# Ranked Duos, Trios and Quads

Branch `ranked-teams`. Ranked used to be Solo only: the team playlists were
listed but refused (`queue-unavailable`). They are now played and rated.

Matches are still local: each player's match runs on their own PC with AI
contestants. There is no netplay ([MULTIPLAYER_NETPLAY_FEASIBILITY.md](MULTIPLAYER_NETPLAY_FEASIBILITY.md)).
A ranked team match is the casual Duo, Trio or Quad match (you and AI
teammates against AI teams, [TEAM_SIZES_TRIOS_QUADS.md](TEAM_SIZES_TRIOS_QUADS.md)),
rated on how your team placed.

## Ratings

- **One rating per mode:** Solo, Duo, Trio and Quads. They share the tiers,
  seasons, K factors, 5 placement matches, hidden MMR and season caps of
  Ranked Solo (`server/ranked.js`). One mode's matches never move another
  mode's rating.
- **Storage:** Solo stays where it was, in `profile.ranked`. The team modes are
  kept in `profile.rankedTeams.duo`, `.trio` and `.quad`, each with the same
  shape as Solo's record.
- **Migration:** nothing has to run. A profile without `rankedTeams` gets it the
  first time a team mode is played, and only with that mode. Reading the
  Ranked screen or `/api/ranked` writes nothing for a mode never played. A
  malformed team record (hand-edited or imported) is repaired when it is
  read. Solo's record is never touched by a team mode.
  `/admin/import-profile` carries `rankedTeams` over like `ranked`, with any
  pending match dropped.
- **Seasons:** each mode's record rolls over to the new season on its own,
  when it is next read. Last season is kept in `past`, and MMR keeps half its
  distance from 1000, as in Solo.
- **Rewards:** the tier rewards are the same items. Reaching a tier in any
  mode grants that tier's reward once, and an item already owned is never
  granted twice.

## Placement

- **Field = number of teams:** the map's contestants divided by the team
  size. Jungle and Prison place 16 contestants (one per pod; 1.3.11 put 24
  in Jungle's 16 pods), so a match has 8 duos, 5 trios or 4 quads. The field is fixed
  when the match starts (`launchMatch`), and a result can't change it.
- **The team's win is 1st, for every member.** The HUD's team result (hud.js,
  Duo's rule extended to N in Trios/Quads) holds your death's result while a
  teammate lives. If your team then wins, the HUD posts a victory, so a member
  who fell early still gets 1st.
- **A loss** is posted with the position the game reported for you (`Rank`).
  The server turns it into a team place by taking the team-sized slice it
  falls in: `ceil(position / team size)`. In Duo on Jungle, positions 1-2 are
  team place 1, 3-4 are 2, and 23-24 are 12. The result is clamped to between
  2nd (1st needs the win) and the last team.
- **Malformed, missing or too short:** a missing, `0`, negative or malformed
  position is last place. So is a match shorter than `MIN_MATCH_SECONDS`.
- **`teamOutcome`:** the HUD's body now says how it settled the result:
  `won`, `out` (the whole team was down), `waited` (posted after the 20-minute
  wait) or `left` (you left the match first). The server logs it and keeps it
  on the history entry. It is never scored.
- **Known limit:** after a loss where a teammate outlived you, the HUD posts
  your own death's position. The game sends no team placement and no live
  count of the teams still alive, so this is the closest the HUD can report.
  Your team place is then counted from your own death, which is conservative:
  your team placed at least that well. A team win is always exact.
  `Rank`'s in-game meaning in team modes is still to be confirmed (see the
  in-game checks).

## Tickets and anti-abuse

Ranked team results follow the same rules as Ranked Solo.

- **The ticket names the match.** `launchMatch` starts a ranked match for the
  playlist's mode (`ranked.modeForPlaylist`). The ticket carries
  `ranked: <match id>` and `rankedMode: solo|duo|trio|quad`.
- **Only that mode's pending match is scored.** The result must match the
  pending match of the ticket's mode, by id.
  - A Solo ticket can't finish a Duos match, and a Duos ticket can't finish a
    Solo one.
  - A casual Duo result scores nothing.
  - A client-sent `matchId` is ignored.
  - A ticket is spent once.
  - Another player's token has no ticket.
- **A match left unfinished** counts as last place of its own mode, when the
  next match of that mode starts. Another mode's pending match is left alone.
- **Kills** are bounded to every contestant except your own team
  (24 - team size on Jungle).
- **Tickets from before this change** have no `rankedMode`, and count as Solo.

## Queue and party

- **Queues:** `ranked_coop2`, `ranked_coop3` and `ranked_coop4` (with an
  optional map, e.g. `ranked_ffa_jungle_coop2`). They are enabled in
  `server/playlists.js`, and each takes a party of up to its team size.
- **Alone:** you get AI teammates, exactly like casual.
- **A party queues as one**, under the rules on this branch: only the leader
  queues, every member must be in the menu, and a party larger than the team
  is refused (`party-too-large`, "takes parties of up to N"). The whole party
  is in one lobby and gets the same match id, lobby id and party id on every
  member's `match-ready` and ticket.
- **Each member is rated in their own match:** each member gets their own
  ranked match and ticket, and plays their own local match with AI teammates.
- **Match URL:** the casual team URL (`duo:<map>`, `trio:<map>`,
  `quad:<map>`, or `map:duo:<n>?TeamSize=N` with weather). It is opened by
  ClientWeb.js's existing team path. This is how Ranked Solo launches too: it
  is Solo's `offline:<map>`, made ranked only by its ticket. `match-ready`
  also says `ranked: "duo"` (null when not ranked). No ClientWeb.js change was
  needed.

### MMR in a party: not averaged

**Decision:** a party member's MMR is not averaged with the party's.

Each member plays their own local match. Their bot teams are rated around
their own MMR for that mode (`opponentsFor`), and their result is theirs
alone. Averaging would only make a strong player's match easier and a weak
player's harder, with no shared outcome to justify it.

Display stays honest too. The lobby shows each player's own tier in the
lobby's mode, or none before their first match in it. Ranked Solo and every
other lobby keep showing the Solo tier.

## Server API

- **`GET /api/ranked`** (token): returns the Solo summary at the top level, as
  before, so older menus and HUDs still work. Every mode's summary is under
  `modes: {solo, duo, trio, quad}`. `?mode=duo` puts that mode at the top
  level instead. Each summary also has `mode`, `name`, `playlist` and
  `teamSize`. History entries have `mode` and `teamSize`.
- **Match result** reply: `ranked: {entry, summary}` for the ticket's mode.
- **Player card:** adds `rankedTeams: {duo, trio, quad}`, each this season's
  `{tier, rating, matches, wins}` or null.
- **Leaderboard:** adds the boards `ranked_duo`, `ranked_trio` and
  `ranked_quad`, after the existing six, so their order is unchanged. Each is
  the rating in that mode this season, with that mode's tier as the emblem.
  Every board now carries `mode`: `solo` for `ranked`, `duo`/`trio`/`quad` for
  the team boards, and null for the others.
- **Presence:** shows "Ranked Duos", "Ranked Trios" or "Ranked Quads".

## Menus (ES5)

- **`RankedUI.js`, the tabs:** Solo, Duo, Trio and Quads are all active. A
  click selects one, and the choice is remembered in localStorage when the
  page can store it. Each tab shows that mode's tier, ELO, placements,
  peak/matches/wins, recent matches ("#3 of 12", team place for the team
  modes) and the rank ladder.
- **`RankedUI.js`, the Play tile:** the Ranked screen's tile (the stock
  free-for-all tile) is retitled RANKED SOLO, DUO, TRIO or QUADS, and its text
  says how teams are made.
  - With Solo selected, it goes through the stock Ranked.js path
    (`ranked_ffa`).
  - With a team mode selected, it queues `ranked_coop2`, `ranked_coop3` or
    `ranked_coop4` and returns to the main menu, as Ranked Solo does.
  - If the server is older than the team modes, they show as Soon.
- **`MatchLobby.js`:** names the ranked team modes and lays out the pregame
  roster by team, as casual Duo, Trio and Quad do.
- **`Leaderboard.js`:** tabs Ranked Solo, Ranked Duo, Ranked Trio and Ranked
  Quads.
- **`hud.js`:** sends `teamOutcome`. The ranked banner reads "RANKED DUOS •
  TEAM PLACE 1 OF 12" (Solo: "RANKED SOLO • PLACE 3 OF 16").

## Tests

- `server/test/ranked_teams.test.js`:
  - Rules (unit): modes, team fields, separate ratings, the team placement
    table, the clamp to the field, cross-mode refusal and abandonment,
    placements and rewards, simulation, per-mode season rollover, migration
    and repair.
  - Server (spawned, sockets):
    - each mode alone: URL, ticket and a team win at 1st;
    - the clamp table, kills bound and Prison's fields;
    - ticket rules (no ticket, spent ticket, forged id);
    - mismatched results: another player, Solo, casual Duos and abandonment;
    - `/api/ranked` modes;
    - a Solo-only profile migrating and the per-mode lobby rank;
    - a past-season team record;
    - a party of two queuing as one, leader-only queueing, party size versus
      team size, a party of three in Trios;
    - per-mode leaderboards.
- `patch/test_ranked_hud.js`: hud.js's team result. A member dead early then
  the team's win (victory, 1st, their own stats, `won`); team out; leaving;
  the wait; Solo; the banner text.
- `patch/test_ranked_menu.js`: RankedUI.js against stand-ins, with
  `server/ranked.js` summaries. Covers the tabs, each mode's panel, the tile
  and its queue, a failed queue, the remembered tab, and an older server.
- Updated:
  - `playlists.test.js`, `party.test.js` and `audit.test.js`: ranked teams are
    no longer refused.
  - `leaderboard.test.js` passes unchanged.

## In-game checks (not yet done)

These need a client build with this branch's `RankedUI.js`, `MatchLobby.js`,
`Leaderboard.js` and `hud.js`, and the server deployed. Test through the
launcher against the VPS.

1. **Ranked screen:** Play > RANKED.
   - The tabs Solo, Duo, Trio and Quads are all clickable, with no "Soon".
   - Each tab changes the panel (Duo starts at 1000 ELO, Placements 0/5) and
     the tile's title (RANKED DUO and so on).
   - Solo still shows your Solo rating.
2. **Ranked Duo alone:** pick Duo, press the tile.
   - The lobby pill reads "Ranked Duo", and the pregame roster shows YOUR
     TEAM with one TEAMMATE.
   - The match is the Duo match on the voted map, with an AI teammate.
3. **Die early, the AI teammate wins:** "Your result is saved when your
   team's match ends", then at the win the banner "RANKED DUOS • TEAM PLACE 1
   OF 12" with a rating gain. The Ranked screen's Duo tab then shows the match
   at "#1 of 12".
4. **Die and your teammate dies:** the banner shows a team place between 2
   and 12. Write down the death screen's placement and the banner's team
   place. The game log line `ReportLocalMatchResult: {... "placement": N,
   "teamOutcome": "out"}` tells whether the game's `Rank` in team modes is
   your contestant position (1-24) or already a team place (1-12). If it is a
   team place, `ranked.teamPlacement` must not divide it: report it.
5. **Trio and Quads alone:** the same with 2 or 3 AI teammates, team place
   out of 8 or 6.
6. **A party of two in Ranked Duo:** only the leader can press the tile (the
   member gets "... leads your party").
   - Both menus go to the same lobby and both games start the Duo match.
   - Each player's Duo rating moves by their own match.
   - In Ranked Trio, a party of three is accepted.
   - In Ranked Duo, a party of three is refused: "Ranked Duos takes parties
     of up to 2".
7. **Leaderboard:** the tabs Ranked Duo, Ranked Trio and Ranked Quads list
   you with your rating and tier in each mode. Ranked Solo is unchanged.
8. **Quitting a ranked team match:** use Quit from the pause menu mid-match.
   That match counts as last place of that mode at your next match of that
   mode (Ranked Solo unaffected).
