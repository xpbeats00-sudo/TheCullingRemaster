"""VFX camos: weapon skins whose surface glows and moves, built only from
stock materials whose shaders the game already ships (no shader is copied).

Two looks, each a plain MaterialInstanceConstant (no static permutation, so
it renders with its parent's cooked shaders) on a copy of the weapon's own
mesh, given to the skin through GeoSkin (as the stock special skins do):

- Dark Matter: a child of AirDropLandingPad_MI, a static permutation of the
  environment master PM_Herc with "-use Emissive-" on. Its base pass (read
  from the cooked DXBC) is
      emissive = BaseColor * EmissiveMask.b * |sin(2 pi t PulseFrequency)|^PulseRange
                 * EmissiveColor * EmissiveIntensity
  and its shader map has the GPU-skin vertex factory. Base Color is a
  near-black indigo picture with violet/blue filaments and stars, so the
  filaments and stars glow and breathe; the weapon keeps its own normal map.
  The stock Crafted_Smoke_Grenade_3p_MI is the same kind of asset (a plain
  child of a PM_Herc static permutation with its own textures).
- Wave: a child of Chainsaw_A_MI, the only PM_Weapon_Master permutation with
  a time panner ("-Use Bow Panner-"): where GP alpha is set, base colour and
  normal are sampled at UV + (time * ChainsawSpeed, 0). Base Color is a band
  picture, GP alpha is set everywhere and the normal map is flat, so bands of
  colour flow along the weapon. This permutation has no emissive input: the
  bands are bright lit colour, not light.
- Dark Matter Popper (Compound Bow only): the FUNC Popper mesh (stock skin
  CompoundBow_14) with a child of its own material Bow_Compound_B_PM, whose
  glow channel pulses (Emissive Color * Glow INT * pulse), recoloured violet.

The earlier animated attempt shipped copies of Chainsaw_A_MI, i.e. new
packages carrying an inline shader map; none is made here.

Skins are the weapon's stock GeoSkin skin (CompoundBow_14, Katana_15,
FiremansAxe_15) with GeoSkin pointed at the copy and the store fields
rewritten. Mesh copies keep every name's length, so their header and export
offsets are byte-identical to the stock mesh.

Item IDs follow make_camos: 800000 + weapon index * 100 + camo index, camo
indices after make_camos' 67 (VFX_FIRST). Catalog source "xp-vfx-camos"
(server.js treats it like "xp-camos": one purchase unlocks the look on every
weapon that has it). Run after make_camos.py, which deletes every *_XP_* skin.

usage: python make_vfx_camos.py <Paks dir>
       python make_vfx_camos.py <Paks dir> --test-pak <base src dir> <out.pak>
         (the base generated tree plus these files, packed for an in-game test)
"""
import glob
import hashlib
import json
import os
import re
import shutil
import struct
import sys
import tempfile

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import asset_registry  # noqa: E402
import cooked_texture  # noqa: E402
from build_menu_arenas import encode_tag  # noqa: E402
from make_camos import fbm, weapon_templates, FIRST_ID  # noqa: E402
from make_eye_skins import expression_params, iter_tags, struct_array, name_value  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from ue_names import name_hashes  # noqa: E402
from ue_package import UPackage  # noqa: E402

C = "Victory/Content/"
CONTENT = os.path.join(HERE, "src", "Victory", "Content")
CATALOG = os.path.join(HERE, "..", "server", "data", "catalog.json")
CATALOG_TAG = "xp-vfx-camos"
REGISTRY_NAME = "vfx_camos"
WEAPONS_PKG = "/Game/Character/Weapons/"
SKINS_PKG = "/Game/Cosmetics/WeaponSkins/"
VFX_FIRST = 67                     # camo index after make_camos' 59 + 8 Necro Mist
PRICE, RARITY = 2500, 5            # make_camos' top tier (Magic Energy, Necro Mist)

# Stock parents (their cooked shader maps are what renders).
DARK_PARENT = "/Game/Environment/Culling/Materials/AirDropLandingPad_MI"
DARK_ROOT = "/Game/Environment/Materials/PM_Herc"
WAVE_PARENT = WEAPONS_PKG + "Chainsaw_A_MI"
WAVE_ROOT = "/Game/Environment/Materials/PM_Weapon_Master"
POPPER_PARENT = WEAPONS_PKG + "Bow_Compound_B_PM"
POPPER_MESH = WEAPONS_PKG + "Bow_Compound_B"
FLAT_NORMAL = "/Game/Environment/Materials/4x4_Flat_DDN"
BLACK = "/Game/Environment/Materials/4x4_Black_Chip"
# Texture templates (cooked_texture.rebuild keeps their sRGB/compression settings).
SRGB_TEMPLATE = C + "Character/Weapons/TwoHanded_Melee_Desert_BC.uasset"
MASK_TEMPLATE = C + "Character/Weapons/digicamo_A_GP.uasset"
GP_TEMPLATE = C + "Character/Weapons/Chainsaw_A_GP.uasset"

# weapon skin prefix -> (stock GeoSkin skin used as template, default mesh, body material)
WEAPONS = {
    "CompoundBow": ("CompoundBow_14", "CompoundBow_A", "Bow_Compound_A_MI"),
    "Katana": ("Katana_15", "Katana", "Katana_MI"),
    "FiremansAxe": ("FiremansAxe_15", "FireAxe_A", "TwoHanded_Melee_MI"),
}
WEAPON_LETTER = {"CompoundBow": "B", "Katana": "K", "FiremansAxe": "F"}

# (label, kind, colour (linear, max 1), description, weapons)
CAMOS = [
    ("Dark Matter", "dark", (0.55, 0.30, 1.00),
     "Void-black metal veined with violet starlight that breathes.", list(WEAPONS)),
    ("Dark Matter Popper", "popper", (0.80, 0.20, 1.00),
     "The FUNC Popper, its glow turned to pulsing dark-matter violet.", ["CompoundBow"]),
    ("Wave Abyss Blue", "wave", (0.05, 0.35, 1.00),
     "Bands of abyss-blue light flowing along the weapon.", list(WEAPONS)),
    ("Wave Violet", "wave", (0.55, 0.10, 1.00),
     "Bands of violet light flowing along the weapon.", list(WEAPONS)),
    ("Wave Toxic Green", "wave", (0.30, 1.00, 0.05),
     "Bands of toxic-green light flowing along the weapon.", list(WEAPONS)),
    ("Wave Ember", "wave", (1.00, 0.30, 0.02),
     "Bands of ember light flowing along the weapon.", list(WEAPONS)),
]
WAVE_SPEED = 0.12                  # UV widths per second (ChainsawSpeed)
DARK_PULSE = (0.2, 0.6, 6.0)       # PulseFrequency (Hz), PulseRange (exponent), Emissive Intensity
POPPER_PULSE = (0.3, 0.8, 100.0)   # PulseFrequency, PulseRange, Glow INT (stock 0.1, 1, 100)

# Release gate (make_pak.py on fix-release-pipeline): never use these.
FORBIDDEN = [b"_XPAnim", b"_XPTest", b"Camo_XP_Anim_", b"TEST BUILD"]


def slug(label):
    return "VFX_" + re.sub(r"[^A-Za-z0-9]+", "_", label).strip("_")


def rel(package_path):
    return C + package_path[len("/Game/"):] + ".uasset"


def out_path(package_path):
    return os.path.join(CONTENT, *package_path[len("/Game/"):].split("/")) + ".uasset"


def write(package_path, data):
    for bad in FORBIDDEN:
        assert bad not in data and bad.decode().encode("utf-16le") not in data, (package_path, bad)
    p = out_path(package_path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)


def fstring(s):
    b = s.encode("latin1") + b"\0"
    return struct.pack("<i", len(b)) + b


def rename(up, mapping):
    for k, (s, _) in enumerate(up.names):
        if s in mapping:
            up.names[k] = (mapping[s], struct.pack("<HH", *name_hashes(mapping[s])))


def same_length_name(code, stock):
    """A new name of exactly len(stock) characters starting with `code`_."""
    name = (code + "_" + stock)[:len(stock)]
    assert len(name) == len(stock) and len(stock) > len(code) + 1, (code, stock)
    return name


# ---- names of the generated assets
def mesh_path(ci, weapon, mesh):
    return WEAPONS_PKG + same_length_name("X%d%s" % (ci, WEAPON_LETTER[weapon]), mesh)


def mic_path(ci, weapon, material):
    return WEAPONS_PKG + same_length_name("X%d%s" % (ci, WEAPON_LETTER[weapon]), material)


def texture_path(name):
    return WEAPONS_PKG + name


# ---- material instances
def export_classes(up):
    """Class names of the package's exports."""
    return {up.names[struct.unpack_from("<i", up.imports[-e["fields"][0] - 1], 20)[0]][0]
            for e in up.exports if e["fields"][0] < 0}


def param_guids(*packages):
    """{parameter name: ExpressionGUID} from stock MICs' stored values and
    Materials' parameter expressions (first found wins)."""
    out = {}
    for data in packages:
        up = UPackage(data)
        if "MaterialInstanceConstant" not in export_classes(up):
            for (name, num), guid in expression_params(data).items():
                out.setdefault(name if num == 0 else "%s_%d" % (name, num - 1), guid)
        else:
            d = up.exports[0]["data"]
            for arr in ("ScalarParameterValues", "VectorParameterValues", "TextureParameterValues"):
                for f in struct_array(up, d, arr):
                    n, num = name_value(up, f["ParameterName"])
                    out.setdefault(n, f["ExpressionGUID"])
    return out


def build_mic(template, path, parent, parent_class, guids, scalars=(), vectors=(), textures=()):
    """A MaterialInstanceConstant at `path`: Parent + parameter overrides, no
    static permutation. scalars [(name, float)], vectors [(name, rgba)],
    textures [(name, texture package path)] (object name = last path part)."""
    up = UPackage(template)
    obj = path.rsplit("/", 1)[1]
    up.names = [(path, struct.pack("<HH", *name_hashes(path)))]     # name 0: the package, as in stock
    up.imports = []

    def imp(class_package, class_name, outer, name):
        up.imports.append(up.fname(class_package) + up.fname(class_name) + struct.pack("<i", outer) + up.fname(name))
        return -len(up.imports)

    engine = imp("/Script/CoreUObject", "Package", 0, "/Script/Engine")
    mic_class = imp("/Script/CoreUObject", "Class", engine, "MaterialInstanceConstant")
    parent_pkg = imp("/Script/CoreUObject", "Package", 0, parent)
    parent_obj = imp("/Script/Engine", parent_class, parent_pkg, parent.rsplit("/", 1)[1])
    tex_ref = {}
    for _, tex in textures:
        if tex not in tex_ref:
            pkg = imp("/Script/CoreUObject", "Package", 0, tex)
            tex_ref[tex] = imp("/Script/Engine", "Texture2D", pkg, tex.rsplit("/", 1)[1])

    zero = b"\0" * 16

    def element(name, ptype, value):
        if ptype == "FloatProperty":
            v = up.fname("ParameterValue") + up.fname("FloatProperty") + struct.pack("<ii", 4, 0) + b"\0" + struct.pack("<f", value)
        elif ptype == "LinearColor":
            v = (up.fname("ParameterValue") + up.fname("StructProperty") + struct.pack("<ii", 16, 0)
                 + up.fname("LinearColor") + b"\0" * 17 + struct.pack("<4f", *value))
        else:
            v = up.fname("ParameterValue") + up.fname("ObjectProperty") + struct.pack("<ii", 4, 0) + b"\0" + struct.pack("<i", value)
        return (up.fname("ParameterName") + up.fname("NameProperty") + struct.pack("<ii", 8, 0) + b"\0" + up.fname(name)
                + v + up.fname("ExpressionGUID") + up.fname("StructProperty") + struct.pack("<ii", 16, 0)
                + up.fname("Guid") + b"\0" * 17 + guids.get(name, zero) + up.fname("None"))

    def array(prop, struct_name, elems):
        elems = list(elems)
        if not elems:
            return b""
        blob = b"".join(elems)
        body = (struct.pack("<i", len(elems)) + up.fname(prop) + up.fname("StructProperty")
                + struct.pack("<ii", len(blob), 0) + up.fname(struct_name) + b"\0" * 17 + blob)
        return up.fname(prop) + up.fname("ArrayProperty") + struct.pack("<ii", len(body), 0) + up.fname("StructProperty") + b"\0" + body

    data = (up.fname("Parent") + up.fname("ObjectProperty") + struct.pack("<ii", 4, 0) + b"\0" + struct.pack("<i", parent_obj)
            + array("ScalarParameterValues", "ScalarParameterValue", (element(n, "FloatProperty", v) for n, v in scalars))
            + array("TextureParameterValues", "TextureParameterValue", (element(n, "Object", tex_ref[t]) for n, t in textures))
            + array("VectorParameterValues", "VectorParameterValue", (element(n, "LinearColor", v) for n, v in vectors))
            + up.fname("None") + b"\0" * 4)
    e = up.exports[0]
    e["fields"][0] = mic_class
    e["fields"][4] = up.name_index(obj)
    e["fields"][5] = 0
    e["data"] = data
    return up.save()


# ---- meshes
def mesh_copy(stock, old_mesh, new_mesh, old_mat, new_mat, material_class=None):
    """The stock mesh at new_mesh with its old_mat material import pointing at
    new_mat (package and object renamed; class set to material_class when
    given). Names keep their length unless the class name has to be added."""
    up = UPackage(stock)
    old_obj, new_obj = old_mat.rsplit("/", 1)[1], new_mat.rsplit("/", 1)[1]
    mapping = {old_mesh: new_mesh, old_mat: new_mat, old_obj: new_obj}
    for k, v in mapping.items():
        assert len(k) == len(v), (k, v)
    names_before = [n for n, _ in up.names]
    for k in mapping:
        assert k in names_before, k
    rename(up, mapping)
    if material_class:
        for k, raw in enumerate(up.imports):
            cp, _, cls, _, outer, obj, num = struct.unpack("<iiiiiii", raw)
            if up.names[obj][0] == new_obj:
                up.imports[k] = raw[:8] + up.fname(material_class) + raw[16:]
                break
        else:
            raise SystemExit("%s has no %s import" % (old_mesh, old_obj))
    out = up.save()
    a, b = UPackage(stock), UPackage(out)
    assert [e["data"] for e in a.exports] == [e["data"] for e in b.exports]
    if not material_class or "MaterialInstanceConstant" in names_before:
        assert len(out) == len(stock) and [e["fields"][7:9] for e in a.exports] == [e["fields"][7:9] for e in b.exports]
    return out


# ---- skins
DROP = {"GeoSkin", "Roughness", "Specular", "RedMetallic", "GreenMetallic", "BlueMetallic", "RoughnessMetal",
        "NormalIntensity", "bIsPremiumPurchasable", "PremiumPurchaseCost", "StoreCategory", "bIsPurchasable",
        "bDefaultItem", "bDontDrop", "Camo", "CamoTexture", "BC", "BC2"}


def skin_asset(template, asset, item_id, label, description, geo):
    """A stock GeoSkin skin renamed to `asset`, GeoSkin -> geo, store fields
    rewritten (credits, not premium)."""
    up = UPackage(template)
    old_path = next(s for s, _ in up.names if s.startswith(SKINS_PKG))
    old = old_path.rsplit("/", 1)[1]
    rename(up, {old_path: SKINS_PKG + asset, old: asset})
    e = up.exports[0]
    assert up.names[e["fields"][4]][0] == asset
    e["fields"][5] = 0                       # stock _14/_15 carry the suffix as an FName number
    old_data = e["data"]
    key = hashlib.md5(("xp-vfx-camo-" + asset).encode()).hexdigest().upper()
    values = {"ItemID": fstring(str(item_id)), "ItemDisplayName": fstring(label),
              "ItemDescription": struct.pack("<i", 0) + b"\0" + struct.pack("<i", 0) + fstring(key) + fstring(description),
              "Rarity": struct.pack("<i", RARITY), "PurchaseCost": struct.pack("<f", float(PRICE))}
    out, end, seen = b"", 0, set()
    for name, _, ptype, start, voff, size in iter_tags(up, old_data):
        out += old_data[end:start]
        end = voff + size
        if name in DROP:
            continue
        if name in values:
            header = bytearray(old_data[start:voff])
            struct.pack_into("<i", header, 16, len(values[name]))
            out += bytes(header) + values[name]
            seen.add(name)
        else:
            out += old_data[start:end]
    assert seen == set(values), (asset, set(values) - seen)
    geo_value = fstring(geo)
    added = (up.fname("GeoSkin") + up.fname("AssetObjectProperty") + struct.pack("<ii", len(geo_value), 0) + b"\0" + geo_value
             + encode_tag(up, "Specular", "FloatProperty", 0.5)
             + encode_tag(up, "bIsPurchasable", "BoolProperty", True))
    e["data"] = added + out + old_data[end:]
    return up.save()


# ---- textures
def _periodic_grid(size):
    v = (np.arange(size) + 0.5) / size
    return np.meshgrid(v, v)


def dark_matter_image(size=1024):
    """Near-black indigo with violet/blue filaments and stars (tileable)."""
    x, y = _periodic_grid(size)
    p = 4
    qx, qy = fbm(x * p, y * p, p, 401), fbm(x * p + 5.2, y * p + 1.3, p, 409)
    n = fbm(x * p + 3.5 * qx, y * p + 3.5 * qy, p, 419, octaves=6)
    ridge = (1 - np.abs(2 * n - 1)) ** 22                              # thin filaments
    n2 = fbm(x * 2 * p + 2 * qy, y * 2 * p + 2 * qx, 2 * p, 431, octaves=6)
    ridge2 = (1 - np.abs(2 * n2 - 1)) ** 30
    cloud = np.clip(fbm(x * p + 1.7, y * p + 9.2, p, 443) * 1.6 - 0.6, 0, 1) ** 2
    rng = np.random.default_rng(7)
    stars = np.zeros((size, size), np.float32)
    for _ in range(size * size // 2600):
        sx, sy = rng.integers(size, size=2)
        stars[sy, sx] = rng.uniform(0.4, 1.0) ** 2
    stars = np.asarray(Image.fromarray((stars * 255).astype(np.uint8)).filter(
        __import__("PIL.ImageFilter", fromlist=["GaussianBlur"]).GaussianBlur(0.8)), np.float32) / 255.0 * 3.0
    base = np.array([0.012, 0.006, 0.032])
    violet, blue, white = np.array([0.55, 0.22, 1.0]), np.array([0.20, 0.42, 1.0]), np.array([0.92, 0.85, 1.0])
    rgb = (base + cloud[..., None] * np.array([0.06, 0.02, 0.14])
           + ridge[..., None] * violet * 0.8 + ridge2[..., None] * blue * 0.65
           + np.clip(ridge * ridge2 * 4, 0, 1)[..., None] * white * 0.6
           + np.clip(stars, 0, 1)[..., None] * white)
    return (np.clip(rgb, 0, 1) ** (1 / 2.2) * 255 + 0.5).astype(np.uint8)


def wave_image(color, size=1024, bands=6):
    """Wavy bands across U (they flow along U when panned), tileable."""
    x, y = _periodic_grid(size)
    warp = 0.22 * np.sin(2 * np.pi * 2 * y) + 0.06 * np.sin(2 * np.pi * 5 * y + 1.3)
    phase = bands * x + warp
    v = 0.5 + 0.5 * np.cos(2 * np.pi * phase)
    v2 = 0.5 + 0.5 * np.cos(2 * np.pi * (2 * bands * x - 1.5 * warp + 0.37))
    grain = fbm(x * 8, y * 8, 8, 503) * 0.25 + 0.875
    core, halo, ripple = v ** 28, v ** 7, v2 ** 16 * 0.3
    c = np.array(color, np.float32)
    rgb = (np.array([0.004, 0.004, 0.006]) + (halo * 0.5 + ripple)[..., None] * c * grain[..., None]
           + core[..., None] * (0.55 * c + 0.45))
    return (np.clip(rgb, 0, 1) ** (1 / 2.2) * 255 + 0.5).astype(np.uint8)


def texture(src, template, name, rgb=None, rgba=None, min_width=8):
    old = template.rsplit("/", 1)[1][:-len(".uasset")]
    if rgba is not None:
        return cooked_texture.rebuild(src[template], cooked_texture.mip_chain_rgba(rgba, min_width), rename=(old, name), fmt="PF_DXT5")
    return cooked_texture.rebuild(src[template], cooked_texture.mip_chain(rgb, min_width), rename=(old, name))


# ---- main
def weapon_index(catalog, weapon):
    """make_camos' weapon index (its item IDs are 800000 + index * 100 + camo)."""
    ids = {(t["tid"] - FIRST_ID) // 100 for t in catalog
           if t.get("source") == "xp-camos" and t["asset"].startswith(SKINS_PKG + weapon + "_XP_")}
    assert len(ids) == 1, (weapon, ids)
    return ids.pop()


def plan(catalog):
    """[(camo index, camo, weapon, asset, item id)]"""
    rows = []
    for k, camo in enumerate(CAMOS):
        ci = VFX_FIRST + k
        for weapon in camo[4]:
            rows.append((ci, camo, weapon, "%s_XP_%s" % (weapon, slug(camo[0])),
                         FIRST_ID + weapon_index(catalog, weapon) * 100 + ci))
    return rows


def stock_material_of(src, material_rel):
    """{parameter: texture package path} of a stock weapon MIC."""
    up = UPackage(src[material_rel])
    out = {}
    for f in struct_array(up, up.exports[0]["data"], "TextureParameterValues"):
        n, _ = name_value(up, f["ParameterName"])
        idx = struct.unpack("<i", f["ParameterValue"])[0]
        raw = up.imports[-idx - 1]
        outer = struct.unpack_from("<i", raw, 16)[0]
        out[n] = up.names[struct.unpack_from("<i", up.imports[-outer - 1], 20)[0]][0]
    return out


def main(paks_dir):
    rows = plan(json.load(open(CATALOG)))
    weapon_rels = {}
    for weapon, (skin, mesh, material) in WEAPONS.items():
        weapon_rels[weapon] = (C + "Cosmetics/WeaponSkins/%s.uasset" % skin, rel(WEAPONS_PKG + mesh), rel(WEAPONS_PKG + material))
    need = {SRGB_TEMPLATE, MASK_TEMPLATE, GP_TEMPLATE, rel(DARK_PARENT), rel(DARK_ROOT), rel(WAVE_PARENT), rel(WAVE_ROOT),
            rel(POPPER_PARENT), rel(POPPER_MESH),
            C + "Character/Weapons/Crafted_Smoke_Grenade_3p_MI.uasset"}     # build_mic's package template
    need |= {r for t in weapon_rels.values() for r in t}
    src = find_in_paks(paks_dir, need)
    template_mic = src[C + "Character/Weapons/Crafted_Smoke_Grenade_3p_MI.uasset"]

    # remove an earlier run's output
    for _, camo, weapon, asset, _ in rows:
        p = out_path(SKINS_PKG + asset)
        if os.path.exists(p):
            os.remove(p)
    for f in glob.glob(os.path.join(CONTENT, "Character", "Weapons", "X[0-9][0-9][BKF]_*.uasset")) \
            + glob.glob(os.path.join(CONTENT, "Character", "Weapons", "T_VFX_*.uasset")):
        os.remove(f)

    # textures
    write(texture_path("T_VFX_Dark_Matter_BC"), texture(src, SRGB_TEMPLATE, "T_VFX_Dark_Matter_BC", rgb=dark_matter_image()))
    mask = np.zeros((64, 64, 3), np.uint8)
    mask[...] = (80, 90, 255)                # R metallic, G roughness, B emissive
    write(texture_path("T_VFX_Dark_Matter_M"), texture(src, MASK_TEMPLATE, "T_VFX_Dark_Matter_M", rgb=mask, min_width=4))
    gp = np.zeros((64, 64, 4), np.uint8)
    gp[...] = (0, 90, 0, 255)                # R metal add, G roughness, A = pan everywhere
    write(texture_path("T_VFX_Wave_GP"), texture(src, GP_TEMPLATE, "T_VFX_Wave_GP", rgba=gp, min_width=4))
    for label, kind, color, _, _ in CAMOS:
        if kind == "wave":
            name = "T_" + slug(label) + "_BC"
            write(texture_path(name), texture(src, SRGB_TEMPLATE, name, rgb=wave_image(color)))

    dark_guids = param_guids(src[rel(DARK_PARENT)], src[rel(DARK_ROOT)])
    wave_guids = param_guids(src[rel(WAVE_PARENT)], src[rel(WAVE_ROOT)])
    popper_guids = param_guids(src[rel(POPPER_PARENT)])

    catalog = [t for t in json.load(open(CATALOG)) if t.get("source") != CATALOG_TAG]
    by_asset = {t["asset"]: t for t in catalog}
    taken = {t["tid"] for t in catalog}
    stock_templates = weapon_templates(paks_dir)
    records = []
    for ci, (label, kind, color, description, _), weapon, asset, item_id in rows:
        skin_rel, mesh_rel, mat_rel = weapon_rels[weapon]
        _, mesh, material = WEAPONS[weapon]
        if kind == "popper":
            old_mesh, old_mat = POPPER_MESH, POPPER_PARENT
            new_mesh = mesh_path(ci, weapon, "Bow_Compound_B")
            new_mat = mic_path(ci, weapon, "Bow_Compound_B_PM")
            f, r, glow = POPPER_PULSE
            write(new_mat, build_mic(template_mic, new_mat, POPPER_PARENT, "Material", popper_guids,
                                     scalars=[("Glow INT", glow), ("PulseFrequency", f), ("PulseRange", r)],
                                     vectors=[("Emissive Color", tuple(c * 0.015 for c in color) + (1.0,))]))
            write(new_mesh, mesh_copy(src[rel(POPPER_MESH)], old_mesh, new_mesh, old_mat, new_mat,
                                      material_class="MaterialInstanceConstant"))
            geo = "%s.Bow_Compound_B" % new_mesh
        else:
            old_mesh, old_mat = WEAPONS_PKG + mesh, WEAPONS_PKG + material
            new_mesh, new_mat = mesh_path(ci, weapon, mesh), mic_path(ci, weapon, material)
            if kind == "dark":
                normal = stock_material_of(src, mat_rel)["NM"]
                f, r, intensity = DARK_PULSE
                m = texture_path("T_VFX_Dark_Matter_M")
                mic = build_mic(template_mic, new_mat, DARK_PARENT, "MaterialInstanceConstant", dark_guids,
                                scalars=[("Emissive Intensity", intensity), ("PulseFrequency", f), ("PulseRange", r),
                                         ("Detail normal INT", 0.0), ("Base TIle", 1.0)],
                                vectors=[("Emissive Color", tuple(color) + (1.0,))],
                                textures=[("Base Color", texture_path("T_VFX_Dark_Matter_BC")), ("Normal", normal),
                                          ("Emissive mask", m), ("Metallic mask", m), ("Roughenss mask", m),
                                          ("Detail normal mask", m)])
            else:
                mic = build_mic(template_mic, new_mat, WAVE_PARENT, "MaterialInstanceConstant", wave_guids,
                                scalars=[("ChainsawSpeed", WAVE_SPEED)],
                                textures=[("BC", texture_path("T_" + slug(label) + "_BC")),
                                          ("GP", texture_path("T_VFX_Wave_GP")), ("NM", FLAT_NORMAL), ("CM", BLACK)])
            write(new_mat, mic)
            write(new_mesh, mesh_copy(src[mesh_rel], old_mesh, new_mesh, old_mat, new_mat))
            geo = "%s.%s" % (new_mesh, mesh)
        write(SKINS_PKG + asset, skin_asset(src[skin_rel], asset, item_id, label, description, geo))
        records.append(asset_registry.record(SKINS_PKG + asset, "WeaponCustomizationDataAsset"))
        assert item_id not in taken, item_id
        taken.add(item_id)
        stock = by_asset[SKINS_PKG + os.path.basename(stock_templates[weapon][0])[:-len(".uasset")]]
        entry = dict(stock)
        entry.update({"tid": item_id, "asset": SKINS_PKG + asset, "displayName": label, "rarity": RARITY,
                      "purchaseCost": float(PRICE), "purchasable": True, "premiumPurchasable": False,
                      "premiumCost": 0.0, "default": False, "source": CATALOG_TAG})
        catalog.append(entry)
        print("%-12s %-20s %d  %s" % (weapon, label, item_id, geo))

    asset_registry.save(REGISTRY_NAME, records)
    asset_registry.build(paks_dir)
    with open(CATALOG, "w") as f:
        json.dump(catalog, f, indent=1)
    previews()
    print("%d VFX skins" % len(records))
    return records


def previews():
    """patch/branding/vfx_camos_preview.png: the camo pictures (not renders)."""
    tiles = [("Dark Matter", dark_matter_image(256))]
    tiles += [(label, wave_image(color, 256)) for label, kind, color, _, _ in CAMOS if kind == "wave"]
    sheet = Image.new("RGB", (len(tiles) * 264, 280), (18, 18, 20))
    from PIL import ImageDraw
    d = ImageDraw.Draw(sheet)
    for i, (label, img) in enumerate(tiles):
        sheet.paste(Image.fromarray(img), (i * 264 + 4, 20))
        d.text((i * 264 + 4, 4), label, fill=(220, 220, 220))
    path = os.path.join(HERE, "branding", "vfx_camos_preview.png")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sheet.save(path)


# ---- test pak
def append_records(registry, records):
    count, end = asset_registry._end_of_assets(registry)
    out = bytearray(registry[:end]) + b"".join(records) + registry[end:]
    struct.pack_into("<i", out, 20, count + len(records))
    return bytes(out)


def test_pak(base_src, out_pak, records):
    """base_src (a full generated patch/src tree) + this generator's files,
    with their records appended to base_src's AssetRegistry.bin."""
    import make_pak
    stage = tempfile.mkdtemp(prefix="vfx_stage_")
    try:
        shutil.copytree(base_src, os.path.join(stage, "src"))
        root = os.path.join(stage, "src")
        mine = [os.path.relpath(p, os.path.join(HERE, "src"))
                for p in glob.glob(os.path.join(CONTENT, "**", "*.uasset"), recursive=True)
                if re.search(r"(_XP_VFX_|[/\\]X\d\d[BKF]_|[/\\]T_VFX_)", p)]
        for r in mine:
            dst = os.path.join(root, r)
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            shutil.copyfile(os.path.join(HERE, "src", r), dst)
        reg = os.path.join(root, "Victory", "AssetRegistry.bin")
        with open(reg, "rb") as f:
            data = f.read()
        with open(reg, "wb") as f:
            f.write(append_records(data, records))
        for p in ("force_steamid.txt", "force_account_name.txt"):
            for hit in glob.glob(os.path.join(root, "**", p), recursive=True):
                os.remove(hit)
        make_pak.main(root, out_pak)
        print("test pak: %s (%d VFX files added)" % (out_pak, len(mine)))
    finally:
        shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    recs = main(sys.argv[1])
    if "--test-pak" in sys.argv:
        i = sys.argv.index("--test-pak")
        test_pak(sys.argv[i + 1], sys.argv[i + 2], recs)
