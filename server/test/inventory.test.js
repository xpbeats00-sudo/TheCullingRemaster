// The item list push (get-inventory-types): about 800 KB, so a stale version
// can't make the server send it over and over (FULL_AUDIT_2026-11-06 P1: about
// 24 MB/s per address at the socket limits). The full list goes to a socket at
// most once a minute; the up-to-date answer is always sent.
"use strict";

const assert = require("assert");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const catalog = require("../data/catalog.json");

(async () => {
  const srv = startServer();
  let socket = null;
  try {
    await srv.ready();
    socket = await srv.connect(await srv.login("steam:76561190000000131"));
    const replies = [];
    socket.on("inventory-types-response", (m) => replies.push(m));

    await test("a stale version gets the full list, as the game's parser reads it", async () => {
      const reply = next(socket, "inventory-types-response");
      socket.emit("get-inventory-types", "old");
      const m = await reply;
      assert.strictEqual(m.data.versionOK, false);
      assert.strictEqual(m.data.types.length, catalog.length);
      const i = catalog.find((x) => x.source);
      const t = m.data.types.find((x) => x.tid === i.tid);
      assert.deepStrictEqual([t.tn, t.pc, t.r], [i.displayName, Math.round(i.purchaseCost), i.rarity]);
      replies.length = 0;
      socket.current = m.data.currentVersion;
    });

    await test("asking again within a minute doesn't send the list again", async () => {
      for (let i = 0; i < 5; i++) socket.emit("get-inventory-types", "old");
      await sleep(500);
      assert.ok(!replies.some((m) => m.data.types), "no second full list: " + replies.length);
    });

    await test("the current version is always answered", async () => {
      replies.length = 0;
      const reply = next(socket, "inventory-types-response");
      socket.emit("get-inventory-types", socket.current);
      assert.deepStrictEqual((await reply).data, { versionOK: true, currentVersion: socket.current });
    });

    await test("another socket gets its own full list", async () => {
      const other = await srv.connect(await srv.login("steam:76561190000000132"));
      try {
        const reply = next(other, "inventory-types-response");
        other.emit("get-inventory-types", "");
        assert.strictEqual((await reply).data.types.length, catalog.length);
      } finally { other.close(); }
    });

    console.log("all %d inventory tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    if (socket) socket.close();
    srv.stop();
  }
})();
