import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAIN_WORK_DIR } from './agency-cli.js';
import { prepareBrainWorkDir, runBrain } from './brain-runner.js';
import { renderFactSheetMarkdown } from './factsheet.js';
import { parseMarkers, MARKER_REGEX } from './marker-parser.js';
import { applyMarkerBatch } from './marker-applier.js';
import { filterMarkersThroughGateway, runRealityGateway } from './reality-gateway.js';
import { migrateToV5, writeJsonFileAtomic } from './tasks-v5.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_TASK_CHAT_TIMEOUT_MS = 10 * 60 * 1000;
export const DEFAULT_TASK_CHAT_WORKIQ_LIMIT = 12;
export const DEFAULT_TASKS_FILE = path.join(REPO_ROOT, 'tasks.json');

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
}

function safeFilePart(value) {
  return String(value || 'task')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 80) || 'task';
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function sourceRefsForContext(task) {
  return normalizeArray(task.sourceRefs).map(ref => ({
    id: ref.id,
    type: ref.type || null,
    title: ref.title || '',
    from: ref.from || null,
    date: ref.date || null,
    firstSeenAt: ref.firstSeenAt || null,
    lastSeenAt: ref.lastSeenAt || null,
    sourceTaskId: ref.sourceTaskId || null,
    evidenceText: ref.evidenceText || '',
    link: ref.link ? '[present; existing link omitted, reference by id]' : null
  }));
}

function recentHistory(task) {
  return normalizeArray(task.history).slice(-12).map(entry => ({
    timestamp: entry.timestamp || null,
    type: entry.type || null,
    text: entry.text || '',
    agentResponse: entry.agentResponse || null
  }));
}

function writeTaskChatState({ data, task, taskId, userPrompt, brainWorkDir, runId, now }) {
  const dir = prepareBrainWorkDir(brainWorkDir);
  const factSheetFile = `task-factsheet-${safeFilePart(taskId)}-${safeFilePart(runId)}.md`;
  fs.writeFileSync(path.join(dir, factSheetFile), renderFactSheetMarkdown(task), 'utf8');

  const state = {
    renderedAt: nowIso(now),
    runId,
    scope: {
      taskId,
      allowedTaskIds: [taskId],
      instruction: 'Markers may mutate only this task. Foreign task ids are out of scope.'
    },
    userPrompt,
    task: {
      id: task.id,
      taskType: task.taskType || 'single',
      title: task.title || '',
      status: task.status || '',
      summary: task.summary || '',
      notes: task.notes || '',
      pmStatus: task.pmStatus || null,
      lineItems: normalizeArray(task.lineItems),
      sourceRefs: sourceRefsForContext(task),
      brainState: task.brainState || null,
      recentHistory: recentHistory(task)
    },
    rootReviewQueueForTask: normalizeArray(data.reviewQueue)
      .filter(item => item?.ref === taskId || normalizeArray(task.lineItems).some(line => line.id === item?.ref))
  };

  const stateFile = `task-chat-state-${safeFilePart(taskId)}-${safeFilePart(runId)}.json`;
  fs.writeFileSync(path.join(dir, stateFile), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return {
    brainWorkDir: dir,
    stateFile: path.join(dir, stateFile),
    factSheetFiles: [factSheetFile],
    stateFileName: stateFile
  };
}

function buildTaskChatPrompt({ stateFileName, factSheetFiles, userPrompt, taskId, runId }) {
  return [
    '# Agent Zero Task Chat Brain',
    '',
    'You are answering the user about exactly one Agent Zero task and may optionally propose task updates.',
    'Read the task-scoped JSON state file and the full Fact Sheet file before using tools or emitting markers.',
    '',
    `runId: ${runId}`,
    `taskId: ${taskId}`,
    `stateFile: ./${stateFileName}`,
    `factSheetFiles: ${factSheetFiles.map(name => `./${name}`).join(', ')}`,
    '',
    'Rules:',
    '- You may call WorkIQ when current M365 evidence is needed.',
    '- Answer the user in normal concise text.',
    '- If task state should change, append valid marker lines after the answer.',
    '- Marker lines must use the same grammar as Agency scans and must not be in code fences.',
    '- Markers may only mutate the scoped taskId. Do not create or mutate other tasks.',
    '- PROJECT_UPDATE.pmStatus replaces pmStatus; re-emit entries that should remain.',
    '- pmStatus.userActions is only for actions Martin, the app user, must personally do; use owner:"user" or omit owner there.',
    '- Actions owned by other people must be lineItems or Fact Sheet Open Actions with explicit owner.',
    '- If a user action marked with userMarkedDoneAt is confirmed closed by evidence, omit it from userActions.',
    '- If a user-marked action is still open or reopened, re-emit the same user action id with userMarkedDoneAt:null and evidence.',
    '- Every status, problem, risk, waiting, or user-action change needs evidenceRefIds.',
    '- Unsupported or uncertain changes should be NEEDS_REVIEW, not asserted as state.',
    '',
    'User prompt:',
    userPrompt
  ].join('\n');
}

function chatTextWithoutMarkers(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => !MARKER_REGEX.test(line.trim()))
    .join('\n')
    .trim();
}

function reviewMarkerForScope(taskId, marker, reason) {
  const payload = {
    kind: 'other',
    ref: taskId,
    question: `Task chat held out-of-scope marker (${marker.type}): ${reason}`,
    confidence: 'low'
  };
  return {
    type: 'NEEDS_REVIEW',
    payload,
    raw: `[NEEDS_REVIEW] ${JSON.stringify(payload)}`
  };
}

function lineItemIds(task) {
  return new Set(normalizeArray(task.lineItems).map(item => item.id).filter(Boolean));
}

export function scopeMarkersToTask(markers, task) {
  const scoped = [];
  const held = [];
  const taskId = task.id;
  const allowedLineItemIds = lineItemIds(task);

  for (const marker of normalizeArray(markers)) {
    const payload = marker.payload || {};
    let ok = false;
    let reason = 'marker type is not allowed in task-scoped chat';

    if (['PROJECT_UPDATE', 'FACTSHEET_UPDATE', 'LINEITEM_NEW', 'LINEITEM_UPDATE', 'TASK_UPDATE'].includes(marker.type)) {
      ok = payload.taskId === taskId;
      reason = `marker targets ${payload.taskId || '(none)'}, expected ${taskId}`;
    } else if (marker.type === 'NEEDS_REVIEW') {
      ok = !payload.ref || payload.ref === taskId || allowedLineItemIds.has(payload.ref);
      reason = `review ref ${payload.ref || '(none)'} is outside task ${taskId}`;
    } else if (marker.type === 'SCAN_DONE') {
      ok = true;
    }

    if (ok) scoped.push(marker);
    else {
      held.push({ marker, reason });
      scoped.push(reviewMarkerForScope(taskId, marker, reason));
    }
  }

  return { markers: scoped, held };
}

function appendChatHistory(data, taskId, {
  userText,
  assistantText,
  now,
  jobId = null,
  runId,
  markersParsed,
  markersApplied,
  markersHeld,
  parseErrors,
  durationMs
}) {
  const task = normalizeArray(data.tasks).find(item => item.id === taskId);
  if (!task) return null;
  const ts = nowIso(now);
  task.history = normalizeArray(task.history);
  task.history.push({
    timestamp: ts,
    type: 'update',
    text: userText,
    communications: [],
    agentResponse: assistantText || '(no chat text)',
    agentPlan: {
      intent: 'answer',
      understanding: 'Task-scoped Agency Brain chat',
      confidence: null,
      userConfirmed: true,
      jobId,
      runId
    },
    agentExecution: {
      parsedCount: 0,
      confidence: null,
      answer: assistantText || null,
      searchAttempts: [],
      ambiguities: [],
      durationMs,
      method: 'agency-task-chat-v1',
      markersParsed,
      markersApplied,
      markersHeld,
      parseErrors
    }
  });
  task.activeJob = null;
  task.jobHistory = normalizeArray(task.jobHistory);
  task.jobHistory.push({
    jobId,
    kind: 'log',
    status: 'completed',
    startedAt: null,
    completedAt: ts,
    intent: 'answer',
    runId,
    method: 'agency-task-chat-v1'
  });
  if (task.jobHistory.length > 20) task.jobHistory.shift();
  task.updatedAt = ts;
  return task;
}

export async function runTaskChatOnce(job, {
  tasksFile = DEFAULT_TASKS_FILE,
  brainWorkDir = BRAIN_WORK_DIR,
  now = new Date(),
  runId = `task-chat-${Date.now()}`,
  _readJsonFile = readJsonFile,
  _writeJsonFileAtomic = writeJsonFileAtomic,
  _runBrain = runBrain,
  _runGateway = runRealityGateway,
  _parseMarkers = parseMarkers,
  _applyMarkerBatch = applyMarkerBatch
} = {}) {
  const startedAt = Date.now();
  const taskId = job?.taskId;
  const userPrompt = String(job?.input?.text || '').trim();
  if (!taskId) throw new Error('runTaskChatOnce requires job.taskId');
  if (!userPrompt) throw new Error('runTaskChatOnce requires job.input.text');

  job?.emit?.('job.phase_changed', { phase: 'brain_prepare', taskId });
  const beforeData = migrateToV5(_readJsonFile(tasksFile));
  const task = normalizeArray(beforeData.tasks).find(item => item.id === taskId);
  if (!task) throw new Error('Task not found');

  const state = writeTaskChatState({ data: beforeData, task, taskId, userPrompt, brainWorkDir, runId, now });
  const prompt = buildTaskChatPrompt({
    stateFileName: state.stateFileName,
    factSheetFiles: state.factSheetFiles,
    userPrompt,
    taskId,
    runId
  });

  job?.emit?.('job.phase_changed', { phase: 'brain_run', taskId });
  const brainResult = await _runBrain({
    prompt,
    brainWorkDir: state.brainWorkDir,
    timeoutMs: DEFAULT_TASK_CHAT_TIMEOUT_MS,
    workIqHardLimit: DEFAULT_TASK_CHAT_WORKIQ_LIMIT,
    cleanBrainWorkDir: false
  });
  if (!brainResult.ok) {
    throw new Error(brainResult.error?.message || 'Task chat brain run failed');
  }

  const assistantText = brainResult.assistantText || brainResult.text || '';
  const parsed = _parseMarkers(assistantText);
  const chatText = chatTextWithoutMarkers(assistantText);

  if (!parsed.markers.length && !chatText) {
    throw new Error(parsed.errors.length ? 'Task chat output had no valid markers or answer text' : 'Task chat output was empty');
  }

  let afterData = beforeData;
  let applyResult = { applied: 0, dropped: [] };
  let gatewayFilter = { held: [], approved: [], gatewayParsed: true, gatewayParseError: null };
  let scoped = { markers: [], held: [] };

  if (parsed.markers.length) {
    scoped = scopeMarkersToTask(parsed.markers, task);
    job?.emit?.('job.phase_changed', { phase: 'brain_gateway', taskId, markers: scoped.markers.length });
    const gatewayResult = await _runGateway({
      stateFile: state.stateFile,
      factSheetFiles: state.factSheetFiles,
      markers: scoped.markers,
      brainWorkDir: state.brainWorkDir,
      runId
    });
    gatewayFilter = filterMarkersThroughGateway(scoped.markers, gatewayResult);
    applyResult = _applyMarkerBatch(beforeData, gatewayFilter.markers, {
      now,
      runId,
      auditLogFile: null
    });
    afterData = applyResult.data;
  }

  const finalTask = appendChatHistory(afterData, taskId, {
    userText: userPrompt,
    assistantText: chatText || 'Task updated.',
    now,
    jobId: job?.id || null,
    runId,
    markersParsed: parsed.markers.length,
    markersApplied: applyResult.applied,
    markersHeld: gatewayFilter.held.length + scoped.held.length,
    parseErrors: parsed.errors,
    durationMs: Date.now() - startedAt
  });
  if (!finalTask) throw new Error('Task was deleted before final write');

  _writeJsonFileAtomic(tasksFile, afterData);

  return {
    task: finalTask,
    assistantText: chatText,
    markersParsed: parsed.markers.length,
    markersApplied: applyResult.applied,
    markersDropped: applyResult.dropped,
    markersHeld: gatewayFilter.held.length + scoped.held.length,
    scopeHeld: scoped.held.length,
    parseErrors: parsed.errors,
    gateway: {
      approvedMarkers: gatewayFilter.approved.length,
      heldMarkers: gatewayFilter.held.length,
      parsed: gatewayFilter.gatewayParsed,
      parseError: gatewayFilter.gatewayParseError
    }
  };
}
