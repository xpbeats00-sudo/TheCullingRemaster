/* Runs the netplay module (netplay.c, compiled with the blob's own flags:
 * the release build) against fake game objects: a fake image holds a jump
 * at every game function the tested paths call, to the stand-ins below, its
 * kernel32 import slots hold the real functions (the control folder is a
 * real folder), and np_self_rva is set so the module's image base is the
 * fake image.
 *
 * Built and run by test_netplay.py (test_native), one process per scenario
 * (the module reads its environment once): argv[1] names the scenario, the
 * rest are its inputs (tickets and their SHA-256, computed by the test with
 * hashlib). Prints "ok ..." lines, exits 1 on the first failure.
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

typedef unsigned long long u64;
typedef unsigned int u32;
typedef unsigned char u8;
typedef unsigned short u16;
typedef int i32;

extern volatile u64 np_self_rva;
u8 np_listen(void *world, void *url);
void np_prelogin(void *gm, void *options, void *address, void *uid, void *error);
void np_notify_control(void *notify, void *conn, u8 type, void *bunch);
void np_tick_flush(void *driver, float dt);

#define F(p, off, type) (*(type *)((u8 *)(p) + (off)))
#define CHECK(c) do { if (!(c)) { printf("FAIL line %d: %s\n", __LINE__, #c); fflush(stdout); exit(1); } } while (0)

static u8 *image;

static void hook(u64 rva, void *fn)
{
    u8 *at = image + rva;
    VirtualAlloc((void *)((u64)at & ~0xfffULL), 0x2000, MEM_COMMIT, PAGE_EXECUTE_READWRITE);
    at[0] = 0x48; at[1] = 0xb8; memcpy(at + 2, &fn, 8);   /* mov rax, fn */
    at[10] = 0xff; at[11] = 0xe0;                         /* jmp rax */
}

static void iat(u64 rva, void *fn)
{
    VirtualAlloc(image + (rva & ~0xfffULL), 0x1000, MEM_COMMIT, PAGE_READWRITE);
    memcpy(image + rva, &fn, 8);
}

/* ---------------------------------------------------------------- strings */

typedef struct { u16 *data; i32 num, max; } FStr;

static void string_resize(FStr *s, i32 new_max, i32 prev)
{
    (void)prev;
    s->data = (u16 *)realloc(s->data, (size_t)new_max * 2);
    s->max = new_max;
}
static void mem_free(void *p) { free(p); }

static void set_wide(FStr *s, const char *a)
{
    i32 i, n = (i32)strlen(a) + 1;
    s->data = (u16 *)malloc((size_t)n * 2);
    for (i = 0; i < n; i++)
        s->data[i] = (u16)(u8)a[i];
    s->num = s->max = n;
}

static const char *narrow(FStr *s)
{
    static char out[512];
    i32 i;
    for (i = 0; i < s->num && i < 511 && s->data && s->data[i]; i++)
        out[i] = (char)s->data[i];
    out[i] = 0;
    return out;
}

/* ---------------------------------------------------------------- the world */

static u8 *world, *driver, *gm, *gs;
static void *drv_vtable[0x100];
static void *conn_vtable[0x100];

static u8 *block(size_t n) { return (u8 *)calloc(1, n); }

/* Weak pointers: an index into this table (serial 1; 0 = none). */
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
    if (o && w[0] < 0) { w[0] = reg(o); w[1] = 1; }
}
static u8 *weak_get(i32 *w) { return w[1] && w[0] >= 0 && w[0] < nobjs && alive_obj[w[0]] ? objs[w[0]] : 0; }

/* A player state in pages of its own: destroying it frees them, so any
 * later read of it crashes the test (a use after free). */
static u8 *new_ps(u32 flags)
{
    u8 *p = (u8 *)VirtualAlloc(0, 0x1000, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    F(p, 0x42c, u32) = flags;              /* bit 2: a bot */
    F(p, 0x5b4, u8) = 1;                   /* a contestant */
    reg(p);
    return p;
}
static void destroy(u8 *o)
{
    int i;
    for (i = 0; i < nobjs; i++)
        if (objs[i] == o)
            alive_obj[i] = 0;
    VirtualFree(o, 0, MEM_RELEASE);
}

/* Names: the match states the module looks up. */
enum { N_WAITING = 1001, N_PROGRESS, N_POST, N_LEAVING, N_OTHER };
static u64 *fname(u64 *out, const u16 *name, i32 find)
{
    char a[64];
    int i;
    (void)find;
    for (i = 0; i < 63 && name[i]; i++)
        a[i] = (char)name[i];
    a[i] = 0;
    *out = !strcmp(a, "WaitingToStart") ? N_WAITING : !strcmp(a, "InProgress") ? N_PROGRESS
        : !strcmp(a, "WaitingPostMatch") ? N_POST : !strcmp(a, "LeavingMap") ? N_LEAVING : N_OTHER;
    return out;
}

/* Records (AVictoryGameState +0x468, 0x150 each) and the scoreboard (+0x498, 0xb0 each). */
#define REC 0x150
#define SB 0xb0
static u8 *recs, *sbs;
static int nrecs;
static u8 *add_record(u8 *ps, const char *id, i32 team)
{
    u8 *r = recs + (size_t)nrecs * REC, *e = sbs + (size_t)nrecs * SB;
    set_wide((FStr *)r, id);               /* +0: the player's id */
    set_wide((FStr *)(e + 0x10), id);      /* the scoreboard entry's PlayerId */
    F(r, 0x10, u8 *) = ps;
    F(r, 0x28, u8) = 1;                    /* alive */
    F(r, 0x40, i32) = team;
    nrecs++;
    F(gs, 0x468 + 8, i32) = nrecs;
    F(gs, 0x498 + 8, i32) = nrecs;
    return r;
}
static u8 *sb_of(u8 *r) { return sbs + (size_t)((r - recs) / REC) * SB; }

static u8 **players;                       /* the game state's PlayerArray */
static int nplayers;
static void set_players(u8 **list, int n)
{
    int i;
    for (i = 0; i < n; i++)
        players[i] = list[i];
    nplayers = n;
    F(gs, 0x418, u8 **) = players;
    F(gs, 0x418 + 8, i32) = n;
}

static int team_sets;
static u8 *last_team_ps[256];
static void set_team(u8 *ps, i32 team, u8 b)
{
    int i;
    (void)b;
    last_team_ps[team_sets++ & 255] = ps;
    F(ps, 0x490, i32) = team;
    for (i = 0; i < nrecs; i++)
        if (F(recs + (size_t)i * REC, 0x10, u8 *) == ps)
            F(recs + (size_t)i * REC, 0x40, i32) = team;
}

static void noop(void) {}
static u8 *singleton_obj;
static u8 *singleton(void) { return singleton_obj; }
static u8 create_named(void *e, void *w, u64 a, u64 b) { (void)e; (void)w; (void)a; (void)b; return 1; }
static u8 *wctx;
static u8 *world_ctx(void *e, void *w) { (void)e; (void)w; return wctx; }
static u8 *coll;
static u8 *find_coll(void *w, i32 type) { (void)w; (void)type; return coll; }
static int listen_port_taken;
static u8 init_listen(u8 *drv, void *notify, u8 *url, u8 reuse, void *err)
{
    (void)drv; (void)notify; (void)reuse; (void)err;
    if (listen_port_taken)
        F(url, 0x20, i32) += 1;            /* UIpNetDriver: BindNextPort took the next one */
    return 1;
}
static i32 conn_not_ready(void *c, u8 s) { (void)c; (void)s; return 0; }
static void set_state(u32 name) { F(gm, 0x4a0, u32) = name; F(gs, 0x440, u32) = name; }

static u8 *conns_list[64];
static int nconns;
static void set_conns(u8 **list, int n)
{
    int i;
    for (i = 0; i < n; i++)
        conns_list[i] = list[i];
    nconns = n;
    F(driver, 0x78, u8 **) = conns_list;
    F(driver, 0x80, i32) = n;
}

static void tick(void) { np_tick_flush(driver, 0.016f); }

/* The host listens (np_listen binds the driver to the world). */
static void listen_world(i32 port)
{
    u8 *url = block(0x100);
    F(url, 0x20, i32) = port;
    F(world, 0x38, u8 *) = 0;
    CHECK(np_listen(world, url) == 1);
    CHECK(F(world, 0x38, u8 *) == driver);
}

/* A joined player's controller on its connection, with its player state. */
static void give_pc(u8 *conn, u8 *ps)
{
    u8 *pc = block(0x1000);
    F(pc, 0x420, u8 *) = ps;
    F(conn, 0x30, u8 *) = pc;
}

/* ---------------------------------------------------------------- logins */

static FStr cur_options, cur_error;
static u8 *cur_uid;

/* A player's net id: FUniqueNetIdRepl {vtable, TSharedPtr object at +8}; the
 * id's vtable +0x18 IsValid, +0x20 ToString(FString *out). */
static u8 id_valid(u8 *id) { (void)id; return 1; }
static FStr *id_to_string(u8 *id, FStr *out) { set_wide(out, F(id, 8, const char *)); return out; }
static void *id_vtable[8];

static u8 *net_id(const char *text)
{
    u8 *repl, *id;
    if (!text)
        return 0;
    repl = (u8 *)calloc(1, 0x20);
    id = (u8 *)calloc(1, 0x20);
    id_vtable[0x18 / 8] = (void *)id_valid;
    id_vtable[0x20 / 8] = (void *)id_to_string;
    F(id, 0, void **) = id_vtable;
    F(id, 8, const char *) = _strdup(text);
    F(repl, 8, u8 *) = id;
    return repl;
}
static int game_prelogins, base_prelogins, game_refuses;

static void game_prelogin(void *g, void *options, void *address, void *uid, FStr *error)
{
    (void)g; (void)options; (void)address; (void)uid;
    game_prelogins++;
    if (game_refuses && !error->num)
        set_wide(error, "Match is over!");
}
static void base_prelogin(void *g, void *options, void *address, void *uid, void *error)
{
    (void)g; (void)options; (void)address; (void)uid; (void)error;
    base_prelogins++;
}
/* The stock NotifyControlMessage: a Login runs the game mode's PreLogin (np_prelogin). */
static void stock_control(void *notify, void *conn, u8 type, void *bunch)
{
    (void)notify; (void)conn; (void)bunch;
    if (type == 5)
        np_prelogin(gm, &cur_options, 0, cur_uid, &cur_error);
}

static u8 *new_conn(void)
{
    u8 *c = block(0x1000);
    F(c, 0, void **) = conn_vtable;
    F(c, 0x124, i32) = 3;                  /* open */
    return c;
}

/* A login with these URL options on conn, as the player whose net id reads
 * uid (NULL: none): "" when let in, else the refusal. */
static const char *login_opts(u8 *conn, const char *opts, const char *uid)
{
    char buf[600];
    cur_uid = net_id(uid);
    _snprintf(buf, sizeof(buf), "%s", opts);
    free(cur_options.data);
    set_wide(&cur_options, buf);
    free(cur_error.data);
    cur_error.data = 0; cur_error.num = cur_error.max = 0;
    np_notify_control(world + 0x28, conn, 5, 0);
    return cur_error.num ? narrow(&cur_error) : "";
}

static const char *login(u8 *conn, const char *ticket, const char *uid)
{
    char buf[600];
    _snprintf(buf, sizeof(buf), "?Name=Player?Nonce=%s?SplitscreenCount=1", ticket);
    return login_opts(conn, buf, uid);
}

/* "steam:7656..." -> "7656...": the net id of the ticket's own player. */
static const char *steam_of(const char *user) { return strncmp(user, "steam:", 6) ? user : user + 6; }

static char ctl[MAX_PATH];

static int read_file(const char *name, char *out, int max)
{
    char path[MAX_PATH + 64];
    FILE *f;
    int n;
    _snprintf(path, sizeof(path), "%s\\%s", ctl, name);
    f = fopen(path, "rb");
    if (!f)
        return -1;
    n = (int)fread(out, 1, (size_t)max - 1, f);
    fclose(f);
    out[n] = 0;
    return n;
}

static void remove_file(const char *name)
{
    char path[MAX_PATH + 64];
    _snprintf(path, sizeof(path), "%s\\%s", ctl, name);
    DeleteFileA(path);
}

/* ---------------------------------------------------------------- setup */

static void setup(void)
{
    image = (u8 *)VirtualAlloc(0, 0x3400000, MEM_RESERVE, PAGE_NOACCESS);
    CHECK(image);
    iat(0x253f258, (void *)WriteFile);
    iat(0x253f280, (void *)GetEnvironmentVariableW);
    iat(0x253f2a8, (void *)CreateFileW);
    iat(0x253f630, (void *)GetTickCount);
    iat(0x253f260, (void *)ReadFile);
    iat(0x253f330, (void *)CloseHandle);
    hook(0x1a3420, (void *)string_resize);
    hook(0x50c510, (void *)mem_free);
    hook(0x245320, (void *)game_prelogin);
    hook(0x1343270, (void *)base_prelogin);
    hook(0x1685a90, (void *)stock_control);
    hook(0x69c470, (void *)weak_get);
    hook(0x69c2a0, (void *)weak_set);
    hook(0x5b0e60, (void *)fname);
    hook(0x24e7e0, (void *)set_team);
    hook(0x1f2de0, (void *)singleton);
    hook(0x2335370, (void *)noop);          /* the stock TickFlush */
    hook(0x1635d60, (void *)create_named);
    hook(0x163d220, (void *)world_ctx);
    hook(0x143df20, (void *)noop);          /* SetWorld */
    hook(0x1680dd0, (void *)find_coll);
    hook(0x231fd0, (void *)noop);           /* spawn one bot */
    {
        static u8 *engine;
        engine = block(0x100);
        VirtualAlloc(image + 0x3307000, 0x1000, MEM_COMMIT, PAGE_READWRITE);
        F(image, 0x3307b48, u8 *) = engine;
    }
    VirtualAlloc(image + 0x2567000, 0x1000, MEM_COMMIT, PAGE_READWRITE);   /* L"/Script/Victory" */
    np_self_rva = (u64)&np_self_rva - (u64)image;
    world = block(0x2000);
    driver = block(0x1000);
    gm = block(0x1000);
    gs = block(0x1000);
    F(driver, 0, void **) = drv_vtable;
    drv_vtable[0x220 / 8] = (void *)init_listen;
    conn_vtable[0x268 / 8] = (void *)conn_not_ready;
    F(driver, 0xe0, u64) = 0x11a;          /* NAME_GameNetDriver */
    wctx = block(0x400);
    F(wctx, 0x248, u8 *) = block(0x20);
    F(F(wctx, 0x248, u8 *), 0, u8 *) = driver;
    F(wctx, 0x250, i32) = 1;
    coll = block(0x100);
    singleton_obj = block(0x1000);
    recs = block(REC * 64);
    sbs = block(SB * 64);
    players = (u8 **)block(sizeof(u8 *) * 64);
    F(gs, 0x468, u8 *) = recs;
    F(gs, 0x498, u8 *) = sbs;
    set_state(N_PROGRESS);
    F(world, 0x38, u8 *) = driver;         /* the notify's world has a driver, no ServerConnection: server side */
    F(world, 0xf0, u8 *) = gm;
    F(world, 0xf8, u8 *) = gs;
    F(gm, 0x458, u8 *) = gs;
    F(driver, 0xa0, u8 *) = world;
    CHECK(GetEnvironmentVariableA("CULLING_NETPLAY_CONTROL", ctl, MAX_PATH) || 1);
}

/* ---------------------------------------------------------------- scenarios */

/* H1: tickets are checked locally, by hash, with no wait.
 * argv: ticket A, its hash, user A, ticket B, its hash, user B, a forged ticket. */
static int scenario_tickets(char **v)
{
    const char *ta = v[0], *ha = v[1], *ua = v[2], *tb = v[3], *hb = v[4], *ub = v[5], *forged = v[6];
    char buf[512], want[512];
    u32 t0, ms;
    int i;
    CHECK(strcmp(login(new_conn(), ta, steam_of(ua)), "") == 0);
    CHECK(read_file("used-1", buf, sizeof(buf)) > 0);
    _snprintf(want, sizeof(want), "%s %s %s\n", ha, ua, steam_of(ua));
    CHECK(strcmp(buf, want) == 0);
    printf("ok    a known ticket lets its player in; its use goes to the agent (used-1: hash, userID, net id)\n");
    CHECK(strcmp(login(new_conn(), ta, steam_of(ua)), "Match ticket already used") == 0);
    printf("ok    the same ticket again is refused (one use)\n");
    CHECK(strcmp(login(new_conn(), forged, steam_of(ua)), "Match ticket refused") == 0);
    CHECK(strcmp(login_opts(new_conn(), "?Name=Player?SplitscreenCount=1", steam_of(ua)), "No match ticket") == 0);
    printf("ok    a forged ticket and a login without one are refused\n");
    t0 = GetTickCount();
    for (i = 0; i < 300; i++) {
        _snprintf(buf, sizeof(buf), "v1.junk%d.%08x", i, i * 2654435761u);
        CHECK(strcmp(login(new_conn(), buf, "76561190000000000"), "Match ticket refused") == 0);
    }
    ms = GetTickCount() - t0;
    CHECK(ms < 1500);
    printf("ok    300 refused logins in %u ms: no wait on the game thread\n", ms);
    CHECK(strcmp(login(new_conn(), tb, steam_of(ub)), "") == 0);
    CHECK(read_file("used-2", buf, sizeof(buf)) > 0);
    _snprintf(want, sizeof(want), "%s %s %s\n", hb, ub, steam_of(ub));
    CHECK(strcmp(buf, want) == 0);
    printf("ok    the second player's ticket: in, used-2\n");
    CHECK(game_prelogins == 2 && base_prelogins == 0);
    printf("ok    the game's own PreLogin runs for the ticketed logins only; never the test host's bypass\n");
    remove_file("tickets.txt");
    CHECK(strcmp(login(new_conn(), "v1.abc.def", "76561190000000000"), "Server not ready") == 0);
    printf("ok    no tickets.txt (the agent hasn't written one): refused\n");
    return 0;
}

/* H5: one join per player, and the ticket bound to its player.
 * argv: tickets A, B (steam: userIDs) and C (a non-Steam userID) with their users. */
static int scenario_players(char **v)
{
    const char *ta = v[0], *ua = v[1], *tb = v[2], *ub = v[3], *tc = v[4];
    char buf[512];
    CHECK(strcmp(login(new_conn(), ta, steam_of(ua)), "") == 0);
    CHECK(strcmp(login(new_conn(), tb, steam_of(ua)), "Match ticket is for another player") == 0);
    printf("ok    B's ticket with A's Steam ID (a copied id) is refused: the ticket's Steam ID must be the player's\n");
    CHECK(strcmp(login(new_conn(), tb, "76561190000000999"), "Match ticket is for another player") == 0);
    CHECK(strcmp(login(new_conn(), tc, 0), "No player id") == 0);
    printf("ok    another Steam ID, or none, is refused\n");
    CHECK(strcmp(login(new_conn(), tb, steam_of(ub)), "") == 0);
    printf("ok    B's own ticket still lets B in (refusals don't use a ticket up)\n");
    CHECK(strcmp(login(new_conn(), tc, steam_of(ua)), "Player already in the match") == 0);
    printf("ok    a net id already in the match is refused (C's non-Steam ticket with A's id)\n");
    CHECK(strcmp(login(new_conn(), tc, "76561190000000777"), "") == 0);
    CHECK(read_file("used-3", buf, sizeof(buf)) > 0 && strstr(buf, " 76561190000000777\n"));
    printf("ok    a non-Steam userID's ticket: in with its player's id recorded (used-3)\n");
    return 0;
}

/* M1: a real host (CULLING_NETPLAY_PREMATCH) whose control folder isn't
 * there lets nobody in. argv: a ticket and its user (the test leaves the
 * variable unset, or names a missing folder). */
static int scenario_nocontrol(char **v)
{
    CHECK(strcmp(login(new_conn(), v[0], steam_of(v[1])), "Server not ready") == 0);
    CHECK(strcmp(login_opts(new_conn(), "?Name=Player", steam_of(v[1])), "") != 0);
    CHECK(game_prelogins == 0 && base_prelogins == 0);
    printf("ok    no control folder on a real host: every login refused, ticket or not\n");
    return 0;
}

/* M5: a login the game's own PreLogin refuses doesn't join: its ticket isn't
 * used and no used-<n> is written. argv: a ticket and its user. */
static int scenario_gamerefuses(char **v)
{
    char buf[512];
    game_refuses = 1;
    CHECK(strcmp(login(new_conn(), v[0], steam_of(v[1])), "Match is over!") == 0);
    CHECK(read_file("used-1", buf, sizeof(buf)) < 0);
    printf("ok    refused by the game's PreLogin: not in the join table, no used-1\n");
    game_refuses = 0;
    CHECK(strcmp(login(new_conn(), v[0], steam_of(v[1])), "") == 0);
    CHECK(read_file("used-1", buf, sizeof(buf)) > 0);
    printf("ok    the same ticket lets the player in once the game does\n");
    return 0;
}

/* H4: a team player who leaves mid-match. Its player state is destroyed
 * (its pages freed: any later read crashes); the host goes on (teams every
 * tick) and reports it from its record as last seen. argv: tickets A, B
 * and their users (Duos, teams 1 and 2). */
static int scenario_leaver(char **v)
{
    const char *ta = v[0], *ua = v[1], *tb = v[2], *ub = v[3];
    u8 *ca = new_conn(), *cb = new_conn(), *pa = new_ps(0), *pb = new_ps(0), *b1 = new_ps(4), *b2 = new_ps(4);
    u8 *ra, *rb, *rb1, *rb2, *list[4], *cl[2];
    char buf[3200];
    int i, sets;
    listen_world(7777);
    CHECK(strcmp(login(ca, ta, steam_of(ua)), "") == 0);
    CHECK(strcmp(login(cb, tb, steam_of(ub)), "") == 0);
    give_pc(ca, pa);
    give_pc(cb, pb);
    cl[0] = ca; cl[1] = cb;
    set_conns(cl, 2);
    list[0] = pa; list[1] = pb; list[2] = b1; list[3] = b2;
    set_players(list, 4);
    ra = add_record(pa, steam_of(ua), 0);
    rb = add_record(pb, steam_of(ub), 0);
    rb1 = add_record(b1, "bot1", 0);
    rb2 = add_record(b2, "bot2", 0);
    tick();                                /* the result's bookkeeping takes up the players' states */
    tick();
    CHECK(F(pa, 0x490, i32) == 1 && F(pb, 0x490, i32) == 2);
    printf("ok    the joined players are put on their tickets' teams\n");
    F(rb, 0xf0, i32) = 1;                  /* B: a bot kill and 40 damage */
    F(sb_of(rb), 0x68, i32) = 40;
    tick();
    /* B leaves: out of the PlayerArray and the connections, its player state destroyed. */
    list[1] = b2;
    set_players(list, 3);
    set_conns(cl, 1);
    destroy(pb);
    sets = team_sets;
    for (i = 0; i < 20; i++)
        tick();
    for (i = sets; i < team_sets; i++)
        CHECK(last_team_ps[i & 255] != pb);
    printf("ok    after the player left: 20 ticks, no use of its freed player state (teams set %d more times)\n", team_sets - sets);
    F(ra, 0x29, u8) = 1;                   /* the game's winner */
    F(rb1, 0x28, u8) = 0; F(rb1, 0x5c, i32) = 1;
    F(rb2, 0x28, u8) = 0; F(rb2, 0x5c, i32) = 2;
    set_state(N_POST);
    tick();
    CHECK(read_file("result.txt", buf, sizeof(buf)) > 0);
    printf("      %s", buf);
    {
        char want[200];
        _snprintf(want, sizeof(want), "player n=1 user=%s placement=1 ", ua);
        CHECK(strstr(buf, want) != 0);
        _snprintf(want, sizeof(want), "player n=2 user=%s placement=4 ", ub);
        CHECK(strstr(buf, want) != 0);
        CHECK(strstr(buf, " kills=1 damage=40 ") && strstr(buf, " alive=0 left=1\n"));
        CHECK(strstr(buf, " team=2 team_placement="));
    }
    CHECK(read_file("result.done", buf, sizeof(buf)) > 0);
    printf("ok    the result: the winner 1st; the player who left, out when it left (4th of 4 alive), with its kills and damage\n");
    return 0;
}

/* H3: the host listens on CULLING_NETPLAY_PORT and says which port it bound.
 * argv: "taken" when the engine has to take the next port. */
static int scenario_listen(char **v)
{
    char buf[64];
    listen_port_taken = !strcmp(v[0], "taken");
    listen_world(7777);
    CHECK(read_file("listening", buf, sizeof(buf)) > 0);
    printf("      listening: %s", buf);
    CHECK(strcmp(buf, listen_port_taken ? "port=7791\n" : "port=7790\n") == 0);
    printf("ok    listening on CULLING_NETPLAY_PORT (7790, not the URL's 7777)%s\n", listen_port_taken ? ": the port bound instead is reported" : "");
    return 0;
}

/* M2: the match ends at its time limit with several alive. Exactly one
 * winner: the game's winner flag 1st, the other living after it, the dead
 * after them. argv: tickets A, B, C and their users; "teams" for Duos. */
static int scenario_timelimit(char **v)
{
    int teams = !strcmp(v[6], "teams");
    u8 *c[3], *p[3], *r[3], *bot = new_ps(4), *rbot, *cl[3];
    char buf[3200], want[200], *s;
    int i, firsts = 0;
    listen_world(7777);
    for (i = 0; i < 3; i++) {
        c[i] = new_conn();
        p[i] = new_ps(0);
        CHECK(strcmp(login(c[i], v[2 * i], steam_of(v[2 * i + 1])), "") == 0);
        give_pc(c[i], p[i]);
        cl[i] = c[i];
    }
    set_conns(cl, 3);
    {
        u8 *list[4];
        list[0] = p[0]; list[1] = p[1]; list[2] = p[2]; list[3] = bot;
        set_players(list, 4);
    }
    for (i = 0; i < 3; i++)
        r[i] = add_record(p[i], steam_of(v[2 * i + 1]), 0);
    rbot = add_record(bot, "bot", 0);
    tick();
    tick();
    /* The time limit: A (the game's winner) and B alive, C dead first, the bot alive. */
    F(r[0], 0x29, u8) = 1;
    F(r[2], 0x28, u8) = 0; F(r[2], 0x5c, i32) = 1;
    (void)rbot;
    set_state(N_POST);
    tick();
    CHECK(read_file("result.txt", buf, sizeof(buf)) > 0);
    printf("      %s", buf);
    for (s = buf; (s = strstr(s, teams ? " team_placement=1 " : " placement=1 ")) != 0; s++)
        firsts++;
    _snprintf(want, sizeof(want), "user=%s placement=1 ", v[1]);
    CHECK(strstr(buf, want) != 0);
    _snprintf(want, sizeof(want), "user=%s placement=2 ", v[3]);
    CHECK(strstr(buf, want) != 0);
    _snprintf(want, sizeof(want), "user=%s placement=4 ", v[5]);
    CHECK(strstr(buf, want) != 0);
    if (teams) {
        /* Teams 1, 2, 3 (one player each, the bot on team 1 with A): A's team won; B's, alive, 2nd; C's 3rd. */
        CHECK(strstr(buf, " team=1 team_placement=1 ") && strstr(buf, " team=2 team_placement=2 ") && strstr(buf, " team=3 team_placement=3 "));
    }
    CHECK(firsts == 1);
    printf("ok    the time limit with several alive: the winner 1st, the other living 2nd, the dead last; one winner%s\n",
           teams ? " team" : "");
    return 0;
}

int main(int argc, char **argv)
{
    if (argc < 2)
        return 2;
    setup();
    if (!strcmp(argv[1], "tickets") && argc >= 9)
        return scenario_tickets(argv + 2);
    if (!strcmp(argv[1], "players") && argc >= 7)
        return scenario_players(argv + 2);
    if (!strcmp(argv[1], "timelimit") && argc >= 9)
        return scenario_timelimit(argv + 2);
    if (!strcmp(argv[1], "listen") && argc >= 3)
        return scenario_listen(argv + 2);
    if (!strcmp(argv[1], "leaver") && argc >= 6)
        return scenario_leaver(argv + 2);
    if (!strcmp(argv[1], "nocontrol") && argc >= 4)
        return scenario_nocontrol(argv + 2);
    if (!strcmp(argv[1], "gamerefuses") && argc >= 4)
        return scenario_gamerefuses(argv + 2);
    printf("FAIL unknown scenario %s\n", argv[1]);
    return 2;
}
