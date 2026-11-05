// ShowdownHud.js against a stand-in page: the game's "SDR|" round messages
// (patch/showdown_rounds.c) drive the panel, the banner, the black fade and
// the round reports; a death that doesn't end the series shows no death
// screen; the one that ends it, and every other message, reach hud.js.
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

function page() {
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
  const posts = [], shown = [], deaths = [];
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
    OnStartPlaying: () => started++,
    $: { ajax: (o) => {
      if (o.type == "GET") o.success({ active: true, series: { round: 1, wins: 0, losses: 0, roundsToWin: 4 },
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
    g, posts, shown, deaths, doc, byId,
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
  assert.deepStrictEqual(p.posts, [{ round: 1, result: "W", wins: 1, losses: 0 }]);
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
  assert.deepStrictEqual(p.deaths, [false], "the 4th loss shows the death screen");
  assert.strictEqual(p.g.window.ShowdownHud.round(), 4, "the match result names round 4");
});

test("the series won: the last round message, then the stock VICTORY", () => {
  const p = page();
  p.say("SDR|S|7|3|3|3");
  p.say("SDR|O|7|4|3|W");
  p.flush();
  assert.ok(p.doc.getElementById("sd-banner").textContent.indexOf("SHOWDOWN VICTORY") >= 0);
  assert.deepStrictEqual(p.posts[p.posts.length - 1], { round: 7, result: "W", wins: 4, losses: 3 });
  p.g.SetDeathData({}, true);
  assert.deepStrictEqual(p.deaths, [true]);
});

console.log("all %d Showdown HUD tests passed", passed);
