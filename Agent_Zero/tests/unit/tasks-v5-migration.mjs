import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  cleanupStaleAtomicTempsForFile,
  migrateTasksFileToV5,
  migrateToV5,
  writeJsonFileAtomic
} from '../../brain/tasks-v5.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-v5');

function fixtureV4() {
  return {
    version: 4,
    lastScan: '2026-07-01T08:00:00.000Z',
    customRootField: { keep: true },
    tasks: [
      {
        id: 'task-1',
        title: 'First task',
        summary: 'Existing summary',
        source: 'email',
        from: 'alex@example.test',
        date: '2026-07-01T07:00:00.000Z',
        link: 'https://example.test/message/1',
        status: 'new',
        notes: 'keep notes',
        history: [{ timestamp: '2026-07-01T08:01:00.000Z', type: 'note', text: 'keep history' }],
        activeJob: null,
        jobHistory: []
      },
      {
        id: 'task-2',
        title: 'Second task',
        summary: '',
        status: 'on-radar',
        additionalLinks: ['https://example.test/extra'],
        ambiguities: [{ question: 'Keep?', resolved: false }],
        customTaskField: 42
      }
    ]
  };
}

function resetTmp(name) {
  const dir = path.join(tmpRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

test('migrateToV5 migrates a v4 fixture additively and preserves task count', () => {
  const v4 = fixtureV4();
  const migrated = migrateToV5(v4);

  assert.equal(migrated.version, 5);
  assert.equal(migrated.tasks.length, v4.tasks.length);
  assert.deepEqual(migrated.customRootField, v4.customRootField);
  assert.equal(migrated.brain.engine, 'agency');
  assert.equal(migrated.brain.model, 'claude-opus-4.8');
  assert.deepEqual(migrated.reviewQueue, []);

  for (const task of migrated.tasks) {
    assert.equal(task.schemaVersion, 5);
    assert.equal(task.taskType, 'single');
    assert.equal(task.archived, false);
    assert.equal(task.supersededBy, null);
    assert.deepEqual(task.supersedesTaskIds, []);
    assert.deepEqual(task.lineItems, []);
    assert.deepEqual(task.sourceRefs, []);
    assert.equal(task.pmStatus, null);
    assert.deepEqual(task.brainState, {
      lastScanRunId: null,
      lastEvidenceAt: null,
      needsReview: false,
      reviewReason: null
    });
  }
});

test('migrateToV5 is idempotent', () => {
  const once = migrateToV5(fixtureV4());
  const twice = migrateToV5(once);
  assert.deepEqual(twice, once);
});

test('migrateToV5 quarantines unsupported legacy resolution statuses', () => {
  const migrated = migrateToV5({
    version: 5,
    tasks: [{
      id: 'project-legacy-resolution',
      title: 'Legacy project',
      taskType: 'project',
      lineItems: [{
        id: 'line-legacy-resolution',
        title: 'Legacy line',
        resolutionStatus: 'unverified'
      }]
    }]
  });
  const lineItem = migrated.tasks[0].lineItems[0];

  assert.equal(lineItem.resolutionStatus, null);
  assert.equal(lineItem.needsReview, true);
  assert.match(lineItem.reviewReason, /fresh source verification/i);
  assert.deepEqual(migrateToV5(migrated), migrated);
});

test('migrateToV5 does not lose existing task fields', () => {
  const migrated = migrateToV5(fixtureV4());
  const task1 = migrated.tasks.find(t => t.id === 'task-1');
  const task2 = migrated.tasks.find(t => t.id === 'task-2');

  assert.equal(task1.title, 'First task');
  assert.equal(task1.summary, 'Existing summary');
  assert.equal(task1.link, 'https://example.test/message/1');
  assert.equal(task1.history[0].text, 'keep history');
  assert.deepEqual(task2.additionalLinks, ['https://example.test/extra']);
  assert.deepEqual(task2.ambiguities, [{ question: 'Keep?', resolved: false }]);
  assert.equal(task2.customTaskField, 42);
});

test('migrateTasksFileToV5 writes backup before migration and round-trips JSON', () => {
  const dir = resetTmp('file-migration');
  const tasksFile = path.join(dir, 'tasks.json');
  fs.writeFileSync(tasksFile, `${JSON.stringify(fixtureV4(), null, 2)}\n`, 'utf8');

  const result = migrateTasksFileToV5(tasksFile, { now: new Date('2026-07-05T12:34:56.000Z') });
  const parsed = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(result.migrated, true);
  assert.equal(parsed.version, 5);
  assert.equal(parsed.tasks.length, 2);
  assert.equal(path.basename(result.backupFile), 'tasks.json.v4-2026-07-05T12-34-56-000Z.bak');
  assert.ok(fs.existsSync(result.backupFile));
  assert.equal(JSON.parse(fs.readFileSync(result.backupFile, 'utf8')).version, 4);
});

test('writeJsonFileAtomic rotates at most three .bak files', () => {
  const dir = resetTmp('atomic-write');
  const file = path.join(dir, 'tasks.json');

  for (let i = 0; i < 5; i++) {
    writeJsonFileAtomic(file, { version: i, tasks: [] });
  }

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  const backups = fs.readdirSync(dir).filter(name => /^tasks\.json\.\d+\.bak$/.test(name)).sort();

  assert.equal(parsed.version, 4);
  assert.deepEqual(backups, ['tasks.json.1.bak', 'tasks.json.2.bak', 'tasks.json.3.bak']);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'tasks.json.1.bak'), 'utf8')).version, 3);
});

test('writeJsonFileAtomic retries transient Windows rename failures', () => {
  const dir = resetTmp('atomic-rename-retry');
  const file = path.join(dir, 'tasks.json');
  let renameAttempts = 0;

  writeJsonFileAtomic(file, { version: 1, tasks: [] }, {
    renameRetryDelayMs: 0,
    _sleep: () => {},
    _renameSync: (from, to) => {
      renameAttempts++;
      if (renameAttempts === 1) {
        const err = new Error('transient EPERM rename');
        err.code = 'EPERM';
        throw err;
      }
      fs.renameSync(from, to);
    }
  });

  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 1);
  assert.equal(renameAttempts, 2);
});

test('writeJsonFileAtomic continues when backup copy is locked', () => {
  const dir = resetTmp('atomic-backup-copy-locked');
  const file = path.join(dir, 'tasks.json');
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, tasks: [] }, null, 2)}\n`, 'utf8');

  writeJsonFileAtomic(file, { version: 2, tasks: [] }, {
    _copyFileSync: () => {
      const err = new Error('EBUSY copyfile');
      err.code = 'EBUSY';
      throw err;
    }
  });

  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).version, 2);
});

test('cleanupStaleAtomicTempsForFile removes ignored atomic temp files', () => {
  const dir = resetTmp('atomic-temp-cleanup');
  const file = path.join(dir, 'tasks.json');
  const stale = path.join(dir, '.tasks.json.12345.67890.abc123.tmp');
  const unrelated = path.join(dir, '.other.json.12345.67890.abc123.tmp');
  fs.writeFileSync(stale, 'sensitive task data', 'utf8');
  fs.writeFileSync(unrelated, 'keep', 'utf8');

  const result = cleanupStaleAtomicTempsForFile(file, { olderThanMs: 0 });
  const gitignore = fs.readFileSync(path.join(repoRoot, '.gitignore'), 'utf8');

  assert.equal(result.removed, 1);
  assert.equal(fs.existsSync(stale), false);
  assert.equal(fs.existsSync(unrelated), true);
  assert.match(gitignore, /^\.tasks\.json\.\*\.tmp$/m);
});
