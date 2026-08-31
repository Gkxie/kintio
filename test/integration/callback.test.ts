import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { createApp } from '../../src/app.ts';
import { createConfig } from '../../src/config.ts';
import type { MessageSync } from '../../src/routes/wecom.ts';

const testConfig = createConfig({
  WECOM_CALLBACK_TOKEN: 'TestToken123',
  WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  WECOM_RECEIVE_ID: 'ww-test-receive-id',
}, path.join(os.tmpdir(), 'kintio-callback-config'));

const silentLogger = {
  error() {},
  info() {},
};

function encryptMessage(
  message: string,
  receiveId = testConfig.wecom.expectedReceiveId,
): string {
  const aesKey = Buffer.from(`${testConfig.wecom.encodingAesKey}=`, 'base64');
  const messageBuffer = Buffer.from(message);
  const messageLength = Buffer.alloc(4);
  messageLength.writeUInt32BE(messageBuffer.length);

  let plaintext = Buffer.concat([
    Buffer.from('0123456789abcdef'),
    messageLength,
    messageBuffer,
    Buffer.from(receiveId),
  ]);
  const paddingLength = 32 - (plaintext.length % 32);
  plaintext = Buffer.concat([plaintext, Buffer.alloc(paddingLength, paddingLength)]);

  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false);

  return Buffer.concat([cipher.update(plaintext), cipher.final()]).toString('base64');
}

function createSignedQuery(encrypted: string): URLSearchParams {
  const timestamp = '1787374800';
  const nonce = '123456789';
  const msgSignature = crypto
    .createHash('sha1')
    .update(
      [testConfig.wecom.callbackToken, timestamp, nonce, encrypted]
        .sort()
        .join(''),
    )
    .digest('hex');

  return new URLSearchParams({
    msg_signature: msgSignature,
    timestamp,
    nonce,
  });
}

function createTestApp(
  options: { messageProcessor?: MessageSync | null } = {},
) {
  return createApp({ config: testConfig, logger: silentLogger, ...options });
}

test('GET / exposes the expected response', async () => {
  const app = createTestApp();
  const rootResponse = await app.request('/');

  assert.equal(rootResponse.status, 200);
  assert.equal(await rootResponse.text(), 'hello world');
  assert.equal(rootResponse.headers.get('cache-control'), 'no-store');
});

test('GET / verifies and decrypts a valid WeCom callback challenge', async () => {
  const app = createTestApp();
  const expectedMessage = 'hono-callback-verification';
  const encrypted = encryptMessage(expectedMessage);
  const query = createSignedQuery(encrypted);
  query.set('echostr', encrypted);

  const response = await app.request(`/?${query}`);

  assert.equal(response.status, 200);
  assert.equal(await response.text(), expectedMessage);
});

test('GET rejects an invalid callback signature', async () => {
  const app = createTestApp();
  const encrypted = encryptMessage('invalid-signature');
  const query = createSignedQuery(encrypted);
  query.set('msg_signature', '0'.repeat(40));
  query.set('echostr', encrypted);

  const response = await app.request(`/?${query}`);

  assert.equal(response.status, 403);
  assert.equal(await response.text(), 'invalid signature');
});

test('POST / verifies and accepts an encrypted WeCom event', async () => {
  const app = createTestApp();
  const event = [
    '<xml>',
    '<Event><![CDATA[kf_msg_or_event]]></Event>',
    '<OpenKfId><![CDATA[wkd-test]]></OpenKfId>',
    '</xml>',
  ].join('');
  const encrypted = encryptMessage(event);
  const query = createSignedQuery(encrypted);

  const response = await app.request(`/?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'success');
});

test('POST acknowledges after synchronously registering message sync', async () => {
  const calls: Array<{ callbackToken: string; openKfId: string }> = [];
  const app = createTestApp({
    messageProcessor: {
      enqueue(event: { callbackToken: string; openKfId: string }) {
        calls.push(event);
        return true;
      },
    },
  });
  const event = [
    '<xml>',
    '<MsgType><![CDATA[event]]></MsgType>',
    '<Event><![CDATA[kf_msg_or_event]]></Event>',
    '<Token><![CDATA[callback-sync-token]]></Token>',
    '<OpenKfId><![CDATA[wkd-test]]></OpenKfId>',
    '</xml>',
  ].join('');
  const encrypted = encryptMessage(event);
  const query = createSignedQuery(encrypted);

  const response = await app.request(`/?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
  });

  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'success');
  assert.deepEqual(calls, [
    { callbackToken: 'callback-sync-token', openKfId: 'wkd-test' },
  ]);
});

test('POST returns 503 when shutdown rejects sync registration', async () => {
  const app = createTestApp({
    messageProcessor: {
      enqueue() {
        return false;
      },
    },
  });
  const event = [
    '<xml>',
    '<MsgType><![CDATA[event]]></MsgType>',
    '<Event><![CDATA[kf_msg_or_event]]></Event>',
    '<Token><![CDATA[callback-sync-token]]></Token>',
    '<OpenKfId><![CDATA[wkd-test]]></OpenKfId>',
    '</xml>',
  ].join('');
  const encrypted = encryptMessage(event);
  const query = createSignedQuery(encrypted);

  const response = await app.request(`/?${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
  });

  assert.equal(response.status, 503);
  assert.equal(await response.text(), 'service unavailable');
});

test('POST rejects request bodies larger than one MiB', async () => {
  const app = createTestApp();
  const response = await app.request('/', {
    method: 'POST',
    headers: { 'Content-Type': 'application/xml' },
    body: 'x'.repeat(1024 * 1024 + 1),
  });

  assert.equal(response.status, 413);
  assert.equal(await response.text(), 'request body is too large');
});
