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


def build(g, version="9.9.9", **kw):
    mr.main("https://example.test", version, out=out, game=g, setup=False, **kw)


real_live_version = mr.live_version
mr.live_version = lambda base: ("1.3.5", "the live manifest (stand-in)")    # no network in tests


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
        saved = mr.MIN_FULL_FILES, mr.SHIPPED, mr.MIN_FULL_BYTES
        mr.MIN_FULL_FILES = 5                                 # enough files ...
        try:
            refuses("lacks Victory/Binaries/Win64/Func.Client.dll, Victory/Binaries/Win64/Func.Launcher.exe", build, game)
            mr.SHIPPED = ()                                   # ... everything a release needs ...
            refuses("ships only 0.00 GB", build, game)
            mr.MIN_FULL_BYTES = 0                             # ... and enough bytes: the exe is checked next
            refuses("is not the Steam Victory.exe", build, game)
        finally:
            mr.MIN_FULL_FILES, mr.SHIPPED, mr.MIN_FULL_BYTES = saved
        assert not os.path.exists(out), "the out folder was written"

    @test
    def excluded():
        """excluded files don't count towards a full release"""
        for rel in mr.FULL_EXCLUDE | {"Victory/Content/Paks/Victory/Content/WwiseAudio/Windows/1.wem",
                                      "Victory/Content/Paks/Victory/Config/DefaultEngine.ini.original",
                                      "Victory/Config/DefaultGame.ini.original"}:
            touch(game, rel)
        files = mr.game_files(game)
        assert not [f for f in files if "Paks/Victory/" in f or f.endswith(".original")], files
        assert not set(files) & set(mr.FULL_EXCLUDE), set(files) & set(mr.FULL_EXCLUDE)
        assert len(files) == len(mr.REQUIRED) + 10, files
    @test
    def skip_gate_only_for_tests():
        """--skip-gate is refused for a build into releases/"""
        refuses("test builds only", mr.main, "https://example.test", "9.9.9", setup=False, pak_only=True, skip_gate=True)

    real_git_state = mr.git_state

    @test
    def versions():
        """a version not newer than the live one, a built version or a malformed one is refused"""
        assert mr.compare_versions("1.10.0", "1.9.2") == 1 and mr.compare_versions("1.3.5", "1.3.5.0") == 0
        assert mr.compare_versions("1.3.4", "1.3.5") == -1
        refuses("not newer than the live release 1.3.5", build, None, "1.3.5", pak_only=True)
        refuses("not newer than the live release 1.3.5", build, None, "1.2.9", pak_only=True)
        refuses("use numbers like 1.4.0", build, None, "1.4.0-test", pak_only=True)
        # Server unreachable: releases/LATEST is the live version.
        saved_root, mr.ROOT = mr.ROOT, tmp
        try:
            touch(tmp, "releases/LATEST", b"1.4.2")
            assert real_live_version("http://127.0.0.1:9", timeout=3) == ("1.4.2", os.path.join(tmp, "releases", "LATEST"))
        finally:
            mr.ROOT = saved_root
            shutil.rmtree(os.path.join(tmp, "releases"))
        os.makedirs(os.path.join(out, "publish"))
        try:
            refuses("already exists: release 9.9.9 was built before", build, None, pak_only=True)
        finally:
            shutil.rmtree(out)

    @test
    def dirty():
        """a git tree with uncommitted changes is refused (unless --allow-dirty)"""
        mr.git_state = lambda: ("0" * 40, "test", ["patch/make_camos.py"])
        try:
            refuses("uncommitted changes (patch/make_camos.py)", build, None, pak_only=True)
            assert not os.path.exists(out)
        finally:
            mr.git_state = real_git_state

    @test
    def gate_fails():
        """a failing consistency gate stops the build before anything is packed"""
        import test_release_consistency as gate
        mr.git_state = lambda: ("0" * 40, "test", [])
        real_run = gate.run
        gate.run = lambda paks=None: (["patch/registry/camos.bin is missing"], [])
        try:
            refuses("consistency gate failed (1 problem(s)), nothing was packed", build, None, pak_only=True)
            assert not os.path.exists(out)
        finally:
            gate.run = real_run
            mr.git_state = real_git_state

    @test
    def links():
        """release files link the install's, but what the release changes is a copy or written new"""
        import patch_exe as P
        exe = bytearray(P.CAP_AT + 16)                     # a stand-in exe (test_patch_exe.py)
        exe[P.CAP_AT:P.CAP_AT + 5] = bytes.fromhex("b810000000")
        exe[P.SHA_GATE_AT:P.SHA_GATE_AT + 7] = P.SHA_GATE
        exe[P.SHA_GATE_AT + 7:P.SHA_GATE_AT + 13] = P.SHA_JUMP
        exe[P.TRAIN_JUMP_AT:P.TRAIN_JUMP_AT + 2] = P.TRAIN_JUMP
        exe[P.TRAIN_CALL_AT:P.TRAIN_CALL_AT + len(P.TRAIN_CALL)] = P.TRAIN_CALL
        exe[P.TRAIN_STUB_AT:P.TRAIN_STUB_AT + 13] = P.PAD
        exe[P.DUO_HOOK_AT:P.DUO_HOOK_AT + len(P.DUO_HOOK)] = P.DUO_HOOK
        exe[P.DUO_STUB_AT:P.DUO_STUB_AT + len(P.DUO_STUB)] = P.DUO_PAD
        touch(game, mr.GAME_EXE, bytes(exe))
        touch(game, mr.SETTINGS_README_PATH, b"the install's own readme")
        release = os.path.join(tmp, "release")
        mr.link_game(game, release, mr.game_files(game))
        at = lambda root, rel: os.path.join(root, *rel.split("/"))      # noqa: E731
        same = lambda rel: os.path.samefile(at(game, rel), at(release, rel))  # noqa: E731
        assert same("Victory/Content/Movies/m0.mp4"), "an unchanged file is a hard link"
        assert not same(mr.GAME_EXE), "Victory.exe is a copy"
        assert open(at(game, mr.GAME_EXE), "rb").read() == bytes(exe), "patching changed the install's exe"
        assert P.check(at(release, mr.GAME_EXE))["slots"], "the release's exe is patched"
        assert not same(mr.SETTINGS_README_PATH), "the readme the release writes is its own file"
        assert open(at(game, mr.SETTINGS_README_PATH), "rb").read() == b"the install's own readme"
        assert open(at(release, mr.SETTINGS_README_PATH), "rb").read() == mr.SETTINGS_README.encode("ascii")
finally:
    shutil.rmtree(tmp, ignore_errors=True)

if failures:
    sys.exit(1)
print("all %d make_release guard tests passed" % passed)
