# Full Project Audit: The Culling Remaster (local)

Date: 2026-11-03. Git checkpoint before this audit: `9fe0ad9` ("Checkpoint before full project audit").

**Verification legend.** *Static*: checked from files, by parsers or tests run here. *Runtime*: seen in the running game. I can't run or see the game, so every runtime fact comes from the user's in-game reports and is labelled that way.

## 1. Inventory

| Part | What it is | Size |
|---|---|---|
| `TheCulling/` | Cooked UE 4.15.3 WindowsClient shipping build (stock, untouched apart from the patch pak) | 5.7 GB |
| `TheCulling/Victory/Content/Paks/LocalServer-WindowsClient_P.pak` | Our patch pak, built by `patch/make_pak.py` from `patch/src` | 195.9 MB, 4541 files |
| `patch/` | Generators (Python), asset parsers, research dumps, `src/` staging tree | 674 MB |
| `server/` | Node local backend: ClientWeb stand-in, shop, ranked, tests | 12 MB |
| `CallingCards/`, `Camos/`, `Ranked/` | User-supplied source art | (ignored by git) |
| `Showdown/Showdown_mode.md` | Last Breath game mode spec, the only file in that folder | 1 file |

There's no `.uproject`, no source code and no Blueprint editor project. A "build" here means regenerating assets with the Python generators and repacking the patch pak. Nothing is compiled.

Custom content in the catalog (static count from `server/data/catalog.json`): 2183 weapon skins (59 camos × 37 weapons), 678 calling cards (48 animated + 630 classic), 9 ranked reward cards.

## 2. Calling card page freeze

**Symptom (runtime, user report):** opening the calling card page hangs the whole game.

**Evidence gathered this session:**

| Hypothesis | Test | Result |
|---|---|---|
| ~690 locked/purchasable cards make the page hang | Server flag made every card owned; the user opened the page | **Refuted (runtime).** Still froze. In `logs/server.card-owned-test.log`, inventory is fetched at 04:59:23–25, the menu's 15-second `/api/ranked` poll stops right after, and the socket times out at 05:00:05: the UI thread hung. Flag removed. |
| Card images exhaust UI memory | Measured: our 687 card PNGs decode to 519 MB (925×160 classic, 463×up to 2560 animated sheets) vs 319 stock cards (~189 MB) | **Not the cause as stated (static).** The card list is text-only (`AppearanceItemScreen` template). Only the selected card is previewed, so the images are not all loaded at once. |
| Crash dumps show the hang | `%LOCALAPPDATA%/TheCulling/Saved/Logs` | Two dumps exist from 13:50 and 19:11, both earlier crashes with empty call stacks. A hang writes no dump. The shipping build writes no text log. |

**Root cause: not yet identified.** Static analysis can't separate a hang in the native `GetFlairCustomizations` call from one in the list render. So this session added instrumentation:

- `uiresources/FrontEnd/js/UiTrace.js` posts a breadcrumb to the local server before and after each card-related native call (`GetFlairCustomizations`, `GetItemsForCustAndCat`, `SetPreviewItem`, `SetCustomization`, ...), synchronously where Coherent allows.
- `js/Screens/DynFlairItem.js` (the card screen; the stock file is copied, never edited in place) adds "items received / render start / render done" breadcrumbs. It also drops the stock `console.log(JSON.stringify(items))` of every card on every refresh. That dump is ~1000 items into Coherent's console bridge. Removing it is hygiene, not a proven fix.
- `server.js` logs these as `ui-trace` lines (`POST /api/uitrace`, route self-tested).

**Next step (needs one in-game run):** open the card page once. The last `ui-trace` line in `logs/server.log` names the step that hangs:

- the last line is `call GetFlairCustomizations` → the native call hangs (cards' data or texture packages);
- the last line is `flair list render start` → the list render;
- the last line is `call SetPreviewItem` → the preview of a specific card.

**Regression test:** none yet, because the cause isn't known. Once it is, a test should reproduce the failing step from the trace.

## 3. Animated skins

The full per-skin table is in `ANIMATED_SKIN_AUDIT.md`. Summary:

- 2183 skins, 0 structural failures (static: re-save, tag walk, texture platform data).
- Static reference audit of all 3100 custom packages: 0 bad, 2188 soft references resolved.
- **No skin is verified as animated in game.** 2179 are static camos. The 4 Ice Axe diagnostic skins isolate each piece of the scrolling-material path that produced "Serialization Error: Corrupt data found" in the earlier build. Their results are awaiting the user's report.
- FPS is not measured: no animated skin is active outside those tests, and no frame-time readout is reachable from the tools here.

## 4. New game mode (Last Breath)

See `GAME_MODE_INTEGRATION_REPORT.md`. In short, it's **not playable in game**. It needs a new GameMode Blueprint (rounds, N-vs-N teams, circular zone), which can't be authored for a cooked build. A tested server-side rules core and config were implemented (`server/lastbreath.js`, 11 tests).

## 5. Code audit

Static checks run:

| Check | Result |
|---|---|
| `node --check` on every server JS file | 5/5 ok (server.js, ranked.js, lastbreath.js, 2 backups) |
| Parse of every patch UI script | 10/10 ok |
| `py_compile` of every `patch/*.py` | 27/27 ok |
| `<script src>` in FrontEnd.html resolve to a file (patch or stock pak) | none missing |
| `server/test/ranked.test.js` | pass |
| `server/test/matchresult.test.js` (new) | pass |
| `server/test/lastbreath.test.js` (new) | 11/11 pass |

Findings:

| # | Severity | Finding | Action |
|---|---|---|---|
| 1 | High | `/api/matchresult` trusted raw numbers: `damage: 1e999` parsed to Infinity, so credits and XP became Infinity, stored as `null` in profiles.json, corrupting the profile. | **Fixed.** Values are bounded and non-finite values count as 0. Regression test `matchresult.test.js` runs a throwaway server with its own data folder (`CULLING_DATA_DIR`). |
| 2 | Medium | profiles.json was rewritten in place on every change. A crash mid-write would truncate it, and the next start would reset every profile. | **Fixed.** Write to `.tmp`, then rename. Exercised by `matchresult.test.js`. |
| 3 | Medium | `CARDS_OWNED_TEST` diagnostic flag left on: every calling card was free. | **Removed** (hypothesis refuted, section 2). |
| 4 | Low | The stock card screen dumps every card as JSON to the console on each refresh. | **Removed** in the patched `DynFlairItem.js` copy. |
| 5 | Low | `/api/matchresult` and `/api/ranked` use the last logged-in user. That's correct for this single-player local server and wrong if several clients share one server. | Documented, not changed. |
| 6 | Info | Match results (placement, kills, damage) are reported by the game client. There's no authoritative server for local bot matches. | Inherent. The ranked UI says "local test mode". |
| 7 | Info | `server/server.before-shop.js` and `server.before-ranked.js` were kept backups. They weren't loaded. | Removed with `server/data/catalog.before-*.json` (git history keeps them). |
| 8 | Info | 9 TODO/HACK comments in the patched `ClientWeb.js`, carried over from the stock file. | Left as-is. |

## 6. Performance

| Item | Status |
|---|---|
| Menu FPS regressions fixed earlier: 16K uncompressed sky → DXT1 + mips; distance-field shadows from the low moon off; double translucent water → one layer | Runtime: user confirmed "the issue is fixed for fps" |
| Card PNG memory: 519 MB decoded if every custom card were shown at once | Static measure. Not hit by the text list. Relevant only if a card grid view is added |
| Patch pak size 195.9 MB | Static |
| Animated skin FPS | Not measured (none active) |
| Last Breath server load (spec section 11) | Not applicable: mode not playable |

## 7. What was not done

- No in-game test was run by me in this session. The game isn't running, and runtime checks need the user.
- The card freeze root cause and the animated-skin corruption root cause are both narrowed, not found.
- Last Breath zone centre and radius were not extracted from the Jungle level.
