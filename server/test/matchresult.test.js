// Match results on the shared server: paid only for a match the player's menu
// started, once, bounded, and to the right player.
"use strict";

const assert = require("assert");
const { startServer, next } = require("./helpers");

const A = "steam:76561190000000001";
const B = "steam:76561190000000002";
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

(async () => {
  const srv = startServer();
  const sockets = [];
  try {
    await srv.ready();
    const tokenA = await srv.login(A);
    const a = await srv.connect(tokenA);
    sockets.push(a);

    await test("a result with no match started is refused", async () => {
      const r = await srv.request("POST", "/api/matchresult", { kills: 3 });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(r.json.error, "no-match");
    });

    await test("a started match pays once, to its player, with numbers bounded", async () => {
      a.emit("join-mm", { queueName: "ffa" });
      await next(a, "match-ready");
      const r = await srv.request("POST", "/api/matchresult",
        '{"victory":false,"kills":-5,"damage":1e999,"timeAlive":99999,"func":99999999999,"placement":3}');
      assert.strictEqual(r.status, 200);
      const p = srv.profiles()[A];
      assert.ok(Number.isFinite(p.cullCredits) && Number.isFinite(p.stats.xp));
      assert.strictEqual(p.stats.kills, 0, "negative kills clamped");
      assert.strictEqual(p.stats.totalDamage, 0, "non-finite damage counts as none");
      assert.ok(p.lastMatch.timeAlive <= 40, "time alive capped to the real match length: " + p.lastMatch.timeAlive);
      assert.ok(p.stats.funcEarned <= 1e6);
      const replay = await srv.request("POST", "/api/matchresult", { kills: 50 });
      assert.strictEqual(replay.status, 409, "the same match can't pay twice");
    });

    await test("the HUD's level report goes to the player whose result was just paid", async () => {
      const r = await srv.request("POST", "/api/setlevel", { level: 3 });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(srv.profiles()[A].stats.level, 3);
    });

    await test("a normal result pays the documented formula", async () => {
      const before = srv.profiles()[A].cullCredits;
      a.emit("join-mm", { queueName: "ffa" });
      await next(a, "match-ready");
      await srv.request("POST", "/api/matchresult", { victory: true, kills: 3, damage: 400, timeAlive: 0, func: 20 });
      assert.strictEqual(srv.profiles()[A].cullCredits - before, 100 + 75 + 20 + 0 + 400);
    });

    await test("two players behind one address need their tokens", async () => {
      const tokenB = await srv.login(B);
      const b = await srv.connect(tokenB);
      sockets.push(b);
      a.emit("join-mm", { queueName: "ffa" });
      b.emit("join-mm", { queueName: "ffa" });
      await Promise.all([next(a, "match-ready"), next(b, "match-ready")]);
      const anon = await srv.request("POST", "/api/matchresult", { kills: 1 });
      assert.strictEqual(anon.status, 409);
      assert.strictEqual(anon.json.error, "ambiguous");
      const withToken = await srv.request("POST", "/api/matchresult", { kills: 1 }, { Authorization: "Bearer " + tokenB });
      assert.strictEqual(withToken.status, 200);
      assert.strictEqual(srv.profiles()[B].stats.kills, 1);
    });

    await test("ranked needs a login token", async () => {
      assert.strictEqual((await srv.request("GET", "/api/ranked")).status, 401);
      const r = await srv.request("GET", "/api/ranked", undefined, { Authorization: "Bearer " + tokenA });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.tier);
    });

    await test("a socket can't log in with a made-up token or a bare user ID", async () => {
      assert.strictEqual(await srv.connect("not-a-token"), null);
      assert.strictEqual(await srv.connect({ userID: A }), null);
    });

    await test("the match queue only trusts a user ID with a logged-in menu at that address", async () => {
      const stranger = await srv.request("POST", "/api/matchqueue", { userid: "steam:76561190000000999" });
      assert.strictEqual(stranger.status, 401);
      const ok = await srv.request("POST", "/api/matchqueue", { userid: A });
      assert.strictEqual(ok.status, 200);
    });

    console.log("all %d matchresult tests passed", passed);
  } finally {
    sockets.forEach((s) => s.close());
    srv.stop();
  }
})().catch((e) => { console.error("FAIL", e.message); process.exitCode = 1; });
