import { createHash } from 'node:crypto';

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeOwner(value) {
  const raw = normalizeText(value);
  if (!raw) return 'user';
  const lower = raw.toLowerCase();
  if (['user', 'martin', 'du', 'me', 'ich', 'app-user', 'app user'].includes(lower)) return 'user';
  return raw;
}

export function isUserOwner(value) {
  return normalizeOwner(value) === 'user';
}

export function displayOwner(value) {
  return isUserOwner(value) ? 'You' : normalizeOwner(value);
}

function evidenceList(entry) {
  const ids = [];
  if (entry?.evidence) ids.push(entry.evidence);
  if (entry?.evidenceRefId) ids.push(entry.evidenceRefId);
  if (entry?.sourceRefId) ids.push(entry.sourceRefId);
  ids.push(...normalizeArray(entry?.evidenceRefIds));
  return [...new Set(ids.filter(Boolean).map(String))];
}

export function userActionContentKey(entry) {
  const text = normalizeText(typeof entry === 'string' ? entry : entry?.text).toLowerCase();
  const date = normalizeText(entry?.date || entry?.dueAt || entry?.at).slice(0, 32);
  const evidence = evidenceList(entry).sort().join(',');
  return JSON.stringify({ text, date, evidence });
}

export function stableUserActionId(entry) {
  const hash = createHash('sha1').update(userActionContentKey(entry)).digest('hex').slice(0, 12);
  return `ua-${hash}`;
}

export function normalizeUserActionEntry(value, { fallbackConfidence = 'low' } = {}) {
  if (!value) return null;
  const base = typeof value === 'string' ? { text: value } : { ...value };
  const text = normalizeText(base.text || base.current || base.summary);
  if (!text) return null;

  const evidenceRefIds = evidenceList(base);
  const normalized = {
    ...base,
    id: normalizeText(base.id) || stableUserActionId({ ...base, text }),
    text,
    owner: normalizeOwner(base.owner),
    date: base.date || base.dueAt || base.at || null,
    evidence: base.evidence || base.evidenceRefId || base.sourceRefId || evidenceRefIds[0] || null,
    evidenceRefIds,
    confidence: base.confidence || fallbackConfidence || 'low',
    userMarkedDoneAt: base.userMarkedDoneAt || null
  };

  if (!normalized.userMarkedDoneAt) normalized.userMarkedDoneAt = null;
  return normalized;
}

export function normalizePmStatusUserActions(pmStatus) {
  if (!pmStatus || typeof pmStatus !== 'object' || Array.isArray(pmStatus)) return pmStatus;
  const result = { ...pmStatus };
  result.userActions = normalizeArray(pmStatus.userActions)
    .map(entry => normalizeUserActionEntry(entry, { fallbackConfidence: pmStatus.confidence || 'low' }))
    .filter(Boolean);
  return result;
}

function actionMapById(actions) {
  const map = new Map();
  for (const action of actions) {
    if (action?.id) map.set(action.id, action);
  }
  return map;
}

function actionMapByContent(actions) {
  const map = new Map();
  for (const action of actions) map.set(userActionContentKey(action), action);
  return map;
}

function findExistingAction(action, byId, byContent) {
  if (action?.id && byId.has(action.id)) return byId.get(action.id);
  return byContent.get(userActionContentKey(action)) || null;
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
}

function dateOnly(value) {
  return String(value || '').slice(0, 10);
}

export function mergeUserActionCarryForward(existingPmStatus, incomingPmStatus, {
  now = new Date(),
  evidenceRefIds = [],
  rawIncomingPmStatus = incomingPmStatus
} = {}) {
  const pmStatus = normalizePmStatusUserActions(incomingPmStatus);
  if (!pmStatus || typeof pmStatus !== 'object') {
    return { pmStatus, historyEvents: [] };
  }

  const existingActions = normalizeArray(normalizePmStatusUserActions(existingPmStatus)?.userActions);
  const byId = actionMapById(existingActions);
  const byContent = actionMapByContent(existingActions);
  const matchedExistingIds = new Set();
  const historyEvents = [];
  const ts = nowIso(now);
  const evidenceIds = normalizeArray(evidenceRefIds);

  pmStatus.userActions = normalizeArray(pmStatus.userActions).map(action => {
    const existing = findExistingAction(action, byId, byContent);
    const incomingRaw = normalizeArray(rawIncomingPmStatus?.userActions)
      .find(raw => raw && typeof raw === 'object' && (raw.id === action.id || userActionContentKey(raw) === userActionContentKey(action)));
    const hasExplicitDoneFlag = incomingRaw && Object.hasOwn(incomingRaw, 'userMarkedDoneAt');
    const next = { ...action };

    if (!existing) {
      if (hasExplicitDoneFlag && next.userMarkedDoneAt) next.userMarkedDoneAt = null;
      return next;
    }

    matchedExistingIds.add(existing.id);
    next.owner = existing.owner || next.owner || 'user';

    if (!hasExplicitDoneFlag && existing.userMarkedDoneAt) {
      next.userMarkedDoneAt = existing.userMarkedDoneAt;
      return next;
    }

    if (hasExplicitDoneFlag && !next.userMarkedDoneAt && existing.userMarkedDoneAt) {
      next.reopenedUserMarkedDoneAt = existing.userMarkedDoneAt;
      next.reopenedAt = ts;
      if (evidenceIds.length) next.reopenedEvidenceRefIds = evidenceIds;
      historyEvents.push({
        timestamp: ts,
        type: 'user-action-reopened',
        text: `User action reopened after it was marked done on ${dateOnly(existing.userMarkedDoneAt)}: ${existing.text}`,
        evidenceRefIds: evidenceIds,
        userAction: existing
      });
      return next;
    }

    return next;
  });

  for (const existing of existingActions) {
    if (!existing.userMarkedDoneAt || matchedExistingIds.has(existing.id)) continue;
    historyEvents.push({
      timestamp: ts,
      type: 'user-action-confirmed',
      text: `User-marked action confirmed closed: ${existing.text}`,
      evidenceRefIds: evidenceIds.length ? evidenceIds : normalizeArray(existing.evidenceRefIds),
      userAction: existing
    });
  }

  return { pmStatus, historyEvents };
}

export function splitUserActionsByDone(actions) {
  const active = [];
  const done = [];
  for (const entry of normalizeArray(actions)) {
    const normalized = normalizeUserActionEntry(entry);
    if (!normalized) continue;
    if (normalized.userMarkedDoneAt) done.push(normalized);
    else active.push(normalized);
  }
  return { active, done };
}
