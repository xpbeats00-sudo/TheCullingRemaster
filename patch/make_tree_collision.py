"""Tree collision: no perch inside a tree's crown (players got stuck in trees).

The bug (stock, every map): a player who runs or jumps into a tree can end up
inside it and can't get out. Prison has only two trees that block players,
American Elm (548) and European Linden (208), Jungle the same two (941 and
517) plus Kapok, Queen/Curly/Sago palm. What the cooked assets say:

- Every blocking tree is foliage (FoliageInstancedStaticMeshComponent, the
  maps' Landscape levels; BlockAll, so pawns are blocked), uniformly scaled,
  upright. Its collision is the mesh's BodySetup: capsules (SphylElems) only,
  CTF_UseSimpleAsComplex - no complex-only trunk, no missing collision. The
  pawn's movement is stock: ShooterCharacterMovement's constructor only sets
  its sprint/strafe/slide values, so MaxDepenetrationWithGeometry 500, with
  pawns 100, AirControl 0.05 are the engine's (UCharacterMovementComponent
  constructor, VA 0x14122c910); DefaultEngine.ini's physics are stock too
  (bEnablePCM, MaxDepenetrationVelocity 0 = unlimited). Nothing disables or
  weakens depenetration.
- But Elm's and Linden's capsules stop where the visible trunk forks: Elm is
  three trunks of radius 18 whose tops are 195 up (166-223 at Prison's
  scales 0.85-1.15, 174-341 on Jungle), Linden two stacked ones ending 214 up;
  above that the mesh is limbs and crown (Elm's vertices spread from radius
  ~40 below 200 to 250-370 at 200-350) with no collision. And these two (only
  these) mark their collision WalkableSlope_Unwalkable.
- A player's capsule (radius 50, half height 86, jump apex +128) rides up
  over such a low cap top (its lower half meets the round cap above the
  cap's centre) and lands on it: inside the tree's fork and crown, standing
  on capsules the movement component won't stand on. Elm's three caps are a
  stable perch (resting on all three, normals ~20 deg from vertical, the
  centre inside their triangle at every scale): the movement component stays
  Falling there - no jump (JumpMaxCount 1: none from Falling), and the air
  control that could push it off is cut against each surface it pushes into
  (UCharacterMovementComponent::LimitAirControl) - so it stays inside the tree.

The fix: each of those trunk capsules goes on up, its bottom, radius and axis
kept, until its top is TOP (450) above the tree's base - inside the trunk
and the fork's crotch, where nobody can stand anyway, and far above any jump
(at the smallest instance scale, 0.81, the cap's centre is 350+ up). The
footprint is unchanged (the prebuilt navmesh and the bots' paths stay
right). Edited in place in the stock StaticMesh packages (two floats per
capsule: Center and Length; same size, no new names, imports or exports);
the HISM instance bodies are made from the mesh's BodySetup at load (the
maps' PhysicsSerializer objects are empty). The native module's safety net
(unstick.c) catches whatever else of the kind is left.

usage: python make_tree_collision.py <Paks dir> [--out DIR]
  output: patch/src (make_pak.py packs it)
"""
import argparse
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from make_bot_ai import walk  # noqa: E402
from stock_paks import paks_dir, read_stock  # noqa: E402
from uasset import Package  # noqa: E402

VEG = "Victory/Content/Environment/Culling/Vegetation/"
ELM = VEG + "American_Elm_Culling/American_Elm_Culling.uasset"
LINDEN = VEG + "European_Linden_REV/EuropeanLinden_Desktop.uasset"
TOP = 450.0                         # a lengthened capsule's top, mesh units above the tree's base

# The stock capsules (centre, orientation quaternion x y z w, radius, length);
# the generator stops on anything else. lengthen: the indices it extends.
STOCK = {
    ELM: {"capsules": [((-13.04100227355957, 7.798957824707031, 91.56619262695312), (0.0, -0.0, 0.0, 1.0), 18.0, 170.0),
                       ((17.28644371032715, 18.81739044189453, 92.22882080078125),
                        (-0.0, 0.04674061760306358, 0.0, 0.9989070892333984), 18.0, 170.0),
                       ((3.4075164794921875, -22.601303100585938, 91.56619262695312), (0.0, -0.0, 0.0, 1.0), 18.0, 170.0)],
          "lengthen": (0, 1, 2)},
    LINDEN: {"capsules": [((0.0, 0.0, 30.0), (-0.03489655628800392, -0.013081544078886509, -0.00045681840856559575,
                                              0.999305248260498), 13.0, 100.0),
                          ((-3.0, 5.0, 150.0), (-0.017449747771024704, -0.01744970679283142, -0.00030458561377599835,
                                                0.9996954202651978), 14.0, 100.0)],
             "lengthen": (1,)},
}
ASSETS = tuple(sorted(STOCK))


def axis(q):
    """The capsule's axis: the quaternion's rotation of +Z."""
    x, y, z, w = q
    return (2 * (x * z + w * y), 2 * (y * z - w * x), 1 - 2 * (x * x + y * y))


def capsules(data):
    """[(centre, orientation, radius, length, {field: (offset, size)})] of the BodySetup's
    SphylElems, in order, and the BodySetup's other stored properties {path: value bytes}."""
    pkg = Package(bytes(data))
    setups = [e for e in pkg.exports if str(pkg.ref(e["class"])) == "BodySetup"]
    assert len(setups) == 1, "%d BodySetups" % len(setups)
    e = setups[0]
    elems, other = {}, {}
    for path, ptype, off, size, _extra in walk(pkg, e["offset"], e["offset"] + e["size"]):
        if path.startswith("AggGeom.SphylElems("):
            k = int(path[len("AggGeom.SphylElems("):path.index(")")])
            elems.setdefault(k, {})[path.split(").", 1)[1]] = (off, size)
        elif not path.startswith("AggGeom"):
            other[path] = bytes(data[off:off + size])
        elif path not in ("AggGeom", "AggGeom.SphylElems"):
            raise ValueError("unexpected collision %s" % path)
    out = []
    for k in range(len(elems)):
        f = elems[k]
        assert set(f) == {"Center", "Orientation", "Radius", "Length"}, f
        c = struct.unpack_from("<3f", data, f["Center"][0])
        q = struct.unpack_from("<4f", data, f["Orientation"][0])
        r = struct.unpack_from("<f", data, f["Radius"][0])[0]
        n = struct.unpack_from("<f", data, f["Length"][0])[0]
        out.append((c, q, r, n, f))
    return out, other


def ends(c, q, r, n):
    """The capsule's lowest and highest points along its axis (bottom, top)."""
    a = axis(q)
    h = n / 2 + r
    return tuple(c[i] - a[i] * h for i in range(3)), tuple(c[i] + a[i] * h for i in range(3))


def _close(a, b, eps=1e-3):
    return all(abs(x - y) <= eps for x, y in zip(a, b))


def lengthened(c, q, r, n, top=TOP):
    """(centre, length) of the capsule with its bottom kept and its top at z = top."""
    a = axis(q)
    grow = (top - ends(c, q, r, n)[1][2]) / a[2]
    assert grow > 0, "already as tall"
    return tuple(c[i] + a[i] * grow / 2 for i in range(3)), n + grow


def apply(asset, data, log=None):
    """The patched copy of one mesh package and the byte ranges written: [(start, end, what)]."""
    caps, _ = capsules(data)
    want = STOCK[asset]
    if len(caps) != len(want["capsules"]):
        sys.exit("%s: %d capsules, the stock mesh has %d" % (asset, len(caps), len(want["capsules"])))
    for k, ((c, q, r, n, _f), (sc, sq, sr, sn)) in enumerate(zip(caps, want["capsules"])):
        if not (_close(c, sc, 1e-6) and _close(q, sq, 1e-9) and r == sr and n == sn):
            sys.exit("%s capsule %d: stock %s, found %s" % (asset, k, (sc, sq, sr, sn), (c, q, r, n)))
    out = bytearray(data)
    written = []
    for k in want["lengthen"]:
        c, q, r, n, f = caps[k]
        nc, nn = lengthened(c, q, r, n)
        struct.pack_into("<3f", out, f["Center"][0], *nc)
        struct.pack_into("<f", out, f["Length"][0], nn)
        written.append((f["Center"][0], f["Center"][0] + 12, "capsule %d Center" % k))
        written.append((f["Length"][0], f["Length"][0] + 4, "capsule %d Length" % k))
        if log:
            log("  capsule %d (radius %g): top %.0f -> %.0f, centre (%.1f, %.1f, %.1f) -> (%.1f, %.1f, %.1f), "
                "length %g -> %.1f" % (k, r, ends(c, q, r, n)[1][2], TOP, *c, *nc, n, nn))
    assert len(out) == len(data)
    return bytes(out), written


def build(stock, log=None):
    """{asset: (patched bytes, written ranges)}."""
    result = {}
    for asset in ASSETS:
        if log:
            log(asset)
        result[asset] = apply(asset, stock[asset], log)
    return result


def main():
    ap = argparse.ArgumentParser(description="Tree trunk collision up into the crown (patch/src)")
    ap.add_argument("paks", nargs="?")
    ap.add_argument("--out", default=os.path.join(HERE, "src"))
    a = ap.parse_args()
    stock = read_stock(paks_dir(a.paks), set(ASSETS))
    missing = set(ASSETS) - set(stock)
    if missing:
        sys.exit("not found in the base paks: %s" % ", ".join(sorted(missing)))
    for asset, (data, _w) in build(stock, log=print).items():
        path = os.path.join(a.out, asset)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
    print("%d tree meshes -> %s" % (len(ASSETS), a.out))


if __name__ == "__main__":
    main()
