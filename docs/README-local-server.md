# The Culling — local server

Run **`Play The Culling (local).bat`**. It starts the local backend (a console window titled
"The Culling local server") and launches the game through the Func launcher.

In game: press a key on the title screen → **Play → Solo** (or Duos). The server "matches" you
instantly and the game loads a local match on the island against bots. Training → Offline
(Jungle / Prison) also works and needs no server.

## What's here

| Path | What it is |
|---|---|
| `server/server.js` | Local stand-in for the game's ClientWeb backend: root data, login, match queue (HTTP) and the socket.io channel for profile, currency, leaderboards, lobbies, matchmaking. Listens on `127.0.0.1:8000`. Profiles are kept in `server/data/profiles.json`. |
| `TheCulling/Victory/Binaries/Win64/Func.Client.Local.dll` | Copy of the Func mod's client DLL with its backend URL changed to `http://127.0.0.1:8000/api` (made by `patch/patch_client_dll.py`; the original DLL is untouched). |
| `TheCulling/Victory/Content/Paks/LocalServer-WindowsClient_P.pak` | Patch pak overriding `FrontEnd/js/ClientWeb.js` so a `match-ready` for `offline:<map>` starts the built-in bot match. Built from `patch/src` by `patch/make_pak.py`. |
| `logs/` | `Func.Client.log` (client mod log) and server logs. |

## Undo

Delete `LocalServer-WindowsClient_P.pak` from `Content/Paks` and launch `Func.Launcher.exe`
normally; the original Func setup is unchanged.

## Known limits

- Bot matches run in-process (the game's offline mode); there is no separate dedicated server.
- Cosmetic entitlements aren't served yet (the native JSON format is unmapped), so you have the
  game's default items; the store and crates are disabled.
