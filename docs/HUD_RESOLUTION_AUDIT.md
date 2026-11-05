# HUD resolution audit

Branch `hud-loading`, 2026-11-05. The in-match HUD (Coherent GT page
`uiresources/hud/hud.html`) measured at five resolutions in a browser harness
that renders the real page, then fixed where parts overlapped, ran off screen
or were cut.

Statuses: **PASS** measured and fine, **FAIL** measured and wrong,
**PARTIAL** fixed and measured in Chromium, Coherent GT behaviour not seen in
game yet, **NOT TESTED**, **BLOCKED**.

## How it is measured

| Piece | What it does |
|---|---|
| `patch/hud_harness.py` | Extracts the stock HUD (hud.html, CSS, libs, fonts, images, localization, item JSON) from the base paks (`pakchunk*` only, read-only) into `patch/research/hud-harness/` (git-ignored), adds the Remaster scripts from `patch/src/.../hud/js/` and builds `hud.html` the way the pipeline does (`make_calling_cards.py` tag + `make_server_config.add_tags`, now a shared function). The built page matches the pipeline's output line for line (checked against a generated `hud.html`). |
| `patch/hud_harness/harness.js` | Stands in for the game: answers every `engine.call`, fires the engine events of a match for one scenario (`match`, `duo`, `spectate`, `showdown`, `showdown-end`, `scoreboard`), stubs only the Remaster server's API (`$.ajax` to `REMASTER_API`; the page's own JSON loads normally) and measures element rects. `?names=long` uses 20-character names, the longest an account can have (`server/accounts.js`). |
| `patch/test_hud_layout.js` | Headless Edge (or Chrome, `HUD_BROWSER`) driven over the DevTools protocol with Node's own WebSocket (no npm packages). For each scenario × name length × resolution: waits until the HUD has bound its data like in game (fails otherwise), checks on-screen, overlap pairs, cut text, and that all 24 scoreboard rows are on screen or scrollable; writes `report/report.json` and screenshots. Also scans the HUD scripts' injected CSS for what Coherent GT lacks (grid, object-fit, flex gap). |

Run: `node patch/test_hud_layout.js` (about 2 minutes; `--only <scenario>`,
`--no-build`, `HUD_DEBUG=1` for the page console, `HUD_EVAL=<expr>`).
Manual: `python patch/hud_harness.py`, then
`python -m http.server 8765 --directory patch/research/hud-harness` and open
`http://127.0.0.1:8765/uiresources/hud/harness.html?scenario=duo` in a
browser sized to the resolution (DevTools device toolbar).

Resolutions: 1280×720, 1920×1080, 2560×1440, 3440×1440 (21:9), 1600×1200 (4:3).
Parts measured: bottom-left (airdrop, FUNC, movement, armor, buffs, health,
stamina), Duo teammate panel, compass, location, kill feed / game messages,
match timer and ping, weapon slots and tooltip, chat, wound icons, spectator
panel and buttons, Showdown panel and round banner, end-of-match scoreboard.

## Result

| | Before (origin/main scripts) | After |
|---|---|---|
| Layouts passing | **32 / 60** | **60 / 60** |
| Coherent CSS scan | FAIL (object-fit, flex gap in ShowdownHud.js) | PASS |

Before/after are the same harness and checks; "before" is the run with
`hud.js` and `ShowdownHud.js` from origin/main.

## Findings and fixes

### 1. Duo teammate panel never anchored: FAIL → PASS (in Chromium), in game PARTIAL

`RemasterPlacePartyBar` used `getElementById("armor-icon-container")`, but the
page has two elements with that id and the first is the spectator panel's,
hidden while you play. Its rect is 0×0, so the function returned every time
and the panel stayed at an unplaced position (`top: auto`, no `bottom`):

| Resolution | Panel before | Problem | Panel after |
|---|---|---|---|
| 1280×720 | 13,532 192×35 | covers FUNC counter by 115×30 px | 138,561 |
| 1920×1080 | 19,801 288×52 | covers FUNC by 173×44 px | 207,842 |
| 2560×1440 | 26,1060 384×69 | covers FUNC by 230×66 px | 276,1123 |
| 3440×1440 | 34,1430 516×93 | 83 px below the screen's bottom | 372,1029 |
| 1600×1200 | 16,667 240×43 | mid-left, not where designed | 173,993 |

With long names the unplaced panel also covered armor, buffs and the health bar.
Fix (`hud.js`): the armor row is looked up inside `#hud-bottom-left-container`,
the panel ends above the whole armor-and-buffs row (not just the armor bar,
the buff icons are taller), and starts right of the FUNC counter's box (where
"+5 Structures" notices pop up). All from real rects, re-run on `resize` and
the game's `OnViewResized`. The name is `nowrap` so a long one ends in "...".

Screenshots: `docs/hud-audit/before-duo-3440x1440.jpg`, `after-duo-3440x1440.jpg`.

### 2. Kill feed runs into the wound icons on 21:9: FAIL → PASS

The game-message column starts 7vw from the top and grows with its messages
(its `height: 75%` is of a parent sized by its content). At 3440×1440 five
messages end at y=1430, through the bottom-centre wound icons (top at 1258):
overlap 1548×138 px in every 21:9 scenario. Fix (`RemasterFitGameMessages`):
`max-height` = space between the column's top and the wound icons' real top,
set when the HUD binds, on `OnStartPlaying`, `resize` and `OnViewResized`.
Newest messages are on top, so the oldest are the ones cut. 16:9 and 4:3
already fit and are unchanged.

### 3. Showdown pre-round panel over the weapon slots: FAIL → PASS

The panel is sized in vw only, so with a full kit (7 items) its height scales
with the screen's width:

| Resolution | Panel before | Overlap / problem | After |
|---|---|---|---|
| 1280×720 | 294×568 | weapon slots 115×105 px | 235×453 (scale 0.80) |
| 1920×1080 | 442×856 | weapon slots 173×161 px | 351×679 |
| 2560×1440 | 589×1143 | weapon slots 231×217 px | 466×906 |
| 3440×1440 | 791×1456 | 110 px off the bottom, slots 309×60 px | 487×895 |
| 1600×1200 | 368×756 | fits | unchanged |

Fix (`ShowdownHud.js`): after the panel is drawn it is measured, and if it
would pass the top of weapon slot 1 (minus 1.5vh) it is scaled down
(`transform: scale`, origin top right) to end there; re-done on `resize`.

Screenshots: `docs/hud-audit/before-showdown-1920x1080.jpg`, `after-showdown-1920x1080.jpg`.

### 4. Showdown panel used CSS Coherent GT doesn't have: FAIL → PASS (scan), in game PARTIAL

- `object-fit: contain` on the item art `<img>`: Coherent has no object-fit,
  so the art would be stretched to 4.6vw×2.6vw. Now a `div` with
  `background-size: contain` (supported: stock CSS uses background-size).
  In the browser the old `<img>` also showed broken-image frames when an icon
  was missing; the background version shows nothing.
- `gap` on the "carrying now" flex row: not in Coherent's flexbox, the slots
  would touch. Now `margin-right` on each slot.

### 5. End-of-match scoreboard cuts contestants 20-24: FAIL → PASS (in Chromium), in game PARTIAL

The stock scoreboard was made for 16 players and its box is `overflow: hidden`.
With the Remaster's 24, the last rows were cut and couldn't be reached:

| Resolution | Last row before (bottom, px) | Reachable before | After |
|---|---|---|---|
| 1280×720 | 766 of 720 | no | list scrolls |
| 1920×1080 | 1152 of 1080 | no | list scrolls |
| 2560×1440 | 1524 of 1440 | no | list scrolls |
| 3440×1440 | 1937 of 1440 | no | list scrolls |
| 1600×1200 | 1012 of 1200 | yes | list scrolls (fits) |

Fix (`RemasterFitScoreboard`): the row list fills the scoreboard box
(flex column, `min-height: 0`) and scrolls (`overflow-y: auto`, which stock
CSS already uses elsewhere). When rows are taller than the box their text is
scaled down, measured from the box, to no less than 85% of stock (1.1vw) so it
stays readable; the rest scrolls. Run when scoreboard data arrives, when the
SCOREBOARD tab is focused (`BaseMenuScreen.SetTabFocus`, mouse and keys) and on
`resize`. Screenshot: `docs/hud-audit/after-scoreboard-1920x1080.jpg` (21 rows
visible at 1080p, 3 more by scrolling).

### Checked and fine (PASS at all five resolutions, both name lengths)

Health, stamina, armor, buffs, FUNC and airdrop counters (no overlaps among
them or with the weapon stack), compass vs timer/ping, kill feed vs compass and
timer, location banner, match timer, weapon slots 1-5 and tooltip on screen,
spectator panel vs weapon slots and spectate buttons, spectator name (20
characters fit), team chat box vs compass, Showdown round banner on screen.

### Observations not changed

- The Showdown round banner ("ROUND 3 WON", 3.2 s) is drawn over the centre
  kill-feed column; it is short-lived and on top, so it reads. Not a failure.
- On 21:9 the stock HUD's vw sizing makes everything 34% larger than on 16:9
  at the same height (e.g. health bar 86 px tall at 3440×1440 vs 64 px at
  2560×1440). Nothing overlaps after the fixes; rescaling the stock HUD to
  height was not attempted (stock CSS lives in the paks).
- `RefreshPingSetting` (stock) calls `document.getElementById()` with no id
  and throws inside its promise; harmless, logged by the harness on every run.
- The separate `uiresources/Scoreboard/scoreboard.html` page is not referenced
  by `DefaultGame.ini` or any script; the scoreboard players see is the
  end-of-match one above.

## Status

| Item | Status |
|---|---|
| Harness renders the real HUD with stock CSS at 5 resolutions | PASS |
| Automated check (`node patch/test_hud_layout.js`) | PASS, 60/60 |
| Duo panel placement | PASS in Chromium; PARTIAL until seen in game (Duo match) |
| Kill feed vs wound icons on 21:9 | PASS in Chromium; PARTIAL in game |
| Showdown panel fit and Coherent-safe CSS | PASS in Chromium; PARTIAL in game |
| 24-row scoreboard reachable | PASS in Chromium; PARTIAL in game (Coherent's flex `min-height: 0` and scrolling with the mouse wheel) |
| Same layout in Coherent GT itself | NOT TESTED (no in-game run in this change) |

### In-game checks to do (through the launcher, against the VPS)

Build a test pak from this branch and check, at your monitor's resolution and
one other (Options > Video):

1. Duo match: the teammate's bar sits bottom left, right of the FUNC counter
   and above your armor/buff row, not over FUNC or the health bar; a long
   teammate name ends in "...".
2. Any match on a 21:9 screen (or windowed at 2580×1080): kill/game messages
   stop above the bone/wound icons at the bottom centre.
3. Showdown: the pre-round panel (right side) ends above the weapon slots;
   item pictures are not stretched; the "carrying now" squares have gaps.
4. A full 24-player match (bots fill): at the end, SCOREBOARD tab shows the
   rows; the mouse wheel scrolls to the last contestant.
5. Change resolution in a match (pause menu > video): the Duo bar and the
   message column follow.
