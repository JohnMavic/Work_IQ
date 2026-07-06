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
const MOERKEN_PATTERN = /moerken/i;

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

function buildTaskIndexes(data) {
  const byId = new Map();
  const byShortId = new Map();
  for (const task of normalizeArray(data.tasks)) {
    if (!task || typeof task !== 'object') continue;
    if (task.id) {
      byId.set(task.id, task);
      byShortId.set(String(task.id).slice(0, 8), task);
    }
    if (task.taskId) byId.set(task.taskId, task);
  }
  return { byId, byShortId };
}

function sourceTaskForRef(ref, indexes) {
  if (!ref?.sourceTaskId) return null;
  return indexes.byId.get(ref.sourceTaskId) || indexes.byShortId.get(String(ref.sourceTaskId).slice(0, 8)) || null;
}

function isMoerkenStemmedSourceRef(ref, indexes) {
  if (!ref || typeof ref !== 'object') return false;
  if (CONTAMINATED_REFS.has(ref.id)) return true;
  if (MOERKEN_PATTERN.test(JSON.stringify(ref))) return true;
  const sourceTask = sourceTaskForRef(ref, indexes);
  if (!sourceTask) return false;
  return MOERKEN_PATTERN.test(String(sourceTask.from || '')) || MOERKEN_PATTERN.test(String(sourceTask.summary || ''));
}

function filterReviewReason(reason, contaminatedIds) {
  const removed = [];
  const kept = [];

  for (const rawPart of String(reason || '').split(/\s+\|\s+/)) {
    let part = rawPart.trim();
    if (!part) continue;

    if (/^Source link repair could not reconstruct/i.test(part)) {
      const ids = part.match(/src-[a-z0-9-]+/gi) || [];
      const remainingIds = ids.filter(id => !contaminatedIds.has(id));
      if (remainingIds.length !== ids.length) {
        removed.push(part);
        if (remainingIds.length) {
          part = `Source link repair could not reconstruct ${remainingIds.length} sourceRef link(s): ${remainingIds.join(', ')}`;
          kept.push(part);
        }
        continue;
      }
    }

    if (referencesContamination(part) || [...contaminatedIds].some(id => part.includes(id))) {
      removed.push(part);
    } else {
      kept.push(part);
    }
  }

  return { value: kept.join(' | ') || null, removed };
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

function cleanLineItems(data, task, contaminatedIds, contaminatedSourceTaskIds, now) {
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

    if (item.reviewReason && referencesContamination(item.reviewReason)) {
      pushReview(data, {
        key: `lineItem.${item.id}.reviewReason`,
        ref: task.id,
        question: 'Batch 5 follow-up moved contaminated cross-project review reason out of Zurich The Circle line item.',
        payload: { lineItemId: item.id, field: 'reviewReason', value: item.reviewReason }
      }, now);
      delete item.reviewReason;
      if (item.id === 'li-circle-timeline' && normalizeArray(item.evidenceRefIds).some(id => !contaminatedIds.has(id))) {
        delete item.needsReview;
      }
      changed = true;
    }

    const evidenceBefore = normalizeArray(item.evidenceRefIds);
    item.evidenceRefIds = evidenceBefore.filter(id => !contaminatedIds.has(id));
    if (item.evidenceRefIds.length !== evidenceBefore.length) changed = true;

    const sourceTaskIdsBefore = normalizeArray(item.sourceTaskIds);
    item.sourceTaskIds = sourceTaskIdsBefore.filter(id => !contaminatedSourceTaskIds.has(id) && !contaminatedSourceTaskIds.has(String(id).slice(0, 8)));
    if (item.sourceTaskIds.length !== sourceTaskIdsBefore.length) changed = true;

    if (item.id === 'li-circle-timeline' && item.evidenceRefIds.length === 0) {
      item.status = 'needs-review';
      item.needsReview = true;
      item.reviewReason = 'December timeline requires non-contaminated evidence before it can remain active.';
      changed = true;
    }

    kept.push(item);
  }

  task.lineItems = kept;
  return changed;
}

function cleanFactSheet(data, task, contaminatedIds, now) {
  let changed = false;
  const sections = task.factSheet?.sections;
  if (!sections || typeof sections !== 'object') return changed;

  for (const [sectionName, entries] of Object.entries(sections)) {
    if (!Array.isArray(entries)) continue;
    const keptEntries = [];
    entries.forEach((entry, index) => {
      if (!entry || typeof entry !== 'object') {
        keptEntries.push(entry);
        return;
      }

      const originalRefs = normalizeArray(entry.evidenceRefIds);
      const nextRefs = originalRefs.filter(id => !contaminatedIds.has(id));
      const contaminatedText = referencesContamination(entry.text);
      const touched = contaminatedText || nextRefs.length !== originalRefs.length;

      if (!touched) {
        keptEntries.push(entry);
        return;
      }

      pushReview(data, {
        key: `factSheet.${sectionName}.${entry.id || index}`,
        ref: task.id,
        question: `Batch 5 follow-up moved contaminated source evidence out of Zurich The Circle factSheet.${sectionName}.`,
        payload: { section: sectionName, entry }
      }, now);

      if (!contaminatedText && nextRefs.length) {
        keptEntries.push({ ...entry, evidenceRefIds: nextRefs });
      }
      changed = true;
    });
    sections[sectionName] = keptEntries;
  }

  return changed;
}

function cleanSourceRefs(data, task, indexes, now) {
  const removedRefs = [];
  const keptRefs = [];
  for (const ref of normalizeArray(task.sourceRefs)) {
    if (isMoerkenStemmedSourceRef(ref, indexes)) removedRefs.push(ref);
    else keptRefs.push(ref);
  }

  if (!removedRefs.length) return { changed: false, removedRefs, contaminatedIds: new Set(), contaminatedSourceTaskIds: new Set() };

  pushReview(data, {
    key: 'sourceRefs.moerken-stemmed',
    ref: task.id,
    question: 'Batch 5 follow-up moved Moerken-stemmed sourceRefs out of Zurich The Circle active project state.',
    payload: { sourceRefs: removedRefs }
  }, now);

  task.sourceRefs = keptRefs;
  const removedLinks = new Set(removedRefs.map(ref => ref.link).filter(Boolean));
  if (Array.isArray(task.additionalLinks) && removedLinks.size) {
    task.additionalLinks = task.additionalLinks.filter(link => !removedLinks.has(link));
  }

  return {
    changed: true,
    removedRefs,
    contaminatedIds: new Set(removedRefs.map(ref => ref.id).filter(Boolean)),
    contaminatedSourceTaskIds: new Set(removedRefs.flatMap(ref => {
      const ids = [];
      if (ref.sourceTaskId) {
        ids.push(ref.sourceTaskId);
        ids.push(String(ref.sourceTaskId).slice(0, 8));
      }
      return ids;
    }))
  };
}

function cleanBrainStateAndHistory(data, task, contaminatedIds, now) {
  let changed = false;

  if (task.brainState?.reviewReason) {
    const filtered = filterReviewReason(task.brainState.reviewReason, contaminatedIds);
    if (filtered.value !== task.brainState.reviewReason) {
      if (filtered.removed.length) {
        pushReview(data, {
          key: 'brainState.reviewReason.moerken-stemmed',
          ref: task.id,
          question: 'Batch 5 follow-up moved contaminated cross-project review reason out of Zurich The Circle brainState.',
          payload: { field: 'brainState.reviewReason', removed: filtered.removed, original: task.brainState.reviewReason }
        }, now);
      }
      task.brainState.reviewReason = filtered.value;
      task.brainState.needsReview = Boolean(filtered.value);
      changed = true;
    }
  }

  for (const entry of normalizeArray(task.history)) {
    if (!entry || typeof entry !== 'object' || !referencesContamination(entry.text)) continue;
    pushReview(data, {
      key: `history.${entry.timestamp || entry.type || 'entry'}`,
      ref: task.id,
      question: 'Batch 5 follow-up moved contaminated wording out of Zurich The Circle task history.',
      payload: { historyEntry: { ...entry } }
    }, now);
    entry.text = String(entry.text || '').replace(/Moerken\/Norway\s*/gi, 'cross-project ').replace(/Moerken/gi, 'cross-project');
    changed = true;
  }

  return changed;
}

function markTaskReview(task, now) {
  task.brainState = { ...V5_BRAIN_STATE_DEFAULTS, ...(task.brainState || {}) };
  task.brainState.needsReview = true;
  const reason = 'Batch 5 moved cross-project contamination to reviewQueue; verify any MPR delivery-risk facts before reapplying.';
  task.brainState.reviewReason = task.brainState.reviewReason
    ? `${task.brainState.reviewReason} | ${reason}`
    : reason;
  task.updatedAt = nowIso(now);
  task.history = normalizeArray(task.history);
  if (!task.history.some(entry => entry.type === 'batch5-repair' && String(entry.text || '').includes(REPAIR_ID))) {
    task.history.push({
      timestamp: nowIso(now),
      type: 'batch5-repair',
      text: `${REPAIR_ID}: moved contaminated cross-project Circle facts to reviewQueue. SourceRefs retained.`
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
  const indexes = buildTaskIndexes(data);
  const sourceRefResult = cleanSourceRefs(data, task, indexes, now);
  const contaminatedIds = new Set([...CONTAMINATED_REFS, ...sourceRefResult.contaminatedIds]);
  const contaminatedSourceTaskIds = sourceRefResult.contaminatedSourceTaskIds;
  const pmChanged = cleanPmStatus(data, task, now);
  const lineItemsChanged = cleanLineItems(data, task, contaminatedIds, contaminatedSourceTaskIds, now);
  const factSheetChanged = cleanFactSheet(data, task, contaminatedIds, now);
  const brainStateChanged = cleanBrainStateAndHistory(data, task, contaminatedIds, now);
  const changed = sourceRefResult.changed || pmChanged || lineItemsChanged || factSheetChanged || brainStateChanged;

  if (changed) markTaskReview(task, now);

  return {
    data,
    summary: {
      found: true,
      changed,
      sourceRefsChanged: sourceRefResult.changed,
      pmChanged,
      lineItemsChanged,
      factSheetChanged,
      brainStateChanged,
      removedSourceRefs: sourceRefResult.removedRefs.map(ref => ref.id),
      timelineEvidenceRetained: normalizeArray(task.lineItems)
        .find(item => item.id === 'li-circle-timeline')
        ?.evidenceRefIds?.length || 0,
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
