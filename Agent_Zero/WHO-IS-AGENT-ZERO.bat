@echo off
:: ============================================================
:: Agent Zero - Diagnostic Tool (read-only, never kills)
:: Shows EXACTLY how many node processes belong to Agent Zero
:: vs other tools (Copilot CLI, Playwright, etc.)
:: ============================================================
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0who-is-agent-zero.ps1" "%~dp0."
pause
