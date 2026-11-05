// The Culling Remaster launcher: main process.
//
// One frameless window: the startup screen (splash.html) while the boot
// checks run, then the launcher (main.html). Everything that touches the disk,
// the network or other programs happens here; the pages get the narrow
// window.launcher API from preload.js.
"use strict";

const { app, BrowserWindow, ipcMain, dialog, shell, net, Menu, clipboard, safeStorage, screen } = require("electron");
const fs = require("fs");
const os = require("os");
const path = require("path");
const config = require("./lib/config");
const game = require("./lib/game");
const sync = require("./lib/sync");
const clientdll = require("./lib/clientdll");
const playername = require("./lib/playername");
const account = require("./lib/account");
const selfupdate = require("./lib/selfupdate");
const discord = require("./lib/discord");
const build = require("./lib/build");
const status = require("./lib/status");
const { createReconnect } = require("./lib/reconnect");
const { createLog } = require("./lib/log");
const { friendly } = require("./lib/errors");

const SETTINGS = () => path.join(app.getPath("userData"), "settings.json");
const UPDATES = () => path.join(app.getPath("userData"), "launcher-updates");
const PAGES = { splash: "src/splash.html", main: "src/main.html" };

let win = null;
let settings = null;
let manifest = null;           // last fetched release manifest
let todo = null;               // files Game Sync still has to download
let busy = false;              // a sync is running
let syncAbort = null;          // aborts the running sync (Pause)
let bootResult = { online: false, error: null };
let log = () => {};
let accounts = null;             // saved sign-ins (lib/account.js)
let accountApi = null;
// A launcher update in progress or failed: { version, done, total, error }.
let launcherUpdate = null;

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// Settings changes are written at once; a refusal is the launcher's own
// AppData folder, not the game folder (lib/errors.js).
function saveSettings(patch) {
  try {
    settings = config.save(SETTINGS(), Object.assign(settings, patch));
  } catch (e) {
    throw Object.assign(e, { op: e.op || "appdata" });
  }
  return settings;
}

// The game folder's state. A folder the launcher saw installed that is gone
// now reads as missing, not as somewhere to install into.
function checkGame() {
  return game.check(settings.gamePath, { expectInstalled: !!settings.gamePath && settings.installedPath === settings.gamePath });
}

// What lib/errors.js needs to word an error.
function errorContext() {
  let missing = false;
  try { missing = !!checkGame().missing; } catch { /* unknown */ }
  return { gamePath: settings && settings.gamePath, gameFolderMissing: missing };
}

// Remembers the folder holds a finished install (see checkGame).
function noteInstalled() {
  if (settings.gamePath && settings.installedPath !== settings.gamePath && sync.installedVersion(settings.gamePath)) {
    try { saveSettings({ installedPath: settings.gamePath }); } catch (e) { log("settings", { error: e.message }); }
  }
}

function createWindow() {
  // Never bigger than the screen it opens on (a small laptop, 150% scaling).
  let workArea = null;
  try { workArea = screen.getPrimaryDisplay().workAreaSize; } catch { /* the designed size */ }
  win = new BrowserWindow(Object.assign(status.windowSize(workArea), {
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
  }));
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
  const check = checkGame();
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
  reconnect.cancel();
  return m;
}

// Offline at start-up: the release is fetched again with growing waits, and
// when the player presses Retry; once it arrives the window shows it.
const reconnect = createReconnect(async () => {
  if (busy) return false;
  try {
    await latestManifest();
  } catch (e) {
    bootResult = { online: false, error: friendly(e, errorContext()) };
    log("reconnect", { error: e.message });
    return false;
  }
  try { await refreshPlan(); } catch (e) { log("plan", { code: e.code, error: e.message }); bootResult.error = friendly(e, errorContext()); }
  log("reconnect", { online: true, release: manifest.version });
  return true;
}, { onOnline: () => send("state-changed") });

// The start-up checks. They always finish the start-up screen, an error
// included (a settings file that can't be written, a game folder that
// can't be read), so it never hangs.
const bootProgress = (p, label) => send("boot-progress", { p, label });
function boot() {
  return status.finishBoot(bootChecks, bootProgress, (e) => {
    log("boot-error", { code: e.code, op: e.op, error: e.message });
    bootResult.error = friendly(e, errorContext());
    return "Couldn't finish the start-up checks: " + bootResult.error;
  });
}

async function bootChecks() {
  const progress = bootProgress;
  bootResult = { online: false, error: null };
  progress(0.08, "Checking game folder");
  if (!settings.gamePath) {
    // A Steam copy is used only if this launcher already manages it: a full
    // release would otherwise replace Steam's files (its Steam API among them).
    const steam = game.detect();
    const managed = steam && fs.existsSync(path.join(steam, sync.STATE_DIR));
    const gamePath = managed ? steam : game.defaultInstallDir();
    saveSettings({ gamePath });
  }
  try { sync.recover(settings.gamePath); } catch (e) { log("recover", { error: e.message }); }
  noteInstalled();
  progress(0.25, "Contacting xplab.shop");
  try {
    await latestManifest();
  } catch (e) {
    manifest = null;
    bootResult = { online: false, error: friendly(e, errorContext()) };
    log("manifest", { error: e.message });
  }
  // A newer launcher first: it may handle this release better than this one.
  if (manifest && await updateLauncher((done, total) =>
    progress(0.25 + 0.7 * done / total, `Updating the launcher to ${manifest.launcher.version} (${Math.floor(done / total * 100)}%)`))) {
    return status.HANDED_OFF;    // the setup takes over; this launcher is quitting
  }
  const installed = checkGame().ok;
  progress(0.45, installed ? "Verifying game files" : "Preparing install");
  try {
    await refreshPlan((done, total) => progress(0.45 + 0.5 * done / total, installed ? "Verifying game files" : "Preparing install"));
  } catch (e) {
    log("plan", { code: e.code, error: e.message });
    bootResult.error = friendly(e, errorContext());
  }
  // A game started before the launcher (or by a launcher that was closed):
  // PLAY shows it running instead of starting a second copy.
  game.isRunning().then((up) => { if (up && !gameWatch.running) watchGame({ alreadyRunning: true }); }, () => {});
  log("boot", { online: bootResult.online, release: manifest && manifest.version, installed: sync.installedVersion(settings.gamePath), todo: todo ? todo.length : null });
  if (!bootResult.online) reconnect.start();
  return status.bootLabel({ online: bootResult.online, check: checkGame(), todo, installed: sync.installedVersion(settings.gamePath), release: manifest && manifest.version });
}

// ---------------------------------------------------------------- launcher self-update

// Updates the launcher if the manifest offers a newer one: downloads and
// checks the setup, runs it and quits. Returns true when the setup is running.
// Only the installed (packaged) launcher updates itself; CULLING_SELFUPDATE=1
// allows it from a dev run, for testing.
async function updateLauncher(onProgress) {
  const allowed = app.isPackaged || process.env.CULLING_SELFUPDATE === "1";
  let plan;
  try { plan = selfupdate.decide(manifest, app.getVersion(), allowed); } catch (e) { log("launcher-update", { error: e.message }); return false; }
  const offer = plan.offer;
  if (!offer) {
    if (plan.cleanup) try { selfupdate.cleanup(UPDATES()); } catch { /* in use: next time */ }
    return false;
  }
  if (!selfupdate.mayTry(UPDATES(), offer.version)) {
    launcherUpdate = { version: offer.version, error: "Launcher " + offer.version + " didn't install. Download it from the website." };
    log("launcher-update", { version: offer.version, error: "tried " + selfupdate.MAX_TRIES + " times, giving up" });
    return false;
  }
  if (busy) return false;
  launcherUpdate = { version: offer.version, done: 0, total: offer.size };
  try {
    log("launcher-update", { from: app.getVersion(), to: offer.version, size: offer.size });
    const file = await selfupdate.download(manifest, UPDATES(), {
      fetchImpl: (url, init) => net.fetch(url, init),
      onProgress: (done, total) => {
        launcherUpdate.done = done;
        onProgress(done, total);
        // The main window too (it is already showing when the intro is off).
        send("sync-progress", { phase: "launcher", done, total, version: offer.version });
      }
    });
    selfupdate.recordTry(UPDATES(), offer.version);
    // Quits only once the setup is running: a setup Windows blocks (an
    // antivirus, AppLocker) leaves this launcher working, saying so.
    await selfupdate.install(file);
    log("launcher-update", { installing: offer.version });
    setTimeout(() => app.quit(), 300);
    return true;
  } catch (e) {
    log("launcher-update", { version: offer.version, op: e.op, code: e.code, error: e.message });
    launcherUpdate = { version: offer.version, error: friendly(e) };
    // The window drops its "Updating launcher" card.
    send("sync-progress", { phase: "launcher", version: offer.version, error: launcherUpdate.error });
    return false;
  }
}

// ---------------------------------------------------------------- state for the pages

function state() {
  const check = checkGame();
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
    // A Remaster account works unless the installed game uses a real Steam account.
    accountSupported: !check.ok || playername.supported(settings.gamePath),
    // The account signed in on the selected server: its username is the in-game name.
    account: (() => { const a = accounts.get(currentServer().id); return a ? { username: a.username } : null; })(),
    launcherUpdate,
    // The game is starting or running: PLAY shows "Running".
    gameRunning: gameWatch.running,
    busy
  };
}

function currentServer() {
  const servers = (manifest && manifest.servers && manifest.servers.length) ? manifest.servers : settings.servers;
  return servers.find((s) => s.id === settings.serverId) || servers[0] || config.DEFAULTS.servers[0];
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
      throw new Error(friendly(err, errorContext()));
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
    // Steam's own copy is refused, as at start-up, unless the launcher
    // already manages it: a release would replace Steam's files there.
    if (game.isSteamFolder(r.filePaths[0])) throw new Error(game.STEAM_FOLDER);
    const gamePath = game.installTarget(r.filePaths[0]);
    if (game.isSteamFolder(gamePath)) throw new Error(game.STEAM_FOLDER);
    saveSettings({ gamePath });
    await refreshPlan();
    return state();
  });

  handle("set-setting", (key, value) => {
    if (!["serverId", "closeOnLaunch", "playIntro", "parallel", "maxMBps"].includes(key)) throw new Error("not a user setting: " + key);
    saveSettings({ [key]: value });
    return state();
  });

  // Accounts. The password goes to the server and is dropped; the token is kept.
  handle("account-register", async (form) => {
    const f = form && typeof form === "object" ? form : {};
    if (String(f.password || "") !== String(f.confirm || "")) throw new Error("The passwords don't match");
    const server = currentServer();
    // Progress already on this server under this PC's Steam ID moves to the new account.
    const claimUserID = playername.readSteamId(settings.gamePath, app.getPath("appData"));
    const a = await accountApi.register(server.api, { username: f.username, email: f.email, password: f.password, claimUserID });
    accounts.set(server.id, a);
    log("account", { created: a.username, claimed: a.claimed });
    return Object.assign(state(), { claimed: a.claimed });
  });

  handle("account-login", async (form) => {
    const f = form && typeof form === "object" ? form : {};
    const server = currentServer();
    const a = await accountApi.login(server.api, { username: f.username, password: f.password });
    accounts.set(server.id, a);
    log("account", { signedIn: a.username });
    return state();
  });

  handle("account-logout", async () => {
    const server = currentServer();
    const a = accounts.get(server.id);
    accounts.remove(server.id);
    if (a) { try { await accountApi.logout(server.api, a.token); } catch (e) { log("account", { logout: e.message }); } }
    return state();
  });

  handle("check-updates", async () => {
    if (busy) throw new Error("Game Sync is running");
    await latestManifest();
    // A newer launcher installs right away (the launcher restarts).
    if (await updateLauncher(() => {})) {
      return Object.assign(state(), { restarting: true });
    }
    await refreshPlan((done, total) => send("sync-progress", { phase: "verify", done, total }));
    return state();
  });

  // Restores the version before the last update (its files are kept until the next one).
  handle("rollback", async () => {
    if (busy) throw new Error("Wait for Game Sync to finish");
    if (await game.isRunning()) throw new Error("Close The Culling first");
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
    const check = checkGame();
    if (!(check.ok || check.installable)) throw new Error(check.missing ? check.reason : check.reason + ": choose another folder in Settings");
    if (await game.isRunning()) throw new Error("Close The Culling first: its files can't be updated while it runs");
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
        if (p.phase === "download" && now - lastSent < 100 && p.doneBytes < p.totalBytes && !p.reconnecting && !p.lost) return;
        lastSent = now;
        send("sync-progress", p);
      }, {
        signal: syncAbort.signal,
        parallel: settings.parallel,
        maxBytesPerSec: settings.maxMBps * 1048576,
        log
      });
      log("synced", { version: manifest.version, files: r.files, bytes: r.bytes, seconds: r.seconds, retries: r.retries, kept: r.kept });
      noteInstalled();
      // The Repair report is read before the plan is cleared.
      const outcome = status.syncOutcome(r, todo, repair);
      todo = [];
      return Object.assign(state(), outcome);
    } catch (e) {
      if (!(e instanceof sync.SyncPaused)) {
        log("sync-error", { kind: e.kind, error: e.message });
        busy = false;
        try { await refreshPlan(); } catch { /* keep the error below */ }
        throw e;
      }
      log("paused", { lost: !!e.lost });
      busy = false;
      await refreshPlan();
      // A lost connection pauses too, and says so.
      return Object.assign(state(), { paused: true, lost: !!e.lost, message: e.lost ? e.message : null });
    } finally {
      busy = false;
      syncAbort = null;
    }
  });

  handle("ping-servers", async () => Promise.all(state().servers.map(ping)));

  // Retry next to "Offline": fetch the release now.
  handle("retry-connection", async () => {
    const reconnected = await reconnect.now();
    return Object.assign(state(), { reconnected });
  });

  handle("play", async () => {
    const check = checkGame();
    const server = currentServer();
    const signedIn = accounts.get(server.id);
    const why = status.playBlocker({
      // Started from here and not gone yet, or started some other way.
      running: gameWatch.running || await game.isRunning(),
      busy,
      check,
      installed: check.ok && !!sync.installedVersion(settings.gamePath),
      supported: check.ok && playername.supported(settings.gamePath),
      signedIn: !!signedIn
    });
    if (why) throw new Error(why);
    let grant;
    try {
      grant = await accountApi.play(server.api, signedIn.token);
    } catch (e) {
      if (e.code === "signed-out") { accounts.remove(server.id); send("state-changed"); }
      throw e;
    }
    try {
      playername.write(settings.gamePath, grant.username);
      playername.writeSteamId(settings.gamePath, grant.userID);
      // The player's own Func client, pointed at the chosen server.
      clientdll.ensure(game.win64(settings.gamePath), server.api);
    } catch (e) {
      // A locked file here is the game still running (lib/errors.js).
      throw Object.assign(e, { op: e.op || "play" });
    }
    await game.launch(settings.gamePath, app.getPath("logs"));
    const presence = watchGame();
    // With Discord presence on, "close on launch" hides the window and the
    // launcher leaves when the game does (the presence needs a process).
    if (settings.closeOnLaunch && !presence) setTimeout(() => app.quit(), 1500);
    else if (settings.closeOnLaunch) win.hide();
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

// The game while it runs: PLAY shows "Running" and can't start a second
// copy, and Discord shows the presence (lib/discord.js). The game takes a
// while to start after its launcher; it counts as closed once it was seen and
// is gone, or never appeared within GAME_START_MS (lib/status.js).
const GAME_POLL_MS = 10000, GAME_START_MS = 3 * 60 * 1000;
let presence = null;
const gameWatch = status.createGameWatch({
  isRunning: () => game.isRunning(),
  pollMs: GAME_POLL_MS,
  startMs: GAME_START_MS,
  onChange: () => send("state-changed"),
  onExit: () => {
    if (presence) presence.stop();
    if (settings.closeOnLaunch && win && !win.isVisible()) setTimeout(() => app.quit(), 500);
  }
});
// Returns false when there is no Discord application to show.
function watchGame(opts) {
  gameWatch.start(opts);
  if (!discord.APP_ID) return false;
  if (!presence) presence = discord.createPresence({ links: settings.links, log });
  presence.start();
  return true;
}

// ---------------------------------------------------------------- app

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => { if (win) { if (!win.isVisible()) win.show(); if (win.isMinimized()) win.restore(); win.focus(); } });
  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    // Chromium's network stack: the system proxy and the Windows certificate store.
    sync.useFetch((url, init) => net.fetch(url, init));
    log = createLog(app.getPath("logs"));
    settings = config.load(SETTINGS());
    accounts = account.createStore(path.join(app.getPath("userData"), "account.dat"), safeStorage);
    accountApi = account.createClient((url, init) => net.fetch(url, init));
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
