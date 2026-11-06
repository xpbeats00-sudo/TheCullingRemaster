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


def launch(join, trace, flog):
    env = dict(os.environ, FUNC_CLIENT_DISABLE_PAK_MOUNT="1", CULLING_NETPLAY_TRACE=trace)
    return subprocess.Popen([os.path.join(WIN64, "Func.Launcher.exe"), "-FuncSkipUpdateCheck",
                             "-FuncClientDll=" + os.path.join(WIN64, "Func.Client.Local.dll"),
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


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=os.path.join(os.environ.get("TEMP", "."), "culling-netplay-run"))
    ap.add_argument("--host-wait", type=int, default=120)
    ap.add_argument("--client-wait", type=int, default=90)
    ap.add_argument("--no-client", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
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
    log_mark = set(os.listdir(LOGS)) if os.path.isdir(LOGS) else set()
    try:
        shutil.copyfile(host_exe, dst)
        log("installed the host exe into the test copy (backup %s)" % keep)
        host_trace = os.path.join(a.out, "host.trace")
        client_trace = os.path.join(a.out, "client.trace")
        for f in (host_trace, client_trace):
            if os.path.exists(f):
                os.remove(f)

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

        if host and host in pids and not a.no_client:
            client_l = launch("127.0.0.1:%d" % PORT, client_trace, os.path.join(a.out, "client.func.log"))
            client = None
            t0 = time.time()
            while time.time() - t0 < 90 and not client:
                client = next((p for p, parent in victories().items() if parent == client_l.pid), None)
                time.sleep(2)
            started += [p for p in (client,) if p]
            log("client Victory.exe pid", client)
            t1 = time.time()
            while time.time() - t1 < a.client_wait:
                time.sleep(3)
                if "type=9" in read(host_trace):
                    time.sleep(10)
                    break
            result["evidence"]["host_udp_at_end"] = udp_owners(PORT)[1]
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
        for p in started:
            kill(p)
        time.sleep(5)
        for p, parent in victories().items():
            if p in started:
                kill(p)
        shutil.copy2(keep, dst)
        log("restored the test copy's Victory.exe")
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
