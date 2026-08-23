import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { createConfig } from '../src/config.js';
import { createRuntime } from '../src/runtime.js';

test('runtime forwards deferred steering context into Codex app-server', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-runtime-steering-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const config = createConfig({
    WECOM_CALLBACK_TOKEN: 'CallbackToken123',
    WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
    WECOM_CORP_ID: 'ww-test',
    WECOM_KF_SECRET: 'secret',
    WECOM_ALLOWED_USER_IDS: 'wm-one',
    WECOM_STATE_FILE: path.join(directory, 'state.json'),
    CODEX_MODEL: 'gpt-test',
    CODEX_REASONING_EFFORT: 'none',
  });
  const runtime = createRuntime({
    config,
    logger: { info() {}, warn() {}, error() {} },
  });
  const mediaCatalogFile = path.join(directory, 'media-catalog.json');
  const client = runtime.responder.codexFactory({
    conversation: { openKfId: 'wk-one', externalUserId: 'wm-one' },
    mediaCatalog: [],
    mediaCatalogFile,
    deferSends: true,
    turnId: 'message-one',
  });

  assert.equal(client.env.WECOM_TOOL_DEFER_SEND, 'true');
  assert.equal(client.env.WECOM_TOOL_MEDIA_CATALOG_FILE, mediaCatalogFile);
  assert.equal(client.env.WECOM_TOOL_OPEN_KFID, 'wk-one');
  assert.equal(client.env.WECOM_TOOL_EXTERNAL_USER_ID, 'wm-one');
  assert.ok(
    client.configOverrides.some(
      (override) =>
        override.includes('mcp_servers.wechat_kf.env_vars') &&
        override.includes('WECOM_TOOL_DEFER_SEND'),
    ),
  );
  await client.close();
  await runtime.messageProcessor.close();
});
