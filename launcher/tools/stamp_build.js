// Stamp the launcher with its version and the Git commit it is built from
// (build-info.json, read by lib/build.js). Run before packaging an installer.
//
// usage: node tools/stamp_build.js
"use strict";

const fs = require("fs");
const path = require("path");
const { gitCommit, INFO } = require("../lib/build");

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"));
const commit = gitCommit(path.join(__dirname, ".."));
if (!commit) {
  console.error("not a Git checkout: can't name the build");
  process.exit(1);
}
const info = { version: pkg.version, commit, built: new Date().toISOString() };
fs.writeFileSync(INFO, JSON.stringify(info, null, 2) + "\n");
console.log(`build ${info.version} (${commit}) -> ${path.basename(INFO)}`);
