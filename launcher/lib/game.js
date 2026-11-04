// Finding, checking and starting a The Culling install.
//
// The game root is the folder holding "Victory" (Steam's TheCulling folder).
// The Remaster runs through the Func launcher with the patched client DLL that
// Game Sync installs, exactly like "Play The Culling (local).bat".
"use strict";

const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const WIN64 = ["Victory", "Binaries", "Win64"];
const GAME_EXE = "Victory.exe";
const FUNC_LAUNCHER = "Func.Launcher.exe";
const CLIENT_DLL = "Func.Client.Local.dll";

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

// Steam library folders, from Steam's libraryfolders.vdf.
function steamLibraries() {
  const roots = [];
  for (const steam of ["C:\\Program Files (x86)\\Steam", "C:\\Program Files\\Steam"]) {
    const vdf = path.join(steam, "steamapps", "libraryfolders.vdf");
    if (!fs.existsSync(vdf)) continue;
    roots.push(steam);
    for (const m of fs.readFileSync(vdf, "utf8").matchAll(/"path"\s+"([^"]+)"/g)) roots.push(m[1].replace(/\\\\/g, "\\"));
  }
  return [...new Set(roots)];
}

function detect() {
  for (const lib of steamLibraries()) {
    for (const name of ["TheCulling", "The Culling"]) {
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
  if (!status.clientDll) return Promise.reject(new Error("Remaster files missing: run Game Sync first"));
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

module.exports = { check, detect, launch, steamLibraries };
