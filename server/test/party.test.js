// Party -> queue -> lobby -> match, with real logged-in socket.io clients
// against a spawned server (docs/AUDIT_02_PARTY_MATCHMAKING.md).
//
// Matches run on each player's own PC against AI contestants; what the server
// owes a party is one shared record: every member in the same lobby, the same
// match id on every member's match-ready and ticket, the right playlist for
// each, and a party that never splits silently.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { startServer } = require("./helpers");

// A failed test leaves its players back in the menu (results posted, out of
// any queue) so the next one starts clean.
let passed = 0, failed = 0;
let afterFailure = async () => {};
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok    " + name); } catch (e) {
    failed++;
    console.log("FAIL  " + name + "\n      " + (e.stack || e.message).split("\n").slice(0, 3).join("\n      "));
    await afterFailure();
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Every queue/lobby/party event a client can get, kept in order.
const EVENTS = ["join-mm-ack", "join-mm-fail", "join-mm-group", "leave-mm-ack", "leave-mm-group", "remaster-lobby",
  "match-ready", "remaster-party-notice", "remaster-friends"];

// A promise for the next `event` matching `pred` (one left unawaited after a
// failed assertion doesn't crash the run).
function waitFor(p, event, pred = () => true, ms = 4000) {
  const got = new Promise((resolve, reject) => {
    const t = setTimeout(() => { p.socket.off(event, on); reject(new Error(p.name + ": timed out waiting for " + event)); }, ms);
    function on(m) { if (pred(m)) { clearTimeout(t); p.socket.off(event, on); resolve(m); } }
    p.socket.on(event, on);
  });
  got.catch(() => {});
  return got;
}

function recorder(socket) {
  const log = [];
  for (const e of EVENTS) socket.on(e, (m) => log.push({ e, m }));
  return { log, of: (e) => log.filter((x) => x.e === e).map((x) => x.m), clear: () => { log.length = 0; } };
}

async function run(srv, label) {
  let ip = 10;
  const players = [];
  async function player(name) {
    const r = await srv.request("POST", "/api/account/register",
      { username: name, email: name.replace(/\W/g, "").toLowerCase() + "@example.com", password: "long enough" },
      { "X-Forwarded-For": "198.51.100." + (ip++) });
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
    p.rec = recorder(p.socket);
    return p;
  }
  function act(p, event, msg) {
    const r = waitFor(p, "remaster-friend-result", (x) => x.action === event);
    p.socket.emit(event, msg);
    return r;
  }
  async function befriend(a, b) {
    await act(a, "friend-request", { username: b.name });
    assert.ok((await act(b, "friend-accept", { username: a.name })).ok);
  }
  async function party(leader, ...members) {
    let id = null;
    for (const m of members) {
      await befriend(leader, m);
      const inv = waitFor(m, "remaster-party-invite");
      const r = await act(leader, "party-invite", { username: m.name });
      assert.ok(r.ok, JSON.stringify(r));
      const got = await act(m, "party-accept", { partyId: (await inv).partyId });
      assert.ok(got.ok, JSON.stringify(got));
      id = got.partyId;
    }
    return id;
  }
  // The match each player was sent to, and the lobby they last saw before it.
  const lastLobby = (p) => p.rec.of("remaster-lobby").pop();
  const ready = (p) => p.rec.of("match-ready");
  // Plays the match out (the HUD's result), so the player is back in the menu.
  async function finish(p) {
    const r = await srv.request("POST", "/api/matchresult", { victory: false, kills: 1, damage: 50, timeAlive: 60, placement: 5, cap: 16 },
      { Authorization: "Bearer " + p.token });
    assert.strictEqual(r.status, 200, p.name + " result: " + JSON.stringify(r.json));
  }
  const clear = (...ps) => ps.forEach((p) => p.rec.clear());
  const tickets = () => { try { return JSON.parse(fs.readFileSync(path.join(srv.dir, "tickets.json"), "utf8")); } catch { return []; } };
  async function reset() {
    await sleep(1200);
    for (const p of players) {
      if (p.socket && p.socket.connected) p.socket.emit("leave-mm");
      await srv.request("POST", "/api/matchresult", { victory: false }, { Authorization: "Bearer " + p.token });
    }
    await sleep(300);
  }
  return { reset, player, connect, act, befriend, party, lastLobby, ready, finish, clear, tickets, players, label };
}

(async () => {
  const srv = startServer(8191, { vars: { CULLING_LOBBY_GATHER_MS: "400", CULLING_LOBBY_COUNTDOWN_MS: "400",
    CULLING_PARTY_OFFLINE_MS: "2500" } });
  const fault = startServer(8193, { vars: { CULLING_LOBBY_GATHER_MS: "200", CULLING_LOBBY_COUNTDOWN_MS: "100",
    CULLING_FAULT_ALLOCATION: "1" } });
  let h = null, hf = null;
  try {
    await srv.ready();
    await fault.ready();
    h = await run(srv, "main");
    afterFailure = h.reset;
    const { player, connect, act, party, lastLobby, ready, finish, clear, tickets } = h;

    const L = await player("Lead Wolf"), M = await player("Member Fox");
    const partyId = await party(L, M);

    await test("party queues for Duos: one lobby, one match id, the right playlist for both", async () => {
      clear(L, M);
      const lr = waitFor(L, "match-ready"), mr = waitFor(M, "match-ready");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const [a, b] = await Promise.all([lr, mr]);
      assert.strictEqual(M.rec.of("join-mm-group").length, 1, "the member's menu followed the leader once");
      assert.strictEqual(lastLobby(L).id, lastLobby(M).id, "the same lobby");
      assert.deepStrictEqual(lastLobby(L).players.map((p) => p.name).sort(), ["Lead Wolf", "Member Fox"]);
      assert.strictEqual(lastLobby(M).queue, "coop2");
      assert.strictEqual(a.gameServer, "duo:0");
      assert.strictEqual(b.gameServer, "duo:0", "the member plays Duo too");
      assert.ok(a.matchId && a.matchId === b.matchId, "the same match id: " + a.matchId + " / " + b.matchId);
      assert.strictEqual(a.lobbyId, b.lobbyId);
      assert.strictEqual(a.lobbyId, lastLobby(L).id);
      assert.strictEqual(a.partyId, partyId);
      assert.strictEqual(b.partyId, partyId, "consistent party id");
      assert.strictEqual(a.playlist, "coop2");
      const t = tickets().filter((x) => x.userID === L.userID || x.userID === M.userID);
      assert.strictEqual(t.length, 2, "a ticket each");
      assert.ok(t.every((x) => x.matchId === a.matchId && x.partyId === partyId && x.mode === "coop2"), JSON.stringify(t));
      await sleep(300);
      assert.strictEqual(ready(L).length + ready(M).length, 2, "one match-ready each");
      await finish(L); await finish(M);
    });

    await test("duplicate queue: the leader queueing again keeps the party in its lobby, one match each", async () => {
      clear(L, M);
      const lr = waitFor(L, "match-ready"), mr = waitFor(M, "match-ready");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      await waitFor(M, "join-mm-group");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      L.socket.emit("join-mm", { queueName: "ffa_prison_coop2" });
      const [a, b] = await Promise.all([lr, mr]);
      await sleep(900);
      const ids = new Set(L.rec.of("remaster-lobby").concat(M.rec.of("remaster-lobby")).map((l) => l.id));
      assert.strictEqual(ids.size, 1, "one lobby, not " + [...ids].join(","));
      assert.strictEqual(a.matchId, b.matchId);
      assert.deepStrictEqual([ready(L).length, ready(M).length], [1, 1], "one match-ready each");
      await finish(L); await finish(M);
    });

    await test("a member queueing on their own is refused with a reason; the party stays one unit", async () => {
      clear(L, M);
      const fail = waitFor(M, "join-mm-fail");
      M.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const f = await fail;
      assert.strictEqual(f.reason, "party-leader-queues");
      assert.ok(/Lead Wolf/.test(f.message), f.message);
      await sleep(200);
      assert.strictEqual(M.rec.of("remaster-lobby").length, 0, "not put in a lobby");
      assert.strictEqual(L.rec.of("join-mm-group").length + L.rec.of("remaster-lobby").length, 0, "the leader is not pulled anywhere");
    });

    await test("a member pressing Duo again while the party's lobby counts down stays in it (the split bug)", async () => {
      clear(L, M);
      const lr = waitFor(L, "match-ready"), mr = waitFor(M, "match-ready");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      await waitFor(M, "remaster-lobby", (l) => l.state === "starting");
      M.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const [a, b] = await Promise.all([lr, mr]);
      assert.strictEqual(a.matchId, b.matchId, "the same match");
      assert.strictEqual(a.lobbyId, b.lobbyId, "the same lobby");
      await sleep(900);
      assert.deepStrictEqual([ready(L).length, ready(M).length], [1, 1], "no second match for the member");
      const mine = new Set(M.rec.of("remaster-lobby").map((l) => l.id));
      assert.strictEqual(mine.size, 1, "the member never saw another lobby: " + [...mine].join(","));
      await finish(L); await finish(M);
    });

    await test("cancel: the leader cancelling takes the party out; a member cancelling does too", async () => {
      clear(L, M);
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      await waitFor(M, "join-mm-group");
      const ack = waitFor(L, "leave-mm-ack"), out = waitFor(M, "leave-mm-group");
      L.socket.emit("leave-mm");
      await ack; await out;
      clear(L, M);
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      await waitFor(M, "join-mm-group");
      const mack = waitFor(M, "leave-mm-ack"), lout = waitFor(L, "leave-mm-group");
      M.socket.emit("leave-mm");
      await mack;
      assert.strictEqual((await lout).reason, "party-member-cancelled");
      await sleep(1100);
      assert.deepStrictEqual([ready(L).length, ready(M).length], [0, 0], "nobody was sent into a match");
    });

    await test("repeated queue attempts: queue, cancel, queue... the last one is the party's only match", async () => {
      clear(L, M);
      for (let i = 0; i < 3; i++) {
        L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
        await waitFor(M, "join-mm-group");
        L.socket.emit("leave-mm");
        await waitFor(M, "leave-mm-group");
      }
      const lr = waitFor(L, "match-ready"), mr = waitFor(M, "match-ready");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const [a, b] = await Promise.all([lr, mr]);
      await sleep(1000);
      assert.strictEqual(a.matchId, b.matchId);
      assert.deepStrictEqual([ready(L).length, ready(M).length], [1, 1], "one match each, none from the cancelled queues");
      await finish(L); await finish(M);
    });

    await test("member disconnect: the party's search stops with a reason; reconnecting keeps the party", async () => {
      clear(L, M);
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      await waitFor(M, "join-mm-group");
      const out = waitFor(L, "leave-mm-group");
      M.socket.close();
      assert.strictEqual((await out).reason, "party-member-disconnected");
      await sleep(1000);
      assert.strictEqual(ready(L).length, 0, "the leader isn't sent on alone");
      // While the member is offline the leader is told why the party can't queue.
      const fail = waitFor(L, "join-mm-fail");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const f = await fail;
      assert.strictEqual(f.reason, "party-not-ready");
      assert.ok(/Member Fox/.test(f.message), f.message);
      await connect(M);
      const fr = await waitFor(M, "remaster-friends", (x) => x.party);
      assert.strictEqual(fr.party.id, partyId, "the same party id after reconnecting");
      assert.strictEqual(fr.party.leader, "Lead Wolf");
      const lr = waitFor(L, "match-ready"), mr = waitFor(M, "match-ready");
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const [a, b] = await Promise.all([lr, mr]);
      assert.strictEqual(a.matchId, b.matchId);
      await finish(L); await finish(M);
    });

    await test("leader disconnect: the member's search stops; the leader comes back still leading", async () => {
      clear(L, M);
      L.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      await waitFor(M, "join-mm-group");
      const out = waitFor(M, "leave-mm-group");
      L.socket.close();
      assert.strictEqual((await out).reason, "party-leader-disconnected");
      await sleep(1000);
      assert.strictEqual(ready(M).length, 0, "the member isn't sent on alone");
      await connect(L);
      const fr = await waitFor(L, "remaster-friends", (x) => x.party);
      assert.deepStrictEqual([fr.party.id, fr.party.leader, fr.party.members.length], [partyId, "Lead Wolf", 2]);
    });

    await test("a leader offline past the grace period leaves the party, with notice; the next member leads", async () => {
      const N = await player("Third Owl");
      await h.befriend(L, N);
      const inv = waitFor(N, "remaster-party-invite");
      await act(L, "party-invite", { username: N.name });
      assert.ok((await act(N, "party-accept", { partyId: (await inv).partyId })).ok);
      clear(L, M, N);
      const notice = waitFor(M, "remaster-party-notice", () => true, 5000);
      L.socket.close();
      const n = await notice;
      assert.strictEqual(n.reason, "member-offline");
      assert.ok(/Lead Wolf/.test(n.message), n.message);
      const fr = await waitFor(N, "remaster-friends", (x) => x.party && x.party.members.length === 2);
      assert.deepStrictEqual([fr.party.id, fr.party.leader], [partyId, "Member Fox"], "same party, next member leads");
      // L comes back as a friend outside the party; M and N play on as a party.
      await connect(L);
      const lr = waitFor(M, "match-ready"), nr = waitFor(N, "match-ready");
      M.socket.emit("join-mm", { queueName: "ffa_jungle" });
      const [a, b] = await Promise.all([lr, nr]);
      assert.strictEqual(a.matchId, b.matchId);
      await finish(M); await finish(N);
      h.N = N;
    });

    await test("Duos refuses a party of three instead of leaving one behind", async () => {
      const N = h.N;
      // M leads M + N; L (already M's friend) rejoins to make three.
      const inv = waitFor(L, "remaster-party-invite");
      assert.ok((await act(M, "party-invite", { username: L.name })).ok);
      assert.ok((await act(L, "party-accept", { partyId: (await inv).partyId })).ok);
      clear(L, M, N);
      const fail = waitFor(M, "join-mm-fail");
      M.socket.emit("join-mm", { queueName: "ffa_jungle_coop2" });
      const f = await fail;
      assert.strictEqual(f.reason, "party-too-large");
      await sleep(300);
      assert.strictEqual(L.rec.of("join-mm-group").length + N.rec.of("join-mm-group").length, 0, "nobody pulled");
      assert.strictEqual(M.rec.of("remaster-lobby").length, 0);
    });

    await test("Solo with a party of three: all three in one lobby and one match", async () => {
      const N = h.N;
      clear(L, M, N);
      const rs = [waitFor(L, "match-ready"), waitFor(M, "match-ready"), waitFor(N, "match-ready")];
      M.socket.emit("join-mm", { queueName: "ffa_prison" });
      const got = await Promise.all(rs);
      assert.strictEqual(new Set(got.map((g) => g.matchId)).size, 1);
      assert.ok(got.every((g) => g.gameServer === "offline:1"));
      await finish(L); await finish(M); await finish(N);
    });

    await test("Trio, Quad and team Showdown playlists are refused with a reason; Showdown Solo refuses a party", async () => {
      for (const [q, reason] of [["ffa_jungle_coop3", "mode-not-supported"], ["ffa_jungle_coop4", "mode-not-supported"],
        ["showdown_duo", "mode-not-supported"], ["showdown_trio", "mode-not-supported"], ["showdown_quad", "mode-not-supported"],
        ["ranked_showdown", "mode-not-supported"], ["showdown", "party-too-large"]]) {
        const fail = waitFor(M, "join-mm-fail");
        M.socket.emit("join-mm", { queueName: q });
        const f = await fail;
        assert.strictEqual(f.reason, reason, q + ": " + JSON.stringify(f));
        assert.ok(typeof f.message === "string" && f.message.length > 10, q + " explains itself");
      }
    });

    await test("only the leader invites; nobody joins or leaves a queued party without the queue stopping", async () => {
      const N = h.N;
      const O = await player("Fourth Elk");
      await h.befriend(N, O);
      assert.strictEqual((await act(N, "party-invite", { username: O.name })).error, "not-party-leader");
      await h.befriend(M, O);
      const inv = waitFor(O, "remaster-party-invite");
      assert.ok((await act(M, "party-invite", { username: O.name })).ok);
      const partyIdNow = (await inv).partyId;
      clear(L, M, N);
      M.socket.emit("join-mm", { queueName: "ffa_jungle" });
      await waitFor(N, "join-mm-group");
      assert.strictEqual((await act(O, "party-accept", { partyId: partyIdNow })).error, "party-in-queue");
      const outs = [waitFor(M, "leave-mm-group"), waitFor(L, "leave-mm-group")];
      assert.ok((await act(N, "party-leave")).ok);
      const [m1, l1] = await Promise.all(outs);
      assert.strictEqual(m1.reason, "party-changed");
      assert.strictEqual(l1.reason, "party-changed");
      await sleep(900);
      assert.deepStrictEqual([ready(L).length, ready(M).length, ready(N).length], [0, 0, 0]);
      h.O = O;
    });

    await test("a leader searching alone (invite still open) can't be joined mid-search; after it, the two queue as one", async () => {
      const N = h.N, O = h.O;
      const inv = waitFor(N, "remaster-party-invite");
      assert.ok((await act(O, "party-invite", { username: N.name })).ok, "O leads a party of one, N invited");
      const partyO = (await inv).partyId;
      clear(N, O);
      O.socket.emit("join-mm", { queueName: "ffa_jungle" });
      await waitFor(O, "remaster-lobby");
      assert.strictEqual((await act(N, "party-accept", { partyId: partyO })).error, "party-in-queue");
      O.socket.emit("leave-mm");
      await waitFor(O, "leave-mm-ack");
      assert.ok((await act(N, "party-accept", { partyId: partyO })).ok);
      const rs = [waitFor(O, "match-ready"), waitFor(N, "match-ready")];
      O.socket.emit("join-mm", { queueName: "ffa_jungle" });
      const [a, b] = await Promise.all(rs);
      assert.strictEqual(a.matchId, b.matchId);
      assert.strictEqual(a.partyId, partyO);
      await finish(O); await finish(N);
    });

    // ------------------------------------------------------- allocation failure
    hf = await run(fault, "fault");
    afterFailure = hf.reset;
    const FL = await hf.player("Fault Lead"), FM = await hf.player("Fault Member");
    await hf.party(FL, FM);

    await test("allocation failure: every member is told, nobody gets a match, ticket or ranked match", async () => {
      hf.clear(FL, FM);
      const fails = [waitFor(FL, "join-mm-fail"), waitFor(FM, "join-mm-fail")];
      FL.socket.emit("join-mm", { queueName: "ranked_ffa_jungle" });
      const [a, b] = await Promise.all(fails);
      assert.strictEqual(a.reason, "allocation-failed");
      assert.strictEqual(b.reason, "allocation-failed");
      await sleep(300);
      assert.deepStrictEqual([hf.ready(FL).length, hf.ready(FM).length], [0, 0]);
      const profiles = fault.profiles();
      for (const p of [FL, FM]) {
        const r = profiles[p.userID] && profiles[p.userID].ranked;
        assert.ok(!r || !r.pending, p.name + ": no ranked match started");
        const res = await fault.request("POST", "/api/matchresult", { victory: true, placement: 1 }, { Authorization: "Bearer " + p.token });
        assert.strictEqual(res.status, 409, "no ticket to claim");
      }
      // Back in the menu: the party can queue again (and fail again, cleanly).
      const again = waitFor(FL, "join-mm-fail");
      FL.socket.emit("join-mm", { queueName: "ffa_jungle" });
      assert.strictEqual((await again).reason, "allocation-failed");
    });

    console.log("%s: %d passed, %d failed", "party tests", passed, failed);
    if (failed) process.exitCode = 1;
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const x of [h, hf]) if (x) for (const p of x.players) if (p.socket) p.socket.close();
    srv.stop();
    fault.stop();
  }
})();
