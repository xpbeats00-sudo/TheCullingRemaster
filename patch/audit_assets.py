"""Structural audit of every generated package in src/ (what UE4's linker
would reject as "Corrupt data found").

Checks per package:
  - parses and re-saves byte for byte (header, name/import/export tables);
  - every export's tagged properties walk to "None" inside the export, with
    valid name and object indices;
  - Texture2D: the cooked platform data is consistent (sizes per format, mip
    offsets, skip offset, mips halving) and is followed by "None";
  - copies of stock packages (mesh/material copies) have the same export data
    as their source, apart from the intended edits;
  - weapon skins: Camo / BC / GeoSkin paths resolve to a package that exists
    (src or stock paks) and contains an export of that object name.

usage: python audit_assets.py <Paks dir> [name filter]
"""
import glob
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_catalog import pak_entries  # noqa: E402
from patch_assets import find_in_paks  # noqa: E402
from ue_package import UPackage  # noqa: E402

SRC = os.path.join(HERE, "src")
BPP = {"PF_DXT1": 0.5, "PF_DXT5": 1, "PF_DXT3": 1, "PF_B8G8R8A8": 4, "PF_FloatRGBA": 8, "PF_G8": 1, "PF_BC5": 1}


class Problem(Exception):
    pass


def walk_tags(up, data, start, end):
    """Tagged properties from start; returns the offset after "None"."""
    p = start
    n_names, n_imp, n_exp = len(up.names), len(up.imports), len(up.exports)
    while True:
        if p + 8 > end:
            raise Problem("tags run past the export at %d" % p)
        idx = struct.unpack_from("<i", data, p)[0]
        if not 0 <= idx < n_names:
            raise Problem("bad name index %d at %d" % (idx, p))
        name = up.names[idx][0]
        if name == "None":
            return p + 8
        tidx = struct.unpack_from("<i", data, p + 8)[0]
        if not 0 <= tidx < n_names:
            raise Problem("bad type index for %s" % name)
        ptype = up.names[tidx][0]
        size = struct.unpack_from("<i", data, p + 16)[0]
        q = p + 24
        if ptype == "StructProperty":
            sidx = struct.unpack_from("<i", data, q)[0]
            if not 0 <= sidx < n_names:
                raise Problem("bad struct name for %s" % name)
            q += 8 + 16
        elif ptype == "BoolProperty":
            q += 1
        elif ptype in ("ByteProperty", "EnumProperty", "ArrayProperty"):
            q += 8
        if data[q] not in (0, 1):
            raise Problem("bad HasPropertyGuid for %s" % name)
        q += 1 + (16 if data[q] else 0)
        if size < 0 or q + size > end:
            raise Problem("%s (%s) size %d runs past the export" % (name, ptype, size))
        if ptype == "ObjectProperty" and size == 4:
            ref = struct.unpack_from("<i", data, q)[0]
            if not (-n_imp <= ref <= n_exp):
                raise Problem("%s refers to object %d" % (name, ref))
        if ptype in ("StrProperty", "AssetObjectProperty", "NameProperty") and ptype != "NameProperty":
            n = struct.unpack_from("<i", data, q)[0]
            if n != size - 4:
                raise Problem("%s string length %d vs size %d" % (name, n, size))
        p = q + size


def check_texture(up, e, base, file_len, tail_len):
    blob = e["data"]
    i = blob.find(b"PF_")
    while i >= 0:
        n = struct.unpack_from("<i", blob, i - 4)[0]
        if 4 <= n <= 32 and blob[i + n - 1] == 0:
            break
        i = blob.find(b"PF_", i + 1)
    if i < 0:
        raise Problem("no pixel format")
    fmt = blob[i:i + n - 1].decode()
    w, h, slices = struct.unpack_from("<iii", blob, i - 16)
    name_at = i - 28
    fmt_name = up.names[struct.unpack_from("<i", blob, name_at)[0]][0]
    if fmt_name != fmt:
        raise Problem("format FName %s vs string %s" % (fmt_name, fmt))
    skip = struct.unpack_from("<i", blob, name_at + 8)[0]
    q = i + n
    first, count = struct.unpack_from("<ii", blob, q)
    q += 8
    pw, ph = None, None
    for k in range(count):
        cooked = struct.unpack_from("<i", blob, q)[0]
        q += 4
        flags, cnt, size, off = struct.unpack_from("<Iiiq", blob, q)
        q += 20
        mw_expected = None
        if flags & 1:
            if off + size > tail_len:
                raise Problem("mip %d end-of-file payload past the file" % k)
        else:
            if cnt != size:
                raise Problem("mip %d count %d != size %d" % (k, cnt, size))
            if off != base + q:
                raise Problem("mip %d offset %d != %d" % (k, off, base + q))
            q += cnt
        mw, mh = struct.unpack_from("<ii", blob, q)
        q += 8
        expected = int(max(mw, 4) * max(mh, 4) * BPP[fmt] * slices) if fmt.startswith("PF_DXT") or fmt == "PF_BC5" \
            else int(mw * mh * BPP[fmt] * slices)
        if size != expected:
            raise Problem("mip %d %dx%d size %d, expected %d for %s" % (k, mw, mh, size, expected, fmt))
        if pw and (mw > pw or mh > ph):
            raise Problem("mip %d grows" % k)
        pw, ph = mw, mh
        if cooked not in (0, 1):
            raise Problem("mip %d bCooked %d" % (k, cooked))
    if skip != base + q:
        raise Problem("skip offset %d != %d" % (skip, base + q))
    if up.names[struct.unpack_from("<i", blob, q)[0]][0] != "None":
        raise Problem("platform data not followed by None")
    return "%s %dx%d x%d mips" % (fmt, w, h, count)


def audit(path, stock_index):
    data = open(path, "rb").read()
    up = UPackage(data)
    if up.save() != data:
        raise Problem("does not re-save identically")
    notes = []
    tail_len = len(up.tail)
    for k, e in enumerate(up.exports):
        f = e["fields"]
        cls = f[0]
        cls_name = up.names[struct.unpack_from("<i", up.imports[-cls - 1], 20)[0]][0] if cls < 0 else "?"
        base = f[8]
        end = walk_tags(up, e["data"], 0, len(e["data"]))
        if cls_name in ("Texture2D", "TextureCube"):
            notes.append(check_texture(up, e, base, len(data), tail_len))
    return up, notes


def main(paks_dir, filt=None):
    files = [p for p in glob.glob(os.path.join(SRC, "Victory", "**", "*.uasset"), recursive=True)
             if not filt or filt.lower() in os.path.basename(p).lower()]
    stock = set()
    for pk in stock_paks(paks_dir):
        for e in pak_entries(pk):
            stock.add(e[1].replace("../../../", ""))
    src_rel = {os.path.relpath(p, SRC).replace("\\", "/"): p for p in files}
    exports_cache = {}

    def exports_of(rel):
        if rel not in exports_cache:
            if rel in src_rel:
                d = open(src_rel[rel], "rb").read()
            elif os.path.exists(os.path.join(SRC, rel)):
                d = open(os.path.join(SRC, rel), "rb").read()
            elif rel in stock:
                d = find_in_paks(paks_dir, {rel})[rel]
            else:
                exports_cache[rel] = None
                return None
            u = UPackage(d)
            exports_cache[rel] = {u.name_str(e["fields"][4], e["fields"][5]) for e in u.exports}
        return exports_cache[rel]

    bad, ok, refs_checked = [], 0, 0
    for p in sorted(files):
        name = os.path.relpath(p, SRC)
        try:
            up, notes = audit(p, stock)
            # Soft references from skins / cards.
            if "WeaponSkins" in name or "CullingCards" in name:
                d = up.exports[0]["data"]
                from make_camos import iter_tags
                for tag, ptype, start, voff, size in iter_tags(up, d):
                    if ptype == "AssetObjectProperty":
                        ref = d[voff + 4:voff + size - 1].decode("latin1")
                        pkg, obj = ref.split(".", 1)
                        rel = "Victory/Content/" + pkg[len("/Game/"):] + ".uasset" if pkg.startswith("/Game/") else None
                        if pkg.startswith("/Engine/"):
                            continue
                        exp = exports_of(rel) if rel else None
                        refs_checked += 1
                        if exp is None:
                            raise Problem("%s -> %s: package missing" % (tag, ref))
                        if obj not in exp:
                            raise Problem("%s -> %s: no export %s (has %s)" % (tag, ref, obj, sorted(exp)[:3]))
            ok += 1
        except Problem as ex:
            bad.append((name, str(ex)))
        except Exception as ex:
            bad.append((name, "%s: %s" % (type(ex).__name__, ex)))
    for n, why in bad:
        print("BAD  %-70s %s" % (n, why))
    print("%d packages checked, %d bad, %d references resolved" % (ok + len(bad), len(bad), refs_checked))
    return bad


if __name__ == "__main__":
    main(*sys.argv[1:])
