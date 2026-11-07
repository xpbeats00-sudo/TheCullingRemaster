// The game-server agent: the route-B host's side of the backend's game-server
// API (docs/PARTY_MATCHMAKING_REWORK.md section 4, on branch
// shared-match-backend). It runs next to one host game and does what the game
// itself can't (HTTPS, HMAC):
//
//   - register, then heartbeat; a heartbeat's answer carries the match to run
//     (the assignment), written to <control>/assignment.json for whoever
//     starts the host game (patch/netplay_run.py in the test);
//   - posts `ready` once the host game writes <control>/listening;
//   - answers the host's PreLogin: <control>/verify-<n>.req holds a player's
//     ticket (?Nonce=, as the stock client sends it); the agent asks `verify-ticket` and writes
//     verify-<n>.ans: "ok <team> <userID>" or "deny <reason>";
//   - posts the one `result` once the host writes <control>/result.done
//     (result.txt: each joined player's placement, kills, damage and time
//     alive, by the verify request it passed with; roster players who never
//     joined are reported joined: false).
//
// The game talks to the agent only through those files (the host module is a
// no-CRT blob with no network or crypto of its own).
//
// usage: node agent.js --backend http://127.0.0.1:8123 --id gs1 --secret <hex>
//          --host 127.0.0.1 --port 7777 --control <dir> [--log <file>]
// The secret is the per-server one: `node server/allocator.js secret gs1 [dataDir]`.
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");
const { URL } = require("url");

const arg = (name, d) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : d; };
const o = {
  backend: arg("backend", process.env.CULLING_BACKEND_URL),
  id: arg("id", process.env.CULLING_GAMESERVER_ID),
  secret: arg("secret", process.env.CULLING_GAMESERVER_SECRET),
  host: arg("host", "127.0.0.1"),
  port: parseInt(arg("port", "7777"), 10),
  control: arg("control"),
  log: arg("log"),
};
for (const k of ["backend", "id", "secret", "control"]) if (!o[k]) { console.error("missing --" + k); process.exit(2); }
fs.mkdirSync(o.control, { recursive: true });

function log(event, fields = {}) {
  const line = JSON.stringify(Object.assign({ t: new Date().toISOString(), event }, fields));
  console.log(line);
  if (o.log) fs.appendFileSync(o.log, line + "\n");
}

const sign = (secret, ts, action, body) => crypto.createHmac("sha256", secret).update(String(ts) + "." + action + "." + body).digest("hex");

// A signed call to the backend: {status, json}.
function call(action, payload) {
  const body = JSON.stringify(Object.assign({ serverId: o.id }, payload));
  const ts = Date.now();
  const u = new URL("/api/gameserver/" + action, o.backend);
  const lib = u.protocol === "https:" ? https : http;
  return new Promise((resolve, reject) => {
    const req = lib.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", timeout: 10000, headers: {
      "Content-Type": "text/plain", "X-Culling-Server": o.id, "X-Culling-Timestamp": String(ts),
      "X-Culling-Signature": sign(o.secret, ts, action, body) } }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    req.end(body);
  });
}

const ctl = (name) => path.join(o.control, name);
const exists = (name) => fs.existsSync(ctl(name));

let heartbeatMs = 2000;
let assignment = null;      // the match being run
let readyPosted = false;
let resultPosted = false;
const verified = new Map(); // verify request n -> {userID, team}

// The match is over for this server (its result was paid, or the backend
// says it's no longer its own): report idle again.
function drop() {
  assignment = null;
  readyPosted = false;
  verified.clear();
}

function take(a) {
  if (!a) {
    if (assignment && readyPosted) log("released", { matchId: assignment.matchId });
    if (assignment && readyPosted) drop();
    return;
  }
  if (assignment && assignment.matchId === a.matchId) return;
  assignment = a;
  readyPosted = false;
  resultPosted = false;
  verified.clear();
  fs.writeFileSync(ctl("assignment.json"), JSON.stringify(a, null, 1));
  log("assignment", { matchId: a.matchId, playlist: a.playlist, players: a.players, bots: a.bots, field: a.field,
    roster: a.teams.flatMap((t) => t.players.map((p) => p.userID)) });
}

async function heartbeat() {
  try {
    const r = await call("heartbeat", { matchId: assignment ? assignment.matchId : null,
      state: !assignment ? "idle" : readyPosted ? "running" : "loading", players: verified.size, bots: assignment ? assignment.bots : 0 });
    if (r.status === 200 && r.json) {
      if (r.json.heartbeatMs) heartbeatMs = r.json.heartbeatMs;
      if (r.json.cancel) {
        log("cancel", { matchId: r.json.cancel });
        if (assignment && assignment.matchId === r.json.cancel) drop();
      }
      take(r.json.assignment);
    } else log("heartbeat-refused", { status: r.status, json: r.json });
  } catch (e) { log("heartbeat-error", { error: e.message }); }
  setTimeout(heartbeat, heartbeatMs);
}

async function postReady() {
  const r = await call("ready", { matchId: assignment.matchId });
  readyPosted = r.status === 200;
  log("ready", { status: r.status, json: r.json });
}

const pending = new Set();
async function answer(n) {
  pending.add(n);
  const ticket = fs.readFileSync(ctl("verify-" + n + ".req"), "utf8").trim();
  let text;
  try {
    const r = assignment ? await call("verify-ticket", { matchId: assignment.matchId, ticket }) : { status: 503, json: { error: "no-match" } };
    if (r.status === 200 && r.json && r.json.ok) {
      verified.set(n, { userID: r.json.userID, team: r.json.team });
      text = "ok " + r.json.team + " " + r.json.userID;
    } else text = "deny " + ((r.json && r.json.error) || "status-" + r.status);
  } catch (e) { text = "deny backend-error"; }
  fs.writeFileSync(ctl("verify-" + n + ".ans"), text);
  log("verify", { request: n, answer: text, ticketLength: ticket.length });
}

// result.txt -> the backend's result body (section 4.4).
function resultBody(text) {
  const kv = (line) => Object.fromEntries(line.split(/\s+/).filter((x) => x.includes("=")).map((x) => x.split("=")));
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = Object.assign({}, ...lines.filter((l) => !l.startsWith("player ")).map(kv));
  const byUser = new Map();
  for (const l of lines.filter((l) => l.startsWith("player "))) {
    const f = kv(l);
    const v = verified.get(parseInt(f.n, 10));
    if (v && f.record !== "0") byUser.set(v.userID, f);
  }
  const field = assignment.field || parseInt(head.field, 10) || 16;
  const sinceReady = Math.max(1, parseInt(head.elapsed, 10) || 0);
  const players = [];
  for (const t of assignment.teams) for (const p of t.players) {
    const f = byUser.get(p.userID);
    if (!f) { players.push({ userID: p.userID, team: t.team, placement: field, kills: 0, damage: 0, timeAlive: 0, joined: false }); continue; }
    players.push({ userID: p.userID, team: t.team, joined: true,
      placement: Math.min(field, Math.max(1, parseInt(f.placement, 10) || field)),
      kills: Math.min(field - (assignment.teamSize || 1), Math.max(0, parseInt(f.kills, 10) || 0)),
      damage: Math.min(5000, Math.max(0, parseInt(f.damage, 10) || 0)),
      timeAlive: Math.min(sinceReady, Math.max(0, parseInt(f.alive_s, 10) || 0)) });
  }
  const body = { matchId: assignment.matchId, duration: sinceReady, players };
  if ((assignment.teamSize || 1) > 1) {
    // Team placement: the best placement of any member.
    const best = new Map();
    for (const p of players) if (p.joined) best.set(p.team, Math.min(best.get(p.team) || field, p.placement));
    const order = [...best.entries()].sort((a, b) => a[1] - b[1]);
    body.teams = order.map(([team], i) => ({ team, placement: i + 1, outcome: i === 0 ? "won" : "out" }));
  }
  return body;
}

async function postResult() {
  resultPosted = true;
  const body = resultBody(fs.readFileSync(ctl("result.txt"), "utf8"));
  const r = await call("result", body);
  fs.writeFileSync(ctl("result.posted"), JSON.stringify({ status: r.status, answer: r.json, body }, null, 1));
  log("result", { status: r.status, answer: r.json, players: body.players });
  if (r.status === 200 || r.status === 409) drop();
}

async function poll() {
  try {
    if (assignment && !readyPosted && exists("listening")) await postReady();
    for (const f of fs.readdirSync(o.control)) {
      const m = /^verify-(\d+)\.req$/.exec(f);
      if (m && !pending.has(+m[1]) && !exists("verify-" + m[1] + ".ans")) answer(+m[1]).catch((e) => log("verify-error", { error: e.message }));
    }
    if (assignment && readyPosted && !resultPosted && exists("result.done")) await postResult();
  } catch (e) { log("poll-error", { error: e.message }); }
  setTimeout(poll, 25);
}

(async () => {
  const r = await call("register", { host: o.host, port: o.port, version: "route-b-agent-1" });
  log("register", { status: r.status, json: r.json });
  if (r.status !== 200) process.exit(1);
  if (r.json.heartbeatMs) heartbeatMs = r.json.heartbeatMs;
  take(r.json.assignment);
  heartbeat();
  poll();
})().catch((e) => { log("fatal", { error: e.message }); process.exit(1); });
