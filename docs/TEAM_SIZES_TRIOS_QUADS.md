# Team sizes: Trios, Quads and team Showdown

Branch `team-sizes`. Trios (teams of 3) and Quads (teams of 4) are played
locally like Duo: you and 2 or 3 AI teammates against AI teams of the same size,
24 contestants (8 trios or 6 quads). Team Showdown (NvN rounds) is built and
tested in the native module, but it is **not on the menu**: its spawns are
blocked (see below).

Status words: PASS (checked), FAIL, BLOCKED, NOT TESTED (needs the game),
PARTIAL.

## How it works

### Team size from the match URL

- Duo opens `Jungle_P?bEnableBots=true?game=/Game/Blueprints/GameMode/VictoryGameMode_CoopRanked.VictoryGameMode_CoopRanked_C`
  (`patch/make_duo.py`). Trios and Quads open the same URL with
  `?TeamSize=3` / `?TeamSize=4` (`make_duo.TEAM_URLS`; copied in ClientWeb.js
  `REMASTER_TEAM_URLS`, checked by `test_match_urls.py`).
- The game keeps the URL's options in `AGameModeBase::OptionsString`
  (GameMode +0x400). Found from the reflection data (the `OptionsString`
  UStrProperty is constructed with offset 0x400, VA 0x14183cdd8) and confirmed
  in `AGameModeBase::InitGame` (VA 0x14133e2c3: `lea rcx, [rbx+0x400]; mov rdx,
  Options; call FString=`). The module parses `?TeamSize=` itself (UE option
  syntax, key in any case, value 2-8); no game function is called for it.
- Fix 4 pairs contestants with a stub (`SetTeamNum(ps, index/2 + 1)`, VA
  0x14005ac03) called from the scoreboard refresh (VA 0x140203b3a). That hook
  and stub are kept exactly as 1.3.9 shipped them in every build: they pair
  Duo. Fix 9 takes only the stub's own final sort call (VA 0x14005ac50) to the
  module's `sd_teams`, which runs after the stub's pairing:
  - ClassicTeams (type 2) with `?TeamSize=` 3-8: re-teamed `SetTeamNum(ps,
    index / N + 1, true)` over GameState.PlayerArray (Trios, Quads).
  - ClassicTeams without it, or 2 (Duo): left exactly as the stub paired it.
  - Lightning (Showdown, type 3, which the stub skips): teamed only with
    `?TeamSize=` 2-8 (team Showdown); the 1v1 URL has none.
  - Every other type: no teams (as before). Then the stock sort.
  - Without the module (`patch(rounds=False)`) the stub calls the sort itself.
  - **In-game regression (2026-11-05, pin e02e5f98):** the first fix 9 build put
    `sd_teams` on the refresh's own call (VA 0x140203b3d, keeping the `mov rcx,
    rax`) and let it do Duo's pairing too; Duo then had no teammate in game,
    while the 1.3.9 exe paired with the same pak. Static review found that
    build's `sd_teams` equivalent to the stub for Duo (same GameState, type
    byte +0x4e4, PlayerArray, SetTeamNum arguments; ABI and stack checked), so
    the cause was not pinned down; Duo was moved back onto the proven code
    instead. The exe is upgraded from that build (and from older ones) to the
    current bytes; `test_patch_exe.py` asserts the hook site and stub, and
    `test_native_module.py` runs the stub-then-`sd_teams` path for Duo URLs.
    New pin: PATCHED_SHA256 `574bec67b8cda1ce8d26c1675d17d4d907fb25efb0fad56f12ae5955361738d8`.
- 24 contestants divide by 2, 3 and 4. Teams are by PlayerArray index; you
  join first, so you are on team 1 with the next N - 1 contestants.

### What already worked for any size (verified in code)

- Team win (fix 7, `duo_should_end`): ends when every living contestant has the
  same TeamNumber > 0 and someone of another team has died. Size-agnostic:
  tested with 12 pairs, 8 trios and 6 quads.
- Winners: `DetermineMatchWinner` (0x1402324a0) marks every record with the
  living team's number.
- Chokening credit (fix 8): teammate check is "TeamNumber > 0 and equal" -
  covers every teammate (tested with two teammates).
- End-of-match scoreboard (hud.js `ConvertScoreboardDataForBinding`) groups by
  `player.team` - any size. The > 16 scoreboard (fix 6) copies every entry.

### What assumed one teammate, and the fix

- **The game's teammate panel is native and single-teammate.** The
  AVictoryPlayerHUD tick (VA 0x1401fbea1-0x1401fc092) finds the first pawn with
  your TeamNumber, keeps it at HUD +0x658 (weak), sets HUD +0x654, binds its
  death to `TeamMemberDied`, sends `OnTeamMemberAdded(name)` once and then
  `SetTeamMemberStatus(health, max, stamina, max)` for that one pawn
  (0x140203d20). It never looks for a second teammate.
- Fix: in Trios/Quads (team size > 2) the module's once-a-second check
  (`sd_should_end` -> `report_mates`) sends the HUD page one message through
  `AVictoryPlayerHUD::ShowGameMessage` (the same channel Showdown's `SDR|` uses):
  `TMS|<k>{|<health %>|<stamina %>|<alive 0/1>|<name>}*k` - every teammate except
  you and the one the game's panel shows (remembered from HUD +0x658, so it is
  never listed twice even after its pawn is gone), in PlayerArray order. Health
  and stamina come from the same getters the native panel uses (health
  component pawn +0x830: 0x140262d20 / 0x1402634c0; stamina component +0x828:
  0x14028ee40 / 0x14028f9c0). Names: PlayerState +0x408, 20 chars, `|` -> `/`.
  Duo sends nothing new.
- hud.js (ES5): `TMS|` never shows as a game message; each reported teammate
  gets a panel cloned from the game's markup (`.remaster-party-extra`), styled
  like the Duo panel and stacked above it by `RemasterPlacePartyBar` (the game's
  panel keeps the lowest place while shown; a downed teammate's panel hides and
  the others move down). Hidden on pause and on your death, like the game's.
  "<name> is your Teammate!" once per reported teammate.
- Your death's result (Duo's "wait for the team" rule) now waits for the whole
  team: `remasterTeam.bMateAlive` = the panel teammate alive OR any reported
  teammate alive; the result posts when the last one is down.
- Lobby (MatchLobby.js): "Trio Play" / "Quad Play", YOUR TEAM lists 2 / 3
  TEAMMATE rows, the team count is contestants / N.

### Menu and server

- Play screen: TRIO PLAY and QUAD PLAY tiles right after DUO
  (`make_branding.add_team_tiles`, also applied by `--menu-only`), Duo's art,
  no `data-push-screen` (the stock Play.js queues only `solo_play`/`duo_play`
  and pushes a screen for any other tile). `js/Teams.js` queues
  `ffa_jungle_coop3` / `ffa_jungle_coop4`. Seven tiles now: 11.4vw x 15vw,
  titles 1.8vw (was five at 16vw x 21vw).
- Server (`server/server.js`, minimal): `coop3`/`coop4` modes (`TEAM_MODES`),
  match-ready `trio:<map>` / `quad:<map>`, a party queues up to the team size,
  presence labels Trios/Quads, Ranked teams still refused.

## Team Showdown (NvN rounds)

Implemented in the module, gated by `?TeamSize=N` on the Lightning URL:

- Sides: "mine" is your team, "theirs" the other (1v1 keeps PC vs AI). A round
  ends when one side has nobody standing; W/L/D, BETWEEN (3 s black), RESET
  (every pawn and corpse destroyed, every record revived, everyone respawned:
  PlayerControllers first, then AIs), first to 4 - the existing series code.
  Until `sd_teams` has assigned teams the series does not start.
- Kit: `kit_rival` already gives every AI the player's kit - teammates and
  rivals alike.
- Bots: the GameMode's bot spawner call at match start (VA 0x14023330d, call
  0x1402320f0, which reads BotsToSpawn at +0x518) goes to `sd_spawn_bots`, which
  sets 2N - 1 first in team Showdown (Lightning's default is 1).
- HUD: the `SDR|` messages are unchanged ("YOU w - l RIVAL" means the teams);
  `TMS|` reports teammates for N >= 3.
- Tests: 2v2, 3v3, 4v4 series (`test_native_module.py`), 1v1 regression.

**BLOCKED - spawns.** Showdown's map edit (`make_showdown.py ARENA_STARTS`)
moves only two `SpawnsLightning` PlayerStarts into the arena (opposite sides);
the other six are retagged unused. 2N fighters on two starts would stack (or
fail to spawn: a pawn that doesn't spawn counts as down and can end a round).
Teams also need sides: nothing places a team together, and the reset respawns
"each at a free start". Options, each needing RE or asset work not done here:
1. Move the six spare starts into the arena (3 per side) - but the 1v1 picker
   could then put both fighters on one side; or tag them differently and
   select them with the URL's `SpawnTag` option (AVictoryGameMode::InitGame
   reads `?SpawnTag=` into GameMode +0x5e0, used by the start chooser near
   0x140231b61 - its exact rule is not verified).
2. Teleport each pawn to its team's side after RestartPlayer (needs
   `K2_SetActorLocation`/`TeleportTo` located in the exe).
3. The server's Showdown record is 1v1 (`SHOWDOWN.format`); team results would
   need their own format.
So team Showdown has no menu tile and no server queue; 1v1 Showdown is
unaffected (no `?TeamSize=` in its URL).

## Static verification (2026-11-05)

| Check | Result |
|---|---|
| `python build_showdown_rounds.py --check` (cl /W4 /WX, 11136 bytes, 7 entries) | PASS |
| `python test_patch_exe.py <copy of stock Victory.exe>` (stand-ins + real exe: new calls lead to `sd_teams`/`sd_spawn_bots`, stock bytes matched, idempotent, older-build upgrade, foreign call refused) | PASS |
| Real exe copy: fix 4's `call 0x14005ac03` at 0x140203b3a, the stub's sort call to `sd_teams` at 0x14005ac50, `call sd_spawn_bots` at 0x14023330d (capstone) | PASS |
| Main-branch-patched exe re-patched == fresh patch (byte compare) | PASS |
| `python test_native_module.py`: team sizes from URLs (20 URL forms), Showdown-only-with-TeamSize, holes, 2N-1 bots, team win for 2/3/4 of 24, Showdown 1v1, team Showdown 2v2/3v3/4v4, Trios/Quads `TMS|` report, Chokening with a trio | PASS |
| Mutation check (5 mutants of the new code, each caught) | PASS |
| `python test_match_urls.py`, `python test_menu_items.py` | PASS |
| `node test_team_hud.js` (hud.js's own functions: panels, stacking, hide, team result) | PASS |
| `node test_showdown_hud.js` | PASS |
| `node --check` on ClientWeb.js, MatchLobby.js, Teams.js, Showdown.js, hud.js, ShowdownHud.js, server.js | PASS |
| `python lint_es5.py` Teams.js, MatchLobby.js, hud.js (whole); ClientWeb.js (`--diff origin/main`) | PASS |
| Server tests (`NODE_PATH` = main checkout's node_modules): matchqueue (new Trios/Quads case), audit, friends, matchlobby and 15 others | PASS |
| `server/test/showdown.test.js` | FAIL - also fails on origin/main without these changes (ENOENT profiles.json in its temp dir) |
| In game | NOT TESTED |

## In-game checks (through the launcher + VPS)

1. Patch the exe (`patch_exe.py`), build the pak, release; the launcher installs it.
2. Duo regression: Duo tile -> pairs as before, one teammate panel, match ends
   with your team's win, no `TMS|` text anywhere.
3. Play screen: seven tiles fit on one row at 1080p and 1440p/ultrawide,
   titles readable, hover/focus scale doesn't clip, controller/keyboard focus
   moves across all seven.
4. TRIO PLAY: lobby says "Trio Play", YOUR TEAM has 2 TEAMMATE rows, "8 teams".
   In the match: the TEAM/KILLS/STATUS board shows 8 teams of 3 (layout of 3
   rows per team), you + 2 bots on team 1.
5. Trios HUD: the game's panel shows one teammate; one more panel stacked above
   it with name, health and stamina moving (1 s updates); "X is your Teammate!"
   for both. A teammate dying: its panel goes, the other moves down.
6. QUAD PLAY: same with 6 teams of 4 and 2 extra panels.
7. AI teammates: don't attack you or each other; you can't damage them (if the
   game blocks team damage); their spawns (CoopRanked's pair-balanced spawns -
   do trios/quads spawn together or apart?).
8. Win: last team standing ends the match; every teammate (dead ones too) is a
   winner; the end-of-match scoreboard groups 3 / 4 per team.
9. Your death with teammates alive: "Your result is saved when your team's
   match ends"; result posted at the team's win or when the last teammate dies.
10. Chokening in Trios: gas kills of rivals credit you; teammates in the gas are
    not your kills.
11. Server: the profile records Trios/Quads under `coop3`/`coop4`; friends see
    "In match · Trios".
12. Showdown 1v1 regression: rounds, kits, first to 4 unchanged.
13. (Team Showdown, only after the spawn blocker) open
    `Jungle_P?bEnableBots=true?game=...VictoryGameMode_Lightning_C?TeamSize=2`
    from a dev build: 3 bots, teams 2v2, rounds end on a team wipe.

## Risks

- CoopRanked's spawn logic is "pair-balanced"; with trios/quads it may place
  teammates apart (cosmetic) - check 7.
- The in-world TEAM/KILLS/STATUS board layout was made for pairs; groups of 3/4
  may overflow - check 4.
- AI team behaviour (no friendly targeting) is assumed to read TeamNumber as in
  Duo - check 7.
- The extra panels update once a second (the native one every frame).
- 11.4vw tiles: the stock titles and hover glow were sized for 4-5 tiles.
- `GM_TYPE` is read at bot-spawn time for team Showdown only (class default);
  irrelevant to Trios/Quads.

## Files

`patch/showdown_rounds.c` (sd_teams, sd_spawn_bots, report_mates, team
Showdown sides), `patch/build_showdown_rounds.py`, `patch/showdown_rounds_blob.py`,
`patch/patch_exe.py` (fix 9), `patch/test_patch_exe.py`, `patch/test_native_module.c/.py`,
`patch/make_duo.py`, `patch/make_branding.py`, `patch/test_match_urls.py`,
`patch/test_menu_items.py`, `patch/test_team_hud.js`, `patch/lint_es5.py`,
`patch/src/.../FrontEnd/js/{ClientWeb,MatchLobby,Teams}.js`,
`patch/src/.../hud/js/hud.js`, `server/server.js`, `server/test/matchqueue.test.js`.
