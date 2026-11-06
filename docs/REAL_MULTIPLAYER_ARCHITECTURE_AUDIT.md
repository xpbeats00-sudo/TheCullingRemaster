# Real multiplayer: architecture audit

**Date:** 2026-11-05. **Release live:** 1.3.12.

**The question:** what does it take for a party to play together in one live match? Today every player plays a separate local match.

**Evidence labels:**
- **[C]** read from code, the shipped exe or assets;
- **[T]** an automated test;
- **[G]** seen in a running game;
- **[I]** inferred.

Companion documents:
- `MULTIPLAYER_NETPLAY_FEASIBILITY.md`: the first investigation;
- `NETPLAY_LISTEN_SERVER.md`: the listen-server prototype;
- `DEDICATED_SERVER_IMPLEMENTATION.md` and `SHARED_WORLD_REPLICATION_AUDIT.md`: the host work, being written on branch `netplay-host`;
- `RECENT_PLAYERS_SYSTEM.md` and `JOIN_FRIENDS_AND_PARTY_DESIGN.md`: being written on branch `recent-players`.

## 1. Summary

| Question | Answer |
|---|---|
| Is there a dedicated server build of this game? | **No, not one we have.** No `VictoryServer` / WindowsServer binary is on this PC, in the install, or in the paks [C]. SteamDB lists only client depots for The Culling (app 437220, retired) and the Day 1 Reference (468220). No public server tool exists. The Func project (the mod this launcher uses) runs online matches, so it very likely has one [I]. |
| Can this client host a match? | **Not as shipped.** The server code was compiled out of the WindowsClient build. `UWorld::Listen` is a `return false` stub, and the replication send loop (`ServerReplicateActors` and its helpers) is gone [C]. The network layer is intact: sockets, the packet handler and the stateless handshake. Making the client a host means rebuilding the missing pieces natively (route B). |
| Can this client join a real server? | **Yes, the path is there.** The stock menu code still connects to a server when the Remaster server answers with an address: `engine.call("ConnectToServer", gameServer, nonce, serverNonce)` (ClientWeb.js, the last branch of `match-ready`) [C]. `UPendingNetGame` / `ConnectToServer` (0x1401dce90) is in the exe [C]. The game mode parses `?servernonce` (0x140233e59) [C]. |
| Why does a party get separate matches today? | Every `match-ready` answer is a local match URL. Each PC opens its own world with its own bots and posts its own result (section 2). |

**The shortest technically valid paths to two PCs in one match:**

| Route | What | Effort | Blocker |
|---|---|---|---|
| **A** | A matching UE 4.15.3 server build (Func's, or one from the rights holder) runs on the VPS. The client joins it through the existing `ConnectToServer` path. | Days to a few weeks once the binary exists: matchmaking, allocation and tickets (section 4) | **Getting the binary.** Only you can ask (Func maintainers or the rights holder). |
| **B** | The patched client hosts (`?listen`, then headless with `-nullrhi` on the VPS as a de facto dedicated server). Others join it. | About 3–4 months. Most of it is rebuilding the replication send loop (about 1,000–1,500 lines of engine code) natively, with no source | Engineering time. In progress (milestone 1: host and handshake). |

Both routes share everything outside the game binary: party matchmaking, server allocation, tickets, results and Recent Players. That part is being built now, so whichever route lands, the backend is ready.

## 2. Why a party gets separate local matches (every place)

| Where | What happens [C] |
|---|---|
| `server/server.js` `launchMatch()` | Builds one `matchId` (`newMatchId`) and one lobby or party record, then sends **each** member a `match-ready` with a local answer: `offline:<map>`, `duo:<map>`, `trio:`/`quad:<map>`, `map:<...>` (night and weather), `showdown:<format>` or `custom:<...>`. Its comment says so: "Each player's match still runs on their own PC with AI contestants ... netplay is false." The payload carries `netplay: false`. |
| `server/playlists.js` header | "dedicated game server and no netplay": every playlist is local. |
| `ClientWeb.js` `match-ready` handler | `offline:` → `engine.call("StartOfflineMatch", map)`. `duo:`, `trio:`, `quad:`, `map:`, `showdown:` and `custom:` → `engine.call("StartTraining", url)`. Both open a **local** world on this PC. Only an answer with none of those prefixes reaches `ConnectToServer`. |
| `patch_exe.py` fix 3 | StartTraining opens a URL in place of a slot name, which is how every Remaster mode starts locally. |
| Native module `sd_spawn_bots` / the stock spawner (0x1402320f0) | The local GameMode spawns every other contestant as a bot: rivals, and the "teammates" in Duo/Trios/Quads. |
| Fix 4 stub and `sd_teams` | The local GameState pairs the player with bots by PlayerArray index. The party's friends are never in it. |
| `hud.js` `LocalMatchResultBody` → `POST /api/matchresult` | Each PC posts its own result. The server matches it to that player's ticket. Ranked team matches rate each member on their own local team's placement. |

**So the shared `matchId` is only a shared record.** It links the party's separate results; it isn't a shared world.

## 3. What a real match needs, by layer

| Layer | Today | Needed | Status |
|---|---|---|---|
| Accounts and auth | Remaster accounts and session tokens. The HUD's result is matched by ticket and address. | The same, plus a **match connection ticket** the game server checks when a player logs in (the UE `PreLogin` options; the game already parses `?servernonce`). | Backend can be built now. |
| Party | One leader, members follow into one lobby. Tested by `party.test.js` and `friends.test.js`. | Unchanged. The party must land on **one team on one server**. | Done (lobby level). |
| Matchmaking | Lobbies per queue and map, filled by people. Each person gets a local match. | A lobby launches **one** match on **one** allocated server and sends every member the same address. | Design: `PARTY_MATCHMAKING_REWORK.md`. |
| Server allocator | None. | Picks a free game-server process on the VPS, starts it with the map, mode and match id, tracks its heartbeat, frees it at the end, recovers from crashes. | Can be built against a stand-in; needs route A or B to run for real. |
| Game server | None (route A binary missing; route B in progress). | Authoritative world, spawning, combat, loot, gas, bots, teams, results. | **BLOCKED** on route A or B. |
| Client join | The `ConnectToServer` path is intact in the menu and the exe. | The same, given an address and nonces. | Exists [C], NOT TESTED against a server. |
| Results | Each client posts its own. | The **server** posts the authoritative result for every player. Clients' posts are ignored for shared matches. | Backend can be built now. |
| Recent Players | None. | Recorded from server-confirmed participants. | Being built (branch `recent-players`), from lobby co-members until shared matches exist. |

## 4. The backend the shared match plugs into (route-independent)

1. **Queue:** a party queues as one unit, as today. The team size is checked against the party.
2. **Match:** the lobby fills (people, then bot slots). One `matchId`. The party is one team; every team is assigned by the backend.
3. **Allocate:** the allocator starts or reserves a game-server process with `map`, `mode`, `matchId`, the team layout and the bot count. It waits for the server's ready heartbeat, with a timeout. On failure the lobby is told and re-queued, never left hanging.
4. **Tickets:** each player gets a one-use connection ticket (HMAC over `matchId`, `userId`, team, expiry). `match-ready` carries `gameServer: "<host>:<port>"`, `nonce` and `serverNonce`, so the existing menu branch calls `ConnectToServer`, plus `netplay: true`.
5. **Join:** the game server validates the ticket in PreLogin (from the URL options), puts the player on the assigned team, and refuses anyone else.
6. **Play:** the server owns the world and the bots.
7. **Result:** the server posts one signed result for the whole match (each player's placement, kills, team outcome). The backend pays and rates from it. Client posts for a shared match are ignored.
8. **End:** players return to the menu (the stock post-match flow); the server process is freed.

Steps 1–4 and 7 are server code and can be written and unit-tested now against a stand-in game server. Steps 5–6 need the game server.

## 5. Capacity on the VPS (planning numbers, not measured)

The planned target is 10 people and about 20 bots on the Windows Server VPS. It **can't be measured until a game server exists**. The client's own per-match cost on a gaming PC isn't a server's cost: a headless server has no rendering (`-nullrhi`), but the AI, physics and replication run on its CPU. The deployment guide gets the measurements (CPU, memory, bandwidth per player, tick rate) once route A or B runs.

## 6. Acceptance gates (status today)

| Gate | Status | Why |
|---|---|---|
| MP1 Two PCs authenticate | PASS (existing) | Accounts and login work for any number of players [T and live use]. |
| MP2 Friends create and join parties | PASS (existing) | `party.test.js`, `friends.test.js` [T]; used live. |
| MP3 Party queue stays grouped | PASS (lobby level) | `party.test.js`: one lobby, one match id [T]. |
| MP4 One shared match allocated | NOT TESTED | No allocator yet. |
| MP5 Both clients connect to one server | BLOCKED | No game server (route A missing; route B in progress). |
| MP6–MP12 One live world, see each other, same team, combat, loot, bots, authoritative results | BLOCKED | Same. |
| MP13 Recent Players recorded | In progress | Branch `recent-players`. |
| MP14 Recent Players invite each other | In progress | Same. |
| MP15 Join permissions and privacy | In progress | Same. |
| MP16 Ranked results from one shared match | BLOCKED | Needs a shared match. |
| MP17 Reconnect and recovery | PARTIAL | Party and lobby reconnects are tested [T]; in-match reconnect needs a server. |

## 7. Decision needed from you

**Route A is the only short path:** a matching UE 4.15.3 dedicated server build. The Func project runs online Culling matches, so ask its maintainers whether they can share a server build, or how they host. Alternatively, ask the rights holder.

Without it, route B continues: about 3–4 months, with the host-and-handshake milestone under way now.
