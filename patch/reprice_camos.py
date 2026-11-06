"""Apply make_camos.PRICE to the built camo skins without rebuilding them.

The PurchaseCost float in each skin package is rewritten in place (same size,
so no offsets move) and the catalog entries' purchaseCost follow.

usage: python reprice_camos.py
"""
import json
import os
import struct
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_camos  # noqa: E402
from ue_package import UPackage  # noqa: E402

PACK_BY_RARITY = {r: pack for pack, r in make_camos.RARITY.items()}


def main():
    catalog = json.load(open(make_camos.CATALOG))
    changed = 0
    for entry in catalog:
        if entry.get("source") != make_camos.CATALOG_TAG:
            continue
        price = float(make_camos.PRICE[PACK_BY_RARITY[entry["rarity"]]])
        path = os.path.join(HERE, "src", "Victory", "Content", *entry["asset"][len("/Game/"):].split("/")) + ".uasset"
        data = bytearray(open(path, "rb").read())
        up = UPackage(bytes(data))
        e = up.exports[0]
        base = e["fields"][8]
        for name, ptype, start, voff, size in make_camos.iter_tags(up, e["data"]):
            if name == "PurchaseCost":
                assert ptype == "FloatProperty" and size == 4, (path, ptype, size)
                struct.pack_into("<f", data, base + voff, price)
                break
        else:
            raise SystemExit("no PurchaseCost in " + path)
        UPackage(bytes(data))                      # still parses
        open(path, "wb").write(data)
        entry["purchaseCost"] = price
        changed += 1
    from build_catalog import write_catalog       # refuses an item ID used twice
    write_catalog(make_camos.CATALOG, catalog)
    print("%d skins repriced: %s" % (changed, make_camos.PRICE))


if __name__ == "__main__":
    main()
