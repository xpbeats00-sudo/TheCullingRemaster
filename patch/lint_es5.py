"""ES5 check for the UI scripts Coherent UI runs (the game's browser has no ES2015).

Strips comments, strings and regex literals, then flags ES2015+ syntax: arrow
functions, let/const, template literals, classes, spread/rest, for...of,
default parameters, shorthand methods, destructuring, async/await, **,
optional chaining and ??. Whole files by default; with --diff <git ref> only
the lines added since that ref (for stock files that already use const).

--release lints every UI script the patch pak ships (patch/src/**/uiresources),
whole files, with const allowed (the stock scripts use it and Coherent UI runs
them): build_release.py runs it before every release.

usage: python lint_es5.py [--diff REF] file.js ...
       python lint_es5.py --release
"""
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

RULES = [
    (re.compile(r"=>"), "arrow function"),
    (re.compile(r"\blet\s+[A-Za-z_$\[{]"), "let"),
    (re.compile(r"\bconst\s+[A-Za-z_$\[{]"), "const"),
    (re.compile(r"`"), "template literal"),
    (re.compile(r"\bclass\s+[A-Za-z_$]"), "class"),
    (re.compile(r"\.\.\.\s*[A-Za-z_$\[{(]"), "spread/rest"),
    (re.compile(r"\bfor\s*\([^;)]*\bof\b"), "for...of"),
    (re.compile(r"\bfunction\b[^(]*\([^)]*="), "default parameter"),
    # An object literal's foo() { ... }: a line that starts with a call and a
    # block is no ES5 statement (if/for/while/switch/catch/with are).
    (re.compile(r"^\s*(?!(?:if|for|while|switch|catch|with|function|return)\b)[A-Za-z_$][\w$]*\s*\([^()]*\)\s*\{"),
     "shorthand method"),
    (re.compile(r"\b(?:var|let|const)\s*[\[{]"), "destructuring"),
    (re.compile(r"\basync\s+(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)"), "async function"),
    (re.compile(r"\bawait\s+[A-Za-z_$(\[]"), "await"),
    (re.compile(r"\*\*"), "exponent operator"),
    (re.compile(r"\?\.(?!\d)"), "optional chaining"),
    (re.compile(r"\?\?"), "nullish coalescing"),
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


def lint(path, only=None, allow_const=False):
    src = open(path, encoding="utf-8-sig").read()
    bad = []
    lines = src.split("\n")
    for no, line in enumerate(strip(src).split("\n"), 1):
        if only is not None and no not in only:
            continue
        for rule, what in RULES:
            if allow_const and what == "const":
                continue
            if rule.search(line):
                bad.append("%s:%d: %s: %s" % (path, no, what, lines[no - 1].strip()[:100]))
    return bad


def release_scripts(src=os.path.join(HERE, "src")):
    """Every .js the patch pak ships under a uiresources folder (Coherent UI runs them)."""
    out = []
    for root, _, names in os.walk(src):
        if "uiresources" not in root.replace(os.sep, "/").split("/"):
            continue
        out += [os.path.join(root, n) for n in names if n.lower().endswith(".js")]
    return sorted(out)


def main(args):
    ref = None
    allow_const = False
    if args[:1] == ["--release"]:
        args, allow_const = release_scripts(), True
        if not args:
            print("FAIL no UI scripts under %s" % os.path.join(HERE, "src"))
            return 1
    elif args[:1] == ["--diff"]:
        ref, args = args[1], args[2:]
    if not args:
        print(__doc__)
        return 2
    problems = []
    for f in args:
        problems += lint(f, added_lines(f, ref) if ref else None, allow_const)
    for p in problems:
        print("FAIL", p)
    if problems:
        return 1
    print("ok    ES5: %d file(s)%s" % (len(args), " (lines added since %s)" % ref if ref else
                                       ", const allowed (stock)" if allow_const else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
