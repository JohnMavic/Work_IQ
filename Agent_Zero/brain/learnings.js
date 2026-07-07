import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_LEARNINGS_FILE = path.join(REPO_ROOT, 'brain-learnings.md');
export const DEFAULT_LEARNINGS_MAX_BYTES = 8 * 1024;
export const LEARNING_CATEGORIES = new Set(['principle', 'pattern', 'fact']);

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function normalizeWhitespace(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(text) {
  return String(text || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function splitLearningEntries(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const firstEntryIndex = lines.findIndex(line => /^##\s+/.test(line));
  if (firstEntryIndex < 0) {
    return {
      preamble: String(text || '').trimEnd(),
      entries: []
    };
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
  if (byteLength(text) <= maxBytes) {
    return { text, truncated: false, warning: null, omittedEntries: 0 };
  }

  const { preamble, entries } = splitLearningEntries(text);
  if (!entries.length) {
    const warning = `Brain learnings exceeded ${maxBytes} bytes and were hard-truncated.`;
    let trimmed = String(text || '');
    while (byteLength(trimmed) > maxBytes && trimmed.length > 0) {
      trimmed = trimmed.slice(Math.max(1, Math.ceil(trimmed.length * 0.1)));
    }
    return {
      text: `${warning}\n\n${trimmed.trimStart()}`,
      truncated: true,
      warning,
      omittedEntries: 0
    };
  }

  const kept = [...entries];
  let omittedEntries = 0;
  let warning = `Brain learnings exceeded ${maxBytes} bytes; oldest entries were omitted from this run.`;
  let candidate = joinLearningEntries(preamble, kept, warning);
  while (kept.length > 1 && byteLength(candidate) > maxBytes) {
    kept.shift();
    omittedEntries++;
    candidate = joinLearningEntries(preamble, kept, warning);
  }

  if (byteLength(candidate) <= maxBytes) {
    return {
      text: candidate,
      truncated: true,
      warning,
      omittedEntries
    };
  }

  const newest = kept.at(-1) || '';
  warning = `Brain learnings exceeded ${maxBytes} bytes; oldest entries and part of the newest entry were omitted from this run.`;
  const prefix = joinLearningEntries(preamble, [], warning);
  const remainingBytes = Math.max(0, maxBytes - byteLength(prefix) - byteLength('\n'));
  let trimmed = newest;
  while (byteLength(trimmed) > remainingBytes && trimmed.length > 0) {
    trimmed = trimmed.slice(Math.max(1, Math.ceil(trimmed.length * 0.1)));
  }
  return {
    text: `${prefix}\n${trimmed.trimStart()}`,
    truncated: true,
    warning,
    omittedEntries: Math.max(omittedEntries, entries.length - 1)
  };
}

export function loadBrainLearnings({
  filePath = DEFAULT_LEARNINGS_FILE,
  maxBytes = DEFAULT_LEARNINGS_MAX_BYTES
} = {}) {
  if (!filePath || !fs.existsSync(filePath)) {
    return {
      text: '',
      bytes: 0,
      maxBytes,
      truncated: false,
      warning: null,
      omittedEntries: 0,
      filePath
    };
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  const budgeted = trimToBudget(raw, maxBytes);
  return {
    ...budgeted,
    bytes: byteLength(budgeted.text),
    maxBytes,
    filePath
  };
}

export function renderBrainLearningsBlock(options = {}) {
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

  const secretPatterns = [
    /\b(password|passwd|pwd)\s*[:=]\s*\S+/i,
    /\b(api[_-]?key|token|secret|client[_-]?secret)\s*[:=]\s*\S+/i,
    /\bBearer\s+[A-Za-z0-9._~+/-]+=*/i,
    /-----BEGIN [A-Z ]*PRIVATE KEY-----/i
  ];
  if (secretPatterns.some(pattern => pattern.test(text) || pattern.test(payload.evidence))) {
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
  const existing = fs.existsSync(filePath) ? fs.readFileSync(filePath, 'utf8') : '';
  const duplicatePattern = new RegExp(`Text:\\s+${escapeRegExp(text)}(?:\\r?\\n|$)`, 'i');
  if (duplicatePattern.test(existing)) {
    return { ok: true, appended: false, duplicate: true, filePath };
  }

  const date = (now instanceof Date ? now.toISOString() : String(now || new Date().toISOString())).slice(0, 10);
  const entry = [
    '',
    `## ${date} ${payload.category}: ${learningSlug(text)}`,
    `Category: ${payload.category}`,
    `Evidence: ${evidence}`,
    `Text: ${text}`,
    ''
  ].join('\n');

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, entry, 'utf8');
  return { ok: true, appended: true, duplicate: false, filePath };
}
