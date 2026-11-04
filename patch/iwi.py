"""Decode Call of Duty .iwi textures (IW4 v8 / BO2 v27) to PIL images.

Header: 'IWi', version, then format and width/height (u16) - right after the
version byte in BO2 (v27), after a 4-byte flags field in IW4 (v8); pixel data runs smallest mip to largest, so the full-size
image is the last width*height*bpp bytes of the file."""
import io
import struct

from PIL import Image

FORMATS = {0x01: ("RGBA", 4), 0x02: ("RGB", 3), 0x0B: ("DXT1", 0.5), 0x0C: ("DXT3", 1), 0x0D: ("DXT5", 1)}


def _dds(fourcc, w, h, data):
    hdr = (b"DDS " + struct.pack("<IIIIIII", 124, 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000, h, w, len(data), 0, 1)
           + b"\0" * 44 + struct.pack("<II4sIIIII", 32, 4, fourcc.encode(), 0, 0, 0, 0, 0)
           + struct.pack("<IIIII", 0x1000, 0, 0, 0, 0))
    return Image.open(io.BytesIO(hdr + data))


def decode(data):
    assert data[:3] == b"IWi", "not an IWI file"
    version = data[3]
    if version == 8:                         # IW4: flags (int32), format, usage, width, height
        fmt = data[8]
        w, h = struct.unpack_from("<HH", data, 10)
    else:                                    # BO2 (27): format, usage, width, height
        fmt = data[4]
        w, h = struct.unpack_from("<HH", data, 6)
    kind, bpp = FORMATS[fmt]
    size = int(w * h * bpp)
    pixels = data[-size:]
    if kind.startswith("DXT"):
        return _dds(kind, w, h, pixels).convert("RGBA")
    if kind == "RGBA":
        return Image.frombytes("RGBA", (w, h), pixels, "raw", "BGRA")
    return Image.frombytes("RGB", (w, h), pixels, "raw", "BGR").convert("RGBA")
