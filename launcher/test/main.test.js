// main.js on a stand-in Electron (no window, no network): the window's
// security settings, the IPC sender check, and the window's long actions
// claimed before their first await (a second Update click while the first is
// still starting was run alongside it: two syncs on one game folder).
"use strict";

const assert = require("assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const Module = require("module");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "launcher-main-"));
const userData = path.join(tmp, "userData");
fs.mkdirSync(userData, { recursive: true });
// An empty game folder (installable) and a release server that never answers.
fs.writeFileSync(path.join(userData, "settings.json"), JSON.stringify({
  gamePath: path.join(tmp, "game"), manifestUrl: "http://127.0.0.1:9/remaster/manifest.json", playIntro: true
}));

const handlers = {};
const appEvents = {};
const fetches = [];
let releaseFetch = null;            // resolves the stand-in network's pending answers
const pendingFetches = [];
let win = null;
let pickFolder = null;              // what the folder dialog answers

class WebContents {
  constructor() {
    this.events = {};
    this.mainFrame = {};
    this.permissionRequest = null;
    this.permissionCheck = null;
    const self = this;
    this.session = {
      setPermissionRequestHandler(fn) { self.permissionRequest = fn; },
      setPermissionCheckHandler(fn) { self.permissionCheck = fn; }
    };
  }
  on(name, fn) { (this.events[name] = this.events[name] || []).push(fn); return this; }
  emit(name, ...args) { (this.events[name] || []).forEach((f) => f(...args)); }
  setWindowOpenHandler(fn) { this.windowOpen = fn; }
  send() {}
}

class BrowserWindow {
  constructor(opts) { this.opts = opts; this.webContents = new WebContents(); win = this; }
  once() {}
  on() {}
  loadFile(f) { this.loaded = f; return Promise.resolve(); }
  isDestroyed() { return false; }
  isVisible() { return true; }
  isMinimized() { return false; }
  show() {} hide() {} minimize() {} focus() {} restore() {} close() {}
}

const electron = {
  app: {
    isPackaged: false,
    getVersion: () => "9.9.9",
    getPath: (name) => path.join(tmp, name === "userData" ? "userData" : name),
    requestSingleInstanceLock: () => true,
    whenReady: () => Promise.resolve(),
    on: (name, fn) => { (appEvents[name] = appEvents[name] || []).push(fn); },
    quit: () => {}
  },
  BrowserWindow,
  ipcMain: { handle: (channel, fn) => { handlers[channel] = fn; } },
  dialog: { showOpenDialog: async () => (pickFolder ? { canceled: false, filePaths: [pickFolder] } : { canceled: true, filePaths: [] }) },
  shell: { openExternal: async () => {} },
  net: {
    // Held until releaseFetch(): the first sync stays in its manifest fetch.
    fetch: (url) => new Promise((resolve, reject) => {
      fetches.push(url);
      pendingFetches.push(() => reject(new Error("net::ERR_CONNECTION_REFUSED")));
    })
  },
  Menu: { setApplicationMenu: () => {} },
  clipboard: { writeText: async () => {} },
  safeStorage: { isAsyncEncryptionAvailable: async () => false },
  screen: { getPrimaryDisplay: () => ({ workAreaSize: { width: 1920, height: 1040 } }) }
};
releaseFetch = () => { while (pendingFetches.length) pendingFetches.shift()(); };

const load = Module._load;
Module._load = function (request) {
  if (request === "electron") return electron;
  return load.apply(this, arguments);
};
// The real game.isRunning asks tasklist for Victory.exe: with the game open on
// this PC every sync would be refused ("Close The Culling first") and these
// tests would fail for a reason that has nothing to do with them. The game is
// never running here.
require("../lib/game").isRunning = async () => false;

let passed = 0;
let current = null;
async function test(name, fn) { current = name; await fn(); passed++; current = null; console.log("ok    " + name); }
// A test left waiting on a promise that can't settle (on the old main.js the
// second Update click went into its own manifest fetch) would otherwise end
// the process quietly, with exit code 0.
process.on("exit", () => {
  if (current) { console.error("FAIL never finished: " + current); process.exitCode = 1; }
});
const tick = () => new Promise((r) => setImmediate(r));
const call = (channel, ...args) => handlers[channel]({ sender: win.webContents }, ...args);
const settle = (p) => p.then((v) => ({ ok: true, v }), (e) => ({ ok: false, e }));

(async () => {
  try {
    require("../main.js");
    for (let i = 0; i < 20 && !win; i++) await tick();
    assert.ok(win, "the window was created");

    await test("the window: isolated, sandboxed, no Node, no DevTools menu; no navigation, windows, webviews or permissions", () => {
      const wp = win.opts.webPreferences;
      assert.strictEqual(wp.contextIsolation, true);
      assert.strictEqual(wp.sandbox, true);
      assert.strictEqual(wp.nodeIntegration, false);
      assert.ok(!wp.webviewTag, "no <webview>");
      assert.ok(/preload\.js$/.test(wp.preload));
      let prevented = 0;
      win.webContents.emit("will-navigate", { preventDefault: () => prevented++ }, "https://evil.test/");
      win.webContents.emit("will-redirect", { preventDefault: () => prevented++ }, "https://evil.test/");
      assert.strictEqual(prevented, 2, "navigation and redirects are refused");
      assert.deepStrictEqual(win.webContents.windowOpen({ url: "https://evil.test/" }), { action: "deny" });
      let granted = null;
      win.webContents.permissionRequest(win.webContents, "notifications", (ok) => { granted = ok; });
      assert.strictEqual(granted, false, "permission requests are refused");
      assert.strictEqual(win.webContents.permissionCheck(win.webContents, "clipboard-read"), false);
      const other = new WebContents();
      appEvents["web-contents-created"].forEach((f) => f({}, other));
      let webview = 0;
      other.emit("will-attach-webview", { preventDefault: () => webview++ });
      assert.strictEqual(webview, 1, "no webview attaches anywhere");
      assert.deepStrictEqual(other.windowOpen({ url: "https://evil.test/" }), { action: "deny" });
      for (const page of ["main.html", "splash.html"]) {
        const html = fs.readFileSync(path.join(__dirname, "..", "src", page), "utf8");
        const csp = /Content-Security-Policy" content="([^"]+)"/.exec(html)[1];
        for (const want of ["default-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-src 'none'"]) {
          assert.ok(csp.indexOf(want) >= 0, page + ": " + want);
        }
        assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), page + ": no unsafe-*");
        assert.ok(!/<script>[^<]/.test(html) && !/ on[a-z]+="/.test(html), page + ": no inline script or handlers");
      }
    });

    await test("IPC from anything but the launcher's window is refused", async () => {
      const r = await settle(handlers.state({ sender: new WebContents() }));
      assert.ok(!r.ok && /unexpected sender/.test(r.e.message));
      const preload = fs.readFileSync(path.join(__dirname, "..", "preload.js"), "utf8");
      const invoked = new Set([...preload.matchAll(/ipcRenderer\.invoke\("([a-z-]+)"/g)].map((m) => m[1]));
      for (const ch of invoked) assert.ok(handlers[ch], "preload's " + ch + " has a handler");
      for (const ch of Object.keys(handlers)) assert.ok(invoked.has(ch), "handler " + ch + " is reachable only through preload");
    });

    await test("a second Update while the first is still starting is refused, as are Restore and Check meanwhile", async () => {
      const first = settle(call("sync", {}));
      const second = await settle(call("sync", {}));
      assert.ok(!second.ok && /Wait for Game Sync to finish/.test(second.e.message), "the second click: " + (second.e && second.e.message));
      const restore = await settle(call("rollback"));
      assert.ok(!restore.ok && /Wait for Game Sync to finish/.test(restore.e.message), "Restore: " + (restore.e && restore.e.message));
      const check = await settle(call("check-updates"));
      assert.ok(!check.ok && /Wait for Game Sync to finish/.test(check.e.message), "Check for updates: " + (check.e && check.e.message));
      // tasklist (game.isRunning) can take seconds on a busy PC.
      for (let i = 0; i < 1500 && !fetches.length; i++) await new Promise((r) => setTimeout(r, 20));
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(fetches.length, 2, "one manifest fetch (and its .sig), for one sync: " + fetches.join(", "));
      releaseFetch();
      const r = await first;
      assert.ok(!r.ok && /Can't reach the update server/.test(r.e.message), "the first sync ends with the network's error: " + (r.e && r.e.message));
      // Over: the next one may run.
      const again = settle(call("sync", {}));
      for (let i = 0; i < 1500 && fetches.length < 4; i++) await new Promise((res) => setTimeout(res, 20));
      assert.strictEqual(fetches.length, 4, "a new sync runs once the first is over");
      releaseFetch();
      await again;
    });

    await test("PLAY's look for a release: one that arrives after the 4 s wait is planned when it does", async () => {
      // An installed game folder (Victory.exe only), chosen in Settings.
      const g = path.join(tmp, "installed");
      fs.mkdirSync(path.join(g, "Victory", "Binaries", "Win64"), { recursive: true });
      fs.writeFileSync(path.join(g, "Victory", "Binaries", "Win64", "Victory.exe"), "exe");
      pickFolder = g;
      const picked = await call("choose-game-folder");
      assert.strictEqual(picked.settings.gamePath, g);
      // The release server answers slowly: after PLAY has stopped waiting.
      const sync = require("../lib/sync");
      const real = sync.fetchManifest;
      const body = Buffer.from("new pak");
      sync.fetchManifest = () => new Promise((resolve) => setTimeout(() => resolve({
        version: "2.0.0", baseUrl: "https://example.test/remaster/manifest.json",
        files: [{ path: "Victory/Content/Paks/new.pak", size: body.length, url: "o/x",
          sha256: require("crypto").createHash("sha256").update(body).digest("hex") }]
      }), 4600));
      try {
        const played = await settle(call("play"));
        assert.ok(!played.ok, "PLAY itself is refused here (no release installed)");
        await new Promise((r) => setTimeout(r, 1200));
        const s = await call("state");
        assert.strictEqual(s.release, "2.0.0");
        assert.ok(s.pending && s.pending.files === 1, "the late release is planned: " + JSON.stringify(s.pending));
      } finally {
        sync.fetchManifest = real;
      }
    });

    console.log("all %d main process tests passed", passed);
  } finally {
    Module._load = load;
    fs.rmSync(tmp, { recursive: true, force: true });
  }
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exitCode = 1; });
