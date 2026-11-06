/* The automated in-game tests: a scenario drives a real match with the game's
 * own functions and writes what it sees as JSON lines. Part of the native
 * module: showdown_rounds.c includes this file.
 *
 * Off unless the match URL has ?RemasterAutoTest=<scenario> (no shipped URL
 * has it: test_match_urls.py fails if one does). Off, it costs one compare a
 * frame: sd_gm_tick (the FreeForAll vtable's slot 125, AShooterGameMode::Tick,
 * stock VA 0x1402456b0, a jmp to 0x140237910: the per-frame tick whose
 * once-a-second part calls slot 282) runs the stock tick, then at_frame,
 * which returns at once for a GameMode whose URL has no scenario. It runs in
 * every match state, so a scenario can quit after the match has ended.
 *
 * What a scenario can do, all through the game's own code:
 *   - kill a contestant: UGameplayStatics::ApplyDamage (0x14132cec0) with
 *     lethal damage, a chosen killer controller as EventInstigator and its
 *     pawn as DamageCauser: the game's TakeDamage -> Die -> Killed path;
 *   - move a pawn: AActor::K2_TeleportTo (unstick.c's US_TELEPORT) or, to put
 *     it exactly somewhere (inside a tree), K2_SetActorLocation (0x14111f940,
 *     no sweep, teleport);
 *   - push a direction: APawn::AddMovementInput (vtable +0x6b0), every frame;
 *   - start gas pylons as the Chokening does: APylon::OnRising (vtable
 *     +0x5e0, what BP_KillSwitch's KillSwitchActivation runs), then the
 *     console's HandleAirDropRatingActivity("PylonUse", name, 4) through the
 *     module's own entry sd_rating (the call fix 8 hooks);
 *   - keep the local player alive: the health component's SetHealth
 *     (0x140263850) to its max each frame;
 *   - quit: UKismetSystemLibrary::ExecuteConsoleCommand (0x1413ae190) "quit".
 * What it reads: the world's controllers, PlayerArray (TeamNumber +0x490,
 * PlayerName +0x408), AShooterPlayerState GetKills (0x1402483b0) and
 * GetKillerName (0x140248270), the game state's alive records, the
 * scoreboard arrays (RoundScoreboardData +0x498/+0x4a0, m_SortedScoreboardData
 * +0x590/+0x598), pawn locations, weapons (AShooterCharacter +0x8d8, its
 * EWeaponState +0x660, the weapon's own debug string 0x1402c1d00 for the
 * state names), the module's series (S), unstick (U), weather (W) and
 * Chokening (C) state, and every HUD message the module sends.
 *
 * The lines go to %LOCALAPPDATA%\TheCullingRemaster\autotest\results.jsonl
 * (kernel32 through Victory.exe's own import table: CreateDirectoryW,
 * CreateFileW, WriteFile, GetEnvironmentVariableW, GetTickCount64), one JSON
 * object a line: {"ms": ms since the scenario began, "el": seconds
 * InProgress, "ev": what, ...}. patch/autotest/run.py reads them.
 *
 * Scenarios (patch/autotest/scenarios.py has the URLs and the checks):
 *   teamwin    wipe every other team (Solo: every bot), the local player as
 *              killer: the team's (your) win
 *   teamout    the local player dies first (killed by a rival), then each
 *              teammate: the team is out; the HUD posts your death's Rank
 *   solodeath  ten bots die, then the local player
 *   sd         Showdown, 1v1 or team: you lose round 2 (team: you go down
 *              first, then your mates), win the others: 4-1
 *   choke      Duo: three pylons started the Chokening's way, three rivals
 *              and your teammate held in their gas
 *   unstick    Prison: the local pawn put in an American Elm's fork, pushing
 *              forward, twice
 *   night      a night map with weather for 10+ minutes, the player kept alive
 *   bots       every bot brought around the (kept alive) player, then their
 *              weapon states sampled every frame
 */

/* ---------------------------------------------------------------- the game */
#define AT_GM_TICK        0x2456b0  /* the FreeForAll vtable's slot 125 (stock): AShooterGameMode::Tick */
#define AT_APPLY_DAMAGE   0x132cec0 /* float UGameplayStatics::ApplyDamage(AActor*, float, AController*, AActor*, UClass*) */
#define AT_CONSOLE        0x13ae190 /* UKismetSystemLibrary::ExecuteConsoleCommand(ctx, const FString *, APlayerController*) */
#define AT_SET_LOCATION   0x111f940 /* AActor::K2_SetActorLocation(actor, const FVector *, sweep, FHitResult *, teleport) */
#define AT_PS_KILLS       0x2483b0  /* AShooterPlayerState::GetKills */
#define AT_PS_KILLER      0x248270  /* AShooterPlayerState::GetKillerName(FString out) -> out */
#define AT_FNAME_STRING   0x5b44b0  /* FName::ToString(FString out) */
#define AT_WEAPON_DEBUG   0x2c1d00  /* AShooterWeapon's debug string (FString out, const FString *prefix) */
#define AT_SET_HEALTH     0x263850  /* health component SetHealth(float, bool) */
#define ATV_ADD_MOVEMENT  0x6b0     /* APawn::AddMovementInput(const FVector *, float, bool) (vtable offset) */
#define ATV_ON_RISING     0x5e0     /* APylon::OnRising (vtable offset; its exec thunk jumps to it) */
#define ATW_WEAPON        0x8d8     /* AShooterCharacter: current weapon (GetWeapon) */
#define ATW_STATE         0x660     /* AShooterWeapon: EWeaponState (int) */
#define ATO_NAME          0x18      /* UObjectBase::NamePrivate (FName) */
#define ATG_BOARD         0x498     /* AVictoryGameState RoundScoreboardData (TArray, 0xb0 each) */
#define ATG_SORTED        0x590     /* AVictoryGameState m_SortedScoreboardData (TArray) */
/* Victory.exe's import address table (kernel32). */
#define AT_IAT_CREATE_DIR 0x253f2a0 /* CreateDirectoryW */
#define AT_IAT_CREATE_FILE 0x253f2a8 /* CreateFileW */
#define AT_IAT_WRITE_FILE 0x253f258 /* WriteFile */
#define AT_IAT_GETENV     0x253f280 /* GetEnvironmentVariableW */
#define AT_IAT_TICKS      0x253f5d8 /* GetTickCount64 */

typedef float (*at_damage_t)(u8 *, float, u8 *, u8 *, u8 *);
typedef void (*at_console_t)(u8 *, FString *, u8 *);
typedef char (*at_setloc_t)(u8 *, const float *, char, u8 *, char);
typedef i32 (*at_int_t)(u8 *);
typedef FString *(*at_string_t)(u8 *, FString *);
typedef FString *(*at_debug_t)(u8 *, FString *, FString *);
typedef void (*at_health_t)(u8 *, float, char);
typedef void (*at_move_t)(u8 *, const float *, float, char);
typedef void (*at_tick_t)(u8 *, float);
typedef i32 (__stdcall *at_mkdir_t)(const u16 *, void *);
typedef void *(__stdcall *at_open_t)(const u16 *, u32, u32, void *, u32, u32, void *);
typedef i32 (__stdcall *at_write_t)(void *, const void *, u32, u32 *, void *);
typedef u32 (__stdcall *at_getenv_t)(const u16 *, u16 *, u32);
typedef u64 (__stdcall *at_ticks_t)(void);

#define IAT(rva) (*(void **)AT(rva))

void __stosb(unsigned char *, unsigned char, unsigned __int64);
#pragma intrinsic(__stosb)

enum { AT_NONE, AT_TEAMWIN, AT_TEAMOUT, AT_SOLODEATH, AT_SD, AT_CHOKE, AT_UNSTICK, AT_NIGHT, AT_BOTS };
#define AT_MAX     48               /* fighters tracked */
#define AT_POST_END 25              /* seconds after the match's end before quitting (the HUD posts its result) */
#define AT_LINE    2048
#define AT_WIPE_AT 100              /* seconds InProgress before a scenario kills: a result needs 120 s on the ticket */

typedef struct { u8 *ctrl, *ps, *pawn; i32 team, alive, pc, index; } AtFighter;

static struct {
    u8 *gm, *gs;
    i32 on, scen;
    u16 name[16];
    void *file;
    u64 t0, last_ms;
    i32 last_sec, frames, fps;
    i32 ended, end_ms, quit;        /* the match's end (sd_should_end said so), quit sent */
    i32 step, step_ms;              /* the scenario's progress */
    i32 tms_ms;                     /* last TMS line logged */
    i32 round_ms, round;            /* Showdown: when the round's S message came */
    i32 round_logged;
    i32 kills_done, teams_logged;
    Weak seen[AT_MAX];              /* player states seen, by PlayerArray index */
    i32 dead[AT_MAX];
    i32 state[AT_MAX];              /* bots: weapon state last frame (-1 none) */
    i32 state_ms[AT_MAX];
    Weak weapon[AT_MAX];
    u32 named_states;               /* weapon states whose debug string is logged */
    Weak pylon[4];
    Weak victim[4];
    i32 npylons, moves0;
    float fork[3];
    u8 hit[0x100];
} T;

static char LN[AT_LINE];
static i32 LNn;
static u16 at_path[300];
static AtFighter F[AT_MAX];
static i32 NF;

static u64 at_now(void) { return ((at_ticks_t)IAT(AT_IAT_TICKS))(); }
static i32 at_ms(void) { return (i32)(at_now() - T.t0); }

/* ---------------------------------------------------------------- JSON lines */
static void at_c(char c) { if (LNn < AT_LINE - 4) LN[LNn++] = c; }
static void at_raw(const char *s) { while (*s) at_c(*s++); }
static void at_num(i32 v)
{
    char b[12];
    i32 n = 0;
    u32 u = v < 0 ? (u32)(-v) : (u32)v;
    if (v < 0) at_c('-');
    do { b[n++] = (char)('0' + u % 10); u /= 10; } while (u && n < 11);
    while (n) at_c(b[--n]);
}
static const char AT_HEX[] = "0123456789abcdef";
#define AT_HX(i) (((const char *)wx_launder(AT_HEX))[i])
static void at_hex(u64 v)
{
    i32 k;
    at_c('"');
    for (k = 60; k >= 0; k -= 4) at_c(AT_HX((v >> k) & 15));
    at_c('"');
}
static void at_fnum(float f)
{
    i32 t;
    if (!(f == f) || f > 1e9f || f < -1e9f) { at_raw("null"); return; }
    t = (i32)(f < 0 ? f * 10.0f - 0.5f : f * 10.0f + 0.5f);
    if (t < 0) { at_c('-'); t = -t; }
    at_num(t / 10);
    at_c('.');
    at_c((char)('0' + t % 10));
}
static void at_wstr(const u16 *s, i32 n)
{
    i32 i;
    at_c('"');
    for (i = 0; s && i < n && s[i]; i++) {
        u16 ch = s[i];
        if (ch == '"' || ch == '\\') { at_c('\\'); at_c((char)ch); }
        else if (ch >= 32 && ch < 127) at_c((char)ch);
        else if (ch == '\n') at_raw("\\n");
        else { at_raw("\\u"); at_c(AT_HX(ch >> 12)); at_c(AT_HX((ch >> 8) & 15)); at_c(AT_HX((ch >> 4) & 15));
               at_c(AT_HX(ch & 15)); }
    }
    at_c('"');
}
static void at_key(const char *k) { at_c(','); at_c('"'); at_raw(k); at_c('"'); at_c(':'); }
static void at_i(const char *k, i32 v) { at_key(k); at_num(v); }
static void at_f(const char *k, float v) { at_key(k); at_fnum(v); }
static void at_s(const char *k, const char *v) { at_key(k); at_c('"'); at_raw(v); at_c('"'); }
static void at_fs(const char *k, const FString *s) { at_key(k); at_wstr(s ? s->data : 0, s && s->data ? s->num : 0); }

static void at_open_file(void)
{
    static const u16 VAR[] = { 'L', 'O', 'C', 'A', 'L', 'A', 'P', 'P', 'D', 'A', 'T', 'A', 0 };
    static const char SUB[] = "\\TheCullingRemaster\\autotest";
    static const char FILE_NAME[] = "\\results.jsonl";
    const char *sub = (const char *)wx_launder(SUB), *file = (const char *)wx_launder(FILE_NAME);
    u16 *path = (u16 *)wx_launder(at_path);
    u32 n = ((at_getenv_t)IAT(AT_IAT_GETENV))((const u16 *)wx_launder(VAR), path, 200);
    i32 i, k;
    if (!n || n >= 200) return;
    for (i = (i32)n, k = 0; sub[k]; k++) path[i++] = (u16)sub[k];
    path[i] = 0;
    ((at_mkdir_t)IAT(AT_IAT_CREATE_DIR))(path, 0);       /* the parent exists: the game's install folder */
    for (k = 0; file[k]; k++) path[i++] = (u16)file[k];
    path[i] = 0;
    /* FILE_APPEND_DATA, share read/write/delete, OPEN_ALWAYS, normal */
    T.file = ((at_open_t)IAT(AT_IAT_CREATE_FILE))(path, 4, 7, 0, 4, 0x80, 0);
    if (T.file == (void *)~(u64)0) T.file = 0;
}

static void at_begin(const char *ev)
{
    LNn = 0;
    at_raw("{\"ms\":");
    at_num(at_ms());
    at_i("el", T.gs ? FIELD(T.gs, GS_ELAPSED, i32) : -1);
    at_s("ev", ev);
}

static void at_end(void)
{
    u32 done = 0;
    at_c('}');
    at_c('\n');
    if (!T.file) at_open_file();
    if (T.file) ((at_write_t)IAT(AT_IAT_WRITE_FILE))(T.file, LN, (u32)LNn, &done, 0);
}

/* ---------------------------------------------------------------- the match */
static FString at_fstring(const char *s)
{
    FString f;
    i32 i, n = 0;
    while (s[n]) n++;
    f.data = 0;
    f.num = n + 1;
    f.max = 0;
    ((fn_resize)AT(R_STRING_RESIZE))(&f, n + 1, 0);
    for (i = 0; f.data && i <= n; i++) f.data[i] = (u16)(i < n ? s[i] : 0);
    return f;
}

static void at_free(FString *s) { if (s->data) ((fn_free)AT(R_FREE))(s->data); s->data = 0; }

/* The name of an object's class (its FName), e.g. "BP_Weapon_Bow_C". */
static void at_class_name(const char *k, u8 *obj)
{
    FString s;
    u8 *cls = obj ? FIELD(obj, O_CLASS, u8 *) : 0;
    s.data = 0; s.num = s.max = 0;
    if (cls) ((at_string_t)AT(AT_FNAME_STRING))(cls + ATO_NAME, &s);
    at_fs(k, &s);
    at_free(&s);
}

static void at_where(u8 *actor, float *at)
{
    u8 *root = actor ? wx_live(FIELD(actor, WXA_ROOT, u8 *)) : 0;
    at[0] = at[1] = at[2] = 0.0f;
    if (!root) return;
    at[0] = FIELD(root, WXC_LOCATION, float);
    at[1] = FIELD(root, WXC_LOCATION + 4, float);
    at[2] = FIELD(root, WXC_LOCATION + 8, float);
}

static void at_pos(const char *k, u8 *actor)
{
    float p[3];
    at_where(actor, p);
    at_key(k);
    at_c('[');
    at_fnum(p[0]); at_c(','); at_fnum(p[1]); at_c(','); at_fnum(p[2]);
    at_c(']');
}

/* Every fighter (player and AI controllers with a contestant's player state). */
static void at_roster(u8 *world)
{
    u8 *list = world + W_CONTROLLERS, **players = T.gs ? FIELD(T.gs, GS_PLAYERS, u8 **) : 0;
    i32 i, j, num = FIELD(list, 8, i32), np = T.gs ? FIELD(T.gs, GS_NUM_PLAYERS, i32) : 0;
    NF = 0;
    for (i = 0; i < num && NF < AT_MAX; i++) {
        u8 *c = weak_get(list, i), *ps;
        AtFighter *f = &F[NF];
        if (!c || !is_fighter(c)) continue;
        ps = FIELD(c, C_PLAYERSTATE, u8 *);
        if (!is_a(ps, R_CLS_PS) || (FIELD(ps, PS_FLAGS, u32) & 2)) continue;
        f->ctrl = c;
        f->ps = ps;
        f->pawn = wx_live(FIELD(c, C_PAWN, u8 *));
        if (f->pawn && !is_a(f->pawn, R_CLS_CHARACTER)) f->pawn = 0;
        f->team = FIELD(ps, PS_TEAM, i32);
        f->pc = is_a(c, R_CLS_PC);
        f->alive = f->pawn && !((fn_bool)AT(R_PS_HAS_LEFT))(ps) && ((fn_bool)AT(R_PS_IS_ALIVE))(ps)
            && ((fn_bool)AT(US_CH_ALIVE))(f->pawn);
        f->index = -1;
        for (j = 0; players && j < np; j++)
            if (players[j] == ps) f->index = j;
        NF++;
    }
}

static AtFighter *at_me(void)
{
    i32 i;
    for (i = 0; i < NF; i++)
        if (F[i].pc) return &F[i];
    return 0;
}

static int at_mate(AtFighter *me, AtFighter *f)
{
    return me && f != me && me->team > 0 && f->team == me->team;
}

static int at_rival(AtFighter *me, AtFighter *f)
{
    return me && f != me && !(me->team > 0 && f->team == me->team);
}

static void at_kill(AtFighter *victim, AtFighter *killer, const char *why)
{
    float dealt;
    if (!victim || !victim->pawn) return;
    at_begin("kill");
    at_s("why", why);
    at_fs("victim", (FString *)(victim->ps + PS_NAME));
    at_i("vteam", victim->team);
    at_i("vpc", victim->pc);
    at_fs("killer", killer ? (FString *)(killer->ps + PS_NAME) : 0);
    dealt = ((at_damage_t)AT(AT_APPLY_DAMAGE))(victim->pawn, 100000.0f, killer ? killer->ctrl : 0,
                                               killer ? killer->pawn : 0, 0);
    at_f("dealt", dealt);
    at_end();
    T.kills_done++;
}

static void at_keep_alive(AtFighter *f)
{
    u8 *h = f && f->alive && f->pawn ? wx_live(FIELD(f->pawn, CH_HEALTH, u8 *)) : 0;
    float m;
    if (!h) return;
    m = ((fn_float)AT(R_MAX_HEALTH))(h);
    if (m > 0.0f && ((fn_float)AT(R_HEALTH))(h) < m) ((at_health_t)AT(AT_SET_HEALTH))(h, m, 0);
}

static void at_quit(const char *why)
{
    FString cmd;
    AtFighter *me = at_me();
    if (T.quit) return;
    T.quit = 1;
    at_begin("quit");
    at_s("why", why);
    at_i("frames", T.frames);
    at_end();
    cmd = at_fstring("quit");
    ((at_console_t)AT(AT_CONSOLE))(T.gm, &cmd, me ? me->ctrl : 0);
    at_free(&cmd);
}

/* Teams, alive counts and the scoreboards. */
static void at_snapshot(const char *ev, int names)
{
    AtFighter *me = at_me();
    i32 i, k, teams[MAX_TEAM * 4 + 2], alive[MAX_TEAM * 4 + 2], nteams = 0, nalive = 0, mates = 0;
    __stosb((u8 *)teams, 0, sizeof(teams));        /* not a loop: the compiler would call memset */
    __stosb((u8 *)alive, 0, sizeof(alive));
    for (i = 0; i < NF; i++) {
        k = F[i].team;
        if (k < 0 || k > MAX_TEAM * 4) k = MAX_TEAM * 4 + 1;
        if (!teams[k]++) nteams++;
        alive[k] += F[i].alive;
        nalive += F[i].alive;
        mates += at_mate(me, &F[i]);
    }
    at_begin(ev);
    at_i("fighters", NF);
    at_i("alive", nalive);
    at_i("teams", nteams);
    at_i("myteam", me ? me->team : -1);
    at_i("mates", mates);
    at_i("me_alive", me ? me->alive : 0);
    at_key("byteam");
    at_c('{');
    for (k = 0, i = 0; k < MAX_TEAM * 4 + 2; k++) {
        if (!teams[k]) continue;
        if (i++) at_c(',');
        at_c('"'); at_num(k); at_raw("\":["); at_num(teams[k]); at_c(','); at_num(alive[k]); at_c(']');
    }
    at_c('}');
    at_i("board", T.gs ? FIELD(T.gs, ATG_BOARD + 8, i32) : -1);
    at_i("sorted", T.gs ? FIELD(T.gs, ATG_SORTED + 8, i32) : -1);
    at_i("players", T.gs ? FIELD(T.gs, GS_NUM_PLAYERS, i32) : -1);
    at_i("fps", T.fps);
    if (names) {
        at_key("roster");
        at_c('[');
        for (i = 0; i < NF; i++) {
            if (i) at_c(',');
            at_c('[');
            at_wstr(((FString *)(F[i].ps + PS_NAME))->data, ((FString *)(F[i].ps + PS_NAME))->num);
            at_c(','); at_num(F[i].team); at_c(','); at_num(F[i].pc); at_c(','); at_num(F[i].alive);
            at_c(','); at_num(F[i].index);
            at_c(']');
        }
        at_c(']');
    }
    at_end();
}

/* A contestant who was alive and isn't: who killed them (the game's own
   KillerName) and the local player's kill count then. */
static void at_deaths(void)
{
    AtFighter *me = at_me();
    i32 i;
    for (i = 0; i < NF; i++) {
        AtFighter *f = &F[i];
        i32 k = f->index;
        FString who;
        if (k < 0 || k >= AT_MAX) continue;
        if (weak(&T.seen[k]) != f->ps) { weak_set(&T.seen[k], f->ps); T.dead[k] = 0; }
        if (f->alive) { T.dead[k] = 0; continue; }
        if (T.dead[k]) continue;
        T.dead[k] = 1;
        who.data = 0; who.num = who.max = 0;
        ((at_string_t)AT(AT_PS_KILLER))(f->ps, &who);
        at_begin("death");
        at_fs("name", (FString *)(f->ps + PS_NAME));
        at_i("team", f->team);
        at_i("pc", f->pc);
        at_i("mate", at_mate(me, f));
        at_fs("killer", &who);
        at_i("my_kills", me ? ((at_int_t)AT(AT_PS_KILLS))(me->ps) : -1);
        at_i("their_kills", ((at_int_t)AT(AT_PS_KILLS))(f->ps));
        at_end();
        at_free(&who);
    }
}

/* ---------------------------------------------------------------- module hooks */

/* Every HUD message the module sends (send() calls this). TMS ones every 5 s. */
static void at_message(const u16 *m, i32 n)
{
    i32 now;
    if (!T.on) return;
    now = at_ms();
    if (n > 4 && m[0] == 'T' && m[1] == 'M' && m[2] == 'S' && m[3] == '|') {
        if (T.tms_ms && now - T.tms_ms < 5000) return;
        T.tms_ms = now;
    }
    if (n > 6 && m[0] == 'S' && m[1] == 'D' && m[2] == 'R' && m[4] == 'S') {
        T.round_ms = now;
        T.round = S.round;
        T.round_logged = 0;
    }
    at_begin("hud");
    at_key("msg");
    at_wstr(m, n);
    at_i("kit", S.kit);
    at_end();
}

static void at_match_end(char ended)
{
    if (!T.on || !ended || T.ended) return;
    T.ended = 1;
    T.end_ms = at_ms();
    at_begin("end");
    at_i("wins", S.wins);
    at_i("losses", S.losses);
    at_i("round", S.round);
    at_end();
}

/* sd_gas_instigator's answer for a wound with no stock instigator. */
static void at_gas(u8 *victim, u8 *by, const char *why)
{
    static i32 last_ms;
    if (!T.on || at_ms() - last_ms < 1000) return;
    last_ms = at_ms();
    at_begin("gas");
    at_s("answer", why);
    at_key("victim"); at_hex((u64)victim);
    at_i("credited", by != 0);
    at_end();
}

/* ---------------------------------------------------------------- scenarios */
static int at_parse(u8 *gm)
{
    static const char NAMES[AT_BOTS + 1][12] = { "", "teamwin", "teamout", "solodeath", "sd", "choke", "unstick", "night",
                                                 "bots" };
    const char (*names)[12] = (const char (*)[12])wx_launder(NAMES);
    i32 len = 0, i, k;
    const u16 *v = wx_option((FString *)(gm + GM_OPTIONS), "remasterautotest", &len);
    if (!v || len <= 0 || len >= 16) return AT_NONE;
    for (i = 0; i < len; i++) T.name[i] = v[i];
    T.name[len] = 0;
    for (k = 1; k <= AT_BOTS; k++) {
        const char *n = names[k];
        for (i = 0; n[i] && i < len && wx_eq(v + i, n + i, 1); i++) ;
        if (i == len && !n[i]) return k;
    }
    return AT_NONE;
}

static AtFighter *at_first(int (*pick)(AtFighter *, AtFighter *), int alive)
{
    AtFighter *me = at_me();
    i32 i;
    for (i = 0; i < NF; i++)
        if (pick(me, &F[i]) && (!alive || F[i].alive)) return &F[i];
    return 0;
}

/* Kill up to n living rivals, the local player as killer. */
static void at_wipe(i32 n, const char *why)
{
    AtFighter *me = at_me();
    i32 i;
    for (i = 0; i < NF && n > 0; i++)
        if (at_rival(me, &F[i]) && F[i].alive) { at_kill(&F[i], me, why); n--; }
}

static void sc_teamwin(i32 el)
{
    if (el >= AT_WIPE_AT && !T.ended) at_wipe(3, "rival");
}

static void sc_teamout(i32 el, i32 now)
{
    AtFighter *me = at_me(), *rival = at_first(at_rival, 1), *mate;
    if (T.step == 0 && el >= AT_WIPE_AT && me && me->alive && rival) {
        at_snapshot("before_my_death", 0);
        at_kill(me, rival, "me");
        T.step = 1;
        T.step_ms = now;
    } else if (T.step == 1 && now - T.step_ms >= 4000) {
        mate = at_first(at_mate, 1);
        if (mate && rival) { at_kill(mate, rival, "mate"); T.step_ms = now - 2500; }
        else if (!mate) { at_snapshot("team_out", 0); T.step = 2; T.step_ms = now; }
    } else if (T.step == 2 && now - T.step_ms >= 30000) {
        at_quit("team out, result posted");
    }
}

static void sc_solodeath(i32 el, i32 now)
{
    AtFighter *me = at_me(), *rival = at_first(at_rival, 1);
    if (T.step == 0 && el >= AT_WIPE_AT) {
        at_wipe(2, "rival");
        if (T.kills_done >= 10) { T.step = 1; T.step_ms = now; }
    } else if (T.step == 1 && now - T.step_ms >= 3000 && me && rival) {
        at_snapshot("before_my_death", 0);
        at_kill(me, rival, "me");
        T.step = 2;
        T.step_ms = now;
    } else if (T.step == 2 && now - T.step_ms >= 30000) {
        at_quit("dead, result posted");
    }
}

/* Showdown: you lose round 2, win the others. Sides and kits are logged at
   each round's 3rd second. */
static void sc_sd(i32 now)
{
    AtFighter *me = at_me(), *rival = at_first(at_rival, 1);
    i32 age = now - T.round_ms, i, j;
    if (!T.round_ms || S.phase != FIGHT || T.round != S.round) return;
    if (!T.round_logged && age >= 3000 && S.placing == 0) {
        T.round_logged = 1;
        at_begin("sides");
        at_i("round", S.round);
        at_i("kit", S.kit);
        at_key("f");
        at_c('[');
        for (i = 0; i < NF; i++) {
            float p[3];
            if (i) at_c(',');
            at_where(F[i].pawn, p);
            at_c('['); at_num(F[i].team); at_c(','); at_num(F[i].pc); at_c(','); at_fnum(p[0]); at_c(',');
            at_fnum(p[1]); at_c(','); at_fnum(p[2]); at_c(']');
        }
        at_c(']');
        at_end();
        for (i = 0; i < NF; i++) {
            u8 **items;
            i32 n;
            if (!F[i].pawn) continue;
            items = FIELD(F[i].pawn, CH_INVENTORY, u8 **);
            n = FIELD(F[i].pawn, CH_INVENTORY + 8, i32);
            at_begin("kit");
            at_i("round", S.round);
            at_i("kit", S.kit);
            at_i("pc", F[i].pc);
            at_i("team", F[i].team);
            at_key("items");
            at_c('[');
            for (j = 0; j < n && j < 12; j++) {
                FString s;
                u8 *cls = items[j] ? FIELD(items[j], O_CLASS, u8 *) : 0;
                if (j) at_c(',');
                s.data = 0; s.num = s.max = 0;
                if (cls) ((at_string_t)AT(AT_FNAME_STRING))(cls + ATO_NAME, &s);
                at_wstr(s.data, s.num);
                at_free(&s);
            }
            at_c(']');
            at_end();
        }
    }
    if (age < 4000 || S.grace > 0 || !T.round_logged) return;
    if (S.round == 2) {
        if (me && me->alive && rival) {
            at_snapshot("before_my_death", 0);
            at_kill(me, rival, "me");
            T.step_ms = now;
        } else if (now - T.step_ms >= 3000) {
            AtFighter *mate = at_first(at_mate, 1);
            if (mate && rival) { at_kill(mate, rival, "mate"); T.step_ms = now - 2000; }
        }
    } else {
        at_wipe(1, "rival");
    }
}

/* Duo: three pylons started as the Chokening starts them, three rivals and
   your teammate held in their gas. */
static void sc_choke(u8 *world, i32 el, i32 now)
{
    AtFighter *me = at_me();
    i32 i, k;
    if (T.step == 0 && el >= 12 && me && me->alive) {
        PtrArray found;
        u8 *cls = ((fn_class)AT(R_CLS_PYLON))((const u16 *)AT(R_PKG_VICTORY));
        FString act, who;
        i32 nf;
        AtFighter *victims[4];
        victims[0] = victims[1] = victims[2] = victims[3] = 0;
        found.data = 0; found.num = found.max = 0;
        if (cls) ((fn_actors)AT(R_ACTORS_OF_CLASS))(T.gm, cls, &found);
        at_begin("pylons");
        at_i("found", found.num);
        at_end();
        for (i = 0, k = 0; i < found.num && k < 3; i++) {
            u8 *p = found.data[i];
            if (!p || FIELD(p, PY_STATE, u8) != PYLON_INERT || FIELD(p, A_INSTIGATOR, u8 *)) continue;
            ((fn_void)VFN(p, ATV_ON_RISING))(p);
            at_begin("rising");
            at_i("state", FIELD(p, PY_STATE, u8));
            at_pos("at", p);
            at_end();
            if (FIELD(p, PY_STATE, u8) != PYLON_RISING) continue;
            weak_set(&T.pylon[k++], p);
        }
        nf = found.num;
        if (found.data) ((fn_free)AT(R_FREE))(found.data);
        T.npylons = k;
        /* The console's own rating call after KillSwitchActivation (the module's sd_rating entry). */
        act = at_fstring("PylonUse");
        who.data = 0; who.num = who.max = 0;
        ((fn_resize)AT(R_STRING_RESIZE))(&who, ((FString *)(me->ps + PS_NAME))->num, 0);
        for (i = 0; who.data && i < ((FString *)(me->ps + PS_NAME))->num; i++) who.data[i] = ((FString *)(me->ps + PS_NAME))->data[i];
        who.num = ((FString *)(me->ps + PS_NAME))->num;
        sd_rating(me->ps, &act, &who, CHOKENING_RATING);
        at_begin("chokening");
        at_i("pylons", nf);
        at_i("started", k);
        at_i("recorded", C.n);
        at_i("my_kills", ((at_int_t)AT(AT_PS_KILLS))(me->ps));
        at_end();
        for (i = 0, k = 0; i < NF && k < 3; i++)
            if (at_rival(me, &F[i]) && F[i].alive) victims[k++] = &F[i];
        victims[3] = at_first(at_mate, 1);
        for (i = 0; i < 4; i++) {
            T.victim[i].index = -1; T.victim[i].serial = 0;
            if (victims[i]) weak_set(&T.victim[i], victims[i]->pawn);
            at_begin("victim");
            at_i("slot", i);
            at_fs("name", victims[i] ? (FString *)(victims[i]->ps + PS_NAME) : 0);
            at_i("mate", i == 3);
            at_end();
        }
        T.step = 1;
        T.step_ms = now;
    }
    if (T.step == 1) {
        /* Each victim stands by its pylon (the teammate by the first): put back every second. */
        for (i = 0; i < 4 && T.npylons; i++) {
            u8 *v = weak(&T.victim[i]), *p = weak(&T.pylon[i < 3 ? i % T.npylons : 0]);
            float at[3], rot[3], dx;
            u8 **in;
            i32 n, j;
            if (!v || !p || !((fn_bool)AT(US_CH_ALIVE))(v)) continue;
            in = FIELD(p, PY_IN_AREA, u8 **);
            n = FIELD(p, PY_IN_AREA + 8, i32);
            for (j = 0; j < n && in[j] != v; j++) ;
            if (j < n) continue;
            at_where(p, at);
            dx = i == 3 ? -120.0f : 120.0f;
            at[0] += dx; at[2] += 100.0f;
            rot[0] = rot[1] = rot[2] = 0.0f;
            ((us_teleport_t)AT(US_TELEPORT))(v, at, rot);
        }
        if (now - T.step_ms >= 75000) {
            at_snapshot("choke_done", 1);
            at_begin("choke_kills");
            at_i("my_kills", me ? ((at_int_t)AT(AT_PS_KILLS))(me->ps) : -1);
            at_i("recorded", C.n);
            at_end();
            T.step = 2;
            T.step_ms = now;
        }
    }
    if (T.step == 2 && now - T.step_ms >= 3000) at_quit("choke done");
}

/* Prison: the local pawn in the elm's fork, pushing forward. */
static void sc_unstick_second(i32 el, i32 now)
{
    AtFighter *me = at_me();
    float to[3];
    if (!me || !me->pawn) return;
    if ((T.step == 0 && el >= 22) || (T.step == 2 && now - T.step_ms >= 23000)) {
        to[0] = 12446.0f; to[1] = -27962.0f; to[2] = T.step == 0 ? 4066.0f + 230.0f : 4066.0f + 330.0f;
        at_begin("place");
        at_i("try", T.step / 2);
        at_pos("from", me->pawn);
        at_i("ok", ((at_setloc_t)AT(AT_SET_LOCATION))(me->pawn, to, 0, T.hit, 1));
        at_pos("at", me->pawn);
        at_i("moves", U.moves);
        at_end();
        T.moves0 = U.moves;
        T.step++;
        T.step_ms = now;
        return;
    }
    if (T.step == 1 || T.step == 3) {
        u8 *move = wx_live(FIELD(me->pawn, USA_MOVEMENT, u8 *));
        at_begin("stuck");
        at_i("try", T.step / 2);
        at_i("dt", now - T.step_ms);
        at_pos("at", me->pawn);
        at_i("mode", move ? FIELD(move, USM_MODE, u8) : -1);
        at_f("accel", move ? FIELD(move, USM_ACCEL, float) : 0.0f);
        at_i("stuck", U.stuck);
        at_i("moves", U.moves);
        at_end();
        if (U.moves != T.moves0) {
            at_begin("unstuck");
            at_i("try", T.step / 2);
            at_i("dt", now - T.step_ms);
            at_pos("at", me->pawn);
            at_end();
            T.step++;
            T.step_ms = now;
        } else if (now - T.step_ms >= 15000) {
            at_begin("still_stuck");
            at_i("try", T.step / 2);
            at_end();
            T.step++;
            T.step_ms = now;
        }
    }
    if (T.step == 4 && now - T.step_ms >= 3000) at_quit("unstick done");
}

/* Every bot around the player, in a ring. */
static void at_gather(AtFighter *me)
{
    float c[3], to[3], rot[3], dx = 1.0f, dy = 0.0f, nx;
    i32 i, n = 0;
    at_where(me->pawn, c);
    rot[0] = rot[1] = rot[2] = 0.0f;
    for (i = 0; i < NF; i++) {
        if (F[i].pc || !F[i].alive) continue;
        to[0] = c[0] + dx * 450.0f;
        to[1] = c[1] + dy * 450.0f;
        to[2] = c[2] + 60.0f;
        nx = dx * 0.8660254f - dy * 0.5f;         /* 30 degrees on */
        dy = dx * 0.5f + dy * 0.8660254f;
        dx = nx;
        n += ((us_teleport_t)AT(US_TELEPORT))(F[i].pawn, to, rot) != 0;
    }
    at_begin("gather");
    at_i("moved", n);
    at_end();
}

/* Each frame: every bot's weapon state, logged when it changes. */
static void at_sample_bots(i32 now)
{
    i32 i;
    for (i = 0; i < NF; i++) {
        AtFighter *f = &F[i];
        u8 *w;
        i32 s, k = f->index;
        if (f->pc || k < 0 || k >= AT_MAX) continue;
        w = f->alive ? wx_live(FIELD(f->pawn, ATW_WEAPON, u8 *)) : 0;
        s = w ? FIELD(w, ATW_STATE, i32) : -1;
        if (s == T.state[k] && (!w || weak(&T.weapon[k]) == w)) continue;
        at_begin("ws");
        at_i("bot", k);
        at_i("s", s);
        at_i("prev", T.state[k]);
        at_i("held", now - T.state_ms[k]);
        at_pos("at", f->pawn);
        if (w && weak(&T.weapon[k]) != w) { at_class_name("weapon", w); weak_set(&T.weapon[k], w); }
        at_end();
        if (w && s >= 0 && s < 32 && !(T.named_states & (1u << s))) {
            FString out, pre;
            T.named_states |= 1u << s;
            out.data = 0; out.num = out.max = 0;
            pre.data = 0; pre.num = pre.max = 0;
            ((at_debug_t)AT(AT_WEAPON_DEBUG))(w, &out, &pre);
            at_begin("state_name");
            at_i("s", s);
            at_fs("debug", &out);
            at_end();
            at_free(&out);
        }
        T.state[k] = s;
        T.state_ms[k] = now;
    }
}

static void at_second(u8 *world, i32 now)
{
    i32 el = T.gs ? FIELD(T.gs, GS_ELAPSED, i32) : 0;
    AtFighter *me = at_me();
    if (T.last_sec == 0) {
        at_begin("start");
        at_key("scenario"); at_wstr(T.name, 16);
        at_fs("url", (FString *)(T.gm + GM_OPTIONS));
        at_i("mode", FIELD(T.gm, GM_TYPE, u8));
        at_i("teamsize", team_size(T.gm, FIELD(T.gm, GM_TYPE, u8)));
        at_end();
    }
    at_deaths();
    if (el >= 6 && !T.teams_logged) {
        at_snapshot("teams", 1);
        T.teams_logged = 1;
    }
    if (T.last_sec % 5 == 0) at_snapshot("state", 0);
    if (T.ended) {
        if (now - T.end_ms >= AT_POST_END * 1000) at_quit("match over");
        return;
    }
    switch (T.scen) {
    case AT_TEAMWIN: sc_teamwin(el); break;
    case AT_TEAMOUT: sc_teamout(el, now); break;
    case AT_SOLODEATH: sc_solodeath(el, now); break;
    case AT_SD: sc_sd(now); break;
    case AT_CHOKE: sc_choke(world, el, now); break;
    case AT_UNSTICK: sc_unstick_second(el, now); break;
    case AT_NIGHT:
        if (T.last_sec % 30 == 0) {
            at_begin("weather");
            at_i("preset", W.preset);
            at_i("rain", W.rain_level);
            at_i("sheltered", W.sheltered);
            at_i("me_alive", me ? me->alive : 0);
            at_end();
        }
        if (el >= 620) at_quit("night: 10+ minutes");
        break;
    case AT_BOTS:
        if (me && me->alive && (el == 4 || el == 45 || el == 90)) at_gather(me);
        if (el >= 135) at_quit("bots sampled");
        break;
    }
    /* No scenario runs longer than 25 minutes. */
    if (now > 25 * 60 * 1000) at_quit("timeout");
}

static void at_frame(u8 *gm)
{
    u8 *gs = FIELD(gm, GM_GAMESTATE, u8 *), *world;
    i32 now;
    if (T.gm != gm || T.gs != gs) {
        i32 scen = at_parse(gm), i;
        T.gm = gm;
        T.gs = gs;
        if (T.on && !scen) T.on = 0;
        if (!scen) return;
        if (!T.on) {
            T.on = 1;
            T.scen = scen;
            T.t0 = at_now();
            T.last_sec = 0;
            T.last_ms = 0;
            T.frames = 0;
            T.ended = T.quit = T.step = T.step_ms = T.kills_done = T.teams_logged = T.round_ms = 0;
            for (i = 0; i < AT_MAX; i++) { T.state[i] = -2; T.state_ms[i] = 0; T.seen[i].index = -1; T.seen[i].serial = 0; }
        }
    }
    if (!T.on || T.quit || !gs || !(world = world_of(gm))) return;
    now = at_ms();
    T.frames++;
    at_roster(world);
    /* The local player (and in the team scenarios its teammates) can't die to
       the bots: only the scenario's own kills count. Showdown is left alone. */
    if (T.scen != AT_SD) {
        AtFighter *me = at_me();
        i32 i;
        at_keep_alive(me);
        if (T.scen == AT_TEAMWIN || T.scen == AT_TEAMOUT || T.scen == AT_SOLODEATH)
            for (i = 0; i < NF; i++)
                if (at_mate(me, &F[i])) at_keep_alive(&F[i]);
    }
    if (T.scen == AT_UNSTICK && (T.step == 1 || T.step == 3)) {
        AtFighter *me = at_me();
        float fwd[3];
        fwd[0] = 1.0f; fwd[1] = 0.0f; fwd[2] = 0.0f;
        if (me && me->pawn) ((at_move_t)VFN(me->pawn, ATV_ADD_MOVEMENT))(me->pawn, fwd, 1.0f, 1);
    }
    if (T.scen == AT_BOTS && FIELD(gs, GS_ELAPSED, i32) >= 5) at_sample_bots(now);
    if (!T.last_sec || now - (i32)T.last_ms >= 1000) {
        T.fps = T.frames;
        T.frames = 0;
        T.last_ms = (u64)now;
        at_second(world, now);
        T.last_sec++;
    }
}

void sd_gm_tick(u8 *gm, float dt)
{
    B = base();
    ((at_tick_t)AT(AT_GM_TICK))(gm, dt);
    if (gm) at_frame(gm);
}
