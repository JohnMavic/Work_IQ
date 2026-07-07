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
import { renderScanState } from '../../brain/render-scan-state.js';
import { parseMarkers } from '../../brain/marker-parser.js';

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
    assert.equal(result.assistantText, 'hello \nworld\n');
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

test('brain runner reads real assistant.message data.content events', async () => {
  const brainWorkDir = makeBrainWorkDir('data-content');
  try {
    const result = await runBrain({
      prompt: 'scan state',
      brainWorkDir,
      _resolveAgencyCli: resolveAgencyCli,
      _spawnFn: makeFakeSpawn((child) => {
        emitJson(child, { type: 'assistant.message', data: { content: '[SCAN_DONE] {"ok":true}' } });
        child.emit('exit', 0);
      })
    });

    assert.equal(result.ok, true);
    assert.equal(result.assistantText, '[SCAN_DONE] {"ok":true}\n');
  } finally {
    cleanupBrainWorkDir(brainWorkDir);
  }
});

test('brain runner promotes delta-only assistant turn at turn_end', async () => {
  const brainWorkDir = makeBrainWorkDir('delta-promotion');
  try {
    const result = await runBrain({
      prompt: 'scan state',
      brainWorkDir,
      _resolveAgencyCli: resolveAgencyCli,
      _spawnFn: makeFakeSpawn((child) => {
        emitJson(child, { type: 'assistant.message_delta', data: { content: '[SCAN' } });
        emitJson(child, { type: 'assistant.message_delta', data: { content: '_DONE] {"ok":true}' } });
        emitJson(child, { type: 'turn_end' });
        child.emit('exit', 0);
      })
    });

    assert.equal(result.ok, true);
    assert.equal(result.assistantText, '[SCAN_DONE] {"ok":true}\n');
  } finally {
    cleanupBrainWorkDir(brainWorkDir);
  }
});

test('brain runner separates assistant messages with newlines so markers remain parseable', async () => {
  const brainWorkDir = makeBrainWorkDir('message-newlines');
  try {
    const result = await runBrain({
      prompt: 'scan state',
      brainWorkDir,
      _resolveAgencyCli: resolveAgencyCli,
      _spawnFn: makeFakeSpawn((child) => {
        emitJson(child, { type: 'assistant.message', data: { content: 'Consolidation complete.' } });
        emitJson(child, { type: 'assistant.message', data: { content: '[SCAN_DONE] {"ok":true}' } });
        child.emit('exit', 0);
      })
    });
    const { markers } = parseMarkers(result.assistantText);

    assert.equal(result.assistantText, 'Consolidation complete.\n[SCAN_DONE] {"ok":true}\n');
    assert.equal(markers.length, 1);
    assert.equal(markers[0].type, 'SCAN_DONE');
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

test('brain runner does not clear state files rendered before the run', async () => {
  const brainWorkDir = makeBrainWorkDir('preserve-rendered-state');
  try {
    const state = renderScanState({
      version: 5,
      tasks: [{ id: 'task-1', title: 'Task one', status: 'new' }]
    }, { brainWorkDir, runId: 'preserve-run' });

    assert.ok(fs.existsSync(state.stateFile));
    const result = await runBrain({
      prompt: `Read ${path.basename(state.stateFile)}`,
      brainWorkDir,
      _resolveAgencyCli: resolveAgencyCli,
      _spawnFn: makeFakeSpawn((child) => {
        emitJson(child, { type: 'assistant.message', content: 'done' });
        child.emit('exit', 0);
      })
    });

    assert.equal(result.ok, true);
    assert.ok(fs.existsSync(state.stateFile));
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

test('brain runner counts WorkIQ only from explicit tool identity fields', async () => {
  const brainWorkDir = makeBrainWorkDir('tool-counter-identity');
  try {
    const result = await runBrain({
      prompt: 'scan state',
      brainWorkDir,
      workIqHardLimit: 2,
      _resolveAgencyCli: resolveAgencyCli,
      _killTreeFn: () => { throw new Error('should not kill'); },
      _spawnFn: makeFakeSpawn((child) => {
        emitJson(child, { type: 'tool.execution_start', data: { toolName: 'write' }, arguments: { content: 'workiq://source/ref' } });
        emitJson(child, { type: 'tool.execution_start', data: { toolName: 'workiq.ask' } });
        emitJson(child, { type: 'assistant.message', content: 'done' });
        child.emit('exit', 0);
      })
    });

    assert.equal(result.ok, true);
    assert.equal(result.counters.toolExecutionStarts, 2);
    assert.equal(result.counters.workIqCalls, 1);
    assert.equal(result.killedForToolBudget, false);
  } finally {
    cleanupBrainWorkDir(brainWorkDir);
  }
});

test('brain runner kills WorkIQ on the first call above the hard limit', async () => {
  const brainWorkDir = makeBrainWorkDir('tool-counter-hard-limit');
  let killCount = 0;
  try {
    const result = await runBrain({
      prompt: 'scan state',
      brainWorkDir,
      workIqHardLimit: 2,
      _resolveAgencyCli: resolveAgencyCli,
      _killTreeFn: () => { killCount++; },
      _spawnFn: makeFakeSpawn((child) => {
        emitJson(child, { type: 'tool.execution_start', server: 'workiq', tool: 'ask' });
        emitJson(child, { type: 'tool.execution_start', server: 'workiq', tool: 'ask' });
        emitJson(child, { type: 'tool.execution_start', server: 'workiq', tool: 'ask' });
        emitJson(child, { type: 'assistant.message', content: 'done' });
        child.emit('exit', 0);
      })
    });

    assert.equal(result.ok, true);
    assert.equal(result.counters.workIqCalls, 3);
    assert.equal(result.killedForToolBudget, true);
    assert.equal(killCount, 1);
  } finally {
    cleanupBrainWorkDir(brainWorkDir);
  }
});

test('brain runner does not classify empty timeout as silent failure', async () => {
  const brainWorkDir = makeBrainWorkDir('timeout-not-silent');
  try {
    const result = await runBrain({
      prompt: 'scan state',
      brainWorkDir,
      timeoutMs: 5,
      _resolveAgencyCli: resolveAgencyCli,
      _killTreeFn: () => {},
      _spawnFn: makeFakeSpawn(() => {})
    });

    assert.equal(result.ok, false);
    assert.equal(result.timedOut, true);
    assert.equal(result.silentFailure, false);
  } finally {
    cleanupBrainWorkDir(brainWorkDir);
  }
});

test('brain runner cleans no bootstrap residue when cli resolution fails before spawn', async () => {
  const brainWorkDir = makeBrainWorkDir('resolve-failure-cleanup');
  try {
    const result = await runBrain({
      prompt: 'A'.repeat(BOOTSTRAP_FILE_THRESHOLD_BYTES + 1),
      brainWorkDir,
      _resolveAgencyCli: () => { throw new Error('agency.exe not found'); },
      _spawnFn: makeFakeSpawn(() => {
        throw new Error('spawn must not run');
      })
    });

    assert.equal(result.ok, false);
    assert.match(result.error.message, /agency\.exe not found/);
    assert.deepEqual(fs.readdirSync(brainWorkDir), []);
  } finally {
    cleanupBrainWorkDir(brainWorkDir);
  }
});

test('brain runner decodes utf8 split across stdout chunks without mojibake', async () => {
  const brainWorkDir = makeBrainWorkDir('utf8-split');
  try {
    const result = await runBrain({
      prompt: 'scan state',
      brainWorkDir,
      _resolveAgencyCli: resolveAgencyCli,
      _spawnFn: makeFakeSpawn((child) => {
        const line = Buffer.from(`${JSON.stringify({
          type: 'assistant.message',
          data: { content: '[TASK_NEW] {"title":"Büro Seestraße","sourceRef":{"id":"src-1","date":"2026-07-05"}}' }
        })}\n`, 'utf8');
        const splitAt = line.indexOf(Buffer.from('ü', 'utf8')) + 1;
        child.stdout.emit('data', line.subarray(0, splitAt));
        child.stdout.emit('data', line.subarray(splitAt));
        child.emit('exit', 0);
      })
    });

    assert.equal(result.ok, true);
    assert.match(result.assistantText, /Büro Seestraße/);
    assert.doesNotMatch(result.assistantText, /\uFFFD/);
  } finally {
    cleanupBrainWorkDir(brainWorkDir);
  }
});
