@echo off
setlocal EnableDelayedExpansion

:: ============================================================
:: Agent Zero — Smart Server Startup
:: Ensures exactly ONE healthy server is running.
:: If already running → exits immediately.
:: If not → cleans up zombies and starts fresh.
:: ============================================================

set PORT=3000
set HEALTH_URL=http://localhost:%PORT%/api/health
set SERVER_DIR=%~dp0.

:: Step 1: Check if server is already running and healthy
curl -s -f -o nul --connect-timeout 3 %HEALTH_URL% 2>nul
if %errorlevel%==0 (
    echo [STARTUP] Server already healthy. Nothing to do.
    exit /b 0
)

:: Step 2: Kill zombie processes on port
echo [STARTUP] Server not healthy. Cleaning up...
for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":%PORT% " ^| findstr "LISTENING"') do (
    if not "%%p"=="0" (
        echo [STARTUP] Killing zombie PID %%p on port %PORT%
        taskkill /PID %%p /T >nul 2>&1
        ping -n 4 127.0.0.1 >nul
        taskkill /PID %%p /T /F >nul 2>&1
    )
)

:: Step 3: Clean orphaned SDK subprocesses
powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -match 'copilot|@github|workiq.*mcp' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }" 2>nul
ping -n 3 127.0.0.1 >nul

:: Step 4: Start fresh server (detached — returns immediately)
echo [STARTUP] Starting Agent Zero server...
cd /d %SERVER_DIR%
start "AgentZero" /min cmd /c "node server.js"
echo [STARTUP] Server process launched. Caller should verify health.
exit /b 0
