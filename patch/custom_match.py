"""CUSTOM matches: the map and the stock custom-match settings, applied.

How the stock game applied them (Victory.exe, cooked Blueprints):

- AShooterGameMode::InitGame (the option parsing at VA 0x140233b00, the
  "mods" part at 0x140234759) reads the URL option ?mods=<index>=<value>|...:
  the value is split on "|", each entry on "=", both sides go through atoi,
  and GameModeMods[index].value is set when GameModeMods[index].type ==
  index. GameModeMods (AShooterGameMode +0x588) is an array of
  GameModeModEntry {EGameModeMod type; int32 value}. The index is not
  bounds-checked against the array, so only the indexes below may ever be
  sent (the client and the server both refuse anything else).
- VictoryGameMode's CDO holds the 18-entry array (EGameModeMod 0..17, in
  order); its children (VictoryGameMode_Custom, VictoryGameMode_CoopRanked...)
  inherit it. The values in MODS are those CDO values.
- The Blueprints read them with ShooterGameMode.GetGameModeMod (nothing
  native does): Jungle_P / Jungle2_P level scripts (0-6: the crate, barrel,
  pylon and toilet spawns, through LevelFunctions.GameModeModSetter),
  MasterLootManager (7-12: building item spawns, the extra green crate and
  pre-opened locker chances), MedStation (13-15: health given, its FUNC cost,
  how often) and FuncRecycler (16: use time). So every setting the stock
  CUSTOM MATCH SETTINGS screen shows takes effect.
- 17 (eStartingActivityValue) is not on the stock screen and is never sent.
- The stock native CustomMatchController (Increment* engine calls) is a stub
  in the shipped exe: every Increment* handler is the same empty function
  (VA 0x1411d9e00), and the stock IncrementGameType has no control on the
  page. CustomMatchSettings.js keeps the values itself.

Game mode: VictoryGameMode, the mode Solo plays (DefaultGame.ini OfflineMap /
OfflineMap2), with ?mods=. VictoryGameMode_Custom only differs by
GameModeType=Custom and an empty StatsToUpdate, neither of which the
Remaster needs, so a CUSTOM match is a Solo match with the lobby's settings.

The flow: the CUSTOM screen sends the settings (lobby-set-mods), START asks
the server (lobby-start-match), the server answers match-ready with
"custom:<map>:<mods>" (game_server() below) and ClientWeb.js builds url()
and opens it with StartTraining(url) (patched exe, patch_exe.py fix 3), like
Duo and Showdown. server/custommatch.js and ClientWeb.js hold copies of MODS
and URLS; test_custom_match.py checks they match.
"""

MODE = "/Game/Blueprints/GameMode/VictoryGameMode.VictoryGameMode_C"
# Map index (0 Jungle, 1 Prison, as in "custom:<map>:...") -> the base URL (Solo's).
URLS = {
    0: "Jungle_P?bEnableBots=true?game=" + MODE,
    1: "Jungle2_P?bEnableBots=true?game=" + MODE,
}
# The stock screen's maps (Custom.js availableMaps) -> map index.
MAP_NAMES = {"Jungle/Jungle_P": 0, "Jungle2/Jungle2_P": 1}

# EGameModeMod index -> (the CUSTOM MATCH SETTINGS key, stock value, min, max).
MODS = [
    ("NumGreenCrateSpawn", 12, 0, 200),
    ("NumBlueCrateSpawn", 24, 0, 200),
    ("NumRedCrateSpawn", 3, 0, 200),
    ("NumRedBarrelSpawn", 15, 0, 200),
    ("NumGasPylonSpawn", 22, 0, 200),
    ("NumFuncBarrelSpawn", 15, 0, 200),
    ("NumToiletGoodiesSpawn", 5, 0, 200),
    ("NumSmallBuildingItemSpawn", 2, 0, 200),
    ("NumMediumBuildingItemSpawn", 4, 0, 200),
    ("NumLargeBuildingItemSpawn", 8, 0, 200),
    ("NumExtraLargeBuildingItemSpawn", 12, 0, 200),
    ("ChancesExtraGreenCrateSpawn", 50, 0, 100),
    ("ChancesLockerPreOpened", 50, 0, 100),
    ("HealthGivenFromHealthStation", 4, 0, 100),
    ("FuncCostForHealth", 1, 0, 100),
    # A health station waits this long between heals (Delay); 0 would heal every frame.
    ("FreqHealthGivenInSeconds", 1, 1, 60),
    ("RecyclerUseTime", 5, 1, 60),
]
# The cooked enum names, in index order (for the check against the asset).
ENUM = ["eGreenCrateSpawnCnt", "eBlueCrateSpawnCnt", "eRedCrateSpawnCnt", "eRedBarrelSpawnCnt", "ePylonSpawnCnt",
        "eFuncBarrelSpawnCnt", "eToiletGoodiesCnt", "eSmallBuildingItemSpawns", "eMediumBuildingItemSpawns",
        "eLargeBuildingItemSpawns", "eExtraLargeBuildingItemSpawns", "eChanceOfAdditionalGreenCratesInBuildings",
        "eChanceOfLockersPreOpened", "eHealthGivenAmountFromHeatlhMachine", "eFuncCostForHealth",
        "eFrequencyOfHealthGivenInSeconds", "eRecylcerUseTime"]


def encode(values):
    """{key: value} -> the "<index>=<value>|..." part of "custom:<map>:<mods>":
    only the settings that differ from stock, in index order."""
    out = []
    for i, (key, default, lo, hi) in enumerate(MODS):
        v = int(values.get(key, default))
        if not lo <= v <= hi:
            raise ValueError("%s=%d is outside %d..%d" % (key, v, lo, hi))
        if v != default:
            out.append("%d=%d" % (i, v))
    return "|".join(out)


def game_server(map_index, values):
    return "custom:%d:%s" % (map_index, encode(values))


def url(map_index, mods):
    """The URL StartTraining opens for "custom:<map_index>:<mods>"."""
    return URLS[map_index] + ("?mods=" + mods if mods else "")
