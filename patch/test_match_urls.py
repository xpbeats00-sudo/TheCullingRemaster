"""Duo and Showdown open their own URLs (StartTraining(url), patched exe), and the SURVIVAL
screen's match slots keep their stock maps.

- ClientWeb.js's REMASTER_DUO_URLS and REMASTER_SHOWDOWN_URL are exactly
  make_duo.URLS and make_showdown.URL, and it starts both with
  StartTraining(url) (never a SURVIVAL slot name).
- The generated DefaultGame.ini (src/) has the stock Training and Survival
  slots; with a Paks dir they are compared to the stock config.
- The generated FrontEnd.html shows the SURVIVAL item.

usage: python test_match_urls.py [Paks dir]
"""
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import make_duo  # noqa: E402
import make_showdown  # noqa: E402

UI = os.path.join(HERE, "src", "Victory", "Content", "uiresources", "FrontEnd")
CONFIG = os.path.join(HERE, "src", "Victory", "Config", "DefaultGame.ini")
SLOTS = ("TrainingMapBasic", "TrainingMapAdvanced", "SurvivalBasic", "SurvivalAdvanced", "OfflineMap", "OfflineMap2")

failures = []


def check(ok, msg):
    if not ok:
        failures.append(msg)


js = open(os.path.join(UI, "js", "ClientWeb.js"), encoding="utf-8").read()
m = re.search(r"var REMASTER_DUO_URLS = (\[.*?\]);", js, re.S)
check(m and json.loads(m.group(1)) == [make_duo.URLS[0], make_duo.URLS[1]], "ClientWeb.js REMASTER_DUO_URLS != make_duo.URLS")
m = re.search(r'var REMASTER_SHOWDOWN_URL = ("[^"]*");', js)
check(m and json.loads(m.group(1)) == make_showdown.URL, "ClientWeb.js REMASTER_SHOWDOWN_URL != make_showdown.URL")
m = re.search(r"var REMASTER_TEAM_URLS = (\{.*?\n\});", js, re.S)
check(m and json.loads(m.group(1)) == {"trio": [make_duo.TEAM_URLS[3][0], make_duo.TEAM_URLS[3][1]],
                                       "quad": [make_duo.TEAM_URLS[4][0], make_duo.TEAM_URLS[4][1]]},
      "ClientWeb.js REMASTER_TEAM_URLS != make_duo.TEAM_URLS")
for n in make_duo.TEAM_SIZES:
    for url in make_duo.TEAM_URLS[n].values():
        check(url.endswith("?TeamSize=%d" % n) and make_duo.MODE in url, "Trios/Quads URL %s" % url)
check('engine.call("StartTraining", REMASTER_TEAM_URLS[' in js, "Trios/Quads aren't started with StartTraining(url)")
# The module's team summary is debug only (?TeamDebug=1): no shipped URL turns it on.
check("teamdebug" not in js.lower() and not any("teamdebug" in u.lower() for n in make_duo.TEAM_SIZES
                                                 for u in make_duo.TEAM_URLS[n].values()),
      "a shipped match URL has ?TeamDebug= (the debug team summary)")
check('engine.call("StartTraining", REMASTER_DUO_URLS' in js, "Duo isn't started with StartTraining(url)")
check('engine.call("StartTraining", showdownUrl)' in js and "var showdownUrl = RemasterShowdownURL(msg.gameServer);" in js,
      "Showdown isn't started with StartTraining(RemasterShowdownURL(...))")
# Team Showdown: "showdown:<n>" is the Showdown URL plus ?TeamSize=n (ClientWeb.js RemasterShowdownURL, run in node).
for n, url in make_showdown.TEAM_URLS.items():
    check(url == make_showdown.URL + "?TeamSize=%d" % n and "teamdebug" not in url.lower(), "team Showdown URL %s" % url)
import subprocess  # noqa: E402
probe = js[js.index("var REMASTER_SHOWDOWN_URL"):js.index("// Trios and Quads: the Duo URLs")] + """
var out = {};
["showdown:1v1", "showdown:1", "showdown:2", "showdown:3", "showdown:4", "showdown:2v2", "showdown:4v4",
 "showdown:5", "showdown:0", "showdown:2v3", "showdown:", "showdown:x", "duo:0", "showdown:22"].forEach(function (k) {
  out[k] = RemasterShowdownURL(k);
});
console.log(JSON.stringify(out));
"""
r = subprocess.run(["node", "-e", probe], capture_output=True, text=True)
got = json.loads(r.stdout) if r.returncode == 0 else {}
want = {"showdown:1v1": make_showdown.URL, "showdown:1": make_showdown.URL, "showdown:2": make_showdown.TEAM_URLS[2],
        "showdown:3": make_showdown.TEAM_URLS[3], "showdown:4": make_showdown.TEAM_URLS[4],
        "showdown:2v2": make_showdown.TEAM_URLS[2], "showdown:4v4": make_showdown.TEAM_URLS[4],
        "showdown:5": None, "showdown:0": None, "showdown:2v3": None, "showdown:": None, "showdown:x": None,
        "duo:0": None, "showdown:22": None}
check(got == want, "RemasterShowdownURL: %s" % {k: got.get(k) for k in want if got.get(k) != want[k]} if got else r.stderr)
check('"ConnectToServer", REMASTER' not in js, "a match is opened with ConnectToServer")
for slot in ("SurvivalBasic", "SurvivalAdvanced", "Practice"):
    check('engine.call("StartTraining", "%s")' % slot not in js, "ClientWeb.js still starts %s" % slot)
check("CoopRanked" not in open(CONFIG, encoding="utf-8").read(), "a DefaultGame.ini slot still opens the pairs mode")
check("Lightning" not in open(CONFIG, encoding="utf-8").read(), "a DefaultGame.ini slot still opens Showdown")


def slots(text):
    out = {}
    for line in text.splitlines():
        key = line.split("=")[0].strip()
        if key in SLOTS:
            out[key] = line.split("=", 1)[1].strip().strip('"')
    return out


mine = slots(open(CONFIG, encoding="utf-8").read())
check(set(mine) == set(SLOTS), "DefaultGame.ini slots: %s" % sorted(mine))
if len(sys.argv) > 1:
    from build_catalog import pak_entries, read_entry
    stock = None
    for e in pak_entries(os.path.join(sys.argv[1], "pakchunk0-WindowsClient.pak")):
        if e[1].endswith("Victory/Config/DefaultGame.ini"):
            stock = slots(read_entry(*([e[0]] + list(e[2:]))).decode("utf-8"))
    check(stock == mine, "DefaultGame.ini slots differ from stock: %s" %
          {k: (stock.get(k), mine.get(k)) for k in SLOTS if stock.get(k) != mine.get(k)})

html = open(os.path.join(UI, "FrontEnd.html"), encoding="utf-8").read()
check('data-push-screen="Training">' in html and "SURVIVAL: Duo and Showdown use its match slots" not in html,
      "FrontEnd.html doesn't show SURVIVAL")

if failures:
    for f in failures:
        print("FAIL", f)
    sys.exit(1)
print("ok    Duo, Trios, Quads and Showdown (1v1, showdown:<n> -> ?TeamSize=n) open their own URLs; SURVIVAL's slots are stock%s"
      % ("" if len(sys.argv) > 1 else " (no Paks dir: stock compare skipped)"))
