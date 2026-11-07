"""List or extract files from a UE4 pak v3 (the format make_pak.py writes).

usage: python pak_read.py <pak> [name filter] [extract dir]
"""
import os, struct, sys, zlib


def fstring(d, o):
    n = struct.unpack_from("<i", d, o)[0]; o += 4
    if n < 0:
        s = d[o:o - 2 * n].decode("utf-16le")[:-1]; o += -2 * n
    else:
        s = d[o:o + n].decode("latin-1")[:-1]; o += n
    return s, o


def index(path):
    f = open(path, "rb")
    f.seek(-44, 2)
    foot = f.read(44)
    magic, ver, ioff, isize = struct.unpack_from("<IiQQ", foot, 0)
    assert magic == 0x5A6F12E1, hex(magic)
    f.seek(ioff)
    d = f.read(isize)
    mount, o = fstring(d, 0)
    n = struct.unpack_from("<i", d, o)[0]; o += 4
    out = []
    for _ in range(n):
        name, o = fstring(d, o)
        off, size, usize, comp = struct.unpack_from("<QQQi", d, o); o += 28
        o += 20  # sha1
        blocks = []
        if comp:
            nb = struct.unpack_from("<i", d, o)[0]; o += 4
            for _ in range(nb):
                blocks.append(struct.unpack_from("<QQ", d, o)); o += 16
        enc, bsize = struct.unpack_from("<BI", d, o); o += 5
        out.append((name, off, size, usize, comp, blocks))
    return f, mount, out


def extract(f, e):
    name, off, size, usize, comp, blocks = e
    if not comp:
        f.seek(off + 53)  # in-file header: 8+8+8+4+20+1+4 = 53 for uncompressed v3
        return f.read(size)
    data = b""
    for a, b in blocks:
        f.seek(a); data += zlib.decompress(f.read(b - a))
    return data


if __name__ == "__main__":
    f, mount, entries = index(sys.argv[1])
    pat = sys.argv[2] if len(sys.argv) > 2 else ""
    for e in entries:
        if pat.lower() in e[0].lower():
            print(e[0], e[3])
            if len(sys.argv) > 3:
                open(os.path.join(sys.argv[3], os.path.basename(e[0])), "wb").write(extract(f, e))
