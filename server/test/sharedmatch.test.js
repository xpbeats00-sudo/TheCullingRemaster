// Shared matches on a game server (docs/PARTY_MATCHMAKING_REWORK.md), against
// the stand-in game server (fake_gameserver.js): real socket.io clients for
// several accounts, the backend spawned with CULLING_SHARED_MATCHES=1.
//
// Part 1, the rules: team packing, connection tickets, request signatures.
// Part 2, pool mode: a party of 2 in Duos gets one allocation, the same
// address, the same team and a valid ticket each, one authoritative result
// and the right pay and rating; three parties (and two solos) in one match,
// never split; allocation failure and ready timeout re-queue; a crash
// mid-match cancels cleanly (tickets revoked, ranked voided, re-queued);
// ticket reuse / wrong user / wrong match refused; a client result for a
// shared match is ignored; queue cancel, disconnect and a duplicate queue
// while the server is starting; the game-server API's authentication.
// Part 3, launch mode: one process per match from a command template; its
// exit cancels the match. Part 4, a backend restart mid-match: the match is
// taken up again from the game server's heartbeat and paid. Part 5, the
// setting off (and a playlist not allowed): exactly as today.
// Run: node test/sharedmatch.test.js
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const http = require("http");
const { spawn } = require("child_process");
const { startServer, freePort } = require("./helpers");
const { FakeGameServer, post } = require("./fake_gameserver");
const { packTeams, groupsOf } = require("../sharedmatch");
const { ConnectionTickets } = require("../connticket");
const { sign, serverSecret, parsePool, parsePorts, Allocator } = require("../allocator");
const R = require("../ranked");

let passed = 0, failed = 0;
let afterFailure = async () => {};
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok    " + name); } catch (e) {
    failed++;
    console.log("FAIL  " + name + "\n      " + (e.stack || e.message).split("\n").slice(0, 4).join("\n      "));
    await afterFailure();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const MASTER = "test-master-secret-0123456789abcdef";
const EVENTS = ["join-mm-ack", "join-mm-fail", "join-mm-group", "leave-mm-ack", "leave-mm-group", "remaster-lobby", "match-ready",
  "remaster-shared-match"];

function waitFor(p, event, pred = () => true, ms = 6000) {
  const got = new Promise((resolve, reject) => {
    const t = setTimeout(() => { p.socket.off(event, on); reject(new Error(p.name + ": timed out waiting for " + event)); }, ms);
    function on(m) { if (pred(m)) { clearTimeout(t); p.socket.off(event, on); resolve(m); } }
    p.socket.on(event, on);
  });
  got.catch(() => {});
  return got;
}

function get(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    }).on("error", reject);
  });
}

// A client joining the game server it was sent to, with its ticket in the URL options (PreLogin).
const join = (ready, userID) => get("http://" + ready.gameServer + "/join?nonce=" + encodeURIComponent(ready.nonce)
  + (userID ? "&userid=" + encodeURIComponent(userID) : ""));

// Accounts, friends and parties through the real socket API (as party.test.js).
let ipCounter = 10;
async function people(srv) {
  const players = [];
  async function player(name) {
    const xff = { "X-Forwarded-For": "198.51.100." + (ipCounter++) };
    const r = await srv.request("POST", "/api/account/register",
      { username: name, email: name.replace(/\W/g, "").toLowerCase() + "@example.com", password: "long enough" }, xff);
    assert.strictEqual(r.status, 200, JSON.stringify(r.json));
    const token = await srv.login(r.json.userID);
    const p = { name, userID: r.json.userID, token };
    await connect(p);
    players.push(p);
    return p;
  }
  async function connect(p) {
    p.socket = await srv.connect(p.token);
    assert.ok(p.socket, p.name + " logged in");
    p.log = [];
    for (const e of EVENTS) p.socket.on(e, (m) => p.log.push({ e, m }));
    p.of = (e) => p.log.filter((x) => x.e === e).map((x) => x.m);
    return p;
  }
  function act(p, event, msg) {
    const r = waitFor(p, "remaster-friend-result", (x) => x.action === event);
    p.socket.emit(event, msg);
    return r;
  }
  async function party(leader, ...members) {
    let id = null;
    for (const m of members) {
      await act(leader, "friend-request", { username: m.name });
      assert.ok((await act(m, "friend-accept", { username: leader.name })).ok);
      const inv = waitFor(m, "remaster-party-invite");
      assert.ok((await act(leader, "party-invite", { username: m.name })).ok);
      const got = await act(m, "party-accept", { partyId: (await inv).partyId });
      assert.ok(got.ok, JSON.stringify(got));
      id = got.partyId;
    }
    return id;
  }
  return { players, player, connect, party };
}

const clear = (...ps) => ps.forEach((p) => { p.log.length = 0; });
const metrics = async (srv) => (await srv.request("GET", "/metrics")).json;
const sharedStats = async (srv) => (await metrics(srv)).sharedMatches;
// XP and credits of a local match's numbers (server.js matchXP / matchCredits).
const xpOf = (r) => 250 + 150 * r.kills + Math.floor(r.damage) + Math.floor(r.timeAlive / 2) + (r.victory ? 1500 : 0);
const creditsOf = (r) => 100 + 25 * r.kills + Math.floor(r.damage / 20) + Math.floor(r.timeAlive / 30) + (r.victory ? 400 : 0);

function sharedVars(extra = {}) {
  return Object.assign({ CULLING_SHARED_MATCHES: "1", CULLING_SHARED_PLAYLISTS: "coop2,coop3,ranked_coop2,ffa,ranked_ffa,showdown_duo,bogus",
    CULLING_GAMESERVER_SECRET: MASTER, CULLING_GAMESERVER_HEARTBEAT_MS: "250", CULLING_GAMESERVER_HEARTBEAT_TIMEOUT_MS: "900",
    CULLING_GAMESERVER_READY_TIMEOUT_MS: "1500", CULLING_LOBBY_GATHER_MS: "400", CULLING_LOBBY_COUNTDOWN_MS: "100",
    CULLING_SHARED_REQUEUE_MAX: "1" }, extra);
}

(async () => {
  // ------------------------------------------------------------ rules
  await test("teams: a party is never split; solos and smaller parties fill teams; what doesn't fit overflows", () => {
    const g = (n, party) => ({ ids: Array.from({ length: n }, (_, i) => (party || "s" + Math.random()) + i), party: party || null });
    const duos = packTeams([g(1), g(2, "A"), g(1), g(2, "B")], 2, 8);
    assert.deepStrictEqual(duos.teams.filter((t) => t.players.length).map((t) => t.players.length), [2, 2, 2]);
    assert.ok(duos.teams[0].players.every((id) => id.startsWith("A")) && duos.teams[1].players.every((id) => id.startsWith("B")), "parties first, whole");
    assert.strictEqual(duos.overflow.length, 0);
    // Trios: 5 teams of 3; six parties of 2 can't all fit (each takes a team).
    const trios = packTeams([1, 2, 3, 4, 5, 6].map((i) => g(2, "P" + i)), 3, 5);
    assert.strictEqual(trios.overflow.length, 1);
    assert.ok(trios.teams.every((t) => t.players.length === 2));
    // A party larger than the team never goes in.
    assert.strictEqual(packTeams([g(3, "Big")], 2, 8).overflow.length, 1);
    // Every party's members share one team.
    const mix = packTeams([g(3, "X"), g(1), g(2, "Y"), g(1), g(1), g(4, "Z")], 4, 4);
    for (const p of ["X", "Y", "Z"]) assert.strictEqual(new Set(mix.teams.filter((t) => t.players.some((id) => id.startsWith(p))).map((t) => t.team)).size, 1, p);
    assert.deepStrictEqual(groupsOf([{ id: "a", party: "p" }, { id: "b" }, { id: "c", party: "p" }]).map((x) => x.ids), [["a", "c"], ["b"]]);
  });

  await test("teams by size: a party is one team in Duos, Trios and Quads; parties that don't fit together never share one", () => {
    const g = (n, party) => ({ ids: Array.from({ length: n }, (_, i) => party + i), party: n > 1 ? party : null });
    const teamOf = (r, id) => r.teams.find((t) => t.players.includes(id)).team;
    const partyTeams = (r, p, n) => new Set(Array.from({ length: n }, (_, i) => teamOf(r, p + i)));
    for (const [size, teamsCount] of [[2, 8], [3, 5], [4, 4]]) {
      // A party of the team's size, a smaller party and solos: every party whole on one team.
      const r = packTeams([g(1, "s"), g(size, "A"), g(1, "t"), g(Math.max(2, size - 1), "B"), g(1, "u")], size, teamsCount);
      assert.strictEqual(r.overflow.length, 0, "size " + size);
      assert.strictEqual(partyTeams(r, "A", size).size, 1, "size " + size + ": the full party on one team");
      assert.strictEqual(partyTeams(r, "B", Math.max(2, size - 1)).size, 1, "size " + size + ": the smaller party on one team");
      assert.notStrictEqual(teamOf(r, "A0"), teamOf(r, "B0"), "size " + size + ": a full team takes nobody else");
      assert.ok(r.teams.every((t) => t.players.length <= size), "size " + size + ": no team over its size");
    }
    // Two parties of 2: one team in Quads (they fit), two teams in Trios and Duos (they don't).
    const quads = packTeams([g(2, "A"), g(2, "B")], 4, 4);
    assert.strictEqual(new Set(["A0", "A1", "B0", "B1"].map((id) => teamOf(quads, id))).size, 1, "Quads: 2 + 2 = one team of 4");
    for (const [size, teamsCount] of [[3, 5], [2, 8]]) {
      const r = packTeams([g(2, "A"), g(2, "B")], size, teamsCount);
      assert.strictEqual(partyTeams(r, "A", 2).size, 1);
      assert.strictEqual(partyTeams(r, "B", 2).size, 1);
      assert.notStrictEqual(teamOf(r, "A0"), teamOf(r, "B0"), "size " + size + ": two parties of 2 never share a team");
    }
    // Trios: a party of 2 and a solo fill one team; a party of 3 and a solo don't share.
    const t21 = packTeams([g(1, "s"), g(2, "A")], 3, 5);
    assert.strictEqual(teamOf(t21, "s0"), teamOf(t21, "A0"), "Trios: party of 2 + solo = one team");
    const t31 = packTeams([g(1, "s"), g(3, "A")], 3, 5);
    assert.notStrictEqual(teamOf(t31, "s0"), teamOf(t31, "A0"));
    // Quads: a party of 3 and a party of 2 don't share; 3 + solo do.
    const q32 = packTeams([g(3, "A"), g(2, "B")], 4, 4);
    assert.notStrictEqual(teamOf(q32, "A0"), teamOf(q32, "B0"), "Quads: 3 + 2 don't fit one team");
    const q31 = packTeams([g(3, "A"), g(1, "s")], 4, 4);
    assert.strictEqual(teamOf(q31, "A0"), teamOf(q31, "s0"), "Quads: 3 + solo = one team");
  });

  await test("lobbies (fits option): a party whose team no longer fits opens the next lobby; without the option, as before", () => {
    const { MatchLobbies } = require("../matchlobby");
    const { SharedMatches } = require("../sharedmatch");
    const timers = { setTimer: () => 0, clearTimer: () => {} };
    // Trios through the real lobbyOptions: 5 teams of 3, so the sixth party of 2 can't join.
    const sm = Object.create(SharedMatches.prototype);
    Object.assign(sm, { allowed: new Set(["coop3"]), allocator: { configured: true },
      deps: { playlist: () => ({ id: "coop3", teamSize: 3 }), contestants: () => 16 } });
    const opts = sm.lobbyOptions({ maxPlayers: { default: 16 }, maps: ["jungle", "prison"] });
    assert.strictEqual(opts.maxPlayers.coop3, 15, "a Trios lobby holds 15");
    const lobbies = new MatchLobbies(Object.assign({ describe: () => ({}), send: () => {}, start: () => {}, options: opts }, timers));
    const first = lobbies.joinGroup("coop3", [{ id: "a1" }, { id: "a2" }], null, "A");
    for (const p of ["B", "C", "D", "E"]) assert.strictEqual(lobbies.joinGroup("coop3", [{ id: p + "1" }, { id: p + "2" }], null, p), first);
    const sixth = lobbies.joinGroup("coop3", [{ id: "F1" }, { id: "F2" }], null, "F");
    assert.notStrictEqual(sixth, first, "the sixth party of 2 gets the next lobby");
    assert.strictEqual(first.state, "starting");
    // The same six parties without the option (shared matches off): one lobby of 12.
    const plain = new MatchLobbies(Object.assign({ describe: () => ({}), send: () => {}, start: () => {}, options: { maxPlayers: 16 } }, timers));
    const one = plain.joinGroup("coop3", [{ id: "a1" }, { id: "a2" }], null, "A");
    for (const p of ["B", "C", "D", "E", "F"]) assert.strictEqual(plain.joinGroup("coop3", [{ id: p + "1" }, { id: p + "2" }], null, p), one);
    // Shared matches off: lobbyOptions hands back the very same options.
    const offSm = Object.assign(Object.create(SharedMatches.prototype), { allowed: new Set(), allocator: null });
    const base = { maxPlayers: { default: 16 } };
    assert.strictEqual(offSm.lobbyOptions(base), base);
  });

  await test("connection tickets: one use, short-lived, bound to match, user, team and server; tampering refused", () => {
    let t = 1000000;
    const ct = new ConnectionTickets({ secret: "s".repeat(32), ttlMs: 5000, now: () => t });
    const a = ct.issue({ matchId: "m1", userID: "u1", team: 3, serverId: "gs1" });
    assert.ok(/^[A-Za-z0-9._-]+$/.test(a.token), "URL-option safe: " + a.token);
    assert.strictEqual(ct.verify(a.token, { matchId: "m1", serverId: "gs1", userID: "u2" }).error, "wrong-user");
    assert.strictEqual(ct.verify(a.token, { matchId: "m2", serverId: "gs1" }).error, "wrong-match");
    assert.strictEqual(ct.verify(a.token, { matchId: "m1", serverId: "gs2" }).error, "wrong-server");
    const ok = ct.verify(a.token, { matchId: "m1", serverId: "gs1", userID: "u1" });
    assert.ok(ok.ok && ok.claims.team === 3 && ok.claims.userID === "u1");
    assert.strictEqual(ct.verify(a.token, { matchId: "m1", serverId: "gs1" }).error, "used", "one use");
    const b = ct.issue({ matchId: "m1", userID: "u2", team: 1, serverId: "gs1" });
    t += 5001;
    assert.strictEqual(ct.verify(b.token, { matchId: "m1", serverId: "gs1" }).error, "expired");
    const c = ct.issue({ matchId: "m1", userID: "u3", team: 1, serverId: "gs1" });
    const parts = c.token.split(".");
    const forged = Buffer.from(JSON.stringify(Object.assign(JSON.parse(Buffer.from(parts[1], "base64").toString()), { t: 2 }))).toString("base64")
      .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    assert.strictEqual(ct.verify(parts[0] + "." + forged + "." + parts[2], {}).error, "bad-signature", "a changed team is refused");
    assert.strictEqual(new ConnectionTickets({ secret: "x".repeat(32) }).verify(c.token, {}).error, "bad-signature", "another secret");
    for (const junk of [null, "", "v1.a", "v2.a.b", "v1.a b.c", "x".repeat(2000)]) assert.ok(ct.verify(junk, {}).error, String(junk));
    ct.revokeMatch("m1");
    assert.strictEqual(ct.verify(c.token, { matchId: "m1", serverId: "gs1" }).error, "revoked");
  });

  await test("allocator config: pool and port lists parse; bad entries are refused; capacity is enforced", () => {
    assert.deepStrictEqual(parsePool("gs1@127.0.0.1:7777, gs2@10.0.0.5:7778"), [{ id: "gs1", host: "127.0.0.1", port: 7777 }, { id: "gs2", host: "10.0.0.5", port: 7778 }]);
    assert.throws(() => parsePool("nonsense"));
    assert.deepStrictEqual(parsePorts("7777-7779,7790"), [7777, 7778, 7779, 7790]);
    let t = 0;
    const a = new Allocator({ pool: parsePool("a@h:1,b@h:2"), maxMatches: 1, master: MASTER, now: () => t, setInterval: () => null, log: () => {} });
    assert.strictEqual(a.reserve({ matchId: "x" }).error, "no-capacity", "no server registered yet");
    a.register("a", {}); a.register("b", {});
    assert.ok(a.reserve({ matchId: "m1" }).serverId);
    assert.strictEqual(a.reserve({ matchId: "m2" }).error, "no-capacity", "maxMatches 1");
    const lost = [];
    a.on("lost", (m, why) => lost.push([m, why]));
    t += 60001; a.check();
    assert.deepStrictEqual(lost, [["m1", "ready-timeout"]]);
    assert.strictEqual(serverSecret(MASTER, "a"), a.secretFor("a"));
    assert.notStrictEqual(serverSecret(MASTER, "a"), serverSecret(MASTER, "b"), "a secret per server");
  });

  // ------------------------------------------------------------ pool mode
  const ports = [await freePort(), await freePort(), await freePort()];
  const srv = startServer({ vars: sharedVars({ CULLING_GAMESERVER_POOL: "gs1@127.0.0.1:" + ports[0] + ",gs2@127.0.0.1:" + ports[1] + ",gs3@127.0.0.1:" + ports[2],
    CULLING_GAMESERVER_MAX: "2" }) });
  const fakes = [];
  let world = null;
  const gs = (i, opts = {}) => new FakeGameServer(Object.assign({ backend: "http://127.0.0.1:" + srv.port, serverId: "gs" + (i + 1),
    secret: serverSecret(MASTER, "gs" + (i + 1)), port: ports[i], heartbeatMs: 250 }, opts));
  try {
    await srv.ready();
    world = await people(srv);
    afterFailure = async () => { for (const p of world.players) if (p.socket && p.socket.connected) p.socket.emit("leave-mm"); await sleep(1500); };
    const gs1 = await gs(0).start();
    fakes.push(gs1);
    const { player, party } = world;
    const L = await player("Lead Wolf"), M = await player("Member Fox");
    const partyId = await party(L, M);
    const byAddress = (addr) => fakes.find((f) => f.o.host + ":" + f.o.port === addr && !f.dead);

    await test("a party of 2 in Duos: one allocation, the same address and team, a valid ticket each, netplay true", async () => {
      clear(L, M);
      const before = (await sharedStats(srv)).servers.counters.reserved;
      const lr = waitFor(L, "match-ready"), mr = waitFor(M, "match-ready");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const [a, b] = await Promise.all([lr, mr]);
      assert.strictEqual(a.gameServer, "127.0.0.1:" + ports[0], "the game server's address, not a local match");
      assert.strictEqual(b.gameServer, a.gameServer, "the same address for both");
      assert.ok(a.netplay === true && b.netplay === true);
      assert.strictEqual(a.matchId, b.matchId);
      assert.strictEqual(a.partyId, partyId);
      assert.strictEqual(a.team, b.team, "one team");
      assert.notStrictEqual(a.nonce, b.nonce, "a ticket each");
      assert.ok(/^v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(a.nonce) && /^[0-9a-f]+$/.test(a.ticketId) && a.ticketExpiresInMs > 0,
        "nonce is the ticket (the stock client sends it as ?Nonce=)");
      assert.ok(/^[0-9a-f]{32}$/.test(a.serverNonce) && a.serverNonce === b.serverNonce, "one server nonce for the match");
      assert.ok(L.of("remaster-shared-match").some((x) => x.state === "allocating"), "told the server is being set up");
      const st = await sharedStats(srv);
      assert.strictEqual(st.servers.counters.reserved - before, 1, "one allocation for the party");
      // The game server was told the layout and the bots.
      const asg = gs1.assignment;
      assert.ok(asg && asg.matchId === a.matchId, "the server got the match");
      assert.deepStrictEqual([asg.playlist, asg.teamSize, asg.teamsCount, asg.field, asg.players, asg.bots], ["coop2", 2, 8, 16, 2, 14]);
      const t = asg.teams.find((x) => x.team === a.team);
      assert.deepStrictEqual(t.players.map((p) => p.userID).sort(), [L.userID, M.userID].sort());
      assert.strictEqual(t.bots, 0);
      assert.strictEqual(asg.teams.filter((x) => !x.players.length).length, 7, "seven all-bot teams");
      assert.strictEqual(asg.matchUrl, "duo:0", "the local URL of the same mode and map (for the host)");
      // PreLogin with each ticket.
      const jl = await join(a, L.userID), jm = await join(b, M.userID);
      assert.deepStrictEqual([jl.status, jl.json.team, jl.json.userID], [200, a.team, L.userID]);
      assert.deepStrictEqual([jm.status, jm.json.team, jm.json.username], [200, a.team, "Member Fox"]);
      // Presence: in a match.
      world.match = { a, b };
    });

    await test("one authoritative result pays and rates both; the client's own result is ignored", async () => {
      const { a } = world.match;
      const pBefore = srv.profiles();
      const before = { L: pBefore[L.userID], M: pBefore[M.userID] };
      // The HUD's result for a shared match: ignored, nothing paid.
      const hud = await srv.request("POST", "/api/matchresult", { victory: true, kills: 9, damage: 999, timeAlive: 999 },
        { Authorization: "Bearer " + L.token });
      assert.strictEqual(hud.status, 202);
      assert.deepStrictEqual([hud.json.ignored, hud.json.reason, hud.json.matchId], [true, "shared-match", a.matchId]);
      assert.strictEqual(srv.profiles()[L.userID].stats.xp, before.L.stats.xp, "nothing paid for the client's post");
      const fl = waitFor(L, "remaster-shared-match", (x) => x.state === "finished"), fm = waitFor(M, "remaster-shared-match", (x) => x.state === "finished");
      const res = await gs1.result({ teams: [{ team: a.team, placement: 1, outcome: "won" }].concat([1, 2, 3, 4, 5, 6, 7, 8]
        .filter((n) => n !== a.team).map((n, i) => ({ team: n, placement: i + 2, outcome: "out" }))),
      players: { [L.userID]: { placement: 1, kills: 3, damage: 200, timeAlive: 20 }, [M.userID]: { placement: 4, kills: 1, damage: 50, timeAlive: 10 } } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      assert.deepStrictEqual([res.json.paid, res.json.noShow], [2, []]);
      const [sl, sm] = await Promise.all([fl, fm]);
      const after = srv.profiles();
      const wantL = { victory: true, kills: 3, damage: 200, timeAlive: 20 }, wantM = { victory: true, kills: 1, damage: 50, timeAlive: 10 };
      assert.strictEqual(after[L.userID].stats.xp - before.L.stats.xp, xpOf(wantL), "the leader's XP from the server's numbers");
      assert.strictEqual(after[M.userID].stats.xp - before.M.stats.xp, xpOf(wantM), "the member wins with the team");
      assert.strictEqual(after[L.userID].cullCredits - before.L.cullCredits, creditsOf(wantL));
      assert.strictEqual(after[M.userID].cullCredits - before.M.cullCredits, creditsOf(wantM));
      assert.deepStrictEqual([after[L.userID].stats.wins, after[L.userID].stats.gamesPlayed, after[L.userID].modes.coop2.played], [1, 1, 1]);
      assert.ok(after[L.userID].lastMatch.shared && after[L.userID].lastMatch.matchId === a.matchId);
      assert.deepStrictEqual([sl.result.teamPlacement, sl.result.xpEarned, sm.result.placement], [1, xpOf(wantL), 4]);
      // The same result again: refused, nothing paid twice.
      const again = await gs1.call("result", { matchId: a.matchId, players: [], teams: [] });
      assert.strictEqual(again.status, 409);
      assert.strictEqual(srv.profiles()[L.userID].stats.xp, after[L.userID].stats.xp);
      await sleep(400);
      const st = await sharedStats(srv);
      assert.deepStrictEqual([st.running, st.allocating, st.counters.results, st.counters.clientResultsIgnored], [0, 0, 1, 1]);
      assert.strictEqual(st.servers.servers.find((s) => s.id === "gs1").state, "idle", "the slot is free again");
      assert.strictEqual(gs1.assignment, null);
    });

    await test("tickets at the game server: reuse, wrong user, another match's ticket and a forged one are refused", async () => {
      clear(L, M);
      const lr = waitFor(L, "match-ready"), mr = waitFor(M, "match-ready");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const [a, b] = await Promise.all([lr, mr]);
      const f = byAddress(a.gameServer);
      assert.strictEqual((await join(a, M.userID)).json.error, "wrong-user", "the leader's ticket for the member");
      assert.strictEqual((await join(a, L.userID)).status, 200);
      const reuse = await join(a, L.userID);
      assert.deepStrictEqual([reuse.status, reuse.json.error], [403, "used"]);
      assert.strictEqual((await join({ gameServer: a.gameServer, nonce: world.match.b.nonce }, M.userID)).json.error, "revoked",
        "a ticket of the last (finished) match");
      assert.strictEqual((await join({ gameServer: a.gameServer, nonce: b.nonce.slice(0, -2) + "xx" }, M.userID)).json.error, "bad-signature");
      // A ticket checked against another match id by the server.
      const other = await f.call("verify-ticket", { matchId: "0000000000000000", ticket: b.nonce });
      assert.deepStrictEqual([other.status, other.json.error], [403, "match-not-running"]);
      assert.strictEqual((await join(b, M.userID)).status, 200, "the member's own ticket still works once");
      const st = await sharedStats(srv);
      assert.ok(st.counters.ticketsRefused >= 4 && st.counters.ticketsAccepted >= 4, JSON.stringify(st.counters));
      // A player the server says never joined is a no-show: not paid.
      const xp = srv.profiles()[M.userID].stats.xp;
      const r = await f.result({ players: { [M.userID]: { joined: false } } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual(r.json.noShow, [M.userID]);
      assert.strictEqual(srv.profiles()[M.userID].stats.xp, xp, "no pay for a no-show");
    });

    await test("local ticket checks: the server gets each ticket's hash (ready answer, heartbeats), never the ticket; ticket-used is one use", async () => {
      clear(L, M);
      const { ticketHash } = require("../sharedmatch");
      const lr = waitFor(L, "match-ready"), mr = waitFor(M, "match-ready");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const [a, b] = await Promise.all([lr, mr]);
      const f = byAddress(a.gameServer);
      // match-ready goes out while the server's ready call is answered: wait for that answer.
      for (let i = 0; i < 80 && !(f.readyAnswer && f.readyAnswer.assignment && f.readyAnswer.assignment.matchId === a.matchId); i++) await sleep(25);
      const ready = f.readyAnswer && f.readyAnswer.assignment;
      assert.ok(ready && ready.matchId === a.matchId, "the ready answer carries the assignment: " + JSON.stringify(f.readyAnswer));
      assert.deepStrictEqual(ready.tickets.map((t) => [t.userID, t.hash, t.team]).sort(),
        [[L.userID, ticketHash(a.nonce), a.team], [M.userID, ticketHash(b.nonce), b.team]].sort());
      assert.ok(ready.tickets.every((t) => t.expiresInMs > 0 && t.used === false && /^[0-9a-f]+$/.test(t.id)), JSON.stringify(ready.tickets));
      assert.ok(!JSON.stringify(ready).includes(a.nonce) && !JSON.stringify(ready).includes(b.nonce), "never the tickets themselves");
      const used = (hash, userID) => f.call("ticket-used", { matchId: a.matchId, hash, userID });
      assert.strictEqual((await used(ticketHash(a.nonce), M.userID)).json.error, "wrong-user", "the leader's ticket for the member");
      const ok = await used(ticketHash(a.nonce), L.userID);
      assert.deepStrictEqual([ok.status, ok.json.ok, ok.json.userID, ok.json.team], [200, true, L.userID, a.team]);
      assert.deepStrictEqual([(await used(ticketHash(a.nonce), L.userID)).json.error, (await used(ticketHash(a.nonce))).status], ["used", 403], "one use");
      assert.strictEqual((await join(a, L.userID)).json.error, "used", "verify-ticket knows it was used");
      assert.strictEqual((await used("ab".repeat(32))).json.error, "not-in-match", "a hash not of this match");
      assert.strictEqual((await used("zz")).json.error, "malformed");
      assert.strictEqual((await f.call("ticket-used", { matchId: "0000000000000000", hash: ticketHash(b.nonce) })).json.error, "match-not-running");
      await sleep(700);    // heartbeats: the used one is flagged
      assert.deepStrictEqual(f.assignment.tickets.map((t) => [t.userID, t.used]).sort(), [[L.userID, true], [M.userID, false]].sort());
      assert.strictEqual((await used(ticketHash(b.nonce), M.userID)).status, 200);
      const r = await f.result({ players: { [L.userID]: { joined: true }, [M.userID]: { joined: true } } });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.deepStrictEqual([r.json.paid, r.json.noShow], [2, []], "both joined through ticket-used");
    });

    await test("Ranked Duos: the party's ranked matches are rated from the server's team placement", async () => {
      clear(L, M);
      const lr = waitFor(L, "match-ready"), mr = waitFor(M, "match-ready");
      L.socket.emit("join-mm", { queueName: "ranked_coop2" });
      const [a, b] = await Promise.all([lr, mr]);
      assert.deepStrictEqual([a.ranked, b.ranked, a.netplay, a.gameServer === b.gameServer], ["duo", "duo", true, true]);
      const p0 = srv.profiles();
      const pendL = p0[L.userID].rankedTeams.duo.pending, pendM = p0[M.userID].rankedTeams.duo.pending;
      assert.ok(pendL && pendM && pendL.field === 8, "a pending Ranked Duos match each, 8 teams");
      // The HUD claims a win: ignored.
      assert.strictEqual((await srv.request("POST", "/api/matchresult", { victory: true, placement: 1 }, { Authorization: "Bearer " + M.token })).status, 202);
      assert.ok(srv.profiles()[M.userID].rankedTeams.duo.pending, "still pending after the client's post");
      const f = byAddress(a.gameServer);
      assert.strictEqual((await join(a, L.userID)).status, 200);
      assert.strictEqual((await join(b, M.userID)).status, 200);
      const teams = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ team: n, placement: 0, outcome: "out" }));
      // Placements 1..8 once each, the party's team third.
      const order = [1, 2, 3, 4, 5, 6, 7, 8].filter((n) => n !== a.team);
      order.splice(2, 0, a.team);
      order.forEach((team, i) => { teams.find((t) => t.team === team).placement = i + 1; });
      const r = await f.result({ teams });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const p1 = srv.profiles();
      for (const [u, pend] of [[L.userID, pendL], [M.userID, pendM]]) {
        const h = p1[u].rankedTeams.duo;
        assert.strictEqual(h.pending, null);
        assert.deepStrictEqual([h.history[0].matchId, h.history[0].placement, h.history[0].field, h.history[0].shared], [pend.id, 3, 8, true]);
        assert.ok(h.history[0].delta > 0, "third of 8 gains");
      }
    });

    await test("three parties and two solos in one Duos match: one match, every party one team, the solos paired", async () => {
      const A = [L, M];
      const B = [await player("Bear One"), await player("Bear Two")];
      const C = [await player("Crow One"), await player("Crow Two")];
      const S = [await player("Solo One"), await player("Solo Two")];
      await party(B[0], B[1]);
      await party(C[0], C[1]);
      const all = A.concat(B, C, S);
      clear(...all);
      const readies = all.map((p) => waitFor(p, "match-ready"));
      for (const leader of [L, B[0], C[0], S[0], S[1]]) leader.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const got = await Promise.all(readies);
      assert.strictEqual(new Set(got.map((x) => x.matchId)).size, 1, "one match for everyone");
      assert.strictEqual(new Set(got.map((x) => x.gameServer)).size, 1, "one address");
      const team = (p) => got[all.indexOf(p)].team;
      for (const [x, y] of [A, B, C]) assert.strictEqual(team(x), team(y), x.name + " and " + y.name + " together");
      assert.strictEqual(new Set([team(L), team(B[0]), team(C[0])]).size, 3, "each party its own team");
      assert.strictEqual(team(S[0]), team(S[1]), "the two solos make a team");
      assert.strictEqual(new Set(got.map((x) => x.team)).size, 4);
      const f = byAddress(got[0].gameServer);
      assert.deepStrictEqual([f.assignment.players, f.assignment.bots], [8, 8]);
      for (const p of all) assert.strictEqual((await join(got[all.indexOf(p)], p.userID)).status, 200, p.name);
      assert.strictEqual((await f.result({})).status, 200);
      world.more = { B, C, S };
    });

    await test("Trios: 15 contestants, a party of 2 with a solo fills one team; a party of 3 in Duos is refused", async () => {
      const [s1] = world.more.S;
      clear(L, M, s1);
      const readies = [L, M, s1].map((p) => waitFor(p, "match-ready"));
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop3" });
      s1.socket.emit("join-mm", { queueName: "ffa_jungle_coop3" });
      const got = await Promise.all(readies);
      assert.strictEqual(new Set(got.map((x) => x.team)).size, 1, "party of 2 + solo = one team of 3");
      const f = byAddress(got[0].gameServer);
      assert.deepStrictEqual([f.assignment.field, f.assignment.teamsCount, f.assignment.bots], [15, 5, 12]);
      assert.strictEqual((await f.result({})).status, 200);
      const [c1, c2] = world.more.C;
      // Crow's party takes in a third member: too many for Duos.
      const [b1, b2] = world.more.B;
      b1.socket.emit("party-leave"); b2.socket.emit("party-leave");
      await sleep(300);
      await world.party(c1, b1);
      const fail = waitFor(c1, "join-mm-fail");
      c1.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      assert.strictEqual((await fail).reason, "party-too-large");
      void c2;
    });

    await test("Solo (shared): a party can't be one team, refused; alone you get a shared FFA match", async () => {
      const fail = waitFor(L, "join-mm-fail");
      L.socket.emit("join-mm", { queueName: "ffa_jungle" });
      const f = await fail;
      assert.strictEqual(f.reason, "party-too-large");
      assert.ok(/every player for themselves/.test(f.message), f.message);
      const s1 = world.more.S[0];
      const r = waitFor(s1, "match-ready");
      s1.socket.emit("join-mm", { queueName: "ffa_jungle" });
      const ready = await r;
      assert.ok(ready.netplay && /^127\.0\.0\.1:\d+$/.test(ready.gameServer));
      const fk = byAddress(ready.gameServer);
      assert.deepStrictEqual([fk.assignment.teamSize, fk.assignment.teamsCount, fk.assignment.bots], [1, 16, 15]);
      assert.strictEqual((await fk.result({ players: { [s1.userID]: { placement: 1 } } })).status, 200);
    });

    await test("queue cancel, leader disconnect and a duplicate queue while the server starts", async () => {
      // A slow server: the match stays "allocating" long enough to act.
      gs1.crash();
      await sleep(1200);
      const slow = await gs(0, { readyDelayMs: 1200 }).start();
      fakes.push(slow);
      clear(L, M);
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      await waitFor(M, "remaster-shared-match", (x) => x.state === "allocating");
      const dup = waitFor(L, "join-mm-fail");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      assert.strictEqual((await dup).reason, "match-starting", "no second match while one is set up");
      const out = waitFor(M, "leave-mm-group"), ack = waitFor(L, "leave-mm-ack");
      L.socket.emit("leave-mm");
      await ack;
      assert.strictEqual((await out).reason, "party-member-cancelled");
      await sleep(1600);
      assert.strictEqual(L.of("match-ready").length + M.of("match-ready").length, 0, "nobody was sent in");
      let st = await sharedStats(srv);
      assert.deepStrictEqual([st.allocating, st.running], [0, 0]);
      assert.strictEqual(st.servers.servers.find((s) => s.id === "gs1").state, "idle", "the server was released");
      // The leader disconnects while it starts: the member is told, nobody goes in.
      clear(L, M);
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      await waitFor(M, "remaster-shared-match", (x) => x.state === "allocating");
      const out2 = waitFor(M, "leave-mm-group");
      L.socket.close();
      assert.strictEqual((await out2).reason, "party-member-disconnected");
      await sleep(1600);
      assert.strictEqual(M.of("match-ready").length, 0);
      st = await sharedStats(srv);
      assert.deepStrictEqual([st.allocating, st.running], [0, 0]);
      await world.connect(L);
      await sleep(300);
      // A party leaving while the server starts doesn't stop the others: a
      // solo in the same match still goes in, the party's slots become bots.
      const s1 = world.more.S[0];
      clear(L, M, s1);
      const sr = waitFor(s1, "match-ready", () => true, 8000);
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      s1.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      await waitFor(s1, "remaster-shared-match", (x) => x.state === "allocating");
      L.socket.emit("leave-mm");
      const got = await sr;
      assert.strictEqual(L.of("match-ready").length + M.of("match-ready").length, 0, "the party wasn't sent");
      assert.deepStrictEqual([slow.assignment.matchId, slow.assignment.players, slow.assignment.bots], [got.matchId, 1, 15],
        "the server's assignment no longer lists the party");
      assert.strictEqual(slow.assignment.teams.flatMap((t) => t.players).map((p) => p.userID).join(), s1.userID);
      assert.strictEqual((await slow.result({})).status, 200);
      slow.crash();
    });

    await test("allocation failure: no server free re-queues the party, which plays once a server is back", async () => {
      await sleep(1200);   // every server silent: offline
      clear(L, M);
      const rq = waitFor(L, "remaster-shared-match", (x) => x.state === "requeued");
      const rqm = waitFor(M, "remaster-shared-match", (x) => x.state === "requeued");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const lr = waitFor(L, "match-ready", () => true, 8000), mr = waitFor(M, "match-ready", () => true, 8000);
      const [x] = await Promise.all([rq, rqm]);
      assert.strictEqual(x.reason, "no-capacity");
      assert.ok(/Searching again/.test(x.message));
      // Back in a lobby together.
      await sleep(50);
      assert.ok(M.of("remaster-lobby").length > 0 && L.of("join-mm-ack").length > 0, "the party is searching again");
      const back = await gs(1).start();
      fakes.push(back);
      const [a, b] = await Promise.all([lr, mr]);
      assert.deepStrictEqual([a.gameServer, b.gameServer], ["127.0.0.1:" + ports[1], "127.0.0.1:" + ports[1]]);
      assert.strictEqual(a.team, b.team);
      assert.strictEqual((await back.result({})).status, 200);
      // Re-queued once (CULLING_SHARED_REQUEUE_MAX=1), then told: with no server at all, join-mm-fail.
      back.crash();
      await sleep(1200);
      clear(L, M);
      const f1 = waitFor(L, "join-mm-fail", () => true, 8000), f2 = waitFor(M, "join-mm-fail", () => true, 8000);
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const [e1] = await Promise.all([f1, f2]);
      assert.strictEqual(e1.reason, "allocation-failed");
      assert.ok(/Nobody was sent in/.test(e1.message), e1.message);
      assert.strictEqual(L.of("remaster-shared-match").filter((n) => n.state === "requeued").length, 1, "re-queued once, then told");
      assert.strictEqual(L.of("match-ready").length, 0);
    });

    await test("ready timeout: a server that never gets ready is released and the party re-queued", async () => {
      const lazy = await gs(2, { ready: false }).start();
      fakes.push(lazy);
      clear(L, M);
      const rq = waitFor(L, "remaster-shared-match", (x) => x.state === "requeued", 8000);
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      assert.strictEqual((await rq).reason, "ready-timeout");
      await waitFor(L, "join-mm-fail", () => true, 8000);   // and then no server left
      lazy.crash();
    });

    await test("a crash mid-match: cancelled, tickets revoked, ranked voided, both told and re-queued", async () => {
      const g = await gs(0).start();
      fakes.push(g);
      clear(L, M);
      const lr = waitFor(L, "match-ready"), mr = waitFor(M, "match-ready");
      L.socket.emit("join-mm", { queueName: "ranked_coop2" });
      const [a, b] = await Promise.all([lr, mr]);
      assert.strictEqual((await join(a, L.userID)).status, 200);
      const pend = srv.profiles()[L.userID].rankedTeams.duo;
      const matches = pend.matches, rating = pend.rating;
      assert.ok(pend.pending);
      const cl = waitFor(L, "remaster-shared-match", (x) => x.state === "cancelled"), cm = waitFor(M, "remaster-shared-match", (x) => x.state === "cancelled");
      const relobby = waitFor(M, "remaster-lobby", () => true, 8000);
      g.crash();
      const [x, y] = await Promise.all([cl, cm]);
      assert.deepStrictEqual([x.reason, x.matchId, x.requeued, y.requeued], ["heartbeat-timeout", a.matchId, true, true]);
      const after = srv.profiles()[L.userID].rankedTeams.duo;
      assert.deepStrictEqual([after.pending, after.matches, after.rating], [null, matches, rating], "voided: no rating lost, no match counted");
      // The server's result after the cancel, and a ticket of the cancelled match: refused.
      const late = await g.call("result", { matchId: a.matchId, players: [], teams: [] });
      assert.strictEqual(late.status, 409);
      const st = await sharedStats(srv);
      assert.strictEqual(st.running, 0);
      await relobby;   // re-queued: in a lobby again
      L.socket.emit("leave-mm");
      await sleep(1500);
      void b;
    });

    await test("a server aborting its match cancels it the same way", async () => {
      const g = await gs(1).start();
      fakes.push(g);
      await sleep(300);
      clear(L, M);
      const lr = waitFor(L, "match-ready");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const a = await lr;
      const cl = waitFor(L, "remaster-shared-match", (x) => x.state === "cancelled");
      const r = await post("http://" + a.gameServer, "/control/abort", "", {});
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      assert.strictEqual((await cl).reason, "server-aborted:test");
      L.socket.emit("leave-mm");
      await sleep(1500);
    });

    await test("game-server API: unsigned, wrongly signed, stale, replayed and unknown-server requests are refused", async () => {
      const body = JSON.stringify({ serverId: "gs2" });
      const raw = (headers, b = body) => srv.request("POST", "/api/gameserver/heartbeat", b, Object.assign({ "Content-Type": "text/plain" }, headers));
      assert.strictEqual((await raw({})).json.error, "unknown-server");
      const ts = Date.now();
      const good = { "X-Culling-Server": "gs2", "X-Culling-Timestamp": String(ts), "X-Culling-Signature": sign(serverSecret(MASTER, "gs2"), ts, "heartbeat", body) };
      assert.strictEqual((await raw(Object.assign({}, good, { "X-Culling-Signature": sign("wrong", ts, "heartbeat", body) }))).json.error, "bad-signature");
      assert.strictEqual((await raw(good)).status, 200);
      assert.strictEqual((await raw(good)).json.error, "replayed");
      const old = Date.now() - 120000;
      assert.strictEqual((await raw({ "X-Culling-Server": "gs2", "X-Culling-Timestamp": String(old),
        "X-Culling-Signature": sign(serverSecret(MASTER, "gs2"), old, "heartbeat", body) })).json.error, "stale-request");
      // Signed for one action, sent to another.
      const t2 = Date.now();
      const r = await srv.request("POST", "/api/gameserver/result", body, { "Content-Type": "text/plain", "X-Culling-Server": "gs2",
        "X-Culling-Timestamp": String(t2), "X-Culling-Signature": sign(serverSecret(MASTER, "gs2"), t2, "heartbeat", body) });
      assert.strictEqual(r.json.error, "bad-signature");
      // gs1's secret can't speak for gs2.
      const t3 = Date.now();
      const s = await srv.request("POST", "/api/gameserver/heartbeat", body, { "Content-Type": "text/plain", "X-Culling-Server": "gs2",
        "X-Culling-Timestamp": String(t3), "X-Culling-Signature": sign(serverSecret(MASTER, "gs1"), t3, "heartbeat", body) });
      assert.strictEqual(s.json.error, "bad-signature");
      assert.strictEqual((await srv.request("POST", "/api/gameserver/heartbeat", { serverId: "gs2" }, Object.assign({}, good))).json.error,
        "body-must-be-text", "a JSON body can't be checked byte for byte");
    });

    await test("a match's result from another server is refused; a malformed result changes nothing", async () => {
      const lr = waitFor(L, "match-ready");
      clear(L, M);
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const a = await lr;
      const owner = byAddress(a.gameServer);
      const other = fakes.find((f) => !f.dead && f !== owner) || await gs(2).start();
      if (!fakes.includes(other)) fakes.push(other);
      const r = await other.call("result", { matchId: a.matchId, players: [], teams: [] });
      assert.deepStrictEqual([r.status, r.json.error], [409, "match-not-running"]);
      const xp = srv.profiles()[L.userID].stats.xp;
      for (const [raw, err] of [[{ players: "x" }, "invalid-players"], [{ teams: [{ team: 1, placement: 1 }, { team: 2, placement: 1 }] }, "two-winners"],
        [{ teams: [{ team: 99, placement: 1 }] }, "invalid-team"]]) {
        const bad = await owner.call("result", Object.assign({ matchId: a.matchId, players: [], teams: [] }, raw));
        assert.deepStrictEqual([bad.status, bad.json.error], [400, err]);
      }
      const badPlace = await owner.result({ players: { [L.userID]: { placement: 17 } } });
      assert.deepStrictEqual([badPlace.status, badPlace.json.error], [400, "invalid-placement"]);
      assert.strictEqual(srv.profiles()[L.userID].stats.xp, xp, "nothing paid");
      assert.strictEqual((await owner.result({})).status, 200, "a good result still counts");
    });

    await test("a playlist not on the allow list (Quads) and Showdown stay local; the metrics show the shared state", async () => {
      clear(L, M);
      const lr = waitFor(L, "match-ready");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop4" });
      const a = await lr;
      assert.deepStrictEqual([a.gameServer, a.netplay], ["quad:0", false]);
      const hud = await srv.request("POST", "/api/matchresult", { victory: false, kills: 1, damage: 10, timeAlive: 20 }, { Authorization: "Bearer " + L.token });
      assert.strictEqual(hud.status, 200, "a local match is paid from the HUD as before");
      await srv.request("POST", "/api/matchresult", { victory: false }, { Authorization: "Bearer " + M.token });
      const st = await sharedStats(srv);
      assert.deepStrictEqual(st.playlists.sort(), ["coop2", "coop3", "ffa", "ranked_coop2", "ranked_ffa"], "showdown_duo and unknown names left out");
      assert.ok(st.servers.mode === "pool" && st.servers.maxMatches === 2);
      // Team Showdown is untouched: a lobby of one team, a local arena match.
      const sr = waitFor(L, "match-ready");
      L.socket.emit("join-mm", { queueName: "showdown_duo" });
      const s = await sr;
      assert.deepStrictEqual([s.gameServer, s.netplay], ["showdown:2", false]);
      L.socket.emit("showdown-leave");
      await srv.request("POST", "/api/matchresult", { victory: false }, { Authorization: "Bearer " + L.token });
      await srv.request("POST", "/api/matchresult", { victory: false }, { Authorization: "Bearer " + M.token });
    });
  } finally {
    for (const f of fakes) f.stop();
    if (world) for (const p of world.players) if (p.socket) p.socket.close();
    srv.stop();
  }

  // ------------------------------------------------------------ the test hook: parties queued as PLAY
  // CULLING_TEST_HOOKS=1 (netplay_run.py --party): POST /api/test/join-mm
  // with a party list forms a real party (the friends and party code) and
  // queues it from its leader's menu socket. Loopback only, no proxy header,
  // never with NODE_ENV=production.
  const hp = await freePort();
  const hsrv = startServer({ vars: sharedVars({ CULLING_SHARED_PLAYLISTS: "coop2,coop3,coop4", CULLING_GAMESERVER_POOL: "gsh@127.0.0.1:" + hp,
    CULLING_TEST_HOOKS: "1", CULLING_LOBBY_GATHER_MS: "600" }) });
  let hw = null, hg = null;
  try {
    await hsrv.ready();
    hw = await people(hsrv);
    afterFailure = async () => { for (const p of hw.players) if (p.socket && p.socket.connected) p.socket.emit("leave-mm"); await sleep(1500); };
    hg = await new FakeGameServer({ backend: "http://127.0.0.1:" + hsrv.port, serverId: "gsh", secret: serverSecret(MASTER, "gsh"), port: hp, heartbeatMs: 250 }).start();
    const ps = [];
    for (const n of ["Hook Ant", "Hook Bee", "Hook Cat", "Hook Dog", "Hook Eel"]) ps.push(await hw.player(n));
    const [a1, a2, b1, b2, c] = ps;
    const hook = (body, headers) => hsrv.request("POST", "/api/test/join-mm", body, headers);
    // Queues groups ([leader, ...members]) through the hook, plays the match
    // out (the fake server's result) and returns each player's team.
    async function play(queueName, groups) {
      const everyone = groups.flat();
      clear(...everyone);
      const readies = everyone.map((p) => waitFor(p, "match-ready", () => true, 8000));
      for (const [leader, ...members] of groups) {
        const r = await hook({ userID: leader.userID, queueName, party: members.map((m) => m.userID) });
        assert.strictEqual(r.status, 200, JSON.stringify(r.json));
        assert.deepStrictEqual(r.json.members.slice().sort(), [leader, ...members].map((p) => p.userID).sort(), "the party as asked");
      }
      const got = await Promise.all(readies);
      assert.strictEqual(new Set(got.map((m) => m.matchId)).size, 1, "one match for everyone");
      assert.ok(got.every((m) => m.netplay && m.gameServer === "127.0.0.1:" + hp));
      for (let i = 0; i < 40 && !(hg.assignment && hg.assignment.matchId === got[0].matchId && hg.readyPosted); i++) await sleep(25);
      const team = new Map();
      for (const t of hg.assignment.teams) for (const p of t.players) team.set(p.userID, t.team);
      for (const [i, p] of everyone.entries()) assert.strictEqual(got[i].team, team.get(p.userID), "match-ready's team is the server's");
      const r = await hg.result({ players: Object.fromEntries(everyone.map((p) => [p.userID, { joined: true }])) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      await sleep(300);
      return (p) => team.get(p.userID);
    }
    await test("test hook: a Duos party of 2 is one real party and one team", async () => {
      const team = await play("ffa_jungle_coop2", [[a1, a2]]);
      assert.strictEqual(team(a1), team(a2));
      const [m1, m2] = [a1.of("match-ready")[0], a2.of("match-ready")[0]];
      assert.ok(m1.partyId && m1.partyId === m2.partyId, "the party's id on match-ready");
    });
    await test("test hook: Trios, a party of 3 is one team; a party of 2 + a solo is one team", async () => {
      let team = await play("ffa_jungle_coop3", [[a1, a2, c]]);
      assert.ok(team(a1) === team(a2) && team(a2) === team(c), "party of 3");
      team = await play("ffa_jungle_coop3", [[a1, a2], [c]]);
      assert.ok(team(a1) === team(a2) && team(a2) === team(c), "party of 2 + solo: one team of 3");
    });
    await test("test hook: two parties of 2 share a Quads team (they fit) but never a Trios one", async () => {
      let team = await play("ffa_jungle_coop4", [[a1, a2], [b1, b2]]);
      assert.strictEqual(new Set([a1, a2, b1, b2].map(team)).size, 1, "Quads: 2 + 2 = one team of 4");
      team = await play("ffa_jungle_coop3", [[a1, a2], [b1, b2]]);
      assert.strictEqual(team(a1), team(a2));
      assert.strictEqual(team(b1), team(b2));
      assert.notStrictEqual(team(a1), team(b1), "Trios: two parties of 2 on two teams");
    });
    await test("test hook: refused behind a proxy header and for a player not logged in; an empty party list queues solo", async () => {
      for (const h of [{ "X-Forwarded-For": "203.0.113.9" }, { Forwarded: "for=203.0.113.9" }, { "X-Real-IP": "203.0.113.9" }]) {
        const r = await hook({ userID: a1.userID, queueName: "ffa_jungle_coop2" }, h);
        assert.strictEqual(r.status, 404, "behind a proxy: " + JSON.stringify(h));
      }
      assert.strictEqual((await hook({ userID: "steam:76561190000000001", queueName: "ffa_jungle_coop2" })).json.error, "not-logged-in");
      const r = await hook({ userID: a1.userID, queueName: "ffa_jungle_coop2", party: ["steam:76561190000000001"] });
      assert.deepStrictEqual([r.status, r.json.error], [409, "not-logged-in"]);
      const team = await play("ffa_jungle_coop2", [[a1], [c]]);
      assert.strictEqual(team(a1), team(c), "two solos paired (a1 left its party)");
    });
  } finally {
    if (hg) hg.stop();
    if (hw) for (const p of hw.players) if (p.socket) p.socket.close();
    hsrv.stop();
  }
  const prod = startServer({ vars: { NODE_ENV: "production", CULLING_TEST_HOOKS: "1" } });
  try {
    await prod.ready();
    await test("test hook: never with NODE_ENV=production", async () => {
      const r = await prod.request("POST", "/api/test/join-mm", { userID: "steam:76561190000000001", queueName: "ffa_jungle" });
      assert.strictEqual(r.status, 404);
    });
  } finally { prod.stop(); }

  // ------------------------------------------------------------ launch mode
  const lp = [await freePort(), await freePort()];
  const fakePath = path.join(__dirname, "fake_gameserver.js");
  const lsrv = startServer({ vars: sharedVars({ CULLING_SHARED_PLAYLISTS: "ffa",
    CULLING_GAMESERVER_COMMAND: JSON.stringify([process.execPath, fakePath, "--port", "{port}", "--host", "{host}"]),
    CULLING_GAMESERVER_PORTS: lp.join(","), CULLING_GAMESERVER_READY_TIMEOUT_MS: "5000" }) });
  let lw = null;
  try {
    await lsrv.ready();
    lw = await people(lsrv);
    afterFailure = async () => { for (const p of lw.players) if (p.socket && p.socket.connected) p.socket.emit("leave-mm"); await sleep(1500); };
    const P = await lw.player("Launch Lynx");
    await test("launch mode: a process per match on a free port; its result pays; it exits and the port is free", async () => {
      const r = waitFor(P, "match-ready", () => true, 10000);
      P.socket.emit("join-mm", { queueName: "ffa_jungle" });
      const a = await r;
      assert.ok(lp.map((x) => "127.0.0.1:" + x).includes(a.gameServer), a.gameServer);
      assert.strictEqual((await join(a, P.userID)).status, 200);
      const st = (await get("http://" + a.gameServer + "/state")).json;
      assert.deepStrictEqual([st.assignment.matchId, st.assignment.bots], [a.matchId, 15]);
      const xp = lsrv.profiles()[P.userID].stats.xp;
      const res = await post("http://" + a.gameServer, "/control/result", JSON.stringify({ players: { [P.userID]: { placement: 2, kills: 2, damage: 80, timeAlive: 20 } } }), {});
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      assert.strictEqual(lsrv.profiles()[P.userID].stats.xp - xp, xpOf({ victory: false, kills: 2, damage: 80, timeAlive: 20 }));
      await sleep(800);
      const s = (await metrics(lsrv)).sharedMatches.servers;
      assert.deepStrictEqual([s.active, s.servers.length], [0, 0], "the process exited and its slot is gone: " + JSON.stringify(s.servers));
    });
    await test("launch mode: the process dying mid-match cancels it (process-exited) and frees the port", async () => {
      clear(P);
      const r = waitFor(P, "match-ready", () => true, 10000);
      P.socket.emit("join-mm", { queueName: "ffa_jungle" });
      const a = await r;
      const c = waitFor(P, "remaster-shared-match", (x) => x.state === "cancelled");
      await post("http://" + a.gameServer, "/control/crash", "", {});
      const x = await c;
      assert.strictEqual(x.reason, "process-exited");
      P.socket.emit("leave-mm");
      await sleep(1500);
      const s = (await metrics(lsrv)).sharedMatches.servers;
      assert.strictEqual(s.active, 0);
    });
  } finally {
    if (lw) for (const p of lw.players) if (p.socket) p.socket.close();
    lsrv.stop();
  }

  // ------------------------------------------------------------ backend restart mid-match
  const rp = await freePort();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "culling-shared-restart-"));
  fs.copyFileSync(path.join(__dirname, "..", "data", "catalog.json"), path.join(dir, "catalog.json"));
  const backendPort = await freePort();
  const runBackend = () => spawn(process.execPath, [path.join(__dirname, "..", "server.js")], { stdio: "ignore",
    env: Object.assign({}, process.env, sharedVars({ CULLING_SHARED_PLAYLISTS: "ffa", CULLING_GAMESERVER_POOL: "gsr@127.0.0.1:" + rp }), {
      CULLING_PORT: String(backendPort), CULLING_DATA_DIR: dir, CULLING_SAVE_DELAY_MS: "0", CULLING_REQUIRE_ACCOUNT: "0", CULLING_MIN_MATCH_SECONDS: "0" }) });
  const rsrv = { dir, port: backendPort, proc: runBackend(), profiles: () => JSON.parse(fs.readFileSync(path.join(dir, "profiles.json"), "utf8")) };
  rsrv.request = (m, u, b, h) => requestTo(backendPort, m, u, b, h);
  rsrv.login = async (userid) => (await requestTo(backendPort, "POST", "/api/login", { userid, authType: "steam" })).json.token;
  rsrv.connect = (token) => connectTo(backendPort, token);
  const up = async () => { for (let i = 0; i < 100; i++) { try { await requestTo(backendPort, "GET", "/health"); return; } catch { await sleep(100); } } throw new Error("no backend"); };
  let rg = null, rw = null;
  try {
    await up();
    rw = await people(rsrv);
    const P = await rw.player("Restart Raven");
    rg = await new FakeGameServer({ backend: "http://127.0.0.1:" + backendPort, serverId: "gsr", secret: serverSecret(MASTER, "gsr"), port: rp, heartbeatMs: 250 }).start();
    await test("a backend restart mid-match: the game server's heartbeat takes the match up again; its result pays", async () => {
      const r = waitFor(P, "match-ready");
      P.socket.emit("join-mm", { queueName: "ffa_jungle" });
      const a = await r;
      assert.strictEqual((await join(a, P.userID)).status, 200);
      P.socket.close();
      rsrv.proc.kill();
      await new Promise((res) => rsrv.proc.once("exit", res));
      await sleep(500);
      rsrv.proc = runBackend();
      await up();
      await sleep(800);   // a few heartbeats
      const st = (await requestTo(backendPort, "GET", "/metrics")).json.sharedMatches;
      assert.deepStrictEqual([st.running, st.servers.servers[0].state, st.servers.servers[0].matchId], [1, "running", a.matchId], JSON.stringify(st.servers));
      // The used-ticket memory didn't survive the restart, the joined flag did: the same ticket again is refused.
      const again = await join(a, P.userID);
      assert.deepStrictEqual([again.status, again.json.error], [403, "already-joined"], JSON.stringify(again));
      const xp = rsrv.profiles()[P.userID].stats.xp;
      const res = await rg.result({ players: { [P.userID]: { placement: 1, kills: 4, damage: 300, timeAlive: 20 } } });
      assert.strictEqual(res.status, 200, JSON.stringify(res.json));
      assert.strictEqual(rsrv.profiles()[P.userID].stats.xp - xp, xpOf({ victory: true, kills: 4, damage: 300, timeAlive: 20 }));
    });
  } finally {
    if (rg) rg.stop();
    if (rw) for (const p of rw.players) if (p.socket) p.socket.close();
    rsrv.proc.kill();
    await sleep(300);
    try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); } catch { /* left */ }
  }

  // ------------------------------------------------------------ setting off
  const off = startServer({ vars: { CULLING_LOBBY_GATHER_MS: "300", CULLING_LOBBY_COUNTDOWN_MS: "100",
    // A pool and playlists configured but the switch off: nothing changes.
    CULLING_SHARED_PLAYLISTS: "coop2,ffa", CULLING_GAMESERVER_POOL: "gs1@127.0.0.1:1", CULLING_GAMESERVER_SECRET: MASTER } });
  let ow = null;
  try {
    await off.ready();
    ow = await people(off);
    const A = await ow.player("Off Otter"), B = await ow.player("Off Badger");
    await ow.party(A, B);
    await test("setting off: a Duos party gets the local duo:0 match, netplay false, paid from the HUD; no game-server API", async () => {
      const ar = waitFor(A, "match-ready"), br = waitFor(B, "match-ready");
      A.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const [a, b] = await Promise.all([ar, br]);
      assert.deepStrictEqual([a.gameServer, b.gameServer, a.netplay, b.netplay, a.matchId === b.matchId], ["duo:0", "duo:0", false, false, true]);
      assert.ok(!("team" in a) && /^[0-9a-f]{16}$/.test(a.nonce) && /^[0-9a-f]{16}$/.test(a.serverNonce), "the payload as today");
      assert.strictEqual(A.of("remaster-shared-match").length, 0);
      const t = JSON.parse(fs.readFileSync(path.join(off.dir, "tickets.json"), "utf8"));
      assert.ok(t.every((x) => !("shared" in x)), "tickets as today");
      const r = await off.request("POST", "/api/matchresult", { victory: false, kills: 1, damage: 10, timeAlive: 20 }, { Authorization: "Bearer " + A.token });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.xpEarned > 0);
      await off.request("POST", "/api/matchresult", { victory: false }, { Authorization: "Bearer " + B.token });
      // As today: an unknown URL (200 {}, nothing done).
      for (const action of ["register", "heartbeat", "verify-ticket", "result"]) {
        const g = await off.request("POST", "/api/gameserver/" + action, "{}", { "Content-Type": "text/plain" });
        assert.deepStrictEqual([g.status, g.json], [200, {}], action);
      }
      assert.deepStrictEqual((await metrics(off)).sharedMatches, { enabled: false });
      assert.ok(!fs.existsSync(path.join(off.dir, "gameserver-secret.txt")), "no secrets made");
      // Solo with a party: allowed as today (shared matches would refuse it).
      const sr = waitFor(A, "match-ready");
      A.socket.emit("join-mm", { queueName: "ffa_jungle" });
      assert.strictEqual((await sr).gameServer, "offline:0");
    });
  } finally {
    if (ow) for (const p of ow.players) if (p.socket) p.socket.close();
    off.stop();
  }

  console.log("\n" + passed + " passed, " + failed + " failed");
  process.exit(failed ? 1 : 0);
})();

// HTTP and socket clients for a backend this test launched itself.
function requestTo(port, method, url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path: url, method, headers: Object.assign({ "Content-Type": "application/json" }, headers) }, (res) => {
      let data = "";
      res.on("data", (c) => (data += c));
      res.on("end", () => { let json = null; try { json = JSON.parse(data); } catch { /* not json */ } resolve({ status: res.statusCode, json }); });
    });
    req.on("error", reject);
    if (body !== undefined) req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function connectTo(port, token) {
  const ioClient = require("socket.io-client");
  const socket = ioClient("http://127.0.0.1:" + port, { transports: ["websocket"], forceNew: true, reconnection: false });
  await new Promise((r) => socket.once("login_ready", r));
  const ok = new Promise((r) => { socket.once("auth-response", () => r(true)); socket.once("auth-fail", () => r(false)); });
  socket.emit("login", { token });
  return (await ok) ? socket : (socket.close(), null);
}
