"""test_release_consistency.py (the release gate) on a throwaway patch tree:
a consistent one passes, and each kind of inconsistency is caught.

usage: python test_release_gate.py
"""
import json
import os
import shutil
import struct
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import asset_registry  # noqa: E402
import make_branding as mb  # noqa: E402
import test_release_consistency as gate  # noqa: E402

failures = []


def put(root, rel, data):
    path = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data if isinstance(data, bytes) else data.encode("utf-8"))


def page():
    """A FrontEnd.html that already has every make_branding menu edit."""
    tiles = "".join('<li id="%s"><p>%s</p></li>\n' % kv for kv in mb.PLAY_TEXT.items())
    return ("<head></head>\n" + tiles + mb.SHOWDOWN_SCRIPT + "\n<script src=\"js/AirdropUnlocks.js\"></script>\n"
            + mb.SURVIVAL_ITEM + mb.FRIENDS_ITEM + mb.LEADERBOARD_ITEM
            + mb.FRIENDS_SCRIPT + "\n  " + mb.LEADERBOARD_SCRIPT + "\n")


def tree(root):
    """A consistent patch tree: src, registry, catalog. Returns (src, registry, catalog)."""
    src, reg, cat = os.path.join(root, "src"), os.path.join(root, "registry"), os.path.join(root, "catalog.json")
    os.makedirs(reg)
    catalog = [{"tid": 100100, "asset": "/Game/Cosmetics/Clothing/Hair_DefaultM", "displayName": "Stock hair"}]
    folders = {"camos": "WeaponSkins/IceAxe_XP_Frost_Plasma", "vfx_camos": "WeaponSkins/Katana_XP_VFX_Dark_Matter",
               "eye_skins": "Clothing/XP_EyeMask_Blood_Red",
               "calling_cards": "CullingCards/CullingCardXP_Akira_Slide", "ranked": "CullingCards/CullingCardXP_Ranked_Scrapper"}
    blobs = b""
    for k, (name, source) in enumerate(sorted(gate.RECORD_SETS.items())):
        asset = "/Game/Cosmetics/" + folders[name]
        catalog.append({"tid": 800000 + k, "asset": asset, "displayName": name, "source": source})
        put(src, gate.asset_file(asset), b"\0package\0")
        records = [asset_registry.record(asset, "DataAsset")]
        with open(os.path.join(reg, name + ".bin"), "wb") as f:
            f.write(struct.pack("<i", len(records)) + b"".join(records))
        blobs += b"".join(records)
    put(src, gate.REGISTRY_BIN, b"stock registry head" + blobs + b"stock registry tail")
    put(src, gate.FRONTEND, page())
    put(src, gate.HUD, "<head></head><script src=\"js/hud.js\"></script>")
    put(src, gate.CONFIG, "[/Script/EngineSettings.GameMapsSettings]\n")
    with open(cat, "w") as f:
        json.dump(catalog, f)
    return src, reg, cat


def case(name, mutate, expect):
    root = tempfile.mkdtemp(prefix="release-gate-test-")
    try:
        src, reg, cat = tree(root)
        if mutate:
            mutate(src, reg, cat)
        problems, _ = gate.run(src, reg, cat)
        if expect is None:
            ok = problems == []
        else:
            ok = any(expect in p for p in problems)
        print(("ok    " if ok else "FAIL  ") + name + ("" if ok else ": %s" % problems))
        if not ok:
            failures.append(name)
    finally:
        shutil.rmtree(root, ignore_errors=True)


def edit_catalog(fn):
    def mutate(src, reg, cat):
        c = json.load(open(cat))
        fn(c)
        json.dump(c, open(cat, "w"))
    return mutate


case("a consistent tree passes", None, None)
case("an item ID used twice", edit_catalog(lambda c: c.append(dict(c[1], asset="/Game/Other"))), "used twice")
case("a catalog item from the diagnostics", edit_catalog(lambda c: c.append(
    {"tid": 1, "asset": "/Game/Character/Weapons/IceAxe_A_XPTest"})), "is test content (XPTest)")
case("a missing record set", lambda s, r, c: os.remove(os.path.join(r, "ranked.bin")), "registry/ranked.bin is missing")
case("a stale record set", lambda s, r, c: shutil.copy(os.path.join(r, "ranked.bin"), os.path.join(r, "animated.bin")),
     "animated.bin is no generator's record set")
case("a sourced item without a record", edit_catalog(lambda c: c.append(
    dict(c[1], tid=900001, asset="/Game/Cosmetics/WeaponSkins/Katana_XP_New"))), "have no registry record")
case("a record without a catalog item", edit_catalog(lambda c: c.pop(1)), "aren't in the catalog")
case("a sourced item whose asset isn't in patch/src",
     lambda s, r, c: os.remove(os.path.join(s, *gate.asset_file("/Game/Cosmetics/WeaponSkins/IceAxe_XP_Frost_Plasma").split("/"))),
     "have no asset")
case("the built AssetRegistry.bin lacks a record set",
     lambda s, r, c: put(s, gate.REGISTRY_BIN, b"stock registry only"), "doesn't hold patch/registry/")
case("an animated-camo asset in patch/src",
     lambda s, r, c: put(s, "Victory/Content/Character/Weapons/AutoBow_A_XPAnim.uasset", b"x"), "is test content")
case("a FrontEnd.html missing a menu edit",
     lambda s, r, c: put(s, gate.FRONTEND, page().replace(mb.LEADERBOARD_SCRIPT, "")), "menu edits")
case("an ungenerated DefaultGame.ini", lambda s, r, c: os.remove(os.path.join(s, *gate.CONFIG.split("/"))),
     "DefaultGame.ini is missing")

if failures:
    sys.exit(1)
print("all release gate tests passed")
