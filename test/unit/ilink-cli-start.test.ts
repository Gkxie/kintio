import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import { loadSharedRuntimeConfig } from '../../src/config.ts';
import { runWorker } from '../../src/runtime/run-worker.ts';

function config() {
  return loadSharedRuntimeConfig({
    environment: {},
    root: path.join(os.tmpdir(), 'kintio-ilink-cli-start'),
  });
}

for (const phase of ['starting', 'running'] as const) {
  test(`fatal Agent failure while ${phase} closes the worker without an intentional-stop notice`, async () => {
    const events: string[] = [];
    const fatal = new Error('synthetic fatal Agent failure');
    let fail!: (error: Error) => void;
    const failure = new Promise<Error>((resolve) => { fail = resolve; });
    let finishStartup: (() => void) | undefined;
    const controller = new AbortController();
    const running = runWorker({
      config: config(),
      signal: controller.signal,
      stdout() {},
      onStopRequested() { events.push('intentional-stop'); },
      onStarted() { events.push('ready'); },
      create: async () => ({
        failure,
        wecomControl: async () => ({ running: false }),
        async start() {
          events.push('start');
          if (phase === 'starting') {
            fail(fatal);
            return new Promise<void>((resolve) => { finishStartup = resolve; });
          }
        },
        stopAcceptingIfIdle() { return true; },
        stopAccepting() { events.push('stop'); },
        async close() { events.push('close'); },
        async abort() { events.push('abort'); },
      }),
    });
    // Resolve the signal on the old implementation so the red test fails
    // promptly instead of waiting indefinitely for its missing failure race.
    const cleanup = setTimeout(() => { controller.abort(); finishStartup?.(); }, 100);
    try {
      if (phase === 'running') {
        await new Promise<void>((resolve) => setImmediate(resolve));
        fail(fatal);
      }
      await assert.rejects(running, (error) => error === fatal);
      assert.deepEqual(events, phase === 'starting'
        ? ['start', 'stop', 'close']
        : ['start', 'ready', 'stop', 'close']);
    } finally {
      clearTimeout(cleanup);
      controller.abort();
      finishStartup?.();
    }
  });
}

test('iLink start runs and drains a foreground runtime without Hono', async () => {
  const events: string[] = [];
  const output: string[] = [];
  const controller = new AbortController();
  const running = runWorker({
    config: config(),
    signal: controller.signal,
    stdout: (text) => output.push(text),
    create: async ({ config: runtimeConfig }) => {
      assert.equal('wecom' in runtimeConfig, false);
      return {
        failure: new Promise<never>(() => {}),
        async wecomControl() { return { running: false }; },
        async start() { events.push('start'); },
        stopAcceptingIfIdle() { return true; },
        stopAccepting() { events.push('stop'); },
        async close() { events.push('close'); },
        async abort() { events.push('abort'); },
      };
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  assert.equal(await running, 130);
  assert.deepEqual(events, ['start', 'stop', 'close']);
  assert.match(output.join(''), /shared runtime is active/u);
});

test('background worker publishes readiness without terminal instructions', async () => {
  const controller = new AbortController();
  const output: string[] = [];
  let started = false;
  const running = runWorker({
    background: true,
    config: config(),
    signal: controller.signal,
    stdout: (text) => output.push(text),
    onStarted() { started = true; },
    create: async () => ({
      failure: new Promise<never>(() => {}),
      async wecomControl() { return { running: false }; },
      async start() {},
      stopAcceptingIfIdle() { return true; },
      stopAccepting() {},
      async close() {},
      async abort() {},
    }),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  controller.abort();
  assert.equal(await running, 130);
  assert.equal(output.join(''), 'Kintio shared runtime is active.\n');
});

test('iLink worker control exposes the Runtime atomic idle gate', async () => {
  const controller = new AbortController();
  const decisions = [false, true];
  let stopIfIdle: (() => boolean) | undefined;
  let calls = 0;
  const running = runWorker({
    background: true,
    config: config(),
    signal: controller.signal,
    stdout() {},
    onStarted(control) {
      stopIfIdle = control.stopIfIdleForUpdate;
    },
    create: async () => ({
      failure: new Promise<never>(() => {}),
      async wecomControl() { return { running: false }; },
      async start() {},
      stopAcceptingIfIdle() {
        calls += 1;
        return decisions.shift() ?? false;
      },
      stopAccepting() {},
      async close() {},
      async abort() {},
    }),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));

  assert.ok(stopIfIdle);
  assert.equal(stopIfIdle(), false);
  assert.equal(stopIfIdle(), true);
  assert.equal(calls, 2);

  controller.abort();
  assert.equal(await running, 130);
});

test('stopping the last account notifies its owner before closing the runtime', async () => {
  const events: string[] = [];
  let requestStop: (() => void) | undefined;
  const running = runWorker({
    config: config(),
    signal: new AbortController().signal,
    stdout() {},
    onStopRequested() { events.push('notify-owner'); },
    create: async ({ onStopRequested }) => {
      requestStop = onStopRequested;
      return {
        failure: new Promise<never>(() => {}),
        async wecomControl() { return { running: false }; },
        async start() { events.push('start'); },
        stopAcceptingIfIdle() { return true; },
        stopAccepting() { events.push('stop'); },
        async close() { events.push('close'); },
        async abort() { events.push('abort'); },
      };
    },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.ok(requestStop);
  requestStop();
  assert.equal(await running, 0);
  assert.deepEqual(events, ['start', 'notify-owner', 'stop', 'close']);
});

test('iLink start closes a runtime whose startup fails', async () => {
  const events: string[] = [];
  await assert.rejects(() => runWorker({
    config: config(),
    signal: new AbortController().signal,
    stdout() {},
    create: async () => ({
      failure: new Promise<never>(() => {}),
      async wecomControl() { return { running: false }; },
      async start() {
        events.push('start');
        throw new Error('simulated iLink startup failure');
      },
      stopAcceptingIfIdle() { return true; },
      stopAccepting() { events.push('stop'); },
      async close() { events.push('close'); },
      async abort() { events.push('abort'); },
    }),
  }), /simulated iLink startup failure/u);
  assert.deepEqual(events, ['start', 'stop', 'close']);
});

test('a pre-aborted iLink start creates no runtime', async () => {
  const controller = new AbortController();
  controller.abort();
  let created = false;
  assert.equal(await runWorker({
    config: config(),
    signal: controller.signal,
    stdout() {},
    create: async () => {
      created = true;
      throw new Error('must not create');
    },
  }), 130);
  assert.equal(created, false);
});

test('iLink start force-aborts after its bounded graceful shutdown', async () => {
  const base = config();
  const controller = new AbortController();
  const events: string[] = [];
  const running = runWorker({
    config: {
      ...base,
      state: { ...base.state, shutdownTimeoutMs: 5 },
    },
    signal: controller.signal,
    stdout() {},
    create: async () => ({
      failure: new Promise<never>(() => {}),
      async wecomControl() { return { running: false }; },
      async start() { events.push('start'); },
      stopAcceptingIfIdle() { return true; },
      stopAccepting() { events.push('stop'); },
      close() {
        events.push('close');
        return new Promise<void>(() => undefined);
      },
      async abort() { events.push('abort'); },
    }),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  controller.abort();
  await assert.rejects(() => running, /Graceful Kintio shutdown timed out/u);
  assert.deepEqual(events, ['start', 'stop', 'close', 'abort']);
});
