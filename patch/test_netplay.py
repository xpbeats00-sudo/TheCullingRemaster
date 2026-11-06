"""patch_netplay.py and build_netplay.py on a stand-in exe (the real bytes at
every offset the patch touches), and on the real Victory.exe when its path is
given.

usage: python test_netplay.py [Victory.exe]
"""
import os
import struct
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import patch_netplay as PN  # noqa: E402
import netplay_blob as NP  # noqa: E402
import build_netplay  # noqa: E402

IMAGE_BASE = 0x140000000
STUB_VA = 0x14143E6F0            # the shared "xor al,al; ret" the stock Listen call targets


def stand_in(path):
    """A file with the stock exe's PE layout where patch_netplay looks: 9
    sections, STOCK_FILE_SIZE bytes, the Listen call's stub bytes at their
    offset."""
    data = bytearray(PN.STOCK_FILE_SIZE)
    pe = 0x110
    data[0:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, pe)
    data[pe:pe + 4] = b"PE\0\0"
    struct.pack_into("<HH", data, pe + 4, 0x8664, PN.STOCK_NUM_SECTIONS)
    struct.pack_into("<H", data, pe + 20, 0xF0)
    struct.pack_into("<I", data, pe + 24 + 56, PN.STOCK_IMAGE_SIZE)
    struct.pack_into("<I", data, pe + 24 + 60, 0x600)       # SizeOfHeaders: room for a 10th header
    table = pe + 24 + 0xF0
    for i in range(PN.STOCK_NUM_SECTIONS):
        data[table + 40 * i:table + 40 * i + 8] = (".s%d" % i).encode().ljust(8, b"\0")
    data[PN.LISTEN_CALL_AT:PN.LISTEN_CALL_AT + 5] = PN.LISTEN_STUB_CALL
    open(path, "wb").write(data)


def _verify_patched(path):
    data = open(path, "rb").read()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    nsec_at, size_at = pe + 6, pe + 24 + 56
    table = pe + 24 + struct.unpack_from("<H", data, pe + 20)[0]
    at = table + 40 * PN.STOCK_NUM_SECTIONS
    header, raw, image_size, call = PN.layout()
    # 10 sections, bumped image size, the section header and its raw bytes appended.
    assert struct.unpack_from("<H", data, nsec_at)[0] == PN.STOCK_NUM_SECTIONS + 1
    assert struct.unpack_from("<I", data, size_at)[0] == image_size
    assert data[at:at + 40] == header
    assert data[PN.STOCK_FILE_SIZE:] == raw and len(data) == PN.STOCK_FILE_SIZE + len(raw)
    # The hook: a call to np_listen in the new section, with the right rel32.
    assert data[PN.LISTEN_CALL_AT:PN.LISTEN_CALL_AT + 5] == call
    target = PN.LISTEN_CALL_VA + 5 + struct.unpack_from("<i", call, 1)[0]
    assert target == IMAGE_BASE + NP.SECTION_RVA + NP.NP_LISTEN, hex(target)
    # np_self_rva in the blob holds its own RVA, so the module can recover the image base.
    off = PN.STOCK_FILE_SIZE + NP.NP_SELF_RVA
    assert struct.unpack_from("<Q", data, off)[0] == NP.SECTION_RVA + NP.NP_SELF_RVA


def test_stand_in():
    tmp = tempfile.mkdtemp()
    try:
        p = os.path.join(tmp, "Victory.exe")
        stand_in(p)
        st = PN.check(p)
        assert st == {"section": False, "hook": False}, st
        assert PN.patch(p) is True
        _verify_patched(p)
        st = PN.check(p)
        assert st == {"section": True, "hook": True}, st
        assert PN.patch(p) is False, "running it again changes nothing"
        print("stand-in: pass")
    finally:
        import shutil
        shutil.rmtree(tmp, ignore_errors=True)


def test_blob_is_position_independent():
    # The builder rejects any relocation that isn't REL32, so a successful
    # build proves the blob needs no base relocations. Rebuild and compare.
    blob, where = build_netplay.build()
    assert blob == NP.BLOB, "netplay_blob.py is OUT OF DATE (run build_netplay.py)"
    assert where["np_listen"] == NP.NP_LISTEN and where["np_self_rva"] == NP.NP_SELF_RVA
    print("blob: pass (%d bytes, position independent, up to date)" % len(blob))


def test_real_exe(path):
    data = open(path, "rb").read()
    # Re-derive the hook target from the stock exe: the Listen call must still
    # point at the shared return-false stub, and that stub must be xor al,al;ret.
    cur = data[PN.LISTEN_CALL_AT:PN.LISTEN_CALL_AT + 5]
    assert cur == PN.LISTEN_STUB_CALL, "Listen call bytes changed: %s" % cur.hex()
    target = PN.LISTEN_CALL_VA + 5 + struct.unpack_from("<i", cur, 1)[0]
    assert target == STUB_VA, hex(target)
    stub_off = PN.LISTEN_CALL_AT - (PN.LISTEN_CALL_VA - STUB_VA)
    assert data[stub_off:stub_off + 3] == bytes.fromhex("32c0c3"), "stub is not xor al,al;ret"
    assert struct.unpack_from("<H", data, struct.unpack_from("<I", data, 0x3C)[0] + 6)[0] == PN.STOCK_NUM_SECTIONS
    # Patch a copy and verify; stock is never written.
    import shutil
    tmp = tempfile.mkdtemp()
    try:
        copy = os.path.join(tmp, "Victory.exe")
        shutil.copyfile(path, copy)
        assert PN.patch(copy) is True
        _verify_patched(copy)
        assert PN.patch(copy) is False
        print("real exe: pass (Listen call %s -> stub %s confirmed; patched copy verified)"
              % (cur.hex(), hex(STUB_VA)))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    test_blob_is_position_independent()
    test_stand_in()
    if len(sys.argv) > 1:
        test_real_exe(sys.argv[1])
    else:
        print("real exe: skipped (pass its path to run it)")
    print("OK")
