// hud.js's team result for Ranked Duos, Trios and Quads (docs/RANKED_TEAMS.md)
// against stand-ins: the result the HUD posts to /api/matchresult carries what
// the server rates a ranked team match on. A member who died early while a
// teammate lives waits; the team's win is then posted as a victory (first
// place for every member) with their own stats; the team out, the wait over
// or leaving the match posts the death; and the body says which (teamOutcome).
// The ranked banner names the mode and the team's place.
// Posting: a post the server doesn't answer is tried again (2, 5, 10, 20,
// 30, then every 60 s) for up to 5 minutes; a 200 (also the server's repeat
// of an answer it gave) is saved, a 4xx is not tried again; leaving the match
// sends what is still unanswered (never a synchronous request) and quits when
// the server answered, or after 2 s at most.
// The functions are taken from hud.js itself, so this tests the shipped code.
//
// usage: node test_ranked_hud.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "src", "Victory", "Content", "uiresources", "hud", "js", "hud.js");
const code = fs.readFileSync(SRC, "utf8").replace(/\r\n/g, "\n");

// A top-level function or var statement of hud.js, by name.
function take(kind, name) {
  const start = code.indexOf(kind == "function" ? "\nfunction " + name + "(" : "\nvar " + name + " =");
  assert.ok(start >= 0, kind + " " + name);
  if (kind == "var") return code.slice(start, code.indexOf(";", start) + 1);
  let i = code.indexOf("{", start), depth = 0;
  for (; i < code.length; i++) {
    if (code[i] == "{") depth++;
    else if (code[i] == "}" && --depth == 0) break;
  }
  return code.slice(start, i + 1);
}

function hud() {
  const posted = [], timers = [];
  const g = {
    console: { log() {} },
    matchData: { playerName: "Rank Leader" },
    deathData: {},
    window: {},
    remasterExtraMates: { alive: 0 },
    LOCAL_SERVER_URL: "http://127.0.0.1:8000/api",
    ShowResultStatus() {},
    $: { extend: Object.assign },
    // The async post: recorded (the server's reply isn't needed here).
    PostLocalMatchResult: (body) => posted.push({ sync: false, body: JSON.parse(JSON.stringify(body)) }),
    XMLHttpRequest: function () {
      this.open = () => {}; this.setRequestHeader = () => {};
      this.send = (text) => posted.push({ sync: true, body: JSON.parse(text) });
    },
    localResultPost: null, remasterLeaving: null,
    setTimeout: (fn) => { timers.push(fn); return timers.length; },
    clearTimeout: (id) => { if (id) timers[id - 1] = null; },
    Date, JSON, parseInt
  };
  const src = [take("var", "bLocalMatchResultSent"), take("var", "remasterTeam"), take("var", "pendingTeamResult"),
    take("var", "remasterTeamOutcome"), take("var", "TEAM_RESULT_WAIT_MS"), take("var", "TEAM_RESULT_MAX_WAIT_MS"),
    take("var", "REMASTER_RANK_WAIT_MS"), take("var", "remasterRankWaiting"), take("var", "remasterPlace"),
    take("function", "RemasterRank"), take("function", "RemasterPlaceArrived"), take("function", "RemasterRankArrived"),
    take("function", "LocalMatchResultBody"), take("function", "ReportLocalMatchResult"),
    take("function", "RemasterTeammateAdded"), take("function", "RemasterTeammateDied"), take("function", "RemasterUpdateMateAlive"),
    take("function", "ArmTeamResultTimer"), take("function", "PostPendingTeamResult"),
    take("function", "RemasterBeforeLeavingMatch"), take("function", "OnLocalMatchResult"),
    take("var", "REMASTER_RANKED_NAMES"), take("function", "RankedResultLabel")].join("\n");
  const fn = new Function("g", "with (g) { " + src +
    "\ng.api = { OnLocalMatchResult: OnLocalMatchResult, RemasterTeammateAdded: RemasterTeammateAdded," +
    " RemasterTeammateDied: RemasterTeammateDied, RemasterUpdateMateAlive: RemasterUpdateMateAlive," +
    " RemasterBeforeLeavingMatch: RemasterBeforeLeavingMatch, RankedResultLabel: RankedResultLabel," +
    " RemasterRankArrived: RemasterRankArrived, RemasterPlaceArrived: RemasterPlaceArrived," +
    " pending: function () { return pendingTeamResult; } }; }");
  fn(g);
  // Runs the timers armed so far (the 60 s wait).
  const tick = () => { const now = timers.slice(); timers.length = 0; now.forEach((f) => f && f()); };
  return { g, api: g.api, posted, tick };
}

// The game's death data for you (your own stats and position).
const death = (rank) => ({ TimeAlive: 200, NumKills: 2, DamageDone: 150, FUNC: 10, DistanceTraveled: 1000, Rank: rank });

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

test("you die early, your teammate wins: one post, a victory at first place, with your own stats", () => {
  const h = hud();
  h.api.RemasterTeammateAdded();
  h.api.OnLocalMatchResult(death(17), false);
  assert.strictEqual(h.posted.length, 0, "your death waits for the team");
  assert.ok(h.api.pending());
  h.api.OnLocalMatchResult(death(1), true);          // SetVictoryData: the team won
  assert.strictEqual(h.posted.length, 1);
  const b = h.posted[0].body;
  assert.deepStrictEqual([b.victory, b.placement, b.kills, b.damage, b.teamOutcome, b.nickname], [true, 1, 2, 150, "won", "Rank Leader"]);
  h.api.OnLocalMatchResult(death(1), true);
  assert.strictEqual(h.posted.length, 1, "never twice");
});

test("a win posts first place even though the game's victory data has no Rank", () => {
  const h = hud();
  const won = death(undefined);
  delete won.Rank;
  h.api.OnLocalMatchResult(won, true);
  assert.strictEqual(h.posted.length, 1);
  assert.deepStrictEqual([h.posted[0].body.victory, h.posted[0].body.placement], [true, 1]);
});

test("a death without a Rank waits for the exe's PLC| place and posts it", () => {
  const h = hud();
  const d = death(undefined);
  delete d.Rank;
  h.g.deathData.Rank = "F";                          // SetRewardRank: a grade, not a place
  h.api.OnLocalMatchResult(d, false);
  assert.strictEqual(h.posted.length, 0, "waits for the place");
  h.api.RemasterPlaceArrived(5);                     // "PLC|5"
  h.tick();
  assert.strictEqual(h.posted.length, 1);
  assert.deepStrictEqual([h.posted[0].body.victory, h.posted[0].body.placement], [false, 5]);
  h.tick();
  assert.strictEqual(h.posted.length, 1, "never twice");
});

test("a held team death posts the place you had (PLC| at your death)", () => {
  const h = hud();
  h.api.RemasterTeammateAdded();
  const d = death(undefined);
  delete d.Rank;
  h.api.RemasterPlaceArrived(11);                    // your death: 11 alive
  h.api.OnLocalMatchResult(d, false);
  assert.strictEqual(h.posted.length, 0, "your death waits for the team");
  h.api.RemasterTeammateDied();
  h.api.RemasterUpdateMateAlive();
  assert.strictEqual(h.posted.length, 1);
  assert.deepStrictEqual([h.posted[0].body.placement, h.posted[0].body.teamOutcome], [11, "out"]);
});

test("a death whose place never comes is posted after the wait (as before: 0)", () => {
  const h = hud();
  const d = death(undefined);
  delete d.Rank;
  h.api.OnLocalMatchResult(d, false);
  assert.strictEqual(h.posted.length, 0);
  h.tick();                                          // the 2 s wait
  assert.strictEqual(h.posted.length, 1);
  assert.strictEqual(h.posted[0].body.placement, 0);
});

test("you die early, your whole team goes down: posted as your death, team out", () => {
  const h = hud();
  h.api.RemasterTeammateAdded();
  h.g.remasterExtraMates.alive = 1;                  // Trios: a second teammate, reported by TMS|
  h.api.OnLocalMatchResult(death(14), false);
  h.api.RemasterTeammateDied();                      // the panel's teammate down
  assert.strictEqual(h.posted.length, 0, "one teammate still up");
  h.g.remasterExtraMates.alive = 0;
  h.api.RemasterUpdateMateAlive();                   // the last one down
  assert.strictEqual(h.posted.length, 1);
  assert.deepStrictEqual([h.posted[0].body.victory, h.posted[0].body.placement, h.posted[0].body.teamOutcome], [false, 14, "out"]);
});

test("leaving while your teammate fights posts at once (never synchronously), as the death, left", () => {
  const h = hud();
  h.api.RemasterTeammateAdded();
  h.api.OnLocalMatchResult(death(9), false);
  h.api.RemasterBeforeLeavingMatch();
  assert.strictEqual(h.posted.length, 1);
  assert.deepStrictEqual([h.posted[0].sync, h.posted[0].body.victory, h.posted[0].body.teamOutcome], [false, false, "left"]);
});

test("leaving while your death waits for its place: posted at once (place 0), not lost", () => {
  const h = hud();
  const d = death(undefined);
  delete d.Rank;
  h.api.OnLocalMatchResult(d, false);
  assert.strictEqual(h.posted.length, 0);
  h.api.RemasterBeforeLeavingMatch();
  assert.strictEqual(h.posted.length, 1);
});

test("the wait: re-armed while a teammate lives, posted after 20 minutes as waited", () => {
  const h = hud();
  h.api.RemasterTeammateAdded();
  h.api.OnLocalMatchResult(death(6), false);
  h.tick();
  assert.strictEqual(h.posted.length, 0, "teammate alive: waits again");
  h.api.pending().since = 0;                         // 20 minutes on
  h.tick();
  assert.strictEqual(h.posted.length, 1);
  assert.strictEqual(h.posted[0].body.teamOutcome, "waited");
});

test("you win with your team, or die last: posted at once; outside a team no teamOutcome", () => {
  const w = hud();
  w.api.RemasterTeammateAdded();
  w.api.OnLocalMatchResult(death(1), true);
  assert.deepStrictEqual([w.posted[0].body.victory, w.posted[0].body.teamOutcome], [true, "won"]);
  const last = hud();
  last.api.RemasterTeammateAdded();
  last.api.RemasterTeammateDied();
  last.api.OnLocalMatchResult(death(5), false);
  assert.deepStrictEqual([last.posted.length, last.posted[0].body.teamOutcome], [1, "out"]);
  const solo = hud();
  solo.api.OnLocalMatchResult(death(3), false);
  assert.strictEqual(solo.posted[0].body.teamOutcome, null, "Solo: no team");
  assert.strictEqual(solo.posted[0].body.placement, 3);
});

test("the ranked banner names the mode and the team's place", () => {
  const h = hud();
  assert.strictEqual(h.api.RankedResultLabel({ mode: "solo", teamSize: 1, placement: 3, field: 16 }), "RANKED SOLO • PLACE 3 OF 16");
  assert.strictEqual(h.api.RankedResultLabel({ mode: "duo", teamSize: 2, placement: 1, field: 12 }), "RANKED DUOS • TEAM PLACE 1 OF 12");
  assert.strictEqual(h.api.RankedResultLabel({ mode: "trio", teamSize: 3, placement: 4, field: 8 }), "RANKED TRIOS • TEAM PLACE 4 OF 8");
  assert.strictEqual(h.api.RankedResultLabel({ mode: "quad", teamSize: 4, placement: 6, field: 6 }), "RANKED QUADS • TEAM PLACE 6 OF 6");
  assert.strictEqual(h.api.RankedResultLabel({ placement: 2, field: 16 }), "RANKED SOLO • PLACE 2 OF 16", "an older server's entry");
});

// ---------------------------------------------------------------- posting (the real PostLocalMatchResult)
// A fake clock, $.ajax answered by the test (or not at all), and the quit.
function poster() {
  let now = 1000000, id = 0;
  let timers = [];
  const ajaxes = [], quits = [], status = [], shown = [];
  const g = {
    console: { log() {} },
    matchData: { playerName: "P" }, deathData: {}, window: {}, remasterExtraMates: { alive: 0 },
    LOCAL_SERVER_URL: "http://srv/api",
    ShowResultStatus: (t, st) => status.push([t, st]),
    NotifyReceivedStatsUpdate: (json) => shown.push(JSON.parse(json)),
    ShowRankedResult() {}, ShowShowdownResult: null,
    engine: { call: () => ({ then() {} }) },
    $: { extend: Object.assign, ajax: (o) => { if (o.url.indexOf("/matchresult") >= 0) ajaxes.push(o); } },
    XMLHttpRequest: function () { throw new Error("no synchronous request"); },
    setTimeout: (fn, ms) => { timers.push({ id: ++id, at: now + ms, fn }); return id; },
    clearTimeout: (t) => { timers = timers.filter((x) => x.id !== t); },
    Date: function () { return { getTime: () => now }; },
    JSON, parseInt, Math
  };
  const src = [take("var", "bLocalMatchResultSent"), take("var", "LOCAL_RESULT_RETRY_MS"), take("var", "LOCAL_RESULT_RETRY_FOR_MS"),
    take("var", "LOCAL_RESULT_QUIT_MS"), take("var", "localResultPost"), take("var", "remasterLeaving"),
    take("var", "remasterTeam"), take("var", "pendingTeamResult"), take("var", "remasterTeamOutcome"),
    take("var", "REMASTER_RANK_WAIT_MS"), take("var", "remasterRankWaiting"), take("var", "remasterPlace"),
    take("function", "RemasterRank"), take("function", "RemasterRankArrived"), take("function", "LocalMatchResultBody"),
    take("function", "ReportLocalMatchResult"), take("function", "PostLocalMatchResult"), take("function", "PostPendingTeamResult"),
    take("function", "RemasterBeforeLeavingMatch"), take("function", "RemasterLeaveMatch"), take("function", "RemasterResultAnswered"),
    take("function", "RemasterQuitNow"), take("function", "OnLocalMatchResult"), take("function", "RemasterTeammateAdded"),
    take("var", "TEAM_RESULT_WAIT_MS"), take("var", "TEAM_RESULT_MAX_WAIT_MS"), take("function", "ArmTeamResultTimer")].join("\n");
  new Function("g", "with (g) { " + src + "\ng.api = { report: ReportLocalMatchResult, leave: RemasterLeaveMatch," +
    " OnLocalMatchResult: OnLocalMatchResult, RemasterTeammateAdded: RemasterTeammateAdded," +
    " post: function () { return localResultPost; }, sent: function () { return bLocalMatchResultSent; } }; }")(g);
  const p = {
    g, api: g.api, ajaxes, quits, status, shown,
    now: () => now,
    // Runs the timers due within ms.
    advance(ms) {
      const end = now + ms;
      for (;;) {
        timers.sort((a, b) => a.at - b.at);
        if (!timers.length || timers[0].at > end) break;
        const t = timers.shift();
        now = t.at;
        t.fn();
      }
      now = end;
    },
    next() { timers.sort((a, b) => a.at - b.at); return timers.length ? timers[0].at - now : null; },
    fail(k, code) { ajaxes[k].error({ status: code || 0 }); },
    ok(k, body) { ajaxes[k].success(body); },
    quit: () => quits.push(now)
  };
  return p;
}
const reply = { startXP: 10, stats: { xp: 300 } };

test("no answer: tried again after 2, 5, 10, 20, 30, 60, 60... s for 5 minutes, then 'Couldn't reach the server'", () => {
  const p = poster();
  p.api.report(death(4), false);
  const waits = [];
  for (let k = 0; ; k++) {
    assert.strictEqual(p.ajaxes.length, k + 1);
    p.fail(k, k % 2 ? 502 : 0);
    const w = p.next();
    if (w === null) break;
    waits.push(w / 1000);
    p.advance(w);
  }
  assert.deepStrictEqual(waits, [2, 5, 10, 20, 30, 60, 60, 60, 60]);
  assert.ok(p.now() - 1000000 >= 5 * 60000 - 60000, "kept trying for about 5 minutes");
  assert.deepStrictEqual(p.status[p.status.length - 1], ["Couldn't reach the server", "bad"]);
  assert.strictEqual(p.api.sent(), false, "a later report may try again");
});

test("the server back within the 5 minutes: saved, the XP shown once", () => {
  const p = poster();
  p.api.report(death(4), false);
  p.fail(0);
  p.advance(2000);
  p.fail(1);
  p.advance(5000);
  p.ok(2, reply);
  assert.deepStrictEqual(p.status[p.status.length - 1], ["Result saved", "ok"]);
  assert.strictEqual(p.shown.length, 1);
  assert.strictEqual(p.next(), null, "nothing more scheduled");
  p.ok(0, reply);                                    // the first try's late answer
  assert.strictEqual(p.shown.length, 1, "shown once");
});

test("a 200 repeat of an answer the server gave (the first post's answer was lost): saved", () => {
  const p = poster();
  p.api.report(death(4), false);
  p.fail(0);                                         // timed out here, paid there
  p.advance(2000);
  p.ok(1, reply);                                    // server.js repeatedResult: the same 200 answer
  assert.deepStrictEqual(p.status[p.status.length - 1], ["Result saved", "ok"]);
  const q = poster();
  q.api.report(death(4), false);
  q.ok(0, {});                                       // a 200 without stats: saved, nothing to show
  assert.deepStrictEqual(q.status[q.status.length - 1], ["Result saved", "ok"]);
  assert.strictEqual(q.shown.length, 0);
});

test("a refusal (409): not tried again, 'wasn't saved'", () => {
  const p = poster();
  p.api.report(death(4), false);
  p.fail(0, 409);
  assert.strictEqual(p.next(), null);
  assert.deepStrictEqual(p.status[p.status.length - 1], ["This match's result wasn't saved", "bad"]);
});

test("quit with nothing to post: at once", () => {
  const p = poster();
  p.api.leave(p.quit);
  assert.deepStrictEqual(p.quits, [1000000]);
  assert.strictEqual(p.ajaxes.length, 0);
});

test("quit with the team's death still waiting: posted (async, 2 s timeout), quit when answered", () => {
  const p = poster();
  p.api.RemasterTeammateAdded();
  p.api.OnLocalMatchResult(death(7), false);
  assert.strictEqual(p.ajaxes.length, 0, "waits for the team");
  p.api.leave(p.quit);
  assert.strictEqual(p.ajaxes.length, 1);
  assert.strictEqual(p.ajaxes[0].timeout, 2000);
  assert.strictEqual(JSON.parse(p.ajaxes[0].data).teamOutcome, "left");
  assert.deepStrictEqual(p.quits, []);
  p.advance(300);
  p.ok(0, reply);
  assert.deepStrictEqual(p.quits, [1000300]);
  p.advance(5000);
  assert.strictEqual(p.quits.length, 1, "quit once");
});

test("quit while the server doesn't answer: quit after 2 s, no retry scheduled", () => {
  const p = poster();
  p.api.report(death(4), false);
  p.fail(0);                                         // a retry is scheduled in 2 s
  p.advance(500);
  p.api.leave(p.quit);
  assert.strictEqual(p.ajaxes.length, 2, "the waiting retry goes at once");
  assert.deepStrictEqual(p.quits, []);
  p.advance(2000);
  assert.deepStrictEqual(p.quits, [1002500]);
  p.fail(1);
  assert.strictEqual(p.next(), null, "no retry after leaving");
  assert.strictEqual(p.quits.length, 1);
});

test("quit pressed twice while waiting: the second quits at once", () => {
  const p = poster();
  p.api.report(death(4), false);
  p.api.leave(p.quit);
  assert.deepStrictEqual(p.quits, []);
  p.api.leave(p.quit);
  assert.strictEqual(p.quits.length, 1);
});

console.log("all %d ranked HUD tests passed", passed);
