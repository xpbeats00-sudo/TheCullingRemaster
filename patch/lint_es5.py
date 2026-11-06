"""ES5 check for the UI scripts Coherent UI runs (the game's browser has no ES2015).

Strips comments, strings and regex literals, then flags ES2015+ syntax: arrow
functions, let/const, template literals, classes, spread/rest, for...of,
default parameters. Whole files by default; with --diff <git ref> only the
lines added since that ref (for stock files that already use const).

usage: python lint_es5.py [--diff REF] file.js ...
"""
import re
import subprocess
import sys

RULES = [
    (re.compile(r"=>"), "arrow function"),
    (re.compile(r"\blet\s+[A-Za-z_$\[{]"), "let"),
    (re.compile(r"\bconst\s+[A-Za-z_$\[{]"), "const"),
    (re.compile(r"`"), "template literal"),
    (re.compile(r"\bclass\s+[A-Za-z_$]"), "class"),
    (re.compile(r"\.\.\.\s*[A-Za-z_$\[{(]"), "spread/rest"),
    (re.compile(r"\bfor\s*\([^;)]*\bof\b"), "for...of"),
    (re.compile(r"\bfunction\b[^(]*\([^)]*="), "default parameter"),
]


def strip(src):
    """The code with comments, strings and regex literals blanked (line breaks kept)."""
    out, i, n = [], 0, len(src)
    prev = ""                        # last significant character, to tell a regex from a division
    while i < n:
        c = src[i]
        if src.startswith("//", i):
            j = src.find("\n", i)
            j = n if j < 0 else j
            out.append(" " * (j - i))
            i = j
        elif src.startswith("/*", i):
            j = src.find("*/", i + 2)
            j = n if j < 0 else j + 2
            out.append(re.sub(r"[^\n]", " ", src[i:j]))
            i = j
        elif c in "'\"":
            j = i + 1
            while j < n and src[j] != c and src[j] != "\n":
                j += 2 if src[j] == "\\" else 1
            out.append(c + " " * (j - i - 1) + c)
            i = j + 1
        elif c == "`":
            out.append("`")
            i += 1
        elif c == "/" and (prev == "" or prev in "(,=:[!&|?{};+-*%<>~^" or src[max(0, i - 6):i].rstrip().endswith("return")):
            j, cls = i + 1, False
            while j < n and src[j] != "\n" and (src[j] != "/" or cls):
                if src[j] == "\\":
                    j += 1
                elif src[j] == "[":
                    cls = True
                elif src[j] == "]":
                    cls = False
                j += 1
            out.append("/" + " " * (j - i - 1) + "/")
            i = j + 1
        else:
            out.append(c)
            if not c.isspace():
                prev = c
            i += 1
            continue
        prev = "a"
    return "".join(out)


def added_lines(path, ref):
    diff = subprocess.run(["git", "diff", "-U0", ref, "--", path], capture_output=True, text=True, check=True).stdout
    lines = set()
    for m in re.finditer(r"^@@ -\S+ \+(\d+)(?:,(\d+))? @@", diff, re.M):
        start, count = int(m.group(1)), int(m.group(2) or "1")
        lines.update(range(start, start + count))
    return lines


def lint(path, only=None):
    src = open(path, encoding="utf-8").read()
    bad = []
    for no, line in enumerate(strip(src).split("\n"), 1):
        if only is not None and no not in only:
            continue
        for rule, what in RULES:
            if rule.search(line):
                bad.append("%s:%d: %s: %s" % (path, no, what, src.split("\n")[no - 1].strip()[:100]))
    return bad


if __name__ == "__main__":
    args = sys.argv[1:]
    ref = None
    if args[:1] == ["--diff"]:
        ref, args = args[1], args[2:]
    problems = []
    for f in args:
        problems += lint(f, added_lines(f, ref) if ref else None)
    for p in problems:
        print("FAIL", p)
    if problems:
        sys.exit(1)
    print("ok    ES5: %d file(s)%s" % (len(args), " (lines added since %s)" % ref if ref else ""))
