// Showdown: you against one rival in the arena, first to 4 rounds.
// Part 1: the series rules (server/showdown.js): one round per match (older
// builds) and the in-match series (the patched exe plays every round in one
// match), with its own economy. Part 2: a throwaway server - the queue starts
// the series straight away (no lobby, out of any lobby) as "showdown:1v1", the
// HUD reports rounds, the match result pays the series once, and the menu
// shows the final score (or the forfeit of a series left unfinished). Team
// Showdown (2v2, 3v3, 4v4): a lobby of one team, "showdown:<N>", the same
// series and economy, recorded per team mode.
"use strict";

const assert = require("assert");
const { ShowdownSeries, seriesPayout, PAYOUT } = require("../showdown");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

const KIT = require("../data/showdown.json").kit;
const KITS = require("../data/showdown.json").kits;
const A = "steam:76561190000000801";

(async () => {
  // ------------------------------------------------------------ rules
  await test("first to 4 wins the series; at most 7 rounds", async () => {
    const sd = new ShowdownSeries();
    const u = "u1";
    let v;
    for (const won of [true, false, true, false, true, false, true]) {
      sd.startRound(u);
      v = sd.recordRound(u, won);
    }
    assert.strictEqual(v.wins, 4);
    assert.strictEqual(v.losses, 3);
    assert.strictEqual(v.round, 7);
    assert.ok(v.over && v.won);
    assert.strictEqual(sd.maxRounds, 7);
  });

  await test("four lost rounds is a defeat; a new queue starts a new series", async () => {
    const sd = new ShowdownSeries();
    for (let i = 0; i < 4; i++) { sd.startRound("u"); sd.recordRound("u", false); }
    assert.ok(sd.last("u").over && sd.last("u").won === false);
    const v = sd.startRound("u");
    assert.deepStrictEqual([v.round, v.wins, v.losses], [1, 0, 0]);
  });

  await test("a round left without a result is lost when the next starts", async () => {
    const sd = new ShowdownSeries();
    sd.startRound("u");
    const v = sd.startRound("u");
    assert.deepStrictEqual(v.rounds, ["left"]);
    assert.deepStrictEqual([v.round, v.losses], [2, 1]);
  });

  await test("a result outside a round changes nothing (no double count)", async () => {
    const sd = new ShowdownSeries();
    sd.startRound("u");
    sd.recordRound("u", true);
    assert.strictEqual(sd.recordRound("u", true), null);
    assert.strictEqual(sd.last("u").wins, 1);
  });

  await test("leaving ends the series as a forfeit", async () => {
    const sd = new ShowdownSeries();
    sd.startRound("u"); sd.recordRound("u", true);
    const v = sd.leave("u");
    assert.ok(v.over && v.forfeit && v.won === false);
  });

  await test("an idle series is dropped after 30 minutes", async () => {
    let t = 0;
    const sd = new ShowdownSeries({ now: () => t });
    sd.startRound("u"); sd.recordRound("u", true);
    t = 31 * 60 * 1000;
    assert.strictEqual(sd.current("u"), null);
  });


  // ------------------------------------------------------------ in-match series rules
  await test("in-match: rounds count in order, once; the 4th win ends the series", async () => {
    const sd = new ShowdownSeries();
    const { series } = sd.startSeries("u");
    assert.deepStrictEqual([series.round, series.inMatch, series.inRound], [1, true, true]);
    assert.ok(sd.recordInMatch("u", 1, "W"));
    assert.strictEqual(sd.recordInMatch("u", 1, "W"), null, "the same round again");
    assert.strictEqual(sd.recordInMatch("u", 3, "W"), null, "a round out of order");
    assert.strictEqual(sd.recordInMatch("u", 2, "X"), null, "not a result");
    let v;
    for (const [r, x] of [[2, "L"], [3, "W"], [4, "W"]]) v = sd.recordInMatch("u", r, x);
    assert.ok(!v.over && v.inRound, "3-1: the match goes on");
    assert.strictEqual(v.round, 5);
    v = sd.recordInMatch("u", 5, "W");
    assert.ok(v.over && v.won && !v.inRound);
    assert.deepStrictEqual(v.rounds, ["won", "lost", "won", "won", "won"]);
    assert.strictEqual(sd.recordInMatch("u", 6, "W"), null, "nothing after the end");
  });

  await test("in-match: a round sooner than minRoundMs after the start or the last round doesn't count", async () => {
    let t = 0;
    const sd = new ShowdownSeries({ now: () => t, minRoundMs: 20000 });
    sd.startSeries("u");
    t = 5000;
    assert.strictEqual(sd.recordInMatch("u", 1, "W"), null, "5 s after the series started");
    t = 21000;
    assert.ok(sd.recordInMatch("u", 1, "W"), "21 s in");
    t = 30000;
    assert.strictEqual(sd.recordInMatch("u", 2, "D"), null, "9 s after the round before");
    t = 41000;
    const v = sd.recordInMatch("u", 2, "L");
    assert.deepStrictEqual([v.wins, v.losses, v.round], [1, 1, 3]);
  });

  await test("in-match: a draw is a round with no point", async () => {
    const sd = new ShowdownSeries();
    sd.startSeries("u");
    const v = sd.recordInMatch("u", 1, "D");
    assert.deepStrictEqual([v.wins, v.losses, v.round, v.rounds[0]], [0, 0, 2, "draw"]);
  });

  await test("in-match: paid once, recorded once; a new queue forfeits an unfinished series", async () => {
    const sd = new ShowdownSeries();
    sd.startSeries("u");
    assert.strictEqual(sd.claimPayout("u"), null, "not over yet");
    for (let r = 1; r <= 4; r++) sd.recordInMatch("u", r, "L");
    assert.ok(sd.claimPayout("u"));
    assert.strictEqual(sd.claimPayout("u"), null);
    assert.ok(sd.markRecorded("u"));
    assert.ok(!sd.markRecorded("u"));
    sd.startSeries("u");
    sd.recordInMatch("u", 1, "W");
    const { series, left } = sd.startSeries("u");
    assert.ok(left.over && left.forfeit && left.won === false);
    assert.deepStrictEqual(left.rounds, ["won", "left"]);
    assert.deepStrictEqual([series.round, series.wins], [1, 0]);
  });

  await test("the series pays its own economy, not a full match per round", async () => {
    const sd = new ShowdownSeries();
    sd.startSeries("u");
    for (const [r, x] of [[1, "W"], [2, "L"], [3, "W"], [4, "W"], [5, "W"]]) sd.recordInMatch("u", r, x);
    const pay = seriesPayout(sd.claimPayout("u"), { kills: 99, damage: 99999, timeAlive: 99999, maxTime: 300 });
    assert.strictEqual(pay.xp, PAYOUT.xpBase + 4 * PAYOUT.xpPerRound + PAYOUT.xpWin);
    assert.strictEqual(pay.credits, PAYOUT.creditsBase + 4 * PAYOUT.creditsPerRound + PAYOUT.creditsWin);
    assert.strictEqual(pay.kills, 4, "at most a kill per round won");
    assert.strictEqual(pay.damage, 5 * PAYOUT.damagePerRound, "damage capped per round played");
    assert.strictEqual(pay.timeAlive, 300);
    assert.ok(pay.credits < 400 && pay.xp < 2500, "a whole series pays less than one full match");
  });

  await test("team Showdown: the same series and economy; kills bound by the team size per round won", async () => {
    const sd = new ShowdownSeries();
    const { series } = sd.startSeries("t", { mode: "showdown_trio", teamSize: 3 });
    assert.deepStrictEqual([series.mode, series.teamSize, series.format], ["showdown_trio", 3, "3v3"]);
    for (const [n, x] of [[1, "W"], [2, "L"], [3, "W"], [4, "W"], [5, "W"]]) sd.recordInMatch("t", n, x);
    const v = sd.claimPayout("t");
    assert.ok(v.over && v.won && v.teamSize === 3);
    const team = seriesPayout(v, { kills: 99, damage: 1e9, timeAlive: 50, maxTime: 100 });
    const solo = seriesPayout(Object.assign({}, v, { teamSize: 1 }), { kills: 99, damage: 1e9, timeAlive: 50, maxTime: 100 });
    assert.deepStrictEqual([team.xp, team.credits], [solo.xp, solo.credits], "the economy doesn't depend on the team size");
    assert.deepStrictEqual([team.kills, solo.kills], [12, 4], "3 rivals per round won (4), 1 in 1v1");
    assert.strictEqual(team.damage, solo.damage);
    const old = sd.view(Object.assign({}, sd.last("t"), { mode: undefined, teamSize: undefined }));
    assert.deepStrictEqual([old.mode, old.teamSize, old.format], ["showdown", 1, "1v1"], "a series saved before team Showdown is 1v1");
    assert.strictEqual(sd.startSeries("u", { teamSize: 9 }).series.teamSize, 1, "an impossible size is 1v1");
  });

  await test("the series survive a restart (showdown-series.json); finished ones are dropped", async () => {
    const fs = require("fs"), os = require("os"), path = require("path");
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "culling-sd-")), "showdown-series.json");
    const sd = new ShowdownSeries({ file });
    sd.startSeries("u");
    sd.recordInMatch("u", 1, "W");
    sd.startSeries("done");
    for (let r = 1; r <= 4; r++) sd.recordInMatch("done", r, "W");
    sd.claimPayout("done"); sd.markRecorded("done"); sd.markAnnounced("done");
    sd.flushSync();
    const again = new ShowdownSeries({ file });
    const v = again.recordInMatch("u", 2, "L");
    assert.deepStrictEqual([v.wins, v.losses, v.round], [1, 1, 3]);
    assert.strictEqual(again.last("done"), null);
  });

  // ------------------------------------------------------------ server
  const srv = startServer();
  const sockets = [];
  try {
    await srv.ready();
    const tokenA = await srv.login(A);
    const a = await srv.connect(tokenA);
    sockets.push(a);
    let lobbies = 0;
    a.on("remaster-lobby", () => lobbies++);

    async function queue() {
      const state = next(a, "remaster-showdown");
      const readyP = next(a, "match-ready");
      a.emit("join-mm", { queueName: "showdown" });
      const s = await state;
      const ready = await readyP;
      assert.strictEqual(ready.gameServer, "showdown:1v1");
      return s;
    }
    const roundPost = (round, result) => srv.request("POST", "/api/showdown/round", { round, result });
    const matchResult = (body) => srv.request("POST", "/api/matchresult", Object.assign({ damage: 120, timeAlive: 90, placement: 1, cap: 24 }, body));
    // Another player's ticket from this address is open by then: A's own, by token.
    const myResult = (body) => srv.request("POST", "/api/matchresult", Object.assign({ damage: 120, timeAlive: 90, placement: 1, cap: 24 }, body),
      { Authorization: "Bearer " + tokenA });

    await test("the showdown queue starts the series in one match, without a lobby, with the kits", async () => {
      const start = await queue();
      assert.strictEqual(lobbies, 0, "no lobby for Showdown");
      assert.strictEqual(start.phase, "round");
      assert.deepStrictEqual([start.series.round, start.series.inMatch], [1, true]);
      assert.strictEqual(start.kit.id, KIT.id);
      assert.strictEqual(start.kits.length, KITS.length);
      const hud = (await srv.request("GET", "/api/showdown")).json;
      assert.ok(hud.active, "the HUD sees the series");
      assert.strictEqual(hud.series.round, 1);
      assert.deepStrictEqual(hud.kits.map((k) => k.items[0].id), KITS.map((k) => k.items[0].id));
    });

    await test("the kits: the same armor and boost, a different weapon each; only armor auto-equips", async () => {
      assert.strictEqual(new Set(KITS.map((k) => k.items[0].id)).size, KITS.length);
      for (const k of KITS) {
        assert.strictEqual(k.items[0].category, "melee", k.id);
        for (const i of k.items) assert.strictEqual(i.autoEquip, i.category === "armor", i.id);
      }
    });

    await test("rounds come from the HUD as the game plays them; a repeat changes nothing", async () => {
      let r = await roundPost(1, "W");
      assert.ok(r.json.counted);
      r = await roundPost(1, "W");
      assert.ok(!r.json.counted, "the same round twice");
      for (const [n, x] of [[2, "L"], [3, "W"]]) r = await roundPost(n, x);
      assert.deepStrictEqual([r.json.series.wins, r.json.series.losses, r.json.series.round], [2, 1, 4]);
      const p = srv.profiles()[A];
      assert.strictEqual(p.stats.gamesPlayed || 0, 0, "rounds are not games");
    });

    await test("the 4th round win ends the series; the match result pays it once", async () => {
      const before = srv.profiles()[A];
      const r = await roundPost(4, "W");
      assert.ok(r.json.series.over === false);
      const last = await roundPost(5, "W");
      assert.ok(last.json.series.over && last.json.series.won);
      const res = await matchResult({ victory: true, kills: 9, damage: 99999, showdownRound: 5 });
      assert.strictEqual(res.status, 200);
      assert.strictEqual(res.json.showdown.phase, "over");
      assert.deepStrictEqual([res.json.showdown.series.wins, res.json.showdown.series.losses], [4, 1]);
      assert.strictEqual(res.json.xpEarned, PAYOUT.xpBase + 4 * PAYOUT.xpPerRound + PAYOUT.xpWin);
      assert.strictEqual(res.json.credits, PAYOUT.creditsBase + 4 * PAYOUT.creditsPerRound + PAYOUT.creditsWin);
      assert.strictEqual(res.json.stats.wins, (before.stats.wins || 0) + 1, "one win for the series");
      assert.strictEqual(res.json.stats.gamesPlayed, (before.stats.gamesPlayed || 0) + 1, "one game for the series");
      assert.strictEqual(res.json.stats.kills, (before.stats.kills || 0) + 4, "a kill per round won at most");
      assert.ok(res.json.stats.totalDamage - (before.stats.totalDamage || 0) <= 5 * PAYOUT.damagePerRound);
      assert.deepStrictEqual(srv.profiles()[A].showdown, { won: 1, lost: 0 });
      const again = await matchResult({ victory: true, showdownRound: 5 });
      assert.notStrictEqual(again.status, 200, "the ticket was used");
    });

    await test("the death that loses the series: the match result counts its round first", async () => {
      await queue();
      for (const [n, x] of [[1, "L"], [2, "L"], [3, "L"]]) await roundPost(n, x);
      const res = await matchResult({ victory: false, kills: 0, showdownRound: 4 });
      assert.strictEqual(res.json.showdown.phase, "over");
      assert.ok(res.json.showdown.series.over && res.json.showdown.series.won === false);
      assert.deepStrictEqual([res.json.showdown.series.wins, res.json.showdown.series.losses], [0, 4]);
      assert.strictEqual(res.json.xpEarned, PAYOUT.xpBase);
      const late = await roundPost(4, "L");
      assert.strictEqual(late.status, 409, "the HUD's report after the match result: no match");
      assert.deepStrictEqual(srv.profiles()[A].showdown, { won: 1, lost: 1 });
    });

    await test("a series queued right after the menu's login isn't touched by it", async () => {
      const c = await srv.connect(await srv.login(A));
      sockets.push(c);
      await queue();                                     // within the login's 1.5 s
      await new Promise((r) => setTimeout(r, 1800));
      const r = await roundPost(1, "W");
      assert.ok(r.json.counted, "still being played");
      c.close();
    });

    await test("back in the menu with the series unfinished: a forfeit, shown once", async () => {
      const b = await srv.connect(await srv.login(A));
      sockets.push(b);
      const s = await next(b, "remaster-showdown");
      assert.strictEqual(s.phase, "over");
      assert.ok(s.series.forfeit && s.series.won === false);
      assert.deepStrictEqual(srv.profiles()[A].showdown, { won: 1, lost: 2 });
      b.close();
      const c = await srv.connect(await srv.login(A));
      sockets.push(c);
      const again = await Promise.race([next(c, "remaster-showdown").then(() => "shown"), new Promise((r) => setTimeout(() => r("quiet"), 2200))]);
      assert.strictEqual(again, "quiet", "shown once; nothing starts by itself");
      c.close();
    });

    await test("Showdown takes the player out of a lobby still searching (no second match-ready)", async () => {
      const lobby = next(a, "remaster-lobby");
      a.emit("join-mm", { queueName: "ffa_jungle" });
      await lobby;
      let readies = 0;
      const count = () => readies++;
      a.on("match-ready", count);
      await queue();
      await new Promise((r) => setTimeout(r, 900));      // past the lobby's gather + countdown
      a.off("match-ready", count);
      assert.strictEqual(readies, 1, "only Showdown's match-ready");
      await roundPost(1, "W");
    });

    await test("another player's match from the same address doesn't hide the Showdown panel", async () => {
      await queue();
      const b = await srv.connect(await srv.login("steam:76561190000000802"));
      sockets.push(b);
      const lobby = next(b, "remaster-lobby");
      b.emit("join-mm", { queueName: "ffa_jungle" });
      await lobby;
      await next(b, "match-ready");
      const hud = (await srv.request("GET", "/api/showdown")).json;
      assert.ok(hud.active && hud.series.round === 1, "the one Showdown ticket from this address");
      assert.ok((await roundPost(1, "W")).json.counted);
      b.close();
    });

    await test("the HUD sees no Showdown in a normal match", async () => {
      const lobby = next(a, "remaster-lobby");
      a.emit("join-mm", { queueName: "ffa_jungle" });
      await lobby;
      const ready = await next(a, "match-ready");
      assert.strictEqual(ready.gameServer, "offline:0");
      const hud = await srv.request("GET", "/api/showdown");
      assert.strictEqual(hud.json.active, false);
      assert.strictEqual((await roundPost(1, "W")).status, 409, "no rounds outside Showdown");
    });

    await test("team Showdown: a lobby of one team (no map vote), showdown:<N>, the series per team, recorded per mode", async () => {
      for (const [q, size] of [["showdown_duo", 2], ["showdown_trio", 3], ["showdown_quad", 4]]) {
        const lobbyP = next(a, "remaster-lobby");
        const stateP = next(a, "remaster-showdown");
        const readyP = next(a, "match-ready");
        a.emit("join-mm", { queueName: q });
        const lobby = await lobbyP;
        assert.deepStrictEqual([lobby.queue, lobby.maxPlayers, lobby.maps, lobby.matchBots, lobby.matchBotsByMap],
          [q, size, null, 2 * size - 1, null], q + " lobby");
        const ready = await readyP;
        assert.deepStrictEqual([ready.gameServer, ready.playlist, ready.netplay], ["showdown:" + size, q, false]);
        const state = await stateP;
        assert.deepStrictEqual([state.phase, state.format, state.series.teamSize, state.series.mode, state.series.round],
          ["round", size + "v" + size, size, q, 1]);
        const hud = (await srv.request("GET", "/api/showdown")).json;
        assert.ok(hud.active && hud.series.teamSize === size && hud.format === size + "v" + size, q + " HUD");
        for (const [n, x] of [[1, "W"], [2, "W"], [3, "D"], [4, "W"]]) assert.ok((await roundPost(n, x)).json.counted);
        const last = await roundPost(5, "W");
        assert.ok(last.json.series.over && last.json.series.won);
        const res = await myResult({ victory: true, kills: 50, showdownRound: 5 });
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.json.xpEarned, PAYOUT.xpBase + 4 * PAYOUT.xpPerRound + PAYOUT.xpWin, "the 1v1 economy");
        assert.strictEqual(res.json.credits, PAYOUT.creditsBase + 4 * PAYOUT.creditsPerRound + PAYOUT.creditsWin);
        assert.strictEqual(srv.profiles()[A].showdownTeams[q].won, 1, q + " recorded under its mode");
      }
      const p = srv.profiles()[A];
      assert.strictEqual(p.showdown.won, 1, "team series never count on the 1v1 record");
      const card = (await srv.request("GET", "/api/showdown")).json;
      assert.strictEqual(card.active, false, "nothing open after the series paid");
    });

    await test("team Showdown lost: the death that loses the series counts, a forfeit is a loss for its mode", async () => {
      const stateP = next(a, "remaster-showdown");
      a.emit("join-mm", { queueName: "showdown_quad" });
      await next(a, "match-ready");
      await stateP;
      for (const [n, x] of [[1, "L"], [2, "L"], [3, "L"]]) await roundPost(n, x);
      const res = await myResult({ victory: false, kills: 0, showdownRound: 4 });
      assert.ok(res.json.showdown.series.over && res.json.showdown.series.won === false);
      assert.deepStrictEqual(srv.profiles()[A].showdownTeams.showdown_quad, { won: 1, lost: 1 });
      const s2 = next(a, "remaster-showdown");
      a.emit("join-mm", { queueName: "showdown_duo" });
      await next(a, "match-ready");
      await s2;
      const left = next(a, "remaster-showdown");
      a.emit("showdown-leave");
      assert.strictEqual((await left).phase, "left");
      assert.deepStrictEqual(srv.profiles()[A].showdownTeams.showdown_duo, { won: 1, lost: 1 });
      await myResult({ victory: false });
    });

    await test("Duo starts the pairs mode on the voted map (duo:<map>)", async () => {
      for (const [queue, want] of [["ffa_jungle_coop2", "duo:0"], ["ffa_prison_coop2", "duo:1"]]) {
        const lobby = next(a, "remaster-lobby");
        a.emit("join-mm", { queueName: queue });
        await lobby;
        const ready = await next(a, "match-ready");
        assert.strictEqual(ready.gameServer, want, queue);
      }
    });

    console.log("all %d showdown tests passed", passed);
  } catch (e) {
    console.error("FAIL", e.stack || e.message);
    process.exitCode = 1;
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
})();
