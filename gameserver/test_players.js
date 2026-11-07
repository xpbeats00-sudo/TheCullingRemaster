// Test players for a shared match: real accounts and menu sockets on the
// backend (as server/test/sharedmatch.test.js makes them), queueing a shared
// playlist together. Each player's match-ready (game server, ticket) goes to
// <out>/tickets.json for the real game clients to join with; their
// remaster-shared-match events (finished: the paid result) go to
// <out>/finished.json.
//
// usage: node test_players.js --backend http://127.0.0.1:8123 --server-dir <backend repo>/server
//          --out <dir> [--count 2] [--queue ffa_jungle] [--wait-ms 900000]
//          [--userids steam:7656...,steam:7656...] [--parties 2,1]
// --userids: the accounts' userIDs, in order (claimed: a game login from
// the player's address first, then the account claims that profile). The
// host binds a ticket to the joining game's Steam ID, so a test whose game
// clients have fixed Steam IDs gives them here.
// --parties: the players as groups, in order ("2,1": a party of the first
// two and a solo; "2,2": two parties of 2), made real parties through the
// backend's socket API as the Friends panel does (friend request and
// accept, party invite and accept). Each party's leader queues it (the
// members follow, as with PLAY); --count is the parties' total.
"use strict";

const fs = require("fs");
const http = require("http");
const path = require("path");
const { URL } = require("url");

const arg = (name, d) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : d; };
const backend = arg("backend", "http://127.0.0.1:8123");
const out = arg("out");
const count = parseInt(arg("count", "2"), 10);
const queue = arg("queue", "ffa_jungle");
const waitMs = parseInt(arg("wait-ms", "900000"), 10);
const userids = (arg("userids", "") || "").split(",").filter(Boolean);
const parties = (arg("parties", "") || "").split(",").filter(Boolean).map((n) => parseInt(n, 10));
const total = parties.length ? parties.reduce((a, b) => a + b, 0) : count;
// The backend checkout's own socket.io-client, else one on NODE_PATH (a worktree without node_modules).
const ioClient = (() => { try { return require(path.join(arg("server-dir"), "node_modules", "socket.io-client")); } catch { return require("socket.io-client"); } })();

function log(event, fields = {}) { console.log(JSON.stringify(Object.assign({ t: new Date().toISOString(), event }, fields))); }

function request(method, p, body, headers = {}) {
  const u = new URL(p, backend);
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : "";
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method,
      headers: Object.assign({ "Content-Type": "application/json", "Content-Length": Buffer.byteLength(data) }, headers) }, (res) => {
      let s = "";
      res.on("data", (c) => (s += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(s); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    req.end(data);
  });
}

const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

// A Friends-panel action, answered with remaster-friend-result.
function act(p, event, msg) {
  const r = new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(p.name + ": no answer to " + event)), 10000);
    const on = (m) => { if (m && m.action === event) { clearTimeout(t); p.socket.off("remaster-friend-result", on); resolve(m); } };
    p.socket.on("remaster-friend-result", on);
  });
  p.socket.emit(event, msg);
  return r;
}

// leader + members: one party, as two menus would make it.
async function makeParty(leader, members) {
  let partyId = null;
  for (const m of members) {
    await act(leader, "friend-request", { username: m.name });
    const fr = await act(m, "friend-accept", { username: leader.name });
    if (!fr.ok && fr.error !== "no-request") throw new Error(m.name + ": friend-accept " + JSON.stringify(fr));
    const invited = once(m.socket, "remaster-party-invite");
    const inv = await act(leader, "party-invite", { username: m.name });
    if (!inv.ok) throw new Error(leader.name + ": party-invite " + JSON.stringify(inv));
    const got = await act(m, "party-accept", { partyId: (await invited).partyId });
    if (!got.ok) throw new Error(m.name + ": party-accept " + JSON.stringify(got));
    partyId = got.partyId;
  }
  log("party", { leader: leader.name, members: members.map((m) => m.name), partyId });
  return partyId;
}

async function player(i) {
  const name = "Shared Tester " + (i + 1);
  const xff = { "X-Forwarded-For": "198.51.100." + (20 + i) };
  const want = userids[i];
  if (want) {
    const first = await request("POST", "/api/login", { userid: want, authType: "steam" }, xff);
    if (first.status !== 200) throw new Error(name + ": login as " + want + " " + first.status);
  }
  const reg = await request("POST", "/api/account/register",
    Object.assign({ username: name, email: "shared.tester." + (i + 1) + "." + Date.now() + "@example.com", password: "long enough password" },
      want ? { claimUserID: want } : {}), xff);
  if (reg.status !== 200) throw new Error(name + ": register " + reg.status + " " + JSON.stringify(reg.json));
  if (want && reg.json.userID !== want) throw new Error(name + ": wanted " + want + ", got " + reg.json.userID);
  const login = await request("POST", "/api/login", { userid: reg.json.userID, authType: "steam" });
  const socket = ioClient(backend, { transports: ["websocket"], forceNew: true, reconnection: false });
  await once(socket, "login_ready");
  const ok = Promise.race([once(socket, "auth-response").then(() => true), once(socket, "auth-fail").then(() => false)]);
  socket.emit("login", { token: login.json.token });
  if (!(await ok)) throw new Error(name + ": socket login refused");
  log("logged-in", { name, userID: reg.json.userID });
  return { name, userID: reg.json.userID, socket, ready: null, events: [] };
}

(async () => {
  fs.mkdirSync(out, { recursive: true });
  const players = [];
  for (let i = 0; i < total; i++) players.push(await player(i));
  // The groups: [leader, ...members] (each solo its own group).
  const groups = [];
  if (parties.length) {
    let k = 0;
    for (const n of parties) { groups.push(players.slice(k, k + n)); k += n; }
  } else for (const p of players) groups.push([p]);
  for (const g of groups) {
    const partyId = g.length > 1 ? await makeParty(g[0], g.slice(1)) : null;
    for (const p of g) { p.partyId = partyId; p.group = groups.indexOf(g); }
  }
  const readies = players.map((p) => new Promise((resolve) => p.socket.on("match-ready", (m) => { p.ready = m; log("match-ready", { name: p.name, gameServer: m.gameServer, netplay: m.netplay, team: m.team }); resolve(m); })));
  const finished = players.map((p) => new Promise((resolve) => p.socket.on("remaster-shared-match", (m) => {
    p.events.push(m);
    log("shared-match", { name: p.name, state: m.state, result: m.result, reason: m.reason });
    fs.writeFileSync(path.join(out, "finished.json"), JSON.stringify(players.map((x) => ({ name: x.name, userID: x.userID, events: x.events })), null, 1));
    if (m.state === "finished" || m.state === "cancelled") resolve(m);
  })));
  for (const p of players) p.socket.on("join-mm-fail", (m) => log("join-mm-fail", { name: p.name, m }));
  for (const g of groups) g[0].socket.emit("join-mm", { queueName: queue });      // a party's leader queues it
  log("queued", { queue, players: players.length, groups: groups.map((g) => g.length) });
  await Promise.all(readies);
  fs.writeFileSync(path.join(out, "tickets.json"), JSON.stringify(players.map((p) => ({ name: p.name, userID: p.userID,
    gameServer: p.ready.gameServer, nonce: p.ready.nonce, serverNonce: p.ready.serverNonce, matchId: p.ready.matchId, team: p.ready.team,
    netplay: p.ready.netplay, group: p.group, partyId: p.partyId || null, readyPartyId: p.ready.partyId || null })), null, 1));
  log("tickets-written");
  const timer = setTimeout(() => { log("timeout"); process.exit(3); }, waitMs);
  await Promise.all(finished);
  clearTimeout(timer);
  log("all-finished");
  process.exit(0);
})().catch((e) => { log("fatal", { error: e.message }); process.exit(1); });
