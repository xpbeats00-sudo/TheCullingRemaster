# The Culling Remaster launcher

Electron app: animated startup screen, then a launcher with **Servers**, **Game Sync**, **Update**, **Settings** and **PLAY**.
It installs and updates the Remaster's own files (patch pak, client DLL) on top of the player's The Culling install. It does not download the game itself.

## Run

```bash
cd launcher
npm install
npm start
```

`npm test` runs the sync and settings tests. Previewing the pages in a normal browser works too (`src/main.html`, `src/splash.html`): without Electron they load `dev-mock.js` with sample data.

## Layout

| Path | What it does |
|---|---|
| `main.js` | Main process: window, boot checks during the startup screen, IPC for the pages |
| `preload.js` | The pages' only API (`window.launcher`) |
| `lib/sync.js` | Game Sync: manifest, hash checks, verified downloads, atomic replace |
| `lib/game.js` | Finds and checks the game folder; starts it through the Func launcher like `Play The Culling (local).bat` |
| `lib/config.js` | Settings in the app's user-data folder |
| `src/` | Pages: `splash.*` (startup screen), `main.*` + `main-ui.js` (launcher), `fx.js` (shared fog and embers) |
| `tools/cutout.py` | Cuts the logo and mask art out of their black backgrounds |
| `tools/make_manifest.js` | Builds a release for Game Sync |

## Publishing a release

1. Put the files to ship in a folder that mirrors the game install:
   `release/Victory/Content/Paks/LocalServer-WindowsClient_P.pak`, `release/Victory/Binaries/Win64/Func.Client.Local.dll`.
   Optionally put `servers.json` (the server list) next to `release/`.
2. `node tools/make_manifest.js release 1.0.1 publish`
3. Upload `publish/` so that `https://xplab.shop/remaster/manifest.json` and `.../remaster/files/...` are served.

Launchers pick it up on their next start or on **Check for updates**. Every file is verified by SHA-256 before it replaces anything, and a manifest can only write inside the game's `Victory` folder.

## Security

The pages are sandboxed with context isolation and no Node access, and they can't navigate or open windows. External links come only from the settings' `links`, and they must be https. Downloads require https (plain http only for localhost).
