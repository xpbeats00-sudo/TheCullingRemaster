"""Checks the Necro Mist build (run after make_eye_skins.py and make_camos.py).

- Catalog: 8 colours x 5 pieces of "xp-eye-skins" items with unique IDs in the
  stock ID scheme, bought with credits; 8 Necro Mist camos on every weapon the
  other camos cover, one camo key ("_XP_<Camo>") per colour.
- Every generated package parses and saves back byte-for-byte.
- Data assets: ItemID, name and price match the catalog, premium-store tags
  are gone, the pieces of one colour share one cloth tint.
- Mask: the data asset's mesh exists, its eye slot imports that colour's
  MaterialInstanceConstant, whose parent is M_NecroMist and whose two Fog
  Tints are the palette colour x2 and x5. With a Paks dir: the mesh copy has
  the stock mesh's exact size and export offsets, and the Fog Tint GUIDs are
  M_NecroMist's.
- Mask hood: the mask's BaseColor override is a 1024 texture whose hood
  cloth leans to the colour while the skull's bone keeps the stock colour
  (with a Paks dir). Top: its material is a child of MI_Top_Necro with Emissive Color
  in the colour.
- Registry: patch/registry/eye_skins.bin lists every data asset.

The in-game look is not checked here: that needs the game.

usage: python test_eye_skins.py [<Paks dir>]
"""
import json
import os
import struct
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import cooked_texture  # noqa: E402
import make_eye_skins as eye  # noqa: E402
from ue_package import UPackage  # noqa: E402

PAKS = sys.argv[1] if len(sys.argv) > 1 else None
passed = 0


def ok(name):
    global passed
    passed += 1
    print("ok   " + name)


def fail(msg):
    print("FAIL " + msg)
    sys.exit(1)


def check(cond, msg):
    if not cond:
        fail(msg)


def load(package_path):
    p = eye.out_path(package_path.split(".")[0])
    check(os.path.exists(p), "missing package " + package_path)
    data = open(p, "rb").read()
    up = UPackage(data)
    check(up.save() == data, "does not round-trip: " + package_path)
    return data, up


def tags(up):
    d = up.exports[0]["data"]
    return {n: (t, d[v:v + z]) for n, _, t, _, v, z in eye.iter_tags(up, d)}


def text(raw):
    return raw[4:-1].decode("latin1")


def imports(up):
    out = []
    for imp in up.imports:
        _, _, cls, _, outer, obj, num = struct.unpack("<iiiiiii", imp)
        pkg = up.names[struct.unpack_from("<i", up.imports[-outer - 1], 20)[0]][0] if outer < 0 else None
        out.append((up.names[cls][0], up.names[obj][0], pkg))
    return out


def vectors(up):
    return {eye.name_value(up, f["ParameterName"]): (f["ExpressionGUID"], struct.unpack("<4f", f["ParameterValue"]))
            for f in eye.struct_array(up, up.exports[0]["data"], "VectorParameterValues")}


def close(a, b, tol=1e-4):
    return all(abs(x - y) <= tol for x, y in zip(a, b))


catalog = json.load(open(eye.CATALOG))
items = [t for t in catalog if t.get("source") == eye.CATALOG_TAG]
tids = [t["tid"] for t in catalog]

# ---- catalog
check(len(items) == len(eye.PALETTE) * len(eye.PIECES), "expected %d eye items, found %d"
      % (len(eye.PALETTE) * len(eye.PIECES), len(items)))
check(len(tids) == len(set(tids)), "duplicate item IDs in the catalog")
expected_ids = {first + i for _, _, _, first, _, _ in eye.PIECES for i in range(len(eye.PALETTE))}
check({t["tid"] for t in items} == expected_ids, "eye item IDs are not the planned ranges")
for t in items:
    check(t["purchasable"] and not t["premiumPurchasable"] and t["premiumCost"] == 0 and t["purchaseCost"] > 0,
          "%s: not a credits purchase" % t["asset"])
    check(t["asset"].startswith(eye.CLOTHING), "%s: not under %s (the game only lists that folder)"
          % (t["asset"], eye.CLOTHING))
    check(t["class"] == "CharacterCustomizationDataAsset", t["asset"])
ok("catalog: %d items, IDs %d-%d, unique, credits only" % (len(items), min(expected_ids), max(expected_ids)))

camos = [t for t in catalog if t.get("source") == "xp-camos"]
key = lambda t: t["asset"].split("_XP_")[1]  # the server's camoKey
mist = [t for t in camos if key(t).startswith("Necro_Mist_")]
weapons = {t["asset"].rsplit("/", 1)[1].split("_XP_")[0] for t in camos}
mist_keys = {key(t) for t in mist}
check(mist_keys == {eye.slug(eye.CAMO_PACK + " " + label) for label, _ in eye.PALETTE},
      "Necro Mist camo keys: %s" % sorted(mist_keys))
for k in mist_keys:
    on = {t["asset"].rsplit("/", 1)[1].split("_XP_")[0] for t in mist if key(t) == k}
    check(on == weapons, "%s is missing on %s" % (k, sorted(weapons - on)))
check(all(t["purchaseCost"] == 2500 and t["purchasable"] for t in mist), "Necro Mist camo price")
check(all(t["displayName"].startswith("Necro Mist ") for t in mist), "Necro Mist camo names")
ok("camos: %d Necro Mist skins = %d colours x %d weapons, one key per colour"
   % (len(mist), len(mist_keys), len(weapons)))

# camo skin packages point at their camo texture
for t in mist[:: max(1, len(mist) // 20)]:
    data, up = load(t["asset"])
    tex = text(tags(up)["Camo"][1])
    check(tex.split(".")[0].endswith("Camo_XP_" + key(t)), "%s: camo texture %s" % (t["asset"], tex))
    load(tex)
ok("camo skins sampled: packages parse and use their Necro Mist texture")

# ---- data assets
stock_fog = eye.expression_params(eye.find_in_paks(PAKS, {eye.NECRO_MIST})[eye.NECRO_MIST]) if PAKS else None
stock_mesh = eye.find_in_paks(PAKS, {eye.SKULL_MESH})[eye.SKULL_MESH] if PAKS else None
stock_bc = (np.asarray(cooked_texture.decode_top(eye.find_in_paks(PAKS, {eye.NECRO_BC})[eye.NECRO_BC])
                       .convert("RGB").resize((1024, 1024)), np.float32) if PAKS else None)
by_tid = {t["tid"]: t for t in items}
for i, (label, color) in enumerate(eye.PALETTE):
    c = np.array(color)
    tints = set()
    for piece, stock_name, prefix, first, price, name_fmt in eye.PIECES:
        t = by_tid[first + i]
        data, up = load(t["asset"])
        tg = tags(up)
        check(text(tg["ItemID"][1]) == str(t["tid"]), "%s: ItemID" % t["asset"])
        check(text(tg["ItemDisplayName"][1]) == t["displayName"] == name_fmt % label, "%s: name" % t["asset"])
        check(struct.unpack("<f", tg["PurchaseCost"][1])[0] == t["purchaseCost"] == price, "%s: price" % t["asset"])
        check(not (set(tg) & {"bIsPremiumPurchasable", "PremiumPurchaseCost", "StoreCategory"}),
              "%s: premium store tags left" % t["asset"])
        check("bIsPurchasable" in tg, "%s: bIsPurchasable" % t["asset"])
        tints.add(tuple(struct.unpack("<4f", tg[n][1]) for n in ("PrimaryColor", "SecondaryColor", "TertiaryColor")))

        if piece == "mask":
            mesh_path = text(tg["Mesh"][1])
            check(mesh_path.startswith(eye.FOLDER), "%s: mesh %s" % (t["asset"], mesh_path))
            mdata, mup = load(mesh_path)
            mats = [(cls, obj, pkg) for cls, obj, pkg in imports(mup) if "Material" in cls]
            mic = [m for m in mats if m[1].startswith("MI_EyeMist")]
            check(len(mic) == 1 and mic[0][0] == "MaterialInstanceConstant", "%s: eye import %s" % (mesh_path, mats))
            check(not any(m[1] == "M_NecroMist" for m in mats), "%s still imports M_NecroMist" % mesh_path)
            if stock_mesh:
                a = UPackage(stock_mesh)
                check(len(mdata) == len(stock_mesh) and [e["fields"][7:9] for e in a.exports]
                      == [e["fields"][7:9] for e in mup.exports], "%s: layout differs from the stock mesh" % mesh_path)
            _, iup = load(mic[0][2])
            parent = [(cls, obj) for cls, obj, _ in imports(iup)][1]
            check(parent == ("Material", "M_NecroMist"), "%s: parent %s" % (mic[0][2], parent))
            v = vectors(iup)
            check(set(v) == {("Fog Tint", 0), ("Fog Tint", 2)}, "%s: parameters %s" % (mic[0][2], sorted(v)))
            check(close(v[("Fog Tint", 0)][1], tuple(c * 2) + (1,)) and close(v[("Fog Tint", 2)][1], tuple(c * 5) + (1,)),
                  "%s: Fog Tint values" % mic[0][2])
            if stock_fog:
                check(all(v[k][0] == stock_fog[k] for k in v), "%s: GUIDs differ from M_NecroMist" % mic[0][2])
        if piece == "mask":
            check("BaseColor" in tg, "%s: no hood BaseColor override" % t["asset"])
            tex = text(tg["BaseColor"][1])
            tdata, _ = load(tex)
            img = np.asarray(cooked_texture.decode_top(tdata).convert("RGB"), np.float32)
            check(img.shape[:2] == (1024, 1024), "%s: size %s" % (tex, img.shape))
            mean = img.reshape(-1, 3).mean(0)
            want = int(np.argmax(c)) if c.max() - c.min() > 0.3 else None
            check(want is None or int(np.argmax(mean)) == want, "%s: mean colour %s is not %s" % (tex, mean, label))
            if stock_bc is not None:
                bone = (slice(40, 400), slice(560, 980))           # the skull's face in the atlas
                diff = np.abs(img[bone] - stock_bc[bone]).mean()
                check(diff < 25, "%s: the skull's bone changed (mean %.1f)" % (tex, diff))
        elif piece in ("top", "topF"):
            mi = text(tg["MaterialInstance"][1])
            _, iup = load(mi)
            parent = imports(iup)[1]
            check(parent[:2] == ("MaterialInstanceConstant", "MI_Top_Necro"), "%s: parent %s" % (mi, parent))
            v = vectors(iup)
            check(list(v) == [("Emissive Color", 0)], "%s: parameters %s" % (mi, list(v)))
            rgb = np.array(v[("Emissive Color", 0)][1][:3])
            check(np.allclose(rgb / rgb.max(), c / c.max(), atol=1e-3), "%s: Emissive Color %s" % (mi, rgb))
    check(len(tints) == 1, "%s: pieces have different tints" % label)
ok("data assets, meshes, materials and skull-hood textures for %d colours" % len(eye.PALETTE)
   + ("" if PAKS else " (no Paks dir: stock layout and GUID checks skipped)"))

# ---- registry
reg = os.path.join(HERE, "registry", "eye_skins.bin")
check(os.path.exists(reg), "missing " + reg)
blob = open(reg, "rb").read()
check(struct.unpack_from("<i", blob, 0)[0] == len(items), "registry count")
for t in items:
    check(("%s.%s" % (t["asset"], t["asset"].rsplit("/", 1)[1])).encode() in blob, "registry lacks " + t["asset"])
ok("registry: %d records" % len(items))

print("%d checks passed" % passed)
