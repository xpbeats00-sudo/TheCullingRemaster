"""build_release.py runs every test before a release: each patch/test_*.py and
test_*.js is in its tests() list (or named in RUN_ELSEWHERE with what runs
it), each listed test exists, and the ES5 lint of the shipped UI scripts is
among them. A test added to patch/ but not to the build would otherwise
never stop a broken release (test_make_showdown.py and
test_showdown_menu.js were in that state).

usage: python test_build_release.py
"""
import argparse
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import build_release  # noqa: E402

a = argparse.Namespace(game="C:/game")
steps = build_release.tests(a, "C:/stage/Paks")
run = set()
for _label, argv, _cwd in steps:
    run.update(os.path.basename(x) for x in argv if isinstance(x, str))

have = sorted(f for f in os.listdir(HERE) if f.startswith("test_") and f.endswith((".py", ".js")))
missing = [f for f in have if f not in run and f not in build_release.RUN_ELSEWHERE]
assert not missing, "patch tests the release build never runs: %s (add them to build_release.tests())" % ", ".join(missing)
print("ok    every patch test (%d) runs in the release build" % len(have))

stale = [f for f in build_release.RUN_ELSEWHERE if f not in have]
assert not stale, "RUN_ELSEWHERE names tests that don't exist: %s" % ", ".join(stale)
gone = sorted({x for _l, argv, _c in steps for x in argv[1:2] + argv[2:3]
               if isinstance(x, str) and os.path.basename(x).startswith("test_") and not os.path.exists(x)
               and os.path.dirname(x) == HERE})
assert not gone, "the build lists tests that don't exist: %s" % ", ".join(gone)
print("ok    every test the build lists exists")

lint = [argv for _l, argv, _c in steps if any(os.path.basename(x) == "lint_es5.py" for x in argv)]
assert lint and "--release" in lint[0], "the build lints the shipped UI scripts (lint_es5.py --release)"
print("ok    the build lints every shipped UI script for ES5")
print("PASS (3 checks)")
