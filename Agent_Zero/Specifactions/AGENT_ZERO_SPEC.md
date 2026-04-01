# Agent Zero — Product Specification

**Version:** 3.0.0
**Date:** March 14, 2026
**Author:** Martin Hämmerli
**Status:** v3.0.0 implemented (naive hybrid Phase 1 scan + verify-and-improve update loop + content removal + server stability hardening)

---

## 1. Purpose

Agent Zero is a local, single-page HTML application that helps the user stay on top of action items from Microsoft 365 emails and Teams messages. The app scans a configurable number of days (1–14, default 4) of communication, extracts tasks, and presents them in a dark-themed interactive card list. The user can manage task status across 6 granular states, interact with an intent-based AI agent per task, add manual tasks, save notes, and click through to the original email or Teams message.

---

## 2. Architecture Overview

```
┌──────────────────────────────────────────────────────────┐
│                    Browser (HTML/JS)                      │
│                                                          │
│  ┌──────────┐  ┌──────────────┐  ┌────────────────────┐ │
│  │ Scan      │  │ Task Cards   │  │ Interaction Panel  │ │
│  │ Trigger + │  │ (sorted,     │  │ (Chat UI, Agent,   │ │
│  │ Slider    │  │  filtered)   │  │  Notes, Details)   │ │
│  └─────┬────┘  └──────┬───────┘  └────────┬───────────┘ │
│        │              │                   │              │
└────────┼──────────────┼───────────────────┼──────────────┘
         │              │                   │
         ▼              ▼                   ▼
┌──────────────────────────────────────────────────────────┐
│               Local Node.js Backend Server               │
│                                                          │
│  ┌──────────────┐  ┌────────────┐  ┌─────────────────┐  │
│  │ GitHub       │  │ Work IQ    │  │ tasks.json      │  │
│  │ Copilot SDK  │  │ (MCP/CLI)  │  │ (persistent)    │  │
│  └──────────────┘  └────────────┘  └─────────────────┘  │
│                                                          │
│  Copilot SDK: AI reasoning (analyze intent, scan).       │
│  Work IQ: M365 data access (emails, Teams via CLI/MCP). │
│  tasks.json: Local JSON file for task persistence.       │
└──────────────────────────────────────────────────────────┘
```

**Two AI integration methods:**

| Method | Used By | How |
|---|---|---|
| Copilot SDK + MCP | Scan, Enrich, Update Check, Analyze (intent detection), Intelligent Search, Ambiguity Review | `CopilotClient` → `createSession()` with/without MCP servers |
| Work IQ CLI (`workiq ask`) | Legacy search fallback (unused in v2.2 primary path) | Direct `spawn('workiq', ['ask'])` via stdin — kept as legacy fallback |

---

## 3. Technology Stack

| Component | Technology | Why |
|---|---|---|
| **Frontend** | Single HTML file (HTML + CSS + JS) | Simple, no build step, consistent with existing projects |
| **Backend** | Node.js server (Express, ES Modules) | Required to run Copilot SDK and Work IQ. Uses `"type": "module"` in package.json for ESM compatibility |
| **AI Engine** | GitHub Copilot SDK (`@github/copilot-sdk`) | AI reasoning for intent classification, scan analysis, summarization |
| **M365 Access** | Work IQ (`@microsoft/workiq`) | Installed globally (v0.2.8+), provides access to M365 emails and Teams via MCP or CLI |
| **Data Storage** | Local JSON file (`tasks.json`) | Simplest possible persistence, easy to inspect and debug |
| **Deep Links** | Outlook `outlook://` protocol links | Opens referenced emails directly in Outlook desktop app |

### 3.1 Prerequisites

| Requirement | Version | Installation |
|---|---|---|
| Node.js | v18+ | https://nodejs.org/ |
| Work IQ CLI | v0.2.8+ | `npm install -g @microsoft/workiq` |
| GitHub Copilot access | — | GitHub account with Copilot license |
| M365 account | — | Corporate account with email + Teams access |

First-time setup:
1. `npm install` (install project dependencies)
2. `workiq accept-eula` (accept Work IQ terms, one-time)
3. Verify M365 access: `workiq ask -q "Show my latest emails"`

### 3.2 Dependencies (package.json)

| Package | Version | Purpose |
|---|---|---|
| `express` | ^5.2.1 | HTTP server and REST API |
| `@github/copilot-sdk` | ^0.1.25 | AI reasoning engine (Copilot SDK) |
| `@microsoft/workiq` | ^0.2.8 | M365 data access via MCP (also installed globally) |
| `uuid` | ^13.0.0 | UUID generation for task IDs |

---

## 4. Features

### 4.1 Scan Trigger

- A prominent **"Scan Emails & Teams"** button in the header
- **Configurable scan range:** slider (1–14 days, default 4) persisted in `localStorage`
- The scan days value is sent in the request body: `{ scanDays: <number> }`
- When triggered, the backend:
  1. Reads existing tasks from `tasks.json` (active + done for dedup context)
  2. Calls Work IQ via Copilot SDK (MCP session) with the inline Phase 1 question: **"Which messages need my action?"**
  3. AI identifies action items AND matches them against existing tasks (semantic dedup)
  4. **New items** → added with status `new`
  5. **Matched items with changes** → existing task updated + `scan-update` history entry
  6. **Matched items without changes** → skipped
  7. **Items matching done tasks** → action `skip`, not re-created
  8. Returns updated counts to frontend
- **Non-blocking scan banner:** inline bar in header row 2 (replaces idle status) with:
  - Spinner + phase text + elapsed time counter (`⏱ MM:SS`)
  - Red "⏹ Stop" button to abort scan safely between tasks
  - Button label changes per phase: "Scanning..." → "Enriching..." → "Checking updates..."
- Scan button disabled during scan (text changes to "Scanning...")
- After completion: notification toast with result summary
- Primary scan prompt is the inline natural-language question above; `SCAN_DISCOVERY_SKILL.md` remains as legacy/fallback guidance

### 4.1a Scan Resilience

- **Scan lock:** Frontend `scanInProgress` state prevents overlapping scans; a second trigger is rejected with a user-visible warning.
- **Phase 1 non-fatal:** If discovery fails, the UI records the failure and still continues with existing pending/enriched tasks already stored on the server.
- **Phase-independent recovery:** Phase 2 reloads all `enrichmentStatus: "pending"` tasks from the server; Phase 3 reloads all `enriched` / `needs-review` tasks.
- **Per-task retry:** Enrichment and update-check retry each task once after 3 seconds before marking it as failed.

### 4.2 Task List Display

Each task is displayed as a card with:

| Field | Description |
|---|---|
| **Title** | Short description of the action item |
| **Source** | "Email", "Teams", or "Manual" badge (color-coded) |
| **From** | Sender / person who assigned the task |
| **Date** | When the original message was sent |
| **Link** | Clickable "Open source ↗" link (if available) |
| **Notes** | Optional notes (italic, below title) |
| **Status** | Dropdown selector (6 statuses, see 4.3) |

### 4.3 Status System (6 Statuses)

| Status | Emoji | Color | Priority | Description |
|---|---|---|---|---|
| `needs-attention` | 🔴 | Red (#ef4444) | 0 | Requires immediate action |
| `new` | 🆕 | Blue (#60a5fa) | 1 | Default for scan results and manual creation |
| `escalated` | 🚨 | Orange (#f97316) | 2 | Escalated to higher priority |
| `in-progress` | 🟡 | Yellow (#fbbf24) | 3 | Currently being worked on |
| `paused` | ⏸️ | Gray (#9ca3af) | 4 | Temporarily on hold |
| `done` | ✅ | Green (#34d399) | 5 | Completed |

**Sort order:** Priority ascending (needs-attention first), then `createdAt` descending within same status.

**Status migration:** On server startup, `migrateStatuses()` converts any legacy `active` status to `new`.

**Valid status transitions:** Any status can transition to any other status (no restrictions).

### 4.4 Manual Task Creation

- "＋ Add Task" button in header row 3 opens a modal dialog
- Modal has three fields: Title (required), Assignment (agent instruction, optional), Context (background info, optional)
- Created with `source: 'manual'`, `status: 'new'`, `from: null`, `date: null`, `enrichmentStatus: 'n/a'`, `updateCheckStatus: 'n/a'`
- History entry: `{ type: 'created', text: 'Task created manually' }`
- If Assignment is provided, the agent **automatically starts working** on it after creation — no second step needed
- Modal closes on ESC, click outside, or Cancel button
- Add Task button disabled when server is offline

### 4.5 Task Deletion

- Red ✕ button on each task card
- `DELETE /api/tasks/:id` removes the task from `tasks.json`
- If another task is frozen (`frozenTasks`), deletion uses minimal DOM update (removes card without full re-render)

### 4.6 Filter Bar

- 7 filter buttons: All, 🔴 Attention, 🆕 New, 🚨 Escalated, 🟡 In Progress, ⏸️ Paused, ✅ Done
- Dynamic badge counts updated on each render (only visible tasks counted)
- Active filter highlighted with blue border
- Task count display: `"X of Y tasks"`

### 4.7 Deduplication (3-Layer)

1. **AI Context Dedup:** Active + done tasks (up to 50 active + 30 done) included in scan prompt so AI can return `action: "skip"` or `action: "update"` with `existingId`
2. **Action-Based Dedup:** Items with `action: "skip"` are counted as skipped. Items with `action: "update"` update the matched existing task
3. **Jaccard Safety-Net:** All new items are checked against ALL existing tasks using word-level Jaccard similarity (threshold > 0.7). If similar, the item is skipped with a console warning

**Backward compatibility:** Items without an `action` field use legacy dedup logic (match by `link`, then by `title + from + source`).

### 4.8 Task Interaction Panel

Each task card is clickable — clicking the title/meta area toggles an **Interaction Panel** below the card:

- **Conversations:** Chat-like display of all `update`, `note`, and `review-response` history entries (reverse-chronological order, newest first)
- **Input form:** Text input + 3 buttons:
  - **📤 Send** — sends to AI agent for analysis (`analyzeLog`)
  - **📝 Note** — saves directly as note (no agent interaction)
  - **▶ Execute** — appears in plan UI after search intent analysis
- **Plan display:** Shows search plan details (understanding, from, keywords, time window, targets) with Execute/Cancel buttons
- **Clarification:** If agent sets `needsClarification: true`, shows a follow-up input
- **Details toggle:** Expandable section showing execution trace (4-step: Auftrag → Gesendet → Antwort → Ergebnis) and system events

**Visual indicators:**
- **Neon-pink border** (`.has-content`): Task has conversation entries
- **Neon-cyan border + dynamic badge** (`.frozen`): Task has active agent work (unified freeze mode for all AI operations, with context-specific status text)
- **Green background** (`.active-panel`): Panel is currently open

### 4.9 Intent-Based Agent (6 Intents)

The agent uses a two-phase approach:

**Phase 1 — Analyze** (`POST /api/tasks/:id/log/analyze`):
- Uses Copilot SDK with the **default model** (explicit Claude Opus 4.6 override removed), **without** Work IQ MCP (fast, AI reasoning only, ~5–15s, 60s timeout)
- Determines one of 6 intents based on user message + task context + conversation history

| Intent | Trigger Examples | Behavior | Requires Execute? |
|---|---|---|---|
| `update` | "Ich habe X bestätigt", "I sent...", "I edited...", "remove that wrong part" | AI updates title and/or summary with new information, including removal of false content on user request | No — result saved immediately |
| `summarize` | "fasse zusammen", "summarize this", "key points" | AI summarizes the content provided in the message | No — result saved immediately |
| `rename` | "nenne es...", "ändere den Titel zu...", "rename to..." | AI changes only the title | No — result saved immediately |
| `answer` | "bis wann?", "what's the deadline?", "who is responsible?" | AI answers from task context + conversation history | No — result saved immediately |
| `correct` | "Das stimmt nicht", "SSD wurde nie bestellt", "Der Titel ist falsch" | AI returns a correction plan for M365 verification | Yes — user must click Verify |
| `search` | "find emails from", "was hat X geschrieben?", "check inbox" | AI returns a search plan with parameters | Yes — user must click Execute |

**Pre-filter:** Messages matching "Ich habe [action verb]" (without negation) bypass intent classification and go directly to the update-only prompt. Negation patterns ("Ich habe NICHT bestätigt") are excluded from the pre-filter and proceed to full classification, where they are typically classified as `correct`.

**Conversation context:** Last 8 history entries of type `update` or `note` are included in the analyze prompt, with full details (user text, agent intent, understanding, communications).

**Update intent — Verify-and-Improve Loop:**
- 3-step flow: **Execute → Verify → Improve**
- Each step is a separate Copilot reasoning call with **no Work IQ MCP**
- **Max 1 retry:** Verify can trigger at most one Improve pass
- **Graceful degradation:** If Verify or Improve fails, the original Execute result is preserved and returned

**Phase 2a — Execute Search** (`POST /api/tasks/:id/log`):
- Only for `search` intent, triggered by user clicking Execute
- v2.2 primary path: **Copilot SDK + Work IQ MCP + SEARCH_SKILL.md** — goal-oriented 3-attempt search with self-assessment and confidence levels
- Legacy fallback: Copilot SDK + Work IQ MCP + LOG_WORK_SKILL.md (when no plan or no SEARCH_SKILL.md)
- Minimal fallback: inline prompt (when no skill files available)
- Timeout: 300 seconds for Copilot SDK + MCP session
- Parses response as JSON (SEARCH_SKILL format: `{ answer, confidence, searchAttempts, communications }` or legacy array format)
- Falls back to Markdown email parser (`parseMarkdownEmails()`) if no JSON parsed
- Search methods: `copilot-sdk-search-skill` (primary), `copilot-sdk-legacy`, `copilot-sdk-minimal`

**Phase 2b — Correction Verification** (`POST /api/tasks/:id/correct`):
- Only for `correct` intent, triggered by user clicking Verify
- Uses **default model + Work IQ MCP + CORRECT_SKILL.md** — evidence-based verification with truth hierarchy
- Searches M365 for evidence supporting or contradicting the user's correction claim
- **Truth hierarchy:** newest M365 messages > older messages > task history > user claims
- Returns one of three verdicts:
  - `user_correct` → correction applied automatically
  - `current_correct` → evidence shown to user, with Accept or Veto option
  - `inconclusive` → insufficient evidence, user can veto to override
- Timeout: 300 seconds
- **User veto** (`POST /api/tasks/:id/correct/resolve`): absolute override right — user can always force their correction regardless of evidence

**Deterministic fallback:** If AI analysis fails, `extractKeywords()` generates a search plan from the task title (stop-word removal), with default time window from task date to today.

### 4.10 Auto-Cleanup

- Done tasks older than a configurable retention period are **permanently deleted** from `tasks.json`
- Default: 3 days; configurable via slider in header (1–30 days), persisted in `localStorage` as `cleanupDays`
- Server-side cleanup: `POST /api/cleanup` runs on startup and before each scan
- Frontend also filters expired done tasks from display (immediate visual feedback when slider changes)
- Only tasks with status `done` and a `doneAt` timestamp older than retention are deleted

### 4.11 Server Status Detection

- `checkServerHealth()` with `AbortController` (3-second timeout) on `/api/tasks`
- **Offline banner** (amber) with startup instructions:
  - Option 1: Double-click `START-AGENT-ZERO.bat`
  - Option 2: Terminal command `cd Agent_Zero && node server.js`
- **Auto-reconnect polling** every 5 seconds when offline
- **Reconnect notification:** "✅ Server verbunden" when connection is restored
- **Status dot** in header (12px circle):
  - 🟢 Green when online, 🔴 Red when offline
  - CSS-only tooltip on hover showing architecture info (online: Express, Copilot SDK, Work IQ, tasks.json; offline: startup instructions)
- Scan and Add Task buttons disabled when offline
- `btn.disabled = !serverOnline` in `triggerScan()` finally block (not hardcoded `false`)

### 4.12 History System

Each task has a `history[]` array with entries of different types:

| Type | Created By | Deletable? | Description |
|---|---|---|---|
| `created` | Scan or manual creation | No | Initial creation event |
| `status-change` | Status dropdown change | No | Records old → new status |
| `scan-update` | Re-scan matching | No | Records field changes from scan |
| `enriched` | Phase 2 enrichment | No | Enrichment success (duration, keywords, confidence, summary) |
| `enrich-error` | Phase 2 failure | No | Enrichment failure (error details, duration) |
| `thread-update` | Phase 3 (update found) | No | New messages detected (search keywords, message count, update text) |
| `update-check` | Phase 3 (no update) | No | No new activity (search keywords, duration) |
| `update-check-error` | Phase 3 failure | No | Update check failed (error details) |
| `summary-update` | Summary change (PATCH, review, or agent) | No | Previous summary preserved in history |
| `update` | Agent interaction (Send) | Yes | User message + agent response |
| `note` | Note button | Yes | User-saved note (no agent) |
| `review-response` | Ambiguity review response | Yes | User's clarification + agent evaluation |
| `correction` | Correction verification | No | Verification result (verdict, confidence, evidence summary) |
| `correction-veto` | User overrides verification | No | User exercised veto right despite contrary evidence |
| `correction-dismissed` | User accepts verification | No | User confirmed current information is correct |

**History deletion:** `DELETE /api/tasks/:id/history/:index` — only `update`, `note`, and `review-response` types can be deleted (system entries are protected with HTTP 403). Each conversation entry has a 🗑️ button (low opacity, visible on hover).

### 4.13 Agent Response (agentResponse)

The `agentResponse` field is generated **server-side** after search execution completes (`POST /api/tasks/:id/log`):

| Condition | agentResponse Content |
|---|---|
| Search error | `❌ Search failed: <error>` |
| v2.2 SEARCH_SKILL answer found | `<confidence icon> <agent's answer>` + optional ambiguities + optional communications list |
| Legacy: Communications found | `✅ N communication(s) found:\n\n` + numbered list with icons, senders, dates, summaries |
| Raw text but no structured data | The raw Work IQ response text (natural language) |
| No results | `🔍 No results found...` with suggestion to retry with different terms |

**Confidence icons:** ✅ (high), ⚠️ (medium), 🔍 (low), ❌ (none)

**Frontend display:** For search intents, `renderConversations()` shows `agentResponse` (final result). When `agentExecution.answer` exists, the answer is rendered as an always-visible block with confidence badge and color-coded border. Communications are shown below as supporting evidence.

### 4.14 Execution Tracing

Every search execution saves an `agentExecution` object:

```json
{
  "promptSent": "<context string sent to AI>",
  "rawResponse": "<first 8000 chars of AI response>",
  "parsedCount": 3,
  "confidence": "high",
  "answer": "Agent's direct answer to the user's question",
  "searchAttempts": [{ "attempt": 1, "strategy": "...", "found": "...", "relevant": true }],
  "ambiguities": [],
  "error": null,
  "durationMs": 45200,
  "method": "copilot-sdk-search-skill"
}
```

**Methods:** `copilot-sdk-search-skill` (v2.2 primary), `copilot-sdk-legacy` (fallback with LOG_WORK_SKILL), or `copilot-sdk-minimal` (no skill file).

### 4.15 Link Open Mode

Header selector with 2 modes (persisted in `localStorage`):

| Mode | Icon | Behavior |
|---|---|---|
| `window` | 🪟 | Opens link in new browser window (default) |
| `tab` | 📑 | Opens link in new tab |

**Migration:** If localStorage contains defunct `split` or `incognito` values from earlier versions, they are auto-reset to `window`.

### 4.16 Collapsible Conversations

- Messages longer than 120 characters get a toggle arrow (▼/▶)
- Collapsed state stored per entry in `collapsedEntries` Set (persisted in `localStorage`)
- Both user messages and agent responses can be independently collapsed
- Preview shows first meaningful line, truncated to 80 characters

### 4.17 Lightweight Markdown Renderer

The `renderMarkdown()` function converts agent responses to HTML:

| Markdown | HTML |
|---|---|
| `## Heading` | `<h2>` |
| `### Heading` | `<h3>` |
| `**bold**` | `<strong>` |
| `*italic*` | `<em>` |
| `` `code` `` | `<code>` |
| `- item` | `<li>` in `<ul>` |
| Double newline | `</p><p>` |
| Single newline | `<br>` |

Tables are rendered via CSS styling on `.agent-msg-bot table` elements.

### 4.18 Progress Feedback (Search Execution)

When the user clicks Execute, the plan UI shows live status updates:
1. **📤 Sending search to Work IQ...** — immediately
2. **⏳ Waiting for system response...** — after 10 seconds (if still running)
3. **✅ Done — N communication(s) found** — on success
4. **🔍 No communications found** — on empty result
5. **❌ Search failed: ...** — on error

### 4.19 Concurrency

- **Write queue** (`safeWriteTasks()`): All mutations go through a sequential promise chain to prevent concurrent file writes
- **Freeze task tracking** (`frozenTasks` Set): When an agent is working on a task:
  - Card gets neon cyan border + a context-specific working badge
  - All interaction functions (delete, update, panel toggle, analyze) check `frozenTasks` Set and refuse action
  - Status changes on OTHER tasks use inline DOM updates (no full re-render)
  - Task deletion uses minimal DOM removal
- **Multiple concurrent agents:** Multiple tasks can have active agent work simultaneously
- **Panel persistence** (`openPanelTaskIds`): Open panels survive `fetchTasks()` re-renders, restored from `localStorage`
- **Pending plan restoration:** After re-render, pending search plans are re-displayed for open panels

### 4.20 Email Content Summary

Each scanned task includes an optional `summary` field — a 2-4 sentence briefing of the original email or Teams message content. This allows the user to understand the full context of an action item without opening the original message.

- **Scan produces summary:** The AI agent extracts and summarizes the email body, including key details (deadlines, amounts, names, decisions, requests)
- **Stored in task object:** `summary` field (string | null). Null for pure notifications with no content beyond the subject line
- **Displayed in UI:** Collapsible summary block under the task title/metadata, toggled by click. Default: collapsed (single line with truncation). Expanded: full summary text
- **Updated on re-scan:** When a task is updated by a re-scan, the summary can be refreshed with new context
- **Not used for deduplication:** Summary is for display only, not for matching logic

### 4.21 Multi-Phase Scan Architecture

The scan process is split into 4 sequential phases for faster initial feedback and progressive content loading:

**Phase 1 — Discovery (Naive Hybrid):**
- Primary prompt is the inline question **"Which messages need my action?"**
- Uses recent message metadata (subject/topic, sender, date, link) for a lightweight first pass
- `SCAN_DISCOVERY_SKILL.md` remains available as legacy/fallback guidance
- Tasks appear immediately with `summary: null`, `enrichmentStatus: "pending"`
- Returns `newTaskIds[]` for Phase 2 orchestration
- Step 1 indicator turns green ✅

**Phase 2 — Enrichment (Content Extraction):**
- `POST /api/tasks/:id/enrich` per new task, sequentially
- Task card frozen (neon blue #00d4ff, no user interaction)
- Uses `ENRICH_SKILL.md` — reads full email body, generates 2-4 sentence summary in original language
- Sets `enrichmentStatus: "enriched"`, `enrichedAt` timestamp
- Step 2 indicator turns green ✅

**Phase 3 — Update Check (Thread Replies):**
- `POST /api/tasks/:id/check-update` per enriched task, sequentially
- Checks for new replies in email thread since task creation
- If update found: appends "📌 Update:" to summary, sets `updateCheckStatus: "updated"`
- Step 3 indicator turns green ✅ or yellow (updated)

**Phase 4 — Task Consolidation (Duplicate Detection):**
- `POST /api/consolidate` — single AI call for all active tasks
- Uses `CONSOLIDATE_SKILL.md` — pure reasoning, no Work IQ MCP needed
- AI compares all task titles and summaries semantically
- Returns merge suggestions with reasoning and suggested merged titles
- Previously dismissed pairs (stored in `noMergeWith[]`) are filtered out
- User actions: **Merge** (combines tasks) or **Keep Separate** (prevents future suggestion)
- Non-fatal: failures are silently caught, scan completes normally
- Also available as standalone action via **🔗 Find Duplicates** button

**Freeze Mode:** During Phase 2/3, the task being processed is frozen — neon blue border/glow, pulse animation, `pointer-events: none`, and a context-specific status badge (for example content analysis, retry, or update-check text). All interaction functions (delete, update, panel toggle, analyze) check `frozenTasks` Set and refuse action.

---

## 5. Data Schema (v3)

### 5.1 tasks.json Structure

```json
{
  "version": 3,
  "lastScan": "2026-02-27T10:30:00.000Z",
  "tasks": [ ... ]
}
```

### 5.2 Task Object

| Field | Type | Description |
|---|---|---|
| `id` | string (UUID) | Unique identifier |
| `title` | string | Action item description |
| `summary` | string \| null | 2-4 sentence briefing of email/message content (null for notifications) |
| `source` | string | `"email"`, `"teams"`, or `"manual"` |
| `from` | string \| null | Sender name |
| `date` | string \| null | Original message date (ISO 8601) |
| `link` | string \| null | Deep link to original message |
| `status` | string | One of 6 statuses (see 4.3) |
| `notes` | string | Free-text notes |
| `history` | HistoryEntry[] | Array of history entries |
| `doneAt` | string \| null | ISO timestamp when status changed to done |
| `enrichmentStatus` | string | `"pending"`, `"enriching"`, `"enriched"`, `"needs-review"`, `"error"`, `"n/a"` |
| `updateCheckStatus` | string | `"pending"`, `"checking"`, `"checked"`, `"updated"`, `"error"`, `"n/a"` |
| `enrichedAt` | string \| null | ISO timestamp of last enrichment |
| `lastUpdateCheck` | string \| null | ISO timestamp of last update check |
| `createdAt` | string | ISO timestamp of creation |
| `updatedAt` | string | ISO timestamp of last modification |
| `noMergeWith` | string[] | IDs of tasks the user chose to keep separate (bidirectional) |
| `additionalLinks` | object[] | Links from secondary tasks after a merge: `[{ url, source, from }]` |

### 5.3 HistoryEntry Object

| Field | Type | Required | Description |
|---|---|---|---|
| `timestamp` | string | Yes | ISO 8601 timestamp |
| `type` | string | Yes | `"created"`, `"status-change"`, `"scan-update"`, `"enriched"`, `"enrich-error"`, `"thread-update"`, `"update-check"`, `"update-check-error"`, `"summary-update"`, `"title-change"`, `"update"`, `"note"`, `"review-response"`, `"merge"`, `"correction"`, `"correction-veto"`, `"correction-dismissed"` |
| `text` | string | Yes | User message or system description |
| `communications` | Communication[] | No | Found emails/messages (search results) |
| `agentPlan` | AgentPlan | No | AI analysis result |
| `agentResponse` | string | No | Final formatted result after search (see 4.13) |
| `agentExecution` | AgentExecution | No | Execution trace metadata (see 4.14) |

### 5.4 AgentPlan Object

| Field | Type | Description |
|---|---|---|
| `intent` | string | `"update"`, `"summarize"`, `"search"`, `"answer"`, `"rename"`, `"correct"`, or `"review"` |
| `understanding` | string | For search: action plan description. For summarize/answer: the result text |
| `expectedAnswer` | string \| null | What KIND of answer the user needs (v2.2, search only) |
| `searchFrom` | string \| null | Person name, email domain, or null |
| `keywords` | string[] | Search terms in user's language (only used if searchFrom is null) |
| `keywordsEnglish` | string[] | English translations of keywords (v2.2) |
| `timeWindow` | object | `{ from, to, reasoning }` |
| `searchTargets` | string | `"inbox"`, `"sent"`, `"teams"`, or `"all"` |
| `needsClarification` | boolean | Whether agent needs more info |
| `clarificationQuestion` | string \| null | Follow-up question if clarification needed |
| `userConfirmed` | boolean | Set to `true` when user clicks Execute (only on saved entries) |
| `fallback` | boolean | `true` if deterministic fallback was used |

### 5.5 AgentExecution Object

| Field | Type | Description |
|---|---|---|
| `promptSent` | string | Context string sent to AI |
| `rawResponse` | string | Raw AI response (first 8000 chars) |
| `parsedCount` | number | Number of communications parsed |
| `confidence` | string \| null | `"high"` / `"medium"` / `"low"` / `"none"` (v2.2) |
| `answer` | string \| null | Agent's direct answer to user's question (v2.2) |
| `searchAttempts` | array | `[{ attempt, strategy, found, relevant }]` (v2.2) |
| `ambiguities` | string[] | Questions for the user (v2.2) |
| `error` | string \| null | Error message if search failed |
| `durationMs` | number | Search duration in milliseconds |
| `method` | string | `"copilot-sdk-search-skill"` (v2.2), `"copilot-sdk-legacy"`, or `"copilot-sdk-minimal"` |

### 5.6 Communication Object

| Field | Type | Description |
|---|---|---|
| `type` | string | `"email"` or `"teams"` |
| `from` | string | Sender name |
| `to` | string | Recipient name(s) |
| `date` | string | Message date (ISO 8601 or natural language from Markdown parser) |
| `summary` | string | 1–2 sentence summary or subject line |
| `link` | string \| null | URL to original message |

---

## 6. API Specification

**Base URL:** `http://localhost:3000`

**Duplicate Instance Prevention:** `app.listen()` handles `EADDRINUSE` — if port 3000 is already in use, the server logs a clear error message and exits with code 1. `START-AGENT-ZERO.bat` also pre-checks via `netstat`.

### 6.1 Endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/tasks` | Return all tasks + metadata |
| `POST` | `/api/tasks` | Create manual task |
| `PATCH` | `/api/tasks/:id` | Update task (status, notes, title, summary, enrichmentStatus, updateCheckStatus) |
| `DELETE` | `/api/tasks/:id` | Delete a task |
| `DELETE` | `/api/tasks/:id/history/:index` | Delete a history entry |
| `POST` | `/api/tasks/:id/note` | Save a note (no agent) |
| `POST` | `/api/scan` | Phase 1: Discovery scan (naive hybrid action question) |
| `POST` | `/api/tasks/:id/enrich` | Phase 2: Content extraction + summary |
| `POST` | `/api/tasks/:id/check-update` | Phase 3: Thread update check |
| `POST` | `/api/consolidate` | Phase 4: Find duplicate/related tasks |
| `POST` | `/api/tasks/merge` | Merge two or more tasks into one |
| `POST` | `/api/tasks/:id/dismiss-merge` | Dismiss a merge suggestion (bidirectional) |
| `POST` | `/api/tasks/:id/log/analyze` | AI intent analysis (default model) |
| `POST` | `/api/tasks/:id/log` | Execute intelligent search |
| `POST` | `/api/tasks/:id/correct` | Correction verification (default model + Work IQ MCP) |
| `POST` | `/api/tasks/:id/correct/resolve` | Resolve correction discussion (accept or veto) |
| `POST` | `/api/cleanup` | Permanently delete done tasks older than `retentionDays` |
| `POST` | `/api/tasks/:id/review` | Ambiguity resolution — user responds to review questions |

### 6.2 GET /api/tasks

**Response:** `{ version, lastScan, tasks[] }`

### 6.3 POST /api/tasks

**Request body:** `{ title: string, notes?: string }`
**Response:** Created task object (HTTP 201)
**Validation:** Title required and non-empty

### 6.4 PATCH /api/tasks/:id

**Request body:** `{ status?, notes?, title?, summary?, enrichmentStatus?, updateCheckStatus? }` (any subset)
**Valid statuses:** `new`, `needs-attention`, `escalated`, `in-progress`, `on-radar`, `updated`, `done`, `paused`
**Side effects:**
- Status change → history entry (`type: 'status-change'`)
- Changing to `done` → sets `doneAt`
- Changing from `done` → clears `doneAt`

### 6.5 DELETE /api/tasks/:id

**Response:** `{ success: true }` or 404

### 6.6 DELETE /api/tasks/:id/history/:index

**Validation:**
- Index must be a valid non-negative integer
- Only `update`, `note`, and `review-response` types can be deleted
- System types (`created`, `status-change`, `scan-update`, `enriched`, `enrich-error`, `thread-update`, `update-check`, `update-check-error`, `summary-update`) → HTTP 403
**Response:** Updated task object

### 6.7 POST /api/tasks/:id/note

**Request body:** `{ text: string }`
**Side effects:** Adds history entry `{ type: 'note', text }`, updates `updatedAt`
**Response:** Updated task object

### 6.8 POST /api/scan

**Request body:** `{ scanDays?: number }` (1–14, default 4)
**Prompting:** Primary inline question **"Which messages need my action?"**; `SCAN_DISCOVERY_SKILL.md` is retained as fallback guidance, not the primary prompt
**Side effects:**
- Creates new tasks (status `new`, `summary: null`, `enrichmentStatus: "pending"`)
- Updates existing tasks (matched by `existingId`)
- Sets `lastScan` timestamp
**Response:** `{ success, added, skipped, updated, total, newTaskIds[], lastScan }`
**Error responses:**
- 502: No response from AI engine
- 502: AI returned unexpected format (includes `raw` field)
- 500: Scan failed

### 6.8a POST /api/tasks/:id/enrich

**Request body:** none
**Side effects:**
- Opens fresh Work IQ session, reads full email body
- Sets `summary`, `enrichmentStatus: "enriched"`, `enrichedAt`
- On failure: sets `enrichmentStatus: "error"`
**Response:** `{ success, summary, language, confidence, enrichmentStatus }`
**Timeout:** 300 seconds

### 6.8b POST /api/tasks/:id/check-update

**Request body:** none
**Side effects:**
- Checks for thread replies since last update check
- If update found: sets `updateCheckStatus: "updated"`, sets `status: "updated"`, appends "📌 Update:" to summary as fallback
- **Post-update evaluation:** After finding updates, runs a second AI call (pure reasoning, no Work IQ) to evaluate whether title and summary should be intelligently rewritten. If evaluation succeeds, overwrites the crude append with refined title/summary. Creates `title-change` / `summary-update` history entries.
- If no update: sets `updateCheckStatus: "checked"`
**Response:** `{ success, hasUpdate, updateCheckStatus, evaluation? }`
**Timeout:** 300 seconds (search) + 30 seconds (evaluation)

### 6.9 POST /api/tasks/:id/log/analyze

**Request body:** `{ text: string }`
**Response (update/summarize/answer/rename):** `{ intent, result, task }` — result saved to history immediately
**Response (correct):** `{ intent: 'correct', plan: { disputedClaim, userAssertion, affectedFields, keywords, keywordsEnglish, verificationQuestion } }` — correction plan returned for verification
**Response (search):** `{ intent: 'search', plan: AgentPlan, fallback? }` — plan returned for user confirmation
**AI prompt includes:** Task context (title, from, source, date) + last 8 conversation entries
**Model:** Default Copilot model routing (explicit Claude Opus 4.6 override removed) for reasoning-based intent classification, especially correction detection
**Update handling:** `update` intent uses a Verify-and-Improve loop — **Execute → Verify → Improve** as separate no-MCP reasoning calls, with at most 1 Improve retry and graceful fallback to the Execute result
**Timeout:** 30 seconds for Copilot SDK analysis

### 6.10 POST /api/tasks/:id/log

**Request body:** `{ text: string, plan?: AgentPlan }`
**With plan + SEARCH_SKILL:** Uses Copilot SDK + Work IQ MCP + SEARCH_SKILL.md for intelligent goal-oriented search (v2.2 primary path, 300s timeout)
**With plan, no SEARCH_SKILL:** Falls back to Copilot SDK + Work IQ MCP + LOG_WORK_SKILL.md (legacy path, 300s timeout)
**Without plan:** Falls back to Copilot SDK + Work IQ MCP session with minimal inline prompt (300s timeout)
**Side effects:** Adds history entry with `communications[]`, `agentPlan`, `agentResponse`, `agentExecution`
**Post-search evaluation:** After search results are saved, a second AI call (pure reasoning, no Work IQ) evaluates whether title and summary should be updated. If so, creates additional `title-change` / `summary-update` history entries. Response includes `evaluation` field with `{ titleChanged, newTitle, summaryChanged, newSummary, reasoning }`.
**Response parsing:** SEARCH_SKILL JSON object first → legacy JSON array → Markdown email parser → raw text

### 6.11 POST /api/tasks/:id/correct

**Request body:** `{ plan: { disputedClaim, userAssertion, affectedFields, keywords, keywordsEnglish, verificationQuestion } }`
**Model:** Default Copilot model routing (explicit Claude Opus 4.6 override removed) for nuanced evidence evaluation
**MCP:** Work IQ (email, Teams, calendar search)
**Skill:** CORRECT_SKILL.md (3-attempt search, truth hierarchy, evidence-based verdict)
**Timeout:** 300 seconds
**Verdicts:**
- `user_correct` → correction applied automatically (title/summary updated, `correction` history entry)
- `current_correct` → no changes made, evidence returned for user review
- `inconclusive` → no changes made, user offered Accept or Veto option
**Response:** `{ verdict, confidence, explanation, evidence[], searchAttempts[], applied, suggestedTitle?, suggestedSummary?, task }`

### 6.12 POST /api/tasks/:id/correct/resolve

**Request body:** `{ action: 'accept' | 'veto', correctedTitle?: string, correctedSummary?: string }`
**Purpose:** Resolves a correction discussion after `current_correct` or `inconclusive` verdict
- `accept` → user confirms current information is correct. Logs `correction-dismissed` history entry.
- `veto` → user overrides. Applies `correctedTitle`/`correctedSummary`. Logs `correction-veto` + `title-change`/`summary-update` history entries.
**Response:** `{ success, action, task }`

---

## 7. Skill Files

External Markdown files loaded at server startup:

| File | Path | Purpose |
|---|---|---|
| `SCAN_DISCOVERY_SKILL.md` | `docs/SCAN_DISCOVERY_SKILL.md` | Phase 1 legacy/fallback discovery guidance (inline question is primary in v3.0.0) |
| `ENRICH_SKILL.md` | `docs/ENRICH_SKILL.md` | Phase 2: Content extraction + summary prompt |
| `UPDATE_CHECK_SKILL.md` | `docs/UPDATE_CHECK_SKILL.md` | Phase 3: Thread update check prompt |
| `CONSOLIDATE_SKILL.md` | `docs/CONSOLIDATE_SKILL.md` | Phase 4: Task consolidation / duplicate detection prompt |
| `SEARCH_SKILL.md` | `docs/SEARCH_SKILL.md` | Intelligent communication search prompt (v2.2) |
| `CORRECT_SKILL.md` | `docs/CORRECT_SKILL.md` | Correction verification prompt (v2.6, default model; explicit Opus override removed) |
| `SCAN_SKILL.md` | `docs/SCAN_SKILL.md` | Legacy scan skill (backup/fallback) |
| `LOG_WORK_SKILL.md` | `docs/LOG_WORK_SKILL.md` | Communication search prompt template (fallback path) |

If a skill file is missing, a warning is logged and the server falls back to inline prompts.

---

## 8. File Structure

```
Agent_Zero/
├── index.html                        (~2256 lines, frontend)
├── server.js                         (~1789 lines, backend)
├── package.json                      (project metadata + dependencies)
├── package-lock.json                 (dependency lock file)
├── tasks.json                        (task data, in .gitignore)
├── .gitignore
├── START-AGENT-ZERO.bat                  (launcher: port check, start server, open browser)
├── README.md
├── docs/
│   ├── ARCHITECTURE.md               (technical architecture document)
│   ├── CHANGELOG.md                  (version history v1.0 → v2.2)
│   ├── SCAN_DISCOVERY_SKILL.md       (Phase 1 fallback prompt)
│   ├── ENRICH_SKILL.md               (Phase 2 enrichment prompt)
│   ├── UPDATE_CHECK_SKILL.md         (Phase 3 update check prompt)
│   ├── CONSOLIDATE_SKILL.md         (Phase 4 task consolidation prompt)
│   ├── SEARCH_SKILL.md               (intelligent search prompt, v2.2)
│   ├── CORRECT_SKILL.md              (correction verification prompt, v2.6)
│   ├── SCAN_SKILL.md                 (legacy scan prompt, fallback)
│   ├── LOG_WORK_SKILL.md             (legacy log work prompt, fallback)
│   ├── FEATURE_INVENTORY_Claude_Code_Codex_Analyse.md  (code review)
│   ├── VIDEO_DESCRIPTION.md          (video script foundation)
│   └── archive/                      (previous doc versions)
├── Specifactions/
│   └── AGENT_ZERO_SPEC.md           (this document)
├── Images/                           (screenshots and diagrams)
└── Security report/                  (security analysis)
```

---

## 9. UI State Persistence (localStorage)

| Key | Type | Default | Description |
|---|---|---|---|
| `scanDays` | string (number) | `"4"` | Selected scan range (1–14) |
| `cleanupDays` | string (number) | `"3"` | Done task retention in days (1–30) |
| `linkMode` | string | `"window"` | Link open mode (window/tab; defunct split/incognito auto-migrated to window) |
| `openPanels` | JSON array | `[]` | Task IDs with open interaction panels |
| `collapsedEntries` | JSON array | `[]` | Collapse IDs for long conversation entries |
