// Build a release manifest for the launcher's Game Sync.
//
// The release folder mirrors the game install: the whole game (Engine/,
// Victory/, the root files) for a full release, or only the Remaster's files.
// Each file is listed with its size and SHA-256 and served from
// "files/<path>" next to manifest.json; servers.json (optional, in the release
// folder's parent) is copied in as the server list. Files are hard-linked into
// the publish folder when it is on the same drive (a full release doesn't
// need its gigabytes twice), copied otherwise.
//
// usage: node tools/make_manifest.js <release dir> <version> [out dir]
//   writes <out dir>/manifest.json and <out dir>/files/...

"use strict";

const fs = require("fs");
const path = require("path");
const { sha256File, targetPath, STATE_DIR } = require("../lib/sync");

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

async function main(release, version, outDir = path.join(release, "..", "publish")) {
  if (!release || !version) {
    console.error("usage: node tools/make_manifest.js <release dir> <version> [out dir]");
    process.exit(2);
  }
  const files = [];
  for (const rel of walk(release).sort()) {
    targetPath(release, rel);                    // the same path rules the launcher applies
    const src = path.join(release, ...rel.split("/"));
    const dst = path.join(outDir, "files", ...rel.split("/"));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    place(src, dst);
    files.push({ path: rel, size: fs.statSync(src).size, sha256: await sha256File(src), url: "files/" + rel });
  }
  let servers = [];
  const serversFile = path.join(release, "..", "servers.json");
  if (fs.existsSync(serversFile)) servers = JSON.parse(fs.readFileSync(serversFile, "utf8"));
  const manifest = { version, released: new Date().toISOString(), files, servers };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 1));
  console.log(`manifest ${version}: ${files.length} files, ${files.reduce((s, f) => s + f.size, 0)} bytes -> ${outDir}`);
}

module.exports = { main };
if (require.main === module) main(...process.argv.slice(2)).catch((e) => { console.error(e.message); process.exit(1); });
