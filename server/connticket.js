// Connection tickets for shared matches (docs/PARTY_MATCHMAKING_REWORK.md).
//
// Each player sent to a shared match gets one ticket: an HMAC-SHA256 over the
// match, the player, their team, the game server and an expiry. The menu
// passes it to ConnectToServer as the serverNonce, the client puts it in its
// login URL options (?servernonce=<ticket>), and the game server checks it in
// PreLogin by asking the backend (POST /api/gameserver/verify-ticket). A
// ticket is good once, for a short time, for that player on that match's
// server only.
//
// Format (URL-option safe: [A-Za-z0-9._-] only, no '?', '=', '#' or spaces):
//   v1.<base64url(JSON claims)>.<base64url(HMAC)>
// claims: { m: matchId, u: userID, t: team, s: serverId, e: expiresAt (ms), j: ticket id }
"use strict";

const crypto = require("crypto");

const b64u = (buf) => Buffer.from(buf).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const unb64u = (s) => Buffer.from(String(s).replace(/-/g, "+").replace(/_/g, "/"), "base64");

class ConnectionTickets {
  constructor({ secret, ttlMs = 120000, now = Date.now } = {}) {
    if (!secret || String(secret).length < 16) throw new Error("connection tickets need a secret");
    this.secret = String(secret);
    this.ttlMs = ttlMs;
    this.now = now;
    this.used = new Map();        // ticket id -> expiresAt (kept until it would have expired)
    this.revoked = new Map();     // matchId -> until (every ticket of a cancelled match)
  }

  mac(body) { return b64u(crypto.createHmac("sha256", this.secret).update("v1." + body).digest()); }

  // A ticket for one player: { id, token, expiresAt }.
  issue({ matchId, userID, team, serverId }) {
    const claims = { m: matchId, u: userID, t: team, s: serverId, e: this.now() + this.ttlMs, j: crypto.randomBytes(9).toString("hex") };
    const body = b64u(JSON.stringify(claims));
    return { id: claims.j, token: "v1." + body + "." + this.mac(body), expiresAt: claims.e };
  }

  // The claims of a well-formed, correctly signed ticket, or { error }.
  // Nothing is consumed.
  read(token) {
    if (typeof token !== "string" || token.length > 1024) return { error: "malformed" };
    const parts = token.split(".");
    if (parts.length !== 3 || parts[0] !== "v1" || !/^[A-Za-z0-9_-]+$/.test(parts[1]) || !/^[A-Za-z0-9_-]+$/.test(parts[2])) return { error: "malformed" };
    const want = this.mac(parts[1]);
    const a = Buffer.from(want), b = Buffer.from(parts[2]);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return { error: "bad-signature" };
    let c;
    try { c = JSON.parse(unb64u(parts[1]).toString("utf8")); } catch { return { error: "malformed" }; }
    if (!c || typeof c.m !== "string" || typeof c.u !== "string" || typeof c.j !== "string" || !Number.isFinite(c.e)) return { error: "malformed" };
    return { claims: { matchId: c.m, userID: c.u, team: c.t, serverId: c.s, expiresAt: c.e, id: c.j } };
  }

  // The game server's check at PreLogin. expect: { matchId, serverId, userID? }
  // (userID: the player the connection claims to be, when the server knows it).
  // A ticket that passes is used up. Returns { ok, claims } or { error }.
  verify(token, expect = {}) {
    this.prune();
    const r = this.read(token);
    if (r.error) return r;
    const c = r.claims;
    if (c.expiresAt < this.now()) return { error: "expired", claims: c };
    if (this.revoked.has(c.matchId)) return { error: "revoked", claims: c };
    if (this.used.has(c.id)) return { error: "used", claims: c };
    if (expect.matchId !== undefined && c.matchId !== expect.matchId) return { error: "wrong-match", claims: c };
    if (expect.serverId !== undefined && c.serverId !== expect.serverId) return { error: "wrong-server", claims: c };
    if (expect.userID !== undefined && expect.userID !== null && c.userID !== expect.userID) return { error: "wrong-user", claims: c };
    this.used.set(c.id, c.expiresAt);
    return { ok: true, claims: c };
  }

  // Every ticket of a match stops working (the match was cancelled or is over).
  revokeMatch(matchId) { this.revoked.set(matchId, this.now() + this.ttlMs); }

  prune() {
    const t = this.now();
    for (const [id, exp] of this.used) if (exp < t) this.used.delete(id);
    for (const [m, until] of this.revoked) if (until < t) this.revoked.delete(m);
  }

  stats() { return { used: this.used.size, revokedMatches: this.revoked.size, ttlMs: this.ttlMs }; }
}

module.exports = { ConnectionTickets };
