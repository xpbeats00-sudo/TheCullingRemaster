"""Build a launcher release of the Remaster patch for a server.

  1. points the menus and HUD at <server> (make_server_config.py) and packs
     patch/src into release/Victory/Content/Paks/LocalServer-WindowsClient_P.pak
  2. puts the local setting (http://127.0.0.1:8000) back, so local play and
     "Play The Culling (local).bat" keep working
  3. writes the server list and runs the launcher's make_manifest.js, giving
     publish/ (manifest.json + files/) to copy to C:\\culling\\updates on the VPS

The client DLL isn't shipped: the launcher points the player's own Func client
at the server (launcher/lib/clientdll.js).

usage: python make_release.py <server base url> <version> [out dir]
  python make_release.py https://xplab.shop:8443 1.0.0
"""
import json
import os
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)
import make_server_config  # noqa: E402

LOCAL = "http://127.0.0.1:8000"
PAK = "LocalServer-WindowsClient_P.pak"


def main(base, version, out=None):
    base = base.rstrip("/")
    out = out or os.path.join(ROOT, "releases", version)
    release = os.path.join(out, "release")
    publish = os.path.join(out, "publish")
    for d in (release, publish):
        if os.path.exists(d):
            shutil.rmtree(d)
    paks = os.path.join(release, "Victory", "Content", "Paks")
    os.makedirs(paks)
    try:
        make_server_config.main(base)
        subprocess.check_call([sys.executable, "-I", os.path.join(HERE, "make_pak.py"),
                               os.path.join(HERE, "src"), os.path.join(paks, PAK)])
    finally:
        make_server_config.main(LOCAL)
    servers = [{"id": "xplab", "name": "The Culling Remaster", "region": "USA",
                "api": base + "/api", "status": base + "/health"}]
    with open(os.path.join(out, "servers.json"), "w") as f:
        json.dump(servers, f, indent=1)
    subprocess.check_call(["node", os.path.join(ROOT, "launcher", "tools", "make_manifest.js"), release, version, publish])
    print("release", version, "for", base, "->", publish)


if __name__ == "__main__":
    main(*sys.argv[1:])
