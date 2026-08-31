import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { createConfig, loadConfig } from '../../src/config.ts';

const base: NodeJS.ProcessEnv = {
  WECOM_CALLBACK_TOKEN: 'CallbackToken123',
  WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
};

const isolatedRoot = path.join(os.tmpdir(), 'kintio-config-negative-isolated');

function testConfig(
  environment: NodeJS.ProcessEnv,
  root = isolatedRoot,
  platform: NodeJS.Platform = process.platform,
) {
  return createConfig(environment, root, platform);
}

test('configuration loading rejects an unreadable environment-file type', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-invalid-env-'));
  const envFile = path.join(root, '.env');
  fs.mkdirSync(envFile);
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  assert.throws(() => loadConfig({ root, envFile, environment: {} }));
});

test('Windows rejects Kintio-owned state outside the instance home', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-windows-boundary-'));
  const root = path.join(parent, 'instance');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  t.onTestFinished(() => fs.rmSync(parent, { recursive: true, force: true }));

  for (const name of [
    'KINTIO_DB_FILE',
    'ILINK_STORAGE_KEY_FILE',
    'CODEX_IMAGE_TMP_DIR',
  ] as const) {
    assert.throws(
      () => testConfig({ [name]: path.join(outside, name) }, root, 'win32'),
      new RegExp(`${name} must stay inside KINTIO_HOME on Windows`, 'u'),
    );
  }
});

test('Windows state containment follows junctions before accepting a path', (t) => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-windows-junction-'));
  const root = path.join(parent, 'instance');
  const outside = path.join(parent, 'outside');
  fs.mkdirSync(root);
  fs.mkdirSync(outside);
  fs.symlinkSync(
    outside,
    path.join(root, 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  t.onTestFinished(() => fs.rmSync(parent, { recursive: true, force: true }));

  assert.throws(
    () => testConfig({
      KINTIO_DB_FILE: './escape/kintio.sqlite',
    }, root, 'win32'),
    /KINTIO_DB_FILE must stay inside KINTIO_HOME on Windows/u,
  );
});

test('PORT rejects non-integers and values outside 1..65535', () => {
  for (const value of ['0', '65536', '1.5', '-1', 'abc', 'Infinity']) {
    assert.throws(
      () => testConfig({ ...base, PORT: value }),
      /PORT must be an integer between 1 and 65535/u,
    );
  }
  assert.equal(testConfig({ ...base, PORT: '1' }).port, 1);
  assert.equal(testConfig({ ...base, PORT: '65535' }).port, 65535);
});

test('boolean parsing accepts documented spellings and rejects ambiguity', () => {
  for (const value of ['1', 'true', 'YES', 'on']) {
    assert.equal(testConfig({ ...base, CODEX_ENABLED: value }).codex.enabled, true);
  }
  for (const value of ['0', 'false', 'NO', 'off']) {
    assert.equal(testConfig({ ...base, CODEX_ENABLED: value }).codex.enabled, false);
  }
  for (const value of ['enabled', '2', 'null', ' true ']) {
    assert.throws(
      () => testConfig({ ...base, CODEX_ENABLED: value }),
      /Invalid boolean value/u,
    );
  }
});

test('WeChat authorization rejects wildcard allowlist entries', () => {
  for (const value of ['*', 'wm-one,*', '*,wm-two']) {
    assert.throws(
      () => testConfig({ ...base, WECOM_ALLOWED_USER_IDS: value }),
      /WECOM_ALLOWED_USER_IDS does not support wildcard entries/u,
    );
  }
});

test('positive integer settings reject zero fractions and non-numbers', () => {
  for (const [name, value] of [
    ['WECOM_API_TIMEOUT_MS', '0'],
    ['WECOM_MCP_OBSERVE_MS', '0'],
    ['WECOM_AUTH_TRIGGER_COUNT', '-1'],
    ['SHUTDOWN_TIMEOUT_MS', '1.5'],
    ['WECOM_API_TIMEOUT_MS', 'NaN'],
  ] as const) {
    assert.throws(
      () => testConfig({ ...base, [name]: value }),
      /must be a positive integer/u,
    );
  }
  const config = testConfig({
    ...base,
    WECOM_API_TIMEOUT_MS: '1',
    WECOM_MCP_OBSERVE_MS: '1',
    WECOM_AUTH_TRIGGER_COUNT: '1',
    SHUTDOWN_TIMEOUT_MS: '1000',
  });
  assert.equal(config.wecom.api.timeoutMs, 1);
  assert.equal(config.wecom.api.observeMs, 1);
  assert.equal(config.wecom.authorization.requiredConsecutive, 1);
  assert.equal(config.state.shutdownTimeoutMs, 1000);
  assert.throws(
    () => testConfig({ ...base, WECOM_MCP_OBSERVE_MS: '20001' }),
    /WECOM_MCP_OBSERVE_MS must not exceed 20000/u,
  );
  assert.throws(
    () => testConfig({ ...base, SHUTDOWN_TIMEOUT_MS: '120001' }),
    /SHUTDOWN_TIMEOUT_MS must not exceed 120000/u,
  );
  assert.throws(
    () => testConfig({ ...base, SHUTDOWN_TIMEOUT_MS: '999' }),
    /SHUTDOWN_TIMEOUT_MS must be at least 1000/u,
  );
});

test('iLink validates an explicit storage key and otherwise uses its private key file', () => {
  for (const key of ['short', 'a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}=`]) {
    assert.throws(
      () => testConfig({ ...base, ILINK_ENABLED: 'true', ILINK_STORAGE_KEY: key }),
      /ILINK_STORAGE_KEY/u,
    );
  }
  const config = testConfig({
    ...base,
    ILINK_ENABLED: 'true',
    ILINK_STORAGE_KEY: 'a'.repeat(43),
  });
  assert.equal(config.ilink.enabled, true);
  assert.match(config.ilink.storageKeyFile, /ilink-storage\.key$/u);
});

test('callback token and EncodingAESKey enforce alphabet and exact lengths', () => {
  for (const token of ['a'.repeat(33), 'bad_token', '含中文']) {
    assert.throws(
      () => testConfig({ ...base, WECOM_CALLBACK_TOKEN: token }),
      /WECOM_CALLBACK_TOKEN/u,
    );
  }
  assert.equal(testConfig({ ...base, WECOM_CALLBACK_TOKEN: 'a'.repeat(32) })
    .wecom.callbackToken.length, 32);
  for (const key of ['a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}_`, '含中文'.repeat(15)]) {
    assert.throws(
      () => testConfig({ ...base, WECOM_ENCODING_AES_KEY: key }),
      /WECOM_ENCODING_AES_KEY/u,
    );
  }
  assert.equal(testConfig({ ...base, WECOM_ENCODING_AES_KEY: 'A'.repeat(43) })
    .wecom.encodingAesKey.length, 43);
});

test('authorization text limits count UTF-8 bytes at the exact boundary', () => {
  const trigger128 = `${'你'.repeat(42)}aa`;
  const confirmation2048 = `${'你'.repeat(682)}aa`;
  assert.equal(Buffer.byteLength(trigger128), 128);
  assert.equal(Buffer.byteLength(confirmation2048), 2048);
  const config = testConfig({
    ...base,
    WECOM_AUTH_TRIGGER: trigger128,
    WECOM_AUTH_CONFIRMATION: confirmation2048,
  });
  assert.equal(config.wecom.authorization.trigger, trigger128);
  assert.equal(config.wecom.authorization.confirmationText, confirmation2048);
  assert.throws(
    () => testConfig({ ...base, WECOM_AUTH_TRIGGER: `${trigger128}你` }),
    /must not exceed 128 UTF-8 bytes/u,
  );
  assert.throws(
    () => testConfig({ ...base, WECOM_AUTH_CONFIRMATION: `${confirmation2048}你` }),
    /must not exceed 2048 UTF-8 bytes/u,
  );
});
