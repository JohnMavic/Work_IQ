import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyMarkerBatch } from '../../brain/marker-applier.js';
import { filterMarkersThroughGateway, parseGatewayDecisions } from '../../brain/reality-gateway.js';
import { migrateToV5 } from '../../brain/tasks-v5.js';
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
