// The player's in-game name: rules, and writing it where the game reads it.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const playername = require("../lib/playername");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-name-"));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

function install(root, withSettings) {
  const win64 = path.join(root, "Engine", "Binaries", "ThirdParty", "Steamworks", "Steamv136", "Win64");
  fs.mkdirSync(withSettings ? path.join(win64, "steam_settings") : win64, { recursive: true });
  return path.join(win64, "steam_settings", "force_account_name.txt");
}

try {
  test("names are trimmed, spaces collapsed, and checked", () => {
    assert.deepStrictEqual(playername.validate("  Xp   Beats "), { name: "Xp Beats" });
    assert.deepStrictEqual(playername.validate("[XP] Reaper_99"), { name: "[XP] Reaper_99" });
    assert.deepStrictEqual(playername.validate("Ñandú"), { name: "Ñandú" });
    assert.ok(playername.validate("").error);
    assert.ok(playername.validate("   ").error);
    assert.ok(playername.validate("x".repeat(33)).error, "over 32");
    assert.deepStrictEqual(playername.validate("x".repeat(32)), { name: "x".repeat(32) });
    for (const bad of ["a<b", "a/b", "a\\b", "emoji 😀", "a:b", "a\"b", "a%b"]) {
      assert.ok(playername.validate(bad).error, "refused: " + bad);
    }
    // Line breaks and tabs are whitespace: they become single spaces.
    assert.deepStrictEqual(playername.validate("line\nbreak\ttab"), { name: "line break tab" });
  });

  test("the name is written where the game reads it, and read back", () => {
    const root = path.join(tmp, "TheCulling");
    const file = install(root, true);
    assert.strictEqual(playername.supported(root), true);
    assert.strictEqual(playername.read(root), "");
    assert.strictEqual(playername.write(root, "  New  Name "), "New Name");
    assert.strictEqual(fs.readFileSync(file, "utf8"), "New Name");
    assert.strictEqual(playername.read(root), "New Name");
    fs.writeFileSync(file, "﻿With Bom");
    assert.strictEqual(playername.read(root), "With Bom");
  });

  test("a bad name changes nothing", () => {
    const root = path.join(tmp, "TheCulling");
    assert.throws(() => playername.write(root, "bad<name"), /letters/);
    assert.strictEqual(playername.read(root), "With Bom");
  });

  test("a real Steam install (no settings folder) keeps its Steam name", () => {
    const root = path.join(tmp, "SteamCopy");
    install(root, false);
    assert.strictEqual(playername.supported(root), false);
    assert.throws(() => playername.write(root, "Someone"), /Steam name/);
    assert.strictEqual(playername.supported(""), false);
  });

  console.log("all %d player name tests passed", passed);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
