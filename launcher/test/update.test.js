// Updates against a local HTTP server: differential downloads, staging and
// commit, crash recovery, rollback, repair, Range edge cases, per-file
// failures, the bandwidth cap, concurrency back-off and manifest rules.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const crypto = require("crypto");
const sync = require("../lib/sync");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-update-"));
const pair = crypto.generateKeyPairSync("ed25519");
const PUB = pair.publicKey.export({ type: "spki", format: "pem" });
const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");

let routes = {};
const hits = {};
const server = http.createServer((req, res) => {
  const p = decodeURIComponent(req.url.split("?")[0]);
  hits[p] = (hits[p] || 0) + 1;
  if (routes[p]) return routes[p](req, res);
  res.statusCode = 404;
  res.end();
});

// Publishes a release at /<name>/: files is { path: Buffer }. Returns the base.
function release(name, version, files, extra = {}) {
  const entries = Object.entries(files).map(([p, b]) => {
    const url = "o/" + sha(b);
    routes[`/${name}/${url}`] = (req, res) => serveRange(req, res, b);
    return { path: p, size: b.length, sha256: sha(b), url };
  });
  const body = Buffer.from(JSON.stringify(Object.assign({ version, files: entries }, extra)));
  routes[`/${name}/manifest.json`] = (req, res) => res.end(body);
  routes[`/${name}/manifest.json.sig`] = (req, res) => res.end(crypto.sign(null, body, pair.privateKey).toString("base64"));
}

// A well-behaved static server: ETag, Range, If-Range, 416.
function serveRange(req, res, b) {
  const etag = `"${sha(b).slice(0, 16)}"`;
  const m = /^bytes=(\d+)-$/.exec(req.headers.range || "");
  const ifRangeOk = !req.headers["if-range"] || req.headers["if-range"] === etag;
  if (m && ifRangeOk) {
    const from = Number(m[1]);
    if (from >= b.length) { res.writeHead(416, { "Content-Range": `bytes */${b.length}` }); return res.end(); }
    res.writeHead(206, { ETag: etag, "Content-Length": b.length - from, "Content-Range": `bytes ${from}-${b.length - 1}/${b.length}` });
    return res.end(b.subarray(from));
  }
  res.writeHead(200, { ETag: etag, "Content-Length": b.length });
  res.end(b);
}

let base;
const get = (name) => sync.fetchManifest(`${base}/${name}/manifest.json`, PUB, 10);
async function install(name, root, opts = {}) {
  const m = await get(name);
  const todo = await sync.plan(m, root);
  const r = await sync.apply(m, todo, root, () => {}, Object.assign({ retryDelayMs: 5 }, opts));
  return { m, todo, r };
}
const read = (root, p) => fs.readFileSync(path.join(root, ...p.split("/")));
// The backup folders of the last update, and the folders of kept repair files.
const backups = (root) => fs.readdirSync(path.join(root, ".remaster")).filter((n) => n === "backup" || n.startsWith("backup-"));
const replaced = (root) => { const d = path.join(root, ".remaster", sync.REPLACED_DIR); return fs.existsSync(d) ? fs.readdirSync(d).map((n) => path.join(d, n)) : []; };

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

(async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${server.address().port}`;
  const A = Buffer.alloc(200000, 1), B = Buffer.alloc(150000, 2), C = Buffer.from("config v1"), OLD = Buffer.from("old pak");
  release("v1", "1.0.0", { "Victory/a.pak": A, "Victory/b.pak": B, "Victory/c.ini": C, "Victory/old.pak": OLD });
  const C2 = Buffer.from("config v2 - changed");
  const D = Buffer.alloc(50000, 4);
  release("v2", "1.1.0", { "Victory/a.pak": A, "Victory/b.pak": B, "Victory/c.ini": C2, "Victory/d.pak": D });
  const root = path.join(tmp, "game");

  try {
    await test("a fresh install stages everything, then commits; the game folder only fills at commit", async () => {
      let sawInstall = false, inGameDuringDownload = false;
      const m = await get("v1");
      const todo = await sync.plan(m, root);
      await sync.apply(m, todo, root, (p) => {
        if (p.phase === "install") sawInstall = true;
        else if (fs.existsSync(path.join(root, "Victory", "a.pak"))) inGameDuringDownload = true;
      }, { retryDelayMs: 5 });
      assert.ok(sawInstall && !inGameDuringDownload);
      assert.ok(read(root, "Victory/a.pak").equals(A));
      assert.strictEqual(sync.installedVersion(root), "1.0.0");
      assert.deepStrictEqual(await sync.plan(m, root), []);
    });

    await test("an update downloads only what changed, removes dropped files, keeps the player's own", async () => {
      fs.writeFileSync(path.join(root, "Victory", "my-notes.txt"), "mine");
      for (const k of Object.keys(hits)) delete hits[k];
      const { todo } = await install("v2", root);
      assert.deepStrictEqual(todo.map((f) => f.path).sort(), ["Victory/c.ini", "Victory/d.pak"]);
      assert.ok(!hits[`/v2/o/${sha(A)}`] && !hits[`/v2/o/${sha(B)}`], "unchanged files not fetched");
      assert.ok(read(root, "Victory/c.ini").equals(C2));
      assert.ok(!fs.existsSync(path.join(root, "Victory", "old.pak")), "dropped pak removed (UE4 mounts every pak)");
      assert.strictEqual(fs.readFileSync(path.join(root, "Victory", "my-notes.txt"), "utf8"), "mine");
      assert.strictEqual(sync.installedVersion(root), "1.1.0");
      assert.strictEqual(sync.previousVersion(root), "1.0.0");
    });

    await test("rollback restores the previous version exactly", async () => {
      assert.strictEqual(sync.rollback(root), "1.0.0");
      assert.ok(read(root, "Victory/c.ini").equals(C));
      assert.ok(read(root, "Victory/old.pak").equals(OLD));
      assert.ok(!fs.existsSync(path.join(root, "Victory", "d.pak")), "file new in 1.1.0 removed");
      assert.strictEqual(sync.installedVersion(root), "1.0.0");
      assert.deepStrictEqual(await sync.plan(await get("v1"), root), [], "1.0.0 verifies");
      assert.throws(() => sync.rollback(root), /no previous version/);
      await install("v2", root);
    });

    await test("Verify & Sync with nothing to do keeps the previous version and its backup", async () => {
      assert.strictEqual(sync.previousVersion(root), "1.0.0");
      const before = backups(root);
      assert.strictEqual(before.length, 1);
      const { todo, r } = await install("v2", root);
      assert.deepStrictEqual(todo, []);
      assert.strictEqual(r.files, 0);
      assert.strictEqual(sync.previousVersion(root), "1.0.0", "Restore previous version still offers 1.0.0");
      assert.deepStrictEqual(backups(root), before, "backup untouched");
      assert.ok(!fs.existsSync(path.join(root, ".remaster", "journal.json")));
    });

    await test("a same-version repair keeps the backup, and the player's replaced file in replaced/", async () => {
      fs.writeFileSync(path.join(root, "Victory", "c.ini"), "my own edit");
      const before = backups(root);
      const { todo, r } = await install("v2", root);
      assert.deepStrictEqual(todo.map((f) => f.path), ["Victory/c.ini"]);
      assert.strictEqual(r.kept, 1);
      assert.ok(read(root, "Victory/c.ini").equals(C2), "repaired");
      assert.strictEqual(sync.installedVersion(root), "1.1.0");
      assert.strictEqual(sync.previousVersion(root), "1.0.0", "previous isn't pointed at the current version");
      assert.deepStrictEqual(backups(root), before, "the last update's backup survives a repair");
      assert.strictEqual(fs.readFileSync(path.join(replaced(root)[0], "Victory", "c.ini"), "utf8"), "my own edit");
      // A second repair: only the newest one's files are kept.
      fs.writeFileSync(path.join(root, "Victory", "c.ini"), "second edit");
      await install("v2", root);
      assert.strictEqual(replaced(root).length, 1, "newest repair only");
      assert.strictEqual(fs.readFileSync(path.join(replaced(root)[0], "Victory", "c.ini"), "utf8"), "second edit");
      // Bounded: over the size limit, the biggest kept files go.
      fs.writeFileSync(path.join(root, "Victory", "c.ini"), "third edit");
      fs.writeFileSync(path.join(root, "Victory", "a.pak"), Buffer.alloc(200000, 0xee));
      const { r: r3 } = await install("v2", root, { replacedMax: 1000 });
      assert.strictEqual(r3.kept, 1, "the big file isn't kept");
      assert.strictEqual(fs.readFileSync(path.join(replaced(root)[0], "Victory", "c.ini"), "utf8"), "third edit");
      assert.ok(read(root, "Victory/a.pak").equals(A));
      // Restore previous version still brings back 1.0.0 exactly.
      assert.strictEqual(sync.rollback(root), "1.0.0");
      assert.ok(read(root, "Victory/c.ini").equals(C) && read(root, "Victory/old.pak").equals(OLD));
      assert.deepStrictEqual(await sync.plan(await get("v1"), root), []);
      await install("v2", root);
      assert.strictEqual(backups(root).length, 1, "an update replaces the old backup once it has committed");
    });

    await test("a locked file during commit puts everything back and keeps the downloads", async () => {
      const C3 = Buffer.from("config v3"), A3 = Buffer.alloc(200000, 9);
      release("v3", "1.2.0", { "Victory/a.pak": A3, "Victory/b.pak": B, "Victory/c.ini": C3, "Victory/d.pak": D });
      const realRename = fs.renameSync;
      fs.renameSync = function (from, to) {
        if (String(to) === path.join(root, "Victory", "c.ini") && !String(from).includes("backup")) {
          throw Object.assign(new Error("EBUSY: resource busy or locked"), { code: "EBUSY", path: String(to) });
        }
        return realRename.apply(this, arguments);
      };
      try {
        await assert.rejects(install("v3", root), /in use .*close the game/);
      } finally {
        fs.renameSync = realRename;
      }
      assert.strictEqual(sync.installedVersion(root), "1.1.0");
      assert.ok(read(root, "Victory/c.ini").equals(C2) && read(root, "Victory/a.pak").equals(A), "1.1.0 files back in place");
      assert.strictEqual(sync.previousVersion(root), "1.0.0", "a failed commit leaves the last update's backup");
      assert.ok(backups(root).some((n) => fs.existsSync(path.join(root, ".remaster", n, "Victory", "c.ini"))), "1.0.0's files still kept");
      for (const k of Object.keys(hits)) delete hits[k];
      const m = await get("v3");
      const todo = await sync.plan(m, root);
      assert.ok(todo.every((f) => f.staged), "downloads kept in staging");
      await sync.apply(m, todo, root, () => {}, { retryDelayMs: 5 });
      assert.ok(!hits[`/v3/o/${sha(A3)}`], "not downloaded again");
      assert.ok(read(root, "Victory/c.ini").equals(C3));
    });

    await test("a crash mid-commit is finished on the next start", async () => {
      const C4 = Buffer.from("config v4"), A4 = Buffer.alloc(200000, 5);
      release("v4", "1.3.0", { "Victory/a.pak": A4, "Victory/b.pak": B, "Victory/c.ini": C4, "Victory/d.pak": D });
      // Commit "crashes" after moving one file: the process dies before the
      // journal is cleared (simulated by throwing from inside a rename that
      // can't be undone in the same run).
      const realRename = fs.renameSync;
      let moves = 0;
      fs.renameSync = function (from, to) {
        if (String(from).includes("staging") && !String(from).endsWith(".part") && ++moves === 2) {
          const e = new Error("simulated power loss");
          e.crash = true;
          throw e;
        }
        return realRename.apply(this, arguments);
      };
      const realRm = fs.rmSync;
      fs.rmSync = function (p) {                          // the "dead" process can't undo or clean up
        if (moves >= 2 && (String(p).includes("journal") || String(p).includes("staging"))) return;
        return realRm.apply(this, arguments);
      };
      try {
        await assert.rejects(install("v4", root));
      } finally {
        fs.renameSync = realRename;
        fs.rmSync = realRm;
      }
      // The failed commit tried to put things back; whatever state is left, a
      // journal-driven recovery must end at a consistent install.
      const journal = path.join(root, ".remaster", "journal.json");
      if (fs.existsSync(journal)) assert.strictEqual(sync.recover(root), true);
      const m = await get("v4");
      const todo = await sync.plan(m, root);
      if (todo.length) await sync.apply(m, todo, root, () => {}, { retryDelayMs: 5 });
      assert.deepStrictEqual(await sync.plan(m, root), []);
      assert.ok(read(root, "Victory/a.pak").equals(A4));
      assert.strictEqual(sync.installedVersion(root), "1.3.0");
    });

    await test("recovery rolls a journaled commit forward", async () => {
      // Build the mid-commit state by hand: one file moved, one still staged.
      const r2 = path.join(tmp, "recover");
      release("r1", "1.0.0", { "Victory/x.bin": Buffer.from("x1"), "Victory/y.bin": Buffer.from("y1") });
      await install("r1", r2);
      const X2 = Buffer.from("x2"), Y2 = Buffer.from("y2");
      const st = (p) => path.join(r2, ".remaster", "staging", ...p.split("/"));
      const bk = (p) => path.join(r2, ".remaster", "backup", ...p.split("/"));
      fs.mkdirSync(path.dirname(st("Victory/y.bin")), { recursive: true });
      fs.mkdirSync(path.dirname(bk("Victory/x.bin")), { recursive: true });
      fs.renameSync(path.join(r2, "Victory", "x.bin"), bk("Victory/x.bin"));   // x: old moved to backup...
      fs.writeFileSync(path.join(r2, "Victory", "x.bin"), X2);                  // ...and new in place
      fs.writeFileSync(st("Victory/y.bin"), Y2);                                 // y: still staged
      fs.writeFileSync(path.join(r2, ".remaster", "journal.json"), JSON.stringify({
        version: "2.0.0", from: "1.0.0", obsolete: [], oldRecords: {},
        files: [{ path: "Victory/x.bin", sha256: sha(X2), size: 2, hadOld: true }, { path: "Victory/y.bin", sha256: sha(Y2), size: 2, hadOld: true }]
      }));
      assert.strictEqual(sync.recover(r2), true);
      assert.ok(read(r2, "Victory/x.bin").equals(X2) && read(r2, "Victory/y.bin").equals(Y2));
      assert.ok(read(r2, ".remaster/backup/Victory/y.bin").equals(Buffer.from("y1")), "old y kept for rollback");
      assert.strictEqual(sync.installedVersion(r2), "2.0.0");
      assert.strictEqual(sync.recover(r2), false, "nothing left to recover");
    });

    await test("Repair finds a silently corrupted file the quick check trusts", async () => {
      const f = path.join(root, "Victory", "b.pak");
      const st = fs.statSync(f);
      const bad = Buffer.from(B); bad[100] ^= 0xff;
      fs.writeFileSync(f, bad);
      // Bit rot behind unchanged metadata: the verified record still matches
      // the file's size and time, so only a full rehash can catch it.
      const stateFile = path.join(root, ".remaster", "sync-state.json");
      const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      state.files["Victory/b.pak"].mtimeMs = fs.statSync(f).mtimeMs;
      fs.writeFileSync(stateFile, JSON.stringify(state));
      assert.strictEqual(st.size, bad.length);
      const m = await get("v4");
      assert.deepStrictEqual(await sync.plan(m, root), [], "quick check trusts the record");
      const todo = await sync.plan(m, root, () => {}, { full: true });
      assert.deepStrictEqual(todo.map((x) => x.path), ["Victory/b.pak"]);
      assert.deepStrictEqual(todo.report, { ok: 3, missing: 0, changed: 1, staged: 0 });
      await sync.apply(m, todo, root, () => {}, { retryDelayMs: 5 });
      assert.ok(read(root, "Victory/b.pak").equals(B));
    });

    await test("a wrong Content-Range is refused and the file starts over cleanly", async () => {
      const data = Buffer.alloc(300000, 7);
      let calls = 0;
      routes["/cr/manifest.json"] = null;
      release("cr", "1", { "Victory/f.bin": data });
      routes[`/cr/o/${sha(data)}`] = (req, res) => {
        calls++;
        if (calls === 1) { res.writeHead(200, { "Content-Length": data.length }); res.write(data.subarray(0, 100000)); return setTimeout(() => res.destroy(), 20); }
        if (calls === 2) {                                 // claims the wrong offset
          res.writeHead(206, { "Content-Range": `bytes 0-${data.length - 1}/${data.length}`, "Content-Length": data.length });
          return res.end(data);
        }
        serveRange(req, res, data);
      };
      const r = path.join(tmp, "cr");
      await install("cr", r);
      assert.ok(read(r, "Victory/f.bin").equals(data));
      assert.strictEqual(calls, 3);
    });

    await test("416 on a partial file that is already complete is accepted", async () => {
      const data = Buffer.alloc(120000, 3);
      release("full", "1", { "Victory/f.bin": data });
      const r = path.join(tmp, "full416");
      const part = path.join(r, ".remaster", "staging", "Victory", "f.bin.part");
      fs.mkdirSync(path.dirname(part), { recursive: true });
      fs.writeFileSync(part, data);                        // a complete .part from a run that died before verifying
      await install("full", r);
      assert.ok(read(r, "Victory/f.bin").equals(data));
    });

    await test("a stale .part from another release is dropped, not an error", async () => {
      const data = Buffer.alloc(1100000, 6);
      release("stale", "2", { "Victory/s.pak": data });
      const r = path.join(tmp, "stale");
      const part = path.join(r, ".remaster", "staging", "Victory", "s.pak.part");
      fs.mkdirSync(path.dirname(part), { recursive: true });
      fs.writeFileSync(part, Buffer.alloc(400000, 9));
      fs.writeFileSync(part + ".json", JSON.stringify({ sha256: "0".repeat(64), etag: '"old"' }));
      await install("stale", r);
      assert.ok(read(r, "Victory/s.pak").equals(data));
    });

    await test("one failing file doesn't stop the others; the next run fetches only it", async () => {
      const ok1 = Buffer.from("fine 1"), ok2 = Buffer.from("fine 2"), bad = Buffer.from("will 404 first");
      release("one", "1", { "Victory/1.txt": ok1, "Victory/2.txt": ok2, "Victory/bad.txt": bad });
      const good = routes[`/one/o/${sha(bad)}`];
      routes[`/one/o/${sha(bad)}`] = (req, res) => { res.statusCode = 404; res.end(); };
      const r = path.join(tmp, "one");
      const e = await install("one", r).then(() => null, (x) => x);
      assert.ok(e && /1 file\(s\) couldn't be downloaded/.test(e.message) && e.failed.length === 1, e && e.message);
      assert.strictEqual(sync.installedVersion(r), null, "not installed with a file missing");
      routes[`/one/o/${sha(bad)}`] = good;
      const m = await get("one");
      const todo = await sync.plan(m, r);
      assert.deepStrictEqual(todo.filter((f) => !f.staged).map((f) => f.path), ["Victory/bad.txt"]);
      await sync.apply(m, todo, r, () => {}, { retryDelayMs: 5 });
      assert.strictEqual(sync.installedVersion(r), "1");
    });

    await test("rate limiting (429) and server errors are retried", async () => {
      const data = Buffer.from("busy server");
      release("busy", "1", { "Victory/b.txt": data });
      let calls = 0;
      const good = routes[`/busy/o/${sha(data)}`];
      routes[`/busy/o/${sha(data)}`] = (req, res) => { calls++; if (calls <= 2) { res.statusCode = calls === 1 ? 429 : 503; return res.end(); } good(req, res); };
      await install("busy", path.join(tmp, "busy"));
      assert.strictEqual(calls, 3);
    });

    await test("the bandwidth cap holds", async () => {
      const data = Buffer.alloc(3 * 1048576, 8);
      release("cap", "1", { "Victory/big.bin": data });
      const t0 = Date.now();
      await install("cap", path.join(tmp, "cap"), { maxBytesPerSec: 1048576 });
      const s = (Date.now() - t0) / 1000;
      assert.ok(s >= 1.7, `3 MB at 1 MB/s (1 MB burst) took ${s.toFixed(2)} s`);
    });

    await test("connections that keep dropping lower how many run at once", async () => {
      const files = {};
      for (let i = 0; i < 12; i++) files[`Victory/f${i}.bin`] = Buffer.from("file " + i);
      release("flaky", "1", files);
      for (const [p, b] of Object.entries(files)) {
        const good = routes[`/flaky/o/${sha(b)}`];
        let n = 0;
        routes[`/flaky/o/${sha(b)}`] = (req, res) => (++n === 1 ? req.socket.destroy() : good(req, res));
      }
      const events = [];
      await install("flaky", path.join(tmp, "flaky"), { parallel: 8, log: (ev, d) => events.push([ev, d]) });
      const lowered = events.filter(([ev, d]) => ev === "parallel" && d.why === "network");
      assert.ok(lowered.length >= 1 && lowered[lowered.length - 1][1].now < 8, JSON.stringify(lowered));
    });

    await test("unsafe or ambiguous manifests are refused", async () => {
      const entry = (p) => ({ path: p, size: 1, sha256: "a".repeat(64), url: "x" });
      for (const p of ["REMAST~1/x", "Victory./x", "a/con .txt", "a/CONIN$", "../x", "C:/x", ".remaster/x"]) {
        assert.throws(() => sync.validateManifest({ version: "1", files: [entry(p)] }), /unsafe|escapes/, p);
      }
      assert.throws(() => sync.validateManifest({ version: "1", files: [entry("Victory/A.pak"), entry("victory/a.pak")] }), /twice/);
      assert.throws(() => sync.validateManifest({ version: "1", files: [], servers: [{ id: "x", name: "x", api: "http://evil.example/api" }] }), /non-https/);
      assert.throws(() => sync.validateManifest({ version: "1", files: [], servers: [{ id: "x" }] }), /server entry/);
    });

    await test("a manifest swapped mid-publish is read again once", async () => {
      const b1 = Buffer.from(JSON.stringify({ version: "1", files: [] })), b2 = Buffer.from(JSON.stringify({ version: "2", files: [] }));
      let n = 0;
      routes["/swap/manifest.json"] = (req, res) => res.end(++n === 1 ? b1 : b2);
      routes["/swap/manifest.json.sig"] = (req, res) => res.end(crypto.sign(null, b2, pair.privateKey).toString("base64"));
      assert.strictEqual((await get("swap")).version, "2");
    });

    await test("redirects are refused", async () => {
      routes["/redir/manifest.json"] = (req, res) => { res.writeHead(302, { Location: "http://example.com/m.json" }); res.end(); };
      await assert.rejects(get("redir"));
    });

    await test("leftovers are cleaned: old-launcher .part files and empty staging folders", async () => {
      const data = Buffer.from("tidy");
      release("tidy", "1", { "Victory/deep/t.txt": data });
      const r = path.join(tmp, "tidy");
      await install("tidy", r);
      fs.writeFileSync(path.join(r, "Victory", "deep", "t.txt.part"), data);   // as the first launchers left them
      await sync.plan(await get("tidy"), r);
      assert.ok(!fs.existsSync(path.join(r, "Victory", "deep", "t.txt.part")));
      assert.ok(!fs.existsSync(path.join(r, ".remaster", "staging")), "empty staging folders removed after commit");
      const events = [];
      release("tidy2", "2", { "Victory/deep/t.txt": Buffer.from("tidy v2") });
      await install("tidy2", r, { log: (ev, d) => events.push([ev, d]) });
      assert.strictEqual(events.find(([ev]) => ev === "download")[1].files, 1, "the log counts downloaded files");
    });

    await test("a corrupted state file is rebuilt by rehashing, nothing is downloaded again", async () => {
      const data = { "Victory/x.pak": Buffer.alloc(70000, 3), "Victory/y.ini": Buffer.from("y") };
      release("corrupt-state", "1", data);
      const r = path.join(tmp, "corrupt-state");
      await install("corrupt-state", r);
      fs.writeFileSync(path.join(r, ".remaster", "sync-state.json"), "{\"format\":2,\"files\":{\"Victor");   // cut off mid-write
      for (const k of Object.keys(hits)) delete hits[k];
      const m = await get("corrupt-state");
      assert.deepStrictEqual(await sync.plan(m, r), [], "every file verified by hash");
      assert.ok(!Object.keys(hits).some((k) => k.includes("/o/")), "nothing downloaded");
      const rebuilt = JSON.parse(fs.readFileSync(path.join(r, ".remaster", "sync-state.json"), "utf8"));
      assert.strictEqual(Object.keys(rebuilt.files).length, 2, "records rebuilt");
    });

    await test("install folders with spaces and non-English characters work end to end", async () => {
      const files = { "Victory/Content/Paks/a b.pak": Buffer.alloc(50000, 1), "Victory/Ünïcödé/日本.txt": Buffer.from("ok") };
      release("unicode", "1", files);
      const r = path.join(tmp, "Mes Jeux", "Spiele Ünïcode 游戏", "The Culling");
      await install("unicode", r);
      for (const [p, b] of Object.entries(files)) assert.ok(read(r, p).equals(b), p);
      assert.deepStrictEqual(await sync.plan(await get("unicode"), r), []);
      assert.strictEqual(sync.installedVersion(r), "1");
    });

    await test("a game folder at a drive root works", async () => {
      const drive = path.parse(tmp).root;                // "C:\" on Windows, "/" elsewhere
      assert.strictEqual(sync.targetPath(drive, "Victory/Binaries/Win64/Victory.exe"), path.join(drive, "Victory", "Binaries", "Win64", "Victory.exe"));
      assert.throws(() => sync.targetPath(drive, "../x"), sync.SyncError);
      assert.throws(() => sync.targetPath(drive, ".remaster/x"), sync.SyncError);
    });

    await test("versions compare numerically", async () => {
      assert.strictEqual(sync.compareVersions("1.10.0", "1.9.9"), 1);
      assert.strictEqual(sync.compareVersions("1.1", "1.1.0"), 0);
      assert.strictEqual(sync.compareVersions("1.0.9", "1.1.0"), -1);
    });

    console.log("all %d update tests passed", passed);
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exitCode = 1; server.close(); });
