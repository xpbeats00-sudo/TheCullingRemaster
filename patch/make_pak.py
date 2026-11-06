"""Build a zlib-compressed UE4 (pak v3) patch pak from a directory tree.

usage: python make_pak.py <src_dir> <out.pak> [--allow-test-content]

Every file under <src_dir> is stored at "../../../<relative path>", the same
layout the game's own paks use, so src/Victory/Content/... overrides the
matching file inside the base paks.

Test and diagnostic content is refused before anything is written (unless
--allow-test-content, for a local diagnostics build only):
- the animated-camo experiment's assets (<Mesh>_XPAnim*, Camo_XP_Anim_*, made
  by diagnostics/make_animated_camos.py) and the Ice Axe test mesh
  (IceAxe_A_XPTest, diagnostics/make_camo_tests.py), by path;
- any file that mentions them or says "TEST BUILD" (ASCII or UTF-16);
- a custom camo skin (Cosmetics/WeaponSkins/*_XP_*.uasset) carrying a
  GeoSkin, BC or BC2 tag, except the VFX camos (*_XP_VFX_*,
  make_vfx_camos.py): those tags on a plain camo are make_camo_tests.py's Ice
  Axe diagnostics (Teal Current points at the stock FireAxe_C, so no name
  gives it away).
The released camos (make_camos.py's <Weapon>_XP_<Camo>, Necro Mist included,
and make_vfx_camos.py's <Weapon>_XP_VFX_*) are none of these. Rebuild with the
release generators (patch/build_release.py) to clear them. test_content()
lists what it finds.
"""
import hashlib
import os
import re
import struct
import sys
import zlib

PAK_MAGIC = 0x5A6F12E1
PAK_VERSION = 3
MOUNT_POINT = "../../../"

# A file whose path has one of these is test content ...
TEST_NAMES = re.compile(r"XPAnim|XPTest|Camo_XP_Anim_", re.I)
# ... and so is a file that mentions one (a skin pointing at an XPAnim mesh,
# say), as ASCII or UTF-16. "_XPAnim" (not "XPAnim"): the stock EndOfMatch.js
# logs "XPAnimate".
TEST_TEXT = [b"_XPAnim", b"_XPTest", b"Camo_XP_Anim_", b"TEST BUILD"]
TEST_TEXT += [t.decode("ascii").encode("utf-16le") for t in TEST_TEXT]
# ... and so is a plain custom camo skin with one of these tags (not a VFX camo).
DIAGNOSTIC_TAGS = {"GeoSkin", "BC", "BC2"}


def diagnostic_tags(data):
    """The GeoSkin/BC/BC2 tags stored in a weapon skin package (empty if it doesn't parse)."""
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
                found.append((rel, "test asset"))
                continue
            with open(full, "rb") as f:
                data = f.read()
            hit = next((t for t in TEST_TEXT if t in data), None)
            if hit:
                found.append((rel, "mentions %r" % hit.replace(b"\0", b"").decode("ascii")))
            elif ("/Cosmetics/WeaponSkins/" in rel and "_XP_" in name and "_XP_VFX_" not in name
                  and rel.endswith(".uasset")):
                tags = diagnostic_tags(data)
                if tags:
                    found.append((rel, "camo skin with diagnostic tags %s" % ", ".join(sorted(tags))))
    return sorted(found)


def fstring(s):
    b = s.encode("ascii") + b"\0"
    return struct.pack("<i", len(b)) + b


BLOCK_SIZE = 0x10000


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


class TestContentError(Exception):
    pass


def main(src, out, allow_test_content=False):
    if not allow_test_content:
        found = test_content(src)
        if found:
            raise TestContentError("refusing to pack %d test/diagnostic file(s) from %s:\n%s\n(delete them, or rebuild "
                                   "with the release generators: patch/build_release.py)"
                                   % (len(found), src, "\n".join("  %s (%s)" % f for f in found[:30])
                                      + ("\n  ..." if len(found) > 30 else "")))
    files = []
    for root, _, names in os.walk(src):
        for name in sorted(names):
            full = os.path.join(root, name)
            files.append((os.path.relpath(full, src).replace(os.sep, "/"), full))
    files.sort()
    # Names are stored as ASCII (fstring); a name that isn't would stop the
    # pack half way with a UnicodeEncodeError naming nothing. Refused up front,
    # naming the files, before anything is written.
    odd = [rel for rel, _ in files if any(ord(ch) > 126 or ord(ch) < 32 for ch in rel)]
    if odd:
        raise TestContentError("refusing to pack %d file(s) whose name isn't plain ASCII (the pak stores ASCII names):\n%s"
                               % (len(odd), "\n".join("  " + ascii(rel) for rel in odd[:30])))

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
    # A new file swapped in whole: an existing pak (or a hard link of one) is never written through.
    tmp = out + ".new"
    with open(tmp, "wb") as f:
        f.write(body + index + footer)
    os.replace(tmp, out)
    print("wrote %s (%d files)" % (out, len(files)))


if __name__ == "__main__":
    args = [a for a in sys.argv[1:] if a != "--allow-test-content"]
    if len(args) != 2:
        sys.exit("usage: python make_pak.py <src_dir> <out.pak> [--allow-test-content]")
    try:
        main(args[0], args[1], "--allow-test-content" in sys.argv)
    except TestContentError as e:
        sys.exit("make_pak: %s" % e)
