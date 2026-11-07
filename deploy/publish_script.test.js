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

  test("a second publish while one runs is refused, and touches nothing", () => {
    const updates = path.join(root, "updates");
    fs.mkdirSync(updates, { recursive: true });
    fs.writeFileSync(path.join(updates, "manifest.json"), JSON.stringify({ version: "1.3.9", files: [] }));
    const fd = fs.openSync(path.join(root, "publish.lock"), "w");          // the publish already running holds it
    let r;
    try {
      r = publish(release("1.3.11"));
    } finally {
      fs.closeSync(fd);
    }
    assert.strictEqual(r.status, 1, r.out);
    assert.match(r.out, /PUBLISH FAILED: nothing was published \(1\.3\.9 is still live\): another publish is running/);
    assert.doesNotMatch(r.out, /== Signature/, "stopped before anything");
    // Once it is over, the next publish gets past the lock (to the signature check, here).
    const again = publish(release("1.3.11"));
    assert.match(again.out, /== Signature/, again.out);
    assert.ok(!fs.existsSync(path.join(root, "publish.lock")), "the lock goes when the publish ends");
  });

  test("every stage step uses the manifest that was verified, and the website changes only after going live", () => {
    const ps = fs.readFileSync(path.join(__dirname, "publish_release.ps1"), "utf8").replace(/\r\n/g, "\n");
    const calls = ps.split("\n").filter((l) => /stage_objects\.js/.test(l) && /Invoke-Node/.test(l));
    assert.strictEqual(calls.length, 3, calls.join("\n"));
    for (const c of calls) assert.match(c, /--manifest \$stagedManifest --sig \$stagedSig/, c);
    const goLive = ps.indexOf("Step 'Go live'"), website = ps.indexOf("Step 'Website setup'"), check = ps.indexOf("Step 'Check");
    assert.ok(goLive > 0 && website > goLive && check > website, "Go live, then the website, then the check");
    assert.ok(ps.indexOf("$live = $true") < website, "a website failure reports the release as live");
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
