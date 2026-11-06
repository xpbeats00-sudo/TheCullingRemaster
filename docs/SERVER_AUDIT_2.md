# Server audit 2: account server, VPS scripts, publishing

Date: 2026-11-05. Branch `server-audit-2` (from `origin/audit-combined` at d8f4573).

Scope: `server/` (accounts, sessions, match tickets, match results, ranked incl. team modes, Showdown incl. team Showdown, party/friends/lobby/matchmaking, playlists, leaderboard, activity, weather/night maps, custom match, store, metrics), `deploy/` (`install_vps.ps1`, `culling_watchdog.ps1`, `publish_release.ps1`, `stage_objects.js`, `check_published.js`, `verify_release.js`), `Update Culling Server.bat`, `Publish Release.bat` and their docs.

The live VPS (217.60.97.88, https://xplab.shop:8443) is production and was only read: `GET /health` (`{"ok":true,"users":1,"matchesToday":2,"playersWeek":2}`, 1.0 s) and a `GET` of the public `manifest.json` (200). Nothing was deployed or published. Everything below was run on the build PC (Windows 11, Node 24.15, Windows PowerShell 5.1).

Counts: **19 findings**: 12 fixed, each with a regression test (for the installer: parse and ordering checks), 1 worked around in the tests (T2), 6 open with the reason; plus the areas checked where nothing was found. Tests: server 274 -> 287 cases (26 -> 28 files), deploy 19 -> 36 (3 -> 6 files), all passing.

## Findings

Severity is for this server today (a few players, one VPS); "at scale" says when it grows.

| # | Severity | Area | Finding | Status |
|---|---|---|---|---|
| D1 | High | Publish / update bats | The bats lose their place when `git pull` changes them; the publish never runs and says nothing useful | FIXED |
| D2 | High | `publish_release.ps1` | No log, no final verdict line, exit code lost, no check of the live version | FIXED |
| D3 | Medium | `install_vps.ps1` | Update replaced the code under the running service, no backup, no rollback, a failed `git pull` ignored | FIXED (not run on the VPS) |
| D4 | Medium | Data | No backup of `C:\culling\data` at all | FIXED (local; off-site is your decision) |
| F4 | Medium | Match results | A ticket without a mode is a 500 after the ticket is taken and the pay added in memory | FIXED |
| F5 | Medium | Parties | A leader leaving with an invite out leaves an empty, leaderless party that the invitee joins alone | FIXED |
| F6 | Medium | Robustness | An exception in a lobby timer (match set-up, broadcast) or the party-offline timer stops the whole server | FIXED |
| P2 | Medium at scale | Friends | One status change of a player with 200 friends online blocks the event loop ~85 ms | FIXED (~15 ms) |
| F7 | Low | Input | A request body of JSON `null` is a 500 on every route that reads the body | FIXED |
| F8 | Low | Memory | Presence entries of players who closed the game after a result are never dropped | FIXED |
| P1 | Low (Medium at scale) | Leaderboard | The season is worked out from the date 5 times per player per computation (250 ms at 50,000 players) | FIXED (164 ms) |
| T1 | Low | Tests | Killed test servers' temp folders sometimes still busy on Windows (EBUSY): `audit.test.js` failed at random | FIXED |
| T2 | Low | Tests | `cmd /c "x.bat"` doesn't reliably exit with the bat's `exit /b` code | Worked around (`call`); documented |
| O1 | Medium | Data | An unreadable `profiles.json` / `accounts.json` / `friends.json` at start: the server runs empty and later overwrites it | OPEN: your decision |
| O2 | Medium | Security | The operator endpoints trust any process on the VPS that connects over loopback | OPEN: your decision |
| O3 | Low | Economy | A Showdown series pays after 15 s however many rounds; round reports have no minimum time | OPEN: balance decision |
| O4 | Low (High at scale) | Saving | Whole-file JSON saves (known from SERVER_PERFORMANCE_AUDIT.md) | OPEN: scaling decision |
| O5 | Low | Leaderboard | Still computed on the event loop: 164 ms every 30 s at 50,000 players | OPEN: not needed yet |
| O6 | Low | Install | The installer's rollback and backup steps haven't been run on the VPS | OPEN: needs the VPS |

### D1. The bats lost their place after `git pull` (the publish that "did nothing")

**Evidence.** cmd reads a batch file one line at a time and remembers the byte position. Both bats ran `git pull --ff-only` as a line of their own and kept reading afterwards. When the pull changed the bat, cmd read the rest from the old position in the new file. For every update `Publish Release.bat` has had, the position after the pull line fell mid-line in the new file:

```
cdf31b4 -> ddd82e6: old bat resumes at byte 939 of the new one: MID-LINE: "dows asks."
ddd82e6 -> 5ad3aa9: old bat resumes at byte 1041 of the new one: MID-LINE: "and answer Yes when Windows asks."
```

So the running copy executed `and answer Yes when Windows asks.` (`'and' is not recognized ...`), then the next lines of the `no_admin` section (`pause`, `exit /b 1`), and closed without running `publish_release.ps1`. That matches the two silent publishes you hit. `deploy/bats.test.js` reproduces it from the old files kept in `deploy/fixtures/`: `publish_release.ps1` is never called and cmd prints "not recognized".

Also: the bats ended with `... & echo. & pause & exit /b`, which exits 0 whatever happened, and a failed `git pull` was ignored.

**Fix.**

- The pull and the call to the updated file are one parenthesized block, which cmd reads whole before running it. The updated file then runs from its start (the `pulled` pass skips the block). Changes anywhere in a bat are safe from now on.
- For the update from today's bats to these: everything above the old pull line is byte for byte the same, and the pull line became `rem ==============` (18 characters, as long as `git pull --ff-only`). A copy of today's bat, which resumes right after its pull, lands exactly on the new block. `deploy/bats.test.js` runs today's bat (fixture `5ad3aa9`) pulling the new one and checks the publish runs once.
- A failed `git pull` stops with `PUBLISH FAILED: "git pull" failed ...` (or `UPDATE FAILED ...`), exit 1.
- The last line is `===== PUBLISHED <v> =====`, or a red window and `===== PUBLISH FAILED, exit code N ... =====`. The exit code is the PowerShell script's.
- `CULLING_RELEASES` overrides `\\tsclient\C\Culling\releases`; `CULLING_NO_PAUSE=1` skips the pauses.

**Tests** (`deploy/bats.test.js`, 9): cmd runs the real bats in a temp folder with stand-ins for `fltmc`, `git` and `powershell` (`deploy/fixtures/fake_tool.cs`, compiled with the .NET Framework's `csc`; a `.cmd` stand-in can't work, because cmd never returns from a batch file run without `call`). Covered: the old failure reproduced; old bat pulling the new one (Publish and Update); the new bat pulling a later one with extra lines at the top; a failed publish and a failed install (non-zero exit, FAILED line); a failed pull; the version from `releases\LATEST`; no version at all; the byte-identical prefix.

### D2. `publish_release.ps1`: failures weren't loud and nothing was logged

**Evidence.** The script printed the steps and threw on failure, but there was no log file, and node's output (signature check, the plan, the upload, the check) went straight to the console: a PowerShell transcript doesn't capture native output written directly to the console (checked: `Start-Transcript` captured `Write-Host` and piped native output, not direct native output or its stderr). Success ended with `Published <v> in N s.`: it didn't say what launchers now see, nor that the version was already live (nothing copied) or older than the live one (launchers refuse downgrades). Together with D1, you couldn't tell whether anything had happened.

**Fix.**

- Everything printed goes to `C:\culling\logs\publish-<time>.log` (transcript; node is run through `Invoke-Node`, which passes its stdout and stderr through the host so they're in the log). The newest 30 logs are kept.
- The script ends with exactly one verdict line, then `Log: <path>`:
  - green `PUBLISHED <v> in N s: https://xplab.shop:8443/remaster/manifest.json says <v> (was <old>).`, with a yellow `NOTE` before it when `<v>` was already live or is older than the live release;
  - red `PUBLISH FAILED: nothing was published (<old> is still live): <why>`;
  - red `PUBLISH FAILED AFTER GOING LIVE: release <v> is live, but: <why>`.
- Exit code 1 for every failure, 0 only for PUBLISHED.
- The final check (`check_published.js`) now also takes `--version <v>` and fails if the live manifest says another version (it already compared the manifest's bytes with `--expect`).
- `-Node` and `-LogDir` parameters (default `C:\culling\node\node.exe` and `C:\culling\logs`); a missing node is a clear error.

**Tests.** `deploy/publish_script.test.js` (3) runs the real script in Windows PowerShell against temp folders: a release folder that isn't there; an unsigned release with a live `1.3.9` (refused at the signature, `1.3.9 is still live`, node's own `signature does not verify` in the log, the live manifest untouched); log rotation. A successful publish needs a release signed with the launcher's key, so it isn't run here; its steps are covered by `deploy/publish.test.js` (7, one new: `--version`).

### D3. Updating the server: no backup, no rollback, code replaced under the running service

**Evidence** (`install_vps.ps1` before):

- The code was copied over `C:\culling\app` and `npm ci` (which deletes `node_modules` first) ran there while the service was still running; the service was only stopped later. A crash in that window (WinSW restarts node at once) would have started half-copied code without its packages.
- No copy of the previous code and no rollback: if the new code didn't start, the last step (`Invoke-RestMethod /health` 2 s after `Start-Service`) threw and the server stayed down on the new code.
- No backup of the data before an update.
- `Update Culling Server.bat` ignored a failed `git pull` and reinstalled the old code; it always exited 0; nothing was logged.

**Fix** (`install_vps.ps1`):

1. The new code is built in `C:\culling\app.new` (copy, `npm ci`, `node --check server.js`, a load check of express and socket.io) while the old server keeps running. A failure here leaves the server untouched.
2. Only then the service is stopped (it saves everything), and `C:\culling\data` is backed up to `C:\culling\data\backups\pre-update-<time>` with `server\backup.js` (each file's size and SHA-256 recorded and checked; the newest 10 kept).
3. The code is swapped (`app` -> `app.previous`, `app.new` -> `app`), the catalog copied, the service started, and `/health` awaited for up to 60 s (`-StartTimeoutSeconds`). If it doesn't answer: stop, `app` -> `app.failed`, `app.previous` -> `app`, the catalog from the backup, start, wait again.
4. A failure at any point after the stop puts the previous code back and starts it. The last line says what state the server is in: `SERVER UPDATED ...`, or `UPDATE FAILED: <why>. rolled back: the previous code is running and answering /health ...` (or `... the server is DOWN ...` when even that fails). Log: `C:\culling\logs\update-<time>.log`. Exit code 0 only for SERVER UPDATED.

Downtime is now the stop, the backup (seconds) and the start; `npm ci` no longer counts.

**Tests.** `deploy/install_script.test.js` (4): every deploy `.ps1` parses (PowerShell's own parser); `npm ci` and the checks run in `app.new` before the stop and nothing is copied into the live `app` before it; the backup runs after the stop and before the swap; the rollback follows a failed health wait; the verdict lines, transcript and exit code are there. **Not run:** the installer itself (it needs administrator rights and the real service). See O6.

### D4. No backups of the player data

**Evidence.** Nothing copied `C:\culling\data` anywhere: not the installer, not the watchdog, not the server. The only copies were `import-backups` (one profile, on an operator import) and `*.unreadable-*` (see O1). A bad update, a disk error or an operator mistake would have lost every account and profile.

**Fix.** `server/backup.js`:

- A snapshot is a folder `<label>-<UTC time>` (e.g. `daily-20261105T040000Z`) with a copy of every data file (`*.json`, `*.txt`, `*.ini` at the top of the data folder: profiles, accounts, sessions, friends, tickets, Showdown series, activity, the level curve, the catalog, the IP-hash secret; never temp files, logs or other backups) and `backup.json` listing each file's size and SHA-256. It is written as `.partial` and renamed when complete.
- `verify` checks every file against `backup.json` and that each JSON file parses.
- The server takes a `daily` snapshot when the newest is older than a day, after writing everything it holds to disk (so the snapshot is complete), and keeps the newest 14. Settings: `CULLING_BACKUP_DIR` (default `<data>\backups`), `CULLING_BACKUP_EVERY_MS` (default 24 h, 0 = off), `CULLING_BACKUP_KEEP` (14). `/metrics` shows `backups.last` (time, folder, files, bytes, ms) or its error; a failure counts as `errors.backup`.
- The installer takes `pre-update` snapshots (D3).
- To restore: stop the service, `node C:\culling\app\backup.js verify <snapshot>`, copy its files over `C:\culling\data`, start the service.

The snapshot copies files synchronously right after the synchronous flush, once a day; with today's few-MB data folder that's milliseconds (it is timed in `/metrics`).

**Tests.** `server/test/backup.test.js` (4): what a snapshot holds and leaves out, verify catches a changed or broken file; rotation per label, other labels untouched, a crashed `.partial` removed, two snapshots in one second, an invalid label refused; the CLI the installer runs (snapshot, list, verify, failure exits 1); the server's own daily snapshot holds a profile that was only in memory (60 s save delay), is rotated to `CULLING_BACKUP_KEEP` and shows in `/metrics`.

### F4. A match result on an older ticket: 500 after the ticket was taken

**Evidence.** `server.js:628` (before): `const mode = claim.ticket.mode || (showdown ? SHOWDOWN.queue : 'ffa');`. `showdown` stopped existing in that function when Showdown results moved to `showdownMatchResult`. Every ticket the current server issues has a mode, but a `tickets.json` written by a server from before the `mode` field (restored after an update; tickets live 3 hours) has none. Then the route throws a `ReferenceError` after `tickets.claim` took the ticket and after `p.cullCredits += credits`, the ranked result and the XP were applied in memory, but before `saveProfiles()`: the HUD got a 500, the result couldn't be posted again (`no-match`), and the half-applied changes were saved only with the next unrelated change. Reproduced: `audit2.test.js` F4 got `500 {"error":"server-error"}` before the fix.

**Fix.** A ticket without a mode is Solo (`'ffa'`).

**Test.** `server/test/audit2.test.js` F4: a server started with such a `tickets.json` pays the result (200), counts it as Solo, no 5xx in `/metrics`.

### F5. A leader leaving with an invite out left a party with nobody leading it

**Evidence.** `friends.js` `leave()` (before) kept a party of one or fewer while any invite to it was pending (`pendingFor`), so the leader's party could wait for the invitee. With the leader gone (leaving, or removed after 2 minutes offline by `watchPartyOffline`) the party had no members and `leader: null`, and the invitee could still accept: they joined alone a party whose leader was `null`, so their own invites failed (`not-party-leader`) and the panel showed no leader. `pendingFor` also counted expired invites, so a party of one stayed for good once an invite had expired. Reproduced by the new unit tests failing (`the empty party is dropped: true !== false`).

**Fix.** A party with no members is always dropped (and its invites with it); a party of one is kept only while an unexpired invite is out; an invite to a party with no members can't be accepted; empty per-player invite lists are removed.

**Tests.** `server/test/friends.test.js` (2 new): the leader leaving with an invite out; an expired invite not keeping a party of one.

### F6. An exception in a timer stopped the server

**Evidence.** Socket handlers are wrapped (an exception is logged and counted), but the lobby timers (`matchlobby.js`: gather timer -> `countdown` -> `broadcast` -> `describe`/`send`; countdown timer -> `launch` -> `start` = `allocateMatch` -> `launchMatch` for every member: ranked start, tickets, presence, friends pushes) and the party-offline timer ran with nothing around them. `server.js` exits on any uncaught exception (`process.on('uncaughtException', ... process.exit(1))`), so one bug in that path, for one player, took every player offline until WinSW restarted it, and that lobby's players were never told. Reproduced with fault injection: with the old `matchlobby.js`, `CULLING_FAULT_ALLOCATION=throw` made the server exit and the player got no `join-mm-fail`.

**Fix.**

- `MatchLobbies` catches a throw in `start` and in each member's `describe`/`send`, and reports it (`onError(error, lobby, where)`); the other members still get their update.
- The server's `onError` counts it (`errors.timer` in `/metrics`), logs it, and tells every member `join-mm-fail` (`allocation-failed`, "The match could not be set up. Nobody was sent in: queue again.").
- `allocateMatch` starts each member's match separately: one that throws is told, the others are sent in.
- The party-offline check, the friends push and a new presence sweep run through `guarded()`.

**Tests.** `server/test/matchlobby.test.js` (1 new, on a fake clock): a throwing `send` and `start` are reported, never thrown out of the timer, and the players are out of the lobby. `server/test/audit2.test.js` F6: with `CULLING_FAULT_ALLOCATION=throw` the player gets `join-mm-fail`, the server keeps answering `/health`, `errors.timer` is counted, and the player can queue again.

### P2. Friends: one status change cost O(friends x their friends) on the event loop

**Evidence.** Each status change (searching, lobby, match, menu) runs `notifyFriends`, which rebuilt and sent the whole friends panel of every friend online; each panel builds an entry (name, card, rank, status) for each of that friend's friends. `server/test/friends_load.js` (new) seeds N accounts who are all friends with each other, logs them all in on their own addresses, and has one player queue and cancel 10 times; `/metrics` timed the socket events (handler time is event-loop time):

| Players online, all friends | Before: `join-mm` p50 / max | After: handler p50 / max | After: the coalesced push, p50 |
|---|---|---|---|
| 21 (20 friends) | 1.9 / 3.0 ms | | |
| 101 (100 friends) | 24.6 / 34.9 ms | 0.27 / 1.6 ms | 6.0 ms |
| 201 (200 friends, the cap) | 85.2 / 101.0 ms (`leave-mm` max 137 ms) | 0.37 / 1.7 ms | 15.3 ms |

Every panel is 27 KB at 200 friends, so a change sends 200 x 27 KB = 5.4 MB in both versions; the encoding is most of what remains.

**Fix.** `sendFriends` marks the player's panel as changed; everything changed during one turn of the event loop is sent once, right after it (`setImmediate`), and each player's entry is built once for all the panels that show it. The pushes are timed in `/metrics` as `(friends push)`. Same event, same payload; it can only arrive a moment later and, when two changes happen in the same turn, once instead of twice. All friends, party, playlists, Showdown and ranked team tests pass unchanged.

**Test.** `audit2.test.js` P2: accepting a friend request changes both players' panels twice in one turn (`notifyFriends` of each); each player now gets one push, with the new friend in it. Against the previous `server.js` it fails (`pushes to A: 2`).

**Open:** a change still sends every friend's full panel (5.4 MB at 200 friends). Sending only the changed entry would need a new event in the menu's `Friends.js`; not done.

### F7. A JSON `null` body: 500

**Evidence.** `bodyObject()` returned whatever `JSON.parse` gave for a text body, so `null` (or a number) made routes read `body.userid` / `.level` / `.username` from `null`: a `TypeError`, a 500 and an `http5xx` count on `/api/login`, `/api/matchresult`, `/api/setlevel`, `/api/account/register` and `/api/account/login`.

**Fix.** A body that isn't a JSON object is no fields (`{}`): those requests get their normal 400/401/409.

**Test.** `audit2.test.js` F7: `null` on those five routes is never a 5xx; `/api/login` gives 400; no 5xx counted.

### F8. Presence entries that never went away

**Evidence.** The HUD's result calls `setPresence(userID, 'menu')`; a player who had closed the game during the match has no socket, so that created an entry nothing ever removed (the next login removes it, if there is one). Also, an entry left by a match that never reported stayed until the player came back. One small object per such player; unbounded over time.

**Fix.** `setPresence(..., 'menu')` for a player with no menu connected removes the entry (their friends see "Offline" either way); a sweep every 10 minutes drops entries of players with no menu and no open match. `/metrics` reports `presence` (the map's size).

**Test.** `audit2.test.js` F8: a player queues, the game closes, the result comes in: `presence` is 0 (it was 2 before the fix, with the F4 player).

### P1. Leaderboard: the season worked out per player

**Evidence.** `ranked.CONFIG.season` is a getter that computes the season from the date (two `Date.parse` and an object each time). `leaderboard.js` read it five times per player per computation, and the sort comparator recomputed every value on each comparison. Measured (in-process, synthetic profiles with ranked records, `compute()` alone): 1,000 players 7.6 ms, 10,000 47.3 ms, 50,000 250.3 ms, of which the season getter alone was ~70 ms. A computation runs on the event loop at most every 30 s after a change.

**Fix.** The season is read once per computation; each board's value and tie-break are computed once per row, then sorted. Same output. After: 5.8 ms, 33.7 ms, 164.4 ms.

**Test.** `server/test/leaderboard.test.js` (1 new): computing the boards for 200 players reads the season at most 3 times (402 before), and the boards are unchanged. The 14 existing leaderboard tests pass.

### T1, T2. Test harness

- **T1.** `audit.test.js` failed at random on the unchanged branch: exit 127 after its first test in the first full run, then exit 1 after all 16 had passed in one of three reruns (and not in six more). The error output wasn't captured, so the cause is the likely one, not a proven one: the tests kill the server and immediately delete its temp folder, and on Windows that folder can still be busy (EBUSY), which `fs.rmSync` throws. The helper's `stop()` and `audit.test.js` now retry the delete (`maxRetries`), and a folder that stays busy is left in `%TEMP%` rather than failing the run. It didn't recur in the later full runs.
- **T2.** Found while testing the bats: `cmd /c "x.bat"` exited 0 after an `exit /b 1` inside a block most of the time (measured 0,0,0,0,0 and 0,0,0,0,1), and with a pipe as stdin it varied too; `cmd /c call "x.bat"` always passed the code on. Double-clicked bats don't report a code anywhere (their banner is what counts); for scripted runs use `cmd /c call "Publish Release.bat" <version>`.

## Open, with the reason

- **O1 (Medium): an unreadable data file at start.** `server.js:234-243`, `accounts.js:165-177`, `friends.js:34-45`: if `profiles.json`, `accounts.json` or `friends.json` can't be parsed, a copy is kept as `*.unreadable-<time>` and the server runs with none of it: players see fresh profiles, their accounts don't exist, and the next save overwrites the file. Saves are atomic (temp file, fsync, rename), so only a disk fault or a hand edit gets there. Options: refuse to start (the service then fails and stays down until someone looks), or start from the newest verified daily backup (loses up to a day). **Needs your choice.** I'd refuse to start, since the watchdog and the update's health check now make that visible.
- **O2 (Medium): operator endpoints and loopback.** `/admin/import-profile`, `/admin/reset-password` (returns a new password), `/metrics` and the level-curve override answer any connection from 127.0.0.1 that carries no proxy headers (`server.js:919`, `metrics.js:201`). Caddy always adds `X-Forwarded-For`, so the internet can't reach them. But any program on the VPS can: Superstar Racing's server, a compromised process, or a request a local service can be tricked into making. Fix if you want it: an operator secret in a file only administrators can read (`account_admin.js` sends it), checked in addition to loopback.
- **O3 (Low): Showdown pay rate.** A series pays once it is over and its match ran 15 s (`CULLING_SHOWDOWN_MIN_SECONDS`), however many rounds were reported; `/api/showdown/round` has no minimum per round. Results are trusted from the player's own client by design (bots only), but 4 reported round wins in 15 s pay 2,000 XP and 240 credits: per minute, several times what a real Solo match pays (minimum 120 s). A minimum per round (say 20 s each) would bound it. **A balance decision.**
- **O4 (Low today, High at scale): whole-file saves.** Unchanged from `SERVER_PERFORMANCE_AUDIT.md`: each save serializes every profile on the event loop (~420 ms at 10,000 veteran profiles). Past a few thousand active players, move to per-profile files or SQLite. **A scaling decision.**
- **O5 (Low): leaderboard on the event loop.** After P1 it's 164 ms at 50,000 account players, at most every 30 s while results come in. Fine for now; at that size, compute it incrementally or in a worker.
- **O6 (Low): the installer's new steps haven't run on the VPS.** The swap, backup and rollback are parse- and order-checked, not executed (administrator rights and the real service). The first update with this code is its first real run: watch its last line, and check `C:\culling\data\backups\pre-update-*` and `C:\culling\app.previous` exist afterwards.

## Checked, nothing found

- **Double pay / lost results:** a ticket pays once (`tickets.claim` deletes it); a replayed result gets `no-match`; ranked results are scored only against the pending match the ticket names, with the last 100 match IDs remembered; a Showdown series pays once (`claimPayout`). Shared addresses are told apart by the HUD's name, else refused (`ambiguous`).
- **Ticket expiry:** 3 h TTL, the open and recent maps stay oldest-first (re-inserted on change, sorted on load), expiry stops at the first live entry. A match never runs that long (25 min).
- **Season rollover:** a ranked match started in one season and reported in the next is not scored (the rollover clears `pending`); its XP and credits are still paid. The season getter is now read once per leaderboard computation (P1).
- **Races:** the server is one thread and no handler awaits between checking and changing state (registration re-checks the name after its `await` on the password hash). Party queueing is checked and done in one turn.
- **Auth:** game tokens 24 random bytes, account tokens 32 bytes stored as SHA-256 only, scrypt passwords behind a 2-at-a-time gate, play grants per hashed address, per-address and per-name login limits with the player's known addresses exempt.
- **Rate limits:** HTTP 20/s (burst 60) and socket events 30/s (burst 90) per address before any parsing, friend actions, leaderboard, new profiles, sign-ups and logins each limited.
- **Input validation:** every socket event checks its fields (queue names, card IDs, map names, user IDs, mods, party IDs, usernames); bodies are capped at 1 MB and socket messages at 1 MB.
- **Prototype pollution:** profiles, accounts and friends are null-prototype maps keyed by validated IDs; imported profiles go through `cleanValue`, which drops `__proto__`, `constructor` and `prototype`.
- **Path traversal:** the only path built from input is the import backup's file name, which keeps `[A-Za-z0-9_-]` only. Express serves no files.
- **Secrets in logs:** passwords are never logged, the bodies of unknown `/api/account` and `/admin` URLs aren't logged, the socket `login` event (the token) isn't in the access log, the reset password is returned, not logged.
- **CORS `*`:** only bearer tokens are used, never cookies, so another website can't act as a player or read a reply that needs a token.
- **Unhandled rejections:** logged and counted, not fatal; async routes go to the JSON error handler.
- **Watchdog:** probes `/health` every minute (5 s timeout), restarts after 3 failures with 5 to 60 minute backoff, at most 6 a day, never starts a deliberately stopped service, keeps its state and log in `C:\culling\data\logs`. Nothing to change; note that after an update whose rollback also fails, the service is running-but-failing and the watchdog's backoff applies.
- **Store:** atomic temp-file + fsync + rename, coalesced, a stale async write never renamed over a newer sync flush, rename retried on Windows sharing errors.

## What changed

Server (`server/`):

- `server.js`: F4, F6 (`lobbyFailed`, per-player guard in `allocateMatch`, `guarded()`, `CULLING_FAULT_ALLOCATION=throw`), F7 (`bodyObject`), F8 (presence removal and 10-minute sweep, `presence` in `/metrics`), P2 (coalesced friends pushes, `(friends push)` timing), D4 (daily backups, `backups` in `/metrics`).
- `backup.js` (new): snapshots, rotation, verify, CLI.
- `friends.js`: F5. `matchlobby.js`: F6 (`onError`). `leaderboard.js`: P1. `metrics.js`: `timer` and `backup` error counters.
- Tests: `test/audit2.test.js` (new, 5), `test/backup.test.js` (new, 4), new cases in `friends.test.js` (2), `matchlobby.test.js` (1), `leaderboard.test.js` (1); `test/friends_load.js` (new measurement script, not a test); `helpers.js` and `audit.test.js` (T1).

Deploy:

- `Publish Release.bat`, `Update Culling Server.bat`: D1.
- `deploy/publish_release.ps1`: D2. `deploy/check_published.js`: `--version`. `deploy/install_vps.ps1`: D3, D4.
- Tests: `deploy/bats.test.js` (new, 9), `deploy/publish_script.test.js` (new, 3), `deploy/install_script.test.js` (new, 4), `deploy/publish.test.js` (+1); fixtures in `deploy/fixtures/` (the three earlier bats and the stand-in tool's source).
- `docs/UPDATE_INFRASTRUCTURE.md`: how a publish and an update end, backups and restoring.

No API shape the menus, HUD or launcher read has changed: same events and payloads, same routes and replies; `/metrics` (operator only) has new fields.

## Test results

Run on the final code (`node <file>` each, Node 24.15, Windows 11; `NODE_PATH` to the main clone's `server\node_modules`). Before the changes the branch had 274 server cases in 26 files and 19 deploy cases in 3 files, all passing (one `audit.test.js` flake, T1).

```
server/test/accounts.test.js  exit 0  all 14 account tests passed
server/test/activity.test.js  exit 0  all 4 activity tests passed
server/test/airdrop_prices.test.js  exit 0  all 5 airdrop price tests passed
server/test/airdrops.test.js  exit 0  all 4 airdrop tests passed
server/test/audit.test.js  exit 0  all 16 audit tests passed
server/test/audit2.test.js  exit 0  all 5 audit 2 tests passed
server/test/backup.test.js  exit 0  all 4 backup tests passed
server/test/camopurchase.test.js  exit 0  all camo purchase tests passed
server/test/custommatch.test.js  exit 0  all 11 custom match tests passed
server/test/deploy.test.js  exit 0  all 2 deploy tests passed
server/test/field.test.js  exit 0  all 5 field tests passed
server/test/friends.test.js  exit 0  all 25 friends tests passed
server/test/lastbreath.test.js  exit 0  all 11 lastbreath tests passed
server/test/leaderboard.test.js  exit 0  all 14 leaderboard tests passed
server/test/matchlobby.test.js  exit 0  all 14 match lobby tests passed
server/test/matchqueue.test.js  exit 0  all 5 matchqueue tests passed
server/test/matchresult.test.js  exit 0  all 8 matchresult tests passed
server/test/metrics.test.js  exit 0  all 8 metrics tests passed
server/test/party.test.js  exit 0  party tests: 17 passed, 0 failed
server/test/playlists.test.js  exit 0  all 12 playlist tests passed
server/test/ranked.test.js  exit 0  all ranked tests passed
server/test/ranked_teams.test.js  exit 0  all 23 ranked team tests passed
server/test/season.test.js  exit 0  all 4 season tests passed
server/test/session.test.js  exit 0  all 6 session tests passed
server/test/showdown.test.js  exit 0  all 25 showdown tests passed
server/test/shutdown.test.js  exit 0  all 2 shutdown tests passed
server/test/store.test.js  exit 0  all 11 store tests passed
server/test/weather.test.js  exit 0  all 8 weather tests passed
deploy/bats.test.js  exit 0  all 9 bat tests passed
deploy/install_script.test.js  exit 0  all 4 install script checks passed
deploy/make_manifest.test.js  exit 0  all 3 make_manifest object tests passed
deploy/publish.test.js  exit 0  all 7 publish tests passed
deploy/publish_script.test.js  exit 0  all 3 publish script tests passed
deploy/stage_objects.test.js  exit 0  stage_objects: all 10 checks passed
server test cases passed: 287; files failed: 0
```

Totals: server 287 cases in 28 files (+13: audit2 5, backup 4, friends 2, matchlobby 1, leaderboard 1); deploy 36 cases in 6 files (+17: bats 9, install_script 4, publish_script 3, publish 1).

Regression checks against the code before each fix (new tests run on the old code): F4 `500 !== 200`; F5 `the empty party is dropped: true !== false`; F6 (old `matchlobby.js`) `no join-mm-fail`, the server exited; P1 `season read 402 times for 200 players`; P2 (previous `server.js`) `pushes to A: 2`; the matchlobby unit test threw `Error: send broke` out of `join`; D1 the old bats never called `publish_release.ps1`.

Load (`node test/load.js --clients 30 --duration 120`, the planned peak of SERVER_PERFORMANCE_AUDIT.md, final code): 1,073 operations, **0 errors**, p50 0.74 ms, p95 11.71 ms, p99 16.8 ms over all operations (the login phase's ~15 ms client timer tick, see that audit's section 2; `POST /api/matchresult` p95 3.67 ms, `join-mm` p95 9.35 ms), event-loop utilization 1.3%, heap after GC 15.2 -> 15.7 -> 16.0 MB at 6, 60 and 118 s, profile saves at most 2.1 ms on the event loop.

Friends fan-out: `node test/friends_load.js --players <N> --changes 10` (table in P2).

## Recommendations that need your decision

1. **Off-site backups.** The daily and pre-update snapshots are on the VPS's own disk, next to the data: they cover a bad update, a corrupted file or an operator mistake, not losing the VPS or its disk. Choose where a copy should go (Hostinger's own VPS backups or snapshots, a storage bucket, or this PC over the Remote Desktop share when you publish) and how often; a scheduled copy of `C:\culling\data\backups\daily-*` is then a few lines.
2. **O1:** refuse to start on an unreadable data file (my recommendation), or start from the newest backup.
3. **O2:** add an operator secret to the loopback-only endpoints, given the VPS also runs Superstar Racing.
4. **O3:** a minimum time per Showdown round, if the pay rate matters.
5. **Scaling (O4, O5, P2's full panels):** none is needed at today's player count. The order when it grows: profile storage (SQLite), then friends deltas, then the leaderboard off the event loop. One process carries a few thousand players (SERVER_PERFORMANCE_AUDIT.md).
6. **The first update with this code (O6):** run `Update Culling Server.bat` when you can watch it; it should end with `SERVER UPDATED`, and `C:\culling\data\backups\pre-update-*` should exist. The first publish after it runs the old bat one last time; thanks to the 18-character line it lands on the new block (tested), and from then on the bats can change freely. One caveat: that holds for the VPS clone's current `Publish Release.bat` being the 5ad3aa9 version (the one on `main` since 2026-11-04). If the clone is older (ddd82e6), that first run stops once more with a "not recognized" line; run it again and it works.
