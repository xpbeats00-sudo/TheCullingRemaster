// ShowdownHud.js against a stand-in page: the game's "SDR|" round messages
// (patch/showdown_rounds.c) drive the panel, the banner, the black fade and
// the round reports; a death that doesn't end the series shows no death
// screen; the one that ends it, and every other message, reach hud.js.
// Team Showdown (the messages' 7th field, N > 1): the team score, every
// death held until the series' end (shown and posted if the team lost; the
// victory, or the held stats as one, if it won), "is your Teammate!" once.
//
// usage: node test_showdown_hud.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "src", "Victory", "Content", "uiresources", "hud", "js", "ShowdownHud.js");

function element(tag) {
  const e = {
    tagName: tag, children: [], className: "", id: "", style: {}, attrs: {}, _text: "", innerHTML: "",
    classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
    appendChild(c) { this.children.push(c); c.parent = this; return c; },
    getAttribute(n) { return this.attrs[n]; },
    set textContent(v) { this._text = v; if (v === "") this.children = []; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(" "); }
  };
  return e;
}

function page(opts = {}) {
  const byId = {};
  const body = element("body");
  const head = element("head");
  const doc = {
    body, head,
    createElement: (t) => element(t),
    getElementById: (id) => byId[id] || find(body, id) || find(head, id) || null
  };
  function find(root, id) {
    if (root.id === id) return root;
    for (const c of root.children) { const f = find(c, id); if (f) return f; }
    return null;
  }
  for (const id of ["hud-bottom-left-container", "hud-center-container"]) {
    byId[id] = element("div");
    byId[id].classList.add("hidden");
  }
  const posts = [], shown = [], deaths = [], reports = [];
  let started = 0;
  const timers = [];
  const sandbox = {
    document: doc,
    window: {},
    REMASTER_API: "http://test/api",
    WeaponSlots: [],
    setTimeout: (fn, ms) => { timers.push(fn); return timers.length; },
    clearTimeout: () => {},
    AddGameMessage: (m) => shown.push(m),
    SetDeathData: (d, v) => deaths.push(v),
    // hud.js's globals the team rules touch.
    remasterTeam: { bInTeam: true, bMateAlive: true, bPanelMateAlive: true },
    remasterExtraMates: { alive: 1, youDied: true },
    RemasterShowExtraMates: () => reports.push("extra panels"),
    bLocalMatchResultSent: false,
    ReportLocalMatchResult: (d, v) => reports.push({ data: d, victory: v }),
    OnStartPlaying: () => started++,
    $: { extend: Object.assign, ajax: (o) => {
      if (o.type == "GET") o.success({ active: true, series: Object.assign({ round: 1, wins: 0, losses: 0, roundsToWin: 4 }, opts.series || {}),
        kits: [0, 1, 2, 3, 4, 5, 6].map((k) => ({ name: "Kit " + k, items: [{ name: "W" + k, category: "melee", tier: 3, description: "", icon: "x" }] })) });
      else posts.push(JSON.parse(o.data));
    } }
  };
  const code = fs.readFileSync(SRC, "utf8");
  const names = Object.keys(sandbox);
  // Globals the script reassigns (AddGameMessage, SetDeathData) live on `g`.
  const g = sandbox;
  const fn = new Function("g", "with (g) { " + code + " }");
  fn(g);
  return {
    g, posts, shown, deaths, reports, doc, byId,
    started: () => started,
    flush: () => { while (timers.length) timers.shift()(); },
    say: (m) => g.AddGameMessage(m, 0)
  };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

test("the round messages never show; other messages do", () => {
  const p = page();
  p.say("SDR|S|1|0|0|3");
  p.say("Drink Up & Fight!");
  assert.deepStrictEqual(p.shown, ["Drink Up & Fight!"]);
});

test("a round won: banner, black, the round to the server once; the next round fades back in with its kit", () => {
  const p = page();
  p.say("SDR|S|1|0|0|3");
  p.flush();
  p.say("SDR|E|1|1|0|W");
  p.say("SDR|E|1|1|0|W");
  p.flush();
  assert.deepStrictEqual(p.posts, [{ round: 1, result: "W", wins: 1, losses: 0, nickname: "" }]);
  assert.strictEqual(p.doc.getElementById("sd-black").className, "on");
  assert.ok(p.doc.getElementById("sd-banner").textContent.indexOf("ROUND 1 WON") >= 0);
  p.say("SDR|S|2|1|0|3");
  p.flush();
  assert.strictEqual(p.doc.getElementById("sd-black").className, "");
  const hud = p.doc.getElementById("sd-hud");
  assert.ok(hud.textContent.indexOf("ROUND 2") >= 0 && hud.textContent.indexOf("KIT 3") >= 0, hud.textContent);
  assert.ok(!p.byId["hud-center-container"].classList.contains("hidden"), "the HUD is back");
  assert.ok(p.started() >= 1);
});

test("a death mid-series: no death screen; the death that loses the series ends the match normally", () => {
  const p = page();
  p.say("SDR|S|1|0|0|0");
  p.g.SetDeathData({}, false);
  assert.deepStrictEqual(p.deaths, [], "mid-series death hidden");
  p.say("SDR|E|1|0|1|L");
  p.say("SDR|S|2|0|1|0");
  p.say("SDR|E|2|0|2|L");
  p.say("SDR|S|3|0|2|1");
  p.say("SDR|E|3|0|3|L");
  p.say("SDR|S|4|0|3|1");
  p.g.SetDeathData({}, false);
  assert.deepStrictEqual(p.deaths, [], "at 0-3 the death waits for the round's message (it may be a draw)");
  p.say("SDR|O|4|0|4|L");
  assert.deepStrictEqual(p.deaths, [false], "the 4th loss shows the death screen");
  assert.strictEqual(p.g.window.ShowdownHud.round(), 4, "the match result names round 4");
});

test("1v1 at 0-3: a draw (both down) doesn't end the series; the death screen waits for the loss", () => {
  // Draw: the death first, then the module's round message.
  const p = page();
  p.say("SDR|S|4|0|3|1");
  p.g.SetDeathData({}, false);
  p.say("SDR|E|4|0|3|D");
  p.flush();
  assert.deepStrictEqual(p.deaths, [], "a draw at 0-3: no death screen, no match result");
  p.say("SDR|S|5|0|3|2");
  p.flush();
  assert.deepStrictEqual(p.deaths, [], "round 5 plays on");
  // The round's message before the death (0-3 reported, then the death of round 3).
  const q = page();
  q.say("SDR|S|3|0|2|0");
  q.say("SDR|E|3|0|3|L");
  q.g.SetDeathData({}, false);
  q.say("SDR|S|4|0|3|1");
  q.flush();
  assert.deepStrictEqual(q.deaths, [], "round 3's death after its round message isn't the series' end");
  // The series lost, the O message before the death: through at once.
  const r = page();
  r.say("SDR|S|4|0|3|1");
  r.say("SDR|O|4|0|4|L");
  r.g.SetDeathData({}, false);
  assert.deepStrictEqual(r.deaths, [false]);
  // No message at all (an older module): the death goes through after the wait.
  const t = page();
  t.say("SDR|S|4|0|3|1");
  t.g.SetDeathData({}, false);
  assert.deepStrictEqual(t.deaths, []);
  t.flush();
  assert.deepStrictEqual(t.deaths, [false], "without a round message the death screen still comes");
});

test("the series won: the last round message, then the stock VICTORY", () => {
  const p = page();
  p.say("SDR|S|7|3|3|3");
  p.say("SDR|O|7|4|3|W");
  p.flush();
  assert.ok(p.doc.getElementById("sd-banner").textContent.indexOf("SHOWDOWN VICTORY") >= 0);
  assert.deepStrictEqual(p.posts[p.posts.length - 1], { round: 7, result: "W", wins: 4, losses: 3, nickname: "" });
  p.g.SetDeathData({}, true);
  assert.deepStrictEqual(p.deaths, [true]);
});

test("1v1 with the team size field (|1): as before", () => {
  const p = page();
  p.say("SDR|S|1|0|0|2|1");
  p.flush();
  const hud = p.doc.getElementById("sd-hud");
  assert.ok(hud.textContent.indexOf("SHOWDOWN 1V1") >= 0 && hud.textContent.indexOf("YOU 0 — 0 RIVAL") >= 0, hud.textContent);
  p.say("SDR|E|1|0|1|L|1");
  p.flush();
  assert.deepStrictEqual(p.posts, [{ round: 1, result: "L", wins: 0, losses: 1, nickname: "" }]);
  assert.deepStrictEqual(p.shown, []);
});

test("team Showdown: the team score and size on the panel and the banners", () => {
  for (const n of [2, 3, 4]) {
    const p = page();
    p.say("SDR|S|1|0|0|4|" + n);
    p.flush();
    const hud = p.doc.getElementById("sd-hud");
    assert.ok(hud.textContent.indexOf("SHOWDOWN " + n + "V" + n) >= 0, hud.textContent);
    assert.ok(hud.textContent.indexOf("YOUR TEAM 0 — 0 RIVALS") >= 0 && hud.textContent.indexOf("SAME KIT FOR EVERYONE") >= 0);
    p.say("SDR|E|1|1|0|W|" + n);
    p.flush();
    assert.ok(p.doc.getElementById("sd-banner").textContent.indexOf("YOUR TEAM 1 — 0 RIVALS") >= 0);
  }
  const q = page({ series: { teamSize: 3 } });           // before the game says: the server's size
  q.flush();
  assert.ok(q.doc.getElementById("sd-hud").textContent.indexOf("SHOWDOWN 3V3") >= 0);
});

test("team Showdown: your death waits for the series' end, even at match point; a new round clears it", () => {
  const p = page();
  p.say("SDR|S|1|0|0|0|2");
  p.g.SetDeathData({ NumKills: 1 }, false);
  assert.deepStrictEqual(p.deaths, [], "no death screen while your team fights on");
  p.flush();
  assert.ok(p.doc.getElementById("sd-banner").textContent.indexOf("YOU ARE DOWN") >= 0);
  p.say("SDR|E|1|1|0|W|2");                              // your teammate won the round
  p.say("SDR|S|2|1|0|0|2");
  p.flush();
  assert.ok(!p.g.remasterExtraMates.youDied && p.reports.indexOf("extra panels") >= 0, "the extra panels come back with you");
  for (const [r, l] of [[2, 1], [3, 2], [4, 3]]) { p.say("SDR|E|" + r + "|1|" + l + "|L|2"); p.say("SDR|S|" + (r + 1) + "|1|" + l + "|0|2"); }
  p.g.SetDeathData({ NumKills: 2 }, false);              // 3 losses: in 1v1 this one would end the match
  assert.deepStrictEqual(p.deaths, [], "held at match point too");
  p.say("SDR|O|5|1|4|L|2");                              // the team is down: the series is lost
  assert.deepStrictEqual(p.deaths, [false], "the held death now: death screen and result");
  assert.ok(!p.g.remasterTeam.bMateAlive && p.g.remasterExtraMates.alive === 0, "nothing left to wait for");
  assert.strictEqual(p.g.window.ShowdownHud.round(), 5);
});

test("team Showdown: the series won after your death is a victory (the game's, else your held stats)", () => {
  const p = page();
  p.say("SDR|S|7|3|3|0|4");
  p.g.SetDeathData({ NumKills: 3, Rank: 5 }, false);
  p.say("SDR|O|7|4|3|W|4");
  assert.deepStrictEqual(p.deaths, []);
  p.flush();                                             // no victory from the game within the wait
  const posted = p.reports.filter((r) => typeof r == "object");
  assert.strictEqual(posted.length, 1);
  assert.deepStrictEqual([posted[0].victory, posted[0].data.Rank, posted[0].data.NumKills], [true, 1, 3]);
  const q = page();
  q.say("SDR|S|7|3|3|0|4");
  q.g.SetDeathData({ NumKills: 3 }, false);
  q.say("SDR|O|7|4|3|W|4");
  q.g.SetDeathData({ NumKills: 3 }, true);               // the game's victory
  q.g.bLocalMatchResultSent = true;                      // ...which hud.js posted
  q.flush();
  assert.deepStrictEqual(q.deaths, [true]);
  assert.strictEqual(q.reports.filter((r) => typeof r == "object").length, 0, "posted once");
});

test("team Showdown: \"is your Teammate!\" once a match; 1v1 untouched", () => {
  const p = page();
  p.say("SDR|S|1|0|0|0|3");
  p.say("Bot A is your Teammate!");
  p.say("SDR|S|2|1|0|0|3");
  p.say("Bot A is your Teammate!");
  p.say("Bot B is your Teammate!");
  assert.deepStrictEqual(p.shown, ["Bot A is your Teammate!", "Bot B is your Teammate!"]);
  const q = page();
  q.say("SDR|S|1|0|0|0");
  q.say("X is your Teammate!");
  q.say("X is your Teammate!");
  assert.strictEqual(q.shown.length, 2);
});

console.log("all %d Showdown HUD tests passed", passed);
