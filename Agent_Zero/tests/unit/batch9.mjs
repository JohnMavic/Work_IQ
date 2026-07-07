import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildAgencyArgs } from '../../brain/agency-cli.js';
import { buildGatewayPrompt } from '../../brain/reality-gateway.js';
import { runTaskChatFastOnce } from '../../brain/task-chat.js';
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
