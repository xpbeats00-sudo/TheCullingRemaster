"""Add the custom calling cards in C:/Culling/CallingCards to the game.

Each card becomes:
- a CullingCardDataAsset (copied from CullingCardBasic_001) in
  /Game/Cosmetics/CullingCards with its own ItemID, label, rarity and image,
  and an entry in the cooked asset registry (the game finds cards through an
  ObjectLibrary over that folder, which reads the registry in a cooked build);
- a 928x160 DXT1 Texture2D (copied from CC_Artboard-1) for the 3D card in the
  customization scene;
- /images/culling-cards/<texture>.png for the menus and HUD. For animated
  cards it's a vertical sprite sheet (463x80 frames, the size cards are shown
  at) that AnimatedCards.js steps through - Coherent can't play GIFs;
- an entry in the local server's catalog (so it's owned).

Sources (best available per pack): BO2 / IW4 animated-card atlases (.dds,
.iwi, .iwd - 256x64 frames stacked vertically), GIFs where there's no atlas,
and PNG/WebP/JPG/DDS stills. Art is fitted into the card's 5.78:1 shape over
a blurred, darkened copy of itself, so nothing important is cropped.

Labels: "Animated - <name>" (red, rarity 5) and "Classic - <name>" (purple,
rarity 4). Stock cards are green (2).

usage: python make_calling_cards.py <Paks dir> [<cards dir>]
"""
import glob
import hashlib
import io
import json
import math
import os
import re
import struct
import sys
import zipfile

import numpy as np
from PIL import Image, ImageEnhance, ImageFilter, ImageSequence

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import asset_registry  # noqa: E402
import cooked_texture  # noqa: E402
import iwi  # noqa: E402
from build_menu_arenas import iter_tags  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from ue_names import name_hashes  # noqa: E402
from ue_package import UPackage  # noqa: E402

CARDS_DIR = "C:/Culling/CallingCards"
SRC = os.path.join(HERE, "src", "Victory")
CONTENT = os.path.join(SRC, "Content")
CATALOG = os.path.join(HERE, "..", "server", "data", "catalog.json")

TEMPLATE_ASSET = "Victory/Content/Cosmetics/CullingCards/CullingCardBasic_001.uasset"
TEMPLATE_TEXTURE = "Victory/Content/Cosmetics/CullingCards/Source/CC_Artboard-1.uasset"
STOCK_HUD = "Victory/Content/uiresources/hud/hud.html"

CARD_W, CARD_H = 925, 160           # the game's card art
TEX_W = 928                         # DXT1 needs a multiple of 4
FRAME_W, FRAME_H = 463, 80          # animated sprite frames: the size cards are shown at
MAX_FRAMES = 32
ATLAS_FPS = 12.0
ANIMATED_ID, CLASSIC_ID = 195001, 196001
RARITY_ANIMATED, RARITY_CLASSIC = 5, 4
PRICE_ANIMATED, PRICE_CLASSIC = 300, 100     # cull credits (server: custom content is bought)
CATALOG_TAG = "xp-calling-cards"

# Long or rude source folder names -> labels.
RENAMES = {"Ass Swing GAH DAYUM": "Ass Swing", "Our Lord And Savior Ryan Gosling": "Ryan Gosling",
           "Kakashi&Obito": "Kakashi & Obito", "Rappahhhhh": "Rappah"}
# The numbered packs, labelled from their art.
CARDTITLE_LABELS = ["Victory Rifle", "Golden Reaper", "Selfie Shooter", "Geisha", "Skull Arsenal",
                    "Ghost Sniper", "Supply Drop", "Ramen", "Party Skeleton", "Thunder Mine",
                    "Champs 2020", "Go Go Comic", "Pop Art Soldier", "Muzzle Flash", "Aviator"]
PACK_V2_LABELS = {"afterlife": "Midnight Run", "anarchy": "Yellow Roadster", "circuit": "Black 911",
                  "comic": "Tire Smoke", "dragon": "Spoiler Wing", "octane": "Street Plate",
                  "paladin": "Headlights", "w115": "White FC"}


# ---- art
def compose(img, w, h):
    """Fit `img` into a w x h card: the art at ~86% width (cropped top and
    bottom if taller), feathered into a blurred, darkened copy of itself."""
    img = img.convert("RGB")
    iw, ih = img.size
    s = max(w / iw, h / ih)
    bg = img.resize((max(w, math.ceil(iw * s)), max(h, math.ceil(ih * s))), Image.BICUBIC)
    x0, y0 = (bg.width - w) // 2, (bg.height - h) // 2
    bg = bg.crop((x0, y0, x0 + w, y0 + h)).filter(ImageFilter.GaussianBlur(h / 8))
    bg = ImageEnhance.Brightness(bg).enhance(0.5)
    aspect = iw / ih
    fw = w if aspect >= w / h else round(w * 0.86)
    fh = round(fw / aspect)
    fg = img.resize((fw, fh), Image.LANCZOS)
    if fh > h:
        top = (fh - h) // 2
        fg = fg.crop((0, top, fw, top + h))
        fh = h
    feather = max(2, w // 40)
    ramp = np.minimum(np.arange(fw) + 1, np.arange(fw)[::-1] + 1) / feather
    mask = Image.fromarray((np.clip(ramp, 0, 1)[None, :].repeat(fh, 0) * 255).astype(np.uint8))
    bg.paste(fg, ((w - fw) // 2, (h - fh) // 2), mask)
    return bg


def atlas_frames(img):
    """256 x 64 frames stacked vertically; unused (black) trailing slots and
    black bars above/below the art are trimmed."""
    img = img.convert("RGB")
    w, h = img.size
    fh = w // 4
    frames = [img.crop((0, i * fh, w, (i + 1) * fh)) for i in range(h // fh)]
    # Unused slots are near pure black (some with a faint dotted border);
    # dark frames that are part of the loop (a storm between flashes) aren't.
    def empty(f):
        a = np.asarray(f, np.float32)
        return a.mean() < 6 and (a.max(2) > 24).mean() < 0.02

    while len(frames) > 1 and empty(frames[-1]):
        frames.pop()
    stack = np.stack([np.asarray(f, np.float32).max(2) for f in frames])
    rows = np.nonzero(stack.max((0, 2)) > 16)[0]
    if len(rows) and (rows[-1] - rows[0] + 1) < fh:
        frames = [f.crop((0, rows[0], w, rows[-1] + 1)) for f in frames]
    return frames


def gif_frames(path):
    im = Image.open(path)
    frames, total = [], 0.0
    for f in ImageSequence.Iterator(im):
        frames.append(f.convert("RGB"))
        total += f.info.get("duration", 100) / 1000.0
    return frames, len(frames) / max(total, 0.05)


def cap(frames, fps):
    if len(frames) <= MAX_FRAMES:
        return frames, fps
    keep = np.linspace(0, len(frames) - 1, MAX_FRAMES).round().astype(int)
    return [frames[k] for k in keep], fps * MAX_FRAMES / len(frames)


def clean(label):
    label = re.sub(r"\s*\(.*?\)\s*", " ", label).strip()
    return RENAMES.get(label, label)


def title(slug):
    return " ".join(p.capitalize() if not p.isdigit() else p for p in slug.replace("_", " ").split())


# ---- gather the packs
def gather(root):
    cards = []

    def animated(label, frames, fps):
        frames, fps = cap(frames, fps)
        cards.append({"label": "Animated - " + label, "frames": frames, "fps": round(fps, 2)})

    def static(label, img):
        cards.append({"label": label, "frames": [img], "fps": 0})

    # Volkz: animated BO2 atlases (folder names are the card names) + stills.
    volkz = glob.glob(os.path.join(root, "Volkz*", "*", "Animated"))
    for base in volkz:
        for d in sorted(os.listdir(base)):
            if d.startswith("z"):
                continue                                    # zOriginals: the stock BO2 cards
            dds = glob.glob(os.path.join(base, d, "*.dds"))
            if dds:
                animated(clean(d), atlas_frames(Image.open(dds[0])), ATLAS_FPS)
    # Volkz's stills replace BO2's emblem/flag texture slots but keep the slot
    # file names ("flag_brazil" is a rosary), so they're numbered instead.
    stills = sorted(glob.glob(os.path.join(root, "Volkz*", "*", "Static", "DDS", "*.dds")))
    for k, dds in enumerate(stills, 1):
        static("Classic - Volkz %03d" % k, Image.open(dds))

    # SynthianCicada: BO2 .iwi atlases ("Linux Loading" is a spinner atlas: use its GIF).
    for d in sorted(glob.glob(os.path.join(root, "Synthian*", "*", ""))):
        label = clean(os.path.basename(d.rstrip("/\\")))
        iwis = glob.glob(os.path.join(d, "*.iwi"))
        img = iwi.decode(open(iwis[0], "rb").read()) if iwis else None
        if img is not None and img.size[1] >= img.size[0] * 2:
            animated(label, atlas_frames(img), ATLAS_FPS)
        elif os.path.exists(os.path.join(d, "Preview.gif")):
            animated(label, *gif_frames(os.path.join(d, "Preview.gif")))

    # pack v2: more BO2 atlases (JDM street cars).
    for f in sorted(glob.glob(os.path.join(root, "pack v2", "*", "*.iwi"))):
        slot = os.path.basename(f)[len("em_bg_ani_"):-4]
        animated(PACK_V2_LABELS.get(slot, title(slot)), atlas_frames(iwi.decode(open(f, "rb").read())), ATLAS_FPS)

    # Animated Cardtitle pack: IW4 atlases inside each folder's .iwd (a zip).
    for d in sorted(glob.glob(os.path.join(root, "Animated Calling Cards*", "*", "*", "[0-9][0-9]"))):
        k = int(os.path.basename(d))
        z = zipfile.ZipFile(os.path.join(d, "userraw", "animated_card.iwd"))
        name = next(n for n in z.namelist() if n.endswith(".iwi"))
        label = CARDTITLE_LABELS[k] if k < len(CARDTITLE_LABELS) else "Cardtitle %02d" % k
        animated(label, atlas_frames(iwi.decode(z.read(name))), 10.0)

    # Files pack (MW / Warzone player cards): one image per card, originals
    # before the identical "...Resultado.png" re-saves.
    files = {}
    for f in sorted(glob.glob(os.path.join(root, "Files Calling Cards*", "*", "*", "*.*"))):
        base, ext = os.path.splitext(os.path.basename(f))
        resave = base.endswith("Resultado")
        base = base[: -len("Resultado")] if resave else base
        rank = (resave, {".png": 0, ".webp": 1, ".jpg": 2, ".gif": 3}.get(ext.lower(), 9))
        if base not in files or rank < files[base][0]:
            files[base] = (rank, f)
    photo = 0
    for base, (_, f) in sorted(files.items()):
        if f.lower().endswith(".gif"):
            animated("2020 Champs" if "champs" in base else title(base), *gif_frames(f))
            continue
        img = Image.open(f)
        m = re.match(r"ui_playercard_(.+)$", base)
        if m and m.group(1).startswith("mc_"):
            label = title(m.group(1).split("_")[1])                 # mastery camo cards
        elif m:
            label = "Card " + m.group(1).upper().replace("_", " ")
        elif "domino" in base:
            label = "Domino " + re.search(r"domino_(\d+)", base).group(1)
        else:
            photo += 1
            label = "Snapshot %d" % photo
        static("Classic - " + label, img)
    return cards


# ---- packages
def fstring(s):
    b = s.encode("latin1") + b"\0"
    return struct.pack("<i", len(b)) + b


def rename_names(up, old, new):
    for k, (s, _) in enumerate(up.names):
        if s == old or s.endswith("/" + old):
            s2 = s[: len(s) - len(old)] + new
            up.names[k] = (s2, struct.pack("<HH", *name_hashes(s2)))


def card_asset(template, asset, item_id, label, texture, rarity, price):
    up = UPackage(template)
    rename_names(up, "CullingCardBasic_001", asset)
    e = up.exports[0]
    key = hashlib.md5(("xp-card-" + asset).encode()).hexdigest().upper()
    text = struct.pack("<i", 0) + b"\0" + struct.pack("<i", 0) + fstring(key) + fstring(label)
    values = {"ItemID": fstring(str(item_id)), "ItemDisplayName": fstring(label), "ItemDescription": text,
              "CullingCard": fstring("/Game/Cosmetics/CullingCards/Source/%s.%s" % (texture, texture)),
              "Rarity": struct.pack("<i", rarity), "PurchaseCost": struct.pack("<f", price)}
    data, out, end = e["data"], b"", 0
    for name, ptype, start, voff, size in iter_tags(up, data):
        out += data[end:start]
        if name in values:
            header = bytearray(data[start:voff])
            struct.pack_into("<i", header, 16, len(values[name]))
            out += bytes(header) + values[name]
        else:
            out += data[start:voff + size]
        end = voff + size
    purchasable = up.fname("bIsPurchasable") + up.fname("BoolProperty") + struct.pack("<ii", 0, 0) + b"\x01\x00"
    e["data"] = purchasable + out + data[end:]
    return up.save()


def quantized_png(img):
    buf = io.BytesIO()
    img.quantize(colors=256, method=Image.Quantize.FASTOCTREE, dither=Image.Dither.FLOYDSTEINBERG).save(buf, "PNG", optimize=True)
    return buf.getvalue()


ANIMATED_JS = """// The Culling Remaster: animated calling cards (generated by make_calling_cards.py).
// An animated card's PNG is a vertical sprite sheet; any element showing one
// (via the card binders, or set directly like the local player's card) is
// stepped through its frames here - Coherent doesn't play GIFs.
var AnimatedCullingCards = %s;   // texture name: [frames, frames per second]

(function () {
  var active = [];

  function cardName(el) {
    var m = /culling-cards\\/([^\\/'"\\)]+)\\.png/.exec(el.style.backgroundImage || "");
    return m ? m[1] : null;
  }

  function track(el) {
    var anim = AnimatedCullingCards[cardName(el)];
    var i = active.indexOf(el);
    if (!anim) {
      if (i >= 0) {
        active.splice(i, 1);
        el.style.backgroundSize = "";
        el.style.backgroundPosition = "";
      }
      return;
    }
    el.cullingCardAnim = anim;
    el.style.backgroundSize = "100%% " + (anim[0] * 100) + "%%";
    if (i < 0) {
      active.push(el);
    }
  }
  window.TrackCullingCardElement = track;

  ["cardbackgroundimage", "cullingCardBGImage"].forEach(function (name) {
    var stock = rivets.binders[name];
    if (stock) {
      rivets.binders[name] = function (el, value) {
        stock.call(this, el, value);
        track(el);
      };
    }
  });

  var start = Date.now();
  setInterval(function () {
    var t = (Date.now() - start) / 1000;
    for (var k = active.length - 1; k >= 0; k--) {
      var a = active[k].cullingCardAnim;
      var frame = Math.floor(t * a[1]) %% a[0];
      active[k].style.backgroundPosition = "0 " + (a[0] > 1 ? frame * 100 / (a[0] - 1) : 0) + "%%";
    }
  }, 40);

  // Cards set without a binder (e.g. jQuery .css on the local player's card),
  // and dropping elements that left the page.
  setInterval(function () {
    var els = document.querySelectorAll(".local-culling-card-container, .culling-card-container");
    for (var i = 0; i < els.length; i++) {
      track(els[i]);
    }
    for (var k = active.length - 1; k >= 0; k--) {
      if (!document.body.contains(active[k])) {
        active.splice(k, 1);
      }
    }
  }, 1000);
})();
"""


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def main(paks_dir, cards_dir=CARDS_DIR):
    templates = find_in_paks(paks_dir, {TEMPLATE_ASSET, TEMPLATE_TEXTURE, STOCK_HUD})
    cards = gather(cards_dir)

    # Unique labels and package names; animated first.
    cards.sort(key=lambda c: (c["fps"] == 0, c["label"].lower()))
    seen, slugs = {}, set()
    for c in cards:
        n = seen.get(c["label"], 0) + 1
        seen[c["label"]] = n
        if n > 1:
            c["label"] += " %d" % n
        slug = re.sub(r"[^A-Za-z0-9]+", "_", c["label"].split(" - ", 1)[1]).strip("_")
        while slug in slugs:
            slug += "_x"
        slugs.add(slug)
        c["slug"] = slug

    card_dir = os.path.join(CONTENT, "Cosmetics", "CullingCards")
    ui_dir = os.path.join(CONTENT, "uiresources", "images", "culling-cards")
    for f in (glob.glob(os.path.join(card_dir, "CullingCardXP_*.uasset"))
              + glob.glob(os.path.join(card_dir, "Source", "CC_XP_*.uasset"))
              + glob.glob(os.path.join(ui_dir, "CC_XP_*.png"))):
        os.remove(f)

    catalog = [t for t in json.load(open(CATALOG)) if t.get("source") != CATALOG_TAG]
    animated_js, records = {}, []
    next_id = {True: ANIMATED_ID, False: CLASSIC_ID}
    for c in cards:
        is_anim = c["fps"] > 0
        item_id = next_id[is_anim]
        next_id[is_anim] += 1
        asset, texture = "CullingCardXP_" + c["slug"], "CC_XP_" + c["slug"]
        rarity = RARITY_ANIMATED if is_anim else RARITY_CLASSIC

        tex = np.asarray(compose(c["frames"][0], TEX_W, CARD_H))
        write(os.path.join(card_dir, "Source", texture + ".uasset"),
              cooked_texture.rebuild(templates[TEMPLATE_TEXTURE], cooked_texture.mip_chain(tex),
                                     rename=("CC_Artboard-1", texture)))
        write(os.path.join(card_dir, asset + ".uasset"),
              card_asset(templates[TEMPLATE_ASSET], asset, item_id, c["label"], texture, rarity,
                         PRICE_ANIMATED if is_anim else PRICE_CLASSIC))
        if is_anim:
            sheet = Image.new("RGB", (FRAME_W, FRAME_H * len(c["frames"])))
            for k, f in enumerate(c["frames"]):
                sheet.paste(compose(f, FRAME_W, FRAME_H), (0, k * FRAME_H))
            write(os.path.join(ui_dir, texture + ".png"), quantized_png(sheet))
            animated_js[texture] = [len(c["frames"]), c["fps"]]
        else:
            write(os.path.join(ui_dir, texture + ".png"), quantized_png(compose(c["frames"][0], CARD_W, CARD_H)))
        records.append(asset_registry.record("/Game/Cosmetics/CullingCards/" + asset, "CullingCardDataAsset"))
        catalog.append({"tid": item_id, "asset": "/Game/Cosmetics/CullingCards/" + asset,
                        "class": "CullingCardDataAsset", "type": "CullingCard", "displayName": c["label"],
                        "category": "Culling Card", "storeCategory": "Culling Card", "rarity": rarity,
                        "maxQuantity": 1, "purchaseCost": float(PRICE_ANIMATED if is_anim else PRICE_CLASSIC),
                        "premiumCost": 0.0, "resale": 0.5, "purchasable": True, "premiumPurchasable": False, "default": False,
                        "source": CATALOG_TAG})

    asset_registry.save("calling_cards", records)
    asset_registry.build(paks_dir)
    js = (ANIMATED_JS % json.dumps(animated_js, indent=1, sort_keys=True)).encode()
    for view in ("FrontEnd", "hud"):
        write(os.path.join(CONTENT, "uiresources", view, "js", "AnimatedCards.js"), js)
    tag = '<script src="js/Formatters.js"></script>'
    hud = templates[STOCK_HUD].decode("utf-8")
    assert tag in hud
    write(os.path.join(CONTENT, "uiresources", "hud", "hud.html"),
          hud.replace(tag, tag + '\n<script src="js/AnimatedCards.js"></script>', 1).encode("utf-8"))
    from build_catalog import write_catalog       # refuses an item ID used twice
    write_catalog(CATALOG, catalog)
    print("%d calling cards: %d animated, %d classic" % (len(cards), len(animated_js), len(cards) - len(animated_js)))


if __name__ == "__main__":
    main(*sys.argv[1:])
