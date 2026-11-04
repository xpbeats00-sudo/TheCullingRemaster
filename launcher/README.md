# The Culling Remaster launcher

Electron app: animated startup screen, then a launcher with **Servers**, **Game Sync**, **Update**, **Settings** and **PLAY**.
It installs the whole game with the Remaster into a new folder (by default `%LOCALAPPDATA%\TheCullingRemaster\Game`, apart from the launcher's own folder), or uses a Steam copy it finds, and keeps it up to date from a release manifest. The version and build (`v1.1.0 · build <commit>`) show in the startup screen's corner and on the Update tab.

## Run

```bash
cd launcher
npm install
npm start
```

`npm test` runs the sync, settings and game-folder tests. `npm run stamp` writes `build-info.json` (version and Git commit) before packaging. Previewing the pages in a normal browser works too (`src/main.html`, `src/splash.html`): without Electron they load `dev-mock.js` with sample data.

## Layout

| Path | What it does |
|---|---|
| `main.js` | Main process: window, boot checks during the startup screen, IPC for the pages |
| `preload.js` | The pages' only API (`window.launcher`) |
| `lib/sync.js` | Game Sync: manifest, hash checks, resumable verified downloads, disk-space check, atomic replace |
| `lib/game.js` | Finds and checks the game folder; installs the whole game into a new folder or uses an existing one; starts it through the Func launcher |
| `lib/config.js` | Settings in the app's user-data folder |
| `lib/build.js`, `tools/stamp_build.js` | The launcher's version and build name |
| `src/` | Pages: `splash.*` (startup screen), `main.*` + `main-ui.js` (launcher), `fx.js` (shared fog and embers) |
| `tools/cutout.py` | Cuts the logo and mask art out of their black backgrounds |
| `tools/make_manifest.js` | Builds a release for Game Sync |

## Publishing a release

1. Put the files to ship in a folder that mirrors the game install. For the full game, that's the whole game folder (`Engine/`, `Victory/`, `Launch.exe` and the other root files) with the Remaster's files in place. Leave out `Func.Client.Local.dll`: the launcher writes it at PLAY. Optionally put `servers.json` (the server list) next to `release/`.
2. `node tools/make_manifest.js release 1.1.0 publish`. Files are hard-linked into `publish/` when it's on the same drive, so a full release doesn't take its 5.7 GB twice. Don't edit a published release's files in place: build a new version instead.
3. Copy the contents of `publish/` to `C:\culling\updates` on the VPS. They're served as `https://xplab.shop:8443/remaster/manifest.json` and `.../remaster/files/...` (see `deploy/install_vps.ps1`).

Launchers pick it up on their next start or on **Check for updates**. Every file is verified by SHA-256 before it replaces anything. An interrupted download resumes from where it stopped (HTTP Range), each file gets three attempts, and the free disk space is checked first. A manifest can only write inside the game folder, never into Game Sync's own `.remaster` state.

## Security

The pages are sandboxed with context isolation and no Node access, and they can't navigate or open windows. External links come only from the settings' `links`, and they must be https. Downloads require https (plain http only for localhost).
