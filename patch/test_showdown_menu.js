// Showdown.js against stand-ins for the stock menu (node, no game): the
// SHOWDOWN tile opens the size picker (1V1-4V4, the last pick remembered),
// PLAY queues the size's playlist ("showdown", "showdown_duo", "_trio",
// "_quad"), BACK queues nothing; the end-of-series card reads the series'
// size (YOUR TEAM / RIVALS) and PLAY AGAIN queues the same size; the overlay
// stack gets every button. Other tiles go to the stock handler.
// usage: node test_showdown_menu.js
"use strict";
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "src", "Victory", "Content", "uiresources", "FrontEnd", "js", "Showdown.js");

function element(tag) {
  const e = {
    tagName: tag, children: [], className: "", id: "", style: {}, _text: "", listeners: {},
    appendChild(c) { if (c.parent) c.parent.children = c.parent.children.filter((x) => x !== c); this.children.push(c); c.parent = this; return c; },
    addEventListener(t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); },
    click() { for (const fn of this.listeners.click || []) fn({ stopPropagation() {}, preventDefault() {} }); },
    set textContent(v) { this._text = String(v); this.children = []; },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(" "); }
  };
  return e;
}

function menu(stored) {
  const body = element("body"), head = element("head");
  const queued = [], errors = [], overlays = [], stock = [];
  let popped = 0, queueResult = true;
  const storage = { v: stored === undefined ? {} : stored };
  function PlayScreen() {}
  PlayScreen.prototype.OnOptionElemSelected = function (elem) { stock.push(elem.id); };
  const g = {
    document: { body, head, createElement: (t) => element(t), createTextNode: (t) => ({ textContent: t, parent: null }) },
    window: {
      localStorage: { getItem: (k) => (k in storage.v ? storage.v[k] : null), setItem: (k, v) => { storage.v[k] = v; } }
    },
    PlayScreen,
    hasClickButton: false,
    Matchmaking: { CanStartMatching: () => true, IsStartingMatchmaking: false },
    QueueMatchmaking: (q) => { queued.push(q); return { then: (fn, bad) => (queueResult === "reject" ? bad() : fn(queueResult)) }; },
    PopScreenToMainMenu: () => popped++,
    ShowError: (m) => errors.push(m),
    RemasterOverlay: { open: (root, o) => overlays.push(o), close: () => {} }
  };
  g.window.RemasterOverlay = g.RemasterOverlay;
  new Function("g", "with (g) { " + fs.readFileSync(SRC, "utf8") + " }")(g);
  const root = () => body.children.find((c) => c.id === "remaster-showdown");
  const buttons = () => {
    const out = [];
    (function walk(e) { if (e.tagName === "button") out.push(e); (e.children || []).forEach(walk); })(root());
    return out;
  };
  const byText = (t) => buttons().find((b) => b.textContent === t);
  return { g, queued, errors, overlays, stock, storage, root, buttons, byText, popped: () => popped,
    fail: () => { queueResult = false; }, reject: () => { queueResult = "reject"; }, tile: (id) => new PlayScreen().OnOptionElemSelected({ id }) };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

test("other tiles go to the stock handler; SHOWDOWN opens the picker (nothing queued yet)", () => {
  const m = menu();
  m.tile("solo_play");
  assert.deepStrictEqual(m.stock, ["solo_play"]);
  m.tile("showdown_play");
  assert.deepStrictEqual(m.stock, ["solo_play"]);
  assert.deepStrictEqual(m.queued, []);
  assert.strictEqual(m.root().className, "");
  assert.deepStrictEqual(m.buttons().map((b) => b.textContent), ["1V1", "2V2", "3V3", "4V4", "PLAY", "BACK"]);
  assert.strictEqual(m.byText("1V1").className, "sd-on", "1v1 the first time");
  const o = m.overlays.pop();
  // RemasterOverlay (Friends.js) calls items() for the parts showing now: an
  // array there threw on every D-pad press and on Select (gamepad stuck).
  assert.strictEqual(typeof o.items, "function", "items is a function, as RemasterOverlay calls it");
  assert.strictEqual(o.items().length, 6);
  assert.strictEqual(o.items()[o.initial].textContent, "PLAY", "the focus starts on PLAY");
});

test("each size queues its playlist; the pick is remembered", () => {
  const want = { "1V1": "showdown", "2V2": "showdown_duo", "3V3": "showdown_trio", "4V4": "showdown_quad" };
  for (const [label, queue] of Object.entries(want)) {
    const m = menu();
    m.tile("showdown_play");
    m.byText(label).click();
    assert.strictEqual(m.byText(label).className, "sd-on");
    assert.ok(m.buttons().filter((b) => b.className === "sd-on").length === 1);
    assert.ok(/rival/.test(m.root().textContent), "the size's note");
    m.byText("PLAY").click();
    assert.deepStrictEqual(m.queued, [queue], label);
    assert.strictEqual(m.root().className, "hidden");
    assert.strictEqual(m.popped(), 1);
  }
  const m = menu({ "remaster.showdown.size": "3" });
  m.tile("showdown_play");
  assert.strictEqual(m.byText("3V3").className, "sd-on", "the last size picked");
  m.byText("4V4").click();
  assert.strictEqual(m.storage.v["remaster.showdown.size"], "4");
  const bad = menu({ "remaster.showdown.size": "9" });
  bad.tile("showdown_play");
  assert.strictEqual(bad.byText("1V1").className, "sd-on", "a stored size out of range is 1v1");
});

test("BACK queues nothing; a failed queue says so and lets the tile work again", () => {
  const m = menu();
  m.tile("showdown_play");
  m.byText("BACK").click();
  assert.deepStrictEqual(m.queued, []);
  assert.strictEqual(m.root().className, "hidden");
  m.fail();
  m.tile("showdown_play");
  m.byText("2V2").click();
  m.byText("PLAY").click();
  assert.deepStrictEqual(m.queued, ["showdown_duo"]);
  assert.ok(m.errors.length === 1 && m.g.hasClickButton === false);
});

test("no connection (the queue's promise rejected): says so, and PLAY works again", () => {
  const m = menu();
  m.reject();
  m.tile("showdown_play");
  m.byText("PLAY").click();
  assert.strictEqual(m.queued.length, 1);
  assert.ok(m.errors.length === 1 && /reach the server/.test(m.errors[0]), m.errors);
  assert.strictEqual(m.g.hasClickButton, false);
});

test("browser storage unavailable: the picker still works (1v1)", () => {
  const m = menu();
  m.g.window.localStorage = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
  m.tile("showdown_play");
  m.byText("3V3").click();
  m.byText("PLAY").click();
  assert.deepStrictEqual(m.queued, ["showdown_trio"]);
});

test("the end-of-series card: the series' size and team score; PLAY AGAIN the same size", () => {
  const m = menu();
  m.g.window.RemasterShowdown.onState({ phase: "over", series: { teamSize: 3, roundsToWin: 4, wins: 4, losses: 2,
    rounds: ["won", "lost", "won", "won", "lost", "won"], won: true, forfeit: false } });
  const text = m.root().textContent;
  assert.ok(/SHOWDOWN 3V3/.test(text) && /YOUR TEAM 4/.test(text) && /2 RIVALS/.test(text) && /Your team took 4/.test(text), text);
  const card = m.overlays.pop();
  assert.strictEqual(typeof card.items, "function", "the card's items, as RemasterOverlay calls them");
  assert.deepStrictEqual(card.items().map((b) => b.textContent), ["CLOSE", "PLAY AGAIN"]);
  m.byText("PLAY AGAIN").click();
  assert.deepStrictEqual(m.queued, ["showdown_trio"]);
  const s = menu();
  s.g.window.RemasterShowdown.onState({ phase: "over", series: { roundsToWin: 4, wins: 1, losses: 4, rounds: [], won: false } });
  assert.ok(/SHOWDOWN 1V1/.test(s.root().textContent) && /YOU 1/.test(s.root().textContent) && /4 RIVAL/.test(s.root().textContent));
  s.byText("PLAY AGAIN").click();
  assert.deepStrictEqual(s.queued, ["showdown"], "an older series (no size) is 1v1");
  s.g.window.RemasterShowdown.onState({ phase: "left", series: {} });
  assert.strictEqual(s.root().className, "hidden");
});

console.log("all %d Showdown menu tests passed", passed);
