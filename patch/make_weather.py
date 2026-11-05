"""Night and fog variants of the two match maps, as their own maps.

Both maps light the whole island at run time: every streamed level of
Jungle_P and Jungle2_P has bForceNoPrecomputedLighting (WorldSettings) and no
lightmap textures; the sun (DirectionalLight) and the SkyLight are Movable.
So a map's time of day is just the property values of its Lighting level
(/Game/Maps/<map>/Lighting): the sun, the sky light and its cubemap, the sky
dome (BP_Victory_Sky's MaterialInstanceDynamic of PM_Sky), the
ExponentialHeightFog, the post-process volume and the reflection captures.
No shader, material or Blueprint is touched.

Stock Prison is already a night map (sun 0.25 at 8000 K, sky light 0.25 with
the jungle2_cubemap, a procedural starry sky, near-black fog, exposure bias
+3 EV and ~800 lamps). Its look is the template for the Jungle's night.

Variants (each a new package; the stock maps are untouched):

- Jungle Night, /Game/Maps/Jungle/Jungle_Night_P: a copy of Jungle_P whose
  Lighting streaming entry points at Lighting_Night, a copy of the Jungle's
  Lighting level with Prison's night sky, a moonlight sun, the night cubemap,
  a low blue-grey night mist, a cool grade and dimmed reflection captures.
- Prison Night (storm), /Game/Maps/Jungle2/Jungle2_Night_P: the same for
  Prison - an overcast storm night: thick fast clouds hiding the stars, a
  dimmer moon, heavy fog.

Fog is set by visibility: the distance (metres, on level ground at the map's
reference height) at which the fog has taken half the light. UE 4.15's height
fog lets 2^(-d * L) through over L units with
d = FogDensity / 1000 * 2^(-FogHeightFalloff / 1000 * (z - fog z)).
--fog <scale> divides every visibility by <scale> (2 = twice as thick).

Start a variant with its URL (MAP_URLS) through the patched exe's
StartTraining(url), like Duo and Showdown (patch_exe.py fix 3).

usage: python make_weather.py <Paks dir> [--fog <scale>] [--out <dir>] [--override-stock]
  --out             write the packages under <dir> instead of patch/src
  --override-stock  also write the night Lighting levels over the stock
                    Lighting paths (test builds only: every Jungle and Prison
                    match is then night)
"""
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_menu_arenas import (encode_tag, iter_tags, set_export_props, set_named_color,  # noqa: E402
                               set_named_param, streaming_props)
from level_survey import export_props  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from ue_package import UPackage  # noqa: E402
from uasset import Package  # noqa: E402

SRC = os.path.join(HERE, "src")
GAME_MODE = "/Game/Blueprints/GameMode/VictoryGameMode.VictoryGameMode_C"

# ---------------------------------------------------------------- the night look
# Prison's stock sky (its MaterialInstanceDynamic of PM_Sky): no painted
# panorama (Custom sky multiplier 0), the engine star field and two cloud
# layers that the material animates itself.
PRISON_SKY = {
    "Horizon falloff": 10.0, "Cloud speed": 4.0, "Sun brightness": 0.0, "Cloud opacity": 0.1,
    "Stars brightness": 0.65, "Custom sky multiplier": 0.0, "Horizon/zenith overlay intensity": 0.05,
    "Sun Radius": 0.0, "Stars tiling": 12.0, "Rim light brightness": 100.0, "Rim light spread": 10.0,
    "Secondary clouds opacity": 2.0, "Whole Cloud Rim light": 5.0,
}
PRISON_CLOUD_COLOR = (0.4549, 0.5912, 1.0, 0.0)
# The placed sky actor's variable for each material parameter (the names
# differ in case; BP_Victory_Sky's construction script copies one to the
# other in the editor, the cooked level stores both).
SKY_ACTOR_NAMES = {"Horizon falloff": "Horizon Falloff",
                   "Horizon/zenith overlay intensity": "Horizon/Zenith multiplier"}


def moon_rotation(pitch, yaw):
    """Light rotation and the sky material's "Light direction" (the
    direction the light travels: the rotation's forward vector)."""
    p, y = math.radians(pitch), math.radians(yaw)
    return (pitch, yaw, 0.0), (math.cos(p) * math.cos(y), math.cos(p) * math.sin(y), math.sin(p), 1.0)


PRESETS = {
    # Jungle Night: Prison's starry sky with a little more cloud, a moon
    # 38 degrees up in the stock sun's compass direction, a cool night mist
    # that thins with height, a cool desaturated grade and reflection
    # captures (captured in daylight) dimmed to match.
    "jungle_night": {
        "sky": dict(PRISON_SKY, **{"Cloud opacity": 0.25, "Stars brightness": 0.55}),
        "cloud_color": PRISON_CLOUD_COLOR,
        "sun_color": (0.80, 0.86, 1.0, 0.0),
        "sun": {"Intensity": 0.3, "Temperature": 8000.0},
        "moon": (-38.0, -105.66),
        "sky_light": {"Intensity": 0.25, "SourceCubemapAngle": 214.68,
                      "LowerHemisphereColor": (0.0529, 0.0666, 0.0742, 1.0)},
        "cubemap": "jungle2_cubemap",
        "fog": {"visibility_m": 50.0, "ground_z": 0.0, "FogHeightFalloff": 0.35, "StartDistance": 1000.0,
                "FogMaxOpacity": 0.98,
                "FogInscatteringColor": (0.007, 0.009, 0.015, 1.0),
                "DirectionalInscatteringColor": (0.03, 0.04, 0.07, 1.0),
                "DirectionalInscatteringExponent": 8.0, "DirectionalInscatteringStartDistance": 3000.0},
        "post": {"AutoExposureBias": 2.5,
                 "ColorSaturation": (1.0, 1.0, 1.0, 0.75),
                 "ColorGainHighlights": (0.85, 0.92, 1.08, 1.0)},
        "reflection_scale": 0.15,
    },
    # Prison Night (storm): the stock night with thick, fast, dark clouds
    # over the stars, a dimmer moon and heavy fog.
    "prison_storm": {
        "sky": dict(PRISON_SKY, **{"Cloud opacity": 0.65, "Cloud speed": 14.0, "Stars brightness": 0.08,
                                   "Secondary clouds opacity": 3.0, "Rim light brightness": 20.0}),
        "cloud_color": (0.16, 0.19, 0.27, 0.0),
        "sun": {"Intensity": 0.12},
        "moon": None,
        "sky_light": {"Intensity": 0.18},
        "cubemap": None,
        "fog": {"visibility_m": 40.0, "ground_z": 2165.0, "FogHeightFalloff": 0.2, "StartDistance": 400.0,
                "FogMaxOpacity": 0.98,
                "FogInscatteringColor": (0.0035, 0.0045, 0.0075, 1.0),
                "DirectionalInscatteringColor": (0.03, 0.04, 0.07, 1.0)},
        "post": {"ColorSaturation": (1.0, 1.0, 1.0, 0.6)},
        "reflection_scale": 0.7,
    },
}

# name -> (stock persistent level, stock Lighting level, new persistent level, new Lighting level, preset)
VARIANTS = {
    "Jungle Night": ("Victory/Content/Maps/Jungle/Jungle_P.umap", "Victory/Content/Maps/Jungle/Lighting.umap",
                     "Victory/Content/Maps/Jungle/Jungle_Night_P.umap",
                     "Victory/Content/Maps/Jungle/Lighting_Night.umap", "jungle_night"),
    "Prison Night": ("Victory/Content/Maps/Jungle2/Jungle2_P.umap", "Victory/Content/Maps/Jungle2/Lighting.umap",
                     "Victory/Content/Maps/Jungle2/Jungle2_Night_P.umap",
                     "Victory/Content/Maps/Jungle2/Lighting_Night.umap", "prison_storm"),
}
CUBEMAP_DIR = "/Game/Environment/Culling/Textures/"


def game_path(rel):
    """Victory/Content/Maps/Jungle/X.umap -> /Game/Maps/Jungle/X"""
    return "/Game/" + rel[len("Victory/Content/"):].rsplit(".", 1)[0]


MAP_URLS = {name: game_path(v[2]) + "?bEnableBots=true?game=" + GAME_MODE for name, v in VARIANTS.items()}
# The menu's map list for "map:<mode>:<index>" answers (server/weather.js):
# 0 Jungle, 1 Prison, 2 Jungle Night, 3 Prison Night. ClientWeb.js holds copies
# (REMASTER_MAP_PATHS, REMASTER_MODE_GAMES); test_weather.py checks them.
MAP_PATHS = ["Jungle_P", "Jungle2_P"] + [game_path(v[2]) for v in VARIANTS.values()]
MODE_GAMES = {"solo": GAME_MODE,
              "duo": "/Game/Blueprints/GameMode/VictoryGameMode_CoopRanked.VictoryGameMode_CoopRanked_C"}

# ---------------------------------------------------------------- weather over a match (native)
# The native module's schedule (weather.c), mirrored here for the tests and
# the docs. Keep both in step: test_weather_native.py runs the C code and
# compares it with weather_state() below.
#            name        cloud speed stars moon  sky   vis(m) rain lightning(1/1000 s) seconds
WEATHER_STATES = [
    ("clear",      0.05, 3.0, 0.70, 1.00, 1.00, 120.0, 0, 0, 120, 240),
    ("cloudy",     0.30, 5.0, 0.40, 0.85, 0.95, 90.0, 0, 0, 100, 220),
    ("overcast",   0.60, 8.0, 0.08, 0.55, 0.80, 65.0, 0, 0, 90, 200),
    ("rain",       0.65, 10.0, 0.05, 0.45, 0.75, 50.0, 1, 0, 90, 200),
    ("heavy rain", 0.72, 13.0, 0.03, 0.35, 0.65, 35.0, 2, 10, 80, 180),
    ("storm",      0.80, 18.0, 0.00, 0.25, 0.55, 28.0, 3, 60, 70, 150),
    ("fog",        0.40, 4.0, 0.20, 0.60, 0.85, 15.0, 0, 0, 90, 180),
]
CLEAR, CLOUDY, OVERCAST, RAIN, HEAVY, STORM, FOG = range(7)
WEATHER_NEXT = {
    CLEAR: [(CLOUDY, 1)],
    CLOUDY: [(CLEAR, 1), (OVERCAST, 1), (FOG, 1)],
    OVERCAST: [(CLOUDY, 1), (RAIN, 2), (FOG, 1)],
    RAIN: [(OVERCAST, 1), (HEAVY, 2)],
    HEAVY: [(RAIN, 2), (STORM, 1)],
    STORM: [(HEAVY, 1)],
    FOG: [(CLOUDY, 1), (OVERCAST, 1)],
}
# ?Weather=<preset>: the start state, and the states whose weight is tripled.
WEATHER_PRESETS = {
    "clear": (CLEAR, {CLEAR, CLOUDY}),
    "cloudy": (CLOUDY, {CLOUDY, OVERCAST}),
    "rainy": (RAIN, {RAIN, HEAVY, OVERCAST}),
    "storm": (STORM, {HEAVY, STORM}),
    "foggy": (FOG, {FOG, OVERCAST}),
}
WEATHER_BLEND = 45
NIGHT_CLOUD_THIN, NIGHT_CLOUD_THICK = 0.15, 0.60
NIGHT_OVERCAST = (0.030, 0.038, 0.060)
NIGHT_RIM_DROP = 0.90


def night_overcast(cloud):
    """0 (thin) .. 1 (thick): how far night cloud goes to the dark overcast (weather.c wx_overcast)."""
    return min(1.0, max(0.0, (cloud - NIGHT_CLOUD_THIN) / (NIGHT_CLOUD_THICK - NIGHT_CLOUD_THIN)))


def _xorshift(x):
    x ^= (x << 13) & 0xFFFFFFFF
    x ^= x >> 17
    x ^= (x << 5) & 0xFFFFFFFF
    return x & 0xFFFFFFFF


def weather_state(seed, preset, cycle, t):
    """(current state, previous state, seconds since the change, blend 0..1)
    at second t, exactly as weather.c computes it."""
    rng = seed or 0x9E3779B9
    names = list(WEATHER_PRESETS)
    start_state, theme = WEATHER_PRESETS[names[preset]] if isinstance(preset, int) else WEATHER_PRESETS[preset]
    start, cur, prev, guard = 0, start_state, start_state, 0
    while True:
        lo, hi = WEATHER_STATES[cur][9], WEATHER_STATES[cur][10]
        rng = _xorshift(rng)
        dur = lo + rng % (hi - lo + 1)
        if not cycle or t < start + dur:
            break
        guard += 1
        if guard > 10000:
            break
        options = [(n, w * (3 if n in theme else 1)) for n, w in WEATHER_NEXT[cur]]
        rng = _xorshift(rng)
        r = rng % sum(w for _, w in options)
        nxt = cur
        for n, w in options:
            if r < w:
                nxt = n
                break
            r -= w
        prev, cur, start = cur, nxt, start + dur
    since = t - start
    blend = 1.0 if prev == cur or since >= WEATHER_BLEND else since / WEATHER_BLEND
    return cur, prev, since, blend


def weather_flash(seed, state, t):
    x = (seed ^ ((t * 0x9E3779B1) & 0xFFFFFFFF)) & 0xFFFFFFFF or 0x9E3779B9
    if not WEATHER_STATES[state][8]:
        return False
    x = _xorshift(x)
    x = _xorshift(x)
    return x % 1000 < WEATHER_STATES[state][8]


# The levels the native module drives: (Lighting level, night?, sun base,
# sky light base, ground z for the fog). The night variants come first.
NATIVE_MAPS = [
    ("Victory/Content/Maps/Jungle/Lighting_Night.umap", True, 0.3, 0.25, 0.0),
    ("Victory/Content/Maps/Jungle2/Lighting_Night.umap", True, 0.25, 0.25, 2165.0),
    ("Victory/Content/Maps/Jungle/Lighting.umap", False, 2.0, 1.0, 0.0),
    ("Victory/Content/Maps/Jungle2/Lighting.umap", True, 0.25, 0.25, 2165.0),
]
RAIN_LEVELS = ("Light", "Heavy", "Storm")
NATIVE_HEADER = os.path.join(HERE, "weather_maps.h")


def object_path(up, index):
    """UE path name of export #index: Package.Top:Sub.Sub..."""
    chain = []
    while index > 0:
        f = up.exports[index - 1]["fields"]
        chain.append(up.name_str(f[4], f[5]))
        index = f[3]
    chain.reverse()
    return chain[0] + (":" + ".".join(chain[1:]) if len(chain) > 1 else "")


def export_class(up, index):
    c = up.exports[index - 1]["fields"][0]
    return up.names[struct.unpack_from("<i", up.imports[-c - 1], 20)[0]][0] if c < 0 else "?"


def native_targets(rel, data):
    """Full paths of the fog, sun, sky light and sky material in a Lighting level."""
    up = UPackage(data)
    pkg = Package(data)
    sky = sky_actor_index(pkg)
    mid = struct.unpack_from("<i", data, export_props(pkg, sky)["Sky material"][1])[0]
    prefix = game_path(rel) + "."
    return {
        "fog": prefix + object_path(up, first_of(pkg, "ExponentialHeightFogComponent")),
        "sun": prefix + object_path(up, first_of(pkg, "DirectionalLightComponent")),
        "sky_light": prefix + object_path(up, first_of(pkg, "SkyLightComponent")),
        "sky_material": prefix + object_path(up, mid),
    }


def fog_constant(data, ground_z):
    """density = k / visibility_m on level ground at ground_z (inverse of fog_visibility)."""
    pkg = Package(data)
    fog = first_of(pkg, "ExponentialHeightFogComponent")
    fp = export_props(pkg, fog)
    fog_z = struct.unpack_from("<3f", data, fp["RelativeLocation"][1])[2]
    falloff = struct.unpack_from("<f", data, fp["FogHeightFalloff"][1])[0] if "FogHeightFalloff" in fp else 0.2
    return 10.0 / 2.0 ** (falloff / 1000.0 * (fog_z - ground_z))


def sky_params(data):
    """{name: value} of the sky dome's MaterialInstanceDynamic (scalars and colours)."""
    pkg = Package(data)
    sky = sky_actor_index(pkg)
    mid = struct.unpack_from("<i", data, export_props(pkg, sky)["Sky material"][1])[0]
    e = pkg.exports[mid - 1]
    blob = data[e["offset"]:e["offset"] + e["size"]]
    pn, pv = pkg.names.index("ParameterName"), pkg.names.index("ParameterValue")
    out, i = {}, 0
    while True:
        i = blob.find(struct.pack("<ii", pn, 0), i)
        if i < 0:
            return out
        name = pkg.names[struct.unpack_from("<i", blob, i + 25)[0]]
        j = blob.find(struct.pack("<ii", pv, 0), i)
        t = pkg.names[struct.unpack_from("<i", blob, j + 8)[0]]
        if t == "FloatProperty":
            out[name] = struct.unpack_from("<f", blob, j + 25)[0]
        elif t == "StructProperty":
            out[name] = struct.unpack_from("<4f", blob, j + 24 + 8 + 16 + 1)
        i += 8


def native_header(levels):
    """weather_maps.h from {rel: package bytes} of every NATIVE_MAPS level.
    Strings are inline arrays: the module's data must hold no absolute
    pointers (the blob gets no base relocations)."""
    def w(s):
        assert '"' not in s and "\\" not in s
        return 'L"%s"' % s
    rows = [(native_targets(rel, levels[rel]), fog_constant(levels[rel], ground), sun, sky, night,
             sky_params(levels[rel])) for rel, night, sun, sky, ground in NATIVE_MAPS]
    width = max(len(v) + 1 for t, *_ in rows for v in t.values())
    out = ["/* Generated by make_weather.py from the Lighting levels: do not edit. */",
           "#define WX_PATH %d" % width,
           "typedef struct { u16 fog[WX_PATH], sun[WX_PATH], sky_light[WX_PATH], sky_material[WX_PATH];",
           "                 float density_k, sun_base, sky_base, stars_base; i32 night;",
           "                 float cloud_rgb[4], rim_base, whole_rim_base; } WxMap;",
           "#define WX_NMAPS %d" % len(NATIVE_MAPS),
           "static const WxMap WX_MAPS[WX_NMAPS] = {"]
    for t, k, sun, sky, night, params in rows:
        c = params["Cloud color"]
        out.append("    {%s,\n     %s,\n     %s,\n     %s,\n     %.6ff, %.3ff, %.3ff, %.3ff, %d,\n"
                   "     {%.4ff, %.4ff, %.4ff, %.4ff}, %.3ff, %.3ff}," % (
                       w(t["fog"]), w(t["sun"]), w(t["sky_light"]), w(t["sky_material"]),
                       k, sun, sky, 1.0 if night else 0.0, 1 if night else 0,
                       c[0], c[1], c[2], c[3], params["Rim light brightness"], params["Whole Cloud Rim light"]))
    out.append("};")
    out.append("static const u16 WX_RAIN_PATHS[3][64] = {")
    for level in RAIN_LEVELS:
        out.append('    L"/Game/Remaster/Weather/P_Rain_%s.P_Rain_%s",' % (level, level))
    out.append("};")
    return "\n".join(out) + "\n"


# ---------------------------------------------------------------- fog
def fog_density(visibility_m, fog_z, ground_z, falloff):
    """FogDensity that halves the light every visibility_m metres on level
    ground at ground_z (inverse of fog_visibility)."""
    per_unit = 1.0 / (visibility_m * 100.0)
    return 1000.0 * per_unit / 2.0 ** (falloff / 1000.0 * (fog_z - ground_z))


def fog_visibility(density, fog_z, ground_z, falloff):
    """Metres over which the fog takes half the light, on level ground at ground_z."""
    per_unit = density / 1000.0 * 2.0 ** (falloff / 1000.0 * (fog_z - ground_z))
    return 1.0 / per_unit / 100.0


# ---------------------------------------------------------------- tagged properties
KINDS = {"FloatProperty": "FloatProperty", "IntProperty": "IntProperty", "BoolProperty": "BoolProperty"}


def kind_of(value):
    if isinstance(value, bool):
        return "BoolProperty"
    if isinstance(value, int):
        return "IntProperty"
    if isinstance(value, float):
        return "FloatProperty"
    raise TypeError(value)


def encode(up, name, kind, value):
    if kind == "Vector4":
        blob = struct.pack("<4f", *value)
        return (up.fname(name) + up.fname("StructProperty") + struct.pack("<ii", len(blob), 0)
                + up.fname("Vector4") + b"\0" * 16 + b"\0" + blob)
    return encode_tag(up, name, kind, value)


def apply_tags(up, data, values):
    """Like build_menu_arenas.set_export_props on a bare tagged-property
    block (a struct's contents): replace or prepend each tag."""
    for prop, (kind, value) in values.items():
        tag = encode(up, prop, kind, value)
        existing = {name: (start, voff + size) for name, _, start, voff, size in iter_tags(up, data)}
        if prop in existing:
            start, end = existing[prop]
            data = data[:start] + tag + data[end:]
        else:
            data = tag + data
    return data


def set_struct_props(up, index, struct_prop, values):
    """Set tagged properties inside the struct property `struct_prop` of
    export #index, updating the struct tag's size."""
    e = up.exports[index - 1]
    data = e["data"]
    for name, ptype, start, voff, size in iter_tags(up, data):
        if name == struct_prop:
            assert ptype == "StructProperty"
            inner = apply_tags(up, data[voff:voff + size], values)
            head = bytearray(data[start:voff])
            struct.pack_into("<i", head, 16, len(inner))
            e["data"] = data[:start] + bytes(head) + inner + data[voff + size:]
            return
    raise KeyError(struct_prop)


def read_tags(up, data):
    return {name: (ptype, voff, size) for name, ptype, _, voff, size in iter_tags(up, data)}


def struct_tags(up, index, struct_prop):
    data = up.exports[index - 1]["data"]
    ptype, voff, size = read_tags(up, data)[struct_prop]
    return data[voff:voff + size]


# ---------------------------------------------------------------- the Lighting level
def first_of(pkg, cls):
    found = [i for i, e in enumerate(pkg.exports, 1) if str(pkg.ref(e["class"])) == cls]
    assert len(found) == 1, (cls, len(found))
    return found[0]


def sky_actor_index(pkg):
    found = [i for i, e in enumerate(pkg.exports, 1) if str(pkg.ref(e["class"])).startswith("BP_Victory_Sky")]
    assert len(found) == 1, found
    return found[0]


def swap_cubemap(up, cubemap):
    """Point the sky light's TextureCube import (and its package import) at
    another stock cubemap in /Game/Environment/Culling/Textures/."""
    for k, imp in enumerate(up.imports):
        cls = up.names[struct.unpack_from("<i", imp, 8)[0]][0]
        if cls != "TextureCube":
            continue
        outer = struct.unpack_from("<i", imp, 16)[0]
        assert outer < 0
        pk = -outer - 1
        old_pkg = up.names[struct.unpack_from("<i", up.imports[pk], 20)[0]][0]
        assert old_pkg.startswith(CUBEMAP_DIR), old_pkg
        up.imports[pk] = up.imports[pk][:20] + up.fname(CUBEMAP_DIR + cubemap)
        up.imports[k] = imp[:20] + up.fname(cubemap)
        return old_pkg
    raise KeyError("no TextureCube import")


def night_lighting(data, preset, fog_scale=1.0):
    """The Lighting level with `preset` applied. Returns (bytes, notes)."""
    pkg = Package(data)
    out = bytearray(data)
    notes = []

    # Sky dome: the material instance the sky mesh renders...
    sky = sky_actor_index(pkg)
    mid = struct.unpack_from("<i", data, export_props(pkg, sky)["Sky material"][1])[0]
    assert str(pkg.ref(pkg.exports[mid - 1]["class"])) == "MaterialInstanceDynamic"
    for param, value in preset["sky"].items():
        set_named_param(pkg, out, pkg.exports[mid - 1], param, "ParameterValue", value)
    set_named_color(pkg, out, pkg.exports[mid - 1], "Cloud color", preset["cloud_color"])
    if preset.get("sun_color"):
        set_named_color(pkg, out, pkg.exports[mid - 1], "Sun color", preset["sun_color"])
    moon = None
    if preset["moon"]:
        moon = moon_rotation(*preset["moon"])
        set_named_color(pkg, out, pkg.exports[mid - 1], "Light direction", moon[1])

    up = UPackage(bytes(out))
    # ...and the placed sky actor's own copies of the same values.
    actor = {SKY_ACTOR_NAMES.get(k, k): ("FloatProperty", v) for k, v in preset["sky"].items()}
    actor["Cloud color"] = ("LinearColor", preset["cloud_color"])
    if preset.get("sun_color"):
        actor["Sun color"] = ("LinearColor", preset["sun_color"])
    set_export_props(up, sky, actor)

    # Sun -> moon.
    sun = first_of(pkg, "DirectionalLightComponent")
    values = {k: (kind_of(v), v) for k, v in preset["sun"].items()}
    if moon:
        values["RelativeRotation"] = ("Rotator", moon[0])
    set_export_props(up, sun, values)
    notes.append("sun %s" % ", ".join("%s %s" % (k, v) for k, v in preset["sun"].items()))

    # Sky light (stock Jungle stores no Intensity: the default 1.0).
    sl = first_of(pkg, "SkyLightComponent")
    values = {}
    for k, v in preset["sky_light"].items():
        values[k] = ("LinearColor", v) if isinstance(v, tuple) else (kind_of(v), v)
    set_export_props(up, sl, values)
    if preset["cubemap"]:
        old = swap_cubemap(up, preset["cubemap"])
        notes.append("sky light cubemap %s -> %s" % (old.rsplit("/", 1)[1], preset["cubemap"]))

    # Height fog, from the wanted visibility.
    fog = first_of(pkg, "ExponentialHeightFogComponent")
    fp = export_props(pkg, fog)
    fog_z = struct.unpack_from("<3f", data, fp["RelativeLocation"][1])[2]
    f = dict(preset["fog"])
    visibility = f.pop("visibility_m") / fog_scale
    ground = f.pop("ground_z")
    stock_density = struct.unpack_from("<f", data, fp["FogDensity"][1])[0]
    stock_falloff = (struct.unpack_from("<f", data, fp["FogHeightFalloff"][1])[0]
                     if "FogHeightFalloff" in fp else 0.2)
    density = fog_density(visibility, fog_z, ground, f["FogHeightFalloff"])
    values = {"FogDensity": ("FloatProperty", density)}
    for k, v in f.items():
        values[k] = ("LinearColor", v) if isinstance(v, tuple) else (kind_of(v), v)
    set_export_props(up, fog, values)
    notes.append("fog density %.4f -> %.4f: half the light every %.0f m (stock %.0f m)" % (
        stock_density, density, visibility, fog_visibility(stock_density, fog_z, ground, stock_falloff)))

    # Post process: exposure and grade (only bOverride_ settings apply).
    ppv = first_of(pkg, "PostProcessVolume")
    values = {}
    for k, v in preset["post"].items():
        values["bOverride_" + k] = ("BoolProperty", True)
        values[k] = ("Vector4", v) if isinstance(v, tuple) else (kind_of(v), v)
    set_struct_props(up, ppv, "Settings", values)

    # Reflection captures hold the scene as it was captured (daylight on the
    # Jungle): scale their Brightness (default 1.0) with the light.
    scaled = 0
    for i, e in enumerate(pkg.exports, 1):
        if str(pkg.ref(e["class"])).endswith("ReflectionCaptureComponent"):
            p = export_props(pkg, i)
            b = struct.unpack_from("<f", data, p["Brightness"][1])[0] if "Brightness" in p else 1.0
            set_export_props(up, i, {"Brightness": ("FloatProperty", b * preset["reflection_scale"])})
            scaled += 1
    notes.append("%d reflection captures x%.2f" % (scaled, preset["reflection_scale"]))
    return up.save(), notes


# ---------------------------------------------------------------- the persistent level
def repoint_lighting(data, old_world, new_world):
    """Point the persistent level's streaming entry for `old_world`
    ("/Game/Maps/Jungle/Lighting.Lighting") at `new_world`."""
    up = UPackage(data)
    needle = old_world.encode("latin1") + b"\0"
    hits = 0
    for e in up.exports:
        cls = e["fields"][0]
        if cls >= 0 or not up.names[struct.unpack_from("<i", up.imports[-cls - 1], 20)[0]][0].startswith(
                "LevelStreaming"):
            continue
        if needle in e["data"][:200]:
            e["data"] = streaming_props(up, e["data"], new_world)
            hits += 1
    assert hits == 1, hits
    return up.save()


def world_path(rel, world):
    return "%s.%s" % (game_path(rel), world)


def build(paks_dir, out_root=SRC, fog_scale=1.0, override_stock=False):
    stock = {v[0] for v in VARIANTS.values()} | {v[1] for v in VARIANTS.values()}
    original = find_in_paks(paks_dir, stock)
    written = []
    for name, (persistent, lighting, new_persistent, new_lighting, preset) in VARIANTS.items():
        # Build on the patch's own copy of the persistent level when there is
        # one (make_showdown.py edits Jungle_P), so the variant keeps its fixes.
        patched = os.path.join(SRC, persistent)
        base = open(patched, "rb").read() if os.path.exists(patched) else original[persistent]
        light, notes = night_lighting(original[lighting], PRESETS[preset], fog_scale)
        world = os.path.splitext(os.path.basename(lighting))[0]
        level = repoint_lighting(base, world_path(lighting, world), world_path(new_lighting, world))
        outputs = [(new_lighting, light), (new_persistent, level)]
        if override_stock:
            outputs.append((lighting, light))
        for rel, blob in outputs:
            path = os.path.join(out_root, rel)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            open(path, "wb").write(blob)
            written.append(rel)
        print("%s: %s (%s)" % (name, game_path(new_persistent), "; ".join(notes)))
        print("  url: %s" % MAP_URLS[name])
    return written


def make_header(paks_dir, out_root=SRC):
    """weather_maps.h text: the night levels as built under out_root, the stock ones from the paks."""
    stock = {rel for rel, *_ in NATIVE_MAPS if not os.path.exists(os.path.join(out_root, rel)) or
             rel in {v[1] for v in VARIANTS.values()}}
    levels = find_in_paks(paks_dir, stock)
    for rel, *_ in NATIVE_MAPS:
        if rel not in levels:
            levels[rel] = open(os.path.join(out_root, rel), "rb").read()
    return native_header(levels)


def main(argv):
    args = list(argv)
    fog, out, override = 1.0, SRC, False
    if "--fog" in args:
        i = args.index("--fog"); fog = float(args[i + 1]); del args[i:i + 2]
    if "--out" in args:
        i = args.index("--out"); out = args[i + 1]; del args[i:i + 2]
    if "--override-stock" in args:
        args.remove("--override-stock"); override = True
    if len(args) != 1:
        sys.exit(__doc__)
    build(args[0], out, fog, override)
    if not override:
        with open(NATIVE_HEADER, "w", newline="\n") as f:
            f.write(make_header(args[0], out))
        print("wrote %s" % NATIVE_HEADER)


if __name__ == "__main__":
    main(sys.argv[1:])
