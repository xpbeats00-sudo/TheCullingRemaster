# The Culling Remaster --- Ranked Mode Design

**Status:** Proposed design; not yet implemented.

## 1. Vision

Create a competitive mode that preserves The Culling's identity:
scavenging, crafting, tactical combat, and being the last survivor.
Reward winning and consistent survival rather than kill farming.

**Identity:** Compete. Survive. Eliminate. Dominate.

## 2. Recommended launch format

  Setting              Proposal
  -------------------- ----------------------------
  Playlist             Ranked Solo
  Match format         Free-for-all survival
  Maximum players      16
  Starting rating      1,000 ELO
  Placement matches    5
  Rank tiers           9
  Main rating factor   Match placement
  Leaderboards         Global and regional
  Rewards              Permanent cosmetic unlocks

Launch Solo first. Add Duos and experimental playlists after matchmaking
and population are stable.

## 3. Rank ladder

  Rank               ELO range Identity
  ------------- -------------- ----------------------------
  Scrapper              0--799 Prove you belong.
  Contender           800--999 Learning to survive.
  Blooded         1,000--1,199 Survived the first trials.
  Hunter          1,200--1,399 Track and eliminate.
  Executioner     1,400--1,599 A dangerous opponent.
  Reaper          1,600--1,799 Few escape you.
  Warlord         1,800--1,999 Control the arena.
  Apex            2,000--2,199 Among the strongest.
  Legend                2,200+ The elite survivors.

These thresholds are starting values and should be tuned using real
match data.

## 4. Placement matches

-   New players complete five placement matches.
-   Start provisional players around 1,000 rating.
-   Use placement results to determine initial rating.
-   Provisional players gain and lose rating faster.
-   Matchmaking uses hidden MMR as well as visible ELO.

Suggested K-factor: 48 for provisional players and 32 for established
players.

## 5. ELO calculation

For a 16-player free-for-all, compare the player's finishing position
against each opponent:

-   Finish above an opponent: 1 point.
-   Tie: 0.5 points.
-   Finish below an opponent: 0 points.

Expected score:

`E = 1 / (1 + 10 ^ ((OpponentRating - PlayerRating) / 400))`

Rating change:

`RatingChange = K * (ActualScore - ExpectedScore)`

Aggregate results across all opponents into one match rating change.

### Rating principles

-   Finishing above highly rated opponents should be more valuable.
-   Losing to much lower-rated opponents should cost more.
-   Placement is the primary ELO factor.
-   Track kills, damage, crafting, and survival time as statistics.
-   Do not directly reward raw kills with ELO; this can encourage kill
    farming.
-   Simulate rating behavior and playtest before release.

## 6. Match rules

  Feature         Proposed rule
  --------------- ----------------------------------------------
  Match size      Up to 16 survivors
  Queue           Solo initially
  Win condition   Last survivor standing
  Matchmaking     Hidden MMR plus visible ELO
  Disconnect      Loss after a reconnect grace period
  Leaving         Escalating queue penalties
  Party queue     Disabled in initial Solo playlist
  Cheating        Investigation and suspension
  Rank decay      Consider only for top tiers after inactivity

Keep gameplay advantages accessible to everyone. Do not sell ranked
power. Protect new players from consistently facing top-tier opponents.

## 7. Future playlists

  Playlist          Format                   Status
  ----------------- ------------------------ ---------------
  Ranked Solo       16-player free-for-all   Launch target
  Ranked Duos       8 teams                  Future
  Ranked Survival   Experimental rules       Future

## 8. Seasons and rewards

Each season can include a leaderboard snapshot, global and regional
rankings, peak-rank tracking, match history, and exclusive cosmetics.

  Achievement   Reward idea
  ------------- -----------------------------------
  Contender     Unique calling card
  Hunter        Weapon skin
  Executioner   Animated calling card
  Reaper        Exclusive axe skin
  Warlord       Animated weapon camo
  Apex          Character outfit
  Legend        Legendary title and emblem
  Top 250       Numbered leaderboard calling card

Rewards should remain permanently unlocked once earned. Clearly
distinguish current rank from season peak rank.

## 9. Additional ranked features

### Hall of Survivors

Show top-ranked players in the main menu.

### Rival system

Track opponents who frequently defeat the player. Do not grant rating
bonuses for repeatedly fighting the same person.

### Rank history

Display previous seasons, peak rank, final rank, and rewards.

### Match statistics

Track wins, placement, eliminations, assists, damage, survival time,
crafting, and rating changes.

### Death recap

Show the eliminator, weapon, damage breakdown, and relevant combat
events when reliable data is available.

### Competitive challenges

Offer optional challenges for profile XP or cosmetics, never direct ELO.

## 10. Rank emblem art direction

Create original emblems later, with a consistent silhouette and readable
shapes at small UI sizes.

  Rank          Visual direction
  ------------- ----------------------------
  Scrapper      Worn, scratched iron
  Contender     Blue steel
  Blooded       Weathered bronze and red
  Hunter        Cold blue steel
  Executioner   Dark steel and blades
  Reaper        Red metal and skull motifs
  Warlord       Black iron and crimson
  Apex          Gold and black
  Legend        Platinum or pale gold

Artwork requirements: - Original designs inspired by The Culling's
survival-arena identity. - Transparent-background exports for UI. -
Editable source files and layers. - Clear visual progression between
tiers. - Do not use copyrighted game rank emblems as final artwork.

## 11. UI requirements

Display: - Current rank emblem and name. - Current ELO and progress to
next tier. - Placement-match status. - Recent rating changes. - Season
name and remaining duration. - Peak rank and ranked match history. -
Rewards and unlock status. - Leaderboard position, when available.

## 12. Technical implementation roadmap

### Phase 1 --- Design and data

-   [ ] Approve rules, rank names, thresholds, and season behavior.
-   [ ] Define rating and placement logic.
-   [ ] Define ranked profile data structure.
-   [ ] Decide whether rating is server-side, local, or both.
-   [ ] Define authoritative match-result data.

### Phase 2 --- Rating engine

-   [ ] Record ratings before each match.
-   [ ] Collect final placements and participants.
-   [ ] Calculate rating changes deterministically.
-   [ ] Store rating history and results.
-   [ ] Handle ties, disconnects, incomplete matches, and server
    failures.
-   [ ] Add automated rating tests.

### Phase 3 --- Matchmaking

-   [ ] Implement hidden MMR.
-   [ ] Set and gradually expand matchmaking rating ranges.
-   [ ] Avoid repeatedly matching the same players where possible.
-   [ ] Add reconnect and abandonment handling.
-   [ ] Record queue time and match-quality metrics.

### Phase 4 --- Progression and UI

-   [ ] Implement rank thresholds and promotion/demotion.
-   [ ] Display rank, ELO, and progress.
-   [ ] Add placement status and match-end rating breakdown.
-   [ ] Add rank history and leaderboard screens.

### Phase 5 --- Seasons and rewards

-   [ ] Implement season identifiers and dates.
-   [ ] Snapshot final ranks.
-   [ ] Grant rewards exactly once.
-   [ ] Persist unlocks.
-   [ ] Test season rollover and interrupted reward delivery.

### Phase 6 --- Testing and balancing

-   [ ] Simulate rating changes across skill levels.
-   [ ] Test new-player placement and smurfing.
-   [ ] Test disconnects, ties, and incomplete matches.
-   [ ] Test rating manipulation and repeated-party abuse.
-   [ ] Evaluate queue times and match quality.
-   [ ] Tune thresholds and K-factors from real data.

## 13. Data integrity and anti-abuse

-   Rating changes must use authoritative match results.
-   Give every match a unique ID to prevent duplicate processing.
-   Reward grants must be idempotent.
-   Validate player identity and match participation.
-   Keep an audit record of rating changes.
-   Do not trust client-submitted placement or kill totals.
-   Protect profile writes from partial saves and corruption.
-   Define how server restarts and incomplete matches are resolved.
-   If the project is local-only, label ranked as local/test mode until
    online results can be validated authoritatively.

## 14. Regression test checklist

-   [ ] New player completes five placements.
-   [ ] Initial tier is correct.
-   [ ] Better-than-expected placement increases ELO.
-   [ ] Worse-than-expected placement decreases ELO.
-   [ ] Ties are handled consistently.
-   [ ] A match result cannot be processed twice.
-   [ ] Disconnect and reconnect behavior is correct.
-   [ ] Abandonment penalties work.
-   [ ] Promotion and demotion thresholds work.
-   [ ] Seasonal rewards are granted once.
-   [ ] Earned cosmetics persist after restart.
-   [ ] Leaderboard sorting and ties work.
-   [ ] Invalid match data is rejected safely.
-   [ ] Rating history matches displayed rating.

## 15. Decisions requiring approval

1.  Original survival rules or a separate competitive ruleset?
2.  Add friend parties in a future Duos playlist?
3.  Soft reset, placement matches, or no rating reset each season?
4.  Legend as a fixed 2,200+ tier or limited to top players?
5.  Should exclusive rewards ever return?
6.  Global leaderboard, regional leaderboard, or both?

## 16. Completion criteria

Ranked is not complete until: - Rating calculations have automated tests
and simulated match data. - Results are authoritative and cannot be
processed twice. - Players can complete placements and progress through
ranks. - Disconnect, tie, and incomplete-match behavior is tested. -
Profile and reward persistence works across restarts. - Matchmaking
quality is measured. - Seasonal results and rewards are tested. - UI and
documentation match the implementation.

Do not describe the mode as online competitive matchmaking if the server
architecture cannot authoritatively validate matches and ratings.

------------------------------------------------------------------------

## Initial recommended configuration

-   Playlist: Ranked Solo
-   Players: 16
-   Win condition: Last survivor standing
-   Placement matches: 5
-   Starting rating: 1,000
-   Provisional K-factor: 48
-   Established K-factor: 32
-   Rank tiers: 9
-   Primary rating factor: Placement
-   Leaderboards: Global and regional
-   Rewards: Permanent unlocks
-   Future playlists: Duos and experimental Survival
