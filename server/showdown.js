// Showdown series (patch/make_showdown.py): you against one bot in the Jungle
// arena, a round at a time, first to `roundsToWin` (default 4, so at most 7
// rounds). Each round is a separate match on the player's PC; this keeps the
// score between them. A round the player leaves without a result (quit,
// crash) is lost when the next one starts.

const DEFAULTS = { roundsToWin: 4, idleMs: 30 * 60 * 1000, now: Date.now };

class ShowdownSeries {
  constructor(options = {}) {
    this.options = Object.assign({}, DEFAULTS, options);
    this.series = new Map();                  // userID -> series
  }

  get maxRounds() { return 2 * this.options.roundsToWin - 1; }

  // The player's series still being played (null when none or finished).
  current(userID) {
    const s = this.series.get(userID);
    if (!s || s.over) return null;
    if (this.options.now() - s.updatedAt > this.options.idleMs) {
      this.series.delete(userID);             // abandoned long ago: start afresh
      return null;
    }
    return s;
  }

  // The last series, finished or not (what the menu shows after a round).
  last(userID) { return this.series.get(userID) || null; }

  // A round is starting: a new series, or the next round of the current one.
  startRound(userID) {
    let s = this.current(userID);
    if (!s) {
      s = { id: Math.random().toString(36).slice(2, 10), wins: 0, losses: 0, rounds: [], inRound: false,
        over: false, won: null, startedAt: this.options.now(), updatedAt: this.options.now() };
      this.series.set(userID, s);
    } else if (s.inRound) {
      this.finish(s, false, 'left');          // the round before never reported
      if (s.over) return this.startRound(userID);
    }
    s.inRound = true;
    s.updatedAt = this.options.now();
    return this.view(s);
  }

  // The round's result. Ignored when no round is being played.
  recordRound(userID, won) {
    const s = this.current(userID);
    if (!s || !s.inRound) return null;
    this.finish(s, Boolean(won), won ? 'won' : 'lost');
    return this.view(s);
  }

  // The player leaves the series from the menu.
  leave(userID) {
    const s = this.current(userID);
    if (!s) return null;
    if (s.inRound) this.finish(s, false, 'left');
    if (!s.over) { s.over = true; s.won = false; s.forfeit = true; }
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
    return {
      id: s.id,
      round: s.rounds.length + (s.inRound ? 1 : 0),
      wins: s.wins,
      losses: s.losses,
      roundsToWin: this.options.roundsToWin,
      maxRounds: this.maxRounds,
      rounds: s.rounds.slice(),
      inRound: s.inRound,
      over: s.over,
      won: s.won,
      forfeit: Boolean(s.forfeit)
    };
  }

  stats() { return { series: this.series.size }; }
}

module.exports = { ShowdownSeries };
