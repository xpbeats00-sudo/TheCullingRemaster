"""make_showdown.py's packages, from the stock paks (read only), and the arena's
spots:

- Jungle_P: the eight SpawnsLightning PlayerStarts are in the arena at
  ARENA_STARTS (four north, four south, facing the middle), still tagged
  SpawnsLightning; nothing else changes (same size, names, imports, exports;
  the only changed bytes are those starts' RelativeLocation/RelativeRotation
  values); re-saved by the package writer it is byte for byte the same; doing
  it twice changes nothing.
- The game mode, pawn and perk packages: they parse, re-save unchanged, and
  their new imports resolve (the perk import's outer is its package import).
- check_spots: every start and every side's spot (1v1 to 4v4) is on the stock
  navmesh's arena floor (Navigation.umap), and none is within three capsule
  radii of another; points off the map have no navmesh.
- The spots agree with the native module's (showdown_rounds.c SD_SIDE_X,
  SD_SPACING, SD_SLOT_Z, SD_MAX_SIDE), and 1v1's are version 1's two starts.

usage: python test_make_showdown.py [Paks dir]
"""
import os
import re
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_showdown as MS  # noqa: E402
from level_survey import export_props  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from uasset import Package  # noqa: E402
from ue_package import UPackage  # noqa: E402

STOCK_PAKS = r"C:\Culling\TheCulling\Victory\Content\Paks"
passed = 0


def ok(msg):
    global passed
    passed += 1
    print("ok   " + msg)


def check(cond, msg):
    if not cond:
        print("FAIL " + msg)
        sys.exit(1)


def starts(data):
    """{name: (location, rotation, tags, (location offset, rotation offset))} of every PlayerStart."""
    pkg = Package(data)
    out = {}
    for i, e in enumerate(pkg.exports, 1):
        if pkg.ref(e["class"]) != "PlayerStart":
            continue
        props = export_props(pkg, i)
        root = struct.unpack_from("<i", data, props["RootComponent"][1])[0]
        cp = export_props(pkg, root)
        off = props["Tags"][1]
        tags = [pkg.names[struct.unpack_from("<i", data, off + 4 + 8 * k)[0]] for k in range(struct.unpack_from("<i", data, off)[0])]
        out[e["name"]] = (struct.unpack_from("<3f", data, cp["RelativeLocation"][1]),
                          struct.unpack_from("<3f", data, cp["RelativeRotation"][1]), tags,
                          (cp["RelativeLocation"][1], cp["RelativeRotation"][1]))
    return out


def same_structure(a, b, what):
    pa, pb = UPackage(a), UPackage(b)
    check(pa.names == pb.names and pa.imports == pb.imports and len(pa.exports) == len(pb.exports),
          what + ": names, imports and exports unchanged")


def resaves(data, what):
    check(UPackage(data).save() == data, what + ": re-saved by the package writer, byte for byte the same")


def test_jungle(stock):
    out = MS.jungle(stock)
    check(len(out) == len(stock), "Jungle_P: same size")
    same_structure(stock, out, "Jungle_P")
    resaves(stock, "Jungle_P (stock)")
    resaves(out, "Jungle_P")
    check(MS.jungle(out) == out, "Jungle_P: a second pass changes nothing")
    before, after = starts(stock), starts(out)
    check(sorted(before) == sorted(after), "Jungle_P: the same PlayerStarts")
    lightning = sorted(n for n in after if n.startswith("Spawns_Lightning"))
    check(lightning == sorted(MS.ARENA_STARTS) and len(lightning) == 8, "Jungle_P: eight Lightning starts")
    allowed = set()
    for name, (loc, rot, tags, offs) in after.items():
        if name in MS.ARENA_STARTS:
            want_loc, yaw = MS.ARENA_STARTS[name]
            check(loc == want_loc and rot == (0.0, yaw, 0.0), "%s at %s facing %g" % (name, want_loc, yaw))
            check(tags == ["SpawnsLightning"], name + " still tagged SpawnsLightning")
            check(abs(loc[0]) < 2000 and abs(loc[1]) < 2000, name + " is in the arena")
            allowed.update(range(offs[0], offs[0] + 12))
            allowed.update(range(offs[1], offs[1] + 12))
        else:
            check(after[name][:3] == before[name][:3], name + " unchanged")
    diff = [i for i in range(len(out)) if out[i] != stock[i]]
    check(diff and set(diff) <= allowed, "Jungle_P: only the eight starts' location and rotation bytes change (%d)" % len(diff))
    yaws = {round(MS.ARENA_STARTS[n][1]) for n in lightning}
    check(all((y > 0) == (MS.ARENA_STARTS[n][1] < 0) for n in lightning for y in [MS.ARENA_STARTS[n][0][1]]),
          "the north starts face south and the south ones north (into the arena)")
    ok("Jungle_P: eight SpawnsLightning starts in the arena (yaws %s), nothing else changed, re-saves, idempotent"
       % sorted(yaws))


def test_other_packages(originals):
    for rel, fix in ((MS.GAME_MODE, MS.game_mode), (MS.PAWN, MS.pawn), (MS.PERK, MS.perk)):
        out = MS.retext(rel, fix(originals[rel]))
        pkg = Package(out)
        resaves(out, rel)
        check(len(pkg.exports) == len(Package(originals[rel]).exports), rel + ": same exports")
        up = UPackage(out)
        for i, raw in enumerate(up.imports):
            outer = struct.unpack_from("<i", raw, 16)[0]
            check(outer <= 0 and -outer <= len(up.imports), "%s: import %d's outer is an import" % (rel, i + 1))
        ok("%s: parses, re-saves unchanged, %d imports resolve" % (rel, len(up.imports)))
    up = UPackage(MS.game_mode(originals[MS.GAME_MODE]))
    perk = MS.import_index(up, MS.PERK_OBJECT)
    outer = struct.unpack_from("<i", up.imports[-perk - 1], 16)[0]
    pkg_name = up.name_str(*struct.unpack_from("<ii", up.imports[-outer - 1], 20))
    check(pkg_name == "/Game/Perks/Showdown/Perk_Showdown", "the Showdown perk's import is in its package (%s)" % pkg_name)
    ok("game mode: the Showdown perk import's outer is /Game/Perks/Showdown/Perk_Showdown")


def test_spots(nav):
    floors = MS.check_spots(nav)
    check(len(floors) == 8 + 2 * 7, "every start and spot checked (%d)" % len(floors))
    check(all(5.0 < h < 60.0 for h in floors.values()), "the floor under them is the arena's (z %s)"
          % sorted({round(h) for h in floors.values()}))
    tiles = MS.navmesh_tiles(nav)
    check(MS.navmesh_heights(tiles, 200000.0, 200000.0) == [], "no navmesh off the map")
    check(MS.navmesh_heights(tiles, 0.0, 0.0), "navmesh at the arena's centre")
    saved = MS.SIDE_X
    try:
        MS.SIDE_X = 60.0                       # both sides on top of each other in the middle
        failed = False
        try:
            MS.check_spots(nav)
        except AssertionError:
            failed = True
        check(failed, "check_spots refuses spots too close together")
    finally:
        MS.SIDE_X = saved
    ok("arena: %d starts and spots on the navmesh floor (z %.0f-%.0f), 3 capsule radii apart; off the map: none"
       % (len(floors), min(floors.values()), max(floors.values())))


def test_native_agrees():
    src = open(os.path.join(HERE, "showdown_rounds.c"), encoding="utf-8").read()

    def f(name):
        return float(re.search(r"#define %s\s+([0-9.]+)f" % name, src).group(1))
    check(f("SD_SIDE_X") == MS.SIDE_X and f("SD_SPACING") == MS.SPACING and f("SD_SLOT_Z") == MS.SPOT_Z,
          "the module's spots are make_showdown's")
    check(int(re.search(r"#define SD_MAX_SIDE\s+(\d+)", src).group(1)) == MS.MAX_SIDE == len(MS.ARENA_STARTS) // 2,
          "4 a side: the module's limit, the starts' count")
    check(MS.side_spots(1) == [[(-1800.0, 0.0, 200.0)], [(1800.0, 0.0, 200.0)]], "1v1: version 1's two starts")
    check(MS.side_spots(4)[0] == [(-1800.0, y, 200.0) for y in (-240.0, -80.0, 80.0, 240.0)], "4v4: 160 apart")
    ok("the native module's spots (SD_SIDE_X, SD_SPACING, SD_SLOT_Z, SD_MAX_SIDE) are make_showdown's")


def main():
    paks = sys.argv[1] if len(sys.argv) > 1 else os.environ.get("CULLING_PAKS") or STOCK_PAKS
    test_native_agrees()
    if not os.path.isdir(paks):
        print("skip packages (no %s)" % paks)
    else:
        originals = find_in_paks(paks, {MS.GAME_MODE, MS.JUNGLE, MS.PAWN, MS.SOURCE_PERK, MS.NAVIGATION})
        originals[MS.PERK] = originals.pop(MS.SOURCE_PERK)
        test_jungle(originals[MS.JUNGLE])
        test_other_packages(originals)
        test_spots(originals[MS.NAVIGATION])
    print("%d checks passed" % passed)


if __name__ == "__main__":
    main()
