# Audit 02: Party → queue → lobby → match

Branch `party-matchmaking`, from `origin/main` at `c0799be`. Scope: the server (`server/`) and the menu handlers that show its answers (`ClientWeb.js`, `Friends.js`).

Status words: **PASS** means a test ran and passed (output below). **FAIL**, **BLOCKED**, **NOT TESTED** and **PARTIAL** mean what they say.

## What is true about matches (read first)

Matches run **locally on each player's PC** with AI contestants. There is no dedicated game server and no netplay.

So the server cannot put two humans in the same in-game match or on the same in-game team, and nothing here claims it does. In Duos, each player gets the game's pairs mode with an **AI teammate**. The server's job is:

- one shared lobby and match record for the party;
- the same party for every member;
- the right playlist and ticket for each member;
- correct, ticket-bound results.

`match-ready` now carries `netplay: false` to state this.

## The reported bug

> Leader invites a friend, the friend joins, both queue for Duos: they end up in **separate lobbies** (and not on the same team).

- **Not on the same team** comes from the architecture above. Each player's Duo match is their own, so the server can't change this. It stays **BLOCKED** until real netplay exists (another agent is researching that).
- **Separate lobbies** was a server bug. It is fixed and tested (see below).

## Trace (before the fix, `origin/main`)

1. **Leader presses Duos.** `ClientWeb.js:2416 QueueMatchmaking` → engine `MatchQueueWithTicket` → `POST /api/matchqueue` (`server.js:474`) → `startLocalMatch(socket, queue)` (`server.js:1165`).
2. **Party branch.** This branch only ran for the leader (`server.js:1188`). It pulled in members who were online and not `match` (`server.js:1192`). For Duos it took the leader and **one** member (`server.js:1194`). Each pulled member got `join-mm-group`. Then `lobbies.joinGroup` ran (`matchlobby.js:67`), which joined members one at a time (`matchlobby.js:72`).
3. **A member presses Duos.** This happens before the leader, after the leader, or again during the pregame countdown. The stock `QueueMatchmaking` only guards `IsStartingMatchmaking` (`ClientWeb.js:2418`), so a menu that is already searching can queue again. The request takes the same `startLocalMatch` path, which has **no party check for a non-leader**. It reached `lobbies.join(mode, member)` (`server.js:1202`), and `join` first *leaves* the member's current lobby.
   - If the party's lobby was still gathering, the member was put back in it.
   - If the lobby had started its countdown (closed to new players), the member got **a new lobby of their own** and later a second, separate match.
4. **Countdown ends.** `start(lobby)` (`server.js:1136`) called `launchMatch` for each member. `launchMatch` (`server.js:1207`) issued an unrelated ticket (`server.js:1224`) and a `match-ready` with random nonces only (`server.js:1234`). Nothing tied a party's matches together.
5. **Cancel.**
   - The leader cancelling pulled the members out (`server.js:1499`).
   - A **member** cancelling only removed themselves (`server.js:1494`). The leader then went on alone.
6. **Disconnect.** Only the player who disconnected was removed from the lobby (`server.js:1724`). Nobody else was told, so the rest of the party played on without them.

## Root causes

| # | Root cause | Where (origin/main) |
|---|---|---|
| RC1 | A party member's own queue request was treated as a solo queue. It moved them out of the party's lobby. During the countdown it moved them into a lobby of their own, which is the reported split. | `server/server.js:1188` (party branch only for the leader), `:1202` (`lobbies.join`); `matchlobby.js` `join` leaves the current lobby first |
| RC2 | The leader's queue silently dropped members: anyone offline, anyone shown "in match", and in Duos everyone after the first. The dropped members then queued alone. | `server/server.js:1192`, `:1194` |
| RC3 | There was no shared match record. Every member got an independent ticket and a `match-ready` with only random nonces: no lobby id, match id or party id. | `server/server.js:1207-1236` |
| RC4 | A duplicate queue request wasn't idempotent. Every repeat re-ran `joinGroup` (leave and rejoin), which reset votes and could open a new lobby. A pre-fix test run saw 3 lobby ids for one party. | `server/server.js:1188-1199`, `matchlobby.js:67-74` |
| RC5 | A member cancelling, disconnecting or leaving the party split the party. The leader's search went on. Only the leader's cancel was party-wide. | `server/server.js:1493-1506`, `:1724`, `:1674` |
| RC6 | Lobby members held the socket they queued from. After a reconnect, lobby updates and `match-ready` could go to the dead socket. | `server/server.js:1130`, `:1136` |
| RC7 | Any member could invite, so there was no single leader for invites. Accepting into a party that was already searching left the newcomer outside its lobby. | `server/friends.js:142`; `server.js:1659` |
| RC8 | Unknown queue names became lobbies, ticket modes and `profile.modes` keys of their own. Trios, Quads and team Showdown had no definition and no refusal. | `server/server.js:1161` |
| RC9 | Ranked bounds: a reported `placement` of `0` or below clamped to **1st**. A client-sent `matchId` was passed to `ranked.finishMatch`. | `server/server.js:551`, `:553` |

## Fixes

- **Playlists** (`server/playlists.js`, new): each playlist has a team size, a party limit (`maxParty`), a ranked flag and an enabled flag. A disabled playlist carries a `reason` and a `message`. Queue names resolve to a playlist, and an unknown name plays Solo. `GET /api/playlists` lists them. Full table: [SHOWDOWN_MODE_DESIGN.md](SHOWDOWN_MODE_DESIGN.md).
- **One queue entry point** (`startLocalMatch`, server.js) validates the whole request before anyone moves. Nothing is half done. The checks, in order:
  1. A **party member's own request** is refused with `party-leader-queues`, and the message names the leader. If their party is already queued, they stay in its lobby: the server re-sends `join-mm-group` and the lobby (fixes RC1).
  2. **Playlist and party size** (`checkParty`). A disabled playlist is refused with its reason. A party too big for it is refused with `party-too-large`. Nobody is dropped (fixes RC2).
  3. A **duplicate** request for the playlist already queued changes nothing. A different playlist while the lobby is still gathering moves the whole party. After the countdown starts, it is refused with `match-starting` (fixes RC4).
  4. **Every member must be ready.** Anyone offline or in a match refuses the queue with `party-not-ready`, and the reply names them (fixes RC2).
  5. Members get `join-mm-group` with the leader's queue name, so their menu shows the right mode. The party then joins **one lobby in one step** (`joinGroup`, now atomic). Each member is marked with the party id, and the lobby view numbers parties without sending any ids.
- **Shared match record** (`allocateMatch`, server.js; fixes RC3): when a lobby's countdown ends, it gets one `matchId`. Every member's `match-ready` and ticket carry `matchId`, `lobbyId`, `partyId`, `playlist` and `netplay: false`.
  - Allocation is all-or-nothing per party. If a member is gone, the whole party gets `join-mm-fail` with `allocation-failed`, and no ticket or ranked match is started.
  - `CULLING_FAULT_ALLOCATION=1` makes allocation fail. It is a test hook only, used by `party.test.js`.
- **The party leaves together** (`cancelPartyQueue`; fixes RC5): cancelling, disconnecting, leaving the party or joining another party during the search stops it for everyone. Each menu gets `leave-mm-group` with a reason and a message. The reasons are:
  - `party-leader-cancelled`, `party-member-cancelled`;
  - `party-leader-disconnected`, `party-member-disconnected`;
  - `party-changed`.
- **Reconnect and offline members:**
  - A member who disconnects keeps their place, and the party keeps its id.
  - If they stay offline for `CULLING_PARTY_OFFLINE_MS` (default 2 minutes) and aren't in a match, they leave the party. The others get `remaster-party-notice` (`member-offline`), and the next member leads if needed. No member is removed silently.
  - A match keeps them: the menu socket drops during every match, and the timer re-arms while they are in a match.
- **The right socket** (`memberSocket`; fixes RC6): lobby updates and `match-ready` go to the socket the player queued from while it is connected. After a reconnect, they go to the socket the player is logged in on now.
  - A first version always used the current login's socket. That broke `showdown.test.js` (a menu still connected on an older login stopped getting its lobby), and it was corrected before commit.
- **Invites** (`friends.js`; fixes RC7): only the leader invites (`not-party-leader`). Accepting a party you are already in is `already-in-party`. You can't join a party while any of its members is searching (`party-in-queue`), including a leader still searching alone. Accepting takes you out of your own search first.
- **Ranked** (fixes RC9):
  - The result scores the ranked match named by the **server's ticket**. The client's `matchId` is ignored.
  - A missing, `0`, negative or malformed placement is last place.
  - 1st place requires a victory, and a victory requires a match long enough to be real (`MIN_MATCH_SECONDS`, existing). Without one, the best a report can claim is 2nd.
  - Existing bounds are kept: kills fit within the field, `timeAlive` can't exceed the match's real length, a ticket is claimed once, and a Solo or Showdown result never finishes a pending ranked match.
- **Menus** (ES5):
  - `join-mm-fail` shows the server's message.
  - `join-mm-group` takes the leader's queue name.
  - `leave-mm-group` and `remaster-party-notice` show their message in the lobby notice.
  - `Friends.js` gains the text for the two new error codes.
- **Behaviour change.** A party of three or four queuing Duos is now refused with `party-too-large`. It used to take the leader and one member and leave the rest behind. `audit.test.js` was updated to match.

## Tests

### New two-client socket tests: `server/test/party.test.js`

Each test uses logged-in accounts, real `socket.io-client` sockets and a spawned server, as `helpers.js` does. A second server runs with `CULLING_FAULT_ALLOCATION=1`.

**Before the fix** (new test file run against the unmodified `origin/main` server code, abridged):

```
FAIL  party queues for Duos: one lobby, one match id, the right playlist for both
      AssertionError [ERR_ASSERTION]: the same match id: undefined / undefined
FAIL  duplicate queue: the leader queueing again keeps the party in its lobby, one match each
      AssertionError [ERR_ASSERTION]: one lobby, not 2,3,4
FAIL  a member queueing on their own is refused with a reason; the party stays one unit
      Error: Member Fox: timed out waiting for join-mm-fail
FAIL  a member pressing Duo again while the party's lobby counts down stays in it (the split bug)
      AssertionError [ERR_ASSERTION]: the member never saw another lobby: 6,7
FAIL  cancel: the leader cancelling takes the party out; a member cancelling does too
      Error: Lead Wolf: timed out waiting for leave-mm-group
ok    repeated queue attempts: queue, cancel, queue... the last one is the party's only match
FAIL  member disconnect: the party's search stops with a reason; reconnecting keeps the party
      Error: Lead Wolf: timed out waiting for leave-mm-group
FAIL  leader disconnect: the member's search stops; the leader comes back still leading
FAIL  a leader offline past the grace period leaves the party, with notice; the next member leads
... (the rest failed on missing refusals / setup that depended on them)
```

`the member never saw another lobby: 6,7` reproduces the reported split. The member's second Duo press during the countdown put them in lobby 7 while their leader was in lobby 6.

**After the fix:**

```
ok    party queues for Duos: one lobby, one match id, the right playlist for both
ok    duplicate queue: the leader queueing again keeps the party in its lobby, one match each
ok    a member queueing on their own is refused with a reason; the party stays one unit
ok    a member pressing Duo again while the party's lobby counts down stays in it (the split bug)
ok    cancel: the leader cancelling takes the party out; a member cancelling does too
ok    repeated queue attempts: queue, cancel, queue... the last one is the party's only match
ok    member disconnect: the party's search stops with a reason; reconnecting keeps the party
ok    leader disconnect: the member's search stops; the leader comes back still leading
ok    a leader offline past the grace period leaves the party, with notice; the next member leads
ok    Duos refuses a party of three instead of leaving one behind
ok    Solo with a party of three: all three in one lobby and one match
ok    Trio, Quad and team Showdown playlists are refused with a reason; Showdown Solo refuses a party
ok    only the leader invites; nobody joins or leaves a queued party without the queue stopping
ok    a leader searching alone (invite still open) can't be joined mid-search; after it, the two queue as one
ok    allocation failure: every member is told, nobody gets a match, ticket or ranked match
party tests: 15 passed, 0 failed
```

| Scenario asked for | Test | Status |
|---|---|---|
| Party queues for Duos → same lobby and match id | 1 (also checks both tickets in `tickets.json`: same `matchId` and `partyId`, mode `coop2`) | PASS |
| Duplicate queue | 2 | PASS |
| Member queues separately | 3, 4 | PASS |
| Cancel (leader and member) | 5 | PASS |
| Leader disconnect | 8, 9 | PASS |
| Member disconnect and reconnect | 7 | PASS |
| Repeated queue attempts | 6 | PASS |
| Allocation failure | 15 (fault-injected: the failure path really runs, the cause is simulated) | PASS |

### Playlists and Ranked anti-abuse: `server/test/playlists.test.js` (new, 12 tests)

```
ok    queue names resolve to playlists (unknown names are Solo, never a lobby of their own)
ok    only Solo, Lightning, Duos, Ranked Solo and Showdown Solo are enabled
ok    party sizes: never more than the team, Showdown Solo alone
ok    GET /api/playlists lists every playlist with what is enabled
ok    a solo player is refused disabled playlists with the reason, and gets no match
ok    an unknown queue name plays Solo
ok    ranked: a result without a server-issued ticket is refused and changes nothing
ok    ranked: scored as the ticket's match; a client-sent matchId is ignored
ok    ranked: the same result twice scores once
ok    ranked: placements are clamped (malformed is last, first needs the win, never past the field)
ok    ranked: one player's result can't score another's ranked match
ok    ranked: a Solo or Showdown match never scores a pending ranked match
all 12 playlist tests passed
```

`matchlobby.test.js` gains a unit test for the atomic, party-marked `joinGroup` (12 tests, was 11).

### Whole server suite

Every `server/test/*.test.js` was run with node, one file at a time:

| | Files | Tests (`ok` lines) | Failed |
|---|---|---|---|
| Before (origin/main) | 20 | 190 | 0 |
| After (this branch) | 22 | 218 | 0 |

The 28 new tests:

- `party.test.js`: 15
- `playlists.test.js`: 12
- `matchlobby.test.js`: 1

The final run, after the fix:

```
PASS test/accounts.test.js (14 ok)
PASS test/activity.test.js (4 ok)
PASS test/airdrops.test.js (4 ok)
PASS test/audit.test.js (16 ok)
PASS test/camopurchase.test.js (4 ok)
PASS test/deploy.test.js (2 ok)
PASS test/field.test.js (5 ok)
PASS test/friends.test.js (23 ok)
PASS test/lastbreath.test.js (11 ok)
PASS test/leaderboard.test.js (13 ok)
PASS test/matchlobby.test.js (12 ok)
PASS test/matchqueue.test.js (4 ok)
PASS test/matchresult.test.js (8 ok)
PASS test/metrics.test.js (8 ok)
PASS test/party.test.js (15 ok)
PASS test/playlists.test.js (12 ok)
PASS test/ranked.test.js (18 ok)
PASS test/season.test.js (4 ok)
PASS test/session.test.js (6 ok)
PASS test/showdown.test.js (22 ok)
PASS test/shutdown.test.js (2 ok)
PASS test/store.test.js (11 ok)
files=22 failed=0 ok-lines=218
```

**Test-run note.** One earlier full run reported `showdown.test.js` as failing: `ENOENT profiles.json`, then a hang. There were two causes:

- **Port clash.** A test server left over from a run I had stopped held port 8157, so the test talked to the wrong server. Killing the leftover cleared it.
- **A real regression of mine** (RC6, first version). Fixed with `memberSocket`, as described under Fixes.

The run above comes after both fixes.

## Not tested here: in-game checks to run

These need the real game: two PCs, or two accounts on two machines, through the launcher and the VPS. Their status is **NOT TESTED**.

1. **Party Duos.** A invites B, and B accepts. A presses Duos.
   - B's menu should follow into A's lobby, and both should see the same lobby with both names.
   - Both should load a Duo match on the voted map.
   - In the VPS log, both `match-ready ->` lines should show the same `match <id>` and `party <id>`.
2. **B presses Duos** (B is not the leader):
   - while A isn't searching: B should see "A leads your party: only the leader can queue it…";
   - while A's lobby counts down: B should stay in A's lobby, with no second match.
3. **Cancel from B** during A's search. A's search should stop, with the notice "B cancelled the search."
4. **Quit B's game** (or pull the network) during the search. A's search should stop, with a notice. If B restarts within 2 minutes, B should still be in the party.
5. **Party of three queues Duos.** The leader should see "Duos takes parties of up to 2: yours has 3.", and nobody should be pulled into a lobby.
6. **Showdown with a party.** The player should see "Showdown Solo is played alone…".
7. **After a Duo match**, both players should return to the menu still in the party, and queueing again should work. The menu socket reconnects after every match, and the 2-minute offline rule must not drop someone who is playing.

Same in-game team for two humans: **BLOCKED** until real netplay exists.
