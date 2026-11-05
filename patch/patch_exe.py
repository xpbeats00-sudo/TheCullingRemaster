"""Victory.exe fixes for the Remaster release.

1. Contestant cap. The game mode spawns min(BotsToSpawn, 16 - human players)
   bots (AVictoryGameMode at VA 0x14023218a: mov eax, 16; sub eax, esi;
   cmovle). This changes the 16. Jungle has 24 player starts, so 24 is the
   most it can place.

2. SHA-1 crash on newer CPUs. The exe links OpenSSL 1.0.2g. On a CPU with the
   SHA instructions (Intel 11th gen and later, AMD Zen), its SHA-1 dispatcher
   (sha1_block_data_order, VA 0x14004bd0d) jumps to the SHA-extension routine
   without setting rax, which that routine uses as its frame pointer
   (movaps [rax-0x48], ...). The game then crashes with an access violation
   at VA 0x14004d063 the first time it hashes with SHA-1 (seen when the Duo
   mode starts). This NOPs that jump (test r10d, 0x20000000; jne) so SHA-1
   takes the SSSE3/AVX path, the one every CPU without SHA instructions
   already uses. Hashes are identical; only the code path changes.

3. More match slots. The menu's StartTraining(name) (VA 0x1401ea220) opens
   one of four DefaultGame.ini URLs (Tutorial, Practice, SurvivalBasic,
   SurvivalAdvanced) through the game's own "open <url>?bExitOnRoundComplete
   =true" helper (VA 0x1401e4630, the one Solo uses too) and does nothing for
   any other name. Now any other name is itself the URL: the last compare's
   "jne done" goes to a 5-byte stub in the function's int3 padding that passes
   the argument (r15, the FString) to the same helper call. The four names
   are unchanged, so the SURVIVAL screen keeps its slots, and Duo and Showdown
   open their own URLs (make_duo.py, make_showdown.py). The stock menu only
   ever passes the four names.

4. Pairs teams locally. Which team a contestant is on is VictoryPlayerState's
   TeamNumber (offset +0x490; read by GetTeamNum VA 0x140249320, written by
   SetTeamNum VA 0x14024e7e0). The in-world TEAM/KILLS/STATUS board groups by
   it (SetTeamNum also writes the board's scoreboard entry via 0x140243680)
   and the Duo teammate HUD matches players whose TeamNumber is equal and > 0
   (AVictoryPlayerHUD tick VA 0x1401fbea1). The stock game only ever assigns
   TeamNumber through the online team subsystem (0x1401f2de0, from matchmaking
   partners); in a local match that subsystem is empty, so nobody gets a team
   and the board stays blank with no teammate. This detours the scoreboard
   refresh (VA 0x140203b3a, where GameState is live, just before the sort at
   0x140243c80) to a stub in the int3 padding at VA 0x14005ac03. The stub,
   ONLY when GameState.GameModeType == ClassicTeams (byte +0x4e4 == 2, i.e.
   the pairs modes CoopRanked/Coop; Solo=1, Lightning/Showdown=3 and the rest
   are left untouched), walks GameState.PlayerArray (ptr +0x418, count +0x420)
   and calls SetTeamNum(playerState, (index >> 1) + 1, true) so contestants
   pair up (0,1 -> team 1; 2,3 -> team 2; ...), then runs the original sort.
   It reasserts each refresh, so join order and timing don't matter.

The bytes are checked first, so it only patches the exe it was written for and
is safe to run on an exe that already has it. The file is rewritten through a
temporary file swapped in whole (os.replace): writing it in place would also
rewrite every hard link of it (a release's files are hard links of the install).

check(path) only reads: which fixes the exe has. verify(path) is what
make_release.py asserts on the exe it ships: every fix, and exactly the bytes
of the stock Steam exe (STOCK_SHA256) with these fixes (PATCHED_SHA256).

usage: python patch_exe.py <Victory.exe> [max contestants, default 24]
       python patch_exe.py --check <Victory.exe>
"""
import hashlib
import os
import sys

CAP_AT = 0x231790                   # file offset of "mov eax, 16" (b8 10 00 00 00)
STOCK = 16
MAX = 24                            # Jungle_P's PlayerStarts

SHA_GATE_AT = 0x4B334               # file offset of "test r10d, 0x20000000"
SHA_GATE = bytes.fromhex("41f7c200000020")
SHA_JUMP = bytes.fromhex("0f8595100000")   # jne 0x14004cdd6 (the SHA-extension routine)
NOPS = b"\x90" * len(SHA_JUMP)

TRAIN_CALL_AT = 0x1E9A92            # file offset of "mov rcx, rdi; call 0x1401e4630" (the open helper)
TRAIN_CALL = bytes.fromhex("488bcfe896a1ffff")
TRAIN_JUMP_AT = 0x1E9A89            # "jne 0x1401ea49a" after the SurvivalAdvanced compare
TRAIN_JUMP = bytes.fromhex("750f")
TRAIN_JUMP_NEW = bytes.fromhex("7528")    # jne 0x1401ea4b3 (the stub)
TRAIN_STUB_AT = 0x1E9AB3            # the 13 int3 bytes after StartTraining
TRAIN_STUB = bytes.fromhex("4c89faebda")  # mov rdx, r15; jmp 0x1401ea492
PAD = b"\xcc" * 13

# 4. Local team pairing (see the module docstring).
DUO_HOOK_AT = 0x20313A              # file offset of "mov rcx, rax; call 0x140243c80" (VA 0x140203b3a)
DUO_HOOK = bytes.fromhex("488bc8e83e010400")
DUO_HOOK_NEW = bytes.fromhex("e8c470e5ff909090")   # call 0x14005ac03 (the stub); nop; nop; nop
DUO_STUB_AT = 0x5A203               # int3 padding at VA 0x14005ac03 (253 bytes free)
# push rbx/rsi/r12/r13; sub rsp,0x28; r12=GameState; if [+0x4e4]!=2 skip; loop
# PlayerArray[+0x418] (count [+0x420]) -> SetTeamNum(PS,(i>>1)+1,1); then the sort.
DUO_STUB = bytes.fromhex(
    "5356415441554883ec284989fc0fb687e40400003c0275324d8bac2418040000"
    "418b9c242004000031f639de7d1c498b4cf5004885c9740e89f2d1eaffc241b0"
    "01e8973b1f00ffc6ebe04c89e1e82b901e004c89e74883c428415d415c5e5bc3")
DUO_PAD = b"\xcc" * len(DUO_STUB)

# The Steam build of Victory.exe this patch is for, and the same exe with every
# fix at the default 24 contestants (what a release ships).
STOCK_SHA256 = "bd818b91d78d99620ff1d003672282fcf7aa23832863a2e93449c945e0ff8758"
PATCHED_SHA256 = "489950775e7ed69ad9a593493988eac625067f4aa07ed70a5b0ad2c3ab405593"


def _cap(data, path, contestants):
    op = data[CAP_AT:CAP_AT + 5]
    if len(op) < 5 or op[0] != 0xB8 or op[2:] != b"\0\0\0" or not STOCK <= op[1] <= 64:
        raise ValueError("%s is not the Victory.exe this patch is for (found %s)" % (path, op.hex()))
    if op[1] == contestants:
        return False
    data[CAP_AT + 1] = contestants
    return True


def _sha1(data, path):
    at = SHA_GATE_AT + len(SHA_GATE)
    if data[SHA_GATE_AT:at] != SHA_GATE:
        raise ValueError("%s is not the Victory.exe this patch is for (SHA-1 gate %s)"
                         % (path, data[SHA_GATE_AT:at].hex()))
    jump = data[at:at + len(SHA_JUMP)]
    if jump == NOPS:
        return False
    if jump != SHA_JUMP:
        raise ValueError("%s is not the Victory.exe this patch is for (SHA-1 jump %s)" % (path, jump.hex()))
    data[at:at + len(SHA_JUMP)] = NOPS
    return True


def _slots(data, path):
    if data[TRAIN_CALL_AT:TRAIN_CALL_AT + len(TRAIN_CALL)] != TRAIN_CALL:
        raise ValueError("%s is not the Victory.exe this patch is for (StartTraining call)" % path)
    jump = bytes(data[TRAIN_JUMP_AT:TRAIN_JUMP_AT + 2])
    pad = bytes(data[TRAIN_STUB_AT:TRAIN_STUB_AT + len(PAD)])
    if jump == TRAIN_JUMP_NEW and pad == TRAIN_STUB + PAD[len(TRAIN_STUB):]:
        return False
    if jump != TRAIN_JUMP or pad != PAD:
        raise ValueError("%s is not the Victory.exe this patch is for (StartTraining %s / %s)" % (path, jump.hex(), pad.hex()))
    data[TRAIN_STUB_AT:TRAIN_STUB_AT + len(TRAIN_STUB)] = TRAIN_STUB
    data[TRAIN_JUMP_AT:TRAIN_JUMP_AT + 2] = TRAIN_JUMP_NEW
    return True


def _duoteam(data, path):
    hook = bytes(data[DUO_HOOK_AT:DUO_HOOK_AT + len(DUO_HOOK)])
    stub = bytes(data[DUO_STUB_AT:DUO_STUB_AT + len(DUO_STUB)])
    if hook == DUO_HOOK_NEW and stub == DUO_STUB:
        return False
    if hook != DUO_HOOK or stub != DUO_PAD:
        raise ValueError("%s is not the Victory.exe this patch is for (team pairing %s / %s)"
                         % (path, hook.hex(), stub[:8].hex()))
    data[DUO_STUB_AT:DUO_STUB_AT + len(DUO_STUB)] = DUO_STUB
    data[DUO_HOOK_AT:DUO_HOOK_AT + len(DUO_HOOK)] = DUO_HOOK_NEW
    return True


def _read(path):
    with open(path, "rb") as f:
        return bytearray(f.read())


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for block in iter(lambda: f.read(1 << 20), b""):
            h.update(block)
    return h.hexdigest()


def check(path):
    """Which fixes the exe has, without changing it:
    {"cap": contestants, "sha1": bool, "slots": bool, "duoteam": bool}.
    Raises ValueError for an exe this patch isn't for."""
    data = _read(path)
    _cap(bytearray(data), path, MAX)                    # raises for another exe
    return {"cap": data[CAP_AT + 1],
            "sha1": not _sha1(bytearray(data), path),     # nothing to change = already fixed
            "slots": not _slots(bytearray(data), path),
            "duoteam": not _duoteam(bytearray(data), path)}


def verify(path, contestants=MAX):
    """Raises ValueError unless the exe has every fix (cap = contestants) and,
    at the default cap, is byte for byte the patched Steam exe."""
    fixes = check(path)
    missing = [name for name, ok in (("contestant cap %d (has %d)" % (contestants, fixes["cap"]), fixes["cap"] == contestants),
                                     ("the SHA-1 crash fix", fixes["sha1"]),
                                     ("the StartTraining URL slots", fixes["slots"]),
                                     ("the Duo team pairing", fixes["duoteam"])) if not ok]
    if missing:
        raise ValueError("%s lacks %s" % (path, ", ".join(missing)))
    if contestants == MAX:
        digest = sha256(path)
        if digest != PATCHED_SHA256:
            raise ValueError("%s has the fixes but isn't the patched Steam exe (SHA-256 %s, expected %s)"
                             % (path, digest, PATCHED_SHA256))
    return fixes


def patch(path, contestants=MAX):
    """Apply every fix; returns True when the file changed."""
    if not STOCK <= contestants <= 64:
        raise ValueError("contestants must be 16-64")
    data = _read(path)
    changed = _cap(data, path, contestants)
    changed = _sha1(data, path) or changed
    changed = _slots(data, path) or changed
    changed = _duoteam(data, path) or changed
    if changed:
        # A new file swapped in whole: the old file (and any hard link of it) is never written.
        tmp = path + ".patching"
        with open(tmp, "wb") as f:
            f.write(data)
        try:
            os.replace(tmp, path)
        except OSError:
            os.remove(tmp)
            raise
    return changed


if __name__ == "__main__":
    if sys.argv[1:2] == ["--check"]:
        fixes = check(sys.argv[2])
        digest = sha256(sys.argv[2])
        kind = {STOCK_SHA256: "the stock Steam exe",
                PATCHED_SHA256: "the patched Steam exe (what a release ships)"}.get(digest, "not a known build")
        print("%s: cap %d, SHA-1 fix %s, StartTraining URLs %s, Duo team pairing %s; SHA-256 %s (%s)"
              % (sys.argv[2], fixes["cap"], fixes["sha1"], fixes["slots"], fixes["duoteam"], digest, kind))
        sys.exit(0 if fixes["cap"] == MAX and fixes["sha1"] and fixes["slots"] and fixes["duoteam"] else 1)
    n = int(sys.argv[2]) if len(sys.argv) > 2 else MAX
    changed = patch(sys.argv[1], n)
    print("%s: up to %d players plus bots, SHA-1 crash fix, match URLs, team pairing%s" % (sys.argv[1], n, "" if changed else " (already)"))
