@echo off
setlocal EnableDelayedExpansion

:: ============================================================
:: Agent Zero — Smart Server Startup
:: 1. If Agent Zero already healthy → open browser, done.
:: 2. If preferred port free → start there.
:: 3. If preferred port occupied by another app → find free port.
:: Always opens browser after successful start.
:: ============================================================

set PREFERRED_PORT=3000
set PORT=%PREFERRED_PORT%
set SERVER_DIR=%~dp0.

:: Step 1: Check if Agent Zero is already running and healthy
curl -s -f -o nul --connect-timeout 3 http://localhost:%PREFERRED_PORT%/api/health 2>nul
if !errorlevel!==0 (
    echo [STARTUP] Agent Zero already healthy on port %PREFERRED_PORT%. Opening browser...
    start "" http://localhost:%PREFERRED_PORT%
    exit /b 0
)

:: Step 2: Clean orphaned SDK subprocesses (safe — only targets Copilot SDK children)
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -match 'copilot|@github|workiq.*mcp' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>nul

:: Step 3: Check if preferred port is free
netstat -ano | findstr ":%PREFERRED_PORT% " | findstr "LISTENING" >nul 2>&1
if !errorlevel! NEQ 0 (
    echo [STARTUP] Port %PREFERRED_PORT% is free.
    set PORT=%PREFERRED_PORT%
    goto :start_server
)

:: Port is occupied — check if it's an Agent Zero zombie (unhealthy node process)
echo [STARTUP] Port %PREFERRED_PORT% is occupied. Checking if it's an Agent Zero zombie...
set "ZOMBIE_PID="
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PREFERRED_PORT% " ^| findstr "LISTENING"') do (
    if not "%%p"=="0" set "ZOMBIE_PID=%%p"
)
if defined ZOMBIE_PID (
    :: Verify: is this node.exe running Agent Zero's server.js? (not just ANY node process)
    powershell -NoProfile -Command "$proc = Get-CimInstance Win32_Process -Filter 'ProcessId=%ZOMBIE_PID%' -EA SilentlyContinue; if (-not $proc -or $proc.Name -ne 'node.exe') { exit 1 }; if ($proc.CommandLine -match 'server\.js') { exit 0 } else { exit 1 }" 2>nul
    if !errorlevel!==0 (
        echo [STARTUP] Confirmed: PID %ZOMBIE_PID% is an Agent Zero zombie. Terminating...
        taskkill /PID %ZOMBIE_PID% /T >nul 2>&1
        ping -n 4 127.0.0.1 >nul
        taskkill /PID %ZOMBIE_PID% /T /F >nul 2>&1
        ping -n 2 127.0.0.1 >nul
        :: Verify port is now free
        netstat -ano | findstr ":%PREFERRED_PORT% " | findstr "LISTENING" >nul 2>&1
        if !errorlevel! NEQ 0 (
            echo [STARTUP] Port %PREFERRED_PORT% reclaimed.
            set PORT=%PREFERRED_PORT%
            goto :start_server
        )
    ) else (
        echo [STARTUP] PID %ZOMBIE_PID% is NOT Agent Zero — leaving it alone.
    )
)

:: Port still occupied by non-Agent-Zero app — find a free port
echo [STARTUP] Port %PREFERRED_PORT% is used by another application. Finding free port...
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
:: Step 4: Start fresh server with selected port
echo [STARTUP] Starting Agent Zero on port !PORT!...
cd /d %SERVER_DIR%
start "AgentZero" /min cmd /c "set PORT=!PORT!&& node server.js"

:: Step 5: Wait for server to become healthy (max ~15 seconds)
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
