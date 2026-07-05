# ============================================================
# Agent Zero — Automated Scan Script
# Called by Windows Task Scheduler (07:00, 11:00 daily)
# Self-contained: manages server lifecycle + runs all 4 phases via API
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

# Step 2: Run Phase 1 — Scan
Write-Log "--- Phase 1: Discovery (scanning last $ScanDays days) ---"
try {
    $scanStart = Get-Date
    $scanResult = Invoke-RestMethod -Uri "$ServerUrl/api/scan" -Method POST `
        -ContentType "application/json" `
        -Body "{`"days`": $ScanDays}" `
        -TimeoutSec 300
    $scanDuration = [math]::Round(((Get-Date) - $scanStart).TotalSeconds, 1)
    Write-Log "Phase 1 complete in ${scanDuration}s: added=$($scanResult.added), updated=$($scanResult.updated), skipped=$($scanResult.skipped), total=$($scanResult.total)"
} catch {
    Write-Log "ERROR Phase 1 failed: $_"
    Write-Log "=== Aborted ==="
    exit 1
}

# Step 3: Run Phase 2 — Enrich new tasks
if ($scanResult.newTaskIds -and $scanResult.newTaskIds.Count -gt 0) {
    Write-Log "--- Phase 2: Enriching $($scanResult.newTaskIds.Count) new task(s) ---"
    foreach ($taskId in $scanResult.newTaskIds) {
        try {
            $enrichStart = Get-Date
            $enrichResult = Invoke-RestMethod -Uri "$ServerUrl/api/tasks/$taskId/enrich" -Method POST `
                -ContentType "application/json" -TimeoutSec 300
            $enrichDuration = [math]::Round(((Get-Date) - $enrichStart).TotalSeconds, 1)
            Write-Log "  Enriched $($taskId.Substring(0,8))... in ${enrichDuration}s: status=$($enrichResult.enrichmentStatus)"
        } catch {
            Write-Log "  ERROR enriching $($taskId.Substring(0,8))...: $_"
        }
    }
} else {
    Write-Log "--- Phase 2: No new tasks to enrich ---"
}

# Step 4: Run Phase 3 — Update checks on existing enriched tasks
Write-Log "--- Phase 3: Update checks ---"
try {
    $tasks = Invoke-RestMethod -Uri "$ServerUrl/api/tasks" -TimeoutSec 30
    $checkable = @($tasks | Where-Object { 
        ($_.enrichmentStatus -eq 'enriched' -or $_.enrichmentStatus -eq 'needs-review') -and 
        $_.status -ne 'done' 
    } | Select-Object -First 10)
    
    Write-Log "  Checking $($checkable.Count) task(s) for updates..."
    foreach ($task in $checkable) {
        try {
            $checkStart = Get-Date
            $checkResult = Invoke-RestMethod -Uri "$ServerUrl/api/tasks/$($task.id)/check-update" -Method POST `
                -ContentType "application/json" -TimeoutSec 300
            $checkDuration = [math]::Round(((Get-Date) - $checkStart).TotalSeconds, 1)
            $hasUpdate = if ($checkResult.hasUpdate) { "NEW UPDATE" } else { "no change" }
            Write-Log "  Checked $($task.id.Substring(0,8))... in ${checkDuration}s: $hasUpdate"
        } catch {
            Write-Log "  ERROR checking $($task.id.Substring(0,8))...: $_"
        }
    }
} catch {
    Write-Log "  ERROR fetching tasks: $_"
}

# Step 5: Run Phase 4 — Consolidation
Write-Log "--- Phase 4: Consolidation ---"
try {
    $consResult = Invoke-RestMethod -Uri "$ServerUrl/api/consolidate" -Method POST `
        -ContentType "application/json" -TimeoutSec 60
    Write-Log "Consolidation complete."
} catch {
    Write-Log "  ERROR during consolidation: $_"
}

Write-Log "=== All phases complete ==="
