# Bot AI audit: fighting, looting, decisions, target priority

Read-only investigation of how the offline-match bots in The Culling ("Victory", UE 4.15, 2016) think. It covers what they do today, where that is unrealistic or exploitable, and what can be changed without the original project. Nothing in the game install was modified, and the game was not launched. None of the behaviour claims below were observed in a match; see "Evidence labels".

## Evidence labels

- **[C] Confirmed**: read directly from shipped data, with the location given. This means cooked asset properties, Kismet bytecode disassembled from the cooked blueprints, or x64 disassembly/decompilation of `Victory.exe`.
- **[I] Inferred**: a conclusion drawn from confirmed code plus UE 4.15 engine semantics, or a guess about in-game effect. Every [I] item needs a playtest to confirm.
- Asset offsets are byte offsets in the stock `.uasset`, which was extracted from `pakchunk3/11-WindowsClient.pak`, not from the patch pak. Exe addresses are virtual addresses in `Victory.exe` (SHA-256 `bd818b91d78d…f8758`, image base `0x140000000`).

## Method (short)

- **Assets.** Extracted every `Blueprints/AI/**` asset, all game modes, 123 weapon/item blueprints and the ini files from the stock paks into a scratch folder, using the repo's `build_catalog.pak_entries` and `read_entry`. Tagged properties were dumped recursively with an extension of `patch/uasset.py`, which handles nested structs and struct arrays.
- **Bytecode.** Every behaviour/decorator/service/context blueprint was disassembled with a small UE 4.15 Kismet disassembler. Its in-memory offsets were checked against `ScriptBytecodeSize` for each function.
- **Behavior tree.** `MatchBot` was rebuilt from `RootNode` → `Children[].ChildComposite/ChildTask/Decorators/DecoratorOps` → `Services`.
- **Exe.** Native functions were located through `StaticRegisterNativesAShooterAIController` at `0x140311320`. Each `execX` thunk tail-jumps to the implementation. The code region `0x140200000–0x140240000` plus `.rdata` and primary `.pdata` entries was decompiled with Ghidra 12.1.4 headless. A full-exe Ghidra import timed out at 53 MB. Field names come from UHT registration code, for example `mov r9d, 0x5b4` next to `L"BotWeaponScore"` at `0x1403aeefd`.

---

## Executive summary

### Top findings

1. **[C] Combat decisions run every frame.** In combat, `MatchBot`'s `SelectAction_C_3` service has `Interval = 0.001` s (`BTComposite_Selector_4`; `RandomDeviation` uses the engine default). Each run, the native melee chooser (`0x14021f960`) rolls a fresh die to block or shove:
   - **Block:** 0.4 chance if the enemy is winding up a melee attack within 400 uu and facing the bot, otherwise 0.1.
   - **Shove:** 0.5 chance if the enemy is blocking (within 175 uu), otherwise 0.1.

   [I] At roughly 10–60 rolls per second, a bot facing a charging player blocks within about 0.1–0.2 s almost every time. That is faster than human reaction and the main reason melee bots feel "psychic".
2. **[I] Bots remember a target for up to 60 s and track its real position.** `BasicController`'s sight config has `MaxAge = 60` (damage `MaxAge = 30`).
   - [C] Target threat requires only an unexpired perception stimulus (`0x140fd1700`, called with the "include not-currently-sensed" flag from the threat function `0x1402183c0`).
   - [C] The chase task moves to the `Enemy` actor itself (`RapidMoveTo_C_41`, `Target = Enemy`), not a last-known location.
   - [I] Combined, breaking line of sight does not lose a bot for up to a minute.
3. **[C] Target choice is the argmax of a simple per-bot threat score.** Scoring is `0x1402183c0`; the choice is `FindBestEnemyTarget` (`0x140219020`).
   - **Formula:** `max(0, 3500 − dist) × 0.01 × 6` + 2 × damage the target dealt to this bot + 3 × projectiles it fired at the bot + a stickiness bonus (50 decaying to 5 over 7 s for the current target).
   - **What it ignores:** players and bots score the same way, and nothing counts how many bots are already attacking a target, so dogpiles are neither prevented nor encouraged.
   - **Range limit:** anything beyond 3500 uu that has not hurt the bot scores 0 and is never picked.
4. **[C] Bots never retreat at low health and never "flee".**
   - The tree has a Flee/Find Cover branch, but no native or blueprint code in the AI controller ever writes `EAIAction::Flee` (9). [C] There is no `mov …, 9` in `0x140215000–0x140223000`, and no behaviour blueprint sets it.
   - That branch only runs when the bot has no weapon (`Weapon is NotSet`).
   - Its "Use Bandage" step reads the wrong key (`ItemKey = SelfActor`), so it can never succeed.
5. **[C] Looting is driven by one integer per item, `BotWeaponScore`** (`AShooterWeapon+0x5b4`). A bot loots an item when its score beats the lowest-scoring item it carries (`0x14021b860`, `0x14021f310`). Every bot always carries fists (score 5), and the scores look like this:
   - **Never looted:** healing items and most armour score 1, so they are below fists. Bots spawn with a random healing item about 37% of the time but never pick more up.
   - **Always wanted:** all bows score 100, more than any gun or melee weapon.
   - **Looted but useless:** guns (40), grenades, mines and traps (10–30) are looted. [C] The weapon-usability check `0x140218990` only accepts `AWeapon_Melee`, `AWeapon_Bow` and `AWeapon_Spray`, and `SelectAction` only has choosers for those three classes. [I] So bots never use what they loot from those categories.
6. **[C] Bots switch to the bow at 250 uu (2.5 m).** `UpdateObjective` (`0x140220de0`, constant at `0x140220fd0`) picks ranged combat whenever the bot has a bow with ammo and the enemy is farther than 250 uu, so bots open fire at point-blank range. Melee only starts inside 250 uu.
7. **[C] Several timings are fixed, so a player can learn them:**

   | Action | Timing | Where |
   |---|---|---|
   | Charged attack | Held exactly 1.0 s: `RandomFloatInRange(1, 1)` | `MeleeCharge` bytecode |
   | Wait for a blocking enemy | Dead code: `ChargeTime` starts at 1.0, which already equals `MaxHoldTime` 1.0 | `MeleeCharge` bytecode |
   | Block | Held 1.5 s | `MeleeBlock.TimeToHoldBlock` |
   | Jab | Release after 0.1 s | `MeleeJab` bytecode |
   | Bow | Released 0.5–1.0 s after draw if there is line of sight, forced at 2.0 s | `FireProjectile` bytecode |
   | Next decision after the enemy enters bow range | Locked for 2.5–4.0 s | `0x14021deb0` |
8. **[C] While shooting, archers walk toward world origin (0,0,0).**
   - `FireProjectile_C_0` reads `DestinationKey = Destination`, a vector key, as an actor. That returns null, so `CreateMoveToProxyObject(…, Destination = (0,0,0), TargetActor = null, 100)` moves to (0,0,0).
   - [C] The game treats (0,0,0) as map centre (`CenterContext` returns `vec(0,0,0)`; `0x14021c210` measures distance from origin).
9. **[C] The current main patch's "wander toward the middle" change does nothing.**
   - `EQS_TUNING` sets `DirectnessToCenterWeight = 1.5` on `BTTask_RunEQSQuery_1`. That parameter only exists in the task's legacy `QueryConfig` copy (offset 59899), not in the `EQSRequest` copy that the editor saved last ([I] the live copy).
   - [C] The `Scavenge` query it runs has no test bound to `DirectnessToCenterWeight` at all. Its params are `MaxDistanceToSelf`, `Density`, `MinDistanceToSelf`, `DistanceToSelfWeight`, `Min/MaxDirectnessToTarget`, `DirectnessWeight` and `DirectnessToActiveAirDropWeight`.
   - The installed patch pak contains exactly this edit (bytes 59899–59902 changed `0.0 → 1.5`).
10. **[C] PR #10's sight change is mostly ineffective, and its 0.6 → 0.3 s "next action" change does not touch fighting.**
    - Sight beyond 3500 uu adds nothing, because threat is 0 past `ThreatParams.MaxDistance = 3500`.
    - `PeripheralVisionAngleDegrees` is a half-angle, so 90° is a 180° cone.
    - `SelectAction_C_24` is the scavenging-branch instance. The combat instance (`SelectAction_C_3`) already runs every frame.

### Top 5 changes, ranked by realism gain per risk

| # | Change | Tier | Risk | What it fixes |
|---|---|---|---|---|
| 1 | `MatchBot` `SelectAction_C_3.Interval` **0.001 → 0.25** (the engine-default ±0.1 s deviation stays) | T2 | Low | Superhuman block/shove reaction. The block/shove dice are rolled ~4×/s instead of every frame, so the expected time to a block becomes roughly 0.3–0.7 s instead of ~0.1 s. |
| 2 | `BasicController` `AISenseConfig_Sight_1.MaxAge` **60 → 8**; `AISenseConfig_Damage_1.MaxAge` **30 → 10** | T2 | Low | Minute-long "knows where you are" tracking after you break line of sight. |
| 3 | `BotWeaponScore` rebalance: healing/armour **1 → 6–9**; guns/explosives/traps the bots can't use **→ 0–4** (values in R3) | T2 | Low | Bots never pick up healing or armour; bots waste inventory and trips on items they cannot use. |
| 4 | `MeleeCharge` bytecode literals: hold time `RandomFloatInRange(1,1)` → **(0.6, 1.4)** at both sites; `ChargeTime` init **1 → 0**; `MaxHoldTime` **1 → 1.8** | T2 (bytecode literal) | Low–medium | Metronomic 1.0 s charged attacks; bots now vary timing and hold a charge into a block instead of always swinging into it. |
| 5 | `MatchBot` `FireProjectile_C_0.DestinationKey` FName **`Destination` → `SelfActor`** | T2 (FName swap) | Low–medium | Archers drifting toward map origin while shooting; they stand and shoot instead. |

Next in line: R6, aligning PR #10's sight with `ThreatParams.MaxDistance` (T2), and R11, the 250 → 700 uu bow/melee switch (T4, one 4-byte displacement patch).

---

## 1. AI asset inventory

All paths are under `Victory/Content/Blueprints/`. "Used by MatchBot" means referenced by the tree the match bots run.

| Asset | Class | Pak | Used by MatchBot | Notes |
|---|---|---|---|---|
| `AI/Trees/MatchBot` | BehaviorTree | chunk3 (+ patch pak copy) | Tree | The match bot brain (section 3) |
| `AI/Trees/SimpleBot` | BehaviorTree | chunk3 | — | Survival bots (`BasicBot_Child_Survival.BotBehavior`); adds `CheckWeak`, `LookAround`, `ValidateTarget` |
| `AI/Trees/BlockOnly`, `ChargeOnly`, `RunForwardBot` | BehaviorTree | chunk11/3 | — | Tutorial bots, decoy (`DecoyBot`) |
| `AI/Base/BasicBlackboard` | BlackboardData | chunk3 | Yes | 10 keys (section 3.1) |
| `AI/Base/BasicController` | BP of `AShooterAIController` | chunk3 | Yes | Perception, `ThreatParams` (section 4) |
| `AI/Base/BasicController_ManDroid` | BP controller | chunk3 | — | Cosmetics only |
| `AI/Base/BasicBot` | BP of `AShooterBot` | chunk3 | Yes ([I] match pawn) | `BotBehavior = MatchBot`, `AIControllerClass = BasicController`, loadout lists |
| `AI/Base/BasicBot_Child_*`, `SurvivalBot_*`, `DecoyBot`, `BasicBot_Clone*` | BP pawns | chunk3/11 | — | Tutorial, survival waves, decoy |
| `AI/Behaviors/*` (15) | `BTTask_BlueprintBase` | chunk3 | 11 of 15 | `Craft`, `EscapeSnare`, `FireProjectile`, `MeleeBlock`, `MeleeCharge`, `MeleeJab`, `MeleeShove`, `QuickLook`, `RapidMoveTo`, `StopMovement`, `UseItem`. Unused: `CheckWeak`, `ForceChargedAttack`, `LookAround`, `RunForward` |
| `AI/Decorators/IsPathing`, `NearLocation` | `BTDecorator_BlueprintBase` | chunk3 | Yes | Move-status and radius gates |
| `AI/Services/*` (8) | `BTService_BlueprintBase` | chunk3 | 7 of 8 | Each is a one-call wrapper around a native `AShooterAIController` function (section 2). `ValidateTarget` is only in SimpleBot. |
| `AI/EQS/*` queries (11) | EnvQuery | chunk3 | Yes | `AvoidGasPylon`, `Backoff`, `FindNewHealthStation`, `FiringPosition`, `MapClosing`, `NearestHealthStation`, `PointAroundSelf`, `PointTowardsTarget`, `QuickCover`, `Scavenge`, `Stalk` |
| `AI/EQS/*Context` (7) | EnvQueryContext BPs | chunk3 | Yes | `CenterContext` = (0,0,0); `EnemyContext`/`TargetContext` = blackboard keys; `ActivePylonsContext` via `PylonManager`; `ActiveAirDropsContext` = `CargoDropTarget_C` within 25000 uu; `HealthMachineContext`; `ForwardContext` |
| `GameMode/VictoryGameMode` (+13 variants) | Game mode | chunk3 | — | `BotControllerClass = BasicController`, `BotsToSpawn = 15` (exe cap 16 total). Classic sets no `BotPawnClass`; Practice/Tutorial set `BasicBot_C`. |
| `Weapons/*`, `Items/*` (123 extracted) | Weapon/item BPs | chunk3 | Yes | `BotWeaponScore` per item (section 6) |
| `DefaultGame.ini`, `BaseGame.ini`, `BaseEngine.ini`, `DefaultEngine.ini` | Config | chunk0 | — | No AIModule overrides in the game's own ini; engine defaults apply (AISense/EQS budgets, `AISystem`) |

---

## 2. Who decides what

The behavior tree is a thin shell. Every service is a blueprint whose only node calls one native function on the controller. [C] This shows in each service's imports, for example `Listen` → `ShooterAIController.CheckBotHearing`.

| BT service (blueprint) | Native function | Implementation VA (exec thunk) | Role |
|---|---|---|---|
| `FindBestTarget` | `FindBestEnemyTarget` | `0x140219020` (`0x14035cf20`) | argmax over `ThreatArray` (section 4) |
| `SelectAction` | `SelectAction` | `0x14021ee10` (`0x14036b330`) | Writes `Action`; per-weapon choosers below |
| `SelectBestWeapon` | `SelectBestWeapon` | `0x14021f010` (`0x14036b350`) | Equip highest `BotWeaponScore` usable weapon |
| `UpdateObjective` | `UpdateObjective` | `0x140220de0` (`0x140373cd0`) | Writes `Objective` |
| `UpdateBotStatus` | `UpdateBotStatus` | `0x140220810` (`0x1403738c0`) | Writes `Status` (iris) |
| `Listen` | `CheckBotHearing` | `0x140218d00` (`0x14035ab50`) | Hearing → investigate |
| `FindScavengingTarget` | `UpdateScavengingTarget` | `0x1402211e0` (`0x140374090`) | Loot target and give-up timer |
| `ValidateTarget` (SimpleBot only) | `ValidateTarget` | `0x140221360` (`0x1403741d0`) | Stuck-on-target blacklist |

Other natives used by the tasks or events:

| Function | VA | Called from / role |
|---|---|---|
| `SelectMeleeAction` | `0x14021f960` | Melee chooser |
| `SelectBowAction` | `0x14021fc70` | Bow chooser |
| `SelectSprayAction` | `0x14021fe50` | Pepper-spray chooser |
| `SelectInventoryAction` | `0x14021f310` | No-enemy action choice |
| Interact chooser | `0x14021f240` | No-enemy action choice |
| GoTo chooser | `0x14021f1a0` | No-enemy action choice |
| Threat score | `0x1402183c0` | Used by `FindBestEnemyTarget` |
| `HasWeaponLOSToEnemy` | `0x14021bb40` | Trace `AIWeaponLosTrace` |
| `IsEnemyBlocking` | `0x14021c680` | Melee chooser, `MeleeCharge` |
| `OnCharacterMakingNoise` | `0x14021d4e0` | Hearing |
| Perception update → `ThreatArray` | `0x140218000` | Perception events |
| `OnBotTakeDamage` (adds damage) | `0x14021d380` | Damage events |
| `OnBeingFiredAt` (adds projectile count) | `0x14021d2a0` | Projectile events |
| `OnEnemyStunned` | `0x14021d760` | Punish a stunned enemy after 0.3–0.8 s |
| `PauseSelectAction` timer | `0x14021deb0` | Bow chooser, `OnEnemyStunned` |
| `SetRandomFocalPoint` | `0x1402202d0` | Look 1000 uu in a random direction |
| `OnScavengingFailed` | `0x14021da90` | Swap worst inventory item |
| Wounds → `Status` | `0x14021eb80` | Wound 0xE → Blinded; wound 5 → Gassed ([I] the gas wound) |

Controller fields: [C] constructor at `0x140217a9b`; names from UHT registration, `ThreatParams` at `0x140387796`, `ThreatArray` at `0x140387585`.

| Offset | Field | Native default | `BasicController` override |
|---|---|---|---|
| `0x610` | `WeaponParams`: melee range | 175 uu | — |
| `0x614` | `WeaponParams`: bow range | 6000 uu | — |
| `0x618` | `WeaponParams`: spray range | 150 uu | — |
| `0x61c` | `ThreatParams.ThreatPerMeterCloserThanMaxDistance` | 10 | **6** (asset @20445) |
| `0x620` | `ThreatParams.MaxDistance` | 1000 | **3500** (@20474) |
| `0x624` | `ThreatPerPointOfDamageDealtToBot` | 2 | — |
| `0x628` | `ThreatPerProjectileFiredAtMyBot` | 3 | — |
| `0x62c` | `StickinessMaxThreatOnTargetSelection` | 50 | — |
| `0x630` | `StickinessMinThreatAfterDecayTimeExpired` | 5 | — |
| `0x634` | `StickinessThreatDecayTime` | 7 s | — |
| `0x638` | `ThreatArray` (24 B entries: actor, damage float, projectile int) | — | — |

Fields marked "—" are not stored in the asset, so they cannot be patched same-size (T2). Changing them needs T3 (add tagged properties) or T4.

---

## 3. Decision-making: the behavior tree

### 3.1 Blackboard (`BasicBlackboard`) [C]

| Key | Type | Notes |
|---|---|---|
| `SelfActor` | Object (Actor) | Pawn |
| `Enemy` | Object (`ShooterCharacter`) | Current target |
| `Weapon` | Object (`ShooterWeapon`) | Item chosen by the inventory logic |
| `Objective` | Enum `EAIObjective` | None 0, Stalking 1, RangedCombat 2, MeleeCombat 3, Scavenging 4, Turtling 5 (unused) |
| `Destination` | Vector | |
| `Status` | Enum `EAIPriorityStatus` | None 0, Gassed 1, Iris 2, Stuck 3, Blinded 4, Snared 5 |
| `Action` | Enum `EAIAction` | None 0, Jab 1, Charged 2, Block 3, Shove 4, Projectile 5, UseItem 6, Craft 7, Hide 8 (unused), Flee 9 (never written), Interact 10, Wait 11, GoTo 12, Reposition 13 |
| `Target` | Object (Actor) | Loot or interact target |
| `IsWeakorFeeble?` | Bool, **`bInstanceSynced = True`** | Shared across every bot. Nothing in MatchBot sets it; `MeleeBlock`/`MeleeCharge` read it. Harmless today but a trap for future edits. |
| `WanderCenterDestination` | Vector | |

Enum names and values are [C] from exe strings at `0x2622130` and on.

### 3.2 Tree structure (`MatchBot`) [C]

Notation: `[decorator]`; `{service: interval ± deviation}`. "Gate" means the pattern `ForceSuccess AND (ReachedMoveGoal OR NOT IsPathing OR NearLocation(Destination, r))`, which reruns an EQS only once the previous move has finished. "dflt" means a value not stored in the asset, so the engine default applies (BT service 0.5 ± 0.1 s).

```
ROOT Selector_0 {FindBestTarget 1.0±0} {UpdateBotStatus 0.5(dflt)±0} {UpdateObjective 0.5(dflt)±0}
├─ [Status != None, abort LowerPriority] "Emergency" Selector_73
│   ├─ [Status==Snared, Both] EscapeSnare            (find SnareWound within 1000, crouch+use after 0.5 s)
│   ├─ [Status==Blinded, Both] Seq_0: [gate 800] EQS PointAroundSelf(200–1100, density 250, RandomBest25%) → Destination
│   │                                  RapidMoveTo Destination r100
│   ├─ [Status==Stuck, Both][Objective != RangedCombat, Both] Seq_67:
│   │     Selector_97: [Enemy set] EQS QuickCover "Move To Center"(1000–4000, d100, enemy 800–10000, Visibility 1, Directness −0.8)
│   │                  [Enemy not set] EQS Backoff(600–2000, d200, DistanceToSelf −0.5, Directness −1, Best5%)
│   │     MoveTo Destination r100 strafe
│   ├─ [Status==Iris, Both] Seq_1: [gate 800] EQS MapClosing(1200–9000, d1000, DistToSelf 0.3, DirectnessToCenter 1.5, DistToCenter −1)
│   │                             RapidMoveTo r100
│   └─ [Status==Gassed, Both] Seq_66: [gate 800] EQS AvoidGasPylon(1200–4000, d400) → RapidMoveTo r100
├─ [Enemy set, abort LowerPriority] "Has Enemy" Selector_4 {SelectBestWeapon 0.1±0} {SelectAction 0.001±0.1(dflt)}
│   ├─ [Action==Flee OR Weapon not set] Seq_10: EQS QuickCover "Find Cover"(400–3000, d100, directness to enemy −1..0.2, enemy 800–10000)
│   │                                           MoveTo "Move To Cover"; [Action==UseItem] UseItem(ItemKey=SelfActor)  ← always fails
│   ├─ [Objective==MeleeCombat, Both] Seq_7 {UpdateObjective 0.5±0.1(dflt)}
│   │     ├─ Selector_8: [Cooldown 1.0][Action != None] Seq_6: EQS Stalk(125–500, d50, dir −0.3..0.8) → [TimeLimit 3] MoveTo r80 strafe
│   │     │              RapidMoveTo "Chase Enemy" Target=Enemy r170
│   │     └─ [ForceSuccess] Selector_6:
│   │          [Action==Charged] MeleeCharge  | [Action==Block][Cooldown 1.0–1.5] MeleeBlock
│   │          [Action==Jab] MeleeJab          | [Action==Shove] MeleeShove
│   │          [Cooldown ≤8] EQS FiringPosition "Flank"(200–400, enemy 200–5000, dir −0.7..0.9)
│   │          [Cooldown 4–15][gate 400] RapidMoveTo "Flank Enemy" r120
│   └─ [Objective==RangedCombat] Selector_36
│         ├─ [TimeLimit 0.5–2.0][Cooldown 1–3] Seq_8: RotateToFaceBBEntry Enemy
│         ├─ [Action==Projectile, LowerPriority] FireProjectile(Enemy, DestinationKey=Destination)
│         └─ Seq_47: [gate 400] EQS FiringPosition(200–3000, enemy 1200–5000, dir −0.7..0.5) → [Cooldown 1] RapidMoveTo r500
└─ [Enemy not set, abort Self] Selector_3 {Listen 4.0±1.0}
    ├─ [Objective==Stalking, Both] "Look For A Fight" Seq_3: RapidMoveTo Destination r100      (hearing sets Destination)
    ├─ [Objective==Scavenging, Both] "Find Stuff" Selector_68 {SelectAction 0.6±0.1(dflt)} {FindScavengingTarget 0.5±0.1(dflt)}
    │     ├─ [Action==UseItem, Both] UseItem(ItemKey=Weapon)
    │     ├─ Selector_52: [Action==Craft] Seq_4: RapidMoveTo Target r120 → Craft "Scavenge"(StartUse on Target)
    │     │               [Action==Interact] Seq_28: RapidMoveTo Target r100 → Craft "Interact"
    │     │               [Action==GoTo] Seq_5: [gate 800] EQS PointTowardsTarget(1600–4000, dir 0.5–1) → RapidMoveTo r100
    │     │                                    → [Cooldown 6–10][ForceSuccess] QuickLook (0.5–1.5 s)
    │     └─ [Action==Wait, Both] StopMovement
    └─ Selector_2 (fallback)
          ├─ Seq_2: [gate 200 + IsAtLocation 200][Cooldown 300 s] EQS FindNewHealthStation(MedStation_C, ≤50000)
          │         [Enemy not set, abort Self] RapidMoveTo "Health Station" r500 → [Cooldown 6–10] QuickLook
          └─ Seq_9: [gate 800] EQS Scavenge "Find Wander Position"(300–2500, d100, DistToSelf 1, Directness 1, AirDrop 1.5, Best5%)
                    RapidMoveTo WanderCenterDestination r500
                    [gate 800] EQS NearestHealthStation(MedStation_C ≤20000) → RapidMoveTo r150
```

### 3.3 Observations

- **Which EQS parameters are live.** Each `BTTask_RunEQSQuery` stores two parameter sets: a legacy `QueryConfig`/`RunMode` and an `EQSRequest`. [C] The two differ; for example "Find Wander Position" has a legacy `RandomBest25Pct`, 9 params, `MaxDistanceToSelf 4000`, against an `EQSRequest` with `RandomBest5Pct`, 8 params, `2500`. [I] `EQSRequest` is the live copy in UE ≥ 4.12. Its values look hand-tuned, while the legacy values match a copy-pasted sibling node. The tree above shows `EQSRequest` values.
- **[I] Idle bots loop past health stations.** When there is nothing to loot, every wander cycle ends with a walk to the nearest `MedStation_C` within 20000 uu (Seq_9). Health stations become predictable bot magnets.
- **[C] The Flee/Find Cover branch is entered only when `Weapon` is unset.** No code writes `Action = Flee`, and the `UseItem` there reads `SelfActor`, which the task casts to `DisposableWeapon`. That cast fails and the task finishes with failure. [I] It is effectively an "unarmed: run to cover" branch with no healing.
- **[C] Turtling and Hide are unused.** No tree branch tests `Objective == Turtling` or `Action == Hide`.
- **[C] Ranged branch timing.** The ranged branch's `RotateToFaceBBEntry` sequence is time-limited to 0.5–2.0 s with a 1–3 s cooldown. Firing runs at `LowerPriority` abort. Repositioning uses `FiringPosition`, whose sphere trace to the enemy scores items where the trace is blocked (engine default `BoolMatch = true`). [I] That means it prefers spots hidden from the enemy.

---

## 4. Target / goal priority

### 4.1 How a target is scored [C] (`0x1402183c0`)

1. **Exclusions.** A target scores 0 if any of these hold:
   - it is invalid or dead;
   - it is in the pawn's ignore list, or the pawn has `bIgnorePlayer` (`+0xed8`, not set on `BasicBot`) and the target is a player;
   - it has no unexpired perception stimulus (`0x140fd1700` with "include not-currently-sensed" = 1);
   - it is on the bot's team (the team check is only meaningful in pair modes).
2. **Score.**
   `threat = max(0, MaxDistance − dist) × 0.01 × ThreatPerMeter + ThreatPerDamagePoint × damageDealtToMe + ThreatPerProjectile × projectilesFiredAtMe`
   With `BasicController` values: `max(0, 3500 − d) × 0.06 + 2 × dmg + 3 × shots`.
3. **Stickiness.** For the current target only: `+ max(5, 50 × (1 − timeSinceSelected / 7))`.
4. **Selection.** `FindBestEnemyTarget` keeps the first strictly-greater score, so ties go to whichever entry entered `ThreatArray` first. A target only changes when the winner differs. If nothing scores above 0, the enemy is cleared.
5. **What fills `ThreatArray`** [C]:
   - perception updates (`0x140218000`): any perceived `ShooterCharacter` the bot is hostile to, or the instigator of a projectile aimed at it;
   - damage (`0x14021d380`, adds damage);
   - shots (`0x14021d2a0`, +1 projectile).

   Entries are removed when their stimulus expires. `0x14021ec10` zeroes all damage and shot counts and clears the enemy (inferred: on the current enemy's death or a reset).

### 4.2 What that means

| Question | Answer |
|---|---|
| Distance | Dominant. A target at contact scores 210 and at 2000 uu scores 90. Beyond 3500 uu it scores 0 unless it has hurt the bot. [C] |
| Health | Not used. Neither the bot's nor the target's health appears in the formula. [C] |
| Threat or last damager | Yes, via damage (2/pt) and shots (3 each). [C] A player who hits a bot for 30 gains +60, so bots retaliate against whoever hurts them. |
| Players vs bots | Identical scoring. [C] |
| Dogpiling | No coordination and no attacker cap; each bot picks independently. [C] [I] The player is not singled out, but a player who damages many bots draws them all, and a player near a group is everyone's nearest target. |
| Ties | First in `ThreatArray` order. [C] |
| Memory | Up to the stimulus `MaxAge`: 60 s sight, 30 s damage. [C] for the values. [I] for the effect: after line of sight is lost, the stimulus stays valid until `MaxAge`, and the chase uses the actor, not a last-seen point, so the bot keeps following the target's real position. |
| Hearing | Every 4 ± 1 s (`Listen`), each `ShooterCharacter` within 1000 uu (`1e6` = 1000² at `0x140218d71`) is checked. It is "heard" if its velocity exceeds a speed threshold read from its `UShooterCharacterMovement` ([I] its walk speed, so sprinting is heard), with no line-of-sight check. A noise makes the bot investigate the noise location (Objective = Stalking, Destination = noise) with probability `(1 − dist/10000) × (0.8 if the bot has a bow else 0.4)` (`0x14021d4e0`). Hearing does not set `Enemy`. [C] The flag/wound path that makes a character "heard" from any distance was not decoded. |

### 4.3 Goal priority (Objective and Status) [C]

- **`UpdateObjective` (`0x140220de0`).**
  - The default objective is Scavenging.
  - Stalking is kept while the noise destination is more than 1000 uu away.
  - With an enemy, the objective is **RangedCombat** if the bot has a bow with ammo and `dist > 250` (0 if the enemy is gassed). Otherwise it is **MeleeCombat** if the bot has a melee weapon and the enemy is not in gas (wound type 5).
  - [I] So bots don't chase into gas for melee, and shoot instead.
- **`UpdateBotStatus` (`0x140220810`).**
  - Sets **Iris** when the closing iris is within 2500 uu, or 5000 if already in Iris status.
  - That distance is ×0.15 if the bot is within 3000 uu of world origin and ×0.5 if it has an enemy.
  - [I] Bots in a fight let the iris get twice as close before running.
- **Wound-driven status (`0x14021eb80`).** Wound type 0xE → Blinded; wound type 5 → Gassed. Snared is set elsewhere.
- **Emergency branch.** Blinded, Stuck, Iris, Gassed and Snared pre-empt everything, aborting LowerPriority.

---

## 5. Fighting

| Topic | What the bot does | Evidence |
|---|---|---|
| Target acquisition | Sight (3500/5000 uu, 75° half-angle, MaxAge 60 s), damage sense (MaxAge 30 s), hearing → investigate | [C] `AISenseConfig_Sight_1` @21862/21891/21920/22058; `AISenseConfig_Damage_1.MaxAge 30` |
| Melee vs ranged | Bow whenever >250 uu with ammo; melee inside 250 uu | [C] `0x140220fd0` (250), `0x1402222c0` |
| Weapons used | Only `AWeapon_Melee`, `AWeapon_Bow`, `AWeapon_Spray` are usable or selectable. [I] Guns, grenades, mines, traps and dynamite are never used. | [C] `0x140218990`, `0x14021ee10` class checks (`0x140305080`, `0x140304c70`, `0x140305150`) |
| Weapon choice | Highest `BotWeaponScore` among usable weapons, re-evaluated every 0.1 s. Bows (100) beat every melee weapon. | [C] `0x14021f010`; `SelectBestWeapon_C_0.Interval 0.1` |
| Melee action choice | Chooser `0x14021f960`, run every frame. Inside 400 uu with the enemy facing the bot: Block p = 0.4 if the enemy is winding up (else 0.1). Shove p = 0.5 if the enemy is blocking (else 0.1), only within 175 uu. When in range (175 uu) with the previous action None or Block: Jab p = 0.7 if the enemy is winding up (else 0.5), otherwise Charged. Fallback: Block p = 0.3. | [C] constants at `0x14021fa3e` (0.1), `0x14021fa5b` (0.4), `0x14021f9ed` (0.5), `0x14021fb02` (0.7), `0x14021fbac` (0.3), `0x14021facc` (30625 = 175²), `0x14021fc23` (160000 = 400²) |
| Reaction time | No reaction delay: the dice are rolled every BT tick (`SelectAction_C_3.Interval 0.001`). | [C] |
| Charged attack | `MeleeCharge`: start primary; chase the enemy at 150 uu every tick; release after exactly 1.0 s. The "keep holding while the enemy blocks" logic is dead (`ChargeTime` initialised to 1 = `MaxHoldTime`). On release against a blocking enemy, Reposition (13) with chance `ChargeToShoveChance` (native default; not stored in `BasicBot`). | [C] `MeleeCharge` bytecode (literals at 14796/14801/14935/14940/15002/15017) |
| Block | `MeleeBlock`: raise block, walk at the enemy (150 uu) every tick, lower after `TimeToHoldBlock` 1.5 s; 1.0–1.5 s BT cooldown. Debug `PrintString` left in (inactive in shipping). | [C] `Default__MeleeBlock_C.TimeToHoldBlock 1.5`; bytecode `this.TimeToHoldBlock = 10f@11494` only for the tutorial BlockBot |
| Jab / shove | Jab: release after 0.1 s (`MeleeJab` @9041). Shove: `OnStartShove` instantly. | [C] |
| Bow | Draw; `ConsiderAttacking` after `RandomFloatInRange(0.5, 1.0)`; release if `HasWeaponLOSToEnemy`, else retry every 0.3 s; forced release at 2.0 s. Meanwhile, moves toward (0,0,0) (`DestinationKey` bug). After entering bow range, `SelectAction` is paused 2.5–4.0 s, and 30% of the time the action is Reposition. | [C] `FireProjectile` bytecode @10797/10802/10887/11557; `0x14021fcb3/0x14021fcbb`; `0x14021fcef` |
| Aim error, lead | Not found in the controller. Aim comes from controller focus (`SetFocus(Enemy)`) plus the weapon's normal spread (`WeaponSpread 1.0`, `RunningSpreadMod 2.0`, …). [I] No target leading. | Not traced into `AShooterWeapon` (see "Not determined") |
| Dodging projectiles | `IsProjectileAimedAtMyBot` only raises threat (+3 per shot); no dodge behaviour found. | [C] `0x14021cb70` → `0x14021d2a0` |
| Retreat at low health or stamina | None. Flee is never selected; no health or stamina input to `SelectAction`, `UpdateObjective` or threat. | [C] for health in those functions. Stamina not exhaustively checked. |
| Stunned enemy | Pauses decisions, then punishes after 0.3–0.8 s (`OnEnemyStunned`). | [C] `0x14021d7c4/0x14021d7c8` |
| Gas or zone during fights | No melee into gas; iris reaction distance halved while fighting; all movement EQS penalise pylons (`ActivePylonsContext`, inverse-linear weight 2.0). | [C] |
| Throwables and traps | Not used (see "Weapons used"). [I] | |

---

## 6. Looting

| Topic | Behaviour | Evidence |
|---|---|---|
| Spawn loadout | [I] (match pawn = `BasicBot`): one random melee weapon from 9 crafted/tier-1 weapons; 50% chance of a ranged weapon (8 of 16 list slots: 5 Crafted Bow, 2 Blowgun, 1 Recurve) with 3 ammo; ~37% chance of a healing item (6 of 16 slots); plus fists. | [C] `BasicBot` ubergraph 8265–8968; `RangedWeaponList`/`BotUtilityWeapon` arrays |
| What to loot | Best `AShooterWeapon` pickup by `BotWeaponScore` + a bonus (`0x14021b5f0`), only if it beats the lowest score in inventory (fists = 5). Containers (`LootContainerParent_Bunkers2`), doors, Func barrels and `SupplyDrop` are "Interactables". | [C] `0x140219930`, `0x14021b860`, `0x14021b6b0`; `BasicController.Interactables` |
| Item values (`BotWeaponScore`) | Bows/blowgun 100; Chainsaw 50; Katana/Firemans Axe/Sledgehammer/Trident/guns 40; Hardened Armor 35; bats, knives, axes 30; tier-2 melee, grenades, mines, smoke 20; crafted weapons, Machete, Hammer 10; Fists 5; **Bandage, Medkit, HemoDrip, CraftedBandage, BodyArmor, CrudeArmor, Backpack, Satchel, OrangeJuice, Branch, Rock: 1** | [C] item CDOs (table in appendix) |
| Upgrading | Swaps out the lowest-score item when a better one is found (`OnScavengingFailed` `0x14021da90`) | [C] code; [I] in-game effect |
| Crafting | `BasicController` knows the craft classes (branch, rock, bandage, crude armour, satchel, bow, spear). `Craft` is really "move to Target and `StartUse`". The crafting decision inside `SelectInventoryAction` was not fully decoded. | [C] partial |
| Inventory limits | `BaseInventorySlotCount 3`, `MaxInventorySlotCount 5` | [C] `BasicBot` CDO |
| Using items | `UseItem` when the item `CanUse` (`0x140230d00`), only from the no-enemy branch. 5 s timeout, then the item is removed. | [C] |
| Health stations and FUNC | Goes to `MedStation_C`: once per 300 s via `FindNewHealthStation`, and at the end of every wander cycle (nearest within 20000). Whether FUNC is spent was not traced. | [C] tree; [I] spending |
| Airdrops | Wander EQS favours directions toward active `CargoDropTarget` (weight 1.5, within 25000). | [C] |
| Stop looting to fight | Any perceived hostile with threat > 0 sets `Enemy`, and "Has Enemy" aborts the loot branch (LowerPriority). | [C] |
| Stuck on a loot target | Blacklists it after 10 s (2 s if usable) without progress. | [C] `0x1402211e0` |

---

## 7. Unrealistic or exploitable behaviour

| # | Issue | Status |
|---|---|---|
| U1 | Near-instant block/shove decisions against melee wind-ups (dice every frame) | [C] mechanism, [I] feel |
| U2 | Up to 60 s of perfect tracking after breaking LOS; chase uses the actor's live position | [C] values and key, [I] effect |
| U3 | Never retreats, never heals mid-fight, never uses Turtling/Hide | [C] |
| U4 | Bow at 2.5 m; melee only inside 250 uu | [C] |
| U5 | Metronomic timings: charge 1.0 s, jab 0.1 s, block 1.5 s, draw 0.5–1.0 s, decision lock 2.5–4 s | [C] |
| U6 | Archers drift toward world origin while shooting | [C] code, [I] visible effect |
| U7 | Never loots healing or armour (score 1 < fists 5) | [C] |
| U8 | Loots guns, grenades, traps it can never use | [C] scores and class checks, [I] in game |
| U9 | Wander loop always ends at the nearest health station (campable) | [C] tree, [I] effect |
| U10 | Hearing works through walls at 1000 uu for any sprinting character | [C] |
| U11 | Targets beyond 3500 uu are ignored unless they hurt the bot (PR #10's 5000 sight changes nothing here) | [C] |
| U12 | No attacker cap and no player preference: free-for-all, nearest-first | [C] |
| U13 | `IsWeakorFeeble?` key is instance-synced across all bots | [C], latent only |

---

## 8. Recommendations

Tiers: **T1** ini; **T2** same-size value edits in cooked assets (`patch_assets.py`, extended where noted); **T3** structural blueprint/BT edits; **T4** `Victory.exe` patch; **T5** needs source.

`patch_assets.py` today only writes Int/Float tagged properties. R4 and R5 need two small, same-size helpers:

- **R4 (bytecode literal):** write a float at a verified file offset whose preceding byte is `0x1E` (`EX_FloatConst`). The offsets were checked against the stock files.
- **R5 (FName swap):** write the name-table index of an existing name at a `NameProperty` value offset.

Both keep the file size, as `patch_assets` asserts.

| ID | Tier | Change (stock → proposed) | Where | Risk | Realism gain | Verify in playtest |
|---|---|---|---|---|---|---|
| **R1** | T2 | `SelectAction_C_3.Interval` 0.001 → **0.25** | `MatchBot.uasset`, export `SelectAction_C_3` | Low. Only affects how often the combat chooser runs; jab/charge choice becomes slightly slower to start. | High: blocks become beatable by timing | 1v1 a melee bot 10×; count charged attacks that land when started from ≤3 m. Stock: almost all blocked. Target: some land. |
| **R2** | T2 | `AISenseConfig_Sight_1.MaxAge` 60 → **8**; `AISenseConfig_Damage_1.MaxAge` 30 → **10** | `BasicController.uasset` (@22058; damage config export) | Low. Bots may lose players who duck behind cover briefly (desired). | High | Get spotted, break LOS behind a building, wait 15 s. Stock: the bot walks straight to you. Target: it stops tracking within ~10 s (it may still investigate noise). |
| **R3** | T2 | `BotWeaponScore`: Bandage **8**, Medkit **9**, HemoDrip **7**, CraftedBandage **6**, BodyArmor **9**, CrudeArmor **7**, Backpack **9**, Satchel **6**. Unusable classes: guns (Rifle, SMG, 357, AlarmGun) **3**; Dynamite, ImpactGrenade, GasGrenade, RemoteExplosive, CraftedExplosive **3**; mines, caltrops, punji sticks, snares **2**. Leave bows and melee as they are. | Item CDOs under `Blueprints/Weapons` and `Items` (IntProperty, stored) | Low. Healing stays below every real melee weapon (≥10), so `SelectBestWeapon` will not equip a bandage as a weapon. Keep the new values below 10. | Medium–high: bots heal and armour up, and stop hoarding junk. | Spectate a bot that took damage; it should pick up bandages and use them out of combat. Bots should no longer carry guns. |
| **R4** | T2 (bytecode) | `MeleeCharge` floats @14796/14801 and @14935/14940 (`RandomFloatInRange(1,1)`) → **0.6 / 1.4**; @15017 `ChargeTime` 1 → **0**; @15002 `MaxHoldTime` 1 → **1.8** | `Behaviors/MeleeCharge.uasset` | Low–medium: bytecode literals only; no control-flow change | Medium: charge timing varies, and bots hold a charge until you drop your block (≤1.8 s) | Block a charging bot repeatedly; the release time should vary, and the bot should sometimes wait out your block. |
| **R5** | T2 (FName) | `FireProjectile_C_0.DestinationKey.SelectedKeyName` `Destination` → **`SelfActor`** | `MatchBot.uasset` | Low–medium: makes the move a no-op (move to self) | Medium: archers stop wandering toward map centre | Watch an archer bot shoot from a corner of the map; it should not walk toward the middle while drawing. |
| R6 | T2 | PR #10 sight: either keep `SightRadius` 3500 / `LoseSightRadius` 5000, **or** keep 5000/6500 and set `ThreatParams.MaxDistance` 3500 → **5000** (@20474). Keep `PeripheralVisionAngleDegrees` **75** (not 90). | `BasicController.uasset` | Low | Medium: makes a wider sight actually matter, without 180° vision | A bot 40–50 m away in the open should engage only with MaxDistance raised. |
| R7 | T2 | `NearestHealthStation` generator `SearchRadius` 20000 → **3000** | `EQS/NearestHealthStation.uasset` (stored `DefaultValue`) | Low: if none is near, the EQS fails and the wander cycle restarts | Medium: removes the health-station magnet | Count bots arriving at a med station during the first 5 min; it should drop. |
| R8 | T2 | Remove `EQS_TUNING` `DirectnessToCenterWeight` (no-op). To bias wandering, use `DirectnessToActiveAirDropWeight` or `DistanceToSelfWeight` in `EQSRequest` instead; both exist there. | `patch_assets.py` | None | Correctness of the patch | — |
| R9 | T2 | `Listen_C_0` 4.0±1.0 → **2.5±0.5** (PR #10 proposes 1.5±0.5) | `MatchBot.uasset` | Low | Low–medium: hearing is wall-hack-ish, so faster polling makes it stronger | Sprint past a bot behind a wall at ~8 m; it should investigate sometimes, not every time. |
| R10 | T2 | `ThreatParams.ThreatPerMeterCloserThanMaxDistance` 6 → **4** | `BasicController.uasset` @20445 | Low | Low–medium: whoever hurts a bot matters more relative to whoever is nearest (retaliation, fewer accidental third-party swaps) | Hit a bot with a bow while another bot stands closer to it; it should turn on you. |
| R11 | T4 | Bow/melee switch distance 250 → **700 uu**: at `0x140220fd0` (`movss xmm6,[rip+disp]`, file offset of disp `0x2205d4`) change disp `0x0236de50` → **`0x0236c6d0`**, which points at the existing read-only 700.0 at `0x14258d6a8`. The 250 constant is shared by 9 sites, so do not edit the constant itself. | `Victory.exe` | Medium: exe patch; affects only this load | High: no more point-blank bow shots | Approach an archer bot; it should switch to melee at ~7 m. |
| R12 | T4 | Melee dice probabilities (0.4/0.1 block, 0.5/0.1 shove, 0.7/0.5 jab). Constants are shared, so repoint each load (`0x14021fa5b`, `0x14021fa3e`, `0x14021f9ed`, `0x14021fb02`) to existing constants with the wanted value, the same way as R11. | `Victory.exe` | Medium | Low once R1 is done | — |
| R13 | T4 | Hearing radius 1000 → 800 uu: repoint the `0x140218d71` load (`1e6`, shared by 12 sites) to a 640000 constant. No such constant exists in `.rdata`, so it would need a code cave. | `Victory.exe` | Medium–high | Low | — |
| R14 | T4/T5 | Low-health retreat (set `Action = Flee` below X% HP so the existing Find Cover branch runs), plus fixing `UseItem_C_0.ItemKey` (`SelfActor` → `Weapon`, T2) | Exe code cave in `SelectAction`; or T5 | High as a T4 (new native code); the T2 key fix alone does nothing until Flee is selected | High | — |
| R15 | T1 | `[/Script/AIModule.AISystem] bAllowStrafing=True` | `DefaultEngine.ini` ([I] `UAISystem` is `config=Engine` in UE 4.15, so the patch would have to ship a `DefaultEngine.ini` override, not `DefaultGame.ini`; the key name `bAllowStrafing` is [C] present in the exe) | Medium: changes every AI move request; may look odd for loot runs | Low–medium: bots keep facing their focus (enemy) while moving | Watch a blocking bot advance; it should keep facing you. |
| R16 | T2 | `MeleeBlock.TimeToHoldBlock` 1.5 → **1.1** | `Behaviors/MeleeBlock.uasset` CDO | Low | Low: shorter turtle windows | — |
| R17 | T3 | Insert a random wait or "reaction" decorator before `Selector_6` actions; add a Turtling/Hide branch; bind the chase to a last-known-location key | `MatchBot.uasset` (new exports, `DecoratorOps`, name table) | High: needs export insertion and correct `ParentNode`/`TreeAsset` links; `ue_package.py` can append exports, but BT node arrays and memory offsets are rebuilt at load, so it is feasible but untested | Medium | — |
| R18 | T5 | Target leading and aim error, per-target attacker cap, squad awareness, stamina-aware fighting | Native `AShooterAIController`/`AShooterWeapon` | — | High | — |

Do not "fix" with T2:

- [C] `WeaponParams` (175/6000/150), stickiness and `ChargeToShoveChance` are not stored in the assets. Changing them needs T3 (adding tagged properties) or T4.
- The `IsWeakorFeeble?` sync flag should stay as it is: nothing writes the key in MatchBot.

---

## 9. PR #10 review

| PR #10 change | Still makes sense? | Why |
|---|---|---|
| `Listen` 4.0±1.0 → 1.5±0.5 | Partly | Hearing has no LOS check and triggers a 40–80% investigate roll; 1.5 s makes it near-certain. Suggest 2.5±0.5 (R9). |
| `FindBestTarget` 1.0 → 0.5 | Yes (minor) | Faster retargeting; stickiness (50 → 5 over 7 s) still prevents flip-flopping. |
| `SelectAction_C_24` 0.6 → 0.3 | Harmless, mislabelled | It is the scavenging-branch instance (`Selector_68`), not combat. The combat instance `SelectAction_C_3` is 0.001 and needs the opposite change (R1). |
| Sight 3500/5000 → 5000/6500 | Ineffective alone | Threat is 0 beyond `ThreatParams.MaxDistance = 3500`, so nothing new gets targeted. It only adds trace cost and longer lose-sight. Pair it with MaxDistance 5000 or drop it (R6). |
| Peripheral 75° → 90° | No | Half-angle: 90° = 180° field of view, less realistic than stock 150°. Keep 75. |
| `AISense_Sight` MaxTracesPerTick 6 → 24 | Fine | Only matters with many bots seeing each other; check `stat unit`. |
| `EnvQueryManager` MaxAllowedTestingTime 0.001 → 0.003 | Fine | Lets EQS finish faster; frame-time cost to check. |
| (main) `EQS_TUNING` DirectnessToCenterWeight 1.5 | No: no-op | See finding 9 and R8. |

## 10. Playtest checklist

Run 3+ solo matches per map (Jungle, Prison) for stock and for each change set. Use `stat unit` for performance. Don't count on `showdebug ai` or the gameplay debugger; they may not work in the shipping build, so judge by spectating.

- [ ] **R1 melee timing.** Start a charged attack at a bot from 2–3 m, 10 times. Note blocked vs landed. Repeat jab spam; bots should still block sometimes.
- [ ] **R2 memory.** Get spotted, break LOS, hide 15 s, note whether the bot comes straight to you.
- [ ] **R3 looting.** Damaged bots pick up and use bandages out of combat; no bot is seen holding a gun or grenade; inventory counts look sane.
- [ ] **R4 charge variety.** Release timing varies (about 0.6–1.4 s); a bot facing your block sometimes holds instead of swinging.
- [ ] **R5 archers.** While shooting, archers no longer walk toward the map middle.
- [ ] **R6 sight.** If MaxDistance was raised, bots notice you in the open at ~45 m; with 75° they still miss you from the side.
- [ ] **R7 health stations.** Fewer bots idle at med stations early.
- [ ] **R11 (if done).** Archers switch to melee at ~7 m.
- [ ] **Regression.** Bots still wander, loot crates and airdrops, escape snares, flee the iris and gas; no stuck or spinning bots; frame time within ~1 ms of stock with 15 bots.

## 11. Not determined (and why)

- **Aim error or leading for bows.** Not traced into `AShooterWeapon::GetAdjustedAim` or projectile spawn; only the controller range was decompiled.
- **What makes some characters "heard" at any distance.** The `CheckBotHearing` branch tests wound type 0x10 or a movement-state flag; their meaning was not decoded.
- **Stamina use in fights.** No stamina read was seen in the decompiled choosers; other code was not searched exhaustively.
- **Crafting and FUNC spending details** inside `SelectInventoryAction` (`0x14021f310`) and the GoTo target picker (`0x140219110`). Only partly decoded.
- **Which pawn class Classic matches spawn.** It is not set in `VictoryGameMode`. The exe contains the `BasicBot_C` path literal, and every other mode uses `BasicBot_C`, but the native default was not traced. If match bots are a different class, the loadout numbers in section 6 do not apply. The controller and tree do apply: `BotControllerClass = BasicController`.
- **`EQSRequest` vs legacy `QueryConfig`.** UE 4.15 `BTTask_RunEQSQuery::PostLoad`/`ExecuteTask` was not checked against the binary. The conclusion that `EQSRequest` is live rests on engine-version knowledge and the data pattern.
- **Every in-game effect marked [I].** No match was played.

## Appendix A: `BotWeaponScore` (stock) [C]

| Score | Items |
|---|---|
| 100 | WeapCompoundBow, WeapCraftedBlowgun, WeapCraftedBow, WeapRecurveBow |
| 50 | WeapChainsaw |
| 40 | Weap357Magnum, WeapRifle, WeapSMG, WeapFiremansAxe, WeapGoldenKatana, WeapKatana, WeapSledgehammer, WeapTrident |
| 35 | HardenedArmor |
| 30 | WeapBaseballBat, WeapBowieKnife, WeapDynamite, WeapGoldenKnife, WeapImpactGrenade, WeapPipeWrench, WeapSurvivalAxe, WeapSurvivalSpear, WeapTacticalMachete, WeapTomahawk, WeapYari |
| 20 | WeapAutoBow, WeapCleaver, WeapCraftedExplosive, WeapCraftedMine, WeapCraftedPunjiSticks, WeapCraftedSmokeBomb, WeapCrowbar, WeapExplosiveMine, WeapGasGrenade, WeapIceAxe, WeapJavelin, WeapKukri, WeapPepperSpray, WeapPike, WeapRemoteExplosive, WeapSabre, WeapSteelPipe |
| 15 | WeapSteelCaltrops, WeapSteelPunjiSticks |
| 10 | WeapAlarmGun, WeapBrassKnuckles, WeapCampHatchet, WeapCraftedCaltrops, WeapCraftedCudgel, WeapCraftedHatchet, WeapCraftedKnife, WeapCraftedSpear, WeapHammer, WeapMachete, WeapStunGun, WeapTantoKnife, WeapTonfa |
| 5 | WeapFists |
| 1 | Backpack, Bandage, BodyArmor, CraftedBandage, CrudeArmor, ExplosiveRuns, HemoDrip, Iron4Skin, LungButter, Medkit, MuscleManMilk, OrangeJuice, Satchel, WeapBranch, WeapRock, WeapSteelSnare |
| 0 | WeapCraftedSnare |

## Appendix B: patch locations (stock files)

| Target | Location | Stock bytes/value |
|---|---|---|
| `MeleeCharge` hold-time range (Weak path) | file @14796, @14801 (`EX_FloatConst`, preceded by `0x1E`) | 1.0, 1.0 |
| `MeleeCharge` ConsiderAttacking range | @14935, @14940 | 1.0, 1.0 |
| `MeleeCharge.MaxHoldTime` init | @15002 | 1.0 |
| `MeleeCharge.ChargeTime` init | @15017 | 1.0 |
| `MeleeCharge` re-check delay while blocked | @15319 | 0.2 |
| `FireProjectile` draw range | @10797, @10802 | 0.5, 1.0 |
| `FireProjectile` forced release | @10887 | 2.0 |
| `FireProjectile` no-LOS retry | @11557 | 0.3 |
| `MeleeJab` release | @9041 | 0.1 |
| `MeleeBlock` tutorial hold | @11494 | 10.0 (tutorial BlockBot only) |
| `Victory.exe` bow/melee switch load | VA `0x140220fd0`, file `0x2205d0`: `f3 0f 10 35 50 de 36 02` | → 250.0 @ `0x14258ee28` |
| `Victory.exe` existing 700.0 constant | VA `0x14258d6a8` | — |
| `Victory.exe` bow decision-lock range | `0x14021fcb3` (×1.5), `0x14021fcbb` (+2.5) | Constants shared (20 and 15 refs) |
| `Victory.exe` hearing radius² | `0x140218d71` → `0x14258ee44` (1e6) | Shared (12 refs) |

SHA-256 of analysed stock files (first 16 hex digits):

| File | SHA-256 prefix |
|---|---|
| `MatchBot.uasset` | `41567d5b58cfb467` |
| `BasicController.uasset` | `236be46957c1b346` |
| `MeleeCharge.uasset` | `099d8abed1eaa14d` |
| `FireProjectile.uasset` | `4e6eac25c3be414f` |
