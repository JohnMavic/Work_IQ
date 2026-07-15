import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { buildAgencyArgs } from '../../brain/agency-cli.js';
import { buildGatewayPrompt, filterMarkersThroughGateway } from '../../brain/reality-gateway.js';
import { runTaskChatFastOnce } from '../../brain/task-chat.js';
import { computeDiscoveryWindow, runBrainScanOnce } from '../../brain/scan-brain.js';
import { applyMarkerBatch } from '../../brain/marker-applier.js';
import {
  evaluateProcessingQualityGate,
  filterMarkersByProcessingQualityGate,
  normalizeProcessing
} from '../../brain/processing-ledger.js';
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

function marker(type, payload) {
  return `[${type}] ${JSON.stringify(payload)}`;
}

function markerObj(type, payload) {
  return { type, payload, raw: marker(type, payload) };
}

function scanDone(payload, { now, scanDays = 4, lastScan = null } = {}) {
  const window = computeDiscoveryWindow({ now, scanDays, lastScan });
  const processingQuality = payload.processingQuality || {};
  const itemCount = Array.isArray(processingQuality.enumeratedItems)
    ? processingQuality.enumeratedItems.length
    : 0;
  return marker('SCAN_DONE', {
    ...payload,
    processingQuality: {
      required: true,
      discoveryPasses: [
        { kind: 'recent-email-enumeration', windowStart: window.start, windowEnd: window.end, itemCount, candidateCount: itemCount },
        { kind: 'material-consequence', windowStart: window.start, windowEnd: window.end, itemCount, candidateCount: itemCount }
      ],
      ...processingQuality
    }
  });
}

function approveAll(markers) {
  return {
    ok: true,
    text: markers.map((_, markerIndex) => `GATEWAY_DECISION\t${markerIndex}\tapprove\tApproved in fixture.`).join('\n'),
    counters: { workIqCalls: 0 }
  };
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

test('Batch 9 scan skill, gateway, and learnings require WorkIQ-index attachment evidence and document write guardrail', () => {
  const skill = fs.readFileSync(path.join(repoRoot, 'docs', 'AGENCY_BRAIN_SCAN_SKILL.md'), 'utf8');
  const learnings = fs.readFileSync(path.join(repoRoot, 'brain-learnings.md'), 'utf8');
  const attachmentDoc = fs.readFileSync(path.join(repoRoot, 'docs', 'OWA_ATTACHMENT_FETCH.md'), 'utf8');
  const gateway = buildGatewayPrompt({
    stateFile: path.join(repoRoot, 'tests', 'unit', 'batch9-state.md'),
    factSheetFiles: ['factsheet-b9.md'],
    markers: [],
    runId: 'b9-gateway'
  });

  assert.match(skill, /Discovery is the default/);
  assert.match(skill, /PDF, DOCX, XLSX/);
  assert.match(skill, /targeted WorkIQ\/M365 Copilot index/);
  assert.match(skill, /list all attachments of this thread with filenames/);
  assert.match(skill, /Batch atomicity is limited to intrinsically related markers/);
  assert.match(skill, /NODE_OBSOLETE/);
  assert.match(skill, /Temporal bookings must always be emitted/);
  assert.match(skill, /yes\(workiq-index\)/);
  assert.match(skill, /failed\(content-not-indexed\)/);
  assert.match(skill, /ledgerCounts/);
  assert.match(skill, /never the number of messages/);
  assert.match(skill, /temporalReview REQUIRED spill/);
  assert.doesNotMatch(skill, /environment_dependent/);
  assert.match(skill, /retry[\s\S]*exactly once/i);
  assert.match(skill, /attachment not indexed yet — re-probe next scan/);
  assert.match(skill, /External Write Guardrail/);
  assert.match(skill, /warning at 40 tool starts/);
  assert.match(skill, /150 tool starts/);
  assert.doesNotMatch(fs.readFileSync(path.join(repoRoot, 'brain', 'scan-brain.js'), 'utf8'), /owaAttachmentHelper:/);
  assert.match(attachmentDoc, /yes\(workiq-index\)/);
  assert.match(attachmentDoc, /optional future path/);
  assert.match(learnings, /attachments-are-source-evidence/);
  assert.match(learnings, /workiq-index-surfaces-attachment-contents/);
  assert.doesNotMatch(learnings, /WorkIQ, and Graph paths did not provide attachment contents/);
  assert.match(gateway, /available evidence used instead of ignored/);
  assert.match(gateway, /yes\(workiq-index\)/);
  assert.match(gateway, /PDF, DOCX, XLSX/);
  assert.match(gateway, /NODE_OBSOLETE is a narrow stale-date disposition/);
  assert.match(gateway, /not a completion claim/);
  assert.match(gateway, /failed\(content-not-indexed\)/);
  assert.match(gateway, /prior content-not-indexed result must never veto/);
  assert.match(gateway, /External write actions are forbidden/);
});

test('Batch 9C OWA attachment helper validates arguments and download sandbox', () => {
  const dir = resetTmp('owa-helper-validation');
  const brainWorkDir = path.join(dir, 'brain-work');
  const script = path.join(repoRoot, 'brain', 'tools', 'owa-attachment.ps1');
  const baseArgs = [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    script,
    '-Subject',
    'Fixture attachment message',
    '-Date',
    '2026-07-06',
    '-RunId',
    'batch9c-fixture',
    '-BrainWorkDir',
    brainWorkDir,
    '-ValidateOnly',
    '-Json'
  ];

  const ok = spawnSync('pwsh', baseArgs, { cwd: repoRoot, encoding: 'utf8' });
  assert.equal(ok.status, 0, ok.stderr || ok.stdout);
  const payload = JSON.parse(ok.stdout.slice(ok.stdout.indexOf('{')));
  assert.equal(payload.ok, true);
  assert.equal(payload.validateOnly, true);
  assert.equal(path.normalize(payload.downloadDir), path.join(brainWorkDir, 'attachments', 'batch9c-fixture'));
  assert.equal(fs.existsSync(payload.downloadDir), true);

  const badRunId = spawnSync('pwsh', [
    ...baseArgs.slice(0, baseArgs.indexOf('-RunId') + 1),
    '../escape',
    ...baseArgs.slice(baseArgs.indexOf('-RunId') + 2)
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.notEqual(badRunId.status, 0);
  assert.match(`${badRunId.stderr}\n${badRunId.stdout}`, /RunId/);

  const outside = path.join(dir, 'outside');
  const badDownload = spawnSync('pwsh', [
    ...baseArgs,
    '-DownloadDir',
    outside
  ], { cwd: repoRoot, encoding: 'utf8' });
  assert.notEqual(badDownload.status, 0);
  assert.match(`${badDownload.stderr}\n${badDownload.stdout}`, /DownloadDir must stay inside brain-work\/attachments/);
});

test('Batch 9 attachment ledger gate requires handled disposition and blocks unhandled attachments', () => {
  const missing = [markerObj('PROJECT_UPDATE', {
    taskId: 'proj-b9',
    processingLedger: [{
      itemRef: { type: 'email', id: 'msg-attachment' },
      threadRef: 'conv-attachment',
      date: '2026-07-06T18:45:00.000Z',
      disposition: 'updates-node',
      nodeRefs: ['li-b9'],
      quote: 'The message says a deck was prepared.',
      reason: 'The item may update the project.'
    }]
  })];
  const filtered = filterMarkersThroughGateway(missing, approveAll(missing));
  assert.equal(filtered.held.length, 1);
  assert.match(filtered.held[0].reason, /attachmentsHandled/);

  const unhandled = [
    markerObj('PROJECT_UPDATE', {
      taskId: 'proj-b9',
      processingLedger: [{
        itemRef: { type: 'email', id: 'msg-attachment' },
        threadRef: 'conv-attachment',
        date: '2026-07-06T18:45:00.000Z',
        disposition: 'updates-node',
        nodeRefs: ['li-b9'],
        attachmentsHandled: 'none',
        quote: 'The message says a deck was prepared.',
        reason: 'The item may update the project.'
      }]
    }),
    markerObj('SCAN_DONE', {
      runId: 'attachment-gate',
      outcome: 'success',
      processingQuality: {
        required: true,
        enumeratedItems: [{
          itemRef: { type: 'email', id: 'msg-attachment' },
          threadRef: 'conv-attachment',
          hasAttachments: true
        }],
        ledgerCounts: [{ threadRef: 'conv-attachment', count: 1 }]
      }
    })
  ];
  const unhandledGate = evaluateProcessingQualityGate(unhandled);
  assert.equal(unhandledGate.ok, false);
  assert.match(unhandledGate.reason, /attachmentsHandled/);

  const handled = structuredClone(unhandled);
  handled[0].payload.processingLedger[0].attachmentsHandled = 'yes(workiq-index)';
  const handledGate = evaluateProcessingQualityGate(handled);
  assert.equal(handledGate.ok, true);

  const legacyCountName = structuredClone(handled);
  legacyCountName[1].payload.processingQuality.threadCounts = legacyCountName[1].payload.processingQuality.ledgerCounts;
  delete legacyCountName[1].payload.processingQuality.ledgerCounts;
  assert.equal(evaluateProcessingQualityGate(legacyCountName).ok, true);

  const directBytesHandled = structuredClone(unhandled);
  directBytesHandled[0].payload.processingLedger[0].attachmentsHandled = 'yes';
  const directBytesGate = evaluateProcessingQualityGate(directBytesHandled);
  assert.equal(directBytesGate.ok, true);

  const failedWithReason = structuredClone(unhandled);
  failedWithReason[0].payload.processingLedger[0].attachmentsHandled = 'failed(encrypted PDF)';
  const failedGate = evaluateProcessingQualityGate(failedWithReason);
  assert.equal(failedGate.ok, true);
});

test('discovery quality gate requires both exact-window semantic passes', () => {
  const window = computeDiscoveryWindow({ now: new Date('2026-07-15T10:00:00.000Z'), scanDays: 4 });
  const complete = markerObj('SCAN_DONE', {
    runId: 'coverage-complete',
    outcome: 'success',
    processingQuality: {
      required: true,
      discoveryPasses: [
        { kind: 'recent-email-enumeration', windowStart: window.start, windowEnd: window.end, itemCount: 3, candidateCount: 2 },
        { kind: 'material-consequence', windowStart: window.start, windowEnd: window.end, itemCount: 1, candidateCount: 1 }
      ]
    }
  });
  const accepted = filterMarkersByProcessingQualityGate([complete], {
    requireDiscoveryCoverage: true,
    requiredDiscoveryWindow: window
  });
  assert.equal(accepted.ok, true);

  const incomplete = markerObj('SCAN_DONE', {
    runId: 'coverage-incomplete',
    outcome: 'success',
    processingQuality: {
      required: true,
      discoveryPasses: [
        { kind: 'recent-email-enumeration', windowStart: window.start, windowEnd: window.end, itemCount: 3, candidateCount: 2 }
      ]
    }
  });
  const rejected = filterMarkersByProcessingQualityGate([incomplete], {
    requireDiscoveryCoverage: true,
    requiredDiscoveryWindow: window
  });
  assert.equal(rejected.ok, false);
  assert.match(rejected.reason, /material-consequence/);
});

test('legacy third attachment-index failure receives a scheduled retry on migration', () => {
  const processing = normalizeProcessing({
    ledger: [{
      itemRef: { type: 'email', id: 'mail-old-attachment' },
      threadRef: 'thread-old-attachment',
      date: '2026-07-01T10:00:00.000Z',
      processedAt: '2026-07-01T11:00:00.000Z',
      attachmentsHandled: 'failed(content-not-indexed)',
      attachmentIndexAttempts: 3,
      reprobeNextScan: false
    }]
  });

  assert.equal(processing.ledger[0].reprobeNextScan, false);
  assert.equal(processing.ledger[0].reprobeAfter, '2026-07-08T11:00:00.000Z');
});

test('Batch 9H NODE_OBSOLETE validates and applies only a stale node disposition', () => {
  const data = migrateToV5({
    version: 5,
    tasks: [{
      id: 'proj-b9h-node',
      taskType: 'project',
      title: 'Node obsolete project',
      status: 'new',
      sourceRefs: [{ id: 'src-old-node', date: '2026-06-20T08:00:00.000Z', link: 'https://example.test/old-node' }],
      pmStatus: {
        current: 'Current state remains open.',
        planned: [{
          id: 'plan-av-go-live',
          text: 'AV Go-Live target 1 Jul 2026 for commissioned rooms',
          date: '2026-07-01',
          evidenceRefIds: ['src-old-node'],
          confidence: 'medium',
          state: 'unconfirmed'
        }],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [{
          id: 'wait-open',
          text: 'Waiting for later sign-off.',
          confidence: 'medium',
          state: 'confirmed'
        }],
        confidence: 'medium'
      },
      lineItems: []
    }]
  });
  const result = applyMarkerBatch(data, [markerObj('NODE_OBSOLETE', {
    taskId: 'proj-b9h-node',
    nodeRef: 'pmStatus.planned:plan-av-go-live',
    obsoleteReason: 'target date passed without completion evidence — needs re-plan'
  })], {
    auditLogFile: null,
    now: new Date('2026-07-08T08:00:00.000Z')
  });
  const project = result.data.tasks[0];

  assert.equal(result.applied, 1);
  assert.equal(project.pmStatus.planned[0].state, 'obsolete');
  assert.equal(project.pmStatus.planned[0].obsoleteReason, 'target date passed without completion evidence — needs re-plan');
  assert.equal(project.pmStatus.waitingOn.length, 1);
  assert.equal(project.history.at(-1).type, 'node-obsolete');

  const future = applyMarkerBatch(data, [markerObj('NODE_OBSOLETE', {
    taskId: 'proj-b9h-node',
    nodeRef: 'wait-open',
    obsoleteReason: 'Should be rejected because this node has no past date.'
  })], {
    auditLogFile: null,
    now: new Date('2026-07-08T08:00:00.000Z')
  });
  assert.equal(future.applied, 0);
  assert.match(future.dropped[0].reason, /not past-dated/);
});

test('Batch 9H NODE_OBSOLETE passes narrow gateway handling and satisfies temporal gate', async () => {
  const dir = resetTmp('node-obsolete-temporal');
  const tasksFile = writeFixture(dir, {
    version: 5,
    reviewQueue: [],
    tasks: [{
      id: 'proj-b9h-temporal',
      taskType: 'project',
      title: 'Temporal node project',
      status: 'new',
      sourceRefs: [{ id: 'src-old', type: 'email', title: 'Old target', date: '2026-06-20T08:00:00.000Z', link: 'https://example.test/old' }],
      pmStatus: {
        current: 'Still waiting for later work.',
        planned: [{
          id: 'plan-av-go-live',
          text: 'AV Go-Live target 1 Jul 2026 for commissioned rooms',
          date: '2026-07-01',
          evidenceRefIds: ['src-old'],
          confidence: 'medium',
          state: 'unconfirmed'
        }],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      lineItems: []
    }]
  });
  const markers = [
    markerObj('NODE_OBSOLETE', {
      taskId: 'proj-b9h-temporal',
      nodeRef: 'pmStatus.planned:plan-av-go-live',
      obsoleteReason: 'target date passed without completion evidence — needs re-plan'
    })
  ];
  const filtered = filterMarkersThroughGateway(markers, approveAll(markers));
  assert.equal(filtered.held.length, 0);

  const output = [
    marker('NODE_OBSOLETE', {
      taskId: 'proj-b9h-temporal',
      nodeRef: 'pmStatus.planned:plan-av-go-live',
      obsoleteReason: 'target date passed without completion evidence — needs re-plan'
    }),
    scanDone({ runId: 'b9h-node-obsolete', outcome: 'success', workIqCalls: 0 }, { now: new Date('2026-07-08T08:00:00.000Z') })
  ].join('\n');
  const result = await runBrainScanOnce({ input: {}, emit() {} }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'b9h-node-obsolete',
    now: new Date('2026-07-08T08:00:00.000Z'),
    _runBrain: async () => ({ ok: true, assistantText: output, counters: { workIqCalls: 0 } }),
    _runGateway: async ({ markers }) => approveAll(markers),
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(result.outcome, 'success');
  assert.equal(result.temporalGate.ok, true);
  assert.equal(saved.tasks[0].pmStatus.planned[0].state, 'obsolete');
  assert.equal(saved.reviewQueue.length, 0);
});

test('Batch 9H content-not-indexed attachment retry holds cursor until third attempt', () => {
  const data = migrateToV5({
    version: 5,
    reviewQueue: [],
    tasks: [{
      id: 'proj-b9h-attachment-retry',
      taskType: 'project',
      title: 'Attachment retry project',
      status: 'new',
      sourceRefs: [{ id: 'src-attach-body', type: 'email', date: '2026-07-08T10:00:00.000Z', link: 'https://example.test/attach-body' }],
      processing: {
        cursorDate: '2026-07-07T00:00:00.000Z',
        lookbackDays: 14,
        threads: { 'thread-attach': { lastProcessedMessageDate: '2026-07-07T00:00:00.000Z' } },
        ledger: []
      },
      pmStatus: {
        current: 'Original current state.',
        planned: [],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      lineItems: [{
        id: 'li-attach',
        title: 'Attachment-backed line',
        status: 'open',
        currentState: 'Attachment pending.',
        evidenceRefIds: ['src-attach-body'],
        state: 'confirmed'
      }]
    }]
  });
  const retryMarker = markerObj('LINEITEM_UPDATE', {
    taskId: 'proj-b9h-attachment-retry',
    lineItemId: 'li-attach',
    patch: {
      currentState: 'Message body checked; attachment content is not indexed yet.',
      confidence: 'medium'
    },
    evidenceRefIds: ['src-attach-body'],
    processingLedger: [{
      itemRef: { type: 'email', id: 'msg-attach' },
      threadRef: 'thread-attach',
      date: '2026-07-08T10:00:00.000Z',
      disposition: 'updates-node',
      nodeRefs: ['li-attach'],
      hasAttachments: true,
      attachmentCount: 1,
      attachmentsHandled: 'failed(content-not-indexed)',
      quote: 'Please see the attached deck.',
      reason: 'WorkIQ returned content-not-indexed after the required alternate attachment query.'
    }]
  });

  const first = applyMarkerBatch(data, [retryMarker], {
    auditLogFile: null,
    now: new Date('2026-07-08T10:30:00.000Z')
  }).data;
  const firstProcessing = first.tasks[0].processing;
  assert.equal(firstProcessing.cursorDate, '2026-07-07T00:00:00.000Z');
  assert.equal(firstProcessing.threads['thread-attach'].lastProcessedMessageDate, '2026-07-07T00:00:00.000Z');
  assert.equal(firstProcessing.ledger[0].attachmentIndexAttempts, 1);
  assert.equal(firstProcessing.ledger[0].reprobeNextScan, true);
  assert.match(first.reviewQueue[0].question, /attachment not indexed yet — re-probe next scan/);

  const second = applyMarkerBatch(first, [retryMarker], {
    auditLogFile: null,
    now: new Date('2026-07-08T11:30:00.000Z')
  }).data;
  assert.equal(second.tasks[0].processing.cursorDate, '2026-07-07T00:00:00.000Z');
  assert.equal(second.tasks[0].processing.ledger[0].attachmentIndexAttempts, 2);

  const third = applyMarkerBatch(second, [retryMarker], {
    auditLogFile: null,
    now: new Date('2026-07-08T12:30:00.000Z')
  }).data;
  assert.equal(third.tasks[0].processing.cursorDate, '2026-07-08T10:00:00.000Z');
  assert.equal(third.tasks[0].processing.threads['thread-attach'].lastProcessedMessageDate, '2026-07-08T10:00:00.000Z');
  assert.equal(third.tasks[0].processing.ledger[0].attachmentIndexAttempts, 3);
  assert.equal(third.tasks[0].processing.ledger[0].reprobeNextScan, false);
  assert.equal(third.reviewQueue.length, 1);
});

test('Batch 9F granular quality gate applies complete mutations and holds only ledgerless marker', async () => {
  const dir = resetTmp('granular-quality-gate');
  const tasksFile = writeFixture(dir, {
    version: 5,
    reviewQueue: [],
    tasks: [{
      id: 'proj-b9f-granular',
      taskType: 'project',
      title: 'Granular quality project',
      status: 'new',
      sourceRefs: [1, 2, 3, 4].map(index => ({
        id: `src-gq-${index}`,
        type: 'email',
        title: `Source ${index}`,
        date: `2026-07-08T0${index}:00:00.000Z`,
        link: `https://example.test/gq/${index}`
      })),
      pmStatus: {
        current: 'Original current state.',
        planned: [],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      lineItems: [1, 2, 3, 4].map(index => ({
        id: `li-gq-${index}`,
        title: `Line ${index}`,
        category: 'workstream',
        status: 'open',
        currentState: `Original ${index}`,
        evidenceRefIds: [`src-gq-${index}`],
        state: 'confirmed'
      }))
    }]
  });

  const lineUpdate = (index, withLedger = true) => marker('LINEITEM_UPDATE', {
    taskId: 'proj-b9f-granular',
    lineItemId: `li-gq-${index}`,
    patch: {
      currentState: `Updated ${index}`,
      confidence: 'medium'
    },
    evidenceRefIds: [`src-gq-${index}`],
    ...(withLedger
      ? {
          processingLedger: [{
            itemRef: { type: 'email', id: `msg-gq-${index}` },
            threadRef: 'thread-gq',
            date: `2026-07-08T0${index}:00:00.000Z`,
            disposition: 'updates-node',
            nodeRefs: [`li-gq-${index}`],
            attachmentsHandled: 'none',
            quote: `Message ${index} updates line ${index}.`,
            reason: `Message ${index} has a complete ledger trail.`
          }]
        }
      : {
          processingEnumeratedItems: [{
            itemRef: { type: 'email', id: `msg-gq-${index}` },
            threadRef: 'thread-gq'
          }]
        })
  });

  const output = [
    lineUpdate(1),
    lineUpdate(2),
    lineUpdate(3),
    lineUpdate(4, false),
    scanDone({
      runId: 'b9f-granular-quality',
      outcome: 'success',
      workIqCalls: 4,
      processingQuality: {
        required: true,
        enumeratedItems: [1, 2, 3, 4].map(index => ({
          itemRef: { type: 'email', id: `msg-gq-${index}` },
          threadRef: 'thread-gq',
          hasAttachments: false
        }))
      }
    }, { now: new Date('2026-07-08T08:00:00.000Z') })
  ].join('\n');

  const result = await runBrainScanOnce({ input: {}, emit() {} }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'b9f-granular-quality',
    now: new Date('2026-07-08T08:00:00.000Z'),
    _runBrain: async () => ({ ok: true, assistantText: output, counters: { workIqCalls: 4 } }),
    _runGateway: async ({ markers }) => approveAll(markers),
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const project = saved.tasks[0];

  assert.equal(result.outcome, 'partial');
  assert.equal(result.qualityGate.ok, false);
  assert.equal(result.qualityGate.heldMarkers, 1);
  assert.equal(result.heldMarkers, 1);
  assert.equal(project.lineItems.find(item => item.id === 'li-gq-1').currentState, 'Updated 1');
  assert.equal(project.lineItems.find(item => item.id === 'li-gq-2').currentState, 'Updated 2');
  assert.equal(project.lineItems.find(item => item.id === 'li-gq-3').currentState, 'Updated 3');
  assert.equal(project.lineItems.find(item => item.id === 'li-gq-4').currentState, 'Original 4');
  assert.match(saved.reviewQueue[0].question, /missing ledger disposition for enumerated item email:msg-gq-4/);
});

test('Batch 9F temporal pass still applies complete stale cleanup when unrelated quality marker is held', async () => {
  const dir = resetTmp('temporal-independent-quality');
  const tasksFile = writeFixture(dir, {
    version: 5,
    reviewQueue: [],
    tasks: [{
      id: 'proj-b9f-temporal',
      taskType: 'project',
      title: 'Temporal independent project',
      status: 'new',
      sourceRefs: [{
        id: 'src-old-temporal',
        type: 'email',
        title: 'Old AV target',
        date: '2026-06-20T08:00:00.000Z',
        link: 'https://example.test/old-temporal'
      }, {
        id: 'src-fresh-temporal',
        type: 'email',
        title: 'Fresh temporal evidence',
        date: '2026-07-08T07:30:00.000Z',
        link: 'https://example.test/fresh-temporal'
      }, {
        id: 'src-unrelated',
        type: 'email',
        title: 'Unrelated update',
        date: '2026-07-08T07:45:00.000Z',
        link: 'https://example.test/unrelated'
      }],
      pmStatus: {
        current: 'Original current state.',
        planned: [{
          id: 'plan-av-go-live',
          text: 'AV Go-Live target 1 Jul 2026 for commissioned rooms',
          date: '2026-07-01',
          evidenceRefIds: ['src-old-temporal'],
          confidence: 'medium',
          state: 'unconfirmed'
        }],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      lineItems: [{
        id: 'li-see-av-commissioning',
        title: 'AV commissioning',
        category: 'workstream',
        status: 'open',
        currentState: 'AV sign-off requested toward a 1 Jul 2026 go-live.',
        evidenceRefIds: ['src-old-temporal'],
        state: 'unconfirmed'
      }, {
        id: 'li-unrelated',
        title: 'Unrelated workstream',
        category: 'workstream',
        status: 'open',
        currentState: 'Original unrelated state.',
        evidenceRefIds: ['src-unrelated'],
        state: 'confirmed'
      }]
    }]
  });

  const output = [
    marker('PROJECT_UPDATE', {
      taskId: 'proj-b9f-temporal',
      pmStatus: {
        current: 'Original current state.',
        planned: [{
          id: 'plan-av-go-live',
          text: 'AV Go-Live target 1 Jul 2026 for commissioned rooms',
          date: '2026-07-01',
          evidenceRefIds: ['src-fresh-temporal'],
          confidence: 'medium',
          state: 'obsolete',
          obsoleteReason: 'The planned date is before the current scan date and fresh evidence supersedes it.'
        }],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      processingLedger: [{
        itemRef: { type: 'email', id: 'msg-stale-pm' },
        threadRef: 'thread-temporal',
        date: '2026-07-08T07:30:00.000Z',
        disposition: 'updates-node',
        nodeRefs: ['plan-av-go-live'],
        attachmentsHandled: 'none',
        quote: 'The old go-live is folded into the later scope.',
        reason: 'Fresh evidence supersedes the stale planned date.'
      }],
      evidenceRefIds: ['src-fresh-temporal']
    }),
    marker('LINEITEM_UPDATE', {
      taskId: 'proj-b9f-temporal',
      lineItemId: 'li-see-av-commissioning',
      patch: {
        state: 'obsolete',
        currentState: 'The old 1 Jul 2026 AV go-live target is obsolete pending the later scope.',
        obsoleteReason: 'The date has passed and fresh evidence supersedes it.',
        confidence: 'medium'
      },
      processingLedger: [{
        itemRef: { type: 'email', id: 'msg-stale-line' },
        threadRef: 'thread-temporal',
        date: '2026-07-08T07:31:00.000Z',
        disposition: 'updates-node',
        nodeRefs: ['li-see-av-commissioning'],
        attachmentsHandled: 'none',
        quote: 'The old go-live is folded into the later scope.',
        reason: 'Fresh evidence supersedes the stale line item state.'
      }],
      evidenceRefIds: ['src-fresh-temporal']
    }),
    marker('LINEITEM_UPDATE', {
      taskId: 'proj-b9f-temporal',
      lineItemId: 'li-unrelated',
      patch: {
        currentState: 'This update lacks a ledger disposition and must be held.',
        confidence: 'medium'
      },
      processingEnumeratedItems: [{
        itemRef: { type: 'teams', id: 'msg-unrelated-ledgerless' },
        threadRef: 'thread-unrelated'
      }],
      evidenceRefIds: ['src-unrelated']
    }),
    scanDone({
      runId: 'b9f-temporal-independent',
      outcome: 'success',
      workIqCalls: 3,
      processingQuality: {
        required: true,
        enumeratedItems: [{
          itemRef: { type: 'email', id: 'msg-stale-pm' },
          threadRef: 'thread-temporal'
        }, {
          itemRef: { type: 'email', id: 'msg-stale-line' },
          threadRef: 'thread-temporal'
        }, {
          itemRef: { type: 'teams', id: 'msg-unrelated-ledgerless' },
          threadRef: 'thread-unrelated'
        }]
      }
    }, { now: new Date('2026-07-08T08:00:00.000Z') })
  ].join('\n');

  const result = await runBrainScanOnce({ input: {}, emit() {} }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'b9f-temporal-independent',
    now: new Date('2026-07-08T08:00:00.000Z'),
    _runBrain: async () => ({ ok: true, assistantText: output, counters: { workIqCalls: 3 } }),
    _runGateway: async ({ markers }) => approveAll(markers),
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const project = saved.tasks[0];

  assert.equal(result.outcome, 'partial');
  assert.equal(result.qualityGate.ok, false);
  assert.equal(result.temporalGate.ok, true);
  assert.equal(project.pmStatus.planned[0].state, 'obsolete');
  assert.equal(project.lineItems.find(item => item.id === 'li-see-av-commissioning').state, 'obsolete');
  assert.equal(project.lineItems.find(item => item.id === 'li-unrelated').currentState, 'Original unrelated state.');
  assert.match(saved.reviewQueue[0].question, /missing ledger disposition for enumerated item teams:msg-unrelated-ledgerless/);
});

test('Batch 9 temporal pass queues stale reviews without holding approved markers', async () => {
  const dir = resetTmp('temporal-pass-granular');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'proj-b9-temporal',
      taskType: 'project',
      title: 'Temporal project',
      status: 'new',
      sourceRefs: [{ id: 'src-old', type: 'email', title: 'Old target', date: '2026-06-20T08:00:00.000Z', link: 'https://example.test/old' }],
      pmStatus: {
        current: 'Current state',
        planned: [{
          id: 'plan-av-go-live',
          text: 'AV Go-Live target 1 Jul 2026 for commissioned rooms',
          date: '2026-07-01',
          evidenceRefIds: ['src-old'],
          confidence: 'medium',
          state: 'unconfirmed'
        }],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      lineItems: [{
        id: 'li-see-av-commissioning',
        title: 'AV commissioning',
        category: 'workstream',
        status: 'open',
        currentState: 'AV sign-off requested toward a 1 Jul 2026 go-live.',
        evidenceRefIds: ['src-old'],
        state: 'unconfirmed'
      }]
    }]
  });

  const output = scanDone({
    runId: 'temporal-pass-granular',
    outcome: 'success',
    workIqCalls: 0
  }, { now: new Date('2026-07-07T08:00:00.000Z') });
  const result = await runBrainScanOnce({ input: {}, emit() {} }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'temporal-pass-granular',
    now: new Date('2026-07-07T08:00:00.000Z'),
    _runBrain: async () => ({ ok: true, assistantText: output, counters: { workIqCalls: 0 } }),
    _runGateway: async ({ markers }) => approveAll(markers),
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(result.outcome, 'partial');
  assert.equal(result.temporalGate.ok, false);
  assert.equal(result.appliedMarkers, 1);
  assert.equal(result.heldMarkers, 0);
  assert.equal(result.reviewItems, 2);
  assert.equal(saved.tasks[0].pmStatus.planned[0].state, 'unconfirmed');
  assert.equal(saved.reviewQueue.length, 2);
  assert.ok(saved.reviewQueue.every(item => /stale date unreconciled:/.test(item.question)));
});

test('Batch 9 temporal pass allows explicit obsolete stale-node cleanup with evidence', async () => {
  const dir = resetTmp('temporal-pass-cleanup');
  const tasksFile = writeFixture(dir, {
    version: 5,
    tasks: [{
      id: 'proj-b9-temporal',
      taskType: 'project',
      title: 'Temporal project',
      status: 'new',
      sourceRefs: [{ id: 'src-old', type: 'email', title: 'Old target', date: '2026-06-20T08:00:00.000Z', link: 'https://example.test/old' }],
      pmStatus: {
        current: 'Current state',
        planned: [{
          id: 'plan-av-go-live',
          text: 'AV Go-Live target 1 Jul 2026 for commissioned rooms',
          date: '2026-07-01',
          evidenceRefIds: ['src-old'],
          confidence: 'medium',
          state: 'unconfirmed'
        }],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      lineItems: [{
        id: 'li-see-av-commissioning',
        title: 'AV commissioning',
        category: 'workstream',
        status: 'open',
        currentState: 'AV sign-off requested toward a 1 Jul 2026 go-live.',
        evidenceRefIds: ['src-old'],
        state: 'unconfirmed'
      }]
    }]
  });

  const sourceRef = {
    id: 'src-fresh-temporal',
    type: 'email',
    title: 'Current verification',
    date: '2026-07-07T07:30:00.000Z',
    link: 'https://example.test/fresh',
    evidenceText: 'Current scan found no evidence that the 1 Jul AV go-live remains valid.'
  };
  const output = [
    marker('PROJECT_UPDATE', {
      taskId: 'proj-b9-temporal',
      sourceRefs: [sourceRef],
      pmStatus: {
        current: 'Current state',
        planned: [{
          id: 'plan-av-go-live',
          text: 'AV Go-Live target 1 Jul 2026 for commissioned rooms',
          date: '2026-07-01',
          evidenceRefIds: ['src-fresh-temporal'],
          confidence: 'medium',
          state: 'obsolete',
          obsoleteReason: 'The planned date is before the current scan date and no fresh evidence confirms it remains valid.'
        }],
        userActions: [],
        problems: [],
        risks: [],
        waitingOn: [],
        confidence: 'medium'
      },
      evidenceRefIds: ['src-fresh-temporal']
    }),
    marker('LINEITEM_UPDATE', {
      taskId: 'proj-b9-temporal',
      lineItemId: 'li-see-av-commissioning',
      patch: {
        state: 'obsolete',
        currentState: 'The old 1 Jul 2026 AV go-live target is obsolete pending fresh schedule evidence.',
        obsoleteReason: 'The date has passed and the scan did not find fresh confirmation.',
        confidence: 'medium'
      },
      evidenceRefIds: ['src-fresh-temporal']
    }),
    scanDone({
      runId: 'temporal-pass-cleanup',
      outcome: 'success',
      workIqCalls: 1
    }, { now: new Date('2026-07-07T08:00:00.000Z') })
  ].join('\n');

  const result = await runBrainScanOnce({ input: {}, emit() {} }, {
    tasksFile,
    brainWorkDir: path.join(dir, 'brain-work'),
    runId: 'temporal-pass-cleanup',
    now: new Date('2026-07-07T08:00:00.000Z'),
    _runBrain: async () => ({ ok: true, assistantText: output, counters: { workIqCalls: 1 } }),
    _runGateway: async ({ markers }) => approveAll(markers),
    _writeJsonFileAtomic: (file, data) => writeJsonFileAtomic(file, data, { maxBackups: 0 })
  });
  const saved = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));

  assert.equal(result.outcome, 'success');
  assert.equal(result.temporalGate.ok, true);
  assert.equal(saved.tasks[0].pmStatus.planned[0].state, 'obsolete');
  assert.equal(saved.tasks[0].lineItems[0].state, 'obsolete');
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
