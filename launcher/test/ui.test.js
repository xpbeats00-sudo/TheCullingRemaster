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

console.log("all %d ui tests passed", passed);
