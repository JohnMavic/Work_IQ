param([string]$ServerDir)
if (-not $ServerDir) { $ServerDir = $PSScriptRoot }
$ServerDir = (Resolve-Path $ServerDir).Path.TrimEnd('\','/')

$all = Get-CimInstance Win32_Process -Filter "name='node.exe'"
Write-Host ""
Write-Host "================================================================"
Write-Host "  Total node.exe processes on system: $($all.Count)"
Write-Host "================================================================"
Write-Host ""

$az_server = @($all | Where-Object {
    ($_.CommandLine -match 'server\.js') -and ($_.CommandLine -notmatch 'playwright')
})
$az_wiq = @($all | Where-Object {
    $_.CommandLine -match [regex]::Escape("$ServerDir\node_modules\@microsoft\workiq")
})
$az_sdk = @($all | Where-Object {
    ($_.CommandLine -match [regex]::Escape($ServerDir)) -and
    ($_.CommandLine -notmatch 'workiq') -and
    ($_.CommandLine -notmatch 'server\.js')
})
$pw = @($all | Where-Object { $_.CommandLine -match 'playwright' })
$copilot_cli = @($all | Where-Object {
    ($_.CommandLine -match 'copilot') -and
    ($_.CommandLine -notmatch [regex]::Escape($ServerDir))
})
$other = @($all | Where-Object {
    -not ($_.CommandLine -match [regex]::Escape($ServerDir)) -and
    -not ($_.CommandLine -match 'server\.js' -and $_.CommandLine -notmatch 'playwright') -and
    -not ($_.CommandLine -match 'playwright') -and
    -not ($_.CommandLine -match 'copilot')
})

Write-Host "  AGENT ZERO server.js   : $($az_server.Count)"
foreach ($p in $az_server) {
    Write-Host "      PID $($p.ProcessId)  parent=$($p.ParentProcessId)"
}
Write-Host "  AGENT ZERO WIQ child   : $($az_wiq.Count)"
foreach ($p in $az_wiq) {
    Write-Host "      PID $($p.ProcessId)  parent=$($p.ParentProcessId)"
}
Write-Host "  AGENT ZERO SDK child   : $($az_sdk.Count)  (transient during scans, OK)"
Write-Host ""
Write-Host "  Copilot CLI Playwright : $($pw.Count)  (NOT Agent Zero - leave alone)"
Write-Host "  Copilot CLI other      : $($copilot_cli.Count)  (NOT Agent Zero - leave alone)"
Write-Host "  Other unrelated node   : $($other.Count)"
Write-Host ""
Write-Host "================================================================"

$h = $null
try { $h = Invoke-RestMethod 'http://localhost:3000/api/health' -TimeoutSec 2 } catch {}
if ($h -and $h.service -eq 'agent-zero') {
    $uptimeH = [math]::Round($h.uptime / 3600, 1)
    Write-Host "  /api/health on port 3000:"
    Write-Host "    pid=$($h.pid)  wiqPid=$($h.wiqPid)  port=$($h.port)"
    Write-Host "    version=$($h.version)  engine=$($h.scanEngine)  uptime=${uptimeH}h"
    Write-Host "    repoPath=$($h.repoPath)"
    if ($az_server.Count -eq 1 -and $az_wiq.Count -le 1) {
        Write-Host "  STATUS: HEALTHY - exactly 1 Agent Zero instance." -ForegroundColor Green
    } else {
        Write-Host "  STATUS: WARNING - found $($az_server.Count) server.js + $($az_wiq.Count) WIQ children." -ForegroundColor Yellow
        Write-Host "  Run STOP-AGENT-ZERO.bat then START-AGENT-ZERO.bat to clean up." -ForegroundColor Yellow
    }
} else {
    Write-Host "  /api/health on port 3000: NO RESPONSE - Agent Zero is not running." -ForegroundColor Yellow
}
Write-Host "================================================================"
Write-Host ""
