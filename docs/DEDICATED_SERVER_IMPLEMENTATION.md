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
| 3 | The host sends the world: the client sees the map's actors, other players and movement | **PARTIAL: the core PASSES** (2026-11-06) | Host trace: 36 actors replicated per pass to the joined client for 60 s; both games alive at the end. Client trace: 36 actor channels, its own PlayerController and **its own pawn, in a pod** at (12885, -17323, 573), which is the SpawnsDecentral-teamA_0 start. A screenshot shows the pod view with the match timer. **13 of 17 pawns moved on the client over 62 s**, e.g. (16712, 4950, 311) to (13120, 13889, 1213). **The client moves its own pawn and the host follows** (2026-11-06): with CULLING_NETPLAY_MOVE=1 the client pushes its pawn (AddMovementInput, alternating every 3 s). Over 28 s the host's position of that pawn stays within a few units of the client's at every sample, e.g. client (1041, -1585) vs host (977, -1564), and client (-556, -848) vs host (-659, -853), so the client's movement updates are processed and accepted by the host. **Weapons and inventory work** (2026-11-06). Each character's inventory weapons and current weapon are sent, before the character so its references resolve. The client goes from 36 to 71 channels, and on the client 29 of 30 pawn samples hold a weapon. The joined player's 5 inventory slots start empty on both host and client. After the host gives it a bot's weapon class mid-match (CULLING_NETPLAY_GIVE=1, SpawnWeapon), slot 0 fills on the host (channel open, SimulatedProxy, owned by the player's pawn) and on the client, and the client's CurrentWeapon switches to it. Sent before the weapon, the slot had stayed null on the client. **Loot and world objects replicate** (2026-11-06). Every 2 s the host gathers every actor in its world that replicates (GetAllActorsOfClass with the base Actor class, kept as weak pointers) and sends them too: about 6,700 objects, 5,393 of them loot (unowned AShooterWeapon actors). A client can't spawn loot, yet its loot count climbed with its channels: 388, 1,480, 2,884, 4,273, then 5,133 of 5,393 (95%) after about 78 s at 16 new channels per pass, limited by the connection (IsNetReady). Not verified one by one: crates opening, doors, gas pylons and airdrops (they're among the objects sent, but no test changes them yet). **Distance limits work** (2026-11-06). For each joined player, every world object goes through the engine's own AActor::IsNetRelevantFor (vtable +0x400; the game's code at 0x140209e10 calls it the same way), from the player's view target. A channel to an object that isn't relevant is closed once the object is beyond 1.25x its NetCullDistanceSquared (+0x12c). In game: of about 6,670 world objects, about 830 to 890 are relevant at a time. The client settles in about 12 s with about 850 objects (450 loot), where it used to take about 80 s for everything, and the connection stops saturating once synced. When the host teleports the joined player across the island (CULLING_NETPLAY_TELEPORT=1), the relevant set follows (893, then 683, then about 645). On the client, channels and loot go from 905/457 to 685/295 as the far objects close, then 698/306 as the new neighbourhood arrives. GetPlayerViewPoint gave a fixed point for the remote player on the host (its camera isn't updated there), so the view target's location is used. **Two joined players work** (2026-11-06). With `netplay_run.py --clients 2`, three games run on this PC. Both clients join, each gets its own controller and pawn, the host sends to both (about 1,750 replications a pass, not saturated), and all three stay up. Measured on one clock: the three games' trace times come from the same Windows tick counter, and the host's positions are interpolated at each client sample time. Over about 40 s of both walking, plus a host teleport of both into the arena:
  - each client's own prediction is mostly within 0-280 units of the host;
  - **each client's view of the other player is within 0-370 units of the host's position** (2-117 and 0-370), and follows the teleport.
The spikes are only the teleport instant. Fixed on the way:
  - **ReplicationFrame:** the engine's ServerReplicateActors starts with `ReplicationFrame++` (UNetDriver +0x280; the replay recorder increments it at 0x14130541f). Property comparisons are shared between connections per frame, so without it the first pass's comparison was reused. The other player's pawn reached each client once, and its ReplicatedMovement there never changed (the client only extrapolated, and was 64,000 units off after the teleport).
  - **Movement corrections:** `APlayerController::SendClientAdjustment`, which the engine's loop does first for each connection. `UCharacterMovementComponent::SendClientAdjustment` survives at 0x14124a7d0 and is called on the pawn's movement interface (component +0x180) when the client has acknowledged its pawn (+0x478) and the pawn is its autonomous proxy. Without it a teleport on the host was undone by the client's moves.
  - **Autonomous to simulated:** a player's pawn goes to every other connection as a simulated proxy (the client's copy has Role 1). Owner means the connection whose PlayerController's Pawn it is; the Owner chain alone also downgraded the owner's own pawn, and the clients lost control.
  - **No double-sending:** pawns, controllers and pawn-owned weapons are no longer also in the world list, where the distance check closed their channels.
Players who join after the pods opened stand in pods that never open; in a real shared match everyone joins before the start. Not yet tested one by one: crates, doors, gas and airdrops. |
| 4 | Combat and damage across players | **PARTIAL: players fight each other from their own games** (2026-11-06) | **Damage the host applies reaches every game.** With CULLING_NETPLAY_DAMAGE=1 the host deals the second player 25 damage every 3 s (ApplyDamage). Its health reads 75, 50, 25, 0 on the host, on the victim's own client and on the other client. At death the victim's own game switches to a spectator pawn and all three games stay up. **A player's attack, pressed in their own game, hurts the other player.** With CULLING_NETPLAY_ATTACK=1 each client faces the other player every 2 s and presses primary attack for 300 ms. It goes through the functions the attack button drives, `AShooterCharacter::OnStartPrimary` (0x140272f60) and `OnStopPrimary` (0x1402743d0): the client runs its weapon, sends ServerStartInput/ServerStopInput, finds the hit and sends ServerNotifyHit. In game both players' health fell on the host about 8 per swing, in step with the swings (100, 92, 77, ... 7 and 6), until player 2 died. **Control run** (CULLING_NETPLAY_ATTACK_ONE_SIDE=1, only player 1 swings): player 2 went 100, 92, 76, 69, 53 while player 1 stayed at 100, so the damage comes from the attacker's game. A bot then walked in and finished player 2. All three games were alive at the end of every run. **Kill credit and the scoreboard work** (2026-11-06). The host's match keeps one 0x150-byte record per player (AVictoryGameState +0x468: player state +0x10, alive +0x28, death order +0x5c, killer name +0x60, Victims +0xe0, Killers +0xf8). It finds a record by the player's Steam ID. The scoreboard's replicated copy is ScoreboardData (+0x498, 0xb0-byte entries: name +0x00, Kills +0x24, alive +0x28, KilledBy +0x30, death order +0x64). In the one-sided attack run with `netplay_run.py --distinct-ids` (each game gets its own test Steam ID and name):
  - **host records:** NetPlayerOne has 1 victim; NetPlayerTwo is dead with death order 2;
  - **scoreboard, identical on the host and both clients:** 18 entries; NetPlayerOne 1 kill; NetPlayerTwo dead, death order 2, killed by NetPlayerOne. Player One's copy changed 0.4 s after the host's.

  **Without distinct IDs it fails, and real players aren't affected.** All the games on one PC share one Steam ID, so the host credited the kill and the death to the first record with that ID (another player's) and left both players' own records untouched. Real players each have their own ID. The scoreboard screen itself wasn't looked at, only its data. The host's own local player (NetHost) is in the match and on the scoreboard; a headless host (milestone 7) won't have one.

  Not yet tested: ranged weapons, blocking and shoves, the kill feed and death screen, the end-of-match results, and a real player's mouse and keyboard. Calling only the weapon's `ServerStartPrimaryInput` RPC (0x14030e590) does nothing visible: on the host it only refreshes the weapon's speed values. |
| 5 | Loot, containers, airdrops, gas, weather | BLOCKED on 3 | |
| 6 | Match flow and results from the host (`shared-match-backend`: allocator, tickets, server results) | BLOCKED on 3 | The backend side is built and tested against a stand-in (`PARTY_MATCHMAKING_REWORK.md`). |
| 7 | A headless host on the VPS (`-nullrhi`) | BLOCKED on 3 | |

## Milestone 3: how the host sends its world

The engine's send loop (`UNetDriver::ServerReplicateActors`) was compiled out, but everything under it survives, because the replay recorder uses it: channel creation, `SetChannelActor`, `ReplicateActor`, server NetGUID assignment in the package map, and closing a destroyed actor's channel. `np_tick_flush` replaces the Steam driver's TickFlush slot. On the host's listen driver it runs a minimal loop, modelled on `UDemoNetDriver::ReplicateActor` (0x1412ee2e0), before the stock TickFlush:

- **What it sends:** the game state, its player states, every controller and every pawn. Each joined connection gets its own PlayerController first.
- **Per actor and connection:**
  - skip anything that doesn't replicate, owner-only actors of other players, and map actors whose level the client hasn't loaded;
  - find the channel in the connection's `ActorChannels` map, or open one;
  - then `ReplicateActor`.
- **Limits:**
  - **Readiness:** a connection that isn't ready (`IsNetReady`, vtable +0x268) is skipped, as the engine does.
  - **New channels:** at most 4 per connection per pass.
  - **Rate:** 20 passes a second.
- **`CallPreReplication`** (it refreshes each character's replicated movement) runs only with `CULLING_NETPLAY_PREREP=1`. It ran safely in game, but stays opt-in until more runs back it.
- **On a client** the same hook writes a trace every 2 s: its channels, controller and pawn, and every pawn with its position.

**The host's own match ended by itself** about 35 s after it started listening, with or without a client: the listen socket closed and the world left. That first looked like crashes. The test host now sets FreeForAll's no-end flag (+0x74d); a lone host then stayed up 139 s and more. The likely cause is that the game's server-side match logic runs on a listen server and finds no network players. A real host will need the proper pre-match flow (wait for the expected players, then start), using the backend's player list.

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
4. **The Steam driver's TickFlush slot** (0x142e0ac10): `np_tick_flush`, the loop above.
5. **`UWorld::InternalGetNetMode`** (0x1416848f0) and its two inlined copies. This client build folded "has a NetDriver" into "is a client", so a hosting world would call itself a client. They now ask the driver: `UNetDriver::GetNetMode` is IsServer ? (GIsClient ? ListenServer : Dedicated) : Client. For every world a stock client has, the result is unchanged.

## How to run it

`python patch/netplay_run.py` (the test copy of the game, launched the way the launcher's PLAY does):
1. Builds the host exe.
2. Installs it into the test copy, backing up the original.
3. Starts a host with `-FuncJoin=Jungle_P?listen?bIsLanMatch?bEnableBots=true?game=...VictoryGameMode_C`.
4. Polls `netstat` for UDP 7777.
5. Starts a second client with `-FuncJoin=127.0.0.1:7777`.
6. Reads the host's trace.
7. Stops only what it started, restores the exe, and writes `netplay_run.json`.

Options: `--clients 2` starts a second player. `--distinct-ids` gives each game its own test Steam ID and name (`steam_settingsorce_steamid.txt` and `force_account_name.txt`, written just before each game starts and restored byte for byte after); kill credit needs it on one PC. Test switches (environment): `CULLING_NETPLAY_PREREP`, `_MOVE`, `_GIVE`, `_TELEPORT=1|2`, `_DAMAGE`, `_ATTACK`, `_ATTACK_ONE_SIDE`.

Two notes:
- **The listen socket lives as long as the host's world.** A match that ends sends the game back to the menu, which closes the socket. That's why bots are on.
- **Both games ran on one PC.** Two PCs need the host's UDP port open (Windows firewall) and the client given the host's address.

## Known issues and risks

- **The trace shows nothing from the client's side.** The client's notify is the pending net game, not hooked. Not needed so far.
- **This build may have more folded net-mode checks** that static reading can't find. They'll show up as wrong behaviour in milestone 3 and later.
- **What the client shows after Join wasn't captured.** The games run fullscreen and the screen tool can't see them. It's expected to have no world from the host until milestone 3 exists.
