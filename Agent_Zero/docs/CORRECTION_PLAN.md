# Agent Zero — Correction Plan v1.0

> **Created:** 2026-04-09 by Martin Hämmerli + Copilot CLI
> **Purpose:** Fix remaining reliability issues in Agent Zero phases, then iteratively test until all phases run perfectly.
> **Location:** E:\Work_IQ\Agent_Zero

---

## Quick Instructions for Copilot CLI (English)

Read this entire plan first. Then execute the corrections in the order listed. After each correction, restart the server, **immediately enable debug logging** by calling `POST http://localhost:3000/api/debug-log` with body `{"enabled":true}`, then run the affected phase, analyze `logs/debug.log`, and fix any issues found. Repeat until each phase runs cleanly. Do NOT change working code — only fix the specific issues described. Test with real browser interactions via Playwright. Always backup `tasks.json` before testing and restore after. **Debug logging MUST be ON for every single test run — no exceptions.**

---

## Context — What Works and What Doesn't

### Architecture Overview
- **Phase 1 (Scan):** Uses `askWorkIQDirect()` — direct queries to persistent WorkIQ MCP subprocess. Fast (~50s). Works well.
- **Phase 2 (Enrich):** Uses Copilot SDK + `askWorkIQTool`. SDK orchestrates multi-step M365 search. Slow (~140s per task) but works.
- **Phase 3 (Update-Check):** Same as Phase 2. Works but suffers from 41-char error responses.
- **Phase 4 (Consolidate):** Uses Copilot SDK without WorkIQ. Pure AI reasoning. Works after timeout fix.
- **Merge:** Uses Copilot SDK without WorkIQ. Works after timeout fix.

### What Already Works (DO NOT CHANGE)
- Phase 1 direct WorkIQ queries (parallel email + Teams)
- `mcp.json` pointing to local `@microsoft/workiq@0.2.8`
- `startWorkIQMCP()` spawning local binary via `process.execPath`
- All timeout values (already increased from 30s to 60-90s)
- `safeWriteTasks()` promise chain for data integrity
- Debug logger (`debugLog()` + GUI toggle + `logs/debug.log`)
- Phase pipeline in `index.html` (sequential: P1 → P2 → P3 → P4)

### Key Files
- `E:\Work_IQ\Agent_Zero\server.js` — all server logic
- `E:\Work_IQ\Agent_Zero\index.html` — GUI + phase orchestration
- `E:\Work_IQ\Agent_Zero\mcp.json` — WorkIQ MCP config for SDK sessions
- `E:\Work_IQ\Agent_Zero\docs/*.md` — skill prompts (DO NOT MODIFY)
- `E:\Work_IQ\Agent_Zero\logs/debug.log` — debug output when logger is ON

---

## Problem 1: 41-Character Error Responses

### What Happens
The persistent WorkIQ MCP subprocess sometimes returns exactly 41 characters: `"An error occurred invoking 'ask_work_iq'."` instead of real M365 data. This is NOT a query problem — the same queries work perfectly after a subprocess restart.

### When It Happens
- After the subprocess has been running for a long time under load
- After a memory crash (exit code 3221225478 = Windows Access Violation)
- When many SDK sessions have been created and destroyed

### Current Behavior (BAD)
The SDK sees the 41-char response and retries with shorter queries — 5-6 retries × 30 seconds each = 150-250 seconds wasted per task, for zero result.

### Fix Required
In `askWorkIQDirect()` (server.js, around line 154), detect the 41-char error response and trigger a subprocess restart instead of returning the error to the caller:

```javascript
// In the resolve handler of askWorkIQDirect:
resolve: (msg) => {
  const text = msg.result?.content?.[0]?.text || '';
  // Detect the known WorkIQ error response
  if (text === "An error occurred invoking 'ask_work_iq'.") {
    debugLog('WORKIQ-QUERY', 'Got 41-char error — triggering subprocess restart');
    // Kill and restart the subprocess
    if (wiqProc) { try { wiqProc.kill(); } catch {} }
    reject(new Error('WorkIQ subprocess unhealthy — restarting'));
    return;
  }
  // ... rest of existing logic
}
```

Additionally, add a counter: if 3 consecutive queries return 41 chars, proactively restart the subprocess even if individual queries didn't trigger the restart.

### Verification
1. Enable debug logging
2. Run a full Phase 3 cycle (Scan button → wait for Phase 3)
3. Check `logs/debug.log` — should see NO 41-char responses
4. If 41-char detected → should see `"triggering subprocess restart"` followed by recovery

---

## Problem 2: WorkIQ Subprocess Crash (Access Violation)

### What Happens
The WorkIQ binary crashes with exit code 3221225478 (Windows Access Violation) after extended use. The auto-restart mechanism works but sometimes fails with `spawn ENOENT` because `process.execPath` becomes unavailable.

### Fix Required
In `startWorkIQMCP()`, cache the Node.js executable path at startup instead of using `process.execPath` dynamically:

```javascript
// At the top of server.js, after imports:
const NODE_PATH = process.execPath; // Cache once at startup

// In startWorkIQMCP():
wiqProc = spawn(NODE_PATH, [workiqScript, 'mcp'], { ... });
```

Also limit the auto-restart loop to max 5 attempts with exponential backoff:

```javascript
let wiqRestartCount = 0;
const MAX_RESTARTS = 5;

// In the close handler:
if (wiqRestartCount >= MAX_RESTARTS) {
  console.error('[WORKIQ] Max restart attempts reached. Manual restart required.');
  debugLog('WORKIQ', 'Max restart attempts reached');
  return;
}
wiqRestartCount++;
const delay = Math.min(3000 * wiqRestartCount, 15000);
setTimeout(() => { startWorkIQMCP().then(() => { wiqRestartCount = 0; })... }, delay);
```

### Verification
1. Run the server for an extended period (>1 hour)
2. If crash occurs, check log: should see restart with backoff, not infinite loop
3. `wiqRestartCount` should reset to 0 after successful restart

---

## Problem 3: Phase 4 Timeout with Large Prompts

### What Happens
Phase 4 (Consolidate) sends ALL active tasks as JSON to the SDK. With 25+ tasks, the prompt exceeds 20,000 chars. This can cause timeouts even with the 180s limit.

### Fix Required
Limit the task context sent to Phase 4. Instead of full 500-char summaries, send only titles + first 100 chars of summary:

In the `/api/consolidate` endpoint (server.js, around line 1590):
```javascript
const taskContext = activeTasks.map(t => ({
  id: t.id,
  title: t.title,
  summary: (t.summary || '').substring(0, 100),  // was 500
  from: t.from,
  source: t.source
}));
```

### Verification
1. Enable debug logging
2. Run Phase 4 via Scan button
3. Check log: prompt size should be <10,000 chars (was 20,537)
4. Phase 4 should complete in <90s (was timing out at 180s)

---

## Testing Protocol — MANDATORY after each fix

### Setup (EVERY test run)
1. Backup: `copy tasks.json tasks.TEST-BACKUP.json`
2. **CRITICAL — Enable debug logging FIRST:**
   ```
   curl -X POST http://localhost:3000/api/debug-log -H "Content-Type: application/json" -d "{\"enabled\":true}"
   ```
   Or via PowerShell:
   ```powershell
   Invoke-RestMethod -Uri 'http://localhost:3000/api/debug-log' -Method POST -Body '{"enabled":true}' -ContentType 'application/json'
   ```
   **Verify** it returns `{"enabled":true}` before proceeding.
3. Clear old logs: delete `logs/debug.log`

### Test Sequence (repeat for each fix)

#### Test A: Full Pipeline
1. Close browser tab
2. Restart server
3. Open browser → click Scan
4. Wait for Phase 1 → Phase 2 → Phase 3 → Phase 4 to complete
5. Analyze `logs/debug.log`:
   - No 41-char responses
   - No subprocess crashes without recovery
   - All phases show START + DONE pairs
   - No `FAILED` entries

#### Test B: User Intervention During Phase 2
1. Restart server, open browser, click Scan
2. Wait until "Phase 2: Enriching (X/Y)" is visible
3. Open a task and ask: "Are there any updates about this in my inbox?"
4. Verify: both enrich AND user question succeed, no crash

#### Test C: Merge During Phase 3
1. Create 2 fake tasks (enriched, known content)
2. Restart server, click Scan
3. Wait until Phase 3 is running
4. Click "Find Duplicates" → merge the 2 fake tasks
5. Verify: merge succeeds AND Phase 3 continues

### Pass Criteria
- ALL phases complete without errors
- No 41-char error responses (or immediate recovery if they occur)
- User interventions work during active phases
- Server stays alive through entire pipeline
- Memory stays below 100MB
- `logs/debug.log` shows clean lifecycle: START → queries → DONE for every operation

### If a Test Fails
1. Read the EXACT error from `logs/debug.log`
2. Identify which fix addresses it
3. Apply the fix
4. Repeat the test
5. Do NOT proceed to the next fix until current test passes

### After All Tests Pass
1. Restore `tasks.json` from backup
2. Disable debug logging
3. Commit with message: `v3.2.0: WorkIQ subprocess health management + Phase 4 optimization`
4. Push to GitHub

---

## Summary of Changes

| # | What | Where | Risk |
|---|------|-------|------|
| 1 | Detect 41-char error → restart subprocess | `askWorkIQDirect()` resolve handler | Low — only affects error path |
| 2 | Cache `NODE_PATH` + limit restart attempts | `startWorkIQMCP()` + close handler | Low — only affects restart logic |
| 3 | Reduce Phase 4 prompt size (500→100 chars) | `/api/consolidate` endpoint | Low — only affects context length |

Total: ~30 lines of code changes. No changes to Phase 1, Phase 2, Phase 3 logic, prompts, or data handling.
