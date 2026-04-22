@echo off
setlocal EnableDelayedExpansion

:: ============================================================
:: Agent Zero — Smart Server Startup (v4.0.2)
:: 1. Check lock file (.agent-zero.lock) → if valid & healthy → open browser, exit 0.
:: 2. Scan ports 3000..3020 for Agent-Zero signature → if found → open browser, exit 0.
:: 3. Otherwise start fresh server.
::
:: Safe when triggered by Windows Task Scheduler AND user at the same time:
:: the server itself has a second line of defense (single-instance guard).
:: ============================================================

set PREFERRED_PORT=3000
set PORT=%PREFERRED_PORT%
set SERVER_DIR=%~dp0.
set LOCK_FILE=%SERVER_DIR%\.agent-zero.lock

:: Step 1: Lock-file check (fastest path — handled by PowerShell so we can parse JSON)
set "EXISTING_PORT="
if exist "%LOCK_FILE%" (
    for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "try { $l = Get-Content -Raw '%LOCK_FILE%' | ConvertFrom-Json; if ($l.pid -and $l.port) { $alive = $false; try { Get-Process -Id $l.pid -EA Stop | Out-Null; $alive = $true } catch {}; if ($alive) { try { $r = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $l.port + '/api/health') -TimeoutSec 2; if ($r.service -eq 'agent-zero') { Write-Output $l.port } } catch {} } } } catch {}"`) do set "EXISTING_PORT=%%P"
)
if defined EXISTING_PORT (
    echo [STARTUP] Agent Zero already running on port !EXISTING_PORT! ^(from lock file^). Opening browser...
    start "" http://localhost:!EXISTING_PORT!
    exit /b 0
)

:: Step 2: Port-scan fallback — scan 3000..3020 for agent-zero signature
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "foreach ($p in 3000..3020) { try { $r = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $p + '/api/health') -TimeoutSec 1 -EA Stop; if ($r.service -eq 'agent-zero') { Write-Output $p; break } } catch {} }"`) do set "EXISTING_PORT=%%P"
if defined EXISTING_PORT (
    echo [STARTUP] Agent Zero found on port !EXISTING_PORT! ^(via port scan^). Opening browser...
    start "" http://localhost:!EXISTING_PORT!
    exit /b 0
)

:: Step 3: Clean orphaned SDK subprocesses (safe — only targets Copilot SDK children)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -match 'copilot|@github|workiq.*mcp' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>nul

:: Step 4: Check if preferred port is free
netstat -ano | findstr ":%PREFERRED_PORT% " | findstr "LISTENING" >nul 2>&1
if !errorlevel! NEQ 0 (
    echo [STARTUP] Port %PREFERRED_PORT% is free.
    set PORT=%PREFERRED_PORT%
    goto :start_server
)

:: Port occupied — but we already confirmed it's NOT Agent Zero (step 2 would have matched).
:: Try to reclaim if it's a node.exe running server.js (zombie); otherwise pick alt port.
echo [STARTUP] Port %PREFERRED_PORT% is occupied by a non-Agent-Zero process. Checking if it's a node zombie...
set "ZOMBIE_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PREFERRED_PORT% " ^| findstr "LISTENING"') do (
    if not "%%p"=="0" set "ZOMBIE_PID=%%p"
)
if defined ZOMBIE_PID (
    powershell -NoProfile -Command "$proc = Get-CimInstance Win32_Process -Filter 'ProcessId=%ZOMBIE_PID%' -EA SilentlyContinue; if (-not $proc -or $proc.Name -ne 'node.exe') { exit 1 }; if ($proc.CommandLine -match 'server\.js') { exit 0 } else { exit 1 }" 2>nul
    if !errorlevel!==0 (
        echo [STARTUP] Confirmed: PID %ZOMBIE_PID% is a node server.js zombie. Terminating...
        taskkill /PID %ZOMBIE_PID% /T >nul 2>&1
        ping -n 4 127.0.0.1 >nul
        taskkill /PID %ZOMBIE_PID% /T /F >nul 2>&1
        ping -n 2 127.0.0.1 >nul
        netstat -ano | findstr ":%PREFERRED_PORT% " | findstr "LISTENING" >nul 2>&1
        if !errorlevel! NEQ 0 (
            echo [STARTUP] Port %PREFERRED_PORT% reclaimed.
            set PORT=%PREFERRED_PORT%
            goto :start_server
        )
    ) else (
        echo [STARTUP] PID %ZOMBIE_PID% is NOT an Agent Zero node process — leaving it alone.
    )
)

:: Still occupied — find free port
echo [STARTUP] Finding free alternative port...
set PORT=0
for /L %%i in (3001,1,3020) do (
    if !PORT!==0 (
        netstat -ano | findstr ":%%i " | findstr "LISTENING" >nul 2>&1
        if !errorlevel! NEQ 0 (
            set PORT=%%i
        )
    )
)
if !PORT!==0 (
    echo [STARTUP] ERROR: No free port found in range 3000-3020.
    pause
    exit /b 1
)
echo [STARTUP] Using alternative port !PORT!

:start_server
:: Step 5: Start fresh server with selected port
echo [STARTUP] Starting Agent Zero on port !PORT!...
cd /d %SERVER_DIR%
start "AgentZero" /min cmd /c "set PORT=!PORT!&& node server.js"

:: Step 6: Wait for server to become healthy (max ~15 seconds)
echo [STARTUP] Waiting for server to become healthy...
set RETRIES=0
:health_loop
if !RETRIES! GEQ 15 (
    echo [STARTUP] ERROR: Server did not become healthy after 15 seconds.
    echo [STARTUP] Check the minimized "AgentZero" window for errors.
    pause
    exit /b 1
)
ping -n 2 127.0.0.1 >nul
curl -s -f -o nul --connect-timeout 2 http://localhost:!PORT!/api/health 2>nul
if !errorlevel!==0 (
    echo [STARTUP] Server is healthy on port !PORT!. Opening browser...
    start "" http://localhost:!PORT!
    exit /b 0
)
set /a RETRIES+=1
goto :health_loop
