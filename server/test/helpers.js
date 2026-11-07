// Shared test harness: a throwaway server on its own port and data folder,
// HTTP helpers, and logged-in socket clients.
//
// Ports: the server listens on a port the system picks (CULLING_PORT=0) and
// writes it to a file in its data folder; srv.port is that port once
// srv.ready() resolves. So suites run side by side (other worktrees, a
// server already on 8000) never collide. freePort() is for the tests that
// launch server.js themselves.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const net = require("net");
const ioClient = require("socket.io-client");

// A port nothing listens on now (the system's pick), for a server a test
// launches itself.
function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.unref();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => resolve(port));
    });
  });
}

// startServer(env): env.profiles / env.files to start with, env.vars for the
// server's environment, env.output to keep what the server logs (srv.output()). (A number as the first argument, the fixed port of
// older tests, is ignored: the port is always the system's pick.)
function startServer(env = {}, legacyEnv) {
  if (typeof env === "number") env = legacyEnv || {};
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "culling-test-"));
  const portFile = path.join(dir, "port");
  fs.copyFileSync(path.join(__dirname, "..", "data", "catalog.json"), path.join(dir, "catalog.json"));
  if (env.profiles) fs.writeFileSync(path.join(dir, "profiles.json"), JSON.stringify(env.profiles));
  // Other data files to start with ({ "accounts.json": {...} }).
  for (const [name, content] of Object.entries(env.files || {})) fs.writeFileSync(path.join(dir, name), JSON.stringify(content));
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    // CULLING_SAVE_DELAY_MS=0: write profiles on every change, so tests can read
    // profiles.json right after a request (the service coalesces to 1 s).
    // CULLING_REQUIRE_ACCOUNT=0: the game's /api/login without an account (the
    // tests that aren't about accounts); accounts.test.js turns it on.
    env: Object.assign({}, process.env, { CULLING_PORT: "0", CULLING_PORT_FILE: portFile, CULLING_DATA_DIR: dir, CULLING_SAVE_DELAY_MS: "0",
      CULLING_REQUIRE_ACCOUNT: "0",
      CULLING_LOBBY_GATHER_MS: "300", CULLING_LOBBY_COUNTDOWN_MS: "100",
      // Results right after the match starts (season.test.js tests the real minimum).
      CULLING_MIN_MATCH_SECONDS: "0", CULLING_SHOWDOWN_MIN_SECONDS: "0", CULLING_SHOWDOWN_MIN_ROUND_SECONDS: "0",
      // The pay limits off, so tests can post results at once (test/matchpay.test.js turns them on).
      CULLING_SECONDS_PER_KILL: "0", CULLING_DAMAGE_PER_SECOND: "0", CULLING_DAILY_MATCH_CREDITS: "0",
      CULLING_DAILY_MATCH_XP: "0" }, env.vars || {}),
    stdio: env.output ? ["ignore", "pipe", "pipe"] : "ignore"
  });
  let output = "";
  if (env.output) for (const s of [proc.stdout, proc.stderr]) s.on("data", (c) => { output += c; });
  const srv = {
    dir, port: null, proc,
    output: () => output,
    profiles: () => JSON.parse(fs.readFileSync(path.join(dir, "profiles.json"), "utf8")),
    request(method, url, body, headers = {}) {
      return new Promise((resolve, reject) => {
        if (!srv.port) return reject(new Error("srv.ready() first: the port isn't known yet"));
        const req = http.request({ host: "127.0.0.1", port: srv.port, path: url, method,
          headers: Object.assign({ "Content-Type": "application/json" }, headers) }, (res) => {
          let data = "";
          res.on("data", (c) => (data += c));
          res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
        });
        req.on("error", reject);
        if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
        req.end();
      });
    },
    // Resolves once the server answers /health; srv.port is its port then.
    async ready() {
      for (let i = 0; i < 100 && !srv.port; i++) {
        if (proc.exitCode !== null) throw new Error("server exited (code " + proc.exitCode + ")");
        try { srv.port = parseInt(fs.readFileSync(portFile, "utf8"), 10) || null; } catch { /* not yet */ }
        if (!srv.port) await new Promise((r) => setTimeout(r, 50));
      }
      if (!srv.port) throw new Error("server did not start (no port)");
      for (let i = 0; i < 100; i++) {
        try { await srv.request("GET", "/health"); return; } catch { await new Promise((r) => setTimeout(r, 100)); }
      }
      throw new Error("server did not start");
    },
    async login(userid) {
      const r = await srv.request("POST", "/api/login", { userid, authType: "steam" });
      return r.json.token;
    },
    // A socket logged in with a token; resolves with the socket.
    async connect(token) {
      const socket = ioClient(`http://127.0.0.1:${srv.port}`, { transports: ["websocket"], forceNew: true, reconnection: false });
      await next(socket, "login_ready");
      const ok = Promise.race([next(socket, "auth-response").then(() => true), next(socket, "auth-fail").then(() => false)]);
      socket.emit("login", { token });
      return (await ok) ? socket : (socket.close(), null);
    },
    // The killed server may still hold its files for a moment (Windows: EBUSY).
    stop() { srv.proc.kill(); try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* a temp folder left */ } }
  };
  return srv;
}

function next(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

module.exports = { startServer, next, freePort };
