// Backups of the data folder (C:\culling\data on the VPS).
//
// A snapshot is a folder <backups>/<label>-<UTC time>/ ("daily-20261105T040000Z")
// holding a copy of every data file at the top of the data folder (profiles,
// accounts, sessions, friends, match tickets, Showdown series, activity, the
// level curve, the catalog and the IP-hash secret: *.json, *.txt, *.ini; never
// temp files, logs or other backups) and backup.json, which lists each file
// with its size and SHA-256. It is written as <name>.partial and renamed when
// complete, so a snapshot folder is always whole.
//
// - daily: the server takes one when the newest daily snapshot is older than a
//   day (CULLING_BACKUP_EVERY_MS), right after writing everything it holds to
//   disk, and keeps the newest 14 (CULLING_BACKUP_KEEP).
// - pre-update: deploy/install_vps.ps1 takes one before it replaces the code
//   ("node backup.js snapshot <data> <backups> pre-update 10").
//
// Restoring (docs/SERVER_AUDIT_2.md): stop the service, "node backup.js verify
// <snapshot>", copy the snapshot's files over the data folder's, start it.
//
// usage: node backup.js snapshot <data dir> <backups dir> [label] [keep]
//        node backup.js verify <snapshot dir>
//        node backup.js list <backups dir> [label]
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const DATA_FILE = /\.(json|txt|ini)$/i;
const NOT_DATA = /\.tmp|\.unreadable-|\.partial$/i;
const LABEL = /^[a-z][a-z0-9-]{0,30}$/;
const NAME = (label) => new RegExp("^" + label + "-(\\d{8}T\\d{6}Z)(-\\d+)?$");

const sha256 = (buf) => crypto.createHash("sha256").update(buf).digest("hex");
// 2026-11-05T04:00:00.123Z -> 20261105T040000Z (sorts as it reads).
const stampOf = (ms) => new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z");
const msOf = (stamp) => Date.parse(stamp.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, "$1-$2-$3T$4:$5:$6Z"));

function checkLabel(label) {
  if (!LABEL.test(label)) throw new Error("invalid backup label: " + JSON.stringify(label));
  return label;
}

// The snapshots of `label`, oldest first: [{ name, dir, at }].
function list(backupDir, label = "daily") {
  checkLabel(label);
  let names = [];
  try { names = fs.readdirSync(backupDir); } catch { return []; }
  const re = NAME(label);
  return names.map((name) => ({ name, m: re.exec(name) })).filter((x) => x.m)
    .map((x) => ({ name: x.name, dir: path.join(backupDir, x.name), at: msOf(x.m[1]) }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

// When the newest snapshot of `label` was taken (ms), or null.
function latestAt(backupDir, label = "daily") {
  const all = list(backupDir, label);
  return all.length ? all[all.length - 1].at : null;
}

// The data files a snapshot copies.
function dataFiles(dataDir) {
  return fs.readdirSync(dataDir, { withFileTypes: true })
    .filter((d) => d.isFile() && DATA_FILE.test(d.name) && !NOT_DATA.test(d.name))
    .map((d) => d.name).sort();
}

// Takes a snapshot; keeps the newest `keep` of its label. Returns
// { dir, files, bytes, removed }.
function snapshot(dataDir, backupDir, label = "daily", { keep = 14, now = Date.now } = {}) {
  checkLabel(label);
  fs.mkdirSync(backupDir, { recursive: true });
  const base = label + "-" + stampOf(now());
  let name = base;
  for (let i = 2; fs.existsSync(path.join(backupDir, name)); i++) name = base + "-" + i;
  const dir = path.join(backupDir, name);
  const partial = dir + ".partial";
  fs.rmSync(partial, { recursive: true, force: true });
  fs.mkdirSync(partial);
  const files = [];
  let bytes = 0;
  try {
    for (const f of dataFiles(dataDir)) {
      const to = path.join(partial, f);
      fs.copyFileSync(path.join(dataDir, f), to);
      const buf = fs.readFileSync(to);
      files.push({ name: f, size: buf.length, sha256: sha256(buf) });
      bytes += buf.length;
    }
    fs.writeFileSync(path.join(partial, "backup.json"), JSON.stringify({ label, at: new Date(now()).toISOString(),
      from: path.resolve(dataDir), files }, null, 1));
    fs.renameSync(partial, dir);
  } catch (e) {
    fs.rmSync(partial, { recursive: true, force: true });
    throw e;
  }
  return { dir, files: files.length, bytes, removed: prune(backupDir, label, keep) };
}

// Removes all but the newest `keep` snapshots of `label` (and any unfinished
// one a crash left). Returns the names removed.
function prune(backupDir, label = "daily", keep = 14) {
  checkLabel(label);
  const removed = [];
  const all = list(backupDir, label);
  for (const s of all.slice(0, Math.max(0, all.length - Math.max(1, keep)))) {
    fs.rmSync(s.dir, { recursive: true, force: true });
    removed.push(s.name);
  }
  let names = [];
  try { names = fs.readdirSync(backupDir); } catch { /* none */ }
  for (const n of names) {
    if (n.startsWith(label + "-") && n.endsWith(".partial")) fs.rmSync(path.join(backupDir, n), { recursive: true, force: true });
  }
  return removed;
}

// Checks a snapshot against its backup.json: [] when every file is there with
// its size and SHA-256, else the problems.
function verify(dir) {
  let meta;
  try { meta = JSON.parse(fs.readFileSync(path.join(dir, "backup.json"), "utf8")); } catch (e) { return ["backup.json: " + e.message]; }
  const problems = [];
  for (const f of Array.isArray(meta.files) ? meta.files : []) {
    let buf;
    try { buf = fs.readFileSync(path.join(dir, path.basename(f.name))); } catch { problems.push(f.name + ": missing"); continue; }
    if (buf.length !== f.size || sha256(buf) !== f.sha256) problems.push(f.name + ": changed since the backup");
    else if (/\.json$/i.test(f.name)) {
      try { JSON.parse(buf.toString("utf8")); } catch (e) { problems.push(f.name + ": not valid JSON (" + e.message + ")"); }
    }
  }
  if (!Array.isArray(meta.files) || !meta.files.length) problems.push("backup.json lists no files");
  return problems;
}

module.exports = { snapshot, prune, list, latestAt, verify, dataFiles, stampOf };

if (require.main === module) {
  const [cmd, a, b, label, keep] = process.argv.slice(2);
  try {
    if (cmd === "snapshot" && a && b) {
      const r = snapshot(a, b, label || "daily", { keep: keep ? parseInt(keep, 10) : 14 });
      const problems = verify(r.dir);
      if (problems.length) throw new Error("the snapshot doesn't verify: " + problems.join("; "));
      console.log(`backup ${r.dir}: ${r.files} files, ${(r.bytes / 1048576).toFixed(1)} MB, verified` +
        (r.removed.length ? `; removed ${r.removed.length} older` : ""));
    } else if (cmd === "verify" && a) {
      const problems = verify(a);
      if (problems.length) { for (const p of problems) console.error("  " + p); throw new Error(problems.length + " problem(s) in " + a); }
      console.log(a + ": every file is as backed up");
    } else if (cmd === "list" && a) {
      for (const s of list(a, b || "daily")) console.log(s.name);
    } else {
      console.error("usage: node backup.js snapshot <data dir> <backups dir> [label] [keep]\n" +
        "       node backup.js verify <snapshot dir>\n       node backup.js list <backups dir> [label]");
      process.exit(2);
    }
  } catch (e) {
    console.error("backup failed: " + e.message);
    process.exit(1);
  }
}
