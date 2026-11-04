<#
The Culling Remaster account server on the xplab.shop VPS (Windows Server, next to Superstar Racing).

Run as administrator ON the VPS from this repository's clone ("Update Culling Server.bat" does it):
  - Node.js (pinned, SHA-256 checked) in C:\culling\node
  - the server code in C:\culling\app (npm ci, production packages only)
  - player data in C:\culling\data (profiles, sessions, ranked; never replaced by an update)
  - the Windows service "culling-server" (WinSW, the same pinned wrapper as Superstar Racing): starts with Windows,
    restarts after a crash, runs as LocalService, listens on 127.0.0.1 only
  - HTTPS: a Caddy site file C:\ssr\caddy\sites\culling.caddy (https://<domain>:<port> -> the service), loaded by the
    Superstar Racing Caddyfile's "import sites/*.caddy" line, and a firewall rule for that port

Safe to run again: it updates the code and restarts the service; data stays.
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\culling',
    [string]$Domain = 'xplab.shop',
    [int]$PublicPort = 8443,
    [int]$LocalPort = 8100,
    [string]$SsrRoot = 'C:\ssr'
)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$NodeVersion = '22.11.0'
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"
$NodeSha256 = '905373A059AECAF7F48C1CE10FFBD5334457CA00F678747F19DB5EA7D256C236'
$WinSWUrl = 'https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe'
$WinSWSha256 = 'B5066B7BBDFBA1293E5D15CDA3CAAEA88FBEAB35BD5B38C41C913D492AADFC4F'
$Service = 'culling-server'
$PublicUrl = "https://${Domain}:$PublicPort"
$Repo = Split-Path -Parent $PSScriptRoot

function Step([string]$Text) { Write-Host "== $Text" -ForegroundColor Cyan }

function Get-Download([string]$Url, [string]$OutFile, [string]$Sha256) {
    if ((Test-Path $OutFile) -and (Get-FileHash $OutFile -Algorithm SHA256).Hash -eq $Sha256) { return $OutFile }
    Invoke-WebRequest -Uri $Url -OutFile "$OutFile.part" -UseBasicParsing
    $got = (Get-FileHash "$OutFile.part" -Algorithm SHA256).Hash
    if ($got -ne $Sha256) { Remove-Item "$OutFile.part" -Force; throw "$Url failed its SHA-256 check ($got)" }
    Move-Item "$OutFile.part" $OutFile -Force
    return $OutFile
}

function Invoke-Native([string]$What, [scriptblock]$Command) {
    & $Command
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this as administrator.' }

foreach ($d in '', 'downloads', 'node', 'app', 'data', 'data\logs', 'service', 'updates') {
    New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) | Out-Null
}

Step "Node.js $NodeVersion"
$nodeExe = Join-Path $Root 'node\node.exe'
$have = if (Test-Path $nodeExe) { (& $nodeExe --version) } else { '' }
if ($have -ne "v$NodeVersion") {
    $zip = Get-Download $NodeUrl (Join-Path $Root "downloads\node-v$NodeVersion-win-x64.zip") $NodeSha256
    $tmp = Join-Path $Root 'downloads\node.new'
    if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
    Expand-Archive $zip $tmp
    $svc = Get-Service $Service -ErrorAction SilentlyContinue
    if ($svc -and $svc.Status -eq 'Running') { Stop-Service $Service }
    Remove-Item (Join-Path $Root 'node') -Recurse -Force
    Move-Item (Join-Path $tmp "node-v$NodeVersion-win-x64") (Join-Path $Root 'node')
    Remove-Item $tmp -Recurse -Force
}

Step 'Server code'
$app = Join-Path $Root 'app'
foreach ($f in 'server.js', 'ranked.js', 'session.js', 'lastbreath.js', 'package.json', 'package-lock.json') {
    Copy-Item (Join-Path $Repo "server\$f") (Join-Path $app $f) -Force
}
New-Item -ItemType Directory -Force -Path (Join-Path $app 'data') | Out-Null
Copy-Item (Join-Path $Repo 'server\data\lastbreath.ini') (Join-Path $app 'data\lastbreath.ini') -Force
Push-Location $app
try {
    $env:Path = (Join-Path $Root 'node') + ';' + $env:Path
    Invoke-Native 'npm ci' { & (Join-Path $Root 'node\npm.cmd') ci --omit=dev --no-audit --no-fund }
} finally { Pop-Location }

Step 'Player data'
$data = Join-Path $Root 'data'
# The item catalog ships with the code; profiles, sessions and the level curve the game reports stay.
Copy-Item (Join-Path $Repo 'server\data\catalog.json') (Join-Path $data 'catalog.json') -Force
$levels = Join-Path $Repo 'server\data\levels.json'
if ((Test-Path $levels) -and -not (Test-Path (Join-Path $data 'levels.json'))) { Copy-Item $levels $data }
Invoke-Native 'icacls' { icacls $data /grant '*S-1-5-19:(OI)(CI)M' /Q }

Step "Service $Service"
$wrapper = Get-Download $WinSWUrl (Join-Path $Root 'downloads\WinSW.NET461.exe') $WinSWSha256
$svcExe = Join-Path $Root "service\$Service.exe"
$svcXml = Join-Path $Root "service\$Service.xml"
@"
<service>
  <id>$Service</id>
  <name>The Culling Remaster account server</name>
  <description>Profiles, shop, ranked and matchmaking for The Culling Remaster (127.0.0.1:$LocalPort, public at $PublicUrl via Caddy).</description>
  <executable>$Root\node\node.exe</executable>
  <arguments>"$app\server.js"</arguments>
  <workingdirectory>$app</workingdirectory>
  <env name="CULLING_HOST" value="127.0.0.1"/>
  <env name="CULLING_PORT" value="$LocalPort"/>
  <env name="CULLING_DATA_DIR" value="$data"/>
  <env name="CULLING_PUBLIC_URL" value="$PublicUrl"/>
  <env name="CULLING_UITRACE" value="0"/>
  <env name="NODE_ENV" value="production"/>
  <startmode>Automatic</startmode>
  <stoptimeout>15 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>$data\logs</logpath>
  <log mode="roll-by-size"><sizeThreshold>5120</sizeThreshold><keepFiles>4</keepFiles></log>
</service>
"@ | Set-Content -Encoding UTF8 $svcXml
$svc = Get-Service $Service -ErrorAction SilentlyContinue
if ($svc -and $svc.Status -eq 'Running') { Stop-Service $Service }
Copy-Item $wrapper $svcExe -Force
if (-not $svc) {
    Invoke-Native 'service install' { & $svcExe install }
    Invoke-Native 'sc config' { sc.exe config $Service obj= 'NT AUTHORITY\LocalService' password= '' }
}
Start-Service $Service

Step "HTTPS on $PublicUrl"
$sites = Join-Path $SsrRoot 'caddy\sites'
New-Item -ItemType Directory -Force -Path $sites | Out-Null
@"
# The Culling Remaster account server (written by TheCullingRemaster deploy\install_vps.ps1).
${Domain}:$PublicPort {
	# Launcher releases (Game Sync): manifest.json and files/..., published to $($Root -replace '\\','/')/updates
	handle_path /remaster/* {
		root * $($Root -replace '\\','/')/updates
		@manifest path /manifest.json
		header @manifest Cache-Control "no-cache"
		file_server
	}
	reverse_proxy 127.0.0.1:$LocalPort
	header Strict-Transport-Security "max-age=31536000"
}
"@ | Set-Content -Encoding UTF8 (Join-Path $sites 'culling.caddy')
$caddyfile = Join-Path $SsrRoot 'caddy\Caddyfile'
$caddyExe = Join-Path $SsrRoot 'caddy\caddy.exe'
if ((Test-Path $caddyfile) -and (Select-String -Path $caddyfile -Pattern 'import .*sites/\*\.caddy' -Quiet)) {
    Invoke-Native 'caddy validate' { & $caddyExe validate --config $caddyfile --adapter caddyfile }
    Invoke-Native 'caddy reload' { & $caddyExe reload --config $caddyfile --adapter caddyfile }
} else {
    Write-Warning "The Superstar Racing Caddyfile doesn't import sites/*.caddy yet: update the VPS with the Superstarracing change that adds it (""Update VPS.bat""), then run this again."
}
if (-not (Get-NetFirewallRule -DisplayName "Culling Remaster HTTPS $PublicPort" -ErrorAction SilentlyContinue)) {
    New-NetFirewallRule -DisplayName "Culling Remaster HTTPS $PublicPort" -Direction Inbound -Protocol TCP -LocalPort $PublicPort -Action Allow | Out-Null
}

Step 'Checks'
Start-Sleep -Seconds 2
$local = Invoke-RestMethod "http://127.0.0.1:$LocalPort/health"
Write-Host "  service:  ok=$($local.ok) users=$($local.users)"
try {
    $public = Invoke-RestMethod "$PublicUrl/health" -TimeoutSec 15
    Write-Host "  public:   ok=$($public.ok) ($PublicUrl)" -ForegroundColor Green
} catch {
    Write-Warning "$PublicUrl/health isn't answering yet: $($_.Exception.Message). If Caddy was just reloaded, the certificate may take a minute; if it stays down, check the hosting panel's firewall allows TCP $PublicPort."
}
Write-Host 'Done.' -ForegroundColor Green
