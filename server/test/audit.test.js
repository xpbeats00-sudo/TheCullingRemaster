// Fixes from the overhaul audit (docs/OVERHAUL_AUDIT.md):
// - a result only finishes the ranked match it belongs to (a Solo result
//   never scores a pending ranked match);
// - open match tickets survive a server restart (every deploy);
// - only an owned calling card can be shown;
// - buying something that doesn't exist fails;
// - the game's /api/login needs a user ID (no shared fallback profile);
// - someone else's wrong passwords can't lock a player out of sign-in;
// - a password reset ends the player's game sessions too.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function request(port, method, url, body, headers = {}) {
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
}

// A server on a data folder that outlives it (for the restart test).
function launch(port, dir) {
  const proc = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: Object.assign({}, process.env, { CULLING_PORT: String(port), CULLING_DATA_DIR: dir, CULLING_SAVE_DELAY_MS: "0",
      CULLING_REQUIRE_ACCOUNT: "0", CULLING_LOBBY_GATHER_MS: "300", CULLING_LOBBY_COUNTDOWN_MS: "100",
      CULLING_MIN_MATCH_SECONDS: "0", CULLING_SHOWDOWN_MIN_SECONDS: "0" }),
    stdio: "ignore"
  });
  return proc;
}
async function waitUp(port) {
  for (let i = 0; i < 100; i++) {
    try { if ((await request(port, "GET", "/health")).status === 200) return; } catch { /* not yet */ }
    await sleep(100);
  }
  throw new Error("server didn't start");
}

(async () => {
  const srv = startServer(8177);
  const sockets = [];
  try {
    await srv.ready();
    const A = "steam:76561190000000951";
    const a = await srv.connect(await srv.login(A));
    sockets.push(a);

    async function play(queue) {
      const ready = next(a, "match-ready");
      a.emit("join-mm", { queueName: queue });
      return ready;
    }

    await test("a Solo result doesn't finish a pending ranked match", async () => {
      await play("ranked_ffa_jungle");                    // ranked pending
      await play("ffa_jungle");                           // then a Solo match replaces the ticket
      const r = await srv.request("POST", "/api/matchresult", { victory: true, kills: 3, damage: 200, timeAlive: 300, placement: 1, cap: 24 });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ranked, null, "not scored as ranked");
      const p = srv.profiles()[A];
      assert.ok(p.ranked && p.ranked.pending, "the ranked match is still pending");
    });

    await test("the ranked match's own result scores it", async () => {
      await play("ranked_ffa_jungle");
      const r = await srv.request("POST", "/api/matchresult", { victory: false, kills: 2, damage: 150, timeAlive: 400, placement: 5, cap: 16 });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.ranked && r.json.ranked.entry, "scored as ranked");
    });

    await test("only an owned calling card is shown", async () => {
      const catalog = require("../data/catalog.json");
      const reward = catalog.find((i) => i.rankedReward && /Card/.test(i.class));
      const stock = catalog.find((i) => !i.source && /Card/.test(i.class));
      a.emit("set-card", { cardID: reward.tid });
      await sleep(300);
      assert.strictEqual(Number(srv.profiles()[A].cardID), 0, "an unearned ranked card is refused");
      a.emit("set-card", { cardID: stock.tid });
      await sleep(300);
      assert.strictEqual(Number(srv.profiles()[A].cardID), stock.tid, "a stock card is fine");
    });

    await test("buying an item that doesn't exist fails", async () => {
      const fail = next(a, "purchase-fail");
      a.emit("purchase-entitlement", { entitlementID: 999999999 });
      assert.strictEqual((await fail).reason, "unknown-item");
    });

    await test("the game's login needs a user ID", async () => {
      const r = await srv.request("POST", "/api/login", { authType: "steam" });
      assert.strictEqual(r.status, 400);
    });
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }

  // ---- a match in progress survives a server restart
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "culling-audit-"));
  fs.copyFileSync(path.join(__dirname, "..", "data", "catalog.json"), path.join(dir, "catalog.json"));
  let proc = launch(8178, dir);
  try {
    await waitUp(8178);
    const io = require("socket.io-client");
    const login = await request(8178, "POST", "/api/login", { userid: "steam:76561190000000952", authType: "steam" });
    const s = io("http://127.0.0.1:8178", { transports: ["websocket"], forceNew: true });
    await next(s, "login_ready");
    s.emit("login", { token: login.json.token });
    await next(s, "auth-response");
    const ready = next(s, "match-ready");
    s.emit("join-mm", { queueName: "ffa_jungle" });
    await ready;
    s.close();
    await sleep(300);
    await test("open match tickets are saved", async () => {
      const saved = JSON.parse(fs.readFileSync(path.join(dir, "tickets.json"), "utf8"));
      assert.strictEqual(saved.length, 1);
      assert.strictEqual(saved[0].mode, "ffa");
    });
    proc.kill();                                          // the hardest stop
    await sleep(500);
    proc = launch(8178, dir);
    await waitUp(8178);
    await test("a result after a server restart is still paid", async () => {
      const r = await request(8178, "POST", "/api/matchresult", { victory: true, kills: 4, damage: 300, timeAlive: 600, placement: 1, cap: 24 });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.ok(r.json.stats && r.json.stats.wins === 1);
    });
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    try { proc.kill(); } catch { /* gone */ }
    await sleep(300);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- sign-in lockout and password reset (accounts required)
  const acc = startServer(8179, { vars: { CULLING_REQUIRE_ACCOUNT: "1" } });
  try {
    await acc.ready();
    const from = (ip) => ({ "X-Forwarded-For": ip });
    const reg = await request(8179, "POST", "/api/account/register",
      { username: "Lockout Test", email: "lock@example.com", password: "the right one" }, from("198.51.100.7"));
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
    await test("someone else's wrong passwords can't lock a player out", async () => {
      for (let i = 0; i < 12; i++) {
        await request(8179, "POST", "/api/account/login", { username: "lockout test", password: "wrong " + i }, from("203.0.113.9"));
      }
      const ok = await request(8179, "POST", "/api/account/login", { username: "Lockout Test", password: "the right one" }, from("198.51.100.7"));
      assert.strictEqual(ok.status, 200, "the right password from the player's own address works");
    });
    await test("a password reset also ends the game sessions", async () => {
      const l = await request(8179, "POST", "/api/account/login", { username: "Lockout Test", password: "the right one" }, from("198.51.100.7"));
      assert.strictEqual((await request(8179, "POST", "/api/account/play", {}, Object.assign({ Authorization: "Bearer " + l.json.token }, from("198.51.100.7")))).status, 200);
      const game = await request(8179, "POST", "/api/login", { userid: reg.json.userID, authType: "steam" }, from("198.51.100.7"));
      assert.strictEqual(game.status, 200);
      const reset = await request(8179, "POST", "/admin/reset-password", { username: "lockout test" });
      assert.strictEqual(reset.status, 200, JSON.stringify(reset.json));
      const io = require("socket.io-client");
      const s = io("http://127.0.0.1:8179", { transports: ["websocket"], forceNew: true });
      await next(s, "login_ready");
      s.emit("login", { token: game.json.token });
      const fail = await next(s, "auth-fail");
      s.close();
      assert.strictEqual(fail.reason, "invalid-token", "the old game session no longer logs in");
    });
    console.log("all %d audit tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    acc.stop();
  }
})();
