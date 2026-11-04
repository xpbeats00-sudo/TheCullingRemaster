# Changelog

## Launcher 1.2.0 (not yet published)

**Downloads**
- Up to 16 files download at once. On the test line, the 3,517 small game files take 28 s instead of about 7 minutes, and big files run at the full speed of the connection.
- A connection that stops sending for 30 s is dropped and resumed automatically, so a download can no longer freeze forever.
- Failed downloads retry with growing waits (1 to 16 s). A file that keeps failing no longer stops the rest; Resume fetches just what's missing.
- **Pause and Resume.** Progress is kept on disk, including partly downloaded files, and survives closing the launcher. Closing mid-download pauses first.
- New settings: downloads at once (16, 8, 4, 2) and a download speed limit.

**Updates**
- Updates download into a staging folder and are installed only once every file has been verified. A failed or interrupted update leaves the previous version working.
- **Restore previous version** (Settings) brings back the files from before the last update.
- **Verify & Repair** (Game Sync) rechecks every game file and downloads only the bad ones.
- Files a new release no longer has are removed, and the player's own files are never touched.
- The launcher refuses to update while the game is running, and refuses releases older than the one installed.

**Reliability and security**
- Downloads use the system's network settings: proxy and Windows certificates. Some antivirus HTTPS scanners broke the old launcher.
- A half-finished install can't be started by accident.
- Stricter checks on release files, and redirects are refused.
- The launcher exe is hardened: it can't be run as a Node.js runtime, it loads only its own code, and the menu and DevTools are gone.
- Copy diagnostics (Settings) puts support information on the clipboard. There's also a log at `%APPDATA%\The Culling Remaster\logs\launcher.log`.

**Fixes**
- With the intro off, the window shows the real state once the start-up checks finish.
- The client DLL is rebuilt when the Func mod's DLL changes.
- A Steam copy of the game is no longer overwritten by a full release.

## Release tooling

- Releases publish each file by content hash (`objects/<sha256>`). Publishing a new release uploads only the files that changed; republishing 1.1.0 this way uploads nothing.
- The publish script checks every upload against its hash, and never overwrites a published object.

## Bot AI (draft PR #10, not released)

- Faster bot reactions and wider sight, from game-config and asset values. Untested in a real match.

## Launcher 1.1.0 (published 2026-11-04)

- Installs the whole game, with player-name selection before PLAY and signed releases.
