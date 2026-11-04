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
  links: { website: "https://xplab.shop/", discord: "", support: "https://xplab.shop/faq.html" },
  closeOnLaunch: false,
  // The in-game name chosen before PLAY (lib/playername.js writes it into the game).
  playerName: "",
  playIntro: true
};

function load(file) {
  let saved = {};
  try { saved = JSON.parse(fs.readFileSync(file, "utf8")); } catch { /* first run or unreadable */ }
  return sanitize(Object.assign({}, DEFAULTS, saved));
}

// Keep only known keys with the right types; anything else falls back.
function sanitize(c) {
  const out = {};
  for (const [k, def] of Object.entries(DEFAULTS)) {
    const v = c[k];
    if (Array.isArray(def)) out[k] = Array.isArray(v) && v.every(validServer) ? v : def;
    else if (k === "links") out[k] = validLinks(v) ? v : def;
    else out[k] = typeof v === typeof def ? v : def;
  }
  return out;
}

function validServer(s) {
  return s && typeof s.id === "string" && typeof s.name === "string" && typeof s.api === "string";
}

// Only https links (or empty, for hidden).
function validLinks(l) {
  return l && typeof l === "object" &&
    Object.values(l).every((u) => u === "" || (typeof u === "string" && u.startsWith("https://")));
}

function save(file, c) {
  const clean = sanitize(c);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, file);
  return clean;
}

module.exports = { load, save, sanitize, DEFAULTS };
