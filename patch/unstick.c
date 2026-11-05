/* Stuck players: a once-a-second safety net for the local player. Part of
 * the native module: showdown_rounds.c includes this file and calls
 * unstick_tick(gm) once a second from sd_should_end (the GameMode's "should
 * the match end" check, AShooterGame_FreeForAll vtable slot 282, which
 * AShooterGameMode::Tick calls while the match is InProgress, in every
 * FreeForAll mode: Solo, Duo, Trios, Quads, Showdown). No new hook.
 *
 * The stock trap (make_tree_collision.py has the evidence): American
 * Elm's trunk collision is three thin capsules that stop about 2 m up, where
 * the visible trunk forks, and the mesh marks them WalkableSlope_Unwalkable.
 * A player whose capsule gets over their tops stands inside the tree on a
 * floor the CharacterMovementComponent refuses: it stays Falling (no jump
 * from Falling, air control into a surface is cut), so it can't get out.
 * make_tree_collision.py takes the trap away; this catches any other spot
 * like it (or the player inside geometry) without knowing where it is.
 *
 * Stuck means UNSTICK_TICKS ticks of all of these (a still, pushing tick that
 * is Walking on nothing blocking neither counts nor resets: on a perch it
 * can't stand on the movement component flips between Falling and Walking):
 *   - the local player's pawn (the first player controller's) is a live
 *     AShooterCharacter that is alive (its IsAlive and the game state's
 *     record), its player state not a spectator and not left;
 *   - the match has been InProgress UNSTICK_AFTER seconds (never in the pods);
 *   - the player is pushing a direction (CharacterMovement Acceleration);
 *   - the pawn moved less than UNSTICK_STILL units since the tick before;
 *   - not using or crafting (AShooterCharacter +0xd80 bits 0-1);
 *   - the movement mode is Falling (a pawn can't hang in the air for 2 s:
 *     it is perched on something it can't stand on), or Walking with its
 *     capsule (UNSTICK_SKIN smaller all round) overlapping a component that
 *     blocks pawns (it is inside geometry). Walking into a wall is neither:
 *     the movement component stops the capsule short of the wall. Ladders,
 *     swimming and the game's custom modes are neither too.
 * Then the pawn goes to the first free spot of: where it last walked and
 * moved (the last UNSTICK_HISTORY such spots, newest first, at most
 * UNSTICK_BACK away: where it came from, so never through a wall it wasn't
 * on this side of), else a ring around it (UNSTICK_RING1/2
 * out, level and UNSTICK_LIFT up). Free = a capsule overlap (the pawn's
 * size, UNSTICK_FLOOR smaller for the floor gap) finds nothing that blocks
 * pawns (world geometry and other pawns). The move is AActor::K2_TeleportTo:
 * the engine's own teleport, which checks the spot again (encroachment) and
 * lets the movement component find its floor (TeleportSucceeded). Once per
 * UNSTICK_COOLDOWN seconds; the HUD says so. ?Unstick=0 turns it off.
 *
 * No object pointer is kept from one tick to the next: the pawn is a weak
 * pointer, every object is checked live (wx_live) before it is used, and
 * the positions are plain floats.
 */

/* ---------------------------------------------------------------- the game */
#define US_TELEPORT      0x111fae0 /* AActor::K2_TeleportTo(actor, const FVector *, const FRotator *) -> bool */
#define US_OVERLAP       0x13a7c30 /* UKismetSystemLibrary::CapsuleOverlapComponents(ctx, &pos, radius, half height,
                                      &object types, class filter, &ignore, &out components) -> bool */
#define USV_RESPONSE     0x468     /* UPrimitiveComponent::GetCollisionResponseToChannel (vtable offset) */
#define US_CH_ALIVE      0x26e0d0  /* AShooterCharacter::IsAlive */
#define USA_MOVEMENT     0x468     /* ACharacter::CharacterMovement */
#define USA_CAPSULE      0x470     /* ACharacter::CapsuleComponent (the root) */
#define USC_HALF_HEIGHT  0x728     /* UCapsuleComponent::CapsuleHalfHeight */
#define USC_RADIUS       0x72c     /* UCapsuleComponent::CapsuleRadius */
#define USC_ROTATION     0x1ec     /* USceneComponent::RelativeRotation (the root's: its world rotation) */
#define USM_MODE         0x1a8     /* UCharacterMovementComponent::MovementMode (EMovementMode) */
#define USM_ACCEL        0x280     /* UCharacterMovementComponent::Acceleration (the input's) */
#define USH_USING        0xd80     /* AShooterCharacter: bit 0 IsUsing, bit 1 IsUsingRecycler */

#define US_WALKING       1         /* EMovementMode */
#define US_FALLING       3
#define US_WORLD_STATIC  0         /* EObjectTypeQuery: ObjectTypeQuery1.. = WorldStatic, WorldDynamic, Pawn */
#define US_WORLD_DYNAMIC 1
#define US_PAWN_OBJECTS  2
#define US_PAWN_CHANNEL  2         /* ECollisionChannel ECC_Pawn */
#define US_BLOCK         2         /* ECollisionResponse ECR_Block */

#define UNSTICK_AFTER    20        /* seconds InProgress before it may act (the pods) */
#define UNSTICK_TICKS    2         /* stuck ticks (of one still spell) before it acts */
#define UNSTICK_STILL    10.0f     /* moved less than this in a second: not moving (walking is 400 a second) */
#define UNSTICK_GOOD     20.0f     /* walked at least this far in a second: a good spot */
#define UNSTICK_BACK     800.0f    /* a good spot is used only this close */
#define UNSTICK_HISTORY  4         /* good spots kept */
#define UNSTICK_SKIN     4.0f      /* inside geometry: the capsule this much smaller still overlaps */
#define UNSTICK_FLOOR    1.0f      /* a free spot: the capsule this much smaller (the walking floor gap) */
#define UNSTICK_RING1    60.0f
#define UNSTICK_RING2    110.0f    /* > the pawn's diameter: off a tree's trunk top */
#define UNSTICK_LIFT     40.0f
#define UNSTICK_COOLDOWN 20        /* seconds after a move before the next */

/* Through a pointer the compiler can't see through (weather.c's wx_launder):
 * a static array indexed by a variable is otherwise addressed from
 * __ImageBase, which the position-independent blob doesn't have. */
#define US_GOOD(i)       (((float (*)[3])wx_launder(U.good))[i])

typedef char (*us_teleport_t)(u8 *, const float *, const float *);
typedef char (*us_overlap_t)(u8 *, const float *, float, float, const void *, u8 *, const void *, void *);
typedef u8 (*us_response_t)(u8 *, u8);

static struct {
    u8 *gm;                        /* compared, never read */
    i32 last_elapsed;
    Weak pawn;
    float last[3], good[UNSTICK_HISTORY][3];
    i32 have_last, ngood, newest;
    i32 stuck, next_ok, moves;
} U;

static float us_dist2(const float *a, const float *b)
{
    float x = a[0] - b[0], y = a[1] - b[1], z = a[2] - b[2];
    return x * x + y * y + z * z;
}

/* Is a component of these object types that blocks pawns in the capsule at pos? */
static int us_blocked(u8 *pawn, const float *pos, float radius, float half, int pawns)
{
    u8 types[3], *ignore[1];
    struct { u8 *data; i32 num, max; } t;
    struct { u8 **data; i32 num, max; } ig;
    PtrArray out;
    i32 i;
    int hit = 0;
    types[0] = US_WORLD_STATIC;
    types[1] = US_WORLD_DYNAMIC;
    types[2] = US_PAWN_OBJECTS;
    t.data = types;
    t.num = t.max = pawns ? 3 : 2;
    ignore[0] = pawn;
    ig.data = ignore;
    ig.num = ig.max = 1;
    out.data = 0;
    out.num = out.max = 0;
    if (radius < 1.0f || half < radius) return 1;
    ((us_overlap_t)AT(US_OVERLAP))(pawn, pos, radius, half, &t, 0, &ig, &out);
    for (i = 0; i < out.num && !hit; i++) {
        u8 *c = wx_live(out.data[i]);
        if (c && ((us_response_t)VFN(c, USV_RESPONSE))(c, US_PAWN_CHANNEL) == US_BLOCK) hit = 1;
    }
    if (out.data) ((fn_free)AT(R_FREE))(out.data);
    return hit;
}

/* Move the pawn to the first free spot; 1 if it moved. */
static int us_move(u8 *pawn, u8 *root, const float *at, float radius, float half)
{
    float rot[3], to[3], dx = 1.0f, dy = 0.0f, nx;
    i32 ring, lift, k;
    rot[0] = FIELD(root, USC_ROTATION, float);
    rot[1] = FIELD(root, USC_ROTATION + 4, float);
    rot[2] = FIELD(root, USC_ROTATION + 8, float);
    for (k = 0; k < U.ngood; k++) {                    /* newest first */
        float *g = US_GOOD((U.newest - k + UNSTICK_HISTORY) % UNSTICK_HISTORY);
        if (us_dist2(g, at) <= UNSTICK_BACK * UNSTICK_BACK
            && !us_blocked(pawn, g, radius - UNSTICK_FLOOR, half - UNSTICK_FLOOR, 1)
            && ((us_teleport_t)AT(US_TELEPORT))(pawn, g, rot))
            return 1;
    }
    for (lift = 0; lift < 2; lift++)
        for (ring = 0; ring < 2; ring++)
            for (k = 0; k < 8; k++) {
                float r = ring ? UNSTICK_RING2 : UNSTICK_RING1;
                to[0] = at[0] + dx * r;
                to[1] = at[1] + dy * r;
                to[2] = at[2] + (lift ? UNSTICK_LIFT : 0.0f);
                nx = (dx - dy) * 0.70710678f;          /* the next of 8 directions, 45 degrees on */
                dy = (dx + dy) * 0.70710678f;
                dx = nx;
                if (!us_blocked(pawn, to, radius - UNSTICK_FLOOR, half - UNSTICK_FLOOR, 1)
                    && ((us_teleport_t)AT(US_TELEPORT))(pawn, to, rot))
                    return 1;
            }
    return 0;
}

static void unstick_tick(u8 *gm)
{
    u8 *gs, *world, *list, *pc = 0, *pawn = 0, *ps, *root, *move;
    float at[3], ax, ay, az, radius, half, moved2;
    i32 i, num, elapsed, mode, still, n;
    if (!gm || !(gs = FIELD(gm, GM_GAMESTATE, u8 *))) return;
    elapsed = FIELD(gs, GS_ELAPSED, i32);
    if (U.gm != gm || elapsed < U.last_elapsed) {      /* a new match */
        U.gm = gm;
        U.pawn.index = -1;
        U.pawn.serial = 0;
        U.have_last = U.ngood = U.stuck = U.next_ok = U.moves = 0;
    }
    U.last_elapsed = elapsed;
    if (url_flag(gm, "unstick=0") || !(world = world_of(gm))) return;
    list = world + W_CONTROLLERS;
    num = FIELD(list, 8, i32);
    for (i = 0; i < num && !pc; i++) {
        u8 *c = weak_get(list, i);
        if (c && is_a(c, R_CLS_PC)) pc = c;
    }
    if (pc) pawn = wx_live(FIELD(pc, C_PAWN, u8 *));
    if (pawn && pawn != weak(&U.pawn)) {               /* a new pawn (respawn, the next round) */
        weak_set(&U.pawn, pawn);
        U.have_last = U.ngood = U.stuck = 0;
    }
    ps = pc ? FIELD(pc, C_PLAYERSTATE, u8 *) : 0;
    root = pawn ? wx_live(FIELD(pawn, WXA_ROOT, u8 *)) : 0;
    move = pawn ? wx_live(FIELD(pawn, USA_MOVEMENT, u8 *)) : 0;
    if (!pawn || !root || !move || root != FIELD(pawn, USA_CAPSULE, u8 *) || !is_a(pawn, R_CLS_CHARACTER)
        || !is_a(ps, R_CLS_PS) || (FIELD(ps, PS_FLAGS, u32) & 3) || ((fn_bool)AT(R_PS_HAS_LEFT))(ps)
        || !((fn_bool)AT(R_PS_IS_ALIVE))(ps) || !((fn_bool)AT(US_CH_ALIVE))(pawn)) {
        U.have_last = U.stuck = 0;                     /* dead, spectating, between pawns: nothing */
        return;
    }
    at[0] = FIELD(root, WXC_LOCATION, float);
    at[1] = FIELD(root, WXC_LOCATION + 4, float);
    at[2] = FIELD(root, WXC_LOCATION + 8, float);
    moved2 = U.have_last ? us_dist2(at, U.last) : 1e12f;
    U.last[0] = at[0]; U.last[1] = at[1]; U.last[2] = at[2];
    U.have_last = 1;
    mode = FIELD(move, USM_MODE, u8);
    if (mode == US_WALKING && moved2 >= UNSTICK_GOOD * UNSTICK_GOOD) {   /* walking somewhere: a good spot */
        U.newest = (U.newest + 1) % UNSTICK_HISTORY;
        US_GOOD(U.newest)[0] = at[0]; US_GOOD(U.newest)[1] = at[1]; US_GOOD(U.newest)[2] = at[2];
        if (U.ngood < UNSTICK_HISTORY) U.ngood++;
    }
    ax = FIELD(move, USM_ACCEL, float);
    ay = FIELD(move, USM_ACCEL + 4, float);
    az = FIELD(move, USM_ACCEL + 8, float);
    radius = FIELD(root, USC_RADIUS, float);
    half = FIELD(root, USC_HALF_HEIGHT, float);
    still = elapsed >= UNSTICK_AFTER && ax * ax + ay * ay + az * az > 1.0f
        && moved2 < UNSTICK_STILL * UNSTICK_STILL && !(FIELD(pawn, USH_USING, u8) & 3)
        && radius > 5.0f && radius < 200.0f && half >= radius && half < 400.0f
        && (mode == US_FALLING || mode == US_WALKING);
    if (!still) U.stuck = 0;
    else if (mode == US_FALLING || us_blocked(pawn, at, radius - UNSTICK_SKIN, half - UNSTICK_SKIN, 0)) U.stuck++;
    if (U.stuck < UNSTICK_TICKS || elapsed < U.next_ok) return;
    U.stuck = 0;                                       /* one try per stuck spell */
    if (!us_move(pawn, root, at, radius, half)) return;
    U.next_ok = elapsed + UNSTICK_COOLDOWN;
    U.moves++;
    U.last[0] = FIELD(root, WXC_LOCATION, float);
    U.last[1] = FIELD(root, WXC_LOCATION + 4, float);
    U.last[2] = FIELD(root, WXC_LOCATION + 8, float);
    n = 0;
    put_str(&n, "You were stuck: moved to a free spot");
    put(&n, 0);
    send(pc, n);
}

/* For the tests (test_unstick_native.py): what the safety net has done. */
void sd_unstick_probe(i32 *out)
{
    out[0] = U.moves;
    out[1] = U.stuck;
    out[2] = U.next_ok;
    out[3] = U.ngood;
}
