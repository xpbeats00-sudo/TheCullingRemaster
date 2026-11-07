/* netplay.c - a native module that brings back the listen-server half of the
 * engine inside the WindowsClient Victory.exe ("route B" of
 * docs/MULTIPLAYER_NETPLAY_FEASIBILITY.md: rebuild the server code the
 * WITH_SERVER_CODE=0 build stripped). See docs/NETPLAY_LISTEN_SERVER.md and
 * docs/DEDICATED_SERVER_IMPLEMENTATION.md.
 *
 * Built by build_netplay.py (MSVC cl, no CRT) into a position-independent
 * blob that patch_netplay.py places in its own section (.netp) of a COPY of
 * the stock exe. Every game address is image-relative: the base is recovered
 * from the RVA of np_self_rva, which the builder writes into the blob, so the
 * blob needs no base relocations (the exe is ASLR-enabled). Every address
 * below is re-derived from the stock bytes by test_netplay.py.
 *
 * Entry points (patch_netplay.py wires each one):
 *
 * np_listen(world, url)   replaces UEngine::LoadMap's call of UWorld::Listen
 *     (VA 0x141644cef, stock target the shared "xor al,al; ret" stub). On a
 *     map URL with ?listen it does what 4.15's UWorld::Listen does:
 *       GEngine->CreateNamedNetDriver(world, NAME_GameNetDriver, NAME_GameNetDriver)
 *       driver = the ActiveNetDrivers entry named NAME_GameNetDriver
 *       driver->SetWorld(world)                (registers its tick events)
 *       world->NetDriver = driver; the DynamicSource and Static level
 *         collections' NetDriver = driver       (UWorld::Tick re-reads it from
 *                                                there, as MovePendingLevel does)
 *       driver->InitListen(world's FNetworkNotify, url, false, error)
 *     undoing the binding if InitListen fails.
 *
 * np_notify_accepting / np_notify_accepted / np_notify_control
 *     replace three slots of UWorld's FNetworkNotify vtable. Each forwards to
 *     the stock function unchanged and, when the CULLING_NETPLAY_TRACE
 *     environment variable names a file, appends one line per call to it, so
 *     a run shows exactly how far the UE handshake gets (Hello, Login, Join,
 *     the connection's state and its PlayerController). With the variable
 *     unset they are pure pass-throughs.
 */

typedef unsigned long long u64;
typedef unsigned int u32;
typedef int i32;
typedef unsigned char u8;
typedef unsigned short u16;

/* ---- the game (RVA = VA - 0x140000000) --------------------------------- */

/* Globals. */
#define R_GENGINE          0x3307b48   /* GEngine (UEngine*) */

/* Engine functions. */
#define R_CREATE_NAMED_ND  0x1635d60   /* UEngine::CreateNamedNetDriver(engine, UWorld*, FName name, FName def) -> bool */
#define R_GET_WORLDCTX     0x163d220   /* UEngine::GetWorldContextFromWorld(engine, world) -> FWorldContext* or NULL */
#define R_SET_WORLD        0x143df20   /* UNetDriver::SetWorld(driver, world) */
#define R_FIND_ADD_COLL    0x1680dd0   /* UWorld::FindOrAddCollectionByType(world, type) -> FLevelCollection* */

/* UWorld's FNetworkNotify functions (vtable 0x142b05cf0, slots 0, 1, 3). */
#define R_NOTIFY_ACCEPTING 0x16858f0   /* NotifyAcceptingConnection(notify) -> EAcceptConnection */
#define R_NOTIFY_ACCEPTED  0x11d9e00   /* NotifyAcceptedConnection(notify, conn): empty in this build too */
#define R_NOTIFY_CONTROL   0x1685a90   /* NotifyControlMessage(notify, conn, type, bunch) */

/* kernel32 imports (IAT slots of the stock exe). */
#define IAT_WRITEFILE      0x253f258
#define IAT_GETENVW        0x253f280
#define IAT_CREATEFILEW    0x253f2a8
#define IAT_GETTICKCOUNT   0x253f630

/* Names (hardcoded EName indices, FName = {index, number}). */
#define NAME_GAMENETDRIVER 0x11a

/* Struct offsets. */
#define O_WORLD_NOTIFY     0x28        /* UWorld's FNetworkNotify base (UWorld ctor stores its vtable there) */
#define O_WORLD_NETDRIVER  0x38        /* UWorld::NetDriver (MovePendingLevel; +0xb8 is DemoNetDriver) */
#define O_WC_DRIVERS_PTR   0x248       /* FWorldContext::ActiveNetDrivers data */
#define O_WC_DRIVERS_NUM   0x250       /*   .Num; 16-byte {UNetDriver*, FNetDriverDefinition*} */
#define WC_DRIVER_STRIDE   0x10
#define O_ND_NAME          0xe0        /* UNetDriver::NetDriverName (FName, 8 bytes) */
#define O_ND_NOTIFY        0xe8        /* UNetDriver::Notify */
#define O_ND_SERVERCONN    0x70        /* UNetDriver::ServerConnection */
#define O_COLL_NETDRIVER   0x10        /* FLevelCollection::NetDriver */
#define COLL_DYNAMIC_SOURCE 0
#define COLL_STATIC        2
#define VT_INITLISTEN      0x220       /* UNetDriver vtable: InitListen(this, notify, url, reuse, error) */
#define R_STEAM_INITLISTEN 0x2324a10   /* USteamNetDriver::InitListen */
#define R_IP_INITLISTEN    0x22d9800   /* UIpNetDriver::InitListen (the UDP socket) */
#define O_STEAM_PASSTHRU   0x438       /* USteamNetDriver::bIsPassthrough (its LAN branch sets it) */
#define O_URL_PORT         0x20        /* FURL::Port */
#define O_CONN_PC          0x30        /* UPlayer::PlayerController (UNetConnection) */
#define O_CONN_STATE       0x124       /* UNetConnection::State (1 closed, 2 pending, 3 open) */

/* The builder writes SECTION_RVA + offsetof(np_self_rva) here. A nonzero
 * initializer keeps it in .data. */
volatile u64 np_self_rva = 0x4E4554504C4159ULL;  /* "NETPLAY" */

static u64 image_base(void)
{
    return (u64)(&np_self_rva) - np_self_rva;
}

#define FN(rva, sig) ((sig)(image_base() + (u64)(rva)))
#define GLOBAL(rva, ty) (*(ty *)(image_base() + (u64)(rva)))
#define F(p, off, ty) (*(ty *)((u8 *)(p) + (off)))

/* ---- trace ------------------------------------------------------------- */

typedef u32 (*getenvw_fn)(const u16 *name, u16 *buf, u32 size);
typedef void *(*createfilew_fn)(const u16 *name, u32 access, u32 share, void *sa, u32 disp, u32 flags, void *tmpl);
typedef i32 (*writefile_fn)(void *h, const void *buf, u32 n, u32 *written, void *ovl);
typedef u32 (*gettickcount_fn)(void);

#define INVALID_HANDLE ((void *)(u64)-1)
static void *trace_handle = INVALID_HANDLE;
static i32 trace_state = 1;        /* 1 = not looked up yet, 2 = on, 3 = off */

static void trace_open(void)
{
    static const u16 var[] = { 'C','U','L','L','I','N','G','_','N','E','T','P','L','A','Y','_','T','R','A','C','E',0 };
    u16 path[260];
    u32 n = (*(getenvw_fn *)(image_base() + IAT_GETENVW))(var, path, 260);
    trace_state = 3;
    if (n == 0 || n >= 260)
        return;
    /* FILE_APPEND_DATA, share read|write, OPEN_ALWAYS, FILE_ATTRIBUTE_NORMAL */
    trace_handle = (*(createfilew_fn *)(image_base() + IAT_CREATEFILEW))(path, 4, 3, 0, 4, 0x80, 0);
    if (trace_handle != INVALID_HANDLE)
        trace_state = 2;
}

struct line { char b[400]; u32 n; };

static void put_s(struct line *l, const char *s)
{
    while (*s && l->n < sizeof(l->b) - 2)
        l->b[l->n++] = *s++;
}

static void put_x(struct line *l, u64 v)
{
    char t[17];
    i32 i = 16;
    t[16] = 0;
    do { t[--i] = "0123456789abcdef"[v & 15]; v >>= 4; } while (v && i > 0);
    put_s(l, "0x");
    put_s(l, t + i);
}

static void put_d(struct line *l, u64 v)
{
    char t[21];
    i32 i = 20;
    t[20] = 0;
    do { t[--i] = (char)('0' + v % 10); v /= 10; } while (v && i > 0);
    put_s(l, t + i);
}

static i32 trace_begin(struct line *l, const char *what)
{
    if (trace_state == 1)
        trace_open();
    if (trace_state != 2)
        return 0;
    l->n = 0;
    put_s(l, "np t=");
    put_d(l, (*(gettickcount_fn *)(image_base() + IAT_GETTICKCOUNT))());
    put_s(l, " ");
    put_s(l, what);
    return 1;
}

static void kv(struct line *l, const char *k, u64 v, i32 hex)
{
    put_s(l, " ");
    put_s(l, k);
    put_s(l, "=");
    if (hex)
        put_x(l, v);
    else
        put_d(l, v);
}

static void trace_end(struct line *l)
{
    u32 w = 0;
    l->b[l->n++] = '\r';
    l->b[l->n++] = '\n';
    (*(writefile_fn *)(image_base() + IAT_WRITEFILE))(trace_handle, l->b, l->n, &w, 0);
}

/* An object's vtable as an RVA (tells UIpNetDriver from USteamNetDriver in a trace). */
static u64 vt_rva(void *obj)
{
    return obj ? *(u64 *)obj - image_base() : 0;
}

/* ---- UWorld::Listen ---------------------------------------------------- */

typedef u8 (*create_named_nd_fn)(void *engine, void *world, u64 name, u64 def);
typedef void *(*get_worldctx_fn)(void *engine, void *world);
typedef void (*set_world_fn)(void *driver, void *world);
typedef u8 *(*find_add_coll_fn)(void *world, i32 type);
typedef u8 (*init_listen_fn)(void *driver, void *notify, void *url, u8 reuse, void *error);

/* An empty FString (TArray<TCHAR> {data, num, max}) for InitListen's out-Error. */
struct fstring { void *data; i32 num; i32 max; };

/* ---- the game-server agent's control folder ------------------------------
 *
 * CULLING_NETPLAY_CONTROL names a folder shared with the game-server agent
 * (gameserver/agent.js), which speaks the backend's signed game-server API.
 * The host and the agent talk through small files there:
 *   listening            the host writes it once it listens (the agent posts ready)
 *   verify-<n>.req/.ans  PreLogin: the player's ticket (?Nonce=), the
 *                        agent's answer "ok <team>" or "deny <reason>"
 *   result.txt + .done   at the end of the match: each joined player's result
 * Without the variable nothing here runs. */
#define IAT_SLEEP          0x253f220
#define IAT_READFILE       0x253f260
#define IAT_CLOSEHANDLE    0x253f330
#define R_STRING_RESIZE    0x1a3420    /* TArray<TCHAR>::ResizeForCopy(NewMax, PrevMax) */
typedef void (*sleep_fn)(u32 ms);
typedef i32 (*readfile_fn)(void *h, void *buf, u32 n, u32 *got, void *ovl);
typedef i32 (*closehandle_fn)(void *h);
typedef void (*resize_fn)(struct fstring *s, i32 new_max, i32 prev_max);
static const u16 ctl_var[] = { 'C','U','L','L','I','N','G','_','N','E','T','P','L','A','Y','_','C','O','N','T','R','O','L',0 };
static u16 ctl_dir[200];
static i32 ctl_state = 1;
static u32 ctl_len;

static i32 ctl_on(void)
{
    if (ctl_state == 1) {
        ctl_len = (*(getenvw_fn *)(image_base() + IAT_GETENVW))(ctl_var, ctl_dir, 180);
        ctl_state = ctl_len > 0 && ctl_len < 180 ? 2 : 3;
    }
    return ctl_state == 2;
}

static void ctl_path(u16 *out, const char *name)
{
    u32 i, k = 0;
    for (i = 0; i < ctl_len; i++)
        out[k++] = ctl_dir[i];
    out[k++] = '\\';
    for (i = 0; name[i] && k < 258; i++)
        out[k++] = (u16)(u8)name[i];
    out[k] = 0;
}

static i32 ctl_write(const char *name, const char *text, u32 n)
{
    u16 path[260];
    void *h;
    u32 w = 0;
    ctl_path(path, name);
    /* GENERIC_WRITE, share read, CREATE_ALWAYS */
    h = (*(createfilew_fn *)(image_base() + IAT_CREATEFILEW))(path, 0x40000000, 1, 0, 2, 0x80, 0);
    if (h == INVALID_HANDLE)
        return 0;
    (*(writefile_fn *)(image_base() + IAT_WRITEFILE))(h, text, n, &w, 0);
    (*(closehandle_fn *)(image_base() + IAT_CLOSEHANDLE))(h);
    return w == n;
}

/* The file's text (NUL-terminated), its length, or -1 when it isn't there. */
static i32 ctl_read(const char *name, char *buf, u32 max)
{
    u16 path[260];
    void *h;
    u32 got = 0;
    ctl_path(path, name);
    /* GENERIC_READ, share read|write|delete, OPEN_EXISTING */
    h = (*(createfilew_fn *)(image_base() + IAT_CREATEFILEW))(path, 0x80000000, 7, 0, 3, 0x80, 0);
    if (h == INVALID_HANDLE)
        return -1;
    (*(readfile_fn *)(image_base() + IAT_READFILE))(h, buf, max - 1, &got, 0);
    (*(closehandle_fn *)(image_base() + IAT_CLOSEHANDLE))(h);
    buf[got] = 0;
    return (i32)got;
}

static char *put_dec(char *p, i32 v)
{
    char t[12];
    i32 n = 0;
    if (v < 0) { *p++ = '-'; v = -v; }
    do { t[n++] = (char)('0' + v % 10); v /= 10; } while (v);
    while (n)
        *p++ = t[--n];
    *p = 0;
    return p;
}

static char *put_str(char *p, const char *s)
{
    while (*s)
        *p++ = *s++;
    *p = 0;
    return p;
}

/* Sets an (empty) FString to msg, as the game's own refusals are. */
static void set_fstring(struct fstring *e, const char *msg)
{
    i32 i, n = 0;
    while (msg[n])
        n++;
    n++;
    if (e->data || e->max)
        return;
    e->num = n;
    FN(R_STRING_RESIZE, resize_fn)(e, n, 0);
    if (!e->data)
        return;
    for (i = 0; i < n; i++)
        ((u16 *)e->data)[i] = (u16)(u8)msg[i];
}

static i32 login_seq;               /* verify requests made */
static i32 last_verified;           /* the request PreLogin just passed (0 none) */

/* PreLogin with the agent: the ticket from ?Nonce= in the login options
 * (the stock menu's ConnectToServer opens "<server>?Nonce=<nonce>", VA
 * 0x1401dce90), checked by the backend through the agent (up to 8 s); a
 * missing ticket, a refusal or no answer refuses the login. */
static void ticket_check(struct fstring *options, struct fstring *error)
{
    const char *key = "?nonce=";       /* matched case-insensitively */
    u16 *o = (u16 *)options->data;
    char name[32], req[400], ans[200], *q;
    i32 i, k, start = -1, len, n = options->num, waited;
    last_verified = 0;
    for (i = 0; o && i < n && start < 0; i++) {
        for (k = 0; key[k] && i + k < n && (o[i + k] | (o[i + k] >= 'A' && o[i + k] <= 'Z' ? 0x20 : 0)) == (u16)key[k]; k++)
            ;
        if (!key[k])
            start = i + k;
    }
    if (start < 0) {
        set_fstring(error, "No match ticket");
        return;
    }
    for (len = 0; start + len < n && o[start + len] && o[start + len] != '?' && len < (i32)sizeof(req) - 2; len++)
        req[len] = (char)o[start + len];
    req[len] = 0;
    login_seq++;
    q = put_str(name, "verify-");
    q = put_dec(q, login_seq);
    put_str(q, ".req");
    if (!ctl_write(name, req, (u32)len)) {
        set_fstring(error, "Server error (ticket)");
        return;
    }
    put_str(q, ".ans");
    for (waited = 0; waited < 8000; waited += 20) {
        if (ctl_read(name, ans, sizeof(ans)) > 0) {
            if (ans[0] == 'o' && ans[1] == 'k') {
                last_verified = login_seq;
                return;
            }
            set_fstring(error, "Match ticket refused");
            return;
        }
        (*(sleep_fn *)(image_base() + IAT_SLEEP))(20);
    }
    set_fstring(error, "Match ticket not checked in time");
}

/* Which verify request each joined connection passed with. Reached through
 * a pointer: indexing a static array directly makes the compiler address it
 * from __ImageBase, which this position-independent blob doesn't have. */
#define MAX_JOINS          64
struct join_table { void *conn[MAX_JOINS]; void *ps[MAX_JOINS]; i32 seq[MAX_JOINS]; u32 died[MAX_JOINS]; i32 n; u32 start; };
static struct join_table join_store;
__declspec(noinline) static struct join_table *join_table(void) { return &join_store; }

static void *find_game_net_driver(void *engine, void *world)
{
    u8 *wc = (u8 *)FN(R_GET_WORLDCTX, get_worldctx_fn)(engine, world);
    if (!wc)
        return 0;
    u8 *entry = F(wc, O_WC_DRIVERS_PTR, u8 *);
    i32 num = F(wc, O_WC_DRIVERS_NUM, i32);
    for (i32 i = 0; entry && i < num; i++) {
        u8 *driver = F(entry, (u64)i * WC_DRIVER_STRIDE, u8 *);
        if (driver && F(driver, O_ND_NAME, u64) == NAME_GAMENETDRIVER)
            return driver;
    }
    return 0;
}

static void bind_world(void *world, void *driver)
{
    F(world, O_WORLD_NETDRIVER, void *) = driver;
    F(FN(R_FIND_ADD_COLL, find_add_coll_fn)(world, COLL_DYNAMIC_SOURCE), O_COLL_NETDRIVER, void *) = driver;
    F(FN(R_FIND_ADD_COLL, find_add_coll_fn)(world, COLL_STATIC), O_COLL_NETDRIVER, void *) = driver;
}

/* The driver np_listen bound (compared, never freed here). */
static void *listen_driver;

/* Replaces LoadMap's call of UWorld::Listen(URL). */
u8 np_listen(void *world, void *url)
{
    struct line l;
    void *engine = (void *)GLOBAL(R_GENGINE, u64);
    if (trace_begin(&l, "listen")) {
        kv(&l, "world", (u64)world, 1);
        kv(&l, "port", url ? (u64)F(url, O_URL_PORT, i32) : 0, 0);
        kv(&l, "netdriver", world ? (u64)F(world, O_WORLD_NETDRIVER, void *) : 0, 1);
        trace_end(&l);
    }
    if (!world || !engine || !url)
        return 0;
    /* A world that already has a driver can't listen (stock: NetDriverAlreadyExists). */
    if (F(world, O_WORLD_NETDRIVER, void *))
        return 0;

    u8 created = FN(R_CREATE_NAMED_ND, create_named_nd_fn)(engine, world, NAME_GAMENETDRIVER, NAME_GAMENETDRIVER);
    void *driver = find_game_net_driver(engine, world);
    if (trace_begin(&l, "listen-create")) {
        kv(&l, "created", created, 0);
        kv(&l, "driver", (u64)driver, 1);
        kv(&l, "vtable", vt_rva(driver), 1);
        trace_end(&l);
    }
    if (!driver)
        return 0;   /* stock: NetDriverCreateFailure */

    FN(R_SET_WORLD, set_world_fn)(driver, world);
    bind_world(world, driver);

    struct fstring error = { 0, 0, 0 };
    void **vt = *(void ***)driver;
    init_listen_fn init = (init_listen_fn)vt[VT_INITLISTEN / 8];
    u8 steam = (u64)init == image_base() + R_STEAM_INITLISTEN;
    /* The GameNetDriver definition is the Steam driver. Its InitListen opens a
     * Steam (emulator) P2P socket unless the URL has ?bIsLanMatch, and on this
     * launch path the option doesn't reach it (in game: no UDP port, ok=1).
     * Take its LAN branch directly, as it does itself: bIsPassthrough = 1,
     * then UIpNetDriver::InitListen, a plain UDP socket on the URL's port. */
    if (steam) {
        F(driver, O_STEAM_PASSTHRU, u8) = 1;
        init = FN(R_IP_INITLISTEN, init_listen_fn);
    }
    u8 ok = init(driver, (u8 *)world + O_WORLD_NOTIFY, url, 0, &error);
    if (ok && ctl_on())
        ctl_write("listening", "1", 1);
    if (trace_begin(&l, "listen-init")) {
        kv(&l, "ok", ok, 0);
        kv(&l, "steam_lan", steam, 0);
        kv(&l, "port", (u64)F(url, O_URL_PORT, i32), 0);
        kv(&l, "notify", (u64)F(driver, O_ND_NOTIFY, void *), 1);
        kv(&l, "error_len", (u64)error.num, 0);
        trace_end(&l);
    }
    if (!ok) {
        /* Stock: NetDriverListenFailure, then DestroyNamedNetDriver. Here the
         * driver is unbound and left unticked in ActiveNetDrivers. */
        bind_world(world, 0);
        FN(R_SET_WORLD, set_world_fn)(driver, 0);
        return 0;
    }
    listen_driver = driver;
    return 1;
}

/* ---- FNetworkNotify trace hooks --------------------------------------- */

typedef i32 (*notify_accepting_fn)(void *notify);
typedef void (*notify_accepted_fn)(void *notify, void *conn);
typedef void (*notify_control_fn)(void *notify, void *conn, u8 type, void *bunch);

/* notify is UWorld+0x28; the world's driver is notify+0x10. */
static u64 server_side(void *notify)
{
    u8 *driver = F(notify, O_WORLD_NETDRIVER - O_WORLD_NOTIFY, u8 *);
    return driver && !F(driver, O_ND_SERVERCONN, void *);
}

i32 np_notify_accepting(void *notify)
{
    struct line l;
    i32 r = FN(R_NOTIFY_ACCEPTING, notify_accepting_fn)(notify);
    if (trace_begin(&l, "accepting")) {
        kv(&l, "result", (u64)r, 0);   /* 0 reject, 1 accept, 2 ignore */
        trace_end(&l);
    }
    return r;
}

void np_notify_accepted(void *notify, void *conn)
{
    struct line l;
    FN(R_NOTIFY_ACCEPTED, notify_accepted_fn)(notify, conn);
    if (trace_begin(&l, "accepted")) {
        kv(&l, "conn", (u64)conn, 1);
        kv(&l, "state", conn ? (u64)F(conn, O_CONN_STATE, i32) : 0, 0);
        trace_end(&l);
    }
}

/* The game mode's PreLogin (AShooterGameMode, VA 0x140236e90) refuses every
 * login with "Match is over!" while its game state's vfunc +0x640 is true. */
#define O_WORLD_AUTH_GM    0xf0        /* UWorld::AuthorityGameMode */
#define O_GM_GAMESTATE     0x458       /* AGameModeBase::GameState */
#define VT_GS_MATCH_OVER   0x640
typedef u8 (*gs_bool_fn)(void *gs);

static u64 match_over(void *notify)
{
    u8 *world = (u8 *)notify - O_WORLD_NOTIFY;
    u8 *gm = F(world, O_WORLD_AUTH_GM, u8 *);
    u8 *gs = gm ? F(gm, O_GM_GAMESTATE, u8 *) : 0;
    if (!gs)
        return 2;                  /* no game state */
    return ((gs_bool_fn)(*(void ***)gs)[VT_GS_MATCH_OVER / 8])(gs);
}

/* ---- the game mode's PreLogin ----------------------------------------- */

/* Replaces AShooterGame_FreeForAll's vtable slot +0x6c8 (PreLogin; stock
 * 0x140245320 -> AShooterGameMode::PreLogin 0x140236e90). The game's PreLogin
 * refuses everyone with "Match is over!" while its game state's vfunc +0x640
 * is true: in game that was already so 28 s after the host started (a local
 * match starts at once). Until the host holds its match for the expected
 * players, the netplay exe skips that one check and runs only what the
 * game's PreLogin runs otherwise: AGameModeBase::PreLogin (0x141343270, the
 * engine's checks: the game session's ApproveLogin). Logged in the trace. */
#define R_BASE_PRELOGIN    0x1343270
typedef void (*prelogin_fn)(void *gm, void *options, void *address, void *uid, void *error);

/* CULLING_NETPLAY_PREMATCH=N: a real pre-match phase. The host holds its
 * match in WaitingToStart (the warmup countdown stays full) until N players
 * have joined, then lets the game's own 15 s countdown run, so every player
 * spawns into a pod at the start. With it, the two test-only bypasses are
 * off: the game's own PreLogin runs (it refuses once the match is over) and
 * the no-end flag isn't set. 0 or unset: the old test host. */
#define R_GAME_PRELOGIN    0x245320    /* FreeForAll's stock PreLogin slot target (AShooterGameMode::PreLogin) */
static const u16 prematch_var[] = { 'C','U','L','L','I','N','G','_','N','E','T','P','L','A','Y','_','P','R','E','M','A','T','C','H',0 };
static i32 prematch_n = -1;

static i32 prematch_expected(void)
{
    u16 v[8];
    u32 n, i;
    if (prematch_n < 0) {
        n = (*(getenvw_fn *)(image_base() + IAT_GETENVW))(prematch_var, v, 8);
        prematch_n = 0;
        for (i = 0; n > 0 && n < 4 && i < n && v[i] >= '0' && v[i] <= '9'; i++)
            prematch_n = prematch_n * 10 + (v[i] - '0');
    }
    return prematch_n;
}

void np_prelogin(void *gm, void *options, void *address, void *uid, void *error)
{
    struct line l;
    if (ctl_on()) {
        ticket_check((struct fstring *)options, (struct fstring *)error);
        if (((struct fstring *)error)->num) {
            if (trace_begin(&l, "prelogin-refused")) {
                /* The options as given (printable ASCII, the first 300
                 * characters): where a client's ticket did or didn't land. */
                struct fstring *o = (struct fstring *)options;
                u16 *c = (u16 *)o->data;
                i32 i;
                kv(&l, "request", (u64)login_seq, 0);
                kv(&l, "options_len", (u64)(o->num > 0 ? o->num : 0), 0);
                put_s(&l, " options=");
                for (i = 0; c && i < o->num && c[i] && i < 300 && l.n < sizeof(l.b) - 2; i++)
                    l.b[l.n++] = c[i] >= 0x20 && c[i] < 0x7f ? (char)c[i] : '.';
                trace_end(&l);
            }
            return;
        }
    }
    if (prematch_expected() > 0)
        FN(R_GAME_PRELOGIN, prelogin_fn)(gm, options, address, uid, error);
    else
        FN(R_BASE_PRELOGIN, prelogin_fn)(gm, options, address, uid, error);
    if (trace_begin(&l, "prelogin")) {
        kv(&l, "error_len", (u64)((struct fstring *)error)->num, 0);
        kv(&l, "game_checks", prematch_expected() > 0, 0);
        kv(&l, "ticket_request", (u64)last_verified, 0);
        trace_end(&l);
    }
}

void np_notify_control(void *notify, void *conn, u8 type, void *bunch)
{
    struct line l;
    u64 server = server_side(notify);
    if (trace_begin(&l, "control")) {
        kv(&l, "server", server, 0);
        kv(&l, "type", type, 0);   /* 0 Hello, 4 Netspeed, 5 Login, 6 Failure, 9 Join, 17 DebugText, 18 NetGUIDAssign */
        kv(&l, "conn", (u64)conn, 1);
        if (server && type == 5)
            kv(&l, "match_over", match_over(notify), 0);
        trace_end(&l);
    }
    if (server && type == 5)
        last_verified = 0;
    FN(R_NOTIFY_CONTROL, notify_control_fn)(notify, conn, type, bunch);
    if (server && type == 5 && conn && last_verified && join_table()->n < MAX_JOINS) {
        struct join_table *t = join_table();
        t->conn[t->n] = conn;
        t->seq[t->n++] = last_verified;
    }
    if (trace_begin(&l, "control-done")) {
        kv(&l, "type", type, 0);
        kv(&l, "state", conn ? (u64)F(conn, O_CONN_STATE, i32) : 0, 0);
        kv(&l, "pc", conn ? (u64)F(conn, O_CONN_PC, void *) : 0, 1);
        kv(&l, "pc_vtable", conn ? vt_rva(F(conn, O_CONN_PC, void *)) : 0, 1);
        trace_end(&l);
    }
}

/* A signed value in a trace line. */
static void kv_s(struct line *l, const char *k, i32 v)
{
    put_s(l, " ");
    put_s(l, k);
    put_s(l, "=");
    if (v < 0) {
        put_s(l, "-");
        v = -v;
    }
    put_d(l, (u64)v);
}

/* ---- milestone 3: the host sends its world (ServerReplicateActors) ------ */

/* This build has no UNetDriver::ServerReplicateActors (WITH_SERVER_CODE=0),
 * but everything under it survives because the replay recorder uses it:
 * UNetConnection::CreateChannel, UActorChannel::SetChannelActor and
 * ReplicateActor, server NetGUID assignment inside the package map, and
 * UNetDriver::NotifyActorDestroyed's channel close. np_tick_flush replaces the
 * Steam driver's TickFlush slot and, on the host's listen driver, runs a
 * minimal ServerReplicateActors first, modelled on
 * UDemoNetDriver::ReplicateActor (VA 0x1412ee2e0), then the stock TickFlush.
 * On a client it only traces what replication gave it. */
#define R_STEAM_TICKFLUSH  0x2335370   /* USteamNetDriver::TickFlush(driver, float) (calls UNetDriver::TickFlush) */
#define R_CREATE_CHANNEL   0x142d660   /* UNetConnection::CreateChannel(conn, type, bOpenedLocally, index) */
#define R_SET_CH_ACTOR     0x12e0d70   /* UActorChannel::SetChannelActor(ch, actor) */
#define R_REPLICATE_ACTOR  0x12dcf30   /* UActorChannel::ReplicateActor(ch) -> bool */
#define R_PRE_REPLICATION  0x110bf50   /* AActor::CallPreReplication(actor, driver) */
#define R_WEAK_SET         0x69c2a0    /* FWeakObjectPtr::operator=(weak, obj) */
#define R_WEAK_GET         0x69c470    /* FWeakObjectPtr::Get(weak) -> obj */
#define CHTYPE_ACTOR       2
#define O_ND_CLIENTS       0x78        /* UNetDriver::ClientConnections (TArray<UNetConnection*>) */
#define O_ND_WORLD         0xa0
#define O_CONN_CHMAP       0x334b8     /* UNetConnection::ActorChannels (TMap<TWeakObjectPtr<AActor>, UActorChannel*>) */
#define O_CH_FLAGS         0x30        /* UChannel: bit 1 Closing */
#define VT_CONN_LEVEL_INIT 0x2c8       /* UNetConnection::ClientHasInitializedLevelFor(conn, actor) */
#define VT_CONN_NET_READY  0x268       /* UNetConnection::IsNetReady(conn, bool Saturate) -> int (game code 0x140209ea5) */
#define VT_PC_VIEW_TARGET  0x628       /* APlayerController::GetViewTarget(pc) -> actor (game code 0x140209ec2) */
#define VT_PC_VIEW_POINT   0x680       /* APlayerController::GetPlayerViewPoint(pc, FVector *loc, FRotator *rot) */
#define VT_A_NET_RELEVANT  0x400       /* AActor::IsNetRelevantFor(actor, RealViewer, ViewTarget, const FVector *SrcLocation) */
#define VT_CH_CLOSE        0x218       /* UChannel::Close(ch) */
#define O_A_CULL_DIST_SQ   0x12c       /* AActor::NetCullDistanceSquared (float) */
#define R_SEND_CLIENT_ADJ  0x124a7d0   /* UCharacterMovementComponent::SendClientAdjustment (this = its INetworkPredictionInterface, component +0x180) */
#define O_CMC_PREDICTION   0x180       /* UCharacterMovementComponent's INetworkPredictionInterface */
#define O_PC_ACK_PAWN      0x478       /* APlayerController::AcknowledgedPawn */
#define O_CH_MOVEMENT      0x468       /* ACharacter::CharacterMovement */
#define ROLE_AUTONOMOUS    2           /* ENetRole::ROLE_AutonomousProxy */
#define ROLE_SIMULATED     1           /* ENetRole::ROLE_SimulatedProxy */
#define O_ND_REP_FRAME     0x280       /* UNetDriver::ReplicationFrame (UDemoNetDriver::TickDemoRecord increments it, 0x14130541f) */
#define MAX_OPEN_PER_PASS  16          /* new actor channels per connection per pass (reliable buffer) */
#define O_GS_PLAYERS       0x418       /* AGameState::PlayerArray */
#define O_W_CONTROLLERS    0x178       /* UWorld controller list (weak pointers) */
#define O_W_PAWNS          0x198       /* UWorld pawn list (weak pointers) */
#define O_C_PAWN           0x408       /* AController::Pawn */
#define O_A_FLAGS          0x84        /* AActor bits: 2 bNetTemporary, 4 bNetStartup, 8 bOnlyRelevantToOwner, 0x40 bTearOff */
#define O_A_REMOTE_ROLE    0x90
#define O_A_OWNER          0x98
#define O_A_ROOT           0x1e0
#define O_SC_LOCATION      0x1a0       /* USceneComponent: world location */
#define O_CH_INVENTORY     0xd30       /* AShooterCharacter::Inventory (TArray<AShooterWeapon*>) */
#define O_CH_CURRENT       0x8d8       /* AShooterCharacter::CurrentWeapon */
#define O_OBJ_CLASS        0x10        /* UObjectBase::ClassPrivate */
#define R_SPAWN_WEAPON     0x27a810    /* AShooterCharacter::SpawnWeapon(pawn, UClass*): into its inventory (the Remaster's Showdown kit uses it) */
#define MAX_INVENTORY      32
#define MAX_REP            384
#define R_ACTORS_OF_CLASS  0x1336ca0   /* UGameplayStatics::GetAllActorsOfClass(ctx, class, TArray<AActor*> *out) */
#define R_FREE             0x50c510    /* FMemory::Free */
#define R_FNAME            0x5b0e60    /* FName::FName(this, const TCHAR *, EFindName) -> this */
#define O_CLASS_CHAIN      0x88        /* UStruct base chain: data (each entry = an ancestor + 0x88), then count - 1; [1] is Actor */
#define O_OBJ_NAME         0x18        /* UObjectBase::NamePrivate (FName: index, number) */
#define WORLD_SCAN_MS      2000
#define MAX_WORLD          8000
#define REP_PERIOD_MS      50

typedef void (*tick_flush_fn)(void *driver, float dt);
typedef void *(*create_channel_fn)(void *conn, i32 type, u8 local, i32 index);
typedef void (*set_ch_actor_fn)(void *ch, void *actor);
typedef u8 (*replicate_fn)(void *ch);
typedef void (*pre_rep_fn)(void *actor, void *driver);
typedef void (*weak_set_fn)(void *weak, void *obj);
typedef void *(*weak_get_fn)(void *weak);
typedef u8 (*conn_actor_fn)(void *conn, void *actor);
typedef i32 (*conn_ready_fn)(void *conn, u8 saturate);
typedef void *(*pc_view_target_fn)(void *pc);
typedef void (*pc_view_point_fn)(void *pc, float *loc, float *rot);
typedef u8 (*net_relevant_fn)(void *actor, void *viewer, void *view_target, const float *loc);
typedef void (*ch_close_fn)(void *ch);
typedef void (*send_adj_fn)(void *prediction);

struct weak { i32 index, serial; };
struct rep_stats { u64 actors, opened, replicated, skipped, deferred, saturated; u64 opened_now; u8 *remote_pawn, *remote_conn; u64 relevant, culled, closed, adjusted; };

/* The channel already replicating actor on conn: UNetConnection::ActorChannels'
 * hash lookup, as UDemoNetDriver::ReplicateActor does it (key = the actor's
 * FWeakObjectPtr, hash = index ^ serial, 0x18-byte elements {key, channel,
 * next}; map +0x08 count, +0x34 free count, +0x38 inline hash, +0x40 hash
 * pointer, +0x48 hash size). */
static void *find_channel(u8 *conn, void *actor)
{
    struct weak key;
    u8 *map = conn + O_CONN_CHMAP;
    i32 num = F(map, 0x08, i32) - F(map, 0x34, i32);
    i32 *hash, i, size;
    u8 *elems = F(map, 0x00, u8 *);
    FN(R_WEAK_SET, weak_set_fn)(&key, actor);
    if (num <= 0 || !elems)
        return 0;
    hash = F(map, 0x40, i32 *) ? F(map, 0x40, i32 *) : (i32 *)(map + 0x38);
    size = F(map, 0x48, i32);
    if (size <= 0)
        return 0;
    for (i = hash[(u32)(key.index ^ key.serial) & (u32)(size - 1)]; i != -1; i = F(elems + (u64)i * 0x18, 0x10, i32)) {
        u8 *e = elems + (u64)i * 0x18;
        if (F(e, 0, i32) == key.index && F(e, 4, i32) == key.serial)
            return F(e, 8, void *);
    }
    return 0;
}

/* Is actor, or something that owns it, the connection's PlayerController? */
static i32 owned_by(u8 *actor, void *pc)
{
    i32 depth;
    for (depth = 0; actor && depth < 8; depth++, actor = F(actor, O_A_OWNER, u8 *))
        if (actor == pc)
            return 1;
    return 0;
}

static i32 prerep_state = 1;       /* 1 = not looked up yet, 2 = on, 3 = off */
static i32 move_state = 1;

/* "1" in the environment variable var (UTF-16), looked up once into *state. */
static i32 env_on(const u16 *var, i32 *state)
{
    u16 v[8];
    if (*state == 1) {
        u32 n = (*(getenvw_fn *)(image_base() + IAT_GETENVW))(var, v, 8);
        *state = (n == 1 && v[0] == '1') ? 2 : 3;
    }
    return *state == 2;
}

/* Replicates actor to conn. Returns 0 when it was deferred (no channel yet
 * for want of room this pass), else 1 (sent, or not for this connection). */
static i32 replicate_to(u8 *conn, u8 *actor, void *pc, struct rep_stats *st)
{
    u8 flags = F(actor, O_A_FLAGS, u8);
    void *ch;
    if (!F(actor, O_A_REMOTE_ROLE, u8) && !(flags & 0x40)) { st->skipped++; return 1; }
    if ((flags & 0x08) && !owned_by(actor, pc)) { st->skipped++; return 1; }
    if ((flags & 0x04) && !((conn_actor_fn)(*(void ***)conn)[VT_CONN_LEVEL_INIT / 8])(conn, actor)) { st->skipped++; return 1; }
    ch = find_channel(conn, actor);
    if (!ch) {
        if (flags & 0x40) { st->skipped++; return 1; }      /* torn off: nothing new to open */
        if (st->opened_now >= MAX_OPEN_PER_PASS) { st->deferred++; return 0; }
        st->opened_now++;
        ch = FN(R_CREATE_CHANNEL, create_channel_fn)(conn, CHTYPE_ACTOR, 1, -1);
        if (!ch) { st->skipped++; return 0; }
        FN(R_SET_CH_ACTOR, set_ch_actor_fn)(ch, actor);
        st->opened++;
    }
    if (F(ch, O_CH_FLAGS, u8) & 2)
        return 1;                                            /* closing */
    {
        /* A player's pawn is an autonomous proxy only to its owner (the
         * connection whose PlayerController's Pawn it is: an Owner-chain test
         * alone also downgraded the owner's own pawn, and the clients lost
         * control of it in game); to every other connection it goes as a
         * simulated proxy, which is what gets
         * replicated movement. ReplicateActor here doesn't downgrade it (it
         * only reads RemoteRole; the engine's ServerReplicateActors did), so
         * this does, around the call (in game: the other player's pawn was
         * sent but never moved on the client). */
        u8 role = F(actor, O_A_REMOTE_ROLE, u8);
        i32 swap = role == ROLE_AUTONOMOUS && actor != F((u8 *)pc, O_C_PAWN, u8 *) && !owned_by(actor, pc);
        if (swap)
            F(actor, O_A_REMOTE_ROLE, u8) = ROLE_SIMULATED;
        FN(R_REPLICATE_ACTOR, replicate_fn)(ch);
        if (swap)
            F(actor, O_A_REMOTE_ROLE, u8) = role;
    }
    st->replicated++;
    return 1;
}

/* ---- world objects: every other actor that replicates ------------------ */

typedef u64 *(*fname_fn)(u64 *out, const u16 *name, i32 find);
typedef void (*actors_fn)(void *ctx, void *cls, void *out);
typedef void (*free_fn)(void *p);

/* The base Actor class: depth 1 of any actor class's base chain, checked by
 * its name ("Actor"). 0 if that doesn't hold. */
static u8 *actor_class(u8 *any_actor)
{
    static const u16 actor_name[] = { 'A','c','t','o','r',0 };
    u8 *cls = any_actor ? F(any_actor, O_OBJ_CLASS, u8 *) : 0;
    u8 **chain = cls ? F(cls, O_CLASS_CHAIN, u8 **) : 0;
    u8 *a;
    u64 name;
    if (!chain || F(cls, O_CLASS_CHAIN + 8, i32) < 1)
        return 0;
    a = chain[1] - O_CLASS_CHAIN;
    FN(R_FNAME, fname_fn)(&name, actor_name, 0);            /* FNAME_Find */
    return F(a, O_OBJ_NAME, u64) == name ? a : 0;
}

/* The world's replicated actors, kept between scans as weak pointers written
 * in place over the array GetAllActorsOfClass allocated (both 8 bytes). */
static struct weak *world_list;
static i32 world_num;
static void *world_of_list;
static u32 last_scan;

/* The base class at depth 2 of an object's class chain (APawn for a pawn,
 * AController for a controller), as the chain entry is stored. */
static u8 *depth2(u8 *obj)
{
    u8 *cls = obj ? F(obj, O_OBJ_CLASS, u8 *) : 0;
    return cls && F(cls, O_CLASS_CHAIN + 8, i32) >= 2 ? F(cls, O_CLASS_CHAIN, u8 **)[2] : 0;
}

static u8 *pawn_kind, *controller_kind;    /* depth-2 chain entries of a pawn and a controller */

static void scan_world(u8 *world, u8 *gm, u8 *gs, u32 now)
{
    struct { u8 **data; i32 num, max; } found;
    u8 *cls;
    i32 i, n = 0;
    if (world == world_of_list && now - last_scan < WORLD_SCAN_MS)
        return;
    last_scan = now;
    if (world_list) {
        FN(R_FREE, free_fn)(world_list);
        world_list = 0;
        world_num = 0;
    }
    world_of_list = world;
    cls = actor_class(gs);
    if (!cls || !gm)
        return;
    found.data = 0;
    found.num = found.max = 0;
    FN(R_ACTORS_OF_CLASS, actors_fn)(gm, cls, &found);
    for (i = 0; found.data && i < found.num && n < MAX_WORLD; i++) {
        u8 *a = found.data[i], *owner, *k;
        if (!a || !F(a, O_A_REMOTE_ROLE, u8))
            continue;                                        /* doesn't replicate */
        /* Pawns, controllers and what a pawn owns (its weapons) are always
         * sent from the first list; here their channel would be closed again
         * when far (in game: the other player's pawn froze on the client). */
        k = depth2(a);
        owner = F(a, O_A_OWNER, u8 *);
        if (k && (k == pawn_kind || k == controller_kind))
            continue;
        if (owner && pawn_kind && depth2(owner) == pawn_kind)
            continue;
        FN(R_WEAK_SET, weak_set_fn)((struct weak *)found.data + n, a);
        n++;
    }
    world_list = (struct weak *)found.data;
    world_num = n;
}


/* Loot: weapons and items lying in the world are AShooterWeapon actors with
 * no owner (the Remaster module's dropped-item cleanup treats them so). The
 * host's and the client's counts side by side show whether loot reached the
 * client. */
#define R_CLS_PICKUP       0x303d00    /* AShooterWeapon::StaticClass getter (takes the package name) */
#define R_PKG_VICTORY      0x2567aa0   /* L"/Script/Victory" */
typedef u8 *(*class_fn)(const u16 *pkg);
/* Fields past AActor (inventory, current weapon, health) are read only from
 * AShooterCharacters: a dead player's spectator pawn is another, smaller
 * class (reading them there crashed a client, and the host at match end). */
static i32 is_character(u8 *obj);

static i32 count_pickups(void *ctx)
{
    struct { u8 **data; i32 num, max; } found;
    u8 *cls = FN(R_CLS_PICKUP, class_fn)((const u16 *)(image_base() + R_PKG_VICTORY));
    i32 n, i;
    if (!cls || !ctx)
        return -1;
    found.data = 0;
    found.num = found.max = 0;
    FN(R_ACTORS_OF_CLASS, actors_fn)(ctx, cls, &found);
    for (n = 0, i = 0; found.data && i < found.num; i++)
        if (found.data[i] && !F(found.data[i], O_A_OWNER, u8 *))
            n++;
    if (found.data)
        FN(R_FREE, free_fn)(found.data);
    return n;
}

/* The actors replicated: the game state, its player states, every
 * controller and every pawn in the world (no relevancy culling yet). */
static i32 collect(u8 *world, u8 **out, u8 *kind)
{
    i32 n = 0, i, num, pass;
    u8 *gm = F(world, O_WORLD_AUTH_GM, u8 *);
    u8 *gs = gm ? F(gm, O_GM_GAMESTATE, u8 *) : 0;
    if (gs) {
        u8 **ps = F(gs, O_GS_PLAYERS, u8 **);
        kind[n] = 0;
        out[n++] = gs;
        num = F(gs, O_GS_PLAYERS + 8, i32);
        for (i = 0; ps && i < num && n < MAX_REP; i++)
            if (ps[i]) {
                kind[n] = 0;
                out[n++] = ps[i];
            }
    }
    for (pass = 0; pass < 2; pass++) {
        u8 *list = world + (pass ? O_W_PAWNS : O_W_CONTROLLERS);
        u8 *data = F(list, 0, u8 *);
        num = F(list, 8, i32);
        for (i = 0; data && i < num && n < MAX_REP; i++) {
            u8 *a = (u8 *)FN(R_WEAK_GET, weak_get_fn)(data + (u64)i * 8);
            if (!a)
                continue;
            if (pass && is_character(a)) {
                /* A character's inventory weapons go first, so that the
                 * character's Inventory and CurrentWeapon refer to weapons
                 * the client already has (in game, a reference sent before
                 * its weapon stayed null on the client). */
                u8 **items = F(a, O_CH_INVENTORY, u8 **);
                i32 k, ni = F(a, O_CH_INVENTORY + 8, i32);
                u8 *cur = F(a, O_CH_CURRENT, u8 *);
                if (items && ni >= 0 && ni <= MAX_INVENTORY)
                    for (k = 0; k < ni && n < MAX_REP - 2; k++)
                        if (items[k]) {
                            kind[n] = 1;
                            out[n++] = items[k];
                        }
                if (cur && n < MAX_REP - 2) {
                    kind[n] = 1;
                    out[n++] = cur;
                }
                kind[n] = 2;
            } else if (pass) {
                kind[n] = 2;
            } else {
                kind[n] = 0;
            }
            out[n++] = a;
        }
    }
    return n;
}

static u32 last_rep, last_trace, last_alive;


/* CULLING_NETPLAY_PREREP=1 turns on AActor::CallPreReplication before
 * replicating (it updates replicated movement); off until it's proven safe
 * in game. */
static i32 prerep_on(void)
{
    static const u16 var[] = { 'C','U','L','L','I','N','G','_','N','E','T','P','L','A','Y','_','P','R','E','R','E','P',0 };
    return env_on(var, &prerep_state);
}

/* CULLING_NETPLAY_GIVE=1: 10 s after the joined player has a pawn, the host
 * gives it, once, a weapon class a bot carries that it doesn't (SpawnWeapon),
 * so the test can see a mid-match inventory change reach the client. */
typedef void *(*spawn_weapon_fn)(void *pawn, void *cls);
static i32 give_state = 1, gave;
static u32 give_at;

static i32 holds_class(u8 *pawn, u8 *cls)
{
    u8 **items = is_character(pawn) ? F(pawn, O_CH_INVENTORY, u8 **) : 0;
    i32 k, ni = items ? F(pawn, O_CH_INVENTORY + 8, i32) : 0;
    for (k = 0; items && k < ni && k < MAX_INVENTORY; k++)
        if (items[k] && F(items[k], O_OBJ_CLASS, u8 *) == cls)
            return 1;
    return 0;
}

static void host_give(u8 *world, u8 *remote, u32 now)
{
    static const u16 var[] = { 'C','U','L','L','I','N','G','_','N','E','T','P','L','A','Y','_','G','I','V','E',0 };
    u8 *data;
    i32 i, num;
    struct line l;
    if (gave || !remote || !is_character(remote) || !env_on(var, &give_state))
        return;
    if (!give_at) { give_at = now + 10000; return; }
    if ((i32)(now - give_at) < 0)
        return;
    data = F(world + O_W_PAWNS, 0, u8 *);
    num = F(world + O_W_PAWNS, 8, i32);
    for (i = 0; data && i < num && !gave; i++) {
        u8 *p = (u8 *)FN(R_WEAK_GET, weak_get_fn)(data + (u64)i * 8);
        u8 **items;
        i32 k, ni;
        if (!p || p == remote || !is_character(p))
            continue;
        items = F(p, O_CH_INVENTORY, u8 **);
        ni = F(p, O_CH_INVENTORY + 8, i32);
        for (k = 0; items && k < ni && k < MAX_INVENTORY && !gave; k++) {
            u8 *cls = items[k] ? F(items[k], O_OBJ_CLASS, u8 *) : 0;
            if (!cls || holds_class(remote, cls))
                continue;
            FN(R_SPAWN_WEAPON, spawn_weapon_fn)(remote, cls);
            gave = 1;
            if (trace_begin(&l, "give")) {
                kv(&l, "pawn", (u64)remote, 1);
                kv(&l, "class", (u64)cls, 1);
                kv(&l, "inventory", (u64)F(remote, O_CH_INVENTORY + 8, i32), 0);
                trace_end(&l);
            }
        }
    }
}

/* CULLING_NETPLAY_TELEPORT=1: 20 s after the joined player has a pawn, the
 * host moves it once across the island (another pod start, AActor::
 * K2_TeleportTo), so the test sees far objects' channels close and the new
 * neighbourhood's open. */
#define R_TELEPORT         0x111fae0   /* AActor::K2_TeleportTo(actor, const FVector *, const FRotator *) -> bool */
typedef u8 (*teleport_fn)(void *actor, const float *loc, const float *rot);
static i32 tp_state = 1, teleported;
static u32 tp_at;

/* CULLING_NETPLAY_TELEPORT=2: 10 s after a second player has a pawn, the
 * host puts both players once side by side on the centre arena's floor, so
 * the two can see each other move. */
static i32 tp2_done;
static u32 tp2_at;

/* CULLING_NETPLAY_ATTACK=1: the joined players attack each other from their
 * own games (client_attack); the host puts the pair closer and traces both
 * players' health (host_watch). */
#define O_PC_CONTROL_ROT   0x430       /* AController::ControlRotation (FRotator: pitch, yaw, roll) */
static const u16 attack_var[] = { 'C','U','L','L','I','N','G','_','N','E','T','P','L','A','Y','_','A','T','T','A','C','K',0 };
static i32 host_attack_state = 1, client_attack_state = 1;
/* CULLING_NETPLAY_ATTACK_ONE_SIDE=1: only the player standing at the arena's
 * x=0 (the first joined) attacks, so the other's health shows whether the
 * damage comes from the attacker's own game (and the attacker's, that
 * nothing else in the arena hurts them). */
static const u16 one_side_var[] = { 'C','U','L','L','I','N','G','_','N','E','T','P','L','A','Y','_','A','T','T','A','C','K','_','O','N','E','_','S','I','D','E',0 };
static i32 one_side_state = 1;

static void host_teleport_pair(u8 **conns, i32 nconn, u32 now)
{
    u8 *pa = 0, *pb = 0, *root;
    float to[3], rot[3];
    struct line l;
    i32 c;
    if (tp2_done || nconn < 2 || tp_state != 4)
        return;
    for (c = 0; c < nconn; c++) {
        u8 *pc = conns[c] ? F(conns[c], O_CONN_PC, u8 *) : 0;
        u8 *p = pc ? F(pc, O_C_PAWN, u8 *) : 0;
        if (p && !pa) pa = p;
        else if (p && !pb) pb = p;
    }
    if (!pa || !pb)
        return;
    if (!tp2_at) { tp2_at = now + 10000; return; }
    if ((i32)(now - tp2_at) < 0)
        return;
    (void)root;
    /* Both on the open centre-arena floor, 300 apart (players who joined
     * after the pods opened stand in pods that never open). */
    rot[0] = rot[1] = rot[2] = 0.0f;
    tp2_done = 1;
    to[0] = 0.0f; to[1] = -700.0f; to[2] = 200.0f;
    if (trace_begin(&l, "teleport-pair")) {
        kv(&l, "ok_a", FN(R_TELEPORT, teleport_fn)(pa, to, rot), 0);
        to[0] = env_on(attack_var, &host_attack_state) ? 110.0f : 300.0f;   /* within arm's reach for the attack test */
        kv(&l, "ok_b", FN(R_TELEPORT, teleport_fn)(pb, to, rot), 0);
        trace_end(&l);
    }
}

/* CULLING_NETPLAY_DAMAGE=1: from 5 s after the pair teleport, the host deals
 * the second player 25 damage every 3 s, credited to the first player
 * (UGameplayStatics::ApplyDamage, as the autotest mode kills with), until
 * it dies; each hit and the victim's health are traced. */
#define R_APPLY_DAMAGE     0x132cec0   /* float UGameplayStatics::ApplyDamage(victim, amount, instigator controller, causer, damage type) */
#define R_HEALTH           0x262d20    /* health component (pawn +0x830): current health */
#define O_CH_HEALTH        0x830       /* AShooterCharacter health component */
typedef float (*apply_damage_fn)(void *victim, float amount, void *instigator, void *causer, void *type);
typedef float (*health_fn)(void *comp);
static i32 dmg_state = 1, dmg_hits;
static u32 dmg_next;

/* Is obj an AShooterCharacter? The class base-chain test the Remaster
 * module uses (showdown_rounds.c is_a): the class's own chain entry at its
 * depth in the object's class chain. */
#define R_CLS_CHARACTER    0x302cc0    /* AShooterCharacter::StaticClass getter (takes the package name) */
static i32 is_character(u8 *obj)
{
    u8 *cls = FN(R_CLS_CHARACTER, class_fn)((const u16 *)(image_base() + R_PKG_VICTORY));
    u8 *oc = obj ? F(obj, O_OBJ_CLASS, u8 *) : 0;
    i32 idx;
    if (!cls || !oc)
        return 0;
    idx = F(cls, O_CLASS_CHAIN + 8, i32);
    return idx <= F(oc, O_CLASS_CHAIN + 8, i32) && F(oc, O_CLASS_CHAIN, u8 **)[idx] == cls + O_CLASS_CHAIN;
}

/* A character's health; -1 for anything else (a dead player's controller
 * gets another kind of pawn with no health component at +0x830: reading it
 * crashed the client in game). */
static i32 health_of(u8 *pawn)
{
    u8 *h;
    if (!pawn || !is_character(pawn))
        return -1;
    h = F(pawn, O_CH_HEALTH, u8 *);
    return h ? (i32)FN(R_HEALTH, health_fn)(h) : -1;
}

static void host_damage(u8 **conns, i32 nconn, u32 now)
{
    static const u16 var[] = { 'C','U','L','L','I','N','G','_','N','E','T','P','L','A','Y','_','D','A','M','A','G','E',0 };
    u8 *pca = 0, *pa = 0, *pb = 0;
    struct line l;
    float dealt;
    i32 c;
    if (!tp2_done || !env_on(var, &dmg_state) || dmg_hits >= 8)
        return;
    for (c = 0; c < nconn; c++) {
        u8 *pc = conns[c] ? F(conns[c], O_CONN_PC, u8 *) : 0;
        u8 *p = pc ? F(pc, O_C_PAWN, u8 *) : 0;
        if (p && !pa) { pa = p; pca = pc; }
        else if (p && !pb) pb = p;
    }
    if (!pa || !pb)
        return;
    if (!dmg_next) { dmg_next = now + 5000; return; }
    if ((i32)(now - dmg_next) < 0)
        return;
    dmg_next = now + 3000;
    if (health_of(pb) <= 0)
        return;
    dealt = FN(R_APPLY_DAMAGE, apply_damage_fn)(pb, 25.0f, pca, pa, 0);
    dmg_hits++;
    if (trace_begin(&l, "hit")) {
        kv(&l, "n", (u64)dmg_hits, 0);
        kv_s(&l, "dealt", (i32)dealt);
        kv_s(&l, "victim_health", health_of(pb));
        trace_end(&l);
    }
}

/* Kill credit and the scoreboard: the game state's player records
 * (AVictoryGameState +0x468, 0x150 bytes each, the scoreboard's source; the
 * Remaster module reads the same ones). Traced for the two joined players on
 * the host and on each client, every 2 s while CULLING_NETPLAY_ATTACK is on. */
#define O_W_GAMESTATE      0xf8        /* UWorld::GameState (set on clients too) */
#define O_GS_RECORDS       0x468
#define REC_SIZE           0x150
#define REC_PS             0x10        /* the player state (the struct's own property list, VA 0x1404c6400 on) */
#define REC_ALIVE          0x28        /* bIsAlive (the game's IsAlive-by-record reads this byte, VA 0x140240301) */
#define REC_DEATH_ORDER    0x5c
#define REC_KILLER_NAME    0x60        /* FString */
#define REC_KILL_POINTS    0x84
#define REC_VICTIMS        0xe0        /* TArray: players this one killed */
#define REC_BOT_VICTIMS    0xf0
#define REC_KILLERS        0xf8        /* TArray */
#define O_C_PLAYERSTATE    0x420       /* AController::PlayerState */
#define O_PAWN_PLAYERSTATE 0x420       /* APawn::PlayerState (registered at 0x420 like AController's; host_watch checks it) */

static u8 *target_ps;               /* a client's first opponent (client_attack) */

static void trace_records(u8 *world, const char *tag, u8 *ps_a, u8 *ps_b)
{
    u8 *gs = world ? F(world, O_W_GAMESTATE, u8 *) : 0;
    u8 *recs = gs ? F(gs, O_GS_RECORDS, u8 *) : 0;
    i32 i, num = gs ? F(gs, O_GS_RECORDS + 8, i32) : 0, alive = 0, kills = 0, dead = 0;
    struct line l;
    if (!trace_begin(&l, tag))
        return;
    kv(&l, "gs", (u64)gs, 1);
    if (!recs || num <= 0) {
        kv_s(&l, "records", num);
        trace_end(&l);
        return;
    }
    for (i = 0; i < num && i < 64; i++) {
        u8 *r = recs + (u64)i * REC_SIZE;
        if (F(r, REC_ALIVE, u8)) alive++; else dead++;
        kills += F(r, REC_VICTIMS + 8, i32) + F(r, REC_BOT_VICTIMS, i32);
    }
    kv(&l, "records", (u64)num, 0);
    kv(&l, "alive", (u64)alive, 0);
    kv(&l, "dead", (u64)dead, 0);
    kv_s(&l, "kills_total", kills);
    for (i = 0; i < num && i < 64; i++) {
        u8 *r = recs + (u64)i * REC_SIZE;
        u8 *ps = F(r, REC_PS, u8 *);
        u16 *kn = F(r, REC_KILLER_NAME, u16 *);
        i32 a = ps == ps_a;
        if (!ps || (ps != ps_a && ps != ps_b))
            continue;
        kv_s(&l, a ? "a_victims" : "b_victims", F(r, REC_VICTIMS + 8, i32));
        kv_s(&l, a ? "a_bots" : "b_bots", F(r, REC_BOT_VICTIMS, i32));
        kv_s(&l, a ? "a_killers" : "b_killers", F(r, REC_KILLERS + 8, i32));
        kv_s(&l, a ? "a_alive" : "b_alive", F(r, REC_ALIVE, u8));
        kv_s(&l, a ? "a_order" : "b_order", F(r, REC_DEATH_ORDER, i32));
        kv_s(&l, a ? "a_kp" : "b_kp", F(r, REC_KILL_POINTS, i32));
        kv_s(&l, a ? "a_kname_len" : "b_kname_len", F(r, REC_KILLER_NAME + 8, i32));
        kv(&l, a ? "a_kname_c0" : "b_kname_c0", kn && F(r, REC_KILLER_NAME + 8, i32) > 0 ? kn[0] : 0, 0);
    }
    trace_end(&l);
    if (!trace_begin(&l, "records-changed"))
        return;
    for (i = 0; i < num && i < 64; i++) {
        u8 *r = recs + (u64)i * REC_SIZE;
        u8 *ps = F(r, REC_PS, u8 *);
        if (ps == ps_a || ps == ps_b) {
            kv(&l, ps == ps_a ? "a_at" : "b_at", (u64)i, 0);
            kv_s(&l, "id_len", F(r, 0x08, i32));    /* record +0: the player's id (FString) */
            kv(&l, "id_c0", F(r, 0x08, i32) > 0 && F(r, 0, u16 *) ? F(r, 0, u16 *)[0] : 0, 0);
        }
        if (F(r, REC_ALIVE, u8) && !F(r, REC_VICTIMS + 8, i32) && !F(r, REC_BOT_VICTIMS, i32))
            continue;
        kv(&l, "rec", (u64)i, 0);
        kv_s(&l, "alive", F(r, REC_ALIVE, u8));
        kv_s(&l, "v", F(r, REC_VICTIMS + 8, i32) + F(r, REC_BOT_VICTIMS, i32));
        kv_s(&l, "order", F(r, REC_DEATH_ORDER, i32));
    }
    trace_end(&l);
}

/* The scoreboard's own copy: AVictoryGameState::ScoreboardData (+0x498, a
 * replicated TArray of 0xb0-byte FPlayerScoreboardData; its property list,
 * VA 0x1404c3d00 on: PlayerId +0x10, PlayerTeam +0x20, Kills +0x24, bIsAlive
 * +0x28, KilledBy +0x30, DeathOrder +0x64). BuildSortedScoreboard (VA
 * 0x140243c80) walks it with that stride. Entries named NetHost/NetPlayerOne/
 * NetPlayerTwo (netplay_run.py --distinct-ids) are traced one by one. */
#define O_GS_SCOREBOARD    0x498
#define SB_SIZE            0xb0
#define SB_NAME            0x00        /* FString */
#define SB_KILLS           0x24
#define SB_ALIVE           0x28
#define SB_KILLED_BY       0x30        /* FString */
#define SB_DEATH_ORDER     0x64

static u16 str_at(u8 *fstr, i32 i)
{
    u16 *d = F(fstr, 0, u16 *);
    return d && i < F(fstr, 8, i32) ? d[i] : 0;
}

static void trace_scoreboard(u8 *world, const char *tag)
{
    u8 *gs = world ? F(world, O_W_GAMESTATE, u8 *) : 0;
    u8 *sb = gs ? F(gs, O_GS_SCOREBOARD, u8 *) : 0;
    i32 i, num = gs ? F(gs, O_GS_SCOREBOARD + 8, i32) : 0, alive = 0, kills = 0;
    struct line l;
    if (!trace_begin(&l, tag))
        return;
    for (i = 0; sb && i < num && i < 64; i++) {
        u8 *e = sb + (u64)i * SB_SIZE;
        alive += F(e, SB_ALIVE, u8) != 0;
        kills += F(e, SB_KILLS, i32);
    }
    kv_s(&l, "entries", num);
    kv_s(&l, "alive", alive);
    kv_s(&l, "kills_total", kills);
    for (i = 0; sb && i < num && i < 64; i++) {
        u8 *e = sb + (u64)i * SB_SIZE;
        char k[3];
        if (str_at(e + SB_NAME, 0) != 'N' || str_at(e + SB_NAME, 1) != 'e' || str_at(e + SB_NAME, 2) != 't')
            continue;
        /* H(ost), O(ne), T(wo): the name's 4th letter, or the 10th for players */
        k[0] = (char)(str_at(e + SB_NAME, 3) == 'H' ? 'H' : str_at(e + SB_NAME, 9));
        k[1] = '_';
        k[2] = 0;
        kv(&l, "who", (u64)(u8)k[0], 0);
        kv_s(&l, "kills", F(e, SB_KILLS, i32));
        kv_s(&l, "alive", F(e, SB_ALIVE, u8));
        kv_s(&l, "order", F(e, SB_DEATH_ORDER, i32));
        kv(&l, "killed_by", (u64)(str_at(e + SB_KILLED_BY, 3) == 'H' ? 'H' : str_at(e + SB_KILLED_BY, 9)), 0);
    }
    if (sb && num > 0)
        kv(&l, "first_name_c0", str_at(sb + SB_NAME, 0), 0);
    trace_end(&l);
}

/* CULLING_NETPLAY_END=1 (with the attack test): 5 s after the second
 * joined player dies, the host eliminates every other character but the
 * first joined player's (bots and the host's own player; ApplyDamage
 * 10000), then stops holding its match open (the no-end flag), so the
 * game's own free-for-all check ends it with that player the last one alive.
 * Every game traces the match state (AGameState::MatchState, +0x440) and
 * the winner. */
#define O_GS_MATCH_STATE   0x440       /* AGameState::MatchState (FName) */
#define O_GM_MATCH_STATE   0x4a0       /* AGameMode::MatchState (FName); its bitfield bools follow */
#define O_GM_NUM_PLAYERS   0x4b0       /* AGameMode::NumPlayers, then NumBots */
#define O_GM_WARMUP        0x598       /* AShooterGameMode::WarmupTime */
#define O_GM_NO_END        0x74d       /* AShooterGame_FreeForAll: while set, its end-of-match check never ends the match (showdown_rounds.c GM_NO_END) */
#define O_GS_REMAINING     0x4e0       /* AShooterGameState::RemainingTime */
#define O_GS_ELAPSED       0x4e8       /* seconds InProgress (showdown_rounds.c GS_ELAPSED) */
#define REC_FLAGS          0x28        /* bIsAlive, then the record's other bools (bIsWinner among them) */
static const u16 end_var[] = { 'C','U','L','L','I','N','G','_','N','E','T','P','L','A','Y','_','E','N','D',0 };
static const u16 ms_waiting[] = { 'W','a','i','t','i','n','g','T','o','S','t','a','r','t',0 };
static const u16 ms_progress[] = { 'I','n','P','r','o','g','r','e','s','s',0 };
static const u16 ms_post[] = { 'W','a','i','t','i','n','g','P','o','s','t','M','a','t','c','h',0 };
static const u16 ms_leaving[] = { 'L','e','a','v','i','n','g','M','a','p',0 };
static i32 end_state = 1, end_phase;  /* 0 holding, 1 waiting, 2 released */
static u32 end_at;
static u64 state_names[4];

/* 1 WaitingToStart, 2 InProgress, 3 WaitingPostMatch, 4 LeavingMap, 0 other, -1 no game state */
static i32 state_code(u32 name)
{
    i32 i;
    for (i = 0; i < 4; i++) {
        if (!state_names[i])
            FN(R_FNAME, fname_fn)(&state_names[i], i == 0 ? ms_waiting : i == 1 ? ms_progress : i == 2 ? ms_post : ms_leaving, 1);
        if ((u32)state_names[i] == name)
            return i + 1;
    }
    return 0;
}

static i32 match_state(u8 *world)
{
    u8 *gs = world ? F(world, O_W_GAMESTATE, u8 *) : 0;
    i32 i;
    if (!gs)
        return -1;
    for (i = 0; i < 4; i++) {
        if (!state_names[i])
            FN(R_FNAME, fname_fn)(&state_names[i], i == 0 ? ms_waiting : i == 1 ? ms_progress : i == 2 ? ms_post : ms_leaving, 1);
        if ((u32)state_names[i] == F(gs, O_GS_MATCH_STATE, u32))
            return i + 1;
    }
    return 0;
}

static u8 *record_of(u8 *world, u8 *ps)
{
    u8 *gs = world ? F(world, O_W_GAMESTATE, u8 *) : 0;
    u8 *recs = gs ? F(gs, O_GS_RECORDS, u8 *) : 0;
    i32 i, num = gs ? F(gs, O_GS_RECORDS + 8, i32) : 0;
    for (i = 0; ps && recs && i < num; i++)
        if (F(recs + (u64)i * REC_SIZE, REC_PS, u8 *) == ps)
            return recs + (u64)i * REC_SIZE;
    return 0;
}

static void host_end(u8 *world, u8 **conns, i32 nconn, u32 now)
{
    u8 *pc0 = nconn > 0 && conns[0] ? F(conns[0], O_CONN_PC, u8 *) : 0;
    u8 *pc1 = nconn > 1 && conns[1] ? F(conns[1], O_CONN_PC, u8 *) : 0;
    u8 *r0 = pc0 ? record_of(world, F(pc0, O_C_PLAYERSTATE, u8 *)) : 0;
    u8 *r1 = pc1 ? record_of(world, F(pc1, O_C_PLAYERSTATE, u8 *)) : 0;
    u8 *keep = pc0 ? F(pc0, O_C_PAWN, u8 *) : 0, *data;
    struct line l;
    i32 i, num, killed = 0;
    if (!tp2_done || !env_on(end_var, &end_state))
        return;
    if (end_phase == 0 && r1 && !F(r1, REC_ALIVE, u8)) {
        end_phase = 1;
        end_at = now + 5000;
    }
    if (end_phase == 1 && (i32)(now - end_at) >= 0 && keep) {
        data = F(world + O_W_PAWNS, 0, u8 *);
        num = F(world + O_W_PAWNS, 8, i32);
        for (i = 0; data && i < num; i++) {
            u8 *p = (u8 *)FN(R_WEAK_GET, weak_get_fn)(data + (u64)i * 8);
            if (p && p != keep && health_of(p) > 0) {
                FN(R_APPLY_DAMAGE, apply_damage_fn)(p, 10000.0f, 0, 0, 0);
                killed++;
            }
        }
        end_phase = 2;
        if (trace_begin(&l, "end-release")) {
            kv(&l, "eliminated", (u64)killed, 0);
            trace_end(&l);
        }
    }
    if (trace_begin(&l, "end")) {
        kv_s(&l, "phase", end_phase);
        kv_s(&l, "match_state", match_state(world));
        kv(&l, "p0_flags", r0 ? (u64)F(r0, REC_FLAGS, u32) : 0, 1);
        kv(&l, "p1_flags", r1 ? (u64)F(r1, REC_FLAGS, u32) : 0, 1);
        kv_s(&l, "p0_order", r0 ? F(r0, REC_DEATH_ORDER, i32) : -2);
        kv_s(&l, "p1_order", r1 ? F(r1, REC_DEATH_ORDER, i32) : -2);
        trace_end(&l);
    }
}


/* The match result for the agent (CULLING_NETPLAY_CONTROL), written once
 * when the match reaches WaitingPostMatch: per joined player (by the verify
 * request it passed with) its record's death order and placement, kills,
 * damage and time alive. Placement = records + 1 - death order (the winner's
 * order is the record count, the first to die 1). The player state is kept
 * from the first tick after the join, so a player who left still counts. */
#define REC_WINNER         0x29        /* bIsWinner (DetermineMatchWinner sets it; byte after bIsAlive) */
static i32 result_done;
#define SB_PLAYER_ID       0x10        /* FString */
#define SB_DAMAGE          0x68        /* DamageDealt (int32: 100 after taking a player from 100 to 0, in game) */

static u8 *scoreboard_entry(u8 *world, u8 *rec)
{
    u8 *gs = F(world, O_W_GAMESTATE, u8 *);
    u8 *sb = gs ? F(gs, O_GS_SCOREBOARD, u8 *) : 0;
    i32 i, k, num = gs ? F(gs, O_GS_SCOREBOARD + 8, i32) : 0, len = F(rec, 8, i32);
    u16 *id = F(rec, 0, u16 *);
    for (i = 0; sb && id && len > 1 && i < num; i++) {
        u8 *e = sb + (u64)i * SB_SIZE;
        u16 *eid = F(e, SB_PLAYER_ID, u16 *);
        if (!eid || F(e, SB_PLAYER_ID + 8, i32) != len)
            continue;
        for (k = 0; k < len && eid[k] == id[k]; k++)
            ;
        if (k == len)
            return e;
    }
    return 0;
}

static void ctl_track_joins(u8 *driver, u8 *world)
{
    struct join_table *t = join_table();
    u8 **conns = F(driver, O_ND_CLIENTS, u8 **);
    i32 nconn = F(driver, O_ND_CLIENTS + 8, i32), i, c;
    u32 now = (*(gettickcount_fn *)(image_base() + IAT_GETTICKCOUNT))();
    /* Time alive is measured here: the record's own MinutesAlive (+0x44) is
     * still 0 at the end of the match (in game). Damage comes from the
     * scoreboard entry, whose DamageDealt is kept up during the match. */
    if (!t->start && match_state(world) == 2)
        t->start = now;
    for (i = 0; i < t->n; i++) {
        u8 *r = t->ps[i] ? record_of(world, (u8 *)t->ps[i]) : 0;
        if (t->start && !t->died[i] && r && !F(r, REC_ALIVE, u8))
            t->died[i] = now;
    }
    for (i = 0; i < t->n; i++) {
        if (t->ps[i])
            continue;
        for (c = 0; conns && c < nconn; c++)
            if (conns[c] == t->conn[i]) {
                u8 *pc = F(conns[c], O_CONN_PC, u8 *);
                t->ps[i] = pc ? F(pc, O_C_PLAYERSTATE, u8 *) : 0;
            }
    }
}

static void ctl_result(u8 *driver, u8 *world)
{
    struct join_table *t;
    u8 *gs, *r;
    char buf[3200], *q;
    i32 i, num, order, placement;
    struct line l;
    if (!ctl_on())
        return;
    ctl_track_joins(driver, world);
    if (result_done || match_state(world) != 3)
        return;
    result_done = 1;
    t = join_table();
    gs = F(world, O_W_GAMESTATE, u8 *);
    num = gs ? F(gs, O_GS_RECORDS + 8, i32) : 0;
    q = put_str(buf, "field=");
    q = put_dec(q, num);
    q = put_str(q, "\nelapsed=");
    q = put_dec(q, gs ? F(gs, O_GS_ELAPSED, i32) : 0);
    q = put_str(q, "\n");
    for (i = 0; i < t->n && q - buf < (i32)sizeof(buf) - 200; i++) {
        r = t->ps[i] ? record_of(world, (u8 *)t->ps[i]) : 0;
        q = put_str(q, "player n=");
        q = put_dec(q, t->seq[i]);
        if (!r) {
            q = put_str(q, " record=0\n");
            continue;
        }
        order = F(r, REC_DEATH_ORDER, i32);
        placement = order <= 0 || order > num ? 1 : num + 1 - order;
        q = put_str(q, " placement=");
        q = put_dec(q, placement);
        q = put_str(q, " order=");
        q = put_dec(q, order);
        q = put_str(q, " kills=");
        q = put_dec(q, F(r, REC_VICTIMS + 8, i32) + F(r, REC_BOT_VICTIMS, i32));
        {
            u8 *sb = scoreboard_entry(world, r);
            u32 end = t->died[i] ? t->died[i] : (*(gettickcount_fn *)(image_base() + IAT_GETTICKCOUNT))();
            q = put_str(q, " damage=");
            q = put_dec(q, sb ? F(sb, SB_DAMAGE, i32) : 0);
            q = put_str(q, " alive_s=");
            q = put_dec(q, t->start ? (i32)((end - t->start) / 1000) : 0);
        }
        q = put_str(q, " winner=");
        q = put_dec(q, F(r, REC_WINNER, u8));
        q = put_str(q, " alive=");
        q = put_dec(q, F(r, REC_ALIVE, u8));
        q = put_str(q, "\n");
    }
    ctl_write("result.txt", buf, (u32)(q - buf));
    ctl_write("result.done", "1", 1);
    if (trace_begin(&l, "result-written")) {
        kv(&l, "players", (u64)t->n, 0);
        kv(&l, "bytes", (u64)(q - buf), 0);
        trace_end(&l);
    }
}

static u32 watch_next;

static void host_watch(u8 *world, u8 **conns, i32 nconn, u32 now)
{
    struct line l;
    i32 c;
    if (!tp2_done || !env_on(attack_var, &host_attack_state) || (i32)(now - watch_next) < 0)
        return;
    watch_next = now + 1000;
    if (!trace_begin(&l, "watch"))
        return;
    for (c = 0; c < nconn && c < 2; c++) {
        u8 *pc = conns[c] ? F(conns[c], O_CONN_PC, u8 *) : 0;
        u8 *p = pc ? F(pc, O_C_PAWN, u8 *) : 0;
        u8 *root = p ? F(p, O_A_ROOT, u8 *) : 0;
        kv_s(&l, c ? "p1_health" : "p0_health", health_of(p));
        kv_s(&l, c ? "p1_x" : "p0_x", root ? (i32)F(root, O_SC_LOCATION, float) : 0);
        kv_s(&l, c ? "p1_yaw" : "p0_yaw", pc ? (i32)F(pc, O_PC_CONTROL_ROT + 4, float) : 0);
        kv(&l, c ? "p1_ps_match" : "p0_ps_match", p && pc && F(p, O_PAWN_PLAYERSTATE, u8 *) == F(pc, O_C_PLAYERSTATE, u8 *), 0);
    }
    trace_end(&l);
    if (((now / 1000) & 1) == 0) {
        u8 *pc0 = nconn > 0 && conns[0] ? F(conns[0], O_CONN_PC, u8 *) : 0;
        u8 *pc1 = nconn > 1 && conns[1] ? F(conns[1], O_CONN_PC, u8 *) : 0;
        trace_records(world, "records", pc0 ? F(pc0, O_C_PLAYERSTATE, u8 *) : 0, pc1 ? F(pc1, O_C_PLAYERSTATE, u8 *) : 0);
        trace_scoreboard(world, "scoreboard");
    }
    host_end(world, conns, nconn, now);
}

static void host_teleport(u8 *remote, u32 now)
{
    static const u16 var[] = { 'C','U','L','L','I','N','G','_','N','E','T','P','L','A','Y','_','T','E','L','E','P','O','R','T',0 };
    float to[3], rot[3];
    struct line l;
    u8 ok;
    if (tp_state == 1) {
        u16 v[8];
        u32 n = (*(getenvw_fn *)(image_base() + IAT_GETENVW))(var, v, 8);
        tp_state = n == 1 && v[0] == '1' ? 2 : n == 1 && v[0] == '2' ? 4 : 3;
    }
    if (teleported || !remote || tp_state != 2)
        return;
    if (!tp_at) { tp_at = now + 20000; return; }
    if ((i32)(now - tp_at) < 0)
        return;
    {
        u8 *root = F(remote, O_A_ROOT, u8 *);
        float x = root ? F(root, O_SC_LOCATION, float) : 0.0f;
        /* the pod start on the far side of the island from where it is */
        if (x < 0.0f) { to[0] = 49842.0f; to[1] = -7813.0f; to[2] = 7450.0f; }   /* SpawnsDecentral-teamB */
        else          { to[0] = -37264.0f; to[1] = 7237.0f; to[2] = 300.0f; }    /* SpawnsDecentral-teaml */
    }
    rot[0] = rot[1] = rot[2] = 0.0f;
    ok = FN(R_TELEPORT, teleport_fn)(remote, to, rot);
    teleported = 1;
    if (trace_begin(&l, "teleport")) {
        kv(&l, "ok", ok, 0);
        trace_end(&l);
    }
}

static void server_replicate(u8 *driver)
{
    u8 *actors[MAX_REP];
    u8 kind[MAX_REP];
    u8 *world = F(driver, O_ND_WORLD, u8 *);
    u8 **conns = F(driver, O_ND_CLIENTS, u8 **);
    i32 nconn = F(driver, O_ND_CLIENTS + 8, i32), n, i, c, live = 0;
    struct rep_stats st = { 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0 };
    struct line l;
    u32 now = (*(gettickcount_fn *)(image_base() + IAT_GETTICKCOUNT))();
    if (now - last_alive >= 2000 && trace_begin(&l, "host-alive")) {
        last_alive = now;
        kv(&l, "clients", (u64)(nconn > 0 ? nconn : 0), 0);
        kv(&l, "state0", nconn > 0 && conns && conns[0] ? (u64)F(conns[0], O_CONN_STATE, i32) : 0, 0);
        kv(&l, "world", (u64)world, 1);
        {
            u8 *gm = world ? F(world, O_WORLD_AUTH_GM, u8 *) : 0;
            u8 *gs = world ? F(world, O_W_GAMESTATE, u8 *) : 0;
            if (gm) {
                kv_s(&l, "gm_state", state_code(F(gm, O_GM_MATCH_STATE, u32)));
                kv(&l, "gm_flags", (u64)F(gm, O_GM_MATCH_STATE + 8, u32), 1);
                kv_s(&l, "players", F(gm, O_GM_NUM_PLAYERS, i32));
                kv_s(&l, "bots", F(gm, O_GM_NUM_PLAYERS + 4, i32));
                kv_s(&l, "warmup", F(gm, O_GM_WARMUP, i32));
                kv_s(&l, "no_end", F(gm, O_GM_NO_END, u8));
            }
            if (gs) {
                kv_s(&l, "gs_state", match_state(world));
                kv_s(&l, "remaining", F(gs, O_GS_REMAINING, i32));
                kv_s(&l, "elapsed", F(gs, O_GS_ELAPSED, i32));
            }
        }
        trace_end(&l);
    }
    if (!world || nconn <= 0 || now - last_rep < REP_PERIOD_MS)
        return;
    last_rep = now;
    {
        i32 c0;
        for (c0 = 0; c0 < nconn; c0++) {
            u8 *pc0 = conns[c0] ? F(conns[c0], O_CONN_PC, u8 *) : 0;
            if (pc0 && F(pc0, O_C_PAWN, u8 *)) {
                host_give(world, F(pc0, O_C_PAWN, u8 *), now);
                host_teleport(F(pc0, O_C_PAWN, u8 *), now);
                break;
            }
        }
        host_teleport_pair(conns, nconn, now);
        host_damage(conns, nconn, now);
        host_watch(world, conns, nconn, now);
    }
    {
        u8 *gm1 = F(world, O_WORLD_AUTH_GM, u8 *);
        i32 c1;
        for (c1 = 0; c1 < nconn && (!pawn_kind || !controller_kind); c1++) {
            u8 *pc1 = conns[c1] ? F(conns[c1], O_CONN_PC, u8 *) : 0;
            if (pc1 && !controller_kind)
                controller_kind = depth2(pc1);
            if (pc1 && F(pc1, O_C_PAWN, u8 *) && !pawn_kind)
                pawn_kind = depth2(F(pc1, O_C_PAWN, u8 *));
        }
        if (pawn_kind && controller_kind)
            scan_world(world, gm1, gm1 ? F(gm1, O_GM_GAMESTATE, u8 *) : 0, now);
    }
    n = collect(world, actors, kind);
    /* A new replication frame, as the engine's ServerReplicateActors starts
     * with ReplicationFrame++: property comparisons are shared between
     * connections per frame, so without it the first pass's comparison was
     * reused (in game: a player's pawn reached the other client once, then
     * its ReplicatedMovement there never changed). */
    F(driver, O_ND_REP_FRAME, i32)++;
    if (prerep_on()) {
        for (i = 0; i < n; i++)
            FN(R_PRE_REPLICATION, pre_rep_fn)(actors[i], driver);
        for (i = 0; world_list && i < world_num; i++) {
            u8 *a = (u8 *)FN(R_WEAK_GET, weak_get_fn)(world_list + i);
            if (a)
                FN(R_PRE_REPLICATION, pre_rep_fn)(a, driver);
        }
    }
    for (c = 0; c < nconn; c++) {
        u8 *conn = conns[c];
        void *pc = conn ? F(conn, O_CONN_PC, void *) : 0;
        conn_ready_fn ready;
        if (!conn || !pc || F(conn, O_CONN_STATE, i32) != 3)
            continue;
        live++;
        if (!st.remote_pawn) {
            st.remote_pawn = F(pc, O_C_PAWN, u8 *);
            st.remote_conn = conn;
        }
        ready = (conn_ready_fn)(*(void ***)conn)[VT_CONN_NET_READY / 8];
        st.opened_now = 0;
        /* The host's movement corrections, as the engine's
         * ServerReplicateActors starts each connection with
         * APlayerController::SendClientAdjustment: when the client has
         * acknowledged its pawn and the pawn is its autonomous proxy, the
         * movement component sends ClientAckGoodMove / ClientAdjustPosition.
         * Without it the host could never overrule a client's position (in
         * game: a teleport on the host was undone by the client's moves). */
        {
            u8 *pawn = F((u8 *)pc, O_C_PAWN, u8 *);
            u8 *cmc = pawn ? F(pawn, O_CH_MOVEMENT, u8 *) : 0;
            if (pawn && cmc && F((u8 *)pc, O_PC_ACK_PAWN, u8 *) == pawn && F(pawn, O_A_REMOTE_ROLE, u8) == ROLE_AUTONOMOUS) {
                FN(R_SEND_CLIENT_ADJ, send_adj_fn)(cmc + O_CMC_PREDICTION);
                st.adjusted++;
            }
        }
        if (!ready(conn, 0)) { st.saturated++; continue; }   /* as the engine does: wait for room */
        replicate_to(conn, (u8 *)pc, pc, &st);               /* its own PlayerController first */
        {
            i32 items_ok = 1;
            for (i = 0; i < n; i++) {
                if (!ready(conn, 0)) { st.saturated++; break; }
                if (actors[i] == pc)
                    continue;
                if (kind[i] == 2 && !items_ok) {             /* a weapon of it is still waiting: next pass */
                    st.deferred++;
                    items_ok = 1;
                    continue;
                }
                if (!replicate_to(conn, actors[i], pc, &st) && kind[i] == 1)
                    items_ok = 0;
                if (kind[i] == 2)
                    items_ok = 1;
            }
            /* Then the world's other replicated actors (loot, crates, doors,
             * pylons, airdrops ...) from the last scan, straight from its
             * weak list. Some are also in the list above; ReplicateActor
             * sends only changes, so a second call costs little. */
            /* Distance limits: the engine's own relevancy test for each,
             * from the player's view point, as the game's code does
             * (0x140209e10). A channel to an object that isn't relevant is
             * closed once it is beyond 1.25x its cull distance, so objects
             * at the edge don't open and close every pass. */
            {
                void *vt_actor = ((pc_view_target_fn)(*(void ***)pc)[VT_PC_VIEW_TARGET / 8])(pc);
                float view[3];
                u8 *vroot = vt_actor ? F((u8 *)vt_actor, O_A_ROOT, u8 *) : 0;
                /* The view target's location, as the engine's FNetViewer
                 * starts from. GetPlayerViewPoint on the host gave a fixed
                 * point for the remote player (its camera isn't updated
                 * there): in game, teleporting it across the island changed
                 * nothing. */
                if (!vroot) {
                    u8 *pawn = F((u8 *)pc, O_C_PAWN, u8 *);
                    vroot = pawn ? F(pawn, O_A_ROOT, u8 *) : 0;
                }
                if (!vroot)
                    continue;
                view[0] = F(vroot, O_SC_LOCATION, float);
                view[1] = F(vroot, O_SC_LOCATION + 4, float);
                view[2] = F(vroot, O_SC_LOCATION + 8, float);
                for (i = 0; world_list && i < world_num; i++) {
                    u8 *a, *root, *ch;
                    if (!ready(conn, 0)) { st.saturated++; break; }
                    a = (u8 *)FN(R_WEAK_GET, weak_get_fn)(world_list + i);
                    if (!a || a == pc)
                        continue;
                    if (((net_relevant_fn)(*(void ***)a)[VT_A_NET_RELEVANT / 8])(a, pc, vt_actor, view)) {
                        st.relevant++;
                        replicate_to(conn, a, pc, &st);
                        continue;
                    }
                    st.culled++;
                    ch = (u8 *)find_channel(conn, a);
                    root = F(a, O_A_ROOT, u8 *);
                    if (ch && root && !(F(ch, O_CH_FLAGS, u8) & 2)) {
                        float dx = F(root, O_SC_LOCATION, float) - view[0];
                        float dy = F(root, O_SC_LOCATION + 4, float) - view[1];
                        float dz = F(root, O_SC_LOCATION + 8, float) - view[2];
                        if (dx * dx + dy * dy + dz * dz > 1.5625f * F(a, O_A_CULL_DIST_SQ, float)) {
                            ((ch_close_fn)(*(void ***)ch)[VT_CH_CLOSE / 8])(ch);
                            st.closed++;
                        }
                    }
                }
            }
        }
    }
    st.actors = (u64)n;
    if (now - last_trace >= 2000 && trace_begin(&l, "rep")) {
        last_trace = now;
        kv(&l, "conns", (u64)live, 0);
        kv(&l, "actors", st.actors, 0);
        kv(&l, "opened", st.opened, 0);
        kv(&l, "replicated", st.replicated, 0);
        kv(&l, "skipped", st.skipped, 0);
        kv(&l, "deferred", st.deferred, 0);
        kv(&l, "saturated", st.saturated, 0);
        kv(&l, "world", (u64)world_num, 0);
        kv(&l, "relevant", st.relevant, 0);
        kv(&l, "culled", st.culled, 0);
        kv(&l, "closed", st.closed, 0);
        kv(&l, "adjusted", st.adjusted, 0);
        kv(&l, "rep_frame", (u64)F(driver, O_ND_REP_FRAME, u32), 0);
        /* Two players: does each connection have a channel to the other's pawn? */
        if (nconn >= 2 && conns[0] && conns[1]) {
            u8 *pc0 = F(conns[0], O_CONN_PC, u8 *), *pc1 = F(conns[1], O_CONN_PC, u8 *);
            u8 *p0 = pc0 ? F(pc0, O_C_PAWN, u8 *) : 0, *p1 = pc1 ? F(pc1, O_C_PAWN, u8 *) : 0;
            kv(&l, "c0_has_p1", p1 ? (u64)(find_channel(conns[0], p1) != 0) : 9, 0);
            kv(&l, "c1_has_p0", p0 ? (u64)(find_channel(conns[1], p0) != 0) : 9, 0);
            kv(&l, "p1_role", p1 ? (u64)F(p1, O_A_REMOTE_ROLE, u8) : 9, 0);
            kv(&l, "p1_flags", p1 ? (u64)F(p1, O_A_FLAGS, u8) : 0, 1);
            /* attachment and the replicated location (FRepMovement at +0xa0, Location at +0x18) */
            if (p0 && F(p0, O_A_ROOT, u8 *)) {
                kv(&l, "p0_attached", (u64)(F(F(p0, O_A_ROOT, u8 *), 0xf0, u8 *) != 0), 0);
                kv_s(&l, "p0_repx", (i32)F(p0, 0xa0 + 0x18, float));
                kv_s(&l, "p0_repy", (i32)F(p0, 0xa0 + 0x1c, float));
            }
            if (p1 && F(p1, O_A_ROOT, u8 *)) {
                kv(&l, "p1_attached", (u64)(F(F(p1, O_A_ROOT, u8 *), 0xf0, u8 *) != 0), 0);
                kv_s(&l, "p1_repx", (i32)F(p1, 0xa0 + 0x18, float));
                kv_s(&l, "p1_repy", (i32)F(p1, 0xa0 + 0x1c, float));
            }
        }
        kv_s(&l, "loot", count_pickups(F(world, O_WORLD_AUTH_GM, u8 *)));
        if (st.remote_pawn && F(st.remote_pawn, O_A_ROOT, u8 *)) {
            u8 *root = F(st.remote_pawn, O_A_ROOT, u8 *);
            kv(&l, "remote_pawn", (u64)st.remote_pawn, 1);
            kv(&l, "remote_inv", is_character(st.remote_pawn) ? (u64)F(st.remote_pawn, O_CH_INVENTORY + 8, i32) : 0, 0);
            kv_s(&l, "x", (i32)F(root, O_SC_LOCATION, float));
            kv_s(&l, "y", (i32)F(root, O_SC_LOCATION + 4, float));
            kv_s(&l, "z", (i32)F(root, O_SC_LOCATION + 8, float));
        }
        trace_end(&l);
    }
}

/* A client: every 2 s, what replication has given it. */
static void client_trace(u8 *driver)
{
    struct line l;
    u8 *conn = F(driver, O_ND_SERVERCONN, u8 *);
    u8 *world = F(driver, O_ND_WORLD, u8 *);
    u32 now = (*(gettickcount_fn *)(image_base() + IAT_GETTICKCOUNT))();
    u8 *pc, *mine, *data;
    i32 i, num;
    if (!conn || !world || now - last_trace < 2000 || !trace_begin(&l, "client"))
        return;
    last_trace = now;
    pc = F(conn, O_CONN_PC, u8 *);
    mine = pc ? F(pc, O_C_PAWN, u8 *) : 0;
    kv(&l, "state", (u64)F(conn, O_CONN_STATE, i32), 0);
    kv(&l, "channels", (u64)(F(conn + O_CONN_CHMAP, 0x08, i32) - F(conn + O_CONN_CHMAP, 0x34, i32)), 0);
    kv(&l, "pc", (u64)pc, 1);
    kv(&l, "pawn", (u64)mine, 1);
    kv_s(&l, "match_state", match_state(world));
    kv_s(&l, "loot", pc ? count_pickups(pc) : -1);
    if (mine) {
        u8 **items = is_character(mine) ? F(mine, O_CH_INVENTORY, u8 **) : 0;
        i32 k, ni = items ? F(mine, O_CH_INVENTORY + 8, i32) : 0;
        kv(&l, "inv", (u64)(ni < 0 ? 0 : ni), 0);
        for (k = 0; items && k < ni && k < 6; k++)
            kv(&l, "item_class", items[k] ? (u64)F(items[k], O_OBJ_CLASS, u8 *) : 0, 1);
        kv(&l, "current", is_character(mine) ? (u64)F(mine, O_CH_CURRENT, u8 *) : 0, 1);
    }
    trace_end(&l);
    trace_scoreboard(world, "client-scoreboard");
    data = F(world + O_W_PAWNS, 0, u8 *);
    num = F(world + O_W_PAWNS, 8, i32);
    for (i = 0; data && i < num && i < 24; i++) {
        u8 *p = (u8 *)FN(R_WEAK_GET, weak_get_fn)(data + (u64)i * 8);
        u8 *root = p ? F(p, O_A_ROOT, u8 *) : 0;
        if (!root || !trace_begin(&l, "client-pawn"))
            continue;
        kv(&l, "pawn", (u64)p, 1);
        kv(&l, "mine", p == mine, 0);
        kv(&l, "holding", is_character(p) && F(p, O_CH_CURRENT, u8 *) != 0, 0);
        kv_s(&l, "x", (i32)F(root, O_SC_LOCATION, float));
        kv_s(&l, "y", (i32)F(root, O_SC_LOCATION + 4, float));
        kv_s(&l, "z", (i32)F(root, O_SC_LOCATION + 8, float));
        kv(&l, "role", (u64)F(p, 0x118, u8), 0);            /* AActor::Role here (1 simulated, 2 autonomous) */
        kv_s(&l, "health", health_of(p));
        kv_s(&l, "repx", (i32)F(p, 0xa0 + 0x18, float));     /* the last ReplicatedMovement.Location received */
        kv_s(&l, "repy", (i32)F(p, 0xa0 + 0x1c, float));
        trace_end(&l);
    }
}

/* A client with CULLING_NETPLAY_MOVE=1 walks its own pawn: AddMovementInput
 * (APawn vtable +0x6b0, as the autotest mode drives it), +X for 3 s then -X
 * for 3 s, every frame. The client's movement component sends that to the
 * host as its ServerMove updates; the host's trace shows whether it moved
 * the client's pawn there. */
#define VT_ADD_MOVEMENT    0x6b0
typedef void (*add_move_fn)(void *pawn, const float *dir, float scale, u8 force);

static void client_move(u8 *driver)
{
    static const u16 var[] = { 'C','U','L','L','I','N','G','_','N','E','T','P','L','A','Y','_','M','O','V','E',0 };
    u8 *conn = F(driver, O_ND_SERVERCONN, u8 *);
    u8 *pc = conn ? F(conn, O_CONN_PC, u8 *) : 0;
    u8 *pawn = pc ? F(pc, O_C_PAWN, u8 *) : 0;
    float dir[3];
    u32 now;
    if (!pawn || !env_on(var, &move_state))
        return;
    now = (*(gettickcount_fn *)(image_base() + IAT_GETTICKCOUNT))();
    dir[0] = (now / 3000) & 1 ? -1.0f : 1.0f;
    dir[1] = 0.0f;
    dir[2] = 0.0f;
    ((add_move_fn)(*(void ***)pawn)[VT_ADD_MOVEMENT / 8])(pawn, dir, 1.0f, 1);
}

/* CULLING_NETPLAY_ATTACK=1 on a client: once another character stands
 * within 400 units, every 2 s the client turns to face it (its
 * PlayerController's ControlRotation, which the movement updates carry to
 * the host) and presses primary attack for 300 ms through the functions the
 * attack button drives: AShooterCharacter::OnStartPrimary and OnStopPrimary
 * (the natives "OnStartPrimary" 0x140368700 and "OnStopPrimary" 0x140368a80
 * call them). They run the weapon locally and send ServerStartInput and
 * ServerStopInput; the client's weapon finds the hits and sends
 * ServerNotifyHit, and the host applies the damage. */
#define R_ON_START_PRIMARY 0x272f60
#define R_ON_STOP_PRIMARY  0x2743d0
typedef void (*pawn_input_fn)(void *pawn);
static u32 attack_next, release_at, attacks;
static u8 *pressed_pawn;

static void client_attack(u8 *driver)
{
    u8 *conn = F(driver, O_ND_SERVERCONN, u8 *);
    u8 *world = F(driver, O_ND_WORLD, u8 *);
    u8 *pc = conn ? F(conn, O_CONN_PC, u8 *) : 0;
    u8 *pawn = pc ? F(pc, O_C_PAWN, u8 *) : 0;
    u8 *root = pawn ? F(pawn, O_A_ROOT, u8 *) : 0;
    u8 *weapon, *data, *target = 0;
    float best = 400.0f * 400.0f, tx = 0, mx, my;
    struct line l;
    i32 i, num;
    u32 now;
    if (!root || !world || !is_character(pawn) || !env_on(attack_var, &client_attack_state))
        return;
    now = (*(gettickcount_fn *)(image_base() + IAT_GETTICKCOUNT))();
    if (pressed_pawn && (i32)(now - release_at) >= 0) {
        if (pressed_pawn == pawn)
            FN(R_ON_STOP_PRIMARY, pawn_input_fn)(pawn);
        pressed_pawn = 0;
    }
    if (pressed_pawn || (i32)(now - attack_next) < 0)
        return;
    attack_next = now + 2000;
    mx = F(root, O_SC_LOCATION, float);
    my = F(root, O_SC_LOCATION + 4, float);
    data = F(world + O_W_PAWNS, 0, u8 *);
    num = F(world + O_W_PAWNS, 8, i32);
    for (i = 0; data && i < num; i++) {
        u8 *p = (u8 *)FN(R_WEAK_GET, weak_get_fn)(data + (u64)i * 8);
        u8 *r = p && p != pawn && is_character(p) ? F(p, O_A_ROOT, u8 *) : 0;
        float dx, dy;
        if (!r || health_of(p) <= 0)
            continue;
        dx = F(r, O_SC_LOCATION, float) - mx;
        dy = F(r, O_SC_LOCATION + 4, float) - my;
        if (dx * dx + dy * dy < best) { best = dx * dx + dy * dy; target = p; tx = dx; }
    }
    weapon = F(pawn, O_CH_CURRENT, u8 *);
    if (!target || !weapon || (env_on(one_side_var, &one_side_state) && tx < 0))
        return;
    /* The arena pair stands on one X line: face +X or -X. */
    F(pc, O_PC_CONTROL_ROT, float) = 0.0f;
    F(pc, O_PC_CONTROL_ROT + 4, float) = tx >= 0 ? 0.0f : 180.0f;
    F(pc, O_PC_CONTROL_ROT + 8, float) = 0.0f;
    if (!target_ps)
        target_ps = F(target, O_PAWN_PLAYERSTATE, u8 *);    /* the first opponent: traced to the end */
    FN(R_ON_START_PRIMARY, pawn_input_fn)(pawn);
    pressed_pawn = pawn;
    release_at = now + 300;
    attacks++;
    if (trace_begin(&l, "attack")) {
        kv(&l, "n", (u64)attacks, 0);
        kv(&l, "weapon", (u64)weapon, 1);
        kv(&l, "target", (u64)target, 1);
        kv_s(&l, "dx", (i32)tx);
        kv_s(&l, "target_health", health_of(target));
        kv_s(&l, "my_health", health_of(pawn));
        trace_end(&l);
    }
}

/* Replaces the Steam driver's vtable slot +0x278 (TickFlush). */

static u32 prematch_since, prematch_trace;
static i32 prematch_released;
#define PREMATCH_MAX_MS    180000      /* start anyway after 3 minutes */

static void prematch_tick(u8 *driver, u8 *world, u8 *gm)
{
    u8 *gs = F(gm, O_GM_GAMESTATE, u8 *);
    u8 **conns = F(driver, O_ND_CLIENTS, u8 **);
    i32 nconn = F(driver, O_ND_CLIENTS + 8, i32), c, joined = 0, expect = prematch_expected();
    u32 now = (*(gettickcount_fn *)(image_base() + IAT_GETTICKCOUNT))();
    struct line l;
    (void)world;
    if (!gs || prematch_released || state_code(F(gm, O_GM_MATCH_STATE, u32)) != 1)
        return;
    if (!prematch_since)
        prematch_since = now;
    for (c = 0; conns && c < nconn; c++)
        if (conns[c] && F(conns[c], O_CONN_STATE, i32) == 3 && F(conns[c], O_CONN_PC, u8 *))
            joined++;
    if (joined < expect && now - prematch_since < PREMATCH_MAX_MS) {
        F(gs, O_GS_REMAINING, i32) = F(gm, O_GM_WARMUP, i32);   /* hold the warmup countdown full */
        if (now - prematch_trace >= 2000 && trace_begin(&l, "prematch-hold")) {
            prematch_trace = now;
            kv_s(&l, "joined", joined);
            kv_s(&l, "expect", expect);
            kv_s(&l, "remaining", F(gs, O_GS_REMAINING, i32));
            trace_end(&l);
        }
        return;
    }
    prematch_released = 1;
    if (trace_begin(&l, "prematch-start")) {
        kv_s(&l, "joined", joined);
        kv_s(&l, "expect", expect);
        kv_s(&l, "held_ms", (i32)(now - prematch_since));
        kv_s(&l, "remaining", F(gs, O_GS_REMAINING, i32));
        trace_end(&l);
    }
}

void np_tick_flush(void *driver, float dt)
{
    if (driver && driver == listen_driver && !F(driver, O_ND_SERVERCONN, void *)) {
        /* Without CULLING_NETPLAY_PREMATCH: the host's match ended by itself
         * ~35 s after listening, with or without a client (in game: the
         * listen socket closed, the world left), so the test host holds it
         * open with the no-end flag. */
        u8 *world = F(driver, O_ND_WORLD, u8 *);
        u8 *gm = world ? F(world, O_WORLD_AUTH_GM, u8 *) : 0;
        if (gm && prematch_expected() > 0)
            prematch_tick((u8 *)driver, world, gm);  /* the real pre-match phase; no no-end flag */
        else if (gm && end_phase < 2)
            F(gm, O_GM_NO_END, u8) = 1;
        else if (gm && end_phase == 2 && F(gm, O_GM_NO_END, u8))
            F(gm, O_GM_NO_END, u8) = 0;             /* released once (CULLING_NETPLAY_END) */
        server_replicate((u8 *)driver);
        if (world)
            ctl_result((u8 *)driver, world);
    } else if (driver && F(driver, O_ND_SERVERCONN, void *)) {
        client_move((u8 *)driver);
        client_attack((u8 *)driver);
        client_trace((u8 *)driver);
    }
    FN(R_STEAM_TICKFLUSH, tick_flush_fn)(driver, dt);
}
