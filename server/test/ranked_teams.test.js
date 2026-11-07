// Ranked Duos, Trios and Quads (docs/RANKED_TEAMS.md).
// Part 1, the rules (server/ranked.js): a rating per mode beside Solo's, the
// team's placement among the teams (field = contestants / team size), the
// placement clamp, abandoned matches per mode, season rollover per mode and
// old profiles migrated cleanly. Part 2, a throwaway server: each mode queued
// alone (AI teammates) and as a party, scored only from the server's ranked
// ticket for that mode, refusals of mismatched or malformed results, the
// per-mode lobby rank, /api/ranked's modes and the per-mode leaderboards.
// Run: node test/ranked_teams.test.js
"use strict";

const assert = require("assert");
const R = require("../ranked");
const playlists = require("../playlists");
const { startServer, next } = require("./helpers");

let passed = 0, failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log("ok    " + name); } catch (e) {
    failed++;
    console.log("FAIL  " + name + "\n      " + (e.stack || e.message).split("\n").slice(0, 4).join("\n      "));
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// teams: a match's teams on Jungle (its 16 pods, as Prison's); of24: what 24
// contestants would make (the most ranked.teamField takes).
const TEAM = { duo: { size: 2, playlist: "ranked_coop2", start: "duo:", teams: 8, prison: 8, of24: 12 },
  trio: { size: 3, playlist: "ranked_coop3", start: "trio:", teams: 5, prison: 5, of24: 8 },
  quad: { size: 4, playlist: "ranked_coop4", start: "quad:", teams: 4, prison: 4, of24: 6 } };
const MODES = Object.keys(TEAM);

(async () => {
  // ------------------------------------------------------------ rules
  await test("modes: Solo plus Duos, Trios and Quads, each tied to its playlist and team size", () => {
    assert.deepStrictEqual(R.MODE_IDS, ["solo", "duo", "trio", "quad"]);
    for (const m of MODES) {
      assert.strictEqual(R.MODES[m].teamSize, TEAM[m].size);
      assert.strictEqual(R.modeForPlaylist(TEAM[m].playlist), m);
      assert.strictEqual(playlists.PLAYLISTS[TEAM[m].playlist].teamSize, TEAM[m].size);
    }
    assert.strictEqual(R.modeForPlaylist("ranked_ffa"), "solo");
    assert.strictEqual(R.modeForPlaylist("coop2"), null, "casual Duos isn't ranked");
    assert.strictEqual(R.modeId("nonsense"), "solo");
  });

  await test("field = number of teams: contestants / team size (16 on Jungle and Prison), never more than 24's", () => {
    for (const m of MODES) {
      assert.strictEqual(R.teamField(m, 16), TEAM[m].teams, m + " on Jungle");
      assert.strictEqual(R.teamField(m, 16), TEAM[m].prison, m + " on Prison");
      assert.strictEqual(R.teamField(m, 24), TEAM[m].of24, m + " of 24");
      assert.strictEqual(R.teamField(m, 999), TEAM[m].of24, m + ": never more than 24 contestants");
    }
  });

  await test("each mode has its own rating; Solo's is untouched by team matches", () => {
    const p = {};
    R.startMatch(p); R.finishMatch(p, { placement: 3 });
    const solo = JSON.stringify(p.ranked);
    for (const m of MODES) {
      const { match } = R.startMatch(p, Date.now(), null, { mode: m, field: TEAM[m].teams });
      assert.strictEqual(match.field, TEAM[m].teams);
      assert.strictEqual(match.mode, m);
      const { entry } = R.finishMatch(p, { matchId: match.id, placement: 1 }, Date.now(), null, m);
      assert.ok(entry.delta > 0, m + " win gains");
      assert.deepStrictEqual([entry.mode, entry.teamSize, entry.field], [m, TEAM[m].size, TEAM[m].teams]);
      assert.strictEqual(p.rankedTeams[m].matches, 1);
    }
    assert.strictEqual(JSON.stringify(p.ranked), solo, "Solo unchanged");
    assert.ok(p.rankedTeams.duo !== p.rankedTeams.trio && p.rankedTeams.trio !== p.rankedTeams.quad, "a record per mode");
  });

  await test("team placement: a win is 1st (even after your own death), a loss the team slice, clamped to the field", () => {
    // [mode, reported contestant position, victory, team placement]
    const cases = [["duo", 20, true, 1], ["duo", 1, false, 2], ["duo", 2, false, 2], ["duo", 3, false, 2], ["duo", 5, false, 3],
      ["duo", 24, false, 12], ["duo", 999, false, 12], ["duo", 0, false, 12], ["duo", -3, false, 12], ["duo", "abc", false, 12],
      ["duo", null, false, 12], ["duo", 2.5, false, 12], ["trio", 4, false, 2], ["trio", 24, false, 8], ["quad", 9, false, 3],
      ["quad", 24, false, 6], ["quad", 100, true, 1]];
    for (const [m, reported, victory, want] of cases) {
      assert.strictEqual(R.teamPlacement(m, reported, victory, TEAM[m].of24), want, m + " " + reported + " " + victory);
    }
    assert.strictEqual(R.teamPlacement("duo", 24, false, 8), 8, "Prison duos: 8 teams");
    // The patched exe's place at your death ("PLC|<alive + 1>", hud.js) on the 16-contestant
    // maps: the team slice it falls in, among 8 duos, 5 trios or 4 quads.
    for (const [m, alive, teams, want] of [["duo", 14, 8, 7], ["duo", 3, 8, 2], ["duo", 16, 8, 8], ["trio", 13, 5, 5],
      ["trio", 7, 5, 3], ["quad", 15, 4, 4], ["quad", 5, 4, 2]]) {
      assert.strictEqual(R.teamPlacement(m, alive, false, teams), want, m + " " + alive + " alive of " + teams + " teams");
    }
  });

  await test("a team match rejects a placement past its teams, and a result can't change its field", () => {
    const p = {};
    R.startMatch(p, Date.now(), null, { mode: "duo", field: 12 });
    const before = JSON.stringify(p.rankedTeams.duo);
    for (const placement of [0, 13, 24, 2.5, "x", null]) {
      assert.strictEqual(R.finishMatch(p, { placement }, Date.now(), null, "duo").error, "invalid-placement", String(placement));
    }
    assert.strictEqual(R.finishMatch(p, { matchId: "rkd-forged", placement: 1 }, Date.now(), null, "duo").error, "unknown-match");
    assert.strictEqual(JSON.stringify(p.rankedTeams.duo), before, "nothing changed");
    const { entry } = R.finishMatch(p, { placement: 12, field: 24 }, Date.now(), null, "duo");
    assert.strictEqual(entry.field, 12, "the team match's field stands");
    assert.ok(entry.delta < 0, "last of 12 teams loses");
  });

  await test("a mode's result can't finish another mode's match; an abandoned match is last of its own mode only", () => {
    const p = {};
    const duo = R.startMatch(p, Date.now(), null, { mode: "duo", field: 12 }).match;
    R.startMatch(p);
    assert.strictEqual(R.finishMatch(p, { matchId: duo.id, placement: 1 }).error, "unknown-match", "Solo can't take the Duos match");
    assert.strictEqual(R.finishMatch(p, { matchId: p.ranked.pending.id, placement: 1 }, Date.now(), null, "trio").error, "no-ranked-match");
    assert.ok(p.rankedTeams.duo.pending, "the Duos match still pending");
    const { abandoned } = R.startMatch(p, Date.now(), null, { mode: "duo", field: 12 });
    assert.ok(abandoned && abandoned.abandoned && abandoned.placement === 12 && abandoned.mode === "duo", JSON.stringify(abandoned));
    assert.ok(p.ranked.pending, "Solo's pending match untouched");
    assert.strictEqual(p.ranked.matches, 0);
  });

  await test("five placement matches per mode, then K 32; tiers and one-time rewards shared across modes", () => {
    const p = {}; const granted = [];
    const grant = (tier) => { granted.push(tier); return [tier]; };
    for (let i = 0; i < 5; i++) {
      R.startMatch(p, Date.now(), grant, { mode: "trio", field: 8 });
      assert.strictEqual(R.finishMatch(p, { placement: 1 }, Date.now(), grant, "trio").entry.k, 48);
    }
    R.startMatch(p, Date.now(), grant, { mode: "trio", field: 8 });
    assert.strictEqual(R.finishMatch(p, { placement: 1 }, Date.now(), grant, "trio").entry.k, 32);
    assert.strictEqual(R.summary(p, Date.now(), "trio").placement, null);
    assert.ok(R.summary(p, Date.now(), "duo").placement, "Duos still in placements");
    assert.ok(granted.length > 0 && new Set(granted).size === granted.length, "each tier's reward once: " + granted);
    for (let i = 0; i < 300; i++) { R.startMatch(p, Date.now(), grant, { mode: "trio", field: 8 }); R.finishMatch(p, { placement: 1 }, Date.now(), grant, "trio"); }
    assert.ok(p.rankedTeams.trio.rating <= R.CONFIG.maxRating, "the season cap holds per mode");
  });

  await test("simulation: in every team mode better team placements rate higher", () => {
    for (const m of MODES) {
      const run = (place) => { const p = {}; for (let i = 0; i < 60; i++) { R.startMatch(p, Date.now(), null, { mode: m, field: TEAM[m].teams }); R.finishMatch(p, { placement: place }, Date.now(), null, m); } return p.rankedTeams[m].rating; };
      const top = run(1), mid = run(Math.ceil(TEAM[m].teams / 2)), bottom = run(TEAM[m].teams);
      assert.ok(top > mid && mid > bottom, m + ": " + [top, mid, bottom]);
      assert.ok(bottom < R.CONFIG.startRating, m + ": always last never climbs");
    }
  });

  await test("season rollover per mode: each mode's record moves to the new season on its own", () => {
    const s1 = Date.parse(R.CONFIG.firstSeason.start) + 86400000;
    const s2 = Date.parse(R.CONFIG.firstSeason.end) + 86400000;
    const p = {};
    for (let i = 0; i < 6; i++) { R.startMatch(p, s1, null, { mode: "duo", field: 12 }); R.finishMatch(p, { placement: 1 }, s1, null, "duo"); }
    R.startMatch(p, s1); R.finishMatch(p, { placement: 2 }, s1);
    const duoS1 = p.rankedTeams.duo.rating, soloS1 = p.ranked.rating;
    assert.ok(duoS1 > 1000);
    // Season 2: only Duos is read.
    const duo = R.summary(p, s2, "duo");
    assert.strictEqual(duo.season.id, "S2");
    assert.strictEqual(duo.rating, R.CONFIG.startRating, "rating reset");
    assert.strictEqual(duo.matches, 0);
    assert.deepStrictEqual(p.rankedTeams.duo.past.map((x) => [x.season, x.rating, x.matches]), [["S1", duoS1, 6]], "last season kept");
    assert.ok(p.rankedTeams.duo.mmr > R.CONFIG.startRating && p.rankedTeams.duo.mmr < duoS1, "MMR keeps half its distance");
    assert.strictEqual(p.ranked.season, "S1", "Solo not yet rolled");
    assert.strictEqual(p.ranked.rating, soloS1);
    R.ensure(p, s2);
    assert.deepStrictEqual([p.ranked.season, p.ranked.rating, p.ranked.past[0].rating], ["S2", 1000, soloS1]);
    assert.ok(!p.rankedTeams.trio, "a mode never played gets no record");
  });

  await test("old profiles: Solo-only profiles migrate cleanly; malformed team records are repaired", () => {
    const p = { ranked: { season: R.CONFIG.season.id, rating: 1234, mmr: 1200, matches: 9, wins: 2, peakRating: 1250, peakTier: "Hunter",
      pending: null, processed: {}, history: [], tiersReached: { Scrapper: 1 } } };
    const solo = JSON.stringify(p.ranked);
    const all = R.summaries(p);
    assert.deepStrictEqual(Object.keys(all), ["solo", "duo", "trio", "quad"]);
    assert.strictEqual(all.solo.rating, 1234);
    assert.strictEqual(all.duo.rating, 1000);
    assert.ok(all.duo.placement && all.quad.placement, "team modes start in placements");
    assert.strictEqual(p.rankedTeams, undefined, "reading the team modes writes nothing");
    assert.strictEqual(JSON.stringify(p.ranked), solo, "Solo unchanged");
    const bad = { rankedTeams: { duo: "junk", trio: { rating: "x", history: 5, processed: [], matches: -1 } } };
    R.ensure(bad, Date.now(), "duo"); R.ensure(bad, Date.now(), "trio");
    assert.strictEqual(bad.rankedTeams.duo.rating, 1000);
    assert.deepStrictEqual([bad.rankedTeams.trio.rating, bad.rankedTeams.trio.matches, Array.isArray(bad.rankedTeams.trio.history)], [1000, 0, true]);
    const arr = { rankedTeams: [] };
    R.ensure(arr, Date.now(), "quad");
    assert.ok(!Array.isArray(arr.rankedTeams) && arr.rankedTeams.quad.rating === 1000);
  });

  // ------------------------------------------------------------ server
  const SEASON = R.CONFIG.season.id;
  const A = "steam:76561190000000981", B = "steam:76561190000000982", OLD = "steam:76561190000000983", PAST = "steam:76561190000000984";
  const oldSolo = { season: SEASON, rating: 1234, mmr: 1200, matches: 9, wins: 2, peakRating: 1250, peakTier: "Hunter",
    pending: null, processed: {}, history: [], tiersReached: { Scrapper: 1, Contender: 1, Blooded: 1, Hunter: 1 } };
  const baseProfile = (userID) => ({ userID, cullCredits: 100, premiumCurrency: 0, cardID: 0, economy: 1, owned: [], createdAt: 1,
    stats: { xp: 0, level: 1, kills: 0, wins: 0, gamesPlayed: 0, totalDamage: 0, minutesAlive: 0, funcEarned: 0, rank: 0 } });
  const seeded = {
    [OLD]: Object.assign(baseProfile(OLD), { ranked: JSON.parse(JSON.stringify(oldSolo)) }),
    [PAST]: Object.assign(baseProfile(PAST), { rankedTeams: { duo: { season: "S0", rating: 1300, mmr: 1300, matches: 20, wins: 5,
      peakRating: 1310, peakTier: "Hunter", pending: null, processed: {}, history: [], tiersReached: {} } } })
  };
  const srv = startServer({ profiles: seeded, vars: { CULLING_LOBBY_GATHER_MS: "250", CULLING_LOBBY_COUNTDOWN_MS: "100",
    CULLING_LEADERBOARD_MIN_AGE_MS: "0" } });
  const sockets = [];
  try {
    await srv.ready();
    const tokenA = await srv.login(A), tokenB = await srv.login(B);
    const a = await srv.connect(tokenA), b = await srv.connect(tokenB);
    sockets.push(a, b);
    const result = (token, body) => srv.request("POST", "/api/matchresult", body, token ? { Authorization: "Bearer " + token } : {});
    async function play(socket, queue) {
      const ready = next(socket, "match-ready");
      socket.emit("join-mm", { queueName: queue });
      return ready;
    }
    const rec = (userID, mode) => { const p = srv.profiles()[userID]; return mode === "solo" ? p.ranked : p.rankedTeams && p.rankedTeams[mode]; };

    for (const m of MODES) {
      await test("Ranked " + m + " alone: the casual " + m + " URL (AI teammates), a ranked ticket for " + m + ", the team's win is 1st of " + TEAM[m].teams, async () => {
        const soloBefore = JSON.stringify(rec(A, "solo") || null);
        const ready = await play(a, "ranked_ffa_jungle_coop" + TEAM[m].size);
        assert.strictEqual(ready.gameServer, TEAM[m].start + "0", "same match URL as casual");
        assert.deepStrictEqual([ready.playlist, ready.ranked, ready.netplay], [TEAM[m].playlist, m, false]);
        const pending = rec(A, m).pending;
        assert.ok(pending && pending.mode === m && pending.field === TEAM[m].teams, JSON.stringify(pending));
        // The HUD's team result: a victory posted after your own death (your teammates won).
        const r = await result(tokenA, { victory: true, placement: 17, kills: 2, damage: 150, timeAlive: 240, cap: 24, teamOutcome: "won" });
        assert.strictEqual(r.status, 200);
        const e = r.json.ranked.entry;
        assert.deepStrictEqual([e.matchId, e.mode, e.placement, e.field, e.teamOutcome], [pending.id, m, 1, TEAM[m].teams, "won"]);
        assert.ok(e.delta > 0 && r.json.ranked.summary.mode === m && r.json.ranked.summary.matches === 1);
        assert.strictEqual(JSON.stringify(rec(A, "solo") || null), soloBefore, "Solo rating untouched");
        assert.strictEqual(srv.profiles()[A].modes[TEAM[m].playlist].played, 1, "career stats under the ranked playlist");
      });
    }

    await test("team placements are clamped: malformed is last, first needs the win, never past the teams", async () => {
      // [mode, reported, team placement]
      const cases = [["duo", 0, 8], ["duo", "abc", 8], ["duo", 1, 2], ["duo", 999, 8], ["duo", 7, 4], ["trio", 24, 5], ["quad", 5, 2]];
      for (const [m, reported, want] of cases) {
        await play(a, "ranked_ffa_jungle_coop" + TEAM[m].size);
        const r = await result(tokenA, { victory: false, kills: 0, damage: 10, timeAlive: 200, placement: reported, cap: 24, teamOutcome: "out" });
        assert.strictEqual(r.status, 200);
        assert.strictEqual(r.json.ranked.entry.placement, want, m + " " + reported + " -> " + r.json.ranked.entry.placement);
        assert.strictEqual(r.json.ranked.entry.field, TEAM[m].teams);
      }
      await play(a, "ranked_ffa_jungle_coop2");
      const k = await result(tokenA, { victory: false, kills: 500, damage: 10, timeAlive: 100, placement: 3, teamOutcome: "bogus!" });
      assert.strictEqual(k.json.ranked.entry.kills, 14, "kills within the 14 other contestants of a Duos match");
      assert.ok(!("teamOutcome" in k.json.ranked.entry), "an unknown outcome isn't kept");
    });

    await test("Prison: scored among the 8 / 5 / 4 teams its 16 contestants make", async () => {
      for (const m of MODES) {
        const ready = await play(a, "ranked_prison_coop" + TEAM[m].size);
        assert.strictEqual(ready.gameServer, TEAM[m].start + "1");
        const r = await result(tokenA, { victory: false, placement: 16, timeAlive: 100 });
        assert.deepStrictEqual([r.json.ranked.entry.field, r.json.ranked.entry.placement], [TEAM[m].prison, TEAM[m].prison], m);
      }
    });

    await test("tickets: no ticket, no rating; the same result twice scores once; a forged matchId is ignored", async () => {
      const before = JSON.stringify(rec(A, "duo"));
      // No ticket: refused, or (within 10 minutes of A's last result) that
      // result's answer again; either way nothing is scored.
      const none = await result(tokenA, { victory: true, placement: 1 });
      assert.ok(none.status === 409 || none.status === 200, "refused: " + none.status);
      assert.strictEqual(JSON.stringify(rec(A, "duo")), before);
      await play(a, "ranked_ffa_jungle_coop2");
      const pending = rec(A, "duo").pending.id;
      const body = { victory: false, placement: 9, timeAlive: 100, matchId: "rkd-forged" };
      const first = await result(tokenA, body);
      assert.strictEqual(first.json.ranked.entry.matchId, pending);
      const matches = rec(A, "duo").matches;
      const again = await result(tokenA, body);
      assert.deepStrictEqual([again.status, again.json], [200, first.json], "the ticket is spent: the same answer again");
      assert.strictEqual(rec(A, "duo").matches, matches);
    });

    await test("mismatched results: another player's token, a Solo ticket and a casual Duos ticket never score a ranked Duos match", async () => {
      await play(a, "ranked_ffa_jungle_coop2");
      const pending = rec(A, "duo").pending.id;
      assert.strictEqual((await result(tokenB, { victory: true, placement: 1 })).status, 409, "B has no ticket");
      assert.strictEqual(rec(A, "duo").pending.id, pending);
      // A Ranked Solo match replaces the open ticket: its result scores Solo, not Duos.
      await play(a, "ranked_ffa_jungle");
      const solo = await result(tokenA, { victory: true, placement: 1, timeAlive: 300, cap: 16 });
      assert.strictEqual(solo.json.ranked.entry.mode, "solo");
      assert.strictEqual(rec(A, "duo").pending.id, pending, "the Duos match still pending");
      // Casual Duos: same URL, no ranked match.
      const casual = await play(a, "ffa_jungle_coop2");
      assert.deepStrictEqual([casual.gameServer, casual.ranked], ["duo:0", null]);
      const c = await result(tokenA, { victory: true, placement: 1, timeAlive: 300 });
      assert.strictEqual(c.json.ranked, null);
      assert.strictEqual(rec(A, "duo").pending.id, pending);
      // The next Ranked Duos match: the one left unfinished counts as last of 8 (16 contestants).
      const before = rec(A, "duo").matches;
      await play(a, "ranked_ffa_jungle_coop2");
      const h = rec(A, "duo");
      assert.strictEqual(h.matches, before + 1);
      assert.deepStrictEqual([h.history[0].matchId, h.history[0].abandoned, h.history[0].placement], [pending, true, 8]);
      await result(tokenA, { victory: false, placement: 5, timeAlive: 100 });
    });

    await test("/api/ranked: Solo at the top as before, every mode under modes, ?mode= picks one", async () => {
      const auth = { Authorization: "Bearer " + tokenA };
      const r = (await srv.request("GET", "/api/ranked", undefined, auth)).json;
      assert.strictEqual(r.mode, "solo");
      assert.ok(r.tier && r.season && Array.isArray(r.recent));
      assert.deepStrictEqual(Object.keys(r.modes), ["solo", "duo", "trio", "quad"]);
      assert.strictEqual(r.modes.duo.matches, rec(A, "duo").matches);
      assert.strictEqual(r.modes.trio.recent[0].mode, "trio");
      const d = (await srv.request("GET", "/api/ranked?mode=duo", undefined, auth)).json;
      assert.deepStrictEqual([d.mode, d.rating, d.teamSize, d.name], ["duo", rec(A, "duo").rating, 2, "Ranked Duos"]);
      assert.strictEqual((await srv.request("GET", "/api/ranked?mode=junk", undefined, auth)).json.mode, "solo");
    });

    await test("an old Solo-only profile keeps its Solo rating; its first Ranked Duos match starts Duos at 1000", async () => {
      const tokenOld = await srv.login(OLD);
      const o = await srv.connect(tokenOld);
      sockets.push(o);
      const lobby = next(o, "remaster-lobby");
      o.emit("join-mm", { queueName: "ranked_coop2" });
      const view = await lobby;
      const me = view.players.find((x) => x.rank !== undefined);
      assert.strictEqual(me.rank, null, "no Duos rank yet (the lobby shows the mode's rank, not Solo's Hunter)");
      await next(o, "match-ready");
      const r = await result(tokenOld, { victory: false, placement: 6, timeAlive: 100 });
      assert.strictEqual(r.json.ranked.entry.ratingBefore, 1000);
      const p = srv.profiles()[OLD];
      assert.deepStrictEqual([p.ranked.rating, p.ranked.matches, p.ranked.peakTier], [1234, 9, "Hunter"], "Solo as it was");
      assert.strictEqual(p.rankedTeams.duo.matches, 1);
      assert.ok(!p.rankedTeams.trio && !p.rankedTeams.quad, "only the mode played is stored");
      const again = next(o, "remaster-lobby");
      o.emit("join-mm", { queueName: "ranked_coop2" });
      assert.strictEqual((await again).players[0].rank, R.tierFor(p.rankedTeams.duo.rating).name, "now the Duos rank");
      await next(o, "match-ready");
      await result(tokenOld, { victory: false, placement: 6, timeAlive: 100 });
      const solo = next(o, "remaster-lobby");
      o.emit("join-mm", { queueName: "ffa_jungle" });
      assert.strictEqual((await solo).players[0].rank, "Hunter", "other lobbies show the Solo rank");
      await next(o, "match-ready");
      await result(tokenOld, { victory: false, placement: 6, timeAlive: 100 });
    });

    await test("a team record from a past season rolls over on its own when read", async () => {
      const tokenPast = await srv.login(PAST);
      const r = (await srv.request("GET", "/api/ranked?mode=duo", undefined, { Authorization: "Bearer " + tokenPast })).json;
      assert.deepStrictEqual([r.season.id, r.rating, r.matches], [SEASON, 1000, 0]);
      const ready = next(a, "match-ready");      // any match: the profile is saved with the rollover
      a.emit("join-mm", { queueName: "ffa" });
      await ready;
      await result(tokenA, { victory: false, timeAlive: 50 });
      const p = srv.profiles()[PAST];
      assert.ok(p.rankedTeams.duo.past && p.rankedTeams.duo.past[0].season === "S0" && p.rankedTeams.duo.past[0].rating === 1300);
      assert.ok(!p.ranked || p.ranked.matches === 0, "no Solo record invented");
    });

    // ------------------------------------------------------------ parties
    let ip = 40;
    async function player(name) {
      const r = await srv.request("POST", "/api/account/register",
        { username: name, email: name.replace(/\W/g, "").toLowerCase() + "@example.com", password: "long enough" },
        { "X-Forwarded-For": "198.51.100." + (ip++) });
      assert.strictEqual(r.status, 200, JSON.stringify(r.json));
      const token = await srv.login(r.json.userID);
      const socket = await srv.connect(token);
      sockets.push(socket);
      return { name, userID: r.json.userID, token, socket };
    }
    function waitFor(p, event, pred = () => true, ms = 4000) {
      const got = new Promise((resolve, reject) => {
        const t = setTimeout(() => { p.socket.off(event, on); reject(new Error(p.name + ": timed out waiting for " + event)); }, ms);
        function on(x) { if (pred(x)) { clearTimeout(t); p.socket.off(event, on); resolve(x); } }
        p.socket.on(event, on);
      });
      got.catch(() => {});
      return got;
    }
    function act(p, event, msg) {
      const r = waitFor(p, "remaster-friend-result", (x) => x.action === event);
      p.socket.emit(event, msg);
      return r;
    }
    async function join(leader, member) {
      await act(leader, "friend-request", { username: member.name });
      assert.ok((await act(member, "friend-accept", { username: leader.name })).ok);
      const inv = waitFor(member, "remaster-party-invite");
      assert.ok((await act(leader, "party-invite", { username: member.name })).ok);
      const got = await act(member, "party-accept", { partyId: (await inv).partyId });
      assert.ok(got.ok, JSON.stringify(got));
      return got.partyId;
    }
    const finish = async (p, body) => {
      const r = await result(p.token, Object.assign({ victory: false, placement: 9, timeAlive: 100 }, body));
      assert.strictEqual(r.status, 200, p.name + ": " + JSON.stringify(r.json));
      return r.json;
    };

    const L = await player("Rank Leader"), M = await player("Rank Mate");
    let partyId = null;
    await test("a party of two queues Ranked Duos as one: one lobby, one match id, each member rated in their own match", async () => {
      partyId = await join(L, M);
      const lobbies = [waitFor(L, "remaster-lobby"), waitFor(M, "remaster-lobby")];
      const rs = [waitFor(L, "match-ready"), waitFor(M, "match-ready")];
      const group = waitFor(M, "join-mm-group");
      L.socket.emit("join-mm", { queueName: "ranked_ffa_jungle_coop2" });
      assert.strictEqual((await group).playlist, "ranked_coop2");
      const [lv, mv] = await Promise.all(lobbies);
      assert.strictEqual(lv.id, mv.id, "one lobby");
      const [lr, mr] = await Promise.all(rs);
      assert.strictEqual(lr.matchId, mr.matchId, "one match");
      assert.deepStrictEqual([lr.partyId, mr.partyId], [partyId, partyId]);
      assert.ok([lr, mr].every((x) => x.gameServer === "duo:0" && x.playlist === "ranked_coop2" && x.ranked === "duo"));
      const pl = rec(L.userID, "duo").pending, pm = rec(M.userID, "duo").pending;
      assert.ok(pl && pm && pl.id !== pm.id, "each member's own ranked match");
      // The leader's team won; the member's team (their own local match) placed 3rd.
      const wl = await finish(L, { victory: true, placement: 1, teamOutcome: "won" });
      const wm = await finish(M, { victory: false, placement: 5, teamOutcome: "out" });
      assert.deepStrictEqual([wl.ranked.entry.placement, wm.ranked.entry.placement], [1, 3]);
      assert.ok(wl.ranked.entry.delta > 0);
    });

    await test("only the leader queues; a party is never larger than the team; Ranked Trios and Quads take a party of two", async () => {
      const f = waitFor(M, "join-mm-fail");
      M.socket.emit("join-mm", { queueName: "ranked_coop2" });
      assert.strictEqual((await f).reason, "party-leader-queues");
      for (const [q, gs] of [["ranked_coop3", "trio:"], ["ranked_coop4", "quad:"]]) {
        const rs = [waitFor(L, "match-ready"), waitFor(M, "match-ready")];
        L.socket.emit("join-mm", { queueName: q });
        const [lr, mr] = await Promise.all(rs);
        assert.strictEqual(lr.matchId, mr.matchId, q);
        assert.ok(lr.gameServer.indexOf(gs) === 0 && mr.gameServer.indexOf(gs) === 0, q + " " + lr.gameServer);
        await finish(L); await finish(M);
      }
      const N = await player("Rank Third");
      await act(L, "friend-request", { username: N.name });
      assert.ok((await act(N, "friend-accept", { username: L.name })).ok);
      const inv = waitFor(N, "remaster-party-invite");
      assert.ok((await act(L, "party-invite", { username: N.name })).ok);
      assert.ok((await act(N, "party-accept", { partyId: (await inv).partyId })).ok);
      const big = waitFor(L, "join-mm-fail");
      L.socket.emit("join-mm", { queueName: "ranked_coop2" });
      const fail = await big;
      assert.strictEqual(fail.reason, "party-too-large");
      assert.ok(/up to 2/.test(fail.message), fail.message);
      await sleep(400);
      assert.ok(!rec(L.userID, "duo").pending, "nothing started for a refused queue");
      const rs = [waitFor(L, "match-ready"), waitFor(M, "match-ready"), waitFor(N, "match-ready")];
      L.socket.emit("join-mm", { queueName: "ranked_coop3" });
      const got = await Promise.all(rs);
      assert.strictEqual(new Set(got.map((g) => g.matchId)).size, 1, "a party of three: one Ranked Trios match");
      for (const p of [L, M, N]) await finish(p);
    });

    await test("leaderboard: one board per ranked mode, from that mode's rating and tier", async () => {
      const view = next(L.socket, "remaster-leaderboard");
      L.socket.emit("remaster-leaderboard-get");
      const v = await view;
      const ids = v.boards.map((x) => x.id);
      for (const id of ["ranked", "ranked_duo", "ranked_trio", "ranked_quad"]) assert.ok(ids.includes(id), id);
      const duo = v.boards.find((x) => x.id === "ranked_duo");
      assert.strictEqual(duo.mode, "duo");
      const want = Math.min(R.CONFIG.maxRating, rec(L.userID, "duo").rating);
      assert.ok(duo.you && duo.you.position >= 1, "listed on Ranked Duos");
      assert.deepStrictEqual([duo.you.value, duo.you.rank, duo.you.matches], [want, R.tierFor(want).name, rec(L.userID, "duo").matches]);
      assert.ok(duo.top.some((e) => e.username === M.name), "the party member too");
      const quad = v.boards.find((x) => x.id === "ranked_quad");
      assert.strictEqual(quad.you.value, Math.min(R.CONFIG.maxRating, rec(L.userID, "quad").rating));
      const solo = v.boards.find((x) => x.id === "ranked");
      assert.ok(!solo.top.some((e) => e.username === L.name), "no Ranked Solo match: not on the Solo board");
    });
  } catch (e) {
    failed++;
    console.error("FAIL", e.stack || e.message);
  } finally {
    for (const s of sockets) s.close();
    srv.stop();
  }
  if (failed) { console.log(failed + " failing, " + passed + " passed"); process.exitCode = 1; }
  else console.log("all %d ranked team tests passed", passed);
})();
