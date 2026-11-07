// Sessions (tokens), match tickets, rate limits and client addresses.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { Sessions, MatchTickets, rateLimiter, clientIp, TOKEN_TTL_MS, TICKET_TTL_MS } = require("../session");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }
let clock = 1_000_000;
const now = () => clock;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "culling-session-"));

try {
  test("tokens identify their player and survive a restart", () => {
    const file = path.join(dir, "sessions.json");
    const s = new Sessions(file, now);
    const t = s.issue("steam:1");
    assert.strictEqual(s.userFor(t), "steam:1");
    assert.strictEqual(new Sessions(file, now).userFor(t), "steam:1");
    assert.strictEqual(s.userFor("nope"), null);
    assert.strictEqual(s.userFor("__proto__"), null);
    assert.strictEqual(s.userFor(undefined), null);
  });

  test("tokens expire", () => {
    const s = new Sessions(null, now);
    const t = s.issue("steam:1");
    clock += TOKEN_TTL_MS + 1;
    assert.strictEqual(s.userFor(t), null);
  });

  test("a ticket pays once and is found by token or by a unique address", () => {
    const m = new MatchTickets(now);
    m.start("steam:1", "1.2.3.4");
    assert.strictEqual(m.claim({ ip: "9.9.9.9" }).error, "no-match");
    assert.strictEqual(m.claim({ ip: "1.2.3.4" }).ticket.userID, "steam:1");
    assert.strictEqual(m.claim({ ip: "1.2.3.4" }).error, "no-match");
    assert.strictEqual(m.recentUser("1.2.3.4"), "steam:1");
    m.start("steam:2", "5.5.5.5");
    assert.strictEqual(m.claim({ userID: "steam:2", ip: "anything" }).ticket.userID, "steam:2");
  });

  test("tickets keep the address hashed, never raw; one saved raw is hashed when loaded", () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const hashIp = (ip) => "h:" + ip.split("").reverse().join("");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "culling-tk-")), "tickets.json");
    const m = new MatchTickets(now, file, { hashIp });
    const t = m.start("steam:1", "1.2.3.4");
    assert.ok(!("ip" in t), "no raw address on the ticket");
    m.flushSync();
    assert.ok(!fs.readFileSync(file, "utf8").includes("1.2.3.4"), "nor in tickets.json");
    assert.strictEqual(m.peek({ ip: "1.2.3.4" }).userID, "steam:1", "found by address");
    fs.writeFileSync(file, JSON.stringify([{ id: "0123456789abcdef", userID: "steam:2", ip: "5.6.7.8", startedAt: clock }]));
    const loaded = new MatchTickets(now, file, { hashIp });
    assert.ok(!("ip" in loaded.open.get("steam:2")), "the raw address is dropped");
    loaded.flushSync();
    assert.ok(!fs.readFileSync(file, "utf8").includes("5.6.7.8"), "and rewritten without it");
    assert.strictEqual(loaded.claim({ ip: "5.6.7.8" }).ticket.userID, "steam:2", "still claimed by address");
    assert.strictEqual(loaded.recentUser("5.6.7.8"), "steam:2");
  });

  test("tickets expire and a new match replaces an unfinished one", () => {
    const m = new MatchTickets(now);
    const first = m.start("steam:1", "1.1.1.1");
    const second = m.start("steam:1", "1.1.1.1");
    assert.notStrictEqual(first.id, second.id);
    assert.strictEqual(m.open.size, 1);
    clock += TICKET_TTL_MS + 1;
    assert.strictEqual(m.claim({ userID: "steam:1" }).error, "no-match");
  });

  test("rate limits allow a burst, refuse the excess, then refill", () => {
    const allow = rateLimiter(2, 3, now);
    assert.deepStrictEqual([1, 2, 3, 4].map(() => allow("a")), [true, true, true, false]);
    assert.strictEqual(allow("b"), true, "per key");
    clock += 1000;
    assert.strictEqual(allow("a"), true);
  });

  test("forwarded addresses are trusted only from the local proxy", () => {
    assert.strictEqual(clientIp("::ffff:127.0.0.1", "6.6.6.6, 8.8.8.8"), "8.8.8.8");
    assert.strictEqual(clientIp("8.8.4.4", "1.1.1.1"), "8.8.4.4");
    assert.strictEqual(clientIp("::ffff:10.0.0.5"), "10.0.0.5");
  });

  console.log("all %d session tests passed", passed);
} finally {
  fs.rmSync(dir, { recursive: true, force: true });
}
