# Agent Zero — Custom Agent Instructions

> Version 5.1.0 · Agency Brain architecture for Microsoft 365 project-task scanning

Agent Zero now uses the Agency runner as its primary scan engine. The Express server
starts scan jobs, renders the current task state into the `brain-work/` sandbox, and
launches `agency.exe copilot` with the Agency Brain skill. The Agency runner inherits
WorkIQ from the user's Copilot MCP configuration instead of the server spawning a
long-lived WorkIQ process.

---

## Primary Agent Role

### Agency Brain Scan Agent (`AGENCY_BRAIN_SCAN_SKILL.md`)
- **Trigger:** User clicks Scan, which creates `POST /api/jobs` with `kind:"scan"`
- **Purpose:** Reduce recent M365 communications into project tasks and standalone tasks
- **Behavior:** Reads rendered state from `brain-work/`, calls WorkIQ through inherited Copilot MCPs, updates existing projects first, and emits machine-readable markers only
- **Output:** Validated task mutations: project tasks, `lineItems`, `pmStatus`, source references, review questions, and scan telemetry
- **Duration:** Bounded by the Agency runner timeout and WorkIQ call hard limit

### Legacy Agents (fallback only)
- **Enable:** Set `AGENT_ZERO_SCAN_ENGINE=legacy`
- **Skill files:** `SCAN_DISCOVERY_SKILL.md`, `ENRICH_SKILL.md`, `UPDATE_CHECK_SKILL.md`, `SEARCH_SKILL.md`, `CONSOLIDATE_SKILL.md`, `CORRECT_SKILL.md`
- **Purpose:** Preserve the previous SDK route behavior for troubleshooting and compatibility
- **Default state:** Disabled. Legacy HTTP routes return a 409 in Agency mode.

---

## Agent Architecture

```
┌─────────────────────────────────────────┐
│          Express Server (server.js)      │
│                                          │
│  POST /api/jobs kind:"scan"              │
│          │                               │
│          ▼                               │
│  runBrainScanOnce()                      │
│          │                               │
│          ▼                               │
│  brain-work/ sandbox                     │
│  scan-state-*.md + spill files           │
│          │                               │
│          ▼                               │
│  agency.exe copilot --no-default-mcps    │
│  + AGENCY_BRAIN_SCAN_SKILL.md            │
└──────────┬──────────────────────────────┘
           │ inherits ~/.copilot/mcp-config.json
           ▼
     WorkIQ MCP → Microsoft 365
```

### Scan Engine Model
- Operational default is `agency` through `START-AGENT-ZERO.bat` and `Start-WorkIQ-Scan.ps1`, which set `AGENT_ZERO_SCAN_ENGINE=agency` when the variable is absent.
- Direct `node server.js` inherits the environment as-is; set `AGENT_ZERO_SCAN_ENGINE=agency` explicitly for Agency mode or `AGENT_ZERO_SCAN_ENGINE=legacy` for fallback.
- Legacy override is explicit in the launch environment: `AGENT_ZERO_SCAN_ENGINE=legacy` re-enables the old SDK routes and persistent WorkIQ subprocess.
- `mcp.json` is legacy-only documentation/configuration. The Agency runner does not read it.
- `buildAgencyEnv()` strips `AGENCY_SESSION_ID` and `COPILOT_AGENT_SESSION_ID` before spawning Agency so parent sessions cannot bleed into child runs.

### State And Marker Model
- `tasks.json` is migrated to schema version 5.
- Project tasks use `taskType:"project"` plus `sourceRefs`, `lineItems`, `pmStatus`, `brainState`, archive/supersession fields, and normal task history.
- Standalone actions remain `taskType:"single"`.
- The agent may only change state through validated marker lines:
  `PROJECT_NEW`, `PROJECT_UPDATE`, `FACTSHEET_UPDATE`, `LINEITEM_NEW`, `LINEITEM_UPDATE`,
  `NODE_OBSOLETE`, `TASK_NEW`, `TASK_UPDATE`, `LEARNING`, `NEEDS_REVIEW`, `SCAN_DONE`
  (the canonical set is `MARKER_TYPES` in `marker-parser.js`).
- `marker-parser.js` ignores markers in code fences; `marker-applier.js` validates evidence references, allowed patch fields, confidence caps, and marker ordering before writing.

### Sandbox Model
- `brain-work/` is the only writable/readable working directory added to the Agency run.
- `render-scan-state.js` writes compact state plus spill files into that sandbox before the run.
- Cleanup is path-guarded: code refuses to clean directories whose basename is not `brain-work`.
- `tasks.json` is updated once per successful marker batch through atomic writes and backup rotation.

### Validation Pipeline

Marker output passes through ordered gates before it can touch `tasks.json`
(`runBrainScanOnce` in `scan-brain.js`):

1. **Project identity gate** (`project-identity.js`) — resolves each candidate against the
   canonical identity index so one undertaking never becomes two top-level records.
2. **Bounded processing-quality correction** (`processing-quality-correction.js`) — a single,
   optional, non-looping pass that repairs only provable processing-ledger omissions for items
   the scan already enumerated. Budgets: timeout 8 min, WorkIQ hard limit 8, tool hard limit 24.
3. **Reality Gateway** (`reality-gateway.js`) — deterministic marker checks plus an independent
   verification pass; unapproved markers are held and converted to review items (fail-closed).
4. **Final processing-quality gate + temporal pass** (`processing-ledger.js`, `temporal-pass.js`) —
   enforce ledger completeness, attachment handling, discovery coverage, and stale-date resolution.
5. **Atomic application** (`marker-applier.js`, `tasks-v5.js`) — validated markers are applied and
   `tasks.json` is written via temp file + fsync + rename with `.1.bak`–`.3.bak` rotation.

### Safety Mechanisms
- **Ambiguity handling:** Low-confidence ownership/status decisions become `NEEDS_REVIEW`.
- **Temporal awareness:** The skill treats current WorkIQ evidence as stronger than historical summaries.
- **Evidence enforcement:** Status, problem, risk, waiting, and user-action changes require source references.
- **WorkIQ budget:** The runner counts explicit WorkIQ tool starts, logs a warning at 40 tool starts, and emergency-stops the child at 150 tool starts to prevent loops.
- **Hallucination prevention:** Unsupported facts must not be emitted as task state.
- **Model request:** `agency-cli.js` requests `claude-opus-4.8` via `--model` and records it in brain telemetry. Actual honoring of the requested model is not independently established by the command-line flag alone.

---

## Skill File Locations

| Skill File | Agent Role | Path |
|---|---|---|
| `AGENCY_BRAIN_SCAN_SKILL.md` | Agency Brain scan | `docs/` |
| `SCAN_DISCOVERY_SKILL.md` | Legacy discovery | `docs/` |
| `ENRICH_SKILL.md` | Legacy enrichment | `docs/` |
| `UPDATE_CHECK_SKILL.md` | Legacy update check | `docs/` |
| `SEARCH_SKILL.md` | Legacy/manual search | `docs/` |
| `CONSOLIDATE_SKILL.md` | Legacy consolidation | `docs/` |
| `CORRECT_SKILL.md` | Legacy correction verification | `docs/` |
| `LOG_WORK_SKILL.md` | Legacy work logging fallback | `docs/` |

---

## MCP Server Configuration

Agency mode uses WorkIQ from the user's inherited Copilot MCP configuration, typically
`~/.copilot/mcp-config.json`. Keep WorkIQ configured there for Agency scans.

`mcp.json` in this repo is retained for `AGENT_ZERO_SCAN_ENGINE=legacy` only. It points
to the local `@microsoft/workiq` package and is not read by the Agency runner.

---

## Operations & Process Hygiene

For operational rules (single-instance guarantee, path-restricted cleanup, diagnostic
tooling, Phase 3 pitfalls), see [`../.github/copilot-instructions.md`](../.github/copilot-instructions.md)
at the Work_IQ repo root.

Quick reference:
- **One instance only**, enforced by atomic lockfile (`fs.openSync('.agent-zero.lock', 'wx')`)
- **Diagnostic:** run `WHO-IS-AGENT-ZERO.bat` before touching processes
- **Cleanup:** path-restricted to `E:\Work_IQ\Agent_Zero` — never broad patterns like `copilot|workiq.*mcp`
- **No broad process kills:** do not use name-based `Stop-Process` or `taskkill /IM`
- **Task Scheduler:** restarts stale servers older than 24h via `Start-WorkIQ-Scan.ps1`
