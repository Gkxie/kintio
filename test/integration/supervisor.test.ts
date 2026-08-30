import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { createConfig } from '../../src/config.ts';
import type { Runtime } from '../../src/runtime.ts';
import { KintioSupervisor } from '../../src/supervisor.ts';

interface Deferred {
  readonly promise: Promise<void>;
  readonly resolve: () => void;
}

function deferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((complete) => { resolve = complete; });
  return { promise, resolve };
}

async function availablePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

function fakeRuntime(
  events: string[],
  options: {
    readonly start?: () => Promise<void>;
    readonly close?: () => Promise<void>;
  } = {},
): Runtime {
  return {
    messageProcessor: null,
    async start() {
      events.push('runtime:start');
      await options.start?.();
    },
    async handleMcp() {
      return Response.json({ available: true });
    },
    async handleMemoryMcp() {
      return Response.json({ available: true });
    },
    async handleIlinkMcp() {
      return Response.json({ available: true });
    },
    stopAccepting() {
      events.push('runtime:stop-accepting');
    },
    async close() {
      events.push('runtime:close');
      await options.close?.();
    },
    async abort() {
      events.push('runtime:abort');
    },
  };
}

const logger = { info() {}, warn() {}, error() {} };

test('supervisor exposes MCP before starting message ingress', async () => {
  const port = await availablePort();
  const events: string[] = [];
  const supervisor = new KintioSupervisor({
    config: createConfig({ PORT: String(port), CODEX_ENABLED: 'false' }),
    logger,
    runtime: fakeRuntime(events, {
      async start() {
        const response = await fetch(`http://127.0.0.1:${port}/mcp`, {
          method: 'POST',
        });
        assert.equal(response.status, 200);
      },
    }),
  });

  assert.deepEqual(await supervisor.start(), { port });
  assert.equal(supervisor.state, 'running');
  assert.deepEqual(events, ['runtime:start']);
  await supervisor.close();
  await assert.rejects(supervisor.start(), /cannot start from closed/u);
});

test('WeChat callback ingress stays gated until all live listeners start', async () => {
  const port = await availablePort();
  const events: string[] = [];
  const supervisor = new KintioSupervisor({
    config: createConfig({
      PORT: String(port),
      WECOM_CALLBACK_TOKEN: 'SupervisorToken123',
      WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      CODEX_ENABLED: 'false',
    }),
    logger,
    runtime: fakeRuntime(events, {
      async start() {
        const gated = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
        assert.equal(gated.status, 503);
      },
    }),
  });

  await supervisor.start();
  const opened = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' });
  assert.notEqual(opened.status, 503);
  await supervisor.close();
});

test('graceful close stops ingress but keeps MCP online while runtime drains', async () => {
  const port = await availablePort();
  const events: string[] = [];
  const drain = deferred();
  const supervisor = new KintioSupervisor({
    config: createConfig({ PORT: String(port), CODEX_ENABLED: 'false' }),
    logger,
    runtime: fakeRuntime(events, { close: () => drain.promise }),
  });
  await supervisor.start();

  const closing = supervisor.close();
  while (!events.includes('runtime:close')) await new Promise((resolve) => setTimeout(resolve, 1));
  const mcp = await fetch(`http://127.0.0.1:${port}/mcp`, { method: 'POST' });
  assert.equal(mcp.status, 200);
  drain.resolve();
  await closing;
  assert.equal(supervisor.state, 'closed');
  assert.deepEqual(events, [
    'runtime:start',
    'runtime:stop-accepting',
    'runtime:close',
  ]);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
});

test('close during startup cancels readiness and releases both channel and runtime', async () => {
  const port = await availablePort();
  const events: string[] = [];
  const releaseStart = deferred();
  const enteredStart = deferred();
  const supervisor = new KintioSupervisor({
    config: createConfig({ PORT: String(port), CODEX_ENABLED: 'false' }),
    logger,
    runtime: fakeRuntime(events, {
      async start() {
        enteredStart.resolve();
        await releaseStart.promise;
      },
    }),
  });

  const starting = supervisor.start();
  await enteredStart.promise;
  const closing = supervisor.close();
  releaseStart.resolve();
  await assert.rejects(starting, /startup was cancelled/u);
  await closing;
  assert.equal(supervisor.state, 'closed');
  assert.deepEqual(events, [
    'runtime:start',
    'runtime:stop-accepting',
    'runtime:abort',
    'runtime:close',
  ]);
});

test('HTTP bind failure releases core resources without starting message ingress', async (t) => {
  const blocker = net.createServer();
  await new Promise<void>((resolve, reject) => {
    blocker.once('error', reject);
    blocker.listen(0, '127.0.0.1', resolve);
  });
  t.onTestFinished(() => new Promise<void>((resolve) => blocker.close(() => resolve())));
  const address = blocker.address();
  if (!address || typeof address === 'string') throw new Error('Missing blocked port');
  const events: string[] = [];
  const supervisor = new KintioSupervisor({
    config: createConfig({ PORT: String(address.port), CODEX_ENABLED: 'false' }),
    logger,
    runtime: fakeRuntime(events),
  });

  await assert.rejects(supervisor.start(), /EADDRINUSE/u);
  assert.deepEqual(events, [
    'runtime:stop-accepting',
    'runtime:abort',
    'runtime:close',
  ]);
});

test('runtime initialization failure closes the already-bound HTTP channel', async () => {
  const port = await availablePort();
  const events: string[] = [];
  const supervisor = new KintioSupervisor({
    config: createConfig({ PORT: String(port), CODEX_ENABLED: 'false' }),
    logger,
    runtime: fakeRuntime(events, {
      async start() {
        throw new Error('listener failed');
      },
    }),
  });

  await assert.rejects(supervisor.start(), /listener failed/u);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  assert.deepEqual(events, [
    'runtime:start',
    'runtime:stop-accepting',
    'runtime:abort',
  ]);
});

test('process abort stops ingress without claiming a graceful resource close', async () => {
  const port = await availablePort();
  const events: string[] = [];
  const supervisor = new KintioSupervisor({
    config: createConfig({ PORT: String(port), CODEX_ENABLED: 'false' }),
    logger,
    runtime: fakeRuntime(events),
  });
  await supervisor.start();

  await supervisor.abortForExit();
  assert.equal(supervisor.state, 'aborted');
  assert.deepEqual(events, [
    'runtime:start',
    'runtime:stop-accepting',
    'runtime:abort',
  ]);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/`));
  await assert.rejects(supervisor.start(), /cannot start from aborted/u);
});

test('constructing and closing an unstarted supervisor owns no runtime files', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'supervisor-lazy-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const databaseFile = path.join(root, 'state.sqlite');
  const supervisor = new KintioSupervisor({
    config: createConfig({
      PORT: String(await availablePort()),
      KINTIO_DB_FILE: databaseFile,
      CODEX_ENABLED: 'false',
    }),
    logger,
  });

  await assert.rejects(fs.access(databaseFile), { code: 'ENOENT' });
  await supervisor.close();
  await assert.rejects(fs.access(databaseFile), { code: 'ENOENT' });
});
