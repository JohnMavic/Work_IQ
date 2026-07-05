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
