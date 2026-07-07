import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  BRAIN_RUN_CLASS,
  PriorityBrainScheduler
} from '../../brain/brain-scheduler.js';

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function tick() {
  return new Promise(resolve => setImmediate(resolve));
}

test('priority scheduler lets interactive overtake queued background', async () => {
  const scheduler = new PriorityBrainScheduler({ globalLimit: 2, backgroundLimit: 1 });
  const started = [];
  const bg1 = deferred();
  const bg2 = deferred();
  const interactive = deferred();

  const p1 = scheduler.run(BRAIN_RUN_CLASS.BACKGROUND, async () => {
    started.push('bg1');
    await bg1.promise;
    return 'bg1';
  });
  await tick();

  const p2 = scheduler.run(BRAIN_RUN_CLASS.BACKGROUND, async () => {
    started.push('bg2');
    await bg2.promise;
    return 'bg2';
  });
  const pi = scheduler.run(BRAIN_RUN_CLASS.INTERACTIVE, async () => {
    started.push('interactive');
    await interactive.promise;
    return 'interactive';
  });
  await tick();

  assert.deepEqual(started, ['bg1', 'interactive']);
  interactive.resolve();
  await pi;
  assert.deepEqual(started, ['bg1', 'interactive']);

  bg1.resolve();
  await p1;
  await tick();
  assert.deepEqual(started, ['bg1', 'interactive', 'bg2']);

  bg2.resolve();
  await p2;
});

test('priority scheduler starts queued interactive before next background batch', async () => {
  const scheduler = new PriorityBrainScheduler({ globalLimit: 2, backgroundLimit: 1 });
  const started = [];
  const bg1 = deferred();
  const int1 = deferred();
  const bg2 = deferred();
  const int2 = deferred();

  const pBg1 = scheduler.run(BRAIN_RUN_CLASS.BACKGROUND, async () => {
    started.push('bg1');
    await bg1.promise;
  });
  const pInt1 = scheduler.run(BRAIN_RUN_CLASS.INTERACTIVE, async () => {
    started.push('int1');
    await int1.promise;
  });
  await tick();
  assert.deepEqual(started, ['bg1', 'int1']);

  const pBg2 = scheduler.run(BRAIN_RUN_CLASS.BACKGROUND, async () => {
    started.push('bg2');
    await bg2.promise;
  });
  const pInt2 = scheduler.run(BRAIN_RUN_CLASS.INTERACTIVE, async () => {
    started.push('int2');
    await int2.promise;
  });
  await tick();
  assert.deepEqual(started, ['bg1', 'int1']);

  int1.resolve();
  await pInt1;
  await tick();
  assert.deepEqual(started, ['bg1', 'int1', 'int2']);

  int2.resolve();
  await pInt2;
  await tick();
  assert.deepEqual(started, ['bg1', 'int1', 'int2']);

  bg1.resolve();
  await pBg1;
  await tick();
  assert.deepEqual(started, ['bg1', 'int1', 'int2', 'bg2']);

  bg2.resolve();
  await pBg2;
});
