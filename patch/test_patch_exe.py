"""patch_exe.py on a stand-in exe (the real bytes at every offset), and on the
real Victory.exe when its path is given.

usage: python test_patch_exe.py [Victory.exe]
"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import patch_exe  # noqa: E402

P = patch_exe


def stand_in(path):
    data = bytearray(P.CAP_AT + 16)
    data[P.CAP_AT:P.CAP_AT + 5] = bytes.fromhex("b810000000")
    data[P.SHA_GATE_AT:P.SHA_GATE_AT + 7] = P.SHA_GATE
    data[P.SHA_GATE_AT + 7:P.SHA_GATE_AT + 13] = P.SHA_JUMP
    data[P.TRAIN_JUMP_AT:P.TRAIN_JUMP_AT + 2] = P.TRAIN_JUMP
    data[P.TRAIN_CALL_AT:P.TRAIN_CALL_AT + len(P.TRAIN_CALL)] = P.TRAIN_CALL
    data[P.TRAIN_STUB_AT:P.TRAIN_STUB_AT + 13] = P.PAD
    data[P.DUO_HOOK_AT:P.DUO_HOOK_AT + len(P.DUO_HOOK)] = P.DUO_HOOK
    data[P.DUO_STUB_AT:P.DUO_STUB_AT + len(P.DUO_STUB)] = P.DUO_PAD
    open(path, "wb").write(data)


def check(path):
    stock = open(path, "rb").read()
    assert P.patch(path) is True
    data = open(path, "rb").read()
    assert data[P.CAP_AT + 1] == 24
    gate = P.SHA_GATE_AT + 7
    assert data[gate:gate + 6] == b"\x90" * 6
    assert data[P.TRAIN_JUMP_AT:P.TRAIN_JUMP_AT + 2] == P.TRAIN_JUMP_NEW
    assert data[P.TRAIN_STUB_AT:P.TRAIN_STUB_AT + 5] == P.TRAIN_STUB
    assert data[P.DUO_HOOK_AT:P.DUO_HOOK_AT + len(P.DUO_HOOK)] == P.DUO_HOOK_NEW
    assert data[P.DUO_STUB_AT:P.DUO_STUB_AT + len(P.DUO_STUB)] == P.DUO_STUB
    changed = [i for i in range(len(stock)) if stock[i] != data[i]]
    duo = set(range(P.DUO_HOOK_AT, P.DUO_HOOK_AT + len(P.DUO_HOOK)))
    duo |= {P.DUO_STUB_AT + i for i in range(len(P.DUO_STUB)) if P.DUO_STUB[i] != 0xCC}
    expected = set(range(gate, gate + 6)) | {P.TRAIN_JUMP_AT + 1} | set(range(P.TRAIN_STUB_AT, P.TRAIN_STUB_AT + 5)) | duo
    assert set(changed) in (expected | {P.CAP_AT + 1}, expected), changed     # or the cap was already there
    assert P.patch(path) is False, "running it again changes nothing"
    return len(changed)


tmp = tempfile.mkdtemp()
try:
    exe = os.path.join(tmp, "Victory.exe")
    stand_in(exe)
    n = check(exe)
    print("ok    stand-in: cap 24, SHA-1 jump NOPed, StartTraining takes URLs; %d bytes changed, idempotent" % n)

    other = os.path.join(tmp, "Other.exe")
    open(other, "wb").write(bytes(P.CAP_AT + 16))
    try:
        P.patch(other)
        raise AssertionError("a different exe was patched")
    except ValueError:
        pass
    print("ok    a different exe is refused")

    # check() reads only; verify() wants every fix and the patched Steam exe's bytes.
    fresh = os.path.join(tmp, "Fresh.exe")
    stand_in(fresh)
    before = open(fresh, "rb").read()
    assert P.check(fresh) == {"cap": 16, "sha1": False, "slots": False, "duoteam": False}
    assert open(fresh, "rb").read() == before, "check() changed the file"
    try:
        P.verify(fresh)
        raise AssertionError("an unpatched exe verified")
    except ValueError as e:
        assert "contestant cap 24 (has 16)" in str(e) and "SHA-1" in str(e) and "StartTraining" in str(e) and "Duo team" in str(e), e
    assert P.check(exe) == {"cap": 24, "sha1": True, "slots": True, "duoteam": True}
    try:
        P.verify(exe)
        raise AssertionError("a stand-in verified as the Steam exe")
    except ValueError as e:
        assert "isn't the patched Steam exe" in str(e), e
    print("ok    check() reports the fixes without writing; verify() wants all four and the patched exe's SHA-256")

    # Patching never writes through a hard link (a release's files are links of the install).
    install = os.path.join(tmp, "Install.exe")
    stand_in(install)
    linked = os.path.join(tmp, "Linked.exe")
    os.link(install, linked)
    P.patch(linked)
    assert open(install, "rb").read() == before, "patching a hard link changed the file it links to"
    assert P.check(linked)["sha1"] and not os.path.exists(linked + ".patching")
    print("ok    patching a hard-linked copy leaves the linked file alone (temp file + os.replace)")

    if len(sys.argv) > 1:
        real = os.path.join(tmp, "Real.exe")
        shutil.copyfile(sys.argv[1], real)
        if open(real, "rb").read()[gate := P.SHA_GATE_AT + 7] == 0x90:
            print("skip  real exe already has the SHA-1 fix")
        else:
            assert P.sha256(real) == P.STOCK_SHA256, "the real exe isn't the stock Steam build P.STOCK_SHA256 names"
            print("ok    real Victory.exe patched cleanly (%d bytes)" % check(real))
            P.verify(real)
            print("ok    real Victory.exe: stock SHA-256 before, PATCHED_SHA256 after, verify() passes")
    print("all patch_exe tests passed")
finally:
    shutil.rmtree(tmp)
