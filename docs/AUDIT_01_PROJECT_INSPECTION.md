# Audit 01: Project inspection (10-hour audit, 2026-11-05)

**Rollback point:** tag `pre-10h-audit` = `main` at `c0799be`, after PR #42 merged.

**Live at the start:**
- release **1.3.10** and launcher **1.3.3** (`https://xplab.shop:8443/remaster/manifest.json`);
- server `/health` reported `{"users":2,"matchesToday":2,"playersWeek":2}`.

## 1. What the project is

The Culling Remaster brings The Culling (Xaviant, 2016) back to life. It is not a rebuilt game. The Remaster:
- patches the **shipped, cooked Unreal Engine 4.15.3 client**;
- replaces the dead online services with **its own account and matchmaking server**;
- ships the result through **its own launcher**.

### Constraints that shape everything

| Constraint | Evidence | Consequence |
|---|---|---|
| No UE4 project, editor or C++ source | Only `TheCulling/` (cooked paks and `Victory.exe`) exists | Blueprint graphs, new maps, new materials and new shaders can't be authored. Changes are made by editing properties in cooked packages, patching the exe (`patch/patch_exe.py`, a native C module in `patch/showdown_rounds.c`), and HTML/JS menus |
| No dedicated game server | Matches open locally with `StartTraining(url)` → `open <map>?bEnableBots=true?game=…` (exe fix 3); an earlier `ConnectToServer` test bounced back to the menu | **Every match runs on the player's own PC with computer-controlled contestants.** Two humans can't be in the same match today. Being researched under "Real multiplayer" below |
| Shaders can't be compiled | Shipping copied shader maps caused "Corrupt data found" crashes (see `docs/ANIMATED_SKIN_AUDIT.md`) | New visuals must reuse stock materials as plain child instances |

## 2. Architecture

```
                 ┌───────────────────────── Player PC ─────────────────────────┐
  Launcher       │  The Culling Remaster.exe (Electron 45, launcher/)           │
  (1.3.3)        │   ├─ signed manifest  ──► https://xplab.shop:8443/remaster   │
                 │   ├─ downloads objects/<sha256>, verifies, repairs, rolls    │
                 │   │   back; updates itself from the signed manifest          │
                 │   ├─ account sign-in  ──► /api (server)                      │
                 │   └─ PLAY: Func.Launcher.exe → Victory.exe (+ Func client DLL)│
                 │                                                               │
  Game           │  Victory.exe (cooked UE 4.15.3, patched: fixes 1–8)           │
                 │   ├─ paks: stock pakchunk*.pak + LocalServer-…_P.pak (Remaster)│
                 │   ├─ menus/HUD: Coherent UI HTML/JS (patch/src/…/uiresources) │
                 │   │    └─ socket.io + REST ──► server (accounts, friends,     │
                 │   │       party, lobby, queue, shop, ranked, leaderboard)     │
                 │   └─ matches: local, with computer-controlled contestants;    │
                 │        the HUD posts the result to /api/matchresult           │
                 └───────────────────────────────────────────────────────────────┘
                                         │ HTTPS (Caddy on the VPS)
                 ┌──────────────── VPS 217.60.97.88 (Windows) ─────────────────┐
  Server         │ culling-server (Node/Express + socket.io, server/), 127.0.0.1 │
                 │  data: C:\culling\data (profiles, sessions, tickets, ranked,  │
                 │        friends, showdown series, activity)                    │
                 │ updates: C:\culling\updates (manifest.json + .sig, objects/)  │
                 │ website: C:\ssr\www\download (launcher setup)                 │
                 └───────────────────────────────────────────────────────────────┘
  Build PC: patch/ generators → make_pak → make_release (signs with the
            offline Ed25519 key) → "Publish Release.bat" on the VPS.
```

## 3. Feature inventory

Status words:
- **PASS:** verified with evidence.
- **PARTIAL:** some acceptance criteria verified.
- **NOT TESTED:** built, but not checked.
- **BLOCKED:** an environment or dependency is missing.

| Area | Feature | Status | Evidence / note |
|---|---|---|---|
| Launcher | Signed updates, repair, rollback, self-update | PASS | 12 test suites; 1.3.10 published and installed |
| Launcher | 1.3.3 (Electron 45) starts and connects | PASS | Started with its own profile; log shows `boot online:true release:1.3.9` |
| Launcher | Self-update 1.3.2 → 1.3.3 on a player PC | NOT TESTED | Published; no player report yet |
| Launcher | Activity line ("N played this week") | PARTIAL | Tested in the browser preview; the live `/health` has the fields |
| Server | Accounts, sessions, tickets, results, ranked, leaderboard, friends, party | PASS (unit and socket tests) | 21 server test files pass |
| Server | Party → Duo queue → same lobby | **FAIL** (user report) | Players reported separate lobbies → AUDIT_02 |
| Game | Solo (24 contestants, Jungle/Prison) | PASS | Played many times |
| Game | Duo (teammate, HUD, compass) | PASS | Played; screenshots |
| Game | In-world board and end-of-match scoreboard with 24 (fix 6) | PARTIAL | Sky board filled in a match; end-of-match tab not seen |
| Game | Duo ends with a team win (fix 7) | NOT TESTED | Statically verified; not in a release |
| Game | Chokening credits its activator (fix 8) | NOT TESTED | Statically verified; not in a release |
| Game | Showdown 1v1 rounds, first to 4 (fix 5) | PARTIAL | The earlier per-round version was played; the in-session rounds and rival kit weren't seen in game |
| Game | Survival, Training, Tutorial | PASS | Loaded in game |
| Game | Custom match settings | NOT TESTED | Branch `custom-match` not merged |
| Game | Trios, Quads, team Showdown | BLOCKED → in progress | Exe team pairing is pairs-only; agent working |
| Game | Real multiplayer (same match, same server) | BLOCKED → researching | See section 1; agent working |
| Menus | Player card + party cards, Ranked page, Duo HUD placement | PASS (menu) / NOT TESTED (HUD in match) | The card was seen in game with a real party; the HUD placement was checked in the harness |
| Cosmetics | 2,179 static camos, Necro Mist set | PASS | In game |
| Cosmetics | VFX camos (Dark Matter pulse, Wave scroll) | PARTIAL | Animate in the Customization preview; galaxy shell and Drift not tested |
| World | Night Jungle | PARTIAL | Loaded in a match; fog distance and FPS not measured |
| World | Night Prison, rain, weather timers | NOT TESTED / in progress | Agent working |
| Economy | Airdrop price −25% | Not started → in progress | Agent working |
| Weapons | Tier 3 audit and balance | Not started → in progress | Agent working |
| Bots | AI overhaul / "Mandriod" ML | Not started → in progress | Agent working (research first) |
| Perf | Loading times | Not measured → in progress | Agent working |
| Pipeline | Release safety (branch `fix-release-pipeline`) | PARTIAL | Built and tested on its branch; not merged; being integrated |

## 4. Bugs and risks, by severity

| # | Severity | Issue | Root cause (known or suspected) | Track |
|---|---|---|---|---|
| 1 | Critical (product) | Two humans can't play in the same match | No game server; client-only cooked build | Netplay feasibility |
| 2 | Critical | Party queues for Duo → separate lobbies | Under investigation (server party → queue → lobby path) | Party matchmaking |
| 3 | High | Publishing silently failed several times (1.3.7, first tries of 1.3.9) | The publish window's output wasn't seen; `releases\LATEST` lagged the build | Pipeline integration; publish docs |
| 4 | High | Release-safety work not on `main` | Branch predates fixes 6–8; its pinned exe hash is stale | Integration |
| 5 | High | Hard-linked setup objects were corrupted by a later rebuild (1.3.5 local copy) | `make_manifest` linked the setup into `objects/` | Fixed on `fix-release-pipeline` (copy, never link); integrating |
| 6 | Medium | Duo match didn't end with one team left | Team rule skipped in a Standalone net mode | Fix 7 (merged; needs an in-game check) |
| 7 | Medium | Gas kills read "Suicide" | Pylons started by the console have no Instigator | Fix 8 (merged; needs an in-game check) |
| 8 | Medium | Teammate armor not shown | The HUD event sends health and stamina only | Needs exe work; open |
| 9 | Low | `SetTeamMemberStatus` never updates `lastHealth` | Assignment inside a commented-out block (stock code) | Harmless (always redraws) |
| 10 | Low | Stale remote branches (`bot-names`, `installer`, `online-server`, `require-account-sticky`, `server-hardening`) | Old work, each one commit off `main` | Review for deletion; not deleted (user content) |

## 5. Feasibility of the requested expansion

| Request | Feasible here? | Why |
|---|---|---|
| Real online multiplayer on a dedicated server | **Unknown → researching** | Needs server or listen code in the client, or a server build. Not fakeable |
| Party-safe matchmaking and the same lobby | Yes (server) | Pure server/menu logic |
| Same in-game team for party members | Only with real netplay | Each PC runs its own match |
| Showdown Solo/Duos/Trios/Quads/Ranked | Solo: yes. Team sizes: likely (exe team-size work). Ranked: yes (server) | Local matches with computer-controlled teammates and rivals |
| HUD across resolutions | Yes | HTML/CSS |
| Tier 3 weapon changes | Yes (cooked property edits) | Needs numbers from the user; a proposal will be made |
| Airdrop −25% | Yes | Data and server |
| Animated camos | Partly | Pulse and scroll work; a moving glow needs the galaxy shell (being tested) |
| New maps | Variants only (Night versions) | No editor for new geometry or navmesh |
| Real-time weather | Partly | Fog, sky and light values are editable live; rain via retuned stock emitters; no wet-surface shaders |
| Night Mode | Yes | Lighting isn't baked; Night Jungle loaded in game |
| Bot AI rebuild + ML | Tuning yes; ML runtime unlikely | No editor for new behaviour trees; no ML runtime in a 4.15 shipping client |
| Faster loading | Possible in places | Must be measured before any claim |

## 6. Tracks running

The tracks run in parallel, each on its own branch from `main`.

| Track | Branch | Report |
|---|---|---|
| Real multiplayer feasibility | `netplay-feasibility` | `MULTIPLAYER_NETPLAY_FEASIBILITY.md` |
| Party, matchmaking and Showdown playlists | `party-matchmaking` | `AUDIT_02_PARTY_MATCHMAKING.md`, `SHOWDOWN_MODE_DESIGN.md` |
| Trios, Quads and team Showdown in game | `team-sizes` | `TEAM_SIZES_TRIOS_QUADS.md` |
| Airdrop price and Tier 3 weapons | `economy-weapons` | `WEAPON_TIER_3_BALANCE.md` |
| HUD resolutions and loading times | `hud-loading` | `HUD_RESOLUTION_AUDIT.md`, `LOADING_TIME_OPTIMIZATION_REPORT.md` |
| Bot AI | `bot-ai` | `BOT_AI_FULL_OVERHAUL.md` |
| Weather, night maps | `weather-night` | `MAPS_WEATHER_NIGHT_MODE_DESIGN.md` |
| Animated camos | `animated-camos` | `NEW_CAMOS_DESIGN_AND_TESTS.md` |
| Custom match + release pipeline integration | `integrate-custom-pipeline` | (in its report) |

In-game checks need the user's PC and are run when it is free. Results go into `AUDIT_09_FULL_REGRESSION_RESULTS.md`.
