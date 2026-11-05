/* The native module: Showdown rounds, the Duo team's win and the Chokening's
 * kills.
 *
 * Built by build_showdown_rounds.py (MSVC cl, no CRT) into a blob that
 * patch_exe.py places in a new section of Victory.exe. All game addresses are
 * image-relative (the exe is ASLR-enabled): the base is found from the RVA of
 * sd_self_rva, which the builder writes into the blob.
 *
 * Five entry points:
 *
 * sd_should_end(gm) replaces AShooterGame_FreeForAll's "should the match end"
 *   virtual (vtable slot 282, VA 0x140244d30), which AShooterGameMode::Tick
 *   calls once a second while the match is InProgress. For Solo and every
 *   other mode it is the stock function. For Duo (ClassicTeams) it is the
 *   stock function, and also ends the match once every living contestant is
 *   on one team (duo_should_end, below). For Lightning (Showdown) it runs the
 *   series:
 *     FIGHT    both fighters alive -> keep playing. One left (by the game's
 *              own alive records, AShooterGameState+0x468) -> the round goes
 *              to them; the HUD is told ("SDR|E|...").
 *     BETWEEN  3 ticks of black on the HUD, then RESET: every pawn is
 *              unpossessed and destroyed (corpses too), both alive records
 *              are restored, and RestartPlayer respawns both fighters at the
 *              arena starts with a fresh kit; the HUD is told ("SDR|S|...").
 *     DONE     a fighter has 4 rounds: the stock end of match (VICTORY or
 *              DEFEAT, then the menu).
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
 *   equal, i.e. Duo), who keep the stock "no instigator".
 *
 * HUD messages go through AVictoryPlayerHUD::ShowGameMessage, which the HUD
 * page receives as the ShowGameMessage event (ShowdownHud.js takes the "SDR|"
 * ones):
 *   SDR|S|<round>|<you>|<rival>|<kit>   round starts (kit 0-6)
 *   SDR|E|<round>|<you>|<rival>|<W/L/D> round over, the series goes on
 *   SDR|O|<round>|<you>|<rival>|<W/L/D> last round, the series is over
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

#define CLASSIC_TEAMS  2           /* EVictoryGameMode::ClassicTeams: Duo (CoopRanked) */
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
    u8 *kit_target, *kit_source;   /* sd_spawn_with: the rival's pawn asks the player's */
} S;

static u16 message[32];

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
    }
    S.last_elapsed = elapsed;
}

static int is_fighter(u8 *c) { return is_a(c, R_CLS_PC) || is_a(c, R_CLS_AI); }

typedef struct { i32 humans, humans_alive, bots, bots_alive; u8 *pc; } Count;

static void count(u8 *world, Count *n)
{
    u8 *list = world + W_CONTROLLERS;
    i32 i, num = FIELD(list, 8, i32);
    for (i = 0; i < num; i++) {
        u8 *c = weak_get(list, i), *ps;
        int pc, alive;
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
        if (pc) { n->humans++; n->humans_alive += alive; n->pc = c; }
        else { n->bots++; n->bots_alive += alive; }
    }
}

static void put(i32 *at, u16 ch) { message[(*at)++] = ch; }

/* "SDR|<ev>|<round>|<you>|<rival>|<x>" to the player's HUD. */
static void tell(u8 *pc, u16 ev, i32 round, i32 wins, i32 losses, u16 x)
{
    u8 *hud;
    FString s;
    i32 n = 0, i;
    if (!pc) return;
    hud = FIELD(pc, PC_HUD, u8 *);
    if (!is_a(hud, R_CLS_HUD)) return;
    put(&n, 'S'); put(&n, 'D'); put(&n, 'R'); put(&n, '|');
    put(&n, ev); put(&n, '|');
    if (round >= 10) put(&n, (u16)('0' + round / 10 % 10));
    put(&n, (u16)('0' + round % 10)); put(&n, '|');
    put(&n, (u16)('0' + wins % 10)); put(&n, '|');
    put(&n, (u16)('0' + losses % 10)); put(&n, '|');
    put(&n, x);
    put(&n, 0);
    s.data = 0;
    s.num = n;
    s.max = 0;
    ((fn_resize)AT(R_STRING_RESIZE))(&s, n, 0);
    if (!s.data) return;
    for (i = 0; i < n; i++) s.data[i] = message[i];
    ((fn_message)AT(R_HUD_MESSAGE))(hud, &s, 0.0f);   /* takes the string */
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
    if (!by || FIELD(by, C_PAWN, u8 *) == victim) return 0;
    vc = FIELD(victim, P_CONTROLLER, u8 *);
    if (vc == by) return 0;
    t = team_of(by);
    if (t > 0 && team_of(vc) == t) return 0;
    return by;
}

char sd_should_end(u8 *gm)
{
    u8 *world;
    Count n;
    u16 x;
    B = base();
    if (C.n) sweep();
    if (gm && FIELD(gm, GM_TYPE, u8) == CLASSIC_TEAMS) return duo_should_end(gm);
    if (!gm || FIELD(gm, GM_TYPE, u8) != LIGHTNING) return ((fn_bool)AT(R_FFA_SHOULD_END))(gm);
    world = world_of(gm);
    if (!world) return ((fn_bool)AT(R_FFA_SHOULD_END))(gm);
    ensure(gm);
    n.humans = n.humans_alive = n.bots = n.bots_alive = 0;
    n.pc = 0;
    count(world, &n);
    if (!n.humans || !n.bots) return ((fn_bool)AT(R_FFA_SHOULD_END))(gm);
    if (!S.announced) {
        S.announced = 1;
        if (kit_rival(world)) S.kitted = S.round;
        tell(n.pc, 'S', S.round, S.wins, S.losses, (u16)('0' + S.kit));
    }
    if (S.phase == DONE) return 1;
    if (S.phase == BETWEEN) {
        if (--S.timer > 0) return 0;
        S.round++;
        S.kit = kit_for(S.round);
        reset(gm, world);
        S.kitted = kit_rival(world) ? S.round : 0;
        S.phase = FIGHT;
        S.grace = GRACE_TICKS;
        n.pc = 0;
        n.humans = n.humans_alive = n.bots = n.bots_alive = 0;
        count(world, &n);
        tell(n.pc, 'S', S.round, S.wins, S.losses, (u16)('0' + S.kit));
        return 0;
    }
    /* Until the rival has this round's kit (no pawn yet, say): try again. */
    if (S.kitted != S.round && kit_rival(world)) S.kitted = S.round;
    if (S.grace > 0) { S.grace--; return 0; }
    if (n.humans_alive && n.bots_alive) return 0;
    x = n.humans_alive ? 'W' : n.bots_alive ? 'L' : 'D';
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
