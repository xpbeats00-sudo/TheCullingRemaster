"""The game's loot, as data: every weighted item list it spawns loot from,
read from the cooked assets, written as one table (patch/loot/loot_tables.json)
and a reference (docs/LOOT_TABLE_REFERENCE.md).

The game already has a data-driven loot system; this reads it rather than
adding another. Where loot comes from:
- Tier lists: ItemSpawnerItemList_Tier1/2/3 (Blueprint defaults, plus a copy
  placed in each map's Gameplay level) feed the tiered pedestals.
- Containers: each locker, cabinet, fridge, toilet and crate Blueprint has
  ItemSpawnerComponents with their own weighted ItemList (ItemClass, Weight,
  MinAmmo, MaxAmmo). An entry of NULL_C or None is "nothing".
- Game modes: how many crates, barrels and building item spawns a match
  places (GreenCratesToSpawn, SmallBuildingItemSpawns...) and the airdrop
  kits it hands out (SelectedAirDrop, mOverridenAirdrops).
- Airdrop kits: AirDropPackages/*, each a fixed list of items.
Item IDs are the game's own item classes (WeapTrident_C, BodyArmor_C...).

usage: python loot_tables.py <Paks dir>
"""
import json
import os
import re
import sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_catalog import pak_entries, read_entry, stock_paks  # noqa: E402
from uasset import Package  # noqa: E402
from uasset_tree import Tree, clean  # noqa: E402

OUT_JSON = os.path.join(HERE, "loot", "loot_tables.json")
OUT_DOC = os.path.join(HERE, "..", "docs", "LOOT_TABLE_REFERENCE.md")
MAPS = {"Jungle": "Victory/Content/Maps/Jungle/Gameplay.umap", "Prison": "Victory/Content/Maps/Jungle2/Gameplay.umap"}
TIER_LISTS = re.compile(r"Blueprints/ItemSpawners/ItemSpawnerItemList_Tier\d\.uasset$")
CONTAINERS = re.compile(r"Blueprints/(Container|Hazards)/[A-Za-z0-9_]+\.uasset$")
GAME_MODES = re.compile(r"Blueprints/GameMode/VictoryGameMode[A-Za-z0-9_]*\.uasset$")
AIRDROPS = re.compile(r"AirDropPackages/[A-Za-z0-9_]+\.uasset$")
LOOT_COUNTS = ("GreenCratesToSpawn", "RedCratesToSpawn", "RedBarrelsToSpawn", "PylonsToSpawn", "FuncBarrelsToSpawn",
               "ToiletGoodies", "SmallBuildingItemSpawns", "MediumBuildingItemSpawns", "LargeBuildingItemSpawns",
               "ExtraLargeBuildingItemSpawns", "ChanceOfAdditionalGreenCratesInBuildings", "ChanceOfLockersPreOpened",
               "StartingActivityValueOverride", "BotsToSpawn", "MatchWarmupTime")
NOTHING = {"NULL_C", "None", None}

# Categories (the game's own item names; descriptions from its localisation).
RANGED = {"WeapAutoBow_C", "WeapCompoundBow_C", "WeapRecurveBow_C", "WeapCraftedBow_C", "WeapCraftedBlowgun_C",
          "WeapRifle_C", "WeapSMG_C", "Weap357Magnum_C", "WeapAlarmGun_C", "WeapStunGun_C"}
THROWABLE = {"WeapImpactGrenade_C", "WeapGasGrenade_C", "WeapDynamite_C", "WeapRemoteExplosive_C", "WeapExplosiveMine_C",
             "WeapCraftedExplosive_C", "WeapCraftedSmokeBomb_C", "WeapPepperSpray_C", "WeapJavelin_C"}
TRAP = {"WeapSteelSnare_C", "WeapSteelCaltrops_C", "WeapSteelPunjiSticks_C", "WeapCraftedCaltrops_C",
        "WeapCraftedPunjiSticks_C", "DepDecoyExplosive_C"}
ARMOR = {"BodyArmor_C", "HardenedArmor_C"}
INJECT = {"HemoBlast_C", "HemoDrip_C", "LungButter_C", "StealthyShot_C", "ExplosiveRuns_C", "OrangeJuice_C", "Iron4Skin_C"}
MUSCLE_MILK = {"MuscleManMilk_C"}
HEALING = {"Medkit_C", "Bandage_C"}
UTILITY = {"Backpack_C", "Satchel_C", "WeapManTracker_C"}
CURRENCY = {"FuncIntheFridge_C"}           # FUNC pickup
KIT_TOKEN = {"WeapZRandom_C"}              # "Surprise Me": rolls a random airdrop kit


def category(item):
    for name, group in (("ranged", RANGED), ("throwable", THROWABLE), ("trap", TRAP), ("armor", ARMOR),
                        ("inject", INJECT), ("muscle_milk", MUSCLE_MILK), ("healing", HEALING), ("utility", UTILITY), ("currency", CURRENCY),
                        ("airdrop_token", KIT_TOKEN)):
        if item in group:
            return name
    if item.startswith(("LootContainer", "SupplyDrop", "Hazard_")):
        return "container"          # crate spawners place these; they hold the loot
    return "melee" if item.startswith("Weap") else "other"


def read_assets(paks):
    """Every asset we need, stock version (the Remaster patch pak excluded)."""
    found = {}
    wanted = (TIER_LISTS, CONTAINERS, GAME_MODES, AIRDROPS)
    for pak in stock_paks(paks):
        for f, name, off, usize, method, blocks in pak_entries(pak):
            rel = name.replace("../../../", "")
            if rel in MAPS.values() or any(p.search(rel) for p in wanted):
                found[rel] = read_entry(f, off, usize, method, blocks)
            elif rel.endswith("uiresources/Localization/FrontEnd.json"):
                found["loc"] = json.loads(read_entry(f, off, usize, method, blocks).decode("utf-8-sig"))["items"]
    return found


def exports(data):
    pkg = Package(data)
    tree = Tree(pkg)
    for e in pkg.exports:
        try:
            props = tree.props(e["offset"], e["offset"] + e["size"])
        except Exception:
            continue
        yield e["name"], pkg.ref(e["class"]), props


def weighted(entries, item_key, weight_key):
    out = []
    for x in entries:
        x = {clean(k): v for k, v in x.items()}
        item = x.get(item_key)
        out.append(OrderedDict([("item", None if item in NOTHING else item), ("weight", x.get(weight_key, 1))]
                               + [(k, x[k]) for k in ("MinAmmo", "MaxAmmo") if x.get(k)]))
    return out


def with_chances(entries):
    total = sum(e["weight"] for e in entries) or 1
    for e in entries:
        e["chance"] = round(e["weight"] / total, 4)
    return entries


def build(paks):
    assets = read_assets(paks)
    loc = assets.pop("loc")
    table = OrderedDict(source="Read from the game's cooked assets by patch/loot_tables.py", tiers={}, maps={},
                        containers={}, gameModes={}, airdrops={}, items={})
    for rel, data in sorted(assets.items()):
        base = os.path.splitext(os.path.basename(rel))[0]
        if TIER_LISTS.search(rel):
            for name, cls, props in exports(data):
                if name.startswith("Default__"):
                    table["tiers"][base.split("_")[-1]] = with_chances(weighted(props.get("WeightedItemListStruct", []), "ItemList", "ItemWeight"))
        elif rel in MAPS.values():
            m = [k for k, v in MAPS.items() if v == rel][0]
            for name, cls, props in exports(data):
                if cls and cls.startswith("ItemSpawnerItemList_Tier") and "WeightedItemListStruct" in props:
                    table["maps"].setdefault(m, {})[cls.split("_")[-2]] = with_chances(
                        weighted(props["WeightedItemListStruct"], "ItemList", "ItemWeight"))
        elif CONTAINERS.search(rel):
            for name, cls, props in exports(data):
                if cls == "ItemSpawnerComponent" and props.get("ItemList"):
                    lst = with_chances(weighted(props["ItemList"], "ItemClass", "Weight"))
                    if any(e["item"] for e in lst):
                        table["containers"].setdefault(base, OrderedDict())[name] = lst
        elif GAME_MODES.search(rel):
            for name, cls, props in exports(data):
                if name.startswith("Default__"):
                    vals = OrderedDict((k, props[k]) for k in LOOT_COUNTS if k in props)
                    for k in ("SelectedAirDrop", "SpawnPointTags", "GameModeType"):
                        if k in props:
                            vals[k] = props[k]
                    if props.get("mOverridenAirdrops"):
                        vals["mOverridenAirdrops"] = sorted(set(props["mOverridenAirdrops"]))
                    table["gameModes"][base] = vals
        elif AIRDROPS.search(rel):
            pkg = Package(data)
            e = pkg.exports[0]
            props = Tree(pkg).props(e["offset"], e["offset"] + e["size"])
            items = [re.sub(r".*\.", "", clean_item) for clean_item in
                     re.findall(r"/Game/[\w/]+\.\w+", data[e["offset"]:e["offset"] + e["size"]].decode("latin1"))]
            table["airdrops"][e["name"]] = OrderedDict(name=props.get("DisplayName"), itemId=props.get("ItemID"),
                                                       funcCost=props.get("ActivityResourceCost"), items=items)
    # Every item that appears anywhere, with its category and the game's text.
    seen = set()
    for lst in list(table["tiers"].values()) + [l for m in table["maps"].values() for l in m.values()] + \
            [l for c in table["containers"].values() for l in c.values()]:
        seen.update(e["item"] for e in lst if e["item"])
    for kit in table["airdrops"].values():
        seen.update(kit["items"])
    for item in sorted(seen):
        key = item[:-2].lower() if item.endswith("_C") else item.lower()
        text = loc.get(key) or {}
        desc = (text.get("description") or {}).get("en", "") if isinstance(text, dict) else ""
        tier = re.search(r"Tier (\d)", desc)
        table["items"][item] = OrderedDict(name=text.get("en", item) if isinstance(text, dict) else item,
                                           category=category(item), tier=int(tier.group(1)) if tier else None,
                                           description=re.sub(r"<br>|\s+", " ", desc).strip())
    return table


def pct(x):
    return "%.1f%%" % (100 * x)


def doc(table):
    items = table["items"]
    name = lambda i: "nothing" if i is None else "%s (`%s`)" % (items.get(i, {}).get("name", i), i)
    out = ["# Loot table reference", "",
           "Generated by `patch/loot_tables.py` from the game's cooked assets; the same data is in",
           "`patch/loot/loot_tables.json`. Item IDs are the game's item classes. Chance is the entry's",
           "share of its list's total weight (the game picks one entry per spawn, weighted).", ""]
    out += ["## Items by category", "", "| Item | ID | Category | Tier | Description |", "|---|---|---|---|---|"]
    for i, v in sorted(items.items(), key=lambda kv: (kv[1]["category"], kv[0])):
        out.append("| %s | `%s` | %s | %s | %s |" % (v["name"], i, v["category"], v["tier"] or "", v["description"]))
    out += ["", "## Tier lists (tiered pedestals)", ""]
    for tier, lst in table["tiers"].items():
        out += ["### %s" % tier, "", "| Item | Weight | Chance |", "|---|---:|---:|"]
        out += ["| %s | %s | %s |" % (name(e["item"]), e["weight"], pct(e["chance"])) for e in lst]
        out.append("")
    for m, tiers in table["maps"].items():
        out += ["### %s level copies" % m, ""]
        for tier, lst in tiers.items():
            same = [(e["item"], e["weight"]) for e in lst] == [(e["item"], e["weight"]) for e in table["tiers"].get(tier, [])]
            out.append("- %s: %s" % (tier, "same as the default list" if same else
                                     ", ".join("%s %s" % (e["item"], e["weight"]) for e in lst)))
        out.append("")
    out += ["## Containers", ""]
    for c, comps in sorted(table["containers"].items()):
        for comp, lst in comps.items():
            out += ["### %s (%s)" % (c, comp), "", "| Item | Weight | Chance |", "|---|---:|---:|"]
            out += ["| %s | %s | %s |" % (name(e["item"]), e["weight"], pct(e["chance"])) for e in lst]
            out.append("")
    out += ["## Game modes: loot amounts and kits", "", "| Mode | " + " | ".join(LOOT_COUNTS) + " | Airdrop |",
            "|---|" + "---:|" * len(LOOT_COUNTS) + "---|"]
    for gm, v in sorted(table["gameModes"].items()):
        out.append("| %s | %s | %s |" % (gm, " | ".join(str(v.get(k, "")) for k in LOOT_COUNTS), v.get("SelectedAirDrop", "")))
    out += ["", "Blank: inherited from the parent mode or the engine default.", "", "## Airdrop kits", "",
            "| Kit | ID | FUNC | Items |", "|---|---|---:|---|"]
    for a, v in sorted(table["airdrops"].items()):
        out.append("| %s | %s | %s | %s |" % (v["name"], v["itemId"], v["funcCost"] or "", ", ".join(name(i) for i in v["items"])))
    return "\n".join(out) + "\n"


def main(paks):
    table = build(paks)
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", newline="\n") as f:
        json.dump(table, f, indent=1)
    with open(OUT_DOC, "w", newline="\n", encoding="utf-8") as f:
        f.write(doc(table))
    print("%d items, %d tier lists, %d containers, %d game modes, %d kits -> %s" % (
        len(table["items"]), len(table["tiers"]), len(table["containers"]), len(table["gameModes"]),
        len(table["airdrops"]), os.path.relpath(OUT_JSON, HERE)))


if __name__ == "__main__":
    main(sys.argv[1])
