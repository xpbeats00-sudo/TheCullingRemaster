// Match pay can't be farmed with fake results: a result too short to be a
// real match pays nothing, kills and damage are bounded by how long the match
// really ran, and match credits and XP have a daily cap (FULL_AUDIT_2026-11-06
// P0 #1: 20 instant results paid +14,500 credits and max XP).
"use strict";

const assert = require("assert");
const { startServer, next } = require("./helpers");

const A = "steam:76561190000000101";
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withServer(vars, fn) {
  const srv = startServer({ vars });
  let sock = null;
  try {
    await srv.ready();
    sock = await srv.connect(await srv.login(A));
    const play = async (body, waitMs = 0) => {
      sock.emit("join-mm", { queueName: "ffa" });
      await next(sock, "match-ready");
      if (waitMs) await sleep(waitMs);
      return srv.request("POST", "/api/matchresult", body);
    };
    await fn(srv, play, sock);
  } finally {
    if (sock) sock.close();
    srv.stop();
  }
}

const FAKE = { victory: true, kills: 99, damage: 1e9, timeAlive: 99999, placement: 1 };

// A Showdown series: queued, `rounds` rounds won as the HUD reports them,
// then the match result that ends it.
async function showdown(srv, sock, rounds, body = {}, waitMs = 0) {
  const ready = next(sock, "match-ready");
  sock.emit("join-mm", { queueName: "showdown" });
  await ready;
  if (waitMs) await sleep(waitMs);
  for (let n = 1; n <= rounds; n++) await srv.request("POST", "/api/showdown/round", { round: n, result: "W" });
  return srv.request("POST", "/api/matchresult", Object.assign({ victory: rounds >= 4, kills: 99, damage: 1e9, timeAlive: 99999 }, body));
}

(async () => {
  await test("a result shorter than the minimum match pays nothing and counts nothing", async () => {
    await withServer({ CULLING_MIN_MATCH_SECONDS: "60" }, async (srv, play) => {
      const before = srv.profiles()[A];
      const r = await play(FAKE);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.credits, 0);
      assert.strictEqual(r.json.xpEarned, 0);
      const p = srv.profiles()[A];
      assert.strictEqual(p.cullCredits, before.cullCredits, "no credits");
      assert.strictEqual(p.stats.xp, before.stats.xp, "no XP");
      assert.strictEqual(p.stats.gamesPlayed, before.stats.gamesPlayed, "not a game played");
      assert.strictEqual(p.stats.kills, before.stats.kills, "no kills on the career");
      assert.strictEqual(p.stats.wins, before.stats.wins, "no win");
      const again = await srv.request("POST", "/api/matchresult", FAKE);
      assert.strictEqual(again.status, 409, "the ticket is still used up");
    });
  });

  await test("kills and damage are bounded by how long the match ran", async () => {
    await withServer({ CULLING_MIN_MATCH_SECONDS: "1", CULLING_SECONDS_PER_KILL: "1", CULLING_DAMAGE_PER_SECOND: "10" },
      async (srv, play) => {
        const r = await play(FAKE, 1600);
        assert.strictEqual(r.status, 200);
        const m = srv.profiles()[A].lastMatch;
        assert.ok(m.kills >= 1 && m.kills <= 2, "about one kill per second of match: " + m.kills);
        assert.ok(m.damage > 0 && m.damage <= 25, "about 10 damage per second of match: " + m.damage);
      });
  });

  await test("match credits and XP stop at the daily cap", async () => {
    await withServer({ CULLING_DAILY_MATCH_CREDITS: "300", CULLING_DAILY_MATCH_XP: "2000" }, async (srv, play) => {
      const start = srv.profiles()[A];
      let paid = 0, xp = 0;
      for (let i = 0; i < 4; i++) {
        const r = await play({ kills: 10, damage: 2000, timeAlive: 600 });
        assert.strictEqual(r.status, 200);
        paid += r.json.credits;
        xp += r.json.xpEarned;
      }
      const p = srv.profiles()[A];
      assert.strictEqual(paid, 300, "credits paid up to the cap: " + paid);
      assert.strictEqual(p.cullCredits - start.cullCredits, 300);
      assert.strictEqual(xp, 2000, "XP up to the cap: " + xp);
      assert.strictEqual(p.stats.xp - start.stats.xp, 2000);
      assert.strictEqual(p.stats.gamesPlayed - start.stats.gamesPlayed, 4, "games still count past the cap");
    });
  });

  await test("a normal match well inside the limits pays as before", async () => {
    await withServer({}, async (srv, play) => {
      const start = srv.profiles()[A];
      // (Time alive is already capped at the match's real length, so none here.)
      const r = await play({ kills: 3, damage: 800, timeAlive: 0, victory: false });
      assert.strictEqual(r.status, 200);
      // 100 + 25*3 + 800/20 = 215 credits; 250 + 450 + 800 = 1500 XP.
      assert.strictEqual(r.json.credits, 215);
      assert.strictEqual(r.json.xpEarned, 1500);
      assert.strictEqual(srv.profiles()[A].cullCredits - start.cullCredits, 215);
      assert.strictEqual(srv.profiles()[A].stats.gamesPlayed - start.stats.gamesPlayed, 1);
    });
  });

  await test("a custom match pays half the credits and XP of the same result in a normal match", async () => {
    await withServer({}, async (srv, play, sock) => {
      const start = srv.profiles()[A];
      const update = next(sock, "lobby-update");
      sock.emit("lobby-create", { mapName: "Jungle/Jungle_P" });
      await update;
      const ready = next(sock, "match-ready");
      sock.emit("lobby-start-match");
      await ready;
      const r = await srv.request("POST", "/api/matchresult", { kills: 3, damage: 800, timeAlive: 0, victory: false });
      assert.strictEqual(r.status, 200);
      // Half of 215 credits and 1500 XP (the normal match above).
      assert.strictEqual(r.json.credits, 107);
      assert.strictEqual(r.json.xpEarned, 750);
      assert.strictEqual(srv.profiles()[A].cullCredits - start.cullCredits, 107);
      assert.strictEqual(srv.profiles()[A].stats.xp - start.stats.xp, 750);
    });
  });

  // Showdown results go through their own path (showdownMatchResult): the
  // same limits (FULL_AUDIT_2026-11-06 round 2: instant "W" rounds paid the
  // daily cap in ~15 s and unlimited career wins and kills).
  await test("a Showdown series shorter than the minimum match pays nothing and counts nothing", async () => {
    await withServer({ CULLING_MIN_MATCH_SECONDS: "60" }, async (srv, play, sock) => {
      const before = srv.profiles()[A];
      const r = await showdown(srv, sock, 4);
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.credits, 0);
      assert.strictEqual(r.json.xpEarned, 0);
      const p = srv.profiles()[A];
      assert.strictEqual(p.cullCredits, before.cullCredits, "no credits");
      assert.strictEqual(p.stats.xp, before.stats.xp, "no XP");
      assert.strictEqual(p.stats.gamesPlayed, before.stats.gamesPlayed, "not a game played");
      assert.strictEqual(p.stats.wins, before.stats.wins, "no win");
      assert.strictEqual(p.stats.kills, before.stats.kills, "no kills on the career");
      assert.ok(!(p.showdown && p.showdown.won), "no series won on the record");
    });
  });

  await test("a Showdown forfeit with no round played pays nothing", async () => {
    await withServer({}, async (srv, play, sock) => {
      const before = srv.profiles()[A];
      const r = await showdown(srv, sock, 0, { victory: false });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.credits, 0);
      assert.strictEqual(r.json.xpEarned, 0);
      const p = srv.profiles()[A];
      assert.strictEqual(p.cullCredits, before.cullCredits);
      assert.strictEqual(p.stats.gamesPlayed, before.stats.gamesPlayed);
    });
  });

  await test("Showdown kills and damage are bounded by how long the series ran", async () => {
    await withServer({ CULLING_MIN_MATCH_SECONDS: "1", CULLING_SECONDS_PER_KILL: "1", CULLING_DAMAGE_PER_SECOND: "10" },
      async (srv, play, sock) => {
        const r = await showdown(srv, sock, 4, {}, 1600);
        assert.strictEqual(r.status, 200);
        assert.ok(r.json.credits > 0, "a real series pays");
        const m = srv.profiles()[A].lastMatch;
        assert.ok(m.kills >= 1 && m.kills <= 2, "about one kill per second of series: " + m.kills);
        assert.ok(m.damage > 0 && m.damage <= 25, "about 10 damage per second of series: " + m.damage);
      });
  });

  await test("a Showdown round reported too soon after the last one doesn't count", async () => {
    await withServer({ CULLING_SHOWDOWN_MIN_ROUND_SECONDS: "1" }, async (srv, play, sock) => {
      const ready = next(sock, "match-ready");
      sock.emit("join-mm", { queueName: "showdown" });
      await ready;
      const round = (n) => srv.request("POST", "/api/showdown/round", { round: n, result: "W" }).then((r) => r.json.counted);
      assert.strictEqual(await round(1), false, "right after the series started");
      await sleep(1100);
      assert.strictEqual(await round(1), true, "a round later");
      assert.strictEqual(await round(2), false, "right after the round before");
    });
  });

  console.log("all %d matchpay tests passed", passed);
})().catch((e) => { console.error("FAIL", e.message); process.exitCode = 1; });
