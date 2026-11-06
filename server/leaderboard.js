// The global leaderboard (the menu's LEADERBOARD panel, js/Leaderboard.js).
//
// Boards, computed from profiles: this season's ranked rating (one board per
// ranked mode: "ranked" is Ranked Solo, "ranked_duo" / "ranked_trio" /
// "ranked_quad" the team modes, each from that mode's own rating), wins,
// kills, K/D (players with at least `minMatches` matches), Showdown series
// won and time played. Only players with an account are listed, by username: no IDs,
// and never a player without an account. Each board lists the top `size`;
// the asking player also gets their own row and position on every board.
//
// Sorting every profile is not done per request: the boards are computed at
// most once every `minAgeMs` after a change (changed()), and at least every
// `ttlMs` in case a change went unannounced. A request is then a lookup.
"use strict";

// The team ranked boards come last: older menus find boards by id, and anything
// reading them by position keeps its place.
const BOARDS = ["ranked", "wins", "kills", "kd", "showdown", "time", "ranked_duo", "ranked_trio", "ranked_quad"];
// The ranked boards and the mode each one ranks (server/ranked.js MODES).
const RANKED_BOARDS = { ranked: "solo", ranked_duo: "duo", ranked_trio: "trio", ranked_quad: "quad" };
const isRankedBoard = (board) => Object.prototype.hasOwnProperty.call(RANKED_BOARDS, board);

class Leaderboard {
  // players(): iterable of { userID, username, profile } (account players).
  // ranked: server/ranked.js (CONFIG.season, CONFIG.maxRating, tierFor).
  constructor({ players, ranked, maxLevel = Infinity, now = Date.now, size = 50, minMatches = 10,
    minAgeMs = 30000, ttlMs = 5 * 60 * 1000 } = {}) {
    this.players = players;
    this.ranked = ranked;
    this.maxLevel = maxLevel;
    this.now = now;
    this.size = size;
    this.minMatches = minMatches;
    this.minAgeMs = minAgeMs;
    this.ttlMs = ttlMs;
    this.cache = null;
    this.dirty = true;
    this.computations = 0;
  }

  // Something a board shows has changed (a result, a new account).
  changed() { this.dirty = true; }

  current() {
    const t = this.now();
    const age = this.cache ? t - this.cache.at : Infinity;
    if (age >= this.ttlMs || (this.dirty && age >= this.minAgeMs)) this.cache = this.compute(t);
    return this.cache;
  }

  // One row per account player with everything the boards show.
  // seasonId: the current season (compute() works it out once: the getter
  // computes it from the date on every read).
  row(userID, username, p, seasonId = this.ranked.CONFIG.season.id) {
    const s = (p && p.stats) || {};
    const games = s.gamesPlayed || 0;
    const wins = s.wins || 0;
    const kills = s.kills || 0;
    const deaths = Math.max(0, games - wins);      // every match not won ends in a death
    const sd = (p && p.showdown) || {};
    const r = p && p.ranked;
    const cfg = this.ranked.CONFIG;
    const rating = r && Number.isFinite(r.rating) ? Math.min(cfg.maxRating, r.rating) : null;
    const thisSeason = rating !== null && r.season === seasonId && (r.matches || 0) > 0;
    // Each ranked mode this season: { rating, matches, wins, rank } or null.
    const modes = {};
    for (const board of Object.keys(RANKED_BOARDS)) {
      const mode = RANKED_BOARDS[board];
      const m = mode === "solo" ? r : (this.ranked.record ? this.ranked.record(p, mode) : null);
      const mr = m && Number.isFinite(m.rating) ? Math.min(cfg.maxRating, m.rating) : null;
      modes[mode] = mr !== null && m.season === seasonId && (m.matches || 0) > 0
        ? { rating: mr, matches: m.matches || 0, wins: m.wins || 0, rank: this.ranked.tierFor(mr).name } : null;
    }
    return {
      userID, username,
      level: Math.min(this.maxLevel, s.level || 1),
      cardID: (p && p.cardID) || 0,
      rank: rating === null ? null : this.ranked.tierFor(rating).name,
      games, wins, kills, deaths,
      kd: deaths ? Math.round(kills / deaths * 100) / 100 : kills,
      showdownWon: sd.won || 0, showdownLost: sd.lost || 0,
      minutes: s.minutesAlive || 0,
      rating: thisSeason ? rating : null,
      rankedMatches: thisSeason ? r.matches || 0 : 0,
      rankedWins: thisSeason ? r.wins || 0 : 0,
      modes,
      pos: {}
    };
  }

  // A row's value on a board, or null if it isn't listed there.
  value(board, x) {
    if (board !== "ranked" && isRankedBoard(board)) {
      const m = x.modes[RANKED_BOARDS[board]];
      return m ? m.rating : null;
    }
    switch (board) {
      case "ranked": return x.rating;
      case "wins": return x.wins > 0 ? x.wins : null;
      case "kills": return x.kills > 0 ? x.kills : null;
      case "kd": return x.games >= this.minMatches ? x.kd : null;
      case "showdown": return x.showdownWon > 0 ? x.showdownWon : null;
      case "time": return x.minutes > 0 ? x.minutes : null;
    }
    return null;
  }

  // Ties on the value: the second key, then the name (both only order the
  // list; tied players share a position).
  second(board, x) {
    if (board !== "ranked" && isRankedBoard(board)) {
      const m = x.modes[RANKED_BOARDS[board]];
      return m ? m.wins : 0;
    }
    switch (board) {
      case "ranked": return x.rankedWins;
      case "wins": case "kills": return -x.games;       // in fewer matches is better
      case "kd": return x.kills;
      case "showdown": return -x.showdownLost;
    }
    return 0;
  }

  compute(at) {
    this.computations++;
    this.dirty = false;
    const rows = new Map();
    const seasonId = this.ranked.CONFIG.season.id;
    for (const { userID, username, profile } of this.players()) {
      if (typeof username !== "string" || !username || rows.has(userID)) continue;
      rows.set(userID, this.row(userID, username, profile, seasonId));
    }
    const boards = {};
    for (const id of BOARDS) {
      // Each row's value and tie-break worked out once, not on every comparison.
      const list = [];
      for (const x of rows.values()) {
        const v = this.value(id, x);
        if (v !== null) list.push({ x, v, s: this.second(id, x) });
      }
      list.sort((a, b) => b.v - a.v || b.s - a.s
        || (a.x.username < b.x.username ? -1 : a.x.username > b.x.username ? 1 : 0));
      let position = 0, last = null;
      list.forEach((e, i) => {
        if (e.v !== last) { position = i + 1; last = e.v; }
        e.x.pos[id] = position;
      });
      boards[id] = { players: list.length, top: list.slice(0, this.size).map((e) => this.entry(id, e.x)) };
    }
    return { at, rows, boards };
  }

  // A row as a board shows it: no IDs.
  entry(board, x) {
    const e = { position: x.pos[board] || null, username: x.username, level: x.level, rank: x.rank, cardID: x.cardID,
      value: this.value(board, x) };
    if (board === "ranked") Object.assign(e, { matches: x.rankedMatches, wins: x.rankedWins });
    else if (isRankedBoard(board)) {
      // A team board shows the player's tier in that mode.
      const m = x.modes[RANKED_BOARDS[board]];
      Object.assign(e, { matches: m ? m.matches : 0, wins: m ? m.wins : 0 });
      e.rank = m ? m.rank : null;
    }
    else if (board === "kd") Object.assign(e, { kills: x.kills, deaths: x.deaths, matches: x.games });
    else if (board === "showdown") Object.assign(e, { lost: x.showdownLost });
    else e.matches = x.games;
    return e;
  }

  // What the panel shows to `userID` (null: a player without an account).
  view(userID) {
    const c = this.current();
    const me = userID ? c.rows.get(userID) : null;
    const cfg = this.ranked.CONFIG;
    return {
      season: { id: cfg.season.id, name: cfg.season.name },
      updatedAt: c.at,
      size: this.size,
      minMatches: this.minMatches,
      you: me ? me.username : null,
      boards: BOARDS.map((id) => {
        const b = c.boards[id];
        let you = null;
        if (me) {
          you = this.entry(id, me);
          if (you.position === null) {
            you.value = this.valueOf(id, me);
            if (id === "kd") you.needMatches = Math.max(0, this.minMatches - me.games);
          }
        }
        return { id, mode: isRankedBoard(id) ? RANKED_BOARDS[id] : null, players: b.players, top: b.top, you };
      })
    };
  }

  // Your own figure on a board you aren't listed on (0, or your K/D so far).
  valueOf(board, x) {
    if (isRankedBoard(board)) return null;
    switch (board) {
      case "wins": return x.wins;
      case "kills": return x.kills;
      case "kd": return x.kd;
      case "showdown": return x.showdownWon;
      case "time": return x.minutes;
    }
    return null;
  }

  stats() { return { computedAt: this.cache ? this.cache.at : null, computations: this.computations,
    players: this.cache ? this.cache.rows.size : 0 }; }
}

module.exports = { Leaderboard, BOARDS, RANKED_BOARDS };
