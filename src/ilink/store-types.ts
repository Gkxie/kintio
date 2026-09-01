import { createHash } from 'node:crypto';

import type { AgentAccess } from '../agent/runtime.ts';
import type { IlinkSealedSecret } from './secret-box.ts';

export const ILINK_CHANNEL = 'weixin_ilink' as const;
export const ILINK_ACCOUNT_KEY_PATTERN = /^ia_[0-9a-f]{40}$/u;
export const ILINK_MAX_PROVIDER_ID_BYTES = 512;
export const ILINK_REPLY_WINDOW_LIFETIME_MS = 24 * 60 * 60 * 1000;
export const ILINK_REPLY_WINDOW_MAX_SENDS = 10;

export type IlinkAccountKey = `ia_${string}`;
export type IlinkAccountStatus = 'active' | 'paused' | 'disabled' | 'revoked';
export type IlinkAgentAccess = AgentAccess;
type IlinkReplyWindowState = 'open' | 'superseded' | 'closed' | 'cancelled';
export type IlinkEncryptedSecret = IlinkSealedSecret;

export interface IlinkAccountRecord {
  readonly accountKey: IlinkAccountKey;
  readonly channel: typeof ILINK_CHANNEL;
  readonly providerAccountId: string;
  readonly ownerPeerId: string;
  readonly baseUrl: string;
  readonly generation: number;
  readonly status: IlinkAccountStatus;
  readonly agentAccess: IlinkAgentAccess;
  readonly pauseUntil: number;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface IlinkAccountSecretRecord {
  readonly accountKey: IlinkAccountKey;
  readonly ownerPeerId: string;
  readonly accountGeneration: number;
  readonly sealedBotToken: IlinkSealedSecret;
  readonly updatedAt: number;
}

export interface IlinkCursorRecord {
  readonly accountKey: IlinkAccountKey;
  readonly accountGeneration: number;
  readonly cursor: string;
  readonly updatedAt: number;
}

/**
 * The counters have separate meanings so a reservation can be released before
 * network transmission without restoring an already-issued send index.
 */
export interface IlinkReplyWindowRecord {
  readonly replyWindowId: number;
  readonly accountKey: IlinkAccountKey;
  readonly peerId: string;
  readonly accountGeneration: number;
  readonly sourceMessageKey: string;
  readonly sourceInboxSeq: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly maxSends: number;
  readonly nextSendIndex: number;
  readonly reservedSendCount: number;
  readonly transmittedSendCount: number;
  readonly state: IlinkReplyWindowState;
  readonly createdAt: number;
  readonly updatedAt: number;
}

export interface RegisterIlinkAccountInput {
  readonly providerAccountId: string;
  readonly ownerPeerId: string;
  readonly baseUrl: string;
  readonly encryptedBotToken: IlinkEncryptedSecret;
  readonly agentAccess?: IlinkAgentAccess;
  readonly now: number;
}

export interface RotateIlinkAccountInput {
  readonly accountKey: IlinkAccountKey;
  readonly expectedGeneration: number;
  readonly providerAccountId: string;
  readonly ownerPeerId: string;
  readonly baseUrl: string;
  readonly encryptedBotToken: IlinkEncryptedSecret;
  readonly agentAccess?: IlinkAgentAccess;
  readonly now: number;
}

export interface CommitIlinkPollPageResult {
  readonly insertedMessageKeys: readonly string[];
  readonly cursor: string;
}

export class IlinkStoreContractError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'IlinkStoreContractError';
    this.code = code;
  }
}

function contractError(message: string, code: string): never {
  throw new IlinkStoreContractError(message, code);
}

function assertProviderId(value: string, label: string): void {
  if (
    !value ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > ILINK_MAX_PROVIDER_ID_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    contractError(`${label} is invalid`, 'invalid_provider_identity');
  }
}

export function createIlinkAccountKey(
  providerAccountId: string,
): IlinkAccountKey {
  assertProviderId(providerAccountId, 'providerAccountId');
  const digest = createHash('sha256')
    .update(`${ILINK_CHANNEL}\0${providerAccountId}`, 'utf8')
    .digest('hex')
    .slice(0, 40);
  return `ia_${digest}`;
}

export function assertIlinkAccountKey(
  accountKey: string,
): asserts accountKey is IlinkAccountKey {
  if (!ILINK_ACCOUNT_KEY_PATTERN.test(accountKey)) {
    contractError('iLink account key is invalid', 'invalid_account_key');
  }
}

export function assertIlinkEncryptedSecret(
  secret: IlinkEncryptedSecret,
): void {
  const decode = (value: string, expectedBytes?: number): number => {
    if (!value || !/^[A-Za-z0-9_-]+$/u.test(value)) {
      contractError('Encrypted secret is not canonical base64url', 'invalid_secret');
    }
    const bytes = Buffer.from(value, 'base64url');
    if (
      bytes.toString('base64url') !== value ||
      (expectedBytes !== undefined && bytes.byteLength !== expectedBytes)
    ) {
      bytes.fill(0);
      contractError('Encrypted secret has an invalid field size', 'invalid_secret');
    }
    const length = bytes.byteLength;
    bytes.fill(0);
    return length;
  };

  if (decode(secret.nonce, 12) !== 12) {
    contractError('Encrypted secret nonce must contain 12 bytes', 'invalid_secret');
  }
  if (decode(secret.authTag, 16) !== 16) {
    contractError('Encrypted secret auth tag must contain 16 bytes', 'invalid_secret');
  }
  if (decode(secret.ciphertext) === 0) {
    contractError('Encrypted secret ciphertext cannot be empty', 'invalid_secret');
  }
}
