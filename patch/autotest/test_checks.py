"""The autotest runner's checks (scenarios.py) on made-up runs: the probe's
split lines are joined, a good run passes and a bad one fails each check.

usage: python patch/autotest/test_checks.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import scenarios as SC  # noqa: E402

EXIT = {"quit": True, "killed": False, "code": 0, "seconds": 120.0}


def run(events, lines=(), crashes=(), exit_info=None):
    return SC.Run(list(events), list(lines), list(crashes), dict(exit_info or EXIT))


def verdicts(checks):
    return {name: okay for name, okay, _ev in checks}


# The probe's parts are joined in order, by tag and id.
lines = ["12:00:00   ui-trace AT|result|7|0/2|{\"victory\":true,\"rawRank\":1,",
         "12:00:00   ui-trace AT|msg|8|0/1|TMS|2|90|80|1|A|70|60|1|B",
         "12:00:00   ui-trace AT|result|7|1/2|\"body\":{\"placement\":1}}"]
assert SC.probe_messages(lines) == [("result", '{"victory":true,"rawRank":1,"body":{"placement":1}}'),
                                    ("msg", "TMS|2|90|80|1|A|70|60|1|B")]
print("ok    probe lines: parts joined in order by tag and id")

# Quads: 6 teams of 4, TMS for 2 extra mates, stacked panels, a win posted with placement 1.
roster = [["P%d" % i, i // 4 + 1, int(i == 0), 1, i] for i in range(16)]
teams = {"ev": "teams", "el": 6, "fighters": 16, "byteam": {str(t): [4, 4] for t in range(1, 5)}, "myteam": 1,
         "mates": 3, "board": 16, "sorted": 16, "roster": roster}
pods = {"ev": "pods_open", "el": 1, "contestants": 16, "starts": 16, "bots_to_spawn": 15, "closest": 820.0, "a": 0, "b": 3,
        "armed": [], "bots_armed": 0}
good = run([{"ev": "start", "scenario": "teamwin", "url": "x"}, teams, dict(pods, ev="pods", el=0, closest=900.0), pods,
            {"ev": "state", "el": 10, "board": 16, "sorted": 16},
            {"ev": "hud", "msg": "TMS|2|90|80|1|A|70|60|1|B"}, {"ev": "end", "el": 110}, {"ev": "quit", "why": "match over"}],
           ['1 ui-trace AT|msg|1|0/1|TMS|2|90|80|1|A|70|60|1|B',
            '1 ui-trace AT|page|2|0/1|{"extraShown":2}',
            '1 ui-trace AT|result|3|0/1|{"victory":true,"rawRank":1,"body":{"placement":1}}',
            '1 match result steam:1 {"victory":true,"kills":20} +3000 XP'])
v = verdicts(SC.check_teamwin(good, "Quads", 4, 4))
assert all(v.values()), v
bad = run([{"ev": "start", "scenario": "teamwin", "url": "x"},
           dict(teams, byteam={"1": [2, 2], "2": [2, 2]}, mates=1, board=24, sorted=0),
           dict(pods, contestants=24, closest=12.0, armed=["BP_Machete_C"], bots_armed=8),
           {"ev": "state", "el": 10, "board": 24, "sorted": 0}],
          [], ["UE4CC-1"], dict(EXIT, quit=False, killed=True))
v = verdicts(SC.check_teamwin(bad, "Quads", 4, 4))
assert v.pop("Quads: scenario ran in game") and not any(v.values()), v
print("ok    team win checks: a good Quads run passes all %d, a bad one fails all" % len(v))

# Team out: the raw Rank tells personal position from team place.
out = run([{"ev": "start", "scenario": "teamout", "url": "x"}, dict(teams, mates=3),
           {"ev": "before_my_death", "alive": 20, "byteam": {"1": [4, 4], "2": [4, 4], "3": [4, 4], "4": [4, 4], "5": [4, 4], "6": [4, 0]}},
           {"ev": "quit", "why": "team out"}],
          ['1 ui-trace AT|result|3|0/1|{"victory":false,"rawRank":20,"body":{"placement":20,"teamOutcome":"out"}}',
           '1 ranked result quad rkd-1 place 4/4 1000 -> 990 Scrapper out'])
v = verdicts(SC.check_teamout(out, "Ranked Quads", 4, 4, "quad"))
assert all(v.values()), v
print("ok    team out checks: Rank 20 with 20 alive is personal, scored min(4, ceil(20/4)) = team place 4 of 4")
print("all autotest check tests passed")
