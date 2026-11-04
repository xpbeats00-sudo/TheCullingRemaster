"""Custom weapon camos: Gewehr's BO2 pack, BoneCrusher's BO1 animated camos
and ten "magic energy" camos made from scratch, on every camo-capable weapon.

How the game draws a camo (PM_Weapon_Master's base pass, disassembled):
    camo   = lerp(lerp(lerp(Color2, Color1, M.b), Color3, M.r), Color4, M.g)
    albedo = BC * camo     in the weapon's camo zone (CM.r)
with M a linear (TC_Masks) texture sampled at UV * CamoScale, rotated by
CamoRotate. So a camo is four colors and three soft masks: each picture is
fitted with four colors (k-means in linear RGB, stretched to enclose the
picture) and per-pixel blend weights, which invert to the masks. Colors are
scaled by GAIN because the weapon's base texture (~0.42 linear in its camo
zone) multiplies them. The weapon material has no time input, so camos are
static: the animated packs contribute their color frames.

Per camo: /Game/Character/Weapons/Camo_XP_<name> (DXT1 1024 + mips, from
digicamo_A_GP). Per weapon x camo: /Game/Cosmetics/WeaponSkins/<Weapon>_XP_<name>
(from the weapon's _01 skin: Camo, CamoScale, colors 1-4 overridden; ColorA /
ColorB from its default _00 skin), a registry record and a catalog entry.

usage: python make_camos.py <Paks dir> [<camos dir>]
"""
import glob
import hashlib
import json
import os
import re
import struct
import sys
import zipfile

import numpy as np
from PIL import Image, ImageDraw

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import asset_registry  # noqa: E402
import cooked_texture  # noqa: E402
import iwi  # noqa: E402
from build_catalog import pak_entries  # noqa: E402
from build_menu_arenas import encode_tag  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from ue_names import name_hashes  # noqa: E402
from ue_package import UPackage  # noqa: E402

CAMOS_DIR = "C:/Culling/Camos"
CONTENT = os.path.join(HERE, "src", "Victory", "Content")
CATALOG = os.path.join(HERE, "..", "server", "data", "catalog.json")
PREVIEW = os.path.join(HERE, "branding", "camos_preview.png")
TEXTURE_TEMPLATE = "Victory/Content/Character/Weapons/digicamo_A_GP.uasset"
SKINS = "Victory/Content/Cosmetics/WeaponSkins/"
CATALOG_TAG = "xp-camos"

SIZE = 1024
GAIN = 2.0                      # 1 / the weapons' mean base-texture brightness in camo zones
CAMO_SCALE = 3.0
FIRST_ID = 800000               # + weapon * 100 + camo
RARITY = {"Magic Energy": 5, "Gewehr": 4, "BoneCrusher": 3}
PRICE = {"Magic Energy": 600, "Gewehr": 400, "BoneCrusher": 250}     # cull credits, per weapon

# Gewehr's pack: folder -> label (the color texture is ~-gcamo_<x>_col).
GEWEHR = {"amethsyrt(afterlife)": "Amethyst", "bloodlust v2(dragon)": "Bloodlust",
          "honey comb (afterlife)": "Honey Comb", "matrix(dragon)": "Matrix",
          "ruby (cyber)": "Ruby", "waves (cyber)": "Waves"}
# BoneCrusher's embers are named after BO1 weapons: labelled from their art.
BONECRUSHER = {
    "aug": "Stardust", "ballistic": "Pop Swirl", "bbgun": "Galaxy Core", "bow": "Psychedelic",
    "bowie": "Crystal Bloom", "cammando": "Sugar Skulls", "camo_zmb_dlc2_": "Blood Smoke",
    "chinalake": "Molten Chrome", "commando": "Inferno", "conbinedwave": "Nebula", "cz": "Cosmic Mirror",
    "dragunov": "Spiral Galaxy", "fal": "Cosmic Dragon", "front": "Dragon Blossom", "g11": "Cotton Candy",
    "galil": "Violet Sigil", "gersh": "Blue Roses", "hk": "Graffiti", "hs10": "Oxidized",
    "l96a1": "Magenta Rock", "law": "Deep Space", "m14": "Tiger Pop", "m16": "Night Bats",
    "m1911": "Dark Nebula", "minigun": "Marble Pop", "misty": "Pastel Swirl", "monkey": "Neon Glacier",
    "mp5": "Acid Splash", "mpl": "Teal Kaleidoscope", "olympia": "Red Lightning", "python": "Space Crew",
    "raygun": "Bubble Glow", "rear": "Pink Monogram", "rpk": "Liquid Neon", "sliquifire": "Psy Swirl",
    "spas": "Caution", "spectre": "Plum", "stakeout": "Blue Venom", "stg": "Liquid Gold",
    "tgun": "Rainbow Monogram", "thompson": "Neon Smoke", "waffe": "Doodle", "wh": "Purple Vortex",
}


# ---- from scratch: seamless "magic energy" textures
def _lattice(ix, iy, seed):
    h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) & 0xFFFFFFFF
    h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
    return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0


def pnoise(x, y, period, seed):
    """Value noise, periodic with `period` lattice cells in x and y."""
    ix, iy = np.floor(x).astype(np.int64), np.floor(y).astype(np.int64)
    fx, fy = x - ix, y - iy
    fx, fy = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy)
    x0, y0, x1, y1 = ix % period, iy % period, (ix + 1) % period, (iy + 1) % period
    a, b = _lattice(x0, y0, seed), _lattice(x1, y0, seed)
    c, d = _lattice(x0, y1, seed), _lattice(x1, y1, seed)
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy


def fbm(x, y, period, seed, octaves=5):
    total, amp, norm = 0, 1.0, 0
    for o in range(octaves):
        f = 2 ** o
        total = total + amp * pnoise(x * f, y * f, period * f, seed + 31 * o)
        norm += amp
        amp *= 0.5
    return total / norm


def colormap(t, stops):
    t = np.clip(t, 0, 1)
    xs = [s[0] for s in stops]
    return np.stack([np.interp(t, xs, [s[1][c] for s in stops]) for c in range(3)], -1)


def energy(style, stops, seed, size=SIZE, period=4, warp=1.6):
    v = (np.arange(size) + 0.5) / size * period
    x, y = np.meshgrid(v, v)
    qx, qy = fbm(x, y, period, seed), fbm(x + 5.2, y + 1.3, period, seed + 7)
    rx = fbm(x + warp * 4 * qx + 1.7, y + warp * 4 * qy + 9.2, period, seed + 13)
    ry = fbm(x + warp * 4 * qx + 8.3, y + warp * 4 * qy + 2.8, period, seed + 19)
    base = fbm(x + warp * 4 * rx, y + warp * 4 * ry, period, seed + 23)
    if style == "veins":            # thin bright electric lines over a dark field
        n = fbm(x + warp * 3 * rx, y + warp * 3 * ry, period * 2, seed + 29, octaves=6)
        ridge = (1 - np.abs(2 * n - 1)) ** 14
        n2 = fbm(x * 1.0 + 2 * qx, y + 2 * qy, period * 2, seed + 37, octaves=6)
        ridge = np.maximum(ridge, 0.7 * (1 - np.abs(2 * n2 - 1)) ** 18)
        t = 0.35 * base + 0.75 * ridge
    elif style == "smoke":          # soft glowing smoke with bright folds
        fold = (1 - np.abs(2 * base - 1)) ** 4
        t = 0.55 * base + 0.6 * fold
    else:                           # "fluid": flowing bands
        bands = 0.5 + 0.5 * np.sin(base * 14 + rx * 6)
        t = 0.45 * base + 0.55 * bands ** 3
    t = (t - t.min()) / (t.max() - t.min() + 1e-6)
    return Image.fromarray((colormap(t, stops) * 255).astype(np.uint8))


K, D = (0.02, 0.01, 0.04), (1.0, 1.0, 1.0)
MAGIC_ENERGY = [
    ("Arcane Surge", "smoke", [(0, (0.05, 0.0, 0.12)), (0.45, (0.45, 0.1, 0.85)), (0.8, (0.85, 0.5, 1.0)), (1, D)]),
    ("Lava Storm", "veins", [(0, (0.08, 0.0, 0.0)), (0.4, (0.5, 0.05, 0.0)), (0.75, (1.0, 0.45, 0.05)), (1, (1.0, 0.9, 0.6))]),
    ("Teal Current", "veins", [(0, (0.0, 0.03, 0.04)), (0.45, (0.0, 0.3, 0.3)), (0.8, (0.2, 0.95, 0.85)), (1, (0.85, 1.0, 1.0))]),
    ("Blue Tempest", "smoke", [(0, (0.0, 0.02, 0.12)), (0.45, (0.05, 0.25, 0.85)), (0.8, (0.35, 0.65, 1.0)), (1, D)]),
    ("Frost Plasma", "fluid", [(0, (0.02, 0.15, 0.4)), (0.4, (0.1, 0.5, 0.95)), (0.75, (0.5, 0.85, 1.0)), (1, D)]),
    ("Abyss Lightning", "veins", [(0, (0.02, 0.0, 0.1)), (0.45, (0.15, 0.05, 0.55)), (0.8, (0.45, 0.4, 1.0)), (1, D)]),
    ("Jade Flow", "fluid", [(0, (0.0, 0.08, 0.07)), (0.45, (0.05, 0.5, 0.42)), (0.8, (0.45, 0.95, 0.8)), (1, D)]),
    ("Solar Flow", "fluid", [(0, (0.15, 0.0, 0.0)), (0.4, (0.75, 0.12, 0.02)), (0.75, (1.0, 0.55, 0.1)), (1, (1.0, 0.95, 0.75))]),
    ("Nebula Fluid", "fluid", [(0, (0.08, 0.0, 0.18)), (0.45, (0.55, 0.15, 0.75)), (0.8, (0.95, 0.55, 0.95)), (1, D)]),
    ("Violet Storm", "veins", [(0, K), (0.45, (0.3, 0.05, 0.5)), (0.8, (0.8, 0.45, 1.0)), (1, D)]),
]


# ---- sources
def square(img):
    """Tileable art made square by repeating it (no stretching), at SIZE."""
    w, h = img.size
    n = max(w, h)
    out = Image.new("RGB", (n, n))
    for x in range(0, n, w):
        for y in range(0, n, h):
            out.paste(img, (x, y))
    return out.resize((SIZE, SIZE), Image.LANCZOS)


def gather(root):
    camos = []
    for i, (label, style, stops) in enumerate(MAGIC_ENERGY):
        camos.append({"label": label, "pack": "Magic Energy", "img": energy(style, stops, seed=101 + 17 * i)})
    for folder, label in GEWEHR.items():
        cols = glob.glob(os.path.join(root, "Gewehr*", "*", folder, "~-gcamo_*_col.iwi"))
        main = [c for c in cols if "_alt_" not in c] or cols
        camos.append({"label": label, "pack": "Gewehr", "img": square(iwi.decode(open(main[0], "rb").read()).convert("RGB"))})
    z = zipfile.ZipFile(glob.glob(os.path.join(root, "AnimatedCamos-BoneCrusher", "iw_animatedcamos.iwd"))[0])
    for slot, label in BONECRUSHER.items():
        img = iwi.decode(z.read("images/%sember.iwi" % slot)).convert("RGB")
        camos.append({"label": label, "pack": "BoneCrusher", "img": square(img)})
    for c in camos:
        c["slug"] = re.sub(r"[^A-Za-z0-9]+", "_", c["label"]).strip("_")
    return camos


# ---- fitting: four colors + three masks
def srgb_to_linear(a):
    a = a / 255.0
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def kmeans(x, k=4, iters=25, seed=0):
    rng = np.random.default_rng(seed)
    c = [x[rng.integers(len(x))]]
    for _ in range(k - 1):
        d = np.min(((x[:, None] - np.array(c)[None]) ** 2).sum(-1), 1)
        c.append(x[rng.choice(len(x), p=d / d.sum())])
    c = np.array(c)
    for _ in range(iters):
        a = ((x[:, None] - c[None]) ** 2).sum(-1).argmin(1)
        c = np.array([x[a == j].mean(0) if (a == j).any() else c[j] for j in range(k)])
    return c


def project_simplex(v):
    """Rows of v projected onto the probability simplex."""
    u = -np.sort(-v, 1)
    css = np.cumsum(u, 1) - 1
    k = np.arange(1, v.shape[1] + 1)
    rho = (u - css / k > 0).sum(1) - 1
    theta = css[np.arange(len(v)), rho] / (rho + 1)
    return np.maximum(v - theta[:, None], 0)


def weights(x, verts, iters=80):
    """Blend weights w >= 0, sum 1, minimising |w @ verts - x| per color
    (projected gradient: robust when the four colors are nearly coplanar)."""
    a = verts @ verts.T
    step = 1.0 / (np.linalg.eigvalsh(a).max() + 1e-6)
    b = x @ verts.T
    w = np.full((len(x), 4), 0.25)
    for _ in range(iters):
        w = project_simplex(w - step * (w @ a - b))
    return w


def fit(img):
    """(colors (4, 3) linear, masks (H, W, 3) uint8) reproducing img."""
    lin = srgb_to_linear(np.asarray(img, np.float32))
    sample = srgb_to_linear(np.asarray(img.resize((192, 192), Image.BOX), np.float32)).reshape(-1, 3)
    centers = kmeans(sample)
    mid = sample.mean(0)
    best = None
    for alpha in (1.0, 1.15, 1.3, 1.5, 1.75, 2.0):
        verts = np.clip(mid + alpha * (centers - mid), 0, 1)
        err = np.abs(weights(sample, verts) @ verts - sample).mean()
        if best is None or err < best[0]:
            best = (err, verts)
    verts = best[1]
    w = weights(lin.reshape(-1, 3), verts)
    # Most-used color is the base (Color2, no channel), then Color1 (blue),
    # Color3 (red), Color4 (green, painted last).
    order = np.argsort(-w.sum(0))
    c2, c1, c3, c4 = order
    g = w[:, c4]
    r = w[:, c3] / np.maximum(1 - g, 1e-4)
    b = w[:, c1] / np.maximum((1 - r) * (1 - g), 1e-4)
    masks = np.clip(np.stack([r, g, b], -1), 0, 1).reshape(lin.shape)
    colors = verts[[c1, c2, c3, c4]]            # Color1..Color4
    return colors, (masks * 255 + 0.5).astype(np.uint8)


def reconstruct(colors, masks):
    m = masks.astype(np.float32) / 255
    c1, c2, c3, c4 = colors
    c = c2 + (c1 - c2) * m[..., 2:3]
    c = c + (c3 - c) * m[..., 0:1]
    c = c + (c4 - c) * m[..., 1:2]
    return np.clip(c, 0, 1) ** (1 / 2.2)


# ---- skins
def iter_tags(up, data):
    p = 0
    while True:
        name = up.names[struct.unpack_from("<i", data, p)[0]][0]
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
        yield name, ptype, p, q, size
        p = q + size


def fstring(s):
    b = s.encode("latin1") + b"\0"
    return struct.pack("<i", len(b)) + b


def tag_value(up, data, prop):
    for name, ptype, start, voff, size in iter_tags(up, data):
        if name == prop:
            return data[voff:voff + size]
    return None


REPLACED = {"ColorSet", "Camo", "CamoScale", "CamoRotate", "Color1", "Color2", "Color3", "Color4", "ColorA",
            "ColorB", "bOverrideColor1", "bOverrideColor2", "bOverrideColor3", "bOverrideColor4",
            "bOverrideColorA", "bOverrideColorB", "BC", "BC2", "GeoSkin", "bDefaultItem", "bIsPremiumPurchasable",
            "PremiumPurchaseCost", "StoreCategory", "bDontDrop", "bIsPurchasable"}


def skin_asset(template, default, asset, item_id, label, rarity, price, texture, colors):
    """The weapon's _01 skin rewritten for one camo."""
    up = UPackage(template)
    old = up.exports[0]["data"]
    old_name = next(s for s, _ in up.names if s.startswith("/Game/Cosmetics/WeaponSkins/")).rsplit("/", 1)[1]
    for k, (s, _) in enumerate(up.names):
        if s == old_name or s.endswith("/" + old_name):
            s2 = s[: len(s) - len(old_name)] + asset
            up.names[k] = (s2, struct.pack("<HH", *name_hashes(s2)))
    dup = UPackage(default)
    color_a = tag_value(dup, dup.exports[0]["data"], "ColorA")
    color_b = tag_value(dup, dup.exports[0]["data"], "ColorB")

    key = hashlib.md5(("xp-camo-" + asset).encode()).hexdigest().upper()
    values = {"ItemID": fstring(str(item_id)), "ItemDisplayName": fstring(label),
              "ItemDescription": struct.pack("<i", 0) + b"\0" + struct.pack("<i", 0) + fstring(key) + fstring(label),
              "Rarity": struct.pack("<i", rarity), "PurchaseCost": struct.pack("<f", price)}
    out, end = b"", 0
    for name, ptype, start, voff, size in iter_tags(up, old):
        out += old[end:start]
        if name in REPLACED:
            pass
        elif name in values:
            header = bytearray(old[start:voff])
            struct.pack_into("<i", header, 16, len(values[name]))
            out += bytes(header) + values[name]
        else:
            out += old[start:voff + size]
        end = voff + size
    added = b"".join([
        up.fname("Camo") + up.fname("AssetObjectProperty") + struct.pack("<ii", len(fstring(texture)), 0) + b"\0" + fstring(texture),
        encode_tag(up, "CamoScale", "FloatProperty", CAMO_SCALE),
        encode_tag(up, "CamoRotate", "FloatProperty", 0.0),
        encode_tag(up, "bIsPurchasable", "BoolProperty", True),
    ] + [encode_tag(up, "bOverrideColor%s" % n, "BoolProperty", True) for n in ("1", "2", "3", "4", "A", "B")]
      + [encode_tag(up, "Color%d" % (i + 1), "LinearColor", tuple(float(v) for v in colors[i]) + (1.0,)) for i in range(4)]
      + [up.fname(n) + up.fname("StructProperty") + struct.pack("<ii", 16, 0) + up.fname("LinearColor")
         + b"\0" * 17 + v for n, v in (("ColorA", color_a), ("ColorB", color_b)) if v is not None])
    up.exports[0]["data"] = added + out + old[end:]
    return up.save()


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def weapon_templates(paks_dir):
    """{weapon prefix: (_01 template rel, _00 default rel)} for the
    camo-capable weapons (their _01 skin uses digicamo_A_GP)."""
    names = set()
    for pk in sorted(os.listdir(paks_dir)):
        if pk.endswith(".pak") and not pk.startswith("LocalServer"):
            for e in pak_entries(os.path.join(paks_dir, pk)):
                n = e[1].replace("../../../", "")
                if n.startswith(SKINS) and n.endswith(".uasset") and n.count("/") == 4:
                    names.add(n)
    out = {}
    for n in sorted(names):
        m = re.match(re.escape(SKINS) + r"(.+)_01\.uasset$", n)
        default = m and next((d for d in names if d.lower() == (SKINS + m.group(1) + "_00.uasset").lower()), None)
        if default:
            out[m.group(1)] = (n, default)
    return out


def main(paks_dir, camos_dir=CAMOS_DIR):
    camos = gather(camos_dir)
    weapons = weapon_templates(paks_dir)
    templates = find_in_paks(paks_dir, {TEXTURE_TEMPLATE} | {r for pair in weapons.values() for r in pair})
    weapons = {w: pair for w, pair in weapons.items() if b"digicamo_A_GP" in templates[pair[0]]}

    tex_dir = os.path.join(CONTENT, "Character", "Weapons")
    skin_dir = os.path.join(CONTENT, "Cosmetics", "WeaponSkins")
    for f in glob.glob(os.path.join(tex_dir, "Camo_XP_*.uasset")) + glob.glob(os.path.join(skin_dir, "*_XP_*.uasset")):
        os.remove(f)

    catalog = [t for t in json.load(open(CATALOG)) if t.get("source") != CATALOG_TAG]
    by_asset = {t["asset"]: t for t in catalog}
    records, previews = [], []
    for ci, c in enumerate(camos):
        colors, masks = fit(c["img"])
        c["colors"] = colors * GAIN
        texture = "Camo_XP_" + c["slug"]
        write(os.path.join(tex_dir, texture + ".uasset"),
              cooked_texture.rebuild(templates[TEXTURE_TEMPLATE], cooked_texture.mip_chain(masks, 64),
                                     rename=("digicamo_A_GP", texture)))
        previews.append((c, c["img"].resize((128, 128)),
                         Image.fromarray((reconstruct(colors, masks) * 255).astype(np.uint8)).resize((128, 128))))
        c["texture"] = "/Game/Character/Weapons/%s.%s" % (texture, texture)
        print("%-18s %-12s colors %s" % (c["label"], c["pack"], np.round(colors, 2).tolist()))

    for wi, (weapon, (tmpl, default)) in enumerate(sorted(weapons.items())):
        stock = by_asset["/Game/Cosmetics/WeaponSkins/" + os.path.basename(tmpl)[:-7]]
        for ci, c in enumerate(camos):
            asset = "%s_XP_%s" % (weapon, c["slug"])
            item_id = FIRST_ID + wi * 100 + ci
            rarity = RARITY[c["pack"]]
            write(os.path.join(skin_dir, asset + ".uasset"),
                  skin_asset(templates[tmpl], templates[default], asset, item_id, c["label"], rarity,
                             PRICE[c["pack"]], c["texture"], c["colors"]))
            records.append(asset_registry.record("/Game/Cosmetics/WeaponSkins/" + asset, "WeaponCustomizationDataAsset"))
            entry = dict(stock)
            entry.update({"tid": item_id, "asset": "/Game/Cosmetics/WeaponSkins/" + asset, "displayName": c["label"],
                          "rarity": rarity, "purchaseCost": float(PRICE[c["pack"]]), "purchasable": True,
                          "premiumPurchasable": False, "premiumCost": 0.0, "default": False,
                          "source": CATALOG_TAG})
            catalog.append(entry)

    asset_registry.save("camos", records)
    asset_registry.build(paks_dir)
    with open(CATALOG, "w") as f:
        json.dump(catalog, f, indent=1)

    sheet = Image.new("RGB", (6 * 270, ((len(previews) + 5) // 6) * 150), (25, 25, 25))
    dr = ImageDraw.Draw(sheet)
    for i, (c, src, rec) in enumerate(previews):
        x, y = (i % 6) * 270, (i // 6) * 150
        sheet.paste(src, (x, y + 16))
        sheet.paste(rec, (x + 132, y + 16))
        dr.text((x + 2, y + 2), "%s (%s)" % (c["label"], c["pack"]), fill=(255, 255, 0))
    sheet.save(PREVIEW)
    print("%d camos x %d weapons = %d skins" % (len(camos), len(weapons), len(records)))


if __name__ == "__main__":
    main(*sys.argv[1:])
