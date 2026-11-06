// "Publish Release.bat" and "Update Culling Server.bat", run for real by
// cmd.exe in a temp folder with stand-ins for fltmc (already administrator),
// git (its "pull" can replace the bat, as a real pull does) and powershell
// (records how it was called, exits with a chosen code).
//
// The bug these guard against (docs/SERVER_AUDIT_2.md, D1): cmd reads a batch
// file a line at a time from where it stopped, so a bat that kept running
// after a "git pull" changed it resumed at the old byte position in the new
// file, mid-line, and the publish never ran. Both earlier updates of
// "Publish Release.bat" did that; the test reproduces it from the old files
// kept in deploy/fixtures.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const FIX = path.join(__dirname, "fixtures");
let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

if (process.platform !== "win32") { console.log("bats tests: skipped (not Windows)"); process.exit(0); }

const crlf = (s) => s.replace(/\r?\n/g, "\r\n");
const read = (f) => crlf(fs.readFileSync(f, "utf8"));

// The stand-in tools (fixtures/fake_tool.cs), built once with the .NET
// Framework's C# compiler, which every Windows has.
const TOOLS = fs.mkdtempSync(path.join(os.tmpdir(), "culling-fake-tools-"));
{
  const csc = path.join(process.env.WINDIR || "C:\Windows", "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe");
  const exe = path.join(TOOLS, "fake_tool.exe");
  const r = spawnSync(csc, ["/nologo", "/out:" + exe, path.join(FIX, "fake_tool.cs")], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("building fake_tool.exe failed: " + (r.stdout || "") + (r.stderr || "") + (r.error || ""));
}
process.on("exit", () => { try { fs.rmSync(TOOLS, { recursive: true, force: true }); } catch { /* in use */ } });

// Runs `bat` (its text) as <name> in a fresh folder. `next`: the text a
// "git pull" puts in its place. Returns { status, out, ps: [powershell calls], pulls }.
function run(name, bat, { next = null, args = "", gitFails = false, psExit = 0, latest = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "culling-bat-"));
  try {
    fs.writeFileSync(path.join(dir, name), bat);
    if (next !== null) fs.writeFileSync(path.join(dir, "next.bat"), next);
    for (const tool of ["fltmc", "git", "powershell"]) fs.copyFileSync(path.join(TOOLS, "fake_tool.exe"), path.join(dir, tool + ".exe"));
    const releases = path.join(dir, "releases");
    fs.mkdirSync(releases);
    if (latest !== null) fs.writeFileSync(path.join(releases, "LATEST"), latest);
    const env = Object.assign({}, process.env, { CULLING_RELEASES: releases, FAKE_BAT: path.join(dir, name),
      FAKE_NEXT: next === null ? "" : path.join(dir, "next.bat"), FAKE_GIT_RC: gitFails ? "1" : "0", FAKE_PS_RC: String(psExit),
      // A pause with a pipe for stdin makes cmd's exit code unreliable: the fixtures pause anyway.
      CULLING_NO_PAUSE: "1" });
    // cmd looks in the current folder first, as on the VPS (Claude Code's shell turns that off).
    for (const k of Object.keys(env)) if (k.toLowerCase() === "nodefaultcurrentdirectoryinexepath") delete env[k];
    // "call": cmd /c "x.bat" alone doesn't reliably exit with the bat's "exit /b" code (measured: 0 most of the
    // time after "exit /b 1"); through call it does. Double-clicked, the code goes nowhere: the banner is what counts.
    const r = spawnSync("cmd.exe", ["/d", "/s", "/c", `"call "${name}"${args ? " " + args : ""}"`],
      // stdin: NUL. With a pipe, cmd's exit code after an "exit /b 1" in a block came back 0 at random.
      { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8", windowsVerbatimArguments: true, timeout: 60000 });
    const lines = (f) => { try { return fs.readFileSync(path.join(dir, f), "utf8").split(/\r?\n/).filter(Boolean); } catch { return []; } };
    return { status: r.status, out: (r.stdout || "") + (r.stderr || ""), ps: lines("ps.txt"), pulls: lines("pulls.txt").length };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}

const PUBLISH = "Publish Release.bat", UPDATE = "Update Culling Server.bat";
const publishNow = read(path.join(ROOT, PUBLISH));
const updateNow = read(path.join(ROOT, UPDATE));
const fixture = (f) => read(path.join(FIX, f));

test("D1 reproduced: the earlier bats lost their place when the pull changed them (the publish never ran)", () => {
  // ddd82e6 -> 5ad3aa9 is the update the user's VPS took: the old copy resumed mid-line.
  const r = run(PUBLISH, fixture("Publish Release.ddd82e6.bat"), { next: fixture("Publish Release.5ad3aa9.bat"), args: "1.3.10" });
  assert.strictEqual(r.ps.length, 0, "publish_release.ps1 was not expected to run: " + r.ps.join(" | "));
  assert.match(r.out, /not recognized/, "cmd ran a fragment of a line");
});

test("Publish: the bat before this one, pulling this one, publishes once", () => {
  const r = run(PUBLISH, fixture("Publish Release.5ad3aa9.bat"), { next: publishNow, args: "1.3.10" });
  assert.strictEqual(r.ps.length, 1, r.out);
  assert.match(r.ps[0], /publish_release\.ps1" -Release ".*\\releases\\1\.3\.10\\publish"/);
  assert.strictEqual(r.status, 0, r.out);
  assert.match(r.out, /PUBLISHED 1\.3\.10/);
});

test("Publish: this bat, pulling a later one that changed anywhere, runs the later one once", () => {
  // A later version with more lines above the pull and a marker on its powershell call.
  const later = publishNow.replace("title Publish", "rem a new line\r\nrem and another, longer one, before the title\r\ntitle Publish")
    .replace("%EXTRA%\r\n", "%EXTRA% -Later\r\n");
  assert.notStrictEqual(later, publishNow);
  const r = run(PUBLISH, publishNow, { next: later, args: "1.3.10 -AllowRemovals" });
  assert.strictEqual(r.ps.length, 1, r.out);
  assert.match(r.ps[0], /-AllowRemovals -Later$/, "the pulled version ran, with the arguments");
  assert.strictEqual(r.status, 0);
});

test("Publish: a failed publish is a non-zero exit and a PUBLISH FAILED line", () => {
  const r = run(PUBLISH, publishNow, { args: "1.3.10", psExit: 1 });
  assert.strictEqual(r.ps.length, 1);
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /PUBLISH FAILED, exit code 1/);
  assert.doesNotMatch(r.out, /PUBLISHED/);
});

test("Publish: a failed git pull stops before publishing, loudly", () => {
  const r = run(PUBLISH, publishNow, { args: "1.3.10", gitFails: true });
  assert.strictEqual(r.ps.length, 0);
  assert.strictEqual(r.status, 1);
  assert.match(r.out, /PUBLISH FAILED: "git pull" failed/);
});

test("Publish: the version comes from releases\\LATEST when none is given; none at all fails", () => {
  const r = run(PUBLISH, publishNow, { latest: "1.3.11" });
  assert.strictEqual(r.ps.length, 1, r.out);
  assert.match(r.ps[0], /\\1\.3\.11\\publish"/);
  const none = run(PUBLISH, publishNow, {});
  assert.strictEqual(none.ps.length, 0);
  assert.strictEqual(none.status, 1);
  assert.match(none.out, /PUBLISH FAILED: no release version given/);
});

test("Update: the bat before this one, pulling this one, installs once", () => {
  const r = run(UPDATE, fixture("Update Culling Server.8d5612c.bat"), { next: updateNow });
  assert.strictEqual(r.ps.length, 1, r.out);
  assert.match(r.ps[0], /install_vps\.ps1"$/);
  assert.strictEqual(r.status, 0);
  assert.match(r.out, /SERVER UPDATED/);
});

test("Update: a later bat runs once; a failed install or pull is a non-zero exit, said loudly", () => {
  const later = updateNow.replace("title Update", "rem one more line\r\ntitle Update").replace('install_vps.ps1"\r\n', 'install_vps.ps1" -Later\r\n');
  const r = run(UPDATE, updateNow, { next: later });
  assert.strictEqual(r.ps.length, 1, r.out);
  assert.match(r.ps[0], /-Later$/);
  const failed = run(UPDATE, updateNow, { psExit: 3 });
  assert.strictEqual(failed.status, 3);
  assert.match(failed.out, /UPDATE FAILED, exit code 3/);
  const pull = run(UPDATE, updateNow, { gitFails: true });
  assert.strictEqual(pull.ps.length, 0);
  assert.strictEqual(pull.status, 1);
  assert.match(pull.out, /UPDATE FAILED: "git pull" failed/);
});

test("the lines a running older copy has already read are unchanged (it resumes right after its pull)", () => {
  for (const [now, old] of [[publishNow, fixture("Publish Release.5ad3aa9.bat")], [updateNow, fixture("Update Culling Server.8d5612c.bat")]]) {
    const resume = old.indexOf("git pull --ff-only\r\n") + "git pull --ff-only\r\n".length;
    assert.strictEqual(now.slice(0, resume - 20), old.slice(0, resume - 20), "lines above the pull changed");
    assert.match(now.slice(resume), /^if \/i not "%~1"=="pulled" \(\r\n/, "the old copy must land on the pull block");
  }
});

console.log("all %d bat tests passed", passed);
