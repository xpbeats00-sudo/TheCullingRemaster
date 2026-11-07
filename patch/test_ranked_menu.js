// RankedUI.js against stand-ins for the stock menu (node, no game): the Ranked
// screen's mode tabs (Solo, Duo, Trio, Quads) are all active; each shows that
// mode's tier, ELO, placements and recent matches from the server's
// /api/ranked (server/ranked.js summaries, the real module); the Play tile is
// retitled for the selected mode and queues it (ranked_coop2/3/4; Solo stays
// the stock Ranked.js path, "ranked_ffa"); a server from before the team modes
// shows them as Soon. Server text is escaped (attributes too) and numbers are
// numbers; no answer says "Ranked unavailable - retry" (retry asks again),
// and signed out it says the menu is offline instead of "Loading..." for good.
// usage: node test_ranked_menu.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const R = require(path.join(__dirname, "..", "server", "ranked"));

const SRC = fs.readFileSync(path.join(__dirname, "src", "Victory", "Content", "uiresources", "FrontEnd", "js", "RankedUI.js"), "utf8");

// The /api/ranked answer for a player with Solo and Duos matches this season.
function answer(old) {
  const p = {};
  R.startMatch(p); R.finishMatch(p, { placement: 4 });
  for (const place of [1, 3]) {
    R.startMatch(p, Date.now(), null, { mode: "duo", field: 12 });
    R.finishMatch(p, { placement: place }, Date.now(), null, "duo");
  }
  const modes = JSON.parse(JSON.stringify(R.summaries(p)));
  return old ? modes.solo : Object.assign({}, modes.solo, { modes });
}

function element(id) {
  const e = { id: id || "", innerHTML: "", textContent: "", children: [], listeners: {}, _q: {},
    appendChild(c) { this.children.push(c); if (c.id) byId[c.id] = c; return c; },
    addEventListener(name, fn) { this.listeners[name] = fn; },
    querySelector(sel) { return this._q[sel] || null; } };
  return e;
}
let byId = {};

function menu(fixture, opts = {}) {
  byId = {};
  byId["ranked-menu"] = element("ranked-menu");
  const tile = element();
  tile._q.h1 = element(); tile._q.h1.textContent = "RANKED SOLO";
  tile._q[".tiled-menu-rollover p"] = element();
  const store = opts.store || {};
  const queued = [], stock = [], errors = [];
  let pops = 0;
  function RankedScreen() {}
  RankedScreen.prototype.OnShow = function () {};
  RankedScreen.prototype.OnOptionElemSelected = function (elem) { stock.push(elem.dataset.queue); };
  let ready = null;
  function $(x) {
    if (typeof x == "function") { ready = x; return null; }
    return { length: 0, find: () => ({ length: 0 }) };   // no player card in this stand-in
  }
  // /api/ranked: answers the fixture, or (opts.fail) fails; opts.hold keeps the answer back.
  const asks = [];
  $.ajax = (o) => {
    asks.push(o);
    const r = { done(f) { if (!opts.fail && !opts.hold) f(JSON.parse(JSON.stringify(fixture))); r.ok = f; return r; },
      fail(f) { if (opts.fail && !opts.hold) f({ status: 0 }); r.bad = f; return r; } };
    return r;
  };
  $.when = (v) => ({ then: (f) => f(v) });
  const ctx = {
    console, $, RankedScreen, ClientwebData: { AuthToken: opts.signedOut ? null : "token" }, Matchmaking: { IsMatchmaking: false },
    QueueMatchmaking: (q) => { queued.push(q); return true; },
    PopScreen: () => { pops++; }, ShowError: (m) => errors.push(m),
    document: {
      getElementById: (id) => byId[id] || null,
      createElement: () => element(),
      querySelector: (sel) => (sel === "#ranked-menu-options li.ranked-ffa-bg" ? tile : null)
    },
    localStorage: { getItem: (k) => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } }
  };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(SRC, ctx);
  ready();                                          // $(refresh): signed in, /api/ranked answered
  const screen = new RankedScreen();
  screen.OnShow();
  const tabs = () => byId["ranked-modes"].innerHTML;
  const panel = () => byId["ranked-panel"].innerHTML;
  const click = (mode) => byId["ranked-modes"].listeners.click({ target: { getAttribute: (n) => (n === "data-mode" ? mode : null) } });
  const play = () => screen.OnOptionElemSelected({ dataset: { queue: "ffa" } });
  const retry = () => byId["ranked-panel"].listeners.click({ target: { getAttribute: (n) => (n === "data-retry" ? "1" : null) } });
  return { ctx, tile, tabs, panel, click, play, queued, stock, errors, store, asks, retry, opts, pops: () => pops };
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }
const fixture = answer(false);

test("every mode tab is active (no Soon); Solo is selected first, with Solo's tier and ELO", () => {
  const m = menu(fixture);
  const tabs = m.tabs();
  for (const label of ["Solo", "Duo", "Trio", "Quads"]) assert.ok(tabs.indexOf(">" + label) >= 0, label);
  assert.ok(tabs.indexOf("Soon") < 0, "nothing is Soon: " + tabs);
  assert.ok(/class="rm-tab active" data-mode="solo"/.test(tabs));
  assert.ok(m.panel().indexOf("RANKED SOLO") >= 0);
  assert.ok(m.panel().indexOf(fixture.modes.solo.rating + " ELO") >= 0);
  assert.strictEqual(m.tile._q.h1.textContent, "RANKED SOLO");
});

test("the Duo tab shows Duos' own tier, ELO, placements and recent team places", () => {
  const m = menu(fixture);
  m.click("duo");
  const d = fixture.modes.duo;
  assert.ok(/class="rm-tab active" data-mode="duo"/.test(m.tabs()));
  const html = m.panel();
  assert.ok(html.indexOf("RANKED DUO · ") >= 0, "the mode on the season line");
  assert.ok(html.indexOf(d.rating + " ELO") >= 0 && d.rating !== fixture.modes.solo.rating);
  assert.ok(html.indexOf("PLACEMENTS 2/5") >= 0, "Duos' own placements");
  assert.ok(html.indexOf("Team place") >= 0);
  assert.ok(html.indexOf("#1<small> of 12</small>") >= 0 && html.indexOf("#3<small> of 12</small>") >= 0, "recent team places");
  assert.ok(/team win counts for the whole team/.test(html));
  assert.strictEqual(m.tile._q.h1.textContent, "RANKED DUO");
  assert.ok(/AI teammate/.test(m.tile._q[".tiled-menu-rollover p"].textContent));
});

test("Trio and Quads never played: a fresh rating in placements, no recent matches", () => {
  const m = menu(fixture);
  m.click("quad");
  assert.ok(m.panel().indexOf("1000 ELO") >= 0 && m.panel().indexOf("PLACEMENTS 0/5") >= 0);
  assert.ok(m.panel().indexOf("No Ranked Quads matches yet this season.") >= 0);
  assert.strictEqual(m.tile._q.h1.textContent, "RANKED QUADS");
});

test("the Play tile queues the selected mode; Solo stays the stock ranked_ffa path", () => {
  for (const [mode, queue] of [["duo", "ranked_coop2"], ["trio", "ranked_coop3"], ["quad", "ranked_coop4"]]) {
    const m = menu(fixture);
    m.click(mode);
    m.play();
    assert.deepStrictEqual(m.queued, [queue], mode);
    assert.deepStrictEqual(m.stock, [], mode + ": not the stock handler");
    assert.strictEqual(m.pops(), 2, "back to the main menu, as Ranked Solo does");
  }
  const s = menu(fixture);
  s.play();
  assert.deepStrictEqual([s.queued, s.stock], [[], ["ffa"]], "Solo: the stock Ranked.js handler (ranked_ffa)");
  const busy = menu(fixture);
  busy.click("duo");
  busy.ctx.Matchmaking.IsMatchmaking = true;
  busy.play();
  assert.deepStrictEqual([busy.queued, busy.stock], [[], ["ffa"]], "already searching: the stock handler decides");
});

test("a double click on Play queues once (the queue answers later); the answer or a new visit allows the next", () => {
  const m = menu(fixture);
  const pending = [];
  m.ctx.QueueMatchmaking = (q) => { m.queued.push(q); return { then: (f) => pending.push(f) }; };   // like engine.call
  m.ctx.$.when = (v) => v;
  m.click("duo");
  m.play();
  m.play();
  assert.deepStrictEqual(m.queued, ["ranked_coop2"], "one queue for two clicks");
  pending.splice(0).forEach((f) => f(false));
  assert.strictEqual(m.errors.length, 1);
  m.play();
  assert.deepStrictEqual(m.queued, ["ranked_coop2", "ranked_coop2"], "after a failed queue, Play queues again");
  pending.splice(0).forEach((f) => f(true));
  assert.strictEqual(m.pops(), 2, "one success: two pops, not four");
  // An answer that never came: showing the screen again clears the guard.
  m.play();
  assert.strictEqual(m.queued.length, 3);
  new m.ctx.RankedScreen().OnShow();
  m.play();
  assert.strictEqual(m.queued.length, 4);
});

test("a malformed /api/ranked answer (no tier, lists missing) neither throws nor draws garbage", () => {
  for (const bad of [null, {}, { tier: null }, { modes: { solo: { rating: 1000 } } },
    { tier: { name: "Hunter" }, rating: 1000, modes: { solo: { tier: { name: "Hunter" }, rating: 1000 } } }]) {
    const m = menu(bad);
    m.click("solo");
    m.click("duo");
    assert.ok(typeof m.panel() == "string", JSON.stringify(bad));
  }
  const m = menu({ tier: { name: "Hunter" }, rating: 1000, modes: { solo: { tier: { name: "Hunter" }, rating: 1000 } } });
  assert.ok(m.panel().indexOf("1000 ELO") >= 0, "a summary without its lists still shows the rating");
});

test("a failed queue says so; the selected tab is remembered", () => {
  const store = {};
  const m = menu(fixture, { store });
  m.ctx.QueueMatchmaking = () => false;
  m.click("trio");
  m.play();
  assert.strictEqual(m.errors.length, 1);
  assert.strictEqual(store["remaster-ranked-mode"], "trio");
  const again = menu(fixture, { store });
  assert.ok(/class="rm-tab active" data-mode="trio"/.test(again.tabs()), "Trio again on the next visit");
  m.click("nonsense");
  assert.strictEqual(m.ctx.RemasterRanked.selected(), "trio", "an unknown tab changes nothing");
});

test("a server from before the team modes: Solo as before, the team tabs Soon", () => {
  const m = menu(answer(true));
  assert.ok(m.tabs().indexOf("Duo<small>Soon</small>") >= 0);
  assert.ok(m.tabs().indexOf("Solo<small>") < 0);
  assert.ok(m.panel().indexOf("RANKED SOLO") >= 0);
  m.click("duo");
  assert.ok(m.panel().indexOf("isn't on this server yet") >= 0);
});

test("server text is escaped in text and attributes (quotes too); numbers are numbers, never markup", () => {
  const evil = JSON.parse(JSON.stringify(fixture));
  const s = evil.modes.solo;
  s.tier.name = 'X" onerror="alert(1)';
  s.season.name = "<b>S</b>";
  s.rating = "<img src=x>";
  s.matches = "7<script>";
  s.tiers.push({ name: "Q'\"<i>", min: "<b>9</b>", reached: false });
  s.recent = [{ placement: "<u>1</u>", field: "16\"", delta: "<i>5</i>", ratingAfter: "1e3" }];
  const m = menu(evil);
  const html = m.panel();
  assert.ok(html.indexOf('onerror="') < 0, "a quote in a tier name can't close the src attribute: " + html.slice(0, 200));
  assert.ok(html.indexOf("&quot;") >= 0);
  for (const bad of ["<img src=x", "<script", "<u>", "<i>", "<b>9", "<b>S"]) assert.ok(html.indexOf(bad) < 0, bad);
  assert.ok(html.indexOf("0 ELO") >= 0, "a rating that isn't a number shows 0");
  assert.ok(html.indexOf("1000</span>") >= 0, "\"1e3\" is the number 1000");
});

test("/api/ranked doesn't answer: 'Ranked unavailable - retry'; retry asks again (not throttled) and shows it", () => {
  const m = menu(fixture, { fail: true });
  assert.ok(/Ranked unavailable . retry/.test(m.panel()), m.panel());
  assert.ok(m.panel().indexOf("Loading") < 0);
  const before = m.asks.length;
  m.opts.fail = false;
  m.retry();
  assert.strictEqual(m.asks.length, before + 1, "retry asks at once");
  assert.ok(m.panel().indexOf(fixture.modes.solo.rating + " ELO") >= 0);
  assert.ok(m.asks.every((o) => o.timeout > 0), "every ask has a timeout");
});

test("signed out (no token): the Ranked screen says offline, not Loading... for good", () => {
  const m = menu(fixture, { signedOut: true });
  assert.ok(/offline/.test(m.panel()), m.panel());
  assert.strictEqual(m.asks.length, 0);
  m.ctx.ClientwebData.AuthToken = "token";            // signed in: ClientWeb.js calls refresh()
  m.ctx.RemasterRanked.refresh();
  assert.ok(m.panel().indexOf(fixture.modes.solo.rating + " ELO") >= 0);
});

console.log("all %d ranked menu tests passed", passed);
