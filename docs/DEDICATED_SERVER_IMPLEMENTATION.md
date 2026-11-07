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

  Not yet tested: ranged weapons, blocking and shoves, the kill feed and death screen, and a real player's mouse and keyboard. Calling only the weapon's `ServerStartPrimaryInput` RPC (0x14030e590) does nothing visible: on the host it only refreshes the weapon's speed values. |
| 5 | Loot, containers, airdrops, gas, weather | BLOCKED on 3 | |
| 6 | Match flow and results from the host (`shared-match-backend`: allocator, tickets, server results) | **PARTIAL: the match ends and every game sees the result** (2026-11-06) | **The game's own end of match runs on the host and reaches both players.** The test (CULLING_NETPLAY_END=1, with the one-sided attack and `--distinct-ids`): 5 s after Player One kills Player Two, the host eliminates everyone else (14 to 16 bots and the host's own player) and stops holding the match open (the no-end flag +0x74d). The stock free-for-all check then ends the match:
  - **match state** (AGameState::MatchState +0x440): InProgress to WaitingPostMatch on the host, and on both clients within 1 s;
  - **winner:** Player One's record gets the winner flag (record +0x28 goes from 0x1 to 0x101, byte +0x29) and death order 18 (1st of 18);
  - **scoreboard:** the same on all three games (1 alive, Player One 1 kill, Player Two dead and killed by Player One);
  - **after the results:** the post-match phase lasts about 30 s. Then the host leaves the map, the listen socket closes, and both players' connections end within 1 s. All three games stay up, and no game crashed.

  **Fixed on the way:** the host crashed 2 s after the match ended. My replication loop read a character's inventory from the host player's spectator pawn (a dead player's pawn is a smaller class), and passed the garbage to CallPreReplication as an actor. Every inventory, weapon and health read now checks the AShooterCharacter class first.

  **Not done:**
  - what the players see at the end (their end screen; desktop capture shows only the title art over the game windows);
  - where the players go when the host leaves (their menu or an error);
  - the backend side: posting the results, placement and XP to the server from the host (`shared-match-backend`).

  **A real pre-match phase works** (2026-11-06). The host's match begins in WaitingToStart with a 15 s warmup (AShooterGameMode::WarmupTime +0x598, counted down in AShooterGameState::RemainingTime +0x4e0), then goes InProgress with a 25-minute clock. With `CULLING_NETPLAY_PREMATCH=N` the host keeps that warmup full until N players have joined, with a 3-minute limit, then lets the game's own countdown run. Both test-only bypasses are off in this mode: the game's own PreLogin runs (it refuses once a match is over), and the no-end flag isn't set. In game with N=2:
  - **the hold:** the host held for 92 s and 113 s while the players arrived;
  - **logins:** both players passed the game's own login checks;
  - **the start:** 15 s after the second join, InProgress with 3 players;
  - **pods:** each player spawned in a pod of their own, (29675, 33265) and (-11652, -39847), shuffling about 120 units inside until the doors opened 10 to 17 s after the start. They then walked out (thousands of units by +90 s). Before, a player who joined after the start stood in a pod that never opened;
  - **no early end:** the match kept going (73 s and more) without the no-end flag.

  **A whole match with no bypasses** (PREMATCH=2 plus the attack and end tests): pre-match hold, countdown, start, Player One beats Player Two (100, 91, ... 12, dead), the host clears the rest, WaitingPostMatch. Player One is the winner (1st of 16), and the scoreboards are identical on all three games. No game crashed.

  **The backend is connected: matchmaking to a paid result, all local** (2026-11-06). The pieces:
  - the backend from branch `shared-match-backend`, shared matches on for Solo, with one pool game server `gs1@127.0.0.1:7777`;
  - the game-server agent `gameserver/agent.js`, which speaks the backend's signed game-server API (register, heartbeat, ready, verify-ticket, result) for the host;
  - two test accounts (`gameserver/test_players.js`) that queue Solo together through the backend's socket API, as the menu does.

  The host and the agent talk through files in a control folder (`CULLING_NETPLAY_CONTROL`):
  - `listening`: the host is up, so the agent posts ready;
  - `verify-<n>.req/.ans`: the host's PreLogin reads the ticket from `?Nonce=` in the login options, the agent asks the backend, and the host refuses on a "deny" (up to 8 s);
  - `result.txt`: written at WaitingPostMatch, then posted by the agent.

  Every game uses a copy of the Func client DLL pointed at the local backend, never the live server. `netplay_run.py --backend-repo <checkout>` runs it all. In game:
  - **allocation:** the backend sent the match to gs1 (2 players, 14 bots); the host started with the pre-match phase for 2 players;
  - **readiness:** once it listened, the agent posted ready and both test players got match-ready (`127.0.0.1:7777`, netplay, their tickets);
  - **joining:** the two game clients joined `127.0.0.1:7777?Nonce=<ticket>`. Each ticket was checked by the backend at PreLogin (team 1, team 2), and the host waited for both, then started;
  - **the match:** Player One beat Player Two, the host cleared the rest, and the match ended;
  - **the result:** placement 1 with 1 kill, 100 damage and 33 s alive; placement 16 with 26 s alive. The backend paid it: 2,016 XP, 531 credits and a victory for Player One; 263 XP for Player Two. The players' `remaster-shared-match finished` messages carried it;
  - **a forged ticket** (`--bad-ticket`): the backend answered `bad-signature` and the host refused that login. The other player was in and every game stayed up.

  From the host's records: placement = records + 1 - death order. Damage is the scoreboard entry's DamageDealt (+0x68, an int32). Time alive is measured by the host from the start to the death, because the record's own MinutesAlive (+0x44) is still 0 at the end.

  **The real menus join** (2026-11-06, twice). Read from the exe first: the stock `ConnectToServer(gameServer, nonce, serverNonce)` (0x1401dce90) runs `open <gameServer>?Nonce=<nonce>` and keeps `serverNonce` in the game singleton. The server, started with `?servernonce=`, sends its own in `ClientCheckServerNonce` (PC vtable +0xe38, 0x140283570), and a client whose stored one differs disconnects with `ServerNonceFailed`. So the backend (branch `shared-match-backend`, 70cc7dc) now sends the ticket as `nonce` and a per-match server nonce as `serverNonce`, also in the assignment for the host's URL. The host reads `?Nonce=`.

  `netplay_run.py --menu` starts both clients at their menus (no `-FuncJoin`). The Remaster menu talks to the server in `js/RemasterServer.js` (`CustomMatchSettings.js` replaces `GetClientwebRootURL`), and this test copy's page doesn't load it, so the menu falls back to `127.0.0.1:8000`. A one-file override pak (`zz_…_P.pak`: `RemasterServer.js` plus the installed `FrontEnd.html` with the script tag) points the test menus at the local backend, and is removed after. The backend's test hook queues both menus as PLAY would. In game:
  - both menus logged in, were queued and allocated;
  - the host started with `?servernonce=<the match's>`;
  - each menu got match-ready and joined through its own `ConnectToServer`, and its ticket from `?Nonce=` was checked by the backend (team 1, team 2);
  - the server-nonce check passed (both stayed connected);
  - the match was played and ended, and the result was paid (player 2 won: 1 kill, 99 damage, 2,021 XP; player 1: 326 XP).

  The same again in a second run. The runner saves every file it changes in the test copy to `<out>/originals` first; `--restore <out>` puts them back after an interrupted run.

  `gameserver/test_agent.py` checks the agent against the real backend with the host played by files, no game needed: both tickets pass, a replayed one is `used`, a forged one `bad-signature`, the result is paid, and the agent goes idle.

  **Not done:**
  - clicking Play in the menu: the test queues the menus through the backend's test hook;
  - teams beyond Solo (Duos and up) were only checked in the agent's code, not in game;
  - the host is started by the test runner. A real game server starts it from the assignment (milestone 7);
  - the pair teleport and eliminations are still test switches. |
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

**Without `CULLING_NETPLAY_PREMATCH`, the host's own match ended by itself** about 35 s after it started listening, with or without a client: the listen socket closed and the world left. That first looked like crashes. The test host now sets FreeForAll's no-end flag (+0x74d); a lone host then stayed up 139 s and more. The likely cause is that the game's server-side match logic runs on a listen server and finds no network players. A real host will need the proper pre-match flow (wait for the expected players, then start), using the backend's player list.

## What the module changes (each edit checked against the stock bytes by `test_netplay.py`)

1. **The `UWorld::Listen` call.** LoadMap's call of `UWorld::Listen` (0x141644cef) goes to `np_listen`; the stock target is a `return false` stub. `np_listen` follows 4.15's Listen:
   - `CreateNamedNetDriver(world, NAME_GameNetDriver 0x11a)`;
   - `SetWorld`;
   - `world->NetDriver` (+0x38) and the DynamicSource and Static level collections;
   - `InitListen` with the world's FNetworkNotify (world+0x28).

   The game net driver is **USteamNetDriver**. Its InitListen opens a Steam (emulator) P2P socket unless the URL has `?bIsLanMatch`, and on this launch path that option doesn't reach it. So `np_listen` takes the driver's own LAN branch itself: `bIsPassthrough` (+0x438) = 1, then `UIpNetDriver::InitListen` (0x1422d9800), a plain UDP socket. In game, without this: `ok=1` but no UDP port.
2. **Three slots of UWorld's FNetworkNotify vtable** (accepting, accepted, control message): pass-through trace hooks. They only write when `CULLING_NETPLAY_TRACE` names a file.
3. **FreeForAll's PreLogin slot** (0x1425a7fe0) goes to `np_prelogin`. The game's PreLogin refuses every login with "Match is over!" while its game state says so (in game: `match_over=1` 28 s after the host started, because a local match starts at once). The test host skips that one refusal and runs only the engine's checks (`AGameModeBase::PreLogin`).
   - **With `CULLING_NETPLAY_PREMATCH=N`** the host holds the pre-match phase until N players have joined, and this slot runs the game's own PreLogin (`AShooterGameMode::PreLogin`, the stock target), so nothing is skipped.
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

Options: `--clients 2` starts a second player. `--distinct-ids` gives each game its own test Steam ID and name (`steam_settingsorce_steamid.txt` and `force_account_name.txt`, written just before each game starts and restored byte for byte after); kill credit needs it on one PC. Test switches (environment): `CULLING_NETPLAY_PREREP`, `_MOVE`, `_GIVE`, `_TELEPORT=1|2`, `_DAMAGE`, `_ATTACK`, `_ATTACK_ONE_SIDE`, `_END`, `_PREMATCH=N`. `--no-client` now watches a lone host for `--after-join` seconds. `--shots N` saves a desktop screenshot every N seconds after the joins. `--backend-repo <checkout of shared-match-backend>` runs the whole chain locally (backend, agent, test players, tickets); `--bad-ticket` tampers with the second client's ticket. `--menu` (with `--backend-repo`) starts the clients at their menus and lets them join by the menu's own match-ready handling. `--restore <out>` undoes an interrupted run.

Two notes:
- **The listen socket lives as long as the host's world.** A match that ends sends the game back to the menu, which closes the socket. That's why bots are on.
- **Both games ran on one PC.** Two PCs need the host's UDP port open (Windows firewall) and the client given the host's address.

## Known issues and risks

- **The trace shows nothing from the client's side.** The client's notify is the pending net game, not hooked. Not needed so far.
- **This build may have more folded net-mode checks** that static reading can't find. They'll show up as wrong behaviour in milestone 3 and later.
- **What the client shows after Join wasn't captured.** The games run fullscreen and the screen tool can't see them. It's expected to have no world from the host until milestone 3 exists.
