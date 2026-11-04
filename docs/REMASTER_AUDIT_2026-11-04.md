# The Culling Remaster — Full Remaster Gap Analysis & Roadmap: Audit (2026-11-04)

Audited roadmap: `C:\Culling\docs\THE_CULLING_REMASTER_FULL_REMASTER_ROADMAP.md`. Code was read at `C:\Culling-play`, live state at the three public HTTPS endpoints, and build output in `C:\Culling\releases`. All checks were read-only. Where the verifier corrected an area auditor, the verifier's result is used. "Not verified in game" means only a runtime test would prove the item.

Owner's season-start rule: ranked must make **level 15+ and any tier above T4 (Hunter) impossible**, and no bot may rate above T3-T4.

## 1. Executive summary

- **Live:** game release **1.3.2** and launcher **1.3.1**. The manifest at `https://xplab.shop:8443/remaster/manifest.json` has a valid Ed25519 signature checked against `launcher/lib/releasekey.js`. `download/launcher.json` matches it (version, size 84,740,992, sha256 f618e94a…8038). **1.3.3** is built locally (`releases\LATEST`) and not published.
- **Season rule: not met, on server or client.**
  - Bot cap: commit `e33c4fd` (bots ≤1399 / Hunter, lobby level ≤14) is only on `origin/bot-names`. PR #25 merged one minute earlier (`052d1b2`).
  - Player caps: ratings, XP and levels have no ceiling, and match results come from the client.
  - Field size: ranked scores a 51-player field while real matches have 16, so finishing **last every match still climbs** (Executioner after about 81 to 84 matches with the bot cap; Legend without it).
- **Account server:** the hardening is live (`/metrics` returns 404 through Caddy, HSTS, no X-Powered-By). The deployed commit cannot be identified because `/health` returns only `{"ok":true,"users":0}`. There are no data backups and no server rollback path.
- **Launcher and pipeline:** they work and are tested (launcher 75/75, deploy 10/10, server 10 test files all pass). Untested so far: a live rollback, a real reboot, in-game login, and an upgrade from 1.1.0, which can neither self-update nor sign in.
- **Multiplayer:** matches are still offline against bots on each PC. Static analysis shows `Victory.exe` is a UE **Client-target** build with `UWorld::Listen` compiled to `return false` (0x14143e6f0 = `32 c0 c3`). The earlier "hosting worked" reading was Goldberg's own port 47584. The client join path (`ConnectToServer` / `SvrNonce`) is intact.
- **Content:** catalog counts check out (2,183 skins, 678 cards, 9 ranked rewards). The live release ships the **Ice Axe diagnostic skins**, which can be bought and are also unlocked by the Hunter and Reaper rewards. It also ships calling cards using third-party IP and real-person likenesses, and redistributes the game, Goldberg and Func binaries with no licence or provenance record.
- **Docs:** KNOWN_ISSUES, NEXT_STEPS, TEST_RESULTS, CHANGELOG and SESSION_REPORT all describe the pre-1.3.x state.

**Single biggest blocker:** there is no server-capable game binary. This blocks M1/M2, trusted ranked results and real multiplayer. **Most urgent:** enforce the season caps on the server.

**What changed since the roadmap was written:**
- Merged: #11, #12, #13, #14/#16 accounts, #15/#20 self-update, #19/#23/#24 lobby, Play screen and pregame lobby, #21 click-freeze fix, #22 fast publish, **#10 bot tuning** (no longer a draft) and **#25 bot names** (no longer open).
- Published: 1.3.1 and 1.3.2. Accounts are now required on the VPS.
- The Listen stub finding is new.

## 2. Status per roadmap area

| Area | Roadmap said | Verified now | Evidence | Remaining gap |
|---|---|---|---|---|
| Launcher/release | 1.2.0 on an unmerged PR; 1.1.0 live | Stale. Launcher 1.3.1 and game 1.3.2 live | Live manifest and launcher.json; #11 = 728ffbb | Publish 1.3.3 from main; record build provenance |
| Launcher features | Diff updates, signing, resume, repair, rollback; 57 tests | Done in code; **75** tests pass | `npm test`; sync.js:615 rollback; main.js:89 downgrade refusal | Live rollback, real reboot, real quit mid-download |
| §4.2 public-release matrix | Clean install/update/repair/rollback | Partial | TEST_RESULTS.md:38-44 (fresh install and repair, on 1.1.0/1.2.0 era) | No test against 1.3.x; no live self-update 1.3.0→1.3.1 |
| In-game login smoke test | Required | **Not done** (verifier) | TEST_RESULTS.md:74 "not confirmed" | Owner watches launcher sign-in → menu → VPS login |
| Signing key backup | Back up offline | Blocked on owner | Key at `%USERPROFILE%\.culling-release\release_ed25519.pem`, unencrypted PKCS#8 | Owner confirmation; restore drill |
| Code signing | Decide | Not started | Setup exe `NotSigned` | Decision, or a disclosure on the website |
| Server hardening (#12/#13) | Prod vulnerable until deployed | Stale. Merged and live | `/metrics` 404 (pre-#13 catch-all gave 200); npm audit 0 high/critical | Deployed commit cannot be seen; add a build id |
| Watchdog | Verify | Implemented; tested only with `-DryRun` locally | SERVER_PERFORMANCE_AUDIT.md:174 | VPS task state, log, real restart |
| VPS load test | 30 clients | Not started | KNOWN_ISSUES.md; no VPS numbers | Run load.js over loopback on the VPS |
| Backups / server rollback | Drill | Not started | No backup code; install_vps.ps1:80-84 overwrites the app | Scheduled backups, pre-deploy snapshot, restore drill |
| Phase 6 capacity limits | — | Partial (verifier) | server.js:54-57, 323-325, 769; accounts.js:25-32 | Account-server limits only; not proven on VPS; no game server |
| Phase 6 crash recovery | — | Partial (verifier) | WinSW restart; server.js:1196-1201; shutdown.test 2/2 | Account server only; not observed on VPS |
| Unreal project | Cooked 4.15.3 client, no source | Confirmed, and worse | "WindowsClient" inlined; no "WindowsNoEditor"; server CVars absent | Client target means hosting needs another binary |
| Online multiplayer | `offline:<map>` | Accurate | server.js:921-936; ClientWeb.js:1408-1415 | Everything from server allocation on |
| Route C | "Not a safe promise" | Understated: stock exe cannot host | LoadMap → Listen stub (0x141644cd2 → 0x14143e6f0) | Runtime and Func.Client patching not ruled out |
| Client join path | — | Present, never exercised | ClientWeb.js:1419-1425; `open %s?Nonce=%s`; `ServerNonceFailed` | A host started with `?SvrNonce=<backend serverNonce>` |
| Vertical slice steps 1-2 | — | **Not done** (verifier) | Only socket test clients (matchlobby.test.js:165-176) | Two real PCs logging in and sharing a lobby |
| Vertical slice steps 3-9 | — | Blocked | No server binary | — |
| Core gameplay | Offline vs bots works | Done, not verified in game | Live patch pak sha256 3f2c7297… = releases\1.3.2 | No regression pass on record |
| Phase 2 audit | Gameplay audit, compatibility matrix | Not started | Deliverables absent | Whole phase |
| Last Breath | Backend rules tested | Accurate; not wired | lastbreath.js "NOT wired"; 11/11 tests | Blocked on editor and multiplayer |
| Showdown tile | — | Published in 1.3.2; not verified in game | Pak: `showdown_play`, "Coming soon" | Naming mismatch: Showdown vs Last Breath |
| Ranked | Local test-mode ELO | Wording partly stale; substance holds | Live per account with rewards; `localTestMode:true`; 50 virtual bots | Trusted results, caps, real field size, seasons |
| Bots | Draft tuning kept separate | Stale: #10 merged (1dea901) | MatchBot.uasset in 1.3.2/1.3.3 = stock (963402d5…); sight tuning only in 1.3.3; AI budgets in no build | Source and shipped assets disagree; no playtest |
| Bot cap / names | — | Cap only on bot-names; names (#25) merged; both only in 1.3.3 | `git branch -r --contains e33c4fd`; VictoryGameMode has "Dominoss" in 1.3.3 only | Merge, deploy, publish |
| Lobby / map vote | — | Done, not verified in game | matchlobby 11/11; server.js:864-886 | Members never share a match; pregame lobby (#24) only in 1.3.3 |
| Catalog counts | 2,183 / 678 / 9 | Verified statically | catalog.json; patch/src counts | In-game display and equip |
| Weapon skins (animated) | Ice Axe diagnostics pending | Still pending; diagnostics are **in the live pak** | Pak read; ANIMATED_SKIN_AUDIT.md:36-42 "awaiting report" | Owner result for each of the 5 cases |
| Calling-card freeze | Root cause unknown, untraced | Partly stale: traced once | freeze-trace.log ~205-213 (SetPreviewItem 191001 never returned); about 29 later opens completed | Reproduce on a local trace build; click fix unconfirmed by owner |
| Cosmetics/inventory | Entitlements not served | Stale: served; crates and premium store disabled | server.js:1051-1098; camopurchase test passes | Per-account loadout; set-card validation |
| Menu visuals | Done | Done, not verified in game | Generators in patch/ | No frame-time captures |
| Phase 3/4 visuals and audio | — | Menu only; match maps and audio untouched | No match-map or Wwise generators; 3,466 .wem + 8 .bnk shipped stock | All deliverables missing |
| Accessibility | Launcher checks begun | Partial | Focus ring 6d62f06; reduced-motion CSS; min window 1100×660 | High-DPI; in-game options audit |
| Phase 1 docs deliverable | Update KNOWN_ISSUES/TEST_RESULTS/NEXT_STEPS | **Not done** (verifier) | Last edited a7084ff 03:15, before #21-#25 | Rewrite against the live state |
| Licensing/privacy | Verify | Not started | No LICENSE/NOTICE in repo or manifest; no privacy policy | Owner rights decision; notices; policy |

## 3. Stale roadmap claims to update

1. §3 Launcher/release and P0 actions 1-2 (roadmap l.51, 69, 164): change to "1.3.2 and launcher 1.3.1 live; 1.3.3 built, unpublished".
2. §2 "57 automated tests": change to 75 launcher tests in 8 suites, plus 10 deploy tests and 10 server test files.
3. §3 Account server "vulnerable until merged/deployed": the hardening is live. Replace with "deployed commit unknown; no backups".
4. §3 Bots "draft exists" and P0 action 6 "keep separate": #10 is merged and untested. Its MatchBot intervals and AI budgets are in no build.
5. §3 Calling cards "never traced": one trace exists. The hang came after the list rendered, inside native `SetPreviewItem(191001)`.
6. §3 Cosmetics "entitlements not served": they are served. Only crates and premium purchases are disabled.
7. §3 Ranked "local test-mode": ranked is now a live public ladder with real rewards, still fed by client-reported results.
8. §5 Route C: change "not a safe promise" to "stock Victory.exe cannot host (Listen stubbed); needs a server build, the Func lead, or native patching". Add the Func mod and Goldberg, which the roadmap never mentions.
9. Phase 1 "Launcher 1.2.0 merged and published": superseded by 1.3.x.
10. Keep as open (not stale): the Phase 1 docs deliverable, the in-game login smoke test, and vertical slice steps 1-2.

## 4. New findings (not in the roadmap)

**Critical**
- **C1. The ranked field is 51 but real matches have 16, so last place gains rating.** Evidence: ranked.js:30 `field: 51`; server.js:873 `matchBots: 15`; hud.js:3082 sends Rank 1..16; hud.js:3127 shows "PLACE x OF 51". Simulation with always 16th: Executioner after about 81 to 84 matches with the cap. On main (no cap) it reaches Legend after about 243.
- **C2. No server-side ceiling or trust check on ranked, XP or level.**
  - `/api/matchresult` takes victory, placement and damage from the request body (server.js:433-448). Damage up to 1e6 makes one forged result worth about 1,031,750 XP. Level 15 starts above 79,749 XP.
  - `/api/setlevel` accepts levels 1 to 1000 (server.js:480-491).
  - The ticket is matched by IP when there is no token (session.js:127-145).
  - Forged wins with the bot cap: T5 after 27 results, Apex after 226. Player rating has no upper bound (ranked.js:146).
- **C3. The shipped Victory.exe cannot host a match** (Client target, Listen stubbed). Static evidence only; Func.Client runtime patching is not ruled out.

**High**
- **H1. The bot T4 / level-14 cap is not on main** (e33c4fd is only on bot-names). Live 1.3.2 has no lobby bot roster at all (MatchLobby.js is 13,999 B). A client built from main would show bot ranks up to Warlord and levels up to 42. VPS deployment of the cap cannot be checked.
- **H2. Players on launcher 1.1.0 are stranded.** They have no self-update and no sign-in, and the server returns 403 `account-required` (server.js:63, 373-375). 1.2.0 was never published, so this mainly affects 1.1.0 users. What the game shows them is not verified in game.
- **H3. No backups of account or profile data.** The update script overwrites the app with no snapshot (install_vps.ps1:80-84).
- **H4. Ice Axe diagnostic skins are in the live pak and can be owned.** Arcane Surge is the path that gave "Serialization Error". Teal Current swaps in the FireAxe_C mesh and is the **Hunter (T4)** reward; Lava Storm is the Reaper reward.
- **H5. Redistribution has no licence or provenance record.** It covers Victory.exe and paks, stock Wwise audio, Valve's `steam_api64_ORIGINAL.dll`, Goldberg `steam_api64.dll` (LGPL-3, no notice), Func.Launcher/Func.Client and the UE4 prereqs (manifest 1.3.2). One area rated this critical.
- **H6. Calling cards sold for credits use third-party IP and real-person likenesses, some with adult or drug themes.** Examples: Goku, Kakashi_Obito, Homelander, Ryan_Gosling, Anime_Thighs, Weed_Kiss. They are in the 1.3.2 pak. The images and the 630 classic cards were not reviewed.
- **H7. The Func mod is the most credible lead for a compatible server.** Func.Client.dll has remote-pawn and net-close strings, the Func.Launcher example uses `-FuncJoin=127.0.0.1:7777`, and the original API was `theculling.atch.ooo`. Whether Func ever hosted servers is unknown.
- **H8. Placement comes from `SetRewardRank`** (hud.js:2549-2551). If the value is missing, the result is rejected and later scored as abandoned (last of 51). The code path is confirmed; its in-game meaning and timing are unverifiable here.

**Medium**
- **M1. Releases have no provenance and can be built from unmerged code.** LATEST=1.3.3 was built from e33c4fd, and `Publish Release.bat` with no argument publishes LATEST. The manifest records no commit.
- **M2. The rollback advice in publish_release.ps1 locks players out.** "Publish the previous release again" makes updated launchers reject the older manifest and go offline (main.js:85-90, 110-114). Its default `-Release` is still 1.1.0.
- **M3. Instant tickets.** The private-lobby `lobby-start-match` event starts a payable ticket with no wait (server.js:1134-1138), and there is no minimum match duration.
- **M4. Imported profiles keep their ranked state and XP.** There is no season rollover (server.js:663-672; ranked.js `ensure()`).
- **M5. Password reset leaves game tokens valid.** It does not revoke 30-day game session tokens (server.js:709-721; session.js:19).
- **M6. Old runtimes.** The VPS runs Node 22.11.0 (pinned) while tests run on v24.15.0. The launcher uses Electron 33.2.1, likely outside Electron's support window; this was not checked online.
- **M7. The bot-cap test can never fail CI.** It sits after the `process.exit(1)` check (ranked.test.js:132).
- **M8. Lobby ranks don't match the ratings used.** Lobby bot ranks come from a name hash, not ranked.js `opponentsFor`. Bots can also show ranked reward cards up to Legend (MatchLobby.js:153-163).
- **M9. `set-card` is not validated.** Any card ID is saved and shown to others (server.js:1029-1036).
- **M10. No traces from public builds.** UiTrace only works when the API is localhost, so the card-open freeze needs a local trace build.
- **M11. Privacy.** Email is collected but never used, there is no privacy policy and no delete or export path, and the sign-up hint implies email recovery that does not exist.
- **M12. Stale shipped readme.** The shipped Readme.txt/ReadMe.txt describe the old Func/SteamID flow.
- **M13. Animated-card driver cost unmeasured.** It runs two permanent intervals in the in-match HUD.
- **M14. One Steam identity per install.** All clients share one `force_steamid.txt`, so two clients on one PC are not a valid multiplayer test.
- **M15. The launcher cannot run online experiments.** It passes no `-FuncJoin` or extra arguments to Func.Launcher (game.js:126-127).

**Low (selected)**
- Tests resolve node_modules through a symlink to older packages.
- `.gitignore` does not cover `accounts.json` or `ip-hash-secret.txt`.
- Game session tokens are stored in plaintext.
- `check_published.js` downloads about 6 GB when run without `--changed-from`.
- Card 192002 has no image map entry.
- `purchase-entitlement` reports success for unknown IDs.
- Watchdog folder ACLs are unchecked.
- Every new profile gets 999,999 premium currency (the premium store is disabled).
- The unused LoadingBar.mp4 (2.7 MB) ships.
- Branding sources are git-ignored, so visual builds are not reproducible from git.
- Launcher minimum window 1100×660 may not fit 1366×768 at 125% scaling.

## 5. Prioritised next actions

| P | Action | Owner | Verified by |
|---|---|---|---|
| P0 | Set ranked `field` to 16 (or the real contestant count, clamped 2..16) | dev/agent | New test: placement 16/16 loses rating |
| P0 | Season ceiling: clamp player rating, peak and tiersReached at 1399. Compute level on the server from XP, capped at 14, and ignore client `/api/setlevel`. Cap XP per match. Require a minimum match time (e.g. 120 s) for victory or ranked. Remove the instant ticket in `lobby-start-match` | dev/agent | Tests: 300 forged wins stay ≤1399; no tier above Hunter granted; instant victory pays no bonus; level ≤14 |
| P0 | PR e33c4fd to main. Move the cap test above the exit check. Exclude 197xxx ranked cards from `botCards` | dev | `git merge-base --is-ancestor e33c4fd origin/main` returns 0; a deliberately failing assertion fails CI |
| P0 | Remove the Ice Axe diagnostic skins from the public pak | dev/agent | Pak read: no `XPTest` or `FireAxe_C` in `IceAxe_XP_*` |
| P0 | Add a commit id to `/health` (or `/version`), then deploy main to the VPS | dev + owner (RDP) | GET returns a commit that is on origin/main |
| P0 | Owner: scan VPS profiles for rating >1399 or level >14 (including the imported XP account) and decide on resets. Confirm `CULLING_REQUIRE_ACCOUNT=1` | owner | Reported counts and service XML |
| P0 | Rebuild from a clean main, publish as 1.3.4 (or 1.3.3 rebuilt) | dev/owner | Manifest version and signature; pak `MAX_LEVEL = 14`, 4-entry RANKS |
| P1 | Scheduled data backups with an off-VPS copy; snapshot app and data before deploy; restore drill | dev + owner | Timed restore recorded in TEST_RESULTS.md |
| P1 | Record the commit in make_release.py and the manifest; refuse a dirty tree or a commit not on main. Fix the rollback message and default `-Release` in publish_release.ps1 | agent | Manifest commit is on origin/main; dry run of the script |
| P1 | Owner, watching the screen: launcher 1.3.1 sign-in → menu → VPS login; live Rollback; real reboot mid-download | owner | Entries in TEST_RESULTS.md |
| P1 | Stranded 1.1.0 users: the account-required response or the menu tells them to reinstall from xplab.shop; add a website notice | dev | An old launcher shows the message (in game) |
| P1 | Owner: back up the signing key offline and document the restore | owner | Signature from the restored key passes verify_release.js |
| P1 | Owner E1 (about 10 min): host with `-FuncJoin=Jungle_P?listen?bIsLanMatch`, then `Get-NetUDPEndpoint` | owner | Predicted: only 47584 bound, which confirms the Listen stub |
| P1 | Write ONLINE_ARCHITECTURE.md (the ADR) and PROVENANCE.md. Contact the Func operators and the IP holder about a server binary and distribution rights | agent + owner | Docs exist; replies recorded |
| P1 | Licensing: THIRD_PARTY_NOTICES (Goldberg LGPL-3, Func, Creepster, Electron, UE4 redist); review the IP and adult cards; privacy policy; account delete command | owner + dev | File in the next manifest; cards removed from catalog; test for the delete command |
| P1 | Resolve PR #10 values before the next full rebuild (revert, or apply the BOT_AI_AUDIT recommendations) | dev | Pak read of MatchBot and BasicController shows the intended values |
| P1 | Refresh KNOWN_ISSUES, NEXT_STEPS, TEST_RESULTS, CHANGELOG, SESSION_REPORT, UPDATE_INFRASTRUCTURE, README-local-server; settle one doc location | agent | grep finds no "not yet published", "draft PR #10" or "1.1.0 is published" |
| P2 | Revoke game tokens on password reset; validate `set-card`; make `purchase-entitlement` fail for unknown IDs; update `.gitignore`; use `npm ci` instead of the symlinked node_modules | agent | New tests pass |
| P2 | Bump Node 22 on the VPS; plan an Electron upgrade; code-signing decision | owner/dev | install_vps.ps1 hash; 75 tests pass on the new Electron |
| P2 | VPS loopback load test; watchdog checks; ACLs on `C:\culling\service` | owner | Numbers and task state recorded |
| P2 | Phase 2 regression matrix (Jungle and Prison, ranked to result, lobby vote); verify `SetRewardRank` gives the placement; bot playtest with `stat unit` | owner | GAMEPLAY_SYSTEM_AUDIT.md, AI_PERFORMANCE_REPORT.md |
| P2 | Card-open freeze: local trace build with no card equipped, then 20 open/close cycles; Ice Axe 5-case report | owner | Results in KNOWN_ISSUES and ANIMATED_SKIN_AUDIT |
| P2 | Performance baseline (menu, match, HUD card intervals); launcher high-DPI check; audio and visual inventory docs | owner/agent | Captures and docs |

## 6. Milestone check

| Milestone | Verdict | Evidence |
|---|---|---|
| M0 Stable foundation | **Partly** | Pipeline tests pass; the live manifest is signed and matches the website. Missing: key backup, deployed-build check, VPS load test, in-game login, provenance, triage refresh, backups, season caps on main and live |
| M1 Reproducible game build + regression baseline | **Not met** | No source or Server target (Client-target exe); TEST_RESULTS.md:102 "real match: not run". The baseline could be recorded now |
| M2 Networked vertical slice | **Not met (blocked)** | Listen stub; no server binary; `match-ready` is always `offline:` |
| M3 Core online alpha | **Not met** | The lobby is socket-tested only; no allocation, reconnect or server results; results are client-reported |
| M4 Expanded gameplay alpha | **Not met** | Last Breath is a backend rules core only (not wired); no existing-mode regression pass |
| M5 Remaster beta | **Not met** | Visuals are menu-only; audio untouched; animated skins at 0 verified; performance and security gates fail (C1, C2) |
| M6 Release candidate | **Not met** | No compatibility, load, soak or network tests |
| M7 Public launch | **Not met** | No backups, incident response, status page or privacy policy; licensing unresolved. A public release is already live regardless |

## 7. Not verified, and what would settle it

- **Which commit the VPS runs, and whether the bot cap and accounts are on:** RDP to the VPS (service XML, `C:\culling\app`), or a new `/health` build id.
- **Live ranked data** (ratings above T4 or levels above 14, the imported account): read `C:\culling\data` on the VPS.
- **Watchdog task state, logs, ACLs, crash restart, load capacity:** VPS access in an owner-approved window.
- **Signing key offline backup:** owner confirmation plus a restore test.
- **Website page content** (version badge, SmartScreen disclosure, privacy and FAQ pages): GETs of the site pages, which were outside the allowed URLs. `objects/` cache headers: a HEAD of one object.
- **Website setup hash:** the release auditor's download matched f618e94a…; the verifier did not re-download it.
- **Anything at runtime:**
  - in-game login;
  - the click-freeze fix;
  - the card-open freeze cause;
  - Ice Axe cases;
  - Showdown tile keyboard behaviour;
  - `SetRewardRank` semantics;
  - bot names and levels in a match;
  - menu FPS;
  - per-PC equip persistence;
  - what 1.1.0 users see.

  All of these need the owner playing with a person watching.
- **Whether Func.Client.dll patches the Listen path at runtime:** owner experiment E1 (port check) or a hook trace.
- **Whether Func or the IP holder can supply a server build or rights:** owner contact.
- **Electron 33 support status:** an online check of Electron's release policy.
- **Images of the 630 classic and 48 animated cards** (IP and adult review): a manual visual review.

Note on inputs: the project facts list PR #25 as open and PR #10 as a draft. Git shows both merged (`052d1b2`, `1dea901`). `C:\Culling-play` HEAD is `e33c4fd` and lacks merges `0eb64af` and `052d1b2`.
