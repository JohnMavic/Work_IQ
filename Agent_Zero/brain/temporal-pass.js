const PM_TEMPORAL_FIELDS = ['planned', 'waitingOn'];
const LINEITEM_TEXT_FIELDS = ['dueAt', 'referencedDate', 'plannedNext', 'waitingOn', 'currentState'];

const MONTHS = new Map(Object.entries({
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  juli: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  okt: 9,
  oktober: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
  dez: 11,
  dezember: 11
}));

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function dayUtcFromDate(value) {
  const parsed = Date.parse(value || '');
  if (!Number.isFinite(parsed)) return null;
  const date = new Date(parsed);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function todayUtc(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function validDay(year, month, day) {
  const y = Number(year);
  const m = Number(month);
  const d = Number(day);
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 2000 || m < 0 || m > 11 || d < 1 || d > 31) return null;
  const time = Date.UTC(y, m, d);
  const date = new Date(time);
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m || date.getUTCDate() !== d) return null;
  return time;
}

function monthIndex(value) {
  return MONTHS.get(String(value || '').toLowerCase()) ?? null;
}

function extractedDateDays(text) {
  const value = compactText(text);
  if (!value) return [];

  const days = [];
  for (const match of value.matchAll(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/g)) {
    const day = validDay(match[1], Number(match[2]) - 1, match[3]);
    if (day !== null) days.push(day);
  }

  for (const match of value.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?[.\s-]+([A-Za-zäÄöÖüÜ]+)[,.\s-]+(20\d{2})\b/g)) {
    const month = monthIndex(match[2]);
    if (month === null) continue;
    const day = validDay(match[3], month, match[1]);
    if (day !== null) days.push(day);
  }

  for (const match of value.matchAll(/\b([A-Za-zäÄöÖüÜ]+)\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s+(20\d{2})\b/g)) {
    const month = monthIndex(match[1]);
    if (month === null) continue;
    const day = validDay(match[3], month, match[2]);
    if (day !== null) days.push(day);
  }

  for (const match of value.matchAll(/\b(\d{1,2})[./](\d{1,2})[./](20\d{2})\b/g)) {
    const day = validDay(match[3], Number(match[2]) - 1, match[1]);
    if (day !== null) days.push(day);
  }

  return [...new Set(days)];
}

function hasPastDateValue(value, today) {
  if (value === undefined || value === null) return false;
  const direct = dayUtcFromDate(value);
  if (direct !== null && direct < today) return true;
  return extractedDateDays(value).some(day => day < today);
}

function isUnconfirmed(node) {
  return String(node?.state || 'unconfirmed').toLowerCase() === 'unconfirmed';
}

function isProject(task) {
  return task?.taskType === 'project' && !task.archived && !task.supersededBy;
}

function hasEvidence(node) {
  return Boolean(
    node?.evidence
    || node?.evidenceRefId
    || normalizeArray(node?.evidenceRefIds).length
    || normalizeArray(node?.sources).length
    || node?.lastConfirmedByMessageDate
    || node?.resolvedBy
    || node?.obsoleteEvidence
  );
}

function hasResolutionReason(node) {
  return Boolean(
    compactText(node?.obsoleteReason)
    || compactText(node?.supersededReason)
    || compactText(node?.reason)
    || node?.obsoleteEvidence
    || node?.resolvedBy
  );
}

function temporalNodeHandled(node) {
  const state = String(node?.state || '').toLowerCase();
  if (state === 'confirmed') return hasEvidence(node);
  if (state === 'obsolete' || state === 'superseded') return hasEvidence(node) && hasResolutionReason(node);
  return false;
}

function nodeLabel(node) {
  return compactText(node?.id || node?.title || node?.text || node?.currentState || 'unnamed');
}

function textKey(value) {
  return compactText(value).toLowerCase();
}

function pmEntryMatches(stale, incoming) {
  if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) return false;
  if (stale.id && incoming.id === stale.id) return true;
  const staleText = textKey(stale.text);
  return Boolean(staleText && textKey(incoming.text) === staleText);
}

function collectStaleNodes(data, { now = new Date() } = {}) {
  const today = todayUtc(now);
  const stale = [];
  for (const task of normalizeArray(data.tasks)) {
    if (!isProject(task)) continue;
    const pm = task.pmStatus || {};
    for (const field of PM_TEMPORAL_FIELDS) {
      for (const entry of normalizeArray(pm[field])) {
        if (!isUnconfirmed(entry)) continue;
        if (!hasPastDateValue(entry.date || entry.dueAt || entry.targetDate || entry.referencedDate || entry.text, today)) continue;
        stale.push({
          kind: 'pmStatus',
          taskId: task.id,
          field,
          id: entry.id || null,
          text: entry.text || '',
          label: `${task.id}.pmStatus.${field}:${nodeLabel(entry)}`
        });
      }
    }

    for (const item of normalizeArray(task.lineItems)) {
      if (!isUnconfirmed(item)) continue;
      if (String(item.resolutionStatus || '').toLowerCase() === 'resolved') continue;
      const hasPastDate = LINEITEM_TEXT_FIELDS.some(field => hasPastDateValue(item[field], today));
      if (!hasPastDate) continue;
      stale.push({
        kind: 'lineItem',
        taskId: task.id,
        lineItemId: item.id,
        label: `${task.id}.lineItems.${item.id || nodeLabel(item)}`
      });
    }
  }
  return stale;
}

function projectUpdateHandles(stale, marker) {
  const payload = marker?.payload || {};
  if (marker.type !== 'PROJECT_UPDATE' || payload.taskId !== stale.taskId || !payload.pmStatus) return false;
  const incoming = normalizeArray(payload.pmStatus[stale.field]).find(entry => pmEntryMatches(stale, entry));
  return temporalNodeHandled(incoming);
}

function lineItemUpdateHandles(stale, marker) {
  const payload = marker?.payload || {};
  if (marker.type !== 'LINEITEM_UPDATE') return false;
  if (payload.taskId !== stale.taskId || payload.lineItemId !== stale.lineItemId) return false;
  return temporalNodeHandled({
    ...(payload.patch || {}),
    evidenceRefIds: payload.evidenceRefIds
  });
}

function markerHandlesStaleNode(stale, marker) {
  if (stale.kind === 'pmStatus') return projectUpdateHandles(stale, marker);
  if (stale.kind === 'lineItem') return lineItemUpdateHandles(stale, marker);
  return false;
}

export function evaluateTemporalPassGate(data, markers = [], { now = new Date() } = {}) {
  const staleNodes = collectStaleNodes(data, { now });
  if (!staleNodes.length) return { ok: true, reason: null, staleNodes: [], addressed: [] };

  const addressed = [];
  const missing = [];
  for (const stale of staleNodes) {
    if (normalizeArray(markers).some(marker => markerHandlesStaleNode(stale, marker))) addressed.push(stale);
    else missing.push(stale);
  }

  if (missing.length) {
    const sample = missing.slice(0, 5).map(item => item.label).join(', ');
    return {
      ok: false,
      reason: `temporal pass missing obsolete/superseded or fresh confirmation for stale unconfirmed date(s): ${sample}`,
      staleNodes,
      addressed,
      missing
    };
  }

  return { ok: true, reason: null, staleNodes, addressed, missing: [] };
}

