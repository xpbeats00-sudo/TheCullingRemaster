// Night maps and weather (server/weather.js): off by default (the stock
// answers, two maps in the vote); with CULLING_NIGHT_MAPS=1 the vote offers
// Jungle Night and Prison Night, whose match-ready carries the map's URL
// index, a weather preset and a seed; CULLING_WEATHER_DAY=1 adds weather to
// the day maps; CULLING_WEATHER_PRESETS limits the presets.
"use strict";

const assert = require("assert");
const weather = require("../weather");
const { startServer, next } = require("./helpers");

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log("ok    " + name); }

const ANSWER = /^map:(solo|duo):([0-3])\?Weather=(clear|cloudy|rainy|storm|foggy)\?WeatherSeed=([1-9][0-9]*)$/;

async function play(srv, id, queue) {
  const s = await srv.connect(await srv.login(id));
  const lobby = next(s, "remaster-lobby");
  s.emit("join-mm", { queueName: queue });
  const view = await lobby;
  const ready = await next(s, "match-ready");
  s.close();
  return { view, ready };
}

(async () => {
  await test("settings: off by default; presets filtered", async () => {
    const off = weather.settings({});
    assert.deepStrictEqual(weather.maps(off), { jungle: 0, prison: 1 });
    assert.strictEqual(weather.weatherFor(off, "jungle"), null);
    assert.strictEqual(weather.weatherFor(off, "jungle-night"), null, "night maps need the setting");
    const on = weather.settings({ CULLING_NIGHT_MAPS: "1", CULLING_WEATHER_PRESETS: "storm, bogus,FOGGY" });
    assert.deepStrictEqual(on.presets, ["storm", "foggy"]);
    assert.deepStrictEqual(weather.maps(on), { jungle: 0, prison: 1, "jungle-night": 2, "prison-night": 3 });
    assert.deepStrictEqual(weather.fieldByMap(on), { jungle: 24, prison: 16, "jungle-night": 24, "prison-night": 16 });
  });

  await test("answers: stock forms without weather, map: URLs with it", async () => {
    const on = weather.settings({ CULLING_NIGHT_MAPS: "1" });
    assert.strictEqual(weather.gameServer(on, "jungle", false, null), "offline:0");
    assert.strictEqual(weather.gameServer(on, "prison", true, null), "duo:1");
    const w = weather.weatherFor(on, "prison-night", (n) => n - 1);
    assert.deepStrictEqual(w, { preset: "foggy", seed: 0x7ffffffe });
    assert.strictEqual(weather.gameServer(on, "prison-night", true, w), "map:duo:3?Weather=foggy?WeatherSeed=2147483646");
    assert.strictEqual(weather.gameServer(on, "jungle-night", false, { preset: "clear", seed: 1 }),
      "map:solo:2?Weather=clear?WeatherSeed=1");
    // Trios and Quads (server.js TEAM_MODES): their own stock answers, and the
    // pairs mode by URL with ?TeamSize= when the match has weather.
    assert.strictEqual(weather.gameServer(on, "jungle", { size: 3, start: "trio:" }, null), "trio:0");
    assert.strictEqual(weather.gameServer(on, "prison", { size: 4, start: "quad:" }, null), "quad:1");
    assert.strictEqual(weather.gameServer(on, "jungle-night", { size: 3, start: "trio:" }, { preset: "storm", seed: 7 }),
      "map:duo:2?TeamSize=3?Weather=storm?WeatherSeed=7");
    assert.strictEqual(weather.gameServer(on, "prison-night", { size: 2, start: "duo:" }, { preset: "clear", seed: 1 }),
      "map:duo:3?Weather=clear?WeatherSeed=1");
    assert.strictEqual(weather.weatherFor(on, "jungle"), null, "day weather needs its own setting");
    const day = weather.settings({ CULLING_WEATHER_DAY: "1" });
    assert.ok(weather.weatherFor(day, "jungle"));
    assert.strictEqual(weather.weatherFor(day, "jungle-night"), null, "night maps off");
    for (let i = 0; i < 200; i++) {
      const x = weather.weatherFor(on, "jungle-night");
      assert.ok(weather.PRESETS.includes(x.preset) && x.seed >= 1 && x.seed <= 0x7ffffffe);
    }
  });

  const off = startServer(8171);
  try {
    await off.ready();
    await test("a default server: two maps in the vote, the stock answer", async () => {
      const { view, ready } = await play(off, "steam:76561190000000901", "ffa_jungle-night");
      assert.deepStrictEqual(Object.keys(view.maps || {}).sort(), ["jungle", "prison"]);
      assert.strictEqual(ready.gameServer, "offline:0", "a night queue name falls back to the day map");
    });
  } finally { off.stop(); }

  const on = startServer(8172, { vars: { CULLING_NIGHT_MAPS: "1" } });
  try {
    await on.ready();
    await test("night maps on: four maps in the vote; Jungle Night opens by URL with weather", async () => {
      const { view, ready } = await play(on, "steam:76561190000000902", "ffa_jungle-night");
      assert.deepStrictEqual(Object.keys(view.maps).sort(), ["jungle", "jungle-night", "prison", "prison-night"]);
      assert.strictEqual(view.matchBotsByMap["jungle-night"], 23);
      const m = ANSWER.exec(ready.gameServer);
      assert.ok(m, ready.gameServer);
      assert.strictEqual(m[1], "solo");
      assert.strictEqual(m[2], "2");
    });
    await test("Duo on Prison Night", async () => {
      const { ready } = await play(on, "steam:76561190000000903", "ffa_prison-night_coop2");
      const m = ANSWER.exec(ready.gameServer);
      assert.ok(m, ready.gameServer);
      assert.strictEqual(m[1], "duo");
      assert.strictEqual(m[2], "3");
    });
    await test("Quads on Jungle Night: the pairs mode by URL with ?TeamSize=4 and weather", async () => {
      const { ready } = await play(on, "steam:76561190000000906", "ffa_jungle-night_coop4");
      const m = /^map:duo:2\?TeamSize=4\?Weather=(clear|cloudy|rainy|storm|foggy)\?WeatherSeed=[1-9][0-9]*$/.exec(ready.gameServer);
      assert.ok(m, ready.gameServer);
    });
    await test("the day maps keep the stock answer (no day weather)", async () => {
      const { ready } = await play(on, "steam:76561190000000904", "ffa_prison");
      assert.strictEqual(ready.gameServer, "offline:1");
    });
  } finally { on.stop(); }

  const day = startServer(8173, { vars: { CULLING_WEATHER_DAY: "1", CULLING_WEATHER_PRESETS: "rainy" } });
  try {
    await day.ready();
    await test("day weather on: the day map opens by URL with the listed preset", async () => {
      const { ready } = await play(day, "steam:76561190000000905", "ffa_jungle");
      const m = ANSWER.exec(ready.gameServer);
      assert.ok(m && m[1] === "solo" && m[2] === "0" && m[3] === "rainy", ready.gameServer);
    });
  } finally { day.stop(); }

  console.log("all %d weather tests passed", passed);
})().catch((e) => { console.error("FAIL", e.stack || e.message); process.exitCode = 1; });
