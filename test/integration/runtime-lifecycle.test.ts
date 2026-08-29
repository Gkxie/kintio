import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';

import { createApp } from '../../src/app.ts';
import { createConfig, type AppConfig } from '../../src/config.ts';
import { createRuntime } from '../../src/runtime.ts';
import { SqliteStore, stableMessageKey } from '../../src/state/sqlite-store.ts';
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
    WECOM_MCP_BEARER_TOKEN: 'r'.repeat(32),
    WECOM_ALLOWED_USER_IDS: 'wm-runtime',
    WECOM_DB_FILE: path.join(directory, 'wecom.sqlite'),
    CODEX_WORKING_DIRECTORY: path.join(directory, 'codex-workspace'),
    CODEX_IMAGE_TMP_DIR: path.join(directory, 'images'),
  });
}

const logger = { info() {}, warn() {}, error() {} };

test('disabled runtime exposes complete no-op lifecycle', async () => {
  const config = createConfig({
    WECOM_CALLBACK_TOKEN: 'RuntimeToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  });
  const runtime = createRuntime({ config, logger });
  assert.equal(runtime.messageProcessor, null);
  await runtime.start();
  assert.equal((await runtime.handleMcp(new Request('http://localhost/mcp'))).status, 503);
  runtime.stopAccepting();
  await runtime.abort();
  await runtime.close();
});

test('iLink-only runtime remains active without WeChat callback or KF API', async (t) => {
  const directory = await workspace(t);
  const databaseFile = path.join(directory, 'ilink-only.sqlite');
  const previous = new SqliteStore({ filePath: databaseFile });
  previous.ingestSyncPage({
    openKfId: 'wk-disabled-channel',
    nextCursor: 'legacy-live',
    messages: [testWecomMessage({
      id: 'legacy-live', openKfId: 'wk-disabled-channel',
      externalUserId: 'wm-disabled-channel', text: 'must remain pending',
    })],
  });
  previous.ingestSyncPage({
    openKfId: 'wk-disabled-channel',
    expectedCursor: 'legacy-live',
    nextCursor: 'legacy-deferred',
    deferred: true,
    messages: [testWecomMessage({
      id: 'legacy-deferred', openKfId: 'wk-disabled-channel',
      externalUserId: 'wm-disabled-channel', text: 'must remain deferred',
    })],
  });
  previous.close();
  const config = createConfig({
    ILINK_ENABLED: 'true',
    HARNESS_MCP_BEARER_TOKEN: 'i'.repeat(32),
    HARNESS_DB_FILE: databaseFile,
    CODEX_WORKING_DIRECTORY: path.join(directory, 'codex-workspace'),
    CODEX_IMAGE_TMP_DIR: path.join(directory, 'images'),
  });
  const runtime = createRuntime({ config, logger });
  t.onTestFinished(() => runtime.close());

  assert.equal(runtime.messageProcessor, null);
  await runtime.start();
  assert.equal((await runtime.handleMcp(new Request('http://localhost/mcp'))).status, 503);
  assert.equal(
    (await runtime.handleIlinkMcp(new Request('http://localhost/mcp/ilink'))).status,
    401,
  );
  await runtime.close();

  const app = createApp({ config, logger });
  const rootResponse = await app.request('/');
  assert.equal(await rootResponse.text(), 'hello world');
  assert.equal((await app.request('/', { method: 'POST' })).status, 404);
  assert.equal((await app.request('/mcp/ilink', { method: 'POST' })).status, 401);
  await app.shutdown();

  const preserved = new SqliteStore({ filePath: databaseFile });
  t.onTestFinished(() => preserved.close());
  assert.deepEqual({
    live: preserved.getInbound(
      stableMessageKey('wk-disabled-channel', 'legacy-live'),
    )?.status,
    deferred: preserved.getInbound(
      stableMessageKey('wk-disabled-channel', 'legacy-deferred'),
    )?.deferred,
  }, { live: 'received', deferred: true });
});

test('app with an injected processor has no-op lifecycle hooks', async () => {
  const config = createConfig({
    WECOM_CALLBACK_TOKEN: 'RuntimeToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  });
  const app = createApp({ config, logger, messageProcessor: null });
  await app.start();
  app.stopAccepting();
  await app.abort();
  await app.shutdown();
  assert.equal((await app.request('/healthz')).status, 200);
});

test('active runtime stop/abort/close are safe and close releases the instance lock', async (t) => {
  const directory = await workspace(t);
  const config = activeConfig(directory);
  const runtime = createRuntime({ config, logger });
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

test('app stopAccepting, abort, and shutdown hooks delegate active lifecycle', async (t) => {
  const directory = await workspace(t);
  const config = activeConfig(directory);
  const app = createApp({ config, logger });
  await app.start();
  assert.equal((await app.request('/healthz')).status, 200);
  assert.equal((await app.request('/mcp', { method: 'POST' })).status, 401);
  assert.equal((await app.request('/mcp/ilink', { method: 'POST' })).status, 401);
  app.stopAccepting();
  await app.abort();
  await app.shutdown();
  await assert.rejects(fs.access(config.state.lockFile), { code: 'ENOENT' });
  await app.shutdown();
});
