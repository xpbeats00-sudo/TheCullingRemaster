"""Weapon balance: applies a table of stat changes to the cooked weapons.

The table (JSON) lists changes, each one stored value of one weapon asset:

    {"changes": [
      {"weapon": "WeapYari", "export": "CDO", "property": "WeaponConfig.PierceValueMin",
       "from": 4.0, "to": 4.5, "reason": "why"}
    ]}

- weapon: the asset's name under Victory/Content/Blueprints/Weapons (or a full
  "Victory/Content/..." path);
- export: "CDO" (the class defaults, Default__WeapYari_C), a fire mode or
  launch by the name the defaults use for it ("PrimaryMode", "SecondaryMode",
  "InstantLaunch", "ThrowModeCharged"...), or an export's own name;
- property: the value's path as weapon_stats.py prints it (MeleeConfig.DamageMax,
  ChargeConfig.StaminaBaseCost, WeaponConfig.WoundsToAdd[1].bBlockable, ThrowSpin.Z);
- from: the stock value. The run stops if the game's value isn't this, so a
  table written against other data is never applied blind;
- to: the new value; reason: required, the design reason.

Only values the asset stores can change, in place (int, float, bool, byte:
the package keeps its size and layout). A value the asset doesn't store is
the native parent's C++ default; adding it would mean adding a property
tag, which this refuses rather than guess at.

A change to a melee weapon's damage, throw damage or speed also rewrites its
HUD tooltip ("Damage: 8-24 / Throw: 8-24 / Normal Speed",
uiresources/Localization/hud.json), so the game never shows stale numbers; the
stock tooltip has to match the stock data first.

Each run starts from the stock paks (never the patch pak), checks every
patched package (only the intended values differ, it re-saves byte for byte
through ue_package.UPackage), writes them to patch/src and records what it
did in patch/balance/weapon_balance_applied.json: each change's original and
new value and reason, and the files written. Files a previous run wrote that
this one doesn't are deleted, so an emptied table leaves the stock weapons.

The table shipped is patch/balance/weapon_balance.json, empty. The proposed
Tier 3 pass is patch/balance/weapon_tier3_proposal.json, NOT applied until
someone approves it (docs/WEAPON_TIER_3_BALANCE.md).

usage: python make_weapon_balance.py [Paks dir] [--table FILE] [--dry-run]
  --dry-run   check the table against the game and print the changes; write nothing
"""
import argparse
import json
import os
import re
import struct
import sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import weapon_stats as ws  # noqa: E402
from stock_paks import paks_dir, read_stock  # noqa: E402
from uasset import Package  # noqa: E402
from ue_package import UPackage  # noqa: E402

SRC = os.path.join(HERE, "src")
BALANCE = os.path.join(HERE, "balance")
TABLE = os.path.join(BALANCE, "weapon_balance.json")
PROPOSAL = os.path.join(BALANCE, "weapon_tier3_proposal.json")
RECORD = os.path.join(BALANCE, "weapon_balance_applied.json")
WEAPONS_DIR = "Victory/Content/Blueprints/Weapons/"
WRITABLE = {"int", "float", "bool", "byte"}
TOOLTIP_PATHS = {"MeleeConfig.DamageMin", "MeleeConfig.DamageMax", "ThrowConfig.LightThrowDamage",
                 "ThrowConfig.HeavyThrowDamage", "WeaponConfig.SpeedModifier"}
FLOAT_TOLERANCE = 1e-4


class BalanceError(Exception):
    pass


def load_table(path):
    with open(path, encoding="utf-8") as f:
        table = json.load(f, object_pairs_hook=OrderedDict)
    changes = table.get("changes")
    if not isinstance(changes, list):
        raise BalanceError("%s: no \"changes\" list" % path)
    seen = set()
    for i, c in enumerate(changes):
        missing = [k for k in ("weapon", "export", "property", "from", "to", "reason") if k not in c]
        if missing:
            raise BalanceError("%s change %d: missing %s" % (path, i, ", ".join(missing)))
        if not str(c["reason"]).strip():
            raise BalanceError("%s change %d: a reason is required" % (path, i))
        key = (c["weapon"], c["export"], c["property"])
        if key in seen:
            raise BalanceError("%s: %s.%s.%s changed twice" % ((path,) + key))
        seen.add(key)
    return table


def asset_path(weapon):
    if "/" in weapon:
        return weapon if weapon.endswith(".uasset") else weapon + ".uasset"
    return WEAPONS_DIR + weapon + ".uasset"


def _export_name(pkg, cdo_leaves, cdo, export):
    if export == "CDO":
        return cdo
    names = [e["name"] for e in pkg.exports]
    if export in names:
        return export
    v = cdo_leaves.get(export)
    if v and v[0] == "object" and v[2] in names:
        return v[2]
    raise BalanceError("no export %r (not CDO, a subobject the defaults name, or an export)" % export)


def _same(kind, a, b):
    if kind == "float":
        return abs(float(a) - float(b)) <= FLOAT_TOLERANCE * max(1.0, abs(float(b)))
    if kind == "bool":
        return bool(a) == b if isinstance(b, bool) else False
    return a == b


def _encode(kind, value, where):
    if kind == "float":
        if isinstance(value, bool) or not isinstance(value, (int, float)):
            raise BalanceError("%s: %r is not a number" % (where, value))
        return struct.pack("<f", float(value))
    if kind == "int":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or int(value) != value:
            raise BalanceError("%s: %r is not an integer" % (where, value))
        return struct.pack("<i", int(value))
    if kind == "byte":
        if isinstance(value, bool) or not isinstance(value, int) or not 0 <= value <= 255:
            raise BalanceError("%s: %r is not a byte" % (where, value))
        return bytes([value])
    if kind == "bool":
        if not isinstance(value, bool):
            raise BalanceError("%s: %r is not true/false" % (where, value))
        return bytes([1 if value else 0])
    raise BalanceError("%s: a %s value can't be changed here" % (where, kind))


def all_leaves(data):
    pkg = Package(data)
    return {(e["name"], path): (kind, off, v) for e in pkg.exports
            for path, kind, off, v in ws.leaves(pkg, e["offset"], e["offset"] + e["size"])}


def patch_asset(rel, data, changes):
    """The patched bytes and a row per change; checks the result."""
    pkg = Package(data)
    cdo = next((e["name"] for e in pkg.exports if e["name"].startswith("Default__")), None)
    if cdo is None:
        raise BalanceError("%s has no class defaults" % rel)
    cdo_leaves = ws.export_leaves(pkg, cdo)
    out = bytearray(data)
    rows, slots, intended = [], [], set()
    for c in changes:
        where = "%s %s.%s" % (os.path.basename(rel), c["export"], c["property"])
        export = _export_name(pkg, cdo_leaves, cdo, c["export"])
        leaves = ws.export_leaves(pkg, export)
        if c["property"] not in leaves:
            close = [p for p in leaves if p.split(".")[-1] == c["property"].split(".")[-1]]
            raise BalanceError("%s is not stored in the asset (its value is the parent's default; only stored values "
                               "can change)%s" % (where, "; stored: " + ", ".join(close) if close else ""))
        kind, off, old = leaves[c["property"]]
        if kind not in WRITABLE:
            raise BalanceError("%s is a %s value: only int, float, bool and byte values can change" % (where, kind))
        if not _same(kind, old, c["from"]):
            raise BalanceError("%s is %r in the game, the table says from %r: the table is stale" % (where, old, c["from"]))
        new = _encode(kind, c["to"], where)
        out[off:off + len(new)] = new
        slots.append((off, len(new)))
        intended.add((export, c["property"]))
        rows.append(OrderedDict([("asset", rel), ("export", export), ("property", c["property"]), ("kind", kind),
                                 ("original", ws._round(old) if kind == "float" else old),
                                 ("new", c["to"]), ("reason", c["reason"])]))
    out = bytes(out)
    verify(rel, data, out, slots, intended)
    return out, rows


def verify(rel, old, new, slots, intended):
    """Only the intended values changed, and the package re-saves byte for byte."""
    if len(old) != len(new):
        raise BalanceError("%s changed size" % rel)
    for i in range(len(old)):
        if old[i] != new[i] and not any(o <= i < o + n for o, n in slots):
            raise BalanceError("%s: byte %d changed outside the patched values" % (rel, i))
    if UPackage(new).save() != new:
        raise BalanceError("%s does not re-save byte for byte" % rel)
    a, b = all_leaves(old), all_leaves(new)
    if set(a) != set(b):
        raise BalanceError("%s: the patched package's properties differ" % rel)
    changed = {k for k in a if a[k][2] != b[k][2]}
    if changed - intended:
        raise BalanceError("%s: unintended changes %s" % (rel, sorted(changed - intended)))


# ---- tooltips --------------------------------------------------------------

def _tooltip_text(stats, old_text):
    text = old_text
    lo, hi = stats["damage"]
    text = ws.TOOLTIP_DAMAGE.sub("Damage: %s-%s" % (_num(lo), _num(hi)), text, count=1)
    lo, hi = stats["throw"]
    text = ws.TOOLTIP_THROW.sub("Throw: %s-%s" % (_num(lo), _num(hi)), text, count=1)
    if stats["speed"] is None:
        raise BalanceError("SpeedModifier has no tooltip word (only %s)" % ", ".join("%g" % s for s in ws.SPEED_WORDS))
    return ws.TOOLTIP_SPEED.sub(stats["speed"] + " Speed", text, count=1)


def _num(v):
    if abs(v - round(v)) > 1e-6:
        raise BalanceError("tooltips show whole numbers; %r isn't one" % v)
    return str(int(round(v)))


def tooltips(paks, records_before, records_after):
    """The patched hud.json bytes and a row per tooltip, or (None, [])."""
    raw, loc = ws.read_hud_loc(paks)
    text, rows = raw.decode("utf-8"), []
    for name, before in records_before.items():
        after = records_after[name]
        old_stats, new_stats = ws.melee_tooltip_stats(before), ws.melee_tooltip_stats(after)
        if old_stats == new_stats:
            continue
        key = before["hudKey"]
        item = loc["items"].get(key) if key else None
        if not item:
            raise BalanceError("%s: no HUD tooltip (hud.json items.%s) to update" % (name, key))
        old_text = item["tooltip_text"]["en"]
        shown = ws.parse_tooltip(old_text)
        if (shown["damage"], shown["throw"], shown["speed"]) != (old_stats["damage"], old_stats["throw"], old_stats["speed"]):
            raise BalanceError("%s: the stock tooltip %r doesn't match the stock data %r; not touching it" % (name, shown, dict(old_stats)))
        new_text = _tooltip_text(new_stats, old_text)
        start = text.index('"items"')
        k = text.index('"%s"' % key, start)
        t = text.index('"tooltip_text"', k)
        old_enc, new_enc = json.dumps(old_text), json.dumps(new_text)
        e = text.index(old_enc, t)
        if e - k > 400:
            raise BalanceError("%s: tooltip text not found next to items.%s" % (name, key))
        text = text[:e] + new_enc + text[e + len(old_enc):]
        rows.append(OrderedDict([("hudKey", key), ("original", old_text), ("new", new_text)]))
    if not rows:
        return None, []
    patched = text.encode("utf-8")
    json.loads(patched)                       # still valid JSON
    return patched, rows


# ---- run -------------------------------------------------------------------

def _previous(record):
    if not os.path.exists(record):
        return []
    with open(record, encoding="utf-8") as f:
        return json.load(f).get("files", [])


def apply(paks, table_path=TABLE, src=SRC, record=RECORD, dry_run=False, log=print):
    table = load_table(table_path)
    by_asset = OrderedDict()
    for c in table["changes"]:
        by_asset.setdefault(asset_path(c["weapon"]), []).append(c)
    stock = read_stock(paks, set(by_asset))
    missing = sorted(set(by_asset) - set(stock))
    if missing:
        raise BalanceError("not in the game's paks: %s" % ", ".join(missing))

    outputs, rows, before, after = OrderedDict(), [], OrderedDict(), OrderedDict()
    for rel, changes in by_asset.items():
        patched, asset_rows = patch_asset(rel, stock[rel], changes)
        outputs[rel] = patched
        rows += asset_rows
        if any(c["property"] in TOOLTIP_PATHS for c in changes):
            rb, ra = ws.weapon_record(rel, stock[rel]), ws.weapon_record(rel, patched)
            if ws.is_tiered_melee(rb):
                before[rel], after[rel] = rb, ra
    tip_rows = []
    if before:
        hud, tip_rows = tooltips(paks, before, after)
        if hud is not None:
            outputs[ws.HUD_LOC] = hud

    for r in rows:
        log("  %-28s %-14s %-40s %s -> %s" % (os.path.basename(r["asset"]), r["export"][:14], r["property"], r["original"], r["new"]))
    for r in tip_rows:
        log("  tooltip %-20s %r -> %r" % (r["hudKey"], r["original"], r["new"]))
    if dry_run:
        log("dry run: %d change(s) checked, nothing written" % len(rows))
        return rows, tip_rows

    previous = set(_previous(record))
    for rel in outputs:
        path = os.path.join(src, rel)
        if os.path.exists(path) and rel not in previous:
            raise BalanceError("%s exists and another generator wrote it; not overwriting" % path)
    for rel, data in outputs.items():
        path = os.path.join(src, rel)
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as f:
            f.write(data)
    for rel in sorted(previous - set(outputs)):
        path = os.path.join(src, rel)
        if os.path.exists(path):
            os.remove(path)
            log("  removed %s (no longer in the table)" % rel)
    with open(record, "w", newline="\n", encoding="utf-8") as f:
        json.dump(OrderedDict([("source", "patch/make_weapon_balance.py"), ("table", os.path.basename(table_path)),
                               ("changes", rows), ("tooltips", tip_rows), ("files", sorted(outputs))]), f, indent=1)
        f.write("\n")
    log("%d change(s) in %d asset(s)%s -> %s" % (len(rows), len(by_asset), ", tooltips updated" if tip_rows else "",
                                                 os.path.relpath(record, HERE)))
    return rows, tip_rows


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("paks", nargs="?")
    ap.add_argument("--table", default=TABLE)
    ap.add_argument("--dry-run", action="store_true")
    args = ap.parse_args(argv)
    try:
        apply(paks_dir(args.paks), args.table, dry_run=args.dry_run)
    except BalanceError as e:
        sys.exit("make_weapon_balance: " + str(e))


if __name__ == "__main__":
    main()
