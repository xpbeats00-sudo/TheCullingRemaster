// Puts a release's objects (objects/<sha256>) in place on the VPS, uploading
// only what isn't there yet. Run by publish_release.ps1 before the manifest
// is replaced, so every object a new manifest names already exists.
//
// For each object of the release, in this order:
//   1. already in <updates>/objects (right size): reused;
//   2. the same file in the old layout (<updates>/files/<path>, right size and
//      SHA-256): hard-linked (or copied) from there, so moving a published
//      release to objects uploads nothing;
//   3. otherwise copied from the release folder (over the Remote Desktop
//      drive), checked against its SHA-256, then moved into place.
// Objects are never overwritten: a launcher can be mid-download on any of them.
//
// usage: node deploy/stage_objects.js <release publish dir> <updates dir>
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash("sha256");
    fs.createReadStream(file).on("data", (d) => h.update(d)).on("error", reject).on("end", () => resolve(h.digest("hex")));
  });
}

const sizeOf = (f) => { try { return fs.statSync(f).size; } catch { return -1; } };

// Copies src to dst through a temporary file, refusing a copy whose hash is wrong.
async function copyVerified(src, dst, sha256) {
  const tmp = dst + ".tmp";
  fs.copyFileSync(src, tmp);
  if (await sha256File(tmp) !== sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`copy of ${src} doesn't match its SHA-256`);
  }
  fs.renameSync(tmp, dst);
}

async function stage(publishDir, updatesDir, log = console.log) {
  const manifest = JSON.parse(fs.readFileSync(path.join(publishDir, "manifest.json"), "utf8"));
  const objects = path.join(updatesDir, "objects");
  fs.mkdirSync(objects, { recursive: true });
  const seen = new Set();
  const n = { reused: 0, linked: 0, uploaded: 0, uploadedBytes: 0 };
  let i = 0;
  for (const f of manifest.files) {
    i++;
    if (seen.has(f.sha256)) continue;
    seen.add(f.sha256);
    const dst = path.join(objects, f.sha256);
    if (sizeOf(dst) === f.size) { n.reused++; continue; }
    const old = path.join(updatesDir, "files", ...f.path.split("/"));
    if (sizeOf(old) === f.size && await sha256File(old) === f.sha256) {
      try { fs.linkSync(old, dst); } catch { await copyVerified(old, dst, f.sha256); }
      n.linked++;
      continue;
    }
    const src = path.join(publishDir, "objects", f.sha256);
    if (sizeOf(src) !== f.size) throw new Error(`the release folder is missing ${f.path} (objects/${f.sha256})`);
    await copyVerified(src, dst, f.sha256);
    n.uploaded++;
    n.uploadedBytes += f.size;
    if (n.uploaded % 50 === 0 || f.size > 50 * 1048576) log(`  uploaded ${n.uploaded} object(s), ${(n.uploadedBytes / 1048576).toFixed(0)} MB (file ${i} of ${manifest.files.length})`);
  }
  log(`release ${manifest.version}: ${seen.size} objects: ${n.reused} already there, ${n.linked} linked from the old layout, ` +
    `${n.uploaded} uploaded (${(n.uploadedBytes / 1048576).toFixed(1)} MB)`);
  return n;
}

module.exports = { stage };
if (require.main === module) {
  const [publishDir, updatesDir] = process.argv.slice(2);
  if (!publishDir || !updatesDir) { console.error("usage: node stage_objects.js <release publish dir> <updates dir>"); process.exit(2); }
  stage(publishDir, updatesDir).catch((e) => { console.error(e.message); process.exit(1); });
}
