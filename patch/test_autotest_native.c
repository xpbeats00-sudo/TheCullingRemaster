/* Runs the module's autotest (autotest.c, compiled into showdown_rounds.c
 * with the blob's own flags) against fake game objects: a fake image holds a
 * jump at every game function the tested paths call, to the stand-ins below,
 * its import table slots point at the real kernel32 functions (the results
 * file) and at a fake clock.
 *
 * Built and run by test_autotest_native.py, which sets LOCALAPPDATA to a
 * temporary folder and reads the results file afterwards. Prints "ok ..."
 * lines, exits 1 on the first failure.
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
void sd_gm_tick(u8 *gm, float dt);
char sd_should_end(u8 *gm);

#define F(p, off, type) (*(type *)((u8 *)(p) + (off)))
#define CHECK(c) do { if (!(c)) { printf("FAIL line %d: %s\n", __LINE__, #c); exit(1); } } while (0)

static u8 *image;
static u8 *world;
static void *vtable[0x200];
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
    F(c, 0x88, u8 **) = chain;
    F(c, 0x90, i32) = 0;
    return c;
}

static u8 *cls_ps, *cls_pc, *cls_ai, *cls_char, *cls_hud;
static u8 *ret_ps(void) { return cls_ps; }
static u8 *ret_pc(void) { return cls_pc; }
static u8 *ret_ai(void) { return cls_ai; }
static u8 *ret_char(void) { return cls_char; }
static u8 *ret_hud(void) { return cls_hud; }

static u8 *objs[4096];
static int nobjs;
static void weak_set(i32 *w, u8 *o)
{
    int i;
    w[0] = -1; w[1] = 0;
    for (i = 0; o && i < nobjs; i++)
        if (objs[i] == o) { w[0] = i; w[1] = 1; }
}
static u8 *weak_get(i32 *w) { return w[1] && w[0] >= 0 ? objs[w[0]] : 0; }
static int reg(u8 *o) { objs[nobjs] = o; return nobjs++; }

/* ---------------------------------------------------------------- stand-ins */
#define PS_LEFT  0x800
#define P_ALIVE  0x900                    /* fake: the pawn's alive flag */
#define C_HEALTH 0x830
static int stock_ticks, stock_end_calls;
static char stock_end;
static void stock_tick(u8 *gm, float dt) { (void)gm; (void)dt; stock_ticks++; }
static char ffa_should_end(u8 *gm) { (void)gm; stock_end_calls++; return stock_end; }
static char ps_has_left(u8 *ps) { return F(ps, PS_LEFT, u8); }
static u8 *pawn_of_ps(u8 *ps);
static char ps_is_alive(u8 *ps) { u8 *p = pawn_of_ps(ps); return p && F(p, P_ALIVE, u8); }
static char ch_alive(u8 *pawn) { return F(pawn, P_ALIVE, u8); }
static float health(u8 *c) { return F(c, 0x10, float); }
static float max_health(u8 *c) { return F(c, 0x14, float); }
static int set_health_calls;
static void set_health(u8 *c, float v, char b) { (void)b; F(c, 0x10, float) = v; set_health_calls++; }
static void mem_free(void *p) { free(p); }
typedef struct { u16 *data; i32 num, max; } FStr;
static void string_resize(FStr *s, i32 n, i32 prev) { (void)prev; s->data = (u16 *)calloc(n + 1, 2); s->max = n; }
static i32 ps_kills(u8 *ps) { return F(ps, 0x950, i32); }
static FStr *ps_killer(u8 *ps, FStr *out) { (void)ps; string_resize(out, 2, 0); out->data[0] = 'K'; out->num = 2; return out; }
static int hud_messages;
static void hud_message(u8 *hud, FStr *s, float t) { (void)hud; (void)t; free(s->data); hud_messages++; }

static struct { u8 *victim, *by, *causer; float dmg; } damage[64];
static int ndamage;
static float apply_damage(u8 *victim, float dmg, u8 *by, u8 *causer, u8 *cls)
{
    (void)cls;
    CHECK(ndamage < 64);
    damage[ndamage].victim = victim; damage[ndamage].by = by; damage[ndamage].causer = causer; damage[ndamage].dmg = dmg;
    ndamage++;
    F(victim, P_ALIVE, u8) = 0;
    return dmg;
}
static char console_cmd[64];
static int console_calls;
static void console(u8 *ctx, FStr *cmd, u8 *pc)
{
    int i;
    (void)ctx; (void)pc;
    console_calls++;
    for (i = 0; i < cmd->num && i < 63; i++) console_cmd[i] = (char)cmd->data[i];
}
static u64 clock_ms = 1000000;
static u64 WINAPI fake_ticks(void) { return clock_ms; }

static void hook(u64 rva, void *fn)
{
    u8 *at = image + rva;
    VirtualAlloc((void *)((u64)at & ~0xfffULL), 0x2000, MEM_COMMIT, PAGE_EXECUTE_READWRITE);
    at[0] = 0x48; at[1] = 0xb8;                         /* mov rax, fn; jmp rax */
    memcpy(at + 2, &fn, 8);
    at[10] = 0xff; at[11] = 0xe0;
}

/* ---------------------------------------------------------------- a match */
static u8 *gm, *gs, *ctrls[8], *pss[8], *pawns[8], *comps[8], *roots[8];
static i32 nfighters;
static u8 *pawn_of_ps(u8 *ps)
{
    int i;
    for (i = 0; i < nfighters; i++)
        if (pss[i] == ps) return pawns[i];
    return 0;
}

static void set_options(const char *s)
{
    FStr *o = (FStr *)(gm + 0x400);
    i32 i, n = (i32)strlen(s) + 1;
    o->data = (u16 *)calloc(n, 2);
    for (i = 0; i < n; i++) o->data[i] = (u16)s[i];
    o->num = o->max = n;
}

static void setup(const char *options, const i32 *teams, i32 n)
{
    i32 *list;
    u8 **players;
    int i;
    nobjs = 0;
    world = new_obj(0);
    gm = new_obj(0);
    gs = new_obj(0);
    reg(gm);
    F(gm, 0x458, u8 *) = gs;
    F(gm, 0x4e0, u8) = 2;                               /* ClassicTeams (Duo) */
    F(gs, 0x4e4, u8) = 2;
    set_options(options);
    list = (i32 *)calloc(16, 8);
    players = (u8 **)calloc(16, sizeof(u8 *));
    nfighters = n;
    for (i = 0; i < n; i++) {
        ctrls[i] = new_obj(i == 0 ? cls_pc : cls_ai);
        pss[i] = new_obj(cls_ps);
        pawns[i] = new_obj(cls_char);
        comps[i] = new_obj(0);
        roots[i] = new_obj(0);
        reg(ctrls[i]); reg(pss[i]); reg(pawns[i]); reg(comps[i]); reg(roots[i]);
        F(ctrls[i], 0x420, u8 *) = pss[i];
        F(ctrls[i], 0x408, u8 *) = pawns[i];
        F(pss[i], 0x490, i32) = teams[i];
        F(pawns[i], P_ALIVE, u8) = 1;
        F(pawns[i], C_HEALTH, u8 *) = comps[i];
        F(pawns[i], 0x1e0, u8 *) = roots[i];
        F(roots[i], 0x1a0, float) = 100.0f * i;
        F(comps[i], 0x10, float) = 100.0f;
        F(comps[i], 0x14, float) = 100.0f;
        weak_set(list + 2 * i, ctrls[i]);
        players[i] = pss[i];
    }
    F(world, 0x178, i32 *) = list;
    F(world, 0x180, i32) = n;
    F(gs, 0x418, u8 **) = players;
    F(gs, 0x420, i32) = n;
}

static void frames(int seconds, int elapsed_from)
{
    int s, f;
    for (s = 0; s < seconds; s++) {
        F(gs, 0x4e8, i32) = elapsed_from + s;
        for (f = 0; f < 10; f++) {
            clock_ms += 100;
            sd_gm_tick(gm, 0.1f);
        }
    }
}

static void reset_counts(void) { stock_ticks = ndamage = console_calls = set_health_calls = 0; console_cmd[0] = 0; }

int main(int argc, char **argv)
{
    static const i32 duo[6] = {1, 1, 2, 2, 3, 3};
    int i, ticks;
    (void)argc; (void)argv;
    image = (u8 *)VirtualAlloc(0, 0x2600000, MEM_RESERVE, PAGE_NOACCESS);
    CHECK(image);
    cls_ps = new_class(); cls_pc = new_class(); cls_ai = new_class(); cls_char = new_class(); cls_hud = new_class();
    vtable[0x120 / 8] = (void *)get_world;
    hook(0x2456b0, (void *)stock_tick);                 /* AT_GM_TICK */
    hook(0x244d30, (void *)ffa_should_end);
    hook(0x249d20, (void *)ps_has_left);
    hook(0x249ca0, (void *)ps_is_alive);
    hook(0x26e0d0, (void *)ch_alive);
    hook(0x69c470, (void *)weak_get);
    hook(0x69c2a0, (void *)weak_set);
    hook(0x3039c0, (void *)ret_ps);
    hook(0x303820, (void *)ret_pc);
    hook(0x302b20, (void *)ret_ai);
    hook(0x302cc0, (void *)ret_char);
    hook(0x3046c0, (void *)ret_hud);
    hook(0x262d20, (void *)health);
    hook(0x2634c0, (void *)max_health);
    hook(0x263850, (void *)set_health);
    hook(0x50c510, (void *)mem_free);
    hook(0x1a3420, (void *)string_resize);
    hook(0x202900, (void *)hud_message);
    hook(0x2483b0, (void *)ps_kills);
    hook(0x248270, (void *)ps_killer);
    hook(0x132cec0, (void *)apply_damage);
    hook(0x13ae190, (void *)console);
    VirtualAlloc(image + 0x2567000, 0x1000, MEM_COMMIT, PAGE_READWRITE);   /* L"/Script/Victory" */
    VirtualAlloc(image + 0x253f000, 0x1000, MEM_COMMIT, PAGE_READWRITE);   /* the import table */
    F(image, 0x253f2a0, void *) = (void *)CreateDirectoryW;
    F(image, 0x253f2a8, void *) = (void *)CreateFileW;
    F(image, 0x253f258, void *) = (void *)WriteFile;
    F(image, 0x253f280, void *) = (void *)GetEnvironmentVariableW;
    F(image, 0x253f5d8, void *) = (void *)fake_ticks;
    sd_self_rva = (u64)&sd_self_rva - (u64)image;

    /* 1. No ?RemasterAutoTest=: the stock tick, nothing else. */
    setup("Jungle_P?bEnableBots=true?game=/Game/X.X_C", duo, 6);
    reset_counts();
    frames(130, 0);
    CHECK(stock_ticks == 1300 && ndamage == 0 && console_calls == 0 && set_health_calls == 0);
    printf("ok    no ?RemasterAutoTest=: 1300 frames, every one the stock tick and nothing else\n");

    /* 2. An unknown scenario, or the option's name as a value elsewhere: inert too. */
    setup("Jungle_P?game=/Game/X.X_C?RemasterAutoTest=bogus", duo, 6);
    reset_counts();
    frames(130, 0);
    CHECK(stock_ticks == 1300 && ndamage == 0 && console_calls == 0);
    setup("Jungle_P?game=/Game/X.X_C?Name=RemasterAutoTest", duo, 6);
    reset_counts();
    frames(130, 0);
    CHECK(stock_ticks == 1300 && ndamage == 0 && console_calls == 0);
    printf("ok    an unknown scenario (and the name as another option's value) is inert\n");

    /* 3. teamwin in Duo: nothing before 100 s InProgress; then the rivals (teams 2, 3)
       die, three a second, the local player their killer; the teammate never. */
    setup("Jungle_P?bEnableBots=true?game=/Game/X.X_C?RemasterAutoTest=teamwin", duo, 6);
    reset_counts();
    F(comps[0], 0x10, float) = 40.0f;                   /* hurt: kept alive */
    F(comps[1], 0x10, float) = 10.0f;
    frames(5, 90);
    CHECK(ndamage == 0 && stock_ticks == 50);
    CHECK(F(comps[0], 0x10, float) == 100.0f && F(comps[1], 0x10, float) == 100.0f && set_health_calls == 2);
    frames(3, 100);
    CHECK(ndamage == 4);
    for (i = 0; i < ndamage; i++) {
        CHECK(damage[i].victim != pawns[0] && damage[i].victim != pawns[1]);
        CHECK(damage[i].by == ctrls[0] && damage[i].causer == pawns[0] && damage[i].dmg >= 1000.0f);
    }
    printf("ok    teamwin: the 4 rivals die from 100 s on (3 a second), the local player as killer; you and your mate kept alive\n");

    /* The match ends (the stock check): 25 s later the console's "quit", once. */
    stock_end = 1;
    CHECK(sd_should_end(gm) == 1);
    stock_end = 0;
    frames(20, 103);
    CHECK(console_calls == 0);
    frames(10, 123);
    CHECK(console_calls == 1 && strcmp(console_cmd, "quit") == 0);
    ticks = stock_ticks;
    frames(5, 133);
    CHECK(console_calls == 1 && stock_ticks == ticks + 50);
    printf("ok    the match's end, then \"quit\" through ExecuteConsoleCommand 25 s later, once; the stock tick goes on\n");

    /* 4. A later match without the option, on the same GameMode address: off again. */
    set_options("Jungle_P?game=/Game/X.X_C");
    F(gm, 0x458, u8 *) = gs = new_obj(0);
    F(gs, 0x418, u8 **) = 0;
    reset_counts();
    frames(130, 0);
    CHECK(ndamage == 0 && console_calls == 0 && stock_ticks == 1300);
    printf("ok    a new match without the option on the same GameMode: inert again\n");
    printf("all autotest native tests passed\n");
    return 0;
}
