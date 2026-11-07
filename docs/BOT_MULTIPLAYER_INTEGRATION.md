# Bots in shared matches

**Date:** 2026-11-05. **Branch:** `shared-match-backend`.
**Companion:** `PARTY_MATCHMAKING_REWORK.md` (the backend), `REAL_MULTIPLAYER_ARCHITECTURE_AUDIT.md` (routes A and B).

**Labels:**
- **PASS**: an automated test.
- **[C]**: read from code.
- **NOT TESTED**: written, not checked.
- **BLOCKED**: needs a real game server, which doesn't exist yet.

## 1. The rule

**Bots live on the game server.** In a shared match the backend never spawns, moves or scores a bot. It only says how many contestants are players, which team each player is on, and how many bot slots each team has. The game server's GameMode spawns the bots, as the local GameMode does today, and its result reports only the players.

## 2. What the bots do today (local matches) [C]

Every Remaster match today runs on the player's own PC. The local GameMode spawns every other contestant as a bot.

| Piece | What it does |
|---|---|
| Stock spawner (VA `0x1402320f0`), called at match start from VA `0x14023330d` | Spawns `BotsToSpawn` (GameMode `+0x518`) bots. Stock caps players plus bots at 16 (`patch_exe.py` fix 1 raised it to 24). |
| `patch/showdown_rounds.c` `sd_spawn_bots(gm)` (replaces that call) | Caps `BotsToSpawn` so each contestant has a start of its own. The cap is the mode's free starts: PlayerStarts tagged with the mode's SpawnPointTags, 16 pods on Jungle and Prison. In Trios and Quads it takes whole teams (`cap -= cap % size`), so Trios has 15 contestants. Then it subtracts the players (it counts the PlayerControllers in the world). So: 15 bots in Solo, Duos and Quads with one player, and 14 in Trios. Team Showdown sets it to 2N - 1 first (Showdown is paused; unchanged). |
| `patch_assets.py`: BasicBot `SpawnsWithWeapons` off | Bots start with **only their fists**. They used to spawn with a shuffled melee, ranged and utility weapon. Its five child classes keep the stock value, so Survival, Tutorial and clone bots keep their loadouts. |
| Fix 4 stub and `sd_teams` | Pair the player with bots by PlayerArray index: in Duos, Trios and Quads the player's "teammates" are bots. |
| Lobby view (`server.js` lobby options `matchBots`, `matchBotsByMap`) | The pregame roster's bot count for each player's own match (15). |

Because each PC runs its own world, a party's members each play with their own bots and never meet. That is why shared matches exist.

## 3. What the backend tells a game server

The assignment, in the answer to the server's `register` and `heartbeat` (`PARTY_MATCHMAKING_REWORK.md` section 4.3), carries everything the server needs to place bots:

| Field | Meaning | Example (a party of 2 in Duos on Jungle) |
|---|---|---|
| `field` | contestants in the match: the map's pods, whole teams only | 16 (Trios: 15) |
| `teamSize`, `teamsCount` | team size and number of teams | 2, 8 |
| `players` | players sent in | 2 |
| `bots` | total bot slots: `field - players` | 14 |
| `teams[i].players` | who is on team `i` (userID, username, party) | team 1: both party members |
| `teams[i].bots` | bot slots on team `i`: `teamSize - players on it` | team 1: 0; teams 2–8: 2 each |
| `matchUrl` | the local URL of the same mode and map (`duo:0`, `trio:1`, `offline:0`) | `duo:0` |
| `startsWithFists` | bots (and players) start with only their fists, as today | `true` |

Rules the backend guarantees [PASS: `sharedmatch.test.js`]:
- A party is one team, never split.
- Solos and smaller parties fill other teams.
- A team with no players is all bots.
- The sum of every team's `bots` equals `bots`.
- `players + bots = field`.
- A player dropped before the start (a party member gone) is removed from the assignment, and their slot becomes a bot slot on the next heartbeat.

Checked layouts [PASS]:

| Match | `field` | `teamsCount` | `players` | `bots` |
|---|---|---|---|---|
| Party of 2 in Duos | 16 | 8 | 2 | 14 (team 1: 0) |
| Three parties of 2 plus two solos in Duos | 16 | 8 | 8 | 8 |
| Party of 2 plus a solo in Trios | 15 | 5 | 3 | 12 |
| One player in Solo | 16 | 16 | 1 | 15 |

## 4. What changes when the match is on a server

| Topic | Local today | On a game server | Status |
|---|---|---|---|
| Who spawns bots | the player's PC | the server's GameMode only; clients spawn none | BLOCKED |
| How many | `sd_spawn_bots`: free starts minus PlayerControllers | The same cap, but the server must count the **expected players** (`assignment.players`), not the PlayerControllers connected at the moment it spawns: players join over several seconds. Otherwise the first player in would get 15 bots and later joiners would have no pod. The server should spawn bots once its join window closes, or reserve `players` starts at match start. | BLOCKED (native change on the server side, route-dependent) |
| Bot teams | fix 4 / `sd_teams` pair the player with bots by PlayerArray index | Teams come from the assignment: a player's team is `teams[i].team` (also returned by `verify-ticket` as `team`). A team's empty slots are filled with bots set to that TeamNumber, and all-bot teams get their own TeamNumbers. Index pairing must not run on a server. | BLOCKED |
| Bot loadout | fists only (`SpawnsWithWeapons` off) | the same asset patch: the server loads the same paks | BLOCKED (the pak must be on the server) |
| A no-show (ticket never used) | n/a | Their slot becomes a bot when the join window closes (route-dependent). The backend counts them as a no-show from the result (`joined: false`, or left out): no pay, ranked last. | backend PASS; server BLOCKED |
| A player dropped before the start | n/a | The heartbeat's assignment no longer lists them, and their team's `bots` goes up by one | backend PASS ("queue cancel, leader disconnect...": a party leaves while the server starts, and the server's assignment drops to 1 player plus 15 bots); server BLOCKED |
| Bots in the result | the HUD posts the player's own result | The server reports only players. Team placements include all-bot teams (placement among all `teamsCount` teams). Kills of bots count as kills. | backend PASS |
| AI cost | one PC, one world | all AI on the server's CPU (`-nullrhi` saves rendering, not AI) | to measure: `REAL_MULTIPLAYER_DEPLOYMENT_GUIDE.md` |

### Route A (a dedicated server build)

The stock dedicated server has its own GameMode and bot spawner. Whether it honours a bot count from the URL is unknown until the binary exists. The plan:
- open `matchUrl`'s map and mode with `?MaxBots=<bots>`, or whatever option it reads;
- apply the team layout from `verify-ticket` at PostLogin.

BLOCKED (no binary).

### Route B (the patched client as host, headless on the VPS)

The native module already has the bot cap and the team code. They need a server mode:
- count `assignment.players` instead of local PlayerControllers;
- set each joining player's TeamNumber from the backend's `team`;
- give each empty slot a bot with that team's TeamNumber;
- skip index pairing.

That is native work on branch `netplay-host`, not done here (this branch doesn't touch `patch/`). BLOCKED.

## 5. Not covered here

- Bot difficulty, names and skins on a server: unchanged, whatever the server's GameMode does.
- Bot replication cost: part of the capacity plan (deployment guide).
- Showdown (paused): its bots (2N - 1 in the arena) stay as they are, local only.
