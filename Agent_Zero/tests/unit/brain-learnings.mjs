import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  appendBrainLearning,
  computeLearningContentHash,
  loadCuratedBrainLearnings,
  parseBrainLearnings,
  renderCuratedBrainLearningsBlock,
  validateLearningPayload
} from '../../brain/learnings.js';

function learningFile(t, markdown) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-zero-learnings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, 'brain-learnings.md');
  fs.writeFileSync(filePath, markdown, 'utf8');
  return filePath;
}

test('brain learnings parse structured metadata and derive stable content-hash ids', () => {
  const markdown = [
    '# Brain Learnings',
    '',
    '## 2026-07-15 pattern: scoped-probe',
    'Category: pattern',
    'Scope: project:seestrasse',
    'Tags: workiq, attachment, workiq',
    'Volatility: ephemeral',
    'Outcome: success',
    'ObservedAt: 2026-07-15T08:00:00.000Z',
    'Evidence: A targeted scan succeeded.',
    'Text: Re-probe the indexed attachment before relying on prior failure.'
  ].join('\n');
  const parsed = parseBrainLearnings(markdown);
  const entry = parsed.entries[0];

  assert.equal(entry.scope, 'project:seestrasse');
  assert.deepEqual(entry.tags, ['attachment', 'workiq']);
  assert.equal(entry.volatility, 'ephemeral');
  assert.equal(entry.outcome, 'success');
  assert.equal(entry.id, `lw-${entry.contentHash}`);
  assert.equal(entry.contentHash, computeLearningContentHash({
    category: 'pattern',
    tags: ['WORKIQ', 'attachment'],
    text: '  re-probe THE indexed attachment before relying on prior failure.  '
  }));
});

test('project-specific Seestrasse learning is not injected into unrelated context', t => {
  const filePath = learningFile(t, [
    '# Brain Learnings',
    '',
    '## 2026-07-15 pattern: seestrasse-attachment-indexing',
    'Category: pattern',
    'Evidence: Project scan.',
    'Text: The Seestrasse August Works PDF remained content-not-indexed across scans.',
    '',
    '## 2025-01-01 principle: verify-authoritative-state',
    'Category: principle',
    'Scope: global',
    'Tags: safety, verification',
    'Volatility: principle',
    'Outcome: active',
    'ObservedAt: 2025-01-01',
    'Evidence: General safety rule.',
    'Text: Verify authoritative state before converting a signal into task state.'
  ].join('\n'));

  const block = renderCuratedBrainLearningsBlock({
    filePath,
    maxBytes: 1600,
    context: {
      projectTitles: ['Northwind Finance Migration'],
      projectKeys: ['NFM-42'],
      aliases: ['Ledger modernization']
    },
    now: new Date('2026-07-15T12:00:00.000Z')
  });

  assert.doesNotMatch(block.markdown, /Seestrasse|August Works/i);
  assert.match(block.markdown, /Verify authoritative state/);
  assert.ok(Buffer.byteLength(block.markdown, 'utf8') <= 1600);
});

test('tool-scoped learning is retrieved from explicit tool context', t => {
  const filePath = learningFile(t, [
    '# Brain Learnings',
    '',
    '## 2026-07-15 pattern: workiq-attachment-reprobe',
    'Category: pattern',
    'Scope: tool:workiq',
    'Tags: attachment, workiq',
    'Volatility: workflow',
    'Outcome: active',
    'ObservedAt: 2026-07-15',
    'Evidence: Repeated WorkIQ attachment indexing behavior.',
    'Text: Re-probe WorkIQ attachments after the indexing cooldown.'
  ].join('\n'));

  const block = renderCuratedBrainLearningsBlock({
    filePath,
    maxBytes: 1200,
    context: { tools: ['Agency', 'WorkIQ'] },
    now: new Date('2026-07-15T12:00:00.000Z')
  });

  assert.match(block.markdown, /Re-probe WorkIQ attachments/);
});

test('the most relevant scoped learning ranks first', t => {
  const filePath = learningFile(t, [
    '# Brain Learnings',
    '',
    '## 2026-07-15 pattern: generic-attachment-probe',
    'Category: pattern',
    'Scope: global',
    'Tags: attachment',
    'Volatility: workflow',
    'Outcome: active',
    'ObservedAt: 2026-07-15',
    'Evidence: General workflow.',
    'Text: Probe an attachment before using attachment-only facts.',
    '',
    '## 2026-07-15 pattern: seestrasse-consolidation-probe',
    'Category: pattern',
    'Scope: project:seestrasse',
    'Tags: seestrasse, consolidation, attachment',
    'Volatility: project_state',
    'Outcome: active',
    'ObservedAt: 2026-07-15',
    'Evidence: Seestrasse project scan.',
    'Text: For Seestrasse Consolidation, re-probe the communications attachment.',
    '',
    '## 2026-07-15 principle: verify-first',
    'Category: principle',
    'Scope: global',
    'Tags: safety',
    'Volatility: principle',
    'Outcome: active',
    'ObservedAt: 2026-07-15',
    'Evidence: Safety baseline.',
    'Text: Verify before asserting current state.'
  ].join('\n'));

  const curated = loadCuratedBrainLearnings({
    filePath,
    maxBytes: 4096,
    query: 'attachment',
    context: {
      projectTitles: ['MS Seestrasse Consolidation'],
      projectKeys: ['SEA-CONSOL'],
      aliases: ['Seestrasse']
    },
    now: new Date('2026-07-15T12:00:00.000Z')
  });

  assert.match(curated.entries[0].title, /seestrasse-consolidation-probe/);
  assert.ok(curated.rankedEntries[0].score > curated.rankedEntries[1].score);
  assert.ok(curated.text.indexOf('seestrasse-consolidation-probe')
    < curated.text.indexOf('generic-attachment-probe'));
});

test('stale transient failures stay quarantined but become eligible for reprobe', t => {
  const filePath = learningFile(t, [
    '# Brain Learnings',
    '',
    '## 2026-01-01 pattern: workiq-cli-unavailable',
    'Category: pattern',
    'Scope: global',
    'Tags: workiq, cli',
    'Volatility: ephemeral',
    'Outcome: failed',
    'ObservedAt: 2026-01-01',
    'Evidence: One runner invocation failed.',
    'Text: Never use the WorkIQ CLI because it is unavailable.'
  ].join('\n'));

  const curated = loadCuratedBrainLearnings({
    filePath,
    maxBytes: 1800,
    query: 'WorkIQ CLI scan',
    now: new Date('2026-07-15T12:00:00.000Z')
  });

  assert.equal(curated.entries.length, 0);
  assert.equal(curated.reprobeEntries.length, 1);
  assert.equal(curated.reprobeEntries[0].reprobeEligible, true);
  assert.equal(curated.reprobeEntries[0].excludedReason, 'failed');
  assert.match(curated.text, /Re-probe current behavior/);
  assert.doesNotMatch(curated.text, /Never use the WorkIQ CLI/);

  const reverifiedPath = learningFile(t, [
    '# Brain Learnings',
    '',
    '## 2026-07-15 pattern: workiq-cli-reverified',
    'Category: pattern',
    'Scope: global',
    'Tags: workiq, cli',
    'Volatility: ephemeral',
    'Outcome: reverified',
    'ObservedAt: 2026-07-15',
    'Evidence: Current runner probe succeeded.',
    'Text: The WorkIQ CLI is reachable in the current runner.'
  ].join('\n'));
  const reverified = loadCuratedBrainLearnings({
    filePath: reverifiedPath,
    query: 'WorkIQ CLI scan',
    now: new Date('2026-07-15T12:00:00.000Z')
  });
  assert.equal(reverified.entries.length, 1);
  assert.equal(reverified.entries[0].outcome, 'reverified');
});

test('safety principles do not decay into permission or operational reprobe notices', t => {
  const filePath = learningFile(t, [
    '# Brain Learnings',
    '',
    '## 2020-01-01 principle: permission-boundary',
    'Category: principle',
    'Scope: global',
    'Tags: safety, permission',
    'Volatility: ephemeral',
    'Outcome: active',
    'ObservedAt: 2020-01-01',
    'Evidence: Safety invariant.',
    'Text: Never treat an expired operational warning as permission to bypass a safety boundary.',
    '',
    '## 2020-01-01 principle: failed-safety-rule',
    'Category: principle',
    'Scope: global',
    'Tags: safety',
    'Volatility: principle',
    'Outcome: contradicted',
    'ObservedAt: 2020-01-01',
    'Evidence: Awaiting human re-verification.',
    'Text: This contradicted safety rule must remain quarantined.'
  ].join('\n'));

  const curated = loadCuratedBrainLearnings({
    filePath,
    query: 'unrelated project',
    now: new Date('2026-07-15T12:00:00.000Z')
  });

  assert.match(curated.text, /Never treat an expired operational warning as permission/);
  assert.doesNotMatch(curated.text, /contradicted safety rule/);
  assert.equal(curated.reprobeEntries.length, 0);
  assert.equal(curated.rankedEntries[0].agePenalty, 0);
});

test('append writes metadata, preserves existing bytes, deduplicates content, and rejects secrets', t => {
  const original = '# User-authored Brain Learnings\n\nKeep this preamble byte-for-byte.\n';
  const filePath = learningFile(t, original);
  const payload = {
    text: 'Re-probe transient attachment failures after the cooldown.',
    category: 'pattern',
    evidence: 'A later targeted probe succeeded.',
    scope: 'project:seestrasse',
    tags: ['attachment', 'workiq'],
    volatility: 'ephemeral',
    outcome: 'success',
    observedAt: '2026-07-15T08:30:00.000Z'
  };

  const appended = appendBrainLearning(payload, {
    filePath,
    now: new Date('2026-07-15T09:00:00.000Z')
  });
  const afterAppend = fs.readFileSync(filePath, 'utf8');

  assert.equal(appended.appended, true);
  assert.ok(afterAppend.startsWith(original));
  assert.match(afterAppend, /^Id: lw-[a-f0-9]{64}$/m);
  assert.match(afterAppend, /^ContentHash: [a-f0-9]{64}$/m);
  assert.match(afterAppend, /^Scope: project:seestrasse$/m);
  assert.match(afterAppend, /^Tags: attachment, workiq$/m);
  assert.match(afterAppend, /^Volatility: ephemeral$/m);
  assert.match(afterAppend, /^Outcome: success$/m);
  assert.match(afterAppend, /^ObservedAt: 2026-07-15T08:30:00.000Z$/m);

  const duplicate = appendBrainLearning({
    ...payload,
    text: '  RE-PROBE transient attachment failures after the cooldown.  ',
    tags: ['workiq', 'attachment']
  }, { filePath });
  assert.equal(duplicate.duplicate, true);
  assert.equal(fs.readFileSync(filePath, 'utf8'), afterAppend);

  const secretPayload = {
    text: 'Use api_key=super-secret-value for the probe.',
    category: 'pattern',
    evidence: 'Unsafe fixture.'
  };
  assert.match(validateLearningPayload(secretPayload), /secrets or credentials/);
  const rejected = appendBrainLearning(secretPayload, { filePath });
  assert.equal(rejected.ok, false);
  assert.equal(fs.readFileSync(filePath, 'utf8'), afterAppend);
});

test('curated rendering enforces a hard UTF-8 byte budget', t => {
  const filePath = learningFile(t, [
    '# Brain Learnings',
    '',
    ...Array.from({ length: 8 }, (_, index) => [
      `## 2026-07-${String(index + 1).padStart(2, '0')} pattern: seestrasse-${index}`,
      'Category: pattern',
      'Scope: project:seestrasse',
      'Tags: seestrasse, attachment',
      'Volatility: workflow',
      'Outcome: active',
      `ObservedAt: 2026-07-${String(index + 1).padStart(2, '0')}`,
      'Evidence: Repeated project evidence.',
      `Text: Seestrasse attachment learning ${index} ${'x'.repeat(180)}`,
      ''
    ]).flat()
  ].join('\n'));

  const maxBytes = 900;
  const block = renderCuratedBrainLearningsBlock({
    filePath,
    maxBytes,
    context: { projectTitles: ['Seestrasse Consolidation'] },
    now: new Date('2026-07-15T12:00:00.000Z')
  });

  assert.ok(Buffer.byteLength(block.markdown, 'utf8') <= maxBytes);
  assert.equal(block.truncated, true);
  assert.ok(block.omittedEntries > 0);
});
