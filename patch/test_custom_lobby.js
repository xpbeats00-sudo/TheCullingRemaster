// The CUSTOM screen fed the server's real lobby (node, no game): ClientWeb.js,
// the stock Custom.js (from the pak) and CustomMatchSettings.js run against
// stand-ins for the engine and the page, and the lobby-update the server sends
// for lobby-create (server/custommatch.js lobby(), what server.js emits) must
// list the owner as a contestant, show the owner's options (map, SETTINGS,
// START) and enable START, even when the calling card image never arrives.
// usage: node test_custom_lobby.js <stock Custom.js>   (test_custom_match.py
//        extracts it from the Paks dir and runs this)
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");
const custom = require(path.join(__dirname, "..", "server", "custommatch.js"));

const JS = path.join(__dirname, "src", "Victory", "Content", "uiresources", "FrontEnd", "js");
const stockCustom = process.argv[2];
if (!stockCustom || !fs.existsSync(stockCustom)) {
  console.log("skip  no stock Custom.js given");
  process.exit(0);
}

const noop = function () {};
// engine.call(...).then(cb): the calling card image lookup either answers or never does.
let answerImages = true;
const images = [];
function engineCall(name) {
  return { then: function (cb) {
    if (name == "GetCullingCardImagePathFromID") { if (answerImages) images.push(cb); return this; }
    if (name == "GetLocalPlayerCullingCardID") cb("191059");
    return this;
  }, catch: function () { return this; } };
}
const elements = {};
function element(id) {
  if (elements[id]) return elements[id];
  const classes = new Set(id == "custom-game-options" ? [] : []);
  const el = {
    id, dataset: {}, innerHTML: "", value: "", textContent: "",
    classList: { add: (c) => classes.add(c), remove: (c) => classes.delete(c), contains: (c) => classes.has(c) },
    querySelector: () => null, querySelectorAll: () => [], getAttribute: noop, focus: noop, appendChild: noop
  };
  elements[id] = el;
  return el;
}
function $(x) {
  const q = { text: noop, html: noop, remove: noop, append: noop, show: noop, hide: noop, val: noop, find: () => q, on: noop,
    hover: noop, addClass: noop, removeClass: noop, each: noop, attr: noop, css: noop, length: 0 };
  if (typeof x == "function") return q;
  return q;
}
$.get = noop; $.ajax = noop; $.extend = Object.assign; $.when = () => ({ then: noop });
// jQuery Deferred, synchronous: resolve(v).promise().then(cb) calls cb(v) at once.
function settled(ok, v) {
  const p = { then: function (f, g) { if (ok && f) f(v); if (!ok && g) g(v); return p; },
    catch: function (g) { if (!ok) g(v); return p; }, done: function (f) { if (ok) f(v); return p; },
    fail: function (g) { if (!ok) g(v); return p; } };
  return p;
}
$.Deferred = () => ({ resolve: (v) => ({ promise: () => settled(true, v) }), reject: (v) => ({ promise: () => settled(false, v) }) });
function BaseMenuScreen() {}
["OnCreation", "OnShow", "OnHide", "OnClosed", "OnMouseClicked", "SetNewActiveMenu", "MouseTabClick", "ResetFocus"]
  .forEach((n) => { BaseMenuScreen.prototype[n] = noop; });

const handlers = {};
const emitted = [];
let activeScreen = null;
const ctx = {
  console: { log: noop, warn: noop, error: noop, info: noop, trace: noop }, $, jQuery: $, setTimeout, clearTimeout, setInterval: noop,
  document: { getElementById: element, querySelectorAll: () => [], querySelector: () => null, createElement: () => element("x"),
    head: { appendChild: noop }, body: { appendChild: noop }, addEventListener: noop },
  window: {}, navigator: { userAgent: "" }, location: { href: "" },
  engine: { call: engineCall, on: noop, off: noop, trigger: noop }, rivets: { bind: () => ({ update: noop, unbind: noop }),
    formatters: {}, binders: {}, adapters: {}, configure: noop },
  io: { connect: () => ({ on: noop, emit: noop }) },
  BaseMenuScreen, VerticalMenuMixin: {}, HorizontalMenuMixin: {}, Screens: {},
  PushModal: noop, PopScreen: noop, PopModal: noop, PushScreen: noop, GetActiveScreen: () => activeScreen,
  FooterData: {}, Friends: {}, g_PlateformSettings: {},
  // FrontEnd.js (stock)
  CancelCustomGameInviteAcceptModal: noop, ShowCustomGameInviteAcceptFailure: noop
};
ctx.window = ctx;
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(JS, "ClientWeb.js"), "utf8"), ctx, { filename: "ClientWeb.js" });
vm.runInContext(fs.readFileSync(stockCustom, "utf8"), ctx, { filename: "Custom.js" });
vm.runInContext(fs.readFileSync(path.join(JS, "Screens", "CustomMatchSettings.js"), "utf8"), ctx, { filename: "CustomMatchSettings.js" });

// The socket: its handlers, as ClientWeb.js binds them at login.
vm.runInContext("socketConnection = { connected: true, on: function (n, f) { __handlers[n] = f; }, emit: function (n, m) { __emitted.push([n, m]); } };" +
  "ClientwebData.bIsConsole = false; ClientwebData.connectionStatus = CW_STATUS_AUTHENTICATED; PlayerProfileData.UserID = 'steam:76561190000000911';", Object.assign(ctx, { __handlers: handlers, __emitted: emitted }));
vm.runInContext("BindClientwebEvents({ resolve: function () {}, reject: function () {} });", ctx);
assert.ok(handlers["lobby-update"], "ClientWeb.js binds lobby-update");

let passed = 0;
function test(name, fn) { fn(); passed++; console.log("ok    " + name); }

// What server.js emits for lobby-create (through JSON, like socket.io).
function serverLobby() {
  const card = { name: "Tester", level: 7, cardID: 12, rank: null };
  return JSON.parse(JSON.stringify(custom.lobby("a1b2c3", "steam:76561190000000911", card, "191059", "Jungle/Jungle_P")));
}

function openCustom() {
  for (const k of Object.keys(elements)) delete elements[k];
  images.length = 0;
  vm.runInContext("LobbyData.RequestingNewLobby = true; LobbyData.IsInLobby = false; LobbyData.Code = null; LobbyData.Owner = '';" +
    "LobbyData.OutstandingRequest = false; LobbyData.MatchIsStarting = false;", ctx);
  activeScreen = new ctx.Screens.CustomScreen();
  activeScreen.OnCreation();
}

for (const answers of [true, false]) {
  test("lobby-create -> the owner is listed, the options and START are shown (card image " +
       (answers ? "arrives)" : "never arrives)"), () => {
    answerImages = answers;
    openCustom();
    assert.ok(emitted.some((e) => e[0] == "lobby-create"), "CUSTOM > Create asks for a lobby");
    assert.ok(element("custom-game-options").classList.contains("hidden"), "before the lobby: options hidden (stock)");
    handlers["lobby-update"](serverLobby());
    images.forEach((cb) => cb("images/card.png"));
    const members = ctx.LobbyMemberList.Members;
    assert.strictEqual(members.length, 16);
    assert.strictEqual(members[0].empty, false, "the owner's row is not empty");
    assert.strictEqual(members[0].displayName, "Tester");
    assert.strictEqual(members[0].level, 7);
    assert.strictEqual(members[0].cullingcard, "191059");
    assert.ok(members.slice(1).every((m) => m.empty), "the other 15 rows are empty");
    assert.ok(!element("custom-game-options").classList.contains("hidden"), "the owner's options are shown");
    assert.strictEqual(ctx.LobbyData.CanStartMatch, true, "START with one member");
    assert.ok(element("start_btn").classList.contains("start") && !element("start_btn").classList.contains("start-disabled"));
    assert.strictEqual(ctx.mapDisplayName.mapDisplayName, "Island");
    assert.deepStrictEqual(ctx.LobbyData.Mods, custom.defaults());
  });
}

test("a lobby-update for the map keeps the owner listed and the options shown", () => {
  const lobby = serverLobby();
  lobby.mapName = "Jungle2/Jungle2_P";
  handlers["lobby-update"](lobby);
  assert.strictEqual(ctx.LobbyMemberList.Members[0].displayName, "Tester");
  assert.ok(!element("custom-game-options").classList.contains("hidden"));
  assert.strictEqual(ctx.mapDisplayName.mapDisplayName, "Prison");
});

test("START asks the server to start (after the settings)", () => {
  emitted.length = 0;
  ctx.CustomScreen.OnClicked({ id: "start_match_btn" });
  const names = emitted.map((e) => e[0]);
  assert.deepStrictEqual(names, ["lobby-set-mods", "lobby-start-match"]);
});

test("match-ready custom:<map>:<mods> opens the map with its settings", () => {
  const calls = [];
  ctx.engine.call = function (name, arg) { calls.push([name, arg]); return engineCall(name); };
  handlers["match-ready"]({ gameServer: "custom:1:0=30|16=2", nonce: "n", serverNonce: "s" });
  assert.deepStrictEqual(calls.filter((c) => c[0] == "StartTraining"),
    [["StartTraining", "Jungle2_P?bEnableBots=true?game=/Game/Blueprints/GameMode/VictoryGameMode.VictoryGameMode_C?mods=0=30|16=2"]]);
});

console.log("all %d custom lobby tests passed", passed);
