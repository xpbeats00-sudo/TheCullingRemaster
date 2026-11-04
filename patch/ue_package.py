"""Rewriter for The Culling's cooked UE 4.15 packages (unversioned, legacy -7).

Supports appending names and exports and replacing export data; every table
offset, export serial offset and the bulk-data offset is recomputed on save.

Layout of these packages:
  summary | name table | import table | export table (96 B/entry)
  | depends map (4 B/export, all empty) | asset registry | export data | tag
"""
import struct

from ue_names import name_hashes

# class, super, template, outer, name(index, number), flags, serial size,
# serial offset, forced/not-client/not-server, guid, package flags,
# not-for-editor-game, is-asset, first export dependency, 4 dependency counts
EXPORT_ENTRY = struct.Struct("<4i2iI5i16sI3i4i")  # 96 bytes
assert EXPORT_ENTRY.size == 96


def _fstring(s):
    b = s.encode("latin1") + b"\0"
    return struct.pack("<i", len(b)) + b


class UPackage:
    def __init__(self, data):
        self.src = data
        r = _R(data)
        assert r.u32() == 0x9E2A83C1
        assert r.i32() == -7
        r.i32(); r.i32(); r.i32()
        assert r.i32() == 0, "custom versions not supported"
        self.pos_total_header = r.p; r.i32()
        r.fstr()
        r.u32()                                   # package flags
        self.pos_names = r.p
        name_count, name_off = r.i32(), r.i32()
        r.i32(); r.i32()                          # gatherable text
        export_count, export_off = r.i32(), r.i32()
        import_count, import_off = r.i32(), r.i32()
        r.i32()                                   # depends offset (0 in cooked data)
        r.i32(); r.i32(); r.i32(); r.i32()        # string asset refs, searchable names, thumbnails
        r.skip(16)                                # guid
        self.pos_generations = r.p
        gens = r.i32()
        assert gens == 1
        r.skip(8)
        for _ in range(2):                        # saved-by / compatible engine versions
            r.skip(10); r.fstr()
        r.u32()                                   # compression flags
        assert r.i32() == 0, "compressed packages not supported"
        r.u32()                                   # package source
        for _ in range(r.i32()):                  # additional packages to cook
            r.fstr()
        self.pos_asset_registry = r.p
        asset_registry_off = r.i32()
        self.pos_bulk = r.p
        bulk_off = r.i64()
        r.i32()                                   # world tile info
        for _ in range(r.i32()):                  # chunk ids
            r.i32()
        self.pos_preload = r.p
        r.i32(); r.i32()                          # preload dependency count/offset
        self.summary = bytearray(data[:r.p])
        assert r.p == name_off

        self.names = []
        r.p = name_off
        for _ in range(name_count):
            s = r.fstr()
            h = r.d[r.p:r.p + 4]; r.p += 4
            self.names.append((s, h))
        assert r.p == import_off
        self.imports = [data[import_off + i * 28: import_off + (i + 1) * 28] for i in range(import_count)]
        assert import_off + import_count * 28 == export_off

        self.exports = []
        for i in range(export_count):
            f = list(EXPORT_ENTRY.unpack_from(data, export_off + i * 96))
            size, off = f[7], f[8]
            self.exports.append({"fields": f, "data": data[off:off + size]})
        depends_off = export_off + export_count * 96
        assert data[depends_off:asset_registry_off] == b"\0" * (4 * export_count), "unexpected depends map"
        self.asset_registry = data[asset_registry_off:struct.unpack_from("<i", data, self.pos_total_header)[0]]
        self.export_order = sorted(range(export_count), key=lambda i: self.exports[i]["fields"][8])
        self.tail = data[bulk_off:]
        first = min(e["fields"][8] for e in self.exports)
        assert first == struct.unpack_from("<i", data, self.pos_total_header)[0]

    # ---- names
    def name_index(self, s, add=True):
        for i, (n, _) in enumerate(self.names):
            if n == s:
                return i
        if not add:
            raise KeyError(s)
        self.names.append((s, struct.pack("<HH", *name_hashes(s))))
        return len(self.names) - 1

    def fname(self, s, number=0):
        return struct.pack("<ii", self.name_index(s), number)

    def name_str(self, index, number=0):
        n = self.names[index][0]
        return n if number == 0 else "%s_%d" % (n, number - 1)

    # ---- imports
    def add_import(self, class_package, class_name, outer, object_name):
        """Append an import (outer: 0 or another import's negative index) and
        return its negative index. Only for packages without preload
        dependency tables (all of The Culling's cooked maps)."""
        assert struct.unpack_from("<i", self.summary, self.pos_preload)[0] == -1
        self.imports.append(self.fname(class_package) + self.fname(class_name)
                            + struct.pack("<i", outer) + self.fname(object_name))
        return -len(self.imports)

    # ---- exports
    def find_export(self, name):
        for i, e in enumerate(self.exports):
            f = e["fields"]
            if self.name_str(f[4], f[5]) == name:
                return i + 1
        raise KeyError(name)

    def add_export(self, fields, data):
        self.exports.append({"fields": list(fields), "data": bytes(data)})
        self.export_order.append(len(self.exports) - 1)
        return len(self.exports)

    # ---- save
    def save(self):
        names = b"".join(_fstring(s) + h for s, h in self.names)
        imports = b"".join(self.imports)
        n_exp = len(self.exports)
        name_off = len(self.summary)
        import_off = name_off + len(names)
        export_off = import_off + len(imports)
        depends_off = export_off + 96 * n_exp
        asset_registry_off = depends_off + 4 * n_exp
        header_end = asset_registry_off + len(self.asset_registry)

        pos = header_end
        for i in self.export_order:
            e = self.exports[i]
            e["fields"][7] = len(e["data"])
            e["fields"][8] = pos
            pos += len(e["data"])
        bulk_off = pos

        s = self.summary
        struct.pack_into("<i", s, self.pos_total_header, header_end)
        struct.pack_into("<ii", s, self.pos_names, len(self.names), name_off)
        struct.pack_into("<iiii", s, self.pos_names + 16, n_exp, export_off, len(self.imports), import_off)
        struct.pack_into("<ii", s, self.pos_generations + 4, n_exp, len(self.names))
        struct.pack_into("<i", s, self.pos_asset_registry, asset_registry_off)
        struct.pack_into("<q", s, self.pos_bulk, bulk_off)
        struct.pack_into("<i", s, self.pos_preload + 4, header_end)

        out = bytearray(s)
        out += names + imports
        for e in self.exports:
            out += EXPORT_ENTRY.pack(*e["fields"])
        out += b"\0" * (4 * n_exp)
        out += self.asset_registry
        assert len(out) == header_end
        for i in self.export_order:
            out += self.exports[i]["data"]
        out += self.tail
        return bytes(out)


class _R:
    def __init__(self, d):
        self.d, self.p = d, 0

    def i32(self):
        v = struct.unpack_from("<i", self.d, self.p)[0]; self.p += 4; return v

    def u32(self):
        v = struct.unpack_from("<I", self.d, self.p)[0]; self.p += 4; return v

    def i64(self):
        v = struct.unpack_from("<q", self.d, self.p)[0]; self.p += 8; return v

    def skip(self, n):
        self.p += n

    def fstr(self):
        n = self.i32()
        if n < 0:
            s = self.d[self.p:self.p - 2 * n].decode("utf-16le"); self.p += -2 * n
        else:
            s = self.d[self.p:self.p + n].decode("latin1"); self.p += n
        return s.rstrip("\0")
