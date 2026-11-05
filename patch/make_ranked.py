"""Ranked Solo assets: rank emblems and the earn-only rank calling cards.

Emblems: the user's artwork (branding/ranked/source), checkerboard
backgrounds removed, exported with transparency to
uiresources/images/ranked/<tier>.png and kept at 1024 in branding/ranked/.

Rank cards: "Ranked - <Tier>" calling cards (emblem + tier name), granted by
the server when a tier is first reached, never sold (catalog rankedReward).

usage: python make_ranked.py <Paks dir>
"""
import json
import math
import os
import sys

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import asset_registry  # noqa: E402
import cooked_texture  # noqa: E402
from make_calling_cards import (CATALOG, TEMPLATE_ASSET, TEMPLATE_TEXTURE, TEX_W, card_asset,  # noqa: E402
                                quantized_png, write)
from patch_assets import find_in_paks  # noqa: E402

CONTENT = os.path.join(HERE, "src", "Victory", "Content")
UI_EMBLEMS = os.path.join(CONTENT, "uiresources", "images", "ranked")
SOURCE_RENDERS = os.path.join(HERE, "branding", "ranked")
CATALOG_TAG = "xp-ranked"
FIRST_ID = 197001
FONT_TITLE = os.path.join(HERE, "branding", "download_creepster", "Creepster-Regular.ttf")
FONT_SMALL = "C:/Windows/Fonts/impact.ttf"

# The emblems are the user's artwork (patch/branding/ranked/source/<Tier>.webp).
# Some were exported with the editor's grey/white "transparency" checkerboard
# baked into the pixels: that background is grown in from the image border, so whites inside the emblem (text, skulls) stay.
EMBLEM_SOURCES = os.path.join(HERE, "branding", "ranked", "source")


def load_emblem(name):
    img = Image.open(os.path.join(EMBLEM_SOURCES, name + ".webp")).convert("RGBA")
    a = np.asarray(img).astype(np.int16)
    if a[..., 3].min() < 255:                      # real transparency already
        return img
    rgb = a[..., :3]
    sat = rgb.max(-1) - rgb.min(-1)
    bg_like = (sat < 22) & (rgb.min(-1) > 150)
    # Grow the background from the border through background-like pixels.
    bg = np.zeros_like(bg_like)
    bg[0, :], bg[-1, :], bg[:, 0], bg[:, -1] = bg_like[0, :], bg_like[-1, :], bg_like[:, 0], bg_like[:, -1]
    while True:
        grown = bg.copy()
        grown[1:] |= bg[:-1]
        grown[:-1] |= bg[1:]
        grown[:, 1:] |= bg[:, :-1]
        grown[:, :-1] |= bg[:, 1:]
        grown &= bg_like
        if (grown == bg).all():
            break
        bg = grown
    alpha = Image.fromarray(np.where(bg, 0, 255).astype(np.uint8))
    # Soften the cut edge by a pixel so the outline doesn't stair-step.
    alpha = alpha.filter(ImageFilter.MinFilter(3)).filter(ImageFilter.GaussianBlur(0.8))
    img.putalpha(alpha)
    bbox = img.getbbox()
    return img.crop(bbox) if bbox else img


def square(img, size):
    """The emblem centred on a transparent square canvas."""
    w, h = img.size
    s = max(w, h)
    canvas = Image.new("RGBA", (s, s), (0, 0, 0, 0))
    canvas.alpha_composite(img, ((s - w) // 2, (s - h) // 2))
    return canvas.resize((size, size), Image.LANCZOS)


# name: (metal top, metal bottom, rim, accent, motif)
TIERS = [
    ("Scrapper", (120, 118, 112), (52, 50, 48), (150, 146, 138), (90, 70, 50), "scratches"),
    ("Contender", (96, 132, 178), (34, 52, 86), (150, 180, 215), (220, 230, 240), "chevron1"),
    ("Blooded", (184, 124, 70), (84, 46, 20), (210, 160, 105), (170, 18, 18), "chevron2"),
    ("Hunter", (150, 190, 225), (44, 74, 104), (205, 228, 245), (235, 245, 255), "chevron3"),
    ("Executioner", (78, 84, 94), (20, 22, 28), (150, 156, 166), (215, 220, 228), "blades"),
    ("Reaper", (184, 30, 40), (66, 8, 12), (225, 90, 90), (232, 222, 200), "skull"),
    ("Warlord", (44, 44, 46), (10, 10, 12), (196, 18, 40), (210, 20, 45), "horns"),
    ("Apex", (246, 196, 82), (138, 88, 18), (30, 24, 16), (24, 20, 14), "crown"),
    ("Legend", (246, 238, 220), (186, 174, 140), (255, 250, 236), (255, 200, 60), "halo"),
]
S = 1024                          # render size (downsampled for export)


def shield(s, inset=0):
    """Shield outline polygon (pointed bottom, curved top) at size s."""
    pts = []
    top, w = 0.14 * s + inset, 0.34 * s - inset
    cx = s / 2
    for k in range(41):                                   # gentle arched top
        t = k / 40
        x = cx - w + 2 * w * t
        pts.append((x, top + 0.05 * s * (1 - math.sin(math.pi * t))))
    for k in range(1, 41):                                # right side to the point
        t = k / 40
        pts.append((cx + w * (1 - t ** 1.6), top + 0.05 * s + (0.86 * s - 2 * inset - top) * t))
    for k in range(39, 0, -1):
        t = k / 40
        pts.append((cx - w * (1 - t ** 1.6), top + 0.05 * s + (0.86 * s - 2 * inset - top) * t))
    return pts


def gradient(s, c0, c1):
    t = np.linspace(0, 1, s)[:, None, None]
    g = (np.array(c0) * (1 - t) + np.array(c1) * t) * np.ones((1, s, 1))
    return Image.fromarray(g.astype(np.uint8))


def emblem(name, top, bottom, rim, accent, motif, seed):
    rng = np.random.default_rng(seed)
    img = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    mask = Image.new("L", (S, S), 0)
    ImageDraw.Draw(mask).polygon(shield(S), fill=255)
    inner = Image.new("L", (S, S), 0)
    ImageDraw.Draw(inner).polygon(shield(S, 0.035 * S), fill=255)

    # Back motifs (behind the shield): crossed blades, horns, halo.
    d = ImageDraw.Draw(img)
    if motif == "blades":
        for sgn in (-1, 1):
            blade = Image.new("RGBA", (S, S), (0, 0, 0, 0))
            bd = ImageDraw.Draw(blade)
            bd.polygon([(S / 2 - 26, 0.06 * S), (S / 2 + 26, 0.06 * S), (S / 2 + 18, 0.92 * S), (S / 2, 0.98 * S),
                        (S / 2 - 18, 0.92 * S)], fill=accent + (255,))
            bd.rectangle((S / 2 - 70, 0.78 * S, S / 2 + 70, 0.81 * S), fill=(60, 60, 64, 255))
            img.alpha_composite(blade.rotate(sgn * 38, resample=Image.BICUBIC, center=(S / 2, S / 2)))
    if motif == "horns":
        for sgn in (-1, 1):
            pts = [(S / 2 + sgn * 0.30 * S, 0.22 * S)]
            for k in range(1, 21):
                t = k / 20
                pts.append((S / 2 + sgn * (0.30 + 0.16 * t) * S, (0.22 - 0.18 * t ** 0.7) * S))
            for k in range(20, -1, -1):
                t = k / 20
                pts.append((S / 2 + sgn * (0.24 + 0.17 * t) * S, (0.27 - 0.20 * t ** 0.7) * S))
            d.polygon(pts, fill=accent + (255,))
    if motif == "halo":
        glow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
        ImageDraw.Draw(glow).ellipse((0.06 * S, 0.02 * S, 0.94 * S, 0.90 * S), outline=accent + (255,), width=26)
        img.alpha_composite(glow.filter(ImageFilter.GaussianBlur(18)))
        img.alpha_composite(glow)

    # Shield body: rim, then the inner plate with a metallic gradient.
    rim_layer = gradient(S, tuple(min(255, c + 40) for c in rim), tuple(int(c * 0.55) for c in rim)).convert("RGBA")
    img.paste(rim_layer, (0, 0), mask)
    plate = gradient(S, top, bottom).convert("RGBA")
    # Brushed-metal grain and a soft highlight.
    grain = (rng.normal(0, 1, (S, S // 8)).repeat(8, 1) * 7).astype(np.int16)
    arr = np.clip(np.asarray(plate, np.int16) + grain[..., None] * np.array([1, 1, 1, 0]), 0, 255).astype(np.uint8)
    plate = Image.fromarray(arr, "RGBA")
    hl = Image.new("L", (S, S), 0)
    ImageDraw.Draw(hl).ellipse((0.18 * S, 0.10 * S, 0.62 * S, 0.50 * S), fill=70)
    plate = Image.composite(Image.new("RGBA", (S, S), (255, 255, 255, 255)), plate, hl.filter(ImageFilter.GaussianBlur(60)))
    img.paste(plate, (0, 0), inner)

    # Front motifs.
    f = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    fd = ImageDraw.Draw(f)
    cx = S / 2
    if motif.startswith("chevron"):
        for k in range(int(motif[-1])):
            y = 0.40 * S + k * 0.13 * S
            fd.polygon([(cx - 0.22 * S, y), (cx, y + 0.10 * S), (cx + 0.22 * S, y), (cx + 0.22 * S, y + 0.06 * S),
                        (cx, y + 0.16 * S), (cx - 0.22 * S, y + 0.06 * S)], fill=accent + (255,))
    elif motif == "scratches":
        for _ in range(26):
            x0, y0 = rng.uniform(0.25, 0.75) * S, rng.uniform(0.25, 0.80) * S
            ang, ln = rng.uniform(-0.6, 0.6), rng.uniform(0.04, 0.16) * S
            fd.line((x0, y0, x0 + ln * math.cos(ang), y0 + ln * math.sin(ang)), fill=(200, 196, 188, 140), width=3)
        fd.ellipse((cx - 0.10 * S, 0.44 * S, cx + 0.10 * S, 0.64 * S), outline=accent + (255,), width=22)
    elif motif == "skull":
        fd.ellipse((cx - 0.17 * S, 0.30 * S, cx + 0.17 * S, 0.62 * S), fill=accent + (255,))
        fd.rounded_rectangle((cx - 0.11 * S, 0.56 * S, cx + 0.11 * S, 0.72 * S), radius=24, fill=accent + (255,))
        for sgn in (-1, 1):
            fd.ellipse((cx + sgn * 0.075 * S - 0.055 * S, 0.43 * S, cx + sgn * 0.075 * S + 0.055 * S, 0.53 * S),
                       fill=(40, 6, 8, 255))
        fd.polygon([(cx, 0.55 * S), (cx - 0.025 * S, 0.60 * S), (cx + 0.025 * S, 0.60 * S)], fill=(40, 6, 8, 255))
        for k in range(-2, 3):
            fd.line((cx + k * 0.035 * S, 0.64 * S, cx + k * 0.035 * S, 0.72 * S), fill=(40, 6, 8, 255), width=8)
    elif motif == "horns":
        fd.polygon([(cx, 0.36 * S), (cx + 0.16 * S, 0.52 * S), (cx, 0.70 * S), (cx - 0.16 * S, 0.52 * S)],
                   fill=accent + (255,))
        fd.polygon([(cx, 0.44 * S), (cx + 0.08 * S, 0.52 * S), (cx, 0.62 * S), (cx - 0.08 * S, 0.52 * S)],
                   fill=(14, 14, 16, 255))
    elif motif in ("crown", "halo"):
        base_y, top_y = 0.58 * S, 0.36 * S
        pts = [(cx - 0.20 * S, base_y)]
        for k in range(5):
            x = cx - 0.20 * S + k * 0.10 * S
            pts += [(x, base_y - 0.08 * S), (x + 0.05 * S, top_y if k % 2 == 0 else top_y + 0.06 * S)]
        pts += [(cx + 0.20 * S, base_y - 0.08 * S), (cx + 0.20 * S, base_y)]
        fd.polygon(pts, fill=accent + (255,))
        fd.rectangle((cx - 0.20 * S, base_y, cx + 0.20 * S, base_y + 0.06 * S), fill=accent + (255,))
        gem = (200, 30, 40, 255) if motif == "crown" else (140, 200, 255, 255)
        fd.ellipse((cx - 0.03 * S, base_y - 0.05 * S, cx + 0.03 * S, base_y + 0.01 * S), fill=gem)
    shadow = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    shadow.paste((0, 0, 0, 150), (6, 10), f.split()[3])
    img.alpha_composite(shadow.filter(ImageFilter.GaussianBlur(6)))
    img.alpha_composite(f)
    return img


def card(name, emblem_img, top, bottom, accent):
    w, h = 925, 160
    bg = np.zeros((h, w, 3), np.float32)
    t = np.linspace(0, 1, w)[None, :, None]
    base = np.array(bottom, np.float32) * 0.35
    bg[:] = base * (1 - t) * 1.2 + np.array([10, 10, 14]) * t
    img = Image.fromarray(np.clip(bg, 0, 255).astype(np.uint8)).convert("RGBA")
    em = emblem_img.resize((150, 150), Image.LANCZOS)
    img.alpha_composite(em, (14, 5))
    d = ImageDraw.Draw(img)
    title = ImageFont.truetype(FONT_TITLE, 74)
    small = ImageFont.truetype(FONT_SMALL, 22)
    tint = tuple(int(c) for c in np.clip(np.array(top) * 1.15 + 30, 0, 255))
    d.text((186, 22), name.upper(), font=title, fill=tint + (255,))
    d.text((190, 112), "RANKED  \u2022  SEASON 1", font=small, fill=(220, 220, 220, 255))
    return img.convert("RGB")


def play_tile(emblems, selected):
    """Play-screen tile (700x900 like the stock ones): the Legend emblem over
    the ladder of tiers; grey normally, red when selected (as SoloPlay)."""
    w, h = 700, 900
    top, bottom = ((120, 8, 8), (40, 0, 0)) if selected else ((70, 70, 72), (22, 22, 24))
    img = gradient(h, top, bottom).resize((w, h)).convert("RGBA")
    big = emblems[-1].resize((520, 520), Image.LANCZOS)
    img.alpha_composite(big, ((w - 520) // 2, 70))
    row = emblems[:-1]
    size = 76
    x0 = (w - size * len(row)) // 2
    for i, em in enumerate(row):
        img.alpha_composite(em.resize((size, size), Image.LANCZOS), (x0 + i * size, 600))
    if not selected:
        g = img.convert("L").convert("RGBA")
        img = Image.blend(g, img, 0.25)
    border = Image.new("RGBA", (w, h), (0, 0, 0, 0))
    ImageDraw.Draw(border).rectangle((0, 0, w - 1, h - 1), outline=(150, 0, 0, 255) if selected else (60, 60, 60, 255), width=8)
    img.alpha_composite(border)
    return img.convert("RGB")


def main(paks_dir):
    templates = find_in_paks(paks_dir, {TEMPLATE_ASSET, TEMPLATE_TEXTURE})
    os.makedirs(UI_EMBLEMS, exist_ok=True)
    os.makedirs(SOURCE_RENDERS, exist_ok=True)
    card_dir = os.path.join(CONTENT, "Cosmetics", "CullingCards")
    ui_cards = os.path.join(CONTENT, "uiresources", "images", "culling-cards")
    catalog = [t for t in json.load(open(CATALOG)) if t.get("source") != CATALOG_TAG]
    records, sheet = [], Image.new("RGBA", (9 * 200, 200), (30, 30, 30, 255))
    for k, (name, top, bottom, rim, accent, motif) in enumerate(TIERS):
        em = square(load_emblem(name), 1024)
        em.save(os.path.join(SOURCE_RENDERS, "%s.png" % name))
        square(em, 256).save(os.path.join(UI_EMBLEMS, "%s.png" % name.lower()))
        sheet.alpha_composite(square(em, 200), (k * 200, 0))

        label, slug = "Ranked - " + name, "Ranked_" + name
        asset, texture = "CullingCardXP_" + slug, "CC_XP_" + slug
        art = card(name, em, top, bottom, accent)
        tex = np.asarray(art.resize((TEX_W, 160), Image.LANCZOS))
        write(os.path.join(card_dir, "Source", texture + ".uasset"),
              cooked_texture.rebuild(templates[TEMPLATE_TEXTURE], cooked_texture.mip_chain(tex),
                                     rename=("CC_Artboard-1", texture)))
        write(os.path.join(card_dir, asset + ".uasset"),
              card_asset(templates[TEMPLATE_ASSET], asset, FIRST_ID + k, label, texture, 5, 0))
        write(os.path.join(ui_cards, texture + ".png"), quantized_png(art))
        records.append(asset_registry.record("/Game/Cosmetics/CullingCards/" + asset, "CullingCardDataAsset"))
        catalog.append({"tid": FIRST_ID + k, "asset": "/Game/Cosmetics/CullingCards/" + asset,
                        "class": "CullingCardDataAsset", "type": "CullingCard", "displayName": label,
                        "category": "Culling Card", "storeCategory": "Culling Card", "rarity": 5, "maxQuantity": 1,
                        "purchaseCost": 0.0, "premiumCost": 0.0, "resale": 0.0, "purchasable": False,
                        "premiumPurchasable": False, "default": False, "source": CATALOG_TAG, "rankedReward": True})
    sheet.convert("RGB").save(os.path.join(HERE, "branding", "ranked_emblems_preview.png"))
    emblems = [Image.open(os.path.join(SOURCE_RENDERS, "%s.png" % t[0])) for t in TIERS]
    tiles = os.path.join(CONTENT, "uiresources", "FrontEnd", "images")
    play_tile(emblems, False).save(os.path.join(tiles, "RankedPlay.png"))
    play_tile(emblems, True).save(os.path.join(tiles, "RankedPlay_sel.png"))
    asset_registry.save("ranked", records)
    asset_registry.build(paks_dir)
    from build_catalog import write_catalog       # refuses an item ID used twice
    write_catalog(CATALOG, catalog)
    print("ranked: %d emblems and rank cards" % len(TIERS))


if __name__ == "__main__":
    main(sys.argv[1])
