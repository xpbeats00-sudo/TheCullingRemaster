"""List mesh components in a cooked level with their mesh and world-ish
location (RelativeLocation of root components), optionally filtered.

usage: python level_survey.py <map.umap> [mesh-name regex]
"""
import os
import re
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from uasset import Package, Reader  # noqa: E402


def export_props(pkg, index):
    """Tagged properties of export #index (1-based) as {name: (type, offset, size, extra)}."""
    e = pkg.exports[index - 1]
    r = Reader(pkg.data, e["offset"])
    end = e["offset"] + e["size"]
    out = {}
    while r.p < end:
        name = pkg.fname(r)
        if name == "None":
            break
        ptype = pkg.fname(r)
        size, _idx = r.i32(), r.i32()
        extra = None
        if ptype == "StructProperty":
            extra = pkg.fname(r); r.skip(16)
        elif ptype == "BoolProperty":
            extra = r.u8()
        elif ptype in ("ByteProperty", "EnumProperty", "ArrayProperty"):
            extra = pkg.fname(r)
        if r.u8():
            r.skip(16)
        out[name] = (ptype, r.p, size, extra)
        r.p += size
    return out


def vector(pkg, off):
    return struct.unpack_from("<3f", pkg.data, off)


def components(pkg):
    for i, e in enumerate(pkg.exports, 1):
        cls = str(pkg.ref(e["class"]))
        if not cls.endswith("MeshComponent") and cls != "SceneComponent":
            continue
        props = export_props(pkg, i)
        mesh = None
        if "StaticMesh" in props:
            mesh = pkg.ref(struct.unpack_from("<i", pkg.data, props["StaticMesh"][1])[0])
        loc = vector(pkg, props["RelativeLocation"][1]) if "RelativeLocation" in props else None
        attached = "AttachParent" in props
        yield i, e["name"], cls, mesh, loc, attached


def main():
    pkg = Package(open(sys.argv[1], "rb").read())
    pat = re.compile(sys.argv[2], re.I) if len(sys.argv) > 2 else None
    for i, name, cls, mesh, loc, attached in components(pkg):
        if pat and not (mesh and pat.search(str(mesh))):
            continue
        if loc is None or attached:
            continue
        print("%5d %-30s %-24s %-40s (%.0f, %.0f, %.0f)" % (i, name[:30], cls[:24], str(mesh)[:40], *loc))


if __name__ == "__main__":
    main()
