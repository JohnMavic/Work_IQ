import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMarkerBatch } from '../../brain/marker-applier.js';
import { parseMarkers } from '../../brain/marker-parser.js';
import { filterMarkersThroughGateway } from '../../brain/reality-gateway.js';
import { runBrainScanOnce } from '../../brain/scan-brain.js';
import { migrateToV5, writeJsonFileAtomic } from '../../brain/tasks-v5.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-batch7');

function resetTmp(name) {
  const dir = path.join(tmpRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function marker(type, payload) {
  return `[${type}] ${JSON.stringify(payload)}`;
}

function markerObj(type, payload) {
  return { type, payload, raw: marker(type, payload) };
}

function actionProof(overrides = {}) {
  return {
    threadRef: 'conv-batch7-open',
    askQuote: {
      text: 'Martin, please confirm the plan.',
      from: 'Direct Requester',
      date: '2026-07-06T08:00:00.000Z',
      threadRef: 'conv-batch7-open'
    },
    resolutionStatus: 'open',
    lastVerifiedMessageDate: '2026-07-06T09:00:00.000Z',
    threadCheck: {
      coverage: 'complete',
      addressedTo: 'user',
      messageCount: 4,
      lastMessageDate: '2026-07-06T09:00:00.000Z',
      checkedThroughMessageDate: '2026-07-06T09:00:00.000Z'
    },
    ...overrides
  };
}

function baseProject(extra = {}) {
  return migrateToV5({
    version: 5,
    reviewQueue: [],
    tasks: [{
      id: 'proj-b7',
      taskType: 'project',
      title: 'Batch 7 project',
      status: 'new',
      summary: 'Original summary',
      sourceRefs: [
        { id: 'src-b7', type: 'email', title: 'Batch 7 source', date: '2026-07-06T08:00:00.000Z', link: 'https://example.test/b7' },
        { id: 'src-b7b', type: 'email', title: 'Batch 7 source B', date: '2026-07-06T09:00:00.000Z', link: 'https://example.test/b7b' }
      ],
      pmStatus: {
        current: 'Current state',
        planned: [],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      lineItems: [{
        id: 'li-b7',
        title: 'Existing line',
        category: 'workstream',
        status: 'open',
        currentState: 'Original state',
        evidenceRefIds: ['src-b7']
      }],
      ...extra
    }]
  });
}

function approveAll(markers) {
  return {
    ok: true,
    text: markers.map((_, markerIndex) => `GATEWAY_DECISION\t${markerIndex}\tapprove\tApproved in fixture.`).join('\n'),
    counters: { workIqCalls: 0 }
  };
}

test('Batch 7 stale @mention with past referenced date is dropped without current proof', () => {
  const { markers } = parseMarkers(marker('PROJECT_UPDATE', {
    taskId: 'proj-b7',
    pmStatus: {
      current: 'Current state',
      planned: [],
      userActions: [{
        id: 'ua-stale-site-walk',
        text: 'Attend the site walk from the old request.',
        evidence: 'src-b7',
        evidenceRefIds: ['src-b7'],
        confidence: 'medium',
        referencedDate: '2026-06-11',
        ...actionProof({
          askQuote: {
            text: '@Martin are you joining the site walk on Thursday?',
            from: 'Laith Skeik',
            date: '2026-06-08T10:00:00.000Z',
            threadRef: 'conv-stale-site-walk'
          },
          threadRef: 'conv-stale-site-walk'
        })
      }],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    },
    evidenceRefIds: ['src-b7']
  }));

  const result = applyMarkerBatch(baseProject(), markers, {
    auditLogFile: null,
    now: new Date('2026-07-06T12:00:00.000Z')
  });

  assert.equal(result.applied, 0);
  assert.match(result.dropped[0].reason, /referencedDate is in the past/);
});

test('Batch 7 CC-only request with third-party resolution is held even if gateway approves', () => {
  const markers = [markerObj('PROJECT_UPDATE', {
    taskId: 'proj-b7',
    pmStatus: {
      current: 'Current state',
      planned: [],
      userActions: [{
        id: 'ua-cc-only',
        text: 'Review the color-coded asset list.',
        evidence: 'src-b7',
        evidenceRefIds: ['src-b7'],
        confidence: 'medium',
        ...actionProof({
          threadRef: 'conv-asset-list',
          askQuote: {
            text: 'Patrick, please confirm whether the asset list is correct.',
            from: 'Requester',
            date: '2026-06-08T08:00:00.000Z',
            threadRef: 'conv-asset-list'
          },
          threadCheck: {
            coverage: 'complete',
            addressedTo: 'cc-only',
            messageCount: 5,
            lastMessageDate: '2026-06-09T15:00:00.000Z',
            checkedThroughMessageDate: '2026-06-09T15:00:00.000Z'
          },
          resolvedBy: {
            text: 'I believe it to be correct. Trust that is all OK?',
            from: 'Patrick Harris',
            date: '2026-06-09T15:00:00.000Z'
          }
        })
      }],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    },
    evidenceRefIds: ['src-b7']
  })];

  const filtered = filterMarkersThroughGateway(markers, approveAll(markers));
  const result = applyMarkerBatch(baseProject(), filtered.markers, { auditLogFile: null });

  assert.equal(filtered.held.length, 1);
  assert.match(filtered.held[0].reason, /action gate failed/i);
  assert.equal(result.data.tasks[0].pmStatus.userActions.length, 0);
  assert.equal(result.data.reviewQueue.length, 1);
});

test('Batch 7 direct unresolved action with askQuote applies', () => {
  const { markers } = parseMarkers(marker('PROJECT_UPDATE', {
    taskId: 'proj-b7',
    pmStatus: {
      current: 'Current state',
      planned: [],
      userActions: [{
        id: 'ua-open-direct',
        text: 'Confirm the plan.',
        evidence: 'src-b7',
        evidenceRefIds: ['src-b7'],
        confidence: 'medium',
        ...actionProof()
      }],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    },
    evidenceRefIds: ['src-b7']
  }));

  const result = applyMarkerBatch(baseProject(), markers, {
    auditLogFile: null,
    now: new Date('2026-07-06T12:00:00.000Z')
  });
  const action = result.data.tasks[0].pmStatus.userActions[0];

  assert.equal(result.applied, 1);
  assert.equal(action.askQuote.text, 'Martin, please confirm the plan.');
  assert.equal(action.threadRef, 'conv-batch7-open');
  assert.equal(action.resolutionStatus, 'open');
});

test('Batch 7 gateway rejects visible action missing proof trail', () => {
  const markers = [markerObj('PROJECT_UPDATE', {
    taskId: 'proj-b7',
    pmStatus: {
      current: 'Current state',
      planned: [],
      userActions: [{ id: 'ua-missing-proof', text: 'Do the thing.', evidence: 'src-b7', evidenceRefIds: ['src-b7'] }],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    },
    evidenceRefIds: ['src-b7']
  })];

  const filtered = filterMarkersThroughGateway(markers, approveAll(markers));

  assert.equal(filtered.approved.length, 0);
  assert.equal(filtered.held.length, 1);
  assert.match(filtered.held[0].reason, /askQuote/);
});

test('Batch 7 omitted user action is preserved unless resolvedBy proof is supplied', () => {
  const data = baseProject({
    pmStatus: {
      current: 'Current state',
      planned: [],
      userActions: [{
        id: 'ua-existing',
        text: 'Confirm the plan.',
        evidence: 'src-b7',
        evidenceRefIds: ['src-b7'],
        confidence: 'medium',
        ...actionProof()
      }],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    }
  });
  const noProof = applyMarkerBatch(data, parseMarkers(marker('PROJECT_UPDATE', {
    taskId: 'proj-b7',
    pmStatus: {
      current: 'Current state',
      planned: [],
      userActions: [],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    },
    evidenceRefIds: ['src-b7']
  })).markers, { auditLogFile: null });

  assert.equal(noProof.data.tasks[0].pmStatus.userActions.length, 1);
  assert.equal(noProof.data.tasks[0].pmStatus.userActions[0].needsReview, true);

  const withProof = applyMarkerBatch(data, parseMarkers(marker('PROJECT_UPDATE', {
    taskId: 'proj-b7',
    pmStatus: {
      current: 'Current state',
      planned: [],
      userActions: [],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    },
    resolvedActions: [{
      id: 'ua-existing',
      resolutionStatus: 'resolved',
      resolvedBy: {
        text: 'This is now handled.',
        from: 'Direct Requester',
        date: '2026-07-06T10:00:00.000Z'
      }
    }],
    evidenceRefIds: ['src-b7']
  })).markers, { auditLogFile: null });

  assert.equal(withProof.data.tasks[0].pmStatus.userActions.length, 0);
  assert.equal(withProof.data.tasks[0].history.at(-1).type, 'user-action-resolved');
});

test('Batch 7 processing-ledger quality gate blocks partial scans before mutation', async () => {
  const dir = resetTmp('quality-gate');
  const tasksFile = path.join(dir, 'tasks.json');
  writeJsonFileAtomic(tasksFile, baseProject(), { maxBackups: 0 });
  const output = [
    marker('PROJECT_UPDATE', {
      taskId: 'proj-b7',
      summary: 'This summary must not be applied.',
      processingLedger: [{
        itemRef: { type: 'email', id: 'msg-1' },
        threadRef: 'conv-quality',
        date: '2026-07-06T08:00:00.000Z',
        disposition: 'updates-node',
        nodeRefs: ['proj-b7'],
        quote: 'Message one updates the project.',
        reason: 'It changes the project summary.'
      }]
    }),
    marker('SCAN_DONE', {
      runId: 'scan-quality',
      outcome: 'success',
      workIqCalls: 2,
      processingQuality: {
        required: true,
        enumeratedItems: [
          { itemRef: { type: 'email', id: 'msg-1' }, threadRef: 'conv-quality' },
          { itemRef: { type: 'email', id: 'msg-2' }, threadRef: 'conv-quality' }
        ],
        threadCounts: [{ threadRef: 'conv-quality', count: 2 }]
      }
    })
  ].join('\n');

  const result = await runBrainScanOnce({ input: {}, emit() {} }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'scan-quality',
    now: new Date('2026-07-06T12:00:00.000Z'),
    _runBrain: async () => ({ ok: true, assistantText: output, counters: { workIqCalls: 2 } }),
    _runGateway: async ({ markers }) => approveAll(markers),
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(result.outcome, 'partial');
  assert.equal(result.qualityGate.ok, false);
  assert.equal(saved.tasks[0].summary, 'Original summary');
  assert.match(saved.reviewQueue[0].question, /missing ledger disposition/);
});

test('Batch 7 ledger persists by stable conversation id across subject rename', () => {
  const text = [
    marker('PROJECT_UPDATE', {
      taskId: 'proj-b7',
      processingLedger: [{
        itemRef: { type: 'email', id: 'msg-old-subject' },
        threadRef: 'conv-stable-1',
        date: '2026-07-05T08:00:00.000Z',
        disposition: 'no-change',
        nodeRefs: ['proj-b7'],
        quote: 'Original subject update.',
        reason: 'No project change.'
      }]
    }),
    marker('PROJECT_UPDATE', {
      taskId: 'proj-b7',
      processingLedger: [{
        itemRef: { type: 'email', id: 'msg-renamed-subject' },
        threadRef: 'conv-stable-1',
        date: '2026-07-06T08:00:00.000Z',
        disposition: 'updates-node',
        nodeRefs: ['li-b7'],
        quote: 'Renamed subject update.',
        reason: 'Same conversation id, new item.'
      }]
    })
  ].join('\n');

  const result = applyMarkerBatch(baseProject(), parseMarkers(text).markers, {
    auditLogFile: null,
    now: new Date('2026-07-06T12:00:00.000Z')
  });
  const processing = result.data.tasks[0].processing;

  assert.deepEqual(Object.keys(processing.threads), ['conv-stable-1']);
  assert.equal(processing.threads['conv-stable-1'].lastProcessedMessageDate, '2026-07-06T08:00:00.000Z');
  assert.equal(processing.ledger.length, 2);
});

test('Batch 7 conflict fixture creates disputed node and project problem', () => {
  const { markers } = parseMarkers(marker('LINEITEM_UPDATE', {
    taskId: 'proj-b7',
    lineItemId: 'li-b7',
    patch: {
      state: 'disputed',
      currentState: 'Conflicting dates remain unresolved.',
      confidence: 'medium',
      conflict: {
        positions: [
          { text: 'Install starts on 17 August.', from: 'Planner A', date: '2026-07-05T08:00:00.000Z' },
          { text: 'Install starts on 24 August.', from: 'Planner B', date: '2026-07-06T08:00:00.000Z' }
        ]
      }
    },
    evidenceRefIds: ['src-b7', 'src-b7b']
  }));

  const result = applyMarkerBatch(baseProject(), markers, {
    auditLogFile: null,
    now: new Date('2026-07-06T12:00:00.000Z')
  });
  const task = result.data.tasks[0];

  assert.equal(task.lineItems[0].state, 'disputed');
  assert.equal(task.pmStatus.problems.some(entry => /Conflicting information/.test(entry.text)), true);
});
