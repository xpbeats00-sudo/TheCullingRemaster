# Friends, parties and player cards

Players add each other by account username, see what their friends are doing, form a party of up to 4 that queues together, and open anyone's player card. Code: `server/friends.js` (friends and parties), the friends section and socket events in `server/server.js`, `MatchLobbies.joinGroup` in `server/matchlobby.js`, and the menu in `patch/src/Victory/Content/uiresources/FrontEnd/js/Friends.js` (wired up in `ClientWeb.js` and `MatchLobby.js`; `patch/make_branding.py` adds the menu item and the script tag). Tests: `server/test/friends.test.js`.

## Friends

- **Requests.** You send a request to a username. The name is matched the same way sign-in matches it: case and extra spaces don't matter. The other player accepts or declines it, and you can cancel your own request.
  - If they had already asked you, your request accepts theirs.
  - Either player can remove the other.
- **Refused requests** answer `no-such-player`, `self`, `already-friends` or `already-requested`. Limits answer `too-many-friends` (200 friends) or `too-many-requests` (50 waiting).
- **Rate limit.** Each player gets 1 action a second, in bursts of up to 20, across requests, accepts, declines, removals and party actions. Over the limit the answer is `slow-down`.
- **Accounts only.** A player signed in without an account (only possible where accounts aren't required) gets `no-account`.
- **Storage.** Friend lists are saved by userID in `friends.json` in the data folder, next to `profiles.json`. Saves are coalesced like the other stores, and the file is flushed on shutdown. A file that can't be read is kept as `friends.json.unreadable-<time>`.
  - Each player's *last seen* time is saved there too: it is updated when they sign in or disconnect.

## Status

What friends see, worked out on the server:

| State | Shown as | Set when |
|---|---|---|
| `menu` | In menu | the menu signs in, a result comes back, they cancel a search |
| `searching` | Searching · Solo / Duo / Ranked | the lobby takes them (`join-mm`) |
| `lobby` | In lobby · *mode* | their lobby's countdown starts (pregame lobby) |
| `match` | In match · *mode* (Showdown adds the round) | their match starts (`launchMatch`, or the Showdown round) |
| `offline` | Offline · *n* min / h / days ago | no menu connection and no open match |

The menu connection can drop while the game is in a match. A player is still *in match* while their match ticket is open, until the result is reported or the ticket expires. Every change is pushed to the player and to their online friends and party members.

## Parties

- **Forming a party.** You invite a friend, which creates the party if you don't have one. You lead it. Only the leader invites (`not-party-leader`).
  - The invited player gets a pop-up (Join / Decline) and sees the invite in the friends panel. Invites last 5 minutes.
  - Joining a party leaves any other party.
  - A party holds at most 4 players (`party-full`).
  - A party that is searching can't be joined until its search ends (`party-in-queue`).
- **Leaving.** Anyone can leave. When the leader leaves, the next member leads. A party left with one player, and no invites still open, is dropped. Leaving while the party searches stops the search for everyone (`leave-mm-group`, reason `party-changed`).
- **Offline members.** A member who disconnects keeps their place. If they stay offline for 2 minutes (`CULLING_PARTY_OFFLINE_MS`) and aren't in a match, they leave the party and the others get `remaster-party-notice`. If that member was the leader, the next member leads.
- **Queueing together.** The party queues as one unit (details in [AUDIT_02_PARTY_MATCHMAKING.md](AUDIT_02_PARTY_MATCHMAKING.md)):
  - Only the leader queues. A member who presses a mode is refused (`party-leader-queues`). If their party is already queued, they stay in its lobby.
  - Every member must be in the menu. If one is offline or in a match, the queue is refused (`party-not-ready`) and the reply names them.
  - The playlist must take a party that size: Duos takes 2 at most, Showdown Solo takes 1 (`party-too-large`). Nobody is left behind.
  - Members get `join-mm-group` with the leader's queue name, and everyone joins one lobby at once (`joinGroup`). If the open lobby can't fit the whole party, it starts counting down and the party opens the next one.
  - Every member gets the same `matchId`, `lobbyId` and `partyId` on `match-ready` and on their match ticket. Each member still plays their own local match with AI contestants (`netplay: false`).
  - If anyone cancels, disconnects or leaves the party during the search, it stops for everyone. Each menu gets `leave-mm-group` with a reason and a message.
- **Not saved.** Parties live in memory and end when the server restarts.

## Player card

`player-card {username}` returns a card for that player; with no username it returns your own. The card has:

- `username`, `level`, `cardID`, `rank` (the same public card the lobby shows) and `status`.
- Record: `wins`, `losses`, `games`, `kills`, `kd`, `winRate`, `minutesPlayed`, `damage` and `memberSince`.
  - `losses` is games minus wins, since every match that isn't won ends in a death.
  - `kd` is kills per loss.
  - `minutesPlayed` is the profile's minutes alive in matches.
- `ranked` for this season: tier, rating, peak tier, ranked matches and wins, and the tiers reached. It is `null` before the first ranked match.
- `showdown`: Showdown series `{won, lost}`. It is counted when a series ends, including a forfeit and a series ended by an unplayed round. It is new in this change, so it starts at 0 for everyone.
- `relation` to you: `you`, `friend`, `requested`, `asked-you` or `none`.

No IDs are included. A username with no account answers `{found: false}`.

**Where it opens:**

- the friends and party lists;
- any lobby row;
- your own card at the top right of the menu.

A contestant without a public profile shows the card, level and rank the lobby row shows, and *This player keeps their stats private.* Nothing on it says how that player got into the match.

**Character model.** The card does not show the 3D character. The menu is HTML (Coherent) and only the engine renders the character, so it can't be put inside a page panel.

## Socket events

Client to server:

- `friends-get`
- `friend-request`, `friend-accept`, `friend-decline`, `friend-remove`, each `{username}`
- `party-invite` `{username}`
- `party-accept`, `party-decline`, each `{partyId}`
- `party-leave`
- `player-card` `{username?}`

Server to client:

- `remaster-friends`, the whole panel:
  - `{you, friends, incoming, outgoing, party, invites, maxParty}`;
  - each person is `{username, name, level, cardID, rank, status: {state, label, lastSeen}}`.
- `remaster-friend-result` `{action, ok | error, ...}`: the answer to each action.
- `remaster-party-invite` `{partyId, from}`
- `remaster-player-card`

The stock `get-friends` and `group-invite` stubs are unchanged: the stock friends UI belongs to the platform layer, which this replaces.

## Menu

- **FRIENDS** is a main menu item, added before PROFILE. The footer's *Invite Player* button is relabelled *Friends* and opens the same panel (`OnInvitePressed`).
  - The item shows a count when requests or invites are waiting.
- **The panel** has an add-by-username box, then the party with *Leave party*, party invites, requests (Accept / Decline, or Cancel) and friends.
  - Each friend row has a status dot and text, plus *Invite* and *Remove* (click twice to confirm).
  - Clicking any row opens that player's card.
- **Building the menu.** The menu edits are part of `rebrand_html` in `make_branding.py`. To apply only the friends edits to an already generated page, run:

  ```bash
  python patch/make_branding.py --menu-only [path to FrontEnd.html]
  ```

  It is safe to run more than once.
