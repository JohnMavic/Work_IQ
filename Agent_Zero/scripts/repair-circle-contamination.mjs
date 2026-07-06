#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateToV5, V5_BRAIN_STATE_DEFAULTS, writeJsonFileAtomic } from '../brain/tasks-v5.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_TASKS_FILE = path.join(REPO_ROOT, 'tasks.json');
export const CIRCLE_TASK_ID = 'proj-zurich-circle-hublcr';
export const CONTAMINATED_REFS = new Set(['src-zones-aug-1783', 'src-moerken-20260701', 'src-2579f860']);
const REPAIR_ID = 'batch5-6b-circle-contamination';

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
}

function referencesContamination(value) {
  if (!value) return false;
  if (typeof value === 'string') {
    return /moerken|august deployment|repeated schedule misses|external venue|zones hardware delivery|cannot confirm mpr hardware/i.test(value);
  }
  if (Array.isArray(value)) return value.some(referencesContamination);
  if (typeof value === 'object') {
    if (normalizeArray(value.evidenceRefIds).some(id => CONTAMINATED_REFS.has(id))) return true;
    if (CONTAMINATED_REFS.has(value.evidence)) return true;
    return Object.values(value).some(referencesContamination);
  }
  return false;
}

function stripContaminatedSentences(text) {
  return String(text || '')
    .split(/(?<=[.!?])\s+/)
    .filter(sentence => !referencesContamination(sentence))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function hasRepairEntry(data, key) {
  return normalizeArray(data.reviewQueue).some(entry => entry.repairId === REPAIR_ID && entry.key === key);
}

function pushReview(data, { key, ref, question, payload }, now) {
  data.reviewQueue = normalizeArray(data.reviewQueue);
  if (hasRepairEntry(data, key)) return;
  data.reviewQueue.push({
    kind: 'other',
    ref,
    question,
    confidence: 'low',
    createdAt: nowIso(now),
    repairId: REPAIR_ID,
    key,
    payload
  });
}

function cleanPmStatus(data, task, now) {
  let changed = false;
  if (!task.pmStatus || typeof task.pmStatus !== 'object') return changed;

  const beforeCurrent = task.pmStatus.current || '';
  const afterCurrent = stripContaminatedSentences(beforeCurrent);
  if (afterCurrent !== beforeCurrent) {
    pushReview(data, {
      key: 'pmStatus.current',
      ref: task.id,
      question: 'Batch 5 repair moved contaminated Moerken/Norway narrative out of Zurich The Circle pmStatus.current.',
      payload: { field: 'pmStatus.current', value: beforeCurrent }
    }, now);
    task.pmStatus.current = afterCurrent;
    changed = true;
  }

  for (const field of ['planned', 'userActions', 'problems', 'risks', 'waitingOn']) {
    const kept = [];
    for (const entry of normalizeArray(task.pmStatus[field])) {
      if (referencesContamination(entry)) {
        pushReview(data, {
          key: `pmStatus.${field}.${entry.evidence || entry.text || kept.length}`,
          ref: task.id,
          question: `Batch 5 repair moved contaminated Moerken/Norway entry out of Zurich The Circle pmStatus.${field}.`,
          payload: { field: `pmStatus.${field}`, entry }
        }, now);
        changed = true;
      } else {
        kept.push(entry);
      }
    }
    task.pmStatus[field] = kept;
  }

  return changed;
}

function cleanLineItems(data, task, now) {
  let changed = false;
  const kept = [];

  for (const item of normalizeArray(task.lineItems)) {
    if (item.id === 'li-circle-zones-handover') {
      pushReview(data, {
        key: `lineItem.${item.id}`,
        ref: task.id,
        question: 'Batch 5 repair moved contaminated Zones/Moerken delivery-risk line item out of Zurich The Circle.',
        payload: { lineItem: item }
      }, now);
      changed = true;
      continue;
    }

    if (item.id === 'li-circle-timeline' && referencesContamination(item.currentState)) {
      pushReview(data, {
        key: `lineItem.${item.id}.currentState`,
        ref: task.id,
        question: 'Batch 5 repair removed contaminated Moerken schedule-miss narrative from Zurich The Circle timeline line item.',
        payload: { lineItem: { ...item } }
      }, now);
      item.currentState = stripContaminatedSentences(item.currentState);
      item.reviewReason = item.reviewReason || 'Moerken/Norway timing conflict moved to reviewQueue by Batch 5 repair.';
      item.needsReview = true;
      changed = true;
    }

    const evidenceBefore = normalizeArray(item.evidenceRefIds);
    item.evidenceRefIds = evidenceBefore.filter(id => !CONTAMINATED_REFS.has(id));
    if (item.evidenceRefIds.length !== evidenceBefore.length) changed = true;
    kept.push(item);
  }

  task.lineItems = kept;
  return changed;
}

function markTaskReview(task, now) {
  task.brainState = { ...V5_BRAIN_STATE_DEFAULTS, ...(task.brainState || {}) };
  task.brainState.needsReview = true;
  const reason = 'Batch 5 moved Moerken/Norway contamination to reviewQueue; verify any MPR delivery-risk facts before reapplying.';
  task.brainState.reviewReason = task.brainState.reviewReason
    ? `${task.brainState.reviewReason} | ${reason}`
    : reason;
  task.updatedAt = nowIso(now);
  task.history = normalizeArray(task.history);
  if (!task.history.some(entry => entry.type === 'batch5-repair' && String(entry.text || '').includes(REPAIR_ID))) {
    task.history.push({
      timestamp: nowIso(now),
      type: 'batch5-repair',
      text: `${REPAIR_ID}: moved contaminated Moerken/Norway Circle facts to reviewQueue. SourceRefs retained.`
    });
  }
}

export function repairCircleContamination(inputData, { now = new Date() } = {}) {
  const data = migrateToV5(inputData);
  const task = normalizeArray(data.tasks).find(item => item.id === CIRCLE_TASK_ID);
  if (!task) {
    return { data, summary: { found: false, changed: false, reviewEntries: 0 } };
  }

  const beforeReviewCount = normalizeArray(data.reviewQueue).length;
  const pmChanged = cleanPmStatus(data, task, now);
  const lineItemsChanged = cleanLineItems(data, task, now);
  const changed = pmChanged || lineItemsChanged;

  if (changed) markTaskReview(task, now);

  return {
    data,
    summary: {
      found: true,
      changed,
      pmChanged,
      lineItemsChanged,
      retainedContaminatedSourceRefs: normalizeArray(task.sourceRefs).filter(ref => CONTAMINATED_REFS.has(ref.id)).map(ref => ref.id),
      reviewEntries: normalizeArray(data.reviewQueue).length - beforeReviewCount
    }
  };
}

export function runRepairCircleContamination({
  tasksFile = DEFAULT_TASKS_FILE,
  apply = false,
  now = new Date(),
  _readJsonFile = readJsonFile,
  _writeJsonFileAtomic = writeJsonFileAtomic
} = {}) {
  const result = repairCircleContamination(_readJsonFile(tasksFile), { now });
  if (apply && result.summary.changed) _writeJsonFileAtomic(tasksFile, result.data);
  return {
    mode: apply ? 'apply' : 'dry-run',
    tasksFile,
    wrote: Boolean(apply && result.summary.changed),
    ...result
  };
}

function parseArgs(argv) {
  const options = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.apply = false;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--tasks-file') options.tasksFile = argv[++i];
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

function printHelp() {
  console.log([
    'Usage: node scripts/repair-circle-contamination.mjs [--dry-run|--apply] [--tasks-file <path>]',
    '',
    'Moves known Zurich The Circle Moerken/Norway contamination into reviewQueue.',
    'Default mode is --dry-run. Use --apply to write tasks.json atomically with backup rotation.'
  ].join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    const result = runRepairCircleContamination(options);
    console.log(JSON.stringify({
      mode: result.mode,
      wrote: result.wrote,
      summary: result.summary
    }, null, 2));
    process.exit(0);
  } catch (err) {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
}
