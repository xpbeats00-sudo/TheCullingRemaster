// A stand-in game server for shared-match tests (no real game server exists
// yet: route A has no server build, route B is in progress).
//
// It speaks the backend's game-server API exactly as a real one must
// (docs/PARTY_MATCHMAKING_REWORK.md): signed register, heartbeats (whose
// answers carry its match assignment), ready, ticket checks and the one
// authoritative result. It also listens on its own host:port - the address
// the players are sent to - where a "client" joins with the ticket in its URL
// options, as the stock client's "open <server>?Nonce=<ticket>" carries it:
//
//   GET /join?nonce=<ticket>&userid=<id>         -> 200 { team } / 403 { error }  (PreLogin)
//   GET /state                                    -> its assignment and who joined
//   POST /control/result   (JSON stats)           -> posts the match result
//   POST /control/crash                            -> stops dead (no more heartbeats; exits when run as a process)
//   POST /control/abort                            -> tells the backend it can't run the match
//
// Use it in-process (new FakeGameServer({...}).start()) for pool mode, or as
// a process (launch mode): node fake_gameserver.js --port N [--host H]
// [--ready-delay-ms N] [--no-ready], with CULLING_GAMESERVER_ID,
// CULLING_GAMESERVER_SECRET and CULLING_BACKEND_URL in its environment (the
// allocator sets them).
"use strict";

const http = require("http");
const { URL } = require("url");
const { sign } = require("../allocator");

function post(base, path, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(path, base);
    const req = http.request({ host: u.hostname, port: u.port, path: u.pathname, method: "POST", headers }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    req.end(body);
  });
}

class FakeGameServer {
  // opts: backend (URL), serverId, secret, host, port, heartbeatMs, readyDelayMs, ready (false: never posts ready)
  constructor(opts) {
    this.o = Object.assign({ host: "127.0.0.1", heartbeatMs: 200, readyDelayMs: 50, ready: true }, opts);
    this.assignment = null;
    this.joined = new Map();       // userID -> team
    this.refused = [];
    this.dead = false;
    this.readyPosted = null;
    this.timer = null;
    this.http = null;
    this.events = [];
  }

  // A signed request to the backend.
  async call(action, payload) {
    const body = JSON.stringify(Object.assign({ serverId: this.o.serverId }, payload));
    const ts = Date.now();
    return post(this.o.backend, "/api/gameserver/" + action, body, {
      "Content-Type": "text/plain", "X-Culling-Server": this.o.serverId, "X-Culling-Timestamp": String(ts),
      "X-Culling-Signature": sign(this.o.secret, ts, action, body) });
  }

  async start() {
    await new Promise((resolve, reject) => {
      this.http = http.createServer((req, res) => this.serve(req, res).catch((e) => { res.writeHead(500); res.end(String(e.message)); }));
      this.http.on("error", reject);
      this.http.listen(this.o.port, this.o.host, resolve);
    });
    const r = await this.call("register", { host: this.o.host, port: this.o.port, version: "fake-1" });
    this.events.push(["register", r.status]);
    if (r.status !== 200) throw new Error("register failed: " + JSON.stringify(r.json));
    if (r.json.heartbeatMs) this.o.heartbeatMs = Math.min(this.o.heartbeatMs, r.json.heartbeatMs);
    this.take(r.json.assignment);
    this.beat();
    return this;
  }

  beat() {
    this.timer = setTimeout(async () => {
      if (this.dead) return;
      try {
        const r = await this.call("heartbeat", { matchId: this.assignment ? this.assignment.matchId : null,
          state: this.assignment ? (this.readyPosted ? "running" : "loading") : "idle",
          players: this.joined.size, bots: this.assignment ? this.assignment.bots : 0, cpu: 12.5, memMB: 900, tickMs: 33.3, tickRate: 30 });
        if (r.json && r.json.cancel && this.assignment && r.json.cancel === this.assignment.matchId) this.endMatch("cancelled");
        else if (r.status === 200) this.take(r.json.assignment);
      } catch { /* backend down: keep trying */ }
      this.beat();
    }, this.o.heartbeatMs);
    if (this.timer.unref) this.timer.unref();
  }

  // An assignment from the backend: load the "map", then post ready.
  take(a) {
    if (!a) {
      if (this.assignment && this.readyPosted) this.endMatch("released");
      else if (this.assignment && !this.readyPosted) this.endMatch("unassigned");
      return;
    }
    if (this.assignment && this.assignment.matchId === a.matchId) { this.assignment = a; return; }
    this.assignment = a;
    this.joined.clear();
    this.readyPosted = null;
    this.events.push(["assignment", a.matchId]);
    if (!this.o.ready) return;
    setTimeout(async () => {
      if (this.dead || !this.assignment || this.assignment.matchId !== a.matchId) return;
      const r = await this.call("ready", { matchId: a.matchId });
      this.readyPosted = r.status === 200 ? Date.now() : null;
      this.events.push(["ready", r.status]);
    }, this.o.readyDelayMs);
  }

  endMatch(why) {
    this.events.push(["end", why]);
    this.assignment = null;
    this.joined.clear();
    this.readyPosted = null;
  }

  // PreLogin: the ticket from the URL options, checked with the backend.
  async join(ticket, userID) {
    if (!this.assignment) return { status: 503, json: { error: "no-match" } };
    const r = await this.call("verify-ticket", { matchId: this.assignment.matchId, ticket, userID });
    if (r.status === 200 && r.json.ok) this.joined.set(r.json.userID, r.json.team);
    else this.refused.push(r.json && r.json.error);
    return r;
  }

  // The authoritative result. stats: { teams: [{team, placement}], players: { userID: {placement, kills, damage, timeAlive} } }
  // (defaults: every assigned player, team 1 first).
  async result(stats = {}) {
    const a = this.assignment;
    if (!a) return { status: 0, json: { error: "no-match" } };
    const players = [];
    for (const t of a.teams) for (const p of t.players) {
      const s = (stats.players && stats.players[p.userID]) || {};
      players.push(Object.assign({ userID: p.userID, team: t.team, placement: t.team, kills: 1, damage: 100, timeAlive: 300,
        joined: this.joined.has(p.userID) }, s));
    }
    const teams = stats.teams || a.teams.map((t) => ({ team: t.team, placement: t.team, outcome: t.team === 1 ? "won" : "out" }));
    const body = Object.assign({ matchId: a.matchId, players, teams, duration: 600 }, stats.extra || {});
    if (stats.raw) Object.assign(body, stats.raw);
    const r = await this.call("result", body);
    if (r.status === 200) this.endMatch("result");
    return r;
  }

  crash() {
    this.dead = true;
    clearTimeout(this.timer);
    if (this.http) this.http.close();
    if (this.o.exitOnCrash) process.exit(3);
  }

  stop() { this.crash(); }

  async serve(req, res) {
    const u = new URL(req.url, "http://x");
    const send = (status, json) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(json)); };
    let body = "";
    for await (const c of req) body += c;
    if (req.method === "GET" && u.pathname === "/join") {
      const r = await this.join(u.searchParams.get("nonce"), u.searchParams.get("userid") || undefined);
      return send(r.status, r.json);
    }
    if (req.method === "GET" && u.pathname === "/state") return send(200, { assignment: this.assignment, joined: [...this.joined], events: this.events });
    if (req.method === "POST" && u.pathname === "/control/result") {
      const r = await this.result(body ? JSON.parse(body) : {});
      return send(r.status || 500, r.json);
    }
    if (req.method === "POST" && u.pathname === "/control/abort") {
      const r = await this.call("abort", { matchId: this.assignment && this.assignment.matchId, reason: "test" });
      return send(r.status, r.json);
    }
    if (req.method === "POST" && u.pathname === "/control/crash") { send(200, { ok: true }); return setTimeout(() => this.crash(), 20); }
    send(404, { error: "not-found" });
  }
}

module.exports = { FakeGameServer, post };

// As a process (launch mode).
if (require.main === module) {
  const arg = (name, d) => { const i = process.argv.indexOf("--" + name); return i > 0 ? process.argv[i + 1] : d; };
  const gs = new FakeGameServer({ backend: process.env.CULLING_BACKEND_URL, serverId: process.env.CULLING_GAMESERVER_ID,
    secret: process.env.CULLING_GAMESERVER_SECRET, host: arg("host", "127.0.0.1"), port: parseInt(arg("port", "0"), 10),
    readyDelayMs: parseInt(arg("ready-delay-ms", "50"), 10), ready: !process.argv.includes("--no-ready"), exitOnCrash: true });
  gs.start().catch((e) => { console.error(e.message); process.exit(1); });
  // A launched server exits once its match is over.
  setInterval(() => { if (gs.events.some((e) => e[0] === "end")) process.exit(0); }, 100);
}
