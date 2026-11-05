"""Loading times from the logs the game, the launcher and the server write.

  python measure_loading.py <log> [<log> ...] [--json]

Each file's kind is recognised from its lines:

- Game log (Unreal's own: Victory.log, when the game is started with -log
  or ABSLOG=<file>; the shipped build writes none by default). Lines look like
    [2026.11.05-01.02.03:456][  0]LogLoad: LoadMap: /Game/Maps/FrontEnd/FrontEnd
    [2026.11.05-01.02.06:789][  0]LogLoad: Took 3.33 seconds to LoadMap(/Game/Maps/FrontEnd/FrontEnd)
  and give
    startup -> menu        first log line to the end of the first menu map load
    menu -> match loaded   start of a match map load (or the Browse to its
                           server) to the end of that load
    match -> menu          start of the menu map load after a match to its end
  plus the engine's own "Took N seconds" for every map load.
- Launcher log (%APPDATA%/The Culling Remaster/logs/launcher.log, one JSON
  object per line): launcher start -> boot checks done, every PLAY and how
  long the game then ran (game-exit, to the launcher's 10 s check).
- Func client log (Func.Client.log next to launcher.log): one
  "=== Func.Client session <local time> ===" header per game start. Given
  together with launcher.log, PLAY -> game process start is reported.
- Server log (server.js output, "HH:MM:SS message", UTC): per player, the
  game's login (its menu reached the server) -> match queue -> match result.

Times are wall-clock from the logs; nothing here starts or changes the game.
"""
import argparse
import datetime as dt
import json
import re
import sys

UE_LINE = re.compile(r"^\[(\d{4})\.(\d\d)\.(\d\d)-(\d\d)\.(\d\d)\.(\d\d):(\d{3})\]\[\s*\d+\](\w+): (.*)$")
LOADMAP_START = re.compile(r"^LoadMap: (\S+)")
LOADMAP_TOOK = re.compile(r"^Took ([\d.]+) seconds to LoadMap\((.*)\)")
BROWSE = re.compile(r"^Browse: (\S+)")
FUNC_SESSION = re.compile(r"^=== Func\.Client session (\d{4}-\d\d-\d\d \d\d:\d\d:\d\d) ===")
SERVER_LINE = re.compile(r"^(\d\d):(\d\d):(\d\d) (login|matchqueue|match result|ranked result|showdown round) (\S+)")
MENU_MAP = "/Maps/FrontEnd/"


def is_menu(url):
    return MENU_MAP in url or url.rstrip("/").endswith("/FrontEnd")


def kind_of(lines):
    for line in lines[:400]:
        s = line.strip()
        if not s:
            continue
        if UE_LINE.match(s):
            return "game"
        if FUNC_SESSION.match(s):
            return "func"
        if s.startswith("{") and '"event"' in s:
            return "launcher"
        if SERVER_LINE.match(s):
            return "server"
    return None


def game_log(lines):
    """Map loads from Unreal's log -> measurements."""
    out, first, pending, browse, seen_match = [], None, None, None, False
    for line in lines:
        m = UE_LINE.match(line.strip())
        if not m:
            continue
        y, mo, d, h, mi, s, ms = (int(x) for x in m.groups()[:7])
        t = dt.datetime(y, mo, d, h, mi, s, ms * 1000)
        msg = m.group(9)
        if first is None:
            first = t
        b = BROWSE.match(msg)
        if b and not is_menu(b.group(1)):
            browse = t
        st = LOADMAP_START.match(msg)
        if st:
            pending = (t, st.group(1))
            continue
        took = LOADMAP_TOOK.match(msg)
        if not took:
            continue
        engine_s, target = float(took.group(1)), took.group(2)
        start = pending[0] if pending else t - dt.timedelta(seconds=engine_s)
        pending = None
        out.append({"what": "map load (engine)", "map": target, "seconds": engine_s, "at": t.isoformat()})
        if is_menu(target):
            if not seen_match and not any(o["what"] == "startup -> menu" for o in out):
                out.append({"what": "startup -> menu", "map": target, "seconds": (t - first).total_seconds(),
                            "at": t.isoformat()})
            elif seen_match:
                out.append({"what": "match -> menu", "map": target, "seconds": (t - start).total_seconds(),
                            "at": t.isoformat()})
                seen_match = False
        else:
            began = browse if browse and browse <= start else start
            out.append({"what": "menu -> match loaded", "map": target, "seconds": (t - began).total_seconds(),
                        "at": t.isoformat()})
            seen_match, browse = True, None
    return out


def parse_iso(s):
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00"))


def launcher_log(lines):
    out, start, plays = [], None, []
    for line in lines:
        try:
            e = json.loads(line)
        except ValueError:
            continue
        t, ev = parse_iso(e["t"]), e.get("event")
        if ev == "start":
            start = t
        elif ev == "boot" and start:
            out.append({"what": "launcher start -> boot checks done", "seconds": (t - start).total_seconds(),
                        "online": e.get("online"), "at": e["t"]})
            start = None
        elif ev == "play":
            plays.append(t)
            out.append({"what": "PLAY pressed", "seconds": 0.0, "at": e["t"]})
        elif ev == "game-exit":
            out.append({"what": "PLAY -> game closed (10 s checks)", "seconds": float(e.get("seconds", 0)), "at": e["t"]})
    return out, plays


def func_log(lines):
    """Local start time of every game session (the client DLL's header)."""
    starts = []
    for line in lines:
        m = FUNC_SESSION.match(line.strip())
        if m:
            starts.append(dt.datetime.strptime(m.group(1), "%Y-%m-%d %H:%M:%S"))
    return starts


def server_log(lines):
    """Per player: login -> match queue -> match result (times of day, UTC)."""
    out, last, day = [], {}, 0
    prev = None
    for line in lines:
        m = SERVER_LINE.match(line.strip())
        if not m:
            continue
        secs = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + int(m.group(3))
        if prev is not None and secs < prev - 3600:
            day += 1            # past midnight
        prev = secs
        t = day * 86400 + secs
        what, who = m.group(4), m.group(5)
        mine = last.setdefault(who, {})
        if what == "login":
            mine.clear()
            mine["login"] = t
        elif what == "matchqueue" and "login" in mine:
            out.append({"what": "game login -> match queue (time in menu)", "player": who, "seconds": t - mine["login"]})
            mine["queue"] = t
        elif what in ("match result", "ranked result", "showdown round") and "queue" in mine:
            out.append({"what": "match queue -> match result", "player": who, "seconds": t - mine.pop("queue")})
    return out


def pair_plays(plays, starts):
    """PLAY (UTC) -> the next game start (local time) within 3 minutes."""
    out = []
    for p in plays:
        local = p.astimezone().replace(tzinfo=None)
        nxt = [s for s in starts if dt.timedelta(0) <= s - local < dt.timedelta(minutes=3)]
        if nxt:
            out.append({"what": "PLAY -> game process start", "seconds": (nxt[0] - local).total_seconds(),
                        "at": p.isoformat()})
    return out


def measure(paths):
    results, plays, starts = [], [], []
    for path in paths:
        lines = open(path, encoding="utf-8", errors="replace").read().splitlines()
        kind = kind_of(lines)
        if kind == "game":
            results += [dict(r, source=path) for r in game_log(lines)]
        elif kind == "launcher":
            r, p = launcher_log(lines)
            results += [dict(x, source=path) for x in r]
            plays += p
        elif kind == "func":
            starts += func_log(lines)
            results += [{"what": "game process start", "seconds": 0.0, "at": s.isoformat(), "source": path}
                        for s in func_log(lines)]
        elif kind == "server":
            results += [dict(r, source=path) for r in server_log(lines)]
        else:
            print("%s: not a log this script knows" % path, file=sys.stderr)
    results += pair_plays(plays, starts)
    return results


def summary(results):
    groups = {}
    for r in results:
        if r["what"] in ("PLAY pressed", "game process start"):
            continue
        groups.setdefault(r["what"], []).append(r["seconds"])
    rows = []
    for what, v in groups.items():
        v = sorted(v)
        rows.append({"what": what, "count": len(v), "min": v[0], "median": v[len(v) // 2], "max": v[-1]})
    return rows


def main(argv=None):
    ap = argparse.ArgumentParser(description="loading times from game, launcher and server logs")
    ap.add_argument("logs", nargs="+")
    ap.add_argument("--json", action="store_true", help="every measurement as JSON")
    a = ap.parse_args(argv)
    results = measure(a.logs)
    if a.json:
        print(json.dumps({"measurements": results, "summary": summary(results)}, indent=1, default=str))
        return 0
    for r in results:
        extra = r.get("map") or r.get("player") or ""
        print("%-44s %9.2f s  %s %s" % (r["what"], r["seconds"], r.get("at", ""), extra))
    print()
    for s in summary(results):
        print("%-44s n=%-3d min %7.2f  median %7.2f  max %7.2f s" % (s["what"], s["count"], s["min"], s["median"], s["max"]))
    return 0


if __name__ == "__main__":
    sys.exit(main())
