"""The release consistency gate: what make_release.py checks before it packs.

The patch pak, the server's catalog and the asset registry are made by many
generators; a release built after only some of them ran ships a catalog
selling items the client can't load, or a client with assets the registry
doesn't list. This checks, on what is on disk now:

- catalog.json: every item ID once; nothing from the test/diagnostic content
  (XPTest, XPAnim, Camo_XP_Anim_, TEST BUILD);
- patch/registry: exactly the record sets camos, vfx_camos, eye_skins,
  calling_cards and ranked, each listing exactly the catalog items of its
  source (xp-camos, xp-vfx-camos, xp-eye-skins, xp-calling-cards,
  xp-ranked), and every record
  in the built src/Victory/AssetRegistry.bin (with the stock paks: its count
  is the stock count plus the records);
- every catalog item's asset exists: a sourced item in patch/src, a stock one
  in the stock paks (with --paks) or patch/src;
- patch/src has no test/diagnostic content (make_pak.test_content);
- the generated pages and config are what their generators make: with --paks,
  DefaultGame.ini = make_loading_bar.config_text, FrontEnd.html =
  make_branding.branded_html(stock page), hud.html = the stock HUD with
  make_calling_cards' script (both compared after make_server_config's
  scripts, which make_release adds); without --paks, the menu edits
  (make_branding) are all in FrontEnd.html and DefaultGame.ini exists.

usage: python test_release_consistency.py [--paks <stock Paks dir>] [--src <dir>] [--registry <dir>] [--catalog <catalog.json>]
"""
import argparse
import glob
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_pak  # noqa: E402
from build_catalog import check_unique_tids, pak_entries, stock_paks  # noqa: E402

SRC = os.path.join(HERE, "src")
REGISTRY = os.path.join(HERE, "registry")
CATALOG = os.path.join(HERE, "..", "server", "data", "catalog.json")
# patch/registry/<name>.bin -> the catalog source whose items it lists
RECORD_SETS = {"camos": "xp-camos", "vfx_camos": "xp-vfx-camos", "eye_skins": "xp-eye-skins",
               "calling_cards": "xp-calling-cards", "ranked": "xp-ranked"}
TEST_WORDS = ("XPTest", "XPAnim", "Camo_XP_Anim_", "TEST BUILD")
UI = "Victory/Content/uiresources"
FRONTEND = UI + "/FrontEnd/FrontEnd.html"
HUD = UI + "/hud/hud.html"
CONFIG = "Victory/Config/DefaultGame.ini"
REGISTRY_BIN = "Victory/AssetRegistry.bin"


def _fstring(data, p):
    n = struct.unpack_from("<i", data, p)[0]
    p += 4
    if n < 0:
        return data[p:p - 2 * n].decode("utf-16le").rstrip("\0"), p - 2 * n
    return data[p:p + n].decode("latin1").rstrip("\0"), p + n


def read_records(path):
    """(package paths, record bytes) of an asset_registry.save() file."""
    data = open(path, "rb").read()
    count = struct.unpack_from("<i", data, 0)[0]
    p, packages = 4, []
    for _ in range(count):
        strings = []
        for _ in range(6):
            s, p = _fstring(data, p)
            strings.append(s)
        packages.append(strings[4])
        p += 16
    if p != len(data):
        raise ValueError("%s: %d bytes after its %d records" % (path, len(data) - p, count))
    return packages, data[4:]


def asset_file(asset):
    """/Game/X/Y -> Victory/Content/X/Y.uasset"""
    return "Victory/Content/" + asset[len("/Game/"):] + ".uasset"


def _read(path, binary=False):
    with open(path, "rb") as f:
        data = f.read()
    return data if binary else data.decode("utf-8")


def run(src=SRC, registry=REGISTRY, catalog_path=CATALOG, paks=None):
    """([problem], [note]) for what is on disk."""
    problems, notes = [], []
    bad = problems.append
    at = lambda rel: os.path.join(src, *rel.split("/"))  # noqa: E731

    catalog = json.load(open(catalog_path, encoding="utf-8"))
    try:
        check_unique_tids(catalog)
    except ValueError as e:
        bad(str(e))
    for item in catalog:
        text = json.dumps(item)
        word = next((w for w in TEST_WORDS if w in text), None)
        if word:
            bad("catalog item %s (%s) is test content (%s)" % (item["tid"], item.get("asset"), word))

    src_files = {}
    for root, _, names in os.walk(src):
        for name in names:
            rel = os.path.relpath(os.path.join(root, name), src).replace(os.sep, "/")
            src_files[rel.lower()] = rel
    stock = None
    if paks:
        stock = set()
        for pak in stock_paks(paks):
            for e in pak_entries(pak):
                stock.add(e[1].replace("../../../", "").lower())

    # Registry record sets <-> sourced catalog items.
    have = {os.path.splitext(os.path.basename(f))[0]: f for f in glob.glob(os.path.join(registry, "*.bin"))}
    for extra in sorted(set(have) - set(RECORD_SETS)):
        bad("patch/registry/%s.bin is no generator's record set (stale? it would add its records to the registry)" % extra)
    blobs, added = [], 0
    for name, source in sorted(RECORD_SETS.items()):
        items = {i["asset"] for i in catalog if i.get("source") == source}
        if name not in have:
            bad("patch/registry/%s.bin is missing: run the generator that writes %s items" % (name, source))
            continue
        try:
            packages, blob = read_records(have[name])
        except (ValueError, struct.error) as e:
            bad("patch/registry/%s.bin can't be read: %s" % (name, e))
            continue
        blobs.append((name, blob))
        added += len(packages)
        if len(set(packages)) != len(packages):
            bad("patch/registry/%s.bin lists a package twice" % name)
        missing, extra = sorted(items - set(packages)), sorted(set(packages) - items)
        if missing:
            bad("%d %s catalog items have no registry record (%s): the game won't list them"
                % (len(missing), source, ", ".join(missing[:3])))
        if extra:
            bad("%d records in patch/registry/%s.bin aren't in the catalog (%s)" % (len(extra), name, ", ".join(extra[:3])))
    built = at(REGISTRY_BIN)
    if not os.path.exists(built):
        bad("no %s in patch/src: asset_registry.build hasn't run" % REGISTRY_BIN)
    else:
        data = _read(built, True)
        for name, blob in blobs:
            if blob not in data:
                bad("%s doesn't hold patch/registry/%s.bin's records: rebuild it (asset_registry.build)" % (REGISTRY_BIN, name))
        if paks:
            import asset_registry
            from patch_assets import find_in_paks
            count, _ = asset_registry._end_of_assets(find_in_paks(paks, {REGISTRY_BIN})[REGISTRY_BIN])
            if struct.unpack_from("<i", data, 20)[0] != count + added:
                bad("%s lists %d assets, not the stock %d + %d records"
                    % (REGISTRY_BIN, struct.unpack_from("<i", data, 20)[0], count, added))

    # Every item's asset exists.
    missing = []
    for item in catalog:
        rel = asset_file(item["asset"]).lower()
        if rel in src_files:
            continue
        if item.get("source"):
            missing.append("%s %s (%s, not in patch/src)" % (item["tid"], item["asset"], item["source"]))
        elif stock is not None and rel not in stock:
            missing.append("%s %s (stock, in neither the paks nor patch/src)" % (item["tid"], item["asset"]))
    if missing:
        bad("%d catalog items have no asset: %s%s" % (len(missing), "; ".join(missing[:5]), " ..." if len(missing) > 5 else ""))
    if stock is None:
        notes.append("stock catalog items not checked against the paks (no --paks)")

    for rel, why in make_pak.test_content(src):
        bad("patch/src/%s is test content (%s)" % (rel, why))

    # Generated pages and config.
    import make_branding
    import make_server_config
    for rel in (FRONTEND, HUD, CONFIG):
        if not os.path.exists(at(rel)):
            bad("patch/src/%s is missing (not generated)" % rel)
    if os.path.exists(at(FRONTEND)):
        page = _read(at(FRONTEND))
        menu = make_branding.add_leaderboard(make_branding.add_friends(make_branding.show_survival(
            make_branding.add_airdrop_unlocks(make_branding.add_play_screen(page)))))
        if menu != page:
            bad("FrontEnd.html is missing some of make_branding's menu edits: run make_branding.py --menu-only")
    if paks:
        import make_loading_bar
        from patch_assets import find_in_paks
        stock_ui = find_in_paks(paks, {FRONTEND, HUD})
        if os.path.exists(at(CONFIG)) and _read(at(CONFIG)) != make_loading_bar.config_text(paks):
            bad("DefaultGame.ini isn't what make_loading_bar.py write_config makes: run it again")
        if os.path.exists(at(FRONTEND)):
            want = make_server_config.add_scripts(make_branding.branded_html(stock_ui[FRONTEND].decode("utf-8")), "FrontEnd")
            if make_server_config.add_scripts(_read(at(FRONTEND)), "FrontEnd") != want:
                bad("FrontEnd.html isn't what make_branding.py makes from the stock page: run it again")
        if os.path.exists(at(HUD)):
            tag = '<script src="js/Formatters.js"></script>'
            hud = stock_ui[HUD].decode("utf-8").replace(tag, tag + '\n<script src="js/AnimatedCards.js"></script>', 1)
            if make_server_config.add_scripts(_read(at(HUD)), "hud") != make_server_config.add_scripts(hud, "hud"):
                bad("hud.html isn't what make_calling_cards.py makes from the stock HUD: run it again")
    else:
        notes.append("DefaultGame.ini, FrontEnd.html and hud.html not compared with their generators (no --paks)")
    return problems, notes


def main(argv=None):
    ap = argparse.ArgumentParser(description="Release consistency gate")
    ap.add_argument("--paks", help="the stock Paks folder (pakchunk paks; *_P.pak are ignored)")
    ap.add_argument("--src", default=SRC)
    ap.add_argument("--registry", default=REGISTRY)
    ap.add_argument("--catalog", default=CATALOG)
    a = ap.parse_args(argv)
    problems, notes = run(a.src, a.registry, a.catalog, a.paks)
    for n in notes:
        print("note  " + n)
    for p in problems:
        print("FAIL  " + p)
    if problems:
        print("release consistency: %d problem(s): not releasable" % len(problems))
        return 1
    print("ok    release consistency: catalog, registry, assets, generated pages and config agree")
    return 0


if __name__ == "__main__":
    sys.exit(main())
