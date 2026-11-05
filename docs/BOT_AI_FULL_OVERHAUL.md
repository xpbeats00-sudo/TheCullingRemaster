# Bot AI overhaul: research, feasibility and what was built

The request was a complete rebuild of the match AI, "taught using Mandriod machine-learning algorithms". This document covers four things:

- what "Mandriod" turned out to be;
- how the shipped AI is built;
- which of the requested capabilities can be changed in a cooked UE 4.15.3 shipping client with no editor and no source;
- what was implemented: `patch/make_bot_ai.py`, five difficulty tiers built from stock data, tested by `patch/test_bot_ai.py`.

**Nothing in this work is machine learning.** The tiers are hand-chosen values written into the cooked assets. Every behaviour claim marked [I] needs a playtest, and no match was played for this work.

Companion document: `docs/BOT_AI_AUDIT.md`, the earlier read-only audit. It has the full behavior tree, the native function map with addresses, and the threat formula. Its asset offsets and SHA-256 prefixes were re-checked against the stock paks for this work and all matched (`MatchBot` `41567d5b58cfb467`, `BasicController` `236be46957c1b346`, `MeleeCharge` `099d8abed1eaa14d`, `FireProjectile` `4e6eac25c3be414f`). This document does not repeat the audit's detail.

Evidence labels:

- **[C]** read directly from shipped data: cooked asset properties, Kismet bytecode, or `Victory.exe` disassembly.
- **[I]** inferred from engine semantics, or the expected in-game effect.

Statuses: **PASS**, **FAIL**, **BLOCKED**, **NOT TESTED**, **PARTIAL**.

---

## 1. "Mandriod": findings

| Question | Finding |
|---|---|
| A machine-learning framework, library or project called "Mandriod"? | **None found.** Web searches for "Mandriod" and "Mandroid" with machine learning, framework, library, GitHub and reinforcement learning returned no such project. The search engine corrected the spelling to "Android" or "Mandroid". |
| What "Mandroid" is elsewhere | A Marvel powered-armour suit, a *Billy & Mandy* character, a 1993 film, and a Korean prosthetics company (Mand.ro). None are ML software. |
| "Android" ML (a likely misspelling) | TensorFlow Lite / LiteRT and ML Kit are Google's on-device inference stacks for Android phones (Apache-2.0 / Google terms). They target Android apps, not a Windows UE4 client. Their Windows-capable relatives (TFLite C API, ONNX Runtime) are discussed in section 6. |
| In the game | "**Mandroid 5000**" is a stock contestant name in `VictoryGameMode.BotNames`, kept by `patch_assets.BOT_NAMES`. **`BasicController_ManDroid`** is a stock `BasicController` subclass [C]. It has fixed (non-random) cosmetics, a 180° sight half-angle, and an extra hearing sense (`HearingRange` 10000). The tutorial and survival bots (`BasicBot_Child_Tutorial`, `BasicBot_Child_Survival`) use it. It contains no learning code, only property values. |
| Licence / integration | Nothing to license or integrate: no such API exists, and none was invented. |

**Conclusion.** "Mandriod" is not an ML toolkit. Either it is a misspelling of Android or Mandroid, or it refers to the game's own "Mandroid" contestant and controller, which are scripted. Section 6 evaluates ML with real frameworks.

---

## 2. Current architecture map

Everything below is [C] unless marked. Paths are under `Victory/Content/Blueprints/`.

```
Game mode (VictoryGameMode*, BotControllerClass = AI/Base/BasicController_C, BotsToSpawn)
  └─ spawns BotPawnClass: not stored in Classic; the AShooterGameMode constructor loads
     "/Game/Blueprints/AI/Base/BasicBot.BasicBot_C" (FClassFinder, Victory.exe 0x140236e03)
       AI/Base/BasicBot (AShooterBot BP): BotBehavior = AI/Trees/MatchBot,
         AIControllerClass = BasicController_C, loadout lists, ChargeToShoveChance (native default 0.5,
         ctor 0x140221593 -> +0xedc)
       AI/Base/BasicController (AShooterAIController BP)
         ├─ AIPerception (component added by the BP's construction script)
         │    ├─ AISenseConfig_Sight_1: SightRadius 3500, LoseSightRadius 5000, half-angle 75, MaxAge 60
         │    └─ AISenseConfig_Damage_1: MaxAge 30          (no hearing sense: hearing is native, below)
         ├─ ThreatParams (stored: ThreatPerMeterCloserThanMaxDistance 6, MaxDistance 3500;
         │    native only: per-damage 2, per-projectile 3, stickiness 50 -> 5 over 7 s)
         └─ crafting classes, Interactables (crates, doors, barrels, SupplyDrop)
       AI/Trees/MatchBot (BehaviorTree) + AI/Base/BasicBlackboard (10 keys)
         ├─ 8 BP services, each a one-node wrapper around a native AShooterAIController function:
         │    FindBestTarget, SelectAction (x2), SelectBestWeapon, UpdateObjective (x2),
         │    UpdateBotStatus, Listen (native hearing: 1000 uu, no line of sight), FindScavengingTarget
         ├─ 15 BP tasks in AI/Behaviors (MeleeCharge, MeleeBlock, MeleeJab, MeleeShove, FireProjectile,
         │    RapidMoveTo, Craft, UseItem, EscapeSnare, QuickLook, StopMovement, ...)
         ├─ 2 BP decorators (IsPathing, NearLocation) + engine Cooldown/TimeLimit/Blackboard decorators
         └─ 11 EQS queries in AI/EQS (Scavenge, FiringPosition, QuickCover, AvoidGasPylon, MapClosing, ...)
Navigation: prebaked Recast navmesh in each map's Navigation sublevel (Jungle 93 MB, Jungle2 45 MB,
  Survival, Tutorial); no runtime generation.
```

Bot spawn and count:

- `BotsToSpawn` is stored in the game modes. Stock is 15; `patch_assets.py` sets 50 in Solo.
- `Victory.exe` caps players plus bots at 16; `patch_exe.py` raises the cap to 24.
- `bEnableBots` is a URL option, parsed in `InitGame` (0x140233c65) into `+0x5c9`.

**URL options the game parses [C].** `InitGame` reads these options, from its string references (0x140233600–0x140234800): `BucketID`, `bEnableBots`, `bExitOnRoundComplete`, `servernonce`, `SpawnTag`, `bNetProfile`, `EntranceFeeID`, `bWriteThreadStats`, `bEnableAreaSpawns`, `queue`, `custom`, `mods`.

- **There is no bot-skill or difficulty option.**
- The exe's only `DifficultyLevelId` string is a telemetry field, next to `SectionId`, `GameplayModeId` and `ItemId` (0x1402588e8).
- `AGameModeBase::OptionsString` is at `+0x400` (UHT registration at 0x14183cdd8). A native hook would have to read the URL from there.

**Where decisions happen.** The behavior tree only routes between branches. The choices themselves are native:

| Choice | Native function | Notes |
|---|---|---|
| Target | threat argmax, 0x1402183c0 / 0x140219020 | |
| Action | `SelectAction` 0x14021ee10 → melee dice 0x14021f960, bow 0x14021fc70, spray 0x14021fe50 | Probabilities are exe constants |
| Objective | `UpdateObjective` 0x140220de0 | Bow beyond 250 uu |
| Status | 0x140220810 | Iris, gas, blind, snare, stuck |
| Looting | 0x14021b860 / 0x14021f310 | Driven by each item's `BotWeaponScore` |

---

## 3. What can be changed, and how

| Route | What it can change | Proven? | Used here |
|---|---|---|---|
| **A. Same-size value edits in cooked packages** (Int, Float, existing-FName properties; float literals in Kismet bytecode) | Any value the asset *stores*: BT service intervals, decorator cooldowns and time limits, perception config, the stored `ThreatParams`, task-blueprint literals, item `BotWeaponScore`, EQS parameters | Yes. Property edits in cooked packages work in game (gas timeline, `BotsToSpawn`, bot names, Showdown kit) | **Yes**: every tier edit |
| B. Added tagged properties / imports (`ue_package.py`, `make_showdown.add_props`) | Values not stored (e.g. `RandomDeviation` on `SelectAction_C_3`), a game mode's `BotPawnClass`, repointed classes | Yes, on CDOs (Showdown mode/perk); not yet on BT nodes | No |
| C. Copies of packages at new paths (the Showdown perk pattern) | Per-mode controllers (perception, memory, threat), a per-mode tree only if the pawn is copied too | Yes for a data asset; not tried for a BP class | No (section 7) |
| D. Exe constant repoints (`patch_exe.py`) | Bow/melee switch distance (250 uu), melee dice probabilities, hearing radius | Pattern proven (contestant cap) | No (section 7) |
| E. Native module (`patch/showdown_rounds.c`, a no-CRT blob in a new exe section) | Runtime logic: read the URL (`OptionsString` +0x400), write controller fields (`ThreatParams`/stickiness 0x61c–0x634, `WeaponParams` 0x610–0x618), replace a native via its exec thunk (as `sd_rand_exec` does), hook a call site | Yes, Showdown rounds, Duo team win and gas kills ship this way | No (section 7) |
| F. Editor-only | New BT graphs, new tasks or services, new Blueprint logic, new blackboard keys, a rebuilt navmesh | **Not available**: no editor project, no uncooked assets | — |
| G. ML runtime | A learned policy | **Not available natively**: UE 4.15 has no inference plugin, and the shipping client can't load new modules. It would have to be an external process or a DLL loaded by the native module (section 6) | — |

---

## 4. Feasibility of each requested capability

| Capability | Today [C] | What is feasible | Done here | Status |
|---|---|---|---|---|
| **Perception** | Sight 3500/5000 uu, 75° half-angle; damage sense; native hearing 1000 uu through walls | Radius, angle and MaxAge per tier (A). Hearing radius only by exe patch (D) or code cave | Sight radius, lose radius, angle per tier | PARTIAL (in game NOT TESTED) |
| **Memory** | A target stays known 60 s after sight is lost (30 s after damage), and the chase follows the live actor | MaxAge per tier (A). Chasing a *last-known location* needs a new BT key and task wiring (F), or a native hook (E) | Sight 4–16 s, damage 6–15 s by tier | PARTIAL (NOT TESTED) |
| **Threat assessment** | `max(0, 3500−d)·0.06 + 2·damage + 3·shots` + stickiness; ignores health and players vs bots; no attacker cap | Stored: per-metre weight and MaxDistance (A). Per-damage, per-shot and stickiness only natively (B adds tags to the CDO; E writes fields) | Per-metre 6→4–6 (more weight on who hurt the bot), MaxDistance = sight radius | PARTIAL (NOT TESTED) |
| **Decisions / reaction** | The combat chooser re-rolls block/shove/jab/charge every frame (`SelectAction_C_3.Interval` 0.001), so blocks are near-instant | Interval per tier (A). The dice probabilities are exe constants (D). | Combat interval 0.6 / 0.4 / 0.25 / 0.15 / 0.08 s; scavenging, retarget, hearing intervals | PARTIAL (NOT TESTED) |
| **Navigation** | Prebaked Recast navmesh; EQS for wander, cover, firing positions; `Stuck` status → QuickCover/Backoff EQS | EQS parameters and gates (A). New navmesh: no (F). No evidence of a stuck or navigation fault was found, so nothing was changed | — | NOT CHANGED |
| **Stuck recovery / gas avoidance** | Native `Stuck` and `Gassed`/`Iris` statuses pre-empt everything; all move EQS penalise active pylons | EQS radii and weights (A); iris thresholds are exe constants (D) | — | NOT CHANGED (no failure evidence; playtest first) |
| **Combat: block / shove** | Dice above; block held 1.5 s; block cooldown 1.0–1.5 s | Timing per tier (A); probabilities (D) | Block hold 2.0→1.1 s; block cooldown per tier | PARTIAL (NOT TESTED) |
| **Combat: charged attack** | Released after exactly 1.0 s. "Hold while the enemy blocks" logic is dead: `ChargeTime` starts at 1.0 = `MaxHoldTime` | Literals (A) [C bytecode: `ConsiderAttacking` releases when the enemy isn't blocking, or `ChargeTime > MaxHoldTime`, or `ChargeToShoveChance == 0` (native 0.5); `ChargeTime += DeltaSeconds` each tick] | Hold range per tier; Experienced and up start `ChargeTime` at 0 and wait out a block for up to 1.4 / 1.8 / 2.2 s | PARTIAL (NOT TESTED) |
| **Combat: dodge** | No dodge behaviour; incoming projectiles only raise threat | Needs a new task (F) or a native move-request hook (E) | — | BLOCKED |
| **Combat: parry** | The game's melee is attack / block / shove; `EAIAction` has no parry | N/A | — | N/A |
| **Combat: bow** | Bow beyond 250 uu (point blank); draw 0.5–1.0 s; forced release 2.0 s; archers walk toward world origin while drawing (`DestinationKey` bug) | Draw literals (A); key fix (A, existing FName); switch distance (D) | Draw and release per tier; `DestinationKey` → `SelfActor` in every tier (archers hold position while drawing) | PARTIAL (NOT TESTED) |
| **Resources (loot, heal, armour)** | Healing and armour score 1 < fists 5, so they are never looted. Guns, grenades and traps are looted but never used (usable classes: melee, bow, spray) | Scores (A). Healing *during* a fight needs Flee to be selected (E) | Healing/armour 6–9, unusable items 2–3 (Casual and up) | PARTIAL (NOT TESTED) |
| **Team coordination** | Threat skips teammates (TeamNumber); no shared targets, no attacker cap. A Duo teammate exists on unmerged branch `duo-bot-teammate` | Attacker cap or focus fire: native hook in `FindBestEnemyTarget` (E) | — | BLOCKED (needs E) |
| **Adaptation** | None | Per-match tier by URL needs E. Learning across matches: section 6 | Scripted tiers chosen at build time | BLOCKED |
| **Aim error / leading** | Aim = controller focus (instant) + weapon spread; no leading | Native hook on focal-point or control-rotation update (E) | — | BLOCKED (needs E) |
| **Low-health retreat** | Never: no code writes `Action = Flee`, and the Flee branch's `UseItem` reads the wrong key | Native hook in `SelectAction` (E) plus a key fix (A) | — | BLOCKED (needs E) |

---

## 5. What was implemented

### 5.1 `patch/make_bot_ai.py`

`python patch/make_bot_ai.py <Paks dir> [--tier beginner|casual|experienced|advanced|elite] [--out DIR] [--list]`

- Reads **stock** copies only, from every base pak and never a `*_P.pak`, so a rebuild can't stack on an installed patch.
- Edits values in place, the same size. It adds no names, imports or exports.
- Writes the result to `patch/src/`, which `make_pak.py` packs.
- The default tier is **experienced**.
- Each property is found by its path, e.g. `ThreatParams.MaxDistance` or `DestinationKey.SelectedKeyName`, with a nested tagged-property walker.
- Each bytecode literal is found by its token pattern, never by a fixed offset:
  - `EX_CallMath RandomFloatInRange` followed by two `EX_FloatConst`;
  - `EX_Let <prop> EX_InstanceVariable <prop> EX_FloatConst`;
  - an `EX_StringConst "StopPrimary"` followed by `EX_FloatConst`.
- Every edit asserts the stock value first and stops on anything else.
- Switching to a tier with loot off deletes the item copies a previous build left in the output folder, so those items revert to stock.

| | Beginner | Casual | Experienced (default) | Advanced | Elite | Stock |
|---|---|---|---|---|---|---|
| Combat decision interval (`SelectAction_C_3`, ±0.1 s engine default) | 0.60 s | 0.40 | 0.25 | 0.15 | 0.08 | 0.001 |
| Scavenge decision (`SelectAction_C_24`) | 1.0 s | 0.8 | 0.6 | 0.5 | 0.4 | 0.6 |
| Retarget (`FindBestTarget_C_1`) | 2.0±0.5 | 1.5±0.4 | 1.0±0.25 | 0.75±0.2 | 0.5±0.1 | 1.0±0 |
| Hearing poll (`Listen_C_0`) | 6.0±1.5 | 5.0±1.2 | 4.0±1.0 | 3.0±0.75 | 2.5±0.5 | 4.0±1.0 |
| Sight radius / lose / half-angle | 2000/3000/55° | 2750/4000/65° | 3500/5000/75° | 3500/5000/75° | 4000/5500/80° | 3500/5000/75° |
| `ThreatParams.MaxDistance` (= sight radius) | 2000 | 2750 | 3500 | 3500 | 4000 | 3500 |
| Threat per metre closer | 6 | 6 | 5 | 4 | 4 | 6 |
| Memory: sight / damage MaxAge | 4 / 6 s | 6 / 8 | 8 / 10 | 12 / 12 | 16 / 15 | 60 / 30 |
| Charged-attack hold (both timers) | 1.0–1.0 s | 0.8–1.2 | 0.6–1.4 | 0.5–1.5 | 0.5–1.5 | 1.0–1.0 |
| Waits out a raised block, max | never | never | 1.4 s | 1.8 | 2.2 | never |
| Block held / block cooldown | 2.0 / 2.0–3.0 s | 1.75 / 1.5–2.5 | 1.5 / 1.0–1.5 | 1.25 / 1.0–1.5 | 1.1 / 0.8–1.2 | 1.5 / 1.0–1.5 |
| Bow draw before release check / forced release | 1.0–1.8 / 3.0 s | 0.8–1.4 / 2.5 | 0.6–1.1 / 2.0 | 0.5–1.0 / 2.0 | 0.5–0.9 / 1.8 | 0.5–1.0 / 2.0 |
| Loot rebalance | off | on | on | on | on | — |
| Archers hold position while drawing | yes | yes | yes | yes | yes | no (walk to origin) |

The table is printed by `python patch/make_bot_ai.py --list`.

**Every tier is fairer than stock where stock is superhuman.** Stock re-rolls its combat decision every frame and remembers a target for 60 s, and every tier is slower to decide and forgets sooner. Expect **Experienced to be noticeably easier to land charged attacks on than the current game** [I]. Elite is the closest to stock's melee reflexes while still taking a human-scale 0.08 ± 0.1 s per decision.

**No tier touches** health, damage, stamina, movement speed, spawn loadouts or anything a player has.

**Loot rebalance (Casual and up).** These are the `BotWeaponScore` changes:

| Items | Stock | New |
|---|---|---|
| Bandage | 1 | 8 |
| Medkit | 1 | 9 |
| HemoDrip | 1 | 7 |
| CraftedBandage | 1 | 6 |
| BodyArmor | 1 | 9 |
| CrudeArmor | 1 | 7 |
| Backpack | 1 | 9 |
| Satchel | 1 | 6 |
| Rifle, SMG, 357 | 40 | 3 |
| AlarmGun | 10 | 3 |
| Dynamite, ImpactGrenade | 30 | 3 |
| GasGrenade, RemoteExplosive, CraftedExplosive, CraftedSmokeBomb | 20 | 3 |
| CraftedMine, ExplosiveMine, CraftedPunjiSticks | 20 | 2 |
| SteelPunjiSticks | 15 | 2 |
| CraftedCaltrops | 10 | 2 |
| SteelCaltrops | 15 | 2 |

- Healing and armour stay between the fists (5) and the weakest melee weapon (10), so they are looted but never chosen as a weapon.
- The parent classes were checked [C]: the guns are `ShooterWeapon_Instant`; the grenades, mines and caltrops are `Weapon_Grenade`, `DeployableWeapon`, `WeaponRemoteClaymore` and `Weapon_Caltrops`. The AI's weapon check accepts none of these.
- `WeapStunGun` and `WeapJavelin` are `Weapon_Melee`, so they are unchanged. `WeapAutoBow` (`Weapon_Autobow`) is unchanged because its relation to `Weapon_Bow` wasn't verified.

### 5.2 Other changes

- `patch/patch_assets.py` no longer edits the AI.
  - PR #10's interval and sight values are replaced by the tiers. Its 5000/6500 sight and 90° half-angle (a 180° cone) are dropped, per the audit's R6.
  - The `EQS_TUNING` entry is removed. It was a no-op (audit finding 9).
  - `make_bot_ai.py` alone now owns `MatchBot`, `BasicController`, `MeleeCharge`, `MeleeBlock`, `FireProjectile` and the 24 item blueprints.
- No player-facing text was added or changed. The generator writes only numeric values and one existing FName, and the test checks that each package's name table is unchanged.

---

## 6. Machine learning: design, and why it is blocked

No "Mandriod" exists, so this section assumes a real framework. Candidates:

- **PyTorch** (BSD-3), to train;
- **ONNX Runtime** (MIT), whose C API runs on Windows x64 and could be loaded as a DLL;
- **TFLite / LiteRT** (Apache-2.0).

Licensing allows any of them. The blockers are the game's, not the libraries'.

**Where a policy could plug in.** Replace the `SelectAction` and `UpdateObjective` natives through their exec thunks, the same pattern as `sd_rand_exec`. The policy then writes the blackboard `Action` and `Objective` enums, which the existing tree executes. The tree, tasks and navmesh stay as they are.

**Observations** (per bot, at each decision), read natively:

- own health and stamina;
- current weapon class and ammo;
- for the target: distance, bearing, facing, and whether it is winding up or blocking (`IsEnemyBlocking`);
- line of sight (`HasWeaponLOSToEnemy`);
- the `ThreatArray` top 3 (distance, damage dealt, shots);
- `Status` (gas, iris, snare, blinded);
- distance to the iris and to the nearest pylon;
- inventory scores.

**Actions** are the existing `EAIAction` values (Jab, Charged, Block, Shove, Projectile, UseItem, Craft, Interact, Wait, GoTo, Reposition, Flee) and `EAIObjective` values (Scavenging, Stalking, MeleeCombat, RangedCombat).

**Rewards:**

- damage dealt minus damage taken;
- a bonus for a kill and a penalty for dying;
- a small reward per second survived;
- a penalty for time in gas;
- for difficulty shaping, a *target* win rate against players, not maximum strength.

| Blocker | Why | Possible way around |
|---|---|---|
| Training throughput | The client runs in real time only. There is no headless or faster-than-real-time mode, no dedicated server build (KNOWN_ISSUES), and resets mean whole matches (~15 min). That is at most ~23 agents × a few decisions per second | Imitation learning from recorded player and stock-AI decisions (logged by the native module), then offline RL. Online RL is impractical |
| Observation and action plumbing | Needs native hooks and struct offsets for health, stamina, weapon and wounds per pawn. Some are known; most need RE | Native-module work (E): ~1–2 weeks |
| Inference host | The native module is a no-CRT blob with no imports. Loading `onnxruntime.dll` needs `LoadLibraryW`/`GetProcAddress`, reached through the exe's import table. The model and DLL must ship through the launcher | 1 week, plus signing and release work |
| Determinism and testing | No replay or determinism; every check is a manual match through the launcher | A logging harness; a long playtest loop |
| Fairness | A learned policy must still respect human reaction limits | Keep the tier interval floors as action rate limits |

**Status: BLOCKED.** It is feasible only as a multi-week native project (about 4–8 weeks to a first imitation-learned policy, with no guarantee it beats the scripted tiers). The scripted tiers here are the practical route, and they are labelled as scripted.

---

## 7. Status

| Item | Status | Evidence |
|---|---|---|
| "Mandriod" research | PASS | Section 1; no such framework |
| Architecture map from stock data | PASS | Section 2; offsets and hashes match the audit |
| `make_bot_ai.py`: 5 tiers build | PASS | 29 packages for Casual and up, 5 for Beginner |
| `test_bot_ai.py` | PASS | See below |
| Mutation check of the test | PASS | Flipping one stray byte, or misordering a tier, makes it fail |
| `patch_assets.py` still runs after the change | PASS | Writes the game mode, phase manager and maps; no AI assets |
| Pak round-trip | PASS | `make_pak.py` on `patch/src`, then the AI entries read back identical |
| Tiers in a real match | NOT TESTED | No match was played (section 8) |
| Per-match tier by URL option | BLOCKED | No such option exists natively; needs E |
| Per-mode tier | NOT DONE | Possible for controller-level values with C; the tree is shared |
| Exe-constant changes (bow switch, dice, hearing) | NOT DONE | D; next steps |
| Dodge, aim error, retreat, team coordination, adaptation | BLOCKED | Need E or F |
| ML | BLOCKED | Section 6 |

`test_bot_ai.py` checks, for each tier:

- every package keeps its size and re-saves byte for byte through `ue_package.py`;
- the name, import and export tables are stock, and every import resolves;
- only the intended bytes differ, and each value reads back;
- every property written is on the allow list;
- `SelfActor` is an object key of the blackboard;
- the tiers are ordered, and the loot scores are in range;
- no other generator names the AI assets;
- `patch/src` holds one complete tier.

---

## 8. In-game checks (to run through the launcher against the VPS)

Build `patch/src` with the tier under test. Then:

1. `python patch/make_bot_ai.py <Paks> --tier <t>`
2. `python patch/test_bot_ai.py <Paks>`
3. Make a release.

Play Solo on Jungle at least 3 times per tier. Say which install was used: the sandbox copy or the user's own.

- [ ] **Load:** the match starts with the usual contestant count, and no log errors mention MatchBot or BasicController.
- [ ] **Melee reaction:** start a charged attack from 2–3 m, 10 times. Count blocks. Stock blocks almost every one. Expect fewer on Experienced, more on Elite, and few on Beginner.
- [ ] **Waiting out a block (Experienced and up):** hold block against a charging bot. It should sometimes keep charging until you lower your block, instead of swinging into it at 1.0 s.
- [ ] **Memory:** get spotted, break line of sight, and hide for 15 s. On Experienced the bot should stop tracking within about 10 s. Stock walks straight to you.
- [ ] **Archers:** a bot drawing a bow holds position instead of walking toward the map middle.
- [ ] **Loot (Casual and up):** a damaged bot picks up and uses bandages out of combat. No bot is seen carrying a gun or grenade.
- [ ] **Sight:** a Beginner bot notices you in the open at about 20 m, not 35 m. An Elite bot notices you at about 40 m.
- [ ] **Regression:** bots still wander, loot, escape snares, and flee the iris and gas; none are stuck or spinning; frame time is within ~1 ms of stock. Showdown's rival still fights with the round's kit.

---

## 9. Continuation plan

| # | Work | Route | Effort | Notes |
|---|---|---|---|---|
| 1 | Playtest the tiers (section 8) and pick the shipping tier | — | 0.5–1 day | Required before release |
| 2 | Bow/melee switch 250 → 700 uu; melee dice probabilities | D (`patch_exe.py`, repoint loads to existing constants; addresses in BOT_AI_AUDIT R11/R12) | 1 day + test | Exe change ships with full releases |
| 3 | Per-match tier by URL option (`?AITier=N`, not shown to players) | E: parse `OptionsString` (+0x400) once per match; write `ThreatParams`/stickiness/`WeaponParams` on every `AShooterAIController` (fields 0x610–0x634). For tree and perception values, write the template nodes (`MatchBot:SelectAction_C_3.Interval`, the sense configs) before the first bot spawns, via `StaticFindObject` | 2–3 days (controller fields) + 3–5 days (templates), plus a harness in `test_native_module.c` | The launcher or menu would then need a selector worded without "bots" |
| 4 | Per-mode controller tier (e.g. Showdown's rival) | C: a copy of `BasicController` at a new path, with tier values; repoint the mode's `BotControllerClass` import | 1–2 days | Perception, memory and threat only; reaction stays global |
| 5 | Low-health retreat and in-fight healing | E: in `SelectAction`, set `Action = Flee` below an HP threshold; fix `UseItem_C_0.ItemKey` (A) | 3–5 days | |
| 6 | Aim error and leading for bows, per tier | E: offset the focal point before `UpdateControlRotation` | 3–5 days | |
| 7 | Attacker cap / focus fire / Duo teammate support | E: in `FindBestEnemyTarget` | 2–4 days | Merge with `duo-bot-teammate` |
| 8 | Hearing radius per tier | D/E (code cave; the constant is shared by 12 sites) | 1–2 days | |
| 9 | Imitation-learning pipeline | Section 6 | 4–8 weeks | Only after 3 and 5–7 exist as hooks |
