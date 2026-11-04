// Player accounts: sign-up, sign-in, tokens, the play grant the game's own
// login needs, claiming an existing profile, the operator tools, and that
// everything survives a graceful restart. Client addresses are simulated with
// X-Forwarded-For (trusted from loopback, as from Caddy on the VPS).
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn, execFileSync } = require("child_process");
const { startServer } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const from = (ip, extra = {}) => Object.assign({ "X-Forwarded-For": ip }, extra);
const bearer = (token, ip) => from(ip, { Authorization: "Bearer " + token });

let nameCounter = 0;
const uniqueName = (prefix = "Player") => prefix + "_" + (++nameCounter) + "_" + process.pid % 1000;

async function main() {
  const srv = startServer(8129, { vars: { CULLING_REQUIRE_ACCOUNT: "1" } });
  const req = srv.request;
  const register = (body, ip) => req("POST", "/api/account/register", body, from(ip));
  const login = (username, password, ip) => req("POST", "/api/account/login", { username, password }, from(ip));
  const me = (token, ip = "198.51.100.1") => req("GET", "/api/account/me", undefined, bearer(token, ip));
  const gameLogin = (userid, ip) => req("POST", "/api/login", { userid, authType: "steam" }, from(ip));
  let p1;
  try {
    await srv.ready();

    await test("register, sign in, me, sign out", async () => {
      const r = await register({ username: "  Player   One ", email: " P1@Example.COM ", password: "correct horse" }, "198.51.100.1");
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.username, "Player One", "trimmed, single spaces");
      assert.match(r.json.userID, /^steam:\d{17}$/);
      assert.ok(BigInt(r.json.userID.slice(6)) > 76561197960265728n);
      assert.strictEqual(r.json.claimed, false);
      assert.match(r.json.token, /^[0-9a-f]{64}$/);
      assert.ok(srv.profiles()[r.json.userID], "profile created");
      p1 = { userID: r.json.userID, token: r.json.token, password: "correct horse" };

      const m = await me(p1.token);
      assert.strictEqual(m.status, 200);
      assert.deepStrictEqual(m.json, { username: "Player One", userID: p1.userID, email: "p1@example.com" });

      const l = await login("PLAYER one", "correct horse", "198.51.100.1");
      assert.strictEqual(l.status, 200);
      assert.strictEqual(l.json.userID, p1.userID);
      assert.strictEqual(l.json.username, "Player One");
      assert.notStrictEqual(l.json.token, p1.token);

      assert.strictEqual((await req("POST", "/api/account/logout", {}, bearer(p1.token, "198.51.100.1"))).status, 200);
      const gone = await me(p1.token);
      assert.strictEqual(gone.status, 401);
      assert.deepStrictEqual(gone.json, { error: "signed-out" });
      assert.strictEqual((await me(l.json.token)).status, 200, "other tokens unaffected");
      p1.token = l.json.token;
      assert.strictEqual((await req("GET", "/api/account/me", undefined, from("198.51.100.1"))).status, 401, "no token");
      assert.strictEqual((await me("f".repeat(64))).status, 401, "unknown token");
    });

    await test("validation errors", async () => {
      const ok = { username: uniqueName(), email: "valid@example.com", password: "long enough" };
      const bad = async (patch, error) => {
        const r = await register(Object.assign({}, ok, patch), "198.51.100.2");
        assert.strictEqual(r.status, 400, JSON.stringify(patch));
        assert.deepStrictEqual(r.json, { error }, JSON.stringify(patch));
      };
      for (const username of ["ab", "  ab  ", "a".repeat(21), "bad!name", "tab\tname", "émile", 12345, undefined, ""]) {
        await bad({ username }, "invalid-username");
      }
      for (const email of ["nope", "a@b", "a@@b.com", "a b@c.com", "x".repeat(250) + "@a.com", "@example.com", 5, undefined]) {
        await bad({ email }, "invalid-email");
      }
      for (const password of ["short", "1234567", "x".repeat(129), 12345678, undefined]) {
        await bad({ password }, "weak-password");
      }
      // Limits are inclusive: 3 and 20 characters, 8 and 128.
      const edge = await register({ username: "abc", email: "edge@example.com", password: "x".repeat(128) }, "198.51.100.2");
      assert.strictEqual(edge.status, 200);
      const edge2 = await register({ username: "a".repeat(20), email: "edge2@example.com", password: "12345678" }, "198.51.100.2");
      assert.strictEqual(edge2.status, 200);
    });

    await test("usernames and emails are unique, ignoring case", async () => {
      const r = await register({ username: "player ONE", email: "other@example.com", password: "long enough" }, "198.51.100.3");
      assert.strictEqual(r.status, 409);
      assert.deepStrictEqual(r.json, { error: "username-taken" });
      const r2 = await register({ username: "Player  one ", email: "x@example.com", password: "long enough" }, "198.51.100.3");
      assert.deepStrictEqual(r2.json, { error: "username-taken" }, "collapsed spaces");
      const e = await register({ username: uniqueName(), email: "  P1@EXAMPLE.com", password: "long enough" }, "198.51.100.3");
      assert.strictEqual(e.status, 409);
      assert.deepStrictEqual(e.json, { error: "email-taken" });
      // Names that are object-prototype keys are ordinary accounts.
      const proto = await register({ username: "__proto__", email: "proto@example.com", password: "long enough" }, "198.51.100.3");
      assert.strictEqual(proto.status, 200);
      assert.strictEqual((await login("__PROTO__", "long enough", "198.51.100.3")).status, 200);
      assert.strictEqual((await login("constructor", "long enough", "198.51.100.3")).status, 401);
    });

    await test("unknown user and wrong password get the same answer", async () => {
      const a = await login("Nobody Here", "whatever123", "198.51.100.4");
      const b = await login("Player One", "wrong password", "198.51.100.4");
      assert.strictEqual(a.status, 401);
      assert.strictEqual(b.status, 401);
      assert.deepStrictEqual(a.json, { error: "wrong-credentials" });
      assert.deepStrictEqual(a.json, b.json);
      // Timing: both spend one scrypt (generous bound; just not "instant" vs "slow").
      const t = async (u, pw) => { const t0 = Date.now(); await login(u, pw, "198.51.100.4"); return Date.now() - t0; };
      const unknown = await t("Nobody Else", "whatever123");
      const wrong = await t("Player One", "wrong again");
      assert.ok(unknown > wrong / 4, `unknown user ${unknown} ms vs wrong password ${wrong} ms`);
    });

    await test("sign-up rate limit per address", async () => {
      const ip = "198.51.100.5";
      for (let i = 0; i < 5; i++) {
        const r = await register({ username: uniqueName("Burst"), email: `burst${i}@example.com`, password: "long enough" }, ip);
        assert.strictEqual(r.status, 200, "burst " + i);
      }
      const r = await register({ username: uniqueName("Burst"), email: "burst9@example.com", password: "long enough" }, ip);
      assert.strictEqual(r.status, 429);
      assert.deepStrictEqual(r.json, { error: "too-many-attempts" });
      const other = await register({ username: uniqueName("Burst"), email: "burst10@example.com", password: "long enough" }, "198.51.100.6");
      assert.strictEqual(other.status, 200, "other addresses unaffected");
    });

    await test("sign-in failure limits: per address and per username; right passwords don't count", async () => {
      const name = uniqueName("Target");
      assert.strictEqual((await register({ username: name, email: "target@example.com", password: "target pass" }, "198.51.100.7")).status, 200);
      for (let i = 0; i < 12; i++) assert.strictEqual((await login(name, "target pass", "198.51.100.8")).status, 200, "right " + i);

      const ip = "198.51.100.9";
      for (let i = 0; i < 10; i++) assert.strictEqual((await login("Somebody " + i, "wrong pass", ip)).status, 401);
      const blocked = await login(name, "target pass", ip);
      assert.strictEqual(blocked.status, 429, "address out of attempts");
      assert.deepStrictEqual(blocked.json, { error: "too-many-attempts" });

      for (let i = 0; i < 10; i++) assert.strictEqual((await login(name, "wrong pass", "203.0.113." + (100 + i))).status, 401);
      assert.strictEqual((await login(name, "target pass", "203.0.113.200")).status, 429, "username out of attempts");
      assert.strictEqual((await login("Player One", "correct horse", "203.0.113.201")).status, 200, "other usernames unaffected");
    });

    await test("the game's login needs a play grant from the same address", async () => {
      const ip = "203.0.113.10";
      const r0 = await gameLogin(p1.userID, ip);
      assert.strictEqual(r0.status, 403);
      assert.deepStrictEqual(r0.json, { errorCode: "account-required", error: "account-required" });

      assert.strictEqual((await req("POST", "/api/account/play", {}, from(ip))).status, 401, "play needs a token");
      const play = await req("POST", "/api/account/play", {}, bearer(p1.token, ip));
      assert.strictEqual(play.status, 200);
      assert.deepStrictEqual(play.json, { username: "Player One", userID: p1.userID });

      const ok = await gameLogin(p1.userID, ip);
      assert.strictEqual(ok.status, 200);
      assert.ok(ok.json.token, "game token");
      const sock = await srv.connect(ok.json.token);
      assert.ok(sock, "socket login with the game token");
      sock.close();
      assert.strictEqual((await gameLogin(p1.userID, ip)).status, 200, "again within the grant");
      assert.strictEqual((await gameLogin(p1.userID, "203.0.113.11")).status, 403, "another address");
      assert.strictEqual((await gameLogin("steam:76561198000000001", ip)).status, 403, "another user ID");
      assert.strictEqual((await gameLogin(p1.userID.slice(6), ip)).status, 200, "the bare number normalizes to the same ID");
      assert.ok(srv.profiles()[p1.userID].lastLoginIpHash, "last login address recorded (hashed)");
      assert.ok(!JSON.stringify(srv.profiles()).includes(ip), "no raw address in profiles.json");
    });

    let imported;
    await test("operator tools refuse anything proxied", async () => {
      for (const h of [{ "X-Forwarded-For": "1.2.3.4" }, { Via: "1.1 caddy" }, { "X-Real-IP": "1.2.3.4" }]) {
        const a = await req("POST", "/admin/import-profile", { username: "Player One", profile: { cullCredits: 1 } }, h);
        assert.strictEqual(a.status, 404, JSON.stringify(h));
        assert.deepStrictEqual(a.json, {});
        const b = await req("POST", "/admin/reset-password", { username: "Player One" }, h);
        assert.strictEqual(b.status, 404, JSON.stringify(h));
        assert.ok(!b.json.password);
      }
      assert.strictEqual((await me(p1.token)).status, 200, "nothing was reset");
    });

    await test("import replaces the profile, sanitized, and keeps a backup", async () => {
      // The level curve (the game's first report sets it).
      await req("POST", "/api/levelcurve", { high: [1999, 4999, 9999, 19999, 49999, 99999] });
      const catalog = JSON.parse(fs.readFileSync(path.join(srv.dir, "catalog.json"), "utf8"));
      const custom = catalog.find((i) => i.source && !i.rankedReward);
      const local = {
        userID: "steam:76561198000000042",
        cullCredits: 123456, premiumCurrency: "999999", economy: 1, cardID: 195041,
        owned: [custom.tid, custom.tid, 99999999, -1, "7"],
        stats: { xp: 50000, wins: 7, kills: 42, level: 1, gamesPlayed: 20, totalDamage: -50, bogus: 5 },
        ranked: { season: "S1", rating: 1300, mmr: 1250, matches: 9, wins: 2, peakRating: 1320, peakTier: "Hunter",
          pending: { id: "abc" }, processed: { m1: 1 }, history: [{ matchId: "m1", delta: -12, placement: 7 }], tiersReached: { Hunter: 1 } },
        lastMatch: { at: 1, xpEarned: 900, victory: true, kills: 3 },
        hacked: { anything: true }
      };
      // 1e999 is Infinity once parsed: must not reach profiles.json.
      const raw = JSON.stringify({ username: "player one", profile: local }).replace('"mmr":1250', '"mmr":1e999');
      const r = await req("POST", "/admin/import-profile", raw);
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual(r.json.userID, p1.userID);
      assert.deepStrictEqual(r.json.before, { credits: 10000, xp: 0, level: 1, wins: 0, kills: 0, owned: 0 });
      assert.deepStrictEqual(r.json.after, { credits: 123456, xp: 50000, level: 6, wins: 7, kills: 42, owned: 1 });
      const p = srv.profiles()[p1.userID];
      assert.strictEqual(p.userID, p1.userID, "the account's user ID, not the local one");
      assert.ok(!srv.profiles()["steam:76561198000000042"], "the local ID is not created");
      assert.strictEqual(p.premiumCurrency, 999999);
      assert.strictEqual(p.cardID, 195041);
      assert.deepStrictEqual(p.owned, [custom.tid]);
      assert.strictEqual(p.stats.totalDamage, 0, "negative replaced");
      assert.strictEqual(p.stats.gamesPlayed, 20);
      assert.ok(!("bogus" in p.stats) && !("hacked" in p), "unknown fields dropped");
      assert.strictEqual(p.ranked.rating, 1300);
      assert.strictEqual(p.ranked.mmr, 0, "Infinity replaced");
      assert.strictEqual(p.ranked.pending, null);
      assert.strictEqual(p.ranked.history[0].delta, -12, "rating changes keep their sign");
      assert.ok(p.lastLoginIpHash, "last login address kept");
      const backups = fs.readdirSync(path.join(srv.dir, "import-backups"));
      assert.strictEqual(backups.length, 1);
      assert.match(backups[0], /^steam_\d{17}-.+\.json$/);
      const old = JSON.parse(fs.readFileSync(path.join(srv.dir, "import-backups", backups[0]), "utf8"));
      assert.strictEqual(old.cullCredits, 10000);
      assert.strictEqual(old.userID, p1.userID);
      assert.strictEqual((await req("POST", "/admin/import-profile", { username: "Nobody Here", profile: {} })).status, 404);
      assert.strictEqual((await req("POST", "/admin/import-profile", { username: "Player One", profile: [] })).status, 400);
      imported = p;
    });

    await test("reset-password revokes every token and the play grant", async () => {
      const ip = "203.0.113.20";
      const t2 = (await login("Player One", "correct horse", ip)).json.token;
      await req("POST", "/api/account/play", {}, bearer(t2, ip));
      assert.strictEqual((await gameLogin(p1.userID, ip)).status, 200);
      const r = await req("POST", "/admin/reset-password", { username: "PLAYER ONE" });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(typeof r.json.password, "string");
      assert.strictEqual(r.json.password.length, 16);
      assert.ok(r.json.revokedTokens >= 2);
      assert.strictEqual((await me(p1.token)).status, 401);
      assert.strictEqual((await me(t2)).status, 401);
      assert.strictEqual((await gameLogin(p1.userID, ip)).status, 403, "grant revoked");
      assert.strictEqual((await login("Player One", "correct horse", ip)).status, 401, "old password");
      const l = await login("Player One", r.json.password, ip);
      assert.strictEqual(l.status, 200, "temporary password");
      p1.token = l.json.token;
      p1.password = r.json.password;
      assert.strictEqual(srv.profiles()[p1.userID].cullCredits, imported.cullCredits, "profile untouched");
    });

    await test("accounts.json and /metrics hold no passwords, tokens, raw addresses or emails", async () => {
      const text = fs.readFileSync(path.join(srv.dir, "accounts.json"), "utf8");
      for (const s of ["correct horse", "target pass", p1.password, p1.token, "203.0.113.20", "198.51.100.1"]) {
        assert.ok(!text.includes(s), "accounts.json contains " + s);
      }
      const saved = JSON.parse(text);
      assert.match(saved.accounts["player one"].password, /^scrypt\$32768\$8\$1\$/);
      assert.strictEqual(saved.accounts["player one"].email, "p1@example.com");
      const m = await req("GET", "/metrics");
      assert.strictEqual(m.status, 200);
      assert.ok(m.json.accounts.accounts >= 10);
      assert.ok(m.json.accounts.tokens >= 1);
      assert.strictEqual(m.json.accounts.required, true);
      assert.ok("loginIp" in m.json.rateLimiterKeys);
      assert.ok(m.json.saving.accounts.writes + m.json.saving.accounts.syncWrites >= 1);
      assert.ok(!JSON.stringify(m.json).includes("@example.com"), "no emails in /metrics");
      assert.strictEqual((await req("GET", "/metrics", undefined, from("1.2.3.4"))).status, 404);
    });

    await test("operator CLI: import from a local profiles.json, reset-password", async () => {
      const cli = path.join(__dirname, "..", "tools", "account_admin.js");
      const run = (...args) => new Promise((resolve) => {
        const p = spawn(process.execPath, [cli, "--port", "8129", ...args]);
        let out = "";
        p.stdout.on("data", (c) => (out += c));
        p.stderr.on("data", (c) => (out += c));
        p.on("exit", (code) => resolve({ code, out }));
      });
      const local = path.join(srv.dir, "local-profiles.json");
      fs.writeFileSync(local, JSON.stringify({ "steam:76561198011111111": { cullCredits: 777, economy: 1, owned: [],
        stats: { xp: 2500, wins: 3, kills: 9 } } }));
      const r = await run("import", "Player One", local, "76561198011111111");
      assert.strictEqual(r.code, 0, r.out);
      assert.match(r.out, /after: {2}credits 777, xp 2500, level 2, wins 3, kills 9, owned 0/);
      assert.strictEqual(srv.profiles()[p1.userID].cullCredits, 777);
      assert.strictEqual(fs.readdirSync(path.join(srv.dir, "import-backups")).length, 2);
      const missing = await run("import", "Player One", local, "steam:1");
      assert.strictEqual(missing.code, 1);
      const reset = await run("reset-password", "player one");
      assert.strictEqual(reset.code, 0, reset.out);
      const pw = reset.out.match(/temporary password for Player One: (\S{16})/)[1];
      assert.strictEqual((await me(p1.token)).status, 401);
      assert.strictEqual((await login("Player One", pw, "203.0.113.40")).status, 200);
      assert.strictEqual((await run("reset-password", "Nobody Here")).code, 1);
    });
  } finally {
    srv.stop();
  }

  // ---- claiming an existing profile (players from before accounts existed)
  const old = startServer(8131, { vars: { CULLING_REQUIRE_ACCOUNT: "0" } });
  try {
    await old.ready();
    await test("a profile is claimed only from its last login address, and only once", async () => {
      const id = "steam:76561198000000777";
      const g = await old.request("POST", "/api/login", { userid: id }, from("192.0.2.50"));
      assert.strictEqual(g.status, 200, "without enforcement the game logs in as before");
      const reg = (name, ip, claimUserID) => old.request("POST", "/api/account/register",
        { username: name, email: name.replace(/\W/g, "") + "@example.com", password: "long enough", claimUserID }, from(ip));

      const elsewhere = await reg("Claimer A", "192.0.2.51", id);
      assert.strictEqual(elsewhere.status, 200);
      assert.strictEqual(elsewhere.json.claimed, false, "another address");
      assert.notStrictEqual(elsewhere.json.userID, id);

      const missing = await reg("Claimer B", "192.0.2.50", "steam:76561198000000999");
      assert.strictEqual(missing.json.claimed, false, "no such profile");
      assert.ok(!old.profiles()["steam:76561198000000999"]);

      const malformed = await reg("Claimer C", "192.0.2.50", "constructor");
      assert.strictEqual(malformed.json.claimed, false);

      const ok = await reg("Claimer D", "192.0.2.50", id);
      assert.strictEqual(ok.status, 200);
      assert.strictEqual(ok.json.claimed, true);
      assert.strictEqual(ok.json.userID, id);

      const again = await reg("Claimer E", "192.0.2.50", id);
      assert.strictEqual(again.json.claimed, false, "already owned");
      assert.notStrictEqual(again.json.userID, id);
      const m = await old.request("GET", "/api/account/me", undefined, bearer(ok.json.token, "192.0.2.50"));
      assert.strictEqual(m.json.userID, id);
    });
  } finally {
    old.stop();
  }

  await test("accounts, tokens and play grants survive a graceful restart", () => restartKeepsAccounts(8130));
}

// ---- graceful stop and restart (the way the service is stopped; see shutdown.test.js)

const SERVER = path.join(__dirname, "..", "server.js");
const PS_HELPER = path.join(__dirname, "winsw_stop.ps1");

function request(port, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: "127.0.0.1", port, path: url, method,
      headers: Object.assign({ "Content-Type": "application/json" }, headers) }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* */ } resolve({ status: res.statusCode, json }); });
    });
    r.on("error", reject);
    if (body !== undefined) r.write(JSON.stringify(body));
    r.end();
  });
}

// Waits for the server just launched (pid), not something else on the port.
async function waitUp(port, pid) {
  for (let i = 0; i < 100; i++) {
    let m;
    try { m = await request(port, "GET", "/metrics"); } catch { await sleep(100); continue; }
    if (m.json && m.json.pid === pid) return;
    throw new Error(`port ${port} is answered by pid ${m.json && m.json.pid}, not the server just started (${pid})`);
  }
  throw new Error("server did not start");
}

// A 60 s save interval: only the first change is written at once, so what
// follows is on disk only if the stop handler wrote it.
function launch(port, dir) {
  const env = Object.assign({}, process.env, { CULLING_PORT: String(port), CULLING_DATA_DIR: dir,
    CULLING_SAVE_DELAY_MS: "60000", CULLING_REQUIRE_ACCOUNT: "1" });
  if (process.platform === "win32") {
    const pidFile = path.join(dir, "server.pid");
    try { fs.unlinkSync(pidFile); } catch { /* none */ }
    execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_HELPER, "-Start",
      "-Exe", process.execPath, "-Arguments", `"${SERVER}"`, "-PidFile", pidFile], { env, stdio: "ignore" });
    const pid = parseInt(fs.readFileSync(pidFile, "utf8"), 10);
    return {
      pid,
      stop: () => execFileSync("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_HELPER, "-Stop",
        "-ProcessId", String(pid), "-TimeoutSeconds", "15"], { encoding: "utf8" }).trim(),
      kill: () => { try { process.kill(pid); } catch { /* gone */ } }
    };
  }
  const proc = spawn(process.execPath, [SERVER], { env, stdio: "ignore" });
  const exited = new Promise((resolve) => proc.on("exit", (code) => resolve(code)));
  return {
    pid: proc.pid,
    stop: async () => { proc.kill("SIGTERM"); return "exited " + (await exited); },
    kill: () => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }
  };
}

async function restartKeepsAccounts(port) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "culling-accounts-"));
  fs.copyFileSync(path.join(__dirname, "..", "data", "catalog.json"), path.join(dir, "catalog.json"));
  const ip = "203.0.113.30";
  let srv = launch(port, dir);
  try {
    await waitUp(port, srv.pid);
    const reg = await request(port, "POST", "/api/account/register",
      { username: "Restart Me", email: "restart@example.com", password: "survives restarts" }, from(ip));
    assert.strictEqual(reg.status, 200);
    await sleep(300);
    // In memory only (next write due in 60 s): a second token and a play grant.
    const l = await request(port, "POST", "/api/account/login", { username: "restart me", password: "survives restarts" }, from(ip));
    assert.strictEqual(l.status, 200);
    assert.strictEqual((await request(port, "POST", "/api/account/play", {}, bearer(l.json.token, ip))).status, 200);
    const onDisk = fs.readFileSync(path.join(dir, "accounts.json"), "utf8");
    assert.strictEqual(Object.keys(JSON.parse(onDisk).grants).length, 0, "grant not on disk before the stop");

    assert.strictEqual(await srv.stop(), "exited 0", "stopped gracefully");
    const saved = JSON.parse(fs.readFileSync(path.join(dir, "accounts.json"), "utf8"));
    assert.strictEqual(Object.keys(saved.grants).length, 1, "grant saved on stop");
    assert.strictEqual(Object.keys(saved.tokens).length, 2, "both tokens saved on stop");

    srv = launch(port, dir);
    await waitUp(port, srv.pid);
    const m = await request(port, "GET", "/api/account/me", undefined, bearer(l.json.token, ip));
    assert.strictEqual(m.status, 200, "token still valid");
    assert.strictEqual(m.json.userID, reg.json.userID);
    const g = await request(port, "POST", "/api/login", { userid: reg.json.userID }, from(ip));
    assert.strictEqual(g.status, 200, "play grant still valid: a restart mid-session doesn't kick the player");
    const again = await request(port, "POST", "/api/account/login", { username: "Restart Me", password: "survives restarts" }, from(ip));
    assert.strictEqual(again.status, 200, "password still valid");
    const dup = await request(port, "POST", "/api/account/register",
      { username: "restart me", email: "new@example.com", password: "long enough" }, from("203.0.113.31"));
    assert.strictEqual(dup.status, 409, "username still taken");
    assert.strictEqual(await srv.stop(), "exited 0");
  } finally {
    srv.kill();
    await sleep(100);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().then(() => console.log("all %d account tests passed", passed), (e) => {
  console.error("FAIL", e.stack || e.message);
  process.exitCode = 1;
});
