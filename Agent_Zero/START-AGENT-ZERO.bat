@echo off
setlocal EnableDelayedExpansion

:: ============================================================
:: Agent Zero - Smart Server Startup (v4.1.0)
::
:: Goal: ALWAYS end up with EXACTLY ONE clean Agent Zero process.
:: NEVER touches node processes from other projects.
::
:: Logic:
::   1. If a healthy Agent Zero on ports 3000-3020 already serves
::      THIS install (matched via /api/health repoPath) -> open
::      browser, exit. Reuse the running instance.
::   2. Otherwise -> call stop-agent-zero.ps1 (path-restricted
::      kill of stale Agent Zero only) -> start fresh server.
::
:: Identification is path-based (CommandLine contains this dir),
:: never pattern-based (no 'copilot|@github|workiq' regex).
:: ============================================================

set PREFERRED_PORT=3000
set SERVER_DIR=%~dp0
:: Strip trailing backslash for matching
if "%SERVER_DIR:~-1%"=="\" set SERVER_DIR=%SERVER_DIR:~0,-1%

:: --- Step 1: Detect a healthy Agent Zero serving THIS install ---
set "EXISTING_PORT="
for /f "usebackq delims=" %%P in (`powershell -NoProfile -Command "$dir = '%SERVER_DIR%'.TrimEnd('\','/'); foreach ($p in 3000..3020) { try { $r = Invoke-RestMethod -Uri ('http://127.0.0.1:' + $p + '/api/health') -TimeoutSec 1 -EA Stop; if ($r.service -eq 'agent-zero') { $repo = ''; if ($r.repoPath) { $repo = $r.repoPath.TrimEnd('\','/') }; if (-not $repo -or $repo -ieq $dir) { Write-Output $p; break } } } catch {} }"`) do set "EXISTING_PORT=%%P"

if defined EXISTING_PORT (
    echo [STARTUP] Agent Zero already running on port !EXISTING_PORT! ^(matched this install^).
    echo [STARTUP] Opening browser, no restart needed.
    start "" http://localhost:!EXISTING_PORT!
    exit /b 0
)

:: --- Step 2: No healthy instance for THIS install -> safe shutdown of any stale stuff ---
echo [STARTUP] No healthy Agent Zero detected. Running safe shutdown of any stale processes...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-agent-zero.ps1" "%SERVER_DIR%"

:: --- Step 3: Pick a free port (preferred 3000, fallback 3001-3020) ---
set PORT=%PREFERRED_PORT%
netstat -ano | findstr ":%PREFERRED_PORT% " | findstr "LISTENING" >nul 2>&1
if !errorlevel!==0 (
    echo [STARTUP] Port %PREFERRED_PORT% still occupied by a non-Agent-Zero process. Picking alternative...
    set PORT=0
    for /L %%i in (3001,1,3020) do (
        if !PORT!==0 (
            netstat -ano | findstr ":%%i " | findstr "LISTENING" >nul 2>&1
            if !errorlevel! NEQ 0 set PORT=%%i
        )
    )
    if !PORT!==0 (
        echo [STARTUP] ERROR: No free port found in range 3000-3020.
        pause
        exit /b 1
    )
)

:: --- Step 4: Start fresh server ---
echo [STARTUP] Starting Agent Zero on port !PORT!...
cd /d %~dp0
start "AgentZero" /min cmd /c "set PORT=!PORT!&& node server.js"

:: --- Step 5: Wait for healthy /api/health ---
echo [STARTUP] Waiting for server to become healthy...
set RETRIES=0
:health_loop
if !RETRIES! GEQ 20 (
    echo [STARTUP] ERROR: Server did not become healthy after ~20 seconds.
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
