import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgencyArgs } from '../../brain/agency-cli.js';
import { buildGatewayPrompt, filterMarkersThroughGateway } from '../../brain/reality-gateway.js';
import { runTaskChatFastOnce } from '../../brain/task-chat.js';
import { runBrainScanOnce } from '../../brain/scan-brain.js';
import { evaluateProcessingQualityGate } from '../../brain/processing-ledger.js';
import { migrateToV5, writeJsonFileAtomic } from '../../brain/tasks-v5.js';
import { runReverifyTasks } from '../../scripts/reverify-tasks.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-batch9');

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

function approveAll(markers) {
  return {
    ok: true,
    text: markers.map((_, markerIndex) => `GATEWAY_DECISION\t${markerIndex}\tapprove\tApproved in fixture.`).join('\n'),
    counters: { workIqCalls: 0 }
  };
}

function writeFixture(dir, data) {
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, `${JSON.stringify(migrateToV5(data), null, 2)}\n`, 'utf8');
  return file;
}

function stateJsonFile(brainWorkDir, prefix) {
  const file = fs.readdirSync(brainWorkDir).find(name => name.startsWith(prefix) && name.endsWith('.json'));
  assert.ok(file, `missing ${prefix} state file`);
  return path.join(brainWorkDir, file);
}

test('Batch 9 default agency args are uncaged while Stage 1 none mode stays MCP-free', () => {
  const defaultArgs = buildAgencyArgs({
    bootstrap: 'prompt',
    callerArgs: ['--no-default-mcps', '--disable-mcp-server', 'workiq', '--disable-mcp-server=mail']
  });

  assert.equal(defaultArgs.includes('--no-default-mcps'), false);
  assert.equal(defaultArgs.includes('--disable-mcp-server'), false);
  assert.equal(defaultArgs.includes('--disable-mcp-server=mail'), false);
  assert.equal(defaultArgs.includes('--disable-builtin-mcps'), false);
  assert.equal(defaultArgs.includes('--allow-all-tools'), true);

  const stageOneArgs = buildAgencyArgs({ bootstrap: 'prompt', mcpMode: 'none' });
  assert.equal(stageOneArgs.includes('--no-config-plugins'), true);
  assert.equal(stageOneArgs.includes('--disable-builtin-mcps'), true);
  assert.equal(stageOneArgs.includes('--disable-mcp-server'), false);
});

test('Batch 9 task chat state injects pmStatus, lineItems, processing cursor, fact sheet, and learnings', async () => {
  const dir = resetTmp('task-chat-state');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'proj-b9-chat',
      taskType: 'project',
      title: 'Batch 9 chat project',
      status: 'new',
      sourceRefs: [{ id: 'src-b9', date: '2026-07-06T08:00:00.000Z', link: 'https://example.test/b9' }],
      pmStatus: {
        current: 'Known current state.',
        planned: [],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      lineItems: [{
        id: 'li-b9',
        title: 'Attachment-backed update',
        status: 'open',
        currentState: 'Waiting for source document.',
        state: 'confirmed',
        evidenceRefIds: ['src-b9']
      }],
      processing: {
        cursorDate: '2026-07-06T00:00:00.000Z',
        lookbackDays: 14,
        threads: { 'conv-b9': { lastProcessedMessageDate: '2026-07-06T08:00:00.000Z' } },
        ledger: []
      },
      factSheet: {
        sections: {
          status: [{ id: 'fs-b9-status', text: 'Known current state.', evidenceRefIds: ['src-b9'] }]
        }
      },
      history: []
    }]
  });
  const brainWorkDir = path.join(dir, 'brain-work');
  let capturedPrompt = '';

  await runTaskChatFastOnce({
    id: 'job-b9-fast',
    taskId: 'proj-b9-chat',
    input: { text: 'Any updates?' },
    emit() {}
  }, {
    tasksFile,
    brainWorkDir,
    runId: 'b9-fast',
    now: new Date('2026-07-07T08:00:00.000Z'),
    _runBrain: async ({ prompt }) => {
      capturedPrompt = prompt;
      return {
        ok: true,
        assistantText: [
          'Known current state from project state, last verified 2026-07-06T08:00:00.000Z.',
          'DEEP_VERIFY {"required":false}'
        ].join('\n'),
        counters: { workIqCalls: 0 }
      };
    },
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });

  const state = JSON.parse(fs.readFileSync(stateJsonFile(brainWorkDir, 'task-chat-state-'), 'utf8'));
  assert.equal(state.task.pmStatus.current, 'Known current state.');
  assert.equal(state.task.lineItems[0].state, 'confirmed');
  assert.equal(state.task.processing.cursorDate, '2026-07-06T00:00:00.000Z');
  assert.match(state.task.factSheetFile, /^task-factsheet-/);
  assert.match(capturedPrompt, /## Brain Learnings/);
});

test('Batch 9 scan skill, gateway, and learnings require attachment evidence and document write guardrail', () => {
  const skill = fs.readFileSync(path.join(repoRoot, 'docs', 'AGENCY_BRAIN_SCAN_SKILL.md'), 'utf8');
  const learnings = fs.readFileSync(path.join(repoRoot, 'brain-learnings.md'), 'utf8');
  const gateway = buildGatewayPrompt({
    stateFile: path.join(repoRoot, 'tests', 'unit', 'batch9-state.md'),
    factSheetFiles: ['factsheet-b9.md'],
    markers: [],
    runId: 'b9-gateway'
  });

  assert.match(skill, /Discovery is the default/);
  assert.match(skill, /PDF, DOCX, XLSX/);
  assert.match(skill, /External Write Guardrail/);
  assert.match(skill, /warning at 40 tool starts/);
  assert.match(skill, /150 tool starts/);
  assert.match(learnings, /attachments-are-source-evidence/);
  assert.match(gateway, /available evidence used instead of ignored/);
  assert.match(gateway, /PDF, DOCX, XLSX/);
  assert.match(gateway, /External write actions are forbidden/);
});

test('Batch 9 attachment ledger gate requires handled disposition and blocks unhandled attachments', () => {
  const missing = [markerObj('PROJECT_UPDATE', {
    taskId: 'proj-b9',
    processingLedger: [{
      itemRef: { type: 'email', id: 'msg-attachment' },
      threadRef: 'conv-attachment',
      date: '2026-07-06T18:45:00.000Z',
      disposition: 'updates-node',
      nodeRefs: ['li-b9'],
      quote: 'The message says a deck was prepared.',
      reason: 'The item may update the project.'
    }]
  })];
  const filtered = filterMarkersThroughGateway(missing, approveAll(missing));
  assert.equal(filtered.held.length, 1);
  assert.match(filtered.held[0].reason, /attachmentsHandled/);

  const unhandled = [
    markerObj('PROJECT_UPDATE', {
      taskId: 'proj-b9',
      processingLedger: [{
        itemRef: { type: 'email', id: 'msg-attachment' },
        threadRef: 'conv-attachment',
        date: '2026-07-06T18:45:00.000Z',
        disposition: 'updates-node',
        nodeRefs: ['li-b9'],
        attachmentsHandled: 'none',
        quote: 'The message says a deck was prepared.',
        reason: 'The item may update the project.'
      }]
    }),
    markerObj('SCAN_DONE', {
      runId: 'attachment-gate',
      outcome: 'success',
      processingQuality: {
        required: true,
        enumeratedItems: [{
          itemRef: { type: 'email', id: 'msg-attachment' },
          threadRef: 'conv-attachment',
          hasAttachments: true
        }],
        threadCounts: [{ threadRef: 'conv-attachment', count: 1 }]
      }
    })
  ];
  const unhandledGate = evaluateProcessingQualityGate(unhandled);
  assert.equal(unhandledGate.ok, false);
  assert.match(unhandledGate.reason, /attachmentsHandled/);

  const handled = structuredClone(unhandled);
  handled[0].payload.processingLedger[0].attachmentsHandled = 'yes';
  const handledGate = evaluateProcessingQualityGate(handled);
  assert.equal(handledGate.ok, true);

  const failedWithReason = structuredClone(unhandled);
  failedWithReason[0].payload.processingLedger[0].attachmentsHandled = 'failed(encrypted PDF)';
  const failedGate = evaluateProcessingQualityGate(failedWithReason);
  assert.equal(failedGate.ok, true);
});

test('Batch 9 temporal pass blocks stale unconfirmed planned and line item dates before apply', async () => {
  const dir = resetTmp('temporal-pass-block');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'proj-b9-temporal',
      taskType: 'project',
      title: 'Temporal project',
      status: 'new',
      sourceRefs: [{ id: 'src-old', type: 'email', title: 'Old target', date: '2026-06-20T08:00:00.000Z', link: 'https://example.test/old' }],
      pmStatus: {
        current: 'Current state',
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
        waitingOn: [],
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
      }]
    }]
  });

  const output = marker('SCAN_DONE', {
    runId: 'temporal-pass-block',
    outcome: 'success',
    workIqCalls: 0
  });
  const result = await runBrainScanOnce({ input: {}, emit() {} }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'temporal-pass-block',
    now: new Date('2026-07-07T08:00:00.000Z'),
    _runBrain: async () => ({ ok: true, assistantText: output, counters: { workIqCalls: 0 } }),
    _runGateway: async ({ markers }) => approveAll(markers),
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(result.outcome, 'partial');
  assert.equal(result.temporalGate.ok, false);
  assert.equal(saved.tasks[0].pmStatus.planned[0].state, 'unconfirmed');
  assert.match(saved.reviewQueue[0].question, /temporal pass gate/);
});

test('Batch 9 temporal pass allows explicit obsolete stale-node cleanup with evidence', async () => {
  const dir = resetTmp('temporal-pass-cleanup');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'proj-b9-temporal',
      taskType: 'project',
      title: 'Temporal project',
      status: 'new',
      sourceRefs: [{ id: 'src-old', type: 'email', title: 'Old target', date: '2026-06-20T08:00:00.000Z', link: 'https://example.test/old' }],
      pmStatus: {
        current: 'Current state',
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
        waitingOn: [],
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
      }]
    }]
  });

  const sourceRef = {
    id: 'src-fresh-temporal',
    type: 'email',
    title: 'Current verification',
    date: '2026-07-07T07:30:00.000Z',
    link: 'https://example.test/fresh',
    evidenceText: 'Current scan found no evidence that the 1 Jul AV go-live remains valid.'
  };
  const output = [
    marker('PROJECT_UPDATE', {
      taskId: 'proj-b9-temporal',
      sourceRefs: [sourceRef],
      pmStatus: {
        current: 'Current state',
        planned: [{
          id: 'plan-av-go-live',
          text: 'AV Go-Live target 1 Jul 2026 for commissioned rooms',
          date: '2026-07-01',
          evidenceRefIds: ['src-fresh-temporal'],
          confidence: 'medium',
          state: 'obsolete',
          obsoleteReason: 'The planned date is before the current scan date and no fresh evidence confirms it remains valid.'
        }],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      evidenceRefIds: ['src-fresh-temporal']
    }),
    marker('LINEITEM_UPDATE', {
      taskId: 'proj-b9-temporal',
      lineItemId: 'li-see-av-commissioning',
      patch: {
        state: 'obsolete',
        currentState: 'The old 1 Jul 2026 AV go-live target is obsolete pending fresh schedule evidence.',
        obsoleteReason: 'The date has passed and the scan did not find fresh confirmation.',
        confidence: 'medium'
      },
      evidenceRefIds: ['src-fresh-temporal']
    }),
    marker('SCAN_DONE', {
      runId: 'temporal-pass-cleanup',
      outcome: 'success',
      workIqCalls: 1
    })
  ].join('\n');

  const result = await runBrainScanOnce({ input: {}, emit() {} }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'temporal-pass-cleanup',
    now: new Date('2026-07-07T08:00:00.000Z'),
    _runBrain: async () => ({ ok: true, assistantText: output, counters: { workIqCalls: 1 } }),
    _runGateway: async ({ markers }) => approveAll(markers),
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(result.outcome, 'success');
  assert.equal(result.temporalGate.ok, true);
  assert.equal(saved.tasks[0].pmStatus.planned[0].state, 'obsolete');
  assert.equal(saved.tasks[0].lineItems[0].state, 'obsolete');
});

test('Batch 9 reverify sweep state injects processing, brainState, fact sheet files, and learnings', async () => {
  const dir = resetTmp('reverify-state');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'proj-b9-sweep',
      taskType: 'project',
      title: 'Batch 9 sweep project',
      status: 'new',
      sourceRefs: [{ id: 'src-b9-sweep', date: '2026-07-06T08:00:00.000Z' }],
      pmStatus: {
        current: 'Sweep current state.',
        planned: [],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      lineItems: [{ id: 'li-sweep', title: 'Sweep line', state: 'confirmed', evidenceRefIds: ['src-b9-sweep'] }],
      processing: {
        cursorDate: '2026-07-05T00:00:00.000Z',
        lookbackDays: 14,
        threads: {},
        ledger: []
      },
      brainState: { needsReview: true, reviewReason: 'Fixture review reason.' },
      history: []
    }]
  });
  const brainWorkDir = path.join(dir, 'brain-work');
  let capturedPrompt = '';

  await runReverifyTasks({
    tasksFile,
    brainWorkDir,
    runId: 'b9-reverify',
    apply: false,
    _runBrain: async ({ prompt }) => {
      capturedPrompt = prompt;
      return {
        ok: true,
        assistantText: '[SCAN_DONE] {"runId":"b9-reverify","outcome":"success","workIqCalls":0}',
        counters: { workIqCalls: 0 }
      };
    },
    _runGateway: async ({ markers }) => ({
      ok: true,
      text: markers.map((_, index) => `GATEWAY_DECISION\t${index}\tapprove\tApproved in fixture.`).join('\n'),
      counters: { workIqCalls: 0 }
    })
  });

  const state = JSON.parse(fs.readFileSync(stateJsonFile(brainWorkDir, 'reverify-state-'), 'utf8'));
  assert.equal(state.tasks[0].processing.cursorDate, '2026-07-05T00:00:00.000Z');
  assert.equal(state.tasks[0].brainState.needsReview, true);
  assert.match(state.tasks[0].factSheetFile, /^reverify-factsheet-/);
  assert.match(capturedPrompt, /## Brain Learnings/);
});
