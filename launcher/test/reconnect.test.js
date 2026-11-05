// Getting back online after an offline start (lib/reconnect.js), and the
// window's Retry and ping refresh (src/ui-logic.js).
"use strict";

const assert = require("assert");
const { createReconnect, DELAYS } = require("../lib/reconnect");
const ui = require("../src/ui-logic");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  await test("offline at start-up: tries again with growing waits until it is back", async () => {
    const at = [];
    let online = false, onlines = 0;
    const t0 = Date.now();
    const r = createReconnect(async () => { at.push(Date.now() - t0); if (!online) throw new Error("fetch failed"); return true; },
      { delays: [20, 40, 80, 400], onOnline: () => onlines++ });
    r.start();
    await wait(300);
    assert.ok(at.length >= 3, "tried several times: " + at);
    assert.ok(at[1] - at[0] >= 30 && at[2] - at[1] >= 70, "waits grow: " + at);
    online = true;
    await wait(500);
    assert.strictEqual(onlines, 1, "back online once");
    const n = at.length;
    await wait(150);
    assert.strictEqual(at.length, n, "no more tries once online");
    assert.strictEqual(r.pending, false);
    assert.deepStrictEqual(DELAYS, [5000, 10000, 20000, 40000, 60000], "5 s up to once a minute");
  });

  await test("Retry tries at once, and a failed Retry keeps the automatic tries going", async () => {
    let online = false, calls = 0;
    const r = createReconnect(async () => { calls++; return online; }, { delays: [10000] });
    r.start();
    assert.strictEqual(await r.now(), false, "still offline");
    assert.strictEqual(calls, 1);
    assert.strictEqual(r.pending, true, "next automatic try scheduled");
    online = true;
    const [a, b] = await Promise.all([r.now(), r.now()]);
    assert.ok(a && b);
    assert.strictEqual(calls, 2, "two presses at once: one try");
    assert.strictEqual(r.pending, false);
    r.start();
    r.cancel();
    assert.strictEqual(r.pending, false, "cancelled when online some other way");
  });

  await test("the window offers Retry while offline and refreshes pings regularly", () => {
    assert.strictEqual(ui.showRetry({ online: false }, false), true);
    assert.strictEqual(ui.showRetry({ online: false }, true), false, "not while a sync runs");
    assert.strictEqual(ui.showRetry({ online: true }, false), false);
    assert.ok(ui.PING_EVERY_MS >= 30000 && ui.PING_EVERY_MS <= 60000);
  });

  console.log("all %d reconnect tests passed", passed);
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exitCode = 1; });
