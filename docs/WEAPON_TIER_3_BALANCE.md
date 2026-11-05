# Tier 3 weapon balance

**Status (2026-11-05)**

| Item | Status | Evidence |
|---|---|---|
| Weapon stat audit (every weapon, from the cooked data) | PASS | `patch/weapon_stats.py`; tables below; `patch/balance/weapon_stats.json`; `test_weapon_balance.py` (walker vs `uasset.Package`; every tiered melee tooltip matches the data) |
| Balance generator `patch/make_weapon_balance.py` | PASS (offline tests) | `python patch/test_weapon_balance.py <Paks dir>`: 7/7 |
| Shipped balance table `patch/balance/weapon_balance.json` | EMPTY: the stock stats ship unchanged | the test checks it writes no weapon |
| Proposed Tier 3 pass `patch/balance/weapon_tier3_proposal.json` | PROPOSED, NOT APPLIED: awaiting approval of the numbers | checked against the game (`--dry-run`) and applied into a temp folder by the test |
| In game | NOT TESTED | nothing is applied, so there is nothing to see in game yet; the checks to run once approved are below |

The request was "Tier 3 weapon changes" with no numbers, and "do not arbitrarily buff or nerf". So this
audits the data, looks for Tier 3 values that are off the curve the other tiers set, and proposes changes
only there, each with its original value, new value and reason. Nothing changes in the game until the
proposal is approved and copied into `weapon_balance.json`.

## Which weapons are Tier 3

The game's own tiers (each melee weapon's `UsableItemName`, "Yari (Tier 3)", and its menu description).
Two per class:

| Class | Tier 3 weapons |
|---|---|
| Axe | Survival Axe (fast), Tomahawk (normal) |
| Blade | Bowie Knife (fast), Tactical Machete (normal) |
| Bludgeon | Baseball Bat (normal), Pipe Wrench (slow) |
| Spear | Yari (fast), Survival Spear (slow) |

Where they come from: the pedestal list the game calls `ItemSpawnerItemList_Tier2` (all eight, equal
weight), Blue Crates (`LootContainer_Blue`, all eight at weight 62; 50 FUNC to open) and explosive
crates. Showdown's seven round kits are all Tier 3 (every one but the Survival Spear), so a Tier 3
change is a Showdown change too. Ranged weapons, throwables and traps have no tier.

## Tier 3 analysis

**Damage and speed sit exactly on the tier curve.** Every tiered melee weapon is one of three archetypes
by `WeaponConfig.SpeedModifier` (1.15 "Fast", 1.0 "Normal", 0.85 "Slow" in its tooltip), and each tier
adds 1 to light and 3 to heavy damage, 4 in all:

| Tier | Fast | Normal | Slow | light + heavy |
|---|---|---|---|---:|
| 1 | Brass Knuckles, Camp Hatchet, Tanto Knife 7-17 | Hammer 6-18 (crafted ones 5-15) | Machete, Pitchfork, Tonfa 5-19 | 24 |
| 2 | Ice Axe, Sabre 8-20 | Crowbar, Kukri, Pike 7-21 | Cleaver, Javelin, Steel Pipe 6-22 | 28 |
| **3** | **Bowie Knife, Survival Axe, Yari 9-23** | **Baseball Bat, Tactical Machete, Tomahawk 8-24** | **Pipe Wrench, Survival Spear 7-25** | **32** |
| 4 | Katana 10-26 | Fireman's Axe, Trident 9-27 | Sledgehammer 8-28 | 36 |

Throw damage equals melee damage on every tiered weapon; backstab is x2 on all of them.

**Timing, stamina, reach and block don't vary by tier at all.** Every tiered melee weapon has the same
charge (0.667 s, heavy from 90%), launch delay, swing, combo window, stamina (3 per attack, 5/s charging,
1/s holding), reach (175 cm, trace radius 30), block (55 degrees, 3 stamina a hit, 0.1 s to raise),
shove and throw costs. Recovery is 1.467 s everywhere except two Tier 1-2 weapons (Ice Axe, Machete:
1.2 s). So there is no Tier 3 outlier in attack speed, reach, recovery, stamina or block, and changing
one of them for Tier 3 alone would start a difference the game doesn't have.

**Wounds follow the class.** Axes and blades scale their bleed by tier (axes 0.35 / 0.40 / 0.45 / 0.50,
blades 0.7 / 0.8 / 0.9 / 1.0 dps); Tier 3 is on that line. Bludgeons (Weakness 15%) and spears (Expose
15%) use one wound at every tier; a stronger Tier 3 wound would need new wound Blueprints, not a number.

**The one numeric outlier: Tier 3 spear armor shred.** Spears store `WeaponConfig.PierceValueMin/Max`
(armor shred; the unique spears' tooltips say "Shred 5-12 Armor"):

| Spear | Tier | Shred |
|---|---:|---|
| Crafted Spear, Pitchfork | 1 | 2-6 |
| Javelin | 2 | 2-6 |
| Pike | 2 | 4-9 |
| **Yari** | **3** | **4-9 (= Tier 2 Pike)** |
| **Survival Spear** | **3** | **5-12 (= Tier 4 Trident)** |
| Trident | 4 | 5-12 |

One Tier 3 spear gains nothing over Tier 2 and the other already has Tier 4's. Of the stats that scale
with tier, it is the only one where a Tier 3 weapon has another tier's value, and the only one where the
two Tier 3 weapons of a class differ by more than their archetype.

**Other Tier 3 oddities, not numbers to tune (not proposed):**
- The Baseball Bat is the only weapon in the game that stores `InterruptBlockForNextActionTime` (0.0).
  The native default it overrides isn't in the data and the effect isn't documented; changing it blind
  would be arbitrary. Worth a look in game.
- The two Tier 3 axes (Survival Axe, Tomahawk) are the only melee weapons thrown as
  `ProjThrowProxySpinner` (a spinning throw). Behaviour, not a stat.
- Recycle value runs 10 / 20 / **25** / 30 FUNC by tier (bot weapon score 10 / 20 / 30 / 40). That is FUNC
  economy rather than weapon balance, and FUNC just went further with airdrops 25% cheaper.

## Proposed Tier 3 pass (NOT APPLIED)

`patch/balance/weapon_tier3_proposal.json`:

| Weapon | Property | Original | New | Reason |
|---|---|---:|---:|---|
| Survival Spear (`WeapSurvivalSpear`) | `WeaponConfig.PierceValueMin` | 5.0 | 4.5 | Has the Tier 4 Trident's shred. Tier 3 spears share 4.5-10.5: midway between the best Tier 2 spear (Pike 4-9) and Tier 4 (Trident 5-12) |
| Survival Spear | `WeaponConfig.PierceValueMax` | 12.0 | 10.5 | same |
| Yari (`WeapYari`) | `WeaponConfig.PierceValueMin` | 4.0 | 4.5 | Has the Tier 2 Pike's shred, so no gain over Tier 2; moves to the shared Tier 3 band |
| Yari | `WeaponConfig.PierceValueMax` | 9.0 | 10.5 | same |

Net effect on the tier: none on average. The two Tier 3 spears' mean shred is 4.5-10.5 before and after;
the Survival Spear loses 0.5 / 1.5 and the Yari gains 0.5 / 1.5. No tooltip shows these spears' shred, so
no text changes. **Showdown**: the Yari is a Showdown kit and every Showdown fighter wears Tactical Body
Armor, so the Yari round gets slightly more armor shred; the Survival Spear isn't a kit.

Alternatives if you'd rather not touch the Yari: (B) Survival Spear only, 5-12 -> 4-9 (a pure nerf of the
outlier; both Tier 3 spears then equal the Tier 2 Pike), or (C) Yari only, 4-9 -> 5-12 (a pure buff; both
then equal Tier 4). The data doesn't choose between them; (A), above, is the one that keeps the tier's
total.

Damage, speed, timing, stamina, reach, recovery and block: **no change proposed**; they are on the curve.

## How to apply it once approved

1. Copy the `changes` of `patch/balance/weapon_tier3_proposal.json` into `patch/balance/weapon_balance.json`
   (or edit the numbers first; every change needs `from` = the stock value and a `reason`).
2. `python patch/make_weapon_balance.py <Paks dir> --dry-run` to see the changes, then without `--dry-run`.
   It writes the patched weapons to `patch/src` and `patch/balance/weapon_balance_applied.json` (original
   and new value, reason, files). A damage, throw or speed change also rewrites that weapon's HUD tooltip.
3. `python patch/test_weapon_balance.py <Paks dir>`, then build the release as usual.
4. To undo: empty the table and run step 2 again; it deletes the files it wrote.

Only values an asset stores can change (the generator refuses the rest): a value it doesn't store is the
native class's C++ default. The Katana's minimum damage, the Pipe Wrench's and Survival Spear's maximum
damage and every "Normal" weapon's SpeedModifier are such values.

## In-game checks once applied (NOT TESTED)

- Pick up a Yari and a Survival Spear (Blue Crate or the Tier 3 pedestals) and heavy-attack a bot wearing
  body armor; compare the armor lost per hit with the Pike (4-9) and the Trident (5-12).
- Both spears' tooltips are unchanged (Expose 15%, Fast / Slow Speed, 9-23 / 7-25).
- Showdown: a Yari round plays as before, apart from armor going down a little faster.

## Values the assets don't store

A cooked Blueprint stores only what differs from its parent. Melee weapons are children of the native
`Weapon_Melee`, whose C++ defaults aren't in the data, but the HUD tooltips (`hud.json`) show what the game
uses, and `test_weapon_balance.py` checks all 31 tiered melee tooltips against the data and these:

| Value | Default | Shown by |
|---|---:|---|
| `MeleeConfig.DamageMax` | 25 | Pipe Wrench and Survival Spear store none; their tooltips say "Damage: 7-25" |
| `MeleeConfig.DamageMin` | 10 | the Katana stores none; its tooltip says "Damage: 10-26" |
| `ThrowConfig.LightThrowDamage` | 10 | the Katana stores none; "Throw: 10-26" |
| `WeaponConfig.SpeedModifier` | 1.0 | weapons with none say "Normal Speed" (1.15 Fast, 0.85 Slow) |

## Weapon stat tables

<!-- BEGIN weapon_stats.py tables -->

Generated by `python patch/weapon_stats.py <Paks dir>` from the stock cooked assets (every stored value of every weapon is also in `patch/balance/weapon_stats.json`).

`·` = not stored in the asset: the native parent class's C++ default, which the cooked data doesn't hold. `†` = not stored, but the HUD tooltip shows the value the game uses (see *Values the assets don't store*).

**Durability**: no weapon asset stores a durability, health or break value, and `Victory.exe` has no property of that name: weapons in The Culling don't wear out. There is nothing to audit or tune.

### Melee: tier, class, damage

| Weapon | Tier | Class | Speed (SpeedModifier) | Damage light-heavy | Backstab x | Throw light-heavy | Armor shred (Pierce) | Wounds | Recycle FUNC | Bot score |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Camp Hatchet (`WeapCampHatchet`) | 1 | Axe | 1.15 Fast | 7-17 | 2 | 7-17 | · | ScaleBleed035, ScaledExpose0075 | 10 | 10 |
| Crafted Hatchet (`WeapCraftedHatchet`) | 1 | Axe | 1† Normal | 5-15 | 2 | 5-15 | · | ScaleBleed030, ScaledExpose0075 | 4 | 10 |
| Cleaver (`WeapCleaver`) | 2 | Axe | 0.85 Slow | 6-22 | 2 | 6-22 | · | ScaleBleed040, ScaledExpose0075 | 20 | 20 |
| Ice Axe (`WeapIceAxe`) | 2 | Axe | 1.15 Fast | 8-20 | 2 | 8-20 | · | ScaleBleed040, ScaledExpose0075 | 20 | 20 |
| Survival Axe (`WeapSurvivalAxe`) | 3 | Axe | 1.15 Fast | 9-23 | 2 | 9-23 | · | ScaleBleed045, ScaledExpose0075 | 25 | 30 |
| Tomahawk (`WeapTomahawk`) | 3 | Axe | 1† Normal | 8-24 | 2 | 8-24 | · | ScaleBleed045, ScaledExpose0075 | 25 | 30 |
| Fireman's Axe (`WeapFiremansAxe`) | 4 | Axe | 1† Normal | 9-27 | 2 | 9-27 | · | ScaleBleed050, ScaledExpose0075 | 30 | 40 |
| Crafted Knife (`WeapCraftedKnife`) | 1 | Blade | 1† Normal | 5-15 | 2 | 5-15 | · | ScaleBleed060, Cripple_Wound | · | 10 |
| Machete (`WeapMachete`) | 1 | Blade | 0.85 Slow | 5-19 | 2 | 5-19 | · | ScaleBleed070, Cripple_Wound | 10 | 10 |
| Tanto Knife (`WeapTantoKnife`) | 1 | Blade | 1.15 Fast | 7-17 | 2 | 7-17 | · | ScaleBleed070, Cripple_Wound | 10 | 10 |
| Kukri (`WeapKukri`) | 2 | Blade | 1† Normal | 7-21 | 2 | 7-21 | · | ScaleBleed080, Cripple_Wound | 20 | 20 |
| Sabre (`WeapSabre`) | 2 | Blade | 1.15 Fast | 8-20 | 2 | 8-20 | · | ScaleBleed080, Cripple_Wound | 20 | 20 |
| Bowie Knife (`WeapBowieKnife`) | 3 | Blade | 1.15 Fast | 9-23 | 2 | 9-23 | · | ScaleBleed090, Cripple_Wound | 25 | 30 |
| Tactical Machete (`WeapTacticalMachete`) | 3 | Blade | 1† Normal | 8-24 | 2 | 8-24 | · | ScaleBleed090, Cripple_Wound | 25 | 30 |
| Katana (`WeapKatana`) | 4 | Blade | 1.15 Fast | 10†-26 | 2 | 10†-26 | · | ScaleBleed100, Cripple_Wound | 30 | 40 |
| Brass Knuckles (`WeapBrassKnuckles`) | 1 | Bludgeon | 1.15 Fast | 7-17 | 2 | 7-17 | · | DamageBludgeonWound1 | 10 | 10 |
| Crafted Cudgel (`WeapCraftedCudgel`) | 1 | Bludgeon | 1† Normal | 5-15 | 2 | 5-15 | · | DamageBludgeonWound1 | 4 | 10 |
| Hammer (`WeapHammer`) | 1 | Bludgeon | 1† Normal | 6-18 | 2 | 6-18 | · | DamageBludgeonWound1 | 10 | 10 |
| Tonfa (`WeapTonfa`) | 1 | Bludgeon | 0.85 Slow | 5-19 | 2 | 5-19 | · | DamageBludgeonWound1 | 10 | 10 |
| Crowbar (`WeapCrowbar`) | 2 | Bludgeon | 1† Normal | 7-21 | 2 | 7-21 | · | DamageBludgeonWound1 | 20 | 20 |
| Steel Pipe (`WeapSteelPipe`) | 2 | Bludgeon | 0.85 Slow | 6-22 | 2 | 6-22 | · | DamageBludgeonWound1 | 20 | 20 |
| Baseball Bat (`WeapBaseballBat`) | 3 | Bludgeon | 1† Normal | 8-24 | 2 | 8-24 | · | DamageBludgeonWound1 | 25 | 30 |
| Pipe Wrench (`WeapPipeWrench`) | 3 | Bludgeon | 0.85 Slow | 7-25† | 2 | 7-25 | · | DamageBludgeonWound1 | 25 | 30 |
| Sledgehammer (`WeapSledgehammer`) | 4 | Bludgeon | 0.85 Slow | 8-28 | 2 | 8-28 | · | DamageBludgeonWound1 | 30 | 40 |
| Crafted Spear (`WeapCraftedSpear`) | 1 | Spear | 1† Normal | 5-15 | 2 | 5-15 | 2-6 | ScaledExpose015, Cripple_Wound | 4 | 10 |
| Pitchfork (`WeapPitchFork`) | 1 | Spear | 0.85 Slow | 5-19 | 2 | 5-19 | 2-6 | ScaledExpose015, Cripple_Wound | 10 | 10 |
| Javelin (`WeapJavelin`) | 2 | Spear | 0.85 Slow | 6-22 | 2 | 6-22 | 2-6 | ScaledExpose015, Cripple_Wound | 20 | 20 |
| Pike (`WeapPike`) | 2 | Spear | 1† Normal | 7-21 | 2 | 7-21 | 4-9 | ScaledExpose015, Cripple_Wound | 20 | 20 |
| Survival Spear (`WeapSurvivalSpear`) | 3 | Spear | 0.85 Slow | 7-25† | 2 | 7-25 | 5-12 | ScaledExpose015, Cripple_Wound | 25 | 30 |
| Yari (`WeapYari`) | 3 | Spear | 1.15 Fast | 9-23 | 2 | 9-23 | 4-9 | ScaledExpose015, Cripple_Wound | 25 | 30 |
| Trident (`WeapTrident`) | 4 | Spear | 1† Normal | 9-27 | 2 | 9-27 | 5-12 | ScaledExpose015, Cripple_Wound | 30 | 40 |
| Gold Crowbar (`WeapCrowbar_Gold`), a copy of `WeapCrowbar` (blank: its values) | 2 | · | · | · | · | · | · | · | · | · |
| Bleeding Blade (Unique) (`WeapGoldenKatana`) | · | Blade | 1† | 8-25† | · | 7-21 | · | BloodyKatanaWound | 30 | 40 |
| Doppledagger (Unique) (`WeapGoldenKnife`) | · | Blade | 0.85 | 7-19 | · | 6-18 | · | BleedWound2 | 25 | 30 |
| Branch (`WeapBranch`) | · | Fists | 1† | 4-12 | 2 | 5-5 | · | · | · | 1 |
| Fists (`WeapFists`) | · | Fists | 1† | 4-12 | 2 | 4-12 | · | · | -1 | 5 |
| Rock (`WeapRock`) | · | Fists | 1† | 4-12 | 2 | 5-5 | · | · | · | 1 |
| Stun Gun (`WeapStunGun`) | · | · | 1† | 0-0 | 0 | 5-5 | · | Cripple_Wound, TazeSick | 15 | 10 |
| WeapSabre_Tutorial (`WeapSabre_Tutorial`), a copy of `WeapSabre` (blank: its values) | · | · | · | · | · | · | · | · | · | · |

### Melee: attack timing, stamina, reach

Primary attack = `PrimaryMode` (WeaponFireMode_Charged): hold to charge, released before MinHeavyChargePct x MaxChargeTime it is a light attack, after it a heavy one. Reach = `InstantLaunch` InstantConfig.WeaponRange (cm) with a sweep of WeaponConfig.TraceRadius.

| Weapon | Charge time s | Heavy at % | Launch delay s | Between attacks s | Swing s (LaunchDuration) | Combo queue s | Stamina per attack | Stamina/s charging | Stamina/s holding | Reach cm | Trace radius |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Camp Hatchet (`WeapCampHatchet`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Crafted Hatchet (`WeapCraftedHatchet`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Cleaver (`WeapCleaver`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Ice Axe (`WeapIceAxe`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Survival Axe (`WeapSurvivalAxe`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Tomahawk (`WeapTomahawk`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Fireman's Axe (`WeapFiremansAxe`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Crafted Knife (`WeapCraftedKnife`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Machete (`WeapMachete`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Tanto Knife (`WeapTantoKnife`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Kukri (`WeapKukri`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Sabre (`WeapSabre`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Bowie Knife (`WeapBowieKnife`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Tactical Machete (`WeapTacticalMachete`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Katana (`WeapKatana`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Brass Knuckles (`WeapBrassKnuckles`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Crafted Cudgel (`WeapCraftedCudgel`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Hammer (`WeapHammer`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Tonfa (`WeapTonfa`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Crowbar (`WeapCrowbar`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Steel Pipe (`WeapSteelPipe`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Baseball Bat (`WeapBaseballBat`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Pipe Wrench (`WeapPipeWrench`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Sledgehammer (`WeapSledgehammer`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Crafted Spear (`WeapCraftedSpear`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Pitchfork (`WeapPitchFork`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Javelin (`WeapJavelin`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Pike (`WeapPike`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Survival Spear (`WeapSurvivalSpear`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Yari (`WeapYari`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Trident (`WeapTrident`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Gold Crowbar (`WeapCrowbar_Gold`), a copy of `WeapCrowbar` (blank: its values) | · | · | · | · | · | · | · | · | · | · | · |
| Bleeding Blade (Unique) (`WeapGoldenKatana`) | 0.5 | 0.75 | 0.1 | 0.1 | 0.2 | · | · | · | 5 | 175 | 30 |
| Doppledagger (Unique) (`WeapGoldenKnife`) | 0.5 | 0.75 | 0.1 | 0.1 | 0.2 | · | · | · | 5 | 175 | 30 |
| Branch (`WeapBranch`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Fists (`WeapFists`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Rock (`WeapRock`) | 0.6667 | 0.9 | 0.1 | 0 | 0.25 | 0.5 | 3 | 5 | 1 | 175 | 30 |
| Stun Gun (`WeapStunGun`) | 0.1 | · | · | · | 2.5 | · | · | · | · | 175 | 30 |
| WeapSabre_Tutorial (`WeapSabre_Tutorial`), a copy of `WeapSabre` (blank: its values) | · | · | · | · | · | · | · | · | · | · | · |

### Melee: block, recovery, shove, throw

Block = `SecondaryMode` (WeaponFireMode_Block). Recovery = how long the wielder is interrupted after a heavy hit lands on them, after their attack is blocked, after a failed shove (HeavyInterruptDuration, BlockedInterruptDuration, ShoveFailInterruptDuration).

| Weapon | Block angle | Block stamina/hit | Block start s | Block mitigation base / step | Heavy-hit recovery s | Blocked recovery s | Shove-fail recovery s | Min interrupt s | Next action after attack interrupt s | Next action after block interrupt s | Shove dmg | Shove stamina | Throw stamina | Throw charge s |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| Camp Hatchet (`WeapCampHatchet`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Crafted Hatchet (`WeapCraftedHatchet`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Cleaver (`WeapCleaver`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Ice Axe (`WeapIceAxe`) | 55 | 3 | 0.1 | 0 / 0 | 1.2 | 1.2 | 1.2 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Survival Axe (`WeapSurvivalAxe`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Tomahawk (`WeapTomahawk`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Fireman's Axe (`WeapFiremansAxe`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Crafted Knife (`WeapCraftedKnife`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Machete (`WeapMachete`) | 55 | 3 | 0.1 | 0 / 0 | 1.2 | 1.2 | 1.2 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Tanto Knife (`WeapTantoKnife`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Kukri (`WeapKukri`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Sabre (`WeapSabre`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Bowie Knife (`WeapBowieKnife`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Tactical Machete (`WeapTacticalMachete`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Katana (`WeapKatana`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Brass Knuckles (`WeapBrassKnuckles`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Crafted Cudgel (`WeapCraftedCudgel`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Hammer (`WeapHammer`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Tonfa (`WeapTonfa`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Crowbar (`WeapCrowbar`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Steel Pipe (`WeapSteelPipe`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Baseball Bat (`WeapBaseballBat`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | 0 | 1 | 3 | 4 | 1.5 |
| Pipe Wrench (`WeapPipeWrench`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Sledgehammer (`WeapSledgehammer`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Crafted Spear (`WeapCraftedSpear`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Pitchfork (`WeapPitchFork`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Javelin (`WeapJavelin`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Pike (`WeapPike`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Survival Spear (`WeapSurvivalSpear`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Yari (`WeapYari`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Trident (`WeapTrident`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Gold Crowbar (`WeapCrowbar_Gold`), a copy of `WeapCrowbar` (blank: its values) | · | · | · | · | · | · | · | · | · | · | · | · | · | · |
| Bleeding Blade (Unique) (`WeapGoldenKatana`) | 65 | 0 | 0.1 | 0 / 0 | 1.2 | 1.2 | · | 0 | 0.3 | · | 0 | 0 | · | 1.5 |
| Doppledagger (Unique) (`WeapGoldenKnife`) | 65 | 0 | 0.1 | 0 / 0 | 1.2 | 1.2 | · | 0 | 0.3 | · | 0 | 0 | · | 1.5 |
| Branch (`WeapBranch`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Fists (`WeapFists`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Rock (`WeapRock`) | 55 | 3 | 0.1 | 0 / 0 | 1.467 | 1.467 | 1.467 | 0.5 | 0.3 | · | 1 | 3 | 4 | 1.5 |
| Stun Gun (`WeapStunGun`) | · | · | · | · | · | · | · | · | · | · | 1 | 3 | · | · |
| WeapSabre_Tutorial (`WeapSabre_Tutorial`), a copy of `WeapSabre` (blank: its values) | · | · | · | · | · | · | · | · | · | · | · | · | · | · |

### Ranged

Bows: BowConfig.HitDamageMin-Max scales with draw; guns: InstantConfig.HitDamage per hit (the SMG stores none: native default). No ranged weapon has a tier; `make_airdrop_unlocks.py` rates them.

| Weapon | Parent | Damage | Headshot x | Max armor mitigation | Spread | Range cm | Clip / max / clips | Fire timing s | Stamina per shot | Reload s | Recoil s (impact / recovery) | Aim zoom | Projectile | Recycle FUNC |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| .357 Magnum (`Weap357Magnum`) | ShooterWeapon_Instant | 25 | 2 | 0.5 | · | · | 6 / 6 / 1 | 0.6 | · | 0.2 | 0.1 / 0.45 | 0.8 | · | 45 |
| Alarm Gun (`WeapAlarmGun`) | ShooterWeapon_Instant | 1 | 1 | 0.5 | 0 | 35000 | 1 / 3 / 3 | 1 | · | 0.5 | 0.1 / 0.2 | 0.4 | · | 10 |
| Rifle (`WeapRifle`) | ShooterWeapon_Instant | 50 | 1.9 | 0.5 | 10 | 35000 | 4 / 4 / 1 | 1 | · | 1 | 0.25 / 2.5 | 0.75 | · | 45 |
| SMG (`WeapSMG`) | ShooterWeapon_Instant | · | 2 | 0.5 | · | · | · / 20 / 1 | 0.1 | · | · | 0.1 / 0.4 | 0.8 | · | 45 |
| Auto Bow (`WeapAutoBow`) | Weapon_Autobow | 6-6 | 2 | 0.5 | 1 | · | 3 / 24 / 2 | 0.175 | · | 1.5 | · | 0.4 | ProjArrowAutobow_C | 15 |
| Compound Bow (`WeapCompoundBow`) | Weapon_Bow | 2-20 | 2 | 0.5 | 1 | · | 1 / 24 / 6 | charge · | 3 | · | · | 0.4 | ProjArrowCompound_C | 30 |
| Crafted Blowgun (`WeapCraftedBlowgun`) | Weapon_Bow | 2-5 | · | · | 1 | · | 1 / 9 / 3 | charge 0.6667 | 5 | · | · | · | ProjBlowDart_C | 5 |
| Crafted Bow (`WeapCraftedBow`) | Weapon_Bow | 3-12 | 2 | 0.5 | 1 | · | 1 / 24 / 6 | charge · | 3 | · | · | 0.6 | ProjArrow_C | 6 |
| Recurve Bow (`WeapRecurveBow`) | Weapon_Bow | 4-16 | 2 | 0.5 | 1 | · | 1 / 24 / 6 | charge · | 3 | · | · | 0.6 | ProjArrowRecurve_C | 15 |

### Projectile settings

The arrows inherit from `ProjArrow`: a blank row uses ProjArrow's values (InitialSpeed / MaxSpeed 15000).

| Projectile | Parent | Initial speed | Max speed | Drag | Life span s | Long-range hit cm | Momentum |
|---|---:|---:|---:|---:|---:|---:|---:|
| `ProjArrow` | VictoryProjectile | 15000 | 15000 | · | 15 | 3500 | · |
| `ProjArrowAutobow`, a copy of `ProjArrow` (blank: its values) | ProjArrow_C | · | · | · | · | · | · |
| `ProjArrowCompound`, a copy of `ProjArrow` (blank: its values) | ProjArrow_C | · | · | · | · | · | · |
| `ProjArrowRecurve`, a copy of `ProjArrow` (blank: its values) | ProjArrow_C | · | · | · | · | · | · |
| `ProjBlowDart`, a copy of `ProjArrow` (blank: its values) | ProjArrow_C | · | · | -0.5 | · | · | · |
| `ProjRocket_Explosion` | ShooterExplosionEffect | · | · | · | · | · | · |
| `ProjSmokeBomb` | ShooterExplosionEffect | · | · | · | · | · | · |
| `ProjThrowProxy` | VictoryProjectile | 5000 | 5000 | -0.9 | 0 | · | 10000 |
| `ProjThrowProxySpinner` | VictoryProjectile | 5000 | 5000 | -0.9 | 0 | · | 10000 |

### Throwables, traps, deployables and the rest

A thrown or placed weapon (`Weap*`) spawns its deployable (`Dep*`), which holds the damage.

| Item | Parent | Damage | Damage at max radius | Radius min-max | Explode delay s | Cook s | Prime s | Disarm s | Damage to destroy | Retrigger s | Recycle FUNC |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `DepCraftedCaltrops` | DeployableCaltrop | · | · | · | · | · | 0.1 | 3 | 5 | · | · |
| `DepCraftedExplosive` | DeployableGrenade | 20 | 10 | 50-400 | 0.1 | · | 4 | 2 | · | · | · |
| `DepCraftedExplosive_FireExtinguisher`, a copy of `DepCraftedExplosive` (blank: its values) | DepCraftedExplosive_C | · | · | · | · | · | 0 | 0 | · | · | · |
| `DepCraftedMine` | DeployableClaymore | 20 | 20 | 200-500 | 0.2 | · | 1 | 5 | · | 0.2 | · |
| `DepCraftedPunjiSticks` | DeployableBearTrap | 10 | · | · | · | · | 0.1 | 3 | 15 | 3 | · |
| `DepCraftedSmokeBomb` | DeployableGrenade | · | · | 300-700 | 0.1 | · | 0.1 | 2 | · | · | · |
| `DepCraftedSnareTripwire`, a copy of `DepSnareRootTripwire` (blank: its values) | DepSnareRootTripwire_C | 15 | · | · | · | · | · | 3 | 15 | · | · |
| `DepDecoyExplosive` | DeployableGrenade | 50 | 25 | 300-600 | · | · | · | 2 | · | · | · |
| `DepDynamite` | DeployableGrenade | 80 | 10 | 450-1000 | 0.1 | · | 4 | 2 | · | · | · |
| `DepExplosiveMine` | DeployableClaymore | 65 | 20 | 400-800 | 0.2 | · | 1 | 1.5 | · | · | · |
| `DepGASGrenade` | DeployableGrenade | 40 | · | · | · | · | 0.1 | 2 | · | · | · |
| `DepImpactGrenade` | DeployableGrenade | 40 | 20 | 400-800 | · | · | 0.1 | 2 | · | · | · |
| `DepLargeBarrelExplosion` | DeployableGrenade | 25 | 25 | 450-1000 | · | · | · | 0 | · | · | · |
| `DepRemoteExplosive` | DeployableClaymore | 95 | 15 | 600-1000 | 0.25 | · | · | 1.5 | · | · | · |
| `DepSnareRootTripwire` | DeployableTrapNode | · | · | · | · | · | 0.5 | 1.5 | · | · | · |
| `DepSteelCaltrops` | DeployableCaltrop | · | · | · | · | · | 0.1 | 3 | 100000 | · | · |
| `DepSteelPunjiSticks` | DeployableBearTrap | 20 | · | · | · | · | 0.1 | 3 | 100000 | 1.5 | · |
| `DepSteelSnareTripwire`, a copy of `DepSnareRootTripwire` (blank: its values) | DepSnareRootTripwire_C | 25 | · | · | · | · | · | 6 | 100000 | · | · |
| Chainsaw (`WeapChainsaw`) | Weapon_Chainsaw | · | · | · | · | · | · | · | · | · | 40 |
| Crafted Caltrop (`WeapCraftedCaltrops`) | Weapon_Caltrops | · | · | · | · | · | · | · | · | · | 0 |
| Crafted Explosive (`WeapCraftedExplosive`), a copy of `WeapDynamite` (blank: its values) | WeapDynamite_C | · | · | · | · | · | · | · | · | · | 6 |
| Crafted Mine (`WeapCraftedMine`) | DeployableWeapon | · | · | · | · | · | · | · | · | · | 10 |
| Crafted Punji Sticks (`WeapCraftedPunjiSticks`) | DeployableWeapon | · | · | · | · | · | · | · | · | · | 0 |
| Crafted Smoke Bomb (`WeapCraftedSmokeBomb`) | Weapon_Grenade | · | · | · | · | 1 | · | · | · | · | 3 |
| Crafted Snare (`WeapCraftedSnare`), a copy of `WeapSteelSnare` (blank: its values) | WeapSteelSnare_C | · | · | · | · | · | · | · | · | · | · |
| Dynamite (`WeapDynamite`) | Weapon_Grenade | · | · | · | · | 3.9 | · | · | · | · | 30 |
| Explosive Mine (`WeapExplosiveMine`) | DeployableWeapon | · | · | · | · | · | · | · | · | · | 20 |
| Crafted Gas Grenade (`WeapGasGrenade`) | Weapon_Grenade | · | · | · | · | 3.9 | · | · | · | · | 7 |
| Impact Grenade (`WeapImpactGrenade`) | Weapon_Grenade | · | · | · | · | 3.9 | · | · | · | · | 25 |
| Man Tracker (`WeapManTracker`) | Weapon_Tracker | · | · | · | · | · | · | · | · | · | 10 |
| Pepper Spray (`WeapPepperSpray`) | Weapon_Spray | · | · | · | · | · | · | · | · | · | 15 |
| Remote Explosive (`WeapRemoteExplosive`) | WeaponRemoteClaymore | · | · | · | · | · | · | · | · | · | 25 |
| Steel Caltrop (`WeapSteelCaltrops`) | Weapon_Caltrops | · | · | · | · | · | · | · | · | · | 0 |
| Steel Punji Sticks (`WeapSteelPunjiSticks`) | DeployableWeapon | · | · | · | · | · | · | · | · | · | 0 |
| Steel Snare (`WeapSteelSnare`) | DeployableWeapon | · | · | · | · | · | · | · | · | · | 0 |

<!-- END weapon_stats.py tables -->
