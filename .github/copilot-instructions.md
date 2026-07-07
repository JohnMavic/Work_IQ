# Copilot Instructions — Work_IQ Repository

This file documents non-obvious operational rules and prior decisions Copilot must respect when working in this repo. Skill/agent architecture lives in `Agent_Zero/AGENTS.md`.

---

## Project: Agent Zero (`E:\Work_IQ\Agent_Zero`)

**Current version:** 4.1.0 (Express server orchestrating Copilot SDK + Work IQ MCP).

### Single-Instance Guarantee — DO NOT WEAKEN

Multiple parallel Agent Zero instances corrupt Work IQ MCP authentication and break Phase 3 (Update Check). The following layered protection MUST stay intact:

| Layer | File | Mechanism |
|---|---|---|
| OS-atomic mutex | `server.js` → `acquireLockFileAtomic()` | `fs.openSync('.agent-zero.lock', 'wx')` — kernel-guaranteed exclusive create. Stale-PID recovery built in. |
| Port backup | `server.js` → `EADDRINUSE` handler on `app.listen` | Graceful exit if port busy. |
| Staleness detection | `Start-WorkIQ-Scan.ps1` | Restart instead of reuse if `/api/health` reports `uptime > 24h` or missing `wiqPid`. |
| Task Scheduler policy | `WorkIQ-Scan-Task.xml` | `MultipleInstancesPolicy: IgnoreNew`. |

**Never** remove `acquireLockFileAtomic()` or replace the atomic `wx` open with a non-atomic check-then-create. **Never** raise the staleness threshold above 24h without re-validating.

### Path-Restricted Process Cleanup — CRITICAL SAFETY RULE

**Cleanup logic must filter exclusively on `[regex]::Escape('E:\Work_IQ\Agent_Zero')` (or the equivalent `__dirname`).**

❌ **FORBIDDEN patterns** (would kill the user's Copilot CLI Playwright MCPs and other tools):
- `copilot|@github|workiq.*mcp`
- `node.*workiq` (matches Copilot CLI's own children)
- Any name-based or broad-keyword `Stop-Process`/`taskkill /IM`

✅ **Required pattern:** Only kill processes whose `CommandLine` contains the literal Agent Zero install directory.

`taskkill /T /F <PID>` on the server.js parent kills the entire process tree (WIQ + SDK children) — prefer this over per-child sweeps.

#### Identification cheatsheet
- **server.js cmdline appears as bare `node server.js`** (no path). Identify it via `/api/health` PID and lockfile PID — **not** via cmdline path.
- **WIQ child cmdline always contains** `E:\Work_IQ\Agent_Zero\node_modules\@microsoft\workiq` — solid path signature.
- On a typical dev machine: 2 Agent Zero processes + ~14 Copilot CLI Playwright MCPs is **normal**. Don't "clean up" what isn't yours.

### Diagnostic Tools

| Tool | Purpose | Side effects |
|---|---|---|
| `WHO-IS-AGENT-ZERO.bat` / `who-is-agent-zero.ps1` | Classify all `node.exe` processes (AZ server / WIQ / SDK / Playwright / other / unrelated) | Read-only |
| `START-AGENT-ZERO.bat` | Manual start with reuse-or-fresh logic | Calls `stop-agent-zero.ps1` if cleanup needed |
| `STOP-AGENT-ZERO.bat` / `stop-agent-zero.ps1` | 3-phase path-restricted shutdown (health → lockfile → orphan sweep) | Idempotent, always exits 0 |
| `Start-WorkIQ-Scan.ps1` | Task Scheduler entry, runs daily 07:00 + 11:00 | Includes staleness check |

**Always run `WHO-IS-AGENT-ZERO.bat` before touching processes** — Task-Manager shows all `node.exe` identically; the count is misleading.

### `/api/health` Contract (v4.1.0+)

```json
{ "service": "agent-zero", "status": "healthy", "uptime": <seconds>,
  "activeSessions": <n>, "memoryMB": <n>, "pid": <n>, "port": 3000,
  "version": "4.1.0", "repoPath": "E:\\Work_IQ\\Agent_Zero", "wiqPid": <n> }
```

`repoPath` and `wiqPid` are required by the Task Scheduler script and the diagnostic tool. Don't drop them.

### Phase 3 (Update Check) — Historical Pitfall

Symptom: "Phase 3 findet keine Updates" with `Phase 1 failed: Work IQ subprocess exited` in `scan-log.txt`.

Root cause (verified in scan-log on 27.04.2026): Task Scheduler reused a 4-day-old server whose Work IQ auth had decayed. **Always check `uptime` and `wiqPid` first** before suspecting prompts or skill content.

### User Constraints (from this repo's owner)
- Don't terminate Node processes from other projects under any circumstances.
- Don't parallelize Phase 3 scans (quota limits).
- Don't raise Phase 3 timeout above 90s "to mask the problem" — fix the root cause.

---

## Project: AI Café (`E:\AI Café`)

Separate repo (`https://github.com/JohnMavic/AI_CAFE.git`). Out of scope for changes from within Work_IQ.

---

## Conventions

- **Path style on Windows:** Use backslashes (`E:\Work_IQ\...`).
- **Git commits:** Always include `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer.
- **No new markdown planning files** in the repo. Use the session workspace instead.
