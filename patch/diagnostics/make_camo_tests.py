"""DIAGNOSTICS ONLY - never part of a release build (patch/build_release.py
doesn't run it, and make_pak.py refuses to pack its IceAxe_A_XPTest mesh and
the skins that point at it). It rewrites four of make_camos.py's Ice Axe camo
skins in patch/src; run make_camos.py again before a release build to put the
plain skins back. For a local diagnostics pak only:
make_pak.py <src> <out> --allow-test-content.

Diagnostics for animated camos on the Ice Axe (run after make_animated_camos.py).

Each listed Ice Axe camo skin isolates one piece:
  Frost Plasma   plain 4-color camo (no GeoSkin, no BC)           - control
  Lava Storm     BC = full-color camo image, no GeoSkin           - BC override
  Teal Current   GeoSkin = stock FireAxe_C (Slayer)                - GeoSkin in preview
  Blue Tempest   GeoSkin = mesh copy with the stock IceAxe_A_MI    - mesh copy
  Arcane Surge   full animated (mesh copy + chainsaw material)    - material copy

usage: python patch/diagnostics/make_camo_tests.py <Paks dir>
"""
import os
import struct
import sys

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))     # patch/
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import make_animated_camos as anim  # noqa: E402
import make_camos  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from ue_package import UPackage  # noqa: E402

SKIN = os.path.join(anim.SKINS, "IceAxe_XP_%s.uasset")
MESH = "Victory/Content/Character/Weapons/IceAxe_A.uasset"


def set_tags(path, geo=None, bc=None):
    up = UPackage(open(path, "rb").read())
    data = up.exports[0]["data"]
    kept, end = b"", 0
    for name, ptype, start, voff, size in make_camos.iter_tags(up, data):
        kept += data[end:start]
        if name not in ("GeoSkin", "BC"):
            kept += data[start:voff + size]
        end = voff + size
    head = b""
    if geo:
        head += anim.asset_tag(up, "GeoSkin", geo)
    if bc:
        head += anim.asset_tag(up, "BC", bc)
    up.exports[0]["data"] = head + kept + data[end:]
    with open(path, "wb") as f:
        f.write(up.save())


def main(paks_dir):
    mesh = find_in_paks(paks_dir, {MESH})[MESH]
    up = UPackage(mesh)
    anim.rename(up, {"/Game/Character/Weapons/IceAxe_A": "/Game/Character/Weapons/IceAxe_A_XPTest"})
    anim.write("IceAxe_A_XPTest", up.save())
    bc = "/Game/Character/Weapons/Camo_XP_Anim_Lava_Storm.Camo_XP_Anim_Lava_Storm"
    set_tags(SKIN % "Frost_Plasma")
    set_tags(SKIN % "Lava_Storm", bc=bc)
    set_tags(SKIN % "Teal_Current", geo="/Game/Character/Weapons/FireAxe_C.FireAxe_C")
    set_tags(SKIN % "Blue_Tempest", geo="/Game/Character/Weapons/IceAxe_A_XPTest.IceAxe_A")
    print("Ice Axe test skins written")


if __name__ == "__main__":
    main(sys.argv[1])
