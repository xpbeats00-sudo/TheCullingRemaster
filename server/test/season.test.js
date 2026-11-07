// Season-start caps on the shared server: results can't make a player more
// than level 14 or T4 (Hunter), and a "win" reported straight after the match
// starts isn't one. Runs with the real minimum match time (120 s).
"use strict";

const assert = require("assert");
const { startServer, next } = require("./helpers");

const A = "steam:76561190000000501";
const OLD = "steam:76561190000000502";
const LAST = "steam:76561190000000503";
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

(async () => {
  // A profile from before the caps: level 40, 300k XP, rated Apex.
  const old = {
    userID: OLD, cullCredits: 100, premiumCurrency: 0, cardID: 0, economy: 1, owned: [],
    stats: { xp: 300000, level: 40, kills: 0, wins: 0, gamesPlayed: 0, totalDamage: 0, minutesAlive: 0, funcEarned: 0, rank: 0 },
    ranked: null
  };
  // Rated Hunter last season, no ranked match this season yet.
  const last = {
    userID: LAST, cullCredits: 100, premiumCurrency: 0, cardID: 0, economy: 1, owned: [],
    stats: { xp: 0, level: 1, kills: 0, wins: 0, gamesPlayed: 3, totalDamage: 0, minutesAlive: 0, funcEarned: 0, rank: 0 },
    ranked: { season: "S0", rating: 1300, mmr: 1300, matches: 12, wins: 4, peakRating: 1300, peakTier: "Hunter",
      pending: null, processed: {}, history: [], tiersReached: { Hunter: 1 } }
  };
  const srv = startServer({ profiles: { [OLD]: old, [LAST]: last }, vars: { CULLING_MIN_MATCH_SECONDS: "120" } });
  const sockets = [];
  try {
    await srv.ready();
    const a = await srv.connect(await srv.login(A));
    sockets.push(a);

    await test("an instant 'victory' with huge numbers pays nothing and isn't on the career", async () => {
      a.emit("join-mm", { queueName: "ffa" });
      await next(a, "match-ready");
      const r = await srv.request("POST", "/api/matchresult",
        { victory: true, kills: 999, damage: 1e9, timeAlive: 99999, func: 5, placement: 1 });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.stats.wins, 0, "no win before 120 s");
      assert.strictEqual(r.json.stats.kills, 0, "a match under 120 s isn't on the career");
      assert.strictEqual(r.json.stats.gamesPlayed, 0);
      assert.strictEqual(r.json.xpEarned, 0, "no XP before 120 s");
      assert.strictEqual(r.json.credits, 0, "no credits before 120 s");
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

    await test("last season's Solo rank isn't on the player card or the lobby card", async () => {
      const ip = { "X-Forwarded-For": "198.51.100.77" };
      await srv.request("POST", "/api/login", { userid: LAST, authType: "steam" }, ip);
      const claimed = await srv.request("POST", "/api/account/register",
        { username: "Oldtimer", email: "old@example.com", password: "long enough", claimUserID: LAST }, ip);
      assert.ok(claimed.json && claimed.json.claimed, JSON.stringify(claimed.json));
      const viewer = await srv.request("POST", "/api/account/register",
        { username: "Viewer", email: "viewer@example.com", password: "long enough" }, { "X-Forwarded-For": "198.51.100.78" });
      const v = await srv.connect(await srv.login(viewer.json.userID));
      sockets.push(v);
      const card = next(v, "remaster-player-card");
      v.emit("player-card", { username: "Oldtimer" });
      const c = await card;
      assert.ok(c.found);
      assert.strictEqual(c.ranked, null, "no ranked record this season");
      assert.strictEqual(c.rank, null, "no rank from last season");
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
