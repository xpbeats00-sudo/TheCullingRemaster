"""The patch's AssetRegistry.bin: the stock (cooked, v1) registry plus the
records every generator saved.

Generators call save(<their name>, [record(...)]) and then build(<Paks dir>),
which writes src/Victory/AssetRegistry.bin from the stock file and all saved
record sets, so each generator can be re-run on its own.
"""
import glob
import os
import struct

HERE = os.path.dirname(os.path.abspath(__file__))
RECORDS = os.path.join(HERE, "registry")
STOCK = "Victory/AssetRegistry.bin"
OUT = os.path.join(HERE, "src", "Victory", "AssetRegistry.bin")


def _fstring(s):
    b = s.encode("latin1") + b"\0"
    return struct.pack("<i", len(b)) + b


def record(package_path, class_name, flags=0x40000, chunk=11):
    """A tagless asset record, as the stock cosmetics have (package path
    like /Game/Cosmetics/WeaponSkins/IceAxe_01)."""
    folder, name = package_path.rsplit("/", 1)
    return (_fstring("%s.%s" % (package_path, name)) + _fstring(folder) + _fstring(class_name)
            + _fstring("None") + _fstring(package_path) + _fstring(name)
            + struct.pack("<iiiI", 0, 1, chunk, flags))


def save(name, records):
    os.makedirs(RECORDS, exist_ok=True)
    with open(os.path.join(RECORDS, name + ".bin"), "wb") as f:
        f.write(struct.pack("<i", len(records)) + b"".join(records))


def _end_of_assets(data):
    p = 16
    version, count = struct.unpack_from("<ii", data, p)
    assert version == 1
    p += 8

    def skip_fstring(q):
        n = struct.unpack_from("<i", data, q)[0]
        return q + 4 + (n if n >= 0 else -2 * n)

    for _ in range(count):
        for _ in range(6):
            p = skip_fstring(p)
        tags = struct.unpack_from("<i", data, p)[0]
        p += 4
        for _ in range(2 * tags):
            p = skip_fstring(p)
        chunks = struct.unpack_from("<i", data, p)[0]
        p += 4 + 4 * chunks + 4
    return count, p


def build(paks_dir):
    from patch_assets import find_in_paks
    stock = find_in_paks(paks_dir, {STOCK})[STOCK]
    count, end = _end_of_assets(stock)
    added, blobs = 0, []
    for f in sorted(glob.glob(os.path.join(RECORDS, "*.bin"))):
        data = open(f, "rb").read()
        added += struct.unpack_from("<i", data, 0)[0]
        blobs.append(data[4:])
    out = bytearray(stock[:end]) + b"".join(blobs) + stock[end:]
    struct.pack_into("<i", out, 20, count + added)
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "wb") as f:
        f.write(out)
    print("asset registry: %d stock + %d added" % (count, added))
