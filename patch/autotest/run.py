"""Automated in-game tests of The Culling Remaster: no human input.

  python patch/autotest/run.py [--only quads_win,sd_1v1] [--no-build] [--keep-install] [--port 8765]

1. Builds what it tests from this worktree: Victory.exe (the stock exe from
   C:/Culling/TheCulling, read only, patched by patch_exe.py with the current
   showdown_rounds_blob.py) and the patch pak (patch/src, pointed at the test
   server's port, with the HUD probe AutoTestHud.js added for this pak only;
   patch/src is put back as it was).
2. Installs both into the test copy of the game, the one a process started
   from here sees (%LOCALAPPDATA%\\TheCullingRemaster\\Game: for Claude-launched
   processes the MSIX-virtualized copy), after backing up what was there, and
   sets the game's window to 960x540 windowed (GameUserSettings.ini, backed up
   too). Everything is put back at the end unless --keep-install.
3. Starts a local server from this worktree's server/ on --port (its own
   scratch data folder, CULLING_REQUIRE_ACCOUNT=0, CULLING_NIGHT_MAPS=1,
   short lobby waits), logging to a file.
4. For each scenario (scenarios.py): waits until no Victory.exe runs (one this
   didn't start is the user playing: never touched), queues the scenario's
   playlist through the stand-in menu (menu.js: a logged-in player, so the
   server issues the match's ticket as for the real menu), then starts the
   game exactly as the launcher's PLAY does (FUNC_CLIENT_DISABLE_PAK_MOUNT=1,
   Func.Launcher.exe -FuncSkipUpdateCheck -FuncClientDll=...Func.Client.Local.dll)
   with -FuncJoin=<the match URL the menu would open>?RemasterAutoTest=<scenario>,
   so the game starts straight into that match. The native module plays the
   scenario and quits through the console. The runner waits (timeout: only the
   processes it started are stopped), then checks the results file, the HUD
   probe's lines and the server log.
5. Writes docs/AUTOTEST_RESULTS.md: PASS/FAIL per check with its evidence, and
   keeps every run's raw files in --out.
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
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
PATCH = os.path.dirname(HERE)
ROOT = os.path.dirname(PATCH)
sys.path.insert(0, PATCH)
sys.path.insert(0, HERE)
import scenarios as SC  # noqa: E402

LOCAL = os.environ["LOCALAPPDATA"]
GAME = os.path.join(LOCAL, "TheCullingRemaster", "Game")
WIN64 = os.path.join(GAME, "Victory", "Binaries", "Win64")
PAKS = os.path.join(GAME, "Victory", "Content", "Paks")
PAK = "LocalServer-WindowsClient_P.pak"
RESULTS = os.path.join(LOCAL, "TheCullingRemaster", "autotest", "results.jsonl")
SETTINGS = os.path.join(LOCAL, "TheCulling", "Saved", "Config", "WindowsClient", "GameUserSettings.ini")
CRASHES = os.path.join(LOCAL, "TheCulling", "Saved", "Logs")
STOCK_EXE = r"C:\Culling\TheCulling\Victory\Binaries\Win64\Victory.exe"
SRC = os.path.join(PATCH, "src")
HUD = os.path.join(SRC, "Victory", "Content", "uiresources", "hud")
CLIENT_WEB = os.path.join(SRC, "Victory", "Content", "uiresources", "FrontEnd", "js", "ClientWeb.js")
DOC = os.path.join(ROOT, "docs", "AUTOTEST_RESULTS.md")
PROBE_TAG = '<script src="js/AutoTestHud.js"></script>'
WINDOW = {"FullscreenMode": "2", "LastConfirmedFullscreenMode": "2", "PreferredFullscreenMode": "2",
          "ResolutionSizeX": "960", "ResolutionSizeY": "540", "LastUserConfirmedResolutionSizeX": "960",
          "LastUserConfirmedResolutionSizeY": "540", "WindowPosX": "0", "WindowPosY": "0", "MasterVolume": "0"}


def log(*a):
    print(datetime.datetime.now().strftime("%H:%M:%S"), *a, flush=True)


# ---------------------------------------------------------------- processes

def victories():
    """{pid: parent pid} of every running Victory.exe."""
    r = subprocess.run(["powershell", "-NoProfile", "-Command",
                        "Get-CimInstance Win32_Process -Filter \"Name='Victory.exe'\" | "
                        "ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId)\" }"],
                       capture_output=True, text=True)
    out = {}
    for ln in r.stdout.splitlines():
        f = ln.split()
        if len(f) == 2 and f[0].isdigit():
            out[int(f[0])] = int(f[1])
    return out


def alive(pid):
    r = subprocess.run(["tasklist", "/FI", "PID eq %d" % pid, "/NH", "/FO", "CSV"], capture_output=True, text=True)
    return ('"%d"' % pid) in r.stdout


def kill(pid):
    subprocess.run(["taskkill", "/PID", str(pid), "/T", "/F"], capture_output=True)


def wait_for_free_game(max_wait):
    """Until no Victory.exe runs: one this runner didn't start is someone playing."""
    t0 = time.time()
    while True:
        running = victories()
        if not running:
            return True
        if time.time() - t0 > max_wait:
            return False
        log("a Victory.exe this runner didn't start is running (%s): waiting" % sorted(running))
        time.sleep(60)


# ---------------------------------------------------------------- build and install

def build(out, port):
    import make_pak
    import make_server_config
    import patch_exe
    exe = os.path.join(out, "Victory.exe")
    shutil.copyfile(STOCK_EXE, exe)
    patch_exe.patch(exe)
    fixes = patch_exe.check(exe)
    log("built Victory.exe:", ", ".join(k for k, v in fixes.items() if v is True), "sha256", patch_exe.sha256(exe)[:16])
    html_path = os.path.join(HUD, "hud.html")
    html = open(html_path, "rb").read()
    probe = os.path.join(HUD, "js", "AutoTestHud.js")
    pak = os.path.join(out, PAK)
    try:
        make_server_config.main("http://127.0.0.1:%d" % port)
        shutil.copyfile(os.path.join(HERE, "AutoTestHud.js"), probe)
        text = open(html_path, "rb").read().decode("utf-8")
        anchor = '<script src="js/ShowdownHud.js"></script>'
        assert anchor in text, "hud.html has no ShowdownHud.js"
        open(html_path, "wb").write(text.replace(anchor, anchor + "\n  " + PROBE_TAG).encode("utf-8"))
        make_pak.main(SRC, pak)
    finally:
        if os.path.exists(probe):
            os.remove(probe)
        open(html_path, "wb").write(html)
        make_server_config.main("http://127.0.0.1:8000")
    log("built", PAK, os.path.getsize(pak) // (1 << 20), "MB (server port %d, HUD probe)" % port)
    return exe, pak


def install(out, exe, pak):
    backup = os.path.join(out, "backup")
    os.makedirs(backup, exist_ok=True)
    pairs = [(os.path.join(WIN64, "Victory.exe"), exe), (os.path.join(PAKS, PAK), pak)]
    for dst, _src in pairs + [(SETTINGS, None)]:
        keep = os.path.join(backup, os.path.basename(dst))
        if os.path.exists(dst) and not os.path.exists(keep):
            shutil.copy2(dst, keep)
    for dst, src in pairs:
        shutil.copyfile(src, dst)
    if os.path.exists(SETTINGS):
        lines = open(SETTINGS, encoding="utf-8").read().splitlines()
        seen = set()
        for i, ln in enumerate(lines):
            k = ln.split("=", 1)[0]
            if k in WINDOW and k not in seen:
                lines[i] = "%s=%s" % (k, WINDOW[k])
                seen.add(k)
        open(SETTINGS, "w", encoding="utf-8", newline="\r\n").write("\n".join(lines) + "\n")
    log("installed into", GAME, "(backups in %s)" % backup)


def restore(out):
    backup = os.path.join(out, "backup")
    for dst in (os.path.join(WIN64, "Victory.exe"), os.path.join(PAKS, PAK), SETTINGS):
        keep = os.path.join(backup, os.path.basename(dst))
        if os.path.exists(keep):
            shutil.copy2(keep, dst)
            os.remove(keep)
    log("restored the test copy's Victory.exe, patch pak and window settings")


# ---------------------------------------------------------------- server

def start_server(out, port):
    data = os.path.join(out, "server-data")
    shutil.rmtree(data, ignore_errors=True)
    os.makedirs(data)
    shutil.copyfile(os.path.join(ROOT, "server", "data", "catalog.json"), os.path.join(data, "catalog.json"))
    env = dict(os.environ, CULLING_PORT=str(port), CULLING_DATA_DIR=data, CULLING_REQUIRE_ACCOUNT="0",
               CULLING_NIGHT_MAPS="1", CULLING_LOBBY_GATHER_MS="500", CULLING_LOBBY_COUNTDOWN_MS="500",
               CULLING_SAVE_DELAY_MS="0")
    logf = open(os.path.join(out, "server.log"), "w", encoding="utf-8")
    proc = subprocess.Popen(["node", os.path.join(ROOT, "server", "server.js")], cwd=os.path.join(ROOT, "server"),
                            env=env, stdout=logf, stderr=subprocess.STDOUT)
    for _ in range(100):
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=2).read()
            log("server up on", port)
            return proc
        except OSError:
            time.sleep(0.2)
    proc.kill()
    raise SystemExit("the test server didn't start (see %s)" % os.path.join(out, "server.log"))


def server_lines(out, start):
    with open(os.path.join(out, "server.log"), encoding="utf-8", errors="replace") as f:
        f.seek(start)
        return f.read().splitlines()


# ---------------------------------------------------------------- one scenario

def crash_reports():
    try:
        return {d for d in os.listdir(CRASHES) if d.startswith("UE4CC")}
    except OSError:
        return set()


def read_results():
    out = []
    try:
        with open(RESULTS, encoding="utf-8", errors="replace") as f:
            for ln in f:
                try:
                    out.append(json.loads(ln))
                except ValueError:
                    pass
    except OSError:
        pass
    return out


def run_one(out, port, name, queue, scenario, timeout, user):
    if not wait_for_free_game(4 * 3600):
        raise SystemExit("the game stayed in use for 4 hours")
    if os.path.exists(RESULTS):
        os.remove(RESULTS)
    logpos = os.path.getsize(os.path.join(out, "server.log"))
    before = crash_reports()
    menu = subprocess.Popen(["node", os.path.join(HERE, "menu.js"), str(port), user, queue, CLIENT_WEB],
                            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
    first = json.loads(menu.stdout.readline() or "{}")
    if not first.get("url"):
        menu.kill()
        raise SystemExit("%s: the menu got no match URL: %s" % (name, first))
    url = first["url"] + "?RemasterAutoTest=" + scenario
    if scenario == "night":
        # The server draws the night map's weather; the long run wants rain (the rain templates the
        # garbage collector frees are what weather.c's crash fix is about): storm, the same seed.
        url = re.sub(r"\?Weather=[A-Za-z]+", "?Weather=storm", url)
    log("%s: %s -> %s" % (name, first["ready"].get("gameServer"), url))
    env = dict(os.environ, FUNC_CLIENT_DISABLE_PAK_MOUNT="1")
    t0 = time.time()
    launcher = subprocess.Popen([os.path.join(WIN64, "Func.Launcher.exe"), "-FuncSkipUpdateCheck",
                                 "-FuncClientDll=" + os.path.join(WIN64, "Func.Client.Local.dll"),
                                 "-FuncClientLog=" + os.path.join(out, name + ".func.log"), "-FuncJoin=" + url],
                                cwd=WIN64, env=env)
    mine = set()
    quit_at = None
    killed = False
    code = None
    while True:
        time.sleep(2)
        mine |= {pid for pid, parent in victories().items() if parent == launcher.pid}
        events = read_results()
        if quit_at is None and any(e.get("ev") == "quit" for e in events):
            quit_at = time.time()
        game_up = any(alive(p) for p in mine)
        if mine and not game_up:
            break
        if not mine and time.time() - t0 > 90:
            log("%s: no Victory.exe from the launcher after 90 s" % name)
            break
        if quit_at and time.time() - quit_at > 45:
            log("%s: the game didn't exit 45 s after its quit: stopping it" % name)
            killed = True
            break
        if time.time() - t0 > timeout:
            log("%s: timeout (%d s)" % (name, timeout))
            killed = True
            break
    if killed:
        for p in mine:
            kill(p)
    try:
        code = launcher.wait(30)
    except subprocess.TimeoutExpired:
        kill(launcher.pid)
    seconds = time.time() - t0
    time.sleep(3)                        # the server's last lines
    try:
        menu.stdin.close()
        menu.wait(10)
    except Exception:
        menu.kill()
    events = read_results()
    lines = server_lines(out, logpos)
    crashes = sorted(crash_reports() - before)
    with open(os.path.join(out, name + ".results.jsonl"), "w", encoding="utf-8") as f:
        f.write("".join(json.dumps(e) + "\n" for e in events))
    with open(os.path.join(out, name + ".server.log"), "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    log("%s: %d events, %d server lines, %.0f s, quit %s, killed %s, crash reports %d"
        % (name, len(events), len(lines), seconds, quit_at is not None, killed, len(crashes)))
    return SC.Run(events, lines, crashes, {"quit": quit_at is not None, "killed": killed, "code": code,
                                           "seconds": seconds, "url": url})


# ---------------------------------------------------------------- report

def write_report(results, out, exe_sha):
    import patch_exe
    passed = sum(1 for _n, checks in results for _c, okay, _e in checks if okay)
    total = sum(len(checks) for _n, checks in results)
    lines = ["# Autotest results", "",
             "Generated by `python patch/autotest/run.py` on %s: every check below ran in the game, with no"
             % datetime.datetime.now().strftime("%Y-%m-%d %H:%M"),
             "human input. The runner built Victory.exe (sha256 `%s`, pin `PATCHED_SHA256 = %s`) and the patch" % (exe_sha, patch_exe.PATCHED_SHA256[:16]),
             "pak from this tree, installed them in the test copy of the game, queued each playlist through",
             "a stand-in menu on a local server (`patch/autotest/menu.js`), and started the game the way the",
             "launcher's PLAY does, straight into the match URL with `?RemasterAutoTest=<scenario>`. The native",
             "module's autotest (`patch/autotest.c`) drove the match and quit; the evidence is from its",
             "results file, the HUD probe (`AutoTestHud.js`, in the test pak only) and the server log.",
             "", "**%d of %d checks pass.**" % (passed, total), "",
             "| Scenario | Check | Result | Evidence |", "|---|---|---|---|"]
    for name, checks in results:
        for check, okay, evidence in checks:
            ev = str(evidence).replace("|", "/").replace("\n", " ")
            lines.append("| %s | %s | %s | %s |" % (name, check.replace("|", "/"), "PASS" if okay else "**FAIL**", ev[:400]))
    lines += ["", "Raw files of each run (results.jsonl, server log, Func client log): `%s`." % out, ""]
    open(DOC, "w", encoding="utf-8", newline="\n").write("\n".join(lines))
    log("wrote", DOC, "(%d/%d pass)" % (passed, total))


def main():
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--only", help="comma-separated scenario names")
    ap.add_argument("--no-build", action="store_true", help="use the exe and pak already in --out")
    ap.add_argument("--keep-install", action="store_true", help="leave the test build installed")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--out", default=os.path.join(os.environ.get("TEMP", PATCH), "culling-autotest"))
    ap.add_argument("--user", default="76561190000004242", help="the stand-in menu's player id")
    ap.add_argument("--restore-only", action="store_true", help="put the test copy back as it was, and stop")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    if a.restore_only:
        if not wait_for_free_game(600):
            raise SystemExit("a Victory.exe is running: not restoring now")
        return restore(a.out)
    import patch_exe
    chosen = [s for s in SC.SCENARIOS if not a.only or s[0] in a.only.split(",")]
    if not chosen:
        raise SystemExit("no such scenario: %s" % a.only)
    if a.no_build:
        exe, pak = os.path.join(a.out, "Victory.exe"), os.path.join(a.out, PAK)
    else:
        exe, pak = build(a.out, a.port)
    exe_sha = patch_exe.sha256(exe)
    if not wait_for_free_game(4 * 3600):
        raise SystemExit("the game stayed in use for 4 hours")
    install(a.out, exe, pak)
    server = start_server(a.out, a.port)
    results = []
    try:
        for name, queue, scenario, timeout, check in chosen:
            run = run_one(a.out, a.port, name, queue, scenario, timeout, a.user)
            try:
                checks = check(run)
            except Exception as e:          # a check that can't read the run fails, with why
                checks = [(name + ": checks", False, "check error: %r" % e)]
            for c, okay, ev in checks:
                log("  %s %s: %s" % ("PASS" if okay else "FAIL", c, str(ev)[:200]))
            results.append((name, checks))
            json.dump([(n, c) for n, c in results], open(os.path.join(a.out, "checks.json"), "w"), indent=1)
    finally:
        server.terminate()
        if not a.keep_install:
            if wait_for_free_game(600):
                restore(a.out)
            else:
                log("NOT restored: a Victory.exe is running; run again with --restore-only")
    write_report(results, a.out, exe_sha)


if __name__ == "__main__":
    main()
