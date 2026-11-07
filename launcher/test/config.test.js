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

  test("a settings file with a byte-order mark keeps its settings", () => {
    const bom = path.join(tmp, "bom.json");
    fs.writeFileSync(bom, "\uFEFF" + JSON.stringify({ gamePath: "D:\\Games\\TheCulling", playIntro: false }));
    const s = config.load(bom);
    assert.strictEqual(s.gamePath, "D:\\Games\\TheCulling");
    assert.strictEqual(s.playIntro, false);
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
    assert.deepStrictEqual(config.sanitize({ servers: [] }).servers, config.DEFAULTS.servers, "an empty list leaves nothing to play on");
    assert.deepStrictEqual(config.sanitize({ servers: [{ id: "x", name: "X", api: "not a url" }] }).servers, config.DEFAULTS.servers);
    assert.deepStrictEqual(config.sanitize({ servers: [{ id: "x", name: "X", api: "http://evil.example/api" }] }).servers, config.DEFAULTS.servers);
    assert.deepStrictEqual(config.sanitize({ servers: [null] }).servers, config.DEFAULTS.servers);
    const mine = [{ id: "local", name: "Local", api: "http://127.0.0.1:8000/api" }, { id: "eu", name: "EU", api: "https://eu.example/api", status: "https://eu.example/health" }];
    assert.deepStrictEqual(config.sanitize({ servers: mine }).servers, mine, "valid lists are kept");
  });

  test("a manifest address that isn't an https URL falls back to the default", () => {
    for (const bad of ["", "manifest.json", "ftp://x/m.json", "http://xplab.shop/m.json", 42, null, "https://"]) {
      assert.strictEqual(config.sanitize({ manifestUrl: bad }).manifestUrl, config.DEFAULTS.manifestUrl, String(bad));
    }
    assert.strictEqual(config.sanitize({ manifestUrl: "https://example.com/r/manifest.json" }).manifestUrl, "https://example.com/r/manifest.json");
    assert.strictEqual(config.sanitize({ manifestUrl: "http://localhost:8080/manifest.json" }).manifestUrl, "http://localhost:8080/manifest.json");
  });

  test("the installed launcher refuses plain http to this PC; a dev run allows it", () => {
    const localhttp = require("../lib/localhttp");
    const sync = require("../lib/sync");
    const clientdll = require("../lib/clientdll");
    const local = ["http://localhost:8080/m.json", "http://127.0.0.1:8000/api"];
    assert.strictEqual(localhttp.allowed(), true, "a dev run (and these tests) by default");
    localhttp.allow(false);                                // what main.js does when app.isPackaged
    try {
      for (const u of local) {
        assert.strictEqual(config.validUrl(u), false, u);
        assert.throws(() => sync.checkUrl(u), /non-https/, u);
        assert.throws(() => clientdll.ensure(tmp, u), /https/, u);
      }
      assert.strictEqual(config.sanitize({ manifestUrl: local[0] }).manifestUrl, config.DEFAULTS.manifestUrl);
      assert.deepStrictEqual(config.sanitize({ servers: [{ id: "l", name: "L", api: local[1] }] }).servers, config.DEFAULTS.servers);
      assert.throws(() => sync.validateManifest({ version: "1", files: [], servers: [{ id: "l", name: "L", api: local[1] }] }), /non-https/);
      assert.strictEqual(config.validUrl("https://localhost:8443/api"), true, "https is fine anywhere");
    } finally {
      localhttp.allow(true);
    }
    for (const u of local) { assert.strictEqual(config.validUrl(u), true, u); sync.checkUrl(u); }
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
