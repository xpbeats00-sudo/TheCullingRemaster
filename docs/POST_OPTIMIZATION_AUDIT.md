# Post-optimization audit (Phase A)

Date: 2026-11-04. This audit closes out the launcher and server optimization plan and checks its results before Phase B starts. Every result below says how it was checked; "not run" means it wasn't.

## Baseline

| Item | State |
|---|---|
| Launcher | 1.2.0 on branch `sync-pause-resume` (PR #11, not merged). Live: 1.1.0 |
| Game release | 1.1.0, live (3,559 files, 6.07 GB) |
| Account server | Live: `main`. Fixes on branch `server-hardening`; dependency patch on `server-deps` (PR #12) |
| Bot tuning | Draft PR #10, untested in a match |

## Verdict

No regression was found in the optimized code. The audit found one **critical issue that predates the optimization work and is live in production now**: any logged-in client can crash the account server with one malformed `get-cards` message. WinSW restarts the server in about 10 s, so a repeat attacker could keep it down. The fix is on `server-hardening` and tested. Deploying it needs your approval (merge, then `Update Culling Server.bat`).

Phase B work can start, because the fix exists and doesn't depend on Phase B. Deploying it is still the most urgent item in NEXT_STEPS.md.

## Checklist (continuation plan section 4)

| Check | Result | Evidence |
|---|---|---|
| Re-run the launcher test matrix | Pass | 57 automated tests (50 from a clean checkout, then 7 added). The live rows are in TEST_RESULTS.md |
| Re-run the server baseline and target-load tests | Pass, locally | 30 clients: 0 errors, p95 1.82 ms. 1,000 clients: 0 errors, p95 11.5 ms. **Not run on the VPS** |
| Signed manifest and release are reproducible | Pass | Rebuilding 1.1.0's manifest from its files matched the prepared one apart from the timestamp. The live release has the same files and hashes, and its signature verifies |
| Installer and launcher signatures validate | **Fail (known)** | Authenticode reports NotSigned for the setup and the exe. Needs a code-signing certificate, which is your decision. Release integrity doesn't depend on it: every release is Ed25519-signed and checked before use |
| Rollback and recovery on a disposable install | Pass, unit only | Tests cover rollback, a simulated power loss mid-commit and journal roll-forward against local servers. A live rollback on a disposable 6 GB install was not run |
| The server supervisor creates no restart loops | Pass, dry run | The watchdog against a dead port restarted once, then logged "backoff 5 min" on every later failure. It is capped at 6 restarts a day and never starts a stopped service. The real scheduled task was not run |
| Memory, timer, handle leaks | Pass, locally | 20-min soak at 30 clients: heap after GC 14.2 → 15.7 → 15.7 MB. Timers per socket are cleared on disconnect, and every table clients can grow is bounded. Actor and delegate leaks don't apply: the VPS runs no game server |
| Compare with the predecessor baseline | Improved | See below |
| Documentation matches the implementation | Fixed 2 mismatches | UPDATE_INFRASTRUCTURE.md said the objects cache rule was in the installer (it is now, on `server-hardening`). LAUNCHER_DOWNLOAD_AUDIT.md listed L9 as partly fixed (it is fixed) |

## Before and after

| Measure | Before | After | How |
|---|---|---|---|
| 3,517 small game files | About 7 min (one at a time) | 28 s (16 at once) | live, this PC to the VPS |
| A stalled connection | Froze forever | Dropped after 30 s, resumed | unit |
| The user's install, 5.50 GB | 190 KB/s before it froze | 9.0 MB/s, 0 retries | live |
| Account server, 1,000 clients | p95 733 ms, 240 errors | p95 11.5 ms, 0 errors | local load test |
| Ranked veteran's profile size | 74 KB | 18 KB | local |

## Found and fixed during this audit

- **Remote crash** (account server): described above. Fixed on `server-hardening`.
- **Level curve:** any client could change the level curve for every player. Now the first report sets it, and only the operator on the VPS can change it. Fixed on `server-hardening`, with a test.
- **3 high-severity dependency issues** (Express, socket.io): patched on `server-deps` (PR #12).
- **Launcher:** player-facing error messages, the offline paused-download display, and a keyboard focus ring. On PR #11.
