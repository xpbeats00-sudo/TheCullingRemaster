"""Paint the menu's night sky: a dark navy dome, a purple/blue nebula band,
dense stars, deep-sky objects, constellations and a thin haze on the horizon
(the sky material's own animated clouds drift above it).

The sky dome samples a BGRA panorama of the upper hemisphere (x = 360 degrees
of azimuth, top row = zenith, bottom row = horizon). The Jungle's 4096x1024
day panorama (/Game/Environment/Sky/03-29_Sunset) is copied to a menu-only
package at 16384x4096 (~45 texels per degree, at or above the menu cameras'
screen density, so the sky stays sharp), so the in-match sky is untouched.

Where a panorama column ends up in the world isn't known exactly, so nothing
here depends on azimuth: the nebula is a band that waves up and down twice
around the whole sky (every menu view sees it crossing diagonally) and the
clouds ring the horizon. The moon is the sky material's own disc, aimed at an
exact world direction by build_menu_arenas.py.

usage: python make_night_sky.py <Paks dir>
"""
import os
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = "Victory/Content/Environment/Sky/03-29_Sunset.uasset"
OUT = os.path.join(HERE, "src", "Victory", "Content", "Maps", "FrontEnd", "MenuNightSky.uasset")
PREVIEW = os.path.join(HERE, "branding", "night_sky_preview.png")
W, H = 16384, 4096      # ~45 texels/degree: at or above the menu cameras' screen density
SEED = 1983


# ---- geometry
def directions(w, h):
    u = (np.arange(w) + 0.5) / w
    v = (np.arange(h) + 0.5) / h
    phi = 2 * np.pi * u[None, :]
    el = np.radians(90.0 * (1.0 - v))[:, None]
    d = np.stack(np.broadcast_arrays(np.cos(el) * np.cos(phi), np.cos(el) * np.sin(phi), np.sin(el)), -1)
    return d.astype(np.float32), np.degrees(np.broadcast_to(el, (h, w))), np.degrees(np.broadcast_to(phi, (h, w)))


# ---- 3D value noise (seamless on the sphere)
def _hash(ix, iy, iz, seed):
    h = (ix * 73856093) ^ (iy * 19349663) ^ (iz * 83492791) ^ (seed * 2654435761)
    h = h.astype(np.uint32)
    h ^= h >> np.uint32(13)
    h *= np.uint32(1274126177)
    h ^= h >> np.uint32(16)
    return (h & np.uint32(0xFFFFFF)).astype(np.float32) / float(0xFFFFFF)


def vnoise(p, seed):
    i = np.floor(p).astype(np.int64)
    f = p - i
    f = f * f * (3 - 2 * f)
    out = 0
    for dx in (0, 1):
        for dy in (0, 1):
            for dz in (0, 1):
                w = ((f[..., 0] if dx else 1 - f[..., 0]) * (f[..., 1] if dy else 1 - f[..., 1])
                     * (f[..., 2] if dz else 1 - f[..., 2]))
                out = out + w * _hash(i[..., 0] + dx, i[..., 1] + dy, i[..., 2] + dz, seed)
    return out


def fbm(p, seed, octaves=6, lacunarity=2.03, gain=0.5):
    total, amp, norm = 0, 1.0, 0
    for o in range(octaves):
        total = total + amp * vnoise(p * (lacunarity ** o), seed + 17 * o)
        norm += amp
        amp *= gain
    return total / norm


def smoothstep(a, b, x):
    t = np.clip((x - a) / (b - a), 0, 1)
    return t * t * (3 - 2 * t)


# ---- layers
def sky_base(el):
    t = np.clip(el / 90.0, 0, 1)[..., None] ** 0.55
    zenith = np.array([0.012, 0.016, 0.048])
    horizon = np.array([0.060, 0.075, 0.150])
    return horizon * (1 - t) + zenith * t


def band_distance(el, phi):
    """Angular distance (degrees, along elevation) from the nebula's center
    line, which waves between ~9 and ~29 degrees up, twice around the sky."""
    center = 19.0 + 10.0 * np.sin(np.radians(2 * phi + 40.0))
    return el - center


def nebula(d, el, phi):
    dist = band_distance(el, phi)
    core = np.exp(-(dist / 9.0) ** 2)
    halo = np.exp(-(dist / 20.0) ** 2)
    gas = fbm(d * 3.2 + 11.0, SEED + 1)
    wisps = fbm(d * 11.0 - 4.0, SEED + 2, octaves=6)
    fine = fbm(d * 28.0 + 9.0, SEED + 7, octaves=4)
    density = smoothstep(0.36, 0.80, gas * 0.6 + wisps * 0.45 + fine * 0.15) * core + 0.20 * halo * gas
    dust = smoothstep(0.50, 0.70, fbm(d * 7.5 + 3.0, SEED + 3)) * core
    density = density * (1 - 0.8 * dust)
    hue = smoothstep(0.3, 0.7, fbm(d * 2.4 - 7.0, SEED + 4, octaves=4))[..., None]
    purple = np.array([0.42, 0.14, 0.78])
    blue = np.array([0.16, 0.22, 0.85])
    col = purple * hue + blue * (1 - hue)
    hot = (smoothstep(0.55, 1.0, density) * fine)[..., None]
    col = col * (1 - hot) + np.array([0.80, 0.55, 1.0]) * hot
    glow = (np.exp(-(dist / 4.0) ** 2) * gas * (1 - 0.8 * dust))[..., None] * np.array([0.30, 0.30, 0.55])
    return col * (density[..., None] * 0.55) + glow * 0.45, core


def clouds(d, el):
    # Flattened fbm (squashed vertically) for low banks, thickest at the
    # horizon and gone by ~30 degrees; thin parts catch silver moonlight.
    p = d * np.array([2.4, 2.4, 7.5], np.float32)
    n = fbm(p + 21.0, SEED + 5) * 0.75 + fbm(p * 3.1, SEED + 6, octaves=4) * 0.35
    # Only a thin haze bank on the horizon: the sky material's own clouds
    # drift across the sky above it, animated by the engine.
    cover = smoothstep(11.0, 1.5, el) * 0.8
    alpha = smoothstep(0.62 - 0.22 * cover, 0.86 - 0.22 * cover, n) * np.clip(cover * 1.3, 0, 1)
    thin = alpha * (1 - alpha) * 4
    lit = 0.55 + 0.45 * fbm(d * 1.5 + 2.0, SEED + 8, octaves=3)
    col = (np.array([0.050, 0.060, 0.115]) * lit[..., None]
           + np.array([0.45, 0.50, 0.66]) * (thin * lit)[..., None] * 0.5)
    return col, alpha


def stars(img, rng, band_core_full):
    h, w, _ = img.shape

    def field(count):
        z = rng.uniform(np.sin(np.radians(1.5)), 1.0, count)
        el = np.degrees(np.arcsin(z))
        return rng.uniform(0, w, count), (1 - el / 90.0) * h

    def in_band(count, power):
        x, y = rng.uniform(0, w, count), rng.uniform(0, h, count)
        keep = rng.uniform(0, 1, count) < band_core_full[y.astype(int), x.astype(int)] ** power
        return x[keep], y[keep]

    tints = np.array([[0.78, 0.86, 1.0], [1.0, 1.0, 1.0], [1.0, 0.88, 0.72], [0.85, 0.75, 1.0]])

    def tint(n):
        return tints[rng.choice(4, n, p=[0.45, 0.35, 0.12, 0.08])]

    # Dust: a dense field of tiny faint stars, thickest along the band.
    fx, fy = field(140000)
    bx, by = in_band(520000, 1.2)
    x, y = np.concatenate([fx, bx]), np.concatenate([fy, by])
    val = (0.06 + 0.32 * rng.uniform(0, 1, len(x)) ** 3)[:, None] * tint(len(x))
    x0, y0 = np.floor(x).astype(int), np.floor(y).astype(int)
    ax, ay = x - x0, y - y0
    for ox, oy, wgt in ((0, 0, (1 - ax) * (1 - ay)), (1, 0, ax * (1 - ay)), (0, 1, (1 - ax) * ay), (1, 1, ax * ay)):
        np.add.at(img, ((y0 + oy).clip(0, h - 1), (x0 + ox) % w), val * wgt[:, None])

    # Medium and bright stars: small gaussians (stretched toward the zenith
    # where the panorama squeezes azimuth); the brightest get a glow and a
    # faint four-point sparkle.
    mx, my = field(5200)
    bx, by = in_band(24000, 2.0)
    x, y = np.concatenate([mx, bx]), np.concatenate([my, by])
    mag = rng.uniform(0, 1, len(x)) ** 4
    top = np.argsort(mag)[-320:]
    mag[top] = 0.75 + 0.25 * rng.uniform(0, 1, len(top))
    cols = tint(len(x))
    for i in range(len(x)):
        e = (1 - y[i] / h) * 90.0
        stretch = 1.0 / max(np.cos(np.radians(e)), 0.08)
        sigma = 0.7 + 1.0 * mag[i]
        sparkle = mag[i] > 0.9
        r = int(np.ceil(sigma * 3 + (10 if sparkle else 3 if mag[i] > 0.7 else 0)))
        rx = min(int(r * stretch), 400)
        yy = np.arange(int(y[i]) - r, int(y[i]) + r + 1)
        xx = np.arange(int(x[i]) - rx, int(x[i]) + rx + 1)
        dy = (yy - y[i])[:, None]
        dx = ((xx - x[i]) / stretch)[None, :]
        rr = dx * dx + dy * dy
        g = np.exp(-rr / (2 * sigma * sigma)) * (0.35 + 1.4 * mag[i])
        if mag[i] > 0.7:
            g = g + 0.25 * mag[i] * np.exp(-rr / (2 * (sigma * 3.5) ** 2))
        if sparkle:
            g = g + 0.35 * (np.exp(-(dx / 0.6) ** 2 - (dy / 8.0) ** 2) + np.exp(-(dy / 0.6) ** 2 - (dx / 8.0) ** 2))
        ok = (yy >= 0) & (yy < h)
        img[np.ix_(yy[ok], xx % w)] += g[ok][..., None] * cols[i]


# ---- deep-sky objects and constellations
# The panorama's azimuth isn't known in world space, so six objects are spread
# 60 degrees apart, low enough (9-13 degrees) for the home camera's narrow view.
# (texture azimuth, elevation) in degrees.
DEEP_SKY = [("spiral_galaxy", 30.0, 12.0), ("black_hole", 90.0, 11.0), ("star_cluster", 150.0, 12.5),
            ("emission_nebula", 210.0, 10.0), ("edge_on_galaxy", 270.0, 12.0), ("remnant", 330.0, 9.5)]
OBJECT_RADIUS = 3.5                  # degrees: window each object is painted in (and clouds part)


def stamp_window(h, w, phi0, el0, radius):
    """Pixel rows/cols around (phi0, el0) and local tangent coords in degrees
    (x along azimuth, y up)."""
    px = w / 360.0
    rows = np.arange(max(0, int((90 - el0 - radius) * px)), min(h, int((90 - el0 + radius) * px) + 1))
    span = radius / max(np.cos(np.radians(el0)), 0.2)
    cols = np.arange(int((phi0 - span) * px), int((phi0 + span) * px) + 1)
    el = 90.0 - (rows + 0.5) / px
    phi = (cols + 0.5) / px
    x = ((phi[None, :] - phi0 + 180) % 360 - 180) * np.cos(np.radians(el[:, None]))
    y = np.broadcast_to((el - el0)[:, None], x.shape)
    return rows, cols % w, x, y


def rotate(x, y, deg):
    a = np.radians(deg)
    return x * np.cos(a) + y * np.sin(a), -x * np.sin(a) + y * np.cos(a)


def _noise2(x, y, scale, seed, octaves=4, z=0.0):
    return fbm(np.stack([x * scale, y * scale, np.zeros_like(x) + z], -1).astype(np.float32), seed, octaves=octaves)


def spiral_galaxy(x, y):
    u, v = rotate(x / 1.6, y / 1.6, 28.0)
    v = v / 0.42                                        # tilted disk
    r = np.hypot(u, v) + 1e-4
    th = np.arctan2(v, u)
    arms = (0.5 + 0.5 * np.cos(2 * (th - 2.4 * np.log(r / 0.25)))) ** 3
    disk = np.exp(-r / 0.9) * (0.25 + 0.9 * arms * _noise2(u, v, 3.0, SEED + 20))
    core = np.exp(-(r / 0.22) ** 2)
    dust = 1 - 0.6 * np.exp(-((v + 0.12) / 0.08) ** 2) * np.exp(-r / 1.2)
    col = disk[..., None] * np.array([0.45, 0.55, 1.0]) * 0.8 + core[..., None] * np.array([1.0, 0.85, 0.6]) * 1.1
    return col * dust[..., None], None


def black_hole(x, y):
    r = np.hypot(x, y)
    # Accretion disk: a tilted ring, Doppler-brighter on the approaching side.
    u, v = rotate(x, y, -12.0)
    vd = v / 0.22
    rd = np.hypot(u, vd)
    ring = np.exp(-((rd - 1.8) / 0.5) ** 2) * (rd > 0.95)
    doppler = 0.55 + 0.45 * np.tanh(-u / 1.2)
    swirl = fbm(np.stack([rd * 6, np.arctan2(vd, u) * 2, np.zeros_like(u)], -1).astype(np.float32), SEED + 21, octaves=3)
    disk = ring * doppler * (0.6 + 0.4 * swirl)
    # The disk's far side, lensed up over the shadow, and the photon ring.
    # (bright arc over the top, a dimmer one under the bottom)
    lensed = np.exp(-((r - 1.18) / 0.2) ** 2) * np.where(v > 0, 1.1, 0.35) * (0.5 + 0.5 * np.abs(v) / (r + 1e-4))
    photon = np.exp(-((r - 0.97) / 0.025) ** 2) * 0.8
    glow = np.exp(-(r / 2.6) ** 2) * 0.12
    col = (disk[..., None] * 1.6 * np.array([1.0, 0.62, 0.28]) + lensed[..., None] * np.array([1.0, 0.75, 0.45])
           + photon[..., None] * np.array([1.0, 0.9, 0.8]) + glow[..., None] * np.array([0.8, 0.45, 0.25]))
    front = (v < 0) & (rd > 0.95)
    shadow = np.clip((r - 0.9) / 0.06, 0, 1)            # the event horizon swallows what's behind it
    return col, np.where(front, 1.0, shadow)


def star_cluster(x, y):
    members = [(-0.9, 0.5), (-0.4, 0.8), (0.1, 0.4), (0.6, 0.9), (0.9, 0.2), (0.3, -0.3), (-0.3, -0.1), (-0.8, -0.5), (0.7, -0.7)]
    col = np.zeros(x.shape + (3,))
    for sx, sy in members:
        rr = (x - sx) ** 2 + (y - sy) ** 2
        col += np.exp(-rr / (2 * 0.035 ** 2))[..., None] * np.array([0.9, 0.95, 1.0]) * 2.0
        col += np.exp(-rr / (2 * 0.3 ** 2))[..., None] * np.array([0.25, 0.4, 0.9]) * 0.18
        spikes = np.exp(-((x - sx) / 0.02) ** 2 - ((y - sy) / 0.25) ** 2) + np.exp(-((y - sy) / 0.02) ** 2 - ((x - sx) / 0.25) ** 2)
        col += spikes[..., None] * 0.35
    haze = np.exp(-(np.hypot(x, y) / 1.4) ** 2) * _noise2(x, y, 2.0, SEED + 22, z=1.0)
    return col + haze[..., None] * np.array([0.2, 0.32, 0.8]) * 0.35, None


def emission_nebula(x, y):
    gas = _noise2(x, y, 1.6, SEED + 23, octaves=6, z=3.0)
    fil = _noise2(x, y, 4.8, SEED + 24, octaves=5, z=9.0)
    r = np.hypot(x / 1.3, y)
    body = smoothstep(0.42, 0.85, gas * 0.7 + fil * 0.4) * np.exp(-(r / 2.0) ** 2)
    core = np.exp(-(np.hypot(x - 0.2, y + 0.1) / 0.45) ** 2)
    dark = smoothstep(0.55, 0.75, _noise2(x, y, 3.2, SEED + 25, z=7.0)) * np.exp(-(r / 1.6) ** 2)
    col = body[..., None] * np.array([1.0, 0.28, 0.45]) * 0.75 + core[..., None] * np.array([1.0, 0.75, 0.85]) * 0.7
    col = col + (body * fil)[..., None] * np.array([0.35, 0.55, 1.0]) * 0.25
    return col * (1 - 0.7 * dark)[..., None], None


def edge_on_galaxy(x, y):
    u, v = rotate(x, y, -18.0)
    disk = np.exp(-(u / 2.0) ** 2 - (v / 0.16) ** 2)
    bulge = np.exp(-(u / 0.45) ** 2 - (v / 0.32) ** 2)
    lane = 1 - 0.75 * np.exp(-(v / 0.035) ** 2) * np.exp(-(u / 1.8) ** 2)
    col = disk[..., None] * np.array([0.55, 0.65, 1.0]) * 0.9 + bulge[..., None] * np.array([1.0, 0.85, 0.65])
    return col * lane[..., None], None


def remnant(x, y):
    r = np.hypot(x, y)
    th = np.arctan2(y, x)
    fil = fbm(np.stack([np.cos(th) * 4, np.sin(th) * 4, r * 3], -1).astype(np.float32), SEED + 26, octaves=5)
    shell = np.exp(-((r - 1.3) / (0.25 + 0.2 * fil)) ** 2) * smoothstep(0.35, 0.75, fil)
    inner = np.exp(-(r / 0.9) ** 2) * fil * 0.4
    pulsar = np.exp(-(r / 0.05) ** 2) * 2.5
    col = (shell[..., None] * np.array([1.0, 0.5, 0.25]) * 0.9 + inner[..., None] * np.array([0.3, 0.8, 0.9]) * 0.6
           + pulsar[..., None] * np.array([0.8, 0.9, 1.0]))
    return col, None


PAINTERS = {"spiral_galaxy": spiral_galaxy, "black_hole": black_hole, "star_cluster": star_cluster,
            "emission_nebula": emission_nebula, "edge_on_galaxy": edge_on_galaxy, "remnant": remnant}


def deep_sky(sky):
    """Paint the deep-sky objects; return a mask (1 near each object) used to
    part the clouds around them."""
    h, w, _ = sky.shape
    mask = np.zeros((h, w), np.float32)
    for kind, phi0, el0 in DEEP_SKY:
        rows, cols, x, y = stamp_window(h, w, phi0, el0, OBJECT_RADIUS)
        col, keep = PAINTERS[kind](x, y)
        region = sky[np.ix_(rows, cols)]
        if keep is not None:
            region = region * keep[..., None]
        sky[np.ix_(rows, cols)] = region + col
        m = smoothstep(OBJECT_RADIUS, 0.45 * OBJECT_RADIUS, np.hypot(x, y))   # 0 at the window edge
        mask[np.ix_(rows, cols)] = np.maximum(mask[np.ix_(rows, cols)], m)
    return mask


# Stick figures: star offsets in degrees from an anchor, the lines joining
# them, and the anchor's (texture azimuth, elevation).
CONSTELLATIONS = [
    ([(0, 0), (4, 1), (8, 0.5), (11, -1), (13, 3), (17, 4), (16, 0)],
     [(0, 1), (1, 2), (2, 3), (3, 6), (6, 5), (5, 4), (4, 3)], 5.0, 16.0),           # dipper
    ([(0, 0), (3, 4), (6, 1), (9, 5), (12, 2)], [(0, 1), (1, 2), (2, 3), (3, 4)], 65.0, 20.0),  # W
    ([(0, 0), (0, 6), (0, 12), (-5, 6), (5, 6)], [(0, 1), (1, 2), (3, 1), (1, 4)], 125.0, 14.0),  # cross
    ([(0, 0), (5, 0.5), (2.5, 4), (2.6, 7), (2.4, 10), (-1, 13), (6, 13)],
     [(0, 2), (1, 2), (2, 3), (3, 4), (4, 5), (4, 6)], 185.0, 12.0),                 # hunter
    ([(0, 0), (3, 2), (6, 3), (9, 2), (12, 5), (14, 9), (11, 11)],
     [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 6)], 245.0, 15.0),                 # scorpion
    ([(0, 0), (4, 3), (8, 3), (10, 6), (7, 9), (3, 8)],
     [(0, 1), (1, 2), (2, 3), (3, 4), (4, 5), (5, 1)], 305.0, 18.0),                 # lion
]


def constellations(sky):
    h, w, _ = sky.shape
    px = w / 360.0

    def glow(cx, cy, sigma, amp, color):
        r = int(sigma * 6) + 2
        ys = np.arange(int(cy) - r, int(cy) + r + 1)
        ys = ys[(ys >= 0) & (ys < h)]
        xs = np.arange(int(cx) - r, int(cx) + r + 1)
        g = np.exp(-((xs[None, :] - cx) ** 2 + (ys[:, None] - cy) ** 2) / (2 * sigma ** 2))
        sky[np.ix_(ys, xs % w)] += g[..., None] * amp * np.asarray(color)

    for offsets, lines, phi0, el0 in CONSTELLATIONS:
        stars = [(phi0 + dx / max(np.cos(np.radians(el0 + dy)), 0.2), el0 + dy) for dx, dy in offsets]
        for a, b in lines:
            (p1, e1), (p2, e2) = stars[a], stars[b]
            n = int(np.hypot((p2 - p1) * np.cos(np.radians((e1 + e2) / 2)), e2 - e1) * px * 1.5) + 2
            for t in np.linspace(0.08, 0.92, n):
                xi = int(((p1 + (p2 - p1) * t) % 360) * px) % w
                yi = int((90 - (e1 + (e2 - e1) * t)) * px)
                if 0 <= yi < h - 1:
                    sky[yi:yi + 2, xi:xi + 2] += np.array([0.10, 0.16, 0.30]) * 0.55
        for p, e in stars:
            x, y = (p % 360) * px, (90 - e) * px
            glow(x, y, 1.6, 2.2, (0.95, 0.97, 1.0))
            glow(x, y, 6.0, 0.10, (0.5, 0.65, 1.0))


# ---- assemble
def paint():
    rng = np.random.default_rng(SEED)
    # Smooth layers at half resolution, then upsampled.
    hw, hh = W // 2, H // 2
    d, el, phi = directions(hw, hh)
    neb, core = nebula(d, el, phi)
    cloud_col, cloud_a = clouds(d, el)

    def up(a):
        a = np.asarray(a, np.float32)
        if a.ndim == 2:
            return np.asarray(Image.fromarray(a, "F").resize((W, H), Image.BICUBIC))
        return np.stack([up(a[..., c]) for c in range(a.shape[-1])], -1)

    sky = up(sky_base(el) + neb)
    alpha = np.clip(up(cloud_a), 0, 1)[..., None]
    star_layer = np.zeros_like(sky)
    stars(star_layer, rng, up(core))
    sky = sky + star_layer
    constellations(sky)
    alpha = alpha * (1 - deep_sky(sky)[..., None])    # clouds part around the objects
    sky = sky * (1 - alpha) + up(cloud_col) * alpha
    return np.clip(sky, 0, 1)


def camera_preview(rgb, path, yaw=0.0, pitch=3.0, hfov=90.0, size=(1280, 720)):
    """Roughly what a menu camera sees (any yaw: the sky has no front)."""
    w, h = size
    f = (w / 2) / np.tan(np.radians(hfov / 2))
    xs, ys = np.meshgrid(np.arange(w) - w / 2 + 0.5, h / 2 - np.arange(h) - 0.5)
    yw, pt = np.radians(yaw), np.radians(pitch)
    fwd = np.array([np.cos(pt) * np.cos(yw), np.cos(pt) * np.sin(yw), np.sin(pt)])
    right = np.array([-np.sin(yw), np.cos(yw), 0.0])
    up = np.cross(fwd, right)
    d = fwd * f + xs[..., None] * right + ys[..., None] * up
    d /= np.linalg.norm(d, axis=-1, keepdims=True)
    el = np.degrees(np.arcsin(np.clip(d[..., 2], -1, 1)))
    phi = np.degrees(np.arctan2(d[..., 1], d[..., 0])) % 360
    img = rgb[np.clip(((1 - el / 90) * H).astype(int), 0, H - 1), (phi / 360 * W).astype(int) % W].astype(np.float32)
    img[el < 0] = (8, 10, 18)
    Image.fromarray(img.astype(np.uint8)).save(path)


MIN_MIP_WIDTH = 128


def main(paks_dir):
    sys.path.insert(0, HERE)
    import cooked_texture
    from patch_assets import find_in_paks
    source = find_in_paks(paks_dir, {SOURCE})[SOURCE]
    rgb = (paint() * 255 + 0.5).astype(np.uint8)
    data = cooked_texture.rebuild(source, cooked_texture.mip_chain(rgb, MIN_MIP_WIDTH))
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    open(OUT, "wb").write(data)
    Image.fromarray(rgb).resize((2048, 512), Image.LANCZOS).save(PREVIEW)
    for yaw in (0, 120, 240):
        camera_preview(rgb, PREVIEW.replace(".png", "_view%d.png" % yaw), yaw=yaw)
    print("night sky written:", OUT, "(%dx%d DXT1, %.1f MB)" % (W, H, len(data) / 1e6))


if __name__ == "__main__":
    main(sys.argv[1])
