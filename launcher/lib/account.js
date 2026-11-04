// Remaster accounts: creating one and signing in with the account server, and
// the saved sign-in.
//
// The username is also the in-game name. Before PLAY the launcher asks the
// server for a play grant (POST /api/account/play), which lets the game log
// in as the account's Steam ID from this connection; the launcher then writes
// that ID and the username where the game's Steam layer reads them
// (lib/playername.js). The password never leaves this module except to the
// server over HTTPS, and is never stored: only the server's sign-in token is,
// encrypted with Windows' DPAPI (Electron's safeStorage).
"use strict";

const fs = require("fs");
const path = require("path");

// The same rules as the server (it checks again).
function checkUsername(raw) {
  const name = String(raw == null ? "" : raw).replace(/\s+/g, " ").trim();
  if (name.length < 2 || name.length > 20) return { error: "Usernames are 2 to 20 characters" };
  if (!/^[A-Za-z0-9_.\- ]+$/.test(name)) return { error: "Use letters, numbers, spaces and _ . -" };
  return { name };
}

function checkEmail(raw) {
  const email = String(raw == null ? "" : raw).trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@.]{2,}$/.test(email)) return { error: "Enter a valid email address" };
  return { email };
}

function checkPassword(raw) {
  const password = String(raw == null ? "" : raw);
  if (password.length < 8) return { error: "Passwords are at least 8 characters" };
  if (password.length > 128) return { error: "Passwords are at most 128 characters" };
  return { password };
}

// The server's error codes, as players read them.
const MESSAGES = {
  "invalid-username": "Usernames are 2 to 20 characters: letters, numbers, spaces and _ . -",
  "username-taken": "That username is taken: choose another",
  "invalid-email": "Enter a valid email address",
  "email-taken": "That email already has an account: sign in instead",
  "weak-password": "Passwords are 8 to 128 characters",
  "wrong-credentials": "Wrong username or password",
  "too-many-attempts": "Too many attempts: wait a few minutes, then try again",
  "signed-out": "You've been signed out: sign in again",
  "server-full": "The server isn't taking new accounts right now. Try again later"
};

class AccountError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

// fetchImpl: the launcher passes Electron's net.fetch (system proxy and
// certificates); tests pass Node's fetch.
function createClient(fetchImpl, timeoutMs = 15000) {
  async function request(api, method, route, body, token) {
    const headers = { "Content-Type": "application/json" };
    if (token) headers.Authorization = "Bearer " + token;
    let res;
    try {
      res = await fetchImpl(api.replace(/\/+$/, "") + route, {
        method, headers, body: body ? JSON.stringify(body) : undefined,
        cache: "no-store", redirect: "error", signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (e) {
      throw new AccountError("Can't reach the account server. Check your internet connection, then try again.", "network");
    }
    let json = null;
    try { json = await res.json(); } catch { /* not JSON */ }
    if (res.ok && json && typeof json === "object") return json;
    const code = json && typeof json.error === "string" ? json.error : null;
    if (res.status === 401 && !code) throw new AccountError(MESSAGES["signed-out"], "signed-out");
    throw new AccountError(MESSAGES[code] || `The account server answered HTTP ${res.status}. Try again in a few minutes.`, code || "http");
  }

  // A reply that names a signed-in account.
  function signedIn(r) {
    if (!r || typeof r.token !== "string" || !r.token || typeof r.username !== "string" || !/^steam:\d{17}$/.test(r.userID)) {
      throw new AccountError("The account server sent an unexpected reply. Try again in a few minutes.", "reply");
    }
    return { username: r.username, userID: r.userID, token: r.token, claimed: !!r.claimed };
  }

  return {
    async register(api, { username, email, password, claimUserID }) {
      const u = checkUsername(username), e = checkEmail(email), p = checkPassword(password);
      const bad = u.error || e.error || p.error;
      if (bad) throw new AccountError(bad, "invalid");
      const body = { username: u.name, email: e.email, password: p.password };
      if (claimUserID) body.claimUserID = claimUserID;
      return signedIn(await request(api, "POST", "/account/register", body));
    },
    async login(api, { username, password }) {
      const u = String(username == null ? "" : username).replace(/\s+/g, " ").trim();
      if (!u || !password) throw new AccountError("Enter your username and password", "invalid");
      return signedIn(await request(api, "POST", "/account/login", { username: u, password: String(password) }));
    },
    // Right before the game starts: the server lets the game in as this account.
    async play(api, token) {
      const r = await request(api, "POST", "/account/play", {}, token);
      if (!r || !/^steam:\d{17}$/.test(r.userID) || typeof r.username !== "string") {
        throw new AccountError("The account server sent an unexpected reply. Try again in a few minutes.", "reply");
      }
      return { username: r.username, userID: r.userID };
    },
    me: (api, token) => request(api, "GET", "/account/me", null, token),
    logout: (api, token) => request(api, "POST", "/account/logout", {}, token)
  };
}

// Saved sign-ins, one per server id: { username, userID, token }. Written
// only when the OS can encrypt it; otherwise the sign-in lasts until the
// launcher closes.
function createStore(file, safeStorage) {
  let memory = {};
  const canEncrypt = () => { try { return !!(safeStorage && safeStorage.isEncryptionAvailable()); } catch { return false; } };
  function load() {
    if (!canEncrypt()) return memory;
    try {
      const all = JSON.parse(safeStorage.decryptString(fs.readFileSync(file)));
      memory = all && typeof all === "object" ? all : {};
    } catch { /* none yet, or from another Windows user: sign in again */ }
    return memory;
  }
  function save() {
    if (!canEncrypt()) return;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file + ".tmp", safeStorage.encryptString(JSON.stringify(memory)));
    fs.renameSync(file + ".tmp", file);
  }
  load();
  return {
    get(serverId) {
      const a = memory[serverId];
      return a && typeof a.token === "string" && typeof a.username === "string" && /^steam:\d{17}$/.test(a.userID) ? a : null;
    },
    set(serverId, a) { memory[serverId] = { username: a.username, userID: a.userID, token: a.token }; save(); },
    remove(serverId) { delete memory[serverId]; save(); },
    persistent: canEncrypt
  };
}

module.exports = { createClient, createStore, checkUsername, checkEmail, checkPassword, AccountError, MESSAGES };
