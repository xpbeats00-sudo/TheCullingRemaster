"""Necro Mist: the Resurrection outfit's glowing mist eyes in eight colours,
as full outfits (skull mask with its hood, top, pants) and as a weapon camo set.

Where the colour lives (cooked assets, read from the paks):
- Skull mask eyes: the Necroskull_Hat mesh's second material slot is
  M_NecroMist (translucent, panning cloud textures) tinted by its two
  "Fog Tint" vector parameters (stock teal: (0, 2, 1.7) and (0, 5, 0.45)).
  Per colour: MI_EyeMist<nn>, a MaterialInstanceConstant of M_NecroMist with
  both Fog Tints set (no static permutation, so it renders with
  M_NecroMist's own shaders), and NecroskullHatEye<nn>, a copy of the mesh
  whose eye slot points at it. The copy's names keep the stock total length,
  so the header and every export offset stay byte-identical to the stock
  mesh (asserted).
- Top and pants: PlayerPawn's UpdateMaterialParametersForCustomizations sets
  the clothing material's ClothingColor_A/B/C from the data asset's
  Primary/Secondary/Tertiary colours (MI_Top_Necro / MI_Bot_Necro have the
  parameters; their ClothingMask is all channel A). The top's glowing trim
  is the material's "Emissive Color" (stock teal), so each top also gets
  MI_EyeTop<nn> / MI_EyeTopF<nn>, a child of the stock MI_Top_Necro with
  only Emissive Color overridden.
- Hood: the skull mask mesh carries the hood too, both on Necro_BC (one
  atlas: dark cloth panels, beige bone, a white emblem). Hats take one slot,
  so hood and eyes are one item: the mask's data asset overrides the hat
  material's BaseColor texture (MI_Necro_01 has no ClothingColor parameters;
  the stock camo balaclavas use the same override) with T_NecroHood<nn>, a
  1024 copy of Necro_BC whose cloth and emblem are dyed and whose bone keeps
  its stock colour (skull_hood_texture).
- Weapons: the weapon material has no time input on its camo layer and the
  animated (GeoSkin) path is unproven, so Necro Mist weapon skins are static
  camos made from M_NecroMist's own cloud texture (T_Clouds_01) in each
  colour. make_camos.py builds them with its other packs (mist_camos below),
  so they are "xp-camos" skins on every camo-capable weapon and one purchase
  unlocks a colour on all of them.

The game lists clothing from /Game/Cosmetics/Clothing (path compiled into the
exe), so the data assets live there; meshes, materials and textures live in
/Game/Remaster/EyeSkins.

Outputs: patch/src/Victory/Content/... packages, patch/registry/eye_skins.bin,
the "xp-eye-skins" entries of server/data/catalog.json, and two swatch
sheets: patch/branding/eye_skins_preview.png (outfits) and
patch/branding/necro_mist_camos_preview.png (the camos on weapon textures).

usage: python make_eye_skins.py <Paks dir> [--preview]    (--preview: only redraw the two sheets)
"""
import glob
import hashlib
import json
import os
import re
import struct
import sys

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import asset_registry  # noqa: E402
import cooked_texture  # noqa: E402
from build_menu_arenas import encode_tag  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from ue_names import name_hashes  # noqa: E402
from ue_package import UPackage  # noqa: E402

CONTENT = os.path.join(HERE, "src", "Victory", "Content")
CATALOG = os.path.join(HERE, "..", "server", "data", "catalog.json")
PREVIEW = os.path.join(HERE, "branding", "eye_skins_preview.png")
CATALOG_TAG = "xp-eye-skins"
FOLDER = "/Game/Remaster/EyeSkins/"
CLOTHING = "/Game/Cosmetics/Clothing/"
C = "Victory/Content/"

# Stock packages read from the paks.
NECRO_MIST = C + "Character/Materials/M_NecroMist.uasset"
SKULL_MESH = C + "Character/Player/Hats/Necroskull_Hat.uasset"
NECRO_BC = C + "Character/Player/Hats/Necro_BC.uasset"
CLOUDS = C + "Effects/Textures/Smoke/T_Clouds_01.uasset"
MIC_TEMPLATE = C + "Character/Player/MaleClothing/MI_Upper01_F2.uasset"   # a plain 3-vector MIC
TOP_MI = {"M": C + "Character/Player/MaleClothing/MI_Top_Necro.uasset",
          "F": C + "Character/Player/FemaleClothing/MI_Top_Necro.uasset"}

# name, linear colour (max channel 1). Eye Fog Tints are this x2 and x5 (the
# stock eyes' magnitudes); the cloth tint is a deep version of it.
PALETTE = [
    ("Blood Red", (1.00, 0.02, 0.02)),
    ("Toxic Green", (0.30, 1.00, 0.02)),
    ("Violet", (0.45, 0.05, 1.00)),
    ("Gold", (1.00, 0.62, 0.05)),
    ("Ice White", (0.75, 0.90, 1.00)),
    ("Hot Pink", (1.00, 0.05, 0.45)),
    ("Ember Orange", (1.00, 0.25, 0.00)),
    ("Abyss Blue", (0.02, 0.20, 1.00)),
]

# piece -> stock data asset, new asset prefix, first item ID (the stock ID
# scheme: 11xxxx hats, 12/13xxxx male top/legs, 22/23xxxx female), price,
# display name.
PIECES = [
    ("mask", "HeadMisc_22_Resurrection", "XP_EyeMask_", 119001, 2500, "Resurrection Skull Mask - %s"),
    ("top", "BodyResurrection_01", "XP_EyeTop_", 129001, 2000, "Resurrection Top - %s"),
    ("topF", "F_BodyResurrection_01", "F_XP_EyeTop_", 229001, 2000, "Resurrection Top - %s"),
    ("legs", "LegsResurrection_01", "XP_EyeLegs_", 139001, 1500, "Resurrection Pants - %s"),
    ("legsF", "F_LegsResurrection_01", "F_XP_EyeLegs_", 239001, 1500, "Resurrection Pants - %s"),
]
DESCRIPTION = {
    "mask": "The Resurrection skull and hood in %s, with matching mist burning in its eyes.",
    "top": "The Resurrection top in %s, its trim glowing to match.",
    "topF": "The Resurrection top in %s, its trim glowing to match.",
    "legs": "The Resurrection pants in %s.",
    "legsF": "The Resurrection pants in %s.",
}
# Data-asset tags the custom items drop (premium store listing); they are
# bought with credits in Customization like the custom camos.
DROPPED = {"bIsPremiumPurchasable", "PremiumPurchaseCost", "StoreCategory", "bIsPurchasable"}

# Weapon camos (built by make_camos.py through mist_camos()).
CAMO_PACK = "Necro Mist"


def slug(label):
    return re.sub(r"[^A-Za-z0-9]+", "_", label).strip("_")


def rel(package_path):
    return C + package_path[len("/Game/"):] + ".uasset"


def out_path(package_path):
    return os.path.join(CONTENT, *package_path[len("/Game/"):].split("/")) + ".uasset"


def write(package_path, data):
    p = out_path(package_path)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, "wb") as f:
        f.write(data)


def fstring(s):
    b = s.encode("latin1") + b"\0"
    return struct.pack("<i", len(b)) + b


def rename(up, mapping):
    """Rename name-table entries exactly equal to a key."""
    for k, (s, _) in enumerate(up.names):
        if s in mapping:
            up.names[k] = (mapping[s], struct.pack("<HH", *name_hashes(mapping[s])))


def iter_tags(up, data, p=0):
    """(name, number, type, tag start, value offset, size) of tagged properties from p."""
    while True:
        idx, num = struct.unpack_from("<ii", data, p)
        name = up.names[idx][0]
        if name == "None":
            return
        ptype = up.names[struct.unpack_from("<i", data, p + 8)[0]][0]
        size = struct.unpack_from("<i", data, p + 16)[0]
        q = p + 24
        if ptype == "StructProperty":
            q += 8 + 16
        elif ptype == "BoolProperty":
            q += 1
        elif ptype in ("ByteProperty", "EnumProperty", "ArrayProperty"):
            q += 8
        q += 1 + (16 if data[q] else 0)
        yield name, num, ptype, p, q, size
        p = q + size


def struct_array(up, data, prop):
    """Elements of an array-of-structs property: [{field: raw value bytes}]."""
    for name, _, ptype, start, voff, size in iter_tags(up, data):
        if name == prop:
            count = struct.unpack_from("<i", data, voff)[0]
            q = voff + 4 + 49                       # count + inner struct tag
            out = []
            for _ in range(count):
                fields, end = {}, q
                for n2, _, t2, s2, v2, z2 in iter_tags(up, data, q):
                    fields[n2] = data[v2:v2 + z2]
                    end = v2 + z2
                out.append(fields)
                q = end + 8                         # the element's None
            return out
    return []


def name_value(up, raw):
    idx, num = struct.unpack("<ii", raw)
    return up.names[idx][0], num


# ---- material instances
def expression_params(material):
    """{(parameter name, FName number): ExpressionGUID} of a cooked Material's
    parameter expressions."""
    up = UPackage(material)
    out = {}
    for e in up.exports:
        d = e["data"]
        try:
            tags = {n: d[v:v + z] for n, _, _, _, v, z in iter_tags(up, d)}
        except (IndexError, struct.error):
            continue
        if "ParameterName" in tags and "ExpressionGUID" in tags:
            out[name_value(up, tags["ParameterName"])] = tags["ExpressionGUID"]
    return out


def instance_vectors(mic):
    """{(name, number): (guid, (r, g, b, a))} of a MIC's vector overrides."""
    up = UPackage(mic)
    return {name_value(up, f["ParameterName"]): (f["ExpressionGUID"], struct.unpack("<4f", f["ParameterValue"]))
            for f in struct_array(up, up.exports[0]["data"], "VectorParameterValues")}


def build_mic(template, package_path, parent_path, parent_class, vectors):
    """A MaterialInstanceConstant: Parent + VectorParameterValues only, no static
    permutation (it renders with its parent's shaders).
    vectors: [(name, number, guid, (r, g, b, a))]."""
    up = UPackage(template)
    obj = package_path.rsplit("/", 1)[1]
    parent_obj = parent_path.rsplit("/", 1)[1]
    t_self = next(s for s, _ in up.names if s.startswith("/Game/") and s.endswith("2"))
    t_parent = t_self[:-1]
    rename(up, {t_self: package_path, t_self.rsplit("/", 1)[1]: obj,
                t_parent: parent_path, t_parent.rsplit("/", 1)[1]: parent_obj})
    # import -2 is the parent object (class, outer -3 = its package)
    cp, _, _, _, outer, _, _ = struct.unpack("<iiiiiii", up.imports[1])
    assert up.names[cp][0] == "/Script/Engine" and outer == -3
    up.imports[1] = up.fname("/Script/Engine") + up.fname(parent_class) + struct.pack("<i", outer) + up.fname(parent_obj)

    elems = b""
    for name, number, guid, rgba in vectors:
        elems += (up.fname("ParameterName") + up.fname("NameProperty") + struct.pack("<ii", 8, 0) + b"\0"
                  + up.fname(name, number)
                  + up.fname("ParameterValue") + up.fname("StructProperty") + struct.pack("<ii", 16, 0)
                  + up.fname("LinearColor") + b"\0" * 17 + struct.pack("<4f", *rgba)
                  + up.fname("ExpressionGUID") + up.fname("StructProperty") + struct.pack("<ii", 16, 0)
                  + up.fname("Guid") + b"\0" * 17 + guid
                  + up.fname("None"))
    body = (struct.pack("<i", len(vectors)) + up.fname("VectorParameterValues") + up.fname("StructProperty")
            + struct.pack("<ii", len(elems), 0) + up.fname("VectorParameterValue") + b"\0" * 17 + elems)
    up.exports[0]["data"] = (up.fname("Parent") + up.fname("ObjectProperty") + struct.pack("<ii", 4, 0) + b"\0"
                             + struct.pack("<i", -2)
                             + up.fname("VectorParameterValues") + up.fname("ArrayProperty")
                             + struct.pack("<ii", len(body), 0) + up.fname("StructProperty") + b"\0" + body
                             + up.fname("None") + b"\0" * 4)
    return up.save()


def mesh_copy(stock, mesh_path, mic_path):
    """The skull mask mesh with its M_NecroMist slot -> the MIC. Names keep
    their total length, so every offset in the package stays put."""
    up = UPackage(stock)
    mic_obj = mic_path.rsplit("/", 1)[1]
    mapping = {"/Game/Character/Materials/M_NecroMist": mic_path, "M_NecroMist": mic_obj,
               "/Game/Character/Player/Hats/Necroskull_Hat": mesh_path}
    assert sum(map(len, mapping)) == sum(map(len, mapping.values())), "names must keep their total length"
    rename(up, mapping)
    for k, imp in enumerate(up.imports):
        cp, _, cls, _, outer, obj, num = struct.unpack("<iiiiiii", imp)
        if up.names[obj][0] == mic_obj:
            assert up.names[cls][0] == "Material"
            # the class name already exists in the table, so no name is added
            cls_name = struct.pack("<ii", up.name_index("MaterialInstanceConstant", add=False), 0)
            up.imports[k] = imp[:8] + cls_name + imp[16:]
            break
    else:
        raise SystemExit("Necroskull_Hat has no M_NecroMist import")
    out = up.save()
    a, b = UPackage(stock), UPackage(out)
    assert len(out) == len(stock) and [e["fields"][7:9] for e in a.exports] == [e["fields"][7:9] for e in b.exports]
    return out


# ---- textures
def cloth_weight(a):
    """How much of each Necro_BC texel is hood cloth or emblem (1) rather than
    skull bone (0): the cloth is dark and grey, the emblem bright and neutral,
    the bone mid-bright and warm (red above blue)."""
    lum = a @ np.array([0.299, 0.587, 0.114], np.float32)
    warm = a[..., 0] - a[..., 2]
    sat = a.max(-1) - a.min(-1)
    dark = np.clip((0.42 - lum) / 0.12, 0, 1)                   # 1 below 0.30, 0 above 0.42
    emblem = np.clip((lum - 0.80) / 0.08, 0, 1) * np.clip((0.10 - sat) / 0.05, 0, 1)
    bone = np.clip((warm - 0.03) / 0.05, 0, 1) * np.clip((lum - 0.30) / 0.10, 0, 1)
    return np.clip(np.maximum(dark, emblem) * (1 - bone), 0, 1)


def skull_hood_texture(stock_bc, package_path, color):
    """Necro_BC at 1024: the hood's cloth and emblem dyed toward the colour
    (luminance kept), the skull's bone left as it is."""
    img = cooked_texture.decode_top(stock_bc).convert("RGB").resize((1024, 1024), Image.LANCZOS)
    a = np.asarray(img, np.float32) / 255.0
    lum = (a @ np.array([0.299, 0.587, 0.114], np.float32))[..., None]
    c = np.array(color, np.float32)
    dyed = np.clip(a * 0.15 + np.clip(lum * (0.3 + 1.1 * c), 0, 1) * 0.85, 0, 1)
    w = cloth_weight(a)[..., None]
    out = (np.clip(a * (1 - w) + dyed * w, 0, 1) * 255 + 0.5).astype(np.uint8)
    obj = package_path.rsplit("/", 1)[1]
    up = UPackage(stock_bc)
    rename(up, {"/Game/Character/Player/Hats/Necro_BC": FOLDER + "Necro_BC"})
    moved = up.save()                      # streamed mips are dropped by rebuild
    return cooked_texture.rebuild(moved, cooked_texture.mip_chain(out, 8), rename=("Necro_BC", obj)), out


def cloud_image(clouds):
    """T_Clouds_01 as a float (512, 512) array in 0..1."""
    g = np.asarray(cooked_texture.decode_top(clouds).convert("L"), np.float32) / 255.0
    return (g - g.min()) / max(g.max() - g.min(), 1e-6)


def mist_image(cloud, color, size=1024):
    """A tileable Necro Mist camo picture: two cloud layers (like the material's
    two Fog Tints) glowing in the colour over near-black."""
    n = cloud.shape[0]
    reps = -(-size // n)
    base = np.tile(cloud, (reps, reps))[:size, :size]
    other = np.tile(np.rot90(cloud), (reps, reps))[:size, :size]
    glow = np.clip(base ** 3.2 * 1.25 + other ** 5 * 0.8, 0, 1)[..., None]
    c = np.array(color, np.float32)[None, None]
    rgb = 0.025 + glow * c * 0.95 + np.clip(glow - 0.7, 0, 1)[..., :1] * 1.2
    return Image.fromarray((np.clip(rgb, 0, 1) * 255 + 0.5).astype(np.uint8))


def mist_camos(paks_dir):
    """make_camos.py's Necro Mist pack: [{label, pack, img, slug}]."""
    cloud = cloud_image(find_in_paks(paks_dir, {CLOUDS})[CLOUDS])
    out = []
    for label, color in PALETTE:
        c = {"label": CAMO_PACK + " " + label, "pack": CAMO_PACK, "img": mist_image(cloud, color)}
        c["slug"] = slug(c["label"])
        out.append(c)
    return out


# ---- data assets
def data_asset(stock, asset, values, added):
    """The stock clothing data asset renamed to /Game/Cosmetics/Clothing/<asset>,
    values {prop: raw value bytes} replacing stored ones, DROPPED removed and
    `added` (encoded tags) put first."""
    up = UPackage(stock)
    old = next(s for s, _ in up.names if s.startswith(CLOTHING)).rsplit("/", 1)[1]
    rename(up, {CLOTHING + old: CLOTHING + asset, old: asset})
    data = up.exports[0]["data"]
    out, end, seen = b"", 0, set()
    for name, _, ptype, start, voff, size in iter_tags(up, data):
        out += data[end:start]
        end = voff + size
        if name in DROPPED:
            continue
        if name in values:
            header = bytearray(data[start:voff])
            struct.pack_into("<i", header, 16, len(values[name]))
            out += bytes(header) + values[name]
            seen.add(name)
        else:
            out += data[start:end]
    missing = set(values) - seen
    assert not missing, (asset, missing)
    up.exports[0]["data"] = b"".join(added(up)) + out + data[end:]
    return up.save()


def asset_tag(up, name, path):
    v = fstring(path)
    return up.fname(name) + up.fname("AssetObjectProperty") + struct.pack("<ii", len(v), 0) + b"\0" + v


def text_value(key_seed, text):
    key = hashlib.md5(key_seed.encode()).hexdigest().upper()
    return struct.pack("<i", 0) + b"\0" + struct.pack("<i", 0) + fstring(key) + fstring(text)


def linear(rgb):
    return struct.pack("<4f", *(float(v) for v in rgb), 1.0)


def stored_path(stock, prop):
    up = UPackage(stock)
    d = up.exports[0]["data"]
    for name, _, ptype, start, voff, size in iter_tags(up, d):
        if name == prop:
            return d[voff + 4:voff + size - 1].decode("latin1")
    return None


# ---- previews (texture swatches, not renders: the in-game look needs the game)
CAMO_PREVIEW = os.path.join(HERE, "branding", "necro_mist_camos_preview.png")
PREVIEW_WEAPONS = [("Ice Axe", "IceAxe_A"), ("Katana", "Katana"), ("Revolver", "Revolver_A")]
BOT_BC = C + "Character/Player/MaleClothing/Bot_Necro_BC.uasset"
TOP_BC = C + "Character/Player/MaleClothing/Top_Necro_BC.uasset"
TOP_MTRGSP = C + "Character/Player/MaleClothing/Top_Necro_MTRGSP.uasset"
T = 180


def _f(img):
    return np.asarray(img.convert("RGB"), np.float32) / 255.0


def _img(a):
    return Image.fromarray((np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8))


def _crop(img, box):
    w, h = img.size
    return img.crop((int(box[0] * w), int(box[1] * h), int(box[2] * w), int(box[3] * h)))


def _label_color(color):
    return tuple(int(min(1.0, v) * 255) for v in 0.35 + 0.65 * np.array(color))


def mask_tile(necro_bc, cloud, color):
    """The skull face (from Necro_BC) with its sockets filled by the tinted mist."""
    skull = _f(_crop(necro_bc, (0.47, 0.0, 1.0, 0.45)).resize((T, T)))
    m = np.asarray(Image.fromarray((cloud * 255).astype(np.uint8)).resize((T, T)), np.float32) / 255.0
    yy, xx = np.mgrid[0:T, 0:T] / T
    sock = np.zeros((T, T), np.float32)
    for cx, cy in ((0.19, 0.44), (0.78, 0.46)):
        sock = np.maximum(sock, np.clip(1.3 - ((xx - cx) ** 2 / 0.011 + (yy - cy) ** 2 / 0.016), 0, 1))
    glow = (sock * (0.35 + 0.9 * m))[..., None]
    return _img(skull * (1 - 0.8 * sock[..., None]) + glow * np.array(color))


def cloth_tile(bc, tint, glow_mask=None, color=None):
    """Stock texture x the ClothingColor tint (luminance kept), plus the top's
    emissive trim in the colour where its MTRGSP alpha marks it."""
    a = _f(bc.resize((T, T)))
    lum = (a @ np.array([0.299, 0.587, 0.114], np.float32))[..., None]
    out = lum * np.array(tint) * 2.2
    if glow_mask is not None:
        g = np.asarray(glow_mask.resize((T, T)), np.float32)[..., None] / 255.0
        out = out + g * np.array(color) * 1.2
    return _img(out)


def _sheet(title, heads):
    sheet = Image.new("RGB", (130 + len(heads) * (T + 8), 40 + len(PALETTE) * (T + 10)), (18, 18, 20))
    d = ImageDraw.Draw(sheet)
    d.text((4, 4), title, fill=(160, 160, 160))
    for j, h in enumerate(heads):
        d.text((130 + j * (T + 8), 22), h, fill=(210, 210, 210))
    return sheet, d


def outfit_sheet(src, cloud, path):
    necro_bc = cooked_texture.decode_top(src[NECRO_BC])
    top_bc = cooked_texture.decode_top(src[TOP_BC])
    bot_bc = cooked_texture.decode_top(src[BOT_BC])
    trim = cooked_texture.decode_top(src[TOP_MTRGSP]).getchannel("A")
    sheet, d = _sheet("Necro Mist outfits - texture swatches (UV atlases), not in-game renders",
                      ("Skull mask: eyes", "Skull mask: hood", "Top", "Pants"))
    for i, (label, color) in enumerate(PALETTE):
        c = np.array(color)
        tint = tuple(0.03 + 0.45 * c)
        _, hood_px = skull_hood_texture(src[NECRO_BC], FOLDER + "T_Preview", color)
        tiles = [mask_tile(necro_bc, cloud, color),
                 _crop(Image.fromarray(hood_px), (0.0, 0.0, 1.0, 1.0)),
                 cloth_tile(top_bc, tint, trim, color),
                 cloth_tile(bot_bc, tint)]
        y = 40 + i * (T + 10)
        d.text((6, y + T // 2 - 6), label, fill=_label_color(color))
        for j, t in enumerate(tiles):
            sheet.paste(t.convert("RGB").resize((T, T)), (130 + j * (T + 8), y))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sheet.save(path)


def camo_sheet(paks_dir, cloud, path):
    """Each Necro Mist camo as make_camos fits it (4 colours + masks), laid on
    weapon texture atlases the way PM_Weapon_Master does: albedo = BC x camo
    in the camo zone (CM red), the masks tiled CamoScale times."""
    import make_camos
    rels = {w: (C + "Character/Weapons/%s_BC.uasset" % m, C + "Character/Weapons/%s_CM.uasset" % m)
            for w, m in PREVIEW_WEAPONS}
    tex = find_in_paks(paks_dir, {r for pair in rels.values() for r in pair})
    S = 516
    weapons = {}
    for w, (bc, cm) in rels.items():
        rgb = np.asarray(cooked_texture.decode_top(tex[bc]).convert("RGB").resize((S, S)), np.float32)
        zone = np.asarray(cooked_texture.decode_top(tex[cm]).convert("RGB").resize((S, S)), np.float32)[..., :1] / 255.0
        weapons[w] = (make_camos.srgb_to_linear(rgb), zone)
    sheet, d = _sheet("Necro Mist camos on weapon texture atlases (the static camo layer), not in-game renders",
                      ("camo picture",) + tuple(w for w, _ in PREVIEW_WEAPONS))
    reps = int(make_camos.CAMO_SCALE)
    for i, (label, color) in enumerate(PALETTE):
        picture = mist_image(cloud, color)
        colors, masks = make_camos.fit(picture)
        m = np.asarray(Image.fromarray(masks).resize((S // reps, S // reps)), np.float32) / 255.0
        m = np.tile(m, (reps, reps, 1))
        c1, c2, c3, c4 = colors * make_camos.GAIN
        camo = c2 + (c1 - c2) * m[..., 2:3]
        camo = camo + (c3 - camo) * m[..., 0:1]
        camo = camo + (c4 - camo) * m[..., 1:2]
        tiles = [picture]
        for w, _ in PREVIEW_WEAPONS:
            bc_lin, zone = weapons[w]
            albedo = bc_lin * (1 - zone) + bc_lin * camo * zone
            tiles.append(_img(np.clip(albedo, 0, 1) ** (1 / 2.2)))
        y = 40 + i * (T + 10)
        d.text((6, y + T // 2 - 12), CAMO_PACK, fill=_label_color(color))
        d.text((6, y + T // 2 + 2), label, fill=_label_color(color))
        for j, t in enumerate(tiles):
            sheet.paste(t.convert("RGB").resize((T, T)), (130 + j * (T + 8), y))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    sheet.save(path)


def previews(paks_dir):
    src = find_in_paks(paks_dir, {NECRO_BC, CLOUDS, TOP_BC, BOT_BC, TOP_MTRGSP})
    cloud = cloud_image(src[CLOUDS])
    outfit_sheet(src, cloud, PREVIEW)
    camo_sheet(paks_dir, cloud, CAMO_PREVIEW)
    print("previews: %s, %s" % (PREVIEW, CAMO_PREVIEW))


# ---- main
def main(paks_dir):
    stock_assets = {p[0]: C + "Cosmetics/Clothing/%s.uasset" % p[1] for p in PIECES}
    src = find_in_paks(paks_dir, {NECRO_MIST, SKULL_MESH, NECRO_BC, MIC_TEMPLATE}
                       | set(TOP_MI.values()) | set(stock_assets.values()))

    for f in glob.glob(os.path.join(CONTENT, "Remaster", "EyeSkins", "*.uasset")) \
            + glob.glob(os.path.join(CONTENT, "Cosmetics", "Clothing", "*XP_Eye*.uasset")):
        os.remove(f)

    fog = expression_params(src[NECRO_MIST])
    fog_keys = sorted(k for k in fog if k[0] == "Fog Tint")
    assert len(fog_keys) == 2, fog_keys
    emissive = {g: instance_vectors(src[TOP_MI[g]])[("Emissive Color", 0)] for g in TOP_MI}
    for g, (_, rgba) in emissive.items():
        print("stock top emissive (%s): %s" % (g, tuple(round(v, 3) for v in rgba)))

    catalog = [t for t in json.load(open(CATALOG)) if t.get("source") != CATALOG_TAG]
    by_asset = {t["asset"]: t for t in catalog}
    taken = {t["tid"] for t in catalog}
    records = []

    for i, (label, color) in enumerate(PALETTE):
        n = "%02d" % (i + 1)
        c = np.array(color)
        tint = tuple(round(float(v), 4) for v in 0.03 + 0.45 * c)

        # eyes
        mic = FOLDER + "MI_EyeMist" + n
        write(mic, build_mic(src[MIC_TEMPLATE], mic, "/Game/Character/Materials/M_NecroMist", "Material",
                             [(fog_keys[0][0], fog_keys[0][1], fog[fog_keys[0]], tuple(c * 2) + (1.0,)),
                              (fog_keys[1][0], fog_keys[1][1], fog[fog_keys[1]], tuple(c * 5) + (1.0,))]))
        mesh = FOLDER + "NecroskullHatEye" + n
        write(mesh, mesh_copy(src[SKULL_MESH], mesh, mic))

        # top glow
        top_mic = {}
        for g, suffix in (("M", ""), ("F", "F")):
            guid, stock_rgba = emissive[g]
            scale = max(stock_rgba[:3])
            path = FOLDER + "MI_EyeTop" + suffix + n
            parent = "/Game/" + TOP_MI[g][len(C):-len(".uasset")]
            write(path, build_mic(src[MIC_TEMPLATE], path, parent, "MaterialInstanceConstant",
                                  [("Emissive Color", 0, guid, tuple(c * scale) + (stock_rgba[3],))]))
            top_mic[g] = path

        # the mask's hood: cloth and emblem dyed, bone kept
        hood_tex = FOLDER + "T_NecroHood" + n
        tex, _ = skull_hood_texture(src[NECRO_BC], hood_tex, color)
        write(hood_tex, tex)

        # data assets + catalog
        for piece, stock_name, prefix, first_id, price, name_fmt in PIECES:
            asset = prefix + slug(label)
            item_id = first_id + i
            assert item_id not in taken, item_id
            name = name_fmt % label
            values = {"ItemID": fstring(str(item_id)), "ItemDisplayName": fstring(name),
                      "ItemDescription": text_value("xp-eye-" + asset, DESCRIPTION[piece] % label.lower()),
                      "PurchaseCost": struct.pack("<f", float(price)),
                      "PrimaryColor": linear(tint), "SecondaryColor": linear(tint), "TertiaryColor": linear(tint)}
            stock = src[stock_assets[piece]]
            if piece == "mask":
                values["Mesh"] = fstring("%s.Necroskull_Hat" % mesh)
            if piece in ("top", "topF"):
                p = top_mic["M" if piece == "top" else "F"]
                values["MaterialInstance"] = fstring("%s.%s" % (p, p.rsplit("/", 1)[1]))
                assert stored_path(stock, "MaterialInstance").startswith(
                    "/Game/" + TOP_MI["M" if piece == "top" else "F"][len(C):-len(".uasset")])

            def added(up, piece=piece):
                tags = [encode_tag(up, "bIsPurchasable", "BoolProperty", True)]
                if piece == "mask":
                    tags.append(asset_tag(up, "BaseColor", "%s.%s" % (hood_tex, hood_tex.rsplit("/", 1)[1])))
                return tags

            write(CLOTHING + asset, data_asset(stock, asset, values, added))
            records.append(asset_registry.record(CLOTHING + asset, "CharacterCustomizationDataAsset"))
            entry = dict(by_asset[CLOTHING + stock_name])
            entry.update({"tid": item_id, "asset": CLOTHING + asset, "displayName": name,
                          "storeCategory": entry["category"], "purchaseCost": float(price),
                          "purchasable": True, "premiumPurchasable": False, "premiumCost": 0.0,
                          "default": False, "source": CATALOG_TAG})
            catalog.append(entry)
            taken.add(item_id)
        print("%-13s eyes %s  cloth %s" % (label, tuple(round(float(v), 2) for v in c * 2), tint))
    asset_registry.save("eye_skins", records)
    asset_registry.build(paks_dir)
    with open(CATALOG, "w") as f:
        json.dump(catalog, f, indent=1)

    previews(paks_dir)
    print("%d colours x %d pieces = %d items" % (len(PALETTE), len(PIECES), len(records)))


if __name__ == "__main__":
    if "--preview" in sys.argv[2:]:
        previews(sys.argv[1])
    else:
        main(sys.argv[1])
