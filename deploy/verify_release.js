// Check a release's manifest signature with the launcher's release key (the
// same check every launcher makes), before publishing it.
//
// usage: node deploy/verify_release.js <manifest.json> <manifest.json.sig>
"use strict";

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const [manifest, sig] = process.argv.slice(2);
const key = require(path.join(__dirname, "..", "launcher", "lib", "releasekey.js"));
const body = fs.readFileSync(manifest);
let ok = false;
try { ok = crypto.verify(null, body, key, Buffer.from(fs.readFileSync(sig, "utf8").trim(), "base64")); } catch { ok = false; }
if (!ok) {
  console.error("signature does not verify");
  process.exit(1);
}
const m = JSON.parse(body);
const gb = m.files.reduce((s, f) => s + f.size, 0) / 1073741824;
console.log(`release ${m.version}: ${m.files.length} files, ${gb.toFixed(2)} GB, signature ok`);
