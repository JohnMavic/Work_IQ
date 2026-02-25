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
    if (activeTasks.length > 0) {
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

// POST /api/tasks/:id/log — log work with AI communication search
app.post('/api/tasks/:id/log', async (req, res) => {
  const { id } = req.params;
  const { text } = req.body;

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

    const logPrompt = `The user logged this work on a task:\n` +
      `Task: "${taskContext.title}" (from: ${taskContext.from || 'unknown'}, source: ${taskContext.source})\n` +
      `User says: "${text.trim()}"\n` +
      `Search my recent emails and Teams messages for communications matching this description. ` +
      `Return ONLY a JSON array of found communications with: ` +
      `type ("email" or "teams"), from (string), to (string), date (ISO 8601), ` +
      `summary (1-2 sentences), link (URL string or null). ` +
      `If nothing found, return [].`;

    const response = await session.sendAndWait({ prompt: logPrompt }, 90000);
    await session.destroy();

    if (response) {
      const parsed = parseJsonFromResponse(response.data.content);
      if (Array.isArray(parsed)) {
        communications = parsed;
      }
    }
  } catch (err) {
    console.error('AI communication search failed:', err);
    // Continue without communications — still log the work
  } finally {
    if (client) {
      try { await client.dispose(); } catch {}
    }
  }

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
        communications
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
