"""Difficulty tiers for the match AI: one tier is built into the patch pak.

The match AI is the stock one (BasicController + the MatchBot behavior tree,
whose services call native AShooterAIController functions; see
docs/BOT_AI_AUDIT.md and docs/BOT_AI_FULL_OVERHAUL.md). Nothing here is
machine learning: a tier is a hand-chosen set of stored values in the cooked
assets, edited in place (same size, no new names, imports or exports):

  decisions  how often the combat chooser re-rolls block/shove/jab/charge
             (MatchBot SelectAction_C_3.Interval; stock 0.001 s = every frame),
             the scavenging chooser, retargeting and the hearing poll
  perception sight radius, lose-sight radius, half-angle of the sight cone
  memory     how long a seen / damaging contestant stays known after contact
             is lost (AISenseConfig MaxAge; stock 60 s / 30 s)
  threat     ThreatParams: the distance beyond which a contestant who hasn't
             hurt the bot is ignored (kept equal to the sight radius) and how
             much closeness counts against damage taken
  melee      charged-attack hold time (MeleeCharge bytecode literals), waiting
             out a raised block (ChargeTime/MaxHoldTime; stock it never waits),
             how long a block is held and how soon it can be raised again
  bow        draw time before the release check, forced release
  loot       BotWeaponScore: healing and armour worth picking up, weapons the
             AI can't use (guns, grenades, mines, caltrops) not worth it

Every tier also fixes FireProjectile's DestinationKey (it read the vector key
"Destination" as an actor, so archers walked toward world origin while
drawing): it now names SelfActor, so archers hold position while they draw.

No tier changes health, damage, stamina, speed or anything a player has: only
how often and how well the AI decides. In-game effect: NOT TESTED.

usage: python make_bot_ai.py <Paks dir> [--tier NAME] [--out DIR] [--list]
  default tier: experienced; output: patch/src (make_pak.py packs it)
"""
import argparse
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_catalog import pak_entries, read_entry  # noqa: E402
from uasset import Package  # noqa: E402

BP = "Victory/Content/Blueprints/"
TREE = BP + "AI/Trees/MatchBot.uasset"
CONTROLLER = BP + "AI/Base/BasicController.uasset"
CHARGE = BP + "AI/Behaviors/MeleeCharge.uasset"
BLOCK = BP + "AI/Behaviors/MeleeBlock.uasset"
FIRE = BP + "AI/Behaviors/FireProjectile.uasset"

ORDER = ("beginner", "casual", "experienced", "advanced", "elite")
DEFAULT_TIER = "experienced"

# decide: combat chooser interval (s; the engine adds +-0.1 s, RandomDeviation
#   isn't stored). scavenge: no-enemy chooser interval. retarget/listen:
#   (interval, random deviation). sight: (radius, lose radius, half-angle deg).
#   memory: (sight MaxAge, damage MaxAge) s. threat: ThreatPerMeterCloser...
#   (MaxDistance follows the sight radius). charge: hold-time range.
#   wait_block: max total charge time while the target blocks (None = stock,
#   never waits). block: (hold s, cooldown min, cooldown max). draw: bow
#   draw-time range before the first release check; release: forced release.
TIERS = {
    "beginner": dict(decide=0.60, scavenge=1.0, retarget=(2.0, 0.5), listen=(6.0, 1.5),
                     sight=(2000.0, 3000.0, 55.0), memory=(4.0, 6.0), threat=6.0,
                     charge=(1.0, 1.0), wait_block=None, block=(2.0, 2.0, 3.0),
                     draw=(1.0, 1.8), release=3.0, loot=False),
    "casual": dict(decide=0.40, scavenge=0.8, retarget=(1.5, 0.4), listen=(5.0, 1.2),
                   sight=(2750.0, 4000.0, 65.0), memory=(6.0, 8.0), threat=6.0,
                   charge=(0.8, 1.2), wait_block=None, block=(1.75, 1.5, 2.5),
                   draw=(0.8, 1.4), release=2.5, loot=True),
    "experienced": dict(decide=0.25, scavenge=0.6, retarget=(1.0, 0.25), listen=(4.0, 1.0),
                        sight=(3500.0, 5000.0, 75.0), memory=(8.0, 10.0), threat=5.0,
                        charge=(0.6, 1.4), wait_block=1.4, block=(1.5, 1.0, 1.5),
                        draw=(0.6, 1.1), release=2.0, loot=True),
    "advanced": dict(decide=0.15, scavenge=0.5, retarget=(0.75, 0.2), listen=(3.0, 0.75),
                     sight=(3500.0, 5000.0, 75.0), memory=(12.0, 12.0), threat=4.0,
                     charge=(0.5, 1.5), wait_block=1.8, block=(1.25, 1.0, 1.5),
                     draw=(0.5, 1.0), release=2.0, loot=True),
    "elite": dict(decide=0.08, scavenge=0.4, retarget=(0.5, 0.1), listen=(2.5, 0.5),
                  sight=(4000.0, 5500.0, 80.0), memory=(16.0, 15.0), threat=4.0,
                  charge=(0.5, 1.5), wait_block=2.2, block=(1.1, 0.8, 1.2),
                  draw=(0.5, 0.9), release=1.8, loot=True),
}
assert tuple(TIERS) == ORDER

# BotWeaponScore with loot on (stock in brackets). A bot loots an item that
# scores above the lowest-scoring item it carries (fists: 5), so healing and
# armour (stock 1) were never picked up. They stay below every real melee
# weapon (>= 10), so the weapon chooser can't prefer them. Guns, grenades,
# mines and caltrops can't be used by the AI (its weapon checks accept melee,
# bow and spray only), so they drop below the fists: no trips for them.
LOOT_SCORES = {   # item: (stock, new)
    "Items/Bandage": (1, 8), "Items/Medkit": (1, 9), "Items/HemoDrip": (1, 7), "Items/CraftedBandage": (1, 6),
    "Items/BodyArmor": (1, 9), "Items/CrudeArmor": (1, 7), "Items/Backpack": (1, 9), "Items/Satchel": (1, 6),
    "Weapons/WeapRifle": (40, 3), "Weapons/WeapSMG": (40, 3), "Weapons/Weap357Magnum": (40, 3),
    "Weapons/WeapAlarmGun": (10, 3),
    "Weapons/WeapDynamite": (30, 3), "Weapons/WeapImpactGrenade": (30, 3),
    "Weapons/WeapGasGrenade": (20, 3), "Weapons/WeapRemoteExplosive": (20, 3),
    "Weapons/WeapCraftedExplosive": (20, 3), "Weapons/WeapCraftedSmokeBomb": (20, 3),
    "Weapons/WeapCraftedMine": (20, 2), "Weapons/WeapExplosiveMine": (20, 2),
    "Weapons/WeapCraftedPunjiSticks": (20, 2), "Weapons/WeapSteelPunjiSticks": (15, 2),
    "Weapons/WeapCraftedCaltrops": (10, 2), "Weapons/WeapSteelCaltrops": (15, 2),
}

# Stock values each edit expects to find (the generator stops on anything else).
STOCK = {
    (TREE, "SelectAction_C_3", "Interval"): 0.001,
    (TREE, "SelectAction_C_24", "Interval"): 0.6,
    (TREE, "FindBestTarget_C_1", "Interval"): 1.0,
    (TREE, "FindBestTarget_C_1", "RandomDeviation"): 0.0,
    (TREE, "Listen_C_0", "Interval"): 4.0,
    (TREE, "Listen_C_0", "RandomDeviation"): 1.0,
    (TREE, "BTDecorator_Cooldown_8", "MinCoolDownTime"): 1.0,      # gates MeleeBlock
    (TREE, "BTDecorator_Cooldown_8", "MaxCoolDownTime"): 1.5,
    (TREE, "FireProjectile_C_0", "DestinationKey.SelectedKeyName"): "Destination",
    (CONTROLLER, "AISenseConfig_Sight_1", "SightRadius"): 3500.0,
    (CONTROLLER, "AISenseConfig_Sight_1", "LoseSightRadius"): 5000.0,
    (CONTROLLER, "AISenseConfig_Sight_1", "PeripheralVisionAngleDegrees"): 75.0,
    (CONTROLLER, "AISenseConfig_Sight_1", "MaxAge"): 60.0,
    (CONTROLLER, "AISenseConfig_Damage_1", "MaxAge"): 30.0,
    (CONTROLLER, "Default__BasicController_C", "ThreatParams.ThreatPerMeterCloserThanMaxDistance"): 6.0,
    (CONTROLLER, "Default__BasicController_C", "ThreatParams.MaxDistance"): 3500.0,
    (BLOCK, "Default__MeleeBlock_C", "TimeToHoldBlock"): 1.5,
}
for _item, (_stock, _new) in LOOT_SCORES.items():
    STOCK[(BP + _item + ".uasset", "Default__%s_C" % _item.split("/")[1], "BotWeaponScore")] = _stock

# Property names a tier may touch. Anything about health, damage, stamina or
# movement is deliberately absent; test_bot_ai.py checks the edits against it.
ALLOWED_PROPS = {
    "Interval", "RandomDeviation", "MinCoolDownTime", "MaxCoolDownTime", "SelectedKeyName",
    "SightRadius", "LoseSightRadius", "PeripheralVisionAngleDegrees", "MaxAge",
    "ThreatPerMeterCloserThanMaxDistance", "MaxDistance", "TimeToHoldBlock", "BotWeaponScore",
}


# ------------------------------------------------------------ reading assets

def stock_assets(paks_dir, wanted):
    """The stock copies: every base pak, never a patch pak (*_P.pak), so a
    rebuild never stacks on an installed patch."""
    found = {}
    for pak in sorted(os.listdir(paks_dir)):
        if not pak.endswith(".pak") or pak.endswith("_P.pak"):
            continue
        for f, name, off, usize, method, blocks in pak_entries(os.path.join(paks_dir, pak)):
            rel = name.replace("../../../", "")
            if rel in wanted:
                found[rel] = read_entry(f, off, usize, method, blocks)
    missing = set(wanted) - set(found)
    if missing:
        sys.exit("not found in the base paks: %s" % ", ".join(sorted(missing)))
    return found


SIMPLE_STRUCTS = {"Vector", "Rotator", "LinearColor", "Guid", "Color", "Vector2D", "IntPoint", "Quat"}


def walk(pkg, start, end, prefix=""):
    """Every tagged property in [start, end), nested structs and struct arrays
    included: yields (path, type, value offset, size, extra). Paths read
    "ThreatParams.MaxDistance", "Children(2).ChildTask"."""
    d = pkg.data

    def fname(p):
        i, n = struct.unpack_from("<ii", d, p)
        s = pkg.names[i]
        return (s if n == 0 else "%s_%d" % (s, n - 1)), p + 8

    p = start
    while p < end:
        name, p = fname(p)
        if name == "None":
            return p
        ptype, p = fname(p)
        size, idx = struct.unpack_from("<ii", d, p)
        p += 8
        extra = None
        if ptype == "StructProperty":
            extra, p = fname(p)
            p += 16
        elif ptype == "BoolProperty":
            extra = d[p]
            p += 1
        elif ptype in ("ByteProperty", "EnumProperty", "ArrayProperty", "SetProperty"):
            extra, p = fname(p)
        elif ptype == "MapProperty":
            p += 16
        has_guid = d[p]
        p += 1 + (16 if has_guid else 0)
        path = prefix + name + ("[%d]" % idx if idx else "")
        yield path, ptype, p, size, extra
        if ptype == "StructProperty" and extra not in SIMPLE_STRUCTS:
            yield from walk(pkg, p, p + size, path + ".")
        elif ptype == "ArrayProperty" and extra == "StructProperty":
            count = struct.unpack_from("<i", d, p)[0]
            q = p + 4
            _, q = fname(q)                      # inner tag: name, type, size, index, struct name, guid, has-guid
            _, q = fname(q)
            q += 8
            inner, q = fname(q)
            q += 17
            for k in range(count):
                if inner in SIMPLE_STRUCTS:
                    break
                sub = walk(pkg, q, p + size, "%s(%d)." % (path, k))
                while True:
                    try:
                        yield next(sub)
                    except StopIteration as stop:
                        q = stop.value
                        break
        p += size
    return p


def find_prop(pkg, export, path):
    """(type, value offset, size) of a stored property, by path."""
    e = pkg.export(export)
    for ppath, ptype, off, size, _extra in walk(pkg, e["offset"], e["offset"] + e["size"]):
        if ppath == path:
            return ptype, off, size
    raise KeyError("%s.%s is not stored in the asset" % (export, path))


def read_value(pkg, ptype, off):
    d = pkg.data
    if ptype == "FloatProperty":
        return struct.unpack_from("<f", d, off)[0]
    if ptype == "IntProperty":
        return struct.unpack_from("<i", d, off)[0]
    if ptype == "NameProperty":
        i, n = struct.unpack_from("<ii", d, off)
        return pkg.names[i] if n == 0 else "%s_%d" % (pkg.names[i], n - 1)
    raise ValueError(ptype)


# ------------------------------------------------------------ script literals

EX_CALL_MATH, EX_FLOAT_CONST, EX_STRING_CONST, EX_LET, EX_INSTANCE_VARIABLE = 0x68, 0x1E, 0x1F, 0x0F, 0x01


def _index_of(pkg, name, imports):
    table = pkg.imports if imports else [e["name"] for e in pkg.exports]
    hits = [i for i, n in enumerate(table) if n == name]
    assert len(hits) == 1, "%s: %d matches" % (name, len(hits))
    return -(hits[0] + 1) if imports else hits[0] + 1


def code_literals(pkg, function, pattern):
    """File offsets of float literals in a function's script, found by token
    pattern (never by fixed offset):
      ("range", None)        RandomFloatInRange(<f>, <f>): offsets of both floats
      ("let", "MaxHoldTime") MaxHoldTime = <f>
      ("timer", "StopPrimary") a "StopPrimary" string constant then <f>
    """
    e = pkg.export(function)
    d, start, end = pkg.data, e["offset"], e["offset"] + e["size"]
    kind, arg = pattern
    out = []
    if kind == "range":
        needle = bytes([EX_CALL_MATH]) + struct.pack("<i", _index_of(pkg, "RandomFloatInRange", True))
        p = d.find(needle, start, end)
        while p >= 0:
            a = p + len(needle)
            assert d[a] == EX_FLOAT_CONST and d[a + 5] == EX_FLOAT_CONST, "RandomFloatInRange without literal arguments"
            out.append((a + 1, a + 6))
            p = d.find(needle, p + 1, end)
    elif kind == "let":
        prop = struct.pack("<i", _index_of(pkg, arg, False))
        needle = bytes([EX_LET]) + prop + bytes([EX_INSTANCE_VARIABLE]) + prop + bytes([EX_FLOAT_CONST])
        p = d.find(needle, start, end)
        while p >= 0:
            out.append(p + len(needle))
            p = d.find(needle, p + 1, end)
    elif kind == "timer":
        needle = bytes([EX_STRING_CONST]) + arg.encode("ascii") + b"\0" + bytes([EX_FLOAT_CONST])
        p = d.find(needle, start, end)
        while p >= 0:
            out.append(p + len(needle))
            p = d.find(needle, p + 1, end)
    else:
        raise ValueError(kind)
    return out


def f32(x):
    return struct.unpack("<f", struct.pack("<f", x))[0]


# ------------------------------------------------------------ the edits

def tier_edits(tier):
    """{asset: [(kind, export, where, value)]}: kind "prop" (where = property
    path) or "code" (where = (pattern, occurrence, argument))."""
    t = TIERS[tier]
    sight, lose, angle = t["sight"]
    edits = {
        TREE: [
            ("prop", "SelectAction_C_3", "Interval", t["decide"]),
            ("prop", "SelectAction_C_24", "Interval", t["scavenge"]),
            ("prop", "FindBestTarget_C_1", "Interval", t["retarget"][0]),
            ("prop", "FindBestTarget_C_1", "RandomDeviation", t["retarget"][1]),
            ("prop", "Listen_C_0", "Interval", t["listen"][0]),
            ("prop", "Listen_C_0", "RandomDeviation", t["listen"][1]),
            ("prop", "BTDecorator_Cooldown_8", "MinCoolDownTime", t["block"][1]),
            ("prop", "BTDecorator_Cooldown_8", "MaxCoolDownTime", t["block"][2]),
            ("prop", "FireProjectile_C_0", "DestinationKey.SelectedKeyName", "SelfActor"),
        ],
        CONTROLLER: [
            ("prop", "AISenseConfig_Sight_1", "SightRadius", sight),
            ("prop", "AISenseConfig_Sight_1", "LoseSightRadius", lose),
            ("prop", "AISenseConfig_Sight_1", "PeripheralVisionAngleDegrees", angle),
            ("prop", "AISenseConfig_Sight_1", "MaxAge", t["memory"][0]),
            ("prop", "AISenseConfig_Damage_1", "MaxAge", t["memory"][1]),
            ("prop", "Default__BasicController_C", "ThreatParams.ThreatPerMeterCloserThanMaxDistance", t["threat"]),
            # Threat is 0 beyond MaxDistance, so sight past it would see nothing new.
            ("prop", "Default__BasicController_C", "ThreatParams.MaxDistance", sight),
        ],
        BLOCK: [("prop", "Default__MeleeBlock_C", "TimeToHoldBlock", t["block"][0])],
        CHARGE: [
            # Both RandomFloatInRange(1, 1) hold timers (weak and normal path).
            ("code", "ExecuteUbergraph_MeleeCharge", (("range", None), 0, 0), t["charge"][0]),
            ("code", "ExecuteUbergraph_MeleeCharge", (("range", None), 0, 1), t["charge"][1]),
            ("code", "ExecuteUbergraph_MeleeCharge", (("range", None), 1, 0), t["charge"][0]),
            ("code", "ExecuteUbergraph_MeleeCharge", (("range", None), 1, 1), t["charge"][1]),
        ],
        FIRE: [
            ("code", "ExecuteUbergraph_FireProjectile", (("range", None), 0, 0), t["draw"][0]),
            ("code", "ExecuteUbergraph_FireProjectile", (("range", None), 0, 1), t["draw"][1]),
            ("code", "ExecuteUbergraph_FireProjectile", (("timer", "StopPrimary"), 0, None), t["release"]),
        ],
    }
    if t["wait_block"] is not None:
        # ConsiderAttacking releases when the target isn't blocking or
        # ChargeTime > MaxHoldTime (ChargeTime grows by DeltaSeconds each
        # tick). Stock both start at 1.0, so it never waits; starting
        # ChargeTime at 0 makes the bot hold a charge into a raised block for
        # up to wait_block seconds, re-checking every 0.2 s.
        edits[CHARGE] += [
            ("code", "ExecuteUbergraph_MeleeCharge", (("let", "MaxHoldTime"), 0, None), t["wait_block"]),
            ("code", "ExecuteUbergraph_MeleeCharge", (("let", "ChargeTime"), 0, None), 0.0),
        ]
    if t["loot"]:
        for item, (_stock, score) in LOOT_SCORES.items():
            asset = BP + item + ".uasset"
            edits[asset] = [("prop", "Default__%s_C" % item.split("/")[1], "BotWeaponScore", score)]
    return edits


# Stock literals the script edits expect: (asset, pattern) -> list of values.
STOCK_CODE = {
    (CHARGE, ("range", None)): [(1.0, 1.0), (1.0, 1.0)],
    (CHARGE, ("let", "MaxHoldTime")): [1.0],
    (CHARGE, ("let", "ChargeTime")): [1.0],
    (FIRE, ("range", None)): [(0.5, 1.0)],
    (FIRE, ("timer", "StopPrimary")): [2.0],
}


def all_assets():
    return sorted({a for t in ORDER for a in tier_edits(t)})


def apply(asset, data, edits, log=None):
    """The patched copy of one asset and the byte ranges written."""
    pkg = Package(bytes(data))
    out = bytearray(data)
    written = []
    for kind, export, where, value in edits:
        if kind == "prop":
            ptype, off, size = find_prop(pkg, export, where)
            old = read_value(pkg, ptype, off)
            want = STOCK.get((asset, export, where))
            if want is not None and (old != want if isinstance(want, str) else abs(old - want) > 1e-6):
                sys.exit("%s %s.%s: stock %r, found %r" % (asset, export, where, want, old))
            if ptype == "FloatProperty":
                struct.pack_into("<f", out, off, float(value))
            elif ptype == "IntProperty":
                struct.pack_into("<i", out, off, int(value))
            elif ptype == "NameProperty":
                # an existing name only: the name table stays as it is
                struct.pack_into("<ii", out, off, pkg.names.index(value), 0)
            else:
                sys.exit("can't write %s (%s)" % (where, ptype))
            written.append((off, off + size, export, where, old, value))
        else:
            (pattern, occurrence, arg) = where
            hits = code_literals(pkg, export, pattern)
            stock = STOCK_CODE[(asset, pattern)]
            if len(hits) != len(stock):
                sys.exit("%s %s %s: %d literals, expected %d" % (asset, export, pattern, len(hits), len(stock)))
            off = hits[occurrence] if arg is None else hits[occurrence][arg]
            old = struct.unpack_from("<f", data, off)[0]
            want = stock[occurrence] if arg is None else stock[occurrence][arg]
            if abs(old - want) > 1e-6:
                sys.exit("%s %s %s #%d: stock %r, found %r" % (asset, export, pattern, occurrence, want, old))
            struct.pack_into("<f", out, off, float(value))
            written.append((off, off + 4, export, "%s#%d%s" % (pattern[1] or pattern[0], occurrence,
                                                               "" if arg is None else ".%d" % arg), old, value))
        if log:
            w = written[-1]
            log("  %s %s: %s -> %s" % (w[2], w[3], _fmt(w[4]), _fmt(w[5])))
    assert len(out) == len(data)
    return bytes(out), written


def _fmt(v):
    return ("%g" % f32(v)) if isinstance(v, float) else str(v)


def build(tier, stock, log=None):
    """{asset: (patched bytes, written ranges)} for a tier."""
    result = {}
    for asset, edits in sorted(tier_edits(tier).items()):
        if log:
            log(asset)
        result[asset] = apply(asset, stock[asset], edits, log)
    return result


def print_table():
    rows = [("combat decision interval s", "decide"), ("scavenge decision s", "scavenge"),
            ("retarget s (+-)", "retarget"), ("hearing poll s (+-)", "listen"),
            ("sight radius / lose / half-angle", "sight"), ("memory: sight / damage s", "memory"),
            ("threat per metre closer", "threat"), ("charge hold s", "charge"),
            ("wait out a block (max s)", "wait_block"), ("block hold / cooldown s", "block"),
            ("bow draw s", "draw"), ("bow forced release s", "release"), ("loot rebalance", "loot")]
    print("%-34s" % "" + "".join("%-22s" % t for t in ORDER))
    for label, key in rows:
        print("%-34s" % label + "".join("%-22s" % (TIERS[t][key],) for t in ORDER))


def main():
    ap = argparse.ArgumentParser(description="Build one AI difficulty tier into patch/src")
    ap.add_argument("paks", nargs="?")
    ap.add_argument("--tier", default=DEFAULT_TIER, choices=ORDER)
    ap.add_argument("--out", default=os.path.join(HERE, "src"))
    ap.add_argument("--list", action="store_true", help="print the tier table and exit")
    a = ap.parse_args()
    if a.list:
        print_table()
        return
    if not a.paks:
        ap.error("the Paks dir is required")
    stock = stock_assets(a.paks, set(all_assets()))
    print("tier:", a.tier)
    built = build(a.tier, stock, log=print)
    # Assets a tier leaves alone (the loot items with loot off) go back to stock:
    # remove a copy an earlier build of another tier left in the output.
    for asset in all_assets():
        out = os.path.join(a.out, asset)
        if asset in built:
            os.makedirs(os.path.dirname(out), exist_ok=True)
            with open(out, "wb") as f:
                f.write(built[asset][0])
        elif os.path.exists(out):
            os.remove(out)
            print("stock again (removed):", asset)
    print("%d assets -> %s" % (len(built), a.out))


if __name__ == "__main__":
    main()
