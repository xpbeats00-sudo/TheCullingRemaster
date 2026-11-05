// Playlists (server/playlists.js; docs/SHOWDOWN_MODE_DESIGN.md) and Ranked's
// anti-abuse: queue names resolve to the right playlist, disabled ones are
// refused with a reason, party sizes are checked, and a ranked result is only
// ever scored from the ticket the server issued, within bounds.
"use strict";

const assert = require("assert");
const playlists = require("../playlists");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

(async () => {
  await test("queue names resolve to playlists (unknown names are Solo, never a lobby of their own)", () => {
    const table = {
      ffa: "ffa", ffa_jungle: "ffa", ffa_prison: "ffa", quick_play: "ffa", whatever: "ffa", "": "ffa", "bad name!": "ffa",
      lightning: "lightning", lightning_jungle: "lightning",
      coop2: "coop2", ffa_jungle_coop2: "coop2", ffa_prison_coop2: "coop2",
      coop3: "coop3", ffa_jungle_coop3: "coop3", trio: "coop3", coop4: "coop4", ffa_prison_coop4: "coop4", quads: "coop4",
      ranked_ffa: "ranked_ffa", ranked_ffa_jungle: "ranked_ffa", ranked: "ranked_ffa",
      ranked_coop2: "ranked_coop2", ranked_ffa_prison_coop2: "ranked_coop2", ranked_coop3: "ranked_coop3", ranked_coop4: "ranked_coop4",
      showdown: "showdown", showdown_solo: "showdown", showdown_duo: "showdown_duo", showdown_2v2: "showdown_duo",
      showdown_trio: "showdown_trio", showdown_quad: "showdown_quad", showdown_4v4: "showdown_quad",
      ranked_showdown: "ranked_showdown", ranked_showdown_duo: "ranked_showdown"
    };
    for (const [q, want] of Object.entries(table)) assert.strictEqual(playlists.resolve(q).playlist.id, want, q);
    assert.strictEqual(playlists.resolve(42).playlist.id, "ffa", "not a string");
    assert.deepStrictEqual([playlists.resolve("ffa_prison_coop2").map, playlists.resolve("ffa_jungle").map, playlists.resolve("ffa").map],
      ["prison", "jungle", null]);
  });

  await test("only Solo, Lightning, Duos, Trios, Quads, Ranked Solo and Showdown Solo are enabled", () => {
    const on = playlists.list().filter((p) => p.enabled).map((p) => p.id).sort();
    assert.deepStrictEqual(on, ["coop2", "coop3", "coop4", "ffa", "lightning", "ranked_ffa", "showdown"]);
    for (const p of playlists.list().filter((x) => !x.enabled)) {
      assert.ok(p.reason && p.message && p.message.length > 20, p.id + " says why it's disabled");
    }
    const sd = playlists.PLAYLISTS;
    assert.deepStrictEqual([sd.showdown.format, sd.showdown_duo.format, sd.showdown_trio.format, sd.showdown_quad.format],
      ["1v1", "2v2", "3v3", "4v4"]);
    assert.deepStrictEqual([sd.coop2.teamSize, sd.coop3.teamSize, sd.coop4.teamSize], [2, 3, 4]);
    assert.ok(sd.ranked_showdown.ranked && !sd.ranked_showdown.enabled);
  });

  await test("party sizes: never more than the team, Showdown Solo alone", () => {
    const P = playlists.PLAYLISTS;
    assert.ok(playlists.checkParty(P.ffa, 4).ok);
    assert.strictEqual(playlists.checkParty(P.ffa, 5).error, "party-too-large");
    assert.ok(playlists.checkParty(P.coop2, 1).ok, "Duos alone: an AI teammate");
    assert.ok(playlists.checkParty(P.coop2, 2).ok);
    const three = playlists.checkParty(P.coop2, 3);
    assert.strictEqual(three.error, "party-too-large");
    assert.ok(/up to 2/.test(three.message), three.message);
    assert.ok(playlists.checkParty(P.showdown, 1).ok);
    const sd = playlists.checkParty(P.showdown, 2);
    assert.strictEqual(sd.error, "party-too-large");
    assert.ok(/alone/.test(sd.message), sd.message);
    // Trios and Quads: up to their team size (AI teammates fill the rest).
    assert.ok(playlists.checkParty(P.coop3, 1).ok && playlists.checkParty(P.coop3, 3).ok);
    assert.strictEqual(playlists.checkParty(P.coop3, 4).error, "party-too-large");
    assert.ok(playlists.checkParty(P.coop4, 4).ok);
    assert.strictEqual(playlists.checkParty(P.coop4, 5).error, "party-too-large");
    // Disabled comes first: a solo player can't queue team Showdown or Ranked teams either.
    assert.strictEqual(playlists.checkParty(P.ranked_coop3, 1).error, "queue-unavailable");
    assert.strictEqual(playlists.checkParty(P.showdown_duo, 2).error, "mode-not-supported");
    assert.strictEqual(playlists.checkParty(P.ranked_coop2, 1).error, "queue-unavailable");
    assert.strictEqual(playlists.checkParty(P.ranked_showdown, 1).error, "mode-not-supported");
  });

  const srv = startServer();
  const sockets = [];
  try {
    await srv.ready();
    const A = "steam:76561190000000971", B = "steam:76561190000000972";
    const tokenA = await srv.login(A), tokenB = await srv.login(B);
    const a = await srv.connect(tokenA), b = await srv.connect(tokenB);
    sockets.push(a, b);
    const result = (token, body) => srv.request("POST", "/api/matchresult", body, token ? { Authorization: "Bearer " + token } : {});
    async function play(socket, queue) {
      const ready = next(socket, "match-ready");
      socket.emit("join-mm", { queueName: queue });
      return ready;
    }

    await test("GET /api/playlists lists every playlist with what is enabled", async () => {
      const r = await srv.request("GET", "/api/playlists");
      assert.strictEqual(r.status, 200);
      const byId = Object.fromEntries(r.json.playlists.map((p) => [p.id, p]));
      assert.strictEqual(byId.coop2.enabled, true);
      assert.strictEqual(byId.coop3.enabled, true);
      assert.strictEqual(byId.coop4.enabled, true);
      assert.strictEqual(byId.ranked_coop3.enabled, false);
      assert.strictEqual(byId.showdown_quad.reason, "mode-not-supported");
    });

    await test("a solo player is refused disabled playlists with the reason, and gets no match", async () => {
      let readies = 0;
      const count = () => readies++;
      a.on("match-ready", count);
      for (const q of ["ranked_ffa_jungle_coop3", "ranked_coop4", "showdown_duo", "showdown_trio", "showdown_quad", "ranked_showdown", "ranked_coop2"]) {
        const fail = next(a, "join-mm-fail");
        a.emit("join-mm", { queueName: q });
        const f = await fail;
        assert.strictEqual(f.reason, playlists.resolve(q).playlist.reason, q);
        assert.strictEqual(f.message, playlists.resolve(q).playlist.message);
      }
      await new Promise((r) => setTimeout(r, 700));
      a.off("match-ready", count);
      assert.strictEqual(readies, 0);
    });

    await test("an unknown queue name plays Solo", async () => {
      const lobby = next(a, "remaster-lobby");
      const ready = play(a, "some_new_mode");
      assert.strictEqual((await lobby).queue, "ffa");
      const m = await ready;
      // No map in the name: no vote, so the map is drawn (Jungle 0 or Prison 1).
      assert.ok(/^offline:[01]$/.test(m.gameServer), m.gameServer);
      assert.deepStrictEqual([m.playlist, m.netplay], ["ffa", false]);
      assert.strictEqual((await result(tokenA, { victory: false, kills: 0, damage: 0, timeAlive: 30 })).status, 200);
      assert.ok(!("some_new_mode" in (srv.profiles()[A].modes || {})), "no stats under a made-up mode");
    });

    await test("ranked: a result without a server-issued ticket is refused and changes nothing", async () => {
      const before = JSON.stringify(srv.profiles()[A].ranked || null);
      const r = await result(tokenA, { victory: true, placement: 1, kills: 15 });
      assert.strictEqual(r.status, 409);
      assert.strictEqual(JSON.stringify(srv.profiles()[A].ranked || null), before);
    });

    await test("ranked: scored as the ticket's match; a client-sent matchId is ignored", async () => {
      await play(a, "ranked_ffa_jungle");
      const pending = srv.profiles()[A].ranked.pending.id;
      const r = await result(tokenA, { victory: false, kills: 2, damage: 100, timeAlive: 300, placement: 4, cap: 16, matchId: "forged-match" });
      assert.strictEqual(r.status, 200);
      assert.ok(r.json.ranked && r.json.ranked.entry, "scored");
      assert.strictEqual(r.json.ranked.entry.matchId, pending, "the server's ranked match, not the client's id");
      assert.strictEqual(r.json.ranked.entry.placement, 4);
    });

    await test("ranked: the same result twice scores once", async () => {
      await play(a, "ranked_ffa_jungle");
      const body = { victory: false, kills: 1, damage: 50, timeAlive: 200, placement: 6, cap: 16 };
      const first = await result(tokenA, body);
      const matches = srv.profiles()[A].ranked.matches;
      const second = await result(tokenA, body);
      assert.strictEqual(first.status, 200);
      assert.strictEqual(second.status, 409, "the ticket is spent");
      assert.strictEqual(srv.profiles()[A].ranked.matches, matches);
    });

    await test("ranked: placements are clamped (malformed is last, first needs the win, never past the field)", async () => {
      const cases = [[0, "field"], [-5, "field"], ["abc", "field"], [1, 2], [999, "field"], [3, 3]];
      for (const [reported, want] of cases) {
        await play(a, "ranked_ffa_jungle");
        const r = await result(tokenA, { victory: false, kills: 0, damage: 10, timeAlive: 200, placement: reported, cap: 16 });
        assert.strictEqual(r.status, 200);
        const e = r.json.ranked.entry;
        assert.strictEqual(e.placement, want === "field" ? e.field : want, "placement " + reported + " -> " + e.placement);
      }
      await play(a, "ranked_ffa_jungle");
      const won = await result(tokenA, { victory: true, kills: 3, damage: 300, timeAlive: 600, placement: 9, cap: 16 });
      assert.strictEqual(won.json.ranked.entry.placement, 1, "a victory is first place");
      await play(a, "ranked_ffa_jungle");
      const kills = await result(tokenA, { victory: false, kills: 500, damage: 1e9, timeAlive: 1e9, placement: 5, cap: 16 });
      assert.ok(kills.json.ranked.entry.kills <= kills.json.ranked.entry.field - 1, "kills within the field");
    });

    await test("ranked: one player's result can't score another's ranked match", async () => {
      await play(a, "ranked_ffa_jungle");
      const pendingA = srv.profiles()[A].ranked.pending.id;
      const r = await result(tokenB, { victory: true, placement: 1 });
      assert.strictEqual(r.status, 409, "B has no ticket");
      assert.strictEqual(srv.profiles()[A].ranked.pending.id, pendingA, "A's match is still pending, untouched");
      assert.strictEqual((await result(tokenA, { victory: false, placement: 7, timeAlive: 100 })).status, 200);
    });

    await test("ranked: a Solo or Showdown match never scores a pending ranked match", async () => {
      await play(a, "ranked_ffa_jungle");
      await play(a, "showdown");
      const r = await result(tokenA, { victory: true, placement: 1 });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.json.ranked, null);
      assert.ok(srv.profiles()[A].ranked.pending, "the ranked match is still pending (abandoned at the next ranked queue)");
    });

    console.log("all %d playlist tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
})();
