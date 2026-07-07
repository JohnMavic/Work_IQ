import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMarkerBatch } from '../../brain/marker-applier.js';
import { parseMarkers } from '../../brain/marker-parser.js';
import { buildGatewayPrompt, filterMarkersThroughGateway } from '../../brain/reality-gateway.js';
import { renderScanState } from '../../brain/render-scan-state.js';
import { buildTaskChatPrompt, runTaskChatOnce } from '../../brain/task-chat.js';
import { appendBrainLearning, renderBrainLearningsBlock } from '../../brain/learnings.js';
import { migrateToV5, writeJsonFileAtomic } from '../../brain/tasks-v5.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-batch8');

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

function writeFixture(dir, data) {
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, `${JSON.stringify(migrateToV5(data), null, 2)}\n`, 'utf8');
  return file;
}

test('Batch 8 renderer injects brain learnings and trims oldest entries within budget', () => {
  const dir = resetTmp('renderer-learnings');
  const learningsFile = path.join(dir, 'brain-learnings.md');
  fs.writeFileSync(learningsFile, [
    '# Agent Zero Brain Learnings',
    '',
    'Preamble stays.',
    '',
    '## 2026-07-01 principle: oldest',
    'Category: principle',
    `Text: oldest ${'x'.repeat(900)}`,
    '',
    '## 2026-07-02 pattern: newest',
    'Category: pattern',
    'Text: newest system-of-record pattern'
  ].join('\n'), 'utf8');

  const block = renderBrainLearningsBlock({ filePath: learningsFile, maxBytes: 420 });
  assert.equal(block.truncated, true);
  assert.match(block.markdown, /oldest entries were omitted/i);
  assert.doesNotMatch(block.markdown, /oldest x/);
  assert.match(block.markdown, /newest system-of-record pattern/);

  const state = renderScanState({
    version: 5,
    tasks: [{ id: 'task-b8', title: 'Task B8', status: 'new' }]
  }, {
    writeFiles: false,
    runId: 'batch8-render',
    learningsFile,
    learningsMaxBytes: 420
  });

  assert.match(state.markdown, /## Brain Learnings/);
  assert.match(state.markdown, /newest system-of-record pattern/);
  assert.equal(state.learningsTruncated, true);
});

test('Batch 8 LEARNING marker appends only validated general learnings', () => {
  const dir = resetTmp('learning-marker');
  const learningFile = path.join(dir, 'brain-learnings.md');
  fs.writeFileSync(learningFile, '# Agent Zero Brain Learnings\n', 'utf8');
  const data = migrateToV5({ version: 5, tasks: [] });

  const { markers } = parseMarkers([
    marker('LEARNING', {
      text: 'For approval questions, check the authoritative portal before asserting state.',
      category: 'principle',
      evidence: 'Batch 8 unit test'
    }),
    marker('LEARNING', {
      text: 'task-1234 is approved now.',
      category: 'fact',
      evidence: 'Bad task-specific memory'
    })
  ].join('\n'));

  const result = applyMarkerBatch(data, markers, {
    auditLogFile: null,
    learningFile,
    now: new Date('2026-07-07T08:00:00.000Z')
  });
  const text = fs.readFileSync(learningFile, 'utf8');

  assert.equal(result.applied, 1);
  assert.equal(result.dropped.length, 1);
  assert.match(result.dropped[0].reason, /general knowledge/);
  assert.match(text, /authoritative portal/);
  assert.doesNotMatch(text, /task-1234/);
});

test('Batch 8 gateway holds invalid LEARNING markers even if the model approves them', () => {
  const markers = [markerObj('LEARNING', {
    text: 'api_key=abc123 should be used for portal checks.',
    category: 'pattern',
    evidence: 'Bad secret'
  })];
  const filtered = filterMarkersThroughGateway(markers, {
    ok: true,
    text: 'GATEWAY_DECISION\t0\tapprove\tApproved in fixture.'
  });

  assert.equal(filtered.approved.length, 0);
  assert.equal(filtered.held.length, 1);
  assert.match(filtered.held[0].reason, /secrets or credentials/);
});

test('Batch 8 prompts include truth hierarchy, learnings, and embedded chat grammar', () => {
  const skill = fs.readFileSync(path.join(repoRoot, 'docs', 'AGENCY_BRAIN_SCAN_SKILL.md'), 'utf8');
  assert.match(skill, /Systems of Record live-checked/);
  assert.match(skill, /unverified via system of record/);
  assert.match(skill, /verified in <system>/);
  assert.match(skill, /signal only — unverified/);
  assert.match(skill, /verified facts first/);
  assert.match(skill, /verify first in the System of Record/);
  assert.match(skill, /\[LEARNING\]/);

  const learningsBlock = [
    '## Brain Learnings',
    '',
    'Text: system-of-record seed'
  ].join('\n');
  const chatPrompt = buildTaskChatPrompt({
    stateFileName: 'task-chat-state.json',
    factSheetFiles: ['task-factsheet.md'],
    userPrompt: 'Is this approval still open?',
    attachments: [],
    taskId: 'task-chat',
    runId: 'run-chat',
    learningsBlock
  });
  assert.match(chatPrompt, /Systems of Record live-checked/);
  assert.match(chatPrompt, /verified in <system>/);
  assert.match(chatPrompt, /signal only — unverified/);
  assert.match(chatPrompt, /Put verified facts first/);
  assert.match(chatPrompt, /verify first in the System of Record/);
  assert.match(chatPrompt, /Do not read docs\/AGENCY_BRAIN_SCAN_SKILL\.md/);
  assert.match(chatPrompt, /\[LEARNING\]/);
  assert.match(chatPrompt, /system-of-record seed/);

  const gatewayPrompt = buildGatewayPrompt({
    stateFile: path.join(repoRoot, 'tests', 'unit', 'missing-ok-state.md'),
    markers: [],
    runId: 'gateway-b8',
    learningsBlock
  });
  assert.match(gatewayPrompt, /system-of-record seed/);
  assert.match(gatewayPrompt, /For LEARNING markers/);
});

test('Batch 8B brain learnings include MyApprovals object-class distinction', () => {
  const learnings = fs.readFileSync(path.join(repoRoot, 'brain-learnings.md'), 'utf8');

  assert.match(learnings, /MyApprovals hosts two object classes/);
  assert.match(learnings, /MyOrder PO approvals \(PO numbers\)/);
  assert.match(learnings, /Modern Invoice approvals \(GUID request ids\)/);
  assert.match(learnings, /does NOT cover invoice approvals/);
  assert.match(learnings, /never infer invoice approval state from PO bookkeeping/);
});

test('Batch 8 task chat stores concrete confidence instead of unknown', async () => {
  const dir = resetTmp('chat-confidence');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'task-chat-confidence',
      taskType: 'single',
      title: 'Task chat confidence',
      status: 'new',
      sourceRefs: [],
      history: []
    }]
  });

  const result = await runTaskChatOnce({
    id: 'job-b8-chat',
    taskId: 'task-chat-confidence',
    input: { text: 'What is this?' },
    emit() {}
  }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'chat-confidence',
    _runBrain: async () => ({
      ok: true,
      assistantText: 'This is a task-scoped answer.',
      counters: { workIqCalls: 0 }
    }),
    _runGateway: async () => {
      throw new Error('gateway should not run for pure answers');
    },
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const history = saved.tasks[0].history.at(-1);

  assert.equal(result.confidence, 'medium');
  assert.equal(history.agentPlan.confidence, 'medium');
  assert.equal(history.agentExecution.confidence, 'medium');
});

test('Batch 8 appendBrainLearning deduplicates exact text', () => {
  const dir = resetTmp('dedupe-learning');
  const learningFile = path.join(dir, 'brain-learnings.md');
  fs.writeFileSync(learningFile, '# Agent Zero Brain Learnings\n', 'utf8');
  const payload = {
    text: 'Treat notification mail as a signal, not the source of truth.',
    category: 'principle',
    evidence: 'Unit test'
  };

  const first = appendBrainLearning(payload, { filePath: learningFile, now: new Date('2026-07-07T08:00:00.000Z') });
  const second = appendBrainLearning(payload, { filePath: learningFile, now: new Date('2026-07-07T09:00:00.000Z') });
  const text = fs.readFileSync(learningFile, 'utf8');

  assert.equal(first.appended, true);
  assert.equal(second.duplicate, true);
  assert.equal((text.match(/Treat notification mail/g) || []).length, 1);
});
