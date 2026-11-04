// Showdown: you against one bot in the arena, first to 4 rounds.
// Part 1: the series rules (server/showdown.js). Part 2: a throwaway server -
// the queue starts straight away (no lobby) as "showdown:1v1", results move
// the score, the HUD gets the round and kit, and the menu gets the next round.
"use strict";

const assert = require("assert");
const { ShowdownSeries } = require("../showdown");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

const KIT = require("../data/showdown.json").kit;
const A = "steam:76561190000000801";

(async () => {
  // ------------------------------------------------------------ rules
  await test("first to 4 wins the series; at most 7 rounds", async () => {
    const sd = new ShowdownSeries();
    const u = "u1";
    let v;
    for (const won of [true, false, true, false, true, false, true]) {
      sd.startRound(u);
      v = sd.recordRound(u, won);
    }
    assert.strictEqual(v.wins, 4);
    assert.strictEqual(v.losses, 3);
    assert.strictEqual(v.round, 7);
    assert.ok(v.over && v.won);
    assert.strictEqual(sd.maxRounds, 7);
  });

  await test("four lost rounds is a defeat; a new queue starts a new series", async () => {
    const sd = new ShowdownSeries();
    for (let i = 0; i < 4; i++) { sd.startRound("u"); sd.recordRound("u", false); }
    assert.ok(sd.last("u").over && sd.last("u").won === false);
    const v = sd.startRound("u");
    assert.deepStrictEqual([v.round, v.wins, v.losses], [1, 0, 0]);
  });

  await test("a round left without a result is lost when the next starts", async () => {
    const sd = new ShowdownSeries();
    sd.startRound("u");
    const v = sd.startRound("u");
    assert.deepStrictEqual(v.rounds, ["left"]);
    assert.deepStrictEqual([v.round, v.losses], [2, 1]);
  });

  await test("a result outside a round changes nothing (no double count)", async () => {
    const sd = new ShowdownSeries();
    sd.startRound("u");
    sd.recordRound("u", true);
    assert.strictEqual(sd.recordRound("u", true), null);
    assert.strictEqual(sd.last("u").wins, 1);
  });

  await test("leaving ends the series as a forfeit", async () => {
    const sd = new ShowdownSeries();
    sd.startRound("u"); sd.recordRound("u", true);
    const v = sd.leave("u");
    assert.ok(v.over && v.forfeit && v.won === false);
  });

  await test("an idle series is dropped after 30 minutes", async () => {
    let t = 0;
    const sd = new ShowdownSeries({ now: () => t });
    sd.startRound("u"); sd.recordRound("u", true);
    t = 31 * 60 * 1000;
    assert.strictEqual(sd.current("u"), null);
  });

  // ------------------------------------------------------------ server
  const srv = startServer(8157);
  const sockets = [];
  try {
    await srv.ready();
    const a = await srv.connect(await srv.login(A));
    sockets.push(a);
    let lobbies = 0;
    a.on("remaster-lobby", () => lobbies++);

    async function round(result) {
      const state = next(a, "remaster-showdown");
      const readyP = next(a, "match-ready");
      a.emit("join-mm", { queueName: "showdown" });
      const s = await state;
      const ready = await readyP;
      assert.strictEqual(ready.gameServer, "showdown:1v1");
      const hud = await srv.request("GET", "/api/showdown");
      const r = await srv.request("POST", "/api/matchresult", Object.assign({ damage: 120, timeAlive: 90, placement: 1, cap: 24 }, result));
      assert.strictEqual(r.status, 200);
      return { start: s, hud: hud.json, result: r.json };
    }

    await test("the showdown queue starts round 1 without a lobby, with the kit", async () => {
      const { start, hud, result } = await round({ victory: true, kills: 9 });
      assert.strictEqual(lobbies, 0, "no lobby for Showdown");
      assert.strictEqual(start.phase, "round");
      assert.strictEqual(start.series.round, 1);
      assert.strictEqual(start.kit.id, KIT.id);
      assert.ok(hud.active, "the HUD sees the round");
      assert.strictEqual(hud.series.round, 1);
      assert.deepStrictEqual(hud.kit.items.map((i) => i.id), KIT.items.map((i) => i.id));
      assert.strictEqual(result.stats.kills, 1, "one opponent");
      assert.strictEqual(result.ranked, null, "not ranked");
      assert.strictEqual(result.showdown.phase, "round-over");
      assert.deepStrictEqual([result.showdown.series.wins, result.showdown.series.losses], [1, 0]);
    });

    await test("the kit's armor is the only item marked auto-equip", async () => {
      for (const i of KIT.items) assert.strictEqual(i.autoEquip, i.category === "armor", i.id);
    });

    await test("back in the menu the next round is offered", async () => {
      const b = await srv.connect(await srv.login(A));
      sockets.push(b);
      const s = await next(b, "remaster-showdown");
      assert.strictEqual(s.phase, "next");
      assert.strictEqual(s.series.round, 1);
      b.close();
    });

    await test("the series ends at 4 round wins with VICTORY", async () => {
      let last;
      for (const won of [false, true, true, true]) last = (await round({ victory: won, kills: won ? 1 : 0 })).result;
      assert.strictEqual(last.showdown.phase, "over");
      assert.deepStrictEqual([last.showdown.series.wins, last.showdown.series.losses], [4, 1]);
      assert.ok(last.showdown.series.won);
      assert.strictEqual(last.stats.wins, 4, "each round won counts as a win");
    });

    await test("the HUD sees no Showdown in a normal match", async () => {
      const lobby = next(a, "remaster-lobby");
      a.emit("join-mm", { queueName: "ffa_jungle" });
      await lobby;
      const ready = await next(a, "match-ready");
      assert.strictEqual(ready.gameServer, "offline:0");
      const hud = await srv.request("GET", "/api/showdown");
      assert.strictEqual(hud.json.active, false);
    });

    await test("Duo starts the pairs mode on the voted map (duo:<map>)", async () => {
      for (const [queue, want] of [["ffa_jungle_coop2", "duo:0"], ["ffa_prison_coop2", "duo:1"]]) {
        const lobby = next(a, "remaster-lobby");
        a.emit("join-mm", { queueName: queue });
        await lobby;
        const ready = await next(a, "match-ready");
        assert.strictEqual(ready.gameServer, want, queue);
      }
    });

    console.log("all %d showdown tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
})();
