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
// Map vote: with `maps` set, each player votes (their queue's map to start
// with, if it named one) until the countdown starts; then the map with the
// most votes is locked in for everyone (a tie, or no votes, is drawn among the
// leaders). `start` gets it as lobby.map.
//
// Matches are still played against bots on each player's own PC; the lobby is
// where player-vs-player matchmaking (Showdown) will pair players.
"use strict";

const DEFAULTS = { gatherMs: 10000, countdownMs: 5000, maxPlayers: 16, maps: null, random: Math.random };

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

  // Adds a player to the open lobby for `queue` (leaving any other first);
  // `prefer` is their first map vote.
  join(queue, member, prefer) {
    this.leave(member.id);
    member.vote = this.validMap(prefer) ? prefer : null;
    let lobby = this.open.get(queue);
    if (!lobby) {
      lobby = { id: this.nextId++, queue, state: "searching", members: new Map(), createdAt: this.now(),
        startAt: null, timer: null, maxPlayers: this.maxFor(queue), map: null };
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

  validMap(map) { return !!this.options.maps && this.options.maps.includes(map); }

  // A player's map vote, while their lobby is still searching.
  vote(id, map) {
    const lobby = this.byMember.get(id);
    if (!lobby || lobby.state !== "searching" || !this.validMap(map)) return false;
    const m = lobby.members.get(id);
    if (m.vote === map) return true;
    m.vote = map;
    this.broadcast(lobby);
    return true;
  }

  tally(lobby) {
    const votes = {};
    for (const map of this.options.maps || []) votes[map] = 0;
    for (const m of lobby.members.values()) if (m.vote) votes[m.vote]++;
    return votes;
  }

  // The map with the most votes; a tie (or no votes) is drawn among the leaders.
  decideMap(lobby) {
    if (!this.options.maps) return null;
    const votes = this.tally(lobby);
    const top = Math.max(...Object.values(votes));
    const leaders = Object.keys(votes).filter((m) => votes[m] === top);
    return leaders[Math.min(leaders.length - 1, Math.floor(this.options.random() * leaders.length))];
  }

  // Full (or gathered long enough): closed to new players, counting down.
  countdown(lobby) {
    if (lobby.state !== "searching" || !lobby.members.size) return;
    this.clearTimer(lobby.timer);
    lobby.map = this.decideMap(lobby);
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
      players: [...lobby.members.values()].map((m) => Object.assign(this.describe(m), this.options.maps ? { vote: m.vote } : {})),
      maxPlayers: lobby.maxPlayers,
      searchingMs: now - lobby.createdAt,
      startsInMs: lobby.state === "starting" ? Math.max(0, lobby.startAt - now) : null,
      gatherEndsInMs: lobby.state === "searching" ? Math.max(0, lobby.createdAt + this.options.gatherMs - now) : null,
      maps: this.options.maps ? this.tally(lobby) : null,
      map: lobby.map,
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
