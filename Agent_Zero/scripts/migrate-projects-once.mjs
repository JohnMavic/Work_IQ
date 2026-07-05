#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { BRAIN_WORK_DIR } from '../brain/agency-cli.js';
import { runBrain } from '../brain/brain-runner.js';
import { applyMarkerBatch } from '../brain/marker-applier.js';
import { parseMarkers } from '../brain/marker-parser.js';
import { renderScanState } from '../brain/render-scan-state.js';
import { migrateToV5, writeJsonFileAtomic } from '../brain/tasks-v5.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_TASKS_FILE = path.join(REPO_ROOT, 'tasks.json');
export const DEFAULT_SKILL_FILE = path.join(REPO_ROOT, 'docs', 'AGENCY_BRAIN_SCAN_SKILL.md');
export const DEFAULT_PREVIEW_FILE = path.join(REPO_ROOT, 'docs', 'gremium', 'migration-preview.json');
export const MIGRATION_WORKIQ_HARD_LIMIT = 60;
export const DEFAULT_MIGRATION_STATE_MAX_BYTES = 128 * 1024;

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
}

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isArchived(task) {
  return Boolean(task?.archived || task?.supersededBy);
}

function isProject(task) {
  return task?.taskType === 'project';
}

function safeFilePart(value) {
  return String(value || 'migration')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 80) || 'migration';
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function markerKey(marker) {
  return `${marker?.line ?? ''}\n${marker?.type ?? ''}\n${marker?.raw ?? JSON.stringify(marker?.payload ?? {})}`;
}

function extractPremiumRequests(event) {
  const candidates = [
    event?.data?.usage?.premiumRequests,
    event?.data?.usage?.premium_requests,
    event?.usage?.premiumRequests,
    event?.usage?.premium_requests,
    event?.data?.premiumRequests,
    event?.premiumRequests
  ];
  const value = candidates.find(candidate => typeof candidate === 'number' && Number.isFinite(candidate));
  return value ?? null;
}

function scanDonePayload(markers) {
  return markers.find(marker => marker.type === 'SCAN_DONE')?.payload || null;
}

function createDeterministicIdFactory(seed) {
  const normalizedSeed = safeFilePart(seed || 'migration');
  const counters = new Map();
  return (prefix) => {
    const key = safeFilePart(prefix || 'id');
    const next = (counters.get(key) || 0) + 1;
    counters.set(key, next);
    return `${key}-${normalizedSeed}-${next}`;
  };
}

function countTaskLinks(task) {
  let count = 0;
  if (task?.link) count++;
  count += normalizeArray(task?.additionalLinks).filter(Boolean).length;
  count += normalizeArray(task?.sourceRefs).filter(ref => ref?.link).length;
  return count;
}

export function computeInvariants(inputData) {
  const data = migrateToV5(inputData);
  return {
    historySum: normalizeArray(data.tasks).reduce((sum, task) => sum + normalizeArray(task.history).length, 0),
    linkSum: normalizeArray(data.tasks).reduce((sum, task) => sum + countTaskLinks(task), 0),
    taskCount: normalizeArray(data.tasks).length
  };
}

export function buildInvariantReport(beforeData, afterData) {
  const before = migrateToV5(beforeData);
  const after = migrateToV5(afterData);
  const beforeInv = computeInvariants(before);
  const afterInv = computeInvariants(after);
  const afterIds = new Set(normalizeArray(after.tasks).map(task => task.id));
  const deletedTaskIds = normalizeArray(before.tasks)
    .map(task => task.id)
    .filter(id => id && !afterIds.has(id));

  return {
    historySumBefore: beforeInv.historySum,
    historySumAfter: afterInv.historySum,
    linkSumBefore: beforeInv.linkSum,
    linkSumAfter: afterInv.linkSum,
    taskCountBefore: beforeInv.taskCount,
    taskCountAfter: afterInv.taskCount,
    deletedTaskIds
  };
}

export function assertInvariantGate(invariants) {
  const reasons = [];
  if (invariants.historySumAfter < invariants.historySumBefore) {
    reasons.push(`history ${invariants.historySumBefore}->${invariants.historySumAfter}`);
  }
  if (invariants.linkSumAfter < invariants.linkSumBefore) {
    reasons.push(`links ${invariants.linkSumBefore}->${invariants.linkSumAfter}`);
  }
  if (invariants.taskCountAfter < invariants.taskCountBefore) {
    reasons.push(`tasks ${invariants.taskCountBefore}->${invariants.taskCountAfter}`);
  }
  if (invariants.deletedTaskIds?.length) {
    reasons.push(`deleted task ids: ${invariants.deletedTaskIds.join(', ')}`);
  }
  if (reasons.length) {
    const error = new Error(`Apply aborted: invariant gate failed (${reasons.join('; ')})`);
    error.code = 'MIGRATION_INVARIANT_FAILED';
    error.invariants = invariants;
    throw error;
  }
}

function collectProjectSourceTaskIds(project) {
  const ids = new Set(normalizeArray(project.supersedesTaskIds).filter(Boolean));
  for (const ref of normalizeArray(project.sourceRefs)) {
    if (ref?.sourceTaskId) ids.add(ref.sourceTaskId);
  }
  for (const item of normalizeArray(project.lineItems)) {
    for (const id of normalizeArray(item.sourceTaskIds)) {
      if (id) ids.add(id);
    }
  }
  return [...ids];
}

function projectUserActions(project) {
  return normalizeArray(project?.pmStatus?.userActions).map(entry => {
    if (typeof entry === 'string') return entry;
    return entry?.text || '';
  }).filter(Boolean);
}

export function buildSimulatedResult(beforeData, afterData) {
  const before = migrateToV5(beforeData);
  const after = migrateToV5(afterData);
  const beforeTasks = normalizeArray(before.tasks);
  const afterTasks = normalizeArray(after.tasks);
  const beforeIds = new Set(beforeTasks.map(task => task.id));
  const beforeActiveSingleIds = new Set(
    beforeTasks
      .filter(task => !isArchived(task) && !isProject(task))
      .map(task => task.id)
  );
  const afterById = new Map(afterTasks.map(task => [task.id, task]));

  const archivedTaskIds = [...beforeActiveSingleIds].filter(id => {
    const task = afterById.get(id);
    return task && isArchived(task);
  });

  const candidateProjects = afterTasks.filter(task => {
    if (!isProject(task) || isArchived(task)) return false;
    if (!beforeIds.has(task.id)) return true;
    return collectProjectSourceTaskIds(task).some(id => beforeActiveSingleIds.has(id));
  });

  const assignedTaskIds = new Set(archivedTaskIds);
  const projectTasks = candidateProjects.map(project => {
    const sourceTaskIds = collectProjectSourceTaskIds(project);
    for (const id of sourceTaskIds) assignedTaskIds.add(id);
    return {
      id: project.id,
      title: project.title,
      status: project.status || 'new',
      sourceTaskIds,
      userActions: projectUserActions(project),
      lineItems: normalizeArray(project.lineItems).map(item => ({
        id: item.id,
        title: item.title,
        status: item.status || 'open',
        sourceTaskIds: normalizeArray(item.sourceTaskIds)
      }))
    };
  });

  const unassignedTaskIds = [...beforeActiveSingleIds].filter(id => !assignedTaskIds.has(id));

  return {
    projectTasks,
    archivedTaskIds,
    unassignedTaskIds
  };
}

export function buildMigrationPrompt({ skillText, stateFile, runId }) {
  const stateFileName = path.basename(stateFile);
  return [
    skillText.trim(),
    '',
    '# One-Time Bestand Migration Run',
    '',
    'Auftrag: konsolidiere den bestehenden aktiven Agent-Zero-Bestand zu Projekt-Tasks mit Line Items.',
    'Dies ist ein Dry-Run- bzw. Preview-Lauf. Schreibe keine Dateien und aendere keinen State direkt.',
    '',
    'Migration-specific rules:',
    '- Read the migration state file before making any WorkIQ calls.',
    '- Consider every active task in the state file, including tasks that are not enriched yet.',
    '- Prefer existing task titles, summaries, legacy links, and sourceRefs as evidence.',
    '- WorkIQ may be used only to clarify grouping, currentness, or missing evidence.',
    '- Hard WorkIQ budget for this one-time migration is 60 calls; stop earlier when evidence is sufficient.',
    '- Create or update project tasks only for real undertakings as the user would think about them.',
    '- Different workstreams inside the same undertaking are line items, not separate projects.',
    '- Genuine unrelated incidents, different undertakings, or uncertain merges must stay separate or become NEEDS_REVIEW.',
    '- Do not force every task into a project. Leave standalone or unclear tasks unassigned by emitting no mutating marker for them.',
    '- For every task absorbed into a project, include its id in supersedesTaskIds and in at least one lineItem.sourceTaskIds.',
    '- For legacy tasks with only a link, introduce a sourceRef in the PROJECT_NEW or PROJECT_UPDATE marker with sourceTaskId, title, date if known, and link.',
    '- Use stable taskId values for PROJECT_NEW and stable id values for lineItems whenever possible.',
    '- pmStatus.planned, pmStatus.userActions, pmStatus.problems, pmStatus.risks, and pmStatus.waitingOn must contain objects like {"text":"...","evidence":"src-...","confidence":"medium"}, never bare strings.',
    '- Before emitting PROJECT_NEW or PROJECT_UPDATE, verify every pmStatus list entry is an object with a text field.',
    '- NEEDS_REVIEW.kind must be exactly one of assignment, status, or other. Use assignment for grouping/ownership uncertainty.',
    '- Include workIqCalls and premiumRequests in SCAN_DONE if known.',
    '',
    '# Run Context',
    `- runId: ${runId}`,
    `- stateFile: ./${stateFileName}`,
    '',
    `Read ./${stateFileName} from the current working directory before making any WorkIQ calls.`,
    'Use the marker grammar from the skill exactly. Emit final markers as physical lines.'
  ].join('\n');
}

export function renderMigrationState(inputData, {
  brainWorkDir = BRAIN_WORK_DIR,
  runId = `migration-${Date.now()}`,
  now = new Date(),
  maxBytes = DEFAULT_MIGRATION_STATE_MAX_BYTES,
  _renderScanState = renderScanState
} = {}) {
  const rendered = _renderScanState(migrateToV5(inputData), {
    brainWorkDir,
    runId,
    now: nowIso(now),
    writeFiles: true,
    maxBytes
  });
  const markdown = [
    '# Agent Zero Migration State',
    '',
    'This file is a one-time migration variant of the scan state.',
    'All active v5 tasks rendered below are eligible for project consolidation.',
    'Archived or superseded tasks are listed only by id and must not be used as active source tasks.',
    '',
    rendered.markdown
  ].join('\n');
  const stateFile = path.join(brainWorkDir, `migration-state-${safeFilePart(runId)}.md`);
  fs.writeFileSync(stateFile, markdown, 'utf8');

  return {
    ...rendered,
    markdown,
    stateFile,
    bytes: byteLength(markdown),
    scanStateFile: rendered.stateFile
  };
}

function filterValidatedMarkers(markers, droppedMarkers) {
  const droppedKeys = new Set(normalizeArray(droppedMarkers).map(drop => {
    if (drop.raw || drop.line || drop.type) {
      return `${drop.line ?? ''}\n${drop.type ?? ''}\n${drop.raw ?? ''}`;
    }
    return null;
  }).filter(Boolean));

  return normalizeArray(markers).filter(marker => !droppedKeys.has(markerKey(marker)));
}

export function simulateMigrationMarkers(beforeData, markers, {
  now = new Date(),
  runId = `migration-${Date.now()}`,
  _applyMarkerBatch = applyMarkerBatch
} = {}) {
  const applyResult = _applyMarkerBatch(beforeData, markers, {
    now,
    runId,
    auditLogFile: null,
    idFactory: createDeterministicIdFactory(runId)
  });
  const validMarkers = filterValidatedMarkers(markers, applyResult.dropped);
  const invariants = buildInvariantReport(beforeData, applyResult.data);

  return {
    data: applyResult.data,
    applied: applyResult.applied,
    markers: validMarkers,
    droppedMarkers: applyResult.dropped,
    simulatedResult: buildSimulatedResult(beforeData, applyResult.data),
    invariants
  };
}

function buildPreview({
  runId,
  startedAt,
  finishedAt,
  mode,
  tasksFile,
  tasksHashBefore,
  tasksHashAfter,
  state,
  brainResult,
  premiumRequests,
  parsed,
  simulation
}) {
  const scanDone = scanDonePayload(simulation.markers);
  const workIqCalls = scanDone?.workIqCalls ?? brainResult.counters?.workIqCalls ?? 0;
  const effectivePremiumRequests = scanDone?.premiumRequests ?? premiumRequests;

  return {
    markers: simulation.markers,
    droppedMarkers: simulation.droppedMarkers,
    simulatedResult: simulation.simulatedResult,
    invariants: simulation.invariants,
    runId,
    mode,
    generatedAt: finishedAt,
    startedAt,
    durationMs: brainResult.durationMs ?? null,
    tasksFile,
    tasksHashBefore,
    tasksHashAfter,
    dryRunMutatedTasks: tasksHashBefore !== tasksHashAfter,
    state: {
      stateFile: state.stateFile,
      scanStateFile: state.scanStateFile,
      bytes: state.bytes,
      maxBytes: state.maxBytes,
      truncated: state.truncated,
      spillFiles: state.spillFiles,
      openTaskIds: state.openTaskIds,
      archivedTaskIds: state.archivedTaskIds
    },
    brain: {
      ok: Boolean(brainResult.ok),
      exitCode: brainResult.exitCode ?? null,
      timedOut: Boolean(brainResult.timedOut),
      salvaged: Boolean(brainResult.salvaged),
      killedForToolBudget: Boolean(brainResult.killedForToolBudget),
      workIqCalls,
      premiumRequests: effectivePremiumRequests ?? null,
      stdoutBytes: brainResult.stdoutBytes ?? null,
      stderrBytes: brainResult.stderrBytes ?? null
    },
    parseErrors: parsed.errors,
    scanDone: scanDone || null
  };
}

export async function runMigrationDryRun({
  tasksFile = DEFAULT_TASKS_FILE,
  skillFile = DEFAULT_SKILL_FILE,
  previewFile = DEFAULT_PREVIEW_FILE,
  brainWorkDir = BRAIN_WORK_DIR,
  now = new Date(),
  runId = `migration-${Date.now()}`,
  stateMaxBytes = DEFAULT_MIGRATION_STATE_MAX_BYTES,
  _readJsonFile = readJsonFile,
  _writeJsonFileAtomic = writeJsonFileAtomic,
  _renderMigrationState = renderMigrationState,
  _runBrain = runBrain,
  _parseMarkers = parseMarkers,
  _simulateMigrationMarkers = simulateMigrationMarkers
} = {}) {
  const startedAt = nowIso(now);
  let premiumRequests = null;
  const tasksHashBefore = sha256File(tasksFile);
  const beforeData = migrateToV5(_readJsonFile(tasksFile));
  const state = _renderMigrationState(beforeData, {
    brainWorkDir,
    runId,
    now,
    maxBytes: stateMaxBytes
  });
  const skillText = fs.readFileSync(skillFile, 'utf8');
  const prompt = buildMigrationPrompt({ skillText, stateFile: state.stateFile, runId });

  const brainResult = await _runBrain({
    prompt,
    brainWorkDir,
    workIqHardLimit: MIGRATION_WORKIQ_HARD_LIMIT,
    onJsonEvent: (event) => {
      const value = extractPremiumRequests(event);
      if (value !== null) premiumRequests = value;
    }
  });
  const tasksHashAfter = sha256File(tasksFile);

  if (tasksHashBefore !== tasksHashAfter) {
    throw new Error('Dry-run aborted: tasks.json changed during migration dry-run');
  }
  if (!brainResult.ok) {
    throw new Error(brainResult.error?.message || 'Migration brain run failed');
  }

  const parsed = _parseMarkers(brainResult.assistantText || '');
  if (!parsed.markers.length) {
    const suffix = parsed.errors.length ? ` (${parsed.errors.length} parse error(s))` : '';
    throw new Error(`Migration brain output had no valid markers${suffix}`);
  }

  const simulation = _simulateMigrationMarkers(beforeData, parsed.markers, { now, runId });
  const preview = buildPreview({
    runId,
    startedAt,
    finishedAt: nowIso(new Date()),
    mode: 'dry-run',
    tasksFile,
    tasksHashBefore,
    tasksHashAfter,
    state,
    brainResult,
    premiumRequests,
    parsed,
    simulation
  });

  _writeJsonFileAtomic(previewFile, preview, { maxBackups: 0 });
  return preview;
}

export function applyMigrationPreview({
  tasksFile = DEFAULT_TASKS_FILE,
  previewFile = DEFAULT_PREVIEW_FILE,
  now = new Date(),
  _readJsonFile = readJsonFile,
  _writeJsonFileAtomic = writeJsonFileAtomic,
  _applyMarkerBatch = applyMarkerBatch
} = {}) {
  const preview = _readJsonFile(previewFile);
  if (!Array.isArray(preview.markers) || preview.markers.length === 0) {
    throw new Error('Apply aborted: migration preview has no validated markers');
  }

  const beforeData = migrateToV5(_readJsonFile(tasksFile));
  const runId = preview.runId || `migration-apply-${Date.now()}`;
  const applyResult = _applyMarkerBatch(beforeData, preview.markers, {
    now,
    runId,
    auditLogFile: null,
    idFactory: createDeterministicIdFactory(runId)
  });

  if (applyResult.dropped.length) {
    throw new Error(`Apply aborted: ${applyResult.dropped.length} preview marker(s) no longer validate`);
  }

  const invariants = buildInvariantReport(beforeData, applyResult.data);
  assertInvariantGate(invariants);
  _writeJsonFileAtomic(tasksFile, applyResult.data);

  return {
    appliedMarkers: applyResult.applied,
    droppedMarkers: applyResult.dropped,
    invariants,
    simulatedResult: buildSimulatedResult(beforeData, applyResult.data)
  };
}

function parseArgs(argv) {
  const options = { mode: 'dry-run' };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.mode = 'dry-run';
    } else if (arg === '--apply') {
      options.mode = 'apply';
    } else if (arg === '--tasks-file') {
      options.tasksFile = argv[++i];
    } else if (arg === '--preview-file') {
      options.previewFile = argv[++i];
    } else if (arg === '--brain-work-dir') {
      options.brainWorkDir = argv[++i];
    } else if (arg === '--state-max-bytes') {
      options.stateMaxBytes = Number(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log([
    'Usage: node scripts/migrate-projects-once.mjs [--dry-run|--apply]',
    '',
    'Default mode is --dry-run.',
    '--dry-run renders migration state, runs the Agency brain once, and writes docs/gremium/migration-preview.json.',
    '--apply applies the validated markers from the preview with a hard invariants gate.'
  ].join('\n'));
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    printHelp();
    return;
  }

  if (options.mode === 'apply') {
    const result = applyMigrationPreview(options);
    console.log(JSON.stringify({
      mode: 'apply',
      appliedMarkers: result.appliedMarkers,
      archivedTaskIds: result.simulatedResult.archivedTaskIds.length,
      invariants: result.invariants
    }, null, 2));
    return;
  }

  const preview = await runMigrationDryRun(options);
  const projectCount = preview.simulatedResult.projectTasks.length;
  const lineItemCount = preview.simulatedResult.projectTasks
    .reduce((sum, project) => sum + normalizeArray(project.lineItems).length, 0);
  console.log(JSON.stringify({
    mode: 'dry-run',
    previewFile: options.previewFile || DEFAULT_PREVIEW_FILE,
    projects: projectCount,
    lineItems: lineItemCount,
    unassigned: preview.simulatedResult.unassignedTaskIds.length,
    workIqCalls: preview.brain.workIqCalls,
    premiumRequests: preview.brain.premiumRequests,
    droppedMarkers: preview.droppedMarkers.length
  }, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  main().catch(err => {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  });
}
