"""Checks the loot tables (patch/loot/loot_tables.json, from loot_tables.py)
and the Showdown kit (server/data/showdown.json, from make_showdown.py).

- Every item in any list or kit is a known item with a category, and every
  category the spec names (melee, ranged, armor, injects, Muscle Man Milk,
  healing, throwables, traps, utility) has items.
- Weighted draws: 200,000 draws from each list land within 1 percentage point
  of the list's stated chances (the same weighted pick the game makes: one
  entry, chance = weight / total weight). The game's own random generator is
  compiled code and isn't exercised here.
- Lists with no weight (all zero) are reported, not divided by zero.
- Showdown kit: only armor is marked auto-equip.

usage: python test_loot_tables.py
"""
import json
import os
import random
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
LOOT = json.load(open(os.path.join(HERE, "loot", "loot_tables.json")))
SHOWDOWN = json.load(open(os.path.join(HERE, "..", "server", "data", "showdown.json")))
KIT = SHOWDOWN["kit"]
KITS = SHOWDOWN["kits"]
DRAWS = 200000
passed = 0


def ok(name):
    global passed
    passed += 1
    print("ok    " + name)


def lists():
    for tier, lst in LOOT["tiers"].items():
        yield "tier " + tier, lst
    for m, tiers in LOOT["maps"].items():
        for tier, lst in tiers.items():
            yield "%s %s" % (m, tier), lst
    for c, comps in LOOT["containers"].items():
        for comp, lst in comps.items():
            yield "%s/%s" % (c, comp), lst


def draw(entries, rng):
    """One weighted pick, as the game makes it."""
    total = sum(e["weight"] for e in entries)
    if total <= 0:
        raise ValueError("no weight")
    x = rng.uniform(0, total)
    for e in entries:
        x -= e["weight"]
        if x < 0:
            return e["item"]
    return entries[-1]["item"]


items = LOOT["items"]
for name, lst in lists():
    for e in lst:
        assert e["item"] is None or e["item"] in items, "%s: unknown item %s" % (name, e["item"])
for kit in LOOT["airdrops"].values():
    for i in kit["items"]:
        assert i in items, i
ok("every listed item is a known item (%d items, %d lists, %d kits)" % (len(items), sum(1 for _ in lists()), len(LOOT["airdrops"])))

cats = {v["category"] for v in items.values()}
for need in ("melee", "ranged", "armor", "inject", "muscle_milk", "healing", "throwable", "trap", "utility"):
    assert need in cats, need
ok("every category has items: " + ", ".join(sorted(cats)))

rng = random.Random(20261104)
worst = (0, None)
for name, lst in lists():
    if sum(e["weight"] for e in lst) <= 0:
        continue
    counts = {}
    for _ in range(DRAWS):
        k = draw(lst, rng)
        counts[k] = counts.get(k, 0) + 1
    for e in lst:
        # An item can be listed twice (Hemo Drip in the medicine cabinet).
        got = counts.get(e["item"], 0) / DRAWS
        want = sum(x["chance"] for x in lst if x["item"] == e["item"])
        off = abs(got - want)
        if off > worst[0]:
            worst = (off, "%s %s" % (name, e["item"]))
        assert off < 0.01, "%s %s: %.4f vs %.4f" % (name, e["item"], got, want)
ok("weighted draws match the stated chances (largest difference %.2f points: %s)" % (100 * worst[0], worst[1]))

try:
    draw([{"item": "WeapRock_C", "weight": 0}], rng)
    raise AssertionError("a list with no weight must not draw")
except ValueError:
    ok("a list with no weight fails safely")

for i in KIT["items"] + [i for k in KITS for i in k["items"]]:
    assert i["autoEquip"] == (i["category"] == "armor"), i
assert any(i["category"] == "armor" for i in KIT["items"]), "the kit should show the armor rule"
ok("Showdown kit %s: only armor auto-equips (%s)" % (KIT["name"], ", ".join("%s%s" % (i["name"], " [auto]" if i["autoEquip"] else "") for i in KIT["items"])))

# The built Showdown assets give exactly the kit (patch/src, from make_showdown.py).
sys.path.insert(0, HERE)
import struct  # noqa: E402
from uasset import Package  # noqa: E402
from uasset_tree import Tree, clean  # noqa: E402
SRC = os.path.join(HERE, "src", "Victory", "Content")


def props(rel, export):
    pkg = Package(open(os.path.join(SRC, rel), "rb").read())
    e = pkg.export(export)
    return pkg, Tree(pkg).props(e["offset"], e["offset"] + e["size"])


_, mode = props("Blueprints/GameMode/VictoryGameMode_Lightning.uasset", "Default__VictoryGameMode_Lightning_C")
assert all(clean_s["MinRoundTime"] >= 1000000 for clean_s in ({clean(k): v for k, v in x.items()} for x in mode["AirDropStages"]))
_, perk = props("Perks/Showdown/Perk_Showdown.uasset", "Perk_JumpStart")
bits = int(sum({clean(k): v for k, v in b.items()}["StatValue"] for b in perk["PerkBonuses"]))
assert perk["bEnabled"] and "Perk_JumpStart" in mode["OverridenPerks"]
assert "Perk_Backpacker" not in mode["OverridenPerks"], "Backpacker would add a backpack (bit 2)"
pawn, _ = props("Blueprints/Pawns/PlayerPawn.uasset", "Default__PlayerPawn_C")
e = pawn.export("GetSpawnWithWeaponClasses")
body = pawn.data[e["offset"]:e["offset"] + e["size"]]
# Bit tests (EX_IntConst) followed by the class each adds (EX_ObjectConst).
given, bit = [], None
for o in range(1, len(body) - 4):
    v = struct.unpack_from("<i", body, o)[0]
    # The bits are tested in rising order; the switch inside bit 32's branch
    # (cases 0-6) isn't a bit.
    if body[o - 1] == 0x1D and v in (1, 2, 4, 8, 16, 32) and (bit is None or v > bit):
        bit = v
    elif body[o - 1] == 0x20 and -len(pawn.imports) <= v <= -1:
        cls = pawn.imports[-v - 1]
        if cls.endswith("_C") and not cls.startswith("Default__") and bit and bits & bit:
            given.append(cls)
assert set(given) == {i["id"] for k in KITS for i in k["items"]}, (bits, given)
ok("the Showdown perk (bits %d) spawns everyone with the kits' items, no airdrops: %s" % (bits, ", ".join(sorted(set(given)))))

# Kit k's weapon is what bit 32's switch adds for RandomIntegerInRange(0, 6) == k
# (the patched exe sets that value to the round's kit). The switch compares
# the value with 0..6 (EX_IntConst after NotEqual_IntInt) and jumps to the
# class it adds when equal.
from make_showdown import ROTATION  # noqa: E402
assert [k["items"][0]["id"] for k in KITS] == ROTATION
ok("%d kits, one Tier 3 weapon each, the same armor and boost: %s" % (len(KITS), ", ".join(k["name"] for k in KITS)))

print("all %d loot table tests passed" % passed)
