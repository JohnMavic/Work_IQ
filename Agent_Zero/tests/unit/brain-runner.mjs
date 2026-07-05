import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { fileURLToPath } from 'node:url';
import {
  BOOTSTRAP_FILE_THRESHOLD_BYTES,
  runBrain,
  residualStderrBytes
} from '../../brain/brain-runner.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const tmpRoot = path.join(repoRoot, 'tests', 'unit', '.tmp-brain-runner');

function makeBrainWorkDir(name) {
  const root = path.join(tmpRoot, name);
  fs.rmSync(root, { recursive: true, force: true });
  return path.join(root, 'brain-work');
}

function cleanupBrainWorkDir(dir) {
  fs.rmSync(path.dirname(dir), { recursive: true, force: true });
}

function emitJson(child, event) {
  child.stdout.emit('data', Buffer.from(`${JSON.stringify(event)}\n`, 'utf8'));
}

function makeFakeSpawn(script, capture = {}) {
  return (exe, args, options) => {
    capture.exe = exe;
    capture.args = args;
    capture.options = options;
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.pid = 4242;
    child.kill = () => { child.killed = true; };
    capture.child = child;
    queueMicrotask(() => script(child, { exe, args, options }));
    return child;
  };
}

const resolveAgencyCli = () => 'C:\\Tools\\agency.exe';

test('brain runner resolves success from exit 0 plus assistant.message text', async () => {
  const brainWorkDir = makeBrainWorkDir('success');
  const capture = {};

  try {
    const result = await runBrain({
      prompt: 'scan state',
      brainWorkDir,
      _resolveAgencyCli: resolveAgencyCli,
      _spawnFn: makeFakeSpawn((child) => {
        emitJson(child, { type: 'assistant.message', message: { content: 'hello ' } });
        emitJson(child, { type: 'assistant.message', content: 'world' });
        child.emit('exit', 0);
      }, capture)
    });

    assert.equal(result.ok, true);
    assert.equal(result.assistantText, 'hello world');
    assert.equal(result.exitCode, 0);
    assert.equal(capture.exe, 'C:\\Tools\\agency.exe');
    assert.equal(capture.options.cwd, brainWorkDir);
    assert.equal(capture.options.env.COPILOT_MODEL, 'claude-opus-4.8');
    assert.ok(capture.args.includes('--no-default-mcps'));
    assert.deepEqual(
      capture.args.slice(capture.args.indexOf('--model'), capture.args.indexOf('--model') + 2),
      ['--model', 'claude-opus-4.8']
    );
    assert.ok(capture.args.includes('--allow-all-tools'));
    assert.equal(capture.args[capture.args.indexOf('--add-dir') + 1], brainWorkDir);
    assert.ok(capture.args.includes('github-mcp-server'));
  } finally {
    cleanupBrainWorkDir(brainWorkDir);
  }
});

test('brain runner treats exit 0 plus empty assistant text as failure', async () => {
  const brainWorkDir = makeBrainWorkDir('empty');
  try {
    const result = await runBrain({
      prompt: 'scan state',
      brainWorkDir,
      _resolveAgencyCli: resolveAgencyCli,
      _spawnFn: makeFakeSpawn((child) => {
        child.emit('exit', 0);
      })
    });

    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.error.exitCode, 0);
    assert.equal(result.timedOut, false);
  } finally {
    cleanupBrainWorkDir(brainWorkDir);
  }
});

test('brain runner salvages timeout when assistant text has at least 200 bytes', async () => {
  const brainWorkDir = makeBrainWorkDir('timeout-salvage');
  let killed = false;
  try {
    const result = await runBrain({
      prompt: 'scan state',
      brainWorkDir,
      timeoutMs: 5,
      _resolveAgencyCli: resolveAgencyCli,
      _killTreeFn: () => { killed = true; },
      _spawnFn: makeFakeSpawn((child) => {
        emitJson(child, { type: 'assistant.message', content: 'x'.repeat(220) });
      })
    });

    assert.equal(result.ok, true);
    assert.equal(result.timedOut, true);
    assert.equal(result.salvaged, true);
    assert.equal(killed, true);
  } finally {
    cleanupBrainWorkDir(brainWorkDir);
  }
});

test('brain runner marks non-zero exit with empty stdout and banner-only stderr as silent failure', async () => {
  const brainWorkDir = makeBrainWorkDir('silent');
  const banner = [
    '🤖 Agency v0.0.0',
    '📁 Log directory: C:\\temp\\agency',
    '📦 Resolving Copilot CLI',
    '🧠 Copilot CLI at C:\\x\\copilot.exe',
    '✅ Copilot CLI resolved',
    '🔌 Loaded workiq'
  ].join('\n');

  try {
    assert.equal(residualStderrBytes(banner), 0);
    const result = await runBrain({
      prompt: 'scan state',
      brainWorkDir,
      _resolveAgencyCli: resolveAgencyCli,
      _spawnFn: makeFakeSpawn((child) => {
        child.stderr.emit('data', Buffer.from(banner, 'utf8'));
        child.emit('exit', 1);
      })
    });

    assert.equal(result.ok, false);
    assert.equal(result.silentFailure, true);
    assert.equal(result.stdoutBytes, 0);
    assert.equal(result.stderrBytes, 0);
  } finally {
    cleanupBrainWorkDir(brainWorkDir);
  }
});

test('brain runner spills bootstrap over 16 KB to per-run file and cleans it up', async () => {
  const brainWorkDir = makeBrainWorkDir('large-prompt');
  const capture = {};

  try {
    const result = await runBrain({
      prompt: 'A'.repeat(BOOTSTRAP_FILE_THRESHOLD_BYTES + 1),
      brainWorkDir,
      _resolveAgencyCli: resolveAgencyCli,
      _spawnFn: makeFakeSpawn((child, { args, options }) => {
        const bootstrap = args[args.indexOf('-p') + 1];
        const match = bootstrap.match(/\.\/(brain-bootstrap-[^\s]+\.md)/);
        assert.ok(match);
        assert.ok(fs.existsSync(path.join(options.cwd, match[1])));
        emitJson(child, { type: 'assistant.message', content: 'done' });
        child.emit('exit', 0);
      }, capture)
    });

    assert.equal(result.ok, true);
    assert.deepEqual(fs.readdirSync(brainWorkDir), []);
  } finally {
    cleanupBrainWorkDir(brainWorkDir);
  }
});

test('brain runner reports tool.execution callbacks and WorkIQ counters', async () => {
  const brainWorkDir = makeBrainWorkDir('tool-counters');
  const callbacks = [];

  try {
    const result = await runBrain({
      prompt: 'scan state',
      brainWorkDir,
      _resolveAgencyCli: resolveAgencyCli,
      onToolExecution: (event, counters) => callbacks.push({ event, counters }),
      _spawnFn: makeFakeSpawn((child) => {
        emitJson(child, { type: 'tool.execution_start', server: 'workiq', tool: 'ask' });
        emitJson(child, { type: 'tool.execution_end', server: 'workiq', tool: 'ask' });
        emitJson(child, { type: 'assistant.message', content: 'done' });
        child.emit('exit', 0);
      })
    });

    assert.equal(result.ok, true);
    assert.equal(result.counters.toolExecutionEvents, 2);
    assert.equal(result.counters.toolExecutionStarts, 1);
    assert.equal(result.counters.workIqCalls, 1);
    assert.equal(callbacks.length, 2);
    assert.equal(callbacks[0].counters.workIqCalls, 1);
  } finally {
    cleanupBrainWorkDir(brainWorkDir);
  }
});
