"""DIAGNOSTICS ONLY - never part of a release build (patch/build_release.py
doesn't run it, and make_pak.py refuses to pack what it writes: the
<Mesh>_XPAnim* and Camo_XP_Anim_* assets). The route below gave
"Serialization Error: Corrupt data found" in game and is unproven; for a local
diagnostics pak only: make_pak.py <src> <out> --allow-test-content. Running it
puts files in patch/src that a release build then refuses until they are
deleted (or make_camos.py is run again, which removes them).

Animated camos: the camo image scrolls across the weapon.

The weapon material (PM_Weapon_Master) has no time input on its camo layer.
Its "-Use Bow Panner-" permutation - compiled only into Chainsaw_A_MI, for
the moving chain - does scroll: in its base pass the weapon's base color (and
normal) are sampled at UV + (time * ChainsawSpeed, 0) and blended in where
the GP texture's alpha is set. The compiled shaders take their textures as
parameters, so a copy of Chainsaw_A_MI pointed at another weapon's textures
gives that weapon the scrolling layer:

- <Mesh>_XPAnim_MI   Chainsaw_A_MI with the weapon's BC/CM/NM, the GP below,
                     and a constant ChainsawSpeed.
- <Mesh>_XPAnim_GP   the weapon's GP (DXT5) with alpha = its camo zone (CM red).
- <Mesh>_XPAnim      a copy of the weapon mesh using that material.
- Camo_XP_Anim_<camo> full-color camo images (sRGB DXT1) for the skins' BC.

Each camo skin of an animated weapon gets GeoSkin = the mesh copy and BC =
its camo image (make_camos.py builds the skins; this adds the two tags).

usage: python patch/diagnostics/make_animated_camos.py <Paks dir>
"""
import glob
import os
import re
import struct
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))     # patch/
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import cooked_texture  # noqa: E402
import make_camos  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from ue_names import name_hashes  # noqa: E402
from ue_package import UPackage  # noqa: E402
from uasset import Package  # noqa: E402

WEAPONS_DIR = "Victory/Content/Character/Weapons/"
GAME_WEAPONS = "/Game/Character/Weapons/"
CHAINSAW_MI = WEAPONS_DIR + "Chainsaw_A_MI.uasset"
BC_TEMPLATE = WEAPONS_DIR + "TwoHanded_Melee_Desert_BC.uasset"
OUT = os.path.join(HERE, "src", "Victory", "Content", "Character", "Weapons")
SKINS = os.path.join(HERE, "src", "Victory", "Content", "Cosmetics", "WeaponSkins")
SPEED = 0.04                     # UV widths per second: one pass every 25 s
# skin prefix -> weapon mesh (from the weapon blueprints; research/weapon_meshes.json)
ANIMATED = {
    "357Magnum": "Revolver_A", "AlarmGun": "ManAlarm_A", "AutoBow": "AutoBow_A", "BaseballBat": "MetalBat_A",
    "BowieKnife": "BowieKnife_A", "BrassKnuckles": "BrassKnuckles_A", "CampHatchet": "Hatchet_A",
    "Chainsaw": "Chainsaw_A", "Cleaver": "Cleaver_A", "CompoundBow": "CompoundBow_A", "Crowbar": "Crowbar_A",
    "FiremansAxe": "FireAxe_A", "Hammer_BallPein": "Hammer_Bambi_A", "IceAxe": "IceAxe_A",
    "Javelin": "Javelin_A", "Katana": "Katana", "Kukri": "Kukri_A", "Machete": "Machete_A",
    "ManTracker": "mantracker_A", "Pike": "Pike_A", "PipeWrench": "PipeWrench_A", "PitchFork": "PitchFork_A",
    "RecurveBow": "Bow_Recurve_A", "Rifle": "M15-Rifle_A", "SMG": "SMG_A", "Sabre": "Sabre_A",
    "Sledgehammer": "Sledgehammer_A", "SteelPipe": "Steel_Pipe_A", "StunGun": "StunGun_A",
    "SurvivalAxe": "Survival_Axe_A", "SurvivalSpear": "Survival_Spear_A", "TacticalMachete": "Tactical_Machete",
    "TantoKnife": "Knife", "Tomahawk": "Tomahawk_Tactical_A", "Tonfa": "Tonfa_A", "Trident": "Trident_A",
    "Yari": "Yari_A",
}


def rename(up, mapping):
    """Rename names exactly equal to a key (package paths and object names)."""
    for k, (s, _) in enumerate(up.names):
        if s in mapping:
            up.names[k] = (mapping[s], struct.pack("<HH", *name_hashes(mapping[s])))


def imports_of(data):
    """[(class, object name, package path)] of a package's imports."""
    up = UPackage(data)
    out = []
    for imp in up.imports:
        _, _, cls, _, outer, obj, _ = struct.unpack("<iiiiiii", imp)
        pkg = None
        if outer < 0:
            pkg = up.names[struct.unpack_from("<i", up.imports[-outer - 1], 20)[0]][0]
        out.append((up.names[cls][0], up.names[obj][0], pkg))
    return out


def rel(package_path):
    return "Victory/Content/" + package_path[len("/Game/"):] + ".uasset"


def set_scalar(data, param, value):
    pkg = Package(data)
    names = [n if isinstance(n, str) else n[0] for n in pkg.names]
    out = bytearray(data)
    i = data.find(struct.pack("<ii", names.index(param), 0))
    tag = struct.pack("<iiii", names.index("ParameterValue"), 0, names.index("FloatProperty"), 0)
    j = data.find(tag, i)
    assert 0 < i < j < i + 200, param
    struct.pack_into("<f", out, j + len(tag) + 9, value)
    return bytes(out)


def build_weapon(paks_dir, src, mesh_rel):
    """Material, GP and mesh copies for one weapon. New packages only: object
    names stay as they were (short mesh names like "Knife" can also be bone
    or socket names inside the files). Returns the GeoSkin path or None."""
    mesh_data = src[mesh_rel]
    mesh_pkg = "/Game/" + mesh_rel[len("Victory/Content/"):-len(".uasset")]
    mesh_obj = mesh_pkg.rsplit("/", 1)[1]
    mis = [(o, p) for c, o, p in imports_of(mesh_data) if c == "MaterialInstanceConstant" and not o.endswith("_HL")]
    if not mis:
        return None
    # The weapon body's material: the one sharing the most leading letters
    # with the mesh name (the rifle also carries IronSights_MI).
    def shared(name):
        a, b = re.sub(r"[^a-z0-9]", "", name.lower()), re.sub(r"[^a-z0-9]", "", mesh_obj.lower())
        n = 0
        while n < min(len(a), len(b)) and a[n] == b[n]:
            n += 1
        return n
    mi_obj, mi_pkg = max(mis, key=lambda m: shared(m[0]))
    need = {rel(mi_pkg)}
    src.update(find_in_paks(paks_dir, need - set(src)))
    tex = {o.rsplit("_", 1)[1]: (o, p) for c, o, p in imports_of(src[rel(mi_pkg)]) if c == "Texture2D"}
    if not all(k in tex for k in ("BC", "CM", "GP", "NM")):
        print("  skip %s: material %s lacks BC/CM/GP/NM (%s)" % (mesh_obj, mi_obj, sorted(tex)))
        return None
    src.update(find_in_paks(paks_dir, {rel(tex["GP"][1]), rel(tex["CM"][1])} - set(src)))
    new = GAME_WEAPONS + mesh_obj.replace("-", "_") + "_XPAnim"

    # GP with alpha = the camo zone (same object name, new package).
    gp_data = src[rel(tex["GP"][1])]
    gp = np.asarray(cooked_texture.decode_top(gp_data))
    cm = np.asarray(cooked_texture.decode_top(src[rel(tex["CM"][1])]).resize(gp.shape[1::-1]))
    rgba = gp.copy()
    rgba[..., 3] = cm[..., 0]
    up = UPackage(cooked_texture.rebuild(gp_data, cooked_texture.mip_chain_rgba(rgba), fmt="PF_DXT5"))
    rename(up, {tex["GP"][1]: new + "_GP"})
    write(new + "_GP", cooked_texture.relocate(up.save()))      # the rename moved the export

    # Material: the chainsaw's panner permutation with this weapon's textures,
    # exported under the weapon material's own object name.
    up = UPackage(src[CHAINSAW_MI])
    mapping = {GAME_WEAPONS + "Chainsaw_A_MI": new + "_MI", "Chainsaw_A_MI": mi_obj,
               GAME_WEAPONS + "Chainsaw_A_GP": new + "_GP", "Chainsaw_A_GP": tex["GP"][0]}
    for suffix in ("BC", "CM", "NM"):
        mapping[GAME_WEAPONS + "Chainsaw_A_" + suffix] = tex[suffix][1]
        mapping["Chainsaw_A_" + suffix] = tex[suffix][0]
    rename(up, mapping)
    write(new + "_MI", set_scalar(up.save(), "ChainsawSpeed", SPEED))

    # Mesh copy: same objects, new package, its material import -> the new MI.
    up = UPackage(mesh_data)
    rename(up, {mesh_pkg: new, mi_pkg: new + "_MI"})
    write(new, up.save())
    return new + "." + mesh_obj


def write(path, data):
    """path: a /Game/Character/Weapons/... package path or a bare name."""
    name = path.rsplit("/", 1)[-1]
    os.makedirs(OUT, exist_ok=True)
    with open(os.path.join(OUT, name + ".uasset"), "wb") as f:
        f.write(data)


def asset_tag(up, name, path):
    value = make_camos.fstring(path)
    return up.fname(name) + up.fname("AssetObjectProperty") + struct.pack("<ii", len(value), 0) + b"\0" + value


def patch_skin(path, geo, bc):
    up = UPackage(open(path, "rb").read())
    data = up.exports[0]["data"]
    kept, end = b"", 0
    for name, ptype, start, voff, size in make_camos.iter_tags(up, data):
        kept += data[end:start]
        if name not in ("GeoSkin", "BC"):
            kept += data[start:voff + size]
        end = voff + size
    up.exports[0]["data"] = asset_tag(up, "GeoSkin", geo) + asset_tag(up, "BC", bc) + kept + data[end:]
    with open(path, "wb") as f:
        f.write(up.save())


def mesh_paths(paks_dir):
    from build_catalog import pak_entries
    found = {}
    wanted = {m.lower(): m for m in ANIMATED.values()}
    for pk in stock_paks(paks_dir):
        for e in pak_entries(pk):
            n = e[1].replace("../../../", "")
            base = n.rsplit("/", 1)[-1][:-len(".uasset")] if n.endswith(".uasset") else None
            if base and base.lower() in wanted and "/Character/" in n:
                found[wanted[base.lower()]] = n
    return found


def main(paks_dir):
    for f in glob.glob(os.path.join(OUT, "*_XPAnim*.uasset")) + glob.glob(os.path.join(OUT, "Camo_XP_Anim_*.uasset")):
        os.remove(f)
    meshes = mesh_paths(paks_dir)
    src = find_in_paks(paks_dir, {CHAINSAW_MI, BC_TEMPLATE} | set(meshes.values()))

    camos = make_camos.gather(make_camos.CAMOS_DIR)
    for c in camos:
        name = "Camo_XP_Anim_" + c["slug"]
        img = np.asarray(c["img"].convert("RGB").resize((1024, 1024), Image.LANCZOS))
        write(name, cooked_texture.rebuild(src[BC_TEMPLATE], cooked_texture.mip_chain(img, 8),
                                           rename=("TwoHanded_Melee_Desert_BC", name)))
        c["bc"] = GAME_WEAPONS + name + "." + name

    done = 0
    for prefix, mesh in sorted(ANIMATED.items()):
        if mesh not in meshes:
            print("  skip %s: mesh %s not found" % (prefix, mesh))
            continue
        geo = build_weapon(paks_dir, src, meshes[mesh])
        if not geo:
            continue
        patched = 0
        for c in camos:
            path = os.path.join(SKINS, "%s_XP_%s.uasset" % (prefix, c["slug"]))
            if os.path.exists(path):
                patch_skin(path, geo, c["bc"])
                patched += 1
        done += 1
        print("%-16s %s  %d skins" % (prefix, geo, patched))
    print("%d weapons animated" % done)

if __name__ == "__main__":
    main(sys.argv[1])
