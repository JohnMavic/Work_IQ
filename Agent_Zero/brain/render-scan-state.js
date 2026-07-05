import fs from 'node:fs';
import path from 'node:path';
import { BRAIN_WORK_DIR } from './agency-cli.js';
import { prepareBrainWorkDir } from './brain-runner.js';
import { migrateToV5 } from './tasks-v5.js';

export const DEFAULT_STATE_MAX_BYTES = 24 * 1024;
export const DEFAULT_HISTORY_SPILL_BYTES = 1600;

function bytes(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

function truncate(text, maxChars) {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (maxChars <= 0) return '';
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 1)).trimEnd()}...`;
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function isArchived(task) {
  return Boolean(task.archived || task.supersededBy);
}

function isProject(task) {
  return task.taskType === 'project';
}

function isSingle(task) {
  return !isProject(task);
}

function safeFilePart(value) {
  return String(value || 'task')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 80) || 'task';
}

function latestEvidenceForLineItem(task, lineItem) {
  const refs = normalizeArray(task.sourceRefs);
  const evidenceRefs = normalizeArray(lineItem.evidenceRefIds)
    .map(id => refs.find(ref => ref.id === id))
    .filter(Boolean);
  const ref = evidenceRefs[0] || refs[0] || null;
  if (!ref) return 'none';
  const parts = [ref.id];
  if (ref.date) parts.push(ref.date.slice(0, 10));
  if (ref.from) parts.push(`from=${truncate(ref.from, 48)}`);
  if (ref.title) parts.push(`title=${truncate(ref.title, 64)}`);
  return parts.join(' | ');
}

function renderSourceRefs(task, lines) {
  const refs = normalizeArray(task.sourceRefs);
  const refLines = refs.slice(0, 6).map(ref => {
    const parts = [ref.id || 'src?'];
    if (ref.date) parts.push(`date=${String(ref.date).slice(0, 10)}`);
    if (ref.from) parts.push(`from=${truncate(ref.from, 48)}`);
    if (ref.title) parts.push(`title=${truncate(ref.title, 80)}`);
    return parts.join(' ');
  });
  if (refLines.length) lines.push(`  sourceRefs: ${refLines.join(' | ')}`);
  const hidden = refs.length - refLines.length;
  if (hidden > 0) lines.push(`  sourceRefs omitted: ${hidden}`);
  if (!refs.length && task.link) lines.push('  legacyLink: present; link omitted, reference this existing task by task id');
}

function writeJsonSpill({ brainWorkDir, filename, title, value, spillFiles }) {
  fs.writeFileSync(path.join(brainWorkDir, filename), `${title}\n\n${JSON.stringify(value, null, 2)}\n`, 'utf8');
  spillFiles.push(filename);
  return filename;
}

function renderPmStatus(task, lines, { brainWorkDir, runId, spillFiles, writeFiles, pmStatusMode }) {
  if (!task.pmStatus) return;
  if (writeFiles && pmStatusMode === 'spill') {
    const filename = `pmstatus-${safeFilePart(task.id)}-${safeFilePart(runId)}.md`;
    const spill = writeJsonSpill({
      brainWorkDir,
      filename,
      title: `# Full pmStatus for ${task.id}`,
      value: task.pmStatus,
      spillFiles
    });
    lines.push(`  pmStatus spill: ${spill}`);
    if (task.pmStatus.current) lines.push(`  PM current: ${truncate(task.pmStatus.current, 180)}`);
    return;
  }
  lines.push(`  pmStatus: ${JSON.stringify(task.pmStatus)}`);
}

function renderHistorySpill(task, { brainWorkDir, runId, historySpillBytes, spillFiles, writeFiles }) {
  const history = normalizeArray(task.history);
  if (!history.length) return null;
  const rendered = history
    .map(entry => `- [${entry.timestamp || '?'}] ${entry.type || 'note'}: ${entry.text || ''}`)
    .join('\n');
  if (bytes(rendered) <= historySpillBytes) return null;
  if (!writeFiles) return null;

  const filename = `history-${safeFilePart(task.id)}-${safeFilePart(runId)}.md`;
  fs.writeFileSync(path.join(brainWorkDir, filename), `# History for ${task.id}\n\n${rendered}\n`, 'utf8');
  spillFiles.push(filename);
  return filename;
}

function renderHiddenLineItems(task, hiddenItems, lines, { brainWorkDir, runId, spillFiles, writeFiles }) {
  if (!hiddenItems.length) return;
  if (writeFiles) {
    const filename = `lineitems-${safeFilePart(task.id)}-${safeFilePart(runId)}.md`;
    const spill = writeJsonSpill({
      brainWorkDir,
      filename,
      title: `# Full omitted lineItems for ${task.id}`,
      value: hiddenItems,
      spillFiles
    });
    lines.push(`  lineItems spill: ${spill} (${hiddenItems.length} omitted)`);
    return;
  }
  lines.push(`  omitted lineItem IDs: ${hiddenItems.map(item => item.id).filter(Boolean).join(', ')}`);
}

function buildMarkdown(data, options) {
  const {
    summaryChars,
    lineItemLimit,
    includePmStatus,
    pmStatusMode,
    brainWorkDir,
    runId,
    historySpillBytes,
    spillFiles,
    writeFiles,
    now
  } = options;

  const tasks = normalizeArray(data.tasks);
  const openProjects = tasks.filter(task => !isArchived(task) && isProject(task));
  const openSingles = tasks.filter(task => !isArchived(task) && isSingle(task));
  const archivedIds = tasks.filter(isArchived).map(task => task.id);
  const lines = [];

  lines.push('# Agent Zero Scan State');
  lines.push('');
  lines.push(`Rendered: ${now}`);
  lines.push(`Last scan anchor: ${data.lastScan || 'none'}`);
  lines.push(`Open projects: ${openProjects.length}`);
  lines.push(`Open single tasks: ${openSingles.length}`);
  lines.push(`Archived/superseded IDs: ${archivedIds.length ? archivedIds.join(', ') : 'none'}`);
  lines.push('');
  lines.push('Read referenced spill files from the current working directory only when needed.');
  lines.push('');

  lines.push('## Open Projects');
  if (!openProjects.length) lines.push('- none');
  for (const task of openProjects) {
    lines.push(`- [${task.id}] ${truncate(task.title, 160)} | status=${task.status || 'new'} | key=${task.projectKey || 'n/a'}`);
    renderSourceRefs(task, lines);
    if (task.summary && summaryChars > 0) lines.push(`  summary: ${truncate(task.summary, summaryChars)}`);
    if (includePmStatus) renderPmStatus(task, lines, { brainWorkDir, runId, spillFiles, writeFiles, pmStatusMode });
    const spill = renderHistorySpill(task, { brainWorkDir, runId, historySpillBytes, spillFiles, writeFiles });
    if (spill) lines.push(`  history spill: ${spill}`);
    const allLineItems = normalizeArray(task.lineItems);
    const lineItems = allLineItems.slice(0, lineItemLimit);
    if (!lineItems.length) lines.push('  lineItems: none');
    for (const item of lineItems) {
      lines.push(`  - (${item.id}) ${truncate(item.title, 120)} | status=${item.status || 'open'} | state=${truncate(item.currentState || '', 100)} | evidence=${latestEvidenceForLineItem(task, item)}`);
    }
    renderHiddenLineItems(task, allLineItems.slice(lineItems.length), lines, { brainWorkDir, runId, spillFiles, writeFiles });
  }
  lines.push('');

  lines.push('## Open Single Tasks');
  if (!openSingles.length) lines.push('- none');
  for (const task of openSingles) {
    const summary = summaryChars > 0 ? truncate(task.summary, summaryChars) : '';
    const hasSourceLink = Boolean(task.link || normalizeArray(task.sourceRefs).find(ref => ref.link));
    lines.push(`- [${task.id}] ${truncate(task.title, 160)} | status=${task.status || 'new'} | sourceLink=${hasSourceLink ? 'present-omitted' : 'none'}`);
    renderSourceRefs(task, lines);
    if (summary) lines.push(`  summary: ${summary}`);
    const spill = renderHistorySpill(task, { brainWorkDir, runId, historySpillBytes, spillFiles, writeFiles });
    if (spill) lines.push(`  history spill: ${spill}`);
  }
  lines.push('');

  lines.push('## Review Queue');
  const reviewQueue = normalizeArray(data.reviewQueue);
  if (!reviewQueue.length) lines.push('- none');
  for (const item of reviewQueue.slice(0, 20)) {
    lines.push(`- ${item.kind || 'other'} ${item.ref || 'root'}: ${truncate(item.question, 160)}`);
  }

  return `${lines.join('\n')}\n`;
}

export function renderScanState(inputData, {
  brainWorkDir = BRAIN_WORK_DIR,
  runId = `run-${Date.now()}`,
  maxBytes = DEFAULT_STATE_MAX_BYTES,
  historySpillBytes = DEFAULT_HISTORY_SPILL_BYTES,
  writeFiles = true,
  now = new Date().toISOString()
} = {}) {
  const data = migrateToV5(inputData);
  const resolvedBrainWorkDir = writeFiles ? prepareBrainWorkDir(brainWorkDir) : brainWorkDir;
  if (writeFiles) fs.mkdirSync(resolvedBrainWorkDir, { recursive: true });

  const attempts = [
    { summaryChars: 180, lineItemLimit: 12, includePmStatus: true, pmStatusMode: 'inline' },
    { summaryChars: 100, lineItemLimit: 8, includePmStatus: true, pmStatusMode: 'spill' },
    { summaryChars: 60, lineItemLimit: 5, includePmStatus: true, pmStatusMode: 'spill' },
    { summaryChars: 0, lineItemLimit: 3, includePmStatus: true, pmStatusMode: 'spill' }
  ];

  let markdown = '';
  let spillFiles = [];
  let selectedAttempt = attempts.at(-1);
  for (const attempt of attempts) {
    spillFiles = [];
    markdown = buildMarkdown(data, {
      ...attempt,
      brainWorkDir: resolvedBrainWorkDir,
      runId,
      historySpillBytes,
      spillFiles,
      writeFiles,
      now
    });
    selectedAttempt = attempt;
    if (bytes(markdown) <= maxBytes) break;
  }

  const stateFile = writeFiles ? path.join(resolvedBrainWorkDir, `scan-state-${safeFilePart(runId)}.md`) : null;
  if (writeFiles) fs.writeFileSync(stateFile, markdown, 'utf8');

  return {
    markdown,
    stateFile,
    spillFiles,
    bytes: bytes(markdown),
    maxBytes,
    truncated: bytes(markdown) > maxBytes || selectedAttempt.summaryChars < attempts[0].summaryChars,
    openTaskIds: normalizeArray(data.tasks).filter(task => !isArchived(task)).map(task => task.id),
    archivedTaskIds: normalizeArray(data.tasks).filter(isArchived).map(task => task.id)
  };
}
