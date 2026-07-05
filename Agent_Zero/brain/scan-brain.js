import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAIN_WORK_DIR, COPILOT_MODEL } from './agency-cli.js';
import { runBrain } from './brain-runner.js';
import { parseMarkers } from './marker-parser.js';
import { applyMarkerBatch } from './marker-applier.js';
import { renderScanState } from './render-scan-state.js';
import { migrateToV5, V5_BRAIN_DEFAULTS, writeJsonFileAtomic } from './tasks-v5.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_TASKS_FILE = path.join(REPO_ROOT, 'tasks.json');
export const DEFAULT_SCAN_SKILL_FILE = path.join(REPO_ROOT, 'docs', 'AGENCY_BRAIN_SCAN_SKILL.md');

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
}

export function normalizeScanDays(value) {
  const parsed = parseInt(value, 10);
  if (!Number.isFinite(parsed)) return 4;
  return Math.min(14, Math.max(1, parsed));
}

export function normalizeScanJobInput(input = {}) {
  const source = input?.scanDays ?? input?.days;
  const normalized = {
    ...(input && typeof input === 'object' && !Array.isArray(input) ? input : {}),
    scanDays: normalizeScanDays(source)
  };
  delete normalized.days;
  return normalized;
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
  const marker = markers.find(item => item.type === 'SCAN_DONE');
  return marker?.payload || null;
}

function buildBootstrapPrompt({ skillText, stateFile, scanDays, runId }) {
  const stateFileName = path.basename(stateFile);
  return [
    skillText.trim(),
    '',
    '# Run Context',
    `- runId: ${runId}`,
    `- scanDays: ${scanDays}`,
    `- stateFile: ./${stateFileName}`,
    '',
    `Read ./${stateFileName} from the current working directory before making any WorkIQ calls.`,
    'Use the marker grammar from the skill exactly. Emit final markers as physical lines.'
  ].join('\n');
}

function countProjectDiff(beforeData, afterData) {
  const beforeIds = new Set((beforeData.tasks || []).map(task => task.id));
  let newProjects = 0;
  let updatedProjects = 0;
  let newSingleTasks = 0;

  for (const task of afterData.tasks || []) {
    if (!beforeIds.has(task.id)) {
      if (task.taskType === 'project') newProjects++;
      else newSingleTasks++;
      continue;
    }
    const beforeTask = (beforeData.tasks || []).find(item => item.id === task.id);
    if (task.taskType === 'project' && beforeTask && beforeTask.updatedAt !== task.updatedAt) {
      updatedProjects++;
    }
  }

  return { newProjects, updatedProjects, newSingleTasks };
}

function setBrainTelemetry(data, {
  runId,
  outcome,
  premiumRequests,
  workIqCalls,
  now
}) {
  data.brain = {
    ...V5_BRAIN_DEFAULTS,
    ...(data.brain || {}),
    engine: 'agency',
    model: COPILOT_MODEL,
    lastRunId: runId,
    lastRunAt: nowIso(now),
    lastOutcome: outcome,
    lastPremiumRequests: premiumRequests ?? data.brain?.lastPremiumRequests ?? null,
    lastWorkIqCalls: workIqCalls ?? data.brain?.lastWorkIqCalls ?? null
  };
}

function addPartialReviewHint(data, { now }) {
  data.reviewQueue = Array.isArray(data.reviewQueue) ? data.reviewQueue : [];
  data.reviewQueue.push({
    kind: 'other',
    ref: null,
    question: 'Agency brain scan ended without SCAN_DONE; valid markers were applied as a partial result and should be reviewed.',
    confidence: 'low',
    createdAt: nowIso(now)
  });
}

async function persistJob(job, onPersistJob) {
  if (onPersistJob) await onPersistJob(job);
}

async function setPhase(job, phase, extra, onPersistJob) {
  if (!job) return;
  job.progress = {
    phase,
    phaseStartedAt: Date.now(),
    currentItemIndex: 0,
    totalItems: 0,
    currentTaskId: null,
    ...extra
  };
  job.emit?.('job.phase_changed', { phase, ...extra });
  await persistJob(job, onPersistJob);
}

export async function runBrainScanOnce(job, {
  tasksFile = DEFAULT_TASKS_FILE,
  skillFile = DEFAULT_SCAN_SKILL_FILE,
  brainWorkDir = BRAIN_WORK_DIR,
  scanDays = normalizeScanDays(job?.input?.scanDays ?? job?.input?.days),
  now = new Date(),
  runId = `scan-${Date.now()}`,
  _readJsonFile = readJsonFile,
  _writeJsonFileAtomic = writeJsonFileAtomic,
  _renderScanState = renderScanState,
  _runBrain = runBrain,
  _parseMarkers = parseMarkers,
  _applyMarkerBatch = applyMarkerBatch,
  onPersistJob = null
} = {}) {
  const appliedAt = nowIso(now);
  let premiumRequests = null;

  await setPhase(job, 'brain_prepare', { scanDays }, onPersistJob);
  const beforeData = migrateToV5(_readJsonFile(tasksFile));
  const state = _renderScanState(beforeData, { brainWorkDir, runId, now: appliedAt, writeFiles: true });
  const skillText = fs.readFileSync(skillFile, 'utf8');
  const prompt = buildBootstrapPrompt({ skillText, stateFile: state.stateFile, scanDays, runId });
  job?.emit?.('job.phase_done', {
    phase: 'brain_prepare',
    stateFile: path.basename(state.stateFile),
    stateBytes: state.bytes,
    spillFiles: state.spillFiles.length
  });

  await setPhase(job, 'brain_run', {
    scanDays,
    stateFile: path.basename(state.stateFile),
    stateBytes: state.bytes
  }, onPersistJob);

  const brainResult = await _runBrain({
    prompt,
    brainWorkDir,
    onJsonEvent: (event) => {
      const value = extractPremiumRequests(event);
      if (value !== null) premiumRequests = value;
    },
    onToolExecution: (event, counters) => {
      job?.emit?.('job.item_progress', {
        phase: 'brain_run',
        eventType: event.type,
        toolExecutionEvents: counters.toolExecutionEvents,
        workIqCalls: counters.workIqCalls
      });
    }
  });
  job?.emit?.('job.phase_done', {
    phase: 'brain_run',
    ok: brainResult.ok,
    salvaged: Boolean(brainResult.salvaged),
    workIqCalls: brainResult.counters?.workIqCalls ?? 0,
    premiumRequests
  });

  await setPhase(job, 'brain_apply', { scanDays }, onPersistJob);

  if (!brainResult.ok) {
    const message = brainResult.error?.message || 'Agency brain run failed';
    if (job) {
      job.result = { outcome: 'failed', error: message, historyFree: true };
      job.error = message;
    }
    throw new Error(message);
  }

  const parsed = _parseMarkers(brainResult.assistantText || '');
  if (!parsed.markers.length) {
    const message = parsed.errors.length
      ? `Agency brain output had no valid markers (${parsed.errors.length} parse error(s))`
      : 'Agency brain output had no markers';
    if (job) {
      job.result = { outcome: 'failed', error: message, historyFree: true, parseErrors: parsed.errors };
      job.error = message;
    }
    throw new Error(message);
  }

  const scanDone = scanDonePayload(parsed.markers);
  const applyResult = _applyMarkerBatch(beforeData, parsed.markers, {
    now,
    runId,
    auditLogFile: null
  });
  const afterData = applyResult.data;
  const partial = brainResult.salvaged || !scanDone || scanDone.outcome === 'partial';
  const outcome = partial ? 'partial' : 'success';
  const workIqCalls = scanDone?.workIqCalls ?? brainResult.counters?.workIqCalls ?? 0;
  const runIdForTelemetry = scanDone?.runId || runId;

  if (!scanDone) addPartialReviewHint(afterData, { now });
  setBrainTelemetry(afterData, {
    runId: runIdForTelemetry,
    outcome,
    premiumRequests,
    workIqCalls,
    now
  });

  _writeJsonFileAtomic(tasksFile, afterData);

  const diffCounts = countProjectDiff(beforeData, afterData);
  const result = {
    outcome,
    runId: runIdForTelemetry,
    newProjects: scanDone?.newProjects ?? diffCounts.newProjects,
    updatedProjects: scanDone?.updatedProjects ?? diffCounts.updatedProjects,
    newSingleTasks: scanDone?.newSingleTasks ?? diffCounts.newSingleTasks,
    workIqCalls,
    premiumRequests,
    droppedMarkers: applyResult.dropped,
    appliedMarkers: applyResult.applied,
    parseErrors: parsed.errors,
    salvaged: Boolean(brainResult.salvaged),
    scanDone: Boolean(scanDone)
  };

  if (job) job.result = result;
  job?.emit?.('job.phase_done', { phase: 'brain_apply', ...result });
  await persistJob(job, onPersistJob);
  return result;
}

export function getScanEngine(env = process.env) {
  return env.AGENT_ZERO_SCAN_ENGINE === 'agency' ? 'agency' : 'legacy';
}
