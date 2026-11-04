# Test results

**Environment**
- **Build PC:** Windows 11 Enterprise 10.0.26300, Node 24.15 (tests), Electron 33.2.1.
- **Network:** this PC to the VPS (`xplab.shop`, Windows Server, Hostinger US). The PC's own line measures 8.4 MB/s.

**Builds**
- **Launcher:** 1.2.0, build `7bf6d8d` (setup `TheCullingRemasterSetup.exe`, 84,734,584 bytes).
- **Live game release:** 1.1.0 (3,559 files, 6,066,014,658 bytes).

**Date:** 2026-11-04 (overnight session).

**Labels**
- **unit:** automated test against a local HTTP server.
- **live:** run against the real VPS or the real packaged app.
- **not run:** neither.

## Launcher: automated suites (`npm test` in `launcher/`)

| Suite | Tests | Result |
|---|---|---|
| sync | 16 | pass |
| update | 21 | pass |
| config | 5 | pass |
| game | 6 | pass |
| player name | 4 | pass |
| errors | 5 | pass |
| **Total** | **57** | **pass** |

The 50 tests before the Phase A additions also pass from a clean checkout of the branch.

The release staging script (`deploy/stage_objects.test.js`) passed all 4 checks.

## Launcher test matrix (plan section 25)

| Scenario | Expected | Actual | Evidence |
|---|---|---|---|
| Fresh install | Files download and verify | Pass | unit; live: the user's install completed by the new engine (105 files, 5.50 GB in 614 s, 0 retries) |
| Up-to-date install | No large download | Pass | unit; live: the packaged 1.2.0 booted with 0 pending |
| One changed file | Only that file downloads | Pass | unit; live: Repair downloaded only the 1 swapped pak (196 MB) |
| Missing file | Only that file downloads | Pass | unit |
| Corrupt file | Only that file is repaired | Pass | unit (including corruption behind unchanged metadata); live: Repair (3,558 OK, 1 changed) |
| Pause during download | Requests stop; partial files stay | Pass | unit; browser preview |
| Resume after restart | Valid partial bytes reused | Pass | unit; live: an old-format partial install resumed |
| Network disconnect | Bounded retries; no corrupt file | Pass | unit (dropped sockets, stalls, 5xx/429) |
| Server ignores Range | File restarts safely | Pass | unit |
| Invalid Content-Range | Response refused | Pass | unit |
| HTTP 416 | Partial file accepted or restarted | Pass | unit |
| Disk fills | Clear error; state kept | Partly | unit for the preflight and error kind; no real full-disk test |
| Launcher closes mid-download | Partial files stay | Pass | unit (abort); the before-quit pause is not run on a real quit |
| Invalid manifest signature | Update refused | Pass | unit |
| Path traversal entry | Entry refused | Pass | unit (plus the Windows-specific cases) |
| Failed update commit | Previous install recoverable | Pass | unit (EBUSY rollback, simulated crash, journal roll-forward) |
| Optional content left out | Core still launches | n/a | The release has no optional content |

## Live measurements

| Measurement | Result |
|---|---|
| TCP / TLS to the VPS | 108 ms / 215 ms average, 0 of 20 failed |
| Single-stream download (2.4 GB pak) | 8.0 MB/s (this PC's line: 8.4 MB/s) |
| 3,517 small files: 1 / 8 / 16 at once | About 7 min (old) / 54 s / 28 s |
| A 256 MB pak through the engine | 8.46 MB/s |
| The user's install, 105 files, 5.50 GB | 614 s, 9.0 MB/s average, 0 retries, 0 failures |
| Full rehash of 3,559 files (5.65 GB) | 13 s from Node; 42 s inside the launcher during Repair |
| Errors across all test downloads | 0 |

## Live: packaged launcher 1.2.0
- **Installs:** the silent install over 1.1.0 succeeded, with version 1.2.0.0 on the exe.
- **Fuses:** verified on the exe. RunAsNode, NODE_OPTIONS and inspect are off; OnlyLoadAppFromAsar and cookie encryption are on.
- **Boot:** online, release 1.1.0 installed, 0 pending, "Game Up to Date", PLAY ready, name kept.
- **PLAY:** the game starts. The name file holds "XP" and the client DLL was generated.
- **Error messages:** with the update server unreachable, the real app showed "Can't reach the update server…" instead of `net::ERR_…`.
- **In-game login to the VPS: not confirmed.**
  - **The symptom:** the game ran and responded, but never reached the server-discovery step within 3 minutes.
  - **The same happened with:** release 1.0.0's patch in the same install, and the user's original known-good folder launched the same way.
  - **So it's environmental:** the game waits on something on screen while unattended, such as a title screen or a locked display. It isn't the fresh install, whose files and launch arguments match the known-good folder.
  - **Needed:** a person at the screen to confirm.
- **Repair:** found the one deliberately swapped file and restored it (hash verified).

## Account server (branch `server-hardening`)

All 8 test files pass (`node test/<file>` in `server/`): camo purchase, last breath (11), match result (8), metrics (8), ranked, session (6), shutdown (2), store (11).

Load tests, all local (i7-14650HX, Node 24); the VPS hasn't been measured:

| Run | Errors | p95 |
|---|---|---|
| 30 clients, 5 min (the planned 10 players + 20 bots is lighter) | 0 | 1.82 ms |
| 30 clients, 20-min soak | 0 | 0.94 ms; heap after GC 14.2 → 15.7 → 15.7 MB, so no leak |
| 1,000 clients: production code → new code | 240 → 0 | 733 ms → 11.5 ms |
| 2,000 clients logging in within 10 s | 615 | 331 ms: the breaking point, each login sends the 0.73 MB catalog |

- **Graceful stop:** a WinSW-style Ctrl+C saved everything and node exited 0 (unit, `winsw_stop.ps1`). The real service stop was not run.
- **Watchdog:** a dry run against a dead port restarted once, then backed off ("backoff 5 min") instead of looping. The real scheduled task was not run.
- **Remote crash:** both `get-cards` crashes reproduced on the production code (exit code 1), and are refused on the new code.

Details: SERVER_PERFORMANCE_AUDIT.md.

## Bot AI (draft PR #10)
- **Asset values:** the stock values were confirmed before patching, and a test pak contains all 7 new values plus the 2 ini budgets.
- **Behaviour in a real match:** not run.
