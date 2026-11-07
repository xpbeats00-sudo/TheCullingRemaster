"""In-game check of the listen-server milestones (route B), no human input.

  python patch/netplay_run.py [--out DIR] [--host-wait 75] [--client-wait 90] [--no-client]

Milestone 1: a host opens a match with ?listen and its Victory.exe owns UDP
7777 (netstat). Milestone 2: a second client opens 127.0.0.1:7777; the
module's trace (CULLING_NETPLAY_TRACE) and both game logs show how far the
UE handshake gets (Hello, Login, Join, the connection's PlayerController).

How it runs, the way the launcher's PLAY does and the autotest runner does:
- Builds the host exe: a copy of the stock exe (C:/Culling/TheCulling, read
  only) with patch_netplay.py (the .netp module; not the Remaster's
  patch_exe.py fixes: the two are exclusive on one exe for now).
- Waits until no Victory.exe runs (one it didn't start is the user's or the
  autotest's: never touched).
- Backs up the test copy's Victory.exe (%LOCALAPPDATA%/TheCullingRemaster/Game:
  for Claude-launched processes, the MSIX-virtualized copy), installs the host
  exe, and starts Func.Launcher.exe -FuncSkipUpdateCheck
  -FuncClientDll=...Func.Client.Local.dll -FuncJoin=<url> with
  FUNC_CLIENT_DISABLE_PAK_MOUNT=1 and CULLING_NETPLAY_TRACE set.
- The client is a second Func.Launcher.exe from the same folder with
  -FuncJoin=127.0.0.1:7777 and its own trace file.
- Stops only the processes it started, restores the exe, and writes
  <out>/netplay_run.json: PASS/FAIL/NOT TESTED per step with the evidence.

Nothing here ships: the host exe exists only in the test copy for the run.
"""
import argparse
import datetime
import json
import os
import re
import shutil
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import patch_netplay as PN  # noqa: E402

LOCAL = os.environ["LOCALAPPDATA"]
GAME = os.path.join(LOCAL, "TheCullingRemaster", "Game")
WIN64 = os.path.join(GAME, "Victory", "Binaries", "Win64")
LOGS = os.path.join(LOCAL, "TheCulling", "Saved", "Logs")
SETTINGS = os.path.join(LOCAL, "TheCulling", "Saved", "Config", "WindowsClient", "GameUserSettings.ini")
# The game's Steam layer (the Goldberg emulator) reads the player's ID and
# name from these at start. All games on one PC share them, so the host's
# player records (looked up by ID) would merge every player into one;
# --distinct-ids gives each game its own test ID and name, written just
# before it starts and restored byte for byte after.
STEAM_SETTINGS = os.path.join(GAME, "Engine", "Binaries", "ThirdParty", "Steamworks", "Steamv136", "Win64", "steam_settings")
ID_FILES = ("force_steamid.txt", "force_account_name.txt")
TEST_IDS = {"host": ("76561197960266901", "NetHost"), "client": ("76561197960266902", "NetPlayerOne"),
            "client2": ("76561197960266903", "NetPlayerTwo")}


def shot(path):
    """The whole desktop as a PNG (System.Drawing)."""
    ps = ("Add-Type -AssemblyName System.Windows.Forms,System.Drawing;"
          "$b=[System.Windows.Forms.SystemInformation]::VirtualScreen;"
          "$i=New-Object System.Drawing.Bitmap $b.Width,$b.Height;"
          "$g=[System.Drawing.Graphics]::FromImage($i);$g.CopyFromScreen($b.Left,$b.Top,0,0,$i.Size);"
          "$i.Save('%s');" % path.replace("'", "''"))
    subprocess.run(["powershell", "-NoProfile", "-Command", ps], capture_output=True, timeout=60)


def read_ids():
    return {f: (open(os.path.join(STEAM_SETTINGS, f), "rb").read() if os.path.exists(os.path.join(STEAM_SETTINGS, f)) else None)
            for f in ID_FILES}


def write_ids(which):
    sid, name = TEST_IDS[which]
    for f, v in zip(ID_FILES, (sid, name)):
        open(os.path.join(STEAM_SETTINGS, f), "wb").write(v.encode())


def restore_ids(original):
    for f, v in original.items():
        path = os.path.join(STEAM_SETTINGS, f)
        if v is None:
            if os.path.exists(path):
                os.remove(path)
        else:
            open(path, "wb").write(v)


WINDOW = {"FullscreenMode": "2", "LastConfirmedFullscreenMode": "2", "PreferredFullscreenMode": "2",
          "ResolutionSizeX": "960", "ResolutionSizeY": "540", "LastUserConfirmedResolutionSizeX": "960",
          "LastUserConfirmedResolutionSizeY": "540", "MasterVolume": "0"}


def set_window(original, x):
    """GameUserSettings.ini: windowed 960x540 at (x, 40), from the original bytes (restored after)."""
    if original is None:
        return
    want = dict(WINDOW, WindowPosX=str(x), WindowPosY="40")
    lines = original.decode("utf-8", errors="replace").splitlines()
    seen = set()
    for i, ln in enumerate(lines):
        k = ln.split("=", 1)[0]
        if k in want and k not in seen:
            lines[i] = "%s=%s" % (k, want[k])
            seen.add(k)
    open(SETTINGS, "w", encoding="utf-8", newline="\r\n").write("\n".join(lines) + "\n")


STOCK_EXE = r"C:\Culling\TheCulling\Victory\Binaries\Win64\Victory.exe"
PORT = 7777
HOST_URL = ("Jungle_P?listen?bIsLanMatch?bEnableBots=true"
            "?game=/Game/Blueprints/GameMode/VictoryGameMode.VictoryGameMode_C")


def log(*a):
    print(datetime.datetime.now().strftime("%H:%M:%S"), *a, flush=True)


def victories():
    """{pid: parent pid} of every Victory.exe."""
    r = subprocess.run(["powershell", "-NoProfile", "-Command",
                        "Get-CimInstance Win32_Process -Filter \"Name='Victory.exe'\" | "
                        "ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
                       capture_output=True, text=True)
    out = {}
    for ln in r.stdout.split():
        pass
    for ln in r.stdout.splitlines():
        p = ln.split()
        if len(p) == 2:
            out[int(p[0])] = int(p[1])
    return out


def kill(pid):
    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)


def udp_owners(port):
    """PIDs that own a UDP socket on the port (netstat -ano -p UDP)."""
    r = subprocess.run(["netstat", "-ano", "-p", "UDP"], capture_output=True, text=True)
    pids, lines = set(), []
    for ln in r.stdout.splitlines():
        m = re.match(r"\s*UDP\s+(\S+):(\d+)\s+\S+\s+(\d+)", ln)
        if m and int(m.group(2)) == port:
            pids.add(int(m.group(3)))
            lines.append(ln.strip())
    return pids, lines


CLIENT_DLL = None    # None: the test copy's Func.Client.Local.dll; --backend-repo: a copy pointed at the local backend


def launch(join, trace, flog):
    env = dict(os.environ, FUNC_CLIENT_DISABLE_PAK_MOUNT="1", CULLING_NETPLAY_TRACE=trace)
    return subprocess.Popen([os.path.join(WIN64, "Func.Launcher.exe"), "-FuncSkipUpdateCheck",
                             "-FuncClientDll=" + (CLIENT_DLL or os.path.join(WIN64, "Func.Client.Local.dll")),
                             "-FuncClientLog=" + flog, "-FuncJoin=" + join], cwd=WIN64, env=env)


def wait_game(launcher, timeout):
    """The Victory.exe the launcher started (pid), or None."""
    t0 = time.time()
    while time.time() - t0 < timeout:
        mine = [pid for pid, parent in victories().items() if parent == launcher.pid]
        if mine:
            return mine[0]
        time.sleep(2)
    return None


def read(path):
    try:
        return open(path, encoding="utf-8", errors="replace").read()
    except OSError:
        return ""


# ---- --backend-repo: the whole shared-match chain, locally ------------------
#
# The backend (branch shared-match-backend, shared matches on, one pool server
# gs1@127.0.0.1:7777), the game-server agent (gameserver/agent.js) next to the
# host, and two test players (gameserver/test_players.js) who queue Solo
# together. The backend sends the match to gs1 (the agent writes
# assignment.json); the host starts with CULLING_NETPLAY_PREMATCH=<players>
# and CULLING_NETPLAY_CONTROL=<control>; once it listens the agent posts
# ready, the players get match-ready with their tickets, and the two game
# clients join 127.0.0.1:7777?servernonce=<ticket>. Every game uses a copy of
# the Func client DLL pointed at the local backend, never the live server.

GAMESERVER = os.path.join(os.path.dirname(HERE), "gameserver")


def start_chain(a):
    sys.path.insert(0, GAMESERVER)
    import local_backend as LB
    import patch_client_dll as PCD
    global CLIENT_DLL
    ctl = os.path.join(a.out, "control")
    shutil.rmtree(ctl, ignore_errors=True)
    os.makedirs(ctl)
    for f in ("tickets.json", "finished.json"):
        if os.path.exists(os.path.join(a.out, f)):
            os.remove(os.path.join(a.out, f))
    url = "http://127.0.0.1:%d/api" % a.backend_port
    CLIENT_DLL = os.path.join(a.out, "Func.Client.Test.dll")
    PCD.main(os.path.join(WIN64, "Func.Client.dll"), CLIENT_DLL, url)
    procs = []
    be = LB.start(a.backend_repo, os.path.join(a.out, "backend-data"), a.backend_port, PORT, os.path.join(a.out, "backend.log"))
    procs.append(be)
    agent = subprocess.Popen(["node", os.path.join(GAMESERVER, "agent.js"), "--backend", url[:-4], "--id", LB.SERVER_ID,
                              "--secret", LB.secret(), "--host", "127.0.0.1", "--port", str(PORT), "--control", ctl,
                              "--log", os.path.join(a.out, "agent.log")],
                             stdout=subprocess.DEVNULL, stderr=open(os.path.join(a.out, "agent.err"), "wb"))
    procs.append(agent)
    time.sleep(2)
    players = subprocess.Popen(["node", os.path.join(GAMESERVER, "test_players.js"), "--backend", url[:-4],
                                "--server-dir", os.path.join(a.backend_repo, "server"), "--out", a.out, "--count", str(a.clients)],
                               stdout=open(os.path.join(a.out, "players.log"), "wb"), stderr=subprocess.STDOUT)
    procs.append(players)
    t0 = time.time()
    while not os.path.exists(os.path.join(ctl, "assignment.json")):
        if time.time() - t0 > 90:
            raise RuntimeError("no assignment from the backend in 90 s (see agent.log, players.log)")
        time.sleep(0.5)
    assignment = json.load(open(os.path.join(ctl, "assignment.json")))
    log("assignment", assignment["matchId"], "players", assignment["players"], "bots", assignment["bots"])
    os.environ["CULLING_NETPLAY_PREMATCH"] = str(assignment["players"])
    os.environ["CULLING_NETPLAY_CONTROL"] = ctl
    return {"procs": procs, "players": players, "ctl": ctl, "assignment": assignment, "tickets": None, "bad": a.bad_ticket}


def join_url(chain, i):
    if not chain:
        return "127.0.0.1:%d" % PORT
    if chain["tickets"] is None:
        t0 = time.time()
        path = os.path.join(os.path.dirname(chain["ctl"]), "tickets.json")
        while not os.path.exists(path):
            if time.time() - t0 > 120:
                raise RuntimeError("no match-ready for the test players in 120 s")
            time.sleep(0.5)
        time.sleep(0.5)
        chain["tickets"] = json.load(open(path))
        log("tickets", [(t["name"], t["gameServer"], t["netplay"]) for t in chain["tickets"]])
    t = chain["tickets"][i]
    nonce = t["serverNonce"]
    if chain["bad"] and i == 1:
        nonce = nonce[:-4] + ("AAAA" if not nonce.endswith("AAAA") else "BBBB")
        log("tampered with the second client's ticket")
    return "%s?servernonce=%s" % (t["gameServer"], nonce)


def finish_chain(a, chain, result):
    # Give the result time to reach the players (posted at WaitingPostMatch).
    t0 = time.time()
    while chain["players"].poll() is None and time.time() - t0 < 20:
        time.sleep(1)
    for name in ("assignment.json", "result.txt", "result.posted"):
        src = os.path.join(chain["ctl"], name)
        if os.path.exists(src):
            shutil.copy2(src, os.path.join(a.out, name))
    finished = os.path.join(a.out, "finished.json")
    result["chain"] = {"assignment": chain["assignment"]["matchId"],
                       "verify": [l for l in read(os.path.join(a.out, "agent.log")).splitlines() if '"verify"' in l],
                       "finished": json.load(open(finished)) if os.path.exists(finished) else None}
    os.environ.pop("CULLING_NETPLAY_PREMATCH", None)
    os.environ.pop("CULLING_NETPLAY_CONTROL", None)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.environ.get("TEMP", "."), "culling-netplay-run"))
    ap.add_argument("--host-wait", type=int, default=120)
    ap.add_argument("--client-wait", type=int, default=90)
    ap.add_argument("--no-client", action="store_true")
    ap.add_argument("--after-join", type=int, default=45)
    ap.add_argument("--clients", type=int, default=1, choices=(1, 2))
    ap.add_argument("--shots", type=int, default=0, help="a desktop screenshot every N seconds after the joins")
    ap.add_argument("--backend-repo", help="a checkout of branch shared-match-backend: run the whole shared-match chain"
                    " locally (backend, game-server agent, two test players queueing; the clients join with their tickets)")
    ap.add_argument("--backend-port", type=int, default=8123)
    ap.add_argument("--bad-ticket", action="store_true", help="with --backend-repo: the second client's ticket is tampered with"
                    " (its signature changed), so the host must refuse it at login")
    ap.add_argument("--distinct-ids", action="store_true", help="give each game its own test Steam ID and name")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.backend_repo:
        a.distinct_ids = True             # one PC: the host's records are found by Steam ID
    result = {"steps": {}, "evidence": {}}

    if victories():
        log("a Victory.exe is running (not started here): waiting for it to close")
        while victories():
            time.sleep(10)

    host_exe = os.path.join(a.out, "Victory.netplay.exe")
    shutil.copyfile(STOCK_EXE, host_exe)
    PN.patch(host_exe)
    st = PN.check(host_exe)
    assert st["section"] and st["edits"], st
    log("built", host_exe)

    dst = os.path.join(WIN64, "Victory.exe")
    keep = os.path.join(a.out, "Victory.exe.backup")
    if not os.path.exists(keep):
        shutil.copy2(dst, keep)
    started = []
    started_procs = []
    chain = None
    settings_bytes = open(SETTINGS, "rb").read() if os.path.exists(SETTINGS) else None
    ids_bytes = read_ids() if a.distinct_ids else None
    log_mark = set(os.listdir(LOGS)) if os.path.isdir(LOGS) else set()
    try:
        shutil.copyfile(host_exe, dst)
        log("installed the host exe into the test copy (backup %s)" % keep)
        host_trace = os.path.join(a.out, "host.trace")
        client_trace = os.path.join(a.out, "client.trace")
        for f in (host_trace, client_trace):
            if os.path.exists(f):
                os.remove(f)

        if a.backend_repo:
            chain = start_chain(a)
            started_procs.extend(chain["procs"])
        set_window(settings_bytes, 0)
        if ids_bytes is not None:
            write_ids("host")
        host_l = launch(HOST_URL, host_trace, os.path.join(a.out, "host.func.log"))
        host = wait_game(host_l, 90)
        started += [p for p in (host,) if p]
        log("host Victory.exe pid", host)
        # Poll: the listen socket lives as long as the host's world (a match
        # that ends sends the game back to the menu and closes it), so the
        # client starts as soon as it is open.
        t0, pids, lines = time.time(), set(), []
        while host and time.time() - t0 < a.host_wait:
            pids, lines = udp_owners(PORT)
            if host in pids:
                result["evidence"]["listen_after_s"] = round(time.time() - t0)
                break
            time.sleep(3)
        result["evidence"]["netstat"] = lines
        result["evidence"]["host_trace"] = read(host_trace).splitlines()[:50]
        if not host:
            result["steps"]["M1 host started"] = "FAIL: no Victory.exe from the launcher"
        else:
            result["steps"]["M1 host started"] = "PASS: pid %d" % host
            result["steps"]["M1 host owns UDP %d" % PORT] = (
                "PASS: %s" % lines if host in pids else "FAIL: owners %s, lines %s" % (sorted(pids), lines))
        log(result["steps"])

        if host and host in pids and a.no_client:
            time.sleep(a.after_join)          # a lone host: watch its match for --after-join seconds
        if host and host in pids and not a.no_client:
            set_window(settings_bytes, 970)
            if ids_bytes is not None:
                write_ids("client")
            client_l = launch(join_url(chain, 0), client_trace, os.path.join(a.out, "client.func.log"))
            client = None
            t0 = time.time()
            while time.time() - t0 < 90 and not client:
                client = next((p for p, parent in victories().items() if parent == client_l.pid), None)
                time.sleep(2)
            started += [p for p in (client,) if p]
            log("client Victory.exe pid", client)
            t1 = time.time()
            client2 = None
            client2_trace = os.path.join(a.out, "client2.trace")
            if os.path.exists(client2_trace):
                os.remove(client2_trace)
            while time.time() - t1 < a.client_wait + (90 if a.clients > 1 else 0):
                time.sleep(3)
                joins = len(re.findall(r"control server=1 type=9 ", read(host_trace)))
                if a.clients > 1 and joins >= 1 and client2 is None:
                    # The second player: another client from the same folder, its own trace.
                    set_window(settings_bytes, 485)
                    if ids_bytes is not None:
                        write_ids("client2")
                    client2_l = launch(join_url(chain, 1), client2_trace, os.path.join(a.out, "client2.func.log"))
                    t2 = time.time()
                    while time.time() - t2 < 90 and not client2:
                        client2 = next((p for p, parent in victories().items() if parent == client2_l.pid), None)
                        time.sleep(2)
                    started += [p for p in (client2,) if p]
                    log("second client Victory.exe pid", client2)
                    if not client2:
                        client2 = 0
                if joins >= a.clients:
                    if a.shots:
                        # Desktop screenshots while the games run (the three windows sit side by side).
                        t_end = time.time() + a.after_join
                        k = 0
                        while time.time() < t_end:
                            time.sleep(min(a.shots, max(0, t_end - time.time())))
                            shot(os.path.join(a.out, "shot%02d.png" % k))
                            k += 1
                    else:
                        time.sleep(a.after_join)
                    break
            result["evidence"]["host_udp_at_end"] = udp_owners(PORT)[1]
            alive = victories()
            result["evidence"]["alive_at_end"] = {"host": host in alive, "client": client in alive}
            if a.clients > 1:
                result["evidence"]["alive_at_end"]["client2"] = bool(client2) and client2 in alive
                result["steps"]["M2 second client joined"] = (
                    "PASS" if len(re.findall(r"control server=1 type=9 ", read(host_trace))) >= 2 else "FAIL (one Join)")
            trace = read(host_trace)
            result["evidence"]["host_trace"] = trace.splitlines()[:200]
            result["evidence"]["client_trace"] = read(client_trace).splitlines()[:50]
            stages = {
                "M2 client started": bool(client),
                "M2 host accepted a connection": "accepting" in trace,
                "M2 Hello": re.search(r"control .*type=0\b", trace) is not None,
                "M2 Login": re.search(r"control .*type=5\b", trace) is not None,
                "M2 Join": re.search(r"control .*type=9\b", trace) is not None,
            }
            for k, ok in stages.items():
                result["steps"][k] = "PASS" if ok else "FAIL (not in the trace)"
        else:
            result["steps"]["M2 client"] = "NOT TESTED (the host didn't listen)" if not a.no_client else "NOT TESTED (--no-client)"
    finally:
        if chain:
            finish_chain(a, chain, result)
        for pr in started_procs:
            if pr.poll() is None:
                pr.kill()
        for p in started:
            kill(p)
        time.sleep(5)
        for p, parent in victories().items():
            if p in started:
                kill(p)
        shutil.copy2(keep, dst)
        if settings_bytes is not None:
            open(SETTINGS, "wb").write(settings_bytes)
        if ids_bytes is not None:
            restore_ids(ids_bytes)
        log("restored the test copy's Victory.exe, GameUserSettings.ini%s (byte for byte)"
            % (" and the Steam ID files" if ids_bytes is not None else ""))
        new_logs = sorted(set(os.listdir(LOGS)) - log_mark) if os.path.isdir(LOGS) else []
        for name in ["Victory.log", "Victory_2.log"] + new_logs:
            src = os.path.join(LOGS, name)
            if os.path.exists(src):
                shutil.copy2(src, os.path.join(a.out, name))
        json.dump(result, open(os.path.join(a.out, "netplay_run.json"), "w"), indent=1)
        log("wrote", os.path.join(a.out, "netplay_run.json"))
    print(json.dumps(result["steps"], indent=1))


if __name__ == "__main__":
    main()
