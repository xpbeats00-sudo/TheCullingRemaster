# Known issues

As of 2026-11-04. Each issue has a severity and the reason it is still open.

## Needs your decision or access

| Issue | Impact | What it needs |
|---|---|---|
| The launcher and its setup aren't code-signed | Windows SmartScreen shows "Windows protected your PC", and some antivirus flags new unsigned installers | A code-signing certificate (paid, tied to your identity) |
| No SSH access to the VPS from the build PC | Every server deploy or publish needs you on Remote Desktop | Authorizing this PC's public key on the VPS, if you want that |
| Launcher 1.2.0 isn't published | Players get 1.1.0, which has the stall freeze and one-at-a-time downloads | Running `Publish Release.bat` on the VPS. The publish script now also takes 1.2.0's setup |
| The account-server fixes aren't live, including a remote crash | Any logged-in client can crash the production server with one message (WinSW restarts it in about 10 s) | Merging the `server-hardening` PR, then `Update Culling Server.bat` on the VPS. It also adds the watchdog and the objects cache rule |
| No CDN | Untested with many players downloading at once, and far from the US | A CDN account (UPDATE_INFRASTRUCTURE.md has the options) |
| Bot AI difficulty tiers (`make_bot_ai.py`, branch `bot-ai`) untested in a match | Unknown feel; Experienced is slower to block than stock | A playtest (docs/BOT_AI_FULL_OVERHAUL.md, section 8) |

## Launcher

| Issue | Severity | Notes |
|---|---|---|
| Release freezing (no manifest expiry) | Low | A compromised server could keep serving an old signed release. Downgrades are refused. An expiry would break offline-published releases, so it's left out by choice |
| Uninstalling the launcher leaves the game (about 6 GB in `%LOCALAPPDATA%\TheCullingRemaster\Game`) | Low | Deliberate: the uninstaller doesn't remove data it can't be sure about. Document it on the website, or add an opt-in checkbox to the uninstaller |
| A really full disk mid-download | Low | Space is checked before downloading, and disk errors stop the sync cleanly with the state kept. Only simulated: no test fills a real disk |
| A machine reboot mid-commit | Low | Recovery is tested with a simulated power loss, not a real reboot |
| A single big file isn't split across connections | Info | Not needed: one connection already fills the measured line (8.0 MB/s single, 8.4 MB/s with 8 streams) |

## Account server

| Issue | Severity | Notes |
|---|---|---|
| 8 moderate npm audit findings remain | Low | Branch `server-deps` patches the 3 high ones. The rest need socket.io 4, which the 2016 game client can't use, and none is reachable in this setup |
| A burst of more than about 1,500 logins in 10 s degrades | Low | Each login sends the 0.73 MB catalog. Far above the planned 30 clients |
| Not measured on the VPS | Medium | All load numbers are from the build PC; the VPS hardware is unknown and runs Node 22 |

The rest of the account-server findings are in SERVER_PERFORMANCE_AUDIT.md.

## Game and bots

| Issue | Notes |
|---|---|
| Matches hold 16 contestants, not 24 | `patch_exe.py` raises Victory.exe's cap to 24, but Solo, Duo, Trios and Quads spawn only at the 16 pods (PlayerStarts tagged `SpawnsDecentral`) on Jungle and Prison; Jungle's other 8 starts are Showdown's arena. Past 16, the game put contestants in pods already taken (1.3.11), so the native module now caps each mode at its free starts. 24 contestants would need 8 more pods in the maps |
| No dedicated game server | Matches run on the player's PC against bots. The VPS only handles accounts. So server tick rate, replication and bot load on the VPS don't apply, and real multiplayer would need a dedicated server build of the game, which isn't available |
