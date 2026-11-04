# Launcher download audit

The Culling Remaster launcher, `launcher/` (Electron 33), version 1.2.0, build `928c151`. Written 2026-11-04.

Every claim here carries one of these labels:
- **unit-tested:** covered by the launcher test suites.
- **live-tested:** run against the real VPS.
- **not verified:** neither of the above.

## Architecture

| Part | File | What it does |
|---|---|---|
| Main process | `main.js` | Boot checks, the IPC API for the window, sync / pause / repair / rollback, play, diagnostics |
| Download engine | `lib/sync.js` | Manifest fetch and signature check, planning, parallel download, staging, commit, recovery, rollback |
| Game folder | `lib/game.js` | Install detection (Steam libraries), checks, the default folder, launching through Func |
| Client DLL | `lib/clientdll.js` | Writes `Func.Client.Local.dll` (the player's Func client pointed at the chosen server) |
| Player name | `lib/playername.js` | The name the game shows (Goldberg `force_account_name.txt`) |
| Settings | `lib/config.js` | `%APPDATA%\The Culling Remaster\settings.json`, sanitised |
| Log | `lib/log.js` | `%APPDATA%\The Culling Remaster\logs\launcher.log` (JSON lines, rolled at 1 MB) |
| Window | `src/main-ui.js`, `src/main.html` | Install / Resume / Pause / Repair / Restore, progress, settings |
| Release tools | `tools/make_manifest.js`, `tools/make_release_key.js`, `../patch/make_release.py` | Build and sign releases |

**Networking:** all of it goes through Electron's `net.fetch`, so it uses Chromium's stack: the system proxy and the Windows certificate store. Node's `fetch` is used in the tests. Redirects are refused.

## Manifest

`manifest.json` plus `manifest.json.sig`. The signature is Ed25519 over the manifest's exact bytes. The public key is built into the launcher (`lib/releasekey.js`). The private key stays on the build PC (`%USERPROFILE%\.culling-release\`).

```json
{ "version": "1.1.0", "released": "...", "servers": [{ "id": "xplab", "name": "...", "api": "https://...", "status": "https://..." }],
  "files": [{ "path": "Victory/Content/Paks/pakchunk0-WindowsClient.pak", "size": 679519437,
              "sha256": "…", "url": "objects/<sha256>" }] }
```

Release 1.1.0 (live) has 3,559 files totalling 6,066,014,658 bytes (5.65 GiB). 3,517 of the files are under 1 MB, and those add up to 124 MB.

**What the launcher accepts:** nothing in a manifest is used before its signature verifies (unit-tested). It then refuses:
- **non-https URLs**, including for servers;
- **bad paths:** absolute paths, drive letters, `..`, `:` (alternate data streams), Windows device names (also `con .txt`, `CONIN$`, `COM¹`), names ending in a dot or space, 8.3 short names (`~1`), the launcher's own `.remaster` folder, and two entries naming one file regardless of case (all unit-tested);
- **older releases:** a release older than the one installed is refused (`compareVersions`, unit-tested; the refusal in `main.js` is not verified live).

If the manifest and its `.sig` don't match, which can happen in the instant a publish swaps them, the launcher reads both again once (unit-tested).

## Planning (differential)

For each manifest file, `plan()` checks the target first:

1. **Target matches** (right size, and a verified record whose size, mtime and hash still match): it's OK. It is rehashed when the record is missing or stale, or always in Repair.
2. **Otherwise, staging is checked:** a verified staged copy only needs committing.
3. **Otherwise:** the file is downloaded.

Only missing and changed files download (unit-tested: the one-changed-file and missing-file cases fetch nothing else). Repair (`full: true`) rehashes everything. It caught a corrupted file whose size and mtime record still matched, which the quick check trusts (unit-tested).

## Download engine

- **Parallel:** 16 files at once (measured, see below), and the player can choose 8, 4 or 2. Concurrency halves on stalls or dropped connections, down to 2, and gets one slot back every 20 s without trouble (unit-tested).
- **Bandwidth cap:** an optional shared token bucket, at 1, 2, 4, 8 or 16 MB/s (unit-tested: 3 MB at 1 MB/s takes at least 1.7 s).
- **Stall watchdog:** 30 s without a byte aborts the request. Every chunk re-arms it, so a slow but moving connection is never called stalled (unit-tested).
- **Retries:** six tries per file, with waits of 1, 2, 4, 8 and 16 s, each ±25% jitter. Pause interrupts the waits.
  - The try count resets while a file is making progress, so a long download over a flaky line isn't given up; 40 tries is the absolute cap.
  - Retried: 408, 425, 429, 5xx, network errors, stalls, Range errors and hash failures.
  - Not retried: other 4xx and disk errors (unit-tested).
- **Error kinds:** `stall`, `network`, `http`, `range`, `verify`, `disk`, `paused`, `commit` and `signature`. Disk errors (ENOSPC, EROFS, EACCES, EPERM) stop everything. A file that fails for good no longer stops the others: the sync finishes the rest, then reports "N file(s) couldn't be downloaded", and the next run fetches only those (unit-tested).
- **Range resume:**
  - An incomplete download is kept as `staging/<path>.part`. Files of 1 MB and over get a `.part.json` beside it with the file's SHA-256 and the server's ETag.
  - Resume sends `Range: bytes=<partial length>-` plus `If-Range: <etag>`.
  - **`206`:** accepted only if `Content-Range` is exactly `bytes <have>-<size-1>/<size>`. Otherwise the partial file is dropped and the file starts over (unit-tested).
  - **`200`:** truncates the partial file, never appends to it (unit-tested).
  - **`416`:** accepted when the partial file is already complete, otherwise restarted (unit-tested).
  - **A `.part` from a different release** (its hash differs) is dropped (unit-tested).
- **Verification:** every file is hashed (SHA-256) when it completes. A mismatch deletes it and counts as a failed try (unit-tested).

## Staging, commit, recovery, rollback

1. Downloads land in `<game>/.remaster/staging/`. Nothing in the game folder changes while downloading (unit-tested).
2. When every file is staged, `journal.json` is written (with fsync). Each replaced file then moves to `.remaster/backup/`, and the staged file moves into place. Launcher-managed files the new release no longer has also move to backup. That matters because UE4 mounts every pak in `Paks/`. The player's own files are never touched (unit-tested).
3. The version is marked installed only after the commit. The journal is then replaced by `last-commit.json`.
4. **If the commit fails** (a locked file: the game running, or antivirus), everything already moved is put back. The downloads stay staged, so the next try downloads nothing (unit-tested with a simulated EBUSY).
5. **A crash mid-commit** is finished on the next start, or before any plan, by `recover()`. The commit is idempotent and rolls forward (unit-tested: a hand-built half-commit, and a simulated power loss).
6. **Rollback** restores the version before the last update from `backup/`. It removes files that were new in that update and restores obsolete ones (unit-tested). In the window it's Settings → Restore previous version. Backups are kept until the next update.

**State** (`sync-state.json`) is written atomically (temp file, fsync, rename), at most every 2 s while downloading, and always on pause, failure and finish. The filesystem stays the authority: a record only skips the rehash while size and mtime still match. The first launchers' state format migrates on load (live-tested: the user's own 1.1.0 install moved from launcher 1.1.0 to the new engine with 3,454 of 3,559 files recognised).

**Disk-space preflight:** download bytes not yet on disk plus a 512 MB margin. The folder is also checked for write access first. Backups are renames of the old files, so they need no extra space.

## Measurements (live-tested, 2026-11-04, this PC to the VPS)

| Measurement | Result |
|---|---|
| TCP connect / TLS ready | 108 ms average (max 144) / 215 ms, 20 samples, 0 failures |
| ICMP ping | Blocked by the VPS firewall (100% "loss" means filtered, not lost) |
| This PC's line (Cloudflare 100 MB) | 8.4 MB/s, so the line is the ceiling |
| One stream, 2.4 GB pak | 8.0 MB/s; with 4 streams 7.7 MB/s; with 8 streams 8.4 MB/s |
| 3,517 files under 1 MB, one at a time (old launcher) | About 118 ms each, about 7 min (the 190 KB/s seen in the field) |
| The same with 8 at a time | 54 s |
| The same with 16 at a time | 28 s, all verified |
| A 256 MB pak through the engine | 8.46 MB/s, verified |
| Real resume of the user's install (Electron `net.fetch`, 16 at a time) | 96 of 105 files in the first 30 s; big paks at 6.7–10.1 MB/s |
| Errors across about 7,500 test downloads | 0 |

**Conclusion:** from this PC, a fresh 5.65 GB install is bounded by the player's own line, about 12 minutes at 8 MB/s. The VPS kept up with every concurrency level tested. The old launcher's slowness came from fetching small files one at a time. Its freezes came from having no stall timeout.

## Audit findings and their status

An independent review of the 1.1.0 launcher (launcher 1.1.0 plus the first Pause/Resume build) found the following. A ✔ means fixed in 1.2.0.

| # | Finding | Status |
|---|---|---|
| H1 | A paused fresh install could be launched once Victory.exe was on disk | ✔ Staging keeps the game folder empty until commit; `play` requires a committed version; the window treats any uncommitted release as an install |
| H2 | With the intro off, the window kept its state from before the boot checks | ✔ It's told when boot finishes (`state-changed`) |
| H3 | A stale or corrupt `.part` aborted the whole sync | ✔ The hash check is inside the retry loop; `.part.json` hash and ETag; content-addressed objects never change under a download |
| M1 | Sync reused a stale manifest for the whole session | ✔ Every sync fetches the latest |
| M2 | Files dropped from a release were never deleted | ✔ Removed at commit (managed files only), restored by rollback |
| M3 | An outdated `Func.Client.Local.dll` was reused | ✔ Rebuilt from the current `Func.Client.dll` and compared byte for byte |
| M4 | A locked target failed the sync and could leave the file deleted | ✔ Commit rolls back; the game-running check comes before sync; moves retry for brief antivirus locks |
| M5 | The 10 s manifest timeout included the 1 MB body | ✔ 60 s |
| M6 | Node's fetch ignored the system proxy and Windows certificates | ✔ `net.fetch` (live-tested: the user's install downloaded through it) |
| M7 | A detected Steam copy would be overwritten with the full release | ✔ A Steam copy is used only if the launcher already manages it |
| M8 | A game folder inside the launcher's own folder is wiped on uninstall | ✔ Refused (packaged app) |
| L1 | Check for updates was allowed during a sync | ✔ Refused while busy |
| L2 | 408/429 counted as permanent failures | ✔ Retried |
| L3 | Retry attempts never reset after progress | ✔ They reset; 40-try cap |
| L4 | Pause was ignored while checking files and during backoff | ✔ Both honour the signal |
| L5 | Progress could go negative | ✔ Partial bytes are capped at the file size on both sides |
| L6 | A state-save error became a download failure, or hid a pause | ✔ Logged, not fatal |
| L7 | DevTools and reload shortcuts available | ✔ No menu; DevTools off in the packaged app |
| L8 | A kill in the first seconds left an unusable folder | ✔ `.remaster` is created before anything else (write probe) |
| L9 | After a paused install, an offline boot showed "Not installed" | Partly fixed: the paused progress shows once online. Offline it still reads "Offline" |
| L10 | Publish swapped `.sig` before `manifest.json` | ✔ The launcher re-reads once on mismatch |
| S1 | Downgrades and frozen releases were accepted | ✔ Downgrades refused. Freeze (no expiry) is not addressed: see KNOWN_ISSUES |
| S2 | Windows path-rule gaps | ✔ All reproduced cases refused (unit-tested) |
| S3 | Redirects bypassed the https check | ✔ Redirects refused |
| S4 | Electron fuses not flipped | ✔ The afterPack hook; verified on the built exe: RunAsNode, NODE_OPTIONS and inspect off, OnlyLoadAppFromAsar on |
| — | No code signing (SmartScreen) | Open: needs a certificate (cost and identity, your decision) |

## Test coverage

`npm test` in `launcher/` runs 49 tests: sync 16, update 18, config 5, game 6, player name 4. The update suite covers the plan's launcher test matrix:
- fresh install, up to date, one changed file, a missing file, a corrupt file;
- pause during download and resume after a restart;
- network drops and stalls, a server ignoring Range, an invalid Content-Range, HTTP 416;
- a failed commit and recovery, rollback;
- signature and path validation, the bandwidth cap, and adaptive concurrency.

Not covered by automated tests:
- a really full disk (only the preflight and error classification are);
- a real machine reboot mid-commit (simulated);
- optional content (the release has none).
