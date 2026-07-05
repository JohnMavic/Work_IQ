# ============================================================
# Agent Zero — Automated Scan Script
# Called by Windows Task Scheduler (07:00, 11:00 daily)
# Self-contained: manages server lifecycle + starts one scan job via API
# ============================================================

param(
    [int]$ScanDays = 4,
    [string]$ServerUrl = "http://localhost:3000",
    [string]$LogFile = "",
    [string]$ServerDir = ""
)

if (-not $LogFile) { $LogFile = Join-Path $PSScriptRoot "scan-log.txt" }
if (-not $ServerDir) { $ServerDir = $PSScriptRoot }

function Write-Log($msg) {
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    $line = "$timestamp - $msg"
    Write-Host $line
    Add-Content -Path $LogFile -Value $line -ErrorAction SilentlyContinue
}

function Test-ServerHealth {
    try {
        $health = Invoke-RestMethod -Uri "$ServerUrl/api/health" -TimeoutSec 3
        return $health
    } catch {
        return $null
    }
}

function Stop-AgentZeroSafe {
    # v4.1.0: delegate to the shared, path-restricted stop-agent-zero.ps1.
    # NEVER kills node processes that don't literally belong to $ServerDir.
    $stopScript = Join-Path $ServerDir "stop-agent-zero.ps1"
    if (Test-Path $stopScript) {
        Write-Log "  Calling shared stop-agent-zero.ps1 (path-restricted, safe)..."
        try {
            & powershell -NoProfile -ExecutionPolicy Bypass -File $stopScript $ServerDir 2>&1 | ForEach-Object { Write-Log "    $_" }
        } catch {
            Write-Log "  Stop script error: $_"
        }
    } else {
        Write-Log "  WARN: stop-agent-zero.ps1 not found at $stopScript - skipping cleanup."
    }
    Start-Sleep 2
}

function Start-AgentZeroServer {
    Write-Log "Starting Agent Zero server..."
    
    # Start server as a detached process
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = "node"
    $psi.Arguments = "server.js"
    $psi.WorkingDirectory = $ServerDir
    $psi.UseShellExecute = $true
    $psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Minimized
    $psi.CreateNoWindow = $false
    [System.Diagnostics.Process]::Start($psi) | Out-Null
    
    Write-Log "Server process launched."
}

Write-Log "=== Scheduled Work IQ Scan ==="

# v4.1.1 — Step 1: Liveness AND staleness check.
# A long-running server (>24h) is at risk of stale WIQ auth (EULA stub bug).
# A young server with healthy WIQ -> reuse. Otherwise -> kill+restart.
$health = Test-ServerHealth
$STALE_UPTIME_SECONDS = 24 * 60 * 60   # 24h - older than this is suspect
$needRestart = $true
if ($health) {
    $uptimeH = [math]::Round($health.uptime / 3600, 1)
    Write-Log "Server is responding (PID: $($health.pid), uptime: ${uptimeH}h, version: $($health.version), wiqPid: $($health.wiqPid))"
    if ($health.uptime -lt $STALE_UPTIME_SECONDS -and $health.wiqPid) {
        Write-Log "Server is fresh and WIQ is alive - REUSING."
        $needRestart = $false
    } else {
        if ($health.uptime -ge $STALE_UPTIME_SECONDS) {
            Write-Log "Server uptime ${uptimeH}h exceeds ${STALE_UPTIME_SECONDS}s threshold - WIQ auth may be stale. Restarting for clean state."
        } else {
            Write-Log "Server has no live WIQ child - restarting."
        }
    }
} else {
    Write-Log "Server not responding."
}

if ($needRestart) {
    Write-Log "Cleaning up and starting fresh..."
    Stop-AgentZeroSafe
    Start-AgentZeroServer
    
    # Wait for server to become healthy (max 30 seconds)
    $serverHealthy = $false
    for ($i = 1; $i -le 15; $i++) {
        Start-Sleep 2
        $health = Test-ServerHealth
        if ($health -and $health.wiqPid) {
            Write-Log "Server started successfully (PID: $($health.pid), wiqPid: $($health.wiqPid), attempt $i)"
            $serverHealthy = $true
            break
        }
        Write-Log "  Waiting for healthy server with live WIQ... (attempt $i/15)"
    }
    
    if (-not $serverHealthy) {
        Write-Log "ERROR: Server failed to start with healthy WIQ within 30 seconds!"
        Write-Log "=== Aborted ==="
        exit 1
    }
}

# Step 2: Start one server-side scan job and poll until terminal
Write-Log "--- Scan job: scanning last $ScanDays days ---"
try {
    $clientRequestId = "scheduled-scan-$([Guid]::NewGuid().ToString('N'))"
    $body = @{
        kind = "scan"
        input = @{ scanDays = $ScanDays }
        clientRequestId = $clientRequestId
    } | ConvertTo-Json -Depth 5

    $jobStart = Get-Date
    $create = Invoke-RestMethod -Uri "$ServerUrl/api/jobs" -Method POST `
        -ContentType "application/json" `
        -Body $body `
        -TimeoutSec 60

    $jobId = $create.jobId
    if (-not $jobId -and $create.existingJobId) { $jobId = $create.existingJobId }
    if (-not $jobId) { throw "Server did not return a jobId" }
    Write-Log "Scan job started: $jobId"

    $lastPhase = ""
    $terminal = $null
    for ($i = 1; $i -le 360; $i++) {
        Start-Sleep 5
        $snapshot = Invoke-RestMethod -Uri "$ServerUrl/api/jobs/$jobId" -TimeoutSec 30
        $status = $snapshot.status
        $phase = if ($snapshot.progress) { $snapshot.progress.phase } else { "" }
        if ($phase -and $phase -ne $lastPhase) {
            Write-Log "  Phase: $phase"
            $lastPhase = $phase
        }
        if ($status -in @("completed", "failed", "cancelled")) {
            $terminal = $snapshot
            break
        }
    }

    if (-not $terminal) {
        throw "Timed out waiting for scan job $jobId"
    }

    $duration = [math]::Round(((Get-Date) - $jobStart).TotalSeconds, 1)
    if ($terminal.status -eq "completed") {
        $r = $terminal.result
        if ($r -and $r.phase1) {
            Write-Log "Scan job complete in ${duration}s: added=$($r.phase1.added), updated=$($r.phase1.updated), skipped=$($r.phase1.skipped), total=$($r.phase1.total), enriched=$($r.phase2Processed), checked=$($r.phase3Processed)"
        } else {
            Write-Log "Scan job complete in ${duration}s: outcome=$($r.outcome), newProjects=$($r.newProjects), updatedProjects=$($r.updatedProjects), newSingleTasks=$($r.newSingleTasks), workIqCalls=$($r.workIqCalls), premiumRequests=$($r.premiumRequests)"
        }
        Write-Log "=== Scan job complete ==="
    } elseif ($terminal.status -eq "cancelled") {
        Write-Log "Scan job was cancelled after ${duration}s."
        Write-Log "=== Aborted ==="
        exit 1
    } else {
        Write-Log "ERROR scan job failed after ${duration}s: $($terminal.error)"
        Write-Log "=== Aborted ==="
        exit 1
    }
} catch {
    Write-Log "ERROR scan job failed: $_"
    Write-Log "=== Aborted ==="
    exit 1
}
