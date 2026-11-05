# Night maps and weather: design and status

Branch `weather-night`. This adds night versions of both match maps, rain, and weather that changes during a match. It works on the cooked UE 4.15.3 game without the editor: only property values, copies of stock assets and the patched exe's native module are changed. No shader or material is new or edited.

Status words: **PASS** (seen working in game), **PARTIAL** (some of it seen working), **NOT TESTED** (statically verified, not yet run in game), **BLOCKED** (cannot be done this way), **FAIL**.

## Summary

| Piece | What it is | Status |
|---|---|---|
| Jungle Night look | `Lighting_Night` copy of Jungle's Lighting level | **PASS** (look only). Seen in a real match through `test_override.pak`: a dark, cloudy night sky, moonlit trees, the sky board working, no errors. Fog distance, readability and FPS are **NOT TESTED**. |
| Prison Night (storm) look | `Lighting_Night` copy of Prison's Lighting level | **PASS**. Chosen from the menu vote in a real Solo match (local server, `CULLING_NIGHT_MAPS=1`, branch audit-combined 7a5c8d8): storm sky, moon behind clouds, surroundings readable, sky board fine. |
| Night maps as their own maps | `Jungle_Night_P`, `Jungle2_Night_P`, opened by URL | **PARTIAL**. `Jungle2_Night_P` opened by URL from the vote and played (PASS); `Jungle_Night_P` by URL is NOT TESTED. |
| Map choice | Server setting, `map:` answers, ClientWeb URLs, vote cards | **PARTIAL**: Prison Night from the vote PASS; Jungle Night and Duo NOT TESTED. Server tests PASS. |
| Rain particles | `P_Rain_{Light,Heavy,Storm}` (GPU streaks) | **PARTIAL**. Streaks visible in game on Prison Night. Bug: indoors (the Prison mess hall's glass roof) the camera-attached rain fell inside, because its GPU collision only sees the depth buffer. Fixed by the shelter check (below): **NOT TESTED** in game. |
| Weather over a match | `weather.c` in the native module | **FAIL, then fixed (NOT TESTED in game)**. The first combined build (PATCHED_SHA256 `e02e5f98…`) crashed 3–4 minutes into Prison Night and Jungle Night matches: access violation at VA 0x1414516ab (root cause and fix below). Night maps must stay off (`CULLING_NIGHT_MAPS` unset, the default) until the fixed build is confirmed in game. Harness and exe-address tests PASS. |
| Night look under weather | Night maps keep dark clouds as the weather thickens them | **FAIL, then fixed (NOT TESTED in game)**. On Jungle Night an overcast/rain state showed a bright light-grey sky, like a stormy day. The tick raised cloud opacity to 0.6–0.8 while the clouds kept the level's bright night cloud colour (0.45, 0.59, 1.0), rim lit by the moon at 100. Fixed below; a test bounds every night-map state. |
| Rain shelter | Upward line traces from the pawn turn the rain off under a roof | **NOT TESTED** in game. Harness and exe-address tests PASS. |
| Lightning | Moon and sky light pulse for one tick (1 s) | **PARTIAL** by design: there is no faster tick, so a flash lasts 1 s. Not seen in game. |
| Thunder audio | — | **BLOCKED** for now. It needs the AkGameplayStatics::PostEvent address and an event; `Play_Lobby_Boom` and `Play_Lobby_Rumble_*` are candidates. Not attempted. |
| Wet surfaces, puddles, splashes on materials | — | **BLOCKED**. This needs new or changed material shaders. Shipping copies of compiled shaders broke the game before (`docs/ANIMATED_SKIN_AUDIT.md`), and only material instances of stock materials work. The rain's GPU collision gives small bounces on the ground, but nothing gets wet. |
| Volumetric fog | — | **BLOCKED**. UE 4.15 has none (it arrived in 4.16), so all fog here is exponential height fog. |

## How the maps are lit (evidence)

- **Everything is lit at runtime.**
  - `DefaultEngine.ini` sets `r.AllowStaticLighting=False`.
  - Both persistent maps' WorldSettings have `bForceNoPrecomputedLighting=True`.
  - No sublevel holds any lightmap or shadowmap textures.
  - The sun (DirectionalLight) and the SkyLight are Movable.
  - So night is just property values.
- **Each map's look lives in its Lighting sublevel**, streamed as `LevelStreamingAlwaysLoaded` (`/Game/Maps/Jungle/Lighting`, `/Game/Maps/Jungle2/Lighting`). It holds:
  - the sky (`BP_Victory_Sky`, whose MaterialInstanceDynamic of `PM_Sky` renders the dome);
  - the sun and the SkyLight;
  - the ExponentialHeightFog;
  - an unbound post-process volume with fixed exposure (min = max = 1);
  - 26–30 reflection captures holding cooked cubemaps.
- **Stock Prison is already a night map:**
  - sun 0.25 at 8000 K;
  - SkyLight 0.25 with `jungle2_cubemap`;
  - a procedural starry sky;
  - near-black fog;
  - exposure bias +3;
  - about 800 lamps.

  Jungle Night uses Prison's sky recipe.
- **A stock runtime light changer already exists:** `BloodMoon` (Prison's `Event_BloodMoon`). It lerps the sun, sky light, fog colour and sky "Overall Color" on a timeline. This shows that runtime lighting changes work in this build.

## Pieces

### 1. Night look and night maps: `patch/make_weather.py`

`python patch/make_weather.py <Paks> [--fog <scale>] [--out <dir>] [--override-stock]`

- **`Lighting_Night` per map** sets:
  - sky material and sky actor values;
  - sun (or moon) intensity, temperature and angle;
  - SkyLight intensity and cubemap;
  - fog, set by visibility in metres (`--fog 2` halves it);
  - exposure and grade, with their `bOverride_` flags;
  - reflection capture brightness.
- **`Jungle_Night_P` / `Jungle2_Night_P`:** copies of the persistent maps. Their one Lighting streaming entry points at `Lighting_Night`.
- **`weather_maps.h`:** for the native module. It holds the full object paths of the fog, sun, SkyLight and sky material in every Lighting level the weather drives (both night levels and both stock ones), plus the fog constant and the light bases.
- **Presets:**
  - Jungle Night: Prison's starry sky with more cloud, a moon 38° up, night mist with half visibility at 50 m, exposure +2.5, a cool desaturated grade, reflections ×0.15.
  - Prison Night (storm): overcast, fast dark clouds, almost no stars, moon 0.12, fog with half visibility at 40 m.

### 2. Map choice (gated)

- **Server** (`server/weather.js`, `server/server.js`). Everything is off by default: stock maps, stock answers (`offline:<map>`, `duo:<map>`).
  - `CULLING_NIGHT_MAPS=1`: the vote also offers `jungle-night` (index 2) and `prison-night` (index 3).
  - `CULLING_WEATHER_DAY=1`: weather on Jungle and Prison too.
  - `CULLING_WEATHER_PRESETS=storm,foggy`: limits which presets are drawn.
  - A match on a night map (or on a day map with day weather) is answered `map:<solo|duo>:<index>?Weather=<preset>?WeatherSeed=<n>`. The preset and seed are drawn per match.
  - Queue names containing `night` (for example `ffa_jungle-night`) prefer the night map.
- **ClientWeb.js** (ES5): `RemasterMapUrl()` turns a `map:` answer into `<map path>?bEnableBots=true?game=<mode's game mode><options>` and opens it with `StartTraining(url)`, as Duo does. `REMASTER_MAP_PATHS` and `REMASTER_MODE_GAMES` are checked against `make_weather.py`.
- **MatchLobby.js:** night vote cards (Jungle Night, Prison Night: the map art under a dark-blue tint). They only appear when the server counts votes for them.

### 3. Rain: `patch/make_rain.py`

`/Game/Remaster/Weather/P_Rain_{Light,Heavy,Storm}` are copies of `P_Impact_Metal` reduced to its one GPU emitter: velocity-aligned spark streaks with GPU depth collision.

**Module tables changed** (the CPU spawn step reads these):

| Setting | Light | Heavy | Storm |
|---|---|---|---|
| Spawn rate | 2,500/s | 8,000/s | 16,000/s |
| Spawn ball radius | 2,200 | 2,600 | 2,600 |
| Lifetime | 1.4–1.8 s | 1.5–1.9 s | 1.4–1.8 s |
| Fall speed | 11–14 m/s | 14–17 m/s | 17–20 m/s |
| Wind | slight | slight | strong sideways |

- Bursts are off, the emitter loops forever, and its LOD (off in stock) is switched on.
- Drops spawn in a ball centred 1,400 units above the emitter.
- Streaks are stretched by speed and coloured pale blue-grey.

**The cooked GPU data is changed to match** (`ParticleModuleTypeDataGpu` EmitterInfo / ResourceData): constant acceleration, max lifetime, particle budget, colour bias, size by speed. All edits are in place.

The fixed bounds cover the ball and the fall.

### 4. Weather over a match: `patch/weather.c` in the native module

- **Hook:** `showdown_rounds.c` includes `weather.c` and calls `weather_tick(gm)` at the top of `sd_should_end`, which runs once a second while the match is InProgress. That is a 3-line change to `showdown_rounds.c`, so it merges easily with other work on that file. The weather code has no other dependency on it.
- **Off unless the URL asks:** it reads the game mode's `OptionsString` (+0x400) for `Weather=<clear|cloudy|rainy|storm|foggy>`, `WeatherSeed=<n>` and `WeatherCycle=0`.
- **Seeded schedule.** The weather is a pure function of (seed, preset, seconds InProgress), so every machine with the seed computes the same weather (ready for netplay).
  - States: clear, cloudy, overcast, rain, heavy rain, storm, fog.
  - Each state lasts 70–240 s; changes blend over 45 s.
  - Transitions follow a weighted Markov chain whose weights depend on the preset.
  - Lightning fires in heavy rain and storm.
  - `make_weather.weather_state()` is the same schedule in Python.
- **What it drives,** found by full object path (StaticFindObject):
  - fog density (from the state's visibility) and fog start distance;
  - sun (or moon) and SkyLight intensity (map base × the state's factor);
  - the sky material's "Cloud opacity", "Cloud speed" and, on night maps, "Stars brightness";
  - rain: the state's level, spawned with `SpawnEmitterAttached` on the local pawn's root (in a weak pointer). It is deactivated (it finishes its drops, then destroys itself) when the level changes or the player has a new pawn.
  - shelter: while it rains, 5 upward line traces per second (`LineTraceSingle`, Visibility, complex, ignoring the pawn, 3,000 units up from 60 above the pawn's centre). One goes straight up, four start 250 units out. The pawn is covered when the centre trace and at least 2 of the 4 side traces hit. Two covered ticks in a row turn the rain off (deactivated: drops already falling finish). Two open ticks turn it back on. A small overhang (only the centre trace hits) keeps the rain, and stepping in and out every second never thrashes the emitter. Where tree canopies have collision on the Visibility channel, they count as a roof too.
- **Game addresses**, each re-derived from the stock exe by `test_weather_native.py`:

| Address | Role |
|---|---|
| StaticFindObject `0x6942a0` | Finds the objects by full path |
| StaticLoadObject `0x695470` | Loads the rain particle systems |
| FName ctor `0x5b0e60` | Makes the material parameter names |
| `0x1271a60` | SetFogDensity |
| `0x1272f60` | Fog SetStartDistance |
| `0x1271d00` | ULightComponent::SetIntensity |
| `0x12c0830` | USkyLightComponent::SetIntensity |
| `0x1423690` | MID SetScalarParameterValue |
| `0x1348fa0` | SpawnEmitterAttached |
| vtable `+0x210` | Deactivate |
| `0x13b7d00` | UKismetSystemLibrary::LineTraceSingle (the thunk's 12 parameters; start in rdx, end in r8) |
| `+0x1a0` | USceneComponent ComponentToWorld translation (as K2_GetActorLocation reads it) |
| `+0x1e0` | AActor::RootComponent |
| `+0x400` | AGameModeBase::OptionsString |

### 5. Night mode combos

The five presets on a night map give clear, cloudy, rainy, storm and foggy nights. Each starts in its own state and leans toward its theme; `WeatherCycle=0` holds it. The same presets work on the day maps with `CULLING_WEATHER_DAY=1`.

## Static verification

| Test | Checks | Result |
|---|---|---|
| `python patch/test_weather.py <Paks> [--pak out.pak] [--override-pak out.pak]` | Every package saves back byte-for-byte. Only the intended exports change, and native data after the tags (cooked cubemaps) is untouched. Every import resolves to an existing object. Every streamed level exists. Preset values and fog visibility read back. `--fog` scales. For rain: stock imports, only the GPU emitter and system changed, every value read back. Menu URLs, server indices and presets, the `weather.c` table and `weather_maps.h` all agree. The paks read back. | PASS (22 checks) |
| `python patch/test_weather_native.py [Victory.exe]` | The weather C code against fake game objects: off without `Weather=`, waits for the level, applies everything, rain on the pawn, re-spawn for a new pawn; rain off under a roof after 2 ticks, back after 2 in the open, kept under a small overhang, no thrash, no traces while dry. The schedule matches Python over 96,080 seconds (8 seeds × 5 presets × with and without cycling). Every applied value matches over 900 s per preset. All 15 game addresses re-derived from the stock exe (by registered native name, exec thunk call, log strings, vtable slot, property offsets, class neighbourhood) and present in the blob. | PASS (8 checks) |
| `python patch/test_native_module.py`, `python patch/test_patch_exe.py` | The existing module and exe tests | PASS |
| `node server/test/weather.test.js` | Default off; night maps and day weather settings; answers | PASS (7 tests) |
| The other server test files | Unchanged behaviour | PASS. `showdown.test.js` fails its last test (a missing `profiles.json`) with or without these changes. |

## Test builds (outside the game install)

- `C:\Culling\weather\test.pak`: the night maps (both `Lighting_Night` and both `*_Night_P`) and the three rain systems.
- `C:\Culling\weather\test_override.pak`: the night Lighting levels on the stock Lighting paths (every Jungle and Prison match is night) and the rain systems. For a quick look only.
- `C:\Culling\weather_test\Victory.exe`: the stock exe patched by `patch_exe.py` with the module that includes the weather.
- Choosing a map from the menu also needs the patch pak rebuilt from this branch's `patch/src` (ClientWeb.js, MatchLobby.js), plus the server with `CULLING_NIGHT_MAPS=1`.

## In-game test list

1. With `test_override.pak`, Prison Solo: overcast storm night, fog at about 40 m, lamps lit, FPS like stock. Jungle Solo again: check fog distance, readability at 20–30 m and FPS.
2. With `test.pak`, the rebuilt patch pak, the patched exe and a server with `CULLING_NIGHT_MAPS=1`:
   1. Vote Jungle Night. The map loads by URL with bots, the HUD works, the match ends, and you return to the menu.
   2. Watch for about 15 minutes. Clouds, fog and moonlight should change smoothly on minute-scale timers, and rain should start and stop. On a storm, lightning flashes for about 1 s.
3. Rain look: streak length, density, brightness at night exposure, falling while you run, and bounces on the ground. It must not render as checkerboard (if it does, its material lacks GPU sprite shaders).
4. Duo on Prison Night; Showdown is unaffected.
5. With the server's default settings: only Jungle and Prison in the vote, and stock answers.
6. FPS with storm rain (16,000 drops/s, about 29,000 alive) on a mid-range GPU.

## The crash at VA 0x1414516ab (fixed)

- **Where it crashed:** a virtual of UParticleSystemComponent (function 0x141451540, in its vtable at 0x142a62c48). It walks Template->Emitters (`[component + 0x708]` = Template, `[Template + 0x40]` = Emitters.Data) and faulted reading an element: the Template it was given was a freed object.
- **Root cause:** `wx_begin` loaded the three rain particle systems at match start (StaticLoadObject) and kept the raw pointers for the whole match. Nothing references a rain template that isn't playing, so the garbage collector (about once a minute) freed it. At the next change of rain level the module passed the freed pointer to SpawnEmitterAttached, and the new component's particle init read freed memory. That happens 3–4 minutes in, at the first change of state after a collection.
- **Fix:**
  - No UObject pointer is kept from one tick to the next except through a weak pointer.
  - The rain template is looked up (StaticLoadObject finds it, or loads it again) right before each spawn.
  - Every object the tick uses (fog, sun, sky light, sky material, the pawn, its root, the template) is used only if live: a weak pointer to it resolves (not destroyed, not pending kill).
- **Test:** `test_weather_native.py` has the scenario. The rain goes off under a roof, the "garbage collector" frees the template, the rain comes back, and the spawn must get a live, reloaded template. The setters refuse dead objects, and the 900-second runs collect unused templates once a minute.

## Night look under weather (fixed)

- **Night maps:** the tick now also darkens the clouds as they thicken. Between cloud opacity 0.15 and 0.6:
  - "Cloud color" goes from the level's own toward (0.030, 0.038, 0.060), set with the MID's SetVectorParameterValue (`0x1423970`, re-derived from the exe).
  - "Rim light brightness" and "Whole Cloud Rim light" drop to a tenth of the level's.
  - The level's cloud colour and rim come from `weather_maps.h`, read from each Lighting level.
- **Jungle Night's static sky:** its "Sun color" (the moon's tint on the clouds) is cool white (0.80, 0.86, 1.0) instead of the stock Jungle's orange sunset.
- **Day maps** (stock Lighting with `CULLING_WEATHER_DAY=1`) keep their bright overcast.
- **Test:** over 20 minutes of every preset and seed on every night map, moonlight and sky light never exceed the level's own (lightning aside), cloud is never brighter than its colour, and thick cloud (0.6+) stays dark: colour at most 0.06, rim at most a fifth.

## Risks

- **Native code.** A wrong address, offset or object lifetime in `weather.c` crashes a weather match (it did once: the freed rain template, above). The code only runs when the URL has `Weather=`. Every address is re-derived from the exe by the test, and every object is checked live each tick. All other matches only parse the options string once per second.
- **Renamed persistent level.** Opening a renamed copy of a persistent level by URL is not yet proven (sublevel copies are). If it fails, the fallback is to override the stock Lighting level (the `test_override.pak` route), with the night look then covering every match on that map.
- **Rain is the most speculative piece.**
  - The base emitter's LOD was off in stock.
  - The GPU simulation's baked data was changed to match the new values.
  - How the material looks on GPU sprites and the frame rate under heavy rain need the game.
- **Lightning lasts 1 s** because the tick is 1 Hz.
- **Merge.** `showdown_rounds_blob.py` is generated: on a merge with another module branch, rebuild it with `build_showdown_rounds.py` after merging the C sources.
