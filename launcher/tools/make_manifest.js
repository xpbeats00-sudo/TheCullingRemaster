// Build a release manifest for the launcher's Game Sync.
//
// The release folder mirrors the game install: the whole game (Engine/,
// Victory/, the root files) for a full release, or only the Remaster's files.
// Each file is listed with its size and SHA-256 and served by content, from
// "objects/<sha256>" next to manifest.json: an object never changes once
// published (it can be cached for good, and a launcher mid-download never sees
// it replaced), identical files are stored once, and a new release only adds
// the objects that changed. servers.json (optional, in the release folder's
// parent) is copied in as the server list. Objects of release files are
// hard-linked into the publish folder when it is on the same drive (a full
// release doesn't need its gigabytes twice), copied otherwise; anything from
// outside the release folder (the launcher setup) is always copied, and an
// object already there is re-hashed before it is reused (place, putObject).
//
// The manifest is signed with the release key (tools/make_release_key.js):
// manifest.json.sig holds its Ed25519 signature, which launchers require.
//
// With --setup <TheCullingRemasterSetup.exe>, the launcher's setup is published
// as one more object and named in the manifest ("launcher": version, size,
// sha256, url), so older launchers update themselves (lib/selfupdate.js). The
// version is the one built into the setup exe, never assumed.
//
// With --build <build.json>, that object is the manifest's "build" (the commit
// and checks make_release.py recorded); launchers ignore it, the publish reads it.
//
// usage: node tools/make_manifest.js <release dir> <version> [out dir] [private key] [--setup <setup.exe>] [--build <build.json>]
//   writes <out dir>/manifest.json(.sig) and <out dir>/objects/...
//   key: the argument, else CULLING_RELEASE_KEY, else <home>/.culling-release/release_ed25519.pem

"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { execFileSync } = require("child_process");
const { sha256File, targetPath, STATE_DIR } = require("../lib/sync");
const { DEFAULT_KEY } = require("./make_release_key");

// Release files, skipping Game Sync's own state and unfinished downloads.
function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === STATE_DIR || e.name.endsWith(".part")) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

// Whether file is inside dir.
function inside(dir, file) {
  const rel = path.relative(path.resolve(dir), path.resolve(file));
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// An object is immutable once published, so it may only share its disk file
// (a hard link) with a release file: those are hard links of the read-only
// game install or written fresh for this release. Anything else, the launcher
// setup in launcher/dist above all, is rebuilt in place later, and a hard link
// would change the published object with it; it is copied. The new object is
// made beside its final name and swapped in, so a stale one is replaced whole.
function place(src, dst, link) {
  const tmp = dst + ".tmp";
  fs.rmSync(tmp, { force: true });
  if (link) { try { fs.linkSync(src, tmp); } catch { fs.copyFileSync(src, tmp); } } else fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dst);
}

// objects/<sha256> for src: an existing object is hashed again before it is
// reused (through the hash cache, so only one whose file changed since it was
// last hashed is read) and replaced when it no longer matches its name.
async function putObject(src, sha256, outDir, cache, link) {
  const dst = path.join(outDir, "objects", sha256);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (fs.existsSync(dst)) {
    if (await cache.sha256(dst) === sha256) return dst;
    console.log(`objects/${sha256} no longer matches its name (changed on disk): replaced`);
  }
  place(src, dst, link);
  return dst;
}

// SHA-256s of files hashed before, keyed by the file's identity (volume and
// file index: a release's game files are hard links of one install) and
// stamped with its size and modification time. A new release then hashes only
// what changed (the patch pak, the setup) instead of all 5.6 GB. The cache
// lives next to the releases (CULLING_HASH_CACHE overrides; "off" disables it).
function hashCache(file) {
  let saved = {};
  if (file) { try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* none yet */ } }
  const now = {};
  const n = { hits: 0, hashed: 0 };
  return {
    async sha256(src) {
      const st = fs.statSync(src, { bigint: true });
      const key = st.dev + ":" + st.ino;
      const stamp = st.size + ":" + st.mtimeNs;
      // Hashed already in this run (an object hard-linked to a release file), or in an earlier one.
      const hit = now[key] || (file && saved[key]);
      if (hit && hit.stamp === stamp && /^[0-9a-f]{64}$/.test(hit.sha256)) { n.hits++; now[key] = hit; return hit.sha256; }
      const sha256 = await sha256File(src);
      n.hashed++;
      now[key] = { stamp, sha256 };
      return sha256;
    },
    save() {
      if (!file) return;
      fs.writeFileSync(file + ".tmp", JSON.stringify(now));
      fs.renameSync(file + ".tmp", file);
    },
    stats: n
  };
}

// The version built into a Windows exe (electron-builder writes the app's).
function exeVersion(file) {
  const v = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
    "(Get-Item -LiteralPath $env:CULLING_EXE).VersionInfo.ProductVersion"],
  { env: Object.assign({}, process.env, { CULLING_EXE: file }), encoding: "utf8" }).trim();
  if (!/^\d+(\.\d+){1,3}$/.test(v)) throw new Error("no version in " + file + " (got " + JSON.stringify(v) + ")");
  return v;
}

// The setup as a published object.
async function launcherEntry(setup, outDir, cache) {
  if (!fs.existsSync(setup)) throw new Error("no setup at " + setup);
  const version = exeVersion(setup);
  const sha256 = await cache.sha256(setup);
  await putObject(setup, sha256, outDir, cache, false);      // a copy: launcher/dist is rebuilt in place
  return { version, size: fs.statSync(setup).size, sha256, url: "objects/" + sha256 };
}

async function main(...args) {
  const option = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return null;
    const v = args[i + 1];
    args.splice(i, 2);
    if (!v) throw new Error(name + " needs a value");
    return v;
  };
  const setup = option("--setup");
  const buildFile = option("--build");
  const info = buildFile ? JSON.parse(fs.readFileSync(buildFile, "utf8")) : null;
  const [release, version, outDir = release && path.join(release, "..", "publish"),
    keyPath = process.env.CULLING_RELEASE_KEY || DEFAULT_KEY] = args;
  return build(release, version, outDir, keyPath, setup, info);
}

async function build(release, version, outDir, keyPath, setup, info) {
  if (!release || !version) {
    console.error("usage: node tools/make_manifest.js <release dir> <version> [out dir] [private key] [--setup <setup.exe>] [--build <build.json>]");
    process.exit(2);
  }
  if (!fs.existsSync(keyPath)) throw new Error("no release key at " + keyPath + ": run node tools/make_release_key.js once");
  const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
  const cacheFile = process.env.CULLING_HASH_CACHE === "off" ? null
    : process.env.CULLING_HASH_CACHE || path.join(outDir, "..", ".hashcache.json");
  const cache = hashCache(cacheFile);
  const files = [];
  for (const rel of walk(release).sort()) {
    targetPath(release, rel);                    // the same path rules the launcher applies
    const src = path.join(release, ...rel.split("/"));
    const sha256 = await cache.sha256(src);
    await putObject(src, sha256, outDir, cache, inside(release, src));
    files.push({ path: rel, size: fs.statSync(src).size, sha256, url: "objects/" + sha256 });
  }
  let servers = [];
  const serversFile = path.join(release, "..", "servers.json");
  if (fs.existsSync(serversFile)) servers = JSON.parse(fs.readFileSync(serversFile, "utf8"));
  const manifest = { version, released: new Date().toISOString(), files, servers };
  // What the release was built from (patch/make_release.py: commit, gate, ...); launchers ignore it.
  if (info) manifest.build = info;
  if (setup) manifest.launcher = await launcherEntry(setup, outDir, cache);
  cache.save();
  const body = Buffer.from(JSON.stringify(manifest, null, 1));
  fs.writeFileSync(path.join(outDir, "manifest.json"), body);
  fs.writeFileSync(path.join(outDir, "manifest.json.sig"), crypto.sign(null, body, key).toString("base64"));
  const objects = new Set(files.map((f) => f.sha256)).size;
  console.log(`manifest ${version}: ${files.length} files (${objects} objects), ${files.reduce((s, f) => s + f.size, 0)} bytes -> ${outDir}`);
  if (manifest.launcher) console.log(`launcher ${manifest.launcher.version}: ${manifest.launcher.size} bytes, object ${manifest.launcher.sha256}`);
  console.log(`hashed ${cache.stats.hashed} file(s), ${cache.stats.hits} unchanged since the last build (hash cache)`);
}

module.exports = { main, exeVersion, hashCache };
if (require.main === module) main(...process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
