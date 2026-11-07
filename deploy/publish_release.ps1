<#
Publish a launcher release and the launcher's setup on the xplab.shop VPS.

Run ON the VPS ("Publish Release.bat" does it), with the build PC's drive shared over Remote Desktop
(Local Resources > More > Drives), so the build PC's C: is \\tsclient\C. The shared drive is slow, so only files the
VPS doesn't have yet cross it, each exactly once:
  1. copies manifest.json(.sig) from the release folder to TEMP once and checks the signature of that copy with the
     launcher's own release key (refuses anything unsigned or altered); every later step uses that verified copy
     (stage_objects.js --manifest/--sig), never the release folder's manifest, which a rebuild could replace meanwhile
  2. says what changes against the live release and how much will be uploaded (reads only the manifest)
  3. puts the release's objects in C:\culling\updates\objects (deploy\stage_objects.js): objects already there are
     reused; missing ones, the launcher setup the release offers among them, are copied over and checked against
     their SHA-256 on the VPS; files of the old files\ layout are linked, not uploaded
  4. manifest.json(.sig), so a launcher never sees a manifest whose objects aren't there yet
     (served as https://<domain>:8443/remaster/; objects never change, so they can be cached for good)
  5. the website's setup (C:\ssr\www\download\TheCullingRemasterSetup.exe) and download\launcher.json (version, size,
     sha256: the website shows the current launcher from it) come from the staged setup object, on the VPS, once the
     release is live (so a publish that fails earlier leaves the website as it was)
  6. checks the result as launchers see it, over HTTPS (deploy\check_published.js): signature, every object on
     disk, the changed files and the setup downloaded and hash-checked, the website's launcher.json and setup
     and that the live manifest's version is the one published
It ends with a green "PUBLISHED <version> ..." or a red "PUBLISH FAILED ..." line (saying whether anything went
live); the exit code is 0 only for PUBLISHED; everything printed is also in <Root>\logs\publish-<time>.log.
One publish at a time: <Root>\publish.lock is held open while one runs, and a second one is refused at once.

A release that drops files the live release has is refused (steps 2 and 3) unless -AllowRemovals is given:
launchers delete every file a release no longer lists, so a release built from a wrong folder would uninstall the
game everywhere. Check the "removed" list of step 2 before allowing it.
#>
[CmdletBinding()]
param(
    [string]$Release = '\\tsclient\C\Culling\releases\1.1.0\publish',
    # Only for a release that doesn't offer a launcher (older builds): the setup to put on the website.
    [string]$Setup = '\\tsclient\C\Culling\launcher\dist\TheCullingRemasterSetup.exe',
    [string]$Root = 'C:\culling',
    [string]$Www = 'C:\ssr\www',
    [string]$Domain = 'xplab.shop',
    [int]$PublicPort = 8443,
    # Allow a release that removes files the live release has (see above).
    [switch]$AllowRemovals,
    # node.exe (default: <Root>\node\node.exe, installed by install_vps.ps1).
    [string]$Node = '',
    # Where the log of this run goes (default: <Root>\logs): publish-<time>.log, the newest 30 kept.
    [string]$LogDir = ''
)
# Every run ends with one line saying what happened: green PUBLISHED, or red PUBLISH FAILED and why (and whether
# anything went live); the exit code is 0 only for PUBLISHED. Everything printed is also in the log file. Before
# this (docs\SERVER_AUDIT_2.md, D1/D2) a publish could end without publishing and without saying so.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Step([string]$Text) { Write-Host "== $Text" -ForegroundColor Cyan }
$started = Get-Date
if (-not $Node) { $Node = Join-Path $Root 'node\node.exe' }
if (-not $LogDir) { $LogDir = Join-Path $Root 'logs' }
New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$log = Join-Path $LogDir ('publish-{0:yyyyMMdd-HHmmss}.log' -f $started)
Start-Transcript -Path $log -Force | Out-Null

# Runs node with its output through this host (so the log has it: a native command writing to the console
# directly is not in a transcript); returns its exit code.
function Invoke-Node {
    $ErrorActionPreference = 'Continue'
    & $Node @args 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.Exception.Message -ForegroundColor Red } else { Write-Host $_ }
    }
    return $LASTEXITCODE
}

$code = 1
$live = $false             # whether the new manifest went live
$why = ''
$version = '?'
$previousVersion = $null
$lock = $null
try {
    $updates = Join-Path $Root 'updates'
    $download = Join-Path $Www 'download'
    # What launchers get now (named in the last line, whatever happens).
    $liveManifest = Join-Path $updates 'manifest.json'
    if (Test-Path $liveManifest) {
        try { $previousVersion = [string](Get-Content $liveManifest -Raw | ConvertFrom-Json).version } catch { $previousVersion = '(unreadable)' }
    }
    # One publish at a time: the lock file is held open (shared with nobody) until this one ends, and Windows
    # deletes it then, also when the window is closed mid-publish.
    $lockPath = Join-Path $Root 'publish.lock'
    try {
        $lock = New-Object IO.FileStream($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 4096,
            [IO.FileOptions]::DeleteOnClose)
    } catch {
        throw "another publish is running (it holds $lockPath): wait for it to finish, then run this again"
    }
    $lockInfo = [Text.Encoding]::UTF8.GetBytes("pid $PID, started $($started.ToString('s'))")
    $lock.Write($lockInfo, 0, $lockInfo.Length)
    $lock.Flush()
    foreach ($p in (Join-Path $Release 'manifest.json'), (Join-Path $Release 'manifest.json.sig'), (Join-Path $Release 'objects')) {
        if (-not (Test-Path $p)) { throw "missing: $p (is the build PC's drive shared over Remote Desktop, and is the version right?)" }
    }
    if (-not (Test-Path $Node)) { throw "node.exe not found at $Node (run Update Culling Server.bat first: it installs it)" }
    New-Item -ItemType Directory -Force -Path $updates, $download | Out-Null
    # The manifest is read from the shared drive once, here.
    $stagedManifest = Join-Path $env:TEMP 'culling-publish-manifest.json'
    $stagedSig = Join-Path $env:TEMP 'culling-publish-manifest.json.sig'
    Copy-Item (Join-Path $Release 'manifest.json') $stagedManifest -Force
    Copy-Item (Join-Path $Release 'manifest.json.sig') $stagedSig -Force

    Step 'Signature'
    if ((Invoke-Node (Join-Path $PSScriptRoot 'verify_release.js') $stagedManifest $stagedSig) -ne 0) {
        throw 'the release is not signed by the launcher release key: not published'
    }
    $manifest = Get-Content $stagedManifest -Raw | ConvertFrom-Json
    $version = [string]$manifest.version
    Write-Host "  publishing $version; live now: $(if ($previousVersion) { $previousVersion } else { 'nothing (first publish)' })"

    $removals = @()
    if ($AllowRemovals) { $removals = @('--allow-removals') }

    Step 'What changes'
    # Every stage_objects.js step reads the verified TEMP copy (and checks its signature again), never the
    # release folder's manifest: a rebuild on the build PC mid-publish can't change what is staged.
    if ((Invoke-Node (Join-Path $PSScriptRoot 'stage_objects.js') --plan @removals --manifest $stagedManifest --sig $stagedSig $Release $updates) -ne 0) {
        throw 'the release was refused or comparing with the live release failed (above): nothing was published'
    }

    Step 'Upload (only what the VPS lacks; each file checked against its SHA-256)'
    if ((Invoke-Node (Join-Path $PSScriptRoot 'stage_objects.js') @removals --manifest $stagedManifest --sig $stagedSig $Release $updates) -ne 0) {
        throw 'staging the release objects failed: the published release is unchanged'
    }
    # Without a launcher in the release, the website's setup comes from -Setup (over the shared drive): checked
    # to be there before anything goes live.
    if (-not $manifest.launcher -and -not (Test-Path $Setup)) { throw "missing: $Setup" }

    Step 'Go live'
    # The release that was live, for the check below (which files changed).
    $previous = Join-Path $env:TEMP 'culling-previous-manifest.json'
    if (Test-Path $liveManifest) { Copy-Item $liveManifest $previous -Force }
    else { Remove-Item $previous -Force -ErrorAction SilentlyContinue }
    # The signature first, then the manifest, each swapped in whole; a launcher reading between the two re-reads once.
    Copy-Item $stagedSig (Join-Path $updates 'manifest.json.sig.new') -Force
    Copy-Item $stagedManifest (Join-Path $updates 'manifest.json.new') -Force
    Move-Item (Join-Path $updates 'manifest.json.sig.new') (Join-Path $updates 'manifest.json.sig') -Force
    Move-Item (Join-Path $updates 'manifest.json.new') $liveManifest -Force
    $live = $true
    Write-Host "  release $version is in place"

    Step 'Website setup'
    # Only once the release is live: a publish that failed before this leaves the website as it was.
    if ($manifest.launcher) {
        # From the staged (already verified) setup object: no second trip over the shared drive.
        if ((Invoke-Node (Join-Path $PSScriptRoot 'stage_objects.js') --setup --manifest $stagedManifest --sig $stagedSig $Release $updates $download) -ne 0) {
            throw 'putting the setup on the website failed (the website still offers the previous setup); launchers update themselves from the release'
        }
    } else {
        Write-Host "  (this release doesn't offer a launcher update: older launchers keep their version)" -ForegroundColor Yellow
        Copy-Item $Setup (Join-Path $download 'TheCullingRemasterSetup.exe.new') -Force
        $setupHash = (Get-FileHash (Join-Path $download 'TheCullingRemasterSetup.exe.new') -Algorithm SHA256).Hash.ToLower()
        Move-Item (Join-Path $download 'TheCullingRemasterSetup.exe.new') (Join-Path $download 'TheCullingRemasterSetup.exe') -Force
        $info = [ordered]@{ version = (Get-Item (Join-Path $download 'TheCullingRemasterSetup.exe')).VersionInfo.ProductVersion;
            size = (Get-Item (Join-Path $download 'TheCullingRemasterSetup.exe')).Length; sha256 = $setupHash;
            published = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ'); url = '/download/TheCullingRemasterSetup.exe' }
        [IO.File]::WriteAllText((Join-Path $download 'launcher.json.new'), ($info | ConvertTo-Json -Compress), (New-Object Text.UTF8Encoding($false)))
        Move-Item (Join-Path $download 'launcher.json.new') (Join-Path $download 'launcher.json') -Force
    }

    Step 'Check (as launchers see it, over HTTPS)'
    $checkArgs = @((Join-Path $PSScriptRoot 'check_published.js'), "https://${Domain}:$PublicPort/remaster/", '--expect', $stagedManifest,
        '--version', $version, '--updates', $updates, '--website', "https://$Domain")
    if (Test-Path $previous) { $checkArgs += @('--changed-from', $previous) }
    if ((Invoke-Node @checkArgs) -ne 0) {
        throw "the check found problems (listed above): fix them, or publish the previous release ($previousVersion) again"
    }
    $code = 0
} catch {
    $why = $_.Exception.Message
    Write-Host ''
    Write-Host "ERROR: $why" -ForegroundColor Red
    if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) { Write-Host $_.InvocationInfo.PositionMessage -ForegroundColor DarkGray }
} finally {
    $seconds = [int]((Get-Date) - $started).TotalSeconds
    Write-Host ''
    if ($code -eq 0) {
        if ($previousVersion -eq $version) {
            Write-Host "NOTE: $version was already the live release: nothing new was published (it was checked again)." -ForegroundColor Yellow
        } else {
            $older = $false
            try { $older = $previousVersion -and ([version]$version -lt [version]$previousVersion) } catch { }
            if ($older) { Write-Host "NOTE: $version is older than $previousVersion, the release that was live: installed launchers refuse a downgrade (docs\UPDATE_INFRASTRUCTURE.md, Rolling back)." -ForegroundColor Yellow }
        }
        Write-Host "PUBLISHED $version in $seconds s: https://${Domain}:$PublicPort/remaster/manifest.json says $version (was $(if ($previousVersion) { $previousVersion } else { 'nothing' }))." -ForegroundColor Green
    } elseif ($live) {
        Write-Host "PUBLISH FAILED AFTER GOING LIVE: release $version is live, but: $why" -ForegroundColor Red
    } else {
        Write-Host "PUBLISH FAILED: nothing was published ($(if ($previousVersion) { "$previousVersion is still live" } else { 'the live release is unchanged' })): $why" -ForegroundColor Red
    }
    Write-Host "Log: $log"
    if ($lock) { $lock.Dispose() }
    try { Stop-Transcript | Out-Null } catch { }
    # The newest 30 logs are kept.
    Get-ChildItem $LogDir -Filter 'publish-*.log' -ErrorAction SilentlyContinue | Sort-Object Name -Descending |
        Select-Object -Skip 30 | Remove-Item -Force -ErrorAction SilentlyContinue
}
exit $code
