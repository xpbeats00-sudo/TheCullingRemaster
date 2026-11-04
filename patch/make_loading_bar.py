"""Loading screen with a progress bar and percentage - NOT IN USE.

Tried and reverted: during a map load the LoadingScreen plugin draws its
image layer, not the movie, so the screen went black (and with no image it
crashes). The game shows the branded stills (LoadScreen, LS_FrontEnd); only
write_config() is run, which sets that up.


The game's loading screen (LoadingScreen plugin, DefaultScreen in
DefaultGame.ini) shows a random still with "LOADING" and a tip; it has no
progress bar, and a map load blocks the game thread, so no real progress is
available to show. Instead the screen plays a movie of the branded loading
art with a bar that fills on an easing curve (fast, then slower, capped at
99%); bAutoCompleteWhenLoadingCompletes ends it the moment the load really
finishes. The tip and "LOADING" are still drawn on top by the game.
(The changing strip - bar and percentage - is drawn per frame with PIL and
overlaid on the static art by ffmpeg.)

- Movie: <game>/Victory/Content/Movies/LoadingBar.mp4 (loose, like the
  game's own LoadingScreen.mp4)
- Config: src/Victory/Config/DefaultGame.ini (stock file, DefaultScreen
  switched to the movie), shipped in the patch pak
- Image: the loading widget picks a random entry of Images at startup and
  crashes on an empty list, so it gets one fully transparent 8x8 texture
  (/Game/UI/LoadingScreens/LS_Transparent) that the movie shows through.

usage: python make_loading_bar.py <game root (TheCulling)> <Paks dir>
"""
import math
import os
import subprocess
import sys

from PIL import Image, ImageDraw, ImageFilter

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_catalog import pak_entries, read_entry  # noqa: E402
import make_showdown  # noqa: E402
import make_duo  # noqa: E402

BRAND = os.path.join(HERE, "branding")
BACKGROUND = os.path.join(BRAND, "LoadScreen_preview.png")      # make_branding.py's loading art
WORK = os.path.join(BRAND, "loading_bar")
CONFIG = "Victory/Config/DefaultGame.ini"
MOVIE = "LoadingBar"
TEXTURE_TEMPLATE = "Victory/Content/Cosmetics/CullingCards/Source/CC_Artboard-1.uasset"   # BGRA, never streamed
TRANSPARENT = "/Game/UI/LoadingScreens/LS_Transparent"

W, H = 1920, 1080
# Between the XP mask (ends ~y 930) and the tip line (~y 1010); % to its right.
BAR_X, BAR_Y, BAR_W, BAR_H = 540, 960, 800, 12
PCT_SIZE = 34
FONT = "C:/Windows/Fonts/impact.ttf"
TAU = 7.0                       # seconds: 50% at ~5 s, 90% at ~16 s, 99% at ~32 s
LENGTH = 120                    # seconds of movie (it stops when loading does)
FPS = 30
RED = (204, 0, 0)


def rounded_bar(w, h, color, glow=0):
    pad = glow * 2
    im = Image.new("RGBA", (w + 2 * pad, h + 2 * pad), (0, 0, 0, 0))
    d = ImageDraw.Draw(im)
    d.rounded_rectangle((pad, pad, pad + w - 1, pad + h - 1), radius=h // 2, fill=color)
    if glow:
        halo = im.filter(ImageFilter.GaussianBlur(glow))
        im = Image.alpha_composite(halo, im)
    return im


def make_layers():
    os.makedirs(WORK, exist_ok=True)
    base = Image.open(BACKGROUND).convert("RGBA").resize((W, H))
    track = rounded_bar(BAR_W, BAR_H, (255, 255, 255, 40))
    track_frame = Image.new("RGBA", (BAR_W, BAR_H), (0, 0, 0, 0))
    ImageDraw.Draw(track_frame).rounded_rectangle((0, 0, BAR_W - 1, BAR_H - 1), radius=BAR_H // 2,
                                                  outline=(255, 255, 255, 90), width=1)
    base.alpha_composite(track, (BAR_X, BAR_Y))
    base.alpha_composite(track_frame, (BAR_X, BAR_Y))
    base.convert("RGB").save(os.path.join(WORK, "base.png"))
    return 8                    # glow radius of the fill


STRIP = (BAR_X - 40, BAR_Y - 30, BAR_X + BAR_W + 140, BAR_Y + BAR_H + 30)   # region that changes


def progress(t):
    return min(0.99, 1 - math.exp(-t / TAU))


def strip_frames(glow):
    """RGBA frames of the changing strip: the bar's fill (glowing, rounded)
    and the percentage above it."""
    from PIL import ImageFont
    x0, y0, x1, y1 = STRIP
    font = ImageFont.truetype(FONT, PCT_SIZE)
    pad = 2 * glow
    for k in range(LENGTH * FPS):
        p = progress(k / FPS)
        im = Image.new("RGBA", (x1 - x0, y1 - y0), (0, 0, 0, 0))
        w = round(BAR_W * p)
        if w >= BAR_H:
            bar = rounded_bar(w, BAR_H, RED + (255,), glow=glow)
            im.alpha_composite(bar, (BAR_X - pad - x0, BAR_Y - pad - y0))
        d = ImageDraw.Draw(im)
        text = "%d%%" % int(100 * p)
        top, bottom = font.getbbox(text)[1::2]
        tx, ty = BAR_X + BAR_W + 22 - x0, BAR_Y + BAR_H / 2 - (top + bottom) / 2 - y0
        d.text((tx + 2, ty + 2), text, font=font, fill=(0, 0, 0, 170))
        d.text((tx, ty), text, font=font, fill=(255, 255, 255, 255))
        yield im.tobytes()


def make_movie(game_root, glow):
    out = os.path.join(game_root, "Victory", "Content", "Movies", MOVIE + ".mp4")
    x0, y0, x1, y1 = STRIP
    proc = subprocess.Popen([
        "ffmpeg", "-v", "error", "-y",
        "-loop", "1", "-framerate", str(FPS), "-i", os.path.join(WORK, "base.png"),
        "-f", "rawvideo", "-pix_fmt", "rgba", "-s", "%dx%d" % (x1 - x0, y1 - y0), "-framerate", str(FPS), "-i", "-",
        "-filter_complex", "[0:v][1:v]overlay=x=%d:y=%d:shortest=1,format=yuv420p[v]" % (x0, y0), "-map", "[v]",
        "-c:v", "libx264", "-profile:v", "main", "-preset", "slow", "-crf", "20", "-r", str(FPS),
        "-movflags", "+faststart", out,
    ], stdin=subprocess.PIPE)
    for frame in strip_frames(glow):
        proc.stdin.write(frame)
    proc.stdin.close()
    assert proc.wait() == 0
    print("movie:", out, "%.1f MB" % (os.path.getsize(out) / 1e6))


def write_transparent_texture(paks_dir):
    import struct
    import cooked_texture
    from patch_assets import find_in_paks
    from ue_names import name_hashes
    from ue_package import UPackage
    name = TRANSPARENT.rsplit("/", 1)[1]
    data = cooked_texture.rebuild(find_in_paks(paks_dir, {TEXTURE_TEMPLATE})[TEXTURE_TEMPLATE],
                                  [(8, 8, bytes(8 * 8 * 4))], rename=("CC_Artboard-1", name), fmt="PF_B8G8R8A8")
    up = UPackage(data)
    for k, (s, _) in enumerate(up.names):
        if s.endswith("/" + name):
            up.names[k] = (TRANSPARENT, struct.pack("<HH", *name_hashes(TRANSPARENT)))
    out = os.path.join(HERE, "src", "Victory", "Content", TRANSPARENT[len("/Game/"):] + ".uasset")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "wb").write(up.save())
    print("texture:", out)


def write_config(paks_dir):
    stock = None
    for e in pak_entries(os.path.join(paks_dir, "pakchunk0-WindowsClient.pak")):
        if e[1].endswith(CONFIG):
            stock = read_entry(*([e[0]] + list(e[2:]))).decode("utf-8")
    lines = stock.splitlines(keepends=True)
    for k, line in enumerate(lines):
        if line.startswith("DefaultScreen="):
            start, end = line.index("MoviePaths="), line.index("ImageStretch=")
            lines[k] = (line[:start] + "MoviePaths=,Images=(/Game/UI/LoadingScreens/LoadScreen.LoadScreen, "
                        "/Game/UI/LoadingScreens/LS_FrontEnd.LS_FrontEnd)," + line[end:])
            break
    else:
        raise KeyError("DefaultScreen")
    # Showdown: StartTraining("Practice") travels to TrainingMapAdvanced, so it
    # becomes the arena match (make_showdown.py; the stock Practice map isn't
    # reachable from the Remaster menu).
    for k, line in enumerate(lines):
        if line.startswith("TrainingMapAdvanced"):
            lines[k] = 'TrainingMapAdvanced = "%s"%s' % (make_showdown.URL, line[len(line.rstrip("\r\n")):])
            break
    else:
        raise KeyError("TrainingMapAdvanced")
    # Duo takes the Survival slots (make_duo.py).
    lines = make_duo.set_urls("".join(lines)).splitlines(keepends=True)
    # Bot AI budgets (UNTESTED IN GAME: playtest before releasing). These
    # AIModule classes read their config from Game.ini and no asset stores the
    # values, so they apply. Stock: 6 sight traces per tick (Victory.exe),
    # 0.001 s per frame for EQS queries (BaseGame.ini).
    nl = "\r\n" if "\r\n" in stock else "\n"
    lines.append(nl + "[/Script/AIModule.AISense_Sight]" + nl + "MaxTracesPerTick=24" + nl +
                 nl + "[/Script/AIModule.EnvQueryManager]" + nl + "MaxAllowedTestingTime=0.003" + nl)
    out = os.path.join(HERE, "src", CONFIG)
    os.makedirs(os.path.dirname(out), exist_ok=True)
    open(out, "w", newline="").write("".join(lines))
    print("config:", out)


if __name__ == "__main__":
    write_config(sys.argv[2])
