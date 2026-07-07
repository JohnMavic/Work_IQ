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
export const COPILOT_CHAT_EFFORT = process.env.AGENT_ZERO_CHAT_EFFORT || 'high';
export const COPILOT_CONTEXT = 'long_context';

export const AGENCY_ARG_PREFIX = buildAgencyArgPrefix({ effort: COPILOT_EFFORT });

export const DEFAULT_DISABLED_MCP_SERVERS = Object.freeze([]);
export const WORKIQ_ONLY_DISABLED_MCP_SERVERS = Object.freeze([]);

function buildAgencyArgPrefix({ effort = COPILOT_EFFORT, noConfigPlugins = false } = {}) {
  return [
    'copilot',
    ...(noConfigPlugins ? ['--no-config-plugins'] : []),
    '--max-autopilot-continues',
    '0',
    '--model',
    COPILOT_MODEL,
    '--effort',
    effort,
    '--context',
    COPILOT_CONTEXT
  ];
}

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
const STRIPPED_CALLER_VALUE_FLAGS = new Set([
  ...PINNED_VALUE_FLAGS,
  '--disable-mcp-server'
]);
const STRIPPED_CALLER_BOOLEAN_FLAGS = new Set([
  '--no-default-mcps',
  '--disable-builtin-mcps',
  '--no-config-plugins'
]);
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
    if (STRIPPED_CALLER_VALUE_FLAGS.has(arg)) {
      i++;
      continue;
    }
    if (STRIPPED_CALLER_BOOLEAN_FLAGS.has(arg)) {
      continue;
    }
    if ([...STRIPPED_CALLER_VALUE_FLAGS].some(flag => arg.startsWith(`${flag}=`))) {
      continue;
    }
    result.push(args[i]);
  }
  return result;
}

function safeFilePart(value) {
  return String(value || 'run')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .slice(0, 100) || 'run';
}

export function isolatedBrainWorkDir(runId, root = BRAIN_WORK_DIR) {
  return path.join(path.resolve(root), 'runs', safeFilePart(runId), 'brain-work');
}

export function resolveAgencyEffort({
  runClass = 'background',
  effort = null,
  env = process.env
} = {}) {
  if (effort) return String(effort);
  if (runClass === 'interactive') return env.AGENT_ZERO_CHAT_EFFORT || 'high';
  return env.AGENT_ZERO_BRAIN_EFFORT || 'xhigh';
}

export function disabledMcpServersForMode(mode = 'default', env = process.env) {
  env;
  if (mode === 'workiq-only') return [...WORKIQ_ONLY_DISABLED_MCP_SERVERS];
  if (mode === 'none') return [];
  return [...DEFAULT_DISABLED_MCP_SERVERS];
}

function buildDisableMcpArgs(_names = []) {
  return [];
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
  uploadsDir = DEFAULT_UPLOADS_DIR,
  effort = COPILOT_EFFORT,
  mcpMode = 'default',
  disableMcpServers = disabledMcpServersForMode(mcpMode)
} = {}) {
  if (!bootstrap || typeof bootstrap !== 'string') {
    throw new Error('buildAgencyArgs requires a bootstrap prompt string');
  }

  return [
    ...buildAgencyArgPrefix({
      effort,
      noConfigPlugins: mcpMode === 'none'
    }),
    ...stripPinnedCallerArgs(callerArgs),
    '-p',
    bootstrap,
    ...AGENCY_RUN_ARGS,
    '--add-dir',
    brainWorkDir,
    ...buildAttachmentArgs({ attachments, uploadsDir }),
    '--allow-all-tools',
    ...(mcpMode === 'none' ? ['--disable-builtin-mcps'] : []),
    ...buildDisableMcpArgs(disableMcpServers)
  ];
}

export function buildAgencyEnv(baseEnv = process.env, { effort = COPILOT_EFFORT } = {}) {
  const {
    AGENCY_SESSION_ID: _agencySessionId,
    COPILOT_AGENT_SESSION_ID: _copilotAgentSessionId,
    ...env
  } = baseEnv;

  return {
    ...env,
    COPILOT_MODEL,
    COPILOT_EFFORT: effort
  };
}
