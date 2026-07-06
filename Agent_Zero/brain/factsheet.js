import { randomUUID } from 'node:crypto';
import { normalizeNodeFields, validateNodeState } from './truth-tree.js';

export const FACTSHEET_VERSION = 1;

export const FACTSHEET_SECTIONS = Object.freeze([
  { id: 'overview', title: 'Overview' },
  { id: 'scopeGoals', title: 'Scope & Goals' },
  { id: 'timelineMilestones', title: 'Timeline & Milestones' },
  { id: 'budgetCostsApprovals', title: 'Budget & Costs & Approvals' },
  { id: 'status', title: 'Status' },
  { id: 'opportunities', title: 'Opportunities' },
  { id: 'risksChallenges', title: 'Risks & Challenges' },
  { id: 'peopleRoles', title: 'People & Roles' },
  { id: 'decisionMakers', title: 'Decision Makers' },
  { id: 'decisionsLog', title: 'Decisions Log' },
  { id: 'openActions', title: 'Open Actions' },
  { id: 'sources', title: 'Sources' }
]);

export const FACTSHEET_SECTION_IDS = new Set(FACTSHEET_SECTIONS.map(section => section.id));

const FACTSHEET_ENTRY_FIELDS = new Set([
  'text',
  'date',
  'evidenceRefIds',
  'confidence',
  'sourceType',
  'title',
  'owner',
  'person',
  'role',
  'organization',
  'location',
  'country',
  'contact',
  'notes',
  'amount',
  'currency',
  'status',
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
  'supersededReason'
]);

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function defaultIdFactory(prefix) {
  return `${prefix}-${randomUUID()}`;
}

function entryText(entry) {
  if (!entry || typeof entry !== 'object') return '';
  return entry.text || entry.title || entry.person || entry.status || '';
}

export function createEmptyFactSheet({ now = null } = {}) {
  const ts = now ? nowIso(now) : null;
  const sections = {};
  for (const section of FACTSHEET_SECTIONS) sections[section.id] = [];
  return {
    version: FACTSHEET_VERSION,
    language: 'en',
    updatedAt: ts,
    sections
  };
}

export function normalizeFactSheet(value, { now = null } = {}) {
  const base = createEmptyFactSheet({ now });
  if (!value || typeof value !== 'object' || Array.isArray(value)) return base;

  const sectionsInput = value.sections && typeof value.sections === 'object' && !Array.isArray(value.sections)
    ? value.sections
    : value;
  const sections = {};

  for (const section of FACTSHEET_SECTIONS) {
    sections[section.id] = normalizeArray(sectionsInput[section.id]).map((entry, index) => {
      if (typeof entry === 'string') {
        return normalizeNodeFields({
          id: `${section.id}-${index + 1}`,
          text: entry,
          evidenceRefIds: [],
          confidence: 'low'
        });
      }
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
        return null;
      }
      return normalizeNodeFields({
        ...entry,
        id: entry.id || `${section.id}-${index + 1}`,
        evidenceRefIds: normalizeArray(entry.evidenceRefIds),
        confidence: ['high', 'medium', 'low'].includes(entry.confidence) ? entry.confidence : 'low'
      });
    }).filter(Boolean);
  }

  return {
    version: FACTSHEET_VERSION,
    language: 'en',
    updatedAt: value.updatedAt || base.updatedAt,
    sections
  };
}

function sourceRefExists(sourceRefIndex, id) {
  return typeof id === 'string' && sourceRefIndex.has(id);
}

function validateEvidenceRefIds(ids, sourceRefIndex, fieldName = 'evidenceRefIds') {
  if (!Array.isArray(ids) || ids.length === 0) return `${fieldName} must be a non-empty array`;
  for (const id of ids) {
    if (!sourceRefExists(sourceRefIndex, id)) return `unknown ${fieldName} entry: ${id}`;
  }
  return null;
}

function normalizePatchList(sectionPatches) {
  if (Array.isArray(sectionPatches)) return sectionPatches;
  if (!sectionPatches || typeof sectionPatches !== 'object') return null;

  const result = [];
  for (const [section, patches] of Object.entries(sectionPatches)) {
    if (!Array.isArray(patches)) return null;
    for (const patch of patches) result.push({ section, ...patch });
  }
  return result;
}

export function validateFactSheetSectionPatches(sectionPatches, sourceRefIndex) {
  const patches = normalizePatchList(sectionPatches);
  if (!patches) return 'sectionPatches must be an object of arrays or an array';
  if (!patches.length) return 'sectionPatches must not be empty';

  for (const patch of patches) {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return 'section patch entries must be objects';
    if (!FACTSHEET_SECTION_IDS.has(patch.section)) return `unknown factSheet section: ${patch.section}`;
    const op = patch.op || 'add';
    if (!['add', 'update', 'replace', 'remove'].includes(op)) return `invalid factSheet op: ${op}`;
    const nodeStateError = validateNodeState(patch, `factSheet.${patch.section}`);
    if (nodeStateError) return nodeStateError;

    if (op === 'add') {
      if (!entryText(patch).trim()) return 'factSheet add requires text, title, person, or status';
      const evidenceError = validateEvidenceRefIds(patch.evidenceRefIds, sourceRefIndex);
      if (evidenceError) return evidenceError;
      continue;
    }

    if (typeof patch.entryId !== 'string' || !patch.entryId.trim()) {
      return `factSheet ${op} requires entryId`;
    }
    if (typeof patch.reason !== 'string' || !patch.reason.trim()) {
      return `factSheet ${op} requires reason`;
    }
    const evidenceError = validateEvidenceRefIds(patch.evidenceRefIds, sourceRefIndex);
    if (evidenceError) return evidenceError;

    if (op === 'update' || op === 'replace') {
      const disallowed = Object.keys(patch)
        .filter(key => !['section', 'op', 'entryId', 'reason'].includes(key))
        .filter(key => !FACTSHEET_ENTRY_FIELDS.has(key));
      if (disallowed.length) return `factSheet ${op} contains disallowed field(s): ${disallowed.join(', ')}`;
    }
  }

  return null;
}

function entryFromPatch(patch, { now, idFactory }) {
  const entry = {};
  for (const field of FACTSHEET_ENTRY_FIELDS) {
    if (patch[field] !== undefined) entry[field] = patch[field];
  }
  return normalizeNodeFields({
    ...entry,
    id: patch.id || idFactory(`fs-${patch.section}`),
    evidenceRefIds: normalizeArray(entry.evidenceRefIds),
    confidence: ['high', 'medium', 'low'].includes(entry.confidence) ? entry.confidence : 'low',
    firstSeenAt: patch.firstSeenAt || nowIso(now),
    updatedAt: patch.updatedAt || nowIso(now)
  }, { defaultState: patch.state || 'confirmed' });
}

export function applyFactSheetSectionPatches(factSheet, sectionPatches, {
  now = new Date(),
  idFactory = defaultIdFactory
} = {}) {
  const sheet = normalizeFactSheet(factSheet, { now });
  const patches = normalizePatchList(sectionPatches) || [];
  const ts = nowIso(now);

  for (const patch of patches) {
    const op = patch.op || 'add';
    const entries = sheet.sections[patch.section];

    if (op === 'add') {
      entries.push(entryFromPatch(patch, { now, idFactory }));
      continue;
    }

    const index = entries.findIndex(entry => entry.id === patch.entryId);
    if (index === -1) continue;

    if (op === 'remove') {
      entries[index] = {
        ...entries[index],
        removedAt: ts,
        removedReason: patch.reason,
        removedEvidenceRefIds: normalizeArray(patch.evidenceRefIds),
        updatedAt: ts
      };
      continue;
    }

    const replacement = op === 'replace'
      ? entryFromPatch({ ...patch, id: patch.entryId }, { now, idFactory })
      : { ...entries[index] };
    for (const field of FACTSHEET_ENTRY_FIELDS) {
      if (patch[field] !== undefined) replacement[field] = patch[field];
    }
    replacement.id = patch.entryId;
    replacement.evidenceRefIds = normalizeArray(replacement.evidenceRefIds);
    replacement.updatedAt = ts;
    replacement.correctionReason = patch.reason;
    entries[index] = replacement;
  }

  sheet.updatedAt = ts;
  return sheet;
}

function pushEntry(sections, sectionId, entry) {
  if (!entry || !entry.text) return;
  const key = `${sectionId}:${entry.text}:${normalizeArray(entry.evidenceRefIds).join(',')}`;
  if (sections._seen.has(key)) return;
  sections._seen.add(key);
  sections[sectionId].push({
    id: entry.id,
    text: entry.text,
    owner: entry.owner || null,
    date: entry.date || null,
    evidenceRefIds: normalizeArray(entry.evidenceRefIds),
    confidence: entry.confidence || 'medium'
  });
}

export function bootstrapFactSheetFromTask(task, { now = new Date(), idFactory = defaultIdFactory } = {}) {
  const sheet = createEmptyFactSheet({ now });
  const sections = sheet.sections;
  sections._seen = new Set();
  const sourceRefs = normalizeArray(task?.sourceRefs);

  pushEntry(sections, 'overview', {
    id: idFactory('fs-overview'),
    text: task?.summary || task?.title || 'No overview captured yet.',
    evidenceRefIds: sourceRefs[0]?.id ? [sourceRefs[0].id] : [],
    confidence: sourceRefs[0]?.id ? 'medium' : 'low'
  });

  const pm = task?.pmStatus || {};
  if (pm.current) {
    pushEntry(sections, 'status', {
      id: idFactory('fs-status'),
      text: String(pm.current),
      evidenceRefIds: normalizeArray(pm.evidenceRefIds),
      confidence: pm.confidence || 'medium'
    });
  }

  for (const entry of normalizeArray(pm.planned)) {
    pushEntry(sections, 'timelineMilestones', {
      id: idFactory('fs-timeline'),
      text: entry.text,
      owner: entry.owner || 'user',
      date: entry.date || null,
      evidenceRefIds: entry.evidence ? [entry.evidence] : [],
      confidence: entry.confidence || pm.confidence || 'medium'
    });
  }
  for (const entry of normalizeArray(pm.userActions)) {
    pushEntry(sections, 'openActions', {
      id: idFactory('fs-action'),
      text: entry.text,
      date: entry.date || null,
      evidenceRefIds: entry.evidence ? [entry.evidence] : [],
      confidence: entry.confidence || pm.confidence || 'medium'
    });
  }
  for (const field of ['problems', 'risks', 'waitingOn']) {
    for (const entry of normalizeArray(pm[field])) {
      pushEntry(sections, 'risksChallenges', {
        id: idFactory('fs-risk'),
        text: entry.text,
        date: entry.date || null,
        evidenceRefIds: entry.evidence ? [entry.evidence] : [],
        confidence: entry.confidence || pm.confidence || 'medium'
      });
    }
  }

  for (const item of normalizeArray(task?.lineItems)) {
    const target = item.category === 'decision' ? 'decisionsLog'
      : item.category === 'risk' || item.problem || item.risk || item.waitingOn ? 'risksChallenges'
      : item.userActionRequired ? 'openActions'
      : 'scopeGoals';
    pushEntry(sections, target, {
      id: idFactory(`fs-${target}`),
      text: [item.title, item.currentState].filter(Boolean).join(': '),
      owner: item.owner || null,
      date: item.dueAt || null,
      evidenceRefIds: normalizeArray(item.evidenceRefIds),
      confidence: item.confidence || 'medium'
    });
  }

  for (const ref of sourceRefs) {
    pushEntry(sections, 'sources', {
      id: idFactory('fs-source'),
      text: [ref.title || ref.id, ref.from ? `from ${ref.from}` : '', ref.type ? `type ${ref.type}` : ''].filter(Boolean).join(' | '),
      date: ref.date || ref.lastSeenAt || ref.firstSeenAt || null,
      evidenceRefIds: ref.id ? [ref.id] : [],
      confidence: ref.link ? 'medium' : 'low'
    });
  }

  delete sections._seen;
  sheet.updatedAt = nowIso(now);
  return sheet;
}

export function renderFactSheetMarkdown(task) {
  const sheet = normalizeFactSheet(task?.factSheet);
  const lines = [`# Fact Sheet for ${task?.id || 'task'}`, '', `Title: ${task?.title || ''}`, 'Language: English', ''];
  for (const section of FACTSHEET_SECTIONS) {
    lines.push(`## ${section.title}`);
    const entries = normalizeArray(sheet.sections[section.id]).filter(entry => !entry.removedAt);
    if (!entries.length) {
      lines.push('- none');
      lines.push('');
      continue;
    }
    for (const entry of entries) {
      const parts = [];
      const text = entry.text || entry.title || entry.person || entry.status || '';
      parts.push(text);
      if (entry.date) parts.push(`date=${entry.date}`);
      if (entry.evidenceRefIds?.length) parts.push(`evidence=${entry.evidenceRefIds.join(',')}`);
      if (entry.confidence) parts.push(`confidence=${entry.confidence}`);
      if (entry.owner) parts.push(`owner=${entry.owner}`);
      if (entry.organization) parts.push(`org=${entry.organization}`);
      if (entry.location) parts.push(`location=${entry.location}`);
      if (entry.country) parts.push(`country=${entry.country}`);
      if (entry.contact) parts.push(`contact=${entry.contact}`);
      lines.push(`- ${parts.filter(Boolean).join(' | ')}`);
    }
    lines.push('');
  }
  return `${lines.join('\n')}\n`;
}
