/* The native module: Showdown rounds, team sizes (Duo, Trios, Quads), the
 * team's win and the Chokening's kills.
 *
 * Built by build_showdown_rounds.py (MSVC cl, no CRT) into a blob that
 * patch_exe.py places in a new section of Victory.exe. All game addresses are
 * image-relative (the exe is ASLR-enabled): the base is found from the RVA of
 * sd_self_rva, which the builder writes into the blob.
 *
 * Seven entry points:
 *
 * sd_should_end(gm) replaces AShooterGame_FreeForAll's "should the match end"
 *   virtual (vtable slot 282, VA 0x140244d30), which AShooterGameMode::Tick
 *   calls once a second while the match is InProgress. For Solo and every
 *   other mode it is the stock function. For Duo, Trios and Quads
 *   (ClassicTeams) it is the stock function, and also ends the match once
 *   every living contestant is on one team (duo_should_end, below), and in
 *   Trios and Quads it reports the teammates the game's own panel doesn't
 *   show ("TMS|", below). For Lightning (Showdown) it runs the series - 1v1,
 *   or team against team when the URL has ?TeamSize=N, N 2-8 (team
 *   Showdown: "you" is your team, the "rival" the other team, a round ends
 *   when one team has nobody standing):
 *     FIGHT    both fighters alive -> keep playing. One left (by the game's
 *              own alive records, AShooterGameState+0x468) -> the round goes
 *              to them; the HUD is told ("SDR|E|...").
 *     BETWEEN  3 ticks of black on the HUD, then RESET: every pawn is
 *              unpossessed and destroyed (corpses too), both alive records
 *              are restored, and RestartPlayer respawns both fighters at the
 *              arena starts with a fresh kit; the HUD is told ("SDR|S|...").
 *     SIDES    at the series' start and after every reset each fighter is
 *              teleported (AActor::K2_TeleportTo) to its side of the arena:
 *              you (1v1) or team 1 to the west, the rival or team 2 to the
 *              east, a team side by side (place(), below). The arena's eight
 *              PlayerStarts (make_showdown.py) are north and south, away from
 *              both sides, so a fighter the game spawned at any of them never
 *              stands on another's spot.
 *     DONE     a fighter has 4 rounds: the stock end of match (VICTORY or
 *              DEFEAT, then the menu).
 *
 * sd_teams(gs) replaces the sort call at the end of patch_exe.py fix 4's
 *   pairing stub (VA 0x14005ac50), so it runs right after the stub has paired
 *   a ClassicTeams match (SetTeamNum(ps, index / 2 + 1); the stub and its
 *   hook at the scoreboard refresh, VA 0x140203b3a, are 1.3.9's, proven in
 *   game for Duo). It re-teams only what the stub can't: a ClassicTeams match
 *   with ?TeamSize= 3-8 (Trios, Quads) and a Lightning match with ?TeamSize=
 *   2-8 (team Showdown) get SetTeamNum(ps, index / N + 1, true) over
 *   GameState.PlayerArray. N is the match URL's ?TeamSize= (the GameMode's
 *   OptionsString, +0x400). Duo (no ?TeamSize=, or 2) and every other match
 *   keep what the stub set, untouched. Then the sort. Each refresh.
 *   (The first build put sd_teams on the refresh's own call, VA 0x140203b3d,
 *   doing Duo's pairing too; in game Duo then had no teammate.)
 *
 * sd_spawn_bots(gm) replaces the GameMode's call of its bot spawner at match
 *   start (VA 0x14023330d, call 0x1402320f0). In a team Showdown match it
 *   first sets BotsToSpawn (+0x518) to 2N - 1 (your N - 1 teammates and N
 *   rivals; N at most 4, the arena's sides); every other match spawns the
 *   mode's own count. In every match it then caps the bots so each
 *   contestant has a start of its own: the mode's starts (those tagged with
 *   one of its SpawnPointTags: 16 pods on Jungle and Prison, 8 arena starts
 *   for Showdown), whole teams in Trios/Quads, minus the players. Past the
 *   free starts the game's chooser reuses a taken one, so with fix 1's 24 on
 *   16 pods, 8 contestants started in someone else's pod.
 *
 * sd_rand_exec(ctx, stack, result) replaces the native of
 *   KismetMathLibrary.RandomIntegerInRange. PlayerPawn.GetSpawnWithWeaponClasses
 *   picks the kit's melee weapon with RandomIntegerInRange(0, 6); in a
 *   Showdown match that one call (recognised by its constant arguments in the
 *   bytecode) returns the round's kit instead, so both fighters get the same
 *   weapon and it changes every 2 rounds. Every other call is untouched.
 *
 * sd_spawn_with(pawn, out, stat) replaces AShooterCharacter::SpawnStartingInventory's
 *   call of the GetSpawnWithWeaponClasses event (VA 0x140267275). The rival's
 *   pawn (BasicBot) has no such event and spawns with its own random loadout
 *   (Blueprint BeginPlay: a shuffled melee, ranged and utility list). In a
 *   Showdown match the module gives it the player's kit instead: it clears
 *   the rival's inventory and runs SpawnStartingInventory on it while this
 *   call asks the player's pawn (a PlayerPawn, whose event is the kit) for
 *   the classes - the same armor (put on), boost and the round's weapon - and
 *   then copies the player's other spawn items (the fists). At the first
 *   second of the match and after every reset. Every other call is stock.
 *
 * At each reset the fighters' inventories are cleared before their pawns go,
 * and weapons and pickups lying in the world without an owner (dropped
 * items) are destroyed.
 *
 * sd_rating(ps, activity, player, value) replaces the call of
 *   AShooterPlayerState::HandleAirDropRatingActivity in its Blueprint thunk
 *   (VA 0x140362477). The Chokening's console (BP_KillSwitch) calls it with
 *   ("PylonUse", name, 4) on its user's player state right after it has run
 *   KillSwitchActivation on every BP_GasPylon_2 (whose OnRising puts the
 *   pylon in the Rising state); a gas tank used directly passes 1. On the
 *   Chokening's call the module records every pylon that is Rising with no
 *   instigator (the ones the console just started), each with the user's
 *   controller (weak pointers: either may go away).
 *
 * sd_gas_instigator(wound) replaces AGasWound's two calls of
 *   AActor::GetInstigatorController (VA 0x1402e71e8 and 0x1402e752f), whose
 *   result is the EventInstigator of the gas's TakeDamage. A pylon gives its
 *   wound the pylon's Instigator (a tank used directly, or forced by damage,
 *   has its user's pawn; one the Chokening started has none, so its kills
 *   were "Suicide"). When the stock answer is none and the wounded character
 *   stands in a pylon the Chokening started (still not Inert), with that
 *   pylon's wound class, the answer is the Chokening's user - unless the
 *   wounded character is the user or the user's teammate (TeamNumber > 0 and
 *   equal: Duo, Trios, Quads), who keep the stock "no instigator".
 *
 * Every second sd_should_end also runs, in every mode, the weather
 * (weather.c, off without ?Weather=) and the stuck-player safety net
 * (unstick.c: the local player stuck on a perch it can't stand on, or inside
 * geometry, for 2 s while pushing a direction goes back to where it last
 * walked, or the nearest free spot, through AActor::K2_TeleportTo).
 *
 * HUD messages go through AVictoryPlayerHUD::ShowGameMessage, which the HUD
 * page receives as the ShowGameMessage event (ShowdownHud.js takes the "SDR|"
 * ones, hud.js the "TMS|" ones; neither is shown):
 *   SDR|S|<round>|<you>|<rival>|<kit>|<N>   round starts (kit 0-6)
 *   SDR|E|<round>|<you>|<rival>|<W/L/D>|<N> round over, the series goes on
 *   SDR|O|<round>|<you>|<rival>|<W/L/D>|<N> last round, the series is over
 *       N is the team size (1: 1v1); "you" and "rival" are the teams' scores.
 *   TMS|<k>{|<health %>|<stamina %>|<alive 0/1>|<name>}*k
 *       once a second in a team match of 3 or more: the teammates the game's
 *       own teammate panel doesn't show (it shows one, the first it finds:
 *       AVictoryPlayerHUD +0x658), in PlayerArray order.
 */

typedef unsigned long long u64;
typedef unsigned int u32;
typedef int i32;
typedef unsigned short u16;
typedef unsigned char u8;

unsigned __int64 __rdtsc(void);
#pragma intrinsic(__rdtsc)

/* ---------------------------------------------------------------- the game */

/* Functions (RVA = VA - 0x140000000). */
#define R_FFA_SHOULD_END 0x244d30  /* AShooterGame_FreeForAll vtable slot 282 */
#define R_RAND_EXEC      0x17f6e30 /* UKismetMathLibrary::execRandomIntegerInRange */
#define R_WEAK_GET       0x69c470  /* FWeakObjectPtr::Get */
#define R_PS_HAS_LEFT    0x249d20  /* AShooterPlayerState: +0x494 bit 0 */
#define R_PS_IS_ALIVE    0x249ca0  /* alive by the game state's records */
#define R_PS_ID          0x249040  /* the player's id (FString out) */
#define R_GS_FIND_RECORD 0x23cae0  /* record index for an id (takes the FString by value) */
#define R_STRING_RESIZE  0x1a3420  /* TArray<TCHAR>::ResizeForCopy(NewMax, PrevMax) */
#define R_HUD_MESSAGE    0x202900  /* AVictoryPlayerHUD::ShowGameMessage(FString, float) */
#define R_CLS_GAMEMODE   0x303000  /* AShooterGameMode::StaticClass (package name) */
#define R_CLS_PC         0x303820  /* AShooterPlayerController */
#define R_CLS_AI         0x302b20  /* AShooterAIController */
#define R_CLS_PS         0x3039c0  /* AShooterPlayerState */
#define R_CLS_CHARACTER  0x302cc0  /* AShooterCharacter */
#define R_CLS_HUD        0x3046c0  /* AVictoryPlayerHUD */
#define R_PKG_VICTORY    0x2567aa0 /* L"/Script/Victory" */
#define R_SPAWN_WITH     0x30a460  /* the GetSpawnWithWeaponClasses event (pawn, TArray<UClass*> out, stat) */
#define R_START_INVENTORY 0x267090 /* AShooterCharacter::SpawnStartingInventory */
#define R_CLEAR_INVENTORY 0x268fa0 /* AShooterCharacter: destroy every inventory item */
#define R_SPAWN_WEAPON   0x27a810  /* AShooterCharacter::SpawnWeapon(UClass*) */
#define R_ACTORS_OF_CLASS 0x1336ca0 /* UGameplayStatics::GetAllActorsOfClass(ctx, class, TArray out) */
#define R_FREE           0x50c510  /* FMemory::Free */
#define R_CLS_WEAPON     0x303d00  /* AShooterWeapon */
#define R_CLS_PICKUP     0x3034e0  /* AShooterPickup */
#define R_INSTIGATOR_CTRL 0x1119150 /* AActor::GetInstigatorController (Instigator ? its Controller : 0) */
#define R_RATING         0x2494d0  /* AShooterPlayerState::HandleAirDropRatingActivity(FString, FString, int32) */
#define R_CLS_PYLON      0x302980  /* APylon */
#define R_WEAK_SET       0x69c2a0  /* FWeakObjectPtr::operator=(const UObject *) */
#define R_SET_TEAM       0x24e7e0  /* AVictoryPlayerState::SetTeamNum(int32, bool) */
#define R_SORT_SCORES    0x243c80  /* AVictoryGameState::BuildSortedScoreboard */
#define R_SPAWN_BOTS     0x2320f0  /* AVictoryGameMode: spawn BotsToSpawn bots (match start) */
#define R_FNAME          0x5b0e60  /* FName::FName(this, const TCHAR *, EFindName) -> this */
#define R_HEALTH         0x262d20  /* health component (pawn +0x830): health */
#define R_MAX_HEALTH     0x2634c0  /* health component: max health */
#define R_STAMINA        0x28ee40  /* stamina component (pawn +0x828): stamina */
#define R_MAX_STAMINA    0x28f9c0  /* stamina component: max stamina */

/* Virtual functions (byte offsets in the vtable). */
#define V_GET_WORLD      0x120     /* UObject::GetWorld */
#define V_RESTART_PLAYER 0x700     /* AGameModeBase::RestartPlayer(AController*) */
#define V_UNPOSSESS      0x650     /* AController::UnPossess */
#define V_DESTROY        0x290     /* AActor::K2_DestroyActor */

/* Fields. */
#define O_CLASS        0x10        /* UObjectBase::ClassPrivate */
#define O_CHAIN        0x88        /* UStruct base chain: array, then count - 1 */
#define GM_TYPE        0x4e0       /* EVictoryGameMode (byte) */
#define GM_GAMESTATE   0x458
#define GS_ELAPSED     0x4e8       /* seconds InProgress, counts up */
#define GS_RECORDS     0x468       /* player records, 0x150 bytes each */
#define GS_NUM_RECORDS 0x470
#define REC_SIZE       0x150
#define REC_ALIVE      0x28
#define W_AUTH_GM      0xf0        /* UWorld::AuthorityGameMode */
#define W_CONTROLLERS  0x178       /* UWorld controller list (weak pointers) */
#define W_PAWNS        0x198       /* UWorld pawn list (weak pointers) */
#define A_OWNER        0x98        /* AActor::Owner */
#define CH_INVENTORY   0xd30       /* AShooterCharacter inventory (TArray<AShooterWeapon*>) */
#define CH_KIT_GIVEN   0xcf1       /* set by SpawnStartingInventory */
#define C_PAWN         0x408
#define C_PLAYERSTATE  0x420
#define PC_HUD         0x490
#define PS_FLAGS       0x42c       /* bit 0 spectator, bit 1 only spectator */
#define F_OBJECT       0x18        /* FFrame::Object */
#define F_CODE         0x20        /* FFrame::Code */
#define GM_NO_END      0x74d       /* while set, the stock check never ends the match */
#define GS_PLAYERS     0x418       /* AGameState::PlayerArray */
#define GS_NUM_PLAYERS 0x420
#define PS_TEAM        0x490       /* VictoryPlayerState TeamNumber (GetTeamNum) */
#define PS_CONTESTANT  0x5b4       /* the stock check counts only these */
#define REC_PS         0x10        /* player record: the player state */
#define REC_TEAM       0x40        /* player record: the team (SetTeamNum writes it) */
#define A_INSTIGATOR   0x150       /* AActor::Instigator */
#define P_CONTROLLER   0x438       /* APawn::Controller */
#define PY_STATE       0x480       /* APylon::PylonState (EPylonState) */
#define PY_IN_AREA     0x488       /* APylon::PlayersInDangerArea (TArray<AShooterCharacter *>) */
#define PY_WOUND_CLASS 0x438       /* APylon::WoundClass */
#define GM_OPTIONS     0x400       /* AGameModeBase::OptionsString (the URL's options) */
#define GM_BOTS        0x518       /* AVictoryGameMode::BotsToSpawn */
#define GM_STARTS      0x490       /* the level's PlayerStarts (TArray<APlayerStart *>) */
#define GM_SPAWN_TAGS  0x4e8       /* AVictoryGameMode::SpawnPointTags (TArray<FString>) */
#define GM_SPAWN_TAG   0x5e0       /* the URL's ?SpawnTag= (FString) */
#define A_TAGS         0x230       /* AActor::Tags (TArray<FName>) */
#define FNAME_ADD      1           /* EFindName, as the game's start chooser passes it */
#define MAX_SPAWN_TAGS 8
#define GS_TYPE        0x4e4       /* the game mode type, copied from GM_TYPE */
#define HUD_MATE       0x658       /* AVictoryPlayerHUD: the teammate its panel shows (weak) */
#define P_PLAYERSTATE  0x420       /* APawn::PlayerState */
#define PS_NAME        0x408       /* APlayerState::PlayerName */
#define CH_HEALTH      0x830       /* AShooterCharacter health component */
#define CH_STAMINA     0x828       /* AShooterCharacter stamina component */
#define C_CONTROL_ROT  0x430       /* AController::ControlRotation (FRotator) */
#define HUD_MATE_FOUND 0x654       /* AVictoryPlayerHUD: its teammate panel has found its pawn (set once) */

#define CLASSIC_TEAMS  2           /* EVictoryGameMode::ClassicTeams: Duo/Trios/Quads (CoopRanked) */
#define LIGHTNING      3           /* EVictoryGameMode::Lightning: Showdown */
#define PYLON_INERT    0           /* EPylonState */
#define PYLON_RISING   1
#define CHOKENING_RATING 4         /* BP_KillSwitch's HandleAirDropRatingActivity value (a tank: 1) */
#define MAX_PYLONS     128
#define ROUNDS_TO_WIN  4
#define KITS           7
#define BLACK_TICKS    3           /* seconds between a round's end and the reset */
#define GRACE_TICKS    2           /* seconds after a reset before deaths count */
#define KIT_BITS       44.0f       /* the Showdown perk's SpawnWithWeapon bits (make_showdown.KIT) */
#define DUO            2           /* ClassicTeams without ?TeamSize= */
#define MAX_TEAM       8           /* ?TeamSize= is 2-8 */
#define NAME_CHARS     20          /* a teammate's name in a TMS message */
#define SD_MAX_SIDE    4           /* team Showdown: up to 4v4 (the arena's 8 starts, 4 spots a side) */

/* The builder writes the RVA of this variable into it. */
volatile u64 sd_self_rva = 0x5344524f554e4453ULL;

typedef struct { u16 *data; i32 num; i32 max; } FString;

typedef char (*fn_bool)(u8 *);
typedef u8 *(*fn_ptr)(u8 *);
typedef void (*fn_void)(u8 *);
typedef void (*fn_void2)(u8 *, u8 *);
typedef u8 *(*fn_class)(const u16 *);
typedef FString *(*fn_id)(u8 *, FString *);
typedef i32 (*fn_find)(u8 *, FString *);
typedef void (*fn_resize)(FString *, i32, i32);
typedef void (*fn_message)(u8 *, FString *, float);
typedef void (*fn_exec)(u8 *, u8 *, void *);
typedef void *(*fn_spawn_with)(u8 *, void *, float);
typedef u8 *(*fn_spawn_weapon)(u8 *, u8 *);
typedef void (*fn_actors)(u8 *, u8 *, void *);
typedef void (*fn_free)(void *);
typedef void (*fn_set_team)(u8 *, i32, u8);
typedef char (*fn_sort)(u8 *);
typedef float (*fn_float)(u8 *);
typedef u64 *(*fn_fname)(u64 *, const u16 *, i32);
typedef struct { u8 **data; i32 num; i32 max; } PtrArray;

static u8 *B;                      /* image base */

#define AT(rva) (B + (rva))
#define FIELD(p, off, type) (*(type *)((u8 *)(p) + (off)))
#define VFN(obj, off) (*(void **)(*(u8 **)(obj) + (off)))

/* ---------------------------------------------------------------- the series */

enum { FIGHT = 1, BETWEEN = 2, DONE = 3 };

static struct {
    u8 *gm, *gs;
    i32 last_elapsed;
    i32 phase, timer, grace;
    i32 round, wins, losses;
    i32 offset, kit;
    i32 announced;
    i32 kitted;                    /* the round the rival has its kit for */
    i32 size;                      /* the team size (1: 1v1), for the HUD */
    i32 placing;                   /* ticks left to put the fighters on their sides */
    u8 *kit_target, *kit_source;   /* sd_spawn_with: the rival's pawn asks the player's */
} S;

static u16 message[256];

/* The autotest (autotest.c, only with ?RemasterAutoTest= in the match URL). */
static void at_message(const u16 *m, i32 n);
static void at_match_end(char ended);
static void at_gas(u8 *victim, u8 *by, const char *why);
static void at_note(const char *what);

static u8 *base(void) { return (u8 *)&sd_self_rva - sd_self_rva; }

static int is_a(u8 *obj, u64 class_rva)
{
    u8 *cls, *chain, *oc;
    i32 idx;
    if (!obj) return 0;
    cls = ((fn_class)AT(class_rva))((const u16 *)AT(R_PKG_VICTORY));
    if (!cls) return 0;
    chain = cls + O_CHAIN;
    idx = FIELD(chain, 8, i32);
    oc = FIELD(obj, O_CLASS, u8 *);
    if (!oc || idx > FIELD(oc, O_CHAIN + 8, i32)) return 0;
    return FIELD(oc, O_CHAIN, u8 **)[idx] == chain;
}

static u8 *world_of(u8 *obj) { return ((fn_ptr)VFN(obj, V_GET_WORLD))(obj); }

static u8 *weak_get(u8 *list, i32 i)
{
    return ((fn_ptr)AT(R_WEAK_GET))(FIELD(list, 0, u8 *) + 8 * (u64)i);
}

static i32 kit_for(i32 round) { return (S.offset + (round - 1) / 2) % KITS; }

/* A new match (or the first look at one) starts a new series. */
static void ensure(u8 *gm)
{
    u8 *gs = FIELD(gm, GM_GAMESTATE, u8 *);
    i32 elapsed = gs ? FIELD(gs, GS_ELAPSED, i32) : 0;
    if (S.gm != gm || S.gs != gs || elapsed < S.last_elapsed) {
        S.gm = gm;
        S.gs = gs;
        S.phase = FIGHT;
        S.timer = S.grace = 0;
        S.round = 1;
        S.wins = S.losses = 0;
        S.offset = (i32)(__rdtsc() % KITS);
        S.kit = kit_for(1);
        S.announced = 0;
        S.kitted = 0;
        S.placing = 0;
    }
    S.last_elapsed = elapsed;
}

static int is_fighter(u8 *c) { return is_a(c, R_CLS_PC) || is_a(c, R_CLS_AI); }

/* The two sides of a Showdown: "mine" is the player (1v1) or the player's
   team (team Showdown), "theirs" the rival or the other team. */
typedef struct { i32 mine, mine_alive, theirs, theirs_alive; u8 *pc; } Count;

static i32 team_of(u8 *c);

static void count(u8 *world, Count *n, int teams)
{
    u8 *list = world + W_CONTROLLERS;
    i32 i, num = FIELD(list, 8, i32), my_team = 0;
    n->mine = n->mine_alive = n->theirs = n->theirs_alive = 0;
    n->pc = 0;
    if (teams) {
        /* The teams are sd_teams'; none yet (before its first refresh): no
           sides yet either. */
        for (i = 0; i < num && !n->pc; i++) {
            u8 *c = weak_get(list, i);
            if (c && is_a(c, R_CLS_PC)) { n->pc = c; my_team = team_of(c); }
        }
        if (my_team <= 0) return;
    }
    for (i = 0; i < num; i++) {
        u8 *c = weak_get(list, i), *ps;
        int pc, alive, mine;
        if (!c) continue;
        pc = is_a(c, R_CLS_PC);
        if (!pc && !is_a(c, R_CLS_AI)) continue;
        ps = FIELD(c, C_PLAYERSTATE, u8 *);
        if (!is_a(ps, R_CLS_PS) || (FIELD(ps, PS_FLAGS, u32) & 2)) continue;
        /* Alive: has a pawn, hasn't left, and the game state's record says so
           (AShooterGameState::PlayerDied clears it when the game's Killed
           runs). */
        alive = FIELD(c, C_PAWN, u8 *) != 0
            && !((fn_bool)AT(R_PS_HAS_LEFT))(ps) && ((fn_bool)AT(R_PS_IS_ALIVE))(ps);
        if (pc) n->pc = c;
        mine = teams ? FIELD(ps, PS_TEAM, i32) == my_team : pc;
        if (mine) { n->mine++; n->mine_alive += alive; }
        else { n->theirs++; n->theirs_alive += alive; }
    }
}

static void put(i32 *at, u16 ch)
{
    if (*at < (i32)(sizeof(message) / sizeof(message[0])) - 1) message[(*at)++] = ch;
}

static void put_int(i32 *at, i32 v)
{
    if (v < 0) v = 0;
    if (v >= 100) put(at, (u16)('0' + v / 100 % 10));
    if (v >= 10) put(at, (u16)('0' + v / 10 % 10));
    put(at, (u16)('0' + v % 10));
}

/* message[0..n) (n counts its closing 0) to the player's HUD. */
static void send(u8 *pc, i32 n)
{
    u8 *hud;
    FString s;
    i32 i;
    if (!pc) return;
    at_message(message, n);
    hud = FIELD(pc, PC_HUD, u8 *);
    if (!is_a(hud, R_CLS_HUD)) return;
    s.data = 0;
    s.num = n;
    s.max = 0;
    ((fn_resize)AT(R_STRING_RESIZE))(&s, n, 0);
    if (!s.data) return;
    for (i = 0; i < n; i++) s.data[i] = message[i];
    ((fn_message)AT(R_HUD_MESSAGE))(hud, &s, 0.0f);   /* takes the string */
}

/* "SDR|<ev>|<round>|<you>|<rival>|<x>|<N>" to the player's HUD. */
static void tell(u8 *pc, u16 ev, i32 round, i32 wins, i32 losses, u16 x)
{
    i32 n = 0;
    put(&n, 'S'); put(&n, 'D'); put(&n, 'R'); put(&n, '|');
    put(&n, ev); put(&n, '|');
    if (round >= 10) put(&n, (u16)('0' + round / 10 % 10));
    put(&n, (u16)('0' + round % 10)); put(&n, '|');
    put(&n, (u16)('0' + wins % 10)); put(&n, '|');
    put(&n, (u16)('0' + losses % 10)); put(&n, '|');
    put(&n, x);
    put(&n, '|');
    put(&n, (u16)('0' + (S.size > 0 && S.size < 10 ? S.size : 1)));
    put(&n, 0);
    send(pc, n);
}

/* The player's record in the game state says alive again. */
static void revive(u8 *gs, u8 *ps)
{
    FString id;
    i32 i;
    id.data = 0;
    id.num = id.max = 0;
    ((fn_id)AT(R_PS_ID))(ps, &id);
    i = ((fn_find)AT(R_GS_FIND_RECORD))(gs, &id);    /* takes the string */
    if (i >= 0 && i < FIELD(gs, GS_NUM_RECORDS, i32))
        FIELD(gs, GS_RECORDS, u8 *)[(u64)i * REC_SIZE + REC_ALIVE] = 1;
    FIELD(ps, PS_FLAGS, u32) &= ~1u;
}

static u8 *pawn_of(u8 *c) { return c ? FIELD(c, C_PAWN, u8 *) : 0; }

static int holds(u8 *pawn, u8 *cls)
{
    i32 i, num = FIELD(pawn, CH_INVENTORY + 8, i32);
    u8 **items = FIELD(pawn, CH_INVENTORY, u8 **);
    for (i = 0; i < num; i++)
        if (items[i] && FIELD(items[i], O_CLASS, u8 *) == cls) return 1;
    return 0;
}

/* The rival gets the player's kit: its own loadout goes, then the game's
   own spawn-with inventory runs on it with the player's kit classes, then
   it gets any other spawn item the player holds (the fists). */
static int kit_rival(u8 *world)
{
    u8 *list = world + W_CONTROLLERS, *player = 0;
    i32 i, j, num = FIELD(list, 8, i32);
    int done = 0;
    for (i = 0; i < num && !player; i++) {
        u8 *c = weak_get(list, i);
        if (c && is_a(c, R_CLS_PC)) player = pawn_of(c);
    }
    if (!player || !is_a(player, R_CLS_CHARACTER)) return 0;
    for (i = 0; i < num; i++) {
        u8 *c = weak_get(list, i), *bot;
        u8 **items;
        i32 n;
        if (!c || !is_a(c, R_CLS_AI)) continue;
        bot = pawn_of(c);
        if (!bot || bot == player || !is_a(bot, R_CLS_CHARACTER)) continue;
        ((fn_void)AT(R_CLEAR_INVENTORY))(bot);
        FIELD(bot, CH_KIT_GIVEN, u8) = 0;
        S.kit_target = bot;
        S.kit_source = player;
        ((fn_void)AT(R_START_INVENTORY))(bot);
        S.kit_target = S.kit_source = 0;
        items = FIELD(player, CH_INVENTORY, u8 **);
        n = FIELD(player, CH_INVENTORY + 8, i32);
        for (j = 0; j < n; j++) {
            u8 *cls = items[j] ? FIELD(items[j], O_CLASS, u8 *) : 0;
            if (cls && !holds(bot, cls)) ((fn_spawn_weapon)AT(R_SPAWN_WEAPON))(bot, cls);
        }
        done = 1;
    }
    return done;
}

/* Weapons and pickups in the world with no owner: dropped items. */
static void clear_dropped(u8 *gm)
{
    u64 classes[2];
    i32 k, i;
    classes[0] = R_CLS_WEAPON;
    classes[1] = R_CLS_PICKUP;
    for (k = 0; k < 2; k++) {
        PtrArray found;
        u8 *cls = ((fn_class)AT(classes[k]))((const u16 *)AT(R_PKG_VICTORY));
        if (!cls) continue;
        found.data = 0;
        found.num = found.max = 0;
        ((fn_actors)AT(R_ACTORS_OF_CLASS))(gm, cls, &found);
        for (i = 0; i < found.num; i++) {
            u8 *a = found.data[i];
            if (a && !FIELD(a, A_OWNER, u8 *)) ((fn_void)VFN(a, V_DESTROY))(a);
        }
        if (found.data) ((fn_free)AT(R_FREE))(found.data);
    }
}

/* Everybody back to the start: no pawns, no corpses, both alive, respawned. */
static void reset(u8 *gm, u8 *world)
{
    u8 *list = world + W_CONTROLLERS, *pawns = world + W_PAWNS;
    u8 *gs = FIELD(gm, GM_GAMESTATE, u8 *);
    i32 i, pass, num = FIELD(list, 8, i32);
    for (i = 0; i < num; i++) {
        u8 *c = weak_get(list, i), *p;
        if (!c || !is_fighter(c)) continue;
        p = FIELD(c, C_PAWN, u8 *);
        if (!p) continue;
        if (is_a(p, R_CLS_CHARACTER)) ((fn_void)AT(R_CLEAR_INVENTORY))(p);
        ((fn_void)VFN(c, V_UNPOSSESS))(c);
        ((fn_void)VFN(p, V_DESTROY))(p);
    }
    /* Corpses and anything else that is a character (backwards: destroying
       takes it out of the list). */
    for (i = FIELD(pawns, 8, i32) - 1; i >= 0; i--) {
        u8 *p = weak_get(pawns, i);
        if (p && is_a(p, R_CLS_CHARACTER)) ((fn_void)VFN(p, V_DESTROY))(p);
    }
    clear_dropped(gm);
    /* The player first, then the rival: each takes a free arena start. */
    for (pass = 0; pass < 2; pass++) {
        num = FIELD(list, 8, i32);
        for (i = 0; i < num; i++) {
            u8 *c = weak_get(list, i), *ps;
            if (!c || !is_a(c, pass ? R_CLS_AI : R_CLS_PC)) continue;
            ps = FIELD(c, C_PLAYERSTATE, u8 *);
            if (!is_a(ps, R_CLS_PS)) continue;
            if (gs) revive(gs, ps);
            ((fn_void2)VFN(gm, V_RESTART_PLAYER))(gm, c);
        }
    }
}

/* ---------------------------------------------------------------- team sizes */

/* The match URL's ?TeamSize= (UE's option syntax: "?Key=Value", the key in
   any case), from the GameMode's OptionsString; 0 when absent or not 2-8. */
static i32 url_team_size(u8 *gm)
{
    static const u16 KEY[] = { 't', 'e', 'a', 'm', 's', 'i', 'z', 'e', '=' };
    FString *o = gm ? (FString *)(gm + GM_OPTIONS) : 0;
    i32 i, k, n, v;
    if (!o || !o->data) return 0;
    n = o->num;
    for (i = 0; i + 10 < n; i++) {
        if (o->data[i] != '?') continue;
        for (k = 0; k < 9; k++) {
            u16 ch = o->data[i + 1 + k];
            if (ch >= 'A' && ch <= 'Z') ch = (u16)(ch + 32);
            if (ch != KEY[k]) break;
        }
        if (k < 9) continue;
        v = 0;
        for (k = i + 10; k < n && o->data[k] >= '0' && o->data[k] <= '9' && v <= MAX_TEAM; k++)
            v = v * 10 + (o->data[k] - '0');
        if (k < n && o->data[k] && o->data[k] != '?') return 0;      /* "3x": not a number */
        return v >= 2 && v <= MAX_TEAM ? v : 0;
    }
    return 0;
}

/* The match URL has the option exactly ("?TeamDebug=1", the key in any case,
   then the next option or the end). opt is lower case. */
static int url_flag(u8 *gm, const char *opt)
{
    FString *o = gm ? (FString *)(gm + GM_OPTIONS) : 0;
    i32 i, k, n;
    if (!o || !o->data) return 0;
    n = o->num;
    for (i = 0; i < n; i++) {
        if (o->data[i] != '?') continue;
        for (k = 0; opt[k] && i + 1 + k < n; k++) {
            u16 ch = o->data[i + 1 + k];
            if (ch >= 'A' && ch <= 'Z') ch = (u16)(ch + 32);
            if (ch != (u16)opt[k]) break;
        }
        if (opt[k]) continue;
        k += i + 1;
        if (k >= n || !o->data[k] || o->data[k] == '?') return 1;
    }
    return 0;
}

/* Team Showdown's size: ?TeamSize= 2-8, at most SD_MAX_SIDE (the arena's
   sides hold 4 each); 0 without it (1v1). */
static i32 showdown_size(u8 *gm)
{
    i32 n = url_team_size(gm);
    return n > SD_MAX_SIDE ? SD_MAX_SIDE : n;
}

/* The team size of a match (gm, its game state's mode type): ClassicTeams
   2-8 (?TeamSize=, else Duo's 2), Lightning only with ?TeamSize= (team
   Showdown, 2-4), 0 = no teams (Solo, 1v1 Showdown and the rest). */
static i32 team_size(u8 *gm, u8 type)
{
    i32 n = url_team_size(gm);
    if (type == CLASSIC_TEAMS) return n ? n : DUO;
    if (type == LIGHTNING) return showdown_size(gm);
    return 0;
}

/* One pod each in the team modes. AShooterGame_FreeForAll's start chooser
   (vtable slot 189, VA 0x140244740) asks the contestant's TeamNumber
   (AVictoryPlayerState::GetTeamNum, VA 0x140249320, its call at VA
   0x1402447ff) and, for a team other than 0, gives it the start its team got
   first (the TMap<int32, APlayerStart*> at GameMode +0x7a0), and records the
   team's start when bSpawnPairTogether (+0x799) or bSpawnPairBalanced
   (+0x79a) is set; IsSpawnpointAllowed (vtable +0x8d8, VA 0x1402450f0)
   refuses another contestant any start in that map. The teams a ClassicTeams
   match has while it spawns (in the pods, the bots in one batch) are not its
   final ones: fix 4's stub and sd_teams set those at the scoreboard refresh.
   So two contestants of different final teams shared a pod (seen in game by
   patch/autotest in Duo: a rival on the player's mate's start, one start
   empty). In a ClassicTeams match the chooser now sees team 0, as in Solo:
   every contestant gets a free start of its own (sd_spawn_bots caps them at
   the starts), the map stays empty, and teammates start apart (their team is
   set before the pods open). Every other mode keeps the stock team. */
#define R_GET_TEAM     0x249320    /* AVictoryPlayerState::GetTeamNum (reads +0x490) */
#define GM_PAIR_TEAMS  0x798       /* AShooterGame_FreeForAll::bPairTeams */
#define GM_PAIR_SPAWN  0x799       /* bSpawnPairTogether: record the team's start */
#define GM_PAIR_BALANCED 0x79a     /* bSpawnPairBalanced */
#define GM_TEAM_STARTS 0x7a0       /* TMap<int32, APlayerStart*> team -> start (num at +0x7a8) */
typedef i32 (*fn_int)(u8 *);
static void at_spawn_team(u8 *gm, u8 *ps, i32 team, i32 given);

i32 sd_spawn_team(u8 *ps)
{
    u8 *world, *gm;
    i32 team;
    B = base();
    team = ((fn_int)AT(R_GET_TEAM))(ps);
    world = ps ? world_of(ps) : 0;
    gm = world ? FIELD(world, W_AUTH_GM, u8 *) : 0;
    if (gm && is_a(gm, R_CLS_GAMEMODE) && FIELD(gm, GM_TYPE, u8) == CLASSIC_TEAMS) {
        at_spawn_team(gm, ps, team, 0);
        return 0;
    }
    if (gm) at_spawn_team(gm, ps, team, team);
    return team;
}

char sd_teams(u8 *gs)
{
    u8 *world, *gm = 0, **players, type;
    i32 size, i, n;
    B = base();
    type = gs ? FIELD(gs, GS_TYPE, u8) : 0;
    if (type == CLASSIC_TEAMS || type == LIGHTNING) {
        world = world_of(gs);
        gm = world ? FIELD(world, W_AUTH_GM, u8 *) : 0;
        size = type == LIGHTNING ? showdown_size(gm) : url_team_size(gm);
        /* Duo: fix 4's stub has paired them; only Trios/Quads and team Showdown are ours. */
        if (size > (type == CLASSIC_TEAMS ? DUO : 1)) {
            players = FIELD(gs, GS_PLAYERS, u8 **);
            n = FIELD(gs, GS_NUM_PLAYERS, i32);
            for (i = 0; i < n; i++)
                if (players[i]) ((fn_set_team)AT(R_SET_TEAM))(players[i], i / size + 1, 1);
        }
    }
    return ((fn_sort)AT(R_SORT_SCORES))(gs);
}

/* How many of the level's PlayerStarts this mode spawns at: the game's start
   chooser (AVictoryGameMode, VA 0x140231b50) takes a start only if its Tags
   hold one of the mode's SpawnPointTags (FName of each string; none listed:
   every start). Jungle and Prison have 16 SpawnsDecentral starts (the pods:
   Solo, Duo, Trios, Quads) and 8 SpawnsLightning (Showdown). 0 when it can't
   tell: the starts aren't listed yet, the URL has ?SpawnTag= (the chooser's
   other rule), or more tags than expected. */
static i32 mode_starts(u8 *gm)
{
    u8 **starts = FIELD(gm, GM_STARTS, u8 **);
    FString *tags = FIELD(gm, GM_SPAWN_TAGS, FString *);
    i32 ns = FIELD(gm, GM_STARTS + 8, i32), nt = FIELD(gm, GM_SPAWN_TAGS + 8, i32);
    i32 i, j, k, nw = 0, n = 0, hit;
    u64 want[MAX_SPAWN_TAGS], name;
    if (!starts || ns <= 0 || nt < 0 || nt > MAX_SPAWN_TAGS || FIELD(gm, GM_SPAWN_TAG + 8, i32) > 1) return 0;
    for (k = 0; k < nt; k++)
        if (tags && tags[k].data && tags[k].num > 1)
            want[nw++] = *((fn_fname)AT(R_FNAME))(&name, tags[k].data, FNAME_ADD);
    if (nt && !nw) return 0;
    for (i = 0; i < ns; i++) {
        u8 *s = starts[i];
        u64 *t;
        i32 nn;
        if (!s) continue;
        if (!nt) { n++; continue; }
        t = FIELD(s, A_TAGS, u64 *);
        nn = FIELD(s, A_TAGS + 8, i32);
        for (hit = 0, j = 0; t && j < nn && !hit; j++)
            for (k = 0; k < nw; k++)
                if (t[j] == want[k]) hit = 1;
        n += hit;
    }
    return n;
}

void sd_spawn_bots(u8 *gm)
{
    u8 *world, *list;
    i32 size, cap, room, humans = 0, i, num;
    B = base();
    if (gm && FIELD(gm, GM_TYPE, u8) == LIGHTNING && (size = showdown_size(gm)) >= 2)
        FIELD(gm, GM_BOTS, i32) = 2 * size - 1;
    /* One contestant a start. The stock spawner caps players plus bots at 16
       (patch_exe.py fix 1: 24), but only the mode's starts are free: past them
       the chooser puts each one more contestant in a random start already
       taken (its fallback list: AShooterGameMode::IsSpawnpointPreferred,
       VA 0x140234dd0, refuses a start used once), so 24 on Jungle's 16 pods
       had 8 contestants in someone else's pod. A team match takes whole teams
       (15 for Trios). */
    if (gm && (cap = mode_starts(gm)) > 0) {
        if (FIELD(gm, GM_TYPE, u8) == CLASSIC_TEAMS && (size = team_size(gm, CLASSIC_TEAMS)) > 1 && cap >= size)
            cap -= cap % size;
        if ((world = world_of(gm)) != 0) {
            list = world + W_CONTROLLERS;
            num = FIELD(list, 8, i32);
            for (i = 0; i < num; i++) {
                u8 *c = weak_get(list, i);
                if (c && is_a(c, R_CLS_PC)) humans++;
            }
        }
        room = cap > humans ? cap - humans : 0;
        if (FIELD(gm, GM_BOTS, i32) > room) FIELD(gm, GM_BOTS, i32) = room;
    }
    ((fn_void)AT(R_SPAWN_BOTS))(gm);
}

/* Trios and Quads: the game's teammate panel (AVictoryPlayerHUD tick, VA
   0x1401fbea1) shows one teammate - the first pawn it finds with your
   TeamNumber, kept at HUD +0x658 - and its status (SetTeamMemberStatus).
   The others go to the HUD page as one "TMS|" message a second. */
static struct { u8 *gm, *shown; } M;   /* the panel's teammate's player state */

static i32 percent(u8 *comp, u64 value_rva, u64 max_rva)
{
    float v, m;
    if (!comp) return 0;
    v = ((fn_float)AT(value_rva))(comp);
    m = ((fn_float)AT(max_rva))(comp);
    if (!(m > 0.0f) || !(v > 0.0f)) return 0;
    if (v >= m) return 100;
    return (i32)(100.0f * v / m + 0.5f);
}

static void report_mates(u8 *gm, u8 *world)
{
    u8 *list = world + W_CONTROLLERS, *gs = FIELD(gm, GM_GAMESTATE, u8 *);
    u8 *pc = 0, *me, *hud, *mate, **players;
    i32 i, j, k, n, at, num = FIELD(list, 8, i32), team, mates = 0;
    if (!gs) return;
    for (i = 0; i < num && !pc; i++) {
        u8 *c = weak_get(list, i);
        if (c && is_a(c, R_CLS_PC)) pc = c;
    }
    if (!pc) return;
    me = FIELD(pc, C_PLAYERSTATE, u8 *);
    hud = FIELD(pc, PC_HUD, u8 *);
    if (!is_a(me, R_CLS_PS) || !is_a(hud, R_CLS_HUD) || (team = FIELD(me, PS_TEAM, i32)) <= 0) return;
    if (M.gm != gm) { M.gm = gm; M.shown = 0; }
    mate = ((fn_ptr)AT(R_WEAK_GET))(hud + HUD_MATE);
    if (mate && FIELD(mate, P_PLAYERSTATE, u8 *)) M.shown = FIELD(mate, P_PLAYERSTATE, u8 *);
    at = 0;
    put(&at, 'T'); put(&at, 'M'); put(&at, 'S'); put(&at, '|');
    k = at;
    put(&at, '0');
    players = FIELD(gs, GS_PLAYERS, u8 **);
    n = FIELD(gs, GS_NUM_PLAYERS, i32);
    for (i = 0; i < n && mates < MAX_TEAM; i++) {
        u8 *ps = players[i], *pawn = 0;
        FString *name;
        int alive;
        if (!ps || ps == me || ps == M.shown || FIELD(ps, PS_TEAM, i32) != team) continue;
        if (FIELD(ps, PS_FLAGS, u32) & 1) continue;
        alive = !((fn_bool)AT(R_PS_HAS_LEFT))(ps) && ((fn_bool)AT(R_PS_IS_ALIVE))(ps);
        for (j = 0; j < num && !pawn; j++) {
            u8 *c = weak_get(list, j);
            if (c && FIELD(c, C_PLAYERSTATE, u8 *) == ps) pawn = FIELD(c, C_PAWN, u8 *);
        }
        if (!pawn || !is_a(pawn, R_CLS_CHARACTER)) alive = 0;
        put(&at, '|');
        put_int(&at, alive ? percent(FIELD(pawn, CH_HEALTH, u8 *), R_HEALTH, R_MAX_HEALTH) : 0);
        put(&at, '|');
        put_int(&at, alive ? percent(FIELD(pawn, CH_STAMINA, u8 *), R_STAMINA, R_MAX_STAMINA) : 0);
        put(&at, '|');
        put(&at, (u16)(alive ? '1' : '0'));
        put(&at, '|');
        name = (FString *)(ps + PS_NAME);
        for (j = 0; name->data && j < name->num && j < NAME_CHARS && name->data[j]; j++)
            put(&at, name->data[j] == '|' ? (u16)'/' : name->data[j]);
        mates++;
    }
    message[k] = (u16)('0' + mates);
    put(&at, 0);
    send(pc, at);
}

/* Debug only (the match URL has ?TeamDebug=1; no menu URL does): once a
   match, a few seconds in, a team match (Duo, Trios, Quads) says who is
   on your team as an ordinary game message: "Your team of <N>: <names>" -
   N the team size the module read from the URL, the names every contestant
   with your TeamNumber, in PlayerArray order (alive or not). It is also the
   in-game check of each link: no message means the module's HUD messages
   don't arrive (or you have no team); "of 2" in Trios means ?TeamSize= wasn't
   read; "of 3" with one name means the teams stayed pairs. */
#define ANNOUNCE_AFTER   3          /* seconds InProgress */
#define ANNOUNCE_LATEST  10         /* ... and at the latest, even with no team */
static struct { u8 *gm; i32 done; } A;

static void put_str(i32 *at, const char *s) { while (*s) put(at, (u16)*s++); }

static void announce_team(u8 *gm, u8 *world, i32 size)
{
    u8 *list = world + W_CONTROLLERS, *gs = FIELD(gm, GM_GAMESTATE, u8 *), *pc = 0, *me, **players;
    i32 i, j, n, at = 0, num = FIELD(list, 8, i32), team, elapsed, names = 0;
    if (A.gm != gm) { A.gm = gm; A.done = 0; }
    if (A.done || !gs) return;
    elapsed = FIELD(gs, GS_ELAPSED, i32);
    if (elapsed < ANNOUNCE_AFTER) return;
    for (i = 0; i < num && !pc; i++) {
        u8 *c = weak_get(list, i);
        if (c && is_a(c, R_CLS_PC)) pc = c;
    }
    if (!pc) return;
    me = FIELD(pc, C_PLAYERSTATE, u8 *);
    team = is_a(me, R_CLS_PS) ? FIELD(me, PS_TEAM, i32) : 0;
    if (team <= 0 && elapsed < ANNOUNCE_LATEST) return;
    A.done = 1;
    put_str(&at, "Your team of ");
    put_int(&at, size);
    put_str(&at, ":");
    players = FIELD(gs, GS_PLAYERS, u8 **);
    n = FIELD(gs, GS_NUM_PLAYERS, i32);
    for (i = 0; team > 0 && i < n && names < MAX_TEAM; i++) {
        u8 *ps = players[i];
        FString *name;
        if (!ps || ps == me || FIELD(ps, PS_TEAM, i32) != team) continue;
        put_str(&at, names ? ", " : " ");
        name = (FString *)(ps + PS_NAME);
        for (j = 0; name->data && j < name->num && j < NAME_CHARS && name->data[j]; j++)
            put(&at, name->data[j]);
        names++;
    }
    if (!names) put_str(&at, team > 0 ? " no teammates" : " no team");
    put(&at, 0);
    send(pc, at);
}

/* ---------------------------------------------------------------- Duo: a team's win */

/* The stock check (VA 0x140244d30) knows teams only when the world's net mode
   is not Standalone (UWorld::GetNetMode, 0x1416848f0): its team rule ("every
   living human on one team") is for online matches. A local Duo match is
   Standalone, so it takes the Solo rule instead - the match ends when no bot
   is alive and at most one human is - and a bot teammate alive keeps the
   match going. Here the match also ends once every living contestant (humans
   and bots, by the stock check's own filters) is on one team (TeamNumber > 0,
   which patch_exe.py fix 4 assigns) and some contestant of another team has
   died (so a match that has not filled yet never ends). The stock end of
   match follows: AShooterGame_FreeForAll's DetermineMatchWinner (0x1402324a0)
   makes every record with the living team's number a winner, dead ones too. */
static char duo_should_end(u8 *gm)
{
    u8 *gs, **players, *recs;
    i32 i, n, team = 0, alive = 0;
    if (((fn_bool)AT(R_FFA_SHOULD_END))(gm)) return 1;
    if (FIELD(gm, GM_NO_END, u8)) return 0;
    gs = FIELD(gm, GM_GAMESTATE, u8 *);
    if (!gs) return 0;
    players = FIELD(gs, GS_PLAYERS, u8 **);
    n = FIELD(gs, GS_NUM_PLAYERS, i32);
    for (i = 0; i < n; i++) {
        u8 *ps = players[i];
        i32 t;
        if (!ps || (FIELD(ps, PS_FLAGS, u32) & 1) || !FIELD(ps, PS_CONTESTANT, u8)) continue;
        if (((fn_bool)AT(R_PS_HAS_LEFT))(ps) || !((fn_bool)AT(R_PS_IS_ALIVE))(ps)) continue;
        t = FIELD(ps, PS_TEAM, i32);
        if (t <= 0 || (team && t != team)) return 0;
        team = t;
        alive++;
    }
    if (!alive) return 0;
    recs = FIELD(gs, GS_RECORDS, u8 *);
    n = FIELD(gs, GS_NUM_RECORDS, i32);
    for (i = 0; i < n; i++) {
        u8 *r = recs + (u64)i * REC_SIZE;
        if (FIELD(r, REC_PS, u8 *) && !FIELD(r, REC_ALIVE, u8) && FIELD(r, REC_TEAM, i32) != team) return 1;
    }
    return 0;
}

/* ---------------------------------------------------------------- the Chokening's kills */

typedef struct { i32 index, serial; } Weak;   /* FWeakObjectPtr */
typedef void (*fn_rating)(u8 *, FString *, FString *, i32);

static struct {
    u8 *world;                     /* compared, never read */
    i32 n;
    struct { Weak pylon, by; } list[MAX_PYLONS];
} C;

static const u16 PYLON_USE[] = { 'P', 'y', 'l', 'o', 'n', 'U', 's', 'e', 0 };

static u8 *weak(Weak *w) { return ((fn_ptr)AT(R_WEAK_GET))((u8 *)w); }
static void weak_set(Weak *w, u8 *obj) { ((fn_void2)AT(R_WEAK_SET))((u8 *)w, obj); }

static int is_pylon_use(FString *s)
{
    i32 i;
    if (!s || !s->data || s->num != 9) return 0;
    for (i = 0; i < 9; i++)
        if (s->data[i] != PYLON_USE[i]) return 0;
    return 1;
}

/* Pylons that went back to Inert (or are gone) are no longer the Chokening's:
   a later trigger by the match's own schedule is not the user's. */
static void sweep(void)
{
    i32 i = 0;
    while (i < C.n) {
        u8 *p = weak(&C.list[i].pylon);
        if (p && FIELD(p, PY_STATE, u8) != PYLON_INERT) { i++; continue; }
        C.n--;
        C.list[i] = C.list[C.n];
    }
}

/* The Chokening was used by ps: the pylons it just started are theirs. */
static void chokening(u8 *ps)
{
    u8 *world = world_of(ps), *list, *by = 0, *cls;
    PtrArray found;
    i32 i, j, num;
    if (!world) return;
    list = world + W_CONTROLLERS;
    num = FIELD(list, 8, i32);
    for (i = 0; i < num && !by; i++) {
        u8 *c = weak_get(list, i);
        if (c && FIELD(c, C_PLAYERSTATE, u8 *) == ps) by = c;
    }
    if (!by) return;
    cls = ((fn_class)AT(R_CLS_PYLON))((const u16 *)AT(R_PKG_VICTORY));
    if (!cls) return;
    if (C.world != world) C.n = 0;      /* a new match */
    C.world = world;
    found.data = 0;
    found.num = found.max = 0;
    ((fn_actors)AT(R_ACTORS_OF_CLASS))(ps, cls, &found);
    for (i = 0; i < found.num && C.n < MAX_PYLONS; i++) {
        u8 *p = found.data[i];
        if (!p || FIELD(p, PY_STATE, u8) != PYLON_RISING || FIELD(p, A_INSTIGATOR, u8 *)) continue;
        for (j = 0; j < C.n && weak(&C.list[j].pylon) != p; j++) ;
        if (j == C.n) C.n++;
        weak_set(&C.list[j].pylon, p);
        weak_set(&C.list[j].by, by);
    }
    if (found.data) ((fn_free)AT(R_FREE))(found.data);
}

void sd_rating(u8 *ps, FString *activity, FString *player, i32 value)
{
    int choke;
    B = base();
    choke = value == CHOKENING_RATING && is_pylon_use(activity);
    ((fn_rating)AT(R_RATING))(ps, activity, player, value);     /* takes the strings */
    if (choke && ps) chokening(ps);
}

static i32 team_of(u8 *c)
{
    u8 *ps = c ? FIELD(c, C_PLAYERSTATE, u8 *) : 0;
    return is_a(ps, R_CLS_PS) ? FIELD(ps, PS_TEAM, i32) : 0;
}

u8 *sd_gas_instigator(u8 *wound)
{
    u8 *ctrl, *victim, *by, *vc, *p = 0;
    i32 i, j, t;
    B = base();
    ctrl = ((fn_ptr)AT(R_INSTIGATOR_CTRL))(wound);
    if (ctrl || !wound || !C.n) return ctrl;
    victim = FIELD(wound, A_OWNER, u8 *);
    if (!victim || world_of(wound) != C.world) return 0;
    for (i = 0; i < C.n; i++) {
        u8 **in;
        i32 n;
        p = weak(&C.list[i].pylon);
        if (!p || FIELD(p, PY_STATE, u8) == PYLON_INERT) continue;
        if (FIELD(p, PY_WOUND_CLASS, u8 *) != FIELD(wound, O_CLASS, u8 *)) continue;
        in = FIELD(p, PY_IN_AREA, u8 **);
        n = FIELD(p, PY_IN_AREA + 8, i32);
        for (j = 0; j < n && in[j] != victim; j++) ;
        if (j < n) break;
    }
    if (i == C.n) return 0;
    by = weak(&C.list[i].by);
    if (!by || FIELD(by, C_PAWN, u8 *) == victim) { at_gas(victim, 0, "user"); return 0; }
    vc = FIELD(victim, P_CONTROLLER, u8 *);
    if (vc == by) { at_gas(victim, 0, "user"); return 0; }
    t = team_of(by);
    if (t > 0 && team_of(vc) == t) { at_gas(victim, 0, "teammate"); return 0; }
    at_gas(victim, by, "rival");
    return by;
}

#include "weather.c"            /* weather over a match (weather_tick) */
#include "unstick.c"            /* the stuck-player safety net (unstick_tick) */

/* ---------------------------------------------------------------- the arena's sides */

/* Each side's spots: a line across the arena's west (side 0: you in 1v1,
   team 1) or east (side 1) approach, SD_SIDE_X out from the centre, facing
   in. A side of n fighters stands SD_SPACING apart, centred on the approach:
   1v1's spots are exactly the two arena starts version 1 used ((-1800, 0, 200)
   facing east, (1800, 0, 200) facing west). Every spot of a side of up to 4
   is on the arena floor's navmesh (make_showdown.py checks it against the
   stock Navigation level), 160 apart (a pawn's capsule is 100 across). */
#define SD_SIDE_X      1800.0f
#define SD_SPACING     160.0f
#define SD_SLOT_Z      200.0f      /* a little above the floor (navmesh z 16-20 there), as the starts were */
#define SD_PLACE_TICKS 3           /* a refused teleport (or a fighter without a pawn yet) is tried again */
#define SD_MAX_FIGHTERS 16

static struct { Weak done[SD_MAX_FIGHTERS]; i32 n; } P;   /* the pawns on their spots this round */

static int sd_placed(u8 *pawn)
{
    i32 i;
    for (i = 0; i < P.n && i < SD_MAX_FIGHTERS; i++)
        if (weak(&P.done[i]) == pawn) return 1;
    return 0;
}

/* A side's k-th spot of n, and its facing (pitch, yaw, roll). */
static void sd_spot(i32 side, i32 k, i32 n, float *at, float *rot)
{
    at[0] = side ? SD_SIDE_X : -SD_SIDE_X;
    at[1] = ((float)k - 0.5f * (float)(n - 1)) * SD_SPACING;
    at[2] = SD_SLOT_Z;
    rot[0] = 0.0f;
    rot[1] = side ? 180.0f : 0.0f;
    rot[2] = 0.0f;
}

/* Every fighter not on its spot yet this round goes there: its side is its
   team (team 1 west, any other east; 1v1: the player west, the rival east),
   its place on the side its order among that side's fighters in the world's
   controller list (stable through the match). The controller's rotation is
   set too, so the player looks into the arena. Returns how many fighters are
   still not on their spots. */
static i32 place(u8 *world, i32 teams)
{
    u8 *list = world + W_CONTROLLERS;
    i32 i, pass, side, k, left = 0, num = FIELD(list, 8, i32);
    i32 n[2], at[2];
    float to[3], rot[3];
    n[0] = n[1] = at[0] = at[1] = 0;
    for (pass = 0; pass < 2; pass++) {
        for (i = 0; i < num; i++) {
            u8 *c = weak_get(list, i), *ps, *pawn;
            if (!c || !is_fighter(c)) continue;
            ps = FIELD(c, C_PLAYERSTATE, u8 *);
            if (!is_a(ps, R_CLS_PS) || (FIELD(ps, PS_FLAGS, u32) & 2)) continue;
            side = teams ? FIELD(ps, PS_TEAM, i32) != 1 : !is_a(c, R_CLS_PC);
            if (!pass) { n[side]++; continue; }
            k = at[side]++;
            pawn = wx_live(FIELD(c, C_PAWN, u8 *));
            if (!pawn || !is_a(pawn, R_CLS_CHARACTER)) { left++; continue; }
            if (sd_placed(pawn)) continue;
            sd_spot(side, k, n[side], to, rot);
            if (!((us_teleport_t)AT(US_TELEPORT))(pawn, to, rot)) { left++; continue; }
            FIELD(c, C_CONTROL_ROT, float) = rot[0];
            FIELD(c, C_CONTROL_ROT + 4, float) = rot[1];
            FIELD(c, C_CONTROL_ROT + 8, float) = rot[2];
            if (P.n < SD_MAX_FIGHTERS) weak_set(&P.done[P.n++], pawn);
        }
    }
    return left;
}

/* A new round: nobody is on a spot yet. In team Showdown the player's HUD
   looks for its teammate's (new) pawn again: its panel finds one once
   (AVictoryPlayerHUD +0x654, VA 0x1401fbec7) and that pawn is gone. */
static void new_round_sides(u8 *world, i32 teams)
{
    u8 *list = world + W_CONTROLLERS;
    i32 i, num = FIELD(list, 8, i32);
    P.n = 0;
    S.placing = SD_PLACE_TICKS;
    if (!teams) return;
    for (i = 0; i < num; i++) {
        u8 *c = weak_get(list, i), *hud;
        if (!c || !is_a(c, R_CLS_PC)) continue;
        hud = FIELD(c, PC_HUD, u8 *);
        if (is_a(hud, R_CLS_HUD)) FIELD(hud, HUD_MATE_FOUND, u8) = 0;
    }
}

static void sides_tick(u8 *world, i32 teams)
{
    if (S.placing <= 0) return;
    S.placing--;
    if (!place(world, teams)) S.placing = 0;
}

/* The player's pawn of this round, kept possessed. After the player's own
   death the game puts its controller in the spectating state a few seconds
   later (APlayerController::BeginSpectatingState unpossesses the pawn it has
   then). The round's 3 black seconds are shorter than that, so it took the
   pawn reset() had just given the player: the next round was lost about a
   second in, without a blow (seen by patch/autotest, round after a lost
   round). The pawn is still there, uncontrolled: the controller possesses it
   again (AController::Possess, vtable +0x648). */
#define V_POSSESS      0x648
static struct { Weak ctrl, pawn; } K;

static void keep_record(u8 *world)
{
    u8 *list = world + W_CONTROLLERS;
    i32 i, num = FIELD(list, 8, i32);
    K.ctrl.index = K.pawn.index = -1;
    K.ctrl.serial = K.pawn.serial = 0;
    for (i = 0; i < num; i++) {
        u8 *c = weak_get(list, i);
        if (c && is_a(c, R_CLS_PC) && FIELD(c, C_PAWN, u8 *)) {
            weak_set(&K.ctrl, c);
            weak_set(&K.pawn, FIELD(c, C_PAWN, u8 *));
            return;
        }
    }
}

static int keep_possessed(void)
{
    u8 *c = weak(&K.ctrl), *p = weak(&K.pawn);
    if (!c || !p || FIELD(c, C_PAWN, u8 *) || FIELD(p, P_CONTROLLER, u8 *) || !((fn_bool)AT(US_CH_ALIVE))(p)) return 0;
    ((fn_void2)VFN(c, V_POSSESS))(c, p);
    return FIELD(c, C_PAWN, u8 *) == p;
}

/* For the tests: the sides' state. */
void sd_sides_probe(i32 *out)
{
    out[0] = P.n;
    out[1] = S.placing;
}

static char should_end(u8 *gm);

char sd_should_end(u8 *gm)
{
    char end;
    B = base();
    end = should_end(gm);
    at_match_end(end);
    return end;
}

static char should_end(u8 *gm)
{
    u8 *world;
    Count n;
    i32 teams;
    u16 x;
    B = base();
    weather_tick(gm);
    unstick_tick(gm);
    if (C.n) sweep();
    if (gm && FIELD(gm, GM_TYPE, u8) == CLASSIC_TEAMS) {
        if ((world = world_of(gm)) != 0) {
            teams = team_size(gm, CLASSIC_TEAMS);
            if (teams > DUO) report_mates(gm, world);
            if (url_flag(gm, "teamdebug=1")) announce_team(gm, world, teams);   /* debug only */
        }
        return duo_should_end(gm);
    }
    if (!gm || FIELD(gm, GM_TYPE, u8) != LIGHTNING) return ((fn_bool)AT(R_FFA_SHOULD_END))(gm);
    world = world_of(gm);
    if (!world) return ((fn_bool)AT(R_FFA_SHOULD_END))(gm);
    teams = team_size(gm, LIGHTNING);
    if (teams > DUO) report_mates(gm, world);
    ensure(gm);
    S.size = teams ? teams : 1;
    if (S.phase == FIGHT && S.round > 1 && keep_possessed()) at_note("repossessed");
    count(world, &n, teams);
    if (!n.mine || !n.theirs) return ((fn_bool)AT(R_FFA_SHOULD_END))(gm);
    if (!S.announced) {
        S.announced = 1;
        new_round_sides(world, 0);
        sides_tick(world, teams);
        if (kit_rival(world)) S.kitted = S.round;
        tell(n.pc, 'S', S.round, S.wins, S.losses, (u16)('0' + S.kit));
    } else if (S.phase == FIGHT) {
        sides_tick(world, teams);
    }
    if (S.phase == DONE) return 1;
    if (S.phase == BETWEEN) {
        if (--S.timer > 0) return 0;
        S.round++;
        S.kit = kit_for(S.round);
        reset(gm, world);
        keep_record(world);
        new_round_sides(world, teams);
        sides_tick(world, teams);
        S.kitted = kit_rival(world) ? S.round : 0;
        S.phase = FIGHT;
        S.grace = GRACE_TICKS;
        count(world, &n, teams);
        tell(n.pc, 'S', S.round, S.wins, S.losses, (u16)('0' + S.kit));
        return 0;
    }
    /* Until the rival has this round's kit (no pawn yet, say): try again. */
    if (S.kitted != S.round && kit_rival(world)) S.kitted = S.round;
    if (S.grace > 0) { S.grace--; return 0; }
    if (n.mine_alive && n.theirs_alive) return 0;
    x = n.mine_alive ? 'W' : n.theirs_alive ? 'L' : 'D';
    if (x == 'W') S.wins++;
    else if (x == 'L') S.losses++;
    if (S.wins >= ROUNDS_TO_WIN || S.losses >= ROUNDS_TO_WIN) {
        S.phase = DONE;
        tell(n.pc, 'O', S.round, S.wins, S.losses, x);
        return 1;
    }
    tell(n.pc, 'E', S.round, S.wins, S.losses, x);
    S.phase = BETWEEN;
    S.timer = BLACK_TICKS;
    return 0;
}

void sd_rand_exec(u8 *ctx, u8 *stack, i32 *result)
{
    u8 *code, *obj, *world, *gm;
    i32 force = -1;
    B = base();
    code = FIELD(stack, F_CODE, u8 *);
    /* RandomIntegerInRange(0, 6): EX_IntConst 0, EX_IntConst 6, EX_EndFunctionParms */
    if (code && code[0] == 0x1d && FIELD(code, 1, i32) == 0 && code[5] == 0x1d
        && FIELD(code, 6, i32) == KITS - 1 && code[10] == 0x16) {
        obj = FIELD(stack, F_OBJECT, u8 *);
        world = obj ? world_of(obj) : 0;
        gm = world ? FIELD(world, W_AUTH_GM, u8 *) : 0;
        if (gm && is_a(gm, R_CLS_GAMEMODE) && FIELD(gm, GM_TYPE, u8) == LIGHTNING) {
            ensure(gm);
            force = S.kit;
        }
    }
    ((fn_exec)AT(R_RAND_EXEC))(ctx, stack, result);
    if (force >= 0) *result = force;
}

void *sd_spawn_with(u8 *pawn, void *out, float stat)
{
    B = base();
    if (pawn && pawn == S.kit_target && S.kit_source)
        return ((fn_spawn_with)AT(R_SPAWN_WITH))(S.kit_source, out, KIT_BITS);
    return ((fn_spawn_with)AT(R_SPAWN_WITH))(pawn, out, stat);
}

#include "autotest.c"           /* the in-game tests (sd_gm_tick, only with ?RemasterAutoTest=) */
