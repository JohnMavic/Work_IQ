import express from 'express';
import fs from 'fs';
import path from 'path';
import http from 'node:http';
import crypto from 'node:crypto';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { CopilotClient, approveAll, defineTool } from '@github/copilot-sdk';
import { spawn, execSync } from 'child_process';
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
            // v3.4.1: signal to any session waiting on wiq-down grace period that
            // WorkIQ is back online. Listeners can then keep waiting on their
            // sendAndWait normally instead of aborting.
            try { wiqEvents.emit('wiq-up'); } catch {}
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
        // v3.4.0 Phase α follow-up: detect EULA/permission stubs at the source so
        // direct callers (Phase-1 scan) get the same stub handling as tool callers.
        // Without this, scan parses stubs as empty data and silently returns 0 items.
        if (text && isStubResponse(text)) {
          consecutiveStubCount++;
          debugLog('WORKIQ-QUERY', `STUB detected (${text.length} chars, consecutive=${consecutiveStubCount}/${STUB_RESTART_THRESHOLD}) "${shortQ}..."`);
          console.warn(`[WORKIQ] STUB response detected (consecutive: ${consecutiveStubCount}/${STUB_RESTART_THRESHOLD})`);
          if (consecutiveStubCount >= STUB_RESTART_THRESHOLD && wiqProc) {
            console.warn(`[WORKIQ] ${consecutiveStubCount} consecutive stubs — force-restarting subprocess`);
            debugLog('WORKIQ', `Force-restart triggered by ${consecutiveStubCount} consecutive stubs (from askWorkIQDirect)`);
            consecutiveStubCount = 0;
            try { wiqProc.kill(); } catch {}
          }
          return reject(new Error('WorkIQ returned EULA/permission stub — service temporarily unavailable'));
        }
        // Healthy response — reset whichever counter applies.
        if (taskId) wiqTaskErrorCounts.set(taskId, 0);
        wiq41ErrorCount = 0;
        consecutiveStubCount = 0;
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
// v3.4.1 (softened): Transient force-restarts (triggered by EULA stubs) no longer
// hard-abort an ongoing LLM session. When 'wiq-down' fires we open a grace period
// during which either: (a) 'wiq-up' fires (WorkIQ came back — keep waiting on
// sendAndWait), or (b) sendAndWait settles on its own (LLM produced its final
// answer without needing WorkIQ again). Only if neither happens within GRACE_MS
// do we reject — so the user still doesn't sit for 300s on a genuinely dead WorkIQ.
const WIQ_GRACE_MS = parseInt(process.env.WIQ_GRACE_MS, 10) || 30000;
function runWithWiqGuard(session, prompt, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let graceTimer = null;
    let storedErr = null;

    const clearGuard = () => {
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      wiqEvents.removeListener('wiq-down', onWiqDown);
      wiqEvents.removeListener('wiq-up', onWiqUp);
    };
    const onWiqUp = () => {
      if (settled) return;
      // WorkIQ is healthy again — cancel the grace timer and keep waiting on
      // sendAndWait as if nothing happened.
      if (graceTimer) { clearTimeout(graceTimer); graceTimer = null; }
      storedErr = null;
    };
    const onWiqDown = (err) => {
      if (settled) return;
      if (graceTimer) return; // already in a grace window
      storedErr = err || new Error('WorkIQ subprocess down');
      graceTimer = setTimeout(() => {
        if (settled) return;
        settled = true;
        clearGuard();
        reject(storedErr);
      }, WIQ_GRACE_MS);
    };
    wiqEvents.on('wiq-down', onWiqDown);
    wiqEvents.on('wiq-up', onWiqUp);

    session.sendAndWait({ prompt }, timeoutMs)
      .then(result => {
        if (settled) return;
        settled = true;
        clearGuard();
        resolve(result);
      })
      .catch(err => {
        if (settled) return;
        settled = true;
        clearGuard();
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
      // v3.4.0 follow-up: stubs now reject inside askWorkIQDirect. Translate the
      // error into the same SERVICE_UNAVAILABLE message the LLM already knows
      // how to handle, so we don't regress tool-side behavior after moving
      // stub detection into the direct layer.
      const isStubError = /eula\/permission stub|eula\s*\/?\s*permission/i.test(e.message);
      if (tracking) {
        tracking.calls.push({ queryIndex, outcome: isStubError ? 'stub' : 'error', durationMs, error: e.message });
        if (isStubError) tracking.stubCount++;
        if (/cooldown|wiq|workiq|exited|crashed|down/i.test(e.message)) tracking.wiqDown = true;
        debugLog('PHASE3-TOOL', `${isStubError ? 'STUB' : 'ERROR'} ${e.message}`, { sessionId, taskId: tracking.taskId, queryIndex, durationMs });
      }
      if (isStubError) {
        return 'SERVICE_UNAVAILABLE: M365 search backend returned a permission/EULA stub instead of results. Do NOT retry. Return your final JSON now: {"hasUpdate": false, "inconclusive": true} — the server will retry this task in the next scan.';
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
        const errMsg = r.reason?.message || 'unknown';
        // v3.4.0 follow-up: stubs now reject from askWorkIQDirect — re-categorize them here.
        if (/eula\/permission stub|eula\s*\/?\s*permission/i.test(errMsg)) {
          errorCount--;
          stubCount++;
          if (tracking) tracking.stubCount++;
          return `=== Query ${i + 1}: "${shortQ}" ===\nSERVICE_UNAVAILABLE (stub response — service permission/EULA issue)`;
        }
        if (tracking && /cooldown|wiq|workiq|exited|crashed|down/i.test(errMsg)) tracking.wiqDown = true;
        return `=== Query ${i + 1}: "${shortQ}" ===\nError: ${errMsg}`;
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

// Phase γ.B.2: wrap an Express handler so the handler body runs inside
// runOnTaskQueue for the task specified by :id. Serialises mutations for
// the same task across skills (log-job, enrich, check-update, review,
// correct, correct/resolve) while keeping different tasks parallel.
function withTaskQueue(handler) {
  return async (req, res, next) => {
    const id = req.params && req.params.id;
    try {
      await runOnTaskQueue(id, () => handler(req, res, next));
    } catch (err) {
      if (!res.headersSent) {
        res.status(500).json({ error: 'Handler failed', detail: err.message });
      }
    }
  };
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

// --- Schema Migration v3 → v4 (Phase γ.A — Job model, additive only) ---
// Adds task.activeJob and task.jobHistory. Does NOT remove pendingPlan (kept
// until Phase γ.F for rollback safety). Creates timestamped backup before
// the very first v3→v4 upgrade on this tasks.json.
function migrateToV4() {
  const data = readTasks();
  if (data.version >= 4) return;
  try {
    const backup = path.join(__dirname, `tasks.json.v3-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`);
    fs.copyFileSync(TASKS_FILE, backup);
    console.log(`[GAMMA.A] Backup written: ${path.basename(backup)}`);
  } catch (err) {
    console.error(`[GAMMA.A] Backup failed: ${err.message} — aborting v4 migration`);
    return;
  }
  for (const task of data.tasks) {
    if (task.activeJob === undefined) task.activeJob = null;
    if (!Array.isArray(task.jobHistory)) task.jobHistory = [];
    // Phase γ.F: legacy pendingPlan is no longer used. Convert any leftover
    // pendingPlan into a jobHistory entry so we don't silently drop user work,
    // then remove the field entirely.
    if (task.pendingPlan) {
      task.jobHistory.push({
        jobId: `legacy-${Math.random().toString(36).slice(2, 10)}`,
        kind: 'log',
        status: 'abandoned',
        startedAt: task.updatedAt || new Date().toISOString(),
        completedAt: new Date().toISOString(),
        legacy: true,
        input: { text: task.pendingPlan.text || '' }
      });
      if (task.jobHistory.length > JOB_HISTORY_CAP) task.jobHistory.shift();
      delete task.pendingPlan;
    }
  }
  data.version = 4;
  writeTasks(data);
  console.log(`[GAMMA.A] Migrated tasks.json to v4 (${data.tasks.length} tasks, additive)`);
}

// Phase γ.F — After server restart, any task whose activeJob was queued,
// running, or awaiting_input is no longer attached to a live runner. We
// record the interruption in jobHistory and clear activeJob so the UI shows
// a clean "retry" state. Runs after migrateToV4() at every startup.
function markInterruptedJobs() {
  const data = readTasks();
  let count = 0;
  for (const t of data.tasks) {
    const aj = t.activeJob;
    if (aj && ['queued', 'running', 'awaiting_input'].includes(aj.status)) {
      if (!Array.isArray(t.jobHistory)) t.jobHistory = [];
      t.jobHistory.push({
        jobId: aj.jobId,
        kind: aj.kind,
        status: 'interrupted',
        startedAt: aj.startedAt,
        completedAt: new Date().toISOString(),
        reason: 'Server restart'
      });
      if (t.jobHistory.length > JOB_HISTORY_CAP) t.jobHistory.shift();
      t.activeJob = null;
      count++;
    }
  }
  if (count > 0) {
    writeTasks(data);
    console.log(`[GAMMA.F] Marked ${count} interrupted job(s) at startup`);
  }
}

// ============================================================================
// Phase γ.A — Job foundation, SSE broker, event bus
// ============================================================================
// Decisions in this block are purely mechanical (state machine, transport,
// deduplication). All SEMANTIC decisions stay in LLM calls (see Phase γ.B).
// ----------------------------------------------------------------------------

const SERVER_INSTANCE_ID = uuidv4();
const JOB_HISTORY_CAP = 20;
const IDEMPOTENCY_TTL_MS = 5 * 60 * 1000;
const GLOBAL_EVENT_BUFFER_CAP = 2000;
const JOB_PER_EVENT_CAP = 200;

const jobs = new Map();              // jobId → Job
const jobsByTask = new Map();        // taskId → Set<jobId>
const activeJobByTask = new Map();   // taskId → jobId (only open jobs)
const idempotencyMap = new Map();    // key → { jobId, bodyHash, expiresAt }
let globalEventSeq = 0;
const globalEventBuffer = [];        // ring, max GLOBAL_EVENT_BUFFER_CAP

console.log(`[GAMMA.A] Server instance id: ${SERVER_INSTANCE_ID}`);

function hashBody(body) {
  return crypto.createHash('sha256').update(JSON.stringify(body || {})).digest('hex');
}

function cleanIdempotency() {
  const now = Date.now();
  for (const [k, v] of idempotencyMap.entries()) {
    if (v.expiresAt < now) idempotencyMap.delete(k);
  }
}

function checkIdempotency(key, bodyHash) {
  if (!key) return { status: 'no-key' };
  cleanIdempotency();
  const entry = idempotencyMap.get(key);
  if (!entry) return { status: 'new' };
  if (entry.bodyHash !== bodyHash) return { status: 'conflict' };
  return { status: 'hit', jobId: entry.jobId };
}

function storeIdempotency(key, jobId, bodyHash) {
  if (!key) return;
  idempotencyMap.set(key, { jobId, bodyHash, expiresAt: Date.now() + IDEMPOTENCY_TTL_MS });
}

// Persist only the JSON-safe slice of a job to task.activeJob.
// v4.0.0-rc.1 — when job.taskId is null (global jobs like 'scan'), delegates
// to persistGlobalJobSnapshot which writes to jobs.json instead.
async function persistJobSnapshot(job) {
  if (!job.taskId) {
    return persistGlobalJobSnapshot(job);
  }
  await safeWriteTasks((data) => {
    const t = data.tasks.find(x => x.id === job.taskId);
    if (!t) return null;
    t.activeJob = {
      jobId: job.id,
      kind: job.kind,
      status: job.status,
      startedAt: job.startedAt,
      lastJobEventId: job.lastJobEventId,
      pendingClarification: job.pendingClarification
    };
    return t;
  });
}

// --- SSE Broker ------------------------------------------------------------
const sseBroker = {
  subscribers: new Set(),  // { res, heartbeat }
  subscribe(req, res) {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const rawLast = req.headers['last-event-id'] || req.query.lastEventId || '0';
    const lastEventId = parseInt(rawLast, 10) || 0;

    // If the client's cursor is older than the oldest buffered event, we
    // cannot replay — client must do a full refetch.
    const oldestBuffered = globalEventBuffer.length > 0 ? globalEventBuffer[0].id : globalEventSeq;
    const tooOld = lastEventId > 0 && lastEventId < oldestBuffered - 1;

    const helloPayload = {
      serverInstanceId: SERVER_INSTANCE_ID,
      lastGlobalEventId: globalEventSeq,
      lastEventsDropped: tooOld
    };
    try {
      res.write(`event: hello\nid: ${globalEventSeq}\ndata: ${JSON.stringify(helloPayload)}\n\n`);
    } catch {}

    if (!tooOld && lastEventId > 0) {
      for (const ev of globalEventBuffer) {
        if (ev.id > lastEventId) this._write(res, ev);
      }
    }

    const heartbeat = setInterval(() => {
      try { res.write(': keepalive\n\n'); } catch {}
    }, 20000);

    const entry = { res, heartbeat };
    this.subscribers.add(entry);

    const cleanup = () => {
      clearInterval(heartbeat);
      this.subscribers.delete(entry);
    };
    req.on('close', cleanup);
    req.on('error', cleanup);
  },
  broadcast(event) {
    for (const entry of this.subscribers) {
      try { this._write(entry.res, event); } catch {}
    }
  },
  _write(res, event) {
    res.write(`event: ${event.type}\nid: ${event.id}\ndata: ${JSON.stringify(event)}\n\n`);
  }
};

// --- Job class -------------------------------------------------------------
class Job {
  constructor({ taskId, kind, input, clientRequestId }) {
    this.id = uuidv4();
    this.taskId = taskId;
    this.kind = kind;                 // 'log' for γ.B, others future
    this.status = 'queued';           // queued|running|awaiting_input|cancelling|cancelled|completed|failed
    this.input = input;
    this.clientRequestId = clientRequestId || null;
    this.abortController = new AbortController();
    this.startedAt = null;
    this.completedAt = null;
    this.result = null;
    this.error = null;
    this.pendingClarification = null;
    this.replyResolver = null;
    this.events = [];                 // per-job ring
    this.lastJobEventId = 0;
    this.sdkSessionId = null;
    this._session = null;             // transient, not serialised
    // v4.0.0-rc.1 — progress fields for global (multi-phase) jobs like 'scan'.
    // Shape: { phase, phaseStartedAt, currentItemIndex, totalItems, currentTaskId }
    this.progress = null;
  }

  emit(type, payload = {}) {
    this.lastJobEventId++;
    globalEventSeq++;
    const event = {
      v: 1,
      id: globalEventSeq,
      jobEventId: this.lastJobEventId,
      ts: Date.now(),
      serverInstanceId: SERVER_INSTANCE_ID,
      taskId: this.taskId,
      jobId: this.id,
      kind: this.kind,
      type,
      payload
    };
    this.events.push(event);
    if (this.events.length > JOB_PER_EVENT_CAP) this.events.shift();
    globalEventBuffer.push(event);
    if (globalEventBuffer.length > GLOBAL_EVENT_BUFFER_CAP) globalEventBuffer.shift();
    sseBroker.broadcast(event);
  }

  async awaitReply(question) {
    this.status = 'awaiting_input';
    this.pendingClarification = { question, askedAt: Date.now() };
    this.emit('job.awaiting_input', { question });
    await persistJobSnapshot(this);
    return new Promise((resolve, reject) => {
      this.replyResolver = { resolve, reject };
    });
  }

  acceptReply(text) {
    if (!this.replyResolver) throw new Error('Job not awaiting input');
    this.pendingClarification = null;
    this.status = 'running';
    this.emit('job.progress', { phase: 'reply_received', chars: String(text).length });
    const r = this.replyResolver;
    this.replyResolver = null;
    r.resolve(text);
  }

  cancel() {
    if (['completed', 'failed', 'cancelled'].includes(this.status)) return false;
    this.status = 'cancelling';
    try { this.abortController.abort(); } catch {}
    if (this.replyResolver) {
      const r = this.replyResolver;
      this.replyResolver = null;
      try { r.reject(new Error('Job cancelled')); } catch {}
    }
    // If an SDK session is bound, destroy it so sendAndWait unblocks.
    if (this._session) {
      try { destroySession(this._session); } catch {}
    }
    return true;
  }

  snapshot() {
    return {
      jobId: this.id,
      taskId: this.taskId,
      kind: this.kind,
      status: this.status,
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      pendingClarification: this.pendingClarification,
      result: this.result,
      error: this.error,
      lastJobEventId: this.lastJobEventId,
      serverInstanceId: SERVER_INSTANCE_ID,
      clientRequestId: this.clientRequestId,
      sdkSessionId: this.sdkSessionId,
      progress: this.progress
    };
  }
}

// Register a job in the in-memory maps. Call AFTER persistJobSnapshot succeeded.
// v4.0.0-rc.1 — supports null taskId for global jobs ('scan', 'consolidate'),
// which are tracked in globalActiveJobByKind (singleton semantics).
function registerJob(job) {
  jobs.set(job.id, job);
  if (job.taskId) {
    let set = jobsByTask.get(job.taskId);
    if (!set) { set = new Set(); jobsByTask.set(job.taskId, set); }
    set.add(job.id);
    activeJobByTask.set(job.taskId, job.id);
  } else {
    globalActiveJobByKind.set(job.kind, job.id);
  }
}

function unregisterActiveJob(job) {
  if (job.taskId) {
    if (activeJobByTask.get(job.taskId) === job.id) {
      activeJobByTask.delete(job.taskId);
    }
  } else {
    if (globalActiveJobByKind.get(job.kind) === job.id) {
      globalActiveJobByKind.delete(job.kind);
    }
  }
}

// Expose to future phases (Phase γ.B runner will be wired here).
// eslint-disable-next-line no-unused-vars
const __gammaA = { Job, jobs, jobsByTask, activeJobByTask, idempotencyMap, sseBroker, registerJob, unregisterActiveJob, persistJobSnapshot, hashBody, checkIdempotency, storeIdempotency };

// ============================================================================
// Phase γ.A.2 — Global (non-task-bound) job registry (v4.0.0-rc.1)
// ============================================================================
// Jobs whose lifecycle spans multiple tasks (like a 4-phase 'scan') live here.
// They persist to jobs.json so a browser refresh can hydrate from server state,
// and a server restart can tombstone them as 'failed:server-restart' without
// losing the history.
// ----------------------------------------------------------------------------

const JOBS_FILE = path.join(__dirname, 'jobs.json');
const GLOBAL_JOBS_HISTORY_CAP = 100;
const globalActiveJobByKind = new Map();   // 'scan' | 'consolidate' → jobId

function readJobsFile() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return { jobs: [] };
    const raw = fs.readFileSync(JOBS_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.jobs)) return { jobs: [] };
    return parsed;
  } catch (err) {
    console.error(`[GAMMA.A2] readJobsFile failed: ${err.message}`);
    return { jobs: [] };
  }
}

function writeJobsFile(data) {
  try {
    fs.writeFileSync(JOBS_FILE, JSON.stringify(data, null, 2));
  } catch (err) {
    console.error(`[GAMMA.A2] writeJobsFile failed: ${err.message}`);
  }
}

async function persistGlobalJobSnapshot(job) {
  const data = readJobsFile();
  const snap = {
    ...job.snapshot(),
    lastUpdate: Date.now()
  };
  const idx = data.jobs.findIndex(j => j.jobId === job.id);
  if (idx >= 0) data.jobs[idx] = snap;
  else data.jobs.push(snap);
  // Trim history (keep most recent)
  if (data.jobs.length > GLOBAL_JOBS_HISTORY_CAP) {
    data.jobs = data.jobs.slice(-GLOBAL_JOBS_HISTORY_CAP);
  }
  writeJobsFile(data);
}

// Check if a global singleton kind is currently active. Returns
// { acquired: true } if free, or { acquired: false, existingJobId } if busy.
function tryAcquireSingleton(kind) {
  const existingId = globalActiveJobByKind.get(kind);
  if (existingId) {
    const job = jobs.get(existingId);
    if (job && !['completed', 'failed', 'cancelled'].includes(job.status)) {
      return { acquired: false, existingJobId: existingId };
    }
    // Stale entry — clean up and allow acquisition.
    globalActiveJobByKind.delete(kind);
  }
  return { acquired: true };
}

// On server boot, mark any globally-persisted jobs that were running as failed.
// Called immediately after this block is defined (see startup section).
function markInterruptedGlobalJobs() {
  const data = readJobsFile();
  let count = 0;
  for (const j of data.jobs) {
    if (['queued', 'running', 'cancelling', 'awaiting_input'].includes(j.status)) {
      j.status = 'failed';
      j.error = (j.error ? j.error + ' | ' : '') + 'server-restart';
      j.completedAt = new Date().toISOString();
      count++;
    }
  }
  if (count > 0) {
    writeJobsFile(data);
    console.log(`[GAMMA.A2] Tombstoned ${count} interrupted global job(s) at startup`);
  }
}

// Lock used by GET /api/jobs?active=true to return {jobs, snapshotEventId}
// atomically, preventing the SSE boot-race: the snapshotEventId is captured
// while the jobs list is also captured, so the client can use it as the
// lastEventId when subscribing to /api/events without losing or duplicating.
function snapshotActiveJobs() {
  const list = [];
  for (const j of jobs.values()) {
    if (['completed', 'failed', 'cancelled'].includes(j.status)) continue;
    list.push(j.snapshot());
  }
  return { jobs: list, snapshotEventId: globalEventSeq };
}

// --- API Endpoints ---

// Health check endpoint — used by startup scripts to verify server is alive and healthy
app.get('/api/health', (req, res) => {
  let version = 'unknown';
  try { version = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8')).version; } catch {}
  res.json({
    service: 'agent-zero',
    status: 'ok',
    uptime: Math.round(process.uptime()),
    activeSessions: activeSessions.size,
    memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    pid: process.pid,
    port: PORT,
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

// Cached at boot. Walks up from __dirname to find .git (Agent_Zero is a
// sub-folder of the Work_IQ repo root, so the local dir has no .git of its
// own). Tries `git rev-parse` first (fast when git is on PATH); falls back
// to reading .git/HEAD directly when the server is launched from a cmd that
// doesn't inherit git in PATH. Server is ESM so no require().
const BUILD_COMMIT = (() => {
  try {
    return execSync('git rev-parse --short HEAD', { cwd: __dirname, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {}
  try {
    let dir = __dirname;
    for (let i = 0; i < 6; i++) {
      const gitPath = path.join(dir, '.git');
      if (fs.existsSync(gitPath)) {
        const head = fs.readFileSync(path.join(gitPath, 'HEAD'), 'utf-8').trim();
        if (head.startsWith('ref: ')) {
          const refFile = path.join(gitPath, head.slice(5));
          if (fs.existsSync(refFile)) return fs.readFileSync(refFile, 'utf-8').trim().slice(0, 7);
          const packed = path.join(gitPath, 'packed-refs');
          if (fs.existsSync(packed)) {
            const ref = head.slice(5);
            const line = fs.readFileSync(packed, 'utf-8').split(/\r?\n/).find(l => l.endsWith(' ' + ref));
            if (line) return line.slice(0, 7);
          }
          return 'noref';
        }
        return head.slice(0, 7);
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {}
  return 'nogit';
})();
console.log(`[Agent Zero] Build commit: ${BUILD_COMMIT}`);

// GET /api/version — return app version from package.json + short git SHA
// so the UI can prove which build is actually running (useful after a patch).
app.get('/api/version', (req, res) => {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
    res.json({ version: pkg.version, name: pkg.name, commit: BUILD_COMMIT });
  } catch {
    res.json({ version: 'unknown', commit: BUILD_COMMIT });
  }
});

// ----------------------------------------------------------------------------
// Phase γ.A endpoints — SSE stream + job inspection/control
// ----------------------------------------------------------------------------

// GET /api/events — Server-Sent Events stream of all job events.
// Supports ?lastEventId=N or Last-Event-ID header for reconnect replay.
app.get('/api/events', (req, res) => {
  sseBroker.subscribe(req, res);
});

// GET /api/jobs/:jobId — full snapshot (used for refresh hydration)
app.get('/api/jobs/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  res.json({ ...job.snapshot(), events: job.events.slice(-JOB_PER_EVENT_CAP) });
});

// POST /api/jobs/:jobId/cancel — request cancellation.
// Returns ok:true + cancelled:true when the job transitioned to 'cancelling',
// cancelled:false when the job was already finished (idempotent no-op).
app.post('/api/jobs/:jobId/cancel', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  const cancelled = job.cancel();
  res.json({ ok: true, cancelled, status: job.status });
});

// POST /api/jobs/:jobId/reply — answer to a clarification question.
app.post('/api/jobs/:jobId/reply', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job not found' });
  if (['completed', 'failed', 'cancelled'].includes(job.status)) {
    return res.status(410).json({ error: `job is ${job.status}` });
  }
  if (job.status !== 'awaiting_input') {
    return res.status(409).json({ error: 'job not awaiting input', status: job.status });
  }
  const text = (req.body && typeof req.body.text === 'string') ? req.body.text : '';
  if (!text.trim()) return res.status(400).json({ error: 'empty reply text' });
  try {
    job.acceptReply(text);
  } catch (err) {
    return res.status(409).json({ error: err.message });
  }
  res.json({ ok: true });
});

// ============================================================================
// Phase γ.B — Log-Job runner (1-call autonomous LLM)
// ============================================================================
// PRINCIPLE: every semantic decision (intent, search strategy, title/summary
// changes, clarification-vs-act) is made by a Copilot CLI LLM instance. No
// regex pre-filters, no keyword heuristics, no deterministic shortcuts. The
// system prompt is the SEARCH_SKILL.md file (same pattern as phases 1-4).
// Only mechanical work (serialisation, JSON schema enforcement, history write,
// SSE emit) is deterministic.
// ----------------------------------------------------------------------------

const GAMMA_LOG_TIMEOUT_MS = 300000;
const GAMMA_LOG_MAX_ROUNDS = 3; // 1 initial + up to 2 clarification rounds

function formatRecentHistoryForPrompt(task) {
  return (task.history || [])
    .filter(h => h.type === 'update' || h.type === 'note')
    .slice(-8)
    .map(h => {
      let entry = `[${h.timestamp}] USER: ${h.text}`;
      if (h.agentPlan) {
        const intent = h.agentPlan.intent || 'search';
        entry += `\nAGENT (${intent}): ${h.agentPlan.understanding || ''}`;
      }
      if (Array.isArray(h.communications) && h.communications.length > 0) {
        for (const c of h.communications) {
          entry += `\n  📧 ${c.from || '?'} → ${c.to || '?'}: ${c.summary || '(no summary)'}`;
        }
      }
      return entry;
    })
    .join('\n---\n');
}

function formatConversationForPrompt(convo) {
  return convo.map(turn => {
    if (turn.role === 'user') return `USER: ${turn.text}`;
    if (turn.role === 'agent-clarification') return `AGENT (asked for clarification): ${turn.text}`;
    return `${turn.role.toUpperCase()}: ${turn.text}`;
  }).join('\n\n');
}

// Compose the system prompt (SEARCH_SKILL.md) + dynamic task/assignment context.
// Same pattern as the Scan/Enrich/Check-Update/Review phases: skill file is
// the durable system prompt, assignment below is the dynamic task context.
function buildLogJobPrompt(task, convo) {
  const taskDate = task.date || task.createdAt || '';
  const recentHistory = formatRecentHistoryForPrompt(task);
  const conversation = formatConversationForPrompt(convo);
  const skill = SEARCH_SKILL || '';

  return `${skill}

## Your Assignment (Agent Zero — Log Work, unified 1-call)

You act on behalf of the user on an action item tracked in Agent Zero. The user sent you one or more messages about this item. Decide yourself, based on meaning and context, what the user actually wants — do NOT rely on keywords or phrase-matching. Then act autonomously in a single turn.

### TASK CONTEXT
- Title: "${task.title}"
- From: ${task.from || 'unknown'}
- Source: ${task.source || 'unknown'}
- Date: ${taskDate}
- Current summary: ${task.summary ? `"${task.summary.substring(0, 1500)}"` : '(none)'}
${recentHistory ? `\n### RECENT HISTORY (last 8 updates)\n${recentHistory}\n` : ''}
### CONVERSATION WITH USER
${conversation}

### DECISION RULES

You MUST make every decision yourself by reasoning about the user's message. Never act on keyword shortcuts.

Possible intents:
- search     : the user wants you to find communications / the current status / an answer by looking in email and Teams
- update     : the user tells you they did something, or reports a new fact about the item — update title/summary to reflect it, DO NOT search unless they explicitly also ask you to verify
- rename     : the user explicitly asks for a title change
- summarize  : the user explicitly asks for a summary change or migration
- correct    : the user says something is wrong, outdated, or hallucinated — fix title/summary accordingly
- answer     : the user asks a conceptual question that needs no search, no write (pure Q&A)
- clarify    : the user's message is genuinely ambiguous — ask ONE short question and wait

Rules:
- Never ask for permission to act. If you can decide, decide and act.
- For **search** intent: use the SEARCH_SKILL strategy above (parallel_search with 2-3 angles, self-assess, optional 3rd attempt). Integrate findings into title/summary when relevant.
- For **update / correct / rename / summarize** intents: normally do NOT call tools. Act directly on the user's information.
- For **answer** intent: provide a direct answer in \`answer\`; leave communications empty; do not touch title/summary.
- For **clarify** intent: set \`clarification\` to exactly ONE short question (user's language). Do not call tools. Do not set titleChanged/summaryChanged.
- Title: concise (max ~15 words), no emoji, reflects CURRENT state.
- Summary: structured 3-section format:
  [1-2 sentence context]
  ---
  🔴 **Nächste Schritte:** / **Next steps:**
  - …
  ---
  ✅ **Bisheriger Verlauf:** / **History:**
  - DD.MM. — milestone (newest first)
  Keep the language of the existing content. Migrate older 📌-Update-style summaries into this structure when touching them.
- Only set \`titleChanged\` or \`summaryChanged\` to true when there is a GENUINE reason in this turn.

### OUTPUT
Output EXACTLY this JSON object and nothing else (no prose, no markdown fences):
{
  "intent": "search" | "update" | "rename" | "summarize" | "correct" | "answer" | "clarify",
  "clarification": "single short question in the user's language" | null,
  "communications": [ { "type": "email"|"teams", "from": "", "to": "", "date": "ISO-8601", "summary": "", "link": "" }, ... ],
  "answer": "user-facing answer text, may be empty string for pure updates" | null,
  "confidence": "high" | "medium" | "low" | "none",
  "searchAttempts": [ { "angle": "", "query": "", "foundCount": 0 }, ... ],
  "ambiguities": [ "..." ],
  "titleChanged": true | false,
  "newTitle": "..." | null,
  "summaryChanged": true | false,
  "newSummary": "..." | null,
  "reasoning": "one concise sentence explaining what you decided and why"
}`;
}

// Wrap an existing tool so the owning Job sees live tool-call progress events.
// IMPORTANT: we intentionally do NOT rebuild the tool via defineTool here.
// The SDK tool object's exact internal shape (private fields, permission
// hooks, session-context plumbing) is not part of a public contract, so
// rebuilding risks losing features (skipPermission, session-id plumbing,
// etc.). Instead we return the tool unchanged and emit a single
// "tool_round" job.progress event BEFORE the LLM round; per-tool-call
// granularity can be added later once the SDK shape is verified.
// Keeping the same name + signature so the runner call-site is stable.
function withJobContext(/* job, tool */_job, tool) {
  return tool;
}

function buildAgentResponseString(parsed, communications) {
  if (parsed.intent === 'clarify' && parsed.clarification) {
    return `❓ ${parsed.clarification}`;
  }
  if (parsed.intent === 'answer' && parsed.answer) {
    return parsed.answer;
  }
  const confIcon = { high: '✅', medium: '⚠️', low: '🔍', none: '❌' }[parsed.confidence] || '';
  const head = parsed.answer ? `${confIcon} ${parsed.answer}`.trim() : (parsed.reasoning || '');
  let out = head;
  if (Array.isArray(parsed.ambiguities) && parsed.ambiguities.length > 0) {
    out += '\n\n⚠️ ' + parsed.ambiguities.join('\n⚠️ ');
  }
  if (communications.length > 0) {
    const summaries = communications.map((c, i) => {
      const icon = c.type === 'teams' ? '💬' : '📧';
      const date = c.date ? (() => { try { return new Date(c.date).toLocaleDateString('de-CH'); } catch { return c.date; } })() : '';
      return `${i + 1}. ${icon} **${c.from || 'Unknown'}** → ${c.to || ''} (${date})${c.summary ? ': ' + c.summary : ''}`;
    }).join('\n');
    out += `\n\n📋 ${communications.length} communication(s):\n${summaries}`;
  }
  return out || '(no response)';
}

// v3.4.1 — Persist failure state so UI/hydration doesn't stay stuck.
// Called from every fail branch in runLogJob. Writes a history entry describing
// the failure, clears task.activeJob, and appends to jobHistory.
async function persistJobFailure(job, reason, extras = {}) {
  try {
    const finalTask = await safeWriteTasks((d) => {
      const t = d.tasks.find(x => x.id === job.taskId);
      if (!t) return null;
      const now = new Date().toISOString();
      if (!t.history) t.history = [];
      t.history.push({
        timestamp: now,
        type: 'update',
        text: job.input && job.input.text ? job.input.text : '(agent request)',
        communications: [],
        agentResponse: `⚠️ Agent failed: ${reason}`,
        agentPlan: { intent: 'answer', understanding: reason, confidence: 'none', userConfirmed: false, jobId: job.id },
        agentExecution: {
          parsedCount: 0,
          confidence: 'none',
          answer: null,
          searchAttempts: [],
          ambiguities: [],
          durationMs: job.startedAt ? Date.now() - job.startedAt : 0,
          method: 'gamma-single-call-v1',
          rounds: extras.rounds || 0,
          error: reason,
          rawPreview: typeof extras.rawPreview === 'string' ? extras.rawPreview.substring(0, 400) : null
        }
      });
      t.activeJob = null;
      t.jobHistory = t.jobHistory || [];
      t.jobHistory.push({
        jobId: job.id,
        kind: job.kind,
        status: 'failed',
        startedAt: job.startedAt ? new Date(job.startedAt).toISOString() : null,
        completedAt: now,
        clientRequestId: job.clientRequestId,
        sdkSessionId: job.sdkSessionId,
        error: reason
      });
      if (t.jobHistory.length > JOB_HISTORY_CAP) t.jobHistory.shift();
      t.updatedAt = now;
      return t;
    });
    return finalTask;
  } catch (persistErr) {
    console.error(`[GAMMA.B] persistJobFailure error job=${job.id.substring(0,8)}: ${persistErr.message}`);
    return null;
  }
}

async function runLogJob(job) {
  return runOnTaskQueue(job.taskId, async () => {
    // Re-read task state at queue front (might have changed while queued)
    const data = readTasks();
    const task = data.tasks.find(t => t.id === job.taskId);
    if (!task) {
      job.status = 'failed';
      job.error = 'Task deleted while queued';
      job.emit('job.failed', { error: job.error });
      activeJobByTask.delete(job.taskId);
      return;
    }

    if (job.status === 'cancelling') {
      await safeWriteTasks((d) => { const t = d.tasks.find(x=>x.id===job.taskId); if(t) t.activeJob = null; return t; });
      job.status = 'cancelled';
      job.completedAt = Date.now();
      job.emit('job.cancelled', {});
      activeJobByTask.delete(job.taskId);
      return;
    }

    job.status = 'running';
    job.startedAt = Date.now();
    job.emit('job.started', { title: task.title });
    await persistJobSnapshot(job);

    const convo = [{ role: 'user', text: job.input.text }];
    let parsed = null;
    let rounds = 0;
    let rawContent = null;

    try {
      while (rounds < GAMMA_LOG_MAX_ROUNDS) {
        if (job.status === 'cancelling') break;
        rounds++;

        await waitForSDKSlot();
        if (job.status === 'cancelling') break;

        const prompt = buildLogJobPrompt(task, convo);
        console.log(`[GAMMA.B] log-job ${job.id.substring(0, 8)} round ${rounds} prompt=${prompt.length} chars`);

        // One fresh session per round so we never depend on an unverified
        // multi-turn API on the SDK session. The conversation is passed in
        // the prompt itself.
        const client = new CopilotClient();
        const session = trackSession(await client.createSession({
          tools: [
            withJobContext(job, askWorkIQTool),
            withJobContext(job, parallelSearchTool)
          ],
          onPermissionRequest: approveAll
        }));
        linkClientToSession(session, client);
        job._session = session;
        if (session && session.id && !job.sdkSessionId) job.sdkSessionId = session.id;

        job.emit('job.progress', { phase: 'llm_round', round: rounds });

        let response;
        try {
          response = await runWithWiqGuard(session, prompt, GAMMA_LOG_TIMEOUT_MS);
        } catch (err) {
          await destroySession(session);
          try { await client.dispose(); } catch {}
          job._session = null;
          if (job.status === 'cancelling') break;
          job.status = 'failed';
          job.error = `LLM call failed: ${err.message}`;
          await persistJobFailure(job, job.error, { rounds });
          job.emit('job.failed', { error: job.error });
          activeJobByTask.delete(job.taskId);
          return;
        }

        await destroySession(session);
        try { await client.dispose(); } catch {}
        job._session = null;

        if (job.status === 'cancelling') break;

        rawContent = response && response.data ? response.data.content : null;
        parsed = parseJsonFromResponse(rawContent);

        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          job.status = 'failed';
          job.error = 'LLM response was not valid JSON object';
          await persistJobFailure(job, job.error, { rounds, rawPreview: typeof rawContent === 'string' ? rawContent : null });
          job.emit('job.failed', { error: job.error, rawPreview: typeof rawContent === 'string' ? rawContent.substring(0, 400) : null });
          activeJobByTask.delete(job.taskId);
          return;
        }

        // Clarification loop: only if the LLM itself decided to ask.
        if (parsed.intent === 'clarify' && typeof parsed.clarification === 'string' && parsed.clarification.trim() && rounds < GAMMA_LOG_MAX_ROUNDS) {
          try {
            const reply = await job.awaitReply(parsed.clarification.trim());
            convo.push({ role: 'agent-clarification', text: parsed.clarification.trim() });
            convo.push({ role: 'user', text: reply });
            continue; // next round with accumulated conversation
          } catch (err) {
            if (job.status === 'cancelling') break;
            job.status = 'failed';
            job.error = `Clarification interrupted: ${err.message}`;
            await persistJobFailure(job, job.error, { rounds });
            job.emit('job.failed', { error: job.error });
            activeJobByTask.delete(job.taskId);
            return;
          }
        }
        break; // final answer produced
      }
    } finally {
      if (job._session) {
        try { await destroySession(job._session); } catch {}
        job._session = null;
      }
    }

    if (job.status === 'cancelling') {
      await safeWriteTasks((d) => { const t = d.tasks.find(x=>x.id===job.taskId); if(t) t.activeJob = null; return t; });
      job.status = 'cancelled';
      job.completedAt = Date.now();
      job.emit('job.cancelled', {});
      activeJobByTask.delete(job.taskId);
      return;
    }

    if (!parsed) {
      job.status = 'failed';
      job.error = 'No parseable response received';
      await persistJobFailure(job, job.error, { rounds });
      job.emit('job.failed', { error: job.error });
      activeJobByTask.delete(job.taskId);
      return;
    }

    // ------------------------------------------------------------------
    // Apply the LLM's decisions to tasks.json — purely mechanical write.
    // ------------------------------------------------------------------
    const communications = Array.isArray(parsed.communications) ? parsed.communications : [];
    const intent = typeof parsed.intent === 'string' ? parsed.intent : 'answer';
    const agentResponse = buildAgentResponseString(parsed, communications);

    const finalTask = await safeWriteTasks((d) => {
      const t = d.tasks.find(x => x.id === job.taskId);
      if (!t) return null;
      const now = new Date().toISOString();
      if (!t.history) t.history = [];

      t.history.push({
        timestamp: now,
        type: 'update',
        text: job.input.text,
        communications,
        agentResponse,
        agentPlan: {
          intent,
          understanding: parsed.reasoning || '',
          confidence: parsed.confidence || null,
          userConfirmed: true,
          jobId: job.id
        },
        agentExecution: {
          parsedCount: communications.length,
          confidence: parsed.confidence || null,
          answer: parsed.answer || null,
          searchAttempts: Array.isArray(parsed.searchAttempts) ? parsed.searchAttempts : [],
          ambiguities: Array.isArray(parsed.ambiguities) ? parsed.ambiguities : [],
          durationMs: Date.now() - job.startedAt,
          method: 'gamma-single-call-v1',
          rounds
        }
      });

      if (parsed.titleChanged && parsed.newTitle && String(parsed.newTitle).trim() !== t.title) {
        const prev = t.title;
        t.title = String(parsed.newTitle).trim();
        t.history.push({
          timestamp: now,
          type: 'title-change',
          text: `📝 Title updated: "${prev}" → "${t.title}"\nReason: ${parsed.reasoning || ''}`
        });
      }
      if (parsed.summaryChanged && parsed.newSummary) {
        const prevLen = (t.summary || '').length;
        t.summary = String(parsed.newSummary).trim();
        t.history.push({
          timestamp: now,
          type: 'summary-update',
          text: `📋 Summary updated (prev ${prevLen} chars)\nReason: ${parsed.reasoning || ''}`
        });
      }

      t.activeJob = null;
      t.jobHistory = t.jobHistory || [];
      t.jobHistory.push({
        jobId: job.id,
        kind: job.kind,
        status: 'completed',
        startedAt: new Date(job.startedAt).toISOString(),
        completedAt: now,
        clientRequestId: job.clientRequestId,
        sdkSessionId: job.sdkSessionId,
        intent,
        rounds
      });
      if (t.jobHistory.length > JOB_HISTORY_CAP) t.jobHistory.shift();

      t.updatedAt = now;
      return t;
    });

    if (!finalTask) {
      job.status = 'failed';
      job.error = 'Task was deleted before final write';
      job.emit('job.failed', { error: job.error });
      activeJobByTask.delete(job.taskId);
      return;
    }

    job.result = {
      task: finalTask,
      evaluation: {
        titleChanged: !!parsed.titleChanged,
        summaryChanged: !!parsed.summaryChanged,
        reasoning: parsed.reasoning || ''
      }
    };
    job.status = 'completed';
    job.completedAt = Date.now();
    job.emit('job.completed', { task: finalTask, evaluation: job.result.evaluation });
    activeJobByTask.delete(job.taskId);
  });
}

// POST /api/tasks/:id/log-job — TEMPORARY endpoint for Phase γ.B.
// Old /log/analyze and /log remain active until Phase γ.F cut-over.
// Accepts Idempotency-Key header (optional but recommended).
app.post('/api/tasks/:id/log', async (req, res) => {
  const { id } = req.params;
  const { text } = req.body || {};
  const idempKey = req.headers['idempotency-key'] || null;

  if (!text || !String(text).trim()) {
    return res.status(400).json({ error: 'Log text is required' });
  }

  // Confirm task exists (fast read, no lock)
  try {
    const data = readTasks();
    const t = data.tasks.find(x => x.id === id);
    if (!t) return res.status(404).json({ error: 'Task not found' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read tasks', detail: err.message });
  }

  // Idempotency replay protection
  const bodyHash = hashBody({ text: String(text).trim() });
  const idem = checkIdempotency(idempKey, bodyHash);
  if (idem.status === 'conflict') {
    return res.status(409).json({ error: 'Idempotency-Key reused with different body' });
  }
  if (idem.status === 'hit') {
    const existing = jobs.get(idem.jobId);
    return res.status(202).json({ jobId: idem.jobId, status: existing ? existing.status : 'unknown', idempotent: true });
  }

  // One active log-job per task at a time
  const activeId = activeJobByTask.get(id);
  if (activeId) {
    return res.status(409).json({ error: 'Task already has an active job', existingJobId: activeId });
  }

  const job = new Job({
    taskId: id,
    kind: 'log',
    input: { text: String(text).trim() },
    clientRequestId: idempKey
  });
  registerJob(job);
  storeIdempotency(idempKey, job.id, bodyHash);

  await persistJobSnapshot(job);

  // Kick off runner asynchronously — respond 202 immediately.
  setImmediate(() => {
    runLogJob(job).catch(err => {
      console.error(`[GAMMA.B] runLogJob unhandled error: ${err.stack || err.message}`);
      if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
        job.status = 'failed';
        job.error = `Unhandled: ${err.message}`;
        try { job.emit('job.failed', { error: job.error }); } catch {}
        activeJobByTask.delete(job.taskId);
      }
    });
  });

  res.status(202).json({ jobId: job.id, status: 'queued' });
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

      const allowedFields = ['status', 'notes', 'title', 'summary', 'enrichmentStatus', 'updateCheckStatus'];
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
    const forceCancel = String(req.query.cancelActive || '').toLowerCase() === 'true';

    // Phase γ.F: refuse to delete tasks with an active job unless ?cancelActive=true.
    const activeJobId = activeJobByTask.get(id);
    if (activeJobId) {
      const job = jobs.get(activeJobId);
      if (job && !['completed', 'failed', 'cancelled'].includes(job.status)) {
        if (!forceCancel) {
          return res.status(409).json({
            error: 'Task has an active job',
            existingJobId: activeJobId,
            hint: 'Retry with ?cancelActive=true to cancel first'
          });
        }
        try { job.cancel(); } catch {}
        // Give the runner a moment to observe cancellation before we remove the task.
        await new Promise((r) => setTimeout(r, 1000));
      }
    }

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

    // v3.4.0 follow-up: retry once if askWorkIQDirect rejected because WorkIQ returned stubs.
    // The stub-handler in askWorkIQDirect force-restarts the subprocess on the 3rd stub, so a
    // single retry after a short wait lets Phase-1 self-heal instead of silently returning 0 items.
    const isStubErr = (r) => r.status === 'rejected' && /eula\/permission stub/i.test(r.reason?.message || '');
    async function fetchScanPair() {
      return Promise.allSettled([
        askWorkIQDirect(emailQuery, 90000),
        askWorkIQDirect(teamsQuery, 90000),
      ]);
    }
    let [emailResult, teamsResult] = await fetchScanPair();
    if (isStubErr(emailResult) || isStubErr(teamsResult)) {
      console.warn('[SCAN] Phase 1 got EULA/permission stubs — force-restarting WorkIQ and retrying once');
      debugLog('PHASE1', 'STUB-RETRY: force-restarting WorkIQ subprocess');
      // Proactively kill the subprocess: the global consecutiveStubCount threshold (3) does not
      // trigger on 2 parallel stubs (email+teams), so without this kill the retry would hit the
      // same stubbing WorkIQ instance and fail again. See logs 2026-04-22T06:44 for repro.
      if (wiqProc) { try { wiqProc.kill(); } catch {} }
      await new Promise(r => setTimeout(r, 8000));
      // Wait until subprocess is marked ready (up to 15s beyond the 8s nap)
      const retryDeadline = Date.now() + 15000;
      while (!wiqReady && Date.now() < retryDeadline) {
        await new Promise(r => setTimeout(r, 500));
      }
      [emailResult, teamsResult] = await fetchScanPair();
      console.log(`[SCAN] Phase 1 retry complete (email=${emailResult.status}, teams=${teamsResult.status})`);
      debugLog('PHASE1', `STUB-RETRY done`, { email: emailResult.status, teams: teamsResult.status });
    }

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
app.post('/api/tasks/:id/enrich', withTaskQueue(async (req, res) => {
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
}));

// POST /api/tasks/:id/check-update — Phase 3: check for thread updates
// v3.3: Action-Item-State injection, hard query budget, stub detection,
// tristate outcome (updated/no-update/inconclusive), no eval session, pre-filter.
app.post('/api/tasks/:id/check-update', withTaskQueue(async (req, res) => {
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
}));

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

// POST /api/tasks/:id/review — User responds to ambiguity review items (v2.1)
app.post('/api/tasks/:id/review', withTaskQueue(async (req, res) => {
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
}));

// POST /api/tasks/:id/correct — Evidence-based correction verification (v2.6: Opus 4.6 + Work IQ MCP)
app.post('/api/tasks/:id/correct', withTaskQueue(async (req, res) => {
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
}));

// POST /api/tasks/:id/correct/resolve — User resolves correction discussion (accept evidence or veto)
app.post('/api/tasks/:id/correct/resolve', withTaskQueue(async (req, res) => {
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
}));

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

// ============================================================================
// Phase γ.A.3 — Scan Job runner (v4.0.0-rc.1)
// ============================================================================
// A 'scan' job is the server-side driver of Phases 1-4 (scan / enrich / check /
// consolidate). It replaces the former client-side for-loop in index.html so
// that a browser refresh no longer terminates the work.
//
// Business logic is NOT duplicated: the job uses internal HTTP requests to the
// existing endpoints (/api/scan, /api/tasks/:id/enrich, /api/tasks/:id/check-
// update, /api/consolidate). Overhead is negligible compared to the 60-300 s
// LLM calls inside each step, and risk of regressions is minimal because the
// legacy endpoints are unchanged.
//
// Cancel semantics: "stop after current item" — the in-flight LLM call is
// allowed to finish (aborting mid-call has historically been unstable), but
// no further items are started.
// ----------------------------------------------------------------------------

async function runScanJob(job) {
  const baseUrl = `http://127.0.0.1:${PORT}`;
  const FETCH_HEADERS = { 'Content-Type': 'application/json' };

  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.emit('job.started', {});
  await persistJobSnapshot(job);

  const setPhase = async (phase, extra = {}) => {
    job.progress = {
      phase,
      phaseStartedAt: Date.now(),
      currentItemIndex: 0,
      totalItems: 0,
      currentTaskId: null,
      ...extra
    };
    job.emit('job.phase_changed', { phase, ...extra });
    await persistJobSnapshot(job);
  };

  const isCancelling = () => ['cancelling', 'cancelled'].includes(job.status);

  const markCancelled = async () => {
    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
    job.emit('job.cancelled', { atPhase: job.progress?.phase || null });
    unregisterActiveJob(job);
    await persistJobSnapshot(job);
  };

  const scanDays = Math.min(14, Math.max(1, parseInt(job.input?.scanDays, 10) || 4));

  try {
    // ── Phase 1: Scan M365 via legacy endpoint ──
    await setPhase('scan', { scanDays });
    let phase1Summary = { added: 0, updated: 0, skipped: 0, total: 0 };
    try {
      const r = await fetch(`${baseUrl}/api/scan`, {
        method: 'POST',
        headers: FETCH_HEADERS,
        body: JSON.stringify({ scanDays })
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => '');
        throw new Error(`Phase 1 HTTP ${r.status}: ${txt.substring(0, 200)}`);
      }
      const payload = await r.json();
      phase1Summary = {
        added: payload.added || 0,
        updated: payload.updated || 0,
        skipped: payload.skipped || 0,
        total: payload.total || 0
      };
    } catch (err) {
      job.emit('job.phase_error', { phase: 'scan', error: err.message });
      throw err;
    }
    job.emit('job.phase_done', { phase: 'scan', ...phase1Summary });
    if (isCancelling()) return markCancelled();

    // ── Phase 2: Enrich pending / error-retry tasks ──
    const afterScan = readTasks();
    const pendingForEnrich = afterScan.tasks.filter(t =>
      !['done', 'completed'].includes(t.status) &&
      (!t.enrichmentStatus || t.enrichmentStatus === 'pending' || t.enrichmentStatus === 'error')
    );
    await setPhase('enrich', { totalItems: pendingForEnrich.length });

    for (let i = 0; i < pendingForEnrich.length; i++) {
      if (isCancelling()) return markCancelled();
      const t = pendingForEnrich[i];
      job.progress = {
        ...job.progress,
        currentItemIndex: i,
        totalItems: pendingForEnrich.length,
        currentTaskId: t.id
      };
      job.emit('job.item_started', {
        phase: 'enrich',
        taskId: t.id,
        index: i,
        total: pendingForEnrich.length,
        title: (t.title || '').substring(0, 80)
      });
      let ok = false;
      let itemError = null;
      try {
        const r = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(t.id)}/enrich`, {
          method: 'POST',
          headers: FETCH_HEADERS,
          body: '{}'
        });
        ok = r.ok;
        if (!r.ok) itemError = `HTTP ${r.status}`;
      } catch (err) {
        itemError = err.message;
      }
      job.emit('job.item_done', {
        phase: 'enrich',
        taskId: t.id,
        index: i,
        total: pendingForEnrich.length,
        ok,
        error: itemError
      });
      await persistJobSnapshot(job);
    }
    job.emit('job.phase_done', { phase: 'enrich', processed: pendingForEnrich.length });
    if (isCancelling()) return markCancelled();

    // ── Phase 3: Check for updates on enriched tasks ──
    const afterEnrich = readTasks();
    const eligibleForCheck = afterEnrich.tasks.filter(t =>
      !['done', 'completed'].includes(t.status) &&
      ['enriched', 'needs-review'].includes(t.enrichmentStatus)
    );
    await setPhase('check', { totalItems: eligibleForCheck.length });

    for (let i = 0; i < eligibleForCheck.length; i++) {
      if (isCancelling()) return markCancelled();
      const t = eligibleForCheck[i];
      job.progress = {
        ...job.progress,
        currentItemIndex: i,
        totalItems: eligibleForCheck.length,
        currentTaskId: t.id
      };
      job.emit('job.item_started', {
        phase: 'check',
        taskId: t.id,
        index: i,
        total: eligibleForCheck.length,
        title: (t.title || '').substring(0, 80)
      });
      let ok = false;
      let itemError = null;
      try {
        const r = await fetch(`${baseUrl}/api/tasks/${encodeURIComponent(t.id)}/check-update`, {
          method: 'POST',
          headers: FETCH_HEADERS,
          body: '{}'
        });
        ok = r.ok;
        if (!r.ok) itemError = `HTTP ${r.status}`;
      } catch (err) {
        itemError = err.message;
      }
      job.emit('job.item_done', {
        phase: 'check',
        taskId: t.id,
        index: i,
        total: eligibleForCheck.length,
        ok,
        error: itemError
      });
      await persistJobSnapshot(job);
    }
    job.emit('job.phase_done', { phase: 'check', processed: eligibleForCheck.length });
    if (isCancelling()) return markCancelled();

    // ── Phase 4: Consolidate duplicates ──
    await setPhase('consolidate', {});
    let consolidateSummary = { suggestions: 0 };
    try {
      const r = await fetch(`${baseUrl}/api/consolidate`, {
        method: 'POST',
        headers: FETCH_HEADERS,
        body: '{}'
      });
      if (r.ok) {
        const payload = await r.json().catch(() => ({}));
        consolidateSummary = {
          suggestions: (payload && payload.suggestions && payload.suggestions.length) || 0
        };
      } else {
        consolidateSummary.error = `HTTP ${r.status}`;
      }
    } catch (err) {
      consolidateSummary.error = err.message;
    }
    job.emit('job.phase_done', { phase: 'consolidate', ...consolidateSummary });

    // ── Completion ──
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.result = {
      phase1: phase1Summary,
      phase2Processed: pendingForEnrich.length,
      phase3Processed: eligibleForCheck.length,
      phase4: consolidateSummary
    };
    job.emit('job.completed', { result: job.result });
    unregisterActiveJob(job);
    await persistJobSnapshot(job);
  } catch (err) {
    console.error(`[SCAN-JOB] ${job.id} failed: ${err.stack || err.message}`);
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
      job.status = 'failed';
      job.error = err.message || String(err);
      job.completedAt = new Date().toISOString();
      job.emit('job.failed', { error: job.error, atPhase: job.progress?.phase || null });
      unregisterActiveJob(job);
      try { await persistJobSnapshot(job); } catch {}
    }
  }
}

// ============================================================================
// v4.0.1 — Merge Job runner
// ============================================================================
// A 'merge' job is the server-side driver for POST /api/tasks/merge. Same
// rationale as scan: the merge AI call can take up to 90 s, so it must
// survive a browser refresh. The runner delegates the actual work to the
// existing /api/tasks/merge endpoint via internal HTTP, exactly like
// runScanJob does for /api/consolidate.
//
// Input:   { taskIds: string[], suggestedTitle?: string }
// Output:  { task: {...merged task...} }
// ----------------------------------------------------------------------------

async function runMergeJob(job) {
  const baseUrl = `http://127.0.0.1:${PORT}`;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.progress = { phase: 'merge', totalItems: (job.input?.taskIds || []).length };
  job.emit('job.started', { kind: 'merge', taskIds: job.input?.taskIds || [] });
  await persistJobSnapshot(job);

  try {
    const r = await fetch(`${baseUrl}/api/tasks/merge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(job.input || {})
    });
    const payload = await r.json().catch(() => ({}));
    if (!r.ok || !payload.success) {
      throw new Error(payload.error || payload.detail || `HTTP ${r.status}`);
    }
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.result = { task: payload.task };
    job.emit('job.completed', {
      kind: 'merge',
      taskId: payload.task && payload.task.id,
      title: payload.task && payload.task.title
    });
    unregisterActiveJob(job);
    await persistJobSnapshot(job);
  } catch (err) {
    console.error(`[MERGE-JOB] ${job.id} failed: ${err.message}`);
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
      job.status = 'failed';
      job.error = err.message || String(err);
      job.completedAt = new Date().toISOString();
      job.emit('job.failed', { kind: 'merge', error: job.error });
      unregisterActiveJob(job);
      try { await persistJobSnapshot(job); } catch {}
    }
  }
}

// ============================================================================
// v4.0.1 — Consolidate Job runner
// ============================================================================
// A 'consolidate' job is the standalone server-side driver for the
// "Find Duplicates" button. (The 4-phase scan job still calls /api/consolidate
// directly via internal HTTP — that internal call does NOT spawn a separate
// job.) The consolidate AI call can take up to 300 s, so a refresh-resilient
// job wrapper is essential.
//
// Output:  { suggestions: [...] }
// ----------------------------------------------------------------------------

async function runConsolidateJob(job) {
  const baseUrl = `http://127.0.0.1:${PORT}`;
  job.status = 'running';
  job.startedAt = new Date().toISOString();
  job.progress = { phase: 'consolidate' };
  job.emit('job.started', { kind: 'consolidate' });
  await persistJobSnapshot(job);

  try {
    const r = await fetch(`${baseUrl}/api/consolidate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}'
    });
    const payload = await r.json().catch(() => ({}));
    if (!r.ok) {
      throw new Error(payload.error || payload.reason || `HTTP ${r.status}`);
    }
    job.status = 'completed';
    job.completedAt = new Date().toISOString();
    job.result = { suggestions: payload.suggestions || [] };
    job.emit('job.completed', {
      kind: 'consolidate',
      suggestions: payload.suggestions || []
    });
    unregisterActiveJob(job);
    await persistJobSnapshot(job);
  } catch (err) {
    console.error(`[CONSOLIDATE-JOB] ${job.id} failed: ${err.message}`);
    if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
      job.status = 'failed';
      job.error = err.message || String(err);
      job.completedAt = new Date().toISOString();
      job.emit('job.failed', { kind: 'consolidate', error: job.error });
      unregisterActiveJob(job);
      try { await persistJobSnapshot(job); } catch {}
    }
  }
}

// ----------------------------------------------------------------------------
// POST /api/jobs — generic job creator.
// Body: { kind, input?, clientRequestId? }
// Supported kinds: 'scan', 'merge', 'consolidate'
// Responses:
//   202 { jobId, status:'queued' }              — new job started
//   202 { jobId, status, idempotent:true }      — same clientRequestId, same body
//   409 { error, existingJobId }                — singleton already running, or conflict
//   400 { error }                               — unsupported kind / missing field
// ----------------------------------------------------------------------------
const SUPPORTED_JOB_KINDS = {
  scan: runScanJob,
  merge: runMergeJob,
  consolidate: runConsolidateJob
};

app.post('/api/jobs', async (req, res) => {
  const { kind, input = {}, clientRequestId = null } = req.body || {};
  if (!kind || typeof kind !== 'string') {
    return res.status(400).json({ error: 'kind is required' });
  }
  const runner = SUPPORTED_JOB_KINDS[kind];
  if (!runner) {
    return res.status(400).json({
      error: `kind='${kind}' not supported (supported: ${Object.keys(SUPPORTED_JOB_KINDS).join(', ')})`
    });
  }

  // Per-kind input validation
  if (kind === 'merge') {
    const ids = input && input.taskIds;
    if (!Array.isArray(ids) || ids.length < 2) {
      return res.status(400).json({ error: 'merge requires input.taskIds with >= 2 entries' });
    }
  }

  const bodyHash = hashBody({ kind, input });
  const idem = checkIdempotency(clientRequestId, bodyHash);
  if (idem.status === 'conflict') {
    return res.status(409).json({ error: 'clientRequestId reused with different body' });
  }
  if (idem.status === 'hit') {
    const existing = jobs.get(idem.jobId);
    return res.status(202).json({
      jobId: idem.jobId,
      status: existing ? existing.status : 'unknown',
      idempotent: true
    });
  }

  const guard = tryAcquireSingleton(kind);
  if (!guard.acquired) {
    return res.status(409).json({
      error: `A '${kind}' job is already running`,
      existingJobId: guard.existingJobId
    });
  }

  const job = new Job({ taskId: null, kind, input, clientRequestId });
  registerJob(job);
  storeIdempotency(clientRequestId, job.id, bodyHash);
  await persistJobSnapshot(job);

  setImmediate(() => {
    runner(job).catch(err => {
      console.error(`[${kind.toUpperCase()}-JOB] unhandled: ${err.stack || err.message}`);
      if (!['completed', 'failed', 'cancelled'].includes(job.status)) {
        job.status = 'failed';
        job.error = `Unhandled: ${err.message}`;
        try { job.emit('job.failed', { kind, error: job.error }); } catch {}
        unregisterActiveJob(job);
      }
    });
  });

  res.status(202).json({ jobId: job.id, status: 'queued' });
});

// GET /api/jobs?active=true
// Returns { jobs, snapshotEventId } atomically for SSE boot-race safety:
// the client uses snapshotEventId as lastEventId when opening /api/events,
// guaranteeing no gap and no duplicate events between the snapshot and the
// live stream.
app.get('/api/jobs', (req, res) => {
  const activeOnly = req.query.active === 'true' || req.query.active === '1';
  if (activeOnly) {
    return res.json(snapshotActiveJobs());
  }
  const list = [];
  for (const j of jobs.values()) list.push(j.snapshot());
  res.json({ jobs: list, snapshotEventId: globalEventSeq });
});

// --- Start Server ---

migrateTasks();
migrateStatuses();
migrateToV3();
migrateToV4();
markInterruptedJobs();
markInterruptedGlobalJobs();

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

// ============================================================================
// Single-Instance Guard (v4.0.2)
// ----------------------------------------------------------------------------
// Prevents two Agent Zero instances from running simultaneously — important
// because the Windows Task Scheduler may trigger a startup while an instance
// is already running in the user session. Strategy:
//   1. Lock file at .agent-zero.lock containing { pid, port, startedAt }.
//   2. On startup, if lock exists AND pid is alive AND the port responds with
//      service:"agent-zero" on /api/health → exit 0 gracefully (no error).
//   3. Fallback: scan ports 3000–3020 in parallel for agent-zero signature.
//   4. If another instance is detected → log + exit 0 (Task Scheduler sees
//      success, no duplicate process).
//   5. Otherwise remove stale lock, start listening, write fresh lock.
//   6. On SIGINT/SIGTERM/exit → remove lock so next start isn't blocked.
// ============================================================================
const LOCK_FILE = path.join(__dirname, '.agent-zero.lock');
const LOCK_SCAN_PORT_MIN = 3000;
const LOCK_SCAN_PORT_MAX = 3020;

function pingAgentZero(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const req = http.get({
      host: '127.0.0.1', port, path: '/api/health', timeout: timeoutMs
    }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          if (j && j.service === 'agent-zero') finish(j);
          else finish(null);
        } catch { finish(null); }
      });
    });
    req.on('error', () => finish(null));
    req.on('timeout', () => { try { req.destroy(); } catch {} finish(null); });
  });
}

function isPidAlive(pid) {
  if (!pid || typeof pid !== 'number') return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function detectExistingInstance() {
  // 1. Lock-file check (fastest, most reliable)
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
      if (lock.pid && lock.port && isPidAlive(lock.pid)) {
        const info = await pingAgentZero(lock.port, 2500);
        if (info) return { ...info, via: 'lockfile' };
      }
    } catch {}
    // Stale lock — will be overwritten when we start
  }
  // 2. Prioritized check: our preferred PORT first with generous timeout
  //    (localhost-to-localhost on Windows can take >800ms on cold sockets).
  const primary = await pingAgentZero(PORT, 2500);
  if (primary) return { ...primary, via: 'portscan-primary' };
  // 3. Port-scan fallback — scan 3000..3020 in parallel for non-default ports
  const ports = [];
  for (let p = LOCK_SCAN_PORT_MIN; p <= LOCK_SCAN_PORT_MAX; p++) {
    if (p !== PORT) ports.push(p);
  }
  const results = await Promise.all(ports.map(async (p) => {
    const info = await pingAgentZero(p, 1500);
    return info ? { ...info, via: 'portscan' } : null;
  }));
  return results.find((r) => r) || null;
}

function writeLockFile() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf-8'));
    fs.writeFileSync(LOCK_FILE, JSON.stringify({
      pid: process.pid,
      port: PORT,
      startedAt: new Date().toISOString(),
      version: pkg.version
    }, null, 2));
  } catch (e) {
    console.warn(`[LOCK] Could not write lock file: ${e.message}`);
  }
}

function removeLockFile() {
  try {
    if (fs.existsSync(LOCK_FILE)) {
      // Only remove if it's OUR lock (defensive: avoid racing with another instance)
      try {
        const lock = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8'));
        if (lock.pid && lock.pid !== process.pid) return;
      } catch {}
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

let lockRemovalRegistered = false;
function registerLockCleanup() {
  if (lockRemovalRegistered) return;
  lockRemovalRegistered = true;
  process.on('exit', removeLockFile);
  const shutdown = (sig) => {
    console.log(`[LOCK] Received ${sig} — cleaning up lock file.`);
    removeLockFile();
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  // Windows: SIGBREAK from Ctrl+Break in cmd
  process.on('SIGBREAK', () => shutdown('SIGBREAK'));
}

async function startServer() {
  const existing = await detectExistingInstance();
  if (existing) {
    console.log(`[STARTUP] ✅ Agent Zero is already running (pid=${existing.pid}, port=${existing.port}, version=${existing.version}, detected via ${existing.via}).`);
    console.log(`[STARTUP] No duplicate instance will be started. Access: http://localhost:${existing.port}`);
    process.exit(0);
  }

  // Clean stale lock (if any)
  try { if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE); } catch {}

  app.listen(PORT, 'localhost', async () => {
    console.log(`Agent Zero running at http://localhost:${PORT}`);
    writeLockFile();
    registerLockCleanup();
    // Start persistent Work IQ MCP subprocess (auth once, EULA once, cached for session)
    try {
      await startWorkIQMCP();
      console.log('[WORKIQ] ✅ Ready — persistent MCP subprocess with cached auth');
    } catch (e) {
      console.warn(`[WORKIQ] ⚠️ MCP startup failed: ${e.message} — will retry on first query`);
    }
  }).on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Last-line-of-defense: port taken after our pre-check (rare race).
      pingAgentZero(PORT).then((info) => {
        if (info) {
          console.log(`[STARTUP] ✅ Port ${PORT} is held by an existing Agent Zero instance (pid=${info.pid}). Exiting cleanly.`);
          process.exit(0);
        }
        console.error(`\n❌ Port ${PORT} is already in use by a non-Agent-Zero process.`);
        console.error(`   → Close that app, or use START-AGENT-ZERO.bat (picks a free port 3001–3020).\n`);
        process.exit(1);
      });
    } else {
      console.error(`\n❌ Server failed to start: ${err.message}\n`);
      process.exit(1);
    }
  });
}

startServer();
