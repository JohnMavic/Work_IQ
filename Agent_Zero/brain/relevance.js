export const RELEVANCE_REASON_MAX_CHARS = 240;

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function normalizeEvidenceRefIds(value) {
  return Array.isArray(value)
    ? [...new Set(value.map(item => String(item || '').trim()).filter(Boolean))]
    : [];
}

export function normalizeRelevance(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const score = Number(value.score);
  return {
    score: Number.isInteger(score) ? Math.min(100, Math.max(0, score)) : null,
    reason: compactText(value.reason).slice(0, RELEVANCE_REASON_MAX_CHARS),
    evidenceRefIds: normalizeEvidenceRefIds(value.evidenceRefIds),
    assessedAt: value.assessedAt || null
  };
}

export function validateRelevance(value, pathName = 'relevance') {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return `${pathName} must be an object`;
  }
  if (!Number.isInteger(Number(value.score)) || Number(value.score) < 0 || Number(value.score) > 100) {
    return `${pathName}.score must be an integer from 0 to 100`;
  }
  const reason = compactText(value.reason);
  if (!reason) return `${pathName}.reason is required`;
  if (reason.length > RELEVANCE_REASON_MAX_CHARS) {
    return `${pathName}.reason must be at most ${RELEVANCE_REASON_MAX_CHARS} characters`;
  }
  if (!Array.isArray(value.evidenceRefIds) || value.evidenceRefIds.length === 0) {
    return `${pathName}.evidenceRefIds must contain at least one evidence reference`;
  }
  if (value.assessedAt !== undefined && value.assessedAt !== null && !Number.isFinite(Date.parse(value.assessedAt))) {
    return `${pathName}.assessedAt must be a parseable date when present`;
  }
  return null;
}

export function relevanceBand(score) {
  const value = Number(score);
  if (!Number.isFinite(value)) return 'unranked';
  if (value >= 75) return 'act-now';
  if (value >= 50) return 'next';
  if (value >= 25) return 'monitor';
  return 'reference';
}

export const INACTIVE_LINE_ITEM_STATUSES = Object.freeze([
  'done', 'completed', 'closed', 'obsolete', 'superseded', 'cancelled', 'canceled', 'resolved'
]);

export const INACTIVE_LINE_ITEM_STATES = Object.freeze(['obsolete', 'superseded']);

function normalizeStatusToken(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

// Shared, pure inactivity predicate: decides whether an evidence-backed semantic
// relevance object is mandatory for a line item, based only on its lifecycle
// status and truth-tree state. Independent of priority, confidence, review
// status, title, sender, keywords, and topic. Does not mutate the input.
export function requiresSemanticRelevance(lineItem) {
  const status = normalizeStatusToken(lineItem?.status);
  if (INACTIVE_LINE_ITEM_STATUSES.includes(status)) return false;
  const state = normalizeStatusToken(lineItem?.state);
  if (INACTIVE_LINE_ITEM_STATES.includes(state)) return false;
  return true;
}
