"""Build a zlib-compressed UE4 (pak v3) patch pak from a directory tree.

usage: python make_pak.py <src_dir> <out.pak>

Every file under <src_dir> is stored at "../../../<relative path>", the same
layout the game's own paks use, so src/Victory/Content/... overrides the
matching file inside the base paks.

Test and diagnostic content is refused before anything is written (unless
--allow-test-content, for a local diagnostics build only):
- the animated-camo experiment's assets (<Mesh>_XPAnim*, Camo_XP_Anim_*,
  from make_animated_camos.py) and the Ice Axe test mesh (IceAxe_A_XPTest,
  make_camo_tests.py), by path;
- any file that mentions them or says "TEST BUILD" (ASCII or UTF-16);
- a custom camo skin (Cosmetics/WeaponSkins/*_XP_*) carrying a GeoSkin, BC
  or BC2 tag, except the VFX camos (*_XP_VFX_*, make_vfx_camos.py): those
  tags on a plain camo are make_camo_tests.py's Ice Axe diagnostics (Teal
  Current points at the stock FireAxe_C, so no name gives it away).
Rebuild with make_camos.py (and without make_camo_tests.py) to clear them.
test_content() lists what it finds.
"""
import re
import hashlib
import os
import struct
import sys
import zlib

PAK_MAGIC = 0x5A6F12E1
PAK_VERSION = 3
MOUNT_POINT = "../../../"


def fstring(s):
    b = s.encode("ascii") + b"\0"
    return struct.pack("<i", len(b)) + b


BLOCK_SIZE = 0x10000

TEST_NAMES = re.compile(r"XPAnim|XPTest|Camo_XP_Anim_", re.I)
# "_XPAnim" (not "XPAnim"): the stock EndOfMatch.js logs "XPAnimate".
TEST_TEXT = [b"_XPAnim", b"_XPTest", b"Camo_XP_Anim_", b"TEST BUILD"]
TEST_TEXT += [t.decode("ascii").encode("utf-16le") for t in TEST_TEXT]
DIAGNOSTIC_TAGS = {"GeoSkin", "BC", "BC2"}


def diagnostic_tags(data):
    """GeoSkin/BC/BC2 tags stored in a weapon skin package (empty if it does not parse)."""
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from make_camos import iter_tags
    from ue_package import UPackage
    try:
        up = UPackage(data)
        return {name for name, *_ in iter_tags(up, up.exports[0]["data"])} & DIAGNOSTIC_TAGS
    except Exception:
        return set()


def test_content(src):
    """[(relative path, why)] for every test or diagnostic file under src."""
    found = []
    for root, _, names in os.walk(src):
        for name in sorted(names):
            full = os.path.join(root, name)
            rel = os.path.relpath(full, src).replace(os.sep, "/")
            if TEST_NAMES.search(rel):
                found.append((rel, "test asset name"))
                continue
            data = open(full, "rb").read()
            hit = next((t for t in TEST_TEXT if t in data), None)
            if hit:
                found.append((rel, "mentions %r" % hit))
            elif "/Cosmetics/WeaponSkins/" in rel and "_XP_" in name and "_XP_VFX_" not in name and rel.endswith(".uasset"):
                tags = diagnostic_tags(data)
                if tags:
                    found.append((rel, "camo skin with diagnostic tags %s" % ", ".join(sorted(tags))))
    return found


def entry_record(offset, raw, packed, blocks):
    # FPakEntry (v3, zlib): offset, compressed size, uncompressed size,
    # compression method, sha1 of stored bytes, block table, bEncrypted,
    # compression block size. Block offsets are absolute within the pak.
    rec = struct.pack("<qqqi", offset, len(packed), len(raw), 1)
    rec += hashlib.sha1(packed).digest()
    rec += struct.pack("<i", len(blocks))
    for start, end in blocks:
        rec += struct.pack("<qq", start, end)
    rec += struct.pack("<BI", 0, min(BLOCK_SIZE, len(raw)))
    return rec


def compress_blocks(raw):
    return [zlib.compress(raw[i:i + BLOCK_SIZE], 9) for i in range(0, max(len(raw), 1), BLOCK_SIZE)]


def main(src, out, allow_test_content=False):
    if not allow_test_content:
        found = test_content(src)
        if found:
            for rel, why in found[:40]:
                print("test content: %s (%s)" % (rel, why))
            sys.exit("refusing to pack %d test/diagnostic files (rebuild with make_camos.py, "
                     "without make_animated_camos.py / make_camo_tests.py)" % len(found))
    files = []
    for root, _, names in os.walk(src):
        for name in sorted(names):
            full = os.path.join(root, name)
            files.append((os.path.relpath(full, src).replace(os.sep, "/"), full))
    files.sort()

    body = bytearray()
    index = bytearray(fstring(MOUNT_POINT) + struct.pack("<i", len(files)))
    for rel, full in files:
        raw = open(full, "rb").read()
        chunks = compress_blocks(raw)
        packed = b"".join(chunks)
        offset = len(body)
        # The inline header has the same size as the index record, so the
        # data (and therefore every block) starts right after it.
        header_size = len(entry_record(0, raw, packed, [(0, 0)] * len(chunks)))
        blocks, pos = [], offset + header_size
        for c in chunks:
            blocks.append((pos, pos + len(c)))
            pos += len(c)
        body += entry_record(0, raw, packed, blocks)  # inline header carries offset 0
        body += packed
        index += fstring(rel) + entry_record(offset, raw, packed, blocks)

    footer = struct.pack("<IiQQ", PAK_MAGIC, PAK_VERSION, len(body), len(index))
    footer += hashlib.sha1(index).digest()
    with open(out, "wb") as f:
        f.write(body + index + footer)
    print("wrote %s (%d files)" % (out, len(files)))


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--allow-test-content"]
    main(args[0], args[1], allow_test_content="--allow-test-content" in sys.argv)
