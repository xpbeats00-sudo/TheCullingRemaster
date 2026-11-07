"""Start a local copy of the backend with shared matches on, for route-B tests.

It runs the backend from a checkout of branch shared-match-backend
(--backend-repo) on 127.0.0.1:<port>, with its own data folder, one pool game
server (gs1@127.0.0.1:7777) and settings that suit real games (slow to load):
a 5-minute ready timeout and ticket lifetime. Nothing here touches the live
server.

Also used as a module by patch/netplay_run.py (start / secret / stop).

usage: python local_backend.py --backend-repo <dir> --data <dir> [--port 8123]
"""
import argparse
import hashlib
import hmac
import os
import subprocess
import time
import urllib.request

MASTER = "route-b-local-test-master-secret"
SERVER_ID = "gs1"


def secret(server_id=SERVER_ID, master=MASTER):
    """The per-server secret: HMAC-SHA256(master, "gameserver:" + id), hex (allocator.js serverSecret)."""
    return hmac.new(master.encode(), ("gameserver:" + server_id).encode(), hashlib.sha256).hexdigest()


def start(repo, data, port=8123, game_port=7777, log=None):
    os.makedirs(data, exist_ok=True)
    env = dict(os.environ, CULLING_PORT=str(port), CULLING_DATA_DIR=data, CULLING_REQUIRE_ACCOUNT="0",
               CULLING_SHARED_MATCHES="1", CULLING_SHARED_PLAYLISTS="ffa,coop2,coop3,coop4",
               CULLING_GAMESERVER_SECRET=MASTER, CULLING_GAMESERVER_POOL="%s@127.0.0.1:%d" % (SERVER_ID, game_port),
               CULLING_GAMESERVER_READY_TIMEOUT_MS="300000", CULLING_GAMESERVER_HEARTBEAT_TIMEOUT_MS="30000",
               CULLING_TICKET_TTL_MS="300000", CULLING_LOBBY_GATHER_MS="4000", CULLING_LOBBY_COUNTDOWN_MS="500",
               CULLING_MIN_MATCH_SECONDS="0")
    out = open(log, "ab") if log else subprocess.DEVNULL
    proc = subprocess.Popen(["node", "server.js"], cwd=os.path.join(repo, "server"), env=env, stdout=out, stderr=out)
    for _ in range(100):
        try:
            urllib.request.urlopen("http://127.0.0.1:%d/health" % port, timeout=1)
            return proc
        except Exception:
            if proc.poll() is not None:
                raise RuntimeError("the backend exited (%s)" % proc.returncode)
            time.sleep(0.2)
    proc.kill()
    raise RuntimeError("the backend didn't answer on port %d" % port)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--backend-repo", required=True)
    ap.add_argument("--data", required=True)
    ap.add_argument("--port", type=int, default=8123)
    a = ap.parse_args()
    p = start(a.backend_repo, a.data, a.port)
    print("backend pid %d on 127.0.0.1:%d; gs1 secret %s" % (p.pid, a.port, secret()))
    p.wait()
