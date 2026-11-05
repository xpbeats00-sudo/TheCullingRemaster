# Loading time optimization report

Branch `hud-loading`, 2026-11-05. What can be measured about loading without
changing the game, where the time and bytes go, what was changed (each with a
before/after taken here), and how to measure game load times in game.

Statuses: **PASS** measured, **FAIL**, **PARTIAL** (part measured),
**NOT TESTED**, **BLOCKED** (needs something not available here).
No claim below says the game loads faster: no in-game timing was taken in this
change (see "In-game measurement procedure").

## 1. What is measurable today

| Source | Where | What it gives | Status |
|---|---|---|---|
| Game log (Unreal) | Would be `%LOCALAPPDATA%\TheCulling\Saved\Logs\Victory.log` (the game's saved dir: `SaveGames`, `Config` and crash reports are there) | Nothing by default: that folder holds only `UE4CC-Windows-*` crash-report folders (minidump + context, no log), on this PC and in the launcher's sandboxed copy. The exe does contain Unreal's log strings (`Took %f seconds to LoadMap(%s)`, `LoadMap: %s`, `ABSLOG=`), so logging is compiled in; whether `-log` or `-ABSLOG=<file>` reaches `Victory.exe` through `Func.Launcher.exe` is untested. | BLOCKED (needs a game run) |
| Launcher log | `%APPDATA%\The Culling Remaster\logs\launcher.log`, JSON lines | Launcher start → boot checks done. New in this change: `play` (PLAY pressed, game spawned) and `game-exit` (seconds the game ran, to the launcher's 10 s check). | PASS |
| Func client log | `Func.Client.log` in the same folder (`-FuncClientLog`) | `=== Func.Client session <local time> ===` per game start = when `Victory.exe` loaded the client DLL. Paired with the launcher's `play`: PLAY → game process start. | PASS (format; pairing tested on samples) |
| Server log | `server.js` output on the VPS (`HH:MM:SS` UTC) | Per player: `login` (the game's menu reached the server) → `matchqueue` → `match result`. Time in menu and queue+match, not load times. | PASS (format) |

`patch/measure_loading.py <logs...> [--json]` reads any mix of these (kind
detected per file) and prints every measurement plus min/median/max:

- game log: startup → menu (first line → end of the first FrontEnd map load),
  menu → match loaded (the `Browse:` to the match server, or the `LoadMap:`
  line, → `Took N seconds to LoadMap(<match map>)`), match → menu, and the
  engine's own `Took N seconds` per map;
- launcher log: launcher boot, PLAY, PLAY → game closed;
- Func.Client.log + launcher log: PLAY → game process start;
- server log: game login → match queue, match queue → match result
  (midnight rollover handled).

Tests: `python patch/test_measure_loading.py` (4 tests, sample logs of every
kind). Run on this PC's real launcher log:

```
launcher start -> boot checks done   n=8  min 0.18  median 2.27  max 4.22 s
```

(the 0.18 s boot was offline: the manifest request failed at once.)

## 2. Where loading time and bytes go (static analysis)

### Startup movie: a 12.07 s floor

`DefaultGame.ini` (stock, unchanged by the Remaster) plays
`Movies/LoadingScreen.mp4` at startup with `bWaitForMoviesToComplete=True`,
`bMoviesAreSkippable=False`, and the LoadingScreen plugin's
`StartupScreen` has `bAutoCompleteWhenLoadingCompletes=False`. The movie is
12.07 s (ffprobe; the Remaster's branded version and the original in
`patch/branding/originals/` are the same length). So from the game window
appearing to the menu is at least 12.07 s, whatever the disk speed.
**Candidate, not changed:** `bMoviesAreSkippable=True` (a click skips) or
`bAutoCompleteWhenLoadingCompletes=True` for `StartupScreen` (the movie ends
when startup loading does). Untested in game: the effect on a fast PC could be
several seconds, or nothing if engine start takes longer than 12 s. Measure
with the procedure below before shipping either.

### The menu map loads two copies of the Jungle's lighting level

Every trip to the menu (startup, and every match → menu) loads `FrontEnd.umap`
and its 12 always-loaded streaming levels (`build_menu_arenas.py`). From the
live 1.3.10 pak (`pak_report.py`):

| Entry | Raw MB | Stored MB |
|---|---|---|
| Maps/FrontEnd/Arena_Sky.umap (copy of Jungle `Lighting.umap`) | 27.35 | 15.89 |
| Maps/FrontEnd/Arena_JungleSide_Lights.umap (another copy of it) | 27.35 | 15.89 |
| Maps/FrontEnd/FrontEnd_TH.umap | 12.08 | 7.88 |
| Maps/FrontEnd/MenuNightSky.uasset (16384×4096 sky panorama) | 44.74 | 6.43 |
| Maps/FrontEnd/MenuNightCube.uasset | 4.20 | 0.93 |
| whole `Maps/FrontEnd` (27 files) | 132.1 | 48.4 |

The two lighting copies are 41% of the menu's raw bytes; the arena rules move
most of their actors below the scene but their data is still loaded.
**Recommendations (not done, need in-game A/B):** strip the lighting copies to
the actors the menu shows; a 8192×2048 night sky (4× fewer texels; the
script's own note says 16384 was chosen for sharpness).

### The Remaster patch pak

| | Installed Nov 3 build | Live release 1.3.10 |
|---|---|---|
| File | 205.4 MB | 189.2 MB |
| Entries | 4545 | 4883 |
| Raw → stored | 411.9 → 204.2 MB (50%) | 388.5 → 188.0 MB (48%) |
| Uncompressed entries | 0 | 0 |
| Byte-identical duplicates | 0.04 MB (3 pairs) | 0.04 MB (3 pairs) |
| Entries identical to the stock file they override | 0 of 23 | not checked |
| Diagnostic content | `IceAxe_A_XPTest` + the Blue Tempest Ice Axe skin pointing at it | `IceAxe_A_XPTest` only, referenced by nothing (stale staging file) |

- Already zlib level 9 in 64 KB blocks (`make_pak.py`), like the game's paks.
- PNGs (700 files, 45.6 MB) are compressed a second time. Measured: inflating
  all of them takes 0.07 s and storing them raw would make the pak 0.08 MB
  *bigger*. **Rejected**: no gain.
- Calling-card PNGs and weapon camo textures are most of the rest (cosmetics,
  loaded on demand, not on the startup path).

### Loose movies in the full release

The live manifest (1.3.10, 3559 files, 6049.8 MB) ships three movies. A scan
of every asset under 8 MB and every config in all paks (14,486 files) and of
the game binaries finds:

| Movie | Size | Duration | Referenced |
|---|---|---|---|
| LoadingScreen.mp4 | 1.82 MB | 12.07 s | yes (`StartupMovies`) |
| Load_Screen.mp4 | 7.27 MB | 5.00 s | no (stock file) |
| LoadingBar.mp4 | 2.69 MB | 120 s | no (`make_loading_bar.py`, reverted) |

### Menu startup requests (ClientWeb.js and Remaster scripts)

On each menu load: engine calls for the ClientWeb root URL → `GET` root data →
`POST` login → socket.io connect (engine.io handshake, then websocket) →
`login` emit → after auth, emits for inventory types, premium types,
leaderboard, cards; plus one `GET` ranked status (`RankedUI.js`, at most once
per 2 s). All asynchronous: none blocks the menu's thread. Timeouts: connect
attempt 15 s, login 30 s, reconnect 30 s after a failure; the menu shows
"connecting" meanwhile. The only synchronous request, `UiTrace.js`, is off
unless the server is on this PC. The HUD reads three JSON files one after the
other at bind (`hud.json`, `SteamItems.json` 0.9 MB, `FrontEnd.json`) from
the pak, no network. No change made.

### Launcher start-up path

`bootChecks` (launcher/main.js): settings → recover → **manifest + signature
from the VPS** (984,157 bytes) → self-update check → plan (stat of 3559 files,
hashing only files whose size/mtime changed) → boot. The network step was two
sequential HTTPS requests.

## 3. Changes, with measurements

| Change | Before | After | Measured how | Status |
|---|---|---|---|---|
| Launcher fetches `manifest.json` and `manifest.json.sig` in parallel (`launcher/lib/sync.js`) | 383 ms median (8 runs: 1453 cold, 316-454 warm) | 243 ms median (125-372) | `node` script fetching the live manifest from xplab.shop:8443 from this PC, both ways alternately, same connection pool. Launcher tests: 16/16 sync, all suites pass. | PASS for the fetch (−140 ms median); launcher boot end-to-end NOT TESTED (compare `launcher start -> boot checks done` in launcher.log over a few starts before/after with `measure_loading.py`) |
| Full releases leave out `Movies/LoadingBar.mp4` (`make_release.py` FULL_EXCLUDE) | 6049.8 MB / 3559 files in the live manifest | −2.69 MB per new full install (`pak_report.py --release` lists it excluded) | sizes from the live manifest and the install | PASS (size); it was never played, so no load-time effect |
| `make_release.py` warns when diagnostic content is in the pak it built | silent | prints each diagnostic entry | `pak_report.py --check` on the Nov 3 pak: 2 found, exit 1; live 1.3.10: 1 found | PASS |
| Launcher logs `play` and `game-exit` | no record of game starts | timestamps for `measure_loading.py` | `node --check`; `measure_loading.py` parses them (sample-log test); main.js has no unit tests and no real launcher run was made | PARTIAL |
| `patch/measure_loading.py`, `patch/pak_report.py` | - | - | tests above | PASS |

Not changed, with reasons: startup movie settings and the menu's lighting
copies / sky size (need in-game A/B timing and a visual check); storing PNGs
raw (measured: no gain); `Load_Screen.mp4` (stock, unreferenced as far as the
scan sees, but the scan skips assets over 8 MB; check in game before
excluding it, −7.27 MB).

**To do outside this branch:** delete `patch/src/Victory/Content/Character/Weapons/IceAxe_A_XPTest.uasset`
from the staging tree (it is stale output of `make_camo_tests.py`; nothing in
the live pak references it) before the next release; `make_release.py` will
warn until then.

## 4. In-game measurement procedure (game load times)

Use the launcher against the VPS, as for any in-game test. Same PC, same
settings, game files already in the OS cache or not (say which): do each
measurement 3 times and take the median.

1. Before starting: note the time; close the game; keep the launcher open.
2. **Startup → menu.** Press PLAY. Start a stopwatch (or screen recording at
   60 fps, OBS) at the click. Stop when the main menu is interactive: the PLAY
   button of the menu responds to the mouse. The launcher log gets `play` at
   the click; `Func.Client.log` gets the game's start time; together:
   `python patch/measure_loading.py "%APPDATA%\The Culling Remaster\logs\launcher.log" "%APPDATA%\The Culling Remaster\logs\Func.Client.log"`
   prints PLAY → game process start. Startup → menu = stopwatch; the movie
   alone is 12.07 s of it.
3. **Menu → match loaded.** In the menu, start a match (Solo/Duo/Showdown).
   Start at the click that leaves the menu (or when the lobby's countdown hits
   0), stop when the in-match HUD appears and you can move.
4. **Match → menu.** Pause → Quit (or die → Return to menu). Start at the
   click, stop when the menu is interactive again.
5. Optional, for engine-reported numbers: if a log file can be produced, run
   `measure_loading.py` on it. Try adding `-log` / `-ABSLOG=C:\Temp\Victory.log`
   to the game's command line (BLOCKED here: the launcher passes only its Func
   options to `Func.Launcher.exe`; whether extra arguments reach `Victory.exe`
   is unknown). If it works, `Took N seconds to LoadMap(...)` gives exact map
   load times.
6. Record: date, release (launcher shows it), resolution, drive (SSD/HDD), the
   three times ×3, and the measure_loading output. Compare builds only with the
   same PC and procedure.

For an A/B of a candidate (e.g. a skippable startup movie or a lighter menu
map): measure 3× on the current release, install the test pak, measure 3×
again, and only then report a difference.

## Status summary

| Area | Status |
|---|---|
| Log sources identified; game log BLOCKED (not written by default) | PARTIAL |
| `measure_loading.py` + tests | PASS |
| Pak analysis (`pak_report.py`), diagnostics guard | PASS |
| Launcher manifest fetch −140 ms median | PASS (component), end-to-end NOT TESTED |
| Unused movie out of full releases (−2.69 MB) | PASS |
| Startup/menu/match load times in game | NOT TESTED (procedure above) |
