/* Runs the native module's stuck-player safety net (unstick.c inside
 * showdown_rounds.c, compiled with the blob's own flags) against fake game
 * objects, like test_weather_native.c: a fake image holds a jump at every
 * game function the module calls, to the stand-ins below. One tick is one
 * call of sd_should_end (the stock check is a stand-in that never ends the
 * match), with GameState's seconds InProgress set to the tick's second.
 *
 * The world: the local player's controller, player state and pawn (an
 * AShooterCharacter: capsule root 50 x 86, CharacterMovement with a mode and
 * an input acceleration), other pawns, and blockers - vertical columns (a
 * tree's trunk: blocks pawns) and one trigger box (only overlaps pawns).
 * CapsuleOverlapComponents is answered from those; K2_TeleportTo moves the
 * pawn (or refuses). Every object a stand-in is handed must be live.
 *
 * test_unstick_native.py builds and runs it ("checks"); exits 1 on the first
 * failed check.
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <math.h>

typedef unsigned long long u64;
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int i32;

extern volatile u64 sd_self_rva;
char sd_should_end(u8 *gm);
void sd_unstick_probe(i32 *out);

#define F(p, off, type) (*(type *)((u8 *)(p) + (off)))
#define UNSTICK_WAIT 20                    /* the module's cooldown (seconds) */
#define CHECK(c) do { if (!(c)) { printf("FAIL line %d: %s\n", __LINE__, #c); exit(1); } } while (0)

static u8 *image;
static void hook(u64 rva, void *fn)
{
    u8 *at = image + rva;
    VirtualAlloc((void *)((u64)at & ~0xfffULL), 0x2000, MEM_COMMIT, PAGE_EXECUTE_READWRITE);
    at[0] = 0x48; at[1] = 0xb8; memcpy(at + 2, &fn, 8);
    at[10] = 0xff; at[11] = 0xe0;
}

/* ---------------------------------------------------------------- objects */
static void *vtable[0x100];
static u8 *world;
static u8 *get_world(u8 *self) { (void)self; return world; }

static u8 *objs[4096];
static int alive_obj[4096], nobjs;
static void weak_set(i32 *w, u8 *o)
{
    int i;
    w[0] = -1; w[1] = 0;
    for (i = 0; o && i < nobjs; i++) if (objs[i] == o) { w[0] = i; w[1] = 1; }
}
static u8 *weak_get(i32 *w) { return w[1] && w[0] >= 0 && alive_obj[w[0]] ? objs[w[0]] : 0; }
static void reg(u8 *o) { objs[nobjs] = o; alive_obj[nobjs] = 1; nobjs++; }
static void kill_obj(u8 *o) { int i; for (i = 0; i < nobjs; i++) if (objs[i] == o) alive_obj[i] = 0; }
static int alive(u8 *o) { int i; for (i = 0; i < nobjs; i++) if (objs[i] == o) return alive_obj[i]; return 0; }

static u8 *new_obj(u8 *cls)
{
    u8 *o = (u8 *)calloc(1, 0x1000);
    F(o, 0, void **) = vtable;
    F(o, 0x10, u8 *) = cls;
    reg(o);
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
static u8 *cls_pc, *cls_ps, *cls_char, *cls_hud;
static u8 *ret_pc(void) { return cls_pc; }
static u8 *ret_ps(void) { return cls_ps; }
static u8 *ret_char(void) { return cls_char; }
static u8 *ret_hud(void) { return cls_hud; }

/* ---------------------------------------------------------------- the match */
static u8 *gm, *gs, *pc, *ps, *hud, *pawn, *root, *move;
static u16 opts[256];
static int ps_left, ps_record_alive = 1, pawn_alive = 1;
static int messages, stock_calls;

static char stock_end(u8 *g) { (void)g; stock_calls++; return 0; }
static char has_left(u8 *p) { CHECK(p == ps); return (char)ps_left; }
static char record_alive(u8 *p) { CHECK(p == ps); return (char)ps_record_alive; }
static int alive_calls;
static char pawn_is_alive(u8 *p) { CHECK(alive(p)); alive_calls++; return (char)pawn_alive; }
static void resize(u16 **s, i32 n, i32 prev) { (void)prev; *s = (u16 *)calloc((size_t)n + 1, 2); }
static wchar_t last_message[256];
static void hud_message(u8 *h, u16 **s, float t)
{
    (void)t;
    CHECK(h == hud);
    wcsncpy(last_message, (wchar_t *)*s, 255);
    messages++;
}
static void mem_free(void *p) { free(p); }

/* Columns (a tree trunk: centre x y, bottom z, top z, radius) block pawns; the
 * trigger box only overlaps them. Other pawns are capsules 50 x 86. */
typedef struct { float x, y, z0, z1, r; u8 *comp; } Column;
static Column cols[8];
static int ncols;
static float trigger[6];                  /* min xyz, max xyz */
static u8 *trigger_comp, *others[4];
static int nothers;
static int overlaps, overlap_pawn_types;
static u8 response(u8 *c, u8 channel)
{
    CHECK(alive(c) && channel == 2);      /* ECC_Pawn */
    return (u8)(c == trigger_comp ? 1 : 2);
}
typedef struct { u8 **data; i32 num, max; } PtrArray;
typedef struct { u8 *data; i32 num, max; } ByteArray;
static void add(PtrArray *out, u8 *c)
{
    if (out->num == out->max) {
        out->max = out->max ? 2 * out->max : 4;
        out->data = (u8 **)realloc(out->data, sizeof(u8 *) * out->max);
    }
    out->data[out->num++] = c;
}
static int capsules_meet(const float *p, float r, float h, float x, float y, float z0, float z1, float cr)
{
    float dx = p[0] - x, dy = p[1] - y;
    return dx * dx + dy * dy < (r + cr) * (r + cr) && p[2] - h < z1 && p[2] + h > z0;
}
static char overlap(u8 *ctx, const float *pos, float radius, float half, const ByteArray *types, u8 *filter,
                    const PtrArray *ignore, PtrArray *out)
{
    int i, pawns;
    CHECK(ctx == pawn && alive(ctx) && !filter);
    CHECK(ignore && ignore->num == 1 && ignore->data[0] == pawn);
    CHECK(types && (types->num == 2 || types->num == 3) && types->data[0] == 0 && types->data[1] == 1);
    CHECK(out && out->num == 0 && !out->data);
    pawns = types->num == 3;
    CHECK(!pawns || types->data[2] == 2);
    overlaps++;
    overlap_pawn_types += pawns;
    for (i = 0; i < ncols; i++)
        if (capsules_meet(pos, radius, half, cols[i].x, cols[i].y, cols[i].z0, cols[i].z1, cols[i].r)) add(out, cols[i].comp);
    if (trigger_comp && pos[0] + radius > trigger[0] && pos[0] - radius < trigger[3] && pos[1] + radius > trigger[1]
        && pos[1] - radius < trigger[4] && pos[2] + half > trigger[2] && pos[2] - half < trigger[5])
        add(out, trigger_comp);
    for (i = 0; pawns && i < nothers; i++) {
        u8 *o = F(others[i], 0x1e0, u8 *);
        const float *q = (const float *)(o + 0x1a0);
        if (capsules_meet(pos, radius, half, q[0], q[1], q[2] - 86.0f, q[2] + 86.0f, 50.0f)) add(out, o);
    }
    return (char)(out->num > 0);
}
static int teleports, teleport_ok = 1;
static float teleported_to[3];
static char teleport(u8 *a, const float *loc, const float *rot)
{
    CHECK(a == pawn && alive(a));
    CHECK(rot[0] == F(root, 0x1ec, float) && rot[1] == F(root, 0x1f0, float) && rot[2] == F(root, 0x1f4, float));
    teleports++;
    if (!teleport_ok) return 0;
    memcpy(teleported_to, loc, sizeof(teleported_to));
    memcpy(root + 0x1a0, loc, 12);
    return 1;
}

static void set_options(const char *o)
{
    int i, n = (int)strlen(o);
    for (i = 0; i < n; i++) opts[i] = (u16)o[i];
    opts[n] = 0;
    F(gm, 0x400, u16 *) = opts;
    F(gm, 0x408, i32) = n + 1;
    F(gm, 0x40c, i32) = n + 1;
}

static i32 *controllers;
static void list_controllers(void)
{
    F(world, 0x178, i32 *) = controllers;
    F(world, 0x180, i32) = 1;
    weak_set(controllers, pc);
}

static void new_pawn(float x, float y, float z)
{
    pawn = new_obj(cls_char);
    root = new_obj(0);
    move = new_obj(0);
    F(pawn, 0x1e0, u8 *) = root;               /* RootComponent */
    F(pawn, 0x470, u8 *) = root;               /* CapsuleComponent */
    F(pawn, 0x468, u8 *) = move;               /* CharacterMovement */
    F(root, 0x1a0, float) = x; F(root, 0x1a4, float) = y; F(root, 0x1a8, float) = z;
    F(root, 0x1ec, float) = 0.0f; F(root, 0x1f0, float) = 135.0f; F(root, 0x1f4, float) = 0.0f;
    F(root, 0x728, float) = 86.0f;             /* CapsuleHalfHeight */
    F(root, 0x72c, float) = 50.0f;             /* CapsuleRadius */
    F(move, 0x1a8, u8) = 1;                    /* Walking */
    F(pc, 0x408, u8 *) = pawn;
    pawn_alive = 1;
}

static void new_match(const char *options)
{
    gm = new_obj(0);
    gs = new_obj(0);
    F(gm, 0x4e0, u8) = 1;                      /* Solo: the stock end check */
    F(gm, 0x458, u8 *) = gs;
    set_options(options);
    pc = new_obj(cls_pc);
    ps = new_obj(cls_ps);
    hud = new_obj(cls_hud);
    F(pc, 0x420, u8 *) = ps;
    F(pc, 0x490, u8 *) = hud;
    list_controllers();
    ps_left = 0;
    ps_record_alive = 1;
    ncols = nothers = 0;
    trigger_comp = 0;
    teleport_ok = 1;
    teleports = overlaps = overlap_pawn_types = messages = stock_calls = 0;
    new_pawn(0.0f, 0.0f, 100.0f);
}

static float *at(void) { return (float *)(root + 0x1a0); }
static void put_at(float x, float y, float z) { at()[0] = x; at()[1] = y; at()[2] = z; }
static void input(float x, float y) { F(move, 0x280, float) = x; F(move, 0x284, float) = y; F(move, 0x288, float) = 0.0f; }
static void mode(u8 m) { F(move, 0x1a8, u8) = m; }

static void tick(i32 t) { F(gs, 0x4e8, i32) = t; CHECK(sd_should_end(gm) == 0); }
static i32 moves(void) { i32 o[4]; sd_unstick_probe(o); return o[0]; }

static void column(float x, float y, float z0, float z1, float r)
{
    Column *c = &cols[ncols++];
    c->x = x; c->y = y; c->z0 = z0; c->z1 = z1; c->r = r;
    c->comp = new_obj(0);
}

/* Walk along +X at walking speed from t0 to t1 (input on): good spots. */
static i32 walk(i32 t0, i32 t1)
{
    i32 t;
    mode(1);
    input(2048.0f, 0.0f);
    for (t = t0; t <= t1; t++) {
        at()[0] += 400.0f;
        tick(t);
    }
    return t1 + 1;
}

static void checks(void)
{
    i32 t, t0, before, m0;
    float good[3];

    /* Normal movement: walking and falling around for a minute, nothing. */
    new_match("?bEnableBots=true?game=/Game/X.X_C");
    for (t = 0; t < 60; t++) {
        mode((u8)(t % 7 == 3 ? 3 : 1));          /* now and then a jump (it moves) */
        input(2048.0f, 0.0f);
        at()[0] += 400.0f;
        at()[2] += t % 7 == 3 ? 60.0f : 0.0f;
        tick(t);
    }
    CHECK(moves() == 0 && teleports == 0 && overlaps == 0 && messages == 0 && stock_calls == 60);
    printf("ok    a minute of walking and jumping: nothing (no query, no move)\n");

    /* Walking into a wall: still, pushing, Walking, nothing overlaps (the
       movement component stops the capsule short of the wall). */
    new_match("");
    t = walk(20, 25);
    column(at()[0] + 50.0f + 30.0f + 0.5f, 0.0f, 0.0f, 600.0f, 30.0f);   /* a trunk just ahead, touching */
    for (; t < 60; t++) tick(t);
    CHECK(moves() == 0 && teleports == 0 && overlaps > 0);
    printf("ok    walking into a tree trunk (still, pushing, not inside it): nothing for 35 s\n");

    /* Perched on a trunk top it can't stand on: Falling, still, pushing -> back
       to where it last walked, once, at the 2nd still tick. */
    new_match("");
    t = walk(20, 25);
    memcpy(good, at(), sizeof(good));
    put_at(good[0] + 120.0f, good[1], good[2] + 200.0f);                 /* jumped onto the elm's trunk top */
    mode(3);
    tick(t++);                                                           /* got there: moved */
    CHECK(moves() == 0);
    tick(t++);                                                           /* still 1 */
    CHECK(moves() == 0 && teleports == 0);
    tick(t++);                                                           /* still 2: moved */
    CHECK(moves() == 1 && teleports == 1 && messages == 1);
    CHECK(at()[0] == good[0] && at()[1] == good[1] && at()[2] == good[2]);
    CHECK(!wcscmp(last_message, L"You were stuck: moved to a free spot"));
    printf("ok    stuck on a tree top (Falling, still, pushing): moved back to where it last walked at the 2nd still tick, once, with a HUD message\n");

    /* Cooldown: stuck again at once -> no second move for 20 s, then one. */
    t0 = t;
    mode(1);
    put_at(good[0] + 400.0f, good[1], good[2]);
    tick(t++);                                                           /* walked off (a good spot) */
    memcpy(good, at(), sizeof(good));
    put_at(good[0] + 120.0f, good[1], good[2] + 200.0f);
    mode(3);
    for (; t < t0 + 19; t++) tick(t);                                   /* the move was at tick t0 - 1 */
    CHECK(moves() == 1 && teleports == 1);
    tick(t++);
    CHECK(moves() == 2 && at()[0] == good[0]);                           /* 20 s after the first */
    printf("ok    cooldown: stuck again right after a move waits until 20 s after it for the next\n");

    /* Not pushing a direction: nothing (an idle player is left where it is). */
    new_match("");
    t = walk(20, 25);
    put_at(at()[0] + 120.0f, 0.0f, 300.0f);
    mode(3);
    input(0.0f, 0.0f);
    for (; t < 40; t++) tick(t);
    CHECK(moves() == 0 && teleports == 0);
    printf("ok    perched but not pushing: nothing\n");

    /* The movement component flips a perch between Falling and Walking: a
       still Walking tick in between neither counts nor resets. */
    new_match("");
    t = walk(20, 25);
    memcpy(good, at(), sizeof(good));
    put_at(good[0] + 120.0f, 0.0f, good[2] + 200.0f);
    mode(3); tick(t++);
    mode(1); tick(t++);
    mode(3); tick(t++);                                                  /* still 1 */
    mode(1); tick(t++);                                                  /* still, Walking, nothing inside */
    CHECK(moves() == 0);
    mode(3); tick(t++);                                                  /* still 2 */
    CHECK(moves() == 1 && at()[0] == good[0]);
    printf("ok    a perch that flips Falling / Walking every tick is caught too\n");

    /* Inside a tree trunk (Walking, still, pushing, the capsule 4 units smaller
       still overlaps a blocker) -> back to where it last walked. */
    new_match("");
    t = walk(20, 25);
    memcpy(good, at(), sizeof(good));
    put_at(good[0] + 300.0f, 0.0f, good[2]);
    column(at()[0] + 20.0f, 0.0f, 0.0f, 600.0f, 40.0f);
    mode(1);
    tick(t++); tick(t++);
    CHECK(moves() == 0);
    tick(t++);
    CHECK(moves() == 1 && at()[0] == good[0] && at()[1] == good[1] && at()[2] == good[2]);
    printf("ok    inside a trunk (Walking, still, pushing): moved back to where it last walked\n");

    /* ... where another pawn now stands: the good spot before it. */
    new_match("");
    t = walk(20, 25);
    memcpy(good, at(), sizeof(good));
    others[0] = new_obj(cls_char);
    F(others[0], 0x1e0, u8 *) = new_obj(0);
    memcpy(F(others[0], 0x1e0, u8 *) + 0x1a0, good, 12);                 /* a bot on the good spot */
    nothers = 1;
    put_at(good[0] + 300.0f, 0.0f, good[2]);
    column(at()[0], 0.0f, 0.0f, 600.0f, 30.0f);                          /* centred in a trunk of 30 */
    tick(t++); tick(t++); tick(t++);
    CHECK(moves() == 1 && at()[0] == good[0] - 400.0f && at()[1] == good[1] && at()[2] == good[2]);
    printf("ok    the last good spot taken by another pawn: the one before it\n");

    /* No good spot (a new pawn stuck in a trunk at once): the first free spot
       of the ring, 110 out (60 out is still in the trunk). */
    new_pawn(90000.0f, 0.0f, 100.0f);
    column(90000.0f, 0.0f, 0.0f, 600.0f, 30.0f);
    input(2048.0f, 0.0f);
    {
        float from[3];
        memcpy(from, at(), sizeof(from));
        t += UNSTICK_WAIT;
        before = moves();
        tick(t++); tick(t++); tick(t++);
        CHECK(moves() == before + 1);
        CHECK(at()[0] == from[0] + 110.0f && at()[1] == from[1] && at()[2] == from[2]);
    }
    printf("ok    no good spot: the first free ring spot (110 out, level; 60 out is still in the trunk)\n");

    /* The last good spot too far (> 800): the ring. */
    new_match("");
    t = walk(20, 25);
    put_at(at()[0] + 900.0f, 0.0f, at()[2] + 200.0f);
    mode(3);
    {
        float from[3];
        tick(t++);
        memcpy(from, at(), sizeof(from));
        tick(t++); tick(t++);
        CHECK(moves() == 1 && at()[0] == from[0] + 60.0f && at()[2] == from[2]);
    }
    printf("ok    the last good spot over 800 away is not used: the nearest free ring spot\n");

    /* A trigger box (overlaps pawns, doesn't block) while pushing a wall: nothing. */
    new_match("");
    t = walk(20, 25);
    trigger_comp = new_obj(0);
    trigger[0] = at()[0] - 500.0f; trigger[1] = -500.0f; trigger[2] = -500.0f;
    trigger[3] = at()[0] + 500.0f; trigger[4] = 500.0f; trigger[5] = 500.0f;
    for (; t < 50; t++) tick(t);
    CHECK(moves() == 0 && overlaps > 0);
    printf("ok    standing still in a trigger volume (overlaps, doesn't block pawns): nothing\n");

    /* Never: dead, the death record, left, spectating, using/crafting,
       ladders/swimming/custom modes, the pods (the first 20 s), ?Unstick=0. */
    {
        static const char *what[] = {"dead pawn", "dead record", "left", "spectator", "using", "recycler",
                                     "flying (ladder)", "swimming", "custom mode", "pods", "Unstick=0"};
        int k;
        for (k = 0; k < 11; k++) {
            new_match(k == 10 ? "?Unstick=0" : "");
            t = k == 9 ? 0 : walk(20, 25);
            if (k == 9) { at()[0] += 400.0f; tick(t++); }
            put_at(at()[0] + 120.0f, 0.0f, at()[2] + 200.0f);
            mode(3);
            input(2048.0f, 0.0f);
            if (k == 0) pawn_alive = 0;
            if (k == 1) ps_record_alive = 0;
            if (k == 2) ps_left = 1;
            if (k == 3) F(ps, 0x42c, u32) = 1;
            if (k == 4) F(pawn, 0xd80, u8) = 1;
            if (k == 5) F(pawn, 0xd80, u8) = 2;
            if (k >= 6 && k <= 8) mode((u8)(k == 6 ? 5 : k == 7 ? 4 : 6));
            before = teleports;
            for (m0 = t + (k == 9 ? 19 - t : 15); t < m0; t++) tick(t);
            CHECK(moves() == 0 && teleports == before);
            F(ps, 0x42c, u32) = 0;
            printf("ok    never when %s\n", what[k]);
            if (k == 9) {                                                /* the pods: from second 20 it may act */
                tick(t++); tick(t++); tick(t++);
                CHECK(t == 22 && moves() == 1);
                printf("ok    ... and from second 20 InProgress it does (moved at the 2nd still tick, second 21)\n");
            }
        }
    }

    /* The pawn destroyed (died, the next round): no call on it, no crash; a
       new pawn starts fresh (the old pawn's good spot is not used). */
    new_match("");
    t = walk(20, 25);
    memcpy(good, at(), sizeof(good));
    put_at(good[0] + 120.0f, 0.0f, good[2] + 200.0f);
    mode(3);
    tick(t++); tick(t++);
    kill_obj(pawn); kill_obj(root); kill_obj(move);
    before = teleports;
    tick(t++); tick(t++); tick(t++);
    CHECK(moves() == 0 && teleports == before);
    new_pawn(good[0] + 5000.0f, 0.0f, 300.0f);
    mode(3);
    input(2048.0f, 0.0f);
    {
        float from[3];
        memcpy(from, at(), sizeof(from));
        tick(t++); tick(t++); tick(t++);
        CHECK(moves() == 1 && at()[0] == from[0] + 60.0f);
    }
    printf("ok    the pawn destroyed: nothing touched; a new pawn starts fresh (no old good spot)\n");

    /* The teleport refused: no move counted, no cooldown; tried again 2 ticks on. */
    new_match("");
    t = walk(20, 25);
    memcpy(good, at(), sizeof(good));
    put_at(good[0] + 120.0f, 0.0f, good[2] + 200.0f);
    mode(3);
    teleport_ok = 0;
    tick(t++); tick(t++); tick(t++);
    CHECK(moves() == 0 && teleports == 2 + 32);                         /* 2 good spots within 800, then 32 ring spots */
    teleport_ok = 1;
    before = teleports;
    tick(t++);
    CHECK(moves() == 0);
    tick(t++);
    CHECK(moves() == 1 && teleports == before + 1 && at()[0] == good[0]);
    printf("ok    a refused teleport: every candidate tried once, then again 2 ticks later\n");

    /* The controller's pawn is not an AShooterCharacter (a plain APawn): it is
       left alone, and nothing past APawn is read. The pawn ends at a
       no-access page from +0x440 on (APawn::Controller is +0x438), so a read
       of CharacterMovement (+0x468), CapsuleComponent (+0x470) or the using
       bits (+0xd80) would crash this test; IsAlive (AShooterCharacter's) is
       never called on it. */
    new_match("");
    t = walk(20, 25);
    {
        u8 *page = (u8 *)VirtualAlloc(0, 0x2000, MEM_RESERVE, PAGE_NOACCESS), *plain;
        CHECK(page && VirtualAlloc(page, 0x1000, MEM_COMMIT, PAGE_READWRITE));
        plain = page + 0x1000 - 0x440;
        memset(plain, 0, 0x440);
        F(plain, 0, void **) = vtable;
        F(plain, 0x10, u8 *) = 0;                  /* no class: not a character */
        F(plain, 0x1e0, u8 *) = root;              /* RootComponent (AActor's) */
        reg(plain);
        F(pc, 0x408, u8 *) = plain;
        mode(3);
        input(2048.0f, 0.0f);
        alive_calls = 0;
        before = teleports;
        for (m0 = t + 10; t < m0; t++) tick(t);
        CHECK(moves() == 0 && teleports == before && alive_calls == 0);
        F(pc, 0x408, u8 *) = pawn;                 /* the character back: it works again */
    }
    printf("ok    a pawn that is not a character: left alone, nothing past APawn read\n");

    /* A new match (or the same game mode's clock going back) forgets the old one. */
    new_match("");
    t = walk(20, 25);
    tick(3);                                                             /* the clock went back: a new match */
    put_at(at()[0] + 120.0f, 0.0f, at()[2] + 200.0f);
    mode(3);
    for (t = 4; t < 15; t++) tick(t);
    CHECK(moves() == 0);
    printf("ok    a new match (clock back to the start) forgets the old one\n");
}

int main(void)
{
    image = (u8 *)VirtualAlloc(0, 0x2600000, MEM_RESERVE, PAGE_NOACCESS);
    CHECK(image);
    cls_pc = new_class(); cls_ps = new_class(); cls_char = new_class(); cls_hud = new_class();
    world = new_obj(0);
    controllers = (i32 *)calloc(2, sizeof(i32));
    vtable[0x120 / 8] = (void *)get_world;
    vtable[0x468 / 8] = (void *)response;
    hook(0x244d30, (void *)stock_end);
    hook(0x69c470, (void *)weak_get);
    hook(0x69c2a0, (void *)weak_set);
    hook(0x303820, (void *)ret_pc);
    hook(0x3039c0, (void *)ret_ps);
    hook(0x302cc0, (void *)ret_char);
    hook(0x3046c0, (void *)ret_hud);
    hook(0x249d20, (void *)has_left);
    hook(0x249ca0, (void *)record_alive);
    hook(0x26e0d0, (void *)pawn_is_alive);
    hook(0x1a3420, (void *)resize);
    hook(0x202900, (void *)hud_message);
    hook(0x50c510, (void *)mem_free);
    hook(0x13a7c30, (void *)overlap);
    hook(0x111fae0, (void *)teleport);
    VirtualAlloc(image + 0x2567000, 0x1000, MEM_COMMIT, PAGE_READWRITE);   /* L"/Script/Victory" */
    sd_self_rva = (u64)&sd_self_rva - (u64)image;
    checks();
    printf("all unstick native tests passed\n");
    return 0;
}
