<#
Publish a launcher release and the launcher's setup on the xplab.shop VPS.

Run ON the VPS ("Publish Release.bat" does it), with the build PC's drive shared over Remote Desktop
(Local Resources > More > Drives), so the build PC's C: is \\tsclient\C:
  - checks the release's signature with the launcher's own release key (refuses anything unsigned or altered)
  - copies the release's files to C:\culling\updates\files first and manifest.json(.sig) last, so a launcher never
    sees a manifest whose files aren't there yet (served as https://<domain>:8443/remaster/)
  - copies the setup to C:\ssr\www\download (kept by the website deploy), served as
    https://<domain>/download/TheCullingRemasterSetup.exe
#>
[CmdletBinding()]
param(
    [string]$Release = '\\tsclient\C\Culling\releases\1.1.0\publish',
    [string]$Setup = '\\tsclient\C\Culling\launcher\dist\TheCullingRemasterSetup.exe',
    [string]$Root = 'C:\culling',
    [string]$Www = 'C:\ssr\www',
    [string]$Domain = 'xplab.shop',
    [int]$PublicPort = 8443
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Step([string]$Text) { Write-Host "== $Text" -ForegroundColor Cyan }

foreach ($p in (Join-Path $Release 'manifest.json'), (Join-Path $Release 'manifest.json.sig'), (Join-Path $Release 'files'), $Setup) {
    if (-not (Test-Path $p)) { throw "missing: $p (is the build PC's drive shared over Remote Desktop?)" }
}

Step 'Signature'
$node = Join-Path $Root 'node\node.exe'
& $node (Join-Path $PSScriptRoot 'verify_release.js') (Join-Path $Release 'manifest.json') (Join-Path $Release 'manifest.json.sig')
if ($LASTEXITCODE -ne 0) { throw 'the release is not signed by the launcher release key: not published' }

Step 'Release files'
$updates = Join-Path $Root 'updates'
New-Item -ItemType Directory -Force -Path $updates | Out-Null
robocopy (Join-Path $Release 'files') (Join-Path $updates 'files') /MIR /R:5 /W:5 /MT:8 /NP /NFL /NDL /NJH
if ($LASTEXITCODE -ge 8) { throw "copying the release files failed (robocopy exit $LASTEXITCODE)" }
# The signature first, then the manifest: both replace the old ones only once every file is in place.
Copy-Item (Join-Path $Release 'manifest.json.sig') (Join-Path $updates 'manifest.json.sig.new') -Force
Copy-Item (Join-Path $Release 'manifest.json') (Join-Path $updates 'manifest.json.new') -Force
Move-Item (Join-Path $updates 'manifest.json.sig.new') (Join-Path $updates 'manifest.json.sig') -Force
Move-Item (Join-Path $updates 'manifest.json.new') (Join-Path $updates 'manifest.json') -Force

Step 'Launcher setup'
$download = Join-Path $Www 'download'
New-Item -ItemType Directory -Force -Path $download | Out-Null
Copy-Item $Setup (Join-Path $download 'TheCullingRemasterSetup.exe.new') -Force
Move-Item (Join-Path $download 'TheCullingRemasterSetup.exe.new') (Join-Path $download 'TheCullingRemasterSetup.exe') -Force

Step 'Checks'
$m = Invoke-RestMethod "https://${Domain}:$PublicPort/remaster/manifest.json" -TimeoutSec 20
Write-Host "  manifest: version $($m.version), $($m.files.Count) files" -ForegroundColor Green
$head = Invoke-WebRequest "https://$Domain/download/TheCullingRemasterSetup.exe" -Method Head -UseBasicParsing -TimeoutSec 20
Write-Host "  setup:    $([math]::Round([int64]$head.Headers['Content-Length'] / 1MB, 1)) MB at https://$Domain/download/TheCullingRemasterSetup.exe" -ForegroundColor Green
Write-Host 'Published.' -ForegroundColor Green
