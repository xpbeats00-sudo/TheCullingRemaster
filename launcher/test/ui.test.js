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

const B = (n) => n + " B";
const sIdle = { syncing: false, pausing: false, resume: null, notInstalled: false, bytes: B };

test("the status line: a vanished game folder says so", () => {
  assert.deepStrictEqual(ui.statusView(st(), sIdle), { title: "Game Up to Date", sub: "Version 1.0.0", look: "" });
  const gone = st({ installed: null, game: { ok: false, installable: false, missing: true, reason: "gone" } });
  assert.deepStrictEqual(ui.statusView(gone, sIdle), { title: "Game folder not found", sub: "Reconnect the drive or choose it in Settings", look: "bad" });
  assert.strictEqual(ui.playView(gone, idle).label, "Set game folder");
  const fresh = st({ installed: null, game: { ok: false, installable: true } });
  assert.strictEqual(ui.statusView(fresh, Object.assign({}, sIdle, { notInstalled: true })).title, "Ready to install");
});

test("local changes at the current release: 'Repair needed', and PLAY offers Repair or Play anyway", () => {
  const drift = st({ drift: true, pending: { files: 3, bytes: 900, partial: 0, releaseBytes: 100 } });
  assert.deepStrictEqual(ui.statusView(drift, sIdle), { title: "Repair needed", sub: "3 files changed", look: "warn" });
  assert.deepStrictEqual(ui.playView(drift, idle), { label: "Play", look: "", disabled: false }, "not 'Update'");
  assert.strictEqual(ui.playAction(drift, idle), "choose", "no forced sync");
  const update = st({ release: "1.1.0", pending: { files: 3, bytes: 900, partial: 0, releaseBytes: 100 } });
  assert.strictEqual(ui.statusView(update, sIdle).title, "Update available");
  assert.strictEqual(ui.playView(update, idle).label, "Update");
  assert.strictEqual(ui.playAction(update, idle), "sync", "a new release is still installed first");
  assert.strictEqual(ui.playAction(st(), idle), "launch");
  assert.strictEqual(ui.playAction(st(), Object.assign({}, idle, { accountNeeded: true })), "signin");
  assert.strictEqual(ui.playAction(st({ gameRunning: true }), idle), "none");
});

test("a restored previous version: a newer release is offered, PLAY still plays it", () => {
  const held = st({ held: true, release: "1.1.0", pending: { files: 3, bytes: 900, partial: 0, releaseBytes: 100 } });
  assert.strictEqual(ui.statusView(held, sIdle).title, "Update available");
  assert.strictEqual(ui.playView(held, idle).label, "Play", "not forced to Update");
  assert.strictEqual(ui.playAction(held, idle), "choose", "Update or Play this version");
});

test("the server line: online when busy, else this week's players, else today's matches, never invented", () => {
  assert.strictEqual(ui.activityView(null).text, "Checking");
  assert.strictEqual(ui.activityView({ ok: false }).text, "Unreachable");
  assert.strictEqual(ui.activityView({ ok: true, ms: 30, users: 12, matchesToday: 300, playersWeek: 90 }).text, "12 online");
  const quiet = ui.activityView({ ok: true, ms: 30, users: 0, matchesToday: 128, playersWeek: 42 });
  assert.strictEqual(quiet.text, "42 played this week");
  assert.strictEqual(quiet.title, "0 online now · 128 matches in the last 24 hours · 42 players this week");
  assert.strictEqual(ui.activityView({ ok: true, ms: 30, users: 1, matchesToday: 3, playersWeek: 0 }).text, "3 matches today");
  assert.strictEqual(ui.activityView({ ok: true, ms: 30, users: 0, matchesToday: 0, playersWeek: 0 }).text, "0 online", "an empty server says so");
  assert.strictEqual(ui.activityView({ ok: true, ms: 30, users: 2, matchesToday: null, playersWeek: null }).text, "2 online", "an older server without activity");
  assert.strictEqual(ui.activityView({ ok: true, ms: 45, users: null }).text, "45 ms", "not our health route");
  assert.strictEqual(ui.activityView({ ok: true, ms: 30, users: 1500, matchesToday: 9000, playersWeek: 4000 }).text, "1,500 online");
});

console.log("all %d ui tests passed", passed);
