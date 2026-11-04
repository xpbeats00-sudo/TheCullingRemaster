<#
Watchdog for the culling-server service (The Culling Remaster account server).

WinSW already restarts the server when node.exe exits. This covers the other
case: the process is running but hung (no reply, or replies slower than 5 s).

Run once a minute by the scheduled task "Culling Server Watchdog" (installed by
install_vps.ps1, runs as SYSTEM). Each run:
  1. probes http://127.0.0.1:<port>/health (5 s timeout; slower counts as a failure);
  2. after 3 consecutive failures restarts the service, with backoff so it
     can never loop: 5, 10, 20, 40, then 60 minutes between restarts (back to
     5 once the server has been healthy for an hour since its last restart),
     and never more than 6 restarts in 24 h (after that it only logs: a human
     is needed);
  3. logs to C:\culling\data\logs\watchdog.log (failures, restarts, recoveries
     and an hourly "ok" line).
It never starts a service that is Stopped (that is someone's deliberate stop,
e.g. an update in progress) and does nothing while <LogDir>\watchdog.pause exists.

-DryRun: probe and log, but don't look at or restart the service (for testing).
#>
[CmdletBinding()]
param(
    [string]$Service = 'culling-server',
    [string]$HealthUrl = 'http://127.0.0.1:8100/health',
    [string]$LogDir = 'C:\culling\data\logs',
    [int]$FailuresBeforeRestart = 3,
    [int]$SlowSeconds = 5,
    [int[]]$BackoffMinutes = @(5, 10, 20, 40, 60),
    [int]$MaxRestartsPerDay = 6,
    [int]$StopTimeoutSeconds = 30,
    [switch]$DryRun
)
$ErrorActionPreference = 'Stop'

New-Item -ItemType Directory -Force -Path $LogDir | Out-Null
$logFile = Join-Path $LogDir 'watchdog.log'
$stateFile = Join-Path $LogDir 'watchdog-state.json'

function Write-Log([string]$Text) {
    # Keep the log small: one previous file.
    if ((Test-Path $logFile) -and (Get-Item $logFile).Length -gt 1MB) { Move-Item $logFile "$logFile.1" -Force }
    Add-Content -Path $logFile -Value ("{0:yyyy-MM-dd HH:mm:ss}  {1}" -f (Get-Date), $Text) -Encoding UTF8
}

function Get-State {
    $s = $null
    if (Test-Path $stateFile) { try { $s = Get-Content $stateFile -Raw | ConvertFrom-Json } catch { $s = $null } }
    if (-not $s) { $s = [pscustomobject]@{} }
    foreach ($k in @{ failures = 0; restarts = @(); backoff = 0; lastOkLog = ''; lastStatus = 'ok'; lastHealthyAt = '' }.GetEnumerator()) {
        if (-not ($s.PSObject.Properties.Name -contains $k.Key)) { $s | Add-Member -NotePropertyName $k.Key -NotePropertyValue $k.Value }
    }
    $s.restarts = @($s.restarts | Where-Object { $_ })
    return $s
}

function Save-State($s) {
    $tmp = "$stateFile.tmp"
    $s | ConvertTo-Json -Depth 4 | Set-Content -Path $tmp -Encoding UTF8
    Move-Item $tmp $stateFile -Force
}

# One probe: ok only for HTTP 200 with {"ok":true} within $SlowSeconds.
function Test-Health {
    $sw = [Diagnostics.Stopwatch]::StartNew()
    try {
        $req = [Net.HttpWebRequest]::Create($HealthUrl)
        $req.Proxy = $null
        $req.Timeout = $SlowSeconds * 1000
        $req.ReadWriteTimeout = $SlowSeconds * 1000
        $req.KeepAlive = $false
        $resp = $req.GetResponse()
        try {
            $body = (New-Object IO.StreamReader($resp.GetResponseStream())).ReadToEnd()
            $code = [int]$resp.StatusCode
        } finally { $resp.Close() }
        $ms = $sw.ElapsedMilliseconds
        if ($code -ne 200) { return @{ ok = $false; ms = $ms; why = "HTTP $code" } }
        if ($body -notmatch '"ok"\s*:\s*true') { return @{ ok = $false; ms = $ms; why = 'unexpected reply' } }
        if ($ms -gt $SlowSeconds * 1000) { return @{ ok = $false; ms = $ms; why = "slow reply ($ms ms)" } }
        return @{ ok = $true; ms = $ms; why = '' }
    } catch {
        $msg = $_.Exception.InnerException.Message
        if (-not $msg) { $msg = $_.Exception.Message }
        return @{ ok = $false; ms = $sw.ElapsedMilliseconds; why = $msg }
    }
}

function Get-NodeProcess {
    $svc = Get-CimInstance Win32_Service -Filter "Name='$Service'"
    if (-not $svc -or -not $svc.ProcessId) { return $null }
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($svc.ProcessId) AND Name='node.exe'" | Select-Object -First 1
}

function Restart-CullingService {
    $node = Get-NodeProcess
    if ($node) {
        $p = Get-Process -Id $node.ProcessId -ErrorAction SilentlyContinue
        if ($p) { Write-Log ("  node pid {0}: cpu {1:N0} s, working set {2:N0} MB, {3} threads" -f $p.Id, $p.CPU, ($p.WorkingSet64 / 1MB), $p.Threads.Count) }
    }
    $svc = Get-Service $Service
    if ($svc.Status -ne 'Stopped') {
        # WinSW sends Ctrl+C (the server saves and exits), then kills node after its own stoptimeout.
        try { $svc.Stop() } catch { Write-Log "  stop request failed: $($_.Exception.Message)" }
        try { $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds($StopTimeoutSeconds)) } catch {
            Write-Log "  service did not stop within $StopTimeoutSeconds s: killing the wrapper and node"
            $wrapper = Get-CimInstance Win32_Service -Filter "Name='$Service'"
            if ($node) { Stop-Process -Id $node.ProcessId -Force -ErrorAction SilentlyContinue }
            if ($wrapper.ProcessId) { Stop-Process -Id $wrapper.ProcessId -Force -ErrorAction SilentlyContinue }
            $svc.WaitForStatus('Stopped', [TimeSpan]::FromSeconds(15))
        }
    }
    Start-Service $Service
    Write-Log "  service started again"
}

$state = Get-State
$now = Get-Date

if (Test-Path (Join-Path $LogDir 'watchdog.pause')) { exit 0 }

$svc = if ($DryRun) { [pscustomobject]@{ Status = 'Running' } } else { Get-Service $Service -ErrorAction SilentlyContinue }
if (-not $svc) { Write-Log "service $Service is not installed"; exit 0 }
if ($svc.Status -ne 'Running') {
    # Stopped: deliberate (update, maintenance). Start/StopPending: WinSW is already on it.
    if ($state.lastStatus -ne "service-$($svc.Status)") { Write-Log "service is $($svc.Status): not probing" }
    $state.lastStatus = "service-$($svc.Status)"
    $state.failures = 0
    Save-State $state
    exit 0
}

$probe = Test-Health
if ($probe.ok) {
    if ($state.failures -gt 0 -or $state.lastStatus -ne 'ok') {
        Write-Log ("healthy again ({0} ms) after {1} failed probe(s)" -f $probe.ms, $state.failures)
    } elseif (-not $state.lastOkLog -or ($now - [datetime]$state.lastOkLog).TotalMinutes -ge 60) {
        Write-Log ("ok ({0} ms)" -f $probe.ms)
        $state.lastOkLog = $now.ToString('o')
    }
    $state.failures = 0
    $state.lastStatus = 'ok'
    $state.lastHealthyAt = $now.ToString('o')
    $state.restarts = @($state.restarts | Where-Object { ($now - [datetime]$_).TotalHours -lt 24 })
    # Healthy for an hour since the last restart: the backoff starts from the beginning next time.
    if ($state.backoff -gt 0 -and (-not $state.restarts.Count -or ($now - [datetime]$state.restarts[-1]).TotalHours -ge 1)) {
        $state.backoff = 0
    }
    Save-State $state
    exit 0
}

$state.failures = [int]$state.failures + 1
$state.lastStatus = 'failing'
Write-Log ("probe failed ({0}/{1}): {2}" -f $state.failures, $FailuresBeforeRestart, $probe.why)

if ($state.failures -ge $FailuresBeforeRestart) {
    $recent = @($state.restarts | Where-Object { ($now - [datetime]$_).TotalHours -lt 24 })
    # The wait before this restart grows with each restart since the server was last healthy for an hour.
    $wait = if ([int]$state.backoff -gt 0) { $BackoffMinutes[[Math]::Min([int]$state.backoff - 1, $BackoffMinutes.Count - 1)] } else { 0 }
    $sinceLast = if ($recent.Count) { ($now - [datetime]$recent[-1]).TotalMinutes } else { [double]::MaxValue }
    if ($recent.Count -ge $MaxRestartsPerDay) {
        Write-Log "  not restarting: already $($recent.Count) restarts in 24 h; needs a human (see the server log in $LogDir)"
    } elseif ($sinceLast -lt $wait) {
        Write-Log ("  not restarting yet: backoff {0} min, last restart {1:N0} min ago" -f $wait, $sinceLast)
    } else {
        Write-Log "  restarting $Service (restart $($recent.Count + 1) in 24 h)"
        if ($DryRun) { Write-Log '  (dry run: not restarting)' } else {
            try { Restart-CullingService } catch { Write-Log "  restart failed: $($_.Exception.Message)" }
        }
        $recent += $now.ToString('o')
        $state.backoff = [int]$state.backoff + 1
        $state.failures = 0
    }
    $state.restarts = $recent
}
Save-State $state
