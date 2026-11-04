# Inventory and equipment

The Remaster uses the game's own inventory and equipment; nothing is layered on top.

## Inventory

- 3 slots, 4 with a satchel (Crafted Satchel), 5 with a backpack. Slots 4 and 5 show locked until then (`hud.js` `Satchel_Locked` / `Backpack_Locked`).
- Fists when a slot is empty.
- The HUD learns about changes from the engine (`SetItemForSlot`, `RemoveItemFromSlot`, `SetWeaponSlotEnabled`, `SelectWeaponSlot`).

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
