import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runBrainScanOnce } from '../../brain/scan-brain.js';
import { migrateToV5, writeJsonFileAtomic } from '../../brain/tasks-v5.js';

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
        evidenceRefIds: ['src-alpha'],
        sourceTaskIds: ['source-1']
      }],
      supersedesTaskIds: ['source-1']
    }),
    marker('SCAN_DONE', {
      runId: 'run-b1',
      outcome: 'success',
      newProjects: 1,
      updatedProjects: 0,
      newSingleTasks: 0,
      workIqCalls: 2
    })
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
    marker('SCAN_DONE', { runId: 'run-salvage', outcome: 'success', newSingleTasks: 1 })
  ].join('\n');

  const result = await runBrainScanOnce(makeJob(), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-salvage',
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
        { id: 'li-room', title: 'Room preparation', status: 'open', evidenceRefIds: ['src-campus-1'] },
        { id: 'li-network', title: 'Network preparation', status: 'open', evidenceRefIds: ['src-campus-2'] }
      ],
      supersedesTaskIds: []
    }),
    marker('PROJECT_NEW', {
      taskId: 'proj-incident',
      projectKey: 'separate-incident',
      title: 'Separate incident',
      sourceRefs: [{ id: 'src-incident', date: '2026-07-05T09:00:00.000Z', link: 'https://example.test/incident' }],
      lineItems: [{ id: 'li-incident', title: 'Resolve incident', status: 'open', evidenceRefIds: ['src-incident'] }],
      supersedesTaskIds: []
    }),
    marker('SCAN_DONE', { runId: 'run-b4', outcome: 'success', newProjects: 2, updatedProjects: 0, newSingleTasks: 0 })
  ].join('\n');

  const result = await runBrainScanOnce(makeJob(), {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'run-b4',
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
    marker('SCAN_DONE', { runId: 'run-b5', outcome: 'success', newProjects: 0, updatedProjects: 1, newSingleTasks: 0 })
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
