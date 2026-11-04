// Showdown, version 1: the "showdown" queue starts straight away (no lobby or
// map vote) as "showdown:1v1", and its result is scored as 2 contestants.
"use strict";

const assert = require("assert");
const { startServer, next } = require("./helpers");

const A = "steam:76561190000000801";
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

(async () => {
  const srv = startServer(8157);
  const sockets = [];
  try {
    await srv.ready();
    const a = await srv.connect(await srv.login(A));
    sockets.push(a);
    let lobbies = 0;
    a.on("remaster-lobby", () => lobbies++);

    await test("the showdown queue starts the arena match without a lobby", async () => {
      a.emit("join-mm", { queueName: "showdown" });
      const ready = await next(a, "match-ready");
      assert.strictEqual(ready.gameServer, "showdown:1v1");
      assert.strictEqual(lobbies, 0, "no lobby for Showdown");
    });

    await test("a Showdown win counts, with at most the one opponent killed", async () => {
      const r = await srv.request("POST", "/api/matchresult", { victory: true, kills: 9, damage: 120, timeAlive: 150, placement: 1, cap: 24 });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.stats.wins, 1);
      assert.strictEqual(r.json.stats.kills, 1, "one opponent");
      assert.strictEqual(r.json.ranked, null, "not ranked");
    });

    await test("the other queues still go through the lobby", async () => {
      const lobby = next(a, "remaster-lobby");
      a.emit("join-mm", { queueName: "ffa_jungle" });
      await lobby;
      const ready = await next(a, "match-ready");
      assert.strictEqual(ready.gameServer, "offline:0");
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
