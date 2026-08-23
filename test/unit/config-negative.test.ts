import assert from 'node:assert/strict';
import test from 'node:test';

import { createConfig } from '../../src/config.js';

const base: NodeJS.ProcessEnv = {
  WECOM_CALLBACK_TOKEN: 'CallbackToken123',
  WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
};

test('[DEP01] PORT rejects non-integers and values outside 1..65535', () => {
  for (const value of ['0', '65536', '1.5', '-1', 'abc', 'Infinity']) {
    assert.throws(
      () => createConfig({ ...base, PORT: value }),
      /PORT must be an integer between 1 and 65535/u,
    );
  }
  assert.equal(createConfig({ ...base, PORT: '1' }).port, 1);
  assert.equal(createConfig({ ...base, PORT: '65535' }).port, 65535);
});

test('[G03] boolean parsing accepts documented spellings and rejects ambiguity', () => {
  for (const value of ['1', 'true', 'YES', 'on']) {
    assert.equal(createConfig({ ...base, CODEX_ENABLED: value }).codex.enabled, true);
  }
  for (const value of ['0', 'false', 'NO', 'off']) {
    assert.equal(createConfig({ ...base, CODEX_ENABLED: value }).codex.enabled, false);
  }
  for (const value of ['enabled', '2', 'null', ' true ']) {
    assert.throws(
      () => createConfig({ ...base, CODEX_ENABLED: value }),
      /Invalid boolean value/u,
    );
  }
});

test('[G03][A02][DEP01] positive integer settings reject zero fractions and non-numbers', () => {
  for (const [name, value] of [
    ['WECOM_API_TIMEOUT_MS', '0'],
    ['WECOM_AUTH_TRIGGER_COUNT', '-1'],
    ['SHUTDOWN_TIMEOUT_MS', '1.5'],
    ['WECOM_API_TIMEOUT_MS', 'NaN'],
  ] as const) {
    assert.throws(
      () => createConfig({ ...base, [name]: value }),
      /must be a positive integer/u,
    );
  }
  const config = createConfig({
    ...base,
    WECOM_API_TIMEOUT_MS: '1',
    WECOM_AUTH_TRIGGER_COUNT: '1',
    SHUTDOWN_TIMEOUT_MS: '1',
  });
  assert.equal(config.wecom.api.timeoutMs, 1);
  assert.equal(config.wecom.authorization.requiredConsecutive, 1);
  assert.equal(config.state.shutdownTimeoutMs, 1);
});

test('[DEP02] project-only enum settings fail closed on unsupported values', () => {
  for (const [name, value, pattern] of [
    ['CODEX_REASONING_EFFORT', 'tiny', /CODEX_REASONING_EFFORT/u],
    ['CODEX_SANDBOX_MODE', 'root', /CODEX_SANDBOX_MODE/u],
    ['CODEX_WEB_SEARCH_MODE', 'sometimes', /CODEX_WEB_SEARCH_MODE/u],
  ] as const) {
    assert.throws(() => createConfig({ ...base, [name]: value }), pattern);
  }
  const config = createConfig({
    ...base,
    CODEX_REASONING_EFFORT: 'ultra',
    CODEX_SANDBOX_MODE: 'workspace-write',
    CODEX_WEB_SEARCH_MODE: 'cached',
  });
  assert.equal(config.codex.reasoningEffort, 'ultra');
  assert.equal(config.codex.sandboxMode, 'workspace-write');
  assert.equal(config.codex.webSearchMode, 'cached');
});

test('[G01] callback token and EncodingAESKey enforce alphabet and exact lengths', () => {
  for (const token of ['', 'a'.repeat(33), 'bad_token', '含中文']) {
    assert.throws(
      () => createConfig({ ...base, WECOM_CALLBACK_TOKEN: token }),
      /WECOM_CALLBACK_TOKEN/u,
    );
  }
  assert.equal(createConfig({ ...base, WECOM_CALLBACK_TOKEN: 'a'.repeat(32) })
    .wecom.callbackToken.length, 32);
  for (const key of ['a'.repeat(42), 'a'.repeat(44), `${'a'.repeat(42)}_`, '含中文'.repeat(15)]) {
    assert.throws(
      () => createConfig({ ...base, WECOM_ENCODING_AES_KEY: key }),
      /WECOM_ENCODING_AES_KEY/u,
    );
  }
  assert.equal(createConfig({ ...base, WECOM_ENCODING_AES_KEY: 'A'.repeat(43) })
    .wecom.encodingAesKey.length, 43);
});

test('[A02][A03] authorization text limits count UTF-8 bytes at the exact boundary', () => {
  const trigger128 = `${'你'.repeat(42)}aa`;
  const confirmation2048 = `${'你'.repeat(682)}aa`;
  assert.equal(Buffer.byteLength(trigger128), 128);
  assert.equal(Buffer.byteLength(confirmation2048), 2048);
  const config = createConfig({
    ...base,
    WECOM_AUTH_TRIGGER: trigger128,
    WECOM_AUTH_CONFIRMATION: confirmation2048,
  });
  assert.equal(config.wecom.authorization.trigger, trigger128);
  assert.equal(config.wecom.authorization.confirmationText, confirmation2048);
  assert.throws(
    () => createConfig({ ...base, WECOM_AUTH_TRIGGER: `${trigger128}你` }),
    /must not exceed 128 UTF-8 bytes/u,
  );
  assert.throws(
    () => createConfig({ ...base, WECOM_AUTH_CONFIRMATION: `${confirmation2048}你` }),
    /must not exceed 2048 UTF-8 bytes/u,
  );
});
