#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMarkerBatch } from '../brain/marker-applier.js';
import { renderScanState } from '../brain/render-scan-state.js';
import { filterMarkersThroughGateway, runRealityGateway } from '../brain/reality-gateway.js';
import { bootstrapFactSheetFromTask, FACTSHEET_SECTIONS, normalizeFactSheet } from '../brain/factsheet.js';
import { BRAIN_WORK_DIR } from '../brain/agency-cli.js';
import { migrateToV5, writeJsonFileAtomic } from '../brain/tasks-v5.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_TASKS_FILE = path.join(REPO_ROOT, 'tasks.json');

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isArchived(task) {
  return Boolean(task?.archived || task?.supersededBy);
}

function activeFactSheetEntryCount(task) {
  const sheet = normalizeFactSheet(task?.factSheet);
  return FACTSHEET_SECTIONS.reduce((sum, section) => {
    return sum + normalizeArray(sheet.sections[section.id]).filter(entry => !entry.removedAt).length;
  }, 0);
}

function collectSourceRefIds(value, ids = new Set()) {
  if (!value) return ids;
  if (typeof value === 'string') {
    if (/^src-[a-z0-9-]+$/i.test(value)) ids.add(value);
    return ids;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectSourceRefIds(item, ids);
    return ids;
  }
  if (typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'evidence' || key === 'evidenceRefIds' || key === 'sourceRefId') collectSourceRefIds(child, ids);
      else collectSourceRefIds(child, ids);
    }
  }
  return ids;
}

function excludedBootstrapSourceRefs(data, task) {
  const ids = new Set();
  for (const item of normalizeArray(data.reviewQueue)) {
    if (item?.ref !== task.id) continue;
    if (item.repairId === 'batch5-6b-circle-contamination') collectSourceRefIds(item.payload, ids);
    if (/contamination|mixed-project|country mismatch|location/i.test(String(item.question || ''))) collectSourceRefIds(item.payload, ids);
  }
  if (task.id === 'proj-zurich-circle-hublcr') {
    ids.add('src-zones-aug-1783');
    ids.add('src-moerken-20260701');
    ids.add('src-2579f860');
  }
  return ids;
}

function evidenceRef(entry) {
  return entry?.evidence || entry?.sourceRefId || null;
}

function filteredBootstrapTask(data, task) {
  const excluded = excludedBootstrapSourceRefs(data, task);
  if (!excluded.size) return task;
  const clone = structuredClone(task);
  clone.sourceRefs = normalizeArray(clone.sourceRefs).filter(ref => !excluded.has(ref?.id));
  clone.lineItems = normalizeArray(clone.lineItems).map(item => ({
    ...item,
    evidenceRefIds: normalizeArray(item.evidenceRefIds).filter(id => !excluded.has(id))
  }));
  if (clone.pmStatus && typeof clone.pmStatus === 'object') {
    for (const field of ['planned', 'userActions', 'problems', 'risks', 'waitingOn']) {
      clone.pmStatus[field] = normalizeArray(clone.pmStatus[field]).filter(entry => !excluded.has(evidenceRef(entry)));
    }
  }
  return clone;
}

function entryToPatch(entry) {
  const patch = { op: 'add' };
  for (const field of [
    'text',
    'date',
    'evidenceRefIds',
    'confidence',
    'sourceType',
    'title',
    'person',
    'role',
    'organization',
    'location',
    'country',
    'contact',
    'notes',
    'amount',
    'currency',
    'status'
  ]) {
    if (entry[field] !== undefined) patch[field] = entry[field];
  }
  return patch;
}

function buildFactSheetUpdateMarkers(data, { now = new Date(), includeExisting = false } = {}) {
  const markers = [];
  const tasks = normalizeArray(data.tasks).filter(task => !isArchived(task));

  for (const task of tasks) {
    if (!includeExisting && activeFactSheetEntryCount(task) > 0) continue;
    const sheet = bootstrapFactSheetFromTask(filteredBootstrapTask(data, task), { now });
    const sectionPatches = {};

    for (const section of FACTSHEET_SECTIONS) {
      const patches = normalizeArray(sheet.sections[section.id])
        .filter(entry => normalizeArray(entry.evidenceRefIds).length > 0)
        .map(entryToPatch);
      if (patches.length) sectionPatches[section.id] = patches;
    }

    if (!Object.keys(sectionPatches).length) continue;
    const payload = { taskId: task.id, sectionPatches };
    markers.push({
      type: 'FACTSHEET_UPDATE',
      payload,
      raw: `[FACTSHEET_UPDATE] ${JSON.stringify(payload)}`
    });
  }

  return markers;
}

async function localApproveGateway(markers) {
  return {
    ok: true,
    text: JSON.stringify({
      decisions: markers.map((_, markerIndex) => ({
        markerIndex,
        decision: 'approve',
        reason: 'Deterministic bootstrap patch was generated from existing validated task evidence.'
      }))
    }),
    counters: { workIqCalls: 0 }
  };
}

export async function bootstrapFactSheets({
  tasksFile = DEFAULT_TASKS_FILE,
  apply = false,
  now = new Date(),
  brainWorkDir = BRAIN_WORK_DIR,
  gateway = 'agency',
  includeExisting = false,
  _readJsonFile = readJsonFile,
  _writeJsonFileAtomic = writeJsonFileAtomic,
  _renderScanState = renderScanState,
  _runGateway = runRealityGateway
} = {}) {
  const beforeData = migrateToV5(_readJsonFile(tasksFile));
  const markers = buildFactSheetUpdateMarkers(beforeData, { now, includeExisting });
  const runId = `factsheet-bootstrap-${Date.now()}`;
  const state = _renderScanState(beforeData, {
    brainWorkDir,
    runId,
    now: now instanceof Date ? now.toISOString() : String(now),
    writeFiles: true
  });

  const gatewayResult = gateway === 'local'
    ? await localApproveGateway(markers)
    : await _runGateway({
        stateFile: state.stateFile,
        factSheetFiles: state.factSheetFiles || [],
        markers,
        brainWorkDir,
        runId
      });

  const filtered = filterMarkersThroughGateway(markers, gatewayResult);
  const applyResult = applyMarkerBatch(beforeData, filtered.markers, {
    now,
    runId,
    auditLogFile: null
  });

  if (apply && applyResult.applied > 0) {
    _writeJsonFileAtomic(tasksFile, applyResult.data);
  }

  return {
    mode: apply ? 'apply' : 'dry-run',
    tasksFile,
    wrote: Boolean(apply && applyResult.applied > 0),
    markersGenerated: markers.length,
    markersApproved: filtered.approved.length,
    markersHeld: filtered.held.length,
    appliedMarkers: applyResult.applied,
    droppedMarkers: applyResult.dropped,
    gateway: {
      mode: gateway,
      ok: Boolean(gatewayResult.ok),
      parsed: filtered.gatewayParsed,
      parseError: filtered.gatewayParseError,
      workIqCalls: gatewayResult.counters?.workIqCalls ?? 0
    },
    stateFile: state.stateFile,
    factSheetFiles: state.factSheetFiles || [],
    data: applyResult.data
  };
}

function parseArgs(argv) {
  const options = { apply: false, gateway: 'agency', includeExisting: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') options.apply = false;
    else if (arg === '--apply') options.apply = true;
    else if (arg === '--tasks-file') options.tasksFile = argv[++i];
    else if (arg === '--brain-work-dir') options.brainWorkDir = argv[++i];
    else if (arg === '--gateway') options.gateway = argv[++i];
    else if (arg === '--include-existing') options.includeExisting = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!['agency', 'local'].includes(options.gateway)) {
    throw new Error('--gateway must be agency or local');
  }
  return options;
}

function printHelp() {
  console.log([
    'Usage: node scripts/bootstrap-factsheets.mjs [--dry-run|--apply] [--gateway agency|local] [--tasks-file <path>]',
    '',
    'Bootstraps Fact Sheets from existing task sourceRefs, pmStatus, and lineItems.',
    'Default gateway is agency. Use --apply to write tasks.json atomically with backup rotation.'
  ].join('\n'));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    const result = await bootstrapFactSheets(options);
    console.log(JSON.stringify({
      mode: result.mode,
      wrote: result.wrote,
      markersGenerated: result.markersGenerated,
      markersApproved: result.markersApproved,
      markersHeld: result.markersHeld,
      appliedMarkers: result.appliedMarkers,
      droppedMarkers: result.droppedMarkers,
      gateway: result.gateway,
      stateFile: path.basename(result.stateFile || ''),
      factSheetFiles: result.factSheetFiles.length
    }, null, 2));
    process.exit(result.markersHeld || result.droppedMarkers.length ? 2 : 0);
  } catch (err) {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
}
