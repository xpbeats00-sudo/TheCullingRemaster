// Player-facing error messages.
"use strict";

const assert = require("assert");
const { friendly } = require("../lib/errors");
const { SyncError } = require("../lib/sync");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

test("offline and unreachable servers read as a connection problem", () => {
  for (const m of ["fetch failed", "net::ERR_INTERNET_DISCONNECTED", "getaddrinfo ENOTFOUND xplab.shop", "The operation was aborted due to timeout"]) {
    assert.match(friendly(new Error(m)), /^Can't reach the update server/, m);
  }
});

test("a release that fails its signature check says nothing was installed", () => {
  assert.match(friendly(new SyncError("the release's signature doesn't match: refusing it", "signature")), /can't verify, so nothing was installed/);
});

test("disk and permission problems say what to do", () => {
  assert.match(friendly(Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" })), /drive is full/);
  assert.match(friendly(Object.assign(new Error("EACCES: permission denied, open 'C:\\Program Files\\x'"), { code: "EACCES" })), /refused access/);
});

test("a launcher update Windows blocked says so, not the game folder", () => {
  const m = friendly(Object.assign(new Error("spawn EPERM"), { code: "EPERM", op: "setup" }));
  assert.match(m, /didn't let the launcher update start/);
  assert.doesNotMatch(m, /game folder/);
});

test("a server error on the manifest asks to retry later", () => {
  assert.match(friendly(new SyncError("manifest.json request failed: HTTP 503", "http")), /having trouble right now \(HTTP 503\)/);
});

test("messages already written for players pass through", () => {
  const m = "a game file is in use (Victory.exe): close the game, then press Resume";
  assert.strictEqual(friendly(Object.assign(new SyncError(m, "commit"), { code: "EBUSY" })), m);
  assert.strictEqual(friendly(new Error("Choose your player name first")), "Choose your player name first");
});

console.log("all %d error message tests passed", passed);
