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
    VirtualAlloc(image + 0x2567000, 0x1000, MEM_COMMIT, PAGE_READWRITE);   /* L"/Script/Victory" */
    np_self_rva = (u64)&np_self_rva - (u64)image;
    world = block(0x2000);
    driver = block(0x1000);
    gm = block(0x1000);
    gs = block(0x1000);
    F(driver, 0, void **) = drv_vtable;
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

int main(int argc, char **argv)
{
    if (argc < 2)
        return 2;
    setup();
    if (!strcmp(argv[1], "tickets") && argc >= 9)
        return scenario_tickets(argv + 2);
    if (!strcmp(argv[1], "players") && argc >= 7)
        return scenario_players(argv + 2);
    if (!strcmp(argv[1], "nocontrol") && argc >= 4)
        return scenario_nocontrol(argv + 2);
    if (!strcmp(argv[1], "gamerefuses") && argc >= 4)
        return scenario_gamerefuses(argv + 2);
    printf("FAIL unknown scenario %s\n", argv[1]);
    return 2;
}
