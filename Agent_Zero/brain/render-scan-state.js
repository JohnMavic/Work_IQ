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
  if (ref.link) parts.push(ref.link);
  return parts.join(' | ');
}

function renderPmStatus(task, lines) {
  if (!task.pmStatus) return;
  lines.push(`  PM current: ${truncate(task.pmStatus.current, 180) || 'n/a'}`);
  for (const field of ['planned', 'userActions', 'problems', 'risks', 'waitingOn']) {
    const entries = normalizeArray(task.pmStatus[field]);
    if (!entries.length) continue;
    const text = entries
      .slice(0, 3)
      .map(entry => truncate(entry.text, 120))
      .filter(Boolean)
      .join(' | ');
    if (text) lines.push(`  ${field}: ${text}`);
  }
}

function renderHistorySpill(task, { brainWorkDir, runId, historySpillBytes, spillFiles }) {
  const history = normalizeArray(task.history);
  if (!history.length) return null;
  const rendered = history
    .map(entry => `- [${entry.timestamp || '?'}] ${entry.type || 'note'}: ${entry.text || ''}`)
    .join('\n');
  if (bytes(rendered) <= historySpillBytes) return null;

  const filename = `history-${safeFilePart(task.id)}-${safeFilePart(runId)}.md`;
  fs.writeFileSync(path.join(brainWorkDir, filename), `# History for ${task.id}\n\n${rendered}\n`, 'utf8');
  spillFiles.push(filename);
  return filename;
}

function buildMarkdown(data, options) {
  const {
    summaryChars,
    lineItemLimit,
    includePmStatus,
    brainWorkDir,
    runId,
    historySpillBytes,
    spillFiles,
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
    if (task.summary && summaryChars > 0) lines.push(`  summary: ${truncate(task.summary, summaryChars)}`);
    if (includePmStatus) renderPmStatus(task, lines);
    const spill = renderHistorySpill(task, { brainWorkDir, runId, historySpillBytes, spillFiles });
    if (spill) lines.push(`  history spill: ${spill}`);
    const lineItems = normalizeArray(task.lineItems).slice(0, lineItemLimit);
    if (!lineItems.length) lines.push('  lineItems: none');
    for (const item of lineItems) {
      lines.push(`  - (${item.id}) ${truncate(item.title, 120)} | status=${item.status || 'open'} | evidence=${latestEvidenceForLineItem(task, item)}`);
    }
    const hidden = normalizeArray(task.lineItems).length - lineItems.length;
    if (hidden > 0) lines.push(`  - ${hidden} more line item(s) omitted by budget`);
  }
  lines.push('');

  lines.push('## Open Single Tasks');
  if (!openSingles.length) lines.push('- none');
  for (const task of openSingles) {
    const summary = summaryChars > 0 ? truncate(task.summary, summaryChars) : '';
    const link = task.link || normalizeArray(task.sourceRefs).find(ref => ref.link)?.link || 'no-link';
    lines.push(`- [${task.id}] ${truncate(task.title, 160)} | status=${task.status || 'new'} | link=${link}`);
    if (summary) lines.push(`  summary: ${summary}`);
    const spill = renderHistorySpill(task, { brainWorkDir, runId, historySpillBytes, spillFiles });
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
    { summaryChars: 180, lineItemLimit: 12, includePmStatus: true },
    { summaryChars: 100, lineItemLimit: 8, includePmStatus: true },
    { summaryChars: 60, lineItemLimit: 5, includePmStatus: false },
    { summaryChars: 0, lineItemLimit: 3, includePmStatus: false }
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
