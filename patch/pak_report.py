"""What a pak holds and what a release ships: the numbers behind
docs/LOADING_TIME_OPTIMIZATION_REPORT.md.

  python pak_report.py <pak>                 sizes by area and type, the largest
                                             entries, duplicates, diagnostics
  python pak_report.py <pak> --check         the same; exit 1 if diagnostics ship
  python pak_report.py --release <game dir>  bytes a full release (make_release.py
                                             --full) links from that install

Diagnostics are test content that must not reach players: the Ice Axe camo
test mesh (make_camo_tests.py, IceAxe_A_XPTest) and anything pointing at it.
"""
import argparse
import collections
import hashlib
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_catalog import pak_entries, read_entry  # noqa: E402

DIAGNOSTIC_NAMES = ("XPTest",)
DIAGNOSTIC_REFS = (b"IceAxe_A_XPTest",)


def inventory(pak):
    rows = []
    for f, name, off, usize, method, blocks in pak_entries(pak):
        stored = sum(e - s for s, e in blocks) if method else usize
        rows.append({"name": name.replace("../../../", ""), "raw": usize, "stored": stored, "method": method,
                     "entry": (f, off, usize, method, blocks)})
    return rows


def area(name):
    parts = name.split("/")
    return "/".join(parts[:4]) if len(parts) > 4 else "/".join(parts[:-1]) or name


def diagnostics(rows):
    """Diagnostic entries, and the shipped assets that reference them."""
    found = []
    for r in rows:
        if any(d in r["name"] for d in DIAGNOSTIC_NAMES):
            found.append((r["name"], "diagnostic asset"))
        elif r["name"].endswith((".uasset", ".umap")) and r["raw"] < 8_000_000:
            data = read_entry(*r["entry"])
            for ref in DIAGNOSTIC_REFS:
                if ref in data:
                    found.append((r["name"], "references " + ref.decode()))
    return found


def duplicates(rows):
    by_hash = collections.defaultdict(list)
    for r in rows:
        by_hash[hashlib.sha1(read_entry(*r["entry"])).hexdigest()].append(r)
    return [g for g in by_hash.values() if len(g) > 1]


def report(pak, check=False):
    rows = inventory(pak)
    raw = sum(r["raw"] for r in rows)
    stored = sum(r["stored"] for r in rows)
    print("%s: %d entries, %.1f MB raw, %.1f MB stored (%.0f%%), file %.1f MB" % (
        os.path.basename(pak), len(rows), raw / 1e6, stored / 1e6, 100.0 * stored / max(raw, 1),
        os.path.getsize(pak) / 1e6))
    print("uncompressed entries: %d" % sum(1 for r in rows if not r["method"]))
    for title, key in (("by area", area), ("by type", lambda n: os.path.splitext(n)[1].lower() or "(none)")):
        groups = collections.defaultdict(lambda: [0, 0, 0])
        for r in rows:
            g = groups[key(r["name"])]
            g[0] += 1
            g[1] += r["raw"]
            g[2] += r["stored"]
        print(title + ":")
        for k, (n, u, c) in sorted(groups.items(), key=lambda kv: -kv[1][2])[:15]:
            print("  %-52s %5d files %8.1f MB raw %8.1f MB stored" % (k, n, u / 1e6, c / 1e6))
    print("largest entries (stored MB, raw MB):")
    for r in sorted(rows, key=lambda r: -r["stored"])[:12]:
        print("  %7.2f %7.2f  %s" % (r["stored"] / 1e6, r["raw"] / 1e6, r["name"]))
    dups = duplicates(rows)
    waste = sum(g[0]["stored"] * (len(g) - 1) for g in dups)
    print("identical entries: %d groups, %.2f MB stored more than once" % (len(dups), waste / 1e6))
    for g in dups[:10]:
        print("  " + ", ".join(r["name"].split("/")[-1] for r in g))
    diag = diagnostics(rows)
    print("diagnostics shipped: %d" % len(diag))
    for name, why in diag:
        print("  %s (%s)" % (name, why))
    return 1 if (check and diag) else 0


def release_size(game):
    """What make_release.py --full links from `game` (its FULL_EXCLUDE rules)."""
    import make_release
    total = count = 0
    excluded = []
    for folder, _, files in os.walk(game):
        for name in files:
            p = os.path.join(folder, name)
            rel = os.path.relpath(p, game).replace(os.sep, "/")
            if rel in make_release.FULL_EXCLUDE or rel.startswith(".remaster/") or rel.endswith(".part"):
                excluded.append((rel, os.path.getsize(p)))
                continue
            total += os.path.getsize(p)
            count += 1
    print("full release from %s: %d files, %.1f MB (the Remaster pak is added on top)" % (game, count, total / 1e6))
    for rel, size in excluded:
        print("  excluded %-70s %8.2f MB" % (rel, size / 1e6))
    return total


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("pak", nargs="?")
    ap.add_argument("--check", action="store_true", help="exit 1 if diagnostic content ships")
    ap.add_argument("--release", metavar="GAME_DIR", help="size of a full release made from this install")
    a = ap.parse_args()
    if a.release:
        release_size(a.release)
    if a.pak:
        sys.exit(report(a.pak, a.check))
