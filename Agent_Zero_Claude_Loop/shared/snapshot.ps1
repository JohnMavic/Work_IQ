<#
.SYNOPSIS
    tasks.json Snapshot Mechanism for Agent Zero Optimization

.DESCRIPTION
    Creates, restores, and verifies backups of the tasks.json file
    using a triple backup strategy (ORIGINAL + BACKUP + hash file).
    Ensures test runs never corrupt production data.

.PARAMETER Command
    Action to perform: backup, restore, verify

.EXAMPLE
    .\snapshot.ps1 backup    # Create snapshot before testing
    .\snapshot.ps1 verify    # Check if tasks.json is unchanged
    .\snapshot.ps1 restore   # Restore original after testing
#>

param(
    [Parameter(Mandatory = $true, Position = 0)]
    [ValidateSet("backup", "restore", "verify")]
    [string]$Command
)

# ─── Configuration ────────────────────────────────────────────────────────────

$AgentZeroPath   = "E:\Work_IQ\Agent_Zero"
$TasksFile       = Join-Path $AgentZeroPath "tasks.json"
$BackupFile      = Join-Path $AgentZeroPath "tasks.test.json"
$HashFile        = Join-Path $AgentZeroPath "tasks.hash"
$OriginalBackup  = Join-Path $AgentZeroPath "tasks.ORIGINAL.json"

# ─── Helper Functions ─────────────────────────────────────────────────────────

function Get-FileHash256 {
    <#
    .SYNOPSIS
        Compute SHA256 hash of a file.
    #>
    param([string]$FilePath)

    if (-not (Test-Path $FilePath)) {
        throw "File not found: $FilePath"
    }
    $hash = Get-FileHash -Path $FilePath -Algorithm SHA256
    return $hash.Hash
}

function Write-Status {
    <#
    .SYNOPSIS
        Print a formatted status message.
    #>
    param(
        [string]$Icon,
        [string]$Message,
        [string]$Color = "White"
    )
    Write-Host "  $Icon " -NoNewline -ForegroundColor $Color
    Write-Host $Message
}

function Assert-TasksFileExists {
    <#
    .SYNOPSIS
        Verify tasks.json exists before operations.
    #>
    if (-not (Test-Path $TasksFile)) {
        Write-Status "✗" "tasks.json not found at: $TasksFile" "Red"
        Write-Status " " "Ensure Agent Zero is set up at: $AgentZeroPath" "DarkGray"
        exit 1
    }
}

# ─── Backup Command ──────────────────────────────────────────────────────────

function Invoke-Backup {
    <#
    .SYNOPSIS
        Create triple backup: ORIGINAL copy + test copy + SHA256 hash.
    #>
    Assert-TasksFileExists

    Write-Host ""
    Write-Host "  ━━━ Snapshot Backup ━━━" -ForegroundColor Cyan
    Write-Host ""

    # 1. Compute hash of current tasks.json
    $currentHash = Get-FileHash256 -FilePath $TasksFile
    Write-Status "🔑" "SHA256: $($currentHash.Substring(0, 16))..." "DarkGray"

    # 2. Create ORIGINAL backup (only if it doesn't exist or differs)
    if (Test-Path $OriginalBackup) {
        $origHash = Get-FileHash256 -FilePath $OriginalBackup
        if ($origHash -ne $currentHash) {
            Write-Status "⚠" "ORIGINAL backup exists but differs — overwriting" "Yellow"
            Copy-Item -Path $TasksFile -Destination $OriginalBackup -Force
        } else {
            Write-Status "✓" "ORIGINAL backup already matches" "Green"
        }
    } else {
        Copy-Item -Path $TasksFile -Destination $OriginalBackup -Force
        Write-Status "✓" "Created ORIGINAL backup: tasks.ORIGINAL.json" "Green"
    }

    # 3. Create test backup copy
    Copy-Item -Path $TasksFile -Destination $BackupFile -Force
    Write-Status "✓" "Created test backup: tasks.test.json" "Green"

    # 4. Store hash for verification
    $hashContent = @{
        hash      = $currentHash
        timestamp = (Get-Date -Format "yyyy-MM-ddTHH:mm:ssZ")
        fileSize  = (Get-Item $TasksFile).Length
        source    = "tasks.json"
    } | ConvertTo-Json
    Set-Content -Path $HashFile -Value $hashContent -Encoding UTF8
    Write-Status "✓" "Stored hash reference: tasks.hash" "Green"

    # Summary
    $fileSize = [math]::Round((Get-Item $TasksFile).Length / 1024, 1)
    Write-Host ""
    Write-Status "📦" "Backup complete ($($fileSize) KB)" "Cyan"
    Write-Host ""
}

# ─── Restore Command ─────────────────────────────────────────────────────────

function Invoke-Restore {
    <#
    .SYNOPSIS
        Restore tasks.json from backup, with hash verification.
    #>
    Write-Host ""
    Write-Host "  ━━━ Snapshot Restore ━━━" -ForegroundColor Cyan
    Write-Host ""

    # Determine best backup source (prefer ORIGINAL, fallback to test backup)
    $restoreSource = $null

    if (Test-Path $OriginalBackup) {
        $restoreSource = $OriginalBackup
        Write-Status "▸" "Using ORIGINAL backup: tasks.ORIGINAL.json" "White"
    } elseif (Test-Path $BackupFile) {
        $restoreSource = $BackupFile
        Write-Status "▸" "Using test backup: tasks.test.json" "Yellow"
        Write-Status "⚠" "ORIGINAL backup not found — using secondary backup" "Yellow"
    } else {
        Write-Status "✗" "No backup files found!" "Red"
        Write-Status " " "Run 'snapshot.ps1 backup' first." "DarkGray"
        exit 1
    }

    # Verify backup integrity against stored hash (if hash file exists)
    if (Test-Path $HashFile) {
        try {
            $hashData = Get-Content -Path $HashFile -Raw | ConvertFrom-Json
            $backupHash = Get-FileHash256 -FilePath $restoreSource

            if ($backupHash -eq $hashData.hash) {
                Write-Status "✓" "Backup integrity verified (SHA256 match)" "Green"
            } else {
                Write-Status "⚠" "Backup hash does NOT match stored hash!" "Yellow"
                Write-Status " " "Stored:  $($hashData.hash.Substring(0, 16))..." "DarkGray"
                Write-Status " " "Backup:  $($backupHash.Substring(0, 16))..." "DarkGray"
                Write-Status " " "Proceeding with restore anyway..." "Yellow"
            }
        } catch {
            Write-Status "⚠" "Could not verify hash: $_" "Yellow"
        }
    } else {
        Write-Status "⚠" "No hash file found — restoring without verification" "Yellow"
    }

    # Perform the restore
    Copy-Item -Path $restoreSource -Destination $TasksFile -Force
    Write-Status "✓" "Restored tasks.json from backup" "Green"

    # Verify the restored file
    $restoredHash = Get-FileHash256 -FilePath $TasksFile
    $sourceHash = Get-FileHash256 -FilePath $restoreSource
    if ($restoredHash -eq $sourceHash) {
        Write-Status "✓" "Post-restore verification passed" "Green"
    } else {
        Write-Status "✗" "Post-restore verification FAILED!" "Red"
        exit 1
    }

    # Cleanup — remove test backup and hash file (keep ORIGINAL)
    if (Test-Path $BackupFile)  { Remove-Item -Path $BackupFile -Force }
    if (Test-Path $HashFile)    { Remove-Item -Path $HashFile -Force }
    Write-Status "🧹" "Cleaned up temporary backup files" "DarkGray"

    Write-Host ""
    Write-Status "✓" "Restore complete" "Cyan"
    Write-Host ""
}

# ─── Verify Command ──────────────────────────────────────────────────────────

function Invoke-Verify {
    <#
    .SYNOPSIS
        Check if current tasks.json matches the stored backup hash.
    #>
    Assert-TasksFileExists

    Write-Host ""
    Write-Host "  ━━━ Snapshot Verify ━━━" -ForegroundColor Cyan
    Write-Host ""

    if (-not (Test-Path $HashFile)) {
        Write-Status "✗" "No hash file found. Run 'snapshot.ps1 backup' first." "Red"
        exit 1
    }

    # Load stored hash data
    $hashData = Get-Content -Path $HashFile -Raw | ConvertFrom-Json
    $currentHash = Get-FileHash256 -FilePath $TasksFile
    $currentSize = (Get-Item $TasksFile).Length

    Write-Status "📋" "Backup taken: $($hashData.timestamp)" "DarkGray"
    Write-Status "📋" "Original size: $($hashData.fileSize) bytes" "DarkGray"
    Write-Status "📋" "Current size:  $currentSize bytes" "DarkGray"
    Write-Host ""

    if ($currentHash -eq $hashData.hash) {
        Write-Status "✓" "tasks.json is UNCHANGED (hash match)" "Green"
        Write-Host ""
        exit 0
    } else {
        Write-Status "✗" "tasks.json has been MODIFIED!" "Red"
        Write-Status " " "Expected: $($hashData.hash.Substring(0, 16))..." "DarkGray"
        Write-Status " " "Current:  $($currentHash.Substring(0, 16))..." "DarkGray"
        Write-Host ""
        Write-Status "💡" "Run 'snapshot.ps1 restore' to revert changes." "Yellow"
        Write-Host ""
        exit 1
    }
}

# ─── Main Dispatch ────────────────────────────────────────────────────────────

switch ($Command) {
    "backup"  { Invoke-Backup }
    "restore" { Invoke-Restore }
    "verify"  { Invoke-Verify }
}
