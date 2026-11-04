"""Build a launcher release of the Remaster patch for a server.

  1. points the menus and HUD at <server> (make_server_config.py) and packs
     patch/src into release/Victory/Content/Paks/LocalServer-WindowsClient_P.pak
  2. puts the local setting (http://127.0.0.1:8000) back, so local play and
     "Play The Culling (local).bat" keep working
  3. writes the server list and runs the launcher's make_manifest.js, giving
     publish/ (manifest.json + files/) to copy to C:\\culling\\updates on the VPS

The client DLL isn't shipped: the launcher points the player's own Func client
at the server (launcher/lib/clientdll.js).

With --full <game dir> the release is the whole game: every file of that
install is hard-linked in (no second copy of the gigabytes), except what is
personal to this PC or made by the launcher itself (FULL_EXCLUDE), with the
Remaster patch above in place of the install's own.

usage: python make_release.py <server base url> <version> [--full <game dir>] [--out <dir>]
  python make_release.py https://xplab.shop:8443 1.0.0
  python make_release.py https://xplab.shop:8443 1.1.0 --full ../TheCulling
"""
import argparse
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
STEAM_SETTINGS = "Engine/Binaries/ThirdParty/Steamworks/Steamv136/Win64/steam_settings"
# Never shipped from a full install: this PC's Steam identity and name (each
# player gets their own; the launcher writes the name), the client DLLs the
# launcher points at a server itself, the patch this release replaces, and
# Steam's install script (EasyAntiCheat, unused).
FULL_EXCLUDE = {
    STEAM_SETTINGS + "/force_steamid.txt",
    STEAM_SETTINGS + "/force_account_name.txt",
    "Victory/Binaries/Win64/Func.Client.Local.dll",
    "Victory/Binaries/Win64/Func.Client.Online.dll",
    "Victory/Content/Paks/" + PAK,
    "InstallScript.vdf",
}
SETTINGS_README = (
    "The Culling Remaster: the launcher writes your player name here\r\n"
    "(force_account_name.txt) before every game. Change it in the launcher.\r\n")


def link_game(game, release):
    """Hard-link the install's files into release/, minus FULL_EXCLUDE."""
    count = 0
    for folder, _, files in os.walk(game):
        for name in files:
            src = os.path.join(folder, name)
            rel = os.path.relpath(src, game).replace(os.sep, "/")
            if rel in FULL_EXCLUDE or rel.startswith(".remaster/") or rel.endswith(".part"):
                continue
            dst = os.path.join(release, *rel.split("/"))
            os.makedirs(os.path.dirname(dst), exist_ok=True)
            try:
                os.link(src, dst)
            except OSError:
                shutil.copy2(src, dst)
            count += 1
    readme = os.path.join(release, *STEAM_SETTINGS.split("/"), "README.txt")
    os.makedirs(os.path.dirname(readme), exist_ok=True)
    with open(readme, "w", newline="") as f:
        f.write(SETTINGS_README)
    return count


def main(base, version, out=None, game=None):
    base = base.rstrip("/")
    out = out or os.path.join(ROOT, "releases", version)
    release = os.path.join(out, "release")
    publish = os.path.join(out, "publish")
    for d in (release, publish):
        if os.path.exists(d):
            shutil.rmtree(d)
    if game:
        print("full release: %d game files linked from %s" % (link_game(os.path.abspath(game), release), game))
    paks = os.path.join(release, "Victory", "Content", "Paks")
    os.makedirs(paks, exist_ok=True)
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
    ap = argparse.ArgumentParser(description="Build a launcher release")
    ap.add_argument("server")
    ap.add_argument("version")
    ap.add_argument("--full", metavar="GAME_DIR", help="ship the whole game from this install")
    ap.add_argument("--out", help="output folder (default releases/<version>)")
    a = ap.parse_args()
    main(a.server, a.version, a.out, a.full)
