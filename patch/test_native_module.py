"""Run the native module's Duo and Chokening code (showdown_rounds.c, compiled
with the blob's own flags) against fake game objects (test_native_module.c).

Needs the Visual Studio C++ tools (as build_showdown_rounds.py does).

usage: python test_native_module.py
"""
import os
import subprocess
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_showdown_rounds as BUILD  # noqa: E402

HARNESS = os.path.join(BUILD.HERE, "test_native_module.c")


def main():
    cl = BUILD.find_cl()
    env = dict(os.environ, PATH=os.path.dirname(cl) + os.pathsep + os.environ.get("PATH", ""))
    vc = os.path.abspath(os.path.join(os.path.dirname(cl), "..", "..", ".."))
    kits = r"C:\Program Files (x86)\Windows Kits\10"
    inc = [os.path.join(vc, "include")]
    lib = [os.path.join(vc, "lib", "x64")]
    for sub in ("ucrt", "um", "shared"):
        vers = sorted(os.listdir(os.path.join(kits, "Include"))) if os.path.isdir(os.path.join(kits, "Include")) else []
        if vers:
            inc.append(os.path.join(kits, "Include", vers[-1], sub))
            lib.append(os.path.join(kits, "Lib", vers[-1], sub, "x64"))
    env["INCLUDE"] = os.pathsep.join(p for p in inc + [env.get("INCLUDE", "")] if p)
    env["LIB"] = os.pathsep.join(p for p in lib + [env.get("LIB", "")] if p)
    with tempfile.TemporaryDirectory() as tmp:
        obj = os.path.join(tmp, "module.obj")
        exe = os.path.join(tmp, "test_native_module.exe")
        steps = ([cl] + BUILD.CL_FLAGS + ["/Fo" + obj, BUILD.SOURCE],
                 [cl, "/nologo", "/O1", "/W3", "/Fe" + exe, "/Fo" + os.path.join(tmp, "harness.obj"), HARNESS, obj])
        for cmd in steps:
            r = subprocess.run(cmd, cwd=tmp, env=env, capture_output=True, text=True)
            if r.returncode:
                sys.exit("build failed:\n" + r.stdout + r.stderr)
        r = subprocess.run([exe], capture_output=True, text=True)
        sys.stdout.write(r.stdout)
        if r.returncode:
            sys.exit("native module tests failed (%d)" % r.returncode)


if __name__ == "__main__":
    main()
