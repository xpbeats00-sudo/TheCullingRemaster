"""Timed sky events for the menu, made from the TS Fireworks bursts.

- Supernova (from the chrysanthemum burst): a blue-white flash and an
  expanding shell of violet sparks with no gravity, lingering ~2x longer than
  the firework, its smoke a brief faint violet remnant.
- Hyperdrive (from the palm burst): long speed-stretched streaks flying
  outward from one point, white/cyan, no gravity, like a warp jump.

Every emitter loops forever on the same cycle (EmitterDelay + EmitterDuration)
so the parts stay in sync; each copy has its own delay so events don't line
up. The fixed bounding box is dropped so the bursts aren't culled. Colors come
from the effects' particle-parameter defaults (BlastColor, SparkleColor),
which apply when nothing sets them at runtime.

Copies are placed by build_menu_arenas.py (SKY_FX).

usage: python make_sky_fx.py <Paks dir>
"""
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_menu_arenas import set_export_props  # noqa: E402
from level_survey import export_props  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from ue_package import UPackage  # noqa: E402
from uasset import Package  # noqa: E402

PARTICLES = "Victory/Content/TS_Fireworks/Particles/%s.uasset"
OUT_DIR = os.path.join(HERE, "src", "Victory", "Content", "Maps", "FrontEnd")
DURATION = 4.0

SUPERNOVA = {
    "source": "PS_TS_Fireworks_Burst_Chrys",
    "lifetime": 2.0,                                   # x the firework's
    "lifetime_overrides": {"ParticleModuleLifetime_4": 1.0},   # smoke: big sprites, keep it short
    "spawn_rate": 0.25,                                # x the spark rates (frame time)
    "params": {"BlastColor": (2.2, 2.6, 4.5), "SparkleColor": (1.3, 0.6, 2.2)},
    "colors": {"ParticleModuleColorOverLife_4": (0.30, 0.22, 0.55)},   # smoke -> violet remnant
}
HYPERDRIVE = {
    "source": "PS_TS_Fireworks_Burst_Palm",
    "lifetime": 1.0,
    "lifetime_overrides": {},
    "spawn_rate": 0.3,
    "params": {"BlastColor": (2.5, 3.5, 5.0), "SparkleColor": (2.0, 3.0, 4.5)},
    "colors": {"ParticleModuleColorOverLife_4": (0.10, 0.14, 0.25)},
}
# name: (recipe, seconds between events)
SKY_FX = {
    "MenuSupernova_Home": (SUPERNOVA, 18.0),
    "MenuHyperdrive_Home": (HYPERDRIVE, 29.0),
    "MenuHyperdrive_Side": (HYPERDRIVE, 23.0),
    "MenuSupernova_Character": (SUPERNOVA, 27.0),
}


def table_values(pkg, data, export, prop):
    """Offset and count of the float Values of `prop`'s lookup table."""
    names = [n if isinstance(n, str) else n[0] for n in pkg.names]
    end = export["offset"] + export["size"]
    start = data.find(struct.pack("<iiii", names.index(prop), 0, names.index("StructProperty"), 0), export["offset"], end)
    values = data.find(struct.pack("<iiii", names.index("Values"), 0, names.index("ArrayProperty"), 0), start, end)
    if start < 0 or values < 0:
        return None, 0
    return values + 37, struct.unpack_from("<i", data, values + 33)[0]


def make(data, recipe, delay):
    pkg = Package(data)
    names = [n if isinstance(n, str) else n[0] for n in pkg.names]
    out = bytearray(data)
    gpu_spawns = set()
    for i, e in enumerate(pkg.exports, 1):
        if str(pkg.ref(e["class"])) == "ParticleLODLevel":
            props = export_props(pkg, i)
            if "TypeDataModule" in props:
                gpu_spawns.add(struct.unpack_from("<i", data, props["SpawnModule"][1])[0])
    for i, e in enumerate(pkg.exports, 1):
        cls = str(pkg.ref(e["class"]))
        if cls == "ParticleModuleLifetime":
            off, n = table_values(pkg, data, e, "Lifetime")
            vals = struct.unpack_from("<%df" % n, data, off)
            scale = recipe["lifetime_overrides"].get(e["name"], recipe["lifetime"])
            struct.pack_into("<%df" % n, out, off, *(v * scale for v in vals))
        elif cls == "ParticleModuleSpawn" and i in gpu_spawns:
            off, n = table_values(pkg, data, e, "Rate")
            vals = struct.unpack_from("<%df" % n, data, off)
            struct.pack_into("<%df" % n, out, off, *(v * recipe["spawn_rate"] for v in vals))
        elif e["name"] in recipe["colors"]:
            off, n = table_values(pkg, data, e, "ColorOverLife")
            assert n == 3, (e["name"], n)
            struct.pack_into("<3f", out, off, *recipe["colors"][e["name"]])
        elif cls == "DistributionVectorParticleParameter":
            props = export_props(pkg, i)
            param = names[struct.unpack_from("<i", data, props["ParameterName"][1])[0]]
            if param in recipe["params"] and "Constant" in props:
                struct.pack_into("<3f", out, props["Constant"][1], *recipe["params"][param])

    up = UPackage(bytes(out))
    for i, e in enumerate(pkg.exports, 1):
        cls = str(pkg.ref(e["class"]))
        if cls == "ParticleModuleRequired":
            set_export_props(up, i, {"EmitterLoops": ("IntProperty", 0),
                                     "EmitterDuration": ("FloatProperty", DURATION),
                                     "EmitterDelay": ("FloatProperty", delay)})
        elif cls == "ParticleModuleAccelerationConstant":
            set_export_props(up, i, {"Acceleration": ("Vector", (0.0, 0.0, 0.0))})
        elif cls == "ParticleSystem":
            set_export_props(up, i, {"bUseFixedRelativeBoundingBox": ("BoolProperty", False)})
    return up.save()


def main(paks_dir):
    sources = {PARTICLES % r["source"] for r, _ in SKY_FX.values()}
    original = find_in_paks(paks_dir, sources)
    os.makedirs(OUT_DIR, exist_ok=True)
    for name, (recipe, delay) in SKY_FX.items():
        data = make(original[PARTICLES % recipe["source"]], recipe, delay)
        open(os.path.join(OUT_DIR, name + ".uasset"), "wb").write(data)
        print("%-24s from %-30s every %.0f s" % (name, recipe["source"], delay + DURATION))


if __name__ == "__main__":
    main(sys.argv[1])
