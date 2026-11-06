# Leaderboard

A global leaderboard of players, opened from the main menu's LEADERBOARD item. The stock LEADERBOARDS screen only showed your own match history, and `CustomMatchSettings.js` still hides it.

Code:

- `server/leaderboard.js` computes the boards.
- `server/server.js` wires it up: the `remaster-leaderboard-get` socket event, the cache invalidation in `saveProfiles()` and account creation, and `/metrics` stats.
- `patch/src/Victory/Content/uiresources/FrontEnd/js/Leaderboard.js` is the panel.
- `ClientWeb.js` forwards `remaster-leaderboard` to the panel.
- `patch/make_branding.py` (`add_leaderboard`) adds the menu item and the script tag.

Tests: `server/test/leaderboard.test.js` and `patch/test_menu_items.py`.

## Boards

| Board | Value | Listed when | Ties broken by (order only) |
|---|---|---|---|
| Ranked (Solo) | this season's rating (capped at `ranked.CONFIG.maxRating`), with the tier | at least one ranked match in the current season (`profile.ranked.season`) | ranked wins |
| Ranked Duo / Trio / Quads (`ranked_duo`, `ranked_trio`, `ranked_quad`) | that mode's rating this season, with that mode's tier ([RANKED_TEAMS.md](RANKED_TEAMS.md)) | at least one match of that mode this season (`profile.rankedTeams.<mode>`) | that mode's wins |
| Wins | matches won | 1 win or more | fewer matches |
| Kills | kills | 1 kill or more | fewer matches |
| K/D | kills per death (deaths = matches not won, as on the player card) | at least 10 matches (`minMatches`) | more kills |
| Showdown | Showdown series won | 1 series won or more | fewer series lost |
| Time played | minutes alive in matches (`stats.minutesAlive`) | 1 minute or more | - |

- Players with the same value share a position (1, 2, 2, 4). Within a tie the list is ordered by the second key, then by username.
- Each board lists the top 50 (`size`).

## Who is listed

- **Accounts only.** Only players with a Remaster account appear, by their account username. Profiles without an account (old Steam-only profiles, anything that never signed up) are never listed or counted.
- **No IDs.** No userID or Steam ID is ever sent. Each entry has `position`, `username`, `level`, `rank` (tier for the emblem), `cardID` (the calling card art), `value`, and the board's details (`matches`, `wins`, `kills`, `deaths` or `lost`).

## Your own row

- Every board carries `you`: your entry with your position, even outside the top 50.
- If you aren't listed on a board, `position` is `null` and `value` is your figure so far. On K/D, `needMatches` says how many more matches you need.
- A signed-in player without an account sees the boards with `you: null`.

## Socket events

- Client to server: `remaster-leaderboard-get` (no payload). The socket must be logged in, like every other event.
- Server to client: `remaster-leaderboard`. It has these fields:
  - `season` `{id, name}`
  - `updatedAt`
  - `size`
  - `minMatches`
  - `you` (your username or `null`)
  - `boards`: `[{id, players, top: [...], you}]` for the ids `ranked`, `wins`, `kills`, `kd`, `showdown`, `time`, `ranked_duo`, `ranked_trio` and `ranked_quad` (the team modes last, so the older boards keep their places). Each board also has `mode`: `solo`/`duo`/`trio`/`quad` on the ranked boards, null otherwise.

  Every board comes in one answer, so switching tabs never asks again.
- **Rate limit.** Each player gets one request every 2 seconds, in bursts of 5. Over the limit the answer is `{error: "slow-down"}`. The panel keeps what it shows, or asks again after 2.5 s if it has nothing yet.

## Cache

- Sorting every account is not done per request. The boards are computed once and reused.
- They are recomputed when something changed (any `saveProfiles()`, a new account) and the last computation is at least `CULLING_LEADERBOARD_MIN_AGE_MS` old (default 30 s).
- They are also recomputed every 5 minutes regardless.
- A finished match therefore shows up within about 30 seconds.
- `/metrics` shows `leaderboard: {computedAt, computations, players}`.

## The panel

- It looks like the Friends panel.
- **Tabs:** Ranked Solo, Ranked Duo, Ranked Trio, Ranked Quads, Wins, Kills, K/D, Showdown and Time played.
- **Rows:** your position (gold, silver and bronze for the top 3), level, name and details, rank emblem (`/images/ranked/<tier>.png`) and the value, over the player's calling card art.
- **Your row:** it is highlighted in the list, and pinned under it with your position, or with what you need to get listed.
- Clicking a row opens that player's card (`RemasterFriends.showCard`).
- Escape closes an open card first, then the panel.
- The panel never mentions how matches are filled.

## Rollout

1. Deploy the server: `server/leaderboard.js` is a new file next to `server.js`.
2. Build a client release with `js/Leaderboard.js` and the updated `ClientWeb.js`.
3. Apply the menu item to the generated `FrontEnd.html`:

   ```
   python patch/make_branding.py --menu-only
   ```

   This is idempotent. A full `make_branding.py` run adds it too.

A client without the server update shows "Loading..." in the panel. An old server never answers `remaster-leaderboard-get`.
