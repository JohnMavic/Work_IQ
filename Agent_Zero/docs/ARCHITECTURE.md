# Agent Zero — Architecture

> Version 5.1.0 · July 15, 2026 · Author: Martin Hämmerli
>
> _Built with AI, powered by curiosity._

Agent Zero is a personal project-task tracker for Microsoft 365. It scans recent mail and
Teams activity, groups related signals into **project tasks** with **line items** and living
**Fact Sheets**, and keeps standalone actions as **single tasks**. The current default engine
is the **Agency Brain**: an `agency.exe copilot` child process that reads a rendered
task-state sandbox, calls WorkIQ through inherited Copilot MCP configuration, and returns
validated marker lines that the server applies to `tasks.json`.

This document describes the current code. The previous four-phase Copilot-SDK pipeline is
retained only as an explicit legacy fallback (`AGENT_ZERO_SCAN_ENGINE=legacy`).

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [Scan Engine Model](#3-scan-engine-model)
4. [Agency Brain Scan Pipeline](#4-agency-brain-scan-pipeline)
5. [Marker Protocol](#5-marker-protocol)
6. [Truth and Learning Mechanisms](#6-truth-and-learning-mechanisms)
7. [Project-First Consolidation](#7-project-first-consolidation)
8. [Discovery Coverage and Attachments](#8-discovery-coverage-and-attachments)
9. [Processing-Quality Correction Pass](#9-processing-quality-correction-pass)
10. [Semantic Relevance and UI](#10-semantic-relevance-and-ui)
11. [Safety and Observability](#11-safety-and-observability)
12. [Data Model (schema v5)](#12-data-model-schema-v5)
13. [API Reference](#13-api-reference)
14. [File Structure](#14-file-structure)
15. [Known Limitations and Boundaries](#15-known-limitations-and-boundaries)

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (index.html)                     │
│  Dark SPA · Executive Brief · Decision Focus · Line items    │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP (localhost:3000) + SSE
┌────────────────────────────┴────────────────────────────────┐
│                    Express Server (server.js)                │
│  Job registry · Scan orchestration · Task persistence        │
│  Legacy route guards (409 unless AGENT_ZERO_SCAN_ENGINE=legacy)│
└────────┬───────────────────────────────┬────────────────────┘
         │ POST /api/jobs kind:"scan"     │ fs (atomic read/write)
┌────────┴─────────────────┐     ┌────────┴────────────┐
│  brain/scan-brain.js     │     │  tasks.json         │
│  runBrainScanOnce()      │     │  schema v5, gitignored│
└────────┬─────────────────┘     └─────────────────────┘
         │ render-scan-state.js → brain-work/ sandbox
         ▼
┌──────────────────────────────────────────────────────────────┐
│  brain/brain-runner.js → spawns agency.exe copilot            │
│  --model claude-opus-4.8 --add-dir brain-work                 │
│  bootstrap = AGENCY_BRAIN_SCAN_SKILL.md + Run Context         │
└────────┬───────────────────────────────────────────────────────┘
         │ inherits ~/.copilot/mcp-config.json
         ▼
     WorkIQ MCP ── Microsoft 365 (mail · Teams · attachments)
```

**Data flow:** Browser → Express job → render state into `brain-work/` → Agency child →
WorkIQ → marker output → gate pipeline → atomic write to `tasks.json` → SSE back to browser.

**External write guardrail:** Agent Zero may read, research, browse, and download evidence
freely. It must not send mail, click approvals, create calendar items, update tickets, or
mutate any external system unless the user explicitly requests that exact write in the same
conversation. All internal state changes go through marker validation, the Reality Gateway,
and atomic writes.

---

## 2. Technology Stack

| Component | Technology | Notes |
|---|---|---|
| Runtime | Node.js | v18+ (`package.json` engines/README) |
| Web framework | Express | 5.x |
| Scan engine | Agency CLI (`agency.exe copilot`) | Spawned per scan; not an npm dependency |
| Requested model | `claude-opus-4.8` | Requested via `--model`; honoring not independently verified |
| M365 data access | WorkIQ MCP | Inherited from `~/.copilot/mcp-config.json` in Agency mode |
| Legacy AI path | `@github/copilot-sdk` + local `@microsoft/workiq` 0.2.8 | Only active with `AGENT_ZERO_SCAN_ENGINE=legacy` |
| Frontend | Single-file HTML/CSS/JS | No build step |
| Data storage | JSON file (`tasks.json`, schema v5) | Atomic writes + `.1.bak`–`.3.bak` rotation |
| Module system | ES Modules | `"type": "module"` |

### Agency runner configuration (`brain/agency-cli.js`, `brain/brain-runner.js`)

- `COPILOT_MODEL = 'claude-opus-4.8'`, `COPILOT_EFFORT = 'xhigh'` (default),
  `COPILOT_CONTEXT = 'long_context'`.
- `buildAgencyArgs()` pins `--model`, `--effort`, `--context`, adds `--add-dir <brain-work>`,
  `--allow-all-tools`, `--yolo`, `--no-ask-user`, `--no-auto-update`, and disables built-in MCPs
  when `mcpMode === 'none'`. `buildAgencyEnv()` strips `AGENCY_SESSION_ID` and
  `COPILOT_AGENT_SESSION_ID` so a parent session cannot bleed into the child.
- `brain-runner.js` limits: default timeout 25 min (`DEFAULT_TIMEOUT_MS`), tool-start warning at
  40 (`DEFAULT_TOOL_CALL_WARN_THRESHOLD`), emergency stop at 150 (`DEFAULT_TOOL_CALL_HARD_LIMIT`,
  which also bounds WorkIQ starts). `prepareBrainWorkDir()` refuses to clean any directory whose
  basename is not `brain-work`.

> **Model caveat:** the requested model is recorded in `tasks.json` brain telemetry
> (`brain.model`), but requesting a model through a command-line flag does not by itself prove
> which model actually served the run.

---

## 3. Scan Engine Model

`getScanEngine()` (`brain/scan-brain.js`) returns `'agency'` only when
`AGENT_ZERO_SCAN_ENGINE === 'agency'`, otherwise `'legacy'`.

- **Operational default is Agency.** `START-AGENT-ZERO.bat` and `Start-WorkIQ-Scan.ps1` set
  `AGENT_ZERO_SCAN_ENGINE=agency` when the variable is unset.
- **A bare `node server.js` inherits the environment as-is**, so set the variable explicitly for
  a manual Agency run, or set `AGENT_ZERO_SCAN_ENGINE=legacy` for the old SDK routes.
- In Agency mode the server does **not** start a persistent WorkIQ subprocess. WorkIQ is reached
  through the user's inherited Copilot MCP configuration.
- The repo `mcp.json` and the local `@microsoft/workiq` dependency are **legacy-only** and are
  not read by the Agency runner.

Legacy SDK endpoints (`/api/scan`, `/api/tasks/:id/enrich`, `/api/tasks/:id/check-update`,
`/api/consolidate`, `/api/tasks/merge`, `/api/tasks/:id/review`, `/api/tasks/:id/correct`) and the
`merge` / `consolidate` job kinds return **409** in Agency mode with an
`AGENT_ZERO_SCAN_ENGINE=legacy` hint.

---

## 4. Agency Brain Scan Pipeline

A scan is one server job (`POST /api/jobs` with `kind:"scan"`) executed by `runScanJob` →
`runAgencyScanJob` → `runBrainScanOnce()`. Phases emit SSE `job.phase_*` events.

```
brain_prepare → brain_run → [brain_quality_correction] → brain_gateway → brain_apply
```

1. **brain_prepare** — `migrateToV5(tasks.json)`; `computeDiscoveryWindow({now, scanDays,
   lastScan})` derives the window (default 4 days, clamped 1–14, with a 14-day recovery floor
   anchored on the last scan); `renderScanState()` writes a compact state document plus spill
   files (Fact Sheets, pmStatus, history, hidden line items, a `temporalReview REQUIRED` spill)
   into the `brain-work/` sandbox.
2. **brain_run** — `buildBootstrapPrompt()` = the `AGENCY_BRAIN_SCAN_SKILL.md` text plus a
   Run Context block (`runId`, `scanDays`, `discoveryWindowStart/End`, `stateFile`).
   `runBrain()` spawns the Agency child, streams JSON events (capturing premium-request counts and
   WorkIQ tool starts), and returns the assistant text.
3. **Parse** — `parseMarkers()` extracts physical `[MARKER] {json}` lines (ignoring fenced code
   blocks). No markers → the job fails; markers but no `SCAN_DONE` → applied as a partial result
   with a review hint.
4. **Project identity gate** — `filterMarkersByProjectIdentity()` resolves each candidate against
   the canonical identity index (project key, normalized title, alias, conversation id, immutable
   source id) so one undertaking never becomes two top-level records; ambiguous cases are held or
   queued for review.
5. **Bounded processing-quality correction** (optional, single attempt) — see §9. Runs only when
   the pre-gateway quality gate reports a correctable ledger omission on the post-identity markers.
6. **brain_gateway** — `runRealityGateway()` performs an independent verification pass;
   `filterMarkersThroughGateway()` combines deterministic marker checks with the gateway decisions.
   Held markers become `NEEDS_REVIEW` items. The gateway **fails closed**: if it cannot be
   verified, non-exempt markers are held.
7. **brain_apply** — the final `filterMarkersByProcessingQualityGate()` (ledger completeness,
   attachment coverage, discovery coverage) and `filterMarkersByTemporalPassGate()` run, then
   `applyMarkerBatch()` applies the surviving markers and `reconcileProjectFragments()` merges any
   stray fragments. Review hints are appended for every held/queued item, telemetry is set, and
   `writeJsonFileAtomic()` persists `tasks.json`.

**Outcome:** `success` only when nothing made the batch partial (no salvage, `SCAN_DONE` present
and not `partial`, no identity/gateway/quality/temporal holds, no dropped markers). Otherwise
`partial`. Only a `success` advances `lastScan`.

---

## 5. Marker Protocol

The Agency Brain never writes files or edits `tasks.json` directly; it emits one marker per
physical line. `MARKER_TYPES` (`brain/marker-parser.js`) is the canonical set:

`PROJECT_NEW`, `PROJECT_UPDATE`, `FACTSHEET_UPDATE`, `LINEITEM_NEW`, `LINEITEM_UPDATE`,
`NODE_OBSOLETE`, `TASK_NEW`, `TASK_UPDATE`, `LEARNING`, `NEEDS_REVIEW`, `SCAN_DONE`.

- `marker-parser.js` ignores marker lines inside fenced code blocks and requires single-line valid
  JSON payloads.
- `marker-applier.js` validates evidence references, allowed patch fields, confidence caps, marker
  ordering, and status/waiting consistency before applying. `NEEDS_REVIEW` and `SCAN_DONE` are
  gateway-exempt; state-changing markers are not.
- `PROJECT_UPDATE.pmStatus` is replace-semantics: the brain must re-emit every entry that should
  remain, or it is removed.

---

## 6. Truth and Learning Mechanisms

Shared, code-backed truth mechanisms apply across discovery, update, and merge-like behavior.

- **Truth tree / node states** (`brain/truth-tree.js`): every emitted or changed node carries a
  `state` from `NODE_STATES` = `unconfirmed | confirmed | disputed | superseded | obsolete`, plus
  `sources[]` and `lastConfirmedByMessageDate`. Action-like nodes also carry `threadRef`,
  `lastVerifiedMessageDate`, and `resolutionStatus` (`open | resolved | obsolete`). Contradictions
  are marked `disputed` with both positions, never silently resolved.
- **SourceRefs / evidence enforcement**: every new or changed status, problem, risk, waiting item,
  or user action requires an evidence reference. New evidence and its full SourceRef travel on the
  same marker (atomic); links must be copied verbatim from WorkIQ (no constructed links or
  citation tokens). Date-only evidence caps confidence at `medium`.
- **Fact Sheets** (`FACTSHEET_UPDATE`): each project has a living Fact Sheet with a fixed English
  section order (Overview; Scope & Goals; Timeline & Milestones; Budget/Costs/Approvals; Status;
  Opportunities; Risks & Challenges; People & Roles; Decision Makers; Decisions Log; Open Actions;
  Sources). Patches are additive/corrective; deletions require an explicit `op:"remove"` with a
  reason and evidence.
- **Temporal precedence**: current WorkIQ evidence outranks old summaries and Brain Learnings.
  Historical facts are labeled as such when newer evidence supersedes them.
- **Shared learnings** (`brain/learnings.js`, `brain-learnings.md`): `LEARNING` markers store
  reusable operating memory only — categories `principle | pattern | fact`, a `volatility` and an
  `outcome`. Negative outcomes (`needs_review | failed | contradicted`) quarantine a learning from
  ranking. Learnings are methods/memory, never evidence that a current source still holds a state.
- **Review quarantine**: low-confidence assignment/status decisions become `NEEDS_REVIEW` rather
  than being applied. Gateway/identity/quality/temporal holds all land in the review queue.
- **Atomic state application**: `writeJsonFileAtomic()` writes through a temp file, fsync, and
  rename (with retry for transient Windows rename failures) and rotates up to three `.bak` files.

---

## 7. Project-First Consolidation

A **project** is one real undertaking (typically a place plus purpose, a migration, a procurement,
a rollout, or an initiative). Different workstreams inside the same undertaking are **line items**,
never separate projects.

- A single project task holds many line items / subtopics (`category`:
  `workstream | action | decision | dependency | risk | info`), plus a synthesized `pmStatus` and
  a Fact Sheet.
- New evidence should **update an existing project first**. Not updating an existing project when
  the evidence clearly belongs there is a defect.
- One signal creates or updates **at most one** project. New projects are created only for a
  genuinely separate undertaking. Uncertain ownership or granularity → `NEEDS_REVIEW`.
- **Merge is a safety net, not the normal path.** The identity gate and
  `reconcileProjectFragments()` catch stray fragments after the fact; the intended behavior is to
  match the canonical identity up front and attach to the existing project. (The legacy
  consolidate/merge endpoints exist only in legacy mode.)

---

## 8. Discovery Coverage and Attachments

### Discovery window

`computeDiscoveryWindow()` produces the exact `discoveryWindowStart` / `discoveryWindowEnd` passed
in Run Context. `scanDays` defaults to 4 and is clamped to 1–14; the start is additionally pulled
back toward the last scan but never earlier than a 14-day recovery floor, so late-indexed messages
are reconsidered.

### Two independent semantic passes

Every scan must complete both passes over the same window and report them in
`SCAN_DONE.processingQuality.discoveryPasses`:

- **`recent-email-enumeration`** — enumerate the recent mail set without requiring a task, request,
  urgency phrase, or known-project match; page/narrow by time until the whole window is covered.
- **`material-consequence`** — independently find communications where inaction could cause a
  material consequence (security, access, compliance, account, device, service, financial,
  operational, or project). Judged by meaning, not by sender/subject/keyword allow-lists.

A missing pass or a mismatched window boundary makes the run partial.

### Processing ledger

For every surfaced item, exactly one ledger disposition is required before mutations apply.
`LEDGER_DISPOSITIONS` = `updates-node | no-change | new-node | conflict | not-this-project |
already-processed`; the default lookback is `DEFAULT_PROCESSING_LOOKBACK_DAYS = 14`. `ledgerCounts`
counts dispositions per thread (never M365 message counts, which live in `threadCheck.messageCount`).

### Attachment dispositions

Every ledger item carries `attachmentsHandled`. Items with attachments may only use
`yes(workiq-index)`, `yes`, or `failed(<reason>)` — never `none`. The default attachment path is a
targeted WorkIQ/M365-index probe (WorkIQ surfaces indexed attachment content, not raw bytes; mail
MCPs deliver message bodies only). On `content-not-indexed` the brain retries once with an
alternative formulation; a persistent miss becomes `failed(content-not-indexed)` and the item is
re-probed on later scans (bounded retries then a cooldown-based `reprobeAfter`). Source-coverage
warnings surface when attachment handling is incomplete.

### Residual boundary

Discovery/quality gates can flag a missed enumeration and the correction pass can supply a missing
ledger disposition for an **already-enumerated** item — but **an item WorkIQ never enumerated
cannot be repaired by any correction pass.** If a message is never surfaced, it is simply not in
scope for that run; the honest outcome is a partial/reviewable scan, not an invented item.

---

## 9. Processing-Quality Correction Pass

`brain/processing-quality-correction.js` implements **exactly one** bounded, single-attempt
correction after the initial scan and project-identity gate. It repairs only provable *processing
omissions* and carries no topic-specific rules.

**When it runs:** only when the pre-gateway `filterMarkersByProcessingQualityGate()` reports a
`processing-ledger-completeness` gap whose reason matches exactly
`"missing ledger disposition for enumerated item <key>"`.

**What it may do (two generic shapes):**

- **Marker-local append** — the held marker itself enumerated the item; append the one missing
  disposition to that marker's `processingLedger`.
- **Scan-wide mapping** — the item is enumerated only in
  `SCAN_DONE.processingQuality.enumeratedItems` and maps to **exactly one**
  processing-ledger-capable marker by **immutable exact source identity** (a SourceRef
  `itemId | messageId | internetMessageId` equal to the enumerated id, plus an exact `threadRef`
  when both are present). This yields either an **append** (no same-thread slot yet and an
  unambiguous expected-count deficit) or an **alias replacement**.

**Alias replacement rule:** allowed only for exactly one same-thread ledger slot when the expected
count already equals the actual count. It rewrites that slot's `itemRef` in place, requiring the
replacement to be **deep-equal to the existing slot in every field except `itemRef`**. It never
appends, removes, or reorders any ledger item, and never changes the thread's count.

**Explicitly excluded:** any fuzzy/title/sender/date/topic/threadRef-only mapping; malformed
markers; wrong windows; missing discovery passes; attachment failures; ambiguous, zero, or
multi-marker mappings; and items absent from all enumeration. Anything excluded simply leaves the
scan partial/reviewable.

**Re-validation:** corrected markers are produced on a deep copy and then flow through the **same**
Reality Gateway, final processing-quality gate, temporal pass, and marker-application validation as
uncorrected markers. Corrections never reach `applyMarkerBatch` as standalone markers.

**Bounded budgets (exact constants):**

| Constant | Value |
|---|---|
| `CORRECTION_TIMEOUT_MS` | `8 * 60 * 1000` (8 min) |
| `CORRECTION_WORKIQ_HARD_LIMIT` | `8` |
| `CORRECTION_TOOL_HARD_LIMIT` | `24` |
| `CORRECTION_EFFORT` | `'xhigh'` |
| `CORRECTION_TAG` | `LEDGER_CORRECTION` (dedicated grammar, not a marker) |

The pass never loops. On any throw, non-ok run, empty/malformed output, or leftover gap it returns
the **original** markers unchanged so the caller continues safely with existing partial/review
behavior. Correction telemetry (attempted, eligible issues, parsed/applied/rejected, pre/post gate
ok, WorkIQ calls, duration) is recorded on the scan result under `qualityCorrection`.

---

## 10. Semantic Relevance and UI

### Model-assessed relevance (`brain/relevance.js`)

Each active line item carries `relevance: { score, reason, evidenceRefIds, assessedAt }`. `score`
is an integer 0–100; `reason` is a plain-English project-level consequence (max
`RELEVANCE_REASON_MAX_CHARS = 240`, at least one evidence reference required). Relevance is assessed
**independently of confidence and review status** — a high-relevance item can still be low-confidence
or under review.

Bands (`relevanceBand()` in code, mirrored in the UI):

| Band | Score | UI label |
|---|---|---|
| `act-now` | 75–100 | Act now |
| `next` | 50–74 | Next |
| `monitor` | 25–49 | Monitor |
| `reference` | 0–24 | Reference |

`priority` remains a compatibility field but never overrides relevance ordering.

### UI (`index.html`)

- **Executive Brief** — a per-project header summarizing blocker/user-action/risk counts and the
  next milestone so the project is understandable without rereading the source stream.
- **Decision Focus** — the top items that need a decision, each with a short rationale.
- **Line items** are grouped and ordered by relevance band (badge + project-level rationale), then
  by due date and title; items without relevance fall back after ranked items.
- **Waiting / signals / milestones** and typed fields (owner, due, waiting dependency, problem,
  risk) render in their own slots; **Owner/Due chips stay hidden when they carry no meaningful
  value** (`meta.owner ? … : ''`, `dueDate ? … : ''`), avoiding placeholder noise.
- **Progressive line-item detail** — deep detail stays collapsed by default and expands on demand.
- **Responsive** — breakpoints at 840px and 520px adapt the Executive Brief grid and Decision Focus
  layout for desktop and mobile; `prefers-reduced-motion` is respected.
- **Source coverage** — failed/incomplete attachment handling surfaces an explicit incomplete
  source-coverage indicator.

---

## 11. Safety and Observability

- **Evidence enforcement** — status/problem/risk/waiting/user-action changes require evidence
  references (§6). `pmStatus.userActions` is only for actions the app user must personally do.
- **Ambiguity → `NEEDS_REVIEW`** — low-confidence assignment/status decisions and every gate hold
  are quarantined into the review queue instead of being applied.
- **WorkIQ / tool limits** — `brain-runner.js` warns at 40 tool starts and emergency-stops at 150;
  the correction pass is capped at 8 WorkIQ / 24 tool starts and an 8-minute timeout.
- **Path-guarded cleanup** — `prepareBrainWorkDir()` refuses to clean anything whose basename is
  not `brain-work`. Server process hygiene is path-restricted to the install directory (see
  `../.github/copilot-instructions.md`).
- **Atomic backups** — `writeJsonFileAtomic()` uses temp file + fsync + rename with retry and
  rotates `.1.bak`–`.3.bak`.
- **Telemetry & processing-quality fields** — `tasks.json` `brain` records
  `engine`, `model`, `lastRunId`, `lastRunAt`, `lastOutcome`, `lastPremiumRequests`,
  `lastWorkIqCalls`. The scan result carries identity/gateway/qualityGate/qualityCorrection/
  temporalGate sub-objects and dropped/applied marker counts. `SCAN_DONE.processingQuality` reports
  discovery passes, enumerated items, and ledger counts.
- **`/api/health`** — `{ service, status, uptime, activeSessions, memoryMB, pid, port, version,
  scanEngine, repoPath, wiqPid }`. In Agency mode `wiqPid` is `null` because no persistent WorkIQ
  subprocess is owned by the server; scheduler scripts accept that.
- **Model honoring caveat** — a requested model (`--model claude-opus-4.8`) is recorded but not
  independently proven by the flag; observability shows what was *requested*, not verified serving.

---

## 12. Data Model (schema v5)

`tasks.json` is schema **version 5** (`migrateToV5()` sets `data.version = 5`; per-task
`brainState.schemaVersion = 5`). Migration is additive and idempotent and quarantines unsupported
legacy resolution statuses.

**Project task** (`taskType: "project"`):

- `sourceRefs[]` — evidence from email / Teams / manual sources (immutable ids + verbatim links)
- `lineItems[]` — workstreams/actions/decisions/dependencies/risks/info, each with typed fields,
  a truth-tree `state`, and `relevance`
- `pmStatus` — synthesized `current`, `planned[]`, `userActions[]`, `problems[]`, `risks[]`,
  `waitingOn[]`, with confidence and `lastSynthesizedAt`
- `factSheet` — the living deep-evidence record (fixed section order)
- `brainState` — per-task telemetry / review flags (`lastScanRunId`, `lastEvidenceAt`,
  `needsReview`, `reviewReason`, `schemaVersion`)
- archive / supersession fields for migrated or reconciled tasks, plus normal task history

**Single task** (`taskType: "single"`) — a standalone action with the normal task fields.

Top-level `brain` telemetry and a `reviewQueue[]` (holds/questions) round out the document.

---

## 13. API Reference

| Endpoint | Method | Purpose |
|---|---|---|
| `/api/jobs` | POST | Create a job. In Agency mode only `kind:"scan"` is active; `merge`/`consolidate` return 409. |
| `/api/jobs` | GET | Active/recent job state (SSE hydration) |
| `/api/jobs/:jobId` | GET | Full job snapshot |
| `/api/jobs/:jobId/cancel` | POST | Request cancellation |
| `/api/jobs/:jobId/reply` | POST | Answer a clarification |
| `/api/events` | GET | SSE event stream |
| `/api/tasks` | GET | All tasks |
| `/api/tasks` | POST | Create a manual task |
| `/api/tasks/:id` | PATCH | Update task fields |
| `/api/tasks/:id` | DELETE | Delete a task |
| `/api/tasks/:id/note` | POST | Save a quick note |
| `/api/tasks/:id/history/:index` | DELETE | Delete a deletable history entry |
| `/api/health` | GET | Health, PID, version, `scanEngine`, `repoPath`, `wiqPid` |
| `/api/version` | GET | App version + short git SHA |
| `/api/cleanup` | POST | Delete done tasks older than `retentionDays` |

**Legacy-only (409 in Agency mode):** `/api/scan`, `/api/tasks/:id/enrich`,
`/api/tasks/:id/check-update`, `/api/consolidate`, `/api/tasks/merge`, `/api/tasks/:id/review`,
`/api/tasks/:id/correct`, and the `merge` / `consolidate` job kinds.

---

## 14. File Structure

```
Agent_Zero/
├── server.js                     Express backend, job registry, legacy route guards
├── index.html                    Single-file frontend (Executive Brief, relevance UI)
├── package.json                  Dependencies and version 5.1.0
├── mcp.json                      Legacy SDK-only WorkIQ MCP config
├── tasks.json                    Local task storage (schema v5, gitignored)
├── brain-learnings.md            Curated Brain Learnings (operating memory)
├── AGENTS.md                     Agent behavior documentation
├── brain/
│   ├── agency-cli.js             Agency executable, pinned args, child environment
│   ├── brain-runner.js           Agency child runner, tool/WorkIQ limits, sandbox guard
│   ├── scan-brain.js             Scan orchestration (runBrainScanOnce)
│   ├── render-scan-state.js      brain-work/ state + spill renderer
│   ├── marker-parser.js          Marker grammar / MARKER_TYPES
│   ├── marker-applier.js         Marker validation + atomic application
│   ├── project-identity.js       Canonical identity gate + fragment reconciliation
│   ├── reality-gateway.js        Independent verification gateway (fail-closed)
│   ├── processing-ledger.js      Ledger dispositions + processing-quality gate
│   ├── processing-quality-correction.js  Bounded single-attempt correction pass
│   ├── temporal-pass.js          Stale-date temporal gate
│   ├── truth-tree.js             Node states + action gate
│   ├── relevance.js              Semantic relevance bands/validation
│   ├── learnings.js              LEARNING parsing/ranking/rendering
│   └── tasks-v5.js               v5 migration + atomic writes
├── brain-work/                   Agency sandbox (rendered state + spill files)
├── docs/
│   ├── AGENCY_BRAIN_SCAN_SKILL.md   Primary scan skill + marker contract
│   ├── ARCHITECTURE.md
│   ├── CHANGELOG.md
│   ├── gremium/                  Historical review records (unchanged)
│   └── archive/                  Historical docs (unchanged)
└── tests/unit/                   Node test suite (node --test)
```

For detailed operational constraints, also read
[`../.github/copilot-instructions.md`](../.github/copilot-instructions.md).

---

## 15. Known Limitations and Boundaries

- **Never-enumerated items cannot be repaired.** The correction pass only supplies a missing
  disposition for an item the scan already enumerated; a message WorkIQ never surfaced is out of
  scope for that run.
- **Attachment bytes are not fetched.** WorkIQ surfaces indexed attachment content; raw bytes are
  not retrieved. Index lag can force `failed(content-not-indexed)` and a later re-probe.
- **Model honoring is unverified.** The requested model is recorded but not independently proven by
  the command-line flag.
- **Gateway fails closed.** If the Reality Gateway cannot be verified, non-exempt markers are held
  rather than applied — a run can be partial without any brain error.
- **Legacy engine is fallback-only.** The four-phase SDK routes exist for troubleshooting under
  `AGENT_ZERO_SCAN_ENGINE=legacy` and are not maintained as the primary path.
