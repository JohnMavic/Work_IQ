import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { CopilotClient } from '@github/copilot-sdk';
import { spawn } from 'child_process';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = 3000;
const TASKS_FILE = path.join(__dirname, 'tasks.json');

// --- Global Error Handlers (crash prevention) ---
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
const sessionTimestamps = new Map(); // session → creation time for staleness detection

function trackSession(session) {
  if (session) {
    activeSessions.add(session);
    sessionTimestamps.set(session, Date.now());
  }
  return session;
}

async function destroySession(session) {
  if (!session) return;
  activeSessions.delete(session);
  sessionTimestamps.delete(session);
  try { await session.destroy(); } catch {}
}

async function destroyAllSessions() {
  const sessions = [...activeSessions];
  activeSessions.clear();
  sessionTimestamps.clear();
  await Promise.allSettled(sessions.map(s => {
    try { return s.destroy(); } catch { return Promise.resolve(); }
  }));
}

// Periodic reaper: kill orphaned SDK subprocesses every 5 minutes during runtime.
// Also destroys tracked sessions that have been alive for over 10 minutes (stuck).
function startPeriodicReaper() {
  setInterval(async () => {
    // Step 1: Destroy stale tracked sessions (>10 min old)
    const now = Date.now();
    const staleTimeout = 10 * 60 * 1000; // 10 minutes
    for (const [session, created] of sessionTimestamps.entries()) {
      if (now - created > staleTimeout) {
        console.log(`[REAPER] Destroying stale session (age: ${((now - created) / 1000).toFixed(0)}s)`);
        await destroySession(session);
      }
    }

    // Step 2: Kill orphaned OS-level processes
    try {
      await reapOrphanedSessions();
    } catch {}
  }, 5 * 60 * 1000); // every 5 minutes
}

// Graceful shutdown: destroy all tracked sessions before exit
function setupGracefulShutdown() {
  let shuttingDown = false;
  const shutdown = async (signal) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n[SHUTDOWN] ${signal} received — cleaning up ${activeSessions.size} active session(s)...`);
    await destroyAllSessions();
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
  // Only kill orphaned SDK processes — NOT those actively used by this server.
  // Strategy: kill processes that started BEFORE this server (orphans from previous runs).
  // Active sessions started after our server are by definition ours.
  if (activeSessions.size > 0) {
    // Don't reap while sessions are active — they might own child processes
    return;
  }
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
        console.log(`[REAPER] Killed ${orphanPids.length} orphaned subprocess(es)`);
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

// --- Work IQ Direct CLI (v1.4) ---

function runWorkIQAsk(question, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    // Interactive mode via stdin — workiq ask without -q writes to stdout properly
    // (workiq ask -q writes to console/TTY directly, bypassing stdout capture)
    const proc = spawn('workiq', ['ask'], { stdio: ['pipe', 'pipe', 'pipe'], shell: true });

    const timer = setTimeout(() => {
      proc.kill();
      reject(new Error(`Timeout after ${timeoutMs / 1000}s waiting for workiq ask`));
    }, timeoutMs);

    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout.trim());
      else reject(new Error(stderr.trim() || `workiq ask exited with code ${code}`));
    });
    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    // Send question via stdin after brief init delay
    setTimeout(() => {
      proc.stdin.write(question + '\n');
      proc.stdin.end();
    }, 500);
  });
}

function buildSearchQuestion(plan, taskContext, userText) {
  const targets = plan.searchTargets || 'inbox';

  // Calculate time window as "last N days" with explicit date range in parentheses
  function timeWindow(tw) {
    const now = new Date();
    const months = ['January','February','March','April','May','June',
      'July','August','September','October','November','December'];
    const fmtDate = d => `${months[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;

    if (!tw?.from) {
      const from = new Date(now); from.setDate(from.getDate() - 7);
      return `from the last 7 days (${fmtDate(from)}-${fmtDate(now)})`;
    }
    const fromDate = new Date(tw.from);
    const days = Math.max(2, Math.ceil((now - fromDate) / (1000 * 60 * 60 * 24)) + 1);
    return `from the last ${days} days (${fmtDate(fromDate)}-${fmtDate(now)})`;
  }

  const tw = timeWindow(plan.timeWindow);
  const keywords = plan.keywords || [];

  // AI-determined sender (person name or domain) takes priority
  const sender = plan.searchFrom || null;

  let question;
  if (sender) {
    question = `Find all emails from ${sender} in my ${targets} ${tw}.`;
  } else if (keywords.length > 0) {
    question = `Find all emails in my ${targets} ${tw} about ${keywords.join(' or ')}.`;
  } else {
    // Last resort: use task title context
    question = `Find all emails in my ${targets} ${tw} related to "${taskContext.title}".`;
  }

  question += ` For each email show: subject line, date, and the full email body content. Order by date descending.`;

  return question;
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

// POST /api/scan — scan M365 emails and Teams via Copilot SDK + Work IQ
app.post('/api/scan', async (req, res) => {
  let client, session;
  const scanDays = Math.min(14, Math.max(1, parseInt(req.body?.scanDays) || 4));
  try {
    client = new CopilotClient();
    session = trackSession(await client.createSession({
      mcpServers: {
        workiq: {
          type: 'stdio',
          command: 'workiq',
          args: ['mcp'],
          tools: '*'
        }
      }
    }));

    // Build context-aware prompt with existing tasks (v1.3, dedup fix v1.5)
    const data = readTasks();
    const activeTasks = data.tasks
      .filter(t => t.status === 'new' || t.status === 'needs-attention' || t.status === 'escalated' || t.status === 'in-progress')
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 50)
      .map(t => ({ id: t.id, title: t.title, source: t.source, from: t.from }));

    // Include recent done tasks so AI won't re-create them (dedup fix)
    const doneTasks = data.tasks
      .filter(t => t.status === 'done')
      .sort((a, b) => (b.doneAt || b.updatedAt || '').localeCompare(a.doneAt || a.updatedAt || ''))
      .slice(0, 30)
      .map(t => ({ id: t.id, title: t.title, source: t.source, from: t.from, status: 'done' }));

    const allContextTasks = [...activeTasks, ...doneTasks];

    let scanPrompt;
    const daysText = `last ${scanDays} day${scanDays === 1 ? '' : 's'}`;

    // Build dedup context: compact list of existing task titles for matching
    const contextLines = allContextTasks.map(t => {
      const status = t.status === 'done' ? ' [DONE]' : '';
      return `- "${t.title}" (${t.source}, from ${t.from || 'unknown'})${status}`;
    }).join('\n');

    // Hybrid approach: naive question + dedup context + structured JSON output
    scanPrompt = `Which of my emails and Teams messages from the ${daysText} require me to take action?

I need to respond, approve, review, decide, deliver, or follow up on something. Find ALL such messages.

${allContextTasks.length > 0 ? `IMPORTANT — I already have these action items tracked. Do NOT return items that match an existing one (same topic, same thread, same request — even if worded differently or with different prefixes like Re:, Fw:, [EXTERN]):
${contextLines}

For items matching an EXISTING active task, return: {"action": "update", "existingId": "<id>", "changes": {"date": "...", "link": "..."}, "reason": "why"}
For items matching a DONE task, return: {"action": "skip"} — do NOT re-create them unless there is genuinely NEW activity.
For NEW items not yet tracked, return the full object below.
` : ''}
For each NEW actionable message, return:
{
  "action": "new",
  "title": "EXACT email subject line or Teams message topic — copy character by character, do NOT rephrase",
  "source": "email" or "teams",
  "from": "Sender's display name",
  "date": "ISO 8601 date string",
  "link": "Direct URL to open this specific message (Outlook link or Teams deep link), or null",
  "actionNeeded": "What exactly I need to do (1-2 sentences)",
  "deadline": "Deadline if mentioned, or null"
}

RULES:
1. Subject lines must be EXACT — copy them character by character. Do NOT rephrase or summarize.
2. Each link must be the specific URL for THAT message. Wrong link = set to null.
3. Ignore purely informational messages (FYI, newsletters, automated notifications with no action).
4. Ignore calendar invitations unless they contain an explicit action request.
5. Ignore messages where I am only in CC with no expectation to act.

Return ONLY a JSON array. No markdown, no explanation, no code blocks.
If nothing requires action, return [].`;

    const scanStart = Date.now();
    let response = null;
    let lastError = null;

    // Attempt 1: full context
    console.log(`[SCAN] Attempt 1: Prompt size: ${scanPrompt.length} chars, timeout: 300s, scanDays: ${scanDays}`);
    try {
      response = await session.sendAndWait({ prompt: scanPrompt }, 300000);
      console.log(`[SCAN] Response received in ${((Date.now() - scanStart) / 1000).toFixed(1)}s`);
    } catch (err1) {
      lastError = err1;
      console.warn(`[SCAN] Attempt 1 failed: ${err1.message}`);
      await destroySession(session);

      // Attempt 2: reduced context, shorter scan range
      const reducedDays = Math.min(scanDays, 2);
      const reducedContext = allContextTasks.slice(0, 10).map(t => `- "${t.title}"${t.status === 'done' ? ' [DONE]' : ''}`).join('\n');
      const reducedPrompt = `Which of my emails and Teams messages from the last ${reducedDays} day${reducedDays === 1 ? '' : 's'} require me to take action?
${reducedContext ? `\nAlready tracked (do NOT duplicate):\n${reducedContext}\n` : ''}
For each NEW actionable message, return: {"action":"new","title":"EXACT subject","source":"email"/"teams","from":"sender","date":"ISO date","link":"URL or null","actionNeeded":"what to do","deadline":"deadline or null"}
Return ONLY a JSON array. If nothing, return [].`;

      console.log(`[SCAN] Attempt 2: Reduced prompt ${reducedPrompt.length} chars, ${reducedDays} days, ${reducedTasks.length} context tasks`);
      try {
        client = new CopilotClient();
        session = trackSession(await client.createSession({
          mcpServers: { workiq: { type: 'stdio', command: 'workiq', args: ['mcp'], tools: '*' } }
        }));
        response = await session.sendAndWait({ prompt: reducedPrompt }, 300000);
        console.log(`[SCAN] Attempt 2 succeeded in ${((Date.now() - scanStart) / 1000).toFixed(1)}s`);
      } catch (err2) {
        lastError = err2;
        console.error(`[SCAN] Attempt 2 also failed: ${err2.message}`);
      }
    }

    await destroySession(session);

    if (!response) {
      return res.status(502).json({ error: `Scan timed out after 2 attempts: ${lastError?.message || 'No response'}` });
    }

    const rawContent = response.data.content;
    const items = parseJsonFromResponse(rawContent);

    if (!Array.isArray(items)) {
      return res.status(502).json({
        error: 'AI returned unexpected format',
        raw: rawContent
      });
    }

    // Process AI results: context-aware dedup (v1.3)
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
          // If the matching task is done, reactivate it instead of creating a duplicate
          if (similarTask.status === 'done') {
            const now2 = new Date().toISOString();
            similarTask.status = 'needs-attention';
            similarTask.doneAt = null;
            if (!similarTask.history) similarTask.history = [];
            similarTask.history.push({
              timestamp: now2,
              type: 'reactivated',
              text: `🔄 Reactivated: new activity detected in "${titleNorm}" (from ${fromNorm || 'unknown'}). Previous status was done.`
            });
            // Update link/date if the new scan has fresher data
            if (item.link) similarTask.link = String(item.link).trim();
            if (item.date) similarTask.date = item.date;
            similarTask.enrichmentStatus = 'pending';
            similarTask.updateCheckStatus = 'pending';
            similarTask.updatedAt = now2;
            newTaskIds.push(similarTask.id);
            updated++;
            console.log(`Reactivated done task: "${similarTask.title}" (matched "${titleNorm}")`);
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
  } finally {
    await destroySession(session);
    if (client) {
      try { await client.dispose(); } catch {}
    }
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
    if (task.enrichmentStatus === 'enriched' || task.enrichmentStatus === 'needs-review') {
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
    client = new CopilotClient();
    session = trackSession(await client.createSession({
      mcpServers: {
        workiq: {
          type: 'stdio',
          command: 'workiq',
          args: ['mcp'],
          tools: '*'
        }
      }
    }));

    // Extract keywords from title (drop common words, keep distinctive terms)
    const stopWords = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'and', 'or', 'via', 'with', 'from', 'my', 'your', 'is', 'are', 'was', 'be', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'this', 'that', 'these', 'those', 'it', 'its']);
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
    const response = await session.sendAndWait({ prompt: enrichPrompt }, 300000);
    const enrichDuration = Date.now() - enrichStart;
    console.log(`[ENRICH] Response in ${(enrichDuration / 1000).toFixed(1)}s`);
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
app.post('/api/tasks/:id/check-update', async (req, res) => {
  const { id } = req.params;

  let task;
  try {
    const data = readTasks();
    task = data.tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
  } catch (err) {
    return res.status(500).json({ error: 'Failed to read task', detail: err.message });
  }

  // Mark as checking
  await safeWriteTasks((data) => {
    const t = data.tasks.find(t => t.id === id);
    if (t) t.updateCheckStatus = 'checking';
  });

  let client, session;
  try {
    client = new CopilotClient();
    session = trackSession(await client.createSession({
      mcpServers: {
        workiq: {
          type: 'stdio',
          command: 'workiq',
          args: ['mcp'],
          tools: '*'
        }
      }
    }));

    // Extract keywords from title (same technique as Phase 2)
    const stopWords = new Set(['the', 'a', 'an', 'to', 'for', 'of', 'in', 'on', 'at', 'by', 'and', 'or', 'via', 'with', 'from', 'my', 'your', 'is', 'are', 'was', 'be', 'has', 'have', 'had', 'do', 'does', 'did', 'will', 'would', 'should', 'could', 'this', 'that', 'these', 'those', 'it', 'its']);
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

    // Temporal anchor: use lastUpdateCheck if available, otherwise enrichedAt or createdAt
    const lastChecked = task.lastUpdateCheck || task.enrichedAt || task.createdAt || task.date || 'unknown';

    const updateSkill = UPDATE_CHECK_SKILL || '';
    const checkPrompt = updateSkill + '\n\n' +
      `Search for the ${task.source === 'teams' ? 'Teams conversation' : 'email thread'} about: ${keywords}\n` +
      `Full subject: "${task.title}"\n` +
      `Sender (hint, may not be exact): ${task.from || 'unknown'}\n` +
      `Source: ${task.source}\n` +
      `Last checked date: ${lastChecked}\n` +
      `Current summary: ${task.summary || '(no summary)'}` +
      linkContext + '\n\n' +
      `Find this conversation and check for messages dated AFTER ${lastChecked}. Only report genuinely NEW activity. Everything before that date was already captured.`;

    const checkStart = Date.now();
    console.log(`[UPDATE-CHECK] Task "${task.title}" — checking for updates since ${lastChecked} (prompt: ${checkPrompt.length} chars)`);
    const response = await session.sendAndWait({ prompt: checkPrompt }, 300000);
    console.log(`[UPDATE-CHECK] Response in ${((Date.now() - checkStart) / 1000).toFixed(1)}s`);
    await destroySession(session);

    if (!response) {
      await safeWriteTasks((data) => {
        const t = data.tasks.find(t => t.id === id);
        if (t) t.updateCheckStatus = 'error';
      });
      return res.status(502).json({ error: 'No response from AI engine' });
    }

    const rawContent = response.data.content;
    const result = parseJsonFromResponse(rawContent);

    // Save original values before modification (for evaluation prompt)
    const originalTitle = task.title;
    const originalSummary = task.summary || '';

    const updated = await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (!t) return null;

      const now = new Date().toISOString();
      t.lastUpdateCheck = now;

      if (result && result.hasUpdate && result.updateSummary) {
        t.updateCheckStatus = 'updated';
        t.status = 'updated';
        if (!t.history) t.history = [];
        const checkDuration = ((Date.now() - checkStart) / 1000).toFixed(1);
        const historyLines = [
          `🔄 Update detected (${checkDuration}s)`,
          `   Search: "${keywords}"`,
          `   Since: ${lastChecked}`,
          `   New messages: ${result.newMessageCount || 'unknown'}`,
          `   Update: ${String(result.updateSummary).trim()}`
        ];
        t.history.push({
          timestamp: now,
          type: 'thread-update',
          text: historyLines.join('\n')
        });
        // Prepend update with timestamp (newest on top — may be refined by evaluation below)
        const updateTs = formatUpdateTimestamp(new Date());
        const updateLine = `📌 Update (${updateTs}): ${String(result.updateSummary).trim()}`;
        t.summary = updateLine + '\n\n' + (t.summary || '');
        t.updatedAt = now;
        return { hasUpdate: true, updateSummary: result.updateSummary };
      } else {
        t.updateCheckStatus = 'checked';
        const checkDuration = ((Date.now() - checkStart) / 1000).toFixed(1);
        if (!t.history) t.history = [];
        t.history.push({
          timestamp: now,
          type: 'update-check',
          text: `✅ No new activity detected (${checkDuration}s) — searched: "${keywords}"`
        });
        t.updatedAt = now;
        return { hasUpdate: false };
      }
    });

    // Post-search evaluation: intelligently update title/summary if Phase 3 found new info
    let evaluation = null;
    if (updated && updated.hasUpdate && updated.updateSummary) {
      let evalClient, evalSession;
      try {
        console.log(`[EVAL-P3] Starting post-update evaluation for task "${originalTitle}" (${id})`);
        evalClient = new CopilotClient();
        evalSession = trackSession(await evalClient.createSession({}));

        const evalPrompt = `You are evaluating whether a task's title and summary need updating based on new information from an update check.

CURRENT TASK:
Title: "${originalTitle}"
Summary: ${originalSummary ? `"${originalSummary}"` : '(no summary)'}

NEW UPDATE FOUND:
"${updated.updateSummary}"

INSTRUCTIONS:

1. TITLE evaluation — be PROACTIVE about updating:
   - The title must reflect the CURRENT state of this action item, not the original request.
   - If the situation has evolved in ANY way (reply received, decision made, deadline passed, request fulfilled, meeting confirmed), UPDATE the title to reflect what is happening NOW.
   - Example: "Please prepare slides by Friday" → "Slides submitted — awaiting review from Jawad"
   - Example: "Harshitha asks for presentation topic" → "Learn & Grow session confirmed for April 17"
   - Be decisive: if the latest update changes the situation, the title MUST change.
   - Keep it concise: max 15 words, factual, no emojis.

2. SUMMARY evaluation — maintain REVERSE CHRONOLOGICAL structure:
   The summary MUST follow this structure:
   - NEWEST updates at the TOP, each with a timestamp marker: "📌 Update (DD.MM.YYYY, HH:MM): ..."
   - OLDER updates below, also with timestamp markers
   - The ORIGINAL base summary at the BOTTOM
   - Each update is separated by a blank line

   Example structure:
   📌 Update (11.03.2026, 11:40): Session confirmed for April 17, Martin as co-organizer...

   📌 Update (10.03.2026, 14:22): Martin provided title and description...

   📌 Update (09.03.2026, 08:15): Harshitha agreed to the proposal...

   Harshitha Digumarthi hat Martin als Guest Speaker eingeladen...

   Rules:
   - Preserve ALL existing updates and the base summary — do NOT drop any information.
   - You may MERGE or DEDUPLICATE genuinely redundant updates, but never silently remove information.
   - If an existing update already has a timestamp, keep it. If it lacks one, leave it without rather than guessing.
   - The new update has already been prepended with a timestamp. Ensure it stays at the top.
   - Write in the SAME language as the existing content.

3. Only set *Changed to true when there is a GENUINE reason to update.

Return ONLY valid JSON, no markdown:
{
  "titleChanged": true or false,
  "newTitle": "new title text (only if titleChanged is true, otherwise omit)",
  "summaryChanged": true or false,
  "newSummary": "full updated summary text (only if summaryChanged is true, otherwise omit)",
  "reasoning": "One sentence explaining why changes were or were not needed"
}`;

        const evalResponse = await evalSession.sendAndWait({ prompt: evalPrompt }, 30000);
        await destroySession(evalSession);

        if (evalResponse) {
          const evalResult = parseJsonFromResponse(evalResponse.data.content);
          if (evalResult && typeof evalResult === 'object') {
            evaluation = evalResult;
            console.log(`[EVAL-P3] Result: titleChanged=${evalResult.titleChanged}, summaryChanged=${evalResult.summaryChanged}, reasoning="${evalResult.reasoning || ''}"`);

            if (evalResult.titleChanged || evalResult.summaryChanged) {
              await safeWriteTasks((data) => {
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
                    text: `📝 Title updated after update check:\n"${prevTitle}" → "${t.title}"\nReason: ${evalResult.reasoning || 'New information from update check'}`
                  });
                  console.log(`[EVAL-P3] Title changed: "${prevTitle}" → "${t.title}"`);
                }

                if (evalResult.summaryChanged && evalResult.newSummary) {
                  t.summary = String(evalResult.newSummary).trim();
                  t.history.push({
                    timestamp: now,
                    type: 'summary-update',
                    text: `📋 Summary refined after update check\nReason: ${evalResult.reasoning || 'New information from update check'}`
                  });
                  console.log(`[EVAL-P3] Summary refined (${t.summary.length} chars)`);
                }

                t.updatedAt = now;
                return t;
              });
            }
          }
        }
      } catch (evalErr) {
        console.error(`[EVAL-P3] Post-update evaluation failed (non-fatal): ${evalErr.message}`);
      } finally {
        await destroySession(evalSession);
        if (evalClient) {
          try { await evalClient.dispose(); } catch {}
        }
      }
    }

    res.json({ success: true, ...updated, evaluation });
  } catch (err) {
    console.error(`[UPDATE-CHECK] Failed for task ${id}:`, err);
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
      summary: (t.summary || '').substring(0, 500),
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

    client = new CopilotClient();
    session = trackSession(await client.createSession({}));

    const startTime = Date.now();
    console.log(`[CONSOLIDATE] Analyzing ${activeTasks.length} tasks for merge suggestions (prompt: ${prompt.length} chars)`);
    const response = await session.sendAndWait({ prompt }, 30000);
    console.log(`[CONSOLIDATE] Response in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
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
    client = new CopilotClient();
    session = trackSession(await client.createSession({}));

    const mergePrompt = `You are merging multiple action items into one unified summary.

TASKS TO MERGE:
${tasksToMerge.map((t, i) => `\n--- Task ${i + 1}: "${t.title}" ---\nSummary: ${t.summary || '(no summary)'}\nFrom: ${t.from || 'unknown'}\nSource: ${t.source}`).join('\n')}

INSTRUCTIONS:
1. Create a UNIFIED SUMMARY that combines all information from all tasks.
2. Preserve ALL important details: names, dates, decisions, action items, updates.
3. Maintain reverse chronological order: newest updates at top with "📌 Update" markers.
4. Write in the SAME LANGUAGE as the original summaries.
5. Do NOT lose any information from any task.
6. If different people have different perspectives, attribute them clearly.

Return ONLY valid JSON:
{
  "mergedSummary": "The complete unified summary text",
  "mergedTitle": "A concise title (max 15 words) for the merged task"
}`;

    const startTime = Date.now();
    console.log(`[MERGE] Merging ${tasksToMerge.length} tasks`);
    const response = await session.sendAndWait({ prompt: mergePrompt }, 30000);
    console.log(`[MERGE] Response in ${((Date.now() - startTime) / 1000).toFixed(1)}s`);
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

  // Build rich conversation history for the agent (full context)
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
      preSession = trackSession(await client.createSession({}));
      try {
        const updateOnlyPrompt = `You are updating a task tracker. The user is providing information and wants the task updated. Generate an appropriate update that MERGES the new information with the existing content.

TASK:
Title: "${task.title}"
Summary: ${task.summary || '(none)'}
${recentHistory ? `\nHistory:\n${recentHistory}\n` : ''}
USER'S MESSAGE:
"${text.trim()}"

RULES FOR THE SUMMARY:
- By default, keep ALL existing summary content intact
- ADD the new information at the TOP with a timestamp: "📌 Update (DD.MM.YYYY, HH:MM): [new info]"
- Then include ALL existing content below unchanged
- EXCEPTION: If the user says content is FALSE/WRONG and must be REMOVED — remove that specific false content, add an update note explaining the removal, keep all OTHER content
- Write in the same language as the existing content

Return ONLY this JSON (no markdown, no explanation):
{
  "intent": "update",
  "newTitle": "Updated title reflecting current state (max ~15 words). Keep the original title if it still fits: ${JSON.stringify(task.title)}",
  "newSummary": "The COMPLETE updated summary with new info at top + ALL existing content below",
  "changeDescription": "Brief description of what changed based on the user's message"
}`;
        const updateResponse = await preSession.sendAndWait({ prompt: updateOnlyPrompt }, 30000);
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

    session = trackSession(await client.createSession({}));

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
  "newSummary": "IMPORTANT: By default, keep ALL existing summary content and ADD new information at the top using '📌 Update (DD.MM.YYYY, HH:MM): ...'. EXCEPTION: If the user explicitly states that specific content is FALSE, WRONG, or must be REMOVED — then REMOVE that specific false content from the summary and title, add an update note explaining what was removed and why, and keep all OTHER content intact.",
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

        // For update: update both title and summary, log changes
        if (result.intent === 'update') {
          const newTitle = result.newTitle ? String(result.newTitle).trim() : null;
          const newSummary = result.newSummary ? String(result.newSummary).trim() : null;
          const changeDescription = result.changeDescription || '';

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
      mcpServers: {
        workiq: { type: 'stdio', command: 'workiq', args: ['mcp'], tools: '*' }
      }
    }));

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
        evalSession = trackSession(await evalClient.createSession({}));

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
   - Example: "Please prepare slides by Friday" → "Slides submitted — awaiting review from Jawad"
   - Be decisive: if the search reveals a changed situation, the title MUST change.
   - Keep it concise: max 15 words, factual, no emojis.

2. SUMMARY evaluation — maintain REVERSE CHRONOLOGICAL structure:
   The summary MUST follow this structure:
   - NEWEST updates at the TOP, each with a timestamp marker: "📌 Update (DD.MM.YYYY, HH:MM): ..."
   - OLDER updates below, also with timestamp markers
   - The ORIGINAL base summary at the BOTTOM
   - Each update is separated by a blank line

   Rules:
   - When NEW information is found (new replies, status changes, decisions), add it as a NEW update at the TOP with today's timestamp: "📌 Update (${formatUpdateTimestamp(new Date())}): ..."
   - If the user explicitly asked to update the summary, integrate the search results even if some information already exists — add timestamps, new details, or restructure.
   - Preserve ALL existing updates and the base summary — do NOT drop any information.
   - You may MERGE or DEDUPLICATE genuinely redundant updates, but never silently remove information.
   - If existing updates already have timestamps, keep them. If they lack timestamps, leave them without rather than guessing.
   - Only skip summary changes if the search returned zero results AND the user did NOT explicitly request an update.
   - Write in the SAME language as the existing content.

3. Only set *Changed to true when there is a GENUINE reason to update. An explicit user request to update IS a genuine reason.

Return ONLY valid JSON, no markdown:
{
  "titleChanged": true or false,
  "newTitle": "new title text (only if titleChanged is true, otherwise omit)",
  "summaryChanged": true or false,
  "newSummary": "full updated summary text (only if summaryChanged is true, otherwise omit)",
  "reasoning": "One sentence explaining why changes were or were not needed"
}`;

        const evalResponse = await evalSession.sendAndWait({ prompt: evalPrompt }, 30000);
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

  let client, session;
  try {
    client = new CopilotClient();
    session = trackSession(await client.createSession({
      mcpServers: {
        workiq: {
          type: 'stdio',
          command: 'workiq',
          args: ['mcp'],
          tools: '*'
        }
      }
    }));

    const reviewPrompt = `You are an intelligent assistant for a task management app. The user is responding to review questions that the agent flagged as uncertain during content enrichment.

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
  "updatedSummary": "The complete updated summary incorporating the user's clarifications AND your research findings. Write in the same language as the current summary. If no changes needed, return null.",
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
      mcpServers: {
        workiq: {
          type: 'stdio',
          command: 'workiq',
          args: ['mcp'],
          tools: '*'
        }
      }
    }));

    const taskDate = task.date || task.createdAt || '';
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

app.listen(PORT, 'localhost', () => {
  console.log(`Agent Zero running at http://localhost:${PORT}`);
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
