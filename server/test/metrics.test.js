// /metrics answers loopback only and never through the proxy; malformed
// client messages fail fast without taking the server down or growing it.
"use strict";

const assert = require("assert");
const { startServer, next } = require("./helpers");
const { metricsAllowed, LatencyBucket } = require("../metrics");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

(async () => {
  await test("the access rule: loopback without proxy headers only", () => {
    assert.strictEqual(metricsAllowed("127.0.0.1", {}), true);
    assert.strictEqual(metricsAllowed("::1", {}), true);
    assert.strictEqual(metricsAllowed("::ffff:127.0.0.1", {}), true);
    for (const ip of ["10.0.0.5", "::ffff:192.168.1.2", "8.8.8.8", "127.0.0.2", "", undefined]) {
      assert.strictEqual(metricsAllowed(ip, {}), false, ip);
    }
    for (const h of ["x-forwarded-for", "x-forwarded-host", "x-forwarded-proto", "forwarded", "x-real-ip", "via"]) {
      assert.strictEqual(metricsAllowed("127.0.0.1", { [h]: "1.2.3.4" }), false, h);
    }
  });

  await test("latency percentiles", () => {
    const b = new LatencyBucket();
    for (let i = 1; i <= 100; i++) b.add(i, i > 98);
    const s = b.summary();
    assert.strictEqual(s.count, 100);
    assert.strictEqual(s.errors, 2);
    assert.strictEqual(s.p50Ms, 50);
    assert.strictEqual(s.p95Ms, 95);
    assert.strictEqual(s.p99Ms, 99);
    assert.strictEqual(s.maxMs, 100);
  });

  const srv = startServer();
  const sockets = [];
  try {
    await srv.ready();

    await test("/metrics reports to loopback", async () => {
      const token = await srv.login("steam:76561190000000101");
      sockets.push(await srv.connect(token));
      await srv.request("GET", "/api/ranked", undefined, { Authorization: "Bearer " + token });
      const r = await srv.request("GET", "/metrics");
      assert.strictEqual(r.status, 200);
      const m = r.json;
      assert.ok(m.uptimeSeconds >= 0);
      assert.strictEqual(m.connectedSockets, 1);
      assert.strictEqual(m.loggedInUsers, 1);
      for (const k of ["p50Ms", "p95Ms", "p99Ms", "maxMs"]) assert.ok(k in m.eventLoopDelay.sinceLastMinute, k);
      assert.ok(m.memoryMB.heapUsed > 0 && m.memoryMB.rss > 0);
      assert.ok("percentOfOneCore" in m.cpu.total);
      assert.ok(m.currentMinute.requests >= 3);
      assert.ok(m.currentMinute.routes["GET /api/ranked"].p95Ms >= 0);
      assert.ok(m.currentMinute.socketEventsByName.login.count >= 1);
      assert.ok("http5xx" in m.currentMinute.errors);
    });

    await test("/metrics is refused through the proxy (X-Forwarded-For) and to proxy-style headers", async () => {
      for (const h of [{ "X-Forwarded-For": "203.0.113.9" }, { "X-Forwarded-For": "127.0.0.1" }, { Forwarded: "for=1.2.3.4" },
        { "X-Forwarded-Proto": "https" }, { Via: "1.1 caddy" }]) {
        const r = await srv.request("GET", "/metrics", undefined, h);
        assert.strictEqual(r.status, 404, JSON.stringify(h));
        assert.ok(!r.json || !("uptimeSeconds" in r.json));
      }
    });

    await test("malformed socket messages are ignored and the server stays up", async () => {
      const token = await srv.login("steam:76561190000000102");
      const s = await srv.connect(token);
      sockets.push(s);
      const before = Object.keys(srv.profiles()).length;
      s.emit("get-cards", { users: "not-an-array" });
      assert.deepStrictEqual((await next(s, "get-cards-result")).cards, []);
      s.emit("get-cards", { users: ["__proto__", "constructor", { a: 1 }, "x".repeat(10000)] });
      const cards = (await next(s, "get-cards-result")).cards;
      assert.strictEqual(cards.length, 4);
      assert.ok(cards.every((c) => c.cardID === 0 && c.cardLevel === 1));
      s.emit("get-cards", null);
      await next(s, "get-cards-result");
      s.emit("set-card", { cardID: { evil: "x".repeat(1000) } });
      s.emit("set-card", "nonsense");
      s.emit("join-mm", { queueName: { toString: 1 } });
      await next(s, "join-mm-ack");
      s.emit("join-mm", { queueName: "__proto__" });
      await next(s, "join-mm-ack");
      s.emit("purchase-entitlement", null);
      assert.strictEqual((await next(s, "purchase-fail")).reason, "unknown-item");
      s.emit("lobby-create", { mapName: ["Prison"] });
      assert.strictEqual((await next(s, "lobby-update")).mapName, "Jungle/Jungle_P", "the stock CUSTOM screen's Jungle");
      for (const u of ["steam:someone-else", "__proto__", 12345, { x: 1 }]) {
        s.emit("get-season-summary", { userID: u });
        await next(s, "season-summary-response");
      }
      s.emit("login", 42);
      await new Promise((r) => setTimeout(r, 200));
      const health = await srv.request("GET", "/health");
      assert.strictEqual(health.status, 200);
      // Looking players up never creates profiles for them.
      assert.strictEqual(Object.keys(srv.profiles()).length, before);
      assert.strictEqual(srv.profiles()["steam:76561190000000102"].cardID, 0, "bad card IDs are stored as 0");
    });

    await test("malformed HTTP input fails fast with a JSON error", async () => {
      const bad = await srv.request("POST", "/api/login", "{not json");
      assert.strictEqual(bad.status, 400);
      const long = await srv.request("POST", "/api/login", { userid: "x".repeat(65) });
      assert.strictEqual(long.status, 400);
      assert.strictEqual(long.json.error, "invalid-userid");
      const ctl = await srv.request("POST", "/api/login", { userid: "steam:a\nb" });
      assert.strictEqual(ctl.status, 400);
      const curve = await srv.request("POST", "/api/levelcurve", { high: "nope" });
      assert.strictEqual(curve.status, 400);
      const m = (await srv.request("GET", "/metrics")).json;
      assert.strictEqual(m.totals.errors.http5xx || 0, 0, "no 5xx");
      assert.strictEqual(m.totals.errors.process || 0, 0, "no uncaught exceptions");
    });

    await test("new profiles per address are limited (burst of 10)", async () => {
      const headers = { "X-Forwarded-For": "198.51.100.7" };
      const codes = [];
      for (let i = 0; i < 12; i++) {
        codes.push((await srv.request("POST", "/api/login", { userid: "steam:7656119000000020" + i }, headers)).status);
      }
      assert.deepStrictEqual(codes.slice(0, 10), Array(10).fill(200));
      assert.deepStrictEqual(codes.slice(10), [429, 429]);
      // Existing players still log in from there.
      assert.strictEqual((await srv.request("POST", "/api/login", { userid: "steam:76561190000000200" }, headers)).status, 200);
    });

    await test("players can set the level curve once but not change it", async () => {
      const remote = { "X-Forwarded-For": "198.51.100.8" };
      const first = await srv.request("POST", "/api/levelcurve", { high: [100, 300, 600] }, remote);
      assert.strictEqual(first.json.levels, 3);
      const changed = await srv.request("POST", "/api/levelcurve", { high: [1, 2] }, remote);
      assert.strictEqual(changed.json.levels, 3, "a client can't replace the stored curve");
      // The operator, on the VPS itself, can.
      const operator = await srv.request("POST", "/api/levelcurve", { high: [100, 300, 600, 1000] });
      assert.strictEqual(operator.json.levels, 4);
    });

    console.log("all %d metrics tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
})();
