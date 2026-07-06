#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAIN_WORK_DIR } from '../brain/agency-cli.js';
import { prepareBrainWorkDir, runBrain } from '../brain/brain-runner.js';
import { renderFactSheetMarkdown } from '../brain/factsheet.js';
import { parseMarkers } from '../brain/marker-parser.js';
import { applyMarkerBatch } from '../brain/marker-applier.js';
import { filterMarkersThroughGateway, runRealityGateway } from '../brain/reality-gateway.js';
import { migrateToV5, writeJsonFileAtomic } from '../brain/tasks-v5.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_TASKS_FILE = path.join(REPO_ROOT, 'tasks.json');
export const REVERIFY_REPAIR_ID = 'batch6-reverify-sweep';
export const DEFAULT_BATCH_SIZE = 5;
export const DEFAULT_WORKIQ_LIMIT = 40;

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function safeFilePart(value) {
  return String(value || 'task')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 80) || 'task';
}

function isActiveTask(task) {
  return task && !task.archived && !task.supersededBy && task.status !== 'done';
}

function chunked(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) chunks.push(items.slice(i, i + size));
  return chunks;
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

function writeBatchState({ data, tasks, brainWorkDir, runId, batchIndex, now }) {
  const dir = prepareBrainWorkDir(brainWorkDir);
  const factSheetFiles = [];
  const renderedTasks = [];

  for (const task of tasks) {
    const factSheetFile = `reverify-factsheet-${safeFilePart(task.id)}-${safeFilePart(runId)}.md`;
    fs.writeFileSync(path.join(dir, factSheetFile), renderFactSheetMarkdown(task), 'utf8');
    factSheetFiles.push(factSheetFile);
    renderedTasks.push({
      id: task.id,
      taskType: task.taskType || 'single',
      title: task.title || '',
      status: task.status || '',
      summary: task.summary || '',
      pmStatus: task.pmStatus || null,
      lineItems: normalizeArray(task.lineItems),
      factSheetFile,
      sourceRefs: sourceRefsForContext(task),
      recentHistory: normalizeArray(task.history).slice(-8).map(entry => ({
        timestamp: entry.timestamp || null,
        type: entry.type || null,
        text: entry.text || '',
        agentResponse: entry.agentResponse || null
      }))
    });
  }

  const state = {
    renderedAt: nowIso(now),
    runId,
    batchIndex,
    activeTaskIdsInBatch: tasks.map(task => task.id),
    invariant: 'Review every claim in pmStatus, lineItems, factSheet, and summary for support, ownership, project assignment, and freshness.',
    taskCountTotal: normalizeArray(data.tasks).length,
    tasks: renderedTasks
  };
  const stateFileName = `reverify-state-${safeFilePart(runId)}-batch-${batchIndex}.json`;
  fs.writeFileSync(path.join(dir, stateFileName), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  return {
    brainWorkDir: dir,
    stateFile: path.join(dir, stateFileName),
    stateFileName,
    factSheetFiles
  };
}

function buildPrompt({ stateFileName, factSheetFiles, runId, batchIndex }) {
  return [
    '# Agent Zero Batch 6 Re-Verification Sweep',
    '',
    'You are repairing existing Agent Zero task state. Read the batch state JSON and all listed Fact Sheet files.',
    'Use WorkIQ when current M365 evidence is needed. Emit only valid marker lines and short non-marker notes if partial.',
    '',
    `runId: ${runId}`,
    `batchIndex: ${batchIndex}`,
    `stateFile: ./${stateFileName}`,
    `factSheetFiles: ${factSheetFiles.map(name => `./${name}`).join(', ')}`,
    '',
    'For every active task in this batch, verify every statement in summary, pmStatus, lineItems, and Fact Sheet:',
    '- Is the statement supported by sourceRefs or current WorkIQ mailbox evidence?',
    '- Is it assigned to the correct project, country, organization, and location?',
    '- Is it current rather than stale?',
    '- Is every pmStatus.userActions entry truly an action Martin personally must do?',
    '- Are actions for other people represented as lineItems or Fact Sheet Open Actions with explicit owner?',
    '- For user actions marked done by Martin, does current evidence confirm closure or show still open?',
    '',
    'Repair rules:',
    '- Prefer FACTSHEET_UPDATE corrective patches and PROJECT_UPDATE/LINEITEM_UPDATE markers over narration.',
    '- Low-confidence ownership or status becomes NEEDS_REVIEW.',
    '- Never silently drop an open action. Foreign-owner actions must move to a lineItem or Fact Sheet Open Action with owner.',
    '- Reuse existing task IDs, lineItem IDs, sourceRef IDs, and userAction IDs.',
    '- PROJECT_UPDATE.pmStatus replaces pmStatus; re-emit entries that should remain.',
    '- Do not delete sourceRefs. If evidence should no longer support a statement, detach it from the statement or move the statement to review.',
    '- Every status, problem, risk, waiting, or user-action change needs evidenceRefIds.',
    '- End with SCAN_DONE for this batch.'
  ].join('\n');
}

function evidenceIdsFromPmEntry(entry) {
  const ids = [];
  if (entry?.evidence) ids.push(entry.evidence);
  if (entry?.evidenceRefId) ids.push(entry.evidenceRefId);
  if (entry?.sourceRefId) ids.push(entry.sourceRefId);
  ids.push(...normalizeArray(entry?.evidenceRefIds));
  return ids.filter(Boolean).map(String);
}

function countSigma(data) {
  const result = {
    pmStatusEntries: 0,
    lineItems: 0,
    factSheetEntries: 0,
    sourceRefs: 0,
    history: 0,
    reviewQueue: normalizeArray(data.reviewQueue).length,
    total: 0
  };
  for (const task of normalizeArray(data.tasks)) {
    const pm = task.pmStatus || {};
    if (pm.current) result.pmStatusEntries++;
    for (const field of ['planned', 'userActions', 'problems', 'risks', 'waitingOn']) {
      result.pmStatusEntries += normalizeArray(pm[field]).length;
    }
    result.lineItems += normalizeArray(task.lineItems).length;
    result.sourceRefs += normalizeArray(task.sourceRefs).length;
    result.history += normalizeArray(task.history).length;
    const sections = task.factSheet?.sections || {};
    for (const entries of Object.values(sections)) {
      if (Array.isArray(entries)) result.factSheetEntries += entries.filter(entry => !entry?.removedAt).length;
    }
  }
  result.total = result.pmStatusEntries + result.lineItems + result.factSheetEntries + result.sourceRefs + result.history + result.reviewQueue;
  return result;
}

function danglingRefs(data) {
  const dangling = [];
  for (const task of normalizeArray(data.tasks)) {
    const refs = new Set(normalizeArray(task.sourceRefs).map(ref => ref.id).filter(Boolean));
    for (const item of normalizeArray(task.lineItems)) {
      for (const id of normalizeArray(item.evidenceRefIds)) {
        if (!refs.has(id)) dangling.push({ taskId: task.id, ownerId: item.id, field: 'lineItems.evidenceRefIds', id });
      }
    }
    const sections = task.factSheet?.sections || {};
    for (const [section, entries] of Object.entries(sections)) {
      for (const entry of normalizeArray(entries)) {
        for (const id of normalizeArray(entry?.evidenceRefIds)) {
          if (!refs.has(id)) dangling.push({ taskId: task.id, ownerId: entry.id, field: `factSheet.${section}.evidenceRefIds`, id });
        }
      }
    }
    const pm = task.pmStatus || {};
    for (const field of ['planned', 'userActions', 'problems', 'risks', 'waitingOn']) {
      for (const entry of normalizeArray(pm[field])) {
        for (const id of evidenceIdsFromPmEntry(entry)) {
          if (!refs.has(id)) dangling.push({ taskId: task.id, ownerId: entry.id || entry.text, field: `pmStatus.${field}`, id });
        }
      }
    }
  }
  return dangling;
}

function removalKey(taskId, field, value) {
  const id = value?.id || value?.evidence || value?.text || JSON.stringify(value).slice(0, 120);
  return `${taskId}:${field}:${id}`;
}

function hasReviewEntry(data, key) {
  return normalizeArray(data.reviewQueue).some(entry => entry.repairId === REVERIFY_REPAIR_ID && entry.key === key);
}

function pushReview(data, { key, ref, question, payload }, now) {
  data.reviewQueue = normalizeArray(data.reviewQueue);
  if (hasReviewEntry(data, key)) return false;
  data.reviewQueue.push({
    kind: 'other',
    ref,
    question,
    confidence: 'low',
    createdAt: nowIso(now),
    repairId: REVERIFY_REPAIR_ID,
    key,
    payload
  });
  return true;
}

function entryComparableKey(entry) {
  if (!entry || typeof entry !== 'object') return String(entry || '');
  return entry.id || `${entry.text || ''}|${entry.evidence || ''}|${normalizeArray(entry.evidenceRefIds).join(',')}`;
}

function addRemovedEntriesToReview(beforeData, afterData, taskIds, now) {
  let added = 0;
  const afterById = new Map(normalizeArray(afterData.tasks).map(task => [task.id, task]));
  const beforeById = new Map(normalizeArray(beforeData.tasks).map(task => [task.id, task]));

  for (const taskId of taskIds) {
    const before = beforeById.get(taskId);
    const after = afterById.get(taskId);
    if (!before || !after) continue;

    const beforePm = before.pmStatus || {};
    const afterPm = after.pmStatus || {};
    for (const field of ['planned', 'userActions', 'problems', 'risks', 'waitingOn']) {
      const afterKeys = new Set(normalizeArray(afterPm[field]).map(entryComparableKey));
      for (const entry of normalizeArray(beforePm[field])) {
        if (afterKeys.has(entryComparableKey(entry))) continue;
        if (pushReview(afterData, {
          key: removalKey(taskId, `pmStatus.${field}`, entry),
          ref: taskId,
          question: `Batch 6 re-verification removed or reclassified pmStatus.${field}; retained verbatim for review.`,
          payload: { field: `pmStatus.${field}`, entry }
        }, now)) added++;
      }
    }

    const afterLineIds = new Set(normalizeArray(after.lineItems).map(item => item.id));
    for (const item of normalizeArray(before.lineItems)) {
      if (!item.id || afterLineIds.has(item.id)) continue;
      if (pushReview(afterData, {
        key: removalKey(taskId, 'lineItems', item),
        ref: taskId,
        question: 'Batch 6 re-verification removed a line item; retained verbatim for review.',
        payload: { lineItem: item }
      }, now)) added++;
    }
  }

  return added;
}

function subtractSigma(before, after) {
  return Object.fromEntries(Object.keys(before).map(key => [key, (after[key] || 0) - (before[key] || 0)]));
}

function compactStats(stats) {
  return [
    `tasks=${stats.tasksSeen}`,
    `batches=${stats.batches}`,
    `markers=${stats.markersParsed}`,
    `applied=${stats.markersApplied}`,
    `held=${stats.markersHeld}`,
    `review=${stats.reviewEntriesAdded}`,
    `dangling=${stats.danglingAfter}`
  ].join(' ');
}

export async function runReverifyTasks({
  tasksFile = DEFAULT_TASKS_FILE,
  apply = false,
  batchSize = DEFAULT_BATCH_SIZE,
  brainWorkDir = BRAIN_WORK_DIR,
  now = new Date(),
  runId = `reverify-${Date.now()}`,
  maxBatches = null,
  _readJsonFile = readJsonFile,
  _writeJsonFileAtomic = writeJsonFileAtomic,
  _runBrain = runBrain,
  _runGateway = runRealityGateway,
  _parseMarkers = parseMarkers,
  _applyMarkerBatch = applyMarkerBatch
} = {}) {
  const originalData = migrateToV5(_readJsonFile(tasksFile));
  let workingData = originalData;
  const active = normalizeArray(originalData.tasks).filter(isActiveTask);
  const batches = chunked(active, Math.max(1, batchSize));
  const selectedBatches = maxBatches === null ? batches : batches.slice(0, Math.max(0, maxBatches));
  const sigmaBefore = countSigma(originalData);
  const danglingBefore = danglingRefs(originalData);
  const batchSummaries = [];
  const stats = {
    tasksSeen: active.length,
    batches: selectedBatches.length,
    markersParsed: 0,
    markersApplied: 0,
    markersDropped: 0,
    markersHeld: 0,
    reviewEntriesAdded: 0,
    workIqCalls: 0,
    gatewayWorkIqCalls: 0,
    wrote: false,
    mode: apply ? 'apply' : 'dry-run',
    compact: ''
  };

  for (let index = 0; index < selectedBatches.length; index++) {
    const batch = selectedBatches[index];
    const batchTaskIds = batch.map(task => task.id);
    const state = writeBatchState({
      data: workingData,
      tasks: batchTaskIds.map(id => normalizeArray(workingData.tasks).find(task => task.id === id)).filter(Boolean),
      brainWorkDir,
      runId,
      batchIndex: index + 1,
      now
    });
    const prompt = buildPrompt({
      stateFileName: state.stateFileName,
      factSheetFiles: state.factSheetFiles,
      runId,
      batchIndex: index + 1
    });
    const brainResult = await _runBrain({
      prompt,
      brainWorkDir: state.brainWorkDir,
      timeoutMs: 25 * 60 * 1000,
      workIqHardLimit: DEFAULT_WORKIQ_LIMIT,
      cleanBrainWorkDir: false
    });
    if (!brainResult.ok) {
      throw new Error(brainResult.error?.message || `Reverify brain run failed for batch ${index + 1}`);
    }
    stats.workIqCalls += brainResult.counters?.workIqCalls || 0;
    const parsed = _parseMarkers(brainResult.assistantText || brainResult.text || '');
    stats.markersParsed += parsed.markers.length;

    const gatewayResult = await _runGateway({
      stateFile: state.stateFile,
      factSheetFiles: state.factSheetFiles,
      markers: parsed.markers,
      brainWorkDir: state.brainWorkDir,
      runId: `${runId}-gateway-${index + 1}`
    });
    stats.gatewayWorkIqCalls += gatewayResult.counters?.workIqCalls || 0;
    const filtered = filterMarkersThroughGateway(parsed.markers, gatewayResult);
    stats.markersHeld += filtered.held.length;

    const beforeBatchData = workingData;
    const applyResult = _applyMarkerBatch(workingData, filtered.markers, {
      now,
      runId,
      auditLogFile: null
    });
    workingData = applyResult.data;
    const reviewAdded = addRemovedEntriesToReview(beforeBatchData, workingData, batchTaskIds, now);

    stats.markersApplied += applyResult.applied;
    stats.markersDropped += applyResult.dropped.length;
    stats.reviewEntriesAdded += reviewAdded;
    batchSummaries.push({
      index: index + 1,
      taskIds: batchTaskIds,
      markersParsed: parsed.markers.length,
      markersApplied: applyResult.applied,
      markersHeld: filtered.held.length,
      markersDropped: applyResult.dropped.length,
      reviewEntriesAdded: reviewAdded,
      parseErrors: parsed.errors
    });
  }

  const sigmaAfter = countSigma(workingData);
  const danglingAfter = danglingRefs(workingData);
  const newDangling = Math.max(0, danglingAfter.length - danglingBefore.length);
  const changed = JSON.stringify(originalData) !== JSON.stringify(workingData);
  if (newDangling > 0) {
    throw new Error(`Reverify sweep would introduce ${newDangling} dangling evidence reference(s)`);
  }
  if (apply && changed) {
    _writeJsonFileAtomic(tasksFile, workingData);
    stats.wrote = true;
  }

  stats.danglingBefore = danglingBefore.length;
  stats.danglingAfter = danglingAfter.length;
  stats.compact = compactStats(stats);

  return {
    mode: stats.mode,
    tasksFile,
    runId,
    changed,
    wrote: stats.wrote,
    stats,
    sigmaBefore,
    sigmaAfter,
    sigmaDelta: subtractSigma(sigmaBefore, sigmaAfter),
    batchSummaries
  };
}

function parseArgs(argv) {
  const options = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.apply = false;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--tasks-file') options.tasksFile = argv[++i];
    else if (arg === '--batch-size') options.batchSize = Number.parseInt(argv[++i], 10);
    else if (arg === '--max-batches') options.maxBatches = Number.parseInt(argv[++i], 10);
    else if (arg === '--run-id') options.runId = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log([
    'Usage: node scripts/reverify-tasks.mjs [--dry-run|--apply] [--tasks-file <path>] [--batch-size 5]',
    '',
    'Runs the Batch 6 re-verification sweep through Agency Brain, Reality Gateway, and applyMarkerBatch.',
    'Default mode is --dry-run. --apply writes tasks.json atomically with backup rotation.'
  ].join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    const result = await runReverifyTasks(options);
    console.log(JSON.stringify({
      mode: result.mode,
      changed: result.changed,
      wrote: result.wrote,
      stats: result.stats,
      sigmaBefore: result.sigmaBefore,
      sigmaAfter: result.sigmaAfter,
      sigmaDelta: result.sigmaDelta
    }, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
}
