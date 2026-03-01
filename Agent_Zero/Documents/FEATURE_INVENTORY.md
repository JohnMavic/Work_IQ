# Agent Zero — Complete Feature & Function Inventory

> Auto-generated from source code analysis of `server.js` and `index.html`.
> This document describes every feature, function, and service the application provides, derived 100% from the codebase — not from specification or architecture documents.

---

## 1. API Endpoints (Backend Services)

| # | HTTP Method | Path | What It Does | Technologies Used |
|---|-------------|------|--------------|-------------------|
| 1 | `GET` | `/` | Serves the single-page HTML frontend (`index.html`) | Express.js static file serving via `res.sendFile()` |
| 2 | `GET` | `/api/tasks` | Returns all tasks from persistent storage as JSON array | `fs.readFileSync()` → `tasks.json` → `JSON.parse()` |
| 3 | `POST` | `/api/tasks` | Creates a new manual task with title, optional notes. Generates UUID, sets `status: 'new'`, `source: 'manual'`, `enrichmentStatus: 'n/a'`. Adds `created` history entry. | `uuid.v4()`, `safeWriteTasks()` write queue, `tasks.json` |
| 4 | `PATCH` | `/api/tasks/:id` | Updates task fields. Allowed: `status`, `notes`, `title`, `summary`, `enrichmentStatus`, `updateCheckStatus`. Validates status against whitelist. Logs status changes and summary changes in history. Manages `doneAt` timestamp. | `safeWriteTasks()` write queue, status validation (`new`, `needs-attention`, `escalated`, `in-progress`, `done`, `paused`) |
| 5 | `DELETE` | `/api/tasks/:id` | Permanently removes a task by ID from storage. | `safeWriteTasks()` with `data.tasks.filter()` |
| 6 | `DELETE` | `/api/tasks/:id/history/:index` | Deletes a single history entry by array index. Protects system entries — only allows deletion of `update`, `note`, and `review-response` types. | `safeWriteTasks()`, type whitelist check |
| 7 | `POST` | `/api/tasks/:id/note` | Adds a quick text note to task history without any agent interaction. Creates history entry with `type: 'note'`. | `safeWriteTasks()`, no AI involved |
| 8 | `POST` | `/api/scan` | **Phase 1 — Discovery.** Scans Microsoft 365 emails and Teams messages for new action items. Uses AI to identify subjects requiring attention. Deduplicates against existing tasks using Jaccard title similarity (>0.7) and exact link matching. Creates new tasks with `enrichmentStatus: 'pending'`. Can also update existing tasks if AI returns matching items with changes. | `CopilotClient` → Copilot SDK session with Work IQ MCP server (`stdio`, `workiq mcp`), `SCAN_DISCOVERY_SKILL.md` prompt, `isSimilarTitle()` Jaccard dedup, `normalizeForCompare()`, scan days parameter (1–14), 180s timeout |
| 9 | `POST` | `/api/tasks/:id/enrich` | **Phase 2 — Enrichment.** Extracts detailed content from the original email/Teams thread. Generates a structured summary with confidence level and language detection. Detects ambiguities where the agent is unsure. Skips tasks already enriched or in needs-review state. | `CopilotClient` + Work IQ MCP, `ENRICH_SKILL.md` prompt, `extractKeywords()` for search terms, `normalizeAmbiguities()`, 300s timeout, keyword-based search (not exact-subject) |
| 10 | `POST` | `/api/tasks/:id/check-update` | **Phase 3 — Update Check.** Checks if new messages have appeared in the thread since the last check. Runs on EVERY scan (not just once like enrichment). Appends update summary to existing task summary. Status is overwritten per task during processing (no pre-reset needed — frontend filters by `enrichmentStatus`, not `updateCheckStatus`). | `CopilotClient` + Work IQ MCP, `UPDATE_CHECK_SKILL.md` prompt, `extractKeywords()`, temporal anchor (`lastUpdateCheck` or `enrichedAt`), 300s timeout |
| 11 | `POST` | `/api/tasks/:id/log/analyze` | **Log Work Phase 1 — Intent Analysis.** AI analyzes user's free-text message to determine intent: `summarize` (create/update summary), `search` (find communications), or `answer` (respond from context). For `summarize` intent: overwrites `task.summary` and logs change. For `search`: returns executable plan. No Work IQ needed — pure AI reasoning. | `CopilotClient` with empty session (no MCP), 30s timeout, `parseJsonFromResponse()`, intent-based routing, summary overwrite with `summary-update` history entry |
| 12 | `POST` | `/api/tasks/:id/log` | **Log Work Phase 2 — Search Execution.** Executes the search plan from Phase 1. Two search methods: (a) `workiq-ask` via CLI subprocess when plan is provided, (b) Copilot SDK + Work IQ MCP as fallback. Parses structured communications (emails/Teams) from response. Stores full execution trace (prompt sent, raw response, parsed count, duration). | `runWorkIQAsk()` CLI spawn (`workiq ask` stdin/stdout), `buildSearchQuestion()` prompt builder, `CopilotClient` + Work IQ MCP fallback, `parseJsonFromResponse()`, `parseMarkdownEmails()` Markdown parser, `LOG_WORK_SKILL.md` prompt |
| 13 | `POST` | `/api/tasks/:id/review` | **Ambiguity Resolution.** User responds to the agent's review questions. AI evaluates which questions are sufficiently answered, provides updated summary if clarifications warrant it, and formulates remaining questions if any are still open. Marks resolved items with timestamp. Changes `enrichmentStatus` to `'enriched'` when all items resolved. | `CopilotClient` with empty session (no MCP), `normalizeAmbiguities()`, per-item resolution tracking (`resolved`, `resolvedAt`), `summary-update` history entry, 30s timeout |

---

## 2. Three-Phase Scan Pipeline

| Phase | Name | Trigger | What Happens | Timeout | Runs |
|-------|------|---------|--------------|---------|------|
| 1 | Discovery | User clicks "Scan Emails & Teams" | AI scans M365 via Work IQ for new action items. Creates tasks with `summary: null`, `enrichmentStatus: 'pending'`. Deduplicates against all non-deleted tasks. | 180s | Once per scan |
| 2 | Enrichment | Automatic after Phase 1 | For each task with `enrichmentStatus: 'pending'`: extracts thread content, generates summary, detects ambiguities. Sets status to `'enriched'` or `'needs-review'`. | 300s per task | Once per task (skips if already enriched) |
| 3 | Update Check | Automatic after Phase 2 | For each task with `enrichmentStatus: 'enriched'` or `'needs-review'` (non-done): checks for new messages since last check. Appends updates to summary. | 300s per task | Every scan cycle (`updateCheckStatus` overwritten per task, no global reset) |

---

## 3. Two-Phase Log Work System

| Phase | Name | Endpoint | What Happens | AI Configuration |
|-------|------|----------|--------------|------------------|
| 1 | Intent Analysis | `/api/tasks/:id/log/analyze` | AI determines user intent: `summarize`, `search`, or `answer`. For summarize/answer: returns result immediately and saves to history. For search: returns executable plan with keywords, time window, search targets. | Copilot SDK only (no MCP) — fast reasoning |
| 2 | Search Execution | `/api/tasks/:id/log` | Executes the search plan. Primary method: `workiq ask` CLI subprocess. Fallback: Copilot SDK + Work IQ MCP session. Parses emails/Teams messages from response. | Work IQ CLI or Copilot SDK + Work IQ MCP |

---

## 4. Frontend Features & UI Components

### 4.1 Server Health Monitoring

| Feature | What It Does | Implementation |
|---------|--------------|----------------|
| Health Check | Polls `/api/tasks` with 3s abort timeout on page load | `checkServerHealth()` with `AbortController`, `fetch()` |
| Status Dot | Green (online) / Red (offline) indicator in header, 12px circle | `.server-dot` CSS class, toggled by `setServerStatus()` |
| Architecture Tooltip | CSS-only hover tooltip on status dot showing tech stack (Express, Copilot SDK, Work IQ, tasks.json) | `.server-tooltip` with `::after` pseudo-element |
| Offline Banner | Amber banner with startup instructions (BAT + manual command) when server unreachable | `.server-offline-banner`, shown/hidden by `setServerStatus()` |
| Auto-Reconnect | Polls every 5s when offline; shows "✅ Server connected" notification on reconnect | `setInterval(checkServerHealth, 5000)`, cleared on reconnect |
| Button Protection | Scan and Add Task buttons disabled when offline | `btn.disabled = !serverOnline` in `setServerStatus()` |

### 4.2 Task Management

| Feature | What It Does | Implementation |
|---------|--------------|----------------|
| Create Task | Manual task creation with title (required) + notes (optional) | `addTask()` → `POST /api/tasks`, HTML form with `onsubmit` |
| Status Management | 6 statuses: Needs Attention, New, Escalated, In Progress, Paused, Done | `<select>` dropdown → `updateTask()` → `PATCH /api/tasks/:id` |
| Delete Task | Permanent deletion with immediate UI removal | `deleteTask()` → `DELETE /api/tasks/:id` |
| Filter by Status | 7 filter buttons (All + 6 statuses) with live count badges | `setFilter()` → `renderTasks()` with `currentFilter` state |
| Sort Order | Status priority (needs-attention > new > escalated > in-progress > paused > done), then `createdAt` descending | `renderTasks()` with `statusOrder` map + date sort |
| Auto-Hide Done | Tasks marked done >3 days ago are hidden from default view (still visible in "Done" filter) | `renderTasks()` filters `doneAt` older than 3 days |
| Task Count | Badge showing filtered task count in filter bar | `updateTaskCount()` after every render |

### 4.3 Task Card Display

| Feature | What It Does | Implementation |
|---------|--------------|----------------|
| Source Badge | Color-coded badge: 📧 Email (blue), 💬 Teams (purple), 📝 Manual (gray) | `.badge-email`, `.badge-teams`, `.badge-manual` CSS classes |
| Step Indicators | 3 dots showing pipeline progress: Discovery → Enrichment → Update Check. States: pending (gray), active (pulsing blue), done (green), error (red), updated (amber) | `renderTaskCard()` with `step2State`/`step3State` mapping |
| Collapsible Summary | 📋 summary box with blue left border, truncated to 6em. Click to expand (400px). Auto-expands when panel is open. | `.task-summary` CSS with `max-height`, `.expanded` class toggle, `.task-card.active-panel .task-summary { max-height: none }` |
| Timestamps | "📥 Discovered: ..." and "🔄 Last updated: ..." below meta | `formatDateTime()` with abbreviated date format |
| Freeze Mode | Neon cyan border + "❄️ Agent working..." badge during agent processing. All interactions disabled. | `frozenTasks` Set, `.frozen` CSS class, `freezeTask()`/`unfreezeTask()` |
| Active Panel | Green border when panel is open. Overrides all hover states including pink (has-content). | `.task-card.active-panel` + `:hover` + `.has-content` + `.has-content:hover` CSS rules |
| Content Indicator | Pink border for tasks with conversation history | `.task-card.has-content` CSS class |

### 4.4 Interaction Panel (Chat)

| Feature | What It Does | Implementation |
|---------|--------------|----------------|
| Input Form (Top) | Text input + 📤 Send (agent) + 📝 Note (no agent) buttons. Positioned at top of panel. | `.panel-log-form` with `border-bottom`, `analyzeLog()` / `addNote()` handlers |
| Agent Analysis | User types message → AI determines intent → shows result or search plan | `analyzeLog()` → `POST /api/tasks/:id/log/analyze` |
| Plan Display | Shows agent's understanding + search parameters (keywords, time window, targets, sender). Execute ✅ / Cancel ✕ buttons. | `showPlanUI()`, `.log-plan` container |
| Clarification | Agent asks follow-up question when intent is unclear. User answers in separate input. | `submitClarification()`, `.log-clarification` container |
| Search Execution | Executes search plan via Work IQ. Shows 4-step progress: 📤 Sending → ⏳ Waiting → 📥 Receiving → ✅ Done. | `executeLog()` → `POST /api/tasks/:id/log`, progress via `setTimeout` |
| Conversation History | Reverse-chronological display (newest first). User messages (📤), agent responses (🤖/📋/💬/✅), communications (📧/💬). | `renderConversations()` with `[...conversations].reverse()` |
| Collapsible Messages | Long messages (>120 chars) can be collapsed/expanded with ▼ toggle arrow | `toggleCollapse()`, `collapsedEntries` Set, `saveUIState()` to localStorage |
| Markdown Rendering | Agent responses rendered with headers, bold, italic, code, lists, paragraphs | `renderMarkdown()` — lightweight regex-based converter |
| Delete Entries | 🗑️ button on each conversation entry. Only `update`, `note`, `review-response` types deletable. | `deleteHistoryEntry()` → `DELETE /api/tasks/:id/history/:index` |
| Notes | Save text note without agent interaction | `addNote()` → `POST /api/tasks/:id/note` |

### 4.5 Ambiguity Review System

| Feature | What It Does | Implementation |
|---------|--------------|----------------|
| Slim Indicator | One-line warning in task-main card: "⚠️ X review items — click to respond" (amber) or "✅ All resolved" (green). Clicking opens panel. | `ambiguityIndicator` variable, inline `onclick="toggleTaskPanel()"` |
| Full Review Panel | Interactive panel in chat area (after input, before conversations). Shows all review items with respond input. | `ambiguityHtml` rendered inside `.task-panel`, `.ambiguity-panel` CSS |
| Open Items | Amber/yellow styling, listed first in panel | `.ambiguity-panel` with `border-left: #f59e0b`, items without `.resolved` class |
| Resolved Items | Strikethrough + dimmed text, ✅ list marker, listed after open items | `.ambiguity-panel li.resolved` CSS with `text-decoration: line-through`, `::marker { content: '✅ ' }` |
| All-Resolved State | Green border, green background, respond input hidden | `.ambiguity-panel.all-resolved` CSS, `.all-resolved .ambiguity-response-form { display: none }` |
| Respond | User types clarification → agent evaluates which questions are answered → updates summary if warranted → marks items resolved or reformulates remaining questions | `respondToReview()` → `POST /api/tasks/:id/review`, `CopilotClient` AI reasoning |
| Grouping | Open items displayed first, resolved items after | `[...openItems, ...resolvedItems]` sort in `ambiguityHtml` |
| Backward Compatibility | Old `string[]` format auto-converted to `{question, resolved}[]` objects | `normalizeAmbiguities()` helper, applied in rendering and server endpoints |

### 4.6 Summary Management

| Feature | What It Does | Implementation |
|---------|--------------|----------------|
| Initial Creation | Summary set to `null` on task creation. Populated during enrichment (Phase 2). | `POST /api/tasks` → `summary: null`, enrichment → `t.summary = result.summary` |
| User Correction | When user says "summary is wrong" in chat → AI corrects → main `task.summary` overwritten | `/log/analyze` with `intent: 'summarize'` → `t.summary = String(result.result).trim()` |
| Update Append | Phase 3 (update check) appends new information: `📌 Update: ...` | `t.summary = (t.summary || '') + '\n\n📌 Update: ' + updateSummary` |
| Review Update | When user clarifies ambiguity items and AI provides updated summary → overwritten | `/review` endpoint → `t.summary = String(result.updatedSummary).trim()` |
| Change Tracking | Every summary change logged in history with `type: 'summary-update'` and previous value | History entry: `✏️ Summary updated via user interaction/direct edit/review clarification\nPrevious: ...` |
| PATCH Update | Summary can be directly updated via PATCH endpoint with history tracking | `allowedFields` includes `'summary'`, change logged before overwrite |

### 4.7 Scan Progress UI

| Feature | What It Does | Implementation |
|---------|--------------|----------------|
| Progress Banner | Non-blocking inline banner showing current phase, task count, and elapsed timer | `.scan-banner.visible` with `.spinner`, `.loading-text`, `.loading-timer` |
| Phase Labels | Button label changes per phase: "Scanning..." → "Enriching..." → "Checking updates..." | `triggerScan()` updates button `textContent` per phase |
| Per-Task Progress | Banner shows "Phase 2: Enriching content (3/12)... ⏱ 02:15" with live counter | `setInterval` 1s timer, task index counter in banner text |
| Freeze per Task | Each task gets frozen individually during its enrichment/update-check, unfrozen after | `freezeTask(taskId)` before, `unfreezeTask(taskId)` after each task processing |
| Auto-Refresh | Individual task cards re-rendered after agent completes work (no full page reload) | `refreshSingleTask(taskId)` → `GET /api/tasks` → DOM update for single card |
| Stuck Reset | On server startup, tasks stuck in `enriching`/`checking` status are reset to `pending` | Server startup IIFE in `server.js` lines ~1674–1691 |

### 4.8 Link Handling

| Feature | What It Does | Implementation |
|---------|--------------|----------------|
| 2 Open Modes | Window (new window), Tab (new tab) | `setLinkMode()`, `openLink()`, localStorage `linkMode` |
| Source Links | "Open source ↗" links on task cards for original email/Teams message | `task.link` rendered as `<a>` with `onclick="return openLink(event)"` |

### 4.9 Notification System

| Feature | What It Does | Implementation |
|---------|--------------|----------------|
| Toast Notifications | Top-right corner, auto-dismiss after 5s. Success (green border) or Error (red border). Close button. | `showNotification(message, type)`, `.notification` CSS with fixed positioning |
| Deduplication | Previous notification removed before showing new one | `document.querySelectorAll('.notification').forEach(n => n.remove())` |

### 4.10 UI State Persistence

| Feature | What It Does | Implementation |
|---------|--------------|----------------|
| Open Panels | Which task panels are expanded survives page refresh | `openPanelTaskIds` Set → localStorage `openPanels` JSON array |
| Collapsed Threads | Which conversation threads are collapsed survives page refresh | `collapsedEntries` Set → localStorage `collapsedEntries` JSON array |
| Scan Days | Default scan period slider value persists | localStorage `scanDays` (1–14) |
| Link Mode | Preferred link open mode persists | localStorage `linkMode` (window/tab) |

---

## 5. Data Schema (tasks.json)

| Field | Type | Set By | Description |
|-------|------|--------|-------------|
| `id` | string (UUID) | Creation | Unique task identifier |
| `title` | string | Scan / Manual | Task subject line |
| `summary` | string \| null | Enrichment / User / Update Check | Detailed content summary |
| `source` | string | Scan / Manual | `'email'`, `'teams'`, or `'manual'` |
| `from` | string \| null | Scan | Sender name or identifier |
| `date` | string \| null | Scan | Original message date |
| `link` | string \| null | Scan | URL to original message |
| `status` | string | User / Scan | `'new'`, `'needs-attention'`, `'escalated'`, `'in-progress'`, `'paused'`, `'done'` |
| `notes` | string | User | Free-text notes |
| `history` | array | System | Array of history entries (see below) |
| `doneAt` | string \| null | Status change | ISO timestamp when marked done |
| `enrichmentStatus` | string | Pipeline | `'pending'`, `'enriching'`, `'enriched'`, `'needs-review'`, `'error'`, `'n/a'` |
| `updateCheckStatus` | string | Pipeline | `'pending'`, `'checking'`, `'checked'`, `'updated'`, `'error'` |
| `enrichedAt` | string \| null | Enrichment | ISO timestamp of enrichment completion |
| `lastUpdateCheck` | string \| null | Update Check | ISO timestamp of last update check |
| `ambiguities` | array | Enrichment / Review | `{question: string, resolved: boolean, resolvedAt?: string}[]` — legacy `string[]` format is auto-converted via `normalizeAmbiguities()` |
| `createdAt` | string | Creation | ISO timestamp |
| `updatedAt` | string | Any change | ISO timestamp |

### History Entry Types

| Type | Created By | Contains |
|------|-----------|----------|
| `created` | Task creation | Creation source text |
| `status-change` | PATCH status | "Status changed: old → new" |
| `scan-update` | Re-scan | Changed fields list |
| `enriched` | Phase 2 | Duration, keywords, source, confidence, language, summary |
| `enrich-error` | Phase 2 failure | Error details, duration, keywords |
| `thread-update` | Phase 3 (update found) | Search keywords, since date, new message count, update text |
| `update-check` | Phase 3 (no update) | Search keywords, duration, last checked date |
| `update-check-error` | Phase 3 failure | Error details |
| `summary-update` | User correction / Review | Previous summary text, change source |
| `review-response` | Ambiguity review | User's response text, agent evaluation (resolved count) |
| `update` | Chat interaction | User text, agentPlan (intent, understanding), communications, agentResponse, agentExecution |
| `note` | Quick note | User text only |

---

## 6. Helper Functions

| Function | Location | What It Does |
|----------|----------|--------------|
| `readTasks()` | server.js | Reads and parses `tasks.json` synchronously |
| `writeTasks(data)` | server.js | Writes `tasks.json` synchronously with 2-space indent |
| `safeWriteTasks(mutationFn)` | server.js | Promise-based write queue ensuring sequential file writes under concurrent requests |
| `normalizeForCompare(title)` | server.js | Lowercase, strip non-alphanumeric, collapse whitespace for dedup comparison |
| `isSimilarTitle(a, b)` | server.js | Jaccard set similarity >0.7 threshold between word sets |
| `normalizeAmbiguities(arr)` | server.js | Converts old `string[]` to `{question, resolved}[]` format |
| `extractKeywords(title)` | server.js | Splits title into words, removes stop words (EN), returns distinctive terms |
| `runWorkIQAsk(question, timeout)` | server.js | Spawns `workiq ask` child process, sends question via stdin, collects stdout, enforces timeout |
| `buildSearchQuestion(plan, ctx, text)` | server.js | Constructs rich Work IQ search prompt from plan parameters (targets, keywords, time window, sender) |
| `parseJsonFromResponse(text)` | server.js | Extracts JSON from AI response: direct parse → markdown code block → array extraction |
| `parseMarkdownEmails(text)` | server.js | Parses Work IQ Markdown response into structured email objects (From, Subject, Date, To, Link) |
| `migrateTasks()` | server.js | v1→v2 schema migration: adds `history[]`, manages `doneAt` |
| `migrateStatuses()` | server.js | v1.5: converts `'active'` status to `'new'` |
| `migrateToV3()` | server.js | v2→v3: adds enrichment/update-check pipeline fields |
| `escHtml(str)` | index.html | XSS protection via `textContent`→`innerHTML` conversion |
| `formatDate(iso)` | index.html | Formats ISO string to `de-CH` locale (dd.mm.yyyy HH:MM) |
| `formatDateTime(iso)` | index.html | Formats ISO string to abbreviated format (Jan 15, 14:30) |
| `renderMarkdown(text)` | index.html | Lightweight Markdown → HTML converter (headers, bold, italic, code, lists) |
| `previewText(text, maxLen)` | index.html | Extracts first line, strips formatting, truncates with "…" |
| `freezeTask(id)` / `unfreezeTask(id)` | index.html | Adds/removes task from frozen set, toggles `.frozen` CSS class |
| `refreshSingleTask(id)` | index.html | Re-fetches and re-renders single task card without full page reload |
| `updateStepIndicator(id, step, state)` | index.html | Updates pipeline phase dot state (pending/active/done/error/updated) |
| `updateTaskSummaryInCard(id, summary)` | index.html | Dynamically inserts or updates summary element in task card DOM |

---

## 7. Skill Files (AI Prompt Templates)

| File | Used By | Purpose |
|------|---------|---------|
| `SCAN_DISCOVERY_SKILL.md` | `/api/scan` | Instructs AI how to scan M365 for action items, what fields to extract, dedup rules |
| `SCAN_SKILL.md` | `/api/scan` (fallback) | Fallback scan prompt if discovery skill not found |
| `ENRICH_SKILL.md` | `/api/tasks/:id/enrich` | Instructs AI how to extract thread content, generate summaries, detect ambiguities, 3-attempt keyword search |
| `UPDATE_CHECK_SKILL.md` | `/api/tasks/:id/check-update` | Instructs AI how to check for new messages since last check, keyword extraction, temporal anchoring |
| `LOG_WORK_SKILL.md` | `/api/tasks/:id/log` (fallback) | Fallback prompt for log work search when no plan provided |

---

## 8. External Dependencies

| Dependency | Version | Purpose |
|------------|---------|---------|
| `express` | ^5.2.1 | HTTP server framework |
| `uuid` | ^13.0.0 | Task ID generation (v4 UUIDs) |
| `@github/copilot-sdk` | ^0.1.25 | AI reasoning sessions (with and without MCP servers) |
| `@microsoft/workiq` | ^0.2.8 | Microsoft 365 data access via MCP (emails, Teams, meetings) |

---

## 9. Startup & Infrastructure

| Component | Details |
|-----------|---------|
| Server | Express.js on `http://localhost:3000` |
| Data Storage | `tasks.json` — local JSON file, synchronized via write queue |
| Launcher | `START-DAILY-BRIEFING.bat` — checks port 3000, starts server minimized, polls until ready, opens browser |
| Migrations | 3 sequential migrations on startup: v1→v2 (history), active→new (status), v2→v3 (pipeline fields) |
| Stuck Reset | On startup: resets `enriching` → `pending`, `checking` → `pending` (recovers from crashed scans) |
| Git Ignored | `node_modules/`, `package-lock.json`, `tasks.json` (personal data) |
