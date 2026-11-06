"""Run the native module's stuck-player safety net (unstick.c, compiled into
showdown_rounds.c with the blob's own flags) against fake game objects
(test_unstick_native.c), and re-derive every game address it uses from the
stock Victory.exe:

- behaviour: walking and jumping around, walking into a tree trunk, an idle
  player on a perch, standing in a trigger volume: nothing. Stuck on a tree
  top (Falling, still, pushing; also when the movement component flips it
  between Falling and Walking) or inside a trunk (Walking, still, pushing,
  overlapping a blocker): moved once, at the 2nd still tick, to where it
  last walked (the one before when another pawn stands there; the nearest
  free ring spot when none is free or near), with a HUD message; a 20 s
  cooldown; never when dead (pawn or record), left, spectating, using or
  crafting, on a ladder / swimming / in a custom mode, in the first 20 s
  (the pods) or with ?Unstick=0; a destroyed pawn is never touched and a
  new one starts fresh; a refused teleport tries every candidate once and
  again 2 ticks later;
- the game addresses (with the stock Victory.exe, read only): K2_TeleportTo
  (its exec thunk's call, which is TeleportTo(loc, rot, false, false)),
  CapsuleOverlapComponents (the thunk's call, radius in xmm2 and half
  height in xmm3 read as its 3rd and 4th parameters), the
  GetCollisionResponseToChannel vtable slot, AShooterCharacter::IsAlive and
  the IsUsing / IsUsingRecycler bits (their exec thunks, registered with
  AShooterCharacter's natives), and the fields from their property
  registrations: ACharacter's CharacterMovement and CapsuleComponent (next to
  JumpMaxCount), UCapsuleComponent's CapsuleHalfHeight and CapsuleRadius,
  USceneComponent's RelativeRotation (next to RelativeLocation and
  RelativeScale3D), UCharacterMovementComponent's MovementMode and
  Acceleration (next to MaxStepHeight); and the built blob uses every one.

Needs the Visual Studio C++ tools (as build_showdown_rounds.py does).

usage: python test_unstick_native.py [Victory.exe]
"""
import os
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_showdown_rounds as BUILD  # noqa: E402
import test_weather_native as TW  # noqa: E402

HARNESS = os.path.join(BUILD.HERE, "test_unstick_native.c")
passed = 0


def ok(msg):
    global passed
    passed += 1
    print("ok   " + msg)


def check(cond, msg):
    if not cond:
        print("FAIL " + msg)
        sys.exit(1)


def build(tmp):
    cl, env = TW.toolchain()
    obj = os.path.join(tmp, "module.obj")
    exe = os.path.join(tmp, "test_unstick_native.exe")
    for cmd in ([cl] + BUILD.CL_FLAGS + ["/Fo" + obj, BUILD.SOURCE],
                [cl, "/nologo", "/O1", "/W3", "/Fe" + exe, "/Fo" + os.path.join(tmp, "harness.obj"), HARNESS, obj]):
        r = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, text=True)
        if r.returncode:
            sys.exit("build failed:\n" + r.stdout + r.stderr)
    return exe


def unstick_defs():
    src = open(os.path.join(BUILD.HERE, "unstick.c"), encoding="utf-8").read()
    return {k: int(v, 16) for k, v in re.findall(r"#define (US[A-Z_]*)\s+(0x[0-9a-f]+)", src)}


def prop_offsets(ex, name):
    """[(registration site, offset)] for a property's wide name: the "mov r9d, <offset>" of its
    registration (the property's constructor call, within the next 40 instructions)."""
    out = []
    for site in ex.sites_of(name):
        text = " | ".join("%s %s" % (i.mnemonic, i.op_str) for i in ex.code(site, 0x120)[:40])
        m = re.search(r"mov r9d, (0x[0-9a-f]+|\d+)", text)
        if m:
            out.append((site, int(m.group(1), 0)))
    return out


def registered_with(ex, name, neighbours, within=0x6000):
    """The offsets of `name` registered within `within` bytes of every one of `neighbours`
    (the same class registers its properties in one function)."""
    near = [[s for s, _ in prop_offsets(ex, n)] + ex.sites_of(n) for n in neighbours]
    return {off for site, off in prop_offsets(ex, name)
            if all(any(abs(site - s) < within for s in sites) for sites in near)}


def exe_checks(path):
    ex = TW.Exe(path)
    u = unstick_defs()
    base = TW.BASE

    def impl_of(name, impl):
        thunks = ex.natives(name)
        check(any(impl in ex.calls(t, 0x600) for t in thunks),
              "%s: no registered exec thunk calls %x (thunks %s)" % (name, impl, [hex(t) for t in thunks]))
        return [t for t in thunks if impl in ex.calls(t, 0x600)]

    # K2_TeleportTo(loc, rot) is TeleportTo(loc, rot, bIsATest = false, bNoCheck = false): a virtual
    # call with r9b = 0 and the 5th argument 0.
    impl_of("K2_TeleportTo", u["US_TELEPORT"])
    body = " | ".join("%s %s" % (i.mnemonic, i.op_str) for i in ex.code(u["US_TELEPORT"], 0x40))
    check(re.search(r"xor r9d, r9d .*mov byte ptr \[rsp \+ 0x20\], 0 .*call qword ptr \[rax \+ 0x[0-9a-f]+\]", body),
          "K2_TeleportTo is not TeleportTo(loc, rot, false, false): %s" % body)
    # CapsuleOverlapComponents: the exec thunk reads ctx, pos, radius, half height, object types,
    # class filter, ignore, out - radius goes in xmm2 and half height in xmm3.
    thunk = impl_of("CapsuleOverlapComponents", u["US_OVERLAP"])[0]
    code = ex.code(thunk, 0x400)
    code = code[:next(k for k, i in enumerate(code) if i.mnemonic == "ret")]
    slots = []
    for k, i in enumerate(code):
        if i.mnemonic == "call" and i.op_str.startswith("0x") and int(i.op_str, 16) - base == 0x696150:
            prev = code[k - 1].op_str
            check(prev.startswith("r8, "), "CapsuleOverlapComponents: unexpected Step call")
            slots.append(prev.split(", ", 1)[1].replace("lea ", ""))
    check(len(slots) == 8, "CapsuleOverlapComponents reads %d parameters, not 8" % len(slots))
    text = " | ".join("%s %s" % (i.mnemonic, i.op_str) for i in code)
    check("movss xmm2, dword ptr %s" % slots[2] in text and "movss xmm3, dword ptr %s" % slots[3] in text,
          "CapsuleOverlapComponents: radius / half height are not in xmm2 / xmm3 (%s)" % slots[:4])
    # GetCollisionResponseToChannel: the thunk's virtual call.
    resp = " ".join(i.op_str for t in ex.natives("GetCollisionResponseToChannel") for i in ex.code(t, 0x80))
    check("[rax + 0x%x]" % u["USV_RESPONSE"] in resp, "GetCollisionResponseToChannel is not vtable +0x%x" % u["USV_RESPONSE"])
    # AShooterCharacter's natives: IsAlive registered next to IsUsing / IsUsingRecycler; those read
    # +0xd80 bits 0 and 1.
    using = [s for s, _ in ex.native_sites("IsUsing")]
    alive = [t for s, t in ex.native_sites("IsAlive") if any(abs(s - x) < 0x200 for x in using)]
    check(len(alive) == 1 and u["US_CH_ALIVE"] in ex.calls(alive[0]), "AShooterCharacter::IsAlive is not %x" % u["US_CH_ALIVE"])
    for name, op in (("IsUsing", "and al, 1"), ("IsUsingRecycler", "shr al, 1")):
        t = [t for s, t in ex.native_sites(name) if any(abs(s - x) < 0x200 for x in using)]
        body = " | ".join("%s %s" % (i.mnemonic, i.op_str) for i in ex.code(t[0], 0x40))
        check("movzx eax, byte ptr [rcx + 0x%x]" % u["USH_USING"] in body and op in body,
              "%s does not read +0x%x (%s)" % (name, u["USH_USING"], body))
    # Fields, from their property registrations.
    fields = (("USA_MOVEMENT", "CharacterMovement", ("JumpMaxCount", "CapsuleComponent")),
              ("USA_CAPSULE", "CapsuleComponent", ("JumpMaxCount", "CharacterMovement")),
              ("USC_HALF_HEIGHT", "CapsuleHalfHeight", ("CapsuleRadius",)),
              ("USC_RADIUS", "CapsuleRadius", ("CapsuleHalfHeight",)),
              ("USC_ROTATION", "RelativeRotation", ("RelativeLocation", "RelativeScale3D")),
              ("USM_MODE", "MovementMode", ("MaxStepHeight", "CustomMovementMode")),
              ("USM_ACCEL", "Acceleration", ("MaxStepHeight", "MaxDepenetrationWithGeometry")))
    for key, name, neighbours in fields:
        offs = registered_with(ex, name, neighbours)
        check(offs == {u[key]}, "%s: %s is registered at %s, not +0x%x" % (key, name, sorted(hex(o) for o in offs), u[key]))
    # The capsule is the root: RootComponent (+0x1e0, test_weather_native) is CapsuleComponent's value
    # in the PlayerPawn (checked in game by unstick_tick itself: root == CapsuleComponent).
    import capstone
    import showdown_rounds_blob as ROUNDS
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    imm = set()
    for i in md.disasm(ROUNDS.BLOB[:ROUNDS.SD_SELF_RVA], 0):
        for h in re.findall(r"0x[0-9a-f]+", i.op_str):
            imm.add(int(h, 16))
    for k in ("US_TELEPORT", "US_OVERLAP", "US_CH_ALIVE", "USV_RESPONSE", "USA_MOVEMENT", "USA_CAPSULE",
              "USC_HALF_HEIGHT", "USC_RADIUS", "USC_ROTATION", "USM_MODE", "USM_ACCEL", "USH_USING"):
        check(u[k] in imm, "the blob doesn't use %s (0x%x)" % (k, u[k]))
    return len(u)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        exe = build(tmp)
        r = subprocess.run([exe], capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        check(r.returncode == 0 and "all unstick native tests passed" in r.stdout, "behaviour checks")
        ok("behaviour checks")
    exe = sys.argv[1] if len(sys.argv) > 1 else TW.EXE
    if os.path.exists(exe):
        n = exe_checks(exe)
        ok("game addresses: all %d re-derived from %s, and in the blob" % (n, exe))
    else:
        print("skip game addresses (no %s)" % exe)
    print("%d checks passed" % passed)


if __name__ == "__main__":
    main()
