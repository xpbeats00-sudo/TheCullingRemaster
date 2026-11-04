# Known issues

As of 2026-11-04. Each issue has a severity and the reason it is still open.

## Needs your decision or access

| Issue | Impact | What it needs |
|---|---|---|
| The launcher and its setup aren't code-signed | Windows SmartScreen shows "Windows protected your PC", and some antivirus flags new unsigned installers | A code-signing certificate (paid, tied to your identity) |
| No SSH access to the VPS from the build PC | Every server deploy or publish needs you on Remote Desktop | Authorizing this PC's public key on the VPS, if you want that |
| Launcher 1.2.0 isn't published | Players get 1.1.0, which has the stall freeze and one-at-a-time downloads | Running `Publish Release.bat` on the VPS. The publish script now also takes 1.2.0's setup |
| The objects cache rule isn't live | Objects get default caching (fine without a CDN) | Running `Update Culling Server.bat` on the VPS |
| No CDN | Untested with many players downloading at once, and far from the US | A CDN account (UPDATE_INFRASTRUCTURE.md has the options) |
| Bot AI tuning (draft PR #10) untested | Unknown feel and performance | A playtest |

## Launcher

| Issue | Severity | Notes |
|---|---|---|
| Release freezing (no manifest expiry) | Low | A compromised server could keep serving an old signed release. Downgrades are refused. An expiry would break offline-published releases, so it's left out by choice |
| Offline after a paused install shows "Offline" rather than the paused progress | Low | Resume works as soon as the connection is back |
| Uninstalling the launcher leaves the game (about 6 GB in `%LOCALAPPDATA%\TheCullingRemaster\Game`) | Low | Deliberate: the uninstaller doesn't remove data it can't be sure about. Document it on the website, or add an opt-in checkbox to the uninstaller |
| A really full disk mid-download | Low | Space is checked before downloading, and disk errors stop the sync cleanly with the state kept. Only simulated: no test fills a real disk |
| A machine reboot mid-commit | Low | Recovery is tested with a simulated power loss, not a real reboot |
| A single big file isn't split across connections | Info | Not needed: one connection already fills the measured line (8.0 MB/s single, 8.4 MB/s with 8 streams) |

## Account server

The account server findings are in SERVER_PERFORMANCE_AUDIT.md.

## Game and bots

| Issue | Notes |
|---|---|
| The bot count can't exceed 15 in solo | Victory.exe caps players plus bots at 16. Raising it needs an exe patch, which is high risk |
| No dedicated game server | Matches run on the player's PC against bots. The VPS only handles accounts. So server tick rate, replication and bot load on the VPS don't apply, and real multiplayer would need a dedicated server build of the game, which isn't available |
