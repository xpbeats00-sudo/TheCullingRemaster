// Game Sync against a local release served over HTTP: fresh install, no-op
// re-check, repair of a tampered file, rejection of corrupt downloads and of
// manifests that try to write outside the game's Victory folder.
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

function put(rel, data) {
  const f = path.join(release, ...rel.split("/"));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, data);
}

const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
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

    await test("manifests can't write outside Victory/ or use plain http", async () => {
      for (const bad of ["../evil.dll", "Victory/../../evil.dll", "/abs/evil", "C:/evil", "Engine/x.dll", "Victory\\..\\x"]) {
        assert.throws(() => sync.targetPath(game, bad), sync.SyncError, bad);
      }
      assert.throws(() => sync.checkUrl("http://xplab.shop/manifest.json"), sync.SyncError);
      assert.ok(sync.checkUrl("https://xplab.shop/remaster/manifest.json"));
      const m = await sync.fetchManifest(base + "/manifest.json");
      m.files[0] = Object.assign({}, m.files[0], { path: "Victory/../../../evil.pak" });
      await assert.rejects(sync.plan(m, game), sync.SyncError);
    });

    console.log("all %d sync tests passed", passed);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error("FAIL", e.message); process.exitCode = 1; server.close(); });
