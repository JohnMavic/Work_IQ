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
  assert.equal(captured.toolCallHardLimit, DEFAULT_TASK_CHAT_FAST_WORKIQ_LIMIT);
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

  assert.equal(DEFAULT_TASK_CHAT_DEEP_TARGET_MS, 25 * 60 * 1000);
  assert.equal(captured.timeoutMs, DEFAULT_TASK_CHAT_DEEP_TIMEOUT_MS);
  assert.equal(DEFAULT_TASK_CHAT_DEEP_WORKIQ_LIMIT, 150);
  assert.equal(Object.hasOwn(captured, 'workIqHardLimit'), false);
  assert.equal(captured.runClass, BRAIN_RUN_CLASS.BACKGROUND);
  assert.equal(captured.mcpMode, 'default');
  assert.match(captured.prompt, /Portal\/CDP\/browser\/shell patterns/);
  assert.match(captured.prompt, /Verify exactly:\n1\. Check approval 123 in MyApprovals\n2\. Confirm whether the approval is still pending/);
  assert.match(captured.prompt, /priority hint, not a limit/);
  assert.match(captured.prompt, /Mandatory M365 workflow/);
  assert.match(captured.prompt, /list all attachments of this thread with filenames/);
  assert.match(captured.prompt, /every enumerated mail\/Teams item and every enumerated attachment filename must have a matching ledger disposition/);
  assert.match(captured.prompt, /only then answer or emit markers/);
  assert.match(captured.prompt, /PDF, DOCX, XLSX/);
  assert.match(captured.prompt, /After attachment content capture, explicitly list all dates, milestones, scope items, quantities, port counts, and names/);
  assert.match(captured.prompt, /Temporal pass is mandatory/);
  assert.match(captured.prompt, /target date passed without completion evidence — needs re-plan/);
  assert.match(captured.prompt, /Use retain for review only when evidence is genuinely contradictory/);
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

test('BATCH9E chat deep attachment gate holds M365 updates when attachment handling is missing', async () => {
  const dir = resetTmp('batch9e-chat-attachment-gate');
  const conversationId = 'conv-b9e-attach';
  const tasksFile = writeFixture(dir, {
    version: 5,
    reviewQueue: [],
    tasks: [{
      id: 'proj-chat-attachment',
      taskType: 'project',
      title: 'Attachment project',
      status: 'new',
      sourceRefs: [{ id: 'src-existing', type: 'email', title: 'Existing source', date: '2026-07-06T08:00:00.000Z' }],
      processing: { cursorDate: '2026-07-06T00:00:00.000Z', lookbackDays: 14, threads: {}, ledger: [] },
      pmStatus: {
        current: 'Original PM state.',
        planned: [],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      history: [{
        timestamp: '2026-07-08T08:00:00.000Z',
        conversationId,
        type: 'update',
        text: 'Search the inbox for updates.',
        agentResponse: 'Original state from project state, last verified 2026-07-06T08:00:00.000Z.\nDeep verification against Microsoft 365 started — I will update this conversation.',
        agentExecution: {
          confidence: 'medium',
          method: 'agency-task-chat-fast-v1',
          deepVerification: {
            required: true,
            status: 'running',
            system: 'Microsoft 365',
            question: 'Search the inbox for updates.',
            verifyExactly: ['Search Outlook for updates and inspect attachments'],
            conversationId,
            startedAt: '2026-07-08T08:00:00.000Z'
          }
        }
      }]
    }]
  });

  const output = [
    'Deep verification found an update, but the deck was not read.',
    marker('PROJECT_UPDATE', {
      taskId: 'proj-chat-attachment',
      sourceRefs: [{
        id: 'src-attach-mail',
        type: 'email',
        title: 'Message with attached deck',
        date: '2026-07-08T08:30:00.000Z',
        link: 'https://outlook.office.com/mail/id/msg-attach',
        evidenceText: 'The message body references an attached deck.'
      }],
      pmStatus: {
        current: 'Updated from unread attached deck.',
        planned: [],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      processingLedger: [{
        itemRef: { type: 'email', id: 'msg-attach' },
        threadRef: 'thread-attach',
        date: '2026-07-08T08:30:00.000Z',
        disposition: 'updates-node',
        nodeRefs: ['pmStatus'],
        attachmentsHandled: 'none',
        quote: 'Please see the attached deck.',
        reason: 'The message body points to the deck but no attachment query was made.'
      }],
      evidenceRefIds: ['src-attach-mail']
    }),
    marker('SCAN_DONE', {
      runId: 'b9e-chat-attachment',
      outcome: 'success',
      workIqCalls: 1,
      processingQuality: {
        required: true,
        enumeratedItems: [{
          itemRef: { type: 'email', id: 'msg-attach' },
          threadRef: 'thread-attach',
          hasAttachments: true,
          attachmentCount: 1
        }],
        threadCounts: [{ threadRef: 'thread-attach', count: 1 }]
      }
    })
  ].join('\n');

  const result = await runTaskChatDeepVerifyOnce({
    id: 'job-b9e-attach',
    taskId: 'proj-chat-attachment',
    input: {
      text: 'Search the inbox for updates.',
      conversationId,
      stageOneAnswer: 'Original state.',
      deepVerification: {
        required: true,
        system: 'Microsoft 365',
        question: 'Search the inbox for updates.',
        verifyExactly: ['Search Outlook for updates and inspect attachments']
      }
    },
    emit() {}
  }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'b9e-chat-attachment',
    now: new Date('2026-07-08T08:45:00.000Z'),
    _runBrain: async () => ({ ok: true, assistantText: output, counters: { workIqCalls: 1 } }),
    _runGateway: async (options) => approveAllGateway(options),
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });

  const markerResult = await result.markerApplyPromise;
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const task = saved.tasks[0];
  const followup = task.history[0].agentFollowups[0];

  assert.equal(markerResult.ok, false);
  assert.match(markerResult.qualityGate.reason, /attachmentsHandled/);
  assert.equal(task.pmStatus.current, 'Original PM state.');
  assert.equal(task.processing.ledger.length, 0);
  assert.match(saved.reviewQueue[0].question, /processing-ledger quality gate/);
  assert.equal(followup.markerProcessingStatus, 'partial');
  assert.equal(followup.markersApplied, 1);
  assert.equal(followup.markersHeld, 1);
});

test('BATCH9G chat deep temporal gate applies valid markers and queues stale reviews', async () => {
  const dir = resetTmp('batch9g-chat-temporal-granular');
  const conversationId = 'conv-b9e-temporal';
  const tasksFile = writeFixture(dir, {
    version: 5,
    reviewQueue: [],
    tasks: [{
      id: 'proj-chat-temporal',
      taskType: 'project',
      title: 'Temporal chat project',
      status: 'new',
      sourceRefs: [{ id: 'src-old', type: 'email', title: 'Old AV target', date: '2026-06-20T08:00:00.000Z' }],
      processing: { cursorDate: '2026-07-06T00:00:00.000Z', lookbackDays: 14, threads: {}, ledger: [] },
      pmStatus: {
        current: 'Original current state.',
        planned: [{
          id: 'plan-av-go-live',
          text: 'AV Go-Live target 1 Jul 2026 for commissioned rooms',
          date: '2026-07-01',
          evidenceRefIds: ['src-old'],
          confidence: 'medium',
          state: 'unconfirmed'
        }],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [{
          id: 'wait-av-signoff',
          text: 'Waiting for AV sign-off by 1 Jul 2026.',
          date: '2026-07-01',
          evidenceRefIds: ['src-old'],
          confidence: 'medium',
          state: 'unconfirmed'
        }],
        confidence: 'medium'
      },
      lineItems: [{
        id: 'li-see-av-commissioning',
        title: 'AV commissioning',
        category: 'workstream',
        status: 'open',
        currentState: 'AV sign-off requested toward a 1 Jul 2026 go-live.',
        evidenceRefIds: ['src-old'],
        state: 'unconfirmed'
      }],
      history: [{
        timestamp: '2026-07-08T09:00:00.000Z',
        conversationId,
        type: 'update',
        text: 'Search the inbox for updates.',
        agentResponse: 'Original state from project state, last verified 2026-06-20T08:00:00.000Z.\nDeep verification against Microsoft 365 started — I will update this conversation.',
        agentExecution: {
          confidence: 'medium',
          method: 'agency-task-chat-fast-v1',
          deepVerification: {
            required: true,
            status: 'running',
            system: 'Microsoft 365',
            question: 'Search the inbox for updates.',
            verifyExactly: ['Search Outlook for updates'],
            conversationId,
            startedAt: '2026-07-08T09:00:00.000Z'
          }
        }
      }]
    }]
  });

  const output = [
    'Deep verification found a new mail but did not reconcile the stale AV date.',
    marker('PROJECT_UPDATE', {
      taskId: 'proj-chat-temporal',
      sourceRefs: [{
        id: 'src-fresh-mail',
        type: 'email',
        title: 'Fresh update',
        date: '2026-07-08T09:15:00.000Z',
        link: 'https://outlook.office.com/mail/id/msg-fresh',
        evidenceText: 'A fresh message was surfaced.'
      }],
      pmStatus: {
        current: 'Fresh mail surfaced.',
        planned: [],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      processingLedger: [{
        itemRef: { type: 'email', id: 'msg-fresh' },
        threadRef: 'thread-fresh',
        date: '2026-07-08T09:15:00.000Z',
        disposition: 'updates-node',
        nodeRefs: ['pmStatus'],
        attachmentsHandled: 'none',
        quote: 'Here is the latest update.',
        reason: 'The message updates the project current state.'
      }],
      evidenceRefIds: ['src-fresh-mail']
    }),
    marker('SCAN_DONE', {
      runId: 'b9e-chat-temporal',
      outcome: 'success',
      workIqCalls: 1,
      processingQuality: {
        required: true,
        enumeratedItems: [{
          itemRef: { type: 'email', id: 'msg-fresh' },
          threadRef: 'thread-fresh',
          hasAttachments: false
        }],
        threadCounts: [{ threadRef: 'thread-fresh', count: 1 }]
      }
    })
  ].join('\n');

  const events = [];
  const result = await runTaskChatDeepVerifyOnce({
    id: 'job-b9e-temporal',
    taskId: 'proj-chat-temporal',
    input: {
      text: 'Search the inbox for updates.',
      conversationId,
      stageOneAnswer: 'Original state.',
      deepVerification: {
        required: true,
        system: 'Microsoft 365',
        question: 'Search the inbox for updates.',
        verifyExactly: ['Search Outlook for updates']
      }
    },
    emit(type, payload) {
      events.push({ type, payload });
    }
  }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'b9e-chat-temporal',
    now: new Date('2026-07-08T09:30:00.000Z'),
    _runBrain: async () => ({ ok: true, assistantText: output, counters: { workIqCalls: 1 } }),
    _runGateway: async (options) => approveAllGateway(options),
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });

  const markerResult = await result.markerApplyPromise;
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const task = saved.tasks[0];
  const followup = task.history[0].agentFollowups[0];

  assert.equal(markerResult.ok, false);
  assert.match(markerResult.temporalGate.reason, /temporal pass missing/);
  assert.equal(markerResult.temporalGate.reviewReasons.length, 3);
  assert.equal(markerResult.temporalGate.held.length, 0);
  assert.equal(markerResult.applyResult.applied, 2);
  assert.equal(task.pmStatus.current, 'Fresh mail surfaced.');
  assert.equal(task.pmStatus.planned[0].state, 'unconfirmed');
  assert.equal(task.pmStatus.planned[0].needsReview, true);
  assert.equal(task.pmStatus.waitingOn[0].state, 'unconfirmed');
  assert.equal(task.pmStatus.waitingOn[0].needsReview, true);
  assert.equal(task.lineItems[0].state, 'unconfirmed');
  assert.equal(saved.reviewQueue.length, 3);
  assert.ok(saved.reviewQueue.every(item => /stale date unreconciled:/.test(item.question)));
  assert.equal(followup.markerProcessingStatus, 'partial');
  assert.equal(followup.markersApplied, 2);
  assert.equal(followup.markersHeld, 0);
  assert.equal(followup.gateway.temporalGate.reviewItems, 3);
  assert.equal(followup.gateway.temporalGate.heldMarkers, 0);
  assert.equal(events.some(ev => ev.payload?.phase === 'marker_apply_held'), false);
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
  assert.match(followup.text, /25-minute hard cap/);
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
  assert.match(html, /marker_apply_held/);
});
