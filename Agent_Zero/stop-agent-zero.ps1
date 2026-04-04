# Agent Zero — Safe Shutdown Script
# Called by STOP-AGENT-ZERO.bat
# Identifies and terminates ONLY Agent Zero processes. Never kills other apps.

param([string]$ServerDir)

Write-Host ""
Write-Host "  ============================================"
Write-Host "   Agent Zero - Safe Shutdown"
Write-Host "  ============================================"
Write-Host ""

$found = 0
$killed = 0
$killedPids = @()

# -------------------------------------------------------
# Phase 1: Find Agent Zero via health endpoints (ports 3000-3020)
# Only Agent Zero responds with {"status":"ok","pid":...}
# -------------------------------------------------------
Write-Host "[STOP] Scanning ports 3000-3020 for Agent Zero instances..."

foreach ($port in 3000..3020) {
    try {
        $response = Invoke-RestMethod -Uri "http://localhost:$port/api/health" -TimeoutSec 1 -ErrorAction Stop
        if ($response.pid -and $response.status -eq "ok") {
            $azPid = [int]$response.pid
            # Verify this PID is actually a node.exe process
            $proc = Get-Process -Id $azPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -eq "node") {
                $found++
                Write-Host "[STOP] Found Agent Zero on port $port (PID $azPid)"
                Write-Host "[STOP]   Sending graceful shutdown..."
                
                # Graceful: taskkill without /F triggers shutdown handler
                & taskkill /PID $azPid /T 2>$null | Out-Null
                
                # Wait up to 8 seconds for graceful exit
                $waited = 0
                while ($waited -lt 8) {
                    Start-Sleep -Seconds 1
                    $waited++
                    $stillRunning = Get-Process -Id $azPid -ErrorAction SilentlyContinue
                    if (-not $stillRunning) { break }
                }
                
                if (Get-Process -Id $azPid -ErrorAction SilentlyContinue) {
                    Write-Host "[STOP]   Still running - forcing termination..."
                    & taskkill /PID $azPid /T /F 2>$null | Out-Null
                    Start-Sleep -Seconds 2
                }
                
                $killedPids += $azPid
                $killed++
                Write-Host "[STOP]   Terminated."
            } else {
                Write-Host "[STOP] Port $port responds to health but PID $azPid is not node.exe - skipping."
            }
        }
    } catch {
        # Port not responding or not Agent Zero — skip silently
    }
}

# -------------------------------------------------------
# Phase 2: Find zombie Agent Zero processes (not responding to health)
# Matches: node.exe whose command line contains server.js from our directory
# -------------------------------------------------------
Write-Host ""
Write-Host "[STOP] Checking for zombie Agent Zero processes..."

$serverDirNorm = $ServerDir.TrimEnd('\', '/').Replace('\', '\\')
$nodeProcs = Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue

foreach ($proc in $nodeProcs) {
    if (-not $proc.CommandLine) { continue }
    # Match: command line contains "server.js" AND is from our directory
    $isServerJs = $proc.CommandLine -match 'server\.js'
    $isOurDir = $proc.CommandLine -match [regex]::Escape($ServerDir.TrimEnd('\', '/'))
    # Also match if CWD-launched (just "node server.js" without full path)
    # by checking the process's parent or if it was started from our dir
    $isSimpleStart = $proc.CommandLine -match '^\s*"?node("?\s+|\.exe"?\s+)server\.js'
    
    if ($isServerJs -and ($isOurDir -or $isSimpleStart)) {
        $zombiePid = $proc.ProcessId
        # Skip if already killed in Phase 1
        if ($killedPids -contains $zombiePid) { continue }
        # Verify still running
        if (-not (Get-Process -Id $zombiePid -ErrorAction SilentlyContinue)) { continue }
        
        $found++
        Write-Host "[STOP] Found zombie Agent Zero process (PID $zombiePid)"
        Write-Host "[STOP]   Terminating..."
        & taskkill /PID $zombiePid /T 2>$null | Out-Null
        Start-Sleep -Seconds 3
        if (Get-Process -Id $zombiePid -ErrorAction SilentlyContinue) {
            & taskkill /PID $zombiePid /T /F 2>$null | Out-Null
            Start-Sleep -Seconds 2
        }
        $killedPids += $zombiePid
        $killed++
        Write-Host "[STOP]   Terminated."
    }
}

# -------------------------------------------------------
# Phase 3: Clean up orphaned Copilot SDK subprocesses
# These are child processes spawned by Agent Zero for the Copilot SDK.
# -------------------------------------------------------
Write-Host ""
Write-Host "[STOP] Cleaning up Copilot SDK subprocesses..."

$sdkKilled = 0
$sdkProcs = Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match 'copilot|@github|workiq.*mcp' }

foreach ($proc in $sdkProcs) {
    $sdkPid = $proc.ProcessId
    if ($killedPids -contains $sdkPid) { continue }
    Write-Host "[STOP]   Killing SDK subprocess (PID $sdkPid)"
    Stop-Process -Id $sdkPid -Force -ErrorAction SilentlyContinue
    $sdkKilled++
}

if ($sdkKilled -eq 0) {
    Write-Host "[STOP]   No SDK subprocesses found."
} else {
    Write-Host "[STOP]   Cleaned up $sdkKilled SDK subprocess(es)."
}

# -------------------------------------------------------
# Summary
# -------------------------------------------------------
Write-Host ""
Write-Host "  ============================================"
if ($found -eq 0) {
    Write-Host "   No Agent Zero instances were running."
} else {
    Write-Host "   Stopped $killed Agent Zero instance(s)."
}
if ($sdkKilled -gt 0) {
    Write-Host "   Cleaned up $sdkKilled SDK subprocess(es)."
}
Write-Host "  ============================================"
Write-Host ""
