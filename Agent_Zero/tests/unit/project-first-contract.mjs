import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { applyFactSheetSectionPatches, createEmptyFactSheet } from '../../brain/factsheet.js';
import { applyMarkerBatch } from '../../brain/marker-applier.js';
import { mergeProcessing } from '../../brain/processing-ledger.js';
import { renderScanState } from '../../brain/render-scan-state.js';

function marker(type, payload) {
  return { type, payload, line: 1, raw: `[${type}]` };
}

test('project briefs are bounded and preserve stable source identity', () => {
  const long = 'Current verified project state. '.repeat(80);
  const result = applyMarkerBatch({ version: 5, tasks: [] }, [marker('PROJECT_NEW', {
    taskId: 'proj-brief',
    projectKey: 'SITE-REFRESH',
    title: 'Site refresh',
    summary: long,
    pmStatus: {
      current: long,
      planned: [], userActions: [], problems: [], risks: [], waitingOn: []
    },
    sourceRefs: [{
      id: 'src-brief',
      itemId: 'item-42',
      conversationId: 'conversation-42',
      threadRef: 'thread-42',
      internetMessageId: '<message-42@example.test>',
      date: '2026-07-15T08:00:00.000Z'
    }],
    lineItems: [{
      id: 'li-brief',
      title: 'Resolve blocker',
      priority: 'HIGH',
      currentState: long,
      relevance: {
        score: 88,
        reason: 'This blocker materially affects the site refresh outcome.',
        evidenceRefIds: ['src-brief']
      },
      evidenceRefIds: ['src-brief']
    }]
  })], { auditLogFile: null, now: new Date('2026-07-15T09:00:00.000Z') });

  assert.equal(result.applied, 1);
  const project = result.data.tasks[0];
  assert.ok(project.summary.length <= 420);
  assert.ok(project.pmStatus.current.length <= 520);
  assert.ok(project.lineItems[0].currentState.length <= 700);
  assert.equal(project.lineItems[0].priority, 'high');
  assert.equal(project.sourceRefs[0].conversationId, 'conversation-42');
  assert.equal(project.sourceRefs[0].internetMessageId, '<message-42@example.test>');
});

test('only a successful SCAN_DONE advances the discovery anchor', () => {
  const original = { version: 5, lastScan: '2026-07-01T00:00:00.000Z', tasks: [] };
  const partial = applyMarkerBatch(original, [marker('SCAN_DONE', {
    runId: 'partial-run', outcome: 'partial'
  })], { auditLogFile: null, now: new Date('2026-07-15T09:00:00.000Z') });
  assert.equal(partial.data.lastScan, original.lastScan);

  const success = applyMarkerBatch(original, [marker('SCAN_DONE', {
    runId: 'success-run', outcome: 'success'
  })], { auditLogFile: null, now: new Date('2026-07-15T09:00:00.000Z') });
  assert.equal(success.data.lastScan, '2026-07-15T09:00:00.000Z');
});

test('Fact Sheet add is idempotent by normalized semantic text', () => {
  const sheet = createEmptyFactSheet({ now: new Date('2026-07-15T08:00:00.000Z') });
  const result = applyFactSheetSectionPatches(sheet, {
    status: [
      { op: 'add', text: 'Circuit is ready.', evidenceRefIds: ['src-1'] },
      { op: 'add', text: '  CIRCUIT is ready ', evidenceRefIds: ['src-2'] }
    ]
  }, { now: new Date('2026-07-15T09:00:00.000Z'), idFactory: prefix => `${prefix}-1` });

  assert.equal(result.sections.status.length, 1);
  assert.deepEqual(result.sections.status[0].evidenceRefIds, ['src-1', 'src-2']);
});

test('scan state preserves canonical aliases and excludes completed singles from open work', () => {
  const rendered = renderScanState({
    version: 5,
    tasks: [{
      id: 'proj-site', taskType: 'project', projectKey: 'SITE-REFRESH',
      projectAliases: ['Zurich-See', 'SEP 3235'], title: 'Zurich site refresh', status: 'in-progress',
      sourceRefs: [{ id: 'src-site', conversationId: 'conv-site' }], lineItems: []
    }, {
      id: 'single-done', taskType: 'single', title: 'Completed note', status: 'done', sourceRefs: []
    }]
  }, {
    writeFiles: false,
    runId: 'identity-test',
    now: '2026-07-15T09:00:00.000Z',
    learningsFile: path.join('Z:', 'does-not-exist', 'brain-learnings.md')
  });

  assert.match(rendered.markdown, /Canonical Identity Index/);
  assert.match(rendered.markdown, /zurich-see/);
  assert.match(rendered.markdown, /sep-3235/);
  const openSingles = rendered.markdown.split('## Open Single Tasks')[1].split('## Review Queue')[0];
  assert.doesNotMatch(openSingles, /single-done/);
});

test('attachment indexing failures schedule a later re-probe instead of becoming permanent', () => {
  const payload = {
    processingLedger: [{
      itemRef: { type: 'email', id: 'mail-1' },
      threadRef: 'thread-1',
      date: '2026-07-15T08:00:00.000Z',
      disposition: 'no-change',
      nodeRefs: [],
      attachmentsHandled: 'failed(content-not-indexed)',
      quote: 'Attachment is not indexed.',
      reason: 'Both targeted index probes returned no content.'
    }]
  };
  let state = null;
  state = mergeProcessing(state, payload, { now: new Date('2026-07-15T09:00:00.000Z') });
  state = mergeProcessing(state, payload, { now: new Date('2026-07-16T09:00:00.000Z') });
  state = mergeProcessing(state, payload, { now: new Date('2026-07-17T09:00:00.000Z') });

  const failure = state.ledger[0];
  assert.equal(failure.attachmentIndexAttempts, 3);
  assert.equal(failure.reprobeNextScan, false);
  assert.equal(failure.reprobeAfter, '2026-07-24T09:00:00.000Z');

  state = mergeProcessing(state, {
    processingLedger: [{
      ...payload.processingLedger[0],
      attachmentsHandled: 'yes(workiq-index)',
      disposition: 'updates-node',
      quote: 'The attachment content is now indexed.',
      reason: 'Fresh indexed content replaced the earlier operational failure.'
    }]
  }, { now: new Date('2026-07-24T10:00:00.000Z') });
  assert.equal(state.ledger[0].attachmentsHandled, 'yes(workiq-index)');
  assert.equal(state.ledger[0].attachmentIndexAttempts, undefined);
  assert.equal(state.ledger[0].reprobeAfter, undefined);
});

test('attachment retry attempts increment once per marker batch', () => {
  const failedLedger = {
    processingLedger: [{
      itemRef: { type: 'email', id: 'mail-batch-retry' },
      threadRef: 'thread-batch-retry',
      date: '2026-07-15T08:00:00.000Z',
      disposition: 'no-change',
      nodeRefs: [],
      attachmentsHandled: 'failed(content-not-indexed)',
      quote: 'Attachment is not indexed.',
      reason: 'The attachment index returned no content.'
    }]
  };
  const original = {
    version: 5,
    tasks: [{
      id: 'proj-batch-retry',
      taskType: 'project',
      title: 'Batch retry project',
      status: 'in-progress',
      sourceRefs: [],
      lineItems: [],
      processing: { cursorDate: null, lookbackDays: 14, threads: {}, ledger: [] }
    }]
  };
  const first = applyMarkerBatch(original, [
    marker('PROJECT_UPDATE', { taskId: 'proj-batch-retry', ...failedLedger }),
    marker('PROJECT_UPDATE', { taskId: 'proj-batch-retry', ...failedLedger }),
    marker('PROJECT_UPDATE', { taskId: 'proj-batch-retry', ...failedLedger })
  ], { auditLogFile: null, now: new Date('2026-07-15T09:00:00.000Z') });

  assert.equal(first.data.tasks[0].processing.ledger[0].attachmentIndexAttempts, 1);

  const second = applyMarkerBatch(first.data, [
    marker('PROJECT_UPDATE', { taskId: 'proj-batch-retry', ...failedLedger })
  ], { auditLogFile: null, now: new Date('2026-07-16T09:00:00.000Z') });
  assert.equal(second.data.tasks[0].processing.ledger[0].attachmentIndexAttempts, 2);
});
