"""Rain particle systems for the weather module: light, heavy and storm.

The game has no rain effect. These are copies of P_Impact_Metal reduced to
its one GPU emitter (velocity-aligned spark streaks with GPU depth-buffer
collision, "Burst_Out"), retuned into falling rain:

- spawn: a constant rate (how hard it rains), no burst, looping forever;
- where: a ball of radius R centred RAIN_ABOVE units above the emitter (the
  weather module attaches the emitter to the local player's pawn, so the
  ball travels with the player; the drops themselves are world-space and
  fall straight on);
- how: falling at ~11-20 m/s with a slight (storm: strong) wind, streaks
  stretched by speed, a pale blue-grey colour, bouncing off whatever the
  depth buffer shows (they splash and die out on the ground);
- the emitter's LOD is switched on (stock: off) and the system's fixed
  bounds cover the ball and the fall.

GPU sprite emitters are baked at cook time: the module tables are what the
CPU spawn step reads (rate, lifetime, start location, start velocity), and
ParticleModuleTypeDataGpu's EmitterInfo / ResourceData hold the rest for the
GPU simulation (colour, size by speed, constant acceleration, lifetime and
particle budget). Both are edited, in place, so the cooked layout is kept.

Writes /Game/Remaster/Weather/P_Rain_{Light,Heavy,Storm} under patch/src
(or --out).

usage: python make_rain.py <Paks dir> [--out <dir>]
"""
import math
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_menu_arenas import iter_tags  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from ue_package import UPackage  # noqa: E402

SRC = os.path.join(HERE, "src")
SOURCE = "Victory/Content/Effects/Particles/Weapons/P_Impact_Metal.uasset"
OUT_DIR = "Victory/Content/Remaster/Weather"
EMITTER = "ParticleSpriteEmitter_0"          # Burst_Out: the GPU emitter
RAIN_ABOVE = 1400.0                          # ball centre above the pawn's centre

LEVELS = {
    #          rate/s  radius  lifetime     velocity min / max (x, y, z)                  colour  stretch
    "Light": dict(rate=2500.0, radius=2200.0, life=(1.4, 1.8),
                  vmin=(-40.0, -40.0, -1400.0), vmax=(40.0, 40.0, -1100.0), color=0.18, stretch=0.016),
    "Heavy": dict(rate=8000.0, radius=2600.0, life=(1.5, 1.9),
                  vmin=(-60.0, -60.0, -1700.0), vmax=(60.0, 60.0, -1400.0), color=0.22, stretch=0.020),
    "Storm": dict(rate=16000.0, radius=2600.0, life=(1.4, 1.8),
                  vmin=(450.0, -100.0, -2000.0), vmax=(650.0, 100.0, -1700.0), color=0.25, stretch=0.022),
}
ACCELERATION = (0.0, 0.0, -200.0)            # drops are near terminal speed already
MAX_STRETCH = 30.0                           # streak length cap, in sprite widths


def asset_path(level):
    return "/Game/Remaster/Weather/P_Rain_" + level


def object_name(level):
    return "P_Rain_" + level


# ---------------------------------------------------------------- nested tags
def walk(up, data, base=0, prefix=()):
    """Yield (path tuple, type, tag start, value offset, size) for every tagged
    property, descending into structs (offsets absolute in `data`)."""
    for name, ptype, start, voff, size in iter_tags(up, data[base:]):
        path = prefix + (name,)
        yield path, ptype, base + start, base + voff, size
        if ptype == "StructProperty":
            inner = data[base + voff:base + voff + size]
            if _looks_tagged(up, inner):
                try:
                    found = list(walk(up, data, base + voff, path))
                except (IndexError, struct.error):
                    found = []
                yield from found


def _looks_tagged(up, blob):
    if len(blob) < 8:
        return False
    idx, num = struct.unpack_from("<ii", blob, 0)
    return 0 <= idx < len(up.names) and num == 0 and (len(blob) >= 25 or up.names[idx][0] == "None")


def find(up, data, path):
    hits = [(t, s, v, z) for p, t, s, v, z in walk(up, data) if p == path]
    if len(hits) != 1:
        raise KeyError("%s: %d matches" % ("/".join(path), len(hits)))
    return hits[0]


def set_floats(up, data, path, values):
    """Set a float, a native struct (Vector/Vector2D/Vector4/Box) or a float array."""
    ptype, start, voff, size = find(up, data, path)
    if ptype == "ArrayProperty":
        n = struct.unpack_from("<i", data, voff)[0]
        assert n == len(values), (path, n, len(values))
        struct.pack_into("<%df" % n, data, voff + 4, *values)
    elif ptype == "FloatProperty":
        struct.pack_into("<f", data, voff, *values)
    elif ptype == "StructProperty":
        assert size >= 4 * len(values), (path, size)
        struct.pack_into("<%df" % len(values), data, voff, *values)
    else:
        raise TypeError(path, ptype)


def set_int(up, data, path, value):
    ptype, start, voff, size = find(up, data, path)
    assert ptype == "IntProperty", (path, ptype)
    struct.pack_into("<i", data, voff, value)


def set_bool(up, data, path, value):
    ptype, start, voff, size = find(up, data, path)
    assert ptype == "BoolProperty", (path, ptype)
    data[start + 24] = 1 if value else 0


def get(up, data, path, fmt):
    ptype, start, voff, size = find(up, data, path)
    if ptype == "BoolProperty":
        return (data[start + 24],)
    if ptype == "ArrayProperty":
        n = struct.unpack_from("<i", data, voff)[0]
        return struct.unpack_from("<%d%s" % (n, fmt), data, voff + 4)
    return struct.unpack_from(fmt, data, voff)


# ---------------------------------------------------------------- the edit
def export(up, name):
    hits = [i for i, e in enumerate(up.exports, 1) if up.name_str(e["fields"][4], e["fields"][5]) == name]
    if len(hits) != 1:
        raise KeyError("%s: %d exports" % (name, len(hits)))
    return hits[0]


def lod_modules(up, emitter):
    """(LOD index, required, spawn, type data, [modules]) of the emitter's only LOD."""
    e = up.exports[emitter - 1]["data"]
    lods = get(up, bytearray(e), ("LODLevels",), "i")
    assert len(lods) == 1, lods
    ld = bytearray(up.exports[lods[0] - 1]["data"])
    return (lods[0], get(up, ld, ("RequiredModule",), "<i")[0], get(up, ld, ("SpawnModule",), "<i")[0],
            get(up, ld, ("TypeDataModule",), "<i")[0], list(get(up, ld, ("Modules",), "i")))


def module_of(up, modules, cls_name):
    found = []
    for m in modules:
        cls = up.exports[m - 1]["fields"][0]
        if cls < 0 and up.names[struct.unpack_from("<i", up.imports[-cls - 1], 20)[0]][0] == cls_name:
            found.append(m)
    assert len(found) == 1, (cls_name, found)
    return found[0]


def edit(up, index, fn):
    d = bytearray(up.exports[index - 1]["data"])
    fn(d)
    up.exports[index - 1]["data"] = bytes(d)


def rain(data, level):
    p = LEVELS[level]
    up = UPackage(data)
    emitter = export(up, EMITTER)
    lod, required, spawn, gpu, modules = lod_modules(up, emitter)
    r = p["radius"]
    lmin, lmax = p["life"]
    count = int(math.ceil(p["rate"] * lmax * 1.1))

    # The system: only the GPU emitter; bounds around the ball and the fall.
    system = [i for i, e in enumerate(up.exports, 1)
              if e["fields"][0] < 0 and up.names[struct.unpack_from("<i", up.imports[-e["fields"][0] - 1], 20)[0]][0]
              == "ParticleSystem"]
    assert len(system) == 1
    sysd = bytearray(up.exports[system[0] - 1]["data"])
    ptype, start, voff, size = find(up, sysd, ("Emitters",))
    assert emitter in struct.unpack_from("<%di" % struct.unpack_from("<i", sysd, voff)[0], sysd, voff + 4)
    new_arr = struct.pack("<ii", 1, emitter)
    head = bytearray(sysd[start:voff])
    struct.pack_into("<i", head, 16, len(new_arr))
    sysd = sysd[:start] + head + new_arr + sysd[voff + size:]
    reach = r + 1500.0                                       # sideways: radius plus wind drift
    fall = 2000.0 * lmax                                     # downward travel over a lifetime
    box = (-reach, -reach, RAIN_ABOVE - r - fall, reach, reach, RAIN_ABOVE + r)
    set_floats(up, sysd, ("FixedRelativeBoundingBox",), box)
    _, bstart, bvoff, _ = find(up, sysd, ("FixedRelativeBoundingBox",))
    sysd[bvoff + 24] = 1                                     # IsValid
    set_bool(up, sysd, ("bUseFixedRelativeBoundingBox",), True)
    up.exports[system[0] - 1]["data"] = bytes(sysd)
    # The ParticleSystem export takes the asset's name.
    f = up.exports[system[0] - 1]["fields"]
    f[4], f[5] = up.name_index(object_name(level)), 0

    edit(up, lod, lambda d: (set_bool(up, d, ("bEnabled",), True), set_int(up, d, ("PeakActiveParticles",), count)))
    edit(up, required, lambda d: set_int(up, d, ("EmitterLoops",), 0))

    def spawn_edit(d):
        set_floats(up, d, ("Rate", "Table", "Values"), (p["rate"],))
    edit(up, spawn, spawn_edit)
    _zero_bursts(up, spawn)

    edit(up, module_of(up, modules, "ParticleModuleLifetime"),
         lambda d: set_floats(up, d, ("Lifetime", "Table", "Values"), (lmin, lmax)))

    def sphere(d):
        set_floats(up, d, ("StartRadius", "Table", "Values"), (r,))
        set_bool(up, d, ("SurfaceOnly",), False)
        set_bool(up, d, ("Negative_X",), True)         # stock: the +X half only
        set_bool(up, d, ("Velocity",), False)
        set_floats(up, d, ("StartLocation", "Table", "Values"), (0.0, 0.0, RAIN_ABOVE))
    edit(up, module_of(up, modules, "ParticleModuleLocationPrimitiveSphere"), sphere)

    def velocity(d):
        set_floats(up, d, ("StartVelocity", "Table", "Values"), p["vmin"] + p["vmax"])
        set_floats(up, d, ("StartVelocityRadial", "Table", "Values"), (0.0,))
    edit(up, module_of(up, modules, "ParticleModuleVelocity"), velocity)

    edit(up, module_of(up, modules, "ParticleModuleAccelerationConstant"),
         lambda d: set_floats(up, d, ("Acceleration",), ACCELERATION))

    def by_speed(d):
        set_floats(up, d, ("SpeedScale",), (0.05, p["stretch"]))
        set_floats(up, d, ("MaxScale",), (1.0, MAX_STRETCH))
    edit(up, module_of(up, modules, "ParticleModuleSizeScaleBySpeed"), by_speed)

    c = p["color"]
    edit(up, module_of(up, modules, "ParticleModuleColor"),
         lambda d: set_floats(up, d, ("StartColor", "Table", "Values"), (c * 0.85, c * 0.95, c * 1.15)))

    def gpu_data(d):
        set_floats(up, d, ("EmitterInfo", "ConstantAcceleration"), ACCELERATION)
        set_floats(up, d, ("EmitterInfo", "MaxLifetime"), (lmax,))
        set_int(up, d, ("EmitterInfo", "MaxParticleCount"), count)
        set_floats(up, d, ("ResourceData", "ConstantAcceleration"), ACCELERATION)
        set_floats(up, d, ("ResourceData", "ColorBias"), (c * 0.85, c * 0.95, c * 1.15, 0.0))
        set_floats(up, d, ("ResourceData", "SizeBySpeed"), (0.05, p["stretch"], 1.0, MAX_STRETCH))
    edit(up, gpu, gpu_data)
    return up.save()


def _zero_bursts(up, spawn):
    """BurstList is an array of FParticleBurst structs; set every Count and
    CountLow to 0 (the stock emitter fires one burst of 100 per loop)."""
    d = bytearray(up.exports[spawn - 1]["data"])
    ptype, start, voff, size = find(up, d, ("BurstList",))
    blob = d[voff:voff + size]
    n = struct.unpack_from("<i", blob, 0)[0]
    # Array of structs: count, then one inner tag header (name, type, size,
    # index, struct name, guid, has-guid), then the tagged elements.
    off = 4 + 8 + 8 + 4 + 4 + 8 + 16 + 1
    for _ in range(n):
        for name, t, s, v, z in iter_tags(up, bytes(blob[off:])):
            if name in ("Count", "CountLow"):
                struct.pack_into("<i", d, voff + off + v, 0)
            last = v + z
        off += last + 8                                      # + "None"
    up.exports[spawn - 1]["data"] = bytes(d)


def build(paks_dir, out_root=SRC):
    original = find_in_paks(paks_dir, {SOURCE})[SOURCE]
    written = []
    for level in LEVELS:
        rel = "%s/P_Rain_%s.uasset" % (OUT_DIR, level)
        path = os.path.join(out_root, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "wb").write(rain(original, level))
        written.append(rel)
        p = LEVELS[level]
        print("%-28s %6.0f drops/s, ball %4.0f, %.1f-%.1f s" % (asset_path(level), p["rate"], p["radius"], *p["life"]))
    return written


def main(argv):
    args = list(argv)
    out = SRC
    if "--out" in args:
        i = args.index("--out"); out = args[i + 1]; del args[i:i + 2]
    if len(args) != 1:
        sys.exit(__doc__)
    build(args[0], out)


if __name__ == "__main__":
    main(sys.argv[1:])
