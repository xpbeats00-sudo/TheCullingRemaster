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
// A release that drops files the live release has is refused unless
// --allow-removals is given: launchers delete every file a new release no
// longer lists, so a release built from a wrong or empty folder would remove
// the game from every player's PC. A release with no files is always refused.
//
// usage: node deploy/stage_objects.js [--allow-removals] <release publish dir> <updates dir>
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

function readLive(updatesDir) {
  try { return JSON.parse(fs.readFileSync(path.join(updatesDir, "manifest.json"), "utf8")); } catch { return null; /* first publish */ }
}

// Refuses a release that would delete files from players' installs (see the
// top of this file), unless removals are explicitly allowed.
function checkRemovals(next, live, allowRemovals) {
  if (!Array.isArray(next.files) || next.files.length === 0) throw new Error(`release ${next.version} lists no files: refusing it`);
  if (!live || !Array.isArray(live.files)) return [];
  const keep = new Set(next.files.map((f) => f.path));
  const removed = live.files.filter((f) => !keep.has(f.path)).map((f) => f.path);
  if (removed.length && !allowRemovals) {
    throw new Error(`release ${next.version} removes ${removed.length} of the ${live.files.length} files of the live release ${live.version} ` +
      `(${removed.slice(0, 5).join(", ")}${removed.length > 5 ? ", ..." : ""}); every launcher would delete them. ` +
      "Nothing was published. If that is intended, publish again with --allow-removals (-AllowRemovals).");
  }
  return removed;
}

async function stage(publishDir, updatesDir, log = console.log, opts = {}) {
  const manifest = JSON.parse(fs.readFileSync(path.join(publishDir, "manifest.json"), "utf8"));
  checkRemovals(manifest, readLive(updatesDir), opts.allowRemovals);
  const objects = path.join(updatesDir, "objects");
  fs.mkdirSync(objects, { recursive: true });
  const seen = new Set();
  const n = { reused: 0, linked: 0, uploaded: 0, uploadedBytes: 0 };
  let i = 0;
  // The launcher setup the release offers (self-update) is an object too.
  const all = manifest.launcher ? manifest.files.concat([{ path: "(launcher setup " + manifest.launcher.version + ")",
    size: manifest.launcher.size, sha256: manifest.launcher.sha256 }]) : manifest.files;
  for (const f of all) {
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
    if (n.uploaded % 50 === 0 || f.size > 50 * 1048576) log(`  uploaded ${n.uploaded} object(s), ${(n.uploadedBytes / 1048576).toFixed(0)} MB (file ${i} of ${all.length})`);
  }
  log(`release ${manifest.version}: ${seen.size} objects: ${n.reused} already there, ${n.linked} linked from the old layout, ` +
    `${n.uploaded} uploaded (${(n.uploadedBytes / 1048576).toFixed(1)} MB)`);
  return n;
}

const MB = (b) => (b / 1048576).toFixed(1) + " MB";

// What publishing this release changes, compared with the release live on the
// VPS (<updates>/manifest.json), and what has to come over the Remote Desktop
// drive: objects the VPS doesn't have yet. Nothing is read from the release
// folder but its manifest, so this is instant.
function plan(publishDir, updatesDir, log = console.log, opts = {}) {
  const next = JSON.parse(fs.readFileSync(path.join(publishDir, "manifest.json"), "utf8"));
  const live = readLive(updatesDir);
  const objects = path.join(updatesDir, "objects");
  // A file still in the old files\ layout is linked, not uploaded (staging
  // checks its hash; here only its size, to stay instant).
  const paths = new Map();
  for (const f of next.files) if (!paths.has(f.sha256)) paths.set(f.sha256, f.path);
  const oldLayout = (sha, size) => paths.has(sha) && sizeOf(path.join(updatesDir, "files", ...paths.get(sha).split("/"))) === size;
  const p = describe(next, live, (sha, size) => sizeOf(path.join(objects, sha)) === size || oldLayout(sha, size), log);
  checkRemovals(next, live, opts.allowRemovals);
  return p;
}

// The difference between the live release and the next one, and the objects
// `has` says the server is missing (what a publish uploads).
function describe(next, live, has, log = console.log) {
  const before = new Map(live ? live.files.map((f) => [f.path, f]) : []);
  const changed = [], added = [];
  for (const f of next.files) {
    const old = before.get(f.path);
    if (!old) added.push(f);
    else if (old.sha256 !== f.sha256) changed.push(f);
    before.delete(f.path);
  }
  const removed = [...before.values()];
  const want = new Map();
  for (const f of next.files) want.set(f.sha256, f.size);
  if (next.launcher) want.set(next.launcher.sha256, next.launcher.size);
  let uploadBytes = 0, uploadCount = 0;
  for (const [sha, size] of want) if (!has(sha, size)) { uploadCount++; uploadBytes += size; }

  log(`release ${live ? live.version : "(none)"} -> ${next.version}: ${changed.length} changed, ${added.length} added, ${removed.length} removed`);
  const show = (tag, list) => list.slice(0, 20).forEach((f) => log(`  ${tag} ${f.path} (${MB(f.size)})`));
  show("changed", changed);
  show("added  ", added);
  show("removed", removed);
  if (changed.length + added.length + removed.length > 60) log("  ...");
  if (next.launcher) {
    const was = live && live.launcher ? live.launcher.version : "none";
    log(`  launcher ${was} -> ${next.launcher.version}` + (live && live.launcher && live.launcher.sha256 === next.launcher.sha256 ? " (unchanged)" : ""));
  }
  log(`to upload: ${uploadCount} object(s), ${MB(uploadBytes)}; everything else is already on the VPS`);
  return { from: live ? live.version : null, to: next.version, changed, added, removed, uploadCount, uploadBytes };
}

// The website's setup and launcher.json, from the setup object the release
// offers (already staged and hash-checked on the VPS), so the setup never
// crosses the Remote Desktop drive a second time.
async function publishSetup(publishDir, updatesDir, downloadDir, log = console.log) {
  const m = JSON.parse(fs.readFileSync(path.join(publishDir, "manifest.json"), "utf8"));
  const l = m.launcher;
  if (!l) throw new Error("this release doesn't offer a launcher (no \"launcher\" entry)");
  const obj = path.join(updatesDir, "objects", l.sha256);
  if (sizeOf(obj) !== l.size) throw new Error("the launcher object isn't staged: " + obj);
  fs.mkdirSync(downloadDir, { recursive: true });
  const setup = path.join(downloadDir, "TheCullingRemasterSetup.exe");
  await copyVerified(obj, setup + ".new", l.sha256);
  fs.renameSync(setup + ".new", setup);
  const info = { version: l.version, size: l.size, sha256: l.sha256,
    published: new Date().toISOString().replace(/\.\d+Z$/, "Z"), url: "/download/TheCullingRemasterSetup.exe" };
  fs.writeFileSync(path.join(downloadDir, "launcher.json.new"), JSON.stringify(info));
  fs.renameSync(path.join(downloadDir, "launcher.json.new"), path.join(downloadDir, "launcher.json"));
  log(`website: setup ${l.version} (${MB(l.size)}) and launcher.json written`);
  return info;
}

module.exports = { stage, plan, describe, publishSetup, checkRemovals };
if (require.main === module) {
  const all = process.argv.slice(2);
  const opts = { allowRemovals: all.includes("--allow-removals") };
  const args = all.filter((a) => a !== "--allow-removals");
  const usage = "usage: node stage_objects.js [--plan] [--allow-removals] <release publish dir> <updates dir>\n" +
    "       node stage_objects.js --setup <release publish dir> <updates dir> <website download dir>";
  const run = (p) => Promise.resolve().then(p).catch((e) => { console.error(e.message); process.exit(1); });
  if (args[0] === "--plan") { if (args.length !== 3) { console.error(usage); process.exit(2); } run(() => plan(args[1], args[2], console.log, opts)); }
  else if (args[0] === "--setup") { if (args.length !== 4) { console.error(usage); process.exit(2); } run(() => publishSetup(args[1], args[2], args[3])); }
  else { if (args.length !== 2) { console.error(usage); process.exit(2); } run(() => stage(args[0], args[1], console.log, opts)); }
}
