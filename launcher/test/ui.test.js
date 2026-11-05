// The main screen's decisions (src/ui-logic.js): what the status, PLAY and
// the operation card say for a given launcher state.
"use strict";

const assert = require("assert");
const ui = require("../src/ui-logic");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

test("connections failing one after another read as reconnecting", () => {
  assert.strictEqual(ui.downloadVerb({ reconnecting: false }, false), "Downloading");
  assert.strictEqual(ui.downloadVerb({ reconnecting: true }, false), "Reconnecting");
  assert.strictEqual(ui.downloadVerb({ reconnecting: true }, true), "Pausing", "Pause pressed wins");
});

test("a failed launcher update drops its 'Updating launcher' card", () => {
  const b = (n) => n + " B";
  const v = ui.launcherUpdateView({ phase: "launcher", version: "1.4.0", done: 50, total: 100 }, b);
  assert.strictEqual(v.title, "Updating launcher");
  assert.strictEqual(v.sub, "Version 1.4.0 · 50%");
  assert.ok(v.op.launcher && v.op.frac === 0.5);
  assert.strictEqual(ui.launcherUpdateView({ phase: "launcher", version: "1.4.0", error: "blocked" }, b), null);
  // A state refresh after the failure clears a card still showing.
  assert.strictEqual(ui.keepOp(v.op, { launcherUpdate: { version: "1.4.0", error: "blocked" } }), null);
  assert.strictEqual(ui.keepOp(v.op, { launcherUpdate: null }), null);
  assert.strictEqual(ui.keepOp(v.op, { launcherUpdate: { version: "1.4.0", done: 50, total: 100 } }), v.op, "still updating: kept");
  const sync = { kind: "Operation in progress · Downloading" };
  assert.strictEqual(ui.keepOp(sync, { launcherUpdate: { error: "x" } }), sync, "a game download's card isn't touched");
});

test("odd settings can't break drawing the screen", () => {
  assert.strictEqual(ui.hostOf("https://xplab.shop:8443/remaster/manifest.json"), "xplab.shop:8443");
  assert.strictEqual(ui.hostOf("not a url"), "-");
  assert.strictEqual(ui.hostOf(undefined), "-");
  const servers = [{ id: "a" }, { id: "b" }];
  assert.strictEqual(ui.selectedServer({ servers, settings: { serverId: "b" } }).id, "b");
  assert.strictEqual(ui.selectedServer({ servers, settings: { serverId: "gone" } }).id, "a");
  assert.strictEqual(ui.selectedServer({ servers: [], settings: { serverId: "a" } }), null);
});

test("the window controls are wired before the launcher's state is asked for", () => {
  const src = require("fs").readFileSync(require("path").join(__dirname, "..", "src", "main-ui.js"), "utf8");
  const start = src.slice(src.indexOf("async function start()"));
  assert.ok(start.indexOf("[data-window]") >= 0 && start.indexOf("[data-window]") < start.indexOf("api.state()"));
});

// A launcher state: installed, up to date, online, signed in.
function st(over = {}) {
  return Object.assign({ online: true, installed: "1.0.0", release: "1.0.0", game: { ok: true, funcLauncher: true, clientDll: true },
    pending: { files: 0, bytes: 0, partial: 0, releaseBytes: 100 }, settings: { serverId: "a" }, servers: [{ id: "a" }],
    accountSupported: true, account: { username: "x" }, gameRunning: false }, over);
}
const idle = { syncing: false, pausing: false, resume: false, notInstalled: false, accountNeeded: false };

test("PLAY shows Running, disabled, while the game runs", () => {
  assert.deepStrictEqual(ui.playView(st(), idle), { label: "Play", look: "", disabled: false });
  assert.deepStrictEqual(ui.playView(st({ gameRunning: true }), idle), { label: "Running", look: "secondary", disabled: true });
  assert.strictEqual(ui.playView(st({ gameRunning: true }), Object.assign({}, idle, { syncing: true })).label, "Pause", "a sync in progress still shows Pause");
});

console.log("all %d ui tests passed", passed);
