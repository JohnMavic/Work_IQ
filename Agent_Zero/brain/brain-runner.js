import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { StringDecoder } from 'node:string_decoder';
import {
  BRAIN_WORK_DIR,
  buildAgencyArgs,
  buildAgencyEnv,
  resolveAgencyEffort,
  resolveAgencyCli
} from './agency-cli.js';
import { BRAIN_RUN_CLASS, defaultBrainScheduler } from './brain-scheduler.js';

export const BOOTSTRAP_FILE_THRESHOLD_BYTES = 16 * 1024;
export const DEFAULT_TIMEOUT_MS = 25 * 60 * 1000;
export const DEFAULT_SALVAGE_BYTES = 200;
export const DEFAULT_WORKIQ_HARD_LIMIT = 25;

export const AGENCY_BANNER_PREFIXES = [
  '🤖 Agency ',
  '📁 Log directory:',
  '📦 Resolving Copilot CLI',
  '🧠 Copilot CLI at',
  '✅ Copilot CLI resolved',
  '🔌 Loaded '
];

function byteLength(text) {
  return Buffer.byteLength(String(text || ''), 'utf8');
}

export function residualStderrBytes(text) {
  if (typeof text !== 'string' || text.length === 0) return 0;
  let bytes = 0;
  for (const line of text.split(/\r?\n/)) {
    if (line.length === 0) continue;
    if (AGENCY_BANNER_PREFIXES.some(prefix => line.startsWith(prefix))) continue;
    bytes += byteLength(line);
  }
  return bytes;
}

function assertBrainWorkDirSafe(dir) {
  const resolved = path.resolve(dir);
  if (path.basename(resolved).toLowerCase() !== 'brain-work') {
    throw new Error(`Refusing to clean non brain-work directory: ${resolved}`);
  }
  return resolved;
}

export function prepareBrainWorkDir(dir = BRAIN_WORK_DIR) {
  const resolved = assertBrainWorkDirSafe(dir);
  fs.mkdirSync(resolved, { recursive: true });
  for (const entry of fs.readdirSync(resolved, { withFileTypes: true })) {
    fs.rmSync(path.join(resolved, entry.name), { recursive: true, force: true });
  }
  return resolved;
}

function assistantTextFromEvent(event) {
  if (!event || event.type !== 'assistant.message') return '';

  const candidates = [
    event.data?.content,
    event.data?.text,
    event.data?.message,
    event.data?.message?.content,
    event.data?.message?.text,
    event.text,
    event.content,
    event.delta?.content,
    event.message,
    event.message?.content,
    event.message?.text
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate;
    if (Array.isArray(candidate)) {
      return candidate
        .map(part => {
          if (typeof part === 'string') return part;
          if (typeof part?.text === 'string') return part.text;
          if (typeof part?.content === 'string') return part.content;
          return '';
        })
        .join('');
    }
  }

  return '';
}

function assistantDeltaTextFromEvent(event) {
  if (!event || event.type !== 'assistant.message_delta') return '';

  const candidates = [
    event.data?.content,
    event.data?.text,
    event.data?.delta?.content,
    event.data?.message?.content,
    event.delta?.content,
    event.content,
    event.text
  ];

  for (const candidate of candidates) {
    if (typeof candidate === 'string') return candidate;
    if (Array.isArray(candidate)) {
      return candidate
        .map(part => {
          if (typeof part === 'string') return part;
          if (typeof part?.text === 'string') return part.text;
          if (typeof part?.content === 'string') return part.content;
          return '';
        })
        .join('');
    }
  }

  return '';
}

function isTurnEndEvent(event) {
  return ['turn_end', 'turn.end', 'assistant.turn_end'].includes(event?.type);
}

function isToolExecutionEvent(event) {
  return typeof event?.type === 'string' && event.type.startsWith('tool.execution_');
}

function isWorkIqStartEvent(event) {
  if (event?.type !== 'tool.execution_start') return false;
  const candidates = [
    event.data?.toolName,
    event.data?.serverName,
    event.data?.server,
    event.data?.name,
    event.toolName,
    event.tool,
    event.server,
    event.name
  ];
  return candidates
    .filter(value => typeof value === 'string')
    .some(value => /work[_-]?iq/i.test(value));
}

function killTree(child) {
  if (!child || !child.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], {
      windowsHide: true,
      stdio: 'ignore'
    });
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function makeLargePromptBootstrap(prompt, runId, brainWorkDir) {
  const filename = `brain-bootstrap-${runId}.md`;
  const filePath = path.join(brainWorkDir, filename);
  fs.writeFileSync(filePath, prompt, 'utf8');
  return {
    bootstrap: [
      `Read ./${filename} in the current working directory before doing any work.`,
      'Follow that file exactly. Return only the requested JSON stream content and final markers.'
    ].join('\n'),
    contextFile: filePath
  };
}

function ensureBrainWorkDir(dir = BRAIN_WORK_DIR) {
  const resolved = assertBrainWorkDirSafe(dir);
  fs.mkdirSync(resolved, { recursive: true });
  return resolved;
}

function buildResult({
  assistantText,
  counters,
  durationMs,
  exitCode,
  rawStderr,
  stdoutBytes,
  timedOut,
  killedForToolBudget,
  spawnError,
  salvageBytes
}) {
  const assistantBytes = byteLength(assistantText);
  const stderrBytes = residualStderrBytes(rawStderr);
  const hasAssistantText = assistantText.trim().length > 0;
  const salvaged = timedOut && assistantBytes >= salvageBytes;
  const ok = (exitCode === 0 && hasAssistantText) || salvaged;
  const silentFailure = !timedOut && typeof exitCode === 'number' && exitCode !== 0 && stdoutBytes === 0 && stderrBytes === 0;

  const result = {
    ok,
    success: ok,
    assistantText,
    text: assistantText,
    exitCode,
    durationMs,
    stdoutBytes,
    stderrBytes,
    rawStderrBytes: byteLength(rawStderr),
    timedOut,
    salvaged,
    silentFailure,
    killedForToolBudget,
    counters
  };

  if (!ok) {
    result.error = {
      message: spawnError?.message || (timedOut ? 'Agency brain run timed out' : 'Agency brain run failed'),
      exitCode,
      durationMs,
      stdoutBytes,
      stderrBytes,
      timedOut,
      silentFailure
    };
  }

  return result;
}

export async function runBrain({
  prompt,
  callerArgs = [],
  brainWorkDir = BRAIN_WORK_DIR,
  attachments = [],
  uploadsDir,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  salvageBytes = DEFAULT_SALVAGE_BYTES,
  workIqHardLimit = DEFAULT_WORKIQ_HARD_LIMIT,
  onToolExecution,
  onJsonEvent,
  onSchedulerUpdate,
  runClass = BRAIN_RUN_CLASS.BACKGROUND,
  effort = null,
  mcpMode = 'default',
  disableMcpServers,
  schedulerLabel = null,
  _spawnFn = spawn,
  _killTreeFn = killTree,
  _resolveAgencyCli = resolveAgencyCli,
  _scheduler = defaultBrainScheduler,
  cleanBrainWorkDir = false
} = {}) {
  if (!prompt || typeof prompt !== 'string') {
    throw new Error('runBrain requires a prompt string');
  }

  const normalizedRunClass = runClass === BRAIN_RUN_CLASS.INTERACTIVE
    ? BRAIN_RUN_CLASS.INTERACTIVE
    : BRAIN_RUN_CLASS.BACKGROUND;
  const selectedEffort = resolveAgencyEffort({ runClass: normalizedRunClass, effort });

  const executeBrainProcess = async () => {

  const resolvedBrainWorkDir = cleanBrainWorkDir
    ? prepareBrainWorkDir(brainWorkDir)
    : ensureBrainWorkDir(brainWorkDir);
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const promptBytes = byteLength(prompt);
  const largePrompt = promptBytes > BOOTSTRAP_FILE_THRESHOLD_BYTES;
  const startedAt = Date.now();
  let fileContext = { bootstrap: prompt, contextFile: null };
  let exe = null;
  let args = null;
  let child = null;
  const counters = {
    jsonEvents: 0,
    toolExecutionEvents: 0,
    toolExecutionStarts: 0,
    workIqCalls: 0
  };
  let assistantText = '';
  let pendingDeltaText = '';
  let stdoutBuffer = '';
  let stdoutBytes = 0;
  let rawStderr = '';
  let timedOut = false;
  let killedForToolBudget = false;
  let settled = false;
  let timer = null;
  const stdoutDecoder = new StringDecoder('utf8');
  const stderrDecoder = new StringDecoder('utf8');

  function cleanupContextFile() {
    if (!fileContext.contextFile) return;
    try { fs.unlinkSync(fileContext.contextFile); } catch {}
  }

  function appendAssistantText(chunk) {
    if (!chunk) return;
    assistantText += chunk;
    if (!assistantText.endsWith('\n')) assistantText += '\n';
  }

  try {
    exe = _resolveAgencyCli();
    fileContext = largePrompt
      ? makeLargePromptBootstrap(prompt, runId, resolvedBrainWorkDir)
      : { bootstrap: prompt, contextFile: null };
    args = buildAgencyArgs({
      bootstrap: fileContext.bootstrap,
      callerArgs,
      brainWorkDir: resolvedBrainWorkDir,
      attachments,
      uploadsDir,
      effort: selectedEffort,
      mcpMode,
      disableMcpServers
    });
    child = _spawnFn(exe, args, {
      cwd: resolvedBrainWorkDir,
      env: buildAgencyEnv(process.env, { effort: selectedEffort }),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (err) {
    cleanupContextFile();
    return buildResult({
      assistantText,
      counters,
      durationMs: Date.now() - startedAt,
      exitCode: null,
      rawStderr,
      stdoutBytes,
      timedOut,
      killedForToolBudget,
      spawnError: err,
      salvageBytes
    });
  }

  function processLine(line) {
    if (!line.trim()) return;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    counters.jsonEvents++;
    if (onJsonEvent) onJsonEvent(event, { ...counters });

    const chunk = assistantTextFromEvent(event);
    if (chunk) {
      pendingDeltaText = '';
      appendAssistantText(chunk);
    } else {
      const delta = assistantDeltaTextFromEvent(event);
      if (delta) pendingDeltaText += delta;
      if (isTurnEndEvent(event) && pendingDeltaText) {
        appendAssistantText(pendingDeltaText);
        pendingDeltaText = '';
      }
    }

    if (isToolExecutionEvent(event)) {
      counters.toolExecutionEvents++;
      if (event.type === 'tool.execution_start') counters.toolExecutionStarts++;
      if (isWorkIqStartEvent(event)) {
        counters.workIqCalls++;
        if (counters.workIqCalls > workIqHardLimit && !killedForToolBudget) {
          killedForToolBudget = true;
          try { _killTreeFn(child); } catch {}
        }
      }
      if (onToolExecution) onToolExecution(event, { ...counters });
    }
  }

  function processStdoutChunk(chunk) {
    const text = Buffer.isBuffer(chunk) ? stdoutDecoder.write(chunk) : String(chunk);
    stdoutBytes += Buffer.isBuffer(chunk) ? chunk.length : byteLength(text);
    stdoutBuffer += text;
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) processLine(line);
  }

  function finishStdoutBuffer() {
    const decoderTail = stdoutDecoder.end();
    if (decoderTail) stdoutBuffer += decoderTail;
    if (stdoutBuffer) {
      processLine(stdoutBuffer);
      stdoutBuffer = '';
    }
    if (pendingDeltaText) {
      appendAssistantText(pendingDeltaText);
      pendingDeltaText = '';
    }
  }

  return new Promise((resolve) => {
    function settle({ exitCode = null, spawnError = null } = {}) {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      finishStdoutBuffer();
      rawStderr += stderrDecoder.end();
      cleanupContextFile();
      resolve(buildResult({
        assistantText,
        counters,
        durationMs: Date.now() - startedAt,
        exitCode,
        rawStderr,
        stdoutBytes,
        timedOut,
        killedForToolBudget,
        spawnError,
        salvageBytes
      }));
    }

    child.stdout?.on('data', processStdoutChunk);
    child.stderr?.on('data', chunk => {
      rawStderr += Buffer.isBuffer(chunk) ? stderrDecoder.write(chunk) : String(chunk);
    });
    child.once?.('error', err => settle({ exitCode: null, spawnError: err }));
    child.once?.('exit', code => settle({ exitCode: typeof code === 'number' ? code : null }));
    child.once?.('close', code => settle({ exitCode: typeof code === 'number' ? code : null }));

    timer = setTimeout(() => {
      timedOut = true;
      try { _killTreeFn(child); } catch {}
      settle({ exitCode: null });
    }, timeoutMs);
  });
  };

  if (!_scheduler) return executeBrainProcess();
  return _scheduler.run(normalizedRunClass, executeBrainProcess, {
    onStateChange: onSchedulerUpdate,
    label: schedulerLabel
  });
}
