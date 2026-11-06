# Joining friends and parties: invite, join, join-in-progress

How players get into a game together: an invite, a request to join, and joining a match that has already started. This doc says which of these work today and which need shared matches.

The rules that exist today live in:
- `server/friends.js` (parties, invites);
- `server/recentplayers.js` and `server/server.js` (join requests, privacy, blocks);
- [FRIENDS_AND_PARTY.md](FRIENDS_AND_PARTY.md);
- [RECENT_PLAYERS_SYSTEM.md](RECENT_PLAYERS_SYSTEM.md).

## The constraint

A match runs on each player's own PC, and its other contestants are AI. The server gives a party one lobby, one match id and one party id ([AUDIT_02_PARTY_MATCHMAKING.md](AUDIT_02_PARTY_MATCHMAKING.md)), but two humans are never in the same game world. Shared matches are being researched ([NETPLAY_LISTEN_SERVER.md](NETPLAY_LISTEN_SERVER.md)). Until they exist:

- "Joining a friend" means joining their **party**. The leader queues the party, and everyone goes through one lobby into matches that share a match id.
- **Nothing can join a match in progress.** There is no running match on a server to join, only each player's own local game.

## Ways in

| Way in | Today | Rules |
|---|---|---|
| **Invite (friend)** | Works | Only the leader invites (`not-party-leader`). Party of up to 4. The invite lasts 5 min. Accepting leaves any other party, and is refused while the party searches (`party-in-queue`). New: refused if either player blocked the other, if anyone in the party is blocked either way with the joiner, and if the invited friend's setting is `nobody`. |
| **Invite (recent player)** | Works (new) | As above, but no friendship needed: the invited player's setting decides (`everyone`, `recent`, which is friends plus their own recent list, `friends`, `nobody`). The pair must be on the inviter's list. Rate-limited per player and per pair. |
| **Request to join (recent player)** | Works (new) | You ask, and the party's leader answers. Refused unless: their setting allows you; they lead the party or have none; there is room; nobody is in a match or searching; the mode they last queued takes one more; and there are no blocks. Everything is checked again on accept. Lasts 5 min. Rate-limited. |
| **Request to join (friend, from the friends list)** | Not built | The same server action would serve it: `recent-join-request` requires the target on your recent list today. Allowing friends is a small change: let `recentTarget` accept a friend. It isn't in the menu yet. |
| **Join a match in progress** | **Not possible** | Needs shared matches (below). |
| **Spectate** | **Not possible** | Needs shared matches and a spectator connection (below). |

### The party's mode

A party has no fixed mode; the leader picks one when queueing. For join requests, "the mode fits" means the playlist the party (or a lone player) **last queued**: a party of 2 that last queued Duos is full for Duos. With no playlist yet, any party with room fits.

The queue itself still checks the size when the leader queues (`party-too-large`). So a party that grew to 3 and then queues Duos is refused with a message: nobody is dropped.

### Timing

- **In a match:** you can't ask to join a party with someone in a match (`in-match`). The leader is in their game, and the menu's connection is closed during a match, so nobody could answer.
- **Searching:** a party that is searching can't take anyone (`party-in-queue`). Its lobby is already set.
- **After the match:** both work again once everyone is back in the menu.

## Join-in-progress, once shared matches exist

These rules are for the shared-match work. **None of them can be built or tested today.** Each needs a match that more than one human connects to.

1. **Spectate.** Join a friend's or party member's running match as a spectator: no pawn, no effect on the match, and no results or ranked score.
   - Who may: the player's setting, the same four choices (a separate *who may spectate me* setting is worth considering), and never across a block.
   - Ranked matches: spectating should be off, or delayed by a minute or more, so a spectator can't call positions to a player.
   - Needs: a spectator connection type in the listen server, and a camera that follows a player.
2. **Next match (the default).** A join accepted during a match puts the requester in the **party**, not the match. When the match ends, the party is together in the menu and the leader queues for the next one.
   - This is what today's design already does, except that today the request is refused (`in-match`) because nobody can answer it during a match.
   - Once a host knows a match is running on the server's behalf, the request can be held until the leader is back in the menu, and then shown.
3. **A slot before the cutoff.** A match that hasn't passed a cutoff can take a late player into a free slot: before the pods open, or within the first N seconds in Survival.
   - Only in modes that allow it: Solo and Lightning, and team modes with an open spot on the requester's party's team.
   - Never in Ranked, and never after the cutoff.
   - Showdown: never mid-series.
   - The host's roster, reported to the server, decides the free slots, and the server's ticket for the late player carries the same `matchId`.
   - The recording hook (`recordPlayedTogether`, source `match`) then records them with everyone else.

What stays the same once shared matches exist:

- invites and join requests go through the server, with the same privacy, block, expiry and rate-limit rules;
- the leader answers join requests;
- a party is never split silently;
- recent players come only from the server's own records (the lobby launch today, the host's roster later), never from a client's list.

## What is possible today and what isn't

| | Today | Needs shared matches |
|---|---|---|
| Party invite (friends, recent players) | Yes, tested | — |
| Ask to join a party (recent players) | Yes, tested | — |
| The party queues and gets one lobby and one match id | Yes, tested (`party.test.js`) | — |
| Be in the same game world as a friend | No | Yes |
| Spectate a friend | No | Yes, plus a spectator connection |
| Join a running match (before a cutoff) | No | Yes, plus host-reported slots |
| Join requests held until the leader's match ends | No (refused `in-match`) | Doable sooner (the server knows when the match ends), but only useful once matches are shared |

**Verified:** the server tests in `server/test/recent_players.test.js`, `party.test.js` and `friends.test.js`.

**Not verified:** none of this has been checked in the game on two PCs. Join-in-progress and spectating are design only.
