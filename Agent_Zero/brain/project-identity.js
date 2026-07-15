import { createHash } from 'node:crypto';

const NEW_MARKER_TYPES = new Set(['PROJECT_NEW', 'TASK_NEW']);
const TEXT_FIELDS = [
  'title',
  'subject',
  'summary',
  'description',
  'currentState',
  'userAction',
  'evidenceText',
  'notes',
  'body'
];
const SOURCE_FINGERPRINT_FIELDS = [
  'fingerprint',
  'sourceFingerprint',
  'immutableFingerprint'
];
const ITEM_ID_FIELDS = [
  'immutableId',
  'itemId',
  'messageId',
  'internetMessageId',
  'internetMessageID'
];
const CONVERSATION_FIELDS = [
  'threadRef',
  'conversationId',
  'conversationID',
  'conversationRef',
  'chatId',
  'channelMessageId'
];
const TERMINAL_STATUSES = new Set(['done', 'completed', 'closed', 'cancelled', 'canceled']);

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function compactIdentity(value) {
  return typeof value === 'string'
    ? value.normalize('NFKC').replace(/\s+/g, ' ').trim().toLocaleLowerCase('en-US')
    : '';
}

function compactFingerprint(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).normalize('NFKC').trim();
}

function latestEvidenceAt(sourceRefs) {
  const times = normalizeArray(sourceRefs)
    .map(ref => Date.parse(ref?.lastSeenAt || ref?.date || ''))
    .filter(Number.isFinite);
  if (!times.length) return null;
  return new Date(Math.max(...times)).toISOString();
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort()
      .map(key => [key, stableValue(value[key])])
  );
}

function sha256(value) {
  return createHash('sha256').update(JSON.stringify(stableValue(value))).digest('hex');
}

function asContentHash(value) {
  return `sha256:${sha256(value)}`;
}

function hashSuffix(contentHash, length = 24) {
  const hash = compactFingerprint(contentHash).replace(/^sha256:/i, '');
  return hash.slice(0, length) || sha256(contentHash).slice(0, length);
}

function addMapValue(map, key, project) {
  if (!key) return;
  if (!map.has(key)) map.set(key, new Map());
  map.get(key).set(project.id, project);
}

function activeProjects(data) {
  return normalizeArray(data?.tasks).filter(task => {
    return task?.taskType === 'project'
      && task.archived !== true
      && !compactFingerprint(task.supersededBy)
      && !TERMINAL_STATUSES.has(compactIdentity(task.status));
  });
}

function projectIdentityEntries(project) {
  const entries = [];
  const add = (kind, value) => {
    const normalized = compactIdentity(value);
    if (normalized) entries.push({ kind, value: normalized });
  };

  add('projectKey', project?.projectKey);
  for (const alias of [
    ...normalizeArray(project?.projectAliases),
    ...normalizeArray(project?.aliases)
  ]) add('alias', alias);
  add('title', project?.title);
  return entries;
}

function candidateIdentityEntries(marker) {
  const payload = marker?.payload || {};
  const entries = [];
  const add = (kind, value) => {
    const normalized = compactIdentity(value);
    if (normalized) entries.push({ kind, value: normalized });
  };

  add('projectKey', payload.projectKey);
  add('projectKey', payload.projectIdKey);
  add('projectTitle', payload.projectTitle);
  add('projectAlias', payload.projectAlias);
  for (const value of [
    ...normalizeArray(payload.aliases),
    ...normalizeArray(payload.projectAliases),
    ...normalizeArray(payload.projectKeys)
  ]) add('alias', value);
  add('title', payload.title);
  return entries;
}

function strongOpaqueId(value) {
  const normalized = compactFingerprint(value);
  return normalized.length >= 8 || /[-:@/\\]/.test(normalized);
}

function addFingerprint(set, prefix, value) {
  const normalized = compactFingerprint(value);
  if (normalized) set.add(`${prefix}:${normalized}`);
}

function addItemRefFingerprints(set, itemRef) {
  if (typeof itemRef === 'string') {
    addFingerprint(set, 'item-ref', itemRef);
    return;
  }
  if (!isObject(itemRef)) return;

  const type = compactFingerprint(itemRef.type || 'm365').toLocaleLowerCase('en-US');
  const id = compactFingerprint(itemRef.id || itemRef.itemId || itemRef.messageId || itemRef.url);
  if (id) {
    addFingerprint(set, `item-${type}`, id);
    if (strongOpaqueId(id)) addFingerprint(set, 'item-id', id);
  }
  addFingerprint(set, 'url', itemRef.url);
  for (const field of CONVERSATION_FIELDS) addFingerprint(set, 'thread', itemRef[field]);
}

function addSourceFingerprints(set, sourceRef) {
  if (!isObject(sourceRef)) return;
  const type = compactFingerprint(sourceRef.type || 'manual').toLocaleLowerCase('en-US');

  for (const field of SOURCE_FINGERPRINT_FIELDS) addFingerprint(set, 'source-fingerprint', sourceRef[field]);
  addFingerprint(set, 'content-hash', sourceRef.contentHash);
  addFingerprint(set, 'source-id', sourceRef.id);
  if (sourceRef.id) {
    addFingerprint(set, `item-${type}`, sourceRef.id);
    if (strongOpaqueId(sourceRef.id)) addFingerprint(set, 'item-id', sourceRef.id);
  }
  for (const field of ITEM_ID_FIELDS) {
    addFingerprint(set, `item-${type}`, sourceRef[field]);
    if (strongOpaqueId(sourceRef[field])) addFingerprint(set, 'item-id', sourceRef[field]);
  }
  for (const field of CONVERSATION_FIELDS) addFingerprint(set, 'thread', sourceRef[field]);
  addFingerprint(set, 'url', sourceRef.link || sourceRef.url);
  addItemRefFingerprints(set, sourceRef.itemRef);
}

function processingLedgers(payload) {
  return [
    ...normalizeArray(payload?.processing?.ledger),
    ...normalizeArray(payload?.processingLedger)
  ];
}

function processingEnumeratedItems(payload) {
  return [
    ...normalizeArray(payload?.processing?.enumeratedItems),
    ...normalizeArray(payload?.processingEnumeratedItems),
    ...normalizeArray(payload?.processingQuality?.enumeratedItems)
  ];
}

function collectFingerprints(value) {
  const set = new Set();
  if (!isObject(value)) return set;

  for (const sourceRef of [
    ...(isObject(value.sourceRef) ? [value.sourceRef] : []),
    ...normalizeArray(value.sourceRefs)
  ]) addSourceFingerprints(set, sourceRef);

  addSourceFingerprints(set, value.sourceRef);
  addItemRefFingerprints(set, value.itemRef);
  for (const field of CONVERSATION_FIELDS) addFingerprint(set, 'thread', value[field]);
  addFingerprint(set, 'content-hash', value.contentHash);

  for (const item of processingLedgers(value)) {
    addItemRefFingerprints(set, item?.itemRef);
    for (const field of CONVERSATION_FIELDS) addFingerprint(set, 'thread', item?.[field]);
  }
  for (const item of processingEnumeratedItems(value)) {
    addItemRefFingerprints(set, item?.itemRef || item);
    for (const field of CONVERSATION_FIELDS) addFingerprint(set, 'thread', item?.[field]);
  }
  for (const threadRef of Object.keys(isObject(value.processing?.threads) ? value.processing.threads : {})) {
    addFingerprint(set, 'thread', threadRef);
  }

  for (const lineItem of [
    ...(isObject(value.lineItem) ? [value.lineItem] : []),
    ...normalizeArray(value.lineItems)
  ]) {
    for (const field of CONVERSATION_FIELDS) addFingerprint(set, 'thread', lineItem?.[field]);
    addFingerprint(set, 'content-hash', lineItem?.contentHash);
    for (const sourceRef of [
      ...(isObject(lineItem?.sourceRef) ? [lineItem.sourceRef] : []),
      ...normalizeArray(lineItem?.sourceRefs)
    ]) addSourceFingerprints(set, sourceRef);
  }

  return set;
}

function projectFingerprints(project) {
  const set = collectFingerprints(project);
  for (const sourceRef of normalizeArray(project?.sourceRefs)) addSourceFingerprints(set, sourceRef);
  for (const lineItem of normalizeArray(project?.lineItems)) {
    for (const field of CONVERSATION_FIELDS) addFingerprint(set, 'thread', lineItem?.[field]);
    addFingerprint(set, 'content-hash', lineItem?.contentHash);
  }
  return set;
}

function collectCandidateTexts(payload) {
  const texts = [];
  const collect = value => {
    if (!isObject(value)) return;
    for (const field of TEXT_FIELDS) {
      if (typeof value[field] === 'string' && value[field].trim()) texts.push(compactIdentity(value[field]));
    }
  };

  collect(payload);
  collect(payload?.sourceRef);
  for (const ref of normalizeArray(payload?.sourceRefs)) collect(ref);
  collect(payload?.lineItem);
  for (const item of normalizeArray(payload?.lineItems)) collect(item);
  return texts.filter(Boolean);
}

function isWordCharacter(value) {
  return Boolean(value) && /[\p{L}\p{N}_]/u.test(value);
}

function containsStrongIdentifier(text, identifier) {
  if (!text || !identifier) return false;
  if (text === identifier) return true;
  if ((identifier.match(/[\p{L}\p{N}]/gu) || []).length < 3) return false;

  let offset = 0;
  while (offset <= text.length - identifier.length) {
    const index = text.indexOf(identifier, offset);
    if (index < 0) return false;
    const before = index > 0 ? text[index - 1] : '';
    const afterIndex = index + identifier.length;
    const after = afterIndex < text.length ? text[afterIndex] : '';
    if (!isWordCharacter(before) && !isWordCharacter(after)) return true;
    offset = index + 1;
  }
  return false;
}

function sourceContentHash(sourceRef) {
  if (compactFingerprint(sourceRef?.contentHash)) return sourceRef.contentHash;
  const semantic = clone(sourceRef || {});
  delete semantic.contentHash;
  delete semantic.firstSeenAt;
  delete semantic.lastSeenAt;
  delete semantic.processedAt;
  return asContentHash({ kind: 'source-ref', source: semantic });
}

function enhanceSourceRef(sourceRef) {
  const enhanced = clone(sourceRef || {});
  enhanced.contentHash = sourceContentHash(enhanced);
  if (!compactFingerprint(enhanced.id)) enhanced.id = `src-${hashSuffix(enhanced.contentHash)}`;
  return enhanced;
}

function enhancedPayloadSources(payload) {
  const singular = isObject(payload?.sourceRef) ? enhanceSourceRef(payload.sourceRef) : null;
  const plural = normalizeArray(payload?.sourceRefs).map(enhanceSourceRef);
  return {
    singular,
    plural,
    all: [...(singular ? [singular] : []), ...plural]
  };
}

function normalizedLineStatus(value) {
  if (!value || value === 'new' || value === 'needs-attention') return 'open';
  return value;
}

function sourceFingerprintsForHash(sourceRefs) {
  const result = new Set();
  for (const sourceRef of sourceRefs) {
    const fingerprints = new Set();
    addSourceFingerprints(fingerprints, sourceRef);
    for (const fingerprint of fingerprints) result.add(fingerprint);
  }
  return [...result].sort();
}

function lineItemSemantic(lineItem, sourceRefs) {
  return {
    title: compactFingerprint(lineItem?.title),
    summary: compactFingerprint(lineItem?.summary),
    category: compactFingerprint(lineItem?.category || 'action'),
    status: compactFingerprint(normalizedLineStatus(lineItem?.status)),
    owner: lineItem?.owner ?? null,
    userActionRequired: Boolean(lineItem?.userActionRequired),
    userAction: lineItem?.userAction ?? null,
    currentState: lineItem?.currentState ?? lineItem?.summary ?? '',
    plannedNext: lineItem?.plannedNext ?? null,
    dueAt: lineItem?.dueAt ?? null,
    waitingOn: lineItem?.waitingOn ?? null,
    problem: lineItem?.problem ?? null,
    risk: lineItem?.risk ?? null,
    threadRef: lineItem?.threadRef ?? null,
    sourceFingerprints: sourceFingerprintsForHash(sourceRefs)
  };
}

function lineItemContentHash(lineItem, sourceRefs) {
  return compactFingerprint(lineItem?.contentHash)
    || asContentHash({ kind: 'project-line-item', lineItem: lineItemSemantic(lineItem, sourceRefs) });
}

function enhanceLineItem(lineItem, projectId, sourceRefs, { fallbackEvidence = false } = {}) {
  const enhanced = clone(lineItem || {});
  enhanced.title = enhanced.title || 'Untitled line item';
  enhanced.category = enhanced.category || 'action';
  enhanced.status = normalizedLineStatus(enhanced.status);
  if (enhanced.currentState === undefined && enhanced.summary !== undefined) enhanced.currentState = enhanced.summary;

  const sourceIds = sourceRefs.map(ref => ref.id).filter(Boolean);
  const evidence = normalizeArray(enhanced.evidenceRefIds).filter(Boolean);
  if (fallbackEvidence && evidence.length === 0) evidence.push(...sourceIds);
  enhanced.evidenceRefIds = [...new Set(evidence.map(String))];
  enhanced.contentHash = lineItemContentHash(enhanced, sourceRefs);
  if (!compactFingerprint(enhanced.id)) {
    enhanced.id = `li-${sha256({ projectId, contentHash: enhanced.contentHash }).slice(0, 24)}`;
  }
  return enhanced;
}

function sourceRefsForExistingLine(project, lineItem) {
  const evidenceIds = new Set(normalizeArray(lineItem?.evidenceRefIds).map(String));
  if (evidenceIds.size === 0) return normalizeArray(project?.sourceRefs);
  return normalizeArray(project?.sourceRefs).filter(ref => evidenceIds.has(String(ref?.id)));
}

function findPersistedLineReplay(project, lineItem) {
  const incomingHash = compactFingerprint(lineItem?.contentHash);
  return normalizeArray(project?.lineItems).find(existing => {
    if (compactFingerprint(existing?.id) && compactFingerprint(existing.id) === compactFingerprint(lineItem?.id)) return true;
    if (incomingHash && compactFingerprint(existing?.contentHash) === incomingHash) return true;
    const existingHash = lineItemContentHash(existing, sourceRefsForExistingLine(project, existing));
    return Boolean(incomingHash && existingHash === incomingHash);
  }) || null;
}

function persistedLineReplay(project, lineItem) {
  return Boolean(findPersistedLineReplay(project, lineItem));
}

function inferredThreadRef(payload, sourceRefs) {
  for (const field of CONVERSATION_FIELDS) {
    if (compactFingerprint(payload?.[field])) return payload[field];
  }
  for (const sourceRef of sourceRefs) {
    for (const field of CONVERSATION_FIELDS) {
      if (compactFingerprint(sourceRef?.[field])) return sourceRef[field];
    }
  }
  return processingLedgers(payload).find(item => compactFingerprint(item?.threadRef))?.threadRef || null;
}

function taskPayloadToLineItem(payload, projectId, sourceRefs) {
  const lineItem = clone(payload || {});
  const sourceTaskId = compactFingerprint(payload?.taskId);

  for (const field of [
    'taskId', 'projectKey', 'projectIdKey', 'projectTitle', 'projectAlias', 'projectAliases',
    'projectKeys', 'aliases', 'sourceRef', 'sourceRefs', 'processing', 'processingLedger',
    'processingEnumeratedItems', 'processingQuality', 'supersedesTaskIds', 'lineItem', 'lineItems'
  ]) delete lineItem[field];

  lineItem.status = normalizedLineStatus(lineItem.status);
  lineItem.category = lineItem.category || 'action';
  if (lineItem.currentState === undefined) lineItem.currentState = lineItem.summary || '';
  if (!lineItem.threadRef) lineItem.threadRef = inferredThreadRef(payload, sourceRefs);
  lineItem.sourceTaskIds = [...new Set([
    ...normalizeArray(lineItem.sourceTaskIds).map(String),
    ...(sourceTaskId ? [sourceTaskId] : [])
  ])];
  lineItem.evidenceRefIds = [...new Set([
    ...normalizeArray(lineItem.evidenceRefIds).map(String),
    ...sourceRefs.map(ref => ref.id).filter(Boolean).map(String)
  ])];
  if (!lineItem.relevance && lineItem.state === undefined) {
    lineItem.state = 'unconfirmed';
    lineItem.needsReview = true;
    lineItem.reviewReason = 'Exact project identity was resolved automatically, but semantic relevance still needs project-wide assessment.';
  }
  return enhanceLineItem(lineItem, projectId, sourceRefs, { fallbackEvidence: true });
}

function markerWith(marker, type, payload) {
  return { ...clone(marker), type, payload };
}

function transformTaskNew(marker, project) {
  const payload = clone(marker.payload || {});
  const sources = enhancedPayloadSources(payload);
  const lineItem = taskPayloadToLineItem(payload, project.id, sources.all);
  const transformedPayload = {
    ...payload,
    taskId: project.id,
    lineItem
  };
  if (sources.singular) transformedPayload.sourceRef = sources.singular;
  if (Array.isArray(payload.sourceRefs)) transformedPayload.sourceRefs = sources.plural;
  return markerWith(marker, 'LINEITEM_NEW', transformedPayload);
}

function transformProjectNew(marker, project) {
  const payload = clone(marker.payload || {});
  const sources = enhancedPayloadSources(payload);
  const sourceRefs = sources.plural.length ? sources.plural : sources.all;
  const updatePayload = {
    ...payload,
    taskId: project.id,
    sourceRefs,
    projectAliases: [...new Set([
      ...normalizeArray(project.projectAliases),
      project.title,
      payload.projectKey,
      payload.title,
      ...normalizeArray(payload.aliases),
      ...normalizeArray(payload.projectAliases)
    ].map(value => compactFingerprint(value)).filter(Boolean))]
  };
  delete updatePayload.projectKey;
  delete updatePayload.aliases;
  delete updatePayload.lineItems;

  if (payload.pmStatus || normalizeArray(payload.evidenceRefIds).length > 0) {
    updatePayload.evidenceRefIds = [...new Set([
      ...normalizeArray(payload.evidenceRefIds).map(String),
      ...sourceRefs.map(ref => ref.id).filter(Boolean).map(String)
    ])];
  }

  const update = markerWith(marker, 'PROJECT_UPDATE', updatePayload);
  const lineItems = [];
  for (const rawLineItem of normalizeArray(payload.lineItems)) {
    const lineItem = enhanceLineItem(rawLineItem, project.id, sourceRefs, { fallbackEvidence: true });
    if (persistedLineReplay(project, lineItem)) continue;
    lineItems.push(markerWith(marker, 'LINEITEM_NEW', { taskId: project.id, lineItem }));
  }
  return [update, ...lineItems];
}

function analyzeCandidate(marker, projects, identityIndex, fingerprintIndex) {
  const matches = new Map();
  const matchedBy = new Map();
  const addMatch = (project, reason) => {
    matches.set(project.id, project);
    if (!matchedBy.has(project.id)) matchedBy.set(project.id, new Set());
    matchedBy.get(project.id).add(reason);
  };

  for (const identity of candidateIdentityEntries(marker)) {
    for (const project of identityIndex.get(identity.value)?.values() || []) {
      addMatch(project, `identity:${identity.kind}`);
    }
  }

  for (const fingerprint of collectFingerprints(marker?.payload || {})) {
    for (const project of fingerprintIndex.get(fingerprint)?.values() || []) {
      addMatch(project, 'immutable-fingerprint');
    }
  }

  const mentionedProjects = new Map();
  const texts = collectCandidateTexts(marker?.payload || {});
  for (const project of projects) {
    const identifiers = projectIdentityEntries(project).map(entry => entry.value);
    if (!texts.some(text => identifiers.some(identifier => containsStrongIdentifier(text, identifier)))) continue;
    mentionedProjects.set(project.id, project);
    addMatch(project, 'text-identifier');
  }

  return {
    matches,
    matchedBy,
    mentionedProjects,
    identities: new Set(candidateIdentityEntries(marker).map(entry => entry.value)),
    fingerprints: collectFingerprints(marker?.payload || {})
  };
}

function duplicateBatchIndexes(markers, analyses) {
  const identityOwners = new Map();
  const fingerprintOwners = new Map();
  const addOwner = (map, key, index) => {
    if (!key) return;
    if (!map.has(key)) map.set(key, new Set());
    map.get(key).add(index);
  };

  markers.forEach((marker, index) => {
    if (!NEW_MARKER_TYPES.has(marker?.type)) return;
    const analysis = analyses.get(index);
    if (marker.type === 'PROJECT_NEW') {
      for (const identity of analysis.identities) addOwner(identityOwners, identity, index);
    }
    for (const fingerprint of analysis.fingerprints) addOwner(fingerprintOwners, fingerprint, index);
  });

  const duplicateKeys = new Map();
  const collect = (map, kind) => {
    for (const [key, indexes] of map) {
      if (indexes.size < 2) continue;
      for (const index of indexes) {
        if (!duplicateKeys.has(index)) duplicateKeys.set(index, []);
        duplicateKeys.get(index).push(`${kind}:${key}`);
      }
    }
  };
  collect(identityOwners, 'identity');
  collect(fingerprintOwners, 'fingerprint');
  return duplicateKeys;
}

/**
 * Conservatively resolves new markers against active project identities before
 * processing-ledger and temporal gates. Inputs are never mutated.
 */
export function filterMarkersByProjectIdentity(data, markers = [], { now } = {}) {
  void now;
  const inputMarkers = normalizeArray(markers);
  const projects = activeProjects(data);
  const identityIndex = new Map();
  const fingerprintIndex = new Map();

  for (const project of projects) {
    for (const identity of projectIdentityEntries(project)) addMapValue(identityIndex, identity.value, project);
    for (const fingerprint of projectFingerprints(project)) addMapValue(fingerprintIndex, fingerprint, project);
  }

  const analyses = new Map();
  inputMarkers.forEach((marker, index) => {
    if (NEW_MARKER_TYPES.has(marker?.type)) {
      analyses.set(index, analyzeCandidate(marker, projects, identityIndex, fingerprintIndex));
    }
  });

  const heldByIndex = new Map();
  const reviewReasons = [];
  const addHeld = (index, reason, details = {}, { review = true } = {}) => {
    const existing = heldByIndex.get(index);
    if (existing) {
      if (!existing.reasons.includes(reason)) existing.reasons.push(reason);
      return;
    }
    heldByIndex.set(index, {
      index,
      marker: clone(inputMarkers[index]),
      reason,
      reasons: [reason],
      source: details.source || 'project-identity',
      candidateProjectIds: details.candidateProjectIds || []
    });
    if (review) {
      reviewReasons.push({
        index,
        markerIndex: index,
        reason,
        source: details.source || 'project-identity',
        ref: null,
        candidateProjectIds: details.candidateProjectIds || []
      });
    }
  };

  const duplicateKeys = duplicateBatchIndexes(inputMarkers, analyses);
  for (const [index, keys] of duplicateKeys) {
    const kinds = [...new Set(keys.map(key => key.split(':', 1)[0]))].join(' and ');
    addHeld(index, `same-batch duplicate ${kinds} detected; creation marker requires review`, {
      source: 'project-identity-same-batch'
    });
  }

  for (const [index, analysis] of analyses) {
    if (heldByIndex.has(index)) continue;
    const mentionedIds = [...analysis.mentionedProjects.keys()].sort();
    const candidateIds = [...analysis.matches.keys()].sort();
    if (mentionedIds.length > 1) {
      addHeld(index, `candidate text contains strong identifiers for multiple active projects: ${mentionedIds.join(', ')}`, {
        source: 'project-identity-ambiguity',
        candidateProjectIds: mentionedIds
      });
      continue;
    }
    if (candidateIds.length > 1) {
      addHeld(index, `marker matches multiple active projects by exact identity or immutable fingerprint: ${candidateIds.join(', ')}`, {
        source: 'project-identity-ambiguity',
        candidateProjectIds: candidateIds
      });
    }
  }

  const projectRemaps = new Map();
  const projectSourcesByOldId = new Map();
  for (const [index, analysis] of analyses) {
    if (heldByIndex.has(index) || inputMarkers[index]?.type !== 'PROJECT_NEW' || analysis.matches.size !== 1) continue;
    const project = [...analysis.matches.values()][0];
    const oldTaskId = compactFingerprint(inputMarkers[index]?.payload?.taskId);
    if (!oldTaskId) continue;
    projectRemaps.set(oldTaskId, project);
    projectSourcesByOldId.set(oldTaskId, enhancedPayloadSources(inputMarkers[index].payload || {}).all);
  }

  const output = [];
  const autoAttached = [];
  for (const [index, marker] of inputMarkers.entries()) {
    if (heldByIndex.has(index)) continue;

    const analysis = analyses.get(index);
    if (analysis?.matches.size === 1 && marker.type === 'TASK_NEW') {
      const project = [...analysis.matches.values()][0];
      const transformed = transformTaskNew(marker, project);
      if (persistedLineReplay(project, transformed.payload.lineItem)) {
        addHeld(index, `exact persisted line-item replay ignored for project ${project.id}`, {
          source: 'project-identity-replay',
          candidateProjectIds: [project.id]
        }, { review: false });
        continue;
      }
      output.push(transformed);
      autoAttached.push({
        index,
        originalType: marker.type,
        transformedTypes: [transformed.type],
        projectId: project.id,
        taskId: project.id,
        matchedBy: [...analysis.matchedBy.get(project.id)].sort(),
        marker: clone(transformed),
        markers: [clone(transformed)]
      });
      continue;
    }

    if (analysis?.matches.size === 1 && marker.type === 'PROJECT_NEW') {
      const project = [...analysis.matches.values()][0];
      const transformed = transformProjectNew(marker, project);
      output.push(...transformed);
      autoAttached.push({
        index,
        originalType: marker.type,
        transformedTypes: transformed.map(item => item.type),
        projectId: project.id,
        taskId: project.id,
        matchedBy: [...analysis.matchedBy.get(project.id)].sort(),
        marker: clone(transformed[0]),
        markers: clone(transformed)
      });
      continue;
    }

    if (marker?.type === 'LINEITEM_NEW') {
      const oldTaskId = compactFingerprint(marker.payload?.taskId);
      const project = projectRemaps.get(oldTaskId);
      if (project) {
        const payload = clone(marker.payload || {});
        const ownSources = enhancedPayloadSources(payload).all;
        const sourceRefs = ownSources.length ? ownSources : (projectSourcesByOldId.get(oldTaskId) || []);
        payload.taskId = project.id;
        payload.lineItem = enhanceLineItem(payload.lineItem, project.id, sourceRefs, { fallbackEvidence: true });
        if (persistedLineReplay(project, payload.lineItem)) {
          addHeld(index, `exact persisted line-item replay ignored for project ${project.id}`, {
            source: 'project-identity-replay',
            candidateProjectIds: [project.id]
          }, { review: false });
          continue;
        }
        const transformed = markerWith(marker, marker.type, payload);
        output.push(transformed);
        autoAttached.push({
          index,
          originalType: marker.type,
          transformedTypes: [marker.type],
          projectId: project.id,
          taskId: project.id,
          matchedBy: ['same-batch-project-taskId'],
          marker: clone(transformed),
          markers: [clone(transformed)]
        });
        continue;
      }
    }

    output.push(clone(marker));
  }

  return {
    markers: output,
    held: [...heldByIndex.values()].sort((a, b) => a.index - b.index),
    reviewReasons,
    autoAttached
  };
}

function deterministicTimestamp(now) {
  if (now instanceof Date && Number.isFinite(now.getTime())) return now.toISOString();
  const value = compactFingerprint(now);
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value;
}

function activeSingles(data) {
  return normalizeArray(data?.tasks).filter(task => {
    return task?.taskType === 'single'
      && task.archived !== true
      && !compactFingerprint(task.supersededBy)
      && !TERMINAL_STATUSES.has(compactIdentity(task.status));
  });
}

function mergeableSourceKeys(sourceRef) {
  const fingerprints = new Set();
  addSourceFingerprints(fingerprints, sourceRef);
  return new Set([...fingerprints].filter(key => !key.startsWith('thread:')));
}

function sourceRefsOverlap(left, right) {
  const leftKeys = mergeableSourceKeys(left);
  if (leftKeys.size === 0) return false;
  return [...mergeableSourceKeys(right)].some(key => leftKeys.has(key));
}

function fillMissingSourceFields(existing, donor) {
  const merged = clone(existing);
  for (const [key, value] of Object.entries(donor)) {
    if (merged[key] === undefined || merged[key] === null || merged[key] === '') merged[key] = clone(value);
  }
  return merged;
}

function mergeDonorSourceRefs(existingRefs, donorRefs) {
  const refs = normalizeArray(existingRefs).map(clone);
  const donorIdToProjectId = new Map();

  for (const rawDonor of donorRefs) {
    const donor = enhanceSourceRef(rawDonor);
    const index = refs.findIndex(existing => sourceRefsOverlap(existing, donor));
    if (index >= 0) {
      refs[index] = fillMissingSourceFields(refs[index], donor);
      donorIdToProjectId.set(String(donor.id), String(refs[index].id || donor.id));
      continue;
    }
    refs.push(donor);
    donorIdToProjectId.set(String(donor.id), String(donor.id));
  }

  return { refs, donorIdToProjectId };
}

function lineItemFromSingle(single, projectId, sourceRefs, evidenceRefIds) {
  const carriesExplicitAction = Boolean(
    single.userActionRequired
    || single.owner
    || single.plannedNext
    || single.dueAt
    || ['in-progress', 'waiting', 'blocked'].includes(compactIdentity(single.status))
  );
  const inheritedState = single.state || 'unconfirmed';
  const lineItem = {
    title: single.title || 'Untitled line item',
    summary: single.summary || '',
    category: single.category || (carriesExplicitAction ? 'action' : 'info'),
    priority: single.priority,
    status: normalizedLineStatus(single.status),
    owner: single.owner ?? null,
    userActionRequired: Boolean(single.userActionRequired),
    userAction: single.userAction ?? null,
    currentState: single.currentState ?? single.summary ?? '',
    plannedNext: single.plannedNext ?? null,
    dueAt: single.dueAt ?? null,
    waitingOn: single.waitingOn ?? null,
    problem: single.problem ?? null,
    risk: single.risk ?? null,
    confidence: single.confidence || 'low',
    relevance: single.relevance ?? null,
    evidenceRefIds,
    sourceTaskIds: [...new Set([
      ...normalizeArray(single.sourceTaskIds).map(String),
      String(single.id)
    ])],
    state: inheritedState,
    sources: normalizeArray(single.sources),
    lastConfirmedByMessageDate: single.lastConfirmedByMessageDate ?? single.date ?? null,
    threadRef: single.threadRef || inferredThreadRef(single, sourceRefs),
    lastVerifiedMessageDate: single.lastVerifiedMessageDate ?? single.date ?? null,
    resolutionStatus: single.resolutionStatus || (inheritedState === 'unconfirmed' ? 'unverified' : 'open'),
    needsReview: single.needsReview ?? (inheritedState === 'unconfirmed'),
    reviewReason: single.reviewReason || (inheritedState === 'unconfirmed'
      ? 'Safety-net attachment preserved this fragment, but current status still requires fresh source verification.'
      : null)
  };
  if (lineItem.priority === undefined) delete lineItem.priority;
  return enhanceLineItem(lineItem, projectId, sourceRefs, { fallbackEvidence: true });
}

function appendHistoryEntry(task, entry) {
  task.history = normalizeArray(task.history).map(clone);
  const exists = task.history.some(item => {
    return item?.type === entry.type
      && item?.sourceTaskId === entry.sourceTaskId
      && item?.projectId === entry.projectId;
  });
  if (!exists) task.history.push(entry);
}

function singleAsCandidateMarker(single) {
  return {
    type: 'TASK_NEW',
    payload: {
      taskId: single.id,
      title: single.title,
      summary: single.summary,
      description: single.description,
      currentState: single.currentState,
      notes: single.notes,
      sourceRefs: normalizeArray(single.sourceRefs),
      processing: single.processing,
      threadRef: single.threadRef,
      conversationId: single.conversationId
    }
  };
}

/**
 * Reconciles already-persisted standalone fragments without deleting their audit
 * records. Only one exact active-project match is eligible for attachment.
 */
export function reconcileProjectFragments(data, { now } = {}) {
  const resultData = clone(isObject(data) ? data : {});
  resultData.tasks = normalizeArray(resultData.tasks);
  const projects = activeProjects(resultData);
  const identityIndex = new Map();
  const fingerprintIndex = new Map();
  const timestamp = deterministicTimestamp(now);

  for (const project of projects) {
    for (const identity of projectIdentityEntries(project)) addMapValue(identityIndex, identity.value, project);
    for (const fingerprint of projectFingerprints(project)) addMapValue(fingerprintIndex, fingerprint, project);
  }

  const attached = [];
  const held = [];
  const reviewReasons = [];
  for (const single of activeSingles(resultData)) {
    const analysis = analyzeCandidate(singleAsCandidateMarker(single), projects, identityIndex, fingerprintIndex);
    const candidateProjectIds = [...analysis.matches.keys()].sort();
    const mentionedProjectIds = [...analysis.mentionedProjects.keys()].sort();

    if (mentionedProjectIds.length > 1 || candidateProjectIds.length > 1) {
      const competingIds = [...new Set([...mentionedProjectIds, ...candidateProjectIds])].sort();
      const reason = `active single ${single.id} matches competing active project identities: ${competingIds.join(', ')}`;
      const entry = {
        taskId: single.id,
        sourceTaskId: single.id,
        task: clone(single),
        reason,
        source: 'project-fragment-ambiguity',
        candidateProjectIds: competingIds
      };
      held.push(entry);
      reviewReasons.push({
        taskId: single.id,
        sourceTaskId: single.id,
        reason,
        source: entry.source,
        ref: single.id,
        candidateProjectIds: competingIds
      });
      continue;
    }

    if (candidateProjectIds.length !== 1) continue;
    const project = analysis.matches.get(candidateProjectIds[0]);
    const donorRefs = normalizeArray(single.sourceRefs);
    const mergedSources = mergeDonorSourceRefs(project.sourceRefs, donorRefs);
    project.sourceRefs = mergedSources.refs;
    project.additionalLinks = project.sourceRefs.map(ref => ref?.link).filter(Boolean);
    project.supersedesTaskIds = [...new Set([
      ...normalizeArray(project.supersedesTaskIds).map(String),
      String(single.id)
    ])];
    const evidenceAt = latestEvidenceAt(project.sourceRefs);
    if (evidenceAt) {
      project.brainState = isObject(project.brainState) ? project.brainState : {};
      project.brainState.lastEvidenceAt = evidenceAt;
    }

    const donorEnhancedRefs = donorRefs.map(enhanceSourceRef);
    const evidenceRefIds = [...new Set(donorEnhancedRefs.map(ref => {
      return mergedSources.donorIdToProjectId.get(String(ref.id)) || String(ref.id);
    }))];
    const lineSourceIds = new Set(evidenceRefIds);
    const lineSources = project.sourceRefs.filter(ref => lineSourceIds.has(String(ref?.id)));
    const lineItem = lineItemFromSingle(single, project.id, lineSources, evidenceRefIds);
    const replay = findPersistedLineReplay(project, lineItem);
    project.lineItems = normalizeArray(project.lineItems);
    if (!replay) project.lineItems.push(lineItem);

    appendHistoryEntry(project, {
      timestamp,
      type: 'project-fragment-attached',
      text: `Attached standalone task ${single.id} as project line item`,
      sourceTaskId: single.id,
      projectId: project.id,
      lineItemId: replay?.id || lineItem.id
    });
    if (timestamp) project.updatedAt = timestamp;

    single.archived = true;
    single.supersededBy = project.id;
    single.archivedAt = timestamp;
    if (timestamp) single.updatedAt = timestamp;
    appendHistoryEntry(single, {
      timestamp,
      type: 'project-fragment-archived',
      text: `Archived after attachment to project ${project.id}`,
      sourceTaskId: single.id,
      projectId: project.id,
      lineItemId: replay?.id || lineItem.id
    });

    attached.push({
      taskId: single.id,
      sourceTaskId: single.id,
      projectId: project.id,
      lineItemId: replay?.id || lineItem.id,
      lineItemCreated: !replay,
      matchedBy: [...analysis.matchedBy.get(project.id)].sort()
    });
  }

  return { data: resultData, attached, held, reviewReasons };
}
