"""Showdown, version 1: you against one bot in the Jungle centre arena.

The game has no Showdown logic, and none can be authored for the cooked
build, so this assembles it from what the game already has:

- Game mode: VictoryGameMode_Lightning (unused by the Remaster). The gas
  manager (MatchPhaseManager_BP) runs its own faster "Lightning" iris for it,
  it spawns no world loot, and it picks the PlayerStarts tagged
  SpawnsLightning. Its defaults get one bot (BotsToSpawn) and the bots' names.
- Spawns: Jungle_P's eight SpawnsLightning starts sit ~20,000 units out. Two
  move into the arena, on opposite sides facing the middle; the other six are
  retagged so they're never picked.
- Start: the menu's StartTraining("Practice") travels to the URL in
  DefaultGame.ini's TrainingMapAdvanced (make_loading_bar.py writes it); the
  stock Practice map isn't reachable from the Remaster menu.

usage: python make_showdown.py <Paks dir>
"""
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from level_survey import export_props  # noqa: E402
from patch_assets import BOT_NAMES, find_in_paks  # noqa: E402
from uasset import Package  # noqa: E402
from ue_package import UPackage  # noqa: E402

SRC = os.path.join(HERE, "src")
GAME_MODE = "Victory/Content/Blueprints/GameMode/VictoryGameMode_Lightning.uasset"
JUNGLE = "Victory/Content/Maps/Jungle/Jungle_P.umap"
URL = "Jungle_P?bEnableBots=true?game=/Game/Blueprints/GameMode/VictoryGameMode_Lightning.VictoryGameMode_Lightning_C"

BOTS = 1
# Arena spawns (the centre ring is at the origin, about 2,500 across; its
# floor is near z = 0): opposite sides, a little above the floor, facing in.
# (location, yaw)
ARENA_STARTS = {
    "Spawns_Lightning01": ((-1800.0, 0.0, 200.0), 0.0),
    "Spawns_Lightning05": ((1800.0, 0.0, 200.0), 180.0),
}
UNUSED_TAG = "SpawnsShowdownUnused"


# ---------------------------------------------------------------- tagged properties

def props_end(up, data):
    """Offset of the "None" that ends an export's tagged properties."""
    p = 0
    while True:
        idx = struct.unpack_from("<i", data, p)[0]
        if up.names[idx][0] == "None":
            return p
        ptype = up.names[struct.unpack_from("<i", data, p + 8)[0]][0]
        size = struct.unpack_from("<i", data, p + 16)[0]
        p += 24
        if ptype == "StructProperty":
            p += 8 + 16
        elif ptype == "BoolProperty":
            p += 1
        elif ptype in ("ByteProperty", "EnumProperty", "ArrayProperty", "SetProperty"):
            p += 8
        elif ptype == "MapProperty":
            p += 16
        has_guid = data[p]
        p += 1 + (16 if has_guid else 0)
        p += size


def tag(up, name, ptype, value, extra=b""):
    return up.fname(name) + up.fname(ptype) + struct.pack("<ii", len(value), 0) + extra + b"\0" + value


def int_prop(up, name, v):
    return tag(up, name, "IntProperty", struct.pack("<i", v))


def str_array_prop(up, name, values):
    body = struct.pack("<i", len(values))
    for v in values:
        b = v.encode("ascii") + b"\0"
        body += struct.pack("<i", len(b)) + b
    return tag(up, name, "ArrayProperty", body, up.fname("StrProperty"))


def add_props(up, export, new_props):
    """Append tagged properties to an export (each must not be there already)."""
    i = up.find_export(export) - 1
    data = up.exports[i]["data"]
    end = props_end(up, data)
    up.exports[i]["data"] = data[:end] + b"".join(new_props) + data[end:]


def has_prop(data, pkg, export, name):
    return any(x[0] == name for x in Package(data).props(export))


# ---------------------------------------------------------------- the assets

def game_mode(data):
    export = "Default__VictoryGameMode_Lightning_C"
    for name in ("BotsToSpawn", "BotNames"):
        assert not has_prop(data, None, export, name), "%s already set" % name
    up = UPackage(data)
    add_props(up, export, [int_prop(up, "BotsToSpawn", BOTS), str_array_prop(up, "BotNames", BOT_NAMES)])
    out = up.save()
    got = {x[0]: x[6] for x in Package(out).props(export)}
    assert got["BotsToSpawn"] == BOTS, got
    return out


def jungle(data):
    """Two SpawnsLightning starts into the arena; the others never picked."""
    up = UPackage(data)
    unused = up.name_index(UNUSED_TAG)
    lightning = up.name_index("SpawnsLightning", add=False)
    pkg = Package(data)
    body = bytearray(data)
    moved = []
    for i, e in enumerate(pkg.exports, 1):
        if pkg.ref(e["class"]) != "PlayerStart" or not e["name"].startswith("Spawns_Lightning"):
            continue
        props = export_props(pkg, i)
        if e["name"] in ARENA_STARTS:
            loc, yaw = ARENA_STARTS[e["name"]]
            root = struct.unpack_from("<i", body, props["RootComponent"][1])[0]
            cp = export_props(pkg, root)
            struct.pack_into("<3f", body, cp["RelativeLocation"][1], *loc)
            struct.pack_into("<3f", body, cp["RelativeRotation"][1], 0.0, yaw, 0.0)
            moved.append(e["name"])
        else:
            off = props["Tags"][1]
            # Tags: count, then FNames (index, number).
            assert struct.unpack_from("<iii", body, off) == (1, lightning, 0), e["name"] + ": expected one tag"
            struct.pack_into("<i", body, off + 4, unused)
    assert sorted(moved) == sorted(ARENA_STARTS), moved
    # The in-place edits, then the new name through the rewriter.
    up2 = UPackage(bytes(body))
    up2.name_index(UNUSED_TAG)
    return up2.save()


def main(paks_dir):
    originals = find_in_paks(paks_dir, {GAME_MODE, JUNGLE})
    for rel, fix in ((GAME_MODE, game_mode), (JUNGLE, jungle)):
        data = fix(originals[rel])
        out = os.path.join(SRC, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        open(out, "wb").write(data)
        print("showdown:", rel)


if __name__ == "__main__":
    main(sys.argv[1])
