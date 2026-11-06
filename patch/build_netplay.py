"""Build netplay.c (the listen-server module) into the blob patch_netplay.py places in Victory.exe.

Same mechanism as build_showdown_rounds.py: compile netplay.c with MSVC (cl /c,
no CRT, no headers), then act as the linker - lay the object's .text, .rdata,
.data and .bss out one after the other at the section's RVA, resolve the
object's RIP-relative relocations (the only kind allowed: the blob must not
need base relocations, the exe is ASLR-enabled), write the RVA of np_self_rva
into it, and write netplay_blob.py (the bytes as hex, and the entry offsets).

    python build_netplay.py           build and write the blob module
    python build_netplay.py --check   build and compare with it

cl.exe is looked for on PATH, then in the Visual Studio 2022 install.
"""
import glob
import os
import struct
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "netplay.c")
OUT = os.path.join(HERE, "netplay_blob.py")
# Its own RVA, distinct from .sdround's 0x35B4000 so the two modules can be
# merged into one build later (see docs/NETPLAY_LISTEN_SERVER.md); the
# standalone prototype puts .netp where the stock SizeOfImage is.
SECTION_RVA = 0x35B4000
ENTRIES = ("np_listen", "np_notify_accepting", "np_notify_accepted", "np_notify_control")
SELF = "np_self_rva"
CL_FLAGS = ["/nologo", "/c", "/O1", "/GS-", "/Zl", "/Gy-", "/GR-", "/Oi", "/Gs1000000", "/W4", "/WX",
            "/wd4100", "/wd4127", "/volatileMetadata-"]
REL32 = {4: 0, 5: 1, 6: 2, 7: 3, 8: 4, 9: 5}     # IMAGE_REL_AMD64_REL32[_n]: extra bytes after the field
LAYOUT = (".text", ".rdata", ".data", ".bss")


def find_cl():
    for d in os.environ.get("PATH", "").split(os.pathsep):
        if os.path.isfile(os.path.join(d, "cl.exe")):
            return os.path.join(d, "cl.exe")
    hits = sorted(glob.glob(r"C:\Program Files\Microsoft Visual Studio\20*\*\VC\Tools\MSVC\*\bin\Hostx64\x64\cl.exe"))
    if not hits:
        sys.exit("cl.exe not found (Visual Studio C++ tools)")
    return hits[-1]


def compile_obj(tmp):
    cl = find_cl()
    obj = os.path.join(tmp, "netplay.obj")
    env = dict(os.environ, PATH=os.path.dirname(cl) + os.pathsep + os.environ.get("PATH", ""))
    r = subprocess.run([cl] + CL_FLAGS + ["/Fo" + obj, SOURCE], cwd=tmp, env=env, capture_output=True, text=True)
    if r.returncode:
        sys.exit("cl failed:\n" + r.stdout + r.stderr)
    return open(obj, "rb").read()


def parse_coff(d):
    machine, nsec, _t, symptr, nsym, optsz, _c = struct.unpack_from("<HHIIIHH", d, 0)
    assert machine == 0x8664, hex(machine)
    strtab = symptr + 18 * nsym

    def name8(raw):
        if raw[:4] == b"\0\0\0\0":
            off = struct.unpack_from("<I", raw, 4)[0]
            return d[strtab + off:d.index(b"\0", strtab + off)].decode()
        return raw.rstrip(b"\0").decode()

    secs = []
    for i in range(nsec):
        o = 20 + optsz + 40 * i
        raw = d[o:o + 8]
        name = raw.rstrip(b"\0").decode()
        if name.startswith("/"):
            off = int(name[1:])
            name = d[strtab + off:d.index(b"\0", strtab + off)].decode()
        vsize, va, rsize, rptr, relptr, _ln, nrel, _nln, flags = struct.unpack_from("<IIIIIIHHI", d, o + 8)
        data = d[rptr:rptr + rsize] if rptr else b"\0" * rsize
        rels = [struct.unpack_from("<IIH", d, relptr + 10 * k) for k in range(nrel)]
        secs.append({"name": name.split("$")[0], "data": data, "size": rsize, "rels": rels, "flags": flags})
    syms = []
    i = 0
    while i < nsym:
        o = symptr + 18 * i
        value, secnum, typ, cls, naux = struct.unpack_from("<IhHBB", d, o + 8)
        syms.append({"name": name8(d[o:o + 8]), "value": value, "sec": secnum, "class": cls})
        for _ in range(naux):
            syms.append(None)
        i += 1 + naux
    return secs, syms


def link(obj):
    secs, syms = parse_coff(obj)
    blob = bytearray()
    place = {}
    for want in LAYOUT:
        for idx, s in enumerate(secs, 1):
            if s["name"] != want:
                continue
            while len(blob) % 16:
                blob.append(0xCC if want == ".text" else 0)
            place[idx] = len(blob)
            blob += s["data"] if want != ".bss" else b"\0" * s["size"]
    for idx, s in enumerate(secs, 1):
        if s["name"] not in LAYOUT and (s["data"].strip(b"\0") or s["rels"]) and not s["name"].startswith((".pdata", ".xdata", ".debug", ".drectve", ".chks")):
            sys.exit("unexpected section %s" % s["name"])
    for idx, s in enumerate(secs, 1):
        if idx not in place:
            continue
        for va, symidx, typ in s["rels"]:
            if typ not in REL32:
                sys.exit("relocation type %d in %s: the blob must be position independent" % (typ, s["name"]))
            sym = syms[symidx]
            if sym["sec"] <= 0 or sym["sec"] not in place:
                sys.exit("unresolved symbol " + sym["name"])
            target = place[sym["sec"]] + sym["value"]
            at = place[idx] + va
            addend = struct.unpack_from("<i", blob, at)[0]
            struct.pack_into("<i", blob, at, target + addend - (at + 4 + REL32[typ]))
    where = {}
    for sym in syms:
        if sym and sym["sec"] in place and sym["class"] == 2:
            where[sym["name"]] = place[sym["sec"]] + sym["value"]
    for name in ENTRIES + (SELF,):
        if name not in where:
            sys.exit("missing symbol " + name)
    struct.pack_into("<Q", blob, where[SELF], SECTION_RVA + where[SELF])
    return bytes(blob), {n: where[n] for n in ENTRIES + (SELF,)}


def render(blob, where):
    lines = ['"""Generated by build_netplay.py from netplay.c: do not edit."""', ""]
    lines.append("SECTION_RVA = 0x%X" % SECTION_RVA)
    for n in ENTRIES + (SELF,):
        lines.append("%s = 0x%X" % (n.upper(), where[n]))
    lines.append("BLOB = bytes.fromhex(")
    h = blob.hex()
    for i in range(0, len(h), 96):
        lines.append('    "%s"' % h[i:i + 96])
    lines.append(")")
    return "\n".join(lines) + "\n"


def build():
    with tempfile.TemporaryDirectory() as tmp:
        return link(compile_obj(tmp))


if __name__ == "__main__":
    blob, where = build()
    text = render(blob, where)
    if "--check" in sys.argv:
        same = os.path.exists(OUT) and open(OUT, encoding="utf-8").read() == text
        print("netplay_blob.py is %s" % ("up to date" if same else "OUT OF DATE"))
        sys.exit(0 if same else 1)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print("netplay: %d bytes, %s" % (len(blob), ", ".join("%s +0x%x" % kv for kv in where.items())))
