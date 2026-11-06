// Backups of the data folder (server/backup.js): what a snapshot holds, that
// it verifies, rotation, a crashed snapshot left behind, the CLI the VPS
// installer runs before an update, and the server's own daily snapshot.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const backup = require("../backup");
const { startServer } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dataDir() {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "culling-backup-"));
  fs.writeFileSync(path.join(d, "profiles.json"), JSON.stringify({ "steam:1": { userID: "steam:1", cullCredits: 5 } }));
  fs.writeFileSync(path.join(d, "accounts.json"), JSON.stringify({ version: 1, accounts: {} }));
  fs.writeFileSync(path.join(d, "ip-hash-secret.txt"), "a".repeat(64));
  // Not data: temp files, a kept unreadable copy, logs, other backups.
  fs.writeFileSync(path.join(d, "profiles.json.tmp"), "{partial");
  fs.writeFileSync(path.join(d, "accounts.json.unreadable-1"), "x");
  fs.mkdirSync(path.join(d, "logs"));
  fs.writeFileSync(path.join(d, "logs", "culling-server.out.log"), "log");
  return d;
}

(async () => {
  await test("a snapshot copies the data files (never temp files, logs or backups) and verifies", async () => {
    const d = dataDir();
    const b = path.join(d, "backups");
    const r = backup.snapshot(d, b, "daily", { now: () => Date.parse("2026-11-05T04:00:00Z") });
    assert.strictEqual(path.basename(r.dir), "daily-20261105T040000Z");
    assert.deepStrictEqual(fs.readdirSync(r.dir).sort(), ["accounts.json", "backup.json", "ip-hash-secret.txt", "profiles.json"]);
    assert.deepStrictEqual(backup.verify(r.dir), []);
    // A second snapshot of the same data doesn't copy the first one.
    const r2 = backup.snapshot(d, b, "daily", { now: () => Date.parse("2026-11-06T04:00:00Z") });
    assert.ok(!fs.readdirSync(r2.dir).includes("backups"));
    assert.strictEqual(backup.latestAt(b, "daily"), Date.parse("2026-11-06T04:00:00Z"));
    // A changed or broken file is caught.
    fs.writeFileSync(path.join(r.dir, "profiles.json"), "{not json");
    assert.ok(backup.verify(r.dir).some((p) => /profiles\.json/.test(p)));
    fs.rmSync(d, { recursive: true, force: true });
  });

  await test("only the newest `keep` of a label are kept; other labels and unfinished snapshots", async () => {
    const d = dataDir();
    const b = path.join(d, "backups");
    let t = Date.parse("2026-11-01T00:00:00Z");
    backup.snapshot(d, b, "pre-update", { now: () => t });
    for (let i = 0; i < 5; i++) { t += 86400000; backup.snapshot(d, b, "daily", { keep: 3, now: () => t }); }
    fs.mkdirSync(path.join(b, "daily-20261201T000000Z.partial"));   // a crash mid-snapshot
    backup.prune(b, "daily", 3);
    assert.deepStrictEqual(backup.list(b, "daily").map((s) => s.name),
      ["daily-20261104T000000Z", "daily-20261105T000000Z", "daily-20261106T000000Z"]);
    assert.strictEqual(backup.list(b, "pre-update").length, 1, "another label's snapshots are left alone");
    assert.ok(!fs.existsSync(path.join(b, "daily-20261201T000000Z.partial")));
    // Two in the same second get distinct names.
    const same = () => t;
    const x = backup.snapshot(d, b, "daily", { keep: 10, now: same });
    const y = backup.snapshot(d, b, "daily", { keep: 10, now: same });
    assert.notStrictEqual(x.dir, y.dir);
    assert.throws(() => backup.snapshot(d, b, "../evil"), /invalid backup label/);
    fs.rmSync(d, { recursive: true, force: true });
  });

  await test("the CLI the installer runs: snapshot, verify, list; a failure exits 1", async () => {
    const d = dataDir();
    const b = path.join(d, "backups");
    const cli = (...args) => spawnSync(process.execPath, [path.join(__dirname, "..", "backup.js"), ...args], { encoding: "utf8" });
    const r = cli("snapshot", d, b, "pre-update", "10");
    assert.strictEqual(r.status, 0, r.stderr);
    assert.match(r.stdout, /verified/);
    const name = cli("list", b, "pre-update").stdout.trim();
    assert.match(name, /^pre-update-\d{8}T\d{6}Z$/);
    assert.strictEqual(cli("verify", path.join(b, name)).status, 0);
    const missing = cli("snapshot", path.join(d, "no-such-folder"), b, "pre-update");
    assert.strictEqual(missing.status, 1);
    assert.match(missing.stderr, /backup failed/);
    fs.rmSync(d, { recursive: true, force: true });
  });

  await test("the server takes its daily snapshot by itself, with everything written first", async () => {
    const srv = startServer({ vars: { CULLING_SAVE_DELAY_MS: "60000", CULLING_BACKUP_EVERY_MS: "200", CULLING_BACKUP_FIRST_MS: "50",
      CULLING_BACKUP_KEEP: "2" } });
    try {
      await srv.ready();
      // Held in memory only (60 s save delay) until the snapshot writes it.
      await srv.login("steam:76561190000000777");
      let snaps = [];
      for (let i = 0; i < 50 && snaps.length < 2; i++) { await sleep(100); snaps = backup.list(path.join(srv.dir, "backups"), "daily"); }
      assert.ok(snaps.length >= 1, "no daily snapshot");
      const last = snaps[snaps.length - 1].dir;
      assert.deepStrictEqual(backup.verify(last), []);
      const profiles = JSON.parse(fs.readFileSync(path.join(last, "profiles.json"), "utf8"));
      assert.ok(profiles["steam:76561190000000777"], "the snapshot has the profile that was only in memory");
      await sleep(800);
      assert.ok(backup.list(path.join(srv.dir, "backups"), "daily").length <= 2, "rotated to CULLING_BACKUP_KEEP");
      const m = await srv.request("GET", "/metrics");
      assert.ok(m.json.backups && m.json.backups.last && m.json.backups.last.files >= 2, JSON.stringify(m.json.backups));
    } finally {
      srv.stop();
    }
  });

  console.log("all %d backup tests passed", passed);
})().catch((e) => { console.error(e); process.exit(1); });
