import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeDiscoveryWindow, runBrainScanOnce } from '../../brain/scan-brain.js';
import { migrateToV5, writeJsonFileAtomic } from '../../brain/tasks-v5.js';
import { runProcessingQualityCorrection } from '../../brain/processing-quality-correction.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-brain-scan');

function resetTmp(name) {
  const dir = path.join(tmpRoot, name);
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    return resetTmp(`${name}-${process.pid}-${Date.now()}`);
  }
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function marker(type, payload) {
  return `[${type}] ${JSON.stringify(payload)}`;
}

function relevance(evidenceRefId, score = 60) {
  return { score, reason: 'Material to the project outcome.', evidenceRefIds: [evidenceRefId] };
}

function scanDone(payload, { now, scanDays = 4, lastScan = null } = {}) {
  const window = computeDiscoveryWindow({ now, scanDays, lastScan });
  const processingQuality = payload.processingQuality || {};
  const itemCount = Array.isArray(processingQuality.enumeratedItems)
    ? processingQuality.enumeratedItems.length
    : 0;
  return marker('SCAN_DONE', {
    ...payload,
    processingQuality: {
      required: true,
      discoveryPasses: [
        { kind: 'recent-email-enumeration', windowStart: window.start, windowEnd: window.end, itemCount, candidateCount: itemCount },
        { kind: 'material-consequence', windowStart: window.start, windowEnd: window.end, itemCount, candidateCount: itemCount }
      ],
      ...processingQuality
    }
  });
}

function makeJob(input = {}) {
  const events = [];
  return {
    input,
    progress: null,
    result: null,
    error: null,
    emit(type, payload = {}) {
      events.push({ type, payload });
    },
    events
  };
}

function writeFixture(dir, data) {
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, `${JSON.stringify(migrateToV5(data), null, 2)}\n`, 'utf8');
  return file;
}

function fakeBrain(assistantText, extra = {}) {
  return async ({ onJsonEvent, onToolExecution }) => {
    if (typeof extra.premiumRequests === 'number') {
      onJsonEvent?.({ type: 'result', data: { usage: { premiumRequests: extra.premiumRequests } } });
    }
    if (extra.workIqCalls) {
      for (let i = 0; i < extra.workIqCalls; i++) {
        onToolExecution?.({ type: 'tool.execution_start', data: { toolName: 'workiq.ask' } }, {
          toolExecutionEvents: i + 1,
          toolExecutionStarts: i + 1,
          workIqCalls: i + 1
        });
      }
    }
    return {
      ok: extra.ok ?? true,
      assistantText,
      counters: {
        workIqCalls: extra.workIqCalls || 0
      },
      salvaged: Boolean(extra.salvaged),
      error: extra.error || null
    };
  };
}

async function fakeGatewayApproveAll({ markers }) {
  return {
    ok: true,
    text: JSON.stringify({
      decisions: markers.map((_, markerIndex) => ({
        markerIndex,
        decision: 'approve',
        reason: 'Unit test approval.'
      }))
    }),
    counters: { workIqCalls: 0 }
  };
}

function countingAtomicWriter(counter) {
  return (file, data) => {
    counter.count++;
    writeJsonFileAtomic(file, data, { maxBackups: 0 });
  };
}

test('B-1 fake brain output mutates tasks.json with one atomic write', async () => {
  const dir = resetTmp('b1');
  const tasksFile = writeFixture(dir, {
    version: 4,
    tasks: [{
      id: 'source-1',
      title: 'Source task',
      status: 'new',
      history: []
    }]
  });
  const writes = { count: 0 };
  const output = [
    marker('PROJECT_NEW', {
      taskId: 'proj-1',
      projectKey: 'alpha-rollout',
      title: 'Alpha rollout',
      summary: 'Alpha summary',
      sourceRefs: [{
        id: 'src-alpha',
        type: 'email',
        title: 'Alpha update',
        date: '2026-07-05T08:00:00.000Z',
        link: 'https://example.test/alpha'
      }],
      lineItems: [{
        id: 'li-alpha',
        title: 'Install alpha',
        status: 'open',
        relevance: relevance('src-alpha', 72),
        evidenceRefIds: ['src-alpha'],
        sourceTaskIds: ['source-1']
      }],
      supersedesTaskIds: ['source-1']
    }),
    scanDone({
      runId: 'run-b1',
      outcome: 'success',
      newProjects: 1,
      updatedProjects: 0,
      newSingleTasks: 0,
      workIqCalls: 2
    }, { now: new Date('2026-07-05T10:00:00.000Z'), scanDays: 5 })
  ].join('\n');

  const job = makeJob({ scanDays: 5 });
  const result = await runBrainScanOnce(job, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-b1',
    now: new Date('2026-07-05T10:00:00.000Z'),
    _runBrain: fakeBrain(output, { premiumRequests: 7, workIqCalls: 2 }),
    _runGateway: fakeGatewayApproveAll,
    _writeJsonFileAtomic: countingAtomicWriter(writes)
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(writes.count, 1);
  assert.equal(result.outcome, 'success');
  assert.equal(result.newProjects, 1);
  assert.equal(result.workIqCalls, 2);
  assert.equal(result.premiumRequests, 7);
  assert.equal(saved.tasks.length, 2);
  assert.equal(saved.tasks.find(task => task.id === 'proj-1').taskType, 'project');
  assert.equal(saved.tasks.find(task => task.id === 'source-1').archived, true);
  assert.ok(job.events.some(event => event.type === 'job.phase_changed' && event.payload.phase === 'brain_prepare'));
  assert.ok(job.events.some(event => event.type === 'job.phase_changed' && event.payload.phase === 'brain_run'));
  assert.ok(job.events.some(event => event.type === 'job.phase_changed' && event.payload.phase === 'brain_apply'));
});

test('B-2 invalid brain output leaves tasks.json unchanged and marks job failed result', async () => {
  const dir = resetTmp('b2');
  const initial = migrateToV5({
    version: 4,
    tasks: [{ id: 'task-1', title: 'Keep', status: 'new' }]
  });
  const tasksFile = writeFixture(dir, initial);
  const before = fs.readFileSync(tasksFile, 'utf8');
  const writes = { count: 0 };
  const job = makeJob({ scanDays: 4 });

  await assert.rejects(
    runBrainScanOnce(job, {
      tasksFile,
      brainWorkDir: path.join(dir, 'brain-work'),
      runId: 'run-b2',
      _runBrain: fakeBrain('not marker output'),
      _runGateway: fakeGatewayApproveAll,
      _writeJsonFileAtomic: countingAtomicWriter(writes)
    }),
    /no markers/
  );

  assert.equal(writes.count, 0);
  assert.equal(fs.readFileSync(tasksFile, 'utf8'), before);
  assert.equal(job.result.outcome, 'failed');
  assert.equal(job.result.historyFree, true);
});

test('B-3 missing SCAN_DONE applies valid markers as partial with review hint', async () => {
  const dir = resetTmp('b3');
  const tasksFile = writeFixture(dir, { version: 5, tasks: [] });
  const output = marker('TASK_NEW', {
    taskId: 'single-1',
    title: 'Standalone action',
    summary: 'Follow up',
    sourceRef: {
      id: 'src-single',
      type: 'email',
      title: 'Standalone email',
      date: '2026-07-05T08:00:00.000Z',
      link: 'https://example.test/single'
    },
    status: 'new'
  });

  const result = await runBrainScanOnce(makeJob(), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-b3',
    now: new Date('2026-07-05T10:00:00.000Z'),
    _runBrain: fakeBrain(output),
    _runGateway: fakeGatewayApproveAll
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(result.outcome, 'partial');
  assert.equal(result.scanDone, false);
  assert.equal(saved.tasks.length, 1);
  assert.equal(saved.brain.lastOutcome, 'partial');
  assert.match(saved.reviewQueue[0].question, /without SCAN_DONE/);
});

test('timeout salvage applies markers normally but forces partial outcome', async () => {
  const dir = resetTmp('timeout-salvage');
  const tasksFile = writeFixture(dir, { version: 5, tasks: [] });
  const output = [
    marker('TASK_NEW', {
      taskId: 'single-salvage',
      title: 'Salvaged action',
      sourceRef: {
        id: 'src-salvage',
        date: '2026-07-05T08:00:00.000Z',
        link: 'https://example.test/salvage'
      }
    }),
    scanDone({ runId: 'run-salvage', outcome: 'success', newSingleTasks: 1 }, { now: new Date('2026-07-05T10:00:00.000Z') })
  ].join('\n');

  const result = await runBrainScanOnce(makeJob(), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-salvage',
    now: new Date('2026-07-05T10:00:00.000Z'),
    _runBrain: fakeBrain(output, { salvaged: true }),
    _runGateway: fakeGatewayApproveAll
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(result.outcome, 'partial');
  assert.equal(result.salvaged, true);
  assert.equal(saved.tasks[0].id, 'single-salvage');
});

test('B-4 consolidation fixture creates one project with two same-place workstreams and one separate project', async () => {
  const dir = resetTmp('b4');
  const tasksFile = writeFixture(dir, { version: 5, tasks: [] });
  const output = [
    marker('PROJECT_NEW', {
      taskId: 'proj-campus',
      projectKey: 'campus-refresh',
      title: 'Campus refresh',
      sourceRefs: [
        { id: 'src-campus-1', date: '2026-07-05T08:00:00.000Z', link: 'https://example.test/campus/1' },
        { id: 'src-campus-2', date: '2026-07-05T08:10:00.000Z', link: 'https://example.test/campus/2' }
      ],
      lineItems: [
        { id: 'li-room', title: 'Room preparation', status: 'open', relevance: relevance('src-campus-1', 55), evidenceRefIds: ['src-campus-1'] },
        { id: 'li-network', title: 'Network preparation', status: 'open', relevance: relevance('src-campus-2', 65), evidenceRefIds: ['src-campus-2'] }
      ],
      supersedesTaskIds: []
    }),
    marker('PROJECT_NEW', {
      taskId: 'proj-incident',
      projectKey: 'separate-incident',
      title: 'Separate incident',
      sourceRefs: [{ id: 'src-incident', date: '2026-07-05T09:00:00.000Z', link: 'https://example.test/incident' }],
      lineItems: [{ id: 'li-incident', title: 'Resolve incident', status: 'open', relevance: relevance('src-incident', 80), evidenceRefIds: ['src-incident'] }],
      supersedesTaskIds: []
    }),
    scanDone({ runId: 'run-b4', outcome: 'success', newProjects: 2, updatedProjects: 0, newSingleTasks: 0 }, { now: new Date('2026-07-05T10:00:00.000Z') })
  ].join('\n');

  const result = await runBrainScanOnce(makeJob(), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-b4',
    now: new Date('2026-07-05T10:00:00.000Z'),
    _runBrain: fakeBrain(output),
    _runGateway: fakeGatewayApproveAll
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const projects = saved.tasks.filter(task => task.taskType === 'project');
  const campus = saved.tasks.find(task => task.id === 'proj-campus');

  assert.equal(result.newProjects, 2);
  assert.equal(projects.length, 2);
  assert.equal(campus.lineItems.length, 2);
  assert.equal(campus.sourceRefs.length, 2);
  assert.ok(saved.tasks.find(task => task.id === 'proj-incident'));
});

test('B-5 follow-up scan updates existing project line item instead of duplicating project', async () => {
  const dir = resetTmp('b5');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'proj-follow',
      title: 'Follow project',
      taskType: 'project',
      status: 'new',
      sourceRefs: [{ id: 'src-old', date: '2026-07-04T08:00:00.000Z', link: 'https://example.test/old' }],
      lineItems: [{ id: 'li-follow', title: 'Follow line', status: 'open', evidenceRefIds: ['src-old'] }],
      updatedAt: '2026-07-04T08:00:00.000Z'
    }]
  });
  const output = [
    marker('PROJECT_UPDATE', {
      taskId: 'proj-follow',
      summary: 'Updated project summary',
      sourceRefs: [{ id: 'src-new', date: '2026-07-05T08:00:00.000Z', link: 'https://example.test/new' }],
      supersedesTaskIds: []
    }),
    marker('LINEITEM_UPDATE', {
      taskId: 'proj-follow',
      lineItemId: 'li-follow',
      patch: { status: 'in-progress', currentState: 'Work has started', confidence: 'high' },
      evidenceRefIds: ['src-new']
    }),
    scanDone({ runId: 'run-b5', outcome: 'success', newProjects: 0, updatedProjects: 1, newSingleTasks: 0 }, { now: new Date('2026-07-05T10:00:00.000Z') })
  ].join('\n');

  const result = await runBrainScanOnce(makeJob(), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-b5',
    now: new Date('2026-07-05T10:00:00.000Z'),
    _runBrain: fakeBrain(output),
    _runGateway: fakeGatewayApproveAll
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const projects = saved.tasks.filter(task => task.taskType === 'project');
  const project = saved.tasks.find(task => task.id === 'proj-follow');

  assert.equal(result.updatedProjects, 1);
  assert.equal(projects.length, 1);
  assert.equal(saved.tasks.length, 1);
  assert.equal(project.lineItems[0].status, 'in-progress');
  assert.equal(project.lineItems[0].currentState, 'Work has started');
  assert.equal(project.sourceRefs.length, 2);
});

test('scan result reports applied diff counts instead of SCAN_DONE intent when gateway holds update', async () => {
  const dir = resetTmp('gateway-held-counts');
  const tasksFile = writeFixture(dir, {
    version: 5,
    lastScan: '2026-07-04T07:00:00.000Z',
    tasks: [{
      id: 'proj-held-counts',
      title: 'Held counts project',
      taskType: 'project',
      status: 'new',
      summary: 'Original summary',
      sourceRefs: [{ id: 'src-held-old', date: '2026-07-04T08:00:00.000Z', link: 'https://example.test/held/old' }],
      lineItems: [],
      updatedAt: '2026-07-04T08:00:00.000Z'
    }]
  });
  const output = [
    marker('PROJECT_UPDATE', {
      taskId: 'proj-held-counts',
      summary: 'Gateway-held summary should not apply.',
      sourceRefs: [{ id: 'src-held-new', date: '2026-07-05T08:00:00.000Z', link: 'https://example.test/held/new' }],
      evidenceRefIds: ['src-held-old']
    }),
    scanDone({ runId: 'run-held-counts', outcome: 'success', newProjects: 0, updatedProjects: 1, newSingleTasks: 0 }, { now: new Date('2026-07-05T10:00:00.000Z'), lastScan: '2026-07-04T07:00:00.000Z' })
  ].join('\n');

  const result = await runBrainScanOnce(makeJob(), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-held-counts',
    now: new Date('2026-07-05T10:00:00.000Z'),
    _runBrain: fakeBrain(output),
    _runGateway: async () => ({
      ok: true,
      text: 'GATEWAY_DECISION\t0\tneeds-review\tThe update could not be verified.',
      counters: { workIqCalls: 0 }
    })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const project = saved.tasks.find(task => task.id === 'proj-held-counts');

  assert.equal(result.updatedProjects, 0);
  assert.equal(result.newProjects, 0);
  assert.equal(result.newSingleTasks, 0);
  assert.equal(result.gateway.heldMarkers, 1);
  assert.equal(result.outcome, 'partial');
  assert.equal(saved.lastScan, '2026-07-04T07:00:00.000Z');
  assert.equal(project.summary, 'Original summary');
  assert.equal(project.sourceRefs.some(ref => ref.id === 'src-held-new'), false);
});

test('applier-dropped mutation makes the scan partial and preserves discovery anchor', async () => {
  const dir = resetTmp('applier-dropped-watermark');
  const tasksFile = writeFixture(dir, {
    version: 5,
    lastScan: '2026-07-03T07:00:00.000Z',
    tasks: []
  });
  const output = [
    marker('PROJECT_UPDATE', { taskId: 'missing-project', summary: 'Must be dropped.' }),
    scanDone({ runId: 'run-dropped-watermark', outcome: 'success', workIqCalls: 0 }, { now: new Date('2026-07-05T10:00:00.000Z'), lastScan: '2026-07-03T07:00:00.000Z' })
  ].join('\n');

  const result = await runBrainScanOnce(makeJob(), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-dropped-watermark',
    now: new Date('2026-07-05T10:00:00.000Z'),
    _runBrain: fakeBrain(output),
    _runGateway: fakeGatewayApproveAll
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(result.outcome, 'partial');
  assert.equal(result.droppedMarkers.length, 1);
  assert.equal(saved.lastScan, '2026-07-03T07:00:00.000Z');
});

test('project identity preflight attaches an exact-alias TASK_NEW to the existing project', async () => {
  const dir = resetTmp('identity-auto-attach');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'proj-phoenix',
      taskType: 'project',
      projectKey: 'PHOENIX-MIGRATION',
      projectAliases: ['Project Phoenix'],
      title: 'Phoenix Migration',
      status: 'in-progress',
      sourceRefs: [],
      lineItems: []
    }]
  });
  const output = [
    marker('TASK_NEW', {
      taskId: 'single-phoenix-handoff',
      title: 'Prepare Project Phoenix handoff',
      summary: 'Send the final handoff package.',
      sourceRef: {
        type: 'email',
        itemId: 'mail-phoenix-handoff',
        conversationId: 'conv-phoenix-handoff',
        date: '2026-07-15T08:00:00.000Z',
        link: 'https://example.test/phoenix/handoff'
      },
      processingLedger: [{
        itemRef: { type: 'email', id: 'mail-phoenix-handoff' },
        threadRef: 'conv-phoenix-handoff',
        date: '2026-07-15T08:00:00.000Z',
        disposition: 'new-node',
        nodeRefs: [],
        attachmentsHandled: 'none',
        quote: 'Please send the final handoff package.',
        reason: 'This is a new workstream in the existing project.'
      }]
    }),
    scanDone({ runId: 'identity-auto-attach', outcome: 'success', workIqCalls: 1 }, { now: new Date('2026-07-15T09:00:00.000Z') })
  ].join('\n');

  const result = await runBrainScanOnce(makeJob(), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'identity-auto-attach',
    now: new Date('2026-07-15T09:00:00.000Z'),
    _runBrain: fakeBrain(output, { workIqCalls: 1 }),
    _runGateway: fakeGatewayApproveAll
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const project = saved.tasks.find(task => task.id === 'proj-phoenix');

  assert.equal(saved.tasks.length, 1);
  assert.equal(project.lineItems.length, 1);
  assert.equal(project.lineItems[0].title, 'Prepare Project Phoenix handoff');
  assert.equal(project.sourceRefs[0].itemId, 'mail-phoenix-handoff');
  assert.equal(project.brainState.lastEvidenceAt, '2026-07-15T08:00:00.000Z');
  assert.equal(project.brainState.lastScanRunId, 'identity-auto-attach');
  assert.equal(result.newSingleTasks, 0);
  assert.equal(result.identity.autoAttached, 1);
});

// -----------------------------------------------------------------------------
// Bounded pre-gateway processing-quality correction pass (single attempt).
//
// Boundary invariant: the pass only repairs a ledger disposition for an item the scan already
// enumerated on a processing-ledger marker. It never invents an item that was never enumerated,
// never mutates state directly, and never lets the pre-gateway gate approve state — the corrected
// marker still passes through the Reality Gateway and the existing final quality gate.
// -----------------------------------------------------------------------------

const CORRECTION_NOW = new Date('2026-07-05T10:00:00.000Z');
const CORRECTION_SCAN_DAYS = 5;

function coltEnumerated() {
  return { itemRef: { type: 'email', id: 'colt-1' }, threadRef: 'thread-colt', date: '2026-07-05T08:00:00.000Z' };
}

function coltLedger(overrides = {}) {
  return {
    itemRef: { type: 'email', id: 'colt-1' },
    threadRef: 'thread-colt',
    date: '2026-07-05T08:00:00.000Z',
    disposition: 'updates-node',
    nodeRefs: ['li-circuit'],
    attachmentsHandled: 'none',
    quote: 'Colt confirmed the Zurich circuit delivery window for August.',
    reason: 'Updates the existing circuit line item; no new node required.',
    ...overrides
  };
}

function seestrasseProjectMarker({ ledger = [] } = {}) {
  return marker('PROJECT_NEW', {
    taskId: 'proj-seestrasse',
    projectKey: 'seestrasse',
    title: 'Seestrasse Workspace',
    summary: 'Workspace circuit works.',
    sourceRefs: [{ id: 'src-colt', type: 'email', title: 'Colt circuit', date: '2026-07-05T08:00:00.000Z', link: 'https://example.test/colt' }],
    lineItems: [{ id: 'li-circuit', title: 'Circuit delivery', status: 'open', relevance: relevance('src-colt', 70), evidenceRefIds: ['src-colt'] }],
    supersedesTaskIds: [],
    processing: { enumeratedItems: [coltEnumerated()], ledger }
  });
}

function correctionSpy(brainImpl) {
  const calls = { runner: 0, brain: 0 };
  const runner = (options) => {
    calls.runner++;
    return runProcessingQualityCorrection({
      ...options,
      _runBrain: async (args) => {
        calls.brain++;
        return brainImpl(args, calls);
      }
    });
  };
  return { runner, calls };
}

// Read the exact enumerated-item metadata the runner put in the prompt so the fake brain always
// answers about the real missing item at its real marker index.
function issueMetaFromPrompt(prompt) {
  const match = prompt.match(/^- (\{"itemKey".*\})$/m);
  if (!match) throw new Error('correction prompt did not list an enumerated item');
  return JSON.parse(match[1]);
}

function validCorrectionLine(prompt, ledgerOverrides = {}) {
  const meta = issueMetaFromPrompt(prompt);
  const ledgerItem = coltLedger({ itemRef: meta.itemRef, threadRef: meta.threadRef, date: meta.date, ...ledgerOverrides });
  return `[LEDGER_CORRECTION] ${JSON.stringify({ markerIndex: meta.eligibleMarkerIndexes[0], ledgerItem })}`;
}

function capturingGateway(capture, { holdTypes = [] } = {}) {
  return async ({ markers }) => {
    capture.markers = markers;
    return {
      ok: true,
      text: JSON.stringify({
        decisions: markers.map((markerItem, markerIndex) => ({
          markerIndex,
          decision: holdTypes.includes(markerItem.type) ? 'needs-review' : 'approve',
          reason: 'Integration test decision.'
        }))
      }),
      counters: { workIqCalls: 0 }
    };
  };
}

test('QC-1 one missing enumerated disposition triggers exactly one correction, gateway sees corrected marker, final gate passes, ledger persisted', async () => {
  const dir = resetTmp('qc1');
  const tasksFile = writeFixture(dir, { version: 5, tasks: [] });
  const output = [
    seestrasseProjectMarker({ ledger: [] }),
    scanDone({ runId: 'run-qc1', outcome: 'success', newProjects: 1 }, { now: CORRECTION_NOW, scanDays: CORRECTION_SCAN_DAYS })
  ].join('\n');

  const spy = correctionSpy((args) => ({
    ok: true,
    assistantText: `${validCorrectionLine(args.prompt)}\n`,
    counters: { workIqCalls: 1 }
  }));
  const capture = {};

  const result = await runBrainScanOnce(makeJob({ scanDays: CORRECTION_SCAN_DAYS }), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-qc1',
    now: CORRECTION_NOW,
    _runBrain: fakeBrain(output),
    _runGateway: capturingGateway(capture),
    _runCorrection: spy.runner
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const project = saved.tasks.find(task => task.id === 'proj-seestrasse');

  assert.equal(spy.calls.runner, 1);
  assert.equal(spy.calls.brain, 1, 'brain correction is a single attempt');

  const gatewayProject = capture.markers.find(item => item.type === 'PROJECT_NEW');
  const gatewayLedger = gatewayProject.payload.processingLedger || gatewayProject.payload.processing?.ledger || [];
  assert.ok(gatewayLedger.some(item => item.itemRef?.id === 'colt-1'), 'gateway received the corrected marker');

  assert.equal(result.qualityGate.ok, true, 'final quality gate passes');
  assert.equal(result.qualityCorrection.attempted, true);
  assert.equal(result.qualityCorrection.eligibleIssues, 1);
  assert.equal(result.qualityCorrection.applied, 1);
  assert.equal(result.qualityCorrection.preGateOk, false);
  assert.equal(result.qualityCorrection.postCorrectionGateOk, true);

  assert.ok(project, 'project applied');
  assert.ok((project.processing?.ledger || []).some(item => item.itemRef?.id === 'colt-1'), 'processing ledger persisted');
  assert.equal(result.outcome, 'success');
});

test('QC-2 malformed correction still runs once, scan stays partial, and the completeness review reason remains', async () => {
  const dir = resetTmp('qc2');
  const tasksFile = writeFixture(dir, { version: 5, tasks: [] });
  const output = [
    seestrasseProjectMarker({ ledger: [] }),
    scanDone({ runId: 'run-qc2', outcome: 'success', newProjects: 1 }, { now: CORRECTION_NOW, scanDays: CORRECTION_SCAN_DAYS })
  ].join('\n');

  const spy = correctionSpy(() => ({
    ok: true,
    assistantText: '[LEDGER_CORRECTION] {"markerIndex":0,"ledgerItem":}\n',
    counters: { workIqCalls: 0 }
  }));

  const result = await runBrainScanOnce(makeJob({ scanDays: CORRECTION_SCAN_DAYS }), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-qc2',
    now: CORRECTION_NOW,
    _runBrain: fakeBrain(output),
    _runGateway: capturingGateway({}),
    _runCorrection: spy.runner
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(spy.calls.brain, 1, 'exactly one correction attempt');
  assert.equal(result.qualityCorrection.attempted, true);
  assert.equal(result.qualityCorrection.applied, 0);
  assert.equal(result.qualityCorrection.received, 1);
  assert.equal(result.qualityCorrection.parsed, 0);
  assert.equal(result.outcome, 'partial');
  assert.equal(result.qualityGate.ok, false);
  assert.match(result.qualityGate.reason || '', /missing ledger disposition for enumerated item email:colt-1/);
  assert.ok(
    (saved.reviewQueue || []).some(item => /missing ledger disposition for enumerated item email:colt-1/.test(item.question || '')),
    'completeness review reason remains'
  );
});

test('QC-3 gateway rejection of the corrected target cannot be bypassed; final result stays partial', async () => {
  const dir = resetTmp('qc3');
  const tasksFile = writeFixture(dir, { version: 5, tasks: [] });
  const output = [
    seestrasseProjectMarker({ ledger: [] }),
    scanDone({ runId: 'run-qc3', outcome: 'success', newProjects: 1 }, { now: CORRECTION_NOW, scanDays: CORRECTION_SCAN_DAYS })
  ].join('\n');

  const spy = correctionSpy((args) => ({
    ok: true,
    assistantText: `${validCorrectionLine(args.prompt)}\n`,
    counters: { workIqCalls: 0 }
  }));
  const capture = {};

  const result = await runBrainScanOnce(makeJob({ scanDays: CORRECTION_SCAN_DAYS }), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-qc3',
    now: CORRECTION_NOW,
    _runBrain: fakeBrain(output),
    _runGateway: capturingGateway(capture, { holdTypes: ['PROJECT_NEW'] }),
    _runCorrection: spy.runner
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(spy.calls.brain, 1);
  // The correction succeeded pre-gateway, but the Reality Gateway still held the corrected marker.
  assert.equal(result.qualityCorrection.applied, 1);
  assert.equal(result.qualityCorrection.postCorrectionGateOk, true);
  assert.ok(result.gateway.heldMarkers >= 1, 'gateway held the corrected marker');
  assert.equal(result.outcome, 'partial', 'gateway rejection cannot be bypassed');
  assert.equal(saved.tasks.find(task => task.id === 'proj-seestrasse'), undefined, 'held marker was not applied');
});

test('QC-4 clean initial output makes zero correction calls', async () => {
  const dir = resetTmp('qc4');
  const tasksFile = writeFixture(dir, { version: 5, tasks: [] });
  const output = [
    seestrasseProjectMarker({ ledger: [coltLedger()] }),
    scanDone({ runId: 'run-qc4', outcome: 'success', newProjects: 1 }, { now: CORRECTION_NOW, scanDays: CORRECTION_SCAN_DAYS })
  ].join('\n');

  const spy = correctionSpy(() => {
    throw new Error('correction runner must not be invoked for clean output');
  });

  const result = await runBrainScanOnce(makeJob({ scanDays: CORRECTION_SCAN_DAYS }), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-qc4',
    now: CORRECTION_NOW,
    _runBrain: fakeBrain(output),
    _runGateway: capturingGateway({}),
    _runCorrection: spy.runner
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(spy.calls.runner, 0, 'runner not called');
  assert.equal(spy.calls.brain, 0, 'brain not called');
  assert.equal(result.qualityCorrection.attempted, false);
  assert.equal(result.qualityCorrection.eligibleIssues, 0);
  assert.equal(result.qualityGate.ok, true);
  assert.equal(result.outcome, 'success');
  assert.ok(saved.tasks.find(task => task.id === 'proj-seestrasse'));
});

test('QC-5 correction telemetry accurately reports applied and rejected corrections', async () => {
  const dir = resetTmp('qc5');
  const tasksFile = writeFixture(dir, { version: 5, tasks: [] });
  const output = [
    seestrasseProjectMarker({ ledger: [] }),
    scanDone({ runId: 'run-qc5', outcome: 'success', newProjects: 1 }, { now: CORRECTION_NOW, scanDays: CORRECTION_SCAN_DAYS })
  ].join('\n');

  const spy = correctionSpy((args) => {
    const meta = issueMetaFromPrompt(args.prompt);
    const valid = validCorrectionLine(args.prompt);
    // A second correction for an item that was never enumerated must be rejected.
    const bogus = `[LEDGER_CORRECTION] ${JSON.stringify({
      markerIndex: meta.eligibleMarkerIndexes[0],
      ledgerItem: coltLedger({ itemRef: { type: 'email', id: 'never-enumerated' } })
    })}`;
    return { ok: true, assistantText: `${valid}\n${bogus}\n`, counters: { workIqCalls: 2 } };
  });

  const result = await runBrainScanOnce(makeJob({ scanDays: CORRECTION_SCAN_DAYS }), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-qc5',
    now: CORRECTION_NOW,
    _runBrain: fakeBrain(output),
    _runGateway: capturingGateway({}),
    _runCorrection: spy.runner
  });

  const qc = result.qualityCorrection;
  assert.equal(qc.attempted, true);
  assert.equal(qc.eligibleIssues, 1);
  assert.equal(qc.runOk, true);
  assert.equal(qc.received, 2);
  assert.equal(qc.parsed, 2);
  assert.equal(qc.applied, 1);
  assert.equal(qc.rejected, 1);
  assert.equal(qc.rejectedReasons.length, 1);
  assert.match(qc.rejectedReasons[0], /not one of the missing enumerated item keys/);
  assert.equal(qc.workIqCalls, 2);
  assert.equal(qc.preGateOk, false);
  assert.equal(qc.postCorrectionGateOk, true);
  assert.ok(qc.durationMs >= 0);
});

// QC-6 — the exact real B2 scan-wide REPLACE-ITEM-IDENTITY topology through the full runner:
//   * item enumerated ONLY in SCAN_DONE.processingQuality.enumeratedItems;
//   * a LINEITEM_UPDATE whose SourceRef.itemId matches the enumerated id exactly (same threadRef);
//   * that marker already carries ONE same-thread ledger disposition under an ALIAS itemRef;
//   * SCAN_DONE.ledgerCounts already expects count=1 for the thread (so appending would break it).
// The single correction must REPLACE the alias itemRef in place — the gateway must receive the
// replacement (never an appended second item), the final quality gate must be clean, and the
// persisted ledger must contain the global key once with the alias absent.
function b2ReplacementLine(prompt) {
  const meta = issueMetaFromPrompt(prompt);
  assert.equal(meta.mode, 'replace-item-identity', 'issue metadata carries replace-item-identity mode');
  assert.ok(meta.existingLedgerItem, 'issue metadata carries the exact existing ledger item to copy');
  const ledgerItem = { ...meta.existingLedgerItem, itemRef: meta.itemRef };
  return `[LEDGER_CORRECTION] ${JSON.stringify({ markerIndex: meta.markerIndex, ledgerItem })}`;
}

test('QC-6 scan-wide item-identity alias mismatch is corrected by replacing the ledger itemRef, not appending', async () => {
  const dir = resetTmp('qc6');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'proj-b2',
      taskType: 'project',
      projectKey: 'b2',
      title: 'B2 Project',
      status: 'in-progress',
      sourceRefs: [{ id: 'src-seed', date: '2026-07-01T08:00:00.000Z', link: 'https://example.test/seed' }],
      lineItems: [{ id: 'li-b2', title: 'Colt circuit protection', status: 'open', evidenceRefIds: ['src-seed'] }],
      updatedAt: '2026-07-01T08:00:00.000Z'
    }]
  });

  const aliasLedger = {
    itemRef: { type: 'email', id: 'colt-b2-reply-1333' },
    threadRef: 'thread-b2',
    date: '2026-07-05T08:00:00.000Z',
    disposition: 'updates-node',
    nodeRefs: ['li-b2'],
    attachmentsHandled: 'none',
    quote: 'Yes, please proceed from my side. Has Anastasiya given her approval as well?',
    reason: 'Fresh 5 Jul evidence resolves the previously pending resilience decision.'
  };
  const output = [
    marker('LINEITEM_UPDATE', {
      taskId: 'proj-b2',
      lineItemId: 'li-b2',
      sourceRefs: [{
        id: 'src-colt',
        itemId: 'colt-b2',
        conversationId: 'colt-b2-conv',
        threadRef: 'thread-b2',
        type: 'email',
        title: 'RE: Request: Colt circuit protection',
        from: 'Someone / Martin',
        date: '2026-07-05',
        link: 'https://example.test/colt-b2'
      }],
      patch: { status: 'waiting', currentState: 'Decision made; awaiting IES execution.', confidence: 'medium' },
      processingLedger: [aliasLedger],
      evidenceRefIds: ['src-colt']
    }),
    scanDone({
      runId: 'run-qc6',
      outcome: 'success',
      updatedProjects: 1,
      processingQuality: {
        enumeratedItems: [{ itemRef: { type: 'email', id: 'colt-b2' }, threadRef: 'thread-b2' }],
        ledgerCounts: [{ threadRef: 'thread-b2', count: 1 }]
      }
    }, { now: CORRECTION_NOW, scanDays: CORRECTION_SCAN_DAYS })
  ].join('\n');

  const spy = correctionSpy((args) => ({
    ok: true,
    assistantText: `${b2ReplacementLine(args.prompt)}\n`,
    counters: { workIqCalls: 1 }
  }));
  const capture = {};

  const result = await runBrainScanOnce(makeJob({ scanDays: CORRECTION_SCAN_DAYS }), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-qc6',
    now: CORRECTION_NOW,
    _runBrain: fakeBrain(output),
    _runGateway: capturingGateway(capture),
    _runCorrection: spy.runner
  });

  assert.equal(spy.calls.runner, 1, 'exactly one correction runner invocation');
  assert.equal(spy.calls.brain, 1, 'exactly one correction brain attempt');

  const gatewayLine = capture.markers.find(item => item.type === 'LINEITEM_UPDATE');
  const gatewayLedger = gatewayLine.payload.processingLedger || gatewayLine.payload.processing?.ledger || [];
  assert.equal(gatewayLedger.length, 1, 'gateway received a single ledger item (replacement, not an appended second)');
  assert.equal(gatewayLedger[0].itemRef.id, 'colt-b2', 'gateway received the replacement identity');
  assert.ok(!gatewayLedger.some(item => item.itemRef?.id === 'colt-b2-reply-1333'), 'alias itemRef absent at gateway');
  // Every non-itemRef field of the original alias disposition is preserved verbatim.
  assert.equal(gatewayLedger[0].quote, aliasLedger.quote);
  assert.equal(gatewayLedger[0].reason, aliasLedger.reason);
  assert.equal(gatewayLedger[0].disposition, aliasLedger.disposition);

  assert.equal(result.qualityGate.ok, true, 'final quality gate is clean');
  assert.equal(result.qualityGate.reviewItems, 0);
  assert.equal(result.qualityCorrection.attempted, true);
  assert.equal(result.qualityCorrection.eligibleIssues, 1);
  assert.equal(result.qualityCorrection.applied, 1);
  assert.deepEqual(result.qualityCorrection.appliedModes, ['replace-item-identity']);
  assert.equal(result.qualityCorrection.preGateOk, false);
  assert.equal(result.qualityCorrection.postCorrectionGateOk, true);

  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const project = saved.tasks.find(task => task.id === 'proj-b2');
  const persisted = project.processing?.ledger || [];
  assert.equal(persisted.filter(item => item.itemRef?.id === 'colt-b2').length, 1, 'persisted ledger contains the global key exactly once');
  assert.ok(!persisted.some(item => item.itemRef?.id === 'colt-b2-reply-1333'), 'persisted ledger no longer contains the alias key');
  assert.equal(result.outcome, 'success');
});
