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
from exe_stand_ins import full_stand_in, rounds_stand_in, stand_in, stock_bytes  # noqa: E402

P = patch_exe


def check(path, rounds=False):
    stock = open(path, "rb").read()
    assert P.patch(path, rounds=rounds) is True
    data = open(path, "rb").read()
    assert data[P.CAP_AT + 1] == 24
    gate = P.SHA_GATE_AT + 7
    assert data[gate:gate + 6] == b"\x90" * 6
    assert data[P.TRAIN_JUMP_AT:P.TRAIN_JUMP_AT + 2] == P.TRAIN_JUMP_NEW
    assert data[P.TRAIN_STUB_AT:P.TRAIN_STUB_AT + 5] == P.TRAIN_STUB
    # Fix 4: the refresh calls the pairing stub in every build (1.3.9's proven hook, which
    # pairs Duo in game); with the module only the stub's sort call leads to sd_teams (fix 9).
    assert data[P.DUO_HOOK_AT:P.DUO_HOOK_AT + len(P.DUO_HOOK)] == P.DUO_HOOK_NEW
    stub = data[P.DUO_STUB_AT:P.DUO_STUB_AT + len(P.DUO_STUB)]
    assert P._module_stub(stub) if rounds else stub == P.DUO_STUB
    assert data[P.SCORE_JG_AT:P.SCORE_JG_AT + len(P.SCORE_JG)] == P.SCORE_JG_NEW
    assert data[P.SCORE_STUB_AT:P.SCORE_STUB_AT + len(P.SCORE_STUB)] == P.SCORE_STUB
    changed = [i for i in range(len(stock)) if stock[i] != data[i]]
    duo = set(range(P.DUO_HOOK_AT, P.DUO_HOOK_AT + len(P.DUO_HOOK)))      # fix 4 in every build
    duo |= {P.DUO_STUB_AT + i for i in range(len(P.DUO_STUB)) if P.DUO_STUB[i] != 0xCC}
    duo |= {P.SCORE_JG_AT + 2, P.SCORE_JG_AT + 3, P.SCORE_JG_AT + 4, P.SCORE_JG_AT + 5}  # the retargeted disp32
    duo |= {P.SCORE_STUB_AT + i for i in range(len(P.SCORE_STUB)) if P.SCORE_STUB[i] != 0xCC}
    expected = set(range(gate, gate + 6)) | {P.TRAIN_JUMP_AT + 1} | set(range(P.TRAIN_STUB_AT, P.TRAIN_STUB_AT + 5)) | duo
    if rounds:
        check_rounds(stock, data)
        changed = [i for i in changed if i not in rounds_changes(stock)]
        expected -= rounds_changes(stock)
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
            | set(range(P.SPAWN_WITH_CALL_AT + 1, P.SPAWN_WITH_CALL_AT + 5))
            | {at + k for _n, at, _va, _s, _e in P.MODULE_CALLS for k in range(1, 5)})


def check_rounds(stock, data):
    header, raw, slot, lea, image_size, call = P.rounds_layout()
    assert len(data) == P.STOCK_FILE_SIZE + len(raw) and data[P.STOCK_FILE_SIZE:] == raw
    assert data[P.SPAWN_WITH_CALL_AT:P.SPAWN_WITH_CALL_AT + 5] == call
    assert P.SPAWN_WITH_CALL_VA + 5 + struct.unpack_from("<i", call, 1)[0] == P.IMAGE_BASE + ROUNDS.SECTION_RVA + ROUNDS.SD_SPAWN_WITH
    assert data[P.FFA_SLOT_AT:P.FFA_SLOT_AT + 8] == struct.pack("<Q", slot)
    assert data[P.RAND_LEA_AT:P.RAND_LEA_AT + 7] == lea
    # The calls fixes 7/8 take over lead to their entry points.
    for name, at, va, stock_call, entry in P.MODULE_CALLS:
        cur = data[at:at + 5]
        # fix 9's call is fix 4's stub's own sort call: int3 padding in the stock exe
        was = P.DUO_STUB[P.STUB_SORT:P.STUB_SORT + 5] if name == "teams" and stock[at:at + 5] == b"\xcc" * 5 else stock[at:at + 5]
        assert was == stock_call and cur[:1] == bytes([0xE8]), name
        assert va + 5 + struct.unpack_from("<i", cur, 1)[0] == P.IMAGE_BASE + ROUNDS.SECTION_RVA + entry, name
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
            0x30A460, 0x267090, 0x268FA0, 0x27A810, 0x1336CA0, 0x50C510, 0x303D00, 0x3034E0,
            # the Chokening's user (fix 8)
            0x1119150, 0x2494D0, 0x302980, 0x69C2A0,
            # team sizes (fix 9): SetTeamNum, the scoreboard sort, the bot spawner, teammates' status
            0x24E7E0, 0x243C80, 0x2320F0, 0x262D20, 0x2634C0, 0x28EE40, 0x28F9C0}
    assert want <= rvas, sorted(hex(x) for x in want - rvas)
    # The rival asks the player's pawn for the kit with the Showdown perk's bits.
    import make_showdown
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "showdown_rounds.c"), encoding="utf-8").read()
    bits = float(re.search(r"#define KIT_BITS\s+([0-9.]+)f", src).group(1))
    assert bits == sum(b for _i, _p, b in make_showdown.KIT), (bits, make_showdown.KIT)
    return len(blob)


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
    # ... also one from before the Duo/Chokening calls (they are stock).
    old = bytearray(data)
    old[P.STOCK_FILE_SIZE + 0x10] ^= 0xFF
    for _n, at, _va, stock_call, _e in P.MODULE_CALLS:
        old[at:at + 5] = stock_call
    assert P._rounds(old, path) is True and old == data
    # A gas call elsewhere: not ours, refused.
    bad = bytearray(data)
    bad[P.MODULE_CALLS[1][1]:P.MODULE_CALLS[1][1] + 5] = bytes.fromhex("e800000000")
    bad[P.STOCK_FILE_SIZE + 0x10] ^= 0xFF
    try:
        P._rounds(bad, path)
        raise AssertionError("a foreign gas call was accepted")
    except ValueError:
        pass
    # A stock exe with a foreign rating call: refused.
    bad = bytearray(stock)
    bad[P.MODULE_CALLS[0][1]:P.MODULE_CALLS[0][1] + 5] = bytes.fromhex("e800000000")
    try:
        P._rounds(bad, path)
        raise AssertionError("a foreign rating call was accepted")
    except ValueError:
        pass
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


def check_team_hook(path):
    """Fix 9 on a stand-in with the real layout. Regression: Duo is paired by
    fix 4's proven hook (1.3.9: the refresh at VA 0x140203b3a calls the stub at
    0x14005ac03, which pairs) in every build; fix 9 takes only the stub's own
    sort call (VA 0x14005ac50) to sd_teams, and the bot spawner's call to
    sd_spawn_bots. The first fix 9 build (the refresh's own call, VA
    0x140203b3d, to sd_teams: Duo had no teammate in game) and the build
    before fix 9 are upgraded to the same bytes; without the module the stub
    calls the sort itself again."""
    import capstone
    data = bytearray(open(path, "rb").read())
    stock_bytes(data)
    open(path, "wb").write(data)
    assert P.patch(path) is True
    new = open(path, "rb").read()
    sect = P.IMAGE_BASE + ROUNDS.SECTION_RVA
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    # The refresh: exactly fix 4's call of the stub at fix 4's site, as 1.3.9 shipped it.
    assert P.DUO_HOOK_AT == 0x20313A and new[P.DUO_HOOK_AT:P.DUO_HOOK_AT + 8] == P.DUO_HOOK_NEW == bytes.fromhex("e8c470e5ff909090")
    ins = next(md.disasm(new[P.DUO_HOOK_AT:P.DUO_HOOK_AT + 5], 0x140203B3A))
    assert (ins.mnemonic, int(ins.op_str, 16)) == ("call", 0x14005AC03), (ins.mnemonic, ins.op_str)
    # The stub: 1.3.9's bytes, pairing (shr edx, 1; inc edx; SetTeamNum), its sort call to sd_teams.
    stub = new[P.DUO_STUB_AT:P.DUO_STUB_AT + len(P.DUO_STUB)]
    assert P.DUO_STUB_AT == 0x5A203 and stub[:P.STUB_SORT] == P.DUO_STUB[:P.STUB_SORT]
    assert stub[P.STUB_SORT + 5:] == P.DUO_STUB[P.STUB_SORT + 5:]
    code = [(i.mnemonic, i.op_str) for i in md.disasm(stub, 0x14005AC03)]
    assert ("movzx", "eax, byte ptr [rdi + 0x4e4]") in code and ("cmp", "al, 2") in code
    assert ("shr", "edx, 1") in code and ("call", "0x14024e7e0") in code, code
    assert ("call", hex(sect + ROUNDS.SD_TEAMS)) in code, "the stub's sort call leads to sd_teams"
    assert 0x14005AC03 + P.STUB_SORT == P.TEAMS_CALL[2] and P.DUO_STUB_AT + P.STUB_SORT == P.TEAMS_CALL[1]
    # The refresh's own call (0x140203b3d) is not touched by fix 9 any more.
    assert not any(c[2] == P.OLD_TEAMS_CALL_VA for c in P.MODULE_CALLS)
    bots = new[0x23290D:0x23290D + 5]
    assert bots[:1] == b"\xe8" and 0x14023330D + 5 + struct.unpack_from("<i", bots, 1)[0] == sect + ROUNDS.SD_SPAWN_BOTS
    assert P.patch(path) is False, "running it again changes nothing"
    fixes = P.check(path)
    assert fixes["duoteam"] and fixes["teams"], fixes
    # The first fix 9 build: the refresh's mov kept and its call to sd_teams; the stub's sort stock.
    first = bytearray(new)
    first[P.DUO_HOOK_AT:P.DUO_HOOK_AT + 3] = P.DUO_HOOK[:3]
    first[P.DUO_HOOK_AT + 3:P.DUO_HOOK_AT + 8] = b"\xe8" + struct.pack("<i", sect + ROUNDS.SD_TEAMS - (P.OLD_TEAMS_CALL_VA + 5))
    first[P.DUO_STUB_AT:P.DUO_STUB_AT + len(P.DUO_STUB)] = P.DUO_STUB
    first[P.STOCK_FILE_SIZE + 0x10] ^= 0xFF                          # and its older module
    open(path, "wb").write(first)
    assert not P.check(path)["teams"]
    assert P.patch(path) is True and open(path, "rb").read() == new, "the first fix 9 build is upgraded"
    # The build before fix 9: fix 4's hook, stock stub and bot spawner call.
    old = bytearray(new)
    old[P.DUO_STUB_AT:P.DUO_STUB_AT + len(P.DUO_STUB)] = P.DUO_STUB
    old[0x23290D:0x23290D + 5] = bytes.fromhex("e8deedffff")
    old[P.STOCK_FILE_SIZE + 0x10] ^= 0xFF
    open(path, "wb").write(old)
    assert P.patch(path) is True and open(path, "rb").read() == new, "an older build is upgraded"
    assert P.patch(path, rounds=False) is True
    plain = open(path, "rb").read()
    assert plain[P.DUO_HOOK_AT:P.DUO_HOOK_AT + 8] == P.DUO_HOOK_NEW, "no module: fix 4's hook"
    assert plain[P.DUO_STUB_AT:P.DUO_STUB_AT + len(P.DUO_STUB)] == P.DUO_STUB, "no module: the stub sorts itself"
    for name, at, bad_bytes in (("refresh", P.DUO_HOOK_AT, bytes.fromhex("488bc8e800000000")),
                                ("stub sort", P.DUO_STUB_AT + P.STUB_SORT, bytes.fromhex("e800000000"))):
        bad = bytearray(new)
        bad[at:at + len(bad_bytes)] = bad_bytes                       # a call elsewhere
        open(path, "wb").write(bad)
        try:
            P.patch(path)
            raise AssertionError("a foreign %s call was accepted" % name)
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
    rounds_stand_in(rs)
    check_team_hook(rs)
    os.remove(rs)
    print("ok    native module: new section; vtable slot 282, RandomIntegerInRange, the spawn-with, rating and gas "
          "calls lead to the module; idempotent, replaces an older module, refuses other exes")
    print("ok    team sizes: Duo keeps fix 4's proven refresh hook and stub (0x140203b3a -> 0x14005ac03); only "
          "the stub's sort call leads to sd_teams, the bot spawner to sd_spawn_bots; the first fix 9 build "
          "and older builds are upgraded; without the module the stub sorts itself; foreign calls refused")

    # check() reads only; verify() wants every fix 1-9 and the patched Steam exe's bytes.
    fresh = os.path.join(tmp, "Fresh.exe")
    stand_in(fresh)
    before = open(fresh, "rb").read()
    none = {"cap": 16, "sha1": False, "slots": False, "duoteam": False, "rounds": False, "weather": False,
            "scoreboard": False, "duowin": False, "chokening": False, "teams": False}
    assert P.check(fresh) == none, P.check(fresh)
    assert open(fresh, "rb").read() == before, "check() changed the file"
    try:
        P.verify(fresh)
        raise AssertionError("an unpatched exe verified")
    except ValueError as e:
        for want in ("contestant cap 24 (has 16)", "SHA-1", "StartTraining", "Duo team pairing", "Showdown rounds",
                     "weather", "big scoreboards", "Duo team win", "Chokening", "team sizes"):
            assert want in str(e), (want, e)
    # Fixes 1-4 and 6 without the native module (5, 7, 8, 9): not a release exe.
    assert P.check(exe) == dict(none, cap=24, sha1=True, slots=True, duoteam=True, scoreboard=True), P.check(exe)
    try:
        P.verify(exe)
        raise AssertionError("an exe without the native module verified")
    except ValueError as e:
        assert all(w in str(e) for w in ("Showdown rounds", "Duo team win", "Chokening", "team sizes")), e
        assert "SHA-1" not in str(e) and "scoreboards" not in str(e), e
    full = os.path.join(tmp, "Full.exe")
    full_stand_in(full)
    assert P.check(full) == none
    assert P.patch(full) is True
    assert P.check(full) == {k: (24 if k == "cap" else True) for k in none}, P.check(full)
    every = {k: (24 if k == "cap" else True) for k in none}
    # Only the module's calls of fix 8 stock: everything else there, Chokening missing.
    partial = bytearray(open(full, "rb").read())
    for name, at, _va, stock_call, _e in P.MODULE_CALLS:
        if name in P.CHOKENING_CALLS:
            partial[at:at + 5] = stock_call
    open(fresh, "wb").write(partial)
    assert P.check(fresh) == dict(every, chokening=False), P.check(fresh)
    # Only fix 9's calls stock (the refresh's call and the bot spawner): team sizes missing.
    partial = bytearray(open(full, "rb").read())
    for name, at, _va, stock_call, _e in P.MODULE_CALLS:
        if name in P.TEAM_CALLS:
            partial[at:at + 5] = stock_call
    open(fresh, "wb").write(partial)
    assert P.check(fresh) == dict(every, teams=False), P.check(fresh)
    try:
        P.verify(full)
        raise AssertionError("a stand-in verified as the Steam exe")
    except ValueError as e:
        assert "isn't the patched Steam exe" in str(e), e
    os.remove(full)
    print("ok    check() reports fixes 1-9 without writing; verify() wants all nine and the patched exe's SHA-256")

    # Patching never writes through a hard link (a release's files are links of the install).
    install = os.path.join(tmp, "Install.exe")
    stand_in(install)
    linked = os.path.join(tmp, "Linked.exe")
    os.link(install, linked)
    P.patch(linked, rounds=False)
    assert open(install, "rb").read() == before, "patching a hard link changed the file it links to"
    assert P.check(linked)["sha1"] and not os.path.exists(linked + ".patching")
    print("ok    patching a hard-linked copy leaves the linked file alone (temp file + os.replace)")

    if len(sys.argv) > 1:
        real = os.path.join(tmp, "Real.exe")
        shutil.copyfile(sys.argv[1], real)
        if open(real, "rb").read()[P.SHA_GATE_AT + 7] == 0x90:
            print("skip  real exe already has the SHA-1 fix")
        else:
            assert P.sha256(real) == P.STOCK_SHA256, "the real exe isn't the stock Steam build P.STOCK_SHA256 names"
            print("ok    real Victory.exe patched cleanly (%d bytes besides the rounds patch)" % check(real, rounds=True))
            real_checks(real)
            P.verify(real)
            print("ok    real Victory.exe: stock SHA-256 before, PATCHED_SHA256 after (%s), verify() passes"
                  % P.PATCHED_SHA256[:16])
    print("all patch_exe tests passed")
finally:
    shutil.rmtree(tmp)
