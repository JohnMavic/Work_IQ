import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  applyStructureMigrationPreview,
  hasNewStructure,
  runStructureMigrationDryRun,
  sanitizeGarbageDates,
  selectStructureMigrationTargets
} from '../../scripts/migrate-structure.mjs';
import { migrateToV5 } from '../../brain/tasks-v5.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-structure-migration');
const skillFile = path.join(repoRoot, 'docs', 'AGENCY_BRAIN_SCAN_SKILL.md');
const batch7File = path.join(repoRoot, 'docs', 'gremium', 'PROMPT-BATCH-7.md');

function resetTmp(name) {
  const dir = path.join(tmpRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function writeTasks(dir, data) {
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, `${JSON.stringify(migrateToV5(data), null, 2)}\n`, 'utf8');
  return file;
}

function marker(type, payload) {
  return `[${type}] ${JSON.stringify(payload)}`;
}

function approveAll(markers) {
  return {
    ok: true,
    text: markers.map((_, index) => `GATEWAY_DECISION\t${index}\tapprove\tApproved in fixture.`).join('\n'),
    counters: { workIqCalls: 0 }
  };
}

function oldTask(extra = {}) {
  return {
    id: 'legacy-1',
    taskType: 'single',
    title: 'Hardware / SFP location (Zurich-See & Circle)',
    status: 'new',
    date: 'Last Tuesday (4:06 PM)',
    link: 'https://outlook.office365.com/owa/test',
    summary: '## Next steps\n- Find the SFP location.\n\n## History\n- Legacy summary must remain.',
    history: [{ timestamp: 'Yesterday afternoon', type: 'note', text: 'Keep this history entry.' }],
    sourceRefs: [],
    ...extra
  };
}

function structureMarkers() {
  const sourceRef = {
    id: 'src-legacy-1',
    type: 'email',
    title: 'Hardware / SFP location',
    from: 'Alex Planner',
    date: '2026-07-05T08:00:00.000Z',
    link: 'https://outlook.office365.com/owa/test',
    sourceTaskId: 'legacy-1',
    evidenceText: 'Fixture evidence for structure migration.'
  };
  const ledger = [{
    itemRef: { type: 'email', id: 'msg-legacy-1' },
    threadRef: 'conv-legacy-1',
    date: '2026-07-05T08:00:00.000Z',
    disposition: 'updates-node',
    nodeRefs: ['legacy-1'],
    quote: 'Please check where the SFPs are located.',
    reason: 'The source confirms this legacy task topic.'
  }];
  const node = {
    evidenceRefIds: ['src-legacy-1'],
    confidence: 'medium',
    state: 'confirmed',
    sources: ['src-legacy-1'],
    lastConfirmedByMessageDate: '2026-07-05T08:00:00.000Z'
  };
  return [
    marker('PROJECT_UPDATE', {
      taskId: 'legacy-1',
      sourceRefs: [sourceRef],
      evidenceRefIds: ['src-legacy-1'],
      pmStatus: {
        current: 'SFP location is being clarified for Zurich-See and Circle.',
        planned: [],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [{ id: 'wait-sfp-location', text: 'Waiting for confirmed SFP storage location.', ...node }],
        confidence: 'medium',
        lastSynthesizedAt: '2026-07-06T10:00:00.000Z'
      },
      processing: {
        cursorDate: '2026-07-05T08:00:00.000Z',
        lookbackDays: 14,
        threads: { 'conv-legacy-1': { lastProcessedMessageDate: '2026-07-05T08:00:00.000Z' } }
      },
      processingLedger: ledger
    }),
    marker('FACTSHEET_UPDATE', {
      taskId: 'legacy-1',
      sectionPatches: {
        overview: [{ op: 'add', text: 'SFP location clarification for Zurich-See and Circle.', date: '2026-07-05T08:00:00.000Z', ...node }],
        status: [{ op: 'add', text: 'SFP location is being clarified.', date: '2026-07-05T08:00:00.000Z', ...node }],
        sources: [{ op: 'add', text: 'Fixture source thread for SFP location.', date: '2026-07-05T08:00:00.000Z', ...node }]
      },
      processingLedger: ledger
    }),
    marker('SCAN_DONE', {
      runId: 'structure-test',
      outcome: 'success',
      newProjects: 0,
      updatedProjects: 1,
      newSingleTasks: 0,
      archivedTasks: 0,
      workIqCalls: 1,
      processingQuality: {
        required: true,
        enumeratedItems: [{ itemRef: { type: 'email', id: 'msg-legacy-1' }, threadRef: 'conv-legacy-1' }],
        threadCounts: [{ threadRef: 'conv-legacy-1', count: 1 }]
      }
    })
  ].join('\n');
}

test('selectStructureMigrationTargets finds active legacy tasks only', () => {
  const data = migrateToV5({
    version: 5,
    tasks: [
      oldTask(),
      oldTask({ id: 'archived', archived: true }),
      oldTask({
        id: 'structured',
        pmStatus: { current: 'Current', planned: [], userActions: [], problems: [], risks: [], waitingOn: [], confidence: 'low' },
        factSheet: { sections: { overview: [{ text: 'Fact', evidenceRefIds: ['src-1'] }] } },
        processing: { cursorDate: null, threads: {}, ledger: [] }
      })
    ]
  });

  assert.deepEqual(selectStructureMigrationTargets(data).map(task => task.id), ['legacy-1']);
});

test('structure migration dry-run and apply migrate old task without field loss', async () => {
  const dir = resetTmp('old-to-new');
  const tasksFile = writeTasks(dir, { version: 5, tasks: [oldTask()] });
  const previewFile = path.join(dir, 'preview.json');
  let sawPrompt = false;

  const preview = await runStructureMigrationDryRun({
    tasksFile,
    skillFile,
    batch7File,
    previewFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'structure-test',
    now: new Date('2026-07-06T10:00:00.000Z'),
    _runBrain: async ({ prompt }) => {
      sawPrompt = /old summary is a fallback field/.test(prompt)
        && /Brain Learnings/.test(prompt)
        && /PDF, DOCX, XLSX/.test(prompt);
      return {
        ok: true,
        assistantText: structureMarkers(),
        counters: { workIqCalls: 1 },
        durationMs: 10,
        exitCode: 0,
        stdoutBytes: 100,
        stderrBytes: 0
      };
    },
    _runGateway: async ({ markers }) => approveAll(markers)
  });

  assert.equal(sawPrompt, true);
  assert.equal(preview.targetIds.length, 1);
  assert.deepEqual(preview.migratedTargetIds, ['legacy-1']);
  assert.equal(preview.dateCleanups.some(item => item.path === 'tasks[0].date'), true);
  assert.equal(preview.dateCleanups.some(item => item.path === 'tasks[0].history[0].timestamp'), true);

  const result = applyStructureMigrationPreview({
    tasksFile,
    previewFile,
    now: new Date('2026-07-06T10:00:00.000Z')
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const task = saved.tasks[0];

  assert.equal(result.appliedMarkers, 3);
  assert.equal(hasNewStructure(task), true);
  assert.equal(task.summary, oldTask().summary);
  assert.equal(task.history.length, 1);
  assert.equal(task.link, oldTask().link);
  assert.equal(task.date, null);
  assert.equal(task.history[0].timestamp, null);
  assert.equal(task.pmStatus.current, 'SFP location is being clarified for Zurich-See and Circle.');
  assert.equal(task.factSheet.sections.overview.length, 1);
  assert.equal(task.processing.cursorDate, '2026-07-05T08:00:00.000Z');
  assert.ok(fs.existsSync(`${tasksFile}.1.bak`));
});

test('sanitizeGarbageDates keeps parseable dates and nulls garbage date-like values', () => {
  const input = {
    tasks: [{
      id: 't',
      date: 'Yesterday',
      createdAt: '2026-07-06T10:00:00.000Z',
      factSheet: { sections: { status: [{ date: 'not a date' }] } }
    }]
  };
  const result = sanitizeGarbageDates(input);

  assert.equal(result.data.tasks[0].date, null);
  assert.equal(result.data.tasks[0].createdAt, '2026-07-06T10:00:00.000Z');
  assert.equal(result.data.tasks[0].factSheet.sections.status[0].date, null);
  assert.deepEqual(result.cleaned.map(item => item.path), ['tasks[0].date', 'tasks[0].factSheet.sections.status[0].date']);
});
