# Copilot Instructions — Work_IQ Repository

This file documents non-obvious operational rules and prior decisions Copilot must respect when working in this repo. Skill/agent architecture lives in `Agent_Zero/AGENTS.md`.

---

## Project: Agent Zero (`E:\Work_IQ\Agent_Zero`)

**Current version:** 5.1.0. **Default scan engine:** the Agency Brain — the server spawns `agency.exe copilot` per scan and inherits WorkIQ from the user's Copilot MCP configuration (`~/.copilot/mcp-config.json`). `START-AGENT-ZERO.bat` and `Start-WorkIQ-Scan.ps1` set `AGENT_ZERO_SCAN_ENGINE=agency` when the variable is unset. The legacy Copilot-SDK path (with a persistent local `@microsoft/workiq` subprocess) is fallback-only and runs only when `AGENT_ZERO_SCAN_ENGINE=legacy`.

### Single-Instance Guarantee — DO NOT WEAKEN

Only one Agent Zero server may run per installation directory. This protects task-state integrity (atomic `tasks.json` writes + backup rotation), the fixed port, the lockfile, and scan safety (overlapping scans compete for the same state and, in legacy mode, also corrupt WorkIQ MCP authentication). The layered protection MUST stay intact:

| Layer | File | Mechanism |
|---|---|---|
| OS-atomic mutex | `server.js` → `acquireLockFileAtomic()` | `fs.openSync('.agent-zero.lock', 'wx')` — kernel-guaranteed exclusive create. Stale-PID recovery built in. |
| Port backup | `server.js` → `EADDRINUSE` handler on `app.listen` | Graceful exit if the port is busy. |
| Staleness detection | `Start-WorkIQ-Scan.ps1` | Restart instead of reuse if `/api/health` reports `uptime > 24h`; in **legacy** mode also restart if a live `wiqPid` is missing. |
| Task Scheduler policy | `WorkIQ-Scan-Task.xml` | `MultipleInstancesPolicy: IgnoreNew`. |

**Never** remove `acquireLockFileAtomic()` or replace the atomic `wx` open with a non-atomic check-then-create. **Never** raise the staleness threshold above 24h without re-validating.

### Path-Restricted Process Cleanup — CRITICAL SAFETY RULE

**Cleanup logic must filter exclusively on `[regex]::Escape('E:\Work_IQ\Agent_Zero')` (or the equivalent `__dirname`).**

❌ **FORBIDDEN patterns** (would kill the user's Copilot CLI Playwright MCPs and other tools):
- `copilot|@github|workiq.*mcp`
- `node.*workiq` (matches Copilot CLI's own children)
- Any name-based or broad-keyword `Stop-Process`/`taskkill /IM`

✅ **Required pattern:** Only kill processes whose `CommandLine` contains the literal Agent Zero install directory (`stop-agent-zero.ps1` Phase C).

`taskkill /T /F <PID>` on the `server.js` parent kills its entire process tree — in Agency mode the transient `agency.exe copilot` scan child, and in legacy mode the WorkIQ + SDK children. Prefer this over per-child sweeps.

#### Identification cheatsheet
- **`server.js` cmdline appears as bare `node server.js`** (no path). Identify it via the `/api/health` PID and the lockfile PID — **not** via cmdline path.
- **Agency scan child** is a transient `agency.exe copilot` process spawned only during a scan; it exits on its own and confines its working set to the `brain-work/` sandbox.
- **Legacy WorkIQ child cmdline always contains** `E:\Work_IQ\Agent_Zero\node_modules\@microsoft\workiq` — a solid path signature (legacy mode only).
- On a typical dev machine: 1 Agent Zero server (plus a transient scan child while scanning) alongside ~14 Copilot CLI Playwright MCPs is **normal**. Don't "clean up" what isn't yours.

### Diagnostic Tools

| Tool | Purpose | Side effects |
|---|---|---|
| `WHO-IS-AGENT-ZERO.bat` / `who-is-agent-zero.ps1` | Classify all `node.exe` processes (AZ server / legacy WIQ / SDK / Playwright / other / unrelated) and print `/api/health` (incl. `scanEngine`) | Read-only |
| `START-AGENT-ZERO.bat` | Manual start (defaults `AGENT_ZERO_SCAN_ENGINE=agency`) with reuse-or-fresh logic | Calls `stop-agent-zero.ps1` if cleanup needed |
| `STOP-AGENT-ZERO.bat` / `stop-agent-zero.ps1` | 3-phase path-restricted shutdown (health repoPath match → lockfile → orphan sweep) | Idempotent, always exits 0 |
| `Start-WorkIQ-Scan.ps1` | Task Scheduler entry, runs daily 07:00 + 11:00 | Includes staleness check |

**Always run `WHO-IS-AGENT-ZERO.bat` before touching processes** — Task-Manager shows all `node.exe` identically; the count is misleading.

### `/api/health` Contract (v5.1.0)

```json
{ "service": "agent-zero", "status": "ok", "uptime": <seconds>,
  "activeSessions": <n>, "memoryMB": <n>, "pid": <n>, "port": 3000,
  "version": "5.1.0", "scanEngine": "agency",
  "repoPath": "E:\\Work_IQ\\Agent_Zero", "wiqPid": null }
```

`repoPath`, `scanEngine`, and `wiqPid` are consumed by the Task Scheduler script and the diagnostic tool — don't drop them.

- **`wiqPid` is `null` in Agency mode by design** (the server owns no persistent WorkIQ subprocess). It is only meaningful/required in legacy mode, where it points at the live `@microsoft/workiq` child. A `null` `wiqPid` **must not** by itself make an Agency-mode server look stale: `Start-WorkIQ-Scan.ps1` only requires a live `wiqPid` when `scanEngine != "agency"`.

### Legacy Phase 3 (Update Check) — Historical fallback pitfall

> Applies **only** to `AGENT_ZERO_SCAN_ENGINE=legacy`. The default Agency Brain pipeline has no Phase 1/2/3 and no persistent WorkIQ subprocess, so this pitfall does not apply to the current engine.

Symptom (legacy): "Phase 3 findet keine Updates" with `Phase 1 failed: Work IQ subprocess exited` in `scan-log.txt`. Root cause (verified 27.04.2026): the Task Scheduler reused a multi-day-old server whose WorkIQ auth had decayed. In legacy mode, check `uptime` and `wiqPid` first before suspecting prompts or skill content.

### User Constraints (from this repo's owner)
- Don't terminate Node processes from other projects under any circumstances.
- Don't run overlapping scans — one scan job at a time (respect the single-instance guarantee and provider quota limits).
- Don't mask a failing scan by inflating timeouts — fix the root cause. (Agency runner limits live in `brain/brain-runner.js`; the old Phase-3 timeout is a legacy-only knob.)

---

## Project: AI Café (`E:\AI Café`)

Separate repo (`https://github.com/JohnMavic/AI_CAFE.git`). Out of scope for changes from within Work_IQ.

---

## Conventions

- **Path style on Windows:** Use backslashes (`E:\Work_IQ\...`).
- **Git commits:** Always include `Co-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>` trailer.
- **No new markdown planning files** in the repo. Use the session workspace instead.
