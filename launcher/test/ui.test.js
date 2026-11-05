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

console.log("all %d ui tests passed", passed);
