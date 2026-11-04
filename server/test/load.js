// Load test for the account server: N concurrent game clients, each from its
// own address (X-Forwarded-For over loopback, as Caddy sends it), doing what
// a player's menu does, in a loop:
//
//   login (HTTP) -> socket login -> catalog / premium types / leaderboard / root data
//   loop: ranked fetch -> join-mm -> match-ready (1.5 s server timer) -> "play"
//         -> matchresult + setlevel (HTTP) -> set-card (50%) -> get-cards
//         -> purchase (10%, players only) -> season summary -> menu idle
//
// Matches are played on the player's PC against bots, so the server sees
// nothing during a match: "play" is a sleep of --match-seconds (default 20 s,
// i.e. matches about 30-50x shorter than real ones, so the request rate per
// client is that much higher than real play).
//
// The server is started fresh per run (own data folder, NODE_ENV=production
// like the service, --expose-gc so heap can be compared after GC), and its
// /metrics is sampled every 5 s for event-loop delay, CPU and memory.
// Clients run in several worker processes so the load generator's own event
// loop doesn't distort the latencies at high client counts.
//
//   node test/load.js --clients 30 --duration 300               5-minute run
//   node test/load.js --clients 30 --duration 1200               20-minute soak
//   node test/load.js --steps 30,100,300,1000 --duration 90      breaking point
// Options: --match-seconds 20 --transport websocket|polling|default --port 8140
//          --workers N --out results.json --stop-p95 200 --ramp-seconds 60
//          --server path/to/server.js   (another build, e.g. the previous one, for a
//                                        before/after comparison; without /metrics only
//                                        client-side numbers are reported)
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, fork } = require("child_process");
const { monitorEventLoopDelay } = require("perf_hooks");

const args = process.argv.slice(2);
const opt = (name, def) => { const i = args.indexOf("--" + name); return i >= 0 ? args[i + 1] : def; };

// ---------------------------------------------------------------- worker

if (process.env.LOAD_WORKER) {
  const ioClient = require("socket.io-client");
  const cfg = JSON.parse(process.env.LOAD_WORKER);
  const catalog = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "data", "catalog.json"), "utf8"));
  const forSale = catalog.filter((i) => i.source && !i.rankedReward).map((i) => i.tid);
  const cards = catalog.filter((i) => i.class === "CullingCardDataAsset").map((i) => i.tid);
  const lat = {};                      // op -> [ms]
  const errors = {};                   // kind -> count
  const counts = { cycles: 0, purchasesOk: 0, purchasesRefused: 0 };
  const rec = (op, ms) => (lat[op] || (lat[op] = [])).push(ms);
  const err = (kind) => { errors[kind] = (errors[kind] || 0) + 1; };
  const eld = monitorEventLoopDelay({ resolution: 10 });
  eld.enable();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const rand = (a, b) => a + Math.random() * (b - a);
  const pick = (xs) => xs[Math.floor(Math.random() * xs.length)];
  let running = true;
  const deadline = Date.now() + cfg.durationMs;

  function request(ip, agent, method, url, body, token) {
    return new Promise((resolve) => {
      const t0 = performance.now();
      const headers = { "Content-Type": "application/json", "X-Forwarded-For": ip };
      if (token) headers.Authorization = "Bearer " + token;
      const req = http.request({ host: "127.0.0.1", port: cfg.port, path: url, method, headers, agent, timeout: 10000 }, (res) => {
        let data = "";
        res.on("data", (c) => (data += c));
        res.on("end", () => {
          let json = null;
          try { json = JSON.parse(data); } catch { /* not json */ }
          resolve({ status: res.statusCode, json, ms: performance.now() - t0 });
        });
      });
      req.on("timeout", () => req.destroy(new Error("timeout")));
      req.on("error", (e) => resolve({ status: 0, error: e.message, ms: performance.now() - t0 }));
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
  }

  async function http_(c, op, method, url, body, okStatuses = [200]) {
    const r = await request(c.ip, c.agent, method, url, body, c.token);
    if (!okStatuses.includes(r.status)) { err(`${op} ${r.status || r.error}`); return null; }
    rec(op, r.ms);
    return r;
  }

  // engine.io-client marks its websocket writable again with setTimeout(0)
  // after each send; on Windows that timer takes up to ~15.6 ms, so a
  // second emit right after a first waits in the client. Wait for that before
  // starting the clock, so the latency measured is the server's.
  function writable(c) {
    const t = c.socket.io.engine && c.socket.io.engine.transport;
    if (!t || t.writable) return Promise.resolve();
    return new Promise((resolve) => { t.once("drain", resolve); setTimeout(resolve, 100); });
  }

  // Emit and wait for the first of `replies`; records latency under `op`.
  async function ask(c, op, event, payload, replies, timeoutMs = 10000) {
    await writable(c);
    return new Promise((resolve) => {
      const t0 = performance.now();
      let done = false;
      const handlers = [];
      const finish = (name, data) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        for (const [n, h] of handlers) c.socket.off(n, h);
        if (name) rec(op, performance.now() - t0); else err(op + " timeout");
        resolve(name ? { name, data, ms: performance.now() - t0 } : null);
      };
      for (const n of replies) { const h = (d) => finish(n, d); handlers.push([n, h]); c.socket.once(n, h); }
      const timer = setTimeout(() => finish(null), timeoutMs);
      if (payload === undefined) c.socket.emit(event); else c.socket.emit(event, payload);
    });
  }

  async function connect(c) {
    const t0 = performance.now();
    const transports = cfg.transport === "default" ? ["polling", "websocket"] : [cfg.transport];
    // forceNode: Node 22+ has a global browser-style WebSocket, which
    // engine.io-client 3.5 would pick, and which can't send X-Forwarded-For.
    c.socket = ioClient(`http://127.0.0.1:${cfg.port}`, { transports, forceNew: true, reconnection: false, forceNode: true,
      extraHeaders: { "X-Forwarded-For": c.ip }, timeout: 10000 });
    c.socket.on("disconnect", (reason) => { if (running && Date.now() < deadline) err("socket disconnect: " + reason); });
    c.socket.on("connect_error", () => err("socket connect_error"));
    const ready = await new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), 10000);
      c.socket.once("login_ready", () => { clearTimeout(timer); resolve(true); });
    });
    if (!ready) { err("socket login_ready timeout"); return false; }
    rec("socket connect", performance.now() - t0);
    const auth = await ask(c, "socket login", "login", { token: c.token }, ["auth-response", "auth-fail"]);
    if (!auth || auth.name !== "auth-response") { err("socket auth failed"); return false; }
    return true;
  }

  async function client(i) {
    const n = cfg.firstClient + i;
    const isPlayer = n % 3 === 0;                    // 1 in 3 "real players", the rest bot accounts
    const c = {
      userID: (isPlayer ? "steam:765611990" : "steam:765611991") + String(n).padStart(8, "0"),
      ip: `10.${(n >> 16) & 255}.${(n >> 8) & 255}.${n & 255}`,
      agent: new http.Agent({ keepAlive: true, maxSockets: 2 })
    };
    await sleep(rand(0, cfg.rampMs));                // ramp up
    const login = await request(c.ip, c.agent, "POST", "/api/login", { userid: c.userID, authType: "steam", appid: 437220, build: "load" });
    if (login.status !== 200) { err("POST /api/login " + (login.status || login.error)); return; }
    rec("POST /api/login", login.ms);
    c.token = login.json.token;
    if (!(await connect(c))) return;
    // What the menu asks for after login (catalog with a stale cached version:
    // the worst case, as on the day of a new release).
    await ask(c, "get-inventory-types (full catalog)", "get-inventory-types", "stale", ["inventory-types-response"]);
    await ask(c, "get-premium-types", "get-premium-types", undefined, ["premium-types-response"]);
    await ask(c, "player-leaderboard-request", "player-leaderboard-request", undefined, ["player-leaderboard-response"]);
    await http_(c, "GET /api", "GET", "/api");
    await ask(c, "get-entitlements", "get-entitlements", undefined, ["entitlements-response"]);

    while (Date.now() < deadline) {
      const ranked = Math.random() < 0.5;
      await http_(c, "GET /api/ranked", "GET", "/api/ranked");
      const t0 = performance.now();
      const ready = new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 10000);
        c.socket.once("match-ready", (m) => { clearTimeout(timer); resolve(m); });
      });
      const ack = await ask(c, "join-mm", "join-mm", { queueName: ranked ? "ranked_ffa" : "ffa" }, ["join-mm-ack"]);
      if (!ack) continue;
      const m = await ready;
      if (!m) { err("match-ready timeout"); continue; }
      if (!String(m.gameServer).startsWith("offline:")) err("match-ready unexpected gameServer");
      rec("match-ready lateness (after the 1.5 s timer)", Math.max(0, performance.now() - t0 - 1500));
      await sleep(cfg.matchMs * rand(0.7, 1.3));      // the match runs on the player's PC
      if (Date.now() >= deadline) break;
      const victory = Math.random() < 0.05;
      const res = await http_(c, "POST /api/matchresult", "POST", "/api/matchresult", {
        victory, kills: Math.floor(rand(0, 8)), damage: rand(0, 900), timeAlive: rand(10, cfg.matchMs / 1000),
        func: Math.floor(rand(0, 300)), placement: victory ? 1 : Math.floor(rand(2, 51))
      });
      if (res && res.json.stats) await http_(c, "POST /api/setlevel", "POST", "/api/setlevel", { level: res.json.stats.level || 1 });
      if (Math.random() < 0.5) c.socket.emit("set-card", { cardID: pick(cards) });
      await ask(c, "get-cards", "get-cards", { users: Array.from({ length: 10 }, () => c.userID) }, ["get-cards-result"]);
      if (isPlayer && Math.random() < 0.1) {
        const r = await ask(c, "purchase-entitlement", "purchase-entitlement", { entitlementID: String(pick(forSale)) },
          ["purchase-success", "purchase-fail"]);
        if (r && r.name === "purchase-success") counts.purchasesOk++; else if (r) counts.purchasesRefused++;
      }
      await ask(c, "get-season-summary", "get-season-summary", { userID: c.userID }, ["season-summary-response"]);
      counts.cycles++;
      await sleep(rand(3000, 8000));                  // in the menus
    }
    c.socket.close();
    c.agent.destroy();
  }

  (async () => {
    await Promise.all(Array.from({ length: cfg.clients }, (_, i) => client(i).catch((e) => err("client crash: " + e.message))));
    running = false;
    process.send({ lat, errors, counts, eld: { p99Ms: eld.percentile(99) / 1e6, maxMs: eld.max / 1e6 } }, () => process.exit(0));
  })();
  return;
}

// ---------------------------------------------------------------- controller

function percentile(sorted, p) {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))];
}
const r2 = (n) => Math.round(n * 100) / 100;

function getJSON(port, url) {
  return new Promise((resolve, reject) => {
    http.get({ host: "127.0.0.1", port, path: url, timeout: 10000 }, (res) => {
      let d = "";
      res.on("data", (c) => (d += c));
      res.on("end", () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on("error", reject).on("timeout", function () { this.destroy(new Error("timeout")); });
  });
}

async function startServer(port, serverFile) {
  // Something already on the port would be measured instead of this build.
  try { await getJSON(port, "/health"); throw new Error(`port ${port} is already in use: stop that server first`); } catch (e) {
    if (/already in use/.test(e.message)) throw e;
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "culling-load-"));
  fs.copyFileSync(path.join(__dirname, "..", "data", "catalog.json"), path.join(dir, "catalog.json"));
  const levels = path.join(__dirname, "..", "data", "levels.json");
  if (fs.existsSync(levels)) fs.copyFileSync(levels, path.join(dir, "levels.json"));
  const out = fs.openSync(path.join(dir, "server.log"), "a");
  const proc = spawn(process.execPath, ["--expose-gc", serverFile], {
    env: Object.assign({}, process.env, { CULLING_PORT: String(port), CULLING_DATA_DIR: dir, NODE_ENV: "production",
      CULLING_UITRACE: "0", NODE_PATH: path.join(__dirname, "..", "node_modules") }),
    stdio: ["ignore", out, out]
  });
  for (let i = 0; i < 100; i++) {
    if (proc.exitCode !== null) break;
    try {
      await getJSON(port, "/health");
      await new Promise((r) => setTimeout(r, 300));
      if (proc.exitCode !== null) break;               // e.g. EADDRINUSE after all
      const m = await getJSON(port, "/metrics");
      if (m.pid !== undefined && m.pid !== proc.pid) throw new Error(`port ${port} is answered by pid ${m.pid}, not the server started`);
      return { proc, dir };
    } catch (e) {
      if (/answered by pid/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 100));
    }
  }
  throw new Error("server did not start (see " + path.join(dir, "server.log") + ")");
}

async function run({ clients, durationMs, port, matchMs, transport, workers, serverFile, rampSeconds }) {
  const server = await startServer(port, serverFile);
  const hasMetrics = "uptimeSeconds" in (await getJSON(port, "/metrics"));
  const samples = [];
  let lastCpu = null;
  const NONE = { cpu: { total: { userMs: 0, systemMs: 0 } }, memoryMB: {}, eventLoopDelay: { sinceLastMinute: {}, sinceStart: null },
    eventLoopUtilization: {}, totals: { requests: 0, socketEvents: 0, errors: null }, saving: null };
  const sample = async (gc) => {
    const m = hasMetrics ? await getJSON(port, "/metrics" + (gc ? "?gc=1" : "")) : NONE;
    const cpuMs = m.cpu.total.userMs + m.cpu.total.systemMs;
    const t = Date.now();
    const s = { t, heapMB: m.memoryMB.heapUsed, rssMB: m.memoryMB.rss, sockets: m.connectedSockets, users: m.loggedInUsers,
      eldP99Ms: m.eventLoopDelay.sinceLastMinute.p99Ms, eldMaxMs: m.eventLoopDelay.sinceLastMinute.maxMs,
      elu: m.eventLoopUtilization.sinceLastMinute,
      cpuPercent: lastCpu ? r2(((cpuMs - lastCpu.ms) / Math.max(1, t - lastCpu.t)) * 100) : null };
    lastCpu = { ms: cpuMs, t };
    return { s, m };
  };
  const t0 = Date.now();
  const baseline = (await sample(true)).m;
  // Clients log in spread over this time (default: 20 ms apart, at most 10 s).
  const rampMs = rampSeconds !== null ? rampSeconds * 1000 : Math.min(10000, clients * 20);
  const perWorker = Math.ceil(clients / workers);
  const results = [];
  const procs = [];
  for (let w = 0; w < workers; w++) {
    const n = Math.min(perWorker, clients - w * perWorker);
    if (n <= 0) break;
    const cfg = { port, clients: n, firstClient: w * perWorker, durationMs, matchMs, transport, rampMs };
    const child = fork(__filename, [], { env: Object.assign({}, process.env, { LOAD_WORKER: JSON.stringify(cfg) }) });
    let got = false;
    procs.push(new Promise((resolve) => {
      child.on("message", (m) => { got = true; results.push(m); });
      child.on("exit", (code, signal) => {
        // A worker that dies takes its clients' numbers with it: count that as errors, never as fewer clients.
        if (!got) results.push({ lat: {}, errors: { [`load worker ${w} exited without results (code ${code}, ${signal || "no signal"}; ${n} clients)`]: n },
          counts: { cycles: 0, purchasesOk: 0, purchasesRefused: 0 }, eld: { p99Ms: 0, maxMs: 0 } });
        resolve();
      });
    }));
  }
  // Heap after GC at start (all clients connected), middle and end.
  const heapMarks = {};
  const timer = setInterval(async () => {
    try { samples.push((await sample(false)).s); } catch { /* server busy */ }
  }, 5000);
  const markAt = async (name, atMs) => {
    await new Promise((r) => setTimeout(r, Math.max(0, t0 + atMs - Date.now())));
    try { const { m } = await sample(true); heapMarks[name] = { atS: Math.round((Date.now() - t0) / 1000), heapMB: m.memoryMB.heapUsed, rssMB: m.memoryMB.rss }; } catch { /* */ }
  };
  const marks = Promise.all([markAt("start", rampMs + 5000), markAt("middle", durationMs / 2), markAt("end", durationMs - 2000)]);
  await Promise.all(procs);
  await marks;
  clearInterval(timer);
  const final = hasMetrics ? await getJSON(port, "/metrics") : NONE;

  // Merge the workers' results.
  const lat = {}, errors = {}, counts = { cycles: 0, purchasesOk: 0, purchasesRefused: 0 };
  let clientEldMax = 0, clientEldP99 = 0;
  for (const r of results) {
    for (const [k, v] of Object.entries(r.lat)) (lat[k] || (lat[k] = [])).push(...v);
    for (const [k, v] of Object.entries(r.errors)) errors[k] = (errors[k] || 0) + v;
    for (const k of Object.keys(counts)) counts[k] += r.counts[k];
    clientEldMax = Math.max(clientEldMax, r.eld.maxMs);
    clientEldP99 = Math.max(clientEldP99, r.eld.p99Ms);
  }
  const ops = {};
  const all = [];
  for (const [k, v] of Object.entries(lat)) {
    v.sort((a, b) => a - b);
    if (!k.startsWith("match-ready lateness")) all.push(...v);
    ops[k] = { count: v.length, p50: r2(percentile(v, 50)), p95: r2(percentile(v, 95)), p99: r2(percentile(v, 99)), max: r2(v[v.length - 1]) };
  }
  all.sort((a, b) => a - b);
  const secs = (Date.now() - t0) / 1000;
  const cpuVals = samples.map((s) => s.cpuPercent).filter((x) => x !== null);
  const summary = {
    clients, transport, durationS: Math.round(secs), matchSeconds: matchMs / 1000, rampSeconds: rampMs / 1000,
    operations: all.length, opsPerSecond: r2(all.length / secs),
    server: serverFile, hasMetrics,
    serverRequestsPerMinute: r2(final.totals.requests / (secs / 60)), serverSocketEventsPerMinute: r2(final.totals.socketEvents / (secs / 60)),
    latencyAllMs: { p50: r2(percentile(all, 50)), p95: r2(percentile(all, 95)), p99: r2(percentile(all, 99)), max: r2(all[all.length - 1] || 0) },
    errors, errorCount: Object.values(errors).reduce((a, b) => a + b, 0),
    serverErrors: final.totals.errors,
    eventLoopDelayMs: final.eventLoopDelay.sinceStart,
    eventLoopUtilization: final.eventLoopUtilization.sinceStart,
    eventLoopUtilizationMaxMinute: Math.max(0, ...samples.map((x) => x.elu || 0)),
    cpuPercentOfOneCore: { mean: r2(cpuVals.reduce((a, b) => a + b, 0) / Math.max(1, cpuVals.length)), max: r2(Math.max(0, ...cpuVals)) },
    memoryMB: { baselineHeap: baseline.memoryMB.heapUsed, baselineRss: baseline.memoryMB.rss,
      maxHeap: Math.max(...samples.map((s) => s.heapMB), 0), maxRss: Math.max(...samples.map((s) => s.rssMB), 0), afterGC: heapMarks },
    saving: final.saving, counts, loadGenerator: { workers: results.length, eventLoopP99Ms: r2(clientEldP99), eventLoopMaxMs: r2(clientEldMax) },
    operationsMs: ops, samples
  };
  // Wait until it has really gone, so the next run can have the port.
  const gone = new Promise((r) => { if (server.proc.exitCode !== null) r(); else server.proc.once("exit", r); });
  server.proc.kill();
  await Promise.race([gone, new Promise((r) => setTimeout(r, 5000))]);
  await new Promise((r) => setTimeout(r, 300));
  try { fs.rmSync(server.dir, { recursive: true, force: true }); } catch { /* still closing */ }
  return summary;
}

function print(s) {
  console.log(`\n=== ${s.clients} clients, ${s.durationS} s, logins spread over ${s.rampSeconds} s, transport ${s.transport}, match ${s.matchSeconds} s`);
  console.log(`  operations ${s.operations} (${s.opsPerSecond}/s); server ${s.serverRequestsPerMinute} HTTP req/min, ${s.serverSocketEventsPerMinute} socket events/min`);
  console.log(`  latency all ops ms: p50 ${s.latencyAllMs.p50}  p95 ${s.latencyAllMs.p95}  p99 ${s.latencyAllMs.p99}  max ${s.latencyAllMs.max}`);
  console.log(`  errors: ${s.errorCount} ${JSON.stringify(s.errors)}  server: ${JSON.stringify(s.serverErrors)}`);
  console.log(`  event-loop delay ms: ${JSON.stringify(s.eventLoopDelayMs)}`);
  console.log(`  event-loop utilization: run ${s.eventLoopUtilization}, highest sample ${s.eventLoopUtilizationMaxMinute}`);
  console.log(`  cpu % of one core: mean ${s.cpuPercentOfOneCore.mean} max ${s.cpuPercentOfOneCore.max}`);
  console.log(`  memory MB: baseline heap ${s.memoryMB.baselineHeap} rss ${s.memoryMB.baselineRss}; max heap ${s.memoryMB.maxHeap} rss ${s.memoryMB.maxRss}`);
  console.log(`  heap after GC: ${JSON.stringify(s.memoryMB.afterGC)}`);
  if (s.saving) console.log(`  saves: profiles ${s.saving.profiles.writes} writes (${s.saving.profiles.changes} changes, last ${s.saving.profiles.lastBytes} B, longest ${s.saving.profiles.maxWriteMs} ms incl. fsync, longest on the event loop ${s.saving.profiles.maxBlockingMs} ms), sessions ${s.saving.sessions.writes} writes`);
  console.log(`  load generator: ${s.loadGenerator.workers} workers, own event loop p99 ${s.loadGenerator.eventLoopP99Ms} ms max ${s.loadGenerator.eventLoopMaxMs} ms`);
  console.log(`  cycles ${s.counts.cycles}, purchases ok ${s.counts.purchasesOk} refused ${s.counts.purchasesRefused}`);
  const rows = Object.entries(s.operationsMs).sort((a, b) => b[1].p95 - a[1].p95);
  for (const [k, v] of rows) console.log(`    ${k.padEnd(46)} n=${String(v.count).padStart(6)}  p50 ${String(v.p50).padStart(7)}  p95 ${String(v.p95).padStart(7)}  p99 ${String(v.p99).padStart(7)}  max ${String(v.max).padStart(8)}`);
}

(async () => {
  const port = parseInt(opt("port", "8140"), 10);
  const durationMs = parseFloat(opt("duration", "300")) * 1000;
  const matchMs = parseFloat(opt("match-seconds", "20")) * 1000;
  const transport = opt("transport", "websocket");
  const stopP95 = parseFloat(opt("stop-p95", "200"));
  const steps = opt("steps", null);
  const out = opt("out", null);
  const rampSeconds = opt("ramp-seconds", null) === null ? null : parseFloat(opt("ramp-seconds"));
  const serverFile = path.resolve(opt("server", path.join(__dirname, "..", "server.js")));
  const counts = steps ? steps.split(",").map(Number) : [parseInt(opt("clients", "30"), 10)];
  const host = { cpu: os.cpus()[0].model, logicalCpus: os.cpus().length, ramGB: r2(os.totalmem() / 2 ** 30), os: `${os.type()} ${os.release()}`, node: process.version };
  console.log("host", JSON.stringify(host));
  const runs = [];
  for (const clients of counts) {
    const workers = parseInt(opt("workers", String(Math.min(8, Math.max(1, Math.ceil(clients / 100))))), 10);
    const s = await run({ clients, durationMs, port, matchMs, transport, workers, serverFile, rampSeconds });
    print(s);
    runs.push(s);
    if (out) fs.writeFileSync(out, JSON.stringify({ host, runs }, null, 2));
    if (steps && (s.latencyAllMs.p95 > stopP95 || s.errorCount > 0)) {
      console.log(`\nbreaking point: ${clients} clients (p95 ${s.latencyAllMs.p95} ms, ${s.errorCount} errors)`);
      break;
    }
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
