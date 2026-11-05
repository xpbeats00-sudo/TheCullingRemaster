# Real online multiplayer: feasibility (2026-11-05)

**The goal.** A party leader and their invited friends queue together, enter the same lobby, stay on the same team, and play on the same authoritative dedicated server.

## Verdict: BLOCKED

Nothing on this PC can be the authoritative server.

- **The game can't host.** `Victory.exe` is a UE 4.15.3 WindowsClient build: the engine's server code was compiled out of it. It can't host a match, as a listen server (`?listen`) or as a dedicated server.
- **No server binary exists here.** None is on this PC, in the paks, or in any Steam folder.
- **The client half is intact.** The menu's matchmaking already ends in a real UE4 client travel, `open <host:port>?Nonce=<nonce>`. A client should be able to join a real server if one existed. That is shown statically only; test N2 below checks it in game.

**What unblocks it** (see the continuation plan):
- **(A) Get a dedicated server build** that matches this client. This is the realistic route.
- **(B) Rebuild the missing server code inside the client exe as a native module.** This is research-grade work: months, with no guarantee.

Nothing here is marked PASS from an in-game run. Every in-game result below is a prediction for the coordinator to check.

## 1. Is server code compiled into Victory.exe?

Everything below is from `C:\Culling\TheCulling\Victory\Binaries\Win64\Victory.exe`:
- stock, SHA-256 `bd818b91…8758`, 53,671,936 bytes, image base 0x140000000;
- disassembled with capstone, with functions bounded by `.pdata`.

The same bytes are present in the sandbox's patched copy: `patch_exe.py` moves neither `.text` nor `.rdata`.

**Reproduce:** `python patch/netplay_check.py <Victory.exe>` checks facts 1–4 from the exact bytes. `python patch/test_netplay_check.py [Victory.exe]` has 8 stand-in tests, plus the real exe when you give its path; all pass on both copies.

| # | Fact | Evidence |
|---|---|---|
| 1 | **`?listen` does nothing: `UWorld::Listen` is a stub returning false** | `UEngine::LoadMap` (function 0x141643b80–0x1416452cd) has the stock "Listen for clients" block at VA 0x141644cc9. In order, it:<br>• checks no pending connection;<br>• loads `GIsClient`;<br>• runs `lea rdx, L"Listen"` (string 0x142aec568) and `call FURL::HasOption` (0x141668e30);<br>• runs `mov rcx, [r14+0x298]` (the WorldContext's world) and `mov rdx, rdi` (the URL);<br>• runs **`call 0x14143e6f0`**;<br>• then the next statement, `GetOption(L"Mutator=", L"")`.<br><br>0x14143e6f0 is **`xor al, al; ret`** (`32 c0 c3`), a "return false" shared by 104 callers. In a full build `UWorld::Listen` creates the GameNetDriver and calls `InitListen`; here its body is gone (`#if WITH_SERVER_CODE`). The `LoadMap: failed to Listen(%s)` string exists twice, at 0x142aedc78 and 0x142aede48, but it is unreferenced: logging is compiled out of the shipping build. |
| 2 | **A server would never replicate actors** | `UNetDriver`'s constructor (call at 0x141427637, `lea` at 0x14142763e) stores its vtable at 0x142a58218.<br><br>`SetWorld` (0x14143b0c0) binds `TickDispatch`, `TickFlush` and `PostTickFlush` through the vcall thunks for slots +0x270, +0x278 and +0x280. So **TickFlush = slot +0x278 = 0x14143f2b0**. `UIpNetDriver` doesn't override it.<br><br>TickFlush starts with `call [rax+0x2d0]`. Slot +0x2d0 is 0x1414357c0, `cmp [rcx+0x70],0; sete al; ret`: `IsServer()`, true when `ServerConnection` is null. The result is **never tested**. The next instructions are:<br>• `xor ebx,ebx`;<br>• `mov [rdi+0x3e8], ebx` (resets `ProcessQueuedBunchesCurrentFrameMilliseconds`);<br>• `QueryPerformanceCounter`.<br><br>So the stock `if (IsServer() && ClientConnections.Num() > 0 && …) { ServerReplicateActors(DeltaSeconds); }` has an empty body: `WITH_SERVER_CODE` was 0. The strings `ServerReplicateActors` and `replicated %d actors` don't exist. |
| 3 | The socket layer is complete | `UIpNetDriver` has its own vtable, 0x142dfe1b8 (constructor 0x1422ca720; `USteamNetDriver`'s constructor at 0x14230c4e0 calls it):<br>• `IsAvailable` returns true (`b0 01 c3`);<br>• `InitListen` is its own function, 0x1422d9800, not `UNetDriver`'s pure virtual 0x141433dc0;<br>• `%s IpNetDriver listening on port %i` is at 0x142df8f30.<br><br>A UDP socket could be bound, but nothing above it (fact 1) asks for one, and nothing would use it (fact 2). |
| 4 | The client half is intact | `AVictoryFrontEndHUD::ConnectToServer(gameServer, nonce, serverNonce)` (0x1401dce90):<br>• formats `L"open %s?Nonce=%s"` (0x14257d978, `lea` at 0x1401dcec6);<br>• runs it as a console command through the player controller (vtable +0xb60);<br>• stores `serverNonce` in the online singleton (0x1401f2de0 → `SetServerNonce` 0x1401f6850).<br><br>The Remaster menu (`ClientWeb.js`) calls it for any `match-ready` whose `gameServer` isn't `offline:`, `duo:` or `showdown:`. |
| 5 | Game-side server logic was compiled | These strings exist (logging is compiled out, so they're unreferenced; their presence means the source that contains them was built):<br>• `AShooterGame_FreeForAll::PreLogin %s %s`, `PreLogin: Unable to load authentication information`;<br>• `Possible hacker warning: unique ID %s with nonce %s is connecting to a server where he is not expected!`;<br>• `AShooterGameMode::InitGame Parsed a server Nonce!`;<br>• `AShooterGame_FreeForAll::InitNewPlayer !NM_DedicatedServer`;<br>• the engine's server handshake: `Login request: %s userId: %s`, `NMT_Login: Invalid URL %s`, `PreLogin failure: %s`, `Join request: %s`, `Join succeeded: %s`.<br><br>`?servernonce` is read by code (`lea` at 0x140233e59 in function 0x140233b00).<br><br>**Not checked:** whether every function body behind those strings survived, beyond facts 1–2. |

### Config (pakchunk0 `DefaultEngine.ini`, extracted at `patch/research/config`)
- **Net drivers:** `GameNetDriver` = `OnlineSubsystemSteam.SteamNetDriver`, falling back to `OnlineSubsystemUtils.IpNetDriver`. `DemoNetDriver` is for replays.
- **IpNetDriver:** `InitialConnectTimeout=240.0`.
- **Steam:** `bVACEnabled=0`, `bAllowP2PPacketRelay=true`, `GameServerQueryPort=27015`.
- **Not set:** `NetServerMaxTickRate` and `[URL] Port`, so the defaults apply (port 7777).

Config can't bring back code that was compiled out.

### Other things that would block a host (if a server existed)
- **Easy Anti-Cheat:** not a blocker.
  - `Func.Launcher.exe` starts `Victory -eac-nop-loaded -NoEAC -NOSPLASH -game`.
  - `InstallScript.vdf` names an `EasyAntiCheat` folder, but the install doesn't have one.
- **Steam:** not a blocker.
  - `steam_api64.dll` (1.8 MB, with `steam_api64_ORIGINAL.dll` next to it) is an emulator. It reads `steam_settings` and carries `Lobby` / `Gameserver` protobuf types.
  - A URL that is an IP address goes through the IP path. *(UE4 4.15 SteamNetDriver passthrough: from the engine source, not checked in this exe.)*
- **Nonces:** the server's game mode parses `?servernonce=` and checks each joining client's `?Nonce=` in `PreLogin` against "authentication information" it loads, by a protocol not reverse-engineered yet.
  - The client quits if the server's `ClientCheckServerNonce` RPC doesn't match the `serverNonce` it got from matchmaking (`QUITTING DUE TO INVALID SERVER NONCE!!!`).
  - Both checks belong to whatever server is used. The backend (`server/`) would hand out matching nonces.
- **Teams:** `TeamNumber` comes from the online team subsystem, which is filled from matchmaking partners (`patch_exe.py` fix 4).
  - A real server must get the party roster from the backend, with the same authentication load as above.
  - Today fix 4 pairs contestants by array index, locally.

### The earlier "ConnectToServer bounced to the menu" result
This is consistent with the above. `offline:N` isn't a host, and no address has a server, so `open` fails: at once for an unresolvable host, or after up to 240 s for a silent one. The engine then travels back to the default map (the menu). Static explanation only.

## 2. Is there a dedicated server binary anywhere?

| Where | Found |
|---|---|
| `C:\Culling\TheCulling` (whole tree) | Client only:<br>• `Victory.exe`;<br>• `Func.Launcher.exe` and `Func.Client{,.Local,.Online}.dll`;<br>• `pakchunk99-WindowsClient_P.pak`;<br>• Engine DotNET crash reporters and ThirdParty DLLs. |
| Paks (10 files, 20,790 entries; listed with `build_catalog.pak_entries`) | Only `WindowsClient` paks and `LocalServer-WindowsClient_P.pak` (the Remaster's UI and config patch).<br>No `WindowsServer` content and no `DedicatedServer*.ini`.<br>The only files with "server" in the name are `RemasterServer.js` ×2. |
| Steam (`C:\Program Files (x86)\Steam`, the only library in `libraryfolders.vdf`) | The Culling isn't installed. No server tool in `steamapps\common`. |
| Whole C: drive | `dir /s` for `*VictoryServer*`, `*WindowsServer*.pak` and `*Victory*Server*.exe` found nothing.<br>`C:\Users\Mbkmo`: no `Func.Server*` or `func-*.zip`. |
| The sandbox game copy (`…\LocalCache\Local\TheCullingRemaster\Game`) | The same client files. |

### Outside this PC: leads only, none verified as a server

- **The Func project** (`theculling.atch.ooo`, the author of the `Func.*` files the Remaster runs on).
  - **It's live:** `/api` answers with socket, matchqueue and login URLs, and `/updates/stable/latest.json` lists build 273: `Func.Client.dll` 257,024 bytes plus the launcher and the pak. Probed read-only on 2026-11-05; I didn't download the package.
  - **Its old client DLL (the one installed here) fixes bugs that only exist with remote players:**
    - `BlowgunVomitProxyPatch: remote PlayerPawn_C …`;
    - `Client_WoundExpired` / `Multicast_WoundExpired`;
    - `Client net-close diagnostics`;
    - `DiscoveryInject: … timeouts: server=60, loading=30`.
  - **Its launcher has load-test clients that join a server:** `-FuncJoin=<host:port>`, `-FuncHeadlessClient` ("Add -nullrhi -nosound for local load clients"), with the example `-FuncJoin=127.0.0.1:7777`.
  - **So Func very likely runs real authoritative servers.** I couldn't find out whether those are an original `VictoryServer` build or something rebuilt.
- **ReviveTheCulling** ([github.com/MEwers96/ReviveTheCulling](https://github.com/MEwers96/ReviveTheCulling), last push 2026-06-24) is a Python mock backend.
  - Its `mock_server.py` sends the host `Jungle_P?listen?bEnableBots=true?servernonce=…` and the others `127.0.0.1:7777`: exactly the route fact 1 rules out.
  - Its readme says the game-server part is still in progress.
- **Steam.** The original game had official dedicated servers. No public server tool for app 437220 was found, and a hosting company's page on it is unreadable (HTTP 403).

## 3. What would make host + join work

There's nothing to unblock with config: the server half doesn't exist in this binary. The two routes:

### (A) A dedicated server build that matches this client (recommended)

- **Needs:** a `VictoryServer.exe` (WindowsServer target, UE 4.15.3) of the same build as this client (`buildversion.txt` 119207). The UE4 handshake compares network versions.
- **Possible sources:**
  - the Func maintainers, who appear to run servers (ask how);
  - Xaviant or the rights holder;
  - an archive of the original Steam server depot.

  Licensing has to be cleared with the rights holder. That is the user's call.
- **Integration once a build exists:** about 1–3 weeks.
  1. Run it on the VPS (Windows Server, 217.60.97.88): one process per match, with `-port`, opened on UDP in the firewall (an operator change).
  2. The backend (`server/`): a party's `match-ready` carries `gameServer: "217.60.97.88:<port>"`, a `nonce` per player and the match's `serverNonce`. The client side is already wired (fact 4).
  3. Reverse-engineer and serve the "authentication information" the server's `PreLogin` loads, with the roster and each party's team, so friends share a `TeamNumber`.
  4. Results come from the server instead of each client's HUD.
- **NAT:** none for players. They only make outbound UDP to the VPS. Only the VPS needs inbound UDP.

### (B) Rebuild the server code in the client (`.sdround` native module, like `showdown_rounds.c`)

This is about 2–4 months of reverse-engineering work, with high risk and no source.

**What would need writing in C against this build's undocumented struct layouts:**
- **`UWorld::Listen`:** about 60 lines of engine logic.
  - Building blocks present: `CreateNamedNetDriver` (its strings exist) and `UIpNetDriver::InitListen` (fact 3).
- **`ServerReplicateActors` and its helpers:** about 1,000+ lines of 4.15 `NetDriver.cpp`, hooked into the `TickFlush` vtable slot of `UIpNetDriver` and `USteamNetDriver` as fix 5 does.
  - The work: relevancy and priority, opening and closing actor channels, the connection's view target, update frequency, bandwidth checks.
  - Present to build on: `UActorChannel::ReplicateActor` (the demo recorder uses it) and `AActor::IsNetRelevantFor`.
- **Any other `WITH_SERVER_CODE` gaps:** found only by testing.

**The host would also be a listen server, not a dedicated one.** `GIsClient` is 1 in a client build, so the net mode would be `NM_ListenServer`. The Victory game code expects `NM_DedicatedServer` (see the `InitNewPlayer !NM_DedicatedServer` string). A headless host on the VPS (`-nullrhi -nosound`) would still have a local player, which every "living humans" rule would count (see fix 7).

**Feasible in principle, not in a session.** It needs a debugger-driven loop with two machines.

### (C) Rewrite the game: out of scope

That means a new UE project rebuilding the Victory classes, assets re-cooked or re-authored. It is years of work.

## 4. Prototype (this branch)

- **`patch/netplay_check.py`** and **`patch/test_netplay_check.py`:** the static evidence above as reproducible checks (8 tests, plus the real exe).
- **Launcher test hook** (`launcher/lib/game.js` `netTestArgs`; 2 new tests in `launcher/test/game.test.js`, `node test/game.test.js`: 10/10).
  - **What it does:** with `CULLING_NET_URL` set in the launcher's environment, PLAY adds `-FuncJoin=<url>`, so the game starts straight into that URL instead of the menu.
  - **Why `-FuncJoin`:** `Func.Launcher.exe` builds `Victory` + the join URL + ` -eac-nop-loaded -NoEAC -NOSPLASH -game` (`lea`s at 0x1400044d8 and 0x140004563). That puts the URL first on the command line, which is where UE4 reads its start URL. This is a static reading; test N1 step 3 confirms it.
  - **Safety:** unset, nothing changes. A value with spaces, quotes or other characters a URL never needs is refused before anything starts.
- **`deploy/netplay_udp_probe.js`:** a UDP listener that logs every datagram (sender, size, first bytes) and never answers. `node deploy/netplay_udp_probe.js --selftest` passes.

No exe patch was written. Faking a host would mean shipping a server that doesn't replicate, and the goal says not to fake it.

## 5. In-game tests for the coordinator

Run these through the launcher from this branch. Name the game copy each test used: a game Claude starts uses the sandbox copy.

### Setup
```powershell
cd C:\Culling\netplay\launcher
npm install          # first time in this worktree
```

### N1: can the client host? (one PC)
1. Start the launcher with the host URL, then sign in and press PLAY:
   ```powershell
   $env:CULLING_NET_URL = 'Jungle_P?listen?bEnableBots=true?game=/Game/Blueprints/GameMode/VictoryGameMode.VictoryGameMode_C'
   npm start
   ```
2. Wait until you are in the Jungle map.
3. **If you land in the menu instead,** `-FuncJoin` didn't set the start URL. Stop and report.
4. In another PowerShell, list every UDP port the game owns:
   ```powershell
   Get-NetUDPEndpoint | Where-Object { (Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue).Name -eq 'Victory' } |
     Select-Object LocalAddress, LocalPort, OwningProcess
   ```
- **Predicted:** no `LocalPort 7777`.
  - Other ports may show up (the Steam emulator and the menu's sockets); only 7777 matters.
  - That confirms fact 1 in game: **host = BLOCKED**.
- **If Victory owns 7777, the static analysis is wrong.** Report it at once and run N3.

### N2: does the client start a real connection? (one PC, or the VPS)
1. In a PowerShell window, start the probe and leave it running:
   ```powershell
   node C:\Culling\netplay\deploy\netplay_udp_probe.js 7777
   ```
   - **Over the internet instead:** run the probe on the VPS over RDP, and allow inbound UDP 7777 in its firewall first (an operator change). Then use `217.60.97.88:7777` in step 2.
2. In a second PowerShell window, start the launcher with the join URL, then sign in and press PLAY:
   ```powershell
   cd C:\Culling\netplay\launcher
   $env:CULLING_NET_URL = '127.0.0.1:7777'
   npm start
   ```
- **Predicted:** within a few seconds the probe logs datagrams from the game's address, with the same sender port each time: the UE4 stateless connection handshake.
  - The game waits, then returns to the menu, possibly with a connection error, after up to 240 s.
- **PASS** = at least one datagram from the game. That proves the client half sends a real connection. It does **not** prove gameplay: there's no server to answer.

### N3: two instances, host + join (only if N1 found 7777 open)
1. On PC A, run N1 and note A's LAN IP (`ipconfig`).
2. On PC B, run N2's step 2 with `CULLING_NET_URL = '<A-ip>:7777'`.
- **PASS** = B appears in A's match, in the same world, and both see each other move.
- **Predicted:** no port opens on A (N1), so this can't run.
- The same steps with one PC and two instances need the launcher to allow a second game, which it deliberately doesn't. Use two PCs.

| Test | Static prediction | In-game result |
|---|---|---|
| N1 host | no UDP 7777 (BLOCKED) | not run |
| N2 join packets | datagrams arrive (client half PASS) | not run |
| N3 host + join | can't run | not run |

## 6. Continuation plan

1. **The user decides route A:** contact the Func maintainers (`theculling.atch.ooo`) and/or the rights holder about a matching dedicated server build, or how Func hosts its matches. This is the only short path to the goal. It's a decision and a message for the user to make, not something done here.
2. **Run N1 and N2** to turn the predictions into results.
3. **If a server build arrives:**
   - check its network version against client 119207 with N2 against it;
   - reverse-engineer its `PreLogin` "authentication information" request (roster, nonces, teams);
   - extend `server/` matchmaking to give a party one `gameServer` with per-player nonces and one team;
   - run one server process per match on the VPS, firewall included;
   - report results from the server.
4. **Only if A fails and the user accepts months of risk: route B.** Prototype `UWorld::Listen` first: a hooked `LoadMap` call that creates and listens on the GameNetDriver. Then N1 shows 7777 open and N3 shows whether a client gets through the handshake to an (empty) world. Only then start on actor replication.
5. **Not to do:** a menu tile or "online" mode that really starts a local bot match. That would fake the goal.

## Sources (web, read-only)
- [ReviveTheCulling (GitHub)](https://github.com/MEwers96/ReviveTheCulling) and its [Reddit thread](https://redlib.cypherpunktools.com/r/survivetheculling/comments/1lxffkh/revivetheculling_a_project)
- [The Culling (Wikipedia)](https://en.wikipedia.org/wiki/The_Culling_(video_game)): history of the official servers
- [The Culling server hosting page (survivalservers)](https://www.survivalservers.com/services/game_servers/the_culling/): returned 403, not read
- `https://theculling.atch.ooo/api` and `/updates/stable/latest.json`: probed directly
