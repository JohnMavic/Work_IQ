import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

export const REPO_ROOT = path.resolve(__dirname, '..');
export const BRAIN_WORK_DIR = path.join(REPO_ROOT, 'brain-work');
export const COPILOT_MODEL = 'claude-opus-4.8';
export const COPILOT_EFFORT = 'high';
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

export function buildAgencyArgs({ bootstrap, callerArgs = [], brainWorkDir = BRAIN_WORK_DIR } = {}) {
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
    COPILOT_MODEL
  };
}
