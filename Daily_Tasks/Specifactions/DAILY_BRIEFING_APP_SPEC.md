# Daily Briefing App — Product Specification

**Version:** 1.4
**Date:** February 25, 2026
**Author:** Martin Hämmerli
**Status:** v1.3 implemented (AI-Powered Deduplication + Skill Files), v1.4 in progress (Two-Phase Log Agent)

---

## 1. Purpose

Build a local, single-page HTML application that helps the user stay on top of action items from Microsoft 365 emails and Teams messages. The app scans the last 4 days of communication, extracts tasks, and presents them in a clean, interactive list. The user can manage task status, add manual tasks, and click through to the original email or Teams message.

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────┐
│                  Browser (HTML/JS)                   │
│                                                     │
│  ┌──────────┐  ┌──────────────┐  ┌───────────────┐ │
│  │ Trigger   │  │ Task List    │  │ Manual Task   │ │
│  │ Button    │  │ (table/cards)│  │ Input Form    │ │
│  └─────┬────┘  └──────┬───────┘  └───────┬───────┘ │
│        │              │                  │          │
└────────┼──────────────┼──────────────────┼──────────┘
         │              │                  │
         ▼              ▼                  ▼
┌─────────────────────────────────────────────────────┐
│              Local Node.js Backend Server            │
│                                                     │
│  ┌──────────────┐  ┌────────────┐  ┌─────────────┐ │
│  │ GitHub       │  │ Work IQ    │  │ tasks.json   │ │
│  │ Copilot SDK  │  │ (MCP Tool) │  │ (persistent) │ │
│  └──────────────┘  └────────────┘  └─────────────┘ │
│                                                     │
│  The SDK provides the AI reasoning engine.          │
│  Work IQ provides access to M365 data.              │
│  tasks.json stores the action item list.            │
└─────────────────────────────────────────────────────┘
```

---

## 3. Technology Stack

| Component | Technology | Why |
|---|---|---|
| **Frontend** | Single HTML file (HTML + CSS + JS) | Simple, no build step, consistent with existing projects |
| **Backend** | Node.js server (Express, ES Modules) | Required to run Copilot SDK and Work IQ MCP. Uses `"type": "module"` in package.json for ESM compatibility with the Copilot SDK |
| **AI Engine** | GitHub Copilot SDK (`@github/copilot-sdk`) | Reuses the same Copilot reasoning engine — no need to rebuild AI logic |
| **M365 Access** | Work IQ MCP (`@microsoft/workiq`) | Already installed (v0.2.8), EULA accepted, token active |
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

---

## 4. Features

### 4.1 Scan Trigger (Manual)

- A prominent button on the page labeled **"Scan Emails & Teams"**
- When clicked, the backend:
  1. Reads existing active tasks from `tasks.json` (for context-aware matching — see 4.7)
  2. Calls Work IQ via Copilot SDK to scan the last 4 days of emails and Teams chats
  3. AI identifies action items AND matches them against existing tasks (semantic dedup)
  4. **New items** → added to the list
  5. **Matched items with changes** → existing task updated + history entry
  6. **Matched items without changes** → skipped
  7. Returns the updated list to the frontend
- While scanning, the UI shows a loading indicator with status text (e.g., "Scanning emails..." → "Scanning Teams..." → "Analyzing action items...")
- The scan button is disabled during scanning (text changes to "Scanning...") to prevent concurrent scans
- After a scan completes, a notification toast shows the result (e.g., "Scan complete: 3 new tasks added, 2 duplicates skipped")
- Future enhancement: replace manual trigger with automated daily scheduler

### 4.2 Task List Display

Each task is displayed as a card or table row with:

| Field | Description |
|---|---|
| **Title** | Short description of the action item |
| **Source** | "Email" or "Teams" badge |
| **From** | Sender / person who assigned the task |
| **Date** | When the original message was sent |
| **Link** | Clickable link that opens the original email in Outlook or the Teams message in Teams |
| **Status** | Current status (see 4.3) |
| **Status Controls** | Buttons/dropdown to change status |

The list should be sorted by: Status (active first) → Date (newest first).

The sort groups tasks by status priority (Active → In Progress → Paused → Done), then within each group by `createdAt` timestamp in descending order (newest first).

### 4.3 Task Status Management

Each task has one of four statuses:

| Status | Icon | Meaning |
|---|---|---|
| **Active** | 🔵 | Needs to be worked on |
| **In Progress** | 🟡 | Currently being worked on |
| **Done** | ✅ | Completed |
| **Paused** | ⏸️ | Temporarily on hold |

**Status transitions — all directions are allowed:**
- Any status can be changed to any other status at any time
- This is intentional: the user may need to reopen a "Done" task or pause an "Active" one
- Status changes are saved immediately to `tasks.json`
- The PATCH endpoint validates status values server-side — only `active`, `in-progress`, `done`, and `paused` are accepted (returns 400 for invalid values)

### 4.4 Manual Task Creation

- A form or input area to manually add tasks
- Required fields: **Title** (free text)
- Optional fields: **Notes** (free text)
- Manual tasks are marked with a "Manual" badge instead of "Email" or "Teams"
- Manual tasks have no source link

### 4.5 Deep Links to Source Messages

- **Emails:** Use the Outlook protocol handler (`outlook://` or `https://outlook.office.com/mail/deeplink/...`) to open the original email
- **Teams messages:** Use the Teams deep link format (`https://teams.microsoft.com/l/message/...`) to open the original message
- Links open in a **new tab/window**
- Work IQ must provide the message ID or URL when extracting action items — this is critical for deep linking

### 4.6 Data Persistence (tasks.json)

```json
{
  "version": 2,
  "lastScan": "2026-02-24T07:00:00.000Z",
  "tasks": [
    {
      "id": "uuid-v4",
      "title": "Review Q1 budget proposal",
      "source": "email",
      "from": "Sarah Johnson",
      "date": "2026-02-22T14:30:00.000Z",
      "link": "https://outlook.office.com/mail/deeplink/...",
      "status": "active",
      "notes": "",
      "history": [
        {
          "timestamp": "2026-02-23T07:01:00.000Z",
          "type": "created",
          "text": "Task created from email scan"
        },
        {
          "timestamp": "2026-02-24T09:15:00.000Z",
          "type": "update",
          "text": "Emailed Sarah with revised numbers",
          "communications": [
            {
              "type": "email",
              "from": "Martin Hämmerli",
              "to": "Sarah Johnson",
              "date": "2026-02-24T09:10:00.000Z",
              "summary": "Sent revised Q1 budget numbers with updated travel costs",
              "link": "https://outlook.office.com/mail/deeplink/..."
            }
          ]
        }
      ],
      "doneAt": null,
      "createdAt": "2026-02-23T07:01:00.000Z",
      "updatedAt": "2026-02-24T09:15:00.000Z"
    }
  ]
}
```

**Schema changes from v1:**
- `version`: Bumped from 1 to 2
- `history`: New array field on each task (see 4.12)
- `doneAt`: ISO timestamp when task was set to "done" (null otherwise, used for auto-cleanup — see 4.13)
- **Migration:** On first load, if `version === 1`, the server auto-migrates: adds empty `history: []` and `doneAt: null` to each task, sets `version: 2`

### 4.7 Duplicate Detection & Smart Task Updates on Re-Scan (v1.3)

When scanning, the system uses **AI-powered context-aware matching** to prevent duplicates and intelligently update existing tasks.

#### Core Principle: Context-Aware Scan

The AI receives the list of existing active tasks as context in the scan prompt, combined with instructions from `Documents/SCAN_SKILL.md`. This allows the AI to semantically match new findings against known tasks — not just by exact string comparison, but by understanding that e.g. "SAP Invoice 5735236948 pending approval" and "Please approve invoice #5735236948" refer to the same action item.

#### Skill File

The scan prompt is built from two parts:
1. **`Documents/SCAN_SKILL.md`** — static instructions defining matching rules, response format, and quality guidelines. Loaded once at server start.
2. **Dynamic context** — existing active tasks (JSON) + scan instruction with time range.

This separation allows the Architect to refine AI behavior by editing the skill file, without requiring code changes.

#### Scan Prompt Structure

```
<contents of SCAN_SKILL.md>

EXISTING TASKS:
[
  {"id":"abc-123","title":"Approve SAP Invoice 5735236948","source":"email","from":"John"},
  {"id":"def-456","title":"Review Q1 budget proposal","source":"teams","from":"Sarah"}
]

Scan my emails and Teams messages from the last 4 days.
For each action item found, decide: action "update" (with existingId) or "new".
```

#### Context Limits

- Only `active` and `in-progress` tasks are included (not done/paused)
- Maximum 50 tasks in the context (newest first by `createdAt`)
- Only `id`, `title`, `source`, `from` per task (minimal token usage)

#### AI Response Format

```json
[
  { "action": "new", "title": "...", "source": "email", "from": "...", "date": "...", "link": "..." },
  { "action": "update", "existingId": "abc-123", "changes": { "date": "2026-03-01" }, "reason": "Follow-up email with updated deadline" }
]
```

#### Server-Side Processing

For each item in the AI response:

| `action` | Server behavior |
|---|---|
| `"new"` | Safety-Net check (see below), then create task if no match |
| `"update"` | Find task by `existingId`, merge changed fields, add history entry with `reason` |
| *(no action field)* | **Backward-compatibility fallback:** Use old logic (link-match, then title+from+source exact match) |

#### Updatable Fields

| Field | Updatebar | Notes |
|---|---|---|
| `title` | ✅ | AI provides improved/current title |
| `date` | ✅ | New deadline from follow-up message |
| `link` | ✅ | More recent link (e.g., latest reply in thread) |
| `from` | ❌ | Original sender preserved; new sender logged in history reason |
| `source` | ❌ | Original source type preserved |
| `status` | ❌ | Only manually changeable by user |

#### History Entry for Updates

When an existing task is updated via scan:
```json
{
  "timestamp": "2026-02-25T08:00:00.000Z",
  "type": "scan-update",
  "text": "Updated by scan: Follow-up email with updated deadline (date: 2026-02-20 → 2026-03-01)"
}
```

#### Safety-Net Dedup (Server-Side Fallback)

After AI matching, the server applies an additional **word-level similarity check** as a last defense against duplicates:

1. Normalize both titles: lowercase, remove punctuation, collapse whitespace
2. Calculate **Jaccard similarity** on word sets: `|intersection| / |union|`
3. If similarity > **0.7** (70% word overlap): treat as duplicate, skip with warning log
4. This catches edge cases where the AI misses a match

#### Response to Frontend

```json
{ "success": true, "added": 2, "updated": 1, "skipped": 3, "total": 15, "lastScan": "..." }
```

### 4.8 Notification Toast System

- Non-blocking slide-in notifications appear in the top-right corner
- Two variants: **success** (green) and **error** (red), styled consistently with the dark theme
- Auto-dismiss after 5 seconds, or manually dismissable via ✕ button
- Used for scan results, error messages, and status feedback
- Only one notification visible at a time (new notification replaces previous)

### 4.9 Error Handling (User-Facing)

The frontend translates technical errors into human-readable messages via `friendlyError()`:

| Error Condition | User Message |
|---|---|
| Authentication/token expired | "Authentication expired — please run `workiq accept-eula` in your terminal and try again." |
| Work IQ not installed/not found | "Could not start Work IQ. Make sure it is installed globally (`npm i -g @microsoft/workiq`)." |
| Scan timeout (120s) | "Scan timed out — your mailbox may be very large. Please try again." |
| No AI response | "No response from AI engine. Check your GitHub Copilot authentication." |
| Malformed AI response | "The AI returned an unexpected response. Please try scanning again." |
| Network/server unreachable | "Cannot reach the server. Is it still running?" |

### 4.10 Filter Badge Counts

Each status filter button dynamically displays the number of tasks in that status:
- Example: "🔵 Active (3)", "✅ Done (5)"
- Counts update automatically after every task mutation (add, update, delete, scan)
- If a status has zero tasks, the count is hidden (e.g., just "⏸️ Paused")

### 4.11 Server Status Detection

The frontend detects whether the backend server is running and provides clear feedback:

- **Health Check on Load:** `checkServerHealth()` performs a `fetch('/api/tasks')` with a 3-second `AbortController` timeout
- **Offline Banner:** A prominent amber banner appears in the main area when the server is unreachable, with instructions to start the server (BAT file or manual command)
- **Auto-Reconnect:** When offline, a polling timer (every 5 seconds) retries the health check automatically. On reconnection, the banner disappears, tasks are loaded, and a "✅ Server verbunden" notification is shown
- **Status Dot:** A small colored dot in the header indicates server status (🟢 green = online, 🔴 red = offline)
- **Button Protection:** The "Scan Emails & Teams" and "Add Task" submit buttons are disabled with tooltip "Server nicht erreichbar" when the server is offline

### 4.12 Task History (v1.2)

Every task has a `history` array that tracks all changes and activities over time. The history is the "logbook" of a task.

**History entry schema:**
```json
{
  "timestamp": "ISO 8601",
  "type": "created | status-change | update | scan-update | note | communication",
  "text": "Human-readable summary of what happened",
  "communications": []
}
```

**Entry types:**
| Type | When created | Example text |
|---|---|---|
| `created` | Task is first created (scan or manual) | "Task created from email scan" |
| `status-change` | User changes task status | "Status changed: active → in-progress" |
| `update` | User adds a work log (see 4.14) | "Emailed Sarah with revised numbers" |
| `scan-update` | Re-scan detects changes to existing task | "Updated by scan: title changed" |
| `note` | User adds a note manually | "Need to follow up by Friday" |
| `communication` | AI found linked communication (see 4.14) | "Found email to Sarah Johnson" |

**UI Display:**
- Each task card has a **collapsible history section** (collapsed by default)
- Toggle via a small "📜 History (3)" link/button on the task card (number = entry count)
- When expanded, entries are shown in reverse chronological order (newest first)
- Each entry shows: timestamp (formatted), type icon, text
- Communication entries additionally show: linked email/Teams badge + "Open ↗" link + AI-generated summary

### 4.13 Auto-Cleanup of Done Tasks (v1.2)

Tasks with status "done" remain visible for **3 days** after being marked done, then automatically disappear from the UI:

- When a task is set to "done", record `doneAt: <ISO timestamp>` on the task
- When a task is moved **away** from "done" (e.g., back to "active"), reset `doneAt: null`
- **Cleanup logic (frontend):** When rendering, filter out tasks where `status === 'done'` AND `doneAt` is older than 3 days. These tasks are NOT deleted from `tasks.json` — they are just hidden in the UI.
- **Filter behavior:** The "✅ Done" filter only shows done tasks that are still within the 3-day window
- **Optional server-side purge:** A future enhancement could periodically remove old done tasks from `tasks.json`. For v1.2, keep them in the file (they just don't render).

### 4.14 AI-Powered Work Logging with Communication Search (v1.2, prompt improved v1.3, two-phase agent v1.4)

When the user wants to log work on a task, the AI assists by finding and linking related communications.

**Problem (v1.3):** The agent immediately executes a Work IQ search (~30–90 seconds) without explaining what it understood or what it will search for. If the prompt is imprecise or the search times out, the user gets no result and no explanation. The agent must be transparent.

**Solution (v1.4): Two-Phase Flow — Analyze, then Execute**

```
Phase 1: ANALYZE (~5-15s, no Work IQ)       Phase 2: EXECUTE (after confirm, ~30-90s)
┌────────────────────────────────────┐      ┌──────────────────────────────────────┐
│ User types log text                │      │ User confirms/adjusts the plan       │
│ → POST /api/tasks/:id/log/analyze  │      │ → POST /api/tasks/:id/log            │
│ → Copilot SDK (NO Work IQ)        │      │ → Copilot SDK + Work IQ              │
│ → AI analyzes intent, not data     │      │ → Targeted search with plan params   │
│ → Returns structured search plan   │      │ → Saves history entry with results   │
│ → Frontend shows plan to user      │      │                                      │
└────────────────────────────────────┘      └──────────────────────────────────────┘
```

**Phase 1 — Analyze (fast, no M365 data access):**
1. User clicks "✏️ Log" and types what they did
2. Frontend sends `POST /api/tasks/:id/log/analyze { text }`
3. Server creates a Copilot SDK session WITHOUT Work IQ MCP (just AI reasoning)
4. AI receives task context + user's log text + analysis instructions
5. AI returns a structured plan:
   ```json
   {
     "understanding": "You asked several people for updates on the SAP Invoice. You want me to check your inbox for replies.",
     "keywords": ["SAP Invoice 5735236710", "PO 0101439547"],
     "timeWindow": {
       "from": "2026-02-20",
       "to": "now",
       "reasoning": "You acted AFTER the task was created, so I search forward from the task date."
     },
     "searchTargets": "inbox",
     "needsClarification": false,
     "clarificationQuestion": null
   }
   ```
6. If `needsClarification` is true: Frontend shows the question + input field for the user's answer. User answers → re-submit to `/analyze` with extended context (original text + answer appended).
7. Frontend displays the plan visually: understanding, keywords, time window, search target.
8. User has three options: **✅ Confirm** | **❌ Cancel**

**Phase 2 — Execute (after user confirmation):**
1. User clicks "✅ Search" to confirm the plan
2. Frontend sends `POST /api/tasks/:id/log { text, plan }` — the enhanced log endpoint
3. Server builds a **targeted** Work IQ prompt using the confirmed plan:
   - Skill file (LOG_WORK_SKILL.md) as base instructions
   - Plan keywords as explicit search terms
   - Plan time window as explicit date range
   - Plan search targets as scope directive
4. Work IQ searches M365 data with the precise parameters
5. Server saves history entry with communications array
6. Frontend shows results

**Clarification Rules (embedded in analysis prompt):**
- If user's log text is too vague to determine search intent → ask what they want to find
- If task date is >30 days old → ask for a narrower time window
- If user says they "reacted" to something → search AFTER task date (forward)
- If user asks for "additional info/context" → search BEFORE task date (backward)
- If direction is ambiguous → ask: "Should I search for communications before or after the task date?"
- Always ask ONE specific question per clarification round

**Frontend UI for the plan display:**
```
┌─ Agent's Analysis ──────────────────────────────────────┐
│ 💡 I'll search your inbox for email threads about       │
│    "SAP Invoice 5735236710" from Feb 20 onwards.        │
│                                                         │
│ Keywords: SAP Invoice, 5735236710, PO 0101439547        │
│ Time: Feb 20 → today                                    │
│ Target: Inbox emails                                    │
│                                                         │
│              [✅ Search]    [❌ Cancel]                   │
└─────────────────────────────────────────────────────────┘
```

If the agent needs clarification:
```
┌─ Agent asks ────────────────────────────────────────────┐
│ ❓ The task is from January 15, which is 40 days ago.    │
│    In which timeframe should I search for replies?       │
│                                                         │
│    [________________________] [Send]                     │
└─────────────────────────────────────────────────────────┘
```

**Fallback:** If the Copilot SDK analysis fails (e.g., timeout, no response), the server falls back to **deterministic analysis**: extract keywords from task title, set time window from task date to now, and present a basic plan to the user. The plan card shows `(auto-generated)` to indicate no AI analysis was performed.

**API Endpoints (v1.4):**
| Method | Endpoint | Description |
|---|---|---|
| `POST` | `/api/tasks/:id/log/analyze` | Phase 1: AI analyzes the log request, returns search plan |
| `POST` | `/api/tasks/:id/log` | Phase 2: Execute search with confirmed plan, save history (enhanced, accepts optional `plan` field) |

**Request/Response — Analyze:**
- Request: `{ "text": "Ich habe verschiedene Personen nach Updates angefragt" }`
- Response: `{ "plan": { "understanding": "...", "keywords": [...], "timeWindow": {...}, "searchTargets": "...", "needsClarification": false, "clarificationQuestion": null } }`
- Clarification re-submit: `{ "text": "Original text. Additional context: last 2 weeks" }`

**Request/Response — Execute (enhanced):**
- Request: `{ "text": "...", "plan": { "keywords": [...], "timeWindow": {...}, "searchTargets": "..." } }`
- Response: Updated task object with new history entry containing communications
- If `plan` is omitted: falls back to v1.3 behavior (direct search without analysis step)

### 4.15 Parallel Task Operations (v1.2)

The user must be able to work on multiple tasks simultaneously without blocking:

- **Logging work on task A** while **browsing/editing task B** must work without conflict
- Each `/api/tasks/:id/log` call is scoped to one task ID — no global lock
- The frontend must NOT use a full-screen overlay for log operations (only for the initial scan)
- **Per-task loading state:** Each task card manages its own spinner/loading indicator
- **Optimistic UI:** After a log is submitted, the text input clears immediately. The history entry appears when the API responds.
- **Concurrency safety (server-side):** `readTasks()` and `writeTasks()` must be safe against concurrent writes. For v1.2, a simple file-level mutex (queue writes sequentially) is sufficient. No need for a database.

---

## 5. UI Design Requirements

- **Dark theme** — consistent with AI Café Presenter aesthetic
- **Responsive** — works well on a standard 1920x1080 monitor
- **Clean, minimal** — no unnecessary decoration
- **Color scheme:** Dark background (#0b0d17), accent colors for statuses
- **Font:** System font stack (-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif)
- **Layout:**
  - Top: App title + "Scan Emails & Teams" button + last scan timestamp
  - Middle: Task list (main area, scrollable)
  - Bottom or side panel: Manual task input form
- **Single HTML file for the frontend** — all CSS and JS inline (same pattern as AI Café Presenter)

---

## 6. Backend API Endpoints

The Node.js server exposes these REST endpoints for the frontend:

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/tasks` | Return all tasks from tasks.json |
| `POST` | `/api/scan` | Trigger a new scan (calls Copilot SDK + Work IQ) |
| `POST` | `/api/tasks` | Add a manual task |
| `PATCH` | `/api/tasks/:id` | Update task status or notes |
| `DELETE` | `/api/tasks/:id` | Delete a task |
| `POST` | `/api/tasks/:id/log/analyze` | Phase 1: AI analyzes log request, returns search plan (v1.4) |
| `POST` | `/api/tasks/:id/log` | Phase 2: Execute search with confirmed plan + save history (v1.2, enhanced v1.4) |

---

## 7. Implementation Steps

### Phase 1: Foundation ✅
1. ✅ Initialize a Node.js project in `E:\Work_IQ\Daily_Tasks\`
2. ✅ Install dependencies: `@github/copilot-sdk`, `@microsoft/workiq`, `express`, `uuid`
3. ✅ Create `server.js` with Express server and basic REST API
4. ✅ Create `tasks.json` with empty initial structure
5. ✅ Create `index.html` with dark-themed UI, task list display, and manual task form
6. ✅ Verify: Server starts, HTML loads, manual tasks can be added/edited/deleted

### Phase 2: Work IQ Integration ✅
7. ✅ Configure Work IQ as an MCP tool in the Copilot SDK (stdio transport via `workiq mcp`)
8. ✅ Implement the `/api/scan` endpoint:
   - Send prompt to Copilot SDK: "Scan my emails and Teams messages from the last 4 days. For each message that contains an action item assigned to me or expected from me, return: title, source type (email/teams), sender name, date, and message link."
   - Parse the AI response into task objects (with robust JSON extraction from markdown code blocks)
9. ✅ Implement duplicate detection against existing tasks (primary: by link, fallback: by title + from + source)
10. ✅ Verify: Scan button triggers real M365 data retrieval and creates tasks

### Phase 3: Polish ✅
11. ✅ Add loading states and error handling (friendlyError() with human-readable messages)
12. ✅ Add status filter buttons (show all / active only / done) with dynamic count badges
13. ✅ Add task count badges per status
14. ✅ Test edge cases: empty inbox, no Teams messages, token expired
15. ✅ Document how to start the app (README.md with install, usage, troubleshooting)

### Phase 4: Task History & Smart Updates (v1.2) ✅
16. ✅ Migrate tasks.json schema from v1 to v2 (add `history`, `doneAt` fields, auto-migrate on load)
17. ✅ Add `POST /api/tasks/:id/log` endpoint with AI communication search via Copilot SDK + Work IQ
18. ✅ Add collapsible task history UI to each task card (collapsed by default, expand on click)
19. ✅ Implement auto-cleanup: hide done tasks older than 3 days from UI
20. ✅ Update scan logic: detect changes in existing tasks and create scan-update history entries
21. ✅ Add per-task loading spinners for log operations (no full-screen overlay)
22. ✅ Implement file-level write mutex for concurrent task updates
23. ✅ Add history entries for all task mutations (status changes, notes, log work)
24. ✅ Update README, Spec, and Architecture docs to v1.2

### Phase 5: AI-Powered Deduplication (v1.3) ✅
25. ✅ Refactor scan prompt to include existing active tasks as context (max 50, id+title+source+from)
26. ✅ Update AI response format to support `action: "update"` (with existingId, changes, reason) and `action: "new"`
27. ✅ Implement server-side processing for update/new actions with smart field merging
28. ✅ Add Safety-Net dedup: normalized title similarity check (Jaccard >0.7 on word sets)
29. ✅ Maintain backward-compatibility: items without `action` field use old dedup logic as fallback
30. ✅ Improve history entries for scan-updates: include AI-provided reason + changed field details
31. ✅ Create SCAN_SKILL.md and LOG_WORK_SKILL.md (skill file externalization)
32. ✅ Load skill files at server start, inject into prompts, graceful fallback
33. ✅ Update Spec, Architecture, and README to v1.3

### Phase 6: Two-Phase Log Agent (v1.4)
34. Add `POST /api/tasks/:id/log/analyze` endpoint (Copilot SDK without Work IQ, ~5-15s)
35. Add `extractKeywords()` helper for deterministic fallback analysis
36. Enhance `POST /api/tasks/:id/log` to accept optional `plan` parameter
37. Build targeted execution prompt from confirmed plan (keywords + time window + targets)
38. Add plan display UI on task card (understanding, keywords, time window, confirm/cancel buttons)
39. Add clarification loop UI (question display + answer input + re-analyze)
40. Add visual states: "Analyzing..." spinner (Phase 1), "Searching..." spinner (Phase 2)
41. Handle fallback: if SDK analysis fails, use deterministic keyword extraction
42. Update Spec, Architecture, README, and LOG_WORK_SKILL.md to v1.4

---

## 8. How to Start the App (Target)

**Primary (one-click):**

Double-click `START-DAILY-BRIEFING.bat` — this starts the server (if not already running), waits for it to be ready, and opens the browser automatically.

**Alternative (manual):**

```powershell
cd E:\Work_IQ\Daily_Tasks
node server.js
```

Then open `http://localhost:3000` in the browser.

---

## 9. File Structure (Target)

```
E:\Work_IQ\Daily_Tasks\
├── Documents\
│   ├── ARCHITECTURE.md                ← Technical architecture reference
│   ├── SCAN_SKILL.md                  ← AI instructions for scan & dedup (v1.3)
│   └── LOG_WORK_SKILL.md             ← AI instructions for log work search (v1.3)
├── Specifactions\
│   └── DAILY_BRIEFING_APP_SPEC.md     ← this file
├── server.js                           ← Node.js backend (ES Modules)
├── index.html                          ← Frontend (single file)
├── tasks.json                          ← Persistent task data
├── package.json                        ← Node.js dependencies ("type": "module")
├── START-DAILY-BRIEFING.bat            ← One-click launcher (starts server + opens browser)
└── README.md                           ← How to install and run
```

---

## 10. Key Risks and Mitigations

| Risk | Mitigation |
|---|---|
| Work IQ token expires | App shows clear error message + instructions to re-authenticate (`workiq accept-eula` or re-login) |
| Admin consent not granted for Work IQ | Test Work IQ access before building the full app: `workiq ask -q "Show my latest emails"` |
| Copilot SDK is in technical preview | Keep the architecture modular — if SDK changes, only `server.js` needs updating |
| Deep links may vary by Outlook version | Support both `outlook://` protocol and `outlook.office.com` web links |
| Large volume of emails (100+) | Limit scan to last 4 days, max 50 action items per scan |

---

## 11. Future Enhancements (Out of Scope for v1.3)

- Automated daily scheduler (Windows Task Scheduler or cron)
- Email/Teams notification when new action items are found
- Priority levels (high/medium/low)
- Due dates and deadline warnings
- Weekly summary report
- Multi-user support
- Server-side purge of old done tasks (currently only hidden in UI)
