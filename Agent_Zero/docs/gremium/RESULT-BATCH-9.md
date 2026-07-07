BATCH9: BLOCKED local command execution failed before MCP probe could run

Probe attempted first, before implementation:

- Command: `AGENCY_RING=Prod AGENCY_NO_UPDATE_CHECK=1 agency copilot --mcp mail -p "List the subject and attachment names of the newest email in my inbox. Reply in one line." --allow-all-tools --no-ask-user -s --model claude-opus-4.8 --effort low --no-auto-update`
- Result: process exited immediately with Windows exit code `0xC0000142` and no stdout/stderr.
- Follow-up checks: `agency --version`, `Get-Command agency`, `Write-Output 'shell-ok'`, and `cmd /c echo cmd-ok` all failed the same way.

Conclusion: this run cannot distinguish whether Agency built-in MCPs are usable headlessly, because the local shell/tool host cannot start even trivial commands. Per Batch 9 instructions, no implementation changes were made without a successful probe.

Best next alternative: rerun the probe in a working PowerShell/Agency session. If `--mcp mail` or `--mcp teams` remains unavailable headlessly after shell startup is fixed, use a Microsoft Graph read-only path with an authenticated CDP/device-flow pattern for message enumeration and attachment download, then feed downloaded PDF/docx/xlsx content through the existing brain-work evidence pipeline.
