// Finding, checking, installing to and starting a The Culling install.
//
// The game root is the folder holding "Victory" (Steam's TheCulling folder, or
// the folder Game Sync installs the whole game into). The Remaster runs through
// the Func launcher with the patched client DLL.
"use strict";

const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const WIN64 = ["Victory", "Binaries", "Win64"];
const GAME_EXE = "Victory.exe";
const FUNC_LAUNCHER = "Func.Launcher.exe";
const CLIENT_DLL = "Func.Client.Local.dll";
const APP_ID = "437220";
const INSTALL_NAME = "The Culling Remaster";
const STATE_DIR = ".remaster";              // Game Sync's state, inside a game folder it manages

function win64(root) { return path.join(root, ...WIN64); }

// Where a fresh install goes by default: per user, no admin rights needed.
function defaultInstallDir() {
  const base = process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local");
  return path.join(base, "Programs", INSTALL_NAME);
}

// ok: the game is there. installable: nothing is there yet (missing or empty
// folder, or a partial install Game Sync started), so Game Sync can install
// the whole game into it.
function check(root) {
  if (!root) return { ok: false, installable: false, reason: "No game folder chosen" };
  if (fs.existsSync(path.join(win64(root), GAME_EXE))) {
    return {
      ok: true,
      funcLauncher: fs.existsSync(path.join(win64(root), FUNC_LAUNCHER)),
      clientDll: fs.existsSync(path.join(win64(root), CLIENT_DLL))
    };
  }
  let entries = null;
  try { entries = fs.readdirSync(root); } catch { /* missing: installable */ }
  if (!entries || entries.length === 0 || entries.includes(STATE_DIR)) {
    return { ok: false, installable: true, reason: "The game isn't installed yet" };
  }
  return { ok: false, installable: false, reason: "This folder isn't empty and isn't a The Culling install" };
}

// The install folder for a folder the player picked: the game itself, or an
// empty folder, as is; otherwise a "The Culling Remaster" folder inside it.
function installTarget(picked) {
  if (check(picked).ok || check(picked).installable) return picked;
  const inside = path.join(picked, INSTALL_NAME);
  const c = check(inside);
  if (c.ok || c.installable) return inside;
  throw new Error(c.reason);
}

// Steam's install folder: the registry first, then the usual places.
function steamRoots() {
  const roots = [];
  if (process.platform === "win32") {
    for (const [key, value] of [["HKCU\\Software\\Valve\\Steam", "SteamPath"],
                                ["HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam", "InstallPath"]]) {
      try {
        const out = execFileSync("reg", ["query", key, "/v", value], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
        const m = out.match(/REG_SZ\s+(.+)/);
        if (m) roots.push(path.normalize(m[1].trim()));
      } catch { /* key missing */ }
    }
  }
  roots.push("C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam");
  return uniquePaths(roots);
}

// Windows paths compare without case or trailing separators.
function uniquePaths(list) {
  const seen = new Map();
  for (const p of list) {
    const key = path.normalize(p).replace(/[\\/]+$/, "").toLowerCase();
    if (!seen.has(key)) seen.set(key, path.normalize(p));
  }
  return [...seen.values()];
}

// Steam library folders, from each Steam install's libraryfolders.vdf.
function steamLibraries(roots = steamRoots()) {
  const libs = [];
  for (const steam of roots) {
    const vdf = path.join(steam, "steamapps", "libraryfolders.vdf");
    if (!fs.existsSync(vdf)) continue;
    libs.push(steam);
    // vdf strings escape backslashes ("D:\\SteamLibrary")
    for (const m of fs.readFileSync(vdf, "utf8").matchAll(/"path"\s+"([^"]+)"/g)) libs.push(path.normalize(m[1].replace(/\\\\/g, "\\")));
  }
  return uniquePaths(libs);
}

// The Culling's folder: Steam's manifest for app 437220 names it; the usual
// folder names are the fallback.
function detect(libraries = steamLibraries()) {
  for (const lib of libraries) {
    const names = ["TheCulling", "The Culling"];
    const acf = path.join(lib, "steamapps", "appmanifest_" + APP_ID + ".acf");
    if (fs.existsSync(acf)) {
      const m = fs.readFileSync(acf, "utf8").match(/"installdir"\s+"([^"]+)"/);
      if (m) names.unshift(m[1]);
    }
    for (const name of names) {
      const root = path.join(lib, "steamapps", "common", name);
      if (check(root).ok) return root;
    }
  }
  return null;
}

// Start the game; resolves once the Func launcher process has spawned.
function launch(root, logDir) {
  const status = check(root);
  if (!status.ok) return Promise.reject(new Error(status.reason));
  if (!status.funcLauncher) return Promise.reject(new Error("Func launcher not found in the game folder"));
  if (!status.clientDll) return Promise.reject(new Error("The Remaster client isn't set up (Func.Client.Local.dll)"));
  const dir = win64(root);
  const args = ["-FuncSkipUpdateCheck", "-FuncClientDll=" + path.join(dir, CLIENT_DLL)];
  if (logDir) args.push("-FuncClientLog=" + path.join(logDir, "Func.Client.log"));
  return new Promise((resolve, reject) => {
    const child = spawn(path.join(dir, FUNC_LAUNCHER), args, {
      cwd: dir,
      detached: true,
      stdio: "ignore",
      env: Object.assign({}, process.env, { FUNC_CLIENT_DISABLE_PAK_MOUNT: "1" })
    });
    child.once("error", reject);
    child.once("spawn", () => { child.unref(); resolve(); });
  });
}

module.exports = { check, detect, launch, steamLibraries, win64, defaultInstallDir, installTarget, INSTALL_NAME };
