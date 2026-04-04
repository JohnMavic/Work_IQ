@echo off
:: ============================================================
:: Agent Zero — Safe Shutdown
:: Identifies and terminates ONLY Agent Zero processes.
:: Never kills other applications, even on the same ports.
::
:: Identification strategy:
::   1. Health endpoint: /api/health returns {"pid":...} — unique to Agent Zero
::   2. Process fingerprint: node.exe running server.js from this directory
::   3. SDK subprocesses: Copilot SDK children (copilot|@github markers)
:: ============================================================

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0stop-agent-zero.ps1" "%~dp0."

