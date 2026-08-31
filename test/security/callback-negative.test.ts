import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import { createApp } from '../../src/app.ts';
import { createConfig } from '../../src/config.ts';
import { WecomCrypto } from '../../src/lib/wecom-crypto.ts';

const config = createConfig({
  WECOM_CALLBACK_TOKEN: 'NegativeToken123',
  WECOM_ENCODING_AES_KEY: 'abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG',
  WECOM_RECEIVE_ID: 'ww-expected',
}, path.join(os.tmpdir(), 'kintio-callback-negative-config'));
const aesKey = Buffer.from(`${config.wecom.encodingAesKey}=`, 'base64');

function encryptPlaintext(plaintext: Buffer, validPadding = true): string {
  let padded: Buffer;
  if (validPadding) {
    const length = 32 - (plaintext.length % 32);
    padded = Buffer.concat([plaintext, Buffer.alloc(length, length)]);
  } else {
    padded = Buffer.alloc(32, 0);
  }
  const cipher = crypto.createCipheriv('aes-256-cbc', aesKey, aesKey.subarray(0, 16));
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(padded), cipher.final()]).toString('base64');
}

function encryptMessage(message: string, receiveId = 'ww-expected'): string {
  const content = Buffer.from(message);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(content.length);
  return encryptPlaintext(Buffer.concat([
    Buffer.from('0123456789abcdef'), length, content, Buffer.from(receiveId),
  ]));
}

function query(encrypted: string): URLSearchParams {
  const timestamp = '1787374800';
  const nonce = 'negative-nonce';
  return new URLSearchParams({
    timestamp,
    nonce,
    msg_signature: new WecomCrypto(config.wecom).calculateSignature(
      timestamp,
      nonce,
      encrypted,
    ),
  });
}

function appWithCalls(calls: Array<{ callbackToken: string; openKfId: string }>) {
  return createApp({
    config,
    logger: { info() {}, error() {} },
    messageProcessor: {
      enqueue(input) {
        calls.push(input);
        return true;
      },
    },
  });
}

test('decrypt rejects wrong ReceiveID, malformed Base64, padding, and length', () => {
  const decryptor = new WecomCrypto(config.wecom);
  assert.throws(
    () => decryptor.decryptMessage(encryptMessage('message', 'ww-other')),
    /receive ID/u,
  );
  assert.throws(() => decryptor.decryptMessage('%%%not-base64%%%'), /Base64/u);
  assert.throws(
    () => decryptor.decryptMessage(encryptPlaintext(Buffer.alloc(0), false)),
    /padding/u,
  );

  const invalidLength = Buffer.alloc(20);
  invalidLength.writeUInt32BE(999, 16);
  assert.throws(
    () => decryptor.decryptMessage(encryptPlaintext(invalidLength)),
    /invalid message length/u,
  );
});

test('GET callback rejects every missing-parameter combination without enqueue', async () => {
  const calls: Array<{ callbackToken: string; openKfId: string }> = [];
  const app = appWithCalls(calls);
  for (const url of [
    '/?msg_signature=x',
    '/?echostr=x',
    '/?msg_signature=x&timestamp=1&nonce=2',
  ]) {
    const response = await app.request(url);
    assert.equal(response.status, 400, url);
  }
  assert.deepEqual(calls, []);
});
test('POST callback rejects missing query or Encrypt without enqueue', async () => {
  const calls: Array<{ callbackToken: string; openKfId: string }> = [];
  const app = appWithCalls(calls);
  const missingQuery = await app.request('/', {
    method: 'POST',
    body: '<xml><Encrypt><![CDATA[x]]></Encrypt></xml>',
  });
  assert.equal(missingQuery.status, 400);
  const missingEncrypt = await app.request('/?msg_signature=x&timestamp=1&nonce=2', {
    method: 'POST',
    body: '<xml></xml>',
  });
  assert.equal(missingEncrypt.status, 400);
  assert.deepEqual(calls, []);
});

test('valid non-kf event is acknowledged but never enqueued', async () => {
  const calls: Array<{ callbackToken: string; openKfId: string }> = [];
  const app = appWithCalls(calls);
  const encrypted = encryptMessage([
    '<xml>',
    '<Event><![CDATA[not_a_kf_event]]></Event>',
    '<Token><![CDATA[unused-token]]></Token>',
    '<OpenKfId><![CDATA[wkd-unused]]></OpenKfId>',
    '</xml>',
  ].join(''));
  const signed = query(encrypted);
  const response = await app.request(`/?${signed}`, {
    method: 'POST',
    body: `<xml><Encrypt><![CDATA[${encrypted}]]></Encrypt></xml>`,
  });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), 'success');
  assert.deepEqual(calls, []);
});
