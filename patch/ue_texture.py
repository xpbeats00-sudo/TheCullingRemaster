"""Read/replace the single inline mip of a cooked 1920x1080 DXT1/DXT5 Texture2D
(The Culling's loading screens) in place, keeping the file size identical."""
import struct

import numpy as np
from PIL import Image

W, H = 1920, 1080
SIZES = {"DXT1": W * H // 2, "DXT5": W * H}


def locate(data):
    """Return (pixel format, offset of the mip bytes)."""
    for fmt, size in SIZES.items():
        needle = struct.pack("<ii", size, size)
        i = data.find(needle)
        if i >= 0 and fmt.encode() in data:
            # bulk header: flags(4) count(4) size on disk(4) offset(8)
            return fmt, i + 8 + 8
    raise ValueError("no 1920x1080 DXT mip found")


def decode(data):
    fmt, off = locate(data)
    raw = data[off:off + SIZES[fmt]]
    header = dds_header(fmt)
    from io import BytesIO
    return Image.open(BytesIO(header + raw)).convert("RGB")


def dds_header(fmt):
    flags = 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000
    pitch = SIZES[fmt]
    pf = struct.pack("<II4sIIIII", 32, 0x4, fmt.encode(), 0, 0, 0, 0, 0)
    return (b"DDS " + struct.pack("<IIIIIII", 124, flags, H, W, pitch, 0, 1) + b"\0" * 44
            + pf + struct.pack("<IIIII", 0x1000, 0, 0, 0, 0))


def _565(c):
    c = np.clip(c, 0, 255).astype(np.uint32)
    return ((c[..., 0] >> 3) << 11) | ((c[..., 1] >> 2) << 5) | (c[..., 2] >> 3)


def _from565(v):
    r = ((v >> 11) & 31) * 255 // 31
    g = ((v >> 5) & 63) * 255 // 63
    b = (v & 31) * 255 // 31
    return np.stack([r, g, b], -1).astype(np.float32)


def encode_bc1(img):
    """Simple BC1: endpoints = block min/max along the luminance axis."""
    a = np.asarray(img.convert("RGB").resize((W, H), Image.LANCZOS), dtype=np.float32)
    blocks = a.reshape(H // 4, 4, W // 4, 4, 3).transpose(0, 2, 1, 3, 4).reshape(-1, 16, 3)
    lum = blocks @ np.array([0.299, 0.587, 0.114], dtype=np.float32)
    hi = blocks[np.arange(len(blocks)), lum.argmax(1)]
    lo = blocks[np.arange(len(blocks)), lum.argmin(1)]
    c0, c1 = _565(hi), _565(lo)
    swap = c0 < c1
    c0, c1 = np.where(swap, c1, c0), np.where(swap, c0, c1)
    p0, p1 = _from565(c0), _from565(c1)
    palette = np.stack([p0, p1, (2 * p0 + p1) / 3, (p0 + 2 * p1) / 3], 1)        # 4-color mode
    d = ((blocks[:, :, None, :] - palette[:, None, :, :]) ** 2).sum(-1)
    idx = d.argmin(2).astype(np.uint32)
    idx = np.where((c0 == c1)[:, None], 0, idx)
    bits = (idx << (2 * np.arange(16, dtype=np.uint32))).sum(1).astype(np.uint32)
    out = np.zeros((len(blocks), 2), dtype=np.uint32)
    out[:, 0] = c0 | (c1 << 16)
    out[:, 1] = bits
    return out.astype("<u4").tobytes()


def encode_bc3(img):
    """BC3 with opaque alpha (all 255) + BC1-style color block."""
    color = np.frombuffer(encode_bc1(img), dtype="<u4").reshape(-1, 2)
    alpha = np.zeros((len(color), 2), dtype="<u4")
    alpha[:, 0] = 0xFFFF            # alpha0 = alpha1 = 255, indices 0
    return np.concatenate([alpha, color], 1).astype("<u4").tobytes()


def replace(data, img):
    fmt, off = locate(data)
    blob = encode_bc1(img) if fmt == "DXT1" else encode_bc3(img)
    assert len(blob) == SIZES[fmt]
    return data[:off] + blob + data[off + len(blob):]
