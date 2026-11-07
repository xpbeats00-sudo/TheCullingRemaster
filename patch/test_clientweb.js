// ClientWeb.js's connection to the server against stand-ins (node, no game):
// the real ClientWeb.js runs in a vm with a fake engine, jQuery (ajax and a
// synchronous Deferred like jQuery 1.x/2.x), socket.io and clock, and the
// answers server/server.js gives. It checks:
// - login refusals: the server's reasons (errorCode or error) are shown in
//   words, with Retry only where trying again can help; unknown ones keep the
//   stock "Error code: 7".
// - reconnect: after a drop, a failed root data load, no answer to the login
//   or the server's auth-fail, the menu signs in again on its own (one try at
//   a time, 5 s doubling to 60 s, +-25%) with an "Offline - reconnecting"
//   notice; never after a refusal retrying can't help (until Retry); a
//   socket's events are bound once, and a replaced socket can't close the
//   next one.
// The functions are the shipped ones (the whole file is run).
// usage: node test_clientweb.js
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const JS = path.join(__dirname, "src", "Victory", "Content", "uiresources", "FrontEnd", "js");
const noop = function () {};

// ---------------------------------------------------------------- the clock
let now = 0;
let timers = [];
let timerId = 0;
function setTimeoutFake(fn, ms) { const id = ++timerId; timers.push({ id, at: now + (ms || 0), fn }); return id; }
function clearTimeoutFake(id) { timers = timers.filter((t) => t.id !== id); }
function advance(ms) {
  const end = now + ms;
  for (;;) {
    timers.sort((a, b) => a.at - b.at || a.id - b.id);
    const t = timers[0];
    if (!t || t.at > end) break;
    timers.shift();
    now = t.at;
    t.fn();
  }
  now = end;
}

// ---------------------------------------------------------------- jQuery Deferred (1.x/2.x: synchronous)
function isPromise(x) { return x && typeof x.then == "function" && typeof x.done == "function"; }
function Deferred() {
  let state = "pending", args = [];
  const done = [], fail = [];
  const d = {
    state: () => state,
    resolve: function () { if (state == "pending") { state = "resolved"; args = [].slice.call(arguments); done.splice(0).forEach((f) => f.apply(null, args)); fail.length = 0; } return d; },
    reject: function () { if (state == "pending") { state = "rejected"; args = [].slice.call(arguments); fail.splice(0).forEach((f) => f.apply(null, args)); done.length = 0; } return d; },
    done: function (f) { if (state == "resolved") f.apply(null, args); else if (state == "pending") done.push(f); return d; },
    fail: function (f) { if (state == "rejected") f.apply(null, args); else if (state == "pending") fail.push(f); return d; },
    always: function (f) { return d.done(f).fail(f); },
    promise: function () { return d; },
    then: function (ok, bad) {
      const n = Deferred();
      const pipe = (fn, settle) => function () {
        if (!fn) return settle.apply(null, arguments);
        const r = fn.apply(null, arguments);
        if (isPromise(r)) r.done(n.resolve).fail(n.reject);
        else settle(r);
      };
      d.done(pipe(ok, n.resolve));
      d.fail(pipe(bad, n.reject));
      return n;
    }
  };
  d.catch = (f) => d.then(null, f);
  return d;
}
function when() {
  const items = [].slice.call(arguments);
  if (items.length == 1 && isPromise(items[0])) return items[0];
  const out = Deferred(), values = [];
  let left = items.length;
  if (!left) return out.resolve();
  items.forEach((it, i) => {
    if (!isPromise(it)) { values[i] = it; if (--left == 0) out.resolve.apply(null, values); return; }
    it.done(function () { values[i] = arguments.length > 1 ? [].slice.call(arguments) : arguments[0]; if (--left == 0) out.resolve.apply(null, values); })
      .fail(out.reject);
  });
  return out;
}

// ---------------------------------------------------------------- the server's HTTP answers
const ROOT_PUBLIC = { authenticated: false, login: "https://srv/api/login", matchqueue: "https://srv/api/matchqueue" };
const ROOT_PRIVATE = { authenticated: true, login: "https://srv/api/login", socket: "https://srv", matchqueue: "https://srv/api/matchqueue" };
let answer = {};            // url -> function (opts) => [status, body] (or null: never answers)
const requests = [];
function ajax(opts) {
  const d = Deferred();
  if (opts.success) d.done(opts.success);
  if (opts.error) d.fail(opts.error);
  requests.push(opts);
  const a = answer[opts.url];
  const r = a ? a(opts) : [0, ""];
  if (r) {
    const text = typeof r[1] == "string" ? r[1] : JSON.stringify(r[1]);
    const xhr = { status: r[0], responseText: text };
    if (r[0] >= 200 && r[0] < 300) d.resolve(JSON.parse(text), "success", xhr);
    else d.reject(xhr, "error", "");
  }
  return d;
}
function serverUp() {
  answer = {
    "https://srv/api": (o) => [200, o.headers && o.headers.Authorization ? ROOT_PRIVATE : ROOT_PUBLIC],
    "https://srv/api/login": () => [200, { token: "tok", redirect: "https://srv/api", userID: "steam:7656119", build: "1" }]
  };
}

// ---------------------------------------------------------------- socket.io
const sockets = [];
function connect(url) {
  const s = { url, handlers: {}, emitted: [], closed: false, connected: true,
    io: { engine: { transport: { name: "websocket" } }, disconnect: function () { s.closed = true; } },
    on: function (n, f) { (s.handlers[n] = s.handlers[n] || []).push(f); },
    emit: function (n, m) { s.emitted.push([n, m]); },
    close: function () { s.closed = true; } };
  sockets.push(s);
  return s;
}
function fire(s, name, msg) { (s.handlers[name] || []).slice().forEach((f) => f(msg)); }
function last() { return sockets[sockets.length - 1]; }
function emits(s, name) { return s.emitted.filter((e) => e[0] == name); }

// ---------------------------------------------------------------- the engine and the page
const engineAnswers = {
  GetAppID: "1", GetClientwebUrl: "https://srv/api", GetClientwebOverride: "", GetClientBuild: "1", GetProductVersion: "1.0",
  RequestLoginTicket: "TICKET-SECRET-0123", GetCurrentUserId: "7656119", GetLocalPlayerCullingCardID: "5", HasNewCustomizations: false
};
const engineCalls = [];
const engineHandlers = {};
const engine = {
  call: function (name) { engineCalls.push([].slice.call(arguments)); return Deferred().resolve(engineAnswers[name]); },
  on: function (n, f) { engineHandlers[n] = f; }, off: noop, trigger: noop
};
const elements = {};
function element(id) {
  if (id && elements[id]) return elements[id];
  const classes = new Set();
  const el = {
    id: id || "", dataset: {}, innerHTML: "", value: "", textContent: "", className: "", style: {}, children: [], parentNode: null,
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    querySelector: () => null, querySelectorAll: () => [], getAttribute: noop, setAttribute: noop, focus: noop, addEventListener: noop,
    appendChild: function (c) { el.children.push(c); c.parentNode = el; return c; },
    removeChild: function (c) { el.children = el.children.filter((x) => x !== c); c.parentNode = null; return c; }
  };
  if (id) elements[id] = el;
  return el;
}
const body = element("body");
function $(x) {
  const q = { text: noop, html: noop, remove: noop, append: noop, show: noop, hide: noop, val: noop, find: () => q, on: noop,
    hover: noop, addClass: noop, removeClass: noop, each: noop, attr: noop, css: noop, length: 0, focus: noop };
  return q;
}
$.ajax = ajax; $.get = noop; $.extend = Object.assign; $.when = when; $.Deferred = Deferred;
const modals = [];
let activeScreen = { ScreenName: "MainMenu", GetMenuItems: () => [null, { focus: noop }] };
const logs = [];
const log = function () { logs.push([].slice.call(arguments).join(" ")); };
const ctx = {
  console: { log, warn: log, error: log, info: log, trace: noop }, $, jQuery: $,
  setTimeout: setTimeoutFake, clearTimeout: clearTimeoutFake, setInterval: () => 0, clearInterval: noop,
  Math: Object.create(Math),
  document: { getElementById: (id) => elements[id] || null, querySelectorAll: () => [], querySelector: () => null,
    createElement: () => element(), head: element("head"), body, addEventListener: noop },
  navigator: { userAgent: "" }, location: { href: "" },
  engine, io: { connect },
  rivets: { bind: () => ({ update: noop, unbind: noop }), formatters: {}, binders: {}, adapters: {}, configure: noop },
  BaseMenuScreen: function () {}, VerticalMenuMixin: {}, HorizontalMenuMixin: {}, Screens: {},
  PushModal: function (kind, args) { modals.push(args); }, PopModal: function () { modals.pop(); },
  PopModalByID: function (id) { const i = modals.findIndex((m) => m.modalID == id); return i < 0 ? null : modals.splice(i, 1)[0]; },
  PopScreen: noop, PushScreen: noop, PopScreenToMainMenu: noop, GetActiveScreen: () => activeScreen, CheckMainMenuStartupModals: noop,
  FooterData: {}, Friends: {}, g_PlateformSettings: {},
  CancelCustomGameInviteAcceptModal: noop, ShowCustomGameInviteAcceptFailure: noop
};
ctx.Math.random = () => 0.5;
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext("Array.prototype.containsString = function (s) { return this.indexOf(s) >= 0; };", ctx);
vm.runInContext(fs.readFileSync(path.join(JS, "ClientWeb.js"), "utf8"), ctx, { filename: "ClientWeb.js" });
const run = (code) => vm.runInContext(code, ctx);

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

// A fresh menu: offline, nothing pending.
function reset() {
  run("if (socketConnection) OnSocketConnectionClosed(); ClientwebData.connectionStatus = CW_STATUS_UNKNOWN; bConnectAttemptProcessing = false;" +
      "buildOutOfDate = false; Matchmaking.LeaveRequested = false; Matchmaking.IsStartingMatchmaking = false; Matchmaking.IsMatchmaking = false;" +
      "RemasterReconnect.timer = null; RemasterReconnect.delay = 0; RemasterReconnect.stopped = false; RemasterReconnect.auto = false;");
  timers = [];
  modals.length = 0;
  sockets.length = 0;
  requests.length = 0;
  logs.length = 0;
  serverUp();
}
// The menu signs in: root data, login, the socket, login_ready, the socket login, auth-response.
function signIn() {
  run("ConnectWebsocketIfNeeded()");
  const s = last();
  assert.ok(s, "a socket was opened");
  fire(s, "connect");
  fire(s, "login_ready");
  advance(3000);
  fire(s, "auth-response");
  assert.strictEqual(run("ClientwebData.connectionStatus"), run("CW_STATUS_AUTHENTICATED"));
  return s;
}
function loginRefused(status, bodyObj) {
  reset();
  answer["https://srv/api/login"] = () => [status, bodyObj];
  run("ConnectWebsocketIfNeeded()");
  const m = modals.filter((x) => x.modalID == "Offline");
  assert.strictEqual(m.length, 1, "one offline modal for " + JSON.stringify(bodyObj));
  return m[0];
}

// ---------------------------------------------------------------- login refusals
test("a normal sign-in reaches auth-response (the stand-ins work)", () => {
  reset();
  const s = signIn();
  assert.strictEqual(emits(s, "login").length, 1);
  assert.strictEqual(emits(s, "login")[0][1].token, "tok");
});

const REFUSALS = [
  // [status, body, words, can retry]
  [403, { errorCode: "account-required", error: "account-required" }, /launcher and sign in/, false],
  [400, { error: "invalid-userid" }, /valid player ID/, false],
  [503, { error: "server-full" }, /server is full/, true],
  [429, { error: "too-many-new-players" }, /new players/, true],
  [429, { error: "rate-limited" }, /wait a minute/, true],
  [429, { error: "too-many-requests" }, /wait a minute/, true],
  [503, { error: "stopping" }, /restarting.*in a minute/, true]
];
for (const [status, b, words, retry] of REFUSALS) {
  test("login refused (" + (b.errorCode || b.error) + "): said in words, " + (retry ? "with" : "without") + " Retry", () => {
    const m = loginRefused(status, b);
    assert.ok(words.test(m.title), m.title);
    assert.ok(!/Error code/.test(m.title), m.title);
    assert.strictEqual(JSON.stringify(m.options), JSON.stringify(retry ? ["Retry", "Play Offline"] : ["Play Offline"]));
    assert.strictEqual(run("ClientwebData.connectionStatus"), run("CW_STATUS_FAILED"));
  });
}
test("an unknown refusal keeps the stock message (Error code: 7, Retry)", () => {
  const m = loginRefused(403, { errorCode: "something-new" });
  assert.ok(/Error code: 7/.test(m.title), m.title);
  assert.strictEqual(JSON.stringify(m.options), "[\"Retry\",\"Play Offline\"]");
});
test("a stock refusal keeps its stock handling (banned)", () => {
  reset();
  answer["https://srv/api/login"] = () => [403, { errorCode: "vac_banned" }];
  run("ConnectWebsocketIfNeeded()");
  assert.ok(modals.some((m) => /banned from online play/.test(m.title)));
});
test("Retry on a refusal tries to sign in again", () => {
  const m = loginRefused(503, { error: "server-full" });
  serverUp();
  m.callback("Retry");
  assert.ok(last(), "a socket after Retry");
});

// ---------------------------------------------------------------- reconnect
const notice = () => {
  const n = body.children.find((c) => c.id == "remaster-offline");
  return n && n.style.display != "none" ? n.textContent : null;
};
const logins = () => requests.filter((r) => r.url == "https://srv/api/login").length;
const pending = () => timers.length;
function serverDown() { answer = {}; }

test("a drop: 'Offline - reconnecting', signed in again 5 s later, the notice gone", () => {
  reset();
  const s = signIn();
  assert.strictEqual(notice(), null);
  fire(s, "disconnect");
  assert.ok(/^Offline . reconnecting$/.test(notice()), notice());
  const n = sockets.length;
  advance(4999);
  assert.strictEqual(sockets.length, n, "not before 5 s");
  advance(1);
  assert.strictEqual(sockets.length, n + 1, "a new socket at 5 s");
  const s2 = last();
  fire(s2, "connect"); fire(s2, "login_ready"); advance(3000); fire(s2, "auth-response");
  assert.strictEqual(run("IsOnline()"), true);
  assert.strictEqual(notice(), null);
  assert.strictEqual(pending(), 0, "nothing left scheduled");
});

test("server down: one try at a time, waits 5, 10, 20, 40, 60, 60 s; back up: signed in, the next drop waits 5 s", () => {
  reset();
  const s = signIn();
  serverDown();
  fire(s, "disconnect");
  const waits = [];
  for (let k = 0; k < 6; k++) {
    assert.strictEqual(pending(), 1, "exactly one try scheduled");
    const t = timers[0];
    waits.push(t.at - now);
    const before = requests.length;
    advance(t.at - now);
    assert.strictEqual(requests.length, before + 1, "one root data request per try");
  }
  assert.strictEqual(JSON.stringify(waits), JSON.stringify([5000, 10000, 20000, 40000, 60000, 60000]));
  assert.ok(notice());
  serverUp();
  advance(timers[0].at - now);
  const s2 = last();
  fire(s2, "connect"); fire(s2, "login_ready"); advance(3000); fire(s2, "auth-response");
  assert.strictEqual(run("IsOnline()"), true);
  fire(s2, "disconnect");
  assert.strictEqual(timers[0].at - now, 5000);
});

test("the wait is jittered by +-25%", () => {
  for (const [r, want] of [[0, 3750], [0.999, 6248]]) {
    reset();
    ctx.Math.random = () => r;
    const s = signIn();
    fire(s, "disconnect");
    assert.strictEqual(timers[0].at - now, want);
  }
  ctx.Math.random = () => 0.5;
});

test("a failed login-data load (root data) at start-up: retried", () => {
  reset();
  serverDown();
  run("ConnectWebsocketIfNeeded()");
  assert.strictEqual(pending(), 1);
  assert.ok(notice());
  assert.strictEqual(modals.length, 0, "no modal for an unreachable server");
  serverUp();
  advance(5000);
  assert.ok(last(), "signed in on the retry");
});

test("no answer to the login (status 0, or a proxy's 502 page): retried, no modal", () => {
  for (const r of [[0, ""], [502, "<html>Bad Gateway</html>"]]) {
    reset();
    answer["https://srv/api/login"] = () => r;
    run("ConnectWebsocketIfNeeded()");
    assert.strictEqual(modals.length, 0, JSON.stringify(modals));
    assert.strictEqual(pending(), 1, "retry scheduled after " + r[0]);
  }
});

test("auth-fail (the server no longer knows the token): a fresh login after the backoff", () => {
  reset();
  const s = signIn();
  assert.strictEqual(logins(), 1);
  fire(s, "auth-fail", { reason: "invalid-token" });
  assert.strictEqual(run("ClientwebData.AuthToken"), undefined, "the token is dropped");
  assert.strictEqual(run("socketConnection"), null);
  advance(5000);
  assert.strictEqual(logins(), 2, "logged in again over HTTP");
  const s2 = last();
  assert.notStrictEqual(s2, s);
  fire(s2, "connect"); fire(s2, "login_ready"); advance(3000);
  assert.strictEqual(emits(s2, "login").length, 1);
});

test("a refusal retrying can't help (account-required): no automatic tries; Retry tries again", () => {
  const m = loginRefused(403, { errorCode: "account-required" });
  assert.strictEqual(pending(), 0);
  assert.strictEqual(notice(), null);
  advance(600000);
  assert.strictEqual(logins(), 1);
  answer["https://srv/api/login"] = () => [503, { error: "server-full" }];
  modals.length = 0;
  m.callback("Play Offline");
  run("RemasterRetryNow()");
  assert.strictEqual(logins(), 2);
  assert.strictEqual(pending(), 1, "retryable again after Retry");
});

test("a retryable refusal during an automatic try: the notice says why, no modal each time", () => {
  reset();
  const s = signIn();
  answer["https://srv/api/login"] = () => [503, { error: "stopping" }];
  fire(s, "disconnect");
  advance(5000);
  advance(10000);
  assert.strictEqual(modals.filter((m) => m.modalID == "Offline").length, 0);
  assert.ok(/restarting/.test(notice()), notice());
  assert.strictEqual(pending(), 1);
});

test("login_ready twice: the socket's events are bound (and the login sent) once", () => {
  reset();
  run("ConnectWebsocketIfNeeded()");
  const s = last();
  fire(s, "connect");
  fire(s, "login_ready");
  fire(s, "login_ready");
  advance(3000);
  fire(s, "login_ready");
  advance(3000);
  assert.strictEqual(emits(s, "login").length, 1);
  assert.strictEqual(s.handlers["match-ready"].length, 1);
});

test("login_ready from a socket replaced within the 3 s: binds nothing on the new one", () => {
  reset();
  run("ConnectWebsocketIfNeeded()");
  const s = last();
  fire(s, "connect");
  fire(s, "login_ready");
  fire(s, "disconnect");                 // replaced before its 3 s are up
  advance(5000);                         // the reconnect: a new socket
  const s2 = last();
  assert.notStrictEqual(s2, s);
  fire(s2, "connect");
  fire(s2, "login_ready");
  advance(3000);
  assert.strictEqual(emits(s2, "login").length, 1);
  assert.strictEqual(s2.handlers["match-ready"].length, 1);
  assert.strictEqual(emits(s, "login").length, 0);
});

test("a replaced socket's late disconnect doesn't close the current one", () => {
  reset();
  const s = signIn();
  fire(s, "disconnect");
  advance(5000);
  const s2 = last();
  fire(s2, "connect"); fire(s2, "login_ready"); advance(3000); fire(s2, "auth-response");
  fire(s, "disconnect");
  fire(s, "error", "late");
  assert.strictEqual(run("socketConnection"), s2);
  assert.strictEqual(run("IsOnline()"), true);
});

console.log("all %d ClientWeb connection tests passed", passed);
