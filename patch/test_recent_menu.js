// The friends panel's RECENT tab (Friends.js; server/recentplayers.js,
// docs/RECENT_PLAYERS_SYSTEM.md) on a small stand-in DOM (node, no game):
// - opening RECENT asks the server for the list; each row shows how you met
//   (relation, mode, map, when), and the buttons the server allows: Add friend
//   / Accept / Requested, Invite / Invited, Join / Asked, and under More
//   Block (twice), Report (a reason) and Remove;
// - every button sends only the event and the username (or request id, or the
//   setting): the server decides;
// - join requests (the section, the pop-up, the badge and the tab count), the
//   invite / join setting, the blocked list and Unblock;
// - the answers' messages, and payloads a server older or newer than the menu
//   could send (null, a list or a field missing) neither throw nor stop the
//   panel drawing;
// - no player-facing text says bots or AI;
// - the gamepad's focus ring covers the tabs and the rows' buttons.
// usage: node test_recent_menu.js
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
  const emitted = [];
  const ctx = Object.assign({
    console, document: doc, JSON, Math, Date,
    setTimeout: () => 0, clearTimeout: () => {}, setInterval: () => 0, clearInterval: () => {},
    FooterData: { bHasGamepad: false },
    PlayerProfileData: { Nickname: "me" },
    socketConnection: { emit: (name, msg) => emitted.push([name, msg]) },
    IsOnline: () => true
  }, extra || {});
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(JS, "Friends.js"), "utf8"), ctx, { filename: "Friends.js" });
  ctx.emitted = emitted;
  ctx.panel = () => doc.getElementById("remaster-friends");
  ctx.sent = (name) => JSON.parse(JSON.stringify(emitted.filter((e) => e[0] === name).map((e) => e[1] === undefined ? null : e[1])));
  return ctx;
}

const now = Date.now();
const person = (username, extra) => Object.assign({ username, name: username, level: 7, cardID: 0, rank: null,
  status: { state: "menu", label: "In menu", lastSeen: null } }, extra);
// A RECENT payload as server.js recentView builds it.
function payload(over) {
  return Object.assign({
    you: "me",
    players: [
      person("Ann", { nameThen: "Ann", relation: "party", playlist: "coop2", mode: "Duo", map: "jungle", playedAt: now - 12 * 60000,
        lastInteraction: now, friend: "friend", invite: { can: false, reason: "already-in-party", sent: false },
        join: { can: false, reason: "already-in-party", sent: false }, party: { size: 2, max: 4, leads: true, yours: true } }),
      person("Bo", { nameThen: "Bo", relation: "lobby", playlist: "ffa", mode: "Solo", map: "prison", playedAt: now - 3 * 3600000,
        lastInteraction: now - 3 * 3600000, friend: "none", invite: { can: true, reason: null, sent: false },
        join: { can: true, reason: null, sent: false }, party: { size: 1, max: 4, leads: true, yours: false } }),
      person("Cy", { nameThen: "Cy", relation: "lobby", playlist: "ffa", mode: "Solo", map: "jungle-night", playedAt: now - 3 * 86400000,
        lastInteraction: now, friend: "requested", invite: { can: false, reason: "unavailable", sent: false },
        join: { can: false, reason: "unavailable", sent: false }, party: null,
        status: { state: "offline", label: "Offline", lastSeen: null } }),
      person("Dee", { nameThen: "Dee", relation: "lobby", playlist: "ffa", mode: "Solo", map: "jungle", playedAt: now - 60000,
        lastInteraction: now, friend: "asked-you", invite: { can: true, reason: null, sent: true },
        join: { can: true, reason: null, sent: true }, party: null })
    ],
    joinRequests: [{ requestId: "abc123def456", from: person("Eve") }],
    blocked: [{ username: "Zed" }],
    settings: { join: "recent" },
    privacyOptions: ["everyone", "recent", "friends", "nobody"],
    reportReasons: ["cheating", "abuse", "name", "griefing", "other"],
    limit: 50, maxParty: 4
  }, over || {});
}

// The row (and its buttons) for a recent player.
function rowOf(g, name) {
  return g.panel().querySelectorAll(".rf-row").find((r) => r.querySelector(".rf-name") && r.querySelector(".rf-name").textContent === name);
}
const buttons = (n) => n.querySelectorAll(".rf-btn").map((b) => b.textContent);
const press = (n, label) => {
  const b = n.querySelectorAll(".rf-btn").find((x) => x.textContent === label);
  assert.ok(b, "no " + label + " button in: " + buttons(n).join(", "));
  b.click();
};
const tags = (n) => n.querySelectorAll(".rf-tag").map((t) => t.textContent);
function openRecent(over) {
  const g = page();
  g.RemasterFriends.openRecent();
  g.RemasterFriends.on("remaster-recent", payload(over));
  return g;
}

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

test("opening RECENT asks for the list, then draws who you played with and how", () => {
  const g = page();
  g.RemasterFriends.open();
  assert.deepStrictEqual(g.sent("recent-get"), [], "the FRIENDS tab doesn't ask");
  const tab = g.panel().querySelectorAll(".rf-tab").find((t) => /^Recent/.test(t.textContent));
  tab.click();
  assert.strictEqual(g.sent("recent-get").length, 1, "RECENT asks once");
  assert.ok(/hidden/.test(g.panel().querySelector(".rf-add").className), "no add-a-friend box on RECENT");
  g.RemasterFriends.on("remaster-recent", payload());
  const text = g.panel().textContent;
  for (const n of ["Ann", "Bo", "Cy", "Dee"]) assert.ok(rowOf(g, n), n + " listed");
  assert.ok(/Party teammate · Duo · Jungle · 12 min ago/.test(text), text.slice(0, 400));
  assert.ok(/Same lobby · Solo · Prison · 3 h ago/.test(text));
  assert.ok(/Jungle at night · 3 days ago/.test(text));
  assert.ok(/4 · last 50/.test(text), "the count and the limit");
  assert.ok(/Offline/.test(rowOf(g, "Cy").textContent));
  assert.ok(/tall/.test(rowOf(g, "Ann").className));
});

test("each row offers what the server allows, and shows what is already sent", () => {
  const g = openRecent();
  assert.deepStrictEqual(buttons(rowOf(g, "Ann")), ["More"], "a friend in your party: nothing to send");
  assert.deepStrictEqual(tags(rowOf(g, "Ann")), ["Your party"]);
  assert.deepStrictEqual(buttons(rowOf(g, "Bo")), ["Add friend", "Invite", "Join", "More"]);
  assert.deepStrictEqual(buttons(rowOf(g, "Cy")), ["More"], "their setting allows neither");
  assert.deepStrictEqual(tags(rowOf(g, "Cy")), ["Requested"]);
  assert.deepStrictEqual(buttons(rowOf(g, "Dee")), ["Accept", "More"]);
  assert.deepStrictEqual(tags(rowOf(g, "Dee")), ["Invited", "Asked"]);
});

test("the buttons send the action and the username only", () => {
  const g = openRecent();
  press(rowOf(g, "Bo"), "Add friend");
  press(rowOf(g, "Bo"), "Invite");
  press(rowOf(g, "Bo"), "Join");
  press(rowOf(g, "Dee"), "Accept");
  assert.deepStrictEqual(g.sent("friend-request"), [{ username: "Bo" }]);
  assert.deepStrictEqual(g.sent("recent-invite"), [{ username: "Bo" }]);
  assert.deepStrictEqual(g.sent("recent-join-request"), [{ username: "Bo" }]);
  assert.deepStrictEqual(g.sent("friend-accept"), [{ username: "Dee" }]);
});

test("More: why Invite / Join are off, Block takes two clicks, Report asks a reason, Remove", () => {
  const g = openRecent();
  press(rowOf(g, "Cy"), "More");
  let more = g.panel().querySelector(".rp-more");
  assert.ok(/Invite: Their settings don't allow it/.test(more.textContent), more.textContent);
  assert.deepStrictEqual(buttons(more), ["Block", "Report", "Remove from list"]);
  press(more, "Block");
  assert.deepStrictEqual(g.sent("recent-block"), [], "one click only arms it");
  more = g.panel().querySelector(".rp-more");
  press(more, "Sure? Block");
  assert.deepStrictEqual(g.sent("recent-block"), [{ username: "Cy" }]);
  press(rowOf(g, "Bo"), "More");
  press(g.panel().querySelector(".rp-more"), "Report");
  more = g.panel().querySelector(".rp-more");
  assert.deepStrictEqual(buttons(more), ["Cheating", "Abusive", "Bad name", "Griefing", "Other", "Cancel"]);
  press(more, "Cheating");
  assert.deepStrictEqual(g.sent("recent-report"), [{ username: "Bo", reason: "cheating" }]);
  press(rowOf(g, "Bo"), "More");
  press(g.panel().querySelector(".rp-more"), "Remove from list");
  assert.deepStrictEqual(g.sent("recent-remove"), [{ username: "Bo" }]);
  assert.strictEqual(g.panel().querySelector(".rp-more"), null, "closed after Remove");
});

test("join requests: listed first, a pop-up, the badge and the tab count; Accept / Decline send the request id", () => {
  const g = page();
  const li = g.document.createElement("li");
  li.id = "remaster-friends-item";
  const label = g.document.createElement("div");
  label.className = "vertical-list-menu-item";
  li.appendChild(label);
  g.document.body.appendChild(li);
  g.RemasterFriends.on("remaster-recent", payload());
  assert.strictEqual(label.textContent, "FRIENDS (1)", "the join request counts on the menu item");
  g.RemasterFriends.openRecent();
  const tab = g.panel().querySelectorAll(".rf-tab").find((t) => /^Recent/.test(t.textContent));
  assert.strictEqual(tab.textContent, "Recent1", "the tab shows the count");
  const req = rowOf(g, "Eve");
  assert.ok(/Wants to join your party/.test(req.textContent));
  press(req, "Accept");
  press(rowOf(g, "Eve"), "Decline");
  assert.deepStrictEqual(g.sent("recent-join-accept"), [{ requestId: "abc123def456" }]);
  assert.deepStrictEqual(g.sent("recent-join-decline"), [{ requestId: "abc123def456" }]);
  const before = g.sent("recent-get").length;
  g.RemasterFriends.on("remaster-join-request", { requestId: "fff000fff000", from: person("Fay") });
  const toast = g.document.getElementById("remaster-party-toast");
  assert.ok(toast && /Fay asks to join your party/.test(toast.textContent), toast && toast.textContent);
  press(toast, "Accept");
  assert.deepStrictEqual(g.sent("recent-join-accept").pop(), { requestId: "fff000fff000" });
  assert.strictEqual(g.sent("recent-get").length, before + 1, "the tab asks for the new list");
  g.RemasterFriends.on("remaster-join-request", { requestId: "x" });
  assert.ok(/hidden/.test(toast.className), "a request without a sender shows nothing");
});

test("the invite / join setting: four choices, the current one marked; the blocked list unblocks", () => {
  const g = openRecent();
  const set = g.panel().querySelector(".rp-choices");
  assert.deepStrictEqual(buttons(set), ["Everyone", "Friends & recent", "Friends", "Nobody"]);
  assert.ok(/\bon\b/.test(set.querySelectorAll(".rf-btn")[1].className));
  press(set, "Friends & recent");
  assert.deepStrictEqual(g.sent("recent-settings"), [], "the current one sends nothing");
  press(set, "Nobody");
  assert.deepStrictEqual(g.sent("recent-settings"), [{ join: "nobody" }]);
  g.RemasterFriends.on("remaster-recent", payload({ settings: { join: "nobody" } }));
  assert.ok(/Nobody can invite you or ask to join, friends included/.test(g.panel().textContent));
  const zed = rowOf(g, "Zed");
  assert.ok(/Can't invite you, join you or see you here/.test(zed.textContent));
  press(zed, "Unblock");
  assert.deepStrictEqual(g.sent("recent-unblock"), [{ username: "Zed" }]);
});

test("the answers: what worked, and why something didn't", () => {
  const g = openRecent();
  const msg = () => g.panel().querySelector(".rf-msg");
  const cases = [
    [{ action: "recent-invite", ok: true, username: "Bo" }, /Party invite sent to Bo/, true],
    [{ action: "recent-join-request", ok: true, username: "Bo" }, /Asked to join Bo's party/, true],
    [{ action: "recent-join-accepted", ok: true, username: "Ann" }, /You joined Ann's party/, true],
    [{ action: "recent-join-accept", ok: true, username: "Eve" }, /Eve joined your party/, true],
    [{ action: "recent-block", ok: true, username: "Cy" }, /Cy is blocked/, true],
    [{ action: "recent-report", ok: true, username: "Bo" }, /Report sent/, true],
    [{ action: "recent-settings", ok: true, join: "friends" }, /Saved: Friends can invite you/, true],
    [{ action: "recent-invite", error: "unavailable" }, /isn't taking invites or requests from you/, false],
    [{ action: "recent-join-request", error: "mode-full" }, /no room for one more/, false],
    [{ action: "recent-join-request", error: "not-party-leader" }, /ask the leader/, false],
    [{ action: "recent-join-request", error: "party-in-queue" }, /searching for a match/, false],
    [{ action: "recent-invite", error: "too-soon" }, /Give it a moment/, false],
    [{ action: "recent-report", error: "already-reported" }, /already reported/, false],
    [{ action: "recent-invite", error: "something-new" }, /That didn't work/, false]
  ];
  for (const [r, want, ok] of cases) {
    g.RemasterFriends.on("remaster-recent-result", r);
    assert.ok(want.test(msg().textContent), JSON.stringify(r) + " -> " + msg().textContent);
    assert.strictEqual(/\bok\b/.test(msg().className), ok, JSON.stringify(r));
  }
  const guest = page();
  guest.RemasterFriends.openRecent();
  guest.RemasterFriends.on("remaster-recent-result", { action: "recent-get", error: "no-account" });
  assert.ok(/Sign in with your account to see recent players/.test(guest.panel().textContent), guest.panel().textContent);
});

test("malformed pushes don't throw, and the tab still draws what came", () => {
  const g = page();
  g.RemasterFriends.openRecent();
  const tries = [null, undefined, "x", {}, { players: "x" }, { players: [null, { username: "Ann" }] },
    { players: [{ username: "Bo", invite: null, join: "x", party: 3 }], joinRequests: [null, { requestId: "a" }, { from: { username: "Q" } }],
      blocked: [null], settings: null, privacyOptions: null, reportReasons: 5 }];
  for (const msg of tries) assert.doesNotThrow(() => g.RemasterFriends.on("remaster-recent", msg), JSON.stringify(msg));
  for (const msg of [null, undefined, "x", { action: null }]) assert.doesNotThrow(() => g.RemasterFriends.on("remaster-recent-result", msg));
  assert.ok(rowOf(g, "Bo"), "the last good player drew");
  assert.ok(!/undefined|NaN/.test(g.panel().textContent), g.panel().textContent.slice(0, 300));
  assert.doesNotThrow(() => press(rowOf(g, "Bo"), "More"));
});

test("no player-facing text says bots or AI", () => {
  const src = fs.readFileSync(path.join(JS, "Friends.js"), "utf8");
  // Every string literal (comments aside): what the menu can ever show.
  const strings = src.replace(/\/\/[^\n]*/g, "").match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g) || [];
  const bad = strings.filter((s) => /\bbots?\b|\bAI\b|\bcomputer[- ]controlled\b/i.test(s));
  assert.deepStrictEqual(bad, []);
  const g = openRecent();
  press(rowOf(g, "Cy"), "More");
  assert.ok(!/\bbots?\b|\bAI\b/i.test(g.panel().textContent));
  const empty = openRecent({ players: [], joinRequests: [], blocked: [] });
  assert.ok(/Players you queue into a match with show up here/.test(empty.panel().textContent));
});

test("with a gamepad the focus ring covers the tabs and the rows' buttons; FRIENDS comes back with its add box", () => {
  const g = page({ FooterData: { bHasGamepad: true } });
  g.RemasterFriends.openRecent();
  g.RemasterFriends.on("remaster-recent", payload());
  const focused = () => g.panel().querySelector(".ro-focus");
  assert.ok(focused() && /^Recent/.test(focused().textContent), "starts on the tab (no field on RECENT): " + (focused() && focused().textContent));
  g.RemasterOverlay.handle(13);         // D-pad down
  g.RemasterOverlay.handle(13);
  assert.ok(focused() && focused().parentNode, "the ring moved on");
  const friends = g.panel().querySelectorAll(".rf-tab").find((t) => /^Friends/.test(t.textContent));
  friends.click();
  assert.ok(!/hidden/.test(g.panel().querySelector(".rf-add").className), "the add box is back");
  g.RemasterFriends.on("remaster-friends", { you: "me", friends: [{ username: "Ann" }], incoming: [], outgoing: [], invites: [] });
  assert.ok(rowOf(g, "Ann") && !g.panel().querySelector(".rp-detail"), "the FRIENDS list, not the recent rows");
  g.RemasterFriends.close();
  assert.ok(!g.RemasterOverlay.isOpen());
});

console.log("all %d recent players menu tests passed", passed);
