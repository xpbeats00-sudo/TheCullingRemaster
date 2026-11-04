# Loot by game mode

Each mode's loot is set in its game-mode Blueprint (amounts) and in the shared item lists (what can appear). The full table, generated from the game, is in `docs/LOOT_TABLE_REFERENCE.md` ("Game modes" section).

| Mode in the Remaster | Game mode | World loot | Kit |
|---|---|---|---|
| Solo, Ranked (Jungle, Prison) | `VictoryGameMode` | 12 green crates, 15 red barrels, 22 pylons, 5 toilet goodies, building spawns (engine defaults) | your equipped airdrop, called with FUNC |
| Duo | `VictoryGameMode` (pairs) | same | same |
| Showdown 1v1 | `VictoryGameMode_Lightning` (Remaster setup, `make_showdown.py`) | none (all amounts 0, lockers pre-opened) | spawned in the inventory: Tomahawk, Tactical Body Armor (on), Muscle Man Milk; the mode's airdrops are off |
| Custom | `VictoryGameMode_Custom` | the custom-match mods (`?mods=`) | as Solo |

## Changing Showdown's kit

`patch/make_showdown.py`: `MELEE` (bit 32) and `BOOST` (bit 4) name the item each free bit gives; armor is bit 8 (Tactical Body Armor, the Armorer perk's bit). Rebuild with `python patch/make_showdown.py <Paks dir>`; it rewrites PlayerPawn, the Showdown perk and mode, and `server/data/showdown.json` for the server and HUD. Deploy the server with the release so the HUD lists the right kit.

Only three items can be given this way (the two free bits plus armor). Other bits belong to perks players can pick in normal matches.

## Not available

- 2v2, 3v3, 4v4 and Last Breath team formats: the cooked game has pairs only (`bPairTeams`) and no N-vs-N team mode (`GAME_MODE_INTEGRATION_REPORT.md`).
- Per-mode item lists: the tier and container lists are shared by every mode on a map; modes differ in amounts and kits.
