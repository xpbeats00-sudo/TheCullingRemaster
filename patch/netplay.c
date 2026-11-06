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

struct line { char b[200]; u32 n; };

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

void np_prelogin(void *gm, void *options, void *address, void *uid, void *error)
{
    struct line l;
    FN(R_BASE_PRELOGIN, prelogin_fn)(gm, options, address, uid, error);
    if (trace_begin(&l, "prelogin")) {
        kv(&l, "error_len", (u64)((struct fstring *)error)->num, 0);
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
    FN(R_NOTIFY_CONTROL, notify_control_fn)(notify, conn, type, bunch);
    if (trace_begin(&l, "control-done")) {
        kv(&l, "type", type, 0);
        kv(&l, "state", conn ? (u64)F(conn, O_CONN_STATE, i32) : 0, 0);
        kv(&l, "pc", conn ? (u64)F(conn, O_CONN_PC, void *) : 0, 1);
        kv(&l, "pc_vtable", conn ? vt_rva(F(conn, O_CONN_PC, void *)) : 0, 1);
        trace_end(&l);
    }
}
