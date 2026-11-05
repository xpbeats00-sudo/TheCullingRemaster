# Overhaul audit — launcher and game (2026-11-04)

The whole Remaster was audited end to end with Solo and Duo as the priority: the launcher, the account and matchmaking server, the in-game menus and HUD, the patch and release pipeline, and every game mode from the menu through the server and the game back to the results. Five read-only audits ran in parallel; each finding was then checked, fixed with a test, and merged on the `overhaul-audit` branch.

## Results before the fixes

| Area | Checks passed | Main problems found |
|---|---|---|
| Server | 27 / 40 | a 15 s Showdown round could finish a pending Ranked match and paid like a full match; a deploy lost every match in progress and scored Ranked ones as last place; two players on one address both lost their results; anyone could lock a player out of sign-in; unowned calling cards could be shown |
| Menus and HUD | 19 / 31 | controller/Escape went to the menu under the Remaster panels; the search pill stuck after a disconnect; no way to leave the pregame lobby; Showdown could auto-queue forever; a failed result was silently lost; Duo deaths were posted as losses even if the team won |
| Game modes | 33 / 66 | Duo had no teammate, HUD or board; Showdown rounds were separate matches; quitting left a player "In match" and out of party queues; a Survival death could pay an earlier match; Ranked Duo silently started Ranked Solo; Custom match can't start |
| Launcher | 24 / 44 | a changed game file forced a re-download at PLAY and was later deleted; a no-op Verify wiped the rollback; a dropped connection stalled for hours; PLAY could start a second game; a blocked launcher update crashed it; a Steam folder picked by hand would be overwritten |
| Patch and release pipeline | 17 / 34 | one wrong path published a "release" that removes the game for everyone; the live exe lacks the crash fix; published files could be corrupted by a rebuild; no checkout could build a complete release; diagnostic skins shipped |
| **Total** | **120 / 215** | |

## What was fixed

### Server (`server/`, tests: `test/audit.test.js` 14 cases + updated tests; all 19 test files pass)
- A match ticket records its mode and ranked match; only that ranked match's own result scores it.
- Open match tickets are saved to disk (`tickets.json`), so a deploy or crash mid-match still pays the result.
- Players sharing an address are told apart by their in-game name.
- The menu logging in again closes a match that ended without a result (quit/crash): no stale "In match", no Survival death paying an old match.
- Results are kept per mode; the stock "coop" leaderboard side shows Duo.
- Ranked Duo is refused instead of silently starting Ranked Solo; a placement beyond the field counts as last place instead of being dropped.
- Sign-in: addresses the player signed in from before are exempt from the per-username limit (no lockouts by strangers).
- Only owned calling cards can be shown; buying unknown items fails; a password reset also ends game sessions; `/api/login` needs a user ID.
- Showdown has its own economy (paid once per series) and its series are saved to disk.

### Duo (exe patch fix 4, `patch/patch_exe.py`)
- In the pairs mode every contestant is put in a pair (you and a bot partner), which drives the Duo HUD, the team board and the team win check. Solo, Showdown and Survival are unchanged.
- The HUD waits for the team's outcome before posting a Duo death.

### Showdown (exe patch fix 5, `patch/showdown_rounds.c`; `make_showdown.py`; Showdown HUD and menu)
- Every round of a series plays in one match: a round ends when a fighter goes down, the screen fades to black, both fighters reset at the arena starts, the kit rotates every 2 rounds (7 kits), and only the 4th round win ends the match.
- No more next-round countdown or auto-queue in the menu; the final score shows once.

### Menus and HUD (`patch/src/.../uiresources`, 15 fixes)
- A shared overlay stack: Escape and the controller (Back, Select, D-pad) work on Friends, Leaderboard and the player card and never reach the menu underneath.
- Search pill: "Joining…" immediately, hidden with "Connection lost" on disconnect, "Leave lobby" in the pregame lobby.
- Match results retry 3 times and the end of match says whether they were saved.
- Invite toast moved clear of the map vote; leaderboard styles scoped; Friends shows "Offline"; Ranked stops polling every 15 s.

### Launcher (`launcher/`, 17 fixes; `npm test` 113 tests in 12 suites)
- Changed files at the current release read "Repair needed" with Repair / Play anyway; replaced files are kept.
- A no-op Verify or same-version repair keeps the previous version; staging leftovers are cleaned.
- A dropped connection shows "Reconnecting", then pauses with "Connection lost"; an offline start retries by itself with a Retry button; ping and player count refresh.
- PLAY shows "Running" and can't start a second game; a blocked launcher update is reported instead of crashing.
- A Steam folder picked by hand is refused; clear error messages (missing drive, locked file); drive-root game folders work; bad settings can't break the window; the window fits small screens.

### Release pipeline
In progress (branch `fix-release-pipeline`): full releases by default with the game path checked, publish refuses removals, every release checks the exe has all its fixes, published files never share a disk file with anything rebuilt, a consistency gate, and one-command builds.

## Still open

- **Live server setting:** `CULLING_REQUIRE_ACCOUNT` should be 1 on the VPS now that the account launcher is out (otherwise anyone can log in as any Steam ID).
- **Showdown:** the rival picks its own random weapons instead of the round's kit; no round timer/overtime; items dropped on death stay between rounds.
- **Custom match:** START needs two players and match settings aren't applied.
- **Prison:** Jungle2 has 16 starts while the cap is 24; the number actually placed needs measuring in game.
- **Ranked seasons:** no rollover yet (Season 1 ends 2027-02-01).
- **Launcher:** Electron 33 is old; the new "Repair needed" and Retry screens are unit-tested only.

## In-game checklist

To be run through the launcher on the next build (the results are added here).

| # | Check | Result |
|---|---|---|
| 1 | Solo Jungle: 24 contestants, result and XP saved | |
| 2 | Solo Prison: loads, contestant count | |
| 3 | Quit mid-match: no stale "In match" | |
| 4 | Duo Jungle: teammate, Duo HUD, team board | |
| 5 | Duo Prison: loads | |
| 6 | Duo: you die, teammate wins → win credited | |
| 7 | Ranked: ranked result and banner | |
| 8 | Showdown: round won → fade, reset, next round | |
| 9 | Showdown: round lost → no death screen, reset | |
| 10 | Showdown: kit changes every 2 rounds | |
| 11 | Showdown: 4 wins → VICTORY, menu card once | |
| 12 | Showdown: leave mid-series → "SHOWDOWN LEFT", no auto-queue | |
| 13 | Survival Basic / Advanced, Training Range, Tutorial load | |
| 14 | Friends panel, invite, party queue (two players) | |
| 15 | Leaderboard opens, boards fill | |
| 16 | Controller: Back closes panels, nothing leaks to the menu | |
| 17 | Launcher: Repair needed / Play anyway, Retry when offline | |
| 18 | Back in the menu after each mode: no stuck "IN QUEUE", credits and level current | |
