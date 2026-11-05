"""Showdown, version 1: you against one bot in the Jungle centre arena.

The game has no Showdown logic, and none can be authored for the cooked
build, so this assembles it from what the game already has:

- Game mode: VictoryGameMode_Lightning (unused by the Remaster). The gas
  manager (MatchPhaseManager_BP) runs its own faster "Lightning" iris for it,
  it spawns no world loot, and it picks the PlayerStarts tagged
  SpawnsLightning. Its defaults get one bot (BotsToSpawn) and the bots' names.
- Kit: every contestant spawns with it in their inventory, nothing on the
  ground. The game's own starting items: perks add to the player stat
  SpawnWithWeapon, and PlayerPawn's GetSpawnWithWeaponClasses gives one item
  per bit (1 Man Tracker, 2 Backpack, 4 Satchel, 8 Body Armor, 16 Alarm Gun,
  32 a random Tier 1 melee weapon). No selectable perk uses bit 4 or 32 (only
  the removed, disabled Perk_JumpStart had 32), so bit 4 becomes BOOST and
  bit 32 always MELEE. A Showdown-only perk (a copy of Perk_JumpStart at a
  new path, so it isn't in the asset registry or the perk menu) grants
  32 + 8 + 4, and the mode forces it on everyone (OverridenPerks, in place of
  Backpacker), bots included (bEnableBotPerks). Body armor a player spawns with puts itself on
  (bUseIfSpawnedWith); the rest waits in the inventory. The mode's airdrops
  are switched off. server/data/showdown.json lists the kit for the server
  and the HUD's pre-round panel.
- Spawns: Jungle_P's eight SpawnsLightning starts sit ~20,000 units out. Two
  move into the arena, on opposite sides facing the middle; the other six are
  retagged so they're never picked.
- Messages: the Lightning branch of the gas manager shows "Open Your
  Airdrop" at match start and Jungle's level script a "Grab your Airdrop."
  help toast; with no airdrop they mislead, so they say what to do instead
  (same length: they are string constants in compiled script).
- Start: the server answers "showdown:1v1" and ClientWeb.js calls the
  menu's StartTraining(URL): the patched exe opens a URL given in place of a
  slot name like a Solo match (patch_exe.py). No DefaultGame.ini slot is
  used, so the SURVIVAL screen's Training Range keeps its stock Practice map.

usage: python make_showdown.py <Paks dir>
"""
import json
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
PAWN = "Victory/Content/Blueprints/Pawns/PlayerPawn.uasset"
SOURCE_PERK = "Victory/Content/Perks/Removed/Perk_JumpStart.uasset"
PERK = "Victory/Content/Perks/Showdown/Perk_Showdown.uasset"
PERK_OBJECT = "Perk_JumpStart"          # the copy keeps its export's name
# The kit both sides spawn with: (item class, its package, the bit that gives it).
MELEE = ("WeapTomahawk_C", "/Game/Blueprints/Weapons/WeapTomahawk", 32)
BOOST = ("MuscleManMilk_C", "/Game/Blueprints/Items/MuscleManMilk", 4)
ARMOR = ("BodyArmor_C", "/Game/Blueprints/Items/BodyArmor", 8)        # stock bit
KIT = [MELEE, ARMOR, BOOST]
KIT_NAME = "Showdown kit"
# What bits 4 and 32 give in the stock game (replaced in GetSpawnWithWeaponClasses).
STOCK_BIT4 = ["Satchel_C"]
STOCK_BIT32 = ["WeapTonfa_C", "WeapHammer_C", "WeapPitchfork_C", "WeapCampHatchet_C",
               "WeapBrassKnuckles_C", "WeapMachete_C", "WeapTantoKnife_C"]
LOOT = os.path.join(HERE, "loot", "loot_tables.json")
SERVER_KIT = os.path.join(HERE, "..", "server", "data", "showdown.json")
NEVER = 1000000                         # airdrop stage times past any round
# Arena spawns (the centre ring is at the origin, about 2,500 across; its
# floor is near z = 0): opposite sides, a little above the floor, facing in.
# (location, yaw)
ARENA_STARTS = {
    "Spawns_Lightning01": ((-1800.0, 0.0, 200.0), 0.0),
    "Spawns_Lightning05": ((1800.0, 0.0, 200.0), 180.0),
}
UNUSED_TAG = "SpawnsShowdownUnused"
PHASES = "Victory/Content/Blueprints/Environment/MatchPhaseManager_BP.uasset"
# (old, new): same length, each the whole of a script string constant.
TEXTS = {
    PHASES: [("Open Your Airdrop", "Drink Up & Fight!")],      # Lightning branch only
    JUNGLE: [("Grab your Airdrop.", "Ready up and fight")],    # help toast
}


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


def bool_prop(up, name, v):
    # A BoolProperty keeps its value in the tag (size 0).
    return up.fname(name) + up.fname("BoolProperty") + struct.pack("<ii", 0, 0) + bytes([1 if v else 0]) + b"\0"


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
    for name in ("BotsToSpawn", "BotNames", "bEnableBotPerks"):
        assert not has_prop(data, None, export, name), "%s already set" % name
    up = UPackage(data)
    # bEnableBotPerks: bots get the mode's perks too, so the bot spawns with
    # the same kit (without it the bot has no perks and no kit).
    add_props(up, export, [int_prop(up, "BotsToSpawn", BOTS), str_array_prop(up, "BotNames", BOT_NAMES),
                           bool_prop(up, "bEnableBotPerks", True)])
    no_airdrops(up, export)
    force_perk(up, export)
    out = up.save()
    got = {x[0]: x[6] for x in Package(out).props(export)}
    assert got["BotsToSpawn"] == BOTS and got["bEnableBotPerks"] == 1, got
    return out


def import_index(up, name):
    for i, raw in enumerate(up.imports):
        if up.name_str(*struct.unpack_from("<ii", raw, 20)) == name:
            return -(i + 1)
    raise KeyError(name)


def value_offsets(up, export):
    """Each property's value offset and size within the export's data."""
    tmp = Package(up.save())
    e = tmp.export(export)
    return {x[0]: (x[3] - e["offset"], x[4]) for x in tmp.props(export)}


def force_perk(up, export):
    """OverridenPerks: the Showdown perk in place of Backpacker (a backpack the
    kit doesn't need; its bit 2 would add one)."""
    backpacker = import_index(up, "Perk_Backpacker")
    package = up.add_import("/Script/CoreUObject", "Package", 0, "/Game/" + PERK[len("Victory/Content/"):-len(".uasset")])
    perk = up.add_import("/Script/Victory", "PerkDataAsset", package, PERK_OBJECT)
    i = up.find_export(export) - 1
    data = bytearray(up.exports[i]["data"])
    off, size = value_offsets(up, export)["OverridenPerks"]
    hits = [p for p in range(off + 4, off + size, 4) if struct.unpack_from("<i", data, p)[0] == backpacker]
    assert len(hits) == 1, hits
    struct.pack_into("<i", data, hits[0], perk)
    up.exports[i]["data"] = bytes(data)


def no_airdrops(up, export):
    """Every airdrop stage (each MinRoundTime, an IntProperty tag inside the
    AirDropStages struct array) after the end of any round: no kit crates."""
    i = up.find_export(export) - 1
    data = bytearray(up.exports[i]["data"])
    off, size = value_offsets(up, export)["AirDropStages"]
    min_time, int_prop_name = up.name_index("MinRoundTime", add=False), up.name_index("IntProperty", add=False)
    times = [p + 25 for p in range(off, off + size - 25)        # name 8, type 8, size 4, index 4, guid 1
             if struct.unpack_from("<iiii", data, p) == (min_time, 0, int_prop_name, 0)]
    assert len(times) == 4, times
    for p in times:
        struct.pack_into("<i", data, p, NEVER)
    up.exports[i]["data"] = bytes(data)


def pawn(data):
    """GetSpawnWithWeaponClasses: bit 4 gives BOOST, bit 32 always MELEE."""
    up = UPackage(data)
    swaps = {}
    for item, package, _bit in (MELEE, BOOST):
        pkg = up.add_import("/Script/CoreUObject", "Package", 0, package)
        cls = up.add_import("/Script/Engine", "BlueprintGeneratedClass", pkg, item)
        for stock in (STOCK_BIT32 if item == MELEE[0] else STOCK_BIT4):
            swaps[import_index(up, stock)] = cls
    i = up.find_export("GetSpawnWithWeaponClasses") - 1
    body = bytearray(up.exports[i]["data"])
    count = {}
    for p in range(len(body) - 4):
        v = struct.unpack_from("<i", body, p)[0]
        # EX_ObjectConst (0x20) then the class reference
        if body[p - 1] == 0x20 and v in swaps:
            struct.pack_into("<i", body, p, swaps[v])
            count[v] = count.get(v, 0) + 1
    assert sorted(count) == sorted(swaps) and set(count.values()) == {1}, count
    up.exports[i]["data"] = bytes(body)
    return up.save()


def perk(data):
    """The Showdown perk: Perk_JumpStart's asset, enabled, granting the kit's
    bits."""
    pkg = Package(data)
    out = bytearray(data)
    bits = float(sum(b for _i, _p, b in KIT))
    found = 0
    for x in pkg.props(PERK_OBJECT):
        if x[0] == "bEnabled":
            # BoolProperty keeps its value in the tag, the byte before the GUID flag.
            assert out[x[3] - 2] == 0
            out[x[3] - 2] = 1
            found += 1
    # PerkBonuses[0].StatValue: its FloatProperty tag, then the value.
    tag = struct.pack("<iiii", pkg.names.index("StatValue"), 0, pkg.names.index("FloatProperty"), 0)
    e = pkg.export(PERK_OBJECT)
    stats = [p + 25 for p in range(e["offset"], e["offset"] + e["size"] - 25) if data[p:p + 16] == tag]
    assert len(stats) == 1 and struct.unpack_from("<f", data, stats[0])[0] == 32.0, stats
    struct.pack_into("<f", out, stats[0], bits)
    assert found == 1
    return bytes(out)


def retext(rel, data):
    """Replace whole script string constants (EX_StringConst 0x1F, text, NUL)
    in place; already replaced is fine."""
    out = bytearray(data)
    for old, new in TEXTS.get(rel, []):
        assert len(old) == len(new), (old, new)
        o, n = b"\x1f" + old.encode() + b"\x00", b"\x1f" + new.encode() + b"\x00"
        found = out.count(o)
        assert found or out.count(n), "%s: %r not found" % (rel, old)
        out = bytearray(bytes(out).replace(o, n))
    return bytes(out)


def server_kit():
    """The kit's contents for the server and the HUD, from the loot tables."""
    loot = json.load(open(LOOT))
    items = []
    for item, _package, _bit in KIT:
        info = loot["items"][item]
        items.append({"id": item, "name": info["name"], "category": info["category"], "tier": info["tier"],
                      "description": info["description"], "icon": item[:-2] if item.endswith("_C") else item,
                      "autoEquip": info["category"] == "armor", "inInventory": True})
    out = {"source": "patch/make_showdown.py", "kit": {"id": "showdown", "name": KIT_NAME, "items": items}}
    with open(SERVER_KIT, "w", newline="\n") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
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
    originals = find_in_paks(paks_dir, {GAME_MODE, JUNGLE, PAWN, SOURCE_PERK})
    originals[PERK] = originals.pop(SOURCE_PERK)
    for rel, fix in ((GAME_MODE, game_mode), (JUNGLE, jungle), (PAWN, pawn), (PERK, perk)):
        data = retext(rel, fix(originals[rel]))
        out = os.path.join(SRC, rel)
        os.makedirs(os.path.dirname(out), exist_ok=True)
        open(out, "wb").write(data)
        print("showdown:", rel)
    # The gas manager is tuned by patch_assets.py first: edit its copy.
    tuned = os.path.join(SRC, PHASES)
    if not os.path.exists(tuned):
        sys.exit("run patch_assets.py first (it writes %s)" % PHASES)
    data = open(tuned, "rb").read()
    open(tuned, "wb").write(retext(PHASES, data))
    print("showdown:", PHASES)
    kit = server_kit()["kit"]
    print("showdown kit: %s (%s)" % (kit["name"], ", ".join(i["name"] for i in kit["items"])))


if __name__ == "__main__":
    main(sys.argv[1])
