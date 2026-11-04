# The Culling Remaster

## Launcher, Download System & Server Optimization Plan

**Version:** 1.0\
**Date:** 2026-11-04\
**Scope:** Windows launcher, 5+ GB game distribution, update
infrastructure, and multiplayer server performance.

## 1. Objectives

Build a launcher and server platform that: - Installs a 5+ GB game
efficiently and avoids redownloading unchanged files. - Resumes
interrupted downloads without losing valid progress. - Verifies every
downloaded file before installation or launch. - Applies updates safely
and can recover from failed updates. - Uses bandwidth, CPU, memory, and
network resources efficiently. - Provides useful logs, diagnostics,
benchmarks, and recovery tools. - Makes no performance or completion
claims without test evidence.

## 2. Priority roadmap

  -----------------------------------------------------------------------
  Priority                            Work
  ----------------------------------- -----------------------------------
  P0                                  Correct pause/resume, idle timeout,
                                      retries, and shutdown handling

  P0                                  Differential updates and SHA-256
                                      verification

  P0                                  Staging, atomic/recoverable
                                      installation, and rollback

  P0                                  Server telemetry and baseline load
                                      tests

  P1                                  Adaptive download concurrency and
                                      bandwidth limits

  P1                                  Repair installation and signed
                                      manifests

  P1                                  AI, pathfinding, and replication
                                      optimization

  P1                                  CDN/object storage and immutable
                                      versioned files

  P2                                  Optional content, update channels,
                                      rollback UI, benchmark tool

  P2                                  Automated server load tests and
                                      long-duration soak tests
  -----------------------------------------------------------------------

# Part A --- Launcher and Download System

## 3. Differential updates

Create a versioned manifest containing, for every managed file: -
Relative path. - Exact byte size. - SHA-256 hash. - Content group (core,
map, cosmetic, audio, optional, etc.). - Required/optional status. -
Optional chunk metadata for large files.

Example schema (values are illustrative only):

``` json
{
  "path": "TheCulling/Content/Paks/pakchunk0-WindowsClient.pak",
  "size": 696000000,
  "sha256": "REPLACE_WITH_REAL_SHA256",
  "group": "core",
  "required": true
}
```

Update process: 1. Fetch the latest manifest over HTTPS. 2. Verify its
digital signature before trusting its contents. 3. Validate paths;
reject absolute paths, drive letters, traversal sequences, and invalid
entries. 4. Compare installed files against the manifest. 5. Reuse files
whose size and SHA-256 match. 6. Download only missing or changed files.
7. Verify each download before marking it complete. 8. Defer deletion of
obsolete launcher-managed files until the update commits. 9. Preserve
user-created files and settings unless explicitly managed by the
launcher.

Cache verification results carefully to avoid hashing every large file
on every startup. Rehash when metadata changes, during Repair, or
whenever integrity is uncertain.

## 4. Download engine

### Concurrency and bandwidth

-   Start with 4--6 concurrent downloads.
-   Benchmark 2, 4, 6, and 8 workers on the actual host.
-   Offer user limits such as 2, 4, 6, 8, and Unlimited.
-   Reduce concurrency when timeouts and retries rise.
-   Add a global bandwidth cap so downloads do not monopolize the
    player's connection.
-   Treat adaptive concurrency as an optional measured improvement, not
    a substitute for reliable retry logic.

### Stall detection

-   Reset the idle timer whenever bytes arrive.
-   Use 30 seconds without progress as an initial configurable stall
    timeout.
-   Distinguish connection timeout, idle timeout, HTTP failure, user
    pause, shutdown, and disk-write failure.
-   Clean up timers and abort listeners after every request.
-   Do not classify a slow but progressing connection as stalled.

### Retry policy

Use bounded exponential backoff with jitter, for example approximately
1, 2, 4, 8, and 16 seconds. Set a maximum attempt count and show a
useful error when exhausted.

### Correct HTTP Range handling

-   Save incomplete files as `.part`.
-   Resume from the actual partial-file length.
-   Use `If-Range` with a stable ETag where supported.
-   Accept resumed data only when the server returns
    `206 Partial Content` and `Content-Range` matches the requested
    offset and expected object length.
-   If the server returns `200 OK`, restart/truncate that partial file;
    never append a full response to existing partial bytes.
-   For `416 Range Not Satisfiable`, verify whether the partial file is
    already complete; otherwise restart safely.
-   Ensure the remote object has not changed between attempts.

### Cancellation behavior

Use distinct cancellation reasons: - **Pause:** stop active requests,
flush state, preserve partial files, show Resume. - **Shutdown:** abort
requests, flush state, close file handles, preserve partials. - **Fatal
sync error:** stop scheduling work and preserve recoverable data. -
**Individual file failure:** retry that file within its retry budget.

A transient failure in one file should not immediately cancel every
other worker. A shared abort controller is appropriate for user pause,
shutdown, or a genuinely fatal sync failure.

### State persistence

-   Persist completed-file state and partial-file metadata.
-   Throttle ordinary state writes to at most once every two seconds.
-   Flush on pause, shutdown, and successful completion.
-   Write state to a temporary file, flush/close it, then atomically
    replace the previous state file.
-   On startup, reconcile saved state against actual files and hashes.
-   Treat the filesystem and verification results as authoritative;
    never trust a state entry alone.

A separate persisted paused flag is optional. If startup always detects
recoverable partials and offers Resume, partial files and verified state
can be sufficient.

## 5. Large-file chunking

Use ordinary Range resume first. Consider independently verifiable 8--32
MB chunks for very large files only after the simpler path is stable.

If implemented: - Put chunk offsets, lengths, and hashes in the signed
manifest. - Download chunks in parallel only when the origin supports
Range reliably. - Verify each chunk before reusing it after restart. -
Reassemble into a temporary file. - Verify the full-file hash before
promoting it. - Keep chunk state separate from whole-file completion
state.

## 6. Progress UI

Display: - Downloaded bytes / required bytes. - Overall percentage. -
Current and average speed. - Approximate time remaining. - Active
downloads and completed file count. - Phase: Checking, Downloading,
Verifying, Installing, Finalizing, or Repairing. - Pause, Resume,
Cancel, and Retry controls. - Clear errors and a Copy Diagnostics
action.

Calculate progress from verified completed bytes plus valid partial
bytes, capped at each file's expected size. Do not count oversized or
unverified partial data as complete. Use a moving average for speed;
estimates are unreliable during the first few seconds.

## 7. Disk-space preflight

Before downloading, check: - Existing installation size. - Changed bytes
to download. - Reusable partial bytes. - Staging and reconstruction
space. - Extraction space, if applicable. - Rollback space. - A safety
margin for logs and filesystem overhead.

Check that the target directory exists and is writable. Recheck space
before large staging operations. A 5.65 GB download may require
substantially more than 5.65 GB free if staging, extraction, and
rollback are involved.

## 8. Staging, installation, and rollback

Never overwrite active game files with unverified downloads.

1.  Download into a staging directory, preferably on the same volume as
    the installation.
2.  Verify sizes and hashes.
3.  Validate the staged build against the manifest.
4.  Write a transaction/commit record.
5.  Promote files using recoverable operations.
6.  Keep the previous working version or a rollback-capable backup.
7.  Mark the new build active only after commit succeeds.
8.  Clean up old files after a successful launch/health check and
    retention period.

Windows directory replacement and locked-file behavior require careful
handling. Use a transaction journal; do not assume a single rename can
replace an entire non-empty game directory atomically.

## 9. Repair mode

Add a **Verify / Repair Game** option: - Compare installed files with
the manifest. - Identify missing, modified, truncated, and corrupt
files. - Redownload only invalid files. - Leave valid files untouched. -
Produce a repair report. - Do not automatically delete unknown user
files.

## 10. Hosting and CDN

For public distribution, use object storage or a large-file host behind
a CDN where practical.

Require: - HTTPS. - Reliable Range requests and `206` responses. -
Correct `Content-Range`. - Stable ETags. - Immutable versioned object
URLs. - Long cache lifetimes for immutable payloads. -
Revalidation/short cache lifetime for latest-version metadata. - Origin
rate limits and monitoring. - Separate manifest delivery from large
payload delivery. - No cloud credentials or storage secrets embedded in
the launcher.

Publish new immutable objects instead of overwriting payloads at the
same URL.

## 11. Package layout and optional content

Consider separate update groups for: - Core game. - Maps and
environments. - Weapons and cosmetics. - Audio. - High-resolution
textures. - Language packs. - Experimental content.

Avoid thousands of tiny files where suitable Unreal package containers
are supported. Also avoid one giant package if small changes force a
full multi-gigabyte redownload. Confirm the actual Unreal Engine version
and packaging format before changing the pipeline.

# Part B --- Server Optimization

## 12. Server optimization goals

Prioritize: 1. Authoritative, fair gameplay. 2. Stable tick rate and
responsive combat. 3. Predictable CPU and memory use. 4. Efficient
replication and network behavior. 5. Bot workloads that do not starve
real players. 6. Graceful recovery from crashes and disconnects. 7.
Measured, clearly stated capacity limits.

Profile first. Make one category of change at a time and compare
results.

## 13. Baseline inventory

Record: - CPU model, cores, logical processors, and clock behavior. -
RAM capacity and available memory. - Disk type, free space, and
latency. - Network bandwidth, latency, packet loss, and provider
limits. - Windows Server version and power plan. - Game/server build and
configuration. - Background services and active processes. - Player
count, bot count, map, and match duration.

For the planned 4-vCPU / 8-GB Windows VPS, 10 real players plus 20 bots
is a benchmark target, not a guaranteed capacity. AI and replication
costs depend on the actual implementation and server build.

## 14. Server telemetry

### Host metrics

-   Total and per-core CPU utilization.
-   Game process CPU, private bytes, and working set.
-   Available memory and paging activity.
-   Disk throughput and latency.
-   Network bytes sent/received, errors, and retransmissions where
    available.

### Game metrics

-   Tick rate and tick-time percentiles.
-   Game-thread and network-update time.
-   Connected players and active bots.
-   AI perception checks and pathfinding requests.
-   Replicated actor/property counts.
-   Bytes sent per client per second.
-   Latency and packet loss where exposed.
-   Spawn/despawn counts.
-   Match duration, crashes, and restarts.

Record averages plus p95/p99 where practical. Averages can hide severe
stutters.

## 15. AI and bot optimization

### Stagger updates

-   Do not run every bot's full decision logic on the same frame.
-   Assign bots to update buckets and spread work across frames.
-   Use different update frequencies for nearby threats, distant
    enemies, and idle bots.
-   Preserve immediate reactions for important events such as taking
    damage or seeing a nearby threat.
-   Avoid full perception scans every frame.

### Perception and target selection

-   Cache target data for a short, controlled interval.
-   Filter by distance and relevance before expensive line-of-sight
    traces.
-   Avoid repeating the same visibility test within one update window.
-   Stop target searches for dead, disabled, or non-active bots.
-   Prioritize nearby and threatening targets.
-   Invalidate cached data when important world events occur.

### Pathfinding

-   Do not request a new path every frame.
-   Reuse valid paths until blocked, invalidated, or the target moves
    enough to justify replanning.
-   Rate-limit requests per bot and globally.
-   Spread pathfinding work across frames.
-   Use stuck detection with escalating recovery: wait, adjust movement,
    replan, then use a safe recovery action.
-   Avoid repeated path requests to unreachable targets.
-   Reduce search space with navigation bounds/filters where supported.

### Decision logic

-   Separate high-frequency movement from lower-frequency strategic
    decisions.
-   Prefer event-driven transitions where appropriate.
-   Avoid repeatedly evaluating unchanged conditions.
-   Cache expensive calculations.
-   Instrument state transitions and detect rapid state-switching loops.
-   Expose bot count and AI update budgets in server configuration.

### Load shedding

-   Define a configurable maximum bot count.
-   Scale low-priority distant-bot work when server load rises.
-   Preserve combat-critical behavior.
-   Do not silently disadvantage real players to maintain unnecessary
    bot activity.

## 16. Replication and networking

-   Replicate only data clients need.
-   Use relevancy and distance-based prioritization where supported.
-   Avoid repeatedly replicating unchanged properties.
-   Reduce update frequency for distant or inactive actors.
-   Keep combat-critical state responsive.
-   Avoid sending large cosmetic/profile payloads during combat.
-   Batch non-urgent updates where appropriate.
-   Avoid excessive multicast events.
-   Keep damage, inventory, round state, score, and sensitive outcomes
    server-authoritative.
-   Validate client requests and rate-limit abusive or malformed
    traffic.
-   Test latency, packet loss, reconnects, and simultaneous events.

Do not reduce replication frequency blindly. Measure bandwidth and
responsiveness first.

## 17. Tick and workload budgets

-   Profile the actual server tick path.
-   Identify expensive recurring functions.
-   Budget AI, pathfinding, perception, replication, and housekeeping.
-   Schedule non-critical work at controlled intervals where engine
    rules permit.
-   Avoid blocking disk operations, synchronous logging, and expensive
    serialization on the game thread.
-   Keep critical state changes deterministic and server-authoritative.
-   Do not hide overload with arbitrary sleeps or tick-rate changes.

## 18. Memory and garbage collection

-   Track memory over long sessions.
-   Look for monotonic growth in actor counts, delegates, timers,
    arrays, caches, and replicated objects.
-   Unregister callbacks and release references when actors are
    destroyed.
-   Bound caches and log buffers.
-   Reuse temporary data where safe.
-   Release match-result and asset references when no longer needed.
-   Profile garbage-collection pauses and allocation spikes.
-   Do not disable or radically alter garbage collection without
    evidence and controlled testing.

## 19. Windows Server and VPS configuration

-   Keep Windows Server supported and patched.
-   Use an appropriate power plan if permitted by the provider.
-   Do not disable antivirus globally. Exclude only verified trusted
    directories if policy allows and there is a measured reason.
-   Keep OS, page file, and server files on adequately provisioned
    storage.
-   Preserve disk space for logs, dumps, updates, and backups.
-   Avoid unnecessary desktop apps and background services.
-   Expose only verified game and administration ports through Windows
    Firewall.
-   Restrict RDP to trusted IPs or a secure VPN where possible.
-   Use strong authentication.
-   Do not expose databases, file shares, or debugging ports publicly.

Do not change CPU affinity, process priority, timer resolution, or
network registry settings without measurements and a rollback plan.

## 20. Crash recovery and service management

-   Run the server under a controlled service manager/supervisor.
-   Capture stdout, stderr, and engine logs.
-   Preserve crash dumps with build/version metadata.
-   Restart after confirmed crashes with backoff to prevent restart
    loops.
-   Do not restart on every transient warning.
-   Support graceful shutdown and state flushing.
-   Add startup health checks before marking the server available.
-   Detect a process that exists but has stopped making progress.
-   Persist critical match/account state safely and idempotently.
-   Test forced termination and host restart.

## 21. Capacity and load-test plan

Run on the actual VPS:

  Test                Real players            Bots      Duration
  ---------------- --------------- --------------- -------------
  Baseline                       0               0        15 min
  AI baseline                    0               5        15 min
  AI load                        0              10        20 min
  Mixed load                     5              10        30 min
  Target trial                  10              20        30 min
  Stability soak     Expected peak   Expected peak   60--120 min

If the target fails, repeat with fewer bots and determine whether CPU,
memory, network, or game-thread time is limiting capacity.

Suggested initial operational guardrails (not engine requirements): -
Aim for sustained host CPU below 80%. - Preserve approximately 1--1.5 GB
of available memory under expected peak load. - Avoid sustained
paging. - Track p95/p99 tick time against the intended tick rate. -
Investigate recurring packet loss, rising latency, and
retransmissions. - Require no unexplained memory growth during the soak
test. - Require no crash, deadlock, or unrecoverable match-state
corruption.

The 4-vCPU / 8-GB VPS may require fewer bots or lower AI/replication
workloads to support the target. Publish only the capacity that passes
testing.

## 22. Custom modes such as Last Breath

-   Keep timers, zone radius, exposure checks, damage, eliminations, and
    match results server-authoritative.
-   Replicate compact phase and zone state.
-   Interpolate fog and visual effects locally on clients.
-   Do not apply authoritative damage on clients.
-   Use a centralized zone manager and scheduled exposure checks.
-   Avoid a full-world scan every frame.
-   Handle disconnects, simultaneous eliminations, late joins, and
    restarts.
-   Test boundary jitter and healing interactions under latency.
-   Instrument zone checks and damage events to detect duplicate
    processing.

## 23. Launcher/server version integration

-   Publish build ID and protocol version.
-   Reject incompatible clients with a clear message.
-   Display maintenance/server status in the launcher.
-   Separate launcher version, game content version, and server build
    version.
-   Do not let clients select arbitrary manifest URLs.
-   Use signed update metadata.
-   Keep server secrets out of downloadable client files.
-   Support maintenance mode during incompatible updates.
-   Define a minimum-client-version policy.

# Part C --- Security, Testing, and Release

## 24. Update security

-   Sign launcher and installer binaries with a publicly trusted
    code-signing identity for public distribution.
-   Sign manifests and verify signatures before trusting entries.
-   Use SHA-256 for file integrity.
-   Use HTTPS for metadata and payloads.
-   Validate every path before writing.
-   Prevent path traversal and reparse-point/symlink escapes.
-   Never execute a downloaded file automatically merely because it
    completed.
-   Keep signing keys in a secure signing service or protected signing
    environment.
-   Never embed private keys, cloud credentials, or storage secrets in
    the launcher.
-   Document key rotation and recovery.

A valid signature identifies the publisher and protects integrity, but
does not guarantee that SmartScreen will stop warning about a new
publisher or low-reputation download.

## 25. Launcher test matrix

  Scenario                     Expected result
  ---------------------------- -------------------------------------------
  Fresh install                Required files download and verify
  Up-to-date install           No large download
  One changed file             Only that file downloads
  Missing file                 Only missing file downloads
  Corrupt file                 Only invalid file is repaired
  Pause during download        Requests stop; partials remain
  Resume after restart         Valid partial bytes are reused
  Network disconnect           Bounded retries; no corrupt final file
  Server ignores Range         File safely restarts
  Invalid Content-Range        Response rejected
  HTTP 416                     Partial verified or safely restarted
  Disk fills                   Clear error; recoverable state retained
  Launcher closes              Handles close; partials remain
  Invalid manifest signature   Update rejected
  Path traversal entry         Entry rejected
  Failed update commit         Previous installation remains recoverable
  Optional content omitted     Core game still launches

## 26. Server test matrix

-   Empty-server baseline.
-   Increasing bot counts.
-   Increasing player counts.
-   Mixed players and bots.
-   High-latency clients.
-   Packet loss and reconnects.
-   Simultaneous damage/elimination events.
-   High actor-count map areas.
-   Long matches and long-session soak.
-   Repeated match start/end cycles.
-   Server crash and restart.
-   Graceful shutdown during a match.
-   Client/server version mismatch.
-   Memory and actor leak checks.

## 27. Release gates

Do not publish until: - Fresh install passes. - Differential update
passes. - Pause/resume works across launcher restart. - File hashes are
verified. - Repair mode passes. - Failed-update recovery passes. -
Manifest trust and path validation are tested. - Server load test passes
at the declared capacity. - Long-session stability test passes. - Logs
identify failures clearly. - Release notes and known limitations are
documented.

## 28. Required engineering reports

Maintain these project documents:

### `LAUNCHER_DOWNLOAD_AUDIT.md`

Current architecture, manifest format, concurrency, retry/resume
behavior, verification results, bugs, and fixes.

### `SERVER_PERFORMANCE_AUDIT.md`

Hardware/OS inventory, baseline and peak metrics,
AI/pathfinding/replication findings, bottlenecks, fixes, tested
capacity, and stability results.

### `UPDATE_INFRASTRUCTURE.md`

Hosting/CDN design, manifest signing, object naming/cache policy,
release/rollback procedure, and access controls.

### `TEST_RESULTS.md`

Build ID, environment, test cases, expected/actual outcomes, logs,
measurements, failures, and outstanding issues.

### `CHANGELOG.md`

User-visible launcher/server changes, bug fixes, compatibility changes,
and known issues.

## 29. Implementation sequence

### Phase 1 --- Stabilize current sync

-   Inspect `sync.js`, `main-ui.js`, and `main.html`.
-   Fix idle timeout and abort handling.
-   Validate Range responses.
-   Add bounded retries.
-   Make state writes atomic and throttled.
-   Test pause/resume after process restart.

### Phase 2 --- Smaller, trusted updates

-   Define and validate the manifest.
-   Add signed-manifest verification.
-   Add SHA-256 verification.
-   Implement differential update planning.
-   Add Repair.
-   Test safe obsolete-file cleanup.

### Phase 3 --- Recoverable installation

-   Add staging and transaction journal.
-   Add rollback.
-   Add disk-space preflight.
-   Test forced shutdown at each update stage.

### Phase 4 --- Download performance

-   Benchmark concurrency.
-   Add bandwidth limits.
-   Evaluate chunking for large files.
-   Deploy CDN/object storage with Range support.
-   Measure install and patch performance from multiple regions.

### Phase 5 --- Server baseline

-   Inventory VPS and server build.
-   Add telemetry.
-   Run baseline and bot/player tests.
-   Profile game-thread, AI, pathfinding, and replication costs.

### Phase 6 --- Server optimization

-   Stagger AI updates.
-   Cache perception/target data.
-   Budget pathfinding.
-   Reduce unnecessary replication.
-   Fix allocations, leaks, and blocking operations.
-   Add controlled crash recovery.

### Phase 7 --- Release validation

-   Run the full launcher matrix.
-   Run server load and soak tests.
-   Publish measured capacity and known limitations.
-   Update engineering reports.

# Part D --- Project Details to Confirm

Inspect the real project before implementation and confirm:

1.  Is the launcher Electron, another Node.js desktop framework, or a
    different stack?
2.  What are the current APIs and responsibilities of `sync.js`,
    `main-ui.js`, and `main.html`?
3.  Where are game files hosted: VPS, object storage, CDN, or another
    host?
4.  Does the host support Range requests and stable ETags?
5.  What is the actual manifest format and installed game size?
6.  What Unreal Engine version and package format does this game build
    use?
7.  Is the server an official dedicated-server build, custom server, or
    client-hosted process?
8.  Can server source code be modified, or are changes limited to
    configuration and hosting?
9.  What are the actual tick rate and current player/bot limits?
10. Is the first public capacity target 10 real players plus 20 bots on
    the 4-vCPU / 8-GB Windows VPS?

Do not assume an optimization is possible until the current code, engine
version, hosting behavior, and server build have been inspected.

## Definition of success

The launcher downloads only missing or changed content, resumes valid
partial data, verifies every file, and recovers safely from interruption
or failed updates.

The server maintains responsive gameplay at a measured capacity, with
stable CPU and memory use, bounded AI workloads, efficient replication,
and reliable crash recovery.

**All performance claims must be backed by recorded tests.** Clearly
distinguish implemented, unit-tested, integration-tested, and verified
in a live game/server environment. Code being written does not mean a
feature is complete.
