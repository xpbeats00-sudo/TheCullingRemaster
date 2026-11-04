# Inventory and equipment

The Remaster uses the game's own inventory and equipment; nothing is layered on top.

## Inventory

- 3 slots, 4 with a satchel (Crafted Satchel), 5 with a backpack. Slots 4 and 5 show locked until then (`hud.js` `Satchel_Locked` / `Backpack_Locked`).
- Fists when a slot is empty.
- The HUD learns about changes from the engine (`SetItemForSlot`, `RemoveItemFromSlot`, `SetWeaponSlotEnabled`, `SelectWeaponSlot`).

## Starting items (Showdown)

Showdown players spawn with the whole kit in their inventory; nothing is on the ground. This uses the game's own mechanism:

- Perks add to the player stat `SpawnWithWeapon`. `PlayerPawn.GetSpawnWithWeaponClasses` gives one item per bit: 1 Man Tracker, 2 Backpack, 4 Satchel, 8 Body Armor, 16 Alarm Gun, 32 a random Tier 1 melee weapon.
- No selectable perk uses bit 4 or 32. Only the removed, disabled `Perk_JumpStart` had 32. `make_showdown.py` makes bit 4 give Muscle Man Milk and bit 32 always give a Tomahawk.
- A Showdown-only perk (`Perks/Showdown/Perk_Showdown`, a copy of `Perk_JumpStart` not in the asset registry, so not in the perk menu) grants 32 + 8 + 4. The Showdown mode forces it on everyone, bots included (`OverridenPerks`, `bEnableBotPerks`).
- The kit: Tomahawk, Tactical Body Armor (on at spawn), Muscle Man Milk (slot 1, use it before fighting).
- Normal matches are unaffected: their perks never set bits 4 or 32.

Verified in game through the launcher (2026-11-04): the player spawned with Muscle Man Milk in slot 1, the Tomahawk in slot 2 (in hand) and armor on. The bot's kit is not visually confirmed yet: in one run it dealt a bleed wound and killed the player quickly, in another it didn't engage.

## What equips itself

Items with the game's `bUseIfSpawnedWith = True` are used when the player is given them (an airdrop kit), not picked up:

| Item | ID | Effect |
|---|---|---|
| Tactical Body Armor | `BodyArmor_C` | 50% of damage absorbed, breaks after 30 |
| Crafted Armor | `HardenedArmor_C` | 50% of damage absorbed, breaks after 20 |
| Crude Armor | `CrudeArmor_C` | crafted armor |
| Backpack | `Backpack_C` | +2 slots |

Everything else (weapons, injects, Muscle Man Milk, healing, throwables, traps, utility) is taken and used by the player.

Differences from the requested rules:
- **Backpack** also uses itself when given in a kit (it only adds slots). It is left as the game has it: changing it would change classic airdrops. None of Showdown's kit has one.
- **Armor found on the ground** is equipped by picking it up and using it. The pickup code is compiled into the game and can't be changed in the cooked build.

## Server side

The server never holds in-match inventory: matches run on the player's PC (no server-capable game binary). It records results (kills, damage, XP, round wins) and owns account items (cosmetics, airdrop unlocks).
