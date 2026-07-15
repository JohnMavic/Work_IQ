import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  selectCorrectableIssuesFromGate,
  deriveCorrectableIssues,
  parseCorrectionLines,
  acceptCorrections,
  buildCorrectionPrompt,
  runProcessingQualityCorrection,
  CORRECTION_TAG
} from '../../brain/processing-quality-correction.js';
import { filterMarkersByProcessingQualityGate } from '../../brain/processing-ledger.js';

// Boundary invariant under test throughout this file (assignment §10): the correction pass can
// ONLY supply a disposition for an item that the scan already enumerated on a processing-ledger
// marker. It never fabricates a disposition for an item that was never enumerated.

const COLT_KEY = 'email:colt-1';

function ledgerItem(overrides = {}) {
  return {
    itemRef: { type: 'email', id: 'colt-1' },
    threadRef: 'thread-colt',
    date: '2026-07-14T08:00:00.000Z',
    disposition: 'updates-node',
    nodeRefs: ['li-1'],
    attachmentsHandled: 'none',
    quote: 'Colt confirmed the Zurich circuit delivery window for August.',
    reason: 'This item updates the existing circuit line item; no new node needed.',
    ...overrides
  };
}

function enumeratedItem(overrides = {}) {
  return {
    itemRef: { type: 'email', id: 'colt-1' },
    threadRef: 'thread-colt',
    date: '2026-07-14T08:00:00.000Z',
    ...overrides
  };
}

function ledgerMarker({ type = 'LINEITEM_UPDATE', enumerated = [], ledger = [], extra = {} } = {}) {
  const payload = {
    taskId: 'proj-seestrasse',
    lineItemId: 'li-1',
    ...extra,
    processing: { enumeratedItems: enumerated, ledger }
  };
  return { type, payload, raw: `[${type}] ${JSON.stringify(payload)}` };
}

function markersWithMissingColt() {
  return [ledgerMarker({ enumerated: [enumeratedItem()], ledger: [] })];
}

test('issue extraction only selects exact missing-enumerated-item failures', () => {
  const markers = [
    // 0: legitimately missing disposition for an enumerated item -> correctable.
    ledgerMarker({ enumerated: [enumeratedItem()], ledger: [] }),
    // 1: a malformed ledger entry -> validation hold, NOT a completeness omission.
    ledgerMarker({
      type: 'PROJECT_UPDATE',
      enumerated: [],
      ledger: [{ itemRef: { type: 'email', id: 'bad-1' }, threadRef: 'thread-bad', date: 'not-a-date', disposition: 'updates-node', nodeRefs: [], attachmentsHandled: 'none', quote: 'x', reason: 'y' }]
    }),
    // 2: a scan-wide enumerated item that maps to no marker -> review reason, NOT correctable.
    {
      type: 'SCAN_DONE',
      payload: {
        processingQuality: {
          required: true,
          enumeratedItems: [{ itemRef: { type: 'email', id: 'orphan-1' }, threadRef: 'thread-orphan' }]
        }
      },
      raw: '[SCAN_DONE] {}'
    }
  ];

  const { gate, issues } = deriveCorrectableIssues(markers, {});
  assert.equal(gate.ok, false);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, COLT_KEY);
  assert.deepEqual([...issues[0].markerIndexes], [0]);
  assert.equal(issues[0].threadRef, 'thread-colt');
  assert.equal(issues[0].date, '2026-07-14T08:00:00.000Z');
  assert.equal(issues[0].hasAttachment, false);
});

test('parser accepts valid physical lines and ignores code fences and prose', () => {
  const text = [
    'Here is my correction analysis (prose that must be ignored):',
    `[${CORRECTION_TAG}] {"markerIndex":0,"ledgerItem":{"disposition":"updates-node"}}`,
    '```',
    `[${CORRECTION_TAG}] {"markerIndex":9,"ledgerItem":{"disposition":"fenced-must-be-ignored"}}`,
    '```',
    `[${CORRECTION_TAG}] {"markerIndex":1,"ledgerItem":}`,
    'Trailing prose line.'
  ].join('\n');

  const parsed = parseCorrectionLines(text);
  assert.equal(parsed.corrections.length, 1);
  assert.equal(parsed.corrections[0].payload.markerIndex, 0);
  assert.equal(parsed.errors.length, 1);
  assert.equal(parsed.errors[0].line, 6);
});

test('valid exact-key/thread/date correction appends ledger to copied marker and makes the pre-gateway quality gate pass', () => {
  const markers = markersWithMissingColt();
  const { issues } = deriveCorrectableIssues(markers, {});
  const result = acceptCorrections({
    markers,
    issues,
    corrections: [{ markerIndex: 0, ledgerItem: ledgerItem() }]
  });

  assert.equal(result.applied.length, 1);
  assert.equal(result.rejected.length, 0);
  assert.equal(result.correctedMarkers[0].payload.processingLedger.length, 1);
  assert.equal(result.correctedMarkers[0].payload.processingLedger[0].itemRef.id, 'colt-1');
  // raw representation is updated consistently.
  assert.ok(result.correctedMarkers[0].raw.includes('processingLedger'));

  const postGate = filterMarkersByProcessingQualityGate(result.correctedMarkers, {});
  assert.equal(postGate.ok, true);
});

test('original markers remain byte and deep equal after acceptance', () => {
  const markers = markersWithMissingColt();
  const before = JSON.stringify(markers);
  const { issues } = deriveCorrectableIssues(markers, {});
  const result = acceptCorrections({
    markers,
    issues,
    corrections: [{ markerIndex: 0, ledgerItem: ledgerItem() }]
  });

  assert.equal(JSON.stringify(markers), before);
  assert.notEqual(result.correctedMarkers, markers);
  assert.notEqual(result.correctedMarkers[0], markers[0]);
  assert.equal(markers[0].payload.processingLedger, undefined);
});

test('wrong key, wrong thread, wrong date, invalid ledger, extra keys, invalid index/type, and duplicates are rejected', () => {
  // Two processing-ledger markers: index 0 enumerates colt; index 1 is a marker type that cannot
  // carry a processing ledger.
  const markers = [
    ledgerMarker({ enumerated: [enumeratedItem()], ledger: [] }),
    { type: 'NEEDS_REVIEW', payload: { question: 'x' }, raw: '[NEEDS_REVIEW] {}' }
  ];
  const { issues } = deriveCorrectableIssues(markers, {});
  assert.equal(issues.length, 1);

  const cases = [
    { name: 'wrong key', correction: { markerIndex: 0, ledgerItem: ledgerItem({ itemRef: { type: 'email', id: 'not-colt' } }) }, match: /not one of the missing enumerated item keys/ },
    { name: 'wrong thread', correction: { markerIndex: 0, ledgerItem: ledgerItem({ threadRef: 'thread-other' }) }, match: /threadRef mismatch/ },
    { name: 'wrong date', correction: { markerIndex: 0, ledgerItem: ledgerItem({ date: '2020-01-01T00:00:00.000Z' }) }, match: /date mismatch/ },
    { name: 'invalid ledger', correction: { markerIndex: 0, ledgerItem: ledgerItem({ quote: '' }) }, match: /quote is required/ },
    { name: 'extra payload key', correction: { markerIndex: 0, ledgerItem: ledgerItem(), note: 'nope' }, match: /unexpected correction field/ },
    { name: 'invalid index', correction: { markerIndex: 99, ledgerItem: ledgerItem() }, match: /not a valid marker index/ },
    { name: 'invalid marker type', correction: { markerIndex: 1, ledgerItem: ledgerItem() }, match: /cannot carry a processing ledger/ }
  ];

  for (const testCase of cases) {
    const result = acceptCorrections({ markers, issues, corrections: [testCase.correction] });
    assert.equal(result.applied.length, 0, `${testCase.name} should apply nothing`);
    assert.equal(result.rejected.length, 1, `${testCase.name} should reject one`);
    assert.match(result.rejected[0].reason, testCase.match, testCase.name);
  }

  // Duplicate key: first accepted, second rejected.
  const dup = acceptCorrections({
    markers,
    issues,
    corrections: [
      { markerIndex: 0, ledgerItem: ledgerItem() },
      { markerIndex: 0, ledgerItem: ledgerItem() }
    ]
  });
  assert.equal(dup.applied.length, 1);
  assert.equal(dup.rejected.length, 1);
  assert.match(dup.rejected[0].reason, /duplicate correction/);
});

test('attachment-bearing item cannot be accepted with attachmentsHandled none', () => {
  const markers = [ledgerMarker({ enumerated: [enumeratedItem({ hasAttachments: true })], ledger: [] })];
  const { issues } = deriveCorrectableIssues(markers, {});
  assert.equal(issues[0].hasAttachment, true);

  const rejectedRun = acceptCorrections({
    markers,
    issues,
    corrections: [{ markerIndex: 0, ledgerItem: ledgerItem({ attachmentsHandled: 'none' }) }]
  });
  assert.equal(rejectedRun.applied.length, 0);
  assert.match(rejectedRun.rejected[0].reason, /attachment-bearing item .* cannot be accepted/);

  const acceptedRun = acceptCorrections({
    markers,
    issues,
    corrections: [{ markerIndex: 0, ledgerItem: ledgerItem({ attachmentsHandled: 'yes(workiq-index)' }) }]
  });
  assert.equal(acceptedRun.applied.length, 1);
});

test('an unproven or unmapped item remains uncorrected and partial', () => {
  // Two enumerated items missing dispositions; the model only supplies a valid one for colt-1.
  const markers = [ledgerMarker({
    enumerated: [enumeratedItem(), enumeratedItem({ itemRef: { type: 'email', id: 'colt-2' }, threadRef: 'thread-colt-2' })],
    ledger: []
  })];
  const { issues } = deriveCorrectableIssues(markers, {});
  assert.equal(issues.length, 2);

  const result = acceptCorrections({
    markers,
    issues,
    corrections: [
      { markerIndex: 0, ledgerItem: ledgerItem() },
      // An "unmapped" attempt for colt-2 that targets a marker index that did not enumerate it.
      { markerIndex: 5, ledgerItem: ledgerItem({ itemRef: { type: 'email', id: 'colt-2' }, threadRef: 'thread-colt-2' }) }
    ]
  });
  assert.equal(result.applied.length, 1);
  assert.equal(result.rejected.length, 1);

  // colt-2 remains uncorrected, so the gate is still not clean -> the scan stays partial/reviewable.
  const postGate = filterMarkersByProcessingQualityGate(result.correctedMarkers, {});
  assert.equal(postGate.ok, false);
  assert.match(postGate.reason || '', /missing ledger disposition for enumerated item email:colt-2/);
});

test('never solves an item that was never enumerated', () => {
  // No marker enumerated colt -> nothing correctable, and a correction for it is rejected.
  const markers = [ledgerMarker({ enumerated: [], ledger: [] })];
  const { issues } = deriveCorrectableIssues(markers, {});
  assert.equal(issues.length, 0);

  const result = acceptCorrections({
    markers,
    issues,
    corrections: [{ markerIndex: 0, ledgerItem: ledgerItem() }]
  });
  assert.equal(result.applied.length, 0);
  assert.match(result.rejected[0].reason, /not one of the missing enumerated item keys/);
});

test('no correctable issue means the correction runner never calls the brain', async () => {
  // Marker enumerates colt AND already dispositions it -> gate clean, no eligible issues.
  const markers = [ledgerMarker({ enumerated: [enumeratedItem()], ledger: [ledgerItem()] })];
  let brainCalls = 0;
  const result = await runProcessingQualityCorrection({
    markers,
    gateOptions: {},
    _runBrain: async () => { brainCalls++; return { ok: true, assistantText: '', counters: { workIqCalls: 0 } }; }
  });

  assert.equal(brainCalls, 0);
  assert.equal(result.corrected, false);
  assert.equal(result.correctedMarkers, markers);
  assert.equal(result.telemetry.attempted, false);
  assert.equal(result.telemetry.eligibleIssues, 0);
  assert.equal(result.telemetry.preGateOk, true);
});

test('runner invokes the brain exactly once and applies a valid correction with accurate telemetry', async () => {
  const markers = markersWithMissingColt();
  let brainCalls = 0;
  const line = `[${CORRECTION_TAG}] ${JSON.stringify({ markerIndex: 0, ledgerItem: ledgerItem() })}`;
  const result = await runProcessingQualityCorrection({
    markers,
    gateOptions: {},
    _runBrain: async ({ prompt }) => {
      brainCalls++;
      assert.match(prompt, /Processing-Ledger Completeness Correction/);
      return { ok: true, assistantText: `analysis\n${line}\n`, counters: { workIqCalls: 1 } };
    }
  });

  assert.equal(brainCalls, 1);
  assert.equal(result.corrected, true);
  assert.equal(result.telemetry.attempted, true);
  assert.equal(result.telemetry.eligibleIssues, 1);
  assert.equal(result.telemetry.runOk, true);
  assert.equal(result.telemetry.parsed, 1);
  assert.equal(result.telemetry.received, 1);
  assert.equal(result.telemetry.applied, 1);
  assert.equal(result.telemetry.rejected, 0);
  assert.equal(result.telemetry.preGateOk, false);
  assert.equal(result.telemetry.postCorrectionGateOk, true);
  assert.equal(result.telemetry.workIqCalls, 1);
  assert.equal(markers[0].payload.processingLedger, undefined); // input untouched
});

test('runner is single-attempt: malformed or empty output leaves markers unchanged and partial', async () => {
  const markers = markersWithMissingColt();
  let brainCalls = 0;
  const result = await runProcessingQualityCorrection({
    markers,
    gateOptions: {},
    _runBrain: async () => {
      brainCalls++;
      return { ok: true, assistantText: `[${CORRECTION_TAG}] {"markerIndex":0,"ledgerItem":}`, counters: { workIqCalls: 0 } };
    }
  });

  assert.equal(brainCalls, 1);
  assert.equal(result.corrected, false);
  assert.equal(result.correctedMarkers, markers);
  assert.equal(result.telemetry.attempted, true);
  assert.equal(result.telemetry.parsed, 0);
  assert.equal(result.telemetry.received, 1);
  assert.equal(result.telemetry.applied, 0);
  assert.equal(result.telemetry.postCorrectionGateOk, false);
});

test('runner continues safely when the brain throws', async () => {
  const markers = markersWithMissingColt();
  const result = await runProcessingQualityCorrection({
    markers,
    gateOptions: {},
    _runBrain: async () => { throw new Error('brain unavailable'); }
  });

  assert.equal(result.corrected, false);
  assert.equal(result.correctedMarkers, markers);
  assert.equal(result.telemetry.attempted, true);
  assert.equal(result.telemetry.runOk, false);
  assert.equal(result.telemetry.applied, 0);
});

test('buildCorrectionPrompt lists filenames, indexed markers, keys, and the physical-line grammar', () => {
  const markers = markersWithMissingColt();
  const { issues } = deriveCorrectableIssues(markers, {});
  const prompt = buildCorrectionPrompt({
    stateFile: '/tmp/brain-work/scan-state-run-x.md',
    factSheetFiles: ['/tmp/brain-work/factsheet-proj-seestrasse-run-x.md'],
    markers,
    issues
  });

  assert.match(prompt, /scan-state-run-x\.md/);
  assert.match(prompt, /factsheet-proj-seestrasse-run-x\.md/);
  assert.match(prompt, /0: \[LINEITEM_UPDATE\]/);
  assert.match(prompt, /email:colt-1/);
  assert.match(prompt, /\[LEDGER_CORRECTION\] \{"markerIndex":N/);
  assert.match(prompt, /read-only WorkIQ query/i);
  assert.match(prompt, /Do NOT change tasks/);
  assert.match(prompt, /emit NOTHING/);
});

// -----------------------------------------------------------------------------------------------
// Scan-wide (global) REPLACE-ITEM-IDENTITY — the exact real B2 topology (generic fixture names,
// identical identity relationships): an item enumerated ONLY in SCAN_DONE, dispositioned once on a
// uniquely source-mapped marker under an ALIAS itemRef, with global ledgerCounts already satisfied.
// -----------------------------------------------------------------------------------------------

const B2_CANON_KEY = 'email:colt-b2';
const B2_THREAD = 'thread-b2';
const B2_ALIAS_DATE = '2026-07-15T13:33:00.000Z';

function b2Enumerated(overrides = {}) {
  return { itemRef: { type: 'email', id: 'colt-b2' }, threadRef: B2_THREAD, ...overrides };
}

function b2AliasLedger(overrides = {}) {
  return {
    itemRef: { type: 'email', id: 'colt-b2-reply-1333' },
    threadRef: B2_THREAD,
    date: B2_ALIAS_DATE,
    disposition: 'updates-node',
    nodeRefs: ['li-b2'],
    attachmentsHandled: 'none',
    quote: 'Yes, please proceed from my side. Has Anastasiya given her approval as well?',
    reason: 'Fresh 15 Jul evidence resolves the previously pending resilience decision.',
    ...overrides
  };
}

function b2SourceRef(overrides = {}) {
  return {
    id: 'src-b2',
    itemId: 'colt-b2',
    conversationId: 'colt-b2-conv',
    threadRef: B2_THREAD,
    type: 'email',
    title: 'RE: Request: Colt circuit protection',
    from: 'Someone / Martin',
    date: '2026-07-15',
    link: 'https://example.test/colt-b2',
    ...overrides
  };
}

function b2LineitemMarker({ type = 'LINEITEM_UPDATE', sourceRefs, ledger, extra = {} } = {}) {
  const payload = {
    taskId: 'proj-b2',
    lineItemId: 'li-b2',
    sourceRefs: sourceRefs || [b2SourceRef()],
    processingLedger: ledger || [b2AliasLedger()],
    ...extra
  };
  return { type, payload, raw: `[${type}] ${JSON.stringify(payload)}` };
}

function b2ScanDone({ enumerated, ledgerCounts, omitLedgerCounts = false } = {}) {
  const processingQuality = {
    required: true,
    enumeratedItems: enumerated || [b2Enumerated()]
  };
  if (!omitLedgerCounts) {
    processingQuality.ledgerCounts = ledgerCounts || [{ threadRef: B2_THREAD, count: 1 }];
  }
  const payload = { processingQuality };
  return { type: 'SCAN_DONE', payload, raw: `[SCAN_DONE] ${JSON.stringify(payload)}` };
}

function b2Markers(opts = {}) {
  return [b2LineitemMarker(opts.marker), b2ScanDone(opts.scanDone)];
}

// The exact replacement the correction brain is expected to emit: the existing alias slot copied
// verbatim with ONLY its itemRef changed to the globally enumerated itemRef.
function b2Replacement(overrides = {}) {
  return { ...b2AliasLedger(), itemRef: { type: 'email', id: 'colt-b2' }, ...overrides };
}

test('B2 filter gate yields held=0 plus a scan_done review reason for the missing global key', () => {
  const gate = filterMarkersByProcessingQualityGate(b2Markers(), {});
  assert.equal(gate.ok, false);
  assert.equal(gate.held.length, 0, 'no marker is held');
  assert.equal(gate.reviewReasons.length, 1, 'exactly one scan-wide review reason');
  assert.equal(gate.reviewReasons[0].source, 'scan_done');
  assert.match(gate.reviewReasons[0].reason, /missing ledger disposition for enumerated item email:colt-b2/);
});

test('B2 selector finds exactly one global issue via SourceRef.itemId + exact threadRef', () => {
  const markers = b2Markers();
  const { issues } = deriveCorrectableIssues(markers, {});
  assert.equal(issues.length, 1);
  assert.equal(issues[0].key, B2_CANON_KEY);
  assert.equal(issues[0].mode, 'replace-item-identity');
  assert.equal(issues[0].markerIndex, 0);
  assert.deepEqual([...issues[0].markerIndexes], [0]);
  assert.equal(issues[0].threadRef, B2_THREAD);
});

test('B2 issue mode is replace-item-identity and points to the exact existing ledger slot', () => {
  const markers = b2Markers();
  const { issues } = deriveCorrectableIssues(markers, {});
  const issue = issues[0];
  assert.equal(issue.container, 'processingLedger');
  assert.equal(issue.slotIndex, 0);
  assert.deepEqual(issue.existingLedgerItem, b2AliasLedger());
  assert.deepEqual(issue.enumeratedItem.itemRef, { type: 'email', id: 'colt-b2' });
});

test('B2 replacement copies the existing ledger exactly except itemRef: replaces (not appends), keeps thread count 1, cleans the gate', () => {
  const markers = b2Markers();
  const before = JSON.stringify(markers);
  const { issues } = deriveCorrectableIssues(markers, {});
  const result = acceptCorrections({
    markers,
    issues,
    corrections: [{ markerIndex: 0, ledgerItem: b2Replacement() }]
  });

  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].mode, 'replace-item-identity');
  assert.equal(result.rejected.length, 0);

  const ledger = result.correctedMarkers[0].payload.processingLedger;
  assert.equal(ledger.length, 1, 'replaced in place, not appended');
  assert.equal(ledger[0].itemRef.id, 'colt-b2', 'itemRef rekeyed to the enumerated identity');
  assert.equal(ledger.filter(item => item.threadRef === B2_THREAD).length, 1, 'thread count stays 1');
  // Every other field preserved verbatim.
  assert.equal(ledger[0].quote, b2AliasLedger().quote);
  assert.equal(ledger[0].reason, b2AliasLedger().reason);
  assert.equal(ledger[0].disposition, b2AliasLedger().disposition);
  assert.deepEqual(ledger[0].nodeRefs, b2AliasLedger().nodeRefs);
  assert.equal(ledger[0].date, b2AliasLedger().date);
  assert.ok(result.correctedMarkers[0].raw.includes('colt-b2"'));

  // Original markers untouched (deep + byte equal).
  assert.equal(JSON.stringify(markers), before);
  assert.notEqual(result.correctedMarkers[0], markers[0]);

  const postGate = filterMarkersByProcessingQualityGate(result.correctedMarkers, {});
  assert.equal(postGate.ok, true, 'final quality gate is clean');
  assert.equal(postGate.reviewReasons.length, 0);
});

test('B2 replacement is rejected if any field other than itemRef changes, or a field is added/removed', () => {
  const markers = b2Markers();
  const { issues } = deriveCorrectableIssues(markers, {});

  const mutations = [
    { name: 'quote', ledgerItem: b2Replacement({ quote: 'Different quote entirely.' }) },
    { name: 'reason', ledgerItem: b2Replacement({ reason: 'Different reason.' }) },
    { name: 'disposition', ledgerItem: b2Replacement({ disposition: 'no-change' }) },
    { name: 'nodeRefs', ledgerItem: b2Replacement({ nodeRefs: ['li-other'] }) },
    { name: 'attachmentsHandled', ledgerItem: b2Replacement({ attachmentsHandled: 'yes' }) },
    { name: 'date', ledgerItem: b2Replacement({ date: '2020-01-01T00:00:00.000Z' }) }
  ];
  for (const mutation of mutations) {
    const result = acceptCorrections({ markers, issues, corrections: [{ markerIndex: 0, ledgerItem: mutation.ledgerItem }] });
    assert.equal(result.applied.length, 0, `${mutation.name} must not apply`);
    assert.equal(result.rejected.length, 1, `${mutation.name} must reject`);
    assert.match(result.rejected[0].reason, /may only change itemRef; field/, mutation.name);
  }

  // Added field.
  const added = acceptCorrections({ markers, issues, corrections: [{ markerIndex: 0, ledgerItem: { ...b2Replacement(), processedAt: '2026-07-15T14:00:00.000Z' } }] });
  assert.equal(added.applied.length, 0);
  assert.match(added.rejected[0].reason, /must carry exactly the existing ledger item fields/);

  // Removed field.
  const removed = b2Replacement();
  delete removed.reason;
  const removedRun = acceptCorrections({ markers, issues, corrections: [{ markerIndex: 0, ledgerItem: removed }] });
  assert.equal(removedRun.applied.length, 0);
  assert.match(removedRun.rejected[0].reason, /must carry exactly the existing ledger item fields/);

  // itemRef not the exact enumerated identity.
  const wrongRef = acceptCorrections({ markers, issues, corrections: [{ markerIndex: 0, ledgerItem: b2Replacement({ itemRef: { type: 'email', id: 'colt-b2-typo' } }) }] });
  assert.equal(wrongRef.applied.length, 0);
  assert.match(wrongRef.rejected[0].reason, /not one of the missing enumerated item keys/);
});

test('B2 mapping rejects title-only, thread-only, fuzzy, multiple-marker, multiple-slot, absent-count and inconsistent-count shapes (all fail-closed)', () => {
  // title-only: SourceRef carries matching title/from/date but no immutable item id -> no mapping.
  const titleOnly = [
    b2LineitemMarker({ sourceRefs: [{ id: 'src-b2', threadRef: B2_THREAD, type: 'email', title: 'RE: Colt circuit', from: 'X', date: '2026-07-15', link: 'https://example.test/a' }] }),
    b2ScanDone()
  ];
  assert.equal(deriveCorrectableIssues(titleOnly, {}).issues.length, 0, 'title-only');

  // thread-only: matching threadRef but a non-matching itemId -> no mapping.
  const threadOnly = [
    b2LineitemMarker({ sourceRefs: [b2SourceRef({ itemId: 'some-other-item' })] }),
    b2ScanDone()
  ];
  assert.equal(deriveCorrectableIssues(threadOnly, {}).issues.length, 0, 'thread-only');

  // fuzzy: near-miss itemId is not an exact match.
  const fuzzy = [
    b2LineitemMarker({ sourceRefs: [b2SourceRef({ itemId: 'colt-b2-reply' })] }),
    b2ScanDone()
  ];
  assert.equal(deriveCorrectableIssues(fuzzy, {}).issues.length, 0, 'fuzzy');

  // multiple-marker: two markers map by immutable identity -> ambiguous.
  const multiMarker = [
    b2LineitemMarker(),
    b2LineitemMarker({ extra: { lineItemId: 'li-b2b' }, sourceRefs: [b2SourceRef({ id: 'src-b2b' })], ledger: [] }),
    b2ScanDone()
  ];
  assert.equal(deriveCorrectableIssues(multiMarker, {}).issues.length, 0, 'multiple-marker');

  // multiple-slot: one mapped marker but two same-thread ledger slots -> ambiguous.
  const multiSlot = [
    b2LineitemMarker({ ledger: [b2AliasLedger(), b2AliasLedger({ itemRef: { type: 'email', id: 'colt-b2-reply-1400' } })] }),
    b2ScanDone({ ledgerCounts: [{ threadRef: B2_THREAD, count: 2 }] })
  ];
  assert.equal(deriveCorrectableIssues(multiSlot, {}).issues.length, 0, 'multiple-slot');

  // absent ledgerCounts: no count evidence for the thread -> uncorrectable.
  const noCounts = [b2LineitemMarker(), b2ScanDone({ omitLedgerCounts: true })];
  assert.equal(deriveCorrectableIssues(noCounts, {}).issues.length, 0, 'absent-count');

  // inconsistent count: expected 2 but actual 1 with one slot -> neither replace nor append.
  const inconsistent = [b2LineitemMarker(), b2ScanDone({ ledgerCounts: [{ threadRef: B2_THREAD, count: 2 }] })];
  assert.equal(deriveCorrectableIssues(inconsistent, {}).issues.length, 0, 'inconsistent-count');
});

test('B2 global APPEND mode triggers only for an unambiguous expected-count deficit', () => {
  // Mapped marker has NO same-thread ledger slot and ledgerCounts shows expected 1 > actual 0.
  const markers = [
    b2LineitemMarker({ ledger: [] }),
    b2ScanDone({ ledgerCounts: [{ threadRef: B2_THREAD, count: 1 }] })
  ];
  const { issues } = deriveCorrectableIssues(markers, {});
  assert.equal(issues.length, 1);
  assert.equal(issues[0].mode, 'append');
  assert.equal(issues[0].markerIndex, 0);

  const appended = {
    itemRef: { type: 'email', id: 'colt-b2' },
    threadRef: B2_THREAD,
    date: B2_ALIAS_DATE,
    disposition: 'updates-node',
    nodeRefs: ['li-b2'],
    attachmentsHandled: 'none',
    quote: 'Yes, please proceed from my side.',
    reason: 'Supplies the missing disposition for the enumerated item.'
  };
  const result = acceptCorrections({ markers, issues, corrections: [{ markerIndex: 0, ledgerItem: appended }] });
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].mode, 'append');
  assert.equal(result.correctedMarkers[0].payload.processingLedger.length, 1);

  const postGate = filterMarkersByProcessingQualityGate(result.correctedMarkers, {});
  assert.equal(postGate.ok, true);
});

test('B2 an item absent from all enumeration can never be corrected via the global path', () => {
  // A marker references item "ghost" by immutable id, but nothing enumerates it -> no issue, and a
  // replacement for it is rejected.
  const markers = [
    b2LineitemMarker({ sourceRefs: [b2SourceRef({ itemId: 'ghost', id: 'src-ghost' })], ledger: [b2AliasLedger({ itemRef: { type: 'email', id: 'ghost-alias' } })] }),
    b2ScanDone({ enumerated: [] })
  ];
  const { issues } = deriveCorrectableIssues(markers, {});
  assert.equal(issues.length, 0);

  const result = acceptCorrections({
    markers,
    issues,
    corrections: [{ markerIndex: 0, ledgerItem: { ...b2AliasLedger(), itemRef: { type: 'email', id: 'ghost' } } }]
  });
  assert.equal(result.applied.length, 0);
  assert.match(result.rejected[0].reason, /not one of the missing enumerated item keys/);
});

test('B2 the runner performs a single attempt and applies the replacement with mode telemetry', async () => {
  const markers = b2Markers();
  let brainCalls = 0;
  const result = await runProcessingQualityCorrection({
    markers,
    gateOptions: {},
    _runBrain: async ({ prompt }) => {
      brainCalls++;
      assert.match(prompt, /replace-item-identity/);
      const line = `[${CORRECTION_TAG}] ${JSON.stringify({ markerIndex: 0, ledgerItem: b2Replacement() })}`;
      return { ok: true, assistantText: `analysis\n${line}\n`, counters: { workIqCalls: 0 } };
    }
  });

  assert.equal(brainCalls, 1);
  assert.equal(result.corrected, true);
  assert.equal(result.telemetry.applied, 1);
  assert.deepEqual(result.telemetry.appliedModes, ['replace-item-identity']);
  assert.equal(result.telemetry.preGateOk, false);
  assert.equal(result.telemetry.postCorrectionGateOk, true);
  assert.equal(markers[0].payload.processingLedger[0].itemRef.id, 'colt-b2-reply-1333', 'input untouched');
});
