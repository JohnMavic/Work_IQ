import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_UPLOADS_DIR, isPathInside } from './attachments.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '..');
export const BRAIN_WORK_DIR = path.join(REPO_ROOT, 'brain-work');
export const COPILOT_MODEL = 'claude-opus-4.8';
export const COPILOT_EFFORT = process.env.AGENT_ZERO_BRAIN_EFFORT || 'xhigh';
export const COPILOT_CONTEXT = 'long_context';

export const AGENCY_ARG_PREFIX = [
  'copilot',
  '--no-default-mcps',
  '--max-autopilot-continues',
  '0',
  '--model',
  COPILOT_MODEL,
  '--effort',
  COPILOT_EFFORT,
  '--context',
  COPILOT_CONTEXT
];

export const AGENCY_RUN_ARGS = [
  '--yolo',
  '--output-format',
  'json',
  '--stream',
  'on',
  '--no-ask-user',
  '--no-auto-update'
];

const PINNED_VALUE_FLAGS = new Set(['--model', '--effort', '--context']);
let memoizedAgencyExe = null;

export function resetAgencyCliMemoForTests() {
  memoizedAgencyExe = null;
}

export function resolveAgencyCli({ env = process.env } = {}) {
  if (env.AGENT_ZERO_AGENCY_EXE) return env.AGENT_ZERO_AGENCY_EXE;
  if (memoizedAgencyExe) return memoizedAgencyExe;

  const output = execFileSync('where.exe', ['agency.exe'], {
    encoding: 'utf8',
    windowsHide: true
  });
  const first = String(output)
    .split(/\r?\n/)
    .map(line => line.trim())
    .find(Boolean);

  if (!first) throw new Error('agency.exe was not found by where.exe');
  memoizedAgencyExe = first;
  return memoizedAgencyExe;
}

export function stripPinnedCallerArgs(args = []) {
  const result = [];
  for (let i = 0; i < args.length; i++) {
    const arg = String(args[i]);
    if (PINNED_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if ([...PINNED_VALUE_FLAGS].some(flag => arg.startsWith(`${flag}=`))) {
      continue;
    }
    result.push(args[i]);
  }
  return result;
}

export function buildAttachmentArgs({
  attachments = [],
  uploadsDir = DEFAULT_UPLOADS_DIR,
  requireExists = true
} = {}) {
  if (!Array.isArray(attachments)) {
    throw new Error('attachments must be an array');
  }
  const root = path.resolve(uploadsDir);
  const args = [];
  for (const value of attachments) {
    const attachmentPath = typeof value === 'string' ? value : value?.absolutePath || value?.path;
    if (!attachmentPath || typeof attachmentPath !== 'string') {
      throw new Error('attachment path is required');
    }
    if (!path.isAbsolute(attachmentPath)) {
      throw new Error(`attachment path must be absolute: ${attachmentPath}`);
    }
    const resolved = path.resolve(attachmentPath);
    if (!isPathInside(root, resolved)) {
      throw new Error(`attachment path is outside uploads: ${resolved}`);
    }
    if (requireExists && (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile())) {
      throw new Error(`attachment file not found: ${resolved}`);
    }
    args.push('--attachment', resolved);
  }
  return args;
}

export function buildAgencyArgs({
  bootstrap,
  callerArgs = [],
  brainWorkDir = BRAIN_WORK_DIR,
  attachments = [],
  uploadsDir = DEFAULT_UPLOADS_DIR
} = {}) {
  if (!bootstrap || typeof bootstrap !== 'string') {
    throw new Error('buildAgencyArgs requires a bootstrap prompt string');
  }

  return [
    ...AGENCY_ARG_PREFIX,
    ...stripPinnedCallerArgs(callerArgs),
    '-p',
    bootstrap,
    ...AGENCY_RUN_ARGS,
    '--add-dir',
    brainWorkDir,
    ...buildAttachmentArgs({ attachments, uploadsDir }),
    '--allow-all-tools',
    '--disable-mcp-server',
    'playwright',
    '--disable-mcp-server',
    'github-mcp-server'
  ];
}

export function buildAgencyEnv(baseEnv = process.env) {
  const {
    AGENCY_SESSION_ID: _agencySessionId,
    COPILOT_AGENT_SESSION_ID: _copilotAgentSessionId,
    ...env
  } = baseEnv;

  return {
    ...env,
    COPILOT_MODEL,
    COPILOT_EFFORT
  };
}
