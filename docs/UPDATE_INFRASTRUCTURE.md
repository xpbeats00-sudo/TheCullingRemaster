# Update infrastructure

How releases of The Culling Remaster are built, signed, hosted and published. Written 2026-11-04.

## Hosting today

| What | Where | Served as |
|---|---|---|
| Release objects | VPS `C:\culling\updates\objects\<sha256>` | `https://xplab.shop:8443/remaster/objects/<sha256>` |
| Manifest + signature | VPS `C:\culling\updates\manifest.json(.sig)` | `https://xplab.shop:8443/remaster/manifest.json` (`Cache-Control: no-cache`) |
| Launcher setup | VPS `C:\ssr\www\download\TheCullingRemasterSetup.exe` | `https://xplab.shop/download/TheCullingRemasterSetup.exe` |
| Account server | VPS service `culling-server` on 127.0.0.1:8100 | `https://xplab.shop:8443/api`, `/health` |

**Caddy** (the Superstar Racing VPS's HTTPS server, site file `C:\ssr\caddy\sites\culling.caddy`, written by `deploy/install_vps.ps1`) serves the files. I checked its behaviour live on 2026-11-04:
- stable ETags;
- `Accept-Ranges: bytes`;
- `206` with a correct `Content-Range`;
- `If-Range` honoured, so a stale tag gets a full `200`;
- `416` with `Content-Range: bytes */<size>`.

**The VPS:** Windows Server, Hostinger, US, IP 217.60.97.88.

**Release 1.1.0** is published there in the old `files/<path>` layout. Launchers follow each entry's `url`, so both layouts work.

## Object naming and caching

From this version, `tools/make_manifest.js` publishes each file once, as `objects/<sha256>`. The benefits:
- **Immutable:** an object never changes once published. A launcher in the middle of a download can't have the file swapped under it, and objects can be cached forever.
- **Deduplicated:** identical files are stored once.
- **Differential:** a new release only adds the objects that changed.

**Cache policy (to apply):** `objects/*` → `Cache-Control: public, max-age=31536000, immutable`; `manifest.json(.sig)` → `no-cache`. Live today: `no-cache` on `manifest.json` only. Both rules (objects immutable; `manifest.json` and its `.sig` no-cache) are in `deploy/install_vps.ps1` on the `server-hardening` branch and apply the next time `Update Culling Server.bat` runs after it's merged. *(Not verified on the VPS; the installer runs `caddy validate` before reloading.)*

## Signing

- **Key pair:** made once with `node launcher/tools/make_release_key.js`. The private key is Ed25519 at `%USERPROFILE%\.culling-release\release_ed25519.pem` on the build PC. It is never committed or uploaded.
- **Public key:** `launcher/lib/releasekey.js`, built into every launcher.
- **Signing:** `make_manifest.js` signs every manifest (`manifest.json.sig`).
- **Checking:**
  - `deploy/verify_release.js` checks the signature before anything is published;
  - every launcher checks it before trusting a manifest.
- **Key loss or rotation:** a new key needs a new launcher build carrying the new public key. Old launchers then refuse new releases until players update the launcher, so **back the private key up offline**.
- **Better later:** keep the key on a hardware token or in a signing service, and add a second key so the next launcher can trust two.

## The release recipe

Order matters: **the client release first, then the server update.** The server's `server/data/catalog.json` sells what it lists; a server updated before the client would sell items the live client can't load. So the server is updated only after the new client release is live.

All paths below are absolute. The build PC's clone is `C:\Culling` and the stock game `C:\Culling\TheCulling` (read-only input: no step writes to it).

### 1. Build the client release (build PC)

```
cd C:\Culling
git status                       (clean, on the commit to release)
python C:\Culling\patch\build_release.py 1.4.0 --game C:\Culling\TheCulling --camos C:\Culling\Camos --cards C:\Culling\CallingCards --skip-showdown-tile
```

`patch/build_release.py` runs these steps and stops at the first failure:

1. **Preflight:** checks that these exist, and that the git tree is clean:
   - the install: absolute path, stock pakchunk paks, the stock Steam `Victory.exe`;
   - `--camos` and `--cards`;
   - the branding art in `C:\Culling\patch\branding`: `remaster_logo_source.png`, `xp_mask_source.png`, `download_creepster\`, `ranked\source\*.webp`.
2. **Leftovers:** deletes test and diagnostic files (`*_XPAnim*`, `Camo_XP_Anim_*`, `*XPTest*`) from `patch\src`.
3. **Staging:** a temp folder with only the stock `pakchunk*-WindowsClient.pak` (hard links) and the stock `FrontEnd.html`. The generators also skip `*_P.pak` patch paks on their own (`build_catalog.stock_paks`).
4. **Generators**, in this order:
   - `build_catalog.py` (only with `--catalog`);
   - `make_airdrop_unlocks.py`, `make_airdrop_prices.py`, `patch_assets.py`, `make_bot_ai.py` (Experienced), `make_weapon_balance.py` (its table is empty: stock stats), `make_loading_bar.py` (DefaultGame.ini only);
   - `make_branding.py --skip-intro`, then `make_branding.py --menu-only`;
   - `make_night_sky.py`, `make_night_cube.py`, `make_moon.py`, `make_meteors.py`, `make_sky_fx.py`, `build_menu_arenas.py`;
   - `make_showdown_tile.py` (skipped with `--skip-showdown-tile`: its source screenshot isn't in the repo or the branding folder);
   - `make_camos.py`, `make_vfx_camos.py`, `make_eye_skins.py`, `make_calling_cards.py`, `make_ranked.py`, `make_card_image_map.py`, `make_showdown.py`, `make_rain.py`, `make_weather.py` (the night maps ship; the server offers them only with `CULLING_NIGHT_MAPS=1`; it also rewrites `patch\weather_maps.h`, and a change there changes the native module: rebuild it with `build_showdown_rounds.py` and recompute `PATCHED_SHA256`), `extract_func_anims.py`.
5. **Release consistency gate** (`patch/test_release_consistency.py --paks <stage>`). It checks:
   - item IDs are unique;
   - `patch\registry\{camos,vfx_camos,eye_skins,calling_cards,ranked}.bin` are present and list exactly the catalog items of their source;
   - every catalog item's asset is in the stock paks or `patch\src`;
   - there is no test content (`make_pak.test_content`: `*XPAnim*`, `*XPTest*`, `Camo_XP_Anim_*`, files mentioning them or `TEST BUILD`, and plain `*_XP_*` camo skins with a GeoSkin/BC/BC2 tag; the `*_XP_VFX_*` and Necro Mist camos are released content);
   - `DefaultGame.ini`, `FrontEnd.html` and `hud.html` equal what their generators make.
6. **Tests:** every `patch\test_*.py` and `patch\test_*.js` (the native module's, `test_native_module.py` and `test_weather_native.py`, need the Visual Studio C++ tools, which the preflight checks), `build_showdown_rounds.py --check`, every `deploy\*.test.js` and the launcher's `npm test`. `patch\lint_es5.py --diff <ref>` checks that the new lines of the hand-written UI scripts are ES5 (run it on a change; the stock scripts use `const`).
7. **`patch/make_release.py https://xplab.shop:8443 1.4.0 --full C:\Culling\TheCulling`.** It refuses, and builds nothing, when:
   - the version isn't newer than the live one. The live version comes from `https://xplab.shop:8443/remaster/manifest.json`, or from `C:\Culling\releases\LATEST` when offline;
   - `C:\Culling\releases\1.4.0` already exists (`--overwrite` rebuilds an unpublished one);
   - the git tree is dirty (`--allow-dirty` overrides this, and the override is recorded);
   - the game dir isn't absolute or isn't an install;
   - the game dir ships fewer than 60 files or 4 GB;
   - the game dir lacks a stock pak, `Victory.exe`, `Func.Launcher.exe`, `Func.Client.dll` or `pakchunk99-WindowsClient_P.pak`;
   - the consistency gate fails;
   - the patched `Victory.exe` lacks a `patch_exe.py` fix 1-8 (cap 24, SHA-1 fix, StartTraining URL slots, Duo team pairing, Showdown rounds module, big scoreboards, Duo team win, Chokening kill credit) or isn't byte for byte `PATCHED_SHA256`;
   - `patch\src` holds test content (`make_pak.py`).

   `PATCHED_SHA256` (and `STOCK_SHA256`) are pinned in `patch\patch_exe.py`. Any change to a fix or to the native module (`showdown_rounds.c` rebuilt into `showdown_rounds_blob.py`) changes the patched exe, so recompute the pin with `python patch\patch_exe.py --hash C:\Culling\TheCulling\Victory\Binaries\Win64\Victory.exe` (it patches a temporary copy and prints the SHA-256) and update it in the same commit. `python patch\test_patch_exe.py <stock Victory.exe>` fails until the pin matches.

   It writes:
   - `C:\Culling\releases\1.4.0\publish\`: the signed `manifest.json`, with a `build` entry (commit, branch, dirty flag, gate result, exe SHA-256);
   - `build.json` and `build-details.json` next to it;
   - `C:\Culling\releases\LATEST`.

The generators rewrite tracked files: `server\data\catalog.json`, `server\data\showdown.json` and the generated `.js` in `patch\src`. If any of them changed, `make_release.py` refuses the dirty tree. Review the diff and commit it, then finish with `--skip-generators`, which reruns only the gate, the tests and `make_release.py`:

```
git add -A
git commit -m "Generated data for 1.4.0"
python C:\Culling\patch\build_release.py 1.4.0 --game C:\Culling\TheCulling --camos C:\Culling\Camos --cards C:\Culling\CallingCards --skip-showdown-tile --skip-generators
```

**Pak-only releases** (`make_release.py ... --pak-only`) have to be asked for. Publishing one over a full release would remove the game from every launcher, so the publish refuses it unless `-AllowRemovals` is given.

**Test builds** never touch `C:\Culling\releases`:

```
python C:\Culling\patch\make_release.py <server> <version> --full C:\Culling\TheCulling --out <temp folder> --key <throwaway key> --no-setup [--skip-gate]
```

The publish refuses a manifest whose gate was skipped.

**Diagnostics** (`patch\diagnostics\make_animated_camos.py`, `make_camo_tests.py`) are never part of a release. `make_pak.py` refuses what they write unless `--allow-test-content` is given (local diagnostics paks only).

#### What a full release leaves out of the install

| Left out | Why |
|---|---|
| `steam_settings\force_steamid.txt`, `force_account_name.txt` | This PC's Steam identity and name. The launcher writes each player's own. |
| `Func.Client.Local.dll`, `Func.Client.Online.dll` | The launcher makes them from `Func.Client.dll`. |
| `Victory\Content\Paks\LocalServer-WindowsClient_P.pak` | The patch this release replaces. |
| `InstallScript.vdf` | Steam's install script (EasyAntiCheat, unused). |
| `Victory\Content\Paks\Victory\` (3,482 files, 344 MB) | A loose extraction of the paks: 3,480 byte-size copies of files inside the pakchunks (3,474 Wwise banks, plus config), a differing `DefaultInput.ini` and `DefaultEngine.ini.original`. The game reads Wwise banks from `Content/WwiseAudio` and config from `Victory/Config`, both inside the pakchunks. Nothing reads this folder. |
| `Victory\Content\Movies\LoadingBar.mp4` (2.6 MB) | `make_loading_bar.py`'s movie, not in use. The loading screen plays no movie; the only startup movie is `LoadingScreen.mp4`. |
| `Engine\...\Steamv136\Win64\generate_interfaces_file.exe` | Goldberg's tool that writes `steam_interfaces.txt`. Nothing loads it. |
| any `*.original` | Backups of edited config. |

**Kept, though first listed as dead weight:** `Victory\Binaries\Win64\pakchunk99-WindowsClient_P.pak`. `Func.Launcher.exe` refuses to start without it next to the client DLL, and `Func.Client.dll` mounts it.

A full release from `C:\Culling\TheCulling` ships 73 files, 5.1 GB. The first release built this way removes the 3,484 left-out files from players' installs, so its publish needs `-AllowRemovals`. Check the plan's "removed" list first.

### 2. Publish the client (VPS)

On the VPS, over Remote Desktop with the build PC's C: drive shared, run from the clone:

```
"Publish Release.bat" 1.4.0
"Publish Release.bat" 1.4.0 -AllowRemovals
```

Use the second form only when step 2 below lists removals you expect. Either runs `deploy/publish_release.ps1 -Release \\tsclient\C\Culling\releases\1.4.0\publish`:

1. **Signature check** with the launcher's key, of a copy of the manifest and its `.sig` taken once into TEMP. An unsigned or altered release is refused. Every later step reads that verified copy (`stage_objects.js --manifest ... --sig ...`), never the release folder's manifest, so a rebuild on the build PC mid-publish can't change what is staged. Only one publish runs at a time (`C:\culling\publish.lock`); a second one is refused before it does anything.
2. **The plan** (`deploy/stage_objects.js --plan`): what changes against the live release and what will upload. It **refuses**:
   - a release with no files;
   - a release whose `build.gate` isn't `passed` (a test build);
   - a release that drops files the live release has, unless `-AllowRemovals`. Launchers delete every file a release no longer lists.
3. **`deploy/stage_objects.js`** (same refusals), for each object:
   - already present: reused;
   - in the old `files/` layout with the right hash: hard-linked, so republishing 1.1.0 as objects uploads nothing;
   - otherwise: copied from the build PC and checked against its SHA-256.

   Objects are never overwritten. (Tested by `deploy/stage_objects.test.js` and `deploy/publish.test.js`.)
4. **Swap-in:** the signature, then the manifest, each swapped in whole. A launcher that reads between the two retries once.
5. **The setup** is copied to the website's download folder from the staged setup object, only now that the release is live (a publish that fails earlier leaves the website as it was; a failure here is reported as `PUBLISH FAILED AFTER GOING LIVE`).
6. **Checks** over HTTPS (`deploy/check_published.js`), including that the live manifest's version is the one just published.

**How it ends (docs/SERVER_AUDIT_2.md, D1 and D2).** The window's last lines are one of:

- green `PUBLISHED <version> in N s: https://xplab.shop:8443/remaster/manifest.json says <version> (was <old>)`, with a yellow `NOTE` above it when that version was already live (nothing new went out) or is older than the live one (installed launchers refuse a downgrade);
- red `PUBLISH FAILED: nothing was published (<old> is still live): <why>`;
- red `PUBLISH FAILED AFTER GOING LIVE: release <version> is live, but: <why>` (the check found a problem after the swap).

Then `Log: C:\culling\logs\publish-<time>.log`: everything the window showed, node's output included (the newest 30 logs are kept). The bat's own last line repeats the outcome, in a red window on failure, and its exit code is the publish's (0 only for PUBLISHED; run it as `cmd /c call "Publish Release.bat" <version>` to get the code: `cmd /c` without `call` doesn't pass it on reliably). `CULLING_NO_PAUSE=1` skips its pauses. A failed `git pull` stops it before anything is published.

The bats used to lose their place when `git pull` changed them while they ran (cmd reads a batch file line by line, from a byte position): both earlier updates of `Publish Release.bat` made the running copy resume mid-line, print a "not recognized" error and stop without publishing. The pull and the call to the updated file are now one block that cmd reads whole (`deploy/bats.test.js` reproduces the old failure and checks the new behavior).

On the build PC, objects in `releases\<v>\publish\objects` are hard links only of release files. Those are themselves links of the read-only install, or files written fresh for the release. The launcher setup from `launcher\dist` is always copied, and an object that no longer matches its name is replaced (`launcher/tools/make_manifest.js`, tested by `deploy/make_manifest.test.js`).

### 3. Then update the server (VPS)

Only after step 2 checks out, and only with the release's commit (its `build.commit`) on the branch the VPS clone pulls, run from the clone:

```
"Update Culling Server.bat"
```

It pulls the code and `server\data\catalog.json` and reinstalls the service. If the release adds no items, the order doesn't matter. If it does, a server updated first would sell items the live client lacks.

The update (`deploy/install_vps.ps1`, docs/SERVER_AUDIT_2.md D3) builds the new code in `C:\culling\app.new` (npm ci there) while the server keeps running, then stops the service, backs up `C:\culling\data` to `C:\culling\data\backups\pre-update-<time>` (verified; the newest 10 kept), swaps the code in (the old one becomes `C:\culling\app.previous`) and waits up to 60 s for `/health`. If the new code doesn't answer, it puts the previous code and catalog back and starts that. It ends with a green `SERVER UPDATED` or a red `UPDATE FAILED: <why>. <what state the server is in>.` and the log's path (`C:\culling\logs\update-<time>.log`). The rollback has not been exercised on the VPS yet.

The server also keeps a daily snapshot of `C:\culling\data` in `C:\culling\data\backups\daily-<time>` (the newest 14; `/metrics` shows the last one under `backups`). To restore one: stop the service, `node C:\culling\app\backup.js verify <snapshot folder>`, copy the snapshot's files over `C:\culling\data`, start the service.

## Rolling back a release

- **Server side:** republish the previous release's folder (`releases/<old>/publish`); its objects are still on the VPS. Installed launchers then see an older version and **refuse it**: downgrades are blocked by design. To really roll players back, publish the old content under a new, higher version number (for example 1.1.2 with 1.1.0's files). Only changed objects download.
- **Player side:** Settings → Restore previous version brings back the files kept from before the last update.

## Retention

- Objects are kept as long as any published manifest might need them. Nothing deletes them yet.
- The old `files/` tree can be removed once no published manifest references it, after 1.1.0 is republished as objects.

## CDN

There is no CDN now. The VPS served full line speed to the one client I could test (8+ MB/s). How it holds up with many players downloading at once, or from other continents, isn't measured.

**When to add one:** if several players install at once, or players outside North America report slow downloads.

**Options** (each needs an account and payment decision, so none is set up):
- **Cloudflare R2** (no egress fees) behind a custom domain;
- **Bunny CDN** (pay per GB, simple pull zone pointing at `https://xplab.shop:8443/remaster/`).

Both work with the launcher as it is. Point the manifest's `url` entries, or the launcher's `manifestUrl`, at the CDN. Payloads are immutable objects, so a pull-through CDN caches them for good. Keep the manifest on the origin, or set it to no-cache.

**Requirements:** HTTPS, Range/206, stable ETags, no redirects (the launcher refuses them), and no credentials in the launcher.

## Access controls

- **VPS:** administration over Remote Desktop.
- **SSH:** this PC's key (`tso_vps`) is refused for Administrator; authorizing a key is your decision.
- **Account server:** listens on 127.0.0.1 only, reached through Caddy.
- **Metrics:** the endpoint answers loopback only and refuses forwarded requests (see SERVER_PERFORMANCE_AUDIT).
- **Release signing key:** on the build PC only.
