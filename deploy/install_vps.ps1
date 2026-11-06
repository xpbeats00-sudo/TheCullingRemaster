<#
The Culling Remaster account server on the xplab.shop VPS (Windows Server, next to Superstar Racing).

Run as administrator ON the VPS from this repository's clone ("Update Culling Server.bat" does it):
  - Node.js (pinned, SHA-256 checked) in C:\culling\node
  - the server code in C:\culling\app (npm ci, production packages only)
  - player data in C:\culling\data (profiles, sessions, ranked; never replaced by an update)
  - the Windows service "culling-server" (WinSW, the same pinned wrapper as Superstar Racing): starts with Windows,
    restarts after a crash, runs as LocalService, listens on 127.0.0.1 only; a stop saves all player data first
  - the scheduled task "Culling Server Watchdog" (C:\culling\service\culling_watchdog.ps1, as SYSTEM, every minute):
    restarts the service if it stops answering /health (hung, not crashed), with backoff; logs to C:\culling\data\logs
  - HTTPS: a Caddy site file C:\ssr\caddy\sites\culling.caddy (https://<domain>:<port> -> the service), loaded by the
    Superstar Racing Caddyfile's "import sites/*.caddy" line, and a firewall rule for that port

Safe to run again: it updates the code and restarts the service; data stays. An update (docs\SERVER_AUDIT_2.md, D3):
  1. builds the new code in C:\culling\app.new (npm ci there) while the running server carries on: a failure here
     changes nothing;
  2. stops the service (it saves everything), backs up C:\culling\data to C:\culling\data\backups\pre-update-<time>
     (server\backup.js: checked against its SHA-256 list; the newest 10 kept; the server keeps 14 daily ones there too);
  3. swaps the code (the old one becomes C:\culling\app.previous), starts the service and waits up to 60 s for
     /health; if the new code doesn't answer, it puts the previous code (and catalog) back, starts that, and fails.
It ends with a green SERVER UPDATED or a red UPDATE FAILED line, then the log's path (C:\culling\logs\update-<time>.log,
the newest 30 kept); the exit code is 0 only for SERVER UPDATED.
#>
[CmdletBinding()]
param(
    [string]$Root = 'C:\culling',
    [string]$Domain = 'xplab.shop',
    [int]$PublicPort = 8443,
    [int]$LocalPort = 8100,
    [string]$SsrRoot = 'C:\ssr',
    # 1: the game can only log in through an account (the launcher's PLAY); 0: any game can log in, as before.
    # Left out, accounts are required: the launcher with accounts (1.3.0) is published, and without it anyone
    # could log in as any Steam ID. -RequireAccount 0 turns it off explicitly (docs\ACCOUNTS.md).
    [ValidateSet(-1, 0, 1)][int]$RequireAccount = -1,
    # How long the new code has to answer /health before it is rolled back.
    [int]$StartTimeoutSeconds = 60
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

# A native command, its output through this host (so the log has it), and a failure if it exits non-zero.
function Invoke-Native([string]$What, [scriptblock]$Command) {
    $ErrorActionPreference = 'Continue'
    & $Command 2>&1 | ForEach-Object {
        if ($_ -is [System.Management.Automation.ErrorRecord]) { Write-Host $_.Exception.Message -ForegroundColor DarkYellow } else { Write-Host $_ }
    }
    if ($LASTEXITCODE -ne 0) { throw "$What failed (exit code $LASTEXITCODE)" }
}

# Whether the service answers /health with ok within $Seconds.
function Wait-Healthy([int]$Seconds) {
    $until = (Get-Date).AddSeconds($Seconds)
    do {
        try {
            $h = Invoke-RestMethod "http://127.0.0.1:$LocalPort/health" -TimeoutSec 5
            if ($h.ok) { return $true }
        } catch { }
        Start-Sleep -Seconds 2
    } while ((Get-Date) -lt $until)
    return $false
}

function Stop-CullingService {
    $s = Get-Service $Service -ErrorAction SilentlyContinue
    if ($s -and $s.Status -ne 'Stopped') { Stop-Service $Service; (Get-Service $Service).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30)) }
}

$principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'Run this as administrator.' }

foreach ($d in '', 'downloads', 'node', 'app', 'data', 'data\logs', 'service', 'updates', 'logs') {
    New-Item -ItemType Directory -Force -Path (Join-Path $Root $d) | Out-Null
}
$started = Get-Date
$logDir = Join-Path $Root 'logs'
$log = Join-Path $logDir ('update-{0:yyyyMMdd-HHmmss}.log' -f $started)
Start-Transcript -Path $log -Force | Out-Null

$code = 1
$why = ''
$snapshot = $null          # the pre-update backup of the data, once taken
$outcome = ''               # what state the server was left in, for the last line
$app = Join-Path $Root 'app'
$appNew = Join-Path $Root 'app.new'
$appPrevious = Join-Path $Root 'app.previous'
$data = Join-Path $Root 'data'
$nodeExe = Join-Path $Root 'node\node.exe'
try {
    Step "Node.js $NodeVersion"
    $have = if (Test-Path $nodeExe) { (& $nodeExe --version) } else { '' }
    if ($have -ne "v$NodeVersion") {
        $zip = Get-Download $NodeUrl (Join-Path $Root "downloads\node-v$NodeVersion-win-x64.zip") $NodeSha256
        $tmp = Join-Path $Root 'downloads\node.new'
        if (Test-Path $tmp) { Remove-Item $tmp -Recurse -Force }
        Expand-Archive $zip $tmp
        Stop-CullingService
        $outcome = "Node.js was being replaced (the service is stopped): check $Root
ode and start the service"
        Remove-Item (Join-Path $Root 'node') -Recurse -Force
        Move-Item (Join-Path $tmp "node-v$NodeVersion-win-x64") (Join-Path $Root 'node')
        Remove-Item $tmp -Recurse -Force
        $outcome = 'the service is stopped'
    }

    Step 'Server code (built beside the running one)'
    if (Test-Path $appNew) { Remove-Item $appNew -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $appNew, (Join-Path $appNew 'tools'), (Join-Path $appNew 'data') | Out-Null
    # Every server module (a fixed list missed showdown.js, and the service then
    # failed to start), minus the old server.before-*.js backups.
    $modules = Get-ChildItem (Join-Path $Repo 'server') -Filter '*.js' -File | Where-Object { $_.Name -notlike '*.before-*' }
    foreach ($m in $modules) { Copy-Item $m.FullName (Join-Path $appNew $m.Name) -Force }
    foreach ($f in 'package.json', 'package-lock.json') {
        Copy-Item (Join-Path $Repo "server\$f") (Join-Path $appNew $f) -Force
    }
    # Operator commands (node tools\account_admin.js ...), run on the VPS while the service is running.
    Copy-Item (Join-Path $Repo 'server\tools\account_admin.js') (Join-Path $appNew 'tools\account_admin.js') -Force
    Copy-Item (Join-Path $Repo 'server\data\lastbreath.ini') (Join-Path $appNew 'data\lastbreath.ini') -Force
    # Showdown's kit (server.js reads it from beside the code; make_showdown.py writes it).
    Copy-Item (Join-Path $Repo 'server\data\showdown.json') (Join-Path $appNew 'data\showdown.json') -Force
    Push-Location $appNew
    try {
        $env:Path = (Join-Path $Root 'node') + ';' + $env:Path
        Invoke-Native 'npm ci' { & (Join-Path $Root 'node\npm.cmd') ci --omit=dev --no-audit --no-fund }
    } finally { Pop-Location }
    Invoke-Native 'checking the new code' { & $nodeExe --check (Join-Path $appNew 'server.js') }
    Invoke-Native 'loading the new code' { & $nodeExe -e "process.chdir(process.argv[1]); for (const m of ['express', 'socket.io']) require(require.resolve(m, { paths: [process.argv[1]] })); console.log('  modules load')" $appNew }

    Step "Service $Service (stopped for the swap)"
    $wrapper = Get-Download $WinSWUrl (Join-Path $Root 'downloads\WinSW.NET461.exe') $WinSWSha256
    $svcExe = Join-Path $Root "service\$Service.exe"
    $svcXml = Join-Path $Root "service\$Service.xml"
    if ($RequireAccount -eq -1) { $RequireAccount = 1 }
    Write-Host "  accounts: $(if ($RequireAccount -eq 1) { 'required to play online' } else { 'NOT required (-RequireAccount 0): any game can log in as any Steam ID' })"
    Stop-CullingService
    $outcome = 'the service is stopped'

    Step 'Backup of the player data'
    $backups = Join-Path $data 'backups'
    $snapshot = $null
    if (Get-ChildItem $data -File -ErrorAction SilentlyContinue | Where-Object { $_.Name -match '\.(json|txt)$' }) {
        Invoke-Native 'backing up the player data' { & $nodeExe (Join-Path $Repo 'server\backup.js') snapshot $data $backups pre-update 10 }
        $snapshot = (Get-ChildItem $backups -Directory -Filter 'pre-update-*' | Where-Object { $_.Name -notlike '*.partial' } |
            Sort-Object Name | Select-Object -Last 1).FullName
        Write-Host "  $snapshot"
    } else {
        Write-Host '  no player data yet (first install)'
    }

    Step 'Swap in the new code'
    $hadPrevious = (Test-Path (Join-Path $app 'server.js'))
    if (Test-Path $appPrevious) { Remove-Item $appPrevious -Recurse -Force }
    if (Test-Path $app) { Move-Item $app $appPrevious }
    Move-Item $appNew $app
    $outcome = 'the new code is in place, the service is stopped'
    # The item catalog ships with the code; profiles, sessions and the level curve the game reports stay.
    Copy-Item (Join-Path $Repo 'server\data\catalog.json') (Join-Path $data 'catalog.json') -Force
    $levels = Join-Path $Repo 'server\data\levels.json'
    if ((Test-Path $levels) -and -not (Test-Path (Join-Path $data 'levels.json'))) { Copy-Item $levels $data }
    Invoke-Native 'icacls' { icacls $data /grant '*S-1-5-19:(OI)(CI)M' /Q }
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
  <env name="CULLING_REQUIRE_ACCOUNT" value="$RequireAccount"/>
  <env name="NODE_ENV" value="production"/>
  <startmode>Automatic</startmode>
  <!-- Stop: WinSW sends Ctrl+C to node (SIGINT in Node); the server writes profiles, sessions and accounts and exits, usually
       within a second. node is killed only if it is still running after stoptimeout. -->
  <stopparentprocessfirst>true</stopparentprocessfirst>
  <stoptimeout>15 sec</stoptimeout>
  <onfailure action="restart" delay="10 sec"/>
  <onfailure action="restart" delay="30 sec"/>
  <resetfailure>1 hour</resetfailure>
  <logpath>$data\logs</logpath>
  <log mode="roll-by-size"><sizeThreshold>5120</sizeThreshold><keepFiles>4</keepFiles></log>
</service>
"@ | Set-Content -Encoding UTF8 $svcXml
    $svc = Get-Service $Service -ErrorAction SilentlyContinue
    Copy-Item $wrapper $svcExe -Force
    if (-not $svc) {
        Invoke-Native 'service install' { & $svcExe install }
        Invoke-Native 'sc config' { sc.exe config $Service obj= 'NT AUTHORITY\LocalService' password= '' }
    }

    Step "Start (the new code has $StartTimeoutSeconds s to answer /health)"
    Start-Service $Service
    if (-not (Wait-Healthy $StartTimeoutSeconds)) {
        Write-Host "  the new code doesn't answer http://127.0.0.1:$LocalPort/health (its log: $data\logs)" -ForegroundColor Red
        if (-not $hadPrevious) { $outcome = 'the new code is installed but not answering; there was no previous code to go back to'; throw 'the server did not start' }
        Step 'Rolling back to the previous code'
        Stop-CullingService
        $failed = Join-Path $Root 'app.failed'
        if (Test-Path $failed) { Remove-Item $failed -Recurse -Force }
        Move-Item $app $failed
        Move-Item $appPrevious $app
        if ($snapshot -and (Test-Path (Join-Path $snapshot 'catalog.json'))) { Copy-Item (Join-Path $snapshot 'catalog.json') (Join-Path $data 'catalog.json') -Force }
        Start-Service $Service
        if (Wait-Healthy $StartTimeoutSeconds) {
            $outcome = "rolled back: the previous code is running and answering /health (the new one is in $failed)"
        } else {
            $outcome = "rolled back, but the previous code does not answer /health either: the server is DOWN (see $data\logs)"
        }
        throw "the new code did not answer /health within $StartTimeoutSeconds s"
    }
    $outcome = 'the new code is running'
    Write-Host '  the new code answers /health'

    Step 'Watchdog'
    # WinSW restarts node when it exits; the watchdog covers a process that is running but hung.
    $watchdog = Join-Path $Root 'service\culling_watchdog.ps1'
    Copy-Item (Join-Path $PSScriptRoot 'culling_watchdog.ps1') $watchdog -Force
    $taskName = 'Culling Server Watchdog'
    $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument ("-NoProfile -NonInteractive -ExecutionPolicy Bypass " +
        "-File ""$watchdog"" -Service $Service -HealthUrl http://127.0.0.1:$LocalPort/health -LogDir ""$data\logs""")
    # Every minute from a minute from now, indefinitely (the repetition carries on across reboots).
    $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Minutes 1)
    $settings = New-ScheduledTaskSettingsSet -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 3) `
        -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
    $taskPrincipal = New-ScheduledTaskPrincipal -UserId 'NT AUTHORITY\SYSTEM' -LogonType ServiceAccount -RunLevel Highest
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Settings $settings -Principal $taskPrincipal -Force `
        -Description "Probes $Service at http://127.0.0.1:$LocalPort/health every minute; restarts it after 3 failures, with backoff. Log: $data\logs\watchdog.log" |
        Out-Null
    Write-Host "  task:     $taskName (every minute; log $data\logs\watchdog.log)"

    Step "HTTPS on $PublicUrl"
    $sites = Join-Path $SsrRoot 'caddy\sites'
    New-Item -ItemType Directory -Force -Path $sites | Out-Null
@"
# The Culling Remaster account server (written by TheCullingRemaster deploy\install_vps.ps1).
${Domain}:$PublicPort {
	# Launcher releases (Game Sync): manifest.json, its .sig and objects/<sha256>, published to $($Root -replace '\\','/')/updates
	handle_path /remaster/* {
		root * $($Root -replace '\\','/')/updates
		@manifest path /manifest.json /manifest.json.sig
		header @manifest Cache-Control "no-cache"
		# Objects are named by their SHA-256, so a given URL never changes: any cache may keep it.
		@objects path /objects/*
		header @objects Cache-Control "public, max-age=31536000, immutable"
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
    $local = Invoke-RestMethod "http://127.0.0.1:$LocalPort/health"
    Write-Host "  service:  ok=$($local.ok) users=$($local.users)"
    # Telemetry (loopback only, never through Caddy): Invoke-RestMethod http://127.0.0.1:$LocalPort/metrics
    $metrics = Invoke-RestMethod "http://127.0.0.1:$LocalPort/metrics"
    Write-Host "  metrics:  uptime $($metrics.uptimeSeconds) s, heap $($metrics.memoryMB.heapUsed) MB"
    Write-Host "  accounts: $($metrics.accounts.accounts) (account required to play: $($metrics.accounts.required))"
    if ($metrics.backups) { Write-Host "  backups:  $($metrics.backups.dir) (daily, newest $($metrics.backups.keep) kept)" }
    try {
        $public = Invoke-RestMethod "$PublicUrl/health" -TimeoutSec 15
        Write-Host "  public:   ok=$($public.ok) ($PublicUrl)" -ForegroundColor Green
    } catch {
        Write-Warning "$PublicUrl/health isn't answering yet: $($_.Exception.Message). If Caddy was just reloaded, the certificate may take a minute; if it stays down, check the hosting panel's firewall allows TCP $PublicPort."
    }
    $code = 0
} catch {
    $why = $_.Exception.Message
    Write-Host ''
    Write-Host "ERROR: $why" -ForegroundColor Red
    if ($_.InvocationInfo -and $_.InvocationInfo.PositionMessage) { Write-Host $_.InvocationInfo.PositionMessage -ForegroundColor DarkGray }
    # Stopped for the swap and failed before the start: the server is put back as it was.
    if ($outcome -eq 'the service is stopped') {
        try { Start-Service $Service; $outcome = "the previous code was started again ($(if (Wait-Healthy 30) { 'answering /health' } else { 'NOT answering /health' }))" } catch { $outcome = "the service could not be started again: the server is DOWN ($($_.Exception.Message))" }
    } elseif ($outcome -eq 'the new code is in place, the service is stopped') {
        try {
            if (Test-Path $appPrevious) {
                if (Test-Path $app) { Remove-Item $app -Recurse -Force }
                Move-Item $appPrevious $app
            }
            Start-Service $Service
            $outcome = "the previous code was put back and started ($(if (Wait-Healthy 30) { 'answering /health' } else { 'NOT answering /health' }))"
        } catch { $outcome = "putting the previous code back failed: the server may be DOWN ($($_.Exception.Message))" }
    } elseif (-not $outcome) {
        $outcome = 'nothing was changed: the running server is untouched'
    }
} finally {
    $seconds = [int]((Get-Date) - $started).TotalSeconds
    Write-Host ''
    if ($code -eq 0) {
        Write-Host "SERVER UPDATED in $seconds s: the new code answers /health. Data backup: $(if ($snapshot) { $snapshot } else { 'none (no data yet)' })" -ForegroundColor Green
    } else {
        Write-Host "UPDATE FAILED: $why. $outcome.$(if ($snapshot) { " Data backup: $snapshot" })" -ForegroundColor Red
    }
    Write-Host "Log: $log"
    try { Stop-Transcript | Out-Null } catch { }
    Get-ChildItem $logDir -Filter 'update-*.log' -ErrorAction SilentlyContinue | Sort-Object Name -Descending |
        Select-Object -Skip 30 | Remove-Item -Force -ErrorAction SilentlyContinue
}
exit $code
