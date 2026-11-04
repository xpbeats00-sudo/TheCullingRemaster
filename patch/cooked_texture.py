"""Rewrite a cooked UE 4.15 Texture2D package with new pixels (DXT1 + mips).

Cooked platform data inside the texture export:
  pixel format FName | skip offset (absolute file position of the closing
  None FName) | SizeX SizeY NumSlices | pixel format FString | FirstMip NumMips
  | per mip: bCooked, bulk header (flags, count, size, absolute offset), data
  (inline mips only), SizeX, SizeY | None FName (+ the rest of the export)

rebuild() finds that block in any single-texture package, replaces the mips
(all written inline, streaming turned off), renames the package/object if
asked, and lays out the absolute offsets.
"""
import struct
import sys

import numpy as np
from PIL import Image

from ue_names import name_hashes
from ue_package import UPackage

BULK_INLINE = 0x48          # ForceInlinePayload | SingleUse, as the game's own mips
BULK_AT_END_OF_FILE = 0x1   # PayloadAtEndOfFile: streamed mips, stored past the exports
PACKAGE_TAG = bytes([0xC1, 0x83, 0x2A, 0x9E])


def bc1_encode(rgb, rows_per_chunk=256):
    """DXT1/BC1-compress an (H, W, 3) uint8 image (H, W multiples of 4).
    Endpoints span each block's per-channel range (inset 1/16), which keeps
    smooth gradients clean; 4-color mode throughout."""
    h, w, _ = rgb.shape
    out = []
    for r0 in range(0, h, rows_per_chunk):
        a = rgb[r0:r0 + rows_per_chunk].astype(np.float32)
        bh = a.shape[0] // 4
        blocks = a.reshape(bh, 4, w // 4, 4, 3).transpose(0, 2, 1, 3, 4).reshape(-1, 16, 3)
        lo, hi = blocks.min(1), blocks.max(1)
        inset = (hi - lo) / 16.0
        hi, lo = hi - inset, lo + inset

        def to565(c):
            c = np.clip(np.rint(c), 0, 255).astype(np.uint32)
            return ((c[:, 0] >> 3) << 11) | ((c[:, 1] >> 2) << 5) | (c[:, 2] >> 3)

        def from565(v):
            return np.stack([((v >> 11) & 31) * 255 // 31, ((v >> 5) & 63) * 255 // 63, (v & 31) * 255 // 31], -1).astype(np.float32)

        c0, c1 = to565(hi), to565(lo)
        swap = c0 < c1
        c0, c1 = np.where(swap, c1, c0), np.where(swap, c0, c1)
        p0, p1 = from565(c0), from565(c1)
        palette = np.stack([p0, p1, (2 * p0 + p1) / 3, (p0 + 2 * p1) / 3], 1)
        d = ((blocks[:, :, None, :] - palette[:, None, :, :]) ** 2).sum(-1)
        idx = d.argmin(2).astype(np.uint32)
        idx = np.where((c0 == c1)[:, None], 0, idx)
        bits = (idx << (2 * np.arange(16, dtype=np.uint32))).sum(1).astype(np.uint32)
        words = np.empty((len(blocks), 2), np.uint32)
        words[:, 0] = c0 | (c1 << 16)
        words[:, 1] = bits
        out.append(words.astype("<u4").tobytes())
    return b"".join(out)


def mip_chain(rgb, min_width=None):
    """[(width, height, BC1 bytes)] from full size down to min_width (or just
    the top mip when min_width is None)."""
    mips = []
    img = Image.fromarray(rgb)
    while True:
        a = np.asarray(img)
        mips.append((a.shape[1], a.shape[0], bc1_encode(a)))
        if min_width is None or a.shape[1] <= min_width:
            return mips
        img = img.resize((a.shape[1] // 2, a.shape[0] // 2), Image.BOX)


def locate(blob):
    """Offsets (relative to the export data) of the platform data block:
    (format FName, SizeX, end of the mips = closing None FName)."""
    i = 0
    while True:
        i = blob.find(b"PF_", i + 1)
        if i < 0:
            raise ValueError("no pixel format string in the texture export")
        n = struct.unpack_from("<i", blob, i - 4)[0]
        if 4 <= n <= 32 and blob[i + n - 1] == 0:
            w, h, slices = struct.unpack_from("<iii", blob, i - 16)
            if 0 < w <= 16384 and 0 < h <= 16384 and slices in (1, 6):     # 6: cube maps
                break
    size_at = i - 16
    q = i + n
    first, count = struct.unpack_from("<ii", blob, q)
    q += 8
    for _ in range(count):
        q += 4                                                  # bCooked
        flags, cnt, sz = struct.unpack_from("<Iii", blob, q)
        inline = not flags & BULK_AT_END_OF_FILE
        q += 20 + (cnt if inline else 0) + 8                    # header, data, SizeX/SizeY
    return size_at - 12, size_at, q


def _has_tag(up, data, name):
    """True if the export's tagged properties include `name`."""
    p = 0
    while p + 24 <= len(data):
        tag = up.names[struct.unpack_from("<i", data, p)[0]][0]
        if tag == "None":
            return False
        if tag == name:
            return True
        ptype = up.names[struct.unpack_from("<i", data, p + 8)[0]][0]
        size = struct.unpack_from("<i", data, p + 16)[0]
        q = p + 24
        if ptype == "StructProperty":
            q += 8 + 16
        elif ptype == "BoolProperty":
            q += 1
        elif ptype in ("ByteProperty", "EnumProperty", "ArrayProperty"):
            q += 8
        q += 1 + (16 if data[q] else 0)
        p = q + size
    return False


def rebuild(data, mips, rename=None, fmt="PF_DXT1"):
    """The texture package `data` with `mips` [(w, h, bytes)] in `fmt`.
    rename: (old object name, new object name) - also renames the package path
    names ending in /<old>."""
    up = UPackage(bytes(data))
    assert len(up.exports) == 1
    if rename:
        old, new = rename
        for k, (s, _) in enumerate(up.names):
            if s == old or s.endswith("/" + old):
                s2 = s[: len(s) - len(old)] + new
                up.names[k] = (s2, struct.pack("<HH", *name_hashes(s2)))
    e = up.exports[0]
    src = e["data"]
    name_at, size_at, end = locate(src)
    prefix, tail = src[:name_at], src[end:]
    # Every mip is written inline: drop streamed payloads stored past the
    # exports (keeping the package tag) and keep the texture from streaming.
    if up.tail.endswith(PACKAGE_TAG):
        up.tail = PACKAGE_TAG
    if not _has_tag(up, prefix, "NeverStream"):
        prefix = (up.fname("NeverStream") + up.fname("BoolProperty") + struct.pack("<ii", 0, 0)
                  + b"\x01\x00" + prefix)
    fmt_name = up.fname(fmt)
    fmt_str = fmt.encode() + b"\0"

    def blob(base):
        out = bytearray(prefix) + fmt_name
        skip_at = len(out)
        out += struct.pack("<i", 0)
        out += struct.pack("<iii", mips[0][0], mips[0][1], 1)
        out += struct.pack("<i", len(fmt_str)) + fmt_str
        out += struct.pack("<ii", 0, len(mips))
        for w, h, px in mips:
            out += struct.pack("<iIii", 1, BULK_INLINE, len(px), len(px))
            out += struct.pack("<q", base + len(out) + 8)
            out += px + struct.pack("<ii", w, h)
        struct.pack_into("<i", out, skip_at, base + len(out))
        return bytes(out + tail)

    # The export's file offset depends on the header (names may have grown),
    # so save once to find it, then lay out the absolute offsets against it.
    e["data"] = blob(0)
    base = UPackage(up.save()).exports[0]["fields"][8]
    e["data"] = blob(base)
    out = up.save()
    assert UPackage(out).exports[0]["fields"][8] == base
    return out


def bc3_encode(rgba):
    """DXT5/BC3: an 8-level alpha block (endpoints = block min/max) plus the
    BC1 color block, for an (H, W, 4) uint8 image."""
    h, w, _ = rgba.shape
    a = rgba[..., 3].astype(np.float32)
    blocks = a.reshape(h // 4, 4, w // 4, 4).transpose(0, 2, 1, 3).reshape(-1, 16)
    a0, a1 = blocks.max(1), blocks.min(1)
    same = a0 == a1
    a1 = np.where(same, np.maximum(a0 - 1, 0), a1)
    a0 = np.where(same & (a0 == 0), 1, a0)
    levels = np.stack([a0, a1] + [((7 - k) * a0 + k * a1) / 7 for k in range(1, 7)], 1)
    idx = np.abs(blocks[:, :, None] - levels[:, None, :]).argmin(2).astype(np.uint64)
    bits = (idx << (3 * np.arange(16, dtype=np.uint64))).sum(1)
    alpha = np.zeros((len(blocks), 8), np.uint8)
    alpha[:, 0], alpha[:, 1] = a0.astype(np.uint8), a1.astype(np.uint8)
    for k in range(6):
        alpha[:, 2 + k] = ((bits >> np.uint64(8 * k)) & np.uint64(0xFF)).astype(np.uint8)
    color = np.frombuffer(bc1_encode(rgba[..., :3]), np.uint8).reshape(-1, 8)
    return np.concatenate([alpha, color], 1).tobytes()


def mip_chain_rgba(rgba, min_width=4):
    """[(width, height, BC3 bytes)] from full size down to min_width."""
    mips = []
    img = Image.fromarray(rgba, "RGBA")
    while True:
        a = np.asarray(img)
        mips.append((a.shape[1], a.shape[0], bc3_encode(a)))
        if a.shape[1] <= min_width or a.shape[0] <= 4:
            return mips
        img = img.resize((a.shape[1] // 2, a.shape[0] // 2), Image.BOX)


def decode_top(data):
    """The largest mip stored in a cooked texture package (inline or
    streamed past the exports), as an RGBA PIL image."""
    import io
    up = UPackage(bytes(data))
    blob = up.exports[0]["data"]
    name_at, size_at, end = locate(blob)
    n = struct.unpack_from("<i", blob, size_at + 12)[0]
    fmt = blob[size_at + 16:size_at + 16 + n - 1].decode()
    q = size_at + 16 + n
    _, count = struct.unpack_from("<ii", blob, q)
    q += 8
    tail_at = len(data) - len(up.tail)
    for _ in range(count):
        q += 4
        flags, cnt, size, off = struct.unpack_from("<Iiiq", blob, q)
        q += 20
        if flags & BULK_AT_END_OF_FILE:
            px = data[tail_at + off:tail_at + off + size]
        else:
            px = blob[q:q + cnt]
            q += cnt
        w, h = struct.unpack_from("<ii", blob, q)
        q += 8
        if len(px) == size and size > 0:
            break
    if fmt == "PF_B8G8R8A8":
        return Image.frombytes("RGBA", (w, h), px, "raw", "BGRA")
    four = {"PF_DXT1": b"DXT1", "PF_DXT3": b"DXT3", "PF_DXT5": b"DXT5"}[fmt]
    hdr = (b"DDS " + struct.pack("<IIIIIII", 124, 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000, h, w, len(px), 0, 1) + b"\0" * 44
           + struct.pack("<II4sIIIII", 32, 4, four, 0, 0, 0, 0, 0) + struct.pack("<IIIII", 0x1000, 0, 0, 0, 0))
    return Image.open(io.BytesIO(hdr + px)).convert("RGBA")


def relocate(data):
    """Recompute a texture's absolute offsets (inline mip payloads and the
    platform data's skip offset) for where its export sits now - needed
    after anything that resizes the package header, such as renaming."""
    up = UPackage(bytes(data))
    e = up.exports[0]
    blob = bytearray(e["data"])
    base = e["fields"][8]
    name_at, size_at, end = locate(bytes(blob))
    n = struct.unpack_from("<i", blob, size_at + 12)[0]
    q = size_at + 16 + n
    _, count = struct.unpack_from("<ii", blob, q)
    q += 8
    for _ in range(count):
        q += 4
        flags, cnt, size, off = struct.unpack_from("<Iiiq", blob, q)
        if not flags & BULK_AT_END_OF_FILE:
            struct.pack_into("<q", blob, q + 12, base + q + 20)
        q += 20 + (0 if flags & BULK_AT_END_OF_FILE else cnt) + 8
    struct.pack_into("<i", blob, name_at + 8, base + q)
    e["data"] = bytes(blob)
    out = up.save()
    assert UPackage(out).exports[0]["fields"][8] == base
    return out


if __name__ == "__main__":
    sys.exit("library module")
