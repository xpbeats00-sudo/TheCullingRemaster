// Finding the game through Steam's files, and pointing the player's own Func
// client at the Remaster server.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const game = require("../lib/game");
const clientdll = require("../lib/clientdll");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-game-"));
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

function fakeGame(root) {
  const win64 = path.join(root, "Victory", "Binaries", "Win64");
  fs.mkdirSync(win64, { recursive: true });
  fs.writeFileSync(path.join(win64, "Victory.exe"), "");
  return win64;
}

try {
  test("finds The Culling in a second Steam library through its app manifest", () => {
    const steam = path.join(tmp, "Steam");
    const lib2 = path.join(tmp, "Games", "SteamLibrary");
    fs.mkdirSync(path.join(steam, "steamapps"), { recursive: true });
    fs.mkdirSync(path.join(lib2, "steamapps"), { recursive: true });
    fs.writeFileSync(path.join(steam, "steamapps", "libraryfolders.vdf"),
      `"libraryfolders"\n{\n\t"0"\n\t{\n\t\t"path"\t\t"${steam.replace(/\\/g, "\\\\")}"\n\t}\n\t"1"\n\t{\n\t\t"path"\t\t"${lib2.replace(/\\/g, "\\\\")}"\n\t}\n}\n`);
    fs.writeFileSync(path.join(lib2, "steamapps", "appmanifest_437220.acf"),
      `"AppState"\n{\n\t"appid"\t\t"437220"\n\t"installdir"\t\t"Culling Custom Dir"\n}\n`);
    fakeGame(path.join(lib2, "steamapps", "common", "Culling Custom Dir"));
    const libs = game.steamLibraries([steam, steam + path.sep]);
    assert.strictEqual(libs.length, 2, "duplicates dropped: " + libs);
    assert.strictEqual(game.detect(libs), path.join(lib2, "steamapps", "common", "Culling Custom Dir"));
  });

  test("nothing found when no library has the game", () => {
    assert.strictEqual(game.detect([path.join(tmp, "nowhere")]), null);
  });

  test("the client DLL is pointed at the server once, from the player's own Func DLL", () => {
    const win64 = fakeGame(path.join(tmp, "TheCulling"));
    const original = Buffer.concat([Buffer.from("MZ...head..."), Buffer.from(clientdll.ORIGINAL, "utf16le"), Buffer.from("...tail")]);
    fs.writeFileSync(path.join(win64, clientdll.SOURCE), original);
    assert.strictEqual(clientdll.ensure(win64, "https://xplab.shop:8443/api"), "written");
    const out = fs.readFileSync(path.join(win64, clientdll.TARGET));
    assert.strictEqual(out.length, original.length);
    assert.ok(out.includes(Buffer.from("https://xplab.shop:8443/api", "utf16le")));
    assert.ok(!out.includes(Buffer.from(clientdll.ORIGINAL, "utf16le")));
    assert.ok(fs.readFileSync(path.join(win64, clientdll.SOURCE)).equals(original), "Func's own DLL untouched");
    assert.strictEqual(clientdll.ensure(win64, "https://xplab.shop:8443/api"), "unchanged");
    assert.strictEqual(clientdll.ensure(win64, "http://127.0.0.1:8000/api"), "written", "switching servers rewrites it");
  });

  test("the client DLL refuses long or plain-http addresses and missing Func", () => {
    const win64 = path.join(tmp, "TheCulling", "Victory", "Binaries", "Win64");
    assert.throws(() => clientdll.ensure(win64, "https://a-much-longer-domain.example/api"), /too long/);
    assert.throws(() => clientdll.ensure(win64, "http://xplab.shop/api"), /https/);
    assert.throws(() => clientdll.ensure(fakeGame(path.join(tmp, "NoFunc")), "https://xplab.shop:8443/api"), /Func mod/);
  });

  test("a missing or empty folder, or a partial install, is ready to install into", () => {
    assert.deepStrictEqual(game.check(path.join(tmp, "nothing-here")).installable, true);
    const empty = path.join(tmp, "Empty");
    fs.mkdirSync(empty);
    assert.strictEqual(game.check(empty).installable, true);
    const partial = path.join(tmp, "Partial");
    fs.mkdirSync(path.join(partial, ".remaster"), { recursive: true });
    fs.mkdirSync(path.join(partial, "Engine"));
    assert.strictEqual(game.check(partial).installable, true, "Game Sync's own unfinished install");
    const other = path.join(tmp, "MyStuff");
    fs.mkdirSync(other);
    fs.writeFileSync(path.join(other, "notes.txt"), "mine");
    assert.deepStrictEqual([game.check(other).ok, game.check(other).installable], [false, false]);
    assert.strictEqual(game.check(path.join(tmp, "TheCulling")).ok, true);
  });

  test("a picked folder: the game or an empty folder as is, else a subfolder inside it", () => {
    assert.strictEqual(game.installTarget(path.join(tmp, "TheCulling")), path.join(tmp, "TheCulling"));
    assert.strictEqual(game.installTarget(path.join(tmp, "Empty")), path.join(tmp, "Empty"));
    assert.strictEqual(game.installTarget(path.join(tmp, "MyStuff")), path.join(tmp, "MyStuff", game.INSTALL_NAME));
    assert.ok(game.defaultInstallDir().endsWith(path.join("Programs", game.INSTALL_NAME)));
  });

  console.log("all %d game tests passed", passed);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
