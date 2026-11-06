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
#define MAX_OPEN_PER_PASS  4           /* new actor channels per connection per pass (reliable buffer) */
#define O_GS_PLAYERS       0x418       /* AGameState::PlayerArray */
#define O_W_CONTROLLERS    0x178       /* UWorld controller list (weak pointers) */
#define O_W_PAWNS          0x198       /* UWorld pawn list (weak pointers) */
#define O_C_PAWN           0x408       /* AController::Pawn */
#define O_A_FLAGS          0x84        /* AActor bits: 2 bNetTemporary, 4 bNetStartup, 8 bOnlyRelevantToOwner, 0x40 bTearOff */
#define O_A_REMOTE_ROLE    0x90
#define O_A_OWNER          0x98
#define O_A_ROOT           0x1e0
#define O_SC_LOCATION      0x1a0       /* USceneComponent: world location */
#define MAX_REP            256
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

struct weak { i32 index, serial; };
struct rep_stats { u64 actors, opened, replicated, skipped, deferred, saturated; u64 opened_now; u8 *remote_pawn; };

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

static void replicate_to(u8 *conn, u8 *actor, void *pc, struct rep_stats *st)
{
    u8 flags = F(actor, O_A_FLAGS, u8);
    void *ch;
    if (!F(actor, O_A_REMOTE_ROLE, u8) && !(flags & 0x40)) { st->skipped++; return; }
    if ((flags & 0x08) && !owned_by(actor, pc)) { st->skipped++; return; }
    if ((flags & 0x04) && !((conn_actor_fn)(*(void ***)conn)[VT_CONN_LEVEL_INIT / 8])(conn, actor)) { st->skipped++; return; }
    ch = find_channel(conn, actor);
    if (!ch) {
        if (flags & 0x40) { st->skipped++; return; }        /* torn off: nothing new to open */
        if (st->opened_now >= MAX_OPEN_PER_PASS) { st->deferred++; return; }
        st->opened_now++;
        ch = FN(R_CREATE_CHANNEL, create_channel_fn)(conn, CHTYPE_ACTOR, 1, -1);
        if (!ch) { st->skipped++; return; }
        FN(R_SET_CH_ACTOR, set_ch_actor_fn)(ch, actor);
        st->opened++;
    }
    if (F(ch, O_CH_FLAGS, u8) & 2)
        return;                                              /* closing */
    FN(R_REPLICATE_ACTOR, replicate_fn)(ch);
    st->replicated++;
}

/* The actors replicated: the game state, its player states, every
 * controller and every pawn in the world (no relevancy culling yet). */
static i32 collect(u8 *world, u8 **out)
{
    i32 n = 0, i, num, pass;
    u8 *gm = F(world, O_WORLD_AUTH_GM, u8 *);
    u8 *gs = gm ? F(gm, O_GM_GAMESTATE, u8 *) : 0;
    if (gs) {
        u8 **ps = F(gs, O_GS_PLAYERS, u8 **);
        out[n++] = gs;
        num = F(gs, O_GS_PLAYERS + 8, i32);
        for (i = 0; ps && i < num && n < MAX_REP; i++)
            if (ps[i])
                out[n++] = ps[i];
    }
    for (pass = 0; pass < 2; pass++) {
        u8 *list = world + (pass ? O_W_PAWNS : O_W_CONTROLLERS);
        u8 *data = F(list, 0, u8 *);
        num = F(list, 8, i32);
        for (i = 0; data && i < num && n < MAX_REP; i++) {
            u8 *a = (u8 *)FN(R_WEAK_GET, weak_get_fn)(data + (u64)i * 8);
            if (a)
                out[n++] = a;
        }
    }
    return n;
}

static u32 last_rep, last_trace, last_alive;
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

/* CULLING_NETPLAY_PREREP=1 turns on AActor::CallPreReplication before
 * replicating (it updates replicated movement); off until it's proven safe
 * in game. */
static i32 prerep_on(void)
{
    static const u16 var[] = { 'C','U','L','L','I','N','G','_','N','E','T','P','L','A','Y','_','P','R','E','R','E','P',0 };
    return env_on(var, &prerep_state);
}

static void server_replicate(u8 *driver)
{
    u8 *actors[MAX_REP];
    u8 *world = F(driver, O_ND_WORLD, u8 *);
    u8 **conns = F(driver, O_ND_CLIENTS, u8 **);
    i32 nconn = F(driver, O_ND_CLIENTS + 8, i32), n, i, c, live = 0;
    struct rep_stats st = { 0, 0, 0, 0, 0, 0, 0, 0 };
    struct line l;
    u32 now = (*(gettickcount_fn *)(image_base() + IAT_GETTICKCOUNT))();
    if (now - last_alive >= 5000 && trace_begin(&l, "host-alive")) {
        last_alive = now;
        kv(&l, "clients", (u64)(nconn > 0 ? nconn : 0), 0);
        kv(&l, "state0", nconn > 0 && conns && conns[0] ? (u64)F(conns[0], O_CONN_STATE, i32) : 0, 0);
        kv(&l, "world", (u64)world, 1);
        trace_end(&l);
    }
    if (!world || nconn <= 0 || now - last_rep < REP_PERIOD_MS)
        return;
    last_rep = now;
    n = collect(world, actors);
    if (prerep_on())
        for (i = 0; i < n; i++)
            FN(R_PRE_REPLICATION, pre_rep_fn)(actors[i], driver);
    for (c = 0; c < nconn; c++) {
        u8 *conn = conns[c];
        void *pc = conn ? F(conn, O_CONN_PC, void *) : 0;
        conn_ready_fn ready;
        if (!conn || !pc || F(conn, O_CONN_STATE, i32) != 3)
            continue;
        live++;
        if (!st.remote_pawn)
            st.remote_pawn = F(pc, O_C_PAWN, u8 *);
        ready = (conn_ready_fn)(*(void ***)conn)[VT_CONN_NET_READY / 8];
        st.opened_now = 0;
        if (!ready(conn, 0)) { st.saturated++; continue; }   /* as the engine does: wait for room */
        replicate_to(conn, (u8 *)pc, pc, &st);               /* its own PlayerController first */
        for (i = 0; i < n; i++) {
            if (!ready(conn, 0)) { st.saturated++; break; }
            if (actors[i] != pc)
                replicate_to(conn, actors[i], pc, &st);
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
        if (st.remote_pawn && F(st.remote_pawn, O_A_ROOT, u8 *)) {
            u8 *root = F(st.remote_pawn, O_A_ROOT, u8 *);
            kv(&l, "remote_pawn", (u64)st.remote_pawn, 1);
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
    trace_end(&l);
    data = F(world + O_W_PAWNS, 0, u8 *);
    num = F(world + O_W_PAWNS, 8, i32);
    for (i = 0; data && i < num && i < 24; i++) {
        u8 *p = (u8 *)FN(R_WEAK_GET, weak_get_fn)(data + (u64)i * 8);
        u8 *root = p ? F(p, O_A_ROOT, u8 *) : 0;
        if (!root || !trace_begin(&l, "client-pawn"))
            continue;
        kv(&l, "pawn", (u64)p, 1);
        kv(&l, "mine", p == mine, 0);
        kv_s(&l, "x", (i32)F(root, O_SC_LOCATION, float));
        kv_s(&l, "y", (i32)F(root, O_SC_LOCATION + 4, float));
        kv_s(&l, "z", (i32)F(root, O_SC_LOCATION + 8, float));
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

/* Replaces the Steam driver's vtable slot +0x278 (TickFlush). */
#define O_GM_NO_END        0x74d       /* AShooterGame_FreeForAll: while set, its end-of-match check never ends the match (showdown_rounds.c GM_NO_END) */

void np_tick_flush(void *driver, float dt)
{
    if (driver && driver == listen_driver && !F(driver, O_ND_SERVERCONN, void *)) {
        /* The host's match ended by itself ~35 s after listening, with or
         * without a client (in game: the listen socket closed, the world
         * left), so the test host holds it open. */
        u8 *world = F(driver, O_ND_WORLD, u8 *);
        u8 *gm = world ? F(world, O_WORLD_AUTH_GM, u8 *) : 0;
        if (gm)
            F(gm, O_GM_NO_END, u8) = 1;
        server_replicate((u8 *)driver);
    } else if (driver && F(driver, O_ND_SERVERCONN, void *)) {
        client_move((u8 *)driver);
        client_trace((u8 *)driver);
    }
    FN(R_STEAM_TICKFLUSH, tick_flush_fn)(driver, dt);
}
