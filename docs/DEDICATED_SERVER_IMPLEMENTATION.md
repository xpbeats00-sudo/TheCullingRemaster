# Shared matches: the game as host (route B)

This is the plan for real multiplayer: the patched game hosts a match and other players' games join it. A matching dedicated-server build of the game doesn't exist (`REAL_MULTIPLAYER_ARCHITECTURE_AUDIT.md`), so the client is turned into the server instead.

The work lives on branch `netplay-host`, in its own exe section (`.netp`), built by `patch/build_netplay.py` from `patch/netplay.c` and applied to a copy of the stock exe by `patch/patch_netplay.py`.
- **Never shipped:** releases only run its static tests.
- **Not combined with the Remaster's module (`patch_exe.py`) yet.** Both add a 10th section at the same place, so a host exe is the stock game plus this module only.

**Status labels:**
- **PASS:** seen in the running game, with the evidence quoted.
- **FAIL:** tried in game and didn't work.
- **NOT TESTED:** never run in game.
- **BLOCKED:** can't be done until something else exists.

## Milestones

| # | Milestone | Status | Evidence |
|---|---|---|---|
| 1 | The host opens a match and listens on UDP 7777 | **PASS** (2026-11-05) | `netstat -ano`: `UDP 0.0.0.0:7777 *:* <host Victory.exe pid>`, 25 s after start. Trace: `listen-init ok=1 steam_lan=1 port=7777`. |
| 2 | A second game connects, completes the handshake and gets a player on the host | **PASS** (2026-11-05) | Host trace: `accepted state=3`, then `control type=0` (Hello), `type=5` (Login, `prelogin error_len=0`), `type=4` (Netspeed: the client got the Welcome), and 18 s later `type=9` (Join). After Join, `pc=0x1fac28ac940 pc_vtable=0x25c6dc0`: the host spawned a PlayerController for the remote player. |
| 3 | The host sends the world: the client sees the map's actors, other players and movement | NOT STARTED | Needs `ServerReplicateActors` and server NetGUID assignment, both compiled out of this exe (`SHARED_WORLD_REPLICATION_AUDIT.md`). The biggest piece: about 1,000–1,500 lines of engine code. |
| 4 | Combat and damage across players | BLOCKED on 3 | |
| 5 | Loot, containers, airdrops, gas, weather | BLOCKED on 3 | |
| 6 | Match flow and results from the host (`shared-match-backend`: allocator, tickets, server results) | BLOCKED on 3 | The backend side is built and tested against a stand-in (`PARTY_MATCHMAKING_REWORK.md`). |
| 7 | A headless host on the VPS (`-nullrhi`) | BLOCKED on 3 | |

## What the module changes (each edit checked against the stock bytes by `test_netplay.py`)

1. **The `UWorld::Listen` call.** LoadMap's call of `UWorld::Listen` (0x141644cef) goes to `np_listen`; the stock target is a `return false` stub. `np_listen` follows 4.15's Listen:
   - `CreateNamedNetDriver(world, NAME_GameNetDriver 0x11a)`;
   - `SetWorld`;
   - `world->NetDriver` (+0x38) and the DynamicSource and Static level collections;
   - `InitListen` with the world's FNetworkNotify (world+0x28).

   The game net driver is **USteamNetDriver**. Its InitListen opens a Steam (emulator) P2P socket unless the URL has `?bIsLanMatch`, and on this launch path that option doesn't reach it. So `np_listen` takes the driver's own LAN branch itself: `bIsPassthrough` (+0x438) = 1, then `UIpNetDriver::InitListen` (0x1422d9800), a plain UDP socket. In game, without this: `ok=1` but no UDP port.
2. **Three slots of UWorld's FNetworkNotify vtable** (accepting, accepted, control message): pass-through trace hooks. They only write when `CULLING_NETPLAY_TRACE` names a file.
3. **FreeForAll's PreLogin slot** (0x1425a7fe0) goes to `np_prelogin`. The game's PreLogin refuses every login with "Match is over!" while its game state says so (in game: `match_over=1` 28 s after the host started, because a local match starts at once). The test host skips that one refusal and runs only the engine's checks (`AGameModeBase::PreLogin`).
   - **For shared matches proper:** the host should hold its match in the pre-match phase until the players the backend expects have joined, and then this goes away.
4. **`UWorld::InternalGetNetMode`** (0x1416848f0) and its two inlined copies. This client build folded "has a NetDriver" into "is a client", so a hosting world would call itself a client. They now ask the driver: `UNetDriver::GetNetMode` is IsServer ? (GIsClient ? ListenServer : Dedicated) : Client. For every world a stock client has, the result is unchanged.

## How to run it

`python patch/netplay_run.py` (the test copy of the game, launched the way the launcher's PLAY does):
1. Builds the host exe.
2. Installs it into the test copy, backing up the original.
3. Starts a host with `-FuncJoin=Jungle_P?listen?bIsLanMatch?bEnableBots=true?game=...VictoryGameMode_C`.
4. Polls `netstat` for UDP 7777.
5. Starts a second client with `-FuncJoin=127.0.0.1:7777`.
6. Reads the host's trace.
7. Stops only what it started, restores the exe, and writes `netplay_run.json`.

Two notes:
- **The listen socket lives as long as the host's world.** A match that ends sends the game back to the menu, which closes the socket. That's why bots are on.
- **Both games ran on one PC.** Two PCs need the host's UDP port open (Windows firewall) and the client given the host's address.

## Known issues and risks

- **The trace shows nothing from the client's side.** The client's notify is the pending net game, not hooked. Not needed so far.
- **This build may have more folded net-mode checks** that static reading can't find. They'll show up as wrong behaviour in milestone 3 and later.
- **What the client shows after Join wasn't captured.** The games run fullscreen and the screen tool can't see them. It's expected to have no world from the host until milestone 3 exists.
