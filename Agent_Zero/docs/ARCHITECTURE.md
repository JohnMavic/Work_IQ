# Agent Zero — Architecture

> Version 3.2.2 · April 11, 2026 · Author: Martin Hämmerli

Agent Zero is a personal action-item tracker that scans Microsoft 365 emails and Teams messages for tasks,
extracts content summaries, and monitors threads for updates — all powered by AI.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [Four-Phase Scan Pipeline](#3-four-phase-scan-pipeline)
4. [Data Schema (v3)](#4-data-schema-v3)
5. [API Reference](#5-api-reference)
6. [Frontend Architecture](#6-frontend-architecture)
7. [Skill Files](#7-skill-files)
8. [Work IQ Integration](#8-work-iq-integration)
9. [File Structure](#9-file-structure)
10. [Known Limitations](#10-known-limitations)

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                     Browser (index.html)                    │
│  Dark-themed SPA · Filter bar · Task cards · Agent panels   │
└────────────────────────────┬────────────────────────────────┘
                             │ HTTP (localhost:3000)
┌────────────────────────────┴────────────────────────────────┐
│                    Express Server (server.js)                │
│  REST API · Scan orchestration · Skill file loader          │
└────────┬───────────────────────────────┬────────────────────┘
         │ Copilot SDK (stdio)           │ fs (read/write)
┌────────┴────────────┐         ┌────────┴────────────┐
│   Work IQ MCP       │         │   tasks.json        │
│   @microsoft/workiq │         │   Local file store   │
└────────┬────────────┘         └─────────────────────┘
         │ Microsoft Search API
┌────────┴────────────────────────────────────────────────────┐
│              Microsoft 365 (Emails · Teams · Calendar)       │
└─────────────────────────────────────────────────────────────┘
```

**Data flow:** Browser → Express → Copilot SDK → Work IQ MCP → Microsoft 365 → back up the chain.

**Session lifecycle management:** Each SDK-based scan operation (Phases 2, 3, search, correction) creates a fresh Copilot SDK session. Phase 1 uses a different path — it communicates with the Work IQ subprocess directly via JSON-RPC (no SDK session needed). All SDK sessions are tracked in a global `activeSessions` Set and guaranteed to be destroyed via `destroySession()` in finally blocks, graceful shutdown handlers (SIGINT/SIGTERM), and a startup orphan reaper. A session slot limiter (`waitForSDKSlot()`) caps concurrent SDK sessions at 2.

---

## 2. Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | v22.15.0 |
| Web framework | Express | 5.2.1 |
| AI orchestration | @github/copilot-sdk | 0.2.1 |
| M365 data access | @microsoft/workiq | 0.2.8 |
| ID generation | uuid | 13.0.0 |
| Frontend | Single-file HTML/CSS/JS | — |
| Data storage | JSON file (tasks.json) | — |
| Module system | ES Modules (ESM) | — |

### Component Roles and Authentication

The Copilot SDK (`@github/copilot-sdk`) does not access AI models directly. It includes the
**Copilot CLI** (`@github/copilot`) as a **bundled npm dependency** — no separate installation
needed. When Agent Zero starts an AI session, the SDK spawns this bundled CLI as a subprocess
and communicates via stdio. The CLI handles authentication, model routing, and API communication
with GitHub's Copilot service.

Work IQ (`@microsoft/workiq`) is started **once at server startup** as a persistent MCP subprocess. It authenticates independently via MSAL (Microsoft Entra ID) and stays alive for the entire server lifetime. Automatic restarts handle crashes (with backoff up to 5 attempts, then a 60s cooldown). Phase 1 communicates with it directly via JSON-RPC (`askWorkIQDirect()`); Phases 2 and 3 connect to it via SDK `createSession()`.

```
server.js startup
  ├── new CopilotClient()
  │     └── spawns: bundled CLI (node_modules/@github/copilot/index.js)
  │           └── auth: GitHub OAuth (auto-login on first use, useLoggedInUser: true)
  │           └── connects to: GitHub Copilot API (AI models)
  │
  └── startWorkIQMCP()  ← runs ONCE at startup, persistent subprocess
        └── spawns: node_modules/.bin/workiq mcp (pinned local install, 0.2.8)
              └── auth: MSAL token (stored after `workiq accept-eula`)
              └── connects to: Microsoft Graph / Microsoft Search API
              └── auto-restarts on crash (max 5, then 60s cooldown)

Phase 1 → askWorkIQDirect()  ← JSON-RPC directly to persistent subprocess
Phases 2, 3 → createSession({ mcpServers: { workiq: ... } }) ← SDK sessions
```

| Component | Install | Role | Auth |
|---|---|---|---|
| Copilot SDK | `npm install` (project dep) | Node.js library — manages AI sessions and prompts | — |
| Copilot CLI | Bundled with SDK (automatic) | AI runtime — spawned by SDK to talk to GitHub's API | GitHub OAuth (auto-login on first start) |
| Work IQ | `npm install` (local dep, pinned 0.2.8) | Persistent MCP subprocess for M365 email/Teams/calendar data | MSAL (`workiq accept-eula`) |

**Model selection:** Intent analysis and correction verification now rely on the Copilot CLI's default model routing. The previous explicit Claude Opus 4.6 override was removed.

---

## 3. Four-Phase Scan Pipeline

The scan runs four sequential phases when the user clicks "Scan". Phase 4 can also be
triggered independently via the "🔗 Find Duplicates" button. Each phase processes tasks
one-by-one to avoid Work IQ timeouts.

```
Phase 1: Discovery          Phase 2: Enrichment         Phase 3: Update Check        Phase 4: Consolidation
─────────────────────       ─────────────────────       ─────────────────────        ─────────────────────
Naive hybrid action scan    Extract full content        Check for new replies        Find related tasks
~30-60s total               ~60-180s per task           ~30-90s per task             ~5-15s total

  ┌──────────┐               ┌──────────┐               ┌──────────┐                ┌──────────┐
  │ Work IQ  │               │ Work IQ  │               │ Work IQ  │                │ No MCP   │
  │ "Which   │               │ "Find ALL│               │ "Any new │                │ "Compare │
  │ messages │               │ messages │               │ replies  │                │ all task │
  │ need my  │               │ about X" │               │ since Y?"│                │ summaries│
  │ action?" │               │          │               │          │                │          │
  └────┬─────┘               └────┬─────┘               └────┬─────┘                └────┬─────┘
       │                          │                          │                            │
  New/Update/Skip            Summary + Confidence       Update or No-change          Merge suggestions
```

### Phase 1: Discovery

**Endpoint:** `POST /api/scan`
**Timeout:** 300s (with retry at reduced context)
**Primary prompt:** Inline natural language question — **"Which messages need my action?"**
**Fallback prompt:** `SCAN_DISCOVERY_SKILL.md` (legacy backup)

1. Load existing tasks as deduplication context (50 active + 30 done)
2. Send the inline discovery question + context to Work IQ via Copilot SDK
3. AI performs a naive hybrid first pass over recent messages and returns a JSON array with `action` per item:
   - `"new"` → create task with `enrichmentStatus: 'pending'`
   - `"update"` → modify existing task (title, date, status)
   - `"skip"` → item matches a done task, ignore
4. Return: `{ added, skipped, updated, total, newTaskIds }`

### Phase 2: Enrichment

**Endpoint:** `POST /api/tasks/:id/enrich`
**Timeout:** 300s
**Skill:** `ENRICH_SKILL.md`

1. Skip if `enrichmentStatus` is already `'enriched'` or `'needs-review'`
2. Extract keywords from task title (stopword-filtered, max 8 tokens)
3. Parse link for Teams Thread-ID or Outlook ItemID (regex)
4. Build prompt: keywords + link context + sender as hint (not filter)
5. AI searches Work IQ, returns `{ summary, confidence, language }`
6. Save summary to task, set `enrichmentStatus: 'enriched'`
7. On failure: set `enrichmentStatus: 'error'`, log details to history

**Frontend loop:** Iterates all tasks where `enrichmentStatus === 'pending'` and `status !== 'done'`.
Each task is frozen (neon cyan border) during processing, then auto-refreshed.

### Phase 3: Update Check

**Endpoint:** `POST /api/tasks/:id/check-update`
**Skill:** `UPDATE_CHECK_SKILL.md`
**Timeout:** 300s

1. Set `updateCheckStatus: 'checking'`
2. Extract keywords from title (same stopword filtering as Phase 2)
3. Build link context (Teams Thread-ID, Outlook ItemID)
4. Temporal anchor: `lastUpdateCheck || enrichedAt || createdAt` — only messages AFTER this date count
5. Ask Work IQ via skill prompt: "Find conversation, check for messages after [last-checked date]"
6. If update found: append to summary with `📌 Update:` prefix, set `updateCheckStatus: 'updated'`, set `status: 'updated'`
7. **Post-update evaluation:** Second AI call (pure reasoning, no Work IQ) evaluates whether title and summary should be intelligently rewritten based on the new findings. If yes, overwrites the crude append with a refined version. Non-fatal fallback: crude append remains if evaluation fails.
8. If no update: set status `'checked'`, log "no new activity"
9. Runs EVERY scan cycle (unlike enrichment which is one-time)

**Frontend loop:** Iterates all tasks where `enrichmentStatus === 'enriched' || 'needs-review'` and `status !== 'done'`.

### Verify-and-Improve Loop

Used for update-intent rewriting and post-update refinement when the agent changes existing task content.

1. **Execute** — first LLM call applies the requested update.
2. **Verify** — second LLM call checks whether the result actually matches the user's intent and preserves critical context.
3. **Improve** — optional third LLM call rewrites the result if verification finds issues.

- **Architecture:** Each step is a separate pure-reasoning LLM call; no Work IQ MCP is needed.
- **Retry policy:** Maximum 1 improve retry.
- **Graceful degradation:** If Verify or Improve fails, the original Execute result is kept instead of failing the user action.

### Phase 4: Task Consolidation

**Endpoint:** `POST /api/consolidate`
**Skill:** `CONSOLIDATE_SKILL.md`
**Timeout:** 300s
**Trigger:** Automatically after Phase 3, or manually via "🔗 Find Duplicates" button

1. Collect all active tasks (status ≠ done) with existing summaries
2. Create a Copilot SDK session **without MCP** (pure reasoning, no Work IQ needed)
3. Send all task titles and summaries to AI for semantic comparison
4. AI identifies groups of tasks that cover the same topic
5. Filter out previously dismissed pairs (bidirectional `noMergeWith` arrays)
6. Enrich suggestions with task details (titles) for frontend display
7. Return merge suggestions to user

**User actions on each suggestion:**
- **Merge** (`POST /api/tasks/merge`): AI generates a combined title and summary via Copilot SDK session. Histories are merged chronologically. Secondary task is deleted.
- **Keep Separate** (`POST /api/tasks/:id/dismiss-merge`): Adds bidirectional `noMergeWith` entries on both tasks — this pair will never be suggested again.

**Non-fatal:** Phase 4 failures are silently caught — the scan still completes successfully.

### Scan Resilience Architecture

The scan orchestration in `index.html` is designed to recover phase-by-phase instead of failing as one monolithic job:

- **Phase 1 is non-fatal:** If discovery fails, the UI records the error in the scan report and still continues with already-known pending/enriched tasks.
- **Phase-independent processing:** Phase 2 reloads all `enrichmentStatus: 'pending'` tasks from the server; Phase 3 reloads all `enriched` / `needs-review` tasks. This allows partial recovery after transient failures or server restarts.
- **Per-task retry loops:** Enrichment and update-check retry each task once after a 3-second delay before marking the task as failed.
- **Scan lock + reporting:** A frontend `scanInProgress` lock prevents overlapping scans, while the expandable **Last scan** panel stores per-phase durations, retry counts, failures, and error details.

### Visual Step Indicators

Each task card shows three dots indicating pipeline progress:

```
● ● ●    Step 1 (Discovery) · Step 2 (Enrichment) · Step 3 (Update)
```

| State | Color | CSS Class |
|-------|-------|-----------|
| Pending | Gray | (default) |
| Active | Neon cyan (#00d4ff), pulsing | `.step-active` |
| Done | Green `#22c55e` | `.step-done` |
| Error | Red `#ef4444` | `.step-error` |
| Updated | Yellow `#fbbf24` | `.step-updated` |

---

## 4. Data Schema (v3)

Tasks are stored in `tasks.json` as `{ version: 3, tasks: [...] }`.

### Task Object

```json
{
  "id": "uuid-v4",
  "title": "Submit NSSR for Cisco SSD replacements",
  "source": "email",
  "from": "Jeff Duffield",
  "date": "2026-02-20T08:30:00Z",
  "link": "https://outlook.office365.com/...",
  "status": "new",
  "notes": "",
  "history": [],
  "doneAt": null,
  "enrichmentStatus": "enriched",
  "updateCheckStatus": "checked",
  "enrichedAt": "2026-02-27T16:30:00Z",
  "lastUpdateCheck": "2026-02-27T17:00:00Z",
  "createdAt": "2026-02-27T15:00:00Z",
  "updatedAt": "2026-02-27T17:00:00Z",
  "additionalLinks": [
    { "url": "https://teams.microsoft.com/...", "source": "teams", "from": "Nicola Pettinato" }
  ]
}
```

### Field Reference

| Field | Type | Values |
|-------|------|--------|
| `status` | string | `new`, `in-progress`, `needs-attention`, `escalated`, `updated`, `on-radar`, `paused`, `done` |
| `source` | string | `email`, `teams` |
| `enrichmentStatus` | string | `pending`, `enriching`, `enriched`, `needs-review`, `error`, `n/a` |
| `updateCheckStatus` | string | `pending`, `checking`, `checked`, `updated`, `error`, `n/a` |
| `history` | array | History entries (see below) |

### History Entry

```json
{
  "type": "enriched",
  "timestamp": "2026-02-27T16:30:00Z",
  "text": "✅ Content extraction successful (157s)\n🔑 Searched: cisco ssd zurich circle\n📋 Summary: ..."
}
```

**History types:** `created`, `status-change`, `scan-update`, `note`, `update`,
`enriched`, `enrich-error`, `thread-update`, `update-check`, `update-check-error`,
`summary-update`, `title-change`, `review-response`, `merge`, `correction`,
`correction-veto`, `correction-dismissed`

### Merge Dismissal

Tasks that a user has chosen to "Keep Separate" store a `noMergeWith` array:

```json
{
  "noMergeWith": ["uuid-of-other-task"]
}
```

This is **bidirectional** — both tasks in a dismissed pair reference each other. Phase 4
checks this field before suggesting a merge.

### Additional Links (Merge Preservation)

When tasks are merged manually or via Phase 4, the secondary tasks' source links are preserved:

```json
{
  "additionalLinks": [
    { "url": "https://teams.microsoft.com/...", "source": "teams", "from": "Nicola Pettinato" },
    { "url": "https://outlook.office365.com/...", "source": "email", "from": "Jeff Duffield" }
  ]
}
```

The primary task keeps its own `link` field (backward compatible). Links are deduplicated by URL.

### Agent Plan (v2.2)

Search history entries include `agentPlan` with the analyze phase output:

| Field | Type | Description |
|-------|------|-------------|
| `intent` | string | `update`, `search`, `summarize`, `answer`, `rename`, `correct`, or `review` — determines rendering path |
| `understanding` | string | Action plan: what the agent will search |
| `expectedAnswer` | string | What KIND of answer the user needs (v2.2) |
| `keywords` | string[] | Search terms in user's language |
| `keywordsEnglish` | string[] | English translations of keywords (v2.2) |
| `timeWindow` | object | `{ from, to, reasoning }` |
| `searchTargets` | string | `inbox`, `sent`, `teams`, or `all` |

### Agent Execution (v2.2)

Search history entries include `agentExecution` with execution details:

| Field | Type | Description |
|-------|------|-------------|
| `method` | string | `copilot-sdk-search-skill` (v2.2), `copilot-sdk-legacy`, `copilot-sdk-minimal` |
| `confidence` | string | `high` / `medium` / `low` / `none` (v2.2) |
| `answer` | string | Agent's direct answer to the user's question (v2.2) |
| `searchAttempts` | array | `[{ attempt, strategy, found, relevant }]` (v2.2) |
| `ambiguities` | string[] | Questions for the user (v2.2) |
| `promptSent` | string | Context string sent to AI |
| `rawResponse` | string | Truncated raw AI response |
| `parsedCount` | number | Number of communications parsed |
| `durationMs` | number | Total search duration |
| `error` | string | Error message if search failed |

### Post-Search Evaluation (v2.3)

After a search returns results, a second AI evaluation (pure reasoning, no Work IQ) checks whether the task's title and summary should be updated based on the new findings. This step runs automatically and is non-blocking — if it fails, the search results are already saved.

**Flow:** Search completes → history entry saved → evaluation prompt sent (CopilotClient session without MCP) → if title/summary changed: additional `title-change` / `summary-update` history entries created → response includes `evaluation` field.

**Evaluation response field:**

| Field | Type | Description |
|-------|------|-------------|
| `titleChanged` | boolean | Whether the title was updated |
| `newTitle` | string | New title text (only present if titleChanged) |
| `summaryChanged` | boolean | Whether the summary was updated |
| `newSummary` | string | Updated summary text (only present if summaryChanged) |
| `reasoning` | string | Why changes were or were not needed |

### Schema Migrations

Three migrations run automatically on server startup:

1. **v1 → v2:** Adds `history[]`, `doneAt`, `agentPlan`, `agentExecution`
2. **Status migration:** Renames `active` → `new`
3. **v2 → v3:** Adds `enrichmentStatus`, `updateCheckStatus`, `enrichedAt`, `lastUpdateCheck`

Additionally, stuck statuses are reset: `enriching` → `pending`, `checking` → `pending`.

---

## 5. API Reference

| Method | Path | Purpose | Timeout |
|--------|------|---------|---------|
| `GET` | `/api/tasks` | List all tasks | — |
| `GET` | `/api/health` | Health check (status, uptime, version, active sessions, SDK info) | — |
| `GET` | `/api/version` | Returns current server version | — |
| `POST` | `/api/tasks` | Create manual task | — |
| `PATCH` | `/api/tasks/:id` | Update fields (status, notes, title, summary, enrichmentStatus, updateCheckStatus) | — |
| `DELETE` | `/api/tasks/:id` | Delete task | — |
| `DELETE` | `/api/tasks/:id/history/:index` | Delete history entry (type `update`, `note`, or `review-response`) | — |
| `POST` | `/api/tasks/:id/note` | Save quick note | — |
| `POST` | `/api/scan` | Phase 1: Discover new tasks | 180s |
| `POST` | `/api/tasks/:id/enrich` | Phase 2: Extract content | 300s |
| `POST` | `/api/tasks/:id/check-update` | Phase 3: Check for updates | 300s |
| `POST` | `/api/consolidate` | Phase 4: Find duplicate/related tasks | 30s |
| `POST` | `/api/tasks/merge` | Merge two or more tasks into one | 30s |
| `POST` | `/api/tasks/:id/dismiss-merge` | Dismiss a merge suggestion (bidirectional) | — |
| `POST` | `/api/tasks/:id/log/analyze` | AI intent analysis (default model, no Work IQ) | 30s |
| `POST` | `/api/tasks/:id/log` | Intelligent search via Copilot SDK + MCP + SEARCH_SKILL.md | 300s |
| `POST` | `/api/tasks/:id/correct` | Correction verification (default model + Work IQ MCP + CORRECT_SKILL.md) | 300s |
| `POST` | `/api/tasks/:id/correct/resolve` | Resolve correction discussion (accept or veto) | — |
| `POST` | `/api/cleanup` | Permanently delete done tasks older than `retentionDays` | — |
| `POST` | `/api/tasks/:id/review` | Ambiguity resolution — user responds to agent's review questions (with MCP research) | 180s |

---

## 6. Frontend Architecture

The entire frontend lives in `index.html` — a single-file dark-themed SPA.

### Color Scheme

| Element | Color |
|---------|-------|
| Background | `#0b0d17` (dark navy) |
| Text | `#e0e0e0` (light gray) |
| Primary button | `#3b82f6` (blue) |
| Freeze border | `#00d4ff` (neon cyan) |
| Cards | `#131627` |
| Borders | `#1e2233` |

### Key Features

- **Add Task modal**: Header button "＋ Add Task" opens a modal with Title, Assignment (agent instruction), and Context (optional background info). After creation, the agent automatically starts processing the assignment — no second step required.
- **Filter bar** with badge counts: All, Attention, New, Escalated, In-Progress, Done, Paused
- **Task cards** with status dropdown, summary section, step indicators, action buttons
- **Step indicator tooltips**: Hover over phase dots for detailed status info (phase name, current action, result)
- **Freeze mode**: Unified neon cyan border + dynamic status badge during **any** AI processing — scan phases, analyzeLog, and executeLog all use the same visual. Frozen tasks block status changes and deletion.
- **Scan abort**: Red "⏹ Stop" button in progress bar — safely stops scan between tasks (waits for current task to finish)
- **Scan report panel**: Expandable **Last scan** panel with per-phase durations, retry counts, task-level failures, and error details
- **Auto-cleanup**: Done tasks are permanently deleted from `tasks.json` after configurable retention period (default 3 days, slider 1–30 days). Cleanup runs on server startup and before each scan.
- **Auto-refresh**: `refreshSingleTask()` re-renders individual cards after agent work
- **Server health check**: Polls `/api/tasks` every 5s when offline, green/red status dot + "Online"/"Offline" label
- **Duplicate instance prevention**: `app.listen()` catches `EADDRINUSE` — if port 3000 is taken, shows clear error and exits with code 1. `START-AGENT-ZERO.bat` also pre-checks via `netstat`.
- **Link opening**: Window or tab mode (user preference persisted in localStorage, defunct split/incognito modes auto-migrated to window)
- **Log work**: Two-phase agent (analyze intent via the default model → intelligent search via SEARCH_SKILL.md or correction verification via CORRECT_SKILL.md with 3-attempt strategy, self-assessment, and confidence levels)
- **Merge Mode**: "🔗 Merge Tasks" button activates multi-select mode — checkboxes appear on all task cards, floating merge bar at bottom with selected count, titles, and Merge/Cancel buttons. ESC exits. Merged tasks preserve all source links via `additionalLinks[]`.
- **Prominent answer display**: When agent returns a direct answer with confidence, it's shown as an always-visible block with color-coded border — never collapsed
- **Detail panel**: Expandable reverse-chronological history with multi-line entries, icons per history type, search attempt details, confidence badges, and relevance annotations

### Key Functions

| Function | Purpose |
|----------|---------|
| `triggerScan()` | Orchestrates all 3 scan phases sequentially, with abort support |
| `abortScan()` | Sets `scanAborted` flag — scan stops after current task finishes |
| `showAddTaskModal()` / `hideAddTaskModal()` | Open/close Add Task modal dialog |
| `addTask()` | Creates task via API, then auto-triggers `analyzeLog()` if assignment provided |
| `renderTasks()` | Renders filtered task list (respects cleanup retention slider) |
| `renderTaskCard(task)` | Renders a single task card (extracted for auto-refresh) |
| `refreshSingleTask(taskId)` | Fetches fresh data + replaces single card DOM |
| `freezeTask(taskId)` / `unfreezeTask(taskId)` | Toggle freeze mode on a card |
| `updateStepIndicator(taskId, step, state)` | Update step dot color/animation |
| `checkServerHealth()` | Poll server with 3s AbortController timeout |
| `analyzeLog(taskId, message)` | Send message to AI for intent analysis |
| `executeLog(taskId)` | Execute agent plan via Work IQ (reads plan from `pendingPlans`) |
| `showCorrectionPlanUI(taskId, plan)` | Display correction verification plan with Verify button |
| `executeCorrectionVerify(taskId)` | Execute correction verification via Work IQ + Opus 4.6 |
| `resolveCorrectionAccept(taskId)` | Accept verification result (current info confirmed) |
| `resolveCorrectionVeto(taskId)` | Override verification with user's correction (absolute veto) |
| `toggleMergeMode()` | Activate/deactivate merge mode (checkboxes, floating bar) |
| `toggleMergeSelect(taskId)` | Toggle task selection in merge mode |
| `executeMergeFromBar()` | Execute merge of selected tasks via API |
| `triggerFindDuplicates()` | Trigger Phase 4 consolidation independently |

---

## 7. Skill Files

Skill files are markdown documents loaded at server startup. They serve as prompt templates
for the AI agent — each file instructs the AI how to perform a specific task via Work IQ.

### SCAN_DISCOVERY_SKILL.md — Phase 1 Fallback Prompt

**Used by:** `POST /api/scan` fallback path · **Lines:** 66 · **Timeout:** 180s

Provides the older structured discovery guidance for the Phase 1 metadata pass. In v3.0.0,
the primary discovery prompt is now the inline natural-language question **"Which messages need my action?"**;
this file remains as a legacy backup when the inline path is unavailable.

- **Action detection:** Identifies messages where the user must respond, review, approve, or deliver something. Ignores FYI emails, newsletters, calendar invites, and CC-only messages.
- **Deduplication:** Receives existing tasks as context. Returns `"action": "new"` (create), `"update"` (modify existing), or `"skip"` (matches a done task).
- **Critical rule:** Subject lines must be copied **character by character** — no rephrasing, no "Action Item:" prefixes. This helps Phase 2 find the original message when subject metadata is used.
- **Output:** JSON array of action objects with title, source, from, date, link.

### ~~SCAN_SKILL.md~~ — Archived (v2.9.1)

Moved to `docs/archive/SCAN_SKILL_legacy.md`. Was the original monolithic scan skill from v1.0 that combined scanning and enrichment in one step. In v3.0.0, Phase 1 uses an inline natural-language discovery prompt, with `SCAN_DISCOVERY_SKILL.md` retained as a fallback reference alongside `ENRICH_SKILL.md` for Phase 2.

### ENRICH_SKILL.md — Phase 2: Content Extraction

**Used by:** `POST /api/tasks/:id/enrich` · **Lines:** 89 · **Timeout:** 300s

Extracts and summarizes the full content of a specific email or Teams conversation identified
in Phase 1. This is where deep reading and temporal reasoning happens.

- **Search strategy — three attempts:**
  1. **Keyword search:** Uses the most distinctive keywords from the subject (names, numbers, project names, locations) — NOT the exact subject line
  2. **Broader search:** Fewer, more general keywords if attempt 1 fails
  3. **Sender-based search:** Recent messages from the sender about the general topic
- **Temporal awareness:** Receives the task's discovery date. Information AFTER that date = current update. Information BEFORE = evaluated: same thread context vs. historical/completed occurrence. Old reference numbers and deadlines are NOT presented as current unless clearly still active.
- **Ambiguity handling:** When the agent finds information it cannot confidently classify as current or historical, it returns an `ambiguities` array with questions for the user. Task gets `enrichmentStatus: 'needs-review'` instead of `'enriched'`.
- **Content extraction:** Reads ALL replies in email threads, ALL messages in Teams chats, forwarding notes + original content. Extracts names, dates, deadlines, amounts, links, instructions, action items, decisions.
- **Summary:** 2-4 sentences starting with the CURRENT situation, then historical context if relevant. Written in the **same language** as the original message.
- **Output:** JSON with `summary`, `language`, `confidence` (high/medium/low/none), optional `ambiguities[]` (object format; legacy string arrays auto-normalized via `normalizeAmbiguities()`)

### LOG_WORK_SKILL.md — Work Logging (Legacy Fallback)

**Used by:** `POST /api/tasks/:id/log` (fallback only, when no plan is available) · **Lines:** 67

Legacy skill for basic communication search. Superseded by SEARCH_SKILL.md for primary search path.
Kept as fallback for the Copilot SDK + MCP path when no analyze plan is available.

- **Search scope:** Complete email threads (RE:, FW:, CC responses), related Teams messages, messages sent BY the user
- **Thread reconstruction:** Follows the conversation chronologically — oldest first
- **Summary per message:** 1-2 sentences capturing actions and decisions (not copy-paste)
- **Output:** JSON array of communication objects with type, from, to, date, summary, link

### SEARCH_SKILL.md — Intelligent Communication Search (v2.2.0)

**Used by:** `POST /api/tasks/:id/log` (primary search path) · **Lines:** 145 · **Timeout:** 300s

Executes user search requests with understanding, self-assessment, and iterative refinement.
Replaces the single-shot `workiq ask` CLI approach with a Copilot SDK + MCP session where
the agent controls the search strategy.

- **Goal-oriented search:** Receives `expectedAnswer` (what KIND of answer the user needs) — not just keywords. The agent searches for communications that ANSWER the question, not just contain keywords.
- **Three-attempt search strategy:** Same proven pattern as ENRICH_SKILL.md:
  1. **Targeted search:** Bilingual keywords (DE + EN) in specified targets
  2. **Broader search:** Fewer keywords, expanded time window, synonyms
  3. **Sender/recipient search:** Search by people mentioned in context
- **Self-assessment after each attempt:** Agent evaluates "Does this answer the user's question?" before deciding to try again or present results.
- **Relevance evaluation:** Agent discards irrelevant results rather than returning keyword-matched noise. An honest "nothing found" beats irrelevant PO approvals.
- **Language awareness:** Automatically translates search terms between German and English.
- **Confidence levels:** `high` / `medium` / `low` / `none` — server uses these for response formatting.
- **Output:** JSON with `answer`, `confidence`, `searchAttempts[]`, `communications[]`, optional `ambiguities[]`

### CORRECT_SKILL.md — Evidence-Based Correction Verification (v2.6.0)

**Used by:** `POST /api/tasks/:id/correct` · **Lines:** 119 · **Timeout:** 300s

Verifies user correction claims against M365 communications. The user says information in the task is wrong — this skill searches for evidence and determines the truth.

- **Evidence-based verification:** Searches M365 for communications that prove or disprove the disputed claim — not blind trust in either direction.
- **Truth hierarchy:** newest M365 messages (most weight) > older messages > task history > user claims.
- **Three-attempt search:** Same pattern as SEARCH_SKILL.md: targeted → broader → sender/thread search.
- **Three verdicts:** `user_correct` (apply correction), `current_correct` (evidence supports stored info), `inconclusive` (insufficient evidence).
- **User veto:** Even when evidence contradicts the user, they have absolute override right via the resolve endpoint.
- **Language awareness:** Bilingual keyword search (German + English).
- **Model:** Default Copilot model routing (explicit Claude Opus 4.6 override removed) for nuanced evidence evaluation.
- **Output:** JSON with `verdict`, `confidence`, `explanation`, `evidence[]`, `searchAttempts[]`, `suggestedTitle`, `suggestedSummary`

### UPDATE_CHECK_SKILL.md — Phase 3: Detect New Activity

- **Purpose:** Check if a conversation thread has new messages since the last check
- **Three-attempt search:** Same keyword-based strategy as Phase 2 (keyword → broader → sender)
- **Temporal anchor:** Uses `lastUpdateCheck` (or `enrichedAt`/`createdAt` on first check)
- **Strict temporal filter:** Only messages AFTER the last-checked date count as updates
- **Perspective attribution:** When different people express different expectations, the update makes the difference explicitly visible
- **Output:** `{ hasUpdate, updateSummary, newMessageCount, latestMessageDate }`
- **Key difference from enrichment:** Enrichment summarizes ALL relevant content; update check reports ONLY what is new since last check

### CONSOLIDATE_SKILL.md — Phase 4: Task Consolidation

**Used by:** `POST /api/consolidate` · **Timeout:** 30s

Analyzes all active tasks semantically and identifies groups that cover the same topic.
This is a pure reasoning task — no Work IQ MCP is needed.

- **Conservative matching:** Only suggests merges for tasks that clearly cover the same project, conversation, or work item. Different tasks from the same person are NOT automatically related.
- **Semantic analysis:** Compares titles and summaries, not just keywords. Two tasks about "EMS video" and "EMS feedback" may be the same project.
- **Group suggestions:** Returns task ID groups with reasoning and a suggested merged title.
- **Output:** JSON array of `{ taskIds[], reason, suggestedTitle }`

---

## 8. Work IQ Integration

Work IQ is a Microsoft 365 MCP server that provides access to emails, Teams messages,
calendar events, and documents via the Microsoft Search API.

### Connection

```javascript
import { CopilotClient } from '@github/copilot-sdk';

const client = new CopilotClient();
const session = trackSession(await client.createSession({
  mcpServers: {
    workiq: { type: 'stdio', command: 'workiq', args: ['mcp'], tools: '*' }
  }
}));

const response = await session.sendAndWait({ prompt: searchPrompt }, 300000);
await destroySession(session);  // guaranteed cleanup via finally block + graceful shutdown
```

### How Each Phase Reads M365 Data

| Phase | What is read | How it searches | Key technique |
|-------|-------------|-----------------|---------------|
| **Phase 1** | Recent message metadata (subject/topic, sender, date, link) | "Which messages need my action?" | Naive hybrid first pass — inline natural-language prompt, no body content |
| **Phase 2** | Full email body, all thread replies, Teams chat history | Keyword search from title (3 attempts), temporal classification | Keywords + link context + sender hint + discovery date |
| **Phase 3** | New replies since last check | Keyword search (3 attempts), temporal filter on last-checked date | Keywords + link context + `lastUpdateCheck` anchor |
| **Phase 4** | *No Work IQ access* | Semantic comparison of all task titles + summaries | Pure reasoning — analyzes existing data only |
| **Log Search** | Communications matching user query | Goal-oriented search (3 attempts), self-assessment, relevance filtering | Bilingual keywords + expectedAnswer + confidence levels |

### Search Strategy (Enrichment)

Work IQ performs best with **keyword-based topic searches**, not exact subject matching.
The enrichment prompt uses this approach:

1. Extract keywords from task title (stopword-filtered)
2. Include link context (Teams Thread-ID, Outlook ItemID) as hints
3. Use sender name as context hint, not as a filter
4. Ask for "ALL messages in this conversation about [topic]"

**Why not exact subject?** Task titles are AI-rephrased during Phase 1 and often differ
from the original email subject. Keyword search is more resilient.

### Known Behavior

- Each API call creates a fresh Copilot SDK session (no session reuse)
- Work IQ uses Microsoft Search API, not Graph Messages API directly
- Token is stored in Windows Credential Manager (MSAL)
- Long threads (15+ messages) can take 150-180s to process

---

## 9. File Structure

```
Agent_Zero/
├── server.js              Express backend (all endpoints + AI orchestration)
├── index.html             Single-file frontend (HTML + CSS + JS)
├── package.json           Dependencies and project metadata
├── tasks.json             Local task storage (gitignored)
├── START-AGENT-ZERO.bat         Auto-launcher (port check + server + browser)
├── .gitignore             Excludes tasks.json and node_modules
├── README.md              Quick-start guide
├── docs/
│   ├── ARCHITECTURE.md        This file
│   ├── CHANGELOG.md           Version history
│   ├── SCAN_DISCOVERY_SKILL.md  Phase 1 fallback instructions
│   ├── ENRICH_SKILL.md         Phase 2 skill instructions
│   ├── UPDATE_CHECK_SKILL.md   Phase 3 skill instructions
│   ├── CONSOLIDATE_SKILL.md   Phase 4 skill instructions
│   ├── SEARCH_SKILL.md         Intelligent search skill (v2.2)
│   ├── CORRECT_SKILL.md        Correction verification skill (v2.6)
│   ├── LOG_WORK_SKILL.md       Legacy work logging skill (fallback)
│   ├── FEATURE_INVENTORY_Claude_Code_Codex_Analyse.md  Code review results
│   ├── VIDEO_DESCRIPTION.md    Video script foundation
│   └── archive/               Previous document versions
├── Specifactions/
│   └── AGENT_ZERO_SPEC.md         Product specification
├── Images/                Screenshots and diagrams
├── Security report/       Security analysis
└── node_modules/              (gitignored)
```

---

## 10. Known Limitations

| Limitation | Impact | Workaround |
|-----------|--------|------------|
| Work IQ uses Search API, not Graph Messages API | Cannot read full email bodies directly; relies on search snippets | Keyword-based search + "find ALL messages" prompt |
| Sent Items search returns hit count but no details | Cannot enumerate sent emails | GitHub Issue #55 on microsoft/work-iq-mcp |
| Some emails not found by Work IQ | Graph API indexing delay or Focused Inbox filtering | Retry on next scan; keyword variation |
| 300s timeout per enrichment | Long threads risk timeout | Sequential processing prevents cascade failures |
| Task titles are AI-rephrased | Titles may not match original email subjects | Keyword search instead of exact match |
| tasks.json is not concurrent-safe | Parallel writes could corrupt data | Sequential write queue with chain recovery (`.catch(() => {})` prevents permanent queue freeze) |
| Conditional Access Policy blocks 3rd-party apps | Cannot use Graph PowerShell SDK or CLI for M365 | Work IQ (pre-authorized) or Graph Explorer |

---

*For version history, see [CHANGELOG.md](CHANGELOG.md).*
*For archived specifications, see the `archive/` folder.*
