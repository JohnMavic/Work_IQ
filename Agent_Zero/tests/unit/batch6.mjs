import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMarkerBatch } from '../../brain/marker-applier.js';
import { parseMarkers } from '../../brain/marker-parser.js';
import { runTaskChatOnce } from '../../brain/task-chat.js';
import { migrateToV5, writeJsonFileAtomic } from '../../brain/tasks-v5.js';
import { splitUserActionsByDone } from '../../brain/user-actions.js';
import { runReverifyTasks } from '../../scripts/reverify-tasks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-batch6');

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
    threadRef: 'conv-batch6-proof',
    askQuote: {
      text: 'Please send the quote.',
      from: 'Alex',
      date: '2026-07-06T08:00:00.000Z',
      threadRef: 'conv-batch6-proof'
    },
    resolutionStatus: 'open',
    lastVerifiedMessageDate: '2026-07-06T09:00:00.000Z',
    threadCheck: {
      coverage: 'complete',
      addressedTo: 'user',
      messageCount: 3,
      lastMessageDate: '2026-07-06T09:00:00.000Z',
      checkedThroughMessageDate: '2026-07-06T09:00:00.000Z'
    },
    ...overrides
  };
}

function writeFixture(dir, data) {
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, `${JSON.stringify(migrateToV5(data), null, 2)}\n`, 'utf8');
  return file;
}

function approveAllGateway({ markers }) {
  return {
    ok: true,
    text: markers.map((_, markerIndex) => `GATEWAY_DECISION\t${markerIndex}\tapprove\tApproved in unit test.`).join('\n'),
    counters: { workIqCalls: 0 }
  };
}

function baseProject(extra = {}) {
  return migrateToV5({
    version: 5,
    tasks: [{
      id: 'proj-b6',
      taskType: 'project',
      title: 'Batch 6 project',
      status: 'new',
      sourceRefs: [{ id: 'src-b6', date: '2026-07-06T08:00:00.000Z', link: 'https://example.test/b6' }],
      lineItems: [],
      history: [],
      pmStatus: {
        current: 'Current state',
        planned: [],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      ...extra
    }]
  });
}

test('B foreign-owner action is rejected from userActions and can be preserved as owned line item', () => {
  const data = baseProject();
  const { markers } = parseMarkers([
    marker('PROJECT_UPDATE', {
      taskId: 'proj-b6',
      pmStatus: {
        current: 'Current state',
        planned: [],
        userActions: [{ text: 'Alex must send the quote.', owner: 'Alex', evidence: 'src-b6', confidence: 'medium' }],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      evidenceRefIds: ['src-b6']
    }),
    marker('LINEITEM_NEW', {
      taskId: 'proj-b6',
      lineItem: {
        id: 'li-alex-quote',
        title: 'Send the quote',
        category: 'action',
        status: 'open',
        owner: 'Alex',
        currentState: 'Alex owns this follow-up.',
        ...actionProof(),
        evidenceRefIds: ['src-b6']
      }
    })
  ].join('\n'));

  const result = applyMarkerBatch(data, markers, { auditLogFile: null });
  const project = result.data.tasks[0];

  assert.equal(result.applied, 1);
  assert.match(result.dropped[0].reason, /owned by the app user/);
  assert.equal(project.pmStatus.userActions.length, 0);
  assert.equal(project.lineItems[0].owner, 'Alex');
});

test('C userMarkedDoneAt survives PROJECT_UPDATE carry-forward for identical user action', () => {
  const data = baseProject({
    pmStatus: {
      current: 'Current state',
      planned: [],
      userActions: [{
        id: 'ua-approve-budget',
        text: 'Approve the budget.',
        owner: 'user',
        evidence: 'src-b6',
        evidenceRefIds: ['src-b6'],
        confidence: 'medium',
        ...actionProof({
          askQuote: {
            text: 'Please send the confirmation mail.',
            from: 'Alex',
            date: '2026-07-06T08:00:00.000Z',
            threadRef: 'conv-batch6-proof'
          }
        }),
        userMarkedDoneAt: '2026-07-06T10:00:00.000Z'
      }],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    }
  });
  const { markers } = parseMarkers(marker('PROJECT_UPDATE', {
    taskId: 'proj-b6',
    pmStatus: {
      current: 'Current state',
      planned: [],
      userActions: [{
        id: 'ua-approve-budget',
        text: 'Approve the budget.',
        owner: 'user',
        evidence: 'src-b6',
        evidenceRefIds: ['src-b6'],
        confidence: 'medium'
      }],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    },
    evidenceRefIds: ['src-b6']
  }));

  const result = applyMarkerBatch(data, markers, { auditLogFile: null });
  const action = result.data.tasks[0].pmStatus.userActions[0];

  assert.equal(action.userMarkedDoneAt, '2026-07-06T10:00:00.000Z');
});

test('C confirmed and contradicted user-marked actions reconcile through history and active split', () => {
  const data = baseProject({
    pmStatus: {
      current: 'Current state',
      planned: [],
      userActions: [{
        id: 'ua-send-mail',
        text: 'Send the confirmation mail.',
        owner: 'user',
        evidence: 'src-b6',
        evidenceRefIds: ['src-b6'],
        confidence: 'medium',
        userMarkedDoneAt: '2026-07-06T10:00:00.000Z'
      }],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    }
  });
  const closed = applyMarkerBatch(data, parseMarkers(marker('PROJECT_UPDATE', {
    taskId: 'proj-b6',
    pmStatus: {
      current: 'Current state',
      planned: [],
      userActions: [],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    },
    evidenceRefIds: ['src-b6']
  })).markers, { auditLogFile: null });

  assert.equal(closed.data.tasks[0].pmStatus.userActions.length, 0);
  assert.equal(closed.data.tasks[0].history.at(-1).type, 'user-action-confirmed');

  const reopened = applyMarkerBatch(data, parseMarkers(marker('PROJECT_UPDATE', {
    taskId: 'proj-b6',
    pmStatus: {
      current: 'Current state',
      planned: [],
      userActions: [{
        id: 'ua-send-mail',
        text: 'Send the confirmation mail.',
        owner: 'user',
        evidence: 'src-b6',
        evidenceRefIds: ['src-b6'],
        confidence: 'medium',
        ...actionProof({
          askQuote: {
            text: 'Please send the confirmation mail.',
            from: 'Alex',
            date: '2026-07-06T08:00:00.000Z',
            threadRef: 'conv-batch6-proof'
          }
        }),
        userMarkedDoneAt: null
      }],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    },
    evidenceRefIds: ['src-b6']
  })).markers, { auditLogFile: null });
  const split = splitUserActionsByDone(reopened.data.tasks[0].pmStatus.userActions);

  assert.equal(split.active.length, 1);
  assert.equal(split.done.length, 0);
  assert.equal(reopened.data.tasks[0].history.at(-1).type, 'user-action-reopened');
});

test('D task chat markers go through gateway and cross-task marker is held', async () => {
  const dir = resetTmp('task-chat-cross-scope');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [
      {
        id: 'task-a',
        taskType: 'single',
        title: 'Task A',
        status: 'new',
        sourceRefs: [{ id: 'src-a', link: 'https://example.test/a' }],
        history: []
      },
      {
        id: 'task-b',
        taskType: 'single',
        title: 'Task B',
        status: 'new',
        sourceRefs: [{ id: 'src-b', link: 'https://example.test/b' }],
        history: []
      }
    ]
  });

  const output = [
    'I checked the task and held the unrelated update.',
    marker('TASK_UPDATE', { taskId: 'task-b', patch: { status: 'done' }, evidenceRefIds: ['src-b'] })
  ].join('\n');
  const result = await runTaskChatOnce({ id: 'job-chat', taskId: 'task-a', input: { text: 'Update this task' }, emit() {} }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'chat-cross',
    _runBrain: async () => ({ ok: true, assistantText: output, counters: { workIqCalls: 0 } }),
    _runGateway: approveAllGateway,
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(result.scopeHeld, 1);
  assert.equal(saved.tasks.find(task => task.id === 'task-b').status, 'new');
  assert.equal(saved.tasks.find(task => task.id === 'task-a').brainState.needsReview, true);
});

test('D task chat SCAN_DONE does not advance global scan telemetry', async () => {
  const dir = resetTmp('task-chat-scan-watermark');
  const tasksFile = writeFixture(dir, {
    version: 5,
    lastScan: '2026-07-01T08:00:00.000Z',
    brain: { lastRunId: 'global-scan', lastRunAt: '2026-07-01T08:00:00.000Z', lastOutcome: 'success' },
    tasks: [{
      id: 'task-a',
      taskType: 'single',
      title: 'Task A',
      status: 'new',
      sourceRefs: [],
      history: []
    }]
  });
  const output = [
    'The task state was checked.',
    marker('SCAN_DONE', { runId: 'task-chat-run', outcome: 'success', workIqCalls: 1 })
  ].join('\n');

  await runTaskChatOnce({ id: 'job-chat-scan', taskId: 'task-a', input: { text: 'Check this task' }, emit() {} }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'task-chat-run',
    _runBrain: async () => ({ ok: true, assistantText: output, counters: { workIqCalls: 1 } }),
    _runGateway: approveAllGateway,
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(saved.lastScan, '2026-07-01T08:00:00.000Z');
  assert.equal(saved.brain.lastRunId, 'global-scan');
  assert.equal(saved.brain.lastOutcome, 'success');
});

test('D task chat pure answer skips reality gateway spawn', async () => {
  const dir = resetTmp('task-chat-no-marker-gateway-skip');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'task-a',
      taskType: 'single',
      title: 'Task A',
      status: 'new',
      sourceRefs: [],
      history: []
    }]
  });
  let gatewayCalls = 0;

  const result = await runTaskChatOnce({
    id: 'job-chat-no-marker',
    taskId: 'task-a',
    input: { text: 'What is this task about?' },
    emit() {}
  }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'chat-no-marker',
    _runBrain: async () => ({
      ok: true,
      assistantText: 'This is a plain answer with no state update.',
      counters: { workIqCalls: 0 }
    }),
    _runGateway: async () => {
      gatewayCalls++;
      throw new Error('gateway should not run without markers');
    },
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(gatewayCalls, 0);
  assert.equal(result.markersParsed, 0);
  assert.equal(result.gateway.skipped, true);
  assert.equal(saved.tasks[0].history.at(-1).agentResponse, 'This is a plain answer with no state update.');
});

test('D marker-only invalid chat output writes nothing', async () => {
  const dir = resetTmp('task-chat-invalid');
  const initial = migrateToV5({
    version: 5,
    tasks: [{ id: 'task-a', taskType: 'single', title: 'Task A', status: 'new', history: [] }]
  });
  const tasksFile = writeFixture(dir, initial);
  const before = fs.readFileSync(tasksFile, 'utf8');

  await assert.rejects(
    runTaskChatOnce({ id: 'job-invalid', taskId: 'task-a', input: { text: 'bad output' }, emit() {} }, {
      tasksFile,
      brainWorkDir: path.join(dir, 'brain-work'),
      _runBrain: async () => ({ ok: true, assistantText: '[TASK_UPDATE] {"taskId":"task-a","patch":}', counters: { workIqCalls: 0 } }),
      _runGateway: approveAllGateway
    }),
    /no valid markers or answer text/
  );

  assert.equal(fs.readFileSync(tasksFile, 'utf8'), before);
});

test('A reverify dry-run does not write, apply writes removed pmStatus entry to reviewQueue', async () => {
  const dir = resetTmp('reverify');
  const tasksFile = writeFixture(dir, baseProject({
    pmStatus: {
      current: 'Current state',
      planned: [],
      userActions: [],
      problems: [{ id: 'prob-1', text: 'Unsupported problem.', evidence: 'src-b6', confidence: 'medium' }],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    }
  }));
  const before = fs.readFileSync(tasksFile, 'utf8');
  const output = [
    marker('PROJECT_UPDATE', {
      taskId: 'proj-b6',
      pmStatus: {
        current: 'Current state',
        planned: [],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      evidenceRefIds: ['src-b6']
    }),
    marker('SCAN_DONE', { runId: 'reverify-test', outcome: 'success', workIqCalls: 1 })
  ].join('\n');
  const options = {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'reverify-test',
    _runBrain: async () => ({ ok: true, assistantText: output, counters: { workIqCalls: 1 } }),
    _runGateway: approveAllGateway,
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  };

  const dry = await runReverifyTasks({ ...options, apply: false });
  assert.equal(fs.readFileSync(tasksFile, 'utf8'), before);
  assert.equal(dry.stats.reviewEntriesAdded, 1);

  const applied = await runReverifyTasks({ ...options, apply: true });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(applied.wrote, true);
  assert.equal(saved.tasks[0].pmStatus.problems.length, 0);
  assert.equal(saved.reviewQueue[0].repairId, 'batch6-reverify-sweep');
  assert.deepEqual(saved.reviewQueue[0].payload.entry.text, 'Unsupported problem.');
});
