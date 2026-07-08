export const LEDGER_DISPOSITIONS = new Set([
  'updates-node',
  'no-change',
  'new-node',
  'conflict',
  'not-this-project',
  'already-processed'
]);

export const DEFAULT_PROCESSING_LOOKBACK_DAYS = 14;

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isFailedAttachmentDisposition(value) {
  return /^failed\(.+\)$/i.test(compactText(value));
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

function attachmentDispositionHandlesPresentAttachments(value) {
  const text = compactText(value).toLowerCase();
  return isHandledAttachmentDisposition(text) || isFailedAttachmentDisposition(text);
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
  const incoming = payload.processing && typeof payload.processing === 'object' && !Array.isArray(payload.processing)
    ? payload.processing
    : {};

  if (incoming.lookbackDays !== undefined && Number.isInteger(Number(incoming.lookbackDays)) && Number(incoming.lookbackDays) > 0) {
    merged.lookbackDays = Number(incoming.lookbackDays);
  }

  const byKey = new Map(merged.ledger.map(item => [itemRefKey(item.itemRef), item]));
  const newItems = extractProcessingLedgerFromPayload(payload).map(item => normalizeLedgerItem(item, { now }));
  for (const item of newItems) {
    byKey.set(itemRefKey(item.itemRef), item);
    mergeThreadState(merged.threads, item.threadRef, item.date);
  }
  merged.ledger = [...byKey.values()];

  if (incoming.threads && typeof incoming.threads === 'object' && !Array.isArray(incoming.threads)) {
    for (const [threadRef, state] of Object.entries(incoming.threads)) {
      mergeThreadState(merged.threads, compactText(threadRef), typeof state === 'string' ? state : state?.lastProcessedMessageDate);
    }
  }

  const latestCommittedDate = maxDate(newItems.map(item => item.date));
  merged.cursorDate = maxDate([merged.cursorDate, incoming.cursorDate, latestCommittedDate]);
  return merged;
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
