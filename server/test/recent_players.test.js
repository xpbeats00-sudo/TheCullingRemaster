// Recent players (server/recentplayers.js, docs/RECENT_PLAYERS_SYSTEM.md).
// Part 1: the rules, on the class (recording, dedupe, the limit, blocks,
// privacy, join requests and their expiry, pair cooldowns, reports, saving).
// Part 2: real logged-in socket.io clients against spawned servers: who is
// recorded from a real lobby launch (and nothing a client sends), dedupe,
// what the list shows (and no private fields), friend requests, invites, join
// requests (privacy, room, mode, queue), blocks both ways, reports for the
// operator, removing, banned and deleted accounts, the limit, rate limits and
// expiry.
//
// Matches run on each player's own PC with AI contestants: what the server
// can confirm is the account players one lobby sent into one match (one match
// id), and who was in the same party. That is what is recorded.
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RecentPlayers, PRIVACY } = require("../recentplayers");
const { Friends } = require("../friends");
const { startServer } = require("./helpers");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok    " + name); } catch (e) {
    failed++;
    console.log("FAIL  " + name + "\n      " + (e.stack || e.message).split("\n").slice(0, 4).join("\n      "));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// A match's participants as the server hands them over.
const match = (id, people, extra = {}) => Object.assign({ matchId: id, playlist: "ffa", map: "jungle",
  participants: people.map((p) => (typeof p === "string" ? { userID: p, name: p.toUpperCase() } : p)) }, extra);

// Keys and values that must never reach another player.
const PRIVATE_KEYS = new Set(["userID", "userId", "with", "email", "ip", "ipHash", "knownIps", "password", "lastLoginIpHash",
  "partyId", "matchId", "lobbyId", "steamId", "steamID", "token", "from_userID"]);
function privateLeaks(payload, ids) {
  const out = [];
  (function walk(v, where) {
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, where + "[" + i + "]"));
    if (v && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) {
        if (PRIVATE_KEYS.has(k)) out.push(where + "." + k);
        walk(x, where + "." + k);
      }
      return;
    }
    if (typeof v === "string" && (/@/.test(v) || /^steam:/.test(v) || ids.includes(v))) out.push(where + " = " + v);
  })(payload, "$");
  return out;
}

(async () => {
  // ------------------------------------------------------------ rules

  await test("recordMatch records every pair both ways: party teammates and the same lobby", async () => {
    const r = new RecentPlayers(null, { now: () => 1000 });
    const n = r.recordMatch(match("m1", [{ userID: "a", name: "Ann", partyId: "p1" }, { userID: "b", name: "Bo", partyId: "p1" },
      { userID: "c", name: "Cy" }], { playlist: "coop2", map: "prison" }));
    assert.strictEqual(n, 6, "3 players: 6 entries");
    const a = r.list("a");
    assert.deepStrictEqual(a.map((e) => [e.with, e.name, e.relation]).sort(), [["b", "Bo", "party"], ["c", "Cy", "lobby"]]);
    assert.deepStrictEqual([a[0].playlist, a[0].map, a[0].matchId, a[0].playedAt, a[0].lastInteraction, a[0].source],
      ["coop2", "prison", "m1", 1000, 1000, "lobby"]);
    assert.strictEqual(r.entry("c", "a").relation, "lobby", "c wasn't in their party");
  });

  await test("nothing is recorded for one player, duplicates, or malformed ids", async () => {
    const r = new RecentPlayers(null);
    assert.strictEqual(r.recordMatch(match("m", ["a"])), 0);
    assert.strictEqual(r.recordMatch(match("m", ["a", "a", { userID: "" }, { userID: 5 }, null, { userID: "x y" }])), 0);
    assert.strictEqual(r.recordMatch(null), 0);
    assert.strictEqual(r.recordMatch({ participants: "a,b" }), 0);
    assert.deepStrictEqual(r.list("a"), []);
  });

  await test("one entry per pair: the latest match is kept (an older one arriving late is not)", async () => {
    let t = 1000;
    const r = new RecentPlayers(null, { now: () => t });
    r.recordMatch(match("m1", ["a", "b"], { playlist: "ffa" }));
    t = 2000;
    r.recordMatch(match("m2", ["a", "b"], { playlist: "coop2" }));
    assert.strictEqual(r.list("a").length, 1);
    assert.deepStrictEqual([r.entry("a", "b").matchId, r.entry("a", "b").playlist, r.entry("a", "b").playedAt], ["m2", "coop2", 2000]);
    r.recordMatch(match("m0", ["a", "b"], { at: 500 }));
    assert.strictEqual(r.entry("a", "b").matchId, "m2", "a late, older match doesn't replace the newer one");
    t = 3000;
    assert.ok(r.touch("a", "b"));
    t = 4000;
    r.recordMatch(match("m3", ["a", "b"]));
    assert.strictEqual(r.entry("a", "b").lastInteraction, 4000);
  });

  await test("the history limit keeps each player's newest entries", async () => {
    let t = 0;
    const r = new RecentPlayers(null, { now: () => t, options: { limit: 3 } });
    for (const other of ["b", "c", "d", "e", "f"]) { t += 1000; r.recordMatch(match("m-" + other, ["a", other])); }
    assert.deepStrictEqual(r.list("a").map((e) => e.with), ["f", "e", "d"], "newest first, 3 kept");
    assert.deepStrictEqual(r.list("b").map((e) => e.with), ["a"], "the others keep theirs");
  });

  await test("teams from a shared match's roster: team, opponent; a party still reads as party", async () => {
    const r = new RecentPlayers(null);
    r.recordMatch(match("s1", [{ userID: "a", team: 0, partyId: "p" }, { userID: "b", team: 0, partyId: "p" },
      { userID: "c", team: 0 }, { userID: "d", team: 1 }], { source: "match" }));
    assert.deepStrictEqual(["b", "c", "d"].map((x) => r.entry("a", x).relation), ["party", "team", "opponent"]);
    r.recordMatch(match("s2", ["e", "f"], { source: "match" }));
    assert.strictEqual(r.entry("e", "f").relation, "match");
    assert.strictEqual(r.entry("e", "f").source, "match");
  });

  await test("blocks work both ways; the privacy setting decides who may invite or ask to join", async () => {
    const r = new RecentPlayers(null);
    r.recordMatch(match("m", ["a", "b"]));
    assert.deepStrictEqual(PRIVACY, ["everyone", "recent", "friends", "nobody"]);
    assert.strictEqual(r.privacy("a"), "recent", "the default: friends and recent players");
    assert.ok(r.allows("a", "b", false), "b is in a's list");
    assert.ok(!r.allows("a", "z", false), "z isn't");
    assert.ok(r.allows("a", "z", true), "a friend is");
    r.setPrivacy("a", "friends");
    assert.ok(!r.allows("a", "b", false) && r.allows("a", "z", true));
    r.setPrivacy("a", "nobody");
    assert.ok(!r.allows("a", "b", false) && !r.allows("a", "z", true), "nobody: not even friends");
    r.setPrivacy("a", "everyone");
    assert.ok(r.allows("a", "z", false));
    assert.deepStrictEqual(r.setPrivacy("a", "anyone"), { error: "invalid-setting" });
    assert.strictEqual(r.privacy("a"), "everyone");
    assert.deepStrictEqual(r.block("b", "a"), { ok: true });
    assert.ok(r.hasBlocked("b", "a") && !r.hasBlocked("a", "b") && r.blockedEitherWay("a", "b"));
    assert.ok(!r.allows("a", "b", true), "a block beats 'everyone' (b blocked a)");
    assert.ok(!r.allows("b", "a", true), "and the other way");
    assert.deepStrictEqual(r.block("b", "b"), { error: "self" });
    assert.deepStrictEqual(r.unblock("b", "a"), { ok: true });
    assert.deepStrictEqual(r.unblock("b", "a"), { error: "not-blocked" });
  });

  await test("join requests: one per pair, they expire, a block drops them", async () => {
    let t = 0;
    const r = new RecentPlayers(null, { now: () => t, options: { requestTtlMs: 1000, maxJoinRequests: 2 } });
    const q = r.requestJoin("a", "b");
    assert.ok(q.ok && /^[0-9a-f]{12}$/.test(q.id));
    assert.deepStrictEqual(r.requestJoin("a", "b"), { error: "already-requested" });
    assert.ok(r.requestJoin("c", "b").ok);
    assert.deepStrictEqual(r.requestJoin("d", "b"), { error: "too-many-requests" });
    assert.deepStrictEqual(r.joinRequestsFor("b").map((x) => x.from), ["c", "a"], "newest first");
    assert.strictEqual(r.takeJoinRequest("c", q.id), null, "only the asked player answers it");
    t = 1500;
    assert.deepStrictEqual(r.joinRequestsFor("b"), [], "expired");
    assert.strictEqual(r.takeJoinRequest("b", q.id), null);
    const q2 = r.requestJoin("a", "b");
    r.block("b", "a");
    assert.strictEqual(r.takeJoinRequest("b", q2.id), null, "blocking drops the request");
  });

  await test("pair cooldowns: the same invite to the same player waits", async () => {
    let t = 0;
    const r = new RecentPlayers(null, { now: () => t, options: { pairCooldownMs: 1000 } });
    assert.strictEqual(r.coolingDown("invite", "a", "b"), 0);
    r.markSent("invite", "a", "b");
    t = 400;
    assert.strictEqual(r.coolingDown("invite", "a", "b"), 600);
    assert.strictEqual(r.coolingDown("invite", "a", "c"), 0, "another player");
    assert.strictEqual(r.coolingDown("join", "a", "b"), 0, "another kind");
    t = 1000;
    assert.strictEqual(r.coolingDown("invite", "a", "b"), 0);
  });

  await test("reports: a known reason, one per pair a day, the note cleaned and cut; nothing else happens", async () => {
    let t = 0;
    const r = new RecentPlayers(null, { now: () => t, options: { maxReports: 3 } });
    r.recordMatch(match("m", ["a", "b"]));
    assert.deepStrictEqual(r.report({ from: "a", about: "b", reason: "rude" }), { error: "invalid-reason" });
    assert.deepStrictEqual(r.report({ from: "a", about: "a", reason: "other" }), { error: "self" });
    const ok = r.report({ from: "a", fromName: "Ann", about: "b", aboutName: "Bo", reason: "cheating",
      note: "  aim\u0000bot\nnow " + "x".repeat(500), context: r.entry("a", "b") });
    assert.ok(ok.ok);
    assert.deepStrictEqual(r.report({ from: "a", about: "b", reason: "abuse" }), { error: "already-reported" });
    const [rep] = r.listReports();
    assert.strictEqual(rep.note.length, 300);
    assert.ok(rep.note.startsWith("aim bot now"), JSON.stringify(rep.note.slice(0, 20)));
    assert.deepStrictEqual([rep.from.username, rep.about.username, rep.reason, rep.status, rep.context.matchId], ["Ann", "Bo", "cheating", "open", "m"]);
    t = 25 * 3600 * 1000;
    assert.ok(r.report({ from: "a", about: "b", reason: "abuse" }).ok, "a day later: again");
    for (const x of ["c", "d", "e"]) r.report({ from: x, about: "b", reason: "other" });
    assert.strictEqual(r.listReports().length, 3, "the oldest go past the cap");
    assert.deepStrictEqual(r.list("b").length, 1, "the reported player's list is untouched");
  });

  await test("purge: a player gone for good leaves every list", async () => {
    const r = new RecentPlayers(null);
    r.recordMatch(match("m", ["a", "b", "c"]));
    r.requestJoin("b", "a");
    assert.ok(r.purge("b"));
    assert.deepStrictEqual(r.list("a").map((e) => e.with), ["c"]);
    assert.deepStrictEqual(r.list("b"), []);
    assert.deepStrictEqual(r.joinRequestsFor("a"), []);
  });

  await test("saved to recent-players.json and read back; an unreadable file is kept aside", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "culling-recent-"));
    const file = path.join(dir, "recent-players.json");
    try {
      const r = new RecentPlayers(file, { saveDelayMs: 0 });
      r.recordMatch(match("m", ["a", "b"]));
      r.block("a", "z");
      r.setPrivacy("b", "friends");
      r.report({ from: "a", about: "b", reason: "name" });
      r.requestJoin("a", "b");
      r.close();
      const back = new RecentPlayers(file);
      assert.deepStrictEqual(back.list("a").map((e) => e.with), ["b"]);
      assert.ok(back.hasBlocked("a", "z"));
      assert.strictEqual(back.privacy("b"), "friends");
      assert.strictEqual(back.listReports().length, 1);
      assert.deepStrictEqual(back.joinRequestsFor("b"), [], "join requests are not saved");
      fs.writeFileSync(file, "{ not json");
      const bad = new RecentPlayers(file);
      assert.deepStrictEqual(bad.list("a"), []);
      assert.ok(fs.readdirSync(dir).some((f) => f.startsWith("recent-players.json.unreadable-")));
      bad.close();
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  await test("friends.js: invite({ anyone }) skips the friends check; join() puts a player in a leader's party", async () => {
    const f = new Friends(null);
    assert.deepStrictEqual(f.invite("a", "b"), { error: "not-friends" });
    const inv = f.invite("a", "b", { anyone: true });
    assert.ok(inv.ok);
    assert.ok(f.inviteOpen("a", "b"));
    assert.strictEqual(f.dropInvitesBetween("b", "a"), 1);
    assert.ok(!f.inviteOpen("a", "b"));
    const j = f.join("c", "d");
    assert.ok(j.ok && j.party.leader === "c");
    assert.deepStrictEqual(f.party("d").members, ["c", "d"]);
    assert.deepStrictEqual(f.join("d", "e"), { error: "not-party-leader" });
    assert.deepStrictEqual(f.join("c", "d"), { error: "already-in-party" });
    for (const x of ["e", "g"]) assert.ok(f.join("c", x).ok);
    assert.deepStrictEqual(f.join("c", "h"), { error: "party-full" });
    assert.ok(f.join("a", "g").ok, "joining leaves the old party");
    assert.deepStrictEqual(f.party("c").members, ["c", "d", "e"]);
  });

  // ------------------------------------------------------------ servers

  const srv = startServer({ vars: { CULLING_LOBBY_GATHER_MS: "1200", CULLING_LOBBY_COUNTDOWN_MS: "100",
    CULLING_SOCIAL_BURST: "1000", CULLING_SOCIAL_RATE: "100", CULLING_SOCIAL_PAIR_MS: "0", CULLING_RECENT_GET_BURST: "1000", CULLING_FRIEND_ACTION_BURST: "1000" } });
  const strict = startServer({ vars: { CULLING_LOBBY_GATHER_MS: "600", CULLING_LOBBY_COUNTDOWN_MS: "100",
    CULLING_SOCIAL_BURST: "3", CULLING_SOCIAL_RATE: "0.001", CULLING_SOCIAL_PAIR_MS: "60000", CULLING_INVITE_TTL_MS: "1500",
    CULLING_RECENT_LIMIT: "2", CULLING_RECENT_GET_BURST: "1000" } });
  let restarted = null;
  const sockets = [];
  try {
    await Promise.all([srv.ready(), strict.ready()]);
    let ip = 10;
    function waitFor(p, event, pred = () => true, ms = 5000) {
      const got = new Promise((resolve, reject) => {
        const t = setTimeout(() => { p.socket.off(event, on); reject(new Error(p.name + ": timed out waiting for " + event)); }, ms);
        function on(m) { if (pred(m)) { clearTimeout(t); p.socket.off(event, on); resolve(m); } }
        p.socket.on(event, on);
      });
      got.catch(() => {});
      return got;
    }
    async function connect(s, p) {
      p.socket = await s.connect(p.token);
      assert.ok(p.socket, p.name + " logged in");
      sockets.push(p.socket);
      return p;
    }
    async function player(s, name) {
      const r = await s.request("POST", "/api/account/register",
        { username: name, email: name.toLowerCase() + "@example.com", password: "long enough" },
        { "X-Forwarded-For": "198.51.100." + (ip++) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const p = { name, userID: r.json.userID, token: await s.login(r.json.userID), srv: s };
      return connect(s, p);
    }
    const act = (p, event, msg, reply = "remaster-recent-result") => {
      const r = waitFor(p, reply, (x) => x.action === event);
      p.socket.emit(event, msg);
      return r;
    };
    const friendAct = (p, event, msg) => act(p, event, msg, "remaster-friend-result");
    const view = (p) => { const r = waitFor(p, "remaster-recent"); p.socket.emit("recent-get"); return r; };
    const row = (v, name) => v.players.find((x) => x.username === name);
    const names = (v) => v.players.map((x) => x.username).sort();
    async function finish(p) {
      const r = await p.srv.request("POST", "/api/matchresult", { victory: false, kills: 1, damage: 50, timeAlive: 60, placement: 5, cap: 16,
        // A client listing other players: ignored (only the server's record counts).
        players: [{ username: "Dee" }, { userID: "steam:76561190000000001" }] }, { Authorization: "Bearer " + p.token });
      assert.strictEqual(r.status, 200, p.name + " result: " + JSON.stringify(r.json));
    }
    // Everyone listed queues `queue` at once (a leader brings their party).
    async function playTogether(queue, queuers, everyone) {
      const ready = everyone.map((p) => waitFor(p, "match-ready", () => true, 8000));
      for (const p of queuers) p.socket.emit("join-mm", { queueName: queue });
      const got = await Promise.all(ready);
      for (const p of everyone) await finish(p);
      return got;
    }

    const A = await player(srv, "Ann"), B = await player(srv, "Bo"), C = await player(srv, "Cy"), D = await player(srv, "Dee");
    const ids = [A, B, C, D].map((p) => p.userID);
    // A player without an account (only where accounts aren't required).
    const G = { name: "Guest", token: await srv.login("steam:76561190000000777"), srv };
    await connect(srv, G);
    // Ann and Bo are friends, in a party Ann leads.
    await friendAct(A, "friend-request", { username: "Bo" });
    assert.ok((await friendAct(B, "friend-accept", { username: "Ann" })).ok);
    const inv = waitFor(B, "remaster-party-invite");
    assert.ok((await friendAct(A, "party-invite", { username: "Bo" })).ok);
    assert.ok((await friendAct(B, "party-accept", { partyId: (await inv).partyId })).ok);

    await test("server: a real lobby launch records its account players, party teammates as such", async () => {
      const got = await playTogether("ffa_jungle_coop2", [A, C, G], [A, B, C, G]);
      assert.strictEqual(new Set(got.map((m) => m.matchId)).size, 1, "one match id for the lobby");
      const a = await view(A);
      assert.deepStrictEqual(names(a), ["Bo", "Cy"], "Bo (party) and Cy (same lobby); no guest, nobody else");
      assert.deepStrictEqual([row(a, "Bo").relation, row(a, "Cy").relation], ["party", "lobby"]);
      assert.deepStrictEqual([row(a, "Cy").playlist, row(a, "Cy").mode, row(a, "Cy").nameThen], ["coop2", "Duo", "Cy"]);
      assert.ok(typeof row(a, "Cy").map === "string" && row(a, "Cy").playedAt > 0);
      assert.deepStrictEqual([row(a, "Bo").friend, row(a, "Cy").friend], ["friend", "none"]);
      assert.ok(row(a, "Cy").rank === null && row(a, "Cy").level >= 1 && row(a, "Cy").status.state === "menu", JSON.stringify(row(a, "Cy").status));
      assert.deepStrictEqual(names(await view(C)), ["Ann", "Bo"]);
      assert.deepStrictEqual(names(await view(D)), [], "Dee wasn't there");
      assert.deepStrictEqual(await act(G, "recent-get", {}), { action: "recent-get", error: "no-account" });
      const saved = JSON.parse(fs.readFileSync(path.join(srv.dir, "recent-players.json"), "utf8"));
      assert.strictEqual(saved.users[A.userID].recent.find((e) => e.with === C.userID).matchId, got[0].matchId, "saved with the match id");
    });

    await test("server: nothing a client sends adds anyone", async () => {
      C.socket.emit("recent-get", { players: [{ username: "Dee" }] });
      C.socket.emit("recent-record", { matchId: "x", players: ["Dee"] });
      await sleep(200);
      assert.deepStrictEqual(names(await view(C)), ["Ann", "Bo"], "the match result's player list was ignored too");
      assert.deepStrictEqual(names(await view(D)), []);
      assert.deepStrictEqual(await act(C, "recent-invite", { username: "Dee" }), { action: "recent-invite", error: "not-recent", username: "Dee" });
    });

    await test("server: no private fields in the list, join requests or results", async () => {
      const leaks = privateLeaks(await view(A), ids).concat(privateLeaks(await view(C), ids));
      assert.deepStrictEqual(leaks, []);
      assert.strictEqual(row(await view(C), "Ann").status.lastSeen, null, "last seen online is for friends only");
    });

    await test("server: the same pair again keeps one entry, the latest", async () => {
      const before = row(await view(A), "Cy");
      await sleep(20);
      await playTogether("ffa_jungle", [A, C], [A, B, C]);
      const a = await view(A);
      assert.deepStrictEqual(names(a), ["Bo", "Cy"]);
      assert.strictEqual(row(a, "Cy").playlist, "ffa");
      assert.ok(row(a, "Cy").playedAt > before.playedAt);
    });

    await test("server: a friend request from the list; the entry's last interaction moves", async () => {
      const before = row(await view(A), "Cy");
      await sleep(10);
      assert.ok((await friendAct(A, "friend-request", { username: "Cy" })).ok);
      const a = await view(A);
      assert.strictEqual(row(a, "Cy").friend, "requested");
      assert.ok(row(a, "Cy").lastInteraction > before.lastInteraction);
      assert.strictEqual(row(await view(C), "Ann").friend, "asked-you");
    });

    await test("server: invites follow the invited player's setting (everyone, recent, friends, nobody)", async () => {
      const set = (p, join) => act(p, "recent-settings", { join });
      assert.deepStrictEqual(await set(C, "nobody"), { action: "recent-settings", ok: true, join: "nobody" });
      assert.strictEqual((await act(A, "recent-invite", { username: "Cy" })).error, "unavailable");
      const a = await view(A);
      assert.deepStrictEqual([row(a, "Cy").invite.can, row(a, "Cy").invite.reason, row(a, "Cy").party], [false, "unavailable", null]);
      await set(C, "friends");
      assert.strictEqual((await act(A, "recent-invite", { username: "Cy" })).error, "unavailable", "not friends yet");
      assert.strictEqual((await act(A, "recent-join-request", { username: "Cy" })).error, "unavailable");
      assert.strictEqual((await set(C, "anyone")).error, "invalid-setting");
      await set(C, "recent");
      assert.strictEqual(row(await view(A), "Cy").invite.can, true);
      const got = waitFor(C, "remaster-party-invite");
      assert.ok((await act(A, "recent-invite", { username: "Cy" })).ok);
      const i = await got;
      assert.deepStrictEqual(privateLeaks(i.from, ids), []);
      assert.strictEqual(row(await view(A), "Cy").invite.sent, true);
      assert.ok((await friendAct(C, "party-decline", { partyId: i.partyId })).ok);
      assert.strictEqual((await act(B, "recent-invite", { username: "Cy" })).error, "not-party-leader", "only the leader invites");
      await set(C, "everyone");
      assert.strictEqual((await act(D, "recent-invite", { username: "Cy" })).error, "not-recent", "Recent players act on your own list");
      await set(C, "recent");
    });

    await test("server: join requests need room, the right mode, no search; the leader answers", async () => {
      // The party last queued Duos (2 at most): a third doesn't fit.
      A.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      await waitFor(A, "remaster-lobby");
      assert.strictEqual((await act(C, "recent-join-request", { username: "Ann" })).error, "party-in-queue");
      const left = waitFor(A, "leave-mm-ack");
      A.socket.emit("leave-mm");
      await left;
      assert.strictEqual((await act(C, "recent-join-request", { username: "Ann" })).error, "mode-full");
      assert.strictEqual(row(await view(C), "Ann").join.reason, "mode-full");
      // Solo takes parties of 4.
      A.socket.emit("join-mm", { queueName: "ffa_jungle" });
      await waitFor(A, "remaster-lobby");
      const left2 = waitFor(A, "leave-mm-ack");
      A.socket.emit("leave-mm");
      await left2;
      assert.strictEqual((await act(C, "recent-join-request", { username: "Bo" })).error, "not-party-leader");
      const asked = waitFor(A, "remaster-join-request");
      assert.ok((await act(C, "recent-join-request", { username: "Ann" })).ok);
      const q = await asked;
      assert.strictEqual(q.from.username, "Cy");
      assert.deepStrictEqual(privateLeaks(q, ids), []);
      assert.strictEqual(row(await view(C), "Ann").join.sent, true);
      assert.strictEqual((await act(C, "recent-join-request", { username: "Ann" })).error, "already-requested");
      assert.deepStrictEqual((await view(A)).joinRequests.map((r) => r.from.username), ["Cy"]);
      assert.strictEqual((await act(B, "recent-join-accept", { requestId: q.requestId })).error, "no-request", "only the asked leader answers");
      const told = waitFor(C, "remaster-recent-result", (x) => x.action === "recent-join-accepted");
      const inParty = waitFor(C, "remaster-friends", (f) => f.party && f.party.members.length === 3);
      assert.ok((await act(A, "recent-join-accept", { requestId: q.requestId })).ok);
      assert.strictEqual((await told).username, "Ann");
      const f = await inParty;
      assert.strictEqual(f.party.leader, "Ann");
      assert.strictEqual(row(await view(C), "Ann").party.yours, true);
    });

    await test("server: blocks work both ways (hidden, no invites, joins or friend requests); a blocker leaves a shared party", async () => {
      const left = waitFor(A, "remaster-friends", (f) => f.party && f.party.members.length === 2);
      assert.deepStrictEqual(await act(B, "recent-block", { username: "Cy" }), { action: "recent-block", ok: true, username: "Cy" });
      const f = await left;
      assert.deepStrictEqual(f.party.members.map((m) => m.username).sort(), ["Ann", "Cy"], "Bo left the party he shared with Cy");
      assert.deepStrictEqual(names(await view(B)), ["Ann"], "Bo no longer sees Cy");
      assert.deepStrictEqual(names(await view(C)), ["Ann"], "and Cy no longer sees Bo");
      assert.deepStrictEqual((await view(B)).blocked, [{ username: "Cy" }]);
      assert.strictEqual((await act(C, "recent-invite", { username: "Bo" })).error, "unavailable");
      assert.strictEqual((await act(C, "recent-join-request", { username: "Bo" })).error, "unavailable");
      assert.strictEqual((await act(C, "recent-report", { username: "Bo", reason: "abuse" })).ok, true, "a report still goes in");
      assert.strictEqual((await friendAct(C, "friend-request", { username: "Bo" })).error, "unavailable");
      assert.strictEqual((await friendAct(B, "friend-request", { username: "Cy" })).error, "blocked");
      assert.strictEqual((await act(B, "recent-invite", { username: "Cy" })).error, "blocked");
      // Cy leaves; Ann invites Cy back, Bo (who blocked Cy) rejoins first: Cy can't join a party with Bo in it.
      assert.ok((await friendAct(C, "party-leave", {})).ok);
      const binv = waitFor(B, "remaster-party-invite");
      assert.ok((await friendAct(A, "party-invite", { username: "Bo" })).ok);
      assert.ok((await friendAct(B, "party-accept", { partyId: (await binv).partyId })).ok);
      const cinv = waitFor(C, "remaster-party-invite");
      assert.ok((await act(A, "recent-invite", { username: "Cy" })).ok);
      assert.strictEqual((await friendAct(C, "party-accept", { partyId: (await cinv).partyId })).error, "unavailable");
      assert.strictEqual((await act(C, "recent-join-request", { username: "Ann" })).error, "unavailable", "nor ask to join it");
      assert.ok((await act(B, "recent-unblock", { username: "Cy" })).ok);
      assert.deepStrictEqual(names(await view(B)), ["Ann", "Cy"], "unblocked: back on the list");
    });

    await test("server: reports are stored for the operator, nothing happens to the player", async () => {
      assert.strictEqual((await act(C, "recent-report", { username: "Ann", reason: "spam" })).error, "invalid-reason");
      assert.ok((await act(C, "recent-report", { username: "Ann", reason: "cheating", note: "flew\u0007 over the wall" })).ok);
      assert.strictEqual((await act(C, "recent-report", { username: "Ann", reason: "cheating" })).error, "already-reported");
      assert.strictEqual((await act(C, "recent-report", { username: "Dee", reason: "other" })).error, "not-recent");
      const r = await srv.request("GET", "/admin/reports");
      assert.strictEqual(r.status, 200);
      const mine = r.json.reports.filter((x) => x.from.username === "Cy");
      assert.deepStrictEqual(mine.map((x) => [x.about.username, x.reason]), [["Bo", "abuse"], ["Ann", "cheating"]]);
      assert.strictEqual(mine[1].note, "flew  over the wall");
      assert.ok(mine[1].context && mine[1].context.playlist === "ffa" && mine[1].context.matchId);
      const proxied = await srv.request("GET", "/admin/reports", undefined, { "X-Forwarded-For": "203.0.113.9" });
      assert.strictEqual(proxied.status, 404, "operator only");
      assert.ok(A.socket.connected, "Ann is still signed in");
      assert.deepStrictEqual(names(await view(A)), ["Bo", "Cy"]);
    });

    await test("server: removing someone takes them off your list only", async () => {
      assert.ok((await act(C, "recent-remove", { username: "Ann" })).ok);
      assert.deepStrictEqual(names(await view(C)), ["Bo"]);
      assert.ok(names(await view(A)).includes("Cy"), "Ann keeps Cy");
      assert.strictEqual((await act(C, "recent-remove", { username: "Ann" })).error, "not-recent");
      assert.strictEqual((await act(C, "recent-invite", { username: "Ann" })).error, "not-recent");
    });

    await test("server: a banned account drops out of every list and can't sign in; lifting the ban brings it back", async () => {
      const gone = new Promise((r) => C.socket.once("disconnect", r));
      const r = await srv.request("POST", "/admin/ban", { username: "Cy", reason: "test" });
      assert.deepStrictEqual([r.status, r.json.banned], [200, true]);
      await gone;
      assert.deepStrictEqual(names(await view(A)), ["Bo"]);
      assert.deepStrictEqual(names(await view(B)), ["Ann"]);
      assert.strictEqual((await act(A, "recent-invite", { username: "Cy" })).error, "no-such-player");
      const login = await srv.request("POST", "/api/account/login", { username: "Cy", password: "long enough" }, { "X-Forwarded-For": "198.51.100.200" });
      assert.deepStrictEqual([login.status, login.json.error], [403, "banned"]);
      const game = await srv.request("POST", "/api/login", { userid: C.userID, authType: "steam" });
      assert.deepStrictEqual([game.status, game.json.error], [403, "banned"]);
      const lift = await srv.request("POST", "/admin/ban", { username: "Cy", banned: false });
      assert.deepStrictEqual([lift.status, lift.json.banned], [200, false]);
      assert.deepStrictEqual(names(await view(A)), ["Bo", "Cy"]);
      C.token = await srv.login(C.userID);
      await connect(srv, C);
      assert.deepStrictEqual(names(await view(C)), ["Bo"]);
      assert.strictEqual((await srv.request("POST", "/admin/ban", { username: "Cy" }, { "X-Forwarded-For": "203.0.113.9" })).status, 404, "operator only");
    });

    // ------------------------------------------------------------ the strict server

    await test("server: the configured limit (CULLING_RECENT_LIMIT=2) keeps two per player", async () => {
      const ps = [];
      for (const n of ["Wes", "Xan", "Yul", "Zed"]) ps.push(await player(strict, n));
      strict.ps = ps;
      await playTogether("ffa_jungle", ps, ps);
      for (const p of ps) {
        const v = await view(p);
        assert.strictEqual(v.players.length, 2, p.name + ": " + names(v));
        assert.strictEqual(v.limit, 2);
      }
      // With two kept out of three, not every pair is on both lists: everyone
      // here lets everyone ask, so the next tests are about the limits only.
      for (const p of ps) assert.ok((await act(p, "recent-settings", { join: "everyone" })).ok);
    });

    await test("server: invites, join requests and reports are rate-limited, per player and per pair", async () => {
      const [W] = strict.ps;
      const [p1, p2] = (await view(W)).players.map((x) => x.username);
      assert.ok((await act(W, "recent-invite", { username: p1 })).ok);
      assert.strictEqual((await act(W, "recent-invite", { username: p1 })).error, "too-soon", "the same invite to the same player waits");
      assert.ok((await act(W, "recent-report", { username: p1, reason: "other" })).ok);
      assert.strictEqual((await act(W, "recent-join-request", { username: p2 })).error, "slow-down", "out of requests for now");
      assert.ok((await view(W)).players.length === 2, "the list itself is still served");
    });

    await test("server: invites and join requests expire", async () => {
      const [W, X, Y, Z] = strict.ps;
      const byName = { Wes: W, Xan: X, Yul: Y, Zed: Z };
      const firstInvited = (await view(W)).players.find((x) => x.invite.sent);
      assert.ok(firstInvited, "Wes's invite is open");
      const invited = byName[firstInvited.username];
      await sleep(1700);
      const f = await (async () => { const r = waitFor(invited, "remaster-friends"); invited.socket.emit("friends-get"); return r; })();
      assert.deepStrictEqual(f.invites, [], "expired: no invite listed");
      assert.strictEqual(row(await view(W), invited.name).invite.sent, false);
      // A join request: someone asks a player who lets everyone ask.
      const asker = [X, Y, Z].find((p) => p !== invited) || X;
      const v = await view(asker);
      const target = byName[v.players[0].username];
      await act(target, "recent-settings", { join: "everyone" });
      const asked = waitFor(target, "remaster-join-request");
      const r = await act(asker, "recent-join-request", { username: target.name });
      assert.ok(r.ok, JSON.stringify(r));
      const q = await asked;
      await sleep(1700);
      assert.strictEqual(row(await view(asker), target.name).join.sent, false, "expired for the asker");
      assert.deepStrictEqual((await view(target)).joinRequests, [], "and for the leader");
      assert.strictEqual((await act(target, "recent-join-accept", { requestId: q.requestId })).error, "no-request");
    });

    // ------------------------------------------------------------ a restart, with an account deleted

    await test("server: after a restart the lists are back; a deleted account is gone from them", async () => {
      srv.proc.kill();
      await new Promise((r) => (srv.proc.exitCode !== null ? r() : srv.proc.once("exit", r)));
      for (const s of sockets) s.close();
      const files = {};
      for (const name of ["accounts.json", "profiles.json", "friends.json", "recent-players.json"]) {
        files[name] = JSON.parse(fs.readFileSync(path.join(srv.dir, name), "utf8"));
      }
      delete files["accounts.json"].accounts.bo;      // Bo's account deleted by hand
      restarted = startServer({ files });
      await restarted.ready();
      const A2 = { name: "Ann", token: await restarted.login(A.userID), srv: restarted };
      await connect(restarted, A2);
      const v = await view(A2);
      assert.deepStrictEqual(names(v), ["Cy"], "Bo is gone, Cy is kept");
      assert.strictEqual(row(v, "Cy").relation, "lobby");
    });
  } catch (e) {
    failed++;
    console.log("FAIL  (setup) " + (e.stack || e.message));
  } finally {
    for (const s of sockets) try { s.close(); } catch { /* closed */ }
    srv.stop();
    strict.stop();
    if (restarted) restarted.stop();
  }
  console.log("recent players tests: %d passed, %d failed", passed, failed);
  process.exit(failed ? 1 : 0);
})();
