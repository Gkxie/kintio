import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  IlinkStoreContractError,
  assertIlinkEncryptedSecret,
  createIlinkAccountKey,
  type IlinkEncryptedSecret,
} from '../../src/ilink/store-types.ts';

const encryptedSecret: IlinkEncryptedSecret = {
  nonce: Buffer.alloc(12, 1).toString('base64url'),
  ciphertext: Buffer.from('ciphertext').toString('base64url'),
  authTag: Buffer.alloc(16, 2).toString('base64url'),
};

function contractCode(error: unknown, code: string): boolean {
  return error instanceof IlinkStoreContractError && error.code === code;
}

test('iLink account keys are deterministic, opaque, and provider scoped', () => {
  const first = createIlinkAccountKey('bot@im.bot');
  assert.equal(first, createIlinkAccountKey('bot@im.bot'));
  assert.notEqual(first, createIlinkAccountKey('other@im.bot'));
  assert.match(first, /^ia_[0-9a-f]{40}$/u);
  assert.equal(first.includes('bot@im.bot'), false);

  for (const invalid of ['', ' bot@im.bot', 'bot\u0000@im.bot']) {
    assert.throws(
      () => createIlinkAccountKey(invalid),
      (error: unknown) => contractCode(error, 'invalid_provider_identity'),
    );
  }
});

test('encrypted Bot and context-token records enforce AES-GCM shape', () => {
  assert.doesNotThrow(() => assertIlinkEncryptedSecret(encryptedSecret));

  for (const malformed of [
    { ...encryptedSecret, nonce: Buffer.alloc(11).toString('base64url') },
    { ...encryptedSecret, authTag: Buffer.alloc(15).toString('base64url') },
    { ...encryptedSecret, ciphertext: '' },
  ]) {
    assert.throws(
      () => assertIlinkEncryptedSecret(malformed),
      (error: unknown) => contractCode(error, 'invalid_secret'),
    );
  }
});
