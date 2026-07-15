import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarkers } from '../../brain/marker-parser.js';
import { applyMarkerBatch } from '../../brain/marker-applier.js';
import { migrateToV5 } from '../../brain/tasks-v5.js';
import { deterministicMarkerIssue } from '../../brain/reality-gateway.js';
import { requiresSemanticRelevance } from '../../brain/relevance.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-markers');

function resetTmp(name) {
  const dir = path.join(tmpRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function marker(type, payload) {
  return `[${type}] ${JSON.stringify(payload)}`;
}

function relevance(evidenceRefId, score = 60) {
  return { score, reason: 'Material to the project outcome.', evidenceRefIds: [evidenceRefId] };
}

function baseData() {
  return migrateToV5({
    version: 4,
    lastScan: null,
    tasks: [
      {
        id: 'old-1',
        title: 'Old source task',
        summary: 'Keep me',
        status: 'new',
        history: [],
        createdAt: '2026-07-01T08:00:00.000Z',
        updatedAt: '2026-07-01T08:00:00.000Z'
      }
    ]
  });
}

test('valid marker batch creates a project task with sourceRefs and lineItems', () => {
  const dir = resetTmp('valid-project');
  const text = [
    marker('PROJECT_NEW', {
      taskId: 'proj-1',
      projectKey: 'zurich-buildout',
      title: 'Zurich buildout',
      aliases: ['buildout'],
      summary: 'Project summary',
      pmStatus: {
        current: 'In progress',
        planned: [{ text: 'Finish cabling', evidence: 'src-1', confidence: 'high' }],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'high',
        lastSynthesizedAt: '2026-07-05T10:00:00.000Z'
      },
      sourceRefs: [{
        id: 'src-1',
        type: 'email',
        title: 'Buildout update',
        from: 'alex@example.test',
        date: '2026-07-05T09:00:00.000Z',
        link: 'https://example.test/msg/1',
        evidenceText: 'Short factual summary'
      }],
      lineItems: [{
        id: 'li-1',
        title: 'Cabling',
        status: 'in-progress',
        currentState: 'Cabling is underway',
        confidence: 'high',
        relevance: relevance('src-1', 70),
        evidenceRefIds: ['src-1'],
        sourceTaskIds: ['old-1']
      }],
      supersedesTaskIds: ['old-1']
    }),
    marker('SCAN_DONE', {
      runId: 'run-1',
      outcome: 'success',
      workIqCalls: 3
    })
  ].join('\n');

  const { markers } = parseMarkers(text);
  const result = applyMarkerBatch(baseData(), markers, {
    auditLogFile: path.join(dir, 'audit.jsonl'),
    now: new Date('2026-07-05T10:00:00.000Z'),
    runId: 'run-1'
  });

  assert.equal(result.applied, 2);
  assert.equal(result.dropped.length, 0);
  assert.equal(result.data.tasks.length, 2);
  const project = result.data.tasks.find(task => task.id === 'proj-1');
  const oldTask = result.data.tasks.find(task => task.id === 'old-1');
  assert.equal(project.taskType, 'project');
  assert.equal(project.sourceRefs[0].id, 'src-1');
  assert.equal(project.lineItems[0].id, 'li-1');
  assert.equal(project.pmStatus.planned[0].text, 'Finish cabling');
  assert.equal(oldTask.archived, true);
  assert.equal(oldTask.supersededBy, 'proj-1');
  assert.equal(result.data.brain.lastRunId, 'run-1');
  assert.equal(result.data.brain.lastOutcome, 'success');
});

test('same-batch PROJECT_NEW followed by LINEITEM_NEW validates against created project', () => {
  const dir = resetTmp('same-batch-project-line');
  const text = [
    marker('PROJECT_NEW', {
      taskId: 'proj-same-batch',
      projectKey: 'same-batch',
      title: 'Same batch project',
      sourceRefs: [{ id: 'src-same-batch', type: 'email', date: '2026-07-05T09:00:00.000Z' }],
      lineItems: []
    }),
    marker('LINEITEM_NEW', {
      taskId: 'proj-same-batch',
      lineItem: {
        id: 'li-same-batch',
        title: 'Created after project marker',
        status: 'new',
        relevance: relevance('src-same-batch'),
        evidenceRefIds: ['src-same-batch']
      }
    })
  ].join('\n');

  const result = applyMarkerBatch(baseData(), parseMarkers(text).markers, {
    auditLogFile: path.join(dir, 'audit.jsonl'),
    now: new Date('2026-07-05T10:00:00.000Z'),
    runId: 'same-batch'
  });

  assert.equal(result.dropped.length, 0);
  assert.equal(result.applied, 2);
  assert.equal(result.data.tasks.find(task => task.id === 'proj-same-batch').lineItems[0].id, 'li-same-batch');
});

test('evidence-dependent markers retry after a later valid marker introduces the SourceRef', () => {
  const dir = resetTmp('deferred-source-ref');
  const data = migrateToV5({
    version: 5,
    tasks: [{
      id: 'proj-deferred-source',
      title: 'Deferred source project',
      taskType: 'project',
      sourceRefs: [],
      lineItems: [{
        id: 'li-deferred-source',
        title: 'Existing workstream',
        category: 'info',
        status: 'on-radar',
        state: 'unconfirmed',
        evidenceRefIds: []
      }]
    }]
  });
  const text = [
    marker('FACTSHEET_UPDATE', {
      taskId: 'proj-deferred-source',
      sectionPatches: {
        overview: [{
          op: 'add',
          text: 'Fresh evidence updates the project overview.',
          evidenceRefIds: ['src-introduced-later'],
          confidence: 'medium',
          state: 'confirmed',
          sources: ['src-introduced-later'],
          lastConfirmedByMessageDate: '2026-07-15'
        }]
      }
    }),
    marker('LINEITEM_UPDATE', {
      taskId: 'proj-deferred-source',
      lineItemId: 'li-deferred-source',
      sourceRefs: [{
        id: 'src-introduced-later',
        type: 'email',
        title: 'Fresh source',
        date: '2026-07-15T10:00:00.000Z',
        link: 'https://example.test/fresh-source'
      }],
      patch: {
        status: 'in-progress',
        state: 'confirmed',
        currentState: 'Fresh evidence confirms active work.',
        relevance: relevance('src-introduced-later')
      },
      evidenceRefIds: ['src-introduced-later']
    })
  ].join('\n');

  const result = applyMarkerBatch(data, parseMarkers(text).markers, {
    auditLogFile: path.join(dir, 'audit.jsonl')
  });
  const project = result.data.tasks[0];

  assert.equal(result.applied, 2);
  assert.equal(result.dropped.length, 0);
  assert.equal(project.sourceRefs[0].id, 'src-introduced-later');
  assert.equal(project.factSheet.sections.overview[0].text, 'Fresh evidence updates the project overview.');
});

test('confirmed active line items require evidence-backed semantic relevance', () => {
  const { markers } = parseMarkers(marker('LINEITEM_NEW', {
    taskId: 'proj-existing',
    lineItem: {
      id: 'li-unranked',
      title: 'Unranked active item',
      status: 'open',
      evidenceRefIds: ['src-existing']
    }
  }));
  const data = migrateToV5({
    version: 5,
    tasks: [{
      id: 'proj-existing',
      title: 'Existing project',
      taskType: 'project',
      sourceRefs: [{ id: 'src-existing', type: 'email', date: '2026-07-05T08:00:00.000Z' }],
      lineItems: []
    }]
  });

  const result = applyMarkerBatch(data, markers, { auditLogFile: null });

  assert.equal(result.applied, 0);
  assert.match(result.dropped[0].reason, /relevance is required/);
});

test('LINEITEM_UPDATE persists a same-marker sourceRef used by relevance', () => {
  const data = migrateToV5({
    version: 5,
    tasks: [{
      id: 'proj-relevance-update',
      title: 'Relevance update project',
      taskType: 'project',
      sourceRefs: [{ id: 'src-old', type: 'email', date: '2026-07-04T08:00:00.000Z' }],
      lineItems: [{ id: 'li-ranked', title: 'Ranked item', status: 'open', evidenceRefIds: ['src-old'] }]
    }]
  });
  const { markers } = parseMarkers(marker('LINEITEM_UPDATE', {
    taskId: 'proj-relevance-update',
    lineItemId: 'li-ranked',
    sourceRefs: [{ id: 'src-new', type: 'email', date: '2026-07-05T08:00:00.000Z', title: 'New evidence' }],
    patch: {
      currentState: 'New evidence makes this the project focus.',
      relevance: relevance('src-new', 91)
    },
    evidenceRefIds: ['src-new']
  }));

  const result = applyMarkerBatch(data, markers, { auditLogFile: null });
  const task = result.data.tasks[0];

  assert.equal(result.applied, 1);
  assert.equal(task.sourceRefs.some(ref => ref.id === 'src-new'), true);
  assert.equal(task.lineItems[0].relevance.score, 91);
  assert.deepEqual(task.lineItems[0].relevance.evidenceRefIds, ['src-new']);
});

test('unknown task reference is dropped and audited', () => {
  const dir = resetTmp('unknown-reference');
  const { markers } = parseMarkers(marker('LINEITEM_NEW', {
    taskId: 'missing-task',
    lineItem: {
      id: 'li-x',
      title: 'Unknown',
      status: 'open',
      currentState: 'No task',
      evidenceRefIds: ['src-1']
    }
  }));

  const result = applyMarkerBatch(baseData(), markers, {
    auditLogFile: path.join(dir, 'audit.jsonl')
  });
  const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');

  assert.equal(result.applied, 0);
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /unknown taskId/);
  assert.match(audit, /unknown taskId/);
});

test('parser ignores markers inside fenced code blocks', () => {
  const text = [
    '```json',
    marker('PROJECT_NEW', { title: 'Ignored', sourceRefs: [] }),
    '```',
    marker('SCAN_DONE', { runId: 'run-2', outcome: 'partial' })
  ].join('\n');

  const { markers, errors } = parseMarkers(text);
  assert.equal(errors.length, 0);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'SCAN_DONE');
});

test('parser ignores markers inside tilde fenced code blocks', () => {
  const text = [
    '~~~',
    marker('TASK_NEW', {
      title: 'Injected example',
      sourceRef: { id: 'src-fenced', date: '2026-07-05' }
    }),
    '~~~',
    marker('SCAN_DONE', { runId: 'run-tilde', outcome: 'partial' })
  ].join('\n');

  const { markers, errors } = parseMarkers(text);
  assert.equal(errors.length, 0);
  assert.equal(markers.length, 1);
  assert.equal(markers[0].type, 'SCAN_DONE');
});

test('status-changing TASK_UPDATE without evidence is dropped', () => {
  const dir = resetTmp('missing-evidence');
  const data = baseData();
  const { markers } = parseMarkers(marker('TASK_UPDATE', {
    taskId: 'old-1',
    patch: { status: 'done' }
  }));

  const result = applyMarkerBatch(data, markers, {
    auditLogFile: path.join(dir, 'audit.jsonl')
  });

  assert.equal(result.applied, 0);
  assert.equal(result.data.tasks.find(task => task.id === 'old-1').status, 'new');
  assert.match(fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8'), /missing evidenceRefIds/);
});

test('TASK_UPDATE patch whitelist blocks destructive task fields', () => {
  const dir = resetTmp('task-update-whitelist');
  const data = migrateToV5({
    version: 5,
    tasks: [{
      id: 'old-1',
      title: 'Keep task',
      status: 'new',
      history: [{ timestamp: '2026-07-01T00:00:00.000Z', type: 'note', text: 'keep' }],
      sourceRefs: [{ id: 'src-keep', date: '2026-07-01T00:00:00.000Z', link: 'https://example.test/keep' }],
      lineItems: [{ id: 'li-keep', title: 'Keep line', evidenceRefIds: ['src-keep'], sourceTaskIds: ['old-1'] }],
      archived: false,
      supersededBy: null,
      taskType: 'single'
    }]
  });
  const { markers } = parseMarkers(marker('TASK_UPDATE', {
    taskId: 'old-1',
    patch: {
      history: [],
      sourceRefs: [],
      lineItems: [],
      archived: true,
      supersededBy: 'ghost',
      id: 'renamed',
      taskType: 'project'
    }
  }));

  const result = applyMarkerBatch(data, markers, {
    auditLogFile: path.join(dir, 'audit.jsonl')
  });
  const task = result.data.tasks.find(item => item.id === 'old-1');

  assert.equal(result.applied, 0);
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /disallowed field/);
  assert.ok(task);
  assert.equal(task.history.length, 1);
  assert.equal(task.sourceRefs.length, 1);
  assert.equal(task.lineItems.length, 1);
  assert.equal(task.archived, false);
  assert.equal(task.supersededBy, null);
  assert.equal(task.taskType, 'single');
});

test('LINEITEM_UPDATE patch whitelist protects line item identity and evidence links', () => {
  const dir = resetTmp('lineitem-update-whitelist');
  const data = migrateToV5({
    version: 5,
    tasks: [{
      id: 'proj-1',
      title: 'Project',
      taskType: 'project',
      sourceRefs: [{ id: 'src-keep', date: '2026-07-01T00:00:00.000Z', link: 'https://example.test/keep' }],
      lineItems: [{
        id: 'li-keep',
        title: 'Keep line',
        status: 'open',
        evidenceRefIds: ['src-keep'],
        sourceTaskIds: ['source-task']
      }]
    }]
  });
  const { markers } = parseMarkers(marker('LINEITEM_UPDATE', {
    taskId: 'proj-1',
    lineItemId: 'li-keep',
    patch: {
      id: 'li-hijacked',
      evidenceRefIds: [],
      sourceTaskIds: []
    }
  }));

  const result = applyMarkerBatch(data, markers, {
    auditLogFile: path.join(dir, 'audit.jsonl')
  });
  const lineItem = result.data.tasks[0].lineItems[0];

  assert.equal(result.applied, 0);
  assert.match(result.dropped[0].reason, /disallowed field/);
  assert.equal(lineItem.id, 'li-keep');
  assert.deepEqual(lineItem.evidenceRefIds, ['src-keep']);
  assert.deepEqual(lineItem.sourceTaskIds, ['source-task']);
});

test('LINEITEM_UPDATE can clear review state only with evidence', () => {
  const dir = resetTmp('lineitem-update-review-state');
  const data = migrateToV5({
    version: 5,
    tasks: [{
      id: 'proj-review',
      title: 'Project review',
      taskType: 'project',
      sourceRefs: [{ id: 'src-review', date: '2026-07-15T10:00:00.000Z', link: 'https://example.test/review' }],
      lineItems: [{
        id: 'li-review',
        title: 'Review line',
        status: 'open',
        state: 'confirmed',
        needsReview: true,
        reviewReason: 'Earlier evidence was incomplete.',
        evidenceRefIds: ['src-review']
      }]
    }]
  });
  const payload = {
    taskId: 'proj-review',
    lineItemId: 'li-review',
    patch: { needsReview: false, reviewReason: null }
  };

  const missingEvidence = applyMarkerBatch(data, parseMarkers(marker('LINEITEM_UPDATE', payload)).markers, {
    auditLogFile: path.join(dir, 'missing-audit.jsonl')
  });
  assert.equal(missingEvidence.applied, 0);
  assert.match(missingEvidence.dropped[0].reason, /missing evidenceRefIds/);

  const verified = applyMarkerBatch(data, parseMarkers(marker('LINEITEM_UPDATE', {
    ...payload,
    evidenceRefIds: ['src-review']
  })).markers, {
    auditLogFile: path.join(dir, 'verified-audit.jsonl')
  });
  assert.equal(verified.applied, 1);
  assert.equal(verified.data.tasks[0].lineItems[0].needsReview, false);
  assert.equal(verified.data.tasks[0].lineItems[0].reviewReason, null);
});

test('legacy unverified resolution status does not block an evidenced line-item update', () => {
  const dir = resetTmp('lineitem-update-legacy-resolution');
  const data = {
    version: 5,
    tasks: [{
      id: 'proj-legacy-resolution',
      title: 'Legacy project',
      taskType: 'project',
      sourceRefs: [{ id: 'src-current', date: '2026-07-15T10:00:00.000Z', link: 'https://example.test/current' }],
      lineItems: [{
        id: 'li-legacy-resolution',
        title: 'Legacy informational line',
        category: 'info',
        status: 'on-radar',
        state: 'unconfirmed',
        resolutionStatus: 'unverified',
        needsReview: true,
        evidenceRefIds: ['src-current']
      }]
    }]
  };
  const { markers } = parseMarkers(marker('LINEITEM_UPDATE', {
    taskId: 'proj-legacy-resolution',
    lineItemId: 'li-legacy-resolution',
    patch: {
      status: 'in-progress',
      state: 'confirmed',
      currentState: 'Fresh evidence confirms the work is in progress.',
      needsReview: false,
      reviewReason: null
    },
    evidenceRefIds: ['src-current']
  }));

  const result = applyMarkerBatch(data, markers, {
    auditLogFile: path.join(dir, 'audit.jsonl')
  });
  const lineItem = result.data.tasks[0].lineItems[0];

  assert.equal(result.applied, 1);
  assert.equal(result.dropped.length, 0);
  assert.equal(lineItem.status, 'in-progress');
  assert.equal(lineItem.resolutionStatus, null);
  assert.equal(lineItem.needsReview, false);
});

test('invalid markers cannot seed evidence for later status updates', () => {
  const dir = resetTmp('validated-evidence-index');
  const text = [
    marker('PROJECT_NEW', {
      sourceRefs: [{ id: 'src-ghost', link: 'https://example.test/ghost', date: '2026-07-05' }],
      lineItems: []
    }),
    marker('TASK_UPDATE', {
      taskId: 'old-1',
      patch: { status: 'done' },
      evidenceRefIds: ['src-ghost']
    })
  ].join('\n');
  const { markers } = parseMarkers(text);

  const result = applyMarkerBatch(baseData(), markers, {
    auditLogFile: path.join(dir, 'audit.jsonl')
  });

  assert.equal(result.applied, 0);
  assert.equal(result.dropped.length, 2);
  assert.match(result.dropped[0].reason, /PROJECT_NEW requires title/);
  assert.match(result.dropped[1].reason, /unknown evidenceRefId/);
  assert.equal(result.data.tasks.find(task => task.id === 'old-1').status, 'new');
});

test('TASK_UPDATE can introduce and persist sourceRefs for its evidence gate', () => {
  const dir = resetTmp('task-update-source-ref-channel');
  const { markers } = parseMarkers(marker('TASK_UPDATE', {
    taskId: 'old-1',
    patch: { status: 'done' },
    sourceRefs: [{
      id: 'src-new-mail',
      type: 'email',
      title: 'Completion update',
      date: '2026-07-05T09:00:00.000Z',
      link: 'https://example.test/new-mail',
      evidenceText: 'The task is done.'
    }],
    evidenceRefIds: ['src-new-mail']
  }));

  const result = applyMarkerBatch(baseData(), markers, {
    auditLogFile: path.join(dir, 'audit.jsonl'),
    now: new Date('2026-07-05T10:00:00.000Z')
  });
  const task = result.data.tasks.find(item => item.id === 'old-1');

  assert.equal(result.applied, 1);
  assert.equal(task.status, 'done');
  assert.equal(task.sourceRefs[0].id, 'src-new-mail');
  assert.equal(task.additionalLinks[0], 'https://example.test/new-mail');
  assert.equal(task.brainState.lastEvidenceAt, '2026-07-05T09:00:00.000Z');
});

test('introduced sourceRef links containing ellipses are discarded and audited without dropping marker', () => {
  const dir = resetTmp('discard-ellipsis-source-link');
  const { markers } = parseMarkers(marker('TASK_NEW', {
    taskId: 'new-linkless',
    title: 'New task with bad source link',
    sourceRef: {
      id: 'src-bad-link',
      type: 'email',
      title: 'Bad shortened link',
      link: 'https://outlook.office365.com/owa/...=ReadMessageItem'
    }
  }));

  const result = applyMarkerBatch(baseData(), markers, {
    auditLogFile: path.join(dir, 'audit.jsonl'),
    now: new Date('2026-07-05T10:00:00.000Z')
  });
  const task = result.data.tasks.find(item => item.id === 'new-linkless');
  const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');

  assert.equal(result.applied, 1);
  assert.equal(result.dropped.length, 0);
  assert.equal(task.sourceRefs[0].link, null);
  assert.match(audit, /discard-source-link/);
  assert.match(audit, /must not contain/);
});

test('superseded source tasks are archived but not deleted', () => {
  const dir = resetTmp('superseded');
  const { markers } = parseMarkers(marker('PROJECT_NEW', {
    taskId: 'proj-archive',
    title: 'Archive test',
    sourceRefs: [{
      id: 'src-archive',
      type: 'email',
      title: 'Archive update',
      date: '2026-07-05T09:00:00.000Z',
      link: 'https://example.test/archive'
    }],
    lineItems: [{
      id: 'li-archive',
      title: 'Archive line',
      status: 'open',
      relevance: relevance('src-archive'),
      evidenceRefIds: ['src-archive']
    }],
    supersedesTaskIds: ['old-1']
  }));

  const result = applyMarkerBatch(baseData(), markers, {
    auditLogFile: path.join(dir, 'audit.jsonl')
  });
  const oldTask = result.data.tasks.find(task => task.id === 'old-1');

  assert.ok(oldTask);
  assert.equal(oldTask.archived, true);
  assert.equal(oldTask.supersededBy, 'proj-archive');
  assert.equal(result.data.tasks.length, 2);
});

test('NEEDS_REVIEW persists task review state and root reviewQueue entries', () => {
  const dir = resetTmp('needs-review');
  const text = [
    marker('NEEDS_REVIEW', {
      kind: 'status',
      ref: 'old-1',
      question: 'Is this still current?',
      confidence: 'low'
    }),
    marker('NEEDS_REVIEW', {
      kind: 'other',
      ref: null,
      question: 'Which project owns this?',
      confidence: 'low'
    })
  ].join('\n');
  const { markers } = parseMarkers(text);
  const result = applyMarkerBatch(baseData(), markers, {
    auditLogFile: path.join(dir, 'audit.jsonl'),
    now: new Date('2026-07-05T11:00:00.000Z')
  });
  const task = result.data.tasks.find(item => item.id === 'old-1');

  assert.equal(task.brainState.needsReview, true);
  assert.equal(task.brainState.reviewReason, 'Is this still current?');
  assert.equal(result.data.reviewQueue.length, 1);
  assert.equal(result.data.reviewQueue[0].question, 'Which project owns this?');
});

test('date-only evidence caps confidence to medium when traced to a SourceRef', () => {
  const dir = resetTmp('date-only-cap');
  const data = migrateToV5({
    version: 5,
    tasks: [{
      id: 'proj-date',
      title: 'Date project',
      status: 'new',
      taskType: 'project',
      sourceRefs: [{
        id: 'src-date',
        type: 'teams',
        title: 'Date-only update',
        date: '2026-07-05T09:00:00.000Z',
        link: null
      }],
      lineItems: [{
        id: 'li-date',
        title: 'Date line',
        status: 'open',
        confidence: 'high',
        evidenceRefIds: ['src-date']
      }]
    }]
  });
  const { markers } = parseMarkers(marker('LINEITEM_UPDATE', {
    taskId: 'proj-date',
    lineItemId: 'li-date',
    patch: { status: 'waiting', confidence: 'high' },
    evidenceRefIds: ['src-date']
  }));

  const result = applyMarkerBatch(data, markers, {
    auditLogFile: path.join(dir, 'audit.jsonl')
  });
  const lineItem = result.data.tasks[0].lineItems[0];

  assert.equal(result.applied, 1);
  assert.equal(lineItem.status, 'waiting');
  assert.equal(lineItem.confidence, 'medium');
});

test('date-only evidence must resolve to an existing or same-batch SourceRef', () => {
  const dir = resetTmp('date-only-missing-source');
  const { markers } = parseMarkers(marker('TASK_UPDATE', {
    taskId: 'old-1',
    patch: { status: 'in-progress', confidence: 'high' },
    evidenceRefIds: ['src-missing-date']
  }));

  const result = applyMarkerBatch(baseData(), markers, {
    auditLogFile: path.join(dir, 'audit.jsonl')
  });

  assert.equal(result.applied, 0);
  assert.equal(result.data.tasks.find(task => task.id === 'old-1').status, 'new');
  assert.match(result.dropped[0].reason, /unknown evidenceRefId/);
});

// --- P3 fix: shared semantic-relevance inactivity predicate -----------------
// The Reality Gateway (deterministicMarkerIssue) and the marker-applier
// (applyMarkerBatch) must agree on when an evidence-backed relevance object is
// mandatory. Both now delegate to requiresSemanticRelevance in brain/relevance.js.

const RELEVANCE_CASE_MATRIX = [
  { name: 'status resolved', lineItem: { status: 'resolved' }, requiresRelevance: false },
  { name: 'status cancelled', lineItem: { status: 'cancelled' }, requiresRelevance: false },
  { name: 'status canceled', lineItem: { status: 'canceled' }, requiresRelevance: false },
  { name: 'state obsolete with status open', lineItem: { status: 'open', state: 'obsolete' }, requiresRelevance: false },
  { name: 'state superseded with status blocked', lineItem: { status: 'blocked', state: 'superseded' }, requiresRelevance: false },
  { name: 'normal active open item', lineItem: { status: 'open' }, requiresRelevance: true }
];

function relevanceMatrixProjectData() {
  return migrateToV5({
    version: 5,
    tasks: [{
      id: 'proj-relevance-matrix',
      title: 'Relevance matrix project',
      taskType: 'project',
      sourceRefs: [{ id: 'src-existing', type: 'email', date: '2026-07-05T08:00:00.000Z' }],
      lineItems: []
    }]
  });
}

function relevanceMatrixMarker(entry, index) {
  return marker('LINEITEM_NEW', {
    taskId: 'proj-relevance-matrix',
    lineItem: {
      id: `li-matrix-${index}`,
      title: 'Matrix item',
      category: 'info',
      evidenceRefIds: ['src-existing'],
      ...entry.lineItem
    }
  });
}

test('requiresSemanticRelevance treats every inactive status as exempt', () => {
  for (const status of ['done', 'completed', 'closed', 'obsolete', 'superseded', 'cancelled', 'canceled', 'resolved']) {
    assert.equal(requiresSemanticRelevance({ status }), false, `status ${status} must be exempt`);
  }
});

test('requiresSemanticRelevance exempts truth-tree state obsolete or superseded regardless of active status', () => {
  assert.equal(requiresSemanticRelevance({ status: 'open', state: 'obsolete' }), false);
  assert.equal(requiresSemanticRelevance({ status: 'blocked', state: 'superseded' }), false);
});

test('requiresSemanticRelevance requires relevance for a normal active open item', () => {
  assert.equal(requiresSemanticRelevance({ status: 'open' }), true);
  assert.equal(requiresSemanticRelevance({ status: 'open', state: 'confirmed' }), true);
  assert.equal(requiresSemanticRelevance({}), true);
});

test('requiresSemanticRelevance normalizes case and whitespace and never mutates input', () => {
  assert.equal(requiresSemanticRelevance({ status: '  Resolved  ' }), false);
  assert.equal(requiresSemanticRelevance({ status: 'OPEN', state: '  Superseded ' }), false);
  assert.equal(requiresSemanticRelevance({ status: '  OPEN  ' }), true);

  const input = { status: 'Resolved', state: 'Confirmed', priority: 'high' };
  const before = structuredClone(input);
  requiresSemanticRelevance(input);
  assert.deepEqual(input, before);

  assert.doesNotThrow(() => requiresSemanticRelevance(Object.freeze({ status: 'done' })));
});

test('requiresSemanticRelevance is independent of priority, confidence, review status, title, sender, and keywords', () => {
  const noise = { priority: 'urgent', confidence: 'high', needsReview: true, title: 'x', sender: 'a@b.test', keywords: ['k'], topic: 't' };
  assert.equal(requiresSemanticRelevance({ status: 'open', ...noise }), true);
  assert.equal(requiresSemanticRelevance({ status: 'resolved', ...noise }), false);
  assert.equal(requiresSemanticRelevance({ status: 'open', state: 'obsolete', ...noise }), false);
});

test('gateway and marker-applier acceptance paths agree on relevance requirement', () => {
  for (const [index, entry] of RELEVANCE_CASE_MATRIX.entries()) {
    const { markers } = parseMarkers(relevanceMatrixMarker(entry, index));

    // Path 1: Reality Gateway deterministic check.
    const gatewayIssue = deterministicMarkerIssue(markers[0]);
    const gatewayRequires = /relevance is required/.test(gatewayIssue || '');

    // Path 2: marker-applier validation pipeline.
    const result = applyMarkerBatch(relevanceMatrixProjectData(), markers, {
      auditLogFile: null,
      now: new Date('2026-07-15T10:00:00.000Z')
    });
    const applierRequires = result.applied === 0 && /relevance is required/.test(result.dropped[0]?.reason || '');

    assert.equal(gatewayRequires, entry.requiresRelevance, `gateway disagreed for: ${entry.name}`);
    assert.equal(applierRequires, entry.requiresRelevance, `applier disagreed for: ${entry.name}`);
    assert.equal(gatewayRequires, applierRequires, `paths disagreed for: ${entry.name}`);

    if (entry.requiresRelevance) {
      assert.equal(gatewayIssue !== null, true);
      assert.equal(result.applied, 0);
    } else {
      assert.equal(gatewayIssue, null, `gateway held an inactive item: ${entry.name}`);
      assert.equal(result.applied, 1, `applier dropped an inactive item: ${entry.name}`);
    }
  }
});
