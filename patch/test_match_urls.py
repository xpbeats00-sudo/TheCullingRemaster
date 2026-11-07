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
# The module's autotest (autotest.c) runs only with ?RemasterAutoTest= in the match URL: no
# shipped URL, page, generator or server answer may carry it. Only patch/autotest/ (the runner
# and its HUD probe, never packed into a release) and the module itself name it.
AUTOTEST = re.compile(r"remasterautotest", re.I)
ROOT = os.path.dirname(HERE)
shipped = []
for base in (os.path.join(HERE, "src"), os.path.join(ROOT, "server"), os.path.join(ROOT, "launcher")):
    for dirpath, dirnames, filenames in os.walk(base):
        dirnames[:] = [d for d in dirnames if d not in ("node_modules", "test", "dist")]
        for fn in filenames:
            if fn.endswith((".js", ".html", ".ini", ".json", ".css")):
                p = os.path.join(dirpath, fn)
                try:
                    if AUTOTEST.search(open(p, encoding="utf-8", errors="replace").read()):
                        shipped.append(os.path.relpath(p, ROOT))
                except OSError:
                    pass
check(not shipped, "?RemasterAutoTest= is named in shipped files: %s" % shipped)
import make_weather  # noqa: E402
import custom_match  # noqa: E402
urls = ([make_showdown.URL] + list(make_showdown.TEAM_URLS.values()) + list(make_duo.URLS.values())
        + [u for n in make_duo.TEAM_SIZES for u in make_duo.TEAM_URLS[n].values()]
        + list(custom_match.URLS.values()) + list(make_weather.MAP_PATHS) + list(make_weather.MODE_GAMES.values()))
check(not any(AUTOTEST.search(u) for u in urls), "a generator's match URL has ?RemasterAutoTest=")
check(not AUTOTEST.search(js), "ClientWeb.js names ?RemasterAutoTest=")
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
# Night maps and weather: "map:<solo|duo>:<n>?..." (ClientWeb.js RemasterMapUrl, run in node). Every
# answer the server's weather.js gameServer() gives opens its map with exactly its options; only
# Weather, WeatherSeed, WeatherCycle and TeamSize with their own values are let through, each once.
probe = js[js.index("var REMASTER_MAP_PATHS"):js.index("var socketConnection")] + """
var weather = require(process.argv[1]);
var answers = [], cfg = { night: true, day: true, presets: weather.PRESETS };
Object.keys(weather.maps(cfg)).forEach(function (map) {
  [null, true, { size: 3, start: "trio:" }, { size: 4, start: "quad:" }].forEach(function (team) {
    [null].concat(weather.PRESETS.map(function (p) { return { preset: p, seed: 2147483646 }; })).forEach(function (w) {
      var s = weather.gameServer(cfg, map, team, w);
      if (s.indexOf("map:") == 0) answers.push(s);
    });
  });
});
var bad = ["map:solo:0?RemasterAutoTest=teamwin", "map:solo:2?Weather=rainy?RemasterAutoTest=1",
  "map:solo:2?Unstick=0", "map:solo:2?TeamDebug=1", "map:duo:2?Weather=rainy?Weather=storm",
  "map:solo:2?Weather=hail", "map:solo:2?WeatherSeed=12345678901", "map:solo:2?WeatherSeed=-1",
  "map:solo:2?WeatherCycle=2", "map:duo:2?TeamSize=8", "map:duo:2?TeamSize=1", "map:duo:2?teamsize=3",
  "map:solo:4", "map:solo:2?Weather=", "map:solo:2?bEnableBots=false", "map:solo:2?game=X",
  "map:solo:2?Weather=rainy?WeatherSeed=1?WeatherCycle=0?TeamSize=3?Weather=clear", "map:solo:2 ", ""];
var out = { good: {}, bad: {} };
answers.forEach(function (a) { out.good[a] = RemasterMapUrl(a); });
bad.forEach(function (a) { out.bad[a] = RemasterMapUrl(a); });
out.cycle = RemasterMapUrl("map:solo:3?Weather=foggy?WeatherSeed=7?WeatherCycle=0");
console.log(JSON.stringify(out));
"""
r = subprocess.run(["node", "-e", probe, os.path.join(ROOT, "server", "weather.js")], capture_output=True, text=True)
got = json.loads(r.stdout) if r.returncode == 0 else None
check(got is not None, "RemasterMapUrl probe: %s" % r.stderr)
if got:
    check(len(got["good"]) >= 40, "RemasterMapUrl: only %d server answers probed" % len(got["good"]))
    for answer, url in got["good"].items():
        m = re.match(r"^map:(solo|duo):([0-3])(.*)$", answer)
        want = (make_weather.MAP_PATHS[int(m.group(2))] + "?bEnableBots=true?game="
                + make_weather.MODE_GAMES[m.group(1)] + m.group(3)) if m else None
        check(url == want, "RemasterMapUrl(%r) = %r, not %r" % (answer, url, want))
    check(not [a for a, u in got["bad"].items() if u is not None],
          "RemasterMapUrl opens: %s" % {a: u for a, u in got["bad"].items() if u is not None})
    check(got["cycle"] and got["cycle"].endswith("?Weather=foggy?WeatherSeed=7?WeatherCycle=0"),
          "RemasterMapUrl drops ?WeatherCycle=0: %r" % got["cycle"])
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
