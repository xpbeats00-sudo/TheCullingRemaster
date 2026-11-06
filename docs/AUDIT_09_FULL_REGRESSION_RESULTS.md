# Audit 09: full regression results (branch `audit-combined`)

Date: 2026-11-05. Machine: the build PC (Windows 11, Node 24.15.0, Python 3, Visual Studio 2022 C++ tools).
Every number below is from a real run on this tree. Nothing was run in the game: every in-game row is **NOT TESTED**.

## What the branch holds

`audit-combined` starts from `integrate-custom-pipeline` (3bc41bf: origin/main c0799be + custom-match +
fix-release-pipeline + animated-camos) and merges these branches, all cut from origin/main c0799be:

| Branch | What it brings |
|---|---|
| audit-reports | docs/AUDIT_01_PROJECT_INSPECTION.md |
| netplay-feasibility | docs, patch/netplay_check.py and its test, launcher `CULLING_NET_URL` test hook, deploy/netplay_udp_probe.js |
| bot-ai | make_bot_ai.py tiers (default Experienced), patch_assets.py no longer touches the AI, test_bot_ai.py |
| economy-weapons | make_airdrop_prices.py (25% off), stock_paks.py, make_weapon_balance.py (empty table), weapon_stats.py, loot_tables changes, their tests |
| hud-loading | hud.js party-bar placement, kill-feed height, ShowdownHud fixes, scoreboard scroll, hud_harness + test_hud_layout.js, launcher sync/play logging, make_release LoadingBar.mp4 exclusion and diagnostic check, measure_loading.py, pak_report.py |
| party-matchmaking | parties queue as one unit, shared matchId/lobbyId/partyId, playlists.js, leader-only invites, menu reasons, party/playlists tests |
| team-sizes | exe fix 9 (?TeamSize=, sd_teams, sd_spawn_bots), TMS| teammate panels, TRIO/QUAD tiles, Teams.js, trio:/quad: URLs, coop3/coop4 queues, lint_es5.py |
| weather-night | weather.js (gated), night maps, weather.c in the native module, make_weather.py/make_rain.py, their tests |

## How the branches were reconciled

| Where | Resolution |
|---|---|
| patch/stock_paks.py vs build_catalog.stock_paks | One rule: stock_paks.py keeps paks_dir()/read_stock() and re-exports build_catalog.stock_paks (pakchunk<N>-WindowsClient.pak, never *_P.pak). make_bot_ai.py uses it too. |
| make_release.py (hud-loading) | The pipeline's FULL_EXCLUDE (already leaves out LoadingBar.mp4). The pak_report check of the written pak stops the release instead of only warning (make_pak.py already refuses test content first). |
| make_server_config.py | Both branches split out the same helper; the pipeline's add_scripts(html, folder) is kept (the release gate uses it); hud_harness.py calls it. |
| server/server.js | party-matchmaking's queueing (playlists.js decides what can be queued, by whom, and how large a party; reasons shown in the menu) + team-sizes' TEAM_MODES + weather's answers + custom matches. A night map is asked for by name in the queue. |
| server/playlists.js | Trios and Quads ENABLED (party up to the team size). Ranked Duos/Trios/Quads, Showdown Duos/Trios/Quads and Ranked Showdown refused with reasons. |
| server/weather.js | gameServer takes the team mode: Trios/Quads keep trio:/quad:<map>; by URL (night map or weather) they are map:duo:<i>?TeamSize=<n>?Weather=...?WeatherSeed=... Night maps stay off unless CULLING_NIGHT_MAPS=1. |
| hud.js | hud-loading's anchor (the armor row inside #hud-bottom-left-container, right of the FUNC counter, never the spectator copy) with team-sizes' extra teammate panels stacked above the game's panel from the same anchor; OnViewResized and resize re-place both. |
| ClientWeb.js / MatchLobby.js / make_branding.py | Custom matches, party reasons, TRIO/QUAD tiles and URLs and night maps side by side; --menu-only applies the CUSTOM screen and the team tiles. |
| patch/showdown_rounds.c | Merged cleanly: team-sizes' NvN code and weather's `#include "weather.c"` + weather_tick hook. Blob rebuilt (20,112 bytes); `build_showdown_rounds.py --check`: up to date. |
| patch_exe.py | check()/verify() require fixes 1-9 (and the weather code, part of the module). PATCHED_SHA256 recomputed with `patch_exe.py --hash`. |
| server tests | helpers.startServer always listens on a port the system picks (CULLING_PORT=0, port file); srv.port is known after ready(). Tests that launch server.js themselves use helpers.freePort(). No suite has a fixed port. |
| build_release.py | New generators in order (below) and every new test; the preflight asks for the VS C++ tools. |

Generator order (build_release.py): make_airdrop_unlocks, **make_airdrop_prices**, patch_assets, **make_bot_ai**,
**make_weapon_balance**, make_loading_bar, make_branding (x2), make_night_sky, make_night_cube, make_moon,
make_meteors, make_sky_fx, build_menu_arenas, make_camos, make_vfx_camos, make_eye_skins, make_calling_cards,
make_ranked, make_card_image_map, make_showdown, **make_rain**, **make_weather** (on make_showdown's Jungle_P),
extract_func_anims.

## Pin

- STOCK_SHA256 (the Steam Victory.exe, unchanged): `bd818b91d78d99620ff1d003672282fcf7aa23832863a2e93449c945e0ff8758`
- PATCHED_SHA256 (fixes 1-9 + weather module): **`e02e5f98db8d55aa92389ec83d936f196f51ea4b5e9371f88b48ca1ffcc52a85`**
  (from `--hash`, and again from patching a scratch copy and hashing it; the dry run's shipped exe has the same SHA-256).

## Results

### Server (node server/test/*.test.js): 25 suites, 245 tests, 0 failures

| Suite | Tests | Status |
|---|---:|---|
| accounts | 14 | PASS |
| activity | 4 | PASS |
| airdrop_prices | 5 | PASS |
| airdrops | 4 | PASS |
| audit | 16 | PASS |
| camopurchase | 6 | PASS |
| custommatch | 10 | PASS |
| deploy | 2 | PASS |
| field | 5 | PASS |
| friends | 23 | PASS |
| lastbreath | 11 | PASS |
| leaderboard | 13 | PASS |
| matchlobby | 12 | PASS |
| matchqueue | 5 | PASS |
| matchresult | 8 | PASS |
| metrics | 8 | PASS |
| party | 16 | PASS |
| playlists | 12 | PASS |
| ranked | 18 | PASS |
| season | 4 | PASS |
| session | 6 | PASS |
| showdown | 22 | PASS |
| shutdown | 2 | PASS |
| store | 11 | PASS |
| weather | 8 | PASS |

All 25 suites also pass when started at the same time (no port collisions).

### Launcher (npm test): 12 suites, 120 tests, 0 failures

sync 16, config 7, game 10, player name 4, update 27, error message 8, account 13, self-update 8, discord 6, ui 9, status 9, reconnect 3.

### Deploy: 3 suites, 0 failures

stage_objects 10 checks, publish 6, make_manifest 3.

### Patch (on the fully generated tree; stock paks and the stock Victory.exe given where a test takes them)

| Test | Result |
|---|---|
| release consistency gate (`--paks`) | PASS: catalog, registry, assets, generated pages and config agree |
| test_patch_exe.py (real exe) | 10 ok, PASS (stock SHA-256 before, PATCHED_SHA256 after, verify() passes) |
| test_make_pak.py | 4 ok, PASS |
| test_make_release.py | 13 ok, PASS |
| test_stock_paks.py | 3 ok, PASS |
| test_release_gate.py | 12 ok, PASS |
| test_extract_func_anims.py | 2 ok, PASS |
| test_menu_items.py | 2 ok, PASS |
| test_match_urls.py | 1 ok, PASS |
| test_eye_skins.py | 5 checks, PASS |
| test_loot_tables.py | 7 ok, PASS |
| test_vfx_camos.py | PASS (678 files) |
| test_custom_match.py (+ test_custom_menu.js, 6) | PASS |
| test_showdown_hud.js | 4 ok, PASS |
| test_team_hud.js | 8 ok, PASS |
| test_hud_layout.js | 60/60 layouts PASS |
| test_airdrop_prices.py | 6 ok, PASS |
| test_weapon_balance.py | 7 ok, PASS |
| test_bot_ai.py | PASS (5 tiers, 121 packages, 222 values) |
| test_weather.py | 20 checks, PASS |
| test_measure_loading.py | 4 ok, PASS |
| test_netplay_check.py | 9 ok, PASS |
| build_showdown_rounds.py --check | PASS (blob up to date) |
| test_native_module.py | 15 ok, PASS |
| test_weather_native.py | 15 ok (8 checks), PASS |
| lint_es5.py --diff origin/main (7 changed UI scripts) | PASS |

### Build and dry run

- `build_release.py 9.9.9 --game C:/Culling/TheCulling --camos ... --cards ... --skip-showdown-tile --no-release`: every generator, the gate and every test, exit 0. The generators left only line-ending changes (no content change: catalog.json, showdown.json, weather_maps.h and the generated .js are as committed).
- `--skip-generators --key <throwaway> --out <scratch> --no-setup`: exit 0. Release 9.9.9 (live: 1.3.10), gate ok, a 5,525-file patch pak, Victory.exe with fixes 1-9 at `e02e5f98...`, a signed manifest of 75 files (5.72 GB). build.json: commit e51ca67, dirty false, gate passed. The signature verifies with the throwaway key only; nothing was published and the real key was not used.

### In game (launcher + VPS): NOT TESTED

| Feature | Status |
|---|---|
| Custom match settings (?mods=) apply in the match | NOT TESTED |
| Party queue: members land in one lobby and one match record | NOT TESTED |
| Trios / Quads: teams of 3 / 4, TMS teammate panels, team win | NOT TESTED |
| Night maps and weather (CULLING_NIGHT_MAPS=1 on a test server) | NOT TESTED |
| Airdrop prices 25% off in the match | NOT TESTED |
| Bot AI Experienced tier | NOT TESTED |
| VFX camos (Dark Matter, Wave) render | NOT TESTED |
| HUD placement at 1080p / 1440p / 21:9 in the real game | NOT TESTED (60 layouts pass in the harness only) |
| Showdown rounds, Duo team win, Chokening kills with the fix 9 exe | NOT TESTED |
| Launcher update to a build from this branch | NOT TESTED |

## Left before merging to main

1. Every in-game row above (the project rule: through the launcher and the VPS).
2. The SHOWDOWN tile has no picture: `showdown_arena_source.png` is not in patch/branding (build used `--skip-showdown-tile`).
3. Night maps ship as assets but stay off on the server until CULLING_NIGHT_MAPS=1 is set after an in-game test.
4. The weapon balance table is empty on purpose (stock stats); the Tier 3 proposal waits for approval.
5. Any change to showdown_rounds.c, weather.c or weather_maps.h changes the blob: rebuild it and recompute PATCHED_SHA256.
