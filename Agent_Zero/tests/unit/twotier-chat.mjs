import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildDeterministicTaskChatFallback,
  DEFAULT_TASK_CHAT_DEEP_TARGET_MS,
  DEFAULT_TASK_CHAT_DEEP_TIMEOUT_MS,
  DEFAULT_TASK_CHAT_DEEP_WORKIQ_LIMIT,
  DEFAULT_TASK_CHAT_FAST_TIMEOUT_MS,
  DEFAULT_TASK_CHAT_FAST_WORKIQ_LIMIT,
  extractDeepVerificationFlag,
  inferDeepVerificationRequirement,
  runTaskChatDeepVerifyOnce,
  runTaskChatFastOnce
} from '../../brain/task-chat.js';
import { BRAIN_RUN_CLASS } from '../../brain/brain-scheduler.js';
import { migrateToV5, writeJsonFileAtomic } from '../../brain/tasks-v5.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-twotier-chat');

function resetTmp(name) {
  const dir = path.join(tmpRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeFixture(dir, data) {
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, `${JSON.stringify(migrateToV5(data), null, 2)}\n`, 'utf8');
  return file;
}

function marker(type, payload) {
  return `[${type}] ${JSON.stringify(payload)}`;
}

function approveAllGateway({ markers }) {
  return {
    ok: true,
    text: markers.map((_, index) => `GATEWAY_DECISION\t${index}\tapprove\tApproved by fixture.`).join('\n')
  };
}

test('TWOTIER flag parser strips machine line and detects deep verification target', () => {
  const parsed = extractDeepVerificationFlag([
      'The approval is open from project state (last verified 2026-07-06).',
      'Deep verification against MyApprovals started — I will update this conversation.',
      'DEEP_VERIFY {"required":true,"system":"MyApprovals","reason":"approval state needs source of record","question":"Is it approved?","verifyExactly":["Check approval 123 in MyApprovals"]}'
    ].join('\n'));

  assert.equal(parsed.flag.required, true);
  assert.equal(parsed.flag.system, 'MyApprovals');
  assert.equal(parsed.flag.question, 'Is it approved?');
  assert.deepEqual(parsed.flag.verifyExactly, ['Check approval 123 in MyApprovals']);
  assert.doesNotMatch(parsed.text, /DEEP_VERIFY/);
});

test('TWOTIER stage 1 is state-only, MCP-free, and never runs gateway', async () => {
  const dir = resetTmp('stage1-guards');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'task-fast',
      taskType: 'single',
      title: 'Fast task',
      status: 'new',
      sourceRefs: [],
      history: []
    }]
  });
  const captured = {};

  const result = await runTaskChatFastOnce({
    id: 'job-fast',
    taskId: 'task-fast',
    input: { text: 'Is this approved?' },
    emit() {}
  }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'fast-run',
    now: new Date('2026-07-07T08:00:00.000Z'),
    _runBrain: async (options) => {
      Object.assign(captured, options);
      return {
        ok: true,
        assistantText: [
          'The approval appears open from project state (last verified unknown).',
          marker('TASK_UPDATE', { taskId: 'task-fast', patch: { status: 'done' } }),
          'Deep verification against MyApprovals started — I will update this conversation.',
          'DEEP_VERIFY {"required":true,"system":"MyApprovals","reason":"approval status requires source-of-record verification","question":"Is this approved?"}'
        ].join('\n'),
        counters: { workIqCalls: 0 }
      };
    },
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const history = saved.tasks[0].history.at(-1);

  assert.equal(captured.timeoutMs, DEFAULT_TASK_CHAT_FAST_TIMEOUT_MS);
  assert.equal(captured.workIqHardLimit, DEFAULT_TASK_CHAT_FAST_WORKIQ_LIMIT);
  assert.equal(captured.runClass, BRAIN_RUN_CLASS.INTERACTIVE);
  assert.equal(captured.mcpMode, 'none');
  assert.match(captured.prompt, /Do not emit Agent Zero marker lines/);
  assert.match(captured.prompt, /State-only means no WorkIQ/);
  assert.doesNotMatch(captured.prompt, /You may use WorkIQ/);
  assert.equal(saved.tasks[0].status, 'new');
  assert.equal(result.markersHeld, 1);
  assert.equal(result.gateway.skipped, true);
  assert.equal(history.agentExecution.deepVerification.status, 'running');
  assert.equal(history.agentExecution.deepVerification.system, 'MyApprovals');
  assert.match(history.agentExecution.deepVerification.verifyExactly[0], /Is this approved\?/);
});

test('TWOTIER scan and lookup questions force the Stage 2 flag even if Stage 1 says no', async () => {
  const dir = resetTmp('stage1-scan-flag');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'task-scan',
      taskType: 'project',
      title: 'Scan task',
      status: 'new',
      sourceRefs: [],
      history: [],
      pmStatus: {
        current: 'No open user actions are recorded.',
        planned: [],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium',
        lastSynthesizedAt: '2026-07-07T08:00:00.000Z'
      }
    }]
  });

  const result = await runTaskChatFastOnce({
    id: 'job-scan',
    taskId: 'task-scan',
    input: { text: 'Gibt es Action Items, bei denen ich aktiv werden muss? Ich scanne dazu meine Inbox der letzten zwei Wochen.' },
    emit() {}
  }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'scan-flag-run',
    now: new Date('2026-07-07T08:00:00.000Z'),
    _runBrain: async () => ({
      ok: true,
      assistantText: [
        'No open user actions are recorded from project state, last verified 2026-07-07T08:00:00.000Z.',
        'DEEP_VERIFY {"required":false}'
      ].join('\n'),
      counters: { workIqCalls: 0 }
    }),
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });

  assert.equal(DEFAULT_TASK_CHAT_FAST_WORKIQ_LIMIT, 0);
  assert.equal(result.deepVerification.required, true);
  assert.equal(result.deepVerification.status, 'running');
  assert.equal(result.deepVerification.system, 'Microsoft 365');
  assert.match(result.assistantText, /Deep verification against Microsoft 365 started/);
});

test('TWOTIER deterministic Stage 1 timeout fallback persists an answer and queues deep verification', async () => {
  const dir = resetTmp('stage1-timeout-fallback');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'task-timeout',
      taskType: 'project',
      title: 'Timeout task',
      status: 'new',
      updatedAt: '2026-07-06T18:00:00.000Z',
      sourceRefs: [],
      history: [],
      pmStatus: {
        current: 'The project is waiting for approval status confirmation.',
        planned: [],
        userActions: [{ text: 'Review the approval if still pending.', status: 'open' }],
        problems: [],
        risks: [],
        waitingOn: [{ text: 'System-of-record approval state.' }],
        confidence: 'medium',
        lastSynthesizedAt: '2026-07-06T18:00:00.000Z'
      },
      factSheet: {
        sections: {
          status: [{ text: 'Approval state is not verified in the system of record.', date: '2026-07-06' }],
          openActions: [],
          budgetCostsApprovals: [],
          risksChallenges: []
        }
      }
    }]
  });

  const result = await runTaskChatFastOnce({
    id: 'job-timeout',
    taskId: 'task-timeout',
    input: { text: 'Check whether this approval is still open.' },
    emit() {}
  }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'timeout-fallback-run',
    now: new Date('2026-07-07T08:00:00.000Z'),
    _runBrain: async (options) => ({
      ok: false,
      timedOut: true,
      salvaged: false,
      error: { message: 'Agency brain run timed out' },
      counters: { workIqCalls: 0 },
      options
    }),
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const history = saved.tasks[0].history.at(-1);

  assert.equal(result.brain.timedOut, true);
  assert.equal(result.brain.deterministicFallback, true);
  assert.equal(result.deepVerification.required, true);
  assert.equal(result.deepVerification.system, 'MyApprovals');
  assert.match(result.assistantText, /^Current project state:/);
  assert.match(result.assistantText, /from project state, last verified 2026-07-06T18:00:00.000Z/);
  assert.match(result.assistantText, /Deep verification against MyApprovals started/);
  assert.equal(history.agentExecution.method, 'agency-task-chat-fast-fallback-v1');
  assert.equal(history.agentResponse, result.assistantText);
});

test('TWOTIER deterministic helpers classify scan questions and summarize project state', () => {
  const inferred = inferDeepVerificationRequirement('Bitte Inbox scannen und Status prüfen.');
  assert.equal(inferred.required, true);
  assert.equal(inferred.system, 'Microsoft 365');

  const fallback = buildDeterministicTaskChatFallback({
    userPrompt: 'Bitte Inbox scannen.',
    task: {
      id: 'task-helper',
      title: 'Helper task',
      updatedAt: '2026-07-06T09:00:00.000Z',
      pmStatus: {
        current: 'Known state only.',
        userActions: [],
        waitingOn: [],
        problems: [],
        risks: []
      }
    }
  });
  assert.match(fallback.assistantText, /Current project state: Known state only/);
  assert.match(fallback.assistantText, /Deep verification against Microsoft 365 started/);
  assert.equal(fallback.flag.required, true);
});

test('TWOTIER stage 2 posts answer before async gateway markers and keeps focused scope', async () => {
  const dir = resetTmp('stage2-followup');
  const conversationId = 'conv-deep-1';
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'task-deep',
      taskType: 'single',
      title: 'Deep task',
      status: 'new',
      sourceRefs: [],
      history: [{
        timestamp: '2026-07-07T08:00:00.000Z',
        conversationId,
        type: 'update',
        text: 'Is this approved?',
        agentResponse: 'State says pending from project state (last verified unknown).\nDeep verification against MyApprovals started — I will update this conversation.',
        agentExecution: {
          confidence: 'medium',
          answer: 'State says pending.',
          method: 'agency-task-chat-fast-v1',
          deepVerification: {
            required: true,
            status: 'running',
            system: 'MyApprovals',
            question: 'Is this approved?',
            conversationId,
            startedAt: '2026-07-07T08:00:00.000Z'
          }
        }
      }]
    }]
  });
  const captured = {};
  let gatewayCalls = 0;
  let releaseGateway;
  const gatewayGate = new Promise(resolve => { releaseGateway = resolve; });
  const events = [];

  const result = await runTaskChatDeepVerifyOnce({
    id: 'job-deep',
    taskId: 'task-deep',
    input: {
      text: 'Is this approved?',
      conversationId,
      stageOneAnswer: 'State says pending.',
      deepVerification: {
        required: true,
        system: 'MyApprovals',
        question: 'Is this approved?',
        verifyExactly: [
          'Check approval 123 in MyApprovals',
          'Confirm whether the approval is still pending'
        ]
      }
    },
    emit(type, payload) { events.push({ type, payload }); }
  }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'deep-run',
    now: new Date('2026-07-07T08:05:00.000Z'),
    _runBrain: async (options) => {
      Object.assign(captured, options);
      options.onToolExecution?.({
        type: 'tool.execution_start',
        data: { toolName: 'workiq.search', serverName: 'WorkIQ' }
      }, { workIqCalls: 1 });
      return {
        ok: true,
        assistantText: [
          'The item is still pending verified in MyApprovals.',
          marker('NEEDS_REVIEW', { kind: 'status', ref: 'task-deep', question: 'Deep verification found pending state.', confidence: 'low' })
        ].join('\n'),
        counters: { workIqCalls: 3 }
      };
    },
    _runGateway: async (options) => {
      gatewayCalls++;
      await gatewayGate;
      return approveAllGateway(options);
    },
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const savedBeforeGateway = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const historyBeforeGateway = savedBeforeGateway.tasks[0].history[0];

  assert.equal(DEFAULT_TASK_CHAT_DEEP_TARGET_MS, 5 * 60 * 1000);
  assert.equal(captured.timeoutMs, DEFAULT_TASK_CHAT_DEEP_TIMEOUT_MS);
  assert.equal(captured.workIqHardLimit, DEFAULT_TASK_CHAT_DEEP_WORKIQ_LIMIT);
  assert.equal(captured.runClass, BRAIN_RUN_CLASS.BACKGROUND);
  assert.equal(captured.mcpMode, 'default');
  assert.match(captured.prompt, /Portal\/CDP\/browser\/shell patterns/);
  assert.match(captured.prompt, /Verify exactly:\n1\. Check approval 123 in MyApprovals\n2\. Confirm whether the approval is still pending/);
  assert.match(captured.prompt, /Do not perform a full project rescan, full inbox rescan, or broad historical sweep/);
  assert.equal(gatewayCalls, 0);
  assert.equal(result.conversationId, conversationId);
  assert.equal(historyBeforeGateway.agentExecution.deepVerification.status, 'completed');
  assert.equal(historyBeforeGateway.agentExecution.deepVerification.markerProcessingStatus, 'scheduled');
  assert.equal(historyBeforeGateway.agentFollowups.length, 1);
  assert.equal(historyBeforeGateway.agentFollowups[0].kind, 'deep-verification');
  assert.equal(historyBeforeGateway.agentFollowups[0].markerProcessingStatus, 'scheduled');
  assert.match(historyBeforeGateway.agentFollowups[0].text, /verified in MyApprovals/);
  assert.ok(events.some(ev => ev.type === 'job.progress' && ev.payload.statusText === 'Checking MyApprovals...'));

  await new Promise(resolve => setImmediate(resolve));
  assert.equal(gatewayCalls, 1);
  releaseGateway();
  const markerResult = await result.markerApplyPromise;
  assert.equal(markerResult.ok, true);
  const savedAfterGateway = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const historyAfterGateway = savedAfterGateway.tasks[0].history[0];
  assert.equal(historyAfterGateway.agentExecution.deepVerification.markerProcessingStatus, 'completed');
  assert.equal(historyAfterGateway.agentFollowups[0].markersHeld, 0);
});

test('TWOTIER stage 2 hard cap posts partial result with open verification items', async () => {
  const dir = resetTmp('stage2-cap-partial');
  const conversationId = 'conv-cap-1';
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'task-cap',
      taskType: 'single',
      title: 'Cap task',
      status: 'new',
      sourceRefs: [],
      history: [{
        timestamp: '2026-07-07T08:00:00.000Z',
        conversationId,
        type: 'update',
        text: 'Check approval and inbox status.',
        agentResponse: 'State says unknown from project state (last verified unknown).\nDeep verification against MyApprovals started — I will update this conversation.',
        agentExecution: {
          confidence: 'medium',
          answer: 'State says unknown.',
          method: 'agency-task-chat-fast-v1',
          deepVerification: {
            required: true,
            status: 'running',
            system: 'MyApprovals',
            question: 'Check approval and inbox status.',
            verifyExactly: ['Check approval 123 in MyApprovals', 'Scan inbox for the latest status mail'],
            conversationId,
            startedAt: '2026-07-07T08:00:00.000Z'
          }
        }
      }]
    }]
  });

  const result = await runTaskChatDeepVerifyOnce({
    id: 'job-cap',
    taskId: 'task-cap',
    input: {
      text: 'Check approval and inbox status.',
      conversationId,
      stageOneAnswer: 'State says unknown.',
      deepVerification: {
        required: true,
        system: 'MyApprovals',
        question: 'Check approval and inbox status.',
        verifyExactly: ['Check approval 123 in MyApprovals', 'Scan inbox for the latest status mail']
      }
    },
    emit() {}
  }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'deep-cap-run',
    now: new Date('2026-07-07T08:10:00.000Z'),
    _runBrain: async (options) => {
      options.onToolExecution?.({
        type: 'tool.execution_start',
        data: { toolName: 'workiq.search', serverName: 'WorkIQ' }
      }, { workIqCalls: 6 });
      return {
        ok: false,
        timedOut: true,
        salvaged: false,
        assistantText: 'Approval 123 was checked but no final status was returned before the cap.',
        error: { message: 'Agency brain run timed out' },
        counters: { workIqCalls: 6 }
      };
    },
    _runGateway: async () => {
      throw new Error('gateway should not run without markers');
    },
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });

  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const history = saved.tasks[0].history[0];
  const followup = history.agentFollowups[0];

  assert.equal(result.brain.timedOut, true);
  assert.equal(result.markerApplication.status, 'skipped');
  assert.equal(history.agentExecution.deepVerification.status, 'partial');
  assert.equal(history.agentExecution.deepVerification.completedAt, '2026-07-07T08:10:00.000Z');
  assert.equal(followup.status, 'partial');
  assert.equal(followup.confidence, 'low');
  assert.match(followup.text, /10-minute hard cap/);
  assert.match(followup.text, /Checked during this run: Checking MyApprovals/);
  assert.match(followup.text, /Still open: Check approval 123 in MyApprovals; Scan inbox for the latest status mail/);
});

test('TWOTIER server auto-queues deep verification as a non-blocking background job', () => {
  const source = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
  assert.match(source, /runTaskChatFastOnce\(job/);
  assert.match(source, /queueDeepVerificationJob\(job, result\)/);
  assert.match(source, /kind:\s*'deep_verify'/);
  assert.match(source, /blocksTask:\s*false/);
  assert.match(source, /runTaskChatDeepVerifyOnce\(job/);
});

test('TWOTIER UI renders deep verification status without composer blocking', () => {
  const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');
  assert.match(html, /Deep verification running/);
  assert.match(html, /agentFollowups/);
  assert.match(html, /deep-verify-status/);
  assert.match(html, /ev\.kind !== 'deep_verify'/);
  assert.match(html, /payload\.blocksTask === false/);
});
