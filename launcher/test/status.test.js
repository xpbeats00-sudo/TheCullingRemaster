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

  console.log("all %d status tests passed", passed);
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exitCode = 1; });
