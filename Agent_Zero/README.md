# Agent Zero

> Version 5.0.0 · A personal AI-powered project-task tracker for Microsoft 365
>
> _Built with AI, powered by curiosity._

**Author:** Martin Hämmerli · [martih@microsoft.com](mailto:martih@microsoft.com)

Agent Zero scans Microsoft 365 mail and Teams activity, groups related signals into
project tasks, and tracks concrete workstreams as line items. The current default
engine is the Agency Brain: an `agency.exe copilot` child process that reads a
rendered task-state sandbox, calls WorkIQ through inherited Copilot MCPs, and returns
validated marker lines for the server to apply.

## Prerequisites

- **Node.js** v18+
- **Git**
- **Active GitHub Copilot subscription**
- **Agency CLI** available as `agency.exe` on `PATH`
- **M365 account** with WorkIQ authentication
- **WorkIQ MCP configured for Copilot**, typically in `~/.copilot/mcp-config.json`

The local `@microsoft/workiq` dependency is retained for legacy SDK mode. Agency mode
does not use `mcp.json` or a server-owned WorkIQ subprocess.

## Installation

```powershell
git clone https://github.com/JohnMavic/Work_IQ.git
cd Work_IQ\Agent_Zero
npm install
```

Authenticate once for WorkIQ:

```powershell
workiq accept-eula
```

Make sure WorkIQ is also available to Copilot through your user MCP config. Agency
runs inherit that config; they do not read this repo's `mcp.json`.

## Quick Start

Double-click `START-AGENT-ZERO.bat`, or start manually:

```powershell
cd E:\Work_IQ\Agent_Zero
node server.js
```

Then open [http://localhost:3000](http://localhost:3000) and click **Scan**.

The launcher and scheduler set `AGENT_ZERO_SCAN_ENGINE=agency` when the variable is
unset. A direct `node server.js` run inherits the environment as-is, so set the engine
explicitly when starting manually:

```powershell
$env:AGENT_ZERO_SCAN_ENGINE = 'agency'
node server.js
```

To use the old SDK routes for troubleshooting, start with:

```powershell
$env:AGENT_ZERO_SCAN_ENGINE = 'legacy'
node server.js
```

## Architecture Overview

```
┌─────────────────────────────────────────┐
│ Agent Zero (server.js, Express)          │
│                                         │
│ POST /api/jobs kind:"scan"              │
│        │                                │
│        ▼                                │
│ runBrainScanOnce()                      │
│        │                                │
│        ▼                                │
│ brain-work/ sandbox                     │
│ scan-state-*.md + spill files           │
│        │                                │
│        ▼                                │
│ agency.exe copilot                      │
│ docs/AGENCY_BRAIN_SCAN_SKILL.md         │
└────────┬────────────────────────────────┘
         │ inherited Copilot MCP config
         ▼
       WorkIQ MCP ── Microsoft 365
```

### Runtime Components

| Component | Current role |
|---|---|
| `server.js` | Express API, job registry, task persistence, legacy route guards |
| `brain/scan-brain.js` | Agency scan orchestration, state rendering, marker parse/apply, telemetry |
| `brain/brain-runner.js` | Spawns `agency.exe`, streams JSON events, counts WorkIQ tool calls, enforces timeouts |
| `brain/agency-cli.js` | Pins Agency arguments/model and builds the child environment |
| `brain-work/` | Restricted sandbox for rendered state and spill files |
| `docs/AGENCY_BRAIN_SCAN_SKILL.md` | Primary scan skill and marker contract |
| `mcp.json` | Legacy SDK-only WorkIQ config for `AGENT_ZERO_SCAN_ENGINE=legacy` |

## How Scans Work

1. The UI creates `POST /api/jobs` with `kind:"scan"` and an optional `scanDays` value.
2. The server normalizes scan input and starts one singleton scan job.
3. `render-scan-state.js` writes current task state into `brain-work/`.
4. Agency receives the scan skill plus a bootstrap prompt that points to the state file.
5. Agency calls WorkIQ via inherited Copilot MCP configuration.
6. Agency emits marker lines only.
7. The server parses and validates markers, then writes `tasks.json` atomically.
8. Job events stream back to the browser.

Agency mode replaces the former four-phase scan loop as the default. The old discovery,
enrichment, update-check, consolidation, search, review, and correction routes remain in
the codebase but are guarded unless `AGENT_ZERO_SCAN_ENGINE=legacy` is set.

## Task Model

`tasks.json` is schema version 5.

Project tasks contain:

- `taskType: "project"`
- `sourceRefs[]` for evidence from email, Teams, or manual sources
- `lineItems[]` for workstreams, actions, dependencies, risks, decisions, and info
- `pmStatus` for synthesized current/planned/user-action/problem/risk/waiting state
- `brainState` telemetry and review flags
- archive/supersession fields for migrated or merged tasks

Standalone actions remain `taskType: "single"` and keep the normal task fields.

## Marker Protocol

The Agency Brain may only mutate state through physical marker lines:

- `PROJECT_NEW`
- `PROJECT_UPDATE`
- `LINEITEM_NEW`
- `LINEITEM_UPDATE`
- `TASK_NEW`
- `TASK_UPDATE`
- `NEEDS_REVIEW`
- `SCAN_DONE`

`marker-parser.js` ignores markers inside fenced code blocks. `marker-applier.js`
validates evidence references, allowed patch fields, confidence rules, and marker order
before any write. If the output has valid markers but no `SCAN_DONE`, the server applies
the safe subset as a partial result and adds a review hint.

## Agency Runner Safeguards

- `buildAgencyArgs()` pins model, effort, context, no-default-MCP behavior, and the
  `brain-work/` add-dir.
- `buildAgencyEnv()` removes `AGENCY_SESSION_ID` and `COPILOT_AGENT_SESSION_ID` from
  the child environment to prevent parent-session bleed.
- `brain-runner.js` counts explicit WorkIQ tool starts and can kill the child when the
  hard WorkIQ budget is reached.
- `prepareBrainWorkDir()` refuses to clean anything whose basename is not `brain-work`.
- `writeJsonFileAtomic()` writes `tasks.json` through temp files, fsync, rename retry,
  and backup rotation.

## API Endpoints

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/jobs` | POST | Create `scan`, `merge`, or `consolidate` jobs. In Agency mode, only `scan` is active. |
| `/api/jobs` | GET | Read active/recent job state |
| `/api/tasks` | GET | Return all tasks |
| `/api/tasks` | POST | Create a manual task |
| `/api/tasks/:id` | PATCH | Update task fields |
| `/api/tasks/:id` | DELETE | Delete a task |
| `/api/tasks/:id/note` | POST | Save a quick note |
| `/api/health` | GET | Health, PID, version, repo path, scan engine, and WorkIQ PID compatibility field |
| `/api/cleanup` | POST | Permanently delete done tasks older than `retentionDays` |

Legacy SDK endpoints such as `/api/scan`, `/api/tasks/:id/enrich`,
`/api/tasks/:id/check-update`, `/api/consolidate`, `/api/tasks/merge`,
`/api/tasks/:id/log`, `/api/tasks/:id/review`, and `/api/tasks/:id/correct` return 409
in Agency mode with the `AGENT_ZERO_SCAN_ENGINE=legacy` override hint.

## Scheduled Scan

`Start-WorkIQ-Scan.ps1` and `WorkIQ-Scan-Task.xml` remain the Windows Task Scheduler
entry points. The scheduler accepts Agency-mode health responses where `wiqPid` is
`null`, because Agency mode does not require a persistent server-owned WorkIQ process.
The script still restarts stale servers older than 24 hours.

## Troubleshooting

| Problem | Check |
|---|---|
| Agency executable not found | Ensure `agency.exe` is on `PATH`, or set `AGENT_ZERO_AGENCY_EXE` |
| Scan cannot access M365 | Check WorkIQ auth and Copilot MCP config in `~/.copilot/mcp-config.json` |
| Legacy route returns 409 | Use `/api/jobs kind:"scan"` or start with `AGENT_ZERO_SCAN_ENGINE=legacy` |
| Port 3000 in use | Use the launcher or stop the existing Agent Zero instance intentionally |
| Need process diagnosis | Run `WHO-IS-AGENT-ZERO.bat` before touching processes |

## File Structure

```
Agent_Zero/
├── server.js                    Express backend, job API, legacy route guards
├── index.html                   Single-file frontend
├── package.json                 Dependencies and version 5.0.0
├── mcp.json                     Legacy SDK-only WorkIQ MCP config
├── tasks.json                   Local task storage (schema v5, gitignored)
├── AGENTS.md                    Agent behavior documentation
├── brain/
│   ├── agency-cli.js            Agency executable, args, environment
│   ├── brain-runner.js          Agency child process runner
│   ├── scan-brain.js            Agency scan orchestration
│   ├── render-scan-state.js     Sandbox state renderer
│   ├── marker-parser.js         Marker parser
│   ├── marker-applier.js        Marker validator/applier
│   └── tasks-v5.js              v5 migration and atomic writes
├── brain-work/                  Agency sandbox
├── docs/
│   ├── AGENCY_BRAIN_SCAN_SKILL.md
│   ├── CHANGELOG.md
│   └── gremium/
└── tests/unit/                  Node test suite
```

For detailed operational constraints, also read [`../.github/copilot-instructions.md`](../.github/copilot-instructions.md).
