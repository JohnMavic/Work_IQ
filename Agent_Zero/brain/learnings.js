import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_LEARNINGS_FILE = path.join(REPO_ROOT, 'brain-learnings.md');
export const DEFAULT_LEARNINGS_MAX_BYTES = 8 * 1024;
export const LEARNING_CATEGORIES = new Set(['principle', 'pattern', 'fact']);
export const LEARNING_VOLATILITIES = new Set([
  'ephemeral',
  'project_state',
  'versioned_tool',
  'workflow',
  'principle'
]);
export const LEARNING_OUTCOMES = new Set([
  'active',
  'success',
  'confirmed_success',
  'needs_review',
  'failed',
  'contradicted',
  'reverified'
]);
export const LEARNING_HALF_LIFE_DAYS = Object.freeze({
  ephemeral: 14,
  project_state: 30,
  versioned_tool: 90,
  workflow: 180,
  principle: 365
});
export const LEARNING_REPROBE_COOLDOWN_DAYS = Object.freeze({
  ephemeral: 7,
  project_state: 14,
  versioned_tool: 30,
  workflow: 60,
  principle: Number.POSITIVE_INFINITY
});

const NEGATIVE_OUTCOMES = new Set(['needs_review', 'failed', 'contradicted']);
const GENERIC_QUERY_TERMS = new Set([
  'agent', 'brain', 'context', 'learning', 'memory', 'project', 'scan', 'task'
]);
const STOPWORDS = new Set([
  'a', 'about', 'an', 'and', 'are', 'as', 'at', 'be', 'but', 'by', 'can',
  'das', 'der', 'die', 'do', 'does', 'for', 'from', 'have', 'how', 'i', 'if',
  'im', 'in', 'is', 'it', 'mit', 'my', 'no', 'not', 'of', 'on', 'or', 'our',
  'so', 'that', 'the', 'their', 'then', 'this', 'to', 'und', 'was', 'we',
  'were', 'what', 'when', 'where', 'which', 'who', 'why', 'will', 'with',
  'would', 'you', 'your'
]);
const KNOWN_FIELDS = new Set([
  'category',
  'contenthash',
  'cooldown',
  'cooldowndays',
  'evidence',
  'id',
  'observedat',
  'outcome',
  'scope',
  'tags',
  'text',
  'volatility'
]);

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function normalizeMaxBytes(value, fallback = DEFAULT_LEARNINGS_MAX_BYTES) {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) return fallback;
  return Math.max(0, Math.floor(value));
}

function hardClipUtf8(text, maxBytes) {
  const value = String(text || '');
  const limit = normalizeMaxBytes(maxBytes, 0);
  if (byteLength(value) <= limit) return value;
  let used = 0;
  let clipped = '';
  for (const character of value) {
    const size = byteLength(character);
    if (used + size > limit) break;
    clipped += character;
    used += size;
  }
  return clipped;
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function normalizeHashText(text) {
  return normalizeWhitespace(text).normalize('NFC').toLowerCase();
}

function normalizeFieldName(name) {
  return String(name || '').replace(/[_-]/g, '').toLowerCase();
}

function normalizeTags(value) {
  let values = [];
  if (Array.isArray(value)) {
    values = value;
  } else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      try {
        const parsed = JSON.parse(trimmed);
        if (Array.isArray(parsed)) values = parsed;
      } catch {}
    }
    if (!values.length && trimmed && !/^none$/i.test(trimmed)) {
      values = trimmed.split(/[,;|]/);
    }
  }
  return [...new Set(values
    .map(tag => normalizeHashText(tag))
    .filter(Boolean))]
    .sort();
}

function normalizeScope(value) {
  const values = Array.isArray(value) ? value : [value];
  const normalized = values
    .map(item => normalizeWhitespace(item))
    .filter(Boolean);
  return normalized.length ? normalized.join(', ') : 'global';
}

function defaultVolatility(category) {
  if (category === 'principle') return 'principle';
  if (category === 'pattern') return 'workflow';
  return 'project_state';
}

function normalizeVolatilityName(value) {
  const normalized = normalizeHashText(value).replace(/[\s-]+/g, '_');
  if (normalized === 'transient') return 'ephemeral';
  if (normalized === 'stable_policy') return 'principle';
  if (normalized === 'environment_dependent') return 'versioned_tool';
  return normalized;
}

function normalizeVolatility(value, category = 'fact') {
  const normalized = normalizeVolatilityName(value);
  if (LEARNING_VOLATILITIES.has(normalized)) return normalized;
  return defaultVolatility(category);
}

function normalizeOutcome(value) {
  const normalized = normalizeHashText(value).replace(/[\s-]+/g, '_');
  if (!normalized) return 'active';
  if (normalized.includes('reverified')) return 'reverified';
  if (normalized.includes('needs_review') || normalized.includes('needsreview')) return 'needs_review';
  if (normalized.includes('contradicted')) return 'contradicted';
  if (normalized.includes('failed') || normalized.includes('failure')) return 'failed';
  if (normalized.includes('confirmed_success')) return 'confirmed_success';
  if (normalized.includes('success') || normalized === 'passed') return 'success';
  return LEARNING_OUTCOMES.has(normalized) ? normalized : 'active';
}

function parseCooldownDays(value) {
  if (Number.isFinite(value)) return Math.max(0, Number(value));
  const normalized = normalizeWhitespace(value);
  if (!normalized) return null;
  const duration = normalized.match(/^P(\d+(?:\.\d+)?)D$/i);
  if (duration) return Number(duration[1]);
  const days = normalized.match(/^(\d+(?:\.\d+)?)\s*(?:d|day|days)?$/i);
  return days ? Number(days[1]) : null;
}

function isoValue(value, fallback = null) {
  const normalized = normalizeWhitespace(value);
  if (normalized && !Number.isNaN(Date.parse(normalized))) return normalized;
  return fallback;
}

function splitLearningEntries(text) {
  const normalized = String(text || '').replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const firstEntryIndex = lines.findIndex(line => /^##\s+/.test(line));
  if (firstEntryIndex < 0) {
    return { preamble: normalized.trimEnd(), entries: [] };
  }

  const preamble = lines.slice(0, firstEntryIndex).join('\n').trimEnd();
  const entries = [];
  let current = [];
  for (const line of lines.slice(firstEntryIndex)) {
    if (/^##\s+/.test(line) && current.length) {
      entries.push(current.join('\n').trimEnd());
      current = [];
    }
    current.push(line);
  }
  if (current.length) entries.push(current.join('\n').trimEnd());
  return { preamble, entries };
}

function joinLearningEntries(preamble, entries, warning = null) {
  const parts = [];
  if (preamble) parts.push(preamble);
  if (warning) parts.push(`> WARNING: ${warning}`);
  parts.push(...entries);
  return `${parts.filter(Boolean).join('\n\n').trimEnd()}\n`;
}

function trimToBudget(text, maxBytes) {
  const limit = normalizeMaxBytes(maxBytes);
  const value = String(text || '');
  if (byteLength(value) <= limit) {
    return { text: value, truncated: false, warning: null, omittedEntries: 0 };
  }
  if (limit === 0) {
    return {
      text: '',
      truncated: true,
      warning: 'Brain learnings were omitted by the 0-byte budget.',
      omittedEntries: splitLearningEntries(value).entries.length
    };
  }

  const { preamble, entries } = splitLearningEntries(value);
  if (!entries.length) {
    const warning = `Brain learnings exceeded ${limit} bytes and were hard-truncated.`;
    const prefix = `> WARNING: ${warning}\n\n`;
    const available = Math.max(0, limit - byteLength(prefix));
    const tail = hardClipUtf8(value, available);
    return {
      text: hardClipUtf8(`${prefix}${tail}`, limit),
      truncated: true,
      warning,
      omittedEntries: 0
    };
  }

  const kept = [...entries];
  let omittedEntries = 0;
  let warning = `Brain learnings exceeded ${limit} bytes; oldest entries were omitted from this run.`;
  let candidate = joinLearningEntries(preamble, kept, warning);
  while (kept.length > 1 && byteLength(candidate) > limit) {
    kept.shift();
    omittedEntries++;
    candidate = joinLearningEntries(preamble, kept, warning);
  }

  if (byteLength(candidate) <= limit) {
    return { text: candidate, truncated: true, warning, omittedEntries };
  }

  warning = `Brain learnings exceeded ${limit} bytes; oldest entries and part of the newest entry were omitted from this run.`;
  const prefix = `> WARNING: ${warning}\n\n`;
  const newest = kept.at(-1) || '';
  const clipped = hardClipUtf8(newest, Math.max(0, limit - byteLength(prefix)));
  return {
    text: hardClipUtf8(`${prefix}${clipped}`, limit),
    truncated: true,
    warning,
    omittedEntries: Math.max(omittedEntries, entries.length - 1)
  };
}

export function computeLearningContentHash(input) {
  const value = typeof input === 'string' ? { text: input } : (input || {});
  const canonical = JSON.stringify([
    normalizeHashText(value.category || ''),
    normalizeHashText(value.text || value.content || ''),
    normalizeTags(value.tags)
  ]);
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex');
}

export function learningIdFromContent(input) {
  return `lw-${computeLearningContentHash(input)}`;
}

function parseEntryFields(rawEntry) {
  const lines = String(rawEntry || '').replace(/\r\n/g, '\n').split('\n');
  const headingLine = lines.shift() || '';
  const heading = headingLine.replace(/^##\s+/, '').trim();
  const fields = {};
  let currentField = null;

  for (const line of lines) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    const normalizedName = match ? normalizeFieldName(match[1]) : null;
    if (match && KNOWN_FIELDS.has(normalizedName)) {
      currentField = normalizedName;
      fields[currentField] = normalizeWhitespace(match[2]);
      continue;
    }
    if (currentField && line.trim()) {
      fields[currentField] = normalizeWhitespace(`${fields[currentField]} ${line}`);
    }
  }

  return { heading, fields };
}

function inferLegacyAttachmentFailure({ fields, category, title, text, evidence }) {
  if (category === 'principle' || fields.volatility || fields.outcome) return null;
  const content = normalizeWhitespace(`${title} ${text} ${evidence}`);
  const namesAttachment = /\b(?:attachment|deck|pdf)\b/i.test(content);
  const recordsIndexFailure = /(?:content[- ]not[- ]indexed|non[- ]indexed|no indexed attachment content)/i.test(content);
  const recordsPastRuns = /\b(?:prior|previous|earlier|this|consecutive|later)\b[^.]{0,120}\bscans?\b/i.test(content)
    || /\bacross\b[^.]{0,80}\bscans?\b/i.test(content);
  if (!namesAttachment || !recordsIndexFailure || !recordsPastRuns) return null;
  return { volatility: 'ephemeral', outcome: 'failed' };
}

function parseLearningEntry(rawEntry, index) {
  const { heading, fields } = parseEntryFields(rawEntry);
  const headingMatch = heading.match(/^(\d{4}-\d{2}-\d{2})\s+(principle|pattern|fact):\s*(.*)$/i);
  const date = headingMatch?.[1] || null;
  const headingCategory = headingMatch?.[2]?.toLowerCase() || null;
  const category = LEARNING_CATEGORIES.has(normalizeHashText(fields.category))
    ? normalizeHashText(fields.category)
    : (headingCategory || 'fact');
  const title = headingMatch?.[3]?.trim() || heading || `learning-${index + 1}`;
  const text = normalizeWhitespace(fields.text);
  const tags = normalizeTags(fields.tags);
  const scopeExplicit = Boolean(fields.scope);
  const scope = normalizeScope(fields.scope || 'global');
  const inferredLegacyMetadata = inferLegacyAttachmentFailure({
    fields,
    category,
    title,
    text,
    evidence: fields.evidence
  });
  const volatility = normalizeVolatility(fields.volatility || inferredLegacyMetadata?.volatility, category);
  const outcome = normalizeOutcome(fields.outcome || inferredLegacyMetadata?.outcome);
  const observedAt = isoValue(fields.observedat, date);
  const cooldownDays = parseCooldownDays(fields.cooldowndays ?? fields.cooldown);
  const contentHash = computeLearningContentHash({ category, text, tags });

  return {
    id: learningIdFromContent({ category, text, tags }),
    contentHash,
    storedId: normalizeWhitespace(fields.id) || null,
    storedContentHash: normalizeWhitespace(fields.contenthash) || null,
    title,
    date,
    category,
    evidence: normalizeWhitespace(fields.evidence),
    text,
    scope,
    scopeExplicit,
    tags,
    volatility,
    outcome,
    observedAt,
    cooldownDays,
    inferredLegacyMetadata: Boolean(inferredLegacyMetadata),
    raw: String(rawEntry || '').trimEnd(),
    metadata: { ...fields }
  };
}

export function parseBrainLearnings(markdown) {
  const split = splitLearningEntries(markdown);
  return {
    preamble: split.preamble,
    entries: split.entries.map(parseLearningEntry)
  };
}

export const parseBrainLearningMarkdown = parseBrainLearnings;

function hasCuratedInput(options) {
  if (!options || typeof options !== 'object') return false;
  return typeof options.query === 'string'
    || options.context !== undefined
    || options.projectTitle !== undefined
    || options.projectTitles !== undefined
    || options.projectKey !== undefined
    || options.projectKeys !== undefined
    || options.aliases !== undefined
    || options.projectAliases !== undefined
    || options.tools !== undefined
    || options.services !== undefined;
}

function shouldRenderCurated(options) {
  if (hasCuratedInput(options)) return true;
  const configuredPath = options?.filePath;
  if (!configuredPath) return true;
  return path.resolve(configuredPath) === path.resolve(DEFAULT_LEARNINGS_FILE);
}

export function loadBrainLearnings(options = {}) {
  if (hasCuratedInput(options)) return loadCuratedBrainLearnings(options);
  const {
    filePath = DEFAULT_LEARNINGS_FILE,
    maxBytes = DEFAULT_LEARNINGS_MAX_BYTES
  } = options;
  const limit = normalizeMaxBytes(maxBytes);
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      text: '',
      bytes: 0,
      maxBytes: limit,
      truncated: false,
      warning: null,
      omittedEntries: 0,
      filePath
    };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const budgeted = trimToBudget(raw, limit);
  return {
    ...budgeted,
    bytes: byteLength(budgeted.text),
    maxBytes: limit,
    filePath
  };
}

export function renderBrainLearningsBlock(options = {}) {
  if (shouldRenderCurated(options)) return renderCuratedBrainLearningsBlock(options);
  const learnings = loadBrainLearnings(options);
  const lines = [
    '## Brain Learnings',
    '',
    'Persistent operating memory for this run.'
  ];

  if (!learnings.text.trim()) {
    lines.push('');
    lines.push('- none');
  } else {
    lines.push('');
    lines.push(learnings.text.trimEnd());
  }

  return {
    ...learnings,
    markdown: `${lines.join('\n')}\n`
  };
}

function flattenContextValues(value, depth = 0, { includeTools = true } = {}) {
  if (depth > 3 || value == null) return [];
  if (typeof value === 'string' || typeof value === 'number') return [String(value)];
  if (Array.isArray(value)) return value.flatMap(item => flattenContextValues(item, depth + 1, { includeTools }));
  if (typeof value !== 'object') return [];

  const allowedKeys = [
    'alias', 'aliases', 'goal', 'key', 'keys', 'name', 'projectAlias',
    'projectAliases', 'projectKey', 'projectKeys', 'projectTitle',
    'projectTitles', 'projects', 'title', 'titles',
    ...(includeTools ? ['service', 'services', 'tool', 'tools', 'integration', 'integrations'] : [])
  ];
  return allowedKeys.flatMap(key => flattenContextValues(value[key], depth + 1, { includeTools }));
}

export function buildBrainLearningQuery({ query = '', context = null, ...contextFields } = {}) {
  const values = [query, ...flattenContextValues(context), ...flattenContextValues(contextFields)];
  return values.map(normalizeWhitespace).filter(Boolean).join(' ');
}

function buildBrainLearningLexicalQuery({ query = '', context = null, ...contextFields } = {}) {
  const values = [
    query,
    ...flattenContextValues(context, 0, { includeTools: false }),
    ...flattenContextValues(contextFields, 0, { includeTools: false })
  ];
  return values.map(normalizeWhitespace).filter(Boolean).join(' ');
}

export function tokenizeBrainLearningQuery(value) {
  const tokens = normalizeHashText(value).split(/[^\p{L}\p{N}]+/u);
  return [...new Set(tokens.filter(token => (
    token.length >= 3
    && !STOPWORDS.has(token)
    && !GENERIC_QUERY_TERMS.has(token)
  )))];
}

function tokenSet(value) {
  return new Set(tokenizeBrainLearningQuery(value));
}

function countMatches(queryTerms, value) {
  const candidates = tokenSet(value);
  let matches = 0;
  for (const term of queryTerms) {
    if (candidates.has(term)) matches++;
  }
  return matches;
}

function isGlobalScope(scope) {
  const normalized = normalizeHashText(scope);
  return !normalized || normalized === 'global' || normalized === 'all' || normalized === '*';
}

function isSafetyPrinciple(entry) {
  return entry?.category === 'principle';
}

function nowMilliseconds(now) {
  if (now instanceof Date) return now.getTime();
  if (typeof now === 'number' && Number.isFinite(now)) return now;
  const parsed = Date.parse(String(now || ''));
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

function entryAgeDays(entry, now) {
  const observed = Date.parse(entry?.observedAt || entry?.date || '');
  if (Number.isNaN(observed)) return 0;
  return Math.max(0, (nowMilliseconds(now) - observed) / 86400000);
}

function evaluateBrainLearning(entry, {
  query = '',
  context = null,
  now = new Date(),
  queryTerms: providedTerms = null,
  ...contextFields
} = {}) {
  const queryText = buildBrainLearningQuery({ query, context, ...contextFields });
  const queryTerms = providedTerms || tokenizeBrainLearningQuery(queryText);
  const lexicalTerms = tokenizeBrainLearningQuery(buildBrainLearningLexicalQuery({
    query,
    context,
    ...contextFields
  }));
  const scopeTerms = tokenSet(String(entry.scope || '').replace(/^project\s*:/i, ''));
  let scopeMatches = 0;
  for (const term of queryTerms) {
    if (scopeTerms.has(term)) scopeMatches++;
  }

  const globalScope = isGlobalScope(entry.scope);
  const scopeMismatch = !globalScope && scopeMatches === 0;
  const tagMatches = countMatches(lexicalTerms, (entry.tags || []).join(' '));
  const titleMatches = countMatches(lexicalTerms, entry.title);
  const textMatches = countMatches(lexicalTerms, entry.text);
  const evidenceMatches = countMatches(lexicalTerms, entry.evidence);
  const lexicalScore = (scopeMatches * 8) + (tagMatches * 4) + (titleMatches * 2) + (evidenceMatches * 2) + textMatches;
  const safetyPrinciple = isSafetyPrinciple(entry);
  const relevant = !scopeMismatch && (lexicalScore > 0 || safetyPrinciple);
  const ageDays = entryAgeDays(entry, now);
  const halfLifeDays = LEARNING_HALF_LIFE_DAYS[entry.volatility]
    || LEARNING_HALF_LIFE_DAYS.ephemeral;
  const ageRatio = safetyPrinciple ? 0 : ageDays / halfLifeDays;
  const agePenalty = safetyPrinciple ? 0 : 5 * Math.min(ageRatio, 2);
  const score = ((lexicalScore * 4) / (1 + ageRatio)) + (safetyPrinciple ? 2 : 0) - agePenalty;
  const quarantined = NEGATIVE_OUTCOMES.has(entry.outcome);
  const operational = !safetyPrinciple && entry.volatility !== 'principle';
  const cooldownDays = Number.isFinite(entry.cooldownDays)
    ? entry.cooldownDays
    : (LEARNING_REPROBE_COOLDOWN_DAYS[entry.volatility]
      ?? LEARNING_REPROBE_COOLDOWN_DAYS.ephemeral);
  const reprobeEligible = quarantined
    && operational
    && relevant
    && ageDays >= cooldownDays;

  return {
    entry,
    score,
    lexicalScore,
    relevant,
    scopeMismatch,
    safetyPrinciple,
    ageDays,
    ageRatio,
    agePenalty,
    quarantined,
    excludedReason: quarantined ? entry.outcome : (!relevant ? 'not_relevant' : null),
    operational,
    cooldownDays,
    reprobeEligible
  };
}

export function scoreBrainLearning(entry, options = {}, detail = null) {
  const evaluated = evaluateBrainLearning(entry, options);
  if (detail && typeof detail === 'object') Object.assign(detail, evaluated);
  return evaluated.score;
}

function compareRankedLearnings(a, b) {
  if (b.score !== a.score) return b.score - a.score;
  const aObserved = Date.parse(a.entry.observedAt || a.entry.date || '') || 0;
  const bObserved = Date.parse(b.entry.observedAt || b.entry.date || '') || 0;
  if (bObserved !== aObserved) return bObserved - aObserved;
  return a.entry.id < b.entry.id ? -1 : a.entry.id > b.entry.id ? 1 : 0;
}

export function rankBrainLearnings(entries, options = {}) {
  const queryText = buildBrainLearningQuery(options);
  const queryTerms = tokenizeBrainLearningQuery(queryText);
  return (entries || [])
    .map(entry => evaluateBrainLearning(entry, { ...options, queryTerms }))
    .filter(item => item.relevant && !item.quarantined)
    .sort(compareRankedLearnings);
}

function renderCuratedEntry(entry) {
  return [
    `## ${entry.date || 'undated'} ${entry.category}: ${entry.title}`,
    `Id: ${entry.id}`,
    `ContentHash: ${entry.contentHash}`,
    `Category: ${entry.category}`,
    `Scope: ${entry.scope}`,
    `Tags: ${entry.tags.length ? entry.tags.join(', ') : 'none'}`,
    `Volatility: ${entry.volatility}`,
    `Outcome: ${entry.outcome}`,
    `ObservedAt: ${entry.observedAt || 'unknown'}`,
    `Evidence: ${entry.evidence || 'not recorded'}`,
    `Text: ${entry.text}`
  ].join('\n');
}

function renderReprobeNotice(item) {
  const { entry } = item;
  return [
    `## Reprobe due: ${entry.title}`,
    `Id: ${entry.id}`,
    `Scope: ${entry.scope}`,
    `Tags: ${entry.tags.length ? entry.tags.join(', ') : 'none'}`,
    `PreviousOutcome: ${entry.outcome}`,
    `ObservedAt: ${entry.observedAt || 'unknown'}`,
    `CooldownDays: ${item.cooldownDays}`,
    'Instruction: This operational failure is quarantined and its cooldown has elapsed. Re-probe current behavior; do not treat the old failure as a prohibition or as current state.'
  ].join('\n');
}

function packCuratedItems(items, maxBytes) {
  const limit = normalizeMaxBytes(maxBytes);
  const kept = [];
  let text = '';
  let omittedEntries = 0;
  for (const item of items) {
    const separator = text ? '\n\n' : '';
    const candidate = `${text}${separator}${item.rendered}`;
    if (byteLength(candidate) <= limit) {
      text = candidate;
      kept.push(item);
      continue;
    }
    const compact = item.kind === 'learning'
      ? `- [${item.entry.id}] scope=${item.entry.scope}; volatility=${item.entry.volatility}; outcome=${item.entry.outcome}: ${item.entry.text}`
      : `- [${item.entry.id}] operational failure cooldown elapsed: re-probe current behavior; do not treat the old failure as current state.`;
    const compactCandidate = `${text}${separator}${compact}`;
    if (byteLength(compactCandidate) <= limit) {
      text = compactCandidate;
      kept.push({ ...item, rendered: compact });
      continue;
    }
    omittedEntries++;
  }

  let warning = null;
  if (omittedEntries > 0) {
    warning = `${omittedEntries} relevant brain learning(s) omitted by the ${limit}-byte budget.`;
    const renderedWarning = `> WARNING: ${warning}`;
    const candidate = text ? `${text}\n\n${renderedWarning}` : renderedWarning;
    if (byteLength(candidate) <= limit) text = candidate;
  }

  return {
    text,
    kept,
    truncated: omittedEntries > 0,
    warning,
    omittedEntries
  };
}

export function loadCuratedBrainLearnings({
  filePath = DEFAULT_LEARNINGS_FILE,
  maxBytes = DEFAULT_LEARNINGS_MAX_BYTES,
  query = '',
  context = null,
  now = new Date(),
  includeReprobeNotices = true,
  ...contextFields
} = {}) {
  const limit = normalizeMaxBytes(maxBytes);
  const base = {
    text: '',
    bytes: 0,
    maxBytes: limit,
    truncated: false,
    warning: null,
    omittedEntries: 0,
    filePath,
    query: buildBrainLearningQuery({ query, context, ...contextFields }),
    entries: [],
    rankedEntries: [],
    excludedEntries: [],
    reprobeEntries: []
  };
  if (!filePath || !fs.existsSync(filePath) || limit === 0) return base;

  const parsed = parseBrainLearnings(fs.readFileSync(filePath, 'utf8'));
  const options = { query, context, now, ...contextFields };
  const queryText = buildBrainLearningQuery(options);
  const queryTerms = tokenizeBrainLearningQuery(queryText);
  const evaluated = parsed.entries.map(entry => evaluateBrainLearning(entry, {
    ...options,
    queryTerms
  }));
  const rankedEntries = evaluated
    .filter(item => item.relevant && !item.quarantined)
    .sort(compareRankedLearnings);
  const excludedEntries = evaluated.filter(item => item.quarantined || !item.relevant);
  const reprobeEntries = evaluated
    .filter(item => item.reprobeEligible)
    .sort(compareRankedLearnings);
  const items = rankedEntries.map(item => ({
    ...item,
    kind: 'learning',
    rendered: renderCuratedEntry(item.entry)
  }));
  if (includeReprobeNotices) {
    items.push(...reprobeEntries.map(item => ({
      ...item,
      kind: 'reprobe',
      rendered: renderReprobeNotice(item)
    })));
  }

  const packed = packCuratedItems(items, limit);
  const entries = packed.kept
    .filter(item => item.kind === 'learning')
    .map(item => item.entry);
  return {
    ...base,
    ...packed,
    entries,
    rankedEntries,
    excludedEntries,
    reprobeEntries,
    bytes: byteLength(packed.text)
  };
}

export const loadCuratedLearnings = loadCuratedBrainLearnings;

export function renderCuratedBrainLearningsBlock(options = {}) {
  const maxBytes = normalizeMaxBytes(options.maxBytes);
  const prefix = [
    '## Brain Learnings',
    '',
    'Persistent operating memory curated for this context.',
    '',
    ''
  ].join('\n');
  const empty = '- none\n';
  const available = Math.max(0, maxBytes - byteLength(prefix));
  const learnings = loadCuratedBrainLearnings({ ...options, maxBytes: available });
  let markdown = learnings.text
    ? `${prefix}${learnings.text.trimEnd()}\n`
    : `${prefix}${empty}`;
  markdown = hardClipUtf8(markdown, maxBytes);

  return {
    ...learnings,
    contentBytes: learnings.bytes,
    bytes: byteLength(markdown),
    maxBytes,
    markdown
  };
}

export const renderCuratedLearningsBlock = renderCuratedBrainLearningsBlock;

function payloadValue(payload, lowerName, titleName) {
  return payload[lowerName] ?? payload[titleName];
}

function containsSecret(value) {
  const text = String(value || '');
  const secretPatterns = [
    /\b(password|passwd|pwd)\s*[:=]\s*["']?\S{4,}/i,
    /\b(api[_ -]?key|access[_ -]?token|auth[_ -]?token|client[_ -]?secret|secret|token)\s*[:=]\s*["']?\S{4,}/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]{8,}=*/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i,
    /\bAKIA[0-9A-Z]{16}\b/,
    /\bgh[pousr]_[A-Za-z0-9]{20,}\b/,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/,
    /\bAccountKey\s*=\s*[^;\s]+/i,
    /\b(?:https?|ssh):\/\/[^\s/:]+:[^\s/@]+@/i
  ];
  return secretPatterns.some(pattern => pattern.test(text));
}

export function validateLearningPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return 'LEARNING requires an object payload';
  }
  if (typeof payload.text !== 'string' || !payload.text.trim()) {
    return 'LEARNING requires text';
  }
  if (!LEARNING_CATEGORIES.has(payload.category)) {
    return 'LEARNING category must be principle, pattern, or fact';
  }
  if (typeof payload.evidence !== 'string' || !payload.evidence.trim()) {
    return 'LEARNING requires evidence';
  }

  const text = payload.text.trim();
  if (byteLength(text) > 1600) return 'LEARNING text is too long';
  if (byteLength(payload.evidence) > 500) return 'LEARNING evidence is too long';

  const scopeValue = payloadValue(payload, 'scope', 'Scope');
  if (scopeValue !== undefined
      && typeof scopeValue !== 'string'
      && !Array.isArray(scopeValue)) {
    return 'LEARNING scope must be a string or array of strings';
  }
  if (Array.isArray(scopeValue) && scopeValue.some(item => typeof item !== 'string')) {
    return 'LEARNING scope must contain only strings';
  }

  const tagsValue = payloadValue(payload, 'tags', 'Tags');
  if (tagsValue !== undefined
      && typeof tagsValue !== 'string'
      && !Array.isArray(tagsValue)) {
    return 'LEARNING tags must be a string or array of strings';
  }
  if (Array.isArray(tagsValue) && tagsValue.some(item => typeof item !== 'string')) {
    return 'LEARNING tags must contain only strings';
  }

  const volatilityValue = payloadValue(payload, 'volatility', 'Volatility');
  if (volatilityValue !== undefined) {
    const normalized = normalizeVolatilityName(volatilityValue);
    if (!LEARNING_VOLATILITIES.has(normalized)) {
      return 'LEARNING volatility is invalid';
    }
  }

  const outcomeValue = payloadValue(payload, 'outcome', 'Outcome');
  if (outcomeValue !== undefined) {
    const normalized = normalizeHashText(outcomeValue).replace(/[\s-]+/g, '_');
    if (!LEARNING_OUTCOMES.has(normalized)) return 'LEARNING outcome is invalid';
  }

  const observedAtValue = payloadValue(payload, 'observedAt', 'ObservedAt');
  if (observedAtValue !== undefined && Number.isNaN(Date.parse(String(observedAtValue)))) {
    return 'LEARNING observedAt must be a valid date';
  }

  const valuesToInspect = [
    payload.text,
    payload.evidence,
    scopeValue,
    tagsValue,
    volatilityValue,
    outcomeValue
  ].flat(Infinity);
  if (valuesToInspect.some(containsSecret)) {
    return 'LEARNING must not contain secrets or credentials';
  }

  const taskFactPatterns = [
    /\b(task|src|li)-[0-9A-Za-z_.-]{4,}\b/,
    /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i,
    /\bsourceRefs?\b/i,
    /\blineItems?\b/i,
    /\bpmStatus\b/,
    /\bprojectKey\b/
  ];
  if (taskFactPatterns.some(pattern => pattern.test(text))) {
    return 'LEARNING must be general knowledge, not task state or task identifiers';
  }

  return null;
}

function learningSlug(text) {
  return normalizeWhitespace(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'learning';
}

export function appendBrainLearning(payload, {
  filePath = DEFAULT_LEARNINGS_FILE,
  now = new Date()
} = {}) {
  const error = validateLearningPayload(payload);
  if (error) return { ok: false, reason: error };

  const text = normalizeWhitespace(payload.text);
  const evidence = normalizeWhitespace(payload.evidence);
  const scope = normalizeScope(payloadValue(payload, 'scope', 'Scope') || 'global');
  const tags = normalizeTags(payloadValue(payload, 'tags', 'Tags'));
  const volatility = normalizeVolatility(
    payloadValue(payload, 'volatility', 'Volatility'),
    payload.category
  );
  const outcome = normalizeOutcome(payloadValue(payload, 'outcome', 'Outcome'));
  const nowDate = now instanceof Date ? now : new Date(now || Date.now());
  const nowIso = Number.isNaN(nowDate.getTime()) ? new Date().toISOString() : nowDate.toISOString();
  const observedAt = isoValue(payloadValue(payload, 'observedAt', 'ObservedAt'), nowIso);
  const contentHash = computeLearningContentHash({
    category: payload.category,
    text,
    tags
  });
  const id = `lw-${contentHash}`;
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const parsed = parseBrainLearnings(existing);
  const normalizedText = normalizeHashText(text);
  const duplicateEntry = parsed.entries.find(entry => (
    entry.contentHash === contentHash
    || normalizeHashText(entry.text) === normalizedText
  ));
  if (duplicateEntry) {
    return {
      ok: true,
      appended: false,
      duplicate: true,
      id: duplicateEntry.id,
      contentHash: duplicateEntry.contentHash,
      filePath
    };
  }

  const date = observedAt.slice(0, 10);
  const lines = [
    `## ${date} ${payload.category}: ${learningSlug(text)}`,
    `Id: ${id}`,
    `ContentHash: ${contentHash}`,
    `Category: ${payload.category}`,
    `Scope: ${scope}`,
    `Tags: ${tags.length ? tags.join(', ') : 'none'}`,
    `Volatility: ${volatility}`,
    `Outcome: ${outcome}`,
    `ObservedAt: ${observedAt}`,
    `Evidence: ${evidence}`,
    `Text: ${text}`
  ];
  const cooldownDays = parseCooldownDays(payload.cooldownDays ?? payload.CooldownDays);
  if (Number.isFinite(cooldownDays)) lines.splice(9, 0, `CooldownDays: ${cooldownDays}`);
  const separator = existing && !existing.endsWith('\n\n')
    ? (existing.endsWith('\n') ? '\n' : '\n\n')
    : '';
  const entry = `${separator}${lines.join('\n')}\n`;

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, entry, 'utf8');
  return {
    ok: true,
    appended: true,
    duplicate: false,
    id,
    contentHash,
    filePath
  };
}
