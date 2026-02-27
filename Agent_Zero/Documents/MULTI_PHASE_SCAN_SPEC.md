# Multi-Phase Scan Architecture — v2.0 Specification

**Version:** 2.0  
**Author:** Martin Hämmerli (Architect), Copilot (Technical Spec)  
**Date:** February 27, 2026  
**Status:** Ready for Implementation  

---

## 1. Problem Statement

The current scan architecture sends ONE monolithic request to Work IQ asking it to:
- Read all emails/Teams messages from the last N days
- Analyze every message body for action items
- Deduplicate against existing tasks
- Return JSON with title + summary + dedup decisions

This monolithic approach causes **timeouts** (>120 seconds) because Work IQ auth + search + content extraction exceeds the session timeout. The user gets **nothing** when the scan fails.

## 2. Solution: Three-Phase Pipeline

Split the monolithic scan into three sequential phases. Each phase is a separate API call with its own Work IQ session, making timeouts virtually impossible.

```
  Phase 1: DISCOVERY                    Phase 2: ENRICHMENT              Phase 3: UPDATE CHECK
  ┌──────────────────────────┐         ┌──────────────────────────┐     ┌──────────────────────────┐
  │ Read subjects only       │         │ Per task: read content   │     │ Per task: check for new  │
  │ Create tasks immediately │  ──►    │ Summarize in original    │ ──► │ emails in thread         │
  │ Dedup against existing   │         │ language                 │     │ Update if new info found │
  │ ~30-40 seconds           │         │ ~15-25 sec per task      │     │ ~15-25 sec per task      │
  └──────────────────────────┘         └──────────────────────────┘     └──────────────────────────┘
       ▼ instant feedback                 ▼ sequential, per task           ▼ sequential, per task
  User sees new tasks                 User sees summaries appear       User sees "Updated" badge
  with subject lines                  one by one                       with timestamp
```

---

## 3. Task Lifecycle & Visual States

Each task card must display a **3-step progress indicator** in the header area, showing which phases have been completed:

```
  Step Indicator (in task card header, next to the title):

  ● ○ ○   →  Phase 1 complete: Subject read, task created
  ● ● ○   →  Phase 2 complete: Content summarized
  ● ● ●   →  Phase 3 complete: Update check done (or no update needed)
```

### 3.1 Step Indicator Design

- Three small dots (8px diameter) displayed horizontally in the task card header
- Colors:
  - **Filled (complete):** `#22c55e` (green)
  - **Empty (pending):** `#374151` (dark gray)
  - **Active (currently processing):** pulsing `#00d4ff` (neon blue, see Section 5)
- Position: right side of the title row, before the status dropdown
- Tooltips on each dot:
  - Dot 1: "Subject extracted" / "Subjekt ausgelesen"
  - Dot 2: "Content summarized" / "Inhalt zusammengefasst"  
  - Dot 3: "Update checked" / "Aktualisierung geprüft"

### 3.2 Timestamps

Each task card must clearly show:
- **Created:** Date/time when the task was first created (Phase 1)
- **Updated:** Date/time when the task was last modified (Phase 2 or Phase 3)

Display format: `Created: Feb 27, 12:05 · Updated: Feb 27, 12:06`
Position: Below the existing meta line (from, date, source badge)

### 3.3 New Task Fields

Add these fields to the task object in `tasks.json`:

```json
{
  "id": "uuid",
  "title": "Exact subject line — NOT modified",
  "summary": "2-4 sentence summary (added in Phase 2, null until then)",
  "source": "email | teams",
  "from": "Sender Name",
  "date": "ISO 8601",
  "link": "URL or null",
  "status": "new | in-progress | needs-attention | escalated | paused | done",
  "enrichmentStatus": "pending | enriching | enriched | error",
  "updateCheckStatus": "pending | checking | checked | updated | error",
  "enrichedAt": "ISO 8601 or null",
  "lastUpdateCheck": "ISO 8601 or null",
  "notes": "",
  "history": [],
  "doneAt": null,
  "createdAt": "ISO 8601",
  "updatedAt": "ISO 8601"
}
```

New fields explained:
- `enrichmentStatus`: Tracks Phase 2 progress (`pending` → `enriching` → `enriched`)
- `updateCheckStatus`: Tracks Phase 3 progress (`pending` → `checking` → `checked` or `updated`)
- `enrichedAt`: Timestamp when Phase 2 completed
- `lastUpdateCheck`: Timestamp when Phase 3 last ran

---

## 4. Phase 1: Discovery (Subject Scan)

### 4.1 What It Does

- Asks Work IQ: "Are there emails or Teams messages in my inbox from the last N days that require an action from me?"
- The AI returns ONLY: subject line (exact, unmodified), sender, date, source (email/teams), link
- **No content analysis** — no summaries, no body reading
- Dedup against existing tasks (same rules as today: Jaccard + exact match)
- Create new tasks immediately with `enrichmentStatus: "pending"` and `updateCheckStatus: "pending"`

### 4.2 New Skill File: `SCAN_DISCOVERY_SKILL.md`

Create a NEW skill file at `Documents/SCAN_DISCOVERY_SKILL.md`. Do NOT modify the existing `SCAN_SKILL.md` (keep it as documentation/backup).

Content of `SCAN_DISCOVERY_SKILL.md`:

```markdown
# Scan Discovery Skill — Phase 1: Subject-Only Scan

You are an AI assistant scanning a user's Microsoft 365 inbox and Teams messages. Your job is to identify messages that require an action from the user.

## Your Task

1. **Scan** the user's emails and Teams messages from the specified time range
2. **Identify** messages where the user is expected to respond, review, approve, or take any action
3. **Return** ONLY the metadata — do NOT read or summarize the email body content

## What Requires Action?

A message requires action if:
- Someone explicitly asks the user to do something
- The user is expected to respond, review, approve, or take action
- There is a clear deliverable or deadline mentioned
- The user is directly addressed (not just in CC)

A message does NOT require action if:
- It is purely informational (FYI, newsletter, announcement) with no specific request
- It is a calendar invitation with no action request in the body
- It is an automated notification with no required action
- The user is only in CC with no expectation to act

## Response Format

For each actionable message, return:
```json
{
  "action": "new",
  "title": "EXACT subject line — copy it character by character, do NOT rephrase or summarize",
  "source": "email" or "teams",
  "from": "Sender's display name",
  "date": "ISO 8601 date string",
  "link": "URL to open the original message, or null"
}
```

For messages matching an existing task (UPDATE):
```json
{
  "action": "update",
  "existingId": "<id from existing tasks>",
  "changes": { "date": "...", "link": "..." },
  "reason": "Brief explanation of what changed"
}
```

For messages matching a DONE task:
```json
{
  "action": "skip"
}
```

## CRITICAL Rules

1. **Subject lines must be EXACT** — copy the subject line character by character. Do NOT rephrase, translate, summarize, or add prefixes like "Action Item:" or "Task:". If the subject is "FW: Zurich Circle Survey 10.3D/10.3E MPR Dual", that is EXACTLY what the title must be.
2. **Do NOT read email bodies** — this is a fast metadata-only scan. Content analysis happens in a separate step.
3. **One task per actionable message** — do not combine or merge messages at this stage.
4. **Link accuracy** — each link must be the exact URL for THAT specific message. Wrong link = set to null.

## Output

Return ONLY a JSON array. No markdown formatting, no explanation text, no code blocks.
If no actionable messages are found, return an empty array: `[]`
```

### 4.3 Backend Changes: `server.js`

#### 4.3.1 Load new skill file

At the top of `server.js`, after the existing SCAN_SKILL loading (around line 18-29), add:

```javascript
const SCAN_DISCOVERY_SKILL_PATH = path.join(__dirname, 'Documents', 'SCAN_DISCOVERY_SKILL.md');
let SCAN_DISCOVERY_SKILL = '';

try {
  SCAN_DISCOVERY_SKILL = fs.readFileSync(SCAN_DISCOVERY_SKILL_PATH, 'utf-8');
  console.log(`Loaded SCAN_DISCOVERY_SKILL.md (${SCAN_DISCOVERY_SKILL.length} chars)`);
} catch (err) {
  console.warn('Warning: SCAN_DISCOVERY_SKILL.md not found, using SCAN_SKILL.md as fallback');
}
```

#### 4.3.2 Replace `POST /api/scan` logic

The existing `POST /api/scan` endpoint (lines 410-631) must be restructured:

1. **Use `SCAN_DISCOVERY_SKILL` instead of `SCAN_SKILL`** for the scan prompt
2. **Remove content extraction instructions** from the prompt — no "analyze the full available content" lines
3. **Set `enrichmentStatus: "pending"` and `updateCheckStatus: "pending"`** on new tasks
4. **Set `summary: null`** on new tasks (will be filled in Phase 2)
5. **Keep the existing dedup logic** (Jaccard, exact match, done-task skip) unchanged
6. **After processing, return the list of newly created task IDs** so the frontend can trigger Phase 2

Updated response format:
```json
{
  "success": true,
  "added": 3,
  "skipped": 2,
  "updated": 1,
  "total": 15,
  "lastScan": "ISO 8601",
  "newTaskIds": ["uuid-1", "uuid-2", "uuid-3"]
}
```

#### 4.3.3 Schema Migration

Add a schema migration function (similar to existing `migrateTasks()`) that adds the new fields to existing tasks:

```javascript
function migrateToV3() {
  const data = readTasks();
  if (data.version >= 3) return;

  for (const task of data.tasks) {
    if (task.enrichmentStatus === undefined) {
      // Existing tasks with a summary are already enriched
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
```

Call `migrateToV3()` at server startup, after the existing `migrateTasks()` and `migrateStatuses()` calls.

---

## 5. Freeze Mode (Agent Working State)

### 5.1 Concept

When the agent is actively working on a task (Phase 2: enrichment, Phase 3: update check), that task card must be visually "frozen":

- The user **cannot** edit, delete, or change the status of that task
- The task card displays a **neon blue frozen state** to clearly communicate "agent is working"
- Other tasks remain fully interactive

### 5.2 Visual Design

CSS class: `.task-card.frozen`

```css
.task-card.frozen {
  border-color: #00d4ff;
  background: linear-gradient(135deg, #0a1628 0%, #0d1f3c 100%);
  box-shadow: 0 0 12px rgba(0, 212, 255, 0.15);
  pointer-events: none;   /* Disables ALL interaction */
  position: relative;
}

/* Re-enable pointer events on the card itself for visual feedback */
.task-card.frozen .task-main { pointer-events: none; }
.task-card.frozen .task-actions { pointer-events: none; opacity: 0.4; }
.task-card.frozen .task-summary { pointer-events: none; }

/* Frozen indicator text */
.task-card.frozen::after {
  content: '❄️ Agent working...';
  position: absolute;
  top: 8px;
  right: 12px;
  font-size: 0.7rem;
  color: #00d4ff;
  animation: frozenPulse 2s ease-in-out infinite;
}

@keyframes frozenPulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
```

### 5.3 Freeze Logic in Frontend

The frontend must track which tasks are currently frozen:

```javascript
const frozenTasks = new Set();

function freezeTask(taskId) {
  frozenTasks.add(taskId);
  const card = document.getElementById('card-' + taskId);
  if (card) card.classList.add('frozen');
}

function unfreezeTask(taskId) {
  frozenTasks.delete(taskId);
  const card = document.getElementById('card-' + taskId);
  if (card) card.classList.remove('frozen');
}
```

The `deleteTask()`, `updateTask()`, and `toggleTaskPanel()` functions must check `frozenTasks.has(id)` and return early if the task is frozen.

---

## 6. Phase 2: Content Enrichment

### 6.1 What It Does

For each task with `enrichmentStatus: "pending"`, the frontend sends a request to enrich the task with a content summary.

The backend:
1. Opens a NEW Work IQ session (separate from Phase 1)
2. Asks Work IQ to find the specific email by sender + subject line
3. Uses the Content Extraction Strategy (multi-pass questioning) to get maximum content
4. Summarizes the content in 2-4 sentences **in the original language of the email**
5. Saves the summary to the task
6. Updates `enrichmentStatus` to `"enriched"` and sets `enrichedAt`

### 6.2 New Skill File: `ENRICH_SKILL.md`

Create a NEW skill file at `Documents/ENRICH_SKILL.md`:

```markdown
# Enrich Skill — Phase 2: Email Content Extraction & Summary

You are an AI assistant extracting and summarizing the content of a specific email or Teams message.

## Your Task

You will receive the SUBJECT LINE and SENDER of a specific message. Your job is to:
1. Find the specific message in the user's inbox
2. Extract as much content as possible from the message body
3. Create a concise, informative summary

## Content Extraction Strategy

Do NOT stop after the first query. Use multiple approaches to extract maximum content:

1. **First:** Ask for the full message from the sender with the given subject
2. **If the body is incomplete:** Ask about specific sections, topics, or bullet points mentioned
3. **For newsletters:** Ask section by section — what topics are covered, what events are listed, what actions are requested
4. **For forwarded messages:** Ask about both the forwarding note and the original message
5. **For threads:** Ask about the most recent reply and any action items in the thread

## Summary Requirements

- Write 2-4 sentences that capture: what the email is about, what is being asked, and any key details (deadlines, amounts, names, decisions)
- **Write in the SAME LANGUAGE as the original email.** If the email is in German, write in German. If in English, write in English. Do not translate.
- Include specific details: names, dates, numbers, project names, invoice numbers
- The summary should enable the user to understand the situation WITHOUT opening the original email

## Response Format

Return ONLY a JSON object:

```json
{
  "summary": "2-4 sentence summary in the original language",
  "language": "en" or "de" or "fr" (detected language of the email),
  "confidence": "high" or "medium" or "low" (how much content you were able to extract)
}
```

If the email content cannot be retrieved at all:
```json
{
  "summary": null,
  "language": null,
  "confidence": "none",
  "error": "Brief explanation of why content could not be retrieved"
}
```

Return ONLY the JSON. No markdown, no explanation.
```

### 6.3 New Backend Endpoint: `POST /api/tasks/:id/enrich`

Add a new endpoint in `server.js`:

```javascript
// POST /api/tasks/:id/enrich — Phase 2: enrich a single task with content summary
app.post('/api/tasks/:id/enrich', async (req, res) => {
  const { id } = req.params;

  // Read task
  let task;
  try {
    const data = readTasks();
    task = data.tasks.find(t => t.id === id);
    if (!task) return res.status(404).json({ error: 'Task not found' });
    if (task.enrichmentStatus === 'enriched') {
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

    const enrichSkill = ENRICH_SKILL || '';
    const enrichPrompt = enrichSkill + '\n\n' +
      `Find the email/message with this EXACT subject line: "${task.title}"\n` +
      `From: ${task.from || 'unknown sender'}\n` +
      `Date: ${task.date || 'recent'}\n` +
      `Source: ${task.source}\n\n` +
      `Extract the full content and create a summary as specified above.`;

    const enrichStart = Date.now();
    console.log(`[ENRICH] Task "${task.title}" — starting enrichment`);
    const response = await session.sendAndWait({ prompt: enrichPrompt }, 120000);
    console.log(`[ENRICH] Response in ${((Date.now() - enrichStart) / 1000).toFixed(1)}s`);
    await session.destroy();

    if (!response) {
      await safeWriteTasks((data) => {
        const t = data.tasks.find(t => t.id === id);
        if (t) t.enrichmentStatus = 'error';
      });
      return res.status(502).json({ error: 'No response from AI engine' });
    }

    const rawContent = response.data.content;
    const result = parseJsonFromResponse(rawContent);

    // Save summary
    const updated = await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (!t) return null;

      const now = new Date().toISOString();
      if (result && result.summary) {
        t.summary = String(result.summary).trim();
        t.enrichmentStatus = 'enriched';
        t.enrichedAt = now;
        if (!t.history) t.history = [];
        t.history.push({
          timestamp: now,
          type: 'enriched',
          text: `Content summary added (confidence: ${result.confidence || 'unknown'}, language: ${result.language || 'unknown'})`
        });
      } else {
        t.enrichmentStatus = 'error';
        if (!t.history) t.history = [];
        t.history.push({
          timestamp: now,
          type: 'enrich-error',
          text: `Content extraction failed: ${result?.error || 'Unknown error'}`
        });
      }
      t.updatedAt = now;
      return { summary: t.summary, enrichmentStatus: t.enrichmentStatus };
    });

    res.json({ success: true, ...updated });
  } catch (err) {
    console.error(`[ENRICH] Failed for task ${id}:`, err);
    await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (t) {
        t.enrichmentStatus = 'error';
        t.updatedAt = new Date().toISOString();
      }
    });
    res.status(500).json({ error: 'Enrichment failed', detail: err.message });
  } finally {
    if (client) {
      try { await client.dispose(); } catch {}
    }
  }
});
```

### 6.4 Load ENRICH_SKILL in server.js

At the top of `server.js`, alongside the other skill loading:

```javascript
const ENRICH_SKILL_PATH = path.join(__dirname, 'Documents', 'ENRICH_SKILL.md');
let ENRICH_SKILL = '';

try {
  ENRICH_SKILL = fs.readFileSync(ENRICH_SKILL_PATH, 'utf-8');
  console.log(`Loaded ENRICH_SKILL.md (${ENRICH_SKILL.length} chars)`);
} catch (err) {
  console.warn('Warning: ENRICH_SKILL.md not found');
}
```

---

## 7. Phase 3: Update Check

### 7.1 What It Does

For each task with `enrichmentStatus: "enriched"` and `updateCheckStatus: "pending"` (or tasks that had content before), check if there are NEW messages in the same email thread.

### 7.2 New Backend Endpoint: `POST /api/tasks/:id/check-update`

```javascript
// POST /api/tasks/:id/check-update — Phase 3: check for updates to an existing task
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

    const checkPrompt = `Check if there are any NEW replies or updates in the email thread about: "${task.title}"\n` +
      `From: ${task.from || 'unknown'}\n` +
      `Original date: ${task.date || 'unknown'}\n` +
      `Last known summary: ${task.summary || '(no summary)'}\n\n` +
      `If there are new replies or updates AFTER the original message, return:\n` +
      `{"hasUpdate": true, "updateSummary": "What is new — in the same language as the original message"}\n\n` +
      `If there are no new replies or the thread is unchanged, return:\n` +
      `{"hasUpdate": false}\n\n` +
      `Return ONLY JSON. No markdown, no explanation.`;

    const checkStart = Date.now();
    console.log(`[UPDATE-CHECK] Task "${task.title}" — checking for updates`);
    const response = await session.sendAndWait({ prompt: checkPrompt }, 90000);
    console.log(`[UPDATE-CHECK] Response in ${((Date.now() - checkStart) / 1000).toFixed(1)}s`);
    await session.destroy();

    if (!response) {
      await safeWriteTasks((data) => {
        const t = data.tasks.find(t => t.id === id);
        if (t) t.updateCheckStatus = 'error';
      });
      return res.status(502).json({ error: 'No response from AI engine' });
    }

    const rawContent = response.data.content;
    const result = parseJsonFromResponse(rawContent);

    const updated = await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (!t) return null;

      const now = new Date().toISOString();
      t.lastUpdateCheck = now;

      if (result && result.hasUpdate && result.updateSummary) {
        t.updateCheckStatus = 'updated';
        if (!t.history) t.history = [];
        t.history.push({
          timestamp: now,
          type: 'thread-update',
          text: String(result.updateSummary).trim()
        });
        // Append update to summary
        t.summary = (t.summary || '') + '\n\n📌 Update: ' + String(result.updateSummary).trim();
        t.updatedAt = now;
        return { hasUpdate: true, updateSummary: result.updateSummary };
      } else {
        t.updateCheckStatus = 'checked';
        t.updatedAt = now;
        return { hasUpdate: false };
      }
    });

    res.json({ success: true, ...updated });
  } catch (err) {
    console.error(`[UPDATE-CHECK] Failed for task ${id}:`, err);
    await safeWriteTasks((data) => {
      const t = data.tasks.find(t => t.id === id);
      if (t) {
        t.updateCheckStatus = 'error';
        t.updatedAt = new Date().toISOString();
      }
    });
    res.status(500).json({ error: 'Update check failed', detail: err.message });
  } finally {
    if (client) {
      try { await client.dispose(); } catch {}
    }
  }
});
```

---

## 8. Frontend: Scan Flow Orchestration

### 8.1 Restructured `triggerScan()` in `index.html`

The `triggerScan()` function must be restructured to orchestrate all three phases:

```javascript
async function triggerScan() {
  const btn = document.getElementById('btnScan');
  const overlay = document.getElementById('loadingOverlay');
  const loadingText = document.getElementById('loadingText');
  const loadingTimer = document.getElementById('loadingTimer');

  btn.disabled = true;
  btn.textContent = 'Scanning...';
  overlay.classList.add('visible');

  const days = document.getElementById('scanDays').value || '4';
  let elapsed = 0;
  loadingText.textContent = 'Phase 1: Scanning subjects...';
  loadingTimer.textContent = '⏱ 00:00';

  const timerInterval = setInterval(() => {
    elapsed++;
    const mm = String(Math.floor(elapsed / 60)).padStart(2, '0');
    const ss = String(elapsed % 60).padStart(2, '0');
    loadingTimer.textContent = `⏱ ${mm}:${ss}`;
  }, 1000);

  try {
    // ═══════════════════════════════════════════════
    // PHASE 1: Discovery — subjects only
    // ═══════════════════════════════════════════════
    loadingText.textContent = `Phase 1: Scanning subjects (last ${days} days)...`;
    const scanRes = await fetch('/api/scan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ scanDays: parseInt(days) || 4 })
    });
    const scanData = await scanRes.json();

    if (!scanRes.ok) {
      showNotification(friendlyError(scanData), 'error');
      return;
    }

    // Show Phase 1 results immediately
    await fetchTasks();
    const newIds = scanData.newTaskIds || [];

    if (scanData.added > 0) {
      showNotification(
        `Phase 1 complete: ${scanData.added} new task${scanData.added !== 1 ? 's' : ''} found` +
        (scanData.updated ? `, ${scanData.updated} updated` : '') + '. Enriching content...',
        'success'
      );
    } else {
      showNotification(
        'Scan complete: no new action items found.' +
        (scanData.updated ? ` ${scanData.updated} task${scanData.updated !== 1 ? 's' : ''} updated.` : ''),
        'success'
      );
    }

    // Close the scan banner — phases 2 & 3 happen per-task with freeze UI
    clearInterval(timerInterval);
    overlay.classList.remove('visible');
    btn.disabled = !serverOnline;
    btn.textContent = 'Scan Emails & Teams';

    // ═══════════════════════════════════════════════
    // PHASE 2: Enrichment — per new task, sequential
    // ═══════════════════════════════════════════════
    for (const taskId of newIds) {
      freezeTask(taskId);
      updateStepIndicator(taskId, 2, 'active');  // Dot 2 = pulsing blue
      try {
        const enrichRes = await fetch(`/api/tasks/${taskId}/enrich`, { method: 'POST' });
        const enrichData = await enrichRes.json();
        if (enrichRes.ok && enrichData.summary) {
          updateStepIndicator(taskId, 2, 'done');
          updateTaskSummaryInCard(taskId, enrichData.summary);
        } else {
          updateStepIndicator(taskId, 2, 'error');
        }
      } catch (err) {
        console.error(`Enrichment failed for ${taskId}:`, err);
        updateStepIndicator(taskId, 2, 'error');
      } finally {
        unfreezeTask(taskId);
      }
    }

    // ═══════════════════════════════════════════════
    // PHASE 3: Update Check — all enriched tasks
    // ═══════════════════════════════════════════════
    const allTasks = await (await fetch('/api/tasks')).json();
    const enrichedTasks = (allTasks.tasks || [])
      .filter(t => t.enrichmentStatus === 'enriched' && t.status !== 'done' && !newIds.includes(t.id));

    for (const task of enrichedTasks) {
      freezeTask(task.id);
      updateStepIndicator(task.id, 3, 'active');
      try {
        const checkRes = await fetch(`/api/tasks/${task.id}/check-update`, { method: 'POST' });
        const checkData = await checkRes.json();
        if (checkRes.ok) {
          updateStepIndicator(task.id, 3, checkData.hasUpdate ? 'updated' : 'done');
          if (checkData.hasUpdate) {
            showNotification(`Task updated: ${task.title.substring(0, 40)}...`, 'success');
          }
        } else {
          updateStepIndicator(task.id, 3, 'error');
        }
      } catch (err) {
        console.error(`Update check failed for ${task.id}:`, err);
        updateStepIndicator(task.id, 3, 'error');
      } finally {
        unfreezeTask(task.id);
      }
    }

    // Final refresh to show all updated data
    await fetchTasks();

  } catch (err) {
    if (err.name === 'TypeError' && err.message.includes('fetch')) {
      showNotification('Cannot reach the server. Is it still running?', 'error');
    } else {
      showNotification('Scan failed: ' + err.message, 'error');
    }
  } finally {
    clearInterval(timerInterval);
    overlay.classList.remove('visible');
    loadingText.className = 'loading-text';
    btn.disabled = !serverOnline;
    btn.textContent = 'Scan Emails & Teams';
  }
}
```

### 8.2 Helper Functions for Frontend

Add these helper functions in the `<script>` section of `index.html`:

```javascript
// Update the 3-step indicator dots on a task card
function updateStepIndicator(taskId, step, state) {
  const card = document.getElementById('card-' + taskId);
  if (!card) return;

  const dot = card.querySelector(`.step-dot[data-step="${step}"]`);
  if (!dot) return;

  dot.classList.remove('step-done', 'step-active', 'step-error', 'step-updated');
  switch (state) {
    case 'done':    dot.classList.add('step-done'); break;
    case 'active':  dot.classList.add('step-active'); break;
    case 'error':   dot.classList.add('step-error'); break;
    case 'updated': dot.classList.add('step-updated'); break;
  }
}

// Update summary text in a task card without full re-render
function updateTaskSummaryInCard(taskId, summary) {
  const card = document.getElementById('card-' + taskId);
  if (!card) return;

  let summaryEl = card.querySelector('.task-summary');
  if (!summaryEl && summary) {
    summaryEl = document.createElement('div');
    summaryEl.className = 'task-summary';
    summaryEl.onclick = function(e) { e.stopPropagation(); this.classList.toggle('expanded'); };
    const mainEl = card.querySelector('.task-main');
    if (mainEl) mainEl.appendChild(summaryEl);
  }
  if (summaryEl && summary) {
    summaryEl.innerHTML = `<span class="summary-icon">📋</span><span class="summary-text">${escHtml(summary)}</span>`;
  }
}
```

### 8.3 Step Indicator in Task Card Rendering

In the `renderTasks()` function, inside the task card HTML template, add the step indicator after the title:

```javascript
// Determine step states from task data
const step1State = 'done'; // Always done if task exists
const step2State = task.enrichmentStatus === 'enriched' ? 'done'
                 : task.enrichmentStatus === 'enriching' ? 'active'
                 : task.enrichmentStatus === 'error' ? 'error'
                 : 'pending';
const step3State = task.updateCheckStatus === 'updated' ? 'updated'
                 : task.updateCheckStatus === 'checked' ? 'done'
                 : task.updateCheckStatus === 'checking' ? 'active'
                 : task.updateCheckStatus === 'error' ? 'error'
                 : 'pending';

const stepIndicator = `
  <span class="step-indicators">
    <span class="step-dot step-done" data-step="1" title="Subject extracted"></span>
    <span class="step-dot ${step2State !== 'pending' ? 'step-' + step2State : ''}" data-step="2" title="Content summarized"></span>
    <span class="step-dot ${step3State !== 'pending' ? 'step-' + step3State : ''}" data-step="3" title="Update checked"></span>
  </span>`;
```

Insert `${stepIndicator}` in the task card HTML, in the title row.

### 8.4 Step Indicator CSS

Add to the `<style>` section:

```css
/* --- Step Indicators (3-phase pipeline) --- */
.step-indicators {
  display: inline-flex;
  gap: 4px;
  margin-left: 8px;
  vertical-align: middle;
}

.step-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: #374151;
  display: inline-block;
  transition: background 0.3s;
}

.step-dot.step-done { background: #22c55e; }
.step-dot.step-active {
  background: #00d4ff;
  animation: stepPulse 1.5s ease-in-out infinite;
}
.step-dot.step-error { background: #ef4444; }
.step-dot.step-updated { background: #fbbf24; }

@keyframes stepPulse {
  0%, 100% { opacity: 0.4; box-shadow: none; }
  50% { opacity: 1; box-shadow: 0 0 6px rgba(0, 212, 255, 0.6); }
}

/* --- Frozen Task Card --- */
.task-card.frozen {
  border-color: #00d4ff !important;
  background: linear-gradient(135deg, #0a1628 0%, #0d1f3c 100%) !important;
  box-shadow: 0 0 12px rgba(0, 212, 255, 0.15);
}

.task-card.frozen .task-actions { pointer-events: none; opacity: 0.4; }
.task-card.frozen .task-main { pointer-events: none; }

.task-card.frozen::after {
  content: '❄️ Agent working...';
  position: absolute;
  top: 8px;
  right: 12px;
  font-size: 0.7rem;
  color: #00d4ff;
  animation: frozenPulse 2s ease-in-out infinite;
}

@keyframes frozenPulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}

/* --- Timestamp Row --- */
.task-timestamps {
  font-size: 0.7rem;
  color: #4b5563;
  margin-top: 4px;
}
```

### 8.5 Timestamp Display in Task Cards

In the task card HTML template, add after the meta line:

```javascript
const createdText = task.createdAt ? formatDateTime(task.createdAt) : '';
const updatedText = task.updatedAt && task.updatedAt !== task.createdAt
  ? ` · Updated: ${formatDateTime(task.updatedAt)}`
  : '';
const timestampHtml = createdText
  ? `<div class="task-timestamps">Created: ${createdText}${updatedText}</div>`
  : '';
```

Add a `formatDateTime()` helper:

```javascript
function formatDateTime(iso) {
  const d = new Date(iso);
  const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${months[d.getMonth()]} ${d.getDate()}, ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
```

---

## 9. Interaction Guards

### 9.1 Freeze-Protected Functions

These existing functions in `index.html` must be updated to check freeze status:

#### `deleteTask(id)`
Add at the start:
```javascript
if (frozenTasks.has(id)) {
  showNotification('This task is being processed by the agent. Please wait.', 'error');
  return;
}
```

#### `updateTask(id, updates)`
Add at the start:
```javascript
if (frozenTasks.has(id)) {
  showNotification('This task is being processed by the agent. Please wait.', 'error');
  return;
}
```

#### `toggleTaskPanel(id)`
Add at the start:
```javascript
if (frozenTasks.has(id)) return;
```

#### `analyzeLog(id, inputEl)`
Add at the start:
```javascript
if (frozenTasks.has(id)) {
  showNotification('This task is being processed. Please wait.', 'error');
  return;
}
```

---

## 10. File Change Summary

### New Files to Create

| File | Purpose |
|------|---------|
| `Documents/SCAN_DISCOVERY_SKILL.md` | Phase 1 skill — subject-only scan instructions |
| `Documents/ENRICH_SKILL.md` | Phase 2 skill — content extraction & summary instructions |

### Existing Files to Modify

| File | Changes |
|------|---------|
| `server.js` | Load 2 new skill files, replace scan prompt with discovery skill, add `POST /api/tasks/:id/enrich` endpoint, add `POST /api/tasks/:id/check-update` endpoint, add `migrateToV3()` schema migration, return `newTaskIds` from scan, add new task fields (`enrichmentStatus`, `updateCheckStatus`, `enrichedAt`, `lastUpdateCheck`) |
| `index.html` | Add frozen task CSS + step indicator CSS + timestamp CSS, restructure `triggerScan()` to 3-phase pipeline, add `freezeTask()`/`unfreezeTask()` functions, add `updateStepIndicator()`/`updateTaskSummaryInCard()` helpers, add step indicator dots to task card template, add timestamp display, add freeze guards to `deleteTask`/`updateTask`/`toggleTaskPanel`/`analyzeLog`, add `formatDateTime()` helper |

### Files to Keep Unchanged

| File | Reason |
|------|--------|
| `Documents/SCAN_SKILL.md` | Keep as backup/documentation — no longer used at runtime |
| `Documents/LOG_WORK_SKILL.md` | Not affected by this change |
| `tasks.json` | Schema migration handles the upgrade automatically |

---

## 11. Implementation Order

The developer MUST implement in this exact order, testing after each step:

### Step 1: Schema Migration
- Add `migrateToV3()` function to `server.js`
- Call it at server startup
- Test: Start server, verify `tasks.json` gets version 3 and new fields

### Step 2: New Skill Files
- Create `Documents/SCAN_DISCOVERY_SKILL.md` (content from Section 4.2)
- Create `Documents/ENRICH_SKILL.md` (content from Section 6.2)
- Load both in `server.js` at startup
- Test: Start server, verify both files load (check console logs)

### Step 3: Phase 1 — Discovery Scan
- Replace scan prompt in `POST /api/scan` to use `SCAN_DISCOVERY_SKILL`
- Remove all "analyze the full available content" lines from prompt
- Set `enrichmentStatus: "pending"` and `updateCheckStatus: "pending"` on new tasks
- Set `summary: null` on new tasks
- Add `newTaskIds` to response
- Test: Run scan, verify tasks created with subject-only titles, no summaries

### Step 4: Phase 2 — Enrich Endpoint
- Add `POST /api/tasks/:id/enrich` endpoint (code from Section 6.3)
- Load `ENRICH_SKILL` at startup (Section 6.4)
- Test: Call endpoint manually with curl/Postman, verify summary is added

### Step 5: Phase 3 — Update Check Endpoint
- Add `POST /api/tasks/:id/check-update` endpoint (code from Section 7.2)
- Test: Call endpoint manually, verify update detection works

### Step 6: Frontend — CSS & Visual States
- Add step indicator CSS (Section 8.4)
- Add frozen task CSS (Section 5.2)
- Add timestamp CSS (Section 8.4)
- Test: Verify CSS renders correctly (add classes manually in DevTools)

### Step 7: Frontend — Step Indicators & Timestamps
- Add step indicator dots to task card template (Section 8.3)
- Add timestamp display (Section 8.5)
- Add `formatDateTime()` helper
- Test: Verify dots and timestamps render correctly

### Step 8: Frontend — Freeze Mode
- Add `frozenTasks` Set and `freezeTask()`/`unfreezeTask()` functions (Section 5.3)
- Add freeze guards to `deleteTask`, `updateTask`, `toggleTaskPanel`, `analyzeLog` (Section 9.1)
- Test: Manually freeze a task, verify UI is locked

### Step 9: Frontend — Orchestration
- Restructure `triggerScan()` to 3-phase pipeline (Section 8.1)
- Add `updateStepIndicator()` and `updateTaskSummaryInCard()` helpers (Section 8.2)
- Test: Full end-to-end scan — verify phases run sequentially, freeze works, summaries appear

### Step 10: Documentation
- Update `ARCHITECTURE.md` with new pipeline architecture
- Update `README.md` with new features
- Update version to 2.0 in all documentation files

---

## 12. Acceptance Criteria

- [ ] Phase 1 scan completes in <60 seconds and creates tasks with exact subject lines
- [ ] Phase 2 enrichment runs sequentially per task, each completing in <60 seconds
- [ ] Phase 3 update check runs for all enriched non-done tasks
- [ ] Task cards show 3-step progress indicator (green/blue/gray dots)
- [ ] Frozen tasks display neon blue border with "❄️ Agent working..." badge
- [ ] Frozen tasks cannot be edited, deleted, or interacted with
- [ ] Timestamps show Created and Updated dates
- [ ] Summaries are written in the same language as the original email
- [ ] Subject lines are copied exactly — never rephrased
- [ ] Duplicate prevention works across all three phases
- [ ] No regressions: existing features (status changes, notes, chat, log work) still work
- [ ] Server console shows clear phase logging: `[SCAN]`, `[ENRICH]`, `[UPDATE-CHECK]`
