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

The bytes are checked first, so it only patches the exe it was written for and
is safe to run on an exe that already has it.

usage: python patch_exe.py <Victory.exe> [max contestants, default 24]
"""
import sys

CAP_AT = 0x231790                   # file offset of "mov eax, 16" (b8 10 00 00 00)
STOCK = 16
MAX = 24                            # Jungle_P's PlayerStarts

SHA_GATE_AT = 0x4B334               # file offset of "test r10d, 0x20000000"
SHA_GATE = bytes.fromhex("41f7c200000020")
SHA_JUMP = bytes.fromhex("0f8595100000")   # jne 0x14004cdd6 (the SHA-extension routine)
NOPS = b"\x90" * len(SHA_JUMP)


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


def patch(path, contestants=MAX):
    """Apply both fixes; returns True when the file changed."""
    if not STOCK <= contestants <= 64:
        raise ValueError("contestants must be 16-64")
    data = bytearray(open(path, "rb").read())
    changed = _cap(data, path, contestants)
    changed = _sha1(data, path) or changed
    if changed:
        with open(path, "wb") as f:
            f.write(data)
    return changed


if __name__ == "__main__":
    n = int(sys.argv[2]) if len(sys.argv) > 2 else MAX
    changed = patch(sys.argv[1], n)
    print("%s: up to %d players plus bots, SHA-1 crash fix%s" % (sys.argv[1], n, "" if changed else " (already)"))
