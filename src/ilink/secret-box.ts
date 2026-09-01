import {
  createCipheriv,
  createDecipheriv,
  createSecretKey,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import {
  assertTrustedDirectory,
  ensurePrivateDirectory,
} from '../lib/private-directory.ts';

const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const AUTH_TAG_BYTES = 16;
const MAX_SCOPE_BYTES = 512;

export interface IlinkSecretScope {
  readonly secretKind: string;
  readonly accountId: string;
  readonly peerId: string;
  readonly generation: number;
}

export interface IlinkSealedSecret {
  readonly nonce: string;
  readonly ciphertext: string;
  readonly authTag: string;
}

export type IlinkSecretBoxErrorCode =
  | 'invalid_key'
  | 'invalid_scope'
  | 'invalid_secret'
  | 'invalid_envelope'
  | 'decryption_failed';

export class IlinkSecretBoxError extends Error {
  readonly code: IlinkSecretBoxErrorCode;

  constructor(code: IlinkSecretBoxErrorCode, message: string) {
    super(message);
    this.name = 'IlinkSecretBoxError';
    this.code = code;
  }
}

function invalidKey(): IlinkSecretBoxError {
  return new IlinkSecretBoxError(
    'invalid_key',
    'iLink secret key must be a canonical 32-byte base64url value',
  );
}

function decodeConfiguredKey(configuredKey: string): Buffer {
  if (
    typeof configuredKey !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(configuredKey)
  ) {
    throw invalidKey();
  }
  const decoded = Buffer.from(configuredKey, 'base64url');
  if (
    decoded.length !== KEY_BYTES ||
    decoded.toString('base64url') !== configuredKey
  ) {
    decoded.fill(0);
    throw invalidKey();
  }
  return decoded;
}

export function readOrCreateIlinkStorageKey(
  filePath: string,
  { allowCreate }: { readonly allowCreate: boolean },
): string {
  const target = path.resolve(filePath);
  const parent = ensurePrivateDirectory(path.dirname(target));
  assertTrustedDirectory(parent, 'iLink storage key directory', true);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`iLink storage key is not a regular file: ${target}`);
    }
    if (process.platform !== 'win32') {
      const uid = process.getuid?.();
      if ((uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) {
        throw new Error(`iLink storage key has unsafe permissions: ${target}`);
      }
    }
    const configuredKey = fs.readFileSync(target, 'utf8').trim();
    const decoded = decodeConfiguredKey(configuredKey);
    decoded.fill(0);
    return configuredKey;
  } catch (error: unknown) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) {
      throw error;
    }
  }
  if (!allowCreate) {
    throw new Error('iLink storage key is missing for existing encrypted state');
  }
  const configuredKey = randomBytes(KEY_BYTES).toString('base64url');
  let descriptor: number | undefined;
  let created = false;
  try {
    descriptor = fs.openSync(target, 'wx', 0o600);
    created = true;
    fs.writeFileSync(descriptor, `${configuredKey}\n`, 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    if (process.platform !== 'win32') {
      const parentDescriptor = fs.openSync(parent, 'r');
      try {
        fs.fsyncSync(parentDescriptor);
      } finally {
        fs.closeSync(parentDescriptor);
      }
    }
    return configuredKey;
  } catch (error: unknown) {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch {}
    }
    if (created) {
      try {
        fs.unlinkSync(target);
      } catch (cleanupError: unknown) {
        throw new AggregateError(
          [error, cleanupError],
          'iLink storage key creation and cleanup both failed',
        );
      }
    }
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      return readOrCreateIlinkStorageKey(target, { allowCreate });
    }
    throw error;
  }
}

function boundedScopeText(value: string): boolean {
  return typeof value === 'string' &&
    value.length > 0 &&
    Buffer.byteLength(value, 'utf8') <= MAX_SCOPE_BYTES;
}

function additionalAuthenticatedData(scope: IlinkSecretScope): Buffer {
  if (
    !scope ||
    typeof scope !== 'object' ||
    !/^[a-z][a-z0-9_]{0,63}$/u.test(scope.secretKind) ||
    !boundedScopeText(scope.accountId) ||
    !boundedScopeText(scope.peerId) ||
    !Number.isSafeInteger(scope.generation) ||
    scope.generation < 0
  ) {
    throw new IlinkSecretBoxError(
      'invalid_scope',
      'Invalid iLink secret scope',
    );
  }
  return Buffer.from(JSON.stringify([
    1,
    scope.secretKind,
    scope.accountId,
    scope.peerId,
    scope.generation,
  ]), 'utf8');
}

function decodeEnvelopeField(
  value: string,
  expectedBytes?: number,
): Buffer {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new IlinkSecretBoxError(
      'invalid_envelope',
      'Invalid iLink secret envelope',
    );
  }
  const decoded = Buffer.from(value, 'base64url');
  if (
    decoded.toString('base64url') !== value ||
    (expectedBytes !== undefined && decoded.length !== expectedBytes)
  ) {
    decoded.fill(0);
    throw new IlinkSecretBoxError(
      'invalid_envelope',
      'Invalid iLink secret envelope',
    );
  }
  return decoded;
}

export class IlinkSecretBox {
  readonly #key: KeyObject;

  constructor(configuredKey: string) {
    const keyBytes = decodeConfiguredKey(configuredKey);
    try {
      this.#key = createSecretKey(keyBytes);
    } finally {
      keyBytes.fill(0);
    }
  }

  seal(secret: string, scope: IlinkSecretScope): IlinkSealedSecret {
    if (typeof secret !== 'string' || secret.length === 0) {
      throw new IlinkSecretBoxError(
        'invalid_secret',
        'iLink secret must be a non-empty string',
      );
    }
    const aad = additionalAuthenticatedData(scope);
    const nonce = randomBytes(NONCE_BYTES);
    const plaintext = Buffer.from(secret, 'utf8');
    try {
      const cipher = createCipheriv('aes-256-gcm', this.#key, nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      cipher.setAAD(aad);
      const ciphertext = Buffer.concat([
        cipher.update(plaintext),
        cipher.final(),
      ]);
      return {
        nonce: nonce.toString('base64url'),
        ciphertext: ciphertext.toString('base64url'),
        authTag: cipher.getAuthTag().toString('base64url'),
      };
    } finally {
      plaintext.fill(0);
      aad.fill(0);
      nonce.fill(0);
    }
  }

  open(envelope: IlinkSealedSecret, scope: IlinkSecretScope): string {
    const aad = additionalAuthenticatedData(scope);
    let nonce: Buffer | undefined;
    let ciphertext: Buffer | undefined;
    let authTag: Buffer | undefined;
    let plaintext: Buffer | undefined;
    try {
      if (!envelope || typeof envelope !== 'object') {
        throw new IlinkSecretBoxError(
          'invalid_envelope',
          'Invalid iLink secret envelope',
        );
      }
      nonce = decodeEnvelopeField(envelope.nonce, NONCE_BYTES);
      ciphertext = decodeEnvelopeField(envelope.ciphertext);
      authTag = decodeEnvelopeField(envelope.authTag, AUTH_TAG_BYTES);
      const decipher = createDecipheriv('aes-256-gcm', this.#key, nonce, {
        authTagLength: AUTH_TAG_BYTES,
      });
      decipher.setAAD(aad);
      decipher.setAuthTag(authTag);
      plaintext = Buffer.concat([
        decipher.update(ciphertext),
        decipher.final(),
      ]);
      return plaintext.toString('utf8');
    } catch (error: unknown) {
      if (error instanceof IlinkSecretBoxError) throw error;
      throw new IlinkSecretBoxError(
        'decryption_failed',
        'Unable to decrypt iLink secret',
      );
    } finally {
      aad.fill(0);
      nonce?.fill(0);
      ciphertext?.fill(0);
      authTag?.fill(0);
      plaintext?.fill(0);
    }
  }
}
