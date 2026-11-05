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

5. Showdown rounds (showdown_rounds.c, built by build_showdown_rounds.py into
   showdown_rounds_blob.py). A new section (.sdround, RVA 0x35b4000, after
   .reloc) holds a small native module, and two pointers lead to it:
   - AShooterGame_FreeForAll's vtable slot 282 (VA 0x1425a81e8, stock
     0x140244d30, the "should the match end" check AShooterGameMode::Tick
     calls once a second): in a Lightning-type match (Showdown) a round ends
     when one fighter is down, the screen goes black, both fighters are reset
     and respawned at the arena starts with the next kit, and only the 4th
     round win ends the match. Every other mode calls the stock function.
   - The native registration of KismetMathLibrary.RandomIntegerInRange (the
     "lea r8, exec" at VA 0x14172be72): in a Showdown match the one call
     RandomIntegerInRange(0, 6) - PlayerPawn's pick of the spawn-with melee
     weapon - returns the round's kit, the same for both fighters.
   - AShooterCharacter::SpawnStartingInventory's call of the
     GetSpawnWithWeaponClasses event (the "call" at VA 0x140267275): the
     module runs SpawnStartingInventory on the rival (a BasicBot, which has
     no such event and spawns with its own random loadout) after clearing its
     inventory, and this call then asks the player's pawn for the kit, so the
     rival gets the same armor, boost and weapon. Every other call is stock.
   The vtable slot already has a base relocation (the exe is ASLR-enabled), so
   the new value is relocated like the old one; the blob itself has no
   absolute addresses.

The bytes are checked first, so it only patches the exe it was written for and
is safe to run on an exe that already has it.

usage: python patch_exe.py <Victory.exe> [max contestants, default 24]
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import showdown_rounds_blob as ROUNDS  # noqa: E402

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


IMAGE_BASE = 0x140000000
ROUNDS_NAME = b".sdround"
ROUNDS_FLAGS = 0xE0000060           # code, initialized data, execute, read, write
STOCK_NUM_SECTIONS = 9
STOCK_IMAGE_SIZE = 0x35B4000
STOCK_FILE_SIZE = 0x332F400         # the end of .reloc's raw data
FFA_SLOT_AT = 0x25A71E8             # file offset of AShooterGame_FreeForAll vtable slot 282 (VA 0x1425a81e8)
FFA_SLOT = 0x140244D30
RAND_LEA_AT = 0x172B472             # file offset of "lea r8, [execRandomIntegerInRange]" (VA 0x14172be72)
RAND_LEA_VA = 0x14172BE72
RAND_LEA = bytes.fromhex("4c8d05b7af0c00")
SPAWN_WITH_CALL_AT = 0x266875       # file offset of "call 0x14030a460" (VA 0x140267275)
SPAWN_WITH_CALL_VA = 0x140267275
SPAWN_WITH_CALL = bytes.fromhex("e8e6310a00")


def _align(n, a):
    return (n + a - 1) // a * a


def rounds_layout():
    """What the rounds patch writes: (section header, raw data, slot value, lea bytes, image size,
    spawn-with call bytes)."""
    blob = ROUNDS.BLOB
    raw = blob + bytes(_align(len(blob), 0x200) - len(blob))
    header = ROUNDS_NAME + struct.pack("<IIIIIIHHI", len(blob), ROUNDS.SECTION_RVA, len(raw), STOCK_FILE_SIZE,
                                       0, 0, 0, 0, ROUNDS_FLAGS)
    slot = IMAGE_BASE + ROUNDS.SECTION_RVA + ROUNDS.SD_SHOULD_END
    target = IMAGE_BASE + ROUNDS.SECTION_RVA + ROUNDS.SD_RAND_EXEC
    lea = RAND_LEA[:3] + struct.pack("<i", target - (RAND_LEA_VA + len(RAND_LEA)))
    spawn_with = IMAGE_BASE + ROUNDS.SECTION_RVA + ROUNDS.SD_SPAWN_WITH
    call = b"\xe8" + struct.pack("<i", spawn_with - (SPAWN_WITH_CALL_VA + 5))
    return header, raw, slot, lea, ROUNDS.SECTION_RVA + _align(len(blob), 0x1000), call


def _pe(data, path):
    if data[:2] != b"MZ" or len(data) < 0x400:
        raise ValueError("%s is not the Victory.exe this patch is for (not a PE file)" % path)
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0" or struct.unpack_from("<H", data, pe + 4)[0] != 0x8664:
        raise ValueError("%s is not the Victory.exe this patch is for (not x64)" % path)
    optsz = struct.unpack_from("<H", data, pe + 20)[0]
    return pe, pe + 6, pe + 24 + 56, pe + 24 + optsz      # header, NumberOfSections, SizeOfImage, section table


def _rounds(data, path):
    pe, nsec_at, size_at, table = _pe(data, path)
    header, raw, slot, lea, image_size, call = rounds_layout()
    nsec = struct.unpack_from("<H", data, nsec_at)[0]
    at = table + 40 * STOCK_NUM_SECTIONS
    cur_slot = struct.unpack_from("<Q", data, FFA_SLOT_AT)[0] if len(data) >= FFA_SLOT_AT + 8 else None
    cur_lea = bytes(data[RAND_LEA_AT:RAND_LEA_AT + len(RAND_LEA)])
    cur_call = bytes(data[SPAWN_WITH_CALL_AT:SPAWN_WITH_CALL_AT + len(SPAWN_WITH_CALL)])
    if nsec == STOCK_NUM_SECTIONS:
        if (struct.unpack_from("<I", data, size_at)[0] != STOCK_IMAGE_SIZE or len(data) != STOCK_FILE_SIZE
                or cur_slot != FFA_SLOT or cur_lea != RAND_LEA or cur_call != SPAWN_WITH_CALL or any(data[at:at + 40])
                or at + 40 > struct.unpack_from("<I", data, pe + 24 + 60)[0]):
            raise ValueError("%s is not the Victory.exe this patch is for (Showdown rounds: section table, vtable "
                             "slot %s, RandomIntegerInRange %s or spawn-with call %s)"
                             % (path, cur_slot and hex(cur_slot), cur_lea.hex(), cur_call.hex()))
    elif nsec == STOCK_NUM_SECTIONS + 1 and data[at:at + 8] == ROUNDS_NAME:
        if (data[at:at + 40] == header and data[STOCK_FILE_SIZE:] == raw and cur_slot == slot and cur_lea == lea
                and cur_call == call and struct.unpack_from("<I", data, size_at)[0] == image_size):
            return False
        # An older build of the module: replace it. Its spawn-with call is
        # stock (builds before the rival's kit) or leads into the section.
        into = cur_call[:1] == b"\xe8" and (IMAGE_BASE + ROUNDS.SECTION_RVA <= SPAWN_WITH_CALL_VA + 5
                                            + struct.unpack_from("<i", cur_call, 1)[0] < IMAGE_BASE + image_size + 0x10000)
        if cur_call != SPAWN_WITH_CALL and not into:
            raise ValueError("%s is not the Victory.exe this patch is for (spawn-with call %s)" % (path, cur_call.hex()))
        del data[STOCK_FILE_SIZE:]
    else:
        raise ValueError("%s is not the Victory.exe this patch is for (%d sections)" % (path, nsec))
    struct.pack_into("<H", data, nsec_at, STOCK_NUM_SECTIONS + 1)
    struct.pack_into("<I", data, size_at, image_size)
    data[at:at + 40] = header
    data += raw
    struct.pack_into("<Q", data, FFA_SLOT_AT, slot)
    data[RAND_LEA_AT:RAND_LEA_AT + len(lea)] = lea
    data[SPAWN_WITH_CALL_AT:SPAWN_WITH_CALL_AT + len(call)] = call
    return True


def patch(path, contestants=MAX, rounds=True):
    """Apply every fix; returns True when the file changed."""
    if not STOCK <= contestants <= 64:
        raise ValueError("contestants must be 16-64")
    data = bytearray(open(path, "rb").read())
    changed = _cap(data, path, contestants)
    changed = _sha1(data, path) or changed
    changed = _slots(data, path) or changed
    changed = _duoteam(data, path) or changed
    if rounds:
        changed = _rounds(data, path) or changed
    if changed:
        with open(path, "wb") as f:
            f.write(data)
    return changed


if __name__ == "__main__":
    n = int(sys.argv[2]) if len(sys.argv) > 2 else MAX
    changed = patch(sys.argv[1], n)
    print("%s: up to %d players plus bots, SHA-1 crash fix, match URLs, team pairing, Showdown rounds%s"
          % (sys.argv[1], n, "" if changed else " (already)"))
