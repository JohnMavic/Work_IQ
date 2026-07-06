#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { prepareBrainWorkDir, runBrain } from '../brain/brain-runner.js';
import { parseMarkers } from '../brain/marker-parser.js';
import { applyMarkerBatch } from '../brain/marker-applier.js';
import { filterMarkersThroughGateway, runRealityGateway } from '../brain/reality-gateway.js';
import { evaluateProcessingQualityGate } from '../brain/processing-ledger.js';
import { renderFactSheetMarkdown, FACTSHEET_SECTIONS, normalizeFactSheet } from '../brain/factsheet.js';
import { migrateToV5, writeJsonFileAtomic } from '../brain/tasks-v5.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_TASKS_FILE = path.join(REPO_ROOT, 'tasks.json');
export const DEFAULT_SKILL_FILE = path.join(REPO_ROOT, 'docs', 'AGENCY_BRAIN_SCAN_SKILL.md');
export const DEFAULT_BATCH7_FILE = path.join(REPO_ROOT, 'docs', 'gremium', 'PROMPT-BATCH-7.md');
export const DEFAULT_PREVIEW_FILE = path.join(REPO_ROOT, 'tests', 'runs', 'structure-migration-preview.json');
export const DEFAULT_REPORT_FILE = path.join(REPO_ROOT, 'docs', 'gremium', 'RESULT-MIGRATE-STRUCTURE.md');
export const DEFAULT_BRAIN_WORK_DIR = path.join(REPO_ROOT, 'tests', 'runs', 'structure-migration', 'brain-work');
export const DEFAULT_BATCH_SIZE = 5;
export const DEFAULT_WORKIQ_LIMIT = 40;
export const STRUCTURE_MIGRATION_REPAIR_ID = 'migrate-structure';

const PM_LIST_FIELDS = ['planned', 'userActions', 'problems', 'risks', 'waitingOn'];
const MUTATING_TYPES = new Set(['PROJECT_UPDATE', 'FACTSHEET_UPDATE', 'LINEITEM_NEW', 'LINEITEM_UPDATE']);
const ALLOWED_TYPES = new Set([...MUTATING_TYPES, 'NEEDS_REVIEW', 'SCAN_DONE']);

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function safeFilePart(value) {
  return String(value || 'structure')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 80) || 'structure';
}

function chunked(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
}

function parseTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function bestIsoDate(values, fallbackNow) {
  for (const value of values) {
    const parsed = parseTime(value);
    if (parsed !== null) return new Date(parsed).toISOString();
  }
  return nowIso(fallbackNow);
}

function isArchived(task) {
  return Boolean(task?.archived || task?.supersededBy);
}

function activeFactSheetEntryCount(task) {
  const sheet = normalizeFactSheet(task?.factSheet);
  return FACTSHEET_SECTIONS.reduce((sum, section) => {
    return sum + normalizeArray(sheet.sections[section.id]).filter(entry => entry && !entry.removedAt).length;
  }, 0);
}

function hasPmStatusStructure(task) {
  const pm = task?.pmStatus;
  return Boolean(
    pm
    && typeof pm === 'object'
    && !Array.isArray(pm)
    && typeof pm.current === 'string'
    && PM_LIST_FIELDS.every(field => Array.isArray(pm[field]))
  );
}

function hasProcessingStructure(task) {
  const processing = task?.processing;
  return Boolean(
    processing
    && typeof processing === 'object'
    && !Array.isArray(processing)
    && Array.isArray(processing.ledger)
    && processing.threads
    && typeof processing.threads === 'object'
    && !Array.isArray(processing.threads)
    && Object.hasOwn(processing, 'cursorDate')
  );
}

export function hasNewStructure(task) {
  return Boolean(
    task
    && !isArchived(task)
    && hasPmStatusStructure(task)
    && activeFactSheetEntryCount(task) > 0
    && hasProcessingStructure(task)
  );
}

export function selectStructureMigrationTargets(inputData, { targetIds = null } = {}) {
  const data = migrateToV5(inputData);
  const requested = targetIds ? new Set(targetIds) : null;
  return normalizeArray(data.tasks)
    .filter(task => task && !isArchived(task))
    .filter(task => !requested || requested.has(task.id))
    .filter(task => !hasNewStructure(task));
}

function isDateLikeKey(key) {
  return key === 'date'
    || key === 'timestamp'
    || key === 'dueAt'
    || key === 'referencedDate'
    || key === 'lastMessageDate'
    || key === 'checkedThroughMessageDate'
    || key.endsWith('At')
    || key.endsWith('Date');
}

function shouldCleanDateValue(value) {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string' && value.trim() === '') return true;
  return parseTime(value) === null;
}

export function sanitizeGarbageDates(inputData) {
  const cleaned = [];

  function walk(value, parts) {
    if (Array.isArray(value)) {
      return value.map((item, index) => walk(item, [...parts, `[${index}]`]));
    }
    if (!value || typeof value !== 'object') return value;

    const result = { ...value };
    for (const [key, child] of Object.entries(result)) {
      const childPath = [...parts, key];
      if (isDateLikeKey(key) && shouldCleanDateValue(child)) {
        cleaned.push({ path: childPath.join('.').replace(/\.\[/g, '['), value: child });
        result[key] = null;
        continue;
      }
      result[key] = walk(child, childPath);
    }
    return result;
  }

  return {
    data: walk(inputData, []),
    cleaned
  };
}

function sourceRefsForState(task) {
  return normalizeArray(task?.sourceRefs).map(ref => ({
    id: ref.id,
    type: ref.type || null,
    title: ref.title || '',
    from: ref.from || null,
    date: ref.date || null,
    firstSeenAt: ref.firstSeenAt || null,
    lastSeenAt: ref.lastSeenAt || null,
    sourceTaskId: ref.sourceTaskId || null,
    evidenceText: ref.evidenceText || '',
    linkPresent: Boolean(ref.link || ref.url)
  }));
}

function taskForState(task, factSheetFile) {
  return {
    id: task.id,
    taskType: task.taskType || 'single',
    title: task.title || '',
    source: task.source || null,
    from: task.from || null,
    status: task.status || null,
    date: task.date || null,
    linkPresent: Boolean(task.link),
    summary: task.summary || '',
    notes: task.notes || '',
    pmStatus: task.pmStatus || null,
    lineItems: normalizeArray(task.lineItems),
    processing: task.processing || null,
    factSheetFile,
    sourceRefs: sourceRefsForState(task),
    recentHistory: normalizeArray(task.history).slice(-10).map(entry => ({
      timestamp: entry.timestamp || null,
      type: entry.type || null,
      text: entry.text || '',
      agentResponse: entry.agentResponse || null
    }))
  };
}

export function writeStructureBatchState({
  data,
  tasks,
  brainWorkDir = DEFAULT_BRAIN_WORK_DIR,
  runId,
  batchIndex,
  totalBatches,
  now = new Date()
} = {}) {
  const dir = prepareBrainWorkDir(brainWorkDir);
  const factSheetFiles = [];
  const renderedTasks = [];

  for (const task of tasks) {
    const factSheetFile = `structure-factsheet-${safeFilePart(task.id)}-${safeFilePart(runId)}.md`;
    fs.writeFileSync(path.join(dir, factSheetFile), renderFactSheetMarkdown(task), 'utf8');
    factSheetFiles.push(factSheetFile);
    renderedTasks.push(taskForState(task, factSheetFile));
  }

  const state = {
    renderedAt: nowIso(now),
    runId,
    batchIndex,
    totalBatches,
    targetTaskIds: tasks.map(task => task.id),
    taskCountTotal: normalizeArray(data.tasks).length,
    invariant: 'Migrate only target tasks to the Batch 7 structure. Preserve title, summary, history, source links, and task count.',
    tasks: renderedTasks
  };
  const stateFileName = `structure-state-${safeFilePart(runId)}-batch-${batchIndex}.json`;
  fs.writeFileSync(path.join(dir, stateFileName), `${JSON.stringify(state, null, 2)}\n`, 'utf8');

  return {
    brainWorkDir: dir,
    stateFile: path.join(dir, stateFileName),
    stateFileName,
    factSheetFiles,
    targetTaskIds: state.targetTaskIds
  };
}

export function buildStructureMigrationPrompt({
  skillText,
  batch7Text,
  stateFileName,
  factSheetFiles,
  runId,
  batchIndex,
  totalBatches
}) {
  return [
    skillText.trim(),
    '',
    '# One-Time Structure Migration Run',
    '',
    'Read the batch state JSON and every listed Fact Sheet file before using WorkIQ.',
    'This run migrates legacy active tasks into the Batch 7 structure; it is not a consolidation run.',
    '',
    `runId: ${runId}`,
    `batch: ${batchIndex}/${totalBatches}`,
    `stateFile: ./${stateFileName}`,
    `factSheetFiles: ${factSheetFiles.map(name => `./${name}`).join(', ') || 'none'}`,
    '',
    'Structure migration rules:',
    '- Mutate only task IDs listed in state.targetTaskIds.',
    '- Do not create new tasks or projects. Use PROJECT_UPDATE for existing single or project tasks.',
    '- Do not change title, summary, history, notes, task count, archived fields, supersession fields, or existing links.',
    '- The old summary is a fallback field and must remain byte-for-byte unchanged.',
    '- For each target task, build pmStatus with current, planned, userActions, problems, risks, waitingOn, confidence, and lastSynthesizedAt.',
    '- For each target task, build an English Fact Sheet using the fixed section model.',
    '- For each target task, initialize processing with cursorDate, threads, and processingLedger entries.',
    '- Use lineItems only when the evidence supports separable workstreams or dependencies.',
    '- Prefer a complete WorkIQ thread lookup for the task title/source. If WorkIQ does not index the source, do not invent facts.',
    '- If source evidence is unavailable or incomplete, still emit a low-confidence structure based on preserved legacy state and emit NEEDS_REVIEW for that task.',
    '- For unavailable source evidence, do not emit userActions. Use pmStatus.current/waitingOn to say the task needs review because source evidence was not verified.',
    '- Visible userActions are allowed only with askQuote and the full Batch 7 action gate proof.',
    '- Every status/problem/risk/waiting/action update must cite sourceRefs already in state or introduced in the same marker batch.',
    '- If a task has no usable sourceRef, introduce one manual sourceRef derived from the legacy task record with link:null unless a real existing link is present.',
    '- Keep all generated content in English.',
    '- End with SCAN_DONE for this batch.',
    '',
    '# Batch 7 Binding Context',
    batch7Text.trim(),
    '',
    'Output only marker lines and short non-marker notes if partial.'
  ].join('\n');
}

function markerWithPayload(marker, payload) {
  return {
    ...marker,
    payload,
    raw: `[${marker.type}] ${JSON.stringify(payload)}`
  };
}

function markerTaskId(marker) {
  return marker?.payload?.taskId || marker?.payload?.ref || null;
}

function normalizeStructureMarkers(markers, targetIds) {
  const allowedTargets = new Set(targetIds);
  const kept = [];
  const dropped = [];

  for (const marker of normalizeArray(markers)) {
    if (!ALLOWED_TYPES.has(marker.type)) {
      dropped.push({ marker, reason: `marker type ${marker.type} is not allowed in structure migration` });
      continue;
    }
    if (marker.type === 'SCAN_DONE') {
      kept.push(marker);
      continue;
    }
    if (marker.type === 'NEEDS_REVIEW') {
      const ref = marker.payload?.ref || null;
      if (ref && !allowedTargets.has(ref)) {
        dropped.push({ marker, reason: `NEEDS_REVIEW ref ${ref} is outside target batch` });
        continue;
      }
      kept.push(marker);
      continue;
    }

    const taskId = markerTaskId(marker);
    if (!taskId || !allowedTargets.has(taskId)) {
      dropped.push({ marker, reason: `marker taskId ${taskId || '(missing)'} is outside target batch` });
      continue;
    }

    if (marker.type === 'PROJECT_UPDATE') {
      const payload = { ...marker.payload };
      delete payload.title;
      delete payload.summary;
      delete payload.supersedesTaskIds;
      kept.push(markerWithPayload(marker, payload));
      continue;
    }

    kept.push(marker);
  }

  return { markers: kept, dropped };
}

function usableLegacyLink(link) {
  const value = typeof link === 'string' ? link.trim() : '';
  if (!/^https?:\/\//i.test(value)) return null;
  if (/\bturn\d+search\d+\b/i.test(value)) return null;
  if (value.includes('...')) return null;
  return value;
}

function truncateText(value, max = 220) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  if (!text) return 'Legacy Agent Zero task record.';
  return text.length <= max ? text : `${text.slice(0, max - 3).trimEnd()}...`;
}

function fallbackSourceRef(task, now) {
  const existing = normalizeArray(task.sourceRefs).find(ref => ref?.id);
  if (existing) {
    return { id: existing.id, additions: [] };
  }

  const id = `src-legacy-${safeFilePart(task.id).slice(0, 48)}`;
  const date = bestIsoDate([task.date, task.updatedAt, task.createdAt], now);
  const link = usableLegacyLink(task.link);
  return {
    id,
    additions: [{
      id,
      type: 'manual',
      title: task.title || 'Legacy Agent Zero task',
      from: task.from || null,
      date,
      link,
      sourceTaskId: task.id,
      firstSeenAt: task.createdAt || nowIso(now),
      lastSeenAt: task.updatedAt || task.createdAt || nowIso(now),
      evidenceText: 'Legacy Agent Zero task record preserved during structure migration.'
    }]
  };
}

export function buildFallbackStructureMarkers(task, {
  now = new Date(),
  runId = `structure-${Date.now()}`
} = {}) {
  const source = fallbackSourceRef(task, now);
  const ts = nowIso(now);
  const evidenceDate = bestIsoDate([task.date, task.updatedAt, task.createdAt], now);
  const threadRef = `legacy:${task.id}`;
  const current = 'Structure initialized from local legacy task metadata only; no verified current external status is asserted.';
  const ledger = [{
    itemRef: { type: 'legacy-task', id: task.id },
    threadRef,
    date: evidenceDate,
    disposition: 'already-processed',
    nodeRefs: [task.id],
    quote: truncateText(task.summary || task.title),
    reason: 'Structure migration initialized the Batch 7 ledger from preserved legacy task state without asserting a new open action.'
  }];
  const nodeBase = {
    evidenceRefIds: [source.id],
    confidence: 'low',
    state: 'unconfirmed',
    sources: [source.id],
    lastConfirmedByMessageDate: null
  };
  const projectPayload = {
    taskId: task.id,
    sourceRefs: source.additions,
    evidenceRefIds: [source.id],
    pmStatus: {
      current,
      planned: [],
      userActions: [],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'low',
      lastSynthesizedAt: ts
    },
    processing: {
      cursorDate: evidenceDate,
      lookbackDays: 14,
      threads: {
        [threadRef]: { lastProcessedMessageDate: evidenceDate }
      }
    },
    processingLedger: ledger
  };
  const factPayload = {
    taskId: task.id,
    sectionPatches: {
      overview: [{
        op: 'add',
        text: 'Local legacy task metadata was migrated to the Batch 7 structure. The original summary remains preserved as the fallback field.',
        date: evidenceDate,
        ...nodeBase
      }],
      status: [{
        op: 'add',
        text: current,
        date: evidenceDate,
        ...nodeBase
      }],
      sources: [{
        op: 'add',
        text: 'Local Agent Zero legacy task metadata retained as migration evidence.',
        date: evidenceDate,
        ...nodeBase
      }]
    },
    processingLedger: ledger
  };
  const reviewPayload = {
    kind: 'status',
    ref: task.id,
    question: 'Structure migration could not fully verify the current source thread in WorkIQ. Review the preserved legacy summary before acting.',
    confidence: 'low',
    repairId: STRUCTURE_MIGRATION_REPAIR_ID
  };
  const scanPayload = {
    runId,
    outcome: 'partial',
    newProjects: 0,
    updatedProjects: 1,
    newSingleTasks: 0,
    archivedTasks: 0,
    workIqCalls: 0,
    processingQuality: {
      required: true,
      enumeratedItems: [{ itemRef: ledger[0].itemRef, threadRef }],
      threadCounts: [{ threadRef, count: 1 }]
    },
    notes: `Fallback structure initialized for ${task.id}; review required.`
  };

  return [
    { type: 'PROJECT_UPDATE', payload: projectPayload, raw: `[PROJECT_UPDATE] ${JSON.stringify(projectPayload)}` },
    { type: 'FACTSHEET_UPDATE', payload: factPayload, raw: `[FACTSHEET_UPDATE] ${JSON.stringify(factPayload)}` },
    { type: 'NEEDS_REVIEW', payload: reviewPayload, raw: `[NEEDS_REVIEW] ${JSON.stringify(reviewPayload)}` },
    { type: 'SCAN_DONE', payload: scanPayload, raw: `[SCAN_DONE] ${JSON.stringify(scanPayload)}` }
  ];
}

function taskById(data, id) {
  return normalizeArray(data.tasks).find(task => task.id === id) || null;
}

function migratedIdsFor(data, targetIds) {
  return targetIds.filter(id => hasNewStructure(taskById(data, id)));
}

function needsReviewIdsFor(data, targetIds) {
  const refs = new Set(normalizeArray(data.reviewQueue).map(entry => entry?.ref).filter(Boolean));
  return targetIds.filter(id => {
    const task = taskById(data, id);
    return Boolean(task?.brainState?.needsReview || refs.has(id));
  });
}

function countLinks(task) {
  let count = task?.link ? 1 : 0;
  count += normalizeArray(task?.additionalLinks).filter(Boolean).length;
  count += normalizeArray(task?.sourceRefs).filter(ref => ref?.link || ref?.url).length;
  return count;
}

function summarizeInvariants(beforeData, afterData) {
  const beforeById = new Map(normalizeArray(beforeData.tasks).map(task => [task.id, task]));
  const afterById = new Map(normalizeArray(afterData.tasks).map(task => [task.id, task]));
  const deletedTaskIds = [...beforeById.keys()].filter(id => !afterById.has(id));
  const changedSummaries = [];
  let historyBefore = 0;
  let historyAfter = 0;
  let linkBefore = 0;
  let linkAfter = 0;

  for (const task of normalizeArray(beforeData.tasks)) {
    historyBefore += normalizeArray(task.history).length;
    linkBefore += countLinks(task);
    const after = afterById.get(task.id);
    if (after && (after.summary || '') !== (task.summary || '')) changedSummaries.push(task.id);
  }
  for (const task of normalizeArray(afterData.tasks)) {
    historyAfter += normalizeArray(task.history).length;
    linkAfter += countLinks(task);
  }

  return {
    taskCountBefore: normalizeArray(beforeData.tasks).length,
    taskCountAfter: normalizeArray(afterData.tasks).length,
    deletedTaskIds,
    changedSummaries,
    historyBefore,
    historyAfter,
    linkBefore,
    linkAfter
  };
}

function assertStructureInvariantGate(invariants) {
  const reasons = [];
  if (invariants.taskCountAfter < invariants.taskCountBefore) {
    reasons.push(`task count ${invariants.taskCountBefore}->${invariants.taskCountAfter}`);
  }
  if (invariants.deletedTaskIds.length) {
    reasons.push(`deleted task ids: ${invariants.deletedTaskIds.join(', ')}`);
  }
  if (invariants.changedSummaries.length) {
    reasons.push(`summary changed for: ${invariants.changedSummaries.join(', ')}`);
  }
  if (invariants.historyAfter < invariants.historyBefore) {
    reasons.push(`history ${invariants.historyBefore}->${invariants.historyAfter}`);
  }
  if (invariants.linkAfter < invariants.linkBefore) {
    reasons.push(`links ${invariants.linkBefore}->${invariants.linkAfter}`);
  }
  if (reasons.length) {
    throw new Error(`Structure migration invariant gate failed (${reasons.join('; ')})`);
  }
}

function compactBatchSummary(summary) {
  return {
    batchIndex: summary.batchIndex,
    targetTaskIds: summary.targetTaskIds,
    markersParsed: summary.markersParsed,
    markersAllowed: summary.markersAllowed,
    markersHeld: summary.markersHeld,
    markersApplied: summary.markersApplied,
    fallbackTasks: summary.fallbackTasks,
    migratedTargetIds: summary.migratedTargetIds,
    needsReviewTargetIds: summary.needsReviewTargetIds,
    workIqCalls: summary.workIqCalls,
    gatewayWorkIqCalls: summary.gatewayWorkIqCalls,
    qualityGate: summary.qualityGate,
    droppedByStructureGuard: summary.droppedByStructureGuard,
    droppedByApplier: summary.droppedByApplier
  };
}

function scanDoneWorkIq(markers, fallback) {
  const scanDone = markers.find(marker => marker.type === 'SCAN_DONE')?.payload || {};
  return Number(scanDone.workIqCalls ?? fallback ?? 0) || 0;
}

async function gatewayFilterMarkers({
  markers,
  state,
  brainWorkDir,
  runId,
  _runGateway
}) {
  if (!markers.length) {
    return {
      markers: [],
      approved: [],
      held: [],
      reviewMarkers: [],
      gatewayParsed: true,
      gatewayParseError: null,
      decisions: [],
      gatewayWorkIqCalls: 0
    };
  }
  const gatewayResult = await _runGateway({
    stateFile: state.stateFile,
    factSheetFiles: state.factSheetFiles,
    markers,
    brainWorkDir,
    runId
  });
  const filtered = filterMarkersThroughGateway(markers, gatewayResult);
  return {
    ...filtered,
    gatewayWorkIqCalls: gatewayResult.counters?.workIqCalls || 0,
    gatewayOk: Boolean(gatewayResult.ok)
  };
}

export async function runStructureMigrationDryRun({
  tasksFile = DEFAULT_TASKS_FILE,
  skillFile = DEFAULT_SKILL_FILE,
  batch7File = DEFAULT_BATCH7_FILE,
  previewFile = DEFAULT_PREVIEW_FILE,
  brainWorkDir = DEFAULT_BRAIN_WORK_DIR,
  batchSize = DEFAULT_BATCH_SIZE,
  now = new Date(),
  runId = `structure-${Date.now()}`,
  targetIds = null,
  maxBatches = null,
  allowFallback = true,
  _readJsonFile = readJsonFile,
  _writeJsonFileAtomic = writeJsonFileAtomic,
  _runBrain = runBrain,
  _runGateway = runRealityGateway,
  _parseMarkers = parseMarkers,
  _applyMarkerBatch = applyMarkerBatch
} = {}) {
  const tasksHashBefore = sha256File(tasksFile);
  const originalData = migrateToV5(_readJsonFile(tasksFile));
  const sanitized = sanitizeGarbageDates(originalData);
  let workingData = sanitized.data;
  const targets = selectStructureMigrationTargets(workingData, { targetIds });
  const targetIdList = targets.map(task => task.id);
  const batches = chunked(targets, Math.max(1, Number(batchSize) || DEFAULT_BATCH_SIZE));
  const selectedBatches = maxBatches === null ? batches : batches.slice(0, Math.max(0, Number(maxBatches) || 0));
  const skillText = fs.readFileSync(skillFile, 'utf8');
  const batch7Text = fs.readFileSync(batch7File, 'utf8');
  const allMarkers = [];
  const batchSummaries = [];
  const stats = {
    mode: 'dry-run',
    targetCount: targetIdList.length,
    batches: selectedBatches.length,
    markersParsed: 0,
    markersApplied: 0,
    markersHeld: 0,
    markersDropped: 0,
    workIqCalls: 0,
    gatewayWorkIqCalls: 0,
    fallbackTasks: 0
  };

  for (let index = 0; index < selectedBatches.length; index++) {
    const batch = selectedBatches[index];
    const batchIndex = index + 1;
    const batchTargetIds = batch.map(task => task.id);
    const liveBatchTasks = batchTargetIds.map(id => taskById(workingData, id)).filter(Boolean);
    const state = writeStructureBatchState({
      data: workingData,
      tasks: liveBatchTasks,
      brainWorkDir,
      runId,
      batchIndex,
      totalBatches: selectedBatches.length,
      now
    });
    const prompt = buildStructureMigrationPrompt({
      skillText,
      batch7Text,
      stateFileName: state.stateFileName,
      factSheetFiles: state.factSheetFiles,
      runId,
      batchIndex,
      totalBatches: selectedBatches.length
    });
    const brainResult = await _runBrain({
      prompt,
      brainWorkDir: state.brainWorkDir,
      timeoutMs: 25 * 60 * 1000,
      workIqHardLimit: DEFAULT_WORKIQ_LIMIT,
      cleanBrainWorkDir: false
    });
    if (!brainResult.ok) {
      throw new Error(brainResult.error?.message || `Structure migration brain run failed for batch ${batchIndex}`);
    }

    const parsed = _parseMarkers(brainResult.assistantText || brainResult.text || '');
    const guarded = normalizeStructureMarkers(parsed.markers, batchTargetIds);
    const filtered = await gatewayFilterMarkers({
      markers: guarded.markers,
      state,
      brainWorkDir: state.brainWorkDir,
      runId: `${runId}-gateway-${batchIndex}`,
      _runGateway
    });
    const qualityGate = evaluateProcessingQualityGate(filtered.markers);
    const applyResult = _applyMarkerBatch(workingData, filtered.markers, {
      now,
      runId,
      auditLogFile: null
    });
    workingData = applyResult.data;
    allMarkers.push(...filtered.markers.filter(marker => {
      return !applyResult.dropped.some(drop => drop.raw && marker.raw && drop.raw === marker.raw);
    }));

    let fallbackMarkers = [];
    let fallbackFiltered = null;
    let fallbackApplyResult = null;
    const notMigrated = batchTargetIds.filter(id => !hasNewStructure(taskById(workingData, id)));
    if (allowFallback && notMigrated.length) {
      fallbackMarkers = notMigrated.flatMap(id => {
        const task = taskById(workingData, id);
        return task ? buildFallbackStructureMarkers(task, { now, runId: `${runId}-fallback-${batchIndex}-${safeFilePart(id)}` }) : [];
      });
      fallbackFiltered = await gatewayFilterMarkers({
        markers: fallbackMarkers,
        state,
        brainWorkDir: state.brainWorkDir,
        runId: `${runId}-fallback-gateway-${batchIndex}`,
        _runGateway
      });
      fallbackApplyResult = _applyMarkerBatch(workingData, fallbackFiltered.markers, {
        now,
        runId,
        auditLogFile: null
      });
      workingData = fallbackApplyResult.data;
      allMarkers.push(...fallbackFiltered.markers.filter(marker => {
        return !fallbackApplyResult.dropped.some(drop => drop.raw && marker.raw && drop.raw === marker.raw);
      }));
    }

    const migratedTargetIds = migratedIdsFor(workingData, batchTargetIds);
    const needsReviewTargetIds = needsReviewIdsFor(workingData, batchTargetIds);
    const summary = {
      batchIndex,
      targetTaskIds: batchTargetIds,
      stateFile: state.stateFile,
      factSheetFiles: state.factSheetFiles,
      markersParsed: parsed.markers.length,
      parseErrors: parsed.errors,
      markersAllowed: guarded.markers.length,
      droppedByStructureGuard: guarded.dropped.map(item => ({ type: item.marker?.type, reason: item.reason })),
      markersHeld: filtered.held.length + (fallbackFiltered?.held.length || 0),
      markersApplied: applyResult.applied + (fallbackApplyResult?.applied || 0),
      droppedByApplier: [...applyResult.dropped, ...(fallbackApplyResult?.dropped || [])],
      fallbackTasks: notMigrated,
      migratedTargetIds,
      needsReviewTargetIds,
      workIqCalls: scanDoneWorkIq(parsed.markers, brainResult.counters?.workIqCalls || 0),
      gatewayWorkIqCalls: filtered.gatewayWorkIqCalls + (fallbackFiltered?.gatewayWorkIqCalls || 0),
      qualityGate: {
        ok: qualityGate.ok,
        reason: qualityGate.reason || null,
        ledgerCount: qualityGate.ledgerCount,
        skipped: Boolean(qualityGate.skipped)
      }
    };
    batchSummaries.push(summary);

    stats.markersParsed += parsed.markers.length;
    stats.markersApplied += summary.markersApplied;
    stats.markersHeld += summary.markersHeld;
    stats.markersDropped += guarded.dropped.length + applyResult.dropped.length + (fallbackApplyResult?.dropped.length || 0);
    stats.workIqCalls += summary.workIqCalls;
    stats.gatewayWorkIqCalls += summary.gatewayWorkIqCalls;
    stats.fallbackTasks += notMigrated.length;
  }

  const tasksHashAfter = sha256File(tasksFile);
  if (tasksHashBefore !== tasksHashAfter) {
    throw new Error('Dry-run aborted: tasks.json changed while structure migration dry-run was running');
  }

  const migratedTargetIds = migratedIdsFor(workingData, targetIdList);
  const needsReviewTargetIds = needsReviewIdsFor(workingData, targetIdList);
  const invariants = summarizeInvariants(sanitized.data, workingData);
  assertStructureInvariantGate(invariants);

  const preview = {
    runId,
    mode: 'dry-run',
    generatedAt: nowIso(new Date()),
    tasksFile,
    tasksHashBefore,
    tasksHashAfter,
    dryRunMutatedTasks: tasksHashBefore !== tasksHashAfter,
    targetIds: targetIdList,
    migratedTargetIds,
    needsReviewTargetIds,
    dateCleanups: sanitized.cleaned,
    markers: allMarkers,
    batches: batchSummaries.map(compactBatchSummary),
    stats,
    invariants,
    outcome: migratedTargetIds.length === targetIdList.length ? 'success' : 'partial',
    partialReason: migratedTargetIds.length === targetIdList.length ? null : 'Not every target task reached the new structure in dry-run simulation.'
  };

  _writeJsonFileAtomic(previewFile, preview, { maxBackups: 1 });
  return preview;
}

export function applyStructureMigrationPreview({
  tasksFile = DEFAULT_TASKS_FILE,
  previewFile = DEFAULT_PREVIEW_FILE,
  now = new Date(),
  allowStalePreview = false,
  _readJsonFile = readJsonFile,
  _writeJsonFileAtomic = writeJsonFileAtomic,
  _applyMarkerBatch = applyMarkerBatch
} = {}) {
  const preview = _readJsonFile(previewFile);
  const currentHash = sha256File(tasksFile);
  if (!allowStalePreview && preview.tasksHashBefore && currentHash !== preview.tasksHashBefore) {
    throw new Error('Apply aborted: tasks.json no longer matches the dry-run preview hash');
  }

  const originalData = migrateToV5(_readJsonFile(tasksFile));
  const sanitized = sanitizeGarbageDates(originalData);
  const beforeData = sanitized.data;
  const markers = normalizeArray(preview.markers);
  const applyResult = _applyMarkerBatch(beforeData, markers, {
    now,
    runId: preview.runId || `structure-apply-${Date.now()}`,
    auditLogFile: null
  });

  if (applyResult.dropped.length) {
    throw new Error(`Apply aborted: ${applyResult.dropped.length} preview marker(s) no longer validate`);
  }

  const invariants = summarizeInvariants(beforeData, applyResult.data);
  assertStructureInvariantGate(invariants);
  const targetIds = normalizeArray(preview.targetIds);
  const migratedTargetIds = migratedIdsFor(applyResult.data, targetIds);
  const needsReviewTargetIds = needsReviewIdsFor(applyResult.data, targetIds);
  _writeJsonFileAtomic(tasksFile, applyResult.data);

  return {
    mode: 'apply',
    tasksFile,
    appliedMarkers: applyResult.applied,
    dateCleanups: sanitized.cleaned,
    targetIds,
    migratedTargetIds,
    needsReviewTargetIds,
    invariants,
    wrote: true,
    outcome: migratedTargetIds.length === targetIds.length ? 'success' : 'partial',
    partialReason: migratedTargetIds.length === targetIds.length ? null : 'Not every target task reached the new structure after apply.'
  };
}

export function writeResultReport(result, {
  reportFile = DEFAULT_REPORT_FILE,
  previewFile = DEFAULT_PREVIEW_FILE
} = {}) {
  const targetCount = normalizeArray(result.targetIds).length;
  const migratedCount = normalizeArray(result.migratedTargetIds).length;
  const needsReviewCount = normalizeArray(result.needsReviewTargetIds).length;
  const ok = result.outcome === 'success' && migratedCount === targetCount;
  const firstLine = ok
    ? `MIGSTRUCT: OK ${migratedCount}/${needsReviewCount}`
    : `MIGSTRUCT: PARTIAL ${result.partialReason || `${migratedCount}/${targetCount} migrated`}`;
  const lines = [
    firstLine,
    '',
    `- Mode: ${result.mode}`,
    `- Tasks considered for migration: ${targetCount}`,
    `- Tasks migrated to the new structure: ${migratedCount}`,
    `- Tasks flagged for review: ${needsReviewCount}`,
    `- Garbage date values cleaned: ${normalizeArray(result.dateCleanups).length}`,
    `- Preview file: ${path.relative(REPO_ROOT, previewFile)}`,
    `- Generated at: ${nowIso(new Date())}`
  ];
  fs.mkdirSync(path.dirname(reportFile), { recursive: true });
  fs.writeFileSync(reportFile, `${lines.join('\n')}\n`, 'utf8');
  return { reportFile, firstLine };
}

function parseArgs(argv) {
  const options = { mode: 'dry-run', writeReport: false, allowFallback: true, allowStalePreview: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.mode = 'dry-run';
    else if (arg === '--apply') options.mode = 'apply';
    else if (arg === '--tasks-file') options.tasksFile = argv[++i];
    else if (arg === '--preview-file') options.previewFile = argv[++i];
    else if (arg === '--report-file') options.reportFile = argv[++i];
    else if (arg === '--brain-work-dir') options.brainWorkDir = argv[++i];
    else if (arg === '--batch-size') options.batchSize = Number(argv[++i]);
    else if (arg === '--max-batches') options.maxBatches = Number(argv[++i]);
    else if (arg === '--target-id') {
      options.targetIds = normalizeArray(options.targetIds);
      options.targetIds.push(argv[++i]);
    } else if (arg === '--no-fallback') options.allowFallback = false;
    else if (arg === '--allow-stale-preview') options.allowStalePreview = true;
    else if (arg === '--write-report') options.writeReport = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log([
    'Usage: node scripts/migrate-structure.mjs [--dry-run|--apply] [options]',
    '',
    'Migrates active legacy tasks to the Batch 7 structure in batches of about five tasks.',
    'Dry-run renders batch state, runs Agency Brain plus Reality Gateway, and writes a preview under tests/runs by default.',
    'Apply replays the validated preview markers, cleans garbage date values, and writes tasks.json atomically with backups.',
    '',
    'Options:',
    '  --batch-size <n>          Default: 5',
    '  --max-batches <n>        Limit dry-run batches',
    '  --target-id <id>         Restrict to one or more task IDs',
    '  --preview-file <path>    Default: tests/runs/structure-migration-preview.json',
    '  --brain-work-dir <path>  Must end with brain-work',
    '  --write-report           Write docs/gremium/RESULT-MIGRATE-STRUCTURE.md',
    '  --no-fallback            Do not add low-confidence fallback structure for unverified tasks'
  ].join('\n'));
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  if (options.mode === 'apply') {
    const result = applyStructureMigrationPreview(options);
    if (options.writeReport) writeResultReport(result, options);
    console.log(JSON.stringify({
      mode: 'apply',
      appliedMarkers: result.appliedMarkers,
      migrated: result.migratedTargetIds.length,
      targetCount: result.targetIds.length,
      needsReview: result.needsReviewTargetIds.length,
      dateCleanups: result.dateCleanups.length,
      outcome: result.outcome
    }, null, 2));
    return;
  }

  const preview = await runStructureMigrationDryRun(options);
  if (options.writeReport) writeResultReport(preview, options);
  console.log(JSON.stringify({
    mode: 'dry-run',
    previewFile: options.previewFile || DEFAULT_PREVIEW_FILE,
    targetCount: preview.targetIds.length,
    migrated: preview.migratedTargetIds.length,
    needsReview: preview.needsReviewTargetIds.length,
    batches: preview.batches.length,
    markers: preview.markers.length,
    held: preview.stats.markersHeld,
    fallbackTasks: preview.stats.fallbackTasks,
    workIqCalls: preview.stats.workIqCalls,
    dateCleanups: preview.dateCleanups.length,
    outcome: preview.outcome
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch(err => {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  });
}
