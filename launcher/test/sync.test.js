// Game Sync against releases served over HTTP: install, no-op re-check, repair
// of a tampered file, rejection of corrupt downloads and of unsafe manifests,
// a whole-game install into a new folder, resuming a dropped download, and
// the disk-space check.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const sync = require("../lib/sync");
const { main: makeManifest } = require("../tools/make_manifest");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-sync-"));
const release = path.join(tmp, "release");
const publish = path.join(tmp, "publish");
const game = path.join(tmp, "game");
let served = {};          // url path -> override body (to serve corrupt data)
let routes = {};          // url path -> handler(req, res), for the resume tests

function put(rel, data) {
  const f = path.join(release, ...rel.split("/"));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
}

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  if (routes[p]) { routes[p](req, res); return; }
  if (served[p]) { res.end(served[p]); return; }
  const f = path.join(publish, ...p.split("/").filter(Boolean));
  if (!f.startsWith(publish) || !fs.existsSync(f)) { res.statusCode = 404; res.end(); return; }
  fs.createReadStream(f).pipe(res);
});

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  put("Victory/Content/Paks/LocalServer-WindowsClient_P.pak", Buffer.alloc(300000, 7));
  put("Victory/Binaries/Win64/Func.Client.Local.dll", "dll v1");
  fs.mkdirSync(game, { recursive: true });
  const silent = console.log; console.log = () => {};
  await makeManifest(release, "1.0.0", publish);
  console.log = silent;

  try {
    await test("fresh install downloads every file and verifies it", async () => {
      const m = await sync.fetchManifest(base + "/manifest.json");
      const todo = await sync.plan(m, game);
      assert.strictEqual(todo.length, 2);
      let last = null;
      const r = await sync.apply(m, todo, game, (p) => { last = p; });
      assert.strictEqual(r.files, 2);
      assert.strictEqual(last.doneBytes, last.totalBytes);
      assert.strictEqual(fs.readFileSync(path.join(game, "Victory/Binaries/Win64/Func.Client.Local.dll"), "utf8"), "dll v1");
      assert.strictEqual(sync.installedVersion(game), "1.0.0");
    });

    await test("an up-to-date install needs nothing", async () => {
      const m = await sync.fetchManifest(base + "/manifest.json");
      assert.deepStrictEqual(await sync.plan(m, game), []);
    });

    await test("a tampered file of the same size is detected and repaired", async () => {
      const f = path.join(game, "Victory/Binaries/Win64/Func.Client.Local.dll");
      fs.writeFileSync(f, "dll XX");
      const m = await sync.fetchManifest(base + "/manifest.json");
      const todo = await sync.plan(m, game);
      assert.deepStrictEqual(todo.map((x) => x.path), ["Victory/Binaries/Win64/Func.Client.Local.dll"]);
      await sync.apply(m, todo, game);
      assert.strictEqual(fs.readFileSync(f, "utf8"), "dll v1");
    });

    await test("a new release replaces only what changed", async () => {
      put("Victory/Binaries/Win64/Func.Client.Local.dll", "dll v2!");
      console.log = () => {};
      await makeManifest(release, "1.0.1", publish);
      console.log = silent;
      const m = await sync.fetchManifest(base + "/manifest.json");
      const todo = await sync.plan(m, game);
      assert.deepStrictEqual(todo.map((x) => x.path), ["Victory/Binaries/Win64/Func.Client.Local.dll"]);
      await sync.apply(m, todo, game);
      assert.strictEqual(sync.installedVersion(game), "1.0.1");
    });

    await test("a corrupt download is rejected and leaves the old file", async () => {
      const f = path.join(game, "Victory/Binaries/Win64/Func.Client.Local.dll");
      fs.writeFileSync(f, "old");
      served["/files/Victory/Binaries/Win64/Func.Client.Local.dll"] = "evil!!!";
      const m = await sync.fetchManifest(base + "/manifest.json");
      const todo = await sync.plan(m, game);
      await assert.rejects(sync.apply(m, todo, game), /failed verification/);
      assert.strictEqual(fs.readFileSync(f, "utf8"), "old");
      assert.ok(!fs.existsSync(f + ".part"), "partial download cleaned up");
      served = {};
    });

    await test("manifests stay inside the game folder, out of Game Sync's state, and use https", async () => {
      for (const bad of ["../evil.dll", "Victory/../../evil.dll", "/abs/evil", "C:/evil", "Victory\\..\\x", "a:b",
                         ".remaster/sync-state.json", "Victory/CON", "Victory/nul.txt", "Victory/x?y", "Victory//x"]) {
        assert.throws(() => sync.targetPath(game, bad), sync.SyncError, bad);
      }
      for (const good of ["Engine/Binaries/ThirdParty/x.dll", "Launch.exe", "Victory/Content/Paks/pakchunk0-WindowsClient.pak"]) {
        assert.ok(sync.targetPath(game, good).startsWith(game + path.sep), good);
      }
      assert.throws(() => sync.checkUrl("http://xplab.shop/manifest.json"), sync.SyncError);
      assert.ok(sync.checkUrl("https://xplab.shop/remaster/manifest.json"));
      const m = await sync.fetchManifest(base + "/manifest.json");
      m.files[0] = Object.assign({}, m.files[0], { path: "Victory/../../../evil.pak" });
      await assert.rejects(sync.plan(m, game), sync.SyncError);
    });

    await test("a whole-game release installs into a folder that doesn't exist yet", async () => {
      const rel2 = path.join(tmp, "full-release"), pub2 = path.join(publish, "full");
      const files = { "Engine/Binaries/ThirdParty/PhysX.dll": "physx", "Victory/Binaries/Win64/Victory.exe": "MZgame",
                      "Victory/Content/Paks/pakchunk0-WindowsClient.pak": Buffer.alloc(200000, 3),
                      "Launch.exe": "MZlaunch", "buildversion.txt": "119207" };
      for (const [rel, data] of Object.entries(files)) {
        const f = path.join(rel2, ...rel.split("/"));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, data);
      }
      console.log = () => {};
      await makeManifest(rel2, "2.0.0", pub2);
      console.log = silent;
      const target = path.join(tmp, "fresh", "The Culling Remaster");
      const m = await sync.fetchManifest(base + "/full/manifest.json");
      const todo = await sync.plan(m, target);
      assert.strictEqual(todo.length, 5);
      assert.ok(!fs.existsSync(target), "planning doesn't create the folder");
      await sync.apply(m, todo, target);
      for (const [rel, data] of Object.entries(files)) {
        assert.ok(fs.readFileSync(path.join(target, ...rel.split("/"))).equals(Buffer.from(data)), rel);
      }
      assert.strictEqual(sync.installedVersion(target), "2.0.0");
      assert.deepStrictEqual(await sync.plan(m, target), []);
    });

    await test("a dropped download resumes from where it stopped", async () => {
      const big = Buffer.alloc(1 << 20);
      for (let i = 0; i < big.length; i++) big[i] = (i * 31) & 255;
      const sha = require("crypto").createHash("sha256").update(big).digest("hex");
      const ranges = [];
      let calls = 0;
      routes["/resume/manifest.json"] = (req, res) => res.end(JSON.stringify({ version: "3", files: [
        { path: "Victory/Content/Paks/big.pak", size: big.length, sha256: sha, url: "big.pak" }] }));
      routes["/resume/big.pak"] = (req, res) => {
        calls++;
        const range = req.headers.range;
        if (!range) {                              // first try: send 40%, then drop the connection
          res.writeHead(200, { "Content-Length": big.length });
          res.write(big.subarray(0, 400000), () => setTimeout(() => res.destroy(), 50));
          return;
        }
        ranges.push(range);
        const from = Number(/bytes=(\d+)-/.exec(range)[1]);
        res.writeHead(206, { "Content-Range": `bytes ${from}-${big.length - 1}/${big.length}`, "Content-Length": big.length - from });
        res.end(big.subarray(from));
      };
      const target = path.join(tmp, "resume-game");
      const m = await sync.fetchManifest(base + "/resume/manifest.json");
      let last = null;
      await sync.apply(m, await sync.plan(m, target), target, (p) => { last = p; }, { retryDelayMs: 10 });
      assert.ok(fs.readFileSync(path.join(target, "Victory/Content/Paks/big.pak")).equals(big));
      assert.strictEqual(calls, 2, "one dropped request, one resumed request");
      assert.ok(/^bytes=[1-9]\d*-$/.test(ranges[0]), "resumed with a Range from the bytes it had: " + ranges[0]);
      assert.strictEqual(last.doneBytes, big.length, "progress counts each byte once");
    });

    await test("a server without ranges restarts the file instead of corrupting it", async () => {
      const data = Buffer.alloc(300000, 9);
      const sha = require("crypto").createHash("sha256").update(data).digest("hex");
      routes["/norange/manifest.json"] = (req, res) => res.end(JSON.stringify({ version: "1", files: [
        { path: "Victory/x.bin", size: data.length, sha256: sha, url: "x.bin" }] }));
      routes["/norange/x.bin"] = (req, res) => res.end(data);       // ignores Range: always the whole file
      const target = path.join(tmp, "norange-game");
      fs.mkdirSync(path.join(target, "Victory"), { recursive: true });
      fs.writeFileSync(path.join(target, "Victory", "x.bin.part"), Buffer.alloc(1000, 1));   // stale partial
      const m = await sync.fetchManifest(base + "/norange/manifest.json");
      let last = null;
      await sync.apply(m, await sync.plan(m, target), target, (p) => { last = p; }, { retryDelayMs: 10 });
      assert.ok(fs.readFileSync(path.join(target, "Victory/x.bin")).equals(data));
      assert.strictEqual(last.doneBytes, data.length);
    });

    await test("not enough disk space stops before anything downloads", async () => {
      assert.throws(() => sync.checkSpace(game, Number.MAX_SAFE_INTEGER), /not enough disk space/);
      assert.ok(sync.freeBytes(path.join(tmp, "not", "made", "yet")) > 0, "free space of a folder that doesn't exist yet");
    });

    console.log("all %d sync tests passed", passed);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error("FAIL", e.message); process.exitCode = 1; server.close(); });
