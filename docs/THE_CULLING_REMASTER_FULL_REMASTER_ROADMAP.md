# The Culling Remaster — Full Remaster Gap Analysis & Roadmap

**Review date:** 2026-11-04  
**Reviewed source:** all 15 Markdown documents in the supplied `docs.rar` archive  
**Purpose:** identify what exists, what is incomplete, the hard technical blockers, and the work required to deliver a genuine remaster.

---

## 1. Executive assessment

The project has made meaningful progress on a **launcher, distribution pipeline, local backend, cosmetic catalog, menu presentation, and modded cooked-game build**. It is not yet a full game remaster.

The central constraint is architectural: the documented game is a **cooked Unreal Engine 4.15.3 Windows client**. The project inventory explicitly reports no `.uproject`, no Unreal source code, no Blueprint editor project, and no dedicated-server target. The current build process generates assets and repacks a patch `.pak`; it does not compile a new game.

That means the current approach can improve or override some existing assets and UI, but it cannot safely deliver major new game-side systems—such as new GameModes, authoritative multiplayer, new replication, or a fully integrated round/zone system—without recovering or rebuilding the appropriate Unreal project and game-side code.

**Confirmed product vision (2026-11-04): Expanded remaster with real online multiplayer required.** The target is the original Culling experience expanded with substantial new modes, weapons, maps, cosmetics, progression, and a production-capable online service. Offline/bot play is useful for development and fallback, but it is not the final product. Real online multiplayer is a launch requirement, not a later optional enhancement.

**Bottom line:** the most important next step is not another cosmetic pack. It is proving a viable game-client and authoritative-server architecture. Until that is solved, the project should be described as a revival/remaster-in-progress, not a complete remaster.

## 2. What already exists

### Strong foundations

- A packaged game install is being distributed as a roughly 6 GB release.
- A custom Electron launcher has differential updates, SHA-256 verification, signed manifests, resumable downloads, staging, repair, rollback, and structured logs.
- The launcher 1.2.0 test record reports 57 automated tests passing, plus live download/install/repair measurements.
- A Node account backend supports login, profiles, currency, shop/catalog data, calling-card data, ranked data, matchmaking responses, and match-result intake.
- The backend has substantial local tests and load-test work. The documented 30-client local test passed with no errors.
- Custom content includes 2,183 weapon-skin catalog entries across 37 weapons and 59 camos, 678 calling cards (48 animated and 630 classic), and 9 ranked reward cards.
- Menu presentation work includes a custom arena/night-sky direction, fog, sea, floodlights, moon, sky effects, and branding/UI changes.
- A Last Breath rules core exists with tests for zone timing, damage, teams, rounds, and best-of-seven scoring.
- Several performance, reliability, persistence, and security issues have already been found and fixed in development branches.

These are useful foundations. They do not prove that every feature is integrated or playable in the game.

## 3. Critical gaps and current status

| Area | Current documented state | What is still missing |
|---|---|---|
| Unreal project | Cooked UE 4.15.3 client; no `.uproject`, source, editor project, or dedicated-server target | Recover a legitimate compatible source project or build a new compatible project and determine what original game code can legally and technically be reused |
| Core gameplay | Original offline match against bots works through the local setup | Full regression pass, game-side system ownership, and a clear plan for modifying core mechanics |
| New modes | Last Breath rules core is tested on the backend | GameMode/GameState logic, team assignment, round flow, zone actor, HUD/state replication, spawn positions, and in-game 4v4 validation |
| Online multiplayer | Account server returns `offline:<map>`; actual match runs locally on each player's PC | Dedicated authoritative game server, real client connections, replication, server-side movement/combat/damage/inventory/results, matchmaking lifecycle, reconnects, and anti-cheat strategy |
| Ranked | Local test-mode ELO and profile display exist | Trusted match results, real opponents, server-authoritative ratings/rewards, seasons, disconnect/abuse handling, and full end-to-end tests |
| Weapon skins | 2,179 are static texture camos; four Ice Axe diagnostic variants test the animated path | Fix the serialization/material path, prove a time-driven material animation in-game, profile it, then scale the proven method to other weapons |
| Calling cards | 678 catalog entries; 48 animated assets | The calling-card page still freezes; root cause unknown; animation playback, lifecycle, memory, and rapid open/close tests still required |
| Cosmetics/inventory | Shop/catalog and currency backend exist | Native game entitlement/inventory format is not fully mapped; local server docs say cosmetic entitlements are not served yet and store/crates are disabled in that local setup |
| Maps/environments | Existing cooked maps and menu environment work are being reused | Map audit, missing/unused content research, new map integration path, collision/nav/spawn validation, lighting/performance and multiplayer testing |
| Bots | Stock bot matches; a bot-tuning draft exists | Real-match behavior test, navigation/stuck recovery, decision quality, combat fairness, CPU budgets, difficulty controls, and reliable telemetry |
| Launcher/release | 1.2.0 works in tests but is on an unmerged PR; 1.1.0 is live | Merge/review, publish, test in-game login at the screen, VPS load test, real reboot/rollback tests, and final release process |
| Account server | Hardened code and dependency fixes exist on branches | Production is still documented as vulnerable until `server-hardening` and `server-deps` are merged and deployed |
| Security | Signed update manifests; several server fixes tested | Production deployment, VPS verification, signing-key backup, code-signing decision, authoritative game server security, privacy/retention policy |
| Audio | Not comprehensively audited in the supplied reports | Full sound/music/voice/announcer audit, replacement/upgrade plan, mix, spatialization, accessibility and licensing |
| Accessibility/options | Launcher checks have begun | In-game settings audit: resolution, FOV if supported, sensitivity, remapping, subtitles, color/accessibility options, UI scaling, graphics presets |
| QA/release | Launcher and backend have test evidence | Full in-game test matrix, multiple PC hardware tiers, long sessions, multiplayer tests, crash recovery, compatibility, release candidate and rollback process |

## 4. Immediate P0 actions — stabilize what already exists

These tasks should happen before large new feature work.

1. **Deploy the account-server security fixes.**
   - Review and merge the documented `server-hardening` branch and `server-deps` PR.
   - Run the VPS update script.
   - Verify service health, watchdog behavior, `/metrics` exposure, logs, and the actual deployed build.
   - Re-run the 30-client load test against the VPS, not just the build PC.
   - Keep a tested rollback path.

2. **Merge and publish launcher 1.2.0.**
   - Review/merge PR #11.
   - Publish the launcher setup and manifest from the VPS.
   - Verify a clean install, update, repair, pause/resume, and rollback using the public release.
   - Test the game reaching the menu and logging in with a person physically observing the screen.
   - Update website version labels only after publication.

3. **Back up the release signing key offline.**
   - Confirm recovery instructions and restrict access.
   - Do not put the private key in source control or the game package.

4. **Resolve the calling-card freeze.**
   - Run the instrumented build and open the card page once.
   - Read the last `ui-trace` breadcrumb to isolate native data retrieval, list rendering, or preview selection.
   - Fix the actual failing step; then test repeated open/close, switching cards, large collections, and animation cleanup.

5. **Complete the Ice Axe animation diagnostic.**
   - Test the five diagnostic cases in order: static control, BC-only, stock mesh override, copied mesh with stock material, full animated material path.
   - Record the first case that fails and its exact error.
   - Do not label skins animated until actual in-game motion is visible and performance is measured.

6. **Playtest the bot tuning.**
   - Verify real-match behavior, navigation, stuck recovery, combat, and CPU impact.
   - Keep the change separate until it passes.

## 5. P0 strategic decision — choose the remaster architecture

This is the project's largest blocker. Before building major new game systems, establish which of these routes is feasible.

### Route A — Recover the original compatible Unreal project

Best outcome if legitimate project files and rights/access can be obtained.

Required:
- Original `.uproject`, source code, Config, Content, Plugins, and build scripts.
- Exact engine version and custom engine modifications, if any.
- Required native modules and third-party dependencies.
- Original Blueprint class dependencies and asset references.
- A reproducible editor build and packaged client.
- A dedicated-server target if the original project supports one or can be extended.

**Gate:** build the unmodified game from the recovered project before attempting remaster changes.

### Route B — Reconstruct a compatible UE 4.15.3 project

This is a substantial reverse-engineering and reconstruction effort, not a quick asset import.

Required:
- UE 4.15.3 editor/toolchain compatibility.
- Reconstructed project structure and asset packages.
- Compatible class definitions and native module interfaces.
- Recreated or recovered Blueprint logic.
- Asset dependency and package validation.
- A proof that a minimally modified client can be cooked and launched.

**Risk:** cooked assets alone do not recreate the original C++ source, Blueprint graphs, server code, or all build dependencies. A reconstructed project may not reproduce the original game's behavior.

### Route C — Continue as a cooked-build mod/remaster

This is the most practical short-term route with the current documented files.

Possible scope, subject to package compatibility:
- UI/HTML/Coherent changes.
- Existing asset replacement and additions.
- Materials/textures/meshes that the cooked build can load.
- Menu, branding, cosmetics and data-driven backend features.
- Configuration and supported game settings.

Not a safe promise under this route:
- New native gameplay systems.
- New authoritative multiplayer.
- A real dedicated server.
- New GameMode/round/replication architecture.
- Reliable changes to compiled native behavior.

**Recommendation:** continue Route C for safe polish and release stabilization, while running a separate feasibility investigation for Route A/B. Do not sink months into new modes or multiplayer until the engine/source path is proven.

## 6. Full remaster roadmap

### Phase 0 — Project ownership, source recovery, and baseline

Deliverables:
- Source/build inventory and provenance record.
- Confirmed rights and permitted use for game code, assets, trademarks, music, and distribution.
- Exact engine version, compiler/toolchain, plugins, and dependencies.
- Reproducible clean baseline build (or written proof that it cannot be reproduced).
- Source-control strategy, branch protections, backups, and build artifact retention.
- Architecture decision record selecting Route A, B, or C.

Acceptance:
- A clean, repeatable build can be produced, or the project limitations and chosen fallback are explicitly documented.

### Phase 1 — Stabilize launcher, backend, and live service

Deliverables:
- Launcher 1.2.0 merged and publicly published.
- Account-server hardening merged and deployed.
- VPS load test and monitoring evidence.
- Backup/restore drill for profiles and release metadata.
- Release signing-key backup and recovery procedure.
- In-game login and launch smoke test.
- Updated `KNOWN_ISSUES.md`, `TEST_RESULTS.md`, and `NEXT_STEPS.md`.

Acceptance:
- A new player can install, launch, update, repair, and recover without manual file manipulation.
- Production backend passes target load and security checks.

### Phase 2 — Core game stability and compatibility

Audit and validate:
- Startup, title screen, login, matchmaking, map loading, match start/end.
- Solo, duos, training/offline, and every existing supported mode.
- Every weapon, melee weapon, ranged weapon, consumable, armor item, healing item, loot container, recycler, trap, and interactable.
- Character movement, climbing/vaulting, melee hit detection, ranged projectiles, damage, healing, death, spectating, and respawn behavior where supported.
- Physics, collision, animation state transitions, audio cues, UI prompts, and save/profile behavior.
- Performance, crashes, memory growth, and compatibility across resolutions and hardware tiers.

Deliverables:
- `GAMEPLAY_SYSTEM_AUDIT.md`
- `COMPATIBILITY_MATRIX.md`
- Reproducible test cases and prioritized bug backlog.

Acceptance:
- No known critical gameplay blocker; all supported original modes pass the regression matrix.

### Phase 3 — Visual remaster

Work from a consistent art direction rather than isolated effects.

**Environment and maps**
- Audit each existing map and menu environment.
- Improve lighting, shadows, fog, sky, atmosphere, water, vegetation, materials, terrain detail, props, and environmental storytelling.
- Improve texture resolution selectively; use mipmaps, correct compression, and platform budgets.
- Improve LODs, culling, occlusion, draw calls, shader complexity, and streaming.
- Validate collision, navmesh, visibility, and performance after environment edits.

**Characters and weapons**
- Audit character models, clothing, hands, weapon meshes, first-/third-person presentation, animations, and attachment points.
- Improve materials, roughness/metalness, normal maps, wear, and readable silhouettes.
- Verify every weapon animation and attachment in gameplay, not just in an asset viewer.

**Lighting and effects**
- Build coherent day/night and weather presentation where supported.
- Add restrained rain, thunder, lightning, dust, smoke, sparks, impact effects, blood, fire, gas, and ability/interaction feedback.
- Ensure VFX communicate gameplay state and do not obscure targets or overload low-end GPUs.

**Performance targets**
- Define minimum/recommended hardware.
- Set frame-rate and frame-time budgets for menu, normal match, and worst-case combat.
- Profile GPU, CPU, memory, shader compilation, and asset streaming.
- Provide scalable graphics settings and safe low-end fallbacks.

Deliverables:
- `VISUAL_REMASTER_GUIDE.md`
- Map-by-map art audit.
- VFX/material validation report.
- Before/after performance captures.

### Phase 4 — Audio remaster

- Inventory all music, ambience, footsteps, weapon sounds, impacts, UI sounds, announcer lines, voice and environmental audio.
- Confirm ownership/licensing and identify missing source assets.
- Improve clarity, loudness consistency, spatial positioning, occlusion/reverb where supported, and mix separation.
- Add volume sliders and relevant accessibility options.
- Test audio cues in noisy combat and with different output devices.

Deliverable: `AUDIO_REMASTER_AUDIT.md`.

### Phase 5 — Gameplay and modes

Only proceed with game-side implementation after the engine/source architecture gate is passed.

- Establish a documented gameplay rules layer and authoritative state ownership.
- Improve bot perception, target selection, navigation, stuck recovery, combat decisions, and difficulty.
- Validate weapon balance, armor, healing, loot, crafting/recycling, traps, and match pacing.
- Implement Last Breath in the game: team sizes 1v1 through 4v4, fair spawns, round lifecycle, shrinking zone actor, damage, HUD replication, spectating, disconnects, and best-of-seven results.
- Test all team sizes and edge cases, including simultaneous eliminations, late joins, reconnects, and server restarts.
- Keep existing modes intact and regression-test them.

Deliverables:
- `GAMEPLAY_SYSTEM_AUDIT.md`
- `AI_PERFORMANCE_REPORT.md`
- `GAME_MODE_INTEGRATION_REPORT.md`

### Phase 6 — Real online multiplayer (mandatory launch workstream)

**This phase is a release blocker because online multiplayer is required by the owner.** It is not acceptable to ship the final expanded remaster with only local/offline matches or client-submitted match results.

The existing account server is not a game server. It currently handles accounts and returns local/offline matches.

Required architecture:
- Dedicated server build of the game, or another technically valid authoritative simulation.
- Server-authoritative movement, combat, damage, inventory, loot, match state, and results.
- UDP game transport and per-match process/port lifecycle as appropriate to the engine.
- Matchmaking, lobby, party, region selection, server allocation, reconnects, disconnect penalties, spectators, and match cleanup.
- Persistence for accounts, inventory, progression, ranks, seasons, purchases, and match history.
- Anti-cheat and abuse controls designed around server authority.
- Operational monitoring, crash recovery, capacity limits, DDoS/firewall strategy, backups, and incident response.
- Network simulation for latency, jitter, packet loss, reconnects, and bandwidth.

Do not advertise online multiplayer as complete until real remote clients can join the same match hosted by an authoritative game server, and do not advertise ranked until match results are generated and validated by trusted server-side logic.

Deliverables:
- `ONLINE_ARCHITECTURE.md`
- `NETWORK_TEST_PLAN.md`
- Dedicated-server deployment and operations guide.

### Phase 7 — Cosmetics, progression, and player identity

- Fix the calling-card freeze and verify all 678 cards.
- Establish a supported animated-card format with lifecycle cleanup and memory budgets.
- Prove one animated weapon skin end-to-end before converting the catalog.
- Build reusable animated material functions and documented texture/mask conventions.
- Validate all 2,183 catalog entries, weapon mappings, ownership, prices, preview, equip, and persistence.
- Build a real inventory/entitlement bridge into the game UI.
- Verify the 9 rank tiers, ELO progression, seasons, rewards, profile badges, stats, medals, kill feed, and match results.
- Prevent duplicate rewards and client-side manipulation.
- Audit cosmetics for clipping, visibility, readability, and performance.

Acceptance:
- Each item can be acquired/equipped, persists across sessions, displays correctly in-game, and passes the appropriate runtime test.
- Animated means time-driven motion observed in-game, not merely a glowing static texture.

### Phase 8 — Launcher and product experience

- Finish first-run setup, install-path selection, repair, update, rollback, and diagnostics.
- Add clear release notes, version/channel information, server status, and maintenance messages.
- Add optional content only with dependency validation and clear disk-space estimates.
- Decide whether a code-signing certificate is worth purchasing; do not misrepresent the current unsigned installer.
- Consider CDN/object storage only when measured concurrency or geography justifies it.
- Improve accessibility, high-DPI behavior, resizing, keyboard navigation, and error recovery.
- Publish website documentation, requirements, known issues, privacy policy, and support instructions.

### Phase 9 — Release candidate and public launch

- Clean install on a fresh Windows machine.
- Upgrade from every supported prior launcher/game version.
- Repair corrupted, missing, and modified files.
- Pause/resume after app close and real machine reboot.
- Rollback on a disposable install.
- Test on minimum/recommended hardware and multiple resolutions.
- Test every game mode, weapon category, cosmetic category, and progression path.
- Multiplayer network tests if authoritative multiplayer is implemented.
- Long-duration soak, crash recovery, backup restore, and security review.
- Verify licenses, attribution, privacy, and distribution permissions.
- Publish release notes, support process, rollback plan, and status page.

---

## 7. Recommended priority order

| Priority | Work | Reason |
|---|---|---|
| P0 | Deploy account-server hardening and publish launcher 1.2.0 | Known production/security and distribution blockers |
| P0 | Fix calling-card freeze and finish Ice Axe animation diagnosis | Two visible in-game defects currently unresolved |
| P0 | Make the Unreal source/project architecture decision | Determines whether a genuine gameplay remaster and dedicated server are possible |
| P1 | Full gameplay compatibility audit | Protects the original game experience |
| P1 | Rebuild one proven animated skin pipeline | Establishes whether the 2,179 static entries can be upgraded safely |
| P1 | Map, character, weapon, VFX, and audio audits | Creates a consistent remaster quality bar |
| P1 | Bot AI and performance validation | Improves offline play without requiring online architecture |
| P2 | Last Breath game integration | Depends on game-side authoring/source path |
| P0 | Prove dedicated authoritative multiplayer feasibility with a playable networked vertical slice | Required product feature; blocks the final release |
| P1 | Build production dedicated-server hosting, matchmaking and operations | Required for real online launch |
| P2 | Expand online modes, ranked seasons, progression and live operations | Depends on reliable authoritative matches |
| P2 | Ranked seasons, full progression, inventory entitlements | Depends on trusted match outcomes and game integration |
| P3 | Optional content, CDN, extra polish and live operations | Scale and product maturity after core functionality |

## 8. Confirmed product decisions and remaining access questions

### Confirmed by the owner

- **Product direction:** Expanded remaster — preserve and modernize the original experience while adding substantial new modes, weapons, maps, cosmetics, and progression.
- **Online requirement:** Real online multiplayer is mandatory for the intended final product. Offline/bot play is a development and fallback capability, not a substitute for online play.

### Remaining access and feasibility questions

1. Can the original Unreal project/source code be obtained, and is its use/distribution authorized?
2. Is a compatible UE 4.15.3 editor/toolchain available, and can it produce a reproducible client build?
3. Can a dedicated-server target be built from the recovered project, or will a compatible game-server architecture need to be reconstructed?
4. Are there original source assets, maps, audio, and unreleased content outside the current cooked install?
5. What initial concurrent-player target, regions, and match sizes should the service support?
6. Is paid infrastructure (CDN, code-signing certificate, additional server capacity) approved?
7. Who will perform in-game visual/runtime checks when automated tooling cannot observe the game?

## 9. Definition of “fully remastered”

Do not call the project complete until all applicable criteria are met:

- A reproducible, supportable game build exists under the selected architecture.
- Original core gameplay works reliably.
- Visual, animation, effects, and audio upgrades are coherent and performant.
- Maps, characters, weapons, interactions, and game modes pass runtime QA.
- Cosmetics, calling cards, inventory, ranks, and progression work end-to-end.
- The launcher installs, updates, repairs, and rolls back reliably.
- Production services are secured, monitored, backed up, and load-tested.
- Real online multiplayer is delivered: remote clients join the same authoritative match; server owns movement/combat/damage/inventory/match results; matchmaking allocates and cleans up sessions; reconnect/disconnect behavior is tested; and service operations, monitoring, backups, security and capacity are supportable.
- Compatibility, performance, accessibility, licensing, privacy, and support documentation are complete.
- Every release gate has observed test evidence; no feature is marked done solely because code or assets were generated.

## 10. Important distinction

A polished launcher, custom menu, large cosmetic catalog, and account backend are valuable parts of the product. They are not substitutes for a rebuilt game client, game-side gameplay systems, or an authoritative multiplayer server.

The fastest responsible route is:

1. Stabilize and publish the existing launcher/backend.
2. Fix the visible card and skin defects.
3. Prove the Unreal source/project path.
4. Complete a gameplay regression audit.
5. Build a coherent visual/audio remaster.
6. Integrate new gameplay and online systems only when the engine architecture supports them.
7. Release only after end-to-end runtime and performance validation.


## 11. Refined delivery strategy for the confirmed expanded + online vision

The project should now be managed as **two coordinated tracks with hard integration gates**, not as a long list of unrelated features.

### Track A — Preserve and expand the game

- Stabilize the original playable experience first.
- Build a complete inventory of original maps, modes, weapons, interactions, bots, characters, animations, UI, audio and assets.
- Improve the original experience without breaking its identity or gameplay readability.
- Add new maps, weapons, modes, cosmetics and progression in controlled releases.
- Keep offline/bot matches working as a regression environment and fallback.

### Track B — Build the online platform

- Prove a real dedicated authoritative game server is technically possible.
- Connect two remote clients to the same match as the first network milestone.
- Move all competitive outcomes and important game state to server authority.
- Build match allocation, matchmaking, parties/lobbies, reconnects, persistence, ranked validation and operations around that working match loop.
- Load-test and security-test the deployed service before opening it to players.

### Mandatory online vertical slice — first major engineering milestone

Before expanding online features, deliver one small but real end-to-end match:

1. Two separate PCs authenticate against the account service.
2. Both clients enter the same lobby or matchmaking queue.
3. The backend allocates a dedicated game server process/session.
4. Both clients connect to that server and see each other in one match.
5. The server validates movement and combat outcomes; clients cannot award themselves kills or wins.
6. The server ends the match and produces the trusted result.
7. The backend records the result and updates the players' profiles.
8. The server shuts down or returns to its pool cleanly.
9. The test is repeated with latency, packet loss, disconnect/reconnect, server crash and restart scenarios.

**Acceptance gate:** this must be demonstrated with real remote clients and server logs. A local mock, API response, offline match, or simulated matchmaking result does not pass.

### Release milestones

| Milestone | Required outcome | Release meaning |
|---|---|---|
| M0 — Stable foundation | Launcher/backend security and release pipeline stable; current defects triaged | Internal development build |
| M1 — Reproducible game build | Compatible engine/project path demonstrated; original gameplay regression baseline recorded | Technical feasibility proven |
| M2 — Networked vertical slice | Two remote clients complete one authoritative match on a dedicated server | Online architecture proven |
| M3 — Core online alpha | Matchmaking, session lifecycle, reconnect/disconnect, server results and persistence work reliably | Closed technical alpha |
| M4 — Expanded gameplay alpha | Existing modes stable; first new mode/map/content integrated and tested | Feature alpha |
| M5 — Remaster beta | Visual/audio upgrades, cosmetics, progression and online service integrated; performance and security gates pass | Invite beta |
| M6 — Release candidate | Full compatibility, load, soak, recovery, network and operational tests pass | Candidate for public launch |
| M7 — Public launch | Support, monitoring, backups, incident response, rollback and release documentation ready | Public expanded remaster |

### Scope control: what not to do yet

Until M1 and M2 pass, avoid:
- Building many new modes that depend on unproven game-side code.
- Promising ranked play based only on the current account API.
- Treating local/offline matchmaking responses as multiplayer.
- Converting the entire skin catalog to animation before one end-to-end animated skin is proven.
- Adding more launcher features while production blockers and the calling-card freeze remain unresolved.

This does not mean stopping creative work. It means keeping cosmetic, menu, asset and documentation work in parallel while the architecture proof receives the highest engineering priority.

### Revised definition of success

The finished product is an expanded, recognizable Culling experience with:
- Stable original gameplay and carefully integrated new content.
- A coherent visual and audio upgrade.
- Working weapons, maps, modes, bots, cosmetics and progression.
- A reliable launcher and account platform.
- Real authoritative online multiplayer with matchmaking and dedicated-server operations.
- Evidence-backed performance, security, compatibility and recovery testing.

A feature is complete only when it works in the packaged game and passes its runtime acceptance test—not when a design document, backend endpoint, asset, or catalog entry exists.
