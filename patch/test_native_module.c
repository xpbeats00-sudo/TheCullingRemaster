/* Runs the native module (showdown_rounds.c, compiled with the blob's own
 * flags) against fake game objects: a fake image holds a jump at every game
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
static u8 *ret_ps(void) { return cls_ps; }
static u8 *ret_pc(void) { return cls_pc; }
static u8 *ret_ai(void) { return cls_ai; }
static u8 *ret_pylon(void) { return cls_pylon; }

/* Weak pointers: an index into this table (serial 0 = none). */
static u8 *objs[256];
static int alive_obj[256];
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
static char ps_has_left(u8 *ps) { return F(ps, PS_LEFT, u8); }
static char ps_is_alive(u8 *ps) { return F(ps, PS_ALIVE, u8); }

static int rating_calls;
static void rating(u8 *ps, void *a, void *p, i32 v) { (void)ps; (void)a; (void)p; (void)v; rating_calls++; }

static u8 *actors[8];
static int nactors;
typedef struct { u8 **data; i32 num, max; } PtrArray;
static void actors_of_class(u8 *ctx, u8 *cls, PtrArray *out)
{
    (void)ctx;
    CHECK(cls == cls_pylon);
    out->data = (u8 **)malloc(sizeof(u8 *) * 8);
    memcpy(out->data, actors, sizeof(u8 *) * nactors);
    out->num = out->max = nactors;
}
static void mem_free(void *p) { free(p); }
static u8 *instigator_ctrl(u8 *a) { u8 *p = F(a, 0x150, u8 *); return p ? F(p, 0x438, u8 *) : 0; }

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

/* ---------------------------------------------------------------- Chokening */

typedef struct { u16 *data; i32 num, max; } FString;
static FString str(const char *s)
{
    FString f;
    i32 i, n = (i32)strlen(s) + 1;
    f.data = (u16 *)calloc(n, 2);
    for (i = 0; i < n; i++) f.data[i] = (u16)s[i];
    f.num = f.max = n;
    return f;
}

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
    vtable[0x120 / 8] = (void *)get_world;
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
    VirtualAlloc(image + 0x2567000, 0x1000, MEM_COMMIT, PAGE_READWRITE);   /* L"/Script/Victory" */
    sd_self_rva = (u64)&sd_self_rva - (u64)image;
    test_duo();
    test_chokening();
    printf("all native module tests passed\n");
    return 0;
}
