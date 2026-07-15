import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import {
  applyMigrationPreview,
  buildInvariantReport,
  runMigrationDryRun
} from '../../scripts/migrate-projects-once.mjs';
import { migrateToV5, writeJsonFileAtomic } from '../../brain/tasks-v5.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-migration');
const skillFile = path.join(repoRoot, 'docs', 'AGENCY_BRAIN_SCAN_SKILL.md');

function resetTmp(name) {
  const dir = path.join(tmpRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function sha256File(filePath) {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function writeTasks(dir, data) {
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, `${JSON.stringify(migrateToV5(data), null, 2)}\n`, 'utf8');
  return file;
}

function marker(type, payload) {
  return `[${type}] ${JSON.stringify(payload)}`;
}

function actionProof() {
  return {
    threadRef: 'conv-alpha-rollout',
    askQuote: {
      text: 'Martin, please confirm the rollout owner.',
      from: 'Alex Planner',
      date: '2026-07-05T08:00:00.000Z',
      threadRef: 'conv-alpha-rollout'
    },
    resolutionStatus: 'open',
    lastVerifiedMessageDate: '2026-07-05T09:00:00.000Z',
    threadCheck: {
      coverage: 'complete',
      addressedTo: 'user',
      messageCount: 2,
      lastMessageDate: '2026-07-05T09:00:00.000Z',
      checkedThroughMessageDate: '2026-07-05T09:00:00.000Z'
    }
  };
}

function sourceTask(id, extra = {}) {
  return {
    id,
    title: `Source ${id}`,
    summary: `Summary ${id}`,
    status: 'new',
    link: `https://example.test/${id}`,
    history: [{ timestamp: '2026-07-01T08:00:00.000Z', type: 'note', text: `History ${id}` }],
    ...extra
  };
}

function projectMarkers() {
  return [
    marker('PROJECT_NEW', {
      taskId: 'proj-alpha',
      projectKey: 'alpha-office-refresh',
      title: 'Alpha office refresh',
      summary: 'Consolidated Alpha office work',
      pmStatus: {
        current: 'Two related workstreams are open.',
        planned: [],
        userActions: [{ text: 'Confirm the rollout owner.', evidence: 'src-alpha-1', confidence: 'medium', ...actionProof() }],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium',
        lastSynthesizedAt: '2026-07-05T10:00:00.000Z'
      },
      sourceRefs: [
        {
          id: 'src-alpha-1',
          type: 'email',
          title: 'Alpha room prep',
          date: '2026-07-05T08:00:00.000Z',
          link: 'https://example.test/task-1',
          sourceTaskId: 'task-1'
        },
        {
          id: 'src-alpha-2',
          type: 'email',
          title: 'Alpha network prep',
          date: '2026-07-05T08:10:00.000Z',
          link: 'https://example.test/task-2',
          sourceTaskId: 'task-2'
        }
      ],
      lineItems: [
        {
          id: 'li-room',
          title: 'Room preparation',
          status: 'open',
          relevance: {
            score: 58,
            reason: 'Room preparation is required for the project rollout.',
            evidenceRefIds: ['src-alpha-1']
          },
          evidenceRefIds: ['src-alpha-1'],
          sourceTaskIds: ['task-1']
        },
        {
          id: 'li-network',
          title: 'Network preparation',
          status: 'waiting',
          relevance: {
            score: 72,
            reason: 'Network readiness is the principal dependency for rollout.',
            evidenceRefIds: ['src-alpha-2']
          },
          evidenceRefIds: ['src-alpha-2'],
          sourceTaskIds: ['task-2']
        }
      ],
      supersedesTaskIds: ['task-1', 'task-2']
    }),
    marker('SCAN_DONE', {
      runId: 'migration-test',
      outcome: 'success',
      newProjects: 1,
      updatedProjects: 0,
      newSingleTasks: 0,
      archivedTasks: 2,
      workIqCalls: 2,
      premiumRequests: 9
    })
  ].join('\n');
}

test('dry-run writes a valid preview and leaves tasks.json hash unchanged', async () => {
  const dir = resetTmp('dry-run');
  const tasksFile = writeTasks(dir, {
    version: 5,
    tasks: [
      sourceTask('task-1'),
      sourceTask('task-2'),
      sourceTask('task-3', { title: 'Unrelated standalone task' })
    ]
  });
  const previewFile = path.join(dir, 'migration-preview.json');
  const beforeHash = sha256File(tasksFile);
  let sawPromptContext = false;

  const preview = await runMigrationDryRun({
    tasksFile,
    skillFile,
    previewFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'migration-test',
    now: new Date('2026-07-05T10:00:00.000Z'),
    _runBrain: async ({ prompt, onJsonEvent }) => {
      sawPromptContext = /Brain Learnings/.test(prompt)
        && /150 tool starts/.test(prompt)
        && /PDF, DOCX, XLSX/.test(prompt);
      assert.match(prompt, /konsolidiere den bestehenden aktiven Agent-Zero-Bestand/);
      onJsonEvent?.({ type: 'result', data: { usage: { premiumRequests: 9 } } });
      return {
        ok: true,
        assistantText: projectMarkers(),
        durationMs: 1234,
        counters: { workIqCalls: 2 },
        exitCode: 0,
        stdoutBytes: 100,
        stderrBytes: 0
      };
    }
  });

  assert.equal(sawPromptContext, true);
  assert.equal(sha256File(tasksFile), beforeHash);
  assert.equal(preview.tasksHashBefore, beforeHash);
  assert.equal(preview.tasksHashAfter, beforeHash);
  assert.equal(preview.dryRunMutatedTasks, false);
  assert.equal(fs.existsSync(previewFile), true);
  assert.equal(preview.markers.length, 2);
  assert.equal(preview.droppedMarkers.length, 0);
  assert.equal(preview.simulatedResult.projectTasks.length, 1);
  assert.equal(preview.simulatedResult.projectTasks[0].lineItems.length, 2);
  assert.deepEqual(preview.simulatedResult.archivedTaskIds.sort(), ['task-1', 'task-2']);
  assert.deepEqual(preview.simulatedResult.unassignedTaskIds, ['task-3']);
  assert.ok(preview.invariants.historySumAfter >= preview.invariants.historySumBefore);
  assert.ok(preview.invariants.linkSumAfter >= preview.invariants.linkSumBefore);
  assert.equal(preview.brain.workIqCalls, 2);
  assert.equal(preview.brain.premiumRequests, 9);
});

test('apply uses preview markers, archives source tasks, keeps tasks, and creates backup', () => {
  const dir = resetTmp('apply');
  const tasksFile = writeTasks(dir, {
    version: 5,
    tasks: [sourceTask('task-1'), sourceTask('task-2')]
  });
  const previewFile = path.join(dir, 'migration-preview.json');
  const preview = {
    runId: 'migration-test',
    markers: [
      {
        type: 'PROJECT_NEW',
        payload: JSON.parse(projectMarkers().split(/\r?\n/)[0].replace(/^\[PROJECT_NEW\]\s+/, '')),
        line: 1,
        raw: projectMarkers().split(/\r?\n/)[0]
      },
      {
        type: 'SCAN_DONE',
        payload: JSON.parse(projectMarkers().split(/\r?\n/)[1].replace(/^\[SCAN_DONE\]\s+/, '')),
        line: 2,
        raw: projectMarkers().split(/\r?\n/)[1]
      }
    ]
  };
  fs.writeFileSync(previewFile, `${JSON.stringify(preview, null, 2)}\n`, 'utf8');
  const before = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  const result = applyMigrationPreview({
    tasksFile,
    previewFile,
    now: new Date('2026-07-05T10:00:00.000Z')
  });
  const after = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const project = after.tasks.find(task => task.id === 'proj-alpha');

  assert.equal(result.appliedMarkers, 2);
  assert.equal(after.tasks.length, before.tasks.length + 1);
  assert.equal(project.taskType, 'project');
  assert.equal(after.tasks.find(task => task.id === 'task-1').archived, true);
  assert.equal(after.tasks.find(task => task.id === 'task-1').supersededBy, 'proj-alpha');
  assert.equal(after.tasks.find(task => task.id === 'task-2').archived, true);
  assert.ok(fs.existsSync(`${tasksFile}.1.bak`));
  assert.deepEqual(
    before.tasks.map(task => task.id).sort(),
    before.tasks.map(task => after.tasks.find(saved => saved.id === task.id)?.id).sort()
  );
  assert.ok(result.invariants.historySumAfter >= result.invariants.historySumBefore);
  assert.ok(result.invariants.linkSumAfter >= result.invariants.linkSumBefore);
});

test('apply aborts before write when the invariant gate would be violated', () => {
  const dir = resetTmp('invariant-fail');
  const tasksFile = writeTasks(dir, {
    version: 5,
    tasks: [sourceTask('task-1')]
  });
  const previewFile = path.join(dir, 'migration-preview.json');
  fs.writeFileSync(previewFile, `${JSON.stringify({
    runId: 'migration-test',
    markers: [{ type: 'SCAN_DONE', payload: { runId: 'migration-test', outcome: 'success' } }]
  }, null, 2)}\n`, 'utf8');
  const beforeHash = sha256File(tasksFile);
  let writes = 0;

  assert.throws(
    () => applyMigrationPreview({
      tasksFile,
      previewFile,
      _writeJsonFileAtomic: () => { writes++; },
      _applyMarkerBatch: (beforeData) => {
        const data = migrateToV5(beforeData);
        data.tasks[0].history = [];
        data.tasks[0].link = null;
        data.tasks[0].additionalLinks = [];
        data.tasks[0].sourceRefs = [];
        return { data, applied: 1, dropped: [] };
      }
    }),
    /invariant gate failed/
  );

  assert.equal(writes, 0);
  assert.equal(sha256File(tasksFile), beforeHash);
});

test('invariant report exposes link and history sums for preview validation', () => {
  const before = migrateToV5({ version: 5, tasks: [sourceTask('task-1')] });
  const after = migrateToV5({
    version: 5,
    tasks: [
      sourceTask('task-1'),
      {
        id: 'proj-extra',
        taskType: 'project',
        title: 'Extra project',
        sourceRefs: [{ id: 'src-extra', link: 'https://example.test/extra' }],
        history: [{ timestamp: '2026-07-05T00:00:00.000Z', type: 'note', text: 'Created' }]
      }
    ]
  });
  const report = buildInvariantReport(before, after);

  assert.equal(report.historySumBefore, 1);
  assert.equal(report.historySumAfter, 2);
  assert.equal(report.linkSumAfter > report.linkSumBefore, true);
  assert.deepEqual(report.deletedTaskIds, []);
});
