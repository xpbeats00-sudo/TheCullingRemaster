"""Run the native module's weather (weather.c, compiled into showdown_rounds.c
with the blob's own flags) against fake game objects (test_weather_native.c),
and check it against make_weather.py's Python copy of the schedule:

- behaviour: no ?Weather= (or an unknown preset) touches nothing; the
  weather waits for its Lighting level; storm sets fog, lights, sky and
  spawns the storm rain on the local pawn's root; one emitter per pawn; an
  emitter left on an old pawn is deactivated; clear has stars and no rain;
- the schedule: for every preset, with and without cycling, over several
  seeds and 20 minutes of match time, the C states, change times, blends and
  lightning are exactly the Python ones (weather_state / weather_flash);
- what is applied: over 15 minutes per preset, every second's fog density
  and start, moon and sky light intensity, cloud opacity and speed, stars
  and rain level are what the Python schedule and the map's constants
  (weather_maps.h) say;
- the game addresses (with the stock Victory.exe, read only): each RVA
  weather.c calls is re-derived from the exe itself - the natives by their
  registered names (lea r8, exec; lea rdx, "Name") and the exec thunk's call
  of the implementation, StaticFindObject / StaticLoadObject by their log
  strings, the FName constructor as StaticFindObject's own call, the
  Deactivate vtable slot from its exec thunk, RootComponent from
  K2_GetRootComponent and OptionsString from its property registration - and
  the built blob holds every one of them.

Needs the Visual Studio C++ tools (as build_showdown_rounds.py does).

usage: python test_weather_native.py [Victory.exe]
"""
import os
import re
import struct
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_showdown_rounds as BUILD  # noqa: E402
import make_weather as mw  # noqa: E402

HARNESS = os.path.join(BUILD.HERE, "test_weather_native.c")
PRESETS = list(mw.WEATHER_PRESETS)
passed = 0


def ok(msg):
    global passed
    passed += 1
    print("ok   " + msg)


def check(cond, msg):
    if not cond:
        print("FAIL " + msg)
        sys.exit(1)


def toolchain():
    cl = BUILD.find_cl()
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
    return cl, env


def build(tmp):
    cl, env = toolchain()
    obj = os.path.join(tmp, "module.obj")
    exe = os.path.join(tmp, "test_weather_native.exe")
    for cmd in ([cl] + BUILD.CL_FLAGS + ["/Fo" + obj, BUILD.SOURCE],
                [cl, "/nologo", "/O1", "/W3", "/Fe" + exe, "/Fo" + os.path.join(tmp, "harness.obj"), HARNESS, obj]):
        r = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, text=True)
        if r.returncode:
            sys.exit("build failed:\n" + r.stdout + r.stderr)
    return exe


def run(exe, *args):
    r = subprocess.run([exe] + [str(a) for a in args], capture_output=True, text=True)
    if r.returncode:
        sys.exit("harness failed:\n" + r.stdout)
    return r.stdout


def header_maps():
    text = open(mw.NATIVE_HEADER).read()
    rows = re.findall(r'\{L"([^"]+)",\s*L"[^"]+",\s*L"[^"]+",\s*L"[^"]+",\s*'
                      r'([\d.]+)f, ([\d.]+)f, ([\d.]+)f, ([\d.]+)f, (\d)\}', text)
    return [(fog, float(k), float(sun), float(sky), float(stars), int(n)) for fog, k, sun, sky, stars, n in rows]


def expected(seed, preset, cycle, t, k, sun_base, sky_base, stars_base, night):
    cur, prev, since, blend = mw.weather_state(seed, preset, cycle, t)
    a, b = mw.WEATHER_STATES[prev], mw.WEATHER_STATES[cur]

    def lerp(i):
        return a[i] + (b[i] - a[i]) * blend
    vis = lerp(6)
    moon, sky = lerp(4), lerp(5)
    if mw.weather_flash(seed, cur, t):
        moon *= 6.0
        sky *= 5.0
    rain = b[7] if blend >= 0.5 else a[7]
    return (k / vis, vis * 20.0 if vis < 40.0 else 800.0, sun_base * moon, sky_base * sky,
            lerp(1), lerp(2), stars_base * lerp(3) if night else None, rain)


EXE = r"C:\Culling\TheCulling\Victory\Binaries\Win64\Victory.exe"
BASE = 0x140000000


class Exe:
    """The stock exe's sections, its lea r64,[rip+x] sites and a disassembler."""

    def __init__(self, path):
        import capstone
        self.d = open(path, "rb").read()
        pe = struct.unpack_from("<I", self.d, 0x3C)[0]
        nsec = struct.unpack_from("<H", self.d, pe + 6)[0]
        opt = struct.unpack_from("<H", self.d, pe + 20)[0]
        self.secs = []
        for i in range(nsec):
            o = pe + 24 + opt + 40 * i
            vs, va, rs, rp = struct.unpack_from("<IIII", self.d, o + 8)
            self.secs.append((self.d[o:o + 8].rstrip(b"\0"), va, rs, rp))
        self.md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
        _, self.tva, self.tsize, self.toff = next(x for x in self.secs if x[0] == b".text")
        self._leas = None

    def off(self, rva):
        for _, va, rs, rp in self.secs:
            if va <= rva < va + rs:
                return rp + rva - va
        raise KeyError(hex(rva))

    def rva(self, off):
        for _, va, rs, rp in self.secs:
            if rp <= off < rp + rs:
                return va + off - rp
        return None

    def leas(self):
        """target RVA -> [(site RVA, first 3 bytes)] for every lea r64, [rip+disp32] in .text."""
        if self._leas is None:
            self._leas = {}
            t = self.d[self.toff:self.toff + self.tsize]
            for m in re.finditer(rb"[\x48\x4c]\x8d[\x05\x0d\x15\x1d\x25\x2d\x35\x3d]", t):
                i = m.start()
                tgt = self.tva + i + 7 + struct.unpack_from("<i", t, i + 3)[0]
                self._leas.setdefault(tgt, []).append((self.tva + i, t[i:i + 3]))
        return self._leas

    def strings(self, s, wide):
        b = (s.encode("utf-16le") + b"\0\0") if wide else (b"\0" + s.encode() + b"\0")
        out = []
        for m in re.finditer(re.escape(b), self.d):
            o = m.start() + (0 if wide else 1)
            r = self.rva(o)
            if r is not None and (not wide or o % 2 == 0):
                out.append(r)
        return out

    def code(self, rva, n=0x200):
        o = self.off(rva)
        return list(self.md.disasm(self.d[o:o + n], BASE + rva))

    def native_sites(self, name):
        """(registration site, exec thunk) RVAs for `name` (lea r8, exec; lea rdx, name)."""
        out = []
        for s in self.strings(name, False):
            for site, op in self.leas().get(s, []):
                o = self.off(site - 7)
                if op == b"\x48\x8d\x15" and self.d[o:o + 3] == b"\x4c\x8d\x05":
                    out.append((site, site + struct.unpack_from("<i", self.d, o + 3)[0]))
        return out

    def natives(self, name):
        return [t for _, t in self.native_sites(name)]

    def calls(self, rva, n=0x200):
        out = []
        for i in self.code(rva, n):
            if i.mnemonic in ("call", "jmp") and i.op_str.startswith("0x"):
                out.append(int(i.op_str, 16) - BASE)
            if i.mnemonic == "ret":
                break
        return out

    def sites_of(self, wide_string):
        return [site for s in self.strings(wide_string, True) for site, _ in self.leas().get(s, [])]


def weather_rvas():
    src = open(os.path.join(BUILD.HERE, "weather.c"), encoding="utf-8").read()
    return {k: int(v, 16) for k, v in re.findall(r"#define (WX[A-Z_]*)\s+(0x[0-9a-f]+)", src)}


def exe_checks(path):
    ex = Exe(path)
    w = weather_rvas()

    def native_impl(name, impl):
        thunks = ex.natives(name)
        check(any(impl in ex.calls(t) for t in thunks),
              "%s: no registered exec thunk calls %x (thunks %s)" % (name, impl, [hex(t) for t in thunks]))
    native_impl("SetFogDensity", w["WX_FOG_DENSITY"])
    native_impl("SetStartDistance", w["WX_FOG_START"])
    native_impl("SetIntensity", w["WX_LIGHT_INTENSITY"])
    native_impl("SetIntensity", w["WX_SKY_INTENSITY"])
    native_impl("SetScalarParameterValue", w["WX_MID_SCALAR"])
    native_impl("SpawnEmitterAttached", w["WX_SPAWN_ATTACHED"])
    # The intensity setters write ULightComponentBase::Intensity (+0x314); the
    # fog setters the fog component's density (+0x300) and start (+0x358).
    for impl, field in ((w["WX_LIGHT_INTENSITY"], "0x314"), (w["WX_SKY_INTENSITY"], "0x314"),
                        (w["WX_FOG_DENSITY"], "0x300"), (w["WX_FOG_START"], "0x358")):
        text = " ".join("%s %s" % (i.mnemonic, i.op_str) for i in ex.code(impl, 0x60))
        check(re.search(r"movss dword ptr \[r[a-z0-9]+ \+ %s\], xmm" % field, text),
              "%x does not write +%s" % (impl, field))
    check(ex.calls(w["WX_LIGHT_INTENSITY"]) != ex.calls(w["WX_SKY_INTENSITY"]), "the two SetIntensity are one")
    # Which class each SetIntensity belongs to: a class registers its natives
    # together, so the light's sits by SetIndirectLightingIntensity
    # (ULightComponent) and the sky light's by RecaptureSky (USkyLightComponent).
    def registered_near(impl, other):
        sites = [s for name in ("SetIntensity",) for s in ex.native_sites(name) if impl in ex.calls(s[1])]
        near = [s for s, _ in ex.native_sites(other)]
        return any(abs(a - b) < 0x200 for a, _ in sites for b in near)
    check(registered_near(w["WX_LIGHT_INTENSITY"], "SetIndirectLightingIntensity"), "light SetIntensity's class")
    check(registered_near(w["WX_SKY_INTENSITY"], "RecaptureSky"), "sky light SetIntensity's class")
    check(not registered_near(w["WX_SKY_INTENSITY"], "SetTemperature"), "sky light SetIntensity is a ULightComponent one")
    check(registered_near(w["WX_LIGHT_INTENSITY"], "SetTemperature"), "light SetIntensity is not ULightComponent's")
    mid = [a for a, t in ex.native_sites("SetScalarParameterValue") if w["WX_MID_SCALAR"] in ex.calls(t)]
    near = [a for a, _ in ex.native_sites("K2_CopyMaterialInstanceParameters")]
    check(any(abs(a - b) < 0x200 for a in mid for b in near), "SetScalarParameterValue is not the MID's")
    finds = ex.sites_of("Illegal call to StaticFindObject() while serializing object data!")
    check(finds and all(w["WX_FIND_OBJECT"] <= s < w["WX_FIND_OBJECT"] + 0x100 for s in finds), "StaticFindObject")
    loads = ex.sites_of("Failed to find object '{ClassName} {OuterName}.{ObjectName}'")
    check(loads and all(w["WX_LOAD_OBJECT"] < s < w["WX_LOAD_OBJECT"] + 0x800 for s in loads), "StaticLoadObject")
    check(w["WX_FNAME"] in ex.calls(w["WX_FIND_OBJECT"], 0x400), "StaticFindObject makes its FName elsewhere")
    deact = " ".join(i.op_str for t in ex.natives("Deactivate") for i in ex.code(t, 0x40))
    check("[rax + 0x%x]" % w["WXV_DEACTIVATE"] in deact, "Deactivate is not vtable +0x210")
    act = " ".join(i.op_str for t in ex.natives("Activate") for i in ex.code(t, 0x60))
    check("[rax + 0x%x]" % (w["WXV_DEACTIVATE"] - 8) in act, "Activate is not the slot before Deactivate")
    root = " ".join(i.op_str for t in ex.natives("K2_GetRootComponent") for i in ex.code(t, 0x30))
    check("[rcx + 0x%x]" % w["WXA_ROOT"] in root, "RootComponent is not +0x1e0")
    site = ex.sites_of("OptionsString")
    check(site, "no OptionsString registration")
    text = " ".join("%s %s" % (i.mnemonic, i.op_str) for i in ex.code(site[0], 0x100))
    check("mov r9d, 0x%x" % w["WXG_OPTIONS"] in text, "OptionsString is not at +0x400")
    import capstone
    import showdown_rounds_blob as ROUNDS
    md = capstone.Cs(capstone.CS_ARCH_X86, capstone.CS_MODE_64)
    imm = set()
    for i in md.disasm(ROUNDS.BLOB[:ROUNDS.SD_SELF_RVA], 0):
        for h in re.findall(r"0x[0-9a-f]+", i.op_str):
            imm.add(int(h, 16))
    for k in ("WX_FIND_OBJECT", "WX_LOAD_OBJECT", "WX_FNAME", "WX_FOG_DENSITY", "WX_FOG_START",
              "WX_LIGHT_INTENSITY", "WX_SKY_INTENSITY", "WX_MID_SCALAR", "WX_SPAWN_ATTACHED"):
        check(w[k] in imm, "the blob doesn't call %s" % k)
    return len(w)


def main():
    with tempfile.TemporaryDirectory() as tmp:
        exe = build(tmp)
        out = run(exe, "checks")
        sys.stdout.write(out)
        check("all weather native tests passed" in out, "behaviour checks")
        ok("behaviour checks")

        seeds = [0, 1, 42, 1234567, 0xDEADBEEF, 2026, 99991, 31337]
        n = flashes = changes = 0
        for seed in seeds:
            for p in range(len(PRESETS)):
                for cycle in (1, 0):
                    lines = run(exe, "probe", seed, p, cycle, 0, 1200).split()
                    for i in range(0, len(lines), 7):
                        t, cur, prev, since, blend, flash = map(int, lines[i + 1:i + 7])
                        want = mw.weather_state(seed, p, cycle, t)
                        check((cur, prev, since) == want[:3],
                              "seed %d %s cycle %d t %d: C %s, Python %s" % (
                                  seed, PRESETS[p], cycle, t, (cur, prev, since), want[:3]))
                        check(abs(blend - round(want[3] * 1000)) <= 1, "blend at t %d" % t)
                        check(bool(flash) == mw.weather_flash(seed, cur, t), "lightning at t %d" % t)
                        flashes += flash
                        changes += since == 0 and t > 0
                        if not cycle:
                            check(cur == mw.WEATHER_PRESETS[PRESETS[p]][0], "WeatherCycle=0 changed state")
                        n += 1
        check(flashes > 0 and changes > 0, "no lightning or no changes at all")
        ok("schedule: %d seconds over %d seeds x %d presets agree with Python (%d changes, %d flashes)" % (
            n, len(seeds), len(PRESETS), changes, flashes))

        maps = header_maps()
        check(len(maps) == len(mw.NATIVE_MAPS), "weather_maps.h rows: %d" % len(maps))
        fog_path, k, sun_base, sky_base, stars_base, night = maps[0]
        prefix = fog_path.split(":")[0] + ":"
        for p, preset in enumerate(PRESETS):
            seed = 4242 + p
            lines = [ln.split() for ln in run(exe, "run", "?Weather=%s?WeatherSeed=%d" % (preset, seed), prefix, 900)
                     .splitlines() if ln.startswith("T ")]
            check(len(lines) == 901, "run lines")
            seen = set()
            for ln in lines:
                t = int(ln[1])
                got = [float(x) for x in ln[2:9]] + [int(ln[9])]
                want = expected(seed, p, 1, t, k, sun_base, sky_base, stars_base, night)
                seen.add(mw.weather_state(seed, p, 1, t)[0])
                for i, (g, w) in enumerate(zip(got, want)):
                    if w is None:
                        continue
                    check(abs(g - w) <= 1e-3 * max(1.0, abs(w)),
                          "%s t %d field %d: applied %s, expected %s" % (preset, t, i, g, w))
            ok("%s (seed %d): 900 s of applied fog, lights, sky and rain match the schedule; states %s" % (
                preset, seed, ", ".join(mw.WEATHER_STATES[s][0] for s in sorted(seen))))
    exe = sys.argv[1] if len(sys.argv) > 1 else EXE
    if os.path.exists(exe):
        n = exe_checks(exe)
        ok("game addresses: all %d re-derived from %s, and in the blob" % (n, exe))
    else:
        print("skip game addresses (no %s)" % exe)
    print("%d checks passed" % passed)


if __name__ == "__main__":
    main()
