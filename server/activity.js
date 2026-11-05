// Recent activity for the launcher's server line: matches played in the last
// 24 hours and players seen in the last 7 days (signed in or finished a
// match). Real counts only; saved to activity.json so a restart or deploy
// doesn't reset them.
"use strict";

const { CoalescedJsonFile } = require("./store");
const fs = require("fs");

const DAY = 24 * 3600 * 1000;
const WEEK = 7 * DAY;
const MAX_MATCHES = 200000;          // a day's worth at most; the oldest go first

class Activity {
  constructor(now = Date.now, file = null, opts = {}) {
    this.now = now;
    this.matches = [];               // finish times, oldest first
    this.players = new Map();        // userID -> last seen
    this.store = file ? new CoalescedJsonFile(file, () => JSON.stringify(this.toJSON()), opts) : null;
    if (file) this.load(file);
  }

  load(file) {
    let raw;
    try { raw = JSON.parse(fs.readFileSync(file, "utf8")); } catch { return; }
    if (!raw || typeof raw !== "object") return;
    if (Array.isArray(raw.matches)) this.matches = raw.matches.filter((t) => Number.isFinite(t)).sort((a, b) => a - b);
    if (raw.players && typeof raw.players === "object") {
      for (const [id, t] of Object.entries(raw.players)) if (Number.isFinite(t)) this.players.set(id, t);
    }
    this.prune();
  }

  toJSON() {
    return { matches: this.matches, players: Object.fromEntries(this.players) };
  }

  prune() {
    const t = this.now();
    let drop = 0;
    while (drop < this.matches.length && this.matches[drop] <= t - DAY) drop++;
    if (this.matches.length - drop > MAX_MATCHES) drop = this.matches.length - MAX_MATCHES;
    if (drop) this.matches.splice(0, drop);
    for (const [id, seen] of this.players) if (seen <= t - WEEK) this.players.delete(id);
  }

  // A player signed in or played.
  seen(userID) {
    if (!userID) return;
    this.players.set(String(userID), this.now());
    if (this.store) this.store.markDirty();
  }

  // A match result was accepted for this player.
  match(userID) {
    this.matches.push(this.now());
    this.seen(userID);
  }

  summary() {
    this.prune();
    return { matchesToday: this.matches.length, playersWeek: this.players.size };
  }

  flushSync() { return this.store ? this.store.flushSync() : false; }
}

module.exports = { Activity, DAY, WEEK };
