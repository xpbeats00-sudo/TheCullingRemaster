# Game Mode Integration Report: Last Breath

Source spec: `Showdown/Showdown_mode.md` (v0.1, 2026-11-03). That file is the only content in `Showdown/`: no maps, Blueprints, audio or art came with it.

## Verdict

**Not playable in game.** Last Breath needs game-side logic the cooked build doesn't have: a round loop, 3- and 4-player teams, and a circular shrinking zone. In UE4 that logic lives in Blueprints or C++. Neither can be authored or compiled here: there is no `.uproject`, no source, no editor, and the game is a cooked UE 4.15.3 shipping build. Everything that can be built without that is built and tested: a server-side rules core and its configuration.

## Phase 0: project inspection (spec section 13)

| Item | Finding | How verified |
|---|---|---|
| Engine and build | UE 4.15.3, cooked WindowsClient shipping build. No `.uproject`, no source, no dedicated-server target. | Static: install folder, pak index |
| Existing game modes | 16 Blueprints in `/Game/Blueprints/GameMode/`: VictoryGameMode (+_Solo, _SoloRanked, _CoopRanked, _Lightning, _Lightning_Coop2, _Custom, _Practice, _Survival, _SurvivalAdvanced, _TrialsSolo, _NewTutorial, _PracticeRange, _EndOfMatch, _RandomShit) | Static: pak listing |
| Team support | Pairs only: `bPairTeams`, `bSpawnPairBalanced`, `EVictoryGameMode::LightningTeams` (VictoryGameMode_Lightning_Coop2). These are FFA-of-pairs flags. There's no N-vs-N team count and no 3- or 4-player teams. | Static: name table of the Blueprint |
| Gas system | `MatchPhaseManager_BP` drives the stock end-game gas. It's an "Iris" around the centre ring: IrisPhaseOne..Four, SetGasPhase1/2, GasIrisRef, gas pylons, Play_Announcer_Gas_Start. The phases are fixed in the Blueprint graph. No circle radius or timing parameter is exposed in config. | Static: name table of the Blueprint |
| Round loop | None in any mode. Matches are single-life battle royale. | Static: Blueprint names; no round or score names found |
| Config levers | `ShooterGameMode` ini (WarmupTime, RoundTime=0, KillScore...) and 17 custom-match mods (crate and pylon counts, health-station rates, recycler time; `?mods=` URL). None controls teams, rounds or zone geometry. | Static: DefaultGame.ini, CustomMatchSettings.js |
| How local matches start | The local server answers `match-ready` with `offline:<mapIndex>` and the game runs `StartOfflineMatch` on `OfflineMap` (Jungle_P with bots, VictoryGameMode). Only the map index is chosen server-side. | Static: server.js, DefaultGame.ini |
| Middle arena centre and bounds | **Unknown.** Needs the transform of the centre-ring actor in the Jungle level, which I didn't extract. The spec says not to guess these values, so zone geometry stays a parameter (`startRadius`, distance to centre). | Not verified |

## What was implemented

| Piece | File | Status |
|---|---|---|
| Tuning config (spec section 14 values, plus my assumed per-phase end radii, tolerance and tick, marked as not from the spec) | `server/data/lastbreath.ini` | Done |
| Rules core: config loader with validation, zone timeline with smooth radius interpolation, per-tick gas damage with boundary tolerance, team-size validation, round/match state machine (eliminations applied once per update, simultaneous wipe = drawn round, best of 7, first to 4, disconnect = elimination) | `server/lastbreath.js` | Done; not wired to the game |
| Tests for the logic-level acceptance criteria | `server/test/lastbreath.test.js` | 11/11 pass (`node test/lastbreath.test.js`) |

The tests caught one bug in my first draft. With the zone closed to radius 0, the 50-unit boundary tolerance still left a safe dot at the centre, so a player standing there never took gas damage. It's fixed: a fully closed zone damages everyone.

## Acceptance criteria (spec section 16)

| Criterion | Status |
|---|---|
| 1v1, 2v2, 3v3 and 4v4 can all start | Rules core only (tested). Not in game: no N-vs-N team mode |
| Teams spawn at fair, valid positions | Blocked: needs level data and spawn actors |
| A round starts and ends correctly | Rules core only (tested) |
| Gas inactive for the first 120 s | Rules core only (tested) |
| Gas shrinks smoothly through configured phases | Rules core only (tested) |
| Server consistently applies gas damage | Rules core only (tested). In game, damage is applied by the game, not this server |
| Healing cannot sustain a player in final gas | Partly: final gas kills a 100 hp player in under 3 s. Real healing rates not checked |
| Eliminations and round wins counted exactly once | Rules core only (tested) |
| Best-of-seven scoring works | Rules core only (tested) |
| Clients receive consistent match and zone state | Blocked: no game-side replication |
| Full 4v4 test without crash | Blocked: mode not playable |

## Blockers and what would unblock them

1. **No Blueprint authoring for a cooked build.** Round flow, team assignment, a circular damage volume and HUD replication all need new `GameMode`/`GameState` logic. Options, roughly from most to least realistic:
   - (a) A UE 4.15 editor project that recreates the needed Victory classes, used to author and cook a new GameMode Blueprint. This is a large reverse-engineering project, because the Blueprint must link against the native `Victory` module's classes.
   - (b) Native code injection into the shipping executable. Out of scope and fragile.
2. **Arena centre and radius.** Extract the centre-ring actor transforms from the Jungle level packages (the same parser the menu-arena work uses) before choosing `ZoneCenter`/`StartRadius`.
3. **Healing balance.** Needs in-game healing item rates.

## Rejected shortcut

A "LAST BREATH" menu tile that just launched a normal solo match against bots would have looked like an integration without being one. I didn't add it.
