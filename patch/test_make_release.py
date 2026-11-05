"""make_release.py's guards, on throwaway folders (no game, no key, nothing packed):
a full release needs an absolute game dir that is a real install with enough
files, and a pak-only release has to be asked for.

usage: python test_make_release.py
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_release as mr  # noqa: E402

failures = []
passed = 0


def test(fn):
    global passed
    try:
        fn()
        passed += 1
        print("ok    " + fn.__doc__)
    except AssertionError as e:
        failures.append(fn.__doc__)
        print("FAIL  %s: %s" % (fn.__doc__, e))
    return fn


def refuses(pattern, fn, *args, **kw):
    try:
        fn(*args, **kw)
    except mr.ReleaseError as e:
        assert pattern in str(e), "refused, but with %r" % str(e)
        return
    raise AssertionError("not refused (expected %r)" % pattern)


def touch(root, rel, data=b"x"):
    path = os.path.join(root, *rel.split("/"))
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


tmp = tempfile.mkdtemp(prefix="make-release-test-")
out = os.path.join(tmp, "out")
game = os.path.join(tmp, "game")
os.makedirs(game)


def build(g, **kw):
    mr.main("https://example.test", "9.9.9", out=out, game=g, setup=False, **kw)


try:
    @test
    def neither():
        """neither --full nor --pak-only is refused (a full release is the default)"""
        refuses("--pak-only", build, None)

    @test
    def both():
        """--full and --pak-only together are refused"""
        refuses("not both", build, game, pak_only=True)

    @test
    def relative():
        """a relative game dir is refused"""
        refuses("absolute path", build, "TheCulling")

    @test
    def missing():
        """a game dir that doesn't exist is refused"""
        refuses("no folder", build, os.path.join(tmp, "nope"))

    @test
    def not_a_game():
        """a folder without Victory.exe and pakchunk0 is refused"""
        refuses("missing Victory/Binaries/Win64/Victory.exe, Victory/Content/Paks/pakchunk0-WindowsClient.pak", build, game)

    @test
    def too_few():
        """an install with too few files to ship is refused before anything is written"""
        for rel in mr.REQUIRED:
            touch(game, rel)
        for i in range(10):
            touch(game, "Victory/Content/Movies/m%d.mp4" % i)
        refuses("files to ship", build, game)
        assert not os.path.exists(out), "the out folder was written"

    @test
    def not_steam_exe():
        """a Victory.exe that isn't the Steam build patch_exe.py is for is refused"""
        saved, mr.MIN_FULL_FILES = mr.MIN_FULL_FILES, 5       # enough files: the exe is checked next
        try:
            refuses("is not the Steam Victory.exe", build, game)
        finally:
            mr.MIN_FULL_FILES = saved
        assert not os.path.exists(out), "the out folder was written"

    @test
    def excluded():
        """excluded files don't count towards a full release"""
        for rel in mr.FULL_EXCLUDE:
            touch(game, rel)
        files = mr.game_files(game)
        assert not set(files) & set(mr.FULL_EXCLUDE), set(files) & set(mr.FULL_EXCLUDE)
        assert len(files) == len(mr.REQUIRED) + 10, files
finally:
    shutil.rmtree(tmp, ignore_errors=True)

if failures:
    sys.exit(1)
print("all %d make_release guard tests passed" % passed)
