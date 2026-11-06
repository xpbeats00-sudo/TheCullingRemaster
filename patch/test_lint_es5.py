"""lint_es5.py: each ES2015+ form Coherent UI can't run is caught, ES5 that
looks close (if/for blocks, getters, `=>` or `**` inside strings, comments
and regex literals) is not, and --release covers every UI script the patch
pak ships.

usage: python test_lint_es5.py
"""
import os
import shutil
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import lint_es5  # noqa: E402

BAD = {
    "arrow function": "var f = function () { return [1].map(x => x); };",
    "let": "let a = 1;",
    "const": "const A = 1;",
    "template literal": "var s = `a${b}`;",
    "class": "class A {}",
    "spread/rest": "f(...args);",
    "for...of": "for (var x of xs) {}",
    "default parameter": "function f(a, b = 2) {}",
    "shorthand method": "var o = {\n  open(root) {\n    return root;\n  }\n};",
    "destructuring": "var { a, b } = o;",
    "async function": "async function f() {}",
    "await": "function f() { await g(); }",
    "exponent operator": "var x = 2 ** 3;",
    "optional chaining": "var n = a?.b;",
    "nullish coalescing": "var n = a ?? 1;",
}
GOOD = "\n".join([
    "// arrows => in a comment, a ?? b, x ** y, async function, let x",
    "/* class A {} `tpl` ...rest */",
    "var s = \"=> ?? ?. ** ` class X let y const z\";",
    "var r = /a=>b|\\*\\*/g;",
    "if (a) {",
    "} else if (b) {",
    "}",
    "for (var i = 0; i < n; i++) {",
    "}",
    "while (x) {",
    "}",
    "switch (k) {",
    "}",
    "try { f(); } catch (e) {",
    "}",
    "var o = { get size() { return 1; }, n: c ? .5 : 1 };",
    "var t = a ? b : c;",
    "var f = function (a, b) { return a == b; };",
])

checks = 0
tmp = tempfile.mkdtemp(prefix="lint-es5-test-")
try:
    for what, code in BAD.items():
        path = os.path.join(tmp, "bad.js")
        with open(path, "w", encoding="utf-8") as f:
            f.write(code)
        found = [p for p in lint_es5.lint(path) if (": %s:" % what) in p]
        assert found, "%s not caught in %r: %s" % (what, code, lint_es5.lint(path))
        checks += 1
    print("ok    %d ES2015+ forms caught" % len(BAD))

    path = os.path.join(tmp, "good.js")
    with open(path, "w", encoding="utf-8") as f:
        f.write(GOOD)
    assert lint_es5.lint(path) == [], lint_es5.lint(path)
    checks += 1
    print("ok    ES5 that looks close is not flagged (blocks, getters, strings, comments, regex)")

    path = os.path.join(tmp, "stock.js")
    with open(path, "w", encoding="utf-8") as f:
        f.write("﻿const A = 1;\r\nvar b = A;\r\n")
    assert [p for p in lint_es5.lint(path) if ": const:" in p], "const is flagged by default"
    assert lint_es5.lint(path, allow_const=True) == [], "--release allows the stock scripts' const"
    checks += 1
    print("ok    const: flagged by default, allowed for the stock scripts (--release); BOM and CRLF read")

    scripts = [os.path.relpath(p, os.path.join(HERE, "src")).replace(os.sep, "/") for p in lint_es5.release_scripts()]
    for want in ("Victory/Content/uiresources/FrontEnd/js/Showdown.js", "Victory/Content/uiresources/hud/js/hud.js",
                 "Victory/Content/uiresources/FrontEnd/js/Screens/CustomMatchSettings.js"):
        assert want in scripts, (want, scripts)
    assert lint_es5.main(["--release"]) == 0, "the shipped UI scripts pass"
    checks += 1
    print("ok    --release lints the %d shipped UI scripts, and they pass" % len(scripts))
finally:
    shutil.rmtree(tmp, ignore_errors=True)
print("PASS (%d checks)" % checks)
