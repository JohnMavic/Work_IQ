import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRAIN_WORK_DIR, COPILOT_MODEL } from './agency-cli.js';
import { runBrain } from './brain-runner.js';
import { parseMarkers } from './marker-parser.js';
import { applyMarkerBatch } from './marker-applier.js';
import { renderScanState } from './render-scan-state.js';
import { filterMarkersThroughGateway, runRealityGateway } from './reality-gateway.js';
import { filterMarkersByProcessingQualityGate } from './processing-ledger.js';
import { runProcessingQualityCorrection, selectCorrectableIssuesFromGate } from './processing-quality-correction.js';
import { filterMarkersByTemporalPassGate } from './temporal-pass.js';
import { filterMarkersByProjectIdentity, reconcileProjectFragments } from './project-identity.js';
import { migrateToV5, V5_BRAIN_DEFAULTS, writeJsonFileAtomic } from './tasks-v5.js';
import { BRAIN_RUN_CLASS } from './brain-scheduler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_TASKS_FILE = path.join(REPO_ROOT, 'tasks.json');
export const DEFAULT_SCAN_SKILL_FILE = path.join(REPO_ROOT, 'docs', 'AGENCY_BRAIN_SCAN_SKILL.md');
export const DEFAULT_OWA_ATTACHMENT_HELPER = path.join(REPO_ROOT, 'brain', 'tools', 'owa-attachment.ps1');

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
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

export function computeDiscoveryWindow({ now = new Date(), scanDays = 4, lastScan = null } = {}) {
  const endMs = now instanceof Date ? now.getTime() : Date.parse(now);
  const safeEndMs = Number.isFinite(endMs) ? endMs : Date.now();
  const requestedStartMs = safeEndMs - normalizeScanDays(scanDays) * 24 * 60 * 60 * 1000;
  const recoveryFloorMs = safeEndMs - 14 * 24 * 60 * 60 * 1000;
  const lastScanMs = Date.parse(lastScan || '');
  const startMs = Number.isFinite(lastScanMs) && lastScanMs < safeEndMs
    ? Math.max(recoveryFloorMs, Math.min(requestedStartMs, lastScanMs))
    : requestedStartMs;
  return {
    start: new Date(startMs).toISOString(),
    end: new Date(safeEndMs).toISOString()
  };
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

function buildBootstrapPrompt({ skillText, stateFile, scanDays, runId, discoveryWindow }) {
  const stateFileName = path.basename(stateFile);
  return [
    skillText.trim(),
    '',
    '# Run Context',
    `- runId: ${runId}`,
    `- scanDays: ${scanDays}`,
    `- discoveryWindowStart: ${discoveryWindow.start}`,
    `- discoveryWindowEnd: ${discoveryWindow.end}`,
    `- stateFile: ./${stateFileName}`,
    '',
    `Read ./${stateFileName} from the current working directory before making any WorkIQ calls.`,
    'Use the exact discovery window above. Complete both the recent-email-enumeration and material-consequence discovery passes, and report both in SCAN_DONE.processingQuality.discoveryPasses.',
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

function addQualityGateReviewHint(data, { now, reason }) {
  data.reviewQueue = Array.isArray(data.reviewQueue) ? data.reviewQueue : [];
  data.reviewQueue.push({
    kind: 'other',
    ref: null,
    question: `Agency brain scan was partially held by the Batch 7 processing-ledger quality gate: ${reason}`,
    confidence: 'low',
    createdAt: nowIso(now)
  });
}

function addQualityGateReviewHints(data, { now, qualityGate }) {
  const reasons = [
    ...normalizeArray(qualityGate?.held).map(item => item.reason),
    ...normalizeArray(qualityGate?.reviewReasons).map(item => item.reason)
  ].filter(Boolean);
  const seen = new Set();
  for (const reason of reasons) {
    if (seen.has(reason)) continue;
    seen.add(reason);
    addQualityGateReviewHint(data, { now, reason });
  }
}

function addTemporalPassReviewHints(data, { now, temporalGate }) {
  data.reviewQueue = Array.isArray(data.reviewQueue) ? data.reviewQueue : [];
  const seen = new Set();
  for (const item of normalizeArray(temporalGate?.reviewReasons)) {
    const reason = item?.reason;
    if (!reason || seen.has(reason)) continue;
    seen.add(reason);
    data.reviewQueue.push({
      kind: 'other',
      ref: item.ref || null,
      question: reason,
      confidence: 'low',
      createdAt: nowIso(now)
    });
  }
}

function addProjectIdentityReviewHints(data, { now, identityGate }) {
  data.reviewQueue = Array.isArray(data.reviewQueue) ? data.reviewQueue : [];
  const seen = new Set(data.reviewQueue.map(item => `${item.kind || 'other'}:${item.ref || ''}:${item.question || ''}`));
  for (const item of normalizeArray(identityGate?.reviewReasons)) {
    const question = item?.reason || item?.question;
    if (!question) continue;
    const entry = {
      kind: 'assignment',
      ref: item.ref || null,
      question,
      confidence: 'low',
      createdAt: nowIso(now)
    };
    const key = `${entry.kind}:${entry.ref || ''}:${entry.question}`;
    if (seen.has(key)) continue;
    seen.add(key);
    data.reviewQueue.push(entry);
  }
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

function schedulerProgress(job, phase, extra, onPersistJob) {
  return (update) => {
    if (!job || update?.state === 'finished') return;
    const queued = update?.state === 'queued';
    const effectivePhase = queued ? 'queued' : phase;
    job.progress = {
      ...(job.progress || {}),
      phase: effectivePhase,
      phaseStartedAt: update?.startedAt || Date.now(),
      queuedAhead: update?.queuedAhead ?? 0,
      runClass: update?.runClass,
      scheduler: update?.scheduler,
      ...extra
    };
    job.emit?.('job.progress', {
      phase: effectivePhase,
      activePhase: phase,
      queuedAhead: update?.queuedAhead ?? 0,
      runClass: update?.runClass,
      schedulerState: update?.state,
      scheduler: update?.scheduler,
      ...extra
    });
    persistJob(job, onPersistJob).catch(() => {});
  };
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
  _runGateway = runRealityGateway,
  _parseMarkers = parseMarkers,
  _applyMarkerBatch = applyMarkerBatch,
  _runCorrection = runProcessingQualityCorrection,
  onPersistJob = null
} = {}) {
  const appliedAt = nowIso(now);
  let premiumRequests = null;

  await setPhase(job, 'brain_prepare', { scanDays }, onPersistJob);
  const beforeData = migrateToV5(_readJsonFile(tasksFile));
  const discoveryWindow = computeDiscoveryWindow({ now, scanDays, lastScan: beforeData.lastScan });
  const state = _renderScanState(beforeData, { brainWorkDir, runId, now: appliedAt, writeFiles: true });
  const skillText = fs.readFileSync(skillFile, 'utf8');
  const prompt = buildBootstrapPrompt({ skillText, stateFile: state.stateFile, scanDays, runId, discoveryWindow });
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
    runClass: BRAIN_RUN_CLASS.BACKGROUND,
    schedulerLabel: `scan:${runId}`,
    onSchedulerUpdate: schedulerProgress(job, 'brain_run', {
      scanDays,
      stateFile: path.basename(state.stateFile)
    }, onPersistJob),
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

  await setPhase(job, 'brain_gateway', { scanDays }, onPersistJob);

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

  const identityGate = filterMarkersByProjectIdentity(beforeData, parsed.markers, { now });

  // Bounded pre-gateway processing-quality correction (single attempt, never a loop).
  // We run the processing-ledger quality gate on the post-identity markers ONLY to discover
  // correctable omissions (an enumerated item whose ledger disposition the brain forgot). If any
  // exist, we ask the brain for exactly those missing dispositions once and strictly accept only
  // valid corrections. The corrected markers are then sent through the existing Reality Gateway;
  // this pre-gateway gate is never used to approve state.
  const correctionGateOptions = {
    requireDiscoveryCoverage: true,
    requiredDiscoveryWindow: discoveryWindow,
    requireAttachmentCoverage: true
  };
  const preCorrectionGate = filterMarkersByProcessingQualityGate(identityGate.markers, correctionGateOptions);
  const correctableIssues = selectCorrectableIssuesFromGate(preCorrectionGate, identityGate.markers);
  let markersForGateway = identityGate.markers;
  let qualityCorrection = {
    attempted: false,
    eligibleIssues: correctableIssues.length,
    runOk: false,
    parsed: 0,
    received: 0,
    applied: 0,
    rejected: 0,
    rejectedReasons: [],
    preGateOk: Boolean(preCorrectionGate.ok),
    postCorrectionGateOk: Boolean(preCorrectionGate.ok),
    remainingReason: preCorrectionGate.reason || null,
    workIqCalls: 0,
    durationMs: 0
  };

  if (correctableIssues.length) {
    await setPhase(job, 'brain_quality_correction', {
      scanDays,
      correctableIssues: correctableIssues.length
    }, onPersistJob);
    const correctionResult = await _runCorrection({
      markers: identityGate.markers,
      stateFile: state.stateFile,
      factSheetFiles: state.factSheetFiles || [],
      brainWorkDir,
      runId,
      gateOptions: correctionGateOptions,
      now,
      onSchedulerUpdate: schedulerProgress(job, 'brain_quality_correction', { scanDays }, onPersistJob)
    });
    qualityCorrection = correctionResult?.telemetry || qualityCorrection;
    if (correctionResult?.corrected && Array.isArray(correctionResult.correctedMarkers)) {
      markersForGateway = correctionResult.correctedMarkers;
    }
    job?.emit?.('job.phase_done', { phase: 'brain_quality_correction', ...qualityCorrection });
    await setPhase(job, 'brain_gateway', { scanDays }, onPersistJob);
  }

  const gatewayResult = await _runGateway({
    stateFile: state.stateFile,
    factSheetFiles: state.factSheetFiles || [],
    markers: markersForGateway,
    brainWorkDir,
    runId,
    learningsBlock: state.learningsMarkdown,
    runClass: BRAIN_RUN_CLASS.BACKGROUND,
    onSchedulerUpdate: schedulerProgress(job, 'brain_gateway', { scanDays }, onPersistJob)
  });
  const gatewayFilter = filterMarkersThroughGateway(markersForGateway, gatewayResult);
  job?.emit?.('job.phase_done', {
    phase: 'brain_gateway',
    ok: Boolean(gatewayResult.ok),
    approvedMarkers: gatewayFilter.approved.length,
    heldMarkers: gatewayFilter.held.length,
    identityHeldMarkers: identityGate.held.length,
    identityAutoAttached: identityGate.autoAttached.length,
    gatewayParsed: gatewayFilter.gatewayParsed,
    workIqCalls: gatewayResult.counters?.workIqCalls ?? 0
  });

  await setPhase(job, 'brain_apply', { scanDays }, onPersistJob);

  const scanDone = scanDonePayload(identityGate.markers);
  const qualityGate = filterMarkersByProcessingQualityGate(gatewayFilter.markers, {
    requireDiscoveryCoverage: true,
    requiredDiscoveryWindow: discoveryWindow,
    requireAttachmentCoverage: true
  });
  const temporalGate = filterMarkersByTemporalPassGate(beforeData, qualityGate.markers, { now });
  const applyResult = _applyMarkerBatch(beforeData, temporalGate.markers, {
    now,
    runId,
    auditLogFile: null,
    advanceScanWatermark: false
  });
  const reconciliation = reconcileProjectFragments(applyResult.data, { now });
  const afterData = reconciliation.data;
  if (!scanDone) addPartialReviewHint(afterData, { now });
  addQualityGateReviewHints(afterData, { now, qualityGate });
  addTemporalPassReviewHints(afterData, { now, temporalGate });
  addProjectIdentityReviewHints(afterData, { now, identityGate });
  addProjectIdentityReviewHints(afterData, {
    now,
    identityGate: { reviewReasons: reconciliation.reviewReasons }
  });
  const partial = brainResult.salvaged
    || !scanDone
    || scanDone.outcome === 'partial'
    || identityGate.held.length > 0
    || gatewayFilter.held.length > 0
    || applyResult.dropped.length > 0
    || !qualityGate.ok
    || !temporalGate.ok;
  const outcome = partial ? 'partial' : 'success';
  const workIqCalls = scanDone?.workIqCalls ?? brainResult.counters?.workIqCalls ?? 0;
  const runIdForTelemetry = scanDone?.runId || runId;

  if (outcome === 'success') afterData.lastScan = nowIso(now);
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
    newProjects: diffCounts.newProjects,
    updatedProjects: diffCounts.updatedProjects,
    newSingleTasks: diffCounts.newSingleTasks,
    workIqCalls,
    premiumRequests,
    discoveryWindow,
    droppedMarkers: applyResult.dropped,
    appliedMarkers: applyResult.applied,
    heldMarkers: identityGate.held.length + gatewayFilter.held.length + qualityGate.held.length + temporalGate.held.length,
    reviewItems: identityGate.reviewReasons.length + reconciliation.reviewReasons.length + qualityGate.reviewReasons.length + temporalGate.reviewReasons.length,
    identity: {
      heldMarkers: identityGate.held.length,
      autoAttached: identityGate.autoAttached.length,
      reconciledFragments: reconciliation.attached.length,
      reconciliationHeld: reconciliation.held.length,
      reviewItems: identityGate.reviewReasons.length + reconciliation.reviewReasons.length
    },
    gateway: {
      ok: Boolean(gatewayResult.ok),
      approvedMarkers: gatewayFilter.approved.length,
      heldMarkers: gatewayFilter.held.length,
      parsed: gatewayFilter.gatewayParsed,
      parseError: gatewayFilter.gatewayParseError,
      retryCount: gatewayResult.retryCount || 0,
      firstParseError: gatewayResult.firstParseError || null
    },
    qualityGate: {
      ok: qualityGate.ok,
      reason: qualityGate.reason,
      skipped: Boolean(qualityGate.skipped),
      ledgerItems: qualityGate.ledgerCount,
      heldMarkers: qualityGate.held.length,
      reviewItems: qualityGate.reviewReasons.length
    },
    qualityCorrection,
    temporalGate: {
      ok: temporalGate.ok,
      reason: temporalGate.reason,
      staleNodes: temporalGate.staleNodes.length,
      addressed: temporalGate.addressed.length,
      heldMarkers: temporalGate.held.length,
      reviewItems: temporalGate.reviewReasons.length
    },
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
