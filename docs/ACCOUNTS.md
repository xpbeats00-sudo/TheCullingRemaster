# Player accounts

Playing online needs an account: a username (unique, also the in-game name), an email and a password. The launcher signs in; the game itself still logs in with `POST /api/login {userid}` and is let in only because the launcher asked for it first (a play grant). Code: `server/accounts.js` (storage, hashing, tokens, grants) and the `/api/account/*` and `/admin/*` routes in `server/server.js`. Tests: `server/test/accounts.test.js`.

## API

JSON in and out, under the existing `/api` base (`https://xplab.shop:8443/api` on the VPS). Behind Caddy the client address is the last `X-Forwarded-For` entry.

| Request | Answers |
|---|---|
| `POST /api/account/register` `{ username, email, password, claimUserID? }` | 200 `{ token, username, userID, claimed }`<br>400 `invalid-username` / `invalid-email` / `weak-password`<br>409 `username-taken` / `email-taken`<br>429 `too-many-attempts`<br>503 `server-full` (account or profile cap) / `busy` (password hashing queue full) |
| `POST /api/account/login` `{ username, password }` | 200 `{ token, username, userID }`<br>401 `wrong-credentials` (unknown user and wrong password alike)<br>429 `too-many-attempts`<br>503 `busy` |
| `GET /api/account/me` + `Authorization: Bearer <token>` | 200 `{ username, userID, email }` · 401 `signed-out` |
| `POST /api/account/play` + Bearer | 200 `{ username, userID }` (records the play grant) · 401 `signed-out` |
| `POST /api/account/logout` + Bearer | 200 `{}` (revokes that token; also 200 for an unknown token) |
| `POST /api/login` `{ userid }` (the game) | as before, or 403 `{ "errorCode": "account-required", "error": "account-required" }` when enforcement is on and there is no valid grant |

Errors are `{ "error": "<code>" }`. Account responses carry `Cache-Control: no-store`.

Rules:

- **Username**: trimmed, runs of spaces collapsed to one, 2-20 characters of `A-Z a-z 0-9 _ . - space`. Unique ignoring case; sign-in ignores case too. Returned as typed (after trimming).
- **Email**: trimmed, lowercased, at most 254 characters, `local@domain.tld`. Unique. Stored only: the server sends no email.
- **Password**: 8-128 characters.
- **claimUserID** (optional, `steam:` + 17 digits): the account takes over that existing profile only if the profile exists, no account owns it, and its last game login came from the same address as this sign-up. Otherwise the claim is ignored without an error and the account gets a fresh ID; `claimed` says which. A profile can be claimed once. With enforcement on, a profile's last-login address only changes through account logins, so in practice only profiles that played before enforcement can be claimed.
- **Fresh user ID**: `steam:` + (76561197960265728 + a random 32-bit number), unused by any profile or account. Registration creates the profile.
- **Tokens**: 32 random bytes (64 hex characters). Valid 30 days from sign-in (not extended by use). At most 8 per account (the oldest is dropped), 100,000 in all. Separate from the game's socket tokens.
- **Rate limits**, per client address unless noted:

  | What | Allowance |
  |---|---|
  | Well-formed sign-ups (including ones refused as taken) | 20, then 1 per minute |
  | Accounts created | 5, then 1 per 10 minutes |
  | Failed sign-ins per address | 10, then 1 per minute |
  | Failed sign-ins per username | 10, then 1 per 5 minutes |

  A sign-in that turns out right is not counted. The per-username limit means someone can keep a player from signing in for a while by guessing wrong on purpose; that is the trade for slowing password guessing.
- **Totals**: accounts are capped by `CULLING_MAX_ACCOUNTS` (default: `CULLING_MAX_PROFILES`, 100,000).
- **Password hashing**: scrypt N=2^15, r=8, p=1, 64-byte key, 16-byte random salt, maxmem 64 MB, stored as `scrypt$32768$8$1$<salt>$<hash>` (base64). Checked with `timingSafeEqual`. An unknown username is checked against a dummy hash, so it costs the same time as a wrong password. At most 2 hashes run at once (32 MB each) and 64 wait; past that the answer is 503 `busy`.

## How the game is bound to an account (the play grant)

1. The launcher signs in (`/api/account/login` or `register`) and keeps the token.
2. It writes the account's `userID` into the game's `force_steamid.txt`, so the game sends exactly that ID.
3. Right before starting the game it calls `POST /api/account/play`. The server records a grant: this account's userID, the hashed client address, valid for 12 hours.
4. The game posts `/api/login {userid}`. With enforcement on, this is accepted only if that userID has a live grant from the same address. Each accepted game login extends the grant by another 12 hours, so a long session or a re-login doesn't expire it.

Grants are kept in memory and in `accounts.json`, so a server restart in the middle of a session doesn't kick anyone. One grant per account; a new PLAY replaces it (new address, new 12 hours). A password reset removes it.

**Limits, plainly:** the game proves nothing; the address is the only check. Anyone on the same public IP as a player who pressed PLAY in the last 12 hours (the same home network, the same café or campus NAT, a carrier-grade NAT shared with strangers) can log the game in as that player during the grant, if they know the player's userID (it is not secret: it is in the player's game folder and in anything the player shares). They get that player's profile in the game, not their password, email or account token. Separately, a player whose address changes (for example a VPN reconnect) has to press PLAY again before the game can log in again.

Enforcement: environment variable `CULLING_REQUIRE_ACCOUNT`, on unless set to `0`. The installer keeps the service's current setting unless told otherwise, and starts with it off: `install_vps.ps1 -RequireAccount 1` turns it on (do this only once launcher 1.3.0 is published), `-RequireAccount 0` turns it off. So `Update Culling Server.bat` never changes it. With it off, `/api/login` behaves exactly as before accounts (any userID logs in), and the account endpoints still work.

## Personal data stored

| Data | Where | Form |
|---|---|---|
| Username, email | `C:\culling\data\accounts.json` | plain text (needed to sign in and for the operator to identify a player) |
| Password | `accounts.json` | scrypt hash with salt; never the password |
| Account tokens | `accounts.json` | sha256 of the token; never the token |
| Play-grant address | `accounts.json` | hashed (see below), with an expiry time |
| Last game-login address per profile | `profiles.json`, field `lastLoginIpHash` | hashed |
| Address-hash secret | `C:\culling\data\ip-hash-secret.txt` | 32 random bytes, created on first start |
| Replaced profiles | `C:\culling\data\import-backups\` | the profile JSON as it was before an import |

Addresses are stored as the first 128 bits of sha256(secret, address). Without the secret file they can't be matched against a list of addresses. Anyone holding both files could test a guessed address. Deleting `ip-hash-secret.txt` invalidates all play grants and claims; it is recreated on the next start.

Passwords, tokens and emails are never logged. The log has the username (the public in-game name) and userID on account creation, and the userID on play grants, game logins and password resets. `/metrics` reports counts only: accounts, live tokens, live grants, hashing queue, rate-limiter table sizes, and `accounts.json` save statistics.

`accounts.json` is written like `profiles.json`: atomically, at most once a second, and on stop. If it can't be parsed at start, it is copied to `accounts.json.unreadable-<time>` and the server starts with no accounts. Restore the copy before players register again, or names will be taken by new sign-ups.

## Rollout order

1. **Publish the launcher with accounts first.** Players must be able to sign in and press PLAY before the server requires it.
2. Then deploy the server with enforcement on (the default).

If the server goes out first, deploy it with `-RequireAccount 0` (or set `CULLING_REQUIRE_ACCOUNT=0` in the service XML). Otherwise every player on the old launcher gets `account-required` and can't play. Run the installer again without the switch once the launcher is out.

Players who already played on the server can keep their progress: the launcher can send `claimUserID` with their old ID when they sign up from the same network as their last game login.

## Operator commands

On the VPS, while the service runs, from `C:\culling\app`:

```
C:\culling\node\node.exe tools\account_admin.js import <username> <path\to\profiles.json> <localUserID>
C:\culling\node\node.exe tools\account_admin.js reset-password <username>
```

Add `--port <n>` if the service doesn't listen on 8100.

- **`import`**: the one-time move of the owner's local progress. It reads the local server's `profiles.json`, picks `<localUserID>` (with or without the `steam:` prefix), and replaces the account's profile with it. The current profile is first written to `C:\culling\data\import-backups\<userID>-<time>.json`. It prints a before/after summary: credits, XP, level, wins, kills, owned items.

  What is kept from the imported profile:
  - credits, premium currency, card, creation time;
  - owned items that exist in the server's catalog;
  - known stats (finite, non-negative; others reset to defaults);
  - ranked (with a pending match cleared; rating changes in history may be negative);
  - last match.

  Unknown fields are dropped. `userID` becomes the account's. The level is recomputed from XP when the server knows the game's level curve. A profile without `economy: 1` gets the pre-shop rule: credits reset to 10,000.
- **`reset-password`**: sets a random 16-character temporary password, signs the account out everywhere (all tokens), removes its play grant, and prints the password once. It is not stored or logged; give it to the player privately. There is no change-password endpoint yet, so it stays their password until the next reset.

Both call `POST /admin/import-profile {username, profile}` and `POST /admin/reset-password {username}` on `http://127.0.0.1:<port>`. These answer only loopback requests without proxy headers, like `/metrics`. Through Caddy (which always adds `X-Forwarded-For`) they return 404.
