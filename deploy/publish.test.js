// Fast publishing: the plan (what changes, what uploads), the launcher setup
// staged once and copied to the website on the VPS, the after-publish check
// over HTTP, and the build's hash cache.
"use strict";
const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { stage, plan, publishSetup } = require("./stage_objects");
const { check } = require("./check_published");
const { hashCache } = require("../launcher/tools/make_manifest");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const t = fs.mkdtempSync(path.join(os.tmpdir(), "publish-"));
const pub = path.join(t, "publish"), upd = path.join(t, "updates"), www = path.join(t, "www", "download");
const pair = crypto.generateKeyPairSync("ed25519");
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const quiet = () => {};
const ALLOW = { allowRemovals: true };

// A release folder like make_manifest.js writes: objects, signed manifest.
function release(version, files, setup) {
  fs.rmSync(pub, { recursive: true, force: true });
  fs.mkdirSync(path.join(pub, "objects"), { recursive: true });
  const put = (b) => { fs.writeFileSync(path.join(pub, "objects", sha(b)), b); return sha(b); };
  const m = { version, files: Object.entries(files).map(([p, b]) => ({ path: p, size: b.length, sha256: put(b), url: "objects/" + sha(b) })) };
  if (setup) m.launcher = { version: setup.version, size: setup.data.length, sha256: put(setup.data), url: "objects/" + sha(setup.data) };
  const body = Buffer.from(JSON.stringify(m));
  fs.writeFileSync(path.join(pub, "manifest.json"), body);
  fs.writeFileSync(path.join(pub, "manifest.json.sig"), crypto.sign(null, body, pair.privateKey).toString("base64"));
  return m;
}
// What "Go live" does.
function goLive() {
  fs.copyFileSync(path.join(pub, "manifest.json"), path.join(upd, "manifest.json"));
  fs.copyFileSync(path.join(pub, "manifest.json.sig"), path.join(upd, "manifest.json.sig"));
}
// Caddy stand-in: /remaster/* from updates, /download/* from www.
function serve() {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url);
    const file = u.startsWith("/remaster/") ? path.join(upd, u.slice(10)) : u.startsWith("/download/") ? path.join(www, u.slice(10)) : null;
    if (!file || !fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "Content-Length": fs.statSync(file).size });
    if (req.method === "HEAD") return res.end();
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}

(async () => {
  const PAK1 = Buffer.from("patch pak v1"), PAK2 = Buffer.from("patch pak v2 (lobby)"), GAME = Buffer.from("game file, unchanged");
  const SETUP = { version: "1.3.1", data: Buffer.from("launcher setup 1.3.1") };
  const { srv, base } = await serve();
  try {
    await test("the plan names what changes and what will upload, before anything moves", async () => {
      release("1.1.0", { "Game.bin": GAME, "Patch.pak": PAK1, "Old.txt": Buffer.from("old") });
      await stage(pub, upd, quiet);
      goLive();
      release("1.3.1", { "Game.bin": GAME, "Patch.pak": PAK2, "New.txt": Buffer.from("new") }, SETUP);
      const lines = [];
      // Old.txt is dropped: refused unless removals are allowed (launchers delete what a release drops).
      assert.throws(() => plan(pub, upd, quiet), /removes 1 of the 3 files.*Old\.txt.*--allow-removals/);
      await assert.rejects(stage(pub, upd, quiet), /removes 1 of the 3 files/);
      assert.ok(!fs.existsSync(path.join(upd, "objects", sha(PAK2))), "a refused release stages nothing");
      const p = plan(pub, upd, (l) => lines.push(l), ALLOW);
      assert.deepStrictEqual(p.changed.map((f) => f.path), ["Patch.pak"]);
      assert.deepStrictEqual(p.added.map((f) => f.path), ["New.txt"]);
      assert.deepStrictEqual(p.removed.map((f) => f.path), ["Old.txt"]);
      assert.strictEqual(p.uploadCount, 3, "pak, new file and the setup; the game file is already there");
      assert.strictEqual(p.uploadBytes, PAK2.length + 3 + SETUP.data.length);
      assert.ok(lines.some((l) => /launcher none -> 1\.3\.1/.test(l)));
    });

    await test("the launcher setup is staged as an object, like the game files", async () => {
      const n = await stage(pub, upd, quiet, ALLOW);
      assert.strictEqual(n.uploaded, 3);
      assert.ok(fs.readFileSync(path.join(upd, "objects", sha(SETUP.data))).equals(SETUP.data));
      assert.strictEqual((await stage(pub, upd, quiet, ALLOW)).uploaded, 0, "publishing again uploads nothing");
    });

    await test("the website's setup and launcher.json come from the staged object", async () => {
      const info = await publishSetup(pub, upd, www, quiet);
      assert.ok(fs.readFileSync(path.join(www, "TheCullingRemasterSetup.exe")).equals(SETUP.data));
      const json = JSON.parse(fs.readFileSync(path.join(www, "launcher.json"), "utf8"));
      assert.deepStrictEqual([json.version, json.size, json.sha256], ["1.3.1", SETUP.data.length, sha(SETUP.data)]);
      assert.strictEqual(info.url, "/download/TheCullingRemasterSetup.exe");
      fs.rmSync(path.join(upd, "objects", sha(SETUP.data)));
      await assert.rejects(publishSetup(pub, upd, www, quiet), /isn't staged/);
      await stage(pub, upd, quiet, ALLOW);
    });

    const prev = path.join(t, "previous.json");
    fs.copyFileSync(path.join(upd, "manifest.json"), prev);
    goLive();
    const opts = (more) => Object.assign({ base: base + "/remaster/", expect: path.join(pub, "manifest.json"), changedFrom: prev,
      website: base, updates: null, sweep: true, all: false, key: pair.publicKey }, more);

    await test("after publishing, the check passes: signature, objects, changed files, website", async () => {
      const lines = [];
      const problems = await check(opts(), (l) => lines.push(l));
      assert.deepStrictEqual(problems, []);
      assert.ok(lines.some((l) => /4\/4 objects served/.test(l)), lines.join("\n"));
      assert.ok(lines.some((l) => /3 changed object\(s\) downloaded/.test(l)), "pak, new file, setup: " + lines.join("\n"));
      const onDisk = await check(opts({ updates: upd, sweep: false }), quiet);
      assert.deepStrictEqual(onDisk, [], "the VPS's on-disk object check agrees");
    });

    // SERVER_AUDIT_2 D2: the publish ends by checking the version launchers are told.
    await test("--version: the live manifest's version must be the one published", async () => {
      const live = JSON.parse(fs.readFileSync(path.join(upd, "manifest.json"), "utf8")).version;
      assert.deepStrictEqual(await check(opts({ version: live }), quiet), []);
      const stale = await check(opts({ version: "9.9.9" }), quiet);
      assert.ok(stale.some((p) => p === `the live manifest says version ${live}, not 9.9.9`), stale.join("; "));
    });

    await test("the check catches a missing object, a corrupted changed file, a wrong website setup, a bad signature", async () => {
      const pakObj = path.join(upd, "objects", sha(PAK2));
      fs.writeFileSync(pakObj, Buffer.from("patch pak v2 (lobbX)"));          // same size, wrong bytes
      fs.renameSync(path.join(upd, "objects", sha(GAME)), path.join(t, "moved"));
      fs.writeFileSync(path.join(www, "TheCullingRemasterSetup.exe"), "an older setup");
      const problems = await check(opts(), quiet);
      assert.ok(problems.some((p) => /Game\.bin/.test(p)), "missing object");
      assert.ok(problems.some((p) => /Patch\.pak: downloaded content doesn't match/.test(p)), "corrupted file");
      assert.ok(problems.some((p) => /website's setup isn't the launcher/.test(p)), "website setup");
      const other = crypto.generateKeyPairSync("ed25519");
      const bad = await check(opts({ key: other.publicKey }), quiet);
      assert.ok(bad.some((p) => /signature doesn't verify/.test(p)));
    });

    await test("the build's hash cache re-hashes only files that changed", async () => {
      const f = path.join(t, "big.bin"), cacheFile = path.join(t, "hashcache.json");
      fs.writeFileSync(f, "version one");
      let c = hashCache(cacheFile);
      assert.strictEqual(await c.sha256(f), sha(Buffer.from("version one")));
      c.save();
      c = hashCache(cacheFile);
      assert.strictEqual(await c.sha256(f), sha(Buffer.from("version one")));
      assert.deepStrictEqual(c.stats, { hits: 1, hashed: 0 }, "unchanged: from the cache");
      c.save();
      await new Promise((r) => setTimeout(r, 20));
      fs.writeFileSync(f, "version two!");
      c = hashCache(cacheFile);
      assert.strictEqual(await c.sha256(f), sha(Buffer.from("version two!")), "changed: hashed again");
      assert.deepStrictEqual(c.stats, { hits: 0, hashed: 1 });
    });

    console.log("all %d publish tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    srv.close();
    fs.rmSync(t, { recursive: true, force: true });
  }
})();
