"""Night cubemap for the menu's sky light (ambient light and reflections).

The sky light used the Jungle's day cubemap (03-29_Sunset): the sea reflected
a warm sunset and the scene was lit by it. This renders the night panorama
(make_night_sky.py) onto the six faces of a menu-only copy of that
TextureCube (/Game/Maps/FrontEnd/MenuNightCube, 256x256 FloatRGBA, 9 mips):
the night sky above, a dark sea below that mirrors it faintly. Its overall
energy matches the day cubemap's times NIGHT_ENERGY, so the sky light keeps
its intensity setting. build_menu_arenas.py points the sky light at it.

usage: python make_night_cube.py <Paks dir>
"""
import io
import os
import struct
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from patch_assets import find_in_paks  # noqa: E402
from ue_names import name_hashes  # noqa: E402
from ue_package import UPackage  # noqa: E402

SOURCE = "Victory/Content/Environment/Culling/Textures/03-29_Sunset.uasset"
SKY = os.path.join(HERE, "src", "Victory", "Content", "Maps", "FrontEnd", "MenuNightSky.uasset")
NAME = "MenuNightCube"
OUT = os.path.join(HERE, "src", "Victory", "Content", "Maps", "FrontEnd", NAME + ".uasset")
NIGHT_ENERGY = 0.6              # night sky's total light relative to the day cubemap's
SEA = np.array([0.004, 0.008, 0.018])
SEA_MIRROR = 0.25               # how much of the sky the sea reflects


def panorama():
    """The night sky panorama (4096x1024 mip of MenuNightSky), linear RGB."""
    blob = UPackage(open(SKY, "rb").read()).exports[0]["data"]
    i = blob.find(b"PF_DXT1")
    q = i + 8
    _, count = struct.unpack_from("<ii", blob, q)
    q += 8
    for _ in range(count):
        q += 4
        _, cnt, _, _ = struct.unpack_from("<Iiiq", blob, q)
        q += 20
        data = blob[q:q + cnt]
        q += cnt
        w, h = struct.unpack_from("<ii", blob, q)
        q += 8
        if w == 4096:
            break
    hdr = (b"DDS " + struct.pack("<IIIIIII", 124, 0x1 | 0x2 | 0x4 | 0x1000 | 0x80000, h, w, cnt, 0, 1) + b"\0" * 44
           + struct.pack("<II4sIIIII", 32, 4, b"DXT1", 0, 0, 0, 0, 0) + struct.pack("<IIIII", 0x1000, 0, 0, 0, 0))
    a = np.asarray(Image.open(io.BytesIO(hdr + data)).convert("RGB"), np.float32) / 255
    return np.where(a <= 0.04045, a / 12.92, ((a + 0.055) / 1.055) ** 2.4)


def face_directions(face, n):
    """World directions of a cube face's texels (D3D face layout; the
    sampler uses UE world axes, +Z up)."""
    c = (np.arange(n) + 0.5) / n * 2 - 1
    s, t = np.meshgrid(c, c)
    one = np.ones_like(s)
    d = [(one, -t, -s), (-one, -t, s), (s, one, t), (s, -one, -t), (s, -t, one), (-s, -t, -one)][face]
    d = np.stack(d, -1)
    return d / np.linalg.norm(d, axis=-1, keepdims=True)


def sample(pano, d):
    h, w, _ = pano.shape
    el = np.degrees(np.arcsin(np.clip(np.abs(d[..., 2]), 0, 1)))
    az = np.degrees(np.arctan2(d[..., 1], d[..., 0])) % 360
    px = (az / 360 * w).astype(int) % w
    py = np.clip(((1 - el / 90) * h).astype(int), 0, h - 1)
    sky = pano[py, px]
    below = d[..., 2:3] < 0
    return np.where(below, SEA + SEA_MIRROR * sky, sky)


def cube_mips(data):
    """[(size, offset of the mip's pixels in the export)] of the template."""
    up = UPackage(data)
    blob = up.exports[0]["data"]
    i = blob.find(b"PF_FloatRGBA")
    n = struct.unpack_from("<i", blob, i - 4)[0]
    q = i + n
    _, count = struct.unpack_from("<ii", blob, q)
    q += 8
    mips = []
    for _ in range(count):
        q += 4
        flags, cnt, _, _ = struct.unpack_from("<Iiiq", blob, q)
        assert not flags & 1, "streamed cube mips"
        q += 20
        mips.append((q, cnt))
        q += cnt
        w, h = struct.unpack_from("<ii", blob, q)
        assert w * h * 8 * 6 == cnt
        q += 8
    return up, mips


def main(paks_dir):
    data = find_in_paks(paks_dir, {SOURCE})[SOURCE]
    up, mips = cube_mips(data)
    blob = bytearray(up.exports[0]["data"])
    day = np.frombuffer(bytes(blob[mips[0][0]:mips[0][0] + mips[0][1]]), np.float16).astype(np.float32)
    day_energy = day.reshape(-1, 4)[:, :3].mean()

    pano = panorama()
    size = int(round((mips[0][1] / 48) ** 0.5))
    faces = [sample(pano, face_directions(f, size)) for f in range(6)]
    gain = NIGHT_ENERGY * day_energy / np.mean([f.mean() for f in faces])
    for k, (off, cnt) in enumerate(mips):
        n = size >> k
        out = []
        for f in faces:
            img = f.reshape(n, size // n, n, size // n, 3).mean((1, 3)) if n < size else f
            rgba = np.concatenate([img * gain, np.ones((n, n, 1))], -1)
            out.append(rgba.astype(np.float16).tobytes())
        px = b"".join(out)
        assert len(px) == cnt
        blob[off:off + cnt] = px
    up.exports[0]["data"] = bytes(blob)
    # New package path; the object keeps its name, so the sky level only
    # swaps its package import (as for the night panorama).
    for k, (s, _) in enumerate(up.names):
        if s.endswith("/03-29_Sunset"):
            s2 = "/Game/Maps/FrontEnd/" + NAME
            up.names[k] = (s2, struct.pack("<HH", *name_hashes(s2)))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    import cooked_texture
    open(OUT, "wb").write(cooked_texture.relocate(up.save()))     # the rename moved the export
    print("night cubemap: %s (gain %.2f, day energy %.3f)" % (OUT, gain, day_energy))


if __name__ == "__main__":
    main(sys.argv[1])
