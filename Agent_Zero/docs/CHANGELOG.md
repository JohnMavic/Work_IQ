# Agent Zero — Changelog

All notable changes to this project are documented here.

---

## v4.1.0 — April 22, 2026

**Chat reliability: WorkIQ stub recycling + retrieval-by-reference prompt fix**

### Problem

Two compounding defects caused ~90–95% of chat-driven action-item updates to fail:

1. **WorkIQ subprocess aging** — after extended runtime or many queries the `workiq` MCP subprocess occasionally returned very short "stub" responses (~260 chars) instead of real search results. The server passed these stubs through to the agent, which then produced unusable summaries.
2. **Retrieval-by-reference blind spot** — when the user referenced a specific recent message ("analyse what I just sent to X"), the search agent anchored its queries on the **action-item topic** (title/keywords). But a referenced message can be about a different subject than the task — so the topic anchor actively hid the target message even though Work IQ had indexed it.

### Fix — `server.js` (Option 4: Stub-Recycling + Auto-Retry)

Infrastructure layer — solves defect #1, makes chat queries resilient against WorkIQ subprocess drift:

- **Proactive recycling** — `wiqStartedAt`, `wiqQueryCount`, `wiqRecycling` state vars; `WIQ_MAX_AGE_MS = 30 min`, `WIQ_MAX_QUERIES = 100`. `maybeRecycleWiq()` gracefully restarts the subprocess before it ages out.
- **Auto-retry on stubs** — `askWorkIQDirect(_isRetry)` detects stub responses (< 260 chars or known stub patterns), triggers a recycle, and retries the query once. Downstream code sees only real results.
- **`waitForWiqUp()`** — after a recycle, blocks until the subprocess reports healthy before forwarding queries.
- **Stub-preview log** — when a stub is detected, logs the first 160 chars to `logs/debug.log` for diagnostics.

### Fix — `docs/SEARCH_SKILL.md` (retrieval-by-reference prompt)

Prompt layer — solves defect #2, changes how the agent formulates queries. Pure prompt engineering, no deterministic rules in code:

- **New section "CRITICAL — Retrieval-by-reference pitfall"** describes the pattern (not the case): user references an act of communication (singular message) with a recipient/sender and a recency cue.
- **Pattern-based signals, not if-then rules** — the agent uses its judgement to recognise when topic anchoring is wrong.
- **Do-not-anchor-on-topic guidance** — anchor on sender/recipient/channel/time instead; include "regardless of topic" or "any subject" in at least one query.
- **Two practical phrasing rules that matter with Graph Search**:
  - **First person** ("messages I sent") over third person ("sent by <user>") — third-person phrasing is treated as a generic name match, not "self".
  - **Message-count cap** ("last 5 messages") over date windows ("last 7 days") — Graph date filters are approximate and can exclude messages sent today.
- **Query B reworded** — topic-free when the retrieval-by-reference pattern matches, otherwise broader keywords (unchanged fallback).
- **Generic counter-example** — Bob / Q3 budget action item / vacation-plans message — keeps the guidance out of any specific case.

### Verified end-to-end

- **Positive test** — "Analyse die Nachricht, die ich gerade an Oliver geschickt habe" on a task titled "Copilot CLI / MSSpace room classification validation". Agent issued two parallel topic-free queries with "regardless of topic"; `confidence: high`; summary correctly updated to the actual content (AI tool / Git / node.js / IT managers) rather than the task topic.
- **Gegen-test** — topic-specific informational question on the same action item. Agent correctly did **not** inject "regardless of topic" and did **not** pollute the summary. Confirms the new pattern is not over-applied.
- Two consecutive chat runs after the stub-recycling infra change: no stubs observed, no retries needed, clean queries.

### Files touched

- `package.json` — version 4.0.2 → 4.1.0
- `server.js` — Option 4 infra (~85 lines: state, recycling helpers, stub detection, auto-retry, stub-preview log)
- `docs/SEARCH_SKILL.md` — new retrieval-by-reference section (~25 lines) + Query B description tweak
- `docs/AGENT_ZERO_PRESENTATION.html` — presentation updates
- `index.html` — header slogan _"Built with AI, powered by curiosity."_
- `README.md`, `AGENTS.md`, `docs/ARCHITECTURE.md`, `Specifactions/AGENT_ZERO_SPEC.md` — version bumped to 4.1.0
- `docs/CHANGELOG.md` — this entry

### Design notes

- **Both fixes are independent but complementary.** Option 4 solves infra flakiness (stubs). The prompt fix solves query formulation. One without the other still leaves ~half the failures in place.
- **Why prompt, not code, for the retrieval pattern?** A deterministic heuristic (e.g., "if user says 'just sent' → strip topic") would overfit the exact phrasings tested and miss the long tail. A pattern described in the skill lets the agent generalise to 1000 future phrasings — German, English, mixed — as long as the signals match.
- **Scope discipline** — the skill deliberately uses `<person>` and `<channel>` placeholders, a failure-mode example in an unrelated domain (Q3 budget / vacation), and no names from the case that prompted the fix. The skill should behave the same tomorrow for a completely unrelated task.

---

## v4.0.2 — April 22, 2026

**Single-instance guard — Task Scheduler no longer creates duplicate instances**

### Problem
The Windows Task Scheduler is configured to launch Agent Zero at set times (e.g., morning starts). If a user-launched instance is already running, the scheduler was still starting a second instance on an alternative port (3001, 3002, …), leaving two competing Agent Zero processes that share the same `tasks.json` — causing inconsistent state and wasted resources.

Root cause: the health-check in `START-AGENT-ZERO.bat` was unreliable in the Task Scheduler session context (different PATH, different user session, `CommandLine` not visible for the running process), so the batch fell through to the port-scan that picks a free alternative port.

### Fix — `server.js`
- **Lock file** (`.agent-zero.lock`) written on successful `app.listen`, removed on `SIGINT` / `SIGTERM` / `SIGBREAK` / normal exit. Stores `{ pid, port, startedAt, version }`.
- **Startup guard** (`detectExistingInstance`) runs *before* `app.listen`:
  1. Read lock file → if PID alive AND `/api/health` returns `service: "agent-zero"` on the stored port → exit 0.
  2. Prioritized check on preferred `PORT` (2.5 s timeout — handles cold-socket delays on Windows).
  3. Parallel port-scan 3000–3020 (1.5 s each) for any Agent Zero signature.
  4. Any hit → log and `process.exit(0)` (Task Scheduler sees success, no notification).
- **Listen-error fallback**: if another process wins the port race *after* our pre-check, the `EADDRINUSE` handler re-pings the port. If it's Agent Zero → exit 0. Otherwise clear error message.
- **Defensive lock cleanup**: only removes the lock file if `pid` matches the current process — avoids racing with another instance.
- **`/api/health`** now includes `service: "agent-zero"` and `port`, used as the signature by both the batch script and the server's own guard.

### Fix — `START-AGENT-ZERO.bat`
- **Step 1** now parses `.agent-zero.lock` via PowerShell (JSON), verifies the PID is alive, and hits `/api/health` — the exact same mechanism the server uses.
- **Step 2** new: PowerShell-based port-scan 3000–3020 for the `service: "agent-zero"` signature, so the script detects existing instances even without a lock file (e.g., when the lock was manually deleted).
- Zombie-cleanup logic preserved for true stuck processes.
- Final-result path unchanged: browser opens to the detected or freshly-started port.

### Task Scheduler recommendation
Open the scheduled task → "Settings" tab → set **"If the task is already running, then the following rule applies: Do not start a new instance."** This provides a third line of defense.

### Files touched
- `package.json` — version 4.0.1 → 4.0.2
- `server.js` — added lock-file + startup guard + health signature (+ ~130 lines before `app.listen`)
- `START-AGENT-ZERO.bat` — replaced with lock-file-aware version
- `.gitignore` — ignore `.agent-zero.lock`

### Verified end-to-end
- Fresh start → lock file written, `/api/health` exposes `service: "agent-zero"`, `port`, `pid`.
- Duplicate `node server.js` attempt → detected via lockfile in ~50 ms → `exit 0`, no MCP subprocess started, no error.
- Manually deleted lock → duplicate attempt → detected via portscan-primary (2.5 s) → `exit 0`.
- `.bat` double-click while running → step 1 lock check fires → browser opens, no new process.

---

## v4.0.1 — April 22, 2026

**Merge and Consolidate now survive browser refresh**

### Problem diagnosed
v4.0.0 moved `scan` to the server-side job orchestrator, but two other long-running AI calls were overlooked:

- **`POST /api/tasks/merge`** — up to 90 s `session.sendAndWait` (AI generates unified summary). Pure request/response: no job registration, no persistence, no SSE.
- **`POST /api/consolidate`** — up to 300 s AI analysis for the standalone "Find Duplicates" button. Same pattern.

Symptoms reported by the user:
1. Start a manual merge from the bottom merge-bar.
2. Press F5 while the AI is composing the merged summary.
3. UI completely forgets the merge was running — no progress indicator, no success notification when the server finishes ~60 s later.
4. The merge itself *did* complete server-side (tasks.json reflected the merge), but the user had no feedback and couldn't tell whether to retry.

Additionally, there was no idempotency — a double-click could start two parallel merges.

### Code — server.js
- **`runMergeJob(job)`** new runner (same shape as `runScanJob`): delegates to the existing `POST /api/tasks/merge` via internal HTTP, emits `job.started` / `job.completed` / `job.failed`, persists snapshot to `jobs.json`, releases singleton on completion. Input: `{ taskIds, suggestedTitle? }`. Result payload: `{ taskId, title }`.
- **`runConsolidateJob(job)`** new runner: delegates to `POST /api/consolidate`. Result payload: `{ suggestions: [...] }`.
- **`POST /api/jobs`** generalised via `SUPPORTED_JOB_KINDS = { scan, merge, consolidate }`. Per-kind input validation (merge requires ≥2 taskIds). Singleton guard + idempotency already existed — they now cover all three kinds.
- **Legacy endpoints `POST /api/tasks/merge` and `POST /api/consolidate` are unchanged**: still synchronous, still used by the runners via internal HTTP, still called by `runScanJob` Phase 4. No business logic duplicated.

### Code — index.html
- **`triggerFindDuplicates()`** rewritten to `POST /api/jobs` with `kind: 'consolidate'` and a `clientRequestId`. Returns immediately with a 202 + `jobId`; SSE drives the completion UI.
- **`executeMergeFromBar()`** rewritten the same way: `kind: 'merge'`, `input: { taskIds }`. State stored in `activeMergeJob = { jobId, taskIds, source: 'bar' | 'banner' }` so the completion handler knows whether to exit merge-mode or remove a suggestion card.
- **`handleMerge(btn)`** (from the Find Duplicates suggestion banner) — same refactor. `source: 'banner'`; on completion, the matching card is removed by `data-merge-job-id` attribute.
- **`handleConsolidateJobEvent(ev)`** and **`handleMergeJobEvent(ev)`** — new SSE handlers mirrored from `handleScanJobEvent`. Surface `job.completed` → notification + task refresh + UI reset; `job.failed` → error notification + button re-enable.
- **`handleJobEvent`** routing extended: `ev.kind === 'consolidate'` and `ev.kind === 'merge'` are dispatched before the task-centric branch.
- **`hydrateGlobalJobs()`** extended: after reload, restores `activeConsolidateJob` / `activeMergeJob` from the server snapshot, re-renders the progress banner, disables the "Find Duplicates" button while a consolidate is in flight, and shows the header progress bar for in-flight merges. When the server finishes, SSE completes the cycle.

### Behavioural impact
- **F5 during a merge or duplicate-search is safe.** The server keeps working, the client re-paints the progress indicator within ~1 s via `hydrateGlobalJobs()`, and the SSE stream delivers the completion event.
- **Double-click on Merge or Find Duplicates is no-op.** The `clientRequestId` is enforced by the server's idempotency cache, and the `tryAcquireSingleton(kind)` guard returns 409 on concurrent attempts.
- **User receives a success notification** when the merge finishes, even after a mid-flight refresh.
- **No new logs needed** — merge / consolidate already log via `debugLog('MERGE'|'PHASE4', ...)` inside the legacy endpoints, which the new runners invoke.

### Tests
- `npm test` — 7/7 lifecycle tests pass unchanged (the `Job` class, idempotency, singleton, persistence logic were already generic).
- `node tests/runs/check-html.cjs` — inline `<script>` block parses cleanly.
- `node --check server.js` — passes.
- E2E validation run (`tests/runs/e2e-v4-0-1.mjs`): opens the UI, confirms v4.0.1 label, triggers a full scan, observes phase transitions via `/api/jobs?active=true`, reloads the page mid-flight to exercise hydration.

### Documentation
- `ARCHITECTURE.md` — "Scan Resilience Architecture" renamed to "Job Orchestrator" and extended with `merge` / `consolidate` kinds.
- `AGENT_ZERO_SPEC.md` — version + status line updated.
- `README.md`, `AGENTS.md` — version bumped to 4.0.1.
- `package.json` — version bumped to 4.0.1.

---

## v4.0.0 — April 22, 2026

**Server-Side Job Registry — Scan + Log-Jobs survive browser refresh**

### Problem diagnosed
The pre-v4 scan was a client-side `for`-loop over phases. Closing the tab or even an F5 killed the whole orchestration mid-flight, leaving tasks in transient states (`enriching`, `checking`) that were only cleaned up on the next scheduled scan. Log-jobs (per-task "search inbox" requests) had the same issue: the visual "⏳ Agent working…" indicator disappeared on any re-render because `updateTaskJobUi` painted DOM directly without updating `frozenTasks`, and `hydrateActiveJobs` on reload was never actually invoked on the boot path and also read `jobId` incorrectly from a structured `activeJob` object.

### Code — server.js (PR1)
- **Job foundation** (`Job` class, `jobs` Map, `jobsByTask` Map, `activeJobByTask` Map, `idempotencyMap`): every `scan` / `log` / `consolidate` / `check` run is modelled as a `Job` with lifecycle (`queued → running → awaiting_input | completed | failed | cancelled`), monotonically-increasing `lastJobEventId`, and a persisted snapshot on `task.activeJob` (for per-task jobs) or in `jobs.json` (for global jobs).
- **SSE broker** (`sseBroker`): `GET /api/events?since=<id>` opens a long-lived stream; events are fanned out with a per-event `globalEventSeq` so the client can resume at exactly the right cursor after reconnect (sessionStorage-seeded before `startSSE()`).
- **Endpoints**: `POST /api/jobs/scan` (singleton-protected, 409 on conflict), `POST /api/jobs/log`, `POST /api/jobs/check`, `GET /api/jobs/:id`, `GET /api/jobs?active=true`, `POST /api/jobs/:id/cancel`, `POST /api/jobs/:id/reply` (for `awaiting_input`).
- **Phase γ.F boot recovery**: on restart, any `task.activeJob` that was `queued` or `running` is marked `interrupted` in `jobHistory` and cleared so the UI shows a clean state; the next scan picks the task up again via the phase-independent filters.
- **Scan runner** (`runScanJob`): moved the four-phase orchestration server-side. Phase 1 discovery, Phase 2 enrichment with auto-recovery, Phase 3 update-check with per-session query budget + stub auto-restart, Phase 4 consolidate. Emits `phase_started` / `phase_done` / `item_started` / `item_done` / `completed` / `failed` / `cancelled`.
- **Singleton protection**: a module-level `scanSingleton` rejects a second scan cluster-wide (not just per tab) and returns the existing `jobId` so re-clicks are idempotent.

### Code — index.html (PR1 → PR1d)
- **SSE client**: persistent `EventSource('/api/events?since=<cursor>')` with cursor seeded from `sessionStorage`; automatic reconnect with exponential backoff; dispatches `handleScanJobEvent` (for `kind === 'scan'`) and `handleJobEvent` (for per-task jobs).
- **`hydrateActiveJobs()` (PR1c)**: correctly reads `jobId` from the `task.activeJob` **object** (was treating it as a string → `/api/jobs/[object Object]` → 404 → silently dropped). Re-paints frozen badge and awaiting_input UI for every running job.
- **Boot-path hydration (PR1d)**: `checkServerHealth()` now calls `hydrateActiveJobs()` after `renderTasks()` — previously only `fetchTasks()` did this, so a hard-refresh on a page that never called `fetchTasks()` left indicators blank.
- **`updateTaskJobUi` (PR1b)**: now adds/removes `taskId` in `frozenTasks` in lockstep with card state. This makes the DOM-preservation branch in `renderTasks` apply to log-jobs, not just to client-side-frozen tasks. Respects `window.__scanHoldsFreezeFor` so a scan `item_started` / `item_done` cycle on a task doesn't steal the freeze of a parallel log-job (or vice-versa).
- **`refreshSingleTask` (PR1b)**: skips `oldCard.replaceWith(newCard)` when the task is in `frozenTasks`; data is still updated in `tasks[idx]` and the next `unfreezeTask` re-renders. Eliminates the visible ~500ms gap where badges/step-dots were nuked and re-attached asynchronously.
- **`handleScanJobEvent` (PR1b)**: `item_started` sets `window.__scanHoldsFreezeFor = taskId` and calls `freezeTask`; `item_done` clears the sentinel, releases the scan's freeze (only if no log-job is still active on the same task), and replaces the blunt `fetchTasks()` refresh with a surgical `refreshSingleTask(taskId)`.

### Code — server.js build marker (PR1c → PR1d)
- `GET /api/version` now returns the short git SHA alongside version + name. Resolved via `execSync('git rev-parse --short HEAD', { cwd: __dirname })` with a filesystem-walk-up fallback that reads `.git/HEAD` one parent level up (Agent_Zero is a sub-folder of the Work_IQ repo root, so the local dir has no `.git`). `execSync` imported as ESM (`import { spawn, execSync } from 'child_process'`), not `require()` — the server is `type: "module"`.
- Boot log prints `[Agent Zero] Build commit: <sha>` to stdout for diagnostics.

### UI — index.html
- Footer version element now displays `v4.0.0 (<sha>)` with the short commit SHA. Tooltip: "Build `<sha>` — reload to refresh". Console log: `[Agent Zero] v4.0.0 build <sha>`. This makes it trivially verifiable whether a given browser session is serving the expected build (important for diagnosing cache issues after a push).

### Tests
- New unit tests in `tests/unit/job-lifecycle.mjs` (7 tests, all passing):
  - Job construction (id, queued status, null progress)
  - Snapshot shape (progress field always present)
  - `emit()` monotonicity (`lastJobEventId` + `globalEventSeq`)
  - Cancel transition (`queued → cancelling`, idempotent)
  - Idempotency cache (new / hit / conflict)
  - Singleton acquire/refuse/release
  - `persistGlobalJobSnapshot` JSON round-trip
- `tests/runs/check-html.cjs` — validates that `<script>` blocks in `index.html` parse as valid JavaScript (PR1b–PR1d touched inline script).

### Documentation
- `ARCHITECTURE.md` — "Scan Resilience Architecture" section rewritten to describe the server-side job registry, SSE with cursor continuity, `hydrateGlobalJobs` + `hydrateActiveJobs` on boot, `frozenTasks` preservation invariant, and build marker.
- `AGENT_ZERO_SPEC.md` — version + status line updated.
- `README.md`, `AGENTS.md`, `BUBBLE_EDITOR_GUIDE.md` — version bumped to 4.0.0.
- `package.json` — version bumped to 4.0.0.

### Behavioural impact
- **F5 and Ctrl+Shift+R are safe during any scan or log-job.** The server keeps running, the UI re-paints the "⏳ Agent working…" badge and step-active dot within ~1 second, and SSE resumes at the correct cursor.
- Closing the browser entirely no longer leaves tasks stuck in `enriching` / `checking` — the server-side job keeps progressing, and the next client to load sees the correct state.
- Visual indicators no longer flicker when a scan runs in parallel to a log-job on the same (or a different) task.

### Known limitations (deferred)
- **Review-resolution summary update**: resolving open review items on an action item currently triggers a search but does not auto-update the task summary. Tracked for a separate PR.
- **WorkIQ service timeouts**: recurring 90s timeouts in Phase 3 and Teams searches are a WorkIQ infrastructure issue, not an Agent Zero bug. The existing 3-strike retry strategy is correct; migration to a newer WorkIQ version is being evaluated separately.

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
