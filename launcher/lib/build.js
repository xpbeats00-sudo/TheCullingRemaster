// The launcher's version and build name, shown to players and in bug reports.
//
// A packaged launcher carries build-info.json (tools/stamp_build.js writes the
// version and the Git commit it was built from); a development run asks Git.
"use strict";

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const INFO = path.join(__dirname, "..", "build-info.json");

function gitCommit(dir) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: dir, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return null;
  }
}

// { version, commit, label: "v1.1.0 · build abc1234" }
function info(version) {
  let stamped = {};
  try { stamped = JSON.parse(fs.readFileSync(INFO, "utf8")); } catch { /* development run */ }
  const v = stamped.version || version;
  const commit = stamped.commit || gitCommit(path.dirname(INFO)) || "dev";
  return { version: v, commit, label: `v${v} · build ${commit}` };
}

module.exports = { info, gitCommit, INFO };
