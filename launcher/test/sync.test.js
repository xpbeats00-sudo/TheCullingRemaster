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
const crypto = require("crypto");

// A throwaway signing key: releases in these tests are signed with it and the
// launcher side is told to trust it (the real key lives outside the repo).
const tmpKeyDir = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-key-"));
const TEST_KEY = path.join(tmpKeyDir, "test.pem");
const pair = crypto.generateKeyPairSync("ed25519");
fs.writeFileSync(TEST_KEY, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
const TEST_PUB = pair.publicKey.export({ type: "spki", format: "pem" });

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

// Serve a hand-made manifest and its signature (test key) at a route.
function signedManifest(route, manifest) {
  const body = Buffer.from(JSON.stringify(manifest));
  routes[route] = (req, res) => res.end(body);
  routes[route + ".sig"] = (req, res) => res.end(crypto.sign(null, body, pair.privateKey).toString("base64"));
}

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  put("Victory/Content/Paks/LocalServer-WindowsClient_P.pak", Buffer.alloc(300000, 7));
  put("Victory/Binaries/Win64/Func.Client.Local.dll", "dll v1");
  fs.mkdirSync(game, { recursive: true });
  const silent = console.log; console.log = () => {};
  await makeManifest(release, "1.0.0", publish, TEST_KEY);
  console.log = silent;

  try {
    await test("fresh install downloads every file and verifies it", async () => {
      const m = await sync.fetchManifest(base + "/manifest.json", TEST_PUB);
      const todo = await sync.plan(m, game);
      assert.strictEqual(todo.length, 2);
      let last = null;
      const r = await sync.apply(m, todo, game, (p) => { if (p.phase === "download") last = p; });
      assert.strictEqual(r.files, 2);
      assert.strictEqual(last.doneBytes, last.totalBytes);
      assert.strictEqual(fs.readFileSync(path.join(game, "Victory/Binaries/Win64/Func.Client.Local.dll"), "utf8"), "dll v1");
      assert.strictEqual(sync.installedVersion(game), "1.0.0");
    });

    await test("an up-to-date install needs nothing", async () => {
      const m = await sync.fetchManifest(base + "/manifest.json", TEST_PUB);
      assert.deepStrictEqual(await sync.plan(m, game), []);
    });

    await test("a tampered file of the same size is detected and repaired", async () => {
      const f = path.join(game, "Victory/Binaries/Win64/Func.Client.Local.dll");
      fs.writeFileSync(f, "dll XX");
      const m = await sync.fetchManifest(base + "/manifest.json", TEST_PUB);
      const todo = await sync.plan(m, game);
      assert.deepStrictEqual(todo.map((x) => x.path), ["Victory/Binaries/Win64/Func.Client.Local.dll"]);
      await sync.apply(m, todo, game);
      assert.strictEqual(fs.readFileSync(f, "utf8"), "dll v1");
    });

    await test("a new release replaces only what changed", async () => {
      put("Victory/Binaries/Win64/Func.Client.Local.dll", "dll v2!");
      console.log = () => {};
      await makeManifest(release, "1.0.1", publish, TEST_KEY);
      console.log = silent;
      const m = await sync.fetchManifest(base + "/manifest.json", TEST_PUB);
      const todo = await sync.plan(m, game);
      assert.deepStrictEqual(todo.map((x) => x.path), ["Victory/Binaries/Win64/Func.Client.Local.dll"]);
      await sync.apply(m, todo, game);
      assert.strictEqual(sync.installedVersion(game), "1.0.1");
    });

    await test("a corrupt download is rejected and leaves the old file", async () => {
      const f = path.join(game, "Victory/Binaries/Win64/Func.Client.Local.dll");
      fs.writeFileSync(f, "old");
      const m = await sync.fetchManifest(base + "/manifest.json", TEST_PUB);
      served["/" + m.files.find((x) => x.path === "Victory/Binaries/Win64/Func.Client.Local.dll").url] = "evil!!!";
      const todo = await sync.plan(m, game);
      await assert.rejects(sync.apply(m, todo, game, () => {}, { retryDelayMs: 5 }), /failed verification/);
      assert.strictEqual(fs.readFileSync(f, "utf8"), "old");
      assert.ok(!fs.existsSync(path.join(game, ".remaster/staging/Victory/Binaries/Win64/Func.Client.Local.dll.part")), "partial download cleaned up");
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
      const m = await sync.fetchManifest(base + "/manifest.json", TEST_PUB);
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
      await makeManifest(rel2, "2.0.0", pub2, TEST_KEY);
      console.log = silent;
      const target = path.join(tmp, "fresh", "The Culling Remaster");
      const m = await sync.fetchManifest(base + "/full/manifest.json", TEST_PUB);
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
      signedManifest("/resume/manifest.json", { version: "3", files: [
        { path: "Victory/Content/Paks/big.pak", size: big.length, sha256: sha, url: "big.pak" }] });
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
      const m = await sync.fetchManifest(base + "/resume/manifest.json", TEST_PUB);
      let last = null;
      await sync.apply(m, await sync.plan(m, target), target, (p) => { if (p.phase === "download") last = p; }, { retryDelayMs: 10 });
      assert.ok(fs.readFileSync(path.join(target, "Victory/Content/Paks/big.pak")).equals(big));
      assert.strictEqual(calls, 2, "one dropped request, one resumed request");
      assert.ok(/^bytes=[1-9]\d*-$/.test(ranges[0]), "resumed with a Range from the bytes it had: " + ranges[0]);
      assert.strictEqual(last.doneBytes, big.length, "progress counts each byte once");
    });

    await test("a server without ranges restarts the file instead of corrupting it", async () => {
      const data = Buffer.alloc(300000, 9);
      const sha = require("crypto").createHash("sha256").update(data).digest("hex");
      signedManifest("/norange/manifest.json", { version: "1", files: [
        { path: "Victory/x.bin", size: data.length, sha256: sha, url: "x.bin" }] });
      routes["/norange/x.bin"] = (req, res) => res.end(data);       // ignores Range: always the whole file
      const target = path.join(tmp, "norange-game");
      fs.mkdirSync(path.join(target, "Victory"), { recursive: true });
      fs.writeFileSync(path.join(target, "Victory", "x.bin.part"), Buffer.alloc(1000, 1));   // stale partial
      const m = await sync.fetchManifest(base + "/norange/manifest.json", TEST_PUB);
      let last = null;
      await sync.apply(m, await sync.plan(m, target), target, (p) => { if (p.phase === "download") last = p; }, { retryDelayMs: 10 });
      assert.ok(fs.readFileSync(path.join(target, "Victory/x.bin")).equals(data));
      assert.strictEqual(last.doneBytes, data.length);
    });

    await test("not enough disk space stops before anything downloads", async () => {
      assert.throws(() => sync.checkSpace(game, Number.MAX_SAFE_INTEGER), /not enough disk space/);
      assert.ok(sync.freeBytes(path.join(tmp, "not", "made", "yet")) > 0, "free space of a folder that doesn't exist yet");
    });

    await test("a manifest edited on the server is refused (signature)", async () => {
      const body = fs.readFileSync(path.join(publish, "manifest.json"), "utf8");
      served["/manifest.json"] = body.replace('"version": "1.0.1"', '"version": "6.6.6"');
      await assert.rejects(sync.fetchManifest(base + "/manifest.json", TEST_PUB), /signature/);
      served = {};
    });

    await test("a bad or missing signature is refused", async () => {
      served["/manifest.json.sig"] = "bm90IGEgc2lnbmF0dXJl";     // base64 of "not a signature"
      await assert.rejects(sync.fetchManifest(base + "/manifest.json", TEST_PUB), /signature/);
      served = {};
      fs.renameSync(path.join(publish, "manifest.json.sig"), path.join(publish, "sig.bak"));
      await assert.rejects(sync.fetchManifest(base + "/manifest.json", TEST_PUB), /HTTP 404/);
      fs.renameSync(path.join(publish, "sig.bak"), path.join(publish, "manifest.json.sig"));
    });

    await test("a release signed with another key is refused, including by the real launcher key", async () => {
      const other = crypto.generateKeyPairSync("ed25519").publicKey.export({ type: "spki", format: "pem" });
      await assert.rejects(sync.fetchManifest(base + "/manifest.json", other), /signature/);
      await assert.rejects(sync.fetchManifest(base + "/manifest.json"), /signature/);
      assert.ok(await sync.fetchManifest(base + "/manifest.json", TEST_PUB));
    });

    await test("pausing keeps finished and partial files, and resuming continues from them", async () => {
      // Six 1 MB files; the server sends them slowly enough to pause mid-way.
      const files = [], blobs = {};
      const fetched = {}, ranges = [];
      for (let i = 0; i < 6; i++) {
        const b = Buffer.alloc(1 << 20, i + 1);
        blobs["/pause/f" + i] = b;
        files.push({ path: `Victory/p${i}.bin`, size: b.length, sha256: crypto.createHash("sha256").update(b).digest("hex"), url: "f" + i });
      }
      signedManifest("/pause/manifest.json", { version: "4", files });
      for (const [route, b] of Object.entries(blobs)) {
        routes[route] = (req, res) => {
          fetched[route] = (fetched[route] || 0) + 1;
          const from = req.headers.range ? Number(/bytes=(\d+)-/.exec(req.headers.range)[1]) : 0;
          if (req.headers.range) ranges.push(route + ":" + from);
          res.writeHead(from ? 206 : 200, Object.assign({ "Content-Length": b.length - from }, from ? { "Content-Range": `bytes ${from}-${b.length - 1}/${b.length}` } : {}));
          let at = from;
          const tick = setInterval(() => {               // 64 KB every 10 ms
            if (res.destroyed) return clearInterval(tick);
            const end = Math.min(b.length, at + 65536);
            res.write(b.subarray(at, end));
            at = end;
            if (at >= b.length) { clearInterval(tick); res.end(); }
          }, 10);
          res.on("close", () => clearInterval(tick));
        };
      }
      const target = path.join(tmp, "pause-game");
      const m = await sync.fetchManifest(base + "/pause/manifest.json", TEST_PUB);
      const ctl = new AbortController();
      let seen = 0;
      const first = sync.apply(m, await sync.plan(m, target), target, (p) => {
        seen = p.doneBytes;
        if (p.doneBytes > 2.5 * (1 << 20) && !ctl.signal.aborted) ctl.abort();
      }, { parallel: 2, signal: ctl.signal, retryDelayMs: 10 });
      await assert.rejects(first, (e) => e instanceof sync.SyncPaused);
      // Downloads wait in staging; nothing reaches the game folder before the commit.
      const stagingDir = path.join(target, ".remaster", "staging", "Victory");
      const done = fs.readdirSync(stagingDir).filter((n) => n.endsWith(".bin"));
      const parts = fs.readdirSync(stagingDir).filter((n) => n.endsWith(".part"));
      assert.ok(!fs.existsSync(path.join(target, "Victory")), "game folder untouched while paused");
      assert.ok(done.length >= 2, "finished files kept: " + done);
      assert.ok(parts.length >= 1, "partial files kept: " + parts);
      assert.strictEqual(sync.installedVersion(target), null, "not marked installed while paused");

      // A new launcher run: only what's missing is planned, partial files resume by Range.
      const m2 = await sync.fetchManifest(base + "/pause/manifest.json", TEST_PUB);
      const todo = await sync.plan(m2, target);
      assert.strictEqual(todo.filter((f) => !f.staged).length, 6 - done.length, "finished files aren't downloaded again");
      assert.strictEqual(todo.report.staged, done.length, "finished files wait in staging for the commit");
      assert.ok(sync.partialBytes(todo, target) > 0, "partial progress is counted");
      const before = Object.assign({}, fetched);
      let last = null;
      await sync.apply(m2, todo, target, (p) => { if (p.phase === "download") last = p; }, { parallel: 2, retryDelayMs: 10 });
      for (const n of done) assert.strictEqual(fetched["/pause/f" + n.slice(1, 2)], before["/pause/f" + n.slice(1, 2)], n + " not fetched again");
      assert.ok(ranges.length >= 1, "resumed with a Range: " + ranges);
      for (let i = 0; i < 6; i++) assert.ok(fs.readFileSync(path.join(target, `Victory/p${i}.bin`)).equals(blobs["/pause/f" + i]));
      assert.strictEqual(sync.installedVersion(target), "4");
      assert.strictEqual(last.doneBytes, last.totalBytes);
      assert.ok(seen > 0);
    });

    await test("a stalled connection is dropped and the file resumes", async () => {
      const data = Buffer.alloc(200000, 5);
      let calls = 0;
      signedManifest("/stall/manifest.json", { version: "5", files: [
        { path: "Victory/s.bin", size: data.length, sha256: crypto.createHash("sha256").update(data).digest("hex"), url: "s.bin" }] });
      routes["/stall/s.bin"] = (req, res) => {
        calls++;
        const from = req.headers.range ? Number(/bytes=(\d+)-/.exec(req.headers.range)[1]) : 0;
        res.writeHead(from ? 206 : 200, Object.assign({ "Content-Length": data.length - from }, from ? { "Content-Range": `bytes ${from}-${data.length - 1}/${data.length}` } : {}));
        if (calls === 1) { res.write(data.subarray(0, 50000)); return; }   // then goes silent, never ends
        res.end(data.subarray(from));
      };
      const target = path.join(tmp, "stall-game");
      const m = await sync.fetchManifest(base + "/stall/manifest.json", TEST_PUB);
      const t0 = Date.now();
      await sync.apply(m, await sync.plan(m, target), target, () => {}, { stallMs: 300, retryDelayMs: 10 });
      assert.ok(fs.readFileSync(path.join(target, "Victory/s.bin")).equals(data));
      assert.strictEqual(calls, 2, "one stalled request, one resumed");
      assert.ok(Date.now() - t0 < 5000, "didn't hang");
    });

    await test("files download in parallel", async () => {
      let now = 0, most = 0;
      const files = [];
      for (let i = 0; i < 24; i++) {
        const b = Buffer.from("small file " + i);
        routes["/par/f" + i] = (req, res) => {
          now++; most = Math.max(most, now);
          setTimeout(() => { now--; res.end(b); }, 40);
        };
        files.push({ path: `Victory/a/f${i}.txt`, size: b.length, sha256: crypto.createHash("sha256").update(b).digest("hex"), url: "f" + i });
      }
      signedManifest("/par/manifest.json", { version: "6", files });
      const target = path.join(tmp, "par-game");
      const m = await sync.fetchManifest(base + "/par/manifest.json", TEST_PUB);
      await sync.apply(m, await sync.plan(m, target), target);
      assert.strictEqual(most, sync.PARALLEL, "requests at once");
      assert.strictEqual((await sync.plan(m, target)).length, 0, "all verified");
    });

    console.log("all %d sync tests passed", passed);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.rmSync(tmpKeyDir, { recursive: true, force: true });
  }
})().catch((e) => { console.error("FAIL", e.message); process.exitCode = 1; server.close(); });
