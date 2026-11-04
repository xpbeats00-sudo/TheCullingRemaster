// Matchmaking lobbies: the rules on a fake clock, then two players on a real
// server seeing each other before their matches start.
"use strict";

const assert = require("assert");
const { MatchLobbies } = require("../matchlobby");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

// A clock and timers the test moves by hand.
function fakeTime() {
  let t = 1000, seq = 0;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => { const id = ++seq; timers.set(id, { at: t + ms, fn }); return id; },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      const end = t + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        t = due[1].at;
        due[1].fn();
      }
      t = end;
    }
  };
}

function setup(options = {}) {
  const time = fakeTime();
  const sent = [], started = [];
  const lobbies = new MatchLobbies(Object.assign({
    options: Object.assign({ gatherMs: 10000, countdownMs: 5000, maxPlayers: 3, note: "bots" }, options),
    describe: (m) => ({ name: m.id }),
    send: (m, payload) => sent.push({ to: m.id, payload }),
    start: (lobby) => started.push({ queue: lobby.queue, players: [...lobby.members.keys()] })
  }, time));
  const last = (id) => sent.filter((s) => s.to === id).pop().payload;
  return { time, lobbies, sent, started, last };
}

(async () => {
  await test("players searching one playlist share a lobby and see each other", () => {
    const { lobbies, last } = setup();
    lobbies.join("ffa", { id: "a" });
    lobbies.join("ffa", { id: "b" });
    lobbies.join("coop2", { id: "c" });
    assert.deepStrictEqual(last("a").players.map((p) => p.name), ["a", "b"]);
    assert.deepStrictEqual(last("c").players.map((p) => p.name), ["c"]);
    assert.strictEqual(last("a").state, "searching");
    assert.strictEqual(last("a").note, "bots");
  });

  await test("after gathering, a countdown, then everyone starts together", () => {
    const { time, lobbies, started, last } = setup();
    lobbies.join("ffa", { id: "a" });
    time.advance(4000);
    lobbies.join("ffa", { id: "b" });
    assert.strictEqual(last("b").gatherEndsInMs, 6000, "the gather time runs from the first player");
    time.advance(6000);
    assert.strictEqual(last("a").state, "starting");
    assert.strictEqual(last("a").startsInMs, 5000);
    assert.strictEqual(started.length, 0);
    time.advance(5000);
    assert.deepStrictEqual(started, [{ queue: "ffa", players: ["a", "b"] }]);
  });

  await test("a full lobby starts its countdown at once; the next player gets a new lobby", () => {
    const { lobbies, last } = setup();
    for (const id of ["a", "b", "c"]) lobbies.join("ffa", { id });
    assert.strictEqual(last("c").state, "starting");
    lobbies.join("ffa", { id: "d" });
    assert.deepStrictEqual(last("d").players.map((p) => p.name), ["d"]);
    assert.notStrictEqual(last("d").id, last("a").id);
  });

  await test("leaving (cancel, disconnect) updates the others; an empty lobby is dropped", () => {
    const { time, lobbies, started, last } = setup();
    lobbies.join("ffa", { id: "a" });
    lobbies.join("ffa", { id: "b" });
    assert.ok(lobbies.leave("a"));
    assert.deepStrictEqual(last("b").players.map((p) => p.name), ["b"]);
    assert.ok(lobbies.leave("b"));
    assert.ok(!lobbies.leave("b"), "only once");
    time.advance(20000);
    assert.strictEqual(started.length, 0, "nobody left to start");
    assert.deepStrictEqual(lobbies.stats(), { lobbies: 0, waiting: 0 });
  });

  await test("searching again moves a player instead of copying them", () => {
    const { lobbies, last } = setup();
    lobbies.join("ffa", { id: "a" });
    lobbies.join("ffa", { id: "b" });
    lobbies.join("coop2", { id: "a" });
    assert.deepStrictEqual(last("b").players.map((p) => p.name), ["b"]);
    assert.deepStrictEqual(lobbies.stats(), { lobbies: 2, waiting: 2 });
  });

  await test("someone who leaves during the countdown isn't sent in", () => {
    const { time, lobbies, started } = setup();
    lobbies.join("ffa", { id: "a" });
    lobbies.join("ffa", { id: "b" });
    time.advance(10000);
    lobbies.leave("b");
    time.advance(5000);
    assert.deepStrictEqual(started, [{ queue: "ffa", players: ["a"] }]);
  });

  // On the real server (gather 300 ms, countdown 100 ms in tests).
  const srv = startServer(8141);
  const sockets = [];
  try {
    await srv.ready();
    const A = "steam:76561190000000301", B = "steam:76561190000000302";
    const a = await srv.connect(await srv.login(A));
    const b = await srv.connect(await srv.login(B));
    sockets.push(a, b);
    a.emit("set-card", { cardID: 42 });

    await test("on the server: both players see the lobby with cards, then both matches start", async () => {
      const seen = [];
      a.on("remaster-lobby", (l) => seen.push(l));
      a.emit("join-mm", { queueName: "ffa" });
      await next(a, "join-mm-ack");
      b.emit("join-mm", { queueName: "ffa" });
      const [ma, mb] = await Promise.all([next(a, "match-ready"), next(b, "match-ready")]);
      assert.ok(ma.gameServer.startsWith("offline:") && mb.gameServer.startsWith("offline:"));
      const both = seen.find((l) => l.players.length === 2);
      assert.ok(both, "a saw both players");
      assert.deepStrictEqual(both.players.map((p) => p.cardID).sort(), [0, 42]);
      assert.ok(both.players.every((p) => p.name === "Player" && p.level >= 1 && !("userID" in p)), "no IDs shown");
      assert.ok(seen.some((l) => l.state === "starting"));
    });

    await test("on the server: cancelling leaves the lobby and no match starts", async () => {
      a.emit("join-mm", { queueName: "ffa" });
      await next(a, "join-mm-ack");
      a.emit("leave-mm");
      await next(a, "leave-mm-ack");
      const started = await Promise.race([next(a, "match-ready").then(() => true), new Promise((r) => setTimeout(() => r(false), 800))]);
      assert.strictEqual(started, false);
      const m = (await srv.request("GET", "/metrics")).json;
      assert.deepStrictEqual(m.gauges ? m.gauges.matchLobbies : m.matchLobbies, { lobbies: 0, waiting: 0 });
    });

    console.log("all %d match lobby tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
})();
