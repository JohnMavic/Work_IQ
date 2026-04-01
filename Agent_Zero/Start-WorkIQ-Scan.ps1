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

function Stop-ZombieProcesses {
    # Kill any node process listening on port 3000
    $listeners = netstat -ano | Select-String ":3000 " | Select-String "LISTENING"
    foreach ($line in $listeners) {
        $pid = ($line -split '\s+')[-1]
        if ($pid -and $pid -ne '0') {
            Write-Log "  Killing zombie on port 3000: PID $pid"
            try { Stop-Process -Id ([int]$pid) -Force -ErrorAction Stop } catch {}
        }
    }
    
    # Kill orphaned Copilot SDK subprocesses
    Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -match 'copilot|@github|workiq.*mcp' } |
        ForEach-Object {
            Write-Log "  Killing orphan SDK process: PID $($_.ProcessId)"
            try { Stop-Process -Id $_.ProcessId -Force -ErrorAction Stop } catch {}
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

# Step 1: Check if server is healthy
$health = Test-ServerHealth
if ($health) {
    Write-Log "Server is HEALTHY (PID: $($health.pid), uptime: $($health.uptime)s, sessions: $($health.activeSessions))"
} else {
    Write-Log "Server not responding. Cleaning up and starting fresh..."
    Stop-ZombieProcesses
    Start-AgentZeroServer
    
    # Wait for server to become healthy (max 30 seconds)
    $serverHealthy = $false
    for ($i = 1; $i -le 15; $i++) {
        Start-Sleep 2
        $health = Test-ServerHealth
        if ($health) {
            Write-Log "Server started successfully (PID: $($health.pid), attempt $i)"
            $serverHealthy = $true
            break
        }
        Write-Log "  Waiting... (attempt $i/15)"
    }
    
    if (-not $serverHealthy) {
        Write-Log "ERROR: Server failed to start within 30 seconds!"
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

# Step 3: Run the scan via API
Write-Log "--- Phase 1: Discovery (scanning last $ScanDays days) ---"
try {
    $scanStart = Get-Date
    $scanResult = Invoke-RestMethod -Uri "$ServerUrl/api/scan" -Method POST `
        -ContentType "application/json" `
        -Body "{`"days`": $ScanDays}" `
        -TimeoutSec 300
    $scanDuration = [math]::Round(((Get-Date) - $scanStart).TotalSeconds, 1)
    
    Write-Log "Phase 1 complete in ${scanDuration}s: added=$($scanResult.added), updated=$($scanResult.updated), skipped=$($scanResult.skipped), total=$($scanResult.total)"
    
    # Enrich new tasks if any were added
    if ($scanResult.newTaskIds -and $scanResult.newTaskIds.Count -gt 0) {
        Write-Log "--- Phase 2: Enriching $($scanResult.newTaskIds.Count) new task(s) ---"
        foreach ($taskId in $scanResult.newTaskIds) {
            try {
                $enrichStart = Get-Date
                $enrichResult = Invoke-RestMethod -Uri "$ServerUrl/api/tasks/$taskId/enrich" -Method POST `
                    -ContentType "application/json" -TimeoutSec 300
                $enrichDuration = [math]::Round(((Get-Date) - $enrichStart).TotalSeconds, 1)
                Write-Log "  Enriched $taskId in ${enrichDuration}s: status=$($enrichResult.enrichmentStatus)"
            } catch {
                Write-Log "  ERROR enriching ${taskId}: $_"
            }
        }
    }
    
    # Phase 3: Update check on existing enriched tasks
    Write-Log "--- Phase 3: Update checks ---"
    try {
        $tasks = Invoke-RestMethod -Uri "$ServerUrl/api/tasks" -TimeoutSec 30
        $checkable = $tasks | Where-Object { 
            ($_.enrichmentStatus -eq 'enriched' -or $_.enrichmentStatus -eq 'needs-review') -and 
            $_.status -ne 'done' 
        } | Select-Object -First 10
        
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
        Write-Log "  ERROR fetching tasks for update check: $_"
    }
    
    # Phase 4: Consolidation
    Write-Log "--- Phase 4: Consolidation ---"
    try {
        $consResult = Invoke-RestMethod -Uri "$ServerUrl/api/consolidate" -Method POST `
            -ContentType "application/json" -TimeoutSec 60
        Write-Log "Consolidation complete: $($consResult | ConvertTo-Json -Compress)"
    } catch {
        Write-Log "  ERROR during consolidation: $_"
    }
    
} catch {
    $scanDuration = [math]::Round(((Get-Date) - $scanStart).TotalSeconds, 1)
    Write-Log "ERROR Phase 1 failed after ${scanDuration}s: $_"
    Write-Log "=== Aborted ==="
    exit 1
}

Write-Log "=== All phases complete ==="
