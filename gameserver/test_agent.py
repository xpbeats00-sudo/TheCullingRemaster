"""The game-server agent against the real backend, with the host game stood in
for by files (no game needed).

Starts a local backend (a checkout of branch shared-match-backend), the agent
and two test players who queue a shared Solo match. Then it plays the host's
part through the control folder: "listening", the players' logins (the host
checks tickets itself against tickets.txt and reports each use in used-<n>)
and a result. Checks:
  - the backend sends the match to gs1 (2 players, 14 bots);
  - both players get match-ready for 127.0.0.1:7777 with netplay and a ticket;
  - the agent writes tickets.txt: each ticket's SHA-256, team and userID,
    never the ticket itself;
  - the agent confirms both uses with the backend (ticket-used), and a
    replayed one is refused there (used); used tickets leave tickets.txt;
  - the result (by userID) is paid: placement 1 is a victory, 16 isn't;
  - after the result the agent reports idle (no "cancel" answers).

usage: python test_agent.py --backend-repo <checkout of shared-match-backend>
"""
import argparse
import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import local_backend as LB  # noqa: E402


def wait(path, timeout=30):
    t0 = time.time()
    while not os.path.exists(path):
        if time.time() - t0 > timeout:
            raise AssertionError("timed out waiting for " + path)
        time.sleep(0.05)
    time.sleep(0.05)


def wait_log(path, pred, timeout=30):
    """The first agent.log event (a dict) for which pred is true."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        try:
            for ln in open(path).read().splitlines():
                ev = json.loads(ln)
                if pred(ev):
                    return ev
        except (OSError, ValueError):
            pass
        time.sleep(0.05)
    raise AssertionError("timed out waiting for an agent event in " + path)


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend-repo", required=True)
    ap.add_argument("--port", type=int, default=8123)
    a = ap.parse_args()
    out = tempfile.mkdtemp(prefix="culling-agent-test-")
    ctl = os.path.join(out, "control")
    os.makedirs(ctl)
    url = "http://127.0.0.1:%d" % a.port
    procs = []
    try:
        procs.append(LB.start(a.backend_repo, os.path.join(out, "backend-data"), a.port, log=os.path.join(out, "backend.log")))
        procs.append(subprocess.Popen(["node", os.path.join(HERE, "agent.js"), "--backend", url, "--id", LB.SERVER_ID,
                                       "--secret", LB.secret(), "--control", ctl, "--log", os.path.join(out, "agent.log")],
                                      stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        time.sleep(1.5)
        players = subprocess.Popen(["node", os.path.join(HERE, "test_players.js"), "--backend", url,
                                    "--server-dir", os.path.join(a.backend_repo, "server"), "--out", out, "--count", "2"],
                                   stdout=open(os.path.join(out, "players.log"), "wb"), stderr=subprocess.STDOUT)
        procs.append(players)
        wait(os.path.join(ctl, "assignment.json"))
        asg = json.load(open(os.path.join(ctl, "assignment.json")))
        assert (asg["players"], asg["bots"], asg["field"]) == (2, 14, 16), asg
        print("ok    the backend sent the match to gs1: 2 players, 14 bots")
        open(os.path.join(ctl, "listening"), "w").write("1")
        wait(os.path.join(out, "tickets.json"))
        tickets = json.load(open(os.path.join(out, "tickets.json")))
        assert all(t["gameServer"] == "127.0.0.1:7777" and t["netplay"] and t["nonce"] for t in tickets), tickets
        print("ok    both players got match-ready for 127.0.0.1:7777 with a ticket")
        agent_log = os.path.join(out, "agent.log")
        wait(os.path.join(ctl, "tickets.txt"))
        lines = sorted(open(os.path.join(ctl, "tickets.txt")).read().splitlines())
        assert lines == sorted("%s %d %s" % (sha(t["nonce"]), t["team"], t["userID"]) for t in tickets), lines
        text = open(os.path.join(ctl, "tickets.txt")).read()
        assert all(t["nonce"] not in text for t in tickets)
        print("ok    tickets.txt: each ticket's SHA-256, team and userID (teams %s), never the ticket" % sorted(t["team"] for t in tickets))
        # The host let both players in (its own check) and reports the uses; a replay of the first is reported too.
        for n, t in ((1, tickets[0]), (2, tickets[1]), (3, tickets[0])):
            with open(os.path.join(ctl, "used-%d" % n), "w", newline="\n") as f:
                f.write("%s %s\n" % (sha(t["nonce"]), t["userID"]))
            ev = wait_log(agent_log, lambda e, n=n: e.get("event") == "ticket-used" and e.get("n") == n)
            want = (200, True, None) if n < 3 else (403, False, "used")
            assert (ev["status"], ev["ok"], ev.get("error")) == want, ev
        print("ok    both uses confirmed with the backend (ticket-used); the replayed one refused there (used)")
        t0 = time.time()
        while open(os.path.join(ctl, "tickets.txt")).read() and time.time() - t0 < 5:
            time.sleep(0.05)
        assert open(os.path.join(ctl, "tickets.txt")).read() == "", "used tickets stay in tickets.txt"
        print("ok    used tickets left tickets.txt")
        open(os.path.join(ctl, "result.txt"), "w").write(
            "field=16\nelapsed=180\nplayer n=1 user=%s placement=1 order=16 kills=3 damage=420 alive_s=175 winner=1 alive=1\n"
            "player n=2 user=%s placement=16 order=1 kills=0 damage=60 alive_s=40 winner=0 alive=0\n" % (tickets[0]["userID"], tickets[1]["userID"]))
        open(os.path.join(ctl, "result.done"), "w").write("1")
        assert players.wait(timeout=30) == 0, "the players weren't told the result"
        fin = {f["name"]: [e for e in f["events"] if e["state"] == "finished"][0]["result"]
               for f in json.load(open(os.path.join(out, "finished.json")))}
        r1, r2 = fin["Shared Tester 1"], fin["Shared Tester 2"]
        assert (r1["placement"], r1["victory"], r1["kills"]) == (1, True, 3), r1
        assert (r2["placement"], r2["victory"]) == (16, False), r2
        print("ok    the result was paid: placement 1 won (%d XP), placement 16 didn't (%d XP)" % (r1["xpEarned"], r2["xpEarned"]))
        time.sleep(5)
        log = open(os.path.join(out, "agent.log")).read()
        assert '"cancel"' not in log, "the agent kept reporting a finished match"
        print("ok    after the result the agent reports idle")
        print("OK")
    finally:
        for p in procs:
            if p.poll() is None:
                p.kill()
        time.sleep(0.5)
        shutil.rmtree(out, ignore_errors=True)


if __name__ == "__main__":
    main()
