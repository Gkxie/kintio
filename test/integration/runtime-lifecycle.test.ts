import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test, vi } from 'vitest';
import type { TestContext } from 'vitest';

import { createApp } from '../../src/app.ts';
import { createConfig, loadIlinkRuntimeConfig, type AppConfig } from '../../src/config.ts';
import { McpIpcHost } from '../../src/mcp/ipc-host.ts';
import { createRuntime } from '../../src/runtime.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import { stableMessageKey } from '../../src/state/sqlite-store.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

async function workspace(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-lifecycle-'));
  t.onTestFinished(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function activeConfig(directory: string): AppConfig {
  return createConfig({
    WECOM_CALLBACK_TOKEN: 'RuntimeToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_CORP_ID: 'ww-runtime',
    WECOM_KF_SECRET: 'runtime-secret',
    ILINK_ENABLED: 'false',
    WECOM_ALLOWED_USER_IDS: 'wm-runtime',
    KINTIO_DB_FILE: path.join(directory, 'wecom.sqlite'),
    CODEX_WORKING_DIRECTORY: path.join(directory, 'codex-workspace'),
    CODEX_IMAGE_TMP_DIR: path.join(directory, 'images'),
  }, directory);
}

const logger = { info() {}, warn() {}, error() {} };

test('disabled runtime exposes complete no-op lifecycle', async (t) => {
  const directory = await workspace(t);
  const config = createConfig({
    WECOM_CALLBACK_TOKEN: 'RuntimeToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  }, directory);
  const runtime = await createRuntime({ config, logger });
  assert.equal(runtime.messageProcessor, null);
  await runtime.start();
  assert.equal(runtime.stopAcceptingIfIdle(), true);
  assert.equal(runtime.stopAcceptingIfIdle(), false);
  await assert.rejects(runtime.start(), /runtime is stopping/u);
  await runtime.abort();
  await runtime.close();
});

test('iLink-only runtime remains active without WeChat callback or KF API', async (t) => {
  const directory = await workspace(t);
  const databaseFile = path.join(directory, 'ilink-only.sqlite');
  const previousPersistence = new StatePersistence({ filePath: databaseFile });
  const previous = previousPersistence.core;
  previous.ingestSyncPage({
    accountKey: 'wk-disabled-channel',
    nextCursor: 'legacy-live',
    messages: [testWecomMessage({
      id: 'legacy-live', openKfId: 'wk-disabled-channel',
      externalUserId: 'wm-disabled-channel', text: 'must remain pending',
    })],
  });
  previous.ingestSyncPage({
    accountKey: 'wk-disabled-channel',
    expectedCursor: 'legacy-live',
    nextCursor: 'legacy-deferred',
    deferred: true,
    messages: [testWecomMessage({
      id: 'legacy-deferred', openKfId: 'wk-disabled-channel',
      externalUserId: 'wm-disabled-channel', text: 'must remain deferred',
    })],
  });
  previousPersistence.close();
  const config = loadIlinkRuntimeConfig({ environment: {
    KINTIO_DB_FILE: databaseFile,
    CODEX_WORKING_DIRECTORY: path.join(directory, 'codex-workspace'),
    CODEX_IMAGE_TMP_DIR: path.join(directory, 'images'),
  }, root: directory });
  const runtime = await createRuntime({ config, logger });
  t.onTestFinished(() => runtime.close());

  assert.equal(runtime.messageProcessor, null);
  await runtime.start();

  const app = createApp({ config: createConfig({}, directory), logger, messageProcessor: runtime.messageProcessor });
  const rootResponse = await app.request('/');
  assert.equal(await rootResponse.text(), 'hello world');
  assert.equal((await app.request('/', { method: 'POST' })).status, 404);
  for (const route of ['/mcp', '/mcp/memory', '/mcp/ilink']) {
    assert.equal((await app.request(route, { method: 'POST' })).status, 404);
  }
  await runtime.close();

  const preservedPersistence = new StatePersistence({ filePath: databaseFile });
  const preserved = preservedPersistence.core;
  t.onTestFinished(() => preservedPersistence.close());
  assert.deepEqual({
    live: preserved.getInbound(
      stableMessageKey('wechat_kf', 'wk-disabled-channel', 'legacy-live'),
    )?.status,
    deferred: preserved.getInbound(
      stableMessageKey('wechat_kf', 'wk-disabled-channel', 'legacy-deferred'),
    )?.deferred,
  }, { live: 'received', deferred: true });
});

test('active runtime stop/abort/close are safe and close releases the instance lock', async (t) => {
  const directory = await workspace(t);
  const config = activeConfig(directory);
  const runtime = await createRuntime({ config, logger });
  assert.ok(runtime.messageProcessor);
  await runtime.start();
  assert.equal(await fs.stat(config.state.lockFile).then(() => true), true);

  runtime.stopAccepting();
  await runtime.messageProcessor.enqueue({
    callbackToken: 'ignored-after-stop',
    openKfId: 'wk-runtime',
  });
  await runtime.abort();
  const firstClose = runtime.close();
  const secondClose = runtime.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
  await assert.rejects(fs.access(config.state.lockFile), { code: 'ENOENT' });
  await runtime.close();
});

test('MCP IPC startup failure rolls back SQLite and the instance lock', async (t) => {
  const directory = await workspace(t);
  const config = activeConfig(directory);
  const failed = vi.spyOn(McpIpcHost.prototype, 'start')
    .mockRejectedValue(new Error('MCP IPC bind failed'));
  await assert.rejects(createRuntime({ config, logger }), /MCP IPC bind failed/u);
  failed.mockRestore();
  await assert.rejects(fs.access(config.state.lockFile), { code: 'ENOENT' });

  const recovered = await createRuntime({ config, logger });
  await recovered.close();
});

test('runtime readiness does not wait for a blocked startup catch-up backlog', async (t) => {
  const directory = await workspace(t);
  const databaseFile = path.join(directory, 'catch-up.sqlite');
  const seededPersistence = new StatePersistence({ filePath: databaseFile });
  const seeded = seededPersistence.core;
  seeded.ingestSyncPage({
    accountKey: 'wk-catch-up',
    nextCursor: 'cursor-before-start',
    messages: [],
  });
  seededPersistence.close();

  let releaseSync!: () => void;
  const blockedSync = new Promise<void>((resolve) => { releaseSync = resolve; });
  let markSyncStarted!: () => void;
  const syncStarted = new Promise<void>((resolve) => { markSyncStarted = resolve; });
  const provider = http.createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    if (request.url?.startsWith('/cgi-bin/gettoken')) {
      response.end(JSON.stringify({
        errcode: 0,
        access_token: 'startup-token',
        expires_in: 7200,
      }));
      return;
    }
    markSyncStarted();
    await blockedSync;
    response.end(JSON.stringify({
      errcode: 0,
      next_cursor: 'cursor-after-start',
      has_more: 0,
      msg_list: [],
    }));
  });
  await new Promise<void>((resolve, reject) => {
    provider.once('error', reject);
    provider.listen(0, '127.0.0.1', resolve);
  });
  t.onTestFinished(async () => {
    releaseSync();
    await new Promise<void>((resolve) => provider.close(() => resolve()));
  });
  const address = provider.address();
  if (!address || typeof address === 'string') throw new Error('Missing provider port');
  const config = createConfig({
    WECOM_CALLBACK_TOKEN: 'RuntimeToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_CORP_ID: 'ww-runtime',
    WECOM_KF_SECRET: 'runtime-secret',
    ILINK_ENABLED: 'false',
    WECOM_API_BASE_URL: `http://127.0.0.1:${address.port}`,
    WECOM_API_TIMEOUT_MS: '5000',
    KINTIO_DB_FILE: databaseFile,
    CODEX_WORKING_DIRECTORY: path.join(directory, 'codex-workspace'),
    CODEX_IMAGE_TMP_DIR: path.join(directory, 'images'),
  }, directory);
  const runtime = await createRuntime({ config, logger });
  t.onTestFinished(() => runtime.close());

  const started = runtime.start();
  await syncStarted;
  await Promise.race([
    started,
    delay(500).then(() => {
      throw new Error('runtime readiness waited for startup catch-up');
    }),
  ]);
  assert.equal(runtime.stopAcceptingIfIdle(), false);
  assert.equal(await runtime.start(), undefined);
  releaseSync();
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && !runtime.stopAcceptingIfIdle()) await delay(10);
  await assert.rejects(runtime.start(), /runtime is stopping/u);
  await runtime.close();
});
