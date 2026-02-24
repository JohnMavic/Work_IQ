# Daily Briefing App — Product Specification

**Version:** 1.1
**Date:** February 24, 2026
**Author:** Martin Hämmerli
**Status:** Implemented — all 3 phases complete

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
  1. Calls Work IQ via Copilot SDK to scan the last 4 days of emails and Teams chats
  2. AI identifies action items assigned to or expected from the user
  3. Compares new items against the existing `tasks.json` list
  4. **New items** → added to the list
  5. **Duplicate items** (same source email/chat, same action) → skipped
  6. Returns the updated list to the frontend
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
  "version": 1,
  "lastScan": "2026-02-23T07:00:00.000Z",
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
      "createdAt": "2026-02-23T07:01:00.000Z",
      "updatedAt": "2026-02-23T07:01:00.000Z"
    },
    {
      "id": "uuid-v4",
      "title": "Prepare slides for Monday standup",
      "source": "manual",
      "from": null,
      "date": null,
      "link": null,
      "status": "in-progress",
      "notes": "Focus on Q4 results",
      "createdAt": "2026-02-23T08:00:00.000Z",
      "updatedAt": "2026-02-23T09:15:00.000Z"
    }
  ]
}
```

### 4.7 Duplicate Detection

When scanning, the AI must compare new findings against existing tasks:
- **Primary match:** Same source message link — if a task with the same `link` already exists, skip it
- **Fallback match (for items without links):** Same `title` (trimmed) + same `from` + same `source` type — prevents duplicates when Work IQ cannot provide a link
- **If duplicate found:** Skip — do not create a second entry
- **If existing task was updated** (e.g., deadline changed in a follow-up email): Update the existing task's title/notes, keep the user's status unchanged

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
│   └── ARCHITECTURE.md                ← Technical architecture reference
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

## 11. Future Enhancements (Out of Scope for v1)

- Automated daily scheduler (Windows Task Scheduler or cron)
- Email/Teams notification when new action items are found
- Priority levels (high/medium/low)
- Due dates and deadline warnings
- Weekly summary report
- Multi-user support
