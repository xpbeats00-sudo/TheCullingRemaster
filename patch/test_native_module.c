/* Runs the native module (showdown_rounds.c, compiled with the blob's own
 * flags) against fake game objects - Duo, team sizes, the teammates' HUD
 * report, Showdown (1v1 and team) and the Chokening: a fake image holds a jump at every game
 * function the tested paths call, to the stand-ins below, and sd_self_rva is
 * set so the module's image base is the fake image.
 *
 * Built and run by test_native_module.py. Prints "ok ..." lines, exits 1 on
 * the first failure.
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef unsigned long long u64;
typedef unsigned char u8;
typedef unsigned short u16;
typedef int i32;

extern volatile u64 sd_self_rva;
char sd_should_end(u8 *gm);
void sd_rating(u8 *ps, void *activity, void *player, i32 value);
u8 *sd_gas_instigator(u8 *wound);
char sd_teams(u8 *gs);
void sd_spawn_bots(u8 *gm);

#define F(p, off, type) (*(type *)((u8 *)(p) + (off)))
#define CHECK(c) do { if (!(c)) { printf("FAIL line %d: %s\n", __LINE__, #c); exit(1); } } while (0)

static u8 *image;

/* ---------------------------------------------------------------- objects */

static u8 *world;
static void *vtable[0x100];
static u8 *get_world(u8 *self) { (void)self; return world; }

static u8 *new_obj(u8 *cls)
{
    u8 *o = (u8 *)calloc(1, 0x1000);
    F(o, 0, void **) = vtable;
    F(o, 0x10, u8 *) = cls;
    return o;
}

static u8 *new_class(void)
{
    u8 *c = (u8 *)calloc(1, 0x100);
    u8 **chain = (u8 **)calloc(1, sizeof(u8 *));
    chain[0] = c + 0x88;
    F(c, 0x88, u8 **) = chain;   /* the base chain: just itself, index 0 */
    F(c, 0x90, i32) = 0;
    return c;
}

static u8 *cls_ps, *cls_pc, *cls_ai, *cls_pylon, *cls_wound, *cls_other_wound, *cls_pawn;
static u8 *cls_char, *cls_hud, *cls_gm, *cls_weapon, *cls_pickup;
static u8 *ret_ps(void) { return cls_ps; }
static u8 *ret_pc(void) { return cls_pc; }
static u8 *ret_ai(void) { return cls_ai; }
static u8 *ret_pylon(void) { return cls_pylon; }
static u8 *ret_char(void) { return cls_char; }
static u8 *ret_hud(void) { return cls_hud; }
static u8 *ret_gm(void) { return cls_gm; }
static u8 *ret_weapon(void) { return cls_weapon; }
static u8 *ret_pickup(void) { return cls_pickup; }

/* Weak pointers: an index into this table (serial 0 = none). */
static u8 *objs[4096];
static int alive_obj[4096];
static int nobjs;
static int reg(u8 *o) { objs[nobjs] = o; alive_obj[nobjs] = 1; return nobjs++; }
static void weak_set(i32 *w, u8 *o)
{
    int i;
    w[0] = -1; w[1] = 0;
    for (i = 0; o && i < nobjs; i++)
        if (objs[i] == o) { w[0] = i; w[1] = 1; }
}
static u8 *weak_get(i32 *w) { return w[1] && w[0] >= 0 && alive_obj[w[0]] ? objs[w[0]] : 0; }
static void kill_obj(u8 *o) { int i; for (i = 0; i < nobjs; i++) if (objs[i] == o) alive_obj[i] = 0; }

/* ---------------------------------------------------------------- stand-ins */

static char stock_end;
static int stock_calls;
static char ffa_should_end(u8 *gm) { (void)gm; stock_calls++; return stock_end; }
#define PS_LEFT  0x800                    /* fake fields the stand-ins read */
#define PS_ALIVE 0x801
#define PS_REC   0x818                    /* its record (Showdown tests), else PS_ALIVE */
#define PS_INDEX 0x820                    /* its record's index */
static char ps_has_left(u8 *ps) { return F(ps, PS_LEFT, u8); }
static char ps_is_alive(u8 *ps) { return F(ps, PS_REC, u8 *) ? F(F(ps, PS_REC, u8 *), 0x28, u8) : F(ps, PS_ALIVE, u8); }

static int rating_calls;
static void rating(u8 *ps, void *a, void *p, i32 v) { (void)ps; (void)a; (void)p; (void)v; rating_calls++; }

static u8 *actors[8];
static int nactors;
typedef struct { u8 **data; i32 num, max; } PtrArray;
static void actors_of_class(u8 *ctx, u8 *cls, PtrArray *out)
{
    (void)ctx;
    if (cls != cls_pylon) {                          /* dropped weapons and pickups: none */
        CHECK(cls == cls_weapon || cls == cls_pickup);
        out->data = 0;
        out->num = out->max = 0;
        return;
    }
    out->data = (u8 **)malloc(sizeof(u8 *) * 8);
    memcpy(out->data, actors, sizeof(u8 *) * nactors);
    out->num = out->max = nactors;
}
static void mem_free(void *p) { free(p); }
static u8 *instigator_ctrl(u8 *a) { u8 *p = F(a, 0x150, u8 *); return p ? F(p, 0x438, u8 *) : 0; }

/* Team sizes. */
static int set_team_calls, sort_calls, spawn_bots_calls;
static void set_team(u8 *ps, i32 team, u8 b) { CHECK(b == 1); F(ps, 0x490, i32) = team; set_team_calls++; }
static char sort_scores(u8 *gs) { (void)gs; sort_calls++; return 7; }
static void spawn_bots(u8 *gm) { (void)gm; spawn_bots_calls++; }
static float comp_value(u8 *c) { return F(c, 0x10, float); }
static float comp_max(u8 *c) { return F(c, 0x14, float); }

/* Strings and HUD messages. */
typedef struct { u16 *data; i32 num, max; } FStr;
static char messages[64][512];
static int nmessages;
static void string_resize(FStr *s, i32 n, i32 prev) { (void)prev; s->data = (u16 *)calloc(n + 1, 2); s->max = n; }
typedef FStr FString;
static FString str(const char *s)
{
    FString f;
    i32 i, n = (i32)strlen(s) + 1;
    f.data = (u16 *)calloc(n, 2);
    for (i = 0; i < n; i++) f.data[i] = (u16)s[i];
    f.num = f.max = n;
    return f;
}
static void hud_message(u8 *hud, FStr *s, float t)
{
    int i;
    (void)hud; (void)t;
    CHECK(s->data && s->num > 0 && s->data[s->num - 1] == 0);
    for (i = 0; i < s->num && i < 511; i++) messages[nmessages % 64][i] = (char)s->data[i];
    messages[nmessages % 64][i] = 0;
    nmessages++;
    free(s->data);
}
static const char *last_message(const char *prefix)
{
    int i;
    for (i = nmessages - 1; i >= 0 && i >= nmessages - 64; i--)
        if (!strncmp(messages[i % 64], prefix, strlen(prefix))) return messages[i % 64];
    return "";
}

/* Showdown's game: records, pawns, inventories, restarts. */
static FStr *ps_id(u8 *ps, FStr *out) { out->data = (u16 *)malloc(2); out->num = F(ps, PS_INDEX, i32) + 1; return out; }
static i32 find_record(u8 *gs, FStr *id) { (void)gs; free(id->data); return id->num - 1; }
static int start_inventory_calls, restarts;
static void start_inventory(u8 *pawn) { (void)pawn; start_inventory_calls++; }
static void clear_inventory(u8 *pawn) { F(pawn, 0xd38, i32) = 0; }
static u8 *spawn_weapon(u8 *pawn, u8 *cls) { (void)pawn; (void)cls; return 0; }

static void hook(u64 rva, void *fn)
{
    u8 *at = image + rva;
    VirtualAlloc((void *)((u64)at & ~0xfffULL), 0x2000, MEM_COMMIT, PAGE_EXECUTE_READWRITE);
    at[0] = 0x48; at[1] = 0xb8; memcpy(at + 2, &fn, 8);   /* mov rax, fn */
    at[10] = 0xff; at[11] = 0xe0;                         /* jmp rax */
}

/* ---------------------------------------------------------------- Duo */

#define GM_TYPE 0x4e0
#define GM_GS 0x458
#define GM_NO_END 0x74d
#define REC 0x150

static u8 *gm, *gs, *pss[6];

static void duo_setup(void)
{
    int i;
    u8 **arr = (u8 **)calloc(6, sizeof(u8 *));
    u8 *recs = (u8 *)calloc(6, REC);
    gm = new_obj(0);
    gs = new_obj(0);
    F(gm, GM_TYPE, u8) = 2;
    F(gm, GM_GS, u8 *) = gs;
    for (i = 0; i < 6; i++) {
        pss[i] = new_obj(cls_ps);
        F(pss[i], 0x5b4, u8) = 1;
        F(pss[i], 0x490, i32) = i / 2 + 1;           /* teams 1,1,2,2,3,3 (fix 4) */
        F(pss[i], PS_ALIVE, u8) = 1;
        arr[i] = pss[i];
        F(recs + i * REC, 0x10, u8 *) = pss[i];
        F(recs + i * REC, 0x28, u8) = 1;
        F(recs + i * REC, 0x40, i32) = i / 2 + 1;
    }
    F(gs, 0x418, u8 **) = arr;
    F(gs, 0x420, i32) = 6;
    F(gs, 0x468, u8 *) = recs;
    F(gs, 0x470, i32) = 6;
}

static void die(int i)
{
    F(pss[i], PS_ALIVE, u8) = 0;
    F(F(gs, 0x468, u8 *) + i * REC, 0x28, u8) = 0;
}

static void revive_all(void)
{
    int i;
    for (i = 0; i < 6; i++) {
        F(pss[i], PS_ALIVE, u8) = 1;
        F(F(gs, 0x468, u8 *) + i * REC, 0x28, u8) = 1;
    }
}

/* A gm's OptionsString (+0x400). */
static void options(u8 *g, const char *url)
{
    FStr *o = (FStr *)(g + 0x400);
    i32 i, n = (i32)strlen(url) + 1;
    o->data = (u16 *)calloc(n, 2);
    for (i = 0; i < n; i++) o->data[i] = (u16)url[i];
    o->num = o->max = n;
}

static void test_duo(void)
{
    int i;
    duo_setup();
    CHECK(sd_should_end(gm) == 0);                    /* three teams alive */
    die(2); die(4);
    CHECK(sd_should_end(gm) == 0);                    /* one of each team left */
    die(3);
    CHECK(sd_should_end(gm) == 0);                    /* teams 1 and 3 */
    die(5);
    CHECK(sd_should_end(gm) == 1);                    /* only team 1, both alive: the bug */
    die(0);
    CHECK(sd_should_end(gm) == 1);                    /* only team 1's second member */
    revive_all(); die(1); die(2); die(3); die(4); die(5);
    CHECK(sd_should_end(gm) == 1);                    /* the player alone, teammate dead */
    revive_all(); die(0); die(1); die(2); die(3);
    CHECK(sd_should_end(gm) == 1);                    /* the rivals' team won */
    printf("ok    Duo: the match ends once every living contestant is on one team\n");

    revive_all(); die(2); die(3); die(4); die(5);
    F(pss[4], PS_LEFT, u8) = 1; F(pss[4], PS_ALIVE, u8) = 1;   /* left, records alive */
    CHECK(sd_should_end(gm) == 1);
    F(pss[4], PS_LEFT, u8) = 0; die(4);
    F(pss[5], 0x42c, i32) = 1; F(pss[5], PS_ALIVE, u8) = 1;   /* spectator */
    CHECK(sd_should_end(gm) == 1);
    F(pss[5], 0x42c, i32) = 0; die(5);
    F(pss[5], 0x5b4, u8) = 0; F(pss[5], PS_ALIVE, u8) = 1;    /* not a contestant */
    CHECK(sd_should_end(gm) == 1);
    F(pss[5], 0x5b4, u8) = 1; die(5);
    printf("ok    Duo: the stock check's filters (left, spectator, contestant)\n");

    /* Not paired (fix 4 hasn't run): never on a team. */
    for (i = 0; i < 6; i++) F(pss[i], 0x490, i32) = 0;
    CHECK(sd_should_end(gm) == 0);
    for (i = 0; i < 6; i++) F(pss[i], 0x490, i32) = i / 2 + 1;
    /* No rival has died yet (the match not filled): records of other teams all alive. */
    revive_all();
    for (i = 2; i < 6; i++) F(pss[i], PS_ALIVE, u8) = 0;      /* not alive by PlayerArray... */
    CHECK(sd_should_end(gm) == 0);                            /* ...but no other team's record dead */
    revive_all(); die(2); die(3); die(4); die(5);
    F(gm, GM_NO_END, u8) = 1;
    CHECK(sd_should_end(gm) == 0);
    F(gm, GM_NO_END, u8) = 0;
    CHECK(sd_should_end(gm) == 1);
    revive_all();
    stock_end = 1;
    CHECK(sd_should_end(gm) == 1);                            /* the stock check still ends it */
    stock_end = 0;
    printf("ok    Duo: unpaired, unfilled and no-end matches go on; the stock check still ends it\n");

    /* Solo (1) and other types: only the stock check. */
    revive_all(); die(2); die(3); die(4); die(5);
    F(gm, GM_TYPE, u8) = 1;
    stock_calls = 0;
    CHECK(sd_should_end(gm) == 0 && stock_calls == 1);
    stock_end = 1;
    CHECK(sd_should_end(gm) == 1);
    stock_end = 0;
    F(gm, GM_TYPE, u8) = 0;
    CHECK(sd_should_end(gm) == 0);
    F(gm, GM_TYPE, u8) = 5;
    CHECK(sd_should_end(gm) == 0);
    printf("ok    Solo and other modes: the stock check alone\n");
}

/* ---------------------------------------------------------------- team sizes */

#define NP 24
static u8 *tgm, *tgs, *tps[NP];

/* 24 contestants in PlayerArray, a world whose AuthorityGameMode is tgm. */
static void teams_setup(u8 type, const char *url)
{
    int i;
    u8 **arr = (u8 **)calloc(NP, sizeof(u8 *));
    u8 *recs = (u8 *)calloc(NP, REC);
    world = new_obj(0);
    tgm = new_obj(0);
    tgs = new_obj(0);
    F(world, 0xf0, u8 *) = tgm;
    F(tgm, GM_TYPE, u8) = type;
    F(tgm, GM_GS, u8 *) = tgs;
    F(tgs, 0x4e4, u8) = type;
    if (url) options(tgm, url);
    for (i = 0; i < NP; i++) {
        tps[i] = new_obj(cls_ps);
        F(tps[i], 0x5b4, u8) = 1;
        F(tps[i], PS_ALIVE, u8) = 1;
        arr[i] = tps[i];
        F(recs + i * REC, 0x10, u8 *) = tps[i];
        F(recs + i * REC, 0x28, u8) = 1;
    }
    F(tgs, 0x418, u8 **) = arr;
    F(tgs, 0x420, i32) = NP;
    F(tgs, 0x468, u8 *) = recs;
    F(tgs, 0x470, i32) = NP;
}

/* What the patched exe runs at the scoreboard refresh: fix 4's stub (1.3.9's,
   patch_exe.DUO_STUB) pairs a ClassicTeams match - SetTeamNum(ps, i / 2 + 1)
   for every non-null PlayerArray entry - then its sort call, which fix 9 sends
   to sd_teams. The stub's pairing is written here directly (not through the
   SetTeamNum stand-in), so set_team_calls counts only sd_teams' own calls. */
static char refresh(u8 *gs)
{
    int i;
    if (gs && F(gs, 0x4e4, u8) == 2)
        for (i = 0; i < F(gs, 0x420, i32); i++)
            if (F(gs, 0x418, u8 **)[i]) F(F(gs, 0x418, u8 **)[i], 0x490, i32) = i / 2 + 1;
    return sd_teams(gs);
}

/* The refresh on the setup: every contestant's team is index / size + 1
   (size 0: none), and sd_teams itself only re-teamed what the stub can't:
   Trios/Quads (ClassicTeams, size 3+) and team Showdown (Lightning). */
static int teams_are(int size)
{
    int i, ours;
    set_team_calls = sort_calls = 0;
    for (i = 0; i < NP; i++) F(tps[i], 0x490, i32) = 0;
    if (refresh(tgs) != 7 || sort_calls != 1) return 0;           /* the sort runs, its result returned */
    for (i = 0; i < NP; i++) {
        i32 want = size ? i / size + 1 : 0;
        if (F(tps[i], 0x490, i32) != want) return 0;
        F(F(tgs, 0x468, u8 *) + i * REC, 0x40, i32) = want;       /* SetTeamNum writes the record too */
    }
    ours = F(tgs, 0x4e4, u8) == 2 ? size > 2 : size > 0;
    return set_team_calls == (ours ? NP : 0);
}

static void team_die(int i)
{
    F(tps[i], PS_ALIVE, u8) = 0;
    F(F(tgs, 0x468, u8 *) + i * REC, 0x28, u8) = 0;
}

static void test_team_sizes(void)
{
    static const struct { const char *url; int size; } classic[] = {
        { 0, 2 },
        { "?bEnableBots=true?game=/Game/Blueprints/GameMode/VictoryGameMode_CoopRanked.VictoryGameMode_CoopRanked_C", 2 },
        { "?bEnableBots=true?game=/Game/Blueprints/GameMode/VictoryGameMode_CoopRanked.VictoryGameMode_CoopRanked_C?TeamSize=3", 3 },
        { "?TeamSize=4?bEnableBots=true", 4 },
        { "?teamsize=3", 3 },
        { "?TEAMSIZE=4?bExitOnRoundComplete=true", 4 },
        { "?TeamSize=2", 2 },
        { "?TeamSize=8", 8 },
        { "?TeamSize=03", 3 },
        { "?TeamSize=1", 2 },              /* out of range: Duo */
        { "?TeamSize=9", 2 },
        { "?TeamSize=12", 2 },
        { "?TeamSize=0", 2 },
        { "?TeamSize=", 2 },
        { "?TeamSize=x", 2 },
        { "?TeamSize=3x", 2 },
        { "?TeamSizes=3", 2 },             /* another option */
        { "?MyTeamSize=3", 2 },
        { "TeamSize=3", 2 },               /* not an option (no '?') */
        { "?bEnableBots=true?TeamSize=4", 4 },
    };
    int i, size;
    for (i = 0; i < (int)(sizeof(classic) / sizeof(classic[0])); i++) {
        teams_setup(2, classic[i].url);
        if (!teams_are(classic[i].size)) {
            printf("FAIL team size of %s: want %d\n", classic[i].url ? classic[i].url : "(none)", classic[i].size);
            exit(1);
        }
    }
    printf("ok    team sizes: ClassicTeams takes ?TeamSize= 3-8 from the URL (any case) over the stub's pairs, else Duo's 2\n");

    teams_setup(2, "?TeamSize=3");
    F(world, 0xf0, u8 *) = 0;                         /* no AuthorityGameMode: Duo's pairs */
    CHECK(teams_are(2));
    teams_setup(3, 0);                                /* 1v1 Showdown: no teams */
    CHECK(teams_are(0));
    teams_setup(3, "?TeamSize=1");
    CHECK(teams_are(0));
    for (size = 2; size <= 4; size++) {
        char url[64];
        sprintf(url, "?bEnableBots=true?TeamSize=%d", size);
        teams_setup(3, url);                          /* team Showdown */
        CHECK(teams_are(size));
    }
    teams_setup(1, "?TeamSize=3");                    /* Solo and the rest: never */
    CHECK(teams_are(0));
    teams_setup(5, "?TeamSize=3");
    CHECK(teams_are(0));
    teams_setup(2, "?TeamSize=3");                    /* a hole in PlayerArray keeps the others' places */
    F(tgs, 0x418, u8 **)[4] = 0;
    set_team_calls = 0;
    refresh(tgs);
    CHECK(set_team_calls == NP - 1 && F(tps[3], 0x490, i32) == 2 && F(tps[5], 0x490, i32) == 2);
    sort_calls = 0;
    CHECK(sd_teams(0) == 7 && sort_calls == 1);       /* no game state: just the sort */
    printf("ok    team sizes: Showdown only with ?TeamSize= 2-8; Solo and others never; holes, no game mode\n");

    /* Duo regression (in game, a build whose sd_teams did Duo's pairing on the
       refresh's own call left Duo with no teammate): Duo is paired by fix 4's
       stub alone; sd_teams never calls SetTeamNum in a Duo match and leaves
       the stub's teams as they are, with any Duo URL, or with no game mode. */
    {
        static const char *duo[] = { 0,
            "?bEnableBots=true?game=/Game/Blueprints/GameMode/VictoryGameMode_CoopRanked.VictoryGameMode_CoopRanked_C",
            "?TeamSize=2", "?TeamSize=1", "?TeamSize=x", "?bEnableBots=true?Weather=rainy?WeatherSeed=7" };
        int d, nogm;
        for (d = 0; d < (int)(sizeof(duo) / sizeof(duo[0])); d++)
            for (nogm = 0; nogm < 2; nogm++) {
                teams_setup(2, duo[d]);
                if (nogm) F(world, 0xf0, u8 *) = 0;
                for (i = 0; i < NP; i++) F(tps[i], 0x490, i32) = i / 2 + 1;   /* as the stub left them */
                set_team_calls = sort_calls = 0;
                CHECK(sd_teams(tgs) == 7 && sort_calls == 1 && set_team_calls == 0);
                for (i = 0; i < NP; i++) CHECK(F(tps[i], 0x490, i32) == i / 2 + 1);
                CHECK(teams_are(2));                  /* and through the refresh: pairs, by the stub */
            }
    }
    printf("ok    Duo: paired by fix 4's stub only; sd_teams leaves it alone (any Duo URL, no game mode)\n");

    /* Bots: team Showdown spawns 2N - 1; everything else the mode's own count. */
    for (size = 2; size <= 4; size++) {
        char url[32];
        sprintf(url, "?TeamSize=%d", size);
        teams_setup(3, url);
        F(tgm, 0x518, i32) = 1;
        spawn_bots_calls = 0;
        sd_spawn_bots(tgm);
        CHECK(F(tgm, 0x518, i32) == 2 * size - 1 && spawn_bots_calls == 1);
    }
    teams_setup(3, 0);
    F(tgm, 0x518, i32) = 1;
    sd_spawn_bots(tgm);
    CHECK(F(tgm, 0x518, i32) == 1);
    teams_setup(2, "?TeamSize=3");
    F(tgm, 0x518, i32) = 23;
    sd_spawn_bots(tgm);
    CHECK(F(tgm, 0x518, i32) == 23);
    spawn_bots_calls = 0;
    sd_spawn_bots(0);
    CHECK(spawn_bots_calls == 1);
    printf("ok    team Showdown spawns 2N - 1 bots (N = 2, 3, 4); 1v1 and ClassicTeams keep their count\n");

    /* The team win (fix 7) for trios and quads of 24: 8 and 6 teams. */
    for (size = 2; size <= 4; size++) {
        char url[32];
        int t, k, teams = NP / size;
        sprintf(url, "?TeamSize=%d", size);
        teams_setup(2, url);
        CHECK(teams_are(size));
        F(tgm, 0x74d, u8) = 0;
        stock_end = 0;
        CHECK(sd_should_end(tgm) == 0);
        for (t = 1; t < teams - 1; t++)               /* every team but the first and last is out... */
            for (k = 0; k < size; k++) team_die(t * size + k);
        CHECK(sd_should_end(tgm) == 0);               /* ...but team 1 and the last are alive */
        for (k = 0; k < size - 1; k++) team_die((teams - 1) * size + k);
        CHECK(sd_should_end(tgm) == 0);               /* one of the last team left */
        team_die(NP - 1);
        CHECK(sd_should_end(tgm) == 1);               /* only team 1: it won */
        for (k = 0; k < size - 1; k++) team_die(k);
        CHECK(sd_should_end(tgm) == 1);               /* its last member standing */
    }
    teams_setup(2, "?TeamSize=4");                    /* quads: a lone survivor of another team wins */
    CHECK(teams_are(4));
    for (i = 0; i < NP - 1; i++) team_die(i);
    CHECK(sd_should_end(tgm) == 1);
    printf("ok    team win: Duo, Trios and Quads of 24 end when one team is left, not before\n");
}

/* ---------------------------------------------------------------- Showdown */

#define MAXF 8
static u8 *sgm, *sgs, *fc[MAXF], *fps[MAXF], *fhud;
static i32 fcw[MAXF][2], fpw[512][2];
static int nf;

static u8 *new_pawn(u8 *c)
{
    u8 *p = new_obj(cls_char), *h = new_obj(0), *st = new_obj(0);
    reg(p);
    F(p, 0x438, u8 *) = c;
    F(p, 0x420, u8 *) = F(c, 0x420, u8 *);
    F(p, 0x830, u8 *) = h;                            /* health 75 of 100 */
    F(h, 0x10, float) = 75.0f; F(h, 0x14, float) = 100.0f;
    F(p, 0x828, u8 *) = st;                           /* stamina 40 of 80 */
    F(st, 0x10, float) = 40.0f; F(st, 0x14, float) = 80.0f;
    F(c, 0x408, u8 *) = p;
    weak_set(fpw[F(world, 0x1a0, i32)], p);
    F(world, 0x1a0, i32)++;
    return p;
}
static void restart_player(u8 *g, u8 *c) { (void)g; restarts++; new_pawn(c); }
static void unpossess(u8 *c) { F(c, 0x408, u8 *) = 0; }
static void destroy(u8 *a) { kill_obj(a); }

/* You (a PlayerController) and n - 1 bots, in that order in PlayerArray. */
static void showdown_setup(int n, u8 type, const char *url)
{
    int i;
    u8 **arr = (u8 **)calloc(MAXF, sizeof(u8 *));
    u8 *recs = (u8 *)calloc(MAXF, REC);
    world = new_obj(0);
    reg(world);
    sgm = new_obj(cls_gm);
    sgs = new_obj(0);
    fhud = new_obj(cls_hud);
    F(world, 0xf0, u8 *) = sgm;
    F(sgm, GM_TYPE, u8) = type;
    F(sgm, GM_GS, u8 *) = sgs;
    F(sgs, 0x4e4, u8) = type;
    F(sgs, 0x4e8, i32) = 10;
    if (url) options(sgm, url);
    F(world, 0x178, void *) = fcw;
    F(world, 0x180, i32) = n;
    F(world, 0x198, void *) = fpw;
    F(world, 0x1a0, i32) = 0;
    for (i = 0; i < n; i++) {
        char name[16];
        fc[i] = new_obj(i ? cls_ai : cls_pc);
        fps[i] = new_obj(cls_ps);
        reg(fc[i]);
        weak_set(fcw[i], fc[i]);
        F(fc[i], 0x420, u8 *) = fps[i];
        F(fps[i], 0x5b4, u8) = 1;
        F(fps[i], PS_REC, u8 *) = recs + i * REC;
        F(fps[i], PS_INDEX, i32) = i;
        sprintf(name, i ? "Bot|%d" : "You", i);
        *(FStr *)(fps[i] + 0x408) = str(name);
        arr[i] = fps[i];
        F(recs + i * REC, 0x10, u8 *) = fps[i];
        F(recs + i * REC, 0x28, u8) = 1;
        new_pawn(fc[i]);
    }
    F(fc[0], 0x490, u8 *) = fhud;
    F(sgs, 0x418, u8 **) = arr;
    F(sgs, 0x420, i32) = n;
    F(sgs, 0x468, u8 *) = recs;
    F(sgs, 0x470, i32) = n;
    nf = n;
    stock_end = 0;
}

static void fdie(int i) { F(F(sgs, 0x468, u8 *) + i * REC, 0x28, u8) = 0; }
static int series_msg(const char *want) { return !strncmp(last_message("SDR|"), want, strlen(want)); }

/* The 3 black seconds, then the reset (both sides respawned), then the grace. */
static void next_round(int round)
{
    char want[32];
    int r = restarts;
    CHECK(sd_should_end(sgm) == 0 && sd_should_end(sgm) == 0);
    CHECK(sd_should_end(sgm) == 0);
    CHECK(restarts == r + nf);
    sprintf(want, "SDR|S|%d|", round);
    CHECK(series_msg(want));
}

static void test_showdown(void)
{
    int i, size;
    /* 1v1: the series as before. */
    showdown_setup(2, 3, "?bEnableBots=true?game=/Game/Blueprints/GameMode/VictoryGameMode_Lightning.VictoryGameMode_Lightning_C");
    nmessages = 0;
    start_inventory_calls = 0;
    CHECK(sd_should_end(sgm) == 0);
    CHECK(series_msg("SDR|S|1|0|0|") && start_inventory_calls == 1);
    CHECK(sd_should_end(sgm) == 0);
    fdie(1);
    CHECK(sd_should_end(sgm) == 0 && series_msg("SDR|E|1|1|0|W"));
    for (i = 2; i <= 4; i++) {
        char want[32];
        next_round(i);
        CHECK(sd_should_end(sgm) == 0 && sd_should_end(sgm) == 0);      /* the grace */
        fdie(1);
        sprintf(want, i < 4 ? "SDR|E|%d|%d|0|W" : "SDR|O|%d|%d|0|W", i, i);
        CHECK(sd_should_end(sgm) == (i == 4) && series_msg(want));
    }
    CHECK(sd_should_end(sgm) == 1);
    CHECK(!*last_message("TMS|"));
    printf("ok    Showdown 1v1: rounds, resets, first to 4 (unchanged)\n");

    /* Team Showdown: N v N, sd_teams' teams (you and N - 1 bots, then N bots). */
    for (size = 2; size <= 4; size++) {
        char url[48], want[32];
        int k, mine_dead = 0;
        sprintf(url, "?bEnableBots=true?TeamSize=%d", size);
        showdown_setup(2 * size, 3, url);
        nmessages = 0;
        start_inventory_calls = 0;
        CHECK(sd_should_end(sgm) == 0 && !*last_message("SDR|"));        /* no teams yet: no series */
        refresh(sgs);
        for (k = 0; k < 2 * size; k++) CHECK(F(fps[k], 0x490, i32) == k / size + 1);
        CHECK(sd_should_end(sgm) == 0 && series_msg("SDR|S|1|0|0|"));
        CHECK(start_inventory_calls == 2 * size - 1);                   /* every bot gets the kit */
        for (k = size; k < 2 * size - 1; k++) fdie(k);                   /* all rivals but one */
        CHECK(sd_should_end(sgm) == 0);
        fdie(0);                                                          /* you are down, a teammate stands */
        CHECK(sd_should_end(sgm) == 0);
        fdie(2 * size - 1);
        CHECK(sd_should_end(sgm) == 0 && series_msg("SDR|E|1|1|0|W"));  /* your team's round */
        next_round(2);
        CHECK(sd_should_end(sgm) == 0 && sd_should_end(sgm) == 0);
        for (k = 0; k < size; k++) { fdie(k); mine_dead++; }             /* your whole team */
        CHECK(sd_should_end(sgm) == 0 && series_msg("SDR|E|2|1|1|L"));
        for (i = 3; i <= 5; i++) {
            next_round(i);
            CHECK(sd_should_end(sgm) == 0 && sd_should_end(sgm) == 0);
            for (k = size; k < 2 * size; k++) fdie(k);
            sprintf(want, i < 5 ? "SDR|E|%d|%d|1|W" : "SDR|O|%d|%d|1|W", i, i - 1);
            CHECK(sd_should_end(sgm) == (i == 5) && series_msg(want));
        }
        if (size > 2) {
            /* The teammates the game's panel doesn't show, once a second. */
            const char *m = last_message("TMS|");
            char w[96];
            CHECK(*m);
            sprintf(w, "TMS|%d|", size - 1);
            CHECK(!strncmp(m, w, strlen(w)));
        } else {
            CHECK(!*last_message("TMS|"));
        }
    }
    printf("ok    team Showdown 2v2, 3v3, 4v4: a round ends when one team is down, first to 4\n");
}

static void test_team_hud(void)
{
    const char *m;
    /* Duo: the game's panel shows the one teammate; nothing more. */
    showdown_setup(4, 2, "?TeamSize=2");
    nmessages = 0;
    refresh(sgs);
    sd_should_end(sgm);
    CHECK(!*last_message("TMS|"));
    showdown_setup(4, 2, 0);
    refresh(sgs);
    sd_should_end(sgm);
    CHECK(!*last_message("TMS|"));

    /* Trios: you, Bot|1, Bot|2. The panel shows Bot|1 (its pawn at HUD +0x658). */
    showdown_setup(6, 2, "?TeamSize=3");
    nmessages = 0;
    refresh(sgs);
    sd_should_end(sgm);
    m = last_message("TMS|");
    CHECK(!strcmp(m, "TMS|2|75|50|1|Bot/1|75|50|1|Bot/2"));             /* no panel teammate yet: both */
    weak_set((i32 *)(fhud + 0x658), F(fc[1], 0x408, u8 *));
    sd_should_end(sgm);
    CHECK(!strcmp(last_message("TMS|"), "TMS|1|75|50|1|Bot/2"));
    fdie(2);
    unpossess(fc[2]);
    sd_should_end(sgm);
    CHECK(!strcmp(last_message("TMS|"), "TMS|1|0|0|0|Bot/2"));           /* down */
    kill_obj(F(fc[1], 0x408, u8 *));                                     /* the panel's pawn is gone... */
    sd_should_end(sgm);
    CHECK(!strcmp(last_message("TMS|"), "TMS|1|0|0|0|Bot/2"));           /* ...still not reported twice */
    printf("ok    Trios HUD: the teammates beyond the game's panel, once a second; none in Duo\n");

    /* Quads: three teammates, the panel shows one. */
    showdown_setup(8, 2, "?TeamSize=4");
    nmessages = 0;
    refresh(sgs);
    weak_set((i32 *)(fhud + 0x658), F(fc[2], 0x408, u8 *));
    F(F(fc[3], 0x408, u8 *), 0x830, u8 *) = 0;                          /* no health component */
    sd_should_end(sgm);
    CHECK(!strcmp(last_message("TMS|"), "TMS|2|75|50|1|Bot/1|0|50|1|Bot/3"));
    F(fc[0], 0x490, u8 *) = 0;                                           /* no HUD: nothing sent */
    nmessages = 0;
    sd_should_end(sgm);
    CHECK(!*last_message("TMS|"));
    printf("ok    Quads HUD: two teammates beyond the panel; no HUD, no message\n");

    /* The team summary, once a match: who is on your team, by TeamNumber. */
    showdown_setup(6, 2, "?TeamSize=3");
    nmessages = 0;
    refresh(sgs);
    sd_should_end(sgm);
    CHECK(!strcmp(last_message("Your team"), "Your team of 3: Bot|1, Bot|2"));
    sd_should_end(sgm);
    CHECK(nmessages == 3);                                               /* TMS twice, the summary once */
    showdown_setup(8, 2, "?TeamSize=4");
    nmessages = 0;
    refresh(sgs);
    sd_should_end(sgm);
    CHECK(!strcmp(last_message("Your team"), "Your team of 4: Bot|1, Bot|2, Bot|3"));
    showdown_setup(4, 2, 0);                                             /* Duo: the stub's pair */
    nmessages = 0;
    refresh(sgs);
    sd_should_end(sgm);
    CHECK(!strcmp(last_message("Your team"), "Your team of 2: Bot|1"));
    CHECK(!*last_message("TMS|"));
    /* Trios whose teams stayed pairs (the in-game failure this tells apart). */
    showdown_setup(6, 2, "?TeamSize=3");
    nmessages = 0;
    {
        int k;
        for (k = 0; k < 6; k++) F(fps[k], 0x490, i32) = k / 2 + 1;
    }
    sd_should_end(sgm);
    CHECK(!strcmp(last_message("Your team"), "Your team of 3: Bot|1"));
    /* Too early, then no team at all by 10 s. */
    showdown_setup(6, 2, "?TeamSize=3");
    nmessages = 0;
    F(sgs, 0x4e8, i32) = 2;
    sd_should_end(sgm);
    CHECK(!*last_message("Your team"));
    F(sgs, 0x4e8, i32) = 5;
    sd_should_end(sgm);
    CHECK(!*last_message("Your team"));                                  /* no team yet: wait */
    F(sgs, 0x4e8, i32) = 10;
    sd_should_end(sgm);
    CHECK(!strcmp(last_message("Your team"), "Your team of 3: no team"));
    /* Solo and Showdown never. */
    showdown_setup(2, 3, 0);
    nmessages = 0;
    sd_should_end(sgm);
    CHECK(!*last_message("Your team"));
    printf("ok    team summary once a match: \"Your team of N: names\" (Duo, Trios, Quads; pairs, no team)\n");
}

/* ---------------------------------------------------------------- Chokening */


static u8 *ctrl[3], *pawn[3], *cps[3], *pylon[3], *wound;
static i32 ctrl_weak[3][2];
static u8 *in_area[8];

static void choke_setup(void)
{
    int i;
    world = new_obj(0);
    reg(world);
    for (i = 0; i < 3; i++) {
        ctrl[i] = new_obj(i ? cls_ai : cls_pc);
        pawn[i] = new_obj(cls_pawn);
        cps[i] = new_obj(cls_ps);
        reg(ctrl[i]);
        F(ctrl[i], 0x420, u8 *) = cps[i];
        F(ctrl[i], 0x408, u8 *) = pawn[i];
        F(pawn[i], 0x438, u8 *) = ctrl[i];
        F(cps[i], 0x490, i32) = 1;                   /* 0, 1 are a team (Duo) ... */
        weak_set(ctrl_weak[i], ctrl[i]);
    }
    F(cps[2], 0x490, i32) = 2;                       /* ... 2 is a rival */
    F(world, 0x178, void *) = ctrl_weak;             /* UWorld controller list */
    F(world, 0x180, i32) = 3;
    for (i = 0; i < 3; i++) {
        pylon[i] = new_obj(cls_pylon);
        reg(pylon[i]);
        F(pylon[i], 0x438, u8 *) = cls_wound;        /* WoundClass */
        F(pylon[i], 0x488, u8 **) = in_area;
        actors[nactors++] = pylon[i];
    }
    F(pylon[0], 0x480, u8) = 1;                      /* Rising, no instigator: the console's */
    F(pylon[1], 0x480, u8) = 1;
    F(pylon[1], 0x150, u8 *) = pawn[2];              /* Rising, a user of its own */
    F(pylon[2], 0x480, u8) = 2;                      /* Active before the console */
    wound = new_obj(cls_wound);
}

static u8 *gas_on(u8 *victim, int in0)
{
    F(wound, 0x98, u8 *) = victim;
    in_area[0] = victim;
    F(pylon[0], 0x490, i32) = in0;
    F(pylon[1], 0x490, i32) = 0;
    F(pylon[2], 0x490, i32) = 0;
    return sd_gas_instigator(wound);
}

static void test_chokening(void)
{
    FString use = str("PylonUse"), other = str("PylonUsed"), name = str("someone");
    choke_setup();
    CHECK(gas_on(pawn[2], 1) == 0);                  /* nothing recorded yet */
    sd_rating(cps[0], &use, &name, 1);               /* a tank used directly */
    sd_rating(cps[0], &other, &name, 4);
    CHECK(rating_calls == 2);
    CHECK(gas_on(pawn[2], 1) == 0);
    printf("ok    Chokening: other rating activities record nothing (the stock call still runs)\n");

    sd_rating(cps[0], &use, &name, 4);               /* the console */
    CHECK(rating_calls == 3);
    CHECK(gas_on(pawn[2], 1) == ctrl[0]);            /* a rival in the gas: the user's kill */
    CHECK(gas_on(pawn[1], 1) == 0);                  /* the user's teammate: no */
    CHECK(gas_on(pawn[0], 1) == 0);                  /* the user: no */
    F(cps[2], 0x490, i32) = 1;                       /* Trios: a second teammate, no either */
    CHECK(gas_on(pawn[2], 1) == 0);
    F(cps[2], 0x490, i32) = 2;
    CHECK(gas_on(pawn[2], 0) == 0);                  /* not in that pylon's area */
    F(wound, 0x10, u8 *) = cls_other_wound;
    CHECK(gas_on(pawn[2], 1) == 0);                  /* another wound class */
    F(wound, 0x10, u8 *) = cls_wound;
    F(wound, 0x150, u8 *) = pawn[1];
    CHECK(gas_on(pawn[2], 1) == ctrl[1]);            /* a wound with its own instigator: stock */
    F(wound, 0x150, u8 *) = 0;
    /* Pylon 1 (own user) and 2 (already active) aren't the console's. */
    in_area[0] = pawn[2];
    F(wound, 0x98, u8 *) = pawn[2];
    F(pylon[0], 0x490, i32) = 0; F(pylon[1], 0x490, i32) = 1;
    CHECK(sd_gas_instigator(wound) == 0);
    F(pylon[1], 0x490, i32) = 0; F(pylon[2], 0x490, i32) = 1;
    CHECK(sd_gas_instigator(wound) == 0);
    printf("ok    Chokening: its pylons' gas kills are the user's; not the user's own, not a teammate's\n");

    /* Solo (no teams): a bot in the gas is the user's kill, team 0 isn't a team. */
    F(cps[0], 0x490, i32) = 0; F(cps[1], 0x490, i32) = 0;
    CHECK(gas_on(pawn[1], 1) == ctrl[0]);
    F(cps[0], 0x490, i32) = 1; F(cps[1], 0x490, i32) = 1;
    /* The user's controller gone: no credit (and no stale pointer). */
    kill_obj(ctrl[0]);
    CHECK(gas_on(pawn[2], 1) == 0);
    alive_obj[1] = 1;
    CHECK(gas_on(pawn[2], 1) == ctrl[0]);
    /* Another world (a new match): nothing. */
    {
        u8 *w = world;
        world = new_obj(0);
        CHECK(gas_on(pawn[2], 1) == 0);
        world = w;
    }
    /* The pylon goes Inert: the once-a-second check drops it for good. */
    F(pylon[0], 0x480, u8) = 0;
    CHECK(gas_on(pawn[2], 1) == 0);
    F(gm, GM_TYPE, u8) = 1;
    sd_should_end(gm);
    F(pylon[0], 0x480, u8) = 1;                      /* triggered again by the schedule */
    CHECK(gas_on(pawn[2], 1) == 0);
    printf("ok    Chokening: gone user, new match and an Inert pylon end the credit\n");
}

int main(void)
{
    image = (u8 *)VirtualAlloc(0, 0x2600000, MEM_RESERVE, PAGE_NOACCESS);
    CHECK(image);
    cls_ps = new_class(); cls_pc = new_class(); cls_ai = new_class(); cls_pylon = new_class();
    cls_wound = new_class(); cls_other_wound = new_class(); cls_pawn = new_class();
    cls_char = new_class(); cls_hud = new_class(); cls_gm = new_class(); cls_weapon = new_class();
    cls_pickup = new_class();
    vtable[0x120 / 8] = (void *)get_world;
    vtable[0x290 / 8] = (void *)destroy;
    vtable[0x650 / 8] = (void *)unpossess;
    vtable[0x700 / 8] = (void *)restart_player;
    hook(0x244d30, (void *)ffa_should_end);
    hook(0x249d20, (void *)ps_has_left);
    hook(0x249ca0, (void *)ps_is_alive);
    hook(0x69c470, (void *)weak_get);
    hook(0x69c2a0, (void *)weak_set);
    hook(0x2494d0, (void *)rating);
    hook(0x3039c0, (void *)ret_ps);
    hook(0x303820, (void *)ret_pc);
    hook(0x302b20, (void *)ret_ai);
    hook(0x302980, (void *)ret_pylon);
    hook(0x1336ca0, (void *)actors_of_class);
    hook(0x50c510, (void *)mem_free);
    hook(0x1119150, (void *)instigator_ctrl);
    hook(0x24e7e0, (void *)set_team);
    hook(0x243c80, (void *)sort_scores);
    hook(0x2320f0, (void *)spawn_bots);
    hook(0x262d20, (void *)comp_value);              /* health, max health */
    hook(0x2634c0, (void *)comp_max);
    hook(0x28ee40, (void *)comp_value);              /* stamina, max stamina */
    hook(0x28f9c0, (void *)comp_max);
    hook(0x1a3420, (void *)string_resize);
    hook(0x202900, (void *)hud_message);
    hook(0x249040, (void *)ps_id);
    hook(0x23cae0, (void *)find_record);
    hook(0x302cc0, (void *)ret_char);
    hook(0x3046c0, (void *)ret_hud);
    hook(0x303000, (void *)ret_gm);
    hook(0x303d00, (void *)ret_weapon);
    hook(0x3034e0, (void *)ret_pickup);
    hook(0x267090, (void *)start_inventory);
    hook(0x268fa0, (void *)clear_inventory);
    hook(0x27a810, (void *)spawn_weapon);
    VirtualAlloc(image + 0x2567000, 0x1000, MEM_COMMIT, PAGE_READWRITE);   /* L"/Script/Victory" */
    sd_self_rva = (u64)&sd_self_rva - (u64)image;
    test_duo();
    test_chokening();
    test_team_sizes();
    test_showdown();
    test_team_hud();
    printf("all native module tests passed\n");
    return 0;
}
