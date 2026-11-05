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

Before anything is packed it refuses a git tree with uncommitted changes
(--allow-dirty overrides, and is recorded) and runs the release consistency
gate (test_release_consistency.py: catalog, registry, assets, generated pages
agree; no test content). The commit, branch, dirty flag and gate result go
into the signed manifest ("build") and <out>/build.json. --skip-gate is only
for test builds into an --out folder outside releases/, and the publish
(deploy/stage_objects.js) refuses a release whose gate didn't pass. --key
signs with another key (a throwaway one for a test build).

usage: python make_release.py <server base url> <version> (--full <game dir> | --pak-only) [--out <dir>] [--no-setup]
         [--allow-dirty] [--skip-gate] [--key <private key>] [--overwrite]

The version must be new: no releases/<version> folder (or release in --out)
unless --overwrite, and newer than the live release (the live manifest's
version from <server>/remaster/manifest.json, a read-only GET; offline,
releases/LATEST).
  python make_release.py https://xplab.shop:8443 1.4.0 --full C:/Culling/TheCulling
"""
import argparse
import json
import os
import re
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
    # Dead weight (checked 2026-11-04, docs/UPDATE_INFRASTRUCTURE.md):
    # make_loading_bar.py's movie, not in use (DefaultGame.ini's loading
    # screen plays no movie; only LoadingScreen.mp4 is a startup movie) ...
    "Victory/Content/Movies/LoadingBar.mp4",
    # ... and Goldberg's tool that writes steam_interfaces.txt (nothing loads it).
    "Engine/Binaries/ThirdParty/Steamworks/Steamv136/Win64/generate_interfaces_file.exe",
}
# Never shipped either: a loose extraction of the paks under the Paks folder
# (3,482 files: WwiseAudio banks and Config, byte-for-byte copies of files
# inside the pakchunk paks, which is where the game reads them: Wwise from
# Content/WwiseAudio, config from Victory/Config; nothing reads
# Content/Paks/Victory/), and backups of edited config (*.original).
FULL_EXCLUDE_PREFIXES = ("Victory/Content/Paks/Victory/",)
FULL_EXCLUDE_SUFFIXES = (".original",)
# Func.Launcher.exe refuses to start without Victory/Binaries/Win64/
# pakchunk99-WindowsClient_P.pak next to the client DLL, and Func.Client.dll
# mounts it, so it ships (it isn't on the engine's own pak path).
GAME_EXE = "Victory/Binaries/Win64/Victory.exe"
# A full release's game dir must have these, and it must ship at least
# MIN_FULL_FILES files of MIN_FULL_BYTES in all, SHIPPED among them. The stock
# install ships 73 files, 5.1 GB (the loose copies above excluded; with them it
# was about 3,560, which is why the first version of this check asked for 3,000).
REQUIRED = (GAME_EXE, "Victory/Content/Paks/pakchunk0-WindowsClient.pak")
MIN_FULL_FILES = 60
MIN_FULL_BYTES = 4 << 30
SHIPPED = tuple("Victory/Content/Paks/pakchunk%d-WindowsClient.pak" % n for n in (0, 1, 2, 3, 5, 6, 7, 11)) + (
    "Victory/Binaries/Win64/Func.Launcher.exe", "Victory/Binaries/Win64/Func.Client.dll",
    "Victory/Binaries/Win64/pakchunk99-WindowsClient_P.pak", GAME_EXE)
SETTINGS_README_PATH = STEAM_SETTINGS + "/README.txt"
# Files of a release the build writes itself, so never linked from the install.
WRITTEN = {SETTINGS_README_PATH, "Victory/Content/Paks/" + PAK}
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


def check_source_exe(game):
    exe = os.path.join(game, *GAME_EXE.split("/"))
    digest = patch_exe.sha256(exe)
    if digest not in (patch_exe.STOCK_SHA256, patch_exe.PATCHED_SHA256):
        raise ReleaseError("--full: %s is not the Steam Victory.exe patch_exe.py is for (SHA-256 %s)" % (exe, digest))


def check_exe(release):
    """The shipped Victory.exe has every patch_exe.py fix and is exactly the
    patched Steam exe (patch_exe.verify)."""
    exe = os.path.join(release, *GAME_EXE.split("/"))
    try:
        fixes = patch_exe.verify(exe)
    except ValueError as e:
        raise ReleaseError("the release's Victory.exe: %s" % e)
    print("Victory.exe: cap %d, SHA-1 crash fix, StartTraining URL slots, Duo team pairing; SHA-256 %s"
          % (fixes["cap"], patch_exe.PATCHED_SHA256))


def game_files(game):
    """The install's files a full release ships (relative, "/"), minus FULL_EXCLUDE."""
    out = []
    for folder, _, files in os.walk(game):
        for name in files:
            rel = os.path.relpath(os.path.join(folder, name), game).replace(os.sep, "/")
            if (rel in FULL_EXCLUDE or rel.startswith(".remaster/") or rel.endswith(".part")
                    or rel.startswith(FULL_EXCLUDE_PREFIXES) or rel.endswith(FULL_EXCLUDE_SUFFIXES)):
                continue
            out.append(rel)
    return sorted(out)


def write_new(path, data):
    """Writes path as a new file swapped in whole: a hard link that was there
    (a file of the install) is replaced, never written through."""
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".new"
    with open(tmp, "wb") as f:
        f.write(data)
    os.replace(tmp, path)


def link_game(game, release, files):
    """Hard-link the install's files into release/. Files the release changes
    are copies (Victory.exe, patched) or written new (WRITTEN): a hard link
    shares the install's disk file, and writing to it would change the install
    and every published object of it."""
    for rel in files:
        src = os.path.join(game, *rel.split("/"))
        dst = os.path.join(release, *rel.split("/"))
        if rel in WRITTEN:
            continue
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
    write_new(os.path.join(release, *SETTINGS_README_PATH.split("/")), SETTINGS_README.encode("ascii"))
    return len(files)


def git_state():
    """(commit, branch, [changed paths]) of the repo the release is built from."""
    def run(*args):
        return subprocess.run(["git", "-C", ROOT] + list(args), capture_output=True, text=True, check=True).stdout
    try:
        commit = run("rev-parse", "HEAD").strip()
        branch = run("rev-parse", "--abbrev-ref", "HEAD").strip()
        # By content (git diff), not git status: with core.autocrlf a generator
        # writing LF where the checkout had CRLF shows in status but changes nothing.
        changed = [p for p in (run("diff", "--name-only", "HEAD").splitlines()
                               + run("ls-files", "--others", "--exclude-standard").splitlines()) if p.strip()]
    except (OSError, subprocess.CalledProcessError) as e:
        raise ReleaseError("can't read the git state of %s (%s): a release records the commit it was built from" % (ROOT, e))
    return commit, branch, changed


def under(path, folder):
    path, folder = os.path.normcase(os.path.abspath(path)), os.path.normcase(os.path.abspath(folder))
    return path == folder or path.startswith(folder.rstrip(os.sep) + os.sep)


def run_gate(paks, skip):
    """The release consistency gate (test_release_consistency.py), before packing."""
    if skip:
        print("CONSISTENCY GATE SKIPPED (--skip-gate): a test build; the publish refuses it")
        return "skipped"
    import test_release_consistency as gate
    problems, notes = gate.run(paks=paks)
    for n in notes:
        print("  note: " + n)
    if problems:
        raise ReleaseError("the release consistency gate failed (%d problem(s)), nothing was packed:\n%s"
                           % (len(problems), "\n".join("  " + p for p in problems[:40])))
    print("release consistency gate: ok")
    return "passed"


def compare_versions(a, b):
    """-1, 0 or 1, like the launcher's sync.compareVersions ("1.10.0" > "1.9.2")."""
    pa, pb = str(a).split("."), str(b).split(".")
    for i in range(max(len(pa), len(pb))):
        x, y = (pa[i] if i < len(pa) else "0"), (pb[i] if i < len(pb) else "0")
        if x.isdigit() and y.isdigit():
            c = int(x) - int(y)
        else:
            c = (x > y) - (x < y)
        if c:
            return -1 if c < 0 else 1
    return 0


def live_version(base, timeout=15):
    """(version, where from): the live manifest's version (a read-only GET of
    <server>/remaster/manifest.json), else releases/LATEST, else (None, None)."""
    import urllib.request
    url = base + "/remaster/manifest.json"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, headers={"Cache-Control": "no-cache"}), timeout=timeout) as r:
            return str(json.loads(r.read().decode("utf-8"))["version"]), url
    except Exception as e:                                   # offline, HTTP error, bad JSON
        print("live manifest not readable (%s): checking against releases/LATEST" % e)
    latest = os.path.join(ROOT, "releases", "LATEST")
    if os.path.exists(latest):
        return open(latest).read().strip(), latest
    return None, None


def check_version(base, version, out, overwrite):
    """Refuses a version that was built already (releases/<version>, or a
    release in --out) unless --overwrite, and one not newer than the live
    release: launchers refuse a downgrade, and the same number twice means two
    different releases under one name."""
    if not re.match(r"^\d+(\.\d+){1,3}$", version):
        raise ReleaseError("version %r: use numbers like 1.4.0" % version)
    for folder in {os.path.join(ROOT, "releases", version), out}:
        if os.path.isdir(folder) and os.listdir(folder) and not overwrite:
            raise ReleaseError("%s already exists: release %s was built before. Use the next version, or --overwrite "
                               "to rebuild it (never one that was published)" % (folder, version))
    live, where = live_version(base)
    if live and compare_versions(version, live) <= 0:
        raise ReleaseError("version %s is not newer than the live release %s (%s): launchers refuse a downgrade"
                           % (version, live, where))
    return live


def main(base, version, out=None, game=None, setup=True, pak_only=False, allow_dirty=False, skip_gate=False, key=None,
         overwrite=False):
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
        missing = sorted(set(SHIPPED) - set(files))
        if missing:
            raise ReleaseError("--full: %s lacks %s: nothing built" % (game, ", ".join(missing)))
        size = sum(os.path.getsize(os.path.join(game, *rel.split("/"))) for rel in files)
        if size < MIN_FULL_BYTES:
            raise ReleaseError("--full: %s ships only %.2f GB (a full release is at least %.0f GB): nothing built"
                               % (game, size / 2 ** 30, MIN_FULL_BYTES / 2 ** 30))
        check_source_exe(game)
    releases = os.path.join(ROOT, "releases")
    out = out or os.path.join(releases, version)
    if skip_gate and under(out, releases):
        raise ReleaseError("--skip-gate is for test builds only: give an --out folder outside %s" % releases)
    live = check_version(base, version, out, overwrite)
    print("release %s (live: %s)" % (version, live or "none"))
    commit, branch, changed = git_state()
    if changed and not allow_dirty:
        raise ReleaseError("the git tree has uncommitted changes (%s%s): commit them first, or --allow-dirty "
                           "(the release then records it was built from a dirty tree)"
                           % (", ".join(changed[:5]), ", ..." if len(changed) > 5 else ""))
    gate = run_gate(os.path.join(game, "Victory", "Content", "Paks") if game else None, skip_gate)
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
    if game:
        check_exe(release)
    # What it was built from: in the signed manifest ("build") and beside it (build.json).
    build = {"commit": commit, "branch": branch, "dirty": bool(changed), "gate": gate,
             "kind": "full" if game else "pak-only", "server": base}
    if game:
        build["exeSha256"] = patch_exe.PATCHED_SHA256
    with open(os.path.join(out, "build.json"), "w") as f:
        json.dump(build, f, indent=1)
    with open(os.path.join(out, "build-details.json"), "w") as f:
        json.dump(dict(build, version=version, game=game, changed=changed[:500]), f, indent=1)
    cmd = ["node", os.path.join(ROOT, "launcher", "tools", "make_manifest.js"), release, version, publish]
    if key:
        cmd.append(os.path.abspath(key))
    cmd += ["--build", os.path.join(out, "build.json")]
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
    ap.add_argument("--allow-dirty", action="store_true", help="build from a git tree with uncommitted changes (recorded)")
    ap.add_argument("--skip-gate", action="store_true",
                    help="test builds only (--out outside releases/): skip the consistency gate; the publish refuses it")
    ap.add_argument("--key", help="release signing key (default: make_manifest.js's, CULLING_RELEASE_KEY or the real key)")
    ap.add_argument("--overwrite", action="store_true", help="rebuild a version whose folder exists (never a published one)")
    a = ap.parse_args()
    try:
        main(a.server, a.version, a.out, a.full, not a.no_setup, a.pak_only, a.allow_dirty, a.skip_gate, a.key, a.overwrite)
    except ReleaseError as e:
        sys.exit("make_release: " + str(e))
