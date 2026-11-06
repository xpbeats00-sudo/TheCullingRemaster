# Client audit 2: launcher, menus and HUD, release pipeline

Date: 2026-11-05. Branch `client-audit-2`, from `origin/audit-combined` at `d8f4573`. Machine: the build PC (Windows 11, Node 24.15.0, Python 3).

Scope:
- the launcher (`launcher/`);
- the in-game menus and HUD (`patch/src/Victory/Content/uiresources/**/js`);
- the release pipeline (`patch/make_*.py`, `build_release.py`, `make_release.py`, `make_pak.py`, the release gate).

Not changed: `patch_exe.py` and `showdown_rounds.c` (findings there are under "Game exe, report only"), the server, and every game install. Nothing was published, and the real release key was not used.

## Summary

| Area | Findings | Fixed | Open |
|---|---|---|---|
| Launcher | 7 | 5 | 2 |
| Menus and HUD | 13 | 8 | 5 |
| Release pipeline | 6 | 5 | 1 (environment only) |
| Game exe (report only) | 1 | 0 | 1 |
| **Total** | **27** | **18** | **9** |

By severity, all areas together:

| Severity | Findings | Fixed | Open |
|---|---|---|---|
| High | 3 | 3 | 0 |
| Medium | 7 | 6 | 1 |
| Low | 17 | 9 | 8 |

Every fix comes with a regression test. Each test fails on the previous code: the old file was swapped back in and the test run; the outputs are quoted below.

## Findings

### Launcher

**L1. HIGH: an overlapping check could put a finished update back to the old version. FIXED.**
- **Where:** `lib/sync.js` `plan()` loaded the state when it started and saved that whole object when it finished. `main.js` ran plans from Check for updates, the offline reconnect, PLAY's last look and the start-up checks alongside a sync or a restore.
- **What happened:** a commit or a restore that finished while the plan was still hashing was overwritten with the plan's stale view. The installed version went back to the previous one, the launcher offered the update again, and the next sync replaced the backup that "Restore previous version" needs.
- **Reproduction:** install 1.0.0, update to 1.1.0, with a full plan running during the update:
  ```
  after apply: installed 1.1.0
  after the overlapping plan: installed 1.0.0 previous version for rollback: 1.0.0
  ```
- **Fix:**
  - `main.js` runs every plan, sync and restore through one queue (new `lib/serial.js`).
  - `plan()` no longer saves over a state whose version, previous version or hold changed meanwhile; it marks its result `stale` instead.
- **Test:** `update.test.js` "a check that overlaps a restore (or an update's commit) doesn't write its old view over it". On the old sync.js: `FAIL AssertionError: the restore stands (the plan wrote 1.1.0 back over it)`.

**L2. MEDIUM: a second Update click ran a second sync on the same folder. FIXED.**
- **Where:** the `sync` handler set `busy` only after `await game.isRunning()`, which runs tasklist and takes 0.1 to several seconds. Restore and Check for updates did not take the flag at all.
- **What happened:** a double click, or Update followed by Restore, ran two jobs on one game folder.
- **Fix:** the three actions are claimed before their first await (`createExclusive`). A second one is refused with "Wait for Game Sync to finish".
- **Test:** new `main.test.js`, which runs main.js on a stand-in Electron. On the old main.js the second click is not refused; it goes into its own manifest fetch: `FAIL never finished: a second Update while the first is still starting is refused, ...`.

**L3. LOW-MEDIUM: a release that arrived after PLAY's 4-second wait showed no update. FIXED.**
- **Where:** PLAY's `Promise.race` timed out, but `latestManifest()` still replaced the manifest when it arrived.
- **What happened:** the old plan stayed next to the new release, so the window offered no update for it.
- **Fix:** the plan now follows the manifest whenever it arrives.
- **Test:** `main.test.js` "PLAY's look for a release ...". On the old main.js: `FAIL AssertionError: the late release is planned: null`.

**L4. LOW: hardening (no exploit found). FIXED.**
- `will-redirect` is refused, as `will-navigate` already was.
- Every permission request and permission check is refused.
- No web contents can attach a `<webview>` or open a window.
- The CSP adds `object-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'` to both pages.
- **Test:** `main.test.js` checks the window's isolation, sandbox, no Node, preload, navigation, window, webview and permission refusals, and the CSP of both pages (no `unsafe-*`, no inline scripts). It also checks that the IPC channels in preload.js and the handlers in main.js are the same set, and that a foreign sender is refused.

**L5. LOW: `net::ERR_UNSAFE_PORT` was worded as a connection problem. FIXED.**
- **Evidence:** launcher.log, `2026-11-04T09:53:47.617Z manifest net::ERR_UNSAFE_PORT`. The player was told "Can't reach the update server. Check your internet connection".
- **Fix:** it now reads as a server setup problem.
- **Test:** `errors.test.js`, 8 → 9 tests.

**L6. LOW: the IPC check is by `webContents`, not by frame. OPEN.**
- **Why it is low:** there are no subframes, and `frame-src 'none'` now forbids them.
- **Why not fixed:** a `senderFrame.url` check needs a run in real Electron to confirm the file URL form of an install path with spaces. If the check were wrong, every IPC call would fail. Recommendation only.

**L7. LOW: the launcher setup is not tied to the release's commit. OPEN (your decision).**
- **Where:** `make_release.py` ships whatever `launcher/dist/TheCullingRemasterSetup.exe` is there.
- **What it means:** the version is read from the exe, so an older setup is never offered. A setup built from another branch, or from a dirty tree, with a newer version would be offered, though.
- **Proposal:** record the setup's SHA-256 and `build-info.json` commit in build.json. Refuse a setup whose commit isn't HEAD unless `--allow-dirty`.

**Checked and fine:**
- The window: `contextIsolation`, `sandbox`, no `nodeIntegration`, DevTools only unpackaged, no menu.
- `open-link` is https-only and limited to the built-in links. Settings are sanitized (`config.js`).
- The manifest: Ed25519 signature before any use, path, device-name and case checks, https-only URLs.
- Self-update: size and SHA-256 from the signed manifest, a cap of 2 tries per version, no cleanup while offline.
- Offline: reconnect backoff of 5/10/20/40/60 s.
- Accessibility basics: every control has a name (a wrapping label, text or `aria-label`), toasts are `role="alert"`, live regions, `:focus-visible` outlines, `prefers-reduced-motion`.
- Idle cost:
  - pings run only while the window is visible (`document.hidden` check);
  - the infinite animations are compositor-only transforms, on PLAY's shine and on busy or attention states only;
  - no polling timers in the main process (the game watch runs only while the game runs).

**Startup, measured from the real launcher.log** (`start` to `boot` events, the manifest fetch and plan included):

| Run | start → boot |
|---|---|
| 1.3.1, online, nothing to do | 1,015 ms and 974 ms |
| 1.2.0, online, nothing to do | 2,649 ms |
| 1.3.2, online, 2 files pending | 2,857 ms and 2,109 ms |
| 1.3.0, first run (no game path) | 4,217 ms |
| 1.2.0, offline (refused port) | 185 ms |

No regression is expected from this branch: the serial queue adds no work at start-up.

### Menus and HUD

**U1. HIGH: the Showdown card couldn't be used with a gamepad. FIXED.**
- **Where:** `Showdown.js` gave `RemasterOverlay.open()` its buttons as a list; `Friends.js` `list()` calls `entry.items()`.
- **What happened:** every D-pad and Select press threw inside `OnButtonPressed`, and the stock handler never ran. Only Back worked, so a gamepad player could neither press PLAY nor PLAY AGAIN.
- **Why the tests missed it:** `test_showdown_menu.js` used an overlay stand-in that accepted the list.
- **Fix:** Showdown passes functions, and the overlay accepts either a function or a list.
- **Tests:**
  - new `test_remaster_panels.js` drives the real overlay with a gamepad: right, left, Select presses PLAY;
  - `test_showdown_menu.js` asserts the contract. On the old code: `AssertionError: items is a function, as RemasterOverlay calls it`.

**U2. MEDIUM: a 1v1 draw at 0-3 ended the series. FIXED (needs an in-game check).**
- **Where:** `ShowdownHud.js` judged a death when it happened (`losses + 1 < roundsToWin`). `showdown_rounds.c:1080` does send `D` when both fighters are down, and a draw adds no loss.
- **What happened:** at 0-3, a draw showed the death screen and posted the result. The server then ended the series (`server.js`, `showdowns.leave`) while the game played on.
- **Fix:** a death that may lose the series is held until the round's message:
  - `O`: the series is lost, and the death screen shows;
  - `E` or `S`: the series goes on, and the held death is dropped;
  - no message within 6 s (an older module): the death screen shows as before.
- **Tests:** `test_showdown_hud.js`, 9 → 10. On the old code: `AssertionError: at 0-3 the death waits for the round's message (it may be a draw)`.

**U3. MEDIUM: leaving a ranked pregame lobby at the last moment can count as an abandoned match. OPEN (server).**
- **Where:** `ClientWeb.js:1545` drops a late `match-ready`, but `launchMatch` has already started the ranked match. `leave-mm` (`server.js:1817`) doesn't cancel it, so the next ranked start marks it abandoned, which counts as last place.
- **Proposed fix:** the client sends `match-declined`, and the server drops a ticket that is younger than about 5 s. This needs a server change and an in-game test.

**U4. MEDIUM: Friends and the Leaderboard never reconnected. FIXED.**
- **Where:** `RECONNECT_AUTOMATICALLY = false`, and Friends.js's comment wrongly said ClientWeb retries every 30 s.
- **What happened:** both panels stayed offline until some other menu action reconnected.
- **Fix:**
  - opening either panel while offline calls `ConnectWebsocketIfNeeded()` once (it is guarded against parallel attempts);
  - the Leaderboard asks again on `auth-response` (`RemasterLeaderboard.connected`).
- **Test:** `test_remaster_panels.js`.

**U5. LOW-MEDIUM: a double click on a Ranked team-mode Play tile queued twice and popped four screens. FIXED.**
- **Fix:** a local guard, cleared by the answer and by the screen showing again. It doesn't rely on the stock `hasClickButton` reset, which isn't in the repo to check.
- **Test:** `test_ranked_menu.js`, 6 → 8 (this and U6). On the old code: `AssertionError: one queue for two clicks`.

**U6. LOW: missing or null payload fields threw inside the socket handlers. FIXED.**
- **What failed:**
  - Friends: player card, party invite, a missing requests list, a card without `kd` or `showdown`;
  - Leaderboard: no season, no `top`;
  - MatchLobby: a null lobby, an empty or missing players list;
  - RankedUI: no `tier`, missing lists.
- **Context:** today's server always sends the full shapes; this is hardening for older and newer servers.
- **Fix:** each panel normalizes the payload at its entry point.
- **Tests:** `test_remaster_panels.js` and `test_ranked_menu.js`. On the old code: `Got unwanted exception: remaster-player-card undefined ... reading 'found'`.

**U7. LOW: quitting with a held team result sends a synchronous XHR with no timeout. OPEN.**
- **Where:** `hud.js` `SendLocalMatchResultNow`, to the VPS, on Quit, beforeunload and unload.
- **Risk:** a stalled request hangs the quit to the menu (UiTrace.js's own warning).
- **Proposed fix:** `navigator.sendBeacon`, else an async XHR. Not done: it changes the quit path, which needs an in-game test.

**U8. LOW: a timed-out but saved result reads as "not saved". OPEN (server).**
- **Where:** the retry gets 409 from the server.
- **Proposed fix:** answer a repeated post with the stored reply.

**U9. LOW: a closed Friends panel kept its text field focused. FIXED.**
- **What happened:** the field swallowed D-pad Left/Right in the next panel.
- **Fix:** `close()` blurs it.
- **Test:** `test_remaster_panels.js`.

**U10. LOW: rows for players without an account open the card of whoever registers "Player". OPEN (server).**
- **Proposed fix:** the server sends `name: null` or `account: false`, or reserves the name.

**U11. LOW: two Leaderboard refusals in a row armed two retry timers. FIXED.**
- **Test:** `test_remaster_panels.js`.

**U12. LOW (performance): hidden panels kept their card rows. FIXED.**
- **Where:** `AnimatedCards.js` updates every tracked card row on the page every 40 ms, hidden or not.
- **Fix:** Leaderboard, Friends, the player card and the lobby pill drop their rows on close; they are drawn again on open or on the next push.
- **Test:** `test_remaster_panels.js`.

**U13. LOW: `AddGameMessage` sets innerHTML. OPEN.**
- **Why it is low:** "<name> is your Teammate!" only ever carries the game's bot names today.
- **Proposed fix:** a one-line escape there.

**HTML injection:**
- Every player name and username in the Remaster panels is set with `textContent`.
- The server limits usernames to letters, digits, `_.-` and space (at most 20 characters).
- No exploitable injection found.

**Dead code (no behaviour impact):**
- `PostPendingTeamResult`'s fallback outcome is never used.
- `Friends.js overlay(id, z)` never uses `z`.
- The stock party branches of `OnInvitePressed` are unreachable after Friends.js replaces it (intentional).

**Checked and fine:**
- No timer or listener stacking when screens or panels are re-entered (the MatchLobby ticker is cleared in `hide()`; the roots are built once).
- `TMS|` parsing is bounded.
- The match URL builders validate strictly.
- Long names have `nowrap` and an ellipsis, with `min-width: 0` on the flex parents.

### Release pipeline

**P1. HIGH: the release build never ran the ES5 lint. FIXED.**
- **What it means:** one ES2015 line stops a whole Coherent UI script, and nothing in `build_release.py` checked for it.
- **Fix:**
  - `lint_es5.py --release` lints every .js under `patch/src/**/uiresources`, whole files, with `const` allowed (the stock scripts use it);
  - it runs in `build_release.tests()`.

**P2. MEDIUM: two tests never ran in the release build. FIXED.**
- **What was missing:** `build_release.tests()` didn't include `test_make_showdown.py` (team Showdown arena starts) or `test_showdown_menu.js`.
- **Fix:**
  - both are added, with the new `test_remaster_panels.js` and `test_lint_es5.py`;
  - the new `test_build_release.py` fails when any `patch/test_*` file is left out. `RUN_ELSEWHERE` names the three that other steps run.

**P3. LOW: the lint missed modern syntax. FIXED.**
- **What was missed:** shorthand methods, destructuring, async/await, `**`, `?.` and `??`.
- **Test:** `test_lint_es5.py`, 18 checks: each form is caught, and close-looking ES5 is not flagged.

**P4. LOW: a non-ASCII file name stopped `make_pak.py` with a bare traceback. FIXED.**
- **Before:** `UnicodeEncodeError: 'ascii' codec can't encode character '\xe9'`, naming no file.
- **Fix:** such names are refused before anything is written, naming the files.
- **Test:** `test_make_pak.py`, which now also asserts that the same tree packs to the same bytes (reproducible).

**P5. LOW: tool failures ended `make_release.py` with a traceback. FIXED.**
- **Before:** `make_pak.py` or `make_manifest.js` failing, or node missing, raised `CalledProcessError` or `FileNotFoundError`.
- **Fix:** `step()` raises a ReleaseError that names the tool and says not to publish.
- **Test:** `test_make_release.py`, 13 → 14.

**P6. ENVIRONMENT: `test_match_urls.py` needs the generated tree. OPEN (not a bug).**
- **Where:** it reads `patch/src/Victory/Config/DefaultGame.ini`, so it fails in a fresh worktree.
- **Why it is fine:** the release build runs it after the generators.

**Checked and fine:**
- The consistency gate runs before packing.
- The diagnostics scan runs on the written pak.
- Version and downgrade checks, the dirty-tree refusal, build.json provenance, and `--skip-gate` refused for `releases/`.
- The hard-linked install is never written through.

### Game exe (report only, not changed)

**X1. LOW: draws never end a Showdown series.**
- **Where:** `showdown_rounds.c:1080-1088` counts neither wins nor losses on a draw.
- **What it means:** repeated draws keep the series going with no round cap.
- **Proposal:** cap the rounds (for example, after round 10 the series goes to the side with more wins, or counts as a draw). This changes the blob and PATCHED_SHA256.
- The HUD now treats `D` correctly (U2).

**Server aside (outside this audit's scope):** `server.js:628` uses `showdown`, which is declared only inside `launchMatch` (line 1456). A ticket without `mode` would throw a ReferenceError in `/api/matchresult`. Every current ticket sets `mode`.

## Changes

| Commit | What |
|---|---|
| `683b69b` | Menus and HUD: U1, U2, U4, U5, U6, U9, U11, U12; new `test_remaster_panels.js` |
| `04bc03a` | Pipeline: P1-P5 (`lint_es5.py --release`, `test_lint_es5.py`, `test_build_release.py`, `make_pak.py`, `make_release.py step()`) |
| `81f3570` | Launcher: L1-L4 (`lib/serial.js`, `sync.plan` guard, `main.js` actions and hardening, CSP); new `main.test.js`, `serial.test.js` |
| (this doc's commit) | L5 (`errors.js`), the `main.test.js` wait for a slow tasklist, this report |

## Test results (real output, this branch)

### Launcher (`npm test`): 14 suites, 129 tests, 0 failures

Before this branch it was 12 suites and 120 tests.

```
all 16 sync tests passed
all 7 config tests passed
all 10 game tests passed
all 4 player name tests passed
all 28 update tests passed
all 9 error message tests passed
all 13 account tests passed
all 8 self-update tests passed
all 6 discord tests passed
all 9 ui tests passed
all 9 status tests passed
all 3 reconnect tests passed
all 3 serial tests passed
all 4 main process tests passed
```

### Menu and HUD stand-ins

```
test_custom_menu.js: all 6 custom menu tests passed
test_ranked_hud.js: all 6 ranked HUD tests passed
test_ranked_menu.js: all 8 ranked menu tests passed        (was 6)
test_showdown_hud.js: all 10 Showdown HUD tests passed     (was 9)
test_showdown_menu.js: all 5 Showdown menu tests passed
test_team_hud.js: all 8 team HUD tests passed
test_remaster_panels.js: all 8 Remaster panel tests passed (new)
test_hud_layout.js: 60/60 layouts pass
lint_es5.py --release: ok    ES5: 21 file(s), const allowed (stock)
```

### Pipeline

```
test_lint_es5.py: PASS (18 checks)                          (new)
test_build_release.py: PASS (3 checks)                      (new)
test_make_pak.py: all make_pak tests passed                 (4 -> 6 checks)
test_make_release.py: all 14 make_release guard tests passed (was 13)
test_release_gate.py: all release gate tests passed
test_stock_paks.py: all stock pak tests passed
test_make_showdown.py: 7 checks passed
```

### Deploy

```
stage_objects.test.js: stage_objects: all 10 checks passed
publish.test.js: all 6 publish tests passed
make_manifest.test.js: all 3 make_manifest object tests passed
```

### Not run here

These need the generated tree, the Visual Studio tools or the real exe, and nothing they cover changed:
- the full `build_release.py`;
- `test_patch_exe.py`, the native-module tests and `test_match_urls.py`.

### In game (launcher + VPS): NOT TESTED

Project rule: in-game tests go through the launcher and the VPS. To check:
1. U1: the Showdown picker and the end card with a gamepad (D-pad, A presses PLAY).
2. U2: a 1v1 draw at 0-3 plays on to round 5; a real 4th loss still shows the death screen (about 1 s later than before, after the module's `O`).
3. U4: Friends and the Leaderboard reconnect after the connection drops.
4. Launcher: Update, Restore previous version, and Check for updates from a build of this branch (L1/L2), and PLAY right after a publish (L3).

## Decisions for you

1. **L7:** tie the launcher setup to the release's commit (refuse a setup from another commit unless `--allow-dirty`)?
2. **U3** (server): add `match-declined` / a young-ticket drop on `leave-mm`, so a last-second leave doesn't count as an abandoned ranked match?
3. **U7:** switch the quit-time result post to `sendBeacon` (needs an in-game test of Quit with a held team result)?
4. **U8 / U10** (server): idempotent match-result replies, and no-account players without the name "Player"?
5. **X1** (exe): cap Showdown rounds at repeated draws (rebuilds the native blob and PATCHED_SHA256)?
