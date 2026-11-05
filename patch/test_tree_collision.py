"""Checks make_tree_collision.py against the stock paks:

- the stock tree meshes re-save byte for byte through ue_package.UPackage,
  and so do the patched ones;
- the patched packages are the stock ones with exactly the intended floats
  changed (each lengthened capsule's Center and Length): same size, same
  summary, names, imports and export table, every other byte equal; every
  import and export reference resolves;
- the geometry: every capsule keeps its radius and orientation and its
  bottom; the lengthened ones keep their axis (the same line: the footprint
  and the navmesh don't change) and reach TOP; the others are stock; the
  BodySetup's other properties (profile, trace flag, walkable slope) are
  byte-identical; and TOP at the smallest instance scale on the maps is far
  above a jumping player's reach;
- patch/src holds exactly the generator's output (when it has the files).

usage: python test_tree_collision.py [<stock Paks dir>]   (default: $CULLING_PAKS or ../TheCulling's)
"""
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_tree_collision as M  # noqa: E402
from stock_paks import paks_dir, read_stock  # noqa: E402
from ue_package import EXPORT_ENTRY, UPackage  # noqa: E402

SRC = os.path.join(HERE, "src")
MIN_SCALE = 0.81           # the smallest Elm / Linden instance scale on Jungle and Prison (their Landscape levels)
JUMP_REACH = 50 + 128 + 45  # the pawn's bottom-sphere centre at a jump's apex (JumpZVelocity 500), plus a step
passed = 0


def ok(msg):
    global passed
    passed += 1
    print("ok   " + msg)


def check(cond, msg):
    if not cond:
        print("FAIL " + msg)
        sys.exit(1)


def resolves(pkg):
    """Every reference in the import and export tables is 0, an import or an export."""
    n_imp, n_exp = len(pkg.imports), len(pkg.exports)
    good = lambda i: i == 0 or (i < 0 and -i <= n_imp) or (0 < i <= n_exp)  # noqa: E731
    for imp in pkg.imports:
        outer = struct.unpack_from("<i", imp, 16)[0]
        if not (outer <= 0 and -outer <= n_imp):
            return False
        for at in (0, 8, 20):
            if not 0 <= struct.unpack_from("<i", imp, at)[0] < len(pkg.names):
                return False
    return all(good(e["fields"][k]) for e in pkg.exports for k in range(4))


def main():
    paks = paks_dir(sys.argv[1] if len(sys.argv) > 1 else None)
    stock = read_stock(paks, set(M.ASSETS))
    check(set(stock) == set(M.ASSETS), "stock meshes missing from %s: %s" % (paks, set(M.ASSETS) - set(stock)))
    built = M.build(stock)
    for asset in M.ASSETS:
        name = asset.rsplit("/", 1)[1]
        old, (new, written) = stock[asset], built[asset]
        check(UPackage(old).save() == old, "%s: the stock package doesn't re-save byte for byte" % name)
        check(UPackage(new).save() == new, "%s: the patched package doesn't re-save byte for byte" % name)
        po, pn = UPackage(old), UPackage(new)
        check(len(new) == len(old), "%s: size changed" % name)
        header = struct.unpack_from("<i", old, po.pos_total_header)[0]
        check(new[:header] == old[:header], "%s: summary / names / imports / export table changed" % name)
        check(pn.names == po.names and pn.imports == po.imports and resolves(pn), "%s: tables" % name)
        check([EXPORT_ENTRY.pack(*e["fields"]) for e in pn.exports] == [EXPORT_ENTRY.pack(*e["fields"]) for e in po.exports],
              "%s: export entries" % name)
        allowed = set()
        for a, b, _what in written:
            allowed.update(range(a, b))
        diff = [i for i in range(header, len(old)) if old[i] != new[i]]
        check(diff and set(diff) <= allowed, "%s: bytes changed outside the capsules' Center/Length: %s"
              % (name, sorted(set(diff) - allowed)[:8]))
        check(len(written) == 2 * len(M.STOCK[asset]["lengthen"]), "%s: written %s" % (name, written))
        ok("%s: re-saves byte for byte (stock and patched); only %d bytes in %d fields differ, all capsule Center/Length"
           % (name, len(diff), len(written)))

        caps_old, other_old = M.capsules(old)
        caps_new, other_new = M.capsules(new)
        check(other_new == other_old, "%s: other BodySetup properties changed" % name)
        check(other_old["WalkableSlopeOverride.WalkableSlopeBehavior"] == other_new["WalkableSlopeOverride.WalkableSlopeBehavior"],
              "walkable slope")
        for k, ((c0, q0, r0, n0, _), (c1, q1, r1, n1, _)) in enumerate(zip(caps_old, caps_new)):
            check(q1 == q0 and r1 == r0, "%s capsule %d: radius or orientation changed" % (name, k))
            b0, t0 = M.ends(c0, q0, r0, n0)
            b1, t1 = M.ends(c1, q1, r1, n1)
            check(all(abs(x - y) < 1e-3 for x, y in zip(b0, b1)), "%s capsule %d: bottom moved %s -> %s" % (name, k, b0, b1))
            if k in M.STOCK[asset]["lengthen"]:
                check(abs(t1[2] - M.TOP) < 1e-2 and n1 > n0, "%s capsule %d: top %s" % (name, k, t1))
                a = M.axis(q0)
                d = [c1[i] - c0[i] for i in range(3)]
                s = sum(d[i] * a[i] for i in range(3))
                check(all(abs(d[i] - s * a[i]) < 1e-3 for i in range(3)), "%s capsule %d: left its axis" % (name, k))
                check((M.TOP - r1) * MIN_SCALE > 1.5 * JUMP_REACH,
                      "%s capsule %d: the top at the smallest scale is within reach" % (name, k))
            else:
                check(c1 == c0 and n1 == n0, "%s capsule %d changed" % (name, k))
        ok("%s: capsules keep radius, axis and bottom; %s now reach %g (cap centre %.0f+ up at scale %.2f, a jump "
           "reaches %d); the rest of the BodySetup (BlockAll, simple as complex, unwalkable) is stock"
           % (name, list(M.STOCK[asset]["lengthen"]), M.TOP, (M.TOP - caps_new[0][2]) * MIN_SCALE, MIN_SCALE,
              JUMP_REACH))

        out = os.path.join(SRC, asset)
        if os.path.exists(out):
            check(open(out, "rb").read() == new, "patch/src's %s isn't the generator's output (rerun make_tree_collision.py)"
                  % name)
            ok("patch/src %s is the generator's output" % name)
        else:
            print("skip patch/src %s (not built)" % name)
    print("%d checks passed" % passed)


if __name__ == "__main__":
    main()
