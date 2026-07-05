#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrateToV5, V5_BRAIN_STATE_DEFAULTS, writeJsonFileAtomic } from '../brain/tasks-v5.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, '..');

export const DEFAULT_TASKS_FILE = path.join(REPO_ROOT, 'tasks.json');

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function nowIso(now) {
  return now instanceof Date ? now.toISOString() : String(now || new Date().toISOString());
}

export function isValidSourceLink(link) {
  return typeof link === 'string' && /^https?:\/\//i.test(link.trim()) && !link.includes('...');
}

function normalizeTitle(value) {
  return String(value || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function titleTokens(value) {
  return new Set(normalizeTitle(value).split(' ').filter(token => token.length > 2));
}

function titleSimilarity(a, b) {
  const aNorm = normalizeTitle(a);
  const bNorm = normalizeTitle(b);
  if (!aNorm || !bNorm) return 0;
  if (aNorm === bNorm) return 1;
  if (aNorm.includes(bNorm) || bNorm.includes(aNorm)) return 0.92;
  const aTokens = titleTokens(aNorm);
  const bTokens = titleTokens(bNorm);
  if (!aTokens.size || !bTokens.size) return 0;
  const shared = [...aTokens].filter(token => bTokens.has(token)).length;
  return shared / Math.max(aTokens.size, bTokens.size);
}

function addCandidate(candidates, link, source) {
  if (!isValidSourceLink(link)) return;
  const normalized = link.trim();
  if (candidates.some(candidate => candidate.link === normalized)) return;
  candidates.push({ link: normalized, ...source });
}

function collectTaskLinkCandidates(task) {
  const candidates = [];
  addCandidate(candidates, task?.link, { field: 'link', taskId: task?.id, title: task?.title || '' });

  for (const entry of normalizeArray(task?.additionalLinks)) {
    const link = typeof entry === 'string' ? entry : entry?.url || entry?.link;
    addCandidate(candidates, link, {
      field: 'additionalLinks',
      taskId: task?.id,
      title: entry?.title || task?.title || '',
      from: entry?.from || null
    });
  }

  for (const ref of normalizeArray(task?.sourceRefs)) {
    addCandidate(candidates, ref?.link || ref?.url, {
      field: 'sourceRefs',
      taskId: task?.id,
      sourceRefId: ref?.id || null,
      title: ref?.title || task?.title || '',
      from: ref?.from || null
    });
  }

  return candidates;
}

function duplicateMismatchRefIds(refs) {
  const ids = new Set();
  const byLink = new Map();
  for (const ref of refs) {
    if (!ref?.link) continue;
    const group = byLink.get(ref.link) || [];
    group.push(ref);
    byLink.set(ref.link, group);
  }
  for (const group of byLink.values()) {
    if (group.length < 2) continue;
    const titles = new Set(group.map(ref => normalizeTitle(ref.title)).filter(Boolean));
    if (titles.size > 1) {
      for (const ref of group) ids.add(ref.id);
    }
  }
  return ids;
}

function evidenceSourceTaskIds(task, refId) {
  const ids = [];
  for (const item of normalizeArray(task?.lineItems)) {
    const evidenceIds = normalizeArray(item?.evidenceRefIds);
    const sourceTaskIds = normalizeArray(item?.sourceTaskIds);
    const index = evidenceIds.indexOf(refId);
    if (index === -1) continue;
    if (sourceTaskIds[index]) ids.push(sourceTaskIds[index]);
    else ids.push(...sourceTaskIds);
  }
  return ids;
}

function candidateSourceTaskIds(task, ref) {
  const ids = [];
  if (ref?.sourceTaskId) ids.push(ref.sourceTaskId);
  if (typeof ref?.id === 'string' && ref.id.startsWith('src-')) ids.push(ref.id.slice(4));
  ids.push(...evidenceSourceTaskIds(task, ref?.id));
  return [...new Set(ids.filter(Boolean).map(String))];
}

function findSourceTaskById(rawIds, sourceTasks, allTasksById) {
  for (const rawId of rawIds) {
    if (allTasksById.has(rawId)) return allTasksById.get(rawId);
    if (rawId.length >= 6) {
      const projectMatch = sourceTasks.find(task => task?.id?.startsWith(rawId));
      if (projectMatch) return projectMatch;
      const globalMatch = [...allTasksById.values()].find(task => task?.id?.startsWith(rawId));
      if (globalMatch) return globalMatch;
    }
  }
  return null;
}

function preferredLinkForSourceTask(sourceTask) {
  const candidates = collectTaskLinkCandidates(sourceTask);
  const primary = candidates.find(candidate => candidate.field === 'link');
  return primary || candidates[0] || null;
}

function findSourceTaskByTitle(ref, sourceTasks) {
  let best = null;
  for (const sourceTask of sourceTasks) {
    const score = titleSimilarity(ref?.title, sourceTask?.title);
    if (!best || score > best.score) best = { task: sourceTask, score };
  }
  return best && best.score >= 0.75 ? best : null;
}

function reconstructSourceLink(task, ref, sourceTasks, allTasksById) {
  const rawIds = candidateSourceTaskIds(task, ref);
  const byId = findSourceTaskById(rawIds, sourceTasks, allTasksById);
  if (byId) {
    const candidate = preferredLinkForSourceTask(byId);
    if (candidate) return { ...candidate, method: 'sourceTaskId' };
  }

  const byTitle = findSourceTaskByTitle(ref, sourceTasks);
  if (byTitle) {
    const candidate = preferredLinkForSourceTask(byTitle.task);
    if (candidate) return { ...candidate, method: 'title', score: byTitle.score };
  }

  return null;
}

function setNeedsReview(task, unresolvedIds, now) {
  const reason = `Source link repair could not reconstruct ${unresolvedIds.length} sourceRef link(s): ${unresolvedIds.join(', ')}`;
  task.brainState = { ...V5_BRAIN_STATE_DEFAULTS, ...(task.brainState || {}) };
  task.brainState.needsReview = true;
  task.brainState.reviewReason = task.brainState.reviewReason
    ? `${task.brainState.reviewReason} | ${reason}`
    : reason;
  task.updatedAt = nowIso(now);
}

function uniqueValidSourceLinks(sourceRefs) {
  return [...new Set(normalizeArray(sourceRefs).map(ref => ref?.link).filter(isValidSourceLink))];
}

function refreshTaskLinks(task) {
  const links = uniqueValidSourceLinks(task.sourceRefs);
  if (links.length) {
    if (!isValidSourceLink(task.link)) task.link = links[0];
    task.additionalLinks = links;
    return;
  }
  if (!isValidSourceLink(task.link)) task.link = null;
  task.additionalLinks = [];
}

export function repairSourceLinks(inputData, { now = new Date() } = {}) {
  const data = migrateToV5(inputData);
  const allTasksById = new Map(normalizeArray(data.tasks).map(task => [task.id, task]));
  const repairedRefs = [];
  const unresolvedRefs = [];
  const changedTaskIds = new Set();
  const issueKeys = new Set();
  const repairedKeys = new Set();
  const unresolvedKeys = new Set();
  const checkedRefs = normalizeArray(data.tasks)
    .reduce((sum, task) => sum + normalizeArray(task.sourceRefs).length, 0);

  for (let pass = 0; pass < 5; pass++) {
    let changedThisPass = false;

    for (const task of normalizeArray(data.tasks)) {
      const refs = normalizeArray(task.sourceRefs);
      if (!refs.length) continue;

      const duplicateIds = duplicateMismatchRefIds(refs);
      const sourceTasks = normalizeArray(task.supersedesTaskIds)
        .map(id => allTasksById.get(id))
        .filter(Boolean);
      const unresolvedForTask = [];
      let taskChanged = false;

      for (const ref of refs) {
        const invalid = !isValidSourceLink(ref?.link);
        const duplicate = duplicateIds.has(ref?.id);
        if (!invalid && !duplicate) continue;

        const before = ref.link ?? null;
        const reconstructed = reconstructSourceLink(task, ref, sourceTasks, allTasksById);
        if (duplicate && !invalid && reconstructed?.link === before) continue;

        const key = `${task.id}:${ref.id || '(missing-id)'}`;
        issueKeys.add(key);

        if (reconstructed?.link) {
          if (ref.link !== reconstructed.link) {
            ref.link = reconstructed.link;
            if (!repairedKeys.has(key)) {
              repairedRefs.push({
                taskId: task.id,
                sourceRefId: ref.id || null,
                before,
                after: ref.link,
                method: reconstructed.method,
                sourceTaskId: reconstructed.taskId || null
              });
              repairedKeys.add(key);
            }
            taskChanged = true;
            changedThisPass = true;
            changedTaskIds.add(task.id);
          }
        } else {
          if (ref.link !== null) {
            ref.link = null;
            taskChanged = true;
            changedThisPass = true;
            changedTaskIds.add(task.id);
          }
          if (!unresolvedKeys.has(key)) {
            unresolvedForTask.push(ref.id || '(missing-id)');
            unresolvedRefs.push({
              taskId: task.id,
              sourceRefId: ref.id || null,
              before,
              title: ref.title || ''
            });
            unresolvedKeys.add(key);
          }
        }
      }

      if (taskChanged) {
        refreshTaskLinks(task);
        task.updatedAt = nowIso(now);
      }
      if (unresolvedForTask.length) setNeedsReview(task, unresolvedForTask, now);
    }

    if (!changedThisPass) break;
  }

  return {
    data,
    summary: {
      checkedRefs,
      issueRefs: issueKeys.size,
      repaired: repairedRefs.length,
      unresolved: unresolvedRefs.length,
      changedTasks: changedTaskIds.size
    },
    repairedRefs,
    unresolvedRefs,
    changedTaskIds: [...changedTaskIds]
  };
}

export function runRepairSourceLinks({
  tasksFile = DEFAULT_TASKS_FILE,
  apply = false,
  now = new Date(),
  _readJsonFile = readJsonFile,
  _writeJsonFileAtomic = writeJsonFileAtomic
} = {}) {
  const before = migrateToV5(_readJsonFile(tasksFile));
  const result = repairSourceLinks(before, { now });

  if (apply) _writeJsonFileAtomic(tasksFile, result.data);

  return {
    mode: apply ? 'apply' : 'dry-run',
    tasksFile,
    wrote: Boolean(apply),
    ...result
  };
}

function parseArgs(argv) {
  const options = { apply: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--dry-run') {
      options.apply = false;
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--tasks-file') {
      options.tasksFile = argv[++i];
    } else if (arg === '--help' || arg === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log([
    'Usage: node scripts/repair-source-links.mjs [--dry-run|--apply] [--tasks-file <path>]',
    '',
    'Repairs project sourceRef links from superseded archived source tasks.',
    'Default mode is --dry-run. Use --apply to write tasks.json atomically with backup rotation.'
  ].join('\n'));
}

function printResult(result) {
  const preview = {
    mode: result.mode,
    wrote: result.wrote,
    summary: result.summary,
    changedTaskIds: result.changedTaskIds,
    unresolvedRefs: result.unresolvedRefs,
    repairedSample: result.repairedRefs.slice(0, 10)
  };
  console.log(JSON.stringify(preview, null, 2));
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      printHelp();
      process.exit(0);
    }
    const result = runRepairSourceLinks(options);
    printResult(result);
    process.exit(result.summary.unresolved ? 2 : 0);
  } catch (err) {
    console.error(err?.stack || err?.message || String(err));
    process.exit(1);
  }
}
