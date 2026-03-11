# Agent Zero — Changelog

All notable changes to this project are documented here.

---

## v2.3.0 — March 10, 2026

**Post-Search Evaluation & Title Rename Intent**

### "Updated" Status
- New status `🔄 Updated` — automatically set when Phase 3 (Update Check) detects new information
- Tasks with "Updated" status sort right after "Attention" for maximum visibility
- Subtle pulsing glow animation on the status dropdown draws attention to changed items
- Users can manually change status away from "Updated" after reviewing

### Post-Search Evaluation
- After intelligent search returns results, a second AI evaluation (pure reasoning, no Work IQ) automatically checks whether the task's **title** and **summary** should be updated based on new findings
- Title is updated when the situation has evolved (e.g. slides submitted → awaiting review)
- Summary is extended with new details while preserving existing information
- Creates `title-change` and `summary-update` history entries for full traceability
- Evaluation is non-fatal — search results are always saved even if evaluation fails
- Frontend shows toast notifications when title or summary is updated

### Phase 3 Post-Update Evaluation
- Phase 3 (Update Check) now also runs the post-search evaluation when new updates are found
- Instead of just appending "📌 Update:" text, AI intelligently rewrites title and summary
- Crude append remains as safe fallback if evaluation fails
- Status automatically changes to `updated` when new information is detected

### Rename Intent
- Agent can now change a task's title via conversation (intent: `rename`)
- User discusses with agent what the title should be → agent applies the change
- Logs `title-change` history entry with old → new title

---

## v2.2.0 — March 2, 2026

**Intelligent Search — Log Work Redesign**

### Add Task Redesign
- "Add Task" button moved from hidden bottom section into header row 3, next to "Scan Emails & Teams"
- Click opens a modal dialog with three fields: Title (required), Assignment (what the agent should do), Context (optional background info)
- After creation, the agent **automatically starts working** on the assignment — no second step needed
- Modal closes on ESC, click outside, or Cancel button

### Unified Freeze Mode
- All agent operations (scan phases, analyzeLog, executeLog) now use the same **neon cyan freeze mode** — consistent visual feedback regardless of which process is running
- Removed the separate `agent-busy` green pulse mode — one consistent visual for "agent is working"
- Frozen tasks block status changes and deletion (pointer-events disabled)

### Intelligent Communication Search (SEARCH_SKILL.md)
- New skill file replaces the single-shot `workiq ask` CLI approach
- Agent now uses Copilot SDK + Work IQ MCP with full control over the search strategy
- **Goal-oriented search:** Agent receives `expectedAnswer` (what KIND of answer the user needs) — searches for communications that ANSWER the question, not just contain keywords
- **3-attempt search strategy:** Targeted → Broader → Sender/Recipient (same proven pattern as enrichment)
- **Self-assessment:** Agent evaluates after each attempt whether results actually answer the user's question
- **Relevance filtering:** Irrelevant results are discarded — an honest "nothing found" beats keyword-matched noise
- **Language awareness:** Search terms automatically translated between German and English
- **Confidence levels:** `high` / `medium` / `low` / `none` — response formatting adapts accordingly

### Improved Analyze Prompt
- New `expectedAnswer` field tells the agent what KIND of answer the user needs (e.g. "a person's name")
- Bilingual keyword generation (user's language + English)
- Understanding is now a concrete action plan, not just a paraphrase

### Response Quality
- Three-tier honest answer formatting: found (with confidence) / partially found / not found
- Search attempt details logged in history for transparency
- Timeout increased from 90s to 300s to accommodate 3-attempt strategy

### Frontend Rendering (index.html)
- Method label shows specific search method used (SEARCH_SKILL, legacy, minimal)
- Plan display shows `expectedAnswer` (🎯) and bilingual keywords (🔑🇬🇧)
- Confidence badge with color coding (green/yellow/orange/red) in detail log
- Agent's direct answer displayed prominently in Step 4
- Search attempts detail: strategy, what was found, relevance per attempt
- Ambiguities shown with ⚠️ indicators
- Communication relevance annotations (↳ why this message answers the question)
- Communication summaries shown in conversation view with styling

### Answer Rendering Fix
- **Bug fix:** `agentPlan.intent` was not stored in history entries — `intent: 'search'` was always undefined, causing `agentResponse` to never be displayed (fell through to showing `understanding` instead)
- **Prominent answer display:** When `agentExecution.answer` exists for search intents, the answer is rendered as a always-visible block with confidence badge and color-coded border — never collapsed
- Communications (email listings) are shown BELOW the answer as supporting evidence

---

## v2.1.0 — March 1, 2026

**Header UI Redesign + Scan Control + Auto-Cleanup**

### Header UI Redesign
- 3-row dashboard layout: App name → Status/Progress → Actions
- Row 2 transforms between idle state (server dot + "Online"/"Offline" label + last scan + sliders) and scanning state (spinner + phase text + timer + stop button)
- CSS `:has()` + sibling selector auto-toggles idle/scanning — constant header height, no content jumping
- Purple gradient background on row 2 during scan

### Step Indicator Hover Tooltips
- Phase dots now show detailed status info on hover (phase name, current action, success/error/pending state)
- Tooltips explain what each phase does and what the current result means

### Scan Abort
- Red "⏹ Stop" button appears in progress bar during scanning
- Safely stops scan between tasks — waits for current task's write to finish before aborting
- Button changes to "⏹ Stopping..." while waiting for current task to complete
- Notification confirms how many tasks were processed before the abort

### Freeze Mode Styling
- Stronger neon cyan border and glow on frozen task cards (`box-shadow: 0 0 18px`)
- "❄️ Agent working..." badge now uses vibrant `#00e5ff` with `text-shadow` glow effect
- Background gradient darkened for better contrast

### Auto-Cleanup of Done Tasks
- Done tasks are **permanently deleted** from `tasks.json` after configurable retention period
- Default: 3 days; configurable via slider in header (1–30 days)
- Server-side cleanup runs on startup and before each scan via `POST /api/cleanup`
- Frontend also filters expired done tasks from display (immediate visual feedback when slider changes)
- Only tasks with status `done` and a `doneAt` timestamp older than retention are deleted

### Code Quality (from bug fix session)
- Removed Incognito and Split View link modes (browser restrictions)
- Fixed `safeWriteTasks()` permanent queue freeze (chain recovery with `.catch(() => {}).then(...)`)
- Fixed notification deduplication (querySelectorAll)
- Removed `updateTaskSummaryInCard()` dead code
- Added error notifications for 3 silent failure paths
- Fixed offline banner BAT filename

---

## v2.0.0 — February 27, 2026

**Three-Phase Scan Pipeline — Complete Rewrite**

The scan system was rebuilt from a monolithic single-pass scan into a three-phase pipeline:

### Phase 1: Discovery
- New `SCAN_DISCOVERY_SKILL.md` — lightweight subject/sender/date extraction only
- Deduplication context: sends top 50 active + 30 done tasks to AI to prevent duplicates
- Actions: `new` (create task), `update` (modify existing), `skip` (already done)

### Phase 2: Enrichment
- New `ENRICH_SKILL.md` — deep content extraction via Work IQ
- Keyword-based search (stopword-filtered title tokens, max 8) instead of exact subject matching
- Link context: Teams Thread-ID and Outlook ItemID extracted from task links via regex
- Sender treated as hint, not filter — fixes false negatives from inaccurate metadata
- 3-attempt retry strategy: keywords → broader keywords → sender-based
- 180s timeout per task

### Phase 3: Update Check
- Detects new replies/messages since original task creation
- Appends updates to existing summary with `📌 Update:` prefix
- 90s timeout per task

### Schema Migration (v2 → v3)
- New fields: `enrichmentStatus`, `updateCheckStatus`, `enrichedAt`, `lastUpdateCheck`
- Automatic migration on server startup (`migrateToV3()`)

### Frontend
- Three-dot step indicators per task card (Discovery ● Enrichment ● Update)
- Freeze mode: neon cyan border (`#00d4ff`) + pulsing badge during agent work
- `refreshSingleTask()` — auto-updates individual cards without full page reload
- Detailed history entries with search keywords, source, duration, confidence
- Summary section visible by default (blue left-border, 6em height)
- Timestamps: "📥 Discovered" / "🔄 Last updated"
- All UI text in English

### Bug Fixes
- Phase 2 now enriches ALL pending tasks (was: only newly discovered)
- Phase 3 now checks ALL enriched tasks (was: excluded new tasks)
- Stuck status reset on startup (enriching→pending, checking→pending)
- `enrichmentStatus` and `updateCheckStatus` added to PATCH allowed fields

---

## v1.4 — February 25, 2026

**Two-Phase Agent for Work Logging**

- Analyze phase: Copilot SDK without Work IQ (~5-15s), extracts user intent
- Execute phase: Copilot SDK with Work IQ (~30-120s), searches and logs
- Interaction panel for task-specific agent conversations
- Execution tracing: `agentPlan` + `agentExecution` objects on tasks
- Server logging: timestamps, session duration, prompt size, raw response preview
- Timeout increased: 90s → 120s for Work IQ execution
- Analyze prompt rewritten: concrete action plan instead of paraphrasing

---

## v1.3 — February 25, 2026

**AI-Powered Deduplication**

- Context-aware scan prompt: sends existing tasks as dedup context
- Safety-net Jaccard similarity check as fallback
- `SCAN_SKILL.md` rewritten with 4-branch decision logic (new/update/skip)
- `LOG_WORK_SKILL.md` created for work logging agent instructions

---

## v1.2 — February 24, 2026

**Task History & Work Logging**

- `history[]` array on each task (typed entries: creation, status-change, scan-update, note, conversation)
- Auto-cleanup: removes tasks older than 30 days (status: done)
- AI work logging via Copilot SDK + Work IQ MCP
- Write queue for concurrent task file access
- Schema v2: `history[]`, `doneAt`, `agentPlan`, `agentExecution`

---

## v1.1 — February 24, 2026

**Server Status Detection & Launcher**

- `checkServerHealth()` with AbortController (3s timeout)
- Offline banner with startup instructions
- Auto-reconnect polling every 5s
- Status dot in header (12px, green/red) with architecture tooltip
- Scan/Add buttons disabled when offline
- `START-AGENT-ZERO.bat` — port check, minimized server window, auto-browser

---

## v1.0 — February 23, 2026

**Initial Release (originally "Daily Briefing")**

- Express server with REST API (GET/POST/PATCH/DELETE)
- `tasks.json` local file storage
- Dark-themed single-file HTML frontend
- Work IQ MCP integration via Copilot SDK (stdio transport)
- Email + Teams scanning with JSON response parsing
- Filter bar with badge counts (all, attention, new, escalated, in-progress, done)
- Manual task creation
- Notification toast system
