import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BRAIN_WORK_DIR } from './agency-cli.js';
import { prepareBrainWorkDir, runBrain } from './brain-runner.js';
import { normalizeFactSheet, renderFactSheetMarkdown } from './factsheet.js';
import { parseMarkers, MARKER_REGEX } from './marker-parser.js';
import { applyMarkerBatch } from './marker-applier.js';
import { filterMarkersThroughGateway, runRealityGateway } from './reality-gateway.js';
import { filterMarkersByProcessingQualityGate } from './processing-ledger.js';
import { filterMarkersByTemporalPassGate } from './temporal-pass.js';
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

export const DEFAULT_TASK_CHAT_TIMEOUT_MS = 25 * 60 * 1000;
export const DEFAULT_TASK_CHAT_WORKIQ_LIMIT = 150;
export const DEFAULT_TASK_CHAT_FAST_TIMEOUT_MS = 120 * 1000;
export const DEFAULT_TASK_CHAT_FAST_WORKIQ_LIMIT = 0;
export const DEFAULT_TASK_CHAT_DEEP_TARGET_MS = 25 * 60 * 1000;
export const DEFAULT_TASK_CHAT_DEEP_TIMEOUT_MS = 25 * 60 * 1000;
export const DEFAULT_TASK_CHAT_DEEP_WORKIQ_LIMIT = 150;
export const DEFAULT_TASKS_FILE = path.join(REPO_ROOT, 'tasks.json');
export const DEEP_VERIFY_PREFIX = 'DEEP_VERIFY';
const LEDGER_MUTATION_TYPES = new Set(['PROJECT_NEW', 'PROJECT_UPDATE', 'FACTSHEET_UPDATE', 'LINEITEM_NEW', 'LINEITEM_UPDATE']);

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function taskLearningBlock(task, now) {
  return renderBrainLearningsBlock({
    context: {
      projectTitle: task?.title,
      projectKey: task?.projectKey,
      projectAliases: normalizeArray(task?.projectAliases),
      tools: ['Agency', 'WorkIQ']
    },
    now
  }).markdown;
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

function parseDateMs(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function latestIsoDate(values) {
  let latest = null;
  for (const value of values) {
    const ms = parseDateMs(value);
    if (ms === null) continue;
    if (latest === null || ms > latest) latest = ms;
  }
  return latest === null ? null : new Date(latest).toISOString();
}

function collectFactSheetDates(task) {
  const sections = task?.factSheet?.sections || {};
  const dates = [];
  for (const entries of Object.values(sections)) {
    for (const entry of normalizeArray(entries)) {
      dates.push(entry?.date, entry?.lastConfirmedByMessageDate, entry?.updatedAt);
    }
  }
  return dates;
}

function projectStateLastVerifiedAt(task) {
  const pm = task?.pmStatus || {};
  const pmDates = [
    ...normalizeArray(pm.planned),
    ...normalizeArray(pm.userActions),
    ...normalizeArray(pm.problems),
    ...normalizeArray(pm.risks),
    ...normalizeArray(pm.waitingOn)
  ].flatMap(item => [item?.lastConfirmedByMessageDate, item?.date, item?.updatedAt]);

  return latestIsoDate([
    task?.brainState?.lastEvidenceAt,
    task?.brainState?.lastSynthesizedAt,
    task?.updatedAt,
    ...normalizeArray(task?.sourceRefs).flatMap(ref => [ref?.lastSeenAt, ref?.date, ref?.firstSeenAt]),
    ...normalizeArray(task?.lineItems).flatMap(item => [
      item?.lastVerifiedMessageDate,
      item?.lastConfirmedByMessageDate,
      item?.dueAt,
      item?.updatedAt
    ]),
    ...pmDates,
    ...collectFactSheetDates(task)
  ]);
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
      processing: task.processing || null,
      brainState: task.brainState || null,
      factSheetFile,
      recentHistory: recentHistory(task),
      verificationSummary: {
        projectStateLastVerifiedAt: projectStateLastVerifiedAt(task),
        stateRenderedAt: nowIso(now)
      }
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

function normalizedQuestionText(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

function inferVerificationSystem(normalizedText) {
  if (/\b(approval|approved|approver|invoice|purchase order|po|myapprovals|myorder|freigabe|genehmig|rechnung|bestellung)\b/.test(normalizedText)) {
    return 'MyApprovals';
  }
  if (/\b(inbox|mailbox|e-?mail|mail|teams|m365|microsoft 365|scan|scanne|search|suche|lookup|look up|durchsuch)\b/.test(normalizedText)) {
    return 'Microsoft 365';
  }
  if (/\b(ticket|request|icm|ado|incident|service now|servicenow)\b/.test(normalizedText)) {
    return 'system of record';
  }
  return 'authoritative system';
}

export function inferDeepVerificationRequirement(userPrompt) {
  const normalized = normalizedQuestionText(userPrompt);
  const asksForLookup = /\b(scan|scanne|search|suche|lookup|look up|durchsuch|inbox|mailbox|e-?mail|teams|check|pruf|verify|verifiz|nachsehen|last two weeks|letzten zwei wochen)\b/.test(normalized);
  const asksForState = /\b(approval|approved|approver|pending|open|closed|paid|booked|completed|accepted|rejected|blocked|status|state|action items?|user actions?|invoice|purchase order|po|ticket|request|freigabe|genehmig|offen|erledigt|bezahlt|gebucht|abgeschlossen|angenommen|abgelehnt|blockiert|rechnung|bestellung|antrag|zustand|aktiv werden|muss ich)\b/.test(normalized);

  if (!asksForLookup && !asksForState) {
    return {
      required: false,
      system: 'authoritative system',
      reason: '',
      question: '',
      verifyExactly: []
    };
  }

  const system = inferVerificationSystem(normalized);
  return {
    required: true,
    system,
    reason: asksForLookup
      ? 'The question asks for an inbox, lookup, or live check that Stage 1 must defer.'
      : 'The question asks for current state and requires deep verification beyond project state.',
    question: String(userPrompt || '').trim(),
    verifyExactly: inferVerifyExactlyList(userPrompt, system)
  };
}

function mergeDeepVerificationFlag(flag, inferred) {
  const required = Boolean(flag?.required) || Boolean(inferred?.required);
  const flagVerifyExactly = normalizeVerifyExactly(
    flag?.verifyExactly || flag?.verifyList || flag?.checks,
    flag?.question || ''
  );
  const inferredVerifyExactly = normalizeVerifyExactly(inferred?.verifyExactly, inferred?.question || '');
  if (!required) {
    return {
      required: false,
      system: flag?.system || inferred?.system || 'authoritative system',
      reason: flag?.reason || inferred?.reason || '',
      question: flag?.question || inferred?.question || '',
      verifyExactly: flagVerifyExactly.length ? flagVerifyExactly : inferredVerifyExactly,
      raw: flag?.raw || null
    };
  }

  const flagSystem = String(flag?.system || '').trim();
  const inferredSystem = String(inferred?.system || '').trim();
  const system = flagSystem && flagSystem !== 'authoritative system' ? flagSystem : inferredSystem || flagSystem || 'authoritative system';
  const question = flag?.question || inferred?.question || '';
  return {
    required: true,
    system,
    reason: flag?.reason || inferred?.reason || 'Deep verification is required beyond project state.',
    question,
    verifyExactly: flagVerifyExactly.length
      ? flagVerifyExactly
      : (inferredVerifyExactly.length ? inferredVerifyExactly : inferVerifyExactlyList(question, system)),
    raw: flag?.raw || null
  };
}

function compactText(value, limit = 240) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  return `${text.slice(0, Math.max(0, limit - 3)).trimEnd()}...`;
}

function normalizeVerifyExactly(value, fallbackText = '') {
  const source = Array.isArray(value)
    ? value
    : (typeof value === 'string' && value.trim() ? [value] : []);
  const seen = new Set();
  const items = [];
  for (const item of source) {
    const text = compactText(item, 260);
    if (!text) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(text);
  }
  if (!items.length && fallbackText) {
    const fallback = compactText(fallbackText, 260);
    if (fallback) items.push(fallback);
  }
  return items;
}

function inferVerifyExactlyList(userPrompt, system) {
  const text = compactText(userPrompt, 260);
  if (!text) return [];
  const target = system || 'the authoritative system';
  return [`Answer this exact question in ${target}: ${text}`];
}

function taskNodeText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return compactText(entry.text || entry.title || entry.currentState || entry.status || '', 180);
}

function activeStateEntries(entries) {
  return normalizeArray(entries)
    .filter(entry => entry && typeof entry === 'object')
    .filter(entry => !entry.removedAt && !entry.userMarkedDoneAt)
    .filter(entry => !['done', 'closed', 'resolved', 'obsolete', 'superseded'].includes(String(entry.resolutionStatus || entry.status || '').toLowerCase()))
    .map(taskNodeText)
    .filter(Boolean);
}

function summarizeEntries(label, entries, emptyText) {
  const visible = activeStateEntries(entries).slice(0, 3);
  if (!visible.length) return `${label}: ${emptyText}`;
  return `${label}: ${visible.join('; ')}`;
}

function factSheetFallbackSignals(task) {
  const sheet = normalizeFactSheet(task?.factSheet);
  const sections = sheet.sections || {};
  const sectionOrder = ['status', 'openActions', 'budgetCostsApprovals', 'risksChallenges'];
  const signals = [];
  const seen = new Set();

  for (const sectionId of sectionOrder) {
    for (const entry of normalizeArray(sections[sectionId])) {
      if (!entry || entry.removedAt) continue;
      const text = compactText(entry.text || entry.title || entry.status || '', 160);
      if (!text || seen.has(text)) continue;
      seen.add(text);
      signals.push(text);
      if (signals.length >= 3) return signals;
    }
  }

  return signals;
}

export function buildDeterministicTaskChatFallback({ task, userPrompt, now = new Date(), reason = 'Stage 1 did not return an answer' } = {}) {
  const lastVerified = projectStateLastVerifiedAt(task) || 'unknown';
  const verification = `from project state, last verified ${lastVerified}`;
  const pm = task?.pmStatus || {};
  const inferred = inferDeepVerificationRequirement(userPrompt);
  const flag = {
    required: true,
    system: inferred.system || 'authoritative system',
    reason: inferred.reason || reason,
    question: inferred.question || String(userPrompt || '').trim(),
    verifyExactly: normalizeVerifyExactly(inferred.verifyExactly, inferred.question || String(userPrompt || '').trim())
  };
  const current = compactText(pm.current || task?.summary || task?.title || 'No current project summary is recorded.', 300);
  const factSignals = factSheetFallbackSignals(task);

  const lines = [
    `Current project state: ${current} (${verification}).`,
    `${summarizeEntries('User actions', pm.userActions, 'none recorded')} (${verification}).`,
    `${summarizeEntries('Waiting on', pm.waitingOn, 'none recorded')} (${verification}).`,
    `${summarizeEntries('Problems', pm.problems, 'none recorded')} (${verification}).`,
    `${summarizeEntries('Risks', pm.risks, 'none recorded')} (${verification}).`
  ];

  if (factSignals.length) {
    lines.push(`Fact Sheet signals: ${factSignals.join('; ')} (${verification}).`);
  }

  lines.push(`Deep verification against ${flag.system} started — I will update this conversation.`);

  return {
    assistantText: lines.join('\n'),
    flag
  };
}

export function buildTaskChatFastPrompt({
  stateFileName,
  factSheetFiles,
  userPrompt,
  attachments,
  taskId,
  runId,
  learningsBlock = renderBrainLearningsBlock().markdown
}) {
  const attachmentContext = attachmentContextForPrompt(attachments);
  const attachmentLines = attachmentContext.length
    ? attachmentContext.map(item => `- ${item.sourceRefId}: ${item.fileName} (${item.mimeType || 'image/*'}, uploaded ${item.uploadedAt || 'unknown date'})`).join('\n')
    : '- none';

  return [
    '# Agent Zero Task Chat Fast Answer',
    '',
    'You are the fast first-stage answerer for exactly one Agent Zero task.',
    'Read the task-scoped JSON state file and the full Fact Sheet file before answering.',
    'Always respond in English, regardless of the user prompt language.',
    '',
    `runId: ${runId}`,
    `taskId: ${taskId}`,
    `stateFile: ./${stateFileName}`,
    `factSheetFiles: ${factSheetFiles.map(name => `./${name}`).join(', ')}`,
    '',
    learningsBlock.trimEnd(),
    '',
    'Stage 1 contract:',
    '- Answer immediately from the known task state, Fact Sheet, recent history, and Brain Learnings.',
    '- State-only means no WorkIQ, no Microsoft 365 lookup, no inbox scan, no MCP query, no portal, no CDP, no browser, no shell, and no system-of-record verification in this stage.',
    '- If the user asks for an inbox scan, lookup, live check, current status, approval state, ticket/request/order/invoice state, or says they will scan their inbox, answer only from the project state and require deep verification.',
    '- Do not introduce fresh search findings, inbox signals, or notification-email claims unless they already exist in the state file or Fact Sheet.',
    '- Do not emit Agent Zero marker lines such as [TASK_UPDATE], [PROJECT_UPDATE], [LINEITEM_UPDATE], [NODE_OBSOLETE], [FACTSHEET_UPDATE], [NEEDS_REVIEW], [LEARNING], or [SCAN_DONE].',
    '- Do not propose task mutations in marker form. This stage is answer-only.',
    '',
    'Answer discipline:',
    '- Every factual sentence must carry its verification status inline.',
    '- Facts from the task state or Fact Sheet must say "from project state, last verified <date>" using task.verificationSummary.projectStateLastVerifiedAt when available, otherwise "from project state, last verified unknown".',
    '- Facts from old history, inference, or attachments that are not system-of-record proof must say "signal only — unverified".',
    '- If the user asks whether something is approved, closed, open, paid, booked, completed, pending, blocked, accepted, rejected, or asks for a ticket/request/order/invoice status, give the best state-based answer but require deep verification.',
    '- If deep verification is required, the visible answer must end with exactly: "Deep verification against <system> started — I will update this conversation."',
    '',
    'Machine flag:',
    `- Your final physical line must be ${DEEP_VERIFY_PREFIX} {"required":false} when no deep verification is needed.`,
    `- Your final physical line must be ${DEEP_VERIFY_PREFIX} {"required":true,"system":"<authoritative system>","reason":"<why verification is needed>","question":"<the user question rewritten for verification>","verifyExactly":["specific thing to verify","another specific thing if needed"]}.`,
    '- For required deep verification, verifyExactly must contain 1-6 concrete checks from the user question and task state. Do not write a broad instruction such as "scan everything" or "review all communications".',
    '- The machine flag is not a marker. Do not wrap it in code fences.',
    '',
    'Image attachments supplied with this user prompt:',
    attachmentLines,
    '',
    'User prompt:',
    userPrompt
  ].join('\n');
}

const CHAT_MARKER_GRAMMAR = [
  '[PROJECT_UPDATE] {"taskId":"task-...","summary":"...","pmStatus":{"current":"...","planned":[],"userActions":[],"problems":[],"risks":[],"waitingOn":[],"confidence":"medium"},"sourceRefs":[],"processingLedger":[{"itemRef":{"type":"email","id":"..."},"threadRef":"conversation-id","date":"...","disposition":"updates-node","nodeRefs":["li-..."],"attachmentsHandled":"none|yes|yes(workiq-index)|failed(<reason>)","quote":"short verbatim quote","reason":"why this disposition is correct"}],"evidenceRefIds":["src-..."]}',
  '[FACTSHEET_UPDATE] {"taskId":"task-...","sectionPatches":{"overview":[{"op":"add","text":"English fact","evidenceRefIds":["src-..."],"confidence":"medium","state":"confirmed","sources":[],"lastConfirmedByMessageDate":"..."}]},"processingLedger":[{"itemRef":{"type":"email","id":"..."},"threadRef":"conversation-id","date":"...","disposition":"updates-node","nodeRefs":["fs-..."],"attachmentsHandled":"none","quote":"short verbatim quote","reason":"why this disposition is correct"}]}',
  '[LINEITEM_NEW] {"taskId":"task-...","lineItem":{"id":"li-...","title":"...","category":"action","priority":"critical|high|medium|low","status":"open","owner":"user","userActionRequired":true,"userAction":"...","currentState":"...","plannedNext":null,"dueAt":null,"waitingOn":null,"problem":null,"risk":null,"confidence":"medium","evidenceRefIds":["src-..."],"state":"confirmed","sources":[],"lastConfirmedByMessageDate":"...","threadRef":"conversation-id","lastVerifiedMessageDate":"...","resolutionStatus":"open","askQuote":{"text":"...","from":"...","date":"...","threadRef":"conversation-id"},"threadCheck":{"coverage":"complete","addressedTo":"user","messageCount":1,"lastMessageDate":"...","checkedThroughMessageDate":"..."}},"processingLedger":[{"itemRef":{"type":"email","id":"..."},"threadRef":"conversation-id","date":"...","disposition":"new-node","nodeRefs":["li-..."],"attachmentsHandled":"none","quote":"short verbatim quote","reason":"why this disposition is correct"}]}',
  '[LINEITEM_UPDATE] {"taskId":"task-...","lineItemId":"li-...","patch":{"status":"waiting","currentState":"...","confidence":"medium","state":"confirmed","sources":[],"lastConfirmedByMessageDate":"..."},"processingLedger":[{"itemRef":{"type":"email","id":"..."},"threadRef":"conversation-id","date":"...","disposition":"updates-node","nodeRefs":["li-..."],"attachmentsHandled":"failed(<reason>)","quote":"short verbatim quote","reason":"why this disposition is correct"}],"evidenceRefIds":["src-..."]}',
  '[NODE_OBSOLETE] {"taskId":"task-...","nodeRef":"pmStatus.planned:<id-or-text>|pmStatus.waitingOn:<id-or-text>|li-...","obsoleteReason":"target date passed without completion evidence — needs re-plan","evidenceRefIds":["src-..."]}',
  '[TASK_UPDATE] {"taskId":"task-...","patch":{"status":"in-progress","summary":"...","confidence":"medium"},"sourceRefs":[{"id":"src-...","type":"email|teams|manual","title":"...","date":"...","link":null,"evidenceText":"short factual summary"}],"evidenceRefIds":["src-..."]}',
  '[LEARNING] {"text":"Reusable principle, pattern, or stable general fact.","category":"principle|pattern|fact","evidence":"why this learning is generally valid"}',
  '[NEEDS_REVIEW] {"kind":"assignment|status|other","ref":"taskId|lineItemId|null","question":"...","confidence":"low"}',
  '[SCAN_DONE] {"runId":"...","outcome":"success|partial","workIqCalls":0,"processingQuality":{"required":true,"enumeratedItems":[{"itemRef":{"type":"email","id":"..."},"threadRef":"conversation-id","hasAttachments":false}],"threadCounts":[{"threadRef":"conversation-id","count":1}]},"notes":"..."}'
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
    'Answer discipline:',
    '- Every factual statement in the chat answer must carry its verification status inline in the same sentence: "verified in <system>" when checked in the authoritative system, or "signal only — unverified" when based only on notification mail, WorkIQ summary, old state, or inference.',
    '- Put verified facts first. Put unverified candidates in a clearly separated section labeled as candidates. Never lead with unverified claims as facts.',
    '- For state questions such as approved, open, closed, ticket status, or pending approval: verify first in the System of Record using Brain Learnings patterns, then answer. The unverified hedge is the fallback when verification cannot be completed, not the normal path.',
    '',
    'Embedded marker grammar short reference. Do not read docs/AGENCY_BRAIN_SCAN_SKILL.md during task chat just to recover grammar:',
    CHAT_MARKER_GRAMMAR,
    '',
    'Image attachments supplied with this user prompt:',
    attachmentLines,
    '',
    'Rules:',
    '- You may call WorkIQ when current M365 evidence is needed.',
    '- For update-search requests, discover new M365 communications since the task processing cursor when available, using mail/Teams MCPs preferentially; read full bodies and use targeted WorkIQ attachment-content questions for any relevant PDF, DOCX, or XLSX attachments before proposing updates.',
    '- Attachments are mandatory evidence when present and relevant. WorkIQ can surface attachment contents via the M365 Copilot index; cite concrete attachment-derived facts with an as-of caveat, or fail closed instead of silently ignoring the attachment. If WorkIQ returns content-not-indexed, retry exactly once with an alternative filename versus thread+sender+date formulation, then use attachmentsHandled:"failed(content-not-indexed)" and surface "attachment not indexed yet — re-probe next scan" if still empty.',
    '- External write actions are forbidden unless the user explicitly requested that exact write in this same conversation. Reading, researching, browsing, and evidence collection are unrestricted.',
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
    '- Temporal obsolete/superseded bookings for stale dates must use standalone NODE_OBSOLETE markers, never a bundled PROJECT_UPDATE.pmStatus or LINEITEM_UPDATE.',
    '- Unsupported or uncertain changes should be NEEDS_REVIEW, not asserted as state.',
    '',
    'User prompt:',
    userPrompt
  ].join('\n');
}

export function buildTaskChatDeepVerifyPrompt({
  stateFileName,
  factSheetFiles,
  userPrompt,
  stageOneAnswer = '',
  deepVerification = {},
  attachments,
  taskId,
  runId,
  learningsBlock = renderBrainLearningsBlock().markdown
}) {
  const attachmentContext = attachmentContextForPrompt(attachments);
  const attachmentLines = attachmentContext.length
    ? attachmentContext.map(item => `- ${item.sourceRefId}: ${item.fileName} (${item.mimeType || 'image/*'}, uploaded ${item.uploadedAt || 'unknown date'})`).join('\n')
    : '- none';
  const verifyExactly = normalizeVerifyExactly(
    deepVerification.verifyExactly,
    deepVerification.question || userPrompt
  );
  const verifyExactlyLines = verifyExactly.length
    ? verifyExactly.map((item, index) => `${index + 1}. ${item}`).join('\n')
    : '1. Verify the original user question exactly as written.';
  return [
    '# Agent Zero Task Chat Deep Verification',
    '',
    'You are the background deep-verification agent for one existing Agent Zero task conversation.',
    'Read the task-scoped JSON state file, every Fact Sheet file, and the Brain Learnings before using tools or emitting markers.',
    'Always respond and write generated task content in English, regardless of the user prompt language.',
    '',
    `runId: ${runId}`,
    `taskId: ${taskId}`,
    `stateFile: ./${stateFileName}`,
    `factSheetFiles: ${factSheetFiles.map(name => `./${name}`).join(', ')}`,
    `authoritativeSystem: ${deepVerification.system || 'unknown system'}`,
    `targetDurationMs: ${DEFAULT_TASK_CHAT_DEEP_TARGET_MS}`,
    `hardCapMs: ${DEFAULT_TASK_CHAT_DEEP_TIMEOUT_MS}`,
    `toolEmergencyStop: ${DEFAULT_TASK_CHAT_DEEP_WORKIQ_LIMIT}`,
    '',
    learningsBlock.trimEnd(),
    '',
    'Verify exactly:',
    verifyExactlyLines,
    '',
    'Deep-verification contract:',
    '- Treat the focus list above as a priority hint, not a limit. If the user asked to search for updates, discover all relevant new communications for this task.',
    '- Keep project summary at most 420 characters and pmStatus.current at most 520 characters. Put owner, next step, due date, waiting dependency, problem, risk, and critical|high|medium|low priority in typed line-item fields instead of duplicating chronology.',
    '- For update-search requests, start from task.processing.cursorDate and task.processing.threads when present, use the lookback window, and enumerate newly surfaced mail/Teams items before deciding that nothing changed.',
    '- Prefer mail and Teams MCPs for discovery.',
    '- Mandatory M365 workflow for update-search requests: first enumerate surfaced mail/Teams items, then read full message bodies, then for each surfaced thread ask WorkIQ exactly: "list all attachments of this thread with filenames". After attachment filenames are enumerated, ask a targeted WorkIQ attachment-content question for every PDF, DOCX, XLSX, deck, or other source attachment file by filename. If WorkIQ returns content-not-indexed or empty indexed content, retry exactly once with an alternative formulation such as exact filename versus thread+sender+date, and only then answer or emit markers.',
    '- After attachment content capture, explicitly list all dates, milestones, scope items, quantities, port counts, and names from that attachment. Do not summarize or collapse the list. If the thread has multiple attachments, perform this extraction separately for each attachment filename.',
    '- Do not answer or emit task-state markers from a message that has relevant attachments until the attachment step is complete. If WorkIQ returns concrete attachment-derived facts, use attachmentsHandled:"yes(workiq-index)"; if direct read-only bytes/content were actually read, use "yes"; if the attachment remains unavailable after the one content-not-indexed retry, use attachmentsHandled:"failed(content-not-indexed)", surface "attachment not indexed yet — re-probe next scan", and do not assert attachment-only facts; for other read failures use "failed(<reason>)".',
    '- For every enumerated or processed M365 item, include a processingLedger disposition on the relevant marker with itemRef, threadRef, date, disposition, nodeRefs, attachmentsHandled, quote, and reason. If attachments are enumerated, include each attachment filename and per-file disposition in the ledger item attachments array.',
    '- The final SCAN_DONE for M365 update-search runs must include processingQuality.required:true with every enumerated item and per-thread counts. For enumerated items with attachments, set hasAttachments:true or attachmentCount and attachment filenames. A message with attachments and ledger attachmentsHandled:"none" will be held.',
    '- Enumeration congruence self-check before any marker emission: every enumerated mail/Teams item and every enumerated attachment filename must have a matching ledger disposition. If any item or attachment file lacks a disposition, do not emit task-state mutation markers for that source; emit NEEDS_REVIEW or a no-change/failed ledger disposition instead.',
    '- Temporal pass is mandatory before final output: review task.pmStatus.planned, task.pmStatus.waitingOn, and lineItems for unconfirmed dates before today. For each stale node, either confirm it with fresh evidence or emit a standalone NODE_OBSOLETE marker with an explicit obsoleteReason. If a planned target date has passed and there is no completion evidence, emit NODE_OBSOLETE with obsoleteReason:"target date passed without completion evidence — needs re-plan"; this is not a claim of completion. Temporal bookings must always be standalone NODE_OBSOLETE markers, never bundled into PROJECT_UPDATE.pmStatus or LINEITEM_UPDATE. Use retain for review only when evidence is genuinely contradictory. Do not silently omit stale pmStatus entries from a replacement pmStatus.',
    '- The runner allows the full 25-minute deep window. It warns at 40 tool starts and emergency-stops at 150 tool starts only to prevent loops.',
    '- If the cap is near or reached, answer with what is already verified, what was checked, and which items remain open. Do not assert unsupported state.',
    '- Portal/CDP/browser/shell patterns from Brain Learnings are allowed in this background stage.',
    '- WorkIQ, mail, Teams, browser, and other read/research tools may be used to locate evidence, links, request ids, conversation ids, source documents, or current M365 context.',
    '- External write actions are forbidden unless the user explicitly requested that exact write in this same conversation. Do not send mail, click approvals, or mutate external systems.',
    '- Marker emission is allowed only after verification or a clearly evidenced update.',
    '- The Reality Gateway will review non-exempt markers, so keep marker evidence tight and scoped to this task.',
    '',
    'Truth hierarchy for answers and markers:',
    '1. Systems of Record live-checked in the authoritative portal or service.',
    '2. Full verbatim threads or source documents.',
    '3. WorkIQ summaries and search results.',
    '4. The task state file and Fact Sheet.',
    '5. Old summaries, history, and inference.',
    '',
    'Answer discipline:',
    '- Start with the deep-verification result.',
    '- Every factual statement in the chat answer must carry its verification status inline in the same sentence: "verified in <system>" when checked in the authoritative system, "from project state (last verified <date>)" for state-only facts, or "signal only — unverified" for signals.',
    '- If verification cannot be completed, say what was checked and keep the final state unverified.',
    '',
    'Embedded marker grammar short reference. Do not read docs/AGENCY_BRAIN_SCAN_SKILL.md during task chat just to recover grammar:',
    CHAT_MARKER_GRAMMAR,
    '',
    'Rules:',
    '- Answer the user in normal concise English text.',
    '- If task state should change, append valid marker lines after the answer.',
    '- Marker lines must use the same grammar as Agency scans and must not be in code fences.',
    '- Markers may only mutate the scoped taskId. Do not create or mutate other tasks.',
    '- LEARNING markers may only propose reusable, general operating memory. They must not contain task facts, secrets, credentials, or one-off project state.',
    '- Every status, problem, risk, waiting, or user-action change needs evidenceRefIds.',
    '- Temporal obsolete/superseded bookings for stale dates must use standalone NODE_OBSOLETE markers, never a bundled PROJECT_UPDATE.pmStatus or LINEITEM_UPDATE.',
    '- Unsupported or uncertain changes should be NEEDS_REVIEW, not asserted as state.',
    '',
    'Image attachments supplied with the original user prompt:',
    attachmentLines,
    '',
    'Original user prompt:',
    userPrompt,
    '',
    'Stage 1 answer:',
    stageOneAnswer || '(not available)',
    '',
    'Deep verification reason:',
    deepVerification.reason || '(not specified)'
  ].join('\n');
}

function chatTextWithoutMarkers(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter(line => !MARKER_REGEX.test(line.trim()))
    .join('\n')
    .trim();
}

function parseDeepVerifyPayload(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith(`${DEEP_VERIFY_PREFIX} `)) return null;
  const jsonText = trimmed.slice(DEEP_VERIFY_PREFIX.length).trim();
  try {
    const parsed = JSON.parse(jsonText);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { error: 'deep verification flag payload is not an object' };
    }
    return { payload: parsed };
  } catch (err) {
    return { error: err.message };
  }
}

export function extractDeepVerificationFlag(text) {
  const lines = String(text || '').split(/\r?\n/);
  const visible = [];
  let payload = null;
  const errors = [];

  for (const line of lines) {
    const parsed = parseDeepVerifyPayload(line);
    if (!parsed) {
      visible.push(line);
      continue;
    }
    if (parsed.error) errors.push(parsed.error);
    else payload = parsed.payload;
  }

  const visibleText = visible.join('\n').trim();
  const inferred = visibleText.match(/Deep verification against\s+(.+?)\s+started — I will update this conversation\./i);
  const required = Boolean(payload?.required) || (!payload && Boolean(inferred));
  const system = String(payload?.system || inferred?.[1] || 'authoritative system').trim() || 'authoritative system';
  const question = typeof payload?.question === 'string' ? payload.question.trim() : '';
  const reason = typeof payload?.reason === 'string' ? payload.reason.trim() : '';
  const verifyExactly = normalizeVerifyExactly(
    payload?.verifyExactly || payload?.verifyList || payload?.checks,
    question
  );

  return {
    text: visibleText,
    flag: {
      required,
      system,
      reason,
      question,
      verifyExactly,
      raw: payload || null
    },
    errors
  };
}

function ensureDeepVerificationLine(text, flag) {
  const base = String(text || '').trim();
  if (!flag?.required) return base;
  const system = flag.system || 'authoritative system';
  const line = `Deep verification against ${system} started — I will update this conversation.`;
  if (base.endsWith(line)) return base;
  return `${base}${base ? '\n' : ''}${line}`;
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

    if (['PROJECT_UPDATE', 'FACTSHEET_UPDATE', 'LINEITEM_NEW', 'LINEITEM_UPDATE', 'NODE_OBSOLETE', 'TASK_UPDATE'].includes(marker.type)) {
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
  conversationId = randomUUID(),
  method = 'agency-task-chat-v1',
  deepVerification = null,
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
    conversationId,
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
      runId,
      conversationId
    },
    agentExecution: {
      parsedCount: 0,
      confidence,
      answer: assistantText || null,
      searchAttempts: [],
      ambiguities: [],
      durationMs,
      method,
      markersParsed,
      markersApplied,
      markersHeld,
      parseErrors,
      deepVerification: deepVerification || null
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
    method
  });
  if (task.jobHistory.length > 20) task.jobHistory.shift();
  task.updatedAt = ts;
  return task;
}

function findConversationEntry(task, conversationId) {
  if (!conversationId) return null;
  return normalizeArray(task?.history).find(entry => entry?.conversationId === conversationId) || null;
}

function appendDeepVerificationContribution(data, taskId, {
  conversationId,
  assistantText,
  now,
  jobId = null,
  runId,
  markersParsed = 0,
  markersApplied = 0,
  markersHeld = 0,
  markersDropped = 0,
  parseErrors = [],
  confidence = 'medium',
  durationMs = 0,
  status = 'completed',
  error = null,
  markerProcessingStatus = null
}) {
  const task = normalizeArray(data.tasks).find(item => item.id === taskId);
  if (!task) return null;
  task.history = normalizeArray(task.history);
  const entry = findConversationEntry(task, conversationId);
  if (!entry) return null;
  const ts = nowIso(now);
  entry.agentFollowups = normalizeArray(entry.agentFollowups);
  entry.agentFollowups.push({
    timestamp: ts,
    role: 'agent',
    kind: 'deep-verification',
    text: assistantText || (error ? `Deep verification failed: ${error}` : 'Deep verification completed.'),
    confidence,
    jobId,
    runId,
    status,
    error,
    markersParsed,
    markersApplied,
    markersHeld,
    markersDropped,
    parseErrors,
    durationMs,
    markerProcessingStatus
  });
  entry.agentExecution = entry.agentExecution || {};
  const existing = entry.agentExecution.deepVerification || {};
  entry.agentExecution.deepVerification = {
    ...existing,
    required: true,
    status,
    completedAt: ['completed', 'partial'].includes(status) ? ts : existing.completedAt || null,
    failedAt: status === 'failed' ? ts : existing.failedAt || null,
    jobId: jobId || existing.jobId || null,
    runId: runId || existing.runId || null,
    error,
    markerProcessingStatus: markerProcessingStatus || existing.markerProcessingStatus || null
  };
  task.activeJob = null;
  task.updatedAt = ts;
  return task;
}

export function appendDeepVerificationFailure(data, taskId, {
  conversationId,
  error,
  now = new Date(),
  jobId = null,
  runId = null,
  durationMs = 0
} = {}) {
  return appendDeepVerificationContribution(data, taskId, {
    conversationId,
    assistantText: `Deep verification failed: ${error || 'unknown error'}`,
    now,
    jobId,
    runId,
    durationMs,
    status: 'failed',
    error: error || 'unknown error',
    confidence: 'low'
  });
}

function updateDeepVerificationMarkerStatus(data, taskId, {
  conversationId,
  now = new Date(),
  jobId = null,
  runId = null,
  markersApplied = 0,
  markersHeld = 0,
  markersDropped = 0,
  gateway = null,
  markerProcessingStatus = 'completed',
  error = null
} = {}) {
  const task = normalizeArray(data.tasks).find(item => item.id === taskId);
  if (!task) return null;
  const entry = findConversationEntry(task, conversationId);
  if (!entry) return null;
  entry.agentFollowups = normalizeArray(entry.agentFollowups);
  const followup = [...entry.agentFollowups].reverse().find(item =>
    item?.kind === 'deep-verification'
    && (!jobId || item.jobId === jobId)
    && (!runId || item.runId === runId)
  ) || [...entry.agentFollowups].reverse().find(item => item?.kind === 'deep-verification');
  if (!followup) return null;

  const ts = nowIso(now);
  followup.markersApplied = markersApplied;
  followup.markersHeld = markersHeld;
  followup.markersDropped = markersDropped;
  followup.markerProcessingStatus = markerProcessingStatus;
  followup.markerProcessedAt = ts;
  followup.gateway = gateway;
  if (error) followup.markerProcessingError = error;

  entry.agentExecution = entry.agentExecution || {};
  const existing = entry.agentExecution.deepVerification || {};
  entry.agentExecution.deepVerification = {
    ...existing,
    markerProcessingStatus,
    markerProcessedAt: ts,
    markersApplied,
    markersHeld,
    markersDropped,
    markerProcessingError: error || null
  };
  task.updatedAt = ts;
  return task;
}

function deepVerificationLimitReason(brainResult) {
  if (brainResult?.timedOut) return 'hit the 25-minute hard cap';
  if (brainResult?.killedForToolBudget) return 'hit the 150-tool emergency stop';
  return 'stopped before a complete verified answer was available';
}

function buildDeepVerificationPartialText({
  chatText,
  brainResult,
  deepVerification,
  verifyExactly,
  toolStatuses,
  userPrompt
}) {
  const base = String(chatText || '').trim();
  const system = deepVerification?.system || 'the authoritative system';
  const checked = normalizeVerifyExactly(toolStatuses).slice(-4);
  const openItems = normalizeVerifyExactly(verifyExactly, deepVerification?.question || userPrompt);
  const lines = [];
  if (base) lines.push(base);
  lines.push(`Deep verification ${deepVerificationLimitReason(brainResult)}; this is a partial result, not a new asserted task state.`);
  lines.push(checked.length
    ? `Checked during this run: ${checked.join('; ')}.`
    : `Checked during this run: started targeted verification against ${system}, but no complete verified result was returned.`);
  lines.push(openItems.length
    ? `Still open: ${openItems.join('; ')}.`
    : 'Still open: the original verification question remains unverified.');
  return lines.join('\n');
}

function toolEventTextParts(event) {
  const parts = [
    event?.data?.toolName,
    event?.data?.serverName,
    event?.data?.server,
    event?.data?.name,
    event?.data?.command,
    event?.toolName,
    event?.tool,
    event?.server,
    event?.name
  ];
  return parts.filter(value => typeof value === 'string' && value.trim()).join(' ');
}

function describeDeepVerificationToolStart(event, deepVerification) {
  if (event?.type !== 'tool.execution_start') return '';
  const system = String(deepVerification?.system || '').trim();
  const focusText = normalizeVerifyExactly(deepVerification?.verifyExactly, deepVerification?.question || '').join(' ');
  const haystack = `${toolEventTextParts(event)} ${system} ${focusText}`.toLowerCase();

  if (/\b(myapprovals?|approval|approv|invoice|purchase order|\bpo\b|freigabe|genehmig|rechnung|bestellung)\b/.test(haystack)) {
    return 'Checking MyApprovals...';
  }
  if (/\b(inbox|mailbox|outlook|e-?mail|message)\b/.test(haystack)) {
    return 'Scanning inbox...';
  }
  if (/\bteams?\b/.test(haystack)) {
    return 'Scanning Teams...';
  }
  if (/\b(browser|edge|cdp|portal)\b/.test(haystack)) {
    return system ? `Checking ${system}...` : 'Checking portal...';
  }
  if (/work[_-]?iq/i.test(haystack)) {
    return system && !/microsoft 365/i.test(system) ? `Checking ${system}...` : 'Scanning Microsoft 365...';
  }
  return system ? `Checking ${system}...` : 'Checking authoritative system...';
}

function deriveChatConfidence({ markersParsed, markersApplied, markersHeld, markersDropped, parseErrors }) {
  if (normalizeArray(parseErrors).length || markersHeld > 0 || markersDropped > 0) return 'low';
  if (markersParsed > 0 && markersApplied >= markersParsed) return 'high';
  return 'medium';
}

function isM365DeepVerification(deepVerification = {}, userPrompt = '') {
  const text = [
    deepVerification?.system,
    deepVerification?.reason,
    deepVerification?.question,
    ...normalizeVerifyExactly(deepVerification?.verifyExactly, deepVerification?.question || userPrompt),
    userPrompt
  ].map(value => String(value || '')).join(' ').toLowerCase();
  return /\b(microsoft 365|m365|workiq|inbox|mailbox|outlook|e-?mail|email|teams?|message|thread|attachment|pdf|docx|xlsx|scan|search|lookup|suche|durchsuch)\b/i.test(text);
}

function isLedgerMutationMarker(marker) {
  return LEDGER_MUTATION_TYPES.has(marker?.type);
}

function markerHasProcessingLedger(marker) {
  const payload = marker?.payload || {};
  return normalizeArray(payload.processingLedger).length > 0
    || normalizeArray(payload.processing?.ledger).length > 0;
}

function scanDoneProcessingQuality(markers) {
  return normalizeArray(markers).find(marker => marker?.type === 'SCAN_DONE')?.payload?.processingQuality || null;
}

function holdTaskChatMutationMarkers(qualityGate, markers, reason) {
  const heldIndexes = new Set(normalizeArray(qualityGate.held).map(item => item.index));
  const extraHeld = [];
  normalizeArray(markers).forEach((marker, index) => {
    if (!isLedgerMutationMarker(marker) || heldIndexes.has(index)) return;
    extraHeld.push({
      index,
      marker,
      reason,
      reasons: [reason],
      source: 'task-chat-m365-quality'
    });
    heldIndexes.add(index);
  });
  const held = [...normalizeArray(qualityGate.held), ...extraHeld].sort((a, b) => a.index - b.index);
  const approved = normalizeArray(markers).filter((_, index) => !heldIndexes.has(index));
  return {
    ...qualityGate,
    ok: false,
    reason: qualityGate.reason || reason,
    markers: approved,
    approved,
    held
  };
}

function evaluateTaskChatProcessingQualityGate(markers, {
  deepVerification = {},
  userPrompt = ''
} = {}) {
  const qualityGate = filterMarkersByProcessingQualityGate(markers);

  const projectMutations = normalizeArray(markers).filter(isLedgerMutationMarker);
  if (!projectMutations.length || !isM365DeepVerification(deepVerification, userPrompt)) return qualityGate;

  const processingQuality = scanDoneProcessingQuality(markers);
  const hasRequiredProcessingQuality = Boolean(processingQuality?.required);
  const hasEnumeratedItems = normalizeArray(processingQuality?.enumeratedItems).length > 0;
  const hasLedger = projectMutations.some(markerHasProcessingLedger);
  if (!hasRequiredProcessingQuality || !hasEnumeratedItems || !hasLedger) {
    return holdTaskChatMutationMarkers(
      qualityGate,
      markers,
      'Microsoft 365 deep verification with task mutations requires SCAN_DONE.processingQuality.required, enumeratedItems, and processingLedger dispositions with attachmentsHandled.'
    );
  }

  return qualityGate;
}

function taskScopedData(data, taskId) {
  return {
    ...data,
    tasks: normalizeArray(data?.tasks).filter(task => task?.id === taskId)
  };
}

function addTaskChatGateReviewHint(data, { taskId, now, gateName, reason }) {
  data.reviewQueue = normalizeArray(data.reviewQueue);
  data.reviewQueue.push({
    kind: 'other',
    ref: taskId,
    question: `Task chat deep verification was partially held by the ${gateName}: ${reason}`,
    confidence: 'low',
    createdAt: nowIso(now)
  });
}

function addTaskChatQualityGateReviewHints(data, { taskId, now, qualityGate }) {
  const reasons = [
    ...normalizeArray(qualityGate?.held).map(item => item.reason),
    ...normalizeArray(qualityGate?.reviewReasons).map(item => item.reason)
  ].filter(Boolean);
  const seen = new Set();
  for (const reason of reasons) {
    if (seen.has(reason)) continue;
    seen.add(reason);
    addTaskChatGateReviewHint(data, {
      taskId,
      now,
      gateName: 'Batch 7 processing-ledger quality gate',
      reason
    });
  }
}

function addTaskChatTemporalGateReviewHints(data, { taskId, now, temporalGate }) {
  data.reviewQueue = normalizeArray(data.reviewQueue);
  const seen = new Set();
  for (const item of normalizeArray(temporalGate?.reviewReasons)) {
    const reason = item?.reason;
    if (!reason || seen.has(reason)) continue;
    seen.add(reason);
    data.reviewQueue.push({
      kind: 'other',
      ref: item.ref || taskId,
      question: reason,
      confidence: 'low',
      createdAt: nowIso(now)
    });
  }
}

async function applyDeepVerificationMarkersAfterAnswer({
  tasksFile,
  taskId,
  conversationId,
  parsedMarkers,
  state,
  now,
  runId,
  job,
  userPrompt,
  deepVerification,
  learningsBlock,
  _readJsonFile,
  _writeJsonFileAtomic,
  _runGateway,
  _applyMarkerBatch
}) {
  let scoped = { markers: [], held: [] };
  let gatewayFilter = { held: [], approved: [], markers: [], gatewayParsed: true, gatewayParseError: null };
  let applyResult = { applied: 0, dropped: [], data: null };
  try {
    const latestData = migrateToV5(_readJsonFile(tasksFile));
    const latestTask = normalizeArray(latestData.tasks).find(item => item.id === taskId);
    if (!latestTask) throw new Error('Task was deleted before deep verification marker apply');
    scoped = scopeMarkersToTask(parsedMarkers, latestTask);

    job?.emit?.('job.progress', {
      phase: 'brain_gateway',
      activePhase: 'brain_gateway',
      agentPhase: 'checking',
      stage: 'deep_verify',
      blocksTask: false,
      conversationId,
      statusText: 'Applying verified task updates...',
      markers: scoped.markers.length
    });

    const gatewayResult = await _runGateway({
      stateFile: state.stateFile,
      factSheetFiles: state.factSheetFiles,
      markers: scoped.markers,
      learningsBlock,
      brainWorkDir: state.brainWorkDir,
      runId,
      runClass: BRAIN_RUN_CLASS.BACKGROUND
    });
    gatewayFilter = filterMarkersThroughGateway(scoped.markers, gatewayResult);

    const qualityGate = evaluateTaskChatProcessingQualityGate(gatewayFilter.markers, {
      deepVerification,
      userPrompt
    });

    const temporalGate = filterMarkersByTemporalPassGate(taskScopedData(latestData, taskId), qualityGate.markers, { now });

    applyResult = _applyMarkerBatch(latestData, temporalGate.markers, {
      now,
      runId,
      auditLogFile: null,
      advanceScanWatermark: false,
      recordScanTelemetry: false
    });
    addTaskChatQualityGateReviewHints(applyResult.data, { taskId, now, qualityGate });
    addTaskChatTemporalGateReviewHints(applyResult.data, { taskId, now, temporalGate });
    const heldMarkerCount = qualityGate.held.length + temporalGate.held.length;
    const reviewItemCount = qualityGate.reviewReasons.length + temporalGate.reviewReasons.length;
    const markerProcessingStatus = heldMarkerCount || reviewItemCount ? 'partial' : 'completed';
    const processingError = qualityGate.ok && temporalGate.ok ? null : qualityGate.reason || temporalGate.reason;
    updateDeepVerificationMarkerStatus(applyResult.data, taskId, {
      conversationId,
      now: new Date(),
      jobId: job?.id || null,
      runId,
      markersApplied: applyResult.applied,
      markersHeld: gatewayFilter.held.length + scoped.held.length + heldMarkerCount,
      markersDropped: applyResult.dropped.length,
      markerProcessingStatus,
      error: processingError,
      gateway: {
        approvedMarkers: gatewayFilter.approved.length,
        heldMarkers: gatewayFilter.held.length,
        parsed: gatewayFilter.gatewayParsed,
        parseError: gatewayFilter.gatewayParseError,
        qualityGate: {
          ok: qualityGate.ok,
          reason: qualityGate.reason,
          skipped: Boolean(qualityGate.skipped),
          ledgerItems: qualityGate.ledgerCount,
          heldMarkers: qualityGate.held.length,
          reviewItems: qualityGate.reviewReasons.length
        },
        temporalGate: {
          ok: temporalGate.ok,
          reason: temporalGate.reason,
          staleNodes: temporalGate.staleNodes.length,
          addressed: temporalGate.addressed.length,
          heldMarkers: temporalGate.held.length,
          reviewItems: temporalGate.reviewReasons.length
        }
      }
    });
    _writeJsonFileAtomic(tasksFile, applyResult.data);
    job?.emit?.('job.progress', {
      phase: 'marker_apply_done',
      activePhase: 'marker_apply_done',
      agentPhase: 'completed',
      stage: 'deep_verify',
      blocksTask: false,
      conversationId,
      statusText: markerProcessingStatus === 'partial' ? 'Task updates partially applied.' : 'Task updates applied.',
      markersApplied: applyResult.applied,
      markersHeld: gatewayFilter.held.length + scoped.held.length + heldMarkerCount
    });
    return {
      ok: qualityGate.ok && temporalGate.ok,
      partial: markerProcessingStatus === 'partial',
      scoped,
      gatewayFilter,
      applyResult,
      qualityGate,
      temporalGate
    };
  } catch (err) {
    try {
      const latestData = migrateToV5(_readJsonFile(tasksFile));
      updateDeepVerificationMarkerStatus(latestData, taskId, {
        conversationId,
        now: new Date(),
        jobId: job?.id || null,
        runId,
        markersApplied: applyResult.applied || 0,
        markersHeld: (gatewayFilter.held?.length || 0) + (scoped.held?.length || 0),
        markersDropped: applyResult.dropped?.length || 0,
        markerProcessingStatus: 'failed',
        error: err.message || String(err)
      });
      _writeJsonFileAtomic(tasksFile, latestData);
    } catch {}
    job?.emit?.('job.progress', {
      phase: 'marker_apply_failed',
      activePhase: 'marker_apply_failed',
      agentPhase: 'failed',
      stage: 'deep_verify',
      blocksTask: false,
      conversationId,
      statusText: 'Task update markers failed.',
      error: err.message || String(err)
    });
    return { ok: false, error: err.message || String(err) };
  }
}

export async function runTaskChatFastOnce(job, {
  tasksFile = DEFAULT_TASKS_FILE,
  brainWorkDir = BRAIN_WORK_DIR,
  uploadsDir = DEFAULT_UPLOADS_DIR,
  now = new Date(),
  runId = `task-chat-fast-${Date.now()}`,
  _readJsonFile = readJsonFile,
  _writeJsonFileAtomic = writeJsonFileAtomic,
  _runBrain = runBrain,
  _parseMarkers = parseMarkers
} = {}) {
  const startedAt = Date.now();
  const taskId = job?.taskId;
  const inputAttachments = normalizeArray(job?.input?.attachments);
  const userPrompt = String(job?.input?.text || '').trim()
    || (inputAttachments.length ? 'Please review the attached image(s) for this task.' : '');
  if (!taskId) throw new Error('runTaskChatFastOnce requires job.taskId');
  if (!userPrompt) throw new Error('runTaskChatFastOnce requires job.input.text');

  setJobPhase(job, 'brain_prepare', { taskId, agentPhase: 'starting', stage: 'fast' });
  const beforeData = migrateToV5(_readJsonFile(tasksFile));
  const task = normalizeArray(beforeData.tasks).find(item => item.id === taskId);
  if (!task) throw new Error('Task not found');
  const attachments = resolveTaskAttachmentReferences({
    taskId,
    attachments: inputAttachments,
    uploadsDir
  });

  const state = writeTaskChatState({ data: beforeData, task, taskId, userPrompt, attachments, brainWorkDir, runId, now });
  const learningsBlock = taskLearningBlock(task, now);
  const prompt = buildTaskChatFastPrompt({
    stateFileName: state.stateFileName,
    factSheetFiles: state.factSheetFiles,
    userPrompt,
    attachments,
    taskId,
    runId,
    learningsBlock
  });

  setJobPhase(job, 'brain_run', { taskId, agentPhase: 'thinking', stage: 'fast' });
  let brainResult;
  try {
    brainResult = await _runBrain({
      prompt,
      brainWorkDir: state.brainWorkDir,
      attachments: attachments.map(attachment => attachment.absolutePath),
      uploadsDir,
      timeoutMs: DEFAULT_TASK_CHAT_FAST_TIMEOUT_MS,
      toolCallHardLimit: DEFAULT_TASK_CHAT_FAST_WORKIQ_LIMIT,
      runClass: BRAIN_RUN_CLASS.INTERACTIVE,
      mcpMode: 'none',
      schedulerLabel: `task-chat-fast:${taskId}`,
      onSchedulerUpdate: schedulerProgress(job, 'brain_run', { taskId, agentPhase: 'thinking', stage: 'fast' }),
      cleanBrainWorkDir: false
    });
  } catch (err) {
    brainResult = {
      ok: false,
      error: { message: err.message || String(err) },
      timedOut: false,
      salvaged: false,
      counters: { workIqCalls: 0 }
    };
  }

  const persistFastAnswer = ({
    chatText,
    flag,
    parsedMarkers = [],
    parseErrors = [],
    method = 'agency-task-chat-fast-v1',
    confidence = 'medium',
    deterministicFallback = false
  }) => {
    const conversationId = randomUUID();
    const deepVerification = flag.required
      ? {
          required: true,
          status: 'running',
          system: flag.system,
          reason: flag.reason,
          question: flag.question || userPrompt,
          verifyExactly: normalizeVerifyExactly(flag.verifyExactly, flag.question || userPrompt),
          conversationId,
          startedAt: nowIso(now),
          jobId: null,
          runId: null
        }
      : {
          required: false,
          status: 'not-needed',
          system: flag.system,
          reason: flag.reason,
          question: flag.question || '',
          verifyExactly: normalizeVerifyExactly(flag.verifyExactly, flag.question || ''),
          conversationId
        };

    const finalTask = appendChatHistory(beforeData, taskId, {
      userText: userPrompt,
      assistantText: chatText,
      attachments,
      now,
      jobId: job?.id || null,
      runId,
      conversationId,
      method,
      deepVerification,
      markersParsed: 0,
      markersApplied: 0,
      markersHeld: parsedMarkers.length,
      parseErrors,
      confidence,
      durationMs: Date.now() - startedAt
    });
    if (!finalTask) throw new Error('Task was deleted before final write');

    _writeJsonFileAtomic(tasksFile, beforeData);

    return {
      task: finalTask,
      assistantText: chatText,
      conversationId,
      deepVerification,
      markersParsed: 0,
      markersApplied: 0,
      markersDropped: 0,
      markersHeld: parsedMarkers.length,
      confidence: finalTask.history.at(-1)?.agentExecution?.confidence || confidence,
      parseErrors,
      gateway: {
        approvedMarkers: 0,
        heldMarkers: 0,
        parsed: true,
        parseError: null,
        skipped: true
      },
      brain: {
        timedOut: Boolean(brainResult?.timedOut),
        salvaged: Boolean(brainResult?.salvaged),
        workIqCalls: brainResult?.counters?.workIqCalls || 0,
        deterministicFallback
      }
    };
  };

  if (!brainResult?.ok) {
    const fallback = buildDeterministicTaskChatFallback({
      task,
      userPrompt,
      now,
      reason: brainResult?.error?.message || 'Task chat fast brain run failed'
    });
    return persistFastAnswer({
      chatText: fallback.assistantText,
      flag: fallback.flag,
      method: 'agency-task-chat-fast-fallback-v1',
      confidence: 'medium',
      deterministicFallback: true
    });
  }

  const assistantText = brainResult.assistantText || brainResult.text || '';
  const parsed = _parseMarkers(assistantText);
  const flagResult = extractDeepVerificationFlag(chatTextWithoutMarkers(assistantText));
  const inferredFlag = inferDeepVerificationRequirement(userPrompt);
  const effectiveFlag = mergeDeepVerificationFlag(flagResult.flag, inferredFlag);
  const chatText = ensureDeepVerificationLine(flagResult.text, effectiveFlag);
  if (!chatText) {
    const fallback = buildDeterministicTaskChatFallback({
      task,
      userPrompt,
      now,
      reason: flagResult.errors.length ? 'Task chat output had no answer text and an invalid deep verification flag' : 'Task chat output was empty'
    });
    return persistFastAnswer({
      chatText: fallback.assistantText,
      flag: fallback.flag,
      method: 'agency-task-chat-fast-fallback-v1',
      confidence: 'medium',
      deterministicFallback: true,
      parseErrors: flagResult.errors
    });
  }

  return persistFastAnswer({
    chatText,
    flag: effectiveFlag,
    parsedMarkers: parsed.markers,
    parseErrors: [...parsed.errors, ...flagResult.errors],
    confidence: flagResult.errors.length || parsed.markers.length ? 'low' : 'medium'
  });
}

export async function runTaskChatDeepVerifyOnce(job, {
  tasksFile = DEFAULT_TASKS_FILE,
  brainWorkDir = BRAIN_WORK_DIR,
  uploadsDir = DEFAULT_UPLOADS_DIR,
  now = new Date(),
  runId = `task-chat-deep-${Date.now()}`,
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
  const userPrompt = String(job?.input?.text || '').trim();
  const conversationId = String(job?.input?.conversationId || '').trim();
  const stageOneAnswer = String(job?.input?.stageOneAnswer || '').trim();
  const deepVerification = job?.input?.deepVerification || {};
  if (!taskId) throw new Error('runTaskChatDeepVerifyOnce requires job.taskId');
  if (!userPrompt) throw new Error('runTaskChatDeepVerifyOnce requires job.input.text');
  if (!conversationId) throw new Error('runTaskChatDeepVerifyOnce requires job.input.conversationId');

  setJobPhase(job, 'brain_prepare', { taskId, agentPhase: 'starting', stage: 'deep_verify' });
  const promptData = migrateToV5(_readJsonFile(tasksFile));
  const promptTask = normalizeArray(promptData.tasks).find(item => item.id === taskId);
  if (!promptTask) throw new Error('Task not found');
  if (!findConversationEntry(promptTask, conversationId)) {
    throw new Error('Conversation not found for deep verification');
  }
  const attachments = resolveTaskAttachmentReferences({
    taskId,
    attachments: inputAttachments,
    uploadsDir
  });

  const state = writeTaskChatState({ data: promptData, task: promptTask, taskId, userPrompt, attachments, brainWorkDir, runId, now });
  const learningsBlock = taskLearningBlock(promptTask, now);
  const prompt = buildTaskChatDeepVerifyPrompt({
    stateFileName: state.stateFileName,
    factSheetFiles: state.factSheetFiles,
    userPrompt,
    stageOneAnswer,
    deepVerification,
    attachments,
    taskId,
    runId,
    learningsBlock
  });

  const verifyExactly = normalizeVerifyExactly(deepVerification.verifyExactly, deepVerification.question || userPrompt);
  const toolStatuses = [];
  setJobPhase(job, 'brain_run', { taskId, agentPhase: 'verifying', stage: 'deep_verify' });
  let brainResult;
  try {
    brainResult = await _runBrain({
      prompt,
      brainWorkDir: state.brainWorkDir,
      attachments: attachments.map(attachment => attachment.absolutePath),
      uploadsDir,
      timeoutMs: DEFAULT_TASK_CHAT_DEEP_TIMEOUT_MS,
      runClass: BRAIN_RUN_CLASS.BACKGROUND,
      mcpMode: 'default',
      schedulerLabel: `task-chat-deep:${taskId}`,
      onSchedulerUpdate: schedulerProgress(job, 'brain_run', { taskId, agentPhase: 'verifying', stage: 'deep_verify' }),
      onToolExecution: (event, counters = {}) => {
        const statusText = describeDeepVerificationToolStart(event, deepVerification);
        if (!statusText) return;
        toolStatuses.push(statusText.replace(/\.+$/, ''));
        job?.emit?.('job.progress', {
          phase: 'brain_run',
          activePhase: 'brain_run',
          agentPhase: 'verifying',
          stage: 'deep_verify',
          blocksTask: false,
          conversationId,
          statusText,
          elapsedMs: Date.now() - startedAt,
          workIqCalls: counters.workIqCalls || 0
        });
      },
      cleanBrainWorkDir: false
    });
  } catch (err) {
    brainResult = {
      ok: false,
      error: { message: err.message || String(err) },
      timedOut: false,
      salvaged: false,
      killedForToolBudget: false,
      counters: { workIqCalls: 0 },
      assistantText: ''
    };
  }

  const assistantText = brainResult.assistantText || brainResult.text || '';
  const parsed = _parseMarkers(assistantText);
  const rawChatText = chatTextWithoutMarkers(assistantText);
  const limited = Boolean(brainResult.timedOut || brainResult.killedForToolBudget);
  if (!brainResult.ok && !limited && !rawChatText) {
    throw new Error(brainResult.error?.message || 'Task chat deep verification failed');
  }

  const partial = limited || !brainResult.ok;
  const status = partial ? 'partial' : 'completed';
  const chatText = partial
    ? buildDeepVerificationPartialText({
        chatText: rawChatText,
        brainResult,
        deepVerification,
        verifyExactly,
        toolStatuses,
        userPrompt
      })
    : rawChatText;

  if (!parsed.markers.length && !chatText) {
    throw new Error(parsed.errors.length ? 'Deep verification output had no valid markers or answer text' : 'Deep verification output was empty');
  }

  const latestData = migrateToV5(_readJsonFile(tasksFile));
  const latestTask = normalizeArray(latestData.tasks).find(item => item.id === taskId);
  if (!latestTask) throw new Error('Task was deleted before deep verification write');

  const confidence = status === 'partial'
    ? 'low'
    : deriveChatConfidence({
        markersParsed: parsed.markers.length,
        markersApplied: 0,
        markersHeld: 0,
        markersDropped: 0,
        parseErrors: parsed.errors
      });
  const finalTask = appendDeepVerificationContribution(latestData, taskId, {
    conversationId,
    assistantText: chatText || 'Deep verification completed.',
    now,
    jobId: job?.id || null,
    runId,
    markersParsed: parsed.markers.length,
    markersApplied: 0,
    markersHeld: 0,
    markersDropped: 0,
    parseErrors: parsed.errors,
    confidence,
    durationMs: Date.now() - startedAt,
    status,
    markerProcessingStatus: parsed.markers.length ? 'scheduled' : 'skipped'
  });
  if (!finalTask) throw new Error('Conversation disappeared before deep verification write');

  _writeJsonFileAtomic(tasksFile, latestData);
  job?.emit?.('job.progress', {
    phase: 'answer_posted',
    activePhase: 'answer_posted',
    agentPhase: 'completed',
    stage: 'deep_verify',
    blocksTask: false,
    conversationId,
    statusText: status === 'partial' ? 'Partial result posted.' : 'Deep verification result posted.'
  });

  const markerApplyPromise = parsed.markers.length
    ? new Promise(resolve => {
        setImmediate(() => {
          applyDeepVerificationMarkersAfterAnswer({
            tasksFile,
            taskId,
            conversationId,
            parsedMarkers: parsed.markers,
            state,
            now,
            runId,
            job,
            userPrompt,
            deepVerification,
            learningsBlock,
            _readJsonFile,
            _writeJsonFileAtomic,
            _runGateway,
            _applyMarkerBatch
          }).then(resolve, err => resolve({ ok: false, error: err.message || String(err) }));
        });
      })
    : Promise.resolve({ ok: true, skipped: true });

  return {
    task: finalTask,
    assistantText: chatText,
    conversationId,
    markersParsed: parsed.markers.length,
    markersApplied: 0,
    markersDropped: [],
    markersHeld: 0,
    confidence,
    scopeHeld: 0,
    parseErrors: parsed.errors,
    markerApplication: {
      scheduled: parsed.markers.length > 0,
      status: parsed.markers.length ? 'scheduled' : 'skipped'
    },
    markerApplyPromise,
    gateway: {
      approvedMarkers: 0,
      heldMarkers: 0,
      parsed: true,
      parseError: null,
      skipped: parsed.markers.length === 0,
      scheduled: parsed.markers.length > 0
    },
    brain: {
      timedOut: Boolean(brainResult.timedOut),
      salvaged: Boolean(brainResult.salvaged),
      killedForToolBudget: Boolean(brainResult.killedForToolBudget),
      workIqCalls: brainResult.counters?.workIqCalls || 0
    }
  };
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
  const learningsBlock = taskLearningBlock(task, now);
  const prompt = buildTaskChatPrompt({
    stateFileName: state.stateFileName,
    factSheetFiles: state.factSheetFiles,
    userPrompt,
    attachments,
    taskId,
    runId,
    learningsBlock
  });

  setJobPhase(job, 'brain_run', { taskId, agentPhase: 'thinking' });
  const brainResult = await _runBrain({
    prompt,
    brainWorkDir: state.brainWorkDir,
    attachments: attachments.map(attachment => attachment.absolutePath),
    uploadsDir,
    timeoutMs: DEFAULT_TASK_CHAT_TIMEOUT_MS,
    runClass: BRAIN_RUN_CLASS.INTERACTIVE,
    mcpMode: 'default',
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
      learningsBlock,
      brainWorkDir: state.brainWorkDir,
      runId,
      runClass: BRAIN_RUN_CLASS.INTERACTIVE,
      onSchedulerUpdate: schedulerProgress(job, 'brain_gateway', { taskId, agentPhase: 'checking' })
    });
    gatewayFilter = filterMarkersThroughGateway(scoped.markers, gatewayResult);
    applyResult = _applyMarkerBatch(beforeData, gatewayFilter.markers, {
      now,
      runId,
      auditLogFile: null,
      advanceScanWatermark: false,
      recordScanTelemetry: false
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
