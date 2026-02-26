# Agent Zero — Product Specification

**Version:** 2.0
**Date:** February 26, 2026
**Author:** Martin Hämmerli
**Status:** v2.0 implemented (Intent-Based Agent + Interaction Panel + Execution Tracing)

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
| Copilot SDK + MCP | Scan, Analyze (intent detection) | `CopilotClient` → `createSession()` with/without MCP servers |
| Work IQ CLI (`workiq ask`) | Search execution | Direct `spawn('workiq', ['ask'])` via stdin — proven more reliable than wrapping Work IQ in another AI layer |

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
| `uuid` | ^13.0.0 | UUID generation for task IDs |

**Note:** `@microsoft/workiq` is installed globally, not as a project dependency.

---

## 4. Features

### 4.1 Scan Trigger

- A prominent **"Scan Emails & Teams"** button in the header
- **Configurable scan range:** slider (1–14 days, default 4) persisted in `localStorage`
- The scan days value is sent in the request body: `{ scanDays: <number> }`
- When triggered, the backend:
  1. Reads existing tasks from `tasks.json` (active + done for dedup context)
  2. Calls Work IQ via Copilot SDK (MCP session) to scan emails and Teams
  3. AI identifies action items AND matches them against existing tasks (semantic dedup)
  4. **New items** → added with status `new`
  5. **Matched items with changes** → existing task updated + `scan-update` history entry
  6. **Matched items without changes** → skipped
  7. **Items matching done tasks** → action `skip`, not re-created
  8. Returns updated counts to frontend
- **Non-blocking scan banner:** inline bar below header (not fullscreen overlay) with:
  - Spinner + animated progress steps (9 steps from "Connecting to AI engine..." to "Hang tight — finalizing...")
  - Elapsed time counter (`⏱ MM:SS`)
  - Timeout warning at 90 seconds (amber color)
- Scan button disabled during scan (text changes to "Scanning...")
- After completion: notification toast with result summary
- Scan prompt uses `SCAN_SKILL.md` if available, with fallback to inline prompt

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

- Input form at the bottom of the page: title (required) + notes (optional)
- Created with `source: 'manual'`, `status: 'new'`, `from: null`, `date: null`
- History entry: `{ type: 'created', text: 'Task created manually' }`
- Add Task button disabled when server is offline

### 4.5 Task Deletion

- Red ✕ button on each task card
- `DELETE /api/tasks/:id` removes the task from `tasks.json`
- If another task has an active agent (`busyTaskIds`), deletion uses minimal DOM update (removes card without full re-render)

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

- **Conversations:** Chat-like display of all `update` and `note` history entries (chronological order, oldest first)
- **Input form:** Text input + 3 buttons:
  - **📤 Send** — sends to AI agent for analysis (`analyzeLog`)
  - **📝 Note** — saves directly as note (no agent interaction)
  - **▶ Execute** — appears in plan UI after search intent analysis
- **Plan display:** Shows search plan details (understanding, from, keywords, time window, targets) with Execute/Cancel buttons
- **Clarification:** If agent sets `needsClarification: true`, shows a follow-up input
- **Details toggle:** Expandable section showing execution trace (4-step: Auftrag → Gesendet → Antwort → Ergebnis) and system events

**Visual indicators:**
- **Neon-pink border** (`.has-content`): Task has conversation entries
- **Green border + pulse animation** (`.agent-busy`): Task has active agent work
- **Green background** (`.active-panel`): Panel is currently open

### 4.9 Intent-Based Agent (3 Intents)

The agent uses a two-phase approach:

**Phase 1 — Analyze** (`POST /api/tasks/:id/log/analyze`):
- Uses Copilot SDK **without** Work IQ MCP (fast, AI reasoning only, ~5–15s)
- Determines one of 3 intents based on user message + task context + conversation history

| Intent | Trigger Examples | Behavior | Requires Execute? |
|---|---|---|---|
| `summarize` | "fasse zusammen", "summarize this", "key points" | AI summarizes the content provided in the message | No — result saved immediately |
| `answer` | "bis wann?", "what's the deadline?", "who is responsible?" | AI answers from task context + conversation history | No — result saved immediately |
| `search` | "find emails from", "was hat X geschrieben?", "check inbox" | AI returns a search plan with parameters | Yes — user must click Execute |

**Conversation context:** Last 8 history entries of type `update` or `note` are included in the analyze prompt, with full details (user text, agent intent, understanding, communications).

**Phase 2 — Execute** (`POST /api/tasks/:id/log`):
- Only for `search` intent, triggered by user clicking Execute
- Uses **Work IQ CLI** (`workiq ask` via stdin) for M365 data access — direct spawn, not wrapped in Copilot SDK
- Builds a natural language search question from the plan parameters (`buildSearchQuestion()`)
- Timeout: 90 seconds for `workiq ask`
- Parses response as JSON, or falls back to Markdown email parser (`parseMarkdownEmails()`)
- Generates `agentResponse` summary server-side (see 4.13)
- Falls back to Copilot SDK + MCP if no plan is provided

**Deterministic fallback:** If AI analysis fails, `extractKeywords()` generates a search plan from the task title (stop-word removal), with default time window from task date to today.

### 4.10 Auto-Cleanup

- Done tasks older than 3 days (based on `doneAt` timestamp) are hidden from the UI during `renderTasks()`
- Tasks are NOT deleted from `tasks.json` — only hidden from display
- Filter badge counts use only visible tasks

### 4.11 Server Status Detection

- `checkServerHealth()` with `AbortController` (3-second timeout) on `/api/tasks`
- **Offline banner** (amber) with startup instructions:
  - Option 1: Double-click `START-DAILY-BRIEFING.bat`
  - Option 2: Terminal command `cd E:\Work_IQ\Daily_Tasks && node server.js`
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
| `update` | Agent interaction (Send) | Yes | User message + agent response |
| `note` | Note button | Yes | User-saved note (no agent) |

**History deletion:** `DELETE /api/tasks/:id/history/:index` — only `update` and `note` types can be deleted (system entries are protected with HTTP 403). Each conversation entry has a 🗑️ button (low opacity, visible on hover).

### 4.13 Agent Response (agentResponse)

The `agentResponse` field is generated **server-side** after search execution completes (`POST /api/tasks/:id/log`):

| Condition | agentResponse Content |
|---|---|
| Search error | `❌ Die Suche ist fehlgeschlagen: <error>` |
| Communications found | `✅ N Kommunikation(en) gefunden:\n\n` + numbered list with icons, senders, dates, summaries |
| Raw text but no structured data | The raw Work IQ response text (natural language) |
| No results | `🔍 Keine Ergebnisse gefunden...` with suggestion to retry with different terms |

**Frontend display:** For search intents, `renderConversations()` shows `agentResponse` (final result) instead of `understanding` (plan). For summarize/answer intents, `understanding` contains the direct result.

### 4.14 Execution Tracing

Every search execution saves an `agentExecution` object:

```json
{
  "promptSent": "<search question sent to Work IQ>",
  "rawResponse": "<first 8000 chars of Work IQ response>",
  "parsedCount": 3,
  "error": null,
  "durationMs": 45200,
  "method": "workiq-ask"
}
```

**Methods:** `workiq-ask` (direct CLI) or `copilot-sdk-mcp` (fallback via Copilot SDK).

The Details panel renders execution trace in 4 numbered steps:
1. **1️⃣ Auftrag** — Agent plan (understanding, keywords, time window, targets)
2. **2️⃣ Gesendet an Work IQ** — The prompt/question sent, with method label
3. **3️⃣ Antwort von Work IQ** — Raw response (truncated to 800 chars) with duration, or error
4. **4️⃣ Ergebnis für Benutzer** — Parsed communications list, or natural language fallback

### 4.15 Link Open Mode

Header selector with 4 modes (persisted in `localStorage`):

| Mode | Icon | Behavior |
|---|---|---|
| `window` | 🪟 | Opens link in new browser window (default) |
| `tab` | 📑 | Opens link in new tab |
| `split` | ◧ | Moves Agent Zero to left half, opens link in right half (50/50) |
| `incognito` | 🕶️ | Attempts private window (falls back to regular window with notification) |

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
- **Busy task tracking** (`busyTaskIds` Set): When an agent is working on a task:
  - Card gets green border + pulse animation
  - Status changes on OTHER tasks use inline DOM updates (no full re-render)
  - Task deletion uses minimal DOM removal
- **Multiple concurrent agents:** Multiple tasks can have active agent work simultaneously
- **Panel persistence** (`openPanelTaskIds`): Open panels survive `fetchTasks()` re-renders, restored from `localStorage`
- **Pending plan restoration:** After re-render, pending search plans are re-displayed for open panels

---

## 5. Data Schema (v2)

### 5.1 tasks.json Structure

```json
{
  "version": 2,
  "lastScan": "2026-02-26T10:30:00.000Z",
  "tasks": [ ... ]
}
```

### 5.2 Task Object

| Field | Type | Description |
|---|---|---|
| `id` | string (UUID) | Unique identifier |
| `title` | string | Action item description |
| `source` | string | `"email"`, `"teams"`, or `"manual"` |
| `from` | string \| null | Sender name |
| `date` | string \| null | Original message date (ISO 8601) |
| `link` | string \| null | Deep link to original message |
| `status` | string | One of 6 statuses (see 4.3) |
| `notes` | string | Free-text notes |
| `history` | HistoryEntry[] | Array of history entries |
| `doneAt` | string \| null | ISO timestamp when status changed to done |
| `createdAt` | string | ISO timestamp of creation |
| `updatedAt` | string | ISO timestamp of last modification |

### 5.3 HistoryEntry Object

| Field | Type | Required | Description |
|---|---|---|---|
| `timestamp` | string | Yes | ISO 8601 timestamp |
| `type` | string | Yes | `"created"`, `"status-change"`, `"scan-update"`, `"update"`, `"note"` |
| `text` | string | Yes | User message or system description |
| `communications` | Communication[] | No | Found emails/messages (search results) |
| `agentPlan` | AgentPlan | No | AI analysis result |
| `agentResponse` | string | No | Final formatted result after search (see 4.13) |
| `agentExecution` | AgentExecution | No | Execution trace metadata (see 4.14) |

### 5.4 AgentPlan Object

| Field | Type | Description |
|---|---|---|
| `intent` | string | `"summarize"`, `"search"`, or `"answer"` |
| `understanding` | string | For search: action plan description. For summarize/answer: the result text |
| `searchFrom` | string \| null | Person name, email domain, or null |
| `keywords` | string[] | Search terms (only used if searchFrom is null) |
| `timeWindow` | object | `{ from, to, reasoning }` |
| `searchTargets` | string | `"inbox"`, `"sent"`, `"teams"`, or `"all"` |
| `needsClarification` | boolean | Whether agent needs more info |
| `clarificationQuestion` | string \| null | Follow-up question if clarification needed |
| `userConfirmed` | boolean | Set to `true` when user clicks Execute (only on saved entries) |
| `fallback` | boolean | `true` if deterministic fallback was used |

### 5.5 AgentExecution Object

| Field | Type | Description |
|---|---|---|
| `promptSent` | string | Search question sent to Work IQ |
| `rawResponse` | string | Raw Work IQ response (first 8000 chars for workiq-ask, 2000 for SDK) |
| `parsedCount` | number | Number of communications parsed |
| `error` | string \| null | Error message if search failed |
| `durationMs` | number | Search duration in milliseconds |
| `method` | string | `"workiq-ask"` or `"copilot-sdk-mcp"` |

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

### 6.1 Endpoints

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/tasks` | Return all tasks + metadata |
| `POST` | `/api/tasks` | Create manual task |
| `PATCH` | `/api/tasks/:id` | Update task (status, notes, title) |
| `DELETE` | `/api/tasks/:id` | Delete a task |
| `DELETE` | `/api/tasks/:id/history/:index` | Delete a history entry |
| `POST` | `/api/tasks/:id/note` | Save a note (no agent) |
| `POST` | `/api/scan` | Scan M365 emails and Teams |
| `POST` | `/api/tasks/:id/log/analyze` | Phase 1: AI intent analysis |
| `POST` | `/api/tasks/:id/log` | Phase 2: Execute search |

### 6.2 GET /api/tasks

**Response:** `{ version, lastScan, tasks[] }`

### 6.3 POST /api/tasks

**Request body:** `{ title: string, notes?: string }`
**Response:** Created task object (HTTP 201)
**Validation:** Title required and non-empty

### 6.4 PATCH /api/tasks/:id

**Request body:** `{ status?, notes?, title? }` (any subset)
**Valid statuses:** `new`, `needs-attention`, `escalated`, `in-progress`, `done`, `paused`
**Side effects:**
- Status change → history entry (`type: 'status-change'`)
- Changing to `done` → sets `doneAt`
- Changing from `done` → clears `doneAt`

### 6.5 DELETE /api/tasks/:id

**Response:** `{ success: true }` or 404

### 6.6 DELETE /api/tasks/:id/history/:index

**Validation:**
- Index must be a valid non-negative integer
- Only `update` and `note` types can be deleted
- System types (`created`, `status-change`, `scan-update`) → HTTP 403
**Response:** Updated task object

### 6.7 POST /api/tasks/:id/note

**Request body:** `{ text: string }`
**Side effects:** Adds history entry `{ type: 'note', text }`, updates `updatedAt`
**Response:** Updated task object

### 6.8 POST /api/scan

**Request body:** `{ scanDays?: number }` (1–14, default 4)
**Side effects:**
- Creates new tasks (status `new`)
- Updates existing tasks (matched by `existingId`)
- Sets `lastScan` timestamp
**Response:** `{ success, added, skipped, updated, total, lastScan }`
**Error responses:**
- 502: No response from AI engine
- 502: AI returned unexpected format (includes `raw` field)
- 500: Scan failed

### 6.9 POST /api/tasks/:id/log/analyze

**Request body:** `{ text: string }`
**Response (summarize/answer):** `{ intent, result, task }` — result saved to history immediately
**Response (search):** `{ intent: 'search', plan: AgentPlan, fallback? }` — plan returned for user confirmation
**AI prompt includes:** Task context (title, from, source, date) + last 8 conversation entries
**Timeout:** 30 seconds for Copilot SDK analysis

### 6.10 POST /api/tasks/:id/log

**Request body:** `{ text: string, plan?: AgentPlan }`
**With plan:** Uses `workiq ask` CLI (direct stdin, 90s timeout). Builds search question from plan via `buildSearchQuestion()`
**Without plan:** Falls back to Copilot SDK + Work IQ MCP session (120s timeout)
**Side effects:** Adds history entry with `communications[]`, `agentPlan`, `agentResponse`, `agentExecution`
**Response parsing:** JSON first, then Markdown email parser (`parseMarkdownEmails()`), then raw text

---

## 7. Skill Files

External Markdown files loaded at server startup:

| File | Path | Purpose |
|---|---|---|
| `SCAN_SKILL.md` | `Documents/SCAN_SKILL.md` | Detailed scan prompt template with JSON output format |
| `LOG_WORK_SKILL.md` | `Documents/LOG_WORK_SKILL.md` | Communication search prompt template (fallback path) |

If a skill file is missing, a warning is logged and the server falls back to inline prompts.

---

## 8. File Structure

```
Agent_Zero/
├── index.html                        (~1430 lines, frontend)
├── server.js                         (~950 lines, backend)
├── package.json                      (project metadata + dependencies)
├── package-lock.json                 (dependency lock file)
├── tasks.json                        (task data, in .gitignore)
├── .gitignore
├── START-DAILY-BRIEFING.bat          (launcher: port check, start server, open browser)
├── README.md
├── Documents/
│   ├── ARCHITECTURE.md               (technical architecture document)
│   ├── SCAN_SKILL.md                 (scan prompt template)
│   └── LOG_WORK_SKILL.md             (log work prompt template)
├── Specifactions/
│   └── DAILY_BRIEFING_APP_SPEC.md    (this document)
└── Images/                           (screenshots and diagrams)
```

---

## 9. UI State Persistence (localStorage)

| Key | Type | Default | Description |
|---|---|---|---|
| `scanDays` | string (number) | `"4"` | Selected scan range (1–14) |
| `linkMode` | string | `"window"` | Link open mode (window/tab/split/incognito) |
| `openPanels` | JSON array | `[]` | Task IDs with open interaction panels |
| `collapsedEntries` | JSON array | `[]` | Collapse IDs for long conversation entries |
