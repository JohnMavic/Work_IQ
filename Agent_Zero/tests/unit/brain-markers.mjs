import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseMarkers } from '../../brain/marker-parser.js';
import { applyMarkerBatch } from '../../brain/marker-applier.js';
import { migrateToV5 } from '../../brain/tasks-v5.js';

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
