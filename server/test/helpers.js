// Shared test harness: a throwaway server on its own port and data folder,
// HTTP helpers, and logged-in socket clients.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const ioClient = require("socket.io-client");

function startServer(port, env = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "culling-test-"));
  fs.copyFileSync(path.join(__dirname, "..", "data", "catalog.json"), path.join(dir, "catalog.json"));
  if (env.profiles) fs.writeFileSync(path.join(dir, "profiles.json"), JSON.stringify(env.profiles));
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    // CULLING_SAVE_DELAY_MS=0: write profiles on every change, so tests can read
    // profiles.json right after a request (the service coalesces to 1 s).
    // CULLING_REQUIRE_ACCOUNT=0: the game's /api/login without an account (the
    // tests that aren't about accounts); accounts.test.js turns it on.
    env: Object.assign({}, process.env, { CULLING_PORT: String(port), CULLING_DATA_DIR: dir, CULLING_SAVE_DELAY_MS: "0",
      CULLING_REQUIRE_ACCOUNT: "0" }, env.vars || {}),
    stdio: "ignore"
  });
  const srv = {
    dir, port, proc,
    profiles: () => JSON.parse(fs.readFileSync(path.join(dir, "profiles.json"), "utf8")),
    request(method, url, body, headers = {}) {
      return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: url, method,
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
    async ready() {
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
      const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ["websocket"], forceNew: true, reconnection: false });
      await next(socket, "login_ready");
      const ok = Promise.race([next(socket, "auth-response").then(() => true), next(socket, "auth-fail").then(() => false)]);
      socket.emit("login", { token });
      return (await ok) ? socket : (socket.close(), null);
    },
    stop() { srv.proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); }
  };
  return srv;
}

function next(socket, event) {
  return new Promise((resolve) => socket.once(event, resolve));
}

module.exports = { startServer, next };
