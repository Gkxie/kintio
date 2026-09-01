import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import { loadIlinkRuntimeConfig } from '../../src/config.ts';
import { startIlinkCliRuntime } from '../../src/ilink/cli-start.ts';

function config() {
  return loadIlinkRuntimeConfig({
    environment: {},
    root: path.join(os.tmpdir(), 'kintio-ilink-cli-start'),
  });
}

test('iLink start runs and drains a foreground runtime without Hono', async () => {
  const events: string[] = [];
  const output: string[] = [];
  const controller = new AbortController();
  const running = startIlinkCliRuntime({
    config: config(),
    signal: controller.signal,
    stdout: (text) => output.push(text),
    create: async ({ config: runtimeConfig }) => {
      assert.equal(runtimeConfig.wecom, undefined);
      return {
        messageProcessor: null,
        async start() { events.push('start'); },
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
  assert.match(output.join(''), /iLink runtime is active/u);
});

test('background worker publishes readiness without terminal instructions', async () => {
  const controller = new AbortController();
  const output: string[] = [];
  let started = false;
  const running = startIlinkCliRuntime({
    background: true,
    config: config(),
    signal: controller.signal,
    stdout: (text) => output.push(text),
    onStarted() { started = true; },
    create: async () => ({
      messageProcessor: null,
      async start() {},
      stopAccepting() {},
      async close() {},
      async abort() {},
    }),
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(started, true);
  controller.abort();
  assert.equal(await running, 130);
  assert.equal(output.join(''), 'Kintio iLink runtime is active.\n');
});

test('stopping the last account closes a foreground iLink runtime successfully', async () => {
  const events: string[] = [];
  let requestStop: (() => void) | undefined;
  const running = startIlinkCliRuntime({
    config: config(),
    signal: new AbortController().signal,
    stdout() {},
    create: async ({ onIlinkStopRequested }) => {
      requestStop = onIlinkStopRequested;
      return {
        messageProcessor: null,
        async start() { events.push('start'); },
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
  assert.deepEqual(events, ['start', 'stop', 'close']);
});

test('iLink start closes a runtime whose startup fails', async () => {
  const events: string[] = [];
  await assert.rejects(() => startIlinkCliRuntime({
    config: config(),
    signal: new AbortController().signal,
    stdout() {},
    create: async () => ({
      messageProcessor: null,
      async start() {
        events.push('start');
        throw new Error('simulated iLink startup failure');
      },
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
  assert.equal(await startIlinkCliRuntime({
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
  const running = startIlinkCliRuntime({
    config: {
      ...base,
      state: { ...base.state, shutdownTimeoutMs: 5 },
    },
    signal: controller.signal,
    stdout() {},
    create: async () => ({
      messageProcessor: null,
      async start() { events.push('start'); },
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
  await assert.rejects(() => running, /Graceful iLink shutdown timed out/u);
  assert.deepEqual(events, ['start', 'stop', 'close', 'abort']);
});
