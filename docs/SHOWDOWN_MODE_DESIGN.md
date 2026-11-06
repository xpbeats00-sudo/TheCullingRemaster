# Showdown and playlist definitions

Code:

- `server/playlists.js`: every playlist, and the party-size checks.
- `server/showdown.js`: the series and its economy.
- `server/server.js`: `startLocalMatch` and `/api/matchresult`.
- `patch/make_showdown.py` and `patch/showdown_rounds.c`: the game side.

Tests: `server/test/playlists.test.js`, `server/test/party.test.js`, `server/test/showdown.test.js`.

## What Showdown is today

- **The match.** You fight one AI rival in the Jungle centre arena, in a single local match on your own PC.
- **Rounds.** A round ends when one fighter dies. The screen fades, both fighters reset with a new kit (the same kit for both sides), and the next round starts in the same match. The first to 4 round wins takes the series, so it is at most 7 rounds. `patch/showdown_rounds.c` runs the rounds inside the match. The HUD reports each round to `/api/showdown/round`.
- **Payout.** The match result that ends the series pays for it once (`seriesPayout`): XP and credits grow with rounds won. A series left unfinished is a forfeit.
- **Players.** There is no second human in a match. The game has no netplay, so Showdown is **1v1 against AI**, or
  **team Showdown** (2v2, 3v3, 4v4): you and AI teammates against AI rivals, the same series, the team's rounds
  (docs/TEAM_SIZES_TRIOS_QUADS.md, "Team Showdown"). A party of up to the team size shares one lobby and match record;
  each member plays their own local match.

## Playlists

| Playlist | id | Team size | Max party | Ranked | Enabled | If disabled: reason, and why |
|---|---|---|---|---|---|---|
| Solo | `ffa` | 1 | 4 | no | **yes** | |
| Lightning | `lightning` | 1 | 4 | no | **yes** | |
| Duos | `coop2` | 2 | 2 | no | **yes** | |
| Trios | `coop3` | 3 | 3 | no | no | `mode-not-supported`: the game only runs teams of two. Team sizes 3 and 4 are being worked on separately. |
| Quads | `coop4` | 4 | 4 | no | no | `mode-not-supported`: same as Trios |
| Ranked Solo | `ranked_ffa` | 1 | 4 | yes | **yes** | |
| Ranked Duos / Trios / Quads | `ranked_coop2/3/4` | 2/3/4 | 2/3/4 | yes | no | `queue-unavailable`: Ranked is played Solo |
| Showdown Solo | `showdown` | 1 (1v1) | **1** | no | **yes** | |
| Showdown Duos | `showdown_duo` | 2 (2v2) | 2 | no | **yes** | |
| Showdown Trios | `showdown_trio` | 3 (3v3) | 3 | no | **yes** | |
| Showdown Quads | `showdown_quad` | 4 (4v4) | 4 | no | **yes** | |
| Ranked Showdown | `ranked_showdown` | 1 (1v1) | 1 | yes | no | `mode-not-supported`: Showdown series aren't rated. There is no rating model for a 1v1 series against AI. |

- **Team size** is the size the game mode is built for. **Max party** is how many friends may queue it together.
  - Max party is never more than the team size, so a party is never split across teams.
  - Solo, Lightning and Ranked Solo take a party of up to 4: everyone shares one lobby and match record, but each plays their own local match.
- **Queue names** resolve as follows (`playlists.resolve`):
  - `showdown*` → Showdown. A `_duo`/`2v2`, `_trio`/`3v3` or `_quad`/`4v4` suffix picks the team size, and a `ranked_` prefix makes it Ranked Showdown.
  - `ranked*` → Ranked. `coop2/3/4` sets the team size.
  - `lightning*` → Lightning.
  - `*coop2` or `duo` → Duos, `*coop3` or `trio` → Trios, `*coop4` or `quad` → Quads.
  - Anything else → Solo. An unknown name never gets a lobby of its own.
- **Maps:** `jungle` or `prison` in the name is the player's first map vote.
- `GET /api/playlists` lists the table for menus.

## Queue rules (all playlists)

The checks run in this order. A refused queue sends `join-mm-fail` with a `reason` and a `message` the menu shows, and nobody moves.

1. **A disabled playlist** is refused with its reason (the table above). This applies to solo players too.
2. **In a party, only the leader queues.** A member is refused with `party-leader-queues`. If their party is already queued, they stay in its lobby.
3. **Party size above max party** is refused with `party-too-large`. For Showdown Solo the message is "Showdown Solo is played alone: leave your party to play it."
4. **Every member must be in the menu** (online, not in a match), or the queue is refused with `party-not-ready`.
5. **Showdown Solo** has no lobby. It starts the series and sends `match-ready` (`showdown:1v1`) with a fresh `matchId`. The other playlists go through a lobby, and the whole party gets one `matchId`. Team Showdown's lobby is one team (at most N players, no map vote); at its launch every member's own series starts and `match-ready` says `showdown:<N>`.

## Results and anti-abuse

A result is only accepted against a **ticket the server issued** when it sent `match-ready`. A ticket is claimed once.

- **Showdown results** are bound to the series:
  - Rounds count in order, once each, by round number.
  - A victory needs at least `CULLING_SHOWDOWN_MIN_SECONDS` (15 s).
  - The payout is the series' own economy, paid once, with kills of at most one per round won (team Showdown: N per round won) and damage of at most 200 per round. XP and credits are the same for every team size.
  - Records: 1v1 series under `profile.showdown`, team series per playlist under `profile.showdownTeams`.
- **Ranked results** score only the ranked match the ticket names. A client's `matchId` is ignored.
  - A missing, `0`, negative or malformed placement is last place, and a placement past the field is clamped to last.
  - 1st place requires a victory on a match of at least `MIN_MATCH_SECONDS` (120 s). Without one, the best a report can claim is 2nd. A shorter match counts as last place.
  - Kills fit within the field, and `timeAlive` can't exceed the real match length.
  - A Solo, Duos or Showdown result never finishes a pending ranked match.
  - Ranked Showdown is disabled, so no Showdown result is ever rated.
- `playlists.test.js` covers all of this, and `showdown.test.js` and `season.test.js` cover the Showdown and too-short rules.

## What enabling the blocked playlists needs

- **Trios and Quads:** game support for team sizes 3 and 4, being worked on separately. Then set `enabled: true` in `playlists.js`. `maxParty` already equals the team size.
- **Showdown Duos, Trios and Quads:** enabled (branch `team-showdown`; docs/TEAM_SIZES_TRIOS_QUADS.md). Teammates are AI
  until real netplay exists; two humans in one party each play their own local match.
- **Ranked Showdown:** a rating model for series and a ranked ticket per series. Rated results must come only from server tickets, as Ranked Solo's do.
