"""Static checks of make_vfx_camos.py's output (the game is not run).

- Every generated package parses and re-saves byte-identically.
- Every import of every generated package names a package that exists cooked
  in the stock paks (LocalServer patch pak excluded) or among the generated
  files, and an object of that class inside it.
- Mesh copies: export data identical to the stock mesh; names keep their
  length (header and export offsets unchanged) except where the material's
  class name had to be added; the body material import points at the MIC.
- MICs: no static permutation (they render with the parent's cooked shaders);
  every overridden parameter is a parameter expression of the root Material;
  the shader-map owner is cooked for the GPU-skin vertex factory; on Windows
  its base-pass pixel shaders (disassembled with d3dcompiler_47) read the
  game time, and for Wave the time moves a texture coordinate.
- Skins: the GeoSkin tag is laid out like the stock skins' (AssetObjectProperty
  holding "<package>.<object>"), points at a generated SkeletalMesh, and no
  Camo/BC/BC2 tag is left; ItemID, name, price and rarity match the catalog.
- Catalog: IDs follow 800000 + weapon * 100 + camo, are unique, and use the
  "xp-vfx-camos" source; the registry record set has one record per skin.
- No generated file carries the release gate's test markers.

usage: python test_vfx_camos.py <Paks dir>
"""
import ctypes
import json
import os
import re
import struct
import sys
import zlib

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_vfx_camos as vfx  # noqa: E402
from build_catalog import pak_entries, read_entry  # noqa: E402
from cooked_texture import decode_top  # noqa: E402
from make_eye_skins import iter_tags, struct_array, name_value, expression_params  # noqa: E402
from ue_package import UPackage  # noqa: E402

FAILS = []


def check(cond, msg):
    if not cond:
        FAILS.append(msg)
        print("FAIL  " + msg)
    return cond


def imports(up):
    """[(class package, class name, outer, object name)]"""
    out = []
    for raw in up.imports:
        cp, _, cn, _, outer, obj, _ = struct.unpack("<iiiiiii", raw)
        out.append((up.names[cp][0], up.names[cn][0], outer, up.names[obj][0]))
    return out


def exports(up):
    """{object name: class name}"""
    out = {}
    imps = imports(up)
    for e in up.exports:
        f = e["fields"]
        name = up.names[f[4]][0] if f[5] == 0 else "%s_%d" % (up.names[f[4]][0], f[5] - 1)
        out[name] = imps[-f[0] - 1][3] if f[0] < 0 else "?"
    return out


class Stock:
    """Lazy reader of the stock paks (the LocalServer patch pak excluded)."""
    def __init__(self, paks_dir):
        self.index = {}
        for pk in sorted(os.listdir(paks_dir)):
            if pk.endswith(".pak") and not pk.startswith("LocalServer"):
                for f, name, off, usize, method, blocks in pak_entries(os.path.join(paks_dir, pk)):
                    self.index[name.replace("../../../", "")] = (os.path.join(paks_dir, pk), off, usize, method, blocks)
        self.cache = {}

    def has(self, rel):
        return rel in self.index

    def get(self, rel):
        if rel not in self.cache:
            path, off, usize, method, blocks = self.index[rel]
            with open(path, "rb") as f:
                self.cache[rel] = read_entry(f, off, usize, method, blocks)
        return self.cache[rel]


def generated_files():
    root = os.path.join(HERE, "src")
    out = {}
    for d, _, names in os.walk(vfx.CONTENT):
        for n in names:
            p = os.path.join(d, n)
            if re.search(r"(_XP_VFX_|^X\d\d[BKF]_|^T_VFX_)", n):
                out[os.path.relpath(p, root).replace(os.sep, "/")] = open(p, "rb").read()
    return out


def package_bytes(stock, gen, package_path):
    rel = vfx.rel(package_path)
    if rel in gen:
        return gen[rel], "generated"
    if stock.has(rel):
        return stock.get(rel), "stock"
    return None, None


# ---- shaders (Windows only: d3dcompiler_47 disassembles DXBC)
def _disassembler():
    try:
        d3d = ctypes.WinDLL("d3dcompiler_47.dll")
    except (OSError, AttributeError):
        return None

    def disasm(b):
        out = ctypes.c_void_p()
        if d3d.D3DDisassemble(ctypes.c_char_p(b), ctypes.c_size_t(len(b)), 0, None, ctypes.byref(out)) != 0:
            return None
        vt = ctypes.cast(ctypes.cast(out, ctypes.POINTER(ctypes.c_void_p))[0], ctypes.POINTER(ctypes.c_void_p))
        ptr = ctypes.WINFUNCTYPE(ctypes.c_void_p, ctypes.c_void_p)(vt[3])(out)
        size = ctypes.WINFUNCTYPE(ctypes.c_size_t, ctypes.c_void_p)(vt[4])(out)
        return ctypes.string_at(ptr, size).decode("latin1")
    return disasm


def base_pass_shaders(data, disasm):
    """Disassembly of the GBuffer (5 render target) ps_5_0 shaders in a
    material package (each shader's code is zlib-compressed DXBC)."""
    for m in re.finditer(b"\x78[\x01\x5e\x9c\xda]", data):
        try:
            raw = zlib.decompressobj().decompress(data[m.start():m.start() + 4000000])
        except zlib.error:
            continue
        j = raw.find(b"DXBC")
        if j < 0:
            continue
        t = disasm(raw[j:j + struct.unpack_from("<I", raw, j + 24)[0]])
        if t and re.search(r"^ps_5_0", t, re.M) and "SV_Target                4" in t:
            yield t


TIME = "cb0[127]"          # View.GameTime in these 4.15 shaders (pulse/panner inputs)
REG = re.compile(r"\br(\d+)\.([xyzw]+)")


def time_moves_uv(t):
    """True if a texture sample's coordinate depends on the game time."""
    taint = set()
    for ln in t.split("\n"):
        ln = ln.strip()
        if not ln or ln.startswith(("dcl", "//", "ps_", "ret")) or " " not in ln:
            continue
        op, args = ln.split(None, 1)
        parts = [a.strip() for a in re.split(r",\s*(?![^()]*\))", args)]
        dst, srcs = parts[0], parts[1:]
        hot = lambda s: TIME in s or any(("r" + m.group(1), c) in taint for m in REG.finditer(s) for c in m.group(2))  # noqa: E731
        if op.startswith("sample") and srcs and hot(srcs[0]):
            return True
        tainted = any(hot(s) for s in srcs)
        m = REG.match(dst.lstrip("-"))
        if m:
            for c in m.group(2):
                (taint.add if tainted else taint.discard)(("r" + m.group(1), c))
    return False


# ---- checks
def check_package(rel, data, stock, gen):
    up = UPackage(data)
    check(up.save() == data, "%s re-saves byte-identically" % rel)
    imps = imports(up)
    for cp, cn, outer, obj in imps:
        if cn == "Package" and obj.startswith("/Game/"):
            pkg, where = package_bytes(stock, gen, obj)
            if not check(pkg is not None, "%s: import package %s exists (stock paks or generated)" % (rel, obj)):
                continue
            inner = [(c, n) for c2, c, o, n in imps if o == -(imps.index((cp, cn, outer, obj)) + 1)]
            ex = exports(UPackage(pkg))
            for c, n in inner:
                check(ex.get(n) == c, "%s: %s.%s is a %s in the %s package (found %s)" % (rel, obj, n, c, where, ex.get(n)))
    for bad in vfx.FORBIDDEN:
        check(bad not in data and bad.decode().encode("utf-16le") not in data, "%s has no %r" % (rel, bad))
    return up


def root_material(stock, gen, path):
    """(root Material bytes, shader-map owner bytes) walking Parent from path:
    the owner is the first static-permutation MIC on the way, else the root."""
    owner = None
    while True:
        data, _ = package_bytes(stock, gen, path)
        up = UPackage(data)
        if exports(up).get(path.rsplit("/", 1)[1]) == "Material":
            return data, owner or data
        d = up.exports[0]["data"]
        tags = {n: d[v:v + z] for n, _, t, s, v, z in iter_tags(up, d)}
        static = next((d[s + 24] for n, _, t, s, v, z in iter_tags(up, d) if n == "bHasStaticPermutationResource"), 0)
        if owner is None and static:
            owner = data
        parent = struct.unpack("<i", tags["Parent"])[0]
        imps = imports(up)
        path = imps[-imps[-parent - 1][2] - 1][3]


def main(paks_dir):
    stock = Stock(paks_dir)
    gen = generated_files()
    catalog = json.load(open(vfx.CATALOG))
    rows = vfx.plan(catalog)
    disasm = _disassembler()

    skins = {vfx.rel(vfx.SKINS_PKG + asset): (ci, camo, weapon, asset, tid) for ci, camo, weapon, asset, tid in rows}
    check(len(skins) == 16, "16 VFX skins planned (%d)" % len(skins))
    check(set(skins) <= set(gen), "every planned skin was generated")
    meshes = [r for r in gen if re.search(r"/X\d\d[BKF]_", r) and b"SkeletalMesh" in gen[r]]
    mics = [r for r in gen if re.search(r"/X\d\d[BKF]_", r) and r not in meshes]
    textures = [r for r in gen if "/T_VFX_" in r]
    check(len(meshes) == 16 and len(mics) == 16 and len(textures) == 7,
          "16 meshes, 16 MICs, 7 textures (%d, %d, %d)" % (len(meshes), len(mics), len(textures)))

    for rel, data in sorted(gen.items()):
        check_package(rel, data, stock, gen)

    for rel in textures:
        img = decode_top(gen[rel])
        check(img.size[0] >= 64, "%s decodes (%s)" % (rel, img.size))

    shader_owners = {}
    for rel in mics:
        up = UPackage(gen[rel])
        tags = {n: up.exports[0]["data"][v:v + z] for n, _, _, _, v, z in iter_tags(up, up.exports[0]["data"])}
        check("bHasStaticPermutationResource" not in tags, "%s has no static permutation" % rel)
        parent_path = imports(up)[-imports(up)[-struct.unpack("<i", tags["Parent"])[0] - 1][2] - 1][3]
        root, owner = root_material(stock, gen, parent_path)
        params = {n for n, _ in expression_params(root)}
        for arr in ("ScalarParameterValues", "VectorParameterValues", "TextureParameterValues"):
            for f in struct_array(up, up.exports[0]["data"], arr):
                n, _ = name_value(up, f["ParameterName"])
                check(n in params, "%s: %s is a parameter of the root material" % (rel, n))
                check(f["ExpressionGUID"] != b"\0" * 16, "%s: %s has its expression GUID" % (rel, n))
        check(b"bUsedWithSkeletalMesh" in root, "%s: root material is used with skeletal meshes" % rel)
        check(b"TGPUSkinVertexFactorytrue" in owner, "%s: shader map cooked for the GPU-skin vertex factory" % rel)
        shader_owners[parent_path] = owner

    if disasm:
        for parent, owner in sorted(shader_owners.items()):
            ps = list(base_pass_shaders(owner, disasm))
            timed = [t for t in ps if TIME in t]
            check(ps and timed, "%s: base-pass shaders read the game time (%d of %d)" % (parent, len(timed), len(ps)))
            if parent == vfx.WAVE_PARENT:
                check(all(time_moves_uv(t) for t in ps), "%s: every base-pass shader pans a texture by time" % parent)
            print("ok    %s: %d base-pass shaders, %d time-driven, %d panning"
                  % (parent.rsplit("/", 1)[1], len(ps), len(timed), sum(time_moves_uv(t) for t in ps)))
    else:
        print("skip  shader disassembly (d3dcompiler_47 not available)")

    for rel in meshes:
        new = UPackage(gen[rel])
        new_path = "/Game/" + rel[len(vfx.C):-len(".uasset")]
        popper = "/X68B_" in rel
        stock_path = vfx.POPPER_MESH if popper else None
        if not popper:
            weapon = next(w for w, l in vfx.WEAPON_LETTER.items() if re.search(r"/X\d\d%s_" % l, rel))
            stock_path = vfx.WEAPONS_PKG + vfx.WEAPONS[weapon][1]
        old = UPackage(stock.get(vfx.rel(stock_path)))
        check([e["data"] for e in old.exports] == [e["data"] for e in new.exports], "%s: export data = stock %s" % (rel, stock_path))
        if not popper:
            check(len(gen[rel]) == len(stock.get(vfx.rel(stock_path))) and
                  [e["fields"][7:9] for e in old.exports] == [e["fields"][7:9] for e in new.exports],
                  "%s: header and export offsets identical to the stock mesh" % rel)
        mats = [(cn, o, imports(new)[-outer - 1][3]) for cp, cn, outer, o in imports(new) if cn in ("MaterialInstanceConstant", "Material")]
        ours = [m for m in mats if re.search(r"/X\d\d[BKF]_", m[2])]
        check(len(ours) == 1 and ours[0][0] == "MaterialInstanceConstant", "%s: one material import -> generated MIC (%s)" % (rel, mats))
        check(new_path.rsplit("/", 1)[1] not in [n for n, _ in old.names], "%s: new package name is not a stock name" % rel)

    stock_geo = UPackage(stock.get(vfx.C + "Cosmetics/WeaponSkins/FiremansAxe_15.uasset"))
    sg = next((s, v) for n, _, t, s, v, z in iter_tags(stock_geo, stock_geo.exports[0]["data"]) if n == "GeoSkin")
    by_tid = {t["tid"]: t for t in catalog}
    for rel, (ci, camo, weapon, asset, tid) in sorted(skins.items()):
        up = UPackage(gen[rel])
        d = up.exports[0]["data"]
        tags = {n: (t, s, v, z) for n, _, t, s, v, z in iter_tags(up, d)}
        check(exports(up) == {asset: "WeaponCustomizationDataAsset"}, "%s: one WeaponCustomizationDataAsset named %s" % (rel, asset))
        t, s, v, z = tags["GeoSkin"]
        check(t == "AssetObjectProperty" and v - s == sg[1] - sg[0], "%s: GeoSkin tag laid out like the stock skins'" % rel)
        geo = d[v + 4:v + z - 1].decode("latin1")
        pkg, obj = geo.split(".")
        mesh, _ = package_bytes(stock, gen, pkg)
        check(mesh is not None and exports(UPackage(mesh)).get(obj) == "SkeletalMesh", "%s: GeoSkin %s is a SkeletalMesh" % (rel, geo))
        check(not {"Camo", "BC", "BC2", "CamoTexture"} & set(tags), "%s: no Camo/BC/BC2 tag" % rel)
        item_id = d[tags["ItemID"][2] + 4:tags["ItemID"][2] + tags["ItemID"][3] - 1].decode()
        check(item_id == str(tid), "%s: ItemID %s = %d" % (rel, item_id, tid))
        entry = by_tid.get(tid, {})
        check(entry.get("asset") == vfx.SKINS_PKG + asset and entry.get("source") == vfx.CATALOG_TAG
              and entry.get("purchaseCost") == float(vfx.PRICE) and entry.get("rarity") == vfx.RARITY
              and entry.get("displayName") == camo[0], "%s: catalog entry %d" % (rel, tid))
        check(tid == vfx.FIRST_ID + vfx.weapon_index(catalog, weapon) * 100 + ci and 0 <= ci < 100, "%s: ID formula" % rel)

    ids = [t["tid"] for t in catalog]
    check(len(ids) == len(set(ids)), "catalog item IDs unique")
    check(sum(t.get("source") == vfx.CATALOG_TAG for t in catalog) == len(skins), "catalog has exactly the VFX skins")
    reg = open(os.path.join(HERE, "registry", vfx.REGISTRY_NAME + ".bin"), "rb").read()
    check(struct.unpack_from("<i", reg)[0] == len(skins), "registry record set has one record per skin")

    print("%d checks failed" % len(FAILS) if FAILS else "all VFX camo checks passed (%d files)" % len(gen))
    return not FAILS


if __name__ == "__main__":
    sys.exit(0 if main(sys.argv[1]) else 1)
