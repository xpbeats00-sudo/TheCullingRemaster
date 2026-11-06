# Real multiplayer: deploying game servers on the VPS

> **PENDING A REAL GAME SERVER.** No game-server binary exists yet (route A: no dedicated server build; route B: the patched client as host, in progress). Nothing in this guide has been run on the VPS. Every step is **NOT TESTED / BLOCKED** unless marked otherwise. The backend side it relies on is tested against a stand-in (`server/test/fake_gameserver.js`; see `PARTY_MATCHMAKING_REWORK.md`). Don't turn on `CULLING_SHARED_MATCHES` on the live server until a real server passes section 7.

**Date:** 2026-11-05. **Branch:** `shared-match-backend`.

## 1. What runs where

| Process | Where | Supervision | Exists? |
|---|---|---|---|
| Backend (`server.js`, the `culling-server` service) | VPS, `127.0.0.1:8100`, public `https://<domain>:8443` via Caddy | WinSW plus `deploy/culling_watchdog.ps1` (already installed) | yes |
| Game servers | VPS, one process per match (launch mode) or a fixed pool | see section 4 | **no** (BLOCKED) |

The game servers talk to the backend on loopback: `CULLING_BACKEND_URL=http://127.0.0.1:8100`. The game-server API needs no public exposure. Players connect to the game servers directly over UDP.

## 2. Ports and firewall

| Port | Protocol | Who | Rule |
|---|---|---|---|
| 8443 | TCP | menus → Caddy → backend | exists (`install_vps.ps1`) |
| 8100 | TCP | game servers → backend (loopback) | none needed; keep it closed to the outside |
| 7777–7786 (example: 10 matches) | **UDP** | game clients → game servers (UE NetDriver) | new: `New-NetFirewallRule -DisplayName "Culling game servers" -Direction Inbound -Protocol UDP -LocalPort 7777-7786 -Action Allow` |

Also open the same UDP range in the hosting panel's firewall, if it has one (as was needed for 8443). UE 4.15's default game port is 7777 UDP [I]. Confirm it with the real server.

`deploy/netplay_udp_probe.js` (from the listen-server prototype) can check that UDP reaches the VPS before any server exists. **NOT TESTED** for this range.

## 3. Secrets

| Secret | Where | Who gets it |
|---|---|---|
| Master game-server secret | `C:\culling\data\gameserver-secret.txt` (created by the backend on first start with shared matches on), or `CULLING_GAMESERVER_SECRET` in the service's environment | the backend only |
| Per-server secret | derived: `node C:\culling\server\allocator.js secret <serverId> C:\culling\data` | each pool server, its own only. Launch mode passes it automatically in the child's environment (`CULLING_GAMESERVER_SECRET`), never on the command line. |
| Ticket secret | `C:\culling\data\ticket-secret.txt` or `CULLING_TICKET_SECRET` | the backend only. Game servers verify tickets through the API. |

The data folder is in the daily backups (`backup.js`), and so are the secrets. Treat the backups as secret too (they already hold `ip-hash-secret.txt`). To rotate, delete the file and restart: every pool server then needs its new secret.

## 4. Running the processes

### Launch mode (preferred: one process per match)

In the service's WinSW XML (`install_vps.ps1` writes it), add:

```xml
<env name="CULLING_SHARED_MATCHES" value="1"/>
<env name="CULLING_SHARED_PLAYLISTS" value="coop2"/>
<env name="CULLING_GAMESERVER_COMMAND" value='["C:\\culling\\gameserver\\Binaries\\Win64\\<Server>.exe","{map}?listen?MatchId={matchId}","-port={port}","-nullrhi","-unattended","-log"]'/>
<env name="CULLING_GAMESERVER_PORTS" value="7777-7786"/>
<env name="CULLING_GAMESERVER_PUBLIC_HOST" value="<VPS public IP or domain>"/>
<env name="CULLING_GAMESERVER_LOG_DIR" value="C:\culling\data\logs\gameservers"/>
<env name="CULLING_GAMESERVER_MAX" value="2"/>
```

The exact command line depends on the route. The one above is a placeholder: the route A binary's name and options are unknown. Route B is the patched `Victory.exe` with `?listen` and `-nullrhi`.

Supervision in launch mode:
- The backend starts each process and watches it (`exit` → the match is cancelled and its players re-queued).
- A process silent for `CULLING_GAMESERVER_HEARTBEAT_TIMEOUT_MS` is treated as hung. The match is cancelled, and the process is killed after `releaseGraceMs` (5 s).
- A process still running after its match ends is killed after the same grace.
- A backend restart doesn't kill running game servers. Their next heartbeat re-adopts the match (tested against the stand-in).
- Add an hourly sweep to the watchdog: kill game-server processes older than `CULLING_SHARED_MAX_MATCH_MS` + 10 min whose server id isn't in `/metrics` `sharedMatches.servers`. That covers orphans a backend crash leaves behind. NOT BUILT.

### Pool mode (long-running servers)

`CULLING_GAMESERVER_POOL=gs1@<ip>:7777,gs2@<ip>:7778`. Each server is its own service, as the backend is: one WinSW wrapper per slot (`culling-gs1`, ...) with `CULLING_GAMESERVER_ID`, `CULLING_GAMESERVER_SECRET` and `CULLING_BACKEND_URL` in its environment, restart on failure. A watchdog copy probes the backend's `/metrics` instead of `/health`: the slot's `lastBeatAgoMs` above the timeout means the server is hung, and the watchdog restarts that service, with `culling_watchdog.ps1`'s backoff and daily cap. This needs a game server that can run match after match without restarting, which is unknown for both routes.

## 5. Capacity: what to measure (plan)

The target is 10 people and about 20 bots on the VPS (audit section 5). It can't be measured until a server exists.

| Measure | How | Recorded where |
|---|---|---|
| CPU per match | Windows `Get-Counter '\Process(<exe>*)\% Processor Time'` every 5 s; the server may also send `cpu` in its heartbeats | heartbeat `stats.cpu` (kept per slot in `/metrics`) |
| Memory per match | `\Process(*)\Working Set - Private` | heartbeat `stats.memMB` |
| Tick rate and tick time | server log (`stat unit`), or `tickMs` / `tickRate` in heartbeats; target 30 Hz, so `tickMs` ≤ 33 | heartbeat `stats.tickMs`, `tickRate` |
| Bandwidth per player | `\Network Interface(*)\Bytes Sent/sec` during a match divided by players, or `kbpsOut` / `kbpsIn` from the NetDriver | heartbeat `stats.kbpsOut`, `kbpsIn` |
| Match start time | reserve → ready | the `[gameserver] ready` log line (`ms`) |

The steps:
1. One match: 2 players plus 14 bots. Then 10 players plus 6 bots. Then 16 players.
2. Two matches at once, then three, up to the first that drops below 30 Hz or above about 80% CPU.
3. Set `CULLING_GAMESERVER_MAX` one below that.

Also log the VPS core count and RAM with the numbers. Every step is BLOCKED.

## 6. Turning it on (when a server exists)

1. Install the game server files and open the UDP range (section 2).
2. Add the settings to the service XML (section 4) with **one** playlist (`coop2`) and `CULLING_GAMESERVER_MAX=1`. Restart the service with the existing update bat.
3. Check that `/metrics` shows `sharedMatches.enabled: true` and the playlist.
4. Two test accounts in a party queue Duos. Check:
   - `[shared] allocating` → `[gameserver] launched/registered/ready` → `match-ready` with `netplay: true`;
   - both clients load into the same world, on the same team;
   - `[shared] result` → both paid.
5. Run section 5. Add playlists one at a time.

**Rollback:** remove `CULLING_SHARED_MATCHES` (or set it to `0`) and restart. Every playlist is local again, and matches running at the time are cancelled with their players re-queued.

## 7. Acceptance before going live

| Gate | Status |
|---|---|
| Backend allocator, tickets, results against the stand-in | PASS (`server/test/sharedmatch.test.js`) |
| Two real clients join one real server with their tickets | BLOCKED |
| Same team, see each other, combat, bots, loot | BLOCKED |
| The authoritative result from a real server pays and rates both | BLOCKED |
| A server crash or kill mid-match cancels and re-queues | stand-in PASS; real BLOCKED |
| Capacity measured (section 5) | BLOCKED |
