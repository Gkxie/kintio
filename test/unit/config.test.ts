import assert from 'node:assert/strict';
import { describe, it, test } from 'vitest';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

import {
  createConfig,
  loadConfig,
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
});

describe('independent channel activation', () => {
  it('allows iLink with no WeChat callback or KF API credentials', () => {
    const kintioDatabase = path.join(os.tmpdir(), 'kintio-test.sqlite');
    const talkFerryDatabase = path.join(os.tmpdir(), 'talkferry-test.sqlite');
    const config = createConfig({
      ILINK_ENABLED: 'true',
      KINTIO_DB_FILE: kintioDatabase,
      TALKFERRY_DB_FILE: talkFerryDatabase,
    });

    assert.equal(config.wecom.api.enabled, false);
    assert.equal(config.wecom.callbackToken, '');
    assert.equal(config.wecom.encodingAesKey, '');
    assert.equal(config.ilink.enabled, true);
    assert.equal(config.codex.enabled, true);
    assert.equal(config.state.databaseFile, kintioDatabase);
    assert.equal(config.state.lockFile, path.join(os.tmpdir(), 'kintio.lock'));
  });

  it('does not infer iLink activation from WeChat KF credentials', () => {
    assert.throws(() => createConfig({
      WECOM_CORP_ID: 'ww-explicit-channel',
      WECOM_KF_SECRET: 'secret',
    }), /ILINK_ENABLED must be explicitly true or false/u);
    const config = createConfig({
      WECOM_CORP_ID: 'ww-explicit-channel',
      WECOM_KF_SECRET: 'secret',
      ILINK_ENABLED: 'false',
    });
    assert.equal(config.wecom.api.enabled, true);
    assert.equal(config.ilink.enabled, false);
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

test('an instance root owns relative config, state, cache, and workspace paths', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-instance-root-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'instance.env');
  await fs.writeFile(configFile, [
    'PORT=9123',
    'KINTIO_DB_FILE=./state/kintio.sqlite',
    'CODEX_WORKING_DIRECTORY=./workspace',
    'CODEX_IMAGE_TMP_DIR=./cache/images',
  ].join('\n'));
  const environment: NodeJS.ProcessEnv = { PORT: '9234' };
  const config = loadConfig({ environment, envFile: configFile, root });

  assert.equal(config.port, 9234);
  assert.equal(config.state.databaseFile, path.join(root, 'state/kintio.sqlite'));
  assert.equal(config.state.lockFile, path.join(root, 'state/kintio.lock'));
  assert.equal(config.codex.workingDirectory, path.join(root, 'workspace'));
  assert.equal(config.codex.imageTempDirectory, path.join(root, 'cache/images'));
  assert.equal(config.ilink.storageKeyFile, path.join(root, 'state/ilink-storage.key'));
});

test('KINTIO_CONFIG_FILE selects its directory when no instance root is supplied', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-config-file-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const configFile = path.join(root, 'custom.env');
  await fs.writeFile(configFile, 'CODEX_WORKING_DIRECTORY=./agent-work\n');
  const config = loadConfig({
    environment: { KINTIO_CONFIG_FILE: configFile },
  });

  assert.equal(config.state.databaseFile, path.join(root, 'data/kintio.sqlite'));
  assert.equal(config.codex.workingDirectory, path.join(root, 'agent-work'));
});

test('default config loading does not copy file values into process.env', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-env-scope-'));
  const configFile = path.join(root, 'instance.env');
  const name = 'KINTIO_CONFIG_TEST_CANARY';
  const previous = process.env[name];
  delete process.env[name];
  await fs.writeFile(configFile, `${name}=file-only-value\n`);
  t.onTestFinished(async () => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
    await fs.rm(root, { recursive: true, force: true });
  });

  loadConfig({ envFile: configFile, root });
  assert.equal(process.env[name], undefined);
  loadConfig({ environment: process.env, envFile: configFile, root });
  assert.equal(process.env[name], undefined);
});

test('Windows environment names remain case-insensitive before file fallback', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-env-case-'));
  const envFile = path.join(root, '.env');
  await fs.writeFile(envFile, 'PORT=9001\n');
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));

  const config = loadConfig({ environment: { port: '9000' }, envFile, root });
  assert.equal(config.port, process.platform === 'win32' ? 9000 : 9001);
});

test('fresh state uses Kintio names while an existing legacy database stays in place', () => {
  const root = path.join(os.tmpdir(), 'kintio-state-root');
  const data = path.join(root, 'data');
  const explicitKintio = path.join(os.tmpdir(), 'kintio-explicit', 'state.sqlite');
  const explicitTalkFerry = path.join(os.tmpdir(), 'talkferry-explicit', 'state.sqlite');
  assert.deepEqual(resolveStateFiles({}, root, () => false), {
    databaseFile: path.join(data, 'kintio.sqlite'),
    lockFile: path.join(data, 'kintio.lock'),
  });
  assert.deepEqual(resolveStateFiles({}, root, (filePath) =>
    filePath === path.join(data, 'talkferry.sqlite')
  ), {
    databaseFile: path.join(data, 'talkferry.sqlite'),
    lockFile: path.join(data, 'talkferry.lock'),
  });
  assert.deepEqual(resolveStateFiles({}, root, (filePath) =>
    filePath === path.join(data, 'wecom.sqlite')
  ), {
    databaseFile: path.join(data, 'wecom.sqlite'),
    lockFile: path.join(data, 'wecom.lock'),
  });
  assert.deepEqual(resolveStateFiles({
    KINTIO_DB_FILE: explicitKintio,
  }, root, () => true), {
    databaseFile: explicitKintio,
    lockFile: path.join(path.dirname(explicitKintio), 'kintio.lock'),
  });
  assert.deepEqual(resolveStateFiles({
    TALKFERRY_DB_FILE: explicitTalkFerry,
  }, root, () => false), {
    databaseFile: explicitTalkFerry,
    lockFile: path.join(path.dirname(explicitTalkFerry), 'talkferry.lock'),
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
    /Multiple default state databases exist/u,
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
  assert.equal(path.basename(config.codex.imageTempDirectory), 'codex-input');
  assert.equal(path.basename(path.dirname(config.codex.imageTempDirectory)), 'data');
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

test('allowed users and channel runtime defaults are parsed', () => {
  const config = createConfig({
    ...callbackEnvironment,
    WECOM_CORP_ID: 'ww-test',
    WECOM_KF_SECRET: 'secret',
    WECOM_ALLOWED_USER_IDS: 'wm-one, wm-two',
    WECOM_AUTH_TRIGGER: '发车',
    WECOM_AUTH_TRIGGER_COUNT: '3',
    WECOM_AUTH_CONFIRMATION: '暗号确认，请继续对话',
    ILINK_ENABLED: 'true',
    ILINK_STORAGE_KEY: 'i'.repeat(43),
  });

  assert.equal(config.wecom.api.enabled, true);
  assert.equal(config.wecom.api.observeMs, 5_000);
  assert.equal(config.wecom.api.baseUrl, 'https://qyapi.weixin.qq.com');
  assert.deepEqual(config.wecom.allowedUserIds, ['wm-one', 'wm-two']);
  assert.equal(config.wecom.authorization.trigger, '发车');
  assert.equal(config.wecom.authorization.requiredConsecutive, 3);
  assert.equal(
    config.wecom.authorization.confirmationText,
    '暗号确认，请继续对话',
  );
  assert.equal(config.codex.enabled, true);
  assert.equal(config.wecom.expectedReceiveId, 'ww-test');
  assert.equal(config.ilink.enabled, true);
  assert.equal(config.ilink.storageKey, 'i'.repeat(43));
  assert.equal(config.ilink.longPollTimeoutMs, 35_000);
  assert.equal(config.ilink.maxAccounts, 20);
});

test('legacy harness database alias remains compatible', () => {
  const databaseFile = path.join(os.tmpdir(), 'legacy-kintio.sqlite');
  const config = createConfig({
    ILINK_ENABLED: 'true',
    HARNESS_DB_FILE: databaseFile,
  });

  assert.equal(config.state.databaseFile, databaseFile);
  assert.equal(config.state.lockFile, path.join(os.tmpdir(), 'wecom.lock'));
});

test('TalkFerry configuration aliases remain compatible for upgrades', () => {
  const databaseFile = path.join(os.tmpdir(), 'talkferry-state.sqlite');
  const config = createConfig({
    ILINK_ENABLED: 'true',
    TALKFERRY_DB_FILE: databaseFile,
  });

  assert.equal(config.state.databaseFile, databaseFile);
  assert.equal(config.state.lockFile, path.join(os.tmpdir(), 'talkferry.lock'));
});
