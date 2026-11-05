// Matches are scored out of the contestants the game really places: 16 from
// stock builds, 24 on Jungle from builds with patch_exe.py (the HUD reports
// cap 24), and Prison stays 16 until more is measured there.
"use strict";

const assert = require("assert");
const { startServer, next } = require("./helpers");

const A = "steam:76561190000000701";
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

(async () => {
  const srv = startServer(8155);
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

    await test("the lobby tells new menus how many bots each map has", async () => {
      const { view, r } = await ranked("jungle", { placement: 3, cap: 24 });
      assert.deepStrictEqual(view.matchBotsByMap, { jungle: 23, prison: 15 });
      assert.strictEqual(view.matchBots, 15, "older menus still show 16 contestants");
      assert.strictEqual(r.ranked.entry.field, 24);
    });

    await test("Jungle from a 24 build: last of 24 is accepted and loses rating", async () => {
      const { r } = await ranked("jungle", { placement: 24, cap: 24, kills: 99 });
      assert.strictEqual(r.ranked.entry.field, 24);
      assert.strictEqual(r.ranked.entry.placement, 24);
      assert.ok(r.ranked.entry.delta < 0, "last of 24 loses rating");
      assert.strictEqual(r.stats.kills, 23, "23 opponents at most");
    });

    await test("Prison is scored as 16 even from a 24 build", async () => {
      const { r } = await ranked("prison", { placement: 16, cap: 24 });
      assert.strictEqual(r.ranked.entry.field, 16);
      assert.ok(r.ranked.entry.delta < 0, "last of 16 loses rating");
    });

    await test("a stock build (no cap) on Jungle is still scored as 16", async () => {
      const { r } = await ranked("jungle", { placement: 16 });
      assert.strictEqual(r.ranked.entry.field, 16);
      assert.ok(r.ranked.entry.delta < 0, "last of 16 loses rating");
    });

    await test("a cap above the most any build has counts as 24", async () => {
      const { r } = await ranked("jungle", { placement: 30, cap: 999 });
      // A rank beyond the field is scored as last place, not dropped (a
      // dropped result left the match pending, later counted as abandoned).
      assert.strictEqual(r.ranked.entry.field, 24);
      assert.strictEqual(r.ranked.entry.placement, 24, "placement 30 of 24 counts as 24th");
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
