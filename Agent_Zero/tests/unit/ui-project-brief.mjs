import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const html = fs.readFileSync(path.join(repoRoot, 'index.html'), 'utf8');

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}`);
  assert.notEqual(start, -1, `function ${name} not found`);
  const braceStart = source.indexOf('{', start);
  let depth = 0;
  for (let i = braceStart; i < source.length; i++) {
    if (source[i] === '{') depth++;
    else if (source[i] === '}') {
      depth--;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`function ${name} did not close`);
}

function buildHarness(extraNames = []) {
  const names = [
    'asArray',
    'parseDateValue',
    'parseDateMs',
    'isInactiveProjectNode',
    'isReviewOnlyProjectNode',
    'isTrustedProjectNode',
    'localDayStartMs',
    'priorityFromSignals',
    'deriveLineItemPriority',
    'pmEntryFromValue',
    'pmEntries',
    'activePmEntries',
    'activeProjectDueDates',
    'mostUrgentPriority',
    'deriveProjectPriority',
    'deriveTaskPriority',
    'earliestTaskDueMs',
    'compareTaskPriority',
    'compareLineItemPriority',
    'normalizeLineItemRelevance',
    'lineItemRelevanceBand',
    'compareLineItemDueTitle',
    'compareLineItemRelevance',
    'groupActiveLineItems',
    'decisionFocusItems',
    'lineItemDisplayMeta',
    'failedAttachmentCoverage',
    'lineItemEvidenceRefIds',
    ...extraNames
  ];
  const code = [
    'const DERIVED_PRIORITY_ORDER = Object.freeze({ critical: 0, high: 1, medium: 2, low: 3 });',
    'const DAY_MS = 24 * 60 * 60 * 1000;',
    'function isArchivedTask(task) { return Boolean(task && (task.archived || task.supersededBy)); }',
    "function isProjectTask(task) { return Boolean(task && task.taskType === 'project'); }",
    "function hasStructuredTaskLayout(task) { return Boolean(task && task.taskType === 'project'); }",
    ...[...new Set(names)].map(name => extractFunction(html, name))
  ].join('\n\n');
  const context = {};
  vm.runInNewContext(code, context);
  return context;
}

test('derived project and line-item priority is deterministic and drives stable sorting', () => {
  const ui = buildHarness();
  const now = new Date('2026-07-15T12:00:00Z').getTime();

  assert.equal(ui.deriveLineItemPriority({ status: 'blocked' }, now), 'critical');
  assert.equal(ui.deriveLineItemPriority({ status: 'open', dueAt: '2026-07-14' }, now), 'critical');
  assert.equal(ui.deriveLineItemPriority({ status: 'open', userActionRequired: true }, now), 'high');
  assert.equal(ui.deriveLineItemPriority({ status: 'open', risk: 'Supplier slip' }, now), 'high');
  assert.equal(ui.deriveLineItemPriority({ status: 'open', dueAt: '2026-07-20' }, now), 'high');
  assert.equal(ui.deriveLineItemPriority({ status: 'open', dueAt: '2026-07-31' }, now), 'medium');
  assert.equal(ui.deriveLineItemPriority({ status: 'open' }, now), 'medium');
  assert.equal(ui.deriveLineItemPriority({ status: 'open', priority: 'critical' }, now), 'critical');
  assert.equal(ui.deriveLineItemPriority({ status: 'blocked', needsReview: true }, now), 'high');
  assert.equal(ui.deriveLineItemPriority({ status: 'done', problem: 'Historical' }, now), 'low');
  assert.equal(ui.deriveLineItemPriority({ status: 'open', state: 'obsolete', dueAt: '2026-07-01' }, now), 'low');

  const emptyPm = { current: '', planned: [], userActions: [], problems: [], risks: [], waitingOn: [] };
  const blockedProject = { taskType: 'project', status: 'in-progress', pmStatus: emptyPm, lineItems: [{ status: 'blocked' }] };
  const riskProject = { taskType: 'project', status: 'in-progress', pmStatus: { ...emptyPm, risks: [{ text: 'Budget risk' }] }, lineItems: [] };
  const historicalMilestoneProject = { taskType: 'project', status: 'in-progress', pmStatus: { ...emptyPm, planned: [{ text: 'Handover happened', date: '2026-07-01', state: 'confirmed' }] }, lineItems: [] };
  const normalProject = { id: 'project', title: 'Project', taskType: 'project', status: 'in-progress', pmStatus: emptyPm, lineItems: [] };
  const normalSingle = { id: 'single', title: 'Single', taskType: 'single', status: 'in-progress' };

  assert.equal(ui.deriveProjectPriority(blockedProject, now), 'critical');
  assert.equal(ui.deriveProjectPriority(riskProject, now), 'high');
  assert.equal(ui.deriveProjectPriority({ ...riskProject, pmStatus: { ...emptyPm, risks: [{ text: 'Unconfirmed', state: 'unconfirmed' }] } }, now), 'medium');
  assert.equal(ui.deriveProjectPriority(historicalMilestoneProject, now), 'medium');
  assert.equal(ui.deriveProjectPriority({
    taskType: 'project',
    status: 'in-progress',
    pmStatus: emptyPm,
    lineItems: [{ status: 'blocked', dueAt: '2026-07-01', needsReview: true }]
  }, now), 'high');
  assert.equal(ui.deriveProjectPriority(normalProject, now), 'medium');
  assert.equal(ui.deriveTaskPriority({ taskType: 'single', status: 'needs-attention' }, now), 'critical');
  assert.equal(ui.deriveTaskPriority({ taskType: 'single', status: 'done' }, now), 'low');

  const sortedTasks = [normalSingle, normalProject].sort((a, b) => ui.compareTaskPriority(a, b, now));
  assert.equal(sortedTasks[0].id, 'project');
  const sortedLines = [
    { id: 'medium', title: 'Medium', status: 'open' },
    { id: 'high', title: 'High', status: 'open', risk: 'Risk' },
    { id: 'critical', title: 'Critical', status: 'blocked' },
    { id: 'low', title: 'Low', status: 'done' }
  ].sort((a, b) => ui.compareLineItemPriority(a, b, now));
  assert.equal(sortedLines.map(item => item.id).join(','), 'critical,high,medium,low');
});

test('project brief derives concise active counts, next milestone, and evidence trust', () => {
  const ui = buildHarness([
    'sourceRefDate',
    'sortedSourceRefs',
    'formatSourceDate',
    'uniqueBriefTexts',
    'nextProjectMilestone',
    'projectBriefData',
    'projectEvidenceTrust'
  ]);
  const now = new Date('2026-07-15T12:00:00Z').getTime();
  const task = {
    taskType: 'project',
    pmStatus: {
      current: 'Executing',
      confidence: 'high',
      userActions: [
        {
          text: 'Approve invoice',
          lastVerifiedMessageDate: '2026-07-14',
          threadCheck: { coverage: 'complete', checkedThroughMessageDate: '2026-07-14' }
        },
        { text: 'Old approval signal', needsReview: true }
      ],
      problems: [{ text: 'Access blocked' }, { text: 'Possible old blocker', state: 'unconfirmed' }],
      risks: [{ text: 'Schedule risk' }, { text: 'Possible risk', needsReview: true }],
      waitingOn: [{ text: 'Supplier response' }],
      planned: [
        { text: 'Later milestone', date: '2026-08-20' },
        { text: 'Next milestone', date: '2026-07-20' },
        { text: 'Old milestone', date: '2026-07-01', state: 'obsolete', obsoleteReason: 'Superseded' }
      ]
    },
    lineItems: [
      { title: 'User line', status: 'open', userActionRequired: true, userAction: 'Send response' },
      { title: 'Blocked line', status: 'blocked', problem: 'Permit missing' },
      { title: 'Unconfirmed subtopic', status: 'blocked', needsReview: true, userAction: 'Check old request' },
      { title: 'Completed line', status: 'done', risk: 'Historical risk', userActionRequired: true }
    ],
    sourceRefs: [{ id: 'src-1', date: '2026-07-14' }]
  };

  const brief = ui.projectBriefData(task, now);
  assert.equal(brief.userActions.length, 2);
  assert.equal(brief.blockers.length, 2);
  assert.equal(brief.risks.length, 1);
  assert.equal(brief.waiting.length, 1);
  assert.equal(brief.signalsToVerify.length, 4);
  assert.equal(brief.milestone.text, 'Next milestone');
  assert.equal(brief.milestone.overdue, false);
  assert.equal(brief.decisionFocus.length, 3);
  assert.equal(brief.sourceCoverageFailures.length, 0);

  const verified = ui.projectEvidenceTrust(task, now);
  assert.equal(verified.level, 'verified');
  assert.equal(verified.freshness, 'fresh');

  task.sourceRefs.push({ id: 'src-2', date: '2026-07-15' });
  task.pmStatus.userActions[0].lastVerifiedMessageDate = '2026-07-10';
  task.pmStatus.userActions[0].threadCheck.coverage = 'partial';
  const evidenceOnly = ui.projectEvidenceTrust(task, now);
  assert.equal(evidenceOnly.level, 'evidence');
});

test('semantic relevance groups and orders active line items before legacy fallback', () => {
  const ui = buildHarness();
  const now = new Date('2026-07-15T12:00:00Z').getTime();
  const relevance = (score, reason = `Project relevance ${score}`) => ({ score, reason, evidenceRefIds: [`src-${score}`] });
  const items = [
    { id: 'legacy-normal', title: 'Legacy normal', status: 'open' },
    { id: 'reference', title: 'Reference', status: 'blocked', dueAt: '2026-07-01', relevance: relevance(10) },
    { id: 'next-zulu', title: 'Zulu', status: 'open', dueAt: '2026-07-18', relevance: relevance(60) },
    { id: 'act', title: 'Act', status: 'open', relevance: relevance(92) },
    { id: 'monitor', title: 'Monitor', status: 'open', relevance: relevance(30) },
    { id: 'next-earlier', title: 'Alpha', status: 'open', dueAt: '2026-07-18', relevance: relevance(60) },
    { id: 'next-later', title: 'Later due', status: 'open', dueAt: '2026-07-22', relevance: relevance(60) },
    { id: 'legacy-blocked', title: 'Legacy blocker', status: 'blocked' },
    { id: 'done', title: 'Done', status: 'done', relevance: relevance(100) }
  ];

  assert.equal(typeof ui.normalizeLineItemRelevance, 'function');
  assert.equal(typeof ui.groupActiveLineItems, 'function');
  assert.equal(ui.lineItemRelevanceBand(75).label, 'Act now');
  assert.equal(ui.lineItemRelevanceBand(50).label, 'Next');
  assert.equal(ui.lineItemRelevanceBand(25).label, 'Monitor');
  assert.equal(ui.lineItemRelevanceBand(0).label, 'Reference');

  const groups = ui.groupActiveLineItems(items, now);
  assert.equal(groups.map(group => group.label).join(','), 'Act now,Next,Monitor,Reference,Unranked');
  assert.equal(groups.flatMap(group => group.items).map(item => item.id).join(','),
    'act,next-earlier,next-zulu,next-later,monitor,reference,legacy-blocked,legacy-normal');
  assert.equal(groups.at(-1).range, null);
  assert.equal(ui.normalizeLineItemRelevance(items[0]), null);
});

test('review and confidence signals do not alter semantic relevance rank', () => {
  const ui = buildHarness();
  const now = new Date('2026-07-15T12:00:00Z').getTime();
  const items = [
    {
      id: 'review-act-now',
      title: 'Review this decision',
      status: 'blocked',
      needsReview: true,
      confidence: 'low',
      relevance: { score: 96, reason: 'Decision blocks the project path.', evidenceRefIds: ['src-review'] }
    },
    {
      id: 'trusted-act-now',
      title: 'Trusted action',
      status: 'open',
      confidence: 'high',
      relevance: { score: 80, reason: 'Action is important but less decisive.', evidenceRefIds: ['src-trusted'] }
    }
  ];

  const groups = ui.groupActiveLineItems(items, now);
  assert.equal(groups[0].label, 'Act now');
  assert.equal(groups[0].items.map(item => item.id).join(','), 'review-act-now,trusted-act-now');
  assert.equal(ui.isReviewOnlyProjectNode(groups[0].items[0]), true);
});

test('optional line-item metadata stays quiet when owner and due date are absent', () => {
  const ui = buildHarness();
  const meta = ui.lineItemDisplayMeta({ status: 'open' }, new Date('2026-07-15T12:00:00Z').getTime());

  assert.equal(meta.owner, null);
  assert.equal(meta.dueAt, null);
  assert.equal(meta.dueMs, null);
  assert.equal(meta.overdue, false);
  assert.doesNotMatch(html, /Unassigned/);
  assert.doesNotMatch(html, /Due: Not set/);
});

test('failed attachment handling produces explicit incomplete source coverage', () => {
  const ui = buildHarness();
  const task = {
    processing: {
      ledger: [
        { itemRef: { id: 'mail-1' }, attachmentsHandled: 'failed(content-not-indexed)' },
        { itemRef: { id: 'mail-2' }, attachmentsHandled: ' FAILED(encrypted PDF)' },
        { itemRef: { id: 'mail-3' }, attachmentsHandled: 'yes(workiq-index)' },
        { itemRef: { id: 'mail-4' }, attachmentsHandled: 'none' }
      ]
    }
  };

  assert.equal(typeof ui.failedAttachmentCoverage, 'function');
  assert.equal(ui.failedAttachmentCoverage(task).length, 2);
  assert.match(html, /Source coverage incomplete/);
  assert.match(html, /Attachment-only facts may be missing/);
});

test('Seestrasse ranks the explicit CorpNet blocker above lower-scored dust', () => {
  const ui = buildHarness();
  const now = new Date('2026-07-15T12:00:00Z').getTime();
  const task = {
    lineItems: [
      {
        id: 'li-see-dust',
        title: 'Seestrasse construction dust',
        status: 'blocked',
        dueAt: '2026-07-14',
        problem: 'Dust containment remains open',
        relevance: {
          score: 38,
          reason: 'Operational nuisance with a contained workstream impact.',
          evidenceRefIds: ['src-dust']
        }
      },
      {
        id: 'li-see-corpnet',
        title: 'CorpNet blocker',
        status: 'blocked',
        needsReview: true,
        relevance: {
          score: 93,
          reason: 'CorpNet blocks the critical project network path.',
          evidenceRefIds: ['src-corpnet']
        }
      }
    ]
  };

  const focus = ui.decisionFocusItems(task, now);
  assert.equal(focus.map(item => item.id).join(','), 'li-see-corpnet,li-see-dust');
  const groups = ui.groupActiveLineItems(task.lineItems, now);
  assert.equal(groups.map(group => group.label).join(','), 'Act now,Monitor');
});

test('project UI keeps deep detail collapsed and gates legacy controls from health state', () => {
  assert.match(html, /fetch\('\/api\/health'/);
  assert.match(html, /serverScanEngine === 'agency'/);
  assert.match(html, /id="btnFindDuplicates"[^>]*legacy-only-control|legacy-only-control" id="btnFindDuplicates"/);
  assert.match(html, /id="btnMergeTasks"[^>]*legacy-only-control|legacy-only-control" id="btnMergeTasks"/);
  assert.match(html, /@media \(max-width: 840px\)/);
  assert.match(html, /:focus-visible/);

  const sourceRenderer = extractFunction(html, 'renderSourceRefsList');
  const factRenderer = extractFunction(html, 'renderFactSheetPanel');
  const lineRenderer = extractFunction(html, 'renderProjectLineItems');
  const lineDetailRenderer = extractFunction(html, 'renderLineItemDetails');
  const lineRowRenderer = extractFunction(html, 'renderLineItemRow');
  assert.doesNotMatch(sourceRenderer, /<details\$\{open\}|<details open>/);
  assert.doesNotMatch(factRenderer, /<details open>/);
  assert.match(lineRenderer, /completed-lineitems/);
  assert.match(lineRenderer, /groupActiveLineItems/);
  assert.match(lineDetailRenderer, /<details class="lineitem-detail">/);
  assert.match(lineDetailRenderer, /Evidence/);
  assert.match(lineRowRenderer, /Why this matters/);
  assert.match(lineRowRenderer, /confidenceBadge/);
  assert.match(html, /Act now/);
  assert.match(html, /Unranked/);
  assert.match(html, /Decision Focus/);
  assert.match(html, /Signals to verify/);
  assert.match(html, /Actions to verify/);
  assert.doesNotMatch(html, /const endTime\s*=/);
  assert.doesNotMatch(html, /function updateFrozenStatus\s*\(/);
});
