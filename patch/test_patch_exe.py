"""patch_exe.py on a stand-in exe (the real bytes at every offset), and on the
real Victory.exe when its path is given.

usage: python test_patch_exe.py [Victory.exe]
"""
import os
import re
import shutil
import struct
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import patch_exe  # noqa: E402
import showdown_rounds_blob as ROUNDS  # noqa: E402

P = patch_exe


def stand_in(path):
    data = bytearray(max(P.CAP_AT + 16, P.SCORE_JG_AT + len(P.SCORE_JG), P.SCORE_STUB_AT + len(P.SCORE_STUB)))
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
    open(path, "wb").write(data)


def check(path, rounds=False):
    stock = open(path, "rb").read()
    assert P.patch(path, rounds=rounds) is True
    data = open(path, "rb").read()
    assert data[P.CAP_AT + 1] == 24
    gate = P.SHA_GATE_AT + 7
    assert data[gate:gate + 6] == b"\x90" * 6
    assert data[P.TRAIN_JUMP_AT:P.TRAIN_JUMP_AT + 2] == P.TRAIN_JUMP_NEW
    assert data[P.TRAIN_STUB_AT:P.TRAIN_STUB_AT + 5] == P.TRAIN_STUB
    assert data[P.DUO_HOOK_AT:P.DUO_HOOK_AT + len(P.DUO_HOOK)] == P.DUO_HOOK_NEW
    assert data[P.DUO_STUB_AT:P.DUO_STUB_AT + len(P.DUO_STUB)] == P.DUO_STUB
    assert data[P.SCORE_JG_AT:P.SCORE_JG_AT + len(P.SCORE_JG)] == P.SCORE_JG_NEW
    assert data[P.SCORE_STUB_AT:P.SCORE_STUB_AT + len(P.SCORE_STUB)] == P.SCORE_STUB
    changed = [i for i in range(len(stock)) if stock[i] != data[i]]
    duo = set(range(P.DUO_HOOK_AT, P.DUO_HOOK_AT + len(P.DUO_HOOK)))
    duo |= {P.DUO_STUB_AT + i for i in range(len(P.DUO_STUB)) if P.DUO_STUB[i] != 0xCC}
    duo |= {P.SCORE_JG_AT + 2, P.SCORE_JG_AT + 3, P.SCORE_JG_AT + 4, P.SCORE_JG_AT + 5}  # the retargeted disp32
    duo |= {P.SCORE_STUB_AT + i for i in range(len(P.SCORE_STUB)) if P.SCORE_STUB[i] != 0xCC}
    expected = set(range(gate, gate + 6)) | {P.TRAIN_JUMP_AT + 1} | set(range(P.TRAIN_STUB_AT, P.TRAIN_STUB_AT + 5)) | duo
    if rounds:
        check_rounds(stock, data)
        changed = [i for i in changed if i not in rounds_changes(stock)]
    assert set(changed) in (expected | {P.CAP_AT + 1}, expected), changed     # or the cap was already there
    assert P.patch(path, rounds=rounds) is False, "running it again changes nothing"
    return len(changed)


# ---------------------------------------------------------------- Showdown rounds

def rounds_changes(stock):
    """The bytes of the stock file the rounds patch may change."""
    pe = struct.unpack_from("<I", stock, 0x3C)[0]
    table = pe + 24 + struct.unpack_from("<H", stock, pe + 20)[0]
    at = table + 40 * P.STOCK_NUM_SECTIONS
    return (set(range(pe + 6, pe + 8)) | set(range(pe + 24 + 56, pe + 24 + 60)) | set(range(at, at + 40))
            | set(range(P.FFA_SLOT_AT, P.FFA_SLOT_AT + 8)) | set(range(P.RAND_LEA_AT + 3, P.RAND_LEA_AT + 7))
            | set(range(P.SPAWN_WITH_CALL_AT + 1, P.SPAWN_WITH_CALL_AT + 5)))


def check_rounds(stock, data):
    header, raw, slot, lea, image_size, call = P.rounds_layout()
    assert len(data) == P.STOCK_FILE_SIZE + len(raw) and data[P.STOCK_FILE_SIZE:] == raw
    assert data[P.SPAWN_WITH_CALL_AT:P.SPAWN_WITH_CALL_AT + 5] == call
    assert P.SPAWN_WITH_CALL_VA + 5 + struct.unpack_from("<i", call, 1)[0] == P.IMAGE_BASE + ROUNDS.SECTION_RVA + ROUNDS.SD_SPAWN_WITH
    assert data[P.FFA_SLOT_AT:P.FFA_SLOT_AT + 8] == struct.pack("<Q", slot)
    assert data[P.RAND_LEA_AT:P.RAND_LEA_AT + 7] == lea
    # The vtable slot and the lea lead to the two entry points.
    sect = P.IMAGE_BASE + ROUNDS.SECTION_RVA
    assert slot == sect + ROUNDS.SD_SHOULD_END
    assert P.RAND_LEA_VA + 7 + struct.unpack_from("<i", lea, 3)[0] == sect + ROUNDS.SD_RAND_EXEC
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    assert struct.unpack_from("<H", data, pe + 6)[0] == P.STOCK_NUM_SECTIONS + 1
    assert struct.unpack_from("<I", data, pe + 24 + 56)[0] == image_size
    table = pe + 24 + struct.unpack_from("<H", data, pe + 20)[0]
    assert data[table + 40 * P.STOCK_NUM_SECTIONS:][:40] == header
    assert set(i for i in range(len(stock)) if stock[i] != data[i]) <= rounds_changes(stock) | other_fixes()


def other_fixes():
    gate = P.SHA_GATE_AT + 7
    return (set(range(gate, gate + 6)) | {P.TRAIN_JUMP_AT + 1, P.CAP_AT + 1}
            | set(range(P.TRAIN_STUB_AT, P.TRAIN_STUB_AT + 5))
            | set(range(P.DUO_HOOK_AT, P.DUO_HOOK_AT + len(P.DUO_HOOK)))
            | set(range(P.DUO_STUB_AT, P.DUO_STUB_AT + len(P.DUO_STUB)))
            | set(range(P.SCORE_JG_AT, P.SCORE_JG_AT + len(P.SCORE_JG)))
            | set(range(P.SCORE_STUB_AT, P.SCORE_STUB_AT + len(P.SCORE_STUB))))


def blob_checks():
    """The module calls only what it means to: the stock check, the stock
    RandomIntegerInRange and the game functions it names, all relative to the
    image base it computes from sd_self_rva (no absolute addresses)."""
    import capstone
    blob = ROUNDS.BLOB
    assert struct.unpack_from("<Q", blob, ROUNDS.SD_SELF_RVA)[0] == ROUNDS.SECTION_RVA + ROUNDS.SD_SELF_RVA
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    sect = P.IMAGE_BASE + ROUNDS.SECTION_RVA
    rvas = set()
    for i in md.disasm(blob[:ROUNDS.SD_SELF_RVA], sect):
        if i.mnemonic in ("call", "jmp") and i.op_str.startswith("0x"):
            t = int(i.op_str, 16)
            assert sect <= t < sect + len(blob), "direct call out of the blob at %x" % i.address
        if i.mnemonic == "movabs":     # a constant (the % 7 multiplier), never an address
            v = int(i.op_str.split(", ")[1], 16)
            assert not 0x100000000 <= v < 0x800000000000, "absolute address at %x" % i.address
        if i.mnemonic in ("mov", "add", "lea") and "rip" not in i.op_str:
            for h in re.findall(r"0x[0-9a-f]+", i.op_str):
                if 0x100000 <= int(h, 16) < 0x3000000:
                    rvas.add(int(h, 16))
    want = {0x244D30, 0x17F6E30, 0x69C470, 0x249D20, 0x249CA0, 0x249040, 0x23CAE0, 0x1A3420, 0x202900,
            0x303000, 0x303820, 0x302B20, 0x3039C0, 0x302CC0, 0x3046C0, 0x2567AA0,
            # the rival's kit and the dropped items
            0x30A460, 0x267090, 0x268FA0, 0x27A810, 0x1336CA0, 0x50C510, 0x303D00, 0x3034E0}
    assert want <= rvas, sorted(hex(x) for x in want - rvas)
    # The rival asks the player's pawn for the kit with the Showdown perk's bits.
    import make_showdown
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "showdown_rounds.c"), encoding="utf-8").read()
    bits = float(re.search(r"#define KIT_BITS\s+([0-9.]+)f", src).group(1))
    assert bits == sum(b for _i, _p, b in make_showdown.KIT), (bits, make_showdown.KIT)
    return len(blob)


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
    open(path, "wb").write(data)


def check_rounds_alone(path):
    stock = open(path, "rb").read()
    data = bytearray(stock)
    assert P._rounds(data, path) is True
    check_rounds(stock, data)
    assert P._rounds(bytearray(data), path) is False, "already patched"
    # An older module in the section is replaced.
    old = bytearray(data)
    old[P.STOCK_FILE_SIZE + 0x10] ^= 0xFF
    assert P._rounds(old, path) is True and old == data
    # ... also one from before the rival's kit (its spawn-with call stock).
    old = bytearray(data)
    old[P.STOCK_FILE_SIZE + 0x10] ^= 0xFF
    old[P.SPAWN_WITH_CALL_AT:P.SPAWN_WITH_CALL_AT + 5] = P.SPAWN_WITH_CALL
    assert P._rounds(old, path) is True and old == data
    # A spawn-with call elsewhere: not ours, refused.
    bad = bytearray(data)
    bad[P.SPAWN_WITH_CALL_AT:P.SPAWN_WITH_CALL_AT + 5] = bytes.fromhex("e800000000")
    bad[P.STOCK_FILE_SIZE + 0x10] ^= 0xFF
    try:
        P._rounds(bad, path)
        raise AssertionError("a foreign spawn-with call was accepted")
    except ValueError:
        pass
    # A different exe is refused.
    bad = bytearray(stock)
    struct.pack_into("<Q", bad, P.FFA_SLOT_AT, 0x140000000)
    try:
        P._rounds(bad, path)
        raise AssertionError("a different exe was patched")
    except ValueError:
        pass


def real_checks(path):
    """The patched real exe still parses, the new section maps the module,
    and the vtable slot keeps its base relocation."""
    import pefile
    pe = pefile.PE(path)
    s = pe.sections[-1]
    assert s.Name.rstrip(b"\0") == P.ROUNDS_NAME and s.VirtualAddress == ROUNDS.SECTION_RVA
    assert pe.get_data(ROUNDS.SECTION_RVA, len(ROUNDS.BLOB)) == ROUNDS.BLOB
    slot_rva = 0x25A81E8
    assert pe.get_offset_from_rva(slot_rva) == P.FFA_SLOT_AT
    assert pe.get_offset_from_rva(P.RAND_LEA_VA - P.IMAGE_BASE) == P.RAND_LEA_AT
    relocs = {e.rva for b in pe.DIRECTORY_ENTRY_BASERELOC for e in b.entries if e.type == 10}
    assert slot_rva in relocs, "the vtable slot is relocated"
    assert pe.get_qword_at_rva(slot_rva) == P.IMAGE_BASE + ROUNDS.SECTION_RVA + ROUNDS.SD_SHOULD_END
    assert pe.OPTIONAL_HEADER.SizeOfImage == P.rounds_layout()[4]
    pe.close()
    print("ok    real exe: .sdround maps the module at 0x%x, slot 282 keeps its relocation"
          % (P.IMAGE_BASE + ROUNDS.SECTION_RVA))


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

    print("ok    Showdown rounds module: %d bytes, calls only the game functions it names" % blob_checks())
    rs = os.path.join(tmp, "Rounds.exe")
    rounds_stand_in(rs)
    check_rounds_alone(rs)
    os.remove(rs)
    print("ok    Showdown rounds: new section; vtable slot 282 and RandomIntegerInRange lead to the module; "
          "idempotent, replaces an older module, refuses other exes")

    if len(sys.argv) > 1:
        real = os.path.join(tmp, "Real.exe")
        shutil.copyfile(sys.argv[1], real)
        if open(real, "rb").read()[P.SHA_GATE_AT + 7] == 0x90:
            print("skip  real exe already has the SHA-1 fix")
        else:
            print("ok    real Victory.exe patched cleanly (%d bytes besides the rounds patch)" % check(real, rounds=True))
            real_checks(real)
    print("all patch_exe tests passed")
finally:
    shutil.rmtree(tmp)
