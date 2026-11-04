"""Read a cooked asset's tagged properties as nested Python values: structs
as dicts, arrays of structs as lists of dicts, object references as names
(uasset.Package only reads the top level).

    Tree(Package(data)).props(export["offset"], export["offset"] + export["size"])

Generated struct member names keep the editor's suffixes
("ItemWeight_13_4A10..."); clean() strips them.
"""
import re
import struct


def clean(name):
    """ItemWeight_13_4A10C1314BD4B19720E5298DEA482D33 -> ItemWeight"""
    return re.sub(r"_\d+_[0-9A-F]{32}$", "", name)


class Tree:
    def __init__(self, pkg):
        self.pkg, self.d = pkg, pkg.data

    def fname(self, p):
        i, n = struct.unpack_from("<ii", self.d, p)
        s = self.pkg.names[i] if 0 <= i < len(self.pkg.names) else "?%d" % i
        return (s if n == 0 else "%s_%d" % (s, n - 1)), p + 8

    def obj(self, v):
        try:
            r = self.pkg.ref(v)
            return r if isinstance(r, str) else (r or "None")
        except Exception:
            return "obj%d" % v

    def value(self, ptype, p, size, extra, depth):
        d = self.d
        if ptype == "IntProperty": return struct.unpack_from("<i", d, p)[0]
        if ptype == "FloatProperty": return round(struct.unpack_from("<f", d, p)[0], 3)
        if ptype in ("ObjectProperty", "ClassProperty"): return self.obj(struct.unpack_from("<i", d, p)[0])
        if ptype == "NameProperty": return self.fname(p)[0]
        if ptype in ("ByteProperty", "EnumProperty"):
            return self.fname(p)[0] if size == 8 else d[p]
        if ptype == "StrProperty":
            n = struct.unpack_from("<i", d, p)[0]
            return d[p + 4:p + 4 + n - 1].decode("latin1") if n > 0 else d[p + 4:p + 4 - 2 * n - 2].decode("utf-16le")
        if ptype == "AssetObjectProperty":
            n = struct.unpack_from("<i", d, p)[0]
            return d[p + 4:p + 4 + n - 1].decode("latin1")
        if ptype == "StructProperty":
            if extra in ("Vector",): return tuple(round(x, 1) for x in struct.unpack_from("<3f", d, p))
            if extra in ("Rotator",): return tuple(round(x, 1) for x in struct.unpack_from("<3f", d, p))
            if extra in ("LinearColor",): return tuple(round(x, 3) for x in struct.unpack_from("<4f", d, p))
            if extra in ("Guid", "Color", "Vector2D", "IntPoint"): return d[p:p + size].hex()
            return self.props(p, p + size, depth + 1)
        if ptype == "ArrayProperty":
            n = struct.unpack_from("<i", d, p)[0]; q = p + 4
            if extra == "StructProperty":
                # inner tag
                _, q = self.fname(q); _, q = self.fname(q); isz = struct.unpack_from("<i", d, q)[0]; q += 8
                sname, q = self.fname(q); q += 16 + 1
                out = []
                for _ in range(n):
                    if sname in ("Vector", "Rotator"):
                        out.append(tuple(round(x, 1) for x in struct.unpack_from("<3f", d, q))); q += 12
                    else:
                        items, q = self.props(q, p + size, depth + 1, ret_end=True)
                        out.append(items)
                return out
            out = []
            for _ in range(n):
                if extra in ("ObjectProperty", "ClassProperty", "IntProperty"):
                    v = struct.unpack_from("<i", d, q)[0]; q += 4
                    out.append(self.obj(v) if extra != "IntProperty" else v)
                elif extra == "NameProperty":
                    v, q = self.fname(q); out.append(v)
                elif extra == "FloatProperty":
                    out.append(round(struct.unpack_from("<f", d, q)[0], 3)); q += 4
                elif extra in ("StrProperty", "AssetObjectProperty"):
                    m = struct.unpack_from("<i", d, q)[0]; out.append(d[q + 4:q + 4 + m - 1].decode("latin1")); q += 4 + m
                elif extra == "ByteProperty":
                    out.append(d[q]); q += 1
                else:
                    return "[%d x %s]" % (n, extra)
            return out
        if ptype == "BoolProperty": return extra
        return "<%s %d>" % (ptype, size)

    def props(self, p, end, depth=0, ret_end=False):
        out = {}
        while p < end:
            name, p = self.fname(p)
            if name == "None":
                break
            ptype, p = self.fname(p)
            size, idx = struct.unpack_from("<ii", self.d, p); p += 8
            extra = None
            if ptype == "StructProperty":
                extra, p = self.fname(p); p += 16
            elif ptype == "BoolProperty":
                extra = bool(self.d[p]); p += 1
            elif ptype in ("ByteProperty", "EnumProperty", "ArrayProperty", "SetProperty"):
                extra, p = self.fname(p)
            elif ptype == "MapProperty":
                p += 16
            g = self.d[p]; p += 1 + (16 if g else 0)
            try:
                v = self.value(ptype, p, size, extra, depth)
            except Exception as e:
                v = "ERR %s" % e
            out[name if idx == 0 else "%s[%d]" % (name, idx)] = v
            p += size
        return (out, p) if ret_end else out
