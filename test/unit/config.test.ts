import assert from 'node:assert/strict';
import { describe, it, test } from 'vitest';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

import {
  createConfig,
  resolveProjectRoot,
  resolveStateFiles,
} from '../../src/config.ts';

const callbackEnvironment = {
  WECOM_CALLBACK_TOKEN: 'CallbackToken123',
  WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
};

test('.env.example is safe to copy before choosing a channel', async () => {
  const environment = parseEnv(await fs.readFile('.env.example', 'utf8'));
  const config = createConfig(environment);

  assert.equal(config.wecom.callbackToken, '');
  assert.equal(config.wecom.encodingAesKey, '');
  assert.equal(config.wecom.api.enabled, false);
  assert.equal(config.ilink.enabled, false);
  assert.equal(config.wecom.mcp.bearerToken, '');
});

describe('independent channel activation', () => {
  it('allows iLink with no WeChat callback or KF API credentials', () => {
    const config = createConfig({
      ILINK_ENABLED: 'true',
      KINTIO_MCP_BEARER_TOKEN: 'i'.repeat(32),
      KINTIO_MCP_URL: 'https://chat.example.com/mcp',
      KINTIO_DB_FILE: '/tmp/kintio-test.sqlite',
      TALKFERRY_MCP_BEARER_TOKEN: 't'.repeat(32),
      TALKFERRY_MCP_URL: 'https://legacy-talkferry.example.com/mcp',
      TALKFERRY_DB_FILE: '/tmp/talkferry-test.sqlite',
    });

    assert.equal(config.wecom.api.enabled, false);
    assert.equal(config.wecom.callbackToken, '');
    assert.equal(config.wecom.encodingAesKey, '');
    assert.equal(config.ilink.enabled, true);
    assert.equal(config.codex.enabled, true);
    assert.equal(config.wecom.mcp.url, 'https://chat.example.com/mcp');
    assert.equal(config.state.databaseFile, '/tmp/kintio-test.sqlite');
    assert.equal(config.state.lockFile, '/tmp/kintio.lock');
  });

  it('keeps callback credentials paired when the callback is enabled', () => {
    assert.throws(
      () => createConfig({ WECOM_CALLBACK_TOKEN: 'CallbackToken123' }),
      /WECOM_CALLBACK_TOKEN and WECOM_ENCODING_AES_KEY/u,
    );
    assert.throws(
      () => createConfig({
        WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
      }),
      /WECOM_CALLBACK_TOKEN and WECOM_ENCODING_AES_KEY/u,
    );
  });
});

test('source and compiled config resolve the same project root', () => {
  const root = path.resolve('.');
  assert.equal(
    resolveProjectRoot(pathToFileURL(path.join(root, 'src/config.ts')).href),
    root,
  );
  assert.equal(
    resolveProjectRoot(pathToFileURL(path.join(root, 'dist/src/config.js')).href),
    root,
  );
});

test('fresh state uses Kintio names while an existing legacy database stays in place', () => {
  const root = '/srv/kintio';
  assert.deepEqual(resolveStateFiles({}, root, () => false), {
    databaseFile: '/srv/kintio/data/kintio.sqlite',
    lockFile: '/srv/kintio/data/kintio.lock',
  });
  assert.deepEqual(resolveStateFiles({}, root, (filePath) =>
    filePath === '/srv/kintio/data/talkferry.sqlite'
  ), {
    databaseFile: '/srv/kintio/data/talkferry.sqlite',
    lockFile: '/srv/kintio/data/talkferry.lock',
  });
  assert.deepEqual(resolveStateFiles({}, root, (filePath) =>
    filePath === '/srv/kintio/data/wecom.sqlite'
  ), {
    databaseFile: '/srv/kintio/data/wecom.sqlite',
    lockFile: '/srv/kintio/data/wecom.lock',
  });
  assert.deepEqual(resolveStateFiles({
    KINTIO_DB_FILE: '/var/lib/kintio/state.sqlite',
  }, root, () => true), {
    databaseFile: '/var/lib/kintio/state.sqlite',
    lockFile: '/var/lib/kintio/kintio.lock',
  });
  assert.deepEqual(resolveStateFiles({
    TALKFERRY_DB_FILE: '/var/lib/talkferry/state.sqlite',
  }, root, () => false), {
    databaseFile: '/var/lib/talkferry/state.sqlite',
    lockFile: '/var/lib/talkferry/talkferry.lock',
  });
});

test('state selection rejects ambiguous new and legacy databases', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-state-selection-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  await Promise.all([
    fs.writeFile(path.join(root, 'data/kintio.sqlite'), ''),
    fs.writeFile(path.join(root, 'data/talkferry.sqlite'), ''),
    fs.writeFile(path.join(root, 'data/wecom.sqlite'), ''),
  ]);
  assert.throws(
    () => resolveStateFiles({}, root),
    /Multiple default state databases exist \(data\/kintio\.sqlite, data\/talkferry\.sqlite, data\/wecom\.sqlite\)/u,
  );
  assert.deepEqual(resolveStateFiles({
    KINTIO_DB_FILE: path.join(root, 'data/wecom.sqlite'),
  }, root), {
    databaseFile: path.join(root, 'data/wecom.sqlite'),
    lockFile: path.join(root, 'data/wecom.lock'),
  });
});

test('message processing remains disabled until CorpID and Secret are present', () => {
  const config = createConfig(callbackEnvironment);

  assert.equal(config.port, 8888);
  assert.equal(config.wecom.api.enabled, false);
  assert.equal(config.codex.enabled, false);
  assert.equal(config.ilink.enabled, false);
  assert.equal(config.ilink.baseUrl, 'https://ilinkai.weixin.qq.com/');
  assert.equal(config.ilink.mcpUrl, 'http://127.0.0.1:8888/mcp/ilink');
  assert.equal(config.codex.webSearchMode, 'live');
  assert.match(config.codex.imageTempDirectory, /data\/codex-input$/u);
  assert.equal(
    config.codex.generatedImageDirectory,
    path.join(config.codex.workingDirectory, 'generated_images'),
  );
  assert.equal(config.wecom.authorization.trigger, '');
  assert.equal(config.wecom.authorization.requiredConsecutive, 3);
  assert.equal(
    config.wecom.authorization.confirmationText,
    'Code accepted. You can continue the conversation.',
  );
});

test('CorpID and WeChat KF Secret must be configured together', () => {
  assert.throws(
    () =>
      createConfig({
        ...callbackEnvironment,
        WECOM_CORP_ID: 'ww-test',
      }),
    /must be configured together/,
  );
});

test('allowed users and safe Codex defaults are parsed', () => {
  const config = createConfig({
    ...callbackEnvironment,
    WECOM_CORP_ID: 'ww-test',
    WECOM_KF_SECRET: 'secret',
    KINTIO_MCP_BEARER_TOKEN: 'a'.repeat(32),
    WECOM_ALLOWED_USER_IDS: 'wm-one, wm-two',
    WECOM_AUTH_TRIGGER: '发车',
    WECOM_AUTH_TRIGGER_COUNT: '3',
    WECOM_AUTH_CONFIRMATION: '暗号确认，请继续对话',
    CODEX_MODEL: 'gpt-5.6-luna',
    CODEX_REASONING_EFFORT: 'none',
    ILINK_ENABLED: 'true',
    ILINK_STORAGE_KEY: 'i'.repeat(43),
  });

  assert.equal(config.wecom.api.enabled, true);
  assert.equal(config.wecom.api.observeMs, 5_000);
  assert.equal(config.wecom.api.baseUrl, 'https://qyapi.weixin.qq.com');
  assert.equal(config.wecom.mcp.url, 'http://127.0.0.1:8888/mcp');
  assert.equal(config.wecom.mcp.memoryUrl, 'http://127.0.0.1:8888/mcp/memory');
  assert.equal(config.wecom.mcp.bearerToken, 'a'.repeat(32));
  assert.deepEqual(config.wecom.allowedUserIds, ['wm-one', 'wm-two']);
  assert.equal(config.wecom.authorization.trigger, '发车');
  assert.equal(config.wecom.authorization.requiredConsecutive, 3);
  assert.equal(
    config.wecom.authorization.confirmationText,
    '暗号确认，请继续对话',
  );
  assert.equal(config.codex.enabled, true);
  assert.equal(config.wecom.expectedReceiveId, 'ww-test');
  assert.equal(config.codex.webSearchMode, 'live');
  assert.equal(config.codex.pathOverride, 'codex');
  assert.equal(config.codex.model, 'gpt-5.6-luna');
  assert.equal(config.codex.reasoningEffort, 'none');
  assert.equal(config.ilink.enabled, true);
  assert.equal(config.ilink.storageKey, 'i'.repeat(43));
  assert.equal(config.ilink.longPollTimeoutMs, 35_000);
  assert.equal(config.ilink.maxAccounts, 20);
});

test('legacy harness MCP and database aliases remain compatible', () => {
  const config = createConfig({
    ILINK_ENABLED: 'true',
    HARNESS_MCP_BEARER_TOKEN: 'l'.repeat(32),
    HARNESS_MCP_URL: 'https://legacy.example.com/mcp',
    HARNESS_DB_FILE: '/tmp/legacy-kintio.sqlite',
  });

  assert.equal(config.wecom.mcp.bearerToken, 'l'.repeat(32));
  assert.equal(config.wecom.mcp.url, 'https://legacy.example.com/mcp');
  assert.equal(config.state.databaseFile, '/tmp/legacy-kintio.sqlite');
  assert.equal(config.state.lockFile, '/tmp/wecom.lock');
});

test('TalkFerry configuration aliases remain compatible for upgrades', () => {
  const config = createConfig({
    ILINK_ENABLED: 'true',
    TALKFERRY_MCP_BEARER_TOKEN: 't'.repeat(32),
    TALKFERRY_MCP_URL: 'https://talkferry.example.com/mcp',
    TALKFERRY_DB_FILE: '/tmp/talkferry-state.sqlite',
  });

  assert.equal(config.wecom.mcp.bearerToken, 't'.repeat(32));
  assert.equal(config.wecom.mcp.url, 'https://talkferry.example.com/mcp');
  assert.equal(config.state.databaseFile, '/tmp/talkferry-state.sqlite');
  assert.equal(config.state.lockFile, '/tmp/talkferry.lock');
});
