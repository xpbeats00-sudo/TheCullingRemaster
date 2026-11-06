"""Checks make_bot_ai.py's tiers against the stock assets.

For every tier:
- each patched package parses, keeps its size, and re-saves byte for byte
  through ue_package.py (UPackage(data).save() == data);
- the name, import and export tables are the stock ones (so every import
  still resolves), and the only bytes that differ from stock are the values
  the tier meant to write; each reads back as the tier's value;
- every property written is on the allow list (decision, perception, memory,
  threat, timing and loot values: nothing about health, damage, stamina or
  movement);
- the FName written (FireProjectile's DestinationKey) is a key of the tree's
  blackboard and is an object key (the task reads it as an actor);
- the tiers are ordered: decisions get faster, sight and memory longer, from
  beginner to elite; MaxDistance follows the sight radius; loot scores sit
  between the fists and the weakest melee weapon (healing, armour) or below
  the fists (what the AI can't use).
Also: no other generator writes the AI assets, and if patch/src holds them
they are one tier's build, complete.

usage: python test_bot_ai.py <Paks dir>
"""
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_bot_ai as M  # noqa: E402
import patch_assets  # noqa: E402
from uasset import Package  # noqa: E402
from ue_package import UPackage  # noqa: E402

BLACKBOARD = M.BP + "AI/Base/BasicBlackboard.uasset"
failures = []


def check(ok, msg):
    if not ok:
        failures.append(msg)
    return ok


def header_end(data):
    return min(e["offset"] for e in Package(data).exports)


def blackboard_keys(data):
    """{key name: key type class} of a BlackboardData asset."""
    pkg = Package(data)
    keys = {}
    for e in pkg.exports:
        if pkg.ref(e["class"]) != "BlackboardData":
            continue
        entry = {}
        for path, ptype, off, size, _x in M.walk(pkg, e["offset"], e["offset"] + e["size"]):
            if path.startswith("Keys(") and path.endswith(").EntryName"):
                entry[path.split(")")[0]] = M.read_value(pkg, ptype, off)
            elif path.startswith("Keys(") and path.endswith(").KeyType"):
                k = path.split(")")[0]
                index = struct.unpack_from("<i", data, off)[0]          # the key type subobject
                keys[entry.get(k)] = pkg.ref(pkg.exports[index - 1]["class"]) if index > 0 else None
    return keys


def check_tier(tier, stock):
    built = M.build(tier, stock)
    for asset, (out, written) in built.items():
        src = stock[asset]
        tag = "%s %s" % (tier, asset.rsplit("/", 1)[1])
        if not check(len(out) == len(src), "%s: size %d -> %d" % (tag, len(src), len(out))):
            continue
        try:
            pkg = Package(out)
            check(UPackage(out).save() == out, "%s: doesn't re-save byte for byte" % tag)
        except Exception as e:                                   # noqa: BLE001
            check(False, "%s: doesn't parse: %s" % (tag, e))
            continue
        h = header_end(src)
        check(out[:h] == src[:h], "%s: header (names, imports, exports) changed" % tag)
        # every import's names and outer are valid
        up = UPackage(out)
        for i, raw in enumerate(up.imports):
            cp, _, cn, _, outer, on, _ = struct.unpack_from("<iiiiiii", raw)
            check(all(0 <= n < len(up.names) for n in (cp, cn, on)) and -len(up.imports) <= outer <= len(up.exports),
                  "%s: import %d doesn't resolve" % (tag, i))
        allowed = bytearray(len(out))
        for start, end, export, where, _old, _new in written:
            for k in range(start, end):
                allowed[k] = 1
            prop = where.rsplit(".", 1)[-1] if not where.startswith(("None#", "range#", "MaxHoldTime#",
                                                                     "ChargeTime#", "StopPrimary#")) else None
            if prop is not None:
                check(prop in M.ALLOWED_PROPS, "%s: %s.%s isn't an allowed property" % (tag, export, where))
        stray = [k for k in range(len(out)) if out[k] != src[k] and not allowed[k]]
        check(not stray, "%s: %d bytes changed outside the intended values (first @%d)"
              % (tag, len(stray), stray[0] if stray else 0))
        # read back
        for kind, export, where, value in M.tier_edits(tier)[asset]:
            if kind == "prop":
                ptype, off, _size = M.find_prop(pkg, export, where)
                got = M.read_value(pkg, ptype, off)
                ok = got == value if isinstance(value, str) else abs(got - M.f32(float(value))) < 1e-6
            else:
                pattern, occurrence, arg = where
                hits = M.code_literals(pkg, export, pattern)
                off = hits[occurrence] if arg is None else hits[occurrence][arg]
                got = struct.unpack_from("<f", out, off)[0]
                ok = abs(got - M.f32(float(value))) < 1e-6
            check(ok, "%s: %s %s reads %r, not %r" % (tag, export, where, got, value))
    return built


def check_design(stock):
    t = [M.TIERS[n] for n in M.ORDER]

    def ordered(key, f, rising, strict=False):
        vals = [f(x[key]) for x in t]
        pairs = list(zip(vals, vals[1:]))
        ok = all((b > a if strict else b >= a) if rising else (b < a if strict else b <= a) for a, b in pairs)
        check(ok, "tiers aren't ordered by %s: %s" % (key, vals))

    ordered("decide", lambda v: v, rising=False, strict=True)
    ordered("scavenge", lambda v: v, rising=False)
    ordered("retarget", lambda v: v[0], rising=False)
    ordered("listen", lambda v: v[0], rising=False)
    ordered("sight", lambda v: v[0], rising=True)
    ordered("sight", lambda v: v[2], rising=True)
    ordered("memory", lambda v: v[0], rising=True)
    ordered("block", lambda v: v[0], rising=False)
    ordered("draw", lambda v: v[0] + v[1], rising=False)
    for name, x in M.TIERS.items():
        check(x["sight"][1] > x["sight"][0], "%s: lose-sight radius not beyond sight radius" % name)
        check(x["charge"][0] <= x["charge"][1] and x["draw"][0] <= x["draw"][1], "%s: a range is reversed" % name)
        check(x["release"] > x["draw"][1], "%s: forced bow release before the draw ends" % name)
        check(x["block"][1] <= x["block"][2], "%s: block cooldown range reversed" % name)
        check(0.0 < x["decide"] < 1.0, "%s: combat decision interval %s" % (name, x["decide"]))
        # every tier is slower than stock's every-frame dice and forgets sooner than stock's 60 s
        check(x["decide"] >= 0.05 and x["memory"][0] < 60.0, "%s: not below stock omniscience" % name)
        edits = M.tier_edits(name)[M.CONTROLLER]
        md = [v for _k, e, w, v in edits if w == "ThreatParams.MaxDistance"]
        check(md == [x["sight"][0]], "%s: ThreatParams.MaxDistance doesn't follow the sight radius" % name)
    weakest_melee = 10
    for item, (old, new) in M.LOOT_SCORES.items():
        healing_or_armour = item.startswith("Items/")
        if healing_or_armour:
            check(5 < new < weakest_melee, "%s: score %d not between fists (5) and melee (10)" % (item, new))
        else:
            check(new < 5, "%s: score %d not below the fists" % (item, new))
    # FireProjectile's key: an object key of the tree's blackboard
    keys = blackboard_keys(stock[BLACKBOARD])
    check("SelfActor" in keys and keys["SelfActor"] == "BlackboardKeyType_Object",
          "SelfActor isn't an object key of BasicBlackboard: %s" % keys)
    check(keys.get("Destination") == "BlackboardKeyType_Vector", "Destination isn't a vector key: %s" % keys)


def check_ownership():
    mine = set(M.all_assets())
    theirs = patch_assets.all_assets()
    check(not (mine & theirs), "patch_assets.py also writes %s" % sorted(mine & theirs))
    for f in sorted(os.listdir(HERE)):
        if not f.endswith(".py") or f in ("make_bot_ai.py", "test_bot_ai.py"):
            continue
        text = open(os.path.join(HERE, f), encoding="utf-8", errors="replace").read()
        for asset in (M.TREE, M.CONTROLLER, M.CHARGE, M.BLOCK, M.FIRE):
            check(asset not in text, "%s writes or names %s" % (f, asset))


def check_src(stock, builds):
    present = [a for a in M.all_assets() if os.path.exists(os.path.join(HERE, "src", a))]
    if not present:
        return "no AI assets in patch/src"
    data = {a: open(os.path.join(HERE, "src", a), "rb").read() for a in present}
    for tier in M.ORDER:
        want = {a: b[0] for a, b in builds[tier].items()}
        if set(want) == set(data) and all(data[a] == want[a] for a in want):
            return "patch/src holds the %s tier" % tier
    check(False, "patch/src's AI assets aren't one tier's complete build (rerun make_bot_ai.py)")
    return ""


def main(paks_dir):
    wanted = set(M.all_assets()) | {BLACKBOARD}
    stock = M.stock_assets(paks_dir, wanted)
    for asset in sorted(wanted):
        check(UPackage(stock[asset]).save() == stock[asset], "stock %s doesn't round-trip" % asset)
    builds = {tier: check_tier(tier, stock) for tier in M.ORDER}
    check_design(stock)
    check_ownership()
    where = check_src(stock, builds)
    if failures:
        for f in failures:
            print("FAIL", f)
        sys.exit(1)
    n = sum(len(b) for b in builds.values())
    edits = sum(len(e) for t in M.ORDER for e in M.tier_edits(t).values())
    print("ok    %d tiers, %d patched packages, %d values: same size, re-save byte for byte, stock tables, "
          "only intended bytes; tiers ordered; loot scores in range; %s" % (len(M.ORDER), n, edits, where))


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__)
    main(sys.argv[1])
