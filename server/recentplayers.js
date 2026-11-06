// Recent players: who each player has played with, as the server itself knows
// it, and the safety tools that go with meeting people (docs/RECENT_PLAYERS_SYSTEM.md).
//
// - Recording. recordMatch() is the only way in. Today server.js calls it
//   when a matchmaking lobby launches: the account players it sent into one
//   match (one match id), party teammates marked as such. Each player's match
//   still runs on their own PC, so that is all the server can confirm. When
//   shared matches exist, the host's authoritative roster comes through the
//   same function (source "match", with teams). Nothing a client sends is
//   ever recorded.
// - One entry per pair, the latest kept, newest first, at most `limit` per
//   player (CULLING_RECENT_LIMIT, 50).
// - Blocks (either way: neither can invite, ask to join or see the other in
//   Recent players), the per-player setting for who may invite them or ask to
//   join their party, and player reports for the operator (never acted on
//   automatically) are kept here too.
// - Join requests and the per-pair cooldowns live in memory only.
//
// Saved by userID in recent-players.json (CoalescedJsonFile, like friends.json).
"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { CoalescedJsonFile } = require("./store");

// Who may invite you or ask to join your party. "recent": your friends and
// the players in your Recent players list; "friends": friends only.
const PRIVACY = ["everyone", "recent", "friends", "nobody"];
// How two players met. party / lobby: what the server knows today (the same
// party; the same lobby and match id). team / opponent / match: for the
// authoritative roster of a shared match (the same team, the other team, a
// match without teams).
const RELATIONS = ["party", "lobby", "team", "opponent", "match"];
const SOURCES = ["lobby", "match"];
const REPORT_REASONS = ["cheating", "abuse", "name", "griefing", "other"];

const DEFAULTS = {
  limit: 50,                       // entries kept per player
  privacy: "recent",               // the setting of a player who never chose
  requestTtlMs: 5 * 60 * 1000,     // a join request lasts as long as a party invite
  pairCooldownMs: 30 * 1000,       // the same invite / join request to the same player
  maxBlocked: 500,
  maxJoinRequests: 20,             // waiting for one player
  maxReports: 5000,                // oldest dropped first
  reportCooldownMs: 24 * 3600 * 1000,
  maxNote: 300
};

const ID = /^[\x21-\x7e]{1,64}$/;
const validId = (v) => typeof v === "string" && ID.test(v);
const shortText = (v, max) => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max) : "");

class RecentPlayers {
  // file: recent-players.json (null: memory only, for tests of the rules).
  constructor(file, { saveDelayMs = 1000, onSaveError = () => {}, now = Date.now, options = {} } = {}) {
    this.file = file;
    this.now = now;
    this.options = Object.assign({}, DEFAULTS, options);
    this.users = Object.create(null);   // userID -> { recent: [entry], blocked: [userID], privacy }
    this.reports = [];
    this.load();
    this.store = file ? new CoalescedJsonFile(file, () => JSON.stringify({ version: 1, users: this.users, reports: this.reports }),
      { delayMs: saveDelayMs, onError: onSaveError, now }) : null;
    this.joinRequests = new Map();      // request id -> { id, from, to, at }
    this.sent = new Map();              // "kind|from|to" -> when (pair cooldowns)
  }

  load() {
    if (!this.file) return;
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return;
      const keep = this.file + ".unreadable-" + Date.now();
      try { fs.copyFileSync(this.file, keep); } catch { /* nothing to keep */ }
      console.error("recent-players.json could not be read (" + e.message + "); a copy is at " + keep);
      return;
    }
    const users = saved && saved.users && typeof saved.users === "object" ? saved.users : {};
    for (const [id, u] of Object.entries(users)) {
      if (!validId(id) || !u || typeof u !== "object") continue;
      const recent = (Array.isArray(u.recent) ? u.recent : []).map(cleanEntry).filter(Boolean);
      recent.sort((a, b) => b.playedAt - a.playedAt);
      this.users[id] = {
        recent: recent.slice(0, this.options.limit),
        blocked: (Array.isArray(u.blocked) ? u.blocked : []).filter(validId).slice(0, this.options.maxBlocked),
        privacy: PRIVACY.includes(u.privacy) ? u.privacy : null
      };
    }
    this.reports = (saved && Array.isArray(saved.reports) ? saved.reports : []).filter((r) => r && typeof r === "object" && r.id)
      .slice(-this.options.maxReports);
  }

  save() { if (this.store) this.store.markDirty(); }
  flushSync() { return this.store ? this.store.flushSync() : false; }
  close() { return this.store ? this.store.close() : false; }

  user(id) {
    if (!this.users[id]) this.users[id] = { recent: [], blocked: [], privacy: null };
    return this.users[id];
  }

  peek(id) { return this.users[id] || { recent: [], blocked: [], privacy: null }; }

  // ------------------------------------------------------------ recording

  // THE recording hook: the players of one match, as the server confirmed
  // them. match: { matchId, playlist, map, at, source: "lobby" | "match",
  // participants: [{ userID, name, partyId?, team? }] }. Every pair is
  // recorded both ways (the latest kept); returns how many entries were
  // written. Fewer than two distinct players: nothing.
  recordMatch(match) {
    if (!match || typeof match !== "object") return 0;
    const source = SOURCES.includes(match.source) ? match.source : "lobby";
    const at = Number.isFinite(match.at) ? match.at : this.now();
    const seen = new Set();
    const people = [];
    for (const p of Array.isArray(match.participants) ? match.participants : []) {
      if (!p || !validId(p.userID) || seen.has(p.userID)) continue;
      seen.add(p.userID);
      people.push({ userID: p.userID, name: shortText(p.name, 40) || "Player", partyId: validId(p.partyId) ? p.partyId : null,
        team: Number.isInteger(p.team) ? p.team : null });
    }
    if (people.length < 2) return 0;
    let n = 0;
    for (const a of people) {
      for (const b of people) {
        if (a === b) continue;
        this.add(a.userID, {
          with: b.userID, name: b.name, relation: relationOf(a, b, source),
          playlist: shortText(match.playlist, 32) || null, map: shortText(match.map, 32) || null,
          matchId: validId(match.matchId) ? match.matchId : null, source, playedAt: at, lastInteraction: at
        });
        n++;
      }
    }
    this.save();
    return n;
  }

  // One entry for `id`: replaces any earlier entry for the same player (the
  // latest is kept), newest first, trimmed to the limit.
  add(id, entry) {
    const u = this.user(id);
    const i = u.recent.findIndex((e) => e.with === entry.with);
    if (i >= 0) {
      const old = u.recent[i];
      u.recent.splice(i, 1);
      if (old.playedAt > entry.playedAt) { u.recent.splice(i, 0, old); return; }   // an older match arriving late
      entry.lastInteraction = Math.max(entry.lastInteraction, old.lastInteraction || 0);
    }
    let j = 0;
    while (j < u.recent.length && u.recent[j].playedAt > entry.playedAt) j++;
    u.recent.splice(j, 0, entry);
    if (u.recent.length > this.options.limit) u.recent.length = this.options.limit;
  }

  // `id`'s entries, newest first (copies).
  list(id) { return this.peek(id).recent.map((e) => Object.assign({}, e)); }

  entry(id, other) {
    const e = this.peek(id).recent.find((x) => x.with === other);
    return e ? Object.assign({}, e) : null;
  }

  // `id` did something with `other` from the list (a friend request, an
  // invite, a join request): their entry's last interaction is now.
  touch(id, other) {
    const e = this.peek(id).recent.find((x) => x.with === other);
    if (!e) return false;
    e.lastInteraction = this.now();
    this.save();
    return true;
  }

  // `id` takes `other` off their own list (the other keeps theirs).
  remove(id, other) {
    const u = this.peek(id);
    const i = u.recent.findIndex((x) => x.with === other);
    if (i < 0) return { error: "not-recent" };
    u.recent.splice(i, 1);
    this.save();
    return { ok: true };
  }

  // Everything about a player who is gone for good (an operator deleting or
  // banning an account): their own lists, and their entries in everyone
  // else's. Reports about them are kept for the operator.
  purge(id) {
    let changed = !!this.users[id];
    delete this.users[id];
    for (const u of Object.values(this.users)) {
      const before = u.recent.length;
      u.recent = u.recent.filter((e) => e.with !== id);
      if (u.recent.length !== before) changed = true;
    }
    this.dropJoinRequests(id);
    if (changed) this.save();
    return changed;
  }

  // ------------------------------------------------------------ blocks

  block(id, other) {
    if (id === other) return { error: "self" };
    const u = this.user(id);
    if (u.blocked.includes(other)) return { ok: true, already: true };
    if (u.blocked.length >= this.options.maxBlocked) return { error: "too-many-blocked" };
    u.blocked.push(other);
    this.dropJoinRequests(id, other);
    this.save();
    return { ok: true };
  }

  unblock(id, other) {
    const u = this.peek(id);
    const i = u.blocked.indexOf(other);
    if (i < 0) return { error: "not-blocked" };
    u.blocked.splice(i, 1);
    this.save();
    return { ok: true };
  }

  hasBlocked(id, other) { return this.peek(id).blocked.includes(other); }
  blockedEitherWay(a, b) { return this.hasBlocked(a, b) || this.hasBlocked(b, a); }
  blockedBy(id) { return this.peek(id).blocked.slice(); }

  // ------------------------------------------------------------ privacy

  privacy(id) { return this.peek(id).privacy || this.options.privacy; }

  setPrivacy(id, value) {
    if (!PRIVACY.includes(value)) return { error: "invalid-setting" };
    this.user(id).privacy = value;
    this.save();
    return { ok: true, join: value };
  }

  // Whether `to`'s setting lets `from` invite them or ask to join their
  // party. friends: whether the two are friends. A block, either way, never.
  allows(to, from, friends) {
    if (to === from || this.blockedEitherWay(to, from)) return false;
    const p = this.privacy(to);
    if (p === "everyone") return true;
    if (p === "nobody") return false;
    if (friends) return true;
    return p === "recent" && !!this.peek(to).recent.find((e) => e.with === from);
  }

  // ------------------------------------------------------------ join requests

  expire() {
    const t = this.now();
    for (const [id, r] of this.joinRequests) if (t - r.at > this.options.requestTtlMs) this.joinRequests.delete(id);
  }

  // `from` asks to join `to`'s party (the server checked they may).
  requestJoin(from, to) {
    if (from === to) return { error: "self" };
    this.expire();
    let waiting = 0;
    for (const r of this.joinRequests.values()) {
      if (r.from === from && r.to === to) return { error: "already-requested" };
      if (r.to === to) waiting++;
    }
    if (waiting >= this.options.maxJoinRequests) return { error: "too-many-requests" };
    const id = crypto.randomBytes(6).toString("hex");
    this.joinRequests.set(id, { id, from, to, at: this.now() });
    return { ok: true, id };
  }

  // Requests waiting for `to`, newest first.
  joinRequestsFor(to) {
    this.expire();
    const out = [];
    for (const r of this.joinRequests.values()) if (r.to === to) out.push(Object.assign({}, r));
    return out.reverse();
  }

  joinRequestFrom(from, to) {
    this.expire();
    for (const r of this.joinRequests.values()) if (r.from === from && r.to === to) return Object.assign({}, r);
    return null;
  }

  // `to` answers request `id`: it is taken (gone either way). null: no such
  // open request for them.
  takeJoinRequest(to, id) {
    this.expire();
    const r = typeof id === "string" ? this.joinRequests.get(id) : null;
    if (!r || r.to !== to) return null;
    this.joinRequests.delete(id);
    return r;
  }

  // Requests between `a` and `b` either way (or every request of `a`'s).
  dropJoinRequests(a, b) {
    let n = 0;
    for (const [id, r] of this.joinRequests) {
      const hit = b === undefined ? r.from === a || r.to === a : (r.from === a && r.to === b) || (r.from === b && r.to === a);
      if (hit) { this.joinRequests.delete(id); n++; }
    }
    return n;
  }

  // ------------------------------------------------------------ pair cooldowns

  // ms until `from` may send `kind` to `to` again (0: now).
  coolingDown(kind, from, to) {
    const last = this.sent.get(kind + "|" + from + "|" + to);
    if (last === undefined) return 0;
    return Math.max(0, this.options.pairCooldownMs - (this.now() - last));
  }

  markSent(kind, from, to) {
    if (this.sent.size >= 50000) {
      const t = this.now();
      for (const [k, at] of this.sent) if (t - at >= this.options.pairCooldownMs) this.sent.delete(k);
      if (this.sent.size >= 50000) this.sent.clear();
    }
    this.sent.set(kind + "|" + from + "|" + to, this.now());
  }

  // ------------------------------------------------------------ reports

  // A report for the operator (GET /admin/reports). Nothing happens to the
  // reported player automatically. One per pair per day.
  report({ from, fromName, about, aboutName, reason, note, context }) {
    if (from === about) return { error: "self" };
    if (!REPORT_REASONS.includes(reason)) return { error: "invalid-reason" };
    const t = this.now();
    for (let i = this.reports.length - 1; i >= 0; i--) {
      const r = this.reports[i];
      if (t - r.at > this.options.reportCooldownMs) break;
      if (r.from.userID === from && r.about.userID === about) return { error: "already-reported" };
    }
    const r = {
      id: crypto.randomBytes(6).toString("hex"), at: t,
      from: { userID: from, username: shortText(fromName, 40) || null },
      about: { userID: about, username: shortText(aboutName, 40) || null },
      reason, note: shortText(note, this.options.maxNote),
      context: context && typeof context === "object" ? {
        relation: RELATIONS.includes(context.relation) ? context.relation : null,
        playlist: shortText(context.playlist, 32) || null, map: shortText(context.map, 32) || null,
        matchId: validId(context.matchId) ? context.matchId : null,
        playedAt: Number.isFinite(context.playedAt) ? context.playedAt : null
      } : null,
      status: "open"
    };
    this.reports.push(r);
    if (this.reports.length > this.options.maxReports) this.reports.splice(0, this.reports.length - this.options.maxReports);
    this.save();
    return { ok: true, id: r.id };
  }

  listReports() { return this.reports.map((r) => JSON.parse(JSON.stringify(r))); }

  stats() {
    let entries = 0;
    for (const u of Object.values(this.users)) entries += u.recent.length;
    return { users: Object.keys(this.users).length, entries, joinRequests: this.joinRequests.size, reports: this.reports.length };
  }
}

// How `b` relates to `a` in one match.
function relationOf(a, b, source) {
  if (a.partyId && a.partyId === b.partyId) return "party";
  if (a.team !== null && b.team !== null) return a.team === b.team ? "team" : "opponent";
  return source === "match" ? "match" : "lobby";
}

function cleanEntry(e) {
  if (!e || typeof e !== "object" || !validId(e.with) || !Number.isFinite(e.playedAt)) return null;
  return {
    with: e.with, name: shortText(e.name, 40) || "Player",
    relation: RELATIONS.includes(e.relation) ? e.relation : "lobby",
    playlist: shortText(e.playlist, 32) || null, map: shortText(e.map, 32) || null,
    matchId: validId(e.matchId) ? e.matchId : null, source: SOURCES.includes(e.source) ? e.source : "lobby",
    playedAt: e.playedAt, lastInteraction: Number.isFinite(e.lastInteraction) ? e.lastInteraction : e.playedAt
  };
}

module.exports = { RecentPlayers, PRIVACY, RELATIONS, REPORT_REASONS, DEFAULTS };
