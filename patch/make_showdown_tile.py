"""Play-screen tile for Showdown (700x900 like the stock ones): the centre
arena (an in-game screenshot of the stage and its sunken ring) graded grey
normally and red when selected, as SoloPlay, with a "COMING SOON" band: the
mode isn't playable yet (no player-vs-player matches), so the tile can't be
queued (make_branding.py).

usage: python make_showdown_tile.py [source screenshot]
  default source: patch/branding/showdown_arena_source.png
"""
import os
import sys

from PIL import Image, ImageDraw, ImageEnhance, ImageFont, ImageOps

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "branding", "showdown_arena_source.png")
OUT = os.path.join(HERE, "src", "Victory", "Content", "uiresources", "FrontEnd", "images")
FONT = "C:/Windows/Fonts/impact.ttf"
W, H = 700, 900
# The part of the 976x579 window capture with the stage gantry and the ring,
# clear of the HUD (compass, FUNC count, health bar, weapon).
CROP = (80, 34, 440, 497)


def grade(src, selected):
    img = src.crop(CROP).resize((W, H), Image.LANCZOS).convert("RGB")
    grey = ImageEnhance.Contrast(ImageOps.grayscale(img)).enhance(1.35)
    if selected:
        img = ImageOps.colorize(grey, black=(25, 0, 0), white=(255, 120, 110))
    else:
        img = ImageOps.colorize(grey, black=(10, 10, 12), white=(205, 205, 210))
    img = img.convert("RGBA")
    # Darker towards the bottom, where the tile's title sits.
    shade = Image.new("RGBA", (W, H))
    d = ImageDraw.Draw(shade)
    for y in range(H):
        a = int(max(0, (y - H * 0.45) / (H * 0.55)) * 200)
        d.line([(0, y), (W, y)], fill=(0, 0, 0, a))
    img.alpha_composite(shade)
    # "COMING SOON" band across the top.
    band = Image.new("RGBA", (W, H))
    d = ImageDraw.Draw(band)
    d.rectangle((0, 56, W, 126), fill=(204, 0, 0, 230) if selected else (150, 0, 0, 215))
    font = ImageFont.truetype(FONT, 46)
    text = "COMING SOON"
    tw = d.textlength(text, font=font)
    d.text(((W - tw) / 2, 66), text, font=font, fill=(255, 255, 255, 255))
    img.alpha_composite(band)
    border = Image.new("RGBA", (W, H))
    ImageDraw.Draw(border).rectangle((0, 0, W - 1, H - 1), outline=(150, 0, 0, 255) if selected else (60, 60, 60, 255), width=8)
    img.alpha_composite(border)
    return img.convert("RGB")


def main(source=SOURCE):
    src = Image.open(source)
    os.makedirs(OUT, exist_ok=True)
    grade(src, False).save(os.path.join(OUT, "ShowdownPlay.png"))
    grade(src, True).save(os.path.join(OUT, "ShowdownPlay_sel.png"))
    print("Showdown tile ->", OUT)


if __name__ == "__main__":
    main(*sys.argv[1:])
