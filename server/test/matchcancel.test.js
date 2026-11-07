// A cancel that crosses the match-ready: the player left the search (or the
// pregame lobby) as the match was being sent, so the menu ignores the
// match-ready. The server closes that match too: no live ticket, no pending
// ranked match scored as last place later, back "In menu" for friends
// (FULL_AUDIT_2026-11-06 round 2). The menu can also say so itself
// (match-declined).
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const A = "steam:76561190000000121";

async function withServer(vars, fn) {
  const srv = startServer({ vars });
  let sock = null;
  try {
    await srv.ready();
    const token = await srv.login(A);
    sock = await srv.connect(token);
    await fn(srv, sock, token);
  } finally {
    if (sock) sock.close();
    srv.stop();
  }
}

const tickets = (srv) => { try { return JSON.parse(fs.readFileSync(path.join(srv.dir, "tickets.json"), "utf8")); } catch { return []; } };

async function rankedMatch(srv, sock) {
  const ready = next(sock, "match-ready");
  sock.emit("join-mm", { queueName: "ranked_ffa_jungle" });
  await ready;
  assert.ok(srv.profiles()[A].ranked.pending, "a ranked match is pending");
  assert.strictEqual(tickets(srv).length, 1, "a ticket is open");
}

(async () => {
  await test("leave-mm right after the match-ready: the ticket and the ranked match are dropped, unscored", async () => {
    await withServer({}, async (srv, sock, token) => {
      await rankedMatch(srv, sock);
      const ack = next(sock, "leave-mm-ack");
      sock.emit("leave-mm", { queueName: "ranked_ffa_jungle" });
      await ack;
      await sleep(100);
      const r = srv.profiles()[A].ranked;
      assert.deepStrictEqual([r.pending, r.matches, r.rating], [null, 0, 1000], "no last place");
      assert.strictEqual(tickets(srv).length, 0, "no live ticket");
      const res = await srv.request("POST", "/api/matchresult", { victory: false }, { Authorization: "Bearer " + token });
      assert.strictEqual(res.status, 409, "nothing to pay");
    });
  });

  await test("match-declined does the same", async () => {
    await withServer({}, async (srv, sock) => {
      await rankedMatch(srv, sock);
      sock.emit("match-declined");
      await sleep(200);
      assert.strictEqual(srv.profiles()[A].ranked.pending, null);
      assert.strictEqual(srv.profiles()[A].ranked.matches, 0);
      assert.strictEqual(tickets(srv).length, 0);
    });
  });

  await test("leave-mm well after the match-ready leaves the match running", async () => {
    await withServer({ CULLING_DECLINE_WINDOW_MS: "300" }, async (srv, sock, token) => {
      await rankedMatch(srv, sock);
      await sleep(500);
      sock.emit("leave-mm", { queueName: "ranked_ffa_jungle" });
      await sleep(200);
      assert.ok(srv.profiles()[A].ranked.pending, "still pending");
      assert.strictEqual(tickets(srv).length, 1, "still open");
      const res = await srv.request("POST", "/api/matchresult", { victory: false, placement: 5 }, { Authorization: "Bearer " + token });
      assert.strictEqual(res.status, 200);
    });
  });

  console.log("all %d match cancel tests passed", passed);
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exitCode = 1; });
