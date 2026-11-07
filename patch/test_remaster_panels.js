// The Remaster menu panels (Friends.js with its RemasterOverlay, Leaderboard.js,
// MatchLobby.js, Showdown.js) on a small stand-in DOM (node, no game):
// - payloads a server older or newer than the menu could send (null, a list or
//   a field missing) neither throw inside the socket handler nor stop the
//   panel drawing;
// - the Showdown card works with a gamepad through the real RemasterOverlay
//   (its items were a list, which the overlay calls: every D-pad press threw);
// - a closed Friends panel doesn't keep its text field focused;
// - offline, opening Friends or the Leaderboard tries to connect once, and the
//   Leaderboard asks again when the menu signs in;
// - two refusals in a row arm one Leaderboard retry, not two;
// - a Leaderboard ask the server never answers says so after 10 s instead of
//   "Loading..." for good (an answer, or opening it again, clears it);
// - Friends: an action's buttons wait for the server's answer (a double click
//   asks once; no answer in 8 s frees them), and a result that arrives while
//   the panel is closed (the invite toast's Join) shows as a note.
// usage: node test_remaster_panels.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const JS = path.join(__dirname, "src", "Victory", "Content", "uiresources", "FrontEnd", "js");

function element(tag) {
  const e = {
    tagName: String(tag || "div").toUpperCase(), children: [], parentNode: null, className: "", id: "", style: {}, attrs: {},
    _text: "", listeners: {}, offsetWidth: 10, offsetHeight: 10, offsetTop: 0, scrollTop: 0, clientHeight: 100, value: "",
    get innerHTML() { return this._html || ""; },
    set innerHTML(v) { this._html = v; this.children = []; parseInto(this, String(v)); },
    get textContent() { return this._text + this.children.map((c) => c.textContent).join(""); },
    set textContent(v) { this._text = v == null ? "" : String(v); this.children = []; },
    get lastChild() { return this.children[this.children.length - 1] || null; },
    get firstChild() { return this.children[0] || null; },
    appendChild(c) {
      if (c.parentNode) c.parentNode.children.splice(c.parentNode.children.indexOf(c), 1);
      this.children.push(c); c.parentNode = this; return c;
    },
    insertBefore(c, ref) { this.children.splice(ref ? this.children.indexOf(ref) : this.children.length, 0, c); c.parentNode = this; return c; },
    removeChild(c) { this.children.splice(this.children.indexOf(c), 1); c.parentNode = null; return c; },
    contains(n) { for (; n; n = n.parentNode) if (n === this) return true; return false; },
    setAttribute(n, v) { this.attrs[n] = String(v); }, getAttribute(n) { return n in this.attrs ? this.attrs[n] : null; },
    addEventListener(n, fn) { (this.listeners[n] = this.listeners[n] || []).push(fn); },
    click() { (this.listeners.click || []).forEach((f) => f.call(this, { target: this, stopPropagation() {}, preventDefault() {} })); },
    dispatchEvent(ev) {
      (this.listeners[ev.type] || []).forEach((f) => f.call(this, { type: ev.type, target: this, stopPropagation() {}, preventDefault() {} }));
    },
    querySelector(sel) { return this.querySelectorAll(sel)[0] || null; },
    querySelectorAll(sel) {
      const out = [];
      const want = sel.split(",").map((s) => s.trim().split(/\s+/).pop());
      (function walk(n) { n.children.forEach((c) => { if (want.some((w) => match(c, w))) out.push(c); walk(c); }); })(this);
      return out;
    },
    focus() { doc.activeElement = this; }, blur() { if (doc.activeElement === this) doc.activeElement = doc.body; },
    scrollIntoView() {}, getBoundingClientRect() { return { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 }; }
  };
  e.classList = {
    add(c) { if (!this.contains(c)) e.className = (e.className + " " + c).trim(); },
    remove(c) { e.className = e.className.split(/\s+/).filter((x) => x !== c).join(" "); },
    contains(c) { return e.className.split(/\s+/).indexOf(c) >= 0; }
  };
  return e;
}

function parseInto(root, html) {
  const re = /<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
  let m, cur = root;
  while ((m = re.exec(html))) {
    if (m[4]) { const t = element("#text"); t._text = m[4]; cur.appendChild(t); continue; }
    if (m[1]) { cur = cur.parentNode || root; continue; }
    const e = element(m[2]);
    const am = /([a-z-]+)="([^"]*)"/g;
    let a;
    while ((a = am.exec(m[3]))) { if (a[1] === "class") e.className = a[2]; else if (a[1] === "id") e.id = a[2]; else e.attrs[a[1]] = a[2]; }
    cur.appendChild(e);
    if (!/^(input|img|br)$/i.test(m[2]) && !/\/$/.test(m[3])) cur = e;
  }
}

function match(e, w) {
  if (w[0] === ".") return w.slice(1).split(".").every((c) => (" " + e.className + " ").indexOf(" " + c + " ") >= 0);
  if (w[0] === "#") return e.id === w.slice(1);
  return e.tagName === w.toUpperCase();
}

let doc = null;

// A menu page with the stock globals the panels touch.
function page(extra) {
  const body = element("body"), head = element("head");
  const docListeners = {};
  doc = {
    body, head, activeElement: body,
    createElement: element,
    createTextNode: (t) => { const n = element("#text"); n._text = String(t); return n; },
    getElementById: (id) => { let f = null; (function walk(n) { n.children.forEach((c) => { if (!f && c.id === id) f = c; walk(c); }); })(body); return f; },
    querySelector: () => null, querySelectorAll: () => [],
    addEventListener(n, fn) { (docListeners[n] = docListeners[n] || []).push(fn); },
    createEvent: () => ({ initMouseEvent(type) { this.type = type; } })
  };
  const timers = [];
  const emitted = [];
  const ctx = Object.assign({
    console, document: doc, JSON, Math, Date,
    setTimeout: (fn, ms) => { timers.push({ fn, ms, live: true }); return timers.length; },
    clearTimeout: (id) => { if (timers[id - 1]) timers[id - 1].live = false; },
    setInterval: () => 0, clearInterval: () => {},
    FooterData: { bHasGamepad: false },
    PlayerProfileData: { Nickname: "me" },
    socketConnection: { emit: (name, msg) => emitted.push([name, msg]) },
    IsOnline: () => true
  }, extra || {});
  ctx.window = ctx;
  vm.createContext(ctx);
  ctx.load = (f) => vm.runInContext(fs.readFileSync(path.join(JS, f), "utf8"), ctx, { filename: f });
  ctx.keydown = (code) => (docListeners.keydown || []).forEach((f) => f({ keyCode: code, target: doc.activeElement, stopPropagation() {}, preventDefault() {} }));
  ctx.timers = timers;
  ctx.live = () => timers.filter((t) => t.live);
  ctx.emitted = emitted;
  return ctx;
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

test("Friends: malformed pushes don't throw, and the panel still draws what came", () => {
  const g = page();
  g.load("Friends.js");
  g.RemasterFriends.open();
  const tries = [
    ["remaster-player-card", undefined],
    ["remaster-player-card", null],
    ["remaster-party-invite", { partyId: "p1" }],
    ["remaster-party-invite", undefined],
    ["remaster-friend-result", null],
    ["remaster-friends", null],
    ["remaster-friends", { you: "me", friends: [{ username: "Ann", online: true }], party: { leader: "me" } }],
    ["remaster-friends", { you: "me", friends: [null, { username: "Bo" }], incoming: "x", invites: [null] }],
    ["remaster-player-card", { found: true, username: "Ann", wins: 1 }],
    ["remaster-player-card", { found: true, username: "Ann", wins: 1, ranked: { tier: "Hunter" }, showdown: null }]
  ];
  for (const [name, msg] of tries) {
    assert.doesNotThrow(() => g.RemasterFriends.on(name, msg), name + " " + JSON.stringify(msg));
  }
  const panel = g.document.getElementById("remaster-friends");
  assert.ok(/Bo/.test(panel.textContent), "the friend that came is listed: " + panel.textContent.slice(0, 200));
  const card = g.document.body.children.find((c) => /Ann/.test(c.textContent) && c !== panel);
  assert.ok(card && /Series won/.test(card.textContent), "the card drew its Showdown section with defaults");
  assert.strictEqual(g.document.getElementById("remaster-party-toast"), null, "an invite without a sender shows no toast");
});

test("Leaderboard: a board without its season or list draws, a null push changes nothing", () => {
  const g = page();
  g.load("Friends.js");
  g.load("Leaderboard.js");
  g.RemasterLeaderboard.open();
  for (const msg of [null, "x", { you: "me", boards: [{ id: "ranked", players: 0, top: [] }] },
    { season: { name: "S1" }, boards: [{ id: "ranked", players: 0 }] }, { season: { name: "S1" }, boards: [null, { id: "ranked", top: [null, { username: "Ann", value: 1200, position: 1 }] }] }]) {
    assert.doesNotThrow(() => g.RemasterLeaderboard.on(msg), JSON.stringify(msg));
  }
  const panel = g.document.getElementById("remaster-leaderboard");
  assert.ok(/Ann/.test(panel.textContent), panel.textContent.slice(0, 300));
  assert.ok(!/undefined/.test(panel.textContent), "nothing reads 'undefined': " + panel.textContent.slice(0, 300));
});

test("MatchLobby: no payload, no players, no player list: no exception, the pill still shows", () => {
  const g = page({ Matchmaking: { IsMatchmaking: true, LastQueue: "ffa" } });
  g.load("MatchLobby.js");
  for (const lobby of [null, undefined, "x", { id: 1, state: "starting", queue: "ffa", matchBots: 3, players: [] },
    { id: 1, state: "searching", queue: "ffa", maxPlayers: 16 }, { id: 2, state: "searching", queue: "ffa", players: [null, { name: "me" }] },
    { id: 3, state: "starting", queue: "ffa_jungle_coop2", matchBots: 5, players: null }]) {
    assert.doesNotThrow(() => g.RemasterLobby.show(lobby), JSON.stringify(lobby));
  }
  assert.ok(g.RemasterLobby.isShown(), "the last good lobby shows");
});

test("Showdown with a gamepad through the real RemasterOverlay: the D-pad moves, Select presses PLAY", () => {
  const stockPresses = [];
  const queued = [];
  const g = page({
    OnButtonPressed: (b) => stockPresses.push(b),
    PlayScreen: function () {}, hasClickButton: false,
    Matchmaking: { CanStartMatching: () => true, IsStartingMatchmaking: false },
    QueueMatchmaking: (q) => { queued.push(q); return { then(f) { f(true); } }; },
    ShowError: () => {}, PopScreenToMainMenu() {},
    localStorage: { getItem: () => null, setItem() {} },
    FooterData: { bHasGamepad: true }
  });
  g.PlayScreen.prototype.OnOptionElemSelected = function () {};
  g.$ = { extend: Object.assign, when: (v) => v };
  g.load("Friends.js");
  g.load("Showdown.js");
  assert.doesNotThrow(() => new g.PlayScreen().OnOptionElemSelected({ id: "showdown_play" }), "the picker opens");
  assert.ok(g.RemasterOverlay.isOpen(), "the picker is on the overlay stack");
  const card = g.document.getElementById("remaster-showdown");
  const focused = () => card.querySelector(".ro-focus");
  assert.strictEqual(focused() && focused().textContent, "PLAY", "the focus starts on PLAY");
  assert.doesNotThrow(() => g.OnButtonPressed(15), "D-pad right");
  assert.strictEqual(focused().textContent, "BACK");
  assert.doesNotThrow(() => g.OnButtonPressed(14), "D-pad left");
  assert.strictEqual(focused().textContent, "PLAY");
  assert.doesNotThrow(() => g.OnButtonPressed(0), "Select");
  assert.deepStrictEqual(stockPresses, [], "the overlay took the presses");
  assert.deepStrictEqual(queued.length, 1, "Select pressed PLAY");
  assert.ok(!g.RemasterOverlay.isOpen(), "the card closed");
});

test("Friends: closing the panel drops the text field's focus", () => {
  const g = page();
  g.load("Friends.js");
  g.RemasterFriends.open();
  const input = g.document.getElementById("remaster-friends").querySelector("input");
  assert.strictEqual(g.document.activeElement, input, "the add field takes the focus (keyboard)");
  g.RemasterFriends.close();
  assert.notStrictEqual(g.document.activeElement, input, "closed: the hidden field has no focus");
});

test("offline: opening Friends or the Leaderboard tries to connect once; the Leaderboard asks again on sign-in", () => {
  let connects = 0;
  const g = page({ socketConnection: null, IsOnline: () => false, ConnectWebsocketIfNeeded: () => { connects++; } });
  g.load("Friends.js");
  g.load("Leaderboard.js");
  g.RemasterFriends.open();
  assert.strictEqual(connects, 1, "Friends tried");
  g.RemasterLeaderboard.open();
  assert.strictEqual(connects, 2, "the Leaderboard tried");
  const sent = [];
  g.socketConnection = { emit: (name) => sent.push(name) };
  g.RemasterLeaderboard.connected();
  assert.deepStrictEqual(sent, ["remaster-leaderboard-get"], "signed in: the open panel asks");
  g.RemasterLeaderboard.close();
  g.RemasterLeaderboard.connected();
  assert.deepStrictEqual(sent, ["remaster-leaderboard-get"], "a closed panel doesn't");
  const on = page({ ConnectWebsocketIfNeeded: () => { connects++; } });
  on.load("Friends.js");
  on.load("Leaderboard.js");
  on.RemasterFriends.open();
  on.RemasterLeaderboard.open();
  assert.strictEqual(connects, 2, "online: no connect attempt");
});

test("Leaderboard: two refusals in a row arm one retry", () => {
  const g = page();
  g.load("Friends.js");
  g.load("Leaderboard.js");
  g.RemasterLeaderboard.open();
  g.RemasterLeaderboard.on({ error: "rate" });
  g.RemasterLeaderboard.on({ error: "rate" });
  assert.strictEqual(g.live().filter((t) => t.ms === 2500).length, 1, "one retry pending");
});

test("Leaderboard: an ask never answered says so after 10 s, not Loading... for good", () => {
  const g = page();
  g.load("Friends.js");
  g.load("Leaderboard.js");
  g.RemasterLeaderboard.open();
  const lb = g.document.getElementById("remaster-leaderboard");
  assert.ok(/Loading/.test(lb.textContent));
  const wait = g.live().filter((t) => t.ms === 10000);
  assert.strictEqual(wait.length, 1, "one answer timeout");
  wait[0].live = false;
  wait[0].fn();
  assert.ok(!/Loading/.test(lb.textContent) && /isn't answering/.test(lb.textContent), lb.textContent);
  g.RemasterLeaderboard.close();
  g.RemasterLeaderboard.open();                        // opening again asks again
  assert.ok(/Loading/.test(lb.textContent));
  g.RemasterLeaderboard.on({ season: { name: "S1" }, boards: [{ id: "ranked", players: 1, top: [{ username: "Ann", value: 1200, position: 1 }] }] });
  g.live().filter((t) => t.ms === 10000).forEach((t) => t.fn());
  assert.ok(/Ann/.test(lb.textContent) && !/isn't answering/.test(lb.textContent), "an answer stands");
});

test("Friends: a double click asks once; the answer (or 8 s without one) frees the buttons", () => {
  const g = page();
  g.load("Friends.js");
  g.RemasterFriends.open();
  g.RemasterFriends.on("remaster-friends", { you: "me", friends: [{ username: "Bo", status: { state: "menu" } }] });
  const fr = g.document.getElementById("remaster-friends");
  const invite = () => fr.querySelectorAll(".rf-btn").filter((b) => b.textContent === "Invite")[0];
  invite().click();
  invite().click();
  assert.strictEqual(g.emitted.filter((e) => e[0] === "party-invite").length, 1, "one invite for two clicks");
  assert.strictEqual(invite().style.opacity, "0.45", "the buttons look disabled while waiting");
  g.RemasterFriends.on("remaster-friend-result", { action: "party-invite", ok: true, username: "Bo" });
  assert.strictEqual(invite().style.opacity, "");
  invite().click();
  assert.strictEqual(g.emitted.filter((e) => e[0] === "party-invite").length, 2, "answered: the next click asks");
  const wait = g.live().filter((t) => t.ms === 8000);
  assert.ok(wait.length >= 1);
  wait.forEach((t) => { t.live = false; t.fn(); });   // no answer
  invite().click();
  assert.strictEqual(g.emitted.filter((e) => e[0] === "party-invite").length, 3, "no answer in 8 s: free again");
});

test("Friends: the invite toast's Join with the panel closed: the result shows as a note", () => {
  const g = page();
  g.load("Friends.js");
  g.RemasterFriends.on("remaster-party-invite", { partyId: "p1", from: { username: "Ann" } });
  const toast = g.document.getElementById("remaster-party-toast");
  toast.querySelectorAll(".rf-btn").filter((b) => b.textContent === "Join")[0].click();
  assert.deepStrictEqual(g.emitted.filter((e) => e[0] === "party-accept").map((e) => e[1].partyId), ["p1"]);
  g.RemasterFriends.on("remaster-friend-result", { action: "party-accept", error: "party-in-queue",
    message: "That party is searching for a match: accept when its search is over." });
  const note = g.document.getElementById("remaster-friend-note");
  assert.ok(note && note.className !== "hidden", "a note is shown");
  assert.ok(/searching for a match/.test(note.textContent), note.textContent);
  g.RemasterFriends.on("remaster-friend-result", { action: "party-accept", ok: true, partyId: "p1" });
  assert.ok(/joined the party/.test(note.textContent) && note.className === "ok");
  g.live().filter((t) => t.ms === 5000).forEach((t) => t.fn());
  assert.strictEqual(note.className, "hidden", "it goes after 5 s");
});

test("closing a panel takes its card rows off the page (AnimatedCards.js animates every row on it)", () => {
  const g = page();
  g.load("Friends.js");
  g.load("Leaderboard.js");
  g.RemasterLeaderboard.open();
  g.RemasterLeaderboard.on({ season: { name: "S1" }, boards: [{ id: "ranked", players: 1, top: [{ username: "Ann", value: 1200, position: 1 }],
    you: { username: "me", value: 1000, position: 0 } }] });
  const lb = g.document.getElementById("remaster-leaderboard");
  assert.ok(lb.querySelectorAll(".lb-row").length >= 1);
  g.RemasterLeaderboard.close();
  assert.strictEqual(lb.querySelectorAll(".lb-row").length, 0, "no rows left in the hidden panel");
  g.RemasterLeaderboard.open();
  assert.ok(lb.querySelectorAll(".lb-row").length >= 1, "drawn again on open");
  g.RemasterFriends.open();
  g.RemasterFriends.on("remaster-friends", { you: "me", friends: [{ username: "Bo", online: true }] });
  const fr = g.document.getElementById("remaster-friends");
  assert.ok(/Bo/.test(fr.textContent));
  g.RemasterFriends.close();
  assert.ok(!/Bo/.test(fr.querySelector(".rf-scroll").textContent), "the friends list left the hidden panel");
  g.RemasterFriends.open();
  assert.ok(/Bo/.test(fr.textContent), "drawn again on open");
});

console.log("all %d Remaster panel tests passed", passed);
