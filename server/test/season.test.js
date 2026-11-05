// Season-start caps on the shared server: results can't make a player more
// than level 14 or T4 (Hunter), and a "win" reported straight after the match
// starts isn't one. Runs with the real minimum match time (120 s).
"use strict";

const assert = require("assert");
const { startServer, next } = require("./helpers");

const A = "steam:76561190000000501";
const OLD = "steam:76561190000000502";
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

(async () => {
  // A profile from before the caps: level 40, 300k XP, rated Apex.
  const old = {
    userID: OLD, cullCredits: 100, premiumCurrency: 0, cardID: 0, economy: 1, owned: [],
    stats: { xp: 300000, level: 40, kills: 0, wins: 0, gamesPlayed: 0, totalDamage: 0, minutesAlive: 0, funcEarned: 0, rank: 0 },
    ranked: null
  };
  const srv = startServer({ profiles: { [OLD]: old }, vars: { CULLING_MIN_MATCH_SECONDS: "120" } });
  const sockets = [];
  try {
    await srv.ready();
    const a = await srv.connect(await srv.login(A));
    sockets.push(a);

    await test("an instant 'victory' with huge numbers is paid as a short loss", async () => {
      a.emit("join-mm", { queueName: "ffa" });
      await next(a, "match-ready");
      const r = await srv.request("POST", "/api/matchresult",
        { victory: true, kills: 999, damage: 1e9, timeAlive: 99999, func: 5, placement: 1 });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.stats.wins, 0, "no win before 120 s");
      assert.strictEqual(r.json.stats.kills, 15, "at most the 15 other contestants");
      assert.ok(r.json.xpEarned <= 250 + 150 * 15 + 5000 + 15, "XP bounded: " + r.json.xpEarned);
    });

    await test("a ranked result before 120 s counts as last place", async () => {
      a.emit("join-mm", { queueName: "ranked_ffa" });
      await next(a, "match-ready");
      const r = await srv.request("POST", "/api/matchresult", { victory: true, placement: 1 });
      assert.ok(r.json.ranked, "ranked result recorded");
      assert.strictEqual(r.json.ranked.entry.placement, 16);
      assert.strictEqual(r.json.ranked.entry.field, 16, "scored as 16 contestants");
      assert.ok(r.json.ranked.entry.delta < 0, "last place loses rating");
    });

    await test("the HUD can't report a level above the season cap", async () => {
      await srv.request("POST", "/api/setlevel", { level: 500 });
      assert.ok(srv.profiles()[A].stats.level <= 14, "level " + srv.profiles()[A].stats.level);
    });

    await test("profiles from before the caps are brought within them when read", async () => {
      await srv.login(OLD);
      const p = srv.profiles()[OLD];
      assert.strictEqual(p.stats.level, 14);
      assert.strictEqual(p.stats.xp, 79749, "XP stops at the top of level 14");
    });

    console.log("all %d season tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
})();
