"""Run the native module's code (showdown_rounds.c, compiled
with the blob's own flags) against fake game objects (test_native_module.c):
Duo's team win, team sizes 2/3/4 (Trios, Quads) from the match URL, the
teammates' HUD report, Showdown 1v1 and team Showdown (2v2, 3v3, 4v4), the
arena's sides (every fighter teleported to its side's spot at the series'
start and after every reset), and the Chokening's kills.

With the stock Victory.exe (read only) it also re-derives the game addresses
the sides use that no other test does: AController::ControlRotation (its
property registration, next to Pawn and PlayerState), and the HUD teammate
panel's "found" flag (AVictoryPlayerHUD +0x654: the tick searches while it
isn't 1 and sets it once, after keeping the pawn at +0x658). K2_TeleportTo is
test_unstick_native.py's. And the built blob uses both.

Needs the Visual Studio C++ tools (as build_showdown_rounds.py does).

usage: python test_native_module.py [Victory.exe]
"""
import os
import re
import struct
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_showdown_rounds as BUILD  # noqa: E402

HARNESS = os.path.join(BUILD.HERE, "test_native_module.c")
STOCK_EXE = r"C:\Culling\TheCulling\Victory\Binaries\Win64\Victory.exe"
HUD_TICK = 0x1fbea1             # the panel's search (showdown_rounds.c, docs/TEAM_SIZES_TRIOS_QUADS.md)
CHOOSER = 0x231b50              # AVictoryGameMode's start chooser (FreeForAll's override calls it, VA 0x14024487d)
PREFERRED = 0x234dd0            # IsSpawnpointPreferred (FreeForAll vtable +0x8e0)


def defines():
    src = "".join(open(os.path.join(BUILD.HERE, f), encoding="utf-8").read() for f in ("showdown_rounds.c", "unstick.c"))
    return {k: int(v, 16) for k, v in re.findall(r"#define ([A-Z_0-9]+)\s+(0x[0-9a-f]+)", src)}


def lea_sites(ex, target):
    """Every lea r64, [rip + disp32] in .text whose target is `target` (an RVA)."""
    import numpy as np
    t = np.frombuffer(ex.d, dtype=np.uint8, count=ex.tsize, offset=ex.toff)
    n = len(t) - 8
    cand = np.nonzero(((t[:n] == 0x48) | (t[:n] == 0x4c)) & (t[1:n + 1] == 0x8d) & ((t[2:n + 2] & 0xc7) == 0x05))[0]
    disp = sum(t[cand + 3 + k].astype(np.int64) << (8 * k) for k in range(4))
    disp = np.where(disp >= 2 ** 31, disp - 2 ** 32, disp)
    return [int(ex.tva + c) for c in cand[ex.tva + cand + 7 + disp == target]]


def prop_offsets(ex, name):
    """[(registration site, offset)]: the "mov r9d, <offset>" of each registration of the wide name."""
    out = []
    for s in ex.strings(name, True):
        for site in lea_sites(ex, s):
            text = " | ".join("%s %s" % (i.mnemonic, i.op_str) for i in ex.code(site, 0x120)[:40])
            m = re.search(r"mov r9d, (0x[0-9a-f]+|\d+)", text)
            if m:
                out.append((site, int(m.group(1), 0)))
    return out


def exe_checks(path):
    import capstone
    import showdown_rounds_blob as ROUNDS
    import test_weather_native as TW
    ex = TW.Exe(path)
    d = defines()
    # ControlRotation: registered with AController's Pawn (C_PAWN) and PlayerState (C_PLAYERSTATE).
    pawn = [s for s, o in prop_offsets(ex, "Pawn") if o == d["C_PAWN"]]
    ps = [s for s, o in prop_offsets(ex, "PlayerState") if o == d["C_PLAYERSTATE"]]
    rot = {o for s, o in prop_offsets(ex, "ControlRotation")
           if any(abs(s - x) < 0x1000 for x in pawn) and any(abs(s - x) < 0x1000 for x in ps)}
    if rot != {d["C_CONTROL_ROT"]}:
        sys.exit("FAIL ControlRotation is registered at %s, not +0x%x" % (sorted(hex(o) for o in rot), d["C_CONTROL_ROT"]))
    print("ok    AController::ControlRotation is +0x%x (registered next to Pawn +0x%x and PlayerState +0x%x)"
          % (d["C_CONTROL_ROT"], d["C_PAWN"], d["C_PLAYERSTATE"]))
    # The HUD panel's flag: the tick skips its search when it is 1, and sets it once, right after
    # keeping the pawn at HUD_MATE (FWeakObjectPtr::operator=, R_WEAK_SET).
    code = " | ".join("%s %s" % (i.mnemonic, i.op_str) for i in ex.code(HUD_TICK, 0x200))
    flag = d["HUD_MATE_FOUND"]
    want = (r"cmp byte ptr \[rdi \+ 0x%x\], 1 \| je .*lea rcx, \[rdi \+ 0x%x\] \| mov rdx, rsi \| call 0x%x \| "
            r"mov byte ptr \[rdi \+ 0x%x\], 1" % (flag, d["HUD_MATE"], TW.BASE + d["R_WEAK_SET"], flag))
    if not re.search(want, code):
        sys.exit("FAIL the HUD panel tick at %x doesn't test and set +0x%x once" % (TW.BASE + HUD_TICK, flag))
    sets = [m.start() for m in re.finditer(rb"\xc6[\x80-\x87]" + struct.pack("<I", flag) + b"\x01",
                                           ex.d[ex.toff:ex.toff + ex.tsize])]
    if len(sets) != 1:
        sys.exit("FAIL +0x%x is set to 1 at %d places, not 1 (the panel's tick)" % (flag, len(sets)))
    print("ok    AVictoryPlayerHUD +0x%x: the teammate panel searches while it isn't 1, sets it once (VA %x)"
          % (flag, TW.BASE + HUD_TICK))
    # One start each (sd_spawn_bots' mode_starts): the game's start chooser walks GM_STARTS, skips
    # SpawnTag (GM_SPAWN_TAG) unless set, and takes a start whose Tags (A_TAGS) hold the FName
    # (R_FNAME, FNAME_ADD = 1) of one of GM_SPAWN_TAGS' strings; IsSpawnpointPreferred refuses a start
    # used once (+0x434), so past the free ones it falls back to a taken start.
    code = " | ".join("%s %s" % (i.mnemonic, i.op_str) for i in ex.code(CHOOSER, 0x420))
    fname = TW.BASE + d["R_FNAME"]
    for what, want in (
            ("the starts", r"cmp dword ptr \[rcx \+ 0x%x\], ebx .*mov rax, qword ptr \[r15 \+ 0x%x\]"
             % (d["GM_STARTS"] + 8, d["GM_STARTS"])),
            ("?SpawnTag=", r"cmp dword ptr \[r15 \+ 0x%x\], 1 \| jle .*mov rdx, qword ptr \[r15 \+ 0x%x\]"
             % (d["GM_SPAWN_TAG"] + 8, d["GM_SPAWN_TAG"])),
            ("SpawnPointTags", r"mov eax, dword ptr \[r15 \+ 0x%x\] .*mov rax, qword ptr \[r15 \+ 0x%x\]"
             % (d["GM_SPAWN_TAGS"] + 8, d["GM_SPAWN_TAGS"])),
            ("the tag's FName", r"mov r8d, %d \| lea rcx, \[rsp \+ 0x30\] \| cmovne rdx, rdi \| call 0x%x \| "
             r"mov rdx, qword ptr \[r13 \+ 0x%x\] \| movsxd rcx, dword ptr \[r13 \+ 0x%x\]"
             % (1, fname, d["A_TAGS"], d["A_TAGS"] + 8))):
        if not re.search(want, code):
            sys.exit("FAIL the start chooser at %x doesn't read %s as mode_starts does" % (TW.BASE + CHOOSER, what))
    pref = " | ".join("%s %s" % (i.mnemonic, i.op_str) for i in ex.code(PREFERRED, 0x1a0))
    if not re.search(r"cmp dword ptr \[r14 \+ 0x434\], 0 \| .*jle .*xor al, al", pref):
        sys.exit("FAIL IsSpawnpointPreferred at %x doesn't refuse a used start" % (TW.BASE + PREFERRED))
    print("ok    the start chooser (VA %x): the mode's starts by SpawnPointTags; a used start is only a fallback (VA %x)"
          % (TW.BASE + CHOOSER, TW.BASE + PREFERRED))
    # AController::Possess: its exec thunk calls vtable +V_POSSESS (the module possesses the
    # player's pawn again after the game's delayed spectating took it).
    poss = " | ".join("%s %s" % (i.mnemonic, i.op_str) for t in ex.natives("Possess") for i in ex.code(t, 0x100))
    if "call qword ptr [rax + 0x%x]" % d["V_POSSESS"] not in poss:
        sys.exit("FAIL AController::Possess is not vtable +0x%x" % d["V_POSSESS"])
    unposs = " | ".join("%s %s" % (i.mnemonic, i.op_str) for t in ex.natives("UnPossess") for i in ex.code(t, 0x100))
    if "[rax + 0x%x]" % d["V_UNPOSSESS"] not in unposs:
        sys.exit("FAIL AController::UnPossess is not vtable +0x%x" % d["V_UNPOSSESS"])
    print("ok    AController::Possess is vtable +0x%x, UnPossess +0x%x (their exec thunks)" % (d["V_POSSESS"], d["V_UNPOSSESS"]))
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    imm = set()
    for i in md.disasm(ROUNDS.BLOB[:ROUNDS.SD_SELF_RVA], 0):
        for h in re.findall(r"0x[0-9a-f]+", i.op_str):
            imm.add(int(h, 16))
    for k in ("C_CONTROL_ROT", "HUD_MATE_FOUND", "US_TELEPORT", "R_FNAME", "GM_STARTS", "GM_SPAWN_TAGS", "A_TAGS"):
        if d[k] not in imm:
            sys.exit("FAIL the blob doesn't use %s (0x%x)" % (k, d[k]))
    print("ok    the blob uses ControlRotation, the panel's flag and K2_TeleportTo")


def main():
    cl = BUILD.find_cl()
    env = dict(os.environ, PATH=os.path.dirname(cl) + os.pathsep + os.environ.get("PATH", ""))
    vc = os.path.abspath(os.path.join(os.path.dirname(cl), "..", "..", ".."))
    kits = r"C:\Program Files (x86)\Windows Kits\10"
    inc = [os.path.join(vc, "include")]
    lib = [os.path.join(vc, "lib", "x64")]
    for sub in ("ucrt", "um", "shared"):
        vers = sorted(os.listdir(os.path.join(kits, "Include"))) if os.path.isdir(os.path.join(kits, "Include")) else []
        if vers:
            inc.append(os.path.join(kits, "Include", vers[-1], sub))
            lib.append(os.path.join(kits, "Lib", vers[-1], sub, "x64"))
    env["INCLUDE"] = os.pathsep.join(p for p in inc + [env.get("INCLUDE", "")] if p)
    env["LIB"] = os.pathsep.join(p for p in lib + [env.get("LIB", "")] if p)
    with tempfile.TemporaryDirectory() as tmp:
        obj = os.path.join(tmp, "module.obj")
        exe = os.path.join(tmp, "test_native_module.exe")
        steps = ([cl] + BUILD.CL_FLAGS + ["/Fo" + obj, BUILD.SOURCE],
                 [cl, "/nologo", "/O1", "/W3", "/Fe" + exe, "/Fo" + os.path.join(tmp, "harness.obj"), HARNESS, obj])
        for cmd in steps:
            r = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, text=True)
            if r.returncode:
                sys.exit("build failed:\n" + r.stdout + r.stderr)
        r = subprocess.run([exe], capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        if r.returncode:
            sys.exit("native module tests failed (%d)" % r.returncode)
    path = sys.argv[1] if len(sys.argv) > 1 else STOCK_EXE
    if os.path.exists(path):
        exe_checks(path)
    else:
        print("skip game addresses (no %s)" % path)


if __name__ == "__main__":
    main()
