"""A real moon for the menu sky: a sphere far out in the moon's direction.

- Texture /Game/Maps/FrontEnd/MenuMoon: an equirectangular moon (bright
  highlands, dark maria, craters with lit rims, a rayed crater), 1024x512 BGRA
  sRGB with mips (from the CC_Artboard-1 card texture).
- Material /Game/Maps/FrontEnd/MI_MenuMoon: instance of GTMaterial2 (Coherent's
  unlit, translucent world-UI material; compiled for static meshes). Its
  emissive, from the disassembled shader, is
      tex * EmissiveColor * (0.5 - 2 * (4 * tex - 0.5) * (Blaq - 0.5)) * EmissiveBrightness
  so Blaq = 0.5 makes it tex * EmissiveColor * EmissiveBrightness / 2.
- Level Arena_Moon (from the Jungle's Water level, like the sea): its water
  plane becomes /Engine/BasicShapes/Sphere with the moon material, placed in
  the moon's direction (build_menu_arenas.MOON_YAW / MOON_ELEVATION) from the
  home camera, casting no shadow (it sits in the moonlight's own direction).

usage: python make_moon.py <Paks dir>
"""
import os
import struct
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cooked_texture  # noqa: E402
from build_menu_arenas import (MOON_ELEVATION, MOON_YAW, SEA_SOURCE, actor_roots, apply_rule,  # noqa: E402
                               encode_tag, plane_rule)
from level_survey import export_props  # noqa: E402
from make_night_sky import fbm, smoothstep  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from ue_names import name_hashes  # noqa: E402
from ue_package import UPackage  # noqa: E402
from uasset import Package  # noqa: E402

FRONTEND = os.path.join(HERE, "src", "Victory", "Content", "Maps", "FrontEnd")
TEXTURE_TEMPLATE = "Victory/Content/Cosmetics/CullingCards/Source/CC_Artboard-1.uasset"
MIC_TEMPLATE = "Victory/Content/Character/Player/TEST/MI_SkinTest_Asian.uasset"
LEVEL_SOURCE = "Victory/Content/Maps/Jungle/Water.umap"
TEXTURE = "/Game/Maps/FrontEnd/MenuMoon"
MATERIAL = "/Game/Maps/FrontEnd/MI_MenuMoon"
SPHERE = "/Engine/BasicShapes/Sphere"
CAMERA = (-158.6, 25.0, 112.4)          # CAMERA_HOME
DISTANCE = 60000.0
ANGULAR_DIAMETER = 2.4                  # degrees
SPHERE_RADIUS = 50.0                    # BasicShapes/Sphere
BRIGHTNESS = 14.0                       # EmissiveBrightness
SEED = 4242


# ---- texture
def moon_albedo(w=1024, h=512):
    u = (np.arange(w) + 0.5) / w * 2 * np.pi
    v = (np.arange(h) + 0.5) / h * np.pi
    lon, colat = np.meshgrid(u, v)
    d = np.stack([np.sin(colat) * np.cos(lon), np.sin(colat) * np.sin(lon), np.cos(colat)], -1).astype(np.float32)
    maria = smoothstep(0.52, 0.66, fbm(d * 1.6 + 3.0, SEED, octaves=5))
    grain = fbm(d * 18.0, SEED + 1, octaves=5)
    albedo = 0.72 - 0.30 * maria + 0.10 * (grain - 0.5)
    rng = np.random.default_rng(SEED)
    for k in range(420):
        c = rng.normal(size=3)
        c /= np.linalg.norm(c)
        size = 0.008 + 0.09 * rng.random() ** 4          # radians
        depth = 0.03 + 0.05 * rng.random()
        ang = np.arccos(np.clip(d @ c, -1, 1)) / size
        bowl = np.exp(-(ang / 0.8) ** 3)
        rim = np.exp(-((ang - 1.0) / 0.3) ** 2)
        albedo = albedo - depth * bowl + 0.6 * depth * rim
    # One young, rayed crater.
    c = np.array([0.3, -0.5, -0.8])
    c /= np.linalg.norm(c)
    ang = np.arccos(np.clip(d @ c, -1, 1))
    az = np.arctan2(d @ np.cross(c, [0, 0, 1]), d @ np.cross(c, np.cross(c, [0, 0, 1])))
    rays = (0.5 + 0.5 * np.cos(az * 23 + 2 * np.sin(az * 7))) ** 8 * np.exp(-ang / 0.35)
    albedo = albedo + 0.08 * rays * fbm(d * 6.0, SEED + 2, octaves=3) + 0.15 * np.exp(-(ang / 0.025) ** 2)
    albedo = np.clip(albedo, 0.05, 1.0)
    tint = np.array([0.97, 0.97, 1.0])
    return (albedo[..., None] * tint * 255).astype(np.uint8)


def bgra_mips(rgb, min_width=4):
    mips = []
    img = Image.fromarray(rgb)
    while True:
        a = np.asarray(img)
        bgra = np.concatenate([a[..., ::-1], np.full(a.shape[:2] + (1,), 255, np.uint8)], -1)
        mips.append((a.shape[1], a.shape[0], bgra.tobytes()))
        if a.shape[1] <= min_width or a.shape[0] <= 2:
            return mips
        img = img.resize((a.shape[1] // 2, a.shape[0] // 2), Image.BOX)


def set_path(up, old_suffix, new_path):
    """Rename the package path name ending in /<old_suffix> and the object
    name <old_suffix> to new_path and its last component."""
    new_name = new_path.rsplit("/", 1)[1]
    for k, (s, _) in enumerate(up.names):
        if s.endswith("/" + old_suffix):
            up.names[k] = (new_path, struct.pack("<HH", *name_hashes(new_path)))
        elif s == old_suffix:
            up.names[k] = (new_name, struct.pack("<HH", *name_hashes(new_name)))


def make_texture(template):
    data = cooked_texture.rebuild(template, bgra_mips(moon_albedo()), fmt="PF_B8G8R8A8")
    up = UPackage(data)
    set_path(up, "CC_Artboard-1", TEXTURE)
    return cooked_texture.relocate(up.save())          # the rename moved the export


# ---- material instance
def fstr_tag_name(up, name):
    return up.fname(name)


def prop(up, name, ptype, value, struct_name=None):
    if ptype == "NameProperty":
        return up.fname(name) + up.fname(ptype) + struct.pack("<ii", 8, 0) + b"\0" + up.fname(value)
    if ptype == "FloatProperty":
        return up.fname(name) + up.fname(ptype) + struct.pack("<ii", 4, 0) + b"\0" + struct.pack("<f", value)
    if ptype == "ObjectProperty":
        return up.fname(name) + up.fname(ptype) + struct.pack("<ii", 4, 0) + b"\0" + struct.pack("<i", value)
    if ptype == "StructProperty":
        return (up.fname(name) + up.fname(ptype) + struct.pack("<ii", len(value), 0) + up.fname(struct_name)
                + b"\0" * 16 + b"\0" + value)
    raise ValueError(ptype)


def struct_array(up, name, struct_name, elements):
    """ArrayProperty of structs (elements: lists of encoded tags)."""
    body = b"".join(b"".join(e) + up.fname("None") for e in elements)
    inner = (up.fname(name) + up.fname("StructProperty") + struct.pack("<ii", len(body), 0)
             + up.fname(struct_name) + b"\0" * 16 + b"\0")
    value = struct.pack("<i", len(elements)) + inner + body
    return up.fname(name) + up.fname("ArrayProperty") + struct.pack("<ii", len(value), 0) + up.fname("StructProperty") + b"\0" + value


def make_material(template):
    up = UPackage(template)
    set_path(up, "MI_SkinTest_Asian", MATERIAL)
    # Imports: parent MI_SkinTest_Caucasian -> Material GTMaterial2, texture
    # Head_Asian_NM -> MenuMoon.
    for k, imp in enumerate(up.imports):
        cpkg, cname, outer, obj = struct.unpack_from("<8s8si8s", imp)
        cls = up.names[struct.unpack_from("<i", cname)[0]][0]
        objn = up.names[struct.unpack_from("<i", obj)[0]][0]
        if objn == "/Game/Character/Player/TEST/MI_SkinTest_Caucasian":
            up.imports[k] = cpkg + cname + struct.pack("<i", outer) + up.fname("/Game/GTMaterial2")
        elif objn == "MI_SkinTest_Caucasian":
            parent = -(k + 1)
            up.imports[k] = up.fname("/Script/Engine") + up.fname("Material") + struct.pack("<i", outer) + up.fname("GTMaterial2")
        elif objn == "/Game/Character/Player/TEST/Head_Asian_NM":
            up.imports[k] = cpkg + cname + struct.pack("<i", outer) + up.fname(TEXTURE)
        elif objn == "Head_Asian_NM":
            texture = -(k + 1)
            up.imports[k] = cpkg + cname + struct.pack("<i", outer) + up.fname(TEXTURE.rsplit("/", 1)[1])
    guid = struct.pack("<16x")
    tags = [
        prop(up, "Parent", "ObjectProperty", parent),
        struct_array(up, "ScalarParameterValues", "ScalarParameterValue", [
            [prop(up, "ParameterName", "NameProperty", n), prop(up, "ParameterValue", "FloatProperty", v),
             prop(up, "ExpressionGUID", "StructProperty", guid, "Guid")]
            for n, v in (("EmissiveBrightness", BRIGHTNESS), ("Brightness", 1.0))]),
        struct_array(up, "TextureParameterValues", "TextureParameterValue", [
            [prop(up, "ParameterName", "NameProperty", "UITexture"), prop(up, "ParameterValue", "ObjectProperty", texture),
             prop(up, "ExpressionGUID", "StructProperty", guid, "Guid")]]),
        struct_array(up, "VectorParameterValues", "VectorParameterValue", [
            [prop(up, "ParameterName", "NameProperty", n),
             prop(up, "ParameterValue", "StructProperty", struct.pack("<4f", *v), "LinearColor"),
             prop(up, "ExpressionGUID", "StructProperty", guid, "Guid")]
            for n, v in (("EmissiveColor", (1.0, 1.0, 1.0, 1.0)), ("Blaq", (0.5, 0.5, 0.5, 1.0)))]),
    ]
    old = up.exports[0]["data"]
    tail = old[old.rfind(up.fname("None")) + 8:]          # native data after the tags
    up.exports[0]["data"] = b"".join(tags) + up.fname("None") + tail
    return up.save()


# ---- level
def moon_location():
    y, e = np.radians(MOON_YAW), np.radians(MOON_ELEVATION)
    d = np.array([np.cos(e) * np.cos(y), np.cos(e) * np.sin(y), np.sin(e)])
    return tuple(float(v) for v in np.array(CAMERA) + DISTANCE * d)


def make_level(source):
    loc = moon_location()
    data, _, _, _ = apply_rule(source, plane_rule(loc))
    up = UPackage(data)
    pkg = UPackage(data)
    outer = up.add_import("/Script/CoreUObject", "Package", 0, SPHERE)
    mesh = up.add_import("/Script/Engine", "StaticMesh", outer, "Sphere")
    outer = up.add_import("/Script/CoreUObject", "Package", 0, MATERIAL)
    mat = up.add_import("/Script/Engine", "MaterialInstanceConstant", outer, MATERIAL.rsplit("/", 1)[1])
    data = up.save()
    p = Package(data)
    out = bytearray(data)
    scale = DISTANCE * np.tan(np.radians(ANGULAR_DIAMETER / 2)) / SPHERE_RADIUS
    for a, root in actor_roots(p):
        if p.exports[a - 1]["name"] != SEA_SOURCE:
            continue
        props = export_props(p, root)
        struct.pack_into("<i", out, props["StaticMesh"][1], mesh)
        struct.pack_into("<i", out, props["OverrideMaterials"][1] + 4, mat)
        struct.pack_into("<3f", out, props["RelativeScale3D"][1], scale, scale, scale)
        for k in ("LDMaxDrawDistance", "CachedMaxDrawDistance"):
            if k in props:
                struct.pack_into("<f", out, props[k][1], 0.0)
        up = UPackage(bytes(out))
        e = up.exports[root - 1]
        e["data"] = (encode_tag(up, "CastShadow", "BoolProperty", False)
                     + encode_tag(up, "bCastDynamicShadow", "BoolProperty", False) + e["data"])
        return up.save(), loc, scale
    raise KeyError(SEA_SOURCE)


def main(paks_dir):
    src = find_in_paks(paks_dir, {TEXTURE_TEMPLATE, MIC_TEMPLATE, LEVEL_SOURCE})
    os.makedirs(FRONTEND, exist_ok=True)
    open(os.path.join(FRONTEND, "MenuMoon.uasset"), "wb").write(make_texture(src[TEXTURE_TEMPLATE]))
    open(os.path.join(FRONTEND, "MI_MenuMoon.uasset"), "wb").write(make_material(src[MIC_TEMPLATE]))
    level, loc, scale = make_level(src[LEVEL_SOURCE])
    open(os.path.join(FRONTEND, "Arena_Moon.umap"), "wb").write(level)
    Image.fromarray(moon_albedo(512, 256)).save(os.path.join(HERE, "branding", "moon_preview.png"))
    print("moon at", [round(v) for v in loc], "scale %.1f" % scale)


if __name__ == "__main__":
    main(sys.argv[1])
