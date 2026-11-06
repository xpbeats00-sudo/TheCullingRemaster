// Night maps and weather (patch/make_weather.py, patch/weather.c).
//
// Off by default: the stock maps play as before, with the stock answers
// ("offline:<map>", "duo:<map>"). Settings (environment):
//   CULLING_NIGHT_MAPS=1     offer Jungle Night and Prison Night in the map vote
//   CULLING_WEATHER_DAY=1    weather over the match on Jungle and Prison too
//   CULLING_WEATHER_PRESETS  presets to draw from (default: all), comma separated
// A night match (and a day match with CULLING_WEATHER_DAY) gets a preset and
// a seed; the answer is "map:<solo|duo>:<map index>[?TeamSize=<n>]?Weather=<preset>?WeatherSeed=<n>",
// which ClientWeb.js opens with StartTraining(url) and the patched exe's
// weather module reads from the URL. The weather is a pure function of the
// seed, so a future host could send the same seed to every player.
"use strict";

const crypto = require("crypto");

const PRESETS = ["clear", "cloudy", "rainy", "storm", "foggy"];
const DAY_MAPS = { jungle: 0, prison: 1 };
const NIGHT_MAPS = { "jungle-night": 2, "prison-night": 3 };
// Contestants each map places (the night maps are copies of the day ones):
// one per pod. Jungle and Prison have 16 pods (PlayerStarts tagged
// SpawnsDecentral; Jungle's 8 others are Showdown's arena), and the patched
// exe's module spawns no more than that (showdown_rounds.c sd_spawn_bots;
// 1.3.11 put 24 in Jungle's 16 pods, so 8 shared one).
const FIELD = { jungle: 16, prison: 16, "jungle-night": 16, "prison-night": 16 };

function settings(env) {
  env = env || process.env;
  const listed = String(env.CULLING_WEATHER_PRESETS || "").split(",").map((s) => s.trim().toLowerCase())
    .filter((s) => PRESETS.includes(s));
  return {
    night: env.CULLING_NIGHT_MAPS === "1",
    day: env.CULLING_WEATHER_DAY === "1",
    presets: listed.length ? listed : PRESETS.slice()
  };
}

// Map name -> index of every map offered.
function maps(cfg) {
  return Object.assign({}, DAY_MAPS, cfg.night ? NIGHT_MAPS : {});
}

function fieldByMap(cfg) {
  const out = {};
  for (const m of Object.keys(maps(cfg))) out[m] = FIELD[m];
  return out;
}

function isNight(map) {
  return Object.prototype.hasOwnProperty.call(NIGHT_MAPS, map);
}

// The weather of a new match on `map`, or null (no weather).
function weatherFor(cfg, map, random) {
  if (!(isNight(map) && cfg.night) && !(cfg.day && Object.prototype.hasOwnProperty.call(DAY_MAPS, map))) return null;
  const r = random || ((n) => crypto.randomInt(n));
  return { preset: cfg.presets[r(cfg.presets.length)], seed: 1 + r(0x7ffffffe) };
}

// The match-ready answer for a Solo or team match. `team`: null/false (Solo),
// true (Duo), or server.js's TEAM_MODES entry ({ size, start }: Duo, Trios,
// Quads). A team match by URL is the pairs mode with ?TeamSize=<n> for teams
// larger than two (patch_exe.py fix 9), as "trio:"/"quad:" open it.
function gameServer(cfg, map, team, weather) {
  const all = maps(cfg);
  const index = Object.prototype.hasOwnProperty.call(all, map) ? all[map] : 0;
  const size = team === true ? 2 : team && team.size ? team.size : 0;
  const start = team === true ? "duo:" : team && team.start ? team.start : "offline:";
  if (!weather && index < 2) return start + index;
  let s = "map:" + (size ? "duo" : "solo") + ":" + index;
  if (size > 2) s += "?TeamSize=" + size;
  if (weather) s += "?Weather=" + weather.preset + "?WeatherSeed=" + weather.seed;
  return s;
}

module.exports = { PRESETS, DAY_MAPS, NIGHT_MAPS, FIELD, settings, maps, fieldByMap, isNight, weatherFor, gameServer };
