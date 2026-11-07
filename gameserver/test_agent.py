"""The game-server agent, with the host game stood in for (no game needed).

Part 1, against the real backend (--backend-repo: a checkout of branch
shared-match-backend). Starts a local backend, the agent and two test
players who queue a shared Solo match. Then it plays the host's part
through the match's control folder: "listening", the players' logins (the
host checks tickets itself against tickets.txt and reports each use in
used-<n>) and a result. Checks:
  - the backend sends the match to gs1 (2 players, 14 bots); the agent
    gives it a folder of its own (<control>/<matchId>);
  - both players get match-ready for 127.0.0.1:7777 with netplay and a ticket;
  - the agent writes tickets.txt: each ticket's SHA-256, team and userID,
    never the ticket itself;
  - the agent confirms both uses with the backend (ticket-used), and a
    replayed one is refused there (used); used tickets leave tickets.txt;
  - the result (by userID) is paid: placement 1 is a victory, 16 isn't;
  - after the result the agent reports idle (no "cancel" answers).

Part 2, the agent's own handling of the host, against a scripted backend
(an HTTP server here that answers as the backend would, and records every
call) and a fake launcher and host (test_fake_host.c, built with the
Visual Studio tools): the host's port and match folder, a port mismatch,
and a host left running by an agent that died.

usage: python test_agent.py [--backend-repo <checkout of shared-match-backend>]
"""
import argparse
import hashlib
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(os.path.dirname(HERE), "patch"))
import local_backend as LB  # noqa: E402


def wait(path, timeout=30):
    t0 = time.time()
    while not os.path.exists(path):
        if time.time() - t0 > timeout:
            raise AssertionError("timed out waiting for " + path)
        time.sleep(0.05)
    time.sleep(0.05)


def events(path):
    try:
        return [json.loads(ln) for ln in open(path).read().splitlines() if ln.strip()]
    except (OSError, ValueError):
        return []


def wait_log(path, pred, timeout=30):
    """The first agent.log event (a dict) for which pred is true."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        for ev in events(path):
            if pred(ev):
                return ev
        time.sleep(0.05)
    raise AssertionError("timed out waiting for an agent event in %s; last: %s" % (path, events(path)[-5:]))


def until(pred, timeout=15, what="a condition"):
    t0 = time.time()
    while time.time() - t0 < timeout:
        v = pred()
        if v:
            return v
        time.sleep(0.05)
    raise AssertionError("timed out waiting for " + what)


# The players' userIDs: the game's Steam IDs, which the host binds tickets to.
USERIDS = ("steam:76561197960266902", "steam:76561197960266903")


def sha(text):
    return hashlib.sha256(text.encode()).hexdigest()


SECRET = "5ec7e7" * 10


def agent_env(secret):
    """The agent's environment: the secret goes there, never on its command line."""
    return dict(os.environ, CULLING_GAMESERVER_SECRET=secret)


# ---- part 1: the real backend --------------------------------------------------

def real_backend(repo, port):
    out = tempfile.mkdtemp(prefix="culling-agent-test-")
    ctl = os.path.join(out, "control")
    os.makedirs(ctl)
    url = "http://127.0.0.1:%d" % port
    procs = []
    try:
        procs.append(LB.start(repo, os.path.join(out, "backend-data"), port, log=os.path.join(out, "backend.log")))
        procs.append(subprocess.Popen(["node", os.path.join(HERE, "agent.js"), "--backend", url, "--id", LB.SERVER_ID,
                                       "--control", ctl, "--log", os.path.join(out, "agent.log")],
                                      env=agent_env(LB.secret()), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL))
        time.sleep(1.5)
        players = subprocess.Popen(["node", os.path.join(HERE, "test_players.js"), "--backend", url,
                                    "--server-dir", os.path.join(repo, "server"), "--out", out, "--count", "2",
                                    "--userids", ",".join(USERIDS)],
                                   stdout=open(os.path.join(out, "players.log"), "wb"), stderr=subprocess.STDOUT)
        procs.append(players)
        wait(os.path.join(ctl, "assignment.json"))
        asg = json.load(open(os.path.join(ctl, "assignment.json")))
        assert (asg["players"], asg["bots"], asg["field"]) == (2, 14, 16), asg
        mdir = asg["control"]
        assert os.path.dirname(mdir) == ctl and os.path.basename(mdir) == asg["matchId"] and os.path.isdir(mdir), mdir
        print("ok    the backend sent the match to gs1: 2 players, 14 bots; its own folder <control>/%s" % asg["matchId"])
        with open(os.path.join(mdir, "listening"), "w", newline="\n") as f:
            f.write("port=7777\n")
        wait(os.path.join(out, "tickets.json"))
        tickets = json.load(open(os.path.join(out, "tickets.json")))
        assert all(t["gameServer"] == "127.0.0.1:7777" and t["netplay"] and t["nonce"] for t in tickets), tickets
        assert [t["userID"] for t in tickets] == list(USERIDS), tickets
        print("ok    both players (claimed userIDs %s) got match-ready for 127.0.0.1:7777 with a ticket" % ", ".join(USERIDS))
        agent_log = os.path.join(out, "agent.log")
        wait(os.path.join(mdir, "tickets.txt"))
        lines = sorted(open(os.path.join(mdir, "tickets.txt")).read().splitlines())
        assert lines == sorted("%s %d %s" % (sha(t["nonce"]), t["team"], t["userID"]) for t in tickets), lines
        text = open(os.path.join(mdir, "tickets.txt")).read()
        assert all(t["nonce"] not in text for t in tickets)
        print("ok    tickets.txt: each ticket's SHA-256, team and userID (teams %s), never the ticket" % sorted(t["team"] for t in tickets))
        # The host let both players in (its own check) and reports the uses; a replay of the first is reported too.
        for n, t in ((1, tickets[0]), (2, tickets[1]), (3, tickets[0])):
            with open(os.path.join(mdir, "used-%d" % n), "w", newline="\n") as f:
                f.write("%s %s %s\n" % (sha(t["nonce"]), t["userID"], t["userID"][6:]))
            ev = wait_log(agent_log, lambda e, n=n: e.get("event") == "ticket-used" and e.get("n") == n)
            want = (200, True, None) if n < 3 else (403, False, "used")
            assert (ev["status"], ev["ok"], ev.get("error")) == want, ev
        print("ok    both uses confirmed with the backend (ticket-used); the replayed one refused there (used)")
        until(lambda: open(os.path.join(mdir, "tickets.txt")).read() == "", 5, "the used tickets to leave tickets.txt")
        print("ok    used tickets left tickets.txt")
        open(os.path.join(mdir, "result.txt"), "w").write(
            "field=16\nelapsed=180\nplayer n=1 user=%s placement=1 order=16 kills=3 damage=420 alive_s=175 winner=1 alive=1\n"
            "player n=2 user=%s placement=16 order=1 kills=0 damage=60 alive_s=40 winner=0 alive=0\n" % (tickets[0]["userID"], tickets[1]["userID"]))
        open(os.path.join(mdir, "result.done"), "w").write("1")
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
    finally:
        for p in procs:
            if p.poll() is None:
                p.kill()
        time.sleep(0.5)
        shutil.rmtree(out, ignore_errors=True)


# ---- part 2: a scripted backend and a fake host ------------------------------------

class Backend:
    """Answers the game-server API as the backend would, from a script, and
    records every call (signatures aren't checked: the real backend's are,
    in part 1 and in sharedmatch.test.js)."""

    def __init__(self):
        self.calls = []
        self.assignment = None        # what register and heartbeats hand out
        self.cancel = None            # a matchId heartbeats cancel
        self.results = []             # statuses for the next result posts (then 200)
        self.heartbeat_status = 200   # 503: the backend failing
        self.lock = threading.Lock()
        backend = self

        class H(http.server.BaseHTTPRequestHandler):
            def log_message(self, *a):
                pass

            def do_POST(self):
                body = self.rfile.read(int(self.headers.get("Content-Length") or 0)).decode()
                action = self.path.rsplit("/", 1)[-1]
                status, answer = backend.answer(action, json.loads(body or "{}"), dict(self.headers))
                data = json.dumps(answer).encode()
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data)))
                self.end_headers()
                self.wfile.write(data)

        self.http = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
        self.url = "http://127.0.0.1:%d" % self.http.server_address[1]
        threading.Thread(target=self.http.serve_forever, daemon=True).start()

    def answer(self, action, body, headers):
        with self.lock:
            self.calls.append((action, body, time.time()))
            a = self.assignment
            if action == "register":
                return 200, {"ok": True, "heartbeatMs": 200, "assignment": a}
            if action == "heartbeat":
                if self.heartbeat_status != 200:
                    return self.heartbeat_status, {"error": "down"}
                out = {"ok": True, "heartbeatMs": 200, "assignment": a}
                if self.cancel:
                    out["cancel"] = self.cancel
                return 200, out
            if action == "ready":
                if a and a["matchId"] == body.get("matchId"):
                    a["tickets"] = self.tickets
                    return 200, {"ok": True, "assignment": a}
                return 409, {"error": "not-your-match"}
            if action == "ticket-used":
                return 200, {"ok": True}
            if action == "abort":
                self.assignment = None
                return 200, {"ok": True}
            if action == "result":
                status = self.results.pop(0) if self.results else 200
                if status in (200, 409):
                    self.assignment = None
                return status, ({"ok": True} if status == 200 else {"error": "status-%d" % status})
            return 404, {"error": "unknown-action"}

    def of(self, action):
        with self.lock:
            return [c for c in self.calls if c[0] == action]

    def match(self, match_id, team_size=1):
        self.tickets = [{"id": "t%d" % i, "hash": sha("ticket-%s-%d" % (match_id, i)), "userID": u, "team": i + 1,
                         "expiresInMs": 120000, "used": False} for i, u in enumerate(USERIDS)]
        self.assignment = {"matchId": match_id, "playlist": "ffa", "map": "jungle", "mapIndex": 0, "teamSize": team_size,
                           "teamsCount": 16, "field": 16, "players": 2, "bots": 14, "serverNonce": "ab" * 16,
                           "teams": [{"team": i + 1, "players": [{"userID": u}], "bots": 0} for i, u in enumerate(USERIDS)],
                           "tickets": []}
        return self.assignment

    def stop(self):
        self.http.shutdown()


def build_fakes(where):
    """Func.Launcher.exe and Victory.exe stand-ins (test_fake_host.c)."""
    import build_netplay
    cl = build_netplay.find_cl()
    env = dict(os.environ, PATH=os.path.dirname(cl) + os.pathsep + os.environ.get("PATH", ""))
    vc = os.path.abspath(os.path.join(os.path.dirname(cl), "..", "..", ".."))
    kits = r"C:\Program Files (x86)\Windows Kits\10"
    inc, lib = [os.path.join(vc, "include")], [os.path.join(vc, "lib", "x64")]
    vers = sorted(os.listdir(os.path.join(kits, "Include"))) if os.path.isdir(os.path.join(kits, "Include")) else []
    for sub in ("ucrt", "um", "shared"):
        if vers:
            inc.append(os.path.join(kits, "Include", vers[-1], sub))
            lib.append(os.path.join(kits, "Lib", vers[-1], sub, "x64"))
    env["INCLUDE"] = os.pathsep.join(p for p in inc + [env.get("INCLUDE", "")] if p)
    env["LIB"] = os.pathsep.join(p for p in lib + [env.get("LIB", "")] if p)
    os.makedirs(where, exist_ok=True)
    src = os.path.join(HERE, "test_fake_host.c")
    for exe, extra in (("Func.Launcher.exe", ["/DLAUNCHER"]), ("Victory.exe", [])):
        r = subprocess.run([cl, "/nologo", "/O1", "/W3"] + extra + ["/Fe" + os.path.join(where, exe),
                            "/Fo" + os.path.join(where, exe + ".obj"), src], cwd=where, env=env, capture_output=True, text=True)
        assert r.returncode == 0, "fake host build failed:\n" + r.stdout + r.stderr
    return os.path.join(where, "Func.Launcher.exe")


def pids_named(name):
    out = subprocess.run(["tasklist", "/FI", "IMAGENAME eq " + name, "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
    return {int(ln.split('","')[1]) for ln in out.splitlines() if ln.startswith('"' + name + '"')}


def fake_hosts(out):
    """The fake hosts (Victory.exe under out) still running."""
    found = []
    for pid in pids_named("Victory.exe"):
        exe = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-Process -Id %d -ErrorAction SilentlyContinue).Path" % pid],
                             capture_output=True, text=True).stdout.strip()
        if exe.lower().startswith(out.lower()):
            found.append(pid)
    return found


def play_result(mdir):
    """The host's end of a match: result.txt, then result.done."""
    with open(os.path.join(mdir, "result.txt"), "w", newline="\n") as f:
        f.write("field=16\nelapsed=120\nplayer n=1 user=%s placement=1 order=16 kills=2 damage=150 alive_s=118 winner=1 alive=1\n"
                "player n=2 user=%s placement=9 order=8 kills=0 damage=20 alive_s=60 winner=0 alive=0\n" % USERIDS)
    open(os.path.join(mdir, "result.done"), "w").write("1")


def running(pid):
    out = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/FO", "CSV", "/NH"], capture_output=True, text=True).stdout
    return ('"%d"' % pid) in out


class Agent:
    def __init__(self, out, backend, launcher, port, name="agent", extra=()):
        self.log = os.path.join(out, name + ".log")
        self.ctl = os.path.join(out, "control")
        args = ["node", os.path.join(HERE, "agent.js"), "--backend", backend.url, "--id", "gs1",
                "--host", "127.0.0.1", "--port", str(port), "--control", self.ctl, "--log", self.log,
                "--launcher", launcher, "--client-dll", "Func.Client.Test.dll", "--linger-ms", "1500"] + list(extra)
        # The secret, a private variable and a test switch in the agent's environment.
        env = dict(agent_env(SECRET), CANARY_PRIVATE="agent-only", CULLING_NETPLAY_END="1")
        self.proc = subprocess.Popen(args, env=env, stdout=subprocess.DEVNULL, stderr=open(os.path.join(out, name + ".err"), "wb"))

    def event(self, name, timeout=20, pred=lambda e: True):
        return wait_log(self.log, lambda e: e.get("event") == name and pred(e), timeout)

    def kill(self):
        if self.proc.poll() is None:
            self.proc.kill()        # node only: what it started stays (as when the agent crashes)
            self.proc.wait()


def test_no_blocking_calls():
    # The agent never waits on a child process (PowerShell, tasklist) in its
    # poll loop: no synchronous child-process call at all.
    src = open(os.path.join(HERE, "agent.js"), encoding="utf-8").read()
    for name in ("execFileSync", "execSync", "spawnSync"):
        assert name not in src, "agent.js calls " + name
    print("ok    no synchronous child-process call in the agent")


def scripted():
    out = tempfile.mkdtemp(prefix="culling-agent-host-")
    backend = Backend()
    agents = []
    port = 47000 + os.getpid() % 1000
    try:
        launcher = build_fakes(os.path.join(out, "fake"))
        mid = "0123456789abcdef"
        backend.match(mid)
        ag = Agent(out, backend, launcher, port)
        agents.append(ag)
        started = ag.event("host-started")
        mdir = os.path.join(ag.ctl, mid)
        cmd = open(os.path.join(until(lambda: os.path.exists(os.path.join(mdir, "cmdline.txt")) and mdir, 15, "the host"),
                                "cmdline.txt"), encoding="utf-8").read()
        env = dict(ln.split("=", 1) for ln in open(os.path.join(mdir, "env.txt"), encoding="utf-8").read().splitlines() if "=" in ln[1:])
        assert "-FuncJoin=Jungle_P?listen?bIsLanMatch?bEnableBots=true" in cmd and "?servernonce=" + "ab" * 16 in cmd, cmd
        assert env.get("CULLING_NETPLAY_CONTROL") == mdir and env.get("CULLING_NETPLAY_PORT") == str(port), env
        asg = json.load(open(os.path.join(ag.ctl, "assignment.json")))
        assert asg["control"] == mdir and asg["matchId"] == mid
        saved = json.load(open(os.path.join(ag.ctl, "host.pid")))
        assert saved["pid"] == started["pid"] and saved["exe"] == "Victory.exe" and running(saved["pid"])
        print("ok    the host runs with the match's own folder <control>/%s and an explicit port (%d); host.pid has its pid and exe"
              % (mid, port))
        envtext = open(os.path.join(mdir, "env.txt"), encoding="utf-8").read()
        assert SECRET not in envtext and "CULLING_GAMESERVER_SECRET" not in envtext, "the secret reached the host"
        assert "CANARY_PRIVATE" not in env and env.get("CULLING_NETPLAY_END") == "1" and env.get("FUNC_CLIENT_DISABLE_PAK_MOUNT") == "1", env
        assert env.get("SystemRoot") or env.get("SYSTEMROOT"), "Windows' own variables are kept"
        assert SECRET not in cmd
        agcmd = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-CimInstance Win32_Process -Filter \"ProcessId=%d\").CommandLine"
                                % ag.proc.pid], capture_output=True, text=True).stdout
        assert "agent.js" in agcmd and SECRET not in agcmd, agcmd
        print("ok    the host's environment is clean (no secret, no other agent variable; system, FUNC_ and CULLING_NETPLAY_ kept);"
              " the secret isn't on the agent's command line")
        bad = subprocess.run(["node", os.path.join(HERE, "agent.js"), "--backend", backend.url, "--id", "gs1", "--secret", SECRET,
                              "--control", os.path.join(out, "x")], capture_output=True, text=True, env=dict(os.environ))
        assert bad.returncode == 2 and "CULLING_GAMESERVER_SECRET" in bad.stderr, (bad.returncode, bad.stderr)
        print("ok    --secret on the command line is refused")
        ag.event("ready", pred=lambda e: e.get("status") == 200)
        wait(os.path.join(mdir, "tickets.txt"))
        assert sorted(open(os.path.join(mdir, "tickets.txt")).read().splitlines()) == sorted(
            "%s %d %s" % (t["hash"], t["team"], t["userID"]) for t in backend.tickets)
        print("ok    listening on that port: ready posted, the tickets in the match's folder")

        # A host whose port was taken (the engine bound the next one): the match is aborted.
        open(os.path.join(os.path.dirname(launcher), "fake_host.cfg"), "w").write("shift=1\n")
        mid2 = "1111111111111111"
        backend.match(mid2)
        mis = ag.event("port-mismatch")
        assert (mis["want"], mis["bound"]) == (port, port + 1), mis
        until(lambda: any(c[1].get("matchId") == mid2 and c[1].get("reason") == "port-mismatch" for c in backend.of("abort")), 5, "the abort")
        until(lambda: not fake_hosts(out), 10, "the mismatched host to stop")
        assert not backend.of("ready") or all(c[1].get("matchId") != mid2 for c in backend.of("ready"))
        print("ok    a host that bound another port (%d): the match aborted (port-mismatch), the host stopped, no ready" % (port + 1))
        os.remove(os.path.join(os.path.dirname(launcher), "fake_host.cfg"))

        # The agent dies with its host running: the next agent kills that host (host.pid), once it's that exe.
        mid3 = "2222222222222222"
        backend.match(mid3)
        orphan = ag.event("host-started", pred=lambda e: e.get("matchId") == mid3)["pid"]
        assert running(orphan), (orphan, events(ag.log)[-6:])
        ag.kill()
        assert running(orphan), "the host outlives its agent"
        backend.assignment = None
        ag2 = Agent(out, backend, launcher, port, "agent2")
        agents.append(ag2)
        killed = ag2.event("orphan-killed")
        assert killed["pid"] == orphan and killed["exe"].lower() == "victory.exe", killed
        until(lambda: not running(orphan), 10, "the orphan to stop")
        assert not os.path.exists(os.path.join(ag2.ctl, "host.pid"))
        print("ok    a restarted agent killed the host its last run left (pid %d, Victory.exe)" % orphan)
        ag2.kill()
        # host.pid naming a process that isn't the host exe (its pid reused): left alone.
        other = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(60)"])
        try:
            json.dump({"pid": other.pid, "exe": "Victory.exe", "matchId": mid3}, open(os.path.join(ag2.ctl, "host.pid"), "w"))
            ag3 = Agent(out, backend, launcher, port, "agent3")
            agents.append(ag3)
            gone = ag3.event("orphan-gone")
            assert gone["pid"] == other.pid and gone["running"].lower() == "python.exe", gone
            assert other.poll() is None, "another program was killed"
            print("ok    host.pid naming another program (a reused pid): left running")
        finally:
            other.kill()
        ag3.kill()

        # The result: kept in result.pending and retried with backoff until the backend has it.
        ag4 = Agent(out, backend, launcher, port, "agent4")
        agents.append(ag4)
        mid4 = "4444444444444444"
        backend.match(mid4)
        backend.results = [503, 503]
        h4 = ag4.event("host-started", pred=lambda e: e.get("matchId") == mid4)["pid"]
        ag4.event("ready", pred=lambda e: e.get("status") == 200)
        play_result(os.path.join(ag4.ctl, mid4))
        first = ag4.event("result", pred=lambda e: e.get("matchId") == mid4)
        assert first["status"] == 503 and os.path.exists(os.path.join(ag4.ctl, mid4, "result.pending")), first
        done = ag4.event("result", pred=lambda e: e.get("matchId") == mid4 and e.get("status") == 200, timeout=30)
        posts = [c[2] for c in backend.of("result") if c[1].get("matchId") == mid4]
        assert len(posts) == 3 and done["attempt"] == 3, posts
        gaps = [b - a for a, b in zip(posts, posts[1:])]
        assert gaps[0] >= 0.9 and gaps[1] >= 1.8, gaps
        posted = json.load(open(os.path.join(ag4.ctl, mid4, "result.posted")))
        assert posted["status"] == 200 and posted["attempts"] == 3 and not os.path.exists(os.path.join(ag4.ctl, mid4, "result.pending"))
        stopped = ag4.event("host-stopped", pred=lambda e: e.get("matchId") == mid4)
        assert stopped["why"] == "post-match over" and not running(h4)
        assert stopped["t"] < done["t"], "the host is stopped after the linger, not after the post"
        print("ok    the result: 503, 503 (kept in result.pending, retried after %.1f s and %.1f s), then 200; the host stopped after"
              " the linger meanwhile" % tuple(gaps))
        # 409: the backend has it already (or the match is gone): done, no retry.
        mid5 = "5555555555555555"
        backend.match(mid5)
        backend.results = [409]
        until(lambda: any(c[1].get("matchId") == mid5 for c in backend.of("ready")), 15, "ready")
        play_result(os.path.join(ag4.ctl, mid5))
        r409 = ag4.event("result", pred=lambda e: e.get("matchId") == mid5)
        assert r409["status"] == 409
        time.sleep(1.5)
        assert len([c for c in backend.of("result") if c[1].get("matchId") == mid5]) == 1
        assert json.load(open(os.path.join(ag4.ctl, mid5, "result.posted")))["status"] == 409
        print("ok    409 is done: one post, no retry")
        # The agent stops with its result unposted: the next one posts it, and runs no host for that match.
        mid6 = "6666666666666666"
        backend.match(mid6)
        backend.results = [503] * 100
        ag4.event("host-started", pred=lambda e: e.get("matchId") == mid6)
        until(lambda: any(c[1].get("matchId") == mid6 for c in backend.of("ready")), 15, "ready")
        play_result(os.path.join(ag4.ctl, mid6))
        ag4.event("result", pred=lambda e: e.get("matchId") == mid6)
        ag4.kill()
        assert os.path.exists(os.path.join(ag4.ctl, mid6, "result.pending"))
        backend.results = []
        ag5 = Agent(out, backend, launcher, port, "agent5")
        agents.append(ag5)
        ok = ag5.event("result", pred=lambda e: e.get("matchId") == mid6 and e.get("status") == 200)
        assert not [e for e in events(ag5.log) if e.get("event") == "host-launch"], "a host started for a finished match"
        assert json.load(open(os.path.join(ag5.ctl, mid6, "result.posted")))["status"] == 200
        print("ok    a result left in result.pending by an agent that stopped: posted by the next one (attempt %d), no new host"
              % ok["attempt"])

        # The backend cancels a running match (a player crashed out, the backend gave up on it): the host is stopped.
        mid7 = "7777777777777777"
        backend.match(mid7)
        h7 = ag5.event("host-started", pred=lambda e: e.get("matchId") == mid7)["pid"]
        until(lambda: any(c[1].get("matchId") == mid7 for c in backend.of("ready")), 15, "ready")
        backend.assignment, backend.cancel = None, mid7
        ag5.event("cancel", pred=lambda e: e.get("matchId") == mid7)
        stopped = ag5.event("host-stopped", pred=lambda e: e.get("matchId") == mid7)
        until(lambda: not running(h7), 10, "the cancelled match's host to stop")
        assert stopped["why"] == "cancelled", stopped
        backend.cancel = None
        print("ok    a cancelled match: its host stopped")

        # An older host's result with two players at placement 1 (both alive at the time limit): one winner posted.
        mid8 = "8888888888888888"
        backend.match(mid8)
        until(lambda: any(c[1].get("matchId") == mid8 for c in backend.of("ready")), 15, "ready")
        mdir8 = os.path.join(ag5.ctl, mid8)
        with open(os.path.join(mdir8, "result.txt"), "w", newline="\n") as f:
            f.write("field=16\nelapsed=1500\nplayer n=1 user=%s placement=1 order=0 kills=1 damage=90 alive_s=1490 winner=0 alive=1\n"
                    "player n=2 user=%s placement=1 order=0 kills=2 damage=120 alive_s=1490 winner=1 alive=1\n" % USERIDS)
        open(os.path.join(mdir8, "result.done"), "w").write("1")
        ag5.event("result", pred=lambda e: e.get("matchId") == mid8 and e.get("status") == 200)
        body = [c[1] for c in backend.of("result") if c[1].get("matchId") == mid8][-1]
        place = {p["userID"]: p["placement"] for p in body["players"]}
        assert place == {USERIDS[0]: 2, USERIDS[1]: 1}, place
        print("ok    two at placement 1 from the host: the one with the winner flag posted 1st, the other 2nd")

        # A failing backend is asked less and less often (no 200 ms hammering), and again as usual once it answers.
        backend.heartbeat_status = 503
        t0 = time.time()
        time.sleep(6)
        beats = [c[2] for c in backend.of("heartbeat") if c[2] >= t0]
        gaps = [b - a for a, b in zip(beats, beats[1:])]
        assert len(beats) <= 8 and gaps and gaps[-1] >= 1.5 and gaps[-1] > gaps[0], gaps
        backend.heartbeat_status = 200
        t1 = time.time()
        until(lambda: len([c for c in backend.of("heartbeat") if c[2] >= t1]) >= 3, 15, "heartbeats as usual")
        print("ok    heartbeats back off while the backend fails (%d in 6 s, gaps %.1f s to %.1f s), then go on as usual"
              % (len(beats), gaps[0], gaps[-1]))
    finally:
        for a in agents:
            a.kill()
        for pid in pids_named("Victory.exe") | pids_named("Func.Launcher.exe"):
            exe = subprocess.run(["powershell", "-NoProfile", "-Command", "(Get-Process -Id %d).Path" % pid], capture_output=True, text=True).stdout
            if exe.strip().lower().startswith(out.lower()):
                subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)
        backend.stop()
        time.sleep(0.5)
        shutil.rmtree(out, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend-repo")
    ap.add_argument("--port", type=int, default=8123)
    a = ap.parse_args()
    if a.backend_repo:
        print("part 1: the real backend")
        real_backend(a.backend_repo, a.port)
    else:
        print("part 1: skipped (no --backend-repo)")
    print("part 2: a scripted backend, a fake launcher and host")
    test_no_blocking_calls()
    scripted()
    print("OK")


if __name__ == "__main__":
    main()
