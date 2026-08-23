import assert from 'node:assert/strict';
import test from 'node:test';

import { createConfig } from '../src/config.js';

const callbackEnvironment = {
  WECOM_CALLBACK_TOKEN: 'CallbackToken123',
  WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
};

test('message processing remains disabled until CorpID and Secret are present', () => {
  const config = createConfig(callbackEnvironment);

  assert.equal(config.wecom.api.enabled, false);
  assert.equal(config.codex.enabled, false);
  assert.equal(config.codex.localAccessEnabled, false);
  assert.equal(config.codex.sandboxMode, 'read-only');
  assert.equal(config.codex.networkAccessEnabled, false);
  assert.equal(config.codex.webSearchMode, 'disabled');
  assert.equal(config.codex.imageTempDirectory, '/dev/shm');
  assert.equal(config.wecom.authorization.trigger, '');
  assert.equal(config.wecom.authorization.requiredConsecutive, 3);
  assert.equal(
    config.wecom.authorization.confirmationText,
    '暗号确认，请继续对话',
  );
});

test('CorpID and customer-service Secret must be configured together', () => {
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
    WECOM_ALLOWED_USER_IDS: 'wm-one, wm-two',
    WECOM_AUTH_TRIGGER: '发车',
    WECOM_AUTH_TRIGGER_COUNT: '3',
    WECOM_AUTH_CONFIRMATION: '暗号确认，请继续对话',
    CODEX_NETWORK_ACCESS: 'true',
    CODEX_MODEL: 'gpt-5.6-luna',
    CODEX_REASONING_EFFORT: 'none',
  });

  assert.equal(config.wecom.api.enabled, true);
  assert.deepEqual(config.wecom.allowedUserIds, ['wm-one', 'wm-two']);
  assert.equal(config.wecom.authorization.trigger, '发车');
  assert.equal(config.wecom.authorization.requiredConsecutive, 3);
  assert.equal(
    config.wecom.authorization.confirmationText,
    '暗号确认，请继续对话',
  );
  assert.equal(config.codex.enabled, true);
  assert.equal(config.codex.localAccessEnabled, false);
  assert.equal(config.wecom.expectedReceiveId, 'ww-test');
  assert.equal(config.codex.webSearchMode, 'live');
  assert.equal(config.codex.model, 'gpt-5.6-luna');
  assert.equal(config.codex.reasoningEffort, 'none');
});
