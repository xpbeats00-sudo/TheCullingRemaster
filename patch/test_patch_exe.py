"""patch_exe.py on a stand-in exe (the real bytes at both offsets), and on the
real Victory.exe when its path is given.

usage: python test_patch_exe.py [Victory.exe]
"""
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import patch_exe  # noqa: E402


def stand_in(path):
    data = bytearray(patch_exe.CAP_AT + 16)
    data[patch_exe.CAP_AT:patch_exe.CAP_AT + 5] = bytes.fromhex("b810000000")
    at = patch_exe.SHA_GATE_AT
    data[at:at + 7] = patch_exe.SHA_GATE
    data[at + 7:at + 13] = patch_exe.SHA_JUMP
    open(path, "wb").write(data)


def check(path):
    stock = open(path, "rb").read()
    assert patch_exe.patch(path) is True
    data = open(path, "rb").read()
    assert data[patch_exe.CAP_AT + 1] == 24
    gate = patch_exe.SHA_GATE_AT + 7
    assert data[gate:gate + 6] == b"\x90" * 6
    changed = [i for i in range(len(stock)) if stock[i] != data[i]]
    sha = list(range(gate, gate + 6))
    assert changed in (sha + [patch_exe.CAP_AT + 1], sha), changed     # or the cap was already there
    assert patch_exe.patch(path) is False, "running it again changes nothing"


tmp = tempfile.mkdtemp()
try:
    exe = os.path.join(tmp, "Victory.exe")
    stand_in(exe)
    check(exe)
    print("ok    stand-in: cap 24 and the SHA-1 jump NOPed, 7 bytes changed, idempotent")

    other = os.path.join(tmp, "Other.exe")
    open(other, "wb").write(bytes(patch_exe.CAP_AT + 16))
    try:
        patch_exe.patch(other)
        raise AssertionError("a different exe was patched")
    except ValueError:
        pass
    print("ok    a different exe is refused")

    if len(sys.argv) > 1:
        real = os.path.join(tmp, "Real.exe")
        shutil.copyfile(sys.argv[1], real)
        if open(real, "rb").read()[patch_exe.SHA_GATE_AT + 7] == 0x90:
            print("skip  real exe already has the SHA-1 fix")
        else:
            check(real)
            print("ok    real Victory.exe patched cleanly")
    print("all patch_exe tests passed")
finally:
    shutil.rmtree(tmp)
