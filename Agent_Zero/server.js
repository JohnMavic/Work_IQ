import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { CopilotClient, approveAll, defineTool } from '@github/copilot-sdk';
import { spawn } from 'child_process';
import { EventEmitter } from 'events';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;
const TASKS_FILE = path.join(__dirname, 'tasks.json');
const NODE_PATH = process.execPath; // Cache once at startup — avoids spawn ENOENT after crash

// --- Debug Logger (v3.1) ---
// Toggle via /api/debug-log or GUI. Writes to logs/ folder.
let DEBUG_LOG = false;
const LOG_DIR = path.join(__dirname, 'logs');
const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5MB rotation

function debugLog(category, message, data = null) {
  if (!DEBUG_LOG) return;
  const ts = new Date().toISOString();
  const mem = Math.round(process.memoryUsage().rss / 1024 / 1024);
  const sessions = activeSessions ? activeSessions.size : '?';
  let line = `[${ts}] [${category}] [mem:${mem}MB sess:${sessions} wiq:${wiqReady ? 'OK' : 'DOWN'}] ${message}`;
  if (data) line += ` | ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  line += '\n';
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const logFile = path.join(LOG_DIR, 'debug.log');
    // Rotate if too large
    try {
      const stat = fs.statSync(logFile);
      if (stat.size > MAX_LOG_SIZE) {
        const rotated = path.join(LOG_DIR, `debug-${ts.replace(/[:.]/g, '-')}.log`);
        fs.renameSync(logFile, rotated);
      }
    } catch {}
    fs.appendFileSync(logFile, line);
  } catch (err) {
    console.error(`[DEBUG-LOG] Write failed: ${err.message}`);
  }
}

// --- Work IQ Persistent MCP Client (v3.2) ---
// Spawns ONE workiq MCP subprocess at startup with proper stdio settings.
// The SDK's own MCP spawning uses windowsHide:true + all-piped stdio which
// blocks WAM auth. We spawn it ourselves with stderr inherited so WAM works.
// Auth happens ONCE, EULA accepted ONCE, then cached for the server lifetime.

let wiqProc = null;
let wiqStdout = '';
let wiqReady = false;
let wiqRequestId = 0;
const wiqPending = new Map(); // id → { resolve, reject, timer }
let wiq41ErrorCount = 0;    // consecutive 41-char error counter (global fallback for calls without taskId)
let wiqCooldownUntil = 0;   // timestamp: reject global queries until this time
// v3.4.0 — Phase α.1: per-task cooldowns so one failing task never blocks another.
// Task-scoped calls use these maps; task-less calls (Phase-1 scan) fall back to the global counter above.
const wiqTaskErrorCounts = new Map();   // taskId → consecutive 41-char errors
const wiqTaskCooldowns = new Map();     // taskId → cooldown-until-ms
const WIQ_TASK_COOLDOWN_MS = 60000;
const WIQ_TASK_ERROR_THRESHOLD = 4;
let wiqRestartCount = 0;    // auto-restart attempts since last clean start
const MAX_RESTARTS = 5;     // give up after this many consecutive failures
// v3.3.0: Stub-Recovery — after N consecutive EULA/permission stubs across
// all Phase-3 sessions, force-restart the WorkIQ subprocess. Without this,
// a degraded WorkIQ (process alive but returning stubs) blinds Phase 3 for
// the entire session lifetime (observed on 2026-04-20: 50 checks, all stub×1).
let consecutiveStubCount = 0;
const STUB_RESTART_THRESHOLD = parseInt(process.env.STUB_RESTART_THRESHOLD, 10) || 3;

// K2: EventEmitter for WorkIQ crash events — lets all active SDK sessions abort immediately
// instead of hanging for their full 600s timeout.
const wiqEvents = new EventEmitter();
wiqEvents.setMaxListeners(100); // Phase 2+3 can have many concurrent sessions listening

function startWorkIQMCP() {
  return new Promise((resolve, reject) => {
    // Use locally installed @microsoft/workiq@0.2.8 (pinned in package.json)
    // instead of npx which resolves to the latest cached version (0.4.0+).
    // The newer versions repeatedly prompt for WAM auth, causing timeouts.
    const workiqScript = path.join(__dirname, 'node_modules', '@microsoft', 'workiq', 'bin', 'workiq.js');
    console.log(`[WORKIQ] Starting persistent MCP subprocess (local: ${workiqScript})...`);
    debugLog('WORKIQ', `Starting subprocess`, { script: workiqScript, nodePath: NODE_PATH });
    wiqProc = spawn(NODE_PATH, [workiqScript, 'mcp'], {
      cwd: __dirname,
      stdio: ['pipe', 'pipe', 'inherit'], // stderr inherited → WAM can auth
    });

    wiqProc.on('error', (err) => {
      console.error('[WORKIQ] Subprocess error:', err.message);
      debugLog('WORKIQ', `Subprocess error: ${err.message}`, { code: err.code });
      wiqReady = false;
    });

    wiqProc.on('close', (code) => {
      console.warn(`[WORKIQ] Subprocess exited (code ${code})`);
      debugLog('WORKIQ', `Subprocess exited (code ${code}), pending requests: ${wiqPending.size}`);
      wiqReady = false;
      wiqProc = null;
      // Reject all pending requests
      for (const [id, pending] of wiqPending) {
        pending.reject(new Error('Work IQ subprocess exited'));
        clearTimeout(pending.timer);
      }
      wiqPending.clear();
      // K2: Signal all active SDK sessions so they abort immediately instead of hanging
      // for their full 600s timeout waiting for a WorkIQ that will never respond.
      wiqEvents.emit('wiq-down', new Error(`WorkIQ subprocess exited (code ${code})`));
      // Auto-restart with exponential backoff (max MAX_RESTARTS attempts)
      if (wiqRestartCount >= MAX_RESTARTS) {
        console.error('[WORKIQ] Max restart attempts reached. Manual restart required.');
        debugLog('WORKIQ', 'Max restart attempts reached — giving up');
        return;
      }
      wiqRestartCount++;
      const delay = Math.min(3000 * wiqRestartCount, 15000);
      console.log(`[WORKIQ] Auto-restarting (attempt ${wiqRestartCount}/${MAX_RESTARTS}) in ${delay}ms...`);
      setTimeout(() => {
        startWorkIQMCP().then(() => {
          console.log('[WORKIQ] ✅ Auto-restart successful');
          wiqRestartCount = 0;
          wiq41ErrorCount = 0; // K3: reset so restarted process doesn't echo-crash immediately
        }).catch(err => {
          console.error(`[WORKIQ] ⚠️ Auto-restart failed: ${err.message}`);
        });
      }, delay);
    });

    // Parse JSON-RPC responses from stdout
    wiqProc.stdout.on('data', (data) => {
      wiqStdout += data.toString();
      const lines = wiqStdout.split('\n');
      wiqStdout = lines.pop(); // keep incomplete line
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line.trim());
          if (msg.id !== undefined && wiqPending.has(msg.id)) {
            const pending = wiqPending.get(msg.id);
            clearTimeout(pending.timer);
            wiqPending.delete(msg.id);
            pending.resolve(msg);
          }
        } catch {}
      }
    });

    // Step 1: Initialize MCP
    const initId = ++wiqRequestId;
    wiqPending.set(initId, {
      resolve: (msg) => {
        console.log('[WORKIQ] MCP initialized:', msg.result?.serverInfo?.name || 'OK');
        // Step 2: Accept EULA
        const eulaId = ++wiqRequestId;
        wiqPending.set(eulaId, {
          resolve: (msg2) => {
            const text = msg2.result?.content?.[0]?.text || '';
            console.log('[WORKIQ] EULA:', text.substring(0, 60));
            wiqReady = true;
            resolve();
          },
          reject,
          timer: setTimeout(() => { wiqPending.delete(eulaId); reject(new Error('EULA timeout')); }, 15000)
        });
        wiqProc.stdin.write(JSON.stringify({
          jsonrpc: '2.0', id: eulaId, method: 'tools/call',
          params: { name: 'accept_eula', arguments: { eulaUrl: 'https://github.com/microsoft/work-iq-mcp' } }
        }) + '\n');
      },
      reject,
      timer: setTimeout(() => { wiqPending.delete(initId); reject(new Error('MCP init timeout')); }, 15000)
    });

    setTimeout(() => {
      wiqProc.stdin.write(JSON.stringify({
        jsonrpc: '2.0', id: initId, method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agent-zero', version: '3.2' } }
      }) + '\n');
    }, 1500);
  });
}

function askWorkIQDirect(question, timeoutMs = 90000, taskId = null) {
  const queryStart = Date.now();
  const shortQ = question.substring(0, 100);
  debugLog('WORKIQ-QUERY', `START "${shortQ}..."`, { timeoutMs, questionLen: question.length, taskId });
  return new Promise(async (resolve, reject) => {
    // Per-task cooldown check (only when taskId is provided) — isolates tasks from each other.
    if (taskId) {
      const taskCdUntil = wiqTaskCooldowns.get(taskId) || 0;
      if (Date.now() < taskCdUntil) {
        const remaining = Math.ceil((taskCdUntil - Date.now()) / 1000);
        debugLog('WORKIQ-QUERY', `Task ${taskId} in cooldown (${remaining}s remaining) — rejecting "${shortQ}..."`);
        return reject(new Error(`WorkIQ in cooldown for this task — try again in ${remaining}s`));
      }
      if (taskCdUntil > 0) {
        debugLog('WORKIQ-QUERY', `Task ${taskId} cooldown expired — resetting error counter`);
        wiqTaskErrorCounts.set(taskId, 0);
        wiqTaskCooldowns.delete(taskId);
      }
    }
    // Global cooldown check — safety net for calls without taskId (Phase 1 scan) and hard-stop across everything.
    if (Date.now() < wiqCooldownUntil) {
      const remaining = Math.ceil((wiqCooldownUntil - Date.now()) / 1000);
      debugLog('WORKIQ-QUERY', `Global cooldown (${remaining}s remaining) — rejecting "${shortQ}..."`);
      return reject(new Error('WorkIQ in cooldown — try again later'));
    }
    if (wiqCooldownUntil > 0) {
      debugLog('WORKIQ-QUERY', `Global cooldown expired — resetting counter, fresh start`);
      wiq41ErrorCount = 0;
      wiqCooldownUntil = 0;
    }
    if (!wiqReady || !wiqProc) {
      debugLog('WORKIQ-QUERY', `Not ready, waiting for recovery...`);
      console.log('[WORKIQ] Not ready, waiting up to 10s for auto-restart...');
      for (let i = 0; i < 10; i++) {
        await new Promise(r => setTimeout(r, 1000));
        if (wiqReady && wiqProc) break;
      }
      if (!wiqReady || !wiqProc) {
        debugLog('WORKIQ-QUERY', `FAILED: not ready after 10s wait`);
        return reject(new Error('Work IQ MCP not ready'));
      }
      debugLog('WORKIQ-QUERY', `Recovered after wait`);
      console.log('[WORKIQ] Recovered — proceeding with query');
    }
    const id = ++wiqRequestId;
    wiqPending.set(id, {
      resolve: (msg) => {
        const text = msg.result?.content?.[0]?.text || '';
        const elapsed = ((Date.now() - queryStart) / 1000).toFixed(1);
        // Detect the known WorkIQ subprocess health error (exactly 41 chars)
        if (text === "An error occurred invoking 'ask_work_iq'.") {
          // Increment per-task counter if scoped; always increment the global one as safety net.
          if (taskId) {
            const next = (wiqTaskErrorCounts.get(taskId) || 0) + 1;
            wiqTaskErrorCounts.set(taskId, next);
            debugLog('WORKIQ-QUERY', `Got 41-char error for task ${taskId} (task-count: ${next}) "${shortQ}..."`);
            if (next > WIQ_TASK_ERROR_THRESHOLD) {
              wiqTaskCooldowns.set(taskId, Date.now() + WIQ_TASK_COOLDOWN_MS);
              debugLog('WORKIQ-QUERY', `Task ${taskId} entering ${WIQ_TASK_COOLDOWN_MS / 1000}s cooldown after ${next} failures`);
              return reject(new Error('WorkIQ temporarily unavailable for this task — cooling down'));
            }
            return reject(new Error('WorkIQ: M365 returned no data for this query'));
          }
          wiq41ErrorCount++;
          debugLog('WORKIQ-QUERY', `Got 41-char error (global count: ${wiq41ErrorCount}) "${shortQ}..."`);
          if (wiq41ErrorCount <= WIQ_TASK_ERROR_THRESHOLD) {
            reject(new Error('WorkIQ: M365 returned no data for this query'));
          } else {
            wiqCooldownUntil = Date.now() + WIQ_TASK_COOLDOWN_MS;
            debugLog('WORKIQ-QUERY', `Entering ${WIQ_TASK_COOLDOWN_MS / 1000}s global cooldown after ${wiq41ErrorCount} consecutive failures`);
            reject(new Error('WorkIQ temporarily unavailable — cooling down'));
          }
          return;
        }
        // Healthy response — reset whichever counter applies.
        if (taskId) wiqTaskErrorCounts.set(taskId, 0);
        wiq41ErrorCount = 0;
        debugLog('WORKIQ-QUERY', `OK in ${elapsed}s (${text.length} chars) "${shortQ}..."`);
        if (text) resolve(text);
        else reject(new Error('Empty response from Work IQ'));
      },
      reject: (err) => {
        const elapsed = ((Date.now() - queryStart) / 1000).toFixed(1);
        debugLog('WORKIQ-QUERY', `FAILED in ${elapsed}s: ${err.message} "${shortQ}..."`);
        reject(err);
      },
      timer: setTimeout(() => {
        wiqPending.delete(id);
        debugLog('WORKIQ-QUERY', `TIMEOUT after ${Math.round(timeoutMs / 1000)}s "${shortQ}..."`);
        reject(new Error(`Work IQ timeout after ${Math.round(timeoutMs / 1000)}s`));
      }, timeoutMs)
    });
    wiqProc.stdin.write(JSON.stringify({
      jsonrpc: '2.0', id, method: 'tools/call',
      params: { name: 'ask_work_iq', arguments: { question } }
    }) + '\n');
  });
}

// K2: Race session.sendAndWait() against wiq-down crashes.
// When WorkIQ crashes during an active session, sendAndWait would hang for the full
// timeout (the SDK's AI agent retries internally and never errors out on its own).
// This wrapper aborts the session promise immediately when WorkIQ goes down.
function runWithWiqGuard(session, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onWiqDown = (err) => {
      if (settled) return;
      settled = true;
      reject(err || new Error('WorkIQ crashed during session'));
    };
    wiqEvents.once('wiq-down', onWiqDown);
    session.sendAndWait({ prompt }, timeoutMs)
      .then(result => {
        if (settled) return;
        settled = true;
        wiqEvents.removeListener('wiq-down', onWiqDown);
        resolve(result);
      })
      .catch(err => {
        if (settled) return;
        settled = true;
        wiqEvents.removeListener('wiq-down', onWiqDown);
        reject(err);
      });
  });
}

// ─── Phase 3 Session Tracking ────────────────────────────────────────────
// Map<sessionId, { taskId, count, stubCount, budgetHit, wiqDown, calls: [...] }>
// Populated by /api/tasks/:id/check-update before sendAndWait, consumed by
// askWorkIQTool handler for budget enforcement and outcome classification,
// then read at the end of the endpoint and finally cleaned up.
const phase3Sessions = new Map();
const PHASE3_QUERY_BUDGET = parseInt(process.env.PHASE3_QUERY_BUDGET, 10) || 3;

function phase3Register(sessionId, taskId) {
  phase3Sessions.set(sessionId, {
    taskId, count: 0, stubCount: 0, budgetHit: false, wiqDown: false, calls: []
  });
}
function phase3Get(sessionId) { return phase3Sessions.get(sessionId); }
function phase3Cleanup(sessionId) { phase3Sessions.delete(sessionId); }

// Detect EULA/permission/service-unavailable stubs from WorkIQ responses.
// Multi-marker fingerprint (≥2 markers) — robust across MCP versions, no length-based check.
const EULA_MARKERS = [
  /accept\s+(the\s+)?eula/i,
  /accept_eula/i,
  /before\s+using\s+this\s+tool/i,
  /permission\s+denied/i,
  /not\s+been\s+accepted/i,
  /eula\s+not\s+accepted/i,
  /requires?\s+(eula|consent)/i,
];
function isStubResponse(text) {
  if (!text || typeof text !== 'string') return false;
  let hits = 0;
  for (const re of EULA_MARKERS) { if (re.test(text)) hits++; if (hits >= 2) return true; }
  return false;
}

// Block model-generated EULA-acceptance attempts (regex on the QUERY itself,
// not the response — keeps legitimate user queries about the word "EULA" working).
const SELF_EULA_QUERY = /^\s*(please\s+|i\s+)?(accept|acknowledge|confirm)\s+(the\s+)?eula\b/i;

const askWorkIQTool = defineTool('ask_work_iq', {
  description: 'Search Microsoft 365 emails, Teams messages, calendar, and documents. Pass a natural language question.',
  parameters: { type: 'object', properties: { question: { type: 'string', description: 'The question to ask Work IQ' } }, required: ['question'] },
  skipPermission: true,
  handler: async ({ question }, invocation) => {
    const sessionId = invocation && invocation.sessionId;
    const tracking = sessionId ? phase3Get(sessionId) : null;
    const phase3Ctx = tracking ? `[task=${tracking.taskId} q=${tracking.count + 1}]` : '';

    // Block model-generated EULA acceptance attempts (no MCP round-trip).
    if (SELF_EULA_QUERY.test(question)) {
      console.warn(`[M365] BLOCKED self-EULA query ${phase3Ctx}: "${question.substring(0, 80)}"`);
      debugLog('PHASE3-TOOL', `BLOCKED self-EULA query`, { sessionId, taskId: tracking?.taskId, query: question.substring(0, 120) });
      if (tracking) tracking.stubCount++;
      return 'TOOL_GUIDANCE: EULA acceptance is handled by the server at startup, not via this tool. Do not call ask_work_iq with EULA-related queries. Continue with your normal search or return {"hasUpdate": false, "inconclusive": true}.';
    }

    // Per-session budget enforcement (Phase 3 only — sessions without tracking are unaffected).
    if (tracking && tracking.count >= PHASE3_QUERY_BUDGET) {
      tracking.budgetHit = true;
      console.warn(`[M365] BUDGET_EXHAUSTED ${phase3Ctx} after ${tracking.count} queries`);
      debugLog('PHASE3-TOOL', `BUDGET_EXHAUSTED`, { sessionId, taskId: tracking.taskId, count: tracking.count, budget: PHASE3_QUERY_BUDGET });
      return `BUDGET_EXHAUSTED: You have reached the maximum of ${PHASE3_QUERY_BUDGET} ask_work_iq calls for this task. STOP searching. Return your final JSON now: {"hasUpdate": false, "inconclusive": true} — the server will retry this task in the next scan.`;
    }

    if (tracking) tracking.count++;
    const queryIndex = tracking ? tracking.count : 0;
    console.log(`[M365] Query ${phase3Ctx}: "${question.substring(0, 80)}..."`);
    const start = Date.now();
    try {
      const result = await askWorkIQDirect(question, 90000, tracking?.taskId || null);
      const durationMs = Date.now() - start;
      const charsReturned = result ? result.length : 0;
      const stubDetected = isStubResponse(result);
      if (stubDetected && tracking) {
        tracking.stubCount++;
        consecutiveStubCount++;
        console.warn(`[M365] STUB detected ${phase3Ctx} (chars=${charsReturned}) — service unavailable (consecutive: ${consecutiveStubCount}/${STUB_RESTART_THRESHOLD})`);
        debugLog('PHASE3-TOOL', `STUB`, { sessionId, taskId: tracking.taskId, queryIndex, durationMs, charsReturned, consecutiveStubCount });
        if (tracking) tracking.calls.push({ queryIndex, outcome: 'stub', durationMs, charsReturned });
        // v3.3.0: If too many consecutive stubs, the WorkIQ subprocess is degraded —
        // force-restart it so the next Phase 3 run starts with a fresh process.
        if (consecutiveStubCount >= STUB_RESTART_THRESHOLD && wiqProc) {
          console.warn(`[WORKIQ] ${consecutiveStubCount} consecutive stubs — force-restarting subprocess`);
          debugLog('WORKIQ', `Force-restart triggered by ${consecutiveStubCount} consecutive stubs`);
          phase3Log(`STUB-RESTART triggered consecutiveStubCount=${consecutiveStubCount} — killing wiqProc pid=${wiqProc.pid || '?'}`);
          consecutiveStubCount = 0;
          try { wiqProc.kill(); } catch {}
          // close-handler emits 'wiq-down' and schedules auto-restart
        }
        return 'SERVICE_UNAVAILABLE: M365 search backend returned a permission/EULA stub instead of results. Do NOT retry. Return your final JSON now: {"hasUpdate": false, "inconclusive": true} — the server will retry this task in the next scan.';
      }
      console.log(`[M365] OK in ${(durationMs / 1000).toFixed(1)}s (${charsReturned} chars) ${phase3Ctx}`);
      consecutiveStubCount = 0; // healthy response resets the counter
      if (tracking) {
        tracking.calls.push({ queryIndex, outcome: 'ok', durationMs, charsReturned });
        debugLog('PHASE3-TOOL', `OK`, { sessionId, taskId: tracking.taskId, queryIndex, durationMs, charsReturned });
      }
      return result;
    } catch (e) {
      const durationMs = Date.now() - start;
      console.error(`[M365] Failed in ${(durationMs / 1000).toFixed(1)}s ${phase3Ctx}: ${e.message}`);
      if (tracking) {
        tracking.calls.push({ queryIndex, outcome: 'error', durationMs, error: e.message });
        if (/cooldown|wiq|workiq|exited|crashed|down/i.test(e.message)) tracking.wiqDown = true;
        debugLog('PHASE3-TOOL', `ERROR ${e.message}`, { sessionId, taskId: tracking.taskId, queryIndex, durationMs });
      }
      return `Error: ${e.message}`;
    }
  }
});

// v3.4.0 Phase β.1: parallel_search — runs up to 3 Work-IQ queries concurrently.
// Dramatically faster than sequential ask_work_iq for multi-angle searches
// (e.g. email + teams, or targeted + broader). Returns a single aggregated
// response so the model gets everything at once without round-tripping.
const parallelSearchTool = defineTool('parallel_search', {
  description: 'Run up to 3 Work IQ searches concurrently and get all results at once. Use this when you want to combine two complementary search angles (e.g. targeted query + broader query, or email-focused + teams-focused). Much faster than calling ask_work_iq multiple times sequentially.',
  parameters: {
    type: 'object',
    properties: {
      queries: {
        type: 'array',
        description: 'Array of 2 or 3 natural-language questions, each a different angle on what you want to find. Do not submit near-duplicates — each query should explore a distinct angle.',
        items: { type: 'string' },
        minItems: 2,
        maxItems: 3
      }
    },
    required: ['queries']
  },
  skipPermission: true,
  handler: async ({ queries }, invocation) => {
    const sessionId = invocation && invocation.sessionId;
    const tracking = sessionId ? phase3Get(sessionId) : null;
    const phase3Ctx = tracking ? `[task=${tracking.taskId}]` : '';

    if (!Array.isArray(queries) || queries.length < 2) {
      return 'Error: parallel_search requires at least 2 queries. Use ask_work_iq for single queries.';
    }
    if (queries.length > 3) queries = queries.slice(0, 3);

    // Pre-check each query for self-EULA attempts — reject upfront.
    for (const q of queries) {
      if (typeof q !== 'string' || !q.trim()) {
        return 'Error: all queries must be non-empty strings.';
      }
      if (SELF_EULA_QUERY.test(q)) {
        console.warn(`[M365] BLOCKED self-EULA query in parallel_search ${phase3Ctx}`);
        debugLog('PHASE3-TOOL', `BLOCKED self-EULA in parallel_search`, { sessionId, taskId: tracking?.taskId, query: q.substring(0, 120) });
        if (tracking) tracking.stubCount++;
        return 'TOOL_GUIDANCE: EULA acceptance is handled by the server at startup. Do not include EULA-related queries.';
      }
    }

    // Budget enforcement — parallel_search counts as queries.length against the budget.
    if (tracking && tracking.count + queries.length > PHASE3_QUERY_BUDGET) {
      tracking.budgetHit = true;
      console.warn(`[M365] BUDGET_EXHAUSTED ${phase3Ctx} — parallel_search would exceed ${PHASE3_QUERY_BUDGET}`);
      debugLog('PHASE3-TOOL', `BUDGET_EXHAUSTED in parallel_search`, { sessionId, taskId: tracking.taskId, count: tracking.count, requested: queries.length, budget: PHASE3_QUERY_BUDGET });
      return `BUDGET_EXHAUSTED: This parallel_search would exceed the budget of ${PHASE3_QUERY_BUDGET} Work IQ calls. STOP searching and return your final JSON now.`;
    }

    if (tracking) tracking.count += queries.length;
    const startAll = Date.now();
    console.log(`[M365] parallel_search ${phase3Ctx} (${queries.length} queries)`);
    debugLog('PARALLEL-SEARCH', `START ${queries.length} queries`, { sessionId, taskId: tracking?.taskId, queries: queries.map(q => q.substring(0, 80)) });

    const results = await Promise.allSettled(
      queries.map(q => askWorkIQDirect(q, 90000, tracking?.taskId || null))
    );

    const durationMs = Date.now() - startAll;
    let okCount = 0, stubCount = 0, errorCount = 0;
    const parts = results.map((r, i) => {
      const shortQ = queries[i].substring(0, 80);
      if (r.status === 'fulfilled') {
        const text = r.value || '';
        const isStub = isStubResponse(text);
        if (isStub) {
          stubCount++;
          if (tracking) tracking.stubCount++;
          return `=== Query ${i + 1}: "${shortQ}" ===\nSERVICE_UNAVAILABLE (stub response — service permission/EULA issue)`;
        }
        okCount++;
        return `=== Query ${i + 1}: "${shortQ}" ===\n${text}`;
      } else {
        errorCount++;
        if (tracking && /cooldown|wiq|workiq|exited|crashed|down/i.test(r.reason?.message || '')) tracking.wiqDown = true;
        return `=== Query ${i + 1}: "${shortQ}" ===\nError: ${r.reason?.message || 'unknown'}`;
      }
    });

    // v3.3.0 stub tracking parity with ask_work_iq
    if (stubCount > 0) {
      consecutiveStubCount += stubCount;
      if (consecutiveStubCount >= STUB_RESTART_THRESHOLD && wiqProc) {
        console.warn(`[WORKIQ] ${consecutiveStubCount} consecutive stubs from parallel_search — force-restarting`);
        debugLog('WORKIQ', `Force-restart from parallel_search stubs (${consecutiveStubCount})`);
        consecutiveStubCount = 0;
        try { wiqProc.kill(); } catch {}
      }
    } else if (okCount > 0) {
      consecutiveStubCount = 0;
    }

    console.log(`[M365] parallel_search OK in ${(durationMs / 1000).toFixed(1)}s ${phase3Ctx} (ok=${okCount} stub=${stubCount} err=${errorCount})`);
    debugLog('PARALLEL-SEARCH', `DONE in ${durationMs}ms`, { sessionId, taskId: tracking?.taskId, ok: okCount, stub: stubCount, error: errorCount });
    if (tracking) {
      tracking.calls.push({ queryIndex: tracking.count, outcome: 'parallel', durationMs, ok: okCount, stub: stubCount, error: errorCount });
    }

    // If ALL queries returned stubs or errors, give the model a clear signal to bail.
    if (okCount === 0) {
      return `PARALLEL_SEARCH_ALL_FAILED (stubs=${stubCount} errors=${errorCount}): Work IQ did not return usable data for any of the ${queries.length} queries. Do NOT retry — return your final JSON now with confidence "none" or hasUpdate=false / inconclusive=true as appropriate.\n\n${parts.join('\n\n')}`;
    }

    return parts.join('\n\n');
  }
});


// Prevent server termination from unhandled errors in SDK child processes.
// The Copilot SDK's JSON-RPC streams can emit errors asynchronously
// (e.g. ERR_STREAM_DESTROYED) after session.destroy() — these must not crash the server.
process.on('uncaughtException', (err) => {
  // Stream errors from destroyed SDK sessions are expected and non-fatal
  if (err.code === 'ERR_STREAM_DESTROYED' || err.code === 'ERR_STREAM_WRITE_AFTER_END' || err.code === 'EPIPE') {
    console.warn(`[RECOVERED] Non-fatal stream error: ${err.code} — ${err.message}`);
    return;
  }
  // For truly unexpected errors, log but keep running
  console.error(`[RECOVERED] Uncaught exception (server continues): ${err.message}`);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  const code = reason instanceof Error ? reason.code : '';
  // SDK stream errors surfacing as rejected promises — non-fatal
  if (code === 'ERR_STREAM_DESTROYED' || code === 'ERR_STREAM_WRITE_AFTER_END' || code === 'EPIPE') {
    console.warn(`[RECOVERED] Non-fatal rejected promise: ${code} — ${msg}`);
    return;
  }
  console.error(`[RECOVERED] Unhandled rejection (server continues): ${msg}`);
});

// --- Session Lifecycle Management (v2.7, enhanced v2.10) ---
// Tracks all active Copilot SDK sessions to guarantee subprocess cleanup
// on errors, timeouts, and server shutdown.
const activeSessions = new Set();
const sessionTimestamps = new Map();
const sessionClients = new WeakMap(); // session → CopilotClient

// Session concurrency limit — prevents WorkIQ subprocess from being overwhelmed.
// v3.4.0 Phase β.4: bumped 2 → 4. With parallel_search each session now issues fewer
// sequential WorkIQ calls, so concurrent sessions put less pressure on the subprocess.
// Raising the cap lets the user interact with multiple tasks simultaneously.
const MAX_CONCURRENT_SDK = parseInt(process.env.MAX_CONCURRENT_SDK, 10) || 4;
async function waitForSDKSlot() {
  while (activeSessions.size >= MAX_CONCURRENT_SDK) {
    debugLog('SDK-SESSION', `Waiting for slot (${activeSessions.size}/${MAX_CONCURRENT_SDK} active)`);
    await new Promise(r => setTimeout(r, 2000));
  }
}

// v3.4.0 Phase β.4: per-task serialization — ensures only one agent run per task at a time,
// even when the user triggers multiple mutations quickly. Different tasks proceed in
// parallel (up to MAX_CONCURRENT_SDK), but the same task's operations queue.
const taskQueues = new Map(); // taskId → Promise chain tail
function runOnTaskQueue(taskId, fn) {
  if (!taskId) return fn();
  const prev = taskQueues.get(taskId) || Promise.resolve();
  const next = prev.then(() => fn(), () => fn()); // don't let a prior failure block the next run
  // Store the tail; clean up when it's the current tail and has settled.
  taskQueues.set(taskId, next);
  next.finally(() => {
    if (taskQueues.get(taskId) === next) taskQueues.delete(taskId);
  });
  return next;
}

function trackSession(session) {
  if (session) {
    activeSessions.add(session);
    sessionTimestamps.set(session, Date.now());
    debugLog('SDK-SESSION', `Created (total active: ${activeSessions.size})`);
  }
  return session;
}

// Associate a client with a session so destroySession can dispose it
function linkClientToSession(session, client) {
  if (session && client) sessionClients.set(session, client);
}

async function destroySession(session) {
  if (!session) return;
  const age = sessionTimestamps.has(session) ? Math.round((Date.now() - sessionTimestamps.get(session)) / 1000) : '?';
  activeSessions.delete(session);
  sessionTimestamps.delete(session);
  debugLog('SDK-SESSION', `Destroying (age: ${age}s, remaining active: ${activeSessions.size})`);
  const client = sessionClients.has(session) ? sessionClients.get(session) : null;
  try { await session.destroy(); } catch {}
  if (client) {
    try { await client.forceStop(); } catch {}
    try { await client.dispose(); } catch {}
  }
}

async function destroyAllSessions() {
  const sessions = [...activeSessions];
  activeSessions.clear();
  sessionTimestamps.clear();
  await Promise.allSettled(sessions.map(s => {
    try { return s.destroy(); } catch { return Promise.resolve(); }
  }));
}

// Periodic check: destroy tracked sessions that have been alive for over 10 minutes (stuck).
// Uses destroySession() which calls forceStop() — safe and targeted.
function startPeriodicReaper() {
  setInterval(async () => {
    const now = Date.now();
    const staleTimeout = 10 * 60 * 1000;
    for (const [session, created] of sessionTimestamps.entries()) {
      if (now - created > staleTimeout) {
        console.log(`[REAPER] Destroying stale session (age: ${((now - created) / 1000).toFixed(0)}s)`);
        await destroySession(session);
      }
    }
  }, 60 * 1000);
}

// Graceful shutdown: destroy all tracked sessions before exit
function setupGracefulShutdown() {
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[SHUTDOWN] ${signal} received — cleaning up ${activeSessions.size} active session(s)...`);
    await destroyAllSessions();
    // Kill persistent Work IQ MCP subprocess
    if (wiqProc) { try { wiqProc.kill(); } catch {} wiqProc = null; }
    // Also kill any remaining SDK subprocesses
    try { await reapOrphanedSessions(); } catch {}
    console.log('[SHUTDOWN] All sessions destroyed. Exiting.');
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Windows: handle Ctrl+C in non-TTY (e.g. background processes)
  process.on('SIGHUP', () => shutdown('SIGHUP'));
}
setupGracefulShutdown();

// Startup orphan reaper: kill leftover CLI subprocesses from previous server runs.
// The Copilot SDK spawns Node.js child processes via stdio with a distinctive
// command line containing '@github/copilot'. On Windows we use PowerShell's
// Get-CimInstance (WMIC is deprecated on Win11); on Unix we use pkill.
async function reapOrphanedSessions() {
  // Kill ALL SDK child processes (used at startup to clean up from previous runs)
  const { execSync } = await import('child_process');
  try {
    if (process.platform === 'win32') {
      const ownPid = process.pid;
      const psOut = execSync(
        `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"name='node.exe'\\" | Where-Object { $_.CommandLine -match 'copilot|@github|workiq.*mcp' -and $_.ProcessId -ne ${ownPid} } | Select-Object -ExpandProperty ProcessId"`,
        { encoding: 'utf-8', timeout: 15000 }
      );
      const orphanPids = psOut.split(/\r?\n/)
        .map(line => parseInt(line.trim(), 10))
        .filter(pid => pid && !isNaN(pid) && pid !== ownPid);

      if (orphanPids.length > 0) {
        for (const pid of orphanPids) {
          try { execSync(`taskkill /F /PID ${pid}`, { timeout: 5000 }); } catch {}
        }
        console.log(`[REAPER] Killed ${orphanPids.length} orphaned subprocess(es) from previous run`);
      }
    } else {
      // Unix: kill node processes whose cmdline contains copilot-sdk markers
      try {
        execSync("pkill -f 'copilot.*stdio'", { timeout: 5000 });
        console.log('[REAPER] Killed orphaned Copilot SDK subprocesses from previous run');
      } catch {
        // pkill returns non-zero if no processes matched — that's fine
      }
    }
  } catch (err) {
    // Non-fatal: if we can't reap, just log and continue
    console.warn(`[REAPER] Orphan cleanup skipped: ${err.message}`);
  }
}
reapOrphanedSessions();
startPeriodicReaper();

// --- Load Skill Files (v1.3) ---

const LOG_WORK_SKILL_PATH = path.join(__dirname, 'docs', 'LOG_WORK_SKILL.md');

const SCAN_DISCOVERY_SKILL_PATH = path.join(__dirname, 'docs', 'SCAN_DISCOVERY_SKILL.md');
const ENRICH_SKILL_PATH = path.join(__dirname, 'docs', 'ENRICH_SKILL.md');
const UPDATE_CHECK_SKILL_PATH = path.join(__dirname, 'docs', 'UPDATE_CHECK_SKILL.md');
const SEARCH_SKILL_PATH = path.join(__dirname, 'docs', 'SEARCH_SKILL.md');
const CONSOLIDATE_SKILL_PATH = path.join(__dirname, 'docs', 'CONSOLIDATE_SKILL.md');
const CORRECT_SKILL_PATH = path.join(__dirname, 'docs', 'CORRECT_SKILL.md');

let LOG_WORK_SKILL = '';
let SCAN_DISCOVERY_SKILL = '';
let ENRICH_SKILL = '';
let UPDATE_CHECK_SKILL = '';
let SEARCH_SKILL = '';
let CONSOLIDATE_SKILL = '';
let CORRECT_SKILL = '';

try {
  LOG_WORK_SKILL = fs.readFileSync(LOG_WORK_SKILL_PATH, 'utf-8');
  console.log(`Loaded LOG_WORK_SKILL.md (${LOG_WORK_SKILL.length} chars)`);
} catch (err) {
  console.warn('Warning: LOG_WORK_SKILL.md not found, using minimal log prompt');
}

try {
  SCAN_DISCOVERY_SKILL = fs.readFileSync(SCAN_DISCOVERY_SKILL_PATH, 'utf-8');
  console.log(`Loaded SCAN_DISCOVERY_SKILL.md (${SCAN_DISCOVERY_SKILL.length} chars)`);
} catch (err) {
  console.warn('Warning: SCAN_DISCOVERY_SKILL.md not found');
}

try {
  ENRICH_SKILL = fs.readFileSync(ENRICH_SKILL_PATH, 'utf-8');
  console.log(`Loaded ENRICH_SKILL.md (${ENRICH_SKILL.length} chars)`);
} catch (err) {
  console.warn('Warning: ENRICH_SKILL.md not found');
}

try {
  UPDATE_CHECK_SKILL = fs.readFileSync(UPDATE_CHECK_SKILL_PATH, 'utf-8');
  console.log(`Loaded UPDATE_CHECK_SKILL.md (${UPDATE_CHECK_SKILL.length} chars)`);
} catch (err) {
  console.warn('Warning: UPDATE_CHECK_SKILL.md not found');
}

try {
  SEARCH_SKILL = fs.readFileSync(SEARCH_SKILL_PATH, 'utf-8');
  console.log(`Loaded SEARCH_SKILL.md (${SEARCH_SKILL.length} chars)`);
} catch (err) {
  console.warn('Warning: SEARCH_SKILL.md not found');
}

try {
  CONSOLIDATE_SKILL = fs.readFileSync(CONSOLIDATE_SKILL_PATH, 'utf-8');
  console.log(`Loaded CONSOLIDATE_SKILL.md (${CONSOLIDATE_SKILL.length} chars)`);
} catch (err) {
  console.warn('Warning: CONSOLIDATE_SKILL.md not found');
}

try {
  CORRECT_SKILL = fs.readFileSync(CORRECT_SKILL_PATH, 'utf-8');
  console.log(`Loaded CORRECT_SKILL.md (${CORRECT_SKILL.length} chars)`);
} catch (err) {
  console.warn('Warning: CORRECT_SKILL.md not found');
}

app.use(express.json());

// Serve index.html at root (no-cache to ensure code changes are always picked up)
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.set('Pragma', 'no-cache');
  res.set('Expires', '0');
  res.sendFile(path.join(__dirname, 'index.html'));
});

// --- Helper: read/write tasks.json ---

function readTasks() {
  const raw = fs.readFileSync(TASKS_FILE, 'utf-8');
  return JSON.parse(raw);
}

function writeTasks(data) {
  fs.writeFileSync(TASKS_FILE, JSON.stringify(data, null, 2) + '\n', 'utf-8');
}

// --- Write Queue (sequential writes for concurrency safety) ---

let writePromise = Promise.resolve();

function safeWriteTasks(mutationFn) {
  writePromise = writePromise.catch(() => {}).then(() => {
    try {
      const data = readTasks();
      const result = mutationFn(data);
      writeTasks(data);
      return result;
    } catch (err) {
      console.error(`[${new Date().toISOString()}] safeWriteTasks FAILED: ${err.message}`);
      throw err;
    }
  });
  return writePromise;
}

// --- Auto-Cleanup: permanently delete done tasks after retention period ---

function cleanupDoneTasks(retentionDays = 3) {
  const data = readTasks();
  const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
  const before = data.tasks.length;
  data.tasks = data.tasks.filter(t => {
    if (t.status === 'done' && t.doneAt && t.doneAt < cutoff) return false;
    return true;
  });
  const removed = before - data.tasks.length;
  if (removed > 0) {
    writeTasks(data);
    console.log(`[${new Date().toISOString()}] Auto-cleanup: permanently deleted ${removed} done task(s) older than ${retentionDays} day(s)`);
  }
  return removed;
}

// --- Dedup Helpers (v1.3, improved v2.3) ---

// Strip common email subject prefixes: Re:, Fw:, AW:, WG:, [EXTERN], [EXTERNAL], etc.
function stripSubjectPrefixes(title) {
  return String(title)
    .replace(/^(\s*(re|fw|fwd|aw|wg|antwort|weiterleitung)\s*:\s*)+/gi, '')
    .replace(/\[extern(al)?\]\s*/gi, '')
    .trim();
}

function normalizeForCompare(title) {
  return stripSubjectPrefixes(String(title))
    .toLowerCase()
    .replace(/[^a-z0-9äöüß\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSimilarTitle(a, b) {
  const wordsA = new Set(normalizeForCompare(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalizeForCompare(b).split(' ').filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  const jaccard = intersection / union;
  // Also check if one subject is a subset of the other (covers prefix-only differences)
  const subsetRatio = intersection / Math.min(wordsA.size, wordsB.size);
  return jaccard > 0.6 || subsetRatio >= 0.9;
}

// --- Keyword Extraction for Log Analysis Fallback (v1.4) ---

// --- Normalize Ambiguities (v2.1) ---
// Converts old string[] format to object[] format for backward compatibility
function normalizeAmbiguities(arr) {
  if (!arr || !Array.isArray(arr)) return [];
  return arr.map(item => {
    if (typeof item === 'string') return { question: item, resolved: false };
    if (typeof item === 'object' && item.question) return item;
    return { question: String(item), resolved: false };
  });
}

// Format a timestamp for update markers in summaries (dd.MM.yyyy, HH:mm)
function formatUpdateTimestamp(date) {
  const d = date || new Date();
  const day = String(d.getDate()).padStart(2, '0');
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const year = d.getFullYear();
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${day}.${month}.${year}, ${hours}:${minutes}`;
}

// v3.3.0: Retroactive Summary-History Reconciliation.
// When a prior Phase 3 run detected a thread-update (e.g. a Sent-Items reply)
// but — due to an older code path or missing newSummary from the model — the
// summary was never refreshed, this helper heals the task on the next run.
// Idempotent: the marker check prevents double-application.
function reconcileSummaryWithHistory(t) {
  if (!t || !Array.isArray(t.history) || !t.history.length) return false;
  let lastThreadUpdate = null, lastSummaryUpdate = null;
  for (let i = t.history.length - 1; i >= 0; i--) {
    const h = t.history[i];
    if (!lastThreadUpdate && h.type === 'thread-update') lastThreadUpdate = h;
    if (!lastSummaryUpdate && (h.type === 'summary-update' || h.type === 'summary')) lastSummaryUpdate = h;
    if (lastThreadUpdate && lastSummaryUpdate) break;
  }
  if (!lastThreadUpdate) return false;
  const tuTs = Date.parse(lastThreadUpdate.timestamp);
  const suTs = lastSummaryUpdate ? Date.parse(lastSummaryUpdate.timestamp) : 0;
  if (!(tuTs > suTs)) return false;
  const marker = `🔴 **Update ${formatUpdateTimestamp(new Date(lastThreadUpdate.timestamp))}:**`;
  if ((t.summary || '').includes(marker)) return false;
  const m = lastThreadUpdate.text.match(/Update:\s*([\s\S]*?)$/);
  const updateText = (m ? m[1] : lastThreadUpdate.text).trim();
  if (!updateText) return false;
  t.summary = `${marker} ${updateText}\n\n---\n\n${t.summary || ''}`;
  if (t.status !== 'done') t.status = 'updated';
  const now = new Date().toISOString();
  t.history.push({
    timestamp: now,
    type: 'summary-update',
    text: `📋 Retroactive reconciliation: thread-update from ${lastThreadUpdate.timestamp} prepended to summary (historical desync healed)`
  });
  t.updatedAt = now;
  return true;
}

// ─── Phase 3: Compact Action Item State Builder ──────────────────────────
// Mirrors the Task_Zero 03 buildProjectMemory pattern: every Phase 3 SDK call
// receives a compact representation of WHAT IS ALREADY KNOWN, so the model can
// detect "no new info" without exhaustive M365 searches.
//
// Hard size budget: ~2.5 kB total. Each section is truncated independently.
const PHASE3_STATE_MAX = 2500;
function _truncate(s, n) {
  if (!s) return '';
  s = String(s);
  return s.length <= n ? s : s.substring(0, n - 1).trimEnd() + '…';
}
function buildActionItemState(task) {
  const lines = [];
  lines.push('# Action Item State (already known to Agent Zero)');
  lines.push('');
  lines.push(`- Title: ${_truncate(task.title, 200)}`);
  lines.push(`- Source: ${task.source || 'unknown'}`);
  lines.push(`- Current status field: ${task.status || 'new'}  (allowed: new | on-radar | in-progress | updated | done)`);
  if (task.from) lines.push(`- Sender: ${_truncate(task.from, 120)}`);
  if (task.link) lines.push(`- Direct link: ${task.link}`);
  if (task.link && task.link.includes('teams.microsoft.com')) {
    const threadMatch = task.link.match(/19:[a-f0-9]+@thread\.[a-z]+/);
    const msgMatch = task.link.match(/\/(\d{10,})\?/);
    if (threadMatch) lines.push(`- Teams thread ID: ${threadMatch[0]}`);
    if (msgMatch) lines.push(`- Teams message ID: ${msgMatch[1]}`);
  }
  const anchor = task.lastSuccessfulUpdateCheck || task.lastUpdateCheck || task.enrichedAt || task.createdAt || task.date;
  lines.push(`- Last successful check (TEMPORAL ANCHOR — only messages AFTER this date are NEW): ${anchor || 'never'}`);
  lines.push('');
  lines.push('## Current summary (already integrated into the task)');
  lines.push(_truncate(task.summary || '(no summary yet)', 1500));
  lines.push('');
  // Recent history tail — gives the model concrete proof of what was already captured.
  if (Array.isArray(task.history) && task.history.length > 0) {
    lines.push('## Recent history (last 5 entries — these are ALREADY captured, do NOT re-report)');
    const tail = task.history.slice(-5);
    for (const h of tail) {
      const ts = h.timestamp ? h.timestamp.substring(0, 19) : '?';
      const txt = _truncate((h.text || '').replace(/\s+/g, ' '), 200);
      lines.push(`- [${ts}] (${h.type || 'note'}) ${txt}`);
      // Communications fingerprint — list IDs/dates/links only, NEVER bodies.
      if (Array.isArray(h.communications) && h.communications.length > 0) {
        for (const c of h.communications.slice(0, 4)) {
          const cd = c.date ? c.date.substring(0, 10) : '?';
          const cl = c.link ? ` ${c.link.substring(0, 80)}…` : '';
          lines.push(`    · ${c.type || '?'} from ${_truncate(c.from || '?', 60)} on ${cd}${cl}`);
        }
      }
    }
  }
  let out = lines.join('\n');
  if (out.length > PHASE3_STATE_MAX) {
    out = out.substring(0, PHASE3_STATE_MAX - 1) + '…';
  }
  return out;
}

// ─── Phase 3: Pre-Filter Configuration ───────────────────────────────────
// Skip a Phase 3 check if the last SUCCESSFUL check ran recently. Configurable.
// Inconclusive runs do NOT update lastSuccessfulUpdateCheck — they are retried
// at the next scan.
const PHASE3_MIN_INTERVAL_MS = {
  'in-progress':  parseInt(process.env.PHASE3_INTERVAL_INPROGRESS, 10) || (1 * 60 * 60 * 1000),  // 1h
  'needs-review': parseInt(process.env.PHASE3_INTERVAL_NEEDSREVIEW, 10) || (2 * 60 * 60 * 1000), // 2h
  'default':      parseInt(process.env.PHASE3_INTERVAL_DEFAULT, 10) || (6 * 60 * 60 * 1000),     // 6h
};
function phase3MinInterval(task) {
  if (task.status === 'in-progress') return PHASE3_MIN_INTERVAL_MS['in-progress'];
  if (task.enrichmentStatus === 'needs-review') return PHASE3_MIN_INTERVAL_MS['needs-review'];
  return PHASE3_MIN_INTERVAL_MS['default'];
}

// Dedicated per-day phase3 log file (in addition to debug.log).
function phase3Log(message, data) {
  if (!DEBUG_LOG) return;
  const ts = new Date().toISOString();
  const day = ts.substring(0, 10);
  const file = path.join(LOG_DIR, `phase3-${day}.log`);
  let line = `[${ts}] ${message}`;
  if (data) line += ` | ${typeof data === 'string' ? data : JSON.stringify(data)}`;
  line += '\n';
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(file, line);
  } catch {}
}

function extractKeywords(title) {
  const stopWords = new Set([
    'the','a','an','is','are','was','were','be','been','have','has','had',
    'do','does','did','will','would','could','should','may','might','must',
    'to','of','in','for','on','with','at','by','from','as','into','through',
    'and','but','or','nor','if','not','no','your','my','me','i','you','we',
    'they','he','she','it','this','that','these','those','pending','approval'
  ]);
  return title
    .split(/[\s|,;:–—]+/)
    .map(w => w.replace(/[^a-zA-Z0-9#]/g, ''))
    .filter(w => w.length > 1 && !stopWords.has(w.toLowerCase()));
}

// --- Schema Migration ---

function migrateTasks() {
  const data = readTasks();
  if (data.version >= 2) return;

  for (const task of data.tasks) {
    if (!task.history) task.history = [];
    if (task.doneAt === undefined) {
      task.doneAt = task.status === 'done' ? task.updatedAt : null;
    }
  }
  data.version = 2;
  writeTasks(data);
  console.log(`Migrated tasks.json from v1 to v2 (${data.tasks.length} tasks)`);
}

// --- Status Migration: active → new (v1.5) ---

function migrateStatuses() {
  const data = readTasks();
  let migrated = 0;
  for (const task of data.tasks) {
    if (task.status === 'active') {
      task.status = 'new';
      migrated++;
    }
  }
  if (migrated > 0) {
    writeTasks(data);
    console.log(`Migrated ${migrated} tasks from 'active' to 'new' status`);
  }
}

// --- Schema Migration v2 → v3 (Multi-Phase Scan) ---

function migrateToV3() {
  const data = readTasks();
  if (data.version >= 3) return;

  for (const task of data.tasks) {
    if (task.enrichmentStatus === undefined) {
      task.enrichmentStatus = task.summary ? 'enriched' : 'pending';
    }
    if (task.updateCheckStatus === undefined) {
      task.updateCheckStatus = 'pending';
    }
    if (task.enrichedAt === undefined) {
      task.enrichedAt = task.summary ? task.updatedAt : null;
    }
    if (task.lastUpdateCheck === undefined) {
      task.lastUpdateCheck = null;
    }
  }
  data.version = 3;
  writeTasks(data);
  console.log(`Migrated tasks.json to v3 (${data.tasks.length} tasks)`);
}

// --- API Endpoints ---

// Health check endpoint — used by startup scripts to verify server is alive and healthy
app.get('/api/health', (req, res) => {
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')).version; } catch {}
  res.json({
    status: 'ok',
    uptime: Math.round(process.uptime()),
    activeSessions: activeSessions.size,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    pid: process.pid,
    version
  });
});

// GET/POST /api/debug-log — toggle debug logging
app.get('/api/debug-log', (req, res) => {
  res.json({ enabled: DEBUG_LOG });
});
app.post('/api/debug-log', (req, res) => {
  const { enabled } = req.body;
  DEBUG_LOG = !!enabled;
  if (DEBUG_LOG) {
    debugLog('SYSTEM', `Debug logging ENABLED by user (pid: ${process.pid}, uptime: ${Math.round(process.uptime())}s)`);
  }
  console.log(`[DEBUG-LOG] ${DEBUG_LOG ? 'ENABLED' : 'DISABLED'}`);
  res.json({ enabled: DEBUG_LOG });
});

// GET /api/version — return app version from package.json
app.get('/api/version', (req, res) => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
    res.json({ version: pkg.version, name: pkg.name });
  } catch {
    res.json({ version: 'unknown' });
  }
});

// GET /api/tasks — return all tasks
app.get('/api/tasks', (req, res) => {
  try {
    const data = readTasks();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: 'Failed to read tasks', detail: err.message });
  }
});

// POST /api/tasks — add a manual task
app.post('/api/tasks', async (req, res) => {
  try {
    const { title, notes } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const task = await safeWriteTasks((data) => {
      const now = new Date().toISOString();
      const t = {
        id: uuidv4(),
        title: title.trim(),
        summary: null,
        source: 'manual',
        from: null,
        date: null,
        link: null,
        status: 'new',
        notes: notes ? notes.trim() : '',
        history: [{ timestamp: now, type: 'created', text: 'Task created manually' }],
        doneAt: null,
        enrichmentStatus: 'n/a',
        updateCheckStatus: 'n/a',
        enrichedAt: null,
        lastUpdateCheck: null,
        createdAt: now,
        updatedAt: now
      };
      data.tasks.push(t);
      return t;
    });

    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create task', detail: err.message });
  }
});

// PATCH /api/tasks/:id — update task status or notes
app.patch('/api/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const validStatuses = ['new', 'needs-attention', 'escalated', 'in-progress', 'on-radar', 'updated', 'done', 'paused'];
    if (updates.status !== undefined && !validStatuses.includes(updates.status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const task = await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (!t) return null;

      const now = new Date().toISOString();
      if (!t.history) t.history = [];

      // Track status change in history
      if (updates.status !== undefined && updates.status !== t.status) {
        t.history.push({
          timestamp: now,
          type: 'status-change',
          text: `Status changed: ${t.status} → ${updates.status}`
        });

        // Manage doneAt
        if (updates.status === 'done') {
          t.doneAt = now;
        } else if (t.status === 'done') {
          t.doneAt = null;
        }
      }

      // Track summary change in history
      if (updates.summary !== undefined && updates.summary !== t.summary) {
        const prevSummary = t.summary;
        t.history.push({
          timestamp: now,
          type: 'summary-update',
          text: `✏️ Summary updated via direct edit` +
            (prevSummary ? `\nPrevious: ${prevSummary.length > 300 ? prevSummary.substring(0, 300) + '...' : prevSummary}` : '')
        });
      }

      const allowedFields = ['status', 'notes', 'title', 'summary', 'enrichmentStatus', 'updateCheckStatus', 'pendingPlan'];
      for (const field of allowedFields) {
        if (updates[field] !== undefined) {
          t[field] = typeof updates[field] === 'string' ? updates[field].trim() : updates[field];
        }
      }
      t.updatedAt = now;
      return t;
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update task', detail: err.message });
  }
});

// DELETE /api/tasks/:id — delete a task
app.delete('/api/tasks/:id', async (req, res) => {
  try {
    const { id } = req.params;

    const found = await safeWriteTasks((data) => {
      const index = data.tasks.findIndex(t => t.id === id);
      if (index === -1) return false;
      data.tasks.splice(index, 1);
      return true;
    });

    if (!found) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete task', detail: err.message });
  }
});

// DELETE /api/tasks/:id/history/:index — delete a single history entry
app.delete('/api/tasks/:id/history/:index', async (req, res) => {
  const { id } = req.params;
  const index = parseInt(req.params.index, 10);

  if (isNaN(index) || index < 0) {
    return res.status(400).json({ error: 'Invalid history index' });
  }

  try {
    const task = await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (!t) return null;
      if (!t.history || index >= t.history.length) return 'out_of_bounds';

      const entry = t.history[index];

      // Protect system entries — only user-generated types can be deleted
      if (entry.type !== 'update' && entry.type !== 'note' && entry.type !== 'review-response') return 'protected';

      // Remove the entry (splice preserves other entries)
      t.history.splice(index, 1);
      t.updatedAt = new Date().toISOString();
      return t;
    });

    if (task === null) {
      return res.status(404).json({ error: 'Task not found' });
    }
    if (task === 'out_of_bounds') {
      return res.status(400).json({ error: 'Invalid history index' });
    }
    if (task === 'protected') {
      return res.status(403).json({ error: 'System entries cannot be deleted' });
    }

    res.json(task);
  } catch (err) {
    res.status(500).json({ error: 'Failed to delete history entry', detail: err.message });
  }
});

// POST /api/cleanup — permanently delete done tasks older than retentionDays
app.post('/api/cleanup', (req, res) => {
  try {
    const retentionDays = parseInt(req.body.retentionDays) || 3;
    const removed = cleanupDoneTasks(retentionDays);
    res.json({ removed, retentionDays });
  } catch (err) {
    res.status(500).json({ error: 'Cleanup failed', detail: err.message });
  }
});

// POST /api/tasks/:id/note — save a quick note (no agent interaction)
app.post('/api/tasks/:id/note', async (req, res) => {
  try {
    const { id } = req.params;
    const { text } = req.body;

    if (!text || !text.trim()) {
      return res.status(400).json({ error: 'Note text is required' });
    }

    const task = await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (!t) return null;
      const now = new Date().toISOString();
      if (!t.history) t.history = [];
      t.history.push({
        timestamp: now,
        type: 'note',
        text: text.trim()
      });
      t.updatedAt = now;
      return t;
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: 'Failed to save note', detail: err.message });
  }
});

// POST /api/scan — scan M365 emails and Teams via Work IQ
// v5.0: Direct M365 scan — no Copilot SDK needed.
// WorkIQ (M365 Copilot) already classifies actionable messages.
// We just ask the right question, parse the response, and create tasks.
app.post('/api/scan', async (req, res) => {
  const scanDays = Math.min(14, Math.max(1, parseInt(req.body?.scanDays) || 4));
  try {
    const scanStart = Date.now();
    const daysText = `last ${scanDays} day${scanDays === 1 ? '' : 's'}`;

    // ── AUTO-RETRY: Reset error enrichments to pending (max 3 attempts) ──
    const retryData = readTasks();
    let retryCount = 0;
    for (const t of retryData.tasks) {
      if (t.enrichmentStatus === 'error' && t.status !== 'done') {
        const errorCount = (t.history || []).filter(h => h.type === 'enrich-error').length;
        if (errorCount < 3) {
          t.enrichmentStatus = 'pending';
          retryCount++;
          debugLog('PHASE1', `Auto-retry: reset "${t.title.substring(0, 50)}" to pending (attempt ${errorCount + 1}/3)`);
        } else {
          debugLog('PHASE1', `Skipping "${t.title.substring(0, 50)}" — max 3 enrichment attempts reached`);
        }
      }
    }
    if (retryCount > 0) {
      await safeWriteTasks((data) => {
        for (const t of data.tasks) {
          if (t.enrichmentStatus === 'error' && t.status !== 'done') {
            const errorCount = (t.history || []).filter(h => h.type === 'enrich-error').length;
            if (errorCount < 3) t.enrichmentStatus = 'pending';
          }
        }
      });
      console.log(`[SCAN] Auto-retry: reset ${retryCount} failed enrichment(s) to pending`);
    }

    // ── STEP 1: Ask M365 for actionable messages (email + Teams in PARALLEL) ──
    console.log(`[SCAN] Fetching actionable messages (${daysText}, parallel)...`);
    debugLog('PHASE1', `START scan (${daysText})`);

    const emailQuery = `Which of my emails from the ${daysText} require me to take action — respond, approve, review, call back, deliver, decide, or follow up? Include emails from external senders. For each actionable email show: exact Subject line, From (sender name), Date received, and a direct Outlook Web link to open it.`;
    const teamsQuery = `Which of my Teams messages from the ${daysText} require me to take action — respond, review, deliver, or follow up? Only include messages with explicit requests. For each show: who sent it, date, topic, and what action is needed.`;

    const [emailResult, teamsResult] = await Promise.allSettled([
      askWorkIQDirect(emailQuery, 90000),
      askWorkIQDirect(teamsQuery, 90000),
    ]);

    const emailRaw = emailResult.status === 'fulfilled' ? emailResult.value : '';
    const teamsRaw = teamsResult.status === 'fulfilled' ? teamsResult.value : '';
    const fetchMs = Date.now() - scanStart;
    console.log(`[SCAN] M365 responded in ${(fetchMs / 1000).toFixed(1)}s (emails: ${emailRaw.length} chars, teams: ${teamsRaw.length} chars)`);
    debugLog('PHASE1', `M365 responded in ${(fetchMs / 1000).toFixed(1)}s`, { emailChars: emailRaw.length, teamsChars: teamsRaw.length });

    if (!emailRaw && !teamsRaw) {
      return res.status(502).json({
        error: `Both M365 queries failed — Email: ${emailResult.reason?.message || 'empty'}, Teams: ${teamsResult.reason?.message || 'empty'}`
      });
    }

    // ── STEP 2: Parse M365 Markdown responses into structured items ──
    const items = [];

    // Parse emails — filter out M365 response header artifacts
    const parsedEmails = (parseMarkdownEmails(emailRaw) || []).filter(e => {
      // Reject M365 response metadata that parser mistakes for emails
      const title = (e.summary || '').toLowerCase();
      if (/^actionable\s+(emails?|messages?)/i.test(title)) return false;
      if (/^(here|below|the following|i found|these are|summary)/i.test(title)) return false;
      if (!e.summary || e.summary.length < 5) return false;
      return true;
    });
    console.log(`[SCAN] Parsed ${parsedEmails.length} actionable emails from M365 response`);
    if (parsedEmails.length === 0 && emailRaw.length > 100) {
      console.log(`[SCAN] Email parser found 0 items. Raw response (first 800 chars):\n${emailRaw.substring(0, 800)}`);
    }
    for (const e of parsedEmails) {
      if (!e.summary && !e.from) continue;
      items.push({
        action: 'new',
        title: e.summary || '(no subject)',
        source: 'email',
        from: e.from || null,
        date: e.date || null,
        link: e.link || null,
        actionNeeded: null,
        deadline: null
      });
    }

    // Parse Teams (simpler format — extract from numbered/bulleted items)
    if (teamsRaw && !teamsRaw.includes('did not find') && !teamsRaw.includes('no Teams')) {
      const teamsItems = parseTeamsMessages(teamsRaw);
      console.log(`[SCAN] Parsed ${teamsItems.length} actionable Teams messages`);
      for (const t of teamsItems) {
        items.push({
          action: 'new',
          title: t.summary || t.from || '(Teams message)',
          source: 'teams',
          from: t.from || null,
          date: t.date || null,
          link: t.link || null,
          actionNeeded: t.action || null,
          deadline: null
        });
      }
    }

    console.log(`[SCAN] Total items to process: ${items.length} (${(fetchMs / 1000).toFixed(1)}s elapsed)`);

    if (items.length === 0 && !emailRaw.includes('no actionable') && emailRaw.length > 100) {
      // M365 returned data but parser couldn't extract items — log for debugging
      console.warn(`[SCAN] Parser returned 0 items but M365 had data. First 500 chars of email response:`);
      console.warn(emailRaw.substring(0, 500));
    }

    // ── STEP 3: Process items — dedup and create tasks ──
    // Process parsed items: context-aware dedup (v1.3)
    const result = await safeWriteTasks((data) => {
      const now = new Date().toISOString();
      let added = 0;
      let skipped = 0;
      let updated = 0;
      const newTaskIds = [];

      for (const item of items) {
        if (!item.title && !item.existingId) continue;

        // --- ACTION: SKIP (AI matched to done task) ---
        if (item.action === 'skip') {
          skipped++;
          continue;
        }

        // --- ACTION: UPDATE (AI matched to existing task) ---
        if (item.action === 'update' && item.existingId) {
          const existing = data.tasks.find(t => t.id === item.existingId);
          if (!existing) {
            console.warn(`Scan update: existingId "${item.existingId}" not found, skipping`);
            skipped++;
            continue;
          }

          const changes = item.changes || {};
          const changedFields = [];

          if (changes.title && changes.title !== existing.title) {
            changedFields.push(`title: "${existing.title}" → "${changes.title}"`);
            existing.title = String(changes.title).trim();
          }
          if (changes.date && changes.date !== existing.date) {
            changedFields.push(`date: ${existing.date || 'none'} → ${changes.date}`);
            existing.date = changes.date;
          }
          if (changes.link && changes.link !== existing.link) {
            changedFields.push(`link updated`);
            existing.link = String(changes.link).trim();
          }
          if (changes.summary && changes.summary !== existing.summary) {
            changedFields.push('summary updated');
            existing.summary = String(changes.summary).trim();
          }

          if (changedFields.length > 0) {
            if (!existing.history) existing.history = [];
            const reason = item.reason || 'Updated by re-scan';
            existing.history.push({
              timestamp: now,
              type: 'scan-update',
              text: `Updated by scan: ${reason} (${changedFields.join(', ')})`
            });
            existing.updatedAt = now;
            updated++;
          } else {
            skipped++;
          }
          continue;
        }

        // --- ACTION: NEW (or no action field = backward-compat) ---
        const titleNorm = String(item.title).trim();
        if (!titleNorm) continue;

        const fromNorm = item.from ? String(item.from).trim() : null;
        const sourceNorm = item.source === 'teams' ? 'teams' : 'email';

        // Backward-compatibility: items without action field use old dedup logic
        if (!item.action) {
          let existing = null;
          if (item.link) {
            existing = data.tasks.find(t => t.link === item.link);
          }
          if (!existing) {
            existing = data.tasks.find(t =>
              normalizeForCompare(t.title) === normalizeForCompare(titleNorm) && t.source === sourceNorm
            );
          }
          if (existing) {
            skipped++;
            continue;
          }
        }

        // Safety-Net: similarity check against ALL existing tasks (including done)
        const similarTask = data.tasks.find(t => isSimilarTitle(t.title, titleNorm));
        if (similarTask) {
          if (similarTask.status === 'done') {
            // Suppress unless this is verifiably NEW activity after the task was marked done.
            // Reason: the same email resurfaces on every scan while still in the scan window.
            // Only reactivate if: no exact link match AND item has a parseable date strictly
            // after doneAt. Conservative defaults: missing link → no link suppression;
            // missing/invalid dates → suppress (can't confirm it's new).
            const exactLinkMatch = !!(item.link && similarTask.link &&
              String(item.link).trim() === String(similarTask.link).trim());
            const doneDate = similarTask.doneAt ? new Date(similarTask.doneAt) : null;
            const itemDate = item.date ? new Date(item.date) : null;
            const isNewActivity = !exactLinkMatch &&
              itemDate && !isNaN(itemDate) &&
              doneDate && !isNaN(doneDate) &&
              itemDate > doneDate;

            if (!isNewActivity) {
              debugLog('PHASE1', `Suppressed done task resurface: "${similarTask.title}"`, { exactLinkMatch, itemDate: item.date, doneAt: similarTask.doneAt });
              console.log(`[SCAN] Suppressed done task: "${similarTask.title}" (matched "${titleNorm}")`);
              skipped++;
            } else {
              // Genuine new activity after done — reactivate
              const now2 = new Date().toISOString();
              similarTask.status = 'needs-attention';
              similarTask.doneAt = null;
              if (!similarTask.history) similarTask.history = [];
              similarTask.history.push({
                timestamp: now2,
                type: 'reactivated',
                text: `🔄 Reactivated: new activity after done — "${titleNorm}" (from ${fromNorm || 'unknown'}, dated ${item.date || 'unknown'})`
              });
              if (item.link) similarTask.link = String(item.link).trim();
              if (item.date) similarTask.date = item.date;
              similarTask.enrichmentStatus = 'pending';
              similarTask.updateCheckStatus = 'pending';
              similarTask.updatedAt = now2;
              newTaskIds.push(similarTask.id);
              updated++;
              console.log(`[SCAN] Reactivated done task (new activity): "${similarTask.title}" (item date ${item.date} > doneAt ${similarTask.doneAt})`);
            }
          } else {
            console.warn(`Safety-Net dedup: "${titleNorm}" is similar to existing "${similarTask.title}", skipping`);
            skipped++;
          }
          continue;
        }

        // Create new task (Phase 1: discovery only — no summary)
        const task = {
          id: uuidv4(),
          title: titleNorm,
          summary: null,
          source: sourceNorm,
          from: fromNorm,
          date: item.date || null,
          link: item.link ? String(item.link).trim() : null,
          status: 'new',
          notes: '',
          history: [{
            timestamp: now,
            type: 'created',
            text: `Task created from ${sourceNorm} scan` +
              (item.actionNeeded ? `\n🎯 Action: ${item.actionNeeded}` : '') +
              (item.deadline ? `\n⏰ Deadline: ${item.deadline}` : '')
          }],
          doneAt: null,
          enrichmentStatus: 'pending',
          updateCheckStatus: 'pending',
          enrichedAt: null,
          lastUpdateCheck: null,
          createdAt: now,
          updatedAt: now
        };

        data.tasks.push(task);
        newTaskIds.push(task.id);
        added++;
      }

      data.lastScan = now;
      return { added, skipped, updated, total: data.tasks.length, lastScan: now, newTaskIds };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Scan failed:', err);
    res.status(500).json({ error: 'Scan failed', detail: err.message });
  }
});

// POST /api/tasks/:id/enrich — Phase 2: content extraction & summary
app.post('/api/tasks/:id/enrich', async (req, res) => {
  const { id } = req.params;

  let task;
  try {
    const data = readTasks();
    task = data.tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    // K1-A: Guard includes 'enriching' to block duplicate requests that arrive while one is already running
    if (['enriched', 'needs-review', 'enriching'].includes(task.enrichmentStatus)) {
      return res.json({ success: true, alreadyEnriched: true, summary: task.summary });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read task', detail: err.message });
  }

  // Mark as enriching
  await safeWriteTasks((data) => {
    const t = data.tasks.find(t => t.id === id);
    if (t) t.enrichmentStatus = 'enriching';
  });

  let client, session;
  try {
    // Extract keywords from title (drop common words, keep distinctive terms)
    const stopWords= new Set(['the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'and', 'or', 'via', 'with', 'from', 'my', 'your', 'is', 'are', 'was', 'be', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'this', 'that', 'these', 'those', 'it', 'its']);
    const keywords = task.title
      .replace(/[^a-zA-Z0-9äöüÄÖÜß\s-]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !stopWords.has(w.toLowerCase()))
      .slice(0, 8)
      .join(' ');

    // Build link context
    let linkContext = '';
    if (task.link) {
      if (task.link.includes('teams.microsoft.com')) {
        const threadMatch = task.link.match(/19:[a-f0-9]+@thread\.[a-z]+/);
        const msgMatch = task.link.match(/\/(\d{10,})\?/);
        linkContext = `\nDirect Teams link: ${task.link}`;
        if (threadMatch) linkContext += `\nTeams Thread ID: ${threadMatch[0]}`;
        if (msgMatch) linkContext += `\nMessage ID: ${msgMatch[1]}`;
      } else if (task.link.includes('outlook.office365.com') || task.link.includes('ItemID=')) {
        linkContext = `\nDirect Outlook link: ${task.link}`;
      }
    }

    const enrichSkill = ENRICH_SKILL || '';
    const enrichPrompt = enrichSkill + '\n\n' +
      `Search for the ${task.source === 'teams' ? 'Teams conversation' : 'email thread'} about: ${keywords}\n` +
      `Full subject: "${task.title}"\n` +
      `Sender (hint, may not be exact): ${task.from || 'unknown'}\n` +
      `Date of original message: ${task.date || 'recent'}\n` +
      `Discovery date (when this action item was first identified): ${task.createdAt || task.date || 'recent'}\n` +
      `Source: ${task.source}` +
      linkContext + '\n\n' +
      `Find ALL messages in this conversation thread. Apply temporal reasoning: information from AFTER the discovery date is a direct update. Information from BEFORE may be historical context — evaluate whether it belongs to THIS action item or to a previous occurrence. Create a summary as specified above.`;

    const enrichStart = Date.now();
    console.log(`[ENRICH] Task "${task.title}" — starting enrichment (prompt: ${enrichPrompt.length} chars)`);
    debugLog('PHASE2', `START enrich "${task.title.substring(0, 60)}"`, { taskId: id, promptLen: enrichPrompt.length, source: task.source });

    await waitForSDKSlot();
    // K1-B: Re-check status after acquiring the slot — another request may have enriched this task
    // while we were waiting (race condition between concurrent batch requests for the same task ID)
    const slotCheck = readTasks();
    const slotTask = slotCheck.tasks.find(t => t.id === id);
    if (slotTask && ['enriched', 'needs-review'].includes(slotTask.enrichmentStatus)) {
      debugLog('PHASE2', `SKIP enrich "${task.title.substring(0, 60)}" — already enriched while waiting for SDK slot`);
      return res.json({ success: true, alreadyEnriched: true, summary: slotTask.summary });
    }
    client = new CopilotClient();
    session = trackSession(await client.createSession({
      tools: [askWorkIQTool, parallelSearchTool],
      onPermissionRequest: approveAll
    }));
    linkClientToSession(session, client);

    const response = await runWithWiqGuard(session, enrichPrompt, 600000);
    const enrichDuration = Date.now() - enrichStart;
    console.log(`[ENRICH] Response in ${(enrichDuration / 1000).toFixed(1)}s`);
    debugLog('PHASE2', `DONE enrich "${task.title.substring(0, 60)}" in ${(enrichDuration / 1000).toFixed(1)}s`);
    await destroySession(session);

    if (!response) {
      await safeWriteTasks((data) => {
        const t = data.tasks.find(t => t.id === id);
        if (t) {
          t.enrichmentStatus = 'error';
          if (!t.history) t.history = [];
          t.history.push({
            timestamp: new Date().toISOString(),
            type: 'enrich-error',
            text: `⚠️ Agent → Work IQ: No response received after ${(enrichDuration / 1000).toFixed(0)}s\n🔑 Keywords: ${keywords}\n📎 Link: ${task.link || 'none'}`
          });
        }
      });
      return res.status(502).json({ error: 'No response from AI engine' });
    }

    const rawContent = response.data.content;
    const result = parseJsonFromResponse(rawContent);

    // Save summary with detailed history
    const updated = await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (!t) return null;

      const now = new Date().toISOString();
      const durationText = `${(enrichDuration / 1000).toFixed(0)}s`;
      if (!t.history) t.history = [];

      if (result && result.summary) {
        t.summary = String(result.summary).trim();
        // Update link if enrichment found one and task has no link yet
        if (result.link && !t.link) {
          t.link = String(result.link).trim();
        }
        t.enrichmentStatus = result.ambiguities && result.ambiguities.length > 0
          ? 'needs-review' : 'enriched';
        t.enrichedAt = now;
        if (result.ambiguities && result.ambiguities.length > 0) {
          t.ambiguities = normalizeAmbiguities(result.ambiguities);
        }
        t.history.push({
          timestamp: now,
          type: 'enriched',
          text: `✅ Content extraction successful (${durationText})\n🔑 Searched: ${keywords}\n📎 Source: ${task.source === 'teams' ? 'Teams chat' : 'Email'} from ${task.from || '?'}\n💬 Confidence: ${result.confidence || '?'} · Language: ${result.language || '?'}\n📋 Summary: ${t.summary}`
            + (result.ambiguities && result.ambiguities.length > 0
              ? `\n⚠️ ${result.ambiguities.length} item(s) need your review` : '')
        });
      } else {
        t.enrichmentStatus = 'error';
        t.history.push({
          timestamp: now,
          type: 'enrich-error',
          text: `❌ Content extraction failed (${durationText})\n🔑 Searched: ${keywords}\n📎 Source: ${task.source === 'teams' ? 'Teams chat' : 'Email'} from ${task.from || '?'}\n⚠️ Error: ${result?.error || 'No usable result from Work IQ'}`
        });
      }
      t.updatedAt = now;
      return { summary: t.summary, enrichmentStatus: t.enrichmentStatus, ambiguities: t.ambiguities || [] };
    });

    res.json({ success: true, ...updated });
  } catch (err) {
    console.error(`[ENRICH] Failed for task ${id}:`, err);
    debugLog('PHASE2', `FAILED enrich "${task.title.substring(0, 60)}": ${err.message}`);
    const isTimeout = err.message && err.message.includes('Timeout');
    await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (t) {
        const now = new Date().toISOString();
        t.enrichmentStatus = 'error';
        t.updatedAt = now;
        if (!t.history) t.history = [];
        t.history.push({
          timestamp: now,
          type: 'enrich-error',
          text: isTimeout
            ? `⏱️ Timeout: Work IQ did not respond within 300s\n🔑 Searched: content for "${task.title.substring(0, 60)}"\n📎 Source: ${task.source === 'teams' ? 'Teams chat' : 'Email'}\n💡 Tip: Task will be retried on the next scan`
            : `❌ System error during content extraction\n⚠️ ${err.message}\n📎 Source: ${task.source === 'teams' ? 'Teams chat' : 'Email'} from ${task.from || '?'}`
        });
      }
    });
    res.status(500).json({ error: 'Enrichment failed', detail: err.message });
  } finally {
    await destroySession(session);
    if (client) {
      try { await client.dispose(); } catch {}
    }
  }
});

// POST /api/tasks/:id/check-update — Phase 3: check for thread updates
// v3.3: Action-Item-State injection, hard query budget, stub detection,
// tristate outcome (updated/no-update/inconclusive), no eval session, pre-filter.
app.post('/api/tasks/:id/check-update', async (req, res) => {
  const { id } = req.params;
  const force = req.query.force === '1' || req.body?.force === true;

  let task;
  try {
    const data = readTasks();
    task = data.tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.updateCheckStatus === 'checking') {
      return res.json({ success: true, alreadyChecking: true });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read task', detail: err.message });
  }

  // Mark as checking (lock — prevents concurrent duplicates)
  await safeWriteTasks((data) => {
    const t = data.tasks.find(t => t.id === id);
    if (t) t.updateCheckStatus = 'checking';
  });

  // v3.3.0: Retroactive Summary Reconciliation ─────────────────────────────
  // Heal tasks where an earlier thread-update was logged in history but the
  // summary itself was never refreshed (older code path or missing newSummary).
  // Runs BEFORE the pre-filter skip so skipped tasks also get healed.
  let reconciledNow = false;
  await safeWriteTasks((data) => {
    const t = data.tasks.find(t => t.id === id);
    if (t && reconcileSummaryWithHistory(t)) {
      reconciledNow = true;
    }
  });
  if (reconciledNow) {
    debugLog('PHASE3', `RECONCILED summary from history for "${task.title.substring(0, 60)}"`, { taskId: id });
    phase3Log(`RECONCILE taskId=${id} title="${task.title.substring(0,60)}" — retroactive summary sync from thread-update history`);
    // re-read task so downstream logic sees the updated summary
    const fresh = readTasks().tasks.find(tt => tt.id === id);
    if (fresh) task = fresh;
  }

  // ─── Pre-Filter (cheap skip) ────────────────────────────────────────────
  // Skip if last SUCCESSFUL check is recent enough. Inconclusive runs do NOT
  // count, so a stuck task gets retried at the next scan instead of being silenced.
  const lastSuccessTs = task.lastSuccessfulUpdateCheck ? Date.parse(task.lastSuccessfulUpdateCheck) : 0;
  const minInterval = phase3MinInterval(task);
  const sinceLastSuccess = Date.now() - lastSuccessTs;
  if (!force && lastSuccessTs && sinceLastSuccess < minInterval) {
    const remaining = Math.round((minInterval - sinceLastSuccess) / 60000);
    debugLog('PHASE3', `SKIP (pre-filter) "${task.title.substring(0, 60)}" — ${Math.round(sinceLastSuccess/60000)}min since last success (min ${Math.round(minInterval/60000)}min)`);
    phase3Log(`SKIP-PREFILTER taskId=${id} title="${task.title.substring(0,60)}" sinceMin=${Math.round(sinceLastSuccess/60000)} minIntervalMin=${Math.round(minInterval/60000)}`);
    await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (t) { t.updateCheckStatus = 'checked'; }
    });
    return res.json({ success: true, skipped: true, reason: 'recent-success', sinceLastSuccessMin: Math.round(sinceLastSuccess/60000), minIntervalMin: Math.round(minInterval/60000) });
  }

  let client, session, sessionId;
  const checkStart = Date.now();
  try {
    await waitForSDKSlot();
    // Re-check after acquiring slot (race with concurrent batch)
    const slotCheck = readTasks();
    const slotTask = slotCheck.tasks.find(t => t.id === id);
    if (slotTask && slotTask.updateCheckStatus === 'checked' && !force) {
      debugLog('PHASE3', `SKIP check "${task.title.substring(0, 60)}" — already checked while waiting for SDK slot`);
      return res.json({ success: true, alreadyChecking: true });
    }
    client = new CopilotClient();
    session = trackSession(await client.createSession({
      tools: [askWorkIQTool, parallelSearchTool],
      onPermissionRequest: approveAll
    }));
    linkClientToSession(session, client);
    sessionId = session.sessionId;
    phase3Register(sessionId, id);

    // ─── Build compact prompt ────────────────────────────────────────────
    // ~700 chars skill + ~2.5 kB action-item state + ~300 chars instructions
    const actionItemState = buildActionItemState(task);
    const updateSkill = UPDATE_CHECK_SKILL || '';
    const checkPrompt = updateSkill + '\n\n' +
      '---\n\n' +
      actionItemState + '\n\n' +
      '---\n\n' +
      `## Your task NOW\n\n` +
      `Determine whether the conversation referenced above has any NEW message(s) dated AFTER the temporal anchor (Last successful check). Use the smallest possible number of ask_work_iq calls (target: 1, hard cap: ${PHASE3_QUERY_BUDGET}). Prefer the Direct link / Thread ID for a focused lookup. Do NOT re-search if your first query returns the same messages already listed in the recent history above.\n\n` +
      `**MANDATORY:** Your ask_work_iq question MUST literally contain the phrase \`Sent Items\` and explicitly request BOTH incoming messages from the counterpart AND messages that I (Martin) sent or replied with in this thread. A self-sent reply IS an update — do not ignore it.\n\n` +
      `**STATE RECONCILIATION:** Even if you find no NEW messages, inspect the current summary above against the Current status field. If the summary already documents a terminal/state-change event (approval complete, done, cancelled, abgeschlossen) but Current status is still 'new' or 'in-progress', emit \`newStatus\` (and \`newTitle\` if needed) in your JSON response — even with hasUpdate=false. This brings the lifecycle into sync with what's already known.\n\n` +
      `Return ONLY the JSON object specified by the skill.`;

    const promptLen = checkPrompt.length;
    const stateBytes = Buffer.byteLength(actionItemState, 'utf8');
    debugLog('PHASE3', `START check "${task.title.substring(0, 60)}"`, { taskId: id, sessionId, since: task.lastSuccessfulUpdateCheck || task.lastUpdateCheck || task.enrichedAt, promptLen, stateBytes });
    phase3Log(`START taskId=${id} sessionId=${sessionId} title="${task.title.substring(0,60)}" promptLen=${promptLen} stateBytes=${stateBytes}`);
    console.log(`[UPDATE-CHECK] Task "${task.title.substring(0, 60)}" — prompt ${promptLen} chars (state ${stateBytes} B)`);

    const response = await runWithWiqGuard(session, checkPrompt, 600000);
    const elapsedMs = Date.now() - checkStart;
    const elapsedS = (elapsedMs / 1000).toFixed(1);
    debugLog('PHASE3', `DONE check "${task.title.substring(0, 60)}" in ${elapsedS}s`);
    await destroySession(session);
    session = null;

    // ─── Outcome classification (tristate) ───────────────────────────────
    const tracking = phase3Get(sessionId) || { count: 0, stubCount: 0, budgetHit: false, wiqDown: false, calls: [] };
    let result = response ? parseJsonFromResponse(response.data?.content) : null;
    const parseFailed = !result;
    const inconclusive = tracking.budgetHit
                      || tracking.stubCount > 0
                      || tracking.wiqDown
                      || (parseFailed && tracking.count === 0)
                      || (parseFailed && tracking.stubCount > 0)
                      || (result && result.inconclusive === true);

    phase3Log(`DONE taskId=${id} sessionId=${sessionId} elapsedS=${elapsedS} queries=${tracking.count} stubCount=${tracking.stubCount} budgetHit=${tracking.budgetHit} wiqDown=${tracking.wiqDown} parseFailed=${parseFailed} inconclusive=${inconclusive} hasUpdate=${!!(result && result.hasUpdate)}`);

    // Save original values before potential modification
    const originalTitle = task.title;
    const originalSummary = task.summary || '';

    let outcome;
    const updated = await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (!t) return null;
      const now = new Date().toISOString();
      t.lastUpdateCheck = now;
      if (!t.history) t.history = [];

      if (inconclusive) {
        outcome = 'inconclusive';
        t.updateCheckStatus = 'inconclusive';
        const reasons = [];
        if (tracking.budgetHit)   reasons.push(`budget-exhausted(${tracking.count})`);
        if (tracking.stubCount)   reasons.push(`stub×${tracking.stubCount}`);
        if (tracking.wiqDown)     reasons.push('wiq-down');
        if (parseFailed)          reasons.push('parse-failed');
        t.history.push({
          timestamp: now,
          type: 'update-check-inconclusive',
          text: `⚠️ Update check inconclusive (${elapsedS}s, ${tracking.count} queries) — reasons: ${reasons.join(', ') || 'unknown'}. Will retry at next scan.`
        });
        t.updatedAt = now;
        return { hasUpdate: false, inconclusive: true, reasons };
      }

      if (result && result.hasUpdate && result.updateSummary) {
        outcome = 'updated';
        t.updateCheckStatus = 'updated';
        t.status = 'updated';
        t.lastSuccessfulUpdateCheck = now;
        const historyLines = [
          `🔄 Update detected (${elapsedS}s, ${tracking.count} queries)`,
          `   Since: ${task.lastSuccessfulUpdateCheck || task.lastUpdateCheck || 'never'}`,
          `   New messages: ${result.newMessageCount || 'unknown'}`,
          `   Update: ${String(result.updateSummary).trim()}`
        ];
        t.history.push({ timestamp: now, type: 'thread-update', text: historyLines.join('\n') });

        // ─── Single-session flow: apply newTitle/newSummary if provided ──
        // No second SDK session. Fallback: if missing, prepend pendingUpdate
        // marker so the update text is never lost.
        const titleChanged = result.newTitle && String(result.newTitle).trim() && String(result.newTitle).trim() !== originalTitle;
        const summaryChanged = result.newSummary && String(result.newSummary).trim();
        if (titleChanged) {
          const prevTitle = t.title;
          t.title = String(result.newTitle).trim();
          t.history.push({
            timestamp: now,
            type: 'title-change',
            text: `📝 Title updated after update check:\n"${prevTitle}" → "${t.title}"\nReason: New information from update check`
          });
        }
        if (summaryChanged) {
          t.summary = String(result.newSummary).trim();
          t.history.push({
            timestamp: now,
            type: 'summary-update',
            text: `📋 Summary refined after update check (single-session, no eval round-trip)`
          });
        } else {
          // Fallback: prepend the raw update so it is visible to the user.
          const ts = formatUpdateTimestamp(new Date());
          t.summary = `🔴 **Update ${ts}:** ${String(result.updateSummary).trim()}\n\n---\n\n${t.summary || ''}`;
          t.history.push({
            timestamp: now,
            type: 'summary-update',
            text: `📋 Update prepended to summary (no newSummary in model response — fallback applied)`
          });
        }
        // Apply newStatus if model provided a valid lifecycle change
        const allowedStatus = new Set(['new', 'on-radar', 'in-progress', 'updated', 'done']);
        if (result.newStatus && allowedStatus.has(String(result.newStatus).trim().toLowerCase())) {
          const newSt = String(result.newStatus).trim().toLowerCase();
          if (newSt !== t.status) {
            const prevStatus = t.status;
            t.status = newSt;
            t.history.push({
              timestamp: now,
              type: 'status-change',
              text: `🔧 Status changed by update check: ${prevStatus} → ${t.status}`
            });
          }
        }
        t.updatedAt = now;
        return { hasUpdate: true, updateSummary: result.updateSummary, titleChanged, summaryChanged };
      }

      // Confirmed "no update" — only path that advances lastSuccessfulUpdateCheck
      outcome = 'no-update';
      t.updateCheckStatus = 'checked';
      t.lastSuccessfulUpdateCheck = now;

      // ─── State Reconciliation (no-update path) ───────────────────────
      // Even with no NEW messages, the model may have detected that the
      // current status / title is inconsistent with the existing summary
      // (e.g. summary says "approved" but status is still "new").
      const allowedStatus = new Set(['new', 'on-radar', 'in-progress', 'updated', 'done']);
      const recoTitleChanged = result && result.newTitle && String(result.newTitle).trim() && String(result.newTitle).trim() !== originalTitle;
      const recoStatusChanged = result && result.newStatus && allowedStatus.has(String(result.newStatus).trim().toLowerCase()) && String(result.newStatus).trim().toLowerCase() !== (t.status || 'new');
      let reconciled = false;
      if (recoTitleChanged) {
        const prevTitle = t.title;
        t.title = String(result.newTitle).trim();
        t.history.push({
          timestamp: now,
          type: 'title-change',
          text: `📝 Title reconciled (no new messages, title now reflects state already in summary):\n"${prevTitle}" → "${t.title}"`
        });
        reconciled = true;
      }
      if (recoStatusChanged) {
        const prevStatus = t.status || 'new';
        t.status = String(result.newStatus).trim().toLowerCase();
        t.history.push({
          timestamp: now,
          type: 'status-change',
          text: `🔧 Status reconciled (no new messages, lifecycle now matches summary): ${prevStatus} → ${t.status}`
        });
        reconciled = true;
      }
      t.history.push({
        timestamp: now,
        type: 'update-check',
        text: `✅ No new activity detected (${elapsedS}s, ${tracking.count} queries)${reconciled ? ' — state reconciled' : ''}`
      });
      t.updatedAt = now;
      return { hasUpdate: false, reconciled, titleChanged: recoTitleChanged, statusChanged: recoStatusChanged };
    });

    debugLog('PHASE3', `OUTCOME ${outcome} for "${task.title.substring(0, 60)}"`, { taskId: id, queries: tracking.count, elapsedS });
    phase3Log(`OUTCOME taskId=${id} outcome=${outcome} queries=${tracking.count} elapsedS=${elapsedS}`);
    res.json({ success: true, outcome, ...updated, queries: tracking.count, elapsedS: parseFloat(elapsedS) });
  } catch (err) {
    console.error(`[UPDATE-CHECK] Failed for task ${id}:`, err);
    debugLog('PHASE3', `FAILED check "${task.title.substring(0, 60)}": ${err.message}`);
    phase3Log(`FAILED taskId=${id} sessionId=${sessionId || '?'} error="${err.message}"`);
    await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (t) {
        const now = new Date().toISOString();
        t.updateCheckStatus = 'error';
        t.updatedAt = now;
        if (!t.history) t.history = [];
        t.history.push({
          timestamp: now,
          type: 'update-check-error',
          text: `❌ Update check failed (searched: "${task.title.slice(0, 40)}")\n   Error: ${err.message}`
        });
      }
    });
    res.status(500).json({ error: 'Update check failed', detail: err.message });
  } finally {
    if (sessionId) phase3Cleanup(sessionId);
    await destroySession(session);
    if (client) {
      try { await client.dispose(); } catch {}
    }
  }
});

// POST /api/consolidate — Phase 4: suggest merging semantically related tasks
app.post('/api/consolidate', async (req, res) => {
  let client, session;
  try {
    const data = readTasks();
    const activeTasks = data.tasks.filter(t =>
      t.status !== 'done' &&
      t.enrichmentStatus !== 'n/a' &&
      (t.enrichmentStatus === 'enriched' || t.enrichmentStatus === 'needs-review') &&
      t.summary
    );

    if (activeTasks.length < 2) {
      return res.json({ success: true, suggestions: [], reason: 'Not enough enriched tasks to compare' });
    }

    // Build task summaries for the AI, filtering out dismissed pairs
    const taskContext = activeTasks.map(t => ({
      id: t.id,
      title: t.title,
      summary: (t.summary || '').substring(0, 150),  // keeps prompt <12k chars
      from: t.from,
      source: t.source
    }));

    // Build list of dismissed pairs to exclude
    const dismissedPairs = new Set();
    for (const t of activeTasks) {
      if (t.noMergeWith && Array.isArray(t.noMergeWith)) {
        for (const otherId of t.noMergeWith) {
          const pair = [t.id, otherId].sort().join('|');
          dismissedPairs.add(pair);
        }
      }
    }

    const consolidateSkill = CONSOLIDATE_SKILL || '';
    const prompt = consolidateSkill + '\n\n' +
      `Here are the active tasks to analyze:\n` +
      JSON.stringify(taskContext, null, 2) +
      (dismissedPairs.size > 0
        ? `\n\nIMPORTANT: The user has already decided to keep the following task pairs SEPARATE. Do NOT suggest merging them:\n` +
          [...dismissedPairs].map(p => p.replace('|', ' and ')).join('\n')
        : '');

    await waitForSDKSlot();
    client = new CopilotClient();
    session = trackSession(await client.createSession({ onPermissionRequest: approveAll }));

    linkClientToSession(session, client);
    const startTime = Date.now();
    console.log(`[CONSOLIDATE] Analyzing ${activeTasks.length} tasks for merge suggestions (prompt: ${prompt.length} chars)`);
    debugLog('PHASE4', `START consolidate (${activeTasks.length} tasks, prompt: ${prompt.length} chars)`);
    const response = await session.sendAndWait({ prompt }, 300000);  // was 180000
    console.log(`[CONSOLIDATE] Response in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    debugLog('PHASE4', `DONE consolidate in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    await destroySession(session);

    if (!response) {
      return res.json({ success: true, suggestions: [], reason: 'No response from AI' });
    }

    const suggestions = parseJsonFromResponse(response.data.content);
    if (!Array.isArray(suggestions)) {
      return res.json({ success: true, suggestions: [], reason: 'AI returned unexpected format' });
    }

    // Filter out dismissed pairs from suggestions
    const filteredSuggestions = suggestions.filter(s => {
      if (!s.taskIds || s.taskIds.length < 2) return false;
      // Check if any pair in this group was dismissed
      for (let i = 0; i < s.taskIds.length; i++) {
        for (let j = i + 1; j < s.taskIds.length; j++) {
          const pair = [s.taskIds[i], s.taskIds[j]].sort().join('|');
          if (dismissedPairs.has(pair)) return false;
        }
      }
      // Verify all task IDs actually exist
      return s.taskIds.every(id => activeTasks.some(t => t.id === id));
    });

    // Enrich suggestions with task titles for the frontend
    const enrichedSuggestions = filteredSuggestions.map(s => ({
      ...s,
      tasks: s.taskIds.map(id => {
        const t = activeTasks.find(t => t.id === id);
        return { id: t.id, title: t.title };
      })
    }));

    console.log(`[CONSOLIDATE] ${enrichedSuggestions.length} merge suggestion(s) found`);
    res.json({ success: true, suggestions: enrichedSuggestions });
  } catch (err) {
    console.error('[CONSOLIDATE] Failed:', err);
    debugLog('PHASE4', `FAILED consolidate: ${err.message}`);
    res.json({ success: true, suggestions: [], reason: err.message });
  } finally {
    await destroySession(session);
    if (client) {
      try { await client.dispose(); } catch {}
    }
  }
});

// POST /api/tasks/merge — merge two or more tasks into one
app.post('/api/tasks/merge', async (req, res) => {
  const { taskIds, suggestedTitle } = req.body;
  if (!taskIds || !Array.isArray(taskIds) || taskIds.length < 2) {
    return res.status(400).json({ error: 'At least 2 task IDs required' });
  }

  let client, session;
  try {
    const data = readTasks();
    const tasksToMerge = taskIds.map(id => data.tasks.find(t => t.id === id)).filter(Boolean);
    if (tasksToMerge.length < 2) {
      return res.status(404).json({ error: 'Could not find enough tasks to merge' });
    }

    // Generate merged summary via AI (no MCP needed)
    await waitForSDKSlot();
    client = new CopilotClient();
    session = trackSession(await client.createSession({ onPermissionRequest: approveAll }));

    linkClientToSession(session, client);
    const mergePrompt = `You are merging multiple action items into one unified summary.

TASKS TO MERGE:
${tasksToMerge.map((t, i) => `\n--- Task ${i + 1}: "${t.title}" ---\nSummary: ${t.summary || '(no summary)'}\nFrom: ${t.from || 'unknown'}\nSource: ${t.source}`).join('\n')}

INSTRUCTIONS:
1. Create a UNIFIED SUMMARY in STRUCTURED FORMAT with 3 visually separated sections:

   [1-2 sentence context: what this merged task is about]

   ---

   🔴 **Nächste Schritte:** (or **Next steps:** if content is in English)
   - All currently pending items from all tasks combined

   ---

   ✅ **Bisheriger Verlauf:** (or **History:** if content is in English)
   - DD.MM. — One-line milestone (most recent first)

2. Preserve ALL important details: names, dates, decisions, action items.
3. Use "---" (Markdown horizontal rule) between sections.
4. NEVER use "📌 Update (date):" format — that is deprecated.
5. Write in the SAME LANGUAGE as the original summaries.
6. If different people have different perspectives, attribute them clearly.

Return ONLY valid JSON:
{
  "mergedSummary": "The complete unified summary in structured format",
  "mergedTitle": "A concise title (max 15 words) for the merged task"
}`;

    const startTime = Date.now();
    console.log(`[MERGE] Merging ${tasksToMerge.length} tasks`);
    debugLog('MERGE', `START merge ${tasksToMerge.length} tasks`, { taskIds, suggestedTitle });
    const response = await session.sendAndWait({ prompt: mergePrompt }, 90000);
    console.log(`[MERGE] Response in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    debugLog('MERGE', `DONE merge in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
    await destroySession(session);

    let mergedTitle = suggestedTitle || tasksToMerge[0].title;
    let mergedSummary = tasksToMerge.map(t => t.summary || '').filter(Boolean).join('\n\n---\n\n');

    if (response) {
      const result = parseJsonFromResponse(response.data.content);
      if (result) {
        if (result.mergedSummary) mergedSummary = String(result.mergedSummary).trim();
        if (result.mergedTitle) mergedTitle = String(result.mergedTitle).trim();
      }
    }

    // Perform the merge
    const primaryId = taskIds[0];
    const secondaryIds = taskIds.slice(1);

    const mergedTask = await safeWriteTasks((data) => {
      const primary = data.tasks.find(t => t.id === primaryId);
      if (!primary) return null;

      const now = new Date().toISOString();
      if (!primary.history) primary.history = [];

      // Merge history from all secondary tasks
      const allHistoryEntries = [];
      for (const secId of secondaryIds) {
        const sec = data.tasks.find(t => t.id === secId);
        if (sec && sec.history) {
          allHistoryEntries.push(...sec.history);
        }
      }
      // Sort all histories chronologically and prepend to primary
      allHistoryEntries.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      primary.history = [...allHistoryEntries, ...primary.history];

      // Add merge event to history
      const mergedTitles = secondaryIds.map(id => {
        const t = data.tasks.find(t => t.id === id);
        return t ? `"${t.title}"` : id;
      }).join(', ');
      primary.history.push({
        timestamp: now,
        type: 'merge',
        text: `🔗 Merged with: ${mergedTitles}`
      });

      // Update primary task
      primary.title = mergedTitle;
      primary.summary = mergedSummary;
      primary.updatedAt = now;

      // Collect ALL links from all tasks being merged
      const allLinks = [];
      for (const t of [primary, ...secondaryIds.map(id => data.tasks.find(t => t.id === id)).filter(Boolean)]) {
        if (t.link) {
          allLinks.push({ url: t.link, source: t.source || 'unknown', from: t.from || null });
        }
        if (t.additionalLinks) {
          allLinks.push(...t.additionalLinks);
        }
      }
      // Deduplicate by URL
      const seenUrls = new Set();
      const uniqueLinks = allLinks.filter(l => {
        if (seenUrls.has(l.url)) return false;
        seenUrls.add(l.url);
        return true;
      });
      // Primary keeps its own link, rest go to additionalLinks
      if (uniqueLinks.length > 1) {
        primary.additionalLinks = uniqueLinks.filter(l => l.url !== primary.link);
      } else if (uniqueLinks.length === 1 && !primary.link) {
        primary.link = uniqueLinks[0].url;
        primary.source = uniqueLinks[0].source;
        primary.from = primary.from || uniqueLinks[0].from;
      }

      // Merge notes from secondary tasks
      const allNotes = [primary.notes || '', ...secondaryIds.map(id => {
        const t = data.tasks.find(t => t.id === id);
        return t?.notes || '';
      })].filter(Boolean);
      if (allNotes.length > 1) {
        primary.notes = allNotes.join('\n\n');
      }

      // Remove noMergeWith entries for merged tasks
      if (primary.noMergeWith) {
        primary.noMergeWith = primary.noMergeWith.filter(id => !secondaryIds.includes(id));
      }

      // Delete secondary tasks
      data.tasks = data.tasks.filter(t => !secondaryIds.includes(t.id));

      return primary;
    });

    if (!mergedTask) {
      return res.status(404).json({ error: 'Primary task not found' });
    }

    console.log(`[MERGE] Successfully merged ${taskIds.length} tasks into "${mergedTitle}"`);
    res.json({ success: true, task: mergedTask });
  } catch (err) {
    console.error('[MERGE] Failed:', err);
    debugLog('MERGE', `FAILED merge: ${err.message}`);
    res.status(500).json({ error: 'Merge failed', detail: err.message });
  } finally {
    await destroySession(session);
    if (client) {
      try { await client.dispose(); } catch {}
    }
  }
});

// POST /api/tasks/:id/dismiss-merge — dismiss a merge suggestion for a pair of tasks
app.post('/api/tasks/:id/dismiss-merge', async (req, res) => {
  const { id } = req.params;
  const { dismissedTaskIds } = req.body;

  if (!dismissedTaskIds || !Array.isArray(dismissedTaskIds) || dismissedTaskIds.length === 0) {
    return res.status(400).json({ error: 'dismissedTaskIds array required' });
  }

  try {
    const result = await safeWriteTasks((data) => {
      // Add noMergeWith on ALL tasks in the group (bidirectional)
      const allIds = [id, ...dismissedTaskIds];
      for (const taskId of allIds) {
        const t = data.tasks.find(t => t.id === taskId);
        if (!t) continue;
        if (!t.noMergeWith) t.noMergeWith = [];
        for (const otherId of allIds) {
          if (otherId !== taskId && !t.noMergeWith.includes(otherId)) {
            t.noMergeWith.push(otherId);
          }
        }
      }
      return true;
    });

    res.json({ success: true });
  } catch (err) {
    console.error('[DISMISS-MERGE] Failed:', err);
    res.status(500).json({ error: 'Failed to dismiss merge', detail: err.message });
  }
});

// POST /api/tasks/:id/log/analyze — Phase 1: AI analyzes log request (v1.4, intent-based v1.5)
app.post('/api/tasks/:id/log/analyze', async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Log text is required' });
  }

  // Read task context
  let task;
  try {
    const data = readTasks();
    task = data.tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read tasks', detail: err.message });
  }

  const taskDate = task.date || task.createdAt || '';
  debugLog('USER-ACTION', `Log Work analyze: "${text.substring(0, 80)}" for task "${task.title.substring(0, 50)}"`, { taskId: id });
  const recentHistory = (task.history || [])
    .filter(h => h.type === 'update' || h.type === 'note')
    .slice(-8)
    .map(h => {
      let entry = `[${h.timestamp}] USER: ${h.text}`;
      if (h.agentPlan) {
        const intent = h.agentPlan.intent || 'search';
        entry += `\nAGENT (${intent}): ${h.agentPlan.understanding}`;
      }
      if (h.communications && h.communications.length > 0) {
        for (const c of h.communications) {
          entry += `\n  📧 ${c.from || '?'} → ${c.to || '?'}: ${c.summary || '(no summary)'}`;
        }
      }
      return entry;
    })
    .join('\n---\n');

  // Try AI analysis (Copilot SDK without Work IQ — fast, just reasoning)
  let client, session, preSession;
  try {
    client = new CopilotClient();

    // Pre-filter: if user explicitly reports an action ("Ich habe X bestätigt/mitgeteilt/..."),
    // skip intent classification entirely and use a dedicated update-only prompt.
    // This prevents the LLM from misclassifying user action reports as search requests.
    const lowerText = text.toLowerCase().trim();
    // Negation check: if the user says "Ich habe NICHT bestätigt" or "I did NOT confirm", skip the pre-filter
    const hasNegation = /\b(nicht|never|not|nie|kein|keine|keinen|keinem|keiner)\b/.test(lowerText);
    const ichHabeAction = !hasNegation && /\bich habe\b/.test(lowerText) &&
      /\b(bestätigt|gesendet|editiert|mitgeteilt|erledigt|geschickt|gemacht|aktualisiert|abgeschlossen|eingereicht|gespeichert|geändert|übermittelt|informiert|kommuniziert|fertiggestellt|verschickt|weitergeleitet|submitted|confirmed)\b/.test(lowerText);
    const iDidAction = !hasNegation && /\bi (did|sent|edited|confirmed|completed|finished|told|communicated|submitted|forwarded)\b/i.test(lowerText);
    
    if (ichHabeAction || iDidAction) {
      console.log(`[ANALYZE] Pre-filter: detected "Ich habe..." action report → forcing update-only prompt`);
      preSession = trackSession(await client.createSession({ onPermissionRequest: approveAll }));
      linkClientToSession(preSession, client);
      try {
        const updateOnlyPrompt = `You are updating a task tracker. The user is providing information and wants the task updated.

TASK:
Title: "${task.title}"
Summary: ${task.summary || '(none)'}
${recentHistory ? `\nHistory:\n${recentHistory}\n` : ''}
USER'S MESSAGE:
"${text.trim()}"

RULES FOR THE SUMMARY — STRUCTURED FORMAT:
The summary MUST follow this exact structure with 3 visually separated sections:

[1-2 sentence context: what this task is about]

---

🔴 **Nächste Schritte:** (or **Next steps:** if content is in English)
- What needs to happen NOW based on latest information
- Who must act, what are we waiting for

---

✅ **Bisheriger Verlauf:** (or **History:** if content is in English)
- DD.MM. — One-line milestone (most recent first)

RULES:
- Integrate the user's new information into the appropriate section
- If something was completed → move from 🔴 to ✅
- If something new is pending → add to 🔴
- NEVER use "📌 Update (date):" block format — that is deprecated
- If the existing summary uses the old format (stacked 📌 Update blocks), MIGRATE it to the new structured format
- EXCEPTION: If the user says content is FALSE/WRONG → remove that specific false content, add a note in ✅ explaining the correction
- Write in the same language as the existing content

Return ONLY this JSON (no markdown, no explanation):
{
  "intent": "update",
  "newTitle": "Updated title reflecting current state (max ~15 words). Keep the original title if it still fits: ${JSON.stringify(task.title)}",
  "newSummary": "The COMPLETE updated summary in structured format",
  "changeDescription": "Brief description of what changed based on the user's message"
}`;
        const updateResponse = await preSession.sendAndWait({ prompt: updateOnlyPrompt }, 60000);
        await destroySession(preSession);
        if (updateResponse) {
          const updateResult = parseJsonFromResponse(updateResponse.data.content);
          if (updateResult && updateResult.intent === 'update') {
            const newTitle = updateResult.newTitle ? String(updateResult.newTitle).trim() : null;
            const newSummary = updateResult.newSummary ? String(updateResult.newSummary).trim() : null;
            const changeDescription = updateResult.changeDescription || '';

            const savedTask = await safeWriteTasks((data) => {
              const t = data.tasks.find(t => t.id === id);
              if (!t) return null;
              const now = new Date().toISOString();
              if (!t.history) t.history = [];
              if (newTitle && newTitle !== t.title) {
                const previousTitle = t.title;
                t.title = newTitle;
                t.history.push({ timestamp: now, type: 'title-change', text: `📝 Title changed:\n"${previousTitle}" → "${newTitle}"` });
              }
              if (newSummary) {
                const previousSummary = t.summary;
                t.summary = newSummary;
                t.history.push({ timestamp: now, type: 'summary-update', text: `✏️ Summary updated via user interaction` + (previousSummary ? `\nPrevious: ${previousSummary.length > 300 ? previousSummary.substring(0, 300) + '...' : previousSummary}` : '') });
              }
              t.history.push({ timestamp: now, type: 'user-update', text: `💬 User: ${text.trim()}${changeDescription ? `\n→ ${changeDescription}` : ''}` });
              return t;
            });
            return res.json({ intent: 'update', result: updateResult.changeDescription || 'Task updated', newTitle, newSummary, changeDescription, task: savedTask });
          }
        }
      } catch (preErr) {
        console.log(`[ANALYZE] Pre-filter update failed: ${preErr.message}, falling through to normal classification`);
        await destroySession(preSession);
      }
    }

    session = trackSession(await client.createSession({ onPermissionRequest: approveAll }));

    linkClientToSession(session, client);
    const analyzePrompt = `You are an intelligent assistant managing a task tracker. The user sends you messages about a specific task. Your job is to UNDERSTAND what the user wants and act accordingly.

TASK CONTEXT:
Title: "${task.title}"
Summary: ${task.summary || '(no summary available)'}
From: ${task.from || 'unknown'}
Source: ${task.source}
Date: ${taskDate}

RECENT CONVERSATION:
${recentHistory || '(no prior conversation)'}

USER'S MESSAGE:
"${text.trim()}"

## HOW TO THINK ABOUT THIS

FUNDAMENTAL PRINCIPLE — ask yourself ONE question first:
**"Does the user's message CONTAIN the information, or is the user asking me to GO FIND it?"**
- If the information is IN the message → the intent is **"update"** (or summarize/rename/answer)
- If the user asks you to SEARCH for information they don't have → the intent is **"search"**
This distinction overrides everything else. A message that contains concrete details (dates, names, meeting info, status updates) is NEVER a search request, even if those details look like they came from an email or calendar.

Follow this decision tree IN ORDER. Stop at the first match:

### Step 1: Is the user PROVIDING information or asking you to UPDATE the task?
The user gives you concrete data — meeting details, dates, names, decisions, quotes, status changes, links — and wants the task updated.
Examples: "Aktualisiere mit diesen Infos: Dry-Run am 16.3...", "Hier ist das Ergebnis: ...", "Das Meeting ist am Montag um 14 Uhr bestätigt."
→ If the user GIVES you concrete information in their message: this is **"update"**.

### Step 1.5: Is the user REPORTING something they did?
Patterns: "Ich habe...", "I did...", "I sent...", "I edited...", "I confirmed..."
→ If YES: this is **"update"**.
⚠️ Even if the message mentions "E-Mail", "Teams", "Chat" — these describe HOW the user communicated. They are NOT requests to search!

### Step 1.7: Is the user CORRECTING or DISPUTING existing information AND wants VERIFICATION?
The user says something currently stored in the title or summary is WRONG, inaccurate, or did not happen, AND wants you to CHECK in M365 whether it's true. Look for:
- Explicit denial + request to verify: "Das stimmt nicht, überprüfe das", "Check if that's true"
- Contradiction where the user is UNSURE: "Ich glaube das wurde nie bestellt", "I don't think I confirmed that"
⚠️ If the user KNOWS it's wrong and just wants it REMOVED (e.g. "ist komplett falsch und muss entfernt werden", "remove this, it's wrong") → this is **"update"** with removal, NOT "correct". The user is not asking you to verify — they are telling you to fix it.
→ If the user wants M365 VERIFICATION before changing: **"correct"**

### Step 2: Does the user ask to ONLY rename the title?
Look for: "nenne es...", "ändere den Titel zu...", "rename to..."
→ If YES and only the title should change: **"rename"**

### Step 3: Does the user explicitly ask for a summary?
Look for: "fasse zusammen", "summarize" — AND the user is NOT providing information to incorporate
→ If YES: **"summarize"**

### Step 4: Does the user ask a question answerable from the task context?
Look for questions about dates, people, status, next steps — where the answer is in the summary/context
→ If YES: **"answer"**

### Step 5: Does the user explicitly ask to FIND or CHECK communications?
The user does NOT have the information and wants you to GO LOOK for it.
Look for: "gibt es neue Nachrichten", "suche nach", "check my inbox", "find emails from", "was hat X geschrieben", "schau in meiner Inbox nach"
⚠️ CRITICAL CHECK: Re-read the user's message. Does it already CONTAIN specific details (dates, times, participants, decisions)? If YES → go back to Step 1, this is "update". The user is NOT asking you to search — they already have the information!
→ If the user genuinely asks you to find something they don't know: **"search"**

### Step 6: Default
If the user provides ANY new information (a link, a date, a status update, a quote from someone) → **"update"**
If truly nothing matches → **"search"** as last resort

## KEY ANTI-PATTERNS (NEVER do these):
- "Aktualisiere die Zusammenfassung mit diesen Informationen: [details]" → **UPDATE**. The user GAVE you the information. Do NOT search for it.
- "Ich habe X per E-Mail bestätigt" → **UPDATE**. The user told you what they did.
- "Hier ist Jawads Antwort: ..." → **UPDATE**. The user pasted the answer. Do NOT search.
- The word "E-Mail" in a user's OWN action report is NEVER a trigger to search emails.

## INTENTS

Choose the intent that best matches what the user actually wants:

**"update"** — The user provides new information AND wants the task updated (title, summary, or both). Use this when:
  - User reports an action they took ("I edited...", "I sent...", "I talked to...")
  - User provides new context with a link or reference
  - User asks to update BOTH title and summary
  - User describes what changed and wants the task to reflect it
  This is the most common intent when a user interacts with a task to keep it current.

**"summarize"** — The user provides text/content to summarize, OR wants ONLY the summary corrected/replaced (not the title).

**"rename"** — The user wants ONLY the title changed (not the summary).

**"answer"** — The user asks a question answerable from the task context, conversation history, or general knowledge. No external search needed.

**"correct"** — The user disputes or denies existing information in the task's title or summary. They claim something is WRONG, did not happen, or is inaccurate. This requires VERIFICATION against M365 communications before any change is made.
  Use this when the user contradicts stored facts — NOT when they simply add new information.

**"search"** — The user explicitly wants you to FIND communications in their M365 environment (emails, Teams, calendar). This requires Work IQ search and is the ONLY intent that triggers an external search.
  ONLY use "search" when the user clearly asks you to look up, find, search, or check something in their communications.

## RESPONSE FORMAT

EVERY response MUST start with a "_reasoning" field. Think through this BEFORE choosing an intent.

For "update":
{
  "_reasoning": "The user says 'Ich habe...' / reports an action / provides new information → update",
  "intent": "update",
  "newTitle": "Short, factual title reflecting the current state of the action item (max ~15 words). If the user doesn't ask for a title change, keep the original: ${JSON.stringify(task.title)}",
  "newSummary": "IMPORTANT: The summary MUST use the STRUCTURED FORMAT with 3 sections separated by '---' (Markdown horizontal rules):\n\n[1-2 sentence context]\n\n---\n\n🔴 **Nächste Schritte:**\n- Current pending items\n\n---\n\n✅ **Bisheriger Verlauf:**\n- DD.MM. — Milestone\n\nIntegrate new information into the appropriate section. Move completed items from 🔴 to ✅. NEVER use '📌 Update (date):' format — it is deprecated. If the existing summary uses the old stacked update format, MIGRATE it to the structured format. EXCEPTION: If the user says content is FALSE/WRONG → remove it and note the correction in ✅.",
  "changeDescription": "Brief human-readable description of what you changed and why"
}

For "summarize":
{
  "_reasoning": "The user explicitly asks for a summary / 'fasse zusammen'",
  "intent": "summarize",
  "result": "The complete updated summary. Write in the same language as the user's message."
}

For "rename":
{
  "_reasoning": "The user wants only the title changed",
  "intent": "rename",
  "result": "The new task title — concise, clear, max ~15 words."
}

For "answer":
{
  "_reasoning": "The user asks a question I can answer from context",
  "intent": "answer",
  "result": "Your direct answer to the user's question."
}

For "search":
{
  "_reasoning": "The user explicitly asks me to FIND/LOOK UP/CHECK communications — they are NOT reporting their own action",
  "intent": "search",
  "understanding": "A clear action plan: what you will search, where, and what you expect to find. Use 'I will...' or 'Ich werde...'",
  "expectedAnswer": "What KIND of answer the user needs. Examples: 'A person name', 'A date', 'A status update'.",
  "searchFrom": "WHO to search for — a person name, email domain, or null if searching by topic only",
  "keywords": ["primary", "search", "terms", "in the user's language"],
  "keywordsEnglish": ["English", "translations", "if user writes in German"],
  "timeWindow": {
    "from": "ISO date string — use task date as default start",
    "to": "ISO date string or 'now'",
    "reasoning": "why this time window"
  },
  "searchTargets": "inbox, sent, teams, or all",
  "needsClarification": false,
  "clarificationQuestion": null
}

For "correct":
{
  "_reasoning": "The user says the current title/summary contains wrong information about X — this needs verification against M365",
  "intent": "correct",
  "disputedClaim": "What specific claim the user says is wrong (extracted from current title/summary)",
  "userAssertion": "What the user says is actually true (in their own words)",
  "affectedFields": ["title", "summary"],
  "keywords": ["search", "terms", "to verify the claim"],
  "keywordsEnglish": ["English", "translations"],
  "verificationQuestion": "The specific question to answer by searching M365 — e.g. 'Was a Cisco SSD actually ordered?'"
}

## GUIDELINES

- For "update", "summarize", "answer", "rename": provide the result IMMEDIATELY — the user should not need to click Execute.
- For "correct": return the correction plan — the frontend will show a "Verify" button. The user's claim must be checked against M365 evidence before any change is made.
- For "search": think about WHO sends the relevant emails (person name or company domain → searchFrom). If the user writes in German but emails may be in English, provide keywordsEnglish with translated terms.
- Write in the same language as the user's message (German → German, English → English).
- When unsure between "update" and "correct": if the user says existing info is WRONG → "correct". If the user provides NEW info → "update".
- When unsure between "update" and "search": if the user's message starts with "Ich habe..." or "I did..." or contains information they are GIVING you (a link, a status report, a completed action), it's ALWAYS "update" — NEVER "search".
- NEVER interpret "per E-Mail", "per Teams", "per Chat" as a signal to search. These describe the user's OWN actions, not a request to find communications.
- "search" should ONLY be used when the user explicitly asks you to LOOK FOR or FIND something in their communications.

## FINAL CHECK (do this before responding)
Before you output your JSON, ask yourself:
1. "Does the user's message contain 'Ich habe' or 'I did/sent/edited/confirmed'?" If YES → "update" (unless negated: "Ich habe NICHT..." → could be "correct").
2. "Does the user say something in the title/summary is WRONG or did not happen?" If YES → "correct".

## CLASSIFICATION EXAMPLES (follow these exactly)

User: "Ich habe das ATP an Jamie per E-Mail bestätigt. Er kann jetzt die Rechnung stellen."
→ {"_reasoning": "User says 'Ich habe bestätigt' — reporting own action", "intent": "update", ...}

User: "Ich habe Harshitha mein Thema mitgeteilt: Agent Zero Demo"
→ {"_reasoning": "User says 'Ich habe mitgeteilt' — reporting own action", "intent": "update", ...}

User: "Ich habe das Slide Deck editiert. https://sharepoint.com/... Aktualisiere die Zusammenfassung."
→ {"_reasoning": "User says 'Ich habe editiert' + wants update", "intent": "update", ...}

User: "Das stimmt nicht, die SSD wurde nie bestellt."
→ {"_reasoning": "User disputes existing info — says SSD was never ordered, contradicts summary", "intent": "correct", ...}

User: "Der Titel ist falsch. Es geht nicht um eine Bestellung, sondern um eine Anfrage."
→ {"_reasoning": "User says title is wrong — current info is factually incorrect", "intent": "correct", ...}

User: "Ich habe das NICHT bestätigt, das ist falsch."
→ {"_reasoning": "User denies having confirmed — negation + dispute of stored info", "intent": "correct", ...}

User: "Gibt es neue Nachrichten von Sebastian wegen der SSD?"
→ {"_reasoning": "User asks to FIND communications", "intent": "search", ...}

User: "Was ist der nächste Schritt?"
→ {"_reasoning": "Question answerable from context", "intent": "answer", ...}

Return ONLY the JSON object. No markdown, no explanation.`;

    const response = await session.sendAndWait({ prompt: analyzePrompt }, 60000);
    await destroySession(session);

    if (response) {
      const result = parseJsonFromResponse(response.data.content);
      if (result && typeof result === 'object' && result.intent) {
        // For summarize/answer: save immediately to history
        if ((result.intent === 'summarize' || result.intent === 'answer') && result.result) {
          const savedTask = await safeWriteTasks((data) => {
            const t = data.tasks.find(t => t.id === id);
            if (!t) return null;
            const now = new Date().toISOString();
            if (!t.history) t.history = [];

            // When intent is "summarize", overwrite the main task summary
            if (result.intent === 'summarize') {
              const previousSummary = t.summary;
              t.summary = String(result.result).trim();
              t.history.push({
                timestamp: now,
                type: 'summary-update',
                text: `✏️ Summary updated via user interaction` +
                  (previousSummary ? `\nPrevious: ${previousSummary.length > 300 ? previousSummary.substring(0, 300) + '...' : previousSummary}` : '')
              });
              console.log(`[${now}] Summary updated for task "${task.title}" (${id})`);
            }

            t.history.push({
              timestamp: now,
              type: 'update',
              text: text.trim(),
              agentPlan: {
                intent: result.intent,
                understanding: result.result
              }
            });
            t.updatedAt = now;
            return t;
          });
          return res.json({ intent: result.intent, result: result.result, task: savedTask });
        }

        // For rename: update title immediately and log the change
        if (result.intent === 'rename' && result.result) {
          const newTitle = String(result.result).trim();
          const savedTask = await safeWriteTasks((data) => {
            const t = data.tasks.find(t => t.id === id);
            if (!t) return null;
            const now = new Date().toISOString();
            if (!t.history) t.history = [];

            const previousTitle = t.title;
            t.title = newTitle;
            t.history.push({
              timestamp: now,
              type: 'title-change',
              text: `📝 Title changed:\n"${previousTitle}" → "${newTitle}"`
            });
            t.history.push({
              timestamp: now,
              type: 'update',
              text: text.trim(),
              agentPlan: {
                intent: 'rename',
                understanding: `Title renamed from "${previousTitle}" to "${newTitle}"`
              }
            });
            t.updatedAt = now;
            return t;
          });
          console.log(`[${new Date().toISOString()}] Title renamed for task (${id}): "${task.title}" → "${newTitle}"`);
          return res.json({ intent: 'rename', result: newTitle, previousTitle: task.title, task: savedTask });
        }

        // For update: verify-and-improve loop before saving
        if (result.intent === 'update') {
          let newTitle = result.newTitle ? String(result.newTitle).trim() : null;
          let newSummary = result.newSummary ? String(result.newSummary).trim() : null;
          let changeDescription = result.changeDescription || '';

          // VERIFY-AND-IMPROVE LOOP: Agent checks its own work
          // Max 2 iterations to avoid infinite loops
          let verifyClient, verifySession;
          try {
            for (let attempt = 1; attempt <= 2; attempt++) {
              verifyClient = new CopilotClient();
              verifySession = trackSession(await verifyClient.createSession({ onPermissionRequest: approveAll }));

              linkClientToSession(verifySession, verifyClient);
              const verifyPrompt = `You are a quality reviewer. A user gave an instruction to update a task. An agent produced changes. Your job is to verify whether the agent's changes correctly fulfil the user's instruction.

USER'S ORIGINAL INSTRUCTION:
"${text.trim()}"

TASK BEFORE CHANGES:
Title: "${task.title}"
Summary: ${task.summary || '(none)'}

AGENT'S PROPOSED CHANGES:
New Title: ${newTitle ? `"${newTitle}"` : '(unchanged)'}
New Summary: ${newSummary ? `"${newSummary.substring(0, 2000)}"` : '(unchanged)'}
Change Description: "${changeDescription}"

EVALUATE:
1. Does the new title correctly reflect the user's instruction? Did the agent change what the user asked for?
2. Does the new summary correctly reflect the user's instruction? If the user asked to REMOVE something, is it actually removed? If the user asked to ADD something, is it actually added?
3. Is important existing content preserved (unless the user explicitly asked to remove it)?
4. Overall: did the agent do what the user asked?

Return ONLY valid JSON:
{
  "fulfilled": true or false,
  "issues": "If not fulfilled: describe specifically what is wrong or missing. If fulfilled: null"
}`;

              const verifyResponse = await verifySession.sendAndWait({ prompt: verifyPrompt }, 60000);
              await destroySession(verifySession);

              if (verifyResponse) {
                const verifyResult = parseJsonFromResponse(verifyResponse.data.content);
                if (verifyResult && verifyResult.fulfilled === true) {
                  console.log(`[VERIFY] Update verified on attempt ${attempt} ✅`);
                  break;
                } else if (verifyResult && verifyResult.fulfilled === false && attempt < 2) {
                  // Agent didn't fulfil the request — try again with feedback
                  console.log(`[VERIFY] Issues found on attempt ${attempt}: ${verifyResult.issues}`);
                  
                  let retryClient, retrySession;
                  try {
                    retryClient = new CopilotClient();
                    retrySession = trackSession(await retryClient.createSession({ onPermissionRequest: approveAll }));
                    
                    const retryPrompt = `You previously tried to update a task but the result was not correct. Fix the issues and try again.

USER'S ORIGINAL INSTRUCTION:
"${text.trim()}"

CURRENT TASK:
Title: "${task.title}"
Summary: ${task.summary || '(none)'}

YOUR PREVIOUS ATTEMPT:
New Title: ${newTitle ? `"${newTitle}"` : '(unchanged)'}
New Summary: ${newSummary ? `"${newSummary.substring(0, 2000)}"` : '(unchanged)'}

ISSUES WITH YOUR PREVIOUS ATTEMPT:
${verifyResult.issues}

Fix these issues. Return ONLY valid JSON:
{
  "newTitle": "Corrected title",
  "newSummary": "Corrected summary",
  "changeDescription": "What you fixed"
}`;

                    const retryResponse = await retrySession.sendAndWait({ prompt: retryPrompt }, 60000);
                    
                    if (retryResponse) {
                      const retryResult = parseJsonFromResponse(retryResponse.data.content);
                      if (retryResult) {
                        if (retryResult.newTitle) newTitle = String(retryResult.newTitle).trim();
                        if (retryResult.newSummary) newSummary = String(retryResult.newSummary).trim();
                        changeDescription = retryResult.changeDescription || changeDescription;
                        console.log(`[VERIFY] Retry produced improved result, verifying again...`);
                      }
                    }
                  } finally {
                    if (retrySession) await destroySession(retrySession);
                    if (retryClient) { try { await retryClient.dispose(); } catch {} }
                  }
                } else {
                  console.log(`[VERIFY] Verification inconclusive on attempt ${attempt}, proceeding with current result`);
                  break;
                }
              } else {
                console.log(`[VERIFY] No verification response, proceeding with current result`);
                break;
              }

              try { await verifyClient.dispose(); } catch {}
              verifyClient = null;
            }
          } catch (verifyErr) {
            console.warn(`[VERIFY] Verification failed (non-fatal): ${verifyErr.message}`);
          } finally {
            if (verifySession) await destroySession(verifySession);
            if (verifyClient) { try { await verifyClient.dispose(); } catch {} }
          }

          // Save the (potentially improved) result
          const savedTask = await safeWriteTasks((data) => {
            const t = data.tasks.find(t => t.id === id);
            if (!t) return null;
            const now = new Date().toISOString();
            if (!t.history) t.history = [];

            const changes = [];

            if (newTitle && newTitle !== t.title) {
              const previousTitle = t.title;
              t.title = newTitle;
              t.history.push({
                timestamp: now,
                type: 'title-change',
                text: `📝 Title changed:\n"${previousTitle}" → "${newTitle}"`
              });
              changes.push(`Title: "${previousTitle}" → "${newTitle}"`);
            }

            if (newSummary) {
              const previousSummary = t.summary;
              t.summary = newSummary;
              t.history.push({
                timestamp: now,
                type: 'summary-update',
                text: `✏️ Summary updated via user interaction` +
                  (previousSummary ? `\nPrevious: ${previousSummary.length > 300 ? previousSummary.substring(0, 300) + '...' : previousSummary}` : '')
              });
              changes.push('Summary updated');
            }

            t.history.push({
              timestamp: now,
              type: 'update',
              text: text.trim(),
              agentPlan: {
                intent: 'update',
                understanding: changeDescription || changes.join(', ')
              }
            });
            t.updatedAt = now;
            return t;
          });
          console.log(`[${new Date().toISOString()}] Task updated (${id}): ${changeDescription}`);
          return res.json({
            intent: 'update',
            result: changeDescription || 'Task updated',
            newTitle: newTitle,
            newSummary: newSummary,
            previousTitle: newTitle ? task.title : undefined,
            task: savedTask
          });
        }

        // For correct: return correction plan for frontend verification flow
        if (result.intent === 'correct') {
          const correctionPlan = {
            disputedClaim: result.disputedClaim || '',
            userAssertion: result.userAssertion || '',
            affectedFields: result.affectedFields || ['summary'],
            keywords: result.keywords || [],
            keywordsEnglish: result.keywordsEnglish || [],
            verificationQuestion: result.verificationQuestion || ''
          };
          return res.json({ intent: 'correct', plan: correctionPlan });
        }

        // For search: return plan as before
        if (result.intent === 'search') {
          const plan = {
            understanding: result.understanding || '',
            searchFrom: result.searchFrom || null,
            keywords: result.keywords || [],
            timeWindow: result.timeWindow || { from: taskDate, to: 'now' },
            searchTargets: result.searchTargets || 'all',
            needsClarification: result.needsClarification || false,
            clarificationQuestion: result.clarificationQuestion || null
          };
          return res.json({ intent: 'search', plan });
        }

        // Unknown intent with result — treat as answer
        if (result.result) {
          const savedTask = await safeWriteTasks((data) => {
            const t = data.tasks.find(t => t.id === id);
            if (!t) return null;
            const now = new Date().toISOString();
            if (!t.history) t.history = [];
            t.history.push({
              timestamp: now,
              type: 'update',
              text: text.trim(),
              agentPlan: { intent: 'answer', understanding: result.result }
            });
            t.updatedAt = now;
            return t;
          });
          return res.json({ intent: 'answer', result: result.result, task: savedTask });
        }
      }
    }

    // AI returned nothing useful → fall through to deterministic fallback
    throw new Error('AI returned no valid response');
  } catch (err) {
    console.warn('AI analysis failed, using deterministic fallback:', err.message);

    // Deterministic fallback: extract keywords from title, default time window
    const keywords = extractKeywords(task.title);
    const plan = {
      understanding: `I will search your inbox and Teams for messages related to "${task.title}" from ${task.from || 'the sender'}, starting from the task date. If I find relevant communications, I will summarize them for you.`,
      keywords,
      timeWindow: {
        from: taskDate || new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
        to: 'now',
        reasoning: 'Default: from task date to today'
      },
      searchTargets: 'inbox and teams',
      needsClarification: false,
      clarificationQuestion: null
    };
    return res.json({ intent: 'search', plan, fallback: true });
  } finally {
    await destroySession(preSession);
    await destroySession(session);
    if (client) {
      try { await client.dispose(); } catch {}
    }
  }
});

// POST /api/tasks/:id/log — log work with AI communication search (v2.2: intelligent search)
app.post('/api/tasks/:id/log', async (req, res) => {
  const { id } = req.params;
  const { text, plan } = req.body;

  if (!text || !text.trim()) {
    return res.status(400).json({ error: 'Log text is required' });
  }

  // Read task context for the prompt (outside write queue)
  let taskContext;
  try {
    const data = readTasks();
    taskContext = data.tasks.find(t => t.id === id);
    if (!taskContext) {
      return res.status(404).json({ error: 'Task not found' });
    }
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read tasks', detail: err.message });
  }

  // AI communication search (v2.2: Copilot SDK + Work IQ MCP + SEARCH_SKILL.md)
  debugLog('USER-ACTION', `Log Work execute: intent=${plan?.intent || 'unknown'} for task "${taskContext.title.substring(0, 50)}"`, { taskId: id });
  let communications = [];
  let rawResponseText = null;
  let promptContext = null;
  let searchError = null;
  let searchMethod = 'copilot-sdk-search-skill';
  let searchConfidence = null;
  let searchAnswer = null;
  let searchAttempts = [];
  let searchAmbiguities = [];
  const searchStartTime = Date.now();

  let client, session;
  try {
    const taskDate = taskContext.date || taskContext.createdAt || '';

    // Build the search prompt from the plan (v2.2) or fallback
    let searchPrompt;
    if (plan && SEARCH_SKILL) {
      // v2.2: Intelligent search with SEARCH_SKILL.md
      const allKeywords = [
        ...(plan.keywords || []),
        ...(plan.keywordsEnglish || [])
      ].filter(Boolean);

      const timeDesc = plan.timeWindow
        ? `from ${plan.timeWindow.from || taskDate} to ${plan.timeWindow.to || 'now'}`
        : `from ${taskDate} onward`;

      searchPrompt = SEARCH_SKILL + '\n\n' +
        `## Your Search Assignment\n\n` +
        `USER'S QUESTION: "${text.trim()}"\n` +
        `EXPECTED ANSWER TYPE: ${plan.expectedAnswer || 'general information'}\n\n` +
        `TASK CONTEXT:\n` +
        `- Title: "${taskContext.title}"\n` +
        `- From: ${taskContext.from || 'unknown'}\n` +
        `- Source: ${taskContext.source}\n` +
        `- Date: ${taskDate}\n` +
        `- Summary: ${taskContext.summary || '(no summary)'}\n\n` +
        `SEARCH PARAMETERS:\n` +
        `- Keywords: ${allKeywords.join(', ') || 'use task title keywords'}\n` +
        `- Search from: ${plan.searchFrom || 'any sender'}\n` +
        `- Time window: ${timeDesc}\n` +
        `- Search targets: ${plan.searchTargets || 'all'}\n\n` +
        `ACTION PLAN: ${plan.understanding || 'Search for communications related to the task'}\n\n` +
        `Execute your search now. Remember: 3 attempts, self-assessment after each, discard irrelevant results.`;

      searchMethod = 'copilot-sdk-search-skill';
    } else if (LOG_WORK_SKILL) {
      // Fallback: LOG_WORK_SKILL.md (legacy, no plan available)
      searchPrompt = LOG_WORK_SKILL + '\n\n' +
        `TASK CONTEXT:\n` +
        `Task: "${taskContext.title}"\n` +
        `Original sender: ${taskContext.from || 'unknown'}, Source: ${taskContext.source}, Date: ${taskDate}\n\n` +
        `USER LOG:\n` +
        `"${text.trim()}"\n\n` +
        `Search from ${taskDate} onward.`;

      searchMethod = 'copilot-sdk-legacy';
    } else {
      // Minimal fallback: no skill file at all
      searchPrompt = `The user logged work on this task:\n` +
        `Task: "${taskContext.title}"\n` +
        `Original sender: ${taskContext.from || 'unknown'}, Source: ${taskContext.source}, Date: ${taskDate}\n\n` +
        `User says: "${text.trim()}"\n\n` +
        `Search my emails and Teams messages for the FULL conversation thread ` +
        `related to this task. Use the task title keywords as search terms. ` +
        `Search from ${taskDate} onward. Include ALL replies, forwards, and ` +
        `CC responses in the thread — not just the original message.\n\n` +
        `For each message found, return a JSON object with:\n` +
        `type ("email" or "teams"), from (sender name), to (recipient names), ` +
        `date (ISO 8601), summary (1-2 sentence summary), ` +
        `link (URL or null).\n\n` +
        `Return ONLY a JSON array ordered by date (oldest first). No markdown.\n` +
        `If nothing found, return [].`;

      searchMethod = 'copilot-sdk-minimal';
    }

    promptContext = `[${searchMethod}] Task: "${taskContext.title}" | From: ${taskContext.from || 'unknown'} | Date: ${taskDate} | User: "${text.trim()}"`;

    console.log(`[LOG] ${searchMethod} for task "${taskContext.title}" at ${new Date().toISOString()}`);
    console.log(`[LOG] Prompt size: ${searchPrompt.length} chars`);

    client = new CopilotClient();
    session = trackSession(await client.createSession({
      tools: [askWorkIQTool, parallelSearchTool],
      onPermissionRequest: approveAll
    }));

    linkClientToSession(session, client);
    const response = await session.sendAndWait({ prompt: searchPrompt }, 300000);
    const elapsed = Date.now() - searchStartTime;
    console.log(`[LOG] Response received in ${elapsed}ms`);
    await destroySession(session);

    if (response) {
      const rawContent = response.data.content;
      rawResponseText = typeof rawContent === 'string' ? rawContent.substring(0, 8000) : JSON.stringify(rawContent).substring(0, 8000);
      console.log(`[LOG] Preview: ${rawResponseText.substring(0, 300)}...`);

      const parsed = parseJsonFromResponse(rawContent);

      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.answer !== undefined) {
        // v2.2 SEARCH_SKILL response format: { answer, confidence, searchAttempts, communications, ambiguities }
        searchAnswer = parsed.answer || null;
        searchConfidence = parsed.confidence || null;
        searchAttempts = parsed.searchAttempts || [];
        searchAmbiguities = parsed.ambiguities || [];
        communications = Array.isArray(parsed.communications) ? parsed.communications : [];
        console.log(`[LOG] SEARCH_SKILL response: confidence=${searchConfidence}, comms=${communications.length}, attempts=${searchAttempts.length}`);
      } else if (Array.isArray(parsed)) {
        // Legacy format: plain JSON array of communications
        communications = parsed;
        console.log(`[LOG] Legacy format: ${communications.length} communications`);
      } else {
        // Try Markdown email parser as fallback
        const mdEmails = parseMarkdownEmails(rawContent);
        if (mdEmails) {
          communications = mdEmails;
          console.log(`[LOG] Parsed ${communications.length} communications (Markdown)`);
        } else {
          console.warn(`[LOG] No structured data parsed — storing natural language response`);
        }
      }
    }
  } catch (err) {
    const elapsed = Date.now() - searchStartTime;
    console.error(`[LOG] ${searchMethod} failed after ${elapsed}ms:`, err.message);
    searchError = err.message;
  } finally {
    await destroySession(session);
    if (client) {
      try { await client.dispose(); } catch {}
    }
  }

  const searchDurationMs = Date.now() - searchStartTime;

  // Build a final agent response summary (v2.2: 3-tier honest formatting)
  let agentResponse = '';
  if (searchError) {
    agentResponse = `❌ Search failed: ${searchError}`;
  } else if (searchAnswer) {
    // v2.2: Use the agent's own answer (it already evaluated relevance)
    const confidenceIcon = { high: '✅', medium: '⚠️', low: '🔍', none: '❌' }[searchConfidence] || '🔍';
    agentResponse = `${confidenceIcon} ${searchAnswer}`;
    if (searchAmbiguities.length > 0) {
      agentResponse += '\n\n⚠️ ' + searchAmbiguities.join('\n⚠️ ');
    }
    if (communications.length > 0) {
      const summaries = communications.map((c, i) => {
        const icon = c.type === 'teams' ? '💬' : '📧';
        const date = c.date ? new Date(c.date).toLocaleDateString('de-CH') : '';
        return `${i + 1}. ${icon} **${c.from || 'Unknown'}** → ${c.to || ''} (${date})${c.summary ? ': ' + c.summary : ''}`;
      }).join('\n');
      agentResponse += `\n\n📋 ${communications.length} communication(s):\n${summaries}`;
    }
  } else if (communications.length > 0) {
    // Legacy format: communications without answer
    const summaries = communications.map((c, i) => {
      const icon = c.type === 'teams' ? '💬' : '📧';
      const date = c.date ? new Date(c.date).toLocaleDateString('de-CH') : '';
      return `${i + 1}. ${icon} **${c.from || 'Unknown'}** → ${c.to || ''} (${date})${c.summary ? ': ' + c.summary : ''}`;
    }).join('\n');
    agentResponse = `✅ ${communications.length} communication(s) found:\n\n${summaries}`;
  } else if (rawResponseText) {
    // Agent returned text but no structured results — show the natural language answer
    agentResponse = rawResponseText;
  } else {
    agentResponse = `🔍 No results found. The search did not return any matching emails or Teams messages. Would you like to try again with different keywords or a broader time window?`;
  }

  // Write the history entry via queue
  try {
    let task = await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (!t) return null;
      if (!t.history) t.history = [];

      const now = new Date().toISOString();
      t.history.push({
        timestamp: now,
        type: 'update',
        text: text.trim(),
        communications,
        agentResponse,
        agentPlan: plan ? {
          intent: plan.intent || 'search',
          understanding: plan.understanding || '',
          expectedAnswer: plan.expectedAnswer || '',
          keywords: plan.keywords || [],
          keywordsEnglish: plan.keywordsEnglish || [],
          timeWindow: plan.timeWindow || {},
          searchTargets: plan.searchTargets || 'all',
          userConfirmed: true,
          fallback: !!plan.fallback
        } : undefined,
        agentExecution: {
          promptSent: promptContext,
          rawResponse: rawResponseText,
          parsedCount: communications.length,
          confidence: searchConfidence,
          answer: searchAnswer,
          searchAttempts,
          ambiguities: searchAmbiguities,
          error: searchError,
          durationMs: searchDurationMs,
          method: searchMethod
        }
      });
      t.updatedAt = now;
      return t;
    });

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    // Post-search evaluation: check if title and summary need updating based on new information
    let evaluation = null;
    if (!searchError && (searchAnswer || communications.length > 0)) {
      let evalClient, evalSession;
      try {
        console.log(`[EVAL] Starting post-search evaluation for task "${task.title}" (${id})`);
        evalClient = new CopilotClient();
        evalSession = trackSession(await evalClient.createSession({ onPermissionRequest: approveAll }));

        linkClientToSession(evalSession, evalClient);
        const commSummaries = communications.slice(0, 10).map(c => {
          const date = c.date ? new Date(c.date).toLocaleDateString('de-CH') : '';
          return `- ${c.from || '?'} → ${c.to || '?'} (${date}): ${c.summary || c.subject || ''}`;
        }).join('\n');

        const evalPrompt = `You are evaluating whether a task's title and summary need updating based on new information from a search.

CURRENT TASK:
Title: "${task.title}"
Summary: ${task.summary ? `"${task.summary}"` : '(no summary)'}

USER'S REQUEST:
"${text.trim()}"

SEARCH RESULTS:
Answer: ${searchAnswer || '(no structured answer)'}
Confidence: ${searchConfidence || 'unknown'}
Communications found: ${communications.length}
${commSummaries ? `Details:\n${commSummaries}` : ''}

INSTRUCTIONS:

CRITICAL RULE: If the user EXPLICITLY asks you to update the title and/or summary (e.g. "aktualisiere die Zusammenfassung", "update the title", "ändere den Titel"), you MUST do so using the search results. The user's request is an ORDER, not a suggestion. Only skip updating if the search returned zero results.

1. TITLE evaluation — be PROACTIVE about updating:
   - The title must reflect the CURRENT state of this action item, not the original request.
   - If the search reveals that the situation has evolved (reply received, decision made, deadline passed, request fulfilled, meeting confirmed), UPDATE the title.
   - If the user explicitly asked to update the title, you MUST update it to reflect the latest findings.
   - Be decisive: if the search reveals a changed situation, the title MUST change.
   - Keep it concise: max 15 words, factual, no emojis.

2. SUMMARY — use STRUCTURED FORMAT with 3 visually separated sections:

   The summary MUST follow this exact structure:

   [1-2 sentence context: what this task is about]

   ---

   🔴 **Nächste Schritte:** (or **Next steps:** if content is in English)
   - What needs to happen NOW based on latest information
   - Who must act, what are we waiting for
   - 📧 *Source reference if known*

   ---

   ✅ **Bisheriger Verlauf:** (or **History:** if content is in English)
   - DD.MM. — One-line milestone (most recent first)
   - DD.MM. — One-line milestone

   RULES:
   - The CONTEXT section (top) stays stable — only update if the core nature of the task changed.
   - The 🔴 section reflects the CURRENT state after integrating search results.
   - Move resolved items from 🔴 to ✅ as one-liners.
   - Use "---" (Markdown horizontal rule) between each section.
   - NEVER use "📌 Update (date):" block format — that is deprecated.
   - Do NOT duplicate information between sections.
   - Write in the SAME language as the existing content.
   - If the existing summary uses the old format (stacked 📌 Update blocks), MIGRATE it to the new structured format.
   - Only skip summary changes if the search returned zero results AND the user did NOT explicitly request an update.

3. Only set *Changed to true when there is a GENUINE reason to update. An explicit user request to update IS a genuine reason.

Return ONLY valid JSON, no markdown:
{
  "titleChanged": true or false,
  "newTitle": "new title text (only if titleChanged is true, otherwise omit)",
  "summaryChanged": true or false,
  "newSummary": "full updated summary text (only if summaryChanged is true, otherwise omit)",
  "reasoning": "One sentence explaining why changes were or were not needed"
}`;

        const evalResponse = await evalSession.sendAndWait({ prompt: evalPrompt }, 90000);  // was 60000
        await destroySession(evalSession);

        if (evalResponse) {
          const evalResult = parseJsonFromResponse(evalResponse.data.content);
          if (evalResult && typeof evalResult === 'object') {
            evaluation = evalResult;
            console.log(`[EVAL] Result: titleChanged=${evalResult.titleChanged}, summaryChanged=${evalResult.summaryChanged}, reasoning="${evalResult.reasoning || ''}"`);

            if (evalResult.titleChanged || evalResult.summaryChanged) {
              const updatedTask = await safeWriteTasks((data) => {
                const t = data.tasks.find(t => t.id === id);
                if (!t) return null;
                const now = new Date().toISOString();
                if (!t.history) t.history = [];

                if (evalResult.titleChanged && evalResult.newTitle) {
                  const prevTitle = t.title;
                  t.title = String(evalResult.newTitle).trim();
                  t.history.push({
                    timestamp: now,
                    type: 'title-change',
                    text: `📝 Title updated after search:\n"${prevTitle}" → "${t.title}"\nReason: ${evalResult.reasoning || 'New information from search'}`
                  });
                  console.log(`[EVAL] Title changed: "${prevTitle}" → "${t.title}"`);
                }

                if (evalResult.summaryChanged && evalResult.newSummary) {
                  const prevSummary = t.summary;
                  t.summary = String(evalResult.newSummary).trim();
                  t.history.push({
                    timestamp: now,
                    type: 'summary-update',
                    text: `📋 Summary updated after search\nReason: ${evalResult.reasoning || 'New information from search'}` +
                      (prevSummary ? `\nPrevious: ${prevSummary.length > 300 ? prevSummary.substring(0, 300) + '...' : prevSummary}` : '')
                  });
                  console.log(`[EVAL] Summary updated (${t.summary.length} chars)`);
                }

                t.updatedAt = now;
                return t;
              });
              if (updatedTask) task = updatedTask;
            }
          }
        }
      } catch (evalErr) {
        console.error(`[EVAL] Post-search evaluation failed (non-fatal): ${evalErr.message}`);
      } finally {
        await destroySession(evalSession);
        if (evalClient) {
          try { await evalClient.dispose(); } catch {}
        }
      }
    }

    res.json({ ...task, evaluation });
    debugLog('USER-ACTION', `Log Work DONE: result=OK`, { taskId: id });
  } catch (err) {
    res.status(500).json({ error: 'Failed to log work', detail: err.message });
  }
});

// POST /api/tasks/:id/review — User responds to ambiguity review items (v2.1)
app.post('/api/tasks/:id/review', async (req, res) => {
  const { id } = req.params;
  const { response } = req.body;

  if (!response || !response.trim()) {
    return res.status(400).json({ error: 'Response text is required' });
  }

  let task;
  try {
    const data = readTasks();
    task = data.tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read tasks', detail: err.message });
  }

  const ambiguities = normalizeAmbiguities(task.ambiguities);
  const openItems = ambiguities.filter(a => !a.resolved);
  if (openItems.length === 0) {
    return res.json({ success: true, message: 'No open review items', task });
  }

  const now = new Date().toISOString();
  console.log(`[${now}] Review response for task "${task.title}" (${id}): "${response.trim().substring(0, 100)}..."`);
  debugLog('USER-ACTION', `Review response for "${task.title.substring(0, 50)}": "${response.substring(0, 80)}"`, { taskId: id });

  let client, session;
  try {
    client = new CopilotClient();
    session = trackSession(await client.createSession({
      tools: [askWorkIQTool, parallelSearchTool],
      onPermissionRequest: approveAll
    }));

    linkClientToSession(session, client);
    const reviewPrompt= `You are an intelligent assistant for a task management app. The user is responding to review questions that the agent flagged as uncertain during content enrichment.

TASK CONTEXT:
Title: "${task.title}"
Source: ${task.source}
From: ${task.from || 'unknown'}
Current Summary: ${task.summary || '(no summary)'}

OPEN REVIEW QUESTIONS:
${openItems.map((a, i) => `${i}: "${a.question}"`).join('\n')}

USER'S RESPONSE:
"${response.trim()}"

CRITICAL INSTRUCTIONS — RESEARCH BEFORE ANSWERING:
1. Read the user's response carefully. If the user asks you to VERIFY, CHECK, ANALYZE, RESEARCH, or INVESTIGATE something — you MUST use your search tools to find the actual information in emails and Teams messages. Do NOT simply accept the user's assumptions as fact.
2. Even if the user states an opinion (e.g. "I don't think X is related to Y"), you must independently verify this by searching for the relevant communications. Then either CONFIRM the user's view with evidence, or PRESENT COUNTER-EVIDENCE if you find a connection.
3. Only after you have done your own research (when the user's response warrants it), decide which review questions are resolved.
4. If the user's response is a simple factual answer (e.g. "Yes, the deadline was extended" or "No, that's a different project"), you can resolve the question directly without additional search.

After your analysis, return ONLY this JSON:
{
  "resolvedIndices": [0, 2],
  "updatedSummary": "The complete updated summary in STRUCTURED FORMAT. Use 3 sections separated by '---': [context paragraph] --- 🔴 **Nächste Schritte:** [pending items] --- ✅ **Bisheriger Verlauf:** [milestones]. NEVER use '📌 Update' format. If the existing summary uses old format, MIGRATE it. Write in the same language as the current summary. If no changes needed, return null.",
  "remainingQuestions": ["Any new or still-open question — only if truly unresolved"],
  "allResolved": true,
  "researchPerformed": true
}

RULES:
- resolvedIndices: array of indices (0-based) from the OPEN REVIEW QUESTIONS list that are now answered
- updatedSummary: must be a COMPLETE replacement summary (not a diff), or null if no update needed. If you performed research, incorporate your findings.
- remainingQuestions: empty array [] if all resolved, otherwise new/reformulated open questions
- allResolved: true if all open questions are answered, false otherwise
- researchPerformed: true if you used search tools to verify, false if direct answer was sufficient
- Be thorough — if the user asks you to verify something, actually verify it before resolving
- Write in the same language as the user's response

Return ONLY the JSON object. No markdown, no explanation.`;

    const aiResponse = await session.sendAndWait({ prompt: reviewPrompt }, 180000);
    await destroySession(session);

    if (!aiResponse) {
      return res.status(500).json({ error: 'No response from AI' });
    }

    const result = parseJsonFromResponse(aiResponse.data.content);
    if (!result || typeof result !== 'object') {
      return res.status(500).json({ error: 'Could not parse AI response' });
    }

    // Apply resolution
    const updatedTask = await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (!t) return null;
      if (!t.history) t.history = [];
      const nowWrite = new Date().toISOString();

      // Normalize existing ambiguities
      t.ambiguities = normalizeAmbiguities(t.ambiguities);

      // Map open items back to the full array and mark resolved ones
      const resolvedSet = new Set(result.resolvedIndices || []);
      let openIndex = 0;
      for (let i = 0; i < t.ambiguities.length; i++) {
        if (!t.ambiguities[i].resolved) {
          if (resolvedSet.has(openIndex)) {
            t.ambiguities[i].resolved = true;
            t.ambiguities[i].resolvedAt = nowWrite;
          }
          openIndex++;
        }
      }

      // Add remaining questions as new open items
      if (result.remainingQuestions && result.remainingQuestions.length > 0) {
        for (const q of result.remainingQuestions) {
          t.ambiguities.push({ question: String(q).trim(), resolved: false });
        }
      }

      // Update summary if provided
      const previousSummary = t.summary;
      if (result.updatedSummary) {
        t.summary = String(result.updatedSummary).trim();
        t.history.push({
          timestamp: nowWrite,
          type: 'summary-update',
          text: `✏️ Summary updated after review clarification` +
            (previousSummary ? `\nPrevious: ${previousSummary.length > 300 ? previousSummary.substring(0, 300) + '...' : previousSummary}` : '')
        });
      }

      // Check if all resolved
      const stillOpen = t.ambiguities.filter(a => !a.resolved);
      if (stillOpen.length === 0) {
        t.enrichmentStatus = 'enriched';
      }

      // Log the review interaction
      const resolvedCount = resolvedSet.size;
      const totalOpen = openItems.length;
      t.history.push({
        timestamp: nowWrite,
        type: 'review-response',
        text: response.trim(),
        agentPlan: {
          intent: 'review',
          understanding: `${resolvedCount}/${totalOpen} items resolved` +
            (stillOpen.length > 0 ? ` — ${stillOpen.length} still open` : ' — all resolved') +
            (result.updatedSummary ? ' · Summary updated' : '')
        }
      });

      t.updatedAt = nowWrite;
      return t;
    });

    if (!updatedTask) {
      return res.status(404).json({ error: 'Task not found' });
    }

    console.log(`[${now}] Review resolved: ${result.resolvedIndices?.length || 0} items, allResolved: ${result.allResolved}`);
    res.json({ success: true, task: updatedTask });
  } catch (err) {
    console.error(`[REVIEW] Failed for task ${id}:`, err);
    res.status(500).json({ error: 'Review processing failed', detail: err.message });
  } finally {
    await destroySession(session);
    if (client) {
      try { await client.dispose(); } catch {}
    }
  }
});

// POST /api/tasks/:id/correct — Evidence-based correction verification (v2.6: Opus 4.6 + Work IQ MCP)
app.post('/api/tasks/:id/correct', async (req, res) => {
  const { id } = req.params;
  const { plan } = req.body;

  if (!plan || !plan.disputedClaim) {
    return res.status(400).json({ error: 'Correction plan with disputedClaim is required' });
  }

  let task;
  try {
    const data = readTasks();
    task = data.tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read tasks', detail: err.message });
  }

  const now = new Date().toISOString();
  console.log(`[${now}] Correction verification for task "${task.title}" (${id}): disputed="${plan.disputedClaim}", user says="${plan.userAssertion}"`);

  let client, session;
  try {
    client = new CopilotClient();
    session = trackSession(await client.createSession({
      tools: [askWorkIQTool, parallelSearchTool],
      onPermissionRequest: approveAll
    }));

    linkClientToSession(session, client);
    const taskDate= task.date || task.createdAt || '';
    const allKeywords = [
      ...(plan.keywords || []),
      ...(plan.keywordsEnglish || [])
    ].filter(k => k && k.trim());

    const correctPrompt = (CORRECT_SKILL || '') + '\n\n' +
      `## Verification Task\n\n` +
      `**Disputed claim (currently stored):** ${plan.disputedClaim}\n` +
      `**User's assertion (what they say is true):** ${plan.userAssertion}\n` +
      `**Verification question:** ${plan.verificationQuestion || 'Is the stored information correct or is the user right?'}\n\n` +
      `## Task Context\n\n` +
      `- **Title:** ${task.title}\n` +
      `- **Summary:** ${task.summary || '(no summary)'}\n` +
      `- **From:** ${task.from || 'unknown'}\n` +
      `- **Source:** ${task.source}\n` +
      `- **Date:** ${taskDate}\n\n` +
      `## Search Parameters\n\n` +
      `- **Keywords:** ${allKeywords.join(', ') || 'extract from context'}\n` +
      `- **Time window:** from ${taskDate || '2 weeks ago'} to now\n` +
      `- **Search targets:** all (inbox, sent, teams)\n\n` +
      `Search for evidence. Apply the truth hierarchy. Return your verdict as JSON.`;

    const aiResponse = await session.sendAndWait({ prompt: correctPrompt }, 300000);
    await destroySession(session);

    if (!aiResponse) {
      return res.status(502).json({ error: 'No response from AI engine' });
    }

    const result = parseJsonFromResponse(aiResponse.data.content);
    if (!result || typeof result !== 'object' || !result.verdict) {
      return res.status(500).json({ error: 'Could not parse verification response' });
    }

    // If verdict is user_correct: apply correction immediately
    if (result.verdict === 'user_correct') {
      const updatedTask = await safeWriteTasks((data) => {
        const t = data.tasks.find(t => t.id === id);
        if (!t) return null;
        const nowWrite = new Date().toISOString();
        if (!t.history) t.history = [];

        const previousTitle = t.title;
        const previousSummary = t.summary;

        if (result.suggestedTitle && result.suggestedTitle !== t.title) {
          t.title = result.suggestedTitle;
          t.history.push({
            timestamp: nowWrite,
            type: 'title-change',
            text: `📝 Title corrected after verification:\n"${previousTitle}" → "${result.suggestedTitle}"`
          });
        }

        if (result.suggestedSummary) {
          t.summary = result.suggestedSummary;
          t.history.push({
            timestamp: nowWrite,
            type: 'summary-update',
            text: `✏️ Summary corrected after verification` +
              (previousSummary ? `\nPrevious: ${previousSummary.length > 300 ? previousSummary.substring(0, 300) + '...' : previousSummary}` : '')
          });
        }

        t.history.push({
          timestamp: nowWrite,
          type: 'correction',
          text: `🔍 Correction verified (${result.confidence} confidence):\n` +
            `Disputed: ${plan.disputedClaim}\n` +
            `Verdict: User is correct — ${result.explanation}`
        });

        t.updatedAt = nowWrite;
        return t;
      });

      return res.json({
        verdict: 'user_correct',
        confidence: result.confidence,
        explanation: result.explanation,
        evidence: result.evidence || [],
        searchAttempts: result.searchAttempts || [],
        applied: true,
        task: updatedTask
      });
    }

    // If verdict is current_correct or inconclusive: return evidence for discussion/veto
    const savedTask = await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (!t) return null;
      const nowWrite = new Date().toISOString();
      if (!t.history) t.history = [];

      t.history.push({
        timestamp: nowWrite,
        type: 'correction',
        text: `🔍 Correction verification (${result.confidence} confidence):\n` +
          `Disputed: ${plan.disputedClaim}\n` +
          `Verdict: ${result.verdict === 'current_correct' ? 'Current information appears correct' : 'Inconclusive — insufficient evidence'}\n` +
          `${result.explanation}`
      });

      t.updatedAt = nowWrite;
      return t;
    });

    return res.json({
      verdict: result.verdict,
      confidence: result.confidence,
      explanation: result.explanation,
      evidence: result.evidence || [],
      searchAttempts: result.searchAttempts || [],
      suggestedTitle: result.suggestedTitle,
      suggestedSummary: result.suggestedSummary,
      applied: false,
      task: savedTask
    });

  } catch (err) {
    console.error(`[CORRECT] Failed for task ${id}:`, err);
    res.status(500).json({ error: 'Correction verification failed', detail: err.message });
  } finally {
    await destroySession(session);
    if (client) {
      try { await client.dispose(); } catch {}
    }
  }
});

// POST /api/tasks/:id/correct/resolve — User resolves correction discussion (accept evidence or veto)
app.post('/api/tasks/:id/correct/resolve', async (req, res) => {
  const { id } = req.params;
  const { action, correctedTitle, correctedSummary } = req.body;

  if (!action || !['accept', 'veto'].includes(action)) {
    return res.status(400).json({ error: 'Action must be "accept" or "veto"' });
  }

  let task;
  try {
    const data = readTasks();
    task = data.tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read tasks', detail: err.message });
  }

  const now = new Date().toISOString();

  if (action === 'accept') {
    // User accepts that the current information is correct — no changes needed
    const updatedTask = await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (!t) return null;
      if (!t.history) t.history = [];

      t.history.push({
        timestamp: now,
        type: 'correction-dismissed',
        text: `✅ User accepted verification result — current information confirmed as correct`
      });

      t.updatedAt = now;
      return t;
    });

    console.log(`[${now}] Correction resolved (accept): task "${task.title}" (${id})`);
    return res.json({ success: true, action: 'accept', task: updatedTask });
  }

  // action === 'veto': User overrides — their version is applied regardless of evidence
  if (!correctedTitle && !correctedSummary) {
    return res.status(400).json({ error: 'Veto requires at least correctedTitle or correctedSummary' });
  }

  const updatedTask = await safeWriteTasks((data) => {
    const t = data.tasks.find(t => t.id === id);
    if (!t) return null;
    if (!t.history) t.history = [];

    const previousTitle = t.title;
    const previousSummary = t.summary;

    if (correctedTitle && correctedTitle.trim() !== t.title) {
      t.title = correctedTitle.trim();
      t.history.push({
        timestamp: now,
        type: 'title-change',
        text: `📝 Title corrected (user veto):\n"${previousTitle}" → "${correctedTitle.trim()}"`
      });
    }

    if (correctedSummary && correctedSummary.trim()) {
      t.summary = correctedSummary.trim();
      t.history.push({
        timestamp: now,
        type: 'summary-update',
        text: `✏️ Summary corrected (user veto)` +
          (previousSummary ? `\nPrevious: ${previousSummary.length > 300 ? previousSummary.substring(0, 300) + '...' : previousSummary}` : '')
      });
    }

    t.history.push({
      timestamp: now,
      type: 'correction-veto',
      text: `⚡ User exercised veto right — correction applied despite evidence suggesting otherwise`
    });

    t.updatedAt = now;
    return t;
  });

  console.log(`[${now}] Correction resolved (veto): task "${task.title}" (${id})`);
  return res.json({ success: true, action: 'veto', task: updatedTask });
});

// Extract JSON array from AI response (handles markdown code blocks)
function parseJsonFromResponse(text) {
  if (!text) return null;
  // Try direct parse first
  try { return JSON.parse(text); } catch {}
  // Try extracting from markdown code block
  const match = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (match) {
    try { return JSON.parse(match[1]); } catch {}
  }
  // Try finding a JSON array in the text
  const arrMatch = text.match(/\[[\s\S]*\]/);
  if (arrMatch) {
    try { return JSON.parse(arrMatch[0]); } catch {}
  }
  return null;
}

// Parse Work IQ Markdown response into structured communications array
// Anchors on **From:** (most reliable field), searches context window for other fields
function parseMarkdownEmails(text) {
  if (!text) return null;
  const emails = [];
  const clean = s => s.trim()
    .replace(/\*+/g, '')
    .replace(/\[.*?\]\(https?:[^\)]+\)/g, '')  // strip markdown citations
    .replace(/\\$/g, '')
    .replace(/\s{2,}$/g, '')
    .trim();

  // Strategy: split by --- separators (Work IQ uses these between emails)
  const blocks = text.split(/\n---\n|\n---$/m);
  for (const block of blocks) {
    // Must contain **From:** to be an email block
    if (!/\*\*From:\*\*/i.test(block)) continue;
    const email = { type: 'email' };
    const fromMatch = block.match(/\*\*From:\*\*\s*(.+)/i);
    if (fromMatch) email.from = clean(fromMatch[1]);
    const subjectMatch = block.match(/\*\*Subject:\*\*\s*(.+)/i);
    if (subjectMatch) email.summary = clean(subjectMatch[1]);
    const dateMatch = block.match(/\*\*Date:\*\*\s*(.+)/i);
    if (dateMatch) email.date = clean(dateMatch[1]);
    const toMatch = block.match(/\*\*To:\*\*\s*(.+)/i);
    if (toMatch) email.to = clean(toMatch[1]);
    const linkMatch = block.match(/\[.*?\]\((https:\/\/outlook[^\)]+)\)/);
    if (linkMatch) email.link = linkMatch[1];
    // Fallback: extract subject from numbered header (### 1) Subject text)
    if (!email.summary) {
      const hdr = block.match(/#{2,3}\s*\d*[\)\.]?\s*(.+)/);
      if (hdr) email.summary = clean(hdr[1]);
    }
    if (email.summary || email.from) emails.push(email);
  }
  return emails.length > 0 ? emails : null;
}

// Parse Work IQ Teams Markdown response into structured messages array
function parseTeamsMessages(text) {
  if (!text) return [];
  const messages = [];
  const clean = s => s.trim().replace(/\*+/g, '').replace(/\[.*?\]\(https?:[^\)]+\)/g, '').trim();

  // Strategy 1: Look for structured blocks with **From:** or **Sender:**
  const blocks = text.split(/\n---\n|\n#{2,3}\s/m);
  for (const block of blocks) {
    const msg = {};
    const fromMatch = block.match(/\*\*(?:From|Sender|Who):\*\*\s*(.+)/i);
    if (fromMatch) msg.from = clean(fromMatch[1]);
    const dateMatch = block.match(/\*\*(?:Date|When|Sent):\*\*\s*(.+)/i);
    if (dateMatch) msg.date = clean(dateMatch[1]);
    const topicMatch = block.match(/\*\*(?:Subject|Topic|Channel|Chat):\*\*\s*(.+)/i);
    if (topicMatch) msg.summary = clean(topicMatch[1]);
    const actionMatch = block.match(/\*\*(?:Action|Request|What):\*\*\s*(.+)/i);
    if (actionMatch) msg.action = clean(actionMatch[1]);
    const linkMatch = block.match(/\[.*?\]\((https:\/\/teams[^\)]+)\)/);
    if (linkMatch) msg.link = linkMatch[1];
    // Need at least a sender or summary to be useful
    if (msg.from || msg.summary) messages.push(msg);
  }

  // Strategy 2: if no structured blocks found, try numbered list items
  if (messages.length === 0) {
    const lines = text.split('\n');
    for (const line of lines) {
      const numbered = line.match(/^\d+[\.\)]\s+(.+)/);
      if (!numbered) continue;
      const content = clean(numbered[1]);
      if (content.length < 10) continue;
      const fromInLine = content.match(/(?:from|by)\s+([^,\-–]+)/i);
      messages.push({
        from: fromInLine ? fromInLine[1].trim() : null,
        summary: content.substring(0, 200),
        date: null,
        link: null
      });
    }
  }

  return messages;
}

// --- Start Server ---

migrateTasks();
migrateStatuses();
migrateToV3();

// Reset stuck transitional statuses from interrupted enrichment/update-check
(function resetStuckStatuses() {
  const data = readTasks();
  let fixed = 0;
  for (const task of data.tasks) {
    if (task.enrichmentStatus === 'enriching') {
      task.enrichmentStatus = 'pending';
      fixed++;
    }
    if (task.updateCheckStatus === 'checking') {
      task.updateCheckStatus = 'pending';
      fixed++;
    }
  }
  if (fixed > 0) {
    writeTasks(data);
    console.log(`Reset ${fixed} stuck enriching/checking status(es) to pending`);
  }
})();

// Startup cleanup: delete done tasks older than default retention (3 days)
cleanupDoneTasks(3);

app.listen(PORT, 'localhost', async () => {
  console.log(`Agent Zero running at http://localhost:${PORT}`);
  // Start persistent Work IQ MCP subprocess (auth once, EULA once, cached for session)
  try {
    await startWorkIQMCP();
    console.log('[WORKIQ] ✅ Ready — persistent MCP subprocess with cached auth');
  } catch (e) {
    console.warn(`[WORKIQ] ⚠️ MCP startup failed: ${e.message} — will retry on first query`);
  }
}).on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ Port ${PORT} is already in use.`);
    console.error(`   Another Agent Zero instance is likely running.`);
    console.error(`   → Close the other instance first, or use START-AGENT-ZERO.bat which handles this automatically.\n`);
  } else {
    console.error(`\n❌ Server failed to start: ${err.message}\n`);
  }
  process.exit(1);
});
