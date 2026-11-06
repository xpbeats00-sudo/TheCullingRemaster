"""measure_loading.py against sample logs of every kind it reads.

usage: python test_measure_loading.py
"""
import datetime as dt
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import measure_loading as ml  # noqa: E402

GAME = """Log file open, 11/05/26 01:00:00
[2026.11.05-01.00.00:000][  0]LogInit: Build: ++depot+UE4-Releases+4.11
[2026.11.05-01.00.09:000][  0]LogLoad: LoadMap: /Game/Maps/FrontEnd/FrontEnd
[2026.11.05-01.00.12:500][  0]LogLoad: Took 3.50 seconds to LoadMap(/Game/Maps/FrontEnd/FrontEnd)
[2026.11.05-01.02.00:000][500]LogNet: Browse: 203.0.113.5:7777/Game/Maps/Jungle/Jungle_P
[2026.11.05-01.02.04:000][501]LogLoad: LoadMap: 203.0.113.5:7777/Game/Maps/Jungle/Jungle_P
[2026.11.05-01.02.30:000][502]LogLoad: Took 26.00 seconds to LoadMap(/Game/Maps/Jungle/Jungle_P)
[2026.11.05-01.20.00:000][900]LogLoad: LoadMap: /Game/Maps/FrontEnd/FrontEnd?closed
[2026.11.05-01.20.05:250][901]LogLoad: Took 5.25 seconds to LoadMap(/Game/Maps/FrontEnd/FrontEnd)
"""

LAUNCHER = """{"t":"2026-11-04T13:33:38.296Z","event":"start","version":"1.3.1","gamePath":"X"}
{"t":"2026-11-04T13:33:39.311Z","event":"boot","online":true,"release":"1.1.0","installed":"1.1.0","todo":0}
{"t":"2026-11-04T13:40:00.000Z","event":"play","release":"1.1.0"}
{"t":"2026-11-04T14:00:00.000Z","event":"game-exit","seconds":1200}
not json
"""

SERVER = """23:59:50 login 76561190000000001 authType=steam appid=437220 build=1
00:01:10 matchqueue 76561190000000001 solo
00:15:40 match result 76561190000000001 {"placement":3}
"""


def write(text):
    f = tempfile.NamedTemporaryFile("w", suffix=".log", delete=False, encoding="utf-8")
    f.write(text)
    f.close()
    return f.name


def by(results, what):
    return [r for r in results if r["what"] == what]


def test_game_log():
    r = ml.measure([write(GAME)])
    assert by(r, "startup -> menu")[0]["seconds"] == 12.5
    match = by(r, "menu -> match loaded")[0]
    assert match["seconds"] == 30.0, match          # from the Browse, not the LoadMap line
    assert by(r, "match -> menu")[0]["seconds"] == 5.25
    assert [x["seconds"] for x in by(r, "map load (engine)")] == [3.5, 26.0, 5.25]


def test_launcher_and_func_logs():
    play_local = dt.datetime(2026, 11, 4, 13, 40, tzinfo=dt.timezone.utc).astimezone().replace(tzinfo=None)
    func = "=== Func.Client session %s ===\nFunc.Client loaded\n" % (
        (play_local + dt.timedelta(seconds=4)).strftime("%Y-%m-%d %H:%M:%S"))
    r = ml.measure([write(LAUNCHER), write(func)])
    assert abs(by(r, "launcher start -> boot checks done")[0]["seconds"] - 1.015) < 1e-6
    assert by(r, "PLAY -> game process start")[0]["seconds"] == 4.0
    assert by(r, "PLAY -> game closed (10 s checks)")[0]["seconds"] == 1200.0


def test_server_log_over_midnight():
    r = ml.measure([write(SERVER)])
    assert by(r, "game login -> match queue (time in menu)")[0]["seconds"] == 80
    assert by(r, "match queue -> match result")[0]["seconds"] == 870


def test_unknown_file_is_skipped():
    assert ml.measure([write("hello\nworld\n")]) == []


if __name__ == "__main__":
    n = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            fn()
            print("ok   ", name)
            n += 1
    print("all %d measure_loading tests passed" % n)
