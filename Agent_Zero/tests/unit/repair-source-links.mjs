import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { repairSourceLinks, runRepairSourceLinks } from '../../scripts/repair-source-links.mjs';
import { migrateToV5 } from '../../brain/tasks-v5.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-repair-source-links');

function resetTmp(name) {
  const dir = path.join(tmpRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function fixtureData() {
  return migrateToV5({
    version: 5,
    tasks: [
      {
        id: 'source-a-full',
        taskType: 'single',
        title: 'Alpha source message',
        link: 'https://example.test/messages/alpha-full',
        archived: true,
        supersededBy: 'proj-alpha'
      },
      {
        id: 'source-b-full',
        taskType: 'single',
        title: 'Beta source message for matching',
        link: 'https://example.test/messages/beta-full',
        archived: true,
        supersededBy: 'proj-alpha'
      },
      {
        id: 'proj-alpha',
        taskType: 'project',
        title: 'Alpha project',
        link: 'https://example.test/old/primary',
        supersedesTaskIds: ['source-a-full', 'source-b-full'],
        sourceRefs: [
          {
            id: 'src-a',
            title: 'Alpha source message',
            sourceTaskId: 'source-a',
            link: 'https://example.test/messages/...'
          },
          {
            id: 'src-b',
            title: 'Beta source message for matching',
            sourceTaskId: null,
            link: null
          },
          {
            id: 'src-missing',
            title: 'Missing source message',
            sourceTaskId: 'missing-source',
            link: 'mailto:bad-link'
          }
        ],
        lineItems: [{
          id: 'li-a',
          title: 'Alpha line',
          evidenceRefIds: ['src-a'],
          sourceTaskIds: ['source-a-full']
        }]
      }
    ]
  });
}

test('repairSourceLinks reconstructs corrupt links and marks unresolved refs for review', () => {
  const result = repairSourceLinks(fixtureData(), {
    now: new Date('2026-07-05T10:00:00.000Z')
  });
  const project = result.data.tasks.find(task => task.id === 'proj-alpha');
  const byId = new Map(project.sourceRefs.map(ref => [ref.id, ref]));

  assert.equal(result.summary.repaired, 2);
  assert.equal(result.summary.unresolved, 1);
  assert.equal(byId.get('src-a').link, 'https://example.test/messages/alpha-full');
  assert.equal(byId.get('src-b').link, 'https://example.test/messages/beta-full');
  assert.equal(byId.get('src-missing').link, null);
  assert.equal(project.brainState.needsReview, true);
  assert.match(project.brainState.reviewReason, /src-missing/);
  assert.deepEqual(project.additionalLinks, [
    'https://example.test/messages/alpha-full',
    'https://example.test/messages/beta-full'
  ]);
});

test('runRepairSourceLinks dry-run leaves tasks file unchanged and apply creates backup', () => {
  const dir = resetTmp('dry-run-apply');
  const tasksFile = path.join(dir, 'tasks.json');
  fs.writeFileSync(tasksFile, `${JSON.stringify(fixtureData(), null, 2)}\n`, 'utf8');
  const before = fs.readFileSync(tasksFile, 'utf8');

  const dryRun = runRepairSourceLinks({
    tasksFile,
    now: new Date('2026-07-05T10:00:00.000Z')
  });

  assert.equal(dryRun.mode, 'dry-run');
  assert.equal(dryRun.wrote, false);
  assert.equal(fs.readFileSync(tasksFile, 'utf8'), before);

  const apply = runRepairSourceLinks({
    tasksFile,
    apply: true,
    now: new Date('2026-07-05T10:00:00.000Z')
  });
  const after = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const project = after.tasks.find(task => task.id === 'proj-alpha');

  assert.equal(apply.mode, 'apply');
  assert.equal(apply.wrote, true);
  assert.equal(fs.existsSync(`${tasksFile}.1.bak`), true);
  assert.equal(project.sourceRefs.find(ref => ref.id === 'src-a').link, 'https://example.test/messages/alpha-full');
});
