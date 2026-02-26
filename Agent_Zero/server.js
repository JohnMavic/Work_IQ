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

// --- Load Skill Files (v1.3) ---

const SCAN_SKILL_PATH = path.join(__dirname, 'Documents', 'SCAN_SKILL.md');
const LOG_WORK_SKILL_PATH = path.join(__dirname, 'Documents', 'LOG_WORK_SKILL.md');

let SCAN_SKILL = '';
let LOG_WORK_SKILL = '';

try {
  SCAN_SKILL = fs.readFileSync(SCAN_SKILL_PATH, 'utf-8');
  console.log(`Loaded SCAN_SKILL.md (${SCAN_SKILL.length} chars)`);
} catch (err) {
  console.warn('Warning: SCAN_SKILL.md not found, using minimal scan prompt');
}

try {
  LOG_WORK_SKILL = fs.readFileSync(LOG_WORK_SKILL_PATH, 'utf-8');
  console.log(`Loaded LOG_WORK_SKILL.md (${LOG_WORK_SKILL.length} chars)`);
} catch (err) {
  console.warn('Warning: LOG_WORK_SKILL.md not found, using minimal log prompt');
}

app.use(express.json());

// Serve index.html at root
app.get('/', (req, res) => {
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
  writePromise = writePromise.then(() => {
    const data = readTasks();
    const result = mutationFn(data);
    writeTasks(data);
    return result;
  });
  return writePromise;
}

// --- Dedup Helpers (v1.3) ---

function normalizeForCompare(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function isSimilarTitle(a, b) {
  const wordsA = new Set(normalizeForCompare(a).split(' ').filter(Boolean));
  const wordsB = new Set(normalizeForCompare(b).split(' ').filter(Boolean));
  if (wordsA.size === 0 || wordsB.size === 0) return false;
  const intersection = [...wordsA].filter(w => wordsB.has(w)).length;
  const union = new Set([...wordsA, ...wordsB]).size;
  return (intersection / union) > 0.7;
}

// --- Keyword Extraction for Log Analysis Fallback (v1.4) ---

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
        source: 'manual',
        from: null,
        date: null,
        link: null,
        status: 'new',
        notes: notes ? notes.trim() : '',
        history: [{ timestamp: now, type: 'created', text: 'Task created manually' }],
        doneAt: null,
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

    const validStatuses = ['new', 'needs-attention', 'escalated', 'in-progress', 'done', 'paused'];
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

      const allowedFields = ['status', 'notes', 'title'];
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

      // Protect system entries — only "update" and "note" types can be deleted
      if (entry.type !== 'update' && entry.type !== 'note') return 'protected';

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
  let client;
  const scanDays = Math.min(14, Math.max(1, parseInt(req.body?.scanDays) || 4));
  try {
    client = new CopilotClient();
    const session = await client.createSession({
      mcpServers: {
        workiq: {
          type: 'stdio',
          command: 'workiq',
          args: ['mcp'],
          tools: '*'
        }
      }
    });

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
    if (SCAN_SKILL && allContextTasks.length > 0) {
      scanPrompt = SCAN_SKILL + `\n\n` +
        `EXISTING TASKS (active and done — do NOT re-create done tasks):\n` +
        JSON.stringify(allContextTasks) + `\n\n` +
        `Scan my emails and Teams messages from the ${daysText}.\n` +
        `For each action item found, decide: action "update" (with existingId) or "new".\n` +
        `If a found item matches a DONE task, use action "skip" — do NOT create it again.`;
    } else if (SCAN_SKILL) {
      scanPrompt = SCAN_SKILL + `\n\n` +
        `There are no existing tasks yet.\n\n` +
        `Scan my emails and Teams messages from the ${daysText}.\n` +
        `For each action item found, return with action "new".`;
    } else if (allContextTasks.length > 0) {
      // Fallback: no skill file, use inline prompt (backward-compat)
      scanPrompt = `I have these EXISTING action items (do NOT re-create done ones):\n` +
        JSON.stringify(allContextTasks) + `\n\n` +
        `Scan my emails and Teams messages from the ${daysText}. ` +
        `For each message that contains an action item assigned to me or expected from me:\n\n` +
        `1. Check if it matches an existing task above (same topic/request, even if worded differently or from a different channel/sender).\n` +
        `   - If it matches a DONE task: skip it entirely — do NOT return it.\n` +
        `   - If it matches an active/in-progress task: return {"action":"update","existingId":"<id>","changes":{...},"reason":"<why>"}\n` +
        `     Only include fields in "changes" that actually changed (title, date, link). Do NOT include "from" or "source" in changes.\n` +
        `   - If NO match: return {"action":"new","title":"...","source":"email" or "teams","from":"...","date":"...","link":"..."}\n\n` +
        `Return ONLY a JSON array. No markdown, no explanation.\n` +
        `If no action items found, return [].`;
    } else {
      scanPrompt = `Scan my emails and Teams messages from the ${daysText}. ` +
        `For each message that contains an action item assigned to me or expected from me, ` +
        `return ONLY a JSON array (no markdown, no explanation) with objects containing: ` +
        `action (always "new"), title (string), source ("email" or "teams"), from (sender name string), ` +
        `date (ISO 8601 string), and link (message URL or deep link string, or null if unavailable). ` +
        `If there are no action items, return an empty array [].`;
    }

    const response = await session.sendAndWait({ prompt: scanPrompt }, 120000);
    await session.destroy();

    if (!response) {
      return res.status(502).json({ error: 'No response from AI engine' });
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
              t.title === titleNorm && t.from === fromNorm && t.source === sourceNorm
            );
          }
          if (existing) {
            skipped++;
            continue;
          }
        }

        // Safety-Net: Jaccard word similarity check against ALL existing tasks
        const similarTask = data.tasks.find(t => isSimilarTitle(t.title, titleNorm));
        if (similarTask) {
          console.warn(`Safety-Net dedup: "${titleNorm}" is similar to existing "${similarTask.title}", skipping`);
          skipped++;
          continue;
        }

        // Create new task
        const task = {
          id: uuidv4(),
          title: titleNorm,
          source: sourceNorm,
          from: fromNorm,
          date: item.date || null,
          link: item.link ? String(item.link).trim() : null,
          status: 'new',
          notes: '',
          history: [{ timestamp: now, type: 'created', text: `Task created from ${sourceNorm} scan` }],
          doneAt: null,
          createdAt: now,
          updatedAt: now
        };

        data.tasks.push(task);
        added++;
      }

      data.lastScan = now;
      return { added, skipped, updated, total: data.tasks.length, lastScan: now };
    });

    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Scan failed:', err);
    res.status(500).json({ error: 'Scan failed', detail: err.message });
  } finally {
    if (client) {
      try { await client.dispose(); } catch {}
    }
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
  let client;
  try {
    client = new CopilotClient();
    const session = await client.createSession({});  // No MCP servers → AI reasoning only

    const analyzePrompt = `You are an intelligent assistant for a task management app. Analyze the user's message and determine the correct intent.

TASK:
Title: "${task.title}"
From: ${task.from || 'unknown'}
Source: ${task.source}
Date: ${taskDate}

RECENT CONVERSATION:
${recentHistory || '(no prior conversation)'}

USER'S MESSAGE:
"${text.trim()}"

STEP 1: Determine the INTENT. Choose exactly one:
- "summarize" — user provided text/content and wants you to summarize or extract key points. The content to summarize is IN the message itself.
- "search" — user wants you to FIND emails, Teams messages, or communications. Requires Work IQ search.
- "answer" — user asks a question that you can answer from the task context, the provided text, or general knowledge. No search needed.

STEP 2: Return JSON based on intent.

If intent is "summarize":
{
  "intent": "summarize",
  "result": "Your clear, structured summary of the content the user provided. Use bullet points for action items. Write in the same language as the user's message."
}

If intent is "answer":
{
  "intent": "answer",
  "result": "Your direct answer to the user's question, based on task context and conversation history. Write in the same language as the user's message."
}

If intent is "search":
{
  "intent": "search",
  "understanding": "A clear action plan: what you will search, where, and what you expect to find. Use 'I will...' or 'Ich werde...'",
  "searchFrom": "WHO to search for — a person name, email domain, or null if searching by topic only",
  "keywords": ["specific", "search", "terms — only used if searchFrom is null"],
  "timeWindow": {
    "from": "ISO date string",
    "to": "ISO date string or 'now'",
    "reasoning": "why this time window"
  },
  "searchTargets": "inbox, sent, teams, or all",
  "needsClarification": false,
  "clarificationQuestion": null
}

RULES:
- If the user pastes a long email/text and says "fasse zusammen", "summarize", "was steht da", "key points" → intent is "summarize"
- If the user asks "was hat X geschrieben", "find emails from", "check my inbox" → intent is "search"
- If the user asks "bis wann muss ich", "what's the deadline", "who is responsible" and the answer is in the task context → intent is "answer"
- For "search" intent: ALWAYS include the task date as start date.
- For "summarize"/"answer": provide the result IMMEDIATELY — the user should not need to click Execute.
- Write in the same language as the user's message (German → German, English → English)
- If the search intent is unclear → set needsClarification to true

CRITICAL RULES FOR searchFrom:
- Think about WHO sends the relevant emails. The task "from" field and the user's message give you clues.
- If the task is from a company (e.g. "zones.com", "Wipro", "Cyviz") → set searchFrom to the company domain (e.g. "zones.com", "wipro.com", "cyviz.com")
- If the task mentions a specific person → set searchFrom to that person's name
- If the user says "search for emails from zones" or "von zones.com" → set searchFrom to "zones.com"
- If neither a person nor company is identifiable → set searchFrom to null and use keywords instead
- NEVER put company names or domains in the keywords array — they belong in searchFrom

Return ONLY the JSON object. No markdown, no explanation.`;

    const response = await session.sendAndWait({ prompt: analyzePrompt }, 30000);
    await session.destroy();

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
    if (client) {
      try { await client.dispose(); } catch {}
    }
  }
});

// POST /api/tasks/:id/log — log work with AI communication search
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

  // AI communication search
  let communications = [];
  let rawResponseText = null;
  let promptContext = null;
  let searchError = null;
  let searchMethod = 'none';
  const searchStartTime = Date.now();

  if (plan) {
    // v1.4: Direct workiq ask — same approach proven in Copilot CLI
    // Work IQ IS an AI agent; no need to wrap it in another AI (Copilot SDK)
    searchMethod = 'workiq-ask';
    try {
      const question = buildSearchQuestion(plan, taskContext, text.trim());
      promptContext = question;

      console.log(`[LOG] workiq ask for task "${taskContext.title}" at ${new Date().toISOString()}`);
      console.log(`[LOG] Question: ${question.substring(0, 300)}...`);

      const result = await runWorkIQAsk(question);
      const elapsed = Date.now() - searchStartTime;
      rawResponseText = result.substring(0, 8000);

      console.log(`[LOG] Response received in ${elapsed}ms (${result.length} chars)`);
      console.log(`[LOG] Preview: ${result.substring(0, 300)}...`);

      const parsed = parseJsonFromResponse(result);
      if (Array.isArray(parsed)) {
        communications = parsed;
        console.log(`[LOG] Parsed ${communications.length} communications (JSON)`);
      } else {
        // Try Markdown email parser as fallback
        const mdEmails = parseMarkdownEmails(result);
        if (mdEmails) {
          communications = mdEmails;
          console.log(`[LOG] Parsed ${communications.length} communications (Markdown)`);
        } else {
          console.warn(`[LOG] No structured data parsed — storing natural language response`);
        }
      }
    } catch (err) {
      const elapsed = Date.now() - searchStartTime;
      console.error(`[LOG] workiq ask failed after ${elapsed}ms:`, err.message);
      searchError = err.message;
    }
  } else {
    // Fallback: Copilot SDK + Work IQ MCP (v1.3 behavior, no plan available)
    searchMethod = 'copilot-sdk-mcp';
    let client;
    try {
      console.log(`[LOG] Copilot SDK + MCP for task "${taskContext.title}" at ${new Date().toISOString()}`);

      client = new CopilotClient();
      const session = await client.createSession({
        mcpServers: {
          workiq: { type: 'stdio', command: 'workiq', args: ['mcp'], tools: '*' }
        }
      });

      const taskDate = taskContext.date || taskContext.createdAt || '';

      let logPrompt;
      if (LOG_WORK_SKILL) {
        logPrompt = LOG_WORK_SKILL + `\n\n` +
          `TASK CONTEXT:\n` +
          `Task: "${taskContext.title}"\n` +
          `Original sender: ${taskContext.from || 'unknown'}, Source: ${taskContext.source}, Date: ${taskDate}\n\n` +
          `USER LOG:\n` +
          `"${text.trim()}"\n\n` +
          `Search from ${taskDate} onward.`;
      } else {
        logPrompt = `The user logged work on this task:\n` +
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
      }

      promptContext = `Task: "${taskContext.title}" | From: ${taskContext.from || 'unknown'} | Date: ${taskDate} | User: "${text.trim()}"`;

      console.log(`[LOG] Sending prompt (${logPrompt.length} chars)`);

      const response = await session.sendAndWait({ prompt: logPrompt }, 120000);
      const elapsed = Date.now() - searchStartTime;
      console.log(`[LOG] Response received in ${elapsed}ms`);
      await session.destroy();

      if (response) {
        const rawContent = response.data.content;
        rawResponseText = typeof rawContent === 'string' ? rawContent.substring(0, 2000) : JSON.stringify(rawContent).substring(0, 2000);
        const parsed = parseJsonFromResponse(rawContent);
        if (Array.isArray(parsed)) {
          communications = parsed;
          console.log(`[LOG] Parsed ${communications.length} communications`);
        }
      }
    } catch (err) {
      const elapsed = Date.now() - searchStartTime;
      console.error(`[LOG] Copilot SDK search failed after ${elapsed}ms:`, err.message);
      searchError = err.message;
    } finally {
      if (client) {
        try { await client.dispose(); } catch {}
      }
    }
  }

  const searchDurationMs = Date.now() - searchStartTime;

  // Write the history entry via queue
  try {
    const task = await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (!t) return null;
      if (!t.history) t.history = [];

      const now = new Date().toISOString();
      t.history.push({
        timestamp: now,
        type: 'update',
        text: text.trim(),
        communications,
        agentPlan: plan ? {
          understanding: plan.understanding || '',
          keywords: plan.keywords || [],
          timeWindow: plan.timeWindow || {},
          searchTargets: plan.searchTargets || 'all',
          userConfirmed: true,
          fallback: !!plan.fallback
        } : undefined,
        agentExecution: {
          promptSent: promptContext,
          rawResponse: rawResponseText,
          parsedCount: communications.length,
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
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: 'Failed to log work', detail: err.message });
  }
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

app.listen(PORT, () => {
  console.log(`Agent Zero running at http://localhost:${PORT}`);
});
