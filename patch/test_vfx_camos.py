"""Static checks of make_vfx_camos.py's output (the game is not run).

- Every generated package parses and re-saves byte-identically.
- Every import of every generated package names a package that exists cooked
  in the stock paks (LocalServer patch pak excluded) or among the generated
  files, and an object of that class inside it.
- Mesh copies: export data identical to the stock mesh; names keep their
  length (header and export offsets unchanged) except where the material's
  class name had to be added; the body material import points at the MIC.
- skeletal_mesh.py's layout model re-serializes every stock weapon mesh byte
  for byte; Dark Matter's shell meshes keep the stock data as a prefix and
  add one material slot (MI_VFX_Galaxy_Mist), one shell section mirroring the
  body section, and its vertices pushed SHELL_OFFSET along the normals, with
  vertex/weight/import-map/adjacency counts and the LODInfo sort entries in
  step.
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
            if re.search(vfx.VFX_FILE, p):
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


def base_pass_shaders(data, disasm, translucent=False):
    """Disassembly of the GBuffer (5 render target) ps_5_0 shaders in a
    material package (each shader's code is zlib-compressed DXBC); with
    translucent, the single-target ps_5_0 shaders that sample textures."""
    for m in re.finditer(b"\x78[\x01\x5e\x9c\xda]", data):
        try:
            raw = zlib.decompressobj().decompress(data[m.start():m.start() + 4000000])
        except zlib.error:
            continue
        j = raw.find(b"DXBC")
        if j < 0:
            continue
        t = disasm(raw[j:j + struct.unpack_from("<I", raw, j + 24)[0]])
        if not t or not re.search(r"^ps_5_0", t, re.M):
            continue
        if translucent and "SV_Target                1" not in t and "sample" in t:
            yield t
        elif not translucent and "SV_Target                4" in t:
            yield t


TIME = re.compile(r"cb[01]\[127\]")   # View.GameTime (View is cb0 in base-pass, cb1 in translucent shaders)
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
        hot = lambda s: bool(TIME.search(s)) or any(("r" + m.group(1), c) in taint for m in REG.finditer(s) for c in m.group(2))  # noqa: E731
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


def mesh_parts(data):
    import skeletal_mesh
    up = UPackage(data)
    x = up.exports[0]["data"]
    return up, skeletal_mesh.SkeletalMesh(x, vfx.tags_end(up, x))


def check_stock_round_trip(stock):
    """skeletal_mesh's layout model reproduces every stock weapon mesh."""
    n = bad = 0
    for rel in sorted(stock.index):
        if not rel.startswith(vfx.C + "Character/Weapons/") or not rel.endswith(".uasset"):
            continue
        data = stock.get(rel)
        if b"SkeletalMesh" not in data:
            continue
        up = UPackage(data)
        if exports(up).get(rel.rsplit("/", 1)[1][:-len(".uasset")]) != "SkeletalMesh":
            continue
        n += 1
        try:
            _, mesh = mesh_parts(data)
            bad += mesh.write() != up.exports[0]["data"]
        except Exception:
            bad += 1
    check(n > 50 and bad == 0, "skeletal_mesh round-trips every stock weapon mesh byte for byte (%d meshes, %d bad)" % (n, bad))
    print("ok    skeletal_mesh round-trips %d stock weapon meshes byte for byte" % n)


def check_shell_mesh(rel, data, stock, row, setup):
    """Dark Matter: the stock mesh plus one galaxy-shell section per body
    section, everything else unchanged."""
    import numpy as np
    up, mesh = mesh_parts(data)
    sup, smesh = mesh_parts(stock.get(vfx.rel(row["stock_mesh"])))
    check(mesh.write() == up.exports[0]["data"], "%s: re-serializes byte for byte" % rel)
    check(mesh.head == smesh.head and mesh.skeleton == smesh.skeleton and mesh.tail == smesh.tail,
          "%s: bounds, skeleton and trailing data = stock" % rel)
    imps = imports(up)
    slot_obj = [imps[-struct.unpack_from("<i", m)[0] - 1][3] for m in mesh.materials]
    check(slot_obj[-1] == vfx.MIST_MIC.rsplit("/", 1)[1] and len(slot_obj) == len(smesh.materials) + 1
          and [m[4:] for m in mesh.materials[:-1]] == [m[4:] for m in smesh.materials],
          "%s: one added material slot -> %s (%s)" % (rel, vfx.MIST_MIC, slot_obj))
    lod, slod = mesh.lods[0], smesh.lods[0]
    n0 = slod.num_vertices
    simps = imports(sup)
    body_slot = next(i for i, m in enumerate(smesh.materials)
                     if simps[-struct.unpack_from("<i", m)[0] - 1][3] == setup["mat_obj"])
    check(slot_obj[body_slot] == row["mic"].rsplit("/", 1)[1], "%s: body slot -> %s" % (rel, row["mic"]))
    body = [i for i, s in enumerate(slod.sections) if s.material == body_slot]
    shells = lod.sections[len(slod.sections):]
    check(len(shells) == len(body) == 1, "%s: one shell section per body section" % rel)
    check(lod.vertices[:len(slod.vertices)] == slod.vertices and lod.indices[:len(slod.indices)] == slod.indices
          and lod.weights[:len(slod.weights)] == slod.weights and lod.adjacency[:len(slod.adjacency)] == slod.adjacency
          and lod.import_map[:n0] == slod.import_map and lod.active_bones == slod.active_bones
          and lod.required_bones == slod.required_bones, "%s: stock vertex/index/weight data kept as the prefix" % rel)
    for b, sh in zip(body, shells):
        src = slod.sections[b]
        check(sh.material == len(smesh.materials) and sh.base_vertex == n0 and sh.num_vertices == src.num_vertices
              and sh.num_triangles == src.num_triangles and sh.bone_map == src.bone_map
              and sh.base_index == len(slod.indices) // slod.index_size and sh.cast_shadow == 0,
              "%s: shell section mirrors section %d" % (rel, b))
        nv = lod.num_vertices
        idx = np.frombuffer(lod.indices, "<u2")
        tri = idx[sh.base_index:sh.base_index + 3 * sh.num_triangles]
        check(nv < 65536 and tri.min() >= n0 and tri.max() < nv, "%s: shell indices address the shell vertices" % rel)
        check(len(lod.adjacency) == 4 * len(lod.indices) and lod.weights_count == nv and len(lod.import_map) == nv
              and len(lod.vertices) == 24 * nv, "%s: vertex, weight, import-map and adjacency counts agree" % rel)
        vb = np.frombuffer(lod.vertices, np.uint8).reshape(-1, 24)
        pos = vb[:, 8:20].copy().view("<f4").reshape(-1, 3)
        d = np.linalg.norm(pos[n0:n0 + src.num_vertices] - pos[src.base_vertex:src.base_vertex + src.num_vertices], axis=1)
        same = (vb[n0:n0 + src.num_vertices, :8] == vb[src.base_vertex:src.base_vertex + src.num_vertices, :8]).all()
        off = row["shell_offset"]
        check(same and abs(d.min() - off) < 0.02 and abs(d.max() - off) < 0.02,
              "%s: shell = body pushed %.2f along the normals (%.3f..%.3f)" % (rel, off, d.min(), d.max()))
    from uasset import Package
    from uasset_tree import Tree
    pkg = Package(data)
    e = pkg.exports[0]
    props = Tree(pkg).props(e["offset"], e["offset"] + e["size"])
    check(len(props["LODInfo"][0]["TriangleSortSettings"]) == len(lod.sections),
          "%s: LODInfo has a triangle-sort entry per section" % rel)


def check_release_gate(gen):
    """make_pak.py refuses test content and lets the VFX camos through."""
    import shutil
    import tempfile
    import make_pak
    d = tempfile.mkdtemp(prefix="vfx_gate_")
    try:
        skins = os.path.join(d, "Victory", "Content", "Cosmetics", "WeaponSkins")
        weapons = os.path.join(d, "Victory", "Content", "Character", "Weapons")
        os.makedirs(skins)
        os.makedirs(weapons)
        vfx_skin = next(r for r in sorted(gen) if "_XP_VFX_" in r)
        for r in sorted(gen)[:40] + [vfx_skin]:
            dst = os.path.join(d, r)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            open(dst, "wb").write(gen[r])
        check(make_pak.test_content(d) == [], "release gate passes the VFX camo files")
        # an Ice Axe diagnostic: a plain camo skin carrying GeoSkin
        open(os.path.join(skins, "IceAxe_XP_Teal_Current.uasset"), "wb").write(gen[vfx_skin])
        open(os.path.join(weapons, "IceAxe_A_XPTest.uasset"), "wb").write(b"x")
        open(os.path.join(weapons, "Note.txt"), "wb").write(b"see Camo_XP_Anim_Lava_Storm")
        found = {os.path.basename(r) for r, _ in make_pak.test_content(d)}
        check(found == {"IceAxe_XP_Teal_Current.uasset", "IceAxe_A_XPTest.uasset", "Note.txt"},
              "release gate flags diagnostic skins, test names and test mentions (%s)" % sorted(found))
        try:
            make_pak.main(d, os.path.join(d, "out.pak"))
            check(False, "make_pak refuses a tree with test content")
        except make_pak.TestContentError:
            check(not os.path.exists(os.path.join(d, "out.pak")), "make_pak refuses a tree with test content")
    finally:
        shutil.rmtree(d, ignore_errors=True)


def main(paks_dir):
    stock = Stock(paks_dir)
    gen = generated_files()
    catalog = json.load(open(vfx.CATALOG))
    manifest = json.load(open(vfx.MANIFEST))
    setups = manifest["setups"]
    rows = vfx.plan(catalog, setups)
    disasm = _disassembler()

    skins = {vfx.rel(vfx.SKINS_PKG + asset): (ci, camo, weapon, asset, tid) for ci, camo, weapon, asset, tid in rows}
    by_mesh = {vfx.rel(r["mesh"]): r for r in manifest["rows"]}
    expected = sum(len(setups) if c[4] == vfx.ALL and c[1] != "dark" else
                   sum(st["shell"] for st in setups.values()) if c[4] == vfx.ALL else len(c[4]) for c in vfx.CAMOS)
    check(len(skins) == expected == len(manifest["rows"]), "%d VFX skins planned and generated (%d)" % (expected, len(skins)))
    check(set(skins) <= set(gen), "every planned skin was generated")
    meshes = [r for r in gen if r in by_mesh]
    mics = sorted({vfx.rel(r["mic"]) for r in manifest["rows"]} | {vfx.rel(vfx.MIST_MIC)})
    textures = [r for r in gen if "/T_VFX_" in r]
    check(len(meshes) == len(skins) and set(mics) <= set(gen) and len(textures) == 8
          and len(gen) == len(skins) + len(meshes) + len(mics) + len(textures),
          "%d skins, %d meshes, %d MICs, %d textures, nothing else" % (len(skins), len(meshes), len(mics), len(textures)))
    check_stock_round_trip(stock)

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
        params = set(expression_params(root))                 # {(FName string, FName number)}
        for arr in ("ScalarParameterValues", "VectorParameterValues", "TextureParameterValues"):
            for f in struct_array(up, up.exports[0]["data"], arr):
                n = name_value(up, f["ParameterName"])
                check(n in params, "%s: %s is a parameter of the root material" % (rel, n))
                check(f["ExpressionGUID"] != b"\0" * 16, "%s: %s has its expression GUID" % (rel, n))
        check(b"bUsedWithSkeletalMesh" in root, "%s: root material is used with skeletal meshes" % rel)
        check(b"TGPUSkinVertexFactorytrue" in owner, "%s: shader map cooked for the GPU-skin vertex factory" % rel)
        shader_owners[parent_path] = owner

    if disasm:
        for parent, owner in sorted(shader_owners.items()):
            ps = list(base_pass_shaders(owner, disasm, translucent=parent == vfx.MIST_PARENT))
            timed = [t for t in ps if TIME.search(t)]
            check(ps and timed, "%s: base-pass shaders read the game time (%d of %d)" % (parent, len(timed), len(ps)))
            if parent == vfx.WAVE_PARENT:
                check(all(time_moves_uv(t) for t in ps), "%s: every base-pass shader pans a texture by time" % parent)
            if parent == vfx.MIST_PARENT:
                check(all(time_moves_uv(t) for t in ps), "%s: every translucent colour shader pans its clouds by time" % parent)
            print("ok    %s: %d base-pass shaders, %d time-driven, %d panning"
                  % (parent.rsplit("/", 1)[1], len(ps), len(timed), sum(time_moves_uv(t) for t in ps)))
    else:
        print("skip  shader disassembly (d3dcompiler_47 not available)")

    for rel in meshes:
        row = by_mesh[rel]
        if row["kind"] == "dark":
            check_shell_mesh(rel, gen[rel], stock, row, setups[row["weapon"]])
            continue
        new = UPackage(gen[rel])
        new_path = "/Game/" + rel[len(vfx.C):-len(".uasset")]
        stock_path = row["stock_mesh"]
        popper = row["kind"] == "popper" or setups[row["weapon"]]["mat_class"] != "MaterialInstanceConstant"
        old = UPackage(stock.get(vfx.rel(stock_path)))
        check([e["data"] for e in old.exports] == [e["data"] for e in new.exports], "%s: export data = stock %s" % (rel, stock_path))
        if not popper:
            check(len(gen[rel]) == len(stock.get(vfx.rel(stock_path))) and
                  [e["fields"][7:9] for e in old.exports] == [e["fields"][7:9] for e in new.exports],
                  "%s: header and export offsets identical to the stock mesh" % rel)
        mats = [(cn, o, imports(new)[-outer - 1][3]) for cp, cn, outer, o in imports(new) if cn in ("MaterialInstanceConstant", "Material")]
        ours = [m for m in mats if m[2] == row["mic"]]
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

    check_release_gate(gen)

    print("%d checks failed" % len(FAILS) if FAILS else "all VFX camo checks passed (%d files)" % len(gen))
    return not FAILS


if __name__ == "__main__":
    sys.exit(0 if main(sys.argv[1]) else 1)
