// CustomMatchSettings.js against stand-ins for the stock menu (node, no game):
// the screen is built from ClientWeb.js's REMASTER_CUSTOM_MODS, shows the
// lobby's settings, sends the full set (bounded) when changed and once more
// right before START; Join on the Play screen's Create or Join choice explains
// instead of opening the keypad; leaving the CUSTOM screen leaves the lobby
// unless its match is starting.
// usage: node test_custom_menu.js   (run by test_custom_match.py)
"use strict";
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const assert = require("assert");

const JS = path.join(__dirname, "src", "Victory", "Content", "uiresources", "FrontEnd", "js");
const clientweb = fs.readFileSync(path.join(JS, "ClientWeb.js"), "utf8");
const tables = clientweb.slice(clientweb.indexOf("var REMASTER_CUSTOM_URLS"), clientweb.indexOf("function RemasterCustomMatchURL"));

const sent = [], modals = [], calls = [];
const noop = function () {};
const deferred = { then: function (f) { f(); return deferred; }, catch: function () { return deferred; } };
function element() {
  return { textContent: "", classList: { add: noop, remove: noop }, getAttribute: noop, querySelector: () => null,
    querySelectorAll: () => [], dataset: {} };
}
// The settings page: one <li> per setting, each with its value <span>.
const spans = {};
const items = [];
const page = element();
page.querySelectorAll = () => items;
function $() { return { text: noop, html: noop, remove: noop, append: noop }; }
$.get = noop; $.ajax = noop; $.extend = Object.assign; $.Deferred = () => ({ resolve: () => ({ promise: noop }) });
function BaseMenuScreen() {}
["OnCreation", "OnShow", "OnHide", "OnClosed", "OnMouseClicked", "SetNewActiveMenu"].forEach((n) => { BaseMenuScreen.prototype[n] = noop; });
function CustomScreen() {}
CustomScreen.prototype.OnClosed = function () { calls.push("stock OnClosed"); };
CustomScreen.OnClicked = function (elem) { calls.push("stock OnClicked " + elem.id); };
const ctx = {
  console: { log: noop, warn: noop, error: noop }, $, document: { getElementById: (id) => (id == "custom-match-settings-menu" ? page : element()) },
  engine: { call: () => deferred }, ClientwebData: {}, ClientwebRootData: null, Matchmaking: {},
  GetClientwebRootURL: noop, LoginResponseFromEngine: noop, ShowError: noop, BindClientwebEvents: noop, ProcessLoginFailure: noop,
  BaseMenuScreen, VerticalMenuMixin: {}, Screens: {}, CustomScreen,
  PushModal: function (screen, args) { modals.push(args); }, PopScreen: noop,
  LobbyData: { IsInLobby: true, MatchIsStarting: false, CanStartMatch: true, Mods: null },
  PlayerProfileData: { UserID: "steam:1" }, IsLobbyOwner: () => true, IsOnline: () => true,
  ConnectWebsocketIfNeeded: () => deferred, LeaveLobby: () => calls.push("LeaveLobby"),
  socketConnection: { connected: true, emit: (name, msg) => sent.push([name, JSON.parse(JSON.stringify(msg))]) }
};
vm.createContext(ctx);
vm.runInContext(tables, ctx);
for (const [key] of ctx.REMASTER_CUSTOM_MODS) {
  const span = element();
  spans[key] = span;
  items.push({ getAttribute: () => key, querySelector: () => span });
}
vm.runInContext(fs.readFileSync(path.join(JS, "Screens", "CustomMatchSettings.js"), "utf8"), ctx);

let passed = 0;
function test(name, fn) { sent.length = 0; modals.length = 0; calls.length = 0; fn(); passed++; console.log("ok    " + name); }
const stock = {};
for (const [key, value] of ctx.REMASTER_CUSTOM_MODS) stock[key] = value;

let screen;
test("the screen shows the stock values and sends the full set", () => {
  screen = new ctx.Screens.CustomSettings();
  screen.OnCreation();
  assert.strictEqual(spans.NumGreenCrateSpawn.textContent, 12);
  assert.strictEqual(spans.RecyclerUseTime.textContent, 5);
  assert.deepStrictEqual(sent, [["lobby-set-mods", { mods: stock }]]);
});

test("a change is bounded and sent", () => {
  screen.IncrementSettings(1, "NumGreenCrateSpawn");
  screen.IncrementSettings(-1, "FreqHealthGivenInSeconds");   // already at its min (1)
  assert.strictEqual(spans.NumGreenCrateSpawn.textContent, 13);
  assert.strictEqual(spans.FreqHealthGivenInSeconds.textContent, 1);
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0][1].mods.NumGreenCrateSpawn, 13);
  screen.IncrementSettings(1, "StartingActivityValue");
  assert.strictEqual(sent.length, 1, "not a setting");
});

test("the lobby's settings are shown when the screen opens", () => {
  ctx.LobbyData.Mods = Object.assign({}, stock, { NumGreenCrateSpawn: 30, RecyclerUseTime: 999, NumRedCrateSpawn: "9" });
  screen.OnShow();
  assert.strictEqual(spans.NumGreenCrateSpawn.textContent, 30);
  assert.strictEqual(spans.RecyclerUseTime.textContent, 5, "out of range: not taken");
  assert.strictEqual(spans.NumRedCrateSpawn.textContent, 3, "not a number: not taken");
  assert.strictEqual(sent[0][1].mods.NumGreenCrateSpawn, 30);
});

test("START sends the settings once more, then the stock START", () => {
  ctx.CustomScreen.OnClicked({ id: "start_match_btn" });
  assert.strictEqual(sent.length, 1);
  assert.strictEqual(sent[0][1].mods.NumGreenCrateSpawn, 30);
  assert.deepStrictEqual(calls, ["stock OnClicked start_match_btn"]);
  ctx.CustomScreen.OnClicked({ id: "match_settings_btn" });
  assert.strictEqual(sent.length, 1, "only START");
});

test("Join explains instead of opening the keypad; Create is stock", () => {
  const choices = [];
  ctx.PushModal("Modal", { options: ["Create", "Join", "Cancel"], title: "Create or Join a game?", callback: (o) => choices.push(o) });
  const chooser = modals[0];
  chooser.callback("Join");
  assert.deepStrictEqual(choices, [], "the stock Join (keypad) is not run");
  assert.strictEqual(modals.length, 2);
  assert.ok(/played on your PC/.test(modals[1].description) && /party/.test(modals[1].description));
  assert.ok(!/bot/i.test(modals[1].title + modals[1].description));
  chooser.callback("Create");
  assert.deepStrictEqual(choices, ["Create"]);
});

test("leaving the CUSTOM screen leaves the lobby, unless the match is starting", () => {
  new ctx.CustomScreen().OnClosed();
  assert.deepStrictEqual(calls, ["stock OnClosed", "LeaveLobby"]);
  calls.length = 0;
  ctx.LobbyData.MatchIsStarting = true;
  new ctx.CustomScreen().OnClosed();
  assert.deepStrictEqual(calls, ["stock OnClosed"]);
});

console.log("all %d custom menu tests passed", passed);
