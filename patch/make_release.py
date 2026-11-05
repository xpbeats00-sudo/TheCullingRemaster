"""Build a launcher release of the Remaster patch for a server.

  1. points the menus and HUD at <server> (make_server_config.py) and packs
     patch/src into release/Victory/Content/Paks/LocalServer-WindowsClient_P.pak
  2. puts the local setting (http://127.0.0.1:8000) back, so local play and
     "Play The Culling (local).bat" keep working
  3. writes the server list and runs the launcher's make_manifest.js, giving
     publish/ (manifest.json + objects/) to copy to C:\\culling\\updates on the VPS
  4. includes the built launcher setup (launcher/dist/TheCullingRemasterSetup.exe,
     unless --no-setup), so older launchers update themselves to it

The client DLL isn't shipped: the launcher points the player's own Func client
at the server (launcher/lib/clientdll.js).

A release is the whole game by default: every file of the install given with
--full <absolute game dir> is hard-linked in (no second copy of the
gigabytes), except what is personal to this PC or made by the launcher itself
(FULL_EXCLUDE), with the Remaster patch above in place of the install's own,
and Victory.exe patched for up to 24 contestants (patch_exe.py). The game dir
is checked first (absolute, exists, has Victory.exe and pakchunk0) and the
release must come out with at least MIN_FULL_FILES files: launchers delete
every file a new release no longer lists, so a release built from a wrong
folder would uninstall the game from every PC. --pak-only (only the patch pak
and the setup) has to be asked for, and publishing it over a full release is
refused unless removals are allowed (deploy/stage_objects.js).

usage: python make_release.py <server base url> <version> (--full <game dir> | --pak-only) [--out <dir>] [--no-setup]
  python make_release.py https://xplab.shop:8443 1.4.0 --full C:/Culling/TheCulling
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
import patch_exe  # noqa: E402

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
GAME_EXE = "Victory/Binaries/Win64/Victory.exe"
# A full release's game dir must have these, and the release at least
# MIN_FULL_FILES files (the stock install has about 3,560).
REQUIRED = (GAME_EXE, "Victory/Content/Paks/pakchunk0-WindowsClient.pak")
MIN_FULL_FILES = 3000
SETTINGS_README = (
    "The Culling Remaster: the launcher writes your player name here\r\n"
    "(force_account_name.txt) before every game. Change it in the launcher.\r\n")


class ReleaseError(Exception):
    pass


def check_game_dir(game):
    """Refuses a game dir a full release can't be built from (see the top)."""
    if not game or not os.path.isabs(game):
        raise ReleaseError("--full needs the game install's absolute path (got %r)" % game)
    if not os.path.isdir(game):
        raise ReleaseError("--full: no folder at %s" % game)
    missing = [rel for rel in REQUIRED if not os.path.isfile(os.path.join(game, *rel.split("/")))]
    if missing:
        raise ReleaseError("--full: %s is not a game install (missing %s)" % (game, ", ".join(missing)))


def game_files(game):
    """The install's files a full release ships (relative, "/"), minus FULL_EXCLUDE."""
    out = []
    for folder, _, files in os.walk(game):
        for name in files:
            rel = os.path.relpath(os.path.join(folder, name), game).replace(os.sep, "/")
            if rel in FULL_EXCLUDE or rel.startswith(".remaster/") or rel.endswith(".part"):
                continue
            out.append(rel)
    return sorted(out)


def link_game(game, release, files):
    """Hard-link the install's files into release/."""
    for rel in files:
        src = os.path.join(game, *rel.split("/"))
        dst = os.path.join(release, *rel.split("/"))
        os.makedirs(os.path.dirname(dst), exist_ok=True)
        if rel == GAME_EXE:
            # Patched (more contestants), so a copy: a link would patch the install.
            shutil.copy2(src, dst)
            patch_exe.patch(dst)
            continue
        try:
            os.link(src, dst)
        except OSError:
            shutil.copy2(src, dst)
    readme = os.path.join(release, *STEAM_SETTINGS.split("/"), "README.txt")
    os.makedirs(os.path.dirname(readme), exist_ok=True)
    with open(readme, "w", newline="") as f:
        f.write(SETTINGS_README)
    return len(files)


def main(base, version, out=None, game=None, setup=True, pak_only=False):
    base = base.rstrip("/")
    if pak_only == bool(game):
        raise ReleaseError("give --full <absolute game dir> (a full release) or --pak-only, not both or neither")
    files = None
    if game:
        check_game_dir(game)
        files = game_files(game)
        if len(files) < MIN_FULL_FILES:
            raise ReleaseError("--full: %s has only %d files to ship (a full release has at least %d): nothing built"
                               % (game, len(files), MIN_FULL_FILES))
    out = out or os.path.join(ROOT, "releases", version)
    release = os.path.join(out, "release")
    publish = os.path.join(out, "publish")
    for d in (release, publish):
        if os.path.exists(d):
            shutil.rmtree(d)
    if game:
        print("full release: %d game files linked from %s" % (link_game(game, release, files), game))
    else:
        print("pak-only release: publishing it over a full release removes the game from every launcher "
              "(the publish refuses it without -AllowRemovals)")
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
    cmd = ["node", os.path.join(ROOT, "launcher", "tools", "make_manifest.js"), release, version, publish]
    setup_exe = os.path.join(ROOT, "launcher", "dist", "TheCullingRemasterSetup.exe")
    if setup and os.path.exists(setup_exe):
        cmd += ["--setup", setup_exe]
    elif setup:
        print("no launcher setup at %s: launchers won't be offered an update (build it with npm run dist)" % setup_exe)
    # One hash cache for every release built into this folder: only files that
    # changed since the last build are hashed (make_manifest.js).
    env = dict(os.environ)
    env.setdefault("CULLING_HASH_CACHE", os.path.join(os.path.dirname(os.path.abspath(out)), ".hashcache.json"))
    subprocess.check_call(cmd, env=env)
    # "Publish Release.bat" publishes the newest release built here unless told otherwise.
    if out == os.path.join(ROOT, "releases", version):
        with open(os.path.join(ROOT, "releases", "LATEST"), "w") as f:
            f.write(version)
    print("release", version, "for", base, "->", publish)
    # What publishing it will change, against the live release (not fatal offline).
    subprocess.call(["node", os.path.join(ROOT, "deploy", "diff_release.js"), publish, base + "/remaster/"])


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description="Build a launcher release")
    ap.add_argument("server")
    ap.add_argument("version")
    ap.add_argument("--full", metavar="GAME_DIR", help="ship the whole game from this install (absolute path)")
    ap.add_argument("--pak-only", action="store_true", help="ship only the patch pak (and setup), not the game")
    ap.add_argument("--out", help="output folder (default releases/<version>)")
    ap.add_argument("--no-setup", action="store_true", help="don't offer the built launcher setup as a launcher update")
    a = ap.parse_args()
    try:
        main(a.server, a.version, a.out, a.full, not a.no_setup, a.pak_only)
    except ReleaseError as e:
        sys.exit("make_release: " + str(e))
