// Airdrop prices (patch/make_airdrop_prices.py): an airdrop costs FUNC in a
// match, read by the game from the cooked AirDropPackage (ActivityResourceCost).
// The server has no airdrop price to keep in step with it: these check that
// it still has none (catalog and the store types it sends, a purchase charges
// nothing), and that the generated price table follows the 0.75 rule and
// covers the same airdrops as the catalog.
"use strict";

const assert = require("assert");
const path = require("path");
const { startServer, next } = require("./helpers");

const USER = "steam:76561190000000701";
const catalog = require("../data/catalog.json");
const prices = require(path.join(__dirname, "..", "..", "patch", "loot", "airdrop_prices.json"));
const airdrops = catalog.filter((i) => i.class === "AirDropPackageDataAsset");
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

// round(stock * 0.75), halves up, in integers.
const quarterOff = (stock) => Math.floor((2 * stock * 3 + 4) / 8);

(async () => {
  await test("the price table follows round(stock x 0.75) for every priced airdrop", async () => {
    assert.strictEqual(prices.factor, "3/4");
    const priced = prices.airdrops.filter((a) => a.stock !== null);
    assert.ok(priced.length >= 40, "airdrops priced: " + priced.length);
    for (const a of priced) {
      assert.ok(Number.isInteger(a.stock) && Number.isInteger(a.new), a.export);
      assert.strictEqual(a.new, quarterOff(a.stock), a.export);
      assert.ok(Math.abs(a.new - a.stock * 0.75) <= 0.5, a.export);
    }
    for (const [stock, want] of [[85, 64], [70, 53], [95, 71], [205, 154]]) assert.strictEqual(quarterOff(stock), want);
  });

  await test("the price table and the catalog have the same airdrops", async () => {
    const fromTable = new Set(prices.airdrops.map((a) => a.itemId));
    const fromCatalog = new Set(airdrops.map((i) => i.tid));
    assert.deepStrictEqual([...fromTable].sort(), [...fromCatalog].sort());
  });

  await test("the catalog prices no airdrop (owned or unlocked, never bought)", async () => {
    for (const i of airdrops) {
      assert.strictEqual(i.purchaseCost, 0, i.displayName);
      assert.strictEqual(i.premiumCost, 0, i.displayName);
      assert.strictEqual(i.resale, 0, i.displayName);
      assert.strictEqual(i.purchasable, false, i.displayName);
      assert.strictEqual(i.premiumPurchasable, false, i.displayName);
    }
  });

  const srv = startServer({ profiles: { [USER]: {
    userID: USER, cullCredits: 500, premiumCurrency: 0, cardID: 0, economy: 1, owned: [],
    stats: { xp: 0, level: 1, kills: 0, wins: 0, gamesPlayed: 0, totalDamage: 0, minutesAlive: 0, funcEarned: 0, rank: 0 }, ranked: null } } });
  let socket = null;
  try {
    await srv.ready();
    socket = await srv.connect(await srv.login(USER));

    await test("the store types the server sends give every airdrop no price and no sale", async () => {
      const reply = next(socket, "inventory-types-response");
      socket.emit("get-inventory-types", "");
      const types = new Map((await reply).data.types.map((t) => [t.tid, t]));
      for (const i of airdrops) {
        const t = types.get(i.tid);
        assert.ok(t, "sent: " + i.displayName);
        assert.deepStrictEqual([t.pc, t.ppc, t.rv, t.ais, t.aps], [0, 0, 0, false, false], i.displayName);
      }
    });

    await test("asking to buy an airdrop charges no credits", async () => {
      const archer = airdrops.find((i) => i.tid === 140102);
      const reply = Promise.race([next(socket, "purchase-success").then(() => "ok"), next(socket, "purchase-fail").then(() => "fail")]);
      socket.emit("purchase-entitlement", { entitlementID: String(archer.tid) });
      await reply;
      await new Promise((r) => setTimeout(r, 200));
      assert.strictEqual(srv.profiles()[USER].cullCredits, 500);
    });

    console.log("all %d airdrop price tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (socket) socket.close();
    srv.stop();
  }
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exitCode = 1; });
