"""Minimal reader/patcher for The Culling's cooked UE 4.15 .uasset files.

Enough to list exports and the tagged default properties of an export
(for example a blueprint's Default__ object), and to overwrite fixed-size
property values (int/float/bool/byte) in place without changing file size.

usage:
  python uasset.py exports <file>
  python uasset.py props <file> <export name>
  python uasset.py set <file> <out> <export name> <prop>[<idx>]=<value> ...
"""
import struct
import sys


class Reader:
    def __init__(self, data, pos=0):
        self.d, self.p = data, pos

    def i32(self):
        v = struct.unpack_from("<i", self.d, self.p)[0]; self.p += 4; return v

    def u32(self):
        v = struct.unpack_from("<I", self.d, self.p)[0]; self.p += 4; return v

    def i64(self):
        v = struct.unpack_from("<q", self.d, self.p)[0]; self.p += 8; return v

    def u16(self):
        v = struct.unpack_from("<H", self.d, self.p)[0]; self.p += 2; return v

    def u8(self):
        v = self.d[self.p]; self.p += 1; return v

    def skip(self, n):
        self.p += n

    def fstr(self):
        n = self.i32()
        if n == 0:
            return ""
        if n < 0:
            s = self.d[self.p:self.p - 2 * n].decode("utf-16le"); self.p += -2 * n
        else:
            s = self.d[self.p:self.p + n].decode("latin1"); self.p += n
        return s.rstrip("\0")


class Package:
    def __init__(self, data):
        self.data = data
        r = Reader(data)
        assert r.u32() == 0x9E2A83C1, "not a uasset"
        legacy = r.i32()
        assert legacy == -7, legacy
        r.i32()                       # legacy UE3 version
        r.i32(); r.i32()              # UE4 / licensee version (0 = unversioned)
        for _ in range(r.i32()):      # custom versions
            r.skip(20)
        r.i32()                       # total header size
        r.fstr()                      # folder name
        r.u32()                       # package flags
        name_count, name_off = r.i32(), r.i32()
        r.i32(); r.i32()              # gatherable text
        export_count, export_off = r.i32(), r.i32()
        import_count, import_off = r.i32(), r.i32()

        r.p = name_off
        self.names = []
        for _ in range(name_count):
            self.names.append(r.fstr())
            r.skip(4)                 # name hashes

        r.p = import_off
        self.imports = []
        for _ in range(import_count):
            r.skip(16)                # class package, class name
            outer = r.i32()
            self.imports.append(self.fname(r))

        r.p = export_off
        self.exports = []
        for _ in range(export_count):
            cls, sup, tmpl, outer = r.i32(), r.i32(), r.i32(), r.i32()
            name = self.fname(r)
            r.u32()                   # object flags
            size, off = r.i32(), r.i32()
            r.skip(4 * 3 + 16 + 4 + 4 + 4 + 4 * 5)
            self.exports.append({"name": name, "class": cls, "size": size, "offset": off})

    def fname(self, r):
        idx, num = r.i32(), r.i32()
        n = self.names[idx]
        return n if num == 0 else "%s_%d" % (n, num - 1)

    def ref(self, i):
        if i < 0:
            return self.imports[-i - 1]
        if i > 0:
            return self.exports[i - 1]["name"]
        return None

    def export(self, name):
        for e in self.exports:
            if e["name"] == name:
                return e
        raise KeyError(name)

    def props(self, name):
        """Yield (name, type, array index, value offset, size, extra, value)."""
        e = self.export(name)
        r = Reader(self.data, e["offset"])
        end = e["offset"] + e["size"]
        while r.p < end:
            pname = self.fname(r)
            if pname == "None":
                break
            ptype = self.fname(r)
            size, idx = r.i32(), r.i32()
            extra = None
            if ptype == "StructProperty":
                extra = self.fname(r); r.skip(16)
            elif ptype == "BoolProperty":
                extra = r.u8()
            elif ptype in ("ByteProperty", "EnumProperty"):
                extra = self.fname(r)
            elif ptype in ("ArrayProperty", "SetProperty"):
                extra = self.fname(r)
            elif ptype == "MapProperty":
                extra = (self.fname(r), self.fname(r))
            if r.u8():
                r.skip(16)            # property guid
            voff = r.p
            yield pname, ptype, idx, voff, size, extra, self.value(ptype, voff, size, extra)
            r.p = voff + size

    def value(self, ptype, off, size, extra):
        d = self.data
        if ptype == "IntProperty":
            return struct.unpack_from("<i", d, off)[0]
        if ptype == "FloatProperty":
            return struct.unpack_from("<f", d, off)[0]
        if ptype == "BoolProperty":
            return bool(extra)
        if ptype == "ByteProperty" and size == 1:
            return d[off]
        if ptype in ("NameProperty", "ByteProperty", "EnumProperty") and size == 8:
            return self.fname(Reader(d, off))
        if ptype == "StrProperty":
            return Reader(d, off).fstr()
        if ptype in ("ObjectProperty", "ClassProperty"):
            return self.ref(struct.unpack_from("<i", d, off)[0])
        if ptype == "ArrayProperty":
            return "[%d x %s]" % (struct.unpack_from("<i", d, off)[0], extra)
        return "<%d bytes>" % size


def set_values(pkg, export_name, assignments):
    data = bytearray(pkg.data)
    found = {}
    for pname, ptype, idx, voff, size, extra, value in pkg.props(export_name):
        found["%s[%d]" % (pname, idx)] = (ptype, voff, size, value)
        found.setdefault(pname, (ptype, voff, size, value))
    for a in assignments:
        key, val = a.split("=", 1)
        if key not in found:
            sys.exit("property %s not present in %s (only stored, non-default values can be patched)" % (key, export_name))
        ptype, voff, size, old = found[key]
        if ptype == "IntProperty":
            struct.pack_into("<i", data, voff, int(val))
        elif ptype == "FloatProperty":
            struct.pack_into("<f", data, voff, float(val))
        elif ptype == "ByteProperty" and size == 1:
            data[voff] = int(val)
        else:
            sys.exit("can't patch %s (%s)" % (key, ptype))
        print("%s: %s -> %s" % (key, old, val))
    return bytes(data)


def main():
    cmd, path = sys.argv[1], sys.argv[2]
    pkg = Package(open(path, "rb").read())
    if cmd == "exports":
        for e in pkg.exports:
            print(e["name"], pkg.ref(e["class"]), e["size"])
    elif cmd == "props":
        for pname, ptype, idx, voff, size, extra, value in pkg.props(sys.argv[3]):
            print("%-40s %-16s [%d] %s" % (pname, ptype, idx, value))
    elif cmd == "set":
        out = sys.argv[3]
        open(out, "wb").write(set_values(pkg, sys.argv[4], sys.argv[5:]))


if __name__ == "__main__":
    main()
