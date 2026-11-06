"""Checks the airdrop price cut (make_airdrop_prices.py): every airdrop costs
round(stock x 0.75) FUNC, halves up.

- The rounding rule, against exact fractions, for every price 0..1000.
- Against the game's stock paks: for every AirDropPackage, the patched copy in
  patch/src stores ActivityResourceCost = new_price(stock); the patched file is
  the stock file with only those 4 bytes changed; it re-saves byte for byte
  through ue_package.UPackage and every other stored property reads the same.
- patch/loot/airdrop_prices.json, docs/AIRDROP_PRICES.md and the loot tables
  (funcCost / stockFuncCost) hold the same numbers as the cooked assets.
- Running the generator again (into a temp folder) gives identical files:
  it always starts from the stock paks, never the patch pak.

Needs the game's paks (argument, $CULLING_PAKS, or ../TheCulling); without them
the asset checks are NOT TESTED and the run fails.

usage: python test_airdrop_prices.py [Paks dir]
"""
import json
import os
import struct
import sys
import tempfile
from fractions import Fraction
from math import floor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_airdrop_prices as m  # noqa: E402
from stock_paks import paks_dir, read_stock  # noqa: E402
from uasset import Package  # noqa: E402
from ue_package import UPackage  # noqa: E402

passed = 0


def ok(name):
    global passed
    passed += 1
    print("ok    " + name)


def check_rounding():
    for stock in range(0, 1001):
        exact = Fraction(stock) * Fraction(3, 4)
        assert m.new_price(stock) == floor(exact + Fraction(1, 2)), stock
        assert abs(m.new_price(stock) - exact) <= Fraction(1, 2), stock
    for stock, new in ((85, 64), (70, 53), (95, 71), (100, 75), (130, 98), (205, 154), (175, 131)):
        assert m.new_price(stock) == new, (stock, m.new_price(stock), new)
    ok("rounding: round(x * 0.75), halves up, for 0..1000 (85->64, 70->53, 95->71)")


def stored(pkg):
    out = {}
    for e in pkg.exports:
        for name, ptype, idx, voff, size, extra, value in pkg.props(e["name"]):
            out[(e["name"], name, idx)] = value
    return out


def check_assets(paks):
    stock = read_stock(paks, m.AIRDROPS)
    assert len(stock) >= 40, "only %d airdrop packages in %s" % (len(stock), paks)
    table = json.load(open(m.OUT_JSON))
    rows = {r["asset"]: r for r in table["airdrops"]}
    assert set(rows) == set(stock), "airdrop_prices.json is stale: run make_airdrop_prices.py"
    priced = 0
    for rel, data in sorted(stock.items()):
        pkg = Package(data)
        e = pkg.exports[0]
        slot = m.price_slot(pkg, e["name"])
        path = os.path.join(m.SRC, rel)
        if slot is None:
            assert not os.path.exists(path), "%s has no stored price but a patched copy" % rel
            assert rows[rel]["stock"] is None and rows[rel]["new"] is None
            continue
        off, old = slot
        assert os.path.exists(path), "%s not generated: run make_airdrop_prices.py" % rel
        new = open(path, "rb").read()
        assert len(new) == len(data), rel
        want = m.new_price(old)
        assert struct.unpack_from("<i", new, off)[0] == want, rel
        diff = [i for i in range(len(data)) if data[i] != new[i]]
        assert all(off <= i < off + 4 for i in diff), "%s: bytes outside the price changed: %s" % (rel, diff[:8])
        assert UPackage(new).save() == new, "%s does not re-save byte for byte" % rel
        a, b = stored(pkg), stored(Package(new))
        assert set(a) == set(b), rel
        changed = [k for k in a if a[k] != b[k]]
        assert changed == [(e["name"], m.PRICE_PROPERTY, 0)], (rel, changed)
        assert rows[rel]["stock"] == old and rows[rel]["new"] == want, rel
        priced += 1
    ok("%d airdrop packages: price = round(stock x 0.75), only those 4 bytes differ, re-save clean" % priced)
    return stock, rows


def check_tables(rows):
    loot = json.load(open(os.path.join(HERE, "loot", "loot_tables.json")))["airdrops"]
    by_export = {r["export"]: r for r in rows.values()}
    assert set(loot) == set(by_export), "loot_tables.json airdrops differ: run loot_tables.py"
    for name, kit in loot.items():
        r = by_export[name]
        assert kit["stockFuncCost"] == r["stock"] and kit["funcCost"] == r["new"], (name, kit, r)
    ok("loot_tables.json: funcCost is the new price, stockFuncCost the stock one, for all %d kits" % len(loot))
    doc = open(m.OUT_DOC, encoding="utf-8").read()
    for r in rows.values():
        if r["stock"] is not None:
            needle = "| %d | %d | %s | %d |" % (r["itemId"], r["stock"], m._dec(Fraction(r["stock"]) * m.PRICE_FACTOR), r["new"])
            assert needle in doc, (r["name"], needle)
    ok("docs/AIRDROP_PRICES.md lists every airdrop's stock and new price")


def check_stock_only():
    import stock_paks
    with tempfile.TemporaryDirectory() as tmp:
        for f in ("pakchunk0-WindowsClient.pak", "LocalServer-WindowsClient_P.pak", "Other_p.pak", "notes.txt"):
            open(os.path.join(tmp, f), "wb").close()
        got = [os.path.basename(p) for p in stock_paks.stock_paks(tmp)]
    assert got == ["pakchunk0-WindowsClient.pak"], got
    ok("only base paks are read, never a patch pak (*_P.pak)")


def check_rerun(paks):
    """Generating twice gives the same bytes (stock only, never the patch pak)."""
    with tempfile.TemporaryDirectory() as tmp:
        saved = m.SRC, m.OUT_JSON, m.OUT_DOC
        m.SRC, m.OUT_JSON, m.OUT_DOC = os.path.join(tmp, "src"), os.path.join(tmp, "p.json"), os.path.join(tmp, "p.md")
        try:
            import io
            import contextlib
            with contextlib.redirect_stdout(io.StringIO()):
                m.main(paks)
            for folder, _, files in os.walk(m.SRC):
                for f in files:
                    rel = os.path.relpath(os.path.join(folder, f), m.SRC)
                    assert open(os.path.join(folder, f), "rb").read() == open(os.path.join(saved[0], rel), "rb").read(), rel
            assert open(m.OUT_JSON).read() == open(saved[1]).read()
        finally:
            m.SRC, m.OUT_JSON, m.OUT_DOC = saved
    ok("a second run gives identical files (always from the stock paks)")


def main():
    check_rounding()
    check_stock_only()
    paks = paks_dir(sys.argv[1] if len(sys.argv) > 1 else None)
    if not os.path.isdir(paks):
        print("NOT TESTED: game paks not found at %s (pass the Paks dir or set CULLING_PAKS)" % paks)
        sys.exit(1)
    stock, rows = check_assets(paks)
    check_tables(rows)
    check_rerun(paks)
    print("%d passed" % passed)


if __name__ == "__main__":
    main()
