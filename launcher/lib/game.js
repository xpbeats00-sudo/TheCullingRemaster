// Finding, checking and starting a The Culling install.
//
// The game root is the folder holding "Victory" (Steam's TheCulling folder).
// The Remaster runs through the Func launcher with the patched client DLL that
// Game Sync installs, exactly like "Play The Culling (local).bat".
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn, execFileSync } = require("child_process");

const WIN64 = ["Victory", "Binaries", "Win64"];
const GAME_EXE = "Victory.exe";
const FUNC_LAUNCHER = "Func.Launcher.exe";
const CLIENT_DLL = "Func.Client.Local.dll";
const APP_ID = "437220";

function win64(root) { return path.join(root, ...WIN64); }

function check(root) {
  if (!root) return { ok: false, reason: "No game folder chosen" };
  if (!fs.existsSync(path.join(win64(root), GAME_EXE))) {
    return { ok: false, reason: "Not a The Culling install (Victory\\Binaries\\Win64\\Victory.exe is missing)" };
  }
  return {
    ok: true,
    funcLauncher: fs.existsSync(path.join(win64(root), FUNC_LAUNCHER)),
    clientDll: fs.existsSync(path.join(win64(root), CLIENT_DLL))
  };
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

module.exports = { check, detect, launch, steamLibraries, win64 };
