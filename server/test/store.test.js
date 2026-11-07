// Saving: writes are atomic (temp file, fsync, rename), coalesced (a burst of
// changes is one write, at most one per interval), never leave a partial
// file, and a synchronous flush always wins over a write in flight. Also the
// bounds on sessions, tickets and rate-limit tables.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { CoalescedJsonFile } = require("../store");
const { Sessions, MatchTickets, rateLimiter, MAX_TOKENS_PER_USER } = require("../session");
const { Accounts } = require("../accounts");
const { startServer } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "culling-store-"));
const read = (f) => JSON.parse(fs.readFileSync(f, "utf8"));

(async () => {
  try {
    await test("a burst of changes is one write, with the latest data", async () => {
      const file = path.join(dir, "burst.json");
      const data = { n: 0 };
      const store = new CoalescedJsonFile(file, () => JSON.stringify(data), { delayMs: 200 });
      for (let i = 1; i <= 1000; i++) { data.n = i; store.markDirty(); }
      await sleep(400);
      assert.strictEqual(store.stats.writes, 1, "1000 changes, one write");
      assert.strictEqual(store.stats.changes, 1000);
      assert.strictEqual(read(file).n, 1000);
    });

    await test("at most one write per interval under a steady stream of changes", async () => {
      const file = path.join(dir, "steady.json");
      const data = { n: 0 };
      const store = new CoalescedJsonFile(file, () => JSON.stringify(data), { delayMs: 250 });
      const t0 = Date.now();
      while (Date.now() - t0 < 1300) { data.n++; store.markDirty(); await sleep(5); }
      await store.flush();
      const elapsed = Date.now() - t0;
      // Leading write plus one per 250 ms.
      assert.ok(store.stats.writes <= Math.ceil(elapsed / 250) + 1, `${store.stats.writes} writes in ${elapsed} ms`);
      assert.ok(store.stats.writes >= 3, `${store.stats.writes} writes`);
      assert.strictEqual(read(file).n, data.n, "nothing lost after flush");
    });

    await test("the file is always complete JSON while being rewritten (rename is atomic)", async () => {
      const file = path.join(dir, "atomic.json");
      // ~2 MB per write, so a non-atomic write would be caught half-done.
      const data = { n: 0, pad: "x".repeat(2 * 1024 * 1024) };
      const store = new CoalescedJsonFile(file, () => JSON.stringify(data), { delayMs: 1 });
      store.flushSync(true);
      let reads = 0, bad = 0, lastN = 0;
      const t0 = Date.now();
      while (Date.now() - t0 < 1500) {
        data.n++; store.markDirty();
        try {
          const got = read(file);
          reads++;
          if (got.pad.length !== data.pad.length || got.n < lastN) bad++;
          lastN = got.n;
        } catch (e) {
          // A Windows reader can briefly hit a sharing violation during the
          // rename; that is not a partial file. Anything else is.
          if (!["EPERM", "EBUSY", "EACCES", "ENOENT"].includes(e.code)) bad++;
        }
        await sleep(1);
      }
      await store.flush();
      assert.strictEqual(bad, 0, `${bad} partial or out-of-order reads of ${reads}`);
      assert.ok(store.stats.writes > 5, `${store.stats.writes} writes`);
      assert.ok(reads > 50, `${reads} reads`);
      assert.strictEqual(read(file).n, data.n);
      assert.ok(!fs.existsSync(file + ".tmp"), "no temp file left");
    });

    await test("a failed write leaves the old file intact and is retried", async () => {
      const file = path.join(dir, "fail.json");
      let data = { v: "old" };
      const errors = [];
      const store = new CoalescedJsonFile(file, () => JSON.stringify(data), { delayMs: 50, onError: (e) => errors.push(e) });
      store.flushSync(true);
      // A directory where the temp file should go: opening it fails.
      fs.mkdirSync(file + ".tmp");
      data = { v: "new" };
      store.markDirty();
      await sleep(200);
      assert.ok(errors.length >= 1, "the error is reported");
      assert.strictEqual(read(file).v, "old", "old data intact");
      assert.strictEqual(store.dirty, true, "the change is kept for a retry");
      fs.rmdirSync(file + ".tmp");
      await sleep(300);
      assert.strictEqual(read(file).v, "new", "retried and written");
      // A serializer that throws doesn't touch the file either.
      const broken = new CoalescedJsonFile(file, () => { throw new Error("boom"); }, { delayMs: 10, onError: () => {} });
      broken.markDirty();
      await sleep(100);
      assert.strictEqual(read(file).v, "new");
    });

    await test("a shutdown flush during a write in flight is not overwritten by the older write", async () => {
      const file = path.join(dir, "race.json");
      const data = { n: 1, pad: "y".repeat(4 * 1024 * 1024) };
      const store = new CoalescedJsonFile(file, () => JSON.stringify(data), { delayMs: 1 });
      store.markDirty();
      // Let the async write start (serialized with n = 1), then change and flush synchronously.
      while (!store.writing) await sleep(0);
      data.n = 2;
      store.markDirty();
      store.close();
      assert.strictEqual(read(file).n, 2);
      await sleep(300);                     // the stale async write finishes
      assert.strictEqual(read(file).n, 2, "the older in-flight write did not replace the flushed data");
      assert.ok(!fs.existsSync(file + ".tmp"), "the stale temp file is removed");
      data.n = 3;
      store.markDirty();                    // after close: written immediately
      assert.strictEqual(read(file).n, 3);
    });

    await test("temp files left by a crash are cleaned up on start", () => {
      const file = path.join(dir, "leftover.json");
      fs.writeFileSync(file, '{"ok":true}');
      fs.writeFileSync(file + ".tmp", '{"half');
      const store = new CoalescedJsonFile(file, () => "{}", { delayMs: 10 });
      assert.ok(!fs.existsSync(file + ".tmp"));
      assert.strictEqual(read(file).ok, true);
      store.close();
    });

    await test("sessions: coalesced saves, flushed on demand, and survive a restart", async () => {
      const file = path.join(dir, "sessions.json");
      const s = new Sessions(file, Date.now, { saveDelayMs: 60000 });
      const t0 = s.issue("steam:1");         // the first change is written promptly (leading edge)
      await sleep(50);
      const tokens = [];
      for (let i = 0; i < 50; i++) tokens.push(s.issue("steam:" + (100 + i)));
      assert.strictEqual(s.store.stats.writes, 1, "50 logins inside the interval: no extra writes yet");
      assert.strictEqual(new Sessions(file).userFor(tokens[49]), null, "not on disk until the interval ends");
      assert.strictEqual(s.flushSync(), true);
      const again = new Sessions(file);
      assert.strictEqual(again.userFor(t0), "steam:1");
      assert.strictEqual(again.userFor(tokens[49]), "steam:149");
    });

    await test("sessions: a player keeps only their newest tokens", () => {
      const s = new Sessions(null);
      const issued = [];
      for (let i = 0; i < MAX_TOKENS_PER_USER + 5; i++) issued.push(s.issue("steam:spam"));
      assert.strictEqual(s.size, MAX_TOKENS_PER_USER);
      assert.strictEqual(s.userFor(issued[0]), null, "oldest dropped");
      assert.strictEqual(s.userFor(issued[issued.length - 1]), "steam:spam", "newest kept");
    });

    await test("tickets: the paid-result table forgets addresses after 15 minutes", () => {
      let clock = 0;
      const m = new MatchTickets(() => clock);
      for (let i = 0; i < 1000; i++) { m.start("steam:" + i, "10.0.0." + i); m.claim({ userID: "steam:" + i, ip: "10.0.0." + i }); }
      assert.strictEqual(m.recent.size, 1000);
      clock += 16 * 60 * 1000;
      m.start("steam:x", "1.1.1.1");
      assert.strictEqual(m.recent.size, 0);
    });

    await test("rate limiter: idle addresses are swept instead of the whole table being reset", () => {
      let clock = 0;
      const allow = rateLimiter(1, 20, () => clock, 100);    // full again 20 s after last use
      for (let i = 0; i < 99; i++) allow("idle" + i);
      clock += 25000;
      for (let i = 0; i < 25; i++) allow("busy");            // over the limit now
      assert.strictEqual(allow.size(), 100);
      assert.strictEqual(allow("new"), true);                // table full: idle ones are swept
      assert.strictEqual(allow.size(), 2, "busy + new remain");
      assert.strictEqual(allow("busy"), false, "the busy address is still limited (not reset)");
    });

    await test("ranked: remembered match IDs are bounded per profile", () => {
      const ranked = require("../ranked");
      const p = {};
      let lastId = null;
      for (let i = 0; i < ranked.CONFIG.processedLength + 40; i++) {
        const { match } = ranked.startMatch(p, 1000 + i);
        ranked.finishMatch(p, { matchId: match.id, placement: 10 }, 1000 + i);
        lastId = match.id;
      }
      assert.strictEqual(Object.keys(p.ranked.processed).length, ranked.CONFIG.processedLength);
      assert.strictEqual(ranked.finishMatch(p, { matchId: lastId, placement: 1 }).duplicate, true, "a recent result still can't count twice");
      assert.strictEqual(p.ranked.history.length, ranked.CONFIG.historyLength);
    });

    // Performance review P4: a reader holding the file open (antivirus,
    // backup) made the rename retry with Atomics.wait, blocking the event
    // loop up to ~340 ms. The periodic write now waits between retries.
    await test("a periodic write whose rename is refused for a moment waits without blocking the event loop", async () => {
      const file = path.join(dir, "locked.json");
      const data = { n: 1 };
      const store = new CoalescedJsonFile(file, () => JSON.stringify(data), { delayMs: 50 });
      const rename = fs.renameSync;
      let refused = 0;
      fs.renameSync = (from, to) => {
        if (to === file && refused < 4) { refused++; const e = new Error("busy"); e.code = "EBUSY"; throw e; }
        return rename(from, to);
      };
      let maxGap = 0, last = performance.now();
      const ticker = setInterval(() => { const t = performance.now(); maxGap = Math.max(maxGap, t - last); last = t; }, 5);
      try {
        store.markDirty();
        await sleep(60);
        await store.flush();
        for (let i = 0; i < 50 && read(file).n !== 1; i++) await sleep(20);
      } finally { fs.renameSync = rename; clearInterval(ticker); }
      assert.strictEqual(refused, 4, "the rename was refused four times, then done");
      assert.strictEqual(read(file).n, 1);
      assert.ok(maxGap < 60, "the event loop never stalled for the retries (20+40+60+80 ms): longest gap " + maxGap.toFixed(1) + " ms");
      assert.ok(store.stats.maxBlockingMs < 50, "blocking " + store.stats.maxBlockingMs);
    });

    // Performance review P5: every game login extended the play grant and
    // rewrote accounts.json; a serialize that slow down the event loop ran
    // every second; and nothing said when profiles.json grew past what a
    // single JSON file can carry.
    await test("a game login extends the play grant in memory, saving it at most once a minute", async () => {
      let clock = 1e12;
      const a = new Accounts(path.join(dir, "accounts.json"), { now: () => clock });
      a.create({ username: "Granted", email: "g@example.com", userID: "steam:76561190000000161", password: "x" });
      a.grant("steam:76561190000000161", "ip");
      const changes = a.store.stats.changes;
      for (let i = 0; i < 10; i++) { clock += 1000; assert.ok(a.useGrant("steam:76561190000000161", "ip")); }
      assert.strictEqual(a.store.stats.changes, changes, "ten logins in ten seconds: no save");
      assert.strictEqual(a.grants.get("steam:76561190000000161").until, clock + 12 * 3600 * 1000, "but extended");
      clock += 61 * 1000;
      assert.ok(a.useGrant("steam:76561190000000161", "ip"));
      assert.strictEqual(a.store.stats.changes, changes + 1, "a minute later: saved");
      a.flushSync();
      assert.strictEqual(read(path.join(dir, "accounts.json")).grants["steam:76561190000000161"].until, clock + 12 * 3600 * 1000);
    });

    await test("after a serialize slower than 50 ms the next write waits 5 s, not the usual interval", async () => {
      const file = path.join(dir, "slow.json");
      let slow = true;
      const store = new CoalescedJsonFile(file, () => {
        const t0 = performance.now();
        while (slow && performance.now() - t0 < 60) { /* a big file */ }
        return "{}";
      }, { delayMs: 100, slowSerializeMs: 50, slowDelayMs: 5000 });
      store.markDirty();
      await sleep(300);
      assert.strictEqual(store.stats.writes, 1);
      assert.strictEqual(store.currentDelayMs(), 5000);
      store.markDirty();
      await sleep(400);
      assert.strictEqual(store.stats.writes, 1, "not written again 100 ms later");
      slow = false;
      store.flushSync();
      assert.strictEqual(store.currentDelayMs(), 100, "back to the interval once it is fast again");
    });

    await test("the server warns loudly when profiles.json grows past CULLING_PROFILES_WARN_BYTES (200 MB)", async () => {
      const srv = startServer({ output: true, vars: { CULLING_PROFILES_WARN_BYTES: "100" } });
      try {
        await srv.ready();
        await srv.login("steam:76561190000000162");
        await sleep(300);
        assert.ok(/WARNING: profiles\.json/.test(srv.output()), srv.output().slice(-300));
      } finally { srv.stop(); }
    });

    console.log("all %d store tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
