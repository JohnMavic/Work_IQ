import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMarkerBatch } from '../../brain/marker-applier.js';
import { filterMarkersThroughGateway, parseGatewayDecisions, runRealityGateway } from '../../brain/reality-gateway.js';
import { migrateToV5 } from '../../brain/tasks-v5.js';
import { repairCircleContamination } from '../../scripts/repair-circle-contamination.mjs';
import { repairSourceLinks } from '../../scripts/repair-source-links.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-batch5');

function resetTmp(name) {
  const dir = path.join(tmpRoot, name);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function marker(type, payload) {
  return { type, payload, raw: `[${type}] ${JSON.stringify(payload)}` };
}

function approveAll(markers) {
  return {
    ok: true,
    text: JSON.stringify({
      decisions: markers.map((_, markerIndex) => ({
        markerIndex,
        decision: 'approve',
        reason: 'Approved in fixture.'
      }))
    })
  };
}

function baseProjectData() {
  return migrateToV5({
    version: 5,
    tasks: [{
      id: 'proj-circle',
      taskType: 'project',
      title: 'Zurich The Circle AV refresh',
      summary: 'Zurich The Circle project in Switzerland.',
      status: 'new',
      sourceRefs: [{
        id: 'src-zurich',
        type: 'email',
        title: 'Zurich source',
        date: '2026-07-01T08:00:00.000Z',
        link: 'https://outlook.office365.com/owa/?ItemID=AAMkReal',
        evidenceText: 'Zurich evidence.'
      }],
      lineItems: [{
        id: 'li-install',
        title: 'Install hardware',
        status: 'open',
        currentState: 'Waiting for schedule.',
        evidenceRefIds: ['src-zurich']
      }],
      factSheet: {
        sections: {
          overview: [{ id: 'fs-overview', text: 'Project country: Switzerland.', evidenceRefIds: ['src-zurich'], confidence: 'medium' }]
        }
      }
    }]
  });
}

test('B-7 contamination fixture is held as NEEDS_REVIEW instead of updating similar project', () => {
  const data = baseProjectData();
  const markers = [marker('PROJECT_UPDATE', {
    taskId: 'proj-circle',
    summary: 'Norway MPR project update from Christian Moerken.',
    pmStatus: {
      current: 'Norway MPR schedule is blocked by supplier delivery.',
      planned: [],
      userActions: [],
      problems: [],
      risks: [{ text: 'Norway delivery risk.', evidence: 'src-zurich', confidence: 'medium' }],
      waitingOn: [],
      confidence: 'medium'
    },
    evidenceRefIds: ['src-zurich']
  })];
  const gateway = {
    ok: true,
    text: JSON.stringify({
      decisions: [{ markerIndex: 0, decision: 'needs-review', reason: 'Country mismatch: Norway evidence does not safely belong to Zurich.' }]
    })
  };

  const filtered = filterMarkersThroughGateway(markers, gateway);
  const result = applyMarkerBatch(data, filtered.markers, { auditLogFile: null });
  const project = result.data.tasks.find(task => task.id === 'proj-circle');

  assert.equal(filtered.held.length, 1);
  assert.equal(project.summary, 'Zurich The Circle project in Switzerland.');
  assert.equal(result.data.reviewQueue.length, 1);
  assert.match(result.data.reviewQueue[0].question, /Country mismatch/);
});

test('B-8 citation-token source links are nulled by deny-first guard', () => {
  const dir = resetTmp('b8');
  const markers = [marker('TASK_NEW', {
    taskId: 'task-token-link',
    title: 'Token link task',
    sourceRef: {
      id: 'src-token',
      type: 'email',
      title: 'Fabricated Outlook link',
      link: 'https://outlook.office.com/mail/inbox/id/turn1search112'
    }
  })];

  const result = applyMarkerBatch(migrateToV5({ version: 5, tasks: [] }), markers, {
    auditLogFile: path.join(dir, 'audit.jsonl')
  });
  const task = result.data.tasks.find(item => item.id === 'task-token-link');
  const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');

  assert.equal(result.applied, 1);
  assert.equal(task.sourceRefs[0].link, null);
  assert.match(audit, /fabricated WorkIQ citation token/);
});

test('B-9 done plus waiting is converted to NEEDS_REVIEW even if gateway approves', () => {
  const data = baseProjectData();
  const markers = [marker('LINEITEM_UPDATE', {
    taskId: 'proj-circle',
    lineItemId: 'li-install',
    patch: { status: 'done', waitingOn: 'supplier delivery', confidence: 'high' },
    evidenceRefIds: ['src-zurich']
  })];

  const filtered = filterMarkersThroughGateway(markers, approveAll(markers));
  const result = applyMarkerBatch(data, filtered.markers, { auditLogFile: null });
  const line = result.data.tasks[0].lineItems[0];

  assert.equal(filtered.held.length, 1);
  assert.equal(line.status, 'open');
  assert.equal(result.data.reviewQueue.length, 1);
  assert.match(result.data.reviewQueue[0].question, /done while still waiting/);
});

test('B-10 obvious project update is applied when gateway explicitly approves', () => {
  const data = baseProjectData();
  const markers = [marker('PROJECT_UPDATE', {
    taskId: 'proj-circle',
    summary: 'Zurich The Circle update: approval received.',
    sourceRefs: [{
      id: 'src-new-zurich',
      type: 'email',
      title: 'Zurich approval',
      date: '2026-07-06T08:00:00.000Z',
      link: 'https://outlook.office365.com/owa/?ItemID=AAMkNew'
    }],
    supersedesTaskIds: []
  })];

  const filtered = filterMarkersThroughGateway(markers, approveAll(markers));
  const result = applyMarkerBatch(data, filtered.markers, { auditLogFile: null });
  const project = result.data.tasks[0];

  assert.equal(filtered.held.length, 0);
  assert.equal(project.summary, 'Zurich The Circle update: approval received.');
  assert.equal(project.sourceRefs.some(ref => ref.id === 'src-new-zurich'), true);
});

test('B-11 fabricated source tokens in free text are scrubbed and audited', () => {
  const dir = resetTmp('b11');
  const data = baseProjectData();
  const markers = [marker('PROJECT_UPDATE', {
    taskId: 'proj-circle',
    pmStatus: {
      current: 'See https://outlook.office.com/mail/inbox/id/turn1search8 for the status.',
      planned: [],
      userActions: [],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    },
    evidenceRefIds: ['src-zurich']
  })];

  const result = applyMarkerBatch(data, markers, {
    auditLogFile: path.join(dir, 'audit.jsonl')
  });
  const current = result.data.tasks[0].pmStatus.current;
  const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');

  assert.equal(result.applied, 1);
  assert.doesNotMatch(current, /turn1search8/);
  assert.match(current, /\[removed fabricated source link\]/);
  assert.match(audit, /scrub-fabricated-source-token/);
});

test('B-12 gateway failure holds project updates fail-closed despite existing evidence', () => {
  const data = baseProjectData();
  const markers = [marker('PROJECT_UPDATE', {
    taskId: 'proj-circle',
    summary: 'Should not apply on gateway failure.',
    pmStatus: {
      current: 'Updated with existing evidence.',
      planned: [],
      userActions: [],
      problems: [],
      risks: [],
      waitingOn: [],
      confidence: 'medium'
    },
    evidenceRefIds: ['src-zurich']
  })];

  const filtered = filterMarkersThroughGateway(markers, { ok: false, error: 'gateway unavailable' });
  const result = applyMarkerBatch(data, filtered.markers, { auditLogFile: null });

  assert.equal(filtered.held.length, 1);
  assert.equal(result.data.tasks[0].summary, 'Zurich The Circle project in Switzerland.');
  assert.match(result.data.reviewQueue[0].question, /gateway unavailable/);
});

test('B-13 omitted gateway judgment becomes NEEDS_REVIEW, never approve', () => {
  const data = baseProjectData();
  const markers = [
    marker('TASK_NEW', {
      taskId: 'standalone-ok',
      title: 'Standalone approved',
      sourceRef: { id: 'src-standalone', link: 'https://outlook.office365.com/owa/?ItemID=Standalone' }
    }),
    marker('PROJECT_UPDATE', {
      taskId: 'proj-circle',
      summary: 'Omitted judgment must not apply.'
    })
  ];
  const gateway = {
    ok: true,
    text: JSON.stringify({
      decisions: [{ markerIndex: 0, decision: 'approve', reason: 'Standalone action is safe.' }]
    })
  };

  const filtered = filterMarkersThroughGateway(markers, gateway);
  const result = applyMarkerBatch(data, filtered.markers, { auditLogFile: null });

  assert.equal(filtered.approved.length, 1);
  assert.equal(filtered.held.length, 1);
  assert.ok(result.data.tasks.find(task => task.id === 'standalone-ok'));
  assert.equal(result.data.tasks.find(task => task.id === 'proj-circle').summary, 'Zurich The Circle project in Switzerland.');
  assert.match(result.data.reviewQueue[0].question, /omitted/i);
});

test('B-14 unusual but non-deny real links are kept losslessly and flagged', () => {
  const dir = resetTmp('b14');
  const markers = [marker('TASK_NEW', {
    taskId: 'task-unusual-link',
    title: 'Unusual source link',
    sourceRef: {
      id: 'src-unusual',
      type: 'email',
      title: 'Unusual source',
      link: 'https://example.test/custom/message/123'
    }
  })];

  const result = applyMarkerBatch(migrateToV5({ version: 5, tasks: [] }), markers, {
    auditLogFile: path.join(dir, 'audit.jsonl')
  });
  const task = result.data.tasks.find(item => item.id === 'task-unusual-link');
  const audit = fs.readFileSync(path.join(dir, 'audit.jsonl'), 'utf8');

  assert.equal(task.sourceRefs[0].link, 'https://example.test/custom/message/123');
  assert.match(audit, /flag-unusual-source-link/);
});

test('factSheet merge applies additive section patches with evidence', () => {
  const data = baseProjectData();
  const markers = [marker('FACTSHEET_UPDATE', {
    taskId: 'proj-circle',
    sectionPatches: {
      status: [{
        op: 'add',
        text: 'Approval received on 6 July 2026.',
        date: '2026-07-06T08:00:00.000Z',
        evidenceRefIds: ['src-zurich'],
        confidence: 'medium'
      }]
    }
  })];

  const result = applyMarkerBatch(data, markers, { auditLogFile: null });
  const entries = result.data.tasks[0].factSheet.sections.status;

  assert.equal(result.applied, 1);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].text, 'Approval received on 6 July 2026.');
});

test('gateway parser marks omitted decisions as needs-review', () => {
  const parsed = parseGatewayDecisions('{"decisions":[{"markerIndex":0,"decision":"approve","reason":"ok."}]}', 2);

  assert.equal(parsed.decisions[0].decision, 'approve');
  assert.equal(parsed.decisions[1].decision, 'needs-review');
  assert.match(parsed.decisions[1].reason, /omitted/);
});

test('gateway parser extracts decisions JSON while ignoring prose and corrected payloads', () => {
  const parsed = parseGatewayDecisions([
    'I reviewed the markers and would rewrite one, but the server must ignore that.',
    '{"decisions":[{"markerIndex":0,"decision":"approve","reason":"Original marker is supported.","payload":{"mutated":true}}]}'
  ].join('\n'), 1);

  assert.equal(parsed.decisions[0].decision, 'approve');
  assert.equal(Object.hasOwn(parsed.decisions[0], 'payload'), false);
});

test('gateway parser accepts documented audit failure output with prose-prefixed pretty JSON', () => {
  const fixture = fs.readFileSync(path.join(repoRoot, 'tests', 'fixtures', 'gateway-audit-fail-output.txt'), 'utf8');
  const parsed = parseGatewayDecisions(fixture, 4);

  assert.equal(parsed.totalParseFailure, false);
  assert.equal(parsed.format, 'json');
  assert.equal(parsed.decisions[0].decision, 'approve');
  assert.equal(parsed.decisions[2].decision, 'approve');
  assert.equal(parsed.decisions[3].decision, 'needs-review');
});

test('gateway parser accepts line verdicts and one broken verdict line does not block others', () => {
  const data = baseProjectData();
  const markers = [
    marker('TASK_NEW', {
      taskId: 'single-line-ok-1',
      title: 'Standalone one',
      sourceRef: { id: 'src-single-line-1', link: 'https://example.test/line/1' }
    }),
    marker('PROJECT_UPDATE', {
      taskId: 'proj-circle',
      summary: 'This project update must be held because its verdict line is malformed.',
      evidenceRefIds: ['src-zurich']
    }),
    marker('TASK_NEW', {
      taskId: 'single-line-ok-2',
      title: 'Standalone two',
      sourceRef: { id: 'src-single-line-2', link: 'https://example.test/line/2' }
    })
  ];
  const gateway = {
    ok: true,
    text: [
      'GATEWAY_DECISION\t0\tapprove\tStandalone one is supported.',
      'GATEWAY_DECISION\t1\tapprove-ish\tMalformed decision token.',
      'GATEWAY_DECISION\t2\tapprove\tStandalone two is supported.'
    ].join('\n')
  };

  const filtered = filterMarkersThroughGateway(markers, gateway);
  const result = applyMarkerBatch(data, filtered.markers, { auditLogFile: null });

  assert.equal(filtered.approved.length, 2);
  assert.equal(filtered.held.length, 1);
  assert.equal(filtered.gatewayParsed, false);
  assert.ok(result.data.tasks.find(task => task.id === 'single-line-ok-1'));
  assert.ok(result.data.tasks.find(task => task.id === 'single-line-ok-2'));
  assert.equal(result.data.tasks.find(task => task.id === 'proj-circle').summary, 'Zurich The Circle project in Switzerland.');
  assert.match(result.data.reviewQueue[0].question, /malformed/i);
});

test('reality gateway retries exactly once after total parse failure', async () => {
  const dir = resetTmp('gateway-retry');
  const stateFile = path.join(dir, 'scan-state.md');
  fs.writeFileSync(stateFile, '# state\n', 'utf8');
  const markers = [marker('TASK_NEW', {
    taskId: 'retry-task',
    title: 'Retry task',
    sourceRef: { id: 'src-retry', link: 'https://example.test/retry' }
  })];
  const prompts = [];

  const result = await runRealityGateway({
    stateFile,
    factSheetFiles: [],
    markers,
    brainWorkDir: dir,
    runId: 'retry-run',
    _runBrain: async ({ prompt }) => {
      prompts.push(prompt);
      return {
        ok: true,
        assistantText: prompts.length === 1
          ? 'No machine readable verdict is present.'
          : 'GATEWAY_DECISION\t0\tapprove\tRetry returned a parseable verdict.',
        counters: { workIqCalls: 0 },
        durationMs: 1
      };
    }
  });
  const parsed = parseGatewayDecisions(result.text, 1);

  assert.equal(prompts.length, 2);
  assert.equal(result.retryCount, 1);
  assert.match(prompts[1], /only retry/i);
  assert.equal(parsed.decisions[0].decision, 'approve');
});

test('reality gateway holds all after one failed retry on total parse failure', async () => {
  const dir = resetTmp('gateway-retry-fails');
  const stateFile = path.join(dir, 'scan-state.md');
  fs.writeFileSync(stateFile, '# state\n', 'utf8');
  const markers = [
    marker('PROJECT_UPDATE', { taskId: 'proj-circle', summary: 'Should be held.' }),
    marker('TASK_NEW', { taskId: 'single-after-retry-fail', title: 'Should also be held after parse retry fail.' })
  ];
  let calls = 0;

  const result = await runRealityGateway({
    stateFile,
    markers,
    brainWorkDir: dir,
    runId: 'retry-fail-run',
    _runBrain: async () => {
      calls++;
      return {
        ok: true,
        assistantText: calls === 1 ? 'not parseable' : 'still not parseable',
        counters: { workIqCalls: 0 },
        durationMs: 1
      };
    }
  });
  const filtered = filterMarkersThroughGateway(markers, result);

  assert.equal(calls, 2);
  assert.equal(result.retryCount, 1);
  assert.equal(filtered.approved.length, 0);
  assert.equal(filtered.held.length, 2);
  assert.match(filtered.held[0].reason, /re-run scan/);
});

test('shared turn1search11 fabricated links are reconstructed from archived source tasks', () => {
  const data = migrateToV5({
    version: 5,
    tasks: [
      {
        id: 'source-zones',
        taskType: 'single',
        title: 'Zones MPR hardware delivery concern for August deployment',
        link: 'https://outlook.office365.com/owa/?ItemID=ZonesReal',
        archived: true,
        supersededBy: 'proj-circle'
      },
      {
        id: 'source-handover',
        taskType: 'single',
        title: 'Zones Project Contact Update Circle HUB Phase 2 MPR',
        link: 'https://outlook.office365.com/owa/?ItemID=HandoverReal',
        archived: true,
        supersededBy: 'proj-circle'
      },
      {
        id: 'proj-circle',
        taskType: 'project',
        title: 'Circle',
        supersedesTaskIds: ['source-zones', 'source-handover'],
        sourceRefs: [
          {
            id: 'src-zones-aug-1783',
            title: 'Zones MPR hardware delivery concern for August deployment',
            sourceTaskId: 'source-zones',
            link: 'https://outlook.office.com/mail/inbox/id/turn1search11'
          },
          {
            id: 'src-6d2675a9',
            title: 'Zones Project Contact Update Circle HUB Phase 2 MPR',
            sourceTaskId: 'source-handover',
            link: 'https://outlook.office.com/mail/inbox/id/turn1search11'
          }
        ],
        additionalLinks: ['https://outlook.office.com/mail/inbox/id/turn1search11']
      }
    ]
  });

  const result = repairSourceLinks(data, { now: new Date('2026-07-06T08:00:00.000Z') });
  const project = result.data.tasks.find(task => task.id === 'proj-circle');

  assert.equal(result.summary.repaired, 2);
  assert.equal(project.sourceRefs.find(ref => ref.id === 'src-zones-aug-1783').link, 'https://outlook.office365.com/owa/?ItemID=ZonesReal');
  assert.equal(project.sourceRefs.find(ref => ref.id === 'src-6d2675a9').link, 'https://outlook.office365.com/owa/?ItemID=HandoverReal');
  assert.deepEqual(project.additionalLinks, [
    'https://outlook.office365.com/owa/?ItemID=ZonesReal',
    'https://outlook.office365.com/owa/?ItemID=HandoverReal'
  ]);
});

test('circle repair removes Moerken-stemmed refs from active project while preserving review payload', () => {
  const data = migrateToV5({
    version: 5,
    reviewQueue: [],
    tasks: [
      {
        id: 'f663726c-source-task-id',
        taskType: 'single',
        archived: true,
        from: 'Christian Moerken',
        summary: 'Norway MPR source task.',
        supersededBy: 'proj-zurich-circle-hublcr'
      },
      {
        id: 'proj-zurich-circle-hublcr',
        taskType: 'project',
        title: 'Zurich The Circle - FY26 HUB LCR AV & MPR Refresh',
        history: [{
          timestamp: '2026-07-05T13:23:08.772Z',
          type: 'batch5-repair',
          text: 'batch5-6b-circle-contamination: moved contaminated Moerken/Norway Circle facts to reviewQueue. SourceRefs retained.'
        }],
        brainState: {
          needsReview: true,
          reviewReason: 'The 1 Jul 2026 Christian Moerken escalation is not Circle evidence. | Source link repair could not reconstruct 2 sourceRef link(s): src-7ab6764a, src-zones-aug-1783'
        },
        sourceRefs: [
          {
            id: 'src-94315dce',
            title: 'MPR refresh schedule shift (Nov -> Dec)',
            link: 'https://teams.microsoft.com/l/message/circle'
          },
          {
            id: 'src-f663726c',
            title: 'MPR refresh projects (timeline & coordination)',
            sourceTaskId: 'f663726c',
            link: 'https://teams.microsoft.com/l/message/norway-source'
          },
          {
            id: 'src-moerken-20260701',
            from: 'Christian Moerken',
            title: 'Dual MPR refresh - repeated schedule misses',
            link: 'https://teams.microsoft.com/l/message/moerken'
          }
        ],
        additionalLinks: [
          'https://teams.microsoft.com/l/message/circle',
          'https://teams.microsoft.com/l/message/norway-source',
          'https://teams.microsoft.com/l/message/moerken'
        ],
        lineItems: [
          {
            id: 'li-circle-dualmpr',
            title: 'Dual MPR rooms',
            evidenceRefIds: ['src-94315dce', 'src-f663726c'],
            sourceTaskIds: ['f663726c-source-task-id']
          },
          {
            id: 'li-circle-timeline',
            title: 'MPR refresh schedule shift (Nov -> Dec 2026, freeze to ~12 Feb 2027)',
            status: 'in-progress',
            evidenceRefIds: ['src-94315dce'],
            needsReview: true,
            reviewReason: 'Recorded Dec schedule conflicts with Christian Moerken August deployment message.'
          }
        ],
        factSheet: {
          sections: {
            scopeGoals: [{
              id: 'fs-dualmpr',
              text: 'Dual MPR refresh remains in planning.',
              evidenceRefIds: ['src-94315dce', 'src-f663726c']
            }],
            sources: [{
              id: 'fs-source-moerken',
              text: 'MPR refresh projects source',
              evidenceRefIds: ['src-f663726c']
            }]
          }
        }
      }
    ]
  });

  const result = repairCircleContamination(data, { now: new Date('2026-07-06T09:00:00.000Z') });
  const project = result.data.tasks.find(task => task.id === 'proj-zurich-circle-hublcr');
  const timeline = project.lineItems.find(item => item.id === 'li-circle-timeline');
  const serializedActiveProject = JSON.stringify(project);

  assert.deepEqual(result.summary.removedSourceRefs.sort(), ['src-f663726c', 'src-moerken-20260701']);
  assert.equal(result.summary.timelineEvidenceRetained, 1);
  assert.equal(project.sourceRefs.some(ref => ref.id === 'src-f663726c' || ref.id === 'src-moerken-20260701'), false);
  assert.equal(project.additionalLinks.includes('https://teams.microsoft.com/l/message/moerken'), false);
  assert.deepEqual(project.lineItems.find(item => item.id === 'li-circle-dualmpr').evidenceRefIds, ['src-94315dce']);
  assert.deepEqual(project.factSheet.sections.scopeGoals[0].evidenceRefIds, ['src-94315dce']);
  assert.equal(project.factSheet.sections.sources.length, 0);
  assert.equal(timeline.status, 'in-progress');
  assert.equal(timeline.needsReview, undefined);
  assert.equal(timeline.reviewReason, undefined);
  assert.doesNotMatch(serializedActiveProject, /Moerken/);
  assert.match(JSON.stringify(result.data.reviewQueue), /Christian Moerken/);
});
