// What a client that never logs in can make the socket layer do
// (performance review P1: four uploaders of ~1 MB polling payloads kept the
// server's CPU busy and every player's requests waiting). Messages are capped
// at 64 KB, an oversized polling upload is refused before its body is read,
// polling uploads and new sessions are rate limited per address.
"use strict";

const assert = require("assert");
const http = require("http");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function raw(port, method, url, body, headers = {}) {
  return new Promise((resolve) => {
    const r = http.request({ host: "127.0.0.1", port, path: url, method, headers, agent: false }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString("latin1") }));
    });
    r.on("error", (e) => resolve({ status: 0, error: e.code }));
    if (body) r.end(body); else r.end();
  });
}
const handshake = (srv, ip) => raw(srv.port, "GET", "/socket.io/?EIO=3&transport=polling", null, { "X-Forwarded-For": ip });

(async () => {
  const srv = startServer();
  const sockets = [];
  try {
    await srv.ready();

    await test("a polling upload over 64 KB is refused (413) before its body is read", async () => {
      const hs = await handshake(srv, "203.0.113.20");
      const sid = (hs.body.match(/"sid":"([^"]+)"/) || [])[1];
      assert.ok(sid, "a session: " + hs.status);
      const body = Buffer.alloc(100 * 1024, 0x61);
      const r = await raw(srv.port, "POST", "/socket.io/?EIO=3&transport=polling&sid=" + sid, body,
        { "X-Forwarded-For": "203.0.113.20", "Content-Type": "application/octet-stream", "Content-Length": body.length });
      assert.strictEqual(r.status, 413);
    });

    await test("new sessions from one address are rate limited", async () => {
      const all = [];
      for (let i = 0; i < 60; i++) all.push((await handshake(srv, "203.0.113.21")).status);
      assert.ok(all.filter((s) => s === 200).length >= 20, "a burst is allowed: " + all.join(","));
      assert.ok(all.some((s) => s !== 200), "then refused");
      assert.strictEqual((await handshake(srv, "203.0.113.22")).status, 200, "another address isn't");
    });

    await test("a socket message over 64 KB closes that socket", async () => {
      const s = await srv.connect(await srv.login("steam:76561190000000151"));
      sockets.push(s);
      const closed = new Promise((r) => s.once("disconnect", () => r("closed")));
      s.emit("get-cards", { users: ["a".repeat(100 * 1024)] });
      const got = await Promise.race([closed, next(s, "get-cards-result").then(() => "answered"), sleep(3000).then(() => "nothing")]);
      assert.strictEqual(got, "closed");
    });

    await test("a normal socket still works", async () => {
      const s = await srv.connect(await srv.login("steam:76561190000000152"));
      sockets.push(s);
      const r = next(s, "get-cards-result");
      s.emit("get-cards", { users: ["steam:76561190000000152"] });
      assert.strictEqual((await r).cards.length, 1);
    });

    console.log("all %d socket limit tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
})();
