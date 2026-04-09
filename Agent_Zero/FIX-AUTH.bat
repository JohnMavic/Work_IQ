@echo off
echo ============================================
echo   Agent Zero - Auth Fix Script
echo ============================================
echo.
echo Dieses Script erneuert die abgelaufenen Auth-Tokens.
echo Du musst dich in 2 Login-Dialogen anmelden.
echo.
echo --- Schritt 1/3: Work IQ EULA akzeptieren ---
workiq accept-eula
echo.
echo --- Schritt 2/3: M365 Auth erneuern ---
echo Ein Windows-Login-Dialog wird erscheinen. Bitte dort anmelden.
echo.
workiq ask -q "hello"
if %ERRORLEVEL% NEQ 0 (
    echo [FEHLER] M365 Auth fehlgeschlagen. Bitte nochmals versuchen.
    pause
    exit /b 1
)
echo.
echo [OK] M365 Auth erneuert!
echo.
echo --- Schritt 3/3: GitHub Auth erneuern ---
echo.
gh auth login -h github.com
echo.
echo ============================================
echo   Auth-Fix abgeschlossen!
echo   Starte Agent Zero jetzt mit:
echo   START-AGENT-ZERO.bat
echo ============================================
pause
