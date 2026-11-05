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

    if len(sys.argv) > 1:
        real = os.path.join(tmp, "Real.exe")
        shutil.copyfile(sys.argv[1], real)
        if open(real, "rb").read()[gate := P.SHA_GATE_AT + 7] == 0x90:
            print("skip  real exe already has the SHA-1 fix")
        else:
            print("ok    real Victory.exe patched cleanly (%d bytes)" % check(real))
    print("all patch_exe tests passed")
finally:
    shutil.rmtree(tmp)
