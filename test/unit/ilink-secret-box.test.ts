import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { test } from 'vitest';

import {
  IlinkSecretBox,
  IlinkSecretBoxError,
  readOrCreateIlinkStorageKey,
  type IlinkSealedSecret,
  type IlinkSecretScope,
} from '../../src/ilink/secret-box.ts';

const configuredKey = randomBytes(32).toString('base64url');
const scope: IlinkSecretScope = {
  secretKind: 'context_token',
  accountId: 'bot-one@im.bot',
  peerId: 'user-one@im.wechat',
  generation: 7,
};

function changed(
  envelope: IlinkSealedSecret,
  field: keyof IlinkSealedSecret,
): IlinkSealedSecret {
  const original = envelope[field];
  const replacement = original.endsWith('A') ? 'B' : 'A';
  return { ...envelope, [field]: `${original.slice(0, -1)}${replacement}` };
}

function capturedError(operation: () => unknown): Error {
  try {
    operation();
  } catch (error: unknown) {
    assert.ok(error instanceof Error);
    return error;
  }
  assert.fail('Expected operation to throw');
}

test('AES-256-GCM round-trips a secret with a fresh canonical envelope', () => {
  const box = new IlinkSecretBox(configuredKey);
  const secret = 'opaque-token-机密-123';

  const first = box.seal(secret, scope);
  const second = box.seal(secret, scope);

  assert.equal(box.open(first, scope), secret);
  assert.equal(box.open(second, scope), secret);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(first.ciphertext, second.ciphertext);
  assert.equal(Buffer.from(first.nonce, 'base64url').length, 12);
  assert.equal(Buffer.from(first.authTag, 'base64url').length, 16);
  for (const value of Object.values(first)) {
    assert.match(value, /^[A-Za-z0-9_-]+$/u);
    assert.equal(Buffer.from(value, 'base64url').toString('base64url'), value);
  }
});

test('all four AAD coordinates authenticate the sealed secret', () => {
  const box = new IlinkSecretBox(configuredKey);
  const envelope = box.seal('bound-secret', scope);
  const alternatives: IlinkSecretScope[] = [
    { ...scope, secretKind: 'bot_token' },
    { ...scope, accountId: 'bot-two@im.bot' },
    { ...scope, peerId: 'user-two@im.wechat' },
    { ...scope, generation: scope.generation + 1 },
  ];

  for (const alternative of alternatives) {
    assert.throws(
      () => box.open(envelope, alternative),
      (error: unknown) =>
        error instanceof IlinkSecretBoxError &&
        error.code === 'decryption_failed',
    );
  }
});

test('another key and every modified envelope field fail closed', () => {
  const box = new IlinkSecretBox(configuredKey);
  const anotherBox = new IlinkSecretBox(randomBytes(32).toString('base64url'));
  const envelope = box.seal('tamper-proof', scope);

  assert.throws(() => anotherBox.open(envelope, scope), /Unable to decrypt/u);
  for (const field of ['nonce', 'ciphertext', 'authTag'] as const) {
    assert.throws(
      () => box.open(changed(envelope, field), scope),
      (error: unknown) =>
        error instanceof IlinkSecretBoxError &&
        ['invalid_envelope', 'decryption_failed'].includes(error.code),
    );
  }
});

test('configured key must be canonical unpadded base64url for exactly 32 bytes', () => {
  const valid = Buffer.alloc(32, 0).toString('base64url');
  assert.doesNotThrow(() => new IlinkSecretBox(valid));

  for (const invalid of [
    '',
    Buffer.alloc(31, 1).toString('base64url'),
    Buffer.alloc(33, 1).toString('base64url'),
    `${valid}=`,
    ` ${valid}`,
    `${valid.slice(0, -1)}B`,
    '+'.repeat(43),
  ]) {
    assert.throws(
      () => new IlinkSecretBox(invalid),
      (error: unknown) =>
        error instanceof IlinkSecretBoxError && error.code === 'invalid_key',
    );
  }
});

test('storage key creation is private, stable, and fails closed for encrypted state', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kintio-ilink-key-'));
  t.onTestFinished(() => fs.rmSync(root, { recursive: true, force: true }));
  const keyFile = path.join(root, 'data', 'ilink-storage.key');
  assert.throws(
    () => readOrCreateIlinkStorageKey(keyFile, { allowCreate: false }),
    /missing for existing encrypted state/u,
  );
  const created = readOrCreateIlinkStorageKey(keyFile, { allowCreate: true });
  assert.match(created, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(
    readOrCreateIlinkStorageKey(keyFile, { allowCreate: false }),
    created,
  );
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(keyFile).mode & 0o777, 0o600);
    fs.chmodSync(keyFile, 0o644);
    assert.throws(
      () => readOrCreateIlinkStorageKey(keyFile, { allowCreate: false }),
      /unsafe permissions/u,
    );
  }
});

test('invalid scope and envelope data are rejected without exposing plaintext', () => {
  const box = new IlinkSecretBox(configuredKey);
  const secret = 'do-not-leak-this-secret';
  const envelope = box.seal(secret, scope);

  assert.throws(
    () => box.seal(secret, { ...scope, generation: -1 }),
    (error: unknown) =>
      error instanceof IlinkSecretBoxError && error.code === 'invalid_scope',
  );
  assert.throws(
    () => box.seal('', scope),
    (error: unknown) =>
      error instanceof IlinkSecretBoxError && error.code === 'invalid_secret',
  );

  for (const corrupt of [
    { ...envelope, nonce: 'not+padded=' },
    { ...envelope, authTag: 'AA' },
    { ...envelope, ciphertext: '' },
  ]) {
    const error = capturedError(() => box.open(corrupt, scope));
    assert.doesNotMatch(
      `${error.name}: ${error.message}\n${error.stack}`,
      new RegExp(secret, 'u'),
    );
    assert.doesNotMatch(error.message, new RegExp(envelope.ciphertext, 'u'));
  }
});
