// /api/login refusals: every one says why in `errorCode`, which the menu
// shows (FULL_AUDIT_2026-11-06 round 2: most carried no errorCode, so the menu
// stayed offline without a word). And what /api/login logs: no client text
// beyond short plain fields (P1: up to 1 MB with newlines rolled the logs
// away), no raw Steam ID of a refused login.
"use strict";

const assert = require("assert");
const { startServer } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

async function withServer(opts, fn) {
  const srv = startServer(opts);
  try {
    await srv.ready();
    await fn(srv);
  } finally {
    srv.stop();
  }
}

const login = (srv, userid, ip, extra = {}) => srv.request("POST", "/api/login", Object.assign({ userid, authType: "steam" }, extra),
  ip ? { "X-Forwarded-For": ip } : {});

(async () => {
  await test("a malformed user ID: invalid-userid", async () => {
    await withServer({}, async (srv) => {
      const r = await login(srv, "");
      assert.strictEqual(r.status, 400);
      assert.strictEqual(r.json.errorCode, "invalid-userid");
      const bad = await srv.request("POST", "/api/login", "{not json");
      assert.strictEqual(bad.status, 400);
      assert.strictEqual(bad.json.errorCode, "invalid-userid", "a body that can't be read");
    });
  });

  await test("no play grant: account-required", async () => {
    await withServer({ vars: { CULLING_REQUIRE_ACCOUNT: "1" } }, async (srv) => {
      const r = await login(srv, "steam:76561190000000501");
      assert.strictEqual(r.status, 403);
      assert.strictEqual(r.json.errorCode, "account-required");
    });
  });

  await test("no room for a new profile: server-full", async () => {
    await withServer({ vars: { CULLING_MAX_PROFILES: "0" } }, async (srv) => {
      const r = await login(srv, "steam:76561190000000502");
      assert.strictEqual(r.status, 503);
      assert.strictEqual(r.json.errorCode, "server-full");
    });
  });

  await test("too many new profiles from one address: too-many-new-players", async () => {
    await withServer({}, async (srv) => {
      let r = null;
      for (let i = 0; i < 11; i++) r = await login(srv, "steam:765611900000006" + String(i).padStart(2, "0"), "203.0.113.7");
      assert.strictEqual(r.status, 429);
      assert.strictEqual(r.json.errorCode, "too-many-new-players");
    });
  });

  await test("over the request limit: rate-limited", async () => {
    await withServer({}, async (srv) => {
      const all = await Promise.all(Array.from({ length: 70 }, () => login(srv, "", "203.0.113.8")));
      const limited = all.filter((r) => r.status === 429);
      assert.ok(limited.length > 0, "some refused");
      for (const r of limited) assert.strictEqual(r.json.errorCode, "rate-limited");
    });
  });

  await test("the login log keeps only short plain authType, appid and build", async () => {
    await withServer({ output: true }, async (srv) => {
      const flood = "x".repeat(5000);
      const r = await login(srv, "steam:76561190000000503", null,
        { authType: "steam\n12:00:00 login FORGED LINE " + flood, appid: "437220<script>", build: "1.3.13-b\r\n" + flood });
      assert.strictEqual(r.status, 200);
      await new Promise((res) => setTimeout(res, 300));
      const line = srv.output().split("\n").find((l) => l.includes("login steam:76561190000000503"));
      assert.ok(line, "logged: " + srv.output().slice(-300));
      assert.ok(!srv.output().includes("FORGED LINE") && !srv.output().includes("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"), "no injected or long text");
      const fields = line.match(/authType=(\S*) appid=(\S*) build=(\S*)/);
      assert.ok(fields, line);
      for (const f of fields.slice(1)) assert.ok(/^[\w.-]{0,32}$/.test(f), "a short plain field: " + f);
      assert.strictEqual(fields[2], "437220script");
    });
  });

  await test("a refused login doesn't log the raw Steam ID", async () => {
    await withServer({ output: true, vars: { CULLING_REQUIRE_ACCOUNT: "1" } }, async (srv) => {
      assert.strictEqual((await login(srv, "steam:76561190000000777")).status, 403);
      await new Promise((res) => setTimeout(res, 300));
      assert.ok(/login refused/.test(srv.output()), "the refusal is logged");
      assert.ok(!srv.output().includes("76561190000000777"), srv.output().slice(-300));
    });
  });

  console.log("all %d login tests passed", passed);
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exitCode = 1; });
