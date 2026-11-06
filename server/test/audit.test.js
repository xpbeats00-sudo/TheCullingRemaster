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
const { startServer, next, freePort } = require("./helpers");

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
  await test("a new ranked season archives the last one and starts fresh (rewards kept)", async () => {
    const ranked = require("../ranked");
    const s1 = ranked.seasonAt(Date.parse("2026-12-01T00:00:00Z"));
    const s2 = ranked.seasonAt(Date.parse("2027-02-15T00:00:00Z"));
    const s3 = ranked.seasonAt(Date.parse("2027-05-10T00:00:00Z"));
    assert.deepStrictEqual([s1.id, s2.id, s3.id], ["S1", "S2", "S3"]);
    assert.strictEqual(s2.start, "2027-02-01T00:00:00.000Z");
    const p = { owned: [197001] };
    const r = ranked.ensure(p, Date.parse("2026-12-01T00:00:00Z"));
    Object.assign(r, { rating: 1350, mmr: 1390, matches: 30, wins: 6, peakRating: 1380, peakTier: "Hunter", tiersReached: { Hunter: true } });
    const after = ranked.ensure(p, Date.parse("2027-02-15T00:00:00Z"));
    assert.strictEqual(after.season, "S2");
    assert.strictEqual(after.matches, 0);
    assert.strictEqual(after.rating, ranked.CONFIG.startRating);
    assert.ok(after.mmr > ranked.CONFIG.startRating && after.mmr < 1390, "MMR softly reset");
    assert.deepStrictEqual(after.tiersReached, {});
    assert.deepStrictEqual(after.past[0], { season: "S1", rating: 1350, peakRating: 1380, peakTier: "Hunter", matches: 30, wins: 6 });
    assert.deepStrictEqual(p.owned, [197001], "rewards stay owned");
    const summary = ranked.summary(p, Date.parse("2027-02-15T00:00:00Z"));
    assert.strictEqual(summary.season.id, "S2");
    assert.ok(summary.season.daysLeft > 0);
  });

  const srv = startServer();
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

    await test("Ranked Duo starts Ranked Duos (the Duo match, its own rating), never Ranked Solo", async () => {
      const solo = JSON.stringify(srv.profiles()[A].ranked);
      const m = await play("ranked_ffa_jungle_coop2");
      assert.deepStrictEqual([m.gameServer, m.playlist, m.ranked], ["duo:0", "ranked_coop2", "duo"]);
      const r = await srv.request("POST", "/api/matchresult", { victory: false, timeAlive: 300, placement: 6, cap: 24 });
      assert.deepStrictEqual([r.json.ranked.entry.mode, r.json.ranked.entry.field, r.json.ranked.entry.placement], ["duo", 12, 3]);
      assert.strictEqual(JSON.stringify(srv.profiles()[A].ranked), solo, "Solo's rating untouched");
    });

    await test("a ranked placement beyond the field still scores (as last place at worst)", async () => {
      await play("ranked_ffa_prison");
      const r = await srv.request("POST", "/api/matchresult", { victory: false, kills: 0, damage: 10, timeAlive: 200, placement: 21, cap: 24 });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.ranked && r.json.ranked.entry, "scored");
      assert.strictEqual(r.json.ranked.entry.placement, r.json.ranked.entry.field);
    });

    await test("Duo results get their own record; the stock coop board shows them", async () => {
      await play("ffa_jungle_coop2");
      const r = await srv.request("POST", "/api/matchresult", { victory: true, kills: 5, damage: 400, timeAlive: 700, placement: 1, cap: 24 });
      assert.strictEqual(r.status, 200);
      const p = srv.profiles()[A];
      assert.strictEqual(p.modes.coop2.played, 1);
      assert.strictEqual(p.modes.coop2.wins, 1);
      const lb = next(a, "player-leaderboard-response");
      a.emit("player-leaderboard-request", {});
      const data = (await lb).data;
      assert.strictEqual(data.coop.currentSeasonWins, 1);
      assert.strictEqual(data.coop.currentSeasonKills, 5);
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
  const restartPort = await freePort();
  let proc = launch(restartPort, dir);
  try {
    await waitUp(restartPort);
    const io = require("socket.io-client");
    const login = await request(restartPort, "POST", "/api/login", { userid: "steam:76561190000000952", authType: "steam" });
    const s = io("http://127.0.0.1:" + restartPort, { transports: ["websocket"], forceNew: true });
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
    proc = launch(restartPort, dir);
    await waitUp(restartPort);
    await test("a result after a server restart is still paid", async () => {
      const r = await request(restartPort, "POST", "/api/matchresult", { victory: true, kills: 4, damage: 300, timeAlive: 600, placement: 1, cap: 24 });
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

  // ---- the menu logging in again closes a match that never reported
  const g = startServer({ vars: { CULLING_ABANDON_GRACE_MS: "200" } });
  try {
    await g.ready();
    const U = "steam:76561190000000953";
    let s = await g.connect(await g.login(U));
    const ready = next(s, "match-ready");
    s.emit("join-mm", { queueName: "ffa_jungle" });
    await ready;
    s.close();
    await sleep(400);
    s = await g.connect(await g.login(U));              // back in the menu, no result was sent
    await sleep(300);
    await test("a match that never reported is closed when the menu logs in again", async () => {
      const r = await g.request("POST", "/api/matchresult", { victory: false, kills: 0, damage: 0, timeAlive: 30, placement: 20, cap: 24 });
      assert.strictEqual(r.status, 409, "a later Survival/Training result can't claim it");
    });
    s.close();
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    g.stop();
  }

  // ---- sign-in lockout and password reset (accounts required)
  const acc = startServer({ vars: { CULLING_REQUIRE_ACCOUNT: "1" } });
  try {
    await acc.ready();
    const from = (ip) => ({ "X-Forwarded-For": ip });
    const reg = await request(acc.port, "POST", "/api/account/register",
      { username: "Lockout Test", email: "lock@example.com", password: "the right one" }, from("198.51.100.7"));
    assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
    await test("someone else's wrong passwords can't lock a player out", async () => {
      for (let i = 0; i < 12; i++) {
        await request(acc.port, "POST", "/api/account/login", { username: "lockout test", password: "wrong " + i }, from("203.0.113.9"));
      }
      const ok = await request(acc.port, "POST", "/api/account/login", { username: "Lockout Test", password: "the right one" }, from("198.51.100.7"));
      assert.strictEqual(ok.status, 200, "the right password from the player's own address works");
    });
    await test("a password reset also ends the game sessions", async () => {
      const l = await request(acc.port, "POST", "/api/account/login", { username: "Lockout Test", password: "the right one" }, from("198.51.100.7"));
      assert.strictEqual((await request(acc.port, "POST", "/api/account/play", {}, Object.assign({ Authorization: "Bearer " + l.json.token }, from("198.51.100.7")))).status, 200);
      const game = await request(acc.port, "POST", "/api/login", { userid: reg.json.userID, authType: "steam" }, from("198.51.100.7"));
      assert.strictEqual(game.status, 200);
      const reset = await request(acc.port, "POST", "/admin/reset-password", { username: "lockout test" });
      assert.strictEqual(reset.status, 200, JSON.stringify(reset.json));
      const io = require("socket.io-client");
      const s = io("http://127.0.0.1:" + acc.port, { transports: ["websocket"], forceNew: true });
      await next(s, "login_ready");
      s.emit("login", { token: game.json.token });
      const fail = await next(s, "auth-fail");
      s.close();
      assert.strictEqual(fail.reason, "invalid-token", "the old game session no longer logs in");
    });
    await test("two players on one address are told apart by their in-game name", async () => {
      const ip = "192.0.2.50";
      const make = async (name) => {
        const reg = await request(acc.port, "POST", "/api/account/register",
          { username: name, email: name.replace(/ /g, "") + "@example.com", password: "household pass" }, from(ip));
        assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
        await request(acc.port, "POST", "/api/account/play", {}, Object.assign({ Authorization: "Bearer " + reg.json.token }, from(ip)));
        const game = await request(acc.port, "POST", "/api/login", { userid: reg.json.userID, authType: "steam" }, from(ip));
        const io = require("socket.io-client");
        const s = io("http://127.0.0.1:" + acc.port, { transports: ["websocket"], forceNew: true, forceNode: true, extraHeaders: from(ip) });
        await next(s, "login_ready");
        s.emit("login", { token: game.json.token });
        await next(s, "auth-response");
        const ready = next(s, "match-ready");
        s.emit("join-mm", { queueName: "ffa_jungle" });
        await ready;
        return { s, userID: reg.json.userID };
      };
      const one = await make("House One"), two = await make("House Two");
      one.s.close(); two.s.close();
      const r1 = await request(acc.port, "POST", "/api/matchresult", { victory: false, kills: 1, damage: 50, timeAlive: 200, placement: 9, cap: 24, nickname: "House Two" }, from(ip));
      assert.strictEqual(r1.status, 200, JSON.stringify(r1.json));
      const r2 = await request(acc.port, "POST", "/api/matchresult", { victory: false, kills: 2, damage: 60, timeAlive: 200, placement: 7, cap: 24, nickname: "House One" }, from(ip));
      assert.strictEqual(r2.status, 200, JSON.stringify(r2.json));
      const profiles = acc.profiles();
      assert.strictEqual(profiles[two.userID].stats.kills, 1);
      assert.strictEqual(profiles[one.userID].stats.kills, 2);
    });
    // Was: Duo took the leader and one member, silently leaving the third
    // behind (who then queued alone). A party is one unit now: refused.
    await test("a party of three queuing Duo is refused, nobody is pulled in", async () => {
      let n = 60;
      const player = async (name) => {
        const ip = "198.51.100." + (n++);
        const reg = await request(acc.port, "POST", "/api/account/register",
          { username: name, email: name.replace(/ /g, "") + "@example.com", password: "party pass" }, from(ip));
        assert.strictEqual(reg.status, 200, JSON.stringify(reg.json));
        await request(acc.port, "POST", "/api/account/play", {}, Object.assign({ Authorization: "Bearer " + reg.json.token }, from(ip)));
        const game = await request(acc.port, "POST", "/api/login", { userid: reg.json.userID, authType: "steam" }, from(ip));
        const io = require("socket.io-client");
        const s = io("http://127.0.0.1:" + acc.port, { transports: ["websocket"], forceNew: true, forceNode: true, extraHeaders: from(ip) });
        await next(s, "login_ready");
        s.emit("login", { token: game.json.token });
        await next(s, "auth-response");
        return { name, s };
      };
      const act = (p, ev, msg) => { const r = next(p.s, "remaster-friend-result"); p.s.emit(ev, msg); return r; };
      const L = await player("Duo Leader"), M1 = await player("Duo One"), M2 = await player("Duo Two");
      for (const m of [M1, M2]) {
        await act(L, "friend-request", { username: m.name });
        await act(m, "friend-accept", { username: L.name });
      }
      for (const m of [M1, M2]) {
        const inv = next(m.s, "remaster-party-invite");
        await act(L, "party-invite", { username: m.name });
        await act(m, "party-accept", { partyId: (await inv).partyId });
      }
      let pulled = 0;
      for (const m of [M1, M2]) m.s.on("join-mm-group", () => pulled++);
      const fail = next(L.s, "join-mm-fail");
      L.s.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      assert.strictEqual((await fail).reason, "party-too-large");
      await sleep(300);
      assert.strictEqual(pulled, 0, "no member pulled in");
      for (const p of [L, M1, M2]) p.s.close();
    });
    console.log("all %d audit tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    acc.stop();
  }
})();
