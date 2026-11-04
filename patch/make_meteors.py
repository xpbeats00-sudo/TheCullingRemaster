"""Meteors for the menu sky, made from the TS Fireworks shell effect.

The shell's head emitter becomes the meteor: its (disabled) velocity is
switched on - fast and straight along the emitter's +X, no drag - and it
spawns for only 0.12 s per loop, so ~30 glowing particles fly as one bright
streak a few degrees long that crosses the sky in 1.4 s, shrinking and
fading out (the shell's own size/alpha-over-life curves). Each loop waits
EmitterDelay first, so a meteor goes by every few seconds. The spark and
smoke trail emitters are GPU particles that can't follow a moving particle;
they're switched off. The fixed bounding box is dropped so the streak isn't
culled once it leaves the emitter.

Three copies with different delays (MenuMeteor_A/B/C) are placed and aimed
by build_menu_arenas.py, one across each group of menu cameras.

usage: python make_meteors.py <Paks dir>
"""
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_menu_arenas import set_export_props  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from ue_package import UPackage  # noqa: E402
from uasset import Package  # noqa: E402

SOURCE = "Victory/Content/TS_Fireworks/Particles/PS_TS_FireworksShell.uasset"
OUT_DIR = os.path.join(HERE, "src", "Victory", "Content", "Maps", "FrontEnd")
METEORS = {"MenuMeteor_A": 6.0, "MenuMeteor_B": 9.0, "MenuMeteor_C": 7.5}   # seconds between meteors
SPEED = 30000.0                 # units/s along the emitter's +X
LIFETIME = 1.4
BURST = 0.12                    # seconds of spawning per loop (~30 particles)
SIZE = 220.0
COLOR = (3.0, 3.6, 5.0, 2.4, 3.0, 4.5)     # HDR blue-white, start -> end of life


def table_values(pkg, data, export_name, prop):
    """Offset and count of the float Values of `prop`'s lookup table (a
    RawDistribution struct) in the named export."""
    names = [n if isinstance(n, str) else n[0] for n in pkg.names]
    e = next(e for e in pkg.exports if e["name"] == export_name)
    end = e["offset"] + e["size"]
    start = data.find(struct.pack("<iiii", names.index(prop), 0, names.index("StructProperty"), 0), e["offset"], end)
    values = data.find(struct.pack("<iiii", names.index("Values"), 0, names.index("ArrayProperty"), 0), start, end)
    assert start >= 0 and values >= 0, (export_name, prop)
    # Values tag: name(8) ArrayProperty(8) size(4) index(4) inner type(8) guid flag(1), then count
    count = struct.unpack_from("<i", data, values + 33)[0]
    return values + 37, count


def make(data, delay):
    pkg = Package(data)
    out = bytearray(data)

    def put(export, prop, floats):
        off, count = table_values(pkg, data, export, prop)
        assert count == len(floats), (export, prop, count)
        struct.pack_into("<%df" % count, out, off, *floats)

    put("ParticleModuleVelocity_0", "StartVelocity", (SPEED, 0.0, 0.0) * 2)
    put("ParticleModuleAccelerationDrag_0", "DragCoefficientRaw", (0.0,))
    put("ParticleModuleLifetime_0", "Lifetime", (LIFETIME, LIFETIME))
    put("ParticleModuleSize_0", "StartSize", (SIZE,) * 3)
    put("ParticleModuleColorOverLife_0", "ColorOverLife", COLOR)

    up = UPackage(bytes(out))
    index = {e["name"]: i for i, e in enumerate(pkg.exports, 1)}
    set_export_props(up, index["ParticleModuleVelocity_0"], {"bEnabled": ("BoolProperty", True)})
    set_export_props(up, index["ParticleModuleRequired_0"], {
        "EmitterDuration": ("FloatProperty", BURST),
        "EmitterDelay": ("FloatProperty", delay),
    })
    # Every LOD level but the shell's: the TailSparkles and TailSmoke emitters.
    shell = index_of_shell_lod(pkg)
    for i, e in enumerate(pkg.exports, 1):
        if str(pkg.ref(e["class"])) == "ParticleLODLevel" and i != shell:
            set_export_props(up, i, {"bEnabled": ("BoolProperty", False)})
    set_export_props(up, index["PS_TS_FireworksShell"], {"bUseFixedRelativeBoundingBox": ("BoolProperty", False)})
    return up.save()


def index_of_shell_lod(pkg):
    """The Shell emitter's LOD level (the one whose spawn module is Spawn_0)."""
    from level_survey import export_props
    for i, e in enumerate(pkg.exports, 1):
        if str(pkg.ref(e["class"])) != "ParticleLODLevel":
            continue
        props = export_props(pkg, i)
        spawn = struct.unpack_from("<i", pkg.data, props["SpawnModule"][1])[0]
        if pkg.exports[spawn - 1]["name"] == "ParticleModuleSpawn_0":
            return i
    raise KeyError("shell LOD level")


def main(paks_dir):
    data = find_in_paks(paks_dir, {SOURCE})[SOURCE]
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, delay in METEORS.items():
        open(os.path.join(OUT_DIR, name + ".uasset"), "wb").write(make(data, delay))
        print("meteor %s: every %.1f s" % (name, delay + BURST))


if __name__ == "__main__":
    main(sys.argv[1])
