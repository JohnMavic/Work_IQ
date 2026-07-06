import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonFileAtomic } from '../brain/tasks-v5.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

const DEFAULT_TASKS_FILE = path.join(REPO_ROOT, 'tasks.json');

const REPLACEMENTS = [
  [/Nutzer-Aktion nötig/g, 'Your action required'],
  [/Du musst aktiv werden/g, 'Your action required'],
  [/Stand heute/g, 'Status today'],
  [/Warten auf/g, 'Waiting on'],
  [/Von dir erledigt/g, 'Marked done by you'],
  [/von dir erledigt am/g, 'Marked done by you on'],
  [/Bestätigung ausstehend/g, 'awaiting confirmation'],
  [/als erledigt markiert, neue Signale zeigen offen/g, 'marked done; new signals show it is open'],
  [/Nächste Schritte/g, 'Next steps'],
  [/Bisheriger Verlauf/g, 'History'],
  [/Geplant/g, 'Planned'],
  [/Probleme/g, 'Problems'],
  [/Risiken/g, 'Risks'],
  [/\bOwner:\s*Du\b/g, 'Owner: You']
];

const RESIDUAL_GERMAN = /[äöüÄÖÜß]|\b(Nutzer|erledigt|abgeschlossen|wartet|fehlt|klären|prüfen|Bestätigung|ausstehend|heute|bisher|nächste|Schritte)\b/i;

function parseArgs(argv) {
  const args = {
    apply: false,
    tasksFile: DEFAULT_TASKS_FILE
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--apply') args.apply = true;
    else if (arg === '--tasks') args.tasksFile = path.resolve(argv[++i]);
    else if (arg === '--help') {
      console.log('Usage: node scripts/translate-generated-english.mjs [--apply] [--tasks tasks.json]');
      process.exit(0);
    }
  }
  return args;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isActiveTask(task) {
  return !(task?.archived || task?.supersededBy || task?.status === 'done');
}

function translateText(value) {
  let next = value;
  for (const [pattern, replacement] of REPLACEMENTS) {
    next = next.replace(pattern, replacement);
  }
  return next;
}

function shouldSkipKey(key) {
  return ['sourceRefs', 'communications', 'additionalLinks', 'link', 'url', 'evidenceText', 'from', 'to', 'source'].includes(key);
}

function walkGenerated(value, pathParts, changes, residuals) {
  if (value === null || value === undefined) return value;
  const pathText = pathParts.join('.');

  if (typeof value === 'string') {
    const next = translateText(value);
    if (next !== value) changes.push({ path: pathText, before: value, after: next });
    if (RESIDUAL_GERMAN.test(next)) residuals.push({ path: pathText, value: next.slice(0, 240) });
    return next;
  }

  if (Array.isArray(value)) {
    return value.map((item, index) => walkGenerated(item, [...pathParts, `[${index}]`], changes, residuals));
  }

  if (typeof value === 'object') {
    const next = { ...value };
    for (const [key, child] of Object.entries(value)) {
      if (shouldSkipKey(key)) continue;
      if (pathText.endsWith('factSheet.sections') && key === 'sources') continue;
      next[key] = walkGenerated(child, [...pathParts, key], changes, residuals);
    }
    return next;
  }

  return value;
}

function processTasks(data) {
  const changes = [];
  const residuals = [];
  const next = structuredClone(data);

  next.tasks = normalizeArray(next.tasks).map((task, taskIndex) => {
    if (!isActiveTask(task)) return task;
    const updated = { ...task };
    for (const key of ['title', 'summary', 'notes', 'pmStatus', 'lineItems', 'factSheet', 'brainState', 'ambiguities']) {
      updated[key] = walkGenerated(updated[key], ['tasks', `[${taskIndex}]`, key], changes, residuals);
    }
    updated.history = normalizeArray(updated.history).map((entry, historyIndex) => walkGenerated(
      entry,
      ['tasks', `[${taskIndex}]`, 'history', `[${historyIndex}]`],
      changes,
      residuals
    ));
    return updated;
  });

  next.reviewQueue = normalizeArray(next.reviewQueue).map((entry, index) => walkGenerated(
    entry,
    ['reviewQueue', `[${index}]`],
    changes,
    residuals
  ));

  return { data: next, changes, residuals };
}

const args = parseArgs(process.argv.slice(2));
const before = JSON.parse(fs.readFileSync(args.tasksFile, 'utf8'));
const result = processTasks(before);

if (args.apply && result.changes.length > 0) {
  writeJsonFileAtomic(args.tasksFile, result.data);
}

console.log(JSON.stringify({
  tasksFile: args.tasksFile,
  apply: args.apply,
  changed: result.changes.length,
  wrote: Boolean(args.apply && result.changes.length > 0),
  residualGermanHits: result.residuals.length,
  changes: result.changes.slice(0, 50),
  residuals: result.residuals.slice(0, 50)
}, null, 2));
