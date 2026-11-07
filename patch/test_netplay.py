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
HERE = os.path.dirname(os.path.abspath(__file__))
HARNESS = os.path.join(HERE, "test_netplay_native.c")
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


def _verify_patched(path, test=False):
    NP = PN.blob(test)
    data = open(path, "rb").read()
    pe = struct.unpack_from("<I", data, 0x3C)[0]
    nsec_at, size_at = pe + 6, pe + 24 + 56
    table = pe + 24 + struct.unpack_from("<H", data, pe + 20)[0]
    at = table + 40 * PN.STOCK_NUM_SECTIONS
    header, raw, image_size, edits = PN.layout(test)
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
    for slot_va, stock_fn, entry in (PN.PRELOGIN_SLOT, PN.TICKFLUSH_SLOT, PN.SHOULD_END_SLOT):
        got = struct.unpack_from("<Q", data, PN._off(slot_va))[0]
        assert got == sect_va + getattr(NP, entry.upper()), (entry, hex(got))
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
        # The test build of the module patches the same way.
        pt = os.path.join(tmp, "VictoryTest.exe")
        stand_in(pt)
        assert PN.patch(pt, test=True) is True
        _verify_patched(pt, test=True)
        assert PN.check(pt, test=True) == {"section": True, "edits": True}
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
    # build proves the blob needs no base relocations. Rebuild and compare
    # (both builds: release and test).
    for test in (False, True):
        mod = PN.blob(test)
        blob, where = build_netplay.build(test)
        assert blob == mod.BLOB, "%s is OUT OF DATE (run build_netplay.py)" % mod.__name__
        assert mod.TEST_BUILD is test
        assert where["np_listen"] == mod.NP_LISTEN and where["np_self_rva"] == mod.NP_SELF_RVA
        for slot, stock_fn, entry in PN.NOTIFY_SLOTS:
            assert where[entry] == getattr(mod, entry.upper()), entry
        print("blob%s: pass (%d bytes, position independent, up to date)" % (" (test build)" if test else "", len(blob)))


# The test switches (environment variables) only the test build reads.
TEST_SWITCHES = ("CULLING_NETPLAY_GIVE", "CULLING_NETPLAY_TELEPORT", "CULLING_NETPLAY_DAMAGE", "CULLING_NETPLAY_ATTACK",
                 "CULLING_NETPLAY_ATTACK_ONE_SIDE", "CULLING_NETPLAY_END", "CULLING_NETPLAY_MOVE", "CULLING_NETPLAY_TEAM_SPLIT")


def test_switches_only_in_the_test_build():
    # A variable's name is in the blob as the UTF-16 string the module asks
    # GetEnvironmentVariableW for (NUL-terminated, so _ATTACK isn't found in
    # _ATTACK_ONE_SIDE). The release build has none; the test build all.
    rel, tst = PN.blob(False).BLOB, PN.blob(True).BLOB
    for name in TEST_SWITCHES:
        w = (name + "\0").encode("utf-16-le")
        assert w not in rel, "the release build reads " + name
        assert w in tst, "the test build doesn't read " + name
    # Kept in both: the real host's settings.
    for name in ("CULLING_NETPLAY_PREMATCH", "CULLING_NETPLAY_CONTROL", "CULLING_NETPLAY_TEAMSIZE", "CULLING_NETPLAY_TRACE"):
        w = (name + "\0").encode("utf-16-le")
        assert w in rel and w in tst, name
    print("test switches: pass (%d only in the test build; the release build has none)" % len(TEST_SWITCHES))


def test_stack_frames():
    # No stack probes in the blob (/Gs1000000, no __chkstk): every function's
    # frame, from its unwind data, stays under a page (the test build's too).
    assert max(build_netplay.build_frames(test=True).values()) < build_netplay.MAX_FRAME
    frames = build_netplay.build_frames()
    assert len(frames) >= 10, "unwind data for %d functions only" % len(frames)
    name, size = max(frames.items(), key=lambda kv: kv[1])
    assert size < build_netplay.MAX_FRAME, "%s takes 0x%x bytes of stack" % (name, size)
    # The parser itself: a frame known from the source (ctl_result's 3200-byte buffer) is seen.
    assert any(f >= 3200 for f in frames.values()), sorted(frames.items(), key=lambda kv: -kv[1])[:3]
    print("stack frames: pass (%d functions, the largest %s 0x%x < 0x%x)" % (len(frames), name, size, build_netplay.MAX_FRAME))


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
            "IAT_CREATEFILEW": "CreateFileW", "IAT_GETTICKCOUNT": "GetTickCount",
            "IAT_READFILE": "ReadFile", "IAT_CLOSEHANDLE": "CloseHandle"}
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
    # 2b. The FreeForAll PreLogin slot: the stub jumping to AShooterGameMode::PreLogin, whose
    # refusal is the "Match is over!" string and whose other path calls AGameModeBase::PreLogin.
    slot_va, stock_fn, entry = PN.PRELOGIN_SLOT
    assert struct.unpack_from("<Q", data, PN._off(slot_va))[0] == stock_fn, "PreLogin slot"
    assert slot_va - IMAGE_BASE in relocs, "PreLogin slot has no base relocation"
    stub = data[PN._off(stock_fn):PN._off(stock_fn) + 5]
    game_pre = stock_fn + 5 + struct.unpack_from("<i", stub, 1)[0]
    assert stub[0] == 0xE9 and game_pre == 0x140236E90, hex(game_pre)
    body = data[PN._off(game_pre):PN._off(game_pre) + 0x130]
    base = mac("R_BASE_PRELOGIN")
    calls = [game_pre + i + 5 + struct.unpack_from("<i", body, i + 1)[0] for i in range(len(body) - 5) if body[i] == 0xE8]
    assert IMAGE_BASE + base in calls, "AShooterGameMode::PreLogin doesn't call AGameModeBase::PreLogin %#x" % base
    msg = "Match is over!".encode("utf-16-le")
    assert data.find(msg) > 0, "no 'Match is over!' string"
    # 2b1. The joining player's net id (H5): AGameModeBase::PreLogin hands the FUniqueNetIdRepl's
    # TSharedPtr (uid + 8) on, and the game reads a player state's id object (+0x460, the
    # Repl's +8) through vtable +0x18 (IsValid) then +0x20 (ToString into the FString out).
    body = data[PN._off(IMAGE_BASE + base):PN._off(IMAGE_BASE + base) + 0x20]
    assert bytes.fromhex("4983c108") in body, "AGameModeBase::PreLogin: add r9, 8 (the Repl's shared pointer)"
    psid = data[PN._off(IMAGE_BASE + mac("R_PS_ID")):PN._off(IMAGE_BASE + mac("R_PS_ID")) + 0x40]
    assert bytes.fromhex("488b8960040000") in psid, "the player state's id object at +0x460"
    i, j = psid.find(bytes.fromhex("ff50") + bytes([mac("VT_ID_IS_VALID")])), psid.find(bytes.fromhex("ff50") + bytes([mac("VT_ID_TO_STRING")]))
    assert 0 <= i < j, "IsValid (+0x18) then ToString (+0x20)"
    # 2b2. FreeForAll's end-of-match check slot (relocated) holds the stock check, which reads
    # the player state's flags and contestant byte and calls HasLeft and IsAlive, as the
    # host's own rule (np_should_end) does.
    slot_va, stock_fn, entry = PN.SHOULD_END_SLOT
    assert struct.unpack_from("<Q", data, PN._off(slot_va))[0] == stock_fn, "end-check slot"
    assert slot_va - IMAGE_BASE in relocs, "end-check slot has no base relocation"
    assert stock_fn - IMAGE_BASE == mac("R_FFA_SHOULD_END")
    body = data[PN._off(stock_fn):PN._off(stock_fn) + 0x100]
    assert struct.pack("<I", mac("O_PS_FLAGS")) in body and struct.pack("<I", mac("O_PS_CONTESTANT")) in body, "flags/contestant reads"
    calls = {stock_fn + i + 5 + struct.unpack_from("<i", body, i + 1)[0] for i in range(len(body) - 5) if body[i] == 0xE8}
    assert IMAGE_BASE + mac("R_PS_HAS_LEFT") in calls and IMAGE_BASE + mac("R_PS_IS_ALIVE") in calls, sorted(hex(c) for c in calls)
    # 2c. Milestone 3. The Steam driver's TickFlush slot (relocated) holds its TickFlush, which
    # calls UNetDriver::TickFlush first; that reads ClientConnections (+0x78, Num +0x80). The
    # replay recorder's ReplicateActor (the loop's template) calls CreateChannel(conn, 2, 1, -1),
    # SetChannelActor(ch, actor) and ReplicateActor(ch), and reads the connection's ActorChannels
    # map at the offsets find_channel uses.
    slot_va, stock_fn, entry = PN.TICKFLUSH_SLOT
    assert struct.unpack_from("<Q", data, PN._off(slot_va))[0] == stock_fn, "TickFlush slot"
    assert slot_va - IMAGE_BASE in relocs, "TickFlush slot has no base relocation"
    assert stock_fn - IMAGE_BASE == mac("R_STEAM_TICKFLUSH")
    t = data[PN._off(stock_fn):PN._off(stock_fn) + 0x10]
    assert t[9] == 0xE8 and stock_fn + 14 + struct.unpack_from("<i", t, 10)[0] == 0x14143F2B0, t.hex()
    base_tf = data[PN._off(0x14143F2B0):PN._off(0x14143F2B0) + 0xd0]
    assert bytes.fromhex("488b5778") in base_tf and bytes.fromhex("486387" + "80000000") in base_tf,         "UNetDriver::TickFlush doesn't read ClientConnections at +0x78/+0x80"
    tmpl = 0x1412EE2E0
    body = data[PN._off(tmpl):PN._off(tmpl) + 0x222]
    calls = {tmpl + i + 5 + struct.unpack_from("<i", body, i + 1)[0] for i in range(len(body) - 5) if body[i] == 0xE8}
    for name in ("R_CREATE_CHANNEL", "R_SET_CH_ACTOR", "R_REPLICATE_ACTOR", "R_WEAK_SET"):
        assert IMAGE_BASE + mac(name) in calls, "the replay template doesn't call %s" % name
    assert bytes.fromhex("83c9ff8d56024 1b001".replace(" ", "").replace("4 1", "41")) in body or         bytes.fromhex("4183c9ff") in body or bytes.fromhex("83c9ff") in body, "CreateChannel's index -1"
    chmap = mac("O_CONN_CHMAP")
    for off in (chmap, chmap + 0x08, chmap + 0x34, chmap + 0x38, chmap + 0x48):
        assert struct.pack("<I", off) in body, "the template doesn't read the channel map at %#x" % off
    pre = data[PN._off(IMAGE_BASE + mac("R_PRE_REPLICATION")):][:4]
    assert pre[0] in (0x40, 0x48, 0x4c, 0x55, 0x53), "CallPreReplication start: %s" % pre.hex()
    # 2d. Weapons and inventory: AShooterCharacter's Inventory and CurrentWeapon offsets from their
    # property registrations ("mov r9d, <offset>" next to the name), and SpawnWeapon is the
    # function the Remaster's module (showdown_rounds.c R_SPAWN_WEAPON) gives weapons with.
    import test_native_module as TNM
    import test_weather_native as TW
    ex = TW.Exe(path)
    inv = {o for _, o in TNM.prop_offsets(ex, "Inventory")}
    cur = {o for _, o in TNM.prop_offsets(ex, "CurrentWeapon")}
    assert mac("O_CH_INVENTORY") in inv, "Inventory registered at %s" % sorted(map(hex, inv))
    assert mac("O_CH_CURRENT") in cur, "CurrentWeapon registered at %s" % sorted(map(hex, cur))
    sr = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "showdown_rounds.c"), encoding="utf-8").read()
    assert int(_re.search(r"#define R_SPAWN_WEAPON\s+(0x[0-9a-f]+)", sr).group(1), 16) == mac("R_SPAWN_WEAPON")
    # 2e. Movement corrections: UCharacterMovementComponent::SendClientAdjustment takes its
    # INetworkPredictionInterface (lea r15, [rcx - 0x180]) and calls ClientAckGoodMove through
    # vtable +0x968; the movement vtable's +0x968 is that RPC's thunk, which looks up the
    # "ClientAckGoodMove" name global. AcknowledgedPawn and CharacterMovement from their
    # property registrations.
    sca = IMAGE_BASE + mac("R_SEND_CLIENT_ADJ")
    body = data[PN._off(sca):PN._off(sca) + 0x80]
    assert bytes.fromhex("4c8db9") + struct.pack("<i", -mac("O_CMC_PREDICTION")) in body, "SendClientAdjustment: lea r15,[rcx-0x180]"
    assert bytes.fromhex("ff9268090000") in body, "SendClientAdjustment: call [rdx+0x968]"
    thunk = struct.unpack_from("<Q", data, PN._off(0x1425BEDE0 + 0x968))[0]
    tb = data[PN._off(thunk):PN._off(thunk) + 0x30]
    i = tb.find(bytes.fromhex("488b15"))
    assert i >= 0, "ClientAckGoodMove thunk: no name load"
    name_global = thunk + i + 7 + struct.unpack_from("<i", tb, i + 3)[0]
    init = data[PN._off(0x14015D0C0):PN._off(0x14015D0C0) + 0x20]
    j = init.find(bytes.fromhex("488d0d"))
    assert 0x14015D0C0 + j + 7 + struct.unpack_from("<i", init, j + 3)[0] == name_global
    k = init.find(bytes.fromhex("488d15"))
    sva = 0x14015D0C0 + k + 7 + struct.unpack_from("<i", init, k + 3)[0]
    assert data[PN._off(sva):PN._off(sva) + 34] == "ClientAckGoodMove".encode("utf-16-le"), "not the ClientAckGoodMove name"
    ack = {o for _, o in TNM.prop_offsets(ex, "AcknowledgedPawn")}
    cm = {o for _, o in TNM.prop_offsets(ex, "CharacterMovement")}
    assert mac("O_PC_ACK_PAWN") in ack and mac("O_CH_MOVEMENT") in cm, (sorted(ack), sorted(cm))
    # 2f. UNetDriver::ReplicationFrame: the replay recorder's record step (0x141305110, which
    # calls the per-actor template) increments it, as the engine's ServerReplicateActors does.
    rec = data[PN._off(0x141305110):PN._off(0x141305110) + 0xc00]
    assert bytes.fromhex("ff83") + struct.pack("<I", mac("O_ND_REP_FRAME")) in rec, "inc dword [rbx+ReplicationFrame]"
    assert any(0x141305110 + i + 5 + struct.unpack_from("<i", rec, i + 1)[0] == 0x1412EE2E0
               for i in range(len(rec) - 5) if rec[i] == 0xE8), "the record step calls the per-actor template"
    # 2g. The client's server-nonce check run at the match start (0x140283940): it asks the
    # game singleton (R_GAME_SINGLETON) whether its nonce matched (0x1401f5360 reads
    # O_SG_NONCE_OK), the flag the host sets for its own player.
    chk = data[PN._off(0x140283940):PN._off(0x140283940) + 0x80]
    calls = {0x140283940 + i + 5 + struct.unpack_from("<i", chk, i + 1)[0] for i in range(len(chk) - 5) if chk[i] == 0xE8}
    assert 0x140000000 + mac("R_GAME_SINGLETON") in calls and 0x1401F5360 in calls, sorted(hex(c) for c in calls)
    assert data[PN._off(0x1401F5360):PN._off(0x1401F5360) + 8] == bytes.fromhex("0fb681") + struct.pack("<I", mac("O_SG_NONCE_OK")) + b"\xc3", \
        "the singleton's nonce-matched getter"
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
              "2 inlined copies, GetNetMode (GIsClient at %#x), %d kernel32 import slots re-derived; patched copy verified)"
              % (gis, open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "netplay.c"), encoding="utf-8").read().count("#define IAT_")))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


# ---- the module's code itself, against fake game objects --------------------

def build_harness(tmp):
    """test_netplay_native.exe: the harness linked with netplay.c compiled
    with the blob's own flags (the release build)."""
    import subprocess
    cl = build_netplay.find_cl()
    env = dict(os.environ, PATH=os.path.dirname(cl) + os.pathsep + os.environ.get("PATH", ""))
    vc = os.path.abspath(os.path.join(os.path.dirname(cl), "..", "..", ".."))
    kits = r"C:\Program Files (x86)\Windows Kits\10"
    inc, lib = [os.path.join(vc, "include")], [os.path.join(vc, "lib", "x64")]
    vers = sorted(os.listdir(os.path.join(kits, "Include"))) if os.path.isdir(os.path.join(kits, "Include")) else []
    for sub in ("ucrt", "um", "shared"):
        if vers:
            inc.append(os.path.join(kits, "Include", vers[-1], sub))
            lib.append(os.path.join(kits, "Lib", vers[-1], sub, "x64"))
    env["INCLUDE"] = os.pathsep.join(p for p in inc + [env.get("INCLUDE", "")] if p)
    env["LIB"] = os.pathsep.join(p for p in lib + [env.get("LIB", "")] if p)
    obj = os.path.join(tmp, "netplay.obj")
    exe = os.path.join(tmp, "test_netplay_native.exe")
    for cmd in ([cl] + build_netplay.CL_FLAGS + ["/Fo" + obj, build_netplay.SOURCE],
                [cl, "/nologo", "/O1", "/W3", "/Fe" + exe, "/Fo" + os.path.join(tmp, "harness.obj"), HARNESS, obj]):
        r = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, text=True)
        assert r.returncode == 0, "build failed:\n" + r.stdout + r.stderr
    return exe


def run_scenario(exe, name, args, env, ctl, tickets=()):
    """One harness process: a fresh control folder with tickets.txt (lines
    "<sha256> <team> <userID>"), the module's environment, and the scenario."""
    import subprocess
    shutil.rmtree(ctl, ignore_errors=True)
    os.makedirs(ctl)
    if tickets:
        with open(os.path.join(ctl, "tickets.txt"), "w", newline="\n") as f:
            f.write("".join("%s %d %s\n" % (sha(tok), team, user) for tok, team, user in tickets))
    e = {k: v for k, v in os.environ.items() if not k.startswith("CULLING_NETPLAY_")}
    e.update({"CULLING_NETPLAY_CONTROL": ctl}, **env)
    e = {k: v for k, v in e.items() if v is not None}       # None: the variable unset
    r = subprocess.run([exe, name] + list(args), capture_output=True, text=True, env=e, timeout=120)
    for ln in r.stdout.splitlines():
        print("      " + ln)
    assert r.returncode == 0, "scenario %s failed (%d): %s" % (name, r.returncode, r.stdout[-400:] + r.stderr[-400:])


def sha(text):
    import hashlib
    return hashlib.sha256(text.encode()).hexdigest()


def test_native():
    tmp = tempfile.mkdtemp()
    try:
        exe = build_harness(tmp)
        ctl = os.path.join(tmp, "control")
        # Real-looking tickets (connticket.js's format): the module hashes the ?Nonce= value.
        ta = "v1.eyJtIjoiYWJjIiwidSI6InN0ZWFtOjc2NTYxMTk3OTYwMjY2OTAyIn0.Zm9yZ2VkLW5vdC1yZWFsbHktYS1tYWMtYnV0LWxvbmc"
        tb = "v1.eyJtIjoiYWJjIiwidSI6InN0ZWFtOjc2NTYxMTk3OTYwMjY2OTAzIn0.c2Vjb25kLXBsYXllcnMtdGlja2V0LW1hYy1oZXJlLW9r" + "x" * 150
        ua, ub = "steam:76561197960266902", "steam:76561197960266903"
        forged = ta[:-4] + "AAAA"
        print("native: tickets (H1)")
        run_scenario(exe, "tickets", [ta, sha(ta), ua, tb, sha(tb), ub, forged], {"CULLING_NETPLAY_PREMATCH": "2"}, ctl,
                     [(ta, 1, ua), (tb, 2, ub)])
        assert len(tb) > 200, "a ticket over three SHA-256 blocks"
        print("native: players (H5)")
        tc = ta.replace("v1.", "v1.c")
        run_scenario(exe, "players", [ta, ua, tb, ub, tc], {"CULLING_NETPLAY_PREMATCH": "2"}, ctl,
                     [(ta, 1, ua), (tb, 2, ub), (tc, 3, "acct:not-a-steam-id")])
        print("native: no control folder (M1)")
        run_scenario(exe, "nocontrol", [ta, ua], {"CULLING_NETPLAY_PREMATCH": "2", "CULLING_NETPLAY_CONTROL": None}, ctl)
        run_scenario(exe, "nocontrol", [ta, ua], {"CULLING_NETPLAY_PREMATCH": "2", "CULLING_NETPLAY_CONTROL": os.path.join(tmp, "missing")}, ctl)
        print("native: pass")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def test_no_sleep():
    # The module never sleeps: no call through kernel32's Sleep import slot
    # (the old ticket check slept the game thread up to 8 s per login).
    for test in (False, True):
        assert struct.pack("<I", 0x253F220) not in PN.blob(test).BLOB, "the module references the Sleep import slot"
    print("no sleep: pass (neither build references kernel32 Sleep)")


if __name__ == "__main__":
    test_blob_is_position_independent()
    test_no_sleep()
    test_native()
    test_switches_only_in_the_test_build()
    test_stack_frames()
    test_trampolines()
    test_stand_in()
    if len(sys.argv) > 1:
        test_real_exe(sys.argv[1])
    else:
        print("real exe: skipped (pass its path to run it)")
    print("OK")
