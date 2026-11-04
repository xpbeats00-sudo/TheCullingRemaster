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
KIT = json.load(open(os.path.join(HERE, "..", "server", "data", "showdown.json")))["kit"]
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

for i in KIT["items"]:
    assert i["autoEquip"] == (i["category"] == "armor"), i
assert any(i["category"] == "armor" for i in KIT["items"]), "the kit should show the armor rule"
ok("Showdown kit %s: only armor auto-equips (%s)" % (KIT["name"], ", ".join("%s%s" % (i["name"], " [auto]" if i["autoEquip"] else "") for i in KIT["items"])))

print("all %d loot table tests passed" % passed)
