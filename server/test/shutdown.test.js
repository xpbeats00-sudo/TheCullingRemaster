// Nothing is lost when the service stops, and at most ~1 s on a hard kill.
//
// The graceful stop is done the way the service is really stopped: on
// Windows, WinSW 2.12's sequence (attach to node's console, CTRL_C_EVENT,
// wait, kill on timeout; see winsw_stop.ps1); elsewhere SIGTERM and SIGINT.
// The server runs with a 60 s save interval, so the data can only be on disk
// if the stop handler wrote it.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");
const ioClient = require("socket.io-client");
const { freePort } = require("./helpers");

const SERVER = path.join(__dirname, "..", "server.js");
const PS_HELPER = path.join(__dirname, "winsw_stop.ps1");
const win = process.platform === "win32";
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const next = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

function request(port, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: url, method,
      headers: Object.assign({ "Content-Type": "application/json" }, headers) }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

function dataDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "culling-stop-"));
  fs.copyFileSync(path.join(__dirname, "..", "data", "catalog.json"), path.join(dir, "catalog.json"));
  return dir;
}

function envFor(port, dir, saveDelay) {
  return Object.assign({}, process.env, { CULLING_PORT: String(port), CULLING_DATA_DIR: dir,
    CULLING_SAVE_DELAY_MS: String(saveDelay), CULLING_REQUIRE_ACCOUNT: "0",
    CULLING_LOBBY_GATHER_MS: "300", CULLING_LOBBY_COUNTDOWN_MS: "100", CULLING_MIN_MATCH_SECONDS: "0",
    CULLING_SECONDS_PER_KILL: "0", CULLING_DAMAGE_PER_SECOND: "0", CULLING_DAILY_MATCH_CREDITS: "0", CULLING_DAILY_MATCH_XP: "0" });
}

// Starts the server; returns { pid, exited: Promise<{code, how}>, hardKill() }.
function launch(port, dir, saveDelay, viaWinSW) {
  const env = envFor(port, dir, saveDelay);
  if (viaWinSW) {
    const pidFile = path.join(dir, "server.pid");
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_HELPER, "-Start",
      "-Exe", process.execPath, "-Arguments", `"${SERVER}"`, "-PidFile", pidFile], { env, stdio: "ignore" });
    const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    return { pid, hardKill: () => process.kill(pid) };
  }
  const proc = spawn(process.execPath, [SERVER], { env, stdio: "ignore" });
  const exited = new Promise((resolve) => proc.on("exit", (code, signal) => resolve({ code, signal })));
  return { pid: proc.pid, proc, exited, hardKill: () => proc.kill("SIGKILL") };
}

async function waitUp(port) {
  for (let i = 0; i < 100; i++) {
    try { await request(port, "GET", "/health"); return; } catch { await sleep(100); }
  }
  throw new Error("server did not start");
}

async function play(port, userID) {
  const login = await request(port, "POST", "/api/login", { userid: userID });
  const socket = ioClient(`http://127.0.0.1:${port}`, { transports: ["websocket"], forceNew: true, reconnection: false });
  await next(socket, "login_ready");
  socket.emit("login", { token: login.json.token });
  await next(socket, "auth-response");
  socket.emit("set-card", { cardID: 191001 });
  socket.emit("join-mm", { queueName: "ffa" });
  await next(socket, "match-ready");
  const r = await request(port, "POST", "/api/matchresult", { victory: true, kills: 4, damage: 300, timeAlive: 1 },
    { Authorization: "Bearer " + login.json.token });
  assert.strictEqual(r.status, 200);
  return { socket, token: login.json.token };
}

const profilesIn = (dir) => {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "profiles.json"), "utf8")); } catch { return {}; }
};

async function gracefulStopKeepsEverything(port, how) {
  const dir = dataDir();
  const user = "steam:7656119000000" + port;
  const srv = launch(port, dir, 60000, how === "winsw");
  let socket;
  try {
    await waitUp(port);
    ({ socket } = await play(port, user));
    await sleep(200);
    // The first change (profile creation) was written at once; the match
    // result is still only in memory (next write due in 60 s).
    const before = profilesIn(dir)[user];
    assert.ok(!before || before.stats.gamesPlayed === 0, "match result not on disk before the stop");

    let outcome;
    if (how === "winsw") {
      outcome = execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_HELPER, "-Stop",
        "-ProcessId", String(srv.pid), "-TimeoutSeconds", "15"], { encoding: "utf8" }).trim();
      assert.strictEqual(outcome, "exited 0", "stopped by Ctrl+C within the stop timeout, not killed");
    } else {
      srv.proc.kill(how);
      outcome = await srv.exited;
      assert.strictEqual(outcome.code, 0);
    }
    const after = profilesIn(dir)[user];
    assert.ok(after, "profile saved");
    assert.strictEqual(after.stats.gamesPlayed, 1, "match result saved on stop");
    assert.strictEqual(after.stats.wins, 1);
    assert.strictEqual(after.cardID, 191001, "card choice saved on stop");
    const sessions = JSON.parse(fs.readFileSync(path.join(dir, "sessions.json"), "utf8"));
    assert.ok(Object.values(sessions).some((s) => s.userID === user), "login token saved");
    assert.ok(!fs.existsSync(path.join(dir, "profiles.json.tmp")), "no temp file left");
  } finally {
    if (socket) socket.close();
    try { srv.hardKill(); } catch { /* already gone */ }
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

(async () => {
  try {
    if (win) {
      await test("WinSW-style stop (Ctrl+C to node's console) saves everything and exits 0", async () => gracefulStopKeepsEverything(await freePort(), "winsw"));
    } else {
      await test("SIGTERM saves everything and exits 0", async () => gracefulStopKeepsEverything(await freePort(), "SIGTERM"));
      await test("SIGINT saves everything and exits 0", async () => gracefulStopKeepsEverything(await freePort(), "SIGINT"));
    }

    await test("a hard kill loses at most about one save interval", async () => {
      const port = await freePort();
      const dir = dataDir();
      const user = "steam:76561190000009999";
      const srv = launch(port, dir, 1000, false);
      let socket;
      try {
        await waitUp(port);
        ({ socket } = await play(port, user));
        await sleep(1500);                 // one interval (1 s) plus the write itself
        srv.hardKill();                    // TerminateProcess / SIGKILL: no handler runs
        await srv.exited;
        assert.strictEqual(profilesIn(dir)[user].stats.gamesPlayed, 1, "a change older than ~1 s survives a hard kill");
      } finally {
        if (socket) socket.close();
        fs.rmSync(dir, { recursive: true, force: true });
      }
    });

    console.log("all %d shutdown tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  }
})();
