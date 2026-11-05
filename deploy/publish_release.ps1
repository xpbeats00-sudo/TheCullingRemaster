<#
Publish a launcher release and the launcher's setup on the xplab.shop VPS.

Run ON the VPS ("Publish Release.bat" does it), with the build PC's drive shared over Remote Desktop
(Local Resources > More > Drives), so the build PC's C: is \\tsclient\C. The shared drive is slow, so only files the
VPS doesn't have yet cross it, each exactly once:
  1. checks the release's signature with the launcher's own release key (refuses anything unsigned or altered)
  2. says what changes against the live release and how much will be uploaded (reads only the manifest)
  3. puts the release's objects in C:\culling\updates\objects (deploy\stage_objects.js): objects already there are
     reused; missing ones, the launcher setup the release offers among them, are copied over and checked against
     their SHA-256 on the VPS; files of the old files\ layout are linked, not uploaded
  4. the website's setup (C:\ssr\www\download\TheCullingRemasterSetup.exe) and download\launcher.json (version, size,
     sha256: the website shows the current launcher from it) come from the staged setup object, on the VPS
  5. manifest.json(.sig) last, so a launcher never sees a manifest whose objects aren't there yet
     (served as https://<domain>:8443/remaster/; objects never change, so they can be cached for good)
  6. checks the result as launchers see it, over HTTPS (deploy\check_published.js): signature, every object on
     disk, the changed files and the setup downloaded and hash-checked, the website's launcher.json and setup

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
    [switch]$AllowRemovals
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Step([string]$Text) { Write-Host "== $Text" -ForegroundColor Cyan }
$started = Get-Date

foreach ($p in (Join-Path $Release 'manifest.json'), (Join-Path $Release 'manifest.json.sig'), (Join-Path $Release 'objects')) {
    if (-not (Test-Path $p)) { throw "missing: $p (is the build PC's drive shared over Remote Desktop?)" }
}
$node = Join-Path $Root 'node\node.exe'
$updates = Join-Path $Root 'updates'
$download = Join-Path $Www 'download'
New-Item -ItemType Directory -Force -Path $updates, $download | Out-Null
# The manifest is read from the shared drive once, here.
$stagedManifest = Join-Path $env:TEMP 'culling-publish-manifest.json'
$stagedSig = Join-Path $env:TEMP 'culling-publish-manifest.json.sig'
Copy-Item (Join-Path $Release 'manifest.json') $stagedManifest -Force
Copy-Item (Join-Path $Release 'manifest.json.sig') $stagedSig -Force

Step 'Signature'
& $node (Join-Path $PSScriptRoot 'verify_release.js') $stagedManifest $stagedSig
if ($LASTEXITCODE -ne 0) { throw 'the release is not signed by the launcher release key: not published' }
$manifest = Get-Content $stagedManifest -Raw | ConvertFrom-Json

$removals = @()
if ($AllowRemovals) { $removals = @('--allow-removals') }

Step 'What changes'
& $node (Join-Path $PSScriptRoot 'stage_objects.js') --plan @removals $Release $updates
if ($LASTEXITCODE -ne 0) { throw 'the release was refused or comparing with the live release failed (above): nothing was published' }

Step 'Upload (only what the VPS lacks; each file checked against its SHA-256)'
& $node (Join-Path $PSScriptRoot 'stage_objects.js') @removals $Release $updates
if ($LASTEXITCODE -ne 0) { throw 'staging the release objects failed: the published release is unchanged' }

Step 'Website setup'
if ($manifest.launcher) {
    # From the staged (already verified) setup object: no second trip over the shared drive.
    & $node (Join-Path $PSScriptRoot 'stage_objects.js') --setup $Release $updates $download
    if ($LASTEXITCODE -ne 0) { throw 'putting the setup on the website failed: the published release is unchanged' }
} else {
    if (-not (Test-Path $Setup)) { throw "missing: $Setup" }
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

Step 'Go live'
# The release that was live, for the check below (which files changed).
$previous = Join-Path $env:TEMP 'culling-previous-manifest.json'
if (Test-Path (Join-Path $updates 'manifest.json')) { Copy-Item (Join-Path $updates 'manifest.json') $previous -Force }
else { Remove-Item $previous -Force -ErrorAction SilentlyContinue }
# The signature first, then the manifest, each swapped in whole; a launcher reading between the two re-reads once.
Copy-Item $stagedSig (Join-Path $updates 'manifest.json.sig.new') -Force
Copy-Item $stagedManifest (Join-Path $updates 'manifest.json.new') -Force
Move-Item (Join-Path $updates 'manifest.json.sig.new') (Join-Path $updates 'manifest.json.sig') -Force
Move-Item (Join-Path $updates 'manifest.json.new') (Join-Path $updates 'manifest.json') -Force
Write-Host "  release $($manifest.version) is live"

Step 'Check (as launchers see it, over HTTPS)'
$checkArgs = @((Join-Path $PSScriptRoot 'check_published.js'), "https://${Domain}:$PublicPort/remaster/", '--expect', $stagedManifest,
    '--updates', $updates, '--website', "https://$Domain")
if (Test-Path $previous) { $checkArgs += @('--changed-from', $previous) }
& $node @checkArgs
if ($LASTEXITCODE -ne 0) {
    Write-Host 'The release is live but the check found problems (listed above). Fix them, or publish the previous release again.' -ForegroundColor Red
    exit 1
}
Write-Host ("Published {0} in {1:N0} s." -f $manifest.version, ((Get-Date) - $started).TotalSeconds) -ForegroundColor Green
