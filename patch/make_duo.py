"""Duo with a teammate: you and an AI teammate against pairs; Trios and Quads
the same with two or three AI teammates.

The game's pairs mode, VictoryGameMode_CoopRanked (a child of VictoryGameMode:
pair-balanced spawns, team type ClassicTeams; unused by the Remaster), pairs
contestants, and the normal mode's bot count and names carry over.

How it starts: the server answers a Duo queue with "duo:<map>" and ClientWeb.js
calls the menu's StartTraining(URLS[map]). StartTraining only knows four slot
names; the patched exe (patch_exe.py) opens any other argument as the URL,
through the same "open <url>?bExitOnRoundComplete=true" helper the Solo path
uses (VA 0x1401e4630). (ConnectToServer, which also runs "open", was tried
first: it puts the game in its join-a-server state and the match bounces back
to the menu.)

Duo has its own URL this way and needs no DefaultGame.ini slot: the six slots
the menu can reach (OfflineMap/OfflineMap2 for Solo, TrainingMapBasic,
TrainingMapAdvanced, SurvivalBasic, SurvivalAdvanced for the SURVIVAL screen's
Tutorial, Training Range and Survival) keep their stock maps.

ClientWeb.js holds a copy of URLS (it can't import this file);
test_match_urls.py checks they match.
"""

MODE = "/Game/Blueprints/GameMode/VictoryGameMode_CoopRanked.VictoryGameMode_CoopRanked_C"
# Map index (0 Jungle, 1 Prison, as in "duo:<map>") -> the URL StartTraining opens (patched exe).
URLS = {
    0: "Jungle_P?bEnableBots=true?game=" + MODE,
    1: "Jungle2_P?bEnableBots=true?game=" + MODE,
}

# Trios and Quads: the same mode with ?TeamSize=N. The patched exe reads it
# from the match URL (showdown_rounds.c sd_teams: contestants are teamed by
# PlayerArray index / N; 24 contestants make 8 trios or 6 quads), so you get
# N - 1 AI teammates. The server answers a Trios queue (coop3) with
# "trio:<map>", Quads (coop4) with "quad:<map>" (server/server.js TEAM_MODES).
TEAM_SIZES = (3, 4)
TEAM_URLS = {n: {m: url + "?TeamSize=%d" % n for m, url in URLS.items()} for n in TEAM_SIZES}
