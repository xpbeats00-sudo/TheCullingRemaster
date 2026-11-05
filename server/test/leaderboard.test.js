// The global leaderboard.
// Part 1: the rules (server/leaderboard.js) - ordering and shared positions,
// the K/D threshold, this season's ranked only, your own row outside the top,
// the cache. Part 2: a throwaway server seeded with 60 account players and
// some profiles without an account - only account players by username, no
// IDs, your own row, a result showing up, the rate limit.
"use strict";

const assert = require("assert");
const ranked = require("../ranked");
const { Leaderboard, BOARDS } = require("../leaderboard");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SEASON = ranked.CONFIG.season.id;

function profile(userID, s = {}) {
  const p = {
    userID, cullCredits: 10000, premiumCurrency: 999999, owned: [], economy: 1, cardID: s.cardID || 0, createdAt: 1,
    stats: { gamesPlayed: s.games || 0, wins: s.wins || 0, kills: s.kills || 0, level: s.level || 1, xp: 0,
      minutesAlive: s.minutes || 0, totalDamage: 0, funcEarned: 0, rank: 0, mmr: 0 }
  };
  if (s.showdown) p.showdown = s.showdown;
  if (s.rating !== undefined) {
    p.ranked = { season: s.season || SEASON, rating: s.rating, mmr: s.rating, matches: s.rankedMatches || 5, wins: s.rankedWins || 0,
      peakRating: s.rating, peakTier: ranked.tierFor(s.rating).name, pending: null, processed: {}, history: [], tiersReached: {} };
  }
  return p;
}

// A board built from [{ userID, username, profile }].
function board(list, opts = {}) {
  return new Leaderboard(Object.assign({ players: () => list, ranked, minAgeMs: 0 }, opts));
}
const who = (userID, username, s) => ({ userID, username, profile: profile(userID, s) });
const get = (view, id) => view.boards.find((b) => b.id === id);

(async () => {
  // ------------------------------------------------------------ rules
  await test("every board is there, best first; ties share a position", async () => {
    const lb = board([
      who("a", "Ann", { games: 10, wins: 3, kills: 20 }),
      who("b", "Bob", { games: 10, wins: 5, kills: 20 }),
      who("c", "Cat", { games: 4, wins: 3, kills: 30 }),
      who("d", "Dan", { games: 0 })
    ]);
    const v = lb.view(null);
    assert.deepStrictEqual(v.boards.map((b) => b.id), BOARDS);
    const wins = get(v, "wins");
    assert.deepStrictEqual(wins.top.map((e) => [e.position, e.username, e.value]), [[1, "Bob", 5], [2, "Cat", 3], [2, "Ann", 3]],
      "Cat's 3 wins came in fewer matches: listed first, same position");
    assert.strictEqual(wins.players, 3, "no wins: not listed");
    assert.deepStrictEqual(get(v, "kills").top.map((e) => [e.position, e.username]), [[1, "Cat"], [2, "Ann"], [2, "Bob"]]);
    assert.strictEqual(get(v, "time").players, 0, "no time played yet");
    assert.strictEqual(v.you, null);
  });

  await test("K/D needs the minimum matches; deaths are matches not won", async () => {
    const lb = board([
      who("a", "OneHit", { games: 1, wins: 0, kills: 40 }),
      who("b", "Steady", { games: 12, wins: 2, kills: 25 }),      // 25 / 10
      who("c", "Ace", { games: 10, wins: 10, kills: 31 })         // never died: K/D is the kills
    ], { minMatches: 10 });
    const kd = get(lb.view("a"), "kd");
    assert.deepStrictEqual(kd.top.map((e) => [e.username, e.value]), [["Ace", 31], ["Steady", 2.5]]);
    assert.deepStrictEqual([kd.top[1].kills, kd.top[1].deaths, kd.top[1].matches], [25, 10, 12]);
    assert.deepStrictEqual([kd.you.position, kd.you.value, kd.you.needMatches], [null, 40, 9], "listed after 9 more matches");
  });

  await test("ranked: this season's rating and tier, within the season cap; last season's not listed", async () => {
    const lb = board([
      who("a", "Old", { games: 5, rating: 1300, season: "S0" }),
      who("b", "Mid", { games: 5, rating: 1100, rankedWins: 2 }),
      who("c", "Top", { games: 5, rating: 9000 }),
      who("d", "Fresh", { games: 0 })
    ]);
    const r = get(lb.view("d"), "ranked");
    assert.deepStrictEqual(r.top.map((e) => [e.username, e.value, e.rank]),
      [["Top", ranked.CONFIG.maxRating, "Hunter"], ["Mid", 1100, "Blooded"]]);
    assert.deepStrictEqual([r.top[1].matches, r.top[1].wins], [5, 2]);
    assert.strictEqual(r.you.position, null, "no ranked matches this season");
    assert.strictEqual(r.you.value, null);
  });

  await test("the top 50, and your own row and position outside it", async () => {
    const list = [];
    for (let i = 1; i <= 60; i++) list.push(who("u" + i, "Player" + String(i).padStart(2, "0"), { games: 70, wins: i, kills: 2 * i, minutes: i }));
    const lb = board(list);
    const v = lb.view("u3");
    const wins = get(v, "wins");
    assert.strictEqual(wins.top.length, 50);
    assert.strictEqual(wins.players, 60);
    assert.deepStrictEqual([wins.top[0].username, wins.top[49].username], ["Player60", "Player11"]);
    assert.deepStrictEqual([wins.you.username, wins.you.position, wins.you.value], ["Player03", 58, 3]);
    assert.strictEqual(get(v, "time").you.position, 58);
    assert.strictEqual(v.you, "Player03");
    assert.strictEqual(lb.view("u60").boards[1].you.position, 1);
  });

  await test("computed once, again only after a change and the minimum age, or the TTL", async () => {
    let t = 0;
    const list = [who("a", "Ann", { games: 1, wins: 1 })];
    const lb = board(list, { now: () => t, minAgeMs: 30000, ttlMs: 300000 });
    lb.view("a"); lb.view("a"); lb.view(null);
    assert.strictEqual(lb.computations, 1);
    list[0].profile.stats.wins = 7;
    lb.changed();
    t = 10000;
    assert.strictEqual(get(lb.view("a"), "wins").you.value, 1, "too soon: the cached board");
    t = 30000;
    assert.strictEqual(get(lb.view("a"), "wins").you.value, 7, "recomputed after the change");
    assert.strictEqual(lb.computations, 2);
    t = 200000;
    lb.view("a");
    assert.strictEqual(lb.computations, 2, "nothing changed");
    t = 330000;
    lb.view("a");
    assert.strictEqual(lb.computations, 3, "the TTL");
  });

  await test("players without a username are never listed", async () => {
    const lb = board([who("a", null, { games: 9, wins: 9 }), who("b", "", { games: 9, wins: 9 }), who("c", "Real", { games: 1, wins: 1 })]);
    assert.deepStrictEqual(get(lb.view("a"), "wins").top.map((e) => e.username), ["Real"]);
    assert.strictEqual(lb.view("a").you, null);
  });

  // ------------------------------------------------------------ server
  const accounts = {}, profiles = {};
  const id = (n) => "steam:7656119" + String(n).padStart(10, "0");
  for (let i = 1; i <= 60; i++) {
    const userID = id(i), username = "Player" + String(i).padStart(2, "0");
    accounts[username.toLowerCase()] = { username, email: "p" + i + "@example.com", userID, password: "x", createdAt: 1 };
    profiles[userID] = profile(userID, { games: 20, wins: i, kills: 3 * i, minutes: 10 * i, level: 1 + (i % 14), cardID: 1000 + i,
      rating: i % 2 ? 800 + 10 * i : undefined, showdown: i % 3 ? { won: i, lost: 1 } : undefined });
  }
  // A one-match wonder with an account: top of kills, never of K/D.
  accounts.lucky = { username: "Lucky", email: "lucky@example.com", userID: id(61), password: "x", createdAt: 1 };
  profiles[id(61)] = profile(id(61), { games: 1, wins: 0, kills: 500 });
  // Profiles without an account, with more of everything: never listed.
  for (let i = 100; i < 105; i++) profiles[id(i)] = profile(id(i), { games: 999, wins: 999, kills: 9999, minutes: 99999, rating: 1399 });

  const srv = startServer({ profiles, files: { "accounts.json": { version: 1, accounts, tokens: {}, grants: {} } },
    vars: { CULLING_LEADERBOARD_MIN_AGE_MS: "0" } });
  const sockets = [];
  try {
    await srv.ready();
    async function player(userID) {
      const token = await srv.login(userID);
      const socket = await srv.connect(token);
      sockets.push(socket);
      return { userID, token, socket };
    }
    async function ask(p) {
      const r = next(p.socket, "remaster-leaderboard");
      p.socket.emit("remaster-leaderboard-get");
      return r;
    }
    const low = await player(id(2));
    const top = await player(id(60));

    let first;
    await test("the server's boards: top 50 by username, best first", async () => {
      first = await ask(low);
      assert.deepStrictEqual(first.boards.map((b) => b.id), BOARDS);
      assert.deepStrictEqual([first.size, first.minMatches, first.season.id], [50, 10, SEASON]);
      const wins = get(first, "wins");
      assert.strictEqual(wins.top.length, 50);
      assert.deepStrictEqual(wins.top.slice(0, 3).map((e) => [e.position, e.username, e.value]),
        [[1, "Player60", 60], [2, "Player59", 59], [3, "Player58", 58]]);
      assert.strictEqual(wins.top[0].level, 1 + (60 % 14));
      assert.strictEqual(wins.top[0].cardID, 1060);
      const kills = get(first, "kills");
      assert.deepStrictEqual([kills.top[0].username, kills.top[0].value], ["Lucky", 500]);
      assert.ok(!get(first, "kd").top.some((e) => e.username === "Lucky"), "one match: not on K/D");
      const r = get(first, "ranked");
      assert.strictEqual(r.players, 30, "the odd-numbered players have a ranked season");
      assert.deepStrictEqual([r.top[0].username, r.top[0].value, r.top[0].rank], ["Player59", 1390, "Hunter"]);
      assert.strictEqual(get(first, "showdown").top[0].username, "Player59");
    });

    await test("only account players are listed, and nothing has an ID", async () => {
      const text = JSON.stringify(first);
      assert.ok(!/steam:|7656119/.test(text), "no Steam IDs or userIDs");
      for (const b of first.boards) {
        for (const e of b.top.concat(b.you ? [b.you] : [])) {
          assert.ok(/^(Player\d\d|Lucky)$/.test(e.username), e.username);
          for (const k of Object.keys(e)) {
            assert.ok(["position", "username", "level", "rank", "cardID", "value", "matches", "wins", "kills", "deaths", "lost",
              "needMatches"].includes(k), "field " + k);
          }
        }
        assert.ok(b.players <= 61, b.id + ": profiles without an account aren't counted");
      }
      assert.ok(!get(first, "wins").top.some((e) => e.value === 999));
    });

    await test("your own row and position, outside the top 50", async () => {
      assert.strictEqual(first.you, "Player02");
      const wins = get(first, "wins");
      assert.ok(!wins.top.some((e) => e.username === "Player02"));
      assert.deepStrictEqual([wins.you.username, wins.you.position, wins.you.value], ["Player02", 59, 2]);
      assert.strictEqual(get(first, "ranked").you.position, null, "even-numbered: no ranked season");
      assert.strictEqual(get(first, "kd").you.position !== null, true, "20 matches: on K/D");
      const t = await ask(top);
      assert.deepStrictEqual([get(t, "wins").you.position, t.you], [1, "Player60"]);
    });

    await test("a finished match shows up (the minimum age is 0 here)", async () => {
      const ready = next(low.socket, "match-ready");
      low.socket.emit("join-mm", { queueName: "ffa_jungle" });
      await ready;
      const r = await srv.request("POST", "/api/matchresult", { victory: true, kills: 4, damage: 100, timeAlive: 300, placement: 1, cap: 24 },
        { Authorization: "Bearer " + low.token });
      assert.strictEqual(r.status, 200);
      const after = await ask(low);
      assert.deepStrictEqual([get(after, "wins").you.value, get(after, "wins").you.position], [3, 58]);
    });

    await test("players without an account see the boards but have no row", async () => {
      const guest = await player("steam:76561190000000999");
      const v = await ask(guest);
      assert.strictEqual(v.you, null);
      assert.ok(v.boards.every((b) => b.you === null));
      assert.strictEqual(get(v, "wins").top.length, 50);
    });

    await test("a socket that hasn't logged in gets nothing", async () => {
      const raw = require("socket.io-client")("http://127.0.0.1:" + srv.port, { transports: ["websocket"], forceNew: true, reconnection: false });
      sockets.push(raw);
      await next(raw, "login_ready");
      let got = false;
      raw.on("remaster-leaderboard", () => { got = true; });
      raw.emit("remaster-leaderboard-get");
      await sleep(300);
      assert.strictEqual(got, false);
    });

    await test("leaderboard requests are rate limited", async () => {
      const got = [];
      top.socket.on("remaster-leaderboard", (m) => got.push(m.error || "ok"));
      for (let i = 0; i < 12; i++) top.socket.emit("remaster-leaderboard-get");
      await sleep(500);
      assert.strictEqual(got.length, 12);
      assert.ok(got.filter((e) => e === "slow-down").length >= 6, got.join());
      assert.ok(got.filter((e) => e === "ok").length >= 4, got.join());
    });

    console.log("all %d leaderboard tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
})();
