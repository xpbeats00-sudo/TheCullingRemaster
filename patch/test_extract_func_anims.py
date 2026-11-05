"""extract_func_anims.py on a throwaway Func pak: the three animation assets
land in src byte for byte, nothing else is taken, and a pak missing one is refused.

usage: python test_extract_func_anims.py
"""
import contextlib
import io
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import extract_func_anims as x  # noqa: E402
import make_pak  # noqa: E402


def func_pak(game, files):
    stage = tempfile.mkdtemp(dir=os.path.dirname(game))
    for rel, data in files.items():
        path = os.path.join(stage, *rel.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        open(path, "wb").write(data)
    out = os.path.join(game, *x.FUNC_PAK.split("/"))
    os.makedirs(os.path.dirname(out), exist_ok=True)
    with contextlib.redirect_stdout(io.StringIO()):
        make_pak.main(stage, out)
    shutil.rmtree(stage)


tmp = tempfile.mkdtemp(prefix="func-anims-test-")
try:
    game, src = os.path.join(tmp, "game"), os.path.join(tmp, "src")
    files = {rel: ("anim %d" % i).encode() * 50 for i, rel in enumerate(x.ANIMS)}
    func_pak(game, dict(files, **{"Victory/Content/uiresources/FrontEnd/js/Screens/CustomMatchSettings.js": b"func's"}))
    with contextlib.redirect_stdout(io.StringIO()):
        x.main(game, src)
    for rel, data in files.items():
        assert open(os.path.join(src, *rel.split("/")), "rb").read() == data, rel
    assert not os.path.exists(os.path.join(src, "Victory", "Content", "uiresources")), "took Func's CustomMatchSettings.js"
    print("ok    the three Func animation assets are copied into src, byte for byte, and nothing else")

    func_pak(game, {x.ANIMS[0]: b"only one"})
    try:
        x.main(game, src)
        raise AssertionError("a pak without all three was accepted")
    except SystemExit as e:
        assert "lacks" in str(e), e
    try:
        x.main(os.path.join(tmp, "nowhere"), src)
        raise AssertionError("a missing pak was accepted")
    except SystemExit as e:
        assert "no Func patch pak" in str(e), e
    print("ok    a Func pak missing one, or no pak at all, is refused")
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print("all extract_func_anims tests passed")
