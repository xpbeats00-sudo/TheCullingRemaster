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

  await test("a Repair returns what its check found", async () => {
    const todo = [{ path: "Victory/a.pak" }];
    Object.defineProperty(todo, "report", { value: { ok: 3, missing: 0, changed: 1, staged: 0 }, enumerable: false });
    const r = { files: 1, bytes: 10, seconds: 1, retries: 0, kept: 1 };
    assert.deepStrictEqual(status.syncOutcome(r, todo, true), { synced: r, repaired: { ok: 3, missing: 0, changed: 1, staged: 0 } });
    assert.deepStrictEqual(status.syncOutcome(r, todo, false), { synced: r, repaired: null });
    assert.deepStrictEqual(status.syncOutcome(r, [], true), { synced: r, repaired: null });
    // The main process reads it before clearing the plan.
    const main = require("fs").readFileSync(require("path").join(__dirname, "..", "main.js"), "utf8");
    const at = main.indexOf("status.syncOutcome(r, todo, repair)");
    assert.ok(at > 0, "the sync handler uses syncOutcome");
    assert.ok(!main.slice(main.lastIndexOf("sync.apply(", at), at).includes("todo = []"), "the plan isn't cleared before its report is read");
  });

  await test("the window fits the screen's work area", async () => {
    assert.deepStrictEqual(status.windowSize({ width: 1920, height: 1040 }), { width: 1280, height: 760, minWidth: 1100, minHeight: 660 });
    // 1366x768 at 125% scaling: a 1093x582 work area.
    assert.deepStrictEqual(status.windowSize({ width: 1093, height: 582 }), { width: 1093, height: 582, minWidth: 1093, minHeight: 582 });
    assert.deepStrictEqual(status.windowSize({ width: 1200, height: 700 }), { width: 1200, height: 700, minWidth: 1100, minHeight: 660 });
    assert.deepStrictEqual(status.windowSize(null), { width: 1280, height: 760, minWidth: 1100, minHeight: 660 }, "no screen info: the designed size");
  });

  await test("start-up labels: a vanished folder isn't 'Ready to install'", async () => {
    const missing = { ok: false, installable: false, missing: true, reason: "gone" };
    assert.strictEqual(status.bootLabel({ online: true, check: missing, todo: null }), "Game folder not found");
    assert.strictEqual(status.bootLabel({ online: false, check: missing, todo: null }), "Game folder not found");
    assert.strictEqual(status.bootLabel({ online: true, check: { ok: false, installable: true }, todo: [{}] }), "Ready to install");
    assert.strictEqual(status.bootLabel({ online: false, check: ok, todo: null }), "Offline");
    assert.strictEqual(status.bootLabel({ online: true, check: ok, todo: [] }), "Ready");
    assert.strictEqual(status.bootLabel({ online: true, check: { ok: false, installable: false }, todo: null }), "Choose a game folder");
  });

  await test("the start-up screen always finishes, an error included", async () => {
    const seen = [];
    const progress = (p, label) => seen.push([p, label]);
    assert.strictEqual(await status.finishBoot(async () => "Ready", progress, () => "x"), "Ready");
    assert.deepStrictEqual(seen.pop(), [1, "Ready"]);
    const label = await status.finishBoot(async () => { throw new Error("EPERM settings.json"); }, progress, (e) => "Couldn't finish: " + e.message);
    assert.strictEqual(label, "Couldn't finish: EPERM settings.json");
    assert.deepStrictEqual(seen.pop(), [1, "Couldn't finish: EPERM settings.json"], "100% with the error: the screen can go on");
    await status.finishBoot(() => { throw new Error("sync"); }, progress, () => { throw new Error("worse"); });
    assert.deepStrictEqual(seen.pop(), [1, "Start-up checks failed"]);
    assert.strictEqual(await status.finishBoot(async () => status.HANDED_OFF, progress, () => "x"), status.HANDED_OFF);
    assert.strictEqual(seen.length, 0, "a launcher update taking over leaves the screen as it is");
  });

  console.log("all %d status tests passed", passed);
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exitCode = 1; });
