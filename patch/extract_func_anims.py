"""The Func mod's three first-person animation assets, from its patch pak into
patch/src, so a clean build ships them in the Remaster pak too.

The Func mod's pakchunk99-WindowsClient_P.pak (next to Func.Client.dll in
Victory/Binaries/Win64; Func.Client.dll mounts it) changes the club and
fire-axe blocks and the first-person anim blueprint. The Remaster's patch pak
has carried copies of them; they were in no generator, so a patch/src built
from scratch lacked them. Its CustomMatchSettings.js is not taken: patch/src
has the Remaster's own (tracked in git).

usage: python extract_func_anims.py <game dir | pakchunk99-WindowsClient_P.pak>
  python extract_func_anims.py C:/Culling/TheCulling
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from build_catalog import pak_entries, read_entry  # noqa: E402

FUNC_PAK = "Victory/Binaries/Win64/pakchunk99-WindowsClient_P.pak"
ANIMS = tuple("Victory/Content/Animations/Player/A/%s.uasset" % n
              for n in ("1P_Club_Block", "1P_Fireaxe_Block", "Player_1P_AnimBP"))
SRC = os.path.join(HERE, "src")


def main(where, src=SRC):
    pak = where if where.lower().endswith(".pak") else os.path.join(where, *FUNC_PAK.split("/"))
    if not os.path.isfile(pak):
        sys.exit("no Func patch pak at %s (install the Func mod, or give the pak's path)" % pak)
    found = {}
    for f, name, off, usize, method, blocks in pak_entries(pak):
        rel = name.replace("../../../", "")
        if rel in ANIMS:
            found[rel] = read_entry(f, off, usize, method, blocks)
    missing = sorted(set(ANIMS) - set(found))
    if missing:
        sys.exit("%s lacks %s (a different Func version?)" % (pak, ", ".join(missing)))
    for rel in ANIMS:
        out = os.path.join(src, *rel.split("/"))
        os.makedirs(os.path.dirname(out), exist_ok=True)
        with open(out + ".new", "wb") as f:
            f.write(found[rel])
        os.replace(out + ".new", out)
        print("%s (%d bytes)" % (rel, len(found[rel])))
    return found


if __name__ == "__main__":
    if len(sys.argv) != 2:
        sys.exit(__doc__.strip().splitlines()[-2].strip())
    main(sys.argv[1])
