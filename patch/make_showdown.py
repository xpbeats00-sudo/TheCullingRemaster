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
  32 a random Tier 1 melee weapon: RandomIntegerInRange(0, 6) picks one of
  seven). No selectable perk uses bit 4 or 32 (only the removed, disabled
  Perk_JumpStart had 32), so bit 4 becomes BOOST and the seven bit-32
  weapons become the seven Tier 3 weapons of ROTATION. In a Showdown match
  the patched exe (patch_exe.py, showdown_rounds.c) makes that one
  RandomIntegerInRange(0, 6) return the round's kit, the same for both
  fighters: the kit changes every 2 rounds, from a random first kit.
  The rival's pawn (BasicBot) has no GetSpawnWithWeaponClasses and spawns
  with its own random loadout; the patched exe clears it and gives the rival
  the player's kit (the same armor, put on, the boost and the round's weapon)
  at the start and after every round's reset. A Showdown-only perk (a copy of Perk_JumpStart at a
  new path, so it isn't in the asset registry or the perk menu) grants
  32 + 8 + 4, and the mode forces it on everyone (OverridenPerks, in place of
  Backpacker), bots included (bEnableBotPerks). Body armor a player spawns with puts itself on
  (bUseIfSpawnedWith); the rest waits in the inventory. The mode's airdrops
  are switched off. server/data/showdown.json lists the kit for the server
  and the HUD's pre-round panel.
- Spawns: Jungle_P's eight SpawnsLightning starts sit ~20,000 units out. All
  eight move into the arena: four on its north approach and four on its south
  one, facing the middle, 160 apart - one start for each fighter of a 4v4, so
  nobody ever spawns on top of anyone. The sides are the patched exe's: at the
  series' start and after every reset it teleports each fighter to its side's
  spot (showdown_rounds.c place(): you or team 1 west, the rival or team 2
  east, a team side by side), so whichever start the game picked doesn't
  matter, and no start is on any side's spot (a teleport never lands on a
  fighter still standing at a start). 1v1's spots are version 1's two starts.
  check_spots() proves every start and spot is on the stock navmesh (the
  arena floor) and clear of the others.
- Messages: the Lightning branch of the gas manager shows "Open Your
  Airdrop" at match start; with no airdrop it misleads, so it says what to do
  instead (same length: a string constant in compiled script). Jungle's level
  script also toasts "Grab your Airdrop." - in every mode on Jungle, so it
  stays stock; the Showdown HUD's panel says what to do.
- Rounds: the whole series (first to 4) is one match: the patched exe ends a
  round when a fighter is down, blacks the screen out, respawns both at the
  arena starts with the next kit and tells the HUD (ShowdownHud.js).
- Start: the server answers "showdown:1v1" (team Showdown "showdown:<n>",
  TEAM_URLS) and ClientWeb.js calls the menu's StartTraining(URL): the patched exe opens a URL given in place of a
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
# Team Showdown (2v2-4v4): the same URL with the team size (showdown_rounds.c
# reads ?TeamSize=; ClientWeb.js RemasterShowdownURL builds these from the
# server's "showdown:<n>").
TEAM_URLS = {n: URL + "?TeamSize=%d" % n for n in (2, 3, 4)}

BOTS = 1
PAWN = "Victory/Content/Blueprints/Pawns/PlayerPawn.uasset"
SOURCE_PERK = "Victory/Content/Perks/Removed/Perk_JumpStart.uasset"
PERK = "Victory/Content/Perks/Showdown/Perk_Showdown.uasset"
PERK_OBJECT = "Perk_JumpStart"          # the copy keeps its export's name
# The kit both sides spawn with: (item class, its package, the bit that gives it).
WEAPONS = "/Game/Blueprints/Weapons/"
MELEE = ("WeapTomahawk_C", WEAPONS + "WeapTomahawk", 32)     # kit 0's weapon
BOOST = ("MuscleManMilk_C", "/Game/Blueprints/Items/MuscleManMilk", 4)
ARMOR = ("BodyArmor_C", "/Game/Blueprints/Items/BodyArmor", 8)        # stock bit
KIT = [MELEE, ARMOR, BOOST]
KIT_NAME = "Showdown kit"
# Bit 32's weapon by kit (0-6: RandomIntegerInRange(0, 6), which the patched
# exe sets to the round's kit): the loot tables' Tier 3 melee weapons.
ROTATION = ["WeapTomahawk_C", "WeapSurvivalAxe_C", "WeapTacticalMachete_C", "WeapBowieKnife_C",
            "WeapBaseballBat_C", "WeapPipeWrench_C", "WeapYari_C"]
ROUNDS_PER_KIT = 2                      # showdown_rounds.c kit_for()
# What bits 4 and 32 give in the stock game (replaced in GetSpawnWithWeaponClasses).
STOCK_BIT4 = ["Satchel_C"]
# Bit 32's switch on RandomIntegerInRange(0, 6): the class each value adds.
STOCK_BIT32 = ["WeapBrassKnuckles_C", "WeapCampHatchet_C", "WeapPitchfork_C", "WeapHammer_C",
               "WeapTonfa_C", "WeapMachete_C", "WeapTantoKnife_C"]
LOOT = os.path.join(HERE, "loot", "loot_tables.json")
SERVER_KIT = os.path.join(HERE, "..", "server", "data", "showdown.json")
NEVER = 1000000                         # airdrop stage times past any round
# Arena spawns (the centre ring is at the origin; its floor, the Center_Ring_Inner
# mesh, runs out to ~1,900 at z 6-57, the navmesh there at z 15-24): the eight
# SpawnsLightning starts, four north and four south of the middle, a little
# above the floor, facing in. (location, yaw)
START_XS = (-240.0, -80.0, 80.0, 240.0)
START_Y = 1800.0
START_Z = 200.0
ARENA_STARTS = dict(
    [("Spawns_Lightning%02d" % (k + 1), ((x, START_Y, START_Z), -90.0)) for k, x in enumerate(START_XS)]
    + [("Spawns_Lightning%02d" % (k + 5), ((x, -START_Y, START_Z), 90.0)) for k, x in enumerate(START_XS)])
# The sides' spots (showdown_rounds.c sd_spot: SD_SIDE_X, SD_SPACING, SD_SLOT_Z;
# test_make_showdown.py checks they agree): side 0 west, side 1 east.
SIDE_X = 1800.0
SPACING = 160.0
SPOT_Z = 200.0
MAX_SIDE = 4
NAVIGATION = "Victory/Content/Maps/Jungle/Navigation.umap"
CAPSULE = 50.0                          # the player's capsule radius (make_tree_collision.py)


def side_spots(n):
    """The n spots of each side: [west, east], each a list of (x, y, z)."""
    ys = [(k - 0.5 * (n - 1)) * SPACING for k in range(n)]
    return [[(-SIDE_X, y, SPOT_Z) for y in ys], [(SIDE_X, y, SPOT_Z) for y in ys]]
PHASES = "Victory/Content/Blueprints/Environment/MatchPhaseManager_BP.uasset"
# (old, new): same length, each the whole of a script string constant.
TEXTS = {
    PHASES: [("Open Your Airdrop", "Drink Up & Fight!")],      # Lightning branch only
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
    """GetSpawnWithWeaponClasses: bit 4 gives BOOST, bit 32 ROTATION[kit]."""
    up = UPackage(data)
    swaps = {}
    pairs = [(BOOST[0], BOOST[1], stock) for stock in STOCK_BIT4]
    pairs += [(item, WEAPONS + item[:-2], stock) for item, stock in zip(ROTATION, STOCK_BIT32)]
    for item, package, stock in pairs:
        pkg = up.add_import("/Script/CoreUObject", "Package", 0, package)
        cls = up.add_import("/Script/Engine", "BlueprintGeneratedClass", pkg, item)
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
    """The kits' contents for the server and the HUD, from the loot tables:
    kit k is ROTATION[k] with the armor and the boost."""
    loot = json.load(open(LOOT))

    def entry(item):
        info = loot["items"][item]
        return {"id": item, "name": info["name"], "category": info["category"], "tier": info["tier"],
                "description": info["description"], "icon": item[:-2] if item.endswith("_C") else item,
                "autoEquip": info["category"] == "armor", "inInventory": True}

    kits = []
    for k, weapon in enumerate(ROTATION):
        items = [entry(weapon)] + [entry(item) for item, _package, _bit in KIT if item != MELEE[0]]
        kits.append({"id": "showdown-%d" % k, "name": "%s kit" % loot["items"][weapon]["name"], "items": items})
    out = {"source": "patch/make_showdown.py", "kit": dict(kits[0], id="showdown", name=KIT_NAME),
           "kits": kits, "roundsPerKit": ROUNDS_PER_KIT}
    with open(SERVER_KIT, "w", newline="\n") as f:
        json.dump(out, f, indent=1)
        f.write("\n")
    return out


def jungle(data):
    """All eight SpawnsLightning starts into the arena (ARENA_STARTS), in place:
    each start's root component's RelativeLocation and RelativeRotation (the
    same sizes: no new names, imports or exports). Each keeps its one tag,
    SpawnsLightning."""
    pkg = Package(data)
    lightning = pkg.names.index("SpawnsLightning")
    body = bytearray(data)
    moved = []
    for i, e in enumerate(pkg.exports, 1):
        if pkg.ref(e["class"]) != "PlayerStart" or not e["name"].startswith("Spawns_Lightning"):
            continue
        props = export_props(pkg, i)
        # Tags: count, then FNames (index, number).
        assert struct.unpack_from("<iii", body, props["Tags"][1]) == (1, lightning, 0), e["name"] + ": expected one tag"
        loc, yaw = ARENA_STARTS[e["name"]]
        root = struct.unpack_from("<i", body, props["RootComponent"][1])[0]
        cp = export_props(pkg, root)
        struct.pack_into("<3f", body, cp["RelativeLocation"][1], *loc)
        struct.pack_into("<3f", body, cp["RelativeRotation"][1], 0.0, yaw, 0.0)
        moved.append(e["name"])
    assert sorted(moved) == sorted(ARENA_STARTS), moved
    return bytes(body)


# ---------------------------------------------------------------- the navmesh

def navmesh_tiles(data):
    """The Recast tiles serialized in a cooked level (ARecastNavMesh's tiles:
    UE's dtMeshHeader, 116 bytes - magic 'DNAV', version 7, x, y, layer, user,
    polyCount, vertCount, ..., bmin and bmax at +72 and +84 - then vertCount
    float3 vertices, then the polys, 32 bytes each: firstLink, verts[6],
    neis[6], flags, vertCount, area). [(bmin, bmax, [polygon vertices])], in
    Recast space ((-x, z, -y) of Unreal's)."""
    tiles = []
    magic = struct.pack("<I", 0x444E4156)
    p = data.find(magic)
    while p >= 0:
        h = struct.unpack_from("<15i", data, p)
        polys, verts = h[6], h[7]
        if h[1] == 7 and 0 <= polys < 5000 and 0 < verts < 20000 and p + 116 + 12 * verts + 32 * polys <= len(data):
            vs = [struct.unpack_from("<3f", data, p + 116 + 12 * i) for i in range(verts)]
            out, base = [], p + 116 + 12 * verts
            for i in range(polys):
                f = struct.unpack_from("<I6H6HHBB", data, base + 32 * i)
                n = f[14]
                if not 3 <= n <= 6 or any(v >= verts for v in f[1:1 + n]):
                    out = None
                    break
                out.append([vs[v] for v in f[1:1 + n]])
            if out is not None:
                tiles.append((struct.unpack_from("<3f", data, p + 72), struct.unpack_from("<3f", data, p + 84), out))
        p = data.find(magic, p + 4)
    return tiles


def navmesh_heights(tiles, x, y):
    """The heights (Unreal z) of every navmesh polygon under Unreal (x, y)."""
    rx, rz = -x, -y
    out = []
    for bmin, bmax, polys in tiles:
        if not (bmin[0] <= rx <= bmax[0] and bmin[2] <= rz <= bmax[2]):
            continue
        for poly in polys:
            inside = False
            for i in range(len(poly)):
                a, b = poly[i], poly[i - 1]
                if (a[2] > rz) != (b[2] > rz) and rx < a[0] + (rz - a[2]) / (b[2] - a[2]) * (b[0] - a[0]):
                    inside = not inside
            if inside:
                out.append(sum(v[1] for v in poly) / len(poly))
    return sorted(out)


def check_spots(nav_data):
    """Every arena start and every side's spot (sides of 1 to MAX_SIDE) stands
    on the stock navmesh's arena floor, a little above it, and no two of them
    are within three capsule radii of each other (a start and a spot either:
    a teleport never lands on a fighter still standing at a start). Returns
    {point: floor height}."""
    tiles = navmesh_tiles(nav_data)
    assert len(tiles) > 1000, "no navmesh (%d tiles)" % len(tiles)
    starts = [loc for loc, _yaw in ARENA_STARTS.values()]
    points = list(starts)
    for n in range(1, MAX_SIDE + 1):
        for side in side_spots(n):
            points += side
    floors = {}
    for x, y, z in set(points):
        under = [h for h in navmesh_heights(tiles, x, y) if 0.0 < z - h < 250.0]
        assert under, "(%g, %g, %g): no navmesh floor under it" % (x, y, z)
        floors[(x, y, z)] = max(under)
    for n in range(1, MAX_SIDE + 1):
        group = starts + side_spots(n)[0] + side_spots(n)[1]
        for i, a in enumerate(group):
            for b in group[i + 1:]:
                d = ((a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2) ** 0.5
                assert d >= 3 * CAPSULE, "%s and %s are only %g apart" % (a, b, d)
    return floors


def main(paks_dir):
    originals = find_in_paks(paks_dir, {GAME_MODE, JUNGLE, PAWN, SOURCE_PERK, NAVIGATION})
    originals[PERK] = originals.pop(SOURCE_PERK)
    floors = check_spots(originals.pop(NAVIGATION))
    print("showdown: %d arena starts and spots on the navmesh (floor z %.0f-%.0f)"
          % (len(floors), min(floors.values()), max(floors.values())))
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
    for kit in server_kit()["kits"]:
        print("showdown kit: %s (%s)" % (kit["name"], ", ".join(i["name"] for i in kit["items"])))


if __name__ == "__main__":
    main(sys.argv[1])
