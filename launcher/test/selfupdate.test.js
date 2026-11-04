// The launcher updating itself: what's offered, the verified download, the
// loop guard, and the manifest entry the release tools write.
"use strict";

const assert = require("assert");
const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const selfupdate = require("../lib/selfupdate");
const sync = require("../lib/sync");
const { main: makeManifest, exeVersion } = require("../tools/make_manifest");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-selfupdate-"));
const TEST_KEY = path.join(tmp, "release_ed25519.pem");
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

const SETUP = crypto.randomBytes(300000);
const SHA = crypto.createHash("sha256").update(SETUP).digest("hex");

// Serves the setup at /objects/<sha>; ?stall sends half, then nothing.
function server() {
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (req.url.startsWith("/stall/")) {
      res.writeHead(200, { "Content-Length": SETUP.length });
      res.write(SETUP.subarray(0, SETUP.length / 2));
      return;                                  // never finishes
    }
    if (req.url === "/objects/" + SHA) { res.writeHead(200, { "Content-Length": SETUP.length }); return res.end(SETUP); }
    if (req.url.startsWith("/tampered/")) { const b = Buffer.from(SETUP); b[10] ^= 1; res.writeHead(200); return res.end(b); }
    if (req.url.startsWith("/bigger/")) { res.writeHead(200); return res.end(Buffer.concat([SETUP, Buffer.alloc(10)])); }
    res.writeHead(404); res.end();
  });
  return new Promise((r) => srv.listen(0, "127.0.0.1", () => r({ srv, base: `http://127.0.0.1:${srv.address().port}/manifest.json`, hits: () => hits })));
}

const manifestFor = (base, url = "objects/" + SHA, version = "1.3.0") =>
  ({ version: "1.1.0", files: [], baseUrl: base, launcher: { version, size: SETUP.length, sha256: SHA, url } });

(async () => {
  const s = await server();
  try {
    await test("only a newer launcher is offered", () => {
      const m = manifestFor(s.base);
      assert.strictEqual(selfupdate.offered(m, "1.2.0").version, "1.3.0");
      assert.strictEqual(selfupdate.offered(m, "1.3.0"), null);
      assert.strictEqual(selfupdate.offered(m, "1.10.0"), null, "numeric, not text, comparison");
      assert.strictEqual(selfupdate.offered({ version: "1.1.0", files: [] }, "1.0.0"), null, "no launcher entry: nothing");
      for (const bad of [{ version: "x", size: 1, sha256: SHA, url: "u" }, { version: "1.3.0", size: 0, sha256: SHA, url: "u" },
        { version: "1.3.0", size: 1, sha256: "nothex", url: "u" }, null]) {
        assert.throws(() => selfupdate.offered({ launcher: bad }, "1.0.0"), /bad launcher entry/);
      }
    });

    await test("the setup is downloaded and checked against the signed size and SHA-256", async () => {
      const dir = path.join(tmp, "dl");
      const seen = [];
      const file = await selfupdate.download(manifestFor(s.base), dir, { fetchImpl: fetch, onProgress: (d, t) => seen.push([d, t]) });
      assert.ok(fs.readFileSync(file).equals(SETUP));
      assert.strictEqual(path.basename(file), "TheCullingRemasterSetup-1.3.0.exe");
      assert.deepStrictEqual(seen[seen.length - 1], [SETUP.length, SETUP.length]);
      const before = s.hits();
      assert.strictEqual(await selfupdate.download(manifestFor(s.base), dir, { fetchImpl: fetch }), file);
      assert.strictEqual(s.hits(), before, "an intact setup already there isn't downloaded again");
    });

    await test("a tampered, oversized or stalled setup is refused and nothing runnable is left", async () => {
      const dir = path.join(tmp, "bad");
      await assert.rejects(selfupdate.download(manifestFor(s.base, "tampered/x"), dir, { fetchImpl: fetch }), /doesn't match the signed release/);
      await assert.rejects(selfupdate.download(manifestFor(s.base, "bigger/x"), dir, { fetchImpl: fetch }), /larger than the release says/);
      await assert.rejects(selfupdate.download(manifestFor(s.base, "stall/x"), dir, { fetchImpl: fetch, stallMs: 300 }), /stopped arriving/);
      await assert.rejects(selfupdate.download(manifestFor(s.base, "missing/x"), dir, { fetchImpl: fetch }), /HTTP 404/);
      assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith(".exe")), "no setup left to run");
      await assert.rejects(selfupdate.download(manifestFor(s.base, "http://example.com/setup.exe"), dir, { fetchImpl: fetch }), /non-https/);
    });

    await test("the setup runs silently, detached, and starts the new launcher", () => {
      let call = null;
      selfupdate.install("C:\\x\\Setup.exe", (file, args, opts) => { call = { file, args, opts }; return { unref() { call.unref = true; } }; });
      assert.deepStrictEqual(call.args, ["/S", "--updated", "--force-run"]);
      assert.ok(call.opts.detached && call.unref);
    });

    await test("a setup that doesn't take is tried twice, then left alone", () => {
      const dir = path.join(tmp, "tries");
      assert.ok(selfupdate.mayTry(dir, "1.3.0"));
      selfupdate.recordTry(dir, "1.3.0");
      assert.ok(selfupdate.mayTry(dir, "1.3.0"));
      selfupdate.recordTry(dir, "1.3.0");
      assert.ok(!selfupdate.mayTry(dir, "1.3.0"), "no update loop");
      assert.ok(selfupdate.mayTry(dir, "1.3.1"), "a newer release is tried again");
      selfupdate.cleanup(dir);
      assert.ok(!fs.existsSync(dir));
    });

    await test("the release tools name the launcher by the version built into the setup exe", async () => {
      // node.exe stands in for a setup: any exe with a version resource.
      const v = exeVersion(process.execPath);
      assert.match(v, /^\d+(\.\d+){1,3}$/);
      const pair = crypto.generateKeyPairSync("ed25519");
      fs.writeFileSync(TEST_KEY, pair.privateKey.export({ type: "pkcs8", format: "pem" }));
      const release = path.join(tmp, "release"), publish = path.join(tmp, "publish");
      fs.mkdirSync(release, { recursive: true });
      fs.writeFileSync(path.join(release, "a.txt"), "game file");
      await makeManifest(release, "1.1.0", publish, TEST_KEY, "--setup", process.execPath);
      const m = JSON.parse(fs.readFileSync(path.join(publish, "manifest.json"), "utf8"));
      assert.strictEqual(m.launcher.version, v);
      assert.strictEqual(m.launcher.size, fs.statSync(process.execPath).size);
      assert.strictEqual(m.launcher.url, "objects/" + m.launcher.sha256);
      assert.strictEqual(await sync.sha256File(path.join(publish, "objects", m.launcher.sha256)), m.launcher.sha256);
      assert.doesNotThrow(() => sync.validateManifest(m));
      assert.throws(() => sync.validateManifest(Object.assign({}, m, { launcher: { version: 5 } })), /bad launcher entry/);
    });

    console.log("all %d self-update tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    s.srv.closeAllConnections();
    s.srv.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
