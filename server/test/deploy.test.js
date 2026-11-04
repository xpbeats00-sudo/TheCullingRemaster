// The VPS install (deploy/install_vps.ps1) must copy everything the server
// loads: a module it misses stops the service starting (server.js once needed
// showdown.js, which a fixed copy list didn't have). The installer copies every
// server/*.js except server.before-*.js backups, and named data files.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SERVER = path.join(__dirname, "..");
const INSTALL = fs.readFileSync(path.join(SERVER, "..", "deploy", "install_vps.ps1"), "utf8");
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

// The local modules server.js loads, followed through their own requires.
function localRequires(file, seen = new Set()) {
  if (seen.has(file)) return seen;
  seen.add(file);
  const src = fs.readFileSync(path.join(SERVER, file), "utf8");
  for (const m of src.matchAll(/require\(\s*['"]\.\/([\w.-]+?)(?:\.js)?['"]\s*\)/g)) localRequires(m[1] + ".js", seen);
  return seen;
}

test("every module the server loads is one the installer copies", () => {
  assert.ok(INSTALL.includes("-Filter '*.js'") && INSTALL.includes("-notlike '*.before-*'"),
    "install_vps.ps1 no longer copies every server/*.js");
  for (const f of localRequires("server.js")) {
    assert.ok(fs.existsSync(path.join(SERVER, f)), "missing " + f);
    assert.ok(!/\.before-/.test(f), f + " is excluded as a backup");
  }
});

test("every data file read from beside the code is copied", () => {
  const src = ["server.js", "lastbreath.js"].map((f) => fs.readFileSync(path.join(SERVER, f), "utf8")).join("\n");
  const files = [...src.matchAll(/path\.join\(__dirname,\s*'data',\s*'([\w.-]+)'\)/g)].map((m) => m[1]);
  assert.ok(files.includes("showdown.json"), "expected server.js to read data/showdown.json");
  for (const f of files) assert.ok(INSTALL.includes("server\\data\\" + f), "install_vps.ps1 doesn't copy data\\" + f);
});

console.log("all %d deploy tests passed", passed);
