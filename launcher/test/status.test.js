// The main process's decisions (lib/status.js): what PLAY may do and what
// the start-up checks say.
"use strict";

const assert = require("assert");
const status = require("../lib/status");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

(async () => {
  const ok = { ok: true, funcLauncher: true, clientDll: true };
  const ready = { busy: false, check: ok, installed: true, supported: true, signedIn: true };

  await test("PLAY on an install that uses a real Steam account says so, not 'Sign in'", () => {
    assert.strictEqual(status.playBlocker(Object.assign({}, ready, { supported: false, signedIn: false })), status.STEAM_ACCOUNT);
    assert.strictEqual(status.playBlocker(Object.assign({}, ready, { signedIn: false })), "Sign in or create an account first");
    assert.strictEqual(status.playBlocker(ready), null);
    assert.strictEqual(status.playBlocker(Object.assign({}, ready, { busy: true })), "Wait for Game Sync to finish");
    assert.match(status.playBlocker(Object.assign({}, ready, { installed: false })), /isn't fully installed/);
    assert.strictEqual(status.playBlocker(Object.assign({}, ready, { check: { ok: false, reason: "No game folder chosen" } })), "No game folder chosen");
  });

  await test("PLAY while the game is already running is refused", () => {
    assert.strictEqual(status.playBlocker(Object.assign({}, ready, { running: true })), "The Culling is already running");
    assert.strictEqual(status.playBlocker(Object.assign({}, ready, { running: true, busy: true, signedIn: false })), "The Culling is already running");
  });

  await test("the game watch: running from PLAY until the game was seen and is gone", async () => {
    let up = false;
    const changes = [];
    let exits = 0;
    const w = status.createGameWatch({ isRunning: async () => up, onChange: (v) => changes.push(v), onExit: () => exits++, pollMs: 10, startMs: 60 });
    assert.strictEqual(w.running, false);
    w.start();
    assert.strictEqual(w.running, true, "running (starting) right after PLAY");
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(w.running, true, "not seen yet, still within the start window");
    up = true;
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(w.running, true, "seen: running past the start window");
    up = false;
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(w.running, false, "gone");
    assert.deepStrictEqual(changes, [true, false]);
    assert.strictEqual(exits, 1);
    // A game that never shows up stops counting after the start window.
    w.start();
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(w.running, false);
    // Found running at start-up: gone means gone at once.
    up = true;
    w.start({ alreadyRunning: true });
    up = false;
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(w.running, false);
    w.stop();
  });

  await test("isRunning asks tasklist without blocking and reads its answer", async () => {
    const game = require("../lib/game");
    let asked = null;
    const fake = (out, err) => (file, args, opts, cb) => { asked = { file, args }; setImmediate(() => cb(err || null, out)); };
    const p = game.isRunning({ platform: "win32", execFileImpl: fake('Victory.exe                  1234 Console    1   2,000,000 K\r\n') });
    assert.ok(p instanceof Promise, "doesn't block: a promise");
    assert.strictEqual(await p, true);
    assert.deepStrictEqual(asked, { file: "tasklist", args: ["/FI", "IMAGENAME eq Victory.exe", "/NH"] });
    assert.strictEqual(await game.isRunning({ platform: "win32", execFileImpl: fake("INFO: No tasks are running which match the specified criteria.\r\n") }), false);
    assert.strictEqual(await game.isRunning({ platform: "win32", execFileImpl: fake("", new Error("tasklist missing")) }), false);
    assert.strictEqual(await game.isRunning({ platform: "win32", execFileImpl: () => { throw new Error("spawn failed"); } }), false);
    assert.strictEqual(await game.isRunning({ platform: "linux" }), false);
  });

  console.log("all %d status tests passed", passed);
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exitCode = 1; });
