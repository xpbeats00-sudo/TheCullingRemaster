"""Stand-in Victory.exe files for the tests (test_patch_exe.py,
test_make_release.py): the bytes patch_exe.py checks, at their offsets, and
zeros everywhere else.

stand_in(path): a small file with the stock bytes of fixes 1-4 and 6 (no PE
headers, so the native module of fixes 5, 7 and 8 can't be applied to it:
patch it with rounds=False).
rounds_stand_in(path): the real exe's size and PE layout where the native
module patch looks (STOCK_FILE_SIZE bytes, about 54 MB).
full_stand_in(path): both, a file every fix 1-8 applies to.
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import patch_exe as P  # noqa: E402


def stand_in(path):
    data = bytearray(max(P.CAP_AT + 16, P.SCORE_JG_AT + len(P.SCORE_JG), P.SCORE_STUB_AT + len(P.SCORE_STUB)))
    stock_bytes(data)
    open(path, "wb").write(data)


def stock_bytes(data):
    """The stock bytes fixes 1-4 and 6 look for, written into data."""
    data[P.CAP_AT:P.CAP_AT + 5] = bytes.fromhex("b810000000")
    data[P.SHA_GATE_AT:P.SHA_GATE_AT + 7] = P.SHA_GATE
    data[P.SHA_GATE_AT + 7:P.SHA_GATE_AT + 13] = P.SHA_JUMP
    data[P.TRAIN_JUMP_AT:P.TRAIN_JUMP_AT + 2] = P.TRAIN_JUMP
    data[P.TRAIN_CALL_AT:P.TRAIN_CALL_AT + len(P.TRAIN_CALL)] = P.TRAIN_CALL
    data[P.TRAIN_STUB_AT:P.TRAIN_STUB_AT + 13] = P.PAD
    data[P.DUO_HOOK_AT:P.DUO_HOOK_AT + len(P.DUO_HOOK)] = P.DUO_HOOK
    data[P.DUO_STUB_AT:P.DUO_STUB_AT + len(P.DUO_STUB)] = P.DUO_PAD
    data[P.SCORE_JG_AT:P.SCORE_JG_AT + len(P.SCORE_JG)] = P.SCORE_JG
    data[P.SCORE_STUB_AT:P.SCORE_STUB_AT + len(P.SCORE_STUB)] = P.SCORE_PAD


def rounds_stand_in(path):
    """A file with the real exe's layout where the rounds patch looks."""
    data = bytearray(P.STOCK_FILE_SIZE)
    pe = 0x110
    data[0:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, pe)
    data[pe:pe + 4] = b"PE\0\0"
    struct.pack_into("<HH", data, pe + 4, 0x8664, P.STOCK_NUM_SECTIONS)
    struct.pack_into("<H", data, pe + 20, 0xF0)
    struct.pack_into("<I", data, pe + 24 + 56, P.STOCK_IMAGE_SIZE)
    struct.pack_into("<I", data, pe + 24 + 60, 0x600)
    table = pe + 24 + 0xF0
    for i in range(P.STOCK_NUM_SECTIONS):
        data[table + 40 * i:table + 40 * i + 8] = (".s%d" % i).encode().ljust(8, b"\0")
    struct.pack_into("<Q", data, P.FFA_SLOT_AT, P.FFA_SLOT)
    data[P.RAND_LEA_AT:P.RAND_LEA_AT + 7] = P.RAND_LEA
    data[P.SPAWN_WITH_CALL_AT:P.SPAWN_WITH_CALL_AT + 5] = P.SPAWN_WITH_CALL
    for _n, at, _va, stock_call, _e in P.MODULE_CALLS:
        data[at:at + 5] = stock_call
    open(path, "wb").write(data)


def full_stand_in(path):
    """rounds_stand_in with the other fixes' stock bytes too: an exe every fix 1-8 applies to."""
    rounds_stand_in(path)
    data = bytearray(open(path, "rb").read())
    small = os.path.join(os.path.dirname(path), "small.tmp")
    stand_in(small)
    part = open(small, "rb").read()
    os.remove(small)
    for at, n in ((P.CAP_AT, 5), (P.SHA_GATE_AT, 13), (P.TRAIN_JUMP_AT, 2), (P.TRAIN_CALL_AT, len(P.TRAIN_CALL)),
                  (P.TRAIN_STUB_AT, 13), (P.DUO_HOOK_AT, len(P.DUO_HOOK)), (P.DUO_STUB_AT, len(P.DUO_STUB)),
                  (P.SCORE_JG_AT, len(P.SCORE_JG)), (P.SCORE_STUB_AT, len(P.SCORE_STUB))):
        data[at:at + n] = part[at:at + n]
    open(path, "wb").write(data)
