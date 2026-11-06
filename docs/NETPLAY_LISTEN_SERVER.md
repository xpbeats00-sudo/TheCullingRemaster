# Listen server in the client: inventory, prototype, plan (2026-11-05)

Route B from `docs/MULTIPLAYER_NETPLAY_FEASIBILITY.md`: rebuild the server code
that `Victory.exe` (UE 4.15.3 WindowsClient, `WITH_SERVER_CODE=0`) had compiled
out, as a native module in the client, so two players can share one match.

**Branch:** `netplay-listen` (worktree). All game addresses are from the stock
Steam `Victory.exe` (`C:\Culling\TheCulling\Victory\Binaries\Win64\Victory.exe`,
image base `0x140000000`), disassembled with capstone and bounded by `.pdata`.
No Epic source is reproduced; the engine's public structure is used only to
name what the bytes show.

## Verdict

**Still research-grade, but less blocked than route B looked, and now started.**
The feasibility doc treated route B as "~2–4 months, high risk". That estimate
stands for a *playable* shared match. But the single most load-bearing claim —
that the socket and connection-handshake layer would have to be rebuilt — is
**wrong in the client's favour**: the entire UDP socket + packet-handler +
connectionless-handshake layer is **intact** in this build. The gap is smaller
and more sharply bounded than "rebuild the server":

1. `UWorld::Listen` — orchestration only (~60 lines). **Prototyped here.**
2. `ServerReplicateActors` + its helpers — the real work (~1,000–1,500 lines).
3. One or two fill-ins in the handshake-accept and server-NetGUID paths.

The prototype in this branch reimplements piece 1 and wires it in, verified
statically against the stock bytes. It is **not** runtime-proven: a second game
instance could not be launched this session (the user's own `Victory.exe` was
running, PID 26372 — not started here — so per the safety rule only static work
was done), and driver *creation* needs one engine symbol a debugger must pin
first (milestone 1). Honest status: **handshake not yet observed in game.**

## Phase 1 — inventory

RVA = VA − `0x140000000`. "Intact" = shared client/server code that survived;
"absent" = compiled out (`WITH_SERVER_CODE 0`); "partial/verify" = present but
its server-only branch needs a debugger to confirm.

| Piece | Status | Evidence (address) | Reimpl. est. |
|---|---|---|---|
| UDP socket bind (`UIpNetDriver::InitBase`) | **intact** | `0x1422d8e10` (vtable +0x210): `UNetDriver::InitBase 0x141433610`, then CreateSocket (driver vtable +0x2e0), socket subsystem (+0x330), bind, store | 0 |
| `UIpNetDriver::InitListen` | **intact** | `0x1422d9800` (vtable +0x220): calls InitBase, then `InitConnectionlessHandler`, then reads bound port into LocalAddr+0x20 | 0 |
| Connectionless handshake setup (`InitConnectionlessHandler`) | **intact** | `0x141433980` (vtable +0x228): allocates a 0x1f0-byte `PacketHandler` at driver+0x88 (the `StatelessConnectHandlerComponent` lives here) | 0 |
| Packet receive (`UIpNetDriver::TickDispatch`) | **intact** | `0x1422e5700` (vtable +0x270): large, reads datagrams via CreateSocket slot | 0 |
| Net-mode resolution | **intact & correct** | `UWorld::GetNetMode 0x1416848f0` → helper `0x1414318f0`: `IsServer()` (ServerConnection==NULL) && `GIsClient`(`0x1430f55e8`)==1 ⇒ returns **2 = NM_ListenServer**. UWorld.NetDriver at **+0xb8** | 0 |
| Engine/world plumbing | **intact** | `GEngine 0x143307b48`; `GetWorldContextFromWorld 0x14163d220` (WorldList at engine+0xb98 / count +0xba0; WorldContext.World at +0x298; `ActiveNetDrivers` at WC+0x248 ptr / +0x250 num, 0x10-byte `{UNetDriver*, FName}` entries) | 0 |
| `UObject::ProcessEvent` / `ProcessRemoteFunction` | **intact** | shared; the client already sends and executes RPCs both ways | 0 |
| `FRepLayout` / `FObjectReplicator` **receive** side | **intact** | the client already applies replicated properties from a server | 0 |
| `UActorChannel::ReplicateActor` (send) | **intact** | present (the demo/replay recorder uses it); `ReplicateActor` strings at `0x1429ccfc0` | 0 |
| Client join half | **intact** | `ConnectToServer 0x1401dce90` (`open %s?Nonce=%s`); connect-path strings referenced: `PendingLevel 0x141c8219b`, `StatelessConnect 0x141448875`, `PacketHandler 0x141084247`, `Welcome 0x1403ca0a3` | 0 |
| Game-mode login (`AShooterGame_FreeForAll::PreLogin`, `InitNewPlayer`, hacker-warning) | **intact (game code)** | strings present (`0x1425a7350` etc.); standalone already runs `PostLogin`. Bodies not individually single-stepped | small |
| `UWorld::Listen` | **absent → prototyped** | LoadMap's call at `0x141644cef` targets the shared `xor al,al; ret` stub `0x14143e6f0` (109 callers). Reimplemented in `patch/netplay.c` | ~60 |
| `ServerReplicateActors` + `BuildConsiderList` / `PrioritizeActors` / `ProcessPrioritizedActors` | **absent** | `UNetDriver::TickFlush 0x14143f2b0` drops the `IsServer()` result and resets counters — the replicate block is empty; strings `ServerReplicateActors`, `replicated %d actors` **absent** | ~1,000–1,500 |
| `FNetGUIDCache::AssignNewNetGUID_Server` | **absent** | string `AssignNewNetGUID` **absent**; server-side GUID assignment stripped (client-side cache intact) | ~80 |
| Handshake **accept** (server side of `ProcessConnectionlessPacket` → create `UNetConnection`, `NotifyAcceptingConnection`/`NotifyAcceptedConnection`, add to `ClientConnections`) | **partial / verify** | client cases of `NotifyControlMessage` present (Welcome/Challenge); the server-accept branch sits inside the large `TickDispatch`/`ProcessConnectionlessPacket` and needs a debugger to confirm it survived | 0–~150 |
| `UWorld::NotifyControlMessage` server cases (Hello/Login/Join/Netspeed/challenge) | **partial / verify** | handshake format strings exist but are unreferenced (logging stripped); whether the switch arms survived needs a run | 0–~120 |
| Driver creation (`UEngine::CreateNamedNetDriver` / `CreateNetDriver_Local`) | **present, not pinned** | the client makes a `PendingNetDriver` on connect, so the code exists; exact entry not yet isolated — **milestone 1** | 0 (reuse) |

**Net:** of the engine pieces a listen server needs, almost everything *below*
`UWorld::Listen` (sockets, packet handler, connectionless handshake, net-mode,
RPC, receive-side replication) is present. What is genuinely gone is the
**send-side replication loop** (`ServerReplicateActors` family) and the
**Listen orchestration**; a few accept-path arms are "verify in a debugger".

## Phase 2 — prototype (this branch)

Files, all new, none touching `patch/showdown_rounds.c` or `patch/patch_exe.py`:

- **`patch/netplay.c`** — the module. One entry, `np_listen(world, url)`,
  reimplementing the reachable part of `UWorld::Listen`: return true if the
  world already has a driver (UWorld+0xb8); else find this world's
  `GameNetDriver` via `GEngine → GetWorldContextFromWorld → ActiveNetDrivers`;
  bind it and call `InitListen` through the driver's own vtable slot +0x220
  (so the `UIpNetDriver`/`USteamNetDriver` override runs and the UDP socket is
  bound); on success store it at UWorld+0xb8 so net mode becomes
  `NM_ListenServer`. Driver *creation* (when none exists yet) is isolated
  behind `NP_HAVE_CREATE_NET_DRIVER` (default 0) so the blob never jumps to an
  unverified address — until milestone 1 the module behaves exactly like the
  stock stub (returns false), making the patch safe to ship and run now.
- **`patch/build_netplay.py`** — compiles `netplay.c` with MSVC (no CRT) and
  links it position-independent into `patch/netplay_blob.py` (312 bytes), the
  same way `build_showdown_rounds.py` builds the Showdown module. Any
  non-`REL32` relocation is rejected, so a successful build proves the blob
  needs no base relocations.
- **`patch/patch_netplay.py`** — applies to a copy of the stock exe: appends a
  `.netp` section (RVA `0x35b4000`) with the blob and repoints LoadMap's Listen
  call (file offset `0x16442ef`) from the stub to `np_listen`. Byte-checked and
  idempotent; the stock exe is never written.
- **`patch/test_netplay.py`** — static tests (stand-in + the real stock exe).

Standalone and separate from the Showdown module so it can be reviewed and
merged independently; because both append a 10th section at the stock
`SizeOfImage`, they are mutually exclusive on one file for now (the merge folds
`np_listen` into the `.sdround` module — see the plan).

### Evidence (reproducible)

```
$ python patch/test_netplay.py C:\Culling\TheCulling\Victory\Binaries\Win64\Victory.exe
blob: pass (312 bytes, position independent, up to date)
stand-in: pass
real exe: pass (Listen call e8fc99dfff -> stub 0x14143e6f0 confirmed; patched copy verified)
OK
```

The hook flips fact 1 of `netplay_check.py` on a patched copy — before:
`listen_stubbed yes … 0x141644cef -> 0x14143e6f0 = 32c0c3`; after, that call
targets `0x1435b40a4` (= base + `.netp` RVA + `np_listen`), i.e. `netplay_check`
can no longer resolve it inside `.text`, which is the proof the call now enters
the new module. The linked `np_listen` disassembles to exactly the intended
sequence: `cmp [world+0xb8],0` → `call find_game_net_driver` → `call [driver_vtable+0x220]`
with a zeroed out-`FString` → store driver at `world+0xb8`.

**Not verified:** the handshake completing in game. Reasons: (1) no second
instance could be launched (user's `Victory.exe` running); (2) with
`NP_HAVE_CREATE_NET_DRIVER=0` a world with no pre-made `GameNetDriver` returns
false, so a run today would look like the stock stub. Milestone 1 removes both.

## Milestone plan to a shared match

| # | Milestone | What it needs | Effort | Risk |
|---|---|---|---|---|
| 1 | **Socket opens on 7777** | Debugger-pin `CreateNamedNetDriver` (+ `NAME_GameNetDriver` FName), set `NP_HAVE_CREATE_NET_DRIVER=1`; start a game with `?listen`; confirm UDP 7777 bound and `GetNetMode==NM_ListenServer` | 3–5 days | low — all primitives confirmed |
| 2 | **One client completes the handshake** | Verify/fill the server-accept arm (`ProcessConnectionlessPacket` → `UNetConnection` → `NotifyAccepting/AcceptedConnection`) and `NotifyControlMessage` Hello/Login/Join; serve matching nonces from `server/`; joining client logs in, `PreLogin`/`PostLogin` run, pawn spawned/possessed (no replication yet) | 2–4 weeks | medium — some arms "verify"; game-mode login may need glue |
| 3 | **Movement replicates** | Reimplement `ServerReplicateActors` + consider-list/priority/channel open-close for the local player's pawn only; server-side `AssignNewNetGUID_Server`; the two players see each other move | 4–8 weeks | **high** — the ~1,000-line core, undocumented 4.15 struct layouts |
| 4 | **Combat / damage** | Extend replication to weapons, health, hit RPCs; server authority for damage; the Chokening/loot already work by game code | 2–4 weeks | medium |
| 5 | **Match flow & end** | Replicate match state, scoreboard, victory; reuse the existing game-mode end paths | 1–2 weeks | medium |
| 6 | **24 players + bots, VPS headless** | Scale replication (relevancy/bandwidth), headless `-nullrhi -nosound` host on the VPS, firewall UDP; `server/` hands each party one `gameServer` + per-player nonces + team | 2–4 weeks | medium |
| — | **Merge** | Fold `np_listen` into the `.sdround` module (one section, one build) once milestone 2 is stable | 1–2 days | low |

Total to a playable 2-player match (milestones 1–5): roughly **3–4 months**,
dominated by milestone 3 — consistent with the feasibility doc, now with the
scope pinned to the replication send loop rather than "the server".

## Risks

- **Milestone 3 is the project.** `ServerReplicateActors` against unknown 4.15
  struct offsets, debugged live on two machines, is where months go and where
  it can stall. Everything before it is days-to-weeks and low/medium risk.
- **Listen vs dedicated.** `GIsClient==1` forces `NM_ListenServer`; Victory game
  code expects `NM_DedicatedServer` in places (`InitNewPlayer !NM_DedicatedServer`).
  A headless listen host still has a local player that "living humans" rules
  count (cf. `patch_exe.py` fix 7's net-mode handling). Workable, needs care.
- **Nonce/auth protocol** between client and `server/` is still un-RE'd
  (`?servernonce`, `ClientCheckServerNonce`); milestone 2 includes it.
- **Route A still dominates.** If a matching `VictoryServer` build can be
  obtained (Func maintainers / rights holder), it is ~1–3 weeks vs ~3–4 months.
  Route B is the code-only path when A is unavailable.

## Tests

`python patch/test_netplay.py [Victory.exe]` — blob is position-independent and
up to date; the patch applies to a stand-in and to a copy of the real exe,
re-derives the Listen call → stub (`0x14143e6f0`, `xor al,al; ret`) from the
stock bytes, checks the hook rel32 and the section bytes, and is idempotent.
`python patch/build_netplay.py --check` — the blob matches `netplay.c`.
