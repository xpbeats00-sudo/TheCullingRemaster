# Changelog

## Game (next release)

**Airdrops cost 25% less FUNC**
- Every airdrop's FUNC price is its stock price x 0.75, rounded to the nearest whole FUNC (halves up): Archer 85 -> 64, Sapper 205 -> 154, Bait Crate 70 -> 53. The full before/after table is in `docs/AIRDROP_PRICES.md`. The price is the airdrop package's `ActivityResourceCost` (patched by `patch/make_airdrop_prices.py`); the HUD meter and the menu's Airdrop screen show what the game sends, so they follow it. Surprise Me! has no price of its own (it costs what the kit it rolls costs). Not yet checked in a match.

**Duo: your team wins when it's the last one standing**
- A Duo match now ends with a team victory as soon as every living contestant is on one team: you and your teammate last alive is a win for both (a teammate who died earlier gets the victory too). Before, the match went on until your teammate died. Solo, Showdown and Survival are unchanged. Needs the patched exe (patch_exe.py fix 7, in the native module).

**The Chokening: its kills are yours**
- Players killed by the gas The Chokening starts are now credited to whoever activated it (kill count, kill feed, "Killed by <name>" on the board) instead of "Killed by Suicide" - but not the activator's own death or their Duo teammate's. Needs the patched exe (patch_exe.py fix 8).

**Showdown: the rival gets your kit**
- The rival no longer spawns with its own random loadout (a melee weapon, a bow or gun with ammo, a utility item): at the start of a Showdown match and after every round's reset it gets exactly the round's kit (the same armor, put on, the Muscle Man Milk and the round's weapon, plus fists). Needs the patched exe (patch_exe.py fix 5: SpawnStartingInventory's kit call, VA 0x140267275).
- At each round's reset the fighters' inventories are cleared and weapons and pickups left lying in the world (dropped items) are removed.

**Showdown: every round in one match**
- A Showdown series (first to 4 rounds) is now one match: when a fighter goes down the round ends, the screen fades to black, both fighters are put back at their arena starts (full health, the fallen one alive again, corpses cleared) with a fresh kit, and the screen fades back in. Only the 4th round win ends the match (VICTORY or DEFEAT) and goes back to the menu. Needs the patched exe (patch_exe.py: the native module from patch/showdown_rounds.c in a new .sdround section) and the server update.
- The kit changes every 2 rounds, starting from a random one of seven: a Tier 3 weapon (Tomahawk, Survival Axe, Tactical Machete, Bowie Knife, Baseball Bat, Pipe Wrench, Yari) with Tactical Body Armor and Muscle Man Milk. The pre-round panel shows the round's kit.
- The menu no longer starts the next round by itself; it shows the final score once (or the forfeit of a series quit before its end). Right-clicks on its card no longer reach the screen underneath; PLAY AGAIN says why when matchmaking can't start.
- Jungle's "Grab your Airdrop." toast is stock again in every mode (it was changed for all modes).
- Server: the HUD reports each round (`POST /api/showdown/round`, by round number, counted once); the match result pays the series once with its own economy (250 XP + 250 per round won + 750 for the series; 40 credits + 20 per round won + 120 for the series; one game on the career, a win only for the series, at most a kill per round won, damage capped at 200 a round), instead of a full 16-player match per round. Queuing Showdown leaves any lobby still searching. Series are kept in `data/showdown-series.json` across restarts.

**CUSTOM matches work**
- PLAY > CUSTOM > Create: pick the map (Island or Prison) and the stock CUSTOM MATCH SETTINGS (crate, barrel, pylon and building loot counts, extra crate and open locker chances, health stations, recycler time), then START, alone. The match is played on your PC like Solo, with those settings applied by the game itself (`?mods=`; all 17 work, see docs/GAME_MODE_LOOT_CONFIGURATION.md). Results count as Custom.
- Join explains that custom matches are played on your PC and to invite friends to a party instead. The lobby code is gone from the CUSTOM screen, and leaving the screen leaves the lobby. Needs the server update (`lobby-set-mods`, `custom:<map>:<mods>`) and the menu rebuilt (`make_branding.py --menu-only` for the CUSTOM screen).

**Leaderboard**
- A LEADERBOARD item on the main menu opens the global leaderboard: the top 50 players on Ranked (this season's rating and tier), Wins, Kills, K/D (10 matches or more), Showdown series won and Time played, by account username. Your own row is highlighted, with your position even outside the top 50; a row opens that player's card. Needs the server update (`remaster-leaderboard-get`). See docs/LEADERBOARD.md.

**Airdrops unlock by level**
- The six locked airdrops unlock as players level up, at a level worked out from the tiers of what each one gives (each weapon or armor counts its tier, other items count 1): Demon Hunter, Hawks Eye and Viking at 6, Cyclops at 8, The Imp at 9, Polecat at 10. The menu shows the level beside the lock and on the preview.
- They were locked for everyone before: their files differ in case from their assets, so the item catalog never had them. Archer was missing the same way.

**Bigger matches**
- Up to 24 contestants instead of 16 (Victory.exe patched by `patch/patch_exe.py`): 23 bots on Jungle. Bots have 25 names, so none show an ID.
- Ranked scores a match out of the contestants it really had: 24 on Jungle from the new build, 16 on Prison and from older builds.

## Launcher (next release)

**Game Sync**
- Files changed in the game folder at the release already installed now read "Repair needed (N files changed)", not "Update available". PLAY offers Repair or Play anyway instead of forcing a sync, and a repair keeps the files it replaces in the game folder's `.remaster\replaced` folder (the newest repair's only, up to 1 GB).
- Verify & Sync with nothing to do, and a repair at the installed release, no longer delete the previous version's backup or point "Restore previous version" at the current version. The old backup goes only once a new update has installed.
- A dropped connection mid-download pauses Game Sync with "Connection lost — Resume when you're back online" instead of retrying every file for hours; the progress shows "Reconnecting" while connections keep failing.
- Downloads left over from an older release are deleted, and no longer show as "Download paused" offline.
- A game folder at the root of a drive (D:\) works.

**Start-up and offline**
- Offline at start-up, the launcher keeps trying to reach the update server by itself (5 s, growing to once a minute), with a Retry button next to Offline. Server ping and player count refresh every 45 s.
- A start-up check that fails finishes the start-up screen with the error instead of hanging it.
- A game folder that is gone (an unplugged drive, a deleted folder) says "Game folder not found" instead of "Ready to install".

**PLAY**
- PLAY shows Running while the game runs and can't start a second copy.
- An install that uses a real Steam account is told so at PLAY, not asked to sign in.
- A Steam copy of the game chosen in Settings is refused (installing there would replace Steam's files) unless the launcher already manages it.

**Other**
- Error messages say what Windows blocked: the game starting, a file locked by the running game, the launcher's settings folder, the game folder, or a launcher update.
- A launcher update an antivirus blocks is reported instead of crashing the launcher, and the "Updating launcher" card goes away after a failed update. Offline starts no longer reset the limit on update tries.
- Settings with an empty server list or a bad update address fall back to the defaults; the window buttons always work.
- The window fits screens smaller than 1280x760.
- Electron 45 (from 33), with electron-builder 26 and @electron/fuses 2. The saved sign-in now uses safeStorage's asynchronous API (the synchronous one is gone in Electron 46); sign-ins saved by older launchers still load. Copy diagnostics waits for the clipboard write. The exe also refuses an app.asar that doesn't match the hash embedded at build time, and the build fails if a newer Electron adds a fuse nobody has decided on.

## Launcher 1.3.0 (not yet published)

**Accounts**
- Players create a Remaster account in the launcher: a username, an email and a password. The username is the name everyone sees in game, and it replaces the old player-name box.
- Signing in is the first step before PLAY. The launcher remembers the sign-in, encrypted with Windows' own data protection. It never stores the password.
- Progress a player already has on the server moves to their new account when they create it from the same PC and connection.
- Signing out, an expired sign-in and a password reset all lead back to the sign-in dialog.

**Other**
- The Discord button opens the community server.
- Footer links now come with the launcher, so a changed link reaches everyone.

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
- Error messages say what to do ("Can't reach the update server…", "Your drive is full…") instead of showing raw network codes.
- A paused install shows its kept progress while offline.
- Every control shows a clear focus ring for keyboard use.
- Copy diagnostics (Settings) puts support information on the clipboard. There's also a log at `%APPDATA%\The Culling Remaster\logs\launcher.log`.

**Fixes**
- With the intro off, the window shows the real state once the start-up checks finish.
- The client DLL is rebuilt when the Func mod's DLL changes.
- A Steam copy of the game is no longer overwritten by a full release.

## Release tooling

- Releases publish each file by content hash (`objects/<sha256>`). Publishing a new release uploads only the files that changed; republishing 1.1.0 this way uploads nothing.
- The publish script checks every upload against its hash, and never overwrites a published object.

## Account server (branch `server-hardening`, not deployed)

- Fixes a remote crash: one malformed message from a logged-in client could stop the server.
- Players can no longer change the level curve for everyone.
- Saves are atomic and batched to at most one per second; nothing is lost on a service stop.
- Everything clients can make the server hold is bounded (profiles, tokens, sockets, message size).
- Operator telemetry at `/metrics` (on the VPS only), and a watchdog that restarts a hung server with backoff.
- About 60 times lower p95 latency at 1,000 clients in a local test (733 ms to 11.5 ms).
- Dependencies (branch `server-deps`): Express 4.22.3 and socket.io 2.5.1 fix 3 high-severity denial-of-service issues.

## Bot AI (branch `bot-ai`, not released)

- Five difficulty tiers (Beginner, Casual, Experienced, Advanced, Elite), one built into the patch pak by `patch/make_bot_ai.py` (default Experienced). Each sets how often the AI decides in a fight (stock re-rolled block/shove every frame), how far it sees, how long it remembers a contestant it lost, how it weighs threats, its charged-attack, block and bow timing, and (Casual and up) loots healing and armour instead of guns and traps it can't use. Every tier: archers hold position while drawing (they walked toward the map's origin). Scripted values, not machine learning; no health or damage changes. Untested in a real match (docs/BOT_AI_FULL_OVERHAUL.md).
- Replaces draft PR #10's AI values in `patch_assets.py`, and drops its no-op wander tweak.

## Launcher 1.1.0 (published 2026-11-04)

- Installs the whole game, with player-name selection before PLAY and signed releases.
