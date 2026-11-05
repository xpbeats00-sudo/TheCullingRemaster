// Who is asking: login tokens, match tickets, client addresses and rate
// limits for the shared (VPS) server.
//
// - Tokens: issued by /api/login, persisted so a server restart doesn't log
//   every player out, and required for socket login and the menu's HTTP calls.
//   Bounded: a player keeps their newest MAX_TOKENS_PER_USER tokens, and the
//   whole table at most MAX_TOKENS (oldest dropped first).
// - Match tickets: a match started by a player's menu opens one ticket; the
//   in-match HUD (which has no token) reports its result against it. The
//   ticket is found by token when there is one, else by the client's address
//   when exactly one player there has an open match. Each ticket pays once.
// - Rate limits: a token bucket per client address.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const { CoalescedJsonFile } = require("./store");

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const TICKET_TTL_MS = 3 * 3600 * 1000;
const RECENT_TTL_MS = 15 * 60 * 1000;
const MAX_TOKENS_PER_USER = 8;
const MAX_TOKENS = 100000;
const PRUNE_EVERY_MS = 60 * 1000;

class Sessions {
  // opts.saveDelayMs: 0 writes on every change (synchronously); the server
  // passes 1000 to coalesce writes (see store.js).
  constructor(file, now = Date.now, opts = {}) {
    this.file = file;
    this.now = now;
    this.tokens = new Map();        // token -> { userID, at }, oldest first
    this.byUser = new Map();        // userID -> [token, ...], oldest first
    let saved = {};
    try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet */ }
    const entries = Object.entries(saved && typeof saved === "object" ? saved : {})
      .filter(([, s]) => s && typeof s.userID === "string" && Number.isFinite(s.at))
      .sort((a, b) => a[1].at - b[1].at);
    for (const [t, s] of entries) this.add(t, { userID: s.userID, at: s.at });
    this.store = file ? new CoalescedJsonFile(file, () => JSON.stringify(Object.fromEntries(this.tokens)),
      { delayMs: opts.saveDelayMs || 0, onError: opts.onSaveError, now }) : null;
    this.lastPrune = 0;
    this.prune();
  }

  add(token, s) {
    this.tokens.set(token, s);
    let list = this.byUser.get(s.userID);
    if (!list) this.byUser.set(s.userID, (list = []));
    list.push(token);
    while (list.length > MAX_TOKENS_PER_USER) this.remove(list[0]);
    while (this.tokens.size > MAX_TOKENS) this.remove(this.tokens.keys().next().value);
  }

  remove(token) {
    const s = this.tokens.get(token);
    if (!s) return;
    this.tokens.delete(token);
    const list = this.byUser.get(s.userID);
    if (list) {
      const i = list.indexOf(token);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.byUser.delete(s.userID);
    }
  }

  prune() {
    this.lastPrune = this.now();
    const cutoff = this.now() - TOKEN_TTL_MS;
    let changed = false;
    // Map order is issue order, so expired tokens are at the front.
    for (const [t, s] of this.tokens) {
      if (s.at >= cutoff) break;
      this.remove(t);
      changed = true;
    }
    return changed;
  }

  save() {
    if (this.store) this.store.markDirty();
  }

  flushSync() {
    return this.store ? this.store.flushSync() : false;
  }

  issue(userID) {
    const token = crypto.randomBytes(24).toString("hex");
    this.add(token, { userID, at: this.now() });
    if (this.now() - this.lastPrune > PRUNE_EVERY_MS) this.prune();
    this.save();
    return token;
  }

  userFor(token) {
    const s = typeof token === "string" ? this.tokens.get(token) : null;
    if (!s || s.at < this.now() - TOKEN_TTL_MS) return null;
    return s.userID;
  }

  // Ends every game session of a player (a password reset); returns how many.
  revokeUser(userID) {
    const list = (this.byUser.get(userID) || []).slice();
    for (const t of list) this.remove(t);
    if (list.length) this.save();
    return list.length;
  }

  get size() { return this.tokens.size; }
}

class MatchTickets {
  // file: where open tickets are kept, so a server restart (every deploy)
  // doesn't lose the matches being played; null keeps them in memory only.
  constructor(now = Date.now, file = null, opts = {}) {
    this.now = now;
    this.open = new Map();          // userID -> { id, userID, ip, startedAt, ...info }
    this.recent = new Map();        // ip -> { userID, at } of the last paid result
    this.store = null;
    if (file) {
      let saved = [];
      try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet */ }
      const cutoff = this.now() - TICKET_TTL_MS;
      (Array.isArray(saved) ? saved : [])
        .filter((t) => t && typeof t.userID === "string" && typeof t.id === "string" && Number.isFinite(t.startedAt) && t.startedAt >= cutoff)
        .sort((a, b) => a.startedAt - b.startedAt)
        .forEach((t) => this.open.set(t.userID, t));
      this.store = new CoalescedJsonFile(file, () => JSON.stringify([...this.open.values()]),
        { delayMs: opts.saveDelayMs || 0, onError: opts.onSaveError, now });
    }
  }

  save() {
    if (this.store) this.store.markDirty();
  }

  flushSync() {
    return this.store ? this.store.flushSync() : false;
  }

  // info: what the result needs to know about the match (map, mode, and the
  // ranked match it is, if any).
  start(userID, ip, info = {}) {
    this.expire();
    const t = Object.assign({}, info, { id: crypto.randomBytes(8).toString("hex"), userID, ip, startedAt: this.now() });
    this.open.delete(userID);       // re-insert so the Map stays oldest-first
    this.open.set(userID, t);       // a new match replaces an unfinished one
    this.save();
    return t;
  }

  expire() {
    const cutoff = this.now() - TICKET_TTL_MS;
    for (const [u, t] of this.open) { if (t.startedAt >= cutoff) break; this.open.delete(u); this.save(); }
    const recentCutoff = this.now() - RECENT_TTL_MS;
    for (const [ip, r] of this.recent) { if (r.at >= recentCutoff) break; this.recent.delete(ip); }
  }

  // Take the ticket for a result: by userID (token) or by address. When
  // several players share the address (a household, a LAN), `pick` (a test on
  // a ticket, e.g. "this player's name is the one the HUD sent") chooses.
  claim({ userID, ip, pick }) {
    this.expire();
    let t = null;
    if (userID) {
      t = this.open.get(userID) || null;
      if (!t) return { error: "no-match" };
    } else {
      const mine = [...this.open.values()].filter((x) => x.ip === ip);
      if (mine.length > 1 && pick) {
        const chosen = mine.filter(pick);
        if (chosen.length === 1) t = chosen[0];
        else return { error: "ambiguous" };
      } else if (mine.length > 1) {
        return { error: "ambiguous" };
      } else {
        t = mine[0] || null;
      }
      if (!t) return { error: "no-match" };
    }
    this.open.delete(t.userID);
    this.save();
    this.recent.delete(ip);         // re-insert so the Map stays oldest-first
    this.recent.set(ip, { userID: t.userID, at: this.now() });
    return { ticket: t, elapsed: (this.now() - t.startedAt) / 1000 };
  }

  // Drops a player's open ticket that has been running for more than graceMs
  // (the menu logged in again: that match ended without a result, by a quit
  // or a crash), so a later Survival or Training result can't claim it.
  // Returns the dropped ticket.
  abandon(userID, graceMs) {
    const t = this.open.get(userID);
    if (!t || this.now() - t.startedAt < graceMs) return null;
    this.open.delete(userID);
    this.save();
    return t;
  }

  // The open ticket for a player (by userID, or the only one from an address),
  // without taking it: the HUD asking about the match it is in.
  peek({ userID, ip }) {
    this.expire();
    if (userID) return this.open.get(userID) || null;
    const mine = [...this.open.values()].filter((x) => x.ip === ip);
    return mine.length === 1 ? mine[0] : null;
  }

  // The player whose result was last paid from this address (the HUD's
  // follow-up /api/setlevel), within 15 minutes.
  recentUser(ip) {
    const r = this.recent.get(ip);
    return r && r.at > this.now() - RECENT_TTL_MS ? r.userID : null;
  }
}

// Token bucket per key: `rate` requests per second, bursts up to `burst`.
// Idle buckets (refilled to full) carry no state worth keeping, so once there
// are more than `maxKeys` they are swept; only if every bucket is busy is the
// table cleared.
function rateLimiter(rate, burst, now = Date.now, maxKeys = 50000) {
  const buckets = new Map();
  const fullAfterMs = (burst / rate) * 1000;
  function allow(key) {
    const t = now();
    let b = buckets.get(key);
    if (!b) {
      if (buckets.size >= maxKeys) {
        for (const [k, x] of buckets) if (t - x.at >= fullAfterMs) buckets.delete(k);
        if (buckets.size >= maxKeys) buckets.clear();
      }
      b = { tokens: burst, at: t };
      buckets.set(key, b);
    }
    b.tokens = Math.min(burst, b.tokens + (t - b.at) / 1000 * rate);
    b.at = t;
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  }
  allow.size = () => buckets.size;
  // Give back one request (e.g. a password attempt that turned out right:
  // only failures should count against a failure limit).
  allow.refund = (key) => {
    const b = buckets.get(key);
    if (b) b.tokens = Math.min(burst, b.tokens + 1);
  };
  return allow;
}

// The client's address. Behind the local reverse proxy (Caddy) the request
// comes from loopback, and the proxy's X-Forwarded-For names the client.
function isLoopback(remote) {
  const ip = String(remote || "").replace(/^::ffff:/, "");
  return ip === "127.0.0.1" || ip === "::1";
}

function clientIp(remote, forwarded) {
  const ip = String(remote || "").replace(/^::ffff:/, "");
  if (isLoopback(ip) && forwarded) return String(forwarded).split(",").pop().trim().slice(0, 64);
  return ip;
}

module.exports = { Sessions, MatchTickets, rateLimiter, clientIp, isLoopback, TOKEN_TTL_MS, TICKET_TTL_MS,
  MAX_TOKENS_PER_USER, MAX_TOKENS };
