// Recent activity for the launcher: matches in the last 24 hours and players
// seen in the last 7 days, real counts only, kept across a restart, and sent
// with /health.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Activity, DAY, WEEK } = require("../activity");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "culling-activity-"));

(async () => {
  const srv = startServer(8131);
  try {
    await test("matches count for 24 hours, players for 7 days", async () => {
      let t = 1e12;
      const a = new Activity(() => t);
      a.match("p1");
      a.match("p1");
      a.seen("p2");
      assert.deepStrictEqual(a.summary(), { matchesToday: 2, playersWeek: 2 });
      t += DAY;
      assert.deepStrictEqual(a.summary(), { matchesToday: 0, playersWeek: 2 }, "a day later the matches are gone");
      a.seen("p1");
      t += WEEK - DAY + 1;
      assert.deepStrictEqual(a.summary(), { matchesToday: 0, playersWeek: 1 }, "p2 not seen for a week");
    });

    await test("nobody active reads 0, never a made-up number", async () => {
      assert.deepStrictEqual(new Activity(() => 5).summary(), { matchesToday: 0, playersWeek: 0 });
    });

    await test("the counts survive a restart", async () => {
      const file = path.join(dir, "activity.json");
      let t = 2e12;
      const a = new Activity(() => t, file, { delayMs: 0 });
      a.match("p1");
      a.seen("p2");
      a.flushSync();
      t += 3600 * 1000;
      const b = new Activity(() => t, file);
      assert.deepStrictEqual(b.summary(), { matchesToday: 1, playersWeek: 2 });
      fs.writeFileSync(file, "{not json");
      assert.deepStrictEqual(new Activity(() => t, file).summary(), { matchesToday: 0, playersWeek: 0 }, "a bad file starts empty");
    });

    await test("/health sends the online count with the activity", async () => {
      await srv.ready();
      let h = await srv.request("GET", "/health");
      assert.strictEqual(h.json.matchesToday, 0);
      assert.strictEqual(h.json.playersWeek, 0);
      const user = "steam:76561190000000031";
      const s = await srv.connect(await srv.login(user));
      try {
        h = await srv.request("GET", "/health");
        assert.strictEqual(h.json.users, 1);
        assert.strictEqual(h.json.playersWeek, 1, "signing in counts as active");
        s.emit("join-mm", { queueName: "ffa" });
        await next(s, "match-ready");
        assert.strictEqual((await srv.request("POST", "/api/matchresult", { kills: 1 })).status, 200);
        h = await srv.request("GET", "/health");
        assert.strictEqual(h.json.matchesToday, 1);
        assert.strictEqual(h.json.playersWeek, 1, "the same player counts once");
      } finally { s.close(); }
    });

    console.log("all %d activity tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    srv.stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})();
