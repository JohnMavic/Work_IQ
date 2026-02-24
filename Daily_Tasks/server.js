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
app.post('/api/tasks', (req, res) => {
  try {
    const { title, notes } = req.body;
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'Title is required' });
    }

    const now = new Date().toISOString();
    const task = {
      id: uuidv4(),
      title: title.trim(),
      source: 'manual',
      from: null,
      date: null,
      link: null,
      status: 'active',
      notes: notes ? notes.trim() : '',
      createdAt: now,
      updatedAt: now
    };

    const data = readTasks();
    data.tasks.push(task);
    writeTasks(data);

    res.status(201).json(task);
  } catch (err) {
    res.status(500).json({ error: 'Failed to create task', detail: err.message });
  }
});

// PATCH /api/tasks/:id — update task status or notes
app.patch('/api/tasks/:id', (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;
    const data = readTasks();
    const task = data.tasks.find(t => t.id === id);

    if (!task) {
      return res.status(404).json({ error: 'Task not found' });
    }

    const validStatuses = ['active', 'in-progress', 'done', 'paused'];
    if (updates.status !== undefined && !validStatuses.includes(updates.status)) {
      return res.status(400).json({ error: `Invalid status. Must be one of: ${validStatuses.join(', ')}` });
    }

    const allowedFields = ['status', 'notes', 'title'];
    for (const field of allowedFields) {
      if (updates[field] !== undefined) {
        task[field] = typeof updates[field] === 'string' ? updates[field].trim() : updates[field];
      }
    }
    task.updatedAt = new Date().toISOString();

    writeTasks(data);
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: 'Failed to update task', detail: err.message });
  }
});

// DELETE /api/tasks/:id — delete a task
app.delete('/api/tasks/:id', (req, res) => {
  try {
    const { id } = req.params;
    const data = readTasks();
    const index = data.tasks.findIndex(t => t.id === id);

    if (index === -1) {
      return res.status(404).json({ error: 'Task not found' });
    }

    data.tasks.splice(index, 1);
    writeTasks(data);
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

    const scanPrompt = `Scan my emails and Teams messages from the last 4 days. ` +
      `For each message that contains an action item assigned to me or expected from me, ` +
      `return ONLY a JSON array (no markdown, no explanation) with objects containing: ` +
      `title (string), source ("email" or "teams"), from (sender name string), ` +
      `date (ISO 8601 string), and link (message URL or deep link string, or null if unavailable). ` +
      `If there are no action items, return an empty array [].`;

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

    // Deduplicate and add new tasks
    const data = readTasks();
    const existingLinks = new Set(
      data.tasks.filter(t => t.link).map(t => t.link)
    );

    const now = new Date().toISOString();
    let added = 0;
    let skipped = 0;

    for (const item of items) {
      if (!item.title) continue;

      // Duplicate detection by link
      if (item.link && existingLinks.has(item.link)) {
        skipped++;
        continue;
      }

      // Fallback duplicate detection for items without a link
      if (!item.link) {
        const titleNorm = String(item.title).trim();
        const fromNorm = item.from ? String(item.from).trim() : null;
        const sourceNorm = item.source === 'teams' ? 'teams' : 'email';
        const isDup = data.tasks.some(t =>
          t.title === titleNorm && t.from === fromNorm && t.source === sourceNorm
        );
        if (isDup) {
          skipped++;
          continue;
        }
      }

      const task = {
        id: uuidv4(),
        title: String(item.title).trim(),
        source: item.source === 'teams' ? 'teams' : 'email',
        from: item.from ? String(item.from).trim() : null,
        date: item.date || null,
        link: item.link ? String(item.link).trim() : null,
        status: 'active',
        notes: '',
        createdAt: now,
        updatedAt: now
      };

      data.tasks.push(task);
      if (task.link) existingLinks.add(task.link);
      added++;
    }

    data.lastScan = now;
    writeTasks(data);

    res.json({
      success: true,
      added,
      skipped,
      total: data.tasks.length,
      lastScan: now
    });
  } catch (err) {
    console.error('Scan failed:', err);
    res.status(500).json({ error: 'Scan failed', detail: err.message });
  } finally {
    if (client) {
      try { await client.dispose(); } catch {}
    }
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

app.listen(PORT, () => {
  console.log(`Daily Briefing App running at http://localhost:${PORT}`);
});
