// Friends, parties and player cards.
// Part 1: the rules (server/friends.js) and a party joining one lobby
// (MatchLobbies.joinGroup). Part 2: a throwaway server - requests by username,
// what friends see of each other's status, a party queueing together, and the
// player card.
"use strict";

const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { Friends } = require("../friends");
const { MatchLobbies } = require("../matchlobby");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// The next remaster-friends push that passes `check`.
function friendsWhen(socket, check, ms = 3000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { socket.off("remaster-friends", on); reject(new Error("no matching remaster-friends")); }, ms);
    function on(f) { if (check(f)) { clearTimeout(t); socket.off("remaster-friends", on); resolve(f); } }
    socket.on("remaster-friends", on);
  });
}

(async () => {
  // ------------------------------------------------------------ rules
  await test("a request, accepted, makes friends both ways", async () => {
    const f = new Friends(null);
    assert.deepStrictEqual(f.request("a", "b"), { ok: true, state: "requested" });
    assert.deepStrictEqual(f.peek("b").incoming, ["a"]);
    assert.deepStrictEqual(f.accept("b", "a"), { ok: true, state: "friends" });
    assert.ok(f.areFriends("a", "b") && f.areFriends("b", "a"));
    assert.deepStrictEqual([f.peek("a").outgoing, f.peek("b").incoming], [[], []]);
  });

  await test("self, duplicate and already-friends requests are refused", async () => {
    const f = new Friends(null);
    assert.strictEqual(f.request("a", "a").error, "self");
    f.request("a", "b");
    assert.strictEqual(f.request("a", "b").error, "already-requested");
    f.accept("b", "a");
    assert.strictEqual(f.request("a", "b").error, "already-friends");
    assert.strictEqual(f.accept("a", "c").error, "no-request");
  });

  await test("asking someone who already asked you accepts at once", async () => {
    const f = new Friends(null);
    f.request("a", "b");
    assert.deepStrictEqual(f.request("b", "a"), { ok: true, state: "friends" });
    assert.ok(f.areFriends("a", "b"));
  });

  await test("decline, cancel and remove", async () => {
    const f = new Friends(null);
    f.request("a", "b");
    assert.ok(f.decline("b", "a").ok, "declined");
    assert.deepStrictEqual([f.peek("a").outgoing, f.peek("b").incoming], [[], []]);
    f.request("a", "b");
    assert.ok(f.decline("a", "b").ok, "cancelled by the sender");
    assert.strictEqual(f.decline("a", "b").error, "no-request");
    f.request("a", "b"); f.accept("b", "a");
    assert.ok(f.remove("b", "a").ok);
    assert.ok(!f.areFriends("a", "b"));
    assert.strictEqual(f.remove("b", "a").error, "not-friends");
  });

  await test("pending requests are capped", async () => {
    const f = new Friends(null, { limits: { maxPending: 2 } });
    f.request("a", "b"); f.request("a", "c");
    assert.strictEqual(f.request("a", "d").error, "too-many-requests");
  });

  await test("parties: invite friends, accept, at most 4, leader passes on", async () => {
    const f = new Friends(null);
    for (const x of ["b", "c", "d", "e"]) { f.request("a", x); f.accept(x, "a"); }
    f.request("b", "c"); f.accept("c", "b");
    assert.strictEqual(f.invite("a", "z").error, "not-friends");
    const { partyId } = f.invite("a", "b");
    assert.ok(partyId);
    assert.deepStrictEqual(f.invitesFor("b"), [{ partyId, from: "a" }]);
    assert.ok(f.acceptInvite("b", partyId).ok);
    assert.strictEqual(f.invite("a", "b").error, "already-in-party");
    f.invite("a", "c"); f.acceptInvite("c", partyId);
    f.invite("a", "d"); f.invite("a", "e");
    assert.ok(f.acceptInvite("d", partyId).ok);
    assert.strictEqual(f.acceptInvite("e", partyId).error, "party-full");
    assert.strictEqual(f.invite("a", "e").error, "party-full");
    f.leave("a");
    assert.strictEqual(f.party("b").leader, "b", "the next member leads");
    assert.deepStrictEqual(f.party("b").members, ["b", "c", "d"]);
  });

  await test("a party of one is dropped; invites expire", async () => {
    let t = 0;
    const f = new Friends(null, { now: () => t });
    f.request("a", "b"); f.accept("b", "a");
    const { partyId } = f.invite("a", "b");
    assert.ok(f.declineInvite("b", partyId).ok);
    assert.strictEqual(f.party("a"), null, "nobody joined");
    const again = f.invite("a", "b").partyId;
    t = 6 * 60 * 1000;
    assert.deepStrictEqual(f.invitesFor("b"), []);
    assert.strictEqual(f.acceptInvite("b", again).error, "no-invite");
  });

  await test("joining another party leaves the first", async () => {
    const f = new Friends(null);
    for (const [x, y] of [["a", "c"], ["b", "c"], ["a", "d"]]) { f.request(x, y); f.accept(y, x); }
    const p1 = f.invite("a", "c").partyId; f.acceptInvite("c", p1);
    f.invite("a", "d"); f.acceptInvite("d", p1);
    const p2 = f.invite("b", "c").partyId;
    const r = f.acceptInvite("c", p2);
    assert.ok(r.ok && r.left.id === p1);
    assert.deepStrictEqual(f.party("a").members, ["a", "d"]);
    assert.deepStrictEqual(f.party("c").members, ["b", "c"]);
  });

  await test("friends are saved and read back", async () => {
    const file = path.join(require("os").tmpdir(), "friends-test-" + process.pid + ".json");
    try {
      const f = new Friends(file, { saveDelayMs: 0 });
      f.request("a", "b"); f.accept("b", "a"); f.request("a", "c");
      f.close();
      const g = new Friends(file);
      assert.ok(g.areFriends("a", "b"));
      assert.deepStrictEqual(g.peek("c").incoming, ["a"]);
      assert.strictEqual(g.party("a"), null, "parties are not saved");
    } finally { fs.rmSync(file, { force: true }); }
  });

  await test("joinGroup puts a party in one lobby, opening the next when it would not fit", async () => {
    const sent = [];
    const lobbies = new MatchLobbies({ describe: (m) => ({ name: m.id }), send: (m, p) => sent.push(p), start: () => {},
      options: { maxPlayers: 4 }, setTimer: () => 0, clearTimer: () => {} });
    for (const id of ["x1", "x2", "x3"]) lobbies.join("ffa", { id });
    const lobby = lobbies.joinGroup("ffa", [{ id: "p1" }, { id: "p2" }]);
    assert.notStrictEqual(lobby, lobbies.byMember.get("x1"), "a new lobby: two would not fit with three");
    assert.strictEqual(lobbies.byMember.get("x1").state, "starting", "the full one starts");
    assert.strictEqual(lobbies.byMember.get("p1"), lobbies.byMember.get("p2"));
    assert.deepStrictEqual([...lobby.members.keys()], ["p1", "p2"]);
  });

  // ------------------------------------------------------------ server
  const srv = startServer(8163);
  const sockets = [];
  try {
    await srv.ready();
    let ip = 10;
    async function player(username) {
      const r = await srv.request("POST", "/api/account/register",
        { username, email: "p" + ip + "@example.com", password: "long enough" }, { "X-Forwarded-For": "198.51.100." + (ip++) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const token = await srv.login(r.json.userID);
      const socket = await srv.connect(token);
      sockets.push(socket);
      return { username, userID: r.json.userID, token, socket };
    }
    function act(p, event, msg) {
      const r = next(p.socket, "remaster-friend-result");
      p.socket.emit(event, msg);
      return r;
    }
    const A = await player("Alpha Wolf");
    const B = await player("bravo");
    const C = await player("Charlie_3");

    await test("friends-get answers with your name and empty lists", async () => {
      const f = next(A.socket, "remaster-friends");
      A.socket.emit("friends-get");
      const got = await f;
      assert.strictEqual(got.you, "Alpha Wolf");
      assert.deepStrictEqual([got.friends, got.incoming, got.outgoing, got.party], [[], [], [], null]);
      assert.strictEqual(got.maxParty, 4);
    });

    await test("requests by username: unknown names, yourself and duplicates are refused", async () => {
      assert.strictEqual((await act(A, "friend-request", { username: "nobody at all" })).error, "no-such-player");
      assert.strictEqual((await act(A, "friend-request", { username: "alpha  WOLF" })).error, "self");
      const incoming = friendsWhen(B.socket, (f) => f.incoming.length === 1);
      const r = await act(A, "friend-request", { username: "BRAVO" });
      assert.deepStrictEqual([r.ok, r.state, r.username], [true, "requested", "bravo"]);
      assert.strictEqual((await incoming).incoming[0].username, "Alpha Wolf");
      assert.strictEqual((await act(A, "friend-request", { username: "bravo" })).error, "already-requested");
    });

    await test("accepting: both see each other in the menu", async () => {
      const seen = friendsWhen(A.socket, (f) => f.friends.length === 1);
      assert.ok((await act(B, "friend-accept", { username: "Alpha Wolf" })).ok);
      const f = await seen;
      assert.strictEqual(f.friends[0].username, "bravo");
      assert.deepStrictEqual([f.friends[0].status.state, f.friends[0].status.label], ["menu", "In menu"]);
      assert.deepStrictEqual(f.outgoing, []);
      assert.ok(Number.isFinite(f.friends[0].level));
    });

    await test("friends see searching, then in match, then back in the menu", async () => {
      const searching = friendsWhen(A.socket, (f) => f.friends[0].status.state === "searching");
      B.socket.emit("join-mm", { queueName: "ffa_jungle" });
      assert.strictEqual((await searching).friends[0].status.label, "Searching · Solo");
      const playing = friendsWhen(A.socket, (f) => f.friends[0].status.state === "match");
      await next(B.socket, "match-ready");
      assert.strictEqual((await playing).friends[0].status.label, "In match · Solo");
      const back = friendsWhen(A.socket, (f) => f.friends[0].status.state === "menu");
      const r = await srv.request("POST", "/api/matchresult", { victory: true, kills: 3, damage: 200, timeAlive: 300, placement: 1, cap: 24 },
        { Authorization: "Bearer " + B.token });
      assert.strictEqual(r.status, 200);
      await back;
    });

    await test("a party: invite a friend, they accept, not strangers", async () => {
      assert.strictEqual((await act(A, "party-invite", { username: "Charlie_3" })).error, "not-friends");
      const invited = next(B.socket, "remaster-party-invite");
      const r = await act(A, "party-invite", { username: "bravo" });
      assert.ok(r.ok && r.partyId);
      const inv = await invited;
      assert.strictEqual(inv.from.username, "Alpha Wolf");
      const joined = friendsWhen(A.socket, (f) => f.party && f.party.members.length === 2);
      assert.ok((await act(B, "party-accept", { partyId: inv.partyId })).ok);
      const f = await joined;
      assert.strictEqual(f.party.leader, "Alpha Wolf");
      assert.deepStrictEqual(f.party.members.map((m) => [m.username, m.leader]), [["Alpha Wolf", true], ["bravo", false]]);
    });

    await test("the leader queues the party: both in one lobby, the member's menu follows", async () => {
      let last = null;
      const track = (l) => { last = l; };
      A.socket.on("remaster-lobby", track);
      const group = next(B.socket, "join-mm-group");
      const lb = next(B.socket, "remaster-lobby");
      A.socket.emit("join-mm", { queueName: "ffa_prison_coop2" });
      await group;
      const b = await lb;
      await sleep(50);
      A.socket.off("remaster-lobby", track);
      assert.strictEqual(last.id, b.id, "the same lobby");
      assert.strictEqual(last.queue, "coop2");
      assert.deepStrictEqual(last.players.map((p) => p.name).sort(), ["Alpha Wolf", "bravo"]);
      const left = next(B.socket, "leave-mm-group");
      A.socket.emit("leave-mm");
      await left;
    });

    await test("a party member leaving: the party of one is gone", async () => {
      const gone = friendsWhen(A.socket, (f) => f.party === null);
      assert.ok((await act(B, "party-leave")).ok);
      await gone;
      assert.strictEqual((await act(B, "party-leave")).error, "not-in-party");
    });

    await test("the player card: record, K/D, time played, ranked and Showdown", async () => {
      const card = next(A.socket, "remaster-player-card");
      A.socket.emit("player-card", { username: "Bravo" });
      const c = await card;
      assert.ok(c.found);
      assert.strictEqual(c.username, "bravo");
      assert.deepStrictEqual([c.games, c.wins, c.losses], [1, 1, 0]);
      assert.strictEqual(c.kd, c.kills, "no deaths: K/D is the kills");
      assert.ok(c.minutesPlayed > 0, "time played");
      assert.deepStrictEqual(c.showdown, { won: 0, lost: 0 });
      assert.strictEqual(c.relation, "friend");
      assert.strictEqual(c.status.state, "menu");
      assert.ok(!("userID" in c) && !JSON.stringify(c).includes(B.userID), "no IDs");
      const none = next(A.socket, "remaster-player-card");
      A.socket.emit("player-card", { username: "Not Here" });
      assert.deepStrictEqual(await none, { found: false, username: "Not Here" });
    });

    await test("your own card; a forfeited Showdown counts as a series lost", async () => {
      const ready = next(C.socket, "match-ready");
      C.socket.emit("join-mm", { queueName: "showdown" });
      await ready;
      C.socket.emit("showdown-leave");
      await sleep(100);
      const card = next(C.socket, "remaster-player-card");
      C.socket.emit("player-card");
      const c = await card;
      assert.deepStrictEqual([c.username, c.relation], ["Charlie_3", "you"]);
      assert.deepStrictEqual(c.showdown, { won: 0, lost: 1 });
      assert.strictEqual(c.ranked, null, "no ranked matches yet");
    });

    await test("going offline: friends see it, with when they were last seen", async () => {
      const off = friendsWhen(A.socket, (f) => f.friends[0].status.state === "offline");
      B.socket.close();
      const f = await off;
      assert.strictEqual(f.friends[0].status.label, "Offline");
      assert.ok(f.friends[0].status.lastSeen > Date.now() - 60000);
      const saved = JSON.parse(fs.readFileSync(path.join(srv.dir, "friends.json"), "utf8"));
      assert.deepStrictEqual(saved.users[A.userID].friends, [B.userID], "saved");
    });

    await test("removing a friend", async () => {
      const B2 = { socket: await srv.connect(await srv.login(B.userID)) };
      sockets.push(B2.socket);
      const gone = friendsWhen(B2.socket, (f) => f.friends.length === 0);
      assert.ok((await act(A, "friend-remove", { username: "bravo" })).ok);
      await gone;
      assert.strictEqual((await act(A, "friend-remove", { username: "bravo" })).error, "not-friends");
    });

    await test("players without an account get no-account", async () => {
      const s = await srv.connect(await srv.login("steam:76561190000000999"));
      sockets.push(s);
      const r = next(s, "remaster-friend-result");
      s.emit("friend-request", { username: "bravo" });
      assert.strictEqual((await r).error, "no-account");
    });

    await test("friend actions are rate limited", async () => {
      const results = [];
      C.socket.on("remaster-friend-result", (r) => results.push(r.error));
      for (let i = 0; i < 30; i++) C.socket.emit("friend-decline", { username: "bravo" });
      await sleep(500);
      assert.strictEqual(results.length, 30);
      assert.ok(results.filter((e) => e === "slow-down").length >= 8, results.join());
      assert.ok(results.filter((e) => e === "no-request").length >= 20);
    });

    console.log("all %d friends tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
})();
