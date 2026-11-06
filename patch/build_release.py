"""One command for a client release: every generator in order, the checks,
then make_release.py --full.

  python patch/build_release.py <version> --game <game dir> --camos <dir> --cards <dir> [options]
  python patch/build_release.py 1.4.0 --game C:/Culling/TheCulling --camos C:/Culling/Camos --cards C:/Culling/CallingCards

Steps (each one's output is shown; the first failure stops the build):

  0. preflight: every input exists (the install and its stock paks and stock
     Victory.exe, the camo and calling-card folders, the branding art), the
     git tree is clean (make_release.py would refuse it at the end anyway)
  1. test/diagnostic leftovers (make_pak.TEST_NAMES: *_XPAnim*, Camo_XP_Anim_*,
     *XPTest*, from patch/diagnostics) are deleted from patch/src
  2. a staging folder holding only the stock pakchunk paks (hard links, so no
     copy; the install itself is only read), and the stock FrontEnd.html
  3. generators, in this order (later ones build on earlier output):
       build_catalog.py           only with --catalog (rewrites the stock part of catalog.json)
       make_airdrop_unlocks.py    airdrop items + AirdropUnlocks.js
       make_airdrop_prices.py     airdrop prices 25% off (the cooked AirDropPackages)
       patch_assets.py            gameplay tuning, bot names
       make_bot_ai.py             bot AI tier (default Experienced)
       make_tree_collision.py     Elm / Linden trunk collision up into the crown (stuck in trees)
       make_weapon_balance.py     weapon stats from patch/balance/weapon_balance.json (empty: stock)
       make_loading_bar.py        write_config only: DefaultGame.ini
       make_branding.py           logos, font, FrontEnd.html, loading screens (--skip-intro:
                                  the install's LoadingScreen.mp4 ships as it is; make_intro
                                  writes into the game folder, which a build never changes)
       make_branding.py --menu-only
       make_night_sky.py, make_night_cube.py (reads the night sky), make_moon.py,
       make_meteors.py, make_sky_fx.py, then build_menu_arenas.py (it streams
       Arena_Moon and places the sky effects, and drops levels it doesn't know),
       make_showdown_tile.py      the menu visuals
       make_camos.py              camo skins (Necro Mist included), registry camos.bin
       make_vfx_camos.py          VFX camos (Dark Matter, Wave), registry vfx_camos.bin
       make_eye_skins.py          Necro Mist outfits, registry eye_skins.bin
       make_calling_cards.py      calling cards, hud.html, registry calling_cards.bin
       make_ranked.py             rank emblems and cards, registry ranked.bin
       make_card_image_map.py     CardImageMap.js (after every card exists)
       make_showdown.py           Showdown mode, server/data/showdown.json
       make_rain.py               the rain particle systems
       make_weather.py            Jungle Night and Prison Night (built on make_showdown's
                                  Jungle_P) and patch/weather_maps.h; the server offers them
                                  only with CULLING_NIGHT_MAPS=1
       extract_func_anims.py      the Func animation assets
  4. the release consistency gate (test_release_consistency.py --paks <stage>)
  5. every patch, deploy and launcher test (TESTS below)
  6. make_release.py <server> <version> --full <game dir>

Inputs outside the repo are arguments and must exist: --game, --camos,
--cards, --branding (default patch/branding: remaster_logo_source.png,
xp_mask_source.png, download_creepster/, ranked/source/, and
showdown_arena_source.png unless --showdown-tile is given; with another
folder, patch/branding is made a directory junction to it). The generators
rewrite tracked files (server/data/catalog.json, showdown.json, the
generated .js in patch/src); if those change, make_release.py refuses the
dirty tree: review and commit them, then run again with --skip-generators.

Then publish the client (Publish Release.bat on the VPS) before updating the
server: the server must never sell items the live client lacks
(docs/UPDATE_INFRASTRUCTURE.md).

Options:
  --server URL          (default https://xplab.shop:8443)
  --skip-showdown-tile  don't run make_showdown_tile.py (keeps any ShowdownPlay*.png in patch/src; without
                        them the SHOWDOWN tile has no picture, as in 1.3.5)
  --catalog             also rebuild the stock catalog (build_catalog.py)
  --skip-generators     steps 0-2, then 4-6 (after a reviewed, committed generator run)
  --from GENERATOR      resume step 3 at that generator (e.g. --from make_camos.py) after a failure
  --no-release          stop after the tests (step 5)
  --stage DIR           the staging folder (default: a temp folder, removed after)
  --key, --out, --allow-dirty, --overwrite, --skip-gate, --no-setup   passed to make_release.py
"""
import argparse
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import make_pak  # noqa: E402
import make_release  # noqa: E402
from build_catalog import STOCK_PAK  # noqa: E402

PY = [sys.executable]
BRANDING = os.path.join(HERE, "branding")
BRANDING_FILES = ("remaster_logo_source.png", "xp_mask_source.png", "download_creepster/Creepster-Regular.ttf",
                  "download_creepster/OFL.txt") + tuple("ranked/source/%s.webp" % t for t in (
                      "Scrapper", "Contender", "Blooded", "Hunter", "Executioner", "Reaper", "Warlord", "Apex", "Legend"))
SYSTEM_FILES = ("C:/Windows/Fonts/impact.ttf",)       # make_branding's loading screens
STOCK_FRONTEND = "Victory/Content/uiresources/FrontEnd/FrontEnd.html"
SHOWDOWN_IMAGES = "Victory/Content/uiresources/FrontEnd/images"
SHOWDOWN_TILES = ("ShowdownPlay.png", "ShowdownPlay_sel.png")
NPM = "npm.cmd" if os.name == "nt" else "npm"


class BuildError(Exception):
    pass


def generators(a, stage, frontend):
    """[(label, argv)] in build order."""
    g = lambda name, *args: (name, PY + [os.path.join(HERE, name)] + list(args))  # noqa: E731
    steps = []
    if a.catalog:
        steps.append(g("build_catalog.py", stage, os.path.join(ROOT, "server", "data", "catalog.json")))
    steps += [
        g("make_airdrop_unlocks.py", stage),
        g("make_airdrop_prices.py", stage),
        g("patch_assets.py", stage),
        g("make_bot_ai.py", stage),
        g("make_tree_collision.py", stage),
        g("make_weapon_balance.py", stage),
        g("make_loading_bar.py", a.game, stage),
        g("make_branding.py", a.game, frontend, stage, "--skip-intro"),
        g("make_branding.py", "--menu-only"),
        g("make_night_sky.py", stage),
        g("make_night_cube.py", stage),
        g("make_moon.py", stage),
        g("make_meteors.py", stage),
        g("make_sky_fx.py", stage),
        g("build_menu_arenas.py", stage),
    ]
    if not a.skip_showdown_tile:
        steps.append(g("make_showdown_tile.py", a.showdown_tile))
    steps += [
        g("make_camos.py", stage, a.camos),
        g("make_vfx_camos.py", stage),
        g("make_eye_skins.py", stage),
        g("make_calling_cards.py", stage, a.cards),
        g("make_ranked.py", stage),
        g("make_card_image_map.py", stage),
        g("make_showdown.py", stage),
        g("make_rain.py", stage),
        g("make_weather.py", stage),
        g("extract_func_anims.py", a.game),
    ]
    return steps


def tests(a, stage):
    """[(label, argv, cwd)]: every patch, deploy and launcher test."""
    exe = os.path.join(a.game, *make_release.GAME_EXE.split("/"))
    p = lambda name, *args: (name, PY + [os.path.join(HERE, name)] + list(args), ROOT)  # noqa: E731
    d = lambda name: (name, ["node", os.path.join(ROOT, "deploy", name)], ROOT)  # noqa: E731
    n = lambda name: (name, ["node", os.path.join(HERE, name)], ROOT)  # noqa: E731
    return [
        p("test_patch_exe.py", exe), p("test_make_pak.py"), p("test_make_release.py"), p("test_stock_paks.py"),
        p("test_release_gate.py"), p("test_extract_func_anims.py"), p("test_menu_items.py"),
        p("test_match_urls.py", stage), p("test_eye_skins.py", stage), p("test_loot_tables.py"),
        p("test_make_showdown.py", stage),
        p("test_vfx_camos.py", stage),
        p("test_custom_match.py", stage), n("test_showdown_hud.js"), n("test_team_hud.js"), n("test_hud_layout.js"),
        n("test_ranked_hud.js"), n("test_ranked_menu.js"), n("test_showdown_menu.js"), n("test_remaster_panels.js"),
        # Coherent UI runs ES5 (and the stock scripts' const): one ES2015 line
        # stops a whole menu or HUD script, so every shipped UI script is linted.
        p("lint_es5.py", "--release"), p("test_lint_es5.py"), p("test_build_release.py"),
        p("test_airdrop_prices.py", stage), p("test_weapon_balance.py", stage), p("test_bot_ai.py", stage),
        p("test_patch_assets.py", stage),
        p("test_weather.py", stage), p("test_tree_collision.py", stage), p("test_measure_loading.py"),
        p("test_netplay_check.py", exe), p("test_netplay.py", exe),
        # The native module (fixes 5, 7-10 and the weather) compiled and run against fake game
        # objects: these need the Visual Studio C++ tools, as build_showdown_rounds.py does.
        p("build_showdown_rounds.py", "--check"), p("test_native_module.py"), p("test_weather_native.py", exe),
        p("test_unstick_native.py", exe),
        d("stage_objects.test.js"), d("publish.test.js"), d("make_manifest.test.js"),
        ("launcher: npm test", [NPM, "test"], os.path.join(ROOT, "launcher")),
    ]


# Test files that tests() doesn't run itself: test_build_release.py checks
# every other patch/test_*.py and test_*.js is in tests(), so a new test can't
# be left out of the release build by mistake.
RUN_ELSEWHERE = {
    "test_release_consistency.py": "the release consistency gate step, before tests()",
    "test_custom_menu.js": "test_custom_match.py runs it",
    "test_custom_lobby.js": "test_custom_match.py runs it (with the stock Custom.js from the paks)",
}


def run(label, argv, cwd=ROOT):
    print("\n== %s" % label, flush=True)
    t = time.time()
    r = subprocess.run(argv, cwd=cwd)
    if r.returncode:
        raise BuildError("%s failed (exit %d): nothing after it ran" % (label, r.returncode))
    print("   (%s: %.0f s)" % (label, time.time() - t), flush=True)


def preflight(a):
    missing = []
    need = lambda path, what: missing.append("%s (%s)" % (path, what)) if not os.path.exists(path) else None  # noqa: E731
    try:
        make_release.check_game_dir(a.game)
        make_release.check_source_exe(a.game)
    except make_release.ReleaseError as e:
        raise BuildError(str(e))
    paks = os.path.join(a.game, "Victory", "Content", "Paks")
    stock = [n for n in os.listdir(paks) if STOCK_PAK.match(n)]
    if len(stock) < 8:
        missing.append("%s: only %d stock pakchunk paks (%s)" % (paks, len(stock), ", ".join(stock)))
    need(a.camos, "--camos: the Camos folder (Gewehr and BoneCrusher packs)")
    need(a.cards, "--cards: the CallingCards folder")
    for rel in BRANDING_FILES:
        need(os.path.join(a.branding, *rel.split("/")), "--branding art")
    if a.skip_showdown_tile:
        tiles = [os.path.join(HERE, "src", *SHOWDOWN_IMAGES.split("/"), n) for n in SHOWDOWN_TILES]
        if not all(os.path.exists(t) for t in tiles):
            print("WARNING: no ShowdownPlay*.png in patch/src: the Play screen's SHOWDOWN tile has no picture "
                  "(as in release 1.3.5)")
    else:
        need(a.showdown_tile, "--showdown-tile: the Showdown tile's screenshot (or --skip-showdown-tile)")
    for f in SYSTEM_FILES:
        need(f, "a Windows font the generators draw with")
    if not shutil.which("node"):
        missing.append("node (deploy and launcher tests, make_manifest.js)")
    try:
        import build_showdown_rounds
        build_showdown_rounds.find_cl()
    except (SystemExit, Exception):
        missing.append("the Visual Studio C++ tools (cl.exe: the native module's check and tests)")
    if missing:
        raise BuildError("missing inputs:\n" + "\n".join("  " + m for m in missing))
    if not a.allow_dirty:
        _, _, changed = make_release.git_state()
        if changed:
            raise BuildError("the git tree has uncommitted changes (%s): commit them first (or --allow-dirty)"
                             % ", ".join(changed[:5]))


def link_branding(branding):
    """The generators read patch/branding: make it a junction to --branding."""
    if os.path.normcase(os.path.abspath(branding)) == os.path.normcase(BRANDING):
        return
    if os.path.exists(BRANDING):
        if os.path.normcase(os.path.realpath(BRANDING)) != os.path.normcase(os.path.realpath(branding)):
            raise BuildError("patch/branding already exists and isn't %s: remove it or pass --branding %s"
                             % (branding, BRANDING))
        return
    subprocess.run(["cmd", "/c", "mklink", "/J", BRANDING, os.path.abspath(branding)], check=True,
                   stdout=subprocess.DEVNULL)
    print("patch/branding -> %s (junction)" % branding)


def clean_test_content():
    removed = []
    src = os.path.join(HERE, "src")
    for root, _, names in os.walk(src):
        for name in names:
            rel = os.path.relpath(os.path.join(root, name), src).replace(os.sep, "/")
            if make_pak.TEST_NAMES.search(rel):
                os.remove(os.path.join(root, name))
                removed.append(rel)
    if removed:
        print("removed %d test/diagnostic file(s) from patch/src (%s%s)"
              % (len(removed), ", ".join(removed[:3]), ", ..." if len(removed) > 3 else ""))


def stage_paks(game, stage):
    """stage/Paks: the stock pakchunk paks only, hard-linked (the install is only read)."""
    paks = os.path.join(game, "Victory", "Content", "Paks")
    out = os.path.join(stage, "Paks")
    os.makedirs(out, exist_ok=True)
    for name in sorted(os.listdir(paks)):
        if not STOCK_PAK.match(name):
            print("  staging skips %s (not a stock pak)" % name)
            continue
        dst = os.path.join(out, name)
        if not os.path.exists(dst):
            try:
                os.link(os.path.join(paks, name), dst)
            except OSError:
                shutil.copy2(os.path.join(paks, name), dst)
    from patch_assets import find_in_paks
    frontend = os.path.join(stage, "FrontEnd.html")
    with open(frontend, "wb") as f:
        f.write(find_in_paks(out, {STOCK_FRONTEND})[STOCK_FRONTEND])
    print("staged %s: %d stock paks, the stock FrontEnd.html" % (out, len(os.listdir(out))))
    return out, frontend


def main(argv=None):
    ap = argparse.ArgumentParser(description="Build a client release in one command (see the top of this file)")
    ap.add_argument("version")
    ap.add_argument("--game", required=True, help="the stock game install (absolute), e.g. C:/Culling/TheCulling")
    ap.add_argument("--camos", required=True, help="the Camos folder (make_camos.py)")
    ap.add_argument("--cards", required=True, help="the CallingCards folder (make_calling_cards.py)")
    ap.add_argument("--branding", default=BRANDING, help="the branding art folder (default patch/branding)")
    ap.add_argument("--showdown-tile", help="the Showdown tile screenshot (default <branding>/showdown_arena_source.png)")
    ap.add_argument("--skip-showdown-tile", action="store_true",
                    help="don't run make_showdown_tile.py (its source screenshot isn't in the repo or branding folder)")
    ap.add_argument("--server", default="https://xplab.shop:8443")
    ap.add_argument("--catalog", action="store_true", help="also rebuild the stock catalog (build_catalog.py)")
    ap.add_argument("--skip-generators", action="store_true")
    ap.add_argument("--from", dest="start_at", metavar="GENERATOR",
                    help="resume at this generator (e.g. make_camos.py) after a failure; the earlier ones' output is kept")
    ap.add_argument("--no-release", action="store_true")
    ap.add_argument("--stage")
    for flag in ("--allow-dirty", "--overwrite", "--skip-gate", "--no-setup"):
        ap.add_argument(flag, action="store_true")
    ap.add_argument("--key")
    ap.add_argument("--out")
    a = ap.parse_args(argv)
    a.showdown_tile = a.showdown_tile or os.path.join(a.branding, "showdown_arena_source.png")
    started = time.time()
    stage = a.stage or tempfile.mkdtemp(prefix="culling-stage-")
    try:
        preflight(a)
        link_branding(a.branding)
        clean_test_content()
        paks, frontend = stage_paks(a.game, stage)
        if not a.skip_generators:
            steps = generators(a, paks, frontend)
            if a.start_at:
                names = [label for label, _ in steps]
                if a.start_at not in names:
                    raise BuildError("--from %s: not a generator of this build (%s)" % (a.start_at, ", ".join(names)))
                steps = steps[names.index(a.start_at):]
            for label, argv_ in steps:
                run(label, argv_)
            clean_test_content()
        run("release consistency gate", PY + [os.path.join(HERE, "test_release_consistency.py"), "--paks", paks])
        for label, argv_, cwd in tests(a, paks):
            run(label, argv_, cwd)
        if a.no_release:
            print("\nbuilt and checked (--no-release): make_release.py not run")
            return 0
        cmd = PY + [os.path.join(HERE, "make_release.py"), a.server, a.version, "--full", os.path.abspath(a.game)]
        for flag in ("allow_dirty", "overwrite", "skip_gate", "no_setup"):
            if getattr(a, flag):
                cmd.append("--" + flag.replace("_", "-"))
        for flag in ("key", "out"):
            if getattr(a, flag):
                cmd += ["--" + flag, getattr(a, flag)]
        run("make_release.py", cmd)
        print("\nrelease %s built in %.0f min. Publish the client first (Publish Release.bat on the VPS), "
              "then update the server." % (a.version, (time.time() - started) / 60))
        return 0
    except BuildError as e:
        print("\nbuild_release: " + str(e), file=sys.stderr)
        return 1
    finally:
        if not a.stage:
            shutil.rmtree(stage, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
