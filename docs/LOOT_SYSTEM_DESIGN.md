# Loot system: audit and design

Status (2026-11-04): audit done; loot tables extracted and tested; Showdown kit, rounds and pre-round HUD built, in-game test pending.

## 1. The missing loot in Showdown (root cause)

Reported: in the Showdown test the bot had gear, the player was stuck with fists.

Nothing failed to spawn. Showdown v1 runs on the game's **Lightning** mode (`VictoryGameMode_Lightning`, see `patch/make_showdown.py`). That mode is built around one airdrop kit per player and no world loot:

| Setting (Lightning defaults) | Value | Effect |
|---|---|---|
| GreenCrates, RedCrates, FuncBarrels, ToiletGoodies | 0 | no crates or barrels |
| Small/Medium/Large/ExtraLarge BuildingItemSpawns | 0 | no items in buildings |
| ChanceOfLockersPreOpened | 100 | every locker already open and empty |
| SelectedAirDrop, mOverridenAirdrops | `AirDrop_zRandom` | each contestant gets a random kit ("Surprise Me!") |
| AirDropStages | at 0, 180, 480, 600 s | the kit arrives at round time 0 |

The kit arrives as a crate that drops at the player and has to be opened (the HUD says "Open Your Airdrop" / "Grab your Airdrop"). Bots receive their kit directly. The Showdown spawn on the west side of the arena (`(-1800, 0, 200)`) is under the arena's ring-shaped roof; the player's clip shows the "Open Your Airdrop" marker above that roof. So the player's kit landed out of reach, and the bot, armed at once, attacked within 4 seconds.

Fixes (in progress): spawns under open sky; one kit for both sides; a pre-round HUD that shows the kit and how to get it.

Normal matches (Solo, Duo, Ranked on Jungle and Prison) use `VictoryGameMode` with its own loot amounts (12 green crates, 15 red barrels, 22 pylons, 5 toilet goodies, building item spawns); none of the Remaster's patches change loot. No missing loot was reported there.

## 2. How the game generates loot (reused, not replaced)

The game already has a data-driven, weighted loot system. All of it is data in the cooked assets:

| Source | Where | What it holds |
|---|---|---|
| Tier lists | `ItemSpawnerItemList_Tier1/2/3` (defaults), with a Tier1 copy in Jungle's Gameplay level | weighted item lists for the tiered pedestals (`SpawnTieredPedestals_v2`, 50/100/200 FUNC) |
| Containers | `ItemSpawnerComponent.ItemList` inside each locker, cabinet, fridge, medicine cabinet, toilet, crate and bunker box Blueprint | weighted lists: item class, weight, min/max ammo; `NULL_C`/None = nothing |
| Crate spawners | `CrateSpawner_*` | which crate or barrel a spawn point places |
| World pickups | `AreaItemSpawner` / `ItemSpawnerComponent` in `Pickups_New` | rocks and branches (crafting) |
| Game mode | `VictoryGameMode*` defaults | how many crates, barrels and building items a match places; which airdrop kits it hands out |
| Airdrop kits | `AirDropPackages/*` | fixed item lists |

`patch/loot_tables.py` reads all of it into one table, `patch/loot/loot_tables.json`, and writes `docs/LOOT_TABLE_REFERENCE.md` (every item ID, category, tier, weight and chance). The JSON is the single place to read and, next, to edit loot; a writer will put edited weights back into the same assets.

Where the spec and the engine differ:

- **The RNG is the game's.** The cooked game picks each spawn's item from its weighted list, on the player's PC. Weights, lists and amounts can be changed; the picking code can't (it is compiled Blueprint/native code).
- **Server-authoritative loot isn't possible yet.** Matches run on each player's PC (Victory.exe can't host: `UWorld::Listen` is compiled out). The Remaster server can choose things before a match (the round, which kit), but not inside it. Tracked in `docs/REMASTER_AUDIT_2026-11-04.md` (C3).
- **Rarity** in the game is the tier list a weapon is in (Tier 1-3 lists, melee Tier 1-4 in the item text) plus its weight. The spec's Common...Legendary weights map onto those lists; they aren't a separate system.

## 3. Equipment rules

- **Body armor:** `BodyArmor_C` has the game's own `bUseIfSpawnedWith = True`: armor you are given (a kit) puts itself on. No other item has the flag, so weapons, injects, Muscle Man Milk, healing and throwables are never used or equipped automatically. Armor picked up from the ground is equipped by using it (native rule, not changeable in the cooked build).
- **Inventory:** the game's own (5 slots with a backpack, 4 with a satchel, 3 without). Nothing is added on top.

## 4. Status

| Spec item | Status |
|---|---|
| Missing loot investigated, root cause | Done (section 1) |
| Central loot table from real item IDs | Done (`patch/loot/loot_tables.json`) |
| Table reference | Done (`docs/LOOT_TABLE_REFERENCE.md`) |
| Weighted-draw and table tests | Done (`patch/test_loot_tables.py`, `docs/LOOT_RNG_TEST_RESULTS.md`) |
| Kit in the inventory at spawn, nothing on the ground | Done for both sides, verified in game |
| Showdown: player can reach the kit | Solved: the kit is spawned into the inventory (no crate) |
| First to 4 rounds, round banner, next-round screen | Built and server-tested (`docs/PRE_ROUND_HUD_DESIGN.md`); not yet run in game |
| Pre-round loadout HUD | Built (`ShowdownHud.js`), checked in a browser; not yet run in game |
| Auto-equip rules | Game's own: armor only (plus Backpack), `docs/INVENTORY_EQUIPMENT_SYSTEM.md` |
| Per-mode loot | `docs/GAME_MODE_LOOT_CONFIGURATION.md` |
| Writer for edited weights | Next |
| Server-authoritative in-match loot, multiplayer inventory | Blocked: no server-capable game binary |
| 2v2-4v4 / Last Breath teams | Blocked: no N-vs-N team mode in the cooked game |
