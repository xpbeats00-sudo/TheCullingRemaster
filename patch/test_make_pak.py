"""make_pak.py refuses test and diagnostic content (throwaway folders only):
the animated-camo assets, the Ice Axe test mesh, packages that reference them
and anything saying TEST BUILD; stock text like EndOfMatch.js's "XPAnimate" is
not test content; the pak is written through a temp file.

usage: python test_make_pak.py
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_pak  # noqa: E402
from build_catalog import pak_entries  # noqa: E402


def put(root, rel, data):
    path = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


tmp = tempfile.mkdtemp(prefix="make-pak-test-")
try:
    src = os.path.join(tmp, "src")
    out = os.path.join(tmp, "out.pak")
    W = "Victory/Content/Character/Weapons/"
    put(src, "Victory/Content/uiresources/hud/js/Screens/EndOfMatch.js", b'console.log("XPAnimate");')
    put(src, "Victory/Content/Cosmetics/WeaponSkins/IceAxe_XP_Frost_Plasma.uasset", b"\0plain camo skin\0")
    make_pak.main(src, out)
    names = sorted(e[1] for e in pak_entries(out))
    assert len(names) == 2 and not os.path.exists(out + ".new"), names
    print("ok    clean content packs (EndOfMatch.js's \"XPAnimate\" is not test content)")

    put(src, W + "AutoBow_A_XPAnim_MI.uasset", b"x")
    put(src, W + "IceAxe_A_XPTest.uasset", b"x")
    put(src, W + "Camo_XP_Anim_Lava_Storm.uasset", b"x")
    put(src, "Victory/Content/Cosmetics/WeaponSkins/IceAxe_XP_Blue_Tempest.uasset",
        b"\0/Game/Character/Weapons/IceAxe_A_XPTest.IceAxe_A\0")
    put(src, "Victory/Content/Cosmetics/WeaponSkins/IceAxe_XP_Lava_Storm.uasset",
        "/Game/Character/Weapons/Camo_XP_Anim_Lava_Storm".encode("utf-16le"))
    put(src, "Victory/Content/uiresources/FrontEnd/FrontEnd.html", b"<p>TEST BUILD</p>")
    found = dict(make_pak.test_content(src))
    assert set(found) == {W + "AutoBow_A_XPAnim_MI.uasset", W + "IceAxe_A_XPTest.uasset", W + "Camo_XP_Anim_Lava_Storm.uasset",
                          "Victory/Content/Cosmetics/WeaponSkins/IceAxe_XP_Blue_Tempest.uasset",
                          "Victory/Content/Cosmetics/WeaponSkins/IceAxe_XP_Lava_Storm.uasset",
                          "Victory/Content/uiresources/FrontEnd/FrontEnd.html"}, found
    print("ok    test assets, packages pointing at them (ASCII or UTF-16) and TEST BUILD are found")

    before = open(out, "rb").read()
    try:
        make_pak.main(src, out)
        raise AssertionError("test content was packed")
    except make_pak.TestContentError as e:
        assert "refusing to pack 6" in str(e), e
    assert open(out, "rb").read() == before, "a refused pak was written"
    print("ok    make_pak refuses to pack them and leaves the old pak alone")

    make_pak.main(src, out, allow_test_content=True)
    assert len(list(pak_entries(out))) == 8
    print("ok    --allow-test-content packs them (local diagnostics builds)")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print("all make_pak tests passed")
