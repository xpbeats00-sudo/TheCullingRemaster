// Build a release manifest for the launcher's Game Sync.
//
// The release folder mirrors the game install: the whole game (Engine/,
// Victory/, the root files) for a full release, or only the Remaster's files.
// Each file is listed with its size and SHA-256 and served by content, from
// "objects/<sha256>" next to manifest.json: an object never changes once
// published (it can be cached for good, and a launcher mid-download never sees
// it replaced), identical files are stored once, and a new release only adds
// the objects that changed. servers.json (optional, in the release folder's
// parent) is copied in as the server list. Objects are hard-linked into the
// publish folder when it is on the same drive (a full release doesn't need its
// gigabytes twice), copied otherwise.
//
// The manifest is signed with the release key (tools/make_release_key.js):
// manifest.json.sig holds its Ed25519 signature, which launchers require.
//
// With --setup <TheCullingRemasterSetup.exe>, the launcher's setup is published
// as one more object and named in the manifest ("launcher": version, size,
// sha256, url), so older launchers update themselves (lib/selfupdate.js). The
// version is the one built into the setup exe, never assumed.
//
// usage: node tools/make_manifest.js <release dir> <version> [out dir] [private key] [--setup <setup.exe>]
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

function place(src, dst) {
  fs.rmSync(dst, { force: true });
  try { fs.linkSync(src, dst); } catch { fs.copyFileSync(src, dst); }
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
async function launcherEntry(setup, outDir) {
  if (!fs.existsSync(setup)) throw new Error("no setup at " + setup);
  const version = exeVersion(setup);
  const sha256 = await sha256File(setup);
  const dst = path.join(outDir, "objects", sha256);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (!fs.existsSync(dst)) place(setup, dst);
  return { version, size: fs.statSync(setup).size, sha256, url: "objects/" + sha256 };
}

async function main(...args) {
  let setup = null;
  const i = args.indexOf("--setup");
  if (i >= 0) { setup = args[i + 1]; args.splice(i, 2); if (!setup) throw new Error("--setup needs the setup exe"); }
  const [release, version, outDir = release && path.join(release, "..", "publish"),
    keyPath = process.env.CULLING_RELEASE_KEY || DEFAULT_KEY] = args;
  return build(release, version, outDir, keyPath, setup);
}

async function build(release, version, outDir, keyPath, setup) {
  if (!release || !version) {
    console.error("usage: node tools/make_manifest.js <release dir> <version> [out dir] [private key] [--setup <setup.exe>]");
    process.exit(2);
  }
  if (!fs.existsSync(keyPath)) throw new Error("no release key at " + keyPath + ": run node tools/make_release_key.js once");
  const key = crypto.createPrivateKey(fs.readFileSync(keyPath));
  const files = [];
  for (const rel of walk(release).sort()) {
    targetPath(release, rel);                    // the same path rules the launcher applies
    const src = path.join(release, ...rel.split("/"));
    const sha256 = await sha256File(src);
    const dst = path.join(outDir, "objects", sha256);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (!fs.existsSync(dst)) place(src, dst);
    files.push({ path: rel, size: fs.statSync(src).size, sha256, url: "objects/" + sha256 });
  }
  let servers = [];
  const serversFile = path.join(release, "..", "servers.json");
  if (fs.existsSync(serversFile)) servers = JSON.parse(fs.readFileSync(serversFile, "utf8"));
  const manifest = { version, released: new Date().toISOString(), files, servers };
  if (setup) manifest.launcher = await launcherEntry(setup, outDir);
  const body = Buffer.from(JSON.stringify(manifest, null, 1));
  fs.writeFileSync(path.join(outDir, "manifest.json"), body);
  fs.writeFileSync(path.join(outDir, "manifest.json.sig"), crypto.sign(null, body, key).toString("base64"));
  const objects = new Set(files.map((f) => f.sha256)).size;
  console.log(`manifest ${version}: ${files.length} files (${objects} objects), ${files.reduce((s, f) => s + f.size, 0)} bytes -> ${outDir}`);
  if (manifest.launcher) console.log(`launcher ${manifest.launcher.version}: ${manifest.launcher.size} bytes, object ${manifest.launcher.sha256}`);
}

module.exports = { main, exeVersion };
if (require.main === module) main(...process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
