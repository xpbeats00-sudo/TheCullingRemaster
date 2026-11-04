// Build a release manifest for the launcher's Game Sync.
//
// The release folder mirrors the game install (e.g. release/Victory/Content/
// Paks/LocalServer-WindowsClient_P.pak). Each file is listed with its size and
// SHA-256 and served from "files/<path>" next to manifest.json; servers.json
// (optional, in the release folder's parent) is copied in as the server list.
//
// usage: node tools/make_manifest.js <release dir> <version> [out dir]
//   writes <out dir>/manifest.json and copies files to <out dir>/files/...

"use strict";

const fs = require("fs");
const path = require("path");
const { sha256File } = require("../lib/sync");

function walk(dir, base = dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    if (e.isDirectory()) walk(full, base, out);
    else out.push(path.relative(base, full).split(path.sep).join("/"));
  }
  return out;
}

async function main(release, version, outDir = path.join(release, "..", "publish")) {
  if (!release || !version) {
    console.error("usage: node tools/make_manifest.js <release dir> <version> [out dir]");
    process.exit(2);
  }
  const files = [];
  for (const rel of walk(release).sort()) {
    if (!rel.startsWith("Victory/")) throw new Error("release files must live under Victory/: " + rel);
    const src = path.join(release, ...rel.split("/"));
    const dst = path.join(outDir, "files", ...rel.split("/"));
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
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
