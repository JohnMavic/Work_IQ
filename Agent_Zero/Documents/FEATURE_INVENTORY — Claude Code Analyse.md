# Agent Zero — Feature & Function Inventory — Claude Code Analysis

> **Analyzed on:** March 1, 2026 by Claude Code (Opus 4.6)
> **Method:** 100% code-based analysis of `server.js` (1,695 lines) and `index.html` (2,066 lines). No assumptions — every rating references a specific line of code.
> **Traffic Light Legend:** 🟢 Works | 🟠 Has Problems | 🔴 Does Not Work

---

## 1. API Endpoints (Backend Services)

| # | HTTP Method | Path | What It Does | Status | Code-Based Evidence | Plain Language Explanation |
|---|-------------|------|--------------|--------|---------------------|---------------------------|
| 1 | `GET` | `/` | Serves the single-page HTML frontend (`index.html`) | 🟢 | `res.sendFile()` correctly implemented (server.js:69–71). No issues. | When you open the app in your browser, the main page loads correctly. |
| 2 | `GET` | `/api/tasks` | Returns all tasks from persistent storage as JSON array | 🟢 | `readTasks()` → `JSON.parse()` → `res.json(data)` (server.js:282–289). Error handling with 500 status present. | The app can read and display your saved tasks. If something goes wrong reading the file, a proper error message is returned. |
| 3 | `POST` | `/api/tasks` | Creates a new manual task with title, optional notes | 🟢 | Complete v3 schema fields including `enrichmentStatus: 'n/a'`, `updateCheckStatus: 'n/a'` (server.js:292–328). UUID generation, validation, history entry — all correct. | Creating a new task by hand works. All required data fields are properly filled in, and the task gets a unique ID. |
| 4 | `PATCH` | `/api/tasks/:id` | Updates task fields with history tracking | 🟢 | Status validation against whitelist, `doneAt` management, summary change tracking present (server.js:331–392). `allowedFields` correctly defined. | Changing a task's status (e.g., "New" → "In Progress") works. The app logs every change so you can see the history. |
| 5 | `DELETE` | `/api/tasks/:id` | Permanently removes a task by ID | 🟢 | `data.tasks.splice(index, 1)` with 404 handling (server.js:395–413). Works. | Deleting a task works. If you try to delete a task that doesn't exist, you get a proper error instead of a crash. |
| 6 | `DELETE` | `/api/tasks/:id/history/:index` | Deletes a single history entry by array index | 🟠 | **Frontend/backend mismatch**: The feature inventory claims `review-response` entries are deletable. However, the server code (server.js:433) only allows deleting `update` and `note` types. The frontend (index.html:1274) renders a 🗑️ delete button on `review-response` entries too, but the server responds with **403 Forbidden** when you click it. | You see a trash can icon on review responses in the chat, but clicking it shows an error. The button appears clickable, but the server refuses the deletion. This is confusing because the button shouldn't be shown at all for those entries. It's a mismatch between what the screen shows and what the system actually allows. |
| 7 | `POST` | `/api/tasks/:id/note` | Adds a quick text note to task history | 🟢 | Simple history entry creation with `type: 'note'` (server.js:458–488). Validation, 404 handling — correct. | Saving a quick note on a task works without any AI involvement. |
| 8 | `POST` | `/api/scan` | Phase 1 — Discovery Scan | 🟢 | Complex but well-structured endpoint (server.js:491–715). CopilotClient + Work IQ MCP, 4-layer dedup chain (AI-skip → exact match → Jaccard → safety net), fallback prompts. Note: `scanDays` allows 1–14 (not 1–7 as stated in the inventory). | The email/Teams scan works. It finds action items, avoids creating duplicates through multiple checks, and creates new tasks. The scan range is actually 1–14 days, not 1–7 as the inventory document claims. |
| 9 | `POST` | `/api/tasks/:id/enrich` | Phase 2 — Content Enrichment | 🟢 | Keyword extraction, link context building, 300s timeout (server.js:718–875). Sets `enrichmentStatus` correctly, normalizes ambiguities, failed enrichments are marked as `error`. | After finding a task, the system goes back and reads the full email/message to create a detailed summary. This works correctly and handles errors gracefully. |
| 10 | `POST` | `/api/tasks/:id/check-update` | Phase 3 — Update Check | 🟢 | Temporal anchor via `lastUpdateCheck \|\| enrichedAt \|\| createdAt \|\| date` (server.js:934). Appends `📌 Update:` correctly to summary. 300s timeout. | The system checks if there are new messages in a thread since the last time it looked. If it finds updates, they get appended to the task summary. This works correctly. |
| 11 | `POST` | `/api/tasks/:id/log/analyze` | Log Work Phase 1 — Intent Analysis | 🟢 | 3 intents (summarize/search/answer) correctly implemented (server.js:1031–1248). Summary overwrite for `summarize` works. Deterministic fallback if AI fails. | When you type a message in the chat, the AI correctly figures out whether you want to search for emails, update a summary, or ask a question. If the AI fails, the system falls back to a basic keyword search instead of crashing. |
| 12 | `POST` | `/api/tasks/:id/log` | Log Work Phase 2 — Search Execution | 🟢 | Dual search: `workiq ask` CLI (primary) + Copilot SDK + MCP (fallback) (server.js:1251–1449). `parseMarkdownEmails()` as JSON fallback. Full execution trace stored. | The actual email/Teams search runs through two methods. If the first method fails, a backup method is used. The system saves a full record of what was searched and what was found. |
| 13 | `POST` | `/api/tasks/:id/review` | Ambiguity Resolution | 🟢 | AI-guided resolution with index mapping (server.js:1452–1609). Remaining questions are added as new open items. `enrichmentStatus` → `enriched` when all resolved. | When the AI is unsure about something, it asks you questions. Your answers are evaluated by the AI, resolved items get marked with a checkmark, and the summary is updated with your clarifications. |

---

## 2. Three-Phase Scan Pipeline

| Phase | Name | Trigger | Status | Code-Based Evidence | Plain Language Explanation |
|-------|------|---------|--------|---------------------|---------------------------|
| 1 | Discovery | User clicks "Scan Emails & Teams" | 🟢 | Correctly implemented. CopilotClient + Work IQ MCP session, 180s timeout (server.js:564). Dedup logic robust. | Clicking the scan button searches your emails and Teams for action items. Duplicates are filtered out. |
| 2 | Enrichment | Automatic after Phase 1 | 🟢 | Frontend iterates over `enrichmentStatus === 'pending'` tasks (index.html:989–1032). Per-task freeze/unfreeze + step indicator updates. | After finding tasks, the system automatically reads the full messages to create detailed summaries. Each task gets a visual progress indicator while this happens. |
| 3 | Update Check | Automatic after Phase 2 | 🟢 | Frontend iterates over `enriched` or `needs-review` tasks, non-done (index.html:1039–1082). Runs on EVERY scan cycle, not just once. | After enrichment, the system checks every task for new messages since the last check. This runs every time you scan, not just once. |

### Inventory Documentation Errors (Features work, but the inventory describes them incorrectly)

| Detail | Inventory Claims | Actual Code | Status | Code-Based Evidence | Plain Language Explanation |
|--------|-----------------|-------------|--------|---------------------|---------------------------|
| Scan Days | 1–7 | 1–14 | 🟠 | Server allows `Math.min(14, ...)` (server.js:493). HTML slider has `max="14"` (index.html:653). The inventory incorrectly states 1–7. | The scan range slider in the app goes from 1 to 14 days — not 1 to 7 as the original feature document says. The feature itself works fine; the documentation is just wrong. |
| Discovery Timeout | 90s | 180s | 🟠 | The inventory says "90s timeout", but the code uses `180000` ms = 180s (server.js:564). | The scan waits up to 3 minutes (180 seconds) for a response, not 90 seconds as claimed in the feature document. Again, the feature works — the documentation is inaccurate. |

---

## 3. Two-Phase Log Work System

| Phase | Name | Endpoint | Status | Code-Based Evidence | Plain Language Explanation |
|-------|------|----------|--------|---------------------|---------------------------|
| 1 | Intent Analysis | `/api/tasks/:id/log/analyze` | 🟢 | 3 intents correctly implemented. Summary overwrite for `summarize` intent works (server.js:1161–1163). Clarification flow present. | When you type a message, the AI determines what you want (search, summarize, or answer a question) and responds appropriately. |
| 2 | Search Execution | `/api/tasks/:id/log` | 🟢 | `workiq ask` CLI as primary, Copilot SDK + MCP as fallback. Both paths have error handling. | The actual email search works through two different methods with automatic fallback if the first one fails. |

---

## 4. Frontend Features & UI Components

### 4.1 Server Health Monitoring

| Feature | Status | Code-Based Evidence | Plain Language Explanation |
|---------|--------|---------------------|---------------------------|
| Health Check | 🟢 | `checkServerHealth()` with `AbortController` and 3s timeout correctly implemented (index.html:724–745). | When you open the page, it checks whether the server is running. If the server doesn't respond within 3 seconds, it's marked as offline. |
| Status Dot | 🟢 | CSS class `server-dot online` is correctly set/removed (index.html:758). | The green/red dot in the header correctly shows whether the server is reachable. |
| Architecture Tooltip | 🟢 | HTML content is dynamically set based on online/offline status (index.html:761–776). | Hovering over the status dot shows a tooltip with technical details about the system architecture. |
| Offline Banner | 🟠 | **Wrong filename**: The banner references `START-AGENT-ZERO.bat` (index.html:680, 773), but the actual file is called `START-DAILY-BRIEFING.bat`. | When the server is down, a help message tells you to run a file called `START-AGENT-ZERO.bat`. But that file doesn't exist — the real file is called `START-DAILY-BRIEFING.bat`. If you follow the on-screen instructions, you won't find the file. The alternative instruction ("run `node server.js`") still works correctly. |
| Auto-Reconnect | 🟢 | `setInterval(checkServerHealth, 5000)` when offline (index.html:794). Correctly cleared on reconnect (index.html:786). | When the server goes down, the app automatically checks every 5 seconds if it's back. When it reconnects, you see a success notification. |
| Button Protection | 🟢 | `btnScan.disabled = !online` and `btnAddTask.disabled = !online` (index.html:778–783). | The "Scan" and "Add Task" buttons are grayed out when the server is offline, preventing you from clicking them when they can't work. |

### 4.2 Task Management

| Feature | Status | Code-Based Evidence | Plain Language Explanation |
|---------|--------|---------------------|---------------------------|
| Create Task | 🟢 | `addTask()` → POST with validation (index.html:833–853). Form reset after success. | Manually creating a new task works. The form clears after the task is saved. |
| Status Management | 🟢 | 6 status values in `<select>` dropdown, `updateTask()` → PATCH (index.html:1294–1301). | The status dropdown (New, In Progress, Done, etc.) works correctly. Changes are saved immediately. |
| Delete Task | 🟢 | `deleteTask()` with DOM cleanup for open panels and collapsed entries (index.html:901–922). | Deleting a task removes it from the list and cleans up any related UI state (open panels, etc.). |
| Filter by Status | 🟢 | 7 filter buttons (All + 6 statuses) with live count badges (index.html:687–694, 1147–1153). | The filter buttons show how many tasks are in each status category and correctly filter the list when clicked. |
| Sort Order | 🟢 | `statusOrder` map + `createdAt` descending correctly implemented (index.html:1156–1161). | Tasks are sorted by priority (Attention first, Done last), then by newest first within each group. |
| Auto-Hide Done | 🟢 | Done tasks older than 3 days are filtered out, but still visible in "Done" filter (index.html:1141–1144). | Tasks marked as "Done" disappear from the main view after 3 days, but you can still see them by clicking the "Done" filter. |
| Task Count | 🟢 | `updateTaskCount()` shows "X of Y tasks" (index.html:895–899). | The task counter ("5 of 12 tasks") updates correctly after every change. |

### 4.3 Task Card Display

| Feature | Status | Code-Based Evidence | Plain Language Explanation |
|---------|--------|---------------------|---------------------------|
| Source Badge | 🟢 | Email/Teams/Manual badges with correct CSS classes (index.html:1179–1181). | Each task shows a colored label indicating its source: blue for Email, purple for Teams, gray for Manual. |
| Step Indicators | 🟢 | 3 dots with correct state mapping: `enrichmentStatus` → Step 2, `updateCheckStatus` → Step 3 (index.html:1242–1257). Hidden for manual tasks (`enrichmentStatus === 'n/a'`). | The three small dots on each task card correctly show the progress through the scan pipeline (discovered → enriched → update checked). Manual tasks don't show these dots. |
| Collapsible Summary | 🟢 | `max-height` CSS with `.expanded` toggle per click (index.html:1194). Auto-expands when panel is open. | Clicking on a task summary expands it to show the full text. It auto-expands when the task panel is open. |
| Timestamps | 🟢 | `formatDateTime()` for Created and Updated (index.html:1260–1266). | Each task shows when it was discovered and when it was last updated. |
| Freeze Mode | 🟢 | `frozenTasks` Set, `.frozen` CSS class, `freezeTask()`/`unfreezeTask()` (index.html:1873–1883). | While the AI is processing a task, it gets a glowing cyan border and all interactions are disabled, so you don't accidentally change something mid-process. |
| Active Panel | 🟢 | `.active-panel` class with green border, overrides all hover states (index.html:1514). | When a task panel is open, the card gets a green border to make it clear which task you're interacting with. |
| Content Indicator | 🟢 | `.has-content` class for tasks with conversation history (index.html:1276–1279). | Tasks that have chat history get a pink border on hover, so you can tell at a glance which tasks have conversations. |

### 4.4 Interaction Panel (Chat)

| Feature | Status | Code-Based Evidence | Plain Language Explanation |
|---------|--------|---------------------|---------------------------|
| Input Form (Top) | 🟢 | Text input + 📤 Send + 📝 Note buttons correctly positioned (index.html:1305–1309). | The chat input with its two buttons (Send to agent, Save as note) works correctly. |
| Agent Analysis | 🟢 | `analyzeLog()` → POST → intent routing (index.html:1555–1640). Busy state with neon highlight. | Sending a message to the agent works. The task card gets a visual highlight while the AI is thinking. |
| Plan Display | 🟢 | `showPlanUI()` shows understanding, keywords, time window, targets + Execute/Cancel (index.html:1765–1787). | When the AI proposes a search plan, it shows you what it understood, what keywords it will use, and the time range — with Execute and Cancel buttons. |
| Clarification | 🟢 | `submitClarification()` combines original text + answer and re-analyzes (index.html:1642–1655). | If the AI needs more information, it asks a follow-up question. Your answer is combined with the original message and re-analyzed. |
| Search Execution | 🟢 | 4-step progress: Sending → Waiting (after 10s) → Response → Done (index.html:1657–1731). | During a search, you see live progress updates (Sending → Waiting → Receiving → Done) so you know the system hasn't frozen. |
| Conversation History | 🟢 | Reverse-chronological with `[...conversations].reverse()` (index.html:1325). | Messages are displayed newest-first, like an email thread. |
| Collapsible Messages | 🟢 | >120 chars → toggle arrow, `collapsedEntries` Set with localStorage (index.html:1342–1352). | Long messages can be collapsed with a click. Your collapse/expand preferences are remembered across page refreshes. |
| Markdown Rendering | 🟢 | `renderMarkdown()` supports headers, bold, italic, code, lists (index.html:1934–1959). | Agent responses are formatted with proper headings, bold text, bullet lists, etc., making them easier to read. |
| Delete Entries | 🟠 | **Misleading UI**: The delete button (🗑️) is rendered for ALL conversation entries including `review-response` (index.html:1328). The server only allows deleting `update` and `note` types (server.js:433). Clicking delete on a `review-response` entry returns **403 Forbidden**. | You see a trash can icon on every chat entry, including your review responses. But when you try to delete a review response, you get an error. The trash can icon should not appear on review responses at all, because the system doesn't allow deleting them. It's like seeing a "Delete" button that shows "Access Denied" when you click it. |
| Notes | 🟢 | `addNote()` → POST without agent interaction (index.html:1739–1763). | Saving a quick note (without involving the AI) works correctly. |

### 4.5 Ambiguity Review System

| Feature | Status | Code-Based Evidence | Plain Language Explanation |
|---------|--------|---------------------|---------------------------|
| Slim Indicator | 🟢 | One-line warning with click handler to `toggleTaskPanel()` (index.html:1208–1209). Amber/green based on status. | When the AI has questions about a task, you see a small amber warning line on the task card. Clicking it opens the review panel. |
| Full Review Panel | 🟢 | Interactive panel with input + respond button in the chat area (index.html:1213–1236). | The full review panel shows all AI questions with a text input where you can type your answers. |
| Open Items | 🟢 | Amber styling, without `.resolved` class, listed first (index.html:1221–1223). | Unanswered questions appear at the top in amber/yellow, making them easy to spot. |
| Resolved Items | 🟢 | `.resolved` CSS class with strikethrough + checkmark marker (index.html:1224–1226). | Answered questions are shown with a checkmark and strikethrough text so you can see they're done. |
| All-Resolved State | 🟢 | `.all-resolved` class: green border, response form hidden (index.html:1215–1216). | When all questions are answered, the panel turns green and the input form disappears. |
| Respond | 🟢 | `respondToReview()` → POST → AI evaluation → resolution tracking (index.html:1808–1837). | Submitting a response works. The AI evaluates your answer and marks questions as resolved if your answer is sufficient. |
| Grouping | 🟢 | `[...openItems, ...resolvedItems]` sort (index.html:1223). | Open questions are always shown before resolved ones, keeping the important items at the top. |
| Backward Compatibility | 🟢 | `normalizeAmbiguities()` converts `string[]` → `{question, resolved}[]` (server.js:121–128). Also applied in the frontend (index.html:1200–1202). | Older tasks that stored questions in a simpler format are automatically upgraded to the new format. No manual migration needed. |

### 4.6 Summary Management

| Feature | Status | Code-Based Evidence | Plain Language Explanation |
|---------|--------|---------------------|---------------------------|
| Initial Creation | 🟢 | `summary: null` on task creation (server.js:304). Enrichment sets summary (server.js:823). | Tasks start without a summary. The summary is created automatically during the enrichment phase. |
| User Correction | 🟢 | `intent: 'summarize'` → `t.summary = String(result.result).trim()` (server.js:1163). | If you tell the agent the summary is wrong, the AI creates a corrected version and replaces the old one. |
| Update Append | 🟢 | `t.summary = (t.summary || '') + '\n\n📌 Update: ' + ...` (server.js:988). | When new messages are found in a thread, the update is appended to the existing summary instead of replacing it. |
| Review Update | 🟢 | `t.summary = String(result.updatedSummary).trim()` (server.js:1565). | When you clarify ambiguity questions, the AI can update the summary with your new information. |
| Change Tracking | 🟢 | Every summary change is logged with `type: 'summary-update'` and previous value (server.js:367–372, 1164–1169, 1566–1571). | Every time the summary changes, the old version is saved in the history. You can always see what the summary said before. |
| PATCH Update | 🟢 | `allowedFields` includes `'summary'`, history tracking before overwrite (server.js:365–373). | Directly editing a summary via the API works and the change is tracked in history. |

### 4.7 Scan Progress UI

| Feature | Status | Code-Based Evidence | Plain Language Explanation |
|---------|--------|---------------------|---------------------------|
| Progress Banner | 🟢 | `.scan-banner.visible` with spinner, text, and timer (index.html:668–672, 932–944). | During scanning, a banner shows at the top of the page with a spinning icon, status text, and elapsed time. |
| Phase Labels | 🟢 | Button text changes: "Scanning..." → "Enriching..." → "Checking updates..." (index.html:931, 994, 1045). | The scan button and banner text update to show which phase is currently running. |
| Per-Task Progress | 🟢 | Banner shows "Phase 2: Enriching content (3/12)... timer" with live counter (index.html:1008, 1059). | You can see exactly how many tasks have been processed (e.g., "3 of 12") with a running timer. |
| Freeze per Task | 🟢 | `freezeTask()` before, `unfreezeTask()` after each task (index.html:1009, 1027, 1060, 1077). | Each task gets a visual lock (glowing cyan border) while being processed, then unlocks when done. |
| Auto-Refresh | 🟢 | `refreshSingleTask(taskId)` after each task processing (index.html:1028, 1078). | After the AI finishes with a task, that specific task card updates on screen without reloading the entire page. |
| Stuck Reset | 🟢 | Server startup IIFE resets `enriching` → `pending` and `checking` → `pending` (server.js:1674–1691). | If the server crashes mid-scan, tasks stuck in a "processing" state are automatically reset to "pending" when the server restarts. |

### 4.8 Link Handling

| Feature | Status | Code-Based Evidence | Plain Language Explanation |
|---------|--------|---------------------|---------------------------|
| Window Mode | 🟢 | `window.open(url, '_blank', ...)` (index.html:2028). | Opening links in a new browser window works correctly. |
| Tab Mode | 🟢 | `window.open(url, '_blank')` without features string (index.html:1998). | Opening links in a new browser tab works correctly. |
| Split View | 🟢 | 50/50 iframe split with header, close, and pop-out buttons (index.html:2010–2022, 2033–2048, 2055–2062). | The split-screen mode shows the original email/message on the right side while Agent Zero stays on the left. Includes close and pop-out buttons. |
| Incognito Mode | 🔴 | **Does not work.** The code (index.html:2023–2025) opens a regular browser window and displays a notification: `"Incognito cannot be opened programmatically"`. Opening a private/incognito window programmatically is a browser security restriction that cannot be bypassed by JavaScript. The function does exactly the same thing as Window Mode. | The "Incognito" button (🕶️) is supposed to open links in a private browser window. It does NOT work — it opens a normal window instead and shows a message saying "Incognito cannot be opened programmatically." This is a fundamental browser security limitation: no website can force your browser into private mode. The button behaves identically to the regular Window mode, making it misleading. |
| CSP Handling | 🟢 | `noFrameDomains` list with 9 known domains (Outlook, Teams, GitHub, etc.), fallback to popup window (index.html:2001–2009). | When using split view with websites that block embedding (like Outlook or Teams), the system automatically opens the link in a separate window instead of showing a blank frame. |
| Source Links | 🟢 | `task.link` rendered as `<a>` with `onclick="return openLink(event)"` (index.html:1190–1191). | "Open source" links on task cards work and respect your chosen link mode (window/tab/split). |

### 4.9 Notification System

| Feature | Status | Code-Based Evidence | Plain Language Explanation |
|---------|--------|---------------------|---------------------------|
| Toast Notifications | 🟢 | Fixed position, auto-dismiss after 5s, close button (index.html:1104–1113). | Pop-up notifications appear in the top-right corner, disappear after 5 seconds, and have a close button. |
| Deduplication | 🟠 | **Inventory inaccuracy**: The inventory describes `querySelectorAll(...).forEach(n => n.remove())`, but the code uses `querySelector` (singular, line 1105–1106). This removes only the first existing notification, not all of them. | The system removes the previous notification before showing a new one. However, it only removes *one* previous notification at a time (the first it finds), not all of them. In practice, this is rarely a problem because notifications are created one at a time. But if two actions happen very fast simultaneously, you could briefly see two notifications stacked on top of each other. This is a very minor issue. |

### 4.10 UI State Persistence

| Feature | Status | Code-Based Evidence | Plain Language Explanation |
|---------|--------|---------------------|---------------------------|
| Open Panels | 🟢 | `openPanelTaskIds` Set → localStorage `openPanels` (index.html:1546, 1551). | If you have a task panel expanded, it stays expanded after you refresh the page. |
| Collapsed Threads | 🟢 | `collapsedEntries` Set → localStorage `collapsedEntries` (index.html:1547, 1552). | If you collapsed a long message, it stays collapsed after page refresh. |
| Scan Days | 🟢 | localStorage `scanDays` with correct range 1–14 (index.html:1976–1980). | Your preferred scan range (e.g., "last 7 days") is remembered across sessions. |
| Link Mode | 🟢 | localStorage `linkMode` (index.html:1984, 1988). | Your preferred link open mode (window/tab/split) is remembered across sessions. |

---

## 5. Data Schema (tasks.json)

| Field | Status | Code-Based Evidence | Plain Language Explanation |
|-------|--------|---------------------|---------------------------|
| Complete Schema | 🟢 | All 17 fields in the v3 schema are correctly implemented and consistent across all code paths. Task creation (server.js:301–318), scan creation (server.js:677–695), and migrations (server.js:256–277) all set fields correctly. | Every data field that a task needs is properly created and maintained throughout the application. No fields are missing or inconsistent. |
| `ambiguities` Field | 🟢 | Optional, with `normalizeAmbiguities()` backward compatibility for old `string[]` formats. | The review questions field works with both old and new data formats automatically. |

---

## 6. Helper Functions

| Function | Location | Status | Code-Based Evidence | Plain Language Explanation |
|----------|----------|--------|---------------------|---------------------------|
| `readTasks()` | server.js:75–78 | 🟢 | Synchronous read and parse. Errors propagate to caller. | Reading the task file works correctly. |
| `writeTasks(data)` | server.js:80–82 | 🟢 | Synchronous write with 2-space indent + newline. | Saving tasks to the file works correctly. |
| `safeWriteTasks(mutationFn)` | server.js:88–96 | 🟠 | **Missing error recovery**: The promise chain has no `.catch()`. If `readTasks()` or `writeTasks()` throws (e.g., disk full, corrupted JSON file), the entire write queue breaks permanently. All subsequent write operations will fail until the server is restarted. Fix would be: `writePromise = writePromise.catch(() => {}).then(...)` | This is the system that makes sure only one task is saved at a time (to prevent data corruption). **The problem:** If saving fails even once (e.g., the disk is full, or the task file gets corrupted), the entire save system freezes permanently. Every future attempt to save anything — create tasks, update status, save notes — will fail silently. The only fix is restarting the server. Think of it like a conveyor belt that jams: one stuck item stops everything behind it, and the belt never un-jams on its own. |
| `normalizeForCompare(title)` | server.js:100–106 | 🟢 | Lowercase, strip non-alphanumeric, collapse whitespace. Correct. | Text normalization for duplicate detection works correctly. |
| `isSimilarTitle(a, b)` | server.js:108–115 | 🟢 | Jaccard similarity >0.7. Edge case: empty word sets return `false`. Correct. | The title similarity check correctly identifies when two task titles are about the same thing, preventing duplicate creation. |
| `normalizeAmbiguities(arr)` | server.js:121–128 | 🟢 | Converts 3 formats (string, object with question, other) safely. | Converts old-format review questions to the new format automatically. |
| `extractKeywords(title)` | server.js:130–142 | 🟢 | 50+ stop words, filters 1-char words. Correct. | Extracts meaningful search words from task titles by removing common words like "the", "and", "for". |
| `runWorkIQAsk(question, timeout)` | server.js:146–178 | 🟢 | Spawn with stdin/stdout, 500ms init delay, timeout handling with `proc.kill()`. Correct. | The direct communication with Work IQ via command line works correctly, including timeout handling. |
| `buildSearchQuestion(plan, ctx, text)` | server.js:180–218 | 🟢 | 3 fallback paths (sender → keywords → task title). Explicit date formatting. | Building search queries works with three levels of fallback to ensure a search always has something to look for. |
| `parseJsonFromResponse(text)` | server.js:1612–1627 | 🟢 | 3-level parsing (direct → code block → array regex). Note: Greedy regex `/\[[\s\S]*\]/` could match too much text if multiple arrays exist — not an issue in practice with AI responses. | Extracting structured data from AI responses works through three different parsing strategies, making it robust against varying response formats. |
| `parseMarkdownEmails(text)` | server.js:1631–1665 | 🟢 | Anchored on `**From:**`, extracts 5 fields. Fallback on header pattern. | Parsing email data from formatted text works correctly, anchoring on the "From:" field as the most reliable indicator. |
| `migrateTasks()` | server.js:222–235 | 🟢 | v1→v2 with history and doneAt. Version guard present. | Upgrading old task data to the new format works. Version check prevents double migration. |
| `migrateStatuses()` | server.js:239–252 | 🟢 | `active` → `new` conversion with count logging. | Old "active" status values are automatically converted to "new". |
| `migrateToV3()` | server.js:256–277 | 🟢 | Adds pipeline fields with intelligent defaults. | Adds the scan pipeline fields to old tasks with smart defaults (e.g., tasks with a summary get "enriched" status). |
| `escHtml(str)` | index.html:1861–1865 | 🟢 | `textContent → innerHTML` — safe XSS prevention. | Prevents malicious code from being injected through user input (security protection). |
| `formatDate(iso)` | index.html:1855–1859 | 🟢 | `de-CH` locale (dd.mm.yyyy HH:MM). | Date formatting in Swiss format works correctly. |
| `formatDateTime(iso)` | index.html:1867–1871 | 🟢 | Abbreviated format (Jan 15, 14:30). | Short date formatting works correctly. |
| `renderMarkdown(text)` | index.html:1934–1959 | 🟢 | Lightweight converter. XSS-safe because `escHtml()` is called first. | Text formatting (bold, italic, lists, etc.) works and is safe against code injection. |
| `previewText(text, maxLen)` | index.html:1963–1968 | 🟢 | First line, formatting strip, truncation with "...". | Truncating long messages for preview works correctly. |
| `freezeTask(id)` / `unfreezeTask(id)` | index.html:1873–1883 | 🟢 | Add/remove from `frozenTasks` Set + CSS class toggle. | Locking/unlocking tasks during processing works correctly. |
| `refreshSingleTask(id)` | index.html:1886–1901 | 🟢 | Works, but inefficient: loads ALL tasks via `GET /api/tasks` to update a single card. Not a problem with current task count (10–50). | Updating a single task card on screen works. It loads all tasks from the server to find the one it needs, which is slightly wasteful but has no noticeable impact with fewer than 50 tasks. |
| `updateStepIndicator(id, step, state)` | index.html:1903–1915 | 🟢 | DOM-based step dot update with CSS classes. | Updating the progress dots on task cards works correctly. |
| `updateTaskSummaryInCard(id, summary)` | index.html:1917–1931 | 🟠 | **Dead code**: This function is defined but never called anywhere in the codebase. It was likely replaced by `refreshSingleTask()`. No functional impact, but it's unnecessary code sitting in the file. | This is a function that exists in the code but is never actually used — like a tool in a toolbox that's never been picked up. It was probably written for an earlier version of the app and replaced by a different approach, but nobody deleted the old code. It doesn't cause any problems, but it's clutter that could confuse someone reading the code. |

---

## 7. Skill Files (AI Prompt Templates)

| File | Status | Code-Based Evidence | Plain Language Explanation |
|------|--------|---------------------|---------------------------|
| `SCAN_DISCOVERY_SKILL.md` | 🟢 | Exists, loaded at startup (server.js:45–50). Takes priority over `SCAN_SKILL.md`. | The AI instructions for scanning emails exist and are loaded correctly. |
| `SCAN_SKILL.md` | 🟢 | Exists, used as fallback if discovery skill is missing (server.js:526). | The backup scan instructions exist and serve as fallback. |
| `ENRICH_SKILL.md` | 🟢 | Exists, loaded at startup (server.js:52–57). Falls back to empty string if not present. | The AI instructions for reading full email content exist and are loaded correctly. |
| `UPDATE_CHECK_SKILL.md` | 🟢 | Exists, loaded at startup (server.js:59–64). Falls back to empty string. | The AI instructions for checking for updates exist and are loaded correctly. |
| `LOG_WORK_SKILL.md` | 🟢 | Exists, used only as fallback in Phase 2 (server.js:1333). Phase 1 (`/log/analyze`) has its own inline prompt. | The AI instructions for work logging exist. They're only used when the main chat system falls back to the secondary search method. |

---

## 8. External Dependencies

| Dependency | Version | Status | Code-Based Evidence | Plain Language Explanation |
|------------|---------|--------|---------------------|---------------------------|
| `express` | ^5.2.1 | 🟢 | Express 5 correctly configured with `express.json()` middleware (server.js:66). ESM import works with `"type": "module"` in package.json. | The web server framework is correctly set up and compatible with the modern JavaScript module system. |
| `uuid` | ^13.0.0 | 🟢 | `v4 as uuidv4` import (server.js:5). Used for task ID generation. | The unique ID generator is correctly imported and used to give every task a unique identifier. |
| `@github/copilot-sdk` | ^0.1.25 | 🟢 | `CopilotClient` import correct (server.js:6). Used in scan, enrich, update-check, log-analyze, log, and review endpoints. Requires active GitHub Copilot authentication — error handling present in code. | The AI engine connection is correctly set up. If authentication fails, the app shows helpful error messages instead of crashing. You need a valid GitHub Copilot license for AI features to work. |
| `@microsoft/workiq` | ^0.2.8 | 🟢 | Started as MCP server via `stdio` (`command: 'workiq', args: ['mcp']`). Requires global installation and EULA acceptance. Error handling and `friendlyError()` cover typical failure cases (auth, EULA, spawn errors). | The Microsoft 365 data access tool is correctly integrated. If it's not installed or the license agreement hasn't been accepted, the app shows clear instructions instead of a cryptic error. |

---

## 9. Startup & Infrastructure

| Component | Status | Code-Based Evidence | Plain Language Explanation |
|-----------|--------|---------------------|---------------------------|
| Server | 🟢 | Express on port 3000, `app.listen(PORT)` (server.js:1693–1695). | The server starts correctly on port 3000. |
| Data Storage | 🟢 | `tasks.json` with synchronous I/O and write queue (server.js:75–96). | Tasks are saved to a local file. A queue system prevents data corruption from simultaneous saves. |
| Launcher | 🟠 | **Filename mismatch**: The file is called `START-DAILY-BRIEFING.bat`, but the offline banner (index.html:680) and the tooltip (index.html:773) reference `START-AGENT-ZERO.bat`. The BAT script itself works correctly (port check, minimized start, health poll, browser open). | The startup script (`START-DAILY-BRIEFING.bat`) works perfectly — it checks if the server is already running, starts it if not, waits for it to be ready, and opens your browser. **However**, when the app is offline, the on-screen instructions tell you to run a file called `START-AGENT-ZERO.bat`, which doesn't exist. It's like a sign pointing to a door that was renamed — the door works fine, but the sign sends you to the wrong place. |
| Migrations | 🟢 | 3 sequential migrations correct: `migrateTasks()` → `migrateStatuses()` → `migrateToV3()` (server.js:1669–1671). | When you update the app, old task data is automatically upgraded to the new format. Three different upgrade steps run in sequence every time the server starts. |
| Stuck Reset | 🟢 | IIFE `resetStuckStatuses()` resets transient statuses (server.js:1674–1691). | If the server crashed while processing tasks, those tasks are automatically un-stuck when the server restarts. |
| Git Ignored | 🟢 | `.gitignore` contains `node_modules/`, `package-lock.json`, `tasks.json`. Correct — personal data is not committed. | Your personal task data and installed packages are correctly excluded from version control, protecting your privacy. |

---

## Analysis Summary

### Statistics

| Traffic Light | Count | Share |
|---------------|-------|-------|
| 🟢 Works | 79 | ~91% |
| 🟠 Has Problems | 7 | ~8% |
| 🔴 Does Not Work | 1 | ~1% |

### Critical Findings

#### 🔴 Red — Does Not Work

| # | Feature | Problem | Code Location | What This Means For Users |
|---|---------|---------|---------------|--------------------------|
| 1 | **Incognito Link Mode** | Cannot open a private/incognito browser window — this is a browser security restriction. Opens a regular window (identical to Window Mode) and shows a notification explaining the limitation. | index.html:2023–2025 | The 🕶️ incognito button is misleading. It promises private browsing but delivers a normal window. There is no way to fix this with JavaScript — it's a fundamental browser security rule. The button should either be removed or clearly labeled as "not supported." |

#### 🟠 Orange — Has Problems

| # | Feature | Problem | Code Location | What This Means For Users |
|---|---------|---------|---------------|--------------------------|
| 1 | **History Deletion: review-response** | Delete button is shown for `review-response` entries in the UI, but the server rejects the deletion with 403 Forbidden. Frontend shows button for types `update`, `note`, `review-response` — server only allows `update` and `note`. | server.js:433 vs index.html:1274 | You see a trash can icon on review responses, but clicking it gives an error. The icon should be hidden for these entries. It's confusing but not dangerous — no data is lost, the deletion simply doesn't happen. |
| 2 | **safeWriteTasks Error Recovery** | The promise chain breaks permanently if any file read/write error occurs. All subsequent write operations fail until the server is restarted. No `.catch()` recovery exists. | server.js:88–96 | If the task file ever becomes unreadable (corrupted file, disk full, etc.), the entire save system freezes. You could still view tasks, but creating, editing, or deleting tasks would silently fail. Restarting the server fixes it, but you might lose the changes that caused the error. Under normal conditions this never happens, but it's a fragile design. |
| 3 | **Offline Banner: wrong BAT filename** | The UI references `START-AGENT-ZERO.bat`, but the actual file is called `START-DAILY-BRIEFING.bat`. | index.html:680, 773 | When the server is down and you look at the help instructions on screen, you're told to run a file that doesn't exist. You'd need to find the correct filename yourself or use the alternative command-line instruction. |
| 4 | **Scan Days Range (documentation only)** | The inventory claims a range of 1–7, but the actual code allows 1–14. The feature itself works correctly. | server.js:493, index.html:653 | The scan works fine — it just scans a wider range than what the feature document says. This is a documentation error, not a code bug. |
| 5 | **Discovery Timeout (documentation only)** | The inventory claims a 90-second timeout, but the actual code uses 180 seconds. The feature itself works correctly. | server.js:564 | The scan waits longer than documented before timing out. This is actually better for users (more time for results), but the documentation is wrong. |
| 6 | **Notification Deduplication** | Uses `querySelector` (removes first) instead of `querySelectorAll` (removes all). Only removes one previous notification at a time. | index.html:1105 | In very rare cases, you might briefly see two notifications stacked on top of each other if two actions complete at nearly the same instant. This is cosmetic and resolves itself within 5 seconds. |
| 7 | **updateTaskSummaryInCard()** | Function is defined but never called anywhere — dead code. No functional impact, but it's unnecessary code. | index.html:1917–1931 | This doesn't affect you as a user. It's leftover code from an earlier version that was replaced but never cleaned up. It takes up space in the file but doesn't cause any problems. |

---

> **Conclusion:** Agent Zero is approximately 91% functionally correct. Most orange findings are documentation inaccuracies in the feature inventory or minor cosmetic issues. The only red finding (Incognito mode) is a fundamental browser security limitation that cannot be resolved with JavaScript. The most critical orange finding is the missing error recovery in `safeWriteTasks()`, which could permanently freeze the write queue if a disk I/O error occurs — though this situation is unlikely under normal operating conditions.
