# Loot and Showdown test results (2026-11-04)

## Automated

| Suite | Command | Result |
|---|---|---|
| Loot tables | `python patch/test_loot_tables.py` | 6/6 pass |
| Showdown series and server | `node server/test/showdown.test.js` | 11/11 pass |
| All server tests | each `server/test/*.test.js` | 14/14 files pass |

Loot tables (`test_loot_tables.py`):
- 75 items in 25 weighted lists and 44 kits; every entry is a known item with a category.
- Every requested category has items: melee 28, ranged 9, throwables 9, injects 7, traps 6, utility 3, healing 2, armor 2, Muscle Man Milk 1.
- 200,000 weighted draws per list match the stated chances within 1 point. The largest difference is 0.20 points (Hemo Drip in the medicine cabinet).
- A list with no weight fails safely.
- The Showdown kit marks only armor as auto-equip.

What these tests cover: the table data and the weighted-pick arithmetic. The game's own random generator is compiled code and isn't exercised.

Showdown (`showdown.test.js`):
- first to 4 and at most 7 rounds; 4 losses is a defeat;
- a quit round is lost; no double counting; leaving is a forfeit; idle series expire;
- the queue skips the lobby and carries the kit;
- the HUD sees the round in a Showdown match and nothing in a normal one;
- the menu gets the next round; VICTORY at 4 wins; at most 1 kill per round.

## In game (through the launcher)

| Check | Result |
|---|---|
| SHOWDOWN tile starts the arena match | Pass (test patch): one bot, both spawned in the arena |
| Player gets a kit | **Fail** with the airdrop kit (crate out of reach). **Pass** after the change: spawned holding Muscle Man Milk (slot 1), Tomahawk (slot 2, in hand), armor on; no crate |
| Bot gets the same kit | Unconfirmed: one run the bot dealt a bleed wound and killed fast; another it didn't engage |
| No airdrops | Pass: none arrived |
| Pre-round panel, round banner, next-round screen | Not run yet (needs the server update) |
| Multiplayer sync | Not possible: no server-capable game binary |

## Performance

The HUD panel is plain HTML with 3-5 images, shown for 14 s; it isn't profiled in game. The series is an in-memory map per player on the server.
