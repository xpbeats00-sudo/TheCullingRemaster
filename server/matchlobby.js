// Matchmaking lobbies: everyone searching the same playlist waits in one lobby
// and sees who else is in it (name, level, rank, calling card) until the match
// starts.
//
// A lobby gathers players for `gatherMs` from its first player (or until it is
// full), counts down `countdownMs`, then starts: `start(lobby)` sends every
// member into the match. Players who join later get the next lobby. Leaving
// (cancel, disconnect) takes a player out at any point; an empty lobby is
// dropped. Every change is pushed to the members (`send`), so the menus never
// poll.
//
// Matches are still played against bots on each player's own PC; the lobby is
// where player-vs-player matchmaking (Showdown) will pair players.
"use strict";

const DEFAULTS = { gatherMs: 10000, countdownMs: 5000, maxPlayers: 16 };

class MatchLobbies {
  // describe(member) -> the public card for one player; send(member, payload);
  // start(lobby) when its countdown ends. Timers and the clock are injectable
  // for tests.
  constructor({ describe, send, start, options = {}, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.describe = describe;
    this.send = send;
    this.startMatch = start;
    this.options = Object.assign({}, DEFAULTS, options);
    this.now = now;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.open = new Map();          // queue -> the lobby taking players
    this.byMember = new Map();      // member id -> lobby
    this.nextId = 1;
  }

  maxFor(queue) {
    const m = this.options.maxPlayers;
    return typeof m === "object" ? (m[queue] || m.default || DEFAULTS.maxPlayers) : m;
  }

  // Adds a player to the open lobby for `queue` (leaving any other first).
  join(queue, member) {
    this.leave(member.id);
    let lobby = this.open.get(queue);
    if (!lobby) {
      lobby = { id: this.nextId++, queue, state: "searching", members: new Map(), createdAt: this.now(),
        startAt: null, timer: null, maxPlayers: this.maxFor(queue) };
      this.open.set(queue, lobby);
      lobby.timer = this.setTimer(() => this.countdown(lobby), this.options.gatherMs);
    }
    lobby.members.set(member.id, member);
    this.byMember.set(member.id, lobby);
    if (lobby.members.size >= lobby.maxPlayers) this.countdown(lobby);
    else this.broadcast(lobby);
    return lobby;
  }

  // Takes a player out of their lobby, if they are in one.
  leave(id) {
    const lobby = this.byMember.get(id);
    if (!lobby) return false;
    this.byMember.delete(id);
    lobby.members.delete(id);
    if (!lobby.members.size) {
      this.clearTimer(lobby.timer);
      if (this.open.get(lobby.queue) === lobby) this.open.delete(lobby.queue);
    } else {
      this.broadcast(lobby);
    }
    return true;
  }

  // Full (or gathered long enough): closed to new players, counting down.
  countdown(lobby) {
    if (lobby.state !== "searching" || !lobby.members.size) return;
    this.clearTimer(lobby.timer);
    lobby.state = "starting";
    lobby.startAt = this.now() + this.options.countdownMs;
    if (this.open.get(lobby.queue) === lobby) this.open.delete(lobby.queue);
    lobby.timer = this.setTimer(() => this.launch(lobby), this.options.countdownMs);
    this.broadcast(lobby);
  }

  launch(lobby) {
    if (lobby.state !== "starting") return;
    lobby.state = "started";
    for (const id of lobby.members.keys()) this.byMember.delete(id);
    if (lobby.members.size) this.startMatch(lobby);
  }

  // What a member's menu shows.
  view(lobby) {
    const now = this.now();
    return {
      id: lobby.id,
      queue: lobby.queue,
      state: lobby.state,
      players: [...lobby.members.values()].map((m) => this.describe(m)),
      maxPlayers: lobby.maxPlayers,
      searchingMs: now - lobby.createdAt,
      startsInMs: lobby.state === "starting" ? Math.max(0, lobby.startAt - now) : null,
      gatherEndsInMs: lobby.state === "searching" ? Math.max(0, lobby.createdAt + this.options.gatherMs - now) : null,
      note: this.options.note || null
    };
  }

  broadcast(lobby) {
    const payload = this.view(lobby);
    for (const m of lobby.members.values()) this.send(m, payload);
  }

  stats() {
    let waiting = 0;
    for (const l of new Set(this.byMember.values())) waiting += l.members.size;
    return { lobbies: new Set(this.byMember.values()).size, waiting };
  }
}

module.exports = { MatchLobbies, DEFAULTS };
