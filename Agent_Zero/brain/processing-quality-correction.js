// Bounded, generic processing-quality correction pass for the Agency Brain scan.
//
// This module implements ONE bounded, single-attempt correction that repairs only a very
// narrow class of defects: a processing-ledger DISPOSITION that is missing for an item the
// initial scan ALREADY ENUMERATED on a processing-ledger marker. It is entirely generic — it
// is driven exclusively by the enumeration/ledger contract enforced by
// `filterMarkersByProcessingQualityGate`, and carries no topic-specific rules.
//
// Boundary invariant (see also the test `never solves an item that was never enumerated`):
//   This pass can ONLY supply a disposition for an item the scan ALREADY ENUMERATED — either on a
//   marker's `processingEnumeratedItems` OR globally in `SCAN_DONE.processingQuality.enumeratedItems`.
//   It never invents new enumerated items, never invents no-change dispositions, never mutates
//   task/state directly, and never bypasses the identity, reality, evidence, temporal, marker, or
//   final quality gates. A globally enumerated item is only correctable when it maps to exactly one
//   processing-ledger-capable marker by IMMUTABLE EXACT SOURCE IDENTITY (itemId/messageId/
//   internetMessageId plus an exact threadRef when both are present) — never by title words, sender,
//   dates alone, topic, fuzzy text, or threadRef alone. Corrections are protocol data on a deep copy:
//   an APPEND adds a disposition to a marker's `processingLedger`; a REPLACE-ITEM-IDENTITY rewrites
//   the itemRef of ONE existing same-thread ledger slot in place (copying every other field exactly)
//   without appending, removing, or reordering any ledger item and without changing the thread's
//   count. Corrections must never reach `applyMarkerBatch` as standalone markers.

import path from 'node:path';
import { runBrain } from './brain-runner.js';
import { BRAIN_RUN_CLASS } from './brain-scheduler.js';
import {
  PROCESSING_LEDGER_MARKER_TYPES,
  itemRefKey,
  validateLedgerItem,
  extractEnumeratedItemsFromPayload,
  extractProcessingLedgerFromPayload,
  filterMarkersByProcessingQualityGate,
  hasAttachmentSignal,
  attachmentDispositionHandlesPresentAttachments
} from './processing-ledger.js';

// Bounded budgets (assignment: timeout <= 8 min, WorkIQ hard limit <= 8, tool hard limit <= 24).
export const CORRECTION_TIMEOUT_MS = 8 * 60 * 1000;
export const CORRECTION_WORKIQ_HARD_LIMIT = 8;
export const CORRECTION_TOOL_HARD_LIMIT = 24;
export const CORRECTION_EFFORT = 'xhigh';

// Only completeness omissions produced by the quality gate are correctable. This is the exact
// machine-readable signal for "missing ledger disposition for enumerated item <key>".
export const MISSING_LEDGER_COMPLETENESS_SOURCE = 'processing-ledger-completeness';
export const MISSING_LEDGER_REASON_RE = /^missing ledger disposition for enumerated item (.+)$/;

// Dedicated correction grammar — deliberately distinct from the marker grammar so corrections are
// never confused with, or parsed as, ordinary markers.
export const CORRECTION_TAG = 'LEDGER_CORRECTION';
const CORRECTION_LINE_RE = new RegExp(`^\\[${CORRECTION_TAG}\\]\\s+(\\{.*\\})\\s*$`);

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function deepClone(value) {
  return JSON.parse(JSON.stringify(value));
}

function datesEqual(a, b) {
  const ta = Date.parse(a);
  const tb = Date.parse(b);
  if (Number.isFinite(ta) && Number.isFinite(tb)) return ta === tb;
  return compactText(a) === compactText(b);
}

function findEnumeratedItem(payload, key) {
  for (const item of extractEnumeratedItemsFromPayload(payload)) {
    if (itemRefKey(item?.itemRef || item) === key) return item;
  }
  return null;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

// Order-independent structural equality — used to prove a REPLACE-ITEM-IDENTITY correction copies
// an existing ledger slot exactly except for its itemRef.
function deepEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b;
  const aIsArr = Array.isArray(a);
  const bIsArr = Array.isArray(b);
  if (aIsArr !== bIsArr) return false;
  if (aIsArr) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  const aKeys = Object.keys(a).sort();
  const bKeys = Object.keys(b).sort();
  if (aKeys.length !== bKeys.length) return false;
  for (let i = 0; i < aKeys.length; i++) if (aKeys[i] !== bKeys[i]) return false;
  for (const key of aKeys) if (!deepEqual(a[key], b[key])) return false;
  return true;
}

// ---- scan-wide (global) enumeration support -------------------------------------------------
// The gate can report a missing ledger disposition for an item the scan enumerated ONLY in
// SCAN_DONE.processingQuality.enumeratedItems (never on any single marker). Such omissions arrive as
// scan-wide review reasons (source 'scan_done'), not marker-local holds, so the marker-local path
// below cannot see them. They are correctable ONLY when the global item maps to EXACTLY ONE
// processing-ledger-capable marker by immutable exact source identity (assignment §2-§4).

// Only immutable item-identity fields on a marker SourceRef may anchor a global mapping. The
// SourceRef's own `id` (a source-record id such as "src-see-colt-...") and any human text
// (title/from/date/topic) are excluded so mapping can never be fuzzy or thread-only.
const SOURCEREF_IMMUTABLE_ID_FIELDS = ['itemId', 'messageId', 'internetMessageId'];

function scanQualityFromMarkers(markers) {
  const payload = markers.find(marker => marker?.type === 'SCAN_DONE')?.payload || {};
  const quality = payload.processingQuality;
  return quality && typeof quality === 'object' && !Array.isArray(quality) ? quality : {};
}

// The exact globally enumerated item (full itemRef + threadRef) for a key, or null when the key is
// absent from the global enumeration (an item absent from enumeration can never be corrected).
function findGlobalEnumeratedItem(scanQuality, key) {
  for (const item of normalizeArray(scanQuality.enumeratedItems)) {
    if (itemRefKey(item?.itemRef || item) === key) return item;
  }
  return null;
}

// Expected count for a thread from SCAN_DONE.processingQuality.ledgerCounts (legacy threadCounts
// fallback). Returns null when no count evidence exists for the thread.
function globalExpectedCount(scanQuality, threadRef) {
  const counts = normalizeArray(scanQuality.ledgerCounts).length
    ? scanQuality.ledgerCounts
    : normalizeArray(scanQuality.threadCounts);
  for (const entry of normalizeArray(counts)) {
    if (compactText(entry?.threadRef) === threadRef) {
      const expected = Number(entry?.count);
      return Number.isInteger(expected) && expected >= 0 ? expected : null;
    }
  }
  return null;
}

// The immutable identity of an enumerated itemRef (its stable id — never title/from/date).
function enumeratedImmutableId(itemRef) {
  if (typeof itemRef === 'string') return compactText(itemRef);
  if (!itemRef || typeof itemRef !== 'object' || Array.isArray(itemRef)) return '';
  return compactText(itemRef.id || itemRef.itemId || itemRef.messageId || itemRef.internetMessageId || '');
}

function collectSourceRefs(payload) {
  const refs = [];
  if (Array.isArray(payload?.sourceRefs)) refs.push(...payload.sourceRefs);
  if (payload?.sourceRef && typeof payload.sourceRef === 'object' && !Array.isArray(payload.sourceRef)) {
    refs.push(payload.sourceRef);
  }
  return refs.filter(ref => ref && typeof ref === 'object' && !Array.isArray(ref));
}

// Immutable exact source-identity match: enumerated itemRef.id equals a SourceRef itemId/messageId/
// internetMessageId, AND threadRef matches exactly when both are present.
function sourceRefMapsToItem(sourceRef, enumeratedId, enumeratedThreadRef) {
  if (!enumeratedId) return false;
  const idMatch = SOURCEREF_IMMUTABLE_ID_FIELDS.some(field => {
    const value = compactText(sourceRef[field]);
    return value && value === enumeratedId;
  });
  if (!idMatch) return false;
  const refThread = compactText(sourceRef.threadRef);
  if (refThread && enumeratedThreadRef && refThread !== enumeratedThreadRef) return false;
  return true;
}

// Processing-ledger-capable marker indexes whose SourceRefs map to the enumerated item by immutable
// identity. A global item is correctable ONLY when EXACTLY one marker matches.
function mapGlobalItemToMarkers(markers, enumeratedId, enumeratedThreadRef) {
  const matches = [];
  markers.forEach((marker, index) => {
    if (!PROCESSING_LEDGER_MARKER_TYPES.has(marker?.type)) return;
    const refs = collectSourceRefs(marker.payload || {});
    if (refs.some(ref => sourceRefMapsToItem(ref, enumeratedId, enumeratedThreadRef))) matches.push(index);
  });
  return matches;
}

// A marker's ledger slots tagged with their original container and index so a REPLACE correction can
// rewrite an EXACT slot in place without appending, removing, or reordering any other ledger item.
function ledgerSlots(payload) {
  const slots = [];
  normalizeArray(payload?.processing?.ledger).forEach((item, index) => {
    slots.push({ container: 'processing.ledger', index, item });
  });
  normalizeArray(payload?.processingLedger).forEach((item, index) => {
    slots.push({ container: 'processingLedger', index, item });
  });
  return slots;
}

/**
 * Select the ONLY correctable classes of issues from a completed quality-gate result.
 *
 * Two entirely generic shapes are recognised (driven only by the enumeration/ledger contract, never
 * by topic):
 *
 *   (a) APPEND (marker-local): a completeness hold (`source === 'processing-ledger-completeness'`)
 *       whose reason is exactly "missing ledger disposition for enumerated item <key>", where the
 *       held marker enumerated the item locally and is permitted to carry a processing ledger. The
 *       missing disposition is appended.
 *
 *   (b) scan-wide (global): a review reason (`source === 'scan_done'`) with the same exact reason,
 *       where the item is present in SCAN_DONE.processingQuality.enumeratedItems and maps to EXACTLY
 *       ONE processing-ledger-capable marker by immutable exact source identity. Its mode is:
 *         - REPLACE-ITEM-IDENTITY when the mapped marker holds exactly one same-thread ledger slot
 *           under a DIFFERENT itemRef and the global expected count already equals the actual count
 *           (the real B2 item-identity alias mismatch); or
 *         - APPEND when the mapped marker holds no same-thread slot and the global ledgerCounts shows
 *           an unambiguous expected-count deficit.
 *
 * Everything else (malformed markers, wrong windows, missing discovery passes, attachment failures,
 * arbitrary gateway holds, ambiguous/zero/multi marker mappings, multiple candidate slots, missing
 * or inconsistent count evidence, or items absent from all enumeration) is intentionally excluded so
 * the scan simply remains partial/reviewable.
 *
 * @returns {Array<{key, mode, markerIndexes:Set<number>, enumeratedItem, threadRef, date, hasAttachment}>}
 */
export function selectCorrectableIssuesFromGate(gate = {}, markers = []) {
  const byKey = new Map();
  const held = Array.isArray(gate.held) ? gate.held : [];

  for (const entry of held) {
    if (!entry || entry.source !== MISSING_LEDGER_COMPLETENESS_SOURCE) continue;

    // A single held marker index can accumulate several reasons (the gate collapses multiple holds
    // for the same marker into one entry with a `reasons` array). The entry is only correctable if
    // EVERY reason on it is a "missing ledger disposition" completeness reason — otherwise the
    // marker is also broken for a reason a correction cannot repair, so we leave it partial.
    const reasons = Array.isArray(entry.reasons) && entry.reasons.length ? entry.reasons : [entry.reason];
    const matches = reasons.map(reason => MISSING_LEDGER_REASON_RE.exec(compactText(reason)));
    if (!matches.length || matches.some(match => !match)) continue;

    const index = entry.index;
    if (!Number.isInteger(index) || index < 0 || index >= markers.length) continue;

    const marker = markers[index];
    if (!marker || !PROCESSING_LEDGER_MARKER_TYPES.has(marker.type)) continue;

    for (const match of matches) {
      const key = compactText(match[1]);
      if (!key) continue;

      const enumeratedItem = findEnumeratedItem(marker.payload || {}, key);
      if (!enumeratedItem) continue; // cannot be safely mapped -> emit no correction

      const threadRef = compactText(enumeratedItem.threadRef);
      if (!threadRef) continue; // an enumerated item without a threadRef cannot be validated

      let issue = byKey.get(key);
      if (!issue) {
        issue = {
          key,
          mode: 'append',
          markerIndexes: new Set(),
          enumeratedItem,
          threadRef,
          date: enumeratedItem.date != null ? enumeratedItem.date : null,
          hasAttachment: hasAttachmentSignal(enumeratedItem)
        };
        byKey.set(key, issue);
      }
      issue.markerIndexes.add(index);
    }
  }

  // (b) Scan-wide (global) omissions -> immutable exact-identity mapping to a single marker.
  const scanQuality = scanQualityFromMarkers(markers);
  const globalLedger = Array.isArray(gate.ledgerItems) ? gate.ledgerItems : [];
  const reviewReasons = Array.isArray(gate.reviewReasons) ? gate.reviewReasons : [];

  for (const entry of reviewReasons) {
    if (!entry || entry.source !== 'scan_done') continue;
    const match = MISSING_LEDGER_REASON_RE.exec(compactText(entry.reason));
    if (!match) continue;
    const key = compactText(match[1]);
    if (!key || byKey.has(key)) continue; // already handled by the marker-local append path

    const enumeratedItem = findGlobalEnumeratedItem(scanQuality, key);
    if (!enumeratedItem) continue; // never correct an item absent from the global enumeration
    const threadRef = compactText(enumeratedItem.threadRef);
    if (!threadRef) continue;

    const enumeratedId = enumeratedImmutableId(enumeratedItem.itemRef);
    if (!enumeratedId) continue;

    const mappedMarkers = mapGlobalItemToMarkers(markers, enumeratedId, threadRef);
    if (mappedMarkers.length !== 1) continue; // ambiguous or zero mapping stays uncorrected

    const markerIndex = mappedMarkers[0];
    const targetPayload = markers[markerIndex]?.payload || {};
    const sameThreadSlots = ledgerSlots(targetPayload).filter(slot => compactText(slot.item?.threadRef) === threadRef);

    const expected = globalExpectedCount(scanQuality, threadRef);
    if (expected === null) continue; // missing count evidence stays uncorrected
    const actual = globalLedger.filter(item => compactText(item?.threadRef) === threadRef).length;

    const base = {
      key,
      markerIndexes: new Set([markerIndex]),
      markerIndex,
      enumeratedItem,
      threadRef,
      date: enumeratedItem.date != null ? enumeratedItem.date : null,
      hasAttachment: hasAttachmentSignal(enumeratedItem)
    };

    if (sameThreadSlots.length === 1) {
      const slot = sameThreadSlots[0];
      const slotKey = itemRefKey(slot.item?.itemRef);
      // REPLACE-ITEM-IDENTITY: exactly one existing same-thread slot under a DIFFERENT itemRef and
      // the global expected count is already satisfied (expected === actual) — the real B2 shape.
      if (slotKey && slotKey !== key && expected === actual) {
        byKey.set(key, {
          ...base,
          mode: 'replace-item-identity',
          container: slot.container,
          slotIndex: slot.index,
          existingLedgerItem: slot.item,
          date: slot.item?.date != null ? slot.item.date : base.date
        });
      }
      // slotKey === key would already be dispositioned correctly; any other case is
      // ambiguous/inconsistent -> leave uncorrected.
      continue;
    }

    if (sameThreadSlots.length === 0 && expected > actual) {
      // APPEND: no same-thread slot yet and an unambiguous expected-count deficit.
      byKey.set(key, { ...base, mode: 'append' });
    }
    // multiple candidate slots, or no slot without a deficit -> uncorrected.
  }

  return [...byKey.values()];
}

/**
 * Convenience wrapper: run the quality gate on the given markers and extract correctable issues.
 */
export function deriveCorrectableIssues(markers = [], gateOptions = {}) {
  const gate = filterMarkersByProcessingQualityGate(markers, gateOptions);
  return { gate, issues: selectCorrectableIssuesFromGate(gate, markers) };
}

/**
 * Parse ONLY the dedicated correction grammar. Physical lines `[LEDGER_CORRECTION] {json}` outside
 * code fences are parsed; everything else — prose, code fences, and marker lines — is ignored.
 */
export function parseCorrectionLines(text) {
  const corrections = [];
  const errors = [];
  let fence = null;
  const lines = String(text || '').split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fenceMatch = line.match(/^\s*(```|~~~)/);
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (fence === fenceMatch[1]) fence = null;
      continue;
    }
    if (fence) continue;

    const match = line.match(CORRECTION_LINE_RE);
    if (!match) continue;

    try {
      corrections.push({ payload: JSON.parse(match[1]), line: i + 1, raw: line });
    } catch (err) {
      errors.push({ line: i + 1, raw: line, error: err.message });
    }
  }

  return { corrections, errors };
}

/**
 * Subtractive, strict acceptance of parsed corrections. Deep-copies the input markers; for an APPEND
 * correction it appends the accepted ledger item to the target marker's `processingLedger`, and for a
 * REPLACE-ITEM-IDENTITY correction it rewrites the itemRef of one existing same-thread ledger slot in
 * place (copying every other field exactly). The marker's raw representation is updated consistently.
 * The input `markers` array and its elements are never mutated.
 */
export function acceptCorrections({ markers = [], issues = [], corrections = [] } = {}) {
  const issueByKey = new Map(issues.map(issue => [issue.key, issue]));
  const correctedMarkers = markers.map(deepClone);
  const applied = [];
  const rejected = [];
  const usedKeys = new Set();

  corrections.forEach((entry, position) => {
    const correction = entry && Object.prototype.hasOwnProperty.call(entry, 'payload') ? entry.payload : entry;
    const reject = (reason) => rejected.push({ position, reason });

    if (!correction || typeof correction !== 'object' || Array.isArray(correction)) {
      return reject('correction must be an object');
    }
    const keys = Object.keys(correction);
    const extra = keys.filter(key => key !== 'markerIndex' && key !== 'ledgerItem');
    if (extra.length) return reject(`unexpected correction field(s): ${extra.join(', ')}`);

    const { markerIndex, ledgerItem } = correction;
    if (!Number.isInteger(markerIndex) || markerIndex < 0 || markerIndex >= markers.length) {
      return reject(`markerIndex ${JSON.stringify(markerIndex)} is not a valid marker index`);
    }
    const targetType = markers[markerIndex]?.type;
    if (!PROCESSING_LEDGER_MARKER_TYPES.has(targetType)) {
      return reject(`marker ${markerIndex} of type ${targetType} cannot carry a processing ledger`);
    }
    if (!ledgerItem || typeof ledgerItem !== 'object' || Array.isArray(ledgerItem)) {
      return reject('ledgerItem must be an object');
    }

    const key = itemRefKey(ledgerItem.itemRef);
    if (!key) return reject('ledgerItem.itemRef is required');

    const issue = issueByKey.get(key);
    if (!issue) return reject(`itemRef ${key} is not one of the missing enumerated item keys`);
    if (!issue.markerIndexes.has(markerIndex)) {
      return reject(`markerIndex ${markerIndex} did not enumerate item ${key}`);
    }
    if (usedKeys.has(key)) return reject(`duplicate correction for item ${key}`);

    const target = correctedMarkers[markerIndex];

    if (issue.mode === 'replace-item-identity') {
      if (!applyReplaceCorrection({ issue, ledgerItem, markerIndex, target, reject })) return;
      usedKeys.add(key);
      applied.push({ markerIndex, key, mode: 'replace-item-identity', ledgerItem: deepClone(ledgerItem) });
      return;
    }

    // APPEND mode (marker-local hold or an unambiguous global expected-count deficit): retain all
    // existing strict validation and append to the marker's processing ledger.
    if (compactText(ledgerItem.threadRef) !== issue.threadRef) {
      return reject(`threadRef mismatch for ${key}`);
    }
    if (issue.date != null && compactText(issue.date) && !datesEqual(ledgerItem.date, issue.date)) {
      return reject(`date mismatch for ${key}`);
    }

    const ledgerError = validateLedgerItem(ledgerItem, 'correction.ledgerItem');
    if (ledgerError) return reject(ledgerError);

    // Attachment-bearing enumerated items may never be dispositioned as if they had no attachments.
    if (issue.hasAttachment && !attachmentDispositionHandlesPresentAttachments(ledgerItem.attachmentsHandled)) {
      return reject(`attachment-bearing item ${key} cannot be accepted with attachmentsHandled=${JSON.stringify(ledgerItem.attachmentsHandled)}`);
    }

    const existingLedger = Array.isArray(target.payload?.processingLedger) ? target.payload.processingLedger : [];
    target.payload = { ...(target.payload || {}), processingLedger: [...existingLedger, deepClone(ledgerItem)] };
    target.raw = `[${target.type}] ${JSON.stringify(target.payload)}`;

    usedKeys.add(key);
    applied.push({ markerIndex, key, mode: 'append', ledgerItem: deepClone(ledgerItem) });
  });

  return { correctedMarkers, applied, rejected, appliedKeys: usedKeys };
}

/**
 * Strict REPLACE-ITEM-IDENTITY acceptance. The replacement must be deep-equal to the exact existing
 * same-thread ledger slot in EVERY field except `itemRef`, and its `itemRef` must be the exact
 * globally enumerated itemRef (and differ from the existing alias). It rewrites that one slot in its
 * original container in place — never appending, removing, or reordering another ledger item — and
 * so never increases the thread's count. Returns true when applied, false (with a reject) otherwise.
 */
function applyReplaceCorrection({ issue, ledgerItem, markerIndex, target, reject }) {
  if (markerIndex !== issue.markerIndex) {
    reject(`markerIndex ${markerIndex} is not the uniquely mapped target for ${issue.key}`);
    return false;
  }
  const existing = issue.existingLedgerItem;
  if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
    reject(`no existing ledger slot to replace for ${issue.key}`);
    return false;
  }

  const corrKeys = Object.keys(ledgerItem).sort();
  const existingKeys = Object.keys(existing).sort();
  if (corrKeys.length !== existingKeys.length || corrKeys.some((k, i) => k !== existingKeys[i])) {
    reject(`replacement for ${issue.key} must carry exactly the existing ledger item fields`);
    return false;
  }
  for (const field of corrKeys) {
    if (field === 'itemRef') continue;
    if (!deepEqual(ledgerItem[field], existing[field])) {
      reject(`replacement for ${issue.key} may only change itemRef; field ${field} differs`);
      return false;
    }
  }
  if (!deepEqual(ledgerItem.itemRef, issue.enumeratedItem?.itemRef)) {
    reject(`replacement itemRef for ${issue.key} must be the exact enumerated itemRef`);
    return false;
  }
  if (deepEqual(ledgerItem.itemRef, existing.itemRef)) {
    reject(`replacement itemRef for ${issue.key} must differ from the existing alias itemRef`);
    return false;
  }

  const ledgerError = validateLedgerItem(ledgerItem, 'correction.ledgerItem');
  if (ledgerError) {
    reject(ledgerError);
    return false;
  }
  if (issue.hasAttachment && !attachmentDispositionHandlesPresentAttachments(ledgerItem.attachmentsHandled)) {
    reject(`attachment-bearing item ${issue.key} cannot be accepted with attachmentsHandled=${JSON.stringify(ledgerItem.attachmentsHandled)}`);
    return false;
  }

  const container = issue.container === 'processing.ledger'
    ? target.payload?.processing?.ledger
    : target.payload?.processingLedger;
  if (!Array.isArray(container) || !container[issue.slotIndex]) {
    reject(`existing ledger slot for ${issue.key} is no longer present`);
    return false;
  }
  container[issue.slotIndex] = deepClone(ledgerItem);
  target.raw = `[${target.type}] ${JSON.stringify(target.payload)}`;
  return true;
}

function issueMetadataForPrompt(issue) {
  const meta = {
    itemKey: issue.key,
    mode: issue.mode || 'append',
    itemRef: issue.enumeratedItem?.itemRef ?? null,
    threadRef: issue.threadRef,
    date: issue.date ?? null,
    hasAttachments: issue.hasAttachment,
    eligibleMarkerIndexes: [...issue.markerIndexes].sort((a, b) => a - b)
  };
  if (issue.mode === 'replace-item-identity') {
    // Give the brain the exact target marker index and the exact existing ledger item to copy so it
    // can change ONLY the itemRef. Acceptance re-verifies this independently.
    meta.markerIndex = issue.markerIndex;
    meta.existingLedgerItem = issue.existingLedgerItem;
  }
  return meta;
}

/**
 * Build the bounded correction prompt. It lists the state/Fact Sheet filenames, the indexed
 * original post-identity markers, the exact missing item keys with their original enumerated
 * metadata, and an explicit physical-line output grammar. It permits a read-only WorkIQ query for
 * the exact item ONLY when the original marker evidence is insufficient, and prohibits any state
 * mutation, invented quotes/outcomes, topic rules, prose, code fences, or additional discovery.
 */
export function buildCorrectionPrompt({ stateFile, factSheetFiles = [], markers = [], issues = [] } = {}) {
  const stateFileName = stateFile ? path.basename(stateFile) : null;
  const factSheetList = (Array.isArray(factSheetFiles) ? factSheetFiles : [])
    .map(name => `- ./${path.basename(name)}`)
    .join('\n') || '- none';

  const markerLines = markers
    .map((marker, index) => `${index}: ${marker?.raw || `[${marker?.type}] ${JSON.stringify(marker?.payload || {})}`}`)
    .join('\n');

  const issueLines = issues
    .map(issue => `- ${JSON.stringify(issueMetadataForPrompt(issue))}`)
    .join('\n');

  return [
    '# Agent Zero — Processing-Ledger Completeness Correction',
    '',
    'The initial scan enumerated the item(s) listed below on a processing-ledger marker but did not',
    'record a processing-ledger DISPOSITION for them. Your only job is to supply the missing',
    'disposition(s) for exactly these enumerated item(s). This is a bounded, single-attempt',
    'correction — you get one turn.',
    '',
    '## Files you may read',
    stateFileName ? `- ./${stateFileName} (rendered scan state)` : '- (no state file)',
    'Fact Sheets:',
    factSheetList,
    '',
    '## Original post-identity markers (indexed)',
    markerLines || '(none)',
    '',
    '## Missing enumerated item(s) to disposition',
    'Each line is JSON: itemKey, mode, itemRef, threadRef, date, hasAttachments, eligibleMarkerIndexes,',
    'and (for mode "replace-item-identity") markerIndex and existingLedgerItem.',
    issueLines || '(none)',
    '',
    '## Output grammar (physical lines only, no code fences, no prose)',
    `For each item you can honestly disposition, emit ONE physical line exactly:`,
    `[${CORRECTION_TAG}] {"markerIndex":N,"ledgerItem":{...}}`,
    '- markerIndex MUST be one of that item\'s eligibleMarkerIndexes.',
    '- ledgerItem.itemRef MUST resolve to the exact itemKey; ledgerItem.threadRef MUST equal the',
    '  item\'s threadRef; ledgerItem.date MUST equal the item\'s date when a date is given.',
    '- ledgerItem MUST include: itemRef, threadRef, date, disposition, nodeRefs (array),',
    '  attachmentsHandled, quote (verbatim from real evidence), reason.',
    '- If hasAttachments is true, attachmentsHandled MUST be yes(workiq-index), yes, or',
    '  failed(<reason>) — never none.',
    '',
    '## Correction mode (per item, from its metadata `mode`)',
    '- mode "append": supply a NEW disposition for the enumerated item on one of its',
    '  eligibleMarkerIndexes, following the field rules above.',
    '- mode "replace-item-identity": the enumerated item is the SAME message already dispositioned',
    '  once on markerIndex under a different (alias) itemRef. Copy that item\'s `existingLedgerItem`',
    '  VERBATIM and change ONLY its itemRef to the enumerated itemRef. Do NOT alter threadRef, date,',
    '  disposition, nodeRefs, attachmentsHandled, quote, reason, or any other field, and do NOT add',
    '  or remove fields. Emit exactly one line for markerIndex.',
    '',
    '## Hard rules',
    '- You MAY issue a single read-only WorkIQ query for the exact item ONLY if the original marker',
    '  evidence is insufficient to write a truthful disposition. Do NOT perform any new discovery.',
    '- Do NOT change tasks, projects, line items, or any other state. Do NOT emit any marker.',
    '- Do NOT invent quotes, evidence, or a "no-change"/"already-processed" outcome you cannot prove.',
    '- Do NOT add topic-specific rules. Do NOT output prose, explanations, or code fences.',
    '- If an item genuinely requires a state mutation that is absent, cannot be proven, or cannot be',
    '  safely mapped to one of its eligibleMarkerIndexes, emit NOTHING for that item so the scan',
    '  stays partial and reviewable. Emitting nothing is always a valid, safe answer.'
  ].join('\n');
}

function baseTelemetry() {
  return {
    attempted: false,
    eligibleIssues: 0,
    runOk: false,
    parsed: 0,
    received: 0,
    applied: 0,
    rejected: 0,
    rejectedReasons: [],
    appliedModes: [],
    preGateOk: null,
    postCorrectionGateOk: null,
    remainingReason: null,
    workIqCalls: 0,
    durationMs: 0
  };
}

/**
 * The single bounded correction runner. Runs the pre-gateway quality gate once to discover
 * correctable omissions; if any exist, issues exactly ONE bounded LLM attempt, strictly accepts
 * valid corrections, and re-evaluates the pre-gateway gate for telemetry. Never loops. On any
 * failure (throw, not-ok, empty/malformed output, or leftover gaps) it returns the ORIGINAL
 * markers unchanged so the caller can continue safely with existing partial/review behavior.
 */
export async function runProcessingQualityCorrection({
  markers = [],
  stateFile = null,
  factSheetFiles = [],
  brainWorkDir,
  runId = `correction-${Date.now()}`,
  gateOptions = {},
  now = new Date(),
  timeoutMs = CORRECTION_TIMEOUT_MS,
  workIqHardLimit = CORRECTION_WORKIQ_HARD_LIMIT,
  toolCallHardLimit = CORRECTION_TOOL_HARD_LIMIT,
  effort = CORRECTION_EFFORT,
  runClass = BRAIN_RUN_CLASS.BACKGROUND,
  schedulerLabel = `scan-correction:${runId}`,
  onSchedulerUpdate = null,
  _runBrain = runBrain,
  _filterGate = filterMarkersByProcessingQualityGate
} = {}) {
  const startedAt = Date.now();
  const telemetry = baseTelemetry();

  const preGate = _filterGate(markers, gateOptions);
  const issues = selectCorrectableIssuesFromGate(preGate, markers);
  telemetry.preGateOk = Boolean(preGate.ok);
  telemetry.eligibleIssues = issues.length;
  telemetry.postCorrectionGateOk = Boolean(preGate.ok);
  telemetry.remainingReason = preGate.reason || null;

  // No correctable omission -> the LLM correction runner is never invoked.
  if (!issues.length) {
    telemetry.durationMs = Date.now() - startedAt;
    return { corrected: false, correctedMarkers: markers, issues, applied: [], rejected: [], telemetry };
  }

  telemetry.attempted = true;
  const prompt = buildCorrectionPrompt({ stateFile, factSheetFiles, markers, issues });

  let brainResult;
  try {
    brainResult = await _runBrain({
      prompt,
      brainWorkDir,
      timeoutMs,
      workIqHardLimit,
      toolCallHardLimit,
      effort,
      runClass,
      schedulerLabel,
      onSchedulerUpdate,
      cleanBrainWorkDir: false
    });
  } catch (err) {
    telemetry.runOk = false;
    telemetry.durationMs = Date.now() - startedAt;
    return { corrected: false, correctedMarkers: markers, issues, applied: [], rejected: [], telemetry, error: err };
  }

  telemetry.workIqCalls = Number(brainResult?.counters?.workIqCalls) || 0;
  telemetry.runOk = Boolean(brainResult?.ok);

  if (!brainResult?.ok) {
    telemetry.durationMs = Date.now() - startedAt;
    return { corrected: false, correctedMarkers: markers, issues, applied: [], rejected: [], telemetry };
  }

  const parsedCorrections = parseCorrectionLines(brainResult.assistantText || brainResult.text || '');
  telemetry.received = parsedCorrections.corrections.length + parsedCorrections.errors.length;
  telemetry.parsed = parsedCorrections.corrections.length;

  const accepted = acceptCorrections({ markers, issues, corrections: parsedCorrections.corrections });
  telemetry.applied = accepted.applied.length;
  telemetry.rejected = accepted.rejected.length;
  telemetry.rejectedReasons = accepted.rejected.map(item => item.reason);
  telemetry.appliedModes = accepted.applied.map(item => item.mode);

  const corrected = accepted.applied.length > 0;
  const correctedMarkers = corrected ? accepted.correctedMarkers : markers;

  const postGate = _filterGate(correctedMarkers, gateOptions);
  telemetry.postCorrectionGateOk = Boolean(postGate.ok);
  telemetry.remainingReason = postGate.reason || null;
  telemetry.durationMs = Date.now() - startedAt;

  return { corrected, correctedMarkers, issues, applied: accepted.applied, rejected: accepted.rejected, telemetry };
}
