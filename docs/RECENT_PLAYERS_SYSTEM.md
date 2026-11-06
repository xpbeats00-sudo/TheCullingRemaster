# Recent players

Players see who they recently played with, and from there add them as friends, invite them to a party, ask to join theirs, block them, report them or take them off the list.

Code:
- `server/recentplayers.js`: the rules and the saved data.
- The *recent players* section of `server/server.js`: the recording hook, the list, and the socket actions.
- `server/friends.js`: `invite(..., { anyone })`, `join`, `dropInvitesBetween` and `inviteOpen`.
- The menu: `patch/src/Victory/Content/uiresources/FrontEnd/js/Friends.js` (the RECENT tab). `ClientWeb.js` forwards its three server events.

Tests:
- `server/test/recent_players.test.js`
- `patch/test_recent_menu.js`

## What "played with" means today (read first)

Every match runs **locally on each player's own PC**, and the other contestants in it are AI. There are no shared matches yet (`docs/NETPLAY_LISTEN_SERVER.md` is the effort working on them). So the server can't know who was in anyone's match. What it can confirm is:

- **The match lobby.** `matchlobby.js` holds the players waiting for one playlist. When the countdown ends, `allocateMatch` gives everyone the lobby sends in one `matchId`.
- **The party.** Members of one party share a `partyId` on their `match-ready` and their ticket.

So a *recent player* is another **account** player that the same lobby launched into the same match id. A party teammate is marked as such. Nothing else counts:

- **Never counted:** players without an account, players banned when the match starts, a player whose match failed to start, a lobby member who left before the countdown, and above all anything a client sends. No socket event or HTTP route takes a player list. `/api/matchresult` ignores any roster in its body, and the tests check that.
- **Not recorded at all:** Showdown Solo and custom matches. Each is one player with no lobby, so there is no co-participant to record.

Player-facing text never says bots or AI. The empty list says *Players you queue into a match with show up here*.

## The recording hook

One function writes recent players, and only the server calls it:

```js
// server.js
recordPlayedTogether({ matchId, playlist, map, source, participants: [{ userID, partyId?, team? }] })
  -> recent.recordMatch(...)   // server/recentplayers.js
```

- **Called from:** `allocateMatch`, right after the launch loop. It passes the members whose `launchMatch` succeeded, with `source: 'lobby'`.
- **What it does:**
  1. Drops anyone without an active account.
  2. Takes each player's current username as their *name at the time*.
  3. Records every pair both ways.
  4. Pushes the new list to the players who have the tab open.
- **Errors** are caught by `guarded`, so recording can never stop a match from starting.

**Once shared matches exist**, the match host reports its authoritative roster through this same function. Teams are numbers, and parties come from the server's own party records:

```js
recordPlayedTogether({ matchId, playlist, map, source: 'match',
  participants: roster.map((p) => ({ userID: p.userID, partyId: p.partyId, team: p.team })) });
```

The relation is chosen in this order: the same party is `party`; the same team is `team`; the other team is `opponent`; no teams at all is `match`. The menu already has labels for all five relations. The roster has to come from the server's side of the shared match (the host's authenticated report, checked against the tickets it issued), never from a menu. Whether `lobby` entries keep being recorded for lobby members who end up in a different shared match is a choice for that work. The function doesn't need to change for it.

## Data model

Saved by userID in `recent-players.json` in the data folder, next to `friends.json`:

- **Writes** are coalesced, the file is flushed on shutdown, and it is part of the daily backup (`*.json`).
- **An unreadable file** is kept as `recent-players.json.unreadable-<time>`.

```json
{ "version": 1,
  "users": {
    "<userID>": {
      "recent": [ { "with": "<userID>", "name": "Bo", "relation": "party|lobby|team|opponent|match",
                    "playlist": "coop2", "map": "jungle", "matchId": "…", "source": "lobby|match",
                    "playedAt": 1793947000000, "lastInteraction": 1793947000000 } ],
      "blocked": ["<userID>"],
      "privacy": "everyone|recent|friends|nobody|null" } },
  "reports": [ { "id", "at", "from": {userID, username}, "about": {userID, username}, "reason", "note",
                 "context": {relation, playlist, map, matchId, playedAt}, "status": "open" } ] }
```

| Field | Meaning |
|---|---|
| `with` | the other player's userID |
| `name` | their username when the match was played (`nameThen` in the list) |
| `relation` | how you met (above) |
| `playlist`, `map` | the lobby's playlist and voted map |
| `matchId` | the shared match id (stored, never sent to a menu) |
| `playedAt` | when the match started |
| `lastInteraction` | the last time you did something with them from the list, or the match, whichever is later |

- **One entry per pair.** A newer match replaces the older entry and keeps the later `lastInteraction`. An older match that arrives late does not replace a newer one.
- **History limit.** Each player keeps their newest `CULLING_RECENT_LIMIT` entries (default 50), newest first.
- **Removing** someone takes them off your list only.
- **Deleted and banned accounts** drop out of every list, as players and as join requests, because the list is filtered on the account being *active* every time it is built:
  - **Deleted** means the account no longer exists in `accounts.json`. There is no delete-account route: an operator removing an account by hand is the only way today.
  - **Banned** means the account has `bannedAt`, set with `/admin/ban`.

  The stored entries are kept, so lifting a ban brings them back. `RecentPlayers.purge(userID)` removes a player from every list for good; nothing calls it yet.
- **Memory only:** join requests (`id`, `from`, `to`, `at`) and the per-pair cooldowns.

## The list (`remaster-recent`)

```js
{ you, players: [entry], joinRequests: [{ requestId, from: person }], blocked: [{ username }],
  settings: { join }, privacyOptions, reportReasons, limit, maxParty }
```

Each `entry` is the same public person the friends list shows, `{ username, name, level, cardID, rank, status: { state, label, lastSeen } }`, plus:

| Field | What it is |
|---|---|
| `nameThen`, `relation`, `playlist`, `mode` (a label such as *Duo*), `map`, `playedAt`, `lastInteraction` | how and when you met |
| `friend` | `friend`, `requested`, `asked-you` or `none` |
| `invite: { can, reason, sent }` | whether you may invite them now, why not, and whether your invite is open |
| `join: { can, reason, sent }` | whether you may ask to join their party now, why not, and whether your request is open |
| `party: { size, max, leads, yours }` | their party, **only when their setting lets you join it** (otherwise `null`) |

**Privacy of the payload:**
- No userIDs, emails, IP hashes, Steam IDs, match ids or party ids. The test walks every payload (list, join request, invite) for them.
- The rank is the same public tier the lobby shows.
- When someone was last online (`status.lastSeen`) is shown only if you are friends. Otherwise it is `null`.

## Privacy and safety rules

- **Who may invite you or ask to join your party** (`recent-settings {join}`):

  | Setting | Who may |
  |---|---|
  | `everyone` | anyone who can reach you |
  | `recent` (default) | your friends and the players on **your** list |
  | `friends` | your friends only |
  | `nobody` | nobody, friends included |

  - "On your list" uses the invited player's own list, so taking someone off your list also stops them inviting you under `recent`.
  - The setting applies to the existing friends `party-invite` too, so a friend can't invite someone set to `nobody`. The default keeps friends' invites working as before.
- **Recent actions act on your own list.** Inviting, asking to join, reporting or removing someone who isn't on it answers `not-recent`.
- **Blocks work both ways.**
  - Blocking takes away the friendship, friend requests either way, party invites either way and join requests.
  - If the two players share a party, the blocker leaves it, and its search stops if it was searching.
  - Afterwards neither player sees the other on Recent players. Neither can invite the other, ask to join the other, send the other a friend request, or join a party the other is in, whether by accepting an invite or by a join request.
  - The player who blocked gets `blocked` ("Unblock them first"). The blocked player gets `unavailable`, the same answer as a privacy refusal, so a block isn't announced.
  - Reporting still works after a block. Blocks don't hide lobby rows: a lobby shows who is in it.
- **Rate limits:**
  - Every action falls under the friends limit: 1 a second, bursts of 20 (`CULLING_FRIEND_ACTION_BURST`).
  - Invites, join requests and reports also fall under `CULLING_SOCIAL_RATE` / `CULLING_SOCIAL_BURST`: 1 every 5 s, bursts of 6.
  - The same invite or join request to the same player waits `CULLING_SOCIAL_PAIR_MS` (30 s) and answers `too-soon`.
  - `recent-get` is limited to 1 a second, bursts of 10 (`CULLING_RECENT_GET_BURST`).
  - Over a limit the answer is `slow-down`.
- **Expiry.** Party invites and join requests last `CULLING_INVITE_TTL_MS` (5 minutes). An expired one can't be accepted (`no-invite`, `no-request`) and no longer shows as sent.
- **Reports** need a reason: `cheating`, `abuse`, `name`, `griefing` or `other`.
  - An optional note is cut to 300 characters, with control characters removed.
  - One report per pair per day (`already-reported`).
  - The newest 5,000 are kept, with the match context from the reporter's entry.
  - Nothing happens to the reported player automatically. The operator reads them with `GET /admin/reports` (loopback only, like `/metrics`).

## Joining a party from Recent players

A join request (`recent-join-request {username}`) is refused unless every check below passes:

1. The target's setting lets you (`unavailable`).
2. They lead their party, or have none, in which case they would lead the new one (`not-party-leader`).
3. It has room, up to 4 (`party-full`).
4. Nobody in it blocked you, and you blocked nobody in it (`unavailable`).
5. They are online (`offline`).
6. Nobody in it is in a match (`in-match`).
7. Nobody in it is searching (`party-in-queue`).
8. **The mode fits.** The playlist the party (or the player) last queued must take one more: a party of 2 that last queued Duos is `mode-full`.

The leader gets `remaster-join-request` (a pop-up and the tab's *Join requests*) and answers it:

- **Accept** (`recent-join-accept {requestId}`) runs all the checks again, and also checks that the requester is still online and not in a match (`requester-offline`, `requester-busy`). Then the requester leaves any search and party they were in and joins. The requester gets `remaster-recent-result {action: 'recent-join-accepted'}`.
- **Decline** (`recent-join-decline`) is silent: the requester's *Asked* clears.

Join-in-progress, spectating and the shared-match rules are in [JOIN_FRIENDS_AND_PARTY_DESIGN.md](JOIN_FRIENDS_AND_PARTY_DESIGN.md).

## Socket events

Client to server (each answered with `remaster-recent-result {action, ok | error, username?, ...}`):

| Event | Payload | Does |
|---|---|---|
| `recent-get` | — | sends `remaster-recent`; the menu then gets pushes while signed in |
| `recent-invite` | `{username}` | party invite to a recent player (no friendship needed; their setting decides) |
| `recent-join-request` | `{username}` | asks to join their party |
| `recent-join-accept` | `{requestId}` | the leader accepts |
| `recent-join-decline` | `{requestId}` | the leader declines |
| `recent-block` | `{username}` | blocks (any account) |
| `recent-unblock` | `{username}` | unblocks |
| `recent-report` | `{username, reason, note?}` | a report for the operator |
| `recent-remove` | `{username}` | off your list |
| `recent-settings` | `{join}` | who may invite you / ask to join |

The friends events used from the tab are unchanged: `friend-request` and `friend-accept` for Add friend and Accept, and `party-accept` for an invite. They now also:

- refuse on a block (`blocked`, `unavailable`);
- refuse `party-invite` for a friend set to `nobody`;
- refuse `party-accept` into a party with a blocked player;
- update `lastInteraction` and push the tab.

Server to client:

- `remaster-recent`: the list (above).
- `remaster-recent-result`: the answer to each action, and `{action: 'recent-join-accepted', ok, username}` to a requester whose request was accepted.
- `remaster-join-request {requestId, from: person}`: to the leader.
- `remaster-party-invite`: unchanged; recent invites use it too.

**Error codes:**
- From the friends actions: `no-account`, `slow-down`, `no-such-player`, `self`, `not-party-leader`, `already-in-party`, `party-full`, `party-in-queue`.
- New here: `not-recent`, `unavailable`, `blocked`, `offline`, `in-match`, `mode-full`, `too-soon`, `already-requested`, `too-many-requests`, `no-request`, `requester-offline`, `requester-busy`, `invalid-reason`, `already-reported`, `invalid-setting`, `too-many-blocked`, `not-blocked`.

## Operator routes

Both are loopback only, without proxy headers. Anything else gets a 404.

- **`POST /admin/ban {username, reason?}`** bans an account; `{username, banned: false}` lifts the ban.
  - What a ban does: signs the account out everywhere (account tokens, play grant, game sessions), disconnects its menu and takes it out of its party.
  - Afterwards `/api/account/login` and the game's `/api/login` answer `403 banned`, and the account drops out of every Recent players list.
  - Nothing is deleted.
- **`GET /admin/reports`** lists the reports.

`/metrics` gauges gain `recentPlayers: {users, entries, joinRequests, reports}` and the `social` rate-limiter size.

## The menu (RECENT tab)

The FRIENDS panel has two tabs, **FRIENDS** and **RECENT**. Each tab shows a count when something is waiting, and join requests also count on the main menu's FRIENDS item. The RECENT tab shows, top to bottom:

1. **Join requests**, with Accept and Decline.
2. **Recent players.** Each row has the card background, level, name, status, rank emblem and a detail line such as *Party teammate · Duo · Jungle · 12 min ago*. Then come the buttons the server allows:
   - *Add friend*, *Accept*, or a *Requested* tag;
   - *Invite*, or an *Invited* tag;
   - *Join*, or an *Asked* tag;
   - *More*, which opens why Invite or Join is off, the party size, *Block* (click twice), *Report* (choose a reason) and *Remove from list*.
3. **Who can invite you or ask to join**, with four choices; the current one is outlined.
4. **Blocked**, with *Unblock*.

The menu decides nothing: it shows what the server allows, and every answer appears in the panel's message line. The gamepad's focus ring covers the tabs and every button. A join request pops up over any screen, like a party invite.

## Tests

`server/test/recent_players.test.js`: 27 tests.

- **12 on the rules:**
  - recording, party vs lobby, and nothing recorded from one player or malformed ids;
  - dedupe, including a late older match, and the limit;
  - team and opponent relations for a future shared match;
  - blocks and the privacy matrix;
  - join requests, their expiry and how blocks drop them;
  - pair cooldowns;
  - reports (reason, once a day, note cleaning, the cap);
  - purge;
  - saving, reloading and an unreadable file;
  - the `friends.js` additions.
- **15 against spawned servers with real sockets:**
  - **Recording from a real lobby launch:** a party of two and a solo account player queue Duos together with a no-account guest, and all get one match id. The leader's list holds exactly the party teammate (`party`) and the solo player (`lobby`). The guest is not recorded, and neither is a player who wasn't there.
  - **Nothing a client sends adds anyone:** a fake `recent-record` event, a roster in the match result, or a player list sent with `recent-get`.
  - **No private fields** in any payload.
  - **Dedupe** on a second match.
  - **Friend request:** the list's friend state and last interaction.
  - **The privacy matrix:** nobody, friends, recent and everyone, an invalid setting, only the leader inviting, and invites only to players on your own list.
  - **Join requests:**
    - `party-in-queue` while the party searches;
    - `mode-full` after it last queued Duos;
    - fits after Solo;
    - `not-party-leader`, `already-requested`;
    - only the asked leader can answer;
    - accept puts the requester in the party.
  - **Blocks both ways:**
    - the blocker leaves the shared party;
    - both lists are hidden;
    - invite, join and friend request are refused each way;
    - accepting an invite into a party with the blocker is refused;
    - unblocking restores the list.
  - **Reports:** stored with context and visible to the operator only, with no effect on the player.
  - **Remove** takes the player off one list only.
  - **Ban:** off every list, sign-in refused both ways, the ban lifts, operator only.
  - **Limit:** `CULLING_RECENT_LIMIT=2` keeps two per player.
  - **Rate limits:** per player, and per pair (`too-soon`).
  - **Expiry** of invites and join requests.
  - **Restart:** after a restart with one account removed from `accounts.json`, the list survives and the deleted account is gone.

`patch/test_recent_menu.js` (10 tests, in `build_release.py` `tests()`) runs `Friends.js` on a stand-in DOM. It checks:

- the tab asks for the list;
- rows, detail lines and per-state buttons;
- every button sends only the action and the username, request id or setting;
- More / Block / Report / Remove;
- join requests (section, pop-up, badge, tab count);
- the setting and Unblock;
- each answer's message;
- malformed payloads;
- that no string in `Friends.js` says bots or AI;
- the gamepad ring.

## What is verified and what isn't

**Verified:**
- `server/test/recent_players.test.js` passes, and so do all the other server test files.
- The release's menu tests pass, and `python patch/lint_es5.py --release` is clean.
- The RECENT tab was drawn in a browser from `Friends.js` with a fake socket: the panel, More, the report reasons, and Invite updating to *Invited* with the message.

**Not verified:**
- The tab inside the game's own Coherent UI menu with the real `ClientWeb.js` socket.
- Its fonts and card images in the game. The preview fell back to Arial.
- Two real PCs going through a lobby on the VPS.
- A join request pop-up over the in-game lobby screen.

These need the launcher and the VPS. The server isn't deployed by this change.

## What changes once shared matches exist

- **Recording.** The host's authoritative roster comes through `recordPlayedTogether(source: 'match')`, with teams. Entries then mean "was in your match", not only "was in your lobby".
- **Joining.** Join-in-progress, spectating and slots before a cutoff become possible. See [JOIN_FRIENDS_AND_PARTY_DESIGN.md](JOIN_FRIENDS_AND_PARTY_DESIGN.md).
- **Reports** can carry the shared match's id for the operator to look up the host's record (`context.matchId` is already stored).
- **Mode fit** may use the match's real team slots instead of the playlist's party limit.
