// deploy/publish_release.ps1 itself, run by Windows PowerShell against temp
// folders: a publish that can't happen says so in red on its last lines,
// exits non-zero, and leaves a log file with everything it printed (node's
// output included). docs/SERVER_AUDIT_2.md, D2.
//
// Only failures are run here: a publish that succeeds needs a release signed
// with the launcher's release key (publish.test.js covers its steps).
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawnSync } = require("child_process");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }
if (process.platform !== "win32") { console.log("publish script tests: skipped (not Windows)"); process.exit(0); }

const t = fs.mkdtempSync(path.join(os.tmpdir(), "culling-publish-ps-"));
const root = path.join(t, "root"), www = path.join(t, "www"), logs = path.join(root, "logs");

function publish(release) {
  const r = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File",
    path.join(__dirname, "publish_release.ps1"), "-Release", release, "-Root", root, "-Www", www, "-Node", process.execPath],
    { encoding: "utf8", timeout: 120000 });
  const out = (r.stdout || "") + (r.stderr || "");
  const logFile = (out.match(/^Log: (.+)$/m) || [])[1];
  return { status: r.status, out, lines: out.trim().split(/\r?\n/), log: logFile && fs.existsSync(logFile.trim()) ? fs.readFileSync(logFile.trim(), "utf8") : null };
}

// A release folder signed with some key that isn't the launcher's.
function release(version) {
  const dir = path.join(t, "releases", version, "publish");
  fs.mkdirSync(path.join(dir, "objects"), { recursive: true });
  const body = Buffer.from(JSON.stringify({ version, files: [{ path: "a.bin", size: 1, sha256: "00".repeat(32), url: "objects/x" }] }));
  fs.writeFileSync(path.join(dir, "manifest.json"), body);
  const key = crypto.generateKeyPairSync("ed25519").privateKey;
  fs.writeFileSync(path.join(dir, "manifest.json.sig"), crypto.sign(null, body, key).toString("base64"));
  return dir;
}

try {
  test("a release folder that isn't there: red PUBLISH FAILED last, exit 1, and a log", () => {
    const r = publish(path.join(t, "releases", "1.3.99", "publish"));
    assert.strictEqual(r.status, 1, r.out);
    const last = r.lines.slice(-2).join("\n");
    assert.match(last, /^PUBLISH FAILED: nothing was published \(the live release is unchanged\): missing: /m, r.out);
    assert.match(r.lines[r.lines.length - 1], /^Log: .*publish-\d{8}-\d{6}\.log$/);
    assert.ok(r.log, "the log file exists");
    assert.match(r.log, /PUBLISH FAILED/);
    assert.doesNotMatch(r.out, /PUBLISHED/);
  });

  test("an unsigned release: refused at the signature, node's own message in the log, the live version named", () => {
    const updates = path.join(root, "updates");
    fs.mkdirSync(updates, { recursive: true });
    fs.writeFileSync(path.join(updates, "manifest.json"), JSON.stringify({ version: "1.3.9", files: [] }));
    const r = publish(release("1.3.10"));
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /== Signature/);
    assert.match(r.out, /PUBLISH FAILED: nothing was published \(1\.3\.9 is still live\): the release is not signed/);
    assert.match(r.log, /signature does not verify/, "node's stderr is in the log");
    assert.strictEqual(JSON.parse(fs.readFileSync(path.join(updates, "manifest.json"), "utf8")).version, "1.3.9", "untouched");
  });

  test("logs are kept to the newest 30", () => {
    for (let i = 0; i < 35; i++) fs.writeFileSync(path.join(logs, `publish-20200101-0000${String(i).padStart(2, "0")}.log`), "old");
    publish(path.join(t, "nowhere"));
    const left = fs.readdirSync(logs).filter((f) => /^publish-.*\.log$/.test(f));
    assert.strictEqual(left.length, 30);
    assert.ok(!left.includes("publish-20200101-000000.log"), "the oldest went");
  });
} finally {
  fs.rmSync(t, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
console.log("all %d publish script tests passed", passed);
