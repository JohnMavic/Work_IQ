#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mergeProcessing } from '../brain/processing-ledger.js';
import { migrateToV5, writeJsonFileAtomic } from '../brain/tasks-v5.js';
import {
  isActionLikeLineItem,
  validateActionGateForVisibleAction
} from '../brain/truth-tree.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_TASKS_FILE = path.join(REPO_ROOT, 'tasks.json');
export const REPAIR_ID = 'batch7-action-gate-sweep';

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function actionText(action) {
  return compactText(action?.text || action?.userAction || action?.title || action?.currentState);
}

function isActiveTask(task) {
  return task && !task.archived && !task.supersededBy && task.status !== 'done';
}

function factSheetSections(task) {
  task.factSheet = task.factSheet && typeof task.factSheet === 'object' && !Array.isArray(task.factSheet)
    ? task.factSheet
    : { version: 1, language: 'en', sections: {} };
  task.factSheet.sections = task.factSheet.sections && typeof task.factSheet.sections === 'object' && !Array.isArray(task.factSheet.sections)
    ? task.factSheet.sections
    : {};
  for (const section of ['status', 'openActions']) {
    task.factSheet.sections[section] = normalizeArray(task.factSheet.sections[section]);
  }
  return task.factSheet.sections;
}

function evidenceRefIdsFor(task, patterns) {
  const matches = [];
  for (const ref of normalizeArray(task.sourceRefs)) {
    const haystack = JSON.stringify(ref);
    if (patterns.some(pattern => pattern.test(haystack))) matches.push(ref.id);
  }
  return [...new Set(matches.filter(Boolean))];
}

function knownResolutionFor(task, action) {
  const text = actionText(action);
  if (/Respond to Laith Skeik's unanswered meeting request to walk through the cabling plan/i.test(text)) {
    return {
      key: 'fall-a-stale-laith-site-walk',
      resolutionStatus: 'obsolete',
      threadRef: 'workiq-conversation-seestrasse-cabling-works-august',
      askQuote: {
        text: 'bist Du am Donnerstag bei der Ortsbegehung dabei?',
        from: 'Laith Skeik',
        date: '2026-06-08',
        threadRef: 'workiq-conversation-seestrasse-cabling-works-august'
      },
      obsoleteEvidence: {
        text: 'The request referred to Thursday 11 June 2026; later thread activity continued after Martin replied on 9 June.',
        from: 'Batch 7 ratification WorkIQ probe',
        date: '2026-07-06'
      },
      factText: 'The old Laith Skeik site-walk response action was removed as obsolete: the quoted request referred to Thursday 11 June 2026 and the thread later continued after Martin replied on 9 June.',
      evidenceRefIds: evidenceRefIdsFor(task, [/Cabling project/i, /meeting request/i, /Seestrasse cabling/i, /Laith Skeik/i])
    };
  }

  if (/Review the color-coded AV decommission asset list/i.test(text)) {
    return {
      key: 'fall-b-third-party-resolved-asset-list',
      resolutionStatus: 'resolved',
      threadRef: 'workiq-conversation-installation-date-microsoft-seestrasse',
      resolvedBy: {
        text: 'I believe it to be correct... Trust that is all OK?',
        from: 'Patrick Harris',
        date: '2026-06-09'
      },
      factText: 'The AV decommission asset-list action was removed as resolved by Patrick Harris on 9 June 2026; Martin was not the direct owner of that request.',
      evidenceRefIds: evidenceRefIdsFor(task, [/asset list/i, /decommission/i, /Patrick Harris/i, /Installation date/i])
    };
  }

  return null;
}

function hasRepairReview(data, key) {
  return normalizeArray(data.reviewQueue).some(entry => entry.repairId === REPAIR_ID && entry.key === key);
}

function pushReview(data, { key, ref, question, payload }, now) {
  data.reviewQueue = normalizeArray(data.reviewQueue);
  if (hasRepairReview(data, key)) return false;
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
  return true;
}

function pushFact(task, resolution, now) {
  if (!resolution) return false;
  const sections = factSheetSections(task);
  const id = `fs-b7-${resolution.key}`;
  if (sections.status.some(entry => entry.id === id)) return false;
  sections.status.push({
    id,
    text: resolution.factText,
    date: resolution.resolvedBy?.date || resolution.obsoleteEvidence?.date || nowIso(now).slice(0, 10),
    evidenceRefIds: normalizeArray(resolution.evidenceRefIds),
    confidence: 'medium',
    state: 'confirmed',
    sources: [],
    lastConfirmedByMessageDate: resolution.resolvedBy?.date || resolution.obsoleteEvidence?.date || null,
    threadRef: resolution.threadRef,
    resolutionStatus: resolution.resolutionStatus,
    resolvedBy: resolution.resolvedBy || null,
    obsoleteEvidence: resolution.obsoleteEvidence || null
  });
  task.factSheet.updatedAt = nowIso(now);
  return true;
}

function ledgerItemFor(task, action, kind, disposition, reason, now, resolution = null) {
  const id = compactText(action?.id || actionText(action) || `${kind}-${Date.now()}`)
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 100);
  return {
    itemRef: { type: 'repair-action', id: `${task.id}:${kind}:${id}` },
    threadRef: resolution?.threadRef || action?.threadRef || `repair-${task.id}`,
    date: nowIso(now),
    disposition,
    nodeRefs: [action?.id || kind].filter(Boolean).map(String),
    quote: resolution?.resolvedBy?.text || resolution?.obsoleteEvidence?.text || resolution?.askQuote?.text || actionText(action),
    reason
  };
}

function appendLedger(task, item, now) {
  task.processing = mergeProcessing(task.processing, { processingLedger: [item] }, { now });
}

function archiveRemovedAction(data, task, kind, action, reason, now, resolution = null) {
  const key = `${task.id}:${kind}:${action?.id || actionText(action)}:${resolution?.key || 'missing-proof'}`;
  pushReview(data, {
    key,
    ref: task.id,
    question: `Batch 7 action-gate sweep removed or deactivated a visible action: ${reason}`,
    payload: {
      kind,
      action,
      reason,
      resolution
    }
  }, now);
}

function validVisibleAction(action, now) {
  return validateActionGateForVisibleAction(action, { pathName: 'repair.action', now }) === null;
}

function countVisibleActions(data) {
  let count = 0;
  for (const task of normalizeArray(data.tasks).filter(isActiveTask)) {
    count += normalizeArray(task.pmStatus?.userActions).filter(action => action?.text && !action.userMarkedDoneAt).length;
    count += normalizeArray(task.lineItems).filter(item => isActionLikeLineItem(item)).length;
    count += normalizeArray(task.factSheet?.sections?.openActions).filter(entry => entry && !entry.removedAt).length;
  }
  return count;
}

function repairPmActions(data, task, now, stats) {
  if (!task.pmStatus || typeof task.pmStatus !== 'object' || Array.isArray(task.pmStatus)) return false;
  const kept = [];
  let changed = false;
  for (const action of normalizeArray(task.pmStatus.userActions)) {
    if (!action?.text || action.userMarkedDoneAt) {
      kept.push(action);
      continue;
    }
    stats.considered++;
    const resolution = knownResolutionFor(task, action);
    if (!resolution && validVisibleAction(action, now)) {
      kept.push(action);
      appendLedger(task, ledgerItemFor(task, action, 'pmStatus.userActions', 'no-change', 'Action already has complete Batch 7 proof.', now), now);
      stats.ledgerItems++;
      continue;
    }
    const reason = resolution
      ? `${resolution.key}: ${resolution.resolutionStatus}`
      : 'missing required Batch 7 askQuote/thread proof';
    archiveRemovedAction(data, task, 'pmStatus.userActions', action, reason, now, resolution);
    pushFact(task, resolution, now);
    appendLedger(task, ledgerItemFor(task, action, 'pmStatus.userActions', 'updates-node', reason, now, resolution), now);
    stats.ledgerItems++;
    stats.removed++;
    if (resolution?.key === 'fall-a-stale-laith-site-walk') stats.fallAResolved = true;
    if (resolution?.key === 'fall-b-third-party-resolved-asset-list') stats.fallBResolved = true;
    changed = true;
  }
  task.pmStatus.userActions = kept;
  return changed;
}

function repairLineItemActions(data, task, now, stats) {
  let changed = false;
  for (const item of normalizeArray(task.lineItems)) {
    if (!isActionLikeLineItem(item)) continue;
    stats.considered++;
    const resolution = knownResolutionFor(task, item);
    if (!resolution && validVisibleAction(item, now)) {
      appendLedger(task, ledgerItemFor(task, item, 'lineItems', 'no-change', 'Line-item action already has complete Batch 7 proof.', now), now);
      stats.ledgerItems++;
      continue;
    }
    const reason = resolution
      ? `${resolution.key}: ${resolution.resolutionStatus}`
      : 'missing required Batch 7 askQuote/thread proof';
    archiveRemovedAction(data, task, 'lineItems', item, reason, now, resolution);
    pushFact(task, resolution, now);
    item.userActionRequired = false;
    item.userAction = null;
    item.needsReview = true;
    item.reviewReason = `Batch 7 action-gate sweep deactivated this action: ${reason}`;
    if (resolution) {
      item.resolutionStatus = resolution.resolutionStatus;
      item.threadRef = resolution.threadRef;
      item.resolvedBy = resolution.resolvedBy || null;
      item.obsoleteEvidence = resolution.obsoleteEvidence || null;
      item.state = resolution.resolutionStatus === 'obsolete' ? 'obsolete' : 'superseded';
    }
    appendLedger(task, ledgerItemFor(task, item, 'lineItems', 'updates-node', reason, now, resolution), now);
    stats.ledgerItems++;
    stats.removed++;
    if (resolution?.key === 'fall-a-stale-laith-site-walk') stats.fallAResolved = true;
    if (resolution?.key === 'fall-b-third-party-resolved-asset-list') stats.fallBResolved = true;
    changed = true;
  }
  return changed;
}

function repairFactSheetOpenActions(data, task, now, stats) {
  const sections = factSheetSections(task);
  let changed = false;
  for (const entry of sections.openActions) {
    if (!entry || entry.removedAt) continue;
    stats.considered++;
    const resolution = knownResolutionFor(task, entry);
    if (!resolution && validVisibleAction(entry, now)) {
      appendLedger(task, ledgerItemFor(task, entry, 'factSheet.openActions', 'no-change', 'Fact Sheet action already has complete Batch 7 proof.', now), now);
      stats.ledgerItems++;
      continue;
    }
    const reason = resolution
      ? `${resolution.key}: ${resolution.resolutionStatus}`
      : 'missing required Batch 7 askQuote/thread proof';
    archiveRemovedAction(data, task, 'factSheet.openActions', entry, reason, now, resolution);
    pushFact(task, resolution, now);
    entry.removedAt = nowIso(now);
    entry.removedReason = `Batch 7 action-gate sweep: ${reason}`;
    entry.repairId = REPAIR_ID;
    entry.resolutionStatus = resolution?.resolutionStatus || 'obsolete';
    entry.threadRef = resolution?.threadRef || entry.threadRef || null;
    entry.resolvedBy = resolution?.resolvedBy || null;
    entry.obsoleteEvidence = resolution?.obsoleteEvidence || null;
    entry.state = resolution?.resolutionStatus === 'resolved' ? 'superseded' : 'obsolete';
    appendLedger(task, ledgerItemFor(task, entry, 'factSheet.openActions', 'updates-node', reason, now, resolution), now);
    stats.ledgerItems++;
    stats.removed++;
    if (resolution?.key === 'fall-a-stale-laith-site-walk') stats.fallAResolved = true;
    if (resolution?.key === 'fall-b-third-party-resolved-asset-list') stats.fallBResolved = true;
    changed = true;
  }
  return changed;
}

export function repairActionGate(inputData, { now = new Date() } = {}) {
  const data = migrateToV5(inputData);
  const beforeActions = countVisibleActions(data);
  const stats = {
    considered: 0,
    removed: 0,
    ledgerItems: 0,
    fallAResolved: false,
    fallBResolved: false,
    changedTasks: []
  };

  for (const task of normalizeArray(data.tasks).filter(isActiveTask)) {
    const changed = [
      repairPmActions(data, task, now, stats),
      repairLineItemActions(data, task, now, stats),
      repairFactSheetOpenActions(data, task, now, stats)
    ].some(Boolean);
    if (!changed) continue;
    task.updatedAt = nowIso(now);
    task.history = normalizeArray(task.history);
    if (!task.history.some(entry => entry.type === REPAIR_ID)) {
      task.history.push({
        timestamp: nowIso(now),
        type: REPAIR_ID,
        text: 'Batch 7 action-gate sweep removed or deactivated visible actions lacking complete thread proof; removed payloads were archived in reviewQueue.'
      });
    }
    stats.changedTasks.push(task.id);
  }

  const afterActions = countVisibleActions(data);
  return {
    data,
    summary: {
      beforeActions,
      afterActions,
      changed: beforeActions !== afterActions || stats.removed > 0,
      ...stats
    }
  };
}

export function runRepairActionGate({
  tasksFile = DEFAULT_TASKS_FILE,
  apply = false,
  now = new Date(),
  _readJsonFile = readJsonFile,
  _writeJsonFileAtomic = writeJsonFileAtomic
} = {}) {
  const result = repairActionGate(_readJsonFile(tasksFile), { now });
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
    'Usage: node scripts/repair-action-gate.mjs [--dry-run|--apply] [--tasks-file <path>]',
    '',
    'Runs the Batch 7 visible-action repair sweep.',
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
    const result = runRepairActionGate(options);
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
