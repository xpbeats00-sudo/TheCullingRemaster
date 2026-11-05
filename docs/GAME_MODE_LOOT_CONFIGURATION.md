# Loot by game mode

Each mode's loot is set in its game-mode Blueprint (amounts) and in the shared item lists (what can appear). The full table, generated from the game, is in `docs/LOOT_TABLE_REFERENCE.md` ("Game modes" section).

| Mode in the Remaster | Game mode | World loot | Kit |
|---|---|---|---|
| Solo, Ranked (Jungle, Prison) | `VictoryGameMode` | 12 green crates, 15 red barrels, 22 pylons, 5 toilet goodies, building spawns (engine defaults) | your equipped airdrop, called with FUNC |
| Duo | `VictoryGameMode` (pairs) | same | same |
| Showdown 1v1 | `VictoryGameMode_Lightning` (Remaster setup, `make_showdown.py`) | none (all amounts 0, lockers pre-opened) | spawned in the inventory: Tomahawk, Tactical Body Armor (on), Muscle Man Milk; the mode's airdrops are off |
| Custom | `VictoryGameMode` (Solo's mode) with `?mods=` | Solo's, changed by the CUSTOM MATCH SETTINGS screen (below) | as Solo |

## Custom matches

PLAY > CUSTOM > Create opens a lobby of one: you pick the map (Island or Prison) and, under SETTINGS, the stock custom-match settings, then START. The match is played on your PC like Solo. Nobody can join a custom lobby (there is no multiplayer hosting); Join says to invite friends to a party instead.

How it is applied: the server answers START with `custom:<map>:<mods>`, and the menu opens Solo's URL for that map plus `?mods=<index>=<value>|...` (only the settings changed from stock). The game's own `AShooterGameMode::InitGame` reads that option into `GameModeMods`, the array on VictoryGameMode's defaults that the Blueprints read. All 17 settings on the screen take effect:

| # | Setting (screen) | Stock | Range | Read by |
|---|---|---|---|---|
| 0 | Green Crates to Spawn | 12 | 0-200 | level script (Jungle_P / Jungle2_P) |
| 1 | Blue Crates to Spawn | 24 | 0-200 | level script |
| 2 | Red Crates to Spawn | 3 | 0-200 | level script |
| 3 | Red Barrels to Spawn | 15 | 0-200 | level script |
| 4 | Pylons to Spawn | 22 | 0-200 | level script |
| 5 | FUNC Barrels to Spawn | 15 | 0-200 | level script |
| 6 | Toilet Goodies | 5 | 0-200 | level script |
| 7-10 | Small / Medium / Large / Extra Large Building Items Spawns | 2 / 4 / 8 / 12 | 0-200 | MasterLootManager |
| 11 | Chances of Additional Green Crate Spawn (%) | 50 | 0-100 | MasterLootManager |
| 12 | Chances of Lockers Pre Opened (%) | 50 | 0-100 | MasterLootManager |
| 13 | Health Given Amount From Health Stations | 4 | 0-100 | MedStation |
| 14 | FUNC Cost for Health | 1 | 0-100 | MedStation |
| 15 | Frequency of Health Given in Seconds | 1 | 1-60 | MedStation |
| 16 | Recycler Use Time (s) | 5 | 1-60 | FuncRecycler |

Counts above what a map has spawn points for just fill every point. Index 17 (starting activity value) is not on the screen and is never sent. The table is `patch/custom_match.py` (copies in `ClientWeb.js` and `server/custommatch.js`, kept equal by `patch/test_custom_match.py`). Custom results count as their own mode (`modes.custom`) and pay like Solo.

Why not `VictoryGameMode_Custom`: it is VictoryGameMode with `GameModeType=Custom` and an empty `StatsToUpdate`, and inherits the same `GameModeMods`; the settings work the same in either, and Solo's mode is the one already played locally. The stock native settings binder (`CustomMatchController`, the `Increment*` engine calls) is an empty stub in the shipped exe, and the stock page has no game type control (Free For All only).

## Changing Showdown's kit

`patch/make_showdown.py`: `MELEE` (bit 32) and `BOOST` (bit 4) name the item each free bit gives; armor is bit 8 (Tactical Body Armor, the Armorer perk's bit). Rebuild with `python patch/make_showdown.py <Paks dir>`; it rewrites PlayerPawn, the Showdown perk and mode, and `server/data/showdown.json` for the server and HUD. Deploy the server with the release so the HUD lists the right kit.

Only three items can be given this way (the two free bits plus armor). Other bits belong to perks players can pick in normal matches.

## Not available

- 2v2, 3v3, 4v4 and Last Breath team formats: the cooked game has pairs only (`bPairTeams`) and no N-vs-N team mode (`GAME_MODE_INTEGRATION_REPORT.md`).
- Per-mode item lists: the tier and container lists are shared by every mode on a map; modes differ in amounts and kits.
