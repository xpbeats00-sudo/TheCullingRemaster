// Launcher settings, kept as JSON in the app's user-data folder.
"use strict";

const fs = require("fs");
const path = require("path");
const localhttp = require("./localhttp");

const DEFAULTS = {
  gamePath: "",
  // The folder the launcher last saw a finished install in: if it vanishes
  // (an unplugged drive, a deleted folder), it reads as missing, not as a
  // place to install into.
  installedPath: "",
  // Release manifest (Game Sync / Update) and the fallback server list.
  manifestUrl: "https://xplab.shop:8443/remaster/manifest.json",
  servers: [{ id: "xplab", name: "The Culling Remaster", region: "USA",
    api: "https://xplab.shop:8443/api", status: "https://xplab.shop:8443/health" }],
  serverId: "xplab",
  // Footer links; an empty one is hidden.
  links: { website: "https://xplab.shop/", discord: "https://discord.com/invite/tson", support: "https://xplab.shop/faq.html" },
  closeOnLaunch: false,
  // The in-game name chosen before PLAY (lib/playername.js writes it into the game).
  playerName: "",
  playIntro: true,
  // Downloads at once (16 measured best against the VPS) and a speed limit in
  // MB/s (0: none), so a download doesn't have to take the whole connection.
  parallel: 16,
  maxMBps: 0
};
const CHOICES = { parallel: [2, 4, 8, 16], maxMBps: [0, 1, 2, 4, 8, 16] };

function load(file) {
  let saved = {};
  // A byte-order mark (Notepad, PowerShell) would otherwise make the file
  // unreadable and reset every setting.
  try { saved = JSON.parse(fs.readFileSync(file, "utf8").replace(/^﻿/, "")); } catch { /* first run or unreadable */ }
  return sanitize(Object.assign({}, DEFAULTS, saved));
}

// Keep only known keys with the right types; anything else falls back.
function sanitize(c) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = c[k];
    // A list the launcher can work with: at least one server, each with an
    // id, a name and web addresses (an empty list leaves nothing to sign in
    // to or play on).
    if (k === "servers") out[k] = Array.isArray(v) && v.length > 0 && v.every(validServer) ? v : def;
    // Links come with the launcher, not from saved settings (a new link reaches everyone).
    else if (k === "links") out[k] = def;
    else if (k === "manifestUrl") out[k] = validUrl(v) ? v : def;
    else if (CHOICES[k]) out[k] = CHOICES[k].includes(v) ? v : def;
    else out[k] = typeof v === typeof def ? v : def;
  }
  return out;
}

// An https address (plain http only on this PC, for testing, in a dev run:
// lib/localhttp.js), as Game Sync and the account client require.
function validUrl(u) {
  if (typeof u !== "string") return false;
  try {
    return localhttp.ok(new URL(u));
  } catch {
    return false;
  }
}

function validServer(s) {
  return !!s && typeof s === "object" && typeof s.id === "string" && s.id !== "" && typeof s.name === "string" &&
    validUrl(s.api) && (s.status === undefined || validUrl(s.status));
}

function save(file, c) {
  const clean = sanitize(c);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, file);
  return clean;
}

module.exports = { load, save, sanitize, validUrl, DEFAULTS, CHOICES };
