@echo off
title Agent Zero Launcher
cd /d "%~dp0"

REM Check if server already running on port 3000 — kill and restart
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo Existing server found on port 3000 — terminating...
    for /f "tokens=5" %%p in ('netstat -ano ^| findstr ":3000 " ^| findstr "LISTENING"') do (
        taskkill /PID %%p /F >nul 2>&1
    )
    timeout /t 2 /nobreak >nul
    echo Old server terminated.
)

REM Start server in a separate minimized window
echo Starting Agent Zero server...
start "Agent Zero Server" /MIN node server.js

REM Wait for server to be ready (max 15 seconds)
set /a attempts=0
:waitloop
set /a attempts+=1
if %attempts% gtr 15 (
    echo ERROR: Server did not start within 15 seconds.
    pause
    exit /b 1
)
timeout /t 1 /nobreak >nul
powershell -Command "try { (Invoke-WebRequest -Uri http://localhost:3000 -TimeoutSec 2 -UseBasicParsing).StatusCode } catch { exit 1 }" >nul 2>&1
if %errorlevel% neq 0 goto waitloop

echo Server ready!
start http://localhost:3000
