// deploy/install_vps.ps1 and the other VPS scripts, checked without running
// them (they need administrator rights and the real service): every script
// parses, and an update keeps the order that makes it safe (docs/SERVER_AUDIT_2.md, D3):
// the new code is built and checked beside the running one, the service is
// stopped only then, the data is backed up before the swap, and a new code that
// doesn't answer /health is swapped back out.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

const INSTALL = fs.readFileSync(path.join(__dirname, "install_vps.ps1"), "utf8").replace(/\r\n/g, "\n");
// Position of a piece of the script, which must be there exactly once.
function at(text) {
  const i = INSTALL.indexOf(text);
  assert.ok(i >= 0, "install_vps.ps1 no longer has: " + text);
  assert.strictEqual(INSTALL.indexOf(text, i + 1), -1, "install_vps.ps1 has this more than once: " + text);
  return i;
}

if (process.platform === "win32") {
  test("every deploy PowerShell script parses", () => {
    const ps = "$bad = 0; foreach ($f in Get-ChildItem -Path $env:DEPLOY_DIR -Filter *.ps1) { $e = $null; " +
      "[void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$null, [ref]$e); " +
      "foreach ($x in $e) { $bad++; Write-Output ($f.Name + ':' + $x.Extent.StartLineNumber + ': ' + $x.Message) } }; exit $bad";
    const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", ps],
      { encoding: "utf8", env: Object.assign({}, process.env, { DEPLOY_DIR: __dirname }) });
    assert.strictEqual(r.status, 0, r.stdout + r.stderr);
  });
}

test("the new code is built and checked in app.new while the old one runs", () => {
  const build = at("Step 'Server code (built beside the running one)'");
  const pushNew = at("Push-Location $appNew");
  const npm = at("Invoke-Native 'npm ci'");
  const check = at("Invoke-Native 'checking the new code'");
  const stop = at("Step \"Service $Service (stopped for the swap)\"");
  assert.ok(build < pushNew && pushNew < npm && npm < check && check < stop, "npm ci and the checks must come before the stop");
  // Nothing copies into the live app folder before the swap.
  assert.ok(!/Copy-Item[^\n]*Join-Path \$app '/.test(INSTALL.slice(0, stop)), "code copied into the running app");
});

test("the data is backed up (verified) after the stop and before the swap", () => {
  const stop = at("Step \"Service $Service (stopped for the swap)\"");
  const backup = at("server\\backup.js') snapshot $data $backups pre-update 10");
  const swap = at("Move-Item $appNew $app");
  assert.ok(stop < backup && backup < swap);
});

test("a new code that doesn't answer /health is rolled back, and the result is said in one line", () => {
  const start = at("Start-Service $Service\n    if (-not (Wait-Healthy $StartTimeoutSeconds))");
  const rollback = at("Move-Item $appPrevious $app\n        if ($snapshot");
  assert.ok(start < rollback);
  at("Write-Host \"SERVER UPDATED in $seconds s");
  at("Write-Host \"UPDATE FAILED: $why. $outcome.");
  at("exit $code");
  assert.match(INSTALL, /Start-Transcript -Path \$log/);
});

console.log("all %d install script checks passed", passed);
