/* Runs the native module's weather (weather.c inside showdown_rounds.c,
 * compiled with the blob's own flags) against fake game objects, like
 * test_native_module.c: a fake image holds a jump at every game function the
 * weather calls, to the stand-ins below.
 *
 * Modes (test_weather_native.py drives them):
 *   probe <seed> <preset> <cycle> <t0> <t1>   the schedule, one line per second
 *   run <options> <map> <t1>                  ticks 0..t1 through sd_should_end with
 *                                             the given URL options; one line per
 *                                             second of what was applied
 *   checks                                    fixed behaviour checks ("ok ..." lines)
 * Exits 1 on the first failed check.
 */
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <wchar.h>

typedef unsigned long long u64;
typedef unsigned char u8;
typedef unsigned short u16;
typedef unsigned int u32;
typedef int i32;

extern volatile u64 sd_self_rva;
char sd_should_end(u8 *gm);
void sd_weather_probe(u32 seed, i32 preset, i32 cycle, i32 t, i32 *out);

#define F(p, off, type) (*(type *)((u8 *)(p) + (off)))
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
static int deactivated;
static void kill_obj(u8 *o);
static void deactivate(u8 *self) { deactivated++; kill_obj(self); }   /* it finishes, then goes */

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
static u8 *cls_pc;
static u8 *ret_pc(void) { return cls_pc; }

static u8 *objs[256];
static int alive_obj[256], nobjs;
static void weak_set(i32 *w, u8 *o)
{
    int i;
    w[0] = -1; w[1] = 0;
    for (i = 0; o && i < nobjs; i++) if (objs[i] == o) { w[0] = i; w[1] = 1; }
}
static u8 *weak_get(i32 *w) { return w[1] && w[0] >= 0 && alive_obj[w[0]] ? objs[w[0]] : 0; }
static int reg(u8 *o) { objs[nobjs] = o; alive_obj[nobjs] = 1; return nobjs++; }
static void kill_obj(u8 *o) { int i; for (i = 0; i < nobjs; i++) if (objs[i] == o) alive_obj[i] = 0; }
static int alive(u8 *o) { int i; for (i = 0; i < nobjs; i++) if (objs[i] == o) return alive_obj[i]; return 0; }

/* The level's objects and what was set on them. */
static u8 *fog, *sun, *sky, *mid, *ps_class, *tmpl[3];
static int map_loaded = 1;
static const wchar_t *map_prefix = L"/Game/Maps/Jungle/Lighting_Night.Lighting:";
static float fog_density, fog_start, sun_i, sky_i, p_cloud, p_speed, p_stars;
static int calls, spawned, names_made;
static u8 *spawn_tmpl, *spawn_parent, *last_comp;

static int starts(const wchar_t *s, const wchar_t *p) { return wcsncmp(s, p, wcslen(p)) == 0; }
static int ends(const wchar_t *s, const wchar_t *e)
{
    size_t a = wcslen(s), b = wcslen(e);
    return a >= b && wcscmp(s + a - b, e) == 0;
}

static u8 *find_object(u8 *cls, u8 *outer, const wchar_t *name, char exact)
{
    (void)cls; (void)outer; (void)exact;
    if (!wcscmp(name, L"/Script/Engine.ParticleSystem")) return ps_class;
    if (!map_loaded || !starts(name, map_prefix)) return 0;
    if (ends(name, L".HeightFogComponent0")) return fog;
    if (ends(name, L".LightComponent0")) return sun;
    if (ends(name, L".SkyLightComponent0")) return sky;
    if (ends(name, L".Sky Sphere mesh.MaterialInstanceDynamic_0")) return mid;
    return 0;
}
static u8 *load_object(u8 *cls, u8 *outer, const wchar_t *name, const wchar_t *file, u32 flags, void *sb, char rec)
{
    (void)outer; (void)file; (void)flags; (void)sb; (void)rec;
    CHECK(cls == ps_class);
    if (!wcscmp(name, L"/Game/Remaster/Weather/P_Rain_Light.P_Rain_Light")) return tmpl[0];
    if (!wcscmp(name, L"/Game/Remaster/Weather/P_Rain_Heavy.P_Rain_Heavy")) return tmpl[1];
    if (!wcscmp(name, L"/Game/Remaster/Weather/P_Rain_Storm.P_Rain_Storm")) return tmpl[2];
    return 0;
}
static void *make_name(u64 *out, const wchar_t *s, i32 find)
{
    CHECK(find == 1);
    names_made++;
    *out = !wcscmp(s, L"Cloud opacity") ? 11 : !wcscmp(s, L"Cloud speed") ? 12 : !wcscmp(s, L"Stars brightness") ? 13 : 99;
    return out;
}
static void set_fog_density(u8 *o, float v) { CHECK(o == fog); fog_density = v; calls++; }
static void set_fog_start(u8 *o, float v) { CHECK(o == fog); fog_start = v; calls++; }
static void set_light(u8 *o, float v) { CHECK(o == sun); sun_i = v; calls++; }
static void set_sky(u8 *o, float v) { CHECK(o == sky); sky_i = v; calls++; }
static void set_scalar(u8 *o, u64 name, float v)
{
    CHECK(o == mid);
    if (name == 11) p_cloud = v; else if (name == 12) p_speed = v; else if (name == 13) p_stars = v;
    else CHECK(0);
    calls++;
}
static u8 *spawn_attached(u8 *t, u8 *parent, u64 name, const float *loc, const float *rot, i32 type, char autodestroy)
{
    CHECK(name == 0 && loc[0] == 0 && loc[1] == 0 && loc[2] == 0 && rot[0] == 0 && type == 0 && autodestroy == 1);
    spawned++;
    spawn_tmpl = t;
    spawn_parent = parent;
    last_comp = new_obj(0);
    reg(last_comp);
    return last_comp;
}

static char stock_end(u8 *gm) { (void)gm; return 0; }

/* Shelter traces: the roof over the centre trace, and over how many of the 4 side ones. */
static u8 *pawn, *root;
static int roof_center, roof_sides, traces, side_traces;
static char line_trace(u8 *ctx, const float *st, const float *en, u8 channel, char complex, const void *ignore,
                       i32 draw, u8 *hit, char self, const float *c1, const float *c2, float time)
{
    const float *at = (const float *)(root + 0x1a0);
    float dx = st[0] - at[0], dy = st[1] - at[1];
    (void)c1; (void)c2; (void)time;
    CHECK(ctx == pawn && channel == 0 && complex == 1 && draw == 0 && self == 1 && hit && ignore);
    CHECK(en[0] == st[0] && en[1] == st[1] && en[2] == st[2] + 3000.0f && st[2] == at[2] + 60.0f);
    traces++;
    if (dx == 0.0f && dy == 0.0f) { side_traces = 0; return (char)roof_center; }
    CHECK(dx * dx + dy * dy == 250.0f * 250.0f);
    return (char)(side_traces++ < roof_sides);
}

/* ---------------------------------------------------------------- a match */
static u8 *gm, *gs, *pc;
static u16 opts[256];

static void set_options(const char *o)
{
    int i, n = (int)strlen(o);
    for (i = 0; i < n; i++) opts[i] = (u16)o[i];
    opts[n] = 0;
    F(gm, 0x400, u16 *) = opts;
    F(gm, 0x408, i32) = n + 1;
    F(gm, 0x40c, i32) = n + 1;
}

static void new_pawn(void)
{
    pawn = new_obj(0);
    root = new_obj(0);
    F(root, 0x1a0, float) = 1000.0f;        /* ComponentToWorld translation */
    F(root, 0x1a4, float) = -2000.0f;
    F(root, 0x1a8, float) = 300.0f;
    F(pawn, 0x1e0, u8 *) = root;
    F(pc, 0x408, u8 *) = pawn;
}

static void new_match(const char *options)
{
    i32 *list = (i32 *)calloc(2, sizeof(i32));
    gm = new_obj(0);
    gs = new_obj(0);
    F(gm, 0x4e0, u8) = 1;                   /* Solo: the stock end check */
    F(gm, 0x458, u8 *) = gs;
    set_options(options);
    pc = new_obj(cls_pc);
    reg(pc);
    weak_set(list, pc);
    F(world, 0x178, i32 *) = list;
    F(world, 0x180, i32) = 1;
    new_pawn();
}

static void tick(i32 t) { F(gs, 0x4e8, i32) = t; CHECK(sd_should_end(gm) == 0); }

static int rain_level_of(u8 *t) { return t == tmpl[0] ? 1 : t == tmpl[1] ? 2 : t == tmpl[2] ? 3 : 0; }

static void checks(void)
{
    int before;
    new_match("?bEnableBots=true?game=/Game/X.X_C");
    calls = 0;
    tick(0); tick(1);
    CHECK(calls == 0 && spawned == 0 && names_made == 0);
    printf("ok    no ?Weather=: nothing is touched\n");

    new_match("?Weather=sunny?WeatherSeed=5");
    tick(0);
    CHECK(calls == 0 && spawned == 0);
    printf("ok    an unknown preset: nothing is touched\n");

    new_match("?Weather=storm?WeatherSeed=7?WeatherCycle=0");
    map_loaded = 0;
    tick(0);
    CHECK(calls == 0 && spawned == 0);
    map_loaded = 1;
    tick(1);
    CHECK(calls > 0 && fog_density > 0.0f && spawned == 1 && rain_level_of(spawn_tmpl) == 3 && spawn_parent == root);
    printf("ok    storm: waits for the Lighting level, then fog, lights, sky and storm rain on the pawn root\n");

    before = spawned;
    tick(2); tick(3);
    CHECK(spawned == before && deactivated == 0);
    printf("ok    the rain emitter is spawned once\n");

    kill_obj(last_comp);                    /* the pawn died and took its emitter */
    new_pawn();
    tick(4);
    CHECK(spawned == before + 1 && spawn_parent == root && deactivated == 0);
    printf("ok    a new pawn gets a new emitter\n");

    before = deactivated;
    {
        u8 *old = last_comp;
        new_pawn();                         /* a new pawn while the old emitter lives (corpse) */
        tick(5);
        CHECK(deactivated == before + 1 && spawn_parent == root && last_comp != old);
    }
    printf("ok    an emitter left on an old pawn is deactivated\n");

    /* Under a roof: the rain goes off after 2 covered ticks, and stays off. */
    {
        int s0 = spawned, d0 = deactivated, i;
        roof_center = 1; roof_sides = 4;
        tick(6);
        CHECK(deactivated == d0 && alive(last_comp));            /* one covered tick: still raining */
        tick(7);
        CHECK(deactivated == d0 + 1 && !alive(last_comp));       /* covered twice: off */
        for (i = 8; i < 12; i++) tick(i);
        CHECK(spawned == s0 && deactivated == d0 + 1);
        printf("ok    under a roof the rain turns off after 2 covered ticks and stays off\n");

        roof_center = 0; roof_sides = 0;
        tick(12);
        CHECK(spawned == s0);                                    /* one open tick: still off */
        tick(13);
        CHECK(spawned == s0 + 1 && alive(last_comp) && rain_level_of(spawn_tmpl) == 3 && spawn_parent == root);
        printf("ok    back in the open the rain comes back after 2 open ticks\n");

        s0 = spawned; d0 = deactivated;
        roof_center = 1; roof_sides = 1;                         /* a small overhang */
        for (i = 14; i < 18; i++) tick(i);
        CHECK(spawned == s0 && deactivated == d0 && alive(last_comp));
        roof_center = 0; roof_sides = 4;                         /* roof beside, nothing above */
        for (i = 18; i < 21; i++) tick(i);
        CHECK(spawned == s0 && deactivated == d0 && alive(last_comp));
        printf("ok    a small overhang (or a roof only beside you) keeps the rain\n");

        for (i = 21; i < 31; i++) {                              /* in and out every second */
            roof_center = i & 1; roof_sides = (i & 1) ? 4 : 0;
            tick(i);
        }
        CHECK(spawned == s0 && deactivated == d0 && alive(last_comp));
        printf("ok    in and out every second: no thrash (no deactivate, no respawn)\n");
        roof_center = 0; roof_sides = 0;
    }

    new_match("?Weather=clear?WeatherSeed=9?WeatherCycle=0");
    before = spawned;
    traces = 0;
    roof_center = 1; roof_sides = 4;
    tick(0); tick(1); tick(2);
    CHECK(spawned == before && p_stars > 0.5f && traces == 0);
    roof_center = 0; roof_sides = 0;
    printf("ok    clear: no rain, stars out, no shelter traces\n");
}

static void run(const char *options, const wchar_t *prefix, i32 t1)
{
    i32 t;
    map_prefix = prefix;
    new_match(options);
    for (t = 0; t <= t1; t++) {
        tick(t);
        printf("T %d %.6f %.3f %.6f %.6f %.4f %.4f %.4f %d\n", t, fog_density, fog_start, sun_i, sky_i,
               p_cloud, p_speed, p_stars, last_comp && alive(last_comp) ? rain_level_of(spawn_tmpl) : 0);
    }
}

int main(int argc, char **argv)
{
    int i;
    image = (u8 *)VirtualAlloc(0, 0x2600000, MEM_RESERVE, PAGE_NOACCESS);
    CHECK(image);
    cls_pc = new_class();
    ps_class = new_obj(0);
    for (i = 0; i < 3; i++) tmpl[i] = new_obj(0);
    fog = new_obj(0); sun = new_obj(0); sky = new_obj(0); mid = new_obj(0);
    world = new_obj(0);
    vtable[0x120 / 8] = (void *)get_world;
    vtable[0x210 / 8] = (void *)deactivate;
    hook(0x244d30, (void *)stock_end);
    hook(0x69c470, (void *)weak_get);
    hook(0x69c2a0, (void *)weak_set);
    hook(0x303820, (void *)ret_pc);
    hook(0x6942a0, (void *)find_object);
    hook(0x695470, (void *)load_object);
    hook(0x5b0e60, (void *)make_name);
    hook(0x1271a60, (void *)set_fog_density);
    hook(0x1272f60, (void *)set_fog_start);
    hook(0x1271d00, (void *)set_light);
    hook(0x12c0830, (void *)set_sky);
    hook(0x1423690, (void *)set_scalar);
    hook(0x1348fa0, (void *)spawn_attached);
    hook(0x13b7d00, (void *)line_trace);
    VirtualAlloc(image + 0x2567000, 0x1000, MEM_COMMIT, PAGE_READWRITE);   /* L"/Script/Victory" */
    sd_self_rva = (u64)&sd_self_rva - (u64)image;
    if (argc >= 2 && !strcmp(argv[1], "probe")) {
        u32 seed = (u32)strtoul(argv[2], 0, 10);
        i32 preset = atoi(argv[3]), cycle = atoi(argv[4]), t0 = atoi(argv[5]), t1 = atoi(argv[6]), t, out[5];
        for (t = t0; t <= t1; t++) {
            sd_weather_probe(seed, preset, cycle, t, out);
            printf("P %d %d %d %d %d %d\n", t, out[0], out[1], out[2], out[3], out[4]);
        }
        return 0;
    }
    if (argc >= 2 && !strcmp(argv[1], "run")) {
        static wchar_t prefix[200];
        mbstowcs(prefix, argv[3], 199);
        run(argv[2], prefix, atoi(argv[4]));
        return 0;
    }
    checks();
    printf("all weather native tests passed\n");
    return 0;
}
