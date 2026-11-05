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

test("a refusal names what was refused: the game starting, a locked file at PLAY, AppData", () => {
  const err = (code, op) => Object.assign(new Error(code + ": operation not permitted"), { code, op });
  assert.match(friendly(err("EPERM", "launch")), /didn't let The Culling start/);
  assert.match(friendly(err("UNKNOWN", "launch")), /didn't let The Culling start/);
  assert.match(friendly(err("EBUSY", "play")), /locked, most likely because The Culling is still running/);
  assert.match(friendly(err("EPERM", "play")), /still running/);
  assert.match(friendly(err("EACCES", "appdata")), /launcher's own settings folder \(in AppData\)/);
  assert.match(friendly(err("EACCES")), /refused access to the game folder/, "anything else on disk is the game folder");
  for (const op of ["launch", "play", "appdata", "setup"]) assert.doesNotMatch(friendly(err("EPERM", op)), /the game folder\./, op);
});

test("a game folder that is gone says to reconnect the drive or choose it", () => {
  const ctx = { gamePath: "E:\\Games\\The Culling Remaster", gameFolderMissing: true };
  const enoent = Object.assign(new Error("ENOENT: no such file or directory, mkdir 'E:\\Games'"), { code: "ENOENT" });
  assert.strictEqual(friendly(enoent, ctx), "Your game folder E:\\Games\\The Culling Remaster can't be found: reconnect the drive or choose the folder in Settings");
  assert.strictEqual(friendly(Object.assign(new Error("EPERM"), { code: "EPERM" }), ctx), friendly(enoent, ctx));
  assert.match(friendly(new Error("fetch failed"), ctx), /^Can't reach the update server/, "a network problem stays one");
  assert.strictEqual(friendly(enoent, { gamePath: "C:\\x", gameFolderMissing: false }), enoent.message, "a missing file in a folder that is there passes through");
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
