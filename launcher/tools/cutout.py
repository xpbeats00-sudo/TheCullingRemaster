"""Cut the launcher art out of its black backgrounds.

- Logo: lifted off black ("unmultiply"): alpha = brightness, so the white and
  red keep full strength and the dark grunge cracks turn see-through.
- Mask: only the black connected to the image border is removed (region grown
  from the edges), so the mask's own black half stays opaque; the purple glow
  outside the outline fades to transparent instead of leaving a dark halo.

usage: python cutout.py <logo.png> <mask.png> <out dir>
"""
import os
import sys

import numpy as np
from PIL import Image, ImageFilter


def dilate(m):
    """One step of 8-neighbour dilation."""
    out = m.copy()
    out[1:] |= m[:-1]; out[:-1] |= m[1:]
    out[:, 1:] |= out[:, :-1].copy(); out[:, :-1] |= out[:, 1:].copy()
    return out


def grow_from_border(allowed):
    """Pixels of `allowed` connected to the image border."""
    seed = np.zeros_like(allowed)
    seed[0], seed[-1], seed[:, 0], seed[:, -1] = allowed[0], allowed[-1], allowed[:, 0], allowed[:, -1]
    while True:
        nxt = dilate(seed) & allowed
        if (nxt == seed).all():
            return seed
        seed = nxt


def unmultiply(rgb, gain=1.15):
    a = np.clip(rgb.max(axis=2) * gain, 0, 1)
    color = np.where(a[..., None] > 0, np.clip(rgb / np.maximum(a[..., None], 1e-6), 0, 1), 0)
    return color, a


def logo(path):
    rgb = np.asarray(Image.open(path).convert("RGB"), np.float32) / 255
    color, a = unmultiply(rgb)
    a[a < 0.04] = 0
    return color, a


def mask(path, dark=0.16):
    rgb = np.asarray(Image.open(path).convert("RGB"), np.float32) / 255
    bright = rgb.max(axis=2)
    # Background: dark pixels connected to the border.
    # The mask's own black half touches its outline where the purple rim is
    # thin, so the outline is closed first (bright pixels grown by `seal`),
    # the outside found from the border, then pulled back to the real edge.
    seal = 12
    closed = bright >= dark
    for _ in range(seal):
        closed = dilate(closed)
    outside = grow_from_border(~closed)
    for _ in range(seal):
        outside = dilate(outside)
    background = outside & (bright < dark)
    # The glow just outside the outline (inside the band the outline was
    # pulled back across): it fades out with its own brightness.
    inside = ~background
    glow = outside & ~background & (bright < 0.55)
    gc, ga = unmultiply(rgb, gain=1.6)
    color = rgb.copy()
    a = np.ones(bright.shape, np.float32)
    a[background] = 0
    # Glow pixels keep their light, fading out with brightness.
    color[glow] = gc[glow]
    a[glow] = ga[glow]
    # Soften the cut edge by a pixel.
    soft = np.asarray(Image.fromarray((a * 255).astype(np.uint8), "L").filter(ImageFilter.BoxBlur(1)), np.float32) / 255
    a = np.where(inside & ~glow, soft, a)
    return color, a


def save(color, a, path):
    out = np.dstack([color, a])
    Image.fromarray((out * 255 + 0.5).astype(np.uint8), "RGBA").save(path, optimize=True)
    ys, xs = np.nonzero(a > 0.02)
    Image.open(path).crop((xs.min(), ys.min(), xs.max() + 1, ys.max() + 1)).save(path, optimize=True)


def main(logo_path, mask_path, out_dir):
    os.makedirs(out_dir, exist_ok=True)
    save(*logo(logo_path), os.path.join(out_dir, "logo.png"))
    save(*mask(mask_path), os.path.join(out_dir, "mask.png"))
    print("wrote logo.png and mask.png to", out_dir)


if __name__ == "__main__":
    main(*sys.argv[1:])
