# Account server: production readiness and performance audit

Date: 2026-11-04. Scope: `server/` (the account server), the service and watchdog parts of `deploy/install_vps.ps1`, and the new `deploy/culling_watchdog.ps1`. Nothing here was run on the VPS. The live server (xplab.shop) was not contacted.

Status labels used below:

- **Implemented**: the code is written and in the working tree.
- **Unit-tested**: covered by a test in `server/test/*.test.js` that passes.
- **Load-tested locally**: measured with `server/test/load.js` on the PC described below.
- **Not verified on the VPS**: nothing has been run on the Hostinger VPS. Every item in this report carries this label.

## 1. What the server actually is

- One Node.js process: Express 4 plus socket.io 2.5. Files: `server.js`, `ranked.js`, `session.js`, `lastbreath.js`, and the new `store.js` and `metrics.js`.
- On the VPS it runs as the WinSW service `culling-server` on 127.0.0.1:8100, as LocalService. Caddy serves it at https://xplab.shop:8443.
- It handles:
  - login (tokens);
  - profiles, cull credits, the shop and calling cards;
  - ranked ratings;
  - matchmaking replies;
  - match results posted by the in-match HUD.
- **It does not run matches.** Matchmaking replies `gameServer: 'offline:<map>'`. The game then plays an offline match against bots on the player's own PC. The server sees nothing between `match-ready` and the `/api/matchresult` POST at the end. So there is no tick rate, no replication, no server-side physics or bot AI, and no per-match server cost. Every "capacity" number in this report is for the account server only.
- State lives in memory and is saved to `CULLING_DATA_DIR`: `profiles.json`, `sessions.json` and `levels.json`.

## 2. Where it was measured

| | Measured on (this PC) | VPS (Hostinger, Windows Server 2022) |
|---|---|---|
| CPU | Intel Core i7-14650HX, 16 cores / 24 threads, base 2.2 GHz (laptop: HP OMEN 16-am0xxx) | **Unknown**: vCPU count, model, clock, and whether cores are shared or burstable |
| RAM | 32 GB | **Unknown**, and shared with Superstar Racing and Caddy |
| Disk | KIOXIA KBG60ZNV1T02 NVMe SSD | **Unknown**: fsync latency on a VPS disk is often 10-100x a local NVMe |
| OS | Windows 11 Enterprise 10.0.26300 | Windows Server 2022 |
| Node | v24.15.0 | v22.11.0 (pinned by the installer) |
| Network | loopback; load generator on the same machine | Internet, then Caddy (TLS) on loopback, then node |

Consequences:

- Absolute numbers will differ on the VPS. Expect fewer and slower cores, slower fsync, TLS work in Caddy, and real network latency on top.
- On this PC, CPU-bound work runs several times faster than on a typical 1-2 vCPU VPS. Treat the breaking point found here as an upper bound for the VPS, not as its value.
- Node 22 and Node 24 were not compared. The installer pins 22.11.0, so the VPS runs a different V8 than the one measured.

### A Windows measurement artifact

Windows timers tick every ~15.6 ms by default, and Node does not raise the timer resolution. Two consequences:

- **Event-loop delay** (`perf_hooks.monitorEventLoopDelay`) has a floor of about 15.5 ms even on an idle process. Measured on an idle Node process: p50 15.52 ms at resolution 1 ms and at 10 ms; `setTimeout(1)` fired after 12.6 ms. So 15-16 ms in the tables below means "no blocking". Only the part above ~16 ms is real blocking. For a resolution-independent signal, `/metrics` also reports **event-loop utilization** (ELU: the share of time the loop is busy).
- **Client latency:** engine.io-client re-arms its websocket with `setTimeout(0)` after every send, so back-to-back emits wait up to one tick in the client. The load generator waits for that before starting its clock, so socket latencies are the server's. Latencies of ~8-15 ms that remain in the login phase and in "match-ready lateness" are this tick, not server work.

## 3. Method (`server/test/load.js`)

- **Server:** a fresh server per run, with its own data folder, `NODE_ENV=production` (like the service), stdout to a log file (like WinSW), and `--expose-gc` so heap can be compared after a forced GC. The load script refuses to run if anything already answers on its port, and checks that the PID behind `/metrics` is the server it started.
- **Clients:** each one is a separate address via `X-Forwarded-For` over loopback, exactly as Caddy presents clients. The client must use the `ws` package (`forceNode: true`). On Node 22+ engine.io-client otherwise picks the global browser-style `WebSocket`, which cannot send that header. Before this was fixed, all sockets shared one rate-limit bucket. Those runs were discarded.
- **One third are "players", two thirds "bot accounts".** The peak scenario is 10 players plus 20 bot accounts, 30 clients.
- **Per client:**
  - **Login:** `POST /api/login`, then socket connect, socket `login`, then `get-inventory-types` with a stale version (the full 4,913-item catalog: the worst case, as on a release day), `get-premium-types`, the leaderboard request, `GET /api` and `get-entitlements`.
  - **Loop:**
    - `GET /api/ranked`;
    - `join-mm` (half `ranked_ffa`, half `ffa`), then wait for `match-ready`;
    - "play" for 20 s ±30%;
    - `POST /api/matchresult` and `POST /api/setlevel`;
    - `set-card` (50%), then `get-cards` (10 users);
    - a purchase (10%, players only);
    - `get-season-summary`;
    - 3-8 s in the menus.
- **Rates are compressed.** A real match lasts minutes: the one real match result on record (`profiles.json`) has `timeAlive` 701 s. Here a cycle takes about 27 s (20 s ±30% match, 1.5 s queue timer, 3-8 s menus). So each client sends about 26x the requests of a real player, more if real players spend longer in menus. 30 test clients produce roughly the request rate of 780 real players. The connection count is still exactly the client count.
- **Sampling:** `/metrics` every 5 s (event-loop delay and utilization, CPU, heap, RSS). Heap after a forced GC at start, middle and end.
- **Load generator:** client work is split over worker processes (1 per 100 clients, up to 8). Their own event-loop p99 stayed at 16-22 ms, which is the timer floor, so the generator was never the bottleneck.

## 4. Results

### Idle baseline (65 s, no clients)

| Event-loop delay p50 / p99 / max | ELU | CPU | Heap / RSS |
|---|---|---|---|
| 15.55 / 16.37 / 35.6 ms (timer floor) | 0.0016 | 0.4% of one core | 11.5 / 61 MB |

### Planned peak: 30 clients, 5 minutes (load-tested locally)

| Metric | Value |
|---|---|
| Operations | 2,211 (6.8/s); server saw 192 HTTP requests/min and 239 socket events/min |
| Latency, all operations | p50 **0.42 ms**, p95 **1.82 ms**, p99 13.4 ms, max 22.8 ms |
| Errors | **0** (client side and server side) |
| Steady-state p95 | `POST /api/matchresult` 1.16 ms, `GET /api/ranked` 0.89 ms, `join-mm` 0.71 ms, `get-cards` 0.45 ms |
| Event-loop delay (whole run) | p50 15.6, p99 16.4, max 27.0 ms (floor ~15.5), so at most ~11 ms of real blocking |
| Event-loop utilization | 0.5% average, 6.3% in the busiest 5 s sample |
| CPU | 0.76% of one core on average, 7.2% peak (the login burst) |
| Memory | heap after GC 14.2, then 15.0, then 15.2 MB; RSS ~72 MB after the start-up burst |
| Saving | 1,013 profile changes, 245 writes (about 1 per second while busy); longest event-loop time per write 0.94 ms; fsync done off the loop |

The p99 and max (13-23 ms) come from the login phase: the first catalog send and JIT warm-up, plus the timer tick. Steady-state operations stay under 2.1 ms at p99.

### 20-minute soak, 30 clients (load-tested locally)

| Metric | Value |
|---|---|
| Operations | 8,286 (6.8/s); 1,324 match cycles; 52 purchases |
| Latency, all operations | p50 0.35 ms, p95 **0.94 ms**, p99 4.7 ms, max 25.4 ms |
| Errors | **0** |
| Event-loop delay | p99 16.5 ms, max 21.7 ms (floor ~15.5 ms) |
| CPU | 0.58% of one core average, 6.9% peak |
| **Heap after GC** | **start 14.2 MB, middle (600 s) 15.7 MB, end (1,198 s) 15.7 MB** |
| RSS | 74.4 MB at middle, 75.5 MB at end |
| Saving | 4,084 changes, 1,066 writes; profiles.json grew to 263 KB (30 profiles, ranked history filling up); longest event-loop time per write 2.0 ms |

No memory growth between the middle and the end. The 1.5 MB rise in the first half is player data: profiles gain match history up to its cap of 50.

### Breaking point (load-tested locally)

Steps of 120 s each. Clients log in spread over clients x 20 ms (at most 10 s). The run stops at p95 > 200 ms or any error.

| Clients | Ops/s | HTTP req/min | Socket ev/min | p50 | p95 | p99 | Errors | ELU avg / peak | CPU avg / peak (one core) | Heap after GC (end) |
|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---:|
| 30 | 7.2 | 189 | 255 | 0.48 | 6.9 | 12.8 | 0 | 0.6% / 6% | 0.7% / 7% | 14.8 MB |
| 100 | 23.9 | 631 | 846 | 0.45 | 7.7 | 12.0 | 0 | 1.5% / 17% | 1.6% / 18% | 16.6 MB |
| 300 | 46.3 | 1,232 | 1,655 | 0.42 | 5.5 | 9.7 | 0 | 2.6% / 27% | 3.0% / 28% | 17.6 MB |
| 1,000 | 229 | 6,035 | 8,132 | 0.56 | 11.5 | 23.3 | 0 | 10% / 78% | 12% / 96% | 34.6 MB |
| **2,000** | 358 | 9,462 | 12,654 | 0.70 | **331** | 807 | **615** | 14% / 96% | 11% / 105% | 46.9 MB |

- **At 2,000 clients:** every failure happened while 2,000 clients logged in within 10 s (200 per second). Those failures were 241 `POST /api/login` ECONNREFUSED and 187 socket connect errors with login timeouts.
  - Each login also pulls the full catalog, which kept the single thread saturated (ELU 96%). The OS listen queue then overflowed.
  - The match loop itself stayed fast: `POST /api/matchresult` p95 1.65 ms, `get-cards` p95 0.8 ms.
- **What the limit is:** the login/catalog rate (single-threaded CPU), not memory or saving. Even at 2,000 clients the heap after GC was 47 MB and the longest event-loop time per save was 8.8 ms.

**The same steps with logins spread over 60 s** (`--ramp-seconds 60`, 180 s per run, load-tested locally). This separates the number of concurrent clients from the login rate:

| Clients | Ops/s | HTTP req/min | Socket ev/min | p50 | p95 | p99 | Errors | ELU avg / peak | CPU avg / peak (one core) | Heap after GC (65 s / 90 s / 178 s) | RSS max |
|---:|---:|---:|---:|---:|---:|---:|---:|---|---|---|---:|
| 2,000 | 400 | 10,790 | 14,156 | 0.52 | 5.6 | 10.3 | 0 | 15% / 33% | 17% / 47% | 53.9 / 57.2 / 56.2 MB | 358 MB |
| **4,000** | 797 | 21,496 | 28,199 | 0.81 | **8.4** | 15.5 | **0** | 28% / 69% | 34% / 77% | 93.7 / 95.3 / 98.0 MB | 461 MB |
| ~5,400 reached (8,000 attempted) | 1,103 | 30,550 | 40,259 | 1.15 | 197 | 940 | 1,840 | 38% / 98% | 43% / 109% | 125.9 / 127.6 / 130.6 MB | 730 MB |

- **4,000 concurrent clients with 0 errors** is the highest clean result. Steady-state p95: `POST /api/matchresult` 6.6 ms, `GET /api/ranked` 6.8 ms, `join-mm` 4.9 ms. The longest event-loop time per save was 45 ms: profiles.json had reached 7.4 MB, written about once a second. The longest write including fsync took 408 ms, off the loop.
- **The 8,000 run says more about the load generator than the server.**
  - 1,070 of its 1,840 errors were EADDRINUSE on the client side (the generator ran out of ephemeral ports).
  - The server only ever saw ~5,400 sockets.
  - Still, at ~5,400 sockets the server was saturating: ELU peaked at 98%, steady-state p95 was ~150-165 ms, and there were login refusals.
  - So with 60 s login ramps the server's limit on this PC lies **between 4,000 (clean) and ~5,400 (degraded) concurrent clients**. It was not pinned down more precisely.
- **Load-generator limit in this environment:** more than 7 forked worker processes crash at start (exit code 0xC0000409, reproducible with 8 and 10 workers). That made two earlier 4,000-client attempts reach only 3,500 and 3,200 clients; they are not counted. The 4,000 row uses 7 workers. `load.js` now reports a worker that dies as errors instead of as fewer clients.

### Before and after (same load, the previous `server.js` from HEAD, load-tested locally)

| | 30 clients: previous | 30 clients: now | 1,000 clients: previous | 1,000 clients: now |
|---|---|---|---|---|
| p50 / p95 / p99, all operations | 1.15 / 9.3 / 12.8 ms | 0.48 / 6.9 / 12.8 ms | **137 / 733 / 1,600 ms** | **0.56 / 11.5 / 23.3 ms** |
| `POST /api/matchresult` p95 | 2.9 ms | 1.2 ms | **1,624 ms** | **1.5 ms** |
| `GET /api/ranked` p95 | 8.1 ms | 1.1 ms | 1,292 ms | 8.3 ms |
| Errors | 0 | 0 | 240 (ECONNRESET) | 0 |

The previous server wrote all of `profiles.json` synchronously on the event loop, pretty-printed, on every change. That included every login (sessions too), match result, level report and card choice. It also logged every request and socket event to stdout. At 1,000 clients the event loop spent most of its time on that, and every request queued behind it.

The previous server's ECONNRESETs are most likely keep-alive races: Node's default 5 s keep-alive timeout against a client that reuses the connection after a menu pause. Slow replies make the race more likely. The new server keeps idle connections for 65 s.

## 5. Fixes made

| # | Area | Change | Status |
|---|---|---|---|
| 1 | Telemetry | `GET /metrics` (`metrics.js`). Answered only to a loopback peer carrying none of `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto`, `X-Forwarded-Port`, `Forwarded`, `X-Real-IP` or `Via`. Caddy always adds `X-Forwarded-For`, so the public URL gets 404. Reports: <ul><li>uptime, connected sockets, logged-in users, profiles, tokens, open tickets, rate-limiter table sizes;</li><li>event-loop delay p50/p95/p99/max (last minute, current minute, since start) and event-loop utilization;</li><li>heap, RSS and external memory;</li><li>CPU (last minute, current, total);</li><li>requests and socket events per minute (last minute, average of the last 5);</li><li>per route and per socket event: count, errors, mean/p50/p95/p99/max latency;</li><li>error counts: http5xx, http4xx, rateLimited, socketHandler, socketDropped, process, save;</li><li>save statistics.</li></ul> Bounded: at most 200 keys, 2,048 latency samples per key per minute (reservoir), 15 minutes of per-minute summaries. | Implemented, unit-tested (`metrics.test.js`: loopback-only rule incl. non-loopback addresses, refusal with each proxy header, report contents, percentiles), load-tested locally |
| 2 | Saving | `store.js` `CoalescedJsonFile`: <ul><li>a change only marks the file dirty;</li><li>at most one write per second (`CULLING_SAVE_DELAY_MS`, default 1000);</li><li>temp file, then async write and `fsync`, then rename;</li><li>a write in flight is discarded if a shutdown flush wrote newer data;</li><li>failed writes keep the change and retry;</li><li>a rename blocked briefly on Windows (EPERM/EBUSY) is retried;</li><li>stale temp files are removed at start.</li></ul> Used for `profiles.json` and `sessions.json`. `levels.json` (rare) is written atomically and synchronously. | Implemented, unit-tested (`store.test.js`: 1,000 changes give 1 write; at most one write per interval; a reader never sees a partial 2 MB file during ~1.5 s of continuous rewrites; failure keeps old data and retries; a shutdown flush beats a stale in-flight write; temp clean-up), load-tested locally (soak: 4,084 changes, 1,066 writes, ≤2.0 ms on the event loop) |
| 3 | Saving | profiles.json is written compact, not pretty-printed. It is serialized on the event loop for every write: compact is ~40% smaller and ~30% faster to produce. | Implemented, load-tested locally |
| 4 | Graceful stop | Flush on SIGINT, SIGTERM, SIGBREAK and SIGHUP. The handler writes synchronously first, then refuses new requests and socket events (503, dropped), closes, writes again and exits. Also flushes on `exit` and on `uncaughtException` (then exits 1 so WinSW restarts it). Exit code is 0 for SIGINT/SIGTERM and 1 for SIGHUP/SIGBREAK: WinSW 2.12 treats a child that exits 0 on its own as "service stopped" and won't restart it. | Implemented, unit-tested (`shutdown.test.js`) |
| 5 | WinSW stop path | Checked in the WinSW v2.12.0 source (`ProcessHelper.cs`, `WrapperService.cs`). On stop it calls `AttachConsole(node)`, then `GenerateConsoleCtrlEvent(CTRL_C_EVENT)`, which Node delivers as SIGINT. It waits `<stoptimeout>` (15 s), then calls `Kill()`. `stopparentprocessfirst` defaults to true in 2.12 and is now set explicitly. Before starting the child, WinSW clears the inherited "ignore Ctrl+C" flag. Without that, Node never sees the event: the first emulation attempt without it was killed after 15 s. `server/test/winsw_stop.ps1` reproduces this sequence exactly. The test then checks that a match result, card choice and login token held only in memory (60 s save interval) are on disk after the stop, and that node exited 0 rather than being killed. | Implemented, unit-tested with a WinSW-equivalent Ctrl+C on this PC (passes: node exits 0 well inside the 15 s stop timeout instead of being killed). **Not verified with the real WinSW service on the VPS** |
| 6 | Crash loss bound | A hard kill (TerminateProcess) 1.5 s after a change keeps the change. | Unit-tested (`shutdown.test.js`) |
| 7 | **Remote crash** | Any logged-in client could crash the process with one socket message: `get-cards` with `users` not an array (`users.map is not a function`), or a user named `constructor` (`profiles.constructor.stats.level`). Both reproduced against the previous server (exit code 1). Fixed: <ul><li>`profiles` has no prototype;</li><li>lookups use own properties;</li><li>`users` must be an array (at most 100);</li><li>every socket handler is wrapped: an exception is logged and counted, never fatal.</li></ul> | Implemented, unit-tested (`metrics.test.js`: malformed messages) |
| 8 | Unbounded growth | `get-season-summary` and `get-cards` for any user ID created a stored profile for it (written to disk). Lookups now never create profiles. | Implemented, unit-tested |
| 9 | Unbounded growth | Login: <ul><li>user IDs limited to 64 printable characters (others get 400);</li><li>new profiles per address: 10, then 1 per minute (429);</li><li>a global cap of 100,000 profiles (`CULLING_MAX_PROFILES`).</li></ul> Existing players are never limited. | Implemented, unit-tested |
| 10 | Unbounded growth | Tokens: each login added one, kept for 30 days, with an O(all tokens) prune and a full `sessions.json` write on every login. Now: at most 8 tokens per player (oldest dropped), 100,000 in total, pruned at most once a minute, saved coalesced. | Implemented, unit-tested |
| 11 | Unbounded growth | `ranked.processed` kept a full copy of every ranked result forever, in every profile. A veteran's profile was ~74 KB, and serializing 1,000 of them took 157 ms per save. Now only the last 100 match IDs are kept (a duplicate result still returns its original entry from history). Old profiles shrink on their next ranked match. A veteran profile is now ~18 KB; 1,000 of them serialize in ~41 ms. | Implemented, unit-tested (`store.test.js`, `ranked.test.js`) |
| 12 | Unbounded growth | Match tickets: the "recent result by address" map was never pruned; entries now expire after 15 min. Rate limiters: past 50,000 addresses the table was cleared (resetting every limit); now idle buckets are swept first. | Implemented, unit-tested |
| 13 | Timers / sockets | <ul><li>One pending `match-ready` timer per socket: a repeated `join-mm` replaces it, a disconnect cancels it, and it doesn't fire to a closed socket.</li><li>Delayed entitlement pushes skip closed sockets.</li><li>A socket that doesn't log in within 60 s is closed.</li><li>At most 32 sockets per address (`CULLING_MAX_SOCKETS_PER_IP`).</li><li>Re-login as another user removes the stale user-to-socket mapping.</li><li>`maxHttpBufferSize` is 1 MB (engine.io 3 default: 100 MB per message).</li></ul> | Implemented; per-address cap and login timeout not unit-tested |
| 14 | Malformed input | <ul><li>Queue names, card IDs, map names and season-summary IDs are validated.</li><li>`/api/levelcurve` requires an array of at most 1,000 entries.</li><li>An Express error handler turns bad JSON into a JSON 400 and handler bugs into a JSON 500 (counted).</li><li>The rate limit runs before body parsing.</li></ul> | Implemented, unit-tested |
| 15 | Logging | Per-request and per-socket-event log lines are off when `NODE_ENV=production` (the service sets it) or `CULLING_ACCESS_LOG=0`. Logins, match results, purchases, ranked results and errors are still logged. | Implemented |
| 16 | Catalog | The inventory-types list (4,913 items) is built once, not per request. | Implemented |
| 17 | Watchdog | `deploy/culling_watchdog.ps1`, installed by `install_vps.ps1` as the scheduled task "Culling Server Watchdog" (SYSTEM, every minute, 3-minute run limit, no overlapping runs). <ul><li>It probes `http://127.0.0.1:8100/health` with a 5 s timeout (a slower reply counts as a failure; it bypasses any proxy).</li><li>After 3 consecutive failures it restarts the service: stop, wait 30 s, kill the wrapper and node if still running, start.</li><li>Backoff between restarts: 5, 10, 20, 40, then 60 min, reset after an hour healthy. At most 6 restarts in 24 h, then it only logs.</li><li>It never starts a service that is Stopped (an update or a deliberate stop), and pauses while `C:\culling\data\logs\watchdog.pause` exists.</li><li>It logs to `C:\culling\data\logs\watchdog.log` (rolled at 1 MB): failures, restarts with node's CPU/memory/threads, recoveries, and an hourly "ok".</li></ul> | Implemented. Probe/backoff logic exercised locally with `-DryRun` against a fake endpoint (hang, 6.5 s slow reply, HTTP 500): it restarted after 3 failures, then held back with "backoff 5 min", then "backoff 10 min". The scheduled-task objects were built (not registered) on this PC. **The real restart path and task registration are not verified on the VPS** |
| 18 | Installer | Copies `store.js` and `metrics.js` (without this the new code would not start on the VPS), sets `stopparentprocessfirst`, installs the watchdog task, and prints a `/metrics` line in its checks. | Implemented, parse-checked. **Not run** |

Tests, all passing (`node test/<name>.test.js` in `server/`):

- existing: `camopurchase`, `lastbreath` (11), `matchresult` (8), `ranked`, `session` (6);
- new: `metrics` (7), `store` (11), `shutdown` (2 on Windows; SIGTERM and SIGINT variants on other systems).

Later: player accounts (`accounts.js`, `accounts.test.js`, 14 tests; see `docs/ACCOUNTS.md`) add `accounts.json` to the same coalesced saves and stop flush, and account counts to `/metrics`. Password hashing (scrypt, 32 MB, tens of ms each) runs off the event loop, at most 2 at a time. The test harnesses start the server with `CULLING_REQUIRE_ACCOUNT=0` unless a test is about accounts.

`matchresult` and `camopurchase` read `profiles.json` right after each request. They now start their server with `CULLING_SAVE_DELAY_MS=0` (write on every change, as before). Their assertions are unchanged.

## 6. Capacity statement (account server only)

Measured on the PC above:

- **The planned peak (10 players + 20 bot accounts, 30 clients) uses under 1% of one core on average, about 16 MB of heap after GC and ~75 MB RSS.** It ran with 0 errors, p95 below 2 ms and no memory growth over 20 minutes, at about 26x the request rate of real play.
- With the same per-client behavior, it handled **1,000 concurrent clients** with 0 errors and p95 11.5 ms. It failed at **2,000 clients logging in within 10 s**. With the same 4,000 clients logging in over 60 s instead, it handled **4,000 concurrent clients with 0 errors and p95 8.4 ms** (about 800 operations/s, ELU 28% average). It degraded at around 5,400.
- Since each test client sends about 26x the requests of a real player, the request-rate headroom for real players is larger than the client counts suggest. The connection count is not compressed.
- **Not a claim about the VPS.** Its CPU, disk and memory are unknown and shared with Superstar Racing, it runs Node 22, and Caddy's TLS sits in front. To get VPS numbers, run `load.js` there (it needs only loopback) or read `/metrics` during real play.
- **Rough expectation, not a measurement:** a 1-2 vCPU VPS should still carry the 30-client peak with a large margin, because it needs under 1% of one core here. The 1,000-client figure should not be assumed there.

Next limits as the player base grows, in order:

1. **Login storms.** A burst of logins with stale catalogs (a release day) saturates the one thread: each full catalog reply is 0.73 MB of JSON (4,913 items; measured payload size). Mitigations:
   - cache the encoded catalog packet;
   - ship the catalog with the patch so versions match;
   - spread reconnects.
2. **Whole-file saves.** Each save serializes every profile on the event loop. Measured with ranked veterans after the fixes: 1,000 profiles ~41 ms per save, 10,000 ~420 ms, at most once a second. Past a few thousand active profiles, move to per-profile files or SQLite.
3. **One process, one core.** Beyond that you need several processes behind Caddy with shared state, which means moving profiles and sessions out of memory (SQLite or Redis).

## 7. What a real dedicated game server would need (not built; for comparison)

If matches ever moved from "offline against bots on each PC" to server-authoritative online matches, the account server above would only be the lobby. A separate system would be needed:

- **A dedicated server build of the game.** The Unreal Engine 4 server target for The Culling, which this project does not have: only the cooked client exists, so `offline:<map>` is all the game supports today. It would run headless, one process per match (50 players or bots), with its own tick rate and replication.
- **CPU and memory per match.** These have to be measured per map on that build. There are no numbers here because there is no build.
- **Bots on the server.** The server runs the AI and navigation for every bot, which is usually the largest CPU cost in bot-filled matches.
- **Networking.**
  - UDP ports per match process, open in the firewall and in the hosting panel; Caddy does not proxy UDP.
  - A low-latency location near the players.
  - Bandwidth per player at the chosen tick rate, to be measured.
- **Orchestration.**
  - Start and stop match processes and assign ports.
  - Health-check them and clean up hung matches.
  - Matchmaking that waits for real players.
  - Reconnect handling.
- **Trust.**
  - Results come from the server, not from the player's HUD; today `/api/matchresult` trusts the client within bounds.
  - Anti-cheat.
  - Ranked rated on real opponents.
- **Measurements that would then matter:** server frame time against the tick budget, packet loss and jitter, per-match CPU and memory, players per vCPU. None of these exist today, and none were invented here.

## 8. Not verified or still open

- Nothing in this report was run on the VPS: not the service, the WinSW stop, the watchdog task, the installer, `/metrics` behind Caddy, or performance.
- The Ctrl+C stop was verified with an exact emulation of WinSW 2.12's sequence, not with WinSW itself.
- The watchdog's real restart (`Stop-Service`, kill, `Start-Service`) and the task running as SYSTEM were not executed. Only the probe/backoff decisions were.
- `/metrics` is refused through Caddy because Caddy adds `X-Forwarded-For`; this is unit-tested with that header, not through a real Caddy. Optional extra: `respond /metrics 404` in `culling.caddy` (Caddy config was out of scope).
- Fixed in review: `/api/levelcurve` let any client change the level curve for everyone. Now the first report sets the curve, and after that only a loopback request without proxy headers (the operator on the VPS) can replace it. Covered by a test in `metrics.test.js`.
- The socket.io transport the game really uses (binary polling, maybe upgrading to websocket) was not load-tested. The load test uses websocket; `--transport polling` exists but was not run. Polling costs more per message.
- Node 22.11 (VPS) against 24.15 (measured) was not compared.

## 9. How to reproduce

In `server/`:

```
node test/metrics.test.js; node test/store.test.js; node test/shutdown.test.js     # plus the existing tests
node test/load.js --clients 30 --duration 300                                       # 5-minute peak
node test/load.js --clients 30 --duration 1200                                      # 20-minute soak
node test/load.js --steps 30,100,300,1000,2000,4000,8000 --duration 120             # breaking point
node test/load.js --steps 2000,4000,8000 --ramp-seconds 60 --duration 180           # slower logins
node test/load.js --clients 1000 --duration 120 --server <old server.js>            # before/after
```

On the VPS (as administrator), while the service runs:

```
Invoke-RestMethod http://127.0.0.1:8100/metrics
```
