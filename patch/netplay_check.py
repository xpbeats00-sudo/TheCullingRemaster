"""Static checks for whether Victory.exe can host a network match.

Reads the exe (stock or patched by patch_exe.py: neither .text nor .rdata
moves) and reports four facts, each from exact bytes at known addresses. See
docs/MULTIPLAYER_NETPLAY_FEASIBILITY.md for how each address was found.

1. listen_stubbed   UEngine::LoadMap's "Listen for clients" block
                    (VA 0x141644cc9): if no pending connection and
                    URL.HasOption(L"Listen"), it calls
                    WorldContext.World()->Listen(URL) at VA 0x141644cef. The
                    call goes to VA 0x14143e6f0, which is "xor al, al; ret":
                    UWorld::Listen was compiled out (WITH_SERVER_CODE=0, a
                    WindowsClient target) and folded into a shared
                    "return false". So "?listen" on a map URL never opens a
                    socket.
2. no_replication   UNetDriver::TickFlush (VA 0x14143f2b0, vtable slot +0x278
                    of the UNetDriver vtable the constructor stores) starts
                    with "IsServer() && ..." (vtable +0x2d0, the function
                    "ServerConnection == NULL") and throws the result away:
                    the next instructions reset
                    ProcessQueuedBunchesCurrentFrameMilliseconds (+0x3e8).
                    The block that calls ServerReplicateActors was compiled
                    out, so even a listening driver would never send actors to
                    clients.
3. ip_driver        UIpNetDriver (vtable stored by its constructor at VA
                    0x1422ca72e; USteamNetDriver's constructor at VA
                    0x14230c4e0 calls this one) is complete: IsAvailable returns true and
                    InitListen is its own function, not UNetDriver's pure
                    virtual. The socket layer is there; what's missing is the
                    world/replication server code above it.
4. client_connect   AVictoryFrontEndHUD::ConnectToServer (VA 0x1401dce90)
                    builds L"open %s?Nonce=%s" (lea at VA 0x1401dcec6): the
                    client half - travelling to a remote server - is intact.

usage: python netplay_check.py <Victory.exe>
"""
import struct
import sys

IMAGE_BASE = 0x140000000
# The stock section layout (patch_exe.py appends .sdround after .reloc and
# moves nothing): (RVA, raw offset, size).
SECTIONS = ((0x1000, 0x600, 0x253DA00),        # .text
            (0x253F000, 0x253E000, 0xB10600))  # .rdata


def off(va):
    rva = va - IMAGE_BASE
    for start, raw, size in SECTIONS:
        if start <= rva < start + size:
            return raw + rva - start
    raise ValueError("VA %#x is outside .text/.rdata" % va)


def read(data, va, n):
    o = off(va)
    return bytes(data[o:o + n])


def qword(data, va):
    return struct.unpack("<Q", read(data, va, 8))[0]


def rel32(data, va, at, size):
    """Target of a rip-relative operand: disp32 at va+at, instruction length size."""
    return va + size + struct.unpack("<i", read(data, va + at, 4))[0]


def wstr(data, va, limit=64):
    raw = read(data, va, 2 * limit)
    end = 0
    while end < len(raw) - 1 and raw[end:end + 2] != b"\0\0":
        end += 2
    return raw[:end].decode("utf-16le", "replace")


RETURN_FALSE = bytes.fromhex("32c0c3")                    # xor al, al; ret
IS_SERVER = bytes.fromhex("48837970000f94c0c3")           # cmp [rcx+0x70], 0; sete al; ret
RETURN_TRUE = bytes.fromhex("b001c3")                     # mov al, 1; ret

# 1. LoadMap: lea rdx, L"Listen"; mov rcx, rdi; call FURL::HasOption; test al, al;
#    je; mov rcx, [r14+0x298]; mov rdx, rdi; call UWorld::Listen
LISTEN_LEA = 0x141644CD2
LISTEN_SEQ = bytes.fromhex("488d15") + b"...." + bytes.fromhex("488bcfe8") + b"...." + \
    bytes.fromhex("84c0740f498b8e98020000488bd7e8")
LISTEN_CALL = 0x141644CEF
MUTATOR_LEA = 0x141644CFE                                 # the next statement: GetOption(L"Mutator=", L"")

# 2. TickFlush.
NETDRIVER_CTOR_LEA = 0x14142763E                          # lea rax, UNetDriver vtable; mov [rbx], rax
SLOT_TICKFLUSH = 0x278
SLOT_ISSERVER = 0x2D0
SLOT_INITLISTEN = 0x220
SLOT_ISAVAILABLE = 0x208
# mov rax,[rcx]; mov rdi,rcx; (saves); call [rax+0x2d0]; xor ebx,ebx; lea rcx,[rsp+0x70];
# mov [rdi+0x3e8], ebx  - the IsServer() result (al) is never tested.
TICKFLUSH_AT = 0x14143F2D7
TICKFLUSH_SEQ = bytes.fromhex("488b01488bf94d8973d0410f297ba80f28f9ff90d002000033db488d4c2470899fe8030000")

# 3. UIpNetDriver.
IPDRIVER_CTOR_LEA = 0x1422CA72E

# 4. ConnectToServer.
CONNECT_LEA = 0x1401DCEC6
CONNECT_FMT = "open %s?Nonce=%s"


def _match(seq, got):
    return len(seq) == len(got) and all(s == ord(".") or s == g for s, g in zip(seq, got))


def check(data):
    """{fact: (bool, detail)} for the four facts in the module docstring."""
    out = {}

    seq = read(data, LISTEN_LEA, len(LISTEN_SEQ))
    listen_str = wstr(data, rel32(data, LISTEN_LEA, 3, 7)) if seq[:3] == LISTEN_SEQ[:3] else None
    mutator = wstr(data, rel32(data, MUTATOR_LEA, 3, 7))
    target = rel32(data, LISTEN_CALL, 1, 5)
    body = read(data, target, len(RETURN_FALSE))
    ok = _match(LISTEN_SEQ, seq) and listen_str == "Listen" and mutator == "Mutator=" and body == RETURN_FALSE
    out["listen_stubbed"] = (ok, "LoadMap calls UWorld::Listen at %#x -> %#x = %s (option %r, next %r)"
                             % (LISTEN_CALL, target, body.hex(), listen_str, mutator))

    vt = rel32(data, NETDRIVER_CTOR_LEA, 3, 7)
    tick = qword(data, vt + SLOT_TICKFLUSH)
    is_server = qword(data, vt + SLOT_ISSERVER)
    ok = (read(data, is_server, len(IS_SERVER)) == IS_SERVER and tick <= TICKFLUSH_AT < tick + 0x40
          and read(data, TICKFLUSH_AT, len(TICKFLUSH_SEQ)) == TICKFLUSH_SEQ)
    out["no_replication"] = (ok, "UNetDriver vtable %#x: TickFlush %#x calls IsServer %#x and drops the result"
                             % (vt, tick, is_server))

    ip_vt = rel32(data, IPDRIVER_CTOR_LEA, 3, 7)
    ip_listen = qword(data, ip_vt + SLOT_INITLISTEN)
    base_listen = qword(data, vt + SLOT_INITLISTEN)
    avail = read(data, qword(data, ip_vt + SLOT_ISAVAILABLE), 3)
    ok = ip_listen != base_listen and avail == RETURN_TRUE
    out["ip_driver"] = (ok, "UIpNetDriver vtable %#x: InitListen %#x (base pure virtual %#x), IsAvailable %s"
                        % (ip_vt, ip_listen, base_listen, avail.hex()))

    fmt = wstr(data, rel32(data, CONNECT_LEA, 3, 7))
    out["client_connect"] = (fmt == CONNECT_FMT, "ConnectToServer formats %r" % fmt)
    return out


def main(path):
    data = open(path, "rb").read()
    facts = check(data)
    for name, (ok, detail) in facts.items():
        print("%-15s %-5s %s" % (name, "yes" if ok else "NO", detail))
    stripped = facts["listen_stubbed"][0] or facts["no_replication"][0]
    print("server (listen/replication) code: %s; client travel code: %s"
          % ("compiled out" if stripped else "not shown missing", "present" if facts["client_connect"][0] else "not found"))
    return facts


if __name__ == "__main__":
    main(sys.argv[1])
