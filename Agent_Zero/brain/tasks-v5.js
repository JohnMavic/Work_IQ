import fs from 'node:fs';
import path from 'node:path';
import { COPILOT_MODEL } from './agency-cli.js';

export const V5_BRAIN_DEFAULTS = {
  engine: 'agency',
  model: COPILOT_MODEL,
  lastRunId: null,
  lastRunAt: null,
  lastOutcome: null,
  lastPremiumRequests: null,
  lastWorkIqCalls: null
};

export const V5_BRAIN_STATE_DEFAULTS = {
  lastScanRunId: null,
  lastEvidenceAt: null,
  needsReview: false,
  reviewReason: null
};

function safeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[:.]/g, '-');
}

function fsyncDirectoryBestEffort(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  } catch {
    // Windows does not always allow directory handles. The file fsync still ran.
  }
}

function rotateBackups(filePath, maxBackups) {
  if (maxBackups <= 0 || !fs.existsSync(filePath)) return;

  const oldest = `${filePath}.${maxBackups}.bak`;
  try { fs.rmSync(oldest, { force: true }); } catch {}

  for (let i = maxBackups - 1; i >= 1; i--) {
    const from = `${filePath}.${i}.bak`;
    const to = `${filePath}.${i + 1}.bak`;
    if (fs.existsSync(from)) {
      try { fs.renameSync(from, to); } catch {}
    }
  }

  fs.copyFileSync(filePath, `${filePath}.1.bak`);
}

export function writeJsonFileAtomic(filePath, data, { maxBackups = 3 } = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  rotateBackups(filePath, maxBackups);

  const tmp = path.join(
    dir,
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
  );
  const payload = `${JSON.stringify(data, null, 2)}\n`;
  let fd = null;

  try {
    fd = fs.openSync(tmp, 'wx');
    fs.writeFileSync(fd, payload, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tmp, filePath);
    fsyncDirectoryBestEffort(dir);
  } catch (err) {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch {}
    }
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw err;
  }
}

function normalizeArray(value) {
  return Array.isArray(value) ? value : [];
}

function normalizeBrainState(value) {
  const existing = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  return {
    ...V5_BRAIN_STATE_DEFAULTS,
    ...existing
  };
}

export function migrateToV5(input) {
  const data = input && typeof input === 'object' ? structuredClone(input) : {};
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];

  data.version = 5;
  if (data.lastScan === undefined) data.lastScan = null;
  data.brain = {
    ...V5_BRAIN_DEFAULTS,
    ...(data.brain && typeof data.brain === 'object' && !Array.isArray(data.brain) ? data.brain : {})
  };
  data.reviewQueue = normalizeArray(data.reviewQueue);
  data.tasks = tasks.map(task => {
    const migrated = {
      ...task,
      schemaVersion: 5
    };

    if (migrated.taskType !== 'project' && migrated.taskType !== 'single') migrated.taskType = 'single';
    if (migrated.archived === undefined) migrated.archived = false;
    if (migrated.supersededBy === undefined) migrated.supersededBy = null;
    migrated.supersedesTaskIds = normalizeArray(migrated.supersedesTaskIds);
    migrated.lineItems = normalizeArray(migrated.lineItems);
    migrated.sourceRefs = normalizeArray(migrated.sourceRefs);
    if (migrated.pmStatus === undefined) migrated.pmStatus = null;
    migrated.brainState = normalizeBrainState(migrated.brainState);
    return migrated;
  });

  return data;
}

export function migrateTasksFileToV5(tasksFile, { now = new Date() } = {}) {
  const raw = fs.readFileSync(tasksFile, 'utf8');
  const parsed = JSON.parse(raw);
  if (parsed.version >= 5) {
    return { migrated: false, data: parsed, backupFile: null };
  }

  const backupFile = path.join(
    path.dirname(tasksFile),
    `${path.basename(tasksFile)}.v4-${safeTimestamp(now)}.bak`
  );
  fs.copyFileSync(tasksFile, backupFile);
  const migrated = migrateToV5(parsed);
  writeJsonFileAtomic(tasksFile, migrated);
  return { migrated: true, data: migrated, backupFile };
}
