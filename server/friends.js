// Friends and parties.
//
// Friends are accounts linked both ways: a request by username, accepted by
// the other player (a request to someone who already asked you is accepted at
// once). Kept by userID in friends.json, with when each player was last seen
// online. Parties live in memory: a leader invites friends (up to `maxParty`
// players), the invited accept or decline, anyone can leave; when the leader
// leaves, the next member leads; a party of one is dropped.
"use strict";

const fs = require("fs");
const crypto = require("crypto");
const { CoalescedJsonFile } = require("./store");

const LIMITS = { maxFriends: 200, maxPending: 50, maxParty: 4, inviteTtlMs: 5 * 60 * 1000 };

class Friends {
  // file: friends.json (null: memory only, for tests of the rules).
  constructor(file, { saveDelayMs = 1000, onSaveError = () => {}, now = Date.now, limits = {} } = {}) {
    this.file = file;
    this.now = now;
    this.limits = Object.assign({}, LIMITS, limits);
    this.users = Object.create(null);     // userID -> { friends: [], incoming: [], outgoing: [], seen }
    this.load();
    this.store = file ? new CoalescedJsonFile(file, () => JSON.stringify({ version: 1, users: this.users }),
      { delayMs: saveDelayMs, onError: onSaveError, now }) : null;
    // Parties (not saved: they end when the server restarts).
    this.parties = new Map();              // party id -> { id, leader, members: [userID] }
    this.partyOf = new Map();              // userID -> party id
    this.invites = new Map();              // invited userID -> Map(party id -> { from, at })
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
      console.error("friends.json could not be read (" + e.message + "); a copy is at " + keep);
      return;
    }
    const users = saved && saved.users && typeof saved.users === "object" ? saved.users : {};
    const ids = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === "string") : []);
    for (const [id, u] of Object.entries(users)) {
      if (!u || typeof u !== "object") continue;
      this.users[id] = { friends: ids(u.friends), incoming: ids(u.incoming), outgoing: ids(u.outgoing),
        seen: Number.isFinite(u.seen) ? u.seen : null };
    }
  }

  save() { if (this.store) this.store.markDirty(); }
  flushSync() { return this.store ? this.store.flushSync() : false; }
  close() { return this.store ? this.store.close() : false; }

  user(id) {
    if (!this.users[id]) this.users[id] = { friends: [], incoming: [], outgoing: [], seen: null };
    return this.users[id];
  }

  peek(id) { return this.users[id] || { friends: [], incoming: [], outgoing: [], seen: null }; }
  areFriends(a, b) { return this.peek(a).friends.includes(b); }
  friendsOf(id) { return this.peek(id).friends.slice(); }

  seen(id) {
    this.user(id).seen = this.now();
    this.save();
  }

  // ------------------------------------------------------------ friends

  // A friend request from `from` to `to` (both userIDs of accounts).
  request(from, to) {
    if (from === to) return { error: "self" };
    const a = this.user(from), b = this.user(to);
    if (a.friends.includes(to)) return { error: "already-friends" };
    if (a.incoming.includes(to)) return this.accept(from, to);       // they asked first
    if (a.outgoing.includes(to)) return { error: "already-requested" };
    if (a.friends.length >= this.limits.maxFriends || b.friends.length >= this.limits.maxFriends) return { error: "too-many-friends" };
    if (a.outgoing.length >= this.limits.maxPending || b.incoming.length >= this.limits.maxPending) return { error: "too-many-requests" };
    a.outgoing.push(to);
    b.incoming.push(from);
    this.save();
    return { ok: true, state: "requested" };
  }

  // `id` accepts the request from `from`.
  accept(id, from) {
    const a = this.user(id), b = this.user(from);
    if (!a.incoming.includes(from)) return { error: "no-request" };
    if (a.friends.length >= this.limits.maxFriends || b.friends.length >= this.limits.maxFriends) return { error: "too-many-friends" };
    drop(a.incoming, from); drop(b.outgoing, id);
    drop(a.outgoing, from); drop(b.incoming, id);
    if (!a.friends.includes(from)) a.friends.push(from);
    if (!b.friends.includes(id)) b.friends.push(id);
    this.save();
    return { ok: true, state: "friends" };
  }

  // `id` declines `from`'s request, or cancels their own request to `from`.
  decline(id, from) {
    const a = this.user(id), b = this.user(from);
    const had = drop(a.incoming, from) | drop(b.outgoing, id) | drop(a.outgoing, from) | drop(b.incoming, id);
    if (!had) return { error: "no-request" };
    this.save();
    return { ok: true };
  }

  remove(id, other) {
    const a = this.user(id), b = this.user(other);
    if (!a.friends.includes(other)) return { error: "not-friends" };
    drop(a.friends, other); drop(b.friends, id);
    this.save();
    return { ok: true };
  }

  // ------------------------------------------------------------ parties

  party(id) {
    const pid = this.partyOf.get(id);
    return pid ? this.parties.get(pid) : null;
  }

  // Invites still open for `id`: [{ partyId, from }], newest first.
  invitesFor(id) {
    const m = this.invites.get(id);
    if (!m) return [];
    const out = [];
    for (const [partyId, inv] of m) {
      if (this.now() - inv.at > this.limits.inviteTtlMs || !this.parties.has(partyId)) { m.delete(partyId); continue; }
      out.push({ partyId, from: inv.from });
    }
    return out.reverse();
  }

  // `from` invites friend `to` to their party (made now if they have none).
  invite(from, to) {
    if (from === to) return { error: "self" };
    if (!this.areFriends(from, to)) return { error: "not-friends" };
    let p = this.party(from);
    if (p && p.members.includes(to)) return { error: "already-in-party" };
    if (p && p.members.length >= this.limits.maxParty) return { error: "party-full" };
    if (!p) {
      p = { id: crypto.randomBytes(6).toString("hex"), leader: from, members: [from] };
      this.parties.set(p.id, p);
      this.partyOf.set(from, p.id);
    }
    if (!this.invites.has(to)) this.invites.set(to, new Map());
    const m = this.invites.get(to);
    m.delete(p.id);
    m.set(p.id, { from, at: this.now() });
    return { ok: true, partyId: p.id };
  }

  // `id` joins the party that invited them (leaving any other party first).
  acceptInvite(id, partyId) {
    const m = this.invites.get(id);
    const inv = m && m.get(partyId);
    const p = this.parties.get(partyId);
    if (!inv || !p || this.now() - inv.at > this.limits.inviteTtlMs) {
      if (m) m.delete(partyId);
      return { error: "no-invite" };
    }
    if (p.members.length >= this.limits.maxParty) return { error: "party-full" };
    m.delete(partyId);
    const left = this.leave(id);
    p.members.push(id);
    this.partyOf.set(id, p.id);
    return { ok: true, party: p, left };
  }

  declineInvite(id, partyId) {
    const m = this.invites.get(id);
    if (!m || !m.delete(partyId)) return { error: "no-invite" };
    const p = this.parties.get(partyId);
    if (p && p.members.length === 1 && !this.pendingFor(p.id)) this.disband(p);   // nobody else joined or is asked
    return { ok: true, party: p || null };
  }

  // `id` leaves their party. Returns the party they left (null if none).
  leave(id) {
    const p = this.party(id);
    if (!p) return null;
    drop(p.members, id);
    this.partyOf.delete(id);
    if (p.leader === id) p.leader = p.members[0] || null;
    if (p.members.length <= 1 && !this.pendingFor(p.id)) this.disband(p);
    return p;
  }

  pendingFor(partyId) {
    for (const m of this.invites.values()) if (m.has(partyId)) return true;
    return false;
  }

  disband(p) {
    for (const id of p.members) this.partyOf.delete(id);
    p.members = [];
    this.parties.delete(p.id);
    for (const m of this.invites.values()) m.delete(p.id);
  }

  stats() { return { users: Object.keys(this.users).length, parties: this.parties.size }; }
}

function drop(list, x) {
  const i = list.indexOf(x);
  if (i < 0) return 0;
  list.splice(i, 1);
  return 1;
}

module.exports = { Friends, LIMITS };
