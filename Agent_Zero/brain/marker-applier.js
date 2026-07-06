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
  'confidence'
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

function validatePmStatus(pmStatus) {
  if (pmStatus === undefined || pmStatus === null) return null;
  if (typeof pmStatus !== 'object' || Array.isArray(pmStatus)) return 'pmStatus must be an object';
  if (pmStatus.current !== undefined && typeof pmStatus.current !== 'string') return 'pmStatus.current must be a string';
  for (const field of PM_LIST_FIELDS) {
    if (pmStatus[field] === undefined) continue;
    if (!Array.isArray(pmStatus[field])) return `pmStatus.${field} must be an array`;
    for (const entry of pmStatus[field]) {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return `pmStatus.${field} entries must be objects`;
      if (typeof entry.text !== 'string' || !entry.text.trim()) return `pmStatus.${field} entries require text`;
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

function validateMarker(marker, data, sourceRefIndex) {
  const payload = marker.payload || {};

  switch (marker.type) {
    case 'PROJECT_NEW': {
      if (!payload.title || typeof payload.title !== 'string') return { ok: false, reason: 'PROJECT_NEW requires title' };
      if (!Array.isArray(payload.sourceRefs) || payload.sourceRefs.length === 0) {
        return { ok: false, reason: 'PROJECT_NEW requires sourceRefs' };
      }
      const pmError = validatePmStatus(payload.pmStatus);
      if (pmError) return { ok: false, reason: pmError };
      const supersedesError = validateSupersedes(data, payload.supersedesTaskIds);
      if (supersedesError) return { ok: false, reason: supersedesError };
      let capConfidenceResult = false;
      for (const item of normalizeArray(payload.lineItems)) {
        const evidence = validateLineItemEvidence(item, sourceRefIndex);
        if (!evidence.ok) return { ok: false, reason: evidence.reason };
        capConfidenceResult = capConfidenceResult || evidence.capConfidence;
      }
      return { ok: true, capConfidence: capConfidenceResult };
    }

    case 'PROJECT_UPDATE': {
      if (!payload.taskId || !taskById(data, payload.taskId)) return { ok: false, reason: `unknown taskId: ${payload.taskId}` };
      const pmError = validatePmStatus(payload.pmStatus);
      if (pmError) return { ok: false, reason: pmError };
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
      return { ok: true, capConfidence: false };
    }

    case 'LINEITEM_NEW': {
      if (!payload.taskId || !taskById(data, payload.taskId)) return { ok: false, reason: `unknown taskId: ${payload.taskId}` };
      if (!payload.lineItem || typeof payload.lineItem !== 'object') return { ok: false, reason: 'LINEITEM_NEW requires lineItem' };
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
      if (patchNeedsEvidence(payload.patch)) {
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
  return {
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
  };
}

function normalizePmStatus(pmStatus, now) {
  if (!pmStatus) return null;
  const ts = nowIso(now);
  const result = {
    current: pmStatus.current || '',
    confidence: pmStatus.confidence || 'low',
    lastSynthesizedAt: pmStatus.lastSynthesizedAt || ts
  };
  for (const field of PM_LIST_FIELDS) {
    result[field] = normalizeArray(pmStatus[field]).map(entry => ({ ...entry }));
  }
  return result;
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
    brainState: {
      ...V5_BRAIN_STATE_DEFAULTS,
      lastScanRunId: context.runId,
      lastEvidenceAt: latestEvidenceAt(sourceRefs)
    }
  };
  data.tasks.push(task);
  archiveSuperseded(data, task.supersedesTaskIds, projectId, context.now);
}

function applyProjectUpdate(data, payload, context) {
  const task = taskById(data, payload.taskId);
  const additions = normalizeArray(payload.sourceRefs).map(ref => normalizeSourceRef(ref, context));
  if (payload.title) task.title = payload.title;
  if (payload.summary !== undefined) task.summary = payload.summary;
  if (payload.pmStatus !== undefined) task.pmStatus = normalizePmStatus(payload.pmStatus, context.now);
  if (additions.length) {
    task.sourceRefs = mergeSourceRefs(task.sourceRefs, additions);
    task.additionalLinks = normalizeArray(task.sourceRefs).map(ref => ref.link).filter(Boolean);
    task.link = task.link || firstLink(additions);
  }
  task.supersedesTaskIds = [...new Set([...normalizeArray(task.supersedesTaskIds), ...normalizeArray(payload.supersedesTaskIds)])];
  task.updatedAt = nowIso(context.now);
  task.brainState = { ...V5_BRAIN_STATE_DEFAULTS, ...(task.brainState || {}) };
  task.brainState.lastScanRunId = context.runId;
  task.brainState.lastEvidenceAt = latestEvidenceAt(task.sourceRefs) || task.brainState.lastEvidenceAt;
  archiveSuperseded(data, payload.supersedesTaskIds, task.id, context.now);
}

function applyFactSheetUpdate(data, payload, context) {
  const task = taskById(data, payload.taskId);
  task.factSheet = applyFactSheetSectionPatches(task.factSheet, payload.sectionPatches, context);
  task.updatedAt = nowIso(context.now);
  task.brainState = { ...V5_BRAIN_STATE_DEFAULTS, ...(task.brainState || {}) };
  task.brainState.lastScanRunId = context.runId;
}

function applyLineItemNew(data, payload, context) {
  const task = taskById(data, payload.taskId);
  task.lineItems = normalizeArray(task.lineItems);
  task.lineItems.push(normalizeLineItem(payload.lineItem, context));
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
  task.updatedAt = nowIso(context.now);
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

function applyValidMarker(data, marker, context) {
  switch (marker.type) {
    case 'PROJECT_NEW': return applyProjectNew(data, marker.payload, context);
    case 'PROJECT_UPDATE': return applyProjectUpdate(data, marker.payload, context);
    case 'FACTSHEET_UPDATE': return applyFactSheetUpdate(data, marker.payload, context);
    case 'LINEITEM_NEW': return applyLineItemNew(data, marker.payload, context);
    case 'LINEITEM_UPDATE': return applyLineItemUpdate(data, marker.payload, context);
    case 'TASK_NEW': return applyTaskNew(data, marker.payload, context);
    case 'TASK_UPDATE': return applyTaskUpdate(data, marker.payload, context);
    case 'NEEDS_REVIEW': return applyNeedsReview(data, marker.payload, context);
    case 'SCAN_DONE': return applyScanDone(data, marker.payload, context);
    default: return undefined;
  }
}

export function applyMarkerBatch(inputData, markers, {
  auditLogFile = DEFAULT_AUDIT_LOG,
  now = new Date(),
  runId = null,
  idFactory = defaultIdFactory
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
    const validation = validateMarker(candidate, original, scopedSourceRefIndex);
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
  const context = { now, runId, idFactory };
  for (const marker of valid) applyValidMarker(data, marker, context);

  return {
    data,
    applied: valid.length,
    dropped,
    auditLogFile
  };
}

export const applyMarkersToTasksData = applyMarkerBatch;
