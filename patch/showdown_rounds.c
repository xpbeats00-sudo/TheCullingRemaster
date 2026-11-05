/* Showdown rounds: every round of a Showdown series in one match.
 *
 * Built by build_showdown_rounds.py (MSVC cl, no CRT) into a blob that
 * patch_exe.py places in a new section of Victory.exe. All game addresses are
 * image-relative (the exe is ASLR-enabled): the base is found from the RVA of
 * sd_self_rva, which the builder writes into the blob.
 *
 * Two entry points:
 *
 * sd_should_end(gm) replaces AShooterGame_FreeForAll's "should the match end"
 *   virtual (vtable slot 282, VA 0x140244d30), which AShooterGameMode::Tick
 *   calls once a second while the match is InProgress. For any mode but
 *   Lightning (Showdown) it is the stock function. For Showdown it runs the
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
#define C_PAWN         0x408
#define C_PLAYERSTATE  0x420
#define PC_HUD         0x490
#define PS_FLAGS       0x42c       /* bit 0 spectator, bit 1 only spectator */
#define F_OBJECT       0x18        /* FFrame::Object */
#define F_CODE         0x20        /* FFrame::Code */

#define LIGHTNING      3           /* EVictoryGameMode::Lightning: Showdown */
#define ROUNDS_TO_WIN  4
#define KITS           7
#define BLACK_TICKS    3           /* seconds between a round's end and the reset */
#define GRACE_TICKS    2           /* seconds after a reset before deaths count */

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
        ((fn_void)VFN(c, V_UNPOSSESS))(c);
        ((fn_void)VFN(p, V_DESTROY))(p);
    }
    /* Corpses and anything else that is a character (backwards: destroying
       takes it out of the list). */
    for (i = FIELD(pawns, 8, i32) - 1; i >= 0; i--) {
        u8 *p = weak_get(pawns, i);
        if (p && is_a(p, R_CLS_CHARACTER)) ((fn_void)VFN(p, V_DESTROY))(p);
    }
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

char sd_should_end(u8 *gm)
{
    u8 *world;
    Count n;
    u16 x;
    B = base();
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
        tell(n.pc, 'S', S.round, S.wins, S.losses, (u16)('0' + S.kit));
    }
    if (S.phase == DONE) return 1;
    if (S.phase == BETWEEN) {
        if (--S.timer > 0) return 0;
        S.round++;
        S.kit = kit_for(S.round);
        reset(gm, world);
        S.phase = FIGHT;
        S.grace = GRACE_TICKS;
        n.pc = 0;
        n.humans = n.humans_alive = n.bots = n.bots_alive = 0;
        count(world, &n);
        tell(n.pc, 'S', S.round, S.wins, S.losses, (u16)('0' + S.kit));
        return 0;
    }
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
