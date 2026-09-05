import assert from 'node:assert/strict';
import { describe, it, test } from 'vitest';

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';

import {
  createConfig,
  INSTANCE_CONFIG_TEMPLATE,
  loadConfig,
  loadIlinkEnrollmentConfig,
  loadIlinkRuntimeConfig,
  resolveProjectRoot,
  resolveStateFiles,
} from '../../src/config.ts';

const callbackEnvironment = {
  WECOM_CALLBACK_TOKEN: 'CallbackToken123',
  WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
};

const isolatedRoot = path.join(os.tmpdir(), 'kintio-config-test-isolated');

function testConfig(
  environment: NodeJS.ProcessEnv,
  root = isolatedRoot,
  platform: NodeJS.Platform = process.platform,
) {
  return createConfig(environment, root, platform);
}

test('the generated instance config is specific to WeCom and safe before credentials are filled', () => {
  const environment = parseEnv(INSTANCE_CONFIG_TEMPLATE);
  const config = testConfig(environment);

  assert.equal(config.wecom.callbackToken, '');
  assert.equal(config.wecom.encodingAesKey, '');
  assert.equal(config.wecom.api.enabled, false);
  assert.equal('ilink' in config, false);
});

describe('independent channel activation', () => {
  it('allows iLink with no WeChat callback or KF API credentials', () => {
    const kintioDatabase = path.join(os.tmpdir(), 'kintio-test.sqlite');
    const config = loadIlinkRuntimeConfig({ environment: {
      KINTIO_DB_FILE: kintioDatabase,
    }, root: os.tmpdir() });

    assert.equal('wecom' in config, false);
    assert.ok(config.ilink);
    assert.equal(config.codex.enabled, true);
    assert.equal(config.state.databaseFile, kintioDatabase);
    assert.equal(config.state.lockFile, path.join(os.tmpdir(), 'kintio.lock'));
  });

  it('does not infer iLink activation from WeChat KF credentials', () => {
    const config = testConfig({
      WECOM_CORP_ID: 'ww-explicit-channel',
      WECOM_KF_SECRET: 'secret',
      ILINK_ENABLED: 'true',
      ILINK_STORAGE_KEY: 'invalid-but-unrelated',
    });
    assert.equal(config.wecom.api.enabled, true);
    assert.equal('ilink' in config, false);
  });

  it('keeps callback credentials paired when the callback is enabled', () => {
    assert.throws(
      () => testConfig({ WECOM_CALLBACK_TOKEN: 'CallbackToken123' }),
      /WECOM_CALLBACK_TOKEN and WECOM_ENCODING_AES_KEY/u,
    );
    assert.throws(
      () => testConfig({
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

test('direct config loading defaults mutable state to the user instance', async (t) => {
  const profile = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-default-profile-'));
  t.onTestFinished(() => fs.rm(profile, { recursive: true, force: true }));
  const instance = path.join(profile, '.kintio', 'wecom');
  const config = loadConfig({ environment: {}, homeDirectory: profile });

  assert.equal(config.state.databaseFile, path.join(instance, 'data/kintio.sqlite'));
  assert.equal(config.state.lockFile, path.join(instance, 'data/kintio.lock'));
  assert.equal(config.codex.imageTempDirectory, path.join(instance, 'data/codex-input'));
  assert.equal(config.codex.workingDirectory, path.join(instance, 'codex-workspace'));
});

test('standalone iLink config ignores unrelated callback settings and needs no file', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-ilink-config-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  const missingFile = path.join(root, 'missing.env');
  const defaults = loadIlinkEnrollmentConfig({
    environment: {},
    envFile: missingFile,
    root,
  });
  assert.equal(defaults.state.databaseFile, path.join(root, 'data/kintio.sqlite'));
  assert.equal(defaults.ilink.maxAccounts, 20);

  const envFile = path.join(root, 'ilink.env');
  await fs.writeFile(envFile, [
    'PORT=invalid-for-hono',
    'WECOM_CORP_ID=incomplete-and-ignored',
    'ILINK_MAX_ACCOUNTS=2',
    'CODEX_WORKING_DIRECTORY=./agent-work',
  ].join('\n'));
  const enrollment = loadIlinkEnrollmentConfig({ environment: {}, envFile, root });
  assert.equal(enrollment.ilink.maxAccounts, 2);
  const runtime = loadIlinkRuntimeConfig({ environment: {}, envFile, root });
  assert.ok(runtime.ilink);
  assert.equal(runtime.ilink.maxAccounts, 2);
  assert.equal(runtime.codex.workingDirectory, path.join(root, 'agent-work'));
  assert.equal('wecom' in runtime, false);
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
});

test('Windows keeps Kintio state inside the instance without owning the Agent workspace', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-windows-state-'));
  const workspace = path.join(path.dirname(root), 'user-project');
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));

  const config = testConfig({
    KINTIO_DB_FILE: './state/kintio.sqlite',
    ILINK_STORAGE_KEY_FILE: './secrets/ilink-storage.key',
    CODEX_IMAGE_TMP_DIR: './cache/images',
    CODEX_WORKING_DIRECTORY: workspace,
  }, root, 'win32');

  assert.equal(config.state.databaseFile, path.join(root, 'state/kintio.sqlite'));
  assert.equal(config.state.lockFile, path.join(root, 'state/kintio.lock'));
  assert.equal(config.codex.imageTempDirectory, path.join(root, 'cache/images'));
  assert.equal(config.codex.workingDirectory, workspace);
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

test('state paths use only Kintio defaults or the explicit database setting', () => {
  const root = path.join(os.tmpdir(), 'kintio-state-root');
  assert.deepEqual(resolveStateFiles({}, root), {
    databaseFile: path.join(root, 'data/kintio.sqlite'),
    lockFile: path.join(root, 'data/kintio.lock'),
  });
  assert.deepEqual(resolveStateFiles({ KINTIO_DB_FILE: 'custom/state.sqlite' }, root), {
    databaseFile: path.join(root, 'custom/state.sqlite'),
    lockFile: path.join(root, 'custom/kintio.lock'),
  });
});

test('state selection does not discover or adopt databases with retired default names', async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'kintio-current-state-'));
  t.onTestFinished(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, 'data'));
  await Promise.all(['wecom.sqlite', 'talkferry.sqlite'].map((name) =>
    fs.writeFile(path.join(root, 'data', name), 'untouched')));
  assert.deepEqual(resolveStateFiles({}, root), {
    databaseFile: path.join(root, 'data/kintio.sqlite'),
    lockFile: path.join(root, 'data/kintio.lock'),
  });
});

test('message processing remains disabled until CorpID and Secret are present', () => {
  const config = testConfig(callbackEnvironment);

  assert.equal(config.port, 8888);
  assert.equal(config.wecom.api.enabled, false);
  assert.equal(config.codex.enabled, false);
  assert.equal('ilink' in config, false);
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
      testConfig({
        ...callbackEnvironment,
        WECOM_CORP_ID: 'ww-test',
      }),
    /must be configured together/,
  );
});

test('allowed users and channel runtime defaults are parsed', () => {
  const config = testConfig({
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
});

test.each(['HARNESS_DB_FILE', 'TALKFERRY_DB_FILE', 'WECOM_DB_FILE'])(
  'retired %s does not configure Kintio state', (name) => {
    const config = testConfig({ [name]: 'retired.sqlite' });
    assert.equal(config.state.databaseFile, path.join(isolatedRoot, 'data/kintio.sqlite'));
    assert.equal(config.state.lockFile, path.join(isolatedRoot, 'data/kintio.lock'));
  },
);
