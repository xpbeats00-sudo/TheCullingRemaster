// CUSTOM matches (custommatch.js): a lobby of one, the map and the stock
// custom-match settings (lobby-set-mods, validated and bounded), and START
// answered with "custom:<map>:<mods>" for ClientWeb.js to open; joining
// someone's lobby is refused with a reason the menu shows.
"use strict";

const assert = require("assert");
const { startServer, next } = require("./helpers");
const custom = require("../custommatch");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

// The stock values: an untouched lobby sends no ?mods= at all.
const STOCK = custom.defaults();

(async () => {
  await test("cleanMods keeps whole numbers within bounds and ignores the rest", async () => {
    const out = custom.cleanMods({ NumGreenCrateSpawn: 40, NumBlueCrateSpawn: 9999, FreqHealthGivenInSeconds: 0,
      RecyclerUseTime: "7", ChancesLockerPreOpened: 2.5, FuncCostForHealth: "x", StartingActivityValue: 99,
      __proto__: { NumRedCrateSpawn: 77 }, toString: 1 });
    assert.strictEqual(out.NumGreenCrateSpawn, 40);
    assert.strictEqual(out.NumBlueCrateSpawn, 200, "clamped to the max");
    assert.strictEqual(out.FreqHealthGivenInSeconds, 1, "clamped to the min");
    assert.strictEqual(out.RecyclerUseTime, 7, "a numeric string");
    assert.strictEqual(out.ChancesLockerPreOpened, 50, "not a whole number: unchanged");
    assert.strictEqual(out.FuncCostForHealth, 1, "not a number: unchanged");
    assert.strictEqual(out.NumRedCrateSpawn, 3, "inherited keys are not read");
    assert.ok(!Object.keys(out).includes("StartingActivityValue") && !Object.keys(out).includes("toString"), "unknown keys are dropped");
    assert.deepStrictEqual(Object.keys(out), custom.MODS.map((m) => m[0]));
    assert.deepStrictEqual(custom.cleanMods(null, out), out, "nothing sent: unchanged");
    assert.deepStrictEqual(custom.cleanMods([1, 2], out), out);
  });

  await test("encode: only the settings that differ from stock, in index order", async () => {
    assert.strictEqual(custom.encode(STOCK), "");
    assert.strictEqual(custom.encode(Object.assign({}, STOCK, { RecyclerUseTime: 2, NumGreenCrateSpawn: 0 })), "0=0|16=2");
    assert.strictEqual(custom.gameServer("Jungle2/Jungle2_P", Object.assign({}, STOCK, { ChancesLockerPreOpened: 100 })),
      "custom:1:12=100");
    assert.strictEqual(custom.gameServer("anything else", STOCK), "custom:0:");
  });

  const srv = startServer();
  const sockets = [];
  try {
    await srv.ready();
    const a = await srv.connect(await srv.login("steam:76561190000000911"));
    sockets.push(a);

    await test("a lobby of one, on a stock map, with the stock settings", async () => {
      const update = next(a, "lobby-update");
      a.emit("lobby-create", { cullingcard: 3, mapName: "../../Evil?game=x" });
      const lobby = await update;
      assert.strictEqual(lobby.members.length, 1);
      assert.strictEqual(lobby.mapName, "Jungle/Jungle_P", "an unknown map is the Jungle");
      assert.deepStrictEqual(lobby.mods, STOCK);
      // What the stock CUSTOM screen needs to list the owner (Custom.js updateLobbyData).
      const m = lobby.members[0];
      assert.strictEqual(m.user, lobby.owner);
      assert.strictEqual(m.userData.userID, lobby.owner);
      assert.strictEqual(typeof m.userData.userName, "string");
      assert.ok(Number.isInteger(m.userData.stats.level) && m.userData.stats.level >= 1);
      assert.strictEqual(m.userData.cullingcard, "3");
    });

    await test("a bad calling card ID is the profile's card", async () => {
      const update = next(a, "lobby-update");
      a.emit("lobby-create", { cullingcard: { evil: 1 }, mapName: "Jungle/Jungle_P" });
      assert.ok(/^\d+$/.test((await update).members[0].userData.cullingcard));
    });

    await test("START with the stock settings opens the plain map", async () => {
      const ready = next(a, "match-ready");
      a.emit("lobby-start-match");
      const msg = await ready;
      assert.strictEqual(msg.gameServer, "custom:0:");
      assert.ok(msg.nonce && msg.serverNonce);
    });

    await test("the map and the settings reach START", async () => {
      const update = next(a, "lobby-update");
      a.emit("lobby-set-map", { mapName: "Jungle2/Jungle2_P" });
      assert.strictEqual((await update).mapName, "Jungle2/Jungle2_P");
      const ack = next(a, "lobby-set-mods-ack");
      a.emit("lobby-set-mods", { mods: Object.assign({}, STOCK, { NumGreenCrateSpawn: 30, HealthGivenFromHealthStation: 10,
        RecyclerUseTime: 600 }) });
      const mods = (await ack).mods;
      assert.strictEqual(mods.NumGreenCrateSpawn, 30);
      assert.strictEqual(mods.RecyclerUseTime, 60, "bounded");
      const ready = next(a, "match-ready");
      a.emit("lobby-start-match");
      assert.strictEqual((await ready).gameServer, "custom:1:0=30|13=10|16=60");
    });

    await test("a bad map name keeps the lobby's map; bad settings keep theirs", async () => {
      const update = next(a, "lobby-update");
      a.emit("lobby-set-map", { mapName: "Jungle2_P?mods=99=1" });
      assert.strictEqual((await update).mapName, "Jungle2/Jungle2_P");
      const ack = next(a, "lobby-set-mods-ack");
      a.emit("lobby-set-mods", { mods: "0=1|99=5" });
      assert.strictEqual((await ack).mods.NumGreenCrateSpawn, 30);
      const ready = next(a, "match-ready");
      a.emit("lobby-start-match");
      assert.strictEqual((await ready).gameServer, "custom:1:0=30|13=10|16=60");
    });

    await test("a custom match result is scored as mode custom", async () => {
      const r = await srv.request("POST", "/api/matchresult", { kills: 2, damage: 100, timeAlive: 60, victory: false });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(srv.profiles()["steam:76561190000000911"].modes.custom.played, 1);
    });

    await test("a new lobby starts from the stock settings again", async () => {
      const left = next(a, "lobby-leave-ack");
      a.emit("lobby-leave");
      await left;
      const update = next(a, "lobby-update");
      a.emit("lobby-create", { cullingcard: 3, mapName: "Jungle/Jungle_P" });
      assert.deepStrictEqual((await update).mods, STOCK);
    });

    await test("outside a lobby, settings and START are refused", async () => {
      const left = next(a, "lobby-leave-ack");
      a.emit("lobby-leave");
      await left;
      const fail = next(a, "lobby-set-mods-fail");
      a.emit("lobby-set-mods", { mods: { NumGreenCrateSpawn: 1 } });
      assert.strictEqual((await fail).reason, "not-in-lobby");
      const startFail = next(a, "lobby-start-match-fail");
      a.emit("lobby-start-match");
      assert.strictEqual((await startFail).reason, "not-in-lobby");
    });

    await test("joining someone's custom lobby says why it can't work", async () => {
      const fail = next(a, "lobby-join-fail");
      a.emit("lobby-join", { code: "123456", cullingcard: 3 });
      const reason = (await fail).reason;
      assert.strictEqual(reason, custom.JOIN_REFUSED);
      assert.ok(/party/i.test(reason) && !/bot/i.test(reason));
    });

    console.log("all %d custom match tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
})();
