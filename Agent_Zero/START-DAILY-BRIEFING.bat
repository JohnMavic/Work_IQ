@echo off
title Daily Briefing Launcher
cd /d "%~dp0"

REM Check if server already running on port 3000
netstat -ano | findstr ":3000 " | findstr "LISTENING" >nul 2>&1
if %errorlevel%==0 (
    echo Server already running.
    start http://localhost:3000
    exit /b
)

REM Start server in a separate minimized window
echo Starting Daily Briefing server...
start "Daily Briefing Server" /MIN node server.js

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
