"""patch_assets.py's bot start, from the stock paks (read only):

- BasicBot (the pawn every match's bots spawn as) stores SpawnsWithWeapons
  off: one byte changes, nothing else, and it reads back False.
- Each of BasicBot's direct children that inherited the flag now stores it on
  (the stock value), the package re-saves byte for byte, and its other
  properties are unchanged.
- Every bot class in the paks (BasicBot's subclasses, found by their parent
  package) ends up with the stock value except BasicBot itself: the Survival
  waves, the Tutorial and clone bots keep theirs.
- The rest of the tuning is unchanged by it (BotsToSpawn, the gas timeline).

usage: python test_patch_assets.py [Paks dir]
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import patch_assets as PA  # noqa: E402
from build_catalog import pak_entries, read_entry, stock_paks  # noqa: E402
from uasset import Package  # noqa: E402
from ue_package import UPackage  # noqa: E402

STOCK_PAKS = r"C:\Culling\TheCulling\Victory\Content\Paks"
FLAG = "SpawnsWithWeapons"
passed = 0


def ok(msg):
    global passed
    passed += 1
    print("ok   " + msg)


def check(cond, msg):
    if not cond:
        print("FAIL " + msg)
        sys.exit(1)


def props(data, export):
    return {p[0]: p[6] for p in Package(data).props(export)}


def bot_classes(paks):
    """{package path: (CDO name, parent package path or None, stored flag or None)} of BasicBot and
    every Blueprint class whose parent is one of them (by the /Game/... package it imports)."""
    found = {}
    for pak in stock_paks(paks, False):
        for f, name, off, usize, method, blocks in pak_entries(pak):
            rel = name.replace("../../../", "")
            if not (rel.startswith("Victory/Content/Blueprints/AI/") and rel.endswith(".uasset")
                    and re.match(r"(BasicBot|SurvivalBot|DecoyBot)", rel.split("/")[-1])):
                continue                     # bot pawns (the AI's tasks and services refer to them too)
            data = read_entry(f, off, usize, method, blocks)
            if b"BasicBot" not in data:
                continue
            pkg = Package(data)
            cdo = [e["name"] for e in pkg.exports if e["name"].startswith("Default__")]
            if not cdo:
                continue
            me = "/Game/" + rel[len("Victory/Content/"):-len(".uasset")]
            refs = [n for n in pkg.names if re.match(r"/Game/Blueprints/AI/Base/BasicBot\w*$", n) and n != me]
            stored = props(data, cdo[0]).get(FLAG)
            found[rel] = (cdo[0], refs, stored)
    out = {}
    for rel, (cdo, refs, stored) in found.items():
        # A class's parent: the BasicBot* package it imports that itself imports the others
        # (SurvivalBot_* import BasicBot and BasicBot_Child_Survival: the parent is the child).
        cands = ["Victory/Content/" + r[len("/Game/"):] + ".uasset" for r in refs]
        cands = [c for c in cands if c in found]
        parent = None
        for c in cands:
            if all(o == c or ("/Game/" + o[len("Victory/Content/"):-len(".uasset")]) in found[c][1] for o in cands):
                parent = c
        if rel != PA.BOT_PAWN and cands:
            check(parent, "%s: no single parent among %s" % (rel, cands))
        out[rel] = (cdo, parent, stored)
    return out


def effective(classes, rel, flags):
    cdo, parent, _ = classes[rel]
    if flags.get(rel) is not None:
        return flags[rel]
    return effective(classes, parent, flags) if parent else None


def main(paks):
    originals = PA.find_in_paks(paks, PA.all_assets())
    built = PA.build(originals)

    stock = originals[PA.BOT_PAWN]
    out = built[PA.BOT_PAWN]
    diff = [i for i in range(len(stock)) if stock[i] != out[i]]
    check(len(out) == len(stock) and len(diff) == 1, "BasicBot: %d bytes changed, not 1" % len(diff))
    before, after = props(stock, "Default__BasicBot_C"), props(out, "Default__BasicBot_C")
    check(before[FLAG] is True and after[FLAG] is False, "BasicBot.%s: %s -> %s" % (FLAG, before[FLAG], after[FLAG]))
    check({k: v for k, v in before.items() if k != FLAG} == {k: v for k, v in after.items() if k != FLAG},
          "BasicBot: another property changed")
    ok("BasicBot: SpawnsWithWeapons True -> False, one byte, nothing else")

    for rel, export in sorted(PA.ARMED_CHILDREN.items()):
        a, b = props(originals[rel], export), props(built[rel], export)
        check(FLAG not in a, "%s stores %s already" % (rel, FLAG))
        check(b.get(FLAG) is True, "%s.%s is %s" % (export, FLAG, b.get(FLAG)))
        check({k: v for k, v in b.items() if k != FLAG} == a, "%s: another property changed" % export)
        check(UPackage(built[rel]).save() == built[rel], "%s doesn't re-save byte for byte" % rel)
    ok("%d direct children store SpawnsWithWeapons True (the stock value), re-save unchanged" % len(PA.ARMED_CHILDREN))

    classes = bot_classes(paks)
    check(PA.BOT_PAWN in classes and len(classes) >= 10, "found only %d bot classes" % len(classes))
    stock_flags = {rel: c[2] for rel, c in classes.items()}
    new_flags = dict(stock_flags)
    for (rel, export, prop), value in PA.BOOLS.items():
        new_flags[rel] = value
    for rel in PA.ARMED_CHILDREN:
        new_flags[rel] = True
    for rel in classes:
        check(classes[rel][1] != PA.BOT_PAWN or rel in PA.ARMED_CHILDREN or stock_flags[rel] is not None,
              "%s inherits BasicBot's flag and isn't kept armed" % rel)
        s, n = effective(classes, rel, stock_flags), effective(classes, rel, new_flags)
        if rel == PA.BOT_PAWN:
            check(s is True and n is False, "BasicBot: %s -> %s" % (s, n))
        else:
            check(s == n, "%s: SpawnsWithWeapons %s -> %s" % (rel, s, n))
    ok("%d bot classes: only BasicBot (match bots) starts unarmed; Survival, Tutorial, clone bots keep theirs"
       % len(classes))

    gm = "Victory/Content/Blueprints/GameMode/VictoryGameMode.uasset"
    check(props(built[gm], "Default__VictoryGameMode_C")["BotsToSpawn"] == 50, "BotsToSpawn")
    ok("the rest of the tuning is as before (BotsToSpawn 50: the native module caps it at the free starts)")
    print("all %d patch_assets checks passed" % passed)


if __name__ == "__main__":
    main(sys.argv[1] if len(sys.argv) > 1 else STOCK_PAKS)
