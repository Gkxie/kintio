import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { createApp } from '../../src/app.ts';
import { createConfig, type AppConfig } from '../../src/config.ts';
import { createRuntime } from '../../src/runtime.ts';

async function workspace(t: TestContext): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-lifecycle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return directory;
}

function activeConfig(directory: string): AppConfig {
  return createConfig({
    WECOM_CALLBACK_TOKEN: 'RuntimeToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_CORP_ID: 'ww-runtime',
    WECOM_KF_SECRET: 'runtime-secret',
    WECOM_ALLOWED_USER_IDS: 'wm-runtime',
    WECOM_DB_FILE: path.join(directory, 'wecom.sqlite'),
    WECOM_STATE_FILE: path.join(directory, 'wecom-state.json'),
    WECOM_LEGACY_JOURNAL_FILE: path.join(directory, 'legacy-journal.sqlite'),
    WECOM_BOT_PAUSE_FILE: path.join(directory, 'legacy-paused'),
    CODEX_WORKING_DIRECTORY: path.join(directory, 'codex-workspace'),
    CODEX_IMAGE_TMP_DIR: path.join(directory, 'images'),
  });
}

const logger = { info() {}, warn() {}, error() {} };

test('[G03][DEP01] disabled runtime exposes complete no-op lifecycle', async () => {
  const config = createConfig({
    WECOM_CALLBACK_TOKEN: 'RuntimeToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  });
  const runtime = createRuntime({ config, logger });
  assert.equal(runtime.messageProcessor, null);
  runtime.stopAccepting();
  await runtime.abort();
  await runtime.close();
});

test('[DEP01] active runtime stop/abort/close are safe and close releases the instance lock', async (t) => {
  const directory = await workspace(t);
  const config = activeConfig(directory);
  const runtime = createRuntime({ config, logger });
  assert.ok(runtime.messageProcessor);
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

test('[D02] active startup rejects legacy JSON until offline migration and releases its lock', async (t) => {
  const directory = await workspace(t);
  const config = activeConfig(directory);
  await fs.writeFile(config.state.legacyStateFile, JSON.stringify({
    version: 1,
    cursors: { 'wk-legacy': 'legacy-cursor' },
    threads: {},
    messages: {},
    sessions: {},
    inboundMedia: {},
    customerAuthorizations: {},
  }), { mode: 0o600 });

  assert.throws(
    () => createRuntime({ config, logger }),
    /run pnpm run migrate/u,
  );
  await fs.access(config.state.legacyStateFile);
  await assert.rejects(fs.access(config.state.databaseFile), { code: 'ENOENT' });
  await assert.rejects(fs.access(config.state.lockFile), { code: 'ENOENT' });
});

test('[DEP01] app stopAccepting, abort, and shutdown hooks delegate active lifecycle', async (t) => {
  const directory = await workspace(t);
  const config = activeConfig(directory);
  const app = createApp({ config, logger });
  assert.equal((await app.request('/healthz')).status, 200);
  app.stopAccepting();
  await app.abort();
  await app.shutdown();
  await assert.rejects(fs.access(config.state.lockFile), { code: 'ENOENT' });
  await app.shutdown();
});
