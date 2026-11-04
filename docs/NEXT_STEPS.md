# Next steps

In order. Each step says who can do it.

## Needs you (access, approval or a decision)

1. **Deploy the account-server fix. This is urgent.** Any logged-in client can crash the live server with one message.
   1. Review and merge the `server-hardening` PR and PR #12 (`server-deps`).
   2. On the VPS, run `Update Culling Server.bat`. It installs the fix, the watchdog and the objects cache rule.
   3. Check `C:\culling\data\logs\watchdog.log` shows "ok" within a few minutes.
2. **Merge PR #11** (launcher 1.2.0). The auto-mode safety check blocked merging to `main` while you were away.
3. **Confirm the in-game login once, at the screen.** Open the installed launcher 1.2.0, press PLAY, and check the game reaches the menu with your profile. Nobody has checked this yet (see TEST_RESULTS.md).
4. **Publish on the VPS** over Remote Desktop with C: shared (`Connect to VPS (shares C drive).rdp`). Run `Publish Release.bat`. It republishes 1.1.0 as objects (uploading nothing) and publishes the launcher 1.2.0 setup. Then download the setup from the website once and run it.
5. **Website:** ask the website session to change the "Launcher v1.1.0" badges to v1.2.0 once it's published.
6. **Back up the release signing key** (`%USERPROFILE%\.culling-release\release_ed25519.pem`) somewhere offline. Losing it means shipping a new launcher.
7. **Decisions:**
   - **Code signing:** a certificate removes the SmartScreen warning.
   - **CDN:** only if many players download at once or from far away.
   - **SSH for deploys:** authorize this PC's key on the VPS if you want deploys without Remote Desktop.
8. **Playtest the bot tuning** (draft PR #10) using its checklist.

## Engineering (can continue autonomously)

1. **After the deploy:** run the load test against the VPS itself (`server/test/load.js`, 30 clients) and confirm `/metrics` is refused through Caddy.
2. **Phase B, launcher:**
   - a high-DPI and window-resize check;
   - a resume-after-reboot test on a real reboot;
   - a disk-space estimate that counts staging.
3. **Release retention:** a script that lists objects no published manifest references, for review before anything is deleted.
4. **Server:** soften login storms on a release day. Ship the catalog with the patch so the client's version matches and the 0.73 MB catalog isn't re-sent, or cache the encoded catalog packet (SERVER_PERFORMANCE_AUDIT.md section 6).
