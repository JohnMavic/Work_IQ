import assert from 'node:assert/strict';
import test from 'node:test';
import {
  filterMarkersByProjectIdentity,
  reconcileProjectFragments
} from '../../brain/project-identity.js';
import { applyMarkerBatch } from '../../brain/marker-applier.js';

const NOW = new Date('2026-07-15T09:00:00.000Z');

function project(overrides = {}) {
  return {
    id: 'proj-alpha',
    taskType: 'project',
    projectKey: 'alpha-rollout',
    projectAliases: ['Project Alpha'],
    title: 'Alpha Rollout',
    archived: false,
    supersededBy: null,
    sourceRefs: [],
    lineItems: [],
    processing: { threads: {}, ledger: [] },
    ...overrides
  };
}

function data(...projects) {
  return { version: 5, tasks: projects };
}

function marker(type, payload, line = 1) {
  return { type, payload, line, raw: `[${type}]` };
}

function ledger(id, threadRef = 'conv-alpha') {
  return [{
    itemRef: { type: 'email', id },
    threadRef,
    date: '2026-07-15T08:00:00.000Z',
    disposition: 'new-node',
    nodeRefs: [],
    attachmentsHandled: 'none',
    quote: 'Please prepare the handoff.',
    reason: 'The message contains a new action.'
  }];
}

test('existing projectKey collision becomes PROJECT_UPDATE plus deterministic line items', () => {
  const processingLedger = ledger('mail-alpha-1');
  const input = marker('PROJECT_NEW', {
    taskId: 'proposed-alpha',
    projectKey: 'ALPHA-ROLLOUT',
    title: 'Alpha Delivery Wave',
    aliases: ['Alpha Wave'],
    summary: 'Current rollout state',
    sourceRefs: [{ type: 'email', itemId: 'mail-alpha-1', title: 'Rollout update' }],
    lineItems: [{ title: 'Prepare handoff', status: 'new' }],
    processingLedger
  });

  const result = filterMarkersByProjectIdentity(data(project()), [input], { now: NOW });

  assert.deepEqual(result.markers.map(item => item.type), ['PROJECT_UPDATE', 'LINEITEM_NEW']);
  assert.equal(result.markers[0].payload.taskId, 'proj-alpha');
  assert.equal(result.markers[0].payload.sourceRefs.length, 1);
  assert.match(result.markers[0].payload.sourceRefs[0].id, /^src-[a-f0-9]{24}$/);
  assert.match(result.markers[0].payload.sourceRefs[0].contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.markers[0].payload.processingLedger, processingLedger);
  assert.deepEqual(result.markers[0].payload.projectAliases, [
    'Project Alpha',
    'Alpha Rollout',
    'ALPHA-ROLLOUT',
    'Alpha Delivery Wave',
    'Alpha Wave'
  ]);
  assert.equal(result.markers[1].payload.taskId, 'proj-alpha');
  assert.match(result.markers[1].payload.lineItem.id, /^li-[a-f0-9]{24}$/);
  assert.match(result.markers[1].payload.lineItem.contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(result.markers[1].payload.lineItem.evidenceRefIds, [result.markers[0].payload.sourceRefs[0].id]);
  assert.equal(result.held.length, 0);
  assert.equal(result.autoAttached.length, 1);
  assert.equal(result.autoAttached[0].projectId, 'proj-alpha');
  const applied = applyMarkerBatch(data(project()), result.markers, {
    auditLogFile: null,
    now: NOW,
    runId: 'alias-merge'
  });
  assert.deepEqual(applied.data.tasks[0].projectAliases, result.markers[0].payload.projectAliases);
  assert.deepEqual(input.payload.sourceRefs, [{ type: 'email', itemId: 'mail-alpha-1', title: 'Rollout update' }]);
});

test('TASK_NEW containing one exact alias attaches while retaining source and processing evidence', () => {
  const processingLedger = ledger('mail-phoenix-1', 'conv-phoenix');
  const input = marker('TASK_NEW', {
    taskId: 'single-phoenix-handoff',
    title: 'Prepare Project Phoenix handoff',
    summary: 'Send the final handoff package.',
    sourceRef: { type: 'email', itemId: 'mail-phoenix-1', conversationId: 'conv-phoenix' },
    processingLedger
  });
  const phoenix = project({
    id: 'proj-phoenix',
    projectKey: 'phoenix-migration',
    projectAliases: ['Project Phoenix'],
    title: 'Phoenix Migration'
  });

  const first = filterMarkersByProjectIdentity(data(phoenix), [input], { now: NOW });
  const second = filterMarkersByProjectIdentity(data(phoenix), [input], { now: NOW });

  assert.equal(first.markers.length, 1);
  assert.equal(first.markers[0].type, 'LINEITEM_NEW');
  assert.equal(first.markers[0].payload.taskId, 'proj-phoenix');
  assert.equal(first.markers[0].payload.lineItem.status, 'open');
  assert.equal(first.markers[0].payload.lineItem.currentState, 'Send the final handoff package.');
  assert.equal(first.markers[0].payload.sourceRef.itemId, 'mail-phoenix-1');
  assert.deepEqual(first.markers[0].payload.processingLedger, processingLedger);
  assert.deepEqual(first.markers, second.markers);
});

test('candidate text naming multiple projects is held even when one source fingerprint matches', () => {
  const alpha = project({
    sourceRefs: [{ id: 'src-alpha-mail', type: 'email', itemId: 'mail-shared-alpha' }]
  });
  const beta = project({
    id: 'proj-beta',
    projectKey: 'beta-cutover',
    projectAliases: ['Project Beta'],
    title: 'Beta Cutover'
  });
  const input = marker('TASK_NEW', {
    title: 'Coordinate Project Alpha with Project Beta',
    sourceRef: { id: 'src-alpha-mail', type: 'email', itemId: 'mail-shared-alpha' }
  });

  const result = filterMarkersByProjectIdentity(data(alpha, beta), [input], { now: NOW });

  assert.equal(result.markers.length, 0);
  assert.equal(result.held.length, 1);
  assert.deepEqual(result.held[0].candidateProjectIds, ['proj-alpha', 'proj-beta']);
  assert.match(result.held[0].reason, /multiple active projects/);
  assert.equal(result.reviewReasons.length, 1);
  assert.equal(result.autoAttached.length, 0);
});

test('no exact identity, text identifier, or immutable fingerprint leaves marker unchanged', () => {
  const input = marker('TASK_NEW', {
    title: 'Prepare unrelated supplier renewal',
    sourceRef: { id: 'src-unrelated', type: 'email', itemId: 'mail-unrelated' }
  });

  const result = filterMarkersByProjectIdentity(data(project()), [input], { now: NOW });

  assert.deepEqual(result.markers, [input]);
  assert.deepEqual(result.held, []);
  assert.deepEqual(result.reviewReasons, []);
  assert.deepEqual(result.autoAttached, []);
});

test('same-batch source replay holds every duplicate creation marker for review', () => {
  const first = marker('TASK_NEW', {
    title: 'First unrelated action',
    sourceRef: { type: 'email', itemId: 'mail-replayed-1', conversationId: 'conv-replayed' }
  }, 1);
  const second = marker('TASK_NEW', {
    title: 'Second unrelated action',
    sourceRef: { type: 'email', itemId: 'mail-replayed-1', conversationId: 'conv-replayed' }
  }, 2);
  const done = marker('SCAN_DONE', { outcome: 'partial' }, 3);

  const result = filterMarkersByProjectIdentity(data(project()), [first, second, done], { now: NOW });

  assert.deepEqual(result.markers, [done]);
  assert.deepEqual(result.held.map(item => item.index), [0, 1]);
  assert.equal(result.reviewReasons.length, 2);
  assert.ok(result.held.every(item => /same-batch duplicate/.test(item.reason)));
});

test('persisted deterministic source and line-item replay is idempotently filtered', () => {
  const input = marker('TASK_NEW', {
    taskId: 'single-alpha-handoff',
    title: 'Project Alpha handoff',
    summary: 'Send the final handoff package.',
    sourceRef: { type: 'email', itemId: 'mail-alpha-replay', conversationId: 'conv-alpha-replay' }
  });
  const alpha = project({ projectAliases: ['Project Alpha'] });
  const first = filterMarkersByProjectIdentity(data(alpha), [input], { now: NOW });
  const attached = first.markers[0];
  const persisted = project({
    projectAliases: ['Project Alpha'],
    sourceRefs: [attached.payload.sourceRef],
    lineItems: [attached.payload.lineItem],
    processing: {
      threads: { 'conv-alpha-replay': { lastProcessedMessageDate: '2026-07-15T08:00:00.000Z' } },
      ledger: []
    }
  });

  const replay = filterMarkersByProjectIdentity(data(persisted), [input], { now: NOW });

  assert.equal(replay.markers.length, 0);
  assert.equal(replay.held.length, 1);
  assert.match(replay.held[0].reason, /persisted line-item replay/);
  assert.equal(replay.reviewReasons.length, 0);
  assert.equal(replay.autoAttached.length, 0);
});

test('post-apply reconciliation archives one exact single fragment and preserves its evidence and history', () => {
  const original = data(
    project({
      id: 'proj-phoenix',
      projectKey: 'phoenix-migration',
      projectAliases: ['Project Phoenix'],
      title: 'Phoenix Migration',
      sourceRefs: [{ id: 'src-existing', type: 'email', itemId: 'mail-existing', date: '2026-07-10T08:00:00.000Z', link: 'https://example.test/existing' }],
      history: [{ type: 'created', text: 'Project created' }]
    }),
    {
      id: 'single-phoenix',
      taskType: 'single',
      title: 'Prepare Project Phoenix handoff',
      summary: 'Send the final handoff package.',
      status: 'new',
      archived: false,
      supersededBy: null,
      sourceRefs: [{ type: 'email', itemId: 'mail-phoenix-fragment', conversationId: 'conv-phoenix', date: '2026-07-14T08:00:00.000Z', link: 'https://example.test/fragment' }],
      history: [{ type: 'brain-task-new', text: 'Created from scan' }]
    }
  );

  const result = reconcileProjectFragments(original, { now: NOW });
  const target = result.data.tasks.find(task => task.id === 'proj-phoenix');
  const donor = result.data.tasks.find(task => task.id === 'single-phoenix');

  assert.equal(result.attached.length, 1);
  assert.equal(result.held.length, 0);
  assert.equal(target.sourceRefs.length, 2);
  assert.equal(target.lineItems.length, 1);
  assert.deepEqual(target.lineItems[0].sourceTaskIds, ['single-phoenix']);
  assert.equal(target.lineItems[0].state, 'unconfirmed');
  assert.equal(target.lineItems[0].needsReview, true);
  assert.match(target.lineItems[0].id, /^li-[a-f0-9]{24}$/);
  assert.match(target.lineItems[0].contentHash, /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(target.supersedesTaskIds, ['single-phoenix']);
  assert.deepEqual(target.additionalLinks, ['https://example.test/existing', 'https://example.test/fragment']);
  assert.equal(target.brainState.lastEvidenceAt, '2026-07-14T08:00:00.000Z');
  assert.equal(donor.archived, true);
  assert.equal(donor.supersededBy, 'proj-phoenix');
  assert.equal(donor.sourceRefs[0].id, undefined);
  assert.deepEqual(donor.history[0], { type: 'brain-task-new', text: 'Created from scan' });
  assert.equal(donor.history.at(-1).type, 'project-fragment-archived');
  assert.deepEqual(original.tasks[1].history, [{ type: 'brain-task-new', text: 'Created from scan' }]);
});

test('post-apply reconciliation uses immutable source fingerprints and deduplicates merged refs', () => {
  const alpha = project({
    sourceRefs: [{ id: 'src-project-mail', type: 'email', itemId: 'mail-shared-source', title: 'Existing evidence' }]
  });
  const fragment = {
    id: 'single-source-match',
    taskType: 'single',
    title: 'Prepare final package',
    summary: 'No project name is present.',
    status: 'new',
    archived: false,
    sourceRefs: [{ id: 'src-donor-mail', type: 'email', itemId: 'mail-shared-source', evidenceText: 'New evidence detail' }],
    history: []
  };

  const result = reconcileProjectFragments(data(alpha, fragment), { now: NOW });
  const target = result.data.tasks.find(task => task.id === 'proj-alpha');

  assert.equal(result.attached.length, 1);
  assert.equal(target.sourceRefs.length, 1);
  assert.equal(target.sourceRefs[0].id, 'src-project-mail');
  assert.equal(target.sourceRefs[0].evidenceText, 'New evidence detail');
  assert.deepEqual(target.lineItems[0].evidenceRefIds, ['src-project-mail']);
});

test('post-apply reconciliation holds competing project identities without archiving donor', () => {
  const fragment = {
    id: 'single-ambiguous',
    taskType: 'single',
    title: 'Coordinate Project Alpha and Project Beta',
    status: 'new',
    archived: false,
    sourceRefs: [],
    history: []
  };
  const beta = project({
    id: 'proj-beta',
    projectKey: 'beta-cutover',
    projectAliases: ['Project Beta'],
    title: 'Beta Cutover'
  });

  const result = reconcileProjectFragments(data(project(), beta, fragment), { now: NOW });
  const donor = result.data.tasks.find(task => task.id === 'single-ambiguous');

  assert.equal(result.attached.length, 0);
  assert.equal(result.held.length, 1);
  assert.equal(result.reviewReasons.length, 1);
  assert.deepEqual(result.held[0].candidateProjectIds, ['proj-alpha', 'proj-beta']);
  assert.equal(donor.archived, false);
});

test('post-apply reconciliation is idempotent after donor archival', () => {
  const initial = data(
    project(),
    {
      id: 'single-alpha-fragment',
      taskType: 'single',
      title: 'Project Alpha handoff',
      summary: 'Send the final handoff package.',
      status: 'new',
      archived: false,
      sourceRefs: [{ type: 'email', itemId: 'mail-alpha-fragment' }],
      history: []
    }
  );

  const first = reconcileProjectFragments(initial, { now: NOW });
  const second = reconcileProjectFragments(first.data, { now: NOW });
  const target = second.data.tasks.find(task => task.id === 'proj-alpha');

  assert.equal(first.attached.length, 1);
  assert.equal(second.attached.length, 0);
  assert.equal(target.lineItems.length, 1);
  assert.equal(target.history.filter(item => item.type === 'project-fragment-attached').length, 1);
});
