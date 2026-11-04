"""Gameplay tuning for local matches: more bots, shorter matches, bots that
head for the middle. Extracts the original assets from the game's paks,
patches fixed-size values in place, and writes them under src/ so
make_pak.py ships them in the patch pak.

usage: python patch_assets.py <Paks dir>
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from build_catalog import pak_entries, read_entry  # noqa: E402
from uasset import Package, Reader  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, "src")

# asset path -> {export name -> {property: value}}
TUNING = {
    "Victory/Content/Blueprints/GameMode/VictoryGameMode.uasset": {
        # Victory.exe caps players plus bots at 16 (exe VA 0x14023218a), so solo
        # gets 15 bots whatever this asks for; 50 just means "as many as allowed".
        "Default__VictoryGameMode_C": {"BotsToSpawn": 50},
    },
    # Faster bot reactions (UNTESTED IN GAME: playtest before releasing).
    # Behavior-tree service intervals in seconds (stock in brackets).
    "Victory/Content/Blueprints/AI/Trees/MatchBot.uasset": {
        "Listen_C_0": {"Interval": 1.5, "RandomDeviation": 0.5},     # hearing check (4.0 +- 1.0)
        "FindBestTarget_C_1": {"Interval": 0.5},                      # target choice (1.0)
        "SelectAction_C_24": {"Interval": 0.3},                       # next action (0.6)
    },
    # Bot sight (UNTESTED IN GAME). Pairs with the AISense_Sight trace budget
    # in DefaultGame.ini, so the wider cone doesn't make spotting slower.
    "Victory/Content/Blueprints/AI/Base/BasicController.uasset": {
        "AISenseConfig_Sight_1": {"SightRadius": 5000.0, "LoseSightRadius": 6500.0,    # (3500, 5000)
                                  "PeripheralVisionAngleDegrees": 90.0},                # (75)
    },
    "Victory/Content/Blueprints/Environment/MatchPhaseManager_BP.uasset": {
        # Gas timeline (stock: iris at 15:00, then +5:00 map shutdown,
        # +9:00 standing room only). Now the iris starts at 5:00 and the
        # match is over by ~14.5 minutes.
        "Default__MatchPhaseManager_BP_C": {
            "StartIris": 300.0,
            "DelayForMapShutdown": 210.0,
            "DelayForSRO": 360.0,
            "Classic-DelayForEndgamePylons": 150.0,
        },
    },
    "Victory/Content/Maps/Jungle/Gameplay.umap": {
        "MatchPhaseManager_24": {"DelayForMapShutdown": 210.0},
        # Phase 1 iris closes faster (stock 240).
        "Iris_v3": {"Phase 1 Transition Scaler": 400.0},
    },
    "Victory/Content/Maps/Jungle2/Gameplay.umap": {
        "BP_GasPylon_v3_120": {"Phase 1 Transition Scaler": 300.0},
    },
}

# The names bots get in a match (VictoryGameMode's BotNames; the game draws
# from this list). The stock list has 17 names (Tony The Ninja, Mandroid 5000,
# ...); the edit keeps the asset's size, so the new list is 17 names with the
# same total length: the community's names, then stock ones that fill the
# space exactly. MatchLobby.js shows the same names in the pregame lobby.
BOT_NAMES = [
    "Dominoss", "Bigred", "Riskybixnew", "Bongzilla", "Billybobjrjr", "999Jay", "Slugling",
    "Sunsetwayboy", "HopelesslyNameless", "Arky", "ShadowRick",
    "Tony The Ninja", "Mandroid 5000", "Lord Xeinous", "Dr. Bonesaw", "Big Purp", "Frank",
]
STR_ARRAYS = {
    ("Victory/Content/Blueprints/GameMode/VictoryGameMode.uasset", "Default__VictoryGameMode_C", "BotNames"): BOT_NAMES,
}

# Behaviour tree EQS parameters: (asset, task node, param) -> value.
EQS_TUNING = {
    # "Find Wander Position": pull wandering bots toward the middle, using the
    # same weight the "Move To Center" query uses when the gas hits them.
    ("Victory/Content/Blueprints/AI/Trees/MatchBot.uasset", "BTTask_RunEQSQuery_1", "DirectnessToCenterWeight"): 1.5,
}


def find_in_paks(paks_dir, wanted):
    found = {}
    for pak in sorted(os.listdir(paks_dir)):
        if not pak.endswith(".pak"):
            continue
        for f, name, off, usize, method, blocks in pak_entries(os.path.join(paks_dir, pak)):
            rel = name.replace("../../../", "")
            if rel in wanted:
                found[rel] = read_entry(f, off, usize, method, blocks)
    missing = set(wanted) - set(found)
    if missing:
        sys.exit("not found in paks: %s" % ", ".join(sorted(missing)))
    return found


def patch_props(pkg, data, export, values):
    stored = {p[0]: (p[1], p[3]) for p in pkg.props(export)}
    for prop, value in values.items():
        if prop not in stored:
            sys.exit("%s.%s is not stored in the asset" % (export, prop))
        ptype, off = stored[prop]
        old = pkg.value(ptype, off, 4, None)
        if ptype == "IntProperty":
            struct.pack_into("<i", data, off, int(value))
        elif ptype == "FloatProperty":
            struct.pack_into("<f", data, off, float(value))
        else:
            sys.exit("can't patch %s (%s)" % (prop, ptype))
        print("  %s.%s: %s -> %s" % (export, prop, old, value))


def patch_str_array(pkg, data, export, prop, values):
    """Replace an array of strings in place. The new array must take exactly
    the bytes the old one did (count, then each string as length + ASCII +
    NUL), so nothing else in the asset moves."""
    for pname, ptype, idx, voff, size, extra, value in pkg.props(export):
        if pname == prop:
            break
    else:
        sys.exit("%s.%s is not stored in the asset" % (export, prop))
    if ptype != "ArrayProperty" or extra != "StrProperty":
        sys.exit("%s.%s is %s of %s, not an array of strings" % (export, prop, ptype, extra))
    old = Reader(bytes(data), voff)
    old_values = [old.fstr() for _ in range(old.i32())]
    new = struct.pack("<i", len(values))
    for v in values:
        b = v.encode("ascii") + b"\0"
        new += struct.pack("<i", len(b)) + b
    if len(new) != size:
        sys.exit("%s.%s: the new list takes %d bytes, the asset has room for exactly %d (%+d): adjust the names"
                 % (export, prop, len(new), size, len(new) - size))
    data[voff:voff + size] = new
    print("  %s.%s: %d names -> %s" % (export, prop, len(old_values), ", ".join(values)))


def patch_eqs_param(pkg, data, export, param, value):
    """Set Value of every FAIDynamicParam named `param` inside an export
    (both the QueryConfig array and the EQSRequest copy)."""
    e = pkg.export(export)
    name_idx = pkg.names.index(param)
    value_idx = pkg.names.index("Value")
    float_idx = pkg.names.index("FloatProperty")
    needle = struct.pack("<ii", name_idx, 0)
    tag = struct.pack("<iiii", value_idx, 0, float_idx, 0) + struct.pack("<ii", 4, 0)
    start, end, hits = e["offset"], e["offset"] + e["size"], 0
    pos = start
    while True:
        i = bytes(data).find(needle, pos, end)
        if i < 0:
            break
        j = bytes(data).find(tag, i, min(i + 400, end))
        if j >= 0:
            voff = j + len(tag) + 1          # + HasPropertyGuid byte
            old = struct.unpack_from("<f", data, voff)[0]
            struct.pack_into("<f", data, voff, float(value))
            print("  %s %s: %s -> %s (@%d)" % (export, param, old, value, voff))
            hits += 1
        pos = i + 8
    if not hits:
        sys.exit("no %s param found in %s" % (param, export))


def main(paks_dir):
    assets = set(TUNING) | {k[0] for k in EQS_TUNING} | {k[0] for k in STR_ARRAYS}
    originals = find_in_paks(paks_dir, assets)
    for rel in sorted(assets):
        data = bytearray(originals[rel])
        pkg = Package(bytes(data))
        print(rel)
        for export, values in TUNING.get(rel, {}).items():
            patch_props(pkg, data, export, values)
        for (asset, export, param), value in EQS_TUNING.items():
            if asset == rel:
                patch_eqs_param(pkg, data, export, param, value)
        for (asset, export, prop), values in STR_ARRAYS.items():
            if asset == rel:
                patch_str_array(pkg, data, export, prop, values)
        assert len(data) == len(originals[rel])
        out = os.path.join(SRC, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        open(out, "wb").write(data)


if __name__ == "__main__":
    main(sys.argv[1])
