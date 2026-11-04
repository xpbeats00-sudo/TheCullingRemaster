// Remaster accounts: the client against a stand-in account server, the saved
// sign-in, and the Steam ID written for the game.
"use strict";

const assert = require("assert");
const fs = require("fs");
const http = require("http");
const os = require("os");
const path = require("path");
const account = require("../lib/account");
const playername = require("../lib/playername");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-account-"));
let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

// A stand-in for the account server's /api/account routes.
function fakeServer() {
  const seen = [];
  const users = { reaper: { username: "Reaper", password: "correct horse", userID: "steam:76561198000000101", token: "t-reaper" } };
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => { body += c; });
    req.on("end", () => {
      const json = body ? JSON.parse(body) : {};
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization || null, body: json });
      const send = (status, obj) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(obj)); };
      if (req.url === "/api/account/register") {
        if (users[json.username.toLowerCase()]) return send(409, { error: "username-taken" });
        return send(200, { token: "t-new", username: json.username, userID: "steam:76561201234567890", claimed: !!json.claimUserID });
      }
      if (req.url === "/api/account/login") {
        const u = users[String(json.username).toLowerCase()];
        if (!u || u.password !== json.password) return send(401, { error: "wrong-credentials" });
        return send(200, { token: u.token, username: u.username, userID: u.userID });
      }
      if (req.url === "/api/account/play") {
        if (req.headers.authorization !== "Bearer t-reaper") return send(401, { error: "signed-out" });
        return send(200, { username: "Reaper", userID: "steam:76561198000000101" });
      }
      if (req.url === "/api/account/limited") return send(429, { error: "too-many-attempts" });
      send(500, { error: "server-error" });
    });
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve({ server, seen, api: `http://127.0.0.1:${server.address().port}/api` })));
}

// safeStorage stand-in: reversible, and visibly not plain text.
const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (s) => Buffer.from("enc:" + Buffer.from(s).toString("base64")),
  decryptString: (b) => Buffer.from(String(b).slice(4), "base64").toString()
});

function install(root) {
  const dir = path.join(root, "Engine", "Binaries", "ThirdParty", "Steamworks", "Steamv136", "Win64", "steam_settings");
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

(async () => {
  const { server, seen, api } = await fakeServer();
  const client = account.createClient(fetch, 5000);
  try {
    await test("form rules match the server's", () => {
      assert.deepStrictEqual(account.checkUsername("  Reaper   99 "), { name: "Reaper 99" });
      for (const bad of ["a", "x".repeat(21), "Ñandú", "a<b", "emoji 😀", ""]) assert.ok(account.checkUsername(bad).error, bad);
      assert.deepStrictEqual(account.checkEmail(" Player@Example.COM "), { email: "player@example.com" });
      for (const bad of ["player", "a@b", "a@b.c", "a b@c.de", "@c.de"]) assert.ok(account.checkEmail(bad).error, bad);
      assert.ok(account.checkPassword("short").error);
      assert.ok(account.checkPassword("x".repeat(129)).error);
      assert.ok(account.checkPassword("long enough").password);
    });

    await test("creating an account sends the claim and returns the sign-in", async () => {
      const a = await client.register(api, { username: " New  Player ", email: "New@Example.com", password: "long enough", claimUserID: "steam:76561199752700292" });
      assert.deepStrictEqual(a, { username: "New Player", userID: "steam:76561201234567890", token: "t-new", claimed: true });
      const req = seen[seen.length - 1];
      assert.deepStrictEqual(req.body, { username: "New Player", email: "new@example.com", password: "long enough", claimUserID: "steam:76561199752700292" });
    });

    await test("bad forms are refused before anything is sent", async () => {
      const before = seen.length;
      await assert.rejects(client.register(api, { username: "a", email: "a@b.cd", password: "long enough" }), /2 to 20/);
      await assert.rejects(client.register(api, { username: "Fine", email: "nope", password: "long enough" }), /valid email/);
      await assert.rejects(client.login(api, { username: "", password: "" }), /username and password/);
      assert.strictEqual(seen.length, before);
    });

    await test("server errors read as messages a player can act on", async () => {
      await assert.rejects(client.register(api, { username: "reaper", email: "r@example.com", password: "long enough" }), (e) => e.code === "username-taken" && /taken/.test(e.message));
      await assert.rejects(client.login(api, { username: "Reaper", password: "wrong password" }), (e) => e.code === "wrong-credentials" && /Wrong username or password/.test(e.message));
      await assert.rejects(client.play(api, "t-old"), (e) => e.code === "signed-out");
      await assert.rejects(client.me(api.replace(/\/api$/, "/api/account/limited#"), "x"), (e) => e.code === "too-many-attempts");
      await assert.rejects(client.login("http://127.0.0.1:1/api", { username: "a", password: "b" }), (e) => e.code === "network" && /Can't reach the account server/.test(e.message));
    });

    await test("signing in and the play grant use the token", async () => {
      const a = await client.login(api, { username: "reaper", password: "correct horse" });
      assert.strictEqual(a.token, "t-reaper");
      const grant = await client.play(api, a.token);
      assert.deepStrictEqual(grant, { username: "Reaper", userID: "steam:76561198000000101" });
      assert.strictEqual(seen[seen.length - 1].auth, "Bearer t-reaper");
    });

    await test("the saved sign-in is encrypted, per server, and never holds the password", () => {
      const file = path.join(tmp, "account.dat");
      const store = account.createStore(file, fakeSafe());
      store.set("xplab", { username: "Reaper", userID: "steam:76561198000000101", token: "t-reaper", password: "correct horse" });
      const raw = fs.readFileSync(file, "utf8");
      assert.ok(raw.startsWith("enc:") && !raw.includes("t-reaper"), "written encrypted");
      assert.ok(!Buffer.from(raw.slice(4), "base64").toString().includes("correct horse"), "no password");
      const again = account.createStore(file, fakeSafe());
      assert.deepStrictEqual(again.get("xplab"), { username: "Reaper", userID: "steam:76561198000000101", token: "t-reaper" });
      assert.strictEqual(again.get("other"), null);
      again.remove("xplab");
      assert.strictEqual(account.createStore(file, fakeSafe()).get("xplab"), null);
    });

    await test("without OS encryption nothing is written: the sign-in lasts until the launcher closes", () => {
      const file = path.join(tmp, "plain.dat");
      const store = account.createStore(file, fakeSafe(false));
      store.set("xplab", { username: "Reaper", userID: "steam:76561198000000101", token: "t-reaper" });
      assert.ok(store.get("xplab"));
      assert.ok(!fs.existsSync(file));
    });

    await test("an unreadable saved sign-in just means signing in again", () => {
      const file = path.join(tmp, "broken.dat");
      fs.writeFileSync(file, "garbage");
      assert.strictEqual(account.createStore(file, fakeSafe()).get("xplab"), null);
    });

    await test("the game is pointed at the account's Steam ID; an older ID is kept once", () => {
      const root = path.join(tmp, "game");
      const dir = install(root);
      fs.writeFileSync(path.join(dir, "force_steamid.txt"), "76561199752700292");
      assert.strictEqual(playername.readSteamId(root), "steam:76561199752700292");
      playername.writeSteamId(root, "steam:76561201234567890");
      assert.strictEqual(fs.readFileSync(path.join(dir, "force_steamid.txt"), "utf8"), "76561201234567890");
      assert.strictEqual(fs.readFileSync(path.join(dir, "force_steamid.txt.before-account"), "utf8"), "76561199752700292");
      playername.writeSteamId(root, "steam:76561198000000101");
      assert.strictEqual(fs.readFileSync(path.join(dir, "force_steamid.txt.before-account"), "utf8"), "76561199752700292", "the first one is kept");
      assert.throws(() => playername.writeSteamId(root, "steam:123"), /not a Steam ID/);
    });

    await test("without a forced ID, the PC-wide emulator ID is the one to claim", () => {
      const root = path.join(tmp, "game2");
      install(root);
      const appData = path.join(tmp, "appdata");
      const settings = path.join(appData, "Goldberg SteamEmu Saves", "settings");
      fs.mkdirSync(settings, { recursive: true });
      assert.strictEqual(playername.readSteamId(root, appData), null);
      fs.writeFileSync(path.join(settings, "user_steam_id.txt"), "76561199752700292\r\n");
      assert.strictEqual(playername.readSteamId(root, appData), "steam:76561199752700292");
    });

    await test("an install that uses real Steam can't take an account", () => {
      const root = path.join(tmp, "steamcopy");
      fs.mkdirSync(path.join(root, "Engine", "Binaries", "ThirdParty", "Steamworks", "Steamv136", "Win64"), { recursive: true });
      assert.throws(() => playername.writeSteamId(root, "steam:76561198000000101"), /uses your Steam account/);
    });

    console.log("all %d account tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    server.close();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})();
