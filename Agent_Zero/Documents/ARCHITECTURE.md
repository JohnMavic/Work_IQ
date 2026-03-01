# Agent Zero — Architecture

> Version 2.0.0 · February 27, 2026 · Author: Martin Hämmerli

Agent Zero is a personal action-item tracker that scans Microsoft 365 emails and Teams messages for tasks,
extracts content summaries, and monitors threads for updates — all powered by AI.

---

## Table of Contents

1. [System Overview](#1-system-overview)
2. [Technology Stack](#2-technology-stack)
3. [Three-Phase Scan Pipeline](#3-three-phase-scan-pipeline)
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

Each scan creates a fresh Copilot SDK session with Work IQ as MCP server. Sessions are independent —
one session per API call, no shared state between scan phases.

---

## 2. Technology Stack

| Component | Technology | Version |
|-----------|-----------|---------|
| Runtime | Node.js | v22.15.0 |
| Web framework | Express | 5.2.1 |
| AI orchestration | @github/copilot-sdk | 0.1.25 |
| M365 data access | @microsoft/workiq | 0.2.8 |
| ID generation | uuid | 13.0.0 |
| Frontend | Single-file HTML/CSS/JS | — |
| Data storage | JSON file (tasks.json) | — |
| Module system | ES Modules (ESM) | — |

---

## 3. Three-Phase Scan Pipeline

The scan runs three sequential phases when the user clicks "Scan". Each phase processes tasks
one-by-one to avoid Work IQ timeouts.

```
Phase 1: Discovery          Phase 2: Enrichment         Phase 3: Update Check
─────────────────────       ─────────────────────       ─────────────────────
Scan subjects only          Extract full content        Check for new replies
~30-60s total               ~60-180s per task           ~30-90s per task

  ┌──────────┐               ┌──────────┐               ┌──────────┐
  │ Work IQ  │               │ Work IQ  │               │ Work IQ  │
  │ "List    │               │ "Find ALL│               │ "Any new │
  │ subjects"│               │ messages │               │ replies  │
  │          │               │ about X" │               │ since Y?"│
  └────┬─────┘               └────┬─────┘               └────┬─────┘
       │                          │                          │
  New/Update/Skip            Summary + Confidence       Update or No-change
```

### Phase 1: Discovery

**Endpoint:** `POST /api/scan`
**Timeout:** 180s
**Skill:** `SCAN_DISCOVERY_SKILL.md` (fallback: `SCAN_SKILL.md`)

1. Load existing tasks as deduplication context (50 active + 30 done)
2. Send skill prompt + context to Work IQ via Copilot SDK
3. AI returns JSON array with `action` per item:
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
6. If update found: append to summary with `📌 Update:` prefix, set status `'updated'`
7. If no update: set status `'checked'`, log "no new activity"
8. Runs EVERY scan cycle (unlike enrichment which is one-time)

**Frontend loop:** Iterates all tasks where `enrichmentStatus === 'enriched' || 'needs-review'` and `status !== 'done'`.

### Visual Step Indicators

Each task card shows three dots indicating pipeline progress:

```
● ● ●    Step 1 (Discovery) · Step 2 (Enrichment) · Step 3 (Update)
```

| State | Color | CSS Class |
|-------|-------|-----------|
| Pending | Gray | (default) |
| Active | Amber, pulsing | `.step-active` |
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
  "updatedAt": "2026-02-27T17:00:00Z"
}
```

### Field Reference

| Field | Type | Values |
|-------|------|--------|
| `status` | string | `new`, `in-progress`, `needs-attention`, `escalated`, `paused`, `done` |
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

**History types:** `creation`, `status-change`, `scan-update`, `note`, `conversation`,
`enriched`, `enrichment-error`, `thread-update`, `update-check-error`

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
| `POST` | `/api/tasks` | Create manual task | — |
| `PATCH` | `/api/tasks/:id` | Update fields (status, notes, title, enrichmentStatus, updateCheckStatus) | — |
| `DELETE` | `/api/tasks/:id` | Delete task | — |
| `DELETE` | `/api/tasks/:id/history/:index` | Delete history entry (type `update` only) | — |
| `POST` | `/api/tasks/:id/note` | Save quick note | — |
| `POST` | `/api/scan` | Phase 1: Discover new tasks | 180s |
| `POST` | `/api/tasks/:id/enrich` | Phase 2: Extract content | 300s |
| `POST` | `/api/tasks/:id/check-update` | Phase 3: Check for updates | 300s |
| `POST` | `/api/tasks/:id/log/analyze` | AI intent analysis (no Work IQ) | 30s |
| `POST` | `/api/tasks/:id/log` | Execute search + log result | 90s |

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
| Cards | `#141829` |
| Borders | `#1e2233` |

### Key Features

- **Filter bar** with badge counts: All, Attention, New, Escalated, In-Progress, Done, Paused
- **Task cards** with status dropdown, summary section, step indicators, action buttons
- **Freeze mode**: Neon cyan border + "🤖 Agent working..." badge during AI processing
- **Auto-refresh**: `refreshSingleTask()` re-renders individual cards after agent work
- **Server health check**: Polls `/api/tasks` every 5s when offline, green/red status dot
- **Link opening**: Window or tab mode (user preference persisted in localStorage)
- **Log work**: Two-phase agent (analyze intent → execute search)
- **Detail panel**: Expandable history with multi-line entries, icons per history type

### Key Functions

| Function | Purpose |
|----------|---------|
| `triggerScan()` | Orchestrates all 3 scan phases sequentially |
| `renderTasks()` | Renders filtered task list |
| `renderTaskCard(task)` | Renders a single task card (extracted for auto-refresh) |
| `refreshSingleTask(taskId)` | Fetches fresh data + replaces single card DOM |
| `freezeTask(taskId)` / `unfreezeTask(taskId)` | Toggle freeze mode on a card |
| `updateStepIndicator(taskId, step, state)` | Update step dot color/animation |
| `checkServerHealth()` | Poll server with 3s AbortController timeout |
| `analyzeLog(taskId, message)` | Send message to AI for intent analysis |
| `executeLog(taskId, plan)` | Execute agent plan via Work IQ |

---

## 7. Skill Files

Skill files are markdown documents loaded at server startup. They serve as prompt templates
for the AI agent — each file instructs the AI how to perform a specific task via Work IQ.

### SCAN_DISCOVERY_SKILL.md — Phase 1: Subject-Only Scan

**Used by:** `POST /api/scan` · **Lines:** 52 · **Timeout:** 180s

Scans the user's M365 inbox and Teams for messages that require action. Returns **metadata only**
(subject, sender, date, link) — no email body content is read at this stage.

- **Action detection:** Identifies messages where the user must respond, review, approve, or deliver something. Ignores FYI emails, newsletters, calendar invites, and CC-only messages.
- **Deduplication:** Receives existing tasks as context. Returns `"action": "new"` (create), `"update"` (modify existing), or `"skip"` (matches a done task).
- **Critical rule:** Subject lines must be copied **character by character** — no rephrasing, no "Action Item:" prefixes. This ensures Phase 2 can find the original message.
- **Output:** JSON array of action objects with title, source, from, date, link.

### SCAN_SKILL.md — Legacy Scan (Fallback)

**Used by:** `POST /api/scan` (fallback if SCAN_DISCOVERY_SKILL.md is missing) · **Lines:** 81

The original monolithic scan skill from v1.0. Unlike the discovery skill, this reads email **bodies**
and generates summaries in a single pass. Kept as fallback — not used when SCAN_DISCOVERY_SKILL.md exists.

- **Content extraction:** Reads full email body, extracts topics, requests, action items, deadlines
- **Matching rules:** Same topic = same task (even across email/Teams), follow-ups = update
- **Summary:** 2-4 sentences capturing situation, request, and key details

### ENRICH_SKILL.md — Phase 2: Content Extraction

**Used by:** `POST /api/tasks/:id/enrich` · **Lines:** 96 · **Timeout:** 300s

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

### LOG_WORK_SKILL.md — Work Logging

**Used by:** `POST /api/tasks/:id/log` · **Lines:** 47 · **Timeout:** 90s

Searches for communications related to a task after the user describes what they did.
Finds the full conversation thread, not just the original message.

- **Search scope:** Complete email threads (RE:, FW:, CC responses), related Teams messages, messages sent BY the user
- **Thread reconstruction:** Follows the conversation chronologically — oldest first
- **Summary per message:** 1-2 sentences capturing actions and decisions (not copy-paste)
- **Output:** JSON array of communication objects with type, from, to, date, summary, link

### UPDATE_CHECK_SKILL.md — Phase 3: Detect New Activity

- **Purpose:** Check if a conversation thread has new messages since the last check
- **Three-attempt search:** Same keyword-based strategy as Phase 2 (keyword → broader → sender)
- **Temporal anchor:** Uses `lastUpdateCheck` (or `enrichedAt`/`createdAt` on first check)
- **Strict temporal filter:** Only messages AFTER the last-checked date count as updates
- **Output:** `{ hasUpdate, updateSummary, newMessageCount, latestMessageDate }`
- **Key difference from enrichment:** Enrichment summarizes ALL relevant content; update check reports ONLY what is new since last check

---

## 8. Work IQ Integration

Work IQ is a Microsoft 365 MCP server that provides access to emails, Teams messages,
calendar events, and documents via the Microsoft Search API.

### Connection

```javascript
import { CopilotSDK } from '@github/copilot-sdk';

const session = sdk.createSession({
  mcpServers: {
    workiq: { command: 'npx', args: ['-y', '@microsoft/workiq', 'mcp'] }
  }
});

const response = await session.sendAndWait(prompt, { timeout: 180000 });
```

### How Each Phase Reads M365 Data

| Phase | What is read | How it searches | Key technique |
|-------|-------------|-----------------|---------------|
| **Phase 1** | Subject lines, sender, date, link | "List messages requiring action from last N days" | Metadata only — no body content |
| **Phase 2** | Full email body, all thread replies, Teams chat history | Keyword search from title (3 attempts), temporal classification | Keywords + link context + sender hint + discovery date |
| **Phase 3** | New replies since last check | Keyword search (3 attempts), temporal filter on last-checked date | Keywords + link context + `lastUpdateCheck` anchor |

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
├── START-DAILY-BRIEFING.bat  Auto-launcher (port check + server + browser)
├── .gitignore             Excludes tasks.json and node_modules
├── README.md              Quick-start guide
├── Documents/
│   ├── ARCHITECTURE.md        This file
│   ├── CHANGELOG.md           Version history
│   ├── SCAN_DISCOVERY_SKILL.md  Phase 1 skill instructions
│   ├── SCAN_SKILL.md           Legacy scan skill (fallback)
│   ├── ENRICH_SKILL.md         Phase 2 skill instructions
│   ├── UPDATE_CHECK_SKILL.md   Phase 3 skill instructions
│   ├── LOG_WORK_SKILL.md       Work logging skill instructions
│   └── archive/               Previous document versions
└── node_modules/              (gitignored)
```

---

## 10. Known Limitations

| Limitation | Impact | Workaround |
|-----------|--------|------------|
| Work IQ uses Search API, not Graph Messages API | Cannot read full email bodies directly; relies on search snippets | Keyword-based search + "find ALL messages" prompt |
| Sent Items search returns hit count but no details | Cannot enumerate sent emails | GitHub Issue #55 on microsoft/work-iq-mcp |
| Some emails not found by Work IQ | Graph API indexing delay or Focused Inbox filtering | Retry on next scan; keyword variation |
| 180s timeout per enrichment | Long threads risk timeout | Sequential processing prevents cascade failures |
| Task titles are AI-rephrased | Titles may not match original email subjects | Keyword search instead of exact match |
| tasks.json is not concurrent-safe | Parallel writes could corrupt data | Sequential processing + write queue |
| Conditional Access Policy blocks 3rd-party apps | Cannot use Graph PowerShell SDK or CLI for M365 | Work IQ (pre-authorized) or Graph Explorer |

---

*For version history, see [CHANGELOG.md](CHANGELOG.md).*
*For archived specifications, see the `archive/` folder.*
