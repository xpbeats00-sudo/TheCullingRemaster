// Game-server allocator for shared matches (docs/PARTY_MATCHMAKING_REWORK.md).
//
// A shared match runs on one game-server process. The allocator keeps track of
// those processes and hands one to each match:
//
// - Pool mode (CULLING_GAMESERVER_POOL): a fixed list of slots, each a
//   long-running process started and supervised outside the backend (the VPS
//   watchdog). A slot is usable once its process has registered and while its
//   heartbeats keep coming. It learns its match from the answer to a heartbeat
//   (pull: the backend never connects to a game server).
// - Launch mode (CULLING_GAMESERVER_COMMAND + CULLING_GAMESERVER_PORTS): one
//   process per match, started from a command template on a free port; its
//   exit ends the match.
//
// Either way a reserved slot must post `ready` within readyTimeoutMs, then
// heartbeat at least every heartbeatTimeoutMs until the match ends, and a
// match may not run longer than maxMatchMs. Anything else (no ready, silent,
// process exit, the server restarting, the server dropping its match) frees
// the slot and reports the match lost, with the reason, so the backend can
// cancel it and tell the players. At most maxMatches run at once.
//
// Game servers authenticate every request with a per-server secret: an
// HMAC-SHA256 over "<timestamp>.<action>.<raw body>" (sign() below). The
// per-server secret is derived from one master secret, so the operator hands
// each process only its own (`node allocator.js secret <serverId> [dataDir]`).
//
// Every state change is logged as one JSON line (event, serverId, matchId,
// reason, ...), for the operator and for capacity measurements (heartbeats
// may carry cpu, memory, players and tick time; they are kept per slot).
"use strict";

const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { EventEmitter } = require("events");
const childProcess = require("child_process");

const DEFAULTS = {
  readyTimeoutMs: 60000,
  heartbeatMs: 2000,           // told to game servers: how often to beat
  heartbeatTimeoutMs: 10000,   // silent this long: lost
  maxMatchMs: 90 * 60 * 1000,
  releaseGraceMs: 5000         // launch mode: time a process gets to exit by itself after its match
};

// ---------------------------------------------------------------- secrets and signatures

// The master secret: CULLING_GAMESERVER_SECRET, else a file in the data folder
// (created once, 32 random bytes).
function loadSecret(envValue, file) {
  if (envValue && String(envValue).length >= 16) return String(envValue);
  try {
    const s = fs.readFileSync(file, "utf8").trim();
    if (s.length >= 32) return s;
  } catch { /* none yet */ }
  const s = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, s);
  return s;
}

const serverSecret = (master, serverId) => crypto.createHmac("sha256", master).update("gameserver:" + serverId).digest("hex");

// The signature a game server sends with a request (X-Culling-Signature).
function sign(secret, timestamp, action, body) {
  return crypto.createHmac("sha256", secret).update(String(timestamp) + "." + action + "." + body).digest("hex");
}

function safeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length || !/^[0-9a-f]+$/i.test(a)) return false;
  return crypto.timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
}

// ---------------------------------------------------------------- config

// "gs1@127.0.0.1:7777,gs2@127.0.0.1:7778" -> [{ id, host, port }]
function parsePool(raw) {
  if (!raw) return [];
  const out = [];
  for (const part of String(raw).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^([A-Za-z0-9_-]{1,32})@([A-Za-z0-9.:[\]-]+):(\d{1,5})$/.exec(part);
    if (!m) throw new Error("CULLING_GAMESERVER_POOL: bad entry " + JSON.stringify(part) + " (want id@host:port)");
    out.push({ id: m[1], host: m[2], port: parseInt(m[3], 10) });
  }
  return out;
}

// "7777-7780,7790" -> [7777, 7778, 7779, 7780, 7790]
function parsePorts(raw) {
  if (!raw) return [];
  const out = [];
  for (const part of String(raw).split(",").map((s) => s.trim()).filter(Boolean)) {
    const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(part);
    if (!m) throw new Error("CULLING_GAMESERVER_PORTS: bad entry " + JSON.stringify(part));
    const a = parseInt(m[1], 10), b = m[2] ? parseInt(m[2], 10) : a;
    for (let p = a; p <= b && out.length < 1000; p++) out.push(p);
  }
  return out;
}

// The launch command: a JSON array (argv), so paths with spaces need no quoting rules.
function parseCommand(raw) {
  if (!raw) return null;
  let argv;
  try { argv = JSON.parse(raw); } catch { throw new Error("CULLING_GAMESERVER_COMMAND must be a JSON array of strings"); }
  if (!Array.isArray(argv) || !argv.length || !argv.every((a) => typeof a === "string")) {
    throw new Error("CULLING_GAMESERVER_COMMAND must be a JSON array of strings");
  }
  return argv;
}

// {name} placeholders in the launch command.
function fill(template, values) {
  return template.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(values, k) ? String(values[k]) : m));
}

// ---------------------------------------------------------------- allocator

class Allocator extends EventEmitter {
  // opts: pool [{id, host, port}] | launch { command: argv, ports: [..], host, publicHost, cwd, logDir },
  // maxMatches, timeouts (DEFAULTS), master (secret), backendUrl() (for launched servers),
  // log(obj), now, spawn, setInterval/clearInterval.
  constructor(opts = {}) {
    super();
    this.options = Object.assign({}, DEFAULTS, opts);
    this.now = opts.now || Date.now;
    this.master = opts.master;
    this.spawn = opts.spawn || childProcess.spawn;
    this.logEvent = opts.log || ((o) => console.log(JSON.stringify(o)));
    this.slots = new Map();          // serverId -> slot
    this.byMatch = new Map();        // matchId -> serverId
    this.pool = opts.pool || [];
    this.launch = opts.launch && opts.launch.command ? opts.launch : null;
    for (const s of this.pool) {
      this.slots.set(s.id, { id: s.id, host: s.host, port: s.port, kind: "pool", state: "offline", lastBeat: 0,
        matchId: null, assignment: null, since: this.now(), stats: null });
    }
    const max = this.pool.length || (this.launch ? this.launch.ports.length : 0);
    this.maxMatches = Math.max(0, Math.min(max, Number.isInteger(opts.maxMatches) && opts.maxMatches > 0 ? opts.maxMatches : max));
    this.counters = { reserved: 0, ready: 0, lost: 0, released: 0, refused: 0 };
    const every = Math.max(50, Math.min(1000, Math.floor(this.options.heartbeatTimeoutMs / 4)));
    this.timer = (opts.setInterval || setInterval)(() => this.check(), every);
    if (this.timer && this.timer.unref) this.timer.unref();
  }

  get configured() { return this.pool.length > 0 || !!this.launch; }

  event(name, fields = {}) {
    try { this.logEvent(Object.assign({ at: new Date(this.now()).toISOString(), event: "gameserver." + name }, fields)); } catch { /* never throw from logging */ }
  }

  secretFor(serverId) { return serverSecret(this.master, serverId); }

  // A server id the allocator would accept requests from.
  knows(serverId) { return typeof serverId === "string" && this.slots.has(serverId); }

  active() { let n = 0; for (const s of this.slots.values()) if (s.state === "reserved" || s.state === "running") n++; return n; }

  // Reserves a game server for a match. assignment: what the server is told
  // (matchId, map, mode, teams, bots, ...). Returns { serverId, host, port } or
  // { error } (no-server, no-capacity, launch-failed). Later: 'ready'
  // (matchId, slot) or 'lost' (matchId, reason, slot).
  reserve(assignment) {
    const matchId = assignment.matchId;
    if (!this.configured) { this.counters.refused++; this.event("refused", { matchId, reason: "no-server" }); return { error: "no-server" }; }
    if (this.active() >= this.maxMatches) {
      this.counters.refused++;
      this.event("refused", { matchId, reason: "no-capacity", active: this.active(), max: this.maxMatches });
      return { error: "no-capacity" };
    }
    let slot = null;
    if (this.pool.length) {
      const fresh = this.now() - this.options.heartbeatTimeoutMs;
      // The longest-idle healthy slot.
      for (const s of this.slots.values()) if (s.state === "idle" && s.lastBeat >= fresh && (!slot || s.since < slot.since)) slot = s;
      if (!slot) { this.counters.refused++; this.event("refused", { matchId, reason: "no-capacity", note: "no idle registered server" }); return { error: "no-capacity" }; }
    } else {
      const used = new Set([...this.slots.values()].map((s) => s.port));
      const port = this.launch.ports.find((p) => !used.has(p));
      if (port === undefined) { this.counters.refused++; this.event("refused", { matchId, reason: "no-capacity" }); return { error: "no-capacity" }; }
      const id = "gs" + port + "-" + crypto.randomBytes(3).toString("hex");
      slot = { id, host: this.launch.publicHost || this.launch.host || "127.0.0.1", port, kind: "launch", state: "offline",
        lastBeat: 0, matchId: null, assignment: null, since: this.now(), stats: null, proc: null };
      this.slots.set(id, slot);
    }
    slot.state = "reserved";
    slot.matchId = matchId;
    slot.assignment = assignment;
    slot.since = this.now();
    slot.reservedAt = this.now();
    this.byMatch.set(matchId, slot.id);
    this.counters.reserved++;
    this.event("reserved", { serverId: slot.id, matchId, address: slot.host + ":" + slot.port, map: assignment.map,
      playlist: assignment.playlist, players: assignment.players, bots: assignment.bots, teams: assignment.teams ? assignment.teams.length : 0 });
    if (slot.kind === "launch" && !this.start(slot)) {
      const reason = "launch-failed";
      this.free(slot, reason);
      return { error: reason };
    }
    return { serverId: slot.id, host: slot.host, port: slot.port };
  }

  // Launch mode: starts the slot's process.
  start(slot) {
    const a = slot.assignment;
    const values = { port: slot.port, host: this.launch.host || "127.0.0.1", publicHost: slot.host, serverId: slot.id,
      matchId: a.matchId, map: a.map, mapIndex: a.mapIndex, playlist: a.playlist, teamSize: a.teamSize, bots: a.bots,
      field: a.field, backend: this.options.backendUrl ? this.options.backendUrl() : "" };
    const argv = this.launch.command.map((x) => fill(x, values));
    let out = "ignore";
    try {
      if (this.launch.logDir) {
        fs.mkdirSync(this.launch.logDir, { recursive: true });
        out = fs.openSync(path.join(this.launch.logDir, slot.id + ".log"), "a");
      }
      // The secret goes in the environment, never on the command line (visible to every process).
      const env = Object.assign({}, process.env, { CULLING_GAMESERVER_ID: slot.id, CULLING_GAMESERVER_SECRET: this.secretFor(slot.id),
        CULLING_BACKEND_URL: values.backend, CULLING_MATCH_ID: a.matchId });
      const proc = this.spawn(argv[0], argv.slice(1), { cwd: this.launch.cwd || undefined, env, stdio: ["ignore", out, out], windowsHide: true });
      slot.proc = proc;
      proc.on("error", (e) => { this.event("process-error", { serverId: slot.id, matchId: slot.matchId, error: e.message }); this.lose(slot, "launch-failed"); });
      proc.on("exit", (code, signal) => {
        slot.proc = null;
        this.event("process-exit", { serverId: slot.id, matchId: slot.matchId, code, signal });
        if (slot.state === "reserved" || slot.state === "running") this.lose(slot, "process-exited");
        else this.slots.delete(slot.id);
      });
      this.event("launched", { serverId: slot.id, matchId: a.matchId, pid: proc.pid, port: slot.port });
      return true;
    } catch (e) {
      this.event("launch-failed", { serverId: slot.id, matchId: a.matchId, error: e.message });
      return false;
    } finally {
      if (typeof out === "number") try { fs.closeSync(out); } catch { /* the child keeps its own handle */ }
    }
  }

  // ------------------------------------------------------------ game-server requests

  // A process says it is up (pool: once it starts; launch: once it has loaded).
  register(serverId, info = {}) {
    const slot = this.slots.get(serverId);
    if (!slot) return { error: "unknown-server" };
    slot.lastBeat = this.now();
    slot.version = typeof info.version === "string" ? info.version.slice(0, 40) : null;
    // Registering again while it had a match (a pool server is only ever
    // reserved once registered; a launched one registers once, before ready):
    // the process restarted and lost the match.
    if (slot.state === "running" || (slot.kind === "pool" && slot.state === "reserved")) this.lose(slot, "server-restarted");
    if (slot.kind === "pool" && slot.state === "offline") { slot.state = "idle"; slot.since = this.now(); }
    this.event("registered", { serverId, state: slot.state, version: slot.version });
    return { ok: true, heartbeatMs: this.options.heartbeatMs, assignment: slot.state === "reserved" || slot.state === "running" ? slot.assignment : null };
  }

  // A heartbeat: { matchId, state, players, cpu, memMB, tickMs, ... }. The
  // answer carries the server's assignment (null: stay idle) and `cancel`
  // when the match it reports is no longer its own.
  heartbeat(serverId, hb = {}) {
    const slot = this.slots.get(serverId);
    if (!slot) return { error: "unknown-server" };
    slot.lastBeat = this.now();
    slot.stats = pickStats(hb);
    if (slot.kind === "pool" && slot.state === "offline") { slot.state = "idle"; slot.since = this.now(); this.event("online", { serverId }); }
    const reported = typeof hb.matchId === "string" && hb.matchId ? hb.matchId : null;
    // Running, but the server says it has no match (or another): it dropped ours.
    if (slot.state === "running" && reported !== slot.matchId) {
      this.lose(slot, "server-dropped-match");
      return { ok: true, assignment: null, cancel: reported };
    }
    const cancel = reported && reported !== slot.matchId ? reported : null;
    if (cancel) this.event("stale-match", { serverId, matchId: cancel });
    return { ok: true, heartbeatMs: this.options.heartbeatMs,
      assignment: slot.state === "reserved" || slot.state === "running" ? slot.assignment : null, cancel };
  }

  // The server has the map loaded and is taking players for matchId.
  ready(serverId, matchId) {
    const slot = this.slots.get(serverId);
    if (!slot) return { error: "unknown-server" };
    slot.lastBeat = this.now();
    if (slot.matchId !== matchId) return { error: "not-your-match" };
    if (slot.state === "running") return { ok: true, duplicate: true };
    if (slot.state !== "reserved") return { error: "not-reserved" };
    slot.state = "running";
    slot.readyAt = this.now();
    this.counters.ready++;
    this.event("ready", { serverId, matchId, ms: slot.readyAt - slot.reservedAt });
    this.emit("ready", matchId, slot);
    return { ok: true };
  }

  // The server gives up on its match (it can't run it).
  abort(serverId, matchId, reason) {
    const slot = this.slots.get(serverId);
    if (!slot) return { error: "unknown-server" };
    if (slot.matchId !== matchId || (slot.state !== "reserved" && slot.state !== "running")) return { error: "not-your-match" };
    this.lose(slot, "server-aborted" + (reason ? ":" + String(reason).replace(/[^\w-]/g, "").slice(0, 40) : ""));
    return { ok: true };
  }

  // Whether serverId is the one running matchId now.
  owns(serverId, matchId) {
    const slot = this.slots.get(serverId);
    return !!slot && slot.matchId === matchId && (slot.state === "reserved" || slot.state === "running");
  }

  // After a backend restart: a server reporting a match the backend still
  // knows (persisted) takes it up again as running.
  adopt(serverId, matchId, assignment) {
    const slot = this.slots.get(serverId);
    if (!slot || (slot.state !== "idle" && slot.state !== "offline")) return false;
    slot.state = "running";
    slot.matchId = matchId;
    slot.assignment = assignment;
    slot.lastBeat = this.now();
    slot.reservedAt = slot.readyAt = this.now();
    this.byMatch.set(matchId, serverId);
    this.event("adopted", { serverId, matchId });
    return true;
  }

  // After a backend restart in launch mode: a process started before it may
  // still run a persisted match; its requests are accepted so it can be
  // adopted (forget() drops it if it never reports).
  expect(serverId, host, port) {
    if (!this.launch || this.slots.has(serverId)) return;
    this.slots.set(serverId, { id: serverId, host, port, kind: "launch", state: "offline", lastBeat: 0, matchId: null,
      assignment: null, since: this.now(), stats: null, proc: null });
  }

  forget(serverId) {
    const slot = this.slots.get(serverId);
    if (slot && slot.kind === "launch" && slot.state === "offline") this.slots.delete(serverId);
  }

  // ------------------------------------------------------------ ending

  // The match is over (its result arrived) or cancelled: the slot is free.
  release(matchId, why = "ended") {
    const id = this.byMatch.get(matchId);
    const slot = id ? this.slots.get(id) : null;
    if (!slot || slot.matchId !== matchId) return false;
    this.free(slot, why);
    return true;
  }

  free(slot, why) {
    const matchId = slot.matchId;
    this.byMatch.delete(matchId);
    this.counters.released++;
    this.event("released", { serverId: slot.id, matchId, reason: why, ms: slot.reservedAt ? this.now() - slot.reservedAt : null });
    slot.matchId = null;
    slot.assignment = null;
    slot.since = this.now();
    if (slot.kind === "pool") {
      // Healthy pool servers take the next match; one that went silent waits for its next heartbeat.
      slot.state = this.now() - slot.lastBeat < this.options.heartbeatTimeoutMs && !/timeout|restarted/.test(why) ? "idle" : "offline";
    } else {
      slot.state = "released";
      const proc = slot.proc;
      if (!proc) { this.slots.delete(slot.id); return; }
      // The process should exit by itself once its match ends; if not, it is stopped.
      const t = setTimeout(() => { try { proc.kill(); } catch { /* gone */ } }, /exited|launch/.test(why) ? 0 : this.options.releaseGraceMs);
      if (t.unref) t.unref();
    }
  }

  // A reserved or running match is lost: the slot is freed and 'lost' emitted.
  lose(slot, reason) {
    const matchId = slot.matchId;
    if (!matchId) return;
    this.counters.lost++;
    this.event("lost", { serverId: slot.id, matchId, reason, state: slot.state });
    this.free(slot, reason);
    this.emit("lost", matchId, reason, slot);
  }

  // Timeouts, from a timer.
  check() {
    const t = this.now();
    for (const slot of [...this.slots.values()]) {
      try {
        if (slot.state === "reserved" && t - slot.reservedAt > this.options.readyTimeoutMs) this.lose(slot, "ready-timeout");
        else if (slot.state === "running" && t - slot.lastBeat > this.options.heartbeatTimeoutMs) this.lose(slot, "heartbeat-timeout");
        else if (slot.state === "running" && t - slot.readyAt > this.options.maxMatchMs) this.lose(slot, "match-timeout");
        else if (slot.state === "idle" && slot.kind === "pool" && t - slot.lastBeat > this.options.heartbeatTimeoutMs) {
          slot.state = "offline";
          this.event("offline", { serverId: slot.id });
        }
      } catch (e) { this.event("check-failed", { serverId: slot.id, error: e.message }); }
    }
  }

  stop() {
    clearInterval(this.timer);
    for (const s of this.slots.values()) if (s.proc) try { s.proc.kill(); } catch { /* gone */ }
  }

  stats() {
    const states = {};
    for (const s of this.slots.values()) states[s.state] = (states[s.state] || 0) + 1;
    return { mode: this.pool.length ? "pool" : this.launch ? "launch" : "none", maxMatches: this.maxMatches, active: this.active(),
      states, counters: Object.assign({}, this.counters),
      servers: [...this.slots.values()].map((s) => ({ id: s.id, address: s.host + ":" + s.port, state: s.state, matchId: s.matchId,
        lastBeatAgoMs: s.lastBeat ? this.now() - s.lastBeat : null, stats: s.stats })) };
  }
}

// What a heartbeat may report for capacity measurement (numbers only).
function pickStats(hb) {
  const out = {};
  for (const k of ["players", "bots", "cpu", "memMB", "tickMs", "tickRate", "kbpsOut", "kbpsIn"]) {
    const v = Number(hb[k]);
    if (Number.isFinite(v)) out[k] = Math.round(v * 100) / 100;
  }
  return out;
}

module.exports = { Allocator, DEFAULTS, sign, safeEqualHex, serverSecret, loadSecret, parsePool, parsePorts, parseCommand, fill };

// `node allocator.js secret <serverId> [dataDir]`: the secret to give that game server.
if (require.main === module) {
  const [cmd, id, dir] = process.argv.slice(2);
  if (cmd !== "secret" || !id) {
    console.error("usage: node allocator.js secret <serverId> [dataDir]");
    process.exit(2);
  }
  const dataDir = dir || process.env.CULLING_DATA_DIR || path.join(__dirname, "data");
  const master = loadSecret(process.env.CULLING_GAMESERVER_SECRET, path.join(dataDir, "gameserver-secret.txt"));
  console.log(serverSecret(master, id));
}
