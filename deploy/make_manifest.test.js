// launcher/tools/make_manifest.js keeps published objects immutable: release
// files may be hard-linked into objects/, the launcher setup (launcher/dist,
// rebuilt in place) never is, and an object that no longer matches its name is
// replaced instead of reused. Throwaway folders and a generated test key only.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { main: makeManifest } = require("../launcher/tools/make_manifest");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const shaFile = (f) => sha(fs.readFileSync(f));
const ino = (f) => fs.statSync(f, { bigint: true }).ino;
const t = fs.mkdtempSync(path.join(os.tmpdir(), "manifest-"));
const release = path.join(t, "release"), pub = path.join(t, "publish"), dist = path.join(t, "dist");
const key = path.join(t, "test_release_ed25519.pem");
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

(async () => {
  const log = console.log;
  try {
    const pair = crypto.generateKeyPairSync("ed25519");
    fs.writeFileSync(key, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
    fs.mkdirSync(path.join(release, "Victory"), { recursive: true });
    fs.mkdirSync(dist);
    const GAME = Buffer.from("a game file"), PAK = Buffer.from("the patch pak");
    fs.writeFileSync(path.join(release, "Victory", "game.bin"), GAME);
    fs.writeFileSync(path.join(release, "Victory", "patch.pak"), PAK);
    // The launcher setup: any exe with a version resource (node itself here).
    const setup = path.join(dist, "TheCullingRemasterSetup.exe");
    fs.copyFileSync(process.execPath, setup);
    process.env.CULLING_HASH_CACHE = path.join(t, "hashcache.json");
    const build = async () => { console.log = () => {}; try { await makeManifest(release, "1.0.0", pub, key, "--setup", setup); } finally { console.log = log; } };
    const manifest = () => JSON.parse(fs.readFileSync(path.join(pub, "manifest.json"), "utf8"));

    await test("release files are hard-linked into objects/, the setup from launcher/dist is copied", async () => {
      await build();
      const m = manifest();
      const game = path.join(pub, "objects", sha(GAME));
      assert.strictEqual(ino(game), ino(path.join(release, "Victory", "game.bin")), "a release file is linked (no second copy)");
      const setupObj = path.join(pub, "objects", m.launcher.sha256);
      assert.notStrictEqual(ino(setupObj), ino(setup), "the setup object must not share the setup's disk file");
      assert.strictEqual(shaFile(setupObj), m.launcher.sha256);
      assert.ok(crypto.verify(null, fs.readFileSync(path.join(pub, "manifest.json")), pair.publicKey,
        Buffer.from(fs.readFileSync(path.join(pub, "manifest.json.sig"), "utf8"), "base64")), "signed with the given key");
    });

    await test("rebuilding the setup in place leaves its published object alone", async () => {
      const m = manifest();
      const setupObj = path.join(pub, "objects", m.launcher.sha256);
      const fd = fs.openSync(setup, "r+");                // what electron-builder does: same file, new bytes
      fs.writeSync(fd, Buffer.from("rebuilt!"), 0, 8, 4096);
      fs.closeSync(fd);
      assert.strictEqual(shaFile(setupObj), m.launcher.sha256, "the object still matches its name");
    });

    await test("an object that no longer matches its name (the old hard-link damage) is replaced, not reused", async () => {
      // Recreate the incident: the setup's object hard-linked to the setup, then the setup rebuilt in place.
      const old = manifest().launcher.sha256;
      fs.writeFileSync(setup, fs.readFileSync(process.execPath));         // back to the original bytes
      const obj = path.join(pub, "objects", old);
      fs.rmSync(obj);
      fs.linkSync(setup, obj);
      const fd = fs.openSync(setup, "r+");
      fs.writeSync(fd, Buffer.from("rebuilt!"), 0, 8, 4096);
      fs.closeSync(fd);
      assert.notStrictEqual(shaFile(obj), old, "set-up: the object is now corrupt");
      fs.rmSync(setup);                                                   // the setup this release offers, a new file
      fs.writeFileSync(setup, fs.readFileSync(process.execPath));
      await new Promise((r) => setTimeout(r, 20));
      await build();
      assert.strictEqual(manifest().launcher.sha256, old);
      assert.strictEqual(shaFile(obj), old, "the corrupt object was replaced with the right bytes");
      assert.notStrictEqual(ino(obj), ino(setup), "and it is a copy");
      // A corrupt release-file object (same size, wrong bytes) is replaced too.
      const pakObj = path.join(pub, "objects", sha(PAK));
      fs.rmSync(pakObj);
      fs.writeFileSync(pakObj, Buffer.from("the patch paX"));
      await build();
      assert.strictEqual(shaFile(pakObj), sha(PAK));
      assert.ok(!fs.readdirSync(path.join(pub, "objects")).some((n) => n.endsWith(".tmp")), "no temporary files left");
    });

    console.log("all %d make_manifest object tests passed", passed);
  } catch (e) {
    console.log = log;
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
})();
