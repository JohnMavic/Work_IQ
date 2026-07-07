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
import { BRAIN_RUN_CLASS } from './brain-scheduler.js';
import { renderBrainLearningsBlock } from './learnings.js';
import {
  DEFAULT_UPLOADS_DIR,
  attachmentContextForPrompt,
  historyAttachmentsFromResolved,
  resolveTaskAttachmentReferences
} from './attachments.js';

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

function setJobPhase(job, phase, payload = {}) {
  if (!job) return;
  job.progress = {
    phase,
    phaseStartedAt: Date.now(),
    currentItemIndex: 0,
    totalItems: 0,
    currentTaskId: job.taskId || null,
    ...payload
  };
  job.emit?.('job.phase_changed', { phase, ...payload });
}

function schedulerProgress(job, phase, payload = {}) {
  return (update) => {
    if (!job || update?.state === 'finished') return;
    const queued = update?.state === 'queued';
    const effectivePhase = queued ? 'queued' : phase;
    job.progress = {
      ...(job.progress || {}),
      phase: effectivePhase,
      phaseStartedAt: update?.startedAt || Date.now(),
      currentTaskId: job.taskId || null,
      queuedAhead: update?.queuedAhead ?? 0,
      runClass: update?.runClass,
      scheduler: update?.scheduler,
      ...payload
    };
    job.emit?.('job.progress', {
      phase: effectivePhase,
      activePhase: phase,
      queuedAhead: update?.queuedAhead ?? 0,
      runClass: update?.runClass,
      schedulerState: update?.state,
      scheduler: update?.scheduler,
      ...payload
    });
  };
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
    agentResponse: entry.agentResponse || null,
    attachments: normalizeArray(entry.attachments).map(attachment => ({
      fileName: attachment.fileName || attachment.storedName || '',
      mimeType: attachment.mimeType || '',
      uploadedAt: attachment.uploadedAt || null
    }))
  }));
}

function writeTaskChatState({ data, task, taskId, userPrompt, attachments, brainWorkDir, runId, now }) {
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
    attachments: attachmentContextForPrompt(attachments),
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

const CHAT_MARKER_GRAMMAR = [
  '[PROJECT_UPDATE] {"taskId":"task-...","summary":"...","pmStatus":{"current":"...","planned":[],"userActions":[],"problems":[],"risks":[],"waitingOn":[],"confidence":"medium"},"sourceRefs":[],"evidenceRefIds":["src-..."]}',
  '[FACTSHEET_UPDATE] {"taskId":"task-...","sectionPatches":{"overview":[{"op":"add","text":"English fact","evidenceRefIds":["src-..."],"confidence":"medium","state":"confirmed","sources":[],"lastConfirmedByMessageDate":"..."}]}}',
  '[LINEITEM_NEW] {"taskId":"task-...","lineItem":{"id":"li-...","title":"...","category":"action","status":"open","owner":"user","userActionRequired":true,"userAction":"...","currentState":"...","confidence":"medium","evidenceRefIds":["src-..."],"state":"confirmed","sources":[],"lastConfirmedByMessageDate":"...","threadRef":"conversation-id","lastVerifiedMessageDate":"...","resolutionStatus":"open","askQuote":{"text":"...","from":"...","date":"...","threadRef":"conversation-id"},"threadCheck":{"coverage":"complete","addressedTo":"user","messageCount":1,"lastMessageDate":"...","checkedThroughMessageDate":"..."}}}',
  '[LINEITEM_UPDATE] {"taskId":"task-...","lineItemId":"li-...","patch":{"status":"waiting","currentState":"...","confidence":"medium","state":"confirmed","sources":[],"lastConfirmedByMessageDate":"..."},"evidenceRefIds":["src-..."]}',
  '[TASK_UPDATE] {"taskId":"task-...","patch":{"status":"in-progress","summary":"...","confidence":"medium"},"sourceRefs":[{"id":"src-...","type":"email|teams|manual","title":"...","date":"...","link":null,"evidenceText":"short factual summary"}],"evidenceRefIds":["src-..."]}',
  '[LEARNING] {"text":"Reusable principle, pattern, or stable general fact.","category":"principle|pattern|fact","evidence":"why this learning is generally valid"}',
  '[NEEDS_REVIEW] {"kind":"assignment|status|other","ref":"taskId|lineItemId|null","question":"...","confidence":"low"}',
  '[SCAN_DONE] {"runId":"...","outcome":"success|partial","workIqCalls":0,"notes":"..."}'
].join('\n');

export function buildTaskChatPrompt({ stateFileName, factSheetFiles, userPrompt, attachments, taskId, runId, learningsBlock = renderBrainLearningsBlock().markdown }) {
  const attachmentContext = attachmentContextForPrompt(attachments);
  const attachmentLines = attachmentContext.length
    ? attachmentContext.map(item => `- ${item.sourceRefId}: ${item.fileName} (${item.mimeType || 'image/*'}, uploaded ${item.uploadedAt || 'unknown date'})`).join('\n')
    : '- none';
  return [
    '# Agent Zero Task Chat Brain',
    '',
    'You are answering the user about exactly one Agent Zero task and may optionally propose task updates.',
    'Read the task-scoped JSON state file and the full Fact Sheet file before using tools or emitting markers.',
    'Always respond and write generated task content in English, regardless of the user prompt language.',
    '',
    `runId: ${runId}`,
    `taskId: ${taskId}`,
    `stateFile: ./${stateFileName}`,
    `factSheetFiles: ${factSheetFiles.map(name => `./${name}`).join(', ')}`,
    '',
    learningsBlock.trimEnd(),
    '',
    'Truth hierarchy for answers and markers:',
    '1. Systems of Record live-checked in the authoritative portal or service.',
    '2. Full verbatim threads or source documents.',
    '3. WorkIQ summaries and search results.',
    '4. The task state file and Fact Sheet.',
    '5. Old summaries, history, and inference.',
    '',
    'For state questions such as approved, open, closed, ticket status, or pending approval, attempt to verify the System of Record when feasible. Use the Edge-CDP pattern from Brain Learnings through shell/browser automation if no direct tool exists. If verification is not possible, explicitly say "unverified via system of record" and do not assert state from notification emails alone.',
    '',
    'Embedded marker grammar short reference. Do not read docs/AGENCY_BRAIN_SCAN_SKILL.md during task chat just to recover grammar:',
    CHAT_MARKER_GRAMMAR,
    '',
    'Image attachments supplied with this user prompt:',
    attachmentLines,
    '',
    'Rules:',
    '- You may call WorkIQ when current M365 evidence is needed.',
    '- Answer the user in normal concise English text.',
    '- If task state should change, append valid marker lines after the answer.',
    '- Marker lines must use the same grammar as Agency scans and must not be in code fences.',
    '- Markers may only mutate the scoped taskId. Do not create or mutate other tasks.',
    '- LEARNING markers may only propose reusable, general operating memory. They must not contain task facts, secrets, credentials, or one-off project state.',
    '- Attached images belong to this user prompt and may be screenshots of mail, plans, or related task evidence.',
    '- If you use information visible only in an attached image for a marker, introduce a sourceRef with type:"manual", the listed sourceRefId, the file name as title, the uploaded date, link:null, and a short English evidenceText.',
    '- Image-derived facts follow every normal rule: assignment checklist, evidence requirements, confidence caps, and gateway verification still apply.',
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
    } else if (marker.type === 'LEARNING') {
      ok = true;
      reason = 'LEARNING markers do not mutate a task';
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
  attachments,
  now,
  jobId = null,
  runId,
  markersParsed,
  markersApplied,
  markersHeld,
  parseErrors,
  confidence,
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
    attachments: historyAttachmentsFromResolved(attachments),
    communications: [],
    agentResponse: assistantText || '(no chat text)',
    agentPlan: {
      intent: 'answer',
      understanding: 'Task-scoped Agency Brain chat',
      confidence,
      userConfirmed: true,
      jobId,
      runId
    },
    agentExecution: {
      parsedCount: 0,
      confidence,
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

function deriveChatConfidence({ markersParsed, markersApplied, markersHeld, markersDropped, parseErrors }) {
  if (normalizeArray(parseErrors).length || markersHeld > 0 || markersDropped > 0) return 'low';
  if (markersParsed > 0 && markersApplied >= markersParsed) return 'high';
  return 'medium';
}

export async function runTaskChatOnce(job, {
  tasksFile = DEFAULT_TASKS_FILE,
  brainWorkDir = BRAIN_WORK_DIR,
  uploadsDir = DEFAULT_UPLOADS_DIR,
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
  const inputAttachments = normalizeArray(job?.input?.attachments);
  const userPrompt = String(job?.input?.text || '').trim()
    || (inputAttachments.length ? 'Please review the attached image(s) for this task.' : '');
  if (!taskId) throw new Error('runTaskChatOnce requires job.taskId');
  if (!userPrompt) throw new Error('runTaskChatOnce requires job.input.text');

  setJobPhase(job, 'brain_prepare', { taskId, agentPhase: 'starting' });
  const beforeData = migrateToV5(_readJsonFile(tasksFile));
  const task = normalizeArray(beforeData.tasks).find(item => item.id === taskId);
  if (!task) throw new Error('Task not found');
  const attachments = resolveTaskAttachmentReferences({
    taskId,
    attachments: inputAttachments,
    uploadsDir
  });

  const state = writeTaskChatState({ data: beforeData, task, taskId, userPrompt, attachments, brainWorkDir, runId, now });
  const prompt = buildTaskChatPrompt({
    stateFileName: state.stateFileName,
    factSheetFiles: state.factSheetFiles,
    userPrompt,
    attachments,
    taskId,
    runId
  });

  setJobPhase(job, 'brain_run', { taskId, agentPhase: 'thinking' });
  const brainResult = await _runBrain({
    prompt,
    brainWorkDir: state.brainWorkDir,
    attachments: attachments.map(attachment => attachment.absolutePath),
    uploadsDir,
    timeoutMs: DEFAULT_TASK_CHAT_TIMEOUT_MS,
    workIqHardLimit: DEFAULT_TASK_CHAT_WORKIQ_LIMIT,
    runClass: BRAIN_RUN_CLASS.INTERACTIVE,
    mcpMode: 'workiq-only',
    schedulerLabel: `task-chat:${taskId}`,
    onSchedulerUpdate: schedulerProgress(job, 'brain_run', { taskId, agentPhase: 'thinking' }),
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
    setJobPhase(job, 'brain_gateway', { taskId, markers: scoped.markers.length, agentPhase: 'checking' });
    const gatewayResult = await _runGateway({
      stateFile: state.stateFile,
      factSheetFiles: state.factSheetFiles,
      markers: scoped.markers,
      brainWorkDir: state.brainWorkDir,
      runId,
      runClass: BRAIN_RUN_CLASS.INTERACTIVE,
      onSchedulerUpdate: schedulerProgress(job, 'brain_gateway', { taskId, agentPhase: 'checking' })
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
    attachments,
    now,
    jobId: job?.id || null,
    runId,
    markersParsed: parsed.markers.length,
    markersApplied: applyResult.applied,
    markersHeld: gatewayFilter.held.length + scoped.held.length,
    parseErrors: parsed.errors,
    confidence: deriveChatConfidence({
      markersParsed: parsed.markers.length,
      markersApplied: applyResult.applied,
      markersHeld: gatewayFilter.held.length + scoped.held.length,
      markersDropped: applyResult.dropped.length,
      parseErrors: parsed.errors
    }),
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
    confidence: finalTask.history.at(-1)?.agentExecution?.confidence || 'medium',
    scopeHeld: scoped.held.length,
    parseErrors: parsed.errors,
    gateway: {
      approvedMarkers: gatewayFilter.approved.length,
      heldMarkers: gatewayFilter.held.length,
      parsed: gatewayFilter.gatewayParsed,
      parseError: gatewayFilter.gatewayParseError,
      skipped: parsed.markers.length === 0
    }
  };
}
