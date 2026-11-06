# Necro Mist skins

The Resurrection skull's animated mist eyes (`M_NecroMist`) in eight colours. Each colour comes as a full outfit (skull mask with its hood, top and pants, male and female) and as a weapon camo. Hats take one slot, so the hood and the glowing eyes are one item: the skull mask, with its hood dyed to match. They replace the animated camo attempt (see below).

## Build

Run both generators against the game's Paks folder, then the test:

```
python patch/make_eye_skins.py <Paks dir>
python patch/make_camos.py <Paks dir>
python patch/test_eye_skins.py <Paks dir>
```

- `make_eye_skins.py` writes the clothing packages, `patch/registry/eye_skins.bin`, the `xp-eye-skins` catalog entries and `patch/branding/eye_skins_preview.png`.
- `make_camos.py` builds the Necro Mist camos together with the other camo packs (`make_eye_skins.mist_camos`).

The generated packages are git-ignored, like every other generator's output, so the build machine has to run both generators before `make_pak.py`.

`python patch/make_eye_skins.py <Paks dir> --preview` redraws only the two swatch sheets (git-ignored, in `patch/branding/`). They show the textures, not in-game renders:

- `eye_skins_preview.png`: each colour's skull-mask eyes, the mask's dyed hood atlas, the top and the pants;
- `necro_mist_camos_preview.png`: each camo on the Ice Axe, Katana and Revolver texture atlases, composited as the weapon material does it.

## Colours and item IDs

| # | Colour | Skull mask + hood | Top (M / F) | Pants (M / F) | Weapon camo key |
|---|---|---|---|---|---|
| 1 | Blood Red | 119001 | 129001 / 229001 | 139001 / 239001 | `Necro_Mist_Blood_Red` |
| 2 | Toxic Green | 119002 | 129002 / 229002 | 139002 / 239002 | `Necro_Mist_Toxic_Green` |
| 3 | Violet | 119003 | 129003 / 229003 | 139003 / 239003 | `Necro_Mist_Violet` |
| 4 | Gold | 119004 | 129004 / 229004 | 139004 / 239004 | `Necro_Mist_Gold` |
| 5 | Ice White | 119005 | 129005 / 229005 | 139005 / 239005 | `Necro_Mist_Ice_White` |
| 6 | Hot Pink | 119006 | 129006 / 229006 | 139006 / 239006 | `Necro_Mist_Hot_Pink` |
| 7 | Ember Orange | 119007 | 129007 / 229007 | 139007 / 239007 | `Necro_Mist_Ember_Orange` |
| 8 | Abyss Blue | 119008 | 129008 / 229008 | 139008 / 239008 | `Necro_Mist_Abyss_Blue` |

- IDs follow the stock scheme: 11xxxx hats, 12xxxx and 13xxxx male top and legs, 22xxxx and 23xxxx female.
- Weapon camo IDs come from make_camos: `800000 + weapon × 100 + 59..66`.
- Prices in cull credits:

  | Item | Price |
  |---|---|
  | Skull mask + hood | 2,500 |
  | Top | 2,000 |
  | Pants | 1,500 |
  | Camo (unlocks that colour on every weapon) | 2,500 |

## How each piece is coloured

| Piece | Mechanism | Assets (`/Game/Remaster/EyeSkins/`) |
|---|---|---|
| Mask eyes | A MaterialInstanceConstant of `M_NecroMist` with both `Fog Tint` parameters set (colour ×2 and ×5, the stock magnitudes). It keeps M_NecroMist's panning-cloud animation. The mesh copy's eye slot points at it. | `MI_EyeMist<nn>`, `NecroskullHatEye<nn>` |
| Top and pants | The data asset's Primary/Secondary/Tertiary colours, which PlayerPawn writes to the clothing material's `ClothingColor_A/B/C`. The top also gets a child MIC of `MI_Top_Necro` with its glowing trim's `Emissive Color` in the colour. | `MI_EyeTop<nn>`, `MI_EyeTopF<nn>` |
| Mask hood | The skull mask mesh carries the hood too, on one atlas (`Necro_BC`). The hat material has no ClothingColor parameters, so the mask's data asset overrides its `BaseColor` texture, as the stock camo balaclavas do. That texture dyes the hood's cloth and emblem and leaves the skull's bone in its stock colour. | `T_NecroHood<nn>` |
| Weapons | Static camo from M_NecroMist's cloud texture (`T_Clouds_01`). | `Camo_XP_Necro_Mist_*` (make_camos) |

The data assets are `/Game/Cosmetics/Clothing/XP_Eye*_<Colour>` and `F_XP_Eye*_<Colour>`. The game lists clothing from that folder only (the path is compiled into the exe).

The mesh copies rename names to the same total length, so each copy's header and export offsets are byte-identical to the stock mesh. The test asserts this.

### Why the weapon camos are static

- `M_NecroMist` is a translucent mist material. On a weapon mesh it would replace the weapon's surface with see-through fog.
- The weapon material (`PM_Weapon_Master`) has no time input on its camo layer, so no camo texture can move.
- The only animated route is the GeoSkin mesh copy plus `Chainsaw_A_MI` panner material. That route produced "Serialization Error: Corrupt data found" in game, and its Ice Axe diagnostics still have no result.
- So the camos are static mist pictures made from the effect's own cloud texture in each colour. They draw like every other custom camo: opaque and readable.
- If the Ice Axe diagnostics ever prove the animated route, `patch/diagnostics/make_animated_camos.py` picks up every camo from make_camos, Necro Mist included (it would then have to move back into the release build and out of make_pak.py's test-content list).

## Status

- **Verified (static):** `test_eye_skins.py` passes.
- **Not verified:** the look in game. The following need one run through the launcher:
  - that the MICs render (the eye MIC's parent is a Material, and the top MIC's parent is a static-permutation MIC);
  - that the colours read as intended;
  - that every item appears in Customization and can be bought.

## Earlier attempt (diagnostics only)

The animated camo attempt is out of the release build:

- `make_animated_camos.py` and `make_camo_tests.py` live in `patch/diagnostics/` and `patch/build_release.py` never runs them;
- `make_pak.py` refuses to pack what they write (`<Mesh>_XPAnim*`, `Camo_XP_Anim_*`, `IceAxe_A_XPTest`, any skin pointing at them, anything saying `TEST BUILD`) unless `--allow-test-content` is given for a local diagnostics pak;
- `build_release.py` deletes those files from `patch/src` before it runs the generators, and `make_camos.py` rewrites every `*_XP_*` skin, so a rebuild puts the plain Ice Axe camo skins back.

The live 1.3.x paks still have the 4 Ice Axe diagnostic skins (and 111 `_XPAnim` assets) until the next release built this way. The server's ranked rewards hand out Teal Current (Hunter) and Lava Storm (Reaper, Fireman's Axe): after a clean build those are ordinary static camos.
