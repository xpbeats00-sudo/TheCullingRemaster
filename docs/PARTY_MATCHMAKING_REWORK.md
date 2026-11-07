# Party matchmaking rework: shared matches on a game server

**Date:** 2026-11-05. **Branch:** `shared-match-backend` (from `multiplayer-plan`).
**Spec:** `REAL_MULTIPLAYER_ARCHITECTURE_AUDIT.md`, section 4.

**Status labels:**
- **PASS**: an automated test shows it; the test is named.
- **NOT TESTED**: written, but nothing checks it yet.
- **BLOCKED**: needs a real game server (route A: a matching dedicated server build; route B: the patched client as host). Neither exists yet. Every PASS below is against the stand-in game server `server/test/fake_gameserver.js`.

**Scope:** Solo, Duos, Trios, Quads and their Ranked playlists. Showdown is paused until real dedicated servers work. It is never shared, even when listed in the allow list, and its code paths are unchanged.

## 1. Summary

The backend can now send a lobby to **one** match on **one** game server. Every member gets the same `gameServer: "host:port"` and their own one-use connection ticket. The game server checks each ticket at PreLogin and posts one signed result. Everyone is paid and rated from that result.

The whole feature is **off by default** (`CULLING_SHARED_MATCHES` unset). With it off, every match is the local match as today: the same answers, the same payloads, the same tickets, and no game-server API [PASS: `sharedmatch.test.js` "setting off"; the 28 existing test files pass unchanged].

| Part | File | Status |
|---|---|---|
| Allocator: pool or launch command, reserve, ready timeout, heartbeats, crash, capacity, structured log | `server/allocator.js` | PASS against the stand-in; BLOCKED for a real server |
| Connection tickets (HMAC, one use, short-lived) and the verify endpoint | `server/connticket.js`, `sharedmatch.js` | PASS (unit and through the stand-in) |
| Shared launch: one allocation per lobby, the same address, a party is one team, bots fill the rest | `server/sharedmatch.js`, hooks in `server.js` | PASS against the stand-in |
| Authoritative results: one signed result pays and rates everyone; the client's post is ignored | `sharedmatch.js`, `server/sharedresults.js` | PASS against the stand-in |
| Lobbies sized by whole teams | `server/matchlobby.js` (`fits` option) | PASS |
| Stand-in game server | `server/test/fake_gameserver.js` | Used by every integration test |
| A real client joining a real server through `ConnectToServer` | the menu and the exe | **BLOCKED** |

## 2. The flow

1. **Queue.** A party queues as one, as today (`join-mm` from the leader). For a shared playlist, a party larger than the team is refused (`party-too-large`). In Solo that is any party: every player is on their own, and the party would be split. [PASS: "Solo (shared)" and "Trios" tests]
2. **Lobby.** The lobby holds one match: 16 contestants (Trios 15). A party joins only a lobby where its whole team still fits beside the others. Otherwise the lobby starts and the party opens the next one (`MatchLobbies` option `fits`). [PASS: the "lobbies (fits option)" test]
3. **Teams.** When the countdown ends, every party becomes one team and is never split. Solos and smaller parties fill the other teams: the largest group first, each into the first team with room. Teams with no players are all bots. Bots fill the field: `field - players`. [PASS: the "teams" unit test and "three parties and two solos"]
4. **Allocate.** The allocator reserves one game server for the lobby, with the map, mode, match id, team layout and bot count (the *assignment*, section 4.3). Members get `remaster-shared-match {state: "allocating"}`. The server must post `ready` within `CULLING_GAMESERVER_READY_TIMEOUT_MS`. [PASS against the stand-in]
5. **Tickets and match-ready.** On `ready`, each member still here gets a ticket and a `match-ready` with the shared fields (section 3.1). A party with a member gone since the countdown isn't sent: it's all or nothing, as today. [PASS: the "a party of 2 in Duos" test]
6. **Join (PreLogin).** The client calls `ConnectToServer(gameServer, nonce, serverNonce)` (`ClientWeb.js`, the last branch of `match-ready`). The stock game opens `<gameServer>?Nonce=<nonce>` and keeps `serverNonce` (Victory.exe 0x1401dce90). The server reads the ticket from `?Nonce=` at PreLogin, asks the backend `verify-ticket` and puts the player on their assigned team; anyone else is refused. The server is started with `?servernonce=<the assignment's serverNonce>` and sends it to each client (`ClientCheckServerNonce`); a client whose stored one differs disconnects with `ServerNonceFailed`. [PASS in game: two real menus joined a route-B host this way, `netplay_run.py --menu` on branch netplay-host]
7. **Play.** The game server owns the world, the bots and the teams. [**BLOCKED**]
8. **Result.** The server posts one signed `result` for every player. The backend pays XP and credits (the local match's economy), updates stats and per-mode stats, and finishes each player's ranked match. Members get `remaster-shared-match {state: "finished", result}`. The client HUD's `/api/matchresult` for a shared match is answered `202 {ignored: true}` and logged. [PASS]
9. **End.** The slot is freed, every ticket of the match is revoked, and the players are back in the menu.

## 3. Socket messages (menu ↔ backend)

### 3.1 `match-ready` (backend → menu)

For a local match (sharing off, or a playlist not allowed) the message is **unchanged**: `{gameServer: "duo:0" | "offline:0" | ..., nonce, serverNonce (random), matchId, lobbyId, partyId, playlist, ranked, netplay: false}`.

For a shared match:

| Field | Value |
|---|---|
| `gameServer` | `"<host>:<port>"` of the game server. It has none of the local prefixes, so the menu calls `ConnectToServer`. Everyone in the match gets the same one. |
| `nonce` | the connection ticket (section 5): the stock client sends it as `?Nonce=` |
| `serverNonce` | the match's server nonce (32 hex), the same for everyone in the match and in the assignment: the client checks the server with it |
| `ticketId` | the ticket's id (hex) |
| `matchId`, `lobbyId`, `partyId`, `playlist`, `ranked` | as today |
| `team` | the player's team number (1..teams) |
| `ticketExpiresInMs` | how long the ticket is good for |
| `netplay` | `true` |

### 3.2 `remaster-shared-match` (backend → menu; new)

| `state` | When | Other fields |
|---|---|---|
| `allocating` | the lobby's countdown ended; a server is being set up | `matchId, playlist, team` |
| `requeued` | allocation failed; the group is searching again | `reason, message, playlist` |
| `cancelled` | the match had started and was lost (crash, silence, timeout, abort) | `matchId, reason, message, playlist, requeued` |
| `finished` | the game server's result was paid | `matchId, playlist, result: {placement, teamPlacement, victory, kills, damage, timeAlive, startXP, xpEarned, credits, ranked: {entry, summary} \| null}`; a no-show gets `{noShow: true, xpEarned: 0, credits: 0}` |

A player whose menu isn't connected gets `cancelled` and `finished` when they next log in (at most 5 kept per player, in memory).

The stock menu ignores this event: nothing in `ClientWeb.js` handles it yet. Showing it is menu work, not done here (NOT TESTED in a menu).

### 3.3 Existing messages, in shared matches

| Message | Shared-match use |
|---|---|
| `join-mm-fail {reason: "allocation-failed", message, playlist}` | no server after the last re-queue; a party member gone before the start |
| `join-mm-fail {reason: "party-too-large"}` | a party bigger than the team, or any party in a shared Solo |
| `join-mm-fail {reason: "match-starting"}` | queueing again while your match is being set up (duplicate queue) |
| `leave-mm` → `leave-mm-ack` | while allocating: your group leaves the match; the others go on with bots in your slots |
| `leave-mm-group {reason: "party-member-cancelled" \| "party-member-disconnected"}` | to the rest of the party when one member cancels or disconnects while allocating |
| `join-mm-ack`, `join-mm-group`, `remaster-lobby` | as today, also after a re-queue |

## 4. Game-server API (game server → backend)

`POST /api/gameserver/<action>`, where the action is `register`, `heartbeat`, `ready`, `abort`, `verify-ticket`, `ticket-used` or `result`. The routes exist only when shared matches are on. With them off, the URL is an unknown one, as today (`200 {}`, nothing done).

### 4.1 Authentication (every request)

| Header | Value |
|---|---|
| `Content-Type` | `text/plain`: the body is JSON sent as text, so the signature is checked over the exact bytes. A JSON-typed body is refused (`body-must-be-text`). |
| `X-Culling-Server` | the server id (a pool entry's id, or the id the allocator gave a launched process) |
| `X-Culling-Timestamp` | ms since epoch; within `CULLING_GAMESERVER_CLOCK_SKEW_MS` of the backend's clock |
| `X-Culling-Signature` | hex `HMAC-SHA256(serverSecret, "<timestamp>.<action>.<body>")` |

The per-server secret is `HMAC-SHA256(master, "gameserver:" + serverId)`. Print it with `node server/allocator.js secret <serverId> [dataDir]`. Each process holds only its own secret: one server can't speak for another. Every signature is accepted once (replay refused). `body.serverId`, if given, must match the header.

Refusals: `401 {error}`, where error is one of `unknown-server`, `body-must-be-text`, `stale-request`, `bad-signature`, `replayed`, `invalid-json` or `server-mismatch`. [PASS: the "game-server API" test, including a signature made for another action and another server's secret]

### 4.2 Actions

| Action | Body | Answer |
|---|---|---|
| `register` | `{serverId, host, port, version}` | `{ok, heartbeatMs, assignment \| null}`. A pool server registering while it had a match restarted: that match is lost (`server-restarted`). |
| `heartbeat` | `{serverId, matchId \| null, state, players, bots, cpu, memMB, tickMs, tickRate, kbpsOut, kbpsIn}` (numbers optional; kept for capacity measurement) | `{ok, heartbeatMs, assignment \| null, cancel}`. `assignment` is the match to run (pull model: the backend never connects to a game server). `cancel` names a match the server reports that is no longer its own. A running server reporting another match, or none, has dropped its match (`server-dropped-match`). |
| `ready` | `{serverId, matchId}` | `{ok, assignment}`. The map is loaded and players can join. Players are sent in now; the answer's assignment already has their `tickets` (below), so the server can let them in before its next heartbeat. |
| `abort` | `{serverId, matchId, reason}` | `{ok}`. The server can't run the match. It is cancelled (`server-aborted:<reason>`). |
| `verify-ticket` | `{serverId, matchId, ticket, userID?}` | `200 {ok, userID, username, team, party}` or `403 {ok: false, error}`. Errors: `match-not-running`, `malformed`, `bad-signature`, `expired`, `used`, `revoked`, `wrong-match`, `wrong-server`, `wrong-user`, `not-in-match`, `already-joined` (the player is in already; the joined flag survives a backend restart). A passing ticket is used up. The route-B host doesn't use it (a round trip at PreLogin blocks the game thread): it checks tickets by hash, then confirms with `ticket-used`. |
| `ticket-used` | `{serverId, matchId, hash, userID?}` | The server let a player in by its ticket's SHA-256 (from the assignment's `tickets`). `200 {ok, userID, username, team, party}`: the ticket is used up here too and the player counts as joined; `403 {ok: false, error}`: `match-not-running`, `malformed`, `not-in-match`, `wrong-user`, `used`, `expired`. |
| `result` | section 4.4 | `200 {ok, paid, noShow: [userID], ignored: [userID]}`, `400 {error}` (malformed, nothing paid), `409 {error: "already-reported" \| "match-not-running"}` |

### 4.3 The assignment (what a game server is told)

Once the match runs, the assignment also has `tickets`: one per player sent in, `{id, hash, userID, team, expiresInMs, used}`, `hash` the SHA-256 (hex) of the player's ticket. Never the tickets themselves (they go only to their players).

```json
{ "matchId": "9f2c...", "playlist": "coop2", "map": "jungle", "mapIndex": 0, "matchUrl": "duo:0",
  "teamSize": 2, "teamsCount": 8, "field": 16, "ranked": false, "players": 2, "bots": 14,
  "teams": [ { "team": 1, "players": [ { "userID": "acct:...", "username": "Lead Wolf", "party": "p-..." },
                                        { "userID": "acct:...", "username": "Member Fox", "party": "p-..." } ], "bots": 0 },
             { "team": 2, "players": [], "bots": 2 }, "..." ],
  "ticketTtlMs": 120000, "startsWithFists": true, "serverNonce": "a8414faf075cae8e81f075e281e9394c" }
```

`serverNonce` is the match's server nonce: start the game server with `?servernonce=<it>` so the clients' check passes. `matchUrl` is the local answer for the same mode and map (`duo:0`, `trio:1`, `offline:0`, ...): the URL a route-B host opens. `bots` per team plus the empty teams add up to the total `bots`. Players dropped before the start (a party member gone) are left out, and their slots become bots. See `BOT_MULTIPLAYER_INTEGRATION.md`. [PASS: the assignment is checked in "a party of 2 in Duos", "three parties", "Trios" and "Solo (shared)"]

### 4.4 The result (one per match)

```json
{ "serverId": "gs1", "matchId": "9f2c...", "duration": 1260,
  "players": [ { "userID": "acct:...", "team": 1, "placement": 1, "kills": 3, "damage": 200, "timeAlive": 1250, "joined": true } ],
  "teams": [ { "team": 1, "placement": 1, "outcome": "won" }, { "team": 2, "placement": 2, "outcome": "out" } ] }
```

Checks:
- `players` is an array of at most 64.
- `placement` must be within 1..field.
- `teams` is required for team modes. `team` and `placement` must be within 1..teams, and only one team can be first (in Solo, only one player).

Values are bounded:
- kills at most `field - teamSize`;
- damage at most 5,000;
- time alive at most the time since `ready` plus 30 s.

How each player is counted:
- A player not in the match is ignored and listed.
- A roster player missing, or `joined: false`, is a **no-show**: no pay, and a ranked match counts as last place, as an abandoned local match does.
- A reported team that differs from the assigned one is logged; the assigned team counts.

Pay is the local match's economy (`matchXP`, `matchCredits`):
- victory is team placement 1 (player placement 1 in Solo);
- profile stats, `modes[playlist]` and `lastMatch` (`shared: true`, `matchId`, placements) are updated.

Ranked:
- Team modes are rated on the team's placement among the match's teams (8 Duos, 5 Trios, 4 Quads on 16 pods), Ranked Solo on the player's placement among 16.
- The entry gets `shared: true`, plus `noShow` and `teamOutcome` when they apply.

[PASS: "one authoritative result pays and rates both", "Ranked Duos", "tickets at the game server" (no-show), "a match's result from another server is refused; a malformed result changes nothing"]

## 5. Connection tickets

The ticket is `v1.<base64url(claims)>.<base64url(HMAC-SHA256(ticketSecret, "v1." + claims))>`, with claims `{m: matchId, u: userID, t: team, s: serverId, e: expiresAt, j: ticketId}`. Every character is in `[A-Za-z0-9._-]`, so it is safe in UE URL options (no `?`, `=`, `#` or space).

| Property | How | Status |
|---|---|---|
| Signed | HMAC; any changed claim fails (`bad-signature`) | PASS (unit: a changed team, another secret) |
| Short-lived | `e` = issue + `CULLING_TICKET_TTL_MS` (default 120 s) | PASS (unit, fake clock) |
| One use | the ticket id is kept until expiry; a second use is `used` | PASS (unit and through the stand-in) |
| For that player | `verify-ticket` with `userID` refuses another player's ticket (`wrong-user`) | PASS |
| For that match and server | `wrong-match`, `wrong-server`, `match-not-running` | PASS |
| Dead with its match | cancel or result revokes every ticket of the match (`revoked`) | PASS |

The game server never needs the ticket secret: it asks the backend.

How the stock client carries it (read from Victory.exe, then seen in game): `ConnectToServer` runs the console command `open <gameServer>?Nonce=<nonce>`, so the ticket is the `nonce` field; `serverNonce` is kept in the game singleton and compared with the server's own in `ClientCheckServerNonce`. The audit's guess (`?servernonce=` from the client, [C]) was wrong: that option is the server's, on its own URL.

## 6. Failure handling

| Case | What happens | Status |
|---|---|---|
| No game server configured (on, but no pool or command) | `applies()` is false: the playlist stays local; logged at start | PASS (by construction; logged) |
| No free server / capacity reached (`CULLING_GAMESERVER_MAX`) | `allocation-failed` → each group re-queued (`remaster-shared-match requeued`, then the normal lobby flow), at most `CULLING_SHARED_REQUEUE_MAX` times, then `join-mm-fail allocation-failed` | PASS ("allocation failure") |
| Server never ready | `ready-timeout`, the slot is released (a pool slot goes offline until it beats again), re-queued as above | PASS ("ready timeout") |
| Launch command fails / process exits before ready | `launch-failed` / `process-exited`, re-queued as above | `process-exited` PASS (launch mode, mid-match); `launch-failed` NOT TESTED |
| Crash or silence mid-match | `heartbeat-timeout` (pool) or `process-exited` (launch): cancelled, tickets revoked, ranked match **voided** (no rating lost, not counted), presence back to menu, players told and re-queued if all are in the menu (else told at their next login) | PASS ("a crash mid-match", "launch mode: the process dying") |
| Server restarts mid-match | `server-restarted` on its next register: cancelled as above | NOT TESTED |
| Server drops its match (heartbeat names another match, or none) | `server-dropped-match`: cancelled as above | NOT TESTED |
| Server can't run its match | `abort` → `server-aborted:<reason>`: cancelled as above | PASS ("a server aborting") |
| Match runs past `CULLING_SHARED_MAX_MATCH_MS` with no result | `match-timeout`: cancelled as above | NOT TESTED (same path as the crash) |
| Leader or member cancels (`leave-mm`) while allocating | their whole party leaves the match, the others are told (`leave-mm-group`), the rest go on (their slots are bots in the next heartbeat's assignment); if nobody is left the server is released | PASS ("queue cancel, leader disconnect and a duplicate queue": both the release and a solo going on alone) |
| Leader or member disconnects while allocating | the same, reason `party-member-disconnected` | PASS (same test) |
| A member disconnects after `match-ready` | expected (the client is joining the server): nothing is cancelled | by design |
| Duplicate queue while allocating | refused `match-starting` | PASS |
| Party member gone at `ready` | that party isn't sent (all or nothing); its slots are dropped from the assignment (bots) | NOT TESTED (same rule as the countdown, which party.test.js covers for local matches) |
| Backend restart (deploy) mid-match | running matches are kept in `data/shared-matches.json`; the game server's next heartbeat takes its match up again (`adopted`); one not heard from within 2 × heartbeat timeout is cancelled (`backend-restart`) | adoption PASS ("a backend restart mid-match"); the cancel-after-restart path NOT TESTED |
| Client result for a shared match | `202 {ignored: true, reason: "shared-match"}`, logged, nothing paid | PASS |
| The same result twice; a result from the wrong server; a malformed result | `409 already-reported`; `409 match-not-running`; `400 <error>`, nothing paid | PASS |

## 7. Settings

All are environment variables of the backend service. Defaults are in brackets.

| Setting | Meaning |
|---|---|
| `CULLING_SHARED_MATCHES` [off] | `1` turns shared matches on. Anything else: the local match everywhere, exactly as today. |
| `CULLING_SHARED_PLAYLISTS` [none] | Comma list of playlist ids to share, e.g. `coop2,coop3,coop4,ranked_coop2`. Unknown, disabled and Showdown ids are ignored (logged). |
| `CULLING_GAMESERVER_POOL` | Pool mode: `id@host:port,...`, long-running servers supervised outside the backend. |
| `CULLING_GAMESERVER_COMMAND` | Launch mode: the command as a JSON array, with placeholders `{port} {host} {publicHost} {serverId} {matchId} {map} {mapIndex} {playlist} {teamSize} {bots} {field} {backend}`. The process gets `CULLING_GAMESERVER_ID`, `CULLING_GAMESERVER_SECRET`, `CULLING_BACKEND_URL` and `CULLING_MATCH_ID` in its environment (the secret never on the command line). |
| `CULLING_GAMESERVER_PORTS` | Launch mode: the ports, e.g. `7777-7786`. |
| `CULLING_GAMESERVER_HOST` [127.0.0.1] | Launch mode: `{host}`, the address the process binds. |
| `CULLING_GAMESERVER_PUBLIC_HOST` [= HOST] | Launch mode: the address players are sent to. |
| `CULLING_GAMESERVER_CWD`, `CULLING_GAMESERVER_LOG_DIR` | Launch mode: the working folder; a folder for each process's stdout and stderr (`<serverId>.log`). |
| `CULLING_GAMESERVER_MAX` [pool size or port count] | At most this many matches at once. |
| `CULLING_GAMESERVER_READY_TIMEOUT_MS` [60000] | From reservation to `ready`. |
| `CULLING_GAMESERVER_HEARTBEAT_MS` [2000] | How often servers are told to beat. |
| `CULLING_GAMESERVER_HEARTBEAT_TIMEOUT_MS` [10000] | Silent this long: lost. |
| `CULLING_SHARED_MAX_MATCH_MS` [5400000] | A match with no result after this long is cancelled. |
| `CULLING_TICKET_TTL_MS` [120000] | Connection ticket lifetime. |
| `CULLING_SHARED_REQUEUE_MAX` [2] | Re-queues after failed allocations before giving up. |
| `CULLING_SHARED_REQUEUE_ON_CANCEL` [on] | `0`: a cancelled match tells its players without re-queueing them. |
| `CULLING_GAMESERVER_CLOCK_SKEW_MS` [60000] | The largest accepted request timestamp difference. |
| `CULLING_GAMESERVER_SECRET` | The master secret. Default: `data/gameserver-secret.txt`, created once. |
| `CULLING_TICKET_SECRET` | The ticket secret. Default: `data/ticket-secret.txt`, created once. |

The files made when on: `gameserver-secret.txt`, `ticket-secret.txt` and `shared-matches.json` in the data folder (git-ignored under `server/data/`). Nothing is created while off [PASS].

**Test hook** (`CULLING_TEST_HOOKS=1`, loopback only, off by default, never on the VPS): `POST /api/test/join-mm {userID, queueName}` queues a logged-in player's own menu socket as if they had pressed PLAY, so a test can drive real game menus without clicking.

## 8. Logs and metrics

Structured lines, one JSON object each:
- `[gameserver] {"event": "gameserver.reserved" | "launched" | "registered" | "online" | "ready" | "lost" | "released" | "refused" | "offline" | "adopted" | "process-exit" | ..., serverId, matchId, reason, ...}` from the allocator;
- `[shared] {"event": "shared.allocating" | "ready" | "allocation-failed" | "requeued" | "cancelled" | "left" | "result" | "result-refused" | "ticket-accepted" | "ticket-refused" | "client-result-ignored" | "team-mismatch" | "request-refused" | "restored" | "adopted", ...}`.

`/metrics` (loopback only) has `sharedMatches`:
- `{enabled, playlists, allocating, running, counters, tickets}`;
- `servers: {mode, maxMatches, active, states, counters, servers: [{id, address, state, matchId, lastBeatAgoMs, stats}]}`. `stats` holds each server's last reported cpu, memory, players, tick time and bandwidth.

With sharing off it is `{enabled: false}`.

## 9. Changes to existing files (kept thin for merging)

- `server.js`:
  - requires;
  - one construction block (deps closures) before `/api/setlevel`;
  - `allocateMatch` (one line);
  - `launchMatch`: the shared answer, the shared payload, `shared: true` on the ticket, and a return value;
  - `startLocalMatch` (two refusals);
  - `/api/matchresult` (one line);
  - lobby options (wrapped);
  - login (`deliverNotices`), `leave-mm` and disconnect (one line each);
  - `gauges` and `flushAll` (one line each).
- `matchlobby.js`: `hasRoom()` with the optional `fits` option; without it, the same size check as before.
- `.gitignore`: the three shared-match data files.

The Recent Players branch adds a recording hook at match launch. `launchMatch` still runs for every shared player, so a hook there records shared matches too.

## 10. Tests

`node server/test/sharedmatch.test.js` has 23 tests:
- 4 rule tests: team packing, the lobby `fits` option, tickets, allocator config and capacity;
- 15 pool-mode integration tests through real socket.io clients for 2 to 8 accounts, against the stand-in game servers;
- 2 launch-mode tests (a stand-in process per match);
- 1 backend restart test;
- 1 setting-off test.

Results on this branch (2026-11-05):
- `sharedmatch.test.js`: 23 passed, 0 failed, five runs in a row.
- The 28 existing server test files: 288 passed, 0 failed, the same counts as on `multiplayer-plan` before the change.

Every file is run with `node`.

What the stand-in can't show (**BLOCKED** until route A or B runs):
- `ConnectToServer` with this payload in the real menu and exe;
- the game reading `?servernonce` at PreLogin and calling `verify-ticket`;
- team assignment and bots in a real server world;
- a real server's heartbeat and result timing;
- in-match reconnect (a ticket is one use: a reconnect needs a re-issued ticket, not built);
- the capacity numbers.
