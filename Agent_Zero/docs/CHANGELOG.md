# Agent Zero — Changelog

All notable changes to this project are documented here.

---

## v3.3.0 — April 20, 2026

**Phase 3 (Update Check) — Stub Auto-Recovery & Retroactive Summary Reconciliation**

### Problem diagnosed
`logs/phase3-2026-04-20.log` showed **50 consecutive `stub×1` inconclusive runs** (06:10–06:21): the WorkIQ MCP subprocess was alive but returning EULA/permission stubs for every query. The existing auto-restart only fires on subprocess **exit**, not on degraded-but-alive stubs — so Phase 3 was effectively blind for hours. Secondary defect: the AppNeta task had a `thread-update` history entry (Martin's Sent-Items reply to Antonio correctly detected on 2026-04-15) but its summary was never refreshed (older code path failed to prepend the update marker).

### Code — server.js
- **Stub Auto-Recovery** (new): global `consecutiveStubCount` counter + `STUB_RESTART_THRESHOLD` (env-overridable, default **3**). In `askWorkIQTool.handler`, every detected stub increments the counter; when the threshold is reached, the WorkIQ subprocess is force-killed. The existing `close`-handler then emits `wiq-down` and schedules the exponential-backoff auto-restart. A healthy response resets the counter. Logs: `[WORKIQ] N consecutive stubs — force-restarting subprocess` and a dedicated `phase3Log` `STUB-RESTART` entry.
- **Retroactive Summary Reconciliation** (new helper `reconcileSummaryWithHistory`): scans the task's history for the latest `thread-update` and latest `summary-update`. If a thread-update exists without a corresponding (or newer) summary-update, the update text is prepended to the summary as `🔴 **Update DD.MM.YYYY, HH:MM:** …`, status is flipped to `updated` (unless already `done`), and a new `summary-update` history entry (`Retroactive reconciliation`) is appended. Idempotent via marker-string check.
- **Reconciliation invoked at the top of `POST /api/tasks/:id/check-update`** (before the pre-filter skip) so even tasks that would be skipped by `phase3MinInterval` still get healed on demand.

### Documentation
- `UPDATE_CHECK_SKILL.md`: new v3.3.0 section noting the auto-restart safety-net and the retroactive reconciliation helper.
- `package.json`: version bumped to 3.3.0.

### Behavioural impact
- A degraded WorkIQ no longer blinds Phase 3 for the full session lifetime; it recovers autonomously after 3 stubs.
- Existing tasks whose summary silently desynced from their history (like AppNeta) are healed automatically on the next Phase 3 run — even if that run is still inconclusive, because reconciliation runs before the WorkIQ call.
- No change to the Sent-Items requirement or the status flip — those were already correct in v3.2.4.

---

## v3.2.4 — April 19, 2026

**Phase 3 (Update Check) Observability + Quota Hardening**

### Code — server.js
- **Per-session query tracking** (`phase3Sessions` Map, `phase3Register` / `phase3Get` / `phase3Cleanup`): every Phase 3 SDK session now carries `{ taskId, count, stubCount, budgetHit, wiqDown, calls[] }` for accurate post-mortem logging.
- **Hard query budget** (`PHASE3_QUERY_BUDGET`, env-overridable, default **3**): the `ask_work_iq` handler rejects any call past the cap with a `BUDGET_EXHAUSTED` message telling the model to return `{"hasUpdate": false, "inconclusive": true}`.
- **Self-EULA guard** (`SELF_EULA_QUERY` regex): any attempt by the model to ask `ask_work_iq` to "accept/acknowledge/confirm the EULA" is blocked before it hits WorkIQ — server handles EULA at startup.
- **M365 stub detection** (`EULA_MARKERS` + `isStubResponse()`): when WorkIQ returns a permission/EULA stub (two or more marker phrases match), the tool response is rewritten to `SERVICE_UNAVAILABLE` so the model returns inconclusive immediately instead of retrying and burning budget.
- **Phase 3 state prompt** (`buildActionItemState()` + `PHASE3_STATE_MAX`): the prompt now includes a structured "Action Item State" block (title, source, sender, direct link, Teams thread/message IDs, temporal anchor, current summary, last 5 history entries with communications). The model is explicitly told this is ground truth and must NOT be re-reported.
- **Richer logs**: every `ask_work_iq` call logs `[PHASE3-TOOL]` with `sessionId`, `taskId`, `queryIndex`, `durationMs`, `charsReturned`, outcome (`ok | stub | error | blocked | budget_exhausted`).

### Code — frontend
- Minor `index.html` polish (see diff).

### Documentation
- `UPDATE_CHECK_SKILL.md`: rewritten as Phase 3 (v2) — explicit query budget (3), required "Sent Items" search template, stop-early rules, forbidden behaviours (EULA queries, exceeding budget, re-summarising known history), explicit tool error handling (`BUDGET_EXHAUSTED`, `SERVICE_UNAVAILABLE`, generic errors).
- `AGENT_ZERO_SPEC.md`: version bumped to 3.2.4; SDK dependency corrected from `^0.1.25` to `^0.2.1` (matches `package.json`).
- `README.md`, `AGENTS.md`, `ARCHITECTURE.md`, `BUBBLE_EDITOR_GUIDE.md`, `AGENT_ZERO_PRESENTATION.html`: version bumped to 3.2.4.
- `package.json`: version bumped to 3.2.4; `playwright` added to `devDependencies` for internal E2E scripts.
- New educational presentations in `docs/`: `phase-1-discovery.html`, `phase-2-enrichment.html`, `phase-3-update-check.html`, `phase-4-consolidate.html` — one per phase, code-accurate, silver-neon AI nodes, plain-English letter bodies with click-through to technical detail panels.

### Removed
- `docs/PHASE3_OBSERVATIONS.md` — transient analysis artifact from the Phase 3 test run that produced the fixes above; its findings are now encoded in the code + `UPDATE_CHECK_SKILL.md`.

---

## v3.2.3 — April 11, 2026

**Spec & Feature Inventory Alignment**

### Documentation
- `AGENT_ZERO_SPEC.md`: K4 done-task suppression now described in Phase 1 dedup section; Jaccard threshold corrected from >0.7 to >0.6; subset ratio ≥0.9 documented; Safety-Net behavior updated to include done-task handling
- `FEATURE_INVENTORY.md`: Phase 1 row and `isSimilarTitle` utility row updated — K4 behavior documented, Jaccard threshold corrected to >0.6
- `CORRECTION_PLAN.md`: K2/K3 commit updated to `43f22bd`; K4 commit updated to `4fdcbba`; version updated to v3.2.3

---

## v3.2.2 — April 11, 2026

**WorkIQ Crash Guard + Dead Code Cleanup + Doc Alignment**

### K2 — WorkIQ Crash Guard (Event-Based Abort)
- New `EventEmitter` (`wiqEvents`) broadcasts `'wiq-down'` when the WorkIQ subprocess exits
- New `runWithWiqGuard(session, prompt, timeoutMs)` wraps `session.sendAndWait()` with a race against `wiq-down`
- All active SDK sessions abort immediately on WorkIQ crash instead of hanging 600s until timeout

### K4 — Phase 1 Done-Task Suppression Fix
- Previously: any done task with a similar title was reactivated to `needs-attention` on every scan
- Root cause: the Safety-Net did not distinguish between "same email resurfaces in scan window" and "genuine new follow-up from sender"
- Fix: done tasks are now suppressed (not reactivated) unless: no exact link match AND item's date is verifiably after `doneAt`
- Conservative defaults: missing item date → suppress; missing doneAt → suppress
- Reactivation still works for genuinely new emails (different link + email date > doneAt)
- Debug log entry: `[PHASE1] Suppressed done task resurface: "..." | {exactLinkMatch, itemDate, doneAt}`
- Error threshold increased 3 → 4 before triggering restart
- Removed premature `wiqProc.kill()` calls on M365 data errors (41-char refusals are not process errors)
- `wiq41ErrorCount` reset to 0 after each auto-restart

### Dead Code & Dependency Cleanup
- Deleted `msal-auth.mjs` (abandoned MSAL/WAM auth experiment, never in production)
- Deleted `migrate-summaries.js` (one-time migration script, already run)
- Deleted `tasks.ORIGINAL.json` (orphaned backup)
- Removed `@azure/msal-node` and `@azure/msal-node-extensions` from `package.json`

### Documentation
- All doc files updated from v3.0.0 → v3.2.2
- ARCHITECTURE.md: fixed WorkIQ subprocess model (persistent, not per-session), fixed Phase 4 timeout (300s), fixed SDK version (0.2.1)
- README.md: fixed `workiq mcp` component description, fixed Session Architecture section
- AUTH_MIGRATION.md: marked as archived (MSAL experiment was abandoned)
- CORRECTION_PLAN.md: added K2 (Fix #12) and K3 (Fix #13)

---

## v3.0.0 — March 16, 2026

**Naive Hybrid Scan + Verify-and-Improve Loop + Server Stability**

### Phase 1 Redesign: Naive Hybrid Scan
- Replaced technical SCAN_DISCOVERY_SKILL prompt with natural language: "Which of my emails and Teams messages require me to take action?"
- Dedup context sent as human-readable list instead of raw JSON
- New fields from scan: `actionNeeded` (what the user must do) and `deadline` (if any)
- Links now included directly in Phase 1 results (previously only after enrichment)
- Dedup against active AND done tasks preserved — 6 items correctly skipped in testing
- Retry with reduced context on timeout preserved

### Verify-and-Improve Loop for Update Intent
- When a user gives an update instruction, the agent now follows a 3-step process:
  1. **Execute**: Generate title/summary changes
  2. **Verify**: Separate LLM call evaluates whether changes correctly fulfil the user's instruction
  3. **Improve**: If verification fails, feedback is sent to a retry LLM call (max 1 retry)
- Pure agent reasoning — no keywords or pattern matching
- Graceful degradation: if verification fails/times out, original result is used

### Content Removal Capability
- Agent can now remove false/wrong information from title and summary when user explicitly requests it
- Update prompt rule "NEVER drop information" now has exception for user-requested removal of false content
- Decision tree Step 1.7 (correct) refined: only triggers for M365 verification requests, not removal requests

### Server Stability
- Global `uncaughtException` and `unhandledRejection` handlers prevent server crashes from SDK stream errors (ERR_STREAM_DESTROYED, EPIPE)
- Periodic reaper now skips cleanup when active sessions exist (prevents killing SDK processes mid-operation)

---

## v2.9.1 — March 13, 2026

**Scan Report Panel Fix + Scan Retry on Timeout**

### Scan Report Panel
- Fixed: Panel was not clickable — DOM structure corrected (panel now nested inside last-scan span)
- Fixed: Click propagation issue with `event.stopPropagation()`
- Fixed: Close-on-click-outside now properly checks parent container

### Scan Timeout Retry
- Phase 1 scan now retries once on timeout with reduced context:
  - Reduces context from 80 tasks to 20
  - Reduces scan range from N days to min(N, 2) days
  - Creates a fresh Copilot SDK session for the retry
- Logs both attempts with timing for diagnostics

---

## v2.9.0 — March 13, 2026

**Scan Process Resilience — Phase-Independent Recovery**

### Phase 1 Non-Fatal
- Phase 1 (subject scan) failure no longer terminates the entire process
- If Phase 1 fails (timeout, 500 error), Phase 2/3 continue with existing pending tasks
- Server-unreachable detection with automatic reconnection wait (up to 30s)

### Per-Task Retry Logic
- Phase 2 (enrichment) and Phase 3 (update check) now retry each failed task once after 3s
- Live status shows retry progress: `🔄 Retrying enrichment...`
- Network errors trigger 5s server recovery wait before retry
- Only aborts the full scan if server remains unreachable after 2 attempts

### Scan Lock
- New `scanInProgress` flag prevents duplicate concurrent scans
- Released in `finally` block — guaranteed cleanup even on errors

### Architecture
- Each phase operates independently on server-side task status
- Phase 2 queries `enrichmentStatus: 'pending'` — works regardless of Phase 1 outcome
- Phase 3 queries `enrichmentStatus: 'enriched'` — works regardless of Phase 2 outcome
- Phase 4 (consolidation) was already non-fatal

---

## v2.8.0 — March 13, 2026

**UX Improvements — Live Agent Status & Reverse-Chronological Details**

### Live Agent Status on Task Cards
- Frozen task cards now show **context-specific status** instead of static "Agent working..."
- Status updates dynamically as the agent progresses through phases:
  - `🤔 Analyzing request...` → `🔄 Updating task...` / `🔍 Preparing search...`
  - `📤 Searching emails & Teams...` → `⏳ Searching M365...` → `✅ 3 result(s) found`
  - `📋 Analyzing content...` (enrichment), `🔍 Checking for updates...` (update check)
  - `⚡ Verifying in M365...` (correction), `✏️ Applying correction...`
- New `updateFrozenStatus(taskId, text)` function for live badge updates without re-render
- `freezeTask()` now accepts optional `statusText` parameter

### Reverse-Chronological Details Panel
- `renderDetails()` now shows newest entries first (matching `renderConversations()` behavior)
- System events section already used reverse order — now consistent throughout

### Performance: Default Model
- Switched from Claude Opus 4.6 to default model for intent classification and correction verification
- Response time improvement: ~26-39s → ~12-19s per classification

---

## v2.7.0 — March 13, 2026

**Session Lifecycle Management — Orphaned Subprocess Prevention**

### Session Tracking & Guaranteed Cleanup
- New global `activeSessions` Set tracks all Copilot SDK sessions from creation to destruction
- `trackSession()` / `destroySession()` helpers replace raw `session.destroy()` calls
- All 12 `createSession()` calls across 8 endpoints now use `trackSession()`
- `session.destroy()` moved from happy-path-only to **finally blocks** — sessions are destroyed even on timeout or error
- Previously, a timeout in `sendAndWait()` would skip `session.destroy()`, leaking the child process

### Graceful Shutdown
- New SIGINT/SIGTERM/SIGHUP handlers call `destroyAllSessions()` before process exit
- Prevents orphaned subprocesses when the server is stopped with Ctrl+C or killed

### Startup Orphan Reaper
- On server start, detects and kills leftover Copilot SDK child processes from previous runs
- Uses PowerShell `Get-CimInstance` on Windows, `pkill` on Unix
- Non-fatal: if detection fails, the server starts normally with a warning

### Impact
- Eliminates the accumulation of orphaned `node.exe` processes (previously up to 74 observed during development)
- Three layers of defense: guaranteed finally-block cleanup, graceful shutdown, startup reaper

---

## v2.6.0 — March 13, 2026

**Correction Verification & Claude Opus 4.6 Integration**

### Evidence-Based Correction ("correct" Intent)
- New **"correct" intent** in the agent's decision tree — detects when users dispute or deny existing information (e.g. "Das stimmt nicht", "SSD wurde nie bestellt", "Der Titel ist falsch")
- **Not keyword-based** — the agent uses Claude Opus 4.6 reasoning to understand whether the user is correcting vs. updating vs. searching
- New `CORRECT_SKILL.md` skill file: 3-attempt M365 search with evidence evaluation and truth hierarchy
- **Truth hierarchy** (most authoritative first): newest M365 messages > older messages > task history > user claims
- Three verdicts: `user_correct` (auto-apply), `current_correct` (show evidence, offer Accept/Veto), `inconclusive` (offer Veto)
- **Absolute user veto right** — user can always override the agent's verdict, regardless of evidence

### Claude Opus 4.6 Model Selection
- Intent classification (`POST /api/tasks/:id/log/analyze`) now uses **Claude Opus 4.6** for superior understanding of user intent — especially correction vs. update distinction
- Correction verification (`POST /api/tasks/:id/correct`) also uses **Claude Opus 4.6** for nuanced evidence evaluation
- All other endpoints continue using the default Copilot SDK model

### Pre-Filter Negation Fix
- Fixed: "Ich habe das NICHT bestätigt" was incorrectly matched by the "Ich habe..." pre-filter, forcing the update-only path
- Negation words (nicht, never, not, nie, kein...) now exclude messages from the pre-filter, allowing them to reach full intent classification

### API Endpoints (New)
- `POST /api/tasks/:id/correct` — Evidence-based correction verification (Claude Opus 4.6 + Work IQ MCP, 300s timeout)
- `POST /api/tasks/:id/correct/resolve` — Resolve correction discussion: `accept` (confirm current info) or `veto` (override with user's correction)

### Frontend
- Correction plan UI: shows disputed claim vs. user assertion with color-coded display and "Verify" button
- Evidence display: expandable list of M365 messages with color-coded support indicators (green = supports user, red = supports current, gray = neutral)
- Discussion panel: "Accept" and "Override" buttons when verdict is `current_correct` or `inconclusive`
- Veto flow: user can edit their correction before applying via `prompt()` dialog
- New history entry icons: 🔍 correction, ⚡ correction-veto, ✅ correction-dismissed

### Data Schema
- New history entry types: `correction`, `correction-veto`, `correction-dismissed`

---

## v2.5.0 — March 12, 2026

**Manual Merge Mode & Link Preservation**

### Review Endpoint with Research Capability
- `POST /api/tasks/:id/review` now uses **MCP/Work IQ** — when the user asks the agent to verify, analyze, or research something, the agent actually searches emails and Teams messages instead of just accepting the user's assumptions
- Timeout increased from 30s to 180s to allow for MCP-based research
- New prompt instructs AI to distinguish between simple answers (resolve directly) and research requests (search first, then resolve with evidence)

### Manual Merge Mode
- New **🔗 Merge Tasks** button in the sidebar activates Merge Mode
- In Merge Mode, all task cards show checkboxes — click to select 2+ tasks for merging
- **Floating merge bar** at the bottom shows: selected count, abbreviated titles, "🔗 Merge N Tasks" button, and "✕ Cancel" button
- **ESC key** exits Merge Mode
- On merge: AI generates a combined title and summary, histories are merged chronologically, secondary tasks are deleted
- Merge Mode button text toggles to "🔗 Merge Mode ON" when active

### Link Preservation on Merge
- New `additionalLinks[]` field on tasks — stores links from secondary tasks after a merge
- Primary task keeps its `link` field unchanged (backward compatible)
- Each additional link stores: `url`, `source` (email/teams), and `from` (sender name)
- Links are deduplicated by URL during merge
- Notes from all merged tasks are combined with `\n\n` separators
- **buildTaskMeta()** renders all links with source labels: "📧 Email · Sender ↗", "💬 Teams · Sender ↗"

### Tooltip Hover Descriptions
- All five sidebar buttons now show descriptive tooltips on hover: Generate Action Items, Add Action Item, Find Duplicates, Merge Tasks, Search

### Server Crash Detection During Scans
- Phase 2, 3, 4 catch blocks now call `setServerStatus(false)` on connection errors
- Offline banner appears immediately when the server crashes mid-scan, with guidance to restart

### Duplicate Instance Prevention
- `app.listen()` now handles `EADDRINUSE` errors — if port 3000 is already in use, the server shows a clear error message and exits with code 1 instead of crashing silently
- `START-AGENT-ZERO.bat` already had a pre-check via `netstat`; server.js now has its own safeguard

### Header Progress for All AI Actions
- Find Duplicates and manual Merge now show the same header progress bar (purple gradient, spinner, timer) as scan phases
- New `showHeaderProgress(text)` / `hideHeaderProgress()` helper functions for consistent progress display
- Stop button is hidden for non-abortable operations

---

## v2.4.0 — March 12, 2026

**Phase 4: Task Consolidation & Perspective Attribution**

### Phase 4: Task Consolidation
- New **Phase 4** added to the scan pipeline — after Phases 1-3, AI semantically analyzes all active tasks and suggests merging those covering the same topic
- New `CONSOLIDATE_SKILL.md` skill file for conservative, semantic task grouping
- **Consolidation banner** appears at the bottom of the screen with merge suggestions, each showing the tasks involved, AI reasoning, and a suggested merged title
- **Merge** button: AI generates a combined title and summary, merges histories chronologically, deletes the secondary task
- **Keep Separate** button: Bidirectional `noMergeWith` persisted on both tasks — the pair is never suggested again
- Phase 4 is non-fatal: timeouts or failures are silently caught, scan completes normally

### Find Duplicates Button
- New **🔗 Find Duplicates** button in the sidebar allows triggering Phase 4 independently, without running a full scan
- Useful when the Copilot SDK times out during scan, or after manually adding multiple tasks

### Tooltip Hover Descriptions
- All four sidebar buttons (Generate Action Items, Add Action Item, Find Duplicates, Search) now show descriptive tooltips on mouse hover
- Tooltips explain what each button does in plain language

### Perspective Attribution
- `ENRICH_SKILL.md` now includes a "Perspective Attribution" section: when different people express different expectations, the agent makes the difference explicitly visible (e.g. "Nicola expects X — Martin is considering Y")
- `UPDATE_CHECK_SKILL.md` updated with attribution instruction for update summaries

### API Endpoints (New)
- `POST /api/consolidate` — Phase 4: Analyze all tasks for merge suggestions (30s timeout, no MCP)
- `POST /api/tasks/merge` — Merge two or more tasks into one (AI-generated combined summary)
- `POST /api/tasks/:id/dismiss-merge` — Dismiss a merge suggestion (bidirectional `noMergeWith`)

### Data Schema
- New `noMergeWith[]` field on tasks — stores IDs of tasks the user has explicitly chosen to keep separate
- New `merge` history entry type — logged when tasks are merged

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
