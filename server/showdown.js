// Showdown series (patch/make_showdown.py): you against one rival in the
// Jungle arena, first to `roundsToWin` (default 4) - or your team against
// another (team Showdown, 2v2 to 4v4): the same series, the rounds your
// team's. Each series knows its playlist (`mode`) and team size.
//
// In-match series (patch/showdown_rounds.c, the patched exe): the whole
// series is one match. The queue starts it (startSeries); the HUD reports each
// round as the game ends it (recordInMatch, by round number, so a repeated or
// late report changes nothing); the match result that ends the series pays
// for it once (claimPayout). A series left before its end (quit to the menu)
// is a forfeit.
//
// The series are kept in a file when one is given (file: showdown-series.json
// in the data folder), so a server restart mid-series (every deploy) doesn't
// lose them; finished and idle ones are dropped when it loads.
//
// Older builds play one round per match (startRound / recordRound): the menu
// starts the next round, and a round left without a result is lost when the
// next one starts.

const fs = require('fs');
const { CoalescedJsonFile } = require('./store');

const DEFAULTS = { roundsToWin: 4, idleMs: 30 * 60 * 1000, now: Date.now, file: null, saveDelayMs: 0,
  onSaveError: () => {} };

class ShowdownSeries {
  constructor(options = {}) {
    this.options = Object.assign({}, DEFAULTS, options);
    this.series = new Map();                  // userID -> series
    this.store = null;
    const file = this.options.file;
    if (file) {
      let saved = [];
      try { saved = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { /* none yet */ }
      const cutoff = this.options.now() - this.options.idleMs;
      for (const entry of Array.isArray(saved) ? saved : []) {
        const [userID, s] = Array.isArray(entry) ? entry : [];
        if (typeof userID !== 'string' || !s || typeof s.id !== 'string' || !Array.isArray(s.rounds)) continue;
        if (!Number.isFinite(s.updatedAt) || s.updatedAt < cutoff) continue;
        if (s.over && s.paid && s.recorded && s.announced) continue;
        this.series.set(userID, s);
      }
      this.store = new CoalescedJsonFile(file, () => JSON.stringify([...this.series.entries()]),
        { delayMs: this.options.saveDelayMs, onError: this.options.onSaveError, now: this.options.now });
    }
  }

  save() { if (this.store) this.store.markDirty(); }

  flushSync() { return this.store ? this.store.flushSync() : false; }

  get maxRounds() { return 2 * this.options.roundsToWin - 1; }

  // The player's series still being played (null when none or finished).
  current(userID) {
    const s = this.series.get(userID);
    if (!s || s.over) return null;
    if (this.options.now() - s.updatedAt > this.options.idleMs) {
      this.series.delete(userID);             // abandoned long ago: start afresh
      this.save();
      return null;
    }
    return s;
  }

  // The last series, finished or not (what the menu shows after a match).
  last(userID) { return this.series.get(userID) || null; }

  fresh(userID, inMatch, kind = {}) {
    const teamSize = Number.isInteger(kind.teamSize) && kind.teamSize >= 1 && kind.teamSize <= 4 ? kind.teamSize : 1;
    const s = { id: Math.random().toString(36).slice(2, 10), wins: 0, losses: 0, rounds: [], inRound: false,
      over: false, won: null, inMatch, paid: false, recorded: false, announced: false,
      mode: typeof kind.mode === 'string' ? kind.mode : 'showdown', teamSize,
      startedAt: this.options.now(), updatedAt: this.options.now() };
    this.series.set(userID, s);
    this.save();
    return s;
  }

  // ------------------------------------------------------------ in-match series

  // The queue starts a whole series in one match. One still being played (the
  // player left it) is forfeited first: returned as `left`. `kind`: the
  // playlist's { mode, teamSize } (1v1 Showdown when left out).
  startSeries(userID, kind = {}) {
    const before = this.current(userID);
    const left = before ? this.leave(userID) : null;
    const s = this.fresh(userID, true, kind);
    s.inRound = true;
    return { series: this.view(s), left };
  }

  // A round the game ended: `result` 'W' (you), 'L' (the rival) or 'D' (no
  // one). Only the next round counts; anything else returns null.
  recordInMatch(userID, round, result) {
    const s = this.current(userID);
    if (!s || !s.inMatch || !s.inRound) return null;
    if (!Number.isInteger(round) || round !== s.rounds.length + 1) return null;
    if (result === 'D') {
      s.rounds.push('draw');
      s.updatedAt = this.options.now();
    } else if (result === 'W' || result === 'L') {
      this.finish(s, result === 'W', result === 'W' ? 'won' : 'lost');
    } else {
      return null;
    }
    s.inRound = !s.over;                      // the match goes on to the next round
    this.save();
    return this.view(s);
  }

  // The series' pay-out, once, when it is over (the match result that ends
  // it). Null when not over or already paid.
  claimPayout(userID) {
    const s = this.series.get(userID);
    if (!s || !s.over || s.paid) return null;
    s.paid = true;
    this.save();
    return this.view(s);
  }

  // The menu has shown the final score (once).
  markAnnounced(userID) {
    const s = this.series.get(userID);
    if (!s || s.announced) return false;
    s.announced = true;
    this.save();
    return true;
  }

  // Once per finished series: whether its result still needs to go on the
  // player's record (true the first time only).
  markRecorded(userID) {
    const s = this.series.get(userID);
    if (!s || !s.over || s.recorded) return false;
    s.recorded = true;
    this.save();
    return true;
  }

  // ------------------------------------------------------------ one round per match (older builds)

  // A round is starting: a new series, or the next round of the current one.
  startRound(userID) {
    let s = this.current(userID);
    if (!s) {
      s = this.fresh(userID, false);
    } else if (s.inRound) {
      this.finish(s, false, 'left');          // the round before never reported
      if (s.over) return this.startRound(userID);
    }
    s.inRound = true;
    s.updatedAt = this.options.now();
    this.save();
    return this.view(s);
  }

  // The round's result. Ignored when no round is being played.
  recordRound(userID, won) {
    const s = this.current(userID);
    if (!s || !s.inRound) return null;
    this.finish(s, Boolean(won), won ? 'won' : 'lost');
    this.save();
    return this.view(s);
  }

  // The player leaves the series (from the menu, or by quitting the match).
  leave(userID) {
    const s = this.current(userID);
    if (!s) return null;
    if (s.inRound && !s.inMatch) this.finish(s, false, 'left');
    if (!s.over) {
      if (s.inMatch) s.rounds.push('left');
      s.inRound = false;
      s.over = true; s.won = false; s.forfeit = true;
    }
    this.save();
    return this.view(s);
  }

  finish(s, won, how) {
    s.inRound = false;
    s.rounds.push(how);
    if (won) s.wins++; else s.losses++;
    s.updatedAt = this.options.now();
    if (s.wins >= this.options.roundsToWin || s.losses >= this.options.roundsToWin) {
      s.over = true;
      s.won = s.wins >= this.options.roundsToWin;
    }
  }

  view(s) {
    const teamSize = s.teamSize || 1;
    return {
      id: s.id,
      mode: s.mode || 'showdown',
      teamSize,
      format: teamSize + 'v' + teamSize,
      round: s.rounds.length + (s.inRound ? 1 : 0),
      wins: s.wins,
      losses: s.losses,
      roundsToWin: this.options.roundsToWin,
      maxRounds: this.maxRounds,
      rounds: s.rounds.slice(),
      inRound: s.inRound,
      inMatch: Boolean(s.inMatch),
      over: s.over,
      won: s.won,
      forfeit: Boolean(s.forfeit)
    };
  }

  stats() { return { series: this.series.size }; }
}

// What a finished in-match series pays: one series, not a match per round.
// XP and credits grow with rounds won (a fraction of a full match's), the
// series counts once on the career (one game, a win only for the series),
// kills at most one rival per round won (in team Showdown the team size per
// round won: a round is won by downing every rival), damage at most 200 a
// round. The same for every team size.
const PAYOUT = { xpBase: 250, xpPerRound: 250, xpWin: 750, creditsBase: 40, creditsPerRound: 20, creditsWin: 120,
  damagePerRound: 200 };

function seriesPayout(view, report) {
  const roundsWon = view.wins;
  const maxKills = roundsWon * (view.teamSize || 1);
  const played = Math.max(1, view.rounds.filter((r) => r !== 'left').length);
  const won = Boolean(view.won);
  const bounded = (v, max) => (Number.isFinite(v) ? Math.min(max, Math.max(0, v)) : 0);
  return {
    victory: won,
    kills: bounded(parseInt(report.kills, 10), maxKills),
    damage: bounded(Number(report.damage), PAYOUT.damagePerRound * played),
    timeAlive: bounded(Number(report.timeAlive), report.maxTime || 0),
    func: 0,
    xp: PAYOUT.xpBase + PAYOUT.xpPerRound * roundsWon + (won ? PAYOUT.xpWin : 0),
    credits: PAYOUT.creditsBase + PAYOUT.creditsPerRound * roundsWon + (won ? PAYOUT.creditsWin : 0)
  };
}

module.exports = { ShowdownSeries, seriesPayout, PAYOUT };
