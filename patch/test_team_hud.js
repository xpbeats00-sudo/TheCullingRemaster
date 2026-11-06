// hud.js's Trios/Quads teammates against a stand-in page: the patched exe's
// "TMS|" messages (patch/showdown_rounds.c report_mates) never show as game
// messages; each teammate gets a panel like the game's, stacked above it; a
// teammate who is down has none; pause and your own death hide them; your
// death's result waits until your whole team is out (Duo's rule, for N).
// The functions are taken from hud.js itself (it needs the whole HUD page to
// load), so this tests the shipped code.
//
// usage: node test_team_hud.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "src", "Victory", "Content", "uiresources", "hud", "js", "hud.js");
const code = fs.readFileSync(SRC, "utf8");

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

function element(tag) {
  const e = {
    tagName: tag, children: [], className: "", id: "", style: {}, parentNode: null, innerHTML: "", textContent: "",
    offsetHeight: 0, _q: {},
    appendChild(c) { this.children.push(c); c.parentNode = this; return c; },
    querySelector(sel) { return this._q[sel] || (this._q[sel] = element("div")); },
    getBoundingClientRect() { return this._rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  };
  e.classList = {
    add(c) { if (!this.contains(c)) e.className = (e.className + " " + c).trim(); },
    remove(c) { e.className = e.className.split(" ").filter((x) => x && x != c).join(" "); },
    contains(c) { return e.className.split(" ").indexOf(c) >= 0; }
  };
  return e;
}

function page() {
  const body = element("body"), head = element("head");
  const byId = {};
  byId["party-member-container"] = element("div");
  byId["party-member-container"].className = "hud-center-left-container hidden";
  body.appendChild(byId["party-member-container"]);
  // The bottom left's armor and buff row and its armor container (hud.js finds
  // them inside #hud-bottom-left-container, never the spectator panel's copy).
  const row = element("div");
  row._rect = { left: 100, top: 900, right: 400, bottom: 940, width: 300, height: 40 };
  byId["armor-icon-container"] = row.querySelector(".armor-icon-container");
  byId["armor-icon-container"]._rect = { left: 100, top: 900, right: 300, bottom: 940, width: 200, height: 40 };
  const doc = {
    body, head,
    getElementById: (id) => (id === "armor-icon-container" ? null : byId[id] || null),
    querySelector: (sel) => (sel === "#hud-bottom-left-container .buff-armor" ? row : null),
    createElement: (tag) => element(tag)
  };
  const shown = [], results = [];
  const g = {
    document: doc,
    window: { innerWidth: 1000, innerHeight: 1000, addEventListener() {} },
    bHasPartyMember: false,
    pendingTeamResult: null,
    AddGameMessage: (m) => shown.push(m),
    PostPendingTeamResult: (sync) => { results.push(sync); g.pendingTeamResult = null; },
    Math, parseInt
  };
  const src = [take("var", "remasterPartyStyled"), take("function", "RemasterPlacePartyBar"),
    take("var", "remasterExtraMates"), take("function", "RemasterExtraPanel"), take("function", "RemasterShowExtraMates"),
    take("function", "RemasterTeamStatus"), take("var", "remasterTeam"), take("function", "RemasterTeammateAdded"),
    take("function", "RemasterTeammateDied"), take("function", "RemasterUpdateMateAlive")].join("\n");
  // The page's own ShowGameMessage handler: its TMS| branch, as written.
  const handler = /engine\.on\('ShowGameMessage', function\(message, duration\)\{([\s\S]*?)\n\}\);/.exec(code);
  assert.ok(handler, "the ShowGameMessage handler");
  const fn = new Function("g", "with (g) { " + src +
    "\ng.say = function (message, duration) {" + handler[1] + "\n};" +
    "\ng.api = { RemasterTeamStatus: RemasterTeamStatus, RemasterTeammateAdded: RemasterTeammateAdded," +
    " RemasterTeammateDied: RemasterTeammateDied, RemasterShowExtraMates: RemasterShowExtraMates," +
    " mates: function () { return remasterExtraMates; }, team: function () { return remasterTeam; } }; }");
  fn(g);
  const panels = () => g.api.mates().panels.map((p) => p.box);
  return { g, shown, results, panels, byId, body };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

test("TMS| messages never show as game messages; others do", () => {
  const p = page();
  p.g.say("TMS|1|75|50|1|Bot/2", 0);
  p.g.say("Grab your Airdrop.", 0);
  assert.deepStrictEqual(p.shown, ["Bot/2 is your Teammate!", "Grab your Airdrop."]);
});

test("Trios: one panel for the teammate beyond the game's, with health, stamina and name", () => {
  const p = page();
  p.g.say("TMS|1|75|50|1|Bot/2", 0);
  const [box] = p.panels();
  assert.strictEqual(p.panels().length, 1);
  assert.ok(!box.classList.contains("hidden") && box.classList.contains("remaster-party-extra"));
  assert.strictEqual(box.parentNode, p.body, "beside the game's panel");
  assert.strictEqual(box.querySelector(".party-member-name").textContent, "Bot/2");
  assert.strictEqual(box.querySelector(".party-health-bar").style.width, "75%");
  assert.strictEqual(box.querySelector(".party-stamina-bar").style.width, "50%");
});

test("Quads: three teammates stack above the game's panel, in order; a downed one leaves its place", () => {
  const p = page();
  p.g.bHasPartyMember = true;                       // the game's panel shows teammate 1
  p.byId["party-member-container"].offsetHeight = 40;
  p.g.say("TMS|2|90|80|1|Bot/2|60|20|1|Bot/3", 0);
  const [a, b] = p.panels();
  const base = parseInt(p.byId["party-member-container"].style.bottom, 10);
  assert.strictEqual(p.byId["party-member-container"].style.left, a.style.left);
  assert.strictEqual(a.style.left, b.style.left);
  assert.strictEqual(parseInt(a.style.bottom, 10), base + 44, "one place up");
  assert.strictEqual(parseInt(b.style.bottom, 10), base + 88, "two places up");
  p.g.say("TMS|2|0|0|0|Bot/2|60|20|1|Bot/3", 0);
  assert.ok(a.classList.contains("hidden"), "down: no panel");
  assert.strictEqual(parseInt(b.style.bottom, 10), base + 44, "the next one moves down");
  assert.deepStrictEqual(p.shown, ["Bot/2 is your Teammate!", "Bot/3 is your Teammate!"], "announced once each");
});

test("no panel teammate: the reported ones start at the lowest place", () => {
  const p = page();
  p.g.say("TMS|1|75|50|1|Bot/2", 0);
  assert.strictEqual(p.panels()[0].style.bottom, p.byId["party-member-container"].style.bottom);
});

test("pause and your own death hide the panels; unpause shows them again", () => {
  const p = page();
  p.g.say("TMS|1|75|50|1|Bot/2", 0);
  const [box] = p.panels();
  p.g.api.mates().paused = true;
  p.g.api.RemasterShowExtraMates();
  assert.ok(box.classList.contains("hidden"));
  p.g.api.mates().paused = false;
  p.g.api.RemasterShowExtraMates();
  assert.ok(!box.classList.contains("hidden"));
  p.g.api.mates().youDied = true;
  p.g.say("TMS|1|75|50|1|Bot/2", 0);
  assert.ok(box.classList.contains("hidden"));
});

test("your death's result waits for the whole team: posted when the last teammate is down", () => {
  const p = page();
  p.g.api.RemasterTeammateAdded();                  // the game's panel teammate
  p.g.say("TMS|2|75|50|1|Bot/2|75|50|1|Bot/3", 0);
  p.g.pendingTeamResult = { data: {} };             // you died
  p.g.api.RemasterTeammateDied();                   // the panel's teammate is down...
  assert.deepStrictEqual(p.results, [], "...two still stand");
  assert.strictEqual(p.g.api.team().bMateAlive, true);
  p.g.say("TMS|2|0|0|0|Bot/2|75|50|1|Bot/3", 0);
  assert.deepStrictEqual(p.results, []);
  p.g.say("TMS|2|0|0|0|Bot/2|0|0|0|Bot/3", 0);
  assert.deepStrictEqual(p.results, [false], "the team is out: posted as the death");
  assert.strictEqual(p.g.api.team().bMateAlive, false);
});

test("Duo (no TMS| ever): the teammate's death posts the waiting result, as before", () => {
  const p = page();
  p.g.api.RemasterTeammateAdded();
  assert.strictEqual(p.g.api.team().bInTeam, true);
  p.g.pendingTeamResult = { data: {} };
  p.g.api.RemasterTeammateDied();
  assert.deepStrictEqual(p.results, [false]);
  assert.strictEqual(p.panels().length, 0);
});

test("a malformed or empty report changes nothing it shouldn't", () => {
  const p = page();
  p.g.say("TMS|", 0);
  p.g.say("TMS|3|75", 0);
  p.g.say("TMS|0", 0);
  assert.strictEqual(p.panels().length, 0);
  assert.deepStrictEqual(p.shown, []);
  p.g.say("TMS|1|999|-5|1|X", 0);
  assert.strictEqual(p.panels()[0].querySelector(".party-health-bar").style.width, "100%");
  assert.strictEqual(p.panels()[0].querySelector(".party-stamina-bar").style.width, "0%");
});

console.log("all %d team HUD tests passed", passed);
