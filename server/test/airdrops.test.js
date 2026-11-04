// The airdrops that start locked unlock by level (catalog unlockLevel, from
// patch/make_airdrop_unlocks.py), and a level-up in a match unlocks them in the
// menu straight away.
"use strict";

const assert = require("assert");
const { startServer, next } = require("./helpers");

const LOW = "steam:76561190000000601";
const HIGH = "steam:76561190000000602";
// Airdrop ItemIDs.
const SNIPER = 140133, ARCHER = 140102, VIKING = 140142, CYCLOPS = 140111, THE_IMP = 140138, POLECAT = 140126;
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

const profile = (userID, xp, level) => ({
  userID, cullCredits: 100, premiumCurrency: 0, cardID: 0, economy: 1, owned: [],
  stats: { xp, level, kills: 0, wins: 0, gamesPlayed: 0, totalDamage: 0, minutesAlive: 0, funcEarned: 0, rank: 0 },
  ranked: null
});

async function owned(socket) {
  const reply = next(socket, "entitlements-response");
  socket.emit("get-entitlements");
  return new Set((await reply).data.items.map((x) => x.i));
}

(async () => {
  const srv = startServer(8153, { profiles: { [LOW]: profile(LOW, 0, 1), [HIGH]: profile(HIGH, 850, 9) } });
  const sockets = [];
  try {
    await srv.ready();
    // Level n starts above 100 * (n - 1) - 1 XP.
    await srv.request("POST", "/api/levelcurve", { high: Array.from({ length: 15 }, (_, i) => 100 * (i + 1) - 1) });

    await test("the catalog has every airdrop in the menu, with the locked ones' levels", async () => {
      const catalog = require("../data/catalog.json");
      const level = (tid) => (catalog.find((i) => i.tid === tid) || {}).unlockLevel;
      for (const tid of [ARCHER, VIKING, CYCLOPS, THE_IMP, POLECAT]) assert.ok(catalog.some((i) => i.tid === tid), "tid " + tid);
      assert.strictEqual(level(SNIPER), undefined, "the starters stay free");
      assert.deepStrictEqual([VIKING, CYCLOPS, THE_IMP, POLECAT].map(level), [6, 8, 9, 10]);
      for (const i of catalog) if (i.unlockLevel) assert.ok(i.unlockLevel <= 14, "reachable this season: " + i.asset);
    });

    const low = await srv.connect(await srv.login(LOW));
    const high = await srv.connect(await srv.login(HIGH));
    sockets.push(low, high);

    await test("a new player has the starters but not the locked airdrops", async () => {
      const items = await owned(low);
      assert.ok(items.has(SNIPER) && items.has(ARCHER));
      for (const tid of [VIKING, CYCLOPS, THE_IMP, POLECAT]) assert.ok(!items.has(tid), "locked: " + tid);
    });

    await test("a level 9 player has the airdrops up to level 9", async () => {
      const items = await owned(high);
      for (const tid of [VIKING, CYCLOPS, THE_IMP]) assert.ok(items.has(tid), "unlocked: " + tid);
      assert.ok(!items.has(POLECAT), "Polecat needs level 10");
    });

    await test("levelling up in a match unlocks them in the menu without a restart", async () => {
      low.emit("join-mm", { queueName: "ffa" });
      await next(low, "match-ready");
      const pushed = next(low, "entitlements-response");
      const r = await srv.request("POST", "/api/matchresult", { victory: false, kills: 3, damage: 300, timeAlive: 600, func: 0, placement: 5 });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.stats.level >= 6, "level " + r.json.stats.level);
      const items = new Set((await pushed).data.items.map((x) => x.i));
      assert.ok(items.has(VIKING), "Viking unlocked at level " + r.json.stats.level);
    });

    console.log("all %d airdrop tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) if (s) s.close();
    srv.stop();
  }
})();
