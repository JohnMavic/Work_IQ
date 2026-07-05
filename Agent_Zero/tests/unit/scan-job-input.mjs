import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeScanJobInput } from '../../brain/scan-brain.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');

test('scan job input accepts scanDays and legacy days then stores scanDays', () => {
  assert.deepEqual(normalizeScanJobInput({ scanDays: 9 }), { scanDays: 9 });
  assert.deepEqual(normalizeScanJobInput({ days: 6 }), { scanDays: 6 });
  assert.deepEqual(normalizeScanJobInput({ scanDays: 99 }), { scanDays: 14 });
  assert.deepEqual(normalizeScanJobInput({ days: 0 }), { scanDays: 1 });
});

test('server and scheduler use scan job input roundtrip instead of old phase calls', () => {
  const server = fs.readFileSync(path.join(repoRoot, 'server.js'), 'utf8');
  const scheduler = fs.readFileSync(path.join(repoRoot, 'Start-WorkIQ-Scan.ps1'), 'utf8');

  assert.match(server, /input = normalizeScanJobInput\(input\)/);
  assert.match(server, /normalizeScanJobInput\(req\.body\)\.scanDays/);
  assert.match(server, /normalizeScanJobInput\(job\.input\)\.scanDays/);

  assert.match(scheduler, /\$ServerUrl\/api\/jobs/);
  assert.match(scheduler, /kind = "scan"/);
  assert.match(scheduler, /input = @\{ scanDays = \$ScanDays \}/);
  assert.doesNotMatch(scheduler, /\$ServerUrl\/api\/scan/);
  assert.doesNotMatch(scheduler, /api\/tasks\/\$taskId\/enrich/);
  assert.doesNotMatch(scheduler, /\$ServerUrl\/api\/consolidate/);
});
