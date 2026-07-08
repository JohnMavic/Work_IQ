export const LEDGER_DISPOSITIONS = new Set([
  'updates-node',
  'no-change',
  'new-node',
  'conflict',
  'not-this-project',
  'already-processed'
]);

export const DEFAULT_PROCESSING_LOOKBACK_DAYS = 14;
export const PROCESSING_LEDGER_MARKER_TYPES = new Set([
  'PROJECT_NEW',
  'PROJECT_UPDATE',
  'LINEITEM_NEW',
  'LINEITEM_UPDATE',
  'FACTSHEET_UPDATE'
]);

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isFailedAttachmentDisposition(value) {
  return /^failed\(.+\)$/i.test(compactText(value));
}

export function isContentNotIndexedAttachmentDisposition(value) {
  return /^failed\(\s*content-not-indexed\s*\)$/i.test(compactText(value));
}

function isHandledAttachmentDisposition(value) {
  const text = compactText(value).toLowerCase();
  return text === 'yes' || text === 'yes(workiq-index)';
}

function isValidAttachmentDisposition(value) {
  const text = compactText(value).toLowerCase();
  return isHandledAttachmentDisposition(text) || text === 'none' || isFailedAttachmentDisposition(text);
}

function hasAttachmentSignal(item = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (item.hasAttachments === true) return true;
  if (Number(item.attachmentCount) > 0) return true;
  if (Array.isArray(item.attachments) && item.attachments.length > 0) return true;
  return false;
}

function scanDoneProcessingQuality(markers = []) {
  const scanDone = markers.find(marker => marker?.type === 'SCAN_DONE')?.payload || {};
  return scanDone.processingQuality && typeof scanDone.processingQuality === 'object' && !Array.isArray(scanDone.processingQuality)
    ? scanDone.processingQuality
    : {};
}

function isProcessingLedgerMarker(marker) {
  return PROCESSING_LEDGER_MARKER_TYPES.has(marker?.type);
}

function addHeld(heldByIndex, index, reason, details = {}) {
  if (!Number.isInteger(index)) return;
  const existing = heldByIndex.get(index);
  if (existing) {
    existing.reasons.push(reason);
    return;
  }
  heldByIndex.set(index, {
    index,
    marker: details.marker || null,
    reason,
    reasons: [reason],
    source: details.source || 'processing-quality',
    key: details.key || null
  });
}

function projectNewGroupKey(marker, index) {
  const payload = marker?.payload || {};
  const taskId = compactText(payload.taskId);
  const projectKey = compactText(payload.projectKey);
  const title = compactText(payload.title);
  if (taskId) return `project-new:${taskId}`;
  if (projectKey) return `project-new-key:${projectKey}`;
  if (title) return `project-new-title:${title.toLowerCase()}`;
  return `marker:${index}`;
}

function buildAtomicGroups(markers = []) {
  const projectNewByTaskId = new Map();
  const projectNewGroups = new Map();

  markers.forEach((marker, index) => {
    if (marker?.type !== 'PROJECT_NEW') return;
    const groupKey = projectNewGroupKey(marker, index);
    projectNewGroups.set(index, groupKey);
    const taskId = compactText(marker.payload?.taskId);
    if (taskId) projectNewByTaskId.set(taskId, groupKey);
  });

  const groups = new Map();
  markers.forEach((marker, index) => {
    let groupKey = null;
    if (marker?.type === 'PROJECT_NEW') {
      groupKey = projectNewGroups.get(index) || projectNewGroupKey(marker, index);
    } else if (marker?.type === 'LINEITEM_NEW') {
      const taskId = compactText(marker.payload?.taskId);
      groupKey = projectNewByTaskId.get(taskId) || null;
    }
    if (!groupKey) groupKey = `marker:${index}`;
    if (!groups.has(groupKey)) groups.set(groupKey, []);
    groups.get(groupKey).push(index);
  });

  return groups;
}

function expandAtomicHolds(markers, heldByIndex) {
  const groups = buildAtomicGroups(markers);
  for (const indexes of groups.values()) {
    const held = indexes.find(index => heldByIndex.has(index));
    if (held === undefined || indexes.length <= 1) continue;
    const heldReason = heldByIndex.get(held)?.reason || 'related marker held by processing-ledger quality gate';
    for (const index of indexes) {
      if (heldByIndex.has(index)) continue;
      addHeld(
        heldByIndex,
        index,
        `related PROJECT_NEW/LINEITEM_NEW marker held atomically because another marker in the new-project group was held: ${heldReason}`,
        { marker: markers[index], source: 'processing-quality-atomic-group' }
      );
    }
  }
}

function attachmentDispositionHandlesPresentAttachments(value) {
  const text = compactText(value).toLowerCase();
  return isHandledAttachmentDisposition(text) || isFailedAttachmentDisposition(text);
}

export function hasContentNotIndexedAttachmentFailure(item = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (isContentNotIndexedAttachmentDisposition(item.attachmentsHandled)) return true;
  return normalizeArray(item.attachments).some(attachment => {
    return isContentNotIndexedAttachmentDisposition(
      attachment?.attachmentsHandled
      || attachment?.disposition
      || attachment?.status
      || attachment?.error
      || attachment?.reason
    );
  });
}

function attachmentIndexAttempts(existingItem) {
  const explicit = Number(existingItem?.attachmentIndexAttempts);
  if (Number.isInteger(explicit) && explicit > 0) return explicit;
  return hasContentNotIndexedAttachmentFailure(existingItem) ? 1 : 0;
}

function annotateAttachmentIndexRetry(item, existingItem) {
  if (!hasContentNotIndexedAttachmentFailure(item)) return item;
  const attempts = Math.min(3, attachmentIndexAttempts(existingItem) + 1);
  return {
    ...item,
    attachmentIndexAttempts: attempts,
    reprobeNextScan: attempts < 3,
    attachmentRetryReason: 'content-not-indexed'
  };
}

function shouldHoldCursorForAttachmentRetry(item) {
  return hasContentNotIndexedAttachmentFailure(item)
    && Number(item?.attachmentIndexAttempts || 1) < 3;
}

function parseTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function maxDate(values) {
  const times = values.map(parseTime).filter(value => value !== null);
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

export function itemRefKey(itemRef) {
  if (typeof itemRef === 'string') return compactText(itemRef);
  if (!itemRef || typeof itemRef !== 'object' || Array.isArray(itemRef)) return '';
  const type = compactText(itemRef.type || 'm365');
  const id = compactText(itemRef.id || itemRef.itemId || itemRef.messageId || itemRef.url);
  return id ? `${type}:${id}` : '';
}

export function validateLedgerItem(item, pathName = 'processing.ledger[]') {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return `${pathName} must be an object`;
  if (!itemRefKey(item.itemRef)) return `${pathName}.itemRef is required`;
  if (!compactText(item.threadRef)) return `${pathName}.threadRef is required`;
  if (parseTime(item.date) === null) return `${pathName}.date must be a parseable date`;
  if (!LEDGER_DISPOSITIONS.has(item.disposition)) {
    return `${pathName}.disposition must be one of ${[...LEDGER_DISPOSITIONS].join(', ')}`;
  }
  if (!Array.isArray(item.nodeRefs)) return `${pathName}.nodeRefs must be an array`;
  if (!isValidAttachmentDisposition(item.attachmentsHandled)) {
    return `${pathName}.attachmentsHandled must be yes(workiq-index), yes, none, or failed(<reason>)`;
  }
  if (hasAttachmentSignal(item) && !attachmentDispositionHandlesPresentAttachments(item.attachmentsHandled)) {
    return `${pathName}.attachmentsHandled must be yes(workiq-index), yes, or failed(<reason>) when attachments are present`;
  }
  if (!compactText(item.quote)) return `${pathName}.quote is required`;
  if (!compactText(item.reason)) return `${pathName}.reason is required`;
  return null;
}

export function normalizeLedgerItem(item, { now = new Date() } = {}) {
  const normalized = {
    ...item,
    itemRef: item.itemRef,
    threadRef: compactText(item.threadRef),
    date: item.date,
    disposition: item.disposition,
    nodeRefs: normalizeArray(item.nodeRefs).map(String),
    attachmentsHandled: compactText(item.attachmentsHandled),
    quote: compactText(item.quote),
    reason: compactText(item.reason),
    processedAt: item.processedAt || (now instanceof Date ? now.toISOString() : String(now || new Date().toISOString()))
  };
  if (item.attachmentIndexAttempts !== undefined) normalized.attachmentIndexAttempts = Number(item.attachmentIndexAttempts);
  if (item.reprobeNextScan !== undefined) normalized.reprobeNextScan = Boolean(item.reprobeNextScan);
  if (item.attachmentRetryReason !== undefined) normalized.attachmentRetryReason = compactText(item.attachmentRetryReason);
  if (item.hasAttachments !== undefined) normalized.hasAttachments = Boolean(item.hasAttachments);
  if (item.attachmentCount !== undefined) normalized.attachmentCount = Number(item.attachmentCount);
  if (Array.isArray(item.attachments)) normalized.attachments = item.attachments;
  if (item.countProbe) normalized.countProbe = item.countProbe;
  return normalized;
}

export function extractProcessingLedgerFromPayload(payload = {}) {
  return [
    ...normalizeArray(payload.processing?.ledger),
    ...normalizeArray(payload.processingLedger)
  ];
}

export function extractEnumeratedItemsFromPayload(payload = {}) {
  return [
    ...normalizeArray(payload.processing?.enumeratedItems),
    ...normalizeArray(payload.processingEnumeratedItems)
  ];
}

export function extractThreadCountsFromPayload(payload = {}) {
  return [
    ...normalizeArray(payload.processing?.threadCounts),
    ...normalizeArray(payload.processingQuality?.threadCounts)
  ];
}

export function validateProcessingPayload(payload = {}, pathName = 'payload') {
  const ledger = extractProcessingLedgerFromPayload(payload);
  for (const [index, item] of ledger.entries()) {
    const error = validateLedgerItem(item, `${pathName}.processingLedger[${index}]`);
    if (error) return error;
  }
  for (const [index, item] of extractEnumeratedItemsFromPayload(payload).entries()) {
    if (!itemRefKey(item.itemRef || item)) return `${pathName}.processingEnumeratedItems[${index}].itemRef is required`;
    if (!compactText(item.threadRef)) return `${pathName}.processingEnumeratedItems[${index}].threadRef is required`;
  }
  for (const [index, count] of extractThreadCountsFromPayload(payload).entries()) {
    if (!compactText(count.threadRef)) return `${pathName}.threadCounts[${index}].threadRef is required`;
    if (!Number.isInteger(Number(count.count)) || Number(count.count) < 0) {
      return `${pathName}.threadCounts[${index}].count must be a non-negative integer`;
    }
  }
  return null;
}

function mergeThreadState(threads, threadRef, date) {
  if (!threadRef) return;
  const existing = threads[threadRef];
  const existingDate = typeof existing === 'string' ? existing : existing?.lastProcessedMessageDate;
  const latest = maxDate([existingDate, date]);
  threads[threadRef] = {
    ...(existing && typeof existing === 'object' && !Array.isArray(existing) ? existing : {}),
    lastProcessedMessageDate: latest || date || existingDate || null
  };
}

export function normalizeProcessing(value = {}) {
  const input = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const threads = {};
  const rawThreads = input.threads && typeof input.threads === 'object' && !Array.isArray(input.threads)
    ? input.threads
    : {};
  for (const [threadRef, state] of Object.entries(rawThreads)) {
    const key = compactText(threadRef);
    if (!key) continue;
    if (typeof state === 'string') threads[key] = { lastProcessedMessageDate: state };
    else if (state && typeof state === 'object' && !Array.isArray(state)) {
      threads[key] = {
        ...state,
        lastProcessedMessageDate: state.lastProcessedMessageDate || null
      };
    }
  }
  return {
    cursorDate: input.cursorDate || null,
    lookbackDays: Number.isInteger(Number(input.lookbackDays)) && Number(input.lookbackDays) > 0
      ? Number(input.lookbackDays)
      : DEFAULT_PROCESSING_LOOKBACK_DAYS,
    threads,
    ledger: normalizeArray(input.ledger)
  };
}

export function mergeProcessing(existing, payload = {}, { now = new Date() } = {}) {
  const merged = normalizeProcessing(existing);
  const priorCursorDate = merged.cursorDate;
  const incoming = payload.processing && typeof payload.processing === 'object' && !Array.isArray(payload.processing)
    ? payload.processing
    : {};

  if (incoming.lookbackDays !== undefined && Number.isInteger(Number(incoming.lookbackDays)) && Number(incoming.lookbackDays) > 0) {
    merged.lookbackDays = Number(incoming.lookbackDays);
  }

  const byKey = new Map(merged.ledger.map(item => [itemRefKey(item.itemRef), item]));
  const newItems = extractProcessingLedgerFromPayload(payload).map(item => {
    const normalized = normalizeLedgerItem(item, { now });
    return annotateAttachmentIndexRetry(normalized, byKey.get(itemRefKey(normalized.itemRef)));
  });
  const cursorEligibleDates = [];
  const blockedThreadDates = new Map();
  for (const item of newItems) {
    byKey.set(itemRefKey(item.itemRef), item);
    if (shouldHoldCursorForAttachmentRetry(item)) {
      const threadRef = compactText(item.threadRef);
      const itemTime = parseTime(item.date);
      if (threadRef && itemTime !== null) {
        const existingTime = blockedThreadDates.get(threadRef);
        if (existingTime === undefined || itemTime < existingTime) blockedThreadDates.set(threadRef, itemTime);
      }
      continue;
    }
    cursorEligibleDates.push(item.date);
    mergeThreadState(merged.threads, item.threadRef, item.date);
  }
  merged.ledger = [...byKey.values()];

  if (incoming.threads && typeof incoming.threads === 'object' && !Array.isArray(incoming.threads)) {
    for (const [threadRef, state] of Object.entries(incoming.threads)) {
      const key = compactText(threadRef);
      const date = typeof state === 'string' ? state : state?.lastProcessedMessageDate;
      const blockTime = blockedThreadDates.get(key);
      const dateTime = parseTime(date);
      if (blockTime !== undefined && (dateTime === null || dateTime >= blockTime)) continue;
      mergeThreadState(merged.threads, key, date);
    }
  }

  const latestCommittedDate = maxDate(cursorEligibleDates);
  let nextCursorDate = maxDate([merged.cursorDate, incoming.cursorDate, latestCommittedDate]);
  const blockedTimes = newItems
    .filter(shouldHoldCursorForAttachmentRetry)
    .map(item => parseTime(item.date))
    .filter(value => value !== null);
  if (blockedTimes.length) {
    const earliestBlocked = Math.min(...blockedTimes);
    const nextCursorTime = parseTime(nextCursorDate);
    if (nextCursorTime !== null && nextCursorTime >= earliestBlocked) {
      const priorCursorTime = parseTime(priorCursorDate);
      nextCursorDate = priorCursorTime !== null && priorCursorTime < earliestBlocked
        ? priorCursorDate
        : null;
    }
  }
  merged.cursorDate = nextCursorDate;
  return merged;
}

export function filterMarkersByProcessingQualityGate(markers = []) {
  const inputMarkers = normalizeArray(markers);
  const projectEntries = inputMarkers
    .map((marker, index) => ({ marker, index }))
    .filter(entry => isProcessingLedgerMarker(entry.marker));
  const scanQuality = scanDoneProcessingQuality(inputMarkers);
  const required = Boolean(scanQuality.required || projectEntries.some(entry => entry.marker.payload?.processingQuality?.required));
  const globalEnumerated = normalizeArray(scanQuality.enumeratedItems);
  const globalThreadCounts = normalizeArray(scanQuality.threadCounts);

  const heldByIndex = new Map();
  const reviewReasons = [];
  const normalizedLedger = [];
  const markerLedgerByIndex = new Map();
  const markerThreadCountsByIndex = new Map();
  const ledgerKeyToMarkerIndexes = new Map();
  const enumeratedKeyToMarkerIndexes = new Map();
  const enumerated = [];
  const threadCounts = [];

  const addReviewReason = (reason, details = {}) => {
    reviewReasons.push({ reason, ...details });
  };

  for (const [index, item] of globalEnumerated.entries()) {
    const key = itemRefKey(item?.itemRef || item);
    if (!key) {
      addReviewReason(`enumeratedItems[${index}].itemRef is required`, { source: 'scan_done' });
      continue;
    }
    if (!compactText(item.threadRef)) {
      addReviewReason(`enumeratedItems[${index}].threadRef is required`, { source: 'scan_done', key });
      continue;
    }
    enumerated.push({ item, key, markerIndex: null, source: 'scan_done' });
  }

  for (const [index, count] of globalThreadCounts.entries()) {
    const threadRef = compactText(count?.threadRef);
    const expected = Number(count?.count);
    if (!threadRef || !Number.isInteger(expected) || expected < 0) {
      addReviewReason(`threadCounts[${index}] is malformed`, { source: 'scan_done' });
      continue;
    }
    threadCounts.push({ threadRef, expected, markerIndex: null, source: 'scan_done' });
  }

  for (const { marker, index } of projectEntries) {
    const payload = marker.payload || {};
    const rawLedger = extractProcessingLedgerFromPayload(payload);
    const markerLedger = [];
    let markerHasError = false;

    for (const [ledgerIndex, item] of rawLedger.entries()) {
      const error = validateLedgerItem(item, `${marker.type}.processingLedger[${ledgerIndex}]`);
      if (error) {
        addHeld(heldByIndex, index, error, { marker, source: 'processing-ledger-validation' });
        markerHasError = true;
        continue;
      }
      const normalized = normalizeLedgerItem(item);
      markerLedger.push(normalized);
      normalizedLedger.push(normalized);
      const key = itemRefKey(normalized.itemRef);
      if (!ledgerKeyToMarkerIndexes.has(key)) ledgerKeyToMarkerIndexes.set(key, new Set());
      ledgerKeyToMarkerIndexes.get(key).add(index);
    }

    for (const [enumeratedIndex, item] of extractEnumeratedItemsFromPayload(payload).entries()) {
      const key = itemRefKey(item?.itemRef || item);
      if (!key) {
        addHeld(heldByIndex, index, `${marker.type}.processingEnumeratedItems[${enumeratedIndex}].itemRef is required`, {
          marker,
          source: 'processing-ledger-validation'
        });
        markerHasError = true;
        continue;
      }
      if (!compactText(item.threadRef)) {
        addHeld(heldByIndex, index, `${marker.type}.processingEnumeratedItems[${enumeratedIndex}].threadRef is required`, {
          marker,
          source: 'processing-ledger-validation',
          key
        });
        markerHasError = true;
        continue;
      }
      enumerated.push({ item, key, markerIndex: index, source: marker.type });
      if (!enumeratedKeyToMarkerIndexes.has(key)) enumeratedKeyToMarkerIndexes.set(key, new Set());
      enumeratedKeyToMarkerIndexes.get(key).add(index);
    }

    const markerThreadCounts = [];
    for (const [countIndex, count] of extractThreadCountsFromPayload(payload).entries()) {
      const threadRef = compactText(count?.threadRef);
      const expected = Number(count?.count);
      if (!threadRef || !Number.isInteger(expected) || expected < 0) {
        addHeld(heldByIndex, index, `${marker.type}.threadCounts[${countIndex}] is malformed`, {
          marker,
          source: 'processing-ledger-validation'
        });
        markerHasError = true;
        continue;
      }
      markerThreadCounts.push({ threadRef, expected, markerIndex: index, source: marker.type });
      threadCounts.push({ threadRef, expected, markerIndex: index, source: marker.type });
    }

    if (!markerHasError) {
      markerLedgerByIndex.set(index, markerLedger);
      markerThreadCountsByIndex.set(index, markerThreadCounts);
    }
  }

  if (!required && !normalizedLedger.length && !enumerated.length && !threadCounts.length) {
    return {
      ok: true,
      reason: null,
      markers: inputMarkers,
      approved: inputMarkers,
      held: [],
      reviewReasons: [],
      ledgerItems: [],
      ledgerCount: 0,
      skipped: true
    };
  }

  const ledgerKeys = new Set(normalizedLedger.map(item => itemRefKey(item.itemRef)));
  const enumeratedAttachmentKeys = new Set();
  const missingEnumeratedByThread = new Map();
  for (const item of enumerated) {
    if (hasAttachmentSignal(item.item)) enumeratedAttachmentKeys.add(item.key);
    if (ledgerKeys.has(item.key)) continue;

    const reason = `missing ledger disposition for enumerated item ${item.key}`;
    const markerIndexes = Number.isInteger(item.markerIndex)
      ? new Set([item.markerIndex])
      : enumeratedKeyToMarkerIndexes.get(item.key);
    if (markerIndexes?.size) {
      for (const index of markerIndexes) {
        addHeld(heldByIndex, index, reason, {
          marker: inputMarkers[index],
          source: 'processing-ledger-completeness',
          key: item.key
        });
      }
    } else {
      addReviewReason(reason, { source: 'scan_done', key: item.key });
    }
    const threadRef = compactText(item.item?.threadRef);
    if (threadRef) {
      if (!missingEnumeratedByThread.has(threadRef)) missingEnumeratedByThread.set(threadRef, []);
      missingEnumeratedByThread.get(threadRef).push(item.key);
    }
  }

  for (const item of normalizedLedger) {
    const key = itemRefKey(item.itemRef);
    if (!enumeratedAttachmentKeys.has(key) || attachmentDispositionHandlesPresentAttachments(item.attachmentsHandled)) continue;
    const reason = `ledger disposition for ${key} has attachments but attachmentsHandled is not yes(workiq-index), yes, or failed(<reason>)`;
    const markerIndexes = ledgerKeyToMarkerIndexes.get(key);
    if (markerIndexes?.size) {
      for (const index of markerIndexes) {
        addHeld(heldByIndex, index, reason, {
          marker: inputMarkers[index],
          source: 'processing-ledger-attachment',
          key
        });
      }
    } else {
      addReviewReason(reason, { source: 'scan_done', key });
    }
  }

  for (const count of markerThreadCountsByIndex.values()) {
    for (const item of count) {
      const markerLedger = markerLedgerByIndex.get(item.markerIndex) || [];
      const actual = markerLedger.filter(ledgerItem => ledgerItem.threadRef === item.threadRef).length;
      if (actual === item.expected) continue;
      addHeld(heldByIndex, item.markerIndex, `ledger count mismatch for ${item.threadRef}: expected ${item.expected}, got ${actual}`, {
        marker: inputMarkers[item.markerIndex],
        source: 'processing-ledger-thread-count'
      });
    }
  }

  for (const item of threadCounts.filter(count => count.markerIndex === null)) {
    const actual = normalizedLedger.filter(ledgerItem => ledgerItem.threadRef === item.threadRef).length;
    if (actual === item.expected) continue;
    const missing = missingEnumeratedByThread.get(item.threadRef);
    const suffix = missing?.length ? `; missing item(s): ${missing.join(', ')}` : '';
    addReviewReason(`ledger count mismatch for ${item.threadRef}: expected ${item.expected}, got ${actual}${suffix}`, {
      source: 'scan_done',
      threadRef: item.threadRef
    });
  }

  expandAtomicHolds(inputMarkers, heldByIndex);

  const held = [...heldByIndex.values()].sort((a, b) => a.index - b.index);
  const heldIndexes = new Set(held.map(item => item.index));
  const approved = inputMarkers.filter((_, index) => !heldIndexes.has(index));
  const issueReasons = [
    ...held.map(item => item.reason),
    ...reviewReasons.map(item => item.reason)
  ];

  return {
    ok: issueReasons.length === 0,
    reason: issueReasons[0] || null,
    markers: approved,
    approved,
    held,
    reviewReasons,
    ledgerItems: normalizedLedger,
    ledgerCount: normalizedLedger.length,
    skipped: false
  };
}

export function evaluateProcessingQualityGate(markers = []) {
  const projectMarkers = markers.filter(marker => marker?.type === 'PROJECT_NEW' || marker?.type === 'PROJECT_UPDATE' || marker?.type === 'LINEITEM_NEW' || marker?.type === 'LINEITEM_UPDATE' || marker?.type === 'FACTSHEET_UPDATE');
  const scanDone = markers.find(marker => marker?.type === 'SCAN_DONE')?.payload || {};
  const scanQuality = scanDone.processingQuality && typeof scanDone.processingQuality === 'object' && !Array.isArray(scanDone.processingQuality)
    ? scanDone.processingQuality
    : {};
  const required = Boolean(scanQuality.required || projectMarkers.some(marker => marker.payload?.processingQuality?.required));
  const ledger = [];
  const enumerated = normalizeArray(scanQuality.enumeratedItems);
  const threadCounts = normalizeArray(scanQuality.threadCounts);

  for (const marker of projectMarkers) {
    const payload = marker.payload || {};
    const processingError = validateProcessingPayload(payload, marker.type);
    if (processingError) return { ok: false, reason: processingError, ledgerItems: ledger, ledgerCount: ledger.length };
    ledger.push(...extractProcessingLedgerFromPayload(payload));
    enumerated.push(...extractEnumeratedItemsFromPayload(payload));
    threadCounts.push(...extractThreadCountsFromPayload(payload));
  }

  const normalizedLedger = [];
  for (const [index, item] of ledger.entries()) {
    const error = validateLedgerItem(item, `ledger[${index}]`);
    if (error) return { ok: false, reason: error, ledgerItems: normalizedLedger, ledgerCount: normalizedLedger.length };
    normalizedLedger.push(normalizeLedgerItem(item));
  }

  if (!required && !normalizedLedger.length && !enumerated.length && !threadCounts.length) {
    return { ok: true, reason: null, ledgerItems: [], ledgerCount: 0, skipped: true };
  }

  const ledgerKeys = new Set(normalizedLedger.map(item => itemRefKey(item.itemRef)));
  const enumeratedAttachmentKeys = new Set();
  for (const [index, item] of enumerated.entries()) {
    const key = itemRefKey(item.itemRef || item);
    if (!key) return { ok: false, reason: `enumeratedItems[${index}].itemRef is required`, ledgerItems: normalizedLedger, ledgerCount: normalizedLedger.length };
    if (hasAttachmentSignal(item)) enumeratedAttachmentKeys.add(key);
    if (!ledgerKeys.has(key)) {
      return { ok: false, reason: `missing ledger disposition for enumerated item ${key}`, ledgerItems: normalizedLedger, ledgerCount: normalizedLedger.length };
    }
  }

  for (const item of normalizedLedger) {
    const key = itemRefKey(item.itemRef);
    if (enumeratedAttachmentKeys.has(key) && !attachmentDispositionHandlesPresentAttachments(item.attachmentsHandled)) {
      return {
        ok: false,
        reason: `ledger disposition for ${key} has attachments but attachmentsHandled is not yes(workiq-index), yes, or failed(<reason>)`,
        ledgerItems: normalizedLedger,
        ledgerCount: normalizedLedger.length
      };
    }
  }

  for (const [index, count] of threadCounts.entries()) {
    const threadRef = compactText(count.threadRef);
    const expected = Number(count.count);
    if (!threadRef || !Number.isInteger(expected) || expected < 0) {
      return { ok: false, reason: `threadCounts[${index}] is malformed`, ledgerItems: normalizedLedger, ledgerCount: normalizedLedger.length };
    }
    const actual = normalizedLedger.filter(item => item.threadRef === threadRef).length;
    if (actual !== expected) {
      return { ok: false, reason: `ledger count mismatch for ${threadRef}: expected ${expected}, got ${actual}`, ledgerItems: normalizedLedger, ledgerCount: normalizedLedger.length };
    }
  }

  return {
    ok: true,
    reason: null,
    ledgerItems: normalizedLedger,
    ledgerCount: normalizedLedger.length,
    skipped: false
  };
}
