# Agent Zero — Complete Feature & Function Inventory (Codex Analysis)

> Auto-generated from source code analysis of `server.js` and `index.html`.
> This document describes every feature, function, and service the application provides, derived 100% from the codebase — not from specification or architecture documents.


> Codex verification (February 28, 2026): code-based review plus runtime smoke tests for `GET/POST/PATCH/DELETE /api/tasks`, note history deletion success, and reproducible HTTP 403 when deleting `review-response`.

> Signal legend: `🟢` works as documented, `🟡` works with issues or documentation mismatch, `🔴` does not work as documented.

---

## 1. API Endpoints (Backend Services)

| # | HTTP Method | Path | What It Does | Technologies Used | Signal | Code-Based Finding | Plain-English Impact |
|---|-------------|------|--------------|-------------------| --- | --- | --- |
| 1 | `GET` | `/` | Serves the single-page HTML frontend (`index.html`) | Express.js static file serving via `res.sendFile()` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| 2 | `GET` | `/api/tasks` | Returns all tasks from persistent storage as JSON array | `fs.readFileSync()` → `tasks.json` → `JSON.parse()` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| 3 | `POST` | `/api/tasks` | Creates a new manual task with title, optional notes. Generates UUID, sets `status: 'new'`, `source: 'manual'`, `enrichmentStatus: 'n/a'`. Adds `created` history entry. | `uuid.v4()`, `safeWriteTasks()` write queue, `tasks.json` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| 4 | `PATCH` | `/api/tasks/:id` | Updates task fields. Allowed: `status`, `notes`, `title`, `summary`, `enrichmentStatus`, `updateCheckStatus`. Validates status against whitelist. Logs status changes and summary changes in history. Manages `doneAt` timestamp. | `safeWriteTasks()` write queue, status validation (`new`, `needs-attention`, `escalated`, `in-progress`, `done`, `paused`) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| 5 | `DELETE` | `/api/tasks/:id` | Permanently removes a task by ID from storage. | `safeWriteTasks()` with `data.tasks.filter()` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| 6 | `DELETE` | `/api/tasks/:id/history/:index` | Deletes a single history entry by array index. Protects system entries — only allows deletion of `update`, `note`, and `review-response` types. | `safeWriteTasks()`, type whitelist check | 🟡 | Documentation says `review-response` entries are deletable, but backend allows only `update` and `note` (server.js:433). Runtime test returned HTTP 403 for `review-response` delete. | A user may click delete and get blocked, even though the document says it should work. |
| 7 | `POST` | `/api/tasks/:id/note` | Adds a quick text note to task history without any agent interaction. Creates history entry with `type: 'note'`. | `safeWriteTasks()`, no AI involved | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| 8 | `POST` | `/api/scan` | **Phase 1 — Discovery.** Scans Microsoft 365 emails and Teams messages for new action items. Uses AI to identify subjects requiring attention. Deduplicates against existing tasks using Jaccard title similarity (>0.7) and exact link matching. Creates new tasks with `enrichmentStatus: 'pending'`. Can also update existing tasks if AI returns matching items with changes. | `CopilotClient` → Copilot SDK session with Work IQ MCP server (`stdio`, `workiq mcp`), `SCAN_DISCOVERY_SKILL.md` prompt, `isSimilarTitle()` Jaccard dedup, `normalizeForCompare()`, scan days parameter (1–7), 90s timeout | 🟡 | Implemented, but documented limits are outdated: code accepts `scanDays` 1-14 and uses 180s timeout (server.js:493,564), not 1-7 and 90s. | The scan may run longer and over a larger date range than the document promises. |
| 9 | `POST` | `/api/tasks/:id/enrich` | **Phase 2 — Enrichment.** Extracts detailed content from the original email/Teams thread. Generates a structured summary with confidence level and language detection. Detects ambiguities where the agent is unsure. Skips tasks already enriched or in needs-review state. | `CopilotClient` + Work IQ MCP, `ENRICH_SKILL.md` prompt, `extractKeywords()` for search terms, `normalizeAmbiguities()`, 300s timeout, keyword-based search (not exact-subject) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| 10 | `POST` | `/api/tasks/:id/check-update` | **Phase 3 — Update Check.** Checks if new messages have appeared in the thread since the last check. Runs on EVERY scan (not just once like enrichment). Appends update summary to existing task summary. Resets `updateCheckStatus` per scan cycle. | `CopilotClient` + Work IQ MCP, `UPDATE_CHECK_SKILL.md` prompt, `extractKeywords()`, temporal anchor (`lastUpdateCheck` or `enrichedAt`), 300s timeout | 🟡 | Endpoint works, but there is no global reset of `updateCheckStatus` each scan cycle; status is updated per task during processing. | Progress/status behavior is slightly different from the documented process wording. |
| 11 | `POST` | `/api/tasks/:id/log/analyze` | **Log Work Phase 1 — Intent Analysis.** AI analyzes user's free-text message to determine intent: `summarize` (create/update summary), `search` (find communications), or `answer` (respond from context). For `summarize` intent: overwrites `task.summary` and logs change. For `search`: returns executable plan. No Work IQ needed — pure AI reasoning. | `CopilotClient` with empty session (no MCP), 30s timeout, `parseJsonFromResponse()`, intent-based routing, summary overwrite with `summary-update` history entry | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| 12 | `POST` | `/api/tasks/:id/log` | **Log Work Phase 2 — Search Execution.** Executes the search plan from Phase 1. Two search methods: (a) `workiq-ask` via CLI subprocess when plan is provided, (b) Copilot SDK + Work IQ MCP as fallback. Parses structured communications (emails/Teams) from response. Stores full execution trace (prompt sent, raw response, parsed count, duration). | `runWorkIQAsk()` CLI spawn (`workiq ask` stdin/stdout), `buildSearchQuestion()` prompt builder, `CopilotClient` + Work IQ MCP fallback, `parseJsonFromResponse()`, `parseMarkdownEmails()` Markdown parser, `LOG_WORK_SKILL.md` prompt | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| 13 | `POST` | `/api/tasks/:id/review` | **Ambiguity Resolution.** User responds to the agent's review questions. AI evaluates which questions are sufficiently answered, provides updated summary if clarifications warrant it, and formulates remaining questions if any are still open. Marks resolved items with timestamp. Changes `enrichmentStatus` to `'enriched'` when all items resolved. | `CopilotClient` with empty session (no MCP), `normalizeAmbiguities()`, per-item resolution tracking (`resolved`, `resolvedAt`), `summary-update` history entry, 30s timeout | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

---

## 2. Three-Phase Scan Pipeline

| Phase | Name | Trigger | What Happens | Timeout | Runs | Signal | Code-Based Finding | Plain-English Impact |
|-------|------|---------|--------------|---------|------| --- | --- | --- |
| 1 | Discovery | User clicks "Scan Emails & Teams" | AI scans M365 via Work IQ for new action items. Creates tasks with `summary: null`, `enrichmentStatus: 'pending'`. Deduplicates against all non-deleted tasks. | 90s | Once per scan | 🟡 | Pipeline row timeout is outdated: code runs discovery with 180s timeout, not 90s. | Users can experience longer waits than expected from this table. |
| 2 | Enrichment | Automatic after Phase 1 | For each task with `enrichmentStatus: 'pending'`: extracts thread content, generates summary, detects ambiguities. Sets status to `'enriched'` or `'needs-review'`. | 300s per task | Once per task (skips if already enriched) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| 3 | Update Check | Automatic after Phase 2 | For each task with `enrichmentStatus: 'enriched'` or `'needs-review'` (non-done): checks for new messages since last check. Appends updates to summary. | 300s per task | Every scan cycle (resets `updateCheckStatus` each time) | 🟡 | Update check runs every scan, but `updateCheckStatus` is not globally reset beforehand; it changes when each task is processed. | Status labels can look inconsistent with the documented "full reset" behavior. |

---

## 3. Two-Phase Log Work System

| Phase | Name | Endpoint | What Happens | AI Configuration | Signal | Code-Based Finding | Plain-English Impact |
|-------|------|----------|--------------|------------------| --- | --- | --- |
| 1 | Intent Analysis | `/api/tasks/:id/log/analyze` | AI determines user intent: `summarize`, `search`, or `answer`. For summarize/answer: returns result immediately and saves to history. For search: returns executable plan with keywords, time window, search targets. | Copilot SDK only (no MCP) — fast reasoning | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| 2 | Search Execution | `/api/tasks/:id/log` | Executes the search plan. Primary method: `workiq ask` CLI subprocess. Fallback: Copilot SDK + Work IQ MCP session. Parses emails/Teams messages from response. | Work IQ CLI or Copilot SDK + Work IQ MCP | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

---

## 4. Frontend Features & UI Components

### 4.1 Server Health Monitoring

| Feature | What It Does | Implementation | Signal | Code-Based Finding | Plain-English Impact |
|---------|--------------|----------------| --- | --- | --- |
| Health Check | Polls `/api/tasks` with 3s abort timeout on page load | `checkServerHealth()` with `AbortController`, `fetch()` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Status Dot | Green (online) / Red (offline) indicator in header, 12px circle | `.server-dot` CSS class, toggled by `setServerStatus()` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Architecture Tooltip | CSS-only hover tooltip on status dot showing tech stack (Express, Copilot SDK, Work IQ, tasks.json) | `.server-tooltip` with `::after` pseudo-element | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Offline Banner | Amber banner with startup instructions (BAT + manual command) when server unreachable | `.server-offline-banner`, shown/hidden by `setServerStatus()` | 🟡 | Offline instructions reference `START-AGENT-ZERO.bat`, but that file does not exist. The repository contains `START-DAILY-BRIEFING.bat`. | A non-technical user may try to run a missing file and fail to start the app. |
| Auto-Reconnect | Polls every 5s when offline; shows "✅ Server connected" notification on reconnect | `setInterval(checkServerHealth, 5000)`, cleared on reconnect | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Button Protection | Scan and Add Task buttons disabled when offline | `btn.disabled = !serverOnline` in `setServerStatus()` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

### 4.2 Task Management

| Feature | What It Does | Implementation | Signal | Code-Based Finding | Plain-English Impact |
|---------|--------------|----------------| --- | --- | --- |
| Create Task | Manual task creation with title (required) + notes (optional) | `addTask()` → `POST /api/tasks`, HTML form with `onsubmit` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Status Management | 6 statuses: Needs Attention, New, Escalated, In Progress, Paused, Done | `<select>` dropdown → `updateTask()` → `PATCH /api/tasks/:id` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Delete Task | Permanent deletion with immediate UI removal | `deleteTask()` → `DELETE /api/tasks/:id` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Filter by Status | 7 filter buttons (All + 6 statuses) with live count badges | `setFilter()` → `renderTasks()` with `currentFilter` state | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Sort Order | Status priority (needs-attention > new > escalated > in-progress > paused > done), then `createdAt` descending | `renderTasks()` with `statusOrder` map + date sort | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Auto-Hide Done | Tasks marked done >3 days ago are hidden from default view (still visible in "Done" filter) | `renderTasks()` filters `doneAt` older than 3 days | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Task Count | Badge showing filtered task count in filter bar | `updateTaskCount()` after every render | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

### 4.3 Task Card Display

| Feature | What It Does | Implementation | Signal | Code-Based Finding | Plain-English Impact |
|---------|--------------|----------------| --- | --- | --- |
| Source Badge | Color-coded badge: 📧 Email (blue), 💬 Teams (purple), 📝 Manual (gray) | `.badge-email`, `.badge-teams`, `.badge-manual` CSS classes | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Step Indicators | 3 dots showing pipeline progress: Discovery → Enrichment → Update Check. States: pending (gray), active (pulsing blue), done (green), error (red), updated (amber) | `renderTaskCard()` with `step2State`/`step3State` mapping | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Collapsible Summary | 📋 summary box with blue left border, truncated to 6em. Click to expand (400px). Auto-expands when panel is open. | `.task-summary` CSS with `max-height`, `.expanded` class toggle, `.task-card.active-panel .task-summary { max-height: none }` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Timestamps | "📥 Discovered: ..." and "🔄 Last updated: ..." below meta | `formatDateTime()` with abbreviated date format | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Freeze Mode | Neon cyan border + "❄️ Agent working..." badge during agent processing. All interactions disabled. | `frozenTasks` Set, `.frozen` CSS class, `freezeTask()`/`unfreezeTask()` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Active Panel | Green border when panel is open. Overrides all hover states including pink (has-content). | `.task-card.active-panel` + `:hover` + `.has-content` + `.has-content:hover` CSS rules | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Content Indicator | Pink border for tasks with conversation history | `.task-card.has-content` CSS class | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

### 4.4 Interaction Panel (Chat)

| Feature | What It Does | Implementation | Signal | Code-Based Finding | Plain-English Impact |
|---------|--------------|----------------| --- | --- | --- |
| Input Form (Top) | Text input + 📤 Send (agent) + 📝 Note (no agent) buttons. Positioned at top of panel. | `.panel-log-form` with `border-bottom`, `analyzeLog()` / `addNote()` handlers | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Agent Analysis | User types message → AI determines intent → shows result or search plan | `analyzeLog()` → `POST /api/tasks/:id/log/analyze` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Plan Display | Shows agent's understanding + search parameters (keywords, time window, targets, sender). Execute ✅ / Cancel ✕ buttons. | `showPlanUI()`, `.log-plan` container | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Clarification | Agent asks follow-up question when intent is unclear. User answers in separate input. | `submitClarification()`, `.log-clarification` container | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Search Execution | Executes search plan via Work IQ. Shows 4-step progress: 📤 Sending → ⏳ Waiting → 📥 Receiving → ✅ Done. | `executeLog()` → `POST /api/tasks/:id/log`, progress via `setTimeout` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Conversation History | Reverse-chronological display (newest first). User messages (📤), agent responses (🤖/📋/💬/✅), communications (📧/💬). | `renderConversations()` with `[...conversations].reverse()` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Collapsible Messages | Long messages (>120 chars) can be collapsed/expanded with ▼ toggle arrow | `toggleCollapse()`, `collapsedEntries` Set, `saveUIState()` to localStorage | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Markdown Rendering | Agent responses rendered with headers, bold, italic, code, lists, paragraphs | `renderMarkdown()` — lightweight regex-based converter | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Delete Entries | 🗑️ button on each conversation entry. Only `update`, `note`, `review-response` types deletable. | `deleteHistoryEntry()` → `DELETE /api/tasks/:id/history/:index` | 🟡 | UI exposes delete buttons for entries that include `review-response`, but backend blocks that type with HTTP 403. | The interface offers an action that can fail unexpectedly for users. |
| Notes | Save text note without agent interaction | `addNote()` → `POST /api/tasks/:id/note` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

### 4.5 Ambiguity Review System

| Feature | What It Does | Implementation | Signal | Code-Based Finding | Plain-English Impact |
|---------|--------------|----------------| --- | --- | --- |
| Slim Indicator | One-line warning in task-main card: "⚠️ X review items — click to respond" (amber) or "✅ All resolved" (green). Clicking opens panel. | `ambiguityIndicator` variable, inline `onclick="toggleTaskPanel()"` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Full Review Panel | Interactive panel in chat area (after input, before conversations). Shows all review items with respond input. | `ambiguityHtml` rendered inside `.task-panel`, `.ambiguity-panel` CSS | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Open Items | Amber/yellow styling, listed first in panel | `.ambiguity-panel` with `border-left: #f59e0b`, items without `.resolved` class | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Resolved Items | Strikethrough + dimmed text, ✅ list marker, listed after open items | `.ambiguity-panel li.resolved` CSS with `text-decoration: line-through`, `::marker { content: '✅ ' }` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| All-Resolved State | Green border, green background, respond input hidden | `.ambiguity-panel.all-resolved` CSS, `.all-resolved .ambiguity-response-form { display: none }` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Respond | User types clarification → agent evaluates which questions are answered → updates summary if warranted → marks items resolved or reformulates remaining questions | `respondToReview()` → `POST /api/tasks/:id/review`, `CopilotClient` AI reasoning | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Grouping | Open items displayed first, resolved items after | `[...openItems, ...resolvedItems]` sort in `ambiguityHtml` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Backward Compatibility | Old `string[]` format auto-converted to `{question, resolved}[]` objects | `normalizeAmbiguities()` helper, applied in rendering and server endpoints | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

### 4.6 Summary Management

| Feature | What It Does | Implementation | Signal | Code-Based Finding | Plain-English Impact |
|---------|--------------|----------------| --- | --- | --- |
| Initial Creation | Summary set to `null` on task creation. Populated during enrichment (Phase 2). | `POST /api/tasks` → `summary: null`, enrichment → `t.summary = result.summary` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| User Correction | When user says "summary is wrong" in chat → AI corrects → main `task.summary` overwritten | `/log/analyze` with `intent: 'summarize'` → `t.summary = String(result.result).trim()` | 🟡 | Summary overwrite happens only when AI intent is `summarize`; there is no deterministic safeguard against misclassification as `answer`. | A user asking for a correction may get a reply without updating the main summary. |
| Update Append | Phase 3 (update check) appends new information: `📌 Update: ...` | `t.summary = (t.summary || '') + '\n\n📌 Update: ' + updateSummary` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Review Update | When user clarifies ambiguity items and AI provides updated summary → overwritten | `/review` endpoint → `t.summary = String(result.updatedSummary).trim()` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Change Tracking | Every summary change logged in history with `type: 'summary-update'` and previous value | History entry: `✏️ Summary updated via user interaction/direct edit/review clarification\nPrevious: ...` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| PATCH Update | Summary can be directly updated via PATCH endpoint with history tracking | `allowedFields` includes `'summary'`, change logged before overwrite | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

### 4.7 Scan Progress UI

| Feature | What It Does | Implementation | Signal | Code-Based Finding | Plain-English Impact |
|---------|--------------|----------------| --- | --- | --- |
| Progress Banner | Non-blocking inline banner showing current phase, task count, and elapsed timer | `.scan-banner.visible` with `.spinner`, `.loading-text`, `.loading-timer` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Phase Labels | Button label changes per phase: "Scanning..." → "Enriching..." → "Checking updates..." | `triggerScan()` updates button `textContent` per phase | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Per-Task Progress | Banner shows "Phase 2: Enriching content (3/12)... ⏱ 02:15" with live counter | `setInterval` 1s timer, task index counter in banner text | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Freeze per Task | Each task gets frozen individually during its enrichment/update-check, unfrozen after | `freezeTask(taskId)` before, `unfreezeTask(taskId)` after each task processing | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Auto-Refresh | Individual task cards re-rendered after agent completes work (no full page reload) | `refreshSingleTask(taskId)` → `GET /api/tasks` → DOM update for single card | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Stuck Reset | On server startup, tasks stuck in `enriching`/`checking` status are reset to `pending` | Server startup IIFE in `server.js` lines ~1674–1691 | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

### 4.8 Link Handling

| Feature | What It Does | Implementation | Signal | Code-Based Finding | Plain-English Impact |
|---------|--------------|----------------| --- | --- | --- |
| 4 Open Modes | Window (new window), Tab (new tab), Split (50/50 iframe), Incognito (private window) | `setLinkMode()`, `openLink()`, localStorage `linkMode` | 🔴 | Incognito mode cannot be programmatically forced by browsers. Code opens a normal window and explicitly states this limitation (index.html:2023-2025). | This mode does not deliver true private browsing as described. |
| Split View | Opens link in 50/50 split panel alongside Agent Zero. Header shows URL + close + pop-out buttons. | `.split-panel` with `<iframe>`, `closeSplitPanel()`, `openSplitInWindow()` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| CSP Handling | Detects domains that block iframe embedding (Outlook, Teams, GitHub, SharePoint, etc.) and falls back to window mode | `openLink()` checks URL against blocked domain list | 🟡 | CSP handling is a static domain blocklist, not real runtime CSP detection. Non-listed blocked sites can still fail in split view. | Some links may open as blank/blocked in split view even though users expect automatic fallback. |
| Source Links | "Open source ↗" links on task cards for original email/Teams message | `task.link` rendered as `<a>` with `onclick="return openLink(event)"` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

### 4.9 Notification System

| Feature | What It Does | Implementation | Signal | Code-Based Finding | Plain-English Impact |
|---------|--------------|----------------| --- | --- | --- |
| Toast Notifications | Top-right corner, auto-dismiss after 5s. Success (green border) or Error (red border). Close button. | `showNotification(message, type)`, `.notification` CSS with fixed positioning | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Deduplication | Previous notification removed before showing new one | `document.querySelectorAll('.notification').forEach(n => n.remove())` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

### 4.10 UI State Persistence

| Feature | What It Does | Implementation | Signal | Code-Based Finding | Plain-English Impact |
|---------|--------------|----------------| --- | --- | --- |
| Open Panels | Which task panels are expanded survives page refresh | `openPanelTaskIds` Set → localStorage `openPanels` JSON array | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Collapsed Threads | Which conversation threads are collapsed survives page refresh | `collapsedEntries` Set → localStorage `collapsedEntries` JSON array | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Scan Days | Default scan period slider value persists | localStorage `scanDays` (1–7) | 🟡 | Document says scan-day range is 1-7, but UI slider is configured for 1-14 (index.html:653). | Users can choose values outside the documented range, causing expectation mismatch. |
| Link Mode | Preferred link open mode persists | localStorage `linkMode` (window/tab/split/incognito) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

---

## 5. Data Schema (tasks.json)

| Field | Type | Set By | Description | Signal | Code-Based Finding | Plain-English Impact |
|-------|------|--------|-------------| --- | --- | --- |
| `id` | string (UUID) | Creation | Unique task identifier | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `title` | string | Scan / Manual | Task subject line | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `summary` | string \| null | Enrichment / User / Update Check | Detailed content summary | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `source` | string | Scan / Manual | `'email'`, `'teams'`, or `'manual'` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `from` | string \| null | Scan | Sender name or identifier | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `date` | string \| null | Scan | Original message date | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `link` | string \| null | Scan | URL to original message | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `status` | string | User / Scan | `'new'`, `'needs-attention'`, `'escalated'`, `'in-progress'`, `'paused'`, `'done'` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `notes` | string | User | Free-text notes | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `history` | array | System | Array of history entries (see below) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `doneAt` | string \| null | Status change | ISO timestamp when marked done | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `enrichmentStatus` | string | Pipeline | `'pending'`, `'enriching'`, `'enriched'`, `'needs-review'`, `'error'`, `'n/a'` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `updateCheckStatus` | string | Pipeline | `'pending'`, `'checking'`, `'checked'`, `'updated'`, `'error'` | 🟡 | Documented enum is incomplete: manual tasks use `updateCheckStatus: 'n/a'` (server.js:314). | Data exports or integrations based on this schema may mis-handle valid values. |
| `enrichedAt` | string \| null | Enrichment | ISO timestamp of enrichment completion | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `lastUpdateCheck` | string \| null | Update Check | ISO timestamp of last update check | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `ambiguities` | array | Enrichment / Review | `{question: string, resolved: boolean, resolvedAt?: string}[]` | 🟡 | Schema is not strictly object-array only; code supports legacy `string[]` via `normalizeAmbiguities()`. | Consumers should expect mixed legacy/new formats, not only one strict structure. |
| `createdAt` | string | Creation | ISO timestamp | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `updatedAt` | string | Any change | ISO timestamp | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

### History Entry Types

| Type | Created By | Contains | Signal | Code-Based Finding | Plain-English Impact |
|------|-----------|----------| --- | --- | --- |
| `created` | Task creation | Creation source text | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `status-change` | PATCH status | "Status changed: old → new" | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `scan-update` | Re-scan | Changed fields list | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `enriched` | Phase 2 | Duration, keywords, source, confidence, language, summary | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `enrich-error` | Phase 2 failure | Error details, duration, keywords | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `thread-update` | Phase 3 (update found) | Search keywords, since date, new message count, update text | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `update-check` | Phase 3 (no update) | Search keywords, duration, last checked date | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `update-check-error` | Phase 3 failure | Error details | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `summary-update` | User correction / Review | Previous summary text, change source | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `review-response` | Ambiguity review | User's response text, agent evaluation (resolved count) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `update` | Chat interaction | User text, agentPlan (intent, understanding), communications, agentResponse, agentExecution | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `note` | Quick note | User text only | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

---

## 6. Helper Functions

| Function | Location | What It Does | Signal | Code-Based Finding | Plain-English Impact |
|----------|----------|--------------| --- | --- | --- |
| `readTasks()` | server.js | Reads and parses `tasks.json` synchronously | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `writeTasks(data)` | server.js | Writes `tasks.json` synchronously with 2-space indent | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `safeWriteTasks(mutationFn)` | server.js | Promise-based write queue ensuring sequential file writes under concurrent requests | 🟡 | Write queue is sequential but lacks chain recovery after rejection; one failed write can leave future queued writes rejected. | After a write failure, users may see repeated save failures until restart/fix. |
| `normalizeForCompare(title)` | server.js | Lowercase, strip non-alphanumeric, collapse whitespace for dedup comparison | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `isSimilarTitle(a, b)` | server.js | Jaccard set similarity >0.7 threshold between word sets | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `normalizeAmbiguities(arr)` | server.js | Converts old `string[]` to `{question, resolved}[]` format | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `extractKeywords(title)` | server.js | Splits title into words, removes stop words (EN), returns distinctive terms | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `runWorkIQAsk(question, timeout)` | server.js | Spawns `workiq ask` child process, sends question via stdin, collects stdout, enforces timeout | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `buildSearchQuestion(plan, ctx, text)` | server.js | Constructs rich Work IQ search prompt from plan parameters (targets, keywords, time window, sender) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `parseJsonFromResponse(text)` | server.js | Extracts JSON from AI response: direct parse → markdown code block → array extraction | 🟡 | Parser handles direct JSON, code blocks, and embedded arrays; embedded JSON objects in free text are not reliably extracted. | Some AI responses may be treated as invalid even when they include usable JSON object data. |
| `parseMarkdownEmails(text)` | server.js | Parses Work IQ Markdown response into structured email objects (From, Subject, Date, To, Link) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `migrateTasks()` | server.js | v1→v2 schema migration: adds `history[]`, manages `doneAt` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `migrateStatuses()` | server.js | v1.5: converts `'active'` status to `'new'` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `migrateToV3()` | server.js | v2→v3: adds enrichment/update-check pipeline fields | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `escHtml(str)` | index.html | XSS protection via `textContent`→`innerHTML` conversion | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `formatDate(iso)` | index.html | Formats ISO string to `de-CH` locale (dd.mm.yyyy HH:MM) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `formatDateTime(iso)` | index.html | Formats ISO string to abbreviated format (Jan 15, 14:30) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `renderMarkdown(text)` | index.html | Lightweight Markdown → HTML converter (headers, bold, italic, code, lists) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `previewText(text, maxLen)` | index.html | Extracts first line, strips formatting, truncates with "…" | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `freezeTask(id)` / `unfreezeTask(id)` | index.html | Adds/removes task from frozen set, toggles `.frozen` CSS class | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `refreshSingleTask(id)` | index.html | Re-fetches and re-renders single task card without full page reload | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `updateStepIndicator(id, step, state)` | index.html | Updates pipeline phase dot state (pending/active/done/error/updated) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `updateTaskSummaryInCard(id, summary)` | index.html | Dynamically inserts or updates summary element in task card DOM | 🟡 | `updateTaskSummaryInCard()` exists but is not called anywhere in the current frontend code path. | This function currently provides no user-facing value and may confuse maintenance work. |

---

## 7. Skill Files (AI Prompt Templates)

| File | Used By | Purpose | Signal | Code-Based Finding | Plain-English Impact |
|------|---------|---------| --- | --- | --- |
| `SCAN_DISCOVERY_SKILL.md` | `/api/scan` | Instructs AI how to scan M365 for action items, what fields to extract, dedup rules | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `SCAN_SKILL.md` | `/api/scan` (fallback) | Fallback scan prompt if discovery skill not found | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `ENRICH_SKILL.md` | `/api/tasks/:id/enrich` | Instructs AI how to extract thread content, generate summaries, detect ambiguities, 3-attempt keyword search | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `UPDATE_CHECK_SKILL.md` | `/api/tasks/:id/check-update` | Instructs AI how to check for new messages since last check, keyword extraction, temporal anchoring | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `LOG_WORK_SKILL.md` | `/api/tasks/:id/log` (fallback) | Fallback prompt for log work search when no plan provided | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

---

## 8. External Dependencies

| Dependency | Version | Purpose | Signal | Code-Based Finding | Plain-English Impact |
|------------|---------|---------| --- | --- | --- |
| `express` | ^5.2.1 | HTTP server framework | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `uuid` | ^13.0.0 | Task ID generation (v4 UUIDs) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `@github/copilot-sdk` | ^0.1.25 | AI reasoning sessions (with and without MCP servers) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| `@microsoft/workiq` | ^0.2.8 | Microsoft 365 data access via MCP (emails, Teams, meetings) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |

---

## 9. Startup & Infrastructure

| Component | Details | Signal | Code-Based Finding | Plain-English Impact |
|-----------|---------| --- | --- | --- |
| Server | Express.js on `http://localhost:3000` | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Data Storage | `tasks.json` — local JSON file, synchronized via write queue | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Launcher | `START-DAILY-BRIEFING.bat` — checks port 3000, starts server minimized, polls until ready, opens browser | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Migrations | 3 sequential migrations on startup: v1→v2 (history), active→new (status), v2→v3 (pipeline fields) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Stuck Reset | On startup: resets `enriching` → `pending`, `checking` → `pending` (recovers from crashed scans) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
| Git Ignored | `node_modules/`, `package-lock.json`, `tasks.json` (personal data) | 🟢 | No contradiction found in the current implementation. | This appears to work as described for normal use. |
