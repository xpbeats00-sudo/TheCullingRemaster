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

module.exports = { validate, supported, read, write, MAX };
