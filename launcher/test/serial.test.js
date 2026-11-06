// lib/serial.js: game-folder jobs run one at a time, in order, a failing one
// doesn't stop the next; an exclusive action refuses a second one at once
// (before the first's first await) and frees itself however it ends.
"use strict";

const assert = require("assert");
const { createSerial, createExclusive } = require("../lib/serial");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await test("jobs run one at a time, in the order queued", async () => {
    const q = createSerial();
    const log = [];
    let running = 0, most = 0;
    const job = (name, ms) => q.run(async () => {
      running++; most = Math.max(most, running);
      log.push("start " + name);
      await wait(ms);
      log.push("end " + name);
      running--;
      return name;
    });
    const results = await Promise.all([job("a", 30), job("b", 5), job("c", 1)]);
    assert.deepStrictEqual(results, ["a", "b", "c"]);
    assert.strictEqual(most, 1, "never two at once");
    assert.deepStrictEqual(log, ["start a", "end a", "start b", "end b", "start c", "end c"]);
    assert.strictEqual(q.pending, 0);
  });

  await test("a failing job rejects its caller only; the next one runs", async () => {
    const q = createSerial();
    const first = q.run(async () => { throw new Error("locked file"); });
    const second = q.run(() => "ran");
    await assert.rejects(first, /locked file/);
    assert.strictEqual(await second, "ran");
    const third = q.run(() => { throw new Error("thrown synchronously"); });
    await assert.rejects(third, /thrown synchronously/);
    assert.strictEqual(await q.run(() => 4), 4);
  });

  await test("an exclusive action refuses a second at once, with the running one's message, and frees itself", async () => {
    const a = createExclusive({ sync: "Wait for Game Sync to finish" });
    let release;
    const first = a.run("sync", () => new Promise((r) => { release = r; }));
    assert.strictEqual(a.current, "sync", "claimed before the first await");
    await assert.rejects(a.run("rollback", async () => "no"), /Wait for Game Sync to finish/);
    await assert.rejects(a.run("other", async () => "no"), /Wait for Game Sync to finish/);
    release("done");
    assert.strictEqual(await first, "done");
    assert.strictEqual(a.current, null);
    await assert.rejects(a.run("check", async () => { throw new Error("offline"); }), /offline/);
    assert.strictEqual(a.current, null, "freed after a failure");
    const plain = createExclusive();
    plain.run("x", () => new Promise(() => {}));
    await assert.rejects(plain.run("y", async () => "no"), /Wait for the launcher to finish/, "a default message");
  });

  console.log("all %d serial tests passed", passed);
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exitCode = 1; });
