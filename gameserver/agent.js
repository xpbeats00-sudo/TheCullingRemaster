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
//   - posts the one `result` once the host writes <control>/result.done:
//     kept in <match folder>/result.pending until the backend has it (200,
//     or 409: it has it already or the match is gone; 400: refused, never
//     taken), retried with backoff (1 s doubling to a minute) meanwhile, and
//     posted by the next run of the agent if this one stops first. The host
//     is stopped --linger-ms after result.done whatever the post does
//     (result.txt: each joined player's placement, kills, damage and time
//     alive, by userID; roster players who never joined are reported
//     joined: false).
//
// The game talks to the agent only through those files (the host module is a
// no-CRT blob with no network or crypto of its own).
//
// Each match has its own folder, <control>/<matchId>, which the host is
// given as CULLING_NETPLAY_CONTROL (a host of an old match can never read a
// new match's tickets); <control>/assignment.json is the latest assignment
// with that folder as "control".
//
// It can also start and stop the host game itself (--launcher): one host
// per assignment, from the assignment's map, with ?servernonce= and the
// pre-match player count; headless with --headless (-nullrhi -nosound). The
// host listens on --port exactly (CULLING_NETPLAY_PORT) and reports the port
// it bound in `listening` ("port=<n>"); any other port (the engine takes the
// next free one when --port is taken) aborts the match. The host's pid and
// exe go to <control>/host.pid, and an agent that starts finds a host left
// running by its last run (a crash, a restart) there and kills it, once its
// image name is the host exe's. The host is stopped --linger-ms after the
// result (the players' post-match screen), and a host that exits before its
// result aborts the match.
//
// usage: CULLING_GAMESERVER_SECRET=<hex> node agent.js --backend http://127.0.0.1:8123 --id gs1
//          --host 127.0.0.1 --port 7777 --control <dir> [--log <file>] [--secret-file <file>]
//          [--launcher <Func.Launcher.exe> --client-dll <dll> [--headless]
//           [--steam-settings <dir>] [--host-trace <file>] [--linger-ms 35000]
//           [--victory-exe <the host exe, when the install's Victory.exe is a client's>]]
// The secret is the per-server one: `node server/allocator.js secret gs1 [dataDir]`.
// It is read from CULLING_GAMESERVER_SECRET (or a file, --secret-file), never
// from the command line (anyone on the machine can list command lines), and
// the host game never gets it: the host runs with a clean environment (the
// system's own variables, FUNC_* and CULLING_NETPLAY_* only).
"use strict";

const { spawn, execFile } = require("child_process");
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
  secret: process.env.CULLING_GAMESERVER_SECRET || (arg("secret-file") ? fs.readFileSync(arg("secret-file"), "utf8").trim() : ""),
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
if (process.argv.includes("--secret")) {
  console.error("the secret goes in CULLING_GAMESERVER_SECRET (or --secret-file), never on the command line");
  process.exit(2);
}
for (const k of ["backend", "id", "control"]) if (!o[k]) { console.error("missing --" + k); process.exit(2); }
if (!o.secret) { console.error("missing CULLING_GAMESERVER_SECRET (or --secret-file)"); process.exit(2); }
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

// The current match's folder (the host's control folder), and the agent's own.
let matchDir = null;
const ctl = (name) => path.join(matchDir || o.control, name);
const root = (name) => path.join(o.control, name);
const exists = (name) => fs.existsSync(ctl(name));
const safeId = (id) => (/^[0-9A-Za-z_-]{1,64}$/.test(String(id)) ? String(id) : crypto.createHash("sha256").update(String(id)).digest("hex").slice(0, 32));

// Old matches' folders: the newest few are kept (logs, results), and any
// with a result still to post.
function pruneMatchDirs(keep = 8) {
  let dirs;
  try { dirs = fs.readdirSync(o.control, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
  const list = dirs.map((d) => ({ name: d.name, at: fs.statSync(root(d.name)).mtimeMs }))
    .filter((d) => root(d.name) !== matchDir && !fs.existsSync(path.join(root(d.name), "result.pending")))
    .sort((a, b) => b.at - a.at);
  for (const d of list.slice(keep)) { try { fs.rmSync(root(d.name), { recursive: true, force: true }); } catch { /* in use */ } }
}

const run = (file, args) => new Promise((resolve) => execFile(file, args, { encoding: "utf8", windowsHide: true },
  (err, stdout) => resolve(err ? "" : String(stdout))));

// A process's image name ("Victory.exe"), or null when no such process runs.
async function imageName(pid) {
  const out = await run("tasklist", ["/FI", "PID eq " + pid, "/FO", "CSV", "/NH"]);
  const m = /^"([^"]+)","(\d+)"/m.exec(out);
  return m && parseInt(m[2], 10) === pid ? m[1] : null;
}

const hostExeName = () => (o.victoryExe ? path.basename(o.victoryExe) : "Victory.exe");

// A host the last run of the agent left (host.pid): killed, if it is still
// that exe (a pid can be reused by anything once its process is gone).
async function killOrphan() {
  let saved;
  try { saved = JSON.parse(fs.readFileSync(root("host.pid"), "utf8")); } catch { return; }
  const pid = parseInt(saved && saved.pid, 10);
  if (pid > 0) {
    const name = await imageName(pid);
    if (name && name.toLowerCase() === String(saved.exe || hostExeName()).toLowerCase()) {
      await run("taskkill", ["/PID", String(pid), "/T", "/F"]);
      log("orphan-killed", { pid, exe: name, matchId: saved.matchId || null });
    } else log("orphan-gone", { pid, running: name });
  }
  try { fs.unlinkSync(root("host.pid")); } catch { /* gone */ }
}

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
// it runs (Victory.exe, or the --victory-exe file). Asked without blocking
// (a PowerShell start takes about a second; the poll loop runs every 25 ms).
async function victoryChildOf(parent) {
  const out = await run("powershell", ["-NoProfile", "-Command",
    "(Get-CimInstance Win32_Process -Filter \"ParentProcessId=" + parent + " and Name='" + hostExeName() + "'\").ProcessId"]);
  const pid = parseInt(out.trim().split(/\s+/)[0], 10);
  return pid > 0 ? pid : null;
}

function alive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

// The host's environment: Windows' own variables, and the launcher's and the
// module's (FUNC_*, CULLING_NETPLAY_*: the test switches only the test build
// reads), nothing else of the agent's: no secret, no token.
const SYSTEM_ENV = new Set(["systemroot", "systemdrive", "windir", "temp", "tmp", "path", "pathext", "comspec", "userprofile",
  "username", "userdomain", "homedrive", "homepath", "localappdata", "appdata", "programdata", "programfiles", "programfiles(x86)",
  "programw6432", "commonprogramfiles", "commonprogramfiles(x86)", "commonprogramw6432", "public", "allusersprofile",
  "computername", "number_of_processors", "processor_architecture", "processor_identifier", "processor_level",
  "processor_revision", "os", "driverdata"]);
function hostEnv() {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (/secret|token|password|passwd|key/i.test(k)) continue;
    if (SYSTEM_ENV.has(k.toLowerCase()) || /^(FUNC_|CULLING_NETPLAY_)/i.test(k)) env[k] = v;
  }
  return env;
}

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
  const env = Object.assign(hostEnv(), { FUNC_CLIENT_DISABLE_PAK_MOUNT: "1", CULLING_NETPLAY_PREMATCH: String(a.players),
    CULLING_NETPLAY_CONTROL: matchDir, CULLING_NETPLAY_TEAMSIZE: String(a.teamSize || 1), CULLING_NETPLAY_PORT: String(o.port) });
  if (o.hostTrace) env.CULLING_NETPLAY_TRACE = o.hostTrace;
  const launcher = spawn(o.launcher, args, { cwd: path.dirname(o.launcher), env, stdio: "ignore" });
  host = { launcher: launcher.pid, pid: null, matchId: a.matchId, stopAt: 0, since: Date.now() };
  log("host-launch", { matchId: a.matchId, url: url.replace(/servernonce=\w+/, "servernonce=…"), headless: o.headless, launcher: launcher.pid });
}

function stopHost(why) {
  if (!host) return;
  if (host.pid && alive(host.pid)) { try { process.kill(host.pid); } catch { /* gone */ } }
  // The launcher and anything it started (the host, before its pid is known).
  if (host.launcher && alive(host.launcher)) run("taskkill", ["/PID", String(host.launcher), "/T", "/F"]);
  log("host-stopped", { matchId: host.matchId, pid: host.pid, why });
  try { fs.unlinkSync(root("host.pid")); } catch { /* gone */ }
  host = null;
}

// Every poll: find the host's Victory.exe, notice it dying, stop it after the post-match.
async function watchHost() {
  if (!host) return;
  if (!host.pid) {
    if (!host.looking && Date.now() >= (host.nextLook || 0)) {
      const h = host;
      h.looking = true;
      victoryChildOf(h.launcher).then((pid) => {
        h.looking = false;
        h.nextLook = Date.now() + 500;
        if (!pid || host !== h || h.pid) return;
        h.pid = pid;
        fs.writeFileSync(root("host.pid"), JSON.stringify({ pid, exe: hostExeName(), matchId: h.matchId }));
        log("host-started", { pid, matchId: h.matchId });
      });
    }
    if (Date.now() - host.since > 120000) {
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

// The match is over for this server (its result was paid, or the backend
// says it's no longer its own): report idle again.
function drop() {
  assignment = null;
  readyPosted = false;
  verified.clear();
  tickets.clear();
  ticketsText = null;
}

// ---- the result: posted until the backend has it --------------------------------

const results = new Map();  // matchId -> { body, file, attempts, nextAt, busy }
const finished = new Set(); // matches whose result the backend has: never taken up again

// result.txt (written by the host at the end) -> result.pending, then posted.
function startResult() {
  resultPosted = true;
  const body = resultBody(fs.readFileSync(ctl("result.txt"), "utf8"));
  const file = ctl("result.pending");
  atomicWrite(file, JSON.stringify(body));
  if (host && host.matchId === body.matchId) host.stopAt = Date.now() + o.lingerMs;
  results.set(body.matchId, { body, file, attempts: 0, nextAt: 0, busy: false });
}

// Every match folder's result.pending (an agent that stopped before posting).
function loadPending() {
  let dirs = [];
  try { dirs = fs.readdirSync(o.control, { withFileTypes: true }).filter((d) => d.isDirectory()); } catch { return; }
  for (const d of dirs) {
    const file = path.join(root(d.name), "result.pending");
    let body;
    try { body = JSON.parse(fs.readFileSync(file, "utf8")); } catch { continue; }
    if (!body || typeof body.matchId !== "string" || results.has(body.matchId)) continue;
    results.set(body.matchId, { body, file, attempts: 0, nextAt: 0, busy: false });
    log("result-pending", { matchId: body.matchId });
  }
}

async function postResults() {
  for (const [matchId, p] of results) {
    if (p.busy || Date.now() < p.nextAt) continue;
    p.busy = true;
    let r;
    try { r = await call("result", p.body); } catch (e) { r = { status: 0, json: { error: e.message } }; }
    p.attempts++;
    log("result", { matchId, status: r.status, answer: r.json, attempt: p.attempts, players: p.body.players });
    if (r.status === 200 || r.status === 409 || r.status === 400) {
      // 409: the backend has it already (or the match is gone); 400: refused for good.
      fs.writeFileSync(path.join(path.dirname(p.file), "result.posted"),
        JSON.stringify({ status: r.status, answer: r.json, body: p.body, attempts: p.attempts }, null, 1));
      try { fs.unlinkSync(p.file); } catch { /* gone */ }
      results.delete(matchId);
      finished.add(matchId);
      if (finished.size > 100) finished.delete(finished.values().next().value);
      if (assignment && assignment.matchId === matchId) drop();
    } else {
      const wait = Math.min(60000, 1000 * Math.pow(2, Math.min(6, p.attempts - 1)));
      p.nextAt = Date.now() + wait;
      log("result-retry", { matchId, inMs: wait });
    }
    p.busy = false;
  }
}

function take(a) {
  if (!a) {
    if (assignment && readyPosted && !results.has(assignment.matchId)) {
      log("released", { matchId: assignment.matchId });
      if (host && host.matchId === assignment.matchId && !host.stopAt) stopHost("released");
      drop();
    }
    return;
  }
  if (assignment && assignment.matchId === a.matchId) { takeTickets(a.tickets); return; }
  if (finished.has(a.matchId)) return;            // its result is posted: over here
  if (results.has(a.matchId)) {
    // Its result is waiting to be posted (an agent that stopped first): the
    // match is over here; heartbeats report it running until the backend has it.
    assignment = a;
    readyPosted = true;
    resultPosted = true;
    matchDir = root(safeId(a.matchId));
    fs.mkdirSync(matchDir, { recursive: true });
    log("assignment-finished", { matchId: a.matchId });
    return;
  }
  assignment = a;
  readyPosted = false;
  resultPosted = false;
  verified.clear();
  confirming.clear();
  tickets.clear();
  ticketsText = null;
  if (o.launcher) stopHost("new match");
  matchDir = root(safeId(a.matchId));
  fs.mkdirSync(matchDir, { recursive: true });
  const saved = JSON.stringify(Object.assign({}, a, { control: matchDir }), null, 1);
  fs.writeFileSync(ctl("assignment.json"), saved);
  atomicWrite(root("assignment.json"), saved);
  pruneMatchDirs();
  log("assignment", { matchId: a.matchId, playlist: a.playlist, players: a.players, bots: a.bots, field: a.field,
    roster: a.teams.flatMap((t) => t.players.map((p) => p.userID)) });
  if (o.launcher) startHost(a);
}

// Errors back off: a failing backend is asked less and less often (up to
// 10 s apart for heartbeats, 5 s for the poll loop's own errors), and a
// backend that doesn't know this server (restarted with a new pool) gets
// a new register.
let heartbeatErrors = 0, pollErrors = 0;
const backoff = (base, errors, max) => Math.min(max, base * Math.pow(2, Math.min(8, errors)));

async function register() {
  for (let attempt = 0; ; attempt++) {
    let r;
    try { r = await call("register", { host: o.host, port: o.port, version: "route-b-agent-2" }); } catch (e) { r = { status: 0, json: { error: e.message } }; }
    log("register", { status: r.status, json: r.json, attempt: attempt + 1 });
    if (r.status === 200 && r.json) return r.json;
    await new Promise((res) => setTimeout(res, backoff(1000, attempt, 30000)));
  }
}

async function heartbeat() {
  let ok = false;
  try {
    const r = await call("heartbeat", { matchId: assignment ? assignment.matchId : null,
      state: !assignment ? "idle" : readyPosted ? "running" : "loading", players: verified.size, bots: assignment ? assignment.bots : 0 });
    if (r.status === 404 && r.json && r.json.error === "unknown-server") {
      log("heartbeat-unknown", {});
      const j = await register();
      ok = true;
      take(j.assignment);
    } else if (r.status === 200 && r.json) {
      ok = true;
      if (r.json.heartbeatMs) heartbeatMs = r.json.heartbeatMs;
      if (r.json.cancel) {
        // The backend gave the match up (cancelled, or no longer this server's):
        // its host goes too, or it would run on with nobody's result counting.
        const mine = assignment && assignment.matchId === r.json.cancel;
        if (mine || (host && host.matchId === r.json.cancel)) log("cancel", { matchId: r.json.cancel });
        if (host && host.matchId === r.json.cancel) stopHost("cancelled");
        if (mine) drop();
      }
      take(r.json.assignment);
    } else log("heartbeat-refused", { status: r.status, json: r.json, errors: heartbeatErrors + 1 });
  } catch (e) { log("heartbeat-error", { error: e.message, errors: heartbeatErrors + 1 }); }
  heartbeatErrors = ok ? 0 : heartbeatErrors + 1;
  setTimeout(heartbeat, ok ? heartbeatMs : backoff(heartbeatMs, heartbeatErrors, 10000));
}

// listening: "port=<n>", the port the host bound. Only --port is ours (the
// address the backend sends players to): another one means --port was
// taken (an old host on it), so the match can't run here.
async function hostListening() {
  const text = fs.readFileSync(ctl("listening"), "utf8");
  if (!text.endsWith("\n")) return;                         // still being written: next poll
  const m = /port=(\d+)/.exec(text);
  const port = m ? parseInt(m[1], 10) : 0;
  if (port === o.port) return postReady();
  log("port-mismatch", { matchId: assignment.matchId, want: o.port, bound: port || null });
  const matchId = assignment.matchId;
  const r = await call("abort", { matchId, reason: "port-mismatch" }).catch((e) => ({ status: 0, json: { error: e.message } }));
  log("abort", { status: r.status, json: r.json });
  if (host && host.matchId === matchId) stopHost("port-mismatch");
  drop();
}

async function postReady() {
  const r = await call("ready", { matchId: assignment.matchId });
  readyPosted = r.status === 200;
  log("ready", { status: r.status, tickets: r.json && r.json.assignment ? (r.json.assignment.tickets || []).length : null,
    error: r.json && r.json.error });
  if (readyPosted && r.json && r.json.assignment && r.json.assignment.matchId === assignment.matchId) takeTickets(r.json.assignment.tickets);
}

// used-<n> from the host: "<hash> <userID> <net id>\n" (the newline: written whole).
// The player is in; the backend is told (ticket-used), which uses the ticket
// up there too. A refusal is logged (the host already let the player in).
async function confirmUse(n) {
  confirming.add(n);
  let text;
  try { text = fs.readFileSync(ctl("used-" + n), "utf8"); } catch { confirming.delete(n); return; }
  if (!text.endsWith("\n")) { confirming.delete(n); return; }     // still being written: next poll
  const [hash, userID, netId] = text.trim().split(/\s+/);
  const t = tickets.get(hash);
  if (t) { t.used = true; writeTickets(); }
  verified.set(n, { userID: t ? t.userID : userID, team: t ? t.team : 0, hash });
  let r;
  try { r = await call("ticket-used", { matchId: assignment.matchId, hash, userID }); } catch (e) { r = { status: 0, json: { error: e.message } }; }
  log("ticket-used", { n, userID, netId, status: r.status, ok: !!(r.json && r.json.ok), error: r.json && r.json.error });
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

async function poll() {
  try {
    if (assignment && !readyPosted && exists("listening")) await hostListening();
    if (assignment && readyPosted) {
      writeTickets();                       // drops tickets that expired
      for (const f of fs.readdirSync(matchDir)) {
        const m = /^used-(\d+)$/.exec(f);
        if (m && !confirming.has(+m[1])) confirmUse(+m[1]).catch((e) => log("ticket-used-error", { error: e.message }));
      }
    }
    if (assignment && readyPosted && !resultPosted && exists("result.done")) startResult();
    if (results.size) await postResults();
    if (o.launcher) await watchHost();
    pollErrors = 0;
  } catch (e) {
    pollErrors++;
    if (pollErrors <= 3 || pollErrors % 50 === 0) log("poll-error", { error: e.message, errors: pollErrors });
  }
  setTimeout(poll, pollErrors ? backoff(25, pollErrors, 5000) : 25);
}

(async () => {
  if (o.launcher && !o.clientDll) { console.error("--launcher needs --client-dll"); process.exit(2); }
  if (o.launcher) await killOrphan();
  loadPending();
  const j = await register();
  if (j.heartbeatMs) heartbeatMs = j.heartbeatMs;
  take(j.assignment);
  heartbeat();
  poll();
})().catch((e) => { log("fatal", { error: e.message }); process.exit(1); });
