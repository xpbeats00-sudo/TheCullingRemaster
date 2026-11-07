# Changelog

## Server (next update)

**Match pay can't be farmed with fake results**
- Fixed: a match result paid kills, damage, XP and credits however short the match was (the minimum match length only blocked the win). Posting fake results in a loop paid about 725 credits each, enough to buy the whole shop in minutes and top the kills leaderboard (FULL_AUDIT_2026-11-06, P0 #1).
- A result less than 2 minutes after the match started (`CULLING_MIN_MATCH_SECONDS`) now pays nothing and isn't counted on the career or in today's matches. Ranked still scores it as last place, as before.
- Kills count up to 1 per 20 s of match (`CULLING_SECONDS_PER_KILL`) and damage up to 10 per second (`CULLING_DAMAGE_PER_SECOND`). The time includes loading and the pod countdown, so real matches stay well inside both.
- Match credits and XP stop at 8,000 credits and 40,000 XP a day, UTC (`CULLING_DAILY_MATCH_CREDITS`, `CULLING_DAILY_MATCH_XP`). Showdown series pay counts toward the same cap. Games still count past the cap; set a limit to 0 to turn it off.
- A normal match pays exactly as before. Tests: `server/test/matchpay.test.js`.

## Game (next release)

**Teams on a game server**
- In a match hosted on a game server (shared matches, still in testing, not yet open to players), the game now keeps the teams the server sets. Before, it re-paired players by its own list order, so your teammate panel could show the wrong player. Local Duo, Trios and Quads pair as before. Checked in game: with 1.3.12 the panel showed the other player; with this build, your own teammate; a local Duo still pairs you with a bot.

**Found by the in-game autotest (`patch/autotest/run.py`, results in [AUTOTEST_RESULTS.md](AUTOTEST_RESULTS.md))**
- Fixed: in Duo, Trios and Quads two contestants of different teams could still share a pod (and one pod stayed empty). The game's start chooser puts teammates on their team's start, but the teams while everyone spawns aren't the final ones. Team matches now give every contestant a free pod of its own, as in Solo; teammates start apart. Needs the patched exe (fix 12).
- Fixed: every ranked loss was scored as last place. The game never tells the HUD your place (its death data has no Rank), so the result posted 0. The patched exe now sends your place when you die (the contestants still alive, you included), and the HUD posts it; team modes turn it into the team's place.
- Fixed: a win posted placement 0 (the game's victory data has no Rank); it posts 1.
- Showdown: after losing a round by your own death, the game's delayed spectating could take the pawn the next round gave you, losing that round a second in. The pawn is possessed again. Unit tested only; Showdown testing is paused.

**Pods: one contestant each, and nobody starts armed**
- Fixed: when the pods opened, other contestants could be standing in your pod, already holding weapons. Since 1.3.x's 24-contestant matches, Solo, Duo, Trios and Quads put 24 contestants on maps with 16 pods (Jungle and Prison). The game gives each contestant a free pod first, then puts the rest in pods that are already taken, so 8 contestants shared someone's pod. Matches now have one contestant per pod: 16 in Solo, Duo and Quads, 15 in Trios (5 full teams), and Showdown is unchanged. Needs the patched exe (the native module caps the bots at the mode's start points).
- Opponents now start like you, with only their fists, and loot their gear. Before, every match opponent spawned with a random melee weapon, a bow or gun, and a utility item. The Survival, Tutorial and Showdown opponents are unchanged (`patch/patch_assets.py`).
- Ranked team matches are scored among the teams a match really has: 8 duos, 5 trios or 4 quads. Needs the server update.
- Not yet checked in a match.

**Ranked Duos, Trios and Quads**
- The Ranked screen's Duo, Trio and Quads tabs are open: each shows its own tier, ELO, placements and recent matches, and the RANKED tile plays the selected mode. A team mode is the Duo/Trio/Quad match (AI teammates, or your party - the leader queues, up to the team size) rated on your team's placement among the teams (8 duos, 5 trios or 4 quads). Your team's win counts as 1st for everyone on it, even if you fell early. Each mode has its own rating (same tiers, seasons and rewards); Ranked Solo is unchanged. The leaderboard has a board per ranked mode. Server and menus: [RANKED_TEAMS.md](RANKED_TEAMS.md). Not yet checked in a match.

**Team Showdown: Showdown 2v2, 3v3 and 4v4**
- The SHOWDOWN tile asks for the size: 1V1 as before, or 2V2, 3V3 and 4V4, where you and AI teammates take on a team of AI rivals in the centre arena. It is the same series as 1v1: first to 4 rounds, all in one match, with the kit changing every 2 rounds and the same kit for everyone. A round ends when a whole team is down.
- Each team starts on its own side of the arena, side by side, at the start and after every round. In 1v1 the two fighters start where they always did.
- A party of up to the team size queues together into one lobby. Each member plays their own match with AI teammates.
- Your death doesn't end the match while a teammate stands: "YOU ARE DOWN" until the round ends. Your teammate's panel follows them from round to round.
- The pay for a series is unchanged. Team series are recorded per size.
- Needs the patched exe (native module) and the server update. Not yet checked in a match.

**No more getting stuck in trees**
- American Elm and European Linden (the trees on both Jungle and Prison) had trunk collision that stopped about 2 m up, where the trunk forks, and marked unwalkable: a player who ran or jumped into one could land on top of it inside the crown and not get out. Their trunk collision now goes on up into the crown (same footprint, so bots and the navmesh are unchanged): the tree is a solid trunk you bump into (`patch/make_tree_collision.py`).
- A safety net for anything else like it: if you are stuck for 2 seconds while pushing a direction - hanging on something you can't stand on, or inside the world's geometry - you are put back where you last walked (or the nearest free spot) and told "You were stuck: moved to a free spot". Never in the pods, while dead or spectating, using or crafting, on a ladder or swimming; at most once every 20 s. Needs the patched exe (patch_exe.py fix 10, in the native module). Not yet checked in a match.

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

**Hardening (FULL_AUDIT_2026-11-06)**
- Downloads stop as soon as the server sends more than the file's signed size, and the file starts over; the release manifest is read up to 8 MB and its signature up to 1 KB. A partial download bigger than its file is deleted before the disk-space check, so it can no longer leave Game Sync stuck on "not enough disk space".
- The launcher remembers the newest release it has accepted (in its own AppData folder) and refuses an older one, or an earlier build of the same version, even for a fresh install or a newly chosen game folder.
- A finished download that an antivirus keeps locked is retried for up to 30 s (without freezing the launcher). If it stays locked, Game Sync says a file is locked, probably by an antivirus, and Resume continues from the finished download; the other files are not stopped, and it no longer asks to choose another game folder.
- A damaged or planted update journal can't move game files outside the launcher's own `.remaster` folder: a journal naming any other backup folder is dropped, and "Restore previous version" refuses such a record.
- The installed launcher accepts only https addresses (settings, release, servers, the client's server address). Plain http to localhost or 127.0.0.1 works only in a dev run.

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
- Publishing stages exactly the manifest it verified: every `stage_objects.js` step reads the TEMP copy whose signature was checked (`--manifest`/`--sig`), not the release folder's, which a rebuild could replace mid-publish (FULL_AUDIT_2026-11-06, P0 #4).
- The website's setup and `launcher.json` change only after the new manifest is live, so a publish that fails earlier leaves the website as it was; a failure there reads `PUBLISH FAILED AFTER GOING LIVE`.
- Only one publish runs at a time (`C:\culling\publish.lock`).
- A release built from a git tree with uncommitted changes (`build.dirty`) is refused unless `-AllowDirty`, and one without a build record unless `-AllowUnbuilt`. `Publish Release.bat` doesn't pass these; run `deploy\publish_release.ps1` directly for them.
- `make_release.py --ship-dead-weight` ships the dead weight (`LoadingBar.mp4`, `generate_interfaces_file.exe`, the loose `Content/Paks/Victory/` extraction, `*.original`) for a release published over one that still lists it. 1.3.13 did this by editing `FULL_EXCLUDE` by hand, which left the build dirty; the flag builds it from a clean tree and records `build.deadWeight`. The Steam ID files, the Func client DLLs, `InstallScript.vdf` and the patch pak stay excluded either way.
- Full releases never ship `Victory/Saved/`, `*.log`, `*.dmp`, or anything in `steam_settings` but its README.
- `install_vps.ps1`: the Caddy site file is validated before it replaces the live one (and the previous one is put back if Caddy refuses the result); the Node.js swap's failure message is one line again. Node stays pinned at 22.11.0 until a newer 22.x and its SHA-256 are checked.
- `.gitignore` covers `*.pem` and `.env`.

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
