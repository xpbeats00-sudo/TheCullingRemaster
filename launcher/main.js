// The Culling Remaster launcher: main process.
//
// One frameless window: the startup screen (splash.html) while the boot
// checks run, then the launcher (main.html). Everything that touches the disk,
// the network or other programs happens here; the pages get the narrow
// window.launcher API from preload.js.
"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, net, Menu, clipboard } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("./lib/config");
const game = require("./lib/game");
const sync = require("./lib/sync");
const clientdll = require("./lib/clientdll");
const playername = require("./lib/playername");
const build = require("./lib/build");
const { createLog } = require("./lib/log");
const { friendly } = require("./lib/errors");

const SETTINGS = () => path.join(app.getPath("userData"), "settings.json");
const PAGES = { splash: "src/splash.html", main: "src/main.html" };

let win = null;
let settings = null;
let manifest = null;           // last fetched release manifest
let todo = null;               // files Game Sync still has to download
let busy = false;              // a sync is running
let syncAbort = null;          // aborts the running sync (Pause)
let bootResult = { online: false, error: null };
let log = () => {};

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
      nodeIntegration: false,
      // No DevTools in the shipped app (no menu either: no reload shortcuts).
      devTools: !app.isPackaged
    }
  });
  // Pages never navigate away or open windows; links go through openLink.
  win.webContents.on("will-navigate", (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  win.once("ready-to-show", () => win.show());
  win.loadFile(settings.playIntro ? PAGES.splash : PAGES.main);
  // Without the intro the main page shows at once; it is told when the checks
  // finish so it shows their result.
  if (!settings.playIntro) boot().finally(() => send("state-changed"));
}

// ---------------------------------------------------------------- boot checks

async function refreshPlan(onHash, opts = {}) {
  const check = game.check(settings.gamePath);
  if (!(check.ok || check.installable) || !manifest) { todo = null; return; }
  todo = await sync.plan(manifest, settings.gamePath, onHash, opts);
}

// The latest signed manifest; an older release than the installed one is
// refused (a server can't take players back to an old version).
async function latestManifest() {
  const m = await sync.fetchManifest(settings.manifestUrl);
  const installed = sync.installedVersion(settings.gamePath);
  if (installed && sync.compareVersions(m.version, installed) < 0) {
    throw new Error(`the server offers ${m.version}, older than the installed ${installed}: not installing it`);
  }
  manifest = m;
  bootResult = { online: true, error: null };
  return m;
}

async function boot() {
  const progress = (p, label) => send("boot-progress", { p, label });
  bootResult = { online: false, error: null };
  progress(0.08, "Checking game folder");
  if (!settings.gamePath) {
    // A Steam copy is used only if this launcher already manages it: a full
    // release would otherwise replace Steam's files (its Steam API among them).
    const steam = game.detect();
    const managed = steam && fs.existsSync(path.join(steam, sync.STATE_DIR));
    const gamePath = managed ? steam : game.defaultInstallDir();
    settings = config.save(SETTINGS(), Object.assign(settings, { gamePath }));
  }
  try { sync.recover(settings.gamePath); } catch (e) { log("recover", { error: e.message }); }
  // An install that already has a name (the game's own setting) starts with it.
  if (!settings.playerName && game.check(settings.gamePath).ok) {
    const existing = playername.read(settings.gamePath);
    if (existing) settings = config.save(SETTINGS(), Object.assign(settings, { playerName: existing }));
  }
  progress(0.25, "Contacting xplab.shop");
  try {
    await latestManifest();
  } catch (e) {
    manifest = null;
    bootResult = { online: false, error: friendly(e) };
    log("manifest", { error: e.message });
  }
  const installed = game.check(settings.gamePath).ok;
  progress(0.45, installed ? "Verifying game files" : "Preparing install");
  try {
    await refreshPlan((done, total) => progress(0.45 + 0.5 * done / total, installed ? "Verifying game files" : "Preparing install"));
  } catch (e) {
    bootResult.error = e.message;
  }
  log("boot", { online: bootResult.online, release: manifest && manifest.version, installed: sync.installedVersion(settings.gamePath), todo: todo ? todo.length : null });
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
    previous: sync.previousVersion(settings.gamePath),
    // partial: bytes of the planned files already downloaded (a paused or
    // interrupted sync); releaseBytes: the whole release, for "x of y".
    // Offline there is nothing to plan against; what is already downloaded
    // still shows, so a paused install doesn't look lost.
    offlineStaged: manifest ? 0 : sync.stagedBytes(settings.gamePath),
    pending: todo ? {
      files: todo.length,
      bytes: todo.reduce((s, f) => s + f.size, 0),
      partial: busy ? 0 : sync.partialBytes(todo, settings.gamePath),
      releaseBytes: manifest.files.reduce((s, f) => s + f.size, 0)
    } : null,
    freeBytes: (() => { try { return sync.freeBytes(settings.gamePath); } catch { return null; } })(),
    servers: (manifest && manifest.servers && manifest.servers.length) ? manifest.servers : settings.servers,
    // The name can be set unless the installed game uses a real Steam name.
    nameSupported: !check.ok || playername.supported(settings.gamePath),
    busy
  };
}

async function ping(server) {
  const url = server.status || server.api;
  const t0 = Date.now();
  try {
    sync.checkUrl(url);
    const res = await net.fetch(url, { cache: "no-store", redirect: "error", signal: AbortSignal.timeout(4000) });
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
    try {
      return await fn(...args);
    } catch (err) {
      // The raw error goes to the log; the window gets what to do about it.
      log("error", { channel, kind: err.kind, code: err.code, error: String(err.message || err) });
      throw new Error(friendly(err));
    }
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
    if (app.isPackaged && game.inside(r.filePaths[0], path.dirname(process.execPath))) {
      throw new Error("Choose a folder outside the launcher's own folder (uninstalling the launcher would delete the game)");
    }
    const gamePath = game.installTarget(r.filePaths[0]);
    settings = config.save(SETTINGS(), Object.assign(settings, { gamePath }));
    await refreshPlan();
    return state();
  });

  handle("set-setting", (key, value) => {
    if (!["serverId", "closeOnLaunch", "playIntro", "parallel", "maxMBps"].includes(key)) throw new Error("not a user setting: " + key);
    settings = config.save(SETTINGS(), Object.assign(settings, { [key]: value }));
    return state();
  });

  handle("set-player-name", (raw) => {
    const v = playername.validate(raw);
    if (v.error) throw new Error(v.error);
    settings = config.save(SETTINGS(), Object.assign(settings, { playerName: v.name }));
    if (game.check(settings.gamePath).ok && playername.supported(settings.gamePath)) playername.write(settings.gamePath, v.name);
    return state();
  });

  handle("check-updates", async () => {
    if (busy) throw new Error("Game Sync is running");
    await latestManifest();
    await refreshPlan((done, total) => send("sync-progress", { phase: "verify", done, total }));
    return state();
  });

  // Restores the version before the last update (its files are kept until the next one).
  handle("rollback", async () => {
    if (busy) throw new Error("Wait for Game Sync to finish");
    if (game.isRunning()) throw new Error("Close The Culling first");
    const v = sync.rollback(settings.gamePath);
    log("rollback", { to: v });
    await refreshPlan();
    return Object.assign(state(), { restored: v });
  });

  // Support information, copied for pasting into a message.
  handle("diagnostics", () => {
    const s = state();
    const text = [
      `The Culling Remaster launcher ${s.build ? s.build.label : s.appVersion}`,
      `Windows ${os.release()} ${os.arch()}, ${Math.round(os.totalmem() / 1073741824)} GB RAM`,
      `Game folder: ${settings.gamePath} (${s.game.ok ? "installed" : s.game.reason})`,
      `Release: ${s.release || "-"}, installed: ${s.installed || "-"}, previous: ${s.previous || "-"}`,
      `Pending: ${s.pending ? `${s.pending.files} file(s), ${s.pending.bytes} bytes, ${s.pending.partial} partial` : "-"}`,
      `Free space: ${s.freeBytes}, downloads at once: ${settings.parallel}, limit: ${settings.maxMBps || "none"} MB/s`,
      `Online: ${s.online}${s.error ? ", last error: " + s.error : ""}`,
      `Log: ${log.file}`,
      "",
      ...log.recent().slice(-60)
    ].join("\n");
    clipboard.writeText(text);
    return true;
  });

  // Pause: in-flight downloads stop; finished files and partial ones stay, and
  // the next sync (also after a restart) continues from them.
  handle("pause-sync", () => {
    if (syncAbort) syncAbort.abort();
    return true;
  });

  // Install / update / resume, or with { repair: true } rehash every file first.
  handle("sync", async (opts = {}) => {
    if (busy) throw new Error("Game Sync is already running");
    const check = game.check(settings.gamePath);
    if (!(check.ok || check.installable)) throw new Error(check.reason + ": choose another folder in Settings");
    if (game.isRunning()) throw new Error("Close The Culling first: its files can't be updated while it runs");
    busy = true;
    syncAbort = new AbortController();
    const repair = !!(opts && opts.repair);
    log("sync", { repair, release: manifest && manifest.version });
    try {
      // Always the latest release: one published while the launcher was open
      // replaces the old plan instead of failing against it.
      try { await latestManifest(); } catch (e) { if (!manifest || /older than/.test(e.message)) throw e; }
      await refreshPlan((done, total) => send("sync-progress", { phase: "verify", done, total }), { full: repair, signal: syncAbort.signal });
      if (repair) log("repair", todo.report);
      // About ten progress updates a second, not one per network chunk.
      let lastSent = 0;
      const r = await sync.apply(manifest, todo, settings.gamePath, (p) => {
        const now = Date.now();
        if (p.phase === "download" && now - lastSent < 100 && p.doneBytes < p.totalBytes) return;
        lastSent = now;
        send("sync-progress", p);
      }, {
        signal: syncAbort.signal,
        parallel: settings.parallel,
        maxBytesPerSec: settings.maxMBps * 1048576,
        log
      });
      log("synced", { version: manifest.version, files: r.files, bytes: r.bytes, seconds: r.seconds, retries: r.retries });
      todo = [];
      return Object.assign(state(), { synced: r, repaired: repair ? todo.report || null : null });
    } catch (e) {
      if (!(e instanceof sync.SyncPaused)) {
        log("sync-error", { kind: e.kind, error: e.message });
        busy = false;
        try { await refreshPlan(); } catch { /* keep the error below */ }
        throw e;
      }
      log("paused", {});
      busy = false;
      await refreshPlan();
      return Object.assign(state(), { paused: true });
    } finally {
      busy = false;
      syncAbort = null;
    }
  });

  handle("ping-servers", async () => Promise.all(state().servers.map(ping)));

  handle("play", async () => {
    if (busy) throw new Error("Wait for Game Sync to finish");
    const check = game.check(settings.gamePath);
    if (!check.ok) throw new Error(check.reason);
    // Only a finished install starts: a paused one has some files but not all.
    if (!sync.installedVersion(settings.gamePath)) throw new Error("The game isn't fully installed yet: press Resume to finish it");
    // The name chosen in the launcher is the one the game shows.
    if (playername.supported(settings.gamePath)) {
      if (!settings.playerName) throw new Error("Choose your player name first");
      playername.write(settings.gamePath, settings.playerName);
    }
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
    Menu.setApplicationMenu(null);
    // Chromium's network stack: the system proxy and the Windows certificate store.
    sync.useFetch((url, init) => net.fetch(url, init));
    log = createLog(app.getPath("logs"));
    settings = config.load(SETTINGS());
    log("start", { version: app.getVersion(), gamePath: settings.gamePath });
    registerIpc();
    createWindow();
  });
  app.on("window-all-closed", () => app.quit());
  // Quitting mid-download pauses first, so the progress file is written.
  let quitting = false;
  app.on("before-quit", (e) => {
    if (!busy || !syncAbort || quitting) return;
    e.preventDefault();
    quitting = true;
    syncAbort.abort();
    const started = Date.now();
    const wait = setInterval(() => {
      if (!busy || Date.now() - started > 5000) { clearInterval(wait); app.quit(); }
    }, 100);
  });
}
