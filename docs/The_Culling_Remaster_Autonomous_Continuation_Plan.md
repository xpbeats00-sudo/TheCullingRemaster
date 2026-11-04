# The Culling Remaster

## Autonomous Continuation & Continuous Upgrade Plan

**Document type:** Autonomous engineering execution specification\
**Version:** 1.0\
**Date:** 2026-11-04\
**Predecessor:**
`The_Culling_Remaster_Launcher_and_Server_Optimization_Plan.md`\
**Purpose:** Continue development after the predecessor plan has been
completed and verified.

------------------------------------------------------------------------

# 1. Mission

Once the Launcher & Server Optimization Plan has been completed,
audited, and its acceptance criteria have passed, continue improving The
Culling Remaster without waiting for routine approval at every small
step.

Work as an engineering agent: inspect the real project, identify the
highest-value improvement, plan it, implement it, build it, test it,
document it, and then move to the next safe improvement.

The goal is not to make the largest number of code changes. The goal is
to deliver a more stable, polished, maintainable, performant, secure,
and enjoyable remaster with evidence that each change works.

**Autonomy means making reasonable engineering decisions within the
boundaries below. It does not mean taking destructive, irreversible,
costly, or security-sensitive actions without approval.**

# 2. Mandatory starting conditions

Do not begin this continuation phase until the predecessor plan has been
completed or its remaining work has been explicitly classified.

First inspect: - `LAUNCHER_DOWNLOAD_AUDIT.md` -
`SERVER_PERFORMANCE_AUDIT.md` - `UPDATE_INFRASTRUCTURE.md` -
`TEST_RESULTS.md` - `CHANGELOG.md` - The actual launcher and server
source code. - Current build scripts and configuration. - Existing
design documents and known-issues lists.

Verify the claims in the reports against the actual code and test
evidence. Do not assume a report is accurate merely because it exists.

Create a baseline record containing: - Current source revision or backup
identifier. - Current launcher and game build IDs. - Current server
build/configuration. - Tests that pass and fail. - Known bugs and
technical debt. - Measured install/update performance. - Measured server
capacity and performance. - Outstanding security and compatibility
risks.

If predecessor acceptance criteria have not passed, finish the
highest-priority unfinished predecessor work first. Do not build new
features on top of a broken foundation.

# 3. Autonomous operating rules

## 3.1 Work loop

Repeat this loop for every task:

1.  **Inspect:** Read relevant code, documentation, configuration, and
    test results.
2.  **Understand:** Trace the affected behavior and identify
    dependencies.
3.  **Prioritize:** Select the highest-value safe task.
4.  **Plan:** Define the intended change and measurable acceptance
    criteria.
5.  **Protect:** Confirm a clean version-control state or create a
    recoverable checkpoint.
6.  **Implement:** Make a focused change; avoid unrelated rewrites.
7.  **Build:** Run the relevant build or static checks.
8.  **Test:** Run targeted tests, then regression tests.
9.  **Review:** Inspect the diff for correctness, security, performance,
    and unintended behavior.
10. **Document:** Update the appropriate report and changelog.
11. **Checkpoint:** Save a commit or other recoverable checkpoint when
    the repository workflow permits.
12. **Continue:** Select the next highest-value task.

Do not claim that a build, test, benchmark, or in-game check passed
unless it actually ran and its result was observed.

## 3.2 Task selection

Prioritize in this order:

1.  Data loss, security vulnerabilities, crashes, corrupted installs,
    and multiplayer correctness.
2.  Reproducible bugs and regressions.
3.  Performance bottlenecks confirmed by profiling.
4.  Broken or incomplete core gameplay.
5.  UX and accessibility problems.
6.  Maintainability and technical debt.
7.  Optional features and polish.

Prefer small, independently testable improvements over a large rewrite.

## 3.3 Change control

-   Keep changes focused and reviewable.
-   Preserve existing working behavior unless the task explicitly
    replaces it.
-   Do not overwrite user-created files, assets, configuration, or local
    data.
-   Do not delete old builds, backups, logs, or source files as routine
    cleanup without checking retention requirements.
-   Do not modify original game archives or source assets destructively.
-   Do not force-push, rewrite shared history, or discard user changes.
-   Do not change production configuration without a tested rollback
    path.
-   Keep secrets, tokens, signing keys, and credentials out of source
    control and logs.
-   Do not introduce a new dependency without checking maintenance
    status, license, security, and project compatibility.
-   If the working tree contains unexplained user changes, preserve them
    and work around them.

## 3.4 Actions requiring approval

Stop and request approval before: - Spending money or starting paid
infrastructure/services. - Changing domains, DNS, hosting plans, or
production storage. - Publishing a public release or deploying a
production server update. - Signing or distributing a release with a
real publisher identity. - Deleting user data, backups, archives, or
unknown files. - Running migrations that cannot be safely rolled back. -
Changing account permissions, firewall exposure, or remote-access
policy. - Uploading private source code or user data to third-party
services. - Making legal, licensing, privacy, or anti-cheat policy
decisions. - Replacing major architecture or engine versions. -
Performing actions that could disrupt live players.

For an approval-required blocker, finish independent safe work, document
the blocker, and continue with tasks that do not depend on it.

# 4. Phase A --- Post-completion audit

Once the predecessor plan is marked complete:

-   Re-run the launcher test matrix.
-   Re-run server baseline and target-load tests.
-   Verify that the signed manifest and release process are
    reproducible.
-   Confirm that the installer and launcher signatures validate.
-   Verify rollback and recovery using a disposable test installation.
-   Confirm that the server supervisor does not create restart loops.
-   Check for memory, actor, timer, delegate, and file-handle leaks.
-   Compare performance against the predecessor baseline.
-   Confirm that documentation matches the actual implementation.

Deliver: - `POST_OPTIMIZATION_AUDIT.md` - Updated `TEST_RESULTS.md` -
Updated `KNOWN_ISSUES.md`

Do not proceed to feature expansion if this audit discovers a critical
regression.

# 5. Phase B --- Launcher product-quality upgrades

Inspect current implementation before selecting tasks. Implement only
features that are missing or demonstrably inadequate.

Potential improvements:

## 5.1 Installation experience

-   First-run setup wizard.
-   Installation directory selection and validation.
-   Clear install/update/repair states.
-   Resume after reboot.
-   Accurate disk-space estimates.
-   Friendly error messages with actionable recovery steps.
-   Accessibility and keyboard navigation.
-   High-DPI and window-resize checks.
-   Safe handling of paths containing spaces and non-English characters.

## 5.2 Update experience

-   Stable and beta channels, if release operations support them.
-   Version history and changelog.
-   Maintenance and service-status display.
-   Repair and verify controls.
-   Safe rollback to the last known-good version.
-   Optional content selection with dependency validation.
-   Clear compatibility messaging when client and server builds differ.

## 5.3 Download quality

-   Benchmark concurrency and bandwidth settings on multiple connection
    profiles.
-   Detect repeated CDN/origin failures.
-   Avoid retry storms with jitter and sensible global limits.
-   Add download diagnostics without recording sensitive information.
-   Test slow disks and low-memory machines.
-   Test interrupted downloads after process termination and machine
    restart.

## 5.4 Launcher reliability

-   Prevent duplicate launcher instances where appropriate.
-   Handle locked game files and an already-running game.
-   Use safe process launching and argument validation.
-   Avoid blocking the UI during disk, network, or hash operations.
-   Handle corrupted local state files with a recoverable rebuild path.
-   Add structured logs with rotation and size limits.

# 6. Phase C --- Server and backend maturity

## 6.1 Capacity engineering

-   Re-profile the server after every significant AI, map, or
    replication change.
-   Identify the limiting resource before scaling.
-   Test the target player/bot mix and at least one overload scenario.
-   Define a safe admission limit based on measured performance.
-   Add configurable bot caps and graceful bot reduction under overload.
-   Avoid promising capacity based only on VPS specifications.

## 6.2 Match lifecycle

-   Validate match creation, joining, leaving, disconnects, reconnects,
    and completion.
-   Make match result submission idempotent.
-   Prevent duplicate rewards and duplicate elimination processing.
-   Handle simultaneous kills and last-player/team-survival edge cases.
-   Recover safely from a server process restart.
-   Ensure spectators cannot leak information that living players should
    not receive.

## 6.3 Persistence and backend integrity

-   Validate account, profile, inventory, progression, rank, and
    match-result persistence.
-   Use transactions or equivalent consistency controls for related
    updates.
-   Add schema/version migration tests.
-   Make retries safe and idempotent.
-   Back up persistent data and periodically test restoration.
-   Define retention and privacy rules for logs and telemetry.

## 6.4 Security and abuse resistance

-   Validate all client-originated requests on the server.
-   Apply rate limits to sensitive endpoints and repeated actions.
-   Prevent client authority over damage, inventory, rewards, rank, and
    match outcomes.
-   Validate payload sizes and types.
-   Protect administrative endpoints.
-   Audit permissions and secrets handling.
-   Add detection and logging for suspicious behavior without treating a
    heuristic as proof of cheating.
-   Do not add invasive anti-cheat or kernel-level software without
    explicit approval and a documented privacy/security review.

# 7. Phase D --- Gameplay and AI quality

Audit gameplay systems for correctness, responsiveness, and consistency.

Potential work areas: - Bot navigation and stuck recovery. - Target
selection and threat prioritization. - Combat decision quality. - Weapon
handling and damage consistency. - Armor and healing rules. - Spawn
safety and spawn fairness. - Match pacing and round transitions. -
Spectator behavior. - Kill feed and elimination ordering. - Scoreboards,
stats, medals, and result screens. - Callsigns, profiles, ranks, and
progression. - Disconnect and reconnect behavior. - Accessibility,
readable HUD, and clear audio feedback.

For every gameplay change: - Define expected behavior. - Add a
reproducible test scenario. - Test edge cases and simultaneous events. -
Test with both bots and real clients where possible. - Check server
authority. - Update design documentation.

Do not rebalance gameplay solely from intuition. Record the rationale
and collect match data where available.

# 8. Phase E --- Cosmetics, UI, and presentation

Audit all cosmetic and presentation systems.

## 8.1 Animated weapon skins

For each skin, verify: - Correct mesh/material assignment. - Correct
texture and mask channels. - Material parameter values. - Time-driven
animation using a real material animation mechanism. - Correct behavior
under different lighting. - Correct first-person and third-person
appearance, if both are supported. - No missing textures, shader errors,
or excessive overdraw. - No unacceptable performance impact.

A static texture, static emissive glow, or one-time color change does
not count as a fully animated skin. Record the actual animation
mechanism and test result for each skin.

## 8.2 Calling cards and profile cosmetics

-   Verify asset loading and fallback behavior.
-   Reproduce and fix any UI freeze or asset-loading deadlock.
-   Avoid synchronous disk reads or expensive texture work on the UI
    thread.
-   Add loading placeholders and failure handling.
-   Test rapid profile switching and repeated opening/closing.
-   Check memory usage when browsing large cosmetic collections.
-   Verify animation timing and cleanup when a card leaves the screen.

## 8.3 Main menu and launcher presentation

-   Check layout scaling, resolution changes, and window resizing.
-   Optimize large background textures and animated effects.
-   Avoid unnecessary full-screen effects on low-end systems.
-   Ensure controls remain readable and responsive.
-   Keep visual style coherent with The Culling.
-   Verify that UI animation does not block input or gameplay
    transitions.

# 9. Phase F --- Custom modes and new content

For every newly added mode or content folder:

1.  Inspect all files and determine its purpose.
2.  Identify dependencies and engine compatibility.
3.  Compare its code with existing gameplay architecture.
4.  Identify duplicated or conflicting systems.
5.  Write an integration plan.
6.  Implement in a separate, testable branch or checkpoint.
7.  Test each player/team configuration.
8.  Test disconnects, late joins, simultaneous events, and server
    restarts.
9.  Profile performance under realistic load.
10. Update the mode specification and changelog.

For Last Breath or other shrinking-zone modes, specifically verify: -
Server-authoritative timers and zone state. - Consistent zone damage. -
Healing interactions. - Safe-zone boundary behavior. - Team elimination
and round completion. - Spectator and reconnect behavior. - No
client-side authority over damage or outcomes.

Do not silently replace existing game modes or remove compatibility with
existing queues.

# 10. Phase G --- Automated quality gates

Add or improve automation where the existing stack supports it.

Recommended gates: - Formatting and lint checks. - Static analysis and
type checks. - Unit tests for manifest parsing, path validation,
retries, Range handling, and state recovery. - Integration tests for
download, verify, repair, and rollback. - Server tests for match
lifecycle, authoritative outcomes, and persistence. - Build
reproducibility checks. - Dependency and vulnerability scanning. -
Package-content validation. - Release artifact signature verification.

Use test doubles for network failures and disk errors. Include cases
for: - Timeout before first byte. - Timeout after partial progress. -
Server ignores Range. - Incorrect Content-Range. - ETag changes during
resume. - Corrupt manifest signature. - Corrupt downloaded file. - Disk
full. - Permission denied. - Process termination during state save. -
Duplicate match-result submission. - Simultaneous elimination events.

Do not make the release pipeline depend on external services without a
clear failure mode.

# 11. Phase H --- Performance and stability campaign

Maintain repeatable benchmarks for: - Fresh install duration. -
Differential patch size and duration. - Repair duration. - Hash
verification throughput. - Peak memory during install and
verification. - Download throughput at different concurrency settings. -
Server CPU and memory at multiple player/bot counts. - Tick-time
p50/p95/p99. - Network traffic per client. - Long-session memory
growth. - Crash and recovery behavior.

Run short tests during development and longer soak tests before
releases.

For each optimization, record: - Baseline. - Change made. - Test
environment. - Result after change. - Regression check. - Whether the
improvement is statistically or operationally meaningful.

# 12. Phase I --- Documentation and handoff

Keep these documents current:

-   `POST_OPTIMIZATION_AUDIT.md`
-   `LAUNCHER_DOWNLOAD_AUDIT.md`
-   `SERVER_PERFORMANCE_AUDIT.md`
-   `UPDATE_INFRASTRUCTURE.md`
-   `GAMEPLAY_SYSTEM_AUDIT.md`
-   `AI_PERFORMANCE_REPORT.md`
-   `COSMETIC_ANIMATION_AUDIT.md`
-   `GAME_MODE_INTEGRATION_REPORT.md`
-   `SECURITY_REVIEW.md`
-   `TEST_RESULTS.md`
-   `KNOWN_ISSUES.md`
-   `CHANGELOG.md`
-   `SESSION_REPORT.md`
-   `NEXT_STEPS.md`

Every session report must include: - What was inspected. - What
changed. - Files modified. - Builds run and results. - Tests run and
results. - Benchmarks and measurements. - Known failures and
limitations. - Revert/checkpoint identifier. - Next recommended task.

# 13. Autonomous stopping and continuation policy

Work in bounded engineering sessions. Do not run an uncontrolled
infinite loop.

Continue while: - The environment and project files are accessible. -
The current task is within the approved scope. - There is a safe,
testable next task. - No approval-only action is required.

Stop the current task and document the blocker when: - Required
source/assets/build tools are missing. - A test cannot be run and the
result is essential to safety. - The only available action is
destructive or irreversible. - Credentials, payment, account
verification, or production access are needed. - A serious security or
data-integrity issue is found. - The project is in an unexplained or
conflicting state.

When blocked, do not invent results or silently skip required
validation. Finish independent safe tasks and write a clear handoff.

# 14. Final acceptance criteria

The continuation phase is successful only when:

-   The predecessor plan has been independently revalidated.
-   High-severity launcher and server defects are fixed or clearly
    documented.
-   Updates, repair, resume, and rollback have repeatable test evidence.
-   Server capacity is measured and honestly documented.
-   AI and replication improvements are supported by profiling.
-   Gameplay and cosmetics pass their relevant test cases.
-   Custom modes are integrated without breaking existing systems.
-   Security-sensitive operations have explicit controls.
-   Documentation matches the actual code and build.
-   Every change has a test result and recoverable checkpoint.
-   Remaining work is listed in `NEXT_STEPS.md`.

**Never mark a task complete merely because code was generated.
Completion requires an observed build/test result appropriate to the
task.**

------------------------------------------------------------------------

# Execution instruction for the engineering agent

When the predecessor plan is complete, begin at **Phase A**. Inspect the
repository and reports rather than assuming the project is in the
expected state. Then work through the phases in priority order,
selecting the highest-value safe task each time.

Make routine engineering decisions autonomously. Keep changes small,
test them, preserve rollback points, and update the reports. Do not ask
the user routine questions that can be answered by inspecting the
project. Ask only when a decision requires their authority, money,
credentials, private information, or a product/design choice that cannot
be inferred safely.

At the end of each bounded session, leave the project in a buildable or
clearly documented state and update `SESSION_REPORT.md` and
`NEXT_STEPS.md`.

**This document is an execution specification. It does not itself launch
an agent, grant access to project files, or cause work to continue in
the background.**
