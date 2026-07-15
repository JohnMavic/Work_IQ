# Agent Zero — Product Specification

**Version:** 5.1.0
**Date:** July 15, 2026
**Author:** Martin Hämmerli
**Status:** v5.1.0 — Agency Brain scan engine with project tasks, line items, living Fact Sheets, a bounded processing-quality correction pass, model-assessed semantic relevance, and a fail-closed Reality Gateway. Additive release on top of v5.0.0; `tasks.json` remains schema version 5.

---

## 1. Purpose

Agent Zero is a local, single-page application that helps the user stay on top of work that
arrives through Microsoft 365 mail and Teams. It scans a configurable window of recent
communication, groups related signals into **project tasks** (with **line items** and a living
**Fact Sheet**), keeps genuinely standalone actions as **single tasks**, and presents everything in
a dark-themed card list with an Executive Brief, Decision Focus, and relevance-ranked line items.

The current default scan engine is the **Agency Brain**: an `agency.exe copilot` child process that
reads a rendered state sandbox, calls WorkIQ through inherited Copilot MCP configuration, and
returns validated marker lines that the server applies to `tasks.json`. The earlier four-phase
Copilot-SDK pipeline is retained only as an explicit fallback under
`AGENT_ZERO_SCAN_ENGINE=legacy`.

---

## 2. Architecture Overview

```
┌───────────────────────────────────────────────┐
│                Browser (index.html)            │
│  Executive Brief · Decision Focus · line items │
│  Relevance bands · review queue · SSE updates  │
└───────────────────────┬────────────────────────┘
                        │ HTTP + SSE (localhost:3000)
┌───────────────────────┴────────────────────────┐
│               Express Server (server.js)        │
│  Job registry · scan orchestration · task store │
│  Legacy route guards (409 unless legacy engine) │
└───────────┬─────────────────────────────────────┘
            │ runBrainScanOnce() → render brain-work/ sandbox
            ▼
┌─────────────────────────────────────────────────┐
│  agency.exe copilot  (--model claude-opus-4.8)    │
│  bootstrap = AGENCY_BRAIN_SCAN_SKILL.md + context │
└───────────┬─────────────────────────────────────┘
            │ inherits ~/.copilot/mcp-config.json
            ▼
      WorkIQ MCP ── Microsoft 365 (mail · Teams · attachments)
```

**Scan engine model (`getScanEngine`):** returns `agency` only when
`AGENT_ZERO_SCAN_ENGINE=agency`, otherwise `legacy`. Launchers
(`START-AGENT-ZERO.bat`, `Start-WorkIQ-Scan.ps1`) default the variable to `agency`; a bare
`node server.js` inherits the environment as-is. In Agency mode the server owns **no** persistent
WorkIQ subprocess and does **not** read the repo `mcp.json`.

---

## 3. Technology Stack

| Component | Technology | Notes |
|---|---|---|
| Frontend | Single HTML file | No build step |
| Backend | Node.js + Express (ESM) | `"type": "module"` |
| Scan engine | `agency.exe copilot` | Spawned per scan; inherits Copilot MCPs |
| Requested model | `claude-opus-4.8` | Requested via `--model`; honoring not independently verified |
| M365 data | WorkIQ MCP | Inherited config; not the repo `mcp.json` in Agency mode |
| Legacy AI path | `@github/copilot-sdk`, local `@microsoft/workiq` 0.2.8 | Only under `AGENT_ZERO_SCAN_ENGINE=legacy` |
| Storage | `tasks.json` (schema v5) | Atomic writes, `.1.bak`–`.3.bak` rotation |

### 3.1 Prerequisites

- Node.js v18+ and Git.
- Active GitHub Copilot subscription; `agency.exe` on `PATH` (or `AGENT_ZERO_AGENCY_EXE`).
- M365 account with WorkIQ authentication, and WorkIQ configured for Copilot
  (typically `~/.copilot/mcp-config.json`).

### 3.2 Runner configuration

- `COPILOT_MODEL = 'claude-opus-4.8'`, `COPILOT_EFFORT = 'xhigh'`, `COPILOT_CONTEXT = 'long_context'`.
- `buildAgencyArgs()` pins model/effort/context, adds `--add-dir brain-work`, `--allow-all-tools`,
  `--yolo`, `--no-ask-user`, `--no-auto-update`. `buildAgencyEnv()` strips `AGENCY_SESSION_ID` and
  `COPILOT_AGENT_SESSION_ID`.
- Runner limits: 25-minute default timeout, tool-start warning at 40, emergency stop at 150.

---

## 4. Scan Pipeline

A scan is one server job: `POST /api/jobs` with `kind:"scan"` → `runScanJob` → `runAgencyScanJob`
→ `runBrainScanOnce()`. Phases (SSE `job.phase_*`):

`brain_prepare → brain_run → [brain_quality_correction] → brain_gateway → brain_apply`

1. **brain_prepare** — migrate to v5; compute the discovery window; render compact state + spill
   files into `brain-work/`.
2. **brain_run** — bootstrap = the scan skill + Run Context (`runId`, `scanDays`,
   `discoveryWindowStart/End`, `stateFile`); the Agency child runs and returns marker text.
3. **parse + project identity gate** — extract markers (code fences ignored); resolve each
   candidate against the canonical identity index.
4. **bounded processing-quality correction** — optional single attempt (§7).
5. **brain_gateway** — independent Reality Gateway verification (fail-closed) + deterministic marker
   checks; held markers become review items.
6. **brain_apply** — final processing-quality gate + temporal pass, then atomic
   `applyMarkerBatch()` and fragment reconciliation; review hints appended; telemetry set;
   `tasks.json` written atomically.

**Outcome** is `success` only when nothing made the batch partial; otherwise `partial`. Only a
`success` advances `lastScan`. If markers exist but `SCAN_DONE` is missing, the safe subset is
applied as a partial result with a review hint.

### 4.1 Scan input

`scanDays` defaults to 4, clamped 1–14 (`normalizeScanJobInput` / `normalizeScanDays`). The
discovery window start is pulled toward the last scan but never earlier than a 14-day recovery
floor, so late-indexed messages are reconsidered.

---

## 5. Marker Protocol

The brain emits one marker per physical line; it never writes files or edits `tasks.json`
directly. Canonical set (`MARKER_TYPES` in `brain/marker-parser.js`):

`PROJECT_NEW`, `PROJECT_UPDATE`, `FACTSHEET_UPDATE`, `LINEITEM_NEW`, `LINEITEM_UPDATE`,
`NODE_OBSOLETE`, `TASK_NEW`, `TASK_UPDATE`, `LEARNING`, `NEEDS_REVIEW`, `SCAN_DONE`.

- `marker-parser.js` ignores markers inside fenced code blocks; payloads must be single-line valid
  JSON.
- `marker-applier.js` validates evidence references, allowed patch fields, confidence caps, marker
  ordering, and status/waiting consistency before applying. `NEEDS_REVIEW` and `SCAN_DONE` are
  gateway-exempt; state-changing markers are not.
- `PROJECT_UPDATE.pmStatus` uses replace-semantics: entries that should remain must be re-emitted.

---

## 6. Truth, Learning, and Project-First Consolidation

### 6.1 Truth mechanisms

- **Truth-tree node states** (`NODE_STATES`): `unconfirmed | confirmed | disputed | superseded |
  obsolete`, with `sources[]` and `lastConfirmedByMessageDate`; action nodes add `threadRef`,
  `lastVerifiedMessageDate`, and `resolutionStatus` (`open | resolved | obsolete`). Contradictions
  are `disputed` with both positions, never silently resolved.
- **Evidence enforcement**: status/problem/risk/waiting/user-action changes require an evidence
  reference; new SourceRefs travel on the same marker (atomic); links are copied verbatim from
  WorkIQ (no constructed links or citation tokens); date-only evidence caps confidence at `medium`.
- **Fact Sheets** (`FACTSHEET_UPDATE`): a living per-project record with a fixed English section
  order; patches are additive/corrective, deletions explicit.
- **Temporal precedence**: current WorkIQ evidence outranks old summaries and Brain Learnings.
- **Shared learnings** (`LEARNING`): reusable operating memory only (`principle | pattern | fact`
  with volatility and outcome); negative outcomes quarantine a learning from ranking.
- **Review quarantine**: low-confidence assignment/status decisions and every gate hold become
  review-queue items instead of state.
- **Atomic application**: temp file + fsync + rename with retry and `.bak` rotation.

### 6.2 Project-first consolidation

A project is one real undertaking; workstreams inside it are line items, never separate projects.
New evidence should update an existing project first; one signal creates or updates at most one
project; uncertain ownership → `NEEDS_REVIEW`. Merge is a safety net (identity gate +
`reconcileProjectFragments`), not the normal path.

---

## 7. Discovery, Attachments, and Processing-Quality Correction

### 7.1 Discovery coverage contract

Every scan completes two independent semantic passes over the exact
`discoveryWindowStart`/`discoveryWindowEnd` and reports them in
`SCAN_DONE.processingQuality.discoveryPasses`:

- `recent-email-enumeration` — enumerate recent mail without task/urgency/known-project
  allow-lists; page/narrow until the whole window is covered.
- `material-consequence` — independently find communications where inaction risks a material
  consequence, judged by meaning (no sender/subject/keyword allow-lists).

A missing pass or mismatched window boundary makes the run partial.

### 7.2 Processing ledger and attachments

Every surfaced item needs exactly one ledger disposition (`LEDGER_DISPOSITIONS` =
`updates-node | no-change | new-node | conflict | not-this-project | already-processed`; default
lookback `DEFAULT_PROCESSING_LOOKBACK_DAYS = 14`). Every ledger item carries `attachmentsHandled`;
items with attachments may only use `yes(workiq-index)`, `yes`, or `failed(<reason>)` — never
`none`. The default attachment path is a targeted WorkIQ/M365-index probe (indexed content, not raw
bytes). On `content-not-indexed` the brain retries once; a persistent miss becomes
`failed(content-not-indexed)` and is re-probed on later scans (bounded retries, then a cooldown).
Incomplete attachment handling surfaces a source-coverage warning in the UI.

### 7.3 Bounded processing-quality correction (`processing-quality-correction.js`)

Exactly **one** bounded, single-attempt correction runs after the identity gate, and only when the
pre-gateway quality gate reports a `processing-ledger-completeness` gap
(`"missing ledger disposition for enumerated item <key>"`). Two generic repair shapes:

- **Marker-local append** — the held marker enumerated the item; append the missing disposition.
- **Scan-wide mapping** — the item is enumerated only in
  `SCAN_DONE.processingQuality.enumeratedItems` and maps to **exactly one** ledger-capable marker by
  **immutable exact source identity** (`itemId | messageId | internetMessageId`, plus an exact
  `threadRef` when both are present) → append (unambiguous count deficit) or **alias replacement**.

**Alias replacement** is allowed only for one same-thread slot when expected count equals actual;
it rewrites that slot's `itemRef` in place, requiring deep equality in every field except `itemRef`,
never appending/removing/reordering and never changing the thread count.

**Explicitly excluded:** any fuzzy/title/sender/date/topic/threadRef-only mapping; malformed
markers; wrong windows; missing discovery passes; attachment failures; ambiguous/zero/multi marker
mappings; and items absent from all enumeration.

**Re-validation:** corrected markers flow through the same Reality Gateway, final quality gate,
temporal pass, and marker-application validation. Corrections never reach `applyMarkerBatch` as
standalone markers.

**Bounded budgets:** `CORRECTION_TIMEOUT_MS = 8 min`, `CORRECTION_WORKIQ_HARD_LIMIT = 8`,
`CORRECTION_TOOL_HARD_LIMIT = 24`, `CORRECTION_EFFORT = 'xhigh'`, dedicated grammar
`CORRECTION_TAG = LEDGER_CORRECTION`. The pass never loops; on any failure it returns the original
markers unchanged.

**Residual boundary:** an item WorkIQ never enumerated cannot be repaired by the correction pass —
the honest result is a partial/reviewable scan, not an invented item.

---

## 8. Semantic Relevance and UI

### 8.1 Relevance (`brain/relevance.js`)

Each active line item carries `relevance: { score (0–100 int), reason (≤240 chars, plain-English
project consequence, ≥1 evidence ref), evidenceRefIds, assessedAt }`, assessed **independently of
confidence and review status**. Bands: **Act now** 75–100, **Next** 50–74, **Monitor** 25–49,
**Reference** 0–24. `priority` is a compatibility field and never overrides relevance.

### 8.2 UI (`index.html`)

- **Executive Brief** per project (blocker/user-action/risk counts + next milestone).
- **Decision Focus** — top items needing a decision, each with a rationale.
- **Line items** grouped/ordered by relevance band (badge + rationale), then due date and title.
- **Waiting / signals / milestones** and typed fields (owner, due, waiting, problem, risk) render in
  their own slots; **Owner/Due chips are hidden when they carry no meaningful value**.
- **Progressive detail** — deep detail collapsed by default; expands on demand.
- **Responsive** — breakpoints at 840px and 520px; `prefers-reduced-motion` respected.

---

## 9. Safety and Observability

- Evidence enforcement; ambiguity → `NEEDS_REVIEW`; WorkIQ/tool limits (40 warn / 150 stop;
  correction 8/24); path-guarded cleanup (`prepareBrainWorkDir` refuses non-`brain-work` dirs);
  atomic backups.
- Telemetry: `tasks.json` `brain` = `{ engine, model, lastRunId, lastRunAt, lastOutcome,
  lastPremiumRequests, lastWorkIqCalls }`; scan result carries identity/gateway/qualityGate/
  qualityCorrection/temporalGate sub-objects; `SCAN_DONE.processingQuality` reports discovery
  passes, enumerated items, and ledger counts.
- `/api/health` → `{ service, status, uptime, activeSessions, memoryMB, pid, port, version,
  scanEngine, repoPath, wiqPid }`; `wiqPid` is `null` in Agency mode.
- **Model honoring caveat:** the requested model is recorded but not independently proven by the
  command-line flag alone.

---

## 10. Data Schema (v5)

`tasks.json` is schema **version 5** (`migrateToV5`, additive + idempotent).

### 10.1 Project task (`taskType: "project"`)

`sourceRefs[]`, `lineItems[]` (typed fields + truth-tree `state` + `relevance`), `pmStatus`
(`current`, `planned[]`, `userActions[]`, `problems[]`, `risks[]`, `waitingOn[]`, confidence,
`lastSynthesizedAt`), `factSheet`, `brainState` (`lastScanRunId`, `lastEvidenceAt`, `needsReview`,
`reviewReason`, `schemaVersion: 5`), archive/supersession fields, and task history.

### 10.2 Single task (`taskType: "single"`)

A standalone action with the normal task fields.

### 10.3 Document-level

Top-level `version: 5`, `brain` telemetry, `lastScan`, and a `reviewQueue[]` for holds and open
questions.

---

## 11. API Specification

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/jobs` | POST | Create a job; Agency mode: only `kind:"scan"` (merge/consolidate → 409) |
| `/api/jobs` | GET | Active/recent job state |
| `/api/jobs/:jobId` | GET | Full snapshot |
| `/api/jobs/:jobId/cancel` | POST | Request cancellation |
| `/api/jobs/:jobId/reply` | POST | Answer a clarification |
| `/api/events` | GET | SSE stream |
| `/api/tasks` | GET/POST | List tasks / create manual task |
| `/api/tasks/:id` | PATCH/DELETE | Update / delete a task |
| `/api/tasks/:id/note` | POST | Save a quick note |
| `/api/tasks/:id/history/:index` | DELETE | Delete a deletable history entry |
| `/api/health` | GET | Health incl. `scanEngine`, `repoPath`, `wiqPid` |
| `/api/version` | GET | Version + short git SHA |
| `/api/cleanup` | POST | Delete done tasks older than `retentionDays` |

**Legacy-only (409 in Agency mode):** `/api/scan`, `/api/tasks/:id/enrich`,
`/api/tasks/:id/check-update`, `/api/consolidate`, `/api/tasks/merge`, `/api/tasks/:id/review`,
`/api/tasks/:id/correct`, and the `merge` / `consolidate` job kinds.

---

## 12. Skill Files

| Skill file | Role | Path |
|---|---|---|
| `AGENCY_BRAIN_SCAN_SKILL.md` | Primary Agency Brain scan skill + marker contract | `docs/` |
| `SCAN_DISCOVERY_SKILL.md`, `ENRICH_SKILL.md`, `UPDATE_CHECK_SKILL.md`, `SEARCH_SKILL.md`, `CONSOLIDATE_SKILL.md`, `CORRECT_SKILL.md`, `LOG_WORK_SKILL.md` | Legacy SDK skills (fallback only) | `docs/` |

---

## 13. File Structure

```
Agent_Zero/
├── server.js                     Express backend, job registry, legacy route guards
├── index.html                    Single-file frontend
├── package.json                  Dependencies and version 5.1.0
├── mcp.json                      Legacy SDK-only WorkIQ MCP config
├── tasks.json                    Local task storage (schema v5, gitignored)
├── brain-learnings.md            Curated Brain Learnings
├── AGENTS.md                     Agent behavior documentation
├── brain/                        Agency Brain engine (see docs/ARCHITECTURE.md §14)
├── brain-work/                   Agency sandbox
├── docs/
│   ├── AGENCY_BRAIN_SCAN_SKILL.md
│   ├── ARCHITECTURE.md
│   ├── CHANGELOG.md
│   ├── gremium/                  Historical review records (unchanged)
│   └── archive/                  Historical docs (unchanged)
└── tests/unit/                   Node test suite (node --test)
```

For the full engine module map, the gate pipeline, and operational constraints, see
`docs/ARCHITECTURE.md` and `../.github/copilot-instructions.md`.

---

## 14. Known Limitations and Boundaries

- Never-enumerated items cannot be repaired by the correction pass.
- Attachment bytes are not fetched; only indexed content, with re-probe on index lag.
- Requested model is recorded but not independently verified.
- The Reality Gateway fails closed; a run can be partial without any brain error.
- The legacy four-phase SDK engine is fallback-only (`AGENT_ZERO_SCAN_ENGINE=legacy`).
