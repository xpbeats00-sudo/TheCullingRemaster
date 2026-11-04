// Check deploy/stage_objects.js: old-layout migration, reuse, uploads, bad copies.
"use strict";
const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { stage } = require("./stage_objects");

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
    console.log("stage_objects: all 4 checks passed");
  } finally {
    fs.rmSync(t, { recursive: true, force: true });
  }
})().catch((e) => { console.error("FAIL", e.message); process.exitCode = 1; });
