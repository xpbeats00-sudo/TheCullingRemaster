// Player accounts: username, email and password, the tokens the launcher signs
// in with, and the play grants that let the game itself log in.
//
// - Passwords: scrypt (N 2^15, r 8, p 1, 64-byte key, 16-byte salt), stored as
//   one string with its parameters, compared with timingSafeEqual. Hashing runs
//   on the libuv thread pool, at most SCRYPT_ACTIVE at a time (each uses 32 MB).
// - Tokens: 32 random bytes; only their sha256 is stored. 30 days, at most 8
//   per account (oldest dropped), at most MAX_TOKENS in all.
// - Play grants: the launcher asks for one right before starting the game; the
//   game's own /api/login for that account's user ID is then accepted from the
//   same address for 12 hours, extended on each game login. One per account.
// - Addresses are never stored raw: hashIp() is sha256 of a per-server secret
//   (ip-hash-secret.txt in the data folder) and the address.
// - Saved to accounts.json through CoalescedJsonFile (see store.js).
"use strict";

const crypto = require("crypto");
const os = require("os");
const fs = require("fs");
const { promisify } = require("util");
const { CoalescedJsonFile, writeAtomicSync } = require("./store");

const scryptAsync = promisify(crypto.scrypt);

const TOKEN_TTL_MS = 30 * 24 * 3600 * 1000;
const MAX_TOKENS_PER_ACCOUNT = 8;
const MAX_TOKENS = 100000;
const GRANT_TTL_MS = 12 * 3600 * 1000;
// A game login extends its grant in memory; the extension is saved at most
// this often per grant (every login rewrote accounts.json: performance review
// P5). A crash loses at most this much of a 12-hour grant's extension.
const GRANT_SAVE_EVERY_MS = 60 * 1000;
const PRUNE_EVERY_MS = 60 * 1000;

const SCRYPT = { N: 1 << 15, r: 8, p: 1, keylen: 64, saltBytes: 16, maxmem: 64 * 1024 * 1024 };
// Hashes computed at once: at most 2, and never every thread of the machine
// (a 2-core VPS keeps one for everything else: performance review P7).
const SCRYPT_ACTIVE = Math.max(1, Math.min(2, os.availableParallelism() - 1));
const SCRYPT_QUEUE = 64;            // waiting beyond that: 503 busy

const USERNAME_RE = /^[A-Za-z0-9_.\- ]+$/;
const EMAIL_RE = /^[^\s@\x00-\x1f\x7f]+@[^\s@.\x00-\x1f\x7f]+(\.[^\s@.\x00-\x1f\x7f]+)+$/;
const STEAM_ID_BASE = 76561197960265728n;

// ---------------------------------------------------------------- validation

// Trimmed, runs of spaces collapsed; null if not a valid username.
function normalizeUsername(raw) {
  if (typeof raw !== "string" || raw.length > 200) return null;
  const name = raw.trim().replace(/ {2,}/g, " ");
  if (name.length < 2 || name.length > 20 || !USERNAME_RE.test(name)) return null;
  return name;
}

// The key an account is stored under (usernames are unique ignoring case).
function usernameKey(raw) {
  const name = normalizeUsername(raw);
  return name === null ? null : name.toLowerCase();
}

function normalizeEmail(raw) {
  if (typeof raw !== "string" || raw.length > 400) return null;
  const email = raw.trim().toLowerCase();
  if (email.length > 254 || !EMAIL_RE.test(email)) return null;
  return email;
}

const validPassword = (pw) => typeof pw === "string" && pw.length >= 8 && pw.length <= 128;

const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");

// ---------------------------------------------------------------- passwords

// At most `maxActive` jobs run at once; up to `maxQueued` wait; beyond that
// the job is refused with an error whose code is "busy".
function createGate(maxActive, maxQueued) {
  let active = 0;
  const queue = [];
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) { active++; next(); }
  };
  function run(fn) {
    if (active < maxActive) {
      active++;
      return Promise.resolve().then(fn).finally(release);
    }
    if (queue.length >= maxQueued) return Promise.reject(Object.assign(new Error("busy"), { code: "busy" }));
    return new Promise((resolve, reject) => {
      queue.push(() => { Promise.resolve().then(fn).then(resolve, reject).finally(release); });
    });
  }
  run.stats = () => ({ active, queued: queue.length });
  return run;
}

const scryptGate = createGate(SCRYPT_ACTIVE, SCRYPT_QUEUE);

async function hashPassword(password) {
  const salt = crypto.randomBytes(SCRYPT.saltBytes);
  const key = await scryptGate(() => scryptAsync(String(password), salt, SCRYPT.keylen,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: SCRYPT.maxmem }));
  return ["scrypt", SCRYPT.N, SCRYPT.r, SCRYPT.p, salt.toString("base64"), key.toString("base64")].join("$");
}

// True if `password` matches `stored` (a hashPassword() string).
async function verifyPassword(password, stored) {
  const parts = typeof stored === "string" ? stored.split("$") : [];
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [N, r, p] = parts.slice(1, 4).map(Number);
  if (!Number.isInteger(N) || N < 2 || N > (1 << 20) || !Number.isInteger(r) || r < 1 || r > 32 || !Number.isInteger(p) || p < 1 || p > 16) {
    return false;
  }
  const salt = Buffer.from(parts[4], "base64");
  const expected = Buffer.from(parts[5], "base64");
  if (!expected.length) return false;
  const key = await scryptGate(() => scryptAsync(String(password), salt, expected.length,
    { N, r, p, maxmem: Math.max(SCRYPT.maxmem, 128 * N * r * 2) }));
  return crypto.timingSafeEqual(key, expected);
}

// A hash no password matches (a random one nobody knows), so an unknown
// username costs the same scrypt as a known one.
let dummyHash = null;
function dummyPasswordHash() {
  if (!dummyHash) {
    dummyHash = hashPassword(crypto.randomBytes(32).toString("hex"));
    dummyHash.catch(() => { dummyHash = null; });   // e.g. busy: try again next time
  }
  return dummyHash;
}

// A random temporary password (no look-alike characters).
function randomPassword(length = 16) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < length; i++) out += chars[crypto.randomInt(chars.length)];
  return out;
}

// A fresh Steam-style ID: the individual-account base plus a random 32-bit
// account number, e.g. "steam:76561198123456789".
function randomSteamID() {
  const n = crypto.randomBytes(4).readUInt32BE(0) || 1;
  return "steam:" + (STEAM_ID_BASE + BigInt(n)).toString();
}

const validSteamID = (id) => typeof id === "string" && /^steam:\d{17}$/.test(id);

// ---------------------------------------------------------------- store

class Accounts {
  // file: accounts.json; secretFile: the IP-hash secret (created if missing).
  constructor(file, { secretFile, now = Date.now, saveDelayMs = 0, onSaveError = () => {} } = {}) {
    this.file = file;
    this.now = now;
    this.accounts = Object.create(null);  // username key -> account
    this.byEmail = new Map();             // email -> username key
    this.byUserID = new Map();            // userID -> username key
    this.tokens = new Map();              // sha256(token) -> { u: key, at }, oldest first
    this.tokensByAccount = new Map();     // key -> [hash, ...], oldest first
    this.grants = new Map();              // userID -> { ip: hashed, until }
    this.grantSavedAt = new Map();        // userID -> when its grant was last saved (memory only)
    this.secret = secretFile ? loadSecret(secretFile) : crypto.randomBytes(32).toString("hex");
    this.load();
    this.store = file ? new CoalescedJsonFile(file, () => this.serialize(), { delayMs: saveDelayMs, onError: onSaveError, now })
      : null;
    this.lastPrune = 0;
    this.prune();
  }

  load() {
    if (!this.file) return;
    let saved;
    try {
      saved = JSON.parse(fs.readFileSync(this.file, "utf8"));
    } catch (e) {
      if (e.code === "ENOENT") return;
      // Keep an unreadable file for inspection instead of overwriting it.
      const keep = this.file + ".unreadable-" + Date.now();
      try { fs.copyFileSync(this.file, keep); } catch { /* nothing to keep */ }
      console.error("accounts.json could not be read (" + e.message + "); a copy is at " + keep);
      return;
    }
    const obj = (v) => (v && typeof v === "object" ? v : {});
    for (const [key, a] of Object.entries(obj(saved.accounts))) {
      if (!a || typeof a.username !== "string" || typeof a.userID !== "string" || typeof a.password !== "string") continue;
      this.accounts[key] = a;
      if (a.email) this.byEmail.set(a.email, key);
      this.byUserID.set(a.userID, key);
    }
    const tokens = Object.entries(obj(saved.tokens))
      .filter(([, t]) => t && typeof t.u === "string" && Number.isFinite(t.at) && this.accounts[t.u])
      .sort((a, b) => a[1].at - b[1].at);
    for (const [hash, t] of tokens) this.addToken(hash, { u: t.u, at: t.at });
    for (const [userID, g] of Object.entries(obj(saved.grants))) {
      if (g && typeof g.ip === "string" && Number.isFinite(g.until) && this.byUserID.has(userID)) this.grants.set(userID, g);
    }
  }

  serialize() {
    return JSON.stringify({ version: 1, accounts: this.accounts, tokens: Object.fromEntries(this.tokens),
      grants: Object.fromEntries(this.grants) });
  }

  save() { if (this.store) this.store.markDirty(); }
  flushSync() { return this.store ? this.store.flushSync() : false; }
  close() { return this.store ? this.store.close() : false; }

  hashIp(ip) { return sha256(this.secret + "|" + String(ip || "")).slice(0, 32); }

  get count() { return Object.keys(this.accounts).length; }

  get(key) {
    return typeof key === "string" && Object.prototype.hasOwnProperty.call(this.accounts, key) ? this.accounts[key] : null;
  }

  keyForUserID(userID) { return this.byUserID.get(userID) || null; }
  emailTaken(email) { return this.byEmail.has(email); }
  ownsUserID(userID) { return this.byUserID.has(userID); }

  create({ username, email, userID, password }) {
    const key = username.toLowerCase();
    const a = { username, email, userID, password, createdAt: this.now() };
    this.accounts[key] = a;
    this.byEmail.set(email, key);
    this.byUserID.set(userID, key);
    this.save();
    return a;
  }

  setPassword(key, hash) {
    const a = this.get(key);
    if (!a) return false;
    a.password = hash;
    a.passwordChangedAt = this.now();
    this.save();
    return true;
  }

  // ---- tokens

  addToken(hash, t) {
    this.tokens.set(hash, t);
    let list = this.tokensByAccount.get(t.u);
    if (!list) this.tokensByAccount.set(t.u, (list = []));
    list.push(hash);
    while (list.length > MAX_TOKENS_PER_ACCOUNT) this.removeToken(list[0]);
    while (this.tokens.size > MAX_TOKENS) this.removeToken(this.tokens.keys().next().value);
  }

  removeToken(hash) {
    const t = this.tokens.get(hash);
    if (!t) return false;
    this.tokens.delete(hash);
    const list = this.tokensByAccount.get(t.u);
    if (list) {
      const i = list.indexOf(hash);
      if (i >= 0) list.splice(i, 1);
      if (!list.length) this.tokensByAccount.delete(t.u);
    }
    return true;
  }

  issueToken(key) {
    const token = crypto.randomBytes(32).toString("hex");
    this.addToken(sha256(token), { u: key, at: this.now() });
    this.maybePrune();
    this.save();
    return token;
  }

  // The account a token belongs to, or null.
  accountForToken(token) {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return null;
    const t = this.tokens.get(sha256(token));
    if (!t || t.at < this.now() - TOKEN_TTL_MS) return null;
    const a = this.get(t.u);
    return a ? { key: t.u, account: a } : null;
  }

  revokeToken(token) {
    if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) return false;
    const removed = this.removeToken(sha256(token));
    if (removed) this.save();
    return removed;
  }

  revokeAll(key) {
    const list = (this.tokensByAccount.get(key) || []).slice();
    for (const hash of list) this.removeToken(hash);
    if (list.length) this.save();
    return list.length;
  }

  // ---- play grants

  grant(userID, ipHash) {
    this.grants.delete(userID);       // re-insert so the Map stays roughly oldest-first
    this.grants.set(userID, { ip: ipHash, until: this.now() + GRANT_TTL_MS });
    this.grantSavedAt.set(userID, this.now());
    this.maybePrune();
    this.save();
  }

  revokeGrant(userID) {
    this.grantSavedAt.delete(userID);
    if (this.grants.delete(userID)) this.save();
  }

  // A game login: allowed if this user ID has a live grant from this address;
  // the grant is then extended (sliding) by another GRANT_TTL_MS.
  useGrant(userID, ipHash) {
    const g = this.grants.get(userID);
    if (!g || g.until < this.now() || g.ip !== ipHash || !this.byUserID.has(userID)) return false;
    g.until = this.now() + GRANT_TTL_MS;
    if (this.now() - (this.grantSavedAt.get(userID) || 0) >= GRANT_SAVE_EVERY_MS) {
      this.grantSavedAt.set(userID, this.now());
      this.save();
    }
    return true;
  }

  // ---- housekeeping

  maybePrune() { if (this.now() - this.lastPrune > PRUNE_EVERY_MS) this.prune(); }

  prune() {
    this.lastPrune = this.now();
    let changed = false;
    const cutoff = this.now() - TOKEN_TTL_MS;
    for (const [hash, t] of this.tokens) {
      if (t.at >= cutoff) break;
      this.removeToken(hash);
      changed = true;
    }
    for (const [userID, g] of this.grants) {
      if (g.until < this.now()) { this.grants.delete(userID); changed = true; }
    }
    return changed;
  }

  // For /metrics: counts only, nothing personal.
  stats() {
    const now = this.now();
    let liveGrants = 0;
    for (const g of this.grants.values()) if (g.until >= now) liveGrants++;
    return { accounts: this.count, tokens: this.tokens.size, playGrants: liveGrants, scrypt: scryptGate.stats() };
  }
}

function loadSecret(file) {
  try {
    const s = fs.readFileSync(file, "utf8").trim();
    if (/^[0-9a-f]{64}$/.test(s)) return s;
  } catch { /* create it */ }
  const s = crypto.randomBytes(32).toString("hex");
  writeAtomicSync(file, s);
  return s;
}

module.exports = { Accounts, normalizeUsername, usernameKey, normalizeEmail, validPassword, hashPassword, verifyPassword,
  dummyPasswordHash, randomPassword, randomSteamID, validSteamID, createGate, TOKEN_TTL_MS, GRANT_TTL_MS,
  MAX_TOKENS_PER_ACCOUNT, SCRYPT, SCRYPT_ACTIVE };
