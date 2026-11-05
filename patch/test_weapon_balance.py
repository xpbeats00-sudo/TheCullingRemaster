"""Checks the weapon stats reader (weapon_stats.py) and the balance generator
(make_weapon_balance.py) against the game's stock paks.

- The property walker reads the same values at the same offsets as
  uasset.Package for every top-level value of every weapon asset.
- Every tiered melee weapon's HUD tooltip (damage, throw, speed) matches the
  cooked data, with the four values some weapons don't store taken from
  weapon_stats.MELEE_INFERRED - so those inferred values are the game's.
- The shipped table is empty: the generator writes no weapon and records no
  change (the Tier 3 proposal is off by default).
- The Tier 3 proposal checks out against the game (every "from" is the stock
  value) and, applied into a temp folder, changes exactly its values: only
  those bytes differ, every other stored value reads the same, the packages
  re-save byte for byte through UPackage, the record holds each original value
  and reason. Emptying the table afterwards removes the files again.
- A change to damage, throw damage or speed rewrites that weapon's tooltip and
  nothing else in hud.json.
- Refused: a value the asset doesn't store, a stale "from", a non-integer for
  an int, a read-only (enum) value, a missing reason, a file another
  generator wrote.

Needs the game's paks (argument, $CULLING_PAKS, or ../TheCulling); without them
it is NOT TESTED and fails.

usage: python test_weapon_balance.py [Paks dir]
"""
import json
import os
import struct
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_weapon_balance as mb  # noqa: E402
import weapon_stats as ws  # noqa: E402
from stock_paks import paks_dir, read_stock  # noqa: E402
from uasset import Package  # noqa: E402
from ue_package import UPackage  # noqa: E402

passed = 0
quiet = lambda *a: None


def ok(name):
    global passed
    passed += 1
    print("ok    " + name)


def refused(fn, needle):
    try:
        fn()
    except mb.BalanceError as e:
        assert needle in str(e), "refused, but not for %r: %s" % (needle, e)
        return str(e)
    raise AssertionError("not refused (%s)" % needle)


def check_walker(assets):
    n = 0
    for rel, data in assets.items():
        pkg = Package(data)
        for e in pkg.exports:
            if e["name"].startswith("Default__") or e["name"] in ("PrimaryMode", "SecondaryMode", "InstantLaunch", "BlockMode"):
                walked = {p: (k, o, v) for p, k, o, v in ws.leaves(pkg, e["offset"], e["offset"] + e["size"])}
                for name, ptype, idx, voff, size, extra, value in pkg.props(e["name"]):
                    if ptype in ("IntProperty", "FloatProperty") and idx == 0:
                        k, o, v = walked[name]
                        assert o == voff and v == value, (rel, e["name"], name)
                        n += 1
    ok("walker agrees with uasset.Package on %d top-level values in %d assets" % (n, len(assets)))


def check_tooltips(records, paks):
    _, loc = ws.read_hud_loc(paks)
    tiered = [r for r in records if ws.is_tiered_melee(r)]
    assert len(tiered) >= 30, len(tiered)
    used = set()
    for r in tiered:
        want = ws.melee_tooltip_stats(r)
        shown = ws.parse_tooltip(loc["items"][r["hudKey"]]["tooltip_text"]["en"])
        assert (shown["damage"], shown["throw"], shown["speed"]) == (want["damage"], want["throw"], want["speed"]), \
            (r["file"], dict(shown), dict(want))
        for p in ws.MELEE_INFERRED:
            if ws.value(r, "CDO", p)[1] == "inferred":
                used.add(p)
    assert used == set(ws.MELEE_INFERRED), used
    ok("all %d tiered melee tooltips match the cooked data; each inferred default is confirmed by one" % len(tiered))


def check_empty_table(paks, tmp):
    table = json.load(open(mb.TABLE))
    assert table["changes"] == [], "the shipped table is not empty"
    src, rec = os.path.join(tmp, "empty-src"), os.path.join(tmp, "empty.json")
    rows, tips = mb.apply(paks, mb.TABLE, src=src, record=rec, log=quiet)
    assert rows == [] and tips == [] and not os.path.exists(src)
    assert json.load(open(rec))["files"] == []
    ok("the shipped table is empty: no weapon written, nothing recorded (proposal off by default)")


def check_proposal(paks, tmp, stock):
    rows, _ = mb.apply(paks, mb.PROPOSAL, dry_run=True, log=quiet)
    assert rows, "the proposal has no changes"
    src, rec = os.path.join(tmp, "src"), os.path.join(tmp, "applied.json")
    rows, tips = mb.apply(paks, mb.PROPOSAL, src=src, record=rec, log=quiet)
    proposal = mb.load_table(mb.PROPOSAL)["changes"]
    record = json.load(open(rec))
    assert len(record["changes"]) == len(proposal) and record["tooltips"] == []
    for c, r in zip(proposal, record["changes"]):
        assert r["property"] == c["property"] and r["new"] == c["to"] and r["reason"] == c["reason"]
        assert abs(r["original"] - c["from"]) < 1e-6, (r, c)
    for rel in record["files"]:
        old, new = stock[rel], open(os.path.join(src, rel), "rb").read()
        assert UPackage(new).save() == new, rel
        a, b = mb.all_leaves(old), mb.all_leaves(new)
        changed = {k: (a[k][2], b[k][2]) for k in a if a[k][2] != b[k][2]}
        want = {(r["export"], r["property"]): r for r in record["changes"] if r["asset"] == rel}
        assert set(changed) == set(want), (rel, changed)
        slots = [(a[k][1], 4) for k in changed]
        assert all(any(o <= i < o + n for o, n in slots) for i in range(len(old)) if old[i] != new[i]), rel
        for k, (was, now) in changed.items():
            assert abs(now - struct.unpack("<f", struct.pack("<f", want[k]["new"]))[0]) < 1e-6, k
    ok("the Tier 3 proposal: %d values in %d assets change and nothing else; clean re-save; originals recorded"
       % (len(rows), len(record["files"])))

    empty = os.path.join(tmp, "empty-table.json")
    json.dump({"changes": []}, open(empty, "w"))
    mb.apply(paks, empty, src=src, record=rec, log=quiet)
    assert not any(os.path.exists(os.path.join(src, f)) for f in record["files"])
    assert json.load(open(rec))["files"] == []
    ok("emptying the table removes the files the last run wrote")


def check_tooltip_sync(paks, tmp):
    table = os.path.join(tmp, "tips.json")
    json.dump({"changes": [
        {"weapon": "WeapBaseballBat", "export": "CDO", "property": "MeleeConfig.DamageMax", "from": 24.0, "to": 25.0, "reason": "test"},
        {"weapon": "WeapBaseballBat", "export": "CDO", "property": "ThrowConfig.HeavyThrowDamage", "from": 24.0, "to": 25.0, "reason": "test"},
        {"weapon": "WeapYari", "export": "CDO", "property": "WeaponConfig.SpeedModifier", "from": 1.15, "to": 0.85, "reason": "test"},
    ]}, open(table, "w"))
    src, rec = os.path.join(tmp, "tips-src"), os.path.join(tmp, "tips.json.rec")
    mb.apply(paks, table, src=src, record=rec, log=quiet)
    raw, stock_loc = ws.read_hud_loc(paks)
    new_loc = json.load(open(os.path.join(src, ws.HUD_LOC), encoding="utf-8"))
    bat, yari = new_loc["items"]["baseball_bat"]["tooltip_text"]["en"], new_loc["items"]["yari"]["tooltip_text"]["en"]
    assert "Damage: 8-25" in bat and "Throw: 8-25" in bat and "Normal Speed" in bat, bat
    assert "Damage: 9-23" in yari and "Slow Speed" in yari, yari
    for k in ("baseball_bat", "yari"):
        stock_loc["items"][k]["tooltip_text"]["en"] = new_loc["items"][k]["tooltip_text"]["en"]
    assert stock_loc == new_loc, "hud.json changed outside the two tooltips"
    ok("damage / throw / speed changes rewrite only those weapons' HUD tooltips")


def check_refusals(paks, tmp):
    def run(changes):
        path = os.path.join(tmp, "bad.json")
        json.dump({"changes": changes}, open(path, "w"))
        return lambda: mb.apply(paks, path, src=os.path.join(tmp, "bad-src"), record=os.path.join(tmp, "bad.rec"), dry_run=True, log=quiet)
    c = lambda **kw: dict({"weapon": "WeapKatana", "export": "CDO", "reason": "test"}, **kw)
    refused(run([c(property="MeleeConfig.DamageMin", **{"from": 10.0, "to": 11.0})]), "not stored")
    refused(run([c(property="MeleeConfig.DamageMax", **{"from": 25.0, "to": 27.0})]), "stale")
    refused(run([c(property="RecycleValue", **{"from": 30, "to": 30.5})]), "not an integer")
    refused(run([c(property="MeleeWeaponType", **{"from": "x", "to": "y"})]), "only int, float, bool and byte")
    refused(run([{"weapon": "WeapKatana", "export": "CDO", "property": "RecycleValue", "from": 30, "to": 31}]), "missing reason")
    refused(run([c(property="RecycleValue", reason=" ", **{"from": 30, "to": 31})]), "reason is required")
    owned = os.path.join(tmp, "owned-src")
    path = os.path.join(owned, "Victory/Content/Blueprints/Weapons/WeapKatana.uasset")
    os.makedirs(os.path.dirname(path))
    open(path, "wb").write(b"x")
    table = os.path.join(tmp, "own.json")
    json.dump({"changes": [c(property="RecycleValue", **{"from": 30, "to": 31})]}, open(table, "w"))
    refused(lambda: mb.apply(paks, table, src=owned, record=os.path.join(tmp, "own.rec"), log=quiet), "another generator")
    ok("refused: not stored, stale from, non-integer int, enum, no reason, a file it didn't write")


def main():
    paks = paks_dir(sys.argv[1] if len(sys.argv) > 1 else None)
    if not os.path.isdir(paks):
        print("NOT TESTED: game paks not found at %s (pass the Paks dir or set CULLING_PAKS)" % paks)
        sys.exit(1)
    records, assets = ws.read_all(paks)
    check_walker(assets)
    check_tooltips(records, paks)
    with tempfile.TemporaryDirectory() as tmp:
        check_empty_table(paks, tmp)
        stock = read_stock(paks, {mb.asset_path(c["weapon"]) for c in mb.load_table(mb.PROPOSAL)["changes"]})
        check_proposal(paks, tmp, stock)
        check_tooltip_sync(paks, tmp)
        check_refusals(paks, tmp)
    print("%d passed" % passed)


if __name__ == "__main__":
    main()
