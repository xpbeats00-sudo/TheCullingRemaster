# The Culling Remaster --- Last Breath

## Game Mode Design & Implementation Specification

**Status:** Initial design draft\
**Mode:** Round-based team elimination\
**Arena:** The Culling middle arena\
**Formats:** 1v1, 2v2, 3v3, 4v4\
**Working title:** Last Breath

------------------------------------------------------------------------

## 1. Mode Overview

Last Breath is a round-based team elimination mode. Two teams fight
inside the middle arena, which is surrounded by toxic gas. The arena
begins fully accessible. After two minutes, the toxic boundary moves
inward until players are forced into a final confrontation.

The mode takes inspiration from compact round-based team gunfight modes
while using The Culling's arena, combat, survival, and toxic-zone
mechanics as its own identity.

### Core rules

-   Two teams compete to eliminate one another.
-   Supported formats: 1v1, 2v2, 3v3, and 4v4.
-   No respawns during a round.
-   Eliminated players may spectate surviving teammates.
-   A team wins when every opposing player is eliminated.
-   Toxic gas begins closing after 120 seconds.
-   Healing is allowed, but must not sustain players indefinitely in the
    gas.
-   Default match format: best of seven; first team to four round wins.

### Design goals

1.  Keep the opening two minutes tactical.
2.  Make the gas warning readable and fair.
3.  Prevent indefinite healing in the gas.
4.  Keep round length controlled without arbitrary instant deaths.
5.  Make all four team sizes viable.
6.  Make the server authoritative for damage, eliminations, and results.

------------------------------------------------------------------------

## 2. Match Formats

  Playlist     Team A   Team B   Total players
  ---------- -------- -------- ---------------
  Duel              1        1               2
  Doubles           2        2               4
  Trios             3        3               6
  Squads            4        4               8

Each format should have its own statistics and, ideally, its own
matchmaking population. If population is low, a combined queue can be
tested later, but teams should always be equal in size.

### Match structure

-   First team to four round wins.
-   Maximum seven rounds.
-   No mid-round respawns.
-   Between rounds, reset round-specific health, inventory, and status
    effects according to the loadout rules.
-   Preserve match score and match-level statistics.

Best-of-seven is a starting point and should remain configurable for
private matches and tournaments.

------------------------------------------------------------------------

## 3. Arena and Safe Zone

### Arena

Use the existing middle arena for the first implementation. Preserve
recognizable geometry and cover wherever possible. The gas should change
how the space is played rather than requiring a complete arena rebuild.

### Circular zone model

Represent the safe area as a circle with:

-   `ZoneCenter`: world-space center.
-   `CurrentRadius`: current safe radius.
-   `StartRadius`: radius at the start of a phase.
-   `TargetRadius`: radius at the end of a phase.
-   `PhaseStartTime`: authoritative server time when the phase began.
-   `PhaseDuration`: duration of the current phase.
-   `CurrentPhase`: current gas state.

The zone is authoritative and deterministic. Fog, particles, audio, and
warning effects are presentation layers driven by replicated zone state.
They must not independently apply gameplay damage.

Determine the actual center and starting radius from the arena bounds.
Do not guess these values.

------------------------------------------------------------------------

## 4. Toxic Zone Timeline

These are prototype targets, not final balance values.

  -----------------------------------------------------------------------
  Round time              Phase                   Intended behavior
  ----------------------- ----------------------- -----------------------
  0:00--2:00              Full Safe Zone          Entire arena is safe

  2:00--2:30              Warning / Initial       Warning cues; boundary
                          Collapse                begins moving inward

  2:30--3:00              Accelerated Collapse    Outer routes and cover
                                                  become unsafe

  3:00--3:30              Critical Collapse       Only a small central
                                                  area remains

  3:30 onward             Final Collapse          Safe radius approaches
                                                  zero
  -----------------------------------------------------------------------

### Zone movement

-   Interpolate the radius smoothly between phase start and target
    radius.
-   Use server time so clients do not simulate different schedules.
-   Replicate phase, phase start time, duration, and radius parameters.
-   Clients may interpolate visuals locally between authoritative
    updates.
-   Do not replicate every particle or fog actor.
-   Keep the boundary visually readable against the arena.

### Warning presentation

At 2:00, show:

-   HUD warning: `TOXIC GAS INBOUND`.
-   Distinct warning sound.
-   Visible movement of the gas wall.
-   Optional siren or environmental light cue.
-   Safe-zone indicator on the HUD or minimap, if available.

Players must be able to understand where the safe area is and how
quickly it is shrinking.

------------------------------------------------------------------------

## 5. Gas Damage and Healing

### Prototype damage curve

  Phase                    Initial damage target
  ---------------------- -----------------------
  Initial Collapse           5 health per second
  Accelerated Collapse      10 health per second
  Critical Collapse         20 health per second
  Final Collapse            35 health per second

These values must be tested against the game's actual health scale,
healing items, healing durations, and damage rules.

### Damage rules

-   The dedicated server determines whether each player is outside the
    safe zone.
-   Apply damage at a controlled server interval, not once per rendered
    frame.
-   Prevent boundary jitter from allowing players to avoid damage.
-   Use a small, tested boundary tolerance if needed.
-   Give gas damage its own damage type for logs and HUD feedback.
-   Gas damage continues during healing unless a specific item rule
    explicitly says otherwise.

### Healing rules

-   Existing healing items remain available initially.
-   Healing consumes its normal item or resource.
-   Healing does not pause the gas timer.
-   Gas damage continues during healing.
-   Healing may be interrupted by combat damage if that matches the
    existing system.
-   No unlimited healing source should exist in the final zone.

The goal is to make healing a temporary survival decision, not a way to
stall indefinitely.

### Anti-stalemate safeguards

If testing shows players can survive indefinitely:

1.  Increase late-phase gas damage.
2.  Reduce or limit healing availability in this mode.
3.  Add a final-collapse damage multiplier.
4.  Add a maximum round duration and clearly communicated overtime rule.

Change one variable at a time and measure the result.

------------------------------------------------------------------------

## 6. Round Flow

### Proposed state sequence

`WaitingForPlayers` → `MatchSetup` → `RoundIntro` → `RoundActive` →
`GasWarning` → `GasClosing` → `FinalCollapse` → `RoundResolution` →
`RoundReset` → `MatchResolution`

### Round start

-   Validate that both teams have the required number of players.
-   Assign teams and spawn points.
-   Reset round-specific health, inventory, and status effects.
-   Place players at their team spawn positions.
-   Prevent movement or combat during countdown if desired.
-   Start the authoritative round clock when the round becomes active.

### Elimination

-   Mark a player eliminated once, even if multiple damage events arrive
    in one server tick.
-   Remove the player from active combat.
-   Allow spectating of living teammates where applicable.
-   Check whether the opposing team has living players remaining.
-   Resolve the round when a team has no living players.

### Round reset

-   Clear temporary round state.
-   Reset the zone to its starting radius.
-   Restore round-specific arena objects if needed.
-   Reassign spawn positions.
-   Preserve match score and match-level statistics.
-   Begin the next round only when required players are ready.

------------------------------------------------------------------------

## 7. Spawn Design

Create separate spawn layouts for each team size.

Requirements:

-   Teams begin on opposite sides of the arena.
-   Avoid immediate line of sight between spawn points where possible.
-   No spawn point begins outside the safe zone.
-   No spawn point overlaps geometry or traps a player.
-   Both teams have comparable access to cover and routes.
-   Layouts should be mirrored or otherwise demonstrably fair.

  Format   Spawn requirement
  -------- ------------------------------------------------
  1v1      One spawn per team
  2v2      Two separated positions per team
  3v3      Three positions per team with room to maneuver
  4v4      Four positions per team without crowding

Swap starting sides during repeated tests to detect side advantage.

------------------------------------------------------------------------

## 8. Loadouts and Equipment

The correct approach depends on the existing weapon and inventory
systems.

Possible approaches:

-   **Preset loadouts:** Each player receives the same selected kit.
-   **Mirrored loadouts:** Both teams receive identical equipment
    options.
-   **Round-based rotation:** Loadouts change between rounds according
    to a fixed sequence.
-   **Existing survival inventory:** Use the current arena item economy
    if it can be made fair and predictable.

Recommended prototype: mirrored, deterministic loadouts. Avoid random
equipment differences that decide competitive rounds before players
engage.

Review healing, weapons, and armor together.

------------------------------------------------------------------------

## 9. HUD, Audio, and Feedback

### HUD

-   Team round score.
-   Round number.
-   Round timer.
-   Alive-player count for each team.
-   Gas phase warning.
-   Safe-zone indicator.
-   Player health and healing-item status.
-   Spectator state after elimination.

### Audio

-   Round countdown and start.
-   Gas warning at 2:00.
-   Gas movement warning.
-   Entering toxic gas.
-   Gas damage or escalating exposure cue.
-   Final-collapse warning.
-   Round victory and defeat.
-   Match victory and defeat.

Audio should communicate danger without drowning out footsteps or combat
information.

### Spectating

Eliminated players may spectate surviving teammates. Prevent unintended
free-camera behavior from revealing enemy positions.

------------------------------------------------------------------------

## 10. Suggested Unreal Architecture

These are proposed names, not claims about existing project classes.
Inspect the actual codebase before creating or renaming classes.

  Class/component                 Responsibility
  ------------------------------- -------------------------------------------------
  `GunfightGameMode`              Server-side match and round rules
  `GunfightGameState`             Replicated match state, timer, scores, phase
  `GunfightTeamManager`           Team assignment and spawn selection
  `ToxicZoneManager`              Zone radius, phase transitions, exposure checks
  `GunfightLoadoutManager`        Preset or mirrored equipment
  `GunfightHUD`                   Timer, score, team status, warnings
  `GunfightSpectatorController`   Post-elimination spectating

### Authority rules

The server owns:

-   Match and round state transitions.
-   Round timer.
-   Zone phase and radius.
-   Safe-zone checks and toxic damage.
-   Player elimination.
-   Team survival checks.
-   Round and match results.
-   Ranked or persistent rewards.

Clients handle presentation:

-   Gas fog and particles.
-   Boundary materials.
-   Local warning effects.
-   HUD interpolation.
-   Non-authoritative camera effects.

Never trust a client-reported gas hit, elimination, or round victory.

------------------------------------------------------------------------

## 11. Benchmarking and Performance

The maximum intended mode population is eight human players, excluding
spectators and optional test bots.

  Test     Players        Bots   Duration Purpose
  ------ --------- ----------- ---------- ----------------------
  A              2           0     15 min 1v1 baseline
  B              4           0     15 min 2v2
  C              6           0     20 min 3v3
  D              8           0     30 min 4v4 target
  E              8           0     60 min Long stability run
  F              8   As needed     30 min Optional stress test

Record:

-   Server CPU utilization.
-   Server memory use and growth.
-   Server frame/tick time.
-   Network bandwidth and packet loss.
-   Client latency and disconnects.
-   Gas damage consistency.
-   Zone replication consistency.
-   Round-state synchronization.
-   Crash logs and gameplay errors.

Do not assume VPS capacity from CPU/RAM specifications alone. Validate
under a full 4v4 match.

------------------------------------------------------------------------

## 12. Exploit and Edge-Case Checklist

-   [ ] Player disconnects during a round.
-   [ ] Player reconnects during a round.
-   [ ] Both teams are eliminated in the same server update.
-   [ ] Player dies to gas on the same tick as weapon damage.
-   [ ] Player crosses the zone boundary repeatedly.
-   [ ] Healing begins immediately before gas damage.
-   [ ] Healing item is consumed while player is eliminated.
-   [ ] All players remain in the gas.
-   [ ] A team has no valid spawn point.
-   [ ] A player joins after the round starts.
-   [ ] Server restarts during a match.
-   [ ] Client receives a delayed phase update.
-   [ ] Timer reaches zero at the same time as an elimination.
-   [ ] Spectator camera exposes enemy positions.
-   [ ] Duplicate elimination events award only one round win.

------------------------------------------------------------------------

## 13. Implementation Phases

### Phase 0 --- Project inspection

-   [ ] Inspect project structure and existing game mode classes.
-   [ ] Identify the actual arena map and bounds.
-   [ ] Locate team, player-state, damage, healing, and spawn systems.
-   [ ] Confirm Unreal Engine version and build type.
-   [ ] Determine whether a dedicated server target exists.
-   [ ] Record code conventions and dependencies.

**Exit condition:** A verified implementation plan based on actual
project files, not guessed class names.

### Phase 1 --- Playable round loop

-   [ ] Add team assignment.
-   [ ] Add 1v1 through 4v4 configuration.
-   [ ] Add spawn layouts.
-   [ ] Add round countdown and timer.
-   [ ] Add elimination tracking.
-   [ ] Add round and match scoring.
-   [ ] Add round reset.

**Exit condition:** Two teams can play repeated rounds and a
best-of-seven match without gas.

### Phase 2 --- Toxic zone

-   [ ] Add authoritative circular zone.
-   [ ] Add phase timing.
-   [ ] Add smooth radius interpolation.
-   [ ] Add server-side exposure checks and damage.
-   [ ] Replicate zone state.
-   [ ] Add client visuals, HUD warnings, and audio.
-   [ ] Test boundary behavior and late joins.

**Exit condition:** Clients see consistent zone behavior and the server
applies consistent damage.

### Phase 3 --- Healing and balance

-   [ ] Integrate existing healing items.
-   [ ] Verify gas damage continues during healing.
-   [ ] Test healing-versus-gas sustainability.
-   [ ] Tune phase durations and damage.
-   [ ] Add anti-stalemate safeguards only if required.

**Exit condition:** Gas reliably forces engagement without making the
opening phase unfair.

### Phase 4 --- Competitive presentation

-   [ ] Add team score HUD.
-   [ ] Add round intro and result screens.
-   [ ] Add spectator flow.
-   [ ] Add audio and visual polish.
-   [ ] Add match statistics.
-   [ ] Add private-match configuration.

**Exit condition:** A complete match can be played and understood
without developer tools.

### Phase 5 --- QA and release readiness

-   [ ] Complete all team-size tests.
-   [ ] Complete disconnect and edge-case tests.
-   [ ] Complete dedicated-server stability test.
-   [ ] Verify server authority and anti-exploit behavior.
-   [ ] Review performance captures.
-   [ ] Document final tuning values.
-   [ ] Record known issues and rollback procedure.

**Exit condition:** No known critical match-flow, zone-authority, or
round-scoring defects.

------------------------------------------------------------------------

## 14. Initial Tuning Configuration

Keep prototype values in one configuration location rather than
scattering constants through code.

``` ini
[LastBreath]
RoundsToWin=4
MaxRounds=7
FullSafeDurationSeconds=120
InitialCollapseDurationSeconds=30
AcceleratedCollapseDurationSeconds=30
CriticalCollapseDurationSeconds=30
FinalCollapseDurationSeconds=30

InitialGasDamagePerSecond=5
AcceleratedGasDamagePerSecond=10
CriticalGasDamagePerSecond=20
FinalGasDamagePerSecond=35

SupportedTeamSizes=1,2,3,4
RespawnsEnabled=false
HealingEnabled=true
```

These are starting points. Confirm the configuration format matches the
project's actual Unreal setup before using it.

------------------------------------------------------------------------

## 15. Open Questions

Resolve these after inspecting the game systems:

1.  Does the middle arena have a clear geometric center suitable for the
    zone?
2.  Can the damage system distinguish toxic damage from weapon damage?
3.  Can existing healing items be restricted or configured per mode?
4.  Should loadouts be fixed, mirrored, or selected by players?
5.  Should the gas stop at a tiny final circle or close to zero?
6.  Should a round have a hard time limit in addition to the gas?
7.  Should ranked matchmaking launch with all four team sizes or begin
    with 1v1 and 2v2?
8.  Are spectators allowed in private matches?
9.  What happens when a player disconnects or abandons a ranked round?

------------------------------------------------------------------------

## 16. Initial Acceptance Criteria

-   [ ] 1v1, 2v2, 3v3, and 4v4 can all start.
-   [ ] Teams spawn at fair, valid positions.
-   [ ] A round starts and ends correctly.
-   [ ] Gas remains inactive for the first 120 seconds.
-   [ ] Gas shrinks smoothly through configured phases.
-   [ ] Server consistently applies gas damage.
-   [ ] Healing cannot sustain a player indefinitely in final gas.
-   [ ] Eliminations and round wins are counted exactly once.
-   [ ] Best-of-seven match scoring works.
-   [ ] Clients receive consistent match and zone state.
-   [ ] A full 4v4 test completes without critical crash or
    synchronization failure.

------------------------------------------------------------------------

## Change Log

  -----------------------------------------------------------------------
  Version                 Date                    Changes
  ----------------------- ----------------------- -----------------------
  0.1                     2026-11-03              Initial mode concept,
                                                  rules, gas timeline,
                                                  technical architecture,
                                                  test plan, and
                                                  acceptance criteria

  -----------------------------------------------------------------------

**Document note:** This is a design and implementation specification. It
does not claim that the mode has been implemented or tested. Update
checkboxes and tuning values only after verifying actual project changes
and test results.
