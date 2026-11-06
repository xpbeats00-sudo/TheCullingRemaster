"""patch_netplay.py and build_netplay.py: on a stand-in exe (the stock bytes at
every offset the patch edits), and on the real Victory.exe when its path is
given.

On the real exe it re-derives every fact the patch relies on from the stock
bytes:
- LoadMap's Listen call targets the shared "xor al,al; ret" stub;
- UWorld's FNetworkNotify vtable slots hold the stock functions, and each has a
  DIR64 base relocation (so the loader rebases the module's pointers);
- UWorld::InternalGetNetMode is the folded "NetDriver ? NM_Client" and its
  demo-driver path calls UNetDriver::GetNetMode with the driver in rax/rcx;
- the two inlined copies have the same shape, with their demo path and join
  where the trampolines go;
- UNetDriver::GetNetMode is "ServerConnection ? NM_Client : GIsClient ?
  NM_ListenServer : NM_DedicatedServer".
Then it patches a copy and checks the result. The stock exe is never written.

usage: python test_netplay.py [Victory.exe]
"""
import os
import shutil
import struct
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import patch_netplay as PN  # noqa: E402
import netplay_blob as NP  # noqa: E402
import build_netplay  # noqa: E402

IMAGE_BASE = 0x140000000
STUB_VA = 0x14143E6F0            # the shared "xor al,al; ret" the stock Listen call targets


def _stock_edits():
    """[(file offset, stock bytes)] of every edit, from the patch's own layout."""
    return [(off, stock) for off, stock, new in PN.layout()[3]]


def stand_in(path):
    """A file with the stock exe's PE layout where patch_netplay looks: 9
    sections, STOCK_FILE_SIZE bytes, and the stock bytes at every edited
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
    for off, stock in _stock_edits():
        data[off:off + len(stock)] = stock
    open(path, "wb").write(data)


def _verify_patched(path):
    data = open(path, "rb").read()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    nsec_at, size_at = pe + 6, pe + 24 + 56
    table = pe + 24 + struct.unpack_from("<H", data, pe + 20)[0]
    at = table + 40 * PN.STOCK_NUM_SECTIONS
    header, raw, image_size, edits = PN.layout()
    sect_va = IMAGE_BASE + NP.SECTION_RVA
    # 10 sections, the bumped image size, the section header and its raw bytes appended.
    assert struct.unpack_from("<H", data, nsec_at)[0] == PN.STOCK_NUM_SECTIONS + 1
    assert struct.unpack_from("<I", data, size_at)[0] == image_size
    assert data[at:at + 40] == header
    assert data[PN.STOCK_FILE_SIZE:] == raw and len(data) == PN.STOCK_FILE_SIZE + len(raw)
    for off, stock, new in edits:
        assert data[off:off + len(new)] == new, "edit at %#x not applied" % off
    # 1. The Listen call goes to np_listen.
    call = data[PN.LISTEN_CALL_AT:PN.LISTEN_CALL_AT + 5]
    assert call[0] == 0xE8
    assert PN.LISTEN_CALL_VA + 5 + struct.unpack_from("<i", call, 1)[0] == sect_va + NP.NP_LISTEN
    # 2. Each notify slot points at its hook in the module.
    for slot, stock_fn, entry in PN.NOTIFY_SLOTS:
        got = struct.unpack_from("<Q", data, PN._off(PN.NOTIFY_VTABLE_VA + 8 * slot))[0]
        assert got == sect_va + getattr(NP, entry.upper()), (slot, hex(got))
    # 3. InternalGetNetMode: driver ? jump to its "mov rcx, rax; jmp GetNetMode" : the stock demo path.
    nm = data[PN._off(PN.NETMODE_VA):PN._off(PN.NETMODE_VA) + len(PN.NETMODE_NEW)]
    assert nm == PN.NETMODE_NEW
    assert PN.NETMODE_VA + 9 + nm[8] == PN.NETMODE_VA + 0x19       # jne -> 0x141684909
    # 4. Each inlined copy jumps to a trampoline in the section that ends in a jmp to its join.
    for va, stock, reg, demo, join in PN.INLINE_SITES:
        j = data[PN._off(va):PN._off(va) + 5]
        assert j[0] == 0xE9
        tva = va + 5 + struct.unpack_from("<i", j, 1)[0]
        assert sect_va <= tva < sect_va + len(raw)
        want = PN.trampoline(tva, reg, demo, join)
        at = PN.STOCK_FILE_SIZE + tva - sect_va
        assert data[at:at + len(want)] == want, "trampoline for %#x" % va
    # np_self_rva in the blob holds its own RVA, so the module can recover the image base.
    off = PN.STOCK_FILE_SIZE + NP.NP_SELF_RVA
    assert struct.unpack_from("<Q", data, off)[0] == NP.SECTION_RVA + NP.NP_SELF_RVA


def test_trampolines():
    # The code a trampoline holds, decoded by hand: the driver test, the demo
    # path, GetNetMode with the driver in rcx, the join.
    for va, stock, reg, demo, join in PN.INLINE_SITES:
        at = 0x1435B5000
        t = PN.trampoline(at, reg, demo, join)
        assert t[:4] == bytes([0x48, 0x8B, 0x40 + reg, 0x38]) and t[4:7] == b"\x48\x85\xc0"
        assert t[7:9] == b"\x0f\x84" and at + 13 + struct.unpack_from("<i", t, 9)[0] == demo
        assert t[13:16] == b"\x48\x89\xc1"
        assert t[16] == 0xE8 and at + 21 + struct.unpack_from("<i", t, 17)[0] == PN.DRIVER_GET_NET_MODE
        assert t[21] == 0xE9 and at + 26 + struct.unpack_from("<i", t, 22)[0] == join
    print("trampolines: pass (driver test, demo path, GetNetMode, join)")


def test_stand_in():
    tmp = tempfile.mkdtemp()
    try:
        p = os.path.join(tmp, "Victory.exe")
        stand_in(p)
        st = PN.check(p)
        assert st == {"section": False, "edits": False}, st
        assert PN.patch(p) is True
        _verify_patched(p)
        st = PN.check(p)
        assert st == {"section": True, "edits": True}, st
        assert PN.patch(p) is False, "running it again changes nothing"
        # A file whose bytes are neither stock nor patched is refused.
        bad = os.path.join(tmp, "Other.exe")
        stand_in(bad)
        d = bytearray(open(bad, "rb").read())
        d[PN._off(PN.NETMODE_VA)] ^= 0xFF
        open(bad, "wb").write(d)
        try:
            PN.check(bad)
            raise AssertionError("an unknown exe was accepted")
        except ValueError:
            pass
        print("stand-in: pass (%d edits, idempotent, refuses an unknown exe)" % len(_stock_edits()))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_blob_is_position_independent():
    # The builder rejects any relocation that isn't REL32, so a successful
    # build proves the blob needs no base relocations. Rebuild and compare.
    blob, where = build_netplay.build()
    assert blob == NP.BLOB, "netplay_blob.py is OUT OF DATE (run build_netplay.py)"
    assert where["np_listen"] == NP.NP_LISTEN and where["np_self_rva"] == NP.NP_SELF_RVA
    for slot, stock_fn, entry in PN.NOTIFY_SLOTS:
        assert where[entry] == getattr(NP, entry.upper()), entry
    print("blob: pass (%d bytes, position independent, up to date)" % len(blob))


def _dir64_relocs(data, off, size):
    """Set of RVAs with an IMAGE_REL_BASED_DIR64 entry in the .reloc data at off."""
    out, p, end = set(), off, off + size
    while p + 8 <= end:
        page, block = struct.unpack_from("<II", data, p)
        if block < 8:
            break
        for i in range((block - 8) // 2):
            e = struct.unpack_from("<H", data, p + 8 + 2 * i)[0]
            if e >> 12 == 10:
                out.add(page + (e & 0xFFF))
        p += block
    return out


def _iat_names(data, sects):
    """{IAT slot RVA: (dll, function)} from the PE import directory."""
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    imp_rva = struct.unpack_from("<I", data, pe + 24 + 112 + 8)[0]   # DataDirectory[1] (PE32+)

    def off(rva):
        for vs, va, rs, ro in sects.values():
            if va <= rva < va + max(vs, rs):
                return ro + rva - va
        raise ValueError(hex(rva))

    def cstr(rva):
        o = off(rva)
        return data[o:data.index(b"\0", o)].decode("ascii")

    out, d = {}, off(imp_rva)
    while True:
        ilt, _, _, name, iat = struct.unpack_from("<IIIII", data, d)
        if not name:
            break
        dll, i = cstr(name), 0
        while True:
            e = struct.unpack_from("<Q", data, off(ilt or iat) + 8 * i)[0]
            if not e:
                break
            if not e >> 63:
                out[iat + 8 * i] = (dll, cstr((e & 0x7FFFFFFF) + 2))
            i += 1
        d += 20
    return out


def test_real_exe(path):
    data = open(path, "rb").read()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    assert struct.unpack_from("<H", data, pe + 6)[0] == PN.STOCK_NUM_SECTIONS, "not the stock 9-section exe"
    table = pe + 24 + struct.unpack_from("<H", data, pe + 20)[0]
    sects = {data[table + 40 * i:table + 40 * i + 8].rstrip(b"\0"): struct.unpack_from("<IIII", data, table + 40 * i + 8)
             for i in range(PN.STOCK_NUM_SECTIONS)}
    rvs, rva, rrs, rro = sects[b".reloc"]
    # 0. The kernel32 import slots the module's trace calls through (netplay.c IAT_*).
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "netplay.c"), encoding="utf-8").read()
    iat = _iat_names(data, sects)
    want = {"IAT_WRITEFILE": "WriteFile", "IAT_GETENVW": "GetEnvironmentVariableW",
            "IAT_CREATEFILEW": "CreateFileW", "IAT_GETTICKCOUNT": "GetTickCount"}
    import re as _re
    for macro, fn in want.items():
        slot = int(_re.search(r"#define %s\s+(0x[0-9a-f]+)" % macro, src).group(1), 16)
        assert iat.get(slot) == ("KERNEL32.dll", fn), "%s %#x is %s, not %s" % (macro, slot, iat.get(slot), fn)
    for name, (start, raw, size) in ((b".text", PN.TEXT), (b".rdata", PN.RDATA)):
        assert (sects[name][1], sects[name][3]) == (start, raw), name
    # 0b. np_listen's LAN branch for the Steam driver: USteamNetDriver::InitListen sets
    # bIsPassthrough (+0x438) = 1 on its LAN path and tail-jumps to UIpNetDriver::InitListen,
    # and the Steam driver's vtable (seen in game, RVA 0x2e0a998) holds it at +0x220.
    def mac(name):
        return int(_re.search(r"#define %s\s+(0x[0-9a-f]+)" % name, src).group(1), 16)
    steam, ip, flag = mac("R_STEAM_INITLISTEN"), mac("R_IP_INITLISTEN"), mac("O_STEAM_PASSTHRU")
    s = data[PN._off(IMAGE_BASE + steam):PN._off(IMAGE_BASE + steam) + 0x11c]
    lan = bytes.fromhex("c683") + struct.pack("<I", flag) + b"\x01"
    assert lan in s, "Steam InitListen: no mov byte [rbx+%#x],1" % flag
    j = s.rindex(b"\xe9")
    assert IMAGE_BASE + steam + j + 5 + struct.unpack_from("<i", s, j + 1)[0] == IMAGE_BASE + ip, \
        "Steam InitListen doesn't end in a jmp to UIpNetDriver::InitListen"
    assert struct.unpack_from("<Q", data, PN._off(IMAGE_BASE + 0x2E0A998 + 0x220))[0] == IMAGE_BASE + steam, \
        "the Steam driver's vtable +0x220 isn't its InitListen"
    ipb = data[PN._off(IMAGE_BASE + ip):PN._off(IMAGE_BASE + ip) + 16]
    assert ipb[:5] in (bytes.fromhex("48895c2408"), bytes.fromhex("4c8bdc4989")) or ipb[0] in (0x48, 0x4c, 0x40), \
        "UIpNetDriver::InitListen doesn't look like a function start: %s" % ipb.hex()
    # 1. The Listen call and its stub.
    cur = data[PN.LISTEN_CALL_AT:PN.LISTEN_CALL_AT + 5]
    assert cur == PN.LISTEN_STUB_CALL, "Listen call bytes changed: %s" % cur.hex()
    assert PN.LISTEN_CALL_VA + 5 + struct.unpack_from("<i", cur, 1)[0] == STUB_VA
    assert data[PN._off(STUB_VA):PN._off(STUB_VA) + 3] == bytes.fromhex("32c0c3"), "stub is not xor al,al;ret"
    # 2. The notify slots: stock functions, each with a DIR64 relocation.
    relocs = _dir64_relocs(data, rro, rvs)
    for slot, stock_fn, entry in PN.NOTIFY_SLOTS:
        slot_va = PN.NOTIFY_VTABLE_VA + 8 * slot
        assert struct.unpack_from("<Q", data, PN._off(slot_va))[0] == stock_fn, "notify slot %d" % slot
        assert slot_va - IMAGE_BASE in relocs, "notify slot %d has no base relocation" % slot
    # 3. InternalGetNetMode as the patch expects, and its demo path's GetNetMode call.
    o = PN._off(PN.NETMODE_VA)
    assert data[o:o + len(PN.NETMODE_STOCK)] == PN.NETMODE_STOCK
    demo = data[o + 0xD:o + 0x21]
    assert demo[:7] == bytes.fromhex("488b81b8000000"), "demo path: mov rax,[rcx+0xb8]: %s" % demo.hex()
    # test rax,rax; je; mov rcx,rax (either encoding); jmp GetNetMode
    assert demo[7:10] == b"\x48\x85\xc0" and demo[12:15] in (b"\x48\x89\xc1", b"\x48\x8b\xc8") and demo[15] == 0xE9, \
        "demo path: %s" % demo.hex()
    assert PN.NETMODE_VA + 0x19 + 3 + 5 + struct.unpack_from("<i", demo, 16)[0] == PN.DRIVER_GET_NET_MODE
    # 4. The inlined copies.
    for va, stock, reg, d, join in PN.INLINE_SITES:
        assert data[PN._off(va):PN._off(va) + len(stock)] == stock, "inline site %#x" % va
        assert va + len(stock) == d, "inline site %#x: demo path right after the folded test" % va
        assert stock[-2] == 0xEB and d + stock[-1] == join, "inline site %#x: the jmp to its join" % va
    # 5. UNetDriver::GetNetMode: IsServer() (vtable +0x2d0: no ServerConnection) ? (GIsClient ?
    # NM_ListenServer 2 : NM_DedicatedServer 1) : NM_Client 3. "xor eax,eax; cmp [GIsClient],al;
    # setne al; inc eax" is the 1-or-2.
    g = data[PN._off(PN.DRIVER_GET_NET_MODE):PN._off(PN.DRIVER_GET_NET_MODE) + 0x2d]
    assert g[4:13] == bytes.fromhex("488b01ff90d0020000"), "GetNetMode: no IsServer call: %s" % g.hex()
    assert g[13:17] == bytes.fromhex("84c07412"), "GetNetMode: test al; je NM_Client: %s" % g.hex()
    assert g[17:19] in (b"\x31\xc0", b"\x33\xc0"), "GetNetMode: xor eax,eax: %s" % g.hex()
    assert g[19:21] == b"\x38\x05" and g[25:28] == bytes.fromhex("0f95c0") and g[28:30] == b"\xff\xc0", \
        "GetNetMode: GIsClient ? 2 : 1: %s" % g.hex()
    gis = PN.DRIVER_GET_NET_MODE + 25 + struct.unpack_from("<i", g, 21)[0]
    assert g[35:40] == b"\xb8\x03\x00\x00\x00", "GetNetMode: NM_Client: %s" % g.hex()
    # Patch a copy and verify; the stock exe is never written.
    tmp = tempfile.mkdtemp()
    try:
        copy = os.path.join(tmp, "Victory.exe")
        shutil.copyfile(path, copy)
        assert PN.patch(copy) is True
        _verify_patched(copy)
        assert PN.patch(copy) is False
        print("real exe: pass (Listen stub, 3 notify slots with relocations, InternalGetNetMode, "
              "2 inlined copies, GetNetMode (GIsClient at %#x), 4 kernel32 import slots re-derived; patched copy verified)" % gis)
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    test_blob_is_position_independent()
    test_trampolines()
    test_stand_in()
    if len(sys.argv) > 1:
        test_real_exe(sys.argv[1])
    else:
        print("real exe: skipped (pass its path to run it)")
    print("OK")
