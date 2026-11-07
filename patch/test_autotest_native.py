"""The native module's autotest (autotest.c, only with ?RemasterAutoTest= in
the match URL) against fake game objects (test_autotest_native.c), and its game
addresses re-derived from the stock Victory.exe:

- behaviour: without the option (or with an unknown scenario) every frame is
  the stock tick and nothing else; "teamwin" in Duo kills only the rivals,
  from 100 s InProgress, the local player as killer, and keeps you and your
  mate alive; after the match's end it quits through the console 25 s later,
  once; a later match on the same GameMode address is inert again;
- the results file: every line is one JSON object, with the start, the
  teams, each kill and the end and quit;
- the game addresses (stock Victory.exe, read only): the FreeForAll vtable's
  slot 125 is stock 0x1402456b0, a jmp to the tick whose once-a-second part
  calls slot 282; each native by its registered name and the exec thunk's call
  (ApplyDamage among UGameplayStatics' damage natives, ExecuteConsoleCommand,
  K2_SetActorLocation, GetKills / GetKillerName of the player state that has
  GetTeamNum, SetHealth of the health component, GetWeapon's +0x8d8,
  AddMovementInput's vtable +0x6b0, OnRising's +0x5e0, the weapon's debug
  string reading EWeaponState at +0x660 and FName::ToString), the kernel32
  imports by name; and the built blob uses every one.

Needs the Visual Studio C++ tools (as build_showdown_rounds.py does).

usage: python test_autotest_native.py [Victory.exe]
"""
import json
import os
import re
import struct
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_showdown_rounds as BUILD  # noqa: E402
import test_weather_native as TW  # noqa: E402

HARNESS = os.path.join(BUILD.HERE, "test_autotest_native.c")
SOURCE = os.path.join(BUILD.HERE, "autotest.c")


def fail(msg):
    print("FAIL " + msg)
    sys.exit(1)


def defines():
    src = open(SOURCE, encoding="utf-8").read()
    return {k: int(v, 16) for k, v in re.findall(r"#define (AT[A-Z_0-9]*)\s+(0x[0-9a-f]+)", src)}


def behaviour():
    cl, env = TW.toolchain()
    with tempfile.TemporaryDirectory() as tmp:
        obj = os.path.join(tmp, "module.obj")
        exe = os.path.join(tmp, "test_autotest_native.exe")
        for cmd in ([cl] + BUILD.CL_FLAGS + ["/Fo" + obj, BUILD.SOURCE],
                    [cl, "/nologo", "/O1", "/W3", "/Fe" + exe, "/Fo" + os.path.join(tmp, "harness.obj"), HARNESS, obj]):
            r = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, text=True)
            if r.returncode:
                fail("build failed:\n" + r.stdout + r.stderr)
        local = os.path.join(tmp, "local")
        os.makedirs(os.path.join(local, "TheCullingRemaster"))
        r = subprocess.run([exe], capture_output=True, text=True, env=dict(os.environ, LOCALAPPDATA=local))
        sys.stdout.write(r.stdout)
        if r.returncode or "all autotest native tests passed" not in r.stdout:
            fail("autotest behaviour (%d)" % r.returncode)
        path = os.path.join(local, "TheCullingRemaster", "autotest", "results.jsonl")
        if not os.path.exists(path):
            fail("no results file at %s" % path)
        lines = open(path, encoding="utf-8").read().splitlines()
    events = []
    for ln in lines:
        try:
            events.append(json.loads(ln))
        except ValueError:
            fail("a results line is not JSON: %r" % ln[:120])
    kinds = [e["ev"] for e in events]
    for want in ("start", "teams", "kill", "end", "quit"):
        if want not in kinds:
            fail("no %r event in %s" % (want, sorted(set(kinds))))
    start = events[kinds.index("start")]
    if start.get("scenario") != "teamwin" or "RemasterAutoTest=teamwin" not in start.get("url", ""):
        fail("start: %s" % start)
    kills = [e for e in events if e["ev"] == "kill"]
    if len(kills) != 4 or any(k["vteam"] not in (2, 3) or k["vpc"] for k in kills):
        fail("kills: %s" % kills)
    teams = events[kinds.index("teams")]
    if teams["myteam"] != 1 or teams["mates"] != 1 or teams["fighters"] != 6 or len(teams["roster"]) != 6:
        fail("teams: %s" % teams)
    if kinds.count("quit") != 1 or kinds.index("end") > kinds.index("quit"):
        fail("end/quit order: %s" % kinds)
    print("ok    results file: %d JSON lines (%s), 4 kills of teams 2/3, one quit after the end"
          % (len(events), ", ".join(sorted(set(kinds)))))


def exe_checks(path):
    import capstone
    import pefile
    import showdown_rounds_blob as ROUNDS
    ex = TW.Exe(path)
    d = defines()

    def impl(name, rva, near=None):
        sites = ex.native_sites(name)
        hits = [(s, t) for s, t in sites if rva in ex.calls(t, 0x600)]
        if not hits:
            fail("%s: no registered exec thunk calls %x (thunks %s)" % (name, rva, [hex(t) for _s, t in sites]))
        if near:
            others = [s for n in near for s, _t in ex.native_sites(n)]
            if not any(abs(s - o) < 0x400 for s, _t in hits for o in others):
                fail("%s at %x is not registered with %s" % (name, rva, near))
        return hits

    # Slot 125: stock value, a jmp to the tick that calls slot 282 (vtable +0x8d0) every second.
    vt = 0x25A81E8 - 282 * 8
    slot = struct.unpack_from("<Q", ex.d, ex.off(vt + 125 * 8))[0] - TW.BASE
    if slot != d["AT_GM_TICK"]:
        fail("vtable slot 125 is %x, not %x" % (slot, d["AT_GM_TICK"]))
    first = ex.code(slot, 8)[0]
    if first.mnemonic != "jmp":
        fail("slot 125 (%x) is not a jmp thunk" % slot)
    tick = int(first.op_str, 16) - TW.BASE
    body = " | ".join("%s %s" % (i.mnemonic, i.op_str) for i in ex.code(tick, 0x500))
    if "call qword ptr [rax + 0x8d0]" not in body or "0x760" not in body:
        fail("the tick at %x doesn't count seconds (+0x760) and call slot 282" % tick)
    print("ok    vtable slot 125 = %x: jmp %x, the per-frame tick whose once-a-second part calls slot 282"
          % (TW.BASE + slot, TW.BASE + tick))
    impl("ApplyDamage", d["AT_APPLY_DAMAGE"], ["ApplyPointDamage", "ApplyRadialDamage"])
    impl("ExecuteConsoleCommand", d["AT_CONSOLE"])
    impl("K2_SetActorLocation", d["AT_SET_LOCATION"])
    impl("GetKills", d["AT_PS_KILLS"], ["GetTeamNum", "GetKillerNameFText"])
    impl("GetKillerName", d["AT_PS_KILLER"], ["GetTeamNum", "GetKillerNameFText"])
    impl("SetHealth", d["AT_SET_HEALTH"], ["GetMaxHealth", "SetMaxHealth"])
    # ApplyDamage reads 5 parameters (actor, damage, instigator, causer, class).
    thunk = [t for _s, t in ex.native_sites("ApplyDamage") if d["AT_APPLY_DAMAGE"] in ex.calls(t)][0]
    body = []
    for i in ex.code(thunk, 0x200):
        body.append(i)
        if i.mnemonic == "ret":
            break
    steps = sum(1 for i in body if i.mnemonic == "call" and i.op_str == "0x140696150")
    if steps != 5:
        fail("ApplyDamage reads %d parameters, not 5" % steps)

    def jumps(name, op):
        text = " | ".join("%s %s" % (i.mnemonic, i.op_str) for t in ex.natives(name) for i in ex.code(t, 0x120))
        if op not in text:
            fail("%s doesn't %s" % (name, op))
    jumps("AddMovementInput", "call qword ptr [rax + 0x%x]" % d["ATV_ADD_MOVEMENT"])
    jumps("OnRising", "jmp qword ptr [rax + 0x%x]" % d["ATV_ON_RISING"])
    get_weapon = [c for t in ex.natives("GetWeapon") for c in ex.calls(t, 0x40)]
    if not any("[rcx + 0x%x]" % d["ATW_WEAPON"] in " ".join(i.op_str for i in ex.code(c, 0x10)) for c in get_weapon):
        fail("GetWeapon doesn't read +0x%x" % d["ATW_WEAPON"])
    # GetCurrentWeaponState -> the weapon (+0x8d8) -> its debug string: EWeaponState at +0x660, FName::ToString.
    state = [c for t in ex.natives("GetCurrentWeaponState") for c in ex.calls(t, 0x100)]
    if not any(d["AT_WEAPON_DEBUG"] in ex.calls(c, 0x40) for c in state):
        fail("GetCurrentWeaponState doesn't lead to %x" % d["AT_WEAPON_DEBUG"])
    dbg = " | ".join("%s %s" % (i.mnemonic, i.op_str) for i in ex.code(d["AT_WEAPON_DEBUG"], 0x260))
    if "[rcx + 0x%x]" % d["ATW_STATE"] not in dbg or "0x%x" % (TW.BASE + d["AT_FNAME_STRING"]) not in dbg:
        fail("the weapon debug string doesn't read +0x%x or call FName::ToString %x" % (d["ATW_STATE"], d["AT_FNAME_STRING"]))
    pe = pefile.PE(path, fast_load=True)
    pe.parse_data_directories(directories=[pefile.DIRECTORY_ENTRY["IMAGE_DIRECTORY_ENTRY_IMPORT"]])
    imports = {imp.name.decode(): imp.address - pe.OPTIONAL_HEADER.ImageBase
               for e in pe.DIRECTORY_ENTRY_IMPORT for imp in e.imports if imp.name}
    for key, name in (("AT_IAT_CREATE_DIR", "CreateDirectoryW"), ("AT_IAT_CREATE_FILE", "CreateFileW"),
                      ("AT_IAT_WRITE_FILE", "WriteFile"), ("AT_IAT_GETENV", "GetEnvironmentVariableW"),
                      ("AT_IAT_TICKS", "GetTickCount64")):
        if imports.get(name) != d[key]:
            fail("%s's import slot is %s, not %x" % (name, imports.get(name) and hex(imports[name]), d[key]))
    pe.close()
    print("ok    game addresses: ApplyDamage, ExecuteConsoleCommand, K2_SetActorLocation, GetKills, GetKillerName, "
          "SetHealth, AddMovementInput +0x6b0, OnRising +0x5e0, GetWeapon +0x8d8, EWeaponState +0x660, "
          "FName::ToString, 5 kernel32 imports")
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    imm = set()
    for i in md.disasm(ROUNDS.BLOB[:ROUNDS.SD_SELF_RVA], 0):
        for h in re.findall(r"0x[0-9a-f]+", i.op_str):
            imm.add(int(h, 16))
    for k in ("AT_GM_TICK", "AT_APPLY_DAMAGE", "AT_CONSOLE", "AT_SET_LOCATION", "AT_PS_KILLS", "AT_PS_KILLER",
              "AT_FNAME_STRING", "AT_WEAPON_DEBUG", "AT_SET_HEALTH", "AT_IAT_CREATE_FILE", "AT_IAT_WRITE_FILE",
              "AT_IAT_GETENV", "AT_IAT_TICKS", "AT_IAT_CREATE_DIR"):
        if d[k] not in imm:
            fail("the blob doesn't use %s (0x%x)" % (k, d[k]))
    print("ok    the blob uses every autotest address")


def main():
    behaviour()
    path = sys.argv[1] if len(sys.argv) > 1 else TW.EXE
    if os.path.exists(path):
        exe_checks(path)
    else:
        print("skip game addresses (no %s)" % path)


if __name__ == "__main__":
    main()
