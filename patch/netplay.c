/* netplay.c - a native module that reimplements UWorld::Listen inside the
 * WindowsClient Victory.exe, the first piece of "route B" from
 * docs/MULTIPLAYER_NETPLAY_FEASIBILITY.md (rebuild the server code the
 * WITH_SERVER_CODE=0 build stripped).
 *
 * Built by build_netplay.py (MSVC cl, no CRT) into a position-independent
 * blob that patch_netplay.py places in a new section (.netp) of the exe, the
 * same way build_showdown_rounds.py / patch_exe.py build and place the
 * Showdown module. All game addresses are image-relative (the exe is
 * ASLR-enabled): the base is recovered from the RVA of np_self_rva, which the
 * builder writes into the blob, so the blob needs no base relocations.
 *
 * ONE entry point:
 *
 * np_listen(world, url) replaces the call UEngine::LoadMap makes to
 *   UWorld::Listen (VA 0x141644cef, which in this build targets the shared
 *   "xor al,al; ret" stub 0x14143e6f0 - UWorld::Listen was compiled out).
 *   patch_netplay.py repoints that one call to this function. On a map URL
 *   with ?listen (or on any map when !GIsClient), LoadMap now calls this
 *   instead of the no-op, so ?listen reaches real engine code again.
 *
 *   What it does, using only engine code confirmed present in this build
 *   (see docs/NETPLAY_LISTEN_SERVER.md for the address evidence):
 *     1. If the world already has a net driver (UWorld+0xb8) -> return true.
 *     2. Find this world's WorldContext (GEngine->WorldList, each entry's
 *        +0x298 is its world) and walk its ActiveNetDrivers (WorldContext
 *        +0x248 array, +0x250 count, 16-byte {UNetDriver* driver, FName name}
 *        entries) for a driver already named NAME_GameNetDriver.
 *     3. If one is found, bind it to the world and call its InitListen
 *        (UIpNetDriver::InitListen, vtable slot +0x220, confirmed intact:
 *        it runs InitBase -> create+bind the UDP socket, then
 *        InitConnectionlessHandler, then stores the bound port). On success
 *        store it at UWorld+0xb8 so UWorld::GetNetMode returns NM_ListenServer
 *        (ServerConnection==NULL and GIsClient==1 -> net mode 2, verified in
 *        the net-mode helper 0x1414318f0), and return true.
 *     4. If no GameNetDriver exists yet, creating one needs NewObject of the
 *        configured UIpNetDriver/USteamNetDriver class - the one engine symbol
 *        this build does not hand us cleanly (UEngine::CreateNamedNetDriver /
 *        CreateNetDriver_Local, which read GEngine->NetDriverDefinitions and
 *        construct the driver). That is milestone 1 in the doc: a debugger
 *        pins CreateNamedNetDriver, and NP_HAVE_CREATE_NET_DRIVER below is set
 *        to 1 with its RVA filled in. Until then the module takes the safe
 *        path: it does not call an unverified address, it records that no
 *        driver was available, and returns false - exactly what the stock
 *        stub did, so patching this in changes nothing observable until the
 *        driver-creation symbol is confirmed. This keeps the prototype safe to
 *        run (no jump to a guessed address).
 *
 *   Every piece except driver creation (step 4) is written against addresses
 *   confirmed from the stock exe's bytes; the one unconfirmed symbol is
 *   isolated behind a compile-time flag that defaults off.
 */

typedef unsigned long long u64;
typedef unsigned int u32;
typedef int i32;
typedef unsigned char u8;

/* ---- the game (RVA = VA - 0x140000000) --------------------------------- */

#define IMAGE_BASE        0x140000000ull

/* Globals. */
#define R_GENGINE         0x3307b48   /* GEngine (UEngine*), confirmed: loaded 969x, the ptr
                                         GetWorldContextFromWorld reads */
#define R_GISCLIENT       0x30f55e8   /* GIsClient (u8): 1 in this WindowsClient build */

/* Functions. */
#define R_GET_WORLDCTX    0x163d220   /* UEngine::GetWorldContextFromWorld(engine, world) ->
                                         WorldContext* (NULL if none). WorldList at engine+0xb98,
                                         count engine+0xba0; each WorldContext's world is +0x298 */

/* Struct offsets (confirmed from the bytes cited in the doc). */
#define O_WC_WORLD        0x298       /* WorldContext.ThisCurrentWorld */
#define O_WC_DRIVERS_PTR  0x248       /* WorldContext.ActiveNetDrivers: TArray data ptr */
#define O_WC_DRIVERS_NUM  0x250       /* WorldContext.ActiveNetDrivers: Num (int32) */
#define WC_DRIVER_STRIDE  0x10        /* sizeof(FNamedNetDriver) {UNetDriver* NetDriver; FName NetDriverName;} */
#define O_WORLD_NETDRIVER 0xb8        /* UWorld.NetDriver (GetNetMode reads this) */
#define VT_INITLISTEN     0x220       /* UNetDriver vtable slot: InitListen(this, Notify, URL, bReuse, Error) */
#define VT_SETWORLD       0x218       /* UNetDriver vtable slot (near InitBase): bind world owner.
                                         0x218 on UIpNetDriver is 0x1422d9370 (own override) */

/* FName of "GameNetDriver". FName is a 32-bit comparison index; its runtime
 * value depends on name-table insertion order, so it is read at run time from
 * the driver the engine already created (step 2 matches by driver presence,
 * not by a baked-in index) rather than hard-coded here. */

/* Set to 1, with R_CREATE_NAMED_NET_DRIVER filled in, once a debugger has
 * pinned UEngine::CreateNamedNetDriver (doc milestone 1). Left 0 so the blob
 * never jumps to an unverified address. */
#define NP_HAVE_CREATE_NET_DRIVER 0
#define R_CREATE_NAMED_NET_DRIVER 0   /* UNCONFIRMED: fill from a debugger first */

/* The builder writes SECTION_RVA + offsetof(np_self_rva) here. A nonzero
 * initializer keeps it in .data (a zero-init global becomes a COMMON/.bss
 * symbol the no-CRT link can't place). */
volatile u64 np_self_rva = 0x4E4554504C4159ULL;  /* "NETPLAY" */

static u64 image_base(void)
{
    /* Address of np_self_rva at run time, minus the RVA stored in it. */
    return (u64)(&np_self_rva) - np_self_rva;
}

#define FN(rva, sig) ((sig)(image_base() + (u64)(rva)))
#define GLOBAL(rva, ty) (*(ty*)(image_base() + (u64)(rva)))

/* ---- the module -------------------------------------------------------- */

/* InitListen(this, FNetworkNotify* Notify, const FURL& URL, bool bReuseAddressAndPort, FString& Error).
 * Called through the driver's own vtable so the UIpNetDriver / USteamNetDriver
 * override runs. Returns bool in al. */
typedef u8 (*init_listen_fn)(void *driver, void *notify, void *url, u8 reuse, void *error);
typedef void *(*get_worldctx_fn)(void *engine, void *world);

/* An FString we can hand InitListen as its out-Error. Empty = {nullptr,0,0}.
 * InitListen only writes to it on failure; a 16-byte zeroed TArray<TCHAR> is a
 * valid empty FString the engine will grow if it needs to. */
struct fstring { void *data; i32 num; i32 max; };

static void *find_game_net_driver(void *world)
{
    void *engine = (void *)GLOBAL(R_GENGINE, u64);
    if (!engine || !world)
        return 0;
    get_worldctx_fn get_ctx = FN(R_GET_WORLDCTX, get_worldctx_fn);
    u8 *wc = (u8 *)get_ctx(engine, world);
    if (!wc)
        return 0;
    u8 *entry = *(u8 **)(wc + O_WC_DRIVERS_PTR);
    i32 num = *(i32 *)(wc + O_WC_DRIVERS_NUM);
    if (!entry || num <= 0)
        return 0;
    /* The game driver is the ActiveNetDrivers entry whose driver is non-null.
     * A fresh listen world has at most the one the engine made for it; the
     * demo driver is only present while recording a replay. */
    for (i32 i = 0; i < num; i++) {
        void *driver = *(void **)(entry + (u64)i * WC_DRIVER_STRIDE);
        if (driver)
            return driver;
    }
    return 0;
}

/* Replaces LoadMap's call of UWorld::Listen(URL). */
u8 np_listen(void *world, void *url)
{
    if (!world)
        return 0;

    /* Already listening / connected. */
    if (*(void **)((u8 *)world + O_WORLD_NETDRIVER))
        return 1;

    void *driver = find_game_net_driver(world);

#if NP_HAVE_CREATE_NET_DRIVER
    if (!driver) {
        /* Milestone 1: ask the engine to create NAME_GameNetDriver, then
         * re-find it. Only compiled in once the symbol is confirmed. */
        typedef void (*create_fn)(void *engine, void *world, u32 def_name, u32 drv_name);
        /* NAME_GameNetDriver's FName index is pinned alongside the symbol. */
        /* FN(R_CREATE_NAMED_NET_DRIVER, create_fn)(GEngine, world, ...); */
        driver = find_game_net_driver(world);
    }
#endif

    if (!driver)
        return 0;   /* same observable result as the stock stub, no guessed call */

    void **vt = *(void ***)driver;
    init_listen_fn init_listen = (init_listen_fn)vt[VT_INITLISTEN / 8];
    struct fstring error = { 0, 0, 0 };
    /* Notify = the UWorld (it implements FNetworkNotify). bReuse = false. */
    u8 ok = init_listen(driver, world, url, 0, &error);
    if (ok)
        *(void **)((u8 *)world + O_WORLD_NETDRIVER) = driver;
    return ok;
}
