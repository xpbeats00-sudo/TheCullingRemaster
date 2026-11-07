"""netplay_run.py's party options, without a game: the groups --party makes,
the team check it reports (PASS when parties are teammates as the backend
packs them), the host URL for a team assignment (the agent's), and the
argument checks.

usage: python test_netplay_run.py
"""
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import netplay_run as R  # noqa: E402


class Args:
    def __init__(self, party, clients=1):
        self.party, self.clients = party, clients


def main():
    users = ["steam:%d" % (76561197960266902 + i) for i in range(4)]
    assert R.party_groups(Args(None, 2)) == [[0], [1]]
    for spec, want in (("2", [[0, 1]]), ("3", [[0, 1, 2]]), ("2,1", [[0, 1], [2]]), ("2,2", [[0, 1], [2, 3]])):
        assert R.party_groups(Args(spec)) == want, spec
    print("ok    --party 2, 3, 2,1 and 2,2: the groups in client order")
    t = lambda *teams: dict(zip(users, teams))
    cases = [
        ("2", 2, t(1, 1), "PASS"), ("2", 2, t(1, 2), "FAIL"),                       # Duos: a party of 2
        ("3", 3, t(1, 1, 1), "PASS"), ("3", 3, t(1, 1, 2), "FAIL"),                 # Trios: a party of 3
        ("2,1", 3, t(1, 1, 1), "PASS"), ("2,1", 3, t(1, 1, 2), "FAIL"),             # Trios: 2 + solo fill one team
        ("2,2", 4, t(1, 1, 1, 1), "PASS"), ("2,2", 4, t(1, 1, 2, 2), "FAIL"),       # Quads: 2 + 2 fit one team
        ("2,2", 3, t(1, 1, 2, 2), "PASS"), ("2,2", 3, t(1, 1, 1, 1), "FAIL"),       # Trios: 2 + 2 don't
    ]
    for spec, size, team, want in cases:
        got = R.party_check(R.party_groups(Args(spec)), users, team, size)
        assert got.startswith(want), (spec, size, team, got)
    print("ok    the team check: parties on one team, together when they fit one, apart when they don't (%d cases)" % len(cases))
    assert R.team_size("ffa_jungle_coop3") == 3 and R.team_size("ffa_jungle") == 1
    url = R.host_url_for({"teamSize": 4, "mapIndex": 0, "serverNonce": "ab" * 16})
    assert url == ("Jungle_P?listen?bIsLanMatch?bEnableBots=true?game=" + R.PAIRS_MODE + "?TeamSize=4?servernonce=" + "ab" * 16), url
    assert os.environ.pop("CULLING_NETPLAY_TEAMSIZE") == "4"
    agent = open(os.path.join(os.path.dirname(HERE), "gameserver", "agent.js"), encoding="utf-8").read()
    assert R.PAIRS_MODE in agent, "netplay_run's pairs mode isn't the agent's"
    print("ok    a Quads assignment's host URL: the pairs mode with ?TeamSize=4 (the agent's), and its team size")
    for args, msg in ((["--party", "2", "--queue", "ffa_jungle_coop2"], "--party needs --backend-repo"),
                      (["--party", "3", "--queue", "ffa_jungle_coop2", "--backend-repo", "x"], "--party needs"),
                      (["--party", "2,2", "--queue", "ffa_jungle_coop4", "--backend-repo", "x"], "3 or 4 players need --menu"),
                      (["--clients", "3"], "3 or 4 clients need --menu")):
        r = subprocess.run([sys.executable, os.path.join(HERE, "netplay_run.py")] + args, capture_output=True, text=True)
        assert r.returncode == 2 and msg in r.stderr, (args, r.stderr[-300:])
    print("ok    refused: a party without the backend, a party bigger than the team, 3 or 4 players without --menu")
    print("OK")


if __name__ == "__main__":
    main()
