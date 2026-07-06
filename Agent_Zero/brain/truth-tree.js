export const NODE_STATES = new Set(['unconfirmed', 'confirmed', 'disputed', 'superseded', 'obsolete']);
export const RESOLUTION_STATUSES = new Set(['open', 'resolved', 'obsolete']);

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function parseTime(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function dateOnlyUtc(value) {
  const parsed = parseTime(value);
  if (parsed === null) return null;
  const date = new Date(parsed);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function todayUtc(now) {
  const date = now instanceof Date ? now : new Date(now || Date.now());
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

export function normalizeNodeFields(value = {}, { defaultState = 'unconfirmed' } = {}) {
  const node = value && typeof value === 'object' && !Array.isArray(value) ? { ...value } : {};
  node.state = NODE_STATES.has(node.state) ? node.state : defaultState;
  node.sources = normalizeArray(node.sources);
  node.lastConfirmedByMessageDate = node.lastConfirmedByMessageDate || null;
  if (node.threadRef !== undefined && node.threadRef !== null) node.threadRef = compactText(node.threadRef);
  if (node.lastVerifiedMessageDate !== undefined && node.lastVerifiedMessageDate !== null) {
    node.lastVerifiedMessageDate = compactText(node.lastVerifiedMessageDate);
  }
  if (node.resolutionStatus !== undefined && node.resolutionStatus !== null) {
    node.resolutionStatus = compactText(node.resolutionStatus);
  }
  return node;
}

export function validateNodeState(node, pathName = 'node') {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return null;
  if (node.state !== undefined && !NODE_STATES.has(node.state)) {
    return `${pathName}.state must be one of ${[...NODE_STATES].join(', ')}`;
  }
  if (node.resolutionStatus !== undefined && !RESOLUTION_STATUSES.has(node.resolutionStatus)) {
    return `${pathName}.resolutionStatus must be open, resolved, or obsolete`;
  }
  if (node.state === 'disputed') {
    const positions = normalizeArray(node.conflict?.positions);
    if (positions.length < 2) return `${pathName}.conflict.positions must contain both sides for disputed state`;
    for (const [index, position] of positions.entries()) {
      if (!position || typeof position !== 'object' || Array.isArray(position)) {
        return `${pathName}.conflict.positions[${index}] must be an object`;
      }
      if (!compactText(position.text || position.quote)) {
        return `${pathName}.conflict.positions[${index}] requires text or quote`;
      }
      if (!compactText(position.from)) return `${pathName}.conflict.positions[${index}] requires from`;
      if (!compactText(position.date)) return `${pathName}.conflict.positions[${index}] requires date`;
    }
  }
  if (node.state === 'superseded' && node.supersededByMessageDate !== undefined && parseTime(node.supersededByMessageDate) === null) {
    return `${pathName}.supersededByMessageDate must be a parseable date`;
  }
  return null;
}

export function isActionLikeLineItem(item = {}) {
  if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
  if (item.userActionRequired || compactText(item.userAction)) return true;
  return compactText(item.owner) && compactText(item.category).toLowerCase() === 'action';
}

export function actionText(entry = {}) {
  return compactText(entry.text || entry.userAction || entry.title || entry.currentState);
}

function quoteHasRequiredFields(quote) {
  return quote
    && typeof quote === 'object'
    && !Array.isArray(quote)
    && compactText(quote.text)
    && compactText(quote.from)
    && compactText(quote.date);
}

export function validateActionGate(entry, {
  pathName = 'action',
  now = new Date()
} = {}) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `${pathName} must be an object`;
  const nodeError = validateNodeState(entry, pathName);
  if (nodeError) return nodeError;

  if (!actionText(entry)) return `${pathName} requires action text`;

  if (!quoteHasRequiredFields(entry.askQuote)) {
    return `${pathName}.askQuote requires verbatim text, from, and date`;
  }

  const threadRef = compactText(entry.threadRef || entry.askQuote.threadRef);
  if (!threadRef) return `${pathName}.threadRef must be a stable conversation or item id`;
  if (entry.askQuote.threadRef && compactText(entry.askQuote.threadRef) !== threadRef) {
    return `${pathName}.askQuote.threadRef must match threadRef`;
  }

  const resolutionStatus = compactText(entry.resolutionStatus);
  if (resolutionStatus !== 'open') return `${pathName}.resolutionStatus must be open for visible actions`;
  if (entry.resolvedBy) return `${pathName} is open but has resolvedBy evidence`;

  const check = entry.threadCheck && typeof entry.threadCheck === 'object' && !Array.isArray(entry.threadCheck)
    ? entry.threadCheck
    : {};
  const coverage = compactText(entry.threadCoverage || check.coverage).toLowerCase();
  if (coverage !== 'complete') return `${pathName}.threadCheck.coverage must be complete`;
  const addressedTo = compactText(entry.addressedTo || check.addressedTo || check.requestedOf).toLowerCase();
  if (!addressedTo) return `${pathName}.threadCheck.addressedTo must show direct addressing`;
  if (['cc', 'cc-only', 'copy', 'other', 'none', 'collective'].includes(addressedTo)) {
    return `${pathName}.threadCheck.addressedTo is not a direct request`;
  }

  const messageCount = Number(entry.messageCount ?? check.messageCount);
  if (!Number.isInteger(messageCount) || messageCount <= 0) {
    return `${pathName}.threadCheck.messageCount must be a positive integer`;
  }

  const lastMessageDate = compactText(entry.lastThreadMessageDate || check.lastMessageDate);
  const checkedThrough = compactText(entry.lastVerifiedMessageDate || check.checkedThroughMessageDate);
  const lastMessageTime = parseTime(lastMessageDate);
  const checkedTime = parseTime(checkedThrough);
  if (lastMessageTime === null) return `${pathName}.threadCheck.lastMessageDate must be a parseable date`;
  if (checkedTime === null) return `${pathName}.lastVerifiedMessageDate must be a parseable date`;
  if (checkedTime < lastMessageTime) {
    return `${pathName}.lastVerifiedMessageDate is older than the last thread message`;
  }

  const temporalStatus = compactText(entry.temporalStatus || check.temporalStatus).toLowerCase();
  if (temporalStatus === 'obsolete') return `${pathName}.temporalStatus is obsolete`;
  const referencedDate = entry.referencedDate || check.referencedDate;
  const referencedDay = dateOnlyUtc(referencedDate);
  if (referencedDay !== null && referencedDay < todayUtc(now) && !quoteHasRequiredFields(entry.currentJustificationQuote || check.currentJustificationQuote)) {
    return `${pathName}.referencedDate is in the past without currentJustificationQuote`;
  }

  return null;
}

export function validateActionGateForVisibleAction(entry, options = {}) {
  if (!entry) return null;
  if (entry.resolutionStatus && entry.resolutionStatus !== 'open') return null;
  return validateActionGate(entry, options);
}
