"""Apply the listen-server prototype to a copy of Victory.exe (route B, step 1).

Standalone and separate from patch_exe.py (which owns the .sdround Showdown
module and showdown_rounds.c): this adds its own .netp section with the
netplay.c module and repoints one call, so the two can be developed and
reviewed independently and merged later (see docs/NETPLAY_LISTEN_SERVER.md).

Because both this and patch_exe.py append a 10th section at the stock
SizeOfImage, they are mutually exclusive on a single exe for now; this patch
requires the stock 9-section Steam exe. The stock exe is never written: callers
patch a copy (patch(dst)).

What it does, from exact stock bytes:
  1. Repoint UEngine::LoadMap's call of UWorld::Listen at VA 0x141644cef (file
     offset 0x16442ef), which in this build targets the shared "xor al,al; ret"
     stub 0x14143e6f0, to np_listen in the new section.
  2. Append a .netp section (RVA 0x35b4000) holding netplay_blob.BLOB, and bump
     NumberOfSections (9 -> 10) and SizeOfImage.

The bytes are checked first, so it only patches the exe it was written for and
is idempotent (running it again is a no-op). check(path) reports state without
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
STOCK_FILE_SIZE = 0x332F400          # end of .reloc's raw data == SECTION_RVA's file offset

# The LoadMap call of UWorld::Listen.
LISTEN_CALL_AT = 0x16442EF           # file offset
LISTEN_CALL_VA = 0x141644CEF
LISTEN_STUB_CALL = bytes.fromhex("e8fc99dfff")   # call 0x14143e6f0 (the return-false stub)


def _align(n, a):
    return (n + a - 1) // a * a


def layout():
    """(section header, raw data, image size, patched call bytes)."""
    blob = NP.BLOB
    raw = blob + bytes(_align(len(blob), 0x200) - len(blob))
    header = SECTION_NAME + struct.pack("<IIIIIIHHI", len(blob), NP.SECTION_RVA, len(raw), STOCK_FILE_SIZE,
                                        0, 0, 0, 0, SECTION_FLAGS)
    image_size = NP.SECTION_RVA + _align(len(blob), 0x1000)
    target = IMAGE_BASE + NP.SECTION_RVA + NP.NP_LISTEN
    call = b"\xe8" + struct.pack("<i", target - (LISTEN_CALL_VA + 5))
    return header, raw, image_size, call


def _pe(data, path):
    if data[:2] != b"MZ" or len(data) < 0x400:
        raise ValueError("%s is not the Victory.exe this patch is for (not a PE file)" % path)
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    if data[pe:pe + 4] != b"PE\0\0" or struct.unpack_from("<H", data, pe + 4)[0] != 0x8664:
        raise ValueError("%s is not the Victory.exe this patch is for (not x64)" % path)
    optsz = struct.unpack_from("<H", data, pe + 20)[0]
    return pe, pe + 6, pe + 24 + 56, pe + 24 + optsz      # header, &NumberOfSections, &SizeOfImage, section table


def check(path):
    """{"section": bool, "hook": bool}: whether the .netp module and the Listen
    hook are in place. Raises ValueError for an exe this patch isn't for."""
    data = bytearray(open(path, "rb").read())
    pe, nsec_at, size_at, table = _pe(data, path)
    header, raw, image_size, call = layout()
    nsec = struct.unpack_from("<H", data, nsec_at)[0]
    at = table + 40 * STOCK_NUM_SECTIONS
    cur_call = bytes(data[LISTEN_CALL_AT:LISTEN_CALL_AT + 5])
    if cur_call not in (LISTEN_STUB_CALL, call):
        raise ValueError("%s is not the Victory.exe this patch is for (Listen call %s)" % (path, cur_call.hex()))
    if nsec == STOCK_NUM_SECTIONS:
        if (struct.unpack_from("<I", data, size_at)[0] != STOCK_IMAGE_SIZE or len(data) != STOCK_FILE_SIZE
                or any(data[at:at + 40])):
            raise ValueError("%s is not the stock 9-section Victory.exe this patch is for" % path)
        return {"section": False, "hook": cur_call == call}
    if nsec == STOCK_NUM_SECTIONS + 1 and data[at:at + 8] == SECTION_NAME:
        section = (data[at:at + 40] == header and data[STOCK_FILE_SIZE:] == raw
                   and struct.unpack_from("<I", data, size_at)[0] == image_size)
        return {"section": section, "hook": cur_call == call}
    raise ValueError("%s is not the Victory.exe this patch is for (%d sections)" % (path, nsec))


def patch(path):
    """Apply the hook and the section to the file at path (a copy; never the
    stock exe). Returns True when the file changed. Idempotent."""
    data = bytearray(open(path, "rb").read())
    pe, nsec_at, size_at, table = _pe(data, path)
    header, raw, image_size, call = layout()
    state = check(path)
    if state["section"] and state["hook"]:
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
    data[LISTEN_CALL_AT:LISTEN_CALL_AT + 5] = call
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
        print("%s: section %s, hook %s" % (sys.argv[2], st["section"], st["hook"]))
        sys.exit(0 if st["section"] and st["hook"] else 1)
    changed = patch(sys.argv[1])
    print("%s: listen hook + .netp module%s" % (sys.argv[1], "" if changed else " (already)"))
