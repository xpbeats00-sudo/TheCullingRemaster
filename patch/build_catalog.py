"""Scan the game's paks for customization items and write the item catalog
the local server serves (server/data/catalog.json).

Every cosmetic data asset carries an ItemID plus its store metadata
(category, rarity, prices, max quantity), so the catalog comes straight from
the shipped content.

usage: python build_catalog.py <Paks dir> <out.json>
"""
import json
import os
import re
import struct
import sys
import zlib

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from uasset import Package  # noqa: E402

PAK_MAGIC = 0x5A6F12E1
WANTED = re.compile(r"/Content/.*\.uasset$")


def fstring(b, o):
    n = struct.unpack_from("<i", b, o)[0]; o += 4
    if n < 0:
        return b[o:o - 2 * n].decode("utf-16le").rstrip("\0"), o - 2 * n
    return b[o:o + n].decode("latin1").rstrip("\0"), o + n


def pak_entries(path):
    f = open(path, "rb")
    f.seek(-44, 2)
    magic, ver, index_off, index_size = struct.unpack("<IiQQ", f.read(24))
    assert magic == PAK_MAGIC
    f.seek(index_off)
    b = f.read(index_size)
    mount, o = fstring(b, 0)
    count = struct.unpack_from("<i", b, o)[0]; o += 4
    for _ in range(count):
        name, o = fstring(b, o)
        off, csize, usize, method = struct.unpack_from("<qqqi", b, o); o += 28 + 20
        blocks = []
        if method:
            nb = struct.unpack_from("<i", b, o)[0]; o += 4
            for _ in range(nb):
                blocks.append(struct.unpack_from("<qq", b, o)); o += 16
        o += 5
        yield f, mount + name, off, usize, method, blocks


def read_entry(f, off, usize, method, blocks):
    if not method:
        f.seek(off + 53)
        return f.read(usize)
    out = bytearray()
    for start, end in blocks:
        f.seek(start)
        out += zlib.decompress(f.read(end - start))
    return bytes(out)


def main(paks_dir, out_path):
    items = {}
    for pak in sorted(os.listdir(paks_dir)):
        if not pak.endswith(".pak"):
            continue
        for f, name, off, usize, method, blocks in pak_entries(os.path.join(paks_dir, pak)):
            if not WANTED.search(name) or usize > 400000:
                continue
            data = read_entry(f, off, usize, method, blocks)
            if b"ItemID" not in data:
                continue
            try:
                pkg = Package(data)
                asset = os.path.splitext(os.path.basename(name))[0]
                # Some files differ in case from their asset (AirDrop_Cyclops
                # holds Airdrop_Cyclops); a missed asset is an item nobody owns.
                asset = next((e["name"] for e in pkg.exports if e["name"].lower() == asset.lower()), asset)
                props = {p[0]: p[6] for p in pkg.props(asset)}
                cls = pkg.ref(pkg.export(asset)["class"])
            except Exception:
                continue
            tid = str(props.get("ItemID", "")).strip()
            if not tid.isdigit():
                continue
            items[int(tid)] = {
                "tid": int(tid),
                "asset": name.replace("../../../Victory/Content/", "/Game/").rsplit(".", 1)[0],
                "class": cls,
                "type": str(props.get("CustomizationType", "")).split("::")[-1],
                "displayName": props.get("ItemDisplayName", asset),
                "category": props.get("Category", ""),
                "storeCategory": props.get("StoreCategory", props.get("Category", "")),
                "rarity": props.get("Rarity", 0),
                "maxQuantity": props.get("MaxQuantityAllowed", 1),
                "purchaseCost": props.get("PurchaseCost", 0.0),
                "premiumCost": props.get("PremiumPurchaseCost", 0.0),
                "resale": props.get("ResaleMultiplier", 0.0),
                "purchasable": bool(props.get("bIsPurchasable", False)),
                "premiumPurchasable": bool(props.get("bIsPremiumPurchasable", False)),
                "default": bool(props.get("bDefaultItem", False)),
            }
    catalog = sorted(items.values(), key=lambda i: i["tid"])
    json.dump(catalog, open(out_path, "w"), indent=1)
    by_type = {}
    for i in catalog:
        by_type[i["type"] or i["class"]] = by_type.get(i["type"] or i["class"], 0) + 1
    print("%d items -> %s" % (len(catalog), out_path))
    for t, n in sorted(by_type.items(), key=lambda x: -x[1]):
        print("  %-28s %d" % (t, n))


if __name__ == "__main__":
    main(sys.argv[1], sys.argv[2])
