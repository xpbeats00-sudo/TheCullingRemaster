"""Raise Victory.exe's limit on players plus bots in a match.

The game mode spawns min(BotsToSpawn, 16 - human players) bots
(AVictoryGameMode at VA 0x14023218a: mov eax, 16; sub eax, esi; cmovle). This
changes the 16. Jungle has 24 player starts, so 24 is the most it can place.

The bytes are checked first, so it only patches the exe it was written for and
is safe to run on an exe that already has it.

usage: python patch_exe.py <Victory.exe> [max contestants, default 24]
"""
import sys

CAP_AT = 0x231790                   # file offset of "mov eax, 16" (b8 10 00 00 00)
STOCK = 16
MAX = 24                            # Jungle_P's PlayerStarts


def patch(path, contestants=MAX):
    if not STOCK <= contestants <= 64:
        raise ValueError("contestants must be 16-64")
    data = bytearray(open(path, "rb").read())
    op = data[CAP_AT:CAP_AT + 5]
    if len(op) < 5 or op[0] != 0xB8 or op[2:] != b"\0\0\0" or not STOCK <= op[1] <= 64:
        raise ValueError("%s is not the Victory.exe this patch is for (found %s)" % (path, op.hex()))
    if op[1] == contestants:
        return False
    data[CAP_AT + 1] = contestants
    with open(path, "wb") as f:
        f.write(data)
    return True


if __name__ == "__main__":
    n = int(sys.argv[2]) if len(sys.argv) > 2 else MAX
    changed = patch(sys.argv[1], n)
    print("%s: up to %d players plus bots%s" % (sys.argv[1], n, "" if changed else " (already)"))
