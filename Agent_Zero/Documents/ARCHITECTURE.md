# Agent Zero — Technical Architecture

**Version:** 2.5
**Date:** February 27, 2026
**Author:** Martin Hämmerli

---

## 1. System Overview

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                          Browser (index.html)                               │
│                          ~1620 lines, vanilla JS                            │
│                                                                             │
│  ┌────────────┐  ┌─────────────┐  ┌──────────┐  ┌───────────────────────┐  │
│  │ Scan Button │  │ Task Cards  │  │ Filters  │  │ Interaction Panel     │  │
│  │ + Slider    │  │ (sorted,    │  │ (6+All)  │  │ (Chat, Agent, Notes,  │  │
│  │ + Link Mode │  │  filtered)  │  │          │  │  Plan, Details)       │  │
│  └──────┬─────┘  └──────┬──────┘  └────┬─────┘  └──────────┬────────────┘  │
│         │               │              │                    │               │
│         └───────────────┴──────────────┴────────────────────┘               │
│                                    │                                        │
│                          fetch() REST API                                   │
└────────────────────────────────────┼────────────────────────────────────────┘
                                     │
                              HTTP (localhost:3000)
                                     │
┌────────────────────────────────────┼────────────────────────────────────────┐
│                   Node.js Express Server (server.js)                        │
│                   ~1090 lines, ES Modules                                   │
│                                    │                                        │
│        ┌───────────────────────────┼───────────────────────────┐            │
│        │                           │                           │            │
│   ┌────┴──────┐          ┌─────────┴─────────┐          ┌─────┴──────┐     │
│   │ REST API  │          │  AI Integration    │          │ tasks.json │     │
│   │ Endpoints │          │                    │          │ (File I/O) │     │
│   │ (8 routes)│          │  ┌──────────────┐  │          │            │     │
│   └───────────┘          │  │ Copilot SDK  │  │          └────────────┘     │
│                          │  │ (reasoning)  │  │                             │
│                          │  └──────┬───────┘  │                             │
│                          │         │          │                             │
│                          │  ┌──────┴───────┐  │                             │
│                          │  │ Work IQ MCP  │  │                             │
│                          │  │ (stdio, scan)│  │                             │
│                          │  └──────────────┘  │                             │
│                          │                    │                             │
│                          │  ┌──────────────┐  │                             │
│                          │  │ workiq ask   │  │                             │
│                          │  │ (CLI, search)│  │                             │
│                          │  └──────┬───────┘  │                             │
│                          └─────────┼──────────┘                             │
└────────────────────────────────────┼────────────────────────────────────────┘
                                     │
                            HTTPS (graph.microsoft.com)
                                     │
                           ┌─────────┴──────────┐
                           │  Microsoft Graph   │
                           │       API          │
                           └─────────┬──────────┘
                                     │
                           ┌─────────┴──────────┐
                           │    M365 Data       │
                           │ (Emails, Teams)    │
                           └────────────────────┘
```

### Component Roles

| Component | Role |
|---|---|
| **Browser (index.html)** | Single-page frontend. Renders task cards, filters, interaction panels, agent chat. All HTML, CSS, and JS in one file. Dark theme, no framework. |
| **Express Server (server.js)** | Backend API server. 8 REST endpoints for CRUD, scanning, intent analysis, and search execution. Manages write queue for concurrency. |
| **Copilot SDK (CopilotClient)** | AI reasoning engine. Used for scan (with MCP) and analyze (without MCP). Creates sessions, sends prompts, parses structured JSON responses. |
| **Work IQ MCP** | MCP-compatible tool server (stdio). Used by Copilot SDK during scan operations. Bridges to Microsoft Graph API for M365 data retrieval. |
| **workiq ask (CLI)** | Direct CLI interface to Work IQ. Used for search execution (primary). Spawned as child process, question sent via stdin. More reliable than wrapping in Copilot SDK. |
| **Microsoft Graph API** | Microsoft's REST API for M365 data. Provides access to emails (Outlook) and chat messages (Teams). |
| **tasks.json** | Local JSON file for persistent storage. Schema v2 with tasks array, history entries, agent plans, and execution traces. |

### Two AI Integration Methods

| Method | Used By | How |
|---|---|---|
| **Copilot SDK + MCP** | Scan, Analyze (intent detection) | `CopilotClient` → `createSession()` with/without MCP servers |
| **workiq ask (CLI)** | Search execution (primary) | Direct `spawn('workiq', ['ask'])` via stdin — proven more reliable than wrapping in Copilot SDK |
| **Copilot SDK + MCP** | Search execution (fallback) | Used when no plan is available (legacy v1.3 behavior) |

### Startup Flow (START-DAILY-BRIEFING.bat)

```
User double-clicks BAT
        │
        ▼
BAT checks port 3000 ──► already in use? ──► open browser, exit
        │ no
        ▼
node server.js (separate minimized window via start /MIN)
        │
        ▼
Poll for server ready (max 15 attempts, 1s each)
        │
        ▼
Server ready → open http://localhost:3000 in default browser
```

---

## 2. Component Details

### 2.1 Frontend (index.html)

- **Lines:** ~1620 (HTML + CSS + JS in single file)
- **Framework:** None — vanilla JavaScript, no build step
- **Theme:** Dark (`background: #0b0d17`, `color: #e0e0e0`)
- **Font:** System font stack (`-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto`)

**Key UI elements:**
- Header with title, server status dot (tooltip), last scan time, scan button + slider, link mode selector
- Scan status banner (non-blocking, below header, with progress steps and timer)
- Filter bar (7 buttons: All + 6 statuses, with dynamic badge counts)
- Task card list (sorted, filtered, with interaction panels)
- Add task form (title + optional notes)
- Notification toast (fixed position, auto-dismiss 5s)

### 2.2 Backend (server.js)

- **Lines:** ~1090
- **Module system:** ES Modules (`"type": "module"` in package.json)
- **Port:** 3000 (hardcoded)
- **Skill files loaded at startup:** `Documents/SCAN_SKILL.md`, `Documents/LOG_WORK_SKILL.md`

**Key backend components:**
- `readTasks()` / `writeTasks()` — synchronous file I/O for tasks.json
- `safeWriteTasks(mutationFn)` — promise-chain write queue for concurrency
- `runWorkIQAsk(question, timeoutMs)` — spawns `workiq ask` process, sends question via stdin
- `buildSearchQuestion(plan, taskContext, userText)` — constructs natural language question from search plan
- `parseJsonFromResponse(text)` — extracts JSON from AI responses (direct, code block, or array match)
- `parseMarkdownEmails(text)` — parses Work IQ Markdown responses into structured communication objects
- `migrateTasks()` — v1 → v2 schema migration (adds history, doneAt)
- `migrateStatuses()` — `active` → `new` status migration
- Dedup helpers: `normalizeForCompare()`, `isSimilarTitle()` (Jaccard)
- Keyword extraction: `extractKeywords()` (for deterministic fallback)

### 2.3 Data Store (tasks.json)

- **Location:** Project root (same directory as server.js)
- **Schema version:** 2
- **Git:** Listed in `.gitignore` (contains personal M365 data)
- **Concurrency:** Protected by `safeWriteTasks()` write queue
- **File format:** Pretty-printed JSON (2-space indent, trailing newline)

### 2.4 AI Engine: Copilot SDK

- **Package:** `@github/copilot-sdk` (^0.1.25)
- **Usage pattern:** Create client → create session (with/without MCP) → sendAndWait → destroy session → dispose client
- **Session types:**
  - With MCP servers (scan): `{ mcpServers: { workiq: { type: 'stdio', command: 'workiq', args: ['mcp'], tools: '*' } } }`
  - Without MCP (analyze): `{}` — pure AI reasoning, no tool access
- **Timeouts:** 120s for scan, 30s for analyze

### 2.5 Search Engine: workiq ask CLI

- **Binary:** `workiq` (globally installed via npm)
- **Invocation:** `spawn('workiq', ['ask'], { stdio: ['pipe', 'pipe', 'pipe'], shell: true })`
- **Input:** Question sent via stdin after 500ms init delay, then stdin.end()
- **Timeout:** 90s default
- **Why stdin:** `workiq ask -q` writes to console/TTY directly, bypassing stdout capture. Interactive mode via stdin works correctly.

---

## 3. Data Flow Diagrams

### 3.1 Scan Flow (Multi-Phase Pipeline)

```
User clicks "Scan Emails & Teams"
        │
        ▼ POST /api/scan { scanDays }
┌───────────────────────────────────────────────────────────┐
│ PHASE 1: Discovery — Subject Lines Only                    │
│                                                            │
│  1. Read existing tasks from tasks.json                    │
│  2. Load SCAN_DISCOVERY_SKILL.md (subject-only rules)      │
│  3. Inject existing tasks as JSON context                   │
│  4. AI scans emails/Teams — returns subject + sender + date │
│  5. Parse & Dedup (Jaccard, link, title+from+source)        │
│  6. Create tasks with summary=null, enrichmentStatus=       │
│     "pending", updateCheckStatus="pending"                  │
│  7. Return { added, skipped, updated, newTaskIds[] }        │
└───────────────────────┬───────────────────────────────────┘
                        │
            ┌───── for each newTaskId (sequential) ─────┐
            │                                            │
            ▼ POST /api/tasks/:id/enrich                 │
┌───────────────────────────────────────────────────┐    │
│ PHASE 2: Enrichment — Content Extraction           │    │
│                                                    │    │
│  1. Freeze task card (neon blue, no interaction)   │    │
│  2. Open fresh Work IQ session                     │    │
│  3. Load ENRICH_SKILL.md (multi-pass strategy)     │    │
│  4. AI reads full email body → generates summary   │    │
│  5. Save summary, set enrichmentStatus="enriched"  │    │
│  6. Unfreeze task card                              │    │
└───────────────────────────────────────────────────┘    │
            │                                            │
            └────────────────────────────────────────────┘
                        │
            ┌───── for each enriched task (sequential) ─┐
            │                                            │
            ▼ POST /api/tasks/:id/check-update           │
┌───────────────────────────────────────────────────┐    │
│ PHASE 3: Update Check — Thread Replies              │    │
│                                                    │    │
│  1. Freeze task card                                │    │
│  2. Check for thread replies since task creation    │    │
│  3. If update found: append "📌 Update:" to summary │    │
│  4. Set updateCheckStatus="checked" or "updated"    │    │
│  5. Unfreeze task card                              │    │
└───────────────────────────────────────────────────┘    │
            │                                            │
            └────────────────────────────────────────────┘
                        │
                        ▼
              Final fetchTasks() → re-render all cards
```

### 3.2 Agent Flow (Intent-Based)

```
User types message in Interaction Panel
        │
        ▼ POST /api/tasks/:id/log/analyze { text }
┌───────────────────────────────────────────────────────────┐
│ Phase 1: Intent Analysis (Copilot SDK, no MCP — fast)      │
│                                                            │
│  Build prompt with:                                         │
│  - Task context (title, from, source, date)                 │
│  - Recent conversation history (last 8 update/note entries) │
│  - User's message                                           │
│                                                            │
│  AI determines intent:                                      │
│  ┌─────────────┬───────────────────────────────────────┐    │
│  │ "summarize" │ User pasted content to summarize.     │    │
│  │             │ AI returns result immediately.         │    │
│  │             │ Saved to history → response to client. │    │
│  ├─────────────┼───────────────────────────────────────┤    │
│  │ "answer"    │ User asked a question answerable from │    │
│  │             │ task context or general knowledge.     │    │
│  │             │ AI returns result immediately.         │    │
│  │             │ Saved to history → response to client. │    │
│  ├─────────────┼───────────────────────────────────────┤    │
│  │ "search"    │ User wants to find emails/Teams msgs. │    │
│  │             │ AI returns a search plan with:         │    │
│  │             │ understanding, searchFrom, keywords,   │    │
│  │             │ timeWindow, searchTargets.             │    │
│  │             │ Plan sent to client for confirmation.  │    │
│  └─────────────┴───────────────────────────────────────┘    │
│                                                            │
│  Fallback: extractKeywords() + default time window          │
└───────────────────────┬───────────────────────────────────┘
                        │
         ┌──────────────┼──────────────┐
         │              │              │
    summarize       answer         search
    (immediate)   (immediate)    (plan shown)
         │              │              │
         ▼              ▼              ▼
    Re-render       Re-render     User clicks
    conversations   conversations "▶ Execute"
                                       │
                                       ▼ POST /api/tasks/:id/log { text, plan }
┌──────────────────────────────────────────────────────────────┐
│ Phase 2: Search Execution                                     │
│                                                               │
│  Primary: workiq ask (CLI)                                     │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ buildSearchQuestion(plan, taskContext, userText)          │   │
│  │  → "Find all emails from X in my inbox from last N days" │   │
│  │                                                           │   │
│  │ runWorkIQAsk(question, 90000)                             │   │
│  │  → spawn workiq ask, send question via stdin              │   │
│  │  → parse response: JSON first, Markdown fallback          │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                               │
│  Fallback: Copilot SDK + MCP (when no plan available)          │
│  ┌─────────────────────────────────────────────────────────┐   │
│  │ CopilotClient → createSession({ mcpServers: workiq })    │   │
│  │ LOG_WORK_SKILL.md prompt or inline prompt                 │   │
│  │ session.sendAndWait(prompt, 120000)                       │   │
│  └─────────────────────────────────────────────────────────┘   │
│                                                               │
│  Build agentResponse summary from results                      │
│  Save history entry with communications, agentPlan,            │
│  agentResponse, agentExecution trace                           │
└───────────────────────────────┬──────────────────────────────┘
                                │
                                ▼
                      safeWriteTasks() → tasks.json
                      Response: updated task object
```

### 3.3 Note Flow

```
User types text → clicks "📝 Note"
        │
        ▼ POST /api/tasks/:id/note { text }
        │
  safeWriteTasks():
    push { timestamp, type: "note", text } to task.history
        │
        ▼
  Response: updated task object
  Frontend: re-render, show "📝 Note saved" notification
```

---

## 4. Data Schema v3

### Root Object

```json
{
  "version": 3,
  "tasks": [ Task, ... ],
  "lastScan": "2026-02-27T10:00:00.000Z"
}
```

### Task Object

| Field | Type | Description |
|---|---|---|
| `id` | string (UUID v4) | Unique identifier |
| `title` | string | Task title (from AI scan or manual input) |
| `summary` | string \| null | 2-4 sentence briefing of the email/message content |
| `source` | `"email"` \| `"teams"` \| `"manual"` | Where the task originated |
| `from` | string \| null | Sender name (null for manual tasks) |
| `date` | string \| null | Original message date (ISO 8601) |
| `link` | string \| null | URL to original email or Teams message |
| `status` | string | One of 6 valid statuses (see §6) |
| `notes` | string | Free-text notes (legacy field, still writable via PATCH) |
| `history` | HistoryEntry[] | Chronological log of all events and agent interactions |
| `doneAt` | string \| null | ISO timestamp when status was set to "done" |
| `enrichmentStatus` | `"pending"` \| `"enriching"` \| `"enriched"` \| `"error"` | Phase 2 enrichment state |
| `updateCheckStatus` | `"pending"` \| `"checking"` \| `"checked"` \| `"updated"` \| `"error"` | Phase 3 update check state |
| `enrichedAt` | string \| null | ISO timestamp of last enrichment |
| `lastUpdateCheck` | string \| null | ISO timestamp of last update check |
| `createdAt` | string | ISO timestamp of task creation |
| `updatedAt` | string | ISO timestamp of last modification |

### HistoryEntry Object

| Field | Type | Present In | Description |
|---|---|---|---|
| `timestamp` | string | all | ISO 8601 timestamp |
| `type` | string | all | Entry type (see variants below) |
| `text` | string | all | Display text or user input |
| `communications` | Communication[] | `update` | Found email/Teams messages (may be empty) |
| `agentPlan` | AgentPlan | `update` | AI analysis result (intent, understanding, search params) |
| `agentResponse` | string | `update` | Final summary shown to user after search execution |
| `agentExecution` | AgentExecution | `update` | Execution trace (prompt, raw response, timing, method) |

**HistoryEntry type variants:**

| Type | Meaning | Deletable |
|---|---|---|
| `created` | Task was created (by scan or manually) | No |
| `status-change` | Status was changed by user | No |
| `scan-update` | Task was updated by a re-scan | No |
| `update` | Agent interaction (analyze + search) | Yes (🗑️) |
| `note` | User-saved note (no agent interaction) | Yes (🗑️) |

### AgentPlan Sub-Object

| Field | Type | Description |
|---|---|---|
| `intent` | `"search"` \| `"summarize"` \| `"answer"` | Detected intent |
| `understanding` | string | Action plan or result text |
| `searchFrom` | string \| null | Person name or email domain to search for |
| `keywords` | string[] | Search terms (used when searchFrom is null) |
| `timeWindow` | `{ from, to, reasoning }` | Date range for search |
| `searchTargets` | string | `"inbox"`, `"sent"`, `"teams"`, `"all"` |
| `needsClarification` | boolean | Whether agent needs more info |
| `clarificationQuestion` | string \| null | Question to ask user |
| `userConfirmed` | boolean | Whether user confirmed the plan before execution |
| `fallback` | boolean | Whether deterministic fallback was used |

### AgentExecution Sub-Object

| Field | Type | Description |
|---|---|---|
| `promptSent` | string \| null | The question sent to Work IQ |
| `rawResponse` | string \| null | Raw response from Work IQ (truncated to 8000/2000 chars) |
| `parsedCount` | number | Number of communications parsed from response |
| `error` | string \| null | Error message if search failed |
| `durationMs` | number | Total search duration in milliseconds |
| `method` | `"workiq-ask"` \| `"copilot-sdk-mcp"` \| `"none"` | Which search method was used |

### Communication Sub-Object

| Field | Type | Description |
|---|---|---|
| `type` | `"email"` \| `"teams"` | Communication type |
| `from` | string | Sender name |
| `to` | string | Recipient(s) |
| `date` | string | Message date (ISO or natural language) |
| `summary` | string | Subject line or 1-2 sentence summary |
| `link` | string \| null | URL to original message |

---

## 5. Concurrency Model

### safeWriteTasks() — Sequential Write Queue

All mutations to `tasks.json` go through `safeWriteTasks()`, which chains promises to ensure sequential writes even when multiple API requests arrive simultaneously.

```
Request A ──┐
            │
Request B ──┤  writePromise chain:
            │
Request C ──┘
            │
            ▼
    ┌───────────────┐     ┌───────────────┐     ┌───────────────┐
    │  Mutation A    │────▶│  Mutation B    │────▶│  Mutation C    │
    │  read → write  │     │  read → write  │     │  read → write  │
    └───────────────┘     └───────────────┘     └───────────────┘
```

```javascript
let writePromise = Promise.resolve();

function safeWriteTasks(mutationFn) {
  writePromise = writePromise.then(() => {
    const data = readTasks();    // read current state
    const result = mutationFn(data);  // mutate in memory
    writeTasks(data);            // write back to disk
    return result;
  });
  return writePromise;
}
```

### busyTaskIds — Frontend Concurrency Guard

A `Set` of task IDs with active agent work. When any task is busy:
- `updateTask()` does inline DOM updates instead of full re-render (prevents disrupting active panels)
- `deleteTask()` removes the card from DOM without re-render (unless it's the busy task)
- Status select, task count, and done styling are updated directly on the DOM element

### Inline DOM Updates During Agent Work

```
busyTaskIds.size > 0?
    │
    ├── YES → Inline update:
    │         - Update status <select> value + className
    │         - Update task count text
    │         - Toggle .done class on card
    │         - Show notification
    │
    └── NO  → Full re-render:
              fetchTasks() → renderTasks()
              Re-open panels from openPanelTaskIds
              Re-apply busy state from busyTaskIds
              Restore pending plan displays
```

---

## 6. Status System

### 6 Statuses with Priority, Colors, and Icons

| Priority | Status | Icon | CSS Color | Hex |
|---|---|---|---|---|
| 0 | `needs-attention` | 🔴 | `status-needs-attention` | `#ef4444` |
| 1 | `new` | 🆕 | `status-new` | `#60a5fa` |
| 2 | `escalated` | 🚨 | `status-escalated` | `#f97316` |
| 3 | `in-progress` | 🟡 | `status-in-progress` | `#fbbf24` |
| 4 | `paused` | ⏸️ | `status-paused` | `#9ca3af` |
| 5 | `done` | ✅ | `status-done` | `#34d399` |

### Sort Algorithm

Tasks are sorted by:
1. **Status priority** (ascending) — `needs-attention` first, `done` last
2. **createdAt** (descending) — newest first within same status

Done tasks older than 3 days (based on `doneAt`) are auto-hidden from the visible list but remain in `tasks.json`.

### Status Migration

On server startup, `migrateStatuses()` converts any `active` status (from older versions) to `new`:

```javascript
if (task.status === 'active') {
  task.status = 'new';
}
```

---

## 7. Frontend Architecture

### 7.1 State Management

**JavaScript variables:**

| Variable | Type | Description |
|---|---|---|
| `tasks` | Array | All tasks from last API response |
| `currentFilter` | string | Active filter (`"all"` or a status value) |
| `serverOnline` | boolean | Server connectivity state |
| `reconnectTimer` | number \| null | Interval ID for reconnect polling |
| `pendingPlans` | Object | `taskId → { plan, originalText, fallback }` — awaiting user confirmation |
| `openPanelTaskIds` | Set | Task IDs with open interaction panels |
| `collapsedEntries` | Set | Collapse IDs for long text entries |
| `busyTaskIds` | Set | Task IDs with active agent work |
| `frozenTasks` | Set | Task IDs frozen during scan pipeline (neon blue, no interaction) |
| `linkMode` | string | Current link open mode |

**localStorage keys:**

| Key | Persists | Description |
|---|---|---|
| `openPanels` | Set as JSON array | Which task panels are open (survives page reload) |
| `collapsedEntries` | Set as JSON array | Which long entries are collapsed |
| `scanDays` | string | Scan range slider value (1–14) |
| `linkMode` | string | Link open mode (`"window"`, `"tab"`, `"split"`, `"incognito"`) |

### 7.2 Markdown Renderer

A lightweight `renderMarkdown()` function that converts agent response text to HTML:

| Markdown | HTML |
|---|---|
| `## Heading` | `<h2>Heading</h2>` |
| `### Heading` | `<h3>Heading</h3>` |
| `**bold**` | `<strong>bold</strong>` |
| `*italic*` | `<em>italic</em>` |
| `` `code` `` | `<code>code</code>` |
| `- list item` | `<ul><li>list item</li></ul>` |
| Double newline | `</p><p>` |
| Single newline | `<br>` |

All text is HTML-escaped via `escHtml()` before Markdown processing (XSS-safe).

### 7.3 Collapsible Entries

- **Threshold:** 120 characters
- Both user messages and agent responses are independently collapsible
- Collapsed state persisted to `localStorage` via `collapsedEntries` Set
- Toggle arrow rotates (▼ expanded, ► collapsed via CSS `transform: rotate(-90deg)`)
- Preview text: first non-empty line, stripped of Markdown formatting, truncated to 80 chars

### 7.4 Server Health Check

```
Page load
    │
    ▼
checkServerHealth()
    │
    ├── fetch /api/tasks (3s AbortController timeout)
    │
    ├── OK  → setServerStatus(true)
    │         - Hide offline banner
    │         - Green dot (12px, #34d399)
    │         - Tooltip: Express, Copilot SDK, Work IQ, tasks.json
    │         - Enable scan + add task buttons
    │         - Clear reconnect timer
    │         - Show "✅ Server verbunden" notification (if was offline)
    │
    └── FAIL → setServerStatus(false)
              - Show amber offline banner with start instructions
              - Red dot (12px, #ef4444)
              - Tooltip: start instructions
              - Disable scan + add task buttons
              - Start reconnect polling (every 5s)
```

### 7.5 Link Open Modes

4 modes for opening task source links, selected via header buttons:

| Mode | Icon | Behavior |
|---|---|---|
| `window` | 🪟 | Opens in a new browser window (default) |
| `tab` | 📑 | Opens in a new tab (`window.open(url, '_blank')`) |
| `split` | ◧ | Resizes Agent Zero to left half, opens link in right half |
| `incognito` | 🕶️ | Attempts private window (falls back to regular window with notification) |

---

## 8. Deduplication Strategy

```
AI scans M365 for action items
        │
        ▼
┌──────────────────────────────────────────────────────────┐
│ Layer 1: AI Context (preventive)                          │
│                                                           │
│  Active tasks (max 50) + done tasks (max 30)              │
│  injected into scan prompt as JSON context.               │
│  AI is instructed: "do NOT re-create done tasks."          │
│  → Prevents most duplicates at the source.                 │
└───────────────────────┬──────────────────────────────────┘
                        │
                        ▼ AI returns items with action field
┌──────────────────────────────────────────────────────────┐
│ Layer 2: AI action:"skip" (explicit)                      │
│                                                           │
│  AI sets action:"skip" for items it matched to done tasks. │
│  These are counted as skipped, not processed further.      │
└───────────────────────┬──────────────────────────────────┘
                        │
                        ▼ Remaining "new" items
┌──────────────────────────────────────────────────────────┐
│ Layer 3: Jaccard Similarity Safety Net (deterministic)    │
│                                                           │
│  For each new item, compare against ALL existing tasks:    │
│                                                           │
│  1. Normalize: lowercase, strip non-alphanumeric,          │
│     collapse whitespace                                    │
│  2. Split into word sets                                    │
│  3. Jaccard = |intersection| / |union|                     │
│  4. If Jaccard > 0.7 → skip (log warning)                  │
│                                                           │
│  Also: backward-compat dedup for items without action      │
│  field (match by link, then title+from+source).            │
└───────────────────────┬──────────────────────────────────┘
                        │
                        ▼
              Create task or skip
```

---

## 9. Search Architecture

### 9.1 Two Search Methods

```
Search request arrives
        │
        ├── Has plan?
        │     │
        │     ├── YES → workiq ask (CLI)        ← PRIMARY
        │     │         Direct spawn, question via stdin
        │     │         90s timeout
        │     │         method = "workiq-ask"
        │     │
        │     └── NO  → Copilot SDK + MCP       ← FALLBACK
        │               CopilotClient + workiq MCP server
        │               LOG_WORK_SKILL.md or inline prompt
        │               120s timeout
        │               method = "copilot-sdk-mcp"
        │
        ▼
Parse response → Build agentResponse → Save to history
```

### 9.2 buildSearchQuestion() Logic

Constructs a natural language question for `workiq ask`:

```
plan.searchFrom exists?
    │
    ├── YES (person/domain) → "Find all emails from {searchFrom} in my {targets} {timeWindow}."
    │
    └── NO
         │
         ├── keywords exist? → "Find all emails in my {targets} {timeWindow} about {keywords}."
         │
         └── no keywords   → "Find all emails in my {targets} {timeWindow} related to '{task.title}'."

Always appended: "For each email show: subject line, date, and the full email body content.
                   Order by date descending."
```

**Time window calculation:**
- If `plan.timeWindow.from` is set: calculate days from that date to now, minimum 2 days
- If not set: default to "last 7 days"
- Format: `"from the last N days (January 1, 2026-February 26, 2026)"`

### 9.3 Response Parsing

```
Work IQ response
        │
        ├── Try JSON.parse(text) directly
        │     └── Success? → use parsed array
        │
        ├── Try extract from ```json ... ``` code block
        │     └── Success? → use parsed array
        │
        ├── Try match /\[[\s\S]*\]/ (JSON array in text)
        │     └── Success? → use parsed array
        │
        └── Try parseMarkdownEmails(text)
              │
              ├── Split by --- separators
              ├── Look for **From:** anchors
              ├── Extract: From, Subject, Date, To, link
              ├── Fallback: numbered header (### 1) Subject)
              │
              └── Success? → use parsed array
                    └── No structured data → store rawResponse as agentResponse
```

### 9.4 agentResponse Generation

After search execution, a summary is built for the user:

| Condition | agentResponse |
|---|---|
| Search error | `❌ Die Suche ist fehlgeschlagen: {error}` |
| Communications found | `✅ N Kommunikation(en) gefunden:` + numbered list with icons |
| Raw text but no structure | The raw Work IQ response text (natural language answer) |
| Nothing found | `🔍 Keine Ergebnisse gefunden...` with suggestion to retry |

---

## 10. API Reference

| Method | Endpoint | Request Body | Response | Description |
|---|---|---|---|---|
| `GET` | `/` | — | HTML | Serves index.html |
| `GET` | `/api/tasks` | — | `{ version, tasks, lastScan }` | Get all tasks |
| `POST` | `/api/tasks` | `{ title, notes? }` | Task object (201) | Create manual task |
| `PATCH` | `/api/tasks/:id` | `{ status?, notes?, title? }` | Task object | Update task fields |
| `DELETE` | `/api/tasks/:id` | — | `{ success: true }` | Delete a task |
| `DELETE` | `/api/tasks/:id/history/:index` | — | Task object | Delete a history entry (only `update` and `note` types) |
| `POST` | `/api/tasks/:id/note` | `{ text }` | Task object | Save a note to task history |
| `POST` | `/api/scan` | `{ scanDays? }` | `{ success, added, skipped, updated, total, newTaskIds[], lastScan }` | Phase 1: Discovery scan (subjects only) |
| `POST` | `/api/tasks/:id/enrich` | — | `{ success, summary, language, confidence, enrichmentStatus }` | Phase 2: Content extraction + summary |
| `POST` | `/api/tasks/:id/check-update` | — | `{ success, hasUpdate, updateCheckStatus }` | Phase 3: Thread update check |
| `POST` | `/api/tasks/:id/log/analyze` | `{ text }` | `{ intent, plan?, result?, task? }` | AI intent analysis |
| `POST` | `/api/tasks/:id/log` | `{ text, plan? }` | Task object | Phase 2: Execute search + save |

**Status validation:** PATCH rejects any status not in `['new', 'needs-attention', 'escalated', 'in-progress', 'done', 'paused']`.

**History deletion protection:** DELETE `/api/tasks/:id/history/:index` returns 403 for entry types other than `update` and `note`.

---

## 11. File Structure

```
Agent_Zero/
├── server.js                  # Express backend (~1090 lines)
├── index.html                 # Frontend SPA (~1620 lines)
├── package.json               # Dependencies and metadata
├── package-lock.json          # Locked dependency versions
├── tasks.json                 # Local data store (gitignored)
├── .gitignore                 # node_modules/, package-lock.json, tasks.json
├── README.md                  # Quick start guide
├── START-DAILY-BRIEFING.bat   # Windows launcher (port check, auto-start)
├── Documents/
│   ├── ARCHITECTURE.md            # This file
│   ├── SCAN_SKILL.md              # Legacy scan skill (backup/fallback)
│   ├── SCAN_DISCOVERY_SKILL.md    # Phase 1: Subject-only discovery scan
│   ├── ENRICH_SKILL.md            # Phase 2: Content extraction + summary
│   ├── LOG_WORK_SKILL.md          # Prompt template for work logging
│   └── MULTI_PHASE_SCAN_SPEC.md   # Multi-phase scan architecture spec
├── Images/
│   └── ChatGPT Image *.png    # App screenshot/logo
└── Specifactions/
    └── DAILY_BRIEFING_APP_SPEC.md  # Product specification
```

---

## 12. Dependencies

From `package.json`:

| Package | Version | Purpose |
|---|---|---|
| `express` | ^5.2.1 | HTTP server and REST API routing |
| `@github/copilot-sdk` | ^0.1.25 | AI reasoning engine (scan prompts, intent analysis) |
| `@microsoft/workiq` | ^0.2.8 | M365 data access via MCP server and CLI |
| `uuid` | ^13.0.0 | UUID v4 generation for task IDs |

**Runtime requirements:**
- Node.js v18+ (ES Modules, top-level await support)
- `workiq` CLI globally installed (`npm i -g @microsoft/workiq`)
- GitHub Copilot authentication (for Copilot SDK)
- Microsoft 365 account with Work IQ EULA accepted

---

## 13. Known Limitations

1. **Work IQ Sent Items search returns hit count but no details.** The search confirms N emails exist in Sent Items but does not return subject, recipients, or dates. Root cause: Work IQ uses the Microsoft Search API (limited metadata) rather than Graph Messages API (`/me/messages`). A [GitHub issue](https://github.com/microsoft/work-iq-mcp) has been filed.

2. **Work IQ Inbox search may miss certain emails.** Some emails that are verifiably present in the mailbox are not found by Work IQ search. Suspected causes: Graph API indexing delay and/or Focused Inbox filtering.

3. **searchFrom field often empty in AI responses.** When a task originates from a company (e.g., "zones.com"), the AI frequently puts the company name in `keywords` instead of `searchFrom`, resulting in less precise search queries. The analyze prompt includes explicit rules for this but the AI does not always follow them.

4. **Incognito mode cannot be forced programmatically.** Browsers do not expose an API to open links in private/incognito windows. The incognito link mode falls back to a regular new window and shows an informational notification.
