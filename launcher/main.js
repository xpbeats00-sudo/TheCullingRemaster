// The Culling Remaster launcher: main process.
//
// One frameless window: the startup screen (splash.html) while the boot
// checks run, then the launcher (main.html). Everything that touches the disk,
// the network or other programs happens here; the pages get the narrow
// window.launcher API from preload.js.
"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const path = require("path");
const config = require("./lib/config");
const game = require("./lib/game");
const sync = require("./lib/sync");
const clientdll = require("./lib/clientdll");
const build = require("./lib/build");

const SETTINGS = () => path.join(app.getPath("userData"), "settings.json");
const PAGES = { splash: "src/splash.html", main: "src/main.html" };

let win = null;
let settings = null;
let manifest = null;           // last fetched release manifest
let todo = null;               // files Game Sync still has to download
let busy = false;              // a sync is running
let bootResult = { online: false, error: null };

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function createWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 760,
    minWidth: 1100,
    minHeight: 660,
    frame: false,
    backgroundColor: "#050307",
    show: false,
    title: "The Culling Remaster",
    icon: path.join(__dirname, "src", "assets", "icon.png"),
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    }
  });
  // Pages never navigate away or open windows; links go through openLink.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => win.show());
  win.loadFile(settings.playIntro ? PAGES.splash : PAGES.main);
  if (!settings.playIntro) boot();
}

// ---------------------------------------------------------------- boot checks

async function refreshPlan(onHash) {
  const check = game.check(settings.gamePath);
  if (!(check.ok || check.installable) || !manifest) { todo = null; return; }
  todo = await sync.plan(manifest, settings.gamePath, onHash);
}

async function boot() {
  const progress = (p, label) => send("boot-progress", { p, label });
  bootResult = { online: false, error: null };
  progress(0.08, "Checking game folder");
  if (!settings.gamePath) {
    // The player's Steam copy if there is one, else where a fresh install goes.
    const gamePath = game.detect() || game.defaultInstallDir();
    settings = config.save(SETTINGS(), Object.assign(settings, { gamePath }));
  }
  progress(0.25, "Contacting xplab.shop");
  try {
    manifest = await sync.fetchManifest(settings.manifestUrl);
    bootResult.online = true;
  } catch (e) {
    manifest = null;
    bootResult.error = e.message;
  }
  const installed = game.check(settings.gamePath).ok;
  progress(0.45, installed ? "Verifying game files" : "Preparing install");
  try {
    await refreshPlan((done, total) => progress(0.45 + 0.5 * done / total, installed ? "Verifying game files" : "Preparing install"));
  } catch (e) {
    bootResult.error = e.message;
  }
  progress(1, !bootResult.online ? "Offline" : !installed ? "Ready to install" : todo && todo.length ? "Update available" : "Ready");
}

// ---------------------------------------------------------------- state for the pages

function state() {
  const check = game.check(settings.gamePath);
  return {
    appVersion: app.getVersion(),
    build: build.info(app.getVersion()),
    settings,
    game: check,
    online: bootResult.online,
    error: bootResult.error,
    release: manifest ? manifest.version : null,
    installed: check.ok ? sync.installedVersion(settings.gamePath) : null,
    pending: todo ? { files: todo.length, bytes: todo.reduce((s, f) => s + f.size, 0) } : null,
    freeBytes: (() => { try { return sync.freeBytes(settings.gamePath); } catch { return null; } })(),
    servers: (manifest && manifest.servers && manifest.servers.length) ? manifest.servers : settings.servers,
    busy
  };
}

async function ping(server) {
  const url = server.status || server.api;
  const t0 = Date.now();
  try {
    sync.checkUrl(url);
    const res = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(4000) });
    const ms = Date.now() - t0;
    let users = null;
    try { users = (await res.json()).users; } catch { /* not our health route */ }
    return { id: server.id, ok: res.ok, ms, users: typeof users === "number" ? users : null };
  } catch {
    return { id: server.id, ok: false, ms: null, users: null };
  }
}

// ---------------------------------------------------------------- IPC

function handle(channel, fn) {
  ipcMain.handle(channel, async (e, ...args) => {
    if (!win || e.sender !== win.webContents) throw new Error("unexpected sender");
    return fn(...args);
  });
}

function registerIpc() {
  handle("state", () => state());
  handle("boot", () => boot());
  handle("splash-done", () => win.loadFile(PAGES.main));

  handle("choose-game-folder", async () => {
    if (busy) throw new Error("Wait for Game Sync to finish");
    const r = await dialog.showOpenDialog(win, {
      title: "Choose where to install The Culling Remaster (or an existing install)",
      properties: ["openDirectory", "createDirectory"],
      defaultPath: settings.gamePath || undefined
    });
    if (r.canceled || !r.filePaths[0]) return state();
    const gamePath = game.installTarget(r.filePaths[0]);
    settings = config.save(SETTINGS(), Object.assign(settings, { gamePath }));
    await refreshPlan();
    return state();
  });

  handle("set-setting", (key, value) => {
    if (!["serverId", "closeOnLaunch", "playIntro"].includes(key)) throw new Error("not a user setting: " + key);
    settings = config.save(SETTINGS(), Object.assign(settings, { [key]: value }));
    return state();
  });

  handle("check-updates", async () => {
    manifest = await sync.fetchManifest(settings.manifestUrl);
    bootResult = { online: true, error: null };
    await refreshPlan((done, total) => send("sync-progress", { phase: "verify", done, total }));
    return state();
  });

  handle("sync", async () => {
    if (busy) throw new Error("Game Sync is already running");
    const check = game.check(settings.gamePath);
    if (!(check.ok || check.installable)) throw new Error(check.reason + ": choose another folder in Settings");
    busy = true;
    try {
      if (!manifest) manifest = await sync.fetchManifest(settings.manifestUrl);
      await refreshPlan((done, total) => send("sync-progress", { phase: "verify", done, total }));
      // About ten progress updates a second, not one per network chunk.
      let lastSent = 0;
      const r = await sync.apply(manifest, todo, settings.gamePath, (p) => {
        const now = Date.now();
        if (now - lastSent < 100 && p.doneBytes < p.totalBytes) return;
        lastSent = now;
        send("sync-progress", Object.assign({ phase: "download" }, p));
      });
      todo = [];
      return Object.assign(state(), { synced: r });
    } finally {
      busy = false;
    }
  });

  handle("ping-servers", async () => Promise.all(state().servers.map(ping)));

  handle("play", async () => {
    if (busy) throw new Error("Wait for Game Sync to finish");
    const check = game.check(settings.gamePath);
    if (!check.ok) throw new Error(check.reason);
    // The player's own Func client, pointed at the chosen server.
    const servers = state().servers;
    const server = servers.find((s) => s.id === settings.serverId) || servers[0];
    clientdll.ensure(game.win64(settings.gamePath), server.api);
    await game.launch(settings.gamePath, app.getPath("logs"));
    if (settings.closeOnLaunch) setTimeout(() => app.quit(), 1500);
    else win.minimize();
    return true;
  });

  handle("open-link", (name) => {
    const url = settings.links[name];
    if (!url || !url.startsWith("https://")) throw new Error("unknown link " + name);
    return shell.openExternal(url);
  });

  handle("window", (action) => {
    if (action === "minimize") win.minimize();
    else if (action === "maximize") win.isMaximized() ? win.unmaximize() : win.maximize();
    else if (action === "close") win.close();
  });
}

// ---------------------------------------------------------------- app

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    settings = config.load(SETTINGS());
    registerIpc();
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
}
