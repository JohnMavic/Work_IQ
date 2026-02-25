# Daily Briefing App — Technical Architecture

**Version:** 1.4
**Date:** February 25, 2026
**Author:** Martin Hämmerli

---

## 1. System Overview

```
┌──────────────────────────────────────────────────────────────────────────┐
│                         Browser (index.html)                             │
│                                                                          │
│  ┌────────────┐  ┌─────────────┐  ┌──────────┐  ┌────────────────────┐  │
│  │ Scan Button │  │ Task Cards  │  │ Filters  │  │ Manual Task Form   │  │
│  └──────┬─────┘  └──────┬──────┘  └─────┬────┘  └─────────┬──────────┘  │
│         │               │               │                  │             │
│         └───────────────┴───────────────┴──────────────────┘             │
│                                    │                                     │
│                          fetch() REST API                                │
└────────────────────────────────────┼─────────────────────────────────────┘
                                     │
                              HTTP (localhost:3000)
                                     │
┌────────────────────────────────────┼─────────────────────────────────────┐
│                    Node.js Express Server (server.js)                     │
│                                    │                                     │
│         ┌──────────────────────────┼──────────────────────────┐          │
│         │                          │                          │          │
│    ┌────┴─────┐           ┌────────┴────────┐          ┌─────┴──────┐   │
│    │ REST API │           │  Copilot SDK    │          │ tasks.json │   │
│    │ Handlers │           │  (CopilotClient)│          │ (File I/O) │   │
│    └──────────┘           └────────┬────────┘          └────────────┘   │
│                                    │                                     │
│                           MCP Protocol (stdio)                           │
│                                    │                                     │
│                           ┌────────┴────────┐                            │
│                           │  Work IQ MCP    │                            │
│                           │  (workiq mcp)   │                            │
│                           └────────┬────────┘                            │
└────────────────────────────────────┼─────────────────────────────────────┘
                                     │
                            HTTPS (graph.microsoft.com)
                                     │
                           ┌─────────┴─────────┐
                           │  Microsoft Graph  │
                           │       API         │
                           └─────────┬─────────┘
                                     │
                           ┌─────────┴─────────┐
                           │   M365 Data       │
                           │  (Emails, Teams)  │
                           └───────────────────┘
```

### Component Roles

| Component | Role |
|---|---|
| **Browser (index.html)** | Single-page frontend. Renders task list, handles user interactions, communicates with backend via REST API. All HTML, CSS, and JS in one file. |
| **Express Server (server.js)** | Backend API server. Handles CRUD operations for tasks, orchestrates AI-powered email scanning, reads/writes tasks.json. |
| **Copilot SDK (CopilotClient)** | AI reasoning engine. Sends prompts to the GitHub Copilot model, manages tool invocations, returns structured responses. |
| **Work IQ MCP Server** | MCP-compatible tool server. Bridges between the Copilot SDK and Microsoft Graph API. Handles M365 authentication and data retrieval. |
| **Microsoft Graph API** | Microsoft's REST API for M365 data. Provides access to emails (Outlook) and chat messages (Teams). |
| **tasks.json** | Local JSON file for persistent storage. Stores all tasks, scan metadata, and version info. |

### Startup Flow (START-DAILY-BRIEFING.bat)

```
User doppelklickt BAT
        │
        ▼
BAT prüft Port 3000 ──► bereits belegt? ──► Browser öffnen
        │ nein
        ▼
node server.js (separates minimiertes Fenster)
        │
        ▼
Warte auf Server-Ready (max 15s)
        │
        ▼
Browser öffnet http://localhost:3000
        │
        ▼
index.html: checkServerHealth()
        │
        ├── ✅ Online → fetchTasks() → App bereit
        └── ❌ Offline → Banner + Auto-Retry (5s)
```

---

## 2. Authentication & Security Chain

```
┌──────────┐     ┌──────────────┐     ┌─────────────────┐     ┌──────────────┐
│   User   │────>│   Work IQ    │────>│  Microsoft      │────>│  Graph API   │
│          │     │   CLI/MCP    │     │  Entra ID       │     │              │
└──────────┘     └──────┬───────┘     │  (Azure AD)     │     └──────────────┘
                        │             └────────┬────────┘
                        │                      │
                        │              OAuth 2.0 Flow
                        │                      │
                        ▼                      ▼
                ┌───────────────┐     ┌─────────────────┐
                │   Windows     │     │  Access Token   │
                │   Credential  │     │  (~60-90 min)   │
                │   Manager     │     │                 │
                │               │     │  Refresh Token  │
                │  Stores:      │     │  (~90 days)     │
                │  - Refresh    │     └─────────────────┘
                │    Token      │
                │  - Account    │
                │    metadata   │
                └───────────────┘
```

### Authentication Flow

1. **First-time setup:** User runs `workiq accept-eula` which triggers Microsoft Entra ID (Azure AD) device code or interactive login
2. **Token acquisition:** MSAL (Microsoft Authentication Library) obtains an OAuth 2.0 access token + refresh token
3. **Token storage:** Refresh token is stored in **Windows Credential Manager** (secure OS-level storage, not in files)
4. **Runtime flow:** When Work IQ needs to call Graph API, MSAL silently acquires a new access token using the stored refresh token
5. **Token renewal:** Access tokens expire after ~60-90 minutes and are renewed automatically. Refresh tokens last ~90 days

### Token Lifecycle

```
Time ─────────────────────────────────────────────────────>

Access Token:  [====60-90 min====][====renewed====][====renewed====]
Refresh Token: [========================~90 days========================]
                                                                    ↑
                                                          User must re-auth
```

### Permission Boundaries

- Work IQ uses **delegated permissions** — it can only access data the authenticated user has access to
- The app cannot read other users' emails or Teams messages
- Scopes typically include: `Mail.Read`, `Chat.Read`, `ChannelMessage.Read.All` (delegated)
- Admin consent may be required for some scopes (depends on organization policy)

### Copilot SDK Authentication

- The Copilot SDK authenticates via GitHub credentials stored by the GitHub CLI (`gh`)
- Uses `useLoggedInUser: true` (default) to pick up stored OAuth tokens
- No GitHub token is stored in the app code

---

## 3. MCP (Model Context Protocol) Architecture

### What is MCP?

MCP (Model Context Protocol) is an open standard for connecting AI models to external tools and data sources. It defines a protocol for:
- **Tool discovery:** The AI model queries available tools from MCP servers
- **Tool invocation:** The AI decides when and how to call tools during reasoning
- **Result handling:** Tool results are fed back into the AI's context for further processing

### Why MCP?

Instead of writing custom API integration code to query Microsoft Graph, MCP allows:
1. The **AI model** to decide which queries to run based on the user's prompt
2. **Work IQ** to handle the complexity of Graph API calls, pagination, and data formatting
3. **Decoupled architecture** — the server.js doesn't need to know Graph API details

### Communication Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                    Node.js Process (server.js)                    │
│                                                                   │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │                    CopilotClient                           │   │
│  │                                                            │   │
│  │  1. Creates session with MCP server config                 │   │
│  │  2. Sends prompt to Copilot AI model                       │   │
│  │  3. AI model discovers tools from MCP server               │   │
│  │  4. AI model calls tools as needed                         │   │
│  │  5. Collects results and generates final response          │   │
│  │                                                            │   │
│  │  ┌──────────────────────────────────────────────────────┐  │   │
│  │  │              MCP Session Manager                      │  │   │
│  │  │                                                       │  │   │
│  │  │  Spawns child process: workiq mcp                     │  │   │
│  │  │  Communicates via stdin/stdout (JSON-RPC over stdio)  │  │   │
│  │  └────────────────────┬──────────────────────────────────┘  │   │
│  └───────────────────────┼─────────────────────────────────────┘   │
│                          │                                         │
│              stdin/stdout (JSON-RPC 2.0)                           │
│                          │                                         │
│  ┌───────────────────────┼─────────────────────────────────────┐   │
│  │            Work IQ MCP Server (child process)                │   │
│  │                       │                                      │   │
│  │  Exposes tools:       │                                      │   │
│  │  - Search emails      │                                      │   │
│  │  - Read email content │                                      │   │
│  │  - List Teams chats   │                                      │   │
│  │  - Read chat messages │                                      │   │
│  │                       │                                      │   │
│  │  Each tool call ──────┼──> HTTPS to Graph API                │   │
│  └───────────────────────┼──────────────────────────────────────┘   │
└──────────────────────────┼──────────────────────────────────────────┘
                           │
                    graph.microsoft.com
```

### stdio Transport

- Work IQ MCP server runs as a **child process** spawned by the Copilot SDK
- Communication happens over **stdin/stdout** using JSON-RPC 2.0 messages
- This is the simplest MCP transport — no TCP ports, no HTTP, no discovery needed
- The SDK manages the process lifecycle (start, communicate, terminate)

### Tool Registration

The MCP server is registered in the session configuration:

```javascript
const session = await client.createSession({
  mcpServers: {
    workiq: {
      type: 'stdio',          // Transport mode
      command: 'workiq',       // Executable
      args: ['mcp'],           // Arguments
      tools: '*'               // Expose all available tools
    }
  }
});
```

The SDK then:
1. Spawns `workiq mcp` as a child process
2. Sends `initialize` and `tools/list` requests via stdin
3. Receives the tool catalog via stdout
4. Makes these tools available to the AI model during the session

---

## 4. Data Flow — Scan Process

When the user clicks "Scan Emails & Teams":

```
Browser                    Express Server               Copilot SDK          Work IQ MCP         Graph API
   │                            │                            │                    │                   │
   │  1. POST /api/scan         │                            │                    │                   │
   │ ──────────────────────>    │                            │                    │                   │
   │                            │  2. new CopilotClient()    │                    │                   │
   │                            │ ──────────────────────>    │                    │                   │
   │                            │  3. createSession({        │                    │                   │
   │                            │       mcpServers: workiq   │                    │                   │
   │                            │     })                     │                    │                   │
   │                            │ ──────────────────────>    │  spawn process     │                   │
   │                            │                            │ ──────────────>    │                   │
   │                            │                            │  tools/list        │                   │
   │                            │                            │ <──────────────    │                   │
   │                            │                            │                    │                   │
   │                            │  4. sendAndWait(prompt)     │                    │                   │
   │                            │ ──────────────────────>    │                    │                   │
   │                            │                            │                    │                   │
   │                            │                     AI reasons about prompt      │                   │
   │                            │                     and decides to call tools    │                   │
   │                            │                            │                    │                   │
   │                            │                            │  5. tool call:     │                   │
   │                            │                            │  search_emails     │                   │
   │                            │                            │ ──────────────>    │  6. GET /me/      │
   │                            │                            │                    │  messages?$filter  │
   │                            │                            │                    │ ──────────────>   │
   │                            │                            │                    │  7. JSON response  │
   │                            │                            │                    │ <──────────────   │
   │                            │                            │  tool result       │                   │
   │                            │                            │ <──────────────    │                   │
   │                            │                            │                    │                   │
   │                            │                     AI may call more tools       │                   │
   │                            │                     (Teams chats, etc.)          │                   │
   │                            │                            │                    │                   │
   │                            │                     AI produces JSON array       │                   │
   │                            │                     of action items              │                   │
   │                            │                            │                    │                   │
   │                            │  8. AssistantMessageEvent   │                    │                   │
   │                            │     { data.content: "[...]" │                    │                   │
   │                            │ <──────────────────────    │                    │                   │
   │                            │                            │                    │                   │
   │                            │  9. Parse JSON response     │                    │                   │
   │                            │     Process "update" items   │                    │                   │
   │                            │     (merge into existing)    │                    │                   │
   │                            │     Process "new" items      │                    │                   │
   │                            │     (Safety-Net dedup check) │                    │                   │
   │                            │     Save to tasks.json       │                    │                   │
   │                            │     Update lastScan         │                    │                   │
   │                            │                            │                    │                   │
   │                            │  10. client.dispose()       │                    │                   │
   │                            │ ──────────────────────>    │  kill process      │                   │
   │                            │                            │ ──────────────>    │                   │
   │                            │                            │                    │                   │
   │  11. { success, added,     │                            │                    │                   │
   │       skipped, total }     │                            │                    │                   │
   │ <──────────────────────    │                            │                    │                   │
   │                            │                            │                    │                   │
   │  12. fetchTasks() +        │                            │                    │                   │
   │      show notification     │                            │                    │                   │
   │                            │                            │                    │                   │
```

### Step-by-Step Detail

| Step | Component | Action |
|---|---|---|
| 1 | Browser | User clicks "Scan Emails & Teams". Button is disabled, loading overlay shown. `POST /api/scan` sent via fetch(). |
| 2 | Server | Creates a new `CopilotClient` instance (connects to Copilot AI engine). |
| 3 | Server | Creates a session with Work IQ registered as an MCP tool server (spawns `workiq mcp` child process). |
| 4 | Server | Builds context-aware prompt: reads existing active tasks (max 50, id+title+source+from) and includes them in the scan prompt. Sends via `session.sendAndWait()` with 120-second timeout. |
| 5 | Copilot SDK | AI model reasons about the prompt, calls Work IQ tools (search emails, list Teams chats), and **matches findings against provided existing tasks**. |
| 6-7 | Work IQ | Queries Microsoft Graph API using the user's OAuth token. Returns email/chat data to the AI. |
| 8 | Copilot SDK | AI processes all retrieved data and returns a JSON array. Each item has `action: "new"` (new task) or `action: "update"` (matches existing task, with `existingId`, `changes`, `reason`). |
| 9 | Server | Parses JSON from AI response. Processes `"update"` items (merge changes into existing tasks, add history). Processes `"new"` items with Safety-Net dedup (Jaccard word-similarity >0.7). Falls back to old dedup logic for items without `action` field. Saves via write queue. |
| 10 | Server | Disposes the CopilotClient (terminates Work IQ child process). |
| 11 | Server | Returns `{ success, added, updated, skipped, total, lastScan }` to the browser. |
| 12 | Browser | Fetches updated task list, renders it, shows notification toast with scan results. |

---

## 5. Data Flow — Manual Task CRUD

```
Browser                         Express Server                  tasks.json
   │                                 │                              │
   │  POST /api/tasks               │                              │
   │  { title, notes }              │                              │
   │ ───────────────────────>       │                              │
   │                                 │  readTasks()                 │
   │                                 │ ───────────────────────>    │
   │                                 │ <───────────────────────    │
   │                                 │                              │
   │                                 │  Generate UUID               │
   │                                 │  Create task object          │
   │                                 │  Append to tasks array       │
   │                                 │                              │
   │                                 │  writeTasks()                │
   │                                 │ ───────────────────────>    │
   │                                 │                              │
   │  201 { task object }           │                              │
   │ <───────────────────────       │                              │
   │                                 │                              │
   │  GET /api/tasks (re-fetch)     │                              │
   │ ───────────────────────>       │  readTasks()                 │
   │                                 │ ───────────────────────>    │
   │  { version, lastScan, tasks }  │                              │
   │ <───────────────────────       │                              │
   │                                 │                              │
   │  Re-render task list           │                              │
   │  Update filter badge counts    │                              │
```

### Mutation Pattern

All task mutations follow the same pattern:
1. Browser sends REST request (POST, PATCH, or DELETE)
2. Server reads `tasks.json` → applies change → writes `tasks.json`
3. Server returns the result
4. Browser calls `fetchTasks()` to re-fetch the full task list
5. `renderTasks()` re-renders the entire UI (sort, filter, badge counts)

This "re-fetch after mutate" pattern is simple and guarantees the UI always reflects the true state of tasks.json.

---

## 6. API Reference

### GET /api/tasks

Returns all tasks and metadata.

**Response (200):**
```json
{
  "version": 1,
  "lastScan": "2026-02-23T07:00:00.000Z",
  "tasks": [ ... ]
}
```

**Errors:** `500` — Failed to read tasks.json

---

### POST /api/tasks

Creates a new manual task.

**Request Body:**
```json
{
  "title": "Task title (required)",
  "notes": "Optional notes"
}
```

**Response (201):**
```json
{
  "id": "uuid-v4",
  "title": "Task title",
  "source": "manual",
  "from": null,
  "date": null,
  "link": null,
  "status": "active",
  "notes": "Optional notes",
  "createdAt": "2026-02-23T08:00:00.000Z",
  "updatedAt": "2026-02-23T08:00:00.000Z"
}
```

**Errors:** `400` — Title is required | `500` — Write failure

---

### PATCH /api/tasks/:id

Updates task fields (status, notes, title).

**Request Body (partial):**
```json
{
  "status": "done",
  "notes": "Updated notes"
}
```

**Response (200):** Updated task object

**Errors:**
- `400` — Invalid status (must be: active, in-progress, done, paused)
- `404` — Task not found
- `500` — Write failure

---

### DELETE /api/tasks/:id

Deletes a task permanently.

**Response (200):**
```json
{ "success": true }
```

**Errors:** `404` — Task not found | `500` — Write failure

---

### POST /api/scan

Triggers an AI-powered scan of M365 emails and Teams messages.

**Request Body:** None

**Response (200):**
```json
{
  "success": true,
  "added": 3,
  "skipped": 2,
  "total": 10,
  "lastScan": "2026-02-23T09:00:00.000Z"
}
```

**Errors:**
- `500` — Scan failed (auth error, connection error, timeout)
- `502` — No response from AI engine / AI returned unexpected format

---

## 7. Frontend Architecture

### Single-File Design

The entire frontend is contained in `index.html`:
- **HTML** structure (header, main, form, loading overlay)
- **CSS** styles (~200 lines, all in a `<style>` tag)
- **JavaScript** application logic (~305 lines, all in a `<script>` tag)

No build step, no bundler, no framework. This matches the project convention (AI Café Presenter uses the same pattern).

### State Management

```
┌─────────────────────────────────────────────┐
│  In-Memory State                             │
│                                              │
│  let tasks = [];        // All tasks         │
│  let currentFilter = 'all'; // Active filter │
│  let serverOnline = false;  // Server reachable?     │
│  let reconnectTimer = null; // Auto-retry interval   │
└──────────────────┬──────────────────────────┘
                   │
        Updated by fetchTasks()
        after every mutation
                   │
                   ▼
┌─────────────────────────────────────────────┐
│  renderTasks()                               │
│                                              │
│  1. Count tasks per status → update badges   │
│  2. Sort: status priority → createdAt desc   │
│  3. Filter by currentFilter                  │
│  4. Generate HTML for each task card         │
│  5. Inject into DOM                          │
└─────────────────────────────────────────────┘
```

There is no local state diffing or virtual DOM. The entire task list is re-rendered on every change. This is acceptable for the expected data volume (dozens of tasks, not thousands).

### Notification System

```
showNotification(message, type)
  │
  ├── Remove existing notification (if any)
  ├── Create <div class="notification notification-{type}">
  ├── Append to document.body
  ├── Auto-remove after 5 seconds
  └── User can dismiss via ✕ button
```

Types: `success` (green border/text) and `error` (red border/text). Slides in from the right with CSS animation.

### Server Health Check

```
checkServerHealth()
  │
  ├── fetch('/api/tasks') with AbortController (3s timeout)
  ├── Success → setServerStatus(true) → load tasks
  └── Failure → setServerStatus(false) → show banner + start polling

setServerStatus(online)
  │
  ├── Toggle offline banner visibility
  ├── Toggle status dot (green/red)
  ├── Enable/disable scan + add buttons
  ├── If reconnected: clear timer + show notification
  └── If offline: start 5s polling timer
```

### Filter System

Five filter buttons with `data-filter` attributes: `all`, `active`, `in-progress`, `done`, `paused`. Clicking a filter:
1. Sets `currentFilter`
2. Updates the `active` CSS class on the button
3. Calls `renderTasks()` which filters the sorted array

Badge counts are updated on every render by counting tasks per status.

### Sort Logic

```
Primary sort:   Status priority (Active=0, In Progress=1, Paused=2, Done=3)
Secondary sort: createdAt descending (newest first within each status group)
```

### Task Interaction Panel (v1.4)

Each task card now has an **interaction panel** that replaces the old "📜 History" toggle.

```
Task Card Layout (v1.4):
════════════════════════

┌─ Card Header (always visible, clickable) ──────────────────────────────────┐
│ Title + Meta + Status + Actions                                            │
└────────────────────────────────────────────────────────────────────────────┘
                │ click toggles ▼
┌─ Interaction Panel (hidden by default) ────────────────────────────────────┐
│                                                                            │
│  ┌─ Agent Conversations (chat-style, chronological) ────────────────────┐  │
│  │ 📝 User: "Ich habe Eors nach einer Antwort gefragt..."              │  │
│  │ 🤖 Agent: "Suche in deiner Inbox nach Antworten von Eörs..."        │  │
│  │ ✅ User confirmed                                                    │  │
│  │ 📧 Eörs → Martin — "Eörs bestätigt..." [Open ↗]                    │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  ┌─ Log Input (always visible in panel) ────────────────────────────────┐  │
│  │ [What did you do? ___________________________] [🔍 Analyze]          │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│  ┌─ Plan Display (appears after analyze) ───────────────────────────────┐  │
│  │ 💡 Understanding + [✅ Search] [❌ Cancel]                            │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
│                                                                            │
│  [▶ Details]                                                               │
│  ┌─ Details (collapsed, expandable) ────────────────────────────────────┐  │
│  │ Technical: Keywords, Time Window, Search Targets (per interaction)   │  │
│  │ System Events: ➕ Created, ✅ Status changed, 🔄 Scan updated       │  │
│  └──────────────────────────────────────────────────────────────────────┘  │
└────────────────────────────────────────────────────────────────────────────┘
```

**State management additions (v1.4):**
```
let pendingPlans = {};   // taskId → { plan, originalText }
let openTaskId = null;   // Which task's panel is currently open
```

**Rendering logic:**
- `renderTasks()` splits history entries into two groups:
  1. **Agent conversations** — entries with `type === "update"` (shown chat-style)
  2. **System events** — entries with `type !== "update"` (shown in Details toggle)
- Agent conversations render in chronological order (oldest first = read like a chat)
- System events render in reverse chronological order (newest first)
- Clicking card header calls `toggleTaskPanel(taskId)` which replaces old `toggleHistory()`

---

## 8. Data Schema

### tasks.json

```json
{
  "version": 2,
  "lastScan": "2026-02-24T07:00:00.000Z | null",
  "tasks": [ Task, ... ]
}
```

| Field | Type | Description |
|---|---|---|
| `version` | number | Schema version (2 since v1.2) |
| `lastScan` | string \| null | ISO 8601 timestamp of last successful scan, or null if never scanned |
| `tasks` | array | Array of Task objects |

### Task Object

| Field | Type | Description | Valid Values |
|---|---|---|---|
| `id` | string | UUID v4 identifier | Auto-generated |
| `title` | string | Short description of the action item | Free text (required) |
| `source` | string | Where the task came from | `"email"`, `"teams"`, `"manual"` |
| `from` | string \| null | Sender name (scanned tasks) or null (manual tasks) | |
| `date` | string \| null | Original message date (ISO 8601) or null | |
| `link` | string \| null | Deep link to source message or null | Outlook/Teams URL |
| `status` | string | Current task status | `"active"`, `"in-progress"`, `"done"`, `"paused"` |
| `notes` | string | User-added notes | Free text (default: "") |
| `history` | array | Chronological log of task events (v1.2) | Array of HistoryEntry |
| `doneAt` | string \| null | Timestamp when set to "done" (v1.2), null otherwise | ISO 8601 |
| `createdAt` | string | When the task was created in the app (ISO 8601) | Auto-generated |
| `updatedAt` | string | Last modification timestamp (ISO 8601) | Auto-updated |

### HistoryEntry Object (v1.2, extended v1.4)

| Field | Type | Description |
|---|---|---|
| `timestamp` | string | When this event occurred (ISO 8601) |
| `type` | string | `"created"`, `"status-change"`, `"update"`, `"scan-update"`, `"note"`, `"communication"` |
| `text` | string | Human-readable description of the event |
| `communications` | array \| undefined | Array of linked communications (only for type "update" and "communication") |
| `agentPlan` | object \| undefined | (v1.4) The confirmed search plan — records what the agent understood, what keywords/time window it used, and whether the user confirmed. Only present for log work entries created via the two-phase agent. |

**agentPlan Object (v1.4):**
| Field | Type | Description |
|---|---|---|
| `understanding` | string | What the agent understood from the user's request |
| `keywords` | string[] | Search keywords extracted from task title + user text |
| `timeWindow` | object | `{ from, to, reasoning }` — the search date range |
| `searchTargets` | string | What was searched: "inbox", "sent", "teams", or "all" |
| `userConfirmed` | boolean | `true` if user explicitly confirmed, `false` if auto-executed |
| `fallback` | boolean | `true` if AI analysis failed and deterministic fallback was used |

### Communication Object (v1.2)

| Field | Type | Description |
|---|---|---|
| `type` | string | `"email"` or `"teams"` |
| `from` | string | Sender name |
| `to` | string | Recipient name(s) |
| `date` | string | Message date (ISO 8601) |
| `summary` | string | AI-generated 1-2 sentence summary of the message |
| `link` | string \| null | Deep link to the original message |

### Example with All Sources and Statuses

```json
{
  "version": 1,
  "lastScan": "2026-02-23T09:00:00.000Z",
  "tasks": [
    {
      "id": "a1b2c3d4-e5f6-7890-abcd-ef1234567890",
      "title": "Review Q1 budget proposal",
      "source": "email",
      "from": "Sarah Johnson",
      "date": "2026-02-22T14:30:00.000Z",
      "link": "https://outlook.office365.com/owa/?ItemID=AAMk...",
      "status": "active",
      "notes": "",
      "createdAt": "2026-02-23T09:01:00.000Z",
      "updatedAt": "2026-02-23T09:01:00.000Z"
    },
    {
      "id": "b2c3d4e5-f6a7-8901-bcde-f12345678901",
      "title": "Reply to project timeline discussion",
      "source": "teams",
      "from": "Alex Chen",
      "date": "2026-02-21T10:15:00.000Z",
      "link": "https://teams.microsoft.com/l/message/...",
      "status": "in-progress",
      "notes": "Need to check with PM first",
      "createdAt": "2026-02-23T09:01:00.000Z",
      "updatedAt": "2026-02-23T10:30:00.000Z"
    },
    {
      "id": "c3d4e5f6-a7b8-9012-cdef-123456789012",
      "title": "Prepare slides for Monday standup",
      "source": "manual",
      "from": null,
      "date": null,
      "link": null,
      "status": "done",
      "notes": "Focus on Q4 results",
      "createdAt": "2026-02-23T08:00:00.000Z",
      "updatedAt": "2026-02-23T11:00:00.000Z"
    },
    {
      "id": "d4e5f6a7-b8c9-0123-defa-234567890123",
      "title": "Follow up on vendor contract",
      "source": "email",
      "from": "Legal Team",
      "date": "2026-02-20T09:00:00.000Z",
      "link": "https://outlook.office365.com/owa/?ItemID=BBNk...",
      "status": "paused",
      "notes": "Waiting for legal review to complete",
      "createdAt": "2026-02-23T09:01:00.000Z",
      "updatedAt": "2026-02-23T09:45:00.000Z"
    }
  ]
}
```

---

## 9. Error Handling

### Server-Side Strategy

Every API endpoint wraps its logic in try/catch:

```
Request ──> try { read/write tasks.json, process } catch (err) { 500 + error detail }
```

The scan endpoint has additional error surfaces:

```
POST /api/scan
  │
  ├── CopilotClient creation fails ──> 500 { error, detail: err.message }
  ├── Session creation fails ──────────> 500 { error, detail: err.message }
  ├── sendAndWait returns null ────────> 502 { error: "No response from AI engine" }
  ├── AI response not parseable ───────> 502 { error: "AI returned unexpected format", raw }
  ├── sendAndWait timeout (120s) ──────> 500 { error, detail: "timeout..." }
  ├── Auth/token error ────────────────> 500 { error, detail: "...auth/token..." }
  └── Success ─────────────────────────> 200 { success, added, skipped, total }
      │
      └── finally: client.dispose() (always clean up)
```

### Client-Side Error Mapping (friendlyError)

The frontend `friendlyError()` function maps server error responses to user-friendly messages:

| Server Error Detail Contains | User-Facing Message |
|---|---|
| `auth`, `token`, `401`, `unauthorized` | Authentication expired — please run "workiq accept-eula" in your terminal and try again. |
| `econnrefused`, `spawn`, `not found`, `not recognized` | Could not start Work IQ. Make sure it is installed globally (npm i -g @microsoft/workiq). |
| `timeout`, `timed out` | Scan timed out — your mailbox may be very large. Please try again. |
| error = "No response from AI engine" | No response from AI engine. Check your GitHub Copilot authentication. |
| error = "AI returned unexpected format" | The AI returned an unexpected response. Please try scanning again. |
| fetch TypeError (network error) | Cannot reach the server. Is it still running? |
| Any other error | Falls back to `data.message` or `data.error` or generic message |

### JSON Response Parser

The `parseJsonFromResponse()` function handles multiple AI response formats:

```
AI Response Text
  │
  ├── Try JSON.parse(text) directly ──> success? return array
  │
  ├── Try regex for ```json ... ``` ──> extract, parse ──> success? return array
  │
  ├── Try regex for [...] anywhere ──> extract, parse ──> success? return array
  │
  └── Return null (triggers 502 error)
```

### Concurrency & Write Safety (v1.2)

```
POST /api/tasks/:id/log (Task A)  ──┐
                                     ├── writeQueue (sequential)
POST /api/tasks/:id/log (Task B)  ──┘
                                     │
                                     ▼
                              readTasks() → modify → writeTasks()
                              (one at a time, queued)
```

Multiple `/api/tasks/:id/log` calls can arrive concurrently (user working on multiple tasks). A simple Promise-based write queue ensures:
- Only one `writeTasks()` call executes at a time
- Later writes wait for earlier ones to complete
- No data loss from concurrent file writes

### Log Work — Two-Phase Agent (v1.4)

The log work feature uses a two-phase approach for transparency and precision.

```
Two-Phase Architecture:
═══════════════════════

Phase 1: ANALYZE (fast, ~5-15 seconds)
──────────────────────────────────────
User text ──→ POST /api/tasks/:id/log/analyze
                    │
                    ▼
         ┌──────────────────────┐
         │ Copilot SDK          │   ← NO Work IQ MCP
         │ (AI reasoning only)  │   ← No M365 data access
         └──────────┬───────────┘   ← Fast: just text analysis
                    │
                    ▼
         ┌──────────────────────┐
         │ Structured Plan:     │
         │ • understanding      │
         │ • keywords           │
         │ • timeWindow         │
         │ • searchTargets      │
         │ • needsClarification │
         └──────────┬───────────┘
                    │
         ┌──────────▼───────────┐
         │ Frontend: show plan  │──→ User confirms or adjusts
         └──────────┬───────────┘
                    │
Phase 2: EXECUTE (after confirm, ~30-90 seconds)
────────────────────────────────────────────────
Confirmed plan ──→ POST /api/tasks/:id/log
                    │
                    ▼
         ┌──────────────────────┐
         │ LOG_WORK_SKILL.md    │  ← Static search instructions
         ├──────────────────────┤
         │ Confirmed plan:      │  ← Keywords, time window, targets
         │ + Task context       │
         │ + User log text      │
         └──────────┬───────────┘
                    │
                    ▼
         ┌──────────────────────┐
         │ Copilot SDK          │
         │ + Work IQ MCP        │  ← NOW searches M365
         └──────────┬───────────┘
                    │
                    ▼
         JSON array of communications
                    │
                    ▼
         History entry saved
```

**Key design decisions:**
- Phase 1 creates a CopilotClient session WITHOUT `mcpServers` → AI can only reason, not search
- Phase 2 creates a session WITH Work IQ → targeted search using confirmed parameters
- The analysis prompt is hardcoded (not a skill file) — it's a stable meta-prompt for understanding intent
- The execution prompt uses `LOG_WORK_SKILL.md` (tunable by Architect)
- Fallback: If Phase 1 SDK fails, server uses `extractKeywords()` for deterministic analysis
- Backward-compatible: If `plan` is omitted in the `/log` request, falls back to v1.3 behavior

**Clarification Loop:**
```
User input too vague ──→ Agent returns needsClarification: true
                         + clarificationQuestion
                              │
                              ▼
                    Frontend shows question
                    + answer input field
                              │
                              ▼
                    User answers ──→ Re-submit to /analyze
                                    (original text + " Additional context: " + answer)
                              │
                              ▼
                    Agent returns clear plan ──→ User confirms
```

**Skill File Architecture (v1.4):**
```
Documents/
├── SCAN_SKILL.md       → POST /api/scan                (detect + dedup action items)
└── LOG_WORK_SKILL.md   → POST /api/tasks/:id/log       (Phase 2: search communications)
                          POST /api/tasks/:id/log/analyze uses hardcoded analysis prompt
```

### AI-Powered Deduplication Strategy (v1.3)

#### Problem (v1.2)

The v1.2 dedup logic uses exact-match comparisons that fail in common real-world scenarios:

```
v1.2 Matching Logic:
  Stufe 1: t.link === item.link           → Fails: same task, different email links
  Stufe 2: t.title === title              → Fails: AI rephrases title slightly
           && t.from === from             → Fails: different sender, same topic
           && t.source === source         → Fails: Teams + Email about same task
```

#### Solution: Context-Aware Scan Prompt

Instead of blind scanning + weak server-side dedup, the AI receives existing tasks as context:

```
┌──────────────────────────────────────────────────────────────────────┐
│                     SCAN FLOW v1.3 vs v1.2                           │
├──────────────────────────────────────────────────────────────────────┤
│                                                                      │
│  v1.2:  Prompt: "Scan my emails..."                                  │
│         AI returns: [ {title, source, from, date, link}, ... ]       │
│         Server dedup: exact link match → exact title+from+source     │
│         Result: ❌ Duplicates when AI rephrases or link differs      │
│                                                                      │
│  v1.3:  Prompt: "Here are EXISTING tasks: [...]. Scan my emails..."  │
│         AI returns: [ {action:"new",...}, {action:"update",...}, ... ]│
│         Server processes: update → merge changes, new → safety-net   │
│         Result: ✅ AI matches semantically, server validates          │
│                                                                      │
└──────────────────────────────────────────────────────────────────────┘
```

#### Processing Pipeline

```
AI Response Items
      │
      ▼
┌─────────────┐     ┌──────────────────┐     ┌────────────────────┐
│ action:     │     │ Find by          │     │ Merge changes:     │
│ "update"    │────>│ existingId       │────>│ title, date, link  │
│             │     │ in tasks.json    │     │ Add history entry  │
└─────────────┘     └──────────────────┘     │ with AI reason     │
                                              └────────────────────┘
┌─────────────┐     ┌──────────────────┐     ┌────────────────────┐
│ action:     │     │ Safety-Net:      │     │ If similar >70%:   │
│ "new"       │────>│ Jaccard word     │────>│   SKIP (warn log)  │
│             │     │ similarity check │     │ If not similar:    │
└─────────────┘     │ vs all tasks     │     │   CREATE new task  │
                    └──────────────────┘     └────────────────────┘
┌─────────────┐     ┌──────────────────┐
│ no action   │     │ Backward-compat: │
│ field       │────>│ old v1.2 logic   │
│             │     │ (link + title)   │
└─────────────┘     └──────────────────┘
```

#### Safety-Net: Normalized Title Similarity

```javascript
// Server-side fallback after AI matching
normalizeForCompare(title):
  → lowercase → remove punctuation → collapse whitespace → trim

isSimilarTitle(a, b):
  → Jaccard similarity on word sets: |intersection| / |union|
  → Threshold: 0.7 (70% word overlap)
  → Example: "Approve SAP Invoice 5735236948" vs "SAP Invoice 5735236948 approval needed"
    Words A: {approve, sap, invoice, 5735236948}
    Words B: {sap, invoice, 5735236948, approval, needed}
    Intersection: 3, Union: 6 → 0.5 (below threshold, but AI should catch this)
```

---

## 10. Dependencies

| Package | Version | Purpose | Why Chosen |
|---|---|---|---|
| `express` | ^5.2.1 | HTTP server and REST API routing | Industry-standard Node.js web framework. Minimal overhead, well-documented. |
| `uuid` | ^13.0.0 | Generate UUID v4 identifiers for tasks | RFC-compliant UUIDs for unique task IDs. No external service needed. |
| `@github/copilot-sdk` | ^0.1.25 | AI reasoning engine (CopilotClient, session management, MCP integration) | Provides the connection to GitHub Copilot's AI model with built-in MCP support. ESM-only module. |
| `@microsoft/workiq` | ^0.2.8 | MCP tool server for M365 data access (emails, Teams) | Pre-installed CLI with EULA accepted. Handles Graph API auth and queries. Used as MCP stdio server. |

### Runtime Requirements

| Requirement | Version | Purpose |
|---|---|---|
| Node.js | v18+ | JavaScript runtime (must support ES Modules) |
| GitHub CLI (`gh`) | Latest | Provides stored OAuth tokens for Copilot SDK authentication |
| Windows Credential Manager | (OS built-in) | Stores Work IQ / MSAL refresh tokens securely |

### Project Configuration

```json
{
  "type": "module"
}
```

The project uses **ES Modules** (not CommonJS) because `@github/copilot-sdk` is ESM-only. This means:
- `import`/`export` syntax instead of `require()`/`module.exports`
- `__dirname` and `__filename` are not available natively (reconstructed via `fileURLToPath`)
- All `.js` files are treated as ES Modules by Node.js
