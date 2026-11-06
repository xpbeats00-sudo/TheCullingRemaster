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
    New pin: PATCHED_SHA256 `574bec67b8cda1ce8d26c1675d17d4d907fb25efb0fad56f12ae5955361738d8`, then `04024dcee5f1d979c219033331e7173225b0a5443430905fb8fad7830cb57e97` with the weather crash and night-cloud fixes (weather.c).
  - **In-game, 574bec67: Duo PASS, Trios FAIL** (one teammate panel). Static
    review again found no defect (World +0xf0 AuthorityGameMode, GameMode
    +0x400 OptionsString, PC +0x490 MyHUD, World +0x178/+0x198 lists, the
    PlayerState bits, HUD +0x658 all re-derived from stock code; CoopRanked's
    native parent is AShooterGame_FreeForAll, so slot 282 runs; no Blueprint
    calls SetTeamNum). Both failures fit "the module's own team assignment
    doesn't take effect" (Trios then stays in the stub's pairs, so there is
    no second teammate to report), but the cause isn't visible statically.
    So the module now says once per team match, ~3 s in, as an ordinary game
    message: **"Your team of N: names"**. Reading it in game:
    no message = the module's HUD messages don't arrive (or no team by 10 s:
    "of N: no team"); "of 2" in Trios = `?TeamSize=` wasn't read from the
    URL; "of 3: one name" = the teams stayed pairs; "of 3: two names" with
    one panel = the `TMS|` report or the panel fails (hud.js now logs every
    report: "Remaster teammates: TMS|..." in the game log). Pin
    `af04c6e874bd6a23299b4f0202765372b99501642ff07ab7d3999d0458cb5c23`.
  - **In-game, af04c6e8 with the 7dbc73d pak: Trios PASS** - the game's panel
    and a stacked second panel, placed above the armor row. The earlier
    one-panel Trios result was the 574bec67 exe with an older pak (hud.js
    before the TMS panels), not the module. The team summary is now debug
    only: the module sends it only when the match URL has `?TeamDebug=1`,
    which no menu or server URL does (`test_match_urls.py` checks). Pin
    `1b53c5273fd5d629d29d4717b37611e0514e18609cc475266172fec0ca847b1d`.
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

## Team Showdown (NvN rounds): Showdown Duos, Trios, Quads

Branch `team-showdown`. The SHOWDOWN tile now asks for the team size (1V1,
2V2, 3V3, 4V4). A team match is you and N - 1 AI teammates against N AI
rivals in the Jungle arena, first to 4 rounds, in one local match, the same
series as 1v1. The match URL is the 1v1 one plus `?TeamSize=N`.

### Rounds (native module, as before)

- Sides: "mine" is your team, "theirs" is the other (1v1 keeps PC vs AI).
- A round ends when one side has nobody standing: W/L/D, BETWEEN (3 s
  black), then RESET (every pawn and corpse destroyed, every record revived,
  everyone respawned, PlayerControllers first, then AIs). First to 4 wins,
  using the existing series code. The series doesn't start until `sd_teams`
  has assigned teams.
- Kit: `kit_rival` gives every AI the player's kit, teammates and rivals
  alike.
- Bots: `sd_spawn_bots` sets BotsToSpawn (+0x518) to 2N - 1. N is now at most
  4: `?TeamSize=` 5-8 plays 4v4 (`showdown_size`), because the arena has
  4 spots a side and 8 starts.
- Teams: `sd_teams` gives `index / N + 1` over PlayerArray. You join first, so
  you are on team 1.

### Spawns: why a native placement plus eight in-arena starts

The blocker was that the arena had only two PlayerStarts. Each option on its
own was weak:

- **Duplicating PlayerStart exports** in the cooked Jungle_P means adding
  exports with their subobjects (capsule, arrow and sprite components), the
  level's actor list, and the export and preload dependency maps, all
  without the editor. That is fragile.
- **Only moving starts** can't give sides. The game picks any free tagged
  start, so a team would be scattered, and with more than two starts 1v1
  could put both fighters on one side. `?SpawnTag=` selection is unverified
  (TEAM_SIZES above).
- **Only teleporting** with two starts still stacks 2N fighters on those two
  at every RestartPlayer (a pawn that fails to spawn counts as down).

So both, each doing what it can do safely:

1. **Level (make_showdown.py `jungle`)**: the eight existing `SpawnsLightning`
   starts (no new exports, names or imports) are rewritten in place: their
   root's RelativeLocation and RelativeRotation. Four are north of the middle
   and four south, at x = -240/-80/80/240 and y = +1800/-1800, z 200, facing
   the middle, 160 apart. Each of up to 8 fighters gets a free start, so nobody
   stacks and nobody fails to spawn. None of them is on a side's spot.
2. **Native (showdown_rounds.c `place`)**: at the series' start and right after
   every reset's RestartPlayer, each fighter goes to its side's spot through
   `AActor::K2_TeleportTo` (VA 0x14111fae0, re-derived by
   test_unstick_native.py). Its controller's ControlRotation (+0x430) is set
   too, so you look into the arena.
   - The west side is team 1, or you in 1v1. The east side is team 2, or the
     rival in 1v1.
   - A side's spots are a line at x = -1800 or +1800, y = (k - (n-1)/2) * 160,
     z 200. In 1v1 they are exactly version 1's two starts, so 1v1 starts
     where it always did.
   - A teleport the engine refuses, or a fighter with no pawn yet, is tried
     again for up to 3 ticks. A fighter on its spot is never moved again that
     round (weak pointers, nothing raw kept).
   - Because the starts are north and south and the spots west and east, a
     teleport never lands on a fighter still standing at a start.
3. **Teammate panel**: AVictoryPlayerHUD's teammate panel looks for your
   teammate's pawn only until it finds one (+0x654 set once, VA 0x1401fc035;
   the search at 0x1401fbec7). Every reset destroys that pawn, so after each
   team reset the module clears +0x654 and the panel finds the new pawn.
   ShowdownHud.js shows "X is your Teammate!" once per match.

`make_showdown.check_spots` proves every start and every spot for 1v1 to 4v4
against the stock Navigation.umap's Recast tiles (parsed from the cooked
level: UE dtMeshHeader of 116 bytes, then vertices, then 32-byte polys).
Each one has an arena-floor navmesh polygon under it (z 15-23, spawned at
200), and no two are within 150 units (3 capsule radii). The arena floor
itself (Center_Ring_Inner) runs from radius about 700 to 1900 at z 6-57. The
random centre configs (Center_Config_1-3: rings, a bridge and walls) are
streamed per match and aren't in that navmesh. They are why a refused
teleport is retried and then left be (the fighter stays at its start), and
they are in-game check 4 below.

### HUD and menus

- `SDR|` messages carry the team size as a 7th field
  (`SDR|S|round|you|rival|kit|N`). Older HUDs ignore it. ShowdownHud.js shows
  "SHOWDOWN NvN" and "YOUR TEAM w — l RIVALS".
- In team Showdown your death never ends the match on its own. It shows "YOU
  ARE DOWN", no death screen and no result, until the series ends:
  - Lost: the held death is shown and posted, after clearing hud.js's "wait
    for the team" state.
  - Won: the game's victory is posted, or after 4 s your held stats as a
    victory (Rank 1).
- A reset brings back the extra teammate panels (`remasterExtraMates.youDied`).
- `TMS|` reports the extra teammates for N >= 3, as in Trios.
- Menu (Showdown.js): the SHOWDOWN tile opens a size card with
  1V1/2V2/3V3/4V4 (the last pick is kept in localStorage, falling back to 1v1),
  PLAY and BACK. It queues `showdown`, `showdown_duo`, `showdown_trio` or
  `showdown_quad`.
- ClientWeb.js `RemasterShowdownURL`: `showdown:1v1` (or `:1`) opens the arena
  URL, and `showdown:<n>` (or `:<n>v<n>`, n 2-4) opens the arena URL with
  `?TeamSize=n` (`make_showdown.TEAM_URLS`). Anything else is an error.
- MatchLobby.js titles the lobby "Showdown 2v2" and so on, with YOUR TEAM and
  OPPONENTS rows.

### Server

- playlists.js: `showdown_duo/trio/quad` are enabled, and `maxParty` = team size.
- A team Showdown queue goes through a lobby, as every party queue does. The
  lobby holds one team: `maxPlayers` = N, so a full party counts down at once.
  It has no map vote and shows the match's 2N - 1 bots (matchlobby.js
  per-queue `queues` options).
- Every member gets the same match id and `showdown:<N>`, and their own series
  (`startSeries(user, { mode, teamSize })`), started when the match is
  launched.
- The economy per series is unchanged (seriesPayout's XP and credits don't
  depend on the size). The kills bound is N per round won.
- Records: 1v1 stays under `profile.showdown`, and team series go under
  `profile.showdownTeams[showdown_duo|trio|quad]`. Player cards list
  `showdownTeams`.
- Friends see "In match · Showdown Duos round 3".

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
12b. Showdown 1v1 with the new arena starts: both fighters start at the old
    spots (you west at (-1800, 0) facing east, the rival east facing west),
    every round. The first second of a match may show a spawn north or south
    before the move. No stuck or falling fighter.

### Team Showdown (branch `team-showdown`, pin `c4b6f753`)

1. SHOWDOWN tile: the size card shows 1V1 2V2 3V3 4V4, PLAY and BACK.
   Mouse, keyboard and controller (D-pad, Select, Back) all work. The size
   is remembered after a restart of the game. BACK returns to the Play
   screen.
2. 2V2 solo: a lobby "Showdown 2v2" with YOUR TEAM (you + 1 TEAMMATE),
   OPPONENTS, "2 teams" and no map vote. Then the arena.
3. In the match: 3 bots. You and one teammate on the west side, side by side
   (160 apart), facing in. Two rivals on the east. At the start and after
   every reset. No fighter inside another, in a wall, or falling from
   height. The first second may show the north/south spawn.
4. Each centre config (bridge, rings, walls; look at several matches): no
   side spot blocked. If one is blocked, that fighter stays at its
   north/south start for the round (the log has no crash). Report which
   config.
5. The rival team attacks your team. Your teammate doesn't attack you or
   fight the other teammate. Everyone has the round's kit (same weapon,
   armor on, boost).
6. Your death with your teammate alive: no death screen, "YOU ARE DOWN",
   the round goes on. Your teammate winning it gives "ROUND n WON". The next
   round you are back (HUD shown, extra panels back in 3v3/4v4).
7. Teammate panel: the game's panel shows your teammate in round 1 and
   again after every reset (new pawn, health moving). "X is your Teammate!"
   shows only once. In 3v3/4v4 the `TMS|` extra panels show every round
   (the game log has "Remaster teammates: TMS|...").
8. Score: the panel and banners say "SHOWDOWN 2V2" and "YOUR TEAM w — l
   RIVALS". First to 4. A team wipe ends a round; one fighter down doesn't.
9. Series lost while you are already dead (your teammate is the last down):
   the death screen shows then, and the result posts once. Series won while
   you are dead: VICTORY (or "Result saved" within ~4 s) and the payout
   once.
10. 3V3 and 4V4: 5 and 7 bots, 3 or 4 a side, side by side, all on the floor.
11. Party of 2 queues 2V2: one lobby with both, both start their own arena
    match with the same match id (server log `match-ready -> ... showdown
    2v2`). A party of 3 is refused 2V2 ("takes parties of up to 2") and
    accepted for 3V3 and 4V4.
12. Menu after the series: the card says "SHOWDOWN 2V2 · FIRST TO 4", "YOUR
    TEAM 4 — n RIVALS". PLAY AGAIN queues 2V2 again. The profile has
    `showdownTeams.showdown_duo`. Friends see "In match · Showdown Duos round
    n".
13. 1v1 regression (check 12 and 12b above), and Duo, Trios and Quads
    unchanged (the module's ClassicTeams code is untouched).

### Team Showdown static verification (2026-11-05)

| Check | Result |
|---|---|
| `python build_showdown_rounds.py --check` (27732 bytes) | PASS |
| `python test_native_module.py` | PASS: 1v1 and 2v2/3v3/4v4 series, spots per side (1v1 the old starts; team 1 west, team 2 east, 160 apart, facing in, controller rotation), again after every reset, sides by team number, refused teleport / late pawn retried for 3 ticks, never moved twice, HUD +0x654 re-armed only in team resets, `SDR|...|N`, `?TeamSize=` 5-8 plays 4v4 with 7 bots |
| `test_native_module.py`: game addresses from the stock exe | PASS: ControlRotation +0x430 registered next to Pawn +0x408 and PlayerState +0x420. The HUD tick tests +0x654 and sets it once (the only `mov byte [..+0x654], 1` in .text). The blob uses both and K2_TeleportTo |
| Mutation check: 6 mutants of the new code (side swap, spacing, no HUD re-arm, no control rotation, re-teleporting, no retries) | PASS: each caught |
| `python test_unstick_native.py`, `python test_weather_native.py` | PASS |
| `python test_make_showdown.py` | PASS: Jungle_P keeps its size, names, imports and exports; only the 8 starts' location and rotation bytes change; it re-saves byte for byte and a second pass is a no-op. The game mode, pawn and perk packages re-save and their imports resolve. 22 starts and spots are on the navmesh floor, 150+ apart. The C constants match make_showdown's |
| `python test_patch_exe.py <copy of stock Victory.exe>` | PASS |
| `python patch_exe.py --hash` | PATCHED_SHA256 `c4b6f75364efed888c66d959bab539152668d64f1dec3f31dc91b1afe6b2871b` |
| `python test_match_urls.py` (RemasterShowdownURL run in node: 14 inputs) | PASS |
| `node test_showdown_hud.js`, `node test_team_hud.js`, `node test_showdown_menu.js` | PASS |
| `python lint_es5.py` on Showdown.js, MatchLobby.js and ShowdownHud.js (whole files), and ClientWeb.js (`--diff origin/audit-combined`) | PASS |
| Server: playlists, showdown, party, matchlobby, matchqueue, friends, audit and the rest of `server/test` | PASS |
| In game | NOT TESTED |

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
