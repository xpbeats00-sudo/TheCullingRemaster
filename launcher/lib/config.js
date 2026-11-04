// Launcher settings, kept as JSON in the app's user-data folder.
"use strict";

const fs = require("fs");
const path = require("path");

const DEFAULTS = {
  gamePath: "",
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
    if (Array.isArray(def)) out[k] = Array.isArray(v) && v.every(validServer) ? v : def;
    // Links come with the launcher, not from saved settings (a new link reaches everyone).
    else if (k === "links") out[k] = def;
    else if (CHOICES[k]) out[k] = CHOICES[k].includes(v) ? v : def;
    else out[k] = typeof v === typeof def ? v : def;
  }
  return out;
}

function validServer(s) {
  return s && typeof s.id === "string" && typeof s.name === "string" && typeof s.api === "string";
}

function save(file, c) {
  const clean = sanitize(c);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, file);
  return clean;
}

module.exports = { load, save, sanitize, DEFAULTS, CHOICES };
