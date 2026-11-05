"""CUSTOM matches (custom_match.py): the menu, the server and the game agree.

- ClientWeb.js's REMASTER_CUSTOM_URLS / REMASTER_CUSTOM_MODS and
  server/custommatch.js's MODS / MAP_NAMES are copies of custom_match's.
- What the server sends ("custom:<map>:<mods>", custommatch.gameServer) is
  turned by the menu's RemasterCustomMatchURL (run in node) into exactly
  custom_match.url(); anything outside the table (another map, an index the
  game would read out of bounds, a value out of range, a repeat, extra URL
  options) gives no URL. The menu opens it with StartTraining(url).
- The Join explanation is the same text in the menu and the server, and no
  menu text added for custom matches mentions bots.
- test_custom_menu.js: CustomMatchSettings.js on stand-ins for the stock
  menu (the settings screen, START, Join, leaving the screen).
- node --check on the changed scripts, and an ES5 check (no arrow functions,
  let/const, template literals, Promise, .includes, Object.assign, classes,
  spread) of CustomMatchSettings.js and of every ClientWeb.js line that isn't
  stock (ClientWeb.original.js).
- make_branding.fix_custom_screen on a stand-in page: the lobby code (nobody
  can join) is gone, SETTINGS looks enabled, the tile says what CUSTOM is;
  running again changes nothing. With the generated FrontEnd.html present,
  it is checked too.
- With a Paks dir: VictoryGameMode's GameModeMods are custom_match's stock
  values, in EGameModeMod order.

usage: python test_custom_match.py [Paks dir]
"""
import json
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import custom_match as cm  # noqa: E402
import make_branding as mb  # noqa: E402

UI = os.path.join(HERE, "src", "Victory", "Content", "uiresources", "FrontEnd")
CLIENTWEB = os.path.join(UI, "js", "ClientWeb.js")
SETTINGS = os.path.join(UI, "js", "Screens", "CustomMatchSettings.js")
SERVER = os.path.join(ROOT, "server")

failures = []


def check(ok, msg):
    if not ok:
        failures.append(msg)


def node(code, *args):
    r = subprocess.run(["node", "-e", code] + list(args), capture_output=True, text=True, cwd=SERVER)
    if r.returncode:
        raise RuntimeError(r.stderr)
    return json.loads(r.stdout)


js = open(CLIENTWEB, encoding="utf-8").read()
settings_js = open(SETTINGS, encoding="utf-8").read()

# ---------------------------------------------------------------- the tables
m = re.search(r"var REMASTER_CUSTOM_URLS = (\[.*?\]);", js, re.S)
check(m and json.loads(m.group(1)) == [cm.URLS[0], cm.URLS[1]], "ClientWeb.js REMASTER_CUSTOM_URLS != custom_match.URLS")
m = re.search(r"var REMASTER_CUSTOM_MODS = (\[.*?\n\]);", js, re.S)
client_mods = json.loads(m.group(1)) if m else None
check(client_mods == [list(x) for x in cm.MODS], "ClientWeb.js REMASTER_CUSTOM_MODS != custom_match.MODS")
check(len(cm.MODS) == len(cm.ENUM) == 17, "17 settings, EGameModeMod 0..16")
for key, default, lo, hi in cm.MODS:
    check(lo <= default <= hi and hi < 1000, "%s: stock value within bounds, at most 3 digits" % key)

server = node("const c = require('./custommatch'); console.log(JSON.stringify({ mods: c.MODS, maps: c.MAP_NAMES, "
              "keys: c.MAP_KEYS, join: c.JOIN_REFUSED }))")
check(server["mods"] == [list(x) for x in cm.MODS], "server/custommatch.js MODS != custom_match.MODS")
check(server["maps"] == cm.MAP_NAMES, "server/custommatch.js MAP_NAMES != custom_match.MAP_NAMES")
check(server["keys"] == ["jungle", "prison"], "server map keys (tickets)")

# ---------------------------------------------------------------- server -> menu -> URL
cases = [
    (0, {}),
    (1, {}),
    (0, {"NumGreenCrateSpawn": 40, "RecyclerUseTime": 1}),
    (1, {"ChancesLockerPreOpened": 100, "HealthGivenFromHealthStation": 0, "FreqHealthGivenInSeconds": 60}),
    (1, dict((k, hi) for k, d, lo, hi in cm.MODS)),
    (0, dict((k, lo) for k, d, lo, hi in cm.MODS)),
]
map_name = {v: k for k, v in cm.MAP_NAMES.items()}
sent = node("const c = require('./custommatch'); const cases = JSON.parse(process.argv[1]);"
            "console.log(JSON.stringify(cases.map(([map, mods]) => c.gameServer(map, Object.assign(c.defaults(), mods)))))",
            json.dumps([[map_name[i], v] for i, v in cases]))
for (i, values), got in zip(cases, sent):
    check(got == cm.game_server(i, values), "server sends %r, custom_match says %r" % (got, cm.game_server(i, values)))

start = js.index("var REMASTER_CUSTOM_URLS")
end = js.index("\n}\n", js.index("function RemasterCustomMatchURL")) + 3
builder = js[start:end]
bad = ["custom:2:", "custom:0:17=1", "custom:0:99=1", "custom:0:0=201", "custom:0:15=0", "custom:0:0=1|0=2",
       "custom:0:0=-1", "custom:0:0=1?game=x", "custom:0:0=1|", "custom:0:=1", "custom:0", "offline:0", "",
       "custom:0:0=1000", "custom:1:" + "|".join(["0=1"] * 60)]
urls = node(builder + "\nconsole.log(JSON.stringify(JSON.parse(process.argv[1]).map(RemasterCustomMatchURL)));",
            json.dumps(sent + bad + ["custom:0:00=05"]))
for (i, values), s, url in zip(cases, sent, urls):
    want = cm.url(i, cm.encode(values))
    check(url == want, "menu opens %r for %r, custom_match says %r" % (url, s, want))
for s, url in zip(bad, urls[len(sent):]):
    check(url is None, "menu opens %r for %r" % (url, s))
check(urls[-1] == cm.URLS[0] + "?mods=0=5", "leading zeros are normalized (%r)" % urls[-1])
check(urls[0] == cm.URLS[0] and "?mods=" not in urls[0], "stock settings: Solo's URL, no ?mods=")

check('engine.call("StartTraining", customUrl)' in js, "a custom match isn't started with StartTraining(url)")
check(js.count("RemasterCustomMatchURL(msg.gameServer)") == 1, "match-ready builds the custom URL")
check(js.count("this.CanStartMatch = IAmTheOwner && this.Members.length >= 1;") == 1
      and js.count("LobbyData.CanStartMatch = LobbyData.Members.length >= 1;") == 1
      and "Members.length > 1" not in js, "START with one member")

# ---------------------------------------------------------------- text
join = re.search(r'var JOIN_REFUSED = "([^"]*)";', settings_js)
check(join and join.group(1) == server["join"], "the Join explanation differs between the menu and the server")
check(not re.search(r"bot", server["join"], re.I) and "party" in server["join"], "Join explanation: %r" % server["join"])
added = settings_js[settings_js.index("The CUSTOM lobby in the Remaster"):]
for s in re.findall(r'"([^"]*)"', added) + [mb.CUSTOM_TILE_TEXT]:
    check(not re.search(r"\bbots?\b", s, re.I), "menu text mentions bots: %r" % s)
check(not re.search(r"\bbots?\b", "The custom match could not start. Please try again.", re.I), "error text")

# ---------------------------------------------------------------- syntax
for path in (CLIENTWEB, SETTINGS, os.path.join(SERVER, "custommatch.js"), os.path.join(SERVER, "server.js")):
    r = subprocess.run(["node", "--check", path], capture_output=True, text=True)
    check(r.returncode == 0, "node --check %s: %s" % (os.path.basename(path), r.stderr.strip()))


r = subprocess.run(["node", os.path.join(HERE, "test_custom_menu.js")], capture_output=True, text=True)
check(r.returncode == 0, "test_custom_menu.js (the CUSTOM screens on stand-ins): %s" % (r.stderr.strip() or r.stdout.strip()))


def code_only(text):
    """Strings and comments blanked (a line-by-line approximation, enough for these files)."""
    text = re.sub(r"/\*.*?\*/", lambda m: "\n" * m.group().count("\n"), text, flags=re.S)
    out = []
    for line in text.split("\n"):
        line = re.sub(r'"(?:\\.|[^"\\])*"' + r"|'(?:\\.|[^'\\])*'", '""', line)
        out.append(re.sub(r"//.*", "", line))
    return out


ES6 = [(r"=>", "arrow function"), (r"\blet\s", "let"), (r"\bconst\s", "const"), (r"`", "template literal"),
       (r"\bPromise\b", "Promise"), (r"\.includes\(", ".includes"), (r"\bObject\.assign\b", "Object.assign"),
       (r"\bclass\s", "class"), (r"\.\.\.", "spread")]


def es5(name, lines):
    for n, line in lines:
        for pat, what in ES6:
            if re.search(pat, line):
                failures.append("%s line %d: %s (Coherent runs ES5): %s" % (name, n, what, line.strip()))


es5("CustomMatchSettings.js", enumerate(code_only(settings_js), 1))
stock = set(l.rstrip("\r") for l in code_only(open(os.path.join(HERE, "ClientWeb.original.js"), encoding="utf-8").read()))
es5("ClientWeb.js", [(n, l) for n, l in enumerate(code_only(js), 1) if l.rstrip("\r") not in stock])

# ---------------------------------------------------------------- the CUSTOM screen (make_branding)
PAGE = """          <li tabindex="0" data-push-screen="Custom" class="play-custom-bg" data-bind-if="{{g_PlateformSettings.bIsPC}}">
            <div class="tiled-menu-rollover">
              <p>Create or join a Custom Match.</p>
            </div>
          </li>
            <li tabindex="0" rv-if="LobbyData.Code" class="custom-game-code-container" data-list="options">
              <div class="custom-game-code" id="lobby-code" data-list="options">
                <span class="code-blackout" data-list="options">HIGHLIGHT TO VIEW LOBBY CODE</span>
                <span class="code-content" data-list="options">{ LobbyData.Code }</span>
              </div>
            </li>
            <li tabindex="0" id="match_settings_btn" onclick="CustomScreen.OnClicked(this)" data-list="options">
              <div id="match_settings" class="start-disabled" data-list="options">SETTINGS</div>
            </li>
            <li tabindex="0" id="start_match_btn" onclick="CustomScreen.OnClicked(this)" data-list="options">
              <div id="start_btn" class="start-disabled" data-list="options">START</div>
            </li>
"""


def custom_checks(html, where):
    check("custom-game-code-container" not in html, "%s: the lobby code is shown" % where)
    check('<div id="match_settings" class="start" data-list="options">SETTINGS</div>' in html, "%s: SETTINGS" % where)
    check('<div id="start_btn" class="start-disabled" data-list="options">START</div>' in html,
          "%s: START is left for ClientWeb.js to enable" % where)
    check("<p>%s</p>" % mb.CUSTOM_TILE_TEXT in html and "Create or join a Custom Match." not in html, "%s: tile" % where)


for nl in ("\n", "\r\n"):
    page = PAGE.replace("\n", nl)
    once = mb.fix_custom_screen(page)
    check(mb.fix_custom_screen(once) == once, "fix_custom_screen: running again changes the page (%r)" % nl)
    check(nl == "\r\n" or "\r" not in once, "fix_custom_screen: line endings kept (%r)" % nl)
    custom_checks(once, "stand-in page %r" % nl)

generated = os.path.join(UI, "FrontEnd.html")
if os.path.exists(generated):
    custom_checks(open(generated, encoding="utf-8").read(), "FrontEnd.html")

# ---------------------------------------------------------------- the game's own values
if len(sys.argv) > 1:
    from patch_assets import find_in_paks
    from uasset import Package, Reader
    rel = "Victory/Content/Blueprints/GameMode/VictoryGameMode.uasset"
    data = find_in_paks(sys.argv[1], {rel})[rel]
    pkg = Package(data)
    entries = []
    for p in pkg.props("Default__VictoryGameMode_C"):
        if p[0] != "GameModeMods":
            continue
        r = Reader(data, p[3])
        count = r.i32()
        pkg.fname(r); pkg.fname(r); r.i32(); r.i32(); pkg.fname(r); r.skip(16)   # the inner struct tag
        if r.u8():
            r.skip(16)
        for _ in range(count):
            entry = {}
            while True:
                name = pkg.fname(r)
                if name == "None":
                    break
                ptype = pkg.fname(r)
                size = r.i32(); r.i32()
                extra = pkg.fname(r) if ptype in ("ByteProperty", "EnumProperty") else None
                if r.u8():
                    r.skip(16)
                entry[name] = pkg.value(ptype, r.p, size, extra)
                r.p += size
            entries.append(entry)
    want = [{"type": "EGameModeMod::" + e, "value": d} for e, (k, d, lo, hi) in zip(cm.ENUM, cm.MODS)]
    check(entries[:17] == want, "VictoryGameMode GameModeMods differ: %s" % entries[:17])
    check(len(entries) == 18 and entries[17].get("type") == "EGameModeMod::eStartingActivityValue",
          "GameModeMods[17] is eStartingActivityValue (never sent)")

if failures:
    for f in failures:
        print("FAIL", f)
    sys.exit(1)
print("ok    custom matches: the menu, the server and the game agree%s"
      % ("" if len(sys.argv) > 1 else " (no Paks dir: the game's values not compared)"))
