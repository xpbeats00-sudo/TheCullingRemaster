// On the build PC: what publishing a release would change, compared with the
// release live on the server, and how much the publish will upload (objects
// the live release doesn't have). Run by make_release.py after a build.
//
// usage: node deploy/diff_release.js <release publish dir> [live base URL]
//   (default https://xplab.shop:8443/remaster/)
"use strict";

const fs = require("fs");
const path = require("path");
const { describe } = require("./stage_objects");

async function diff(publishDir, base = "https://xplab.shop:8443/remaster/", log = console.log) {
  const next = JSON.parse(fs.readFileSync(path.join(publishDir, "manifest.json"), "utf8"));
  const res = await fetch(new URL("manifest.json", base.endsWith("/") ? base : base + "/"),
    { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(60000) });
  if (!res.ok) throw new Error(`live manifest: HTTP ${res.status}`);
  const live = await res.json();
  // Objects the live release already has are on the server (older ones may
  // be too; this errs on the side of a bigger estimate).
  const there = new Set(live.files.map((f) => f.sha256));
  if (live.launcher) there.add(live.launcher.sha256);
  return describe(next, live, (sha) => there.has(sha), log);
}

module.exports = { diff };
if (require.main === module) {
  const [publishDir, base] = process.argv.slice(2);
  if (!publishDir) { console.error("usage: node deploy/diff_release.js <release publish dir> [live base URL]"); process.exit(2); }
  diff(publishDir, base).catch((e) => { console.error("couldn't compare with the live release: " + e.message); process.exit(1); });
}
