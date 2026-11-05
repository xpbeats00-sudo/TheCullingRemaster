"""Build a browser harness of the in-match HUD (hud.html) for layout checks.

The harness is the game's own HUD page - the stock hud.html, CSS, libraries
and images from the base paks - with the Remaster's scripts from patch/src
(hud.js, ShowdownHud.js, AnimatedCards.js, RemasterServer.js) and the same
script tags the build adds (make_calling_cards.py, make_server_config.py),
plus patch/hud_harness/harness.js, which stands in for the game: it fires
the engine events a match sends (health, weapons, a Duo teammate, kill
messages, the match timer, spectating, the Showdown panel) and measures the
elements' rectangles.

Output goes to patch/research/hud-harness/ (git-ignored): serve it with
  python -m http.server 8765 --directory patch/research/hud-harness
and open http://127.0.0.1:8765/uiresources/hud/harness.html?scenario=match
(scenarios: match, duo, spectate, showdown, scoreboard). test_hud_layout.js
does that headless at every checked resolution.

usage: python hud_harness.py [<Paks dir>] [<out dir>]
"""
import os
import shutil
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_catalog import pak_entries, read_entry  # noqa: E402
import make_server_config  # noqa: E402

# The game next to the repo (C:/Culling/TheCulling), or next to a worktree of it.
PAKS = next((p for p in (os.path.join(HERE, "..", "TheCulling", "Victory", "Content", "Paks"),
                         os.path.join(HERE, "..", "..", "TheCulling", "Victory", "Content", "Paks"))
             if os.path.isdir(p)), os.path.join(HERE, "..", "TheCulling", "Victory", "Content", "Paks"))
OUT = os.path.join(HERE, "research", "hud-harness")
UI = "Victory/Content/uiresources/"
# What the HUD page doesn't use: the menus, their videos, the Closure compiler.
SKIP = ("FrontEnd/", "video/", "compiler.jar", "InGameElements/")
OURS = os.path.join(HERE, "src", "Victory", "Content", "uiresources", "hud", "js")
HARNESS_JS = os.path.join(HERE, "hud_harness", "harness.js")
CARDS_TAG = '<script src="js/Formatters.js"></script>'


def stock_files(paks_dir):
    """Yield (path under uiresources/, bytes) from the stock paks only."""
    for pak in sorted(os.listdir(paks_dir)):
        if not (pak.startswith("pakchunk") and pak.endswith(".pak")):
            continue    # the Remaster's own patch pak is applied from patch/src instead
        for f, name, off, usize, method, blocks in pak_entries(os.path.join(paks_dir, pak)):
            rel = name.replace("../../../", "")
            if not rel.startswith(UI):
                continue
            sub = rel[len(UI):]
            if sub.startswith(SKIP):
                continue
            yield sub, (f, off, usize, method, blocks)


def hud_html(stock):
    """The HUD page as the build makes it (make_calling_cards + make_server_config)."""
    html = stock.decode("utf-8")
    assert CARDS_TAG in html
    html = html.replace(CARDS_TAG, CARDS_TAG + '\n<script src="js/AnimatedCards.js"></script>', 1)
    return make_server_config.add_scripts(html, "hud")


def build(paks_dir=PAKS, out=OUT):
    root = os.path.join(out, "uiresources")
    count = 0
    for sub, entry in stock_files(paks_dir):
        dst = os.path.join(root, *sub.split("/"))
        if os.path.exists(dst) and os.path.getsize(dst) == entry[2] and sub != "hud/hud.html":
            continue    # extracted on an earlier run
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        with open(dst, "wb") as f:
            f.write(read_entry(*entry))
        count += 1
    hud_dir = os.path.join(root, "hud")
    stock = open(os.path.join(hud_dir, "hud.html"), "rb").read()
    # The stock page is kept as stock_hud.html; hud.html becomes what the build ships.
    shutil.copyfile(os.path.join(hud_dir, "hud.html"), os.path.join(hud_dir, "stock_hud.html"))
    page = hud_html(stock)
    for name in os.listdir(OURS):
        if name.endswith(".js"):
            shutil.copyfile(os.path.join(OURS, name), os.path.join(hud_dir, "js", name))
    with open(os.path.join(hud_dir, "hud.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(page)
    os.makedirs(os.path.join(hud_dir, "harness"), exist_ok=True)
    shutil.copyfile(HARNESS_JS, os.path.join(hud_dir, "harness", "harness.js"))
    harness = page.replace("</body>", '<script src="harness/harness.js"></script>\n</body>', 1)
    assert harness != page, "hud.html has no </body>"
    with open(os.path.join(hud_dir, "harness.html"), "w", encoding="utf-8", newline="\n") as f:
        f.write(harness)
    print("hud harness: %d stock files extracted, page at %s" % (count, os.path.join(hud_dir, "harness.html")))
    return out


if __name__ == "__main__":
    build(*sys.argv[1:])
