// CUSTOM matches (patch/custom_match.py): a private lobby with one member, the
// map and the stock custom-match settings, played on the player's PC.
//
// The menu sends the settings by their CUSTOM MATCH SETTINGS names
// (lobby-set-mods); START is answered with "custom:<map>:<mods>", where <mods>
// is the stock "?mods=" grammar ("<index>=<value>|...", the settings that
// differ from stock, in index order) that ClientWeb.js turns into the match URL.
// A copy of custom_match.MODS; patch/test_custom_match.py checks they match.
"use strict";

// EGameModeMod index -> [key, stock value, min, max]
const MODS = [
  ["NumGreenCrateSpawn", 12, 0, 200],
  ["NumBlueCrateSpawn", 24, 0, 200],
  ["NumRedCrateSpawn", 3, 0, 200],
  ["NumRedBarrelSpawn", 15, 0, 200],
  ["NumGasPylonSpawn", 22, 0, 200],
  ["NumFuncBarrelSpawn", 15, 0, 200],
  ["NumToiletGoodiesSpawn", 5, 0, 200],
  ["NumSmallBuildingItemSpawn", 2, 0, 200],
  ["NumMediumBuildingItemSpawn", 4, 0, 200],
  ["NumLargeBuildingItemSpawn", 8, 0, 200],
  ["NumExtraLargeBuildingItemSpawn", 12, 0, 200],
  ["ChancesExtraGreenCrateSpawn", 50, 0, 100],
  ["ChancesLockerPreOpened", 50, 0, 100],
  ["HealthGivenFromHealthStation", 4, 0, 100],
  ["FuncCostForHealth", 1, 0, 100],
  ["FreqHealthGivenInSeconds", 1, 1, 60],
  ["RecyclerUseTime", 5, 1, 60]
];

// The stock CUSTOM screen's maps (Custom.js availableMaps) -> map index.
const MAP_NAMES = { "Jungle/Jungle_P": 0, "Jungle2/Jungle2_P": 1 };
const MAP_KEYS = ["jungle", "prison"];
const DEFAULT_MAP = "Jungle/Jungle_P";

// What a player sees when they try to join someone's custom lobby.
const JOIN_REFUSED = "Custom matches are played on your PC; invite friends to a party instead.";

function defaults() {
  const out = {};
  for (const [key, value] of MODS) out[key] = value;
  return out;
}

// One of the stock map names, or `fallback`.
function mapName(raw, fallback = DEFAULT_MAP) {
  return typeof raw === "string" && Object.prototype.hasOwnProperty.call(MAP_NAMES, raw) ? raw : fallback;
}

function mapIndex(name) {
  return Object.prototype.hasOwnProperty.call(MAP_NAMES, name) ? MAP_NAMES[name] : 0;
}

// The lobby's settings after a lobby-set-mods: `previous` with every known key
// of `input` that is a whole number, kept within its bounds. Unknown keys and
// anything else are ignored; at most MODS.length keys are looked at.
function cleanMods(input, previous = defaults()) {
  const out = Object.assign(defaults(), previous);
  if (!input || typeof input !== "object" || Array.isArray(input)) return out;
  for (const [key, , min, max] of MODS) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    const raw = input[key];
    const v = typeof raw === "number" ? raw : typeof raw === "string" && /^-?\d{1,6}$/.test(raw) ? Number(raw) : NaN;
    if (!Number.isInteger(v)) continue;
    out[key] = Math.min(max, Math.max(min, v));
  }
  return out;
}

// "<index>=<value>|...": the settings that differ from stock, in index order.
function encode(mods) {
  const clean = cleanMods(mods, defaults());
  const out = [];
  MODS.forEach(([key, def], i) => { if (clean[key] !== def) out.push(i + "=" + clean[key]); });
  return out.join("|");
}

function gameServer(name, mods) {
  return "custom:" + mapIndex(name) + ":" + encode(mods);
}

module.exports = { MODS, MAP_NAMES, MAP_KEYS, DEFAULT_MAP, JOIN_REFUSED, defaults, mapName, mapIndex, cleanMods, encode, gameServer };
