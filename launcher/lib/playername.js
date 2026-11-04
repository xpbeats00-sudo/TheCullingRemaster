// The player's in-game name.
//
// The game's Steam layer (Engine\Binaries\ThirdParty\Steamworks\<version>\
// Win64) reads its account name from steam_settings\force_account_name.txt,
// which is the name shown in game. The launcher writes the name chosen
// before PLAY there. On an install without that settings folder (a real Steam
// copy), the Steam name is used and can't be changed here.
"use strict";

const fs = require("fs");
const path = require("path");

const MAX = 32;                                  // Steam's limit for a name
const FILE = "force_account_name.txt";

// A clean name, or an error saying what's wrong with it.
function validate(raw) {
  const name = String(raw == null ? "" : raw).normalize("NFC").replace(/\s+/g, " ").trim();
  if (!name) return { error: "Enter a name" };
  if ([...name].length > MAX) return { error: `Names are at most ${MAX} characters` };
  if (!/^[\p{L}\p{N} _.\-[\]()!?'#]+$/u.test(name)) {
    return { error: "Use letters, numbers, spaces and _ . - [ ] ( ) ! ? ' #" };
  }
  return { name };
}

// steam_settings folders of the game's Steam layer.
function settingsDirs(root) {
  const base = path.join(root, "Engine", "Binaries", "ThirdParty", "Steamworks");
  let versions = [];
  try { versions = fs.readdirSync(base); } catch { return []; }
  return versions.map((v) => path.join(base, v, "Win64", "steam_settings")).filter((d) => fs.existsSync(d));
}

const supported = (root) => !!root && settingsDirs(root).length > 0;

function read(root) {
  for (const dir of settingsDirs(root)) {
    try {
      const v = validate(fs.readFileSync(path.join(dir, FILE), "utf8").replace(/^﻿/, ""));
      if (v.name) return v.name;
    } catch { /* not set */ }
  }
  return "";
}

// Writes the name for the game; returns it (cleaned). Throws on a bad name or
// an install without the settings folder.
function write(root, raw) {
  const v = validate(raw);
  if (v.error) throw new Error(v.error);
  const dirs = settingsDirs(root);
  if (!dirs.length) throw new Error("This install uses your Steam name");
  for (const dir of dirs) {
    const file = path.join(dir, FILE);
    fs.writeFileSync(file + ".tmp", v.name, "utf8");
    fs.renameSync(file + ".tmp", file);
  }
  return v.name;
}

// The Steam ID the game logs in with. A Remaster account has its own; the
// launcher writes it to force_steamid.txt before PLAY. Without that file the
// Steam layer uses the PC-wide ID in %APPDATA%\Goldberg SteamEmu Saves.
const ID_FILE = "force_steamid.txt";
const STEAM_ID = /^7656\d{13}$/;              // 76561197960265728 + a 32-bit account number

// The ID this install plays as now ("steam:<id>"), or null. appData is
// %APPDATA%, for the PC-wide fallback.
function readSteamId(root, appData) {
  const candidates = settingsDirs(root).map((d) => path.join(d, ID_FILE));
  if (appData) candidates.push(path.join(appData, "Goldberg SteamEmu Saves", "settings", "user_steam_id.txt"));
  for (const file of candidates) {
    try {
      const id = fs.readFileSync(file, "utf8").replace(/^﻿/, "").trim();
      if (STEAM_ID.test(id)) return "steam:" + id;
    } catch { /* not set */ }
  }
  return null;
}

// Makes the game log in as `userID` ("steam:<id>"). A different ID already
// there is kept once as force_steamid.txt.before-account.
function writeSteamId(root, userID) {
  const id = String(userID || "").replace(/^steam:/, "");
  if (!STEAM_ID.test(id)) throw new Error("not a Steam ID: " + userID);
  const dirs = settingsDirs(root);
  if (!dirs.length) throw new Error("This install uses your Steam account, so it can't use a Remaster account. Choose an install made by the launcher in Settings");
  for (const dir of dirs) {
    const file = path.join(dir, ID_FILE);
    let old = null;
    try { old = fs.readFileSync(file, "utf8").trim(); } catch { /* none */ }
    if (old === id) continue;
    if (old && !fs.existsSync(file + ".before-account")) fs.copyFileSync(file, file + ".before-account");
    fs.writeFileSync(file + ".tmp", id, "utf8");
    fs.renameSync(file + ".tmp", file);
  }
}

module.exports = { validate, supported, read, write, readSteamId, writeSteamId, MAX };
