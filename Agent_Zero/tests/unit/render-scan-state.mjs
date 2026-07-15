import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderScanState } from '../../brain/render-scan-state.js';
import { migrateToV5 } from '../../brain/tasks-v5.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-render-state');
const promptFile = path.join(repoRoot, 'docs', 'AGENCY_BRAIN_SCAN_SKILL.md');

function makeBrainWorkDir(name) {
  const root = path.join(tmpRoot, name);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  return path.join(root, 'brain-work');
}

function singleTask(id, extra = {}) {
  return {
    id,
    title: `Task ${id}`,
    summary: `Summary for ${id}`,
    status: 'new',
    link: `https://example.test/${id}`,
    history: [],
    ...extra
  };
}

test('renderScanState includes all open project and single tasks', () => {
  const data = migrateToV5({
    version: 5,
    lastScan: '2026-07-05T06:00:00.000Z',
    tasks: [
      {
        ...singleTask('project-1', {
          title: 'Office rollout',
          taskType: 'project',
          projectKey: 'office-rollout',
          sourceRefs: [{ id: 'src-1', date: '2026-07-05T08:00:00.000Z', link: 'https://example.test/src-1' }],
          lineItems: [{ id: 'li-1', title: 'Prepare room', status: 'open', evidenceRefIds: ['src-1'] }]
        })
      },
      singleTask('single-1'),
      singleTask('archived-1', { archived: true, title: 'Archived title' })
    ]
  });

  const result = renderScanState(data, { writeFiles: false, runId: 'test-run' });

  assert.match(result.markdown, /\[project-1\] Office rollout/);
  assert.match(result.markdown, /\[single-1\] Task single-1/);
  assert.match(result.markdown, /Archived\/superseded IDs: archived-1/);
  assert.doesNotMatch(result.markdown, /\[archived-1\] Archived title/);
  assert.deepEqual(result.openTaskIds.sort(), ['project-1', 'single-1']);
  assert.deepEqual(result.archivedTaskIds, ['archived-1']);
});

test('renderScanState shows sourceRef ids for single tasks', () => {
  const data = migrateToV5({
    version: 5,
    tasks: [singleTask('single-with-ref', {
      sourceRefs: [{
        id: 'src-single-1',
        title: 'Single task update',
        date: '2026-07-05T08:00:00.000Z',
        link: 'https://example.test/messages/single-with-ref'
      }]
    })]
  });

  const result = renderScanState(data, { writeFiles: false, runId: 'single-ref-run' });

  assert.match(result.markdown, /sourceRefs: src-single-1/);
  assert.doesNotMatch(result.markdown, /https:\/\/example\.test\/messages\/single-with-ref/);
});

test('renderScanState omits existing sourceRef links while preserving ids and metadata', () => {
  const data = migrateToV5({
    version: 5,
    tasks: [{
      ...singleTask('project-sources', {
        taskType: 'project',
        projectKey: 'project-sources',
        sourceRefs: [{
          id: 'src-existing-1',
          title: 'Existing mail source',
          from: 'alex@example.test',
          date: '2026-07-05T08:00:00.000Z',
          link: 'https://example.test/full/existing/source'
        }],
        lineItems: [{
          id: 'li-existing',
          title: 'Existing line',
          evidenceRefIds: ['src-existing-1']
        }]
      })
    }]
  });

  const result = renderScanState(data, { writeFiles: false, runId: 'no-link-run' });

  assert.match(result.markdown, /src-existing-1/);
  assert.match(result.markdown, /Existing mail source/);
  assert.match(result.markdown, /alex@example\.test/);
  assert.doesNotMatch(result.markdown, /https:\/\/example\.test\/full\/existing\/source/);
});

test('renderScanState stays under budget for a 76-task fixture while keeping every open task id', () => {
  const tasks = [];
  for (let i = 1; i <= 76; i++) {
    tasks.push(singleTask(`task-${String(i).padStart(2, '0')}`, {
      title: `Open task ${i}`,
      summary: `Long operational summary ${i} `.repeat(30)
    }));
  }
  const data = migrateToV5({ version: 5, lastScan: null, tasks });
  const result = renderScanState(data, {
    writeFiles: false,
    runId: 'budget-run',
    maxBytes: 14000
  });

  assert.ok(result.bytes <= 14000, `expected ${result.bytes} <= 14000`);
  for (const task of tasks) {
    assert.match(result.markdown, new RegExp(`\\[${task.id}\\]`));
  }
});

test('renderScanState omits long existing links so a 76-task long-link fixture stays in budget', () => {
  const longTail = 'x'.repeat(260);
  const tasks = [];
  for (let i = 1; i <= 76; i++) {
    tasks.push(singleTask(`task-link-${String(i).padStart(2, '0')}`, {
      title: `Open long-link task ${i}`,
      summary: `Summary ${i}`,
      link: `https://outlook.office.com/mail/inbox/id/${longTail}${i}`
    }));
  }

  const result = renderScanState(migrateToV5({ version: 5, tasks }), {
    writeFiles: false,
    runId: 'long-link-budget-run'
  });

  assert.ok(result.bytes <= result.maxBytes, `expected ${result.bytes} <= ${result.maxBytes}`);
  assert.doesNotMatch(result.markdown, /https:\/\/outlook\.office\.com/);
  assert.doesNotMatch(result.markdown, new RegExp(longTail));
});

test('renderScanState writes state and spill files into a clean brain-work directory', () => {
  const brainWorkDir = makeBrainWorkDir('spills');
  fs.mkdirSync(brainWorkDir, { recursive: true });
  fs.writeFileSync(path.join(brainWorkDir, 'stale.txt'), 'stale', 'utf8');

  const data = migrateToV5({
    version: 5,
    tasks: [singleTask('task-history', {
      history: Array.from({ length: 20 }, (_, i) => ({
        timestamp: `2026-07-05T08:${String(i).padStart(2, '0')}:00.000Z`,
        type: 'note',
        text: `Detailed historical entry ${i} `.repeat(20)
      }))
    })]
  });

  const result = renderScanState(data, {
    brainWorkDir,
    runId: 'spill-run',
    historySpillBytes: 500
  });

  assert.ok(result.stateFile);
  assert.ok(fs.existsSync(result.stateFile));
  assert.equal(fs.existsSync(path.join(brainWorkDir, 'stale.txt')), false);
  assert.equal(result.spillFiles.length, 1);
  assert.ok(fs.existsSync(path.join(brainWorkDir, result.spillFiles[0])));
  assert.match(result.markdown, new RegExp(result.spillFiles[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('renderScanState writeFiles:false does not write history spill files', () => {
  const brainWorkDir = makeBrainWorkDir('dry-run-spills');
  fs.rmSync(brainWorkDir, { recursive: true, force: true });
  const data = migrateToV5({
    version: 5,
    tasks: [singleTask('task-history-dry-run', {
      history: Array.from({ length: 20 }, (_, i) => ({
        timestamp: `2026-07-05T08:${String(i).padStart(2, '0')}:00.000Z`,
        type: 'note',
        text: `Detailed historical entry ${i} `.repeat(20)
      }))
    })]
  });

  const result = renderScanState(data, {
    brainWorkDir,
    writeFiles: false,
    runId: 'dry-run',
    historySpillBytes: 500
  });

  assert.equal(result.stateFile, null);
  assert.equal(fs.existsSync(brainWorkDir), false);
});

test('renderScanState spills full pmStatus instead of truncating replacement data', () => {
  const brainWorkDir = makeBrainWorkDir('pmstatus-spill');
  const problems = Array.from({ length: 5 }, (_, i) => ({
    text: `Problem entry ${i + 1} must be preserved in full text ${'detail '.repeat(20)}`,
    date: `2026-07-0${i + 1}`,
    evidence: `src-${i + 1}`,
    confidence: 'medium'
  }));
  const data = migrateToV5({
    version: 5,
    tasks: [{
      ...singleTask('project-pm', {
        taskType: 'project',
        projectKey: 'project-pm',
        pmStatus: {
          current: 'Current state',
          planned: [],
          userActions: [],
          problems,
          risks: [],
          waitingOn: [],
          confidence: 'medium',
          lastSynthesizedAt: '2026-07-05T10:00:00.000Z'
        }
      })
    }]
  });

  const result = renderScanState(data, {
    brainWorkDir,
    runId: 'pm-run',
    maxBytes: 500
  });
  const pmSpill = result.spillFiles.find(name => name.startsWith('pmstatus-'));
  const spillText = fs.readFileSync(path.join(brainWorkDir, pmSpill), 'utf8');

  assert.match(result.markdown, /pmStatus spill:/);
  assert.match(spillText, /Problem entry 5 must be preserved in full text/);
});

test('renderScanState spills omitted line item ids so hidden items can be updated', () => {
  const brainWorkDir = makeBrainWorkDir('lineitems-spill');
  const lineItems = Array.from({ length: 15 }, (_, i) => ({
    id: `li-${i + 1}`,
    title: `Line item ${i + 1}`,
    status: 'open',
    currentState: `State ${i + 1}`
  }));
  const data = migrateToV5({
    version: 5,
    tasks: [{
      ...singleTask('project-lines', {
        taskType: 'project',
        projectKey: 'project-lines',
        lineItems
      })
    }]
  });

  const result = renderScanState(data, {
    brainWorkDir,
    runId: 'line-run'
  });
  const lineSpill = result.spillFiles.find(name => name.startsWith('lineitems-'));
  const spillText = fs.readFileSync(path.join(brainWorkDir, lineSpill), 'utf8');

  assert.match(result.markdown, /lineItems spill:/);
  assert.match(spillText, /li-15/);
});

test('renderScanState emits one required spill for every stale unconfirmed temporal node', () => {
  const brainWorkDir = makeBrainWorkDir('temporal-review-spill');
  const data = migrateToV5({
    version: 5,
    tasks: [{
      ...singleTask('project-temporal', {
        taskType: 'project',
        projectKey: 'project-temporal',
        pmStatus: {
          current: 'Current state',
          planned: [{ id: 'plan-old', text: 'Complete old milestone', date: '2026-07-01', state: 'unconfirmed' }],
          userActions: [],
          problems: [],
          risks: [],
          waitingOn: [],
          confidence: 'medium'
        },
        lineItems: [{
          id: 'li-old-date',
          title: 'Old dated work',
          status: 'open',
          state: 'unconfirmed',
          dueAt: '2026-07-02',
          currentState: 'The old target date remains in the record.'
        }]
      })
    }]
  });

  const result = renderScanState(data, {
    brainWorkDir,
    runId: 'temporal-run',
    now: '2026-07-15T12:00:00.000Z'
  });
  const temporalSpill = result.spillFiles.find(name => name.startsWith('temporal-review-'));
  const spillText = fs.readFileSync(path.join(brainWorkDir, temporalSpill), 'utf8');

  assert.match(result.markdown, /temporalReview REQUIRED spill/);
  assert.match(spillText, /pmStatus\.planned:plan-old/);
  assert.match(spillText, /li-old-date/);
  assert.match(result.markdown, /explicitly reconcile every candidate/i);
});

test('brain prompt and renderer do not encode project-specific verification facts', () => {
  const prompt = fs.readFileSync(promptFile, 'utf8');
  const result = renderScanState(migrateToV5({
    version: 5,
    tasks: [singleTask('neutral-1', {
      title: 'Lakeside office coordination',
      summary: 'Only the provided fixture text should appear.'
    })]
  }), { writeFiles: false, runId: 'neutral-run' });
  const combined = `${prompt}\n${result.markdown}`;
  const forbidden = [
    'Seestrasse',
    'AV/MTR',
    'Patch-Panel',
    'Patch Panel',
    'Switch-Ports',
    'August-Fenster',
    'PO blocker'
  ];

  for (const term of forbidden) {
    assert.equal(combined.includes(term), false, `unexpected hardcoded term: ${term}`);
  }
});
