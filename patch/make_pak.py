"""Build a zlib-compressed UE4 (pak v3) patch pak from a directory tree.

usage: python make_pak.py <src_dir> <out.pak>

Every file under <src_dir> is stored at "../../../<relative path>", the same
layout the game's own paks use, so src/Victory/Content/... overrides the
matching file inside the base paks.
"""
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


def main(src, out):
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
    main(sys.argv[1], sys.argv[2])
