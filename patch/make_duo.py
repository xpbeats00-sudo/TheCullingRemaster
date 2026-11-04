"""Duo with a teammate: you and an AI teammate against pairs.

The stock Duo queue started the same match as Solo. The game's pairs mode,
VictoryGameMode_CoopRanked (a child of VictoryGameMode: pair-balanced spawns,
team type ClassicTeams; unused by the Remaster), pairs contestants, and the
normal mode's bot count and names carry over.

Match URLs come from DefaultGame.ini, and the game can only start a few of
them: StartOfflineMatch(0|1) is Solo, StartTraining("Practice") is Showdown,
so Duo takes the two Survival slots (StartTraining("SurvivalBasic") Jungle,
"SurvivalAdvanced" Prison) and the SURVIVAL menu item goes
(make_branding.py). make_loading_bar.py writes the URLs; the server answers a
Duo queue with "duo:<map>" and ClientWeb.js picks the slot.
"""

MODE = "/Game/Blueprints/GameMode/VictoryGameMode_CoopRanked.VictoryGameMode_CoopRanked_C"
# DefaultGame.ini key -> URL
URLS = {
    "SurvivalBasic": "Jungle_P?bEnableBots=true?game=" + MODE,
    "SurvivalAdvanced": "Jungle2_P?bEnableBots=true?game=" + MODE,
}


def set_urls(text):
    """DefaultGame.ini text with the Duo URLs in the Survival keys."""
    lines = text.splitlines(keepends=True)
    for key, url in URLS.items():
        for k, line in enumerate(lines):
            if line.split("=")[0].strip() == key:
                lines[k] = '%s = "%s"%s' % (key, url, line[len(line.rstrip("\r\n")):])
                break
        else:
            raise KeyError(key)
    return "".join(lines)


if __name__ == "__main__":
    import os
    path = os.path.join(os.path.dirname(os.path.abspath(__file__)), "src", "Victory", "Config", "DefaultGame.ini")
    text = open(path, newline="").read()
    open(path, "w", newline="").write(set_urls(text))
    print("duo URLs ->", path)
