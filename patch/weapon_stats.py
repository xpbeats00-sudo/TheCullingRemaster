"""Every weapon's stats, read from the game's cooked Blueprints.

The weapons are Blueprint classes (Blueprints/Weapons/Weap*.uasset) under
native parents (Weapon_Melee, Weapon_Bow, ShooterWeapon_Instant...). A cooked
Blueprint only stores the values that differ from its parent, so a value the
asset doesn't store is the parent's: for a native parent that is a C++
default, which the cooked data doesn't hold. This module reports such values
as "not stored" rather than guessing them.

What is read, per weapon asset:
- the class default object (Default__WeapX_C): MeleeConfig (damage), WeaponConfig
  (ammo, trace radius, move speed, wounds), ThrowConfig, BowConfig and
  InstantConfig (ranged damage, spread), interrupt durations (recovery), shove,
  RecycleValue, BotWeaponScore, MeleeWeaponType, DisplayCategory;
- its fire modes and launches (the subobjects the default object points at:
  PrimaryMode, SecondaryMode = block or aim, ThrowModeCharged, ShoveMode,
  InstantLaunch, ProjectileLaunch, ReloadMode...): charge times, stamina costs,
  block angle and stamina, reach (InstantConfig.WeaponRange), burst timing;
- its UsableComponent (UsableItemName, which carries the tier: "Katana (Tier 4)").
Projectiles (Proj*.uasset) and deployables (Dep*.uasset) are read the same way.

leaves() walks a tagged property list and yields every scalar it stores with
its byte offset, which make_weapon_balance.py uses to change values in place.

usage: python weapon_stats.py [Paks dir]   (writes patch/balance/weapon_stats.json
                                            and the audit tables in docs/WEAPON_TIER_3_BALANCE.md)
"""
import json
import os
import re
import struct
import sys
from collections import OrderedDict

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_catalog import pak_entries, read_entry  # noqa: E402
from stock_paks import paks_dir, read_stock, stock_paks  # noqa: E402
from uasset import Package  # noqa: E402
from uasset_tree import clean  # noqa: E402
from ue_package import UPackage  # noqa: E402

OUT_JSON = os.path.join(HERE, "balance", "weapon_stats.json")
WEAPON_ASSET = re.compile(r"Victory/Content/Blueprints/Weapons/(Weap|Proj|Dep)[A-Za-z0-9_]*\.uasset$")
# Structs stored as raw bytes rather than tagged properties.
BINARY_STRUCTS = {"Guid", "Color", "LinearColor", "Vector2D", "IntPoint", "Vector4", "Quat", "Box", "Transform"}
VECTOR_STRUCTS = {"Vector": "XYZ", "Rotator": "PYR"}   # Rotator is stored pitch, yaw, roll
# Subobject classes that hold weapon stats.
STAT_SUBOBJECTS = re.compile(r"^(WeaponFire|VictoryProjectileMovementComponent|ProjectileMovementComponent|UsableComponent)")


class _P:
    def __init__(self, pkg):
        self.pkg, self.d = pkg, pkg.data

    def fname(self, p):
        i, n = struct.unpack_from("<ii", self.d, p)
        s = self.pkg.names[i]
        return (s if n == 0 else "%s_%d" % (s, n - 1)), p + 8


def leaves(pkg, start, end, prefix=""):
    """Yield (path, kind, offset, value) for every value stored in the tagged
    property list at [start, end). kind is int, float, bool, byte (writable in
    place), or enum, name, str, object, other (read-only here). A bool's value
    is the tag's own byte, so its offset points there. Struct members and
    array elements get dotted / indexed paths: MeleeConfig.DamageMax,
    WeaponConfig.WoundsToAdd[1].bBlockable, ThrowSpin.Z."""
    out = []
    _walk(pkg, _P(pkg), start, end, prefix, out)
    return iter(out)


def _walk(pkg, r, p, end, prefix, out):
    """Append the leaves of the property list at p to out; return the offset
    just past its terminating None."""
    d = pkg.data
    while p < end:
        name, p = r.fname(p)
        if name == "None":
            return p
        ptype, p = r.fname(p)
        size, idx = struct.unpack_from("<ii", d, p)
        p += 8
        extra, bool_at = None, None
        if ptype == "StructProperty":
            extra, p = r.fname(p)
            p += 16
        elif ptype == "BoolProperty":
            bool_at = p
            extra = d[p]
            p += 1
        elif ptype in ("ByteProperty", "EnumProperty", "ArrayProperty", "SetProperty"):
            extra, p = r.fname(p)
        elif ptype == "MapProperty":
            p += 16
        p += 1 + (16 if d[p] else 0)
        path = prefix + clean(name) + ("[%d]" % idx if idx else "")
        _value(pkg, r, path, ptype, p, size, extra, bool_at, out)
        p += size
    return p


def _value(pkg, r, path, ptype, p, size, extra, bool_at, out):
    d = pkg.data
    add = lambda path, kind, off, v: out.append((path, kind, off, v))
    if ptype == "IntProperty":
        add(path, "int", p, struct.unpack_from("<i", d, p)[0])
    elif ptype == "FloatProperty":
        add(path, "float", p, struct.unpack_from("<f", d, p)[0])
    elif ptype == "BoolProperty":
        add(path, "bool", bool_at, bool(extra))
    elif ptype == "ByteProperty" and size == 1:
        add(path, "byte", p, d[p])
    elif ptype in ("ByteProperty", "EnumProperty"):
        add(path, "enum", p, r.fname(p)[0])
    elif ptype == "NameProperty":
        add(path, "name", p, r.fname(p)[0])
    elif ptype == "StrProperty":
        n = struct.unpack_from("<i", d, p)[0]
        s = d[p + 4:p + 4 + n - 1].decode("latin1") if n >= 0 else d[p + 4:p + 4 - 2 * n - 2].decode("utf-16le")
        add(path, "str", p, s)
    elif ptype in ("ObjectProperty", "ClassProperty"):
        add(path, "object", p, _ref(pkg, struct.unpack_from("<i", d, p)[0]))
    elif ptype == "StructProperty":
        if extra in VECTOR_STRUCTS:
            for i, axis in enumerate(VECTOR_STRUCTS[extra]):
                add("%s.%s" % (path, axis), "float", p + 4 * i, struct.unpack_from("<f", d, p + 4 * i)[0])
        elif extra in BINARY_STRUCTS:
            add(path, "other", p, d[p:p + size].hex())
        else:
            _walk(pkg, r, p, p + size, path + ".", out)
    elif ptype == "ArrayProperty":
        n = struct.unpack_from("<i", d, p)[0]
        q = p + 4
        if extra == "StructProperty":
            _, q = r.fname(q)                       # inner tag: name, type, size, index, struct name, guid, has-guid
            _, q = r.fname(q)
            q += 8
            sname, q = r.fname(q)
            q += 16 + 1
            for i in range(n):
                if sname in VECTOR_STRUCTS:
                    for j, axis in enumerate(VECTOR_STRUCTS[sname]):
                        add("%s[%d].%s" % (path, i, axis), "float", q + 4 * j, struct.unpack_from("<f", d, q + 4 * j)[0])
                    q += 12
                elif sname in BINARY_STRUCTS:
                    add(path, "other", p, "[%d x %s]" % (n, sname))
                    break
                else:
                    q = _walk(pkg, r, q, p + size, "%s[%d]." % (path, i), out)
        elif extra in ("FloatProperty", "IntProperty", "ObjectProperty", "NameProperty"):
            for i in range(n):
                ipath = "%s[%d]" % (path, i)
                if extra == "FloatProperty":
                    add(ipath, "float", q, struct.unpack_from("<f", d, q)[0]); q += 4
                elif extra == "IntProperty":
                    add(ipath, "int", q, struct.unpack_from("<i", d, q)[0]); q += 4
                elif extra == "ObjectProperty":
                    add(ipath, "object", q, _ref(pkg, struct.unpack_from("<i", d, q)[0])); q += 4
                else:
                    add(ipath, "name", q, r.fname(q)[0]); q += 8
        else:
            add(path, "other", p, "[%d x %s]" % (n, extra))
    else:
        add(path, "other", p, "<%s %d bytes>" % (ptype, size))


def _ref(pkg, i):
    try:
        r = pkg.ref(i)
    except IndexError:
        return "obj%d" % i
    if isinstance(r, dict):
        return r["name"]
    return r or "None"


def export_leaves(pkg, export_name):
    e = pkg.export(export_name)
    return OrderedDict((path, (kind, off, value)) for path, kind, off, value in
                       leaves(pkg, e["offset"], e["offset"] + e["size"]))


def parent_class(pkg, cls_export):
    """The super class name of a Blueprint class export."""
    up = UPackage(pkg.data)
    return _ref(pkg, up.exports[up.find_export(cls_export) - 1]["fields"][1])


def tier_of(item_name, loc_desc):
    m = re.search(r"Tier (\d)", item_name or "") or re.search(r"Tier (\d)", loc_desc or "")
    return int(m.group(1)) if m else None


def weapon_record(rel, data, loc=None):
    """Everything the asset stores about one weapon, projectile or deployable."""
    pkg = Package(data)
    base = os.path.splitext(os.path.basename(rel))[0]
    cdo = next(e["name"] for e in pkg.exports if e["name"].startswith("Default__"))
    cls = cdo[len("Default__"):]
    cdo_leaves = export_leaves(pkg, cdo)
    exports = OrderedDict([(cdo, OrderedDict([("role", "CDO"), ("class", cls), ("values", cdo_leaves)]))])
    # The subobjects the default object points at (PrimaryMode -> its export).
    roles = {}
    for path, (kind, off, value) in cdo_leaves.items():
        if kind == "object" and "." not in path and "[" not in path:
            roles.setdefault(value, path)
    for e in pkg.exports:
        ecls = _ref(pkg, e["class"])
        if e["name"] == cdo or not STAT_SUBOBJECTS.match(str(ecls)):
            continue
        exports[e["name"]] = OrderedDict([("role", roles.get(e["name"], e["name"])), ("class", ecls),
                                          ("values", export_leaves(pkg, e["name"]))])
    usable = next((x for x in exports.values() if x["class"] == "UsableComponent"), None)
    item_name = usable["values"].get("UsableItemName", (None, None, None))[2] if usable else None
    key = cls[:-2].lower() if cls.endswith("_C") else cls.lower()
    text = (loc or {}).get(key) or {}
    desc = (text.get("description") or {}).get("en", "") if isinstance(text, dict) else ""
    name_en = text.get("en") if isinstance(text, dict) else None
    get = lambda p: cdo_leaves.get(p, (None, None, None))[2]
    return OrderedDict([
        ("asset", rel), ("file", base), ("class", cls), ("parent", parent_class(pkg, cls)),
        ("name", item_name or name_en or base), ("tier", tier_of(item_name, desc)),
        ("meleeType", (get("MeleeWeaponType") or "").replace("EMeleeWeaponType::", "") or None),
        ("displayCategory", get("DisplayCategory")), ("animType", (get("WeaponAnimType") or "").replace("EWeaponAnimType::", "") or None),
        ("description", re.sub(r"<br>|\s+", " ", desc).strip()),
        ("hudKey", (get("DisplayName") or "").lower() or None),
        ("exports", exports),
    ])


def read_loc(paks):
    for pak in stock_paks(paks):
        for f, name, off, usize, method, blocks in pak_entries(pak):
            if name.endswith("uiresources/Localization/FrontEnd.json"):
                return json.loads(read_entry(f, off, usize, method, blocks).decode("utf-8-sig"))["items"]
    return {}


def read_all(paks):
    loc = read_loc(paks)
    assets = read_stock(paks, WEAPON_ASSET)
    return [weapon_record(rel, data, loc) for rel, data in sorted(assets.items())], assets


def as_json(records):
    """The records without byte offsets: {export: {role, class, values: {path: value}}}."""
    out = []
    for r in records:
        r2 = OrderedDict((k, v) for k, v in r.items() if k != "exports")
        r2["exports"] = OrderedDict(
            (name, OrderedDict([("role", x["role"]), ("class", x["class"]),
                                ("values", OrderedDict((p, _round(v)) for p, (k, o, v) in x["values"].items()))]))
            for name, x in r["exports"].items())
        out.append(r2)
    return out


def _round(v):
    return round(v, 4) if isinstance(v, float) else v


# ---- values a melee weapon doesn't store ---------------------------------
#
# Weapon_Melee's C++ defaults aren't in the cooked data, but the HUD tooltips
# (uiresources/Localization/hud.json, "Damage: 7-25 / Throw: 7-25 / Slow Speed")
# show the values the game uses, and they pin down the four a tiered melee
# weapon may leave out: the Pipe Wrench and Survival Spear store no DamageMax
# and their tooltips say 25; the Katana stores no DamageMin or LightThrowDamage
# and its tooltip says 10-26 / 10-26; a weapon with no SpeedModifier says
# "Normal Speed" (stored 1.15 is "Fast", 0.85 "Slow"). test_weapon_balance.py
# checks every tiered melee tooltip against the cooked data and these.
MELEE_INFERRED = OrderedDict([("MeleeConfig.DamageMin", 10.0), ("MeleeConfig.DamageMax", 25.0),
                              ("ThrowConfig.LightThrowDamage", 10.0), ("WeaponConfig.SpeedModifier", 1.0)])
SPEED_WORDS = OrderedDict([(1.15, "Fast"), (1.0, "Normal"), (0.85, "Slow")])
HUD_LOC = "Victory/Content/uiresources/Localization/hud.json"


def cdo_values(rec):
    return next(x["values"] for x in rec["exports"].values() if x["role"] == "CDO")


def role_values(rec, role):
    for x in rec["exports"].values():
        if x["role"] == role:
            return x["values"]
    return None


def value(rec, role, path):
    """(value, how): how is "stored", "inferred" (MELEE_INFERRED) or None (not stored)."""
    vals = role_values(rec, role)
    if vals is not None and path in vals:
        v = vals[path]
        return (v[2] if isinstance(v, tuple) else v), "stored"
    if role == "CDO" and rec["parent"] == "Weapon_Melee" and path in MELEE_INFERRED:
        return MELEE_INFERRED[path], "inferred"
    return None, None


def melee_tooltip_stats(rec):
    """What the HUD tooltip of a melee weapon should say, from the data."""
    g = lambda p: value(rec, "CDO", p)[0]
    speed = g("WeaponConfig.SpeedModifier")
    word = next((w for s, w in SPEED_WORDS.items() if abs(s - speed) < 1e-4), None)
    return OrderedDict([("damage", (g("MeleeConfig.DamageMin"), g("MeleeConfig.DamageMax"))),
                        ("throw", (g("ThrowConfig.LightThrowDamage"), g("ThrowConfig.HeavyThrowDamage"))),
                        ("speed", word)])


TOOLTIP_DAMAGE = re.compile(r"Damage: (\d+)-(\d+)")
TOOLTIP_THROW = re.compile(r"Throw: (\d+)-(\d+)")
TOOLTIP_SPEED = re.compile(r"\b(Fast|Normal|Slow) Speed\b")


def parse_tooltip(text):
    d, t, s = TOOLTIP_DAMAGE.search(text), TOOLTIP_THROW.search(text), TOOLTIP_SPEED.search(text)
    return OrderedDict([("damage", (float(d.group(1)), float(d.group(2))) if d else None),
                        ("throw", (float(t.group(1)), float(t.group(2))) if t else None),
                        ("speed", s.group(1) if s else None)])


def read_hud_loc(paks):
    raw = read_stock(paks, {HUD_LOC})[HUD_LOC]
    return raw, json.loads(raw.decode("utf-8-sig"))


def is_tiered_melee(rec):
    return rec["parent"] == "Weapon_Melee" and rec["tier"] is not None


# ---- the audit tables -----------------------------------------------------

DOC = os.path.join(HERE, "..", "docs", "WEAPON_TIER_3_BALANCE.md")
BEGIN, END = "<!-- BEGIN weapon_stats.py tables -->", "<!-- END weapon_stats.py tables -->"
NS = "·"          # not stored: the native parent's default, not in the data


def _fmt(v, how=None):
    if v is None:
        return NS
    if isinstance(v, bool):
        return "yes" if v else "no"
    if isinstance(v, float):
        v = round(v, 4)
        s = ("%.4f" % v).rstrip("0").rstrip(".")
    else:
        s = str(v)
    return s + ("†" if how == "inferred" else "")


def _v(rec, role, path):
    return _fmt(*value(rec, role, path))


def _pair(rec, role, a, b, sep="-"):
    x, y = _v(rec, role, a), _v(rec, role, b)
    return NS if x == NS and y == NS else "%s%s%s" % (x, sep, y)


def _wounds(rec, prefix):
    vals = cdo_values(rec)
    out = []
    for p, v in vals.items():
        if p.startswith(prefix) and p.endswith(".WoundClass"):
            out.append(str(v[2] if isinstance(v, tuple) else v).replace("BP_", "").replace("_C", ""))
    return ", ".join(out) or NS


def _label(rec):
    if rec["file"].startswith(("Dep", "Proj")):         # their item names are often copies ("Claymore")
        s = "`%s`" % rec["file"]
    else:
        s = "%s (`%s`)" % (re.sub(r" \(Tier \d\)$", "", rec["name"]), rec["file"])
    if (rec["parent"] or "").endswith("_C"):
        s += ", a copy of `%s` (blank: its values)" % rec["parent"][:-2]
    return s


def _speed(rec):
    v, how = value(rec, "CDO", "WeaponConfig.SpeedModifier")
    if v is None:
        return NS
    if not is_tiered_melee(rec):
        return _fmt(v, how)              # the uniques' tooltips don't follow SpeedModifier
    word = next((w for s, w in SPEED_WORDS.items() if abs(s - v) < 1e-4), "?")
    return "%s %s" % (_fmt(v, how), word)


def _table(head, rows):
    out = ["| " + " | ".join(head) + " |", "|" + "|".join("---" if i == 0 else "---:" for i in range(len(head))) + "|"]
    out += ["| " + " | ".join(r) + " |" for r in rows]
    return out + [""]


def tables(records):
    melee = [r for r in records if r["parent"] == "Weapon_Melee" or (r["file"].startswith("Weap") and
                                                                      r["parent"] in ("WeapCrowbar_C", "WeapSabre_C"))]
    order = {"Axe": 0, "Blade": 1, "Bludgeon": 2, "Spear": 3, "Fists": 4, None: 5}
    melee.sort(key=lambda r: (r["tier"] is None, order.get(r["meleeType"], 5), r["tier"] or 0, r["name"]))
    out = [BEGIN, "", "Generated by `python patch/weapon_stats.py <Paks dir>` from the stock cooked assets "
           "(every stored value of every weapon is also in `patch/balance/weapon_stats.json`).", "",
           "`%s` = not stored in the asset: the native parent class's C++ default, which the cooked data doesn't hold. "
           "`†` = not stored, but the HUD tooltip shows the value the game uses (see *Values the assets don't store*)." % NS, "",
           "**Durability**: no weapon asset stores a durability, health or break value, and `Victory.exe` has no "
           "property of that name: weapons in The Culling don't wear out. There is nothing to audit or tune.", "",
           "### Melee: tier, class, damage", ""]
    rows = []
    for r in melee:
        rows.append([_label(r), _fmt(r["tier"]), r["meleeType"] or NS, _speed(r),
                     _pair(r, "CDO", "MeleeConfig.DamageMin", "MeleeConfig.DamageMax"), _v(r, "CDO", "MeleeConfig.BackstabScalar"),
                     _pair(r, "CDO", "ThrowConfig.LightThrowDamage", "ThrowConfig.HeavyThrowDamage"),
                     _pair(r, "CDO", "WeaponConfig.PierceValueMin", "WeaponConfig.PierceValueMax"),
                     _wounds(r, "WeaponConfig.WoundsToAdd"), _v(r, "CDO", "RecycleValue"), _v(r, "CDO", "BotWeaponScore")])
    out += _table(["Weapon", "Tier", "Class", "Speed (SpeedModifier)", "Damage light-heavy", "Backstab x",
                   "Throw light-heavy", "Armor shred (Pierce)", "Wounds", "Recycle FUNC", "Bot score"], rows)
    out += ["### Melee: attack timing, stamina, reach", "",
            "Primary attack = `PrimaryMode` (WeaponFireMode_Charged): hold to charge, released before "
            "MinHeavyChargePct x MaxChargeTime it is a light attack, after it a heavy one. Reach = "
            "`InstantLaunch` InstantConfig.WeaponRange (cm) with a sweep of WeaponConfig.TraceRadius.", ""]
    rows = []
    for r in melee:
        rows.append([_label(r), _v(r, "PrimaryMode", "ChargeConfig.MaxChargeTime"), _v(r, "PrimaryMode", "ChargeConfig.MinHeavyChargePct"),
                     _v(r, "PrimaryMode", "ChargeConfig.LaunchDelay"), _v(r, "PrimaryMode", "ChargeConfig.TimeBetweenShots"),
                     _v(r, "CDO", "MeleeConfig.LaunchDuration"), _v(r, "CDO", "MeleeConfig.QueueWindowTime"),
                     _v(r, "PrimaryMode", "ChargeConfig.StaminaBaseCost"), _v(r, "PrimaryMode", "ChargeConfig.ChargeStaminaCostPerSec"),
                     _v(r, "PrimaryMode", "ChargeConfig.MaintenanceStaminaCostPerSec"),
                     _v(r, "InstantLaunch", "InstantConfig.WeaponRange"), _v(r, "CDO", "WeaponConfig.TraceRadius")])
    out += _table(["Weapon", "Charge time s", "Heavy at %", "Launch delay s", "Between attacks s", "Swing s (LaunchDuration)",
                   "Combo queue s", "Stamina per attack", "Stamina/s charging", "Stamina/s holding", "Reach cm", "Trace radius"], rows)
    out += ["### Melee: block, recovery, shove, throw", "",
            "Block = `SecondaryMode` (WeaponFireMode_Block). Recovery = how long the wielder is interrupted after a "
            "heavy hit lands on them, after their attack is blocked, after a failed shove (HeavyInterruptDuration, "
            "BlockedInterruptDuration, ShoveFailInterruptDuration).", ""]
    rows = []
    for r in melee:
        rows.append([_label(r), _v(r, "SecondaryMode", "BlockConfig.BlockAngle"), _v(r, "SecondaryMode", "BlockConfig.BlockStaminaCostPerHit"),
                     _v(r, "SecondaryMode", "BlockConfig.BlockStartTime"),
                     _pair(r, "SecondaryMode", "BlockConfig.BlockDamageMitigationBaseline", "BlockConfig.BlockDamageMitigationPerStep", " / "),
                     _v(r, "CDO", "HeavyInterruptDuration"), _v(r, "CDO", "BlockedInterruptDuration"), _v(r, "CDO", "ShoveFailInterruptDuration"),
                     _v(r, "CDO", "WeaponConfig.MinInterruptDuration"), _v(r, "CDO", "InterruptAttackForNextActionTime"),
                     _v(r, "CDO", "InterruptBlockForNextActionTime"),
                     _v(r, "CDO", "ShoveDamage"), _v(r, "CDO", "ShoveStaminaCost"),
                     _v(r, "ThrowModeCharged", "ChargeConfig.StaminaBaseCost"), _v(r, "ThrowModeCharged", "ChargeConfig.MaxChargeTime")])
    out += _table(["Weapon", "Block angle", "Block stamina/hit", "Block start s", "Block mitigation base / step",
                   "Heavy-hit recovery s", "Blocked recovery s", "Shove-fail recovery s", "Min interrupt s",
                   "Next action after attack interrupt s", "Next action after block interrupt s", "Shove dmg",
                   "Shove stamina", "Throw stamina", "Throw charge s"], rows)

    ranged = [r for r in records if r["file"].startswith("Weap") and r["parent"] in
              ("Weapon_Bow", "Weapon_Autobow", "ShooterWeapon_Instant")]
    out += ["### Ranged", "", "Bows: BowConfig.HitDamageMin-Max scales with draw; guns: InstantConfig.HitDamage per hit "
            "(the SMG stores none: native default). No ranged weapon has a tier; `make_airdrop_unlocks.py` rates them.", ""]
    rows = []
    for r in sorted(ranged, key=lambda r: (r["parent"], r["name"])):
        dmg = _pair(r, "CDO", "BowConfig.HitDamageMin", "BowConfig.HitDamageMax")
        if dmg == NS:
            dmg = _v(r, "CDO", "InstantConfig.HitDamage")
        head = _v(r, "CDO", "BowConfig.HeadshotScalar")
        if head == NS:
            head = _v(r, "CDO", "InstantConfig.HeadshotScalar")
        mit = _v(r, "CDO", "BowConfig.MaxMitigationAllowed")
        if mit == NS:
            mit = _v(r, "CDO", "InstantConfig.MaxMitigationAllowed")
        spread = _v(r, "CDO", "BowConfig.WeaponSpread")
        if spread == NS:
            spread = _v(r, "InstantLaunch", "InstantConfig.WeaponSpread")
        timing = _v(r, "PrimaryMode", "BurstConfig.TimeBetweenShots")
        if timing == NS:
            timing = "charge %s" % _v(r, "PrimaryMode", "ChargeConfig.MaxChargeTime")
        rows.append([_label(r), r["parent"], dmg, head, mit, spread, _v(r, "InstantLaunch", "InstantConfig.WeaponRange"),
                     "%s / %s / %s" % (_v(r, "CDO", "WeaponConfig.AmmoPerClip"), _v(r, "CDO", "WeaponConfig.MaxAmmo"),
                                       _v(r, "CDO", "WeaponConfig.InitialClips")),
                     timing, _v(r, "PrimaryMode", "ChargeConfig.StaminaBaseCost"), _v(r, "ReloadMode", "ReloadConfig.ReloadDelay"),
                     _pair(r, "CDO", "RecoilImpactTime", "RecoilRecoveryTime", " / "), _v(r, "SecondaryMode", "AimConfig.ZoomLevel"),
                     _v(r, "CDO", "ProjectileClass"), _v(r, "CDO", "RecycleValue")])
    out += _table(["Weapon", "Parent", "Damage", "Headshot x", "Max armor mitigation", "Spread", "Range cm",
                   "Clip / max / clips", "Fire timing s", "Stamina per shot", "Reload s", "Recoil s (impact / recovery)",
                   "Aim zoom", "Projectile", "Recycle FUNC"], rows)

    projs = [r for r in records if r["file"].startswith("Proj")]
    out += ["### Projectile settings", "", "The arrows inherit from `ProjArrow`: a blank row uses ProjArrow's values "
            "(InitialSpeed / MaxSpeed 15000).", ""]
    rows = [[_label(r), r["parent"], _v(r, "ProjectileMovement", "InitialSpeed"), _v(r, "ProjectileMovement", "MaxSpeed"),
             _v(r, "ProjectileMovement", "DragCoefficient"), _v(r, "CDO", "InitialLifeSpan"), _v(r, "CDO", "DistanceForLongRangeHit"),
             _v(r, "CDO", "Momentum")] for r in projs]
    out += _table(["Projectile", "Parent", "Initial speed", "Max speed", "Drag", "Life span s", "Long-range hit cm", "Momentum"], rows)

    deps = [r for r in records if r["file"].startswith("Dep") or (r["file"].startswith("Weap") and r["parent"] in
            ("Weapon_Grenade", "DeployableWeapon", "Weapon_Caltrops", "WeaponRemoteClaymore", "WeapDynamite_C", "WeapSteelSnare_C",
             "Weapon_Spray", "Weapon_Chainsaw", "Weapon_Tracker"))]
    out += ["### Throwables, traps, deployables and the rest", "",
            "A thrown or placed weapon (`Weap*`) spawns its deployable (`Dep*`), which holds the damage.", ""]
    rows = [[_label(r), r["parent"], _v(r, "CDO", "Damage"), _v(r, "CDO", "DamageAtMaxRadius"),
             _pair(r, "CDO", "ExplosionRadiusMin", "ExplosionRadiusMax"), _v(r, "CDO", "ExplodeDelay"), _v(r, "CDO", "MaxCookTime"),
             _v(r, "CDO", "TimeToPrime"), _v(r, "CDO", "DisarmTime"), _v(r, "CDO", "DamageToDestroy"), _v(r, "CDO", "RetriggerDelay"),
             _v(r, "CDO", "RecycleValue")] for r in sorted(deps, key=lambda r: r["file"])]
    out += _table(["Item", "Parent", "Damage", "Damage at max radius", "Radius min-max", "Explode delay s", "Cook s",
                   "Prime s", "Disarm s", "Damage to destroy", "Retrigger s", "Recycle FUNC"], rows)
    out += [END]
    return "\n".join(out)


def write_doc(records):
    """Replace the generated tables in docs/WEAPON_TIER_3_BALANCE.md."""
    text = open(DOC, encoding="utf-8").read() if os.path.exists(DOC) else "%s\n%s\n" % (BEGIN, END)
    a, b = text.index(BEGIN), text.index(END) + len(END)
    with open(DOC, "w", encoding="utf-8", newline="\n") as f:
        f.write(text[:a] + tables(records) + text[b:])


def main(paks):
    records, _ = read_all(paks)
    os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
    with open(OUT_JSON, "w", newline="\n") as f:
        json.dump({"source": "Read from the game's stock cooked assets by patch/weapon_stats.py. A value an asset "
                             "doesn't store is its parent class's (for a native parent, a C++ default not in the data).",
                   "meleeInferred": MELEE_INFERRED,
                   "weapons": as_json(records)}, f, indent=1)
        f.write("\n")
    write_doc(records)
    print("%d weapon, projectile and deployable assets -> %s, %s" % (
        len(records), os.path.relpath(OUT_JSON, HERE), os.path.relpath(DOC, HERE)))
    return records


if __name__ == "__main__":
    main(paks_dir(sys.argv[1] if len(sys.argv) > 1 else None))
