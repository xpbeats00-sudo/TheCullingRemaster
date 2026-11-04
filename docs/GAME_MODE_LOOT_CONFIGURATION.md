# Loot by game mode

Each mode's loot is set in its game-mode Blueprint (amounts) and in the shared item lists (what can appear). The full table, generated from the game, is in `docs/LOOT_TABLE_REFERENCE.md` ("Game modes" section).

| Mode in the Remaster | Game mode | World loot | Kit |
|---|---|---|---|
| Solo, Ranked (Jungle, Prison) | `VictoryGameMode` | 12 green crates, 15 red barrels, 22 pylons, 5 toilet goodies, building spawns (engine defaults) | your equipped airdrop, called with FUNC |
| Duo | `VictoryGameMode` (pairs) | same | same |
| Showdown 1v1 | `VictoryGameMode_Lightning` (Remaster setup, `make_showdown.py`) | none (all amounts 0, lockers pre-opened) | the same kit for both sides at round time 0; no later drops |
| Custom | `VictoryGameMode_Custom` | the custom-match mods (`?mods=`) | as Solo |

## Changing Showdown's kit

`patch/make_showdown.py`: `KIT` names an airdrop package from `patch/loot/loot_tables.json` "airdrops" (for example `Airdrop_Cyclops`, `Airdrop_Polecat`, `Airdrop_Survivalist`). Rebuild:

```
python patch/loot_tables.py <Paks dir>
python patch/make_showdown.py <Paks dir>
```

`make_showdown.py` rewrites the Lightning mode's kit references, and `server/data/showdown.json` for the server and HUD. Deploy the server with the release so the HUD shows the right kit.

The kit is fixed per release. Matches run on the player's PC from the shipped assets, so the server can't pick a different kit per round for both sides (the bot's kit comes from the mode's assets).

## Not available

- 2v2, 3v3, 4v4 and Last Breath team formats: the cooked game has pairs only (`bPairTeams`) and no N-vs-N team mode (`GAME_MODE_INTEGRATION_REPORT.md`).
- Per-mode item lists: the tier and container lists are shared by every mode on a map; modes differ in amounts and kits.
