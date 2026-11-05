# New camos: design and tests (Dark Matter, Waves)

Branch `animated-camos`. Generator `patch/make_vfx_camos.py`, mesh tool `patch/skeletal_mesh.py`, static tests `patch/test_vfx_camos.py`, server test `server/test/camopurchase.test.js`.

The game cannot be run from this machine. Every in-game status below comes from the coordinator's reports; everything else is a static check.

## Status legend

- **PASS**: verified (the column says how: static check, server test or in-game report).
- **FAIL**: verified broken.
- **PARTIAL**: verified in part. The table says which part.
- **BLOCKED**: cannot be checked yet.
- **NOT TESTED**: nobody has looked at it in game. In-game items stay at this status until the coordinator confirms them.

## The camos

All of them are plain MaterialInstanceConstants: no static permutation, so they render with shaders the game already ships. No shader map is copied. The earlier animated attempt shipped copies of `Chainsaw_A_MI` with a shader map inside, and it crashed.

Each skin gives its weapon a copy of the weapon's own mesh through `GeoSkin`, the same field the stock special skins (FUNC Popper, Slayer, …) use. The copy keeps the stock skeleton, physics asset and sockets. Only the body material slot points at the new material.

| Camo (slot) | How it animates | Material route | Glows? |
|---|---|---|---|
| **Dark Matter** (67) | **Pulse + shell mist.** The surface glow breathes (\|sin\|, 0.15 Hz). Over it, a translucent shell carries two layers of violet/blue cloud that **scroll continuously**, so the weapon looks like a galaxy drifting over a glowing void. | Body: child of `AirDropLandingPad_MI` (a PM_Herc static permutation with emissive on). Emissive = Base Color × mask × pulse × colour × 7. Base Color is the Dark Matter picture: near-black indigo, violet/blue filaments, stars. The weapon keeps its own normal map. Shell: a second mesh section, the body pushed 0.08–0.2 units out along its normals, drawn with `MI_VFX_Galaxy_Mist`, a child of `M_NecroMist` (the Resurrection skull's animated mist). | Yes: the body is emissive and the mist is additive-looking translucent emissive. |
| **Dark Matter Popper** (68, Compound Bow only) | **Pulse.** The FUNC Popper's glow strips pulse violet. | `Bow_Compound_B` mesh (FUNC Popper) with a child of its own material `Bow_Compound_B_PM`: Emissive Color, Glow INT and pulse changed. | Yes (strips only; part of the upper limb keeps a stock teal term the MIC does not reach). |
| **Wave Abyss Blue / Violet / Toxic Green / Ember** (69–72) | **Scroll.** Wavy bands flow along the weapon, 0.12 UV/s. | Child of `Chainsaw_A_MI`, the only PM_Weapon_Master permutation with a time panner. Where GP alpha is set, base colour and normal are sampled at UV + (time × ChainsawSpeed, 0). GP alpha is set everywhere and the normal map is flat. | No: bright lit colour; this permutation has no emissive input. |
| **Dark Matter Drift** (73) | **Scroll.** The Dark Matter picture (brightened ×1.6) drifts along the weapon, 0.05 UV/s. | Same as Wave. This is the fallback if the shell fails. | No (lit). |

Stock evidence (static), from the cooked shaders disassembled with d3dcompiler_47:

- **AirDropLandingPad_MI:** 42 of 42 base-pass shaders read the game time (pulse).
- **Chainsaw_A_MI:** 18 of 18 move a texture coordinate by time.
- **M_NecroMist:** 12 of 12 translucent colour shaders move their cloud coordinates by time.
- **Bow_Compound_B_PM:** 6 of 6 read time (pulse).
- **Skeletal meshes:** every parent's shader map is cooked for the GPU-skin vertex factory. `M_NecroMist` already renders on a skeletal mesh in game (the skull mask).

### The galaxy shell (Dark Matter)

`skeletal_mesh.py` reads and writes the cooked USkeletalMesh export. Its layout model rewrites all 84 stock weapon meshes byte for byte.

`add_shell` appends the following, while keeping all stock data as a prefix:

- the shell vertices (positions + normal × offset; tangents, UVs, skin weights, colours and import map copied);
- the indices and tessellation adjacency (shifted to the new vertices);
- one section (same bone map, shadows off).

The mesh also gets one material slot and one import (the mist MIC). `LODInfo.TriangleSortSettings` gets one entry.

M_NecroMist fades with scene depth over "Fade Distance". The shell sits in front of the opaque body, and the MIC sets Fade Distance to 0.05 (stock 6), so the mist stays visible at a 0.08–0.2 unit offset.

Mist parameters:

- Fog Tint (1.2, 0.35, 3.0) and the second Fog Tint (FName "Fog Tint" number 2) (0.35, 0.7, 3.5).
- Opacity 0.9.
- Fresnel ExIn 3, BRF 0.05, so silhouettes fade.
- Pan SX 0.03, SY −0.08, U1 0.04, U2 −0.05.

## Weapons covered

All 37 camo-capable weapons (make_camos' weapon list) are covered, and every weapon gets all six VFX looks: Dark Matter, four Waves, Drift. Dark Matter Popper exists only for the Compound Bow. That makes 37 × 6 + 1 = **223 skins**.

**Weapons that cannot be covered: none.** The generator checks each weapon and would list one under "not covered" with a reason in `patch/registry/vfx_camos_manifest.json`. It checks that:

- the mesh exists;
- it has one export;
- it round-trips through the layout model;
- it has one LOD;
- the body material is a MIC or Material;
- shell vertices fit 16-bit indices.

ManTracker's mesh lives in `Character/Items`; the generator looks there too.

Skin template:

- **Stock GeoSkin skin:** used when the weapon has one: BaseballBat_14, BowieKnife_15, BrassKnuckles_09, CompoundBow_14, FiremansAxe_15, Katana_15, PipeWrench_14, Sledgehammer_15, SurvivalAxe_14, TacticalMachete_14, Trident_14, Yari_14.
- **_01 camo skin:** used for the other 25 weapons, with the Camo/BC tags dropped and GeoSkin added. That combination has not been seen in game yet (the old Teal Current diagnostic used it, with a mesh of another weapon). So the test order puts one of these weapons early.

Weapon notes:

- **Chainsaw:** the game drives `ChainsawSpeed` on the chainsaw's own material while it runs. Wave/Drift on the Chainsaw may stand still at idle, or race when revved. NOT TESTED.
- **Compound Bow / Recurve Bow / AutoBow:** the replaced body material carried the bowstring's sliding texture ("String Slide"), so with these camos the string texture does not slide. Whiskers and other secondary slots (e.g. the Rifle's iron sights) keep their stock material.

## Item IDs and entitlement

The ID is `800000 + weapon index × 100 + slot`. The weapon index is make_camos' index (read from the existing xp-camos catalog entries). Slots 67–73 follow make_camos' 0–66. Price 2,500 credits, rarity 5, catalog source `xp-vfx-camos`.

`server.js`'s `camoKey` treats `xp-vfx-camos` like `xp-camos`: the camo key is the asset name after `_XP_` (e.g. `VFX_Dark_Matter`). So **one purchase unlocks that camo on every weapon that has it**.

| # | Weapon (skin prefix) | Mesh copied | Body material replaced | Skin template | Dark Matter | Wave Abyss Blue | Wave Violet | Wave Toxic Green | Wave Ember | Dark Matter Drift |
|---|---|---|---|---|---|---|---|---|---|---|
| 0 | 357Magnum | Revolver_A | Revlover_MI | 357Magnum_01 (camo skin) | 800067 | 800069 | 800070 | 800071 | 800072 | 800073 |
| 1 | AlarmGun | ManAlarm_A | ManAlarm_A_MI | AlarmGun_01 (camo skin) | 800167 | 800169 | 800170 | 800171 | 800172 | 800173 |
| 2 | AutoBow | AutoBow_A | AutoBow_MI | AutoBow_01 (camo skin) | 800267 | 800269 | 800270 | 800271 | 800272 | 800273 |
| 3 | BaseballBat | MetalBat_A | MetalBat_A_MI | BaseballBat_14 (stock GeoSkin skin) | 800367 | 800369 | 800370 | 800371 | 800372 | 800373 |
| 4 | BowieKnife | BowieKnife_A | BowieKnife_A_MI | BowieKnife_15 (stock GeoSkin skin) | 800467 | 800469 | 800470 | 800471 | 800472 | 800473 |
| 5 | BrassKnuckles | BrassKnuckles_A | BrassKnuckles_A_MI | BrassKnuckles_09 (stock GeoSkin skin) | 800567 | 800569 | 800570 | 800571 | 800572 | 800573 |
| 6 | CampHatchet | Hatchet_A | Hatchet_A_MI | CampHatchet_01 (camo skin) | 800667 | 800669 | 800670 | 800671 | 800672 | 800673 |
| 7 | Chainsaw | Chainsaw_A | Chainsaw_A_MI | Chainsaw_01 (camo skin) | 800767 | 800769 | 800770 | 800771 | 800772 | 800773 |
| 8 | Cleaver | Cleaver_A | Cleaver_A_MI | Cleaver_01 (camo skin) | 800867 | 800869 | 800870 | 800871 | 800872 | 800873 |
| 9 | CompoundBow | CompoundBow_A | Bow_Compound_A_MI | CompoundBow_14 (stock GeoSkin skin) | 800967 | 800969 | 800970 | 800971 | 800972 | 800973 |
| 10 | Crowbar | Crowbar_A | Crowbar_A_MI | Crowbar_01 (camo skin) | 801067 | 801069 | 801070 | 801071 | 801072 | 801073 |
| 11 | FiremansAxe | FireAxe_A | TwoHanded_Melee_MI | FiremansAxe_15 (stock GeoSkin skin) | 801167 | 801169 | 801170 | 801171 | 801172 | 801173 |
| 12 | Hammer_BallPein | Hammer_Bambi_A | Hammer_BallPein_A_MI | Hammer_BallPein_01 (camo skin) | 801267 | 801269 | 801270 | 801271 | 801272 | 801273 |
| 13 | IceAxe | IceAxe_A | IceAxe_A_MI | IceAxe_01 (camo skin) | 801367 | 801369 | 801370 | 801371 | 801372 | 801373 |
| 14 | Javelin | Javelin_A | Javelin_A_MI | Javelin_01 (camo skin) | 801467 | 801469 | 801470 | 801471 | 801472 | 801473 |
| 15 | Katana | Katana | Katana_MI | Katana_15 (stock GeoSkin skin) | 801567 | 801569 | 801570 | 801571 | 801572 | 801573 |
| 16 | Kukri | Kukri_A | Kukri_A_MI | Kukri_01 (camo skin) | 801667 | 801669 | 801670 | 801671 | 801672 | 801673 |
| 17 | Machete | Machete_A | Machete_MI | Machete_01 (camo skin) | 801767 | 801769 | 801770 | 801771 | 801772 | 801773 |
| 18 | ManTracker | mantracker_A | ManTracker_A_MI | ManTracker_01 (camo skin) | 801867 | 801869 | 801870 | 801871 | 801872 | 801873 |
| 19 | Pike | Pike_A | Pike_A_MI | Pike_01 (camo skin) | 801967 | 801969 | 801970 | 801971 | 801972 | 801973 |
| 20 | PipeWrench | PipeWrench_A | PipeWrench_A_MI | PipeWrench_14 (stock GeoSkin skin) | 802067 | 802069 | 802070 | 802071 | 802072 | 802073 |
| 21 | PitchFork | PitchFork_A | PitchFork_A_MI | PitchFork_01 (camo skin) | 802167 | 802169 | 802170 | 802171 | 802172 | 802173 |
| 22 | RecurveBow | Bow_Recurve_A | Bow_Recurve_A_MI | RecurveBow_01 (camo skin) | 802267 | 802269 | 802270 | 802271 | 802272 | 802273 |
| 23 | Rifle | M15-Rifle_A | M15_Rifle_A_MI | Rifle_01 (camo skin) | 802367 | 802369 | 802370 | 802371 | 802372 | 802373 |
| 24 | SMG | SMG_A | SMG_MI_Default | SMG_01 (camo skin) | 802467 | 802469 | 802470 | 802471 | 802472 | 802473 |
| 25 | Sabre | Sabre_A | Sabre_A_MI | Sabre_01 (camo skin) | 802567 | 802569 | 802570 | 802571 | 802572 | 802573 |
| 26 | Sledgehammer | Sledgehammer_A | TwoHanded_Melee_MI | Sledgehammer_15 (stock GeoSkin skin) | 802667 | 802669 | 802670 | 802671 | 802672 | 802673 |
| 27 | SteelPipe | Steel_Pipe_A | Steel_Pipe_A_MI | SteelPipe_01 (camo skin) | 802767 | 802769 | 802770 | 802771 | 802772 | 802773 |
| 28 | StunGun | StunGun_A | Stun_Gun_A_MI | StunGun_01 (camo skin) | 802867 | 802869 | 802870 | 802871 | 802872 | 802873 |
| 29 | SurvivalAxe | Survival_Axe_A | Survival_Axe_A_MI | SurvivalAxe_14 (stock GeoSkin skin) | 802967 | 802969 | 802970 | 802971 | 802972 | 802973 |
| 30 | SurvivalSpear | Survival_Spear_A | Survival_Spear_A_MI | SurvivalSpear_01 (camo skin) | 803067 | 803069 | 803070 | 803071 | 803072 | 803073 |
| 31 | TacticalMachete | Tactical_Machete | Tactical_Machete_MI | TacticalMachete_14 (stock GeoSkin skin) | 803167 | 803169 | 803170 | 803171 | 803172 | 803173 |
| 32 | TantoKnife | Knife | Knife_A_MI | TantoKnife_01 (camo skin) | 803267 | 803269 | 803270 | 803271 | 803272 | 803273 |
| 33 | Tomahawk | Tomahawk_Tactical_A | Tomahawk_Tactical_MI | Tomahawk_01 (camo skin) | 803367 | 803369 | 803370 | 803371 | 803372 | 803373 |
| 34 | Tonfa | Tonfa_A | Tonfa_MI | Tonfa_01 (camo skin) | 803467 | 803469 | 803470 | 803471 | 803472 | 803473 |
| 35 | Trident | Trident_A | Trident_A_MI | Trident_14 (stock GeoSkin skin) | 803567 | 803569 | 803570 | 803571 | 803572 | 803573 |
| 36 | Yari | Yari_A | Yari_MI | Yari_14 (stock GeoSkin skin) | 803667 | 803669 | 803670 | 803671 | 803672 | 803673 |

Dark Matter Popper: 800968 (Compound Bow).

## Release gate (no test content ships)

`patch/make_pak.py` now refuses to pack (unless `--allow-test-content`):

- any file whose path has `XPAnim`, `XPTest` or `Camo_XP_Anim_`;
- any file mentioning `_XPAnim`, `_XPTest`, `Camo_XP_Anim_` or `TEST BUILD` (ASCII or UTF-16);
- any custom camo skin (`WeaponSkins/*_XP_*`, not `*_XP_VFX_*`) carrying a GeoSkin, BC or BC2 tag. That last rule catches the Ice Axe diagnostics, including Teal Current, which points at the stock `FireAxe_C`.

`make_release.py` packs through `make_pak.py`, so a release cannot carry them.

- **Release build steps:** run `make_camos.py`, then `make_vfx_camos.py`. Never run `make_animated_camos.py` or `make_camo_tests.py`.
- **Generated tree used as the base:** `C:\Culling-play\patch\src` has static Ice Axe skins already. It still holds 112 unreferenced `*_XPAnim*`/`IceAxe_A_XPTest` packages; the test pak leaves them out.
- **Live pak:** the currently installed patch pak still contains them, and its Ice Axe Teal Current still has GeoSkin. The gate flags both.

## Performance

**Draw calls.**
- Waves, Drift and Popper add none: same sections, one material each.
- Dark Matter adds one translucent section per weapon mesh, so +1 draw for each visible weapon component: first person for the owner, third person for others.
- The shell casts no shadow, so there are no extra shadow-depth draws.

**Shader cost.**
- The body uses PM_Herc's opaque pass.
- The shell is a translucent pass with 5 texture samples (two cloud layers + depth for the fade). It covers the weapon's screen area once.

**Textures.** All shared across weapons; one copy loads per look in use.

| Texture | Size | Format | Memory (with mips) |
|---|---|---|---|
| T_VFX_Dark_Matter_BC | 1024² | DXT1 sRGB | ~683 KB |
| T_VFX_Dark_Matter_Drift_BC | 1024² | DXT1 sRGB | ~683 KB |
| T_VFX_Wave_{Abyss_Blue, Violet, Toxic_Green, Ember}_BC | 1024² each | DXT1 sRGB | ~683 KB each |
| T_VFX_Dark_Matter_M | 64² | DXT1 linear | ~3 KB |
| T_VFX_Wave_GP | 64² | DXT5 linear | ~5 KB |
| Mist clouds | stock T_Clouds_01 / T_cloud | | already in the game |

**Meshes.** Only Dark Matter's meshes grow. Extra data per weapon = shell vertices × (24 + skin weight bytes) + shell indices (2 bytes × 3 per triangle) + adjacency (2 bytes × 12 per triangle). Only the equipped weapon's copy loads.

| Weapon | Stock sections | Shell sections | Stock vertices | Shell vertices | Shell triangles | Extra mesh data (KB) | Shell offset |
|---|---|---|---|---|---|---|---|
| 357Magnum | 1 | 1 | 3134 | 3134 | 4016 | 228 | 0.080 |
| AlarmGun | 3 | 1 | 4380 | 3082 | 3401 | 208 | 0.123 |
| AutoBow | 3 | 1 | 10533 | 9571 | 10096 | 632 | 0.080 |
| BaseballBat | 1 | 1 | 1866 | 1866 | 2404 | 136 | 0.088 |
| BowieKnife | 1 | 1 | 1322 | 1322 | 1888 | 102 | 0.080 |
| BrassKnuckles | 1 | 1 | 710 | 710 | 744 | 47 | 0.080 |
| CampHatchet | 1 | 1 | 860 | 860 | 1262 | 67 | 0.080 |
| Chainsaw | 2 | 1 | 4420 | 4296 | 5572 | 314 | 0.131 |
| Cleaver | 1 | 1 | 326 | 326 | 394 | 23 | 0.080 |
| CompoundBow | 2 | 1 | 6605 | 6581 | 7359 | 447 | 0.098 |
| Crowbar | 1 | 1 | 532 | 532 | 834 | 43 | 0.080 |
| FiremansAxe | 1 | 1 | 767 | 767 | 1204 | 62 | 0.105 |
| Hammer_BallPein | 1 | 1 | 661 | 661 | 1056 | 54 | 0.080 |
| IceAxe | 1 | 1 | 1954 | 1954 | 2734 | 149 | 0.080 |
| Javelin | 1 | 1 | 464 | 464 | 640 | 35 | 0.196 |
| Katana | 1 | 1 | 1416 | 1416 | 2244 | 116 | 0.121 |
| Kukri | 1 | 1 | 810 | 810 | 1202 | 64 | 0.080 |
| Machete | 1 | 1 | 889 | 889 | 1262 | 68 | 0.080 |
| ManTracker | 1 | 1 | 719 | 719 | 1114 | 58 | 0.080 |
| Pike | 1 | 1 | 3057 | 3057 | 5738 | 276 | 0.198 |
| PipeWrench | 1 | 1 | 1749 | 1749 | 2768 | 143 | 0.080 |
| PitchFork | 1 | 1 | 2016 | 2016 | 3576 | 176 | 0.197 |
| RecurveBow | 2 | 1 | 3868 | 3297 | 4224 | 240 | 0.139 |
| Rifle | 2 | 1 | 11677 | 9902 | 9963 | 640 | 0.149 |
| SMG | 1 | 1 | 5625 | 5625 | 6778 | 396 | 0.080 |
| Sabre | 1 | 1 | 1427 | 1427 | 2028 | 110 | 0.091 |
| Sledgehammer | 1 | 1 | 456 | 456 | 706 | 37 | 0.106 |
| SteelPipe | 1 | 1 | 1949 | 1949 | 2578 | 144 | 0.080 |
| StunGun | 1 | 1 | 783 | 783 | 1180 | 62 | 0.080 |
| SurvivalAxe | 1 | 1 | 1899 | 1899 | 2178 | 131 | 0.080 |
| SurvivalSpear | 1 | 1 | 4631 | 4631 | 7432 | 381 | 0.183 |
| TacticalMachete | 1 | 1 | 947 | 947 | 1389 | 74 | 0.080 |
| TantoKnife | 1 | 1 | 1432 | 1432 | 2378 | 120 | 0.080 |
| Tomahawk | 1 | 1 | 873 | 873 | 1350 | 70 | 0.080 |
| Tonfa | 1 | 1 | 422 | 422 | 612 | 33 | 0.080 |
| Trident | 1 | 1 | 1359 | 1359 | 1896 | 103 | 0.184 |
| Yari | 1 | 1 | 2169 | 2169 | 3450 | 177 | 0.200 |

All 37 Dark Matter meshes together: 6164 KB on disk; at most one per equipped weapon is loaded.

## Tests and statuses

| Item | How | Status |
|---|---|---|
| Every generated package re-saves byte-identically | test_vfx_camos.py | PASS (static) |
| Every import resolves to a cooked stock package or a generated one, object and class matching | test_vfx_camos.py | PASS (static) |
| Every MIC parameter is a parameter expression of its root material (exact FName incl. number) and carries its GUID | test_vfx_camos.py | PASS (static) |
| Parent shader maps cooked for GPU skin; time-driven (pulse) / panning shaders as listed above | test_vfx_camos.py (d3dcompiler) | PASS (static) |
| skeletal_mesh layout model rewrites all 84 stock weapon meshes byte for byte | test_vfx_camos.py | PASS (static) |
| Dark Matter shell meshes: stock data kept as prefix, one slot → mist MIC, shell section mirrors the body section, offset along normals within 0.02, counts consistent, 16-bit indices, a sort entry per section | test_vfx_camos.py | PASS (static) |
| Wave/Drift/Popper meshes: export data = stock; header/export offsets identical (Popper adds one class name) | test_vfx_camos.py | PASS (static) |
| Skins: GeoSkin tag laid out like stock, points at a generated SkeletalMesh, no Camo/BC/BC2, ItemID/name/price/rarity = catalog | test_vfx_camos.py | PASS (static) |
| Catalog: 223 xp-vfx-camos entries, ID formula, IDs unique; registry has 223 records | test_vfx_camos.py | PASS (static) |
| Release gate passes VFX files, flags diagnostic skin / XPTest name / Camo_XP_Anim_ mention, make_pak refuses | test_vfx_camos.py | PASS (static) |
| Buying a VFX camo charges once and unlocks it on every weapon; Popper stays separate | camopurchase.test.js | PASS (server test) |
| Purchases and credit balance survive a server restart (profiles.json) | camopurchase.test.js | PASS (server test) |
| Other server tests (accounts, store, ranked, …) with the new catalog | server/test/*.test.js | PASS (server tests) |
| FUNC Popper (stock GeoSkin control) in Customization preview | in-game report | PASS (in-game, preview, build 778821d) |
| Dark Matter Popper in preview | in-game report | PARTIAL (works; upper limb partly stock teal) |
| Dark Matter (pulse only, no shell) on Bow and Katana in preview | in-game report | PASS (build 778821d); the shell build is NOT TESTED |
| Waves Ember / Toxic Green / Violet scroll in preview | in-game report | PASS (in-game, preview, build 778821d) |
| Wave Abyss Blue brightness | in-game report | FAIL on build 778821d (too dark), fixed colour NOT TESTED |
| Dark Matter galaxy shell (any weapon) | in game | NOT TESTED |
| Dark Matter Drift | in game | NOT TESTED |
| The 34 newly covered weapons (all looks) | in game | NOT TESTED |
| In match: 1st/3rd person, drop/pick up, other players see it | in game | NOT TESTED |
| Frame time with Dark Matter | in game | NOT TESTED |

## In-game test order

Equip in this order; the first failure isolates the broken piece.

1. **Wave Abyss Blue on the Compound Bow (800969).** Checks the brighter colour on a known-good route.
2. **Dark Matter Drift on the Katana (801573).** Checks the no-shell route with the galaxy picture.
3. **Dark Matter on the Katana (801567).** The galaxy shell. An error here but not at step 2 points at the added section. Otherwise check that the clouds drift over the glow.
4. **Wave Violet on the Crowbar (801070).** The first weapon whose skin comes from a `_01` camo skin rather than a stock GeoSkin skin. A failure here points at that template.
5. **Dark Matter on the Rifle (802367).** Covers the largest shell (9,902 extra vertices), a two-material mesh and a firearm.
6. **Wave Ember on the Chainsaw (800772).** Checks whether ChainsawSpeed is overridden: idle and revving.
7. The rest. In a match check first and third person, dropping and picking up, and what another player sees.

## Regenerating

```
python patch/make_camos.py <Paks dir>
python patch/make_vfx_camos.py <Paks dir> [--test-pak <base patch/src> <out.pak>]
python patch/test_vfx_camos.py <Paks dir>
```

`make_camos.py` deletes every `*_XP_*` skin and rewrites the `xp-camos` catalog entries, so run `make_vfx_camos.py` after it. The test pak is the base generated tree plus these files, with their 223 registry records appended. The base tree's unreferenced XPAnim/XPTest leftovers are left out.
