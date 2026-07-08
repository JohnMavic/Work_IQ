import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { migrateToV5, V5_BRAIN_DEFAULTS, V5_BRAIN_STATE_DEFAULTS } from './tasks-v5.js';
import {
  invalidSourceLinkReason,
  isUsableSourceLink,
  sanitizeFabricatedSourceText,
  sourceLinkVerdict
} from './link-guard.js';
import {
  applyFactSheetSectionPatches,
  normalizeFactSheet,
  validateFactSheetSectionPatches
} from './factsheet.js';
import {
  extractProcessingLedgerFromPayload,
  hasContentNotIndexedAttachmentFailure,
  itemRefKey,
  mergeProcessing,
  validateProcessingPayload
} from './processing-ledger.js';
import {
  findTemporalNodeTarget,
  PM_TEMPORAL_FIELDS,
  isStalePmTemporalNode
} from './temporal-pass.js';
import {
  isActionLikeLineItem,
  normalizeNodeFields,
  validateActionGateForVisibleAction,
  validateNodeState
} from './truth-tree.js';
import {
  isUserOwner,
  mergeUserActionCarryForward,
  normalizePmStatusUserActions
} from './user-actions.js';
import {
  DEFAULT_LEARNINGS_FILE,
  appendBrainLearning,
  validateLearningPayload
} from './learnings.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DEFAULT_AUDIT_LOG = path.join(__dirname, '..', 'logs', 'brain-audit.jsonl');

const PM_LIST_FIELDS = ['planned', 'userActions', 'problems', 'risks', 'waitingOn'];
const STATUS_PATCH_FIELDS = new Set([
  'status',
  'currentState',
  'plannedNext',
  'userActionRequired',
  'userAction',
  'problem',
  'risk',
  'waitingOn',
  'doneAt'
]);
const TASK_UPDATE_PATCH_FIELDS = new Set([
  'title',
  'summary',
  'status',
  'notes',
  'doneAt',
  'confidence'
]);
const LINEITEM_UPDATE_PATCH_FIELDS = new Set([
  'title',
  'category',
  'status',
  'owner',
  'userActionRequired',
  'userAction',
  'currentState',
  'plannedNext',
  'dueAt',
  'waitingOn',
  'problem',
  'risk',
  'confidence',
  'threadRef',
  'lastVerifiedMessageDate',
  'resolutionStatus',
  'askQuote',
  'resolvedBy',
  'referencedDate',
  'lastThreadMessageDate',
  'messageCount',
  'threadCoverage',
  'threadCheck',
  'temporalStatus',
  'currentJustificationQuote',
  'state',
  'sources',
  'lastConfirmedByMessageDate',
  'conflict',
  'supersededByMessageDate',
  'supersededReason',
  'obsoleteReason'
]);

function clone(value) {
  return structuredClone(value);
}

function defaultIdFactory(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
}

function appendAudit(auditLogFile, entry) {
  if (!auditLogFile) return;
  fs.mkdirSync(path.dirname(auditLogFile), { recursive: true });
  fs.appendFileSync(auditLogFile, `${JSON.stringify(entry)}\n`, 'utf8');
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function taskById(data, taskId) {
  return data.tasks.find(task => task.id === taskId) || null;
}

function findLineItem(data, lineItemId) {
  for (const task of data.tasks) {
    const lineItem = normalizeArray(task.lineItems).find(item => item.id === lineItemId);
    if (lineItem) return { task, lineItem };
  }
  return null;
}

function buildSourceRefIndex(data) {
  const index = new Map();
  for (const task of normalizeArray(data.tasks)) {
    for (const ref of normalizeArray(task.sourceRefs)) {
      if (ref?.id) index.set(ref.id, ref);
    }
  }
  return index;
}

function collectPayloadSourceRefs(payload) {
  const refs = [];
  if (Array.isArray(payload?.sourceRefs)) refs.push(...payload.sourceRefs);
  if (payload?.sourceRef) refs.push(payload.sourceRef);
  return refs.filter(ref => ref && typeof ref === 'object' && ref.id);
}

function allPayloadSourceRefs(payload) {
  const refs = [];
  if (Array.isArray(payload?.sourceRefs)) refs.push(...payload.sourceRefs);
  if (payload?.sourceRef !== undefined) refs.push(payload.sourceRef);
  return refs;
}

function isValidSourceLink(link) {
  return isUsableSourceLink(link);
}

function discardInvalidSourceRefLinks(payload, { auditLogFile, appliedAt, marker }) {
  for (const ref of allPayloadSourceRefs(payload)) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) continue;
    const verdict = sourceLinkVerdict(ref.link);
    if (verdict.ok && verdict.auditOnly && verdict.normalized) {
      appendAudit(auditLogFile, {
        timestamp: appliedAt,
        action: 'flag-unusual-source-link',
        type: marker.type,
        sourceRefId: ref.id || null,
        reason: 'sourceRef.link is not a known Outlook/Teams deep-link form; kept losslessly',
        link: verdict.normalized,
        line: marker.line ?? null,
        raw: marker.raw ?? null
      });
    }
    const reason = verdict.ok ? null : verdict.reason;
    if (!reason) continue;
    const discardedLink = ref.link;
    ref.link = null;
    appendAudit(auditLogFile, {
      timestamp: appliedAt,
      action: 'discard-source-link',
      type: marker.type,
      sourceRefId: ref.id || null,
      reason,
      discardedLink: String(discardedLink),
      line: marker.line ?? null,
      raw: marker.raw ?? null
    });
  }
}

function scrubFabricatedSourceText(value, { auditLogFile, appliedAt, marker, pathParts = [] } = {}) {
  if (typeof value === 'string') {
    const sanitized = sanitizeFabricatedSourceText(value);
    if (sanitized.changed) {
      appendAudit(auditLogFile, {
        timestamp: appliedAt,
        action: 'scrub-fabricated-source-token',
        type: marker.type,
        field: pathParts.join('.'),
        line: marker.line ?? null,
        raw: marker.raw ?? null
      });
      return sanitized.text;
    }
    return value;
  }

  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = scrubFabricatedSourceText(value[i], {
        auditLogFile,
        appliedAt,
        marker,
        pathParts: [...pathParts, String(i)]
      });
    }
    return value;
  }

  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'link' || key === 'url') continue;
      value[key] = scrubFabricatedSourceText(child, {
        auditLogFile,
        appliedAt,
        marker,
        pathParts: [...pathParts, key]
      });
    }
  }

  return value;
}

function addPayloadSourceRefs(index, payload) {
  for (const ref of collectPayloadSourceRefs(payload)) {
    if (!index.has(ref.id)) index.set(ref.id, ref);
  }
}

function validateIntroducedSourceRefs(payload) {
  if (payload?.sourceRefs !== undefined && !Array.isArray(payload.sourceRefs)) {
    return 'sourceRefs must be an array';
  }
  if (payload?.sourceRef !== undefined && (!payload.sourceRef || typeof payload.sourceRef !== 'object' || Array.isArray(payload.sourceRef))) {
    return 'sourceRef must be an object';
  }
  for (const ref of allPayloadSourceRefs(payload)) {
    if (!ref || typeof ref !== 'object' || Array.isArray(ref)) return 'sourceRef entries must be objects';
    if (typeof ref.id !== 'string' || !ref.id.trim()) return 'sourceRef requires id';
    const linkReason = invalidSourceLinkReason(ref.link);
    if (linkReason) return linkReason;
  }
  return null;
}

function flatSectionPatches(sectionPatches) {
  if (Array.isArray(sectionPatches)) return sectionPatches;
  if (!sectionPatches || typeof sectionPatches !== 'object' || Array.isArray(sectionPatches)) return [];
  const result = [];
  for (const [section, patches] of Object.entries(sectionPatches)) {
    for (const patch of normalizeArray(patches)) result.push({ section, ...patch });
  }
  return result;
}

function validateFactSheetActionGates(sectionPatches, { now }) {
  for (const [index, patch] of flatSectionPatches(sectionPatches).entries()) {
    if (patch.section !== 'openActions') continue;
    const op = patch.op || 'add';
    if (op === 'remove') continue;
    const error = validateActionGateForVisibleAction(patch, {
      pathName: `factSheet.openActions[${index}]`,
      now
    });
    if (error) return error;
  }
  return null;
}

function validateFactSheetInitialActionGates(factSheet, { now }) {
  const entries = normalizeArray(factSheet?.sections?.openActions || factSheet?.openActions);
  for (const [index, entry] of entries.entries()) {
    const error = validateActionGateForVisibleAction(entry, {
      pathName: `factSheet.openActions[${index}]`,
      now
    });
    if (error) return error;
  }
  return null;
}

function proofQuote(value) {
  return value
    && typeof value === 'object'
    && !Array.isArray(value)
    && typeof value.text === 'string'
    && value.text.trim()
    && typeof value.from === 'string'
    && value.from.trim()
    && typeof value.date === 'string'
    && value.date.trim();
}

function validateResolvedActions(payload, { pathName = 'resolvedActions' } = {}) {
  if (payload.resolvedActions === undefined) return null;
  if (!Array.isArray(payload.resolvedActions)) return `${pathName} must be an array`;
  for (const [index, proof] of payload.resolvedActions.entries()) {
    if (!proof || typeof proof !== 'object' || Array.isArray(proof)) return `${pathName}[${index}] must be an object`;
    if (!proof.id && !proof.text) return `${pathName}[${index}] requires id or text`;
    if (!['resolved', 'obsolete'].includes(proof.resolutionStatus)) {
      return `${pathName}[${index}].resolutionStatus must be resolved or obsolete`;
    }
    if (proof.resolutionStatus === 'resolved' && !proofQuote(proof.resolvedBy)) {
      return `${pathName}[${index}].resolvedBy requires text, from, and date`;
    }
    if (proof.resolutionStatus === 'obsolete' && !proofQuote(proof.obsoleteEvidence || proof.resolvedBy)) {
      return `${pathName}[${index}].obsoleteEvidence requires text, from, and date`;
    }
  }
  return null;
}

function validateLineItemActionGate(item, { now, pathName }) {
  const nodeError = validateNodeState(item, pathName);
  if (nodeError) return nodeError;
  if (!isActionLikeLineItem(item)) return null;
  return validateActionGateForVisibleAction(item, { pathName, now });
}

function validatePmStatus(pmStatus, { now = new Date(), pathName = 'pmStatus' } = {}) {
  if (pmStatus === undefined || pmStatus === null) return null;
  if (typeof pmStatus !== 'object' || Array.isArray(pmStatus)) return 'pmStatus must be an object';
  if (pmStatus.current !== undefined && typeof pmStatus.current !== 'string') return 'pmStatus.current must be a string';
  for (const field of PM_LIST_FIELDS) {
    if (pmStatus[field] === undefined) continue;
    if (!Array.isArray(pmStatus[field])) return `pmStatus.${field} must be an array`;
    for (const [index, entry] of pmStatus[field].entries()) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `pmStatus.${field} entries must be objects`;
      if (typeof entry.text !== 'string' || !entry.text.trim()) return `pmStatus.${field} entries require text`;
      const nodeError = validateNodeState(entry, `${pathName}.${field}[${index}]`);
      if (nodeError) return nodeError;
      if (field === 'userActions' && entry.owner !== undefined && !isUserOwner(entry.owner)) {
        return 'pmStatus.userActions entries must be owned by the app user';
      }
      if (field === 'userActions') {
        const actionError = validateActionGateForVisibleAction(entry, {
          pathName: `${pathName}.userActions[${index}]`,
          now
        });
        if (actionError) return actionError;
      }
    }
  }
  return null;
}

function validateSupersedes(data, ids) {
  for (const id of normalizeArray(ids)) {
    if (!taskById(data, id)) return `unknown supersedesTaskIds ref: ${id}`;
  }
  return null;
}

function patchNeedsEvidence(patch) {
  if (!patch || typeof patch !== 'object') return false;
  return Object.keys(patch).some(key => STATUS_PATCH_FIELDS.has(key));
}

function validatePatchWhitelist(patch, allowedFields, markerType) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return `${markerType} requires patch`;
  const disallowed = Object.keys(patch).filter(key => !allowedFields.has(key));
  if (disallowed.length) return `${markerType} patch contains disallowed field(s): ${disallowed.join(', ')}`;
  if (Object.keys(patch).length === 0) return `${markerType} patch must not be empty`;
  return null;
}

function evaluateEvidence(evidenceRefIds, sourceRefIndex) {
  const ids = normalizeArray(evidenceRefIds);
  if (ids.length === 0) return { ok: false, reason: 'missing evidenceRefIds' };

  const refs = [];
  for (const id of ids) {
    const ref = sourceRefIndex.get(id);
    if (!ref) return { ok: false, reason: `unknown evidenceRefId: ${id}` };
    refs.push(ref);
  }

  return {
    ok: true,
    capConfidence: refs.length > 0 && refs.every(ref => !isValidSourceLink(ref.link))
  };
}

function capConfidence(value) {
  return value === 'high' ? 'medium' : value;
}

function capObjectConfidence(obj) {
  if (obj && typeof obj === 'object' && obj.confidence !== undefined) {
    obj.confidence = capConfidence(obj.confidence);
  }
}

function capPmStatusConfidence(pmStatus) {
  if (!pmStatus || typeof pmStatus !== 'object') return;
  capObjectConfidence(pmStatus);
  for (const field of PM_LIST_FIELDS) {
    for (const entry of normalizeArray(pmStatus[field])) capObjectConfidence(entry);
  }
}

function capPayloadConfidence(marker) {
  const payload = marker.payload;
  capObjectConfidence(payload);
  capObjectConfidence(payload?.patch);
  capObjectConfidence(payload?.lineItem);
  capPmStatusConfidence(payload?.pmStatus);
  for (const item of normalizeArray(payload?.lineItems)) capObjectConfidence(item);
}

function validateLineItemEvidence(lineItem, sourceRefIndex) {
  const evidence = evaluateEvidence(lineItem?.evidenceRefIds, sourceRefIndex);
  if (!evidence.ok) return evidence;
  return evidence;
}

function validateMarker(marker, data, sourceRefIndex, { now = new Date() } = {}) {
  const payload = marker.payload || {};
  const processingError = validateProcessingPayload(payload, marker.type);
  if (processingError) return { ok: false, reason: processingError };

  switch (marker.type) {
    case 'PROJECT_NEW': {
      if (!payload.title || typeof payload.title !== 'string') return { ok: false, reason: 'PROJECT_NEW requires title' };
      if (!Array.isArray(payload.sourceRefs) || payload.sourceRefs.length === 0) {
        return { ok: false, reason: 'PROJECT_NEW requires sourceRefs' };
      }
      const pmError = validatePmStatus(payload.pmStatus, { now, pathName: 'PROJECT_NEW.pmStatus' });
      if (pmError) return { ok: false, reason: pmError };
      const factSheetActionError = validateFactSheetInitialActionGates(payload.factSheet, { now });
      if (factSheetActionError) return { ok: false, reason: factSheetActionError };
      const supersedesError = validateSupersedes(data, payload.supersedesTaskIds);
      if (supersedesError) return { ok: false, reason: supersedesError };
      let capConfidenceResult = false;
      for (const [index, item] of normalizeArray(payload.lineItems).entries()) {
        const actionError = validateLineItemActionGate(item, { now, pathName: `PROJECT_NEW.lineItems[${index}]` });
        if (actionError) return { ok: false, reason: actionError };
        const evidence = validateLineItemEvidence(item, sourceRefIndex);
        if (!evidence.ok) return { ok: false, reason: evidence.reason };
        capConfidenceResult = capConfidenceResult || evidence.capConfidence;
      }
      return { ok: true, capConfidence: capConfidenceResult };
    }

    case 'PROJECT_UPDATE': {
      if (!payload.taskId || !taskById(data, payload.taskId)) return { ok: false, reason: `unknown taskId: ${payload.taskId}` };
      const pmError = validatePmStatus(payload.pmStatus, { now, pathName: 'PROJECT_UPDATE.pmStatus' });
      if (pmError) return { ok: false, reason: pmError };
      const resolvedActionsError = validateResolvedActions(payload);
      if (resolvedActionsError) return { ok: false, reason: resolvedActionsError };
      const supersedesError = validateSupersedes(data, payload.supersedesTaskIds);
      if (supersedesError) return { ok: false, reason: supersedesError };
      if (payload.pmStatus || patchNeedsEvidence(payload.patch)) {
        const evidence = evaluateEvidence(payload.evidenceRefIds, sourceRefIndex);
        if (!evidence.ok) return { ok: false, reason: evidence.reason };
        return { ok: true, capConfidence: evidence.capConfidence };
      }
      return { ok: true, capConfidence: false };
    }

    case 'FACTSHEET_UPDATE': {
      if (!payload.taskId || !taskById(data, payload.taskId)) return { ok: false, reason: `unknown taskId: ${payload.taskId}` };
      const patchError = validateFactSheetSectionPatches(payload.sectionPatches, sourceRefIndex);
      if (patchError) return { ok: false, reason: patchError };
      const actionError = validateFactSheetActionGates(payload.sectionPatches, { now });
      if (actionError) return { ok: false, reason: actionError };
      return { ok: true, capConfidence: false };
    }

    case 'LINEITEM_NEW': {
      if (!payload.taskId || !taskById(data, payload.taskId)) return { ok: false, reason: `unknown taskId: ${payload.taskId}` };
      if (!payload.lineItem || typeof payload.lineItem !== 'object') return { ok: false, reason: 'LINEITEM_NEW requires lineItem' };
      const actionError = validateLineItemActionGate(payload.lineItem, { now, pathName: 'LINEITEM_NEW.lineItem' });
      if (actionError) return { ok: false, reason: actionError };
      const evidence = validateLineItemEvidence(payload.lineItem, sourceRefIndex);
      if (!evidence.ok) return { ok: false, reason: evidence.reason };
      return { ok: true, capConfidence: evidence.capConfidence };
    }

    case 'LINEITEM_UPDATE': {
      if (!payload.taskId || !taskById(data, payload.taskId)) return { ok: false, reason: `unknown taskId: ${payload.taskId}` };
      const task = taskById(data, payload.taskId);
      if (!normalizeArray(task.lineItems).some(item => item.id === payload.lineItemId)) {
        return { ok: false, reason: `unknown lineItemId: ${payload.lineItemId}` };
      }
      const patchError = validatePatchWhitelist(payload.patch, LINEITEM_UPDATE_PATCH_FIELDS, 'LINEITEM_UPDATE');
      if (patchError) return { ok: false, reason: patchError };
      const existingLine = normalizeArray(task.lineItems).find(item => item.id === payload.lineItemId);
      const nextLine = { ...existingLine, ...payload.patch };
      const actionError = validateLineItemActionGate(nextLine, { now, pathName: 'LINEITEM_UPDATE.patch' });
      if (actionError) return { ok: false, reason: actionError };
      if (patchNeedsEvidence(payload.patch)) {
        const evidence = evaluateEvidence(payload.evidenceRefIds, sourceRefIndex);
        if (!evidence.ok) return { ok: false, reason: evidence.reason };
        return { ok: true, capConfidence: evidence.capConfidence };
      }
      return { ok: true, capConfidence: false };
    }

    case 'NODE_OBSOLETE': {
      if (!payload.taskId || !taskById(data, payload.taskId)) return { ok: false, reason: `unknown taskId: ${payload.taskId}` };
      if (payload.sourceRefs !== undefined || payload.sourceRef !== undefined) {
        return { ok: false, reason: 'NODE_OBSOLETE may not introduce sourceRefs' };
      }
      if (typeof payload.nodeRef !== 'string' || !payload.nodeRef.trim()) {
        return { ok: false, reason: 'NODE_OBSOLETE requires nodeRef' };
      }
      if (typeof payload.obsoleteReason !== 'string' || !payload.obsoleteReason.trim()) {
        return { ok: false, reason: 'NODE_OBSOLETE requires obsoleteReason' };
      }
      const target = findTemporalNodeTarget(data, {
        taskId: payload.taskId,
        nodeRef: payload.nodeRef,
        now,
        requirePastDate: true
      });
      if (!target.ok) return { ok: false, reason: target.reason };
      if (payload.evidenceRefIds !== undefined && !Array.isArray(payload.evidenceRefIds)) {
        return { ok: false, reason: 'NODE_OBSOLETE evidenceRefIds must be an array' };
      }
      if (normalizeArray(payload.evidenceRefIds).length > 0) {
        const evidence = evaluateEvidence(payload.evidenceRefIds, sourceRefIndex);
        if (!evidence.ok) return { ok: false, reason: evidence.reason };
        return { ok: true, capConfidence: evidence.capConfidence };
      }
      return { ok: true, capConfidence: false };
    }

    case 'TASK_NEW': {
      if (!payload.title || typeof payload.title !== 'string') return { ok: false, reason: 'TASK_NEW requires title' };
      if (!payload.sourceRef || typeof payload.sourceRef !== 'object') return { ok: false, reason: 'TASK_NEW requires sourceRef' };
      return { ok: true, capConfidence: false };
    }

    case 'TASK_UPDATE': {
      if (!payload.taskId || !taskById(data, payload.taskId)) return { ok: false, reason: `unknown taskId: ${payload.taskId}` };
      const patchError = validatePatchWhitelist(payload.patch, TASK_UPDATE_PATCH_FIELDS, 'TASK_UPDATE');
      if (patchError) return { ok: false, reason: patchError };
      if (patchNeedsEvidence(payload.patch)) {
        const evidence = evaluateEvidence(payload.evidenceRefIds, sourceRefIndex);
        if (!evidence.ok) return { ok: false, reason: evidence.reason };
        return { ok: true, capConfidence: evidence.capConfidence };
      }
      return { ok: true, capConfidence: false };
    }

    case 'LEARNING': {
      const learningError = validateLearningPayload(payload);
      if (learningError) return { ok: false, reason: learningError };
      return { ok: true, capConfidence: false };
    }

    case 'NEEDS_REVIEW': {
      if (!['assignment', 'status', 'other'].includes(payload.kind)) return { ok: false, reason: 'NEEDS_REVIEW has invalid kind' };
      if (typeof payload.question !== 'string' || !payload.question.trim()) return { ok: false, reason: 'NEEDS_REVIEW requires question' };
      if (payload.confidence !== 'low') return { ok: false, reason: 'NEEDS_REVIEW confidence must be low' };
      if (payload.ref && !taskById(data, payload.ref) && !findLineItem(data, payload.ref)) {
        return { ok: false, reason: `unknown review ref: ${payload.ref}` };
      }
      return { ok: true, capConfidence: false };
    }

    case 'SCAN_DONE': {
      if (payload.outcome && !['success', 'partial'].includes(payload.outcome)) return { ok: false, reason: 'invalid SCAN_DONE outcome' };
      return { ok: true, capConfidence: false };
    }

    default:
      return { ok: false, reason: `unknown marker type: ${marker.type}` };
  }
}

function normalizeSourceRef(ref, { now, idFactory }) {
  const ts = nowIso(now);
  return {
    id: ref.id || idFactory('src'),
    type: ref.type || 'manual',
    title: ref.title || '',
    from: ref.from ?? null,
    date: ref.date ?? null,
    link: ref.link ?? null,
    sourceTaskId: ref.sourceTaskId ?? null,
    firstSeenAt: ref.firstSeenAt || ts,
    lastSeenAt: ref.lastSeenAt || ref.date || ts,
    evidenceText: ref.evidenceText || ''
  };
}

function normalizeLineItem(item, { now, idFactory }) {
  const ts = nowIso(now);
  return normalizeNodeFields({
    id: item.id || idFactory('li'),
    title: item.title || 'Untitled line item',
    category: item.category || 'action',
    status: item.status || 'open',
    owner: item.owner ?? null,
    userActionRequired: Boolean(item.userActionRequired),
    userAction: item.userAction ?? null,
    currentState: item.currentState || '',
    plannedNext: item.plannedNext ?? null,
    dueAt: item.dueAt ?? null,
    waitingOn: item.waitingOn ?? null,
    problem: item.problem ?? null,
    risk: item.risk ?? null,
    confidence: item.confidence || 'low',
    evidenceRefIds: normalizeArray(item.evidenceRefIds),
    sourceTaskIds: normalizeArray(item.sourceTaskIds),
    createdAt: item.createdAt || ts,
    updatedAt: item.updatedAt || ts,
    ...item
  });
}

function normalizePmStatus(pmStatus, now) {
  if (!pmStatus) return null;
  const ts = nowIso(now);
  const result = normalizePmStatusUserActions({
    current: pmStatus.current || '',
    confidence: pmStatus.confidence || 'low',
    lastSynthesizedAt: pmStatus.lastSynthesizedAt || ts
  });
  for (const field of PM_LIST_FIELDS) {
    result[field] = normalizeArray(pmStatus[field]).map(entry => normalizeNodeFields({ ...entry }, {
      defaultState: entry?.state || 'confirmed'
    }));
  }
  return normalizePmStatusUserActions(result);
}

function mergeSourceRefs(existing, additions) {
  const byId = new Map();
  for (const ref of normalizeArray(existing)) byId.set(ref.id, ref);
  for (const ref of additions) {
    if (byId.has(ref.id)) byId.set(ref.id, { ...byId.get(ref.id), ...ref });
    else byId.set(ref.id, ref);
  }
  return [...byId.values()];
}

function latestEvidenceAt(sourceRefs) {
  const times = normalizeArray(sourceRefs)
    .map(ref => Date.parse(ref.lastSeenAt || ref.date || ''))
    .filter(Number.isFinite);
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

function firstLink(sourceRefs) {
  return normalizeArray(sourceRefs).find(ref => ref.link)?.link || null;
}

function firstDate(sourceRefs) {
  return normalizeArray(sourceRefs).find(ref => ref.date)?.date || null;
}

function firstFrom(sourceRefs) {
  return normalizeArray(sourceRefs).find(ref => ref.from)?.from || null;
}

function slugify(text) {
  return String(text || 'project')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^\w\s-]/g, '')
    .trim()
    .replace(/[\s_]+/g, '-')
    .slice(0, 80) || 'project';
}

function archiveSuperseded(data, ids, projectId, now) {
  for (const id of normalizeArray(ids)) {
    const task = taskById(data, id);
    if (!task) continue;
    task.archived = true;
    task.supersededBy = projectId;
    task.updatedAt = nowIso(now);
    task.history = normalizeArray(task.history);
    task.history.push({
      timestamp: nowIso(now),
      type: 'superseded',
      text: `Superseded by project task ${projectId}`
    });
  }
}

function nodeLabel(node) {
  return node?.text || node?.title || node?.userAction || node?.currentState || node?.id || 'Project node';
}

function nodeEvidenceIds(node) {
  const ids = [];
  if (node?.evidence) ids.push(node.evidence);
  if (node?.evidenceRefId) ids.push(node.evidenceRefId);
  ids.push(...normalizeArray(node?.evidenceRefIds));
  return [...new Set(ids.filter(Boolean).map(String))];
}

function collectDisputedNodes(task) {
  const nodes = [];
  const pm = task?.pmStatus || {};
  for (const field of PM_LIST_FIELDS) {
    for (const entry of normalizeArray(pm[field])) {
      if (entry?.state === 'disputed') nodes.push({ id: entry.id || `${field}:${nodeLabel(entry)}`, node: entry });
    }
  }
  for (const item of normalizeArray(task?.lineItems)) {
    if (item?.state === 'disputed') nodes.push({ id: item.id || nodeLabel(item), node: item });
  }
  const sections = task?.factSheet?.sections || {};
  for (const [section, entries] of Object.entries(sections)) {
    for (const entry of normalizeArray(entries)) {
      if (entry?.state === 'disputed' && !entry.removedAt) {
        nodes.push({ id: entry.id || `${section}:${nodeLabel(entry)}`, node: entry });
      }
    }
  }
  return nodes;
}

function ensurePmStatus(task, now) {
  if (task.pmStatus && typeof task.pmStatus === 'object' && !Array.isArray(task.pmStatus)) return;
  task.pmStatus = normalizePmStatus({
    current: '',
    planned: [],
    userActions: [],
    problems: [],
    risks: [],
    waitingOn: [],
    confidence: 'low',
    lastSynthesizedAt: nowIso(now)
  }, now);
}

function syncConflictProblems(task, now) {
  if (!task || task.taskType !== 'project') return;
  const disputed = collectDisputedNodes(task);
  if (!disputed.length) return;
  ensurePmStatus(task, now);
  task.pmStatus.problems = normalizeArray(task.pmStatus.problems);
  const existingIds = new Set(task.pmStatus.problems.map(entry => entry.id).filter(Boolean));
  for (const { id, node } of disputed) {
    const problemId = `conflict-${String(id).replace(/[^a-zA-Z0-9_.-]/g, '-').slice(0, 80)}`;
    if (existingIds.has(problemId)) continue;
    task.pmStatus.problems.push(normalizeNodeFields({
      id: problemId,
      text: `Conflicting information: ${nodeLabel(node)}`,
      evidenceRefIds: nodeEvidenceIds(node),
      confidence: node.confidence || 'medium',
      state: 'confirmed',
      sources: normalizeArray(node.sources),
      lastConfirmedByMessageDate: node.lastConfirmedByMessageDate || null,
      conflictNodeId: id
    }, { defaultState: 'confirmed' }));
  }
}

function addAttachmentIndexRetryReviewHints(data, task, payload, { now }) {
  const ledger = extractProcessingLedgerFromPayload(payload);
  if (!ledger.some(hasContentNotIndexedAttachmentFailure)) return;

  data.reviewQueue = normalizeArray(data.reviewQueue);
  const existingQuestions = new Set(data.reviewQueue.map(item => item?.question).filter(Boolean));
  const persistedLedger = normalizeArray(task.processing?.ledger);

  for (const item of ledger) {
    if (!hasContentNotIndexedAttachmentFailure(item)) continue;
    const key = itemRefKey(item.itemRef);
    const persisted = persistedLedger.find(entry => itemRefKey(entry.itemRef) === key);
    const attempts = Number(persisted?.attachmentIndexAttempts || 1);
    if (attempts >= 3) continue;
    const thread = item.threadRef ? ` (${item.threadRef})` : '';
    const question = `attachment not indexed yet — re-probe next scan: ${key || 'unknown attachment item'}${thread}`;
    if (existingQuestions.has(question)) continue;
    existingQuestions.add(question);
    data.reviewQueue.push({
      kind: 'other',
      ref: task.id,
      question,
      confidence: 'low',
      createdAt: nowIso(now)
    });
  }
}

function actionResolutionKey(entry) {
  return String(entry?.id || entry?.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function resolutionProofFor(action, proofs) {
  const id = actionResolutionKey({ id: action?.id });
  const text = actionResolutionKey({ text: action?.text });
  return normalizeArray(proofs).find(proof => {
    const proofId = actionResolutionKey({ id: proof?.id });
    const proofText = actionResolutionKey({ text: proof?.text });
    return (id && proofId === id) || (text && proofText === text);
  }) || null;
}

function preserveUnresolvedOmittedActions(existingPmStatus, incomingPmStatus, payload, { now }) {
  const result = normalizePmStatusUserActions(incomingPmStatus);
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    return { pmStatus: result, historyEvents: [] };
  }

  const incomingKeys = new Set(normalizeArray(result.userActions).flatMap(action => {
    const keys = [];
    if (action?.id) keys.push(actionResolutionKey({ id: action.id }));
    if (action?.text) keys.push(actionResolutionKey({ text: action.text }));
    return keys;
  }));
  const historyEvents = [];
  const ts = nowIso(now);

  for (const existing of normalizeArray(normalizePmStatusUserActions(existingPmStatus)?.userActions)) {
    const keys = [actionResolutionKey({ id: existing.id }), actionResolutionKey({ text: existing.text })].filter(Boolean);
    if (keys.some(key => incomingKeys.has(key))) continue;
    if (existing.userMarkedDoneAt) continue;

    const proof = resolutionProofFor(existing, payload.resolvedActions);
    if (proof) {
      const evidence = proof.resolutionStatus === 'obsolete' ? (proof.obsoleteEvidence || proof.resolvedBy) : proof.resolvedBy;
      historyEvents.push({
        timestamp: ts,
        type: `user-action-${proof.resolutionStatus}`,
        text: `User action ${proof.resolutionStatus}: ${existing.text}`,
        userAction: existing,
        resolution: proof,
        evidenceQuote: evidence
      });
      continue;
    }

    result.userActions.push({
      ...existing,
      needsReview: true,
      reviewReason: 'Batch 7 kept this action because the scan omitted it without resolvedBy or obsolete evidence.'
    });
  }

  return { pmStatus: result, historyEvents };
}

function pmTemporalKey(entry) {
  return String(entry?.id || entry?.text || '').replace(/\s+/g, ' ').trim().toLowerCase();
}

function preserveOmittedStaleTemporalNodes(existingPmStatus, incomingPmStatus, { now }) {
  const result = normalizePmStatusUserActions(incomingPmStatus);
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;

  const existing = normalizePmStatusUserActions(existingPmStatus) || {};
  for (const field of PM_TEMPORAL_FIELDS) {
    const incoming = normalizeArray(result[field]);
    const incomingKeys = new Set(incoming.map(pmTemporalKey).filter(Boolean));
    const additions = [];
    for (const entry of normalizeArray(existing[field])) {
      const key = pmTemporalKey(entry);
      if (!key || incomingKeys.has(key)) continue;
      if (!isStalePmTemporalNode(entry, { now })) continue;
      additions.push({
        ...entry,
        needsReview: true,
        reviewReason: 'Batch 9 kept this stale date because the update omitted it without obsolete, superseded, or fresh-confirmed evidence.'
      });
    }
    if (additions.length) result[field] = [...incoming, ...additions];
  }

  return result;
}

function applyProjectNew(data, payload, context) {
  const ts = nowIso(context.now);
  const sourceRefs = normalizeArray(payload.sourceRefs).map(ref => normalizeSourceRef(ref, context));
  const projectId = payload.taskId || context.idFactory('task');
  const task = {
    id: projectId,
    schemaVersion: 5,
    taskType: 'project',
    projectKey: payload.projectKey || slugify(payload.title),
    projectAliases: normalizeArray(payload.aliases),
    title: payload.title,
    summary: payload.summary || '',
    source: 'brain',
    from: firstFrom(sourceRefs),
    date: firstDate(sourceRefs),
    link: firstLink(sourceRefs),
    status: payload.status || 'new',
    notes: '',
    history: [{
      timestamp: ts,
      type: 'brain-project-new',
      text: 'Created by Agency Brain marker batch'
    }],
    doneAt: null,
    enrichmentStatus: 'enriched',
    updateCheckStatus: 'pending',
    enrichedAt: ts,
    lastUpdateCheck: null,
    lastSuccessfulUpdateCheck: null,
    createdAt: ts,
    updatedAt: ts,
    additionalLinks: sourceRefs.map(ref => ref.link).filter(Boolean),
    ambiguities: [],
    noMergeWith: [],
    activeJob: null,
    jobHistory: [],
    archived: false,
    supersededBy: null,
    supersedesTaskIds: normalizeArray(payload.supersedesTaskIds),
    pmStatus: normalizePmStatus(payload.pmStatus, context.now),
    factSheet: normalizeFactSheet(payload.factSheet, { now: context.now }),
    sourceRefs,
    lineItems: normalizeArray(payload.lineItems).map(item => normalizeLineItem(item, context)),
    processing: mergeProcessing(null, payload, { now: context.now }),
    brainState: {
      ...V5_BRAIN_STATE_DEFAULTS,
      lastScanRunId: context.runId,
      lastEvidenceAt: latestEvidenceAt(sourceRefs)
    }
  };
  syncConflictProblems(task, context.now);
  data.tasks.push(task);
  addAttachmentIndexRetryReviewHints(data, task, payload, context);
  archiveSuperseded(data, task.supersedesTaskIds, projectId, context.now);
}

function applyProjectUpdate(data, payload, context) {
  const task = taskById(data, payload.taskId);
  const additions = normalizeArray(payload.sourceRefs).map(ref => normalizeSourceRef(ref, context));
  if (payload.title) task.title = payload.title;
  if (payload.summary !== undefined) task.summary = payload.summary;
  if (payload.pmStatus !== undefined) {
    const normalizedIncoming = normalizePmStatus(payload.pmStatus, context.now);
    const merged = mergeUserActionCarryForward(task.pmStatus, normalizedIncoming, {
      now: context.now,
      evidenceRefIds: payload.evidenceRefIds,
      rawIncomingPmStatus: payload.pmStatus
    });
    const temporalPmStatus = preserveOmittedStaleTemporalNodes(task.pmStatus, merged.pmStatus, { now: context.now });
    const preserved = preserveUnresolvedOmittedActions(task.pmStatus, temporalPmStatus, payload, { now: context.now });
    task.pmStatus = preserved.pmStatus;
    const historyEvents = [...merged.historyEvents, ...preserved.historyEvents];
    if (historyEvents.length) {
      task.history = normalizeArray(task.history);
      task.history.push(...historyEvents);
    }
  }
  if (additions.length) {
    task.sourceRefs = mergeSourceRefs(task.sourceRefs, additions);
    task.additionalLinks = normalizeArray(task.sourceRefs).map(ref => ref.link).filter(Boolean);
    task.link = task.link || firstLink(additions);
  }
  task.supersedesTaskIds = [...new Set([...normalizeArray(task.supersedesTaskIds), ...normalizeArray(payload.supersedesTaskIds)])];
  task.processing = mergeProcessing(task.processing, payload, { now: context.now });
  addAttachmentIndexRetryReviewHints(data, task, payload, context);
  task.updatedAt = nowIso(context.now);
  task.brainState = { ...V5_BRAIN_STATE_DEFAULTS, ...(task.brainState || {}) };
  task.brainState.lastScanRunId = context.runId;
  task.brainState.lastEvidenceAt = latestEvidenceAt(task.sourceRefs) || task.brainState.lastEvidenceAt;
  syncConflictProblems(task, context.now);
  archiveSuperseded(data, payload.supersedesTaskIds, task.id, context.now);
}

function applyFactSheetUpdate(data, payload, context) {
  const task = taskById(data, payload.taskId);
  task.factSheet = applyFactSheetSectionPatches(task.factSheet, payload.sectionPatches, context);
  task.processing = mergeProcessing(task.processing, payload, { now: context.now });
  addAttachmentIndexRetryReviewHints(data, task, payload, context);
  task.updatedAt = nowIso(context.now);
  task.brainState = { ...V5_BRAIN_STATE_DEFAULTS, ...(task.brainState || {}) };
  task.brainState.lastScanRunId = context.runId;
  syncConflictProblems(task, context.now);
}

function applyLineItemNew(data, payload, context) {
  const task = taskById(data, payload.taskId);
  task.lineItems = normalizeArray(task.lineItems);
  task.lineItems.push(normalizeLineItem(payload.lineItem, context));
  task.processing = mergeProcessing(task.processing, payload, { now: context.now });
  addAttachmentIndexRetryReviewHints(data, task, payload, context);
  syncConflictProblems(task, context.now);
  task.updatedAt = nowIso(context.now);
}

function applyLineItemUpdate(data, payload, context) {
  const task = taskById(data, payload.taskId);
  const lineItem = normalizeArray(task.lineItems).find(item => item.id === payload.lineItemId);
  for (const field of LINEITEM_UPDATE_PATCH_FIELDS) {
    if (Object.hasOwn(payload.patch, field)) lineItem[field] = payload.patch[field];
  }
  lineItem.updatedAt = nowIso(context.now);
  if (Array.isArray(payload.evidenceRefIds)) {
    lineItem.evidenceRefIds = [...new Set([...normalizeArray(lineItem.evidenceRefIds), ...payload.evidenceRefIds])];
  }
  task.processing = mergeProcessing(task.processing, payload, { now: context.now });
  addAttachmentIndexRetryReviewHints(data, task, payload, context);
  syncConflictProblems(task, context.now);
  task.updatedAt = nowIso(context.now);
}

function applyNodeObsolete(data, payload, context) {
  const found = findTemporalNodeTarget(data, {
    taskId: payload.taskId,
    nodeRef: payload.nodeRef,
    now: context.now,
    requirePastDate: true
  });
  if (!found.ok) return;
  const { task, target } = found;
  const node = target.node;
  const ts = nowIso(context.now);

  node.state = 'obsolete';
  node.obsoleteReason = String(payload.obsoleteReason || '').trim();
  node.updatedAt = ts;
  if (target.kind === 'lineItem') {
    node.resolutionStatus = 'obsolete';
  }
  if (Array.isArray(payload.evidenceRefIds) && payload.evidenceRefIds.length) {
    node.evidenceRefIds = [...new Set([...normalizeArray(node.evidenceRefIds), ...payload.evidenceRefIds])];
  }
  if (payload.evidence !== undefined) {
    node.obsoleteEvidence = payload.evidence;
  }
  delete node.needsReview;
  delete node.reviewReason;

  task.history = normalizeArray(task.history);
  task.history.push({
    timestamp: ts,
    type: 'node-obsolete',
    text: `Marked obsolete: ${nodeLabel(node)}`,
    nodeRef: payload.nodeRef,
    obsoleteReason: node.obsoleteReason
  });
  task.updatedAt = ts;
  task.brainState = { ...V5_BRAIN_STATE_DEFAULTS, ...(task.brainState || {}) };
  task.brainState.lastScanRunId = context.runId;
  syncConflictProblems(task, context.now);
}

function applyTaskNew(data, payload, context) {
  const ts = nowIso(context.now);
  const sourceRef = normalizeSourceRef(payload.sourceRef, context);
  data.tasks.push({
    id: payload.taskId || context.idFactory('task'),
    schemaVersion: 5,
    taskType: 'single',
    title: payload.title,
    summary: payload.summary || '',
    source: sourceRef.type || 'brain',
    from: sourceRef.from,
    date: sourceRef.date,
    link: sourceRef.link,
    status: payload.status || 'new',
    notes: '',
    history: [{
      timestamp: ts,
      type: 'brain-task-new',
      text: 'Created by Agency Brain marker batch'
    }],
    doneAt: null,
    createdAt: ts,
    updatedAt: ts,
    archived: false,
    supersededBy: null,
    supersedesTaskIds: [],
    pmStatus: null,
    factSheet: normalizeFactSheet(payload.factSheet, { now: context.now }),
    sourceRefs: [sourceRef],
    lineItems: [],
    brainState: {
      ...V5_BRAIN_STATE_DEFAULTS,
      lastScanRunId: context.runId,
      lastEvidenceAt: latestEvidenceAt([sourceRef])
    }
  });
}

function applyTaskUpdate(data, payload, context) {
  const task = taskById(data, payload.taskId);
  for (const field of TASK_UPDATE_PATCH_FIELDS) {
    if (Object.hasOwn(payload.patch, field)) task[field] = payload.patch[field];
  }
  const additions = collectPayloadSourceRefs(payload).map(ref => normalizeSourceRef(ref, context));
  if (additions.length) {
    task.sourceRefs = mergeSourceRefs(task.sourceRefs, additions);
    task.additionalLinks = normalizeArray(task.sourceRefs).map(ref => ref.link).filter(Boolean);
    task.link = task.link || firstLink(additions);
  }
  task.updatedAt = nowIso(context.now);
  task.brainState = { ...V5_BRAIN_STATE_DEFAULTS, ...(task.brainState || {}) };
  task.brainState.lastScanRunId = context.runId;
  task.brainState.lastEvidenceAt = latestEvidenceAt(task.sourceRefs) || task.brainState.lastEvidenceAt;
}

function applyNeedsReview(data, payload, context) {
  const entry = {
    kind: payload.kind,
    ref: payload.ref || null,
    question: payload.question,
    confidence: 'low',
    createdAt: nowIso(context.now)
  };

  if (!payload.ref) {
    data.reviewQueue = normalizeArray(data.reviewQueue);
    data.reviewQueue.push(entry);
    return;
  }

  const task = taskById(data, payload.ref);
  if (task) {
    task.brainState = { ...V5_BRAIN_STATE_DEFAULTS, ...(task.brainState || {}) };
    task.brainState.needsReview = true;
    task.brainState.reviewReason = payload.question;
    task.updatedAt = nowIso(context.now);
    return;
  }

  const found = findLineItem(data, payload.ref);
  if (found) {
    found.lineItem.needsReview = true;
    found.lineItem.reviewReason = payload.question;
    found.task.brainState = { ...V5_BRAIN_STATE_DEFAULTS, ...(found.task.brainState || {}) };
    found.task.brainState.needsReview = true;
    found.task.brainState.reviewReason = payload.question;
    found.task.updatedAt = nowIso(context.now);
  }
}

function applyScanDone(data, payload, context) {
  data.brain = {
    ...V5_BRAIN_DEFAULTS,
    ...(data.brain || {}),
    lastRunId: payload.runId || context.runId,
    lastRunAt: nowIso(context.now),
    lastOutcome: payload.outcome || 'partial',
    lastPremiumRequests: payload.premiumRequests ?? data.brain?.lastPremiumRequests ?? null,
    lastWorkIqCalls: payload.workIqCalls ?? data.brain?.lastWorkIqCalls ?? null
  };
}

function applyLearning(_data, payload, context) {
  appendBrainLearning(payload, {
    filePath: context.learningFile,
    now: context.now
  });
}

function applyValidMarker(data, marker, context) {
  switch (marker.type) {
    case 'PROJECT_NEW': return applyProjectNew(data, marker.payload, context);
    case 'PROJECT_UPDATE': return applyProjectUpdate(data, marker.payload, context);
    case 'FACTSHEET_UPDATE': return applyFactSheetUpdate(data, marker.payload, context);
    case 'LINEITEM_NEW': return applyLineItemNew(data, marker.payload, context);
    case 'LINEITEM_UPDATE': return applyLineItemUpdate(data, marker.payload, context);
    case 'NODE_OBSOLETE': return applyNodeObsolete(data, marker.payload, context);
    case 'TASK_NEW': return applyTaskNew(data, marker.payload, context);
    case 'TASK_UPDATE': return applyTaskUpdate(data, marker.payload, context);
    case 'LEARNING': return applyLearning(data, marker.payload, context);
    case 'NEEDS_REVIEW': return applyNeedsReview(data, marker.payload, context);
    case 'SCAN_DONE': return applyScanDone(data, marker.payload, context);
    default: return undefined;
  }
}

export function applyMarkerBatch(inputData, markers, {
  auditLogFile = DEFAULT_AUDIT_LOG,
  now = new Date(),
  runId = null,
  idFactory = defaultIdFactory,
  learningFile = DEFAULT_LEARNINGS_FILE
} = {}) {
  const original = migrateToV5(inputData);
  const sourceRefIndex = buildSourceRefIndex(original);

  const valid = [];
  const dropped = [];
  const appliedAt = nowIso(now);

  for (const marker of markers) {
    const candidate = clone(marker);
    discardInvalidSourceRefLinks(candidate.payload, { auditLogFile, appliedAt, marker });
    scrubFabricatedSourceText(candidate.payload, { auditLogFile, appliedAt, marker, pathParts: ['payload'] });
    const introducedSourceRefsError = validateIntroducedSourceRefs(candidate.payload);
    if (introducedSourceRefsError) {
      const drop = {
        timestamp: appliedAt,
        action: 'drop',
        type: marker.type,
        reason: introducedSourceRefsError,
        line: marker.line ?? null,
        raw: marker.raw ?? null
      };
      dropped.push(drop);
      appendAudit(auditLogFile, drop);
      continue;
    }
    const scopedSourceRefIndex = new Map(sourceRefIndex);
    addPayloadSourceRefs(scopedSourceRefIndex, candidate.payload);
    const validation = validateMarker(candidate, original, scopedSourceRefIndex, { now });
    if (!validation.ok) {
      const drop = {
        timestamp: appliedAt,
        action: 'drop',
        type: marker.type,
        reason: validation.reason,
        line: marker.line ?? null,
        raw: marker.raw ?? null
      };
      dropped.push(drop);
      appendAudit(auditLogFile, drop);
      continue;
    }
    if (validation.capConfidence) capPayloadConfidence(candidate);
    valid.push(candidate);
    addPayloadSourceRefs(sourceRefIndex, candidate.payload);
  }

  const data = clone(original);
  const context = { now, runId, idFactory, learningFile };
  for (const marker of valid) applyValidMarker(data, marker, context);

  return {
    data,
    applied: valid.length,
    dropped,
    auditLogFile
  };
}

export const applyMarkersToTasksData = applyMarkerBatch;
