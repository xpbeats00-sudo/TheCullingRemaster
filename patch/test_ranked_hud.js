// hud.js's team result for Ranked Duos, Trios and Quads (docs/RANKED_TEAMS.md)
// against stand-ins: the result the HUD posts to /api/matchresult carries what
// the server rates a ranked team match on. A member who died early while a
// teammate lives waits; the team's win is then posted as a victory (first
// place for every member) with their own stats; the team out, the wait over
// or leaving the match posts the death; and the body says which (teamOutcome).
// The ranked banner names the mode and the team's place.
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
    take("function", "ArmTeamResultTimer"), take("function", "PostPendingTeamResult"), take("function", "SendLocalMatchResultNow"),
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

test("leaving while your teammate fights posts at once (synchronously), as the death, left", () => {
  const h = hud();
  h.api.RemasterTeammateAdded();
  h.api.OnLocalMatchResult(death(9), false);
  h.api.RemasterBeforeLeavingMatch();
  assert.strictEqual(h.posted.length, 1);
  assert.deepStrictEqual([h.posted[0].sync, h.posted[0].body.victory, h.posted[0].body.teamOutcome], [true, false, "left"]);
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

console.log("all %d ranked HUD tests passed", passed);
