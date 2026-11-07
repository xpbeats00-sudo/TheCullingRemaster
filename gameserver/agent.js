// The game-server agent: the route-B host's side of the backend's game-server
// API (docs/PARTY_MATCHMAKING_REWORK.md section 4, on branch
// shared-match-backend). It runs next to one host game and does what the game
// itself can't (HTTPS, HMAC):
//
//   - register, then heartbeat; a heartbeat's answer carries the match to run
//     (the assignment), written to <control>/assignment.json for whoever
//     starts the host game (patch/netplay_run.py in the test);
//   - posts `ready` once the host game writes <control>/listening;
//   - writes <control>/tickets.txt for the host's PreLogin, which checks a
//     player's ticket (?Nonce=, as the stock client sends it) locally: one
//     line per ticket still good, "<SHA-256> <team> <userID>", from the
//     assignment's tickets (the ready answer and every heartbeat), written
//     to a temp file and renamed over it. No round trip at PreLogin;
//   - confirms each use the host reports (<control>/used-<n>: "<hash>
//     <userID>") with the backend's `ticket-used`, which keeps every ticket
//     single use;
//   - posts the one `result` once the host writes <control>/result.done
//     (result.txt: each joined player's placement, kills, damage and time
//     alive, by userID; roster players who never joined are reported
//     joined: false).
//
// The game talks to the agent only through those files (the host module is a
// no-CRT blob with no network or crypto of its own).
//
// It can also start and stop the host game itself (--launcher): one host
// per assignment, from the assignment's map, with ?servernonce= and the
// pre-match player count; headless with --headless (-nullrhi -nosound). The
// host is stopped --linger-ms after the result (the players' post-match
// screen), and a host that exits before its result aborts the match.
//
// usage: node agent.js --backend http://127.0.0.1:8123 --id gs1 --secret <hex>
//          --host 127.0.0.1 --port 7777 --control <dir> [--log <file>]
//          [--launcher <Func.Launcher.exe> --client-dll <dll> [--headless]
//           [--steam-settings <dir>] [--host-trace <file>] [--linger-ms 35000]
//           [--victory-exe <the host exe, when the install's Victory.exe is a client's>]]
// The secret is the per-server one: `node server/allocator.js secret gs1 [dataDir]`.
"use strict";

const { spawn, execFileSync } = require("child_process");
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
  launcher: arg("launcher"),
  clientDll: arg("client-dll"),
  headless: process.argv.includes("--headless"),
  steamSettings: arg("steam-settings"),
  hostTrace: arg("host-trace"),
  victoryExe: arg("victory-exe"),     // the host's own exe (the launcher's -FuncVictoryExe), when the install's Victory.exe is the client's
  lingerMs: parseInt(arg("linger-ms", "35000"), 10),
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
const verified = new Map(); // used-<n> -> {userID, team}: the players the host let in
const confirming = new Set(); // used-<n> being confirmed
const tickets = new Map();  // SHA-256 -> {id, userID, team, until (local ms), used}
let ticketsText = null;     // what tickets.txt holds
const SAFE_USER = /^[\x21-\x7e]{1,47}$/;

// A file the host reads: written whole to a temp file, then renamed over it
// (the host opens with delete sharing, so the rename never waits on it).
function atomicWrite(file, text) {
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, file);
}

// The assignment's tickets (only once the match runs): kept by hash.
function takeTickets(list) {
  if (!Array.isArray(list)) return;
  for (const t of list) {
    if (!t || typeof t.hash !== "string" || !/^[0-9a-f]{64}$/.test(t.hash) || typeof t.userID !== "string") continue;
    const had = tickets.get(t.hash);
    tickets.set(t.hash, { id: t.id, userID: t.userID, team: parseInt(t.team, 10) || 0,
      until: Date.now() + Math.max(0, parseInt(t.expiresInMs, 10) || 0), used: !!t.used || !!(had && had.used) });
  }
  writeTickets();
}

// tickets.txt: every ticket not used and not expired. Not written before the
// match runs (the host refuses logins while there is none).
function writeTickets() {
  if (!assignment || !readyPosted) return;
  const now = Date.now();
  const text = [...tickets.entries()].filter(([, t]) => !t.used && t.until > now && SAFE_USER.test(t.userID))
    .map(([hash, t]) => hash + " " + t.team + " " + t.userID + "\n").join("");
  if (text === ticketsText) return;
  atomicWrite(ctl("tickets.txt"), text);
  ticketsText = text;
  log("tickets", { count: text ? text.split("\n").length - 1 : 0 });
}

// ---- the host game (with --launcher) -----------------------------------------

const MODE = "/Game/Blueprints/GameMode/VictoryGameMode.VictoryGameMode_C";
const PAIRS = "/Game/Blueprints/GameMode/VictoryGameMode_CoopRanked.VictoryGameMode_CoopRanked_C";   // make_duo.py MODE
const MAPS = { 0: "Jungle_P", 1: "Jungle2_P" };      // custom_match.py URLS: 0 Jungle, 1 Prison
let host = null;                                     // { launcher, pid, matchId, stopAt }

// The URL a route-B host opens for this assignment, or null (not supported).
// Solo: the normal mode; Duos: the pairs mode; Trios, Quads: the pairs mode with
// ?TeamSize= (make_duo.py TEAM_URLS). The host puts players on the assigned teams
// (CULLING_NETPLAY_TEAMSIZE).
function hostUrl(a) {
  const map = MAPS[a.mapIndex || 0];
  const size = a.teamSize || 1;
  if (!map || size < 1 || size > 4) return null;
  const mode = size === 1 ? MODE : PAIRS;
  return map + "?listen?bIsLanMatch?bEnableBots=true?game=" + mode + (size > 2 ? "?TeamSize=" + size : "")
    + "?servernonce=" + a.serverNonce;
}

// The host game the launcher started: its child process named after the exe
// it runs (Victory.exe, or the --victory-exe file).
function victoryChildOf(parent) {
  const name = o.victoryExe ? path.basename(o.victoryExe) : "Victory.exe";
  try {
    const out = execFileSync("powershell", ["-NoProfile", "-Command",
      "(Get-CimInstance Win32_Process -Filter \"ParentProcessId=" + parent + " and Name='" + name + "'\").ProcessId"], { encoding: "utf8" });
    const pid = parseInt(out.trim().split(/\s+/)[0], 10);
    return pid > 0 ? pid : null;
  } catch { return null; }
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function startHost(a) {
  const url = hostUrl(a);
  if (!url) {
    log("host-unsupported", { matchId: a.matchId, mapIndex: a.mapIndex, teamSize: a.teamSize });
    call("abort", { matchId: a.matchId, reason: "unsupported-mode" }).catch(() => {});
    drop();
    return;
  }
  const args = ["-FuncSkipUpdateCheck", "-FuncClientDll=" + o.clientDll, "-FuncClientLog=" + ctl("host.func.log"), "-FuncJoin=" + url];
  if (o.headless) args.push("-FuncHeadlessClient");
  if (o.victoryExe) args.push("-FuncVictoryExe=" + o.victoryExe);
  if (o.steamSettings) args.push("-FuncSteamSettingsDir=" + o.steamSettings);
  const env = Object.assign({}, process.env, { FUNC_CLIENT_DISABLE_PAK_MOUNT: "1", CULLING_NETPLAY_PREMATCH: String(a.players),
    CULLING_NETPLAY_CONTROL: o.control, CULLING_NETPLAY_TEAMSIZE: String(a.teamSize || 1) });
  if (o.hostTrace) env.CULLING_NETPLAY_TRACE = o.hostTrace;
  const launcher = spawn(o.launcher, args, { cwd: path.dirname(o.launcher), env, stdio: "ignore" });
  host = { launcher: launcher.pid, pid: null, matchId: a.matchId, stopAt: 0, since: Date.now() };
  log("host-launch", { matchId: a.matchId, url: url.replace(/servernonce=\w+/, "servernonce=…"), headless: o.headless, launcher: launcher.pid });
}

function stopHost(why) {
  if (!host) return;
  if (host.pid && alive(host.pid)) { try { process.kill(host.pid); } catch { /* gone */ } }
  log("host-stopped", { matchId: host.matchId, pid: host.pid, why });
  host = null;
}

// Every poll: find the host's Victory.exe, notice it dying, stop it after the post-match.
async function watchHost() {
  if (!host) return;
  if (!host.pid) {
    host.pid = victoryChildOf(host.launcher);
    if (host.pid) { fs.writeFileSync(ctl("host.pid"), String(host.pid)); log("host-started", { pid: host.pid }); }
    else if (Date.now() - host.since > 120000) {
      log("host-never-started", { matchId: host.matchId });
      if (assignment && assignment.matchId === host.matchId) { await call("abort", { matchId: host.matchId, reason: "host-not-started" }).catch(() => {}); drop(); }
      host = null;
    }
    return;
  }
  if (host.stopAt && Date.now() >= host.stopAt) return stopHost("post-match over");
  if (!alive(host.pid)) {
    log("host-exited", { matchId: host.matchId, pid: host.pid });
    if (assignment && assignment.matchId === host.matchId && !resultPosted) {
      const r = await call("abort", { matchId: host.matchId, reason: "host-exited" }).catch((e) => ({ status: 0, json: { error: e.message } }));
      log("abort", { status: r.status, json: r.json });
      drop();
    }
    host = null;
  }
}

// A fresh control folder for a new match: the host numbers its verify requests from 1.
function clearControl() {
  for (const f of fs.readdirSync(o.control))
    if (/^(listening|tickets\.(txt|txt\.tmp)|used-\d+|result\.(txt|done|posted)|host\.(pid|func\.log))$/.test(f)) {
      try { fs.unlinkSync(ctl(f)); } catch { /* in use */ }
    }
}

// The match is over for this server (its result was paid, or the backend
// says it's no longer its own): report idle again.
function drop() {
  assignment = null;
  readyPosted = false;
  verified.clear();
  tickets.clear();
  ticketsText = null;
}

function take(a) {
  if (!a) {
    if (assignment && readyPosted) log("released", { matchId: assignment.matchId });
    if (assignment && readyPosted) drop();
    return;
  }
  if (assignment && assignment.matchId === a.matchId) { takeTickets(a.tickets); return; }
  assignment = a;
  readyPosted = false;
  resultPosted = false;
  verified.clear();
  confirming.clear();
  tickets.clear();
  ticketsText = null;
  if (o.launcher) { stopHost("new match"); clearControl(); }
  fs.writeFileSync(ctl("assignment.json"), JSON.stringify(a, null, 1));
  log("assignment", { matchId: a.matchId, playlist: a.playlist, players: a.players, bots: a.bots, field: a.field,
    roster: a.teams.flatMap((t) => t.players.map((p) => p.userID)) });
  if (o.launcher) startHost(a);
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
  log("ready", { status: r.status, tickets: r.json && r.json.assignment ? (r.json.assignment.tickets || []).length : null,
    error: r.json && r.json.error });
  if (readyPosted && r.json && r.json.assignment && r.json.assignment.matchId === assignment.matchId) takeTickets(r.json.assignment.tickets);
}

// used-<n> from the host: "<hash> <userID>\n" (the newline: written whole).
// The player is in; the backend is told (ticket-used), which uses the ticket
// up there too. A refusal is logged (the host already let the player in).
async function confirmUse(n) {
  confirming.add(n);
  let text;
  try { text = fs.readFileSync(ctl("used-" + n), "utf8"); } catch { confirming.delete(n); return; }
  if (!text.endsWith("\n")) { confirming.delete(n); return; }     // still being written: next poll
  const [hash, userID] = text.trim().split(/\s+/);
  const t = tickets.get(hash);
  if (t) { t.used = true; writeTickets(); }
  verified.set(n, { userID: t ? t.userID : userID, team: t ? t.team : 0, hash });
  let r;
  try { r = await call("ticket-used", { matchId: assignment.matchId, hash, userID }); } catch (e) { r = { status: 0, json: { error: e.message } }; }
  log("ticket-used", { n, userID, status: r.status, ok: !!(r.json && r.json.ok), error: r.json && r.json.error });
}

// result.txt -> the backend's result body (section 4.4).
function resultBody(text) {
  const kv = (line) => Object.fromEntries(line.split(/\s+/).filter((x) => x.includes("=")).map((x) => x.split("=")));
  const lines = text.split(/\r?\n/).filter(Boolean);
  const head = Object.assign({}, ...lines.filter((l) => !l.startsWith("player ")).map(kv));
  const byUser = new Map();
  const roster = new Set(assignment.teams.flatMap((t) => t.players.map((p) => p.userID)));
  for (const l of lines.filter((l) => l.startsWith("player "))) {
    const f = kv(l);
    // By the userID the host recorded from the player's ticket; else by its used-<n>.
    const v = verified.get(parseInt(f.n, 10));
    const userID = f.user && roster.has(f.user) ? f.user : v ? v.userID : null;
    if (userID && f.record !== "0") byUser.set(userID, f);
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
    // Team placement: the host's (its rank among all the match's teams, bots'
    // teams too), else the best placement of any member, ranked among the
    // players' own teams.
    const teamsCount = assignment.teamsCount || Math.ceil(field / assignment.teamSize);
    const hostPlace = new Map();
    for (const [userID, f] of byUser) {
      const team = players.find((p) => p.userID === userID).team;
      const tp = parseInt(f.team_placement, 10);
      if (tp > 0) hostPlace.set(team, Math.min(teamsCount, tp));
    }
    if (hostPlace.size) {
      body.teams = [...hostPlace.entries()].map(([team, placement]) => ({ team, placement, outcome: placement === 1 ? "won" : "out" }));
    } else {
      const best = new Map();
      for (const p of players) if (p.joined) best.set(p.team, Math.min(best.get(p.team) || field, p.placement));
      const order = [...best.entries()].sort((a, b) => a[1] - b[1]);
      body.teams = order.map(([team], i) => ({ team, placement: i + 1, outcome: i === 0 ? "won" : "out" }));
    }
  }
  return body;
}

async function postResult() {
  resultPosted = true;
  const body = resultBody(fs.readFileSync(ctl("result.txt"), "utf8"));
  const r = await call("result", body);
  fs.writeFileSync(ctl("result.posted"), JSON.stringify({ status: r.status, answer: r.json, body }, null, 1));
  log("result", { status: r.status, answer: r.json, players: body.players });
  if (host && host.matchId === body.matchId) host.stopAt = Date.now() + o.lingerMs;
  if (r.status === 200 || r.status === 409) drop();
}

async function poll() {
  try {
    if (assignment && !readyPosted && exists("listening")) await postReady();
    if (assignment && readyPosted) {
      writeTickets();                       // drops tickets that expired
      for (const f of fs.readdirSync(o.control)) {
        const m = /^used-(\d+)$/.exec(f);
        if (m && !confirming.has(+m[1])) confirmUse(+m[1]).catch((e) => log("ticket-used-error", { error: e.message }));
      }
    }
    if (assignment && readyPosted && !resultPosted && exists("result.done")) await postResult();
    if (o.launcher) await watchHost();
  } catch (e) { log("poll-error", { error: e.message }); }
  setTimeout(poll, 25);
}

(async () => {
  if (o.launcher && !o.clientDll) { console.error("--launcher needs --client-dll"); process.exit(2); }
  const r = await call("register", { host: o.host, port: o.port, version: "route-b-agent-1" });
  log("register", { status: r.status, json: r.json });
  if (r.status !== 200) process.exit(1);
  if (r.json.heartbeatMs) heartbeatMs = r.json.heartbeatMs;
  take(r.json.assignment);
  heartbeat();
  poll();
})().catch((e) => { log("fatal", { error: e.message }); process.exit(1); });
