// Check deploy/stage_objects.js: old-layout migration, reuse, uploads, bad copies.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");
const { stage, plan } = require("./stage_objects");

const sha = (b) => crypto.createHash("sha256").update(b).digest("hex");
const t = fs.mkdtempSync(path.join(os.tmpdir(), "stage-"));
const pub = path.join(t, "publish"), upd = path.join(t, "updates");
const A = Buffer.from("pak A"), B = Buffer.from("pak B"), C = Buffer.from("new file C");
function publish(version, files) {
  fs.rmSync(pub, { recursive: true, force: true });
  fs.mkdirSync(path.join(pub, "objects"), { recursive: true });
  const entries = Object.entries(files).map(([p, b]) => {
    fs.writeFileSync(path.join(pub, "objects", sha(b)), b);
    return { path: p, size: b.length, sha256: sha(b), url: "objects/" + sha(b) };
  });
  fs.writeFileSync(path.join(pub, "manifest.json"), JSON.stringify({ version, files: entries }));
}
(async () => {
  try {
    // The VPS today: release files in the old layout.
    fs.mkdirSync(path.join(upd, "files", "Victory"), { recursive: true });
    fs.writeFileSync(path.join(upd, "files", "Victory", "a.pak"), A);
    fs.writeFileSync(path.join(upd, "files", "Victory", "b.pak"), Buffer.from("stale B!"));   // wrong content
    publish("1", { "Victory/a.pak": A, "Victory/b.pak": B, "Victory/copy-of-a.pak": A });
    let n = await stage(pub, upd, () => {});
    assert.deepStrictEqual([n.reused, n.linked, n.uploaded], [0, 1, 1], "A linked from old layout (once for two paths), B uploaded");
    n = await stage(pub, upd, () => {});
    assert.deepStrictEqual([n.reused, n.linked, n.uploaded], [2, 0, 0], "second publish uploads nothing");
    publish("2", { "Victory/a.pak": A, "Victory/c.pak": C });
    n = await stage(pub, upd, () => {});
    assert.deepStrictEqual([n.reused, n.uploaded, n.uploadedBytes], [1, 1, C.length], "only the new file uploads");
    // A bad copy (the release folder's file doesn't match its hash) is refused.
    publish("3", { "Victory/d.pak": Buffer.from("real D") });
    const m = JSON.parse(fs.readFileSync(path.join(pub, "manifest.json")));
    fs.writeFileSync(path.join(pub, "objects", m.files[0].sha256), Buffer.from("fake D"));
    await assert.rejects(stage(pub, upd, () => {}), /doesn't match/);
    assert.ok(!fs.existsSync(path.join(upd, "objects", m.files[0].sha256)), "nothing bad left in objects");
    // Release 2 goes live; a release that drops files from it is refused unless allowed.
    publish("2", { "Victory/a.pak": A, "Victory/c.pak": C });
    fs.copyFileSync(path.join(pub, "manifest.json"), path.join(upd, "manifest.json"));
    publish("4", { "Victory/a.pak": A });                                    // drops c.pak
    await assert.rejects(stage(pub, upd, () => {}), /removes 1 of the 2 files.*Victory\/c\.pak.*--allow-removals/);
    assert.throws(() => plan(pub, upd, () => {}), /removes 1 of the 2 files/);
    n = await stage(pub, upd, () => {}, { allowRemovals: true });
    assert.strictEqual(n.reused, 1, "allowed explicitly: staged");
    // A release built from an empty folder (no files) is refused even with removals allowed.
    publish("5", {});
    await assert.rejects(stage(pub, upd, () => {}, { allowRemovals: true }), /lists no files/);
    // The command line refuses too, and says how to allow it.
    publish("4", { "Victory/a.pak": A });
    const cli = spawnSync(process.execPath, [path.join(__dirname, "stage_objects.js"), "--plan", pub, upd], { encoding: "utf8" });
    assert.strictEqual(cli.status, 1, cli.stdout + cli.stderr);
    assert.match(cli.stderr, /--allow-removals/);
    const ok = spawnSync(process.execPath, [path.join(__dirname, "stage_objects.js"), "--plan", "--allow-removals", pub, upd], { encoding: "utf8" });
    assert.strictEqual(ok.status, 0, ok.stdout + ok.stderr);
    // A test build (make_release.py --skip-gate records gate "skipped") is refused.
    publish("6", { "Victory/a.pak": A });
    const tm = JSON.parse(fs.readFileSync(path.join(pub, "manifest.json")));
    tm.build = { commit: "abc", gate: "skipped" };
    fs.writeFileSync(path.join(pub, "manifest.json"), JSON.stringify(tm));
    await assert.rejects(stage(pub, upd, () => {}, { allowRemovals: true }), /without the release consistency gate/);
    tm.build.gate = "passed";
    fs.writeFileSync(path.join(pub, "manifest.json"), JSON.stringify(tm));
    await stage(pub, upd, () => {}, { allowRemovals: true });
    // --manifest: the publish stages from the manifest it verified (a TEMP copy), not the release folder's,
    // which a rebuild on the build PC can replace mid-publish.
    publish("7", { "Victory/a.pak": A });
    const verified = path.join(t, "verified-manifest.json");
    fs.copyFileSync(path.join(pub, "manifest.json"), verified);
    const E = Buffer.from("rebuilt E");
    publish("8", { "Victory/a.pak": A, "Victory/e.pak": E });                // the folder's manifest changes after the check
    n = await stage(pub, upd, () => {}, { allowRemovals: true, manifest: verified });
    assert.deepStrictEqual([n.reused, n.uploaded], [1, 0], "staged release 7's objects, not the rebuilt folder's");
    assert.strictEqual(plan(pub, upd, () => {}, { allowRemovals: true, manifest: verified }).to, "7");
    // --sig: the manifest must match its signature (the launcher's release key, or the one given).
    const keys = crypto.generateKeyPairSync("ed25519");
    const sigFile = path.join(t, "verified-manifest.json.sig");
    fs.writeFileSync(sigFile, crypto.sign(null, fs.readFileSync(verified), keys.privateKey).toString("base64"));
    await stage(pub, upd, () => {}, { allowRemovals: true, manifest: verified, sig: sigFile, publicKey: keys.publicKey });
    await assert.rejects(stage(pub, upd, () => {}, { allowRemovals: true, manifest: verified, sig: sigFile }), /signature/,
      "not the launcher's release key");
    fs.writeFileSync(verified, fs.readFileSync(path.join(pub, "manifest.json")));          // altered after signing
    await assert.rejects(stage(pub, upd, () => {}, { allowRemovals: true, manifest: verified, sig: sigFile, publicKey: keys.publicKey }), /signature/);
    const cliM = spawnSync(process.execPath, [path.join(__dirname, "stage_objects.js"), "--plan", "--allow-removals", "--manifest", verified, "--sig", sigFile, pub, upd], { encoding: "utf8" });
    assert.strictEqual(cliM.status, 1, "the command line checks the signature too: " + cliM.stdout + cliM.stderr);
    assert.match(cliM.stderr, /signature/);
    console.log("stage_objects: all 12 checks passed");
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
})().catch((e) => { console.error("FAIL", e.message); process.exitCode = 1; });
