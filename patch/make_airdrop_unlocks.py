"""Level unlocks for the airdrops that start locked.

An airdrop is unlocked when the player owns its item. Six of the airdrops in
the menu (and Archer) were never in the server's catalog - their files differ
in case from their assets, so build_catalog.py skipped them - and nobody could
own them. This adds them to server/data/catalog.json with the level that
unlocks each one, worked out from the tiers of what it gives:

    each weapon or armor counts its tier (1-4), every other item counts 1;
    the airdrop unlocks at the level equal to the total.

Melee tiers are the game's own ("Tier 4 Spear"); guns, bows and armor have
none, so they're rated below. Levels stay within the season's level cap.
It also writes the levels for the menu (FrontEnd/js/AirdropUnlocks.js).

usage: python make_airdrop_unlocks.py [Paks dir]
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_catalog import pak_entries, read_entry, stock_paks, write_catalog  # noqa: E402
from uasset import Package  # noqa: E402

PAKS = os.path.join(HERE, "..", "TheCulling", "Victory", "Content", "Paks")
CATALOG = os.path.join(HERE, "..", "server", "data", "catalog.json")
MENU_JS = os.path.join(HERE, "src", "Victory", "Content", "uiresources", "FrontEnd", "js", "AirdropUnlocks.js")

# The airdrops that start locked; the others in the menu are the stock starters.
LOCKED = ["Airdrop_Cyclops", "Airdrop_DemonHunter", "Airdrop_HawksEye",
          "Airdrop_Polecat", "Airdrop_TheImp", "Airdrop_Viking"]
# server.js SEASON.maxLevel: an unlock above it couldn't be reached this season.
SEASON_MAX_LEVEL = 14
MIN_LEVEL = 2

# Items with no tier in their description, rated on the same 1-4 scale.
TIERS = {
    "weaprifle": 4, "weapsmg": 4, "weap357magnum": 4, "weapcompoundbow": 4,
    "weapautobow": 3, "weaprecurvebow": 3, "bodyarmor": 3,
    "hardenedarmor": 2, "weapcraftedbow": 1, "weapcraftedblowgun": 1,
}


def read_paks(paks):
    """The airdrop assets and the menu's English item strings."""
    airdrops, loc = {}, None
    for pak in stock_paks(paks):
        for f, name, off, usize, method, blocks in pak_entries(pak):
            if "/AirDropPackages/" in name and name.endswith(".uasset"):
                airdrops[name] = read_entry(f, off, usize, method, blocks)
            elif name.endswith("uiresources/Localization/FrontEnd.json"):
                loc = json.loads(read_entry(f, off, usize, method, blocks).decode("utf-8-sig"))
    return airdrops, loc["items"]


def item_tier(key, items):
    if key in TIERS:
        return TIERS[key]
    desc = ((items.get(key) or {}).get("description") or {}).get("en", "")
    m = re.search(r"Tier (\d)", desc)
    return int(m.group(1)) if m else 1


def airdrop(name, data, items):
    pkg = Package(data)
    e = pkg.exports[0]
    props = {p[0]: p[6] for p in pkg.props(e["name"])}
    body = data[e["offset"]:e["offset"] + e["size"]]
    contents = [m.decode().split(".")[-1][:-2].lower() for m in re.findall(rb"/Game/[\w/]+\.\w+", body)]
    return {
        "export": e["name"],
        "tid": int(props["ItemID"]),
        "asset": name.replace("../../../Victory/Content/", "/Game/").rsplit(".", 1)[0],
        "display": props.get("DisplayName", e["name"]),
        "default": bool(props.get("bDefaultItem", False)),
        "points": [(k, item_tier(k, items)) for k in contents],
    }


def catalog_entry(a):
    return {
        "tid": a["tid"], "asset": a["asset"], "class": "AirDropPackageDataAsset", "type": "",
        "displayName": a["export"], "category": "", "storeCategory": "", "rarity": 0,
        "maxQuantity": 1, "purchaseCost": 0.0, "premiumCost": 0.0, "resale": 0.0,
        "purchasable": False, "premiumPurchasable": False, "default": a["default"],
    }


def main(paks):
    assets, items = read_paks(paks)
    found = {a["export"]: a for a in (airdrop(n, d, items) for n, d in assets.items())}
    catalog = json.load(open(CATALOG))
    by_tid = {i["tid"]: i for i in catalog}

    # Airdrops the catalog is missing, each after the stock item before it.
    for a in sorted(found.values(), key=lambda a: a["tid"]):
        if a["tid"] in by_tid:
            continue
        before = max((i for i, c in enumerate(catalog) if not c.get("source") and c["tid"] < a["tid"]),
                     key=lambda i: catalog[i]["tid"], default=-1)
        catalog.insert(before + 1, catalog_entry(a))
        by_tid[a["tid"]] = catalog[before + 1]
        print("added   %-20s %d" % (a["export"], a["tid"]))

    levels = {}
    for name in LOCKED:
        a = found[name]
        level = max(MIN_LEVEL, min(SEASON_MAX_LEVEL, sum(t for _, t in a["points"])))
        by_tid[a["tid"]]["unlockLevel"] = level
        levels[str(a["tid"])] = level
        print("level %2d %-14s %s" % (level, a["display"], " + ".join("%s %d" % (k, t) for k, t in a["points"])))

    write_catalog(CATALOG, catalog)
    with open(MENU_JS, "w", newline="\n") as f:
        f.write("// Generated by patch/make_airdrop_unlocks.py: the level that unlocks each\n"
                "// airdrop that starts locked (by ItemID). The server grants them.\n"
                "var AirdropUnlockLevels = " + json.dumps(levels, sort_keys=True) + ";\n\n"
                "rivets.formatters.airdropUnlockText = function (itemID) {\n"
                "  var level = AirdropUnlockLevels[String(itemID)];\n"
                "  return level ? \"LVL \" + level : \"\";\n"
                "};\n\n"
                "rivets.formatters.airdropUnlockNote = function (itemID) {\n"
                "  var level = AirdropUnlockLevels[String(itemID)];\n"
                "  return level ? \"Unlocks at level \" + level : \"\";\n"
                "};\n")
    print("wrote", os.path.relpath(MENU_JS, HERE))


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else PAKS)
