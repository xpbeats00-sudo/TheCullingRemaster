// Settings round-trip and rejection of bad values; game-folder checks.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("../lib/config");
const game = require("../lib/game");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-config-"));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

try {
  const file = path.join(tmp, "settings.json");

  test("first run gives the defaults", () => {
    assert.deepStrictEqual(config.load(file), config.DEFAULTS);
  });

  test("settings round-trip and unknown or mistyped keys are dropped", () => {
    const saved = config.save(file, { gamePath: "D:\\Games\\TheCulling", closeOnLaunch: true, playIntro: "yes", evil: 1 });
    assert.strictEqual(saved.gamePath, "D:\\Games\\TheCulling");
    assert.strictEqual(saved.closeOnLaunch, true);
    assert.strictEqual(saved.playIntro, true, "mistyped value falls back to the default");
    assert.ok(!("evil" in saved));
    assert.deepStrictEqual(config.load(file), saved);
  });

  test("a corrupt settings file falls back to the defaults", () => {
    fs.writeFileSync(file, "{not json");
    assert.deepStrictEqual(config.load(file), config.DEFAULTS);
  });

  test("bad server lists fall back to the defaults", () => {
    assert.deepStrictEqual(config.sanitize({ servers: [{ id: 1 }] }).servers, config.DEFAULTS.servers);
  });

  test("game folder check finds Victory.exe, Func launcher and the client DLL", () => {
    const root = path.join(tmp, "TheCulling");
    const win64 = path.join(root, "Victory", "Binaries", "Win64");
    assert.strictEqual(game.check(root).ok, false);
    fs.mkdirSync(win64, { recursive: true });
    fs.writeFileSync(path.join(win64, "Victory.exe"), "");
    assert.deepStrictEqual(game.check(root), { ok: true, funcLauncher: false, clientDll: false });
    fs.writeFileSync(path.join(win64, "Func.Launcher.exe"), "");
    fs.writeFileSync(path.join(win64, "Func.Client.Local.dll"), "");
    assert.deepStrictEqual(game.check(root), { ok: true, funcLauncher: true, clientDll: true });
    assert.strictEqual(game.check("").ok, false);
  });

  console.log("all %d config tests passed", passed);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
