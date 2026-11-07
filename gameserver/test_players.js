// Test players for a shared match: real accounts and menu sockets on the
// backend (as server/test/sharedmatch.test.js makes them), queueing a shared
// playlist together. Each player's match-ready (game server, ticket) goes to
// <out>/tickets.json for the real game clients to join with; their
// remaster-shared-match events (finished: the paid result) go to
// <out>/finished.json.
//
// usage: node test_players.js --backend http://127.0.0.1:8123 --server-dir <backend repo>/server
//          --out <dir> [--count 2] [--queue ffa_jungle] [--wait-ms 900000]
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
const ioClient = require(path.join(arg("server-dir"), "node_modules", "socket.io-client"));

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

async function player(i) {
  const name = "Shared Tester " + (i + 1);
  const xff = { "X-Forwarded-For": "198.51.100." + (20 + i) };
  const reg = await request("POST", "/api/account/register",
    { username: name, email: "shared.tester." + (i + 1) + "." + Date.now() + "@example.com", password: "long enough password" }, xff);
  if (reg.status !== 200) throw new Error(name + ": register " + reg.status + " " + JSON.stringify(reg.json));
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
  for (let i = 0; i < count; i++) players.push(await player(i));
  const readies = players.map((p) => new Promise((resolve) => p.socket.on("match-ready", (m) => { p.ready = m; log("match-ready", { name: p.name, gameServer: m.gameServer, netplay: m.netplay, team: m.team }); resolve(m); })));
  const finished = players.map((p) => new Promise((resolve) => p.socket.on("remaster-shared-match", (m) => {
    p.events.push(m);
    log("shared-match", { name: p.name, state: m.state, result: m.result, reason: m.reason });
    fs.writeFileSync(path.join(out, "finished.json"), JSON.stringify(players.map((x) => ({ name: x.name, userID: x.userID, events: x.events })), null, 1));
    if (m.state === "finished" || m.state === "cancelled") resolve(m);
  })));
  for (const p of players) {
    p.socket.on("join-mm-fail", (m) => log("join-mm-fail", { name: p.name, m }));
    p.socket.emit("join-mm", { queueName: queue });
  }
  log("queued", { queue, players: players.length });
  await Promise.all(readies);
  fs.writeFileSync(path.join(out, "tickets.json"), JSON.stringify(players.map((p) => ({ name: p.name, userID: p.userID,
    gameServer: p.ready.gameServer, nonce: p.ready.nonce, serverNonce: p.ready.serverNonce, matchId: p.ready.matchId, team: p.ready.team,
    netplay: p.ready.netplay })), null, 1));
  log("tickets-written");
  const timer = setTimeout(() => { log("timeout"); process.exit(3); }, waitMs);
  await Promise.all(finished);
  clearTimeout(timer);
  log("all-finished");
  process.exit(0);
})().catch((e) => { log("fatal", { error: e.message }); process.exit(1); });
