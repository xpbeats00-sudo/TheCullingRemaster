# Changelog

## 2026-11-03: full project audit

Checkpoint before these changes: git `9fe0ad9`.

### Fixed
- **Server:** match results with non-finite or absurd numbers (e.g. `damage: 1e999`) no longer write Infinity/NaN credits and XP into `profiles.json`. Values are bounded (kills ≤ 200, damage ≤ 1e6, time alive ≤ 4 h, func ≤ 1e6).
- **Server:** `profiles.json` is written atomically (temp file + rename), so a crash mid-save can't truncate it.
- **Server:** removed the `CARDS_OWNED_TEST` diagnostic flag. Custom calling cards are again owned only once bought.
- **UI:** the card screen no longer dumps every card as JSON to the console on each refresh (patched copy of the stock `DynFlairItem.js`).

### Added
- `UiTrace.js` and the `POST /api/uitrace` server route: breadcrumbs around card-screen native calls, to locate the calling card page freeze.
- `server/lastbreath.js` and `server/data/lastbreath.ini`: the Last Breath rules core (zone timeline, gas damage, rounds, best of 7). Not wired into the game; see `GAME_MODE_INTEGRATION_REPORT.md`.
- Tests: `server/test/matchresult.test.js` and `server/test/lastbreath.test.js` (11 cases). `CULLING_DATA_DIR` lets tests run the server against a throwaway data folder.
- `patch/report_skins.py`, which generates `ANIMATED_SKIN_AUDIT.md`.
- Reports: `FULL_PROJECT_AUDIT.md`, `ANIMATED_SKIN_AUDIT.md`, `GAME_MODE_INTEGRATION_REPORT.md`, `SESSION_REPORT.md`.

### Known issues (unchanged)
- Calling card page freeze: root cause not found. Instrumented; needs one in-game run.
- Custom camos are static. The animated path caused "Corrupt data found" and is reverted except for 4 Ice Axe diagnostic skins.

## Before 2026-11-03 (summary of earlier sessions)
- Night menu arena: fog, sea, blue floodlights, moon, live sky (16K panorama, cubemap), meteors, supernovae and hyperdrive streaks.
- Branding: Creepster font, red menu items turning white on hover, rounded UI, larger logo, version label and status bar removed.
- 678 calling cards (48 animated sprite-sheet cards), 59 custom camos on 37 weapons (2183 skins).
- Shop: base-game items free, custom items for cull credits, 10,000 starting credits.
- Ranked Solo (local test mode): placement-based ELO, 9 tiers with the user's emblems, rank badge on the player card.
