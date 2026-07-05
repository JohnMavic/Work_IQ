# =============================================================================
# Agent Zero - Safe Shutdown (v4.1.0)
# =============================================================================
# Identifies and terminates ONLY Agent Zero processes belonging to THIS
# installation directory. Will never touch:
#   - node processes from other projects (e.g. Copilot CLI's @playwright/mcp)
#   - workiq/copilot subprocesses spawned by other tools (e.g. Copilot CLI)
#   - any process whose cmdline does not literally contain THIS repo path
#
# Identification strategy (in order of trust):
#   A. /api/health on ports 3000-3020 returns {service:"agent-zero", pid, repoPath}
#      -> only kill if repoPath matches this script's directory
#   B. .agent-zero.lock contains pid + port written by THIS server.js
#      -> kill PID via taskkill /T /F (kills tree, including WIQ child)
#   C. Path-restricted sweep: any node.exe whose cmdline literally contains
#      "<ServerDir>" -> Stop-Process. Catches orphaned WIQ children whose
#      parent server.js died.
#
# A taskkill /T /F on the server.js PID kills its entire process tree, so
# WIQ children and SDK subprocesses are usually cleaned up automatically.
# Phase C is a safety net for true orphans (parent already gone).
# =============================================================================

param([string]$ServerDir)

if (-not $ServerDir) { $ServerDir = $PSScriptRoot }
$ServerDir = (Resolve-Path $ServerDir).Path.TrimEnd('\', '/')
$ServerDirEscaped = [regex]::Escape($ServerDir)

Write-Host ""
Write-Host "  ============================================"
Write-Host "   Agent Zero - Safe Shutdown (v4.1.0)"
Write-Host "   Target: $ServerDir"
Write-Host "  ============================================"
Write-Host ""

$killedPids = New-Object System.Collections.Generic.HashSet[int]
$serverKills = 0
$orphanKills = 0

function Stop-Tree {
    param([int]$TargetPid, [string]$Label)
    if ($killedPids.Contains($TargetPid)) { return }
    $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if (-not $proc) { return }
    Write-Host "[STOP] Terminating ${Label} (PID $TargetPid) and its child tree..."
    & taskkill /PID $TargetPid /T 2>$null | Out-Null
    $waited = 0
    while ($waited -lt 6 -and (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue)) {
        Start-Sleep -Milliseconds 500; $waited++
    }
    if (Get-Process -Id $TargetPid -ErrorAction SilentlyContinue) {
        Write-Host "[STOP]   Forcing termination of PID $TargetPid..."
        & taskkill /PID $TargetPid /T /F 2>$null | Out-Null
        Start-Sleep -Seconds 1
    }
    $killedPids.Add($TargetPid) | Out-Null
}

# -----------------------------------------------------------------------------
# Phase A: Find via /api/health on ports 3000-3020
# -----------------------------------------------------------------------------
Write-Host "[STOP] Phase A: Probing /api/health on ports 3000-3020..."
foreach ($port in 3000..3020) {
    try {
        $r = Invoke-RestMethod -Uri "http://127.0.0.1:$port/api/health" -TimeoutSec 1 -ErrorAction Stop
        if ($r.service -eq 'agent-zero' -and $r.pid) {
            $repo = if ($r.repoPath) { $r.repoPath.TrimEnd('\','/') } else { '' }
            # Only kill if repoPath matches this directory (or if repoPath missing - older versions)
            $isOurs = (-not $repo) -or ($repo -ieq $ServerDir)
            if ($isOurs) {
                Write-Host "[STOP]   Port $port -> Agent Zero PID $($r.pid) (repoPath=$repo)"
                Stop-Tree -TargetPid ([int]$r.pid) -Label "server.js on port $port"
                $serverKills++
            } else {
                Write-Host "[STOP]   Port $port -> Agent Zero from a DIFFERENT install ($repo) - leaving alone"
            }
        }
    } catch {
        # not responding or not Agent Zero - skip silently
    }
}

# -----------------------------------------------------------------------------
# Phase B: Lockfile fallback
# -----------------------------------------------------------------------------
Write-Host "[STOP] Phase B: Checking .agent-zero.lock..."
$lockFile = Join-Path $ServerDir ".agent-zero.lock"
if (Test-Path $lockFile) {
    try {
        $lock = Get-Content -Raw $lockFile | ConvertFrom-Json
        if ($lock.pid) {
            $lockPid = [int]$lock.pid
            $proc = Get-Process -Id $lockPid -ErrorAction SilentlyContinue
            if ($proc -and $proc.ProcessName -eq 'node') {
                # Confirm via WMI cmdline that it's a server.js process (defensive)
                $cim = Get-CimInstance Win32_Process -Filter "ProcessId=$lockPid" -ErrorAction SilentlyContinue
                if ($cim -and $cim.CommandLine -match 'server\.js') {
                    Write-Host "[STOP]   Lockfile -> server.js PID $lockPid"
                    Stop-Tree -TargetPid $lockPid -Label "server.js (from lockfile)"
                    $serverKills++
                }
            }
        }
    } catch {
        Write-Host "[STOP]   Lockfile unreadable - ignoring."
    }
    # Always clean up the lockfile so a fresh start is unblocked
    try { Remove-Item $lockFile -Force -ErrorAction SilentlyContinue } catch {}
    Write-Host "[STOP]   Lockfile removed."
}

# -----------------------------------------------------------------------------
# Phase C: Path-restricted orphan sweep
# Only matches node processes whose CommandLine literally contains $ServerDir.
# Will never match @playwright/mcp, Copilot CLI MCPs, or any other project.
# -----------------------------------------------------------------------------
Write-Host "[STOP] Phase C: Path-restricted orphan sweep..."
$orphans = @(Get-CimInstance Win32_Process -Filter "name='node.exe'" -ErrorAction SilentlyContinue |
    Where-Object {
        $_.CommandLine -and
        ($_.CommandLine -match $ServerDirEscaped) -and
        (-not $killedPids.Contains([int]$_.ProcessId))
    })

if ($orphans.Count -eq 0) {
    Write-Host "[STOP]   No path-matched orphans found."
} else {
    foreach ($p in $orphans) {
        $oPid = [int]$p.ProcessId
        Write-Host "[STOP]   Orphan PID $oPid -> $($p.CommandLine)"
        try {
            Stop-Process -Id $oPid -Force -ErrorAction Stop
            $killedPids.Add($oPid) | Out-Null
            $orphanKills++
        } catch {
            Write-Host "[STOP]     Could not stop PID ${oPid}: $($_.Exception.Message)"
        }
    }
}

# -----------------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------------
Write-Host ""
Write-Host "  ============================================"
Write-Host "   Stopped:  $serverKills server.js  +  $orphanKills orphan(s)"
Write-Host "  ============================================"
Write-Host ""

# Exit 0 even if nothing was running (idempotent)
exit 0
