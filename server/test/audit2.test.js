// Regressions for docs/SERVER_AUDIT_2.md, each against a throwaway server:
//   F4 a match ticket without a mode (tickets.json from an older server) is paid, not a 500
//   F6 a lobby whose match set-up throws: the members are told, the server keeps running
//   F7 a JSON body of "null" is a 400, not a 500
//   F8 a player who closes the game after a result isn't remembered as "in menu" forever
"use strict";

const assert = require("assert");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = "steam:76561190000000301";
const B = "steam:76561190000000302";

(async () => {
  // ------------------------------------------------------------ F4, F7, F8
  {
    // A ticket as an older server saved it: no mode (the field came later).
    const old = { id: "0123456789abcdef", userID: A, ip: "127.0.0.1", startedAt: Date.now() - 300000, map: "jungle", ranked: null };
    const srv = startServer({ files: { "tickets.json": [old] } });
    const sockets = [];
    try {
      await srv.ready();

      await test("F4: a ticket an older server saved (no mode) is paid, not a server error", async () => {
        const r = await srv.request("POST", "/api/matchresult", { victory: false, kills: 2, damage: 100, timeAlive: 200, placement: 7 });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        const p = srv.profiles()[A];
        assert.strictEqual(p.stats.gamesPlayed, 1);
        assert.strictEqual(p.stats.kills, 2);
        assert.strictEqual(p.modes.ffa.played, 1, "counted as Solo");
        const m = await srv.request("GET", "/metrics");
        assert.strictEqual(m.json.totals.errors.http5xx || 0, 0);
      });

      await test("F7: a body that is JSON null is refused (400), never a server error", async () => {
        for (const url of ["/api/login", "/api/matchresult", "/api/setlevel", "/api/account/register", "/api/account/login"]) {
          const r = await srv.request("POST", url, "null", { "Content-Type": "text/plain" });
          assert.ok(r.status < 500, url + " answered " + r.status);
        }
        const r = await srv.request("POST", "/api/login", "null", { "Content-Type": "text/plain" });
        assert.strictEqual(r.status, 400);
        const m = await srv.request("GET", "/metrics");
        assert.strictEqual(m.json.totals.errors.http5xx || 0, 0, "no 5xx");
      });

      await test("F8: a result after the player closed the game leaves nothing behind", async () => {
        const b = await srv.connect(await srv.login(B));
        sockets.push(b);
        b.emit("join-mm", { queueName: "ffa" });
        await next(b, "match-ready");
        b.close();                                   // the game closed during the match
        await sleep(200);
        const r = await srv.request("POST", "/api/matchresult", { victory: false, kills: 0, damage: 0, timeAlive: 60, placement: 9 });
        assert.strictEqual(r.status, 200);
        const m = await srv.request("GET", "/metrics");
        assert.strictEqual(m.json.presence, 0, "presence entries left: " + m.json.presence);
      });
    } finally {
      for (const s of sockets) s.close();
      srv.stop();
    }
  }

  // ------------------------------------------------------------ F6
  {
    const srv = startServer({ vars: { CULLING_FAULT_ALLOCATION: "throw" } });
    const sockets = [];
    try {
      await srv.ready();
      await test("F6: a lobby whose match set-up throws tells its players, and the server keeps running", async () => {
        const a = await srv.connect(await srv.login(A));
        sockets.push(a);
        const failed = next(a, "join-mm-fail");
        a.emit("join-mm", { queueName: "ffa" });
        const f = await Promise.race([failed, sleep(5000).then(() => null)]);
        assert.ok(f, "no join-mm-fail");
        assert.strictEqual(f.reason, "allocation-failed");
        await sleep(200);
        assert.strictEqual(srv.proc.exitCode, null, "the server exited");
        const h = await srv.request("GET", "/health");
        assert.strictEqual(h.status, 200);
        const m = await srv.request("GET", "/metrics");
        assert.ok((m.json.totals.errors.timer || 0) >= 1, "counted in /metrics");
        // The player can queue again (the lobby is gone).
        a.emit("join-mm", { queueName: "ffa" });
        assert.strictEqual((await next(a, "join-mm-fail")).reason, "allocation-failed");
      });
    } finally {
      for (const s of sockets) s.close();
      srv.stop();
    }
  }

  // ------------------------------------------------------------ P2
  {
    // Two players with accounts; A has asked B to be friends.
    const IDS = { a: "steam:76561190000000311", b: "steam:76561190000000312" };
    const account = (name, id) => ({ username: name, email: name.toLowerCase() + "@example.test", userID: id, password: "scrypt$x", createdAt: 1 });
    const srv = startServer({ files: {
      "accounts.json": { version: 1, accounts: { "player a": account("Player A", IDS.a), "player b": account("Player B", IDS.b) }, tokens: {}, grants: {} },
      "friends.json": { version: 1, users: { [IDS.a]: { friends: [], incoming: [], outgoing: [IDS.b], seen: null },
        [IDS.b]: { friends: [], incoming: [IDS.a], outgoing: [], seen: null } } } } });
    const sockets = [];
    try {
      await srv.ready();
      await test("P2: a change that touches several panels sends each panel once, after it", async () => {
        const a = await srv.connect(await srv.login(IDS.a));
        const b = await srv.connect(await srv.login(IDS.b));
        sockets.push(a, b);
        await sleep(500);                            // the logins' own pushes
        const got = { a: [], b: [] };
        a.on("remaster-friends", (f) => got.a.push(f));
        b.on("remaster-friends", (f) => got.b.push(f));
        b.emit("friend-accept", { username: "Player A" });
        await sleep(500);
        // notifyFriends(B) then notifyFriends(A): each panel was built and sent twice.
        assert.strictEqual(got.a.length, 1, "pushes to A: " + got.a.length);
        assert.strictEqual(got.b.length, 1, "pushes to B: " + got.b.length);
        assert.deepStrictEqual(got.b[0].friends.map((f) => f.username), ["Player A"]);
        assert.deepStrictEqual(got.a[0].friends.map((f) => f.username), ["Player B"]);
        assert.strictEqual(got.a[0].friends[0].status.state, "menu");
      });
    } finally {
      for (const s of sockets) s.close();
      srv.stop();
    }
  }

  console.log("all %d audit 2 tests passed", passed);
})().catch((e) => { console.error(e); process.exit(1); });
