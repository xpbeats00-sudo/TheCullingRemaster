"""Main-menu background: Jungle center arena on the left, Prison center arena
on the right, an open sky, and the warehouse shell removed.

The arena levels are copies of the match levels saved under new package
names in /Game/Maps/FrontEnd/ (the real match maps are untouched). Their
actors are moved into place by rewriting root-component locations; actors
that don't belong in the menu are dropped far below the scene. FrontEnd.umap
gets one always-loaded streaming entry per added level.

usage: python build_menu_arenas.py <Paks dir>
"""
import math
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from level_survey import export_props, vector  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from ue_package import UPackage  # noqa: E402
from uasset import Package  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "src", "Victory", "Content", "Maps", "FrontEnd")
HIDE = "hide"
KEEP = "keep"
HIDE_DROP = -200000.0          # far below the menu scene

# The character stands near (190, 15, 0); the home camera looks down +X.
# Airdrop/Perks cameras look toward -Y, Customization toward +X+Y.
# Each arena (ring radius ~2,700) sits ~30 degrees off the home view's
# center line, so Jungle fills the left half and Prison the right half.
CHARACTER = (190.0, 15.0, 0.0)
# Arena bases sink ~300 below the sea (z = 21) so no sky shows underneath.
ARENA_Z = -320.0
JUNGLE_AT = (6500.0, -3800.0, ARENA_Z)
PRISON_AT = (6500.0, 3800.0, ARENA_Z)
# Second copies for the side views (out of the home camera's field of view):
# Jungle straight ahead of the Airdrop/Perks cameras (looking -Y from x 8..881),
# Prison straight ahead of the Appearance cameras (looking +Y from x ~-25).
JUNGLE_SIDE_AT = (900.0, -8000.0, ARENA_Z)
PRISON_SIDE_AT = (-600.0, 8500.0, ARENA_Z)


def offset(target, source_center):
    return tuple(target[i] - source_center[i] for i in range(3))


def shifted(loc, delta):
    return tuple(loc[i] + delta[i] for i in range(3))


def within(loc, center, radius):
    return math.hypot(loc[0] - center[0], loc[1] - center[1]) <= radius


# Prison ground pieces are single huge meshes anchored at the arena center;
# moved with it they cover the whole menu (and the sea) at knee height.
PRISON_GROUND = ("ParkingLot_", "PrisonYard_", "PrisonCell_Sidewalk", "Prison_Shipping_")


def arena_rule(center, radius, target, drop_meshes=()):
    """Keep what's within `radius` of the arena center, moved so the center
    lands on `target`; hide everything else and any mesh in drop_meshes."""
    delta = offset(target, center)

    def rule(actor, loc):
        if actor["mesh"].startswith(drop_meshes):
            return HIDE
        # The level's foliage actor sits at the origin but holds every tree
        # on the map; moved with the arena they floated over the sea.
        if actor["class"] == "InstancedFoliageActor":
            return HIDE
        loc = loc or (0.0, 0.0, 0.0)
        return shifted(loc, delta) if within(loc, center, radius) else HIDE
    return rule


# Night: the dome shows a painted starry night (make_night_sky.py: nebula
# band, stars, moon, low clouds) from a menu-only copy of the day panorama;
# the day's horizon/zenith color overlay and sun disc stay off (as in the
# original day setup, overlay multiplier 0), and the tint goes back to white.
NIGHT_SKY_PACKAGE = "/Game/Maps/FrontEnd/MenuNightSky"
DAY_SKY_PACKAGE = "/Game/Environment/Sky/03-29_Sunset"
# The sky light's cubemap (ambient light and the sea's reflections): the night
# sky rendered by make_night_cube.py instead of the day sunset.
NIGHT_CUBE_PACKAGE = "/Game/Maps/FrontEnd/MenuNightCube"
DAY_CUBE_PACKAGE = "/Game/Environment/Culling/Textures/03-29_Sunset"
# The moon is the material's own sun disc, drawn toward "Light direction":
# a world direction, so it lands exactly where it's aimed (the panorama's
# azimuth mapping isn't known, so the painted sky has no front). It hangs
# just right of the character's head in the home camera (whose field of
# view is only 45 degrees, so it sees just 0-16 degrees of sky): 6.5 right,
# 11 up. The moonlight (the level's directional light) comes from it,
# lighting the character's front.
MOON_YAW, MOON_ELEVATION = 6.5, 11.0
_moon = (math.cos(math.radians(MOON_ELEVATION)) * math.cos(math.radians(MOON_YAW)),
         math.cos(math.radians(MOON_ELEVATION)) * math.sin(math.radians(MOON_YAW)),
         math.sin(math.radians(MOON_ELEVATION)))
MOON_LIGHT_DIRECTION = (-_moon[0], -_moon[1], -_moon[2], 1.0)       # light travels away from the moon
MOON_LIGHT_ROTATION = (-MOON_ELEVATION, MOON_YAW - 180.0, 0.0)       # pitch, yaw, roll
# The painted sky at 0.6: auto exposure lifted it to a bright royal blue.
# Live layers the sky material animates itself (its parent's engine textures
# fill in where this level's instance has none): two layers of dark night
# clouds panning across the sky, their edges rim-lit toward the moon, and the
# engine star field with its shimmer on top of the painted stars.
# Thin, dark wisps (at 0.55 opacity they were a flat grey overcast that hid
# the stars).
SKY_LIVE = {"Cloud opacity": 0.22, "Cloud speed": 1.5, "Secondary clouds opacity": 0.12,
            "Rim light brightness": 3.5, "Rim light spread": 0.45}
SKY_MATERIAL_SCALARS = {"Custom sky multiplier": 0.6, "Horizon/zenith overlay intensity": 0.0,
                        "Sun brightness": 8.0, "Sun Radius": 0.002,
                        "Stars brightness": 1.6, "Stars tiling": 11.0, **SKY_LIVE}
CLOUD_COLOR = (0.02, 0.026, 0.05, 1.0)
SKY_MATERIAL_COLORS = {"Overall color": (1.0, 1.0, 1.0, 1.0), "Sun color": (0.80, 0.86, 1.0, 0.0),
                       "Light direction": MOON_LIGHT_DIRECTION,
                       "Cloud color": CLOUD_COLOR, "Cloud center color": (0.01, 0.013, 0.028, 1.0)}
SKY_ACTOR_FLOATS = {"Custom sky multiplier": 0.6, "Horizon/Zenith multiplier": 0.0,
                    "Sun brightness": 8.0, "Sun Radius": 0.002, **SKY_LIVE}
SKY_ACTOR_COLORS = {"Sun color": SKY_MATERIAL_COLORS["Sun color"], "Cloud color": CLOUD_COLOR}
SKY_FOG = None
# Moonlight: the (movable) sun and sky light turned way down, cool tint.
# Far shadow cascades off: with both islands loaded they redrew thousands of
# distant meshes into the shadow maps every frame (menu fell to ~25-70 FPS).
# Ray-traced distance field shadows off: with the moon only 11 degrees up
# every shadow ray crossed the whole arena (Perks fell from ~280 to ~33 FPS).
SUN_SETTINGS = {"Intensity": 0.35, "Temperature": 9000.0,
                "FarShadowCascadeCount": 0, "FarShadowDistance": 0.0,
                "DynamicShadowDistanceMovableLight": 5000.0, "DistanceFieldShadowDistance": 0.0}
SUN_FLAGS = {"bUseRayTracedDistanceFieldShadows": ("BoolProperty", False)}
SKY_LIGHT_SETTINGS = {"Intensity": ("FloatProperty", 0.5)}
# The sky sphere sits at scale 40 (millions of units across). At scale 8
# (~400,000 across) it still encloses both islands. (The pale teal that hid
# it was FrontEnd_Default's fog, see MENU_FOG.)
SKY_SPHERE_SCALE = 8.0

# FrontEnd_Default's indoor fog has almost no height falloff, so moving it
# down did nothing: it filled the whole world with teal (0.35, 0.65, 0.58).
# It becomes moonlit night fog that hugs the sea instead (density halves
# every ~500 units of height): the character and props (inside StartDistance)
# stay clear, the arenas read through a light haze, the horizon fades into
# navy, and the stars overhead stay clear.
MENU_FOG = {"FogDensity": ("FloatProperty", 0.1),
            "FogHeightFalloff": ("FloatProperty", 2.0),
            "StartDistance": ("FloatProperty", 2500.0),
            "FogMaxOpacity": ("FloatProperty", 0.92),
            "FogInscatteringColor": ("LinearColor", (0.018, 0.024, 0.055, 1.0)),
            "DirectionalInscatteringColor": ("LinearColor", (0.05, 0.07, 0.14, 1.0))}


def tune_sky(data):
    pkg = Package(data)
    out = bytearray(data)
    for export in (e for e in pkg.exports if str(pkg.ref(e["class"])) == "MaterialInstanceDynamic"):
        for param, value in SKY_MATERIAL_SCALARS.items():
            set_named_param(pkg, out, export, param, "ParameterValue", value)
        for param, color in SKY_MATERIAL_COLORS.items():
            set_named_color(pkg, out, export, param, color)
    # The sky blueprint pushes its own variables into the material at
    # runtime, so set them on the placed sky actor as well.
    sky = next(e for e in pkg.exports if str(pkg.ref(e["class"])) == "BP_Victory_Sky_C")
    props = export_props(pkg, pkg.exports.index(sky) + 1)
    for prop, value in SKY_ACTOR_FLOATS.items():
        struct.pack_into("<f", out, props[prop][1], value)
    for prop, color in SKY_ACTOR_COLORS.items():
        struct.pack_into("<4f", out, props[prop][1], *color)
    sky_index = pkg.exports.index(sky) + 1
    sun = next(e for e in pkg.exports if str(pkg.ref(e["class"])) == "DirectionalLightComponent")
    props = export_props(pkg, pkg.exports.index(sun) + 1)
    for prop, value in SUN_SETTINGS.items():
        fmt = "<i" if props[prop][0] == "IntProperty" else "<f"
        struct.pack_into(fmt, out, props[prop][1], value)
    if SKY_FOG:
        fog_export, values = SKY_FOG
        props = export_props(pkg, pkg.exports.index(pkg.export(fog_export)) + 1)
        for prop, value in values.items():
            struct.pack_into("<f", out, props[prop][1], value)
    for a, root in actor_roots(pkg):
        if str(pkg.ref(pkg.exports[a - 1]["class"])).startswith("BP_Victory_Sky"):
            rp = export_props(pkg, root)
            struct.pack_into("<3f", out, rp["RelativeScale3D"][1], *(SKY_SPHERE_SCALE,) * 3)
        if str(pkg.ref(pkg.exports[a - 1]["class"])) == "DirectionalLight":
            rp = export_props(pkg, root)
            struct.pack_into("<3f", out, rp["RelativeRotation"][1], *MOON_LIGHT_ROTATION)
    # The sky light stores no Intensity (default 1.0), so insert one.
    up = UPackage(bytes(out))
    sky_light = next(i for i, e in enumerate(pkg.exports, 1)
                     if str(pkg.ref(e["class"])) == "SkyLightComponent")
    set_export_props(up, sky_light, SKY_LIGHT_SETTINGS)
    set_export_props(up, pkg.exports.index(sun) + 1, SUN_FLAGS)
    # "Overall Color" isn't stored on the placed sky (default white): add it.
    set_export_props(up, sky_index, {"Overall Color": ("LinearColor", SKY_MATERIAL_COLORS["Overall color"])})
    # Point the dome's texture and the sky light's cubemap at the menu-only
    # night versions.
    swaps = {DAY_SKY_PACKAGE: NIGHT_SKY_PACKAGE, DAY_CUBE_PACKAGE: NIGHT_CUBE_PACKAGE}
    for k, imp in enumerate(up.imports):
        class_name, outer, obj, num = struct.unpack_from("<8xi4xiii", imp)
        if up.names[obj][0] in swaps and up.names[class_name][0] == "Package":
            up.imports[k] = imp[:20] + up.fname(swaps.pop(up.names[obj][0]))
    assert not swaps, swaps
    return up.save()


def iter_tags(up, data):
    """Yield (name, type, tag start, value offset, size) for each tagged property."""
    p = 0
    while p < len(data):
        idx, num = struct.unpack_from("<ii", data, p)
        name = up.names[idx][0]
        if name == "None":
            return
        ptype = up.names[struct.unpack_from("<i", data, p + 8)[0]][0]
        size = struct.unpack_from("<i", data, p + 16)[0]
        q = p + 24
        if ptype == "StructProperty":
            q += 8 + 16
        elif ptype == "BoolProperty":
            q += 1
        elif ptype in ("ByteProperty", "EnumProperty", "ArrayProperty"):
            q += 8
        has_guid = data[q]
        q += 1 + (16 if has_guid else 0)
        yield name, ptype, p, q, size
        p = q + size


def encode_tag(up, name, kind, value):
    """kind: FloatProperty, BoolProperty, or a struct name (Vector, Rotator, Color)."""
    if kind == "FloatProperty":
        return up.fname(name) + up.fname("FloatProperty") + struct.pack("<ii", 4, 0) + b"\0" + struct.pack("<f", value)
    if kind == "IntProperty":
        return up.fname(name) + up.fname("IntProperty") + struct.pack("<ii", 4, 0) + b"\0" + struct.pack("<i", value)
    if kind == "BoolProperty":
        return up.fname(name) + up.fname("BoolProperty") + struct.pack("<ii", 0, 0) + bytes([1 if value else 0]) + b"\0"
    raw = {"Vector": "<3f", "Rotator": "<3f", "Color": "<4B", "LinearColor": "<4f"}[kind]
    blob = struct.pack(raw, *value)
    return (up.fname(name) + up.fname("StructProperty") + struct.pack("<ii", len(blob), 0)
            + up.fname(kind) + b"\0" * 16 + b"\0" + blob)


def set_export_props(up, index, values):
    """values: {prop: (kind, value)}. Replace each property's tag if present,
    otherwise add it at the front of the export's tagged properties."""
    e = up.exports[index - 1]
    data = e["data"]
    existing = {name: (start, voff + size) for name, ptype, start, voff, size in iter_tags(up, data)}
    for prop, (kind, value) in values.items():
        tag = encode_tag(up, prop, kind, value)
        if prop in existing:
            start, end = existing[prop]
            data = data[:start] + tag + data[end:]
            existing = {name: (s, v + z) for name, t, s, v, z in iter_tags(up, data)}
        else:
            data = tag + data
            existing = {name: (s, v + z) for name, t, s, v, z in iter_tags(up, data)}
    e["data"] = data


# Arena floodlights: the warehouse's spare movable spotlights, six on a ring
# above each arena (main and side copies), aimed down into it. Moonlit blue
# (warm white glared orange behind the perk machine), shadowless to keep the
# frame rate. Each aims at its own spot across the
# arena floor (the ring point 120 degrees round, pulled in to FLOOD_AIM_RADIUS):
# all six on the center stacked into one blown-out white hot spot.
# Above and outside the ring trusses: at 2,800 out / 2,600 up the lamps sat
# right against the trusses and blew their lamp heads and banners out white.
FLOOD_RING_RADIUS = 3600.0
FLOOD_HEIGHT = 4200.0
FLOOD_PER_ARENA = 6
FLOOD_AIM_RADIUS = 1300.0
FLOOD_AIM_HEIGHT = 300.0                     # arena floor, above the sea


def floodlight_spots():
    spots = []
    for center in (JUNGLE_AT, PRISON_AT, JUNGLE_SIDE_AT, PRISON_SIDE_AT):
        for k in range(FLOOD_PER_ARENA):
            a = 2 * math.pi * k / FLOOD_PER_ARENA
            loc = (center[0] + FLOOD_RING_RADIUS * math.cos(a),
                   center[1] + FLOOD_RING_RADIUS * math.sin(a),
                   center[2] + FLOOD_HEIGHT)
            b = a + 2 * math.pi / 3
            target = (center[0] + FLOOD_AIM_RADIUS * math.cos(b),
                      center[1] + FLOOD_AIM_RADIUS * math.sin(b),
                      center[2] + FLOOD_AIM_HEIGHT)
            spots.append((loc, aim(loc, target)))
    return spots


# Facade wash: the floodlights light the arenas from above, so the sides the
# menu cameras look at stayed black. Two wide, cool moonlit spots per arena
# stand between its camera and the arena, aimed at that face.
WASH_COLOR = (255, 150, 110, 255)               # BGRA: blue moonlight


def arena_wash_lights():
    views = [(JUNGLE_AT, (-158.0, 25.0)), (PRISON_AT, (-158.0, 25.0)),         # home camera
             (JUNGLE_SIDE_AT, (450.0, -120.0)),                               # airdrop / perks
             (PRISON_SIDE_AT, (-100.0, 250.0))]                               # character cameras
    lights = []
    for arena, cam in views:
        dx, dy = arena[0] - cam[0], arena[1] - cam[1]
        dist = math.hypot(dx, dy)
        ux, uy = dx / dist, dy / dist
        for side in (-1, 1):
            loc = (cam[0] + 0.45 * dx - side * 0.18 * dist * uy,
                   cam[1] + 0.45 * dy + side * 0.18 * dist * ux, 1500.0)
            target = (arena[0] - side * 900.0 * uy, arena[1] + side * 900.0 * ux, 500.0)
            lights.append((loc, target, 3000.0, 0.75 * dist, 45.0, WASH_COLOR))
    return lights


# Night key lights so the player can see their character and the menu props:
# (position, aim point, intensity, radius, cone).
MENU_LIGHTS = [
    ((-60.0, -260.0, 320.0), (190.0, 15.0, 100.0), 9000.0, 1600.0, 40.0),   # key on the character
    ((-60.0, 320.0, 260.0), (190.0, 15.0, 100.0), 4000.0, 1600.0, 40.0),    # fill on the character
    ((150.0, -560.0, 520.0), (140.0, -620.0, 0.0), 9000.0, 1400.0, 55.0),   # airdrop crates
    ((883.0, -560.0, 480.0), (883.0, -936.0, 120.0), 7000.0, 1400.0, 40.0),  # perk station
    # Weapon skins: the preview weapon floats at ~(-52, 512, 83), ~100 in
    # front of CAMERA_WEAPON (-70, 410, 95) - key, fill, and a rim from
    # behind so it separates from the lit arena behind it.
    ((-190.0, 420.0, 230.0), (-52.0, 512.0, 83.0), 5000.0, 500.0, 30.0),    # weapon key
    ((90.0, 430.0, 110.0), (-52.0, 512.0, 83.0), 2500.0, 500.0, 30.0),      # weapon fill
    ((-40.0, 680.0, 230.0), (-52.0, 512.0, 83.0), 4000.0, 500.0, 30.0),     # weapon rim
    # The customization character (PlayerPawn_Customize, (-60, 617)), seen by
    # the character/flair/outfit cameras from ~(-140, 90) looking +Y.
    ((-330.0, 330.0, 300.0), (-60.0, 617.0, 110.0), 6000.0, 1000.0, 35.0),  # character key
    ((200.0, 400.0, 180.0), (-60.0, 617.0, 100.0), 2500.0, 900.0, 40.0),    # character fill
    ((-60.0, 920.0, 330.0), (-60.0, 617.0, 140.0), 5000.0, 700.0, 35.0),    # character rim
    # The storage shelf and its crates, left of the airdrop crates.
    ((150.0, -500.0, 350.0), (-180.0, -960.0, 120.0), 5000.0, 900.0, 40.0),   # airdrop shelf
] + arena_wash_lights()


def aim(src, dst):
    dx, dy, dz = (dst[i] - src[i] for i in range(3))
    return (math.degrees(math.atan2(dz, math.hypot(dx, dy))), math.degrees(math.atan2(dy, dx)), 0.0)


def add_floodlights(data):
    pkg = Package(data)
    lights = [root for a, root in actor_roots(pkg)
              if str(pkg.ref(pkg.exports[a - 1]["class"])) == "SpotLight"]
    spots = floodlight_spots()
    assert len(lights) >= len(spots) + len(MENU_LIGHTS), "not enough spare spotlights"
    up = UPackage(data)
    for root, (loc, target, intensity, radius, cone, *color) in zip(lights[len(spots):], MENU_LIGHTS):
        set_export_props(up, root, {
            "RelativeLocation": ("Vector", loc),
            "RelativeRotation": ("Rotator", aim(loc, target)),
            "RelativeScale3D": ("Vector", (1.0, 1.0, 1.0)),
            "Intensity": ("FloatProperty", intensity),
            "AttenuationRadius": ("FloatProperty", radius),
            "OuterConeAngle": ("FloatProperty", cone),
            "InnerConeAngle": ("FloatProperty", cone * 0.5),
            "MaxDrawDistance": ("FloatProperty", 0.0),
            "CastShadows": ("BoolProperty", False),
            "LightColor": ("Color", color[0] if color else (255, 235, 220, 255)),  # BGRA: cool white
        })
    for root, (loc, rot) in zip(lights, spots):
        set_export_props(up, root, {
            "RelativeLocation": ("Vector", loc),
            "RelativeRotation": ("Rotator", rot),
            "RelativeScale3D": ("Vector", (1.0, 1.0, 1.0)),
            "Intensity": ("FloatProperty", 1500.0),
            "AttenuationRadius": ("FloatProperty", 8000.0),
            "OuterConeAngle": ("FloatProperty", 40.0),
            "InnerConeAngle": ("FloatProperty", 22.0),
            "MaxDrawDistance": ("FloatProperty", 0.0),
            "CastShadows": ("BoolProperty", False),
            "LightColor": ("Color", (255, 120, 70, 255)),           # BGRA: deep blue
        })
    return up.save(), min(len(lights), len(spots))


def set_named_param(pkg, out, export, param, value_prop, value):
    """In an array of {ParameterName/Name, <value_prop>} structs, set the float
    value of the entry named `param`."""
    needle = struct.pack("<ii", pkg.names.index(param), 0)
    tag = (struct.pack("<ii", pkg.names.index(value_prop), 0)
           + struct.pack("<ii", pkg.names.index("FloatProperty"), 0) + struct.pack("<ii", 4, 0))
    start, end = export["offset"], export["offset"] + export["size"]
    i = bytes(out).find(needle, start, end)
    j = bytes(out).find(tag, i, min(i + 200, end)) if i >= 0 else -1
    if j < 0:
        raise KeyError("%s not found in %s" % (param, export["name"]))
    struct.pack_into("<f", out, j + len(tag) + 1, value)


# The whole Prison map as a backdrop on the horizon (fills the empty sky).
# Its terrain spans x -50,777..76,223 and y +-50,800 around the prison
# center, so the center goes 66,000 ahead: the near edge then starts ~15,000
# out, behind the arenas. Dropped 1,500 so the plateau (~z 2,400) sits ~900
# above our sea and the low ground floods.
ISLAND_AT = (66000.0, 0.0, -1500.0)
# Off: the islands' rocks and floating tree lines blocked the view and cost
# ~200 FPS; heavy night fog (MENU_FOG) gives the depth instead.
ISLAND_BACKDROPS = False
ISLAND_LEVELS = ("Landscape", "Structures", "CellBlock_E", "CellBlock_NE", "CellBlock_NW",
                 "CellBlock_SE", "CellBlock_SW", "CellBlock_W", "ExteriorFences", "Towers",
                 "GuardStations", "GasStations", "Sewer", "Cave", "Boundary")
# Scenery only: gameplay spawners, lights, particles and decals cost frame
# time and can't be seen from 66,000 away.
ISLAND_KEEP = ("StaticMeshActor", "SkeletalMeshActor", "Landscape", "InstancedFoliageActor",
               "CullDistanceVolume", "FenceJunction_C", "Center_Ring_Walls")


# The whole Jungle map as the backdrop for the left-facing cameras (Airdrop,
# Perks). Its terrain spans x -76,200..101,600 and y +-76,200 around the
# island center (land within ~+-60,000); centered at (-20,000, -85,000) all of
# it stays clear of the menu, its land faces the -Y cameras, and it doesn't
# overlap the Prison island. Its sea level is our sea level, so no drop.
JUNGLE_ISLAND_AT = (-20000.0, -85000.0, 0.0)
JUNGLE_ISLAND_LEVELS = ("Landscape_ue4_8", "Unmerged_Rocks", "Structures", "Static_VistaBunker",
                        "RedDoor", "Dynamic_Airport_v1", "Dynamic_AirportOutBuildings_v1",
                        "Dynamic_E1_Bunker_v1", "Dynamic_E1_v1", "Dynamic_E2", "Dynamic_E2_Bunker_v1",
                        "Dynamic_N1_v1", "Dynamic_NW1_v1", "Dynamic_N_Hotel_v1", "Dynamic_S1_v1",
                        "Dynamic_SE1_v1", "Dynamic_SW1_v1", "Dynamic_SW3", "Dynamic_TunnelRoomEast",
                        "Dynamic_W1_v1", "Dynamic_W2_v1", "Dynamic_W3_v1",
                        "Dynamic_W_Lab_OutBuildings_v1", "Dynamic_W_Lab_v1", "Dynamic_W_PowerRelay")


def island_rule(target):
    def rule(actor, loc):
        cls = actor["class"]
        if cls in ISLAND_KEEP or cls.startswith(("Door_", "Center_Ring_Walls")):
            return shifted(loc or (0.0, 0.0, 0.0), target)
        return HIDE
    return rule


def set_named_color(pkg, out, export, param, color):
    """Like set_named_param, for a LinearColor ParameterValue."""
    needle = struct.pack("<ii", pkg.names.index(param), 0)
    tag = (struct.pack("<ii", pkg.names.index("ParameterValue"), 0)
           + struct.pack("<ii", pkg.names.index("StructProperty"), 0) + struct.pack("<ii", 16, 0)
           + struct.pack("<ii", pkg.names.index("LinearColor"), 0))
    start, end = export["offset"], export["offset"] + export["size"]
    i = bytes(out).find(needle, start, end)
    j = bytes(out).find(tag, i, min(i + 200, end)) if i >= 0 else -1
    if j < 0:
        raise KeyError("%s not found in %s" % (param, export["name"]))
    struct.pack_into("<4f", out, j + len(tag) + 16 + 1, *color)   # + struct guid + HasPropertyGuid


def ring_dressing_rule(target):
    """The Jungle ring's overhead lights and logo signs live in the Lighting
    level; this copy keeps only them, moved with a Jungle arena copy."""
    def rule(actor, loc):
        if actor["mesh"].startswith(("Center_Ring_Lighting", "Culling_Logo_Sign")):
            return shifted(loc or (0.0, 0.0, 0.0), target)
        return HIDE
    return rule


def sky_rule(actor, loc):
    """Jungle Lighting level: keep sky, sun, sky light and sea; the ring
    lights and logo signs belong to the Jungle arena; drop the rest."""
    name, cls, mesh = actor["name"], actor["class"], actor["mesh"]
    # The post-process volume stays: it sets exposure and turns off costly
    # defaults (dropping it took the menu from ~300 FPS to ~30). The fog goes:
    # with it on, the menu fell from ~250 FPS to ~30-100.
    if any(k in cls for k in ("ReflectionCapture", "LevelLoaded", "ExponentialHeightFog")):
        return HIDE
    if mesh.startswith("Center_Ring_Lighting") or mesh.startswith("Culling_Logo_Sign"):
        return shifted(loc or (0.0, 0.0, 0.0), offset(JUNGLE_AT, (0.0, 0.0, 0.0)))
    if mesh.startswith("Jungle_Water_Plane"):         # river; Arena_Sea replaces it
        return HIDE
    return KEEP


# Sky events: hidden warehouse effect emitters lifted out into the sky and
# pointed at the menu's own effects - meteors (make_meteors.py) flying along
# their emitter's +X, and supernovas / hyperdrive bursts (make_sky_fx.py).
# Each sits where one group of menu cameras looks:
# (emitter, effect package, effect object, location, rotation, scale).
def _sky_spot(yaw, elevation, distance):
    y, e = math.radians(yaw), math.radians(elevation)
    return (distance * math.cos(e) * math.cos(y), distance * math.cos(e) * math.sin(y), distance * math.sin(e))


METEOR_PS = "PS_TS_FireworksShell"
SUPERNOVA_PS = "PS_TS_Fireworks_Burst_Chrys"
HYPERDRIVE_PS = "PS_TS_Fireworks_Burst_Palm"
SKY_FX = [
    ("P_Damaged_Electrical_Constant_11", "MenuMeteor_A", METEOR_PS, (55000.0, -14000.0, 9500.0), (-10.0, 90.0, 0.0), 1.0),  # home
    ("P_Dynamite_Fuse_2", "MenuMeteor_B", METEOR_PS, (-26000.0, -52000.0, 15000.0), (-12.0, 0.0, 0.0), 1.0),                # airdrop, perks
    ("P_Culling_GasCanisterStart_20", "MenuMeteor_C", METEOR_PS, (20000.0, 55000.0, 8500.0), (-8.0, 180.0, 0.0), 1.0),      # character views
    # Home camera: yaw 0, 45 degree view, sees 0-16 degrees of sky.
    ("P_Damaged_Electrical_8", "MenuSupernova_Home", SUPERNOVA_PS, _sky_spot(-8.0, 11.0, 45000.0), (0.0, 0.0, 0.0), 2.5),
    ("P_Steam_falling_line_strong2", "MenuHyperdrive_Home", HYPERDRIVE_PS, _sky_spot(15.0, 6.0, 50000.0), (0.0, 0.0, 0.0), 2.5),
    # Airdrop / perks cameras look -Y; character cameras look +Y.
    ("P_ShowerSteam_23", "MenuHyperdrive_Side", HYPERDRIVE_PS, (6000.0, -50000.0, 14000.0), (0.0, 0.0, 0.0), 3.0),
    ("P_Steam_falling_17", "MenuSupernova_Character", SUPERNOVA_PS, (-4000.0, 52000.0, 6500.0), (0.0, 0.0, 0.0), 2.5),
]
SKY_FX_AT = {emitter: loc for emitter, _, _, loc, _, _ in SKY_FX}


def add_sky_fx(data):
    """Point the moved emitters at the sky effects, aim and size them."""
    up = UPackage(data)
    imports = {}
    for _, package, ps, _, _, _ in SKY_FX:
        outer = up.add_import("/Script/CoreUObject", "Package", 0, "/Game/Maps/FrontEnd/" + package)
        imports[package] = up.add_import("/Script/Engine", "ParticleSystem", outer, ps)
    data = up.save()
    pkg = Package(data)
    up = UPackage(data)
    placed = 0
    for a, root in actor_roots(pkg):
        name = pkg.exports[a - 1]["name"]
        for emitter, package, _, _, rot, scale in SKY_FX:
            if name != emitter:
                continue
            set_export_props(up, root, {
                "RelativeRotation": ("Rotator", rot), "RelativeScale3D": ("Vector", (scale,) * 3),
                "LDMaxDrawDistance": ("FloatProperty", 0.0), "CachedMaxDrawDistance": ("FloatProperty", 0.0),
                "bAllowCullDistanceVolume": ("BoolProperty", False)})
            placed += 1
    data = up.save()
    # Template is an object reference: patch it in place.
    pkg = Package(data)
    out = bytearray(data)
    for a, root in actor_roots(pkg):
        for emitter, package, _, _, _, _ in SKY_FX:
            if pkg.exports[a - 1]["name"] == emitter:
                props = export_props(pkg, root)
                struct.pack_into("<i", out, props["Template"][1], imports[package])
    return bytes(out), placed


WALL_HUNG = {"AutoBow", "CompoundBow", "Rifle", "SMG", "Bat", "SurvivalAxe", "SurvivalSpear"}


def warehouse_rule(actor, loc):
    """Warehouse: the round tutorial-hub platform becomes the character's
    stage; props around the character stay; the rest goes."""
    if actor["name"] in SKY_FX_AT:
        return SKY_FX_AT[actor["name"]]
    if actor["mesh"].startswith("Tutorial_Hub_Center_Platform"):
        return (CHARACTER[0], CHARACTER[1], 0.0)
    if loc is None:
        return KEEP
    # The perk vending machine, right where the Perks camera looks.
    if actor["class"].startswith("PerkStation"):
        return KEEP
    # Wires, vines, pipes and fixtures hung from the (now gone) ceiling.
    if loc[2] > 250.0:
        return HIDE
    # Lockers, fridge, trident, light switches... lined up along the (now
    # gone) back wall, floating behind the customization character.
    if loc[1] > 850.0:
        return HIDE
    # Switches, wiring and the weapons hung on the (gone) front wall, floating
    # behind the airdrop crates; the storage shelf and its crates stay.
    if actor["mesh"].startswith("Interior_Wall") or (loc[1] < -950.0 and actor["mesh"] in WALL_HUNG):
        return HIDE
    return KEEP if within(loc, CHARACTER, 1100.0) else HIDE


# The sea: the Jungle's "water" is a river network (Jungle_Water_Plane_A)
# only a few thousand units wide around the menu; past its banks, where the
# island's land was, the sky showed through. One flat water plane from the
# Jungle's Water level, scaled to 200,000 units square in the river's own
# water material, replaces it at the river's height (one translucent layer:
# sea and river stacked halved the frame rate).
# The water fades with depth: over the stage platform (21 below) it reads as
# shallow, lit water; over nothing it turned into a flat mirror of the sky
# (the "gaps"). A seabed - the same plane in the stage's metal plating - sits
# under all of it so the whole sea looks like the water around the character.
SEA_SOURCE = "Water_Plane3_4"
SEA_SCALE = (1000.0, 1000.0, 1.0)            # base mesh is 200 x 200
SEA_AT = (0.0, 0.0, 21.0)
SEA_MATERIAL = ("Lake_Transparent_MI", None)  # already imported by the Water level
SEABED_AT = (0.0, 0.0, -30.0)
SEABED_MATERIAL = ("Metal_Diamond_Plating_MI", "/Game/Environment/Culling/Materials/Metal_Diamond_Plating_MI")


def plane_rule(at):
    def rule(actor, loc):
        return at if actor["name"] == SEA_SOURCE else HIDE
    return rule


def tune_plane(data, material):
    """Scale the kept water plane to sea size and give it `material`
    ((object name, package path to import, or None if already imported))."""
    name, package = material
    up = UPackage(data)
    if package:
        outer = up.add_import("/Script/CoreUObject", "Package", 0, package)
        mat = up.add_import("/Script/Engine", "MaterialInstanceConstant", outer, name)
    else:
        mat = next(-(i + 1) for i, imp in enumerate(up.imports)
                   if up.names[struct.unpack_from("<i", imp, 20)[0]][0] == name)
    data = up.save()
    pkg = Package(data)
    out = bytearray(data)
    for a, root in actor_roots(pkg):
        if pkg.exports[a - 1]["name"] != SEA_SOURCE:
            continue
        props = export_props(pkg, root)
        struct.pack_into("<3f", out, props["RelativeScale3D"][1], *SEA_SCALE)
        overrides = props["OverrideMaterials"][1]
        assert struct.unpack_from("<i", data, overrides)[0] == 1
        struct.pack_into("<i", out, overrides + 4, mat)
        for prop in ("LDMaxDrawDistance", "CachedMaxDrawDistance"):
            if prop in props:
                struct.pack_into("<f", out, props[prop][1], 0.0)
        return bytes(out)
    raise KeyError(SEA_SOURCE)


def menu_lighting_rule(actor, loc):
    """FrontEnd_Default: everything stays; the fog is retuned by tune_menu_fog."""
    return KEEP


def tune_menu_fog(data):
    pkg = Package(data)
    up = UPackage(data)
    fog = next(i for i, e in enumerate(pkg.exports, 1)
               if str(pkg.ref(e["class"])) == "ExponentialHeightFogComponent")
    set_export_props(up, fog, MENU_FOG)
    return up.save()


# (new package name or None to override in place, source level, rule)
LEVELS = [
    ("Arena_Sky", "Victory/Content/Maps/Jungle/Lighting.umap", sky_rule),
    ("Arena_Sea", "Victory/Content/Maps/Jungle/Water.umap", plane_rule(SEA_AT)),
    ("Arena_Seabed", "Victory/Content/Maps/Jungle/Water.umap", plane_rule(SEABED_AT)),
    ("Arena_Jungle_Core", "Victory/Content/Maps/Jungle/Structures.umap",
     arena_rule((0.0, 0.0, 0.0), 2500.0, JUNGLE_AT)),
    ("Arena_Jungle_Ring", "Victory/Content/Maps/Jungle/Center_Config_2.umap",
     arena_rule((0.0, 0.0, 0.0), 6000.0, JUNGLE_AT)),
    ("Arena_Prison_Core", "Victory/Content/Maps/Jungle2/Structures.umap",
     arena_rule((0.0, 0.0, 2165.0), 3500.0, PRISON_AT, PRISON_GROUND)),
    ("Arena_Prison_Ring", "Victory/Content/Maps/Jungle2/CenterConfig01.umap",
     arena_rule((0.0, 0.0, 2165.0), 6000.0, PRISON_AT)),
    ("Arena_JungleSide_Core", "Victory/Content/Maps/Jungle/Structures.umap",
     arena_rule((0.0, 0.0, 0.0), 2500.0, JUNGLE_SIDE_AT)),
    ("Arena_JungleSide_Ring", "Victory/Content/Maps/Jungle/Center_Config_2.umap",
     arena_rule((0.0, 0.0, 0.0), 6000.0, JUNGLE_SIDE_AT)),
    ("Arena_JungleSide_Lights", "Victory/Content/Maps/Jungle/Lighting.umap",
     ring_dressing_rule(JUNGLE_SIDE_AT)),
    ("Arena_PrisonSide_Core", "Victory/Content/Maps/Jungle2/Structures.umap",
     arena_rule((0.0, 0.0, 2165.0), 3500.0, PRISON_SIDE_AT, PRISON_GROUND)),
    ("Arena_PrisonSide_Ring", "Victory/Content/Maps/Jungle2/CenterConfig01.umap",
     arena_rule((0.0, 0.0, 2165.0), 6000.0, PRISON_SIDE_AT)),
] + ([
    ("PrisonIsland_" + level, "Victory/Content/Maps/Jungle2/%s.umap" % level, island_rule(ISLAND_AT))
    for level in ISLAND_LEVELS
] + [
    ("JungleIsland_" + level, "Victory/Content/Maps/Jungle/%s.umap" % level, island_rule(JUNGLE_ISLAND_AT))
    for level in JUNGLE_ISLAND_LEVELS
] if ISLAND_BACKDROPS else []) + [
    (None, "Victory/Content/Maps/FrontEnd/FrontEnd_TH.umap", warehouse_rule),
    (None, "Victory/Content/Maps/FrontEnd/FrontEnd_Default.umap", menu_lighting_rule),
]
# Levels made by other scripts, streamed in as well: (package, world name).
EXTRA_LEVELS = [("Arena_Moon", "Water")]           # make_moon.py
WAREHOUSE_SHELL_MESHES = {"FE_test"}            # the merged walls/ceiling/floor mesh
FRONTEND = "Victory/Content/Maps/FrontEnd/FrontEnd.umap"


def actor_roots(pkg):
    """Yield (actor export index, root component index) for every actor."""
    for i, e in enumerate(pkg.exports, 1):
        if e["size"] > 300000:
            continue
        props = export_props(pkg, i)
        if "RootComponent" in props:
            root = struct.unpack_from("<i", pkg.data, props["RootComponent"][1])[0]
            if root > 0:
                yield i, root


def apply_rule(data, rule):
    """Run rule(actor, loc) for every actor and write the result:
    a location tuple, KEEP, or HIDE. Returns (bytes, moved, hidden, kept)."""
    pkg = Package(data)
    out = bytearray(data)
    inserts = {}                                   # root -> new location
    hidden_roots = set()
    moved = hidden = kept = 0
    for a, root in actor_roots(pkg):
        props = export_props(pkg, root)
        mesh = props.get("StaticMesh")
        actor = {
            "name": pkg.exports[a - 1]["name"],
            "class": str(pkg.ref(pkg.exports[a - 1]["class"])),
            "mesh": str(pkg.ref(struct.unpack_from("<i", data, mesh[1])[0])) if mesh else "",
        }
        has_loc = "RelativeLocation" in props
        loc = vector(pkg, props["RelativeLocation"][1]) if has_loc else None
        result = rule(actor, loc)
        if result == KEEP:
            kept += 1
            continue
        if result == HIDE:
            new = shifted(loc or (0.0, 0.0, 0.0), (0.0, 0.0, HIDE_DROP))
            hidden += 1
        else:
            new = result
            moved += 1
        if has_loc:
            struct.pack_into("<3f", out, props["RelativeLocation"][1], *new)
        else:
            inserts[root] = new
        if result == HIDE:
            hidden_roots.add(root)
    strip_hidden(pkg, out, hidden_roots)
    return add_locations(bytes(out), inserts), moved, hidden, kept


def strip_hidden(pkg, out, hidden_roots):
    """Dropped actors still cost frame time (meshes, lights, particles,
    decals). Blank those references on every component under a hidden root."""
    parent = {}
    for i, e in enumerate(pkg.exports, 1):
        if e["size"] > 300000:
            continue
        props = export_props(pkg, i)
        if "AttachParent" in props:
            parent[i] = struct.unpack_from("<i", pkg.data, props["AttachParent"][1])[0]

    def is_hidden(i):
        seen = 0
        while i > 0 and seen < 64:
            if i in hidden_roots:
                return True
            i = parent.get(i, 0)
            seen += 1
        return False

    for i, e in enumerate(pkg.exports, 1):
        if e["size"] > 300000 or not is_hidden(i):
            continue
        props = export_props(pkg, i)
        # Shrink hidden roots: a sky sphere (scale 40, mesh from its blueprint
        # so it can't be blanked) still wrapped the camera from 200,000 below
        # and covered the real sky.
        if i in hidden_roots and "RelativeScale3D" in props:
            struct.pack_into("<3f", out, props["RelativeScale3D"][1], 0.001, 0.001, 0.001)
        for ref in ("StaticMesh", "Template", "DecalMaterial"):
            if ref in props and props[ref][0] == "ObjectProperty":
                struct.pack_into("<i", out, props[ref][1], 0)
        if "Intensity" in props and props["Intensity"][0] == "FloatProperty":
            struct.pack_into("<f", out, props["Intensity"][1], 0.0)
        # Height fog with little falloff covers the world wherever it sits.
        if "FogDensity" in props:
            struct.pack_into("<f", out, props["FogDensity"][1], 0.0)


def add_locations(data, inserts):
    """Root components at the exact origin store no RelativeLocation; insert
    the property tag with the wanted location."""
    if not inserts:
        return data
    up = UPackage(data)
    for root, loc in inserts.items():
        tag = (up.fname("RelativeLocation") + up.fname("StructProperty") + struct.pack("<ii", 12, 0)
               + up.fname("Vector") + b"\0" * 16 + b"\0" + struct.pack("<3f", *loc))
        e = up.exports[root - 1]
        e["data"] = tag + e["data"]
    return up.save()


def clear_meshes(data, mesh_names):
    """Point StaticMeshComponents using these meshes at no mesh (renders nothing)."""
    pkg = Package(data)
    out = bytearray(data)
    cleared = 0
    for i, e in enumerate(pkg.exports, 1):
        if not str(pkg.ref(e["class"])).endswith("StaticMeshComponent"):
            continue
        props = export_props(pkg, i)
        if "StaticMesh" in props:
            off = props["StaticMesh"][1]
            if str(pkg.ref(struct.unpack_from("<i", data, off)[0])) in mesh_names:
                struct.pack_into("<i", out, off, 0)
                cleared += 1
    return bytes(out), cleared


def no_depth_of_field(data):
    """Every menu camera blurs what lies past the character (Gaussian depth of
    field, far blur 1-4% of the screen): with arenas behind instead of a
    warehouse wall it just smeared them. Far blur goes to 0 on all cameras."""
    pkg = Package(data)
    out = bytearray(data)
    names = [n if isinstance(n, str) else n[0] for n in pkg.names]
    tag = struct.pack("<iiiiii", names.index("DepthOfFieldFarBlurSize"), 0, names.index("FloatProperty"), 0, 4, 0)
    count = 0
    for e in pkg.exports:
        if str(pkg.ref(e["class"])) != "CameraComponent":
            continue
        k = data.find(tag, e["offset"], e["offset"] + e["size"])
        if k >= 0:
            struct.pack_into("<f", out, k + len(tag) + 1, 0.0)
            count += 1
    return bytes(out), count


def add_streaming_levels(data, packages):
    """Append LevelStreamingAlwaysLoaded entries to FrontEnd.umap."""
    pkg = UPackage(data)
    template = pkg.find_export("LevelStreamingAlwaysLoaded_0")
    world = pkg.find_export("FrontEnd")
    t = pkg.exports[template - 1]
    base_number = 10
    new_indices = []
    for n, (package_name, world_name) in enumerate(packages):
        path = "/Game/Maps/FrontEnd/%s.%s" % (package_name, world_name)
        fields = list(t["fields"])
        fields[5] = base_number + n + 1            # LevelStreamingAlwaysLoaded_<base+n>
        new_indices.append(pkg.add_export(fields, streaming_props(pkg, t["data"], path)))

    # UWorld native tail: PersistentLevel, ExtraReferencedObjects, StreamingLevels
    w = pkg.exports[world - 1]
    wd = bytearray(w["data"])
    count_off = len(wd) - 44 + 20
    assert struct.unpack_from("<i", wd, count_off)[0] == 5, "unexpected UWorld layout"
    wd[count_off:count_off + 4] = struct.pack("<i", 5 + len(new_indices))
    wd += b"".join(struct.pack("<i", i) for i in new_indices)
    w["data"] = bytes(wd)
    return pkg.save()


def streaming_props(pkg, template_data, path):
    """Template streaming export data with the WorldAsset path replaced."""
    assert struct.unpack_from("<i", template_data, 0)[0] == pkg.name_index("WorldAsset", add=False)
    # tag: name(8) type(8) size(4) arrayIndex(4) hasGuid(1), then FString value
    old_size = struct.unpack_from("<i", template_data, 16)[0]
    value = path.encode("latin1") + b"\0"
    new_value = struct.pack("<i", len(value)) + value
    tag = bytearray(template_data[:25])
    struct.pack_into("<i", tag, 16, len(new_value))
    return bytes(tag) + new_value + template_data[25 + old_size:]


def main(paks_dir):
    original = find_in_paks(paks_dir, {src for _, src, _ in LEVELS} | {FRONTEND})
    os.makedirs(OUT, exist_ok=True)

    streaming = []
    for name, src, rule in LEVELS:
        data = original[src]
        note = ""
        if src.endswith("FrontEnd_TH.umap"):
            data, cleared = clear_meshes(data, WAREHOUSE_SHELL_MESHES)
            note = ", shell meshes cleared %d" % cleared
        data, moved, hidden, kept = apply_rule(data, rule)
        if src.endswith("FrontEnd_TH.umap"):
            data, flood = add_floodlights(data)
            note += ", %d floodlights" % flood
            data, fx = add_sky_fx(data)
            note += ", %d sky events" % fx
        if name == "Arena_Sky":
            data = tune_sky(data)
            note = ", night sky and moonlight"
        if name in ("Arena_Sea", "Arena_Seabed"):
            data = tune_plane(data, SEA_MATERIAL if name == "Arena_Sea" else SEABED_MATERIAL)
            note = ", %dx%d plane" % (200 * SEA_SCALE[0], 200 * SEA_SCALE[1])
        if src.endswith("FrontEnd_Default.umap"):
            data = tune_menu_fog(data)
            note = ", navy night haze"
        out_name = name or os.path.splitext(os.path.basename(src))[0]
        open(os.path.join(OUT, out_name + ".umap"), "wb").write(data)
        if name:
            streaming.append((name, os.path.splitext(os.path.basename(src))[0]))
        print("%-18s from %-46s moved %4d, hidden %4d, unchanged %4d%s" % (out_name, src, moved, hidden, kept, note))

    # Drop levels left over from earlier builds so they don't ship in the pak.
    written = {name or os.path.splitext(os.path.basename(src))[0] for name, src, _ in LEVELS}
    for name, world in EXTRA_LEVELS:
        if os.path.exists(os.path.join(OUT, name + ".umap")):
            written.add(name)
            streaming.append((name, world))
    for f in os.listdir(OUT):
        if f.endswith(".umap") and f[:-5] not in written | {"FrontEnd"}:
            os.remove(os.path.join(OUT, f))
    data, sharp = no_depth_of_field(original[FRONTEND])
    data = add_streaming_levels(data, streaming)
    open(os.path.join(OUT, "FrontEnd.umap"), "wb").write(data)
    print("FrontEnd.umap      +%d streaming levels, depth of field off on %d cameras" % (len(streaming), sharp))


if __name__ == "__main__":
    main(sys.argv[1])
