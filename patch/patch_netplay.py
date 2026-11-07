"""Apply the listen-server module to a copy of Victory.exe (route B).

Standalone and separate from patch_exe.py (which owns the .sdround Showdown
module and showdown_rounds.c): this adds its own .netp section with the
netplay.c module and a handful of byte edits, so the two can be developed and
reviewed independently (see docs/DEDICATED_SERVER_IMPLEMENTATION.md). It is
never part of a release: build_release.py only runs its static tests.

Because both this and patch_exe.py append a 10th section at the stock
SizeOfImage, they are mutually exclusive on a single exe; this patch requires
the stock 9-section Steam exe. The stock exe is never written: callers patch a
copy (patch(dst)).

What it does, from exact stock bytes (each checked first):
  1. LoadMap's call of UWorld::Listen (VA 0x141644cef), stock target the
     shared "xor al,al; ret" stub 0x14143e6f0 -> np_listen.
  2. UWorld's FNetworkNotify vtable (VA 0x142b05cf0) slots 0, 1 and 3
     (NotifyAcceptingConnection, NotifyAcceptedConnection,
     NotifyControlMessage) -> the module's pass-through trace hooks. Each slot
     has a DIR64 base relocation, so the loader rebases the new pointer.
  2b. AShooterGame_FreeForAll's PreLogin slot (VA 0x1425a7fe0) -> np_prelogin,
     which skips the game's "Match is over!" refusal (a local match starts at
     once) and runs only AGameModeBase::PreLogin. For the test host only.
  3. UWorld::InternalGetNetMode (VA 0x1416848f0): this client-only build
     folded "NetDriver ? (IsRunningClientOnly() ? NM_Client : NetDriver->GetNetMode())"
     to "NetDriver ? NM_Client", so a world that listens would still call
     itself a client. Rewritten in place to return NetDriver->GetNetMode()
     (UNetDriver::GetNetMode 0x1414318f0 is intact: ServerConnection ? NM_Client
     : GIsClient ? NM_ListenServer : NM_DedicatedServer). For every world a
     stock client can have (no driver, or a driver with a ServerConnection)
     the result is unchanged.
  4. The same folded test inlined at VA 0x14167f027 and 0x14168c79f -> a
     jump to a small trampoline after the module that does the same.
  5. Append the .netp section (RVA 0x35b4000) holding the module and the
     trampolines; bump NumberOfSections (9 -> 10) and SizeOfImage.

Idempotent (running it again is a no-op). check(path) reports state without
changing the file.

usage: python patch_netplay.py <copy of Victory.exe>
       python patch_netplay.py --check <Victory.exe>
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import netplay_blob as NP  # noqa: E402

IMAGE_BASE = 0x140000000
SECTION_NAME = b".netp\0\0\0"
SECTION_FLAGS = 0xE0000060           # code, initialized data, execute, read, write
STOCK_NUM_SECTIONS = 9
STOCK_IMAGE_SIZE = 0x35B4000
STOCK_FILE_SIZE = 0x332F400          # end of .reloc's raw data == the new section's file offset
# Stock section layout (RVA, file offset, size) of .text and .rdata.
TEXT = (0x1000, 0x600, 0x253DA00)
RDATA = (0x253F000, 0x253E000, 0xB10600)

# 1. The LoadMap call of UWorld::Listen.
LISTEN_CALL_VA = 0x141644CEF
LISTEN_STUB_CALL = bytes.fromhex("e8fc99dfff")   # call 0x14143e6f0 (the return-false stub)
LISTEN_CALL_AT = 0x16442EF                       # its file offset (kept for netplay_check / old tests)

# 2. UWorld's FNetworkNotify vtable and the slots hooked.
NOTIFY_VTABLE_VA = 0x142B05CF0
NOTIFY_SLOTS = ((0, 0x1416858F0, "np_notify_accepting"),
                (1, 0x1411D9E00, "np_notify_accepted"),
                (3, 0x141685A90, "np_notify_control"))
# 2b. AShooterGame_FreeForAll's vtable slot +0x6c8 (PreLogin, VA 0x1425a7fe0): stock
# 0x140245320 (jmp AShooterGameMode::PreLogin, which refuses with "Match is over!")
# -> np_prelogin (only AGameModeBase::PreLogin's checks). Test exe only.
PRELOGIN_SLOT = (0x1425A7FE0, 0x140245320, "np_prelogin")
# 2c. USteamNetDriver's vtable slot +0x278 (TickFlush, VA 0x142e0ac10): stock 0x142335370
# -> np_tick_flush (the host's minimal ServerReplicateActors, a client's trace; then stock).
TICKFLUSH_SLOT = (0x142E0AC10, 0x142335370, "np_tick_flush")
# 2d. AShooterGame_FreeForAll's vtable slot 282 (+0x8d0, the end-of-match check, VA
# 0x1425a81e8): stock 0x140244d30 -> np_should_end (on a real host: the match goes on
# while two or more contestants, bots included, are alive; otherwise the stock check).
SHOULD_END_SLOT = (0x1425A81E8, 0x140244D30, "np_should_end")

# 3. UWorld::InternalGetNetMode, in place.
NETMODE_VA = 0x1416848F0
NETMODE_STOCK = bytes.fromhex("48837938007406b803000000c3")   # cmp [rcx+38h],0; je +6; mov eax,3; ret
NETMODE_NEW = bytes.fromhex("488b41384885c075100f1f4000")      # mov rax,[rcx+38h]; test rax,rax; jne 0x141684909; nop4
DRIVER_GET_NET_MODE = 0x1414318F0

# 4. The inlined copies: (VA, stock bytes up to the demo-driver path, base register code, demo path, join).
INLINE_SITES = ((0x14167F027, bytes.fromhex("48837938007407b803000000eb1b"), 1, 0x14167F035, 0x14167F050),
                (0x14168C79F, bytes.fromhex("4c3971387407b803000000eb1b"), 1, 0x14168C7AC, 0x14168C7C7))


def _align(n, a):
    return (n + a - 1) // a * a


def _off(va):
    rva = va - IMAGE_BASE
    for start, raw, size in (TEXT, RDATA):
        if start <= rva < start + size:
            return raw + rva - start
    raise ValueError("VA %#x outside .text/.rdata" % va)


def trampoline(at, base_reg, demo, join):
    """mov rax,[base+38h]; test rax,rax; jz demo; mov rcx,rax; call UNetDriver::GetNetMode; jmp join.
    `at` is the trampoline's own VA."""
    code = bytearray(b"\x48\x8b" + bytes([0x40 + base_reg]) + b"\x38" + b"\x48\x85\xc0")
    code += b"\x0f\x84" + struct.pack("<i", demo - (at + len(code) + 6))
    code += b"\x48\x89\xc1"
    code += b"\xe8" + struct.pack("<i", DRIVER_GET_NET_MODE - (at + len(code) + 5))
    code += b"\xe9" + struct.pack("<i", join - (at + len(code) + 5))
    return bytes(code)


def layout():
    """(section header, raw data, image size, [(file offset, stock bytes, new bytes)])."""
    sect_va = IMAGE_BASE + NP.SECTION_RVA
    content = bytearray(NP.BLOB)
    target = sect_va + NP.NP_LISTEN
    edits = [(_off(LISTEN_CALL_VA), LISTEN_STUB_CALL, b"\xe8" + struct.pack("<i", target - (LISTEN_CALL_VA + 5)))]
    for slot, stock_fn, entry in NOTIFY_SLOTS:
        edits.append((_off(NOTIFY_VTABLE_VA + 8 * slot), struct.pack("<Q", stock_fn),
                      struct.pack("<Q", sect_va + getattr(NP, entry.upper()))))
    for slot_va, stock_fn, entry in (PRELOGIN_SLOT, TICKFLUSH_SLOT, SHOULD_END_SLOT):
        edits.append((_off(slot_va), struct.pack("<Q", stock_fn), struct.pack("<Q", sect_va + getattr(NP, entry.upper()))))
    edits.append((_off(NETMODE_VA), NETMODE_STOCK, NETMODE_NEW))
    for va, stock, reg, demo, join in INLINE_SITES:
        while len(content) % 16:
            content.append(0xCC)
        tva = sect_va + len(content)
        content += trampoline(tva, reg, demo, join)
        jump = b"\xe9" + struct.pack("<i", tva - (va + 5))
        edits.append((_off(va), stock, jump + b"\xcc" * (len(stock) - 5)))
    raw = bytes(content) + bytes(_align(len(content), 0x200) - len(content))
    header = SECTION_NAME + struct.pack("<IIIIIIHHI", len(content), NP.SECTION_RVA, len(raw), STOCK_FILE_SIZE,
                                        0, 0, 0, 0, SECTION_FLAGS)
    image_size = NP.SECTION_RVA + _align(len(content), 0x1000)
    return header, raw, image_size, edits


def _pe(data, path):
    if data[:2] != b"MZ" or len(data) < 0x400:
        raise ValueError("%s is not the Victory.exe this patch is for (not a PE file)" % path)
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0" or struct.unpack_from("<H", data, pe + 4)[0] != 0x8664:
        raise ValueError("%s is not the Victory.exe this patch is for (not x64)" % path)
    optsz = struct.unpack_from("<H", data, pe + 20)[0]
    return pe, pe + 6, pe + 24 + 56, pe + 24 + optsz      # header, &NumberOfSections, &SizeOfImage, section table


def check(path):
    """{"section": bool, "edits": bool}: whether the .netp module and every
    byte edit are in place. Raises ValueError for an exe this patch isn't for
    (any edited range neither stock nor patched)."""
    data = bytearray(open(path, "rb").read())
    pe, nsec_at, size_at, table = _pe(data, path)
    header, raw, image_size, edits = layout()
    nsec = struct.unpack_from("<H", data, nsec_at)[0]
    at = table + 40 * STOCK_NUM_SECTIONS
    done = []
    for off, stock, new in edits:
        cur = bytes(data[off:off + len(stock)])
        if cur not in (stock, new):
            raise ValueError("%s is not the Victory.exe this patch is for (bytes at file offset %#x: %s)"
                             % (path, off, cur.hex()))
        done.append(cur == new)
    if nsec == STOCK_NUM_SECTIONS:
        if (struct.unpack_from("<I", data, size_at)[0] != STOCK_IMAGE_SIZE or len(data) != STOCK_FILE_SIZE
                or any(data[at:at + 40])):
            raise ValueError("%s is not the stock 9-section Victory.exe this patch is for" % path)
        return {"section": False, "edits": all(done)}
    if nsec == STOCK_NUM_SECTIONS + 1 and data[at:at + 8] == SECTION_NAME:
        section = (data[at:at + 40] == header and data[STOCK_FILE_SIZE:] == raw
                   and struct.unpack_from("<I", data, size_at)[0] == image_size)
        return {"section": section, "edits": all(done)}
    raise ValueError("%s is not the Victory.exe this patch is for (%d sections)" % (path, nsec))


def patch(path):
    """Apply the edits and the section to the file at path (a copy; never the
    stock exe). Returns True when the file changed. Idempotent."""
    data = bytearray(open(path, "rb").read())
    pe, nsec_at, size_at, table = _pe(data, path)
    header, raw, image_size, edits = layout()
    state = check(path)
    if state["section"] and state["edits"]:
        return False
    nsec = struct.unpack_from("<H", data, nsec_at)[0]
    at = table + 40 * STOCK_NUM_SECTIONS
    if nsec == STOCK_NUM_SECTIONS:
        if at + 40 > struct.unpack_from("<I", data, pe + 24 + 60)[0]:
            raise ValueError("no room in the section table for a 10th section header")
        struct.pack_into("<H", data, nsec_at, STOCK_NUM_SECTIONS + 1)
        struct.pack_into("<I", data, size_at, image_size)
        data[at:at + 40] = header
        data += raw
    for off, stock, new in edits:
        data[off:off + len(new)] = new
    tmp = path + ".patching"
    with open(tmp, "wb") as f:
        f.write(data)
    try:
        os.replace(tmp, path)
    except OSError:
        os.remove(tmp)
        raise
    return True


if __name__ == "__main__":
    if sys.argv[1:2] == ["--check"]:
        st = check(sys.argv[2])
        print("%s: section %s, edits %s" % (sys.argv[2], st["section"], st["edits"]))
        sys.exit(0 if st["section"] and st["edits"] else 1)
    changed = patch(sys.argv[1])
    print("%s: netplay module + edits%s" % (sys.argv[1], "" if changed else " (already)"))
