import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_TASK_CHAT_DEEP_TIMEOUT_MS,
  DEFAULT_TASK_CHAT_DEEP_WORKIQ_LIMIT,
  DEFAULT_TASK_CHAT_FAST_TIMEOUT_MS,
  DEFAULT_TASK_CHAT_FAST_WORKIQ_LIMIT,
  extractDeepVerificationFlag,
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
    'DEEP_VERIFY {"required":true,"system":"MyApprovals","reason":"approval state needs source of record","question":"Is it approved?"}'
  ].join('\n'));

  assert.equal(parsed.flag.required, true);
  assert.equal(parsed.flag.system, 'MyApprovals');
  assert.equal(parsed.flag.question, 'Is it approved?');
  assert.doesNotMatch(parsed.text, /DEEP_VERIFY/);
});

test('TWOTIER stage 1 uses fast timeout, max two WorkIQ calls, and never runs gateway', async () => {
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
  assert.equal(captured.mcpMode, 'workiq-only');
  assert.match(captured.prompt, /Do not emit Agent Zero marker lines/);
  assert.match(captured.prompt, /Do not use portal, CDP, browser, shell/);
  assert.equal(saved.tasks[0].status, 'new');
  assert.equal(result.markersHeld, 1);
  assert.equal(result.gateway.skipped, true);
  assert.equal(history.agentExecution.deepVerification.status, 'running');
  assert.equal(history.agentExecution.deepVerification.system, 'MyApprovals');
});

test('TWOTIER stage 2 uses background timeout, allows gateway, and appends to same conversation', async () => {
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

  const result = await runTaskChatDeepVerifyOnce({
    id: 'job-deep',
    taskId: 'task-deep',
    input: {
      text: 'Is this approved?',
      conversationId,
      stageOneAnswer: 'State says pending.',
      deepVerification: { required: true, system: 'MyApprovals', question: 'Is this approved?' }
    },
    emit() {}
  }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'deep-run',
    now: new Date('2026-07-07T08:05:00.000Z'),
    _runBrain: async (options) => {
      Object.assign(captured, options);
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
      return approveAllGateway(options);
    },
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const history = saved.tasks[0].history[0];

  assert.equal(captured.timeoutMs, DEFAULT_TASK_CHAT_DEEP_TIMEOUT_MS);
  assert.equal(captured.workIqHardLimit, DEFAULT_TASK_CHAT_DEEP_WORKIQ_LIMIT);
  assert.equal(captured.runClass, BRAIN_RUN_CLASS.BACKGROUND);
  assert.equal(captured.mcpMode, 'default');
  assert.match(captured.prompt, /Portal\/CDP\/browser\/shell patterns/);
  assert.equal(gatewayCalls, 1);
  assert.equal(result.conversationId, conversationId);
  assert.equal(history.agentExecution.deepVerification.status, 'completed');
  assert.equal(history.agentFollowups.length, 1);
  assert.equal(history.agentFollowups[0].kind, 'deep-verification');
  assert.match(history.agentFollowups[0].text, /verified in MyApprovals/);
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
