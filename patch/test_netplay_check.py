"""netplay_check.py on a stand-in exe (the real bytes at every address it reads),
with each fact broken in turn, and on the real Victory.exe when its path is
given.

usage: python test_netplay_check.py [Victory.exe]
"""
import os
import struct
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import netplay_check as N  # noqa: E402

LISTEN_STR = 0x142AEC568
MUTATOR_STR = 0x142AEC1A8
LISTEN_STUB = 0x14143E6F0
NETDRIVER_VT = 0x142A58218
TICKFLUSH = 0x14143F2B0
IS_SERVER_FN = 0x1414357C0
BASE_INITLISTEN = 0x141433DC0
IP_VT = 0x142DFE1B8
IP_INITLISTEN = 0x1422D9800
RETURN_TRUE_FN = 0x141643650
CONNECT_STR = 0x14257D978


def put(data, va, raw):
    o = N.off(va)
    data[o:o + len(raw)] = raw


def put_rel(data, va, head, target, size):
    put(data, va, head + struct.pack("<i", target - (va + size)))


def stand_in():
    data = bytearray(N.off(IP_VT + 0x300))
    put(data, LISTEN_STR, "Listen\0".encode("utf-16le"))
    put(data, MUTATOR_STR, "Mutator=\0".encode("utf-16le"))
    put(data, CONNECT_STR, "open %s?Nonce=%s\0".encode("utf-16le"))
    # LoadMap's listen block: lea rdx, L"Listen"; mov rcx, rdi; call HasOption; test; je; ...; call Listen
    put_rel(data, N.LISTEN_LEA, bytes.fromhex("488d15"), LISTEN_STR, 7)
    put(data, N.LISTEN_LEA + 7, bytes.fromhex("488bcfe84f41020084c0740f498b8e98020000488bd7"))
    put_rel(data, N.LISTEN_CALL, b"\xe8", LISTEN_STUB, 5)
    put_rel(data, N.MUTATOR_LEA, bytes.fromhex("488d15"), MUTATOR_STR, 7)
    put(data, LISTEN_STUB, N.RETURN_FALSE)
    # UNetDriver: constructor's vtable, TickFlush, IsServer, InitListen
    put_rel(data, N.NETDRIVER_CTOR_LEA, bytes.fromhex("488d05"), NETDRIVER_VT, 7)
    put(data, NETDRIVER_VT + N.SLOT_TICKFLUSH, struct.pack("<Q", TICKFLUSH))
    put(data, NETDRIVER_VT + N.SLOT_ISSERVER, struct.pack("<Q", IS_SERVER_FN))
    put(data, NETDRIVER_VT + N.SLOT_INITLISTEN, struct.pack("<Q", BASE_INITLISTEN))
    put(data, IS_SERVER_FN, N.IS_SERVER)
    put(data, N.TICKFLUSH_AT, N.TICKFLUSH_SEQ)
    # UIpNetDriver
    put_rel(data, N.IPDRIVER_CTOR_LEA, bytes.fromhex("488d05"), IP_VT, 7)
    put(data, IP_VT + N.SLOT_INITLISTEN, struct.pack("<Q", IP_INITLISTEN))
    put(data, IP_VT + N.SLOT_ISAVAILABLE, struct.pack("<Q", RETURN_TRUE_FN))
    put(data, RETURN_TRUE_FN, N.RETURN_TRUE)
    # ConnectToServer: lea rdx, L"open %s?Nonce=%s"
    put_rel(data, N.CONNECT_LEA, bytes.fromhex("488d15"), CONNECT_STR, 7)
    return data


def facts(data):
    return {k: ok for k, (ok, _detail) in N.check(bytes(data)).items()}


ALL = {"listen_stubbed": True, "no_replication": True, "ip_driver": True, "client_connect": True}


def test_stand_in():
    assert facts(stand_in()) == ALL


def test_listen_with_a_body_is_not_reported_stubbed():
    data = stand_in()
    put(data, LISTEN_STUB, bytes.fromhex("488bc4"))            # mov rax, rsp: a real prologue
    assert facts(data) == dict(ALL, listen_stubbed=False)


def test_listen_call_elsewhere_is_not_reported_stubbed():
    data = stand_in()
    put_rel(data, N.LISTEN_LEA, bytes.fromhex("488d15"), MUTATOR_STR, 7)   # some other option
    assert facts(data)["listen_stubbed"] is False


def test_tickflush_that_tests_isserver_is_not_reported_stripped():
    data = stand_in()
    at = N.TICKFLUSH_AT + N.TICKFLUSH_SEQ.index(bytes.fromhex("33db"))
    put(data, at, bytes.fromhex("84c0"))                       # test al, al: the result is used
    assert facts(data) == dict(ALL, no_replication=False)


def test_isserver_slot_must_be_isserver():
    data = stand_in()
    put(data, NETDRIVER_VT + N.SLOT_ISSERVER, struct.pack("<Q", RETURN_TRUE_FN))
    assert facts(data)["no_replication"] is False


def test_ip_driver_with_pure_initlisten_is_incomplete():
    data = stand_in()
    put(data, IP_VT + N.SLOT_INITLISTEN, struct.pack("<Q", BASE_INITLISTEN))
    assert facts(data) == dict(ALL, ip_driver=False)


def test_connect_format():
    data = stand_in()
    put(data, CONNECT_STR, "open %s\0".encode("utf-16le"))
    assert facts(data) == dict(ALL, client_connect=False)


def test_outside_sections():
    try:
        N.off(0x140000000)
    except ValueError:
        return
    raise AssertionError("header VA accepted")


def real(path):
    data = open(path, "rb").read()
    got = N.check(data)
    for name, (ok, detail) in got.items():
        print("real  %-15s %s  %s" % (name, ok, detail))
    assert {k: ok for k, (ok, _d) in got.items()} == ALL


if __name__ == "__main__":
    tests = [(k, v) for k, v in sorted(globals().items()) if k.startswith("test_")]
    for name, fn in tests:
        fn()
        print("ok    " + name)
    if len(sys.argv) > 1:
        real(sys.argv[1])
        print("ok    real exe")
    print("%d passed" % (len(tests) + (len(sys.argv) > 1)))
