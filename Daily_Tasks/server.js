import express from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { CopilotClient } from '@github/copilot-sdk';

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
        status: 'active',
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

    const validStatuses = ['active', 'in-progress', 'done', 'paused'];
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

      // Protect system entries — only "update" type can be deleted
      if (entry.type !== 'update') return 'protected';

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

// POST /api/scan — scan M365 emails and Teams via Copilot SDK + Work IQ
app.post('/api/scan', async (req, res) => {
  let client;
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

    // Build context-aware prompt with existing tasks (v1.3)
    const data = readTasks();
    const activeTasks = data.tasks
      .filter(t => t.status === 'active' || t.status === 'in-progress')
      .sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''))
      .slice(0, 50)
      .map(t => ({ id: t.id, title: t.title, source: t.source, from: t.from }));

    let scanPrompt;
    if (SCAN_SKILL && activeTasks.length > 0) {
      scanPrompt = SCAN_SKILL + `\n\n` +
        `EXISTING TASKS:\n` +
        JSON.stringify(activeTasks) + `\n\n` +
        `Scan my emails and Teams messages from the last 4 days.\n` +
        `For each action item found, decide: action "update" (with existingId) or "new".`;
    } else if (SCAN_SKILL) {
      scanPrompt = SCAN_SKILL + `\n\n` +
        `There are no existing tasks yet.\n\n` +
        `Scan my emails and Teams messages from the last 4 days.\n` +
        `For each action item found, return with action "new".`;
    } else if (activeTasks.length > 0) {
      // Fallback: no skill file, use inline prompt (backward-compat)
      scanPrompt = `I have these EXISTING action items (do NOT re-create them):\n` +
        JSON.stringify(activeTasks) + `\n\n` +
        `Scan my emails and Teams messages from the last 4 days. ` +
        `For each message that contains an action item assigned to me or expected from me:\n\n` +
        `1. Check if it matches an existing task above (same topic/request, even if worded differently or from a different channel/sender).\n` +
        `   - If YES: return {"action":"update","existingId":"<id>","changes":{...},"reason":"<why>"}\n` +
        `     Only include fields in "changes" that actually changed (title, date, link). Do NOT include "from" or "source" in changes.\n` +
        `   - If NO match: return {"action":"new","title":"...","source":"email" or "teams","from":"...","date":"...","link":"..."}\n\n` +
        `Return ONLY a JSON array. No markdown, no explanation.\n` +
        `If no action items found, return [].`;
    } else {
      scanPrompt = `Scan my emails and Teams messages from the last 4 days. ` +
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
          status: 'active',
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

// POST /api/tasks/:id/log/analyze — Phase 1: AI analyzes log request (v1.4)
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

  // Try AI analysis (Copilot SDK without Work IQ — fast, just reasoning)
  let client;
  try {
    client = new CopilotClient();
    const session = await client.createSession({});  // No MCP servers → AI reasoning only

    const analyzePrompt = `You are an assistant that plans communication searches for a task management app. Do NOT search for anything — just analyze and return a structured plan.

TASK:
Title: "${task.title}"
From: ${task.from || 'unknown'}
Source: ${task.source}
Date: ${taskDate}

USER'S LOG TEXT:
"${text.trim()}"

Return a JSON object with this exact structure:
{
  "understanding": "A clear action statement describing WHAT you will do, WHERE you will search, and WHAT you expect to find. Write it as a direct message to the user using 'I will...' or 'Ich werde...'. Example: 'This is about a pending approval for SAP Invoice 5735236948. You asked Eörs how to proceed. I will search your inbox for recent emails from Eörs that mention this invoice number or PO, to find his reply. If I find something, I will summarize it for you.'",
  "keywords": ["specific", "search", "keywords"],
  "timeWindow": {
    "from": "ISO date string to start searching",
    "to": "ISO date string or 'now'",
    "reasoning": "1 sentence explaining why this time window"
  },
  "searchTargets": "inbox, sent, teams, or all",
  "needsClarification": false,
  "clarificationQuestion": null
}

RULES FOR UNDERSTANDING (most important!):
- The "understanding" field is your ACTION PLAN shown to the user before execution
- It must describe: (1) the context/subject of the task, (2) what the user did, (3) exactly what you will search and where, (4) what you will do with the results
- Do NOT just rephrase what the user said — describe your concrete plan of action
- Write in the same language as the user's log text (German → German, English → English)
- End with an implicit confirmation: the user will see this and click "Search" to approve

RULES FOR TIME WINDOW:
- If user says they REACTED to something or sent a reply → search AFTER the task date
- If user asks for background info or additional context → search BEFORE the task date
- If the direction is unclear → set needsClarification to true, ask about time window
- If task date is >30 days old → set needsClarification to true, ask for a narrower range
- "now" means today's date

RULES FOR CLARIFICATION:
- If the log text is too vague to determine search intent → set needsClarification to true
- Ask ONE specific, focused question in clarificationQuestion
- Examples of vague: "worked on this", "stuff", "checked something"
- Examples of clear: "emailed Dave about the invoice", "asked for updates on the PO"

RULES FOR KEYWORDS:
- Extract the most specific terms from the TASK TITLE (invoice numbers, PO numbers, project names, person names)
- Do NOT include generic words like "pending", "approval", "action"
- Include names mentioned in the user's log text

Return ONLY the JSON object. No markdown, no explanation.`;

    const response = await session.sendAndWait({ prompt: analyzePrompt }, 30000);
    await session.destroy();

    if (response) {
      const plan = parseJsonFromResponse(response.data.content);
      if (plan && typeof plan === 'object') {
        return res.json({ plan });
      }
    }

    // AI returned nothing useful → fall through to deterministic fallback
    throw new Error('AI returned no valid plan');
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
    return res.json({ plan, fallback: true });
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
  let client;
  const searchStartTime = Date.now();
  try {
    console.log(`[LOG] Starting Work IQ search for task "${taskContext.title}" at ${new Date().toISOString()}`);

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

    console.log(`[LOG] Session created in ${Date.now() - searchStartTime}ms`);

    const taskDate = taskContext.date || taskContext.createdAt || '';

    let logPrompt;
    if (plan) {
      // v1.4: Lean execution prompt — concrete assignment + output format only
      // The plan already contains the full search strategy; no need for skill file tutorial
      logPrompt = `SEARCH ASSIGNMENT:\n` +
        `Search my ${plan.searchTargets || 'inbox and teams'} for communications about:\n` +
        `"${taskContext.title}"\n` +
        `Related to: ${taskContext.from || 'unknown'} (${taskContext.source})\n\n` +
        `SEARCH PARAMETERS:\n` +
        `- Keywords: ${plan.keywords.join(', ')}\n` +
        `- Time: ${plan.timeWindow.from} to ${plan.timeWindow.to}\n` +
        `- User says: "${text.trim()}"\n\n` +
        `RULES:\n` +
        `- Find the FULL thread: replies (RE:), forwards (FW:), CC responses\n` +
        `- Include messages sent BY the user, not just received\n` +
        `- Summarize each message in 1-2 sentences — actions & decisions, don't copy text\n` +
        `- Order by date, oldest first\n\n` +
        `RETURN FORMAT (JSON array only, no markdown):\n` +
        `[{"type":"email"|"teams","from":"sender","to":"recipients","date":"ISO 8601","summary":"1-2 sentences","link":"URL or null"}]\n` +
        `If nothing found, return [].`;
    } else if (LOG_WORK_SKILL) {
      // v1.3 fallback: skill file without plan
      logPrompt = LOG_WORK_SKILL + `\n\n` +
        `TASK CONTEXT:\n` +
        `Task: "${taskContext.title}"\n` +
        `Original sender: ${taskContext.from || 'unknown'}, Source: ${taskContext.source}, Date: ${taskDate}\n\n` +
        `USER LOG:\n` +
        `"${text.trim()}"\n\n` +
        `Search from ${taskDate} onward.`;
    } else {
      // Fallback: no skill file, inline prompt
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

    // Capture dynamic context for tracing (without skill file boilerplate)
    if (plan) {
      promptContext = `Task: "${taskContext.title}" | Keywords: ${plan.keywords.join(', ')} | Time: ${plan.timeWindow.from} to ${plan.timeWindow.to} | Targets: ${plan.searchTargets} | User: "${text.trim()}"`;
    } else {
      promptContext = `Task: "${taskContext.title}" | From: ${taskContext.from || 'unknown'} | Date: ${taskDate} | User: "${text.trim()}"`;
    }

    console.log(`[LOG] Sending prompt (${logPrompt.length} chars) to Work IQ...`);
    console.log(`[LOG] Dynamic context: ${promptContext}`);

    const response = await session.sendAndWait({ prompt: logPrompt }, 120000);
    const searchDuration = Date.now() - searchStartTime;
    console.log(`[LOG] Response received in ${searchDuration}ms`);
    await session.destroy();

    if (response) {
      const rawContent = response.data.content;
      rawResponseText = typeof rawContent === 'string' ? rawContent.substring(0, 2000) : JSON.stringify(rawContent).substring(0, 2000);
      console.log(`[LOG] Raw response (${typeof rawContent === 'string' ? rawContent.length : 'non-string'} chars): ${rawResponseText.substring(0, 300)}...`);
      const parsed = parseJsonFromResponse(rawContent);
      if (Array.isArray(parsed)) {
        communications = parsed;
        console.log(`[LOG] Parsed ${communications.length} communications`);
      } else {
        console.warn(`[LOG] Response could not be parsed as JSON array`);
      }
    } else {
      console.warn(`[LOG] No response from Work IQ session`);
    }
  } catch (err) {
    const elapsed = Date.now() - searchStartTime;
    console.error(`[LOG] AI communication search failed after ${elapsed}ms:`, err.message);
    console.error(`[LOG] Prompt context was: ${promptContext}`);
    searchError = err.message;
    // Continue without communications — still log the work
  } finally {
    if (client) {
      try { await client.dispose(); } catch {}
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
          durationMs: searchDurationMs
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

// --- Start Server ---

migrateTasks();

app.listen(PORT, () => {
  console.log(`Daily Briefing App running at http://localhost:${PORT}`);
});
