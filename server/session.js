// Who is asking: login tokens, match tickets, client addresses and rate
// limits for the shared (VPS) server.
//
// - Tokens: issued by /api/login, persisted so a server restart doesn't log
//   every player out, and required for socket login and the menu's HTTP calls.
// - Match tickets: a match started by a player's menu opens one ticket; the
//   in-match HUD (which has no token) reports its result against it. The
//   ticket is found by token when there is one, else by the client's address
//   when exactly one player there has an open match. Each ticket pays once.
// - Rate limits: a token bucket per client address.
"use strict";

const fs = require("fs");
const crypto = require("crypto");

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const TICKET_TTL_MS = 3 * 3600 * 1000;

class Sessions {
  constructor(file, now = Date.now) {
    this.file = file;
    this.now = now;
    this.tokens = {};
    try { this.tokens = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet */ }
    this.prune();
  }

  prune() {
    const cutoff = this.now() - TOKEN_TTL_MS;
    for (const [t, s] of Object.entries(this.tokens)) if (s.at < cutoff) delete this.tokens[t];
  }

  save() {
    if (!this.file) return;
    const tmp = this.file + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(this.tokens));
    fs.renameSync(tmp, this.file);
  }

  issue(userID) {
    const token = crypto.randomBytes(24).toString("hex");
    this.tokens[token] = { userID, at: this.now() };
    this.prune();
    this.save();
    return token;
  }

  userFor(token) {
    const s = typeof token === "string" && Object.prototype.hasOwnProperty.call(this.tokens, token) ? this.tokens[token] : null;
    if (!s || s.at < this.now() - TOKEN_TTL_MS) return null;
    return s.userID;
  }
}

class MatchTickets {
  constructor(now = Date.now) {
    this.now = now;
    this.open = new Map();          // userID -> { id, userID, ip, startedAt }
    this.recent = new Map();        // ip -> { userID, at } of the last paid result
  }

  start(userID, ip) {
    const t = { id: crypto.randomBytes(8).toString("hex"), userID, ip, startedAt: this.now() };
    this.open.set(userID, t);       // a new match replaces an unfinished one
    return t;
  }

  expire() {
    const cutoff = this.now() - TICKET_TTL_MS;
    for (const [u, t] of this.open) if (t.startedAt < cutoff) this.open.delete(u);
  }

  // Take the ticket for a result: by userID (token) or by address.
  claim({ userID, ip }) {
    this.expire();
    let t = null;
    if (userID) {
      t = this.open.get(userID) || null;
      if (!t) return { error: "no-match" };
    } else {
      const here = [...this.open.values()].filter((x) => x.ip === ip);
      if (here.length === 0) return { error: "no-match" };
      if (here.length > 1) return { error: "ambiguous" };
      t = here[0];
    }
    this.open.delete(t.userID);
    this.recent.set(ip, { userID: t.userID, at: this.now() });
    return { ticket: t, elapsed: (this.now() - t.startedAt) / 1000 };
  }

  // The player whose result was last paid from this address (the HUD's
  // follow-up /api/setlevel), within 15 minutes.
  recentUser(ip) {
    const r = this.recent.get(ip);
    return r && r.at > this.now() - 15 * 60 * 1000 ? r.userID : null;
  }
}

// Token bucket per key: `rate` requests per second, bursts up to `burst`.
function rateLimiter(rate, burst, now = Date.now) {
  const buckets = new Map();
  return function allow(key) {
    const t = now();
    let b = buckets.get(key);
    if (!b) { b = { tokens: burst, at: t }; buckets.set(key, b); }
    b.tokens = Math.min(burst, b.tokens + (t - b.at) / 1000 * rate);
    b.at = t;
    if (buckets.size > 50000) buckets.clear();
    if (b.tokens < 1) return false;
    b.tokens -= 1;
    return true;
  };
}

// The client's address. Behind the local reverse proxy (Caddy) the request
// comes from loopback, and the proxy's X-Forwarded-For names the client.
function clientIp(remote, forwarded) {
  const ip = String(remote || "").replace(/^::ffff:/, "");
  const loopback = ip === "127.0.0.1" || ip === "::1";
  if (loopback && forwarded) return String(forwarded).split(",").pop().trim();
  return ip;
}

module.exports = { Sessions, MatchTickets, rateLimiter, clientIp, TOKEN_TTL_MS, TICKET_TTL_MS };
