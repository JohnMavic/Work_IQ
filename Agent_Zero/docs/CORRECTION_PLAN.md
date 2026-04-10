# Agent Zero — Correction Plan v2.0

> **Created:** 2026-04-09, **Updated:** 2026-04-10 by Martin Hämmerli + Copilot CLI  
> **Purpose:** Fix remaining reliability issues in Agent Zero phases, then iteratively test until all phases run perfectly.  
> **Location:** E:\Work_IQ\Agent_Zero

---

## Quick Instructions for Copilot CLI (English)

Read this entire plan first. Then execute the corrections in the order listed (Fix 1 through Fix 5). After EACH fix:
1. Restart the server (close browser tab first!)
2. **Immediately enable debug logging:** `POST http://localhost:3000/api/debug-log` with body `{"enabled":true}` — verify it returns `{"enabled":true}`
3. Run the affected phase via Playwright browser interactions
4. Analyze `logs/debug.log` for errors
5. If errors found → fix and repeat. If clean → proceed to next fix.

**Debug logging MUST be ON for every single test run — no exceptions.**

Do NOT change working code — only fix the specific issues described. Always backup `tasks.json` before testing and restore after. When stopping the server, only kill Agent Zero processes (match `server.js` + `Agent_Zero` in command line), NEVER kill other servers running on the machine.

---

## Context — What Works and What Doesn't

### Architecture Overview
- **Phase 1 (Scan):** Uses `askWorkIQDirect()` — direct queries to persistent WorkIQ MCP subprocess. Fast (~50s). ✅ Works well.
- **Phase 2 (Enrich):** Uses Copilot SDK + `askWorkIQTool`. SDK orchestrates multi-step M365 search. ~60-140s per task. ✅ Works.
- **Phase 3 (Update-Check):** Same as Phase 2. ✅ Works but suffers from 41-char error cascades.
- **Phase 4 (Consolidate):** Uses Copilot SDK without WorkIQ. Pure AI reasoning. ❌ Timeouts at 180s.
- **Merge:** Uses Copilot SDK without WorkIQ. ✅ Works (17-58s).
- **EVAL-P3:** Post-Phase-3 refinement step. Opens new SDK session per updated task. ⚠️ Needs serialization.
- **User Actions (Log Work, Execute):** Uses SDK + WorkIQ. ⚠️ Not logged, Execute shows 3× loop behavior.

### What Already Works (DO NOT CHANGE)
- Phase 1 direct WorkIQ queries (parallel email + Teams)
- `mcp.json` pointing to local `@microsoft/workiq@0.2.8`
- `startWorkIQMCP()` spawning local binary
- Timeout values (already increased from 30s to 60-90s in v3.1)
- `safeWriteTasks()` promise chain for data integrity
- Debug logger infrastructure (`debugLog()` + GUI toggle + `logs/debug.log`)
- Phase pipeline in `index.html` (sequential: P1 → P2 → P3 → P4)
- Skill prompts in `docs/*.md` — DO NOT MODIFY

### Key Files
- `E:\Work_IQ\Agent_Zero\server.js` — all server logic
- `E:\Work_IQ\Agent_Zero\index.html` — GUI + phase orchestration
- `E:\Work_IQ\Agent_Zero\mcp.json` — WorkIQ MCP config for SDK sessions
- `E:\Work_IQ\Agent_Zero\logs/debug.log` — debug output when logger is ON

---

## Fix 1: 41-Char Error — Cooldown Instead of Restart-Loop

### What Happens
WorkIQ sometimes returns exactly 41 chars: `"An error occurred invoking 'ask_work_iq'."`. The current code detects this and restarts the subprocess — but the new subprocess ALSO returns 41 chars, creating an endless restart loop (observed: 18 consecutive restarts over 7 minutes, destroying other sessions' queries).

### Evidence from Logs (2026-04-10)
```
[08:36:23] Got 41-char error (consecutive: 8) — triggering subprocess restart
[08:37:44] Got 41-char error (consecutive: 10) — triggering subprocess restart
[08:38:24] Got 41-char error (consecutive: 11) — triggering subprocess restart
...
[08:43:03] Got 41-char error (consecutive: 18) — triggering subprocess restart
```
Each restart kills the subprocess while OTHER queries from other SDK sessions are still pending → those queries fail with `"Work IQ subprocess exited"`.

### Fix Required
In `askWorkIQDirect()` resolve handler (server.js), replace the current "restart on every 41-char" with a **cooldown strategy**:

```javascript
let wiq41charCount = 0;
let wiqCooldownUntil = 0;

// In resolve handler:
if (text === "An error occurred invoking 'ask_work_iq'.") {
  wiq41charCount++;
  debugLog('WORKIQ-QUERY', `Got 41-char error (count: ${wiq41charCount})`);
  
  if (wiq41charCount <= 3) {
    // First 3 times: restart subprocess
    if (wiqProc) { try { wiqProc.kill(); } catch {} }
    reject(new Error('WorkIQ unhealthy — restarting'));
  } else {
    // After 3 failed restarts: enter 60s cooldown, stop restarting
    wiqCooldownUntil = Date.now() + 60000;
    debugLog('WORKIQ-QUERY', `Entering 60s cooldown (${wiq41charCount} consecutive failures)`);
    reject(new Error('WorkIQ temporarily unavailable — cooling down'));
  }
  return;
}
// Success → reset counter
wiq41charCount = 0;
```

In `askWorkIQDirect()` at the top, check cooldown:
```javascript
if (Date.now() < wiqCooldownUntil) {
  return reject(new Error('WorkIQ in cooldown — try again later'));
}
```

### Verification
1. Enable debug logging, run full Scan (P1→P2→P3→P4)
2. If 41-char errors occur: log should show max 3 restarts, then "cooldown" message
3. NO more than 3 subprocess restarts in a row
4. Other sessions' queries should NOT fail with "subprocess exited" during cooldown

---

## Fix 2: Session Limit (Max 2 Concurrent SDK Sessions)

### What Happens
The log shows up to 4 simultaneous SDK sessions (`total active: 4`). This happens when Phase 3 starts a new task check while the previous one is still retrying WorkIQ queries. Multiple sessions overwhelm the WorkIQ subprocess.

### Evidence from Logs
```
[08:39:05] SDK-SESSION Created (total active: 4)
```

### Fix Required
Add a simple semaphore that limits concurrent SDK sessions to 2:

```javascript
// At the top of server.js, near the session tracking code:
const MAX_CONCURRENT_SDK = 2;

async function waitForSDKSlot() {
  while (activeSessions.size >= MAX_CONCURRENT_SDK) {
    debugLog('SDK-SESSION', `Waiting for slot (${activeSessions.size}/${MAX_CONCURRENT_SDK} active)`);
    await new Promise(r => setTimeout(r, 2000));
  }
}
```

Call `await waitForSDKSlot()` before every `new CopilotClient()` in these endpoints:
- `/api/tasks/:id/enrich` (Phase 2)
- `/api/tasks/:id/check-update` (Phase 3)
- `/api/consolidate` (Phase 4)
- `/api/tasks/merge`
- EVAL-P3 evaluation sessions

Do NOT add it to user-initiated endpoints (`/api/tasks/:id/log`, `/api/tasks/:id/review`, `/api/tasks/:id/correct`) — user actions should never be blocked by background phases.

### Verification
1. Run full Scan pipeline
2. Check log: `total active` should never exceed 2
3. Should see `"Waiting for slot"` messages when phases queue up
4. All phases should still complete (just sequentially instead of overlapping)

---

## Fix 3: Phase 4 Timeout (180s → 300s)

### What Happens
Phase 4 (Consolidate) sends all active tasks as JSON to the SDK. Even with reduced context (8883 chars), it still times out at 180s.

### Evidence from Logs
```
[08:43:10] PHASE4 START consolidate (20 tasks, prompt: 8883 chars)
[08:46:11] PHASE4 FAILED consolidate: Timeout after 180000ms
```

### Fix Required
Increase timeout from 180000 to 300000 in the `/api/consolidate` endpoint:

```javascript
const response = await session.sendAndWait({ prompt }, 300000);  // was 180000
```

Also reduce summary context from 500 to 150 chars to keep prompts smaller:
```javascript
summary: (t.summary || '').substring(0, 150),  // was 500
```

### Verification
1. Run full Scan → wait for Phase 4
2. Log should show `DONE consolidate` (not `FAILED`)
3. Prompt size should be <12,000 chars

---

## Fix 4: Log User Actions (Log Work, Execute, Review)

### What Happens
User interactions (Log Work, Execute button, Review responses) are NOT captured in the debug log. This makes it impossible to diagnose the "Execute asked 3 times" bug.

### Evidence
The user reported clicking Execute 3 times for the Cisco SSD task, but the debug log shows zero entries for this interaction — only the WorkIQ queries that resulted from it.

### Fix Required
Add `debugLog()` calls to these endpoints in server.js:

**`/api/tasks/:id/log/analyze`** (Log Work — intent analysis):
```javascript
debugLog('USER-ACTION', `Log Work analyze: "${text.substring(0, 80)}" for task "${task.title.substring(0, 50)}"`, { taskId: id });
```

**`/api/tasks/:id/log`** (Log Work — execution):
```javascript
debugLog('USER-ACTION', `Log Work execute: intent=${intent} for task "${task.title.substring(0, 50)}"`, { taskId: id });
```

After the execute completes:
```javascript
debugLog('USER-ACTION', `Log Work DONE: intent=${intent}, result=${success ? 'OK' : 'FAILED'}`, { taskId: id });
```

**`/api/tasks/:id/review`** (Review response):
```javascript
debugLog('USER-ACTION', `Review response for "${task.title.substring(0, 50)}": "${response.substring(0, 80)}"`, { taskId: id });
```

### Verification
1. Enable debug logging
2. Open a task, type a message, click Execute
3. Check `logs/debug.log` — should see `USER-ACTION` entries with task ID, intent, and result
4. If Execute loops: the log will show multiple `Log Work execute` entries → root cause visible

---

## Fix 5: EVAL-P3 Stabilization

### What Happens
EVAL-P3 opens a NEW Copilot SDK session for each task that Phase 3 found an update for. If many tasks have updates, multiple EVAL-P3 sessions run simultaneously, competing for SDK resources.

### Fix Required
Two changes:

**a) Increase EVAL-P3 timeout from 60s to 90s:**
Find the `evalSession.sendAndWait` call inside the Phase 3 update-check handler (around line 1423) and change to 90000.

**b) EVAL-P3 must respect the session limit from Fix 2:**
Add `await waitForSDKSlot()` before creating the EVAL-P3 `CopilotClient`. This automatically serializes EVAL-P3 with other SDK operations.

### Verification
1. Run Scan with tasks that have pending updates
2. Check log: EVAL-P3 sessions should appear one at a time, never overlapping
3. No EVAL-P3 timeouts in the log

---

## Testing Protocol — MANDATORY after ALL fixes are applied

### Setup (EVERY test run)
1. Backup: `copy tasks.json tasks.TEST-BACKUP.json`
2. **CRITICAL — Enable debug logging FIRST:**
   ```powershell
   Invoke-RestMethod -Uri 'http://localhost:3000/api/debug-log' -Method POST -Body '{"enabled":true}' -ContentType 'application/json'
   ```
   **Verify** it returns `{"enabled":true}` before proceeding.
3. Clear old logs: delete `logs/debug.log`

### Test A: Full Pipeline (no intervention)
1. Close browser tab → restart server → open browser
2. Click Scan button
3. Wait for ALL phases to complete (Phase 1 → 2 → 3 → 4)
4. Analyze `logs/debug.log`:
   - ✅ All phases show START + DONE pairs
   - ✅ No `FAILED` entries (except planned cooldowns)
   - ✅ `total active` sessions never exceeds 2
   - ✅ Max 3 consecutive subprocess restarts, then cooldown
   - ✅ Memory stays below 100MB
   - ✅ Phase 4 completes (not timeout)

### Test B: User Intervention During Phase 2
1. Restart server, open browser, click Scan
2. Wait until "Phase 2: Enriching (X/Y)" is visible in GUI
3. Open a DIFFERENT task and type: "Are there any updates about this in my inbox?"
4. Click Execute
5. Verify in log:
   - ✅ `USER-ACTION` entries visible
   - ✅ Both enrich AND user question succeed
   - ✅ No server crash

### Test C: Merge During Phase 3
1. Create 2 fake enriched tasks in tasks.json (known titles/content)
2. Restart server, click Scan
3. Wait until Phase 3 is running
4. Merge the 2 fake tasks via "Find Duplicates" or direct API call
5. Verify in log:
   - ✅ Merge completes while Phase 3 continues
   - ✅ `total active` stays ≤ 2

### Test D: Execute Loop Verification
1. Restart server, enable debug logging
2. Open the Cisco SSD task (or any task with summary)
3. Type an update instruction and click Execute
4. Verify in log:
   - ✅ Only ONE `Log Work execute` entry per user click
   - ✅ No repeated execute cycles for the same message

### Pass Criteria
ALL four tests must pass. If ANY test fails:
1. Read the EXACT error from `logs/debug.log`
2. Identify which fix addresses it
3. Adjust the fix
4. Re-run the failing test
5. Do NOT proceed until it passes

### After All Tests Pass
1. Restore `tasks.json` from backup
2. Disable debug logging
3. Commit: `v3.2.0: Subprocess health management, session limits, user action logging`
4. Push to GitHub (verify no secrets first)

---

## Summary of Changes

| # | What | Where | Risk |
|---|------|-------|------|
| 1 | 41-char cooldown (max 3 restarts, then 60s pause) | `askWorkIQDirect()` | Low — only error path |
| 2 | Session limit (max 2 concurrent SDK sessions) | New `waitForSDKSlot()` + all SDK-using endpoints | Low — wrapping only, no logic change |
| 3 | Phase 4 timeout 180s→300s + summary 500→150 chars | `/api/consolidate` | Null — only numbers |
| 4 | Log user actions (Log Work, Execute, Review) | `/api/tasks/:id/log`, `/api/tasks/:id/review` | Null — only adds logging |
| 5 | EVAL-P3: timeout 60s→90s + session limit | Phase 3 eval handler | Low — timeout + wrapping |

Total: ~50 lines of code changes. No changes to Phase 1 logic, Phase 2 logic, skill prompts, or data handling.
