// Matches are scored out of the contestants the game really places: one per
// pod, 16 on Jungle and Prison, whatever cap the HUD reports (1.3.11's
// reported 24 and put 8 contestants in shared pods).
"use strict";

const assert = require("assert");
const { startServer, next } = require("./helpers");

const A = "steam:76561190000000701";
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

(async () => {
  const srv = startServer();
  const sockets = [];
  try {
    await srv.ready();
    const a = await srv.connect(await srv.login(A));
    sockets.push(a);

    // A ranked match on `map`, then its result.
    async function ranked(map, result) {
      const lobby = next(a, "remaster-lobby");
      a.emit("join-mm", { queueName: "ranked_ffa_" + map });
      const view = await lobby;
      const ready = await next(a, "match-ready");
      assert.strictEqual(ready.gameServer, "offline:" + (map === "prison" ? 1 : 0));
      const r = await srv.request("POST", "/api/matchresult", Object.assign({ victory: false }, result));
      assert.strictEqual(r.status, 200);
      return { view, r: r.json };
    }

    await test("the lobby tells new menus how many bots each map has: 15 for its 16 pods", async () => {
      const { view, r } = await ranked("jungle", { placement: 3, cap: 16 });
      assert.deepStrictEqual(view.matchBotsByMap, { jungle: 15, prison: 15 });
      assert.strictEqual(view.matchBots, 15, "older menus show 16 contestants too");
      assert.strictEqual(r.ranked.entry.field, 16);
    });

    await test("Jungle from a current build (cap 16): last of 16 is accepted and loses rating", async () => {
      const { r } = await ranked("jungle", { placement: 16, cap: 16, kills: 99 });
      assert.strictEqual(r.ranked.entry.field, 16);
      assert.strictEqual(r.ranked.entry.placement, 16);
      assert.ok(r.ranked.entry.delta < 0, "last of 16 loses rating");
      assert.strictEqual(r.stats.kills, 15, "15 opponents at most");
    });

    await test("Jungle from a 1.3.11 build (cap 24, 8 in shared pods): scored as the map's 16", async () => {
      const { r } = await ranked("jungle", { placement: 24, cap: 24 });
      assert.strictEqual(r.ranked.entry.field, 16);
      assert.strictEqual(r.ranked.entry.placement, 16, "24th counts as last of 16");
      assert.ok(r.ranked.entry.delta < 0, "last loses rating");
    });

    await test("Prison is scored as 16 from any build", async () => {
      const { r } = await ranked("prison", { placement: 16, cap: 24 });
      assert.strictEqual(r.ranked.entry.field, 16);
      assert.ok(r.ranked.entry.delta < 0, "last of 16 loses rating");
    });

    await test("a stock build (no cap) on Jungle is still scored as 16", async () => {
      const { r } = await ranked("jungle", { placement: 16 });
      assert.strictEqual(r.ranked.entry.field, 16);
      assert.ok(r.ranked.entry.delta < 0, "last of 16 loses rating");
    });

    await test("a cap above the most any build has counts as the map's 16", async () => {
      const { r } = await ranked("jungle", { placement: 30, cap: 999 });
      // A rank beyond the field is scored as last place, not dropped (a
      // dropped result left the match pending, later counted as abandoned).
      assert.strictEqual(r.ranked.entry.field, 16);
      assert.strictEqual(r.ranked.entry.placement, 16, "placement 30 of 16 counts as 16th");
    });

    console.log("all %d field tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
})();
