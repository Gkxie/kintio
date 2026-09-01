import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';

import {
  type AttemptRecord,
  type CoreState,
  type JsonObject,
} from '../state/sqlite-store.ts';
import type { NormalizedMessage } from '../types.ts';
import { normalizeIlinkBaseUrl } from './protocol/client.ts';
import type { IlinkSealedSecret } from './secret-box.ts';
import {
  ILINK_CHANNEL,
  ILINK_MAX_PROVIDER_ID_BYTES,
  ILINK_REPLY_WINDOW_LIFETIME_MS,
  ILINK_REPLY_WINDOW_MAX_SENDS,
  assertIlinkAccountKey,
  assertIlinkEncryptedSecret,
  createIlinkAccountKey,
  type CommitIlinkPollPageResult,
  type IlinkAccountKey,
  type IlinkAccountRecord,
  type IlinkAccountSecretRecord,
  type IlinkAgentAccess,
  type IlinkAccountStatus,
  type IlinkCursorRecord,
  type IlinkReplyWindowRecord,
  type RegisterIlinkAccountInput,
  type RotateIlinkAccountInput,
} from './store-types.ts';

const MAX_UPSTREAM_CLOCK_SKEW_MS = 5 * 60 * 1_000;
const MAX_CURSOR_BYTES = 256 * 1024;

type JsonPrimitive = null | boolean | number | string;
type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;

interface AccountRow {
  account_key: string;
  provider_account_id: string;
  owner_peer_id: string;
  base_url: string;
  generation: number;
  status: IlinkAccountStatus;
  agent_access: IlinkAgentAccess;
  pause_until: number;
  cursor: string;
  cursor_updated_at: number;
  created_at: number;
  updated_at: number;
}

interface AccountSecretRow extends AccountRow {
  account_generation: number;
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  secret_updated_at: number;
}

interface ReplyWindowRow {
  reply_window_id: number;
  account_key: string;
  peer_id: string;
  account_generation: number;
  source_message_key: string;
  source_inbox_seq: number;
  provider_seq: number | null;
  provider_message_id?: string;
  issued_at: number;
  expires_at: number;
  max_sends: number;
  next_send_index: number;
  reserved_send_count: number;
  transmitted_send_count: number;
  state: IlinkReplyWindowRecord['state'];
  secret_generation: number;
  created_at: number;
  updated_at: number;
}

interface ReplyWindowSecretRow extends ReplyWindowRow {
  nonce: string;
  ciphertext: string;
  auth_tag: string;
  secret_updated_at: number;
}

interface AttemptRow {
  attempt_key: string;
  source_message_key: string;
  open_kfid: string;
  external_userid: string;
  reply_window_id: number;
  send_index: number;
  source: string;
  sent_type: string;
  payload_json: string | null;
  metadata_json: string | null;
  fingerprint: string;
  client_message_id: string;
  status: AttemptRecord['status'];
  wecom_msgid: string;
  error_code: string;
  error_message: string;
  fail_type: number;
  created_at: number;
  updated_at: number;
}

interface AgentSessionWindowRow extends ReplyWindowRow {
  session_source_message_key: string;
  session_open_kfid: string;
  session_external_userid: string;
  session_reply_window_id: number;
  boundary_inbox_seq: number;
  session_expires_at: number;
  session_closed_at: number;
  session_inbound_status: string;
  account_status: IlinkAccountStatus;
  current_account_generation: number;
}

export interface IlinkPollPageEntry {
  readonly message: NormalizedMessage;
  readonly providerSeq?: number;
  readonly sealedContextToken: IlinkSealedSecret;
  readonly secretGeneration: number;
  readonly sealedImages?: readonly IlinkSealedInboundImage[];
}

interface IlinkSealedInboundImage {
  readonly position: number;
  readonly secretGeneration: number;
  readonly sealedLocator: IlinkSealedSecret;
}

export interface IlinkInboundImageSecret extends IlinkSealedInboundImage {
  readonly messageKey: string;
  readonly accountKey: IlinkAccountKey;
  readonly peerId: string;
}

export interface CommitIlinkPageInput {
  readonly accountKey: IlinkAccountKey;
  readonly expectedGeneration: number;
  readonly expectedCursor: string;
  readonly nextCursor: string;
  readonly messages: readonly IlinkPollPageEntry[];
  readonly deferred?: boolean;
  readonly deferredBefore?: number;
}

export interface CommitIlinkPageResult extends CommitIlinkPollPageResult {
  readonly replyWindowIds: readonly number[];
  readonly deferredMessageCount: number;
}

export interface IlinkAccountWithSecret {
  readonly account: IlinkAccountRecord;
  readonly secret: IlinkAccountSecretRecord;
}

export interface IlinkReplyWindowSecret {
  readonly replyWindowId: number;
  readonly accountKey: IlinkAccountKey;
  readonly peerId: string;
  readonly accountGeneration: number;
  readonly secretGeneration: number;
  readonly sourceMessageKey: string;
  readonly sourceInboxSeq: number;
  readonly issuedAt: number;
  readonly expiresAt: number;
  readonly sealedContextToken: IlinkSealedSecret;
  readonly updatedAt: number;
}

export interface CompareAndSetIlinkCursorInput {
  readonly accountKey: IlinkAccountKey;
  readonly expectedGeneration: number;
  readonly expectedCursor: string;
  readonly nextCursor: string;
  readonly now?: number;
}

export interface ReserveIlinkSendInput {
  readonly sessionToken: string;
  readonly sentType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly now?: number;
}

type IlinkReplyRejection = 'reply_window_expired' | 'reply_quota_exhausted';

export type PrepareIlinkReplyAttemptResult =
  | { readonly kind: 'reserved'; readonly attempt: AttemptRecord }
  | {
      readonly kind: 'rejected';
      readonly attempt: AttemptRecord;
      readonly code: IlinkReplyRejection;
    };

export interface StartIlinkSendInput {
  readonly sessionToken: string;
  readonly attemptId: string;
  readonly now?: number;
}

export interface ReserveIlinkSystemSendInput {
  readonly messageKey: string;
  readonly sentType: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly source: string;
  readonly now?: number;
}

export interface ConfirmIlinkEnrollmentInput extends RegisterIlinkAccountInput {
  readonly offerId: string;
  readonly accountGeneration: number;
  readonly maxAccounts: number;
}

export type IlinkSqliteStoreErrorCode =
  | 'invalid_input'
  | 'account_not_found'
  | 'account_exists'
  | 'owner_conflict'
  | 'account_not_active'
  | 'account_limit_reached'
  | 'generation_conflict'
  | 'cursor_conflict'
  | 'pair_mismatch'
  | 'dedupe_invariant'
  | 'reply_window_not_found'
  | 'reply_window_inactive'
  | 'reply_window_expired'
  | 'reply_quota_exhausted'
  | 'invalid_agent_session'
  | 'send_in_progress'
  | 'attempt_conflict';

export class IlinkSqliteStoreError extends Error {
  readonly code: IlinkSqliteStoreErrorCode;

  constructor(code: IlinkSqliteStoreErrorCode, message: string) {
    super(message);
    this.name = 'IlinkSqliteStoreError';
    this.code = code;
  }
}

function fail(code: IlinkSqliteStoreErrorCode, message: string): never {
  throw new IlinkSqliteStoreError(code, message);
}

function rowAs<T>(row: unknown): T | undefined {
  return row === undefined ? undefined : row as T;
}

function rowsAs<T>(rows: readonly unknown[]): T[] {
  return rows as T[];
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    fail('invalid_input', `${label} must be a positive safe integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('invalid_input', `${label} must be a non-negative safe integer`);
  }
  return value;
}

function boundedCursor(value: string, label: string): string {
  if (
    typeof value !== 'string' ||
    Buffer.byteLength(value, 'utf8') > MAX_CURSOR_BYTES ||
    value.includes('\0')
  ) {
    fail('invalid_input', `${label} is invalid`);
  }
  return value;
}

function providerIdentity(value: string, label: string): string {
  if (
    !value ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > ILINK_MAX_PROVIDER_ID_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    fail('invalid_input', `${label} is invalid`);
  }
  return value;
}

function agentAccess(value: IlinkAgentAccess | undefined): IlinkAgentAccess {
  if (value === undefined) return 'restricted';
  if (value !== 'restricted' && value !== 'host') {
    fail('invalid_input', 'agentAccess is invalid');
  }
  return value;
}

function sealedSecret(row: {
  nonce: string;
  ciphertext: string;
  auth_tag: string;
}): IlinkSealedSecret {
  const result = {
    nonce: row.nonce,
    ciphertext: row.ciphertext,
    authTag: row.auth_tag,
  };
  assertIlinkEncryptedSecret(result);
  return result;
}

function canonicalValue(value: unknown): JsonValue {
  if (value === undefined || value === null) return null;
  if (
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('invalid_input', 'JSON numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || Buffer.isBuffer(value)) {
    fail('invalid_input', `Unsupported JSON value: ${typeof value}`);
  }
  const source = value as Record<string, unknown>;
  const output: JsonObject = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) output[key] = canonicalValue(source[key]);
  }
  return output;
}

function encodeJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function decodeObject(value: string | null): JsonObject | undefined {
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as JsonObject
    : undefined;
}

function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function stableAttemptKey(messageKey: string, sendIndex: number): string {
  return `sa_${sha256(`${messageKey}\0${sendIndex}`).slice(0, 29)}`;
}

function stableClientMessageId(messageKey: string, sendIndex: number): string {
  return `wb_${sha256(`${messageKey}\0${sendIndex}`).slice(0, 29)}`;
}

function mapAccount(row: AccountRow): IlinkAccountRecord {
  assertIlinkAccountKey(row.account_key);
  return {
    accountKey: row.account_key,
    channel: ILINK_CHANNEL,
    providerAccountId: row.provider_account_id,
    ownerPeerId: row.owner_peer_id,
    baseUrl: row.base_url,
    generation: Number(row.generation),
    status: row.status,
    agentAccess: row.agent_access,
    pauseUntil: Number(row.pause_until),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapAccountSecret(row: AccountSecretRow): IlinkAccountSecretRecord {
  const account = mapAccount(row);
  if (Number(row.account_generation) !== account.generation) {
    fail('generation_conflict', 'iLink account secret generation is stale');
  }
  return {
    accountKey: account.accountKey,
    ownerPeerId: account.ownerPeerId,
    accountGeneration: Number(row.account_generation),
    sealedBotToken: sealedSecret(row),
    updatedAt: Number(row.secret_updated_at),
  };
}

function mapReplyWindow(row: ReplyWindowRow): IlinkReplyWindowRecord {
  assertIlinkAccountKey(row.account_key);
  return {
    replyWindowId: Number(row.reply_window_id),
    accountKey: row.account_key,
    peerId: row.peer_id,
    accountGeneration: Number(row.account_generation),
    sourceMessageKey: row.source_message_key,
    sourceInboxSeq: Number(row.source_inbox_seq),
    issuedAt: Number(row.issued_at),
    expiresAt: Number(row.expires_at),
    maxSends: Number(row.max_sends),
    nextSendIndex: Number(row.next_send_index),
    reservedSendCount: Number(row.reserved_send_count),
    transmittedSendCount: Number(row.transmitted_send_count),
    state: row.state,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function mapAttempt(row: AttemptRow): AttemptRecord {
  const payload = decodeObject(row.payload_json);
  const metadata = decodeObject(row.metadata_json);
  return {
    attemptId: row.attempt_key,
    messageKey: row.source_message_key,
    channel: ILINK_CHANNEL,
    accountKey: row.open_kfid,
    peerId: row.external_userid,
    replyWindowId: Number(row.reply_window_id),
    sendIndex: Number(row.send_index),
    source: row.source,
    type: row.sent_type,
    ...(payload ? { payload } : {}),
    ...(metadata ? { metadata } : {}),
    fingerprint: row.fingerprint,
    clientMessageId: row.client_message_id,
    status: row.status,
    providerMessageId: row.wecom_msgid,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    failType: Number(row.fail_type),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function entryIsNewer(
  entry: IlinkPollPageEntry,
  open: ReplyWindowRow,
  samePage: boolean,
): boolean {
  if (
    entry.providerSeq !== undefined &&
    open.provider_seq !== null &&
    entry.providerSeq !== open.provider_seq
  ) {
    return entry.providerSeq > open.provider_seq;
  }
  if (entry.message.sentAt !== open.issued_at) {
    return entry.message.sentAt > open.issued_at;
  }
  if (
    (entry.providerSeq === undefined) !== (open.provider_seq === null)
  ) return samePage;
  const candidateNumeric = /^message:(\d+)$/u.exec(
    entry.message.providerMessageId,
  )?.[1];
  const openNumeric = /^message:(\d+)$/u.exec(String(open.provider_message_id || ''))?.[1];
  return candidateNumeric !== undefined && openNumeric !== undefined
    ? BigInt(candidateNumeric) > BigInt(openNumeric)
    : samePage;
}

function compareEntries(
  left: IlinkPollPageEntry,
  right: IlinkPollPageEntry,
): number {
  if (
    left.providerSeq !== undefined &&
    right.providerSeq !== undefined &&
    left.providerSeq !== right.providerSeq
  ) {
    return left.providerSeq - right.providerSeq;
  }
  if (left.message.sentAt !== right.message.sentAt) {
    return left.message.sentAt - right.message.sentAt;
  }
  const leftNumeric = /^message:(\d+)$/u.exec(
    left.message.providerMessageId,
  )?.[1];
  const rightNumeric = /^message:(\d+)$/u.exec(
    right.message.providerMessageId,
  )?.[1];
  if (leftNumeric === undefined || rightNumeric === undefined) {
    return left.message.sync.index - right.message.sync.index;
  }
  const leftId = BigInt(leftNumeric);
  const rightId = BigInt(rightNumeric);
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0;
}

/** @internal Construct through StatePersistence outside persistence tests. */
interface IlinkSqliteStoreInternalOptions {
  readonly database: DatabaseSync;
  readonly inbox: Pick<CoreState, 'insertInboundMessages'>;
  readonly clock?: () => number;
}

export class IlinkSqliteStore {
  readonly #database: DatabaseSync;
  readonly #inbox: Pick<CoreState, 'insertInboundMessages'>;
  readonly #clock: () => number;

  constructor({
    database,
    inbox,
    clock = Date.now,
  }: IlinkSqliteStoreInternalOptions) {
    this.#database = database;
    this.#inbox = inbox;
    this.#clock = clock;
  }

  #now(explicit?: number): number {
    return nonNegativeInteger(explicit ?? Number(this.#clock()), 'now');
  }

  #transaction<T>(operation: () => T): T {
    if (this.#database.isTransaction) return operation();
    this.#database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.#database.exec('COMMIT');
      return result;
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
  }

  #accountRow(accountKey: IlinkAccountKey): AccountRow | undefined {
    assertIlinkAccountKey(accountKey);
    return rowAs<AccountRow>(this.#database.prepare(`
      SELECT * FROM ilink_accounts WHERE account_key = ?
    `).get(accountKey));
  }

  #accountSecretRow(accountKey: IlinkAccountKey): AccountSecretRow | undefined {
    assertIlinkAccountKey(accountKey);
    return rowAs<AccountSecretRow>(this.#database.prepare(`
      SELECT account.*, secret.account_generation,
             secret.nonce, secret.ciphertext, secret.auth_tag,
             secret.updated_at AS secret_updated_at
      FROM ilink_accounts AS account
      JOIN ilink_account_secrets AS secret USING (account_key)
      WHERE account.account_key = ?
    `).get(accountKey));
  }

  recoverPendingAttempts(): number {
    return this.#transaction(() => {
      const groups = rowsAs<{
        reply_window_id: number | null;
        pending_count: number;
      }>(this.#database.prepare(`
        SELECT reply_window_id, COUNT(*) AS pending_count
        FROM send_attempts
        WHERE channel = 'weixin_ilink' AND status = 'pending'
        GROUP BY reply_window_id
      `).all());
      let recovered = 0;
      const now = this.#now();
      for (const group of groups) {
        const replyWindowId = Number(group.reply_window_id || 0);
        const count = Number(group.pending_count || 0);
        const window = replyWindowId
          ? rowAs<ReplyWindowRow>(this.#database.prepare(`
              SELECT * FROM ilink_reply_windows WHERE reply_window_id = ?
            `).get(replyWindowId))
          : undefined;
        if (!window || count <= 0 || window.reserved_send_count < count) {
          fail('attempt_conflict', 'Pending iLink recovery counters are inconsistent');
        }
        const attempts = this.#database.prepare(`
          UPDATE send_attempts
          SET status = 'failed', error_code = 'abandoned_before_transmit',
              error_message = 'iLink send stopped before network transmission',
              updated_at = ?
          WHERE channel = 'weixin_ilink' AND status = 'pending'
            AND reply_window_id = ?
        `).run(now, replyWindowId);
        if (attempts.changes !== count) {
          fail('attempt_conflict', 'Pending iLink recovery changed unexpectedly');
        }
        const updated = this.#database.prepare(`
          UPDATE ilink_reply_windows
          SET reserved_send_count = reserved_send_count - ?, updated_at = ?
          WHERE reply_window_id = ? AND reserved_send_count >= ?
        `).run(count, now, replyWindowId, count);
        if (updated.changes !== 1) {
          fail('attempt_conflict', 'Pending iLink recovery lost its window');
        }
        recovered += count;
      }
      return recovered;
    });
  }

  releasePendingAttempt(
    attemptId: string,
    reason: 'cancelled_before_transmit' | 'reply_window_expired' =
      'cancelled_before_transmit',
  ): boolean {
    return this.#transaction(() => {
      const attempt = rowAs<AttemptRow>(this.#database.prepare(`
        SELECT * FROM send_attempts
        WHERE attempt_key = ? AND channel = 'weixin_ilink' AND status = 'pending'
      `).get(attemptId));
      if (!attempt) return false;
      const now = this.#now();
      const released = this.#database.prepare(`
        UPDATE ilink_reply_windows
        SET reserved_send_count = reserved_send_count - 1, updated_at = ?
        WHERE reply_window_id = ? AND reserved_send_count > 0
      `).run(now, attempt.reply_window_id);
      if (released.changes !== 1) {
        fail('attempt_conflict', 'Pending iLink reservation cannot be released');
      }
      this.#database.prepare(`
        UPDATE send_attempts
        SET status = 'failed', error_code = ?, error_message = ?,
            updated_at = ?
        WHERE attempt_key = ? AND status = 'pending'
      `).run(
        reason,
        reason === 'reply_window_expired'
          ? 'iLink reply window expired before network transmission'
          : 'iLink send cancelled before network transmission',
        now,
        attempt.attempt_key,
      );
      return true;
    });
  }

  registerAccount(input: RegisterIlinkAccountInput): IlinkAccountRecord {
    assertIlinkEncryptedSecret(input.encryptedBotToken);
    const accountKey = createIlinkAccountKey(input.providerAccountId);
    const ownerPeerId = providerIdentity(input.ownerPeerId, 'ownerPeerId');
    const baseUrl = normalizeIlinkBaseUrl(input.baseUrl);
    const requestedAccess = agentAccess(input.agentAccess);
    const now = this.#now(input.now);
    return this.#transaction(() => {
      if (this.#accountRow(accountKey)) {
        fail('account_exists', 'iLink account is already registered');
      }
      const owner = this.#database.prepare(`
        SELECT 1 FROM ilink_accounts
        WHERE owner_peer_id = ? AND status IN ('active', 'paused')
        LIMIT 1
      `).get(ownerPeerId);
      if (owner) fail('owner_conflict', 'iLink owner already has an active account');
      this.#database.prepare(`
        INSERT INTO ilink_accounts (
          account_key, provider_account_id, owner_peer_id, base_url,
          generation, status, agent_access, pause_until, cursor, cursor_updated_at,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 1, 'active', ?, 0, '', 0, ?, ?)
      `).run(
        accountKey,
        input.providerAccountId,
        ownerPeerId,
        baseUrl,
        requestedAccess,
        now,
        now,
      );
      this.#database.prepare(`
        INSERT INTO ilink_account_secrets (
          account_key, account_generation, nonce, ciphertext, auth_tag,
          updated_at
        ) VALUES (?, 1, ?, ?, ?, ?)
      `).run(
        accountKey,
        input.encryptedBotToken.nonce,
        input.encryptedBotToken.ciphertext,
        input.encryptedBotToken.authTag,
        now,
      );
      return mapAccount(this.#accountRow(accountKey)!);
    });
  }

  rotateAccount(input: RotateIlinkAccountInput): IlinkAccountRecord {
    assertIlinkAccountKey(input.accountKey);
    assertIlinkEncryptedSecret(input.encryptedBotToken);
    positiveInteger(input.expectedGeneration, 'expectedGeneration');
    providerIdentity(input.ownerPeerId, 'ownerPeerId');
    if (createIlinkAccountKey(input.providerAccountId) !== input.accountKey) {
      fail('pair_mismatch', 'iLink provider account does not match account key');
    }
    const baseUrl = normalizeIlinkBaseUrl(input.baseUrl);
    const requestedAccess = agentAccess(input.agentAccess);
    const now = this.#now(input.now);
    return this.#transaction(() => {
      const current = this.#accountRow(input.accountKey);
      if (!current) fail('account_not_found', 'Unknown iLink account');
      if (current.generation !== input.expectedGeneration) {
        fail('generation_conflict', 'iLink account generation changed');
      }
      if (
        current.provider_account_id !== input.providerAccountId ||
        current.owner_peer_id !== input.ownerPeerId
      ) {
        fail('pair_mismatch', 'iLink account binding cannot change during rotation');
      }
      const nextGeneration = current.generation + 1;
      const agentAccess =
        current.agent_access === 'host' || requestedAccess === 'host'
          ? 'host'
          : 'restricted';
      positiveInteger(nextGeneration, 'nextGeneration');
      this.#cancelOpenWindows(input.accountKey, now, 'account_generation_changed');
      const updated = this.#database.prepare(`
        UPDATE ilink_accounts
        SET base_url = ?, generation = ?, status = 'active', agent_access = ?,
            pause_until = 0,
            updated_at = ?
        WHERE account_key = ? AND generation = ?
      `).run(
        baseUrl,
        nextGeneration,
        agentAccess,
        now,
        input.accountKey,
        input.expectedGeneration,
      );
      if (updated.changes !== 1) {
        fail('generation_conflict', 'iLink account generation changed');
      }
      this.#database.prepare(`
        INSERT INTO ilink_account_secrets (
          account_key, account_generation, nonce, ciphertext, auth_tag, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(account_key) DO UPDATE SET
          account_generation = excluded.account_generation,
          nonce = excluded.nonce,
          ciphertext = excluded.ciphertext,
          auth_tag = excluded.auth_tag,
          updated_at = excluded.updated_at
      `).run(
        input.accountKey,
        nextGeneration,
        input.encryptedBotToken.nonce,
        input.encryptedBotToken.ciphertext,
        input.encryptedBotToken.authTag,
        now,
      );
      return mapAccount(this.#accountRow(input.accountKey)!);
    });
  }

  confirmEnrollment(input: ConfirmIlinkEnrollmentInput): IlinkAccountRecord {
    const offerId = String(input.offerId || '');
    if (!/^qo_[A-Za-z0-9_-]{1,128}$/u.test(offerId)) {
      fail('invalid_input', 'iLink login offer ID is invalid');
    }
    positiveInteger(input.accountGeneration, 'accountGeneration');
    positiveInteger(input.maxAccounts, 'maxAccounts');
    return this.#transaction(() => {
      const offer = rowAs<{
        initiator_kind: string;
        source_channel: string;
        source_message_key: string;
        source_account_id: string;
        source_peer_id: string;
        created_at: number;
      }>(this.#database.prepare(`
        SELECT initiator_kind, source_channel, source_message_key,
               source_account_id, source_peer_id, created_at
        FROM ilink_login_offers
        WHERE offer_id = ? AND status IN ('waiting', 'scanned')
          AND expires_at > ?
      `).get(offerId, this.#now(input.now)));
      if (!offer) fail('invalid_input', 'Unknown or inactive iLink login offer');
      const accountKey = createIlinkAccountKey(input.providerAccountId);
      const existing = this.#accountRow(accountKey);
      if (!existing || existing.status !== 'active') {
        const active = rowAs<{ count: number }>(this.#database.prepare(`
          SELECT COUNT(*) AS count FROM ilink_accounts WHERE status = 'active'
        `).get());
        if (Number(active?.count || 0) >= input.maxAccounts) {
          fail('account_limit_reached', 'iLink account limit reached');
        }
      }
      if (input.accountGeneration !== (existing?.generation || 0) + 1) {
        fail('generation_conflict', 'iLink enrollment generation changed');
      }
      const account = existing
        ? this.rotateAccount({
            accountKey,
            expectedGeneration: existing.generation,
            providerAccountId: input.providerAccountId,
            ownerPeerId: input.ownerPeerId,
            baseUrl: input.baseUrl,
            encryptedBotToken: input.encryptedBotToken,
            agentAccess:
              offer.initiator_kind === 'local_operator' ? 'host' : 'restricted',
            now: input.now,
          })
        : this.registerAccount({
            ...input,
            agentAccess:
              offer.initiator_kind === 'local_operator' ? 'host' : 'restricted',
          });
      this.#database.prepare(`
        INSERT INTO ilink_enrollment_audit (
          offer_id, initiator_kind, source_channel, source_message_key,
          source_account_id, source_peer_id,
          account_key, result, offered_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'confirmed', ?, ?)
      `).run(
        offerId,
        offer.initiator_kind,
        offer.source_channel,
        offer.source_message_key,
        offer.source_account_id,
        offer.source_peer_id,
        account.accountKey,
        offer.created_at,
        this.#now(input.now),
      );
      const removed = this.#database.prepare(`
        DELETE FROM ilink_login_offers
        WHERE offer_id = ? AND status IN ('waiting', 'scanned')
      `).run(offerId);
      if (removed.changes !== 1) fail('attempt_conflict', 'iLink login offer changed');
      return account;
    });
  }

  #cancelOpenWindows(accountKey: IlinkAccountKey, now: number, reason: string): void {
    const windowIds = rowsAs<{ reply_window_id: number }>(this.#database.prepare(`
      SELECT reply_window_id FROM ilink_reply_windows
      WHERE account_key = ? AND state = 'open'
    `).all(accountKey));
    for (const { reply_window_id: replyWindowId } of windowIds) {
      this.#retireWindow(replyWindowId, 'cancelled', now, reason);
    }
  }

  getAccount(accountKey: IlinkAccountKey): IlinkAccountRecord | undefined {
    const row = this.#accountRow(accountKey);
    return row ? mapAccount(row) : undefined;
  }

  confirmExistingEnrollment(input: {
    readonly offerId: string;
    readonly accountKey: IlinkAccountKey;
    readonly now?: number;
  }): IlinkAccountRecord {
    if (!/^qo_[A-Za-z0-9_-]{1,128}$/u.test(input.offerId)) {
      fail('invalid_input', 'iLink login offer ID is invalid');
    }
    assertIlinkAccountKey(input.accountKey);
    const now = this.#now(input.now);
    return this.#transaction(() => {
      const offer = rowAs<{
        initiator_kind: string;
        source_channel: string;
        source_message_key: string;
        source_account_id: string;
        source_peer_id: string;
        created_at: number;
      }>(this.#database.prepare(`
        SELECT initiator_kind, source_channel, source_message_key,
               source_account_id, source_peer_id, created_at
        FROM ilink_login_offers
        WHERE offer_id = ? AND initiator_kind = 'local_operator'
          AND status IN ('waiting', 'scanned') AND expires_at > ?
          AND EXISTS (
            SELECT 1 FROM json_each(candidate_account_keys_json)
            WHERE value = ?
          )
      `).get(input.offerId, now, input.accountKey));
      if (!offer) fail('invalid_input', 'Unknown or invalid local iLink login offer');
      const account = this.#accountRow(input.accountKey);
      if (!account || account.status !== 'active') {
        fail('account_not_active', 'iLink account is not active');
      }
      this.#database.prepare(`
        UPDATE ilink_accounts SET agent_access = 'host', updated_at = ?
        WHERE account_key = ?
      `).run(now, input.accountKey);
      this.#database.prepare(`
        INSERT INTO ilink_enrollment_audit (
          offer_id, initiator_kind, source_channel, source_message_key,
          source_account_id, source_peer_id, account_key,
          result, offered_at, completed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'already_connected', ?, ?)
      `).run(
        input.offerId,
        offer.initiator_kind,
        offer.source_channel,
        offer.source_message_key,
        offer.source_account_id,
        offer.source_peer_id,
        input.accountKey,
        offer.created_at,
        now,
      );
      const removed = this.#database.prepare(`
        DELETE FROM ilink_login_offers
        WHERE offer_id = ? AND status IN ('waiting', 'scanned')
      `).run(input.offerId);
      if (removed.changes !== 1) fail('attempt_conflict', 'iLink login offer changed');
      return mapAccount(this.#accountRow(input.accountKey)!);
    });
  }

  getAccountSecret(
    accountKey: IlinkAccountKey,
  ): IlinkAccountSecretRecord | undefined {
    const row = this.#accountSecretRow(accountKey);
    return row ? mapAccountSecret(row) : undefined;
  }

  getAccountWithSecret(
    accountKey: IlinkAccountKey,
  ): IlinkAccountWithSecret | undefined {
    const row = this.#accountSecretRow(accountKey);
    return row
      ? { account: mapAccount(row), secret: mapAccountSecret(row) }
      : undefined;
  }

  listActiveAccounts(): readonly IlinkAccountRecord[] {
    return rowsAs<AccountRow>(this.#database.prepare(`
      SELECT * FROM ilink_accounts
      WHERE status = 'active'
      ORDER BY created_at, account_key
    `).all()).map(mapAccount);
  }

  listActiveAccountsWithSecrets(): readonly IlinkAccountWithSecret[] {
    return rowsAs<AccountSecretRow>(this.#database.prepare(`
      SELECT account.*, secret.account_generation,
             secret.nonce, secret.ciphertext, secret.auth_tag,
             secret.updated_at AS secret_updated_at
      FROM ilink_accounts AS account
      JOIN ilink_account_secrets AS secret USING (account_key)
      WHERE account.status = 'active'
      ORDER BY account.created_at, account.account_key
    `).all()).map((row) => ({
      account: mapAccount(row),
      secret: mapAccountSecret(row),
    }));
  }

  getCursor(accountKey: IlinkAccountKey): IlinkCursorRecord | undefined {
    const row = this.#accountRow(accountKey);
    if (!row) return undefined;
    return {
      accountKey,
      accountGeneration: Number(row.generation),
      cursor: row.cursor,
      updatedAt: Number(row.cursor_updated_at),
    };
  }

  compareAndSetCursor(input: CompareAndSetIlinkCursorInput): IlinkCursorRecord {
    assertIlinkAccountKey(input.accountKey);
    positiveInteger(input.expectedGeneration, 'expectedGeneration');
    const expected = boundedCursor(input.expectedCursor, 'expectedCursor');
    const next = boundedCursor(input.nextCursor, 'nextCursor');
    const now = this.#now(input.now);
    return this.#transaction(() => {
      const updated = this.#database.prepare(`
        UPDATE ilink_accounts
        SET cursor = ?, cursor_updated_at = ?
        WHERE account_key = ? AND generation = ? AND status = 'active'
          AND cursor = ?
      `).run(next, now, input.accountKey, input.expectedGeneration, expected);
      if (updated.changes !== 1) this.#cursorFailure(input.accountKey, input.expectedGeneration);
      return this.getCursor(input.accountKey)!;
    });
  }

  #cursorFailure(accountKey: IlinkAccountKey, expectedGeneration: number): never {
    const account = this.#accountRow(accountKey);
    if (!account) fail('account_not_found', 'Unknown iLink account');
    if (account.status !== 'active') {
      fail('account_not_active', 'iLink account is not active');
    }
    if (account.generation !== expectedGeneration) {
      fail('generation_conflict', 'iLink account generation changed');
    }
    fail('cursor_conflict', 'iLink cursor changed');
  }

  commitPollPage(input: CommitIlinkPageInput): CommitIlinkPageResult {
    assertIlinkAccountKey(input.accountKey);
    positiveInteger(input.expectedGeneration, 'expectedGeneration');
    const expectedCursor = boundedCursor(input.expectedCursor, 'expectedCursor');
    const nextCursor = boundedCursor(input.nextCursor, 'nextCursor');
    if (!Array.isArray(input.messages)) {
      fail('invalid_input', 'messages must be an array');
    }
    if (input.deferredBefore !== undefined) {
      nonNegativeInteger(input.deferredBefore, 'deferredBefore');
    }
    const now = this.#now();
    return this.#transaction(() => {
      const account = this.#accountRow(input.accountKey);
      if (!account) fail('account_not_found', 'Unknown iLink account');
      if (account.status !== 'active') {
        fail('account_not_active', 'iLink account is not active');
      }
      if (account.generation !== input.expectedGeneration) {
        fail('generation_conflict', 'iLink account generation changed');
      }
      if (account.cursor !== expectedCursor) {
        fail('cursor_conflict', 'iLink cursor changed');
      }

      const insertedEntries: Array<{
        readonly messageKey: string;
        readonly entry: IlinkPollPageEntry;
        readonly payload: NormalizedMessage;
      }> = [];
      const replyWindowIds: number[] = [];
      const pageWindowSources = new Set<string>();
      for (const entry of input.messages) {
        this.#validatePageEntry(entry, account, expectedCursor);
      }
      const inboxResults = this.#inbox.insertInboundMessages({
        accountKey: input.accountKey,
        entries: input.messages.map((entry) => ({
          message: entry.message,
          deferred: Boolean(input.deferred) || (
            input.deferredBefore !== undefined &&
            entry.message.sentAt < input.deferredBefore
          ),
        })),
        now,
      });
      for (const [index, entry] of input.messages.entries()) {
        const inbox = inboxResults[index];
        if (!inbox) fail('dedupe_invariant', 'iLink inbox result is missing');
        const { messageKey } = inbox;
        const { message } = entry;
        if (!inbox.inserted) {
          this.#validateDuplicate(message, messageKey);
          continue;
        }
        insertedEntries.push({ messageKey, entry, payload: message });
        for (const image of entry.sealedImages || []) {
          this.#database.prepare(`
            INSERT INTO ilink_inbound_images (
              message_key, position, account_key, peer_id, secret_generation,
              nonce, ciphertext, auth_tag, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            messageKey,
            image.position,
            input.accountKey,
            message.conversation.peerId,
            image.secretGeneration,
            image.sealedLocator.nonce,
            image.sealedLocator.ciphertext,
            image.sealedLocator.authTag,
            now,
          );
        }
        const replyWindowId = this.#insertReplyWindow(
          account,
          entry,
          messageKey,
          inbox.inboxSeq,
          pageWindowSources,
          now,
        );
        replyWindowIds.push(replyWindowId);
        pageWindowSources.add(messageKey);
      }

      const cursorUpdate = this.#database.prepare(`
        UPDATE ilink_accounts
        SET cursor = ?, cursor_updated_at = ?
        WHERE account_key = ? AND generation = ? AND status = 'active'
          AND cursor = ?
      `).run(
        nextCursor,
        now,
        input.accountKey,
        input.expectedGeneration,
        expectedCursor,
      );
      if (cursorUpdate.changes !== 1) {
        this.#cursorFailure(input.accountKey, input.expectedGeneration);
      }
      const openMessageKey = this.#openWindow(
        input.accountKey,
        account.owner_peer_id,
      )?.source_message_key || '';
      const deliverable = insertedEntries.find(
        ({ messageKey }) => messageKey === openMessageKey,
      );
      const deliverableDeferred = deliverable
        ? Number(rowAs<{ deferred: number }>(this.#database.prepare(`
            SELECT deferred FROM inbound_messages WHERE message_key = ?
          `).get(deliverable.messageKey))?.deferred || 0) === 1
        : false;
      for (const entry of insertedEntries) {
        if (entry.messageKey === openMessageKey) continue;
        this.#database.prepare(`
          UPDATE inbound_messages
          SET status = 'absorbed', deferred = 0, payload_json = NULL, updated_at = ?
          WHERE message_key = ? AND status = 'received'
        `).run(now, entry.messageKey);
      }
      const pageSummaries = [...insertedEntries]
        .sort((left, right) => compareEntries(left.entry, right.entry))
        .map(({ payload }) => payload.summary);
      const backlog = deliverable
        ? rowsAs<{ message_key: string; payload_json: string | null }>(
            this.#database.prepare(`
              SELECT message_key, payload_json FROM inbound_messages
              WHERE channel = 'weixin_ilink'
                AND open_kfid = ? AND external_userid = ?
                AND status = 'received' AND message_key <> ?
                AND inbox_seq < (
                  SELECT inbox_seq FROM inbound_messages WHERE message_key = ?
                )
              ORDER BY inbox_seq
            `).all(
              input.accountKey,
              account.owner_peer_id,
              deliverable.messageKey,
              deliverable.messageKey,
            ),
          )
        : [];
      if (backlog.length) {
        const placeholders = backlog.map(() => '?').join(',');
        this.#database.prepare(`
          UPDATE inbound_messages
          SET status = 'absorbed', deferred = 0, payload_json = NULL, updated_at = ?
          WHERE message_key IN (${placeholders}) AND status = 'received'
        `).run(now, ...backlog.map(({ message_key: key }) => key));
      }
      const backlogSummaries = backlog.flatMap(({ payload_json: payloadJson }) => {
        const summary = decodeObject(payloadJson)?.summary;
        return typeof summary === 'string' && summary ? [summary] : [];
      });
      const mergeKeys = deliverable
        ? [...new Set([
            ...insertedEntries.map(({ messageKey }) => messageKey),
            ...backlog.map(({ message_key: key }) => key),
          ])]
        : [];
      const mergedImageCount = mergeKeys.length
        ? Number(rowAs<{ count: number }>(this.#database.prepare(`
            SELECT COUNT(*) AS count FROM ilink_inbound_images
            WHERE message_key IN (${mergeKeys.map(() => '?').join(',')})
          `).get(...mergeKeys))?.count || 0)
        : 0;
      const mergedImages = mergeKeys.length
        ? rowsAs<{
            nonce: string;
            ciphertext: string;
            auth_tag: string;
            secret_generation: number;
          }>(this.#database.prepare(`
            SELECT image.nonce, image.ciphertext, image.auth_tag,
                   image.secret_generation
            FROM ilink_inbound_images AS image
            JOIN inbound_messages AS inbound USING (message_key)
            WHERE image.message_key IN (${mergeKeys.map(() => '?').join(',')})
            ORDER BY CASE WHEN image.message_key = ? THEN 0 ELSE 1 END,
                     inbound.inbox_seq DESC, image.position DESC
            LIMIT 4
          `).all(...mergeKeys, deliverable!.messageKey))
        : [];
      if (mergeKeys.length) {
        this.#database.prepare(`
          DELETE FROM ilink_inbound_images
          WHERE message_key IN (${mergeKeys.map(() => '?').join(',')})
        `).run(...mergeKeys);
      } else if (insertedEntries.length) {
        this.#database.prepare(`
          DELETE FROM ilink_inbound_images
          WHERE message_key IN (${insertedEntries.map(() => '?').join(',')})
        `).run(...insertedEntries.map(({ messageKey }) => messageKey));
      }
      if (deliverable) {
        for (const [position, image] of mergedImages.entries()) {
          this.#database.prepare(`
            INSERT INTO ilink_inbound_images (
              message_key, position, account_key, peer_id, secret_generation,
              nonce, ciphertext, auth_tag, created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            deliverable.messageKey,
            position,
            input.accountKey,
            account.owner_peer_id,
            image.secret_generation,
            image.nonce,
            image.ciphertext,
            image.auth_tag,
            now,
          );
        }
      }
      if (
        deliverable &&
        (backlogSummaries.length + pageSummaries.length > 1 || mergedImages.length)
      ) {
        const mergedPayload = {
          ...deliverable.payload,
          summary: [
            ...backlogSummaries,
            ...pageSummaries,
            ...(mergedImageCount > 4
              ? [`[iLink images: attached the latest 4 of ${mergedImageCount}]`]
              : []),
          ].join('\n'),
          attachments: mergedImages.map((_, position) => ({
            kind: 'image' as const,
            mediaId: `ilink:${position}`,
            filename: `ilink-image-${position}`,
            status: 'unresolved' as const,
          })),
        };
        this.#database.prepare(`
          UPDATE inbound_messages SET payload_json = ?, updated_at = ?
          WHERE message_key = ? AND status = 'received'
        `).run(encodeJson(mergedPayload), now, deliverable.messageKey);
      }
      return {
        insertedMessageKeys:
          deliverable && !deliverableDeferred ? [deliverable.messageKey] : [],
        replyWindowIds,
        deferredMessageCount: deliverableDeferred ? 1 : 0,
        cursor: nextCursor,
      };
    });
  }

  #validatePageEntry(
    entry: IlinkPollPageEntry,
    account: AccountRow,
    expectedCursor: string,
  ): void {
    if (!entry || typeof entry !== 'object') {
      fail('invalid_input', 'iLink poll entry is invalid');
    }
    const { message } = entry;
    assertIlinkEncryptedSecret(entry.sealedContextToken);
    nonNegativeInteger(entry.secretGeneration, 'secretGeneration');
    const sealedImages = entry.sealedImages || [];
    const imagePositions = new Set(
      message?.attachments.flatMap((attachment) => {
        const matched = attachment.kind === 'image'
          ? /^ilink:(\d+)$/u.exec(attachment.mediaId)
          : null;
        return matched?.[1] === undefined ? [] : [Number(matched[1])];
      }) || [],
    );
    if (
      imagePositions.size !== (message?.attachments.length || 0) ||
      sealedImages.length !== imagePositions.size
    ) {
      fail('invalid_input', 'iLink image locator count is inconsistent');
    }
    for (const image of sealedImages) {
      nonNegativeInteger(image.position, 'image position');
      nonNegativeInteger(image.secretGeneration, 'image secretGeneration');
      assertIlinkEncryptedSecret(image.sealedLocator);
      if (!imagePositions.has(image.position)) {
        fail('invalid_input', 'iLink image locator position is inconsistent');
      }
    }
    if (
      !message ||
      message.conversation.channel !== ILINK_CHANNEL ||
      message.conversation.accountKey !== account.account_key ||
      message.conversation.peerId !== account.owner_peer_id
    ) {
      fail('pair_mismatch', 'iLink poll message does not match its account');
    }
    if (message.sync.cursor !== expectedCursor) {
      fail('cursor_conflict', 'iLink message cursor does not match its page');
    }
    nonNegativeInteger(message.sync.index, 'message sync index');
    nonNegativeInteger(message.sentAt, 'message sentAt');
    if (entry.providerSeq !== undefined) {
      nonNegativeInteger(entry.providerSeq, 'message providerSeq');
    }
    if (
      !message.providerMessageId ||
      Buffer.byteLength(message.providerMessageId, 'utf8') >
        ILINK_MAX_PROVIDER_ID_BYTES
    ) {
      fail('invalid_input', 'iLink message identity is invalid');
    }
  }

  #validateDuplicate(message: NormalizedMessage, messageKey: string): void {
    const existing = rowAs<{
      message_key: string;
      open_kfid: string;
      msgid: string;
      external_userid: string;
      channel: string;
    }>(this.#database.prepare(`
      SELECT message_key, open_kfid, msgid, external_userid, channel
      FROM inbound_messages
      WHERE message_key = ?
    `).get(messageKey));
    if (
      !existing ||
      existing.message_key !== messageKey ||
      existing.open_kfid !== message.conversation.accountKey ||
      existing.msgid !== message.providerMessageId ||
      existing.external_userid !== message.conversation.peerId ||
      existing.channel !== ILINK_CHANNEL
    ) {
      fail('dedupe_invariant', 'iLink message dedupe identity conflicts');
    }
    const window = this.#database.prepare(`
      SELECT 1 FROM ilink_reply_windows WHERE source_message_key = ?
    `).get(messageKey);
    if (!window) {
      fail('dedupe_invariant', 'Deduplicated iLink message has no reply window');
    }
  }

  #openWindow(accountKey: string, peerId: string): ReplyWindowRow | undefined {
    return rowAs<ReplyWindowRow>(this.#database.prepare(`
      SELECT window.*, inbound.msgid AS provider_message_id
      FROM ilink_reply_windows AS window
      JOIN inbound_messages AS inbound
        ON inbound.message_key = window.source_message_key
      WHERE window.account_key = ? AND window.peer_id = ?
        AND window.state = 'open'
    `).get(accountKey, peerId));
  }

  #insertReplyWindow(
    account: AccountRow,
    entry: IlinkPollPageEntry,
    sourceMessageKey: string,
    sourceInboxSeq: number,
    pageWindowSources: ReadonlySet<string>,
    now: number,
  ): number {
    const { message } = entry;
    const current = this.#openWindow(
      account.account_key,
      message.conversation.peerId,
    );
    const becomesOpen = !current || entryIsNewer(
      entry,
      current,
      pageWindowSources.has(current.source_message_key),
    );
    if (current && becomesOpen) {
      this.#retireWindow(
        current.reply_window_id,
        'superseded',
        now,
        'superseded_by_newer_ilink_message',
      );
    }
    if (message.sentAt > now + MAX_UPSTREAM_CLOCK_SKEW_MS) {
      fail('invalid_input', 'iLink message timestamp is too far in the future');
    }
    const expiresAt = Math.min(message.sentAt, now) +
      ILINK_REPLY_WINDOW_LIFETIME_MS;
    if (!Number.isSafeInteger(expiresAt) || expiresAt <= message.sentAt) {
      fail('invalid_input', 'iLink reply window expiry is invalid');
    }
    const inserted = this.#database.prepare(`
      INSERT INTO ilink_reply_windows (
        account_key, peer_id, account_generation,
        source_message_key, source_inbox_seq, provider_seq,
        issued_at, expires_at, max_sends,
        next_send_index, reserved_send_count, transmitted_send_count,
        state, secret_generation, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, ?, ?, ?, ?)
    `).run(
      account.account_key,
      message.conversation.peerId,
      account.generation,
      sourceMessageKey,
      sourceInboxSeq,
      entry.providerSeq ?? null,
      message.sentAt,
      expiresAt,
      ILINK_REPLY_WINDOW_MAX_SENDS,
      becomesOpen ? 'open' : 'superseded',
      entry.secretGeneration,
      now,
      now,
    );
    const replyWindowId = Number(inserted.lastInsertRowid);
    positiveInteger(replyWindowId, 'replyWindowId');
    if (becomesOpen) {
      this.#database.prepare(`
        INSERT INTO ilink_reply_window_secrets (
          reply_window_id, nonce, ciphertext, auth_tag, updated_at
        ) VALUES (?, ?, ?, ?, ?)
      `).run(
        replyWindowId,
        entry.sealedContextToken.nonce,
        entry.sealedContextToken.ciphertext,
        entry.sealedContextToken.authTag,
        now,
      );
    }
    return replyWindowId;
  }

  #retireWindow(
    replyWindowId: number,
    state: 'superseded' | 'cancelled',
    now: number,
    reason: string,
  ): void {
    this.#database.prepare(`
      UPDATE send_attempts
      SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
      WHERE reply_window_id = ? AND channel = 'weixin_ilink'
        AND status = 'pending'
    `).run(reason, 'iLink reply window is no longer active', now, replyWindowId);
    this.#database.prepare(`
      UPDATE agent_sessions
      SET closed_at = ?, updated_at = ?
      WHERE reply_window_id = ? AND channel = 'weixin_ilink'
        AND closed_at = 0
    `).run(now, now, replyWindowId);
    this.#database.prepare(`
      UPDATE ilink_reply_windows
      SET state = ?, reserved_send_count = 0, updated_at = ?
      WHERE reply_window_id = ? AND state = 'open'
    `).run(state, now, replyWindowId);
    this.#database.prepare(`
      DELETE FROM ilink_reply_window_secrets WHERE reply_window_id = ?
    `).run(replyWindowId);
  }

  getReplyWindow(replyWindowId: number): IlinkReplyWindowRecord | undefined {
    positiveInteger(replyWindowId, 'replyWindowId');
    const row = rowAs<ReplyWindowRow>(this.#database.prepare(`
      SELECT * FROM ilink_reply_windows WHERE reply_window_id = ?
    `).get(replyWindowId));
    return row ? mapReplyWindow(row) : undefined;
  }

  getReplyWindowSecret(
    replyWindowId: number,
  ): IlinkReplyWindowSecret | undefined {
    positiveInteger(replyWindowId, 'replyWindowId');
    const row = rowAs<ReplyWindowSecretRow>(this.#database.prepare(`
      SELECT window.*, secret.nonce, secret.ciphertext, secret.auth_tag,
             secret.updated_at AS secret_updated_at
      FROM ilink_reply_windows AS window
      JOIN ilink_reply_window_secrets AS secret USING (reply_window_id)
      WHERE window.reply_window_id = ?
    `).get(replyWindowId));
    if (!row) return undefined;
    assertIlinkAccountKey(row.account_key);
    return {
      replyWindowId: Number(row.reply_window_id),
      accountKey: row.account_key,
      peerId: row.peer_id,
      accountGeneration: Number(row.account_generation),
      secretGeneration: Number(row.secret_generation),
      sourceMessageKey: row.source_message_key,
      sourceInboxSeq: Number(row.source_inbox_seq),
      issuedAt: Number(row.issued_at),
      expiresAt: Number(row.expires_at),
      sealedContextToken: sealedSecret(row),
      updatedAt: Number(row.secret_updated_at),
    };
  }

  getReplyWindowSecretBySource(
    messageKey: string,
  ): IlinkReplyWindowSecret | undefined {
    const row = rowAs<{ reply_window_id: number }>(this.#database.prepare(`
      SELECT reply_window_id FROM ilink_reply_windows
      WHERE source_message_key = ?
    `).get(String(messageKey || '')));
    return row ? this.getReplyWindowSecret(Number(row.reply_window_id)) : undefined;
  }

  getInboundImageSecret(
    messageKey: string,
    position: number,
  ): IlinkInboundImageSecret | undefined {
    const row = rowAs<{
      message_key: string;
      position: number;
      account_key: string;
      peer_id: string;
      secret_generation: number;
      nonce: string;
      ciphertext: string;
      auth_tag: string;
    }>(this.#database.prepare(`
      SELECT * FROM ilink_inbound_images
      WHERE message_key = ? AND position = ?
    `).get(String(messageKey || ''), position));
    if (!row) return undefined;
    assertIlinkAccountKey(row.account_key);
    return {
      messageKey: row.message_key,
      position: Number(row.position),
      accountKey: row.account_key,
      peerId: row.peer_id,
      secretGeneration: Number(row.secret_generation),
      sealedLocator: {
        nonce: row.nonce,
        ciphertext: row.ciphertext,
        authTag: row.auth_tag,
      },
    };
  }

  reserveStartedSystemAttempt(input: ReserveIlinkSystemSendInput): AttemptRecord {
    const now = this.#now(input.now);
    const payloadJson = encodeJson(input.payload);
    return this.#transaction(() => {
      const window = rowAs<ReplyWindowRow>(this.#database.prepare(`
        SELECT * FROM ilink_reply_windows
        WHERE source_message_key = ?
      `).get(input.messageKey));
      if (!window) fail('reply_window_not_found', 'iLink reply window is missing');
      const account = this.#accountRow(window.account_key as IlinkAccountKey);
      if (
        !account || account.status !== 'active' ||
        account.generation !== window.account_generation || window.state !== 'open'
      ) {
        fail('reply_window_inactive', 'iLink reply window is not active');
      }
      if (now >= window.expires_at) {
        fail('reply_window_expired', 'iLink reply window has expired');
      }
      if (
        window.reserved_send_count + window.transmitted_send_count >=
        window.max_sends
      ) {
        fail('reply_quota_exhausted', 'iLink reply window quota is exhausted');
      }
      const sending = this.#database.prepare(`
        SELECT 1 FROM send_attempts
        WHERE channel = 'weixin_ilink' AND status = 'sending'
          AND open_kfid = ? AND external_userid = ? LIMIT 1
      `).get(window.account_key, window.peer_id);
      if (sending) fail('send_in_progress', 'Another iLink send is in progress');
      const physical = Number(rowAs<{ next_index: number }>(this.#database.prepare(`
        SELECT COALESCE(MAX(send_index) + 1, 0) AS next_index
        FROM send_attempts WHERE source_message_key = ?
      `).get(input.messageKey))?.next_index || 0);
      if (!Number.isSafeInteger(physical) || physical < 0 || physical >= 1_000) {
        fail('attempt_conflict', 'iLink source attempt index is exhausted');
      }
      const attemptKey = stableAttemptKey(input.messageKey, physical);
      const clientMessageId = stableClientMessageId(input.messageKey, physical);
      const metadataJson = encodeJson({
        ...(input.metadata || {}),
        direction: window.source_inbox_seq,
        replyWindowSendIndex: window.next_send_index,
      });
      const updated = this.#database.prepare(`
        UPDATE ilink_reply_windows
        SET next_send_index = next_send_index + 1,
            transmitted_send_count = transmitted_send_count + 1, updated_at = ?
        WHERE reply_window_id = ? AND state = 'open'
          AND reserved_send_count + transmitted_send_count < max_sends
      `).run(now, window.reply_window_id);
      if (updated.changes !== 1) fail('attempt_conflict', 'iLink system send lost quota');
      this.#database.prepare(`
        INSERT INTO send_attempts (
          attempt_key, source_message_key, open_kfid, external_userid,
          channel, reply_window_id, send_index, source, sent_type,
          payload_json, metadata_json, fingerprint, client_message_id,
          status, wecom_msgid, error_code, error_message, fail_type,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'weixin_ilink', ?, ?, ?, ?, ?, ?, ?, ?,
                  'sending', '', '', '', 0, ?, ?)
      `).run(
        attemptKey,
        input.messageKey,
        window.account_key,
        window.peer_id,
        window.reply_window_id,
        physical,
        input.source,
        input.sentType,
        payloadJson,
        metadataJson,
        sha256(`${input.sentType}\0${payloadJson}`),
        clientMessageId,
        now,
        now,
      );
      return mapAttempt(rowAs<AttemptRow>(this.#database.prepare(`
        SELECT * FROM send_attempts WHERE attempt_key = ?
      `).get(attemptKey))!);
    });
  }

  #sessionWindow(sessionToken: string): AgentSessionWindowRow | undefined {
    if (!sessionToken) fail('invalid_agent_session', 'Agent session is required');
    return rowAs<AgentSessionWindowRow>(this.#database.prepare(`
      SELECT
        window.*,
        session.source_message_key AS session_source_message_key,
        session.open_kfid AS session_open_kfid,
        session.external_userid AS session_external_userid,
        session.reply_window_id AS session_reply_window_id,
        session.boundary_inbox_seq,
        session.expires_at AS session_expires_at,
        session.closed_at AS session_closed_at,
        inbound.status AS session_inbound_status,
        account.status AS account_status,
        account.generation AS current_account_generation
      FROM agent_sessions AS session
      JOIN ilink_reply_windows AS window
        ON window.reply_window_id = session.reply_window_id
      JOIN ilink_accounts AS account
        ON account.account_key = window.account_key
      JOIN inbound_messages AS inbound
        ON inbound.message_key = session.source_message_key
      WHERE session.token_hash = ? AND session.channel = 'weixin_ilink'
    `).get(sha256(sessionToken)));
  }

  #validateSessionWindow(
    row: AgentSessionWindowRow | undefined,
    now: number,
  ): AgentSessionWindowRow {
    if (
      !row ||
      row.session_closed_at !== 0 ||
      row.session_expires_at <= now ||
      !['processing', 'preparing'].includes(row.session_inbound_status) ||
      row.session_reply_window_id !== row.reply_window_id ||
      row.boundary_inbox_seq !== row.source_inbox_seq ||
      row.session_open_kfid !== row.account_key ||
      row.session_external_userid !== row.peer_id
    ) {
      fail('invalid_agent_session', 'Agent session is not active for iLink');
    }
    if (
      row.account_status !== 'active' ||
      row.current_account_generation !== row.account_generation
    ) {
      fail('generation_conflict', 'iLink account generation changed');
    }
    if (now >= row.expires_at) {
      fail('reply_window_expired', 'iLink reply window has expired');
    }
    if (row.state !== 'open') {
      fail('reply_window_inactive', 'iLink reply window is not active');
    }
    return row;
  }

  #prepareReplyAttempt(
    input: ReserveIlinkSendInput,
    persistRejection: boolean,
  ): PrepareIlinkReplyAttemptResult {
    const now = this.#now(input.now);
    if (!input.sentType) fail('invalid_input', 'sentType is required');
    const payloadJson = encodeJson(input.payload);
    const candidate = this.#sessionWindow(input.sessionToken);
    let window: AgentSessionWindowRow;
    let rejection: IlinkReplyRejection | undefined;
    try {
      window = this.#validateSessionWindow(candidate, now);
    } catch (error: unknown) {
      if (
        !persistRejection || !candidate ||
        !(error instanceof IlinkSqliteStoreError) ||
        error.code !== 'reply_window_expired'
      ) throw error;
      window = candidate;
      rejection = error.code;
    }
    if (
      !rejection &&
      window.reserved_send_count + window.transmitted_send_count >= window.max_sends
    ) {
      if (!persistRejection) {
        fail('reply_quota_exhausted', 'iLink reply window quota is exhausted');
      }
      rejection = 'reply_quota_exhausted';
    }
    const windowSendIndex = Number(window.next_send_index);
    const physicalIndexRow = rowAs<{ next_index: number }>(this.#database.prepare(`
        SELECT COALESCE(MAX(send_index) + 1, 0) AS next_index
        FROM send_attempts WHERE source_message_key = ?
      `).get(window.session_source_message_key));
    const sendIndex = Number(physicalIndexRow?.next_index ?? 0);
    if (!Number.isSafeInteger(sendIndex) || sendIndex < 0 || sendIndex >= 1000) {
      fail('reply_quota_exhausted', 'iLink source attempt index is exhausted');
    }
    const attemptKey = stableAttemptKey(window.session_source_message_key, sendIndex);
    const clientMessageId = stableClientMessageId(
      window.session_source_message_key,
      sendIndex,
    );
    const metadataJson = encodeJson({
      ...(input.metadata || {}),
      direction: window.source_inbox_seq,
      replyWindowSendIndex: windowSendIndex,
    });
    if (!rejection) {
      const windowUpdate = this.#database.prepare(`
        UPDATE ilink_reply_windows
        SET next_send_index = next_send_index + 1,
            reserved_send_count = reserved_send_count + 1,
            updated_at = ?
        WHERE reply_window_id = ? AND state = 'open'
          AND account_generation = ?
          AND next_send_index = ?
          AND reserved_send_count + transmitted_send_count < max_sends
      `).run(
        now,
        window.reply_window_id,
        window.account_generation,
        windowSendIndex,
      );
      if (windowUpdate.changes !== 1) {
        fail('attempt_conflict', 'iLink reply reservation lost its race');
      }
    }
    this.#database.prepare(`
        INSERT INTO send_attempts (
          attempt_key, source_message_key, open_kfid, external_userid,
          channel, reply_window_id, send_index, source, sent_type,
          payload_json, metadata_json, fingerprint, client_message_id,
          status, wecom_msgid, error_code, error_message, fail_type,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'weixin_ilink', ?, ?, 'mcp_tool', ?, ?, ?, ?, ?,
                  ?, '', ?, ?, 0, ?, ?)
      `).run(
        attemptKey,
        window.session_source_message_key,
        window.account_key,
        window.peer_id,
        window.reply_window_id,
        sendIndex,
        input.sentType,
        payloadJson,
        metadataJson,
        sha256(`${input.sentType}\0${payloadJson}`),
        clientMessageId,
        rejection ? 'failed' : 'pending',
        rejection || '',
        rejection === 'reply_window_expired'
          ? 'iLink reply window expired before network transmission'
          : rejection === 'reply_quota_exhausted'
            ? 'iLink 10-message reply quota exhausted before network transmission'
            : '',
        now,
        now,
      );
    const attempt = mapAttempt(rowAs<AttemptRow>(this.#database.prepare(`
        SELECT * FROM send_attempts WHERE attempt_key = ?
      `).get(attemptKey))!);
    return rejection
      ? { kind: 'rejected', attempt, code: rejection }
      : { kind: 'reserved', attempt };
  }

  reserveReplyAttempt(input: ReserveIlinkSendInput): AttemptRecord {
    const result = this.#transaction(() => this.#prepareReplyAttempt(input, false));
    if (result.kind !== 'reserved') fail('attempt_conflict', 'Unexpected rejection');
    return result.attempt;
  }

  prepareReplyAttempt(input: ReserveIlinkSendInput): PrepareIlinkReplyAttemptResult {
    return this.#transaction(() => this.#prepareReplyAttempt(input, true));
  }

  #pendingReplyAttempt(input: StartIlinkSendInput, now: number) {
    const window = this.#validateSessionWindow(
      this.#sessionWindow(input.sessionToken),
      now,
    );
    const attempt = rowAs<AttemptRow>(this.#database.prepare(`
      SELECT * FROM send_attempts
      WHERE attempt_key = ? AND channel = 'weixin_ilink'
    `).get(input.attemptId));
    if (
      !attempt || attempt.status !== 'pending' ||
      attempt.reply_window_id !== window.reply_window_id ||
      attempt.open_kfid !== window.account_key ||
      attempt.external_userid !== window.peer_id
    ) fail('attempt_conflict', 'iLink reply attempt is not reservable');
    return { window, attempt };
  }

  validatePendingReplyAttempt(input: StartIlinkSendInput): AttemptRecord {
    const now = this.#now(input.now);
    return this.#transaction(() =>
      mapAttempt(this.#pendingReplyAttempt(input, now).attempt)!
    );
  }

  startReplyAttempt(input: StartIlinkSendInput): AttemptRecord {
    const now = this.#now(input.now);
    return this.#transaction(() => {
      const { window, attempt } = this.#pendingReplyAttempt(input, now);
      const sending = this.#database.prepare(`
        SELECT 1 FROM send_attempts
        WHERE channel = 'weixin_ilink' AND status = 'sending'
          AND open_kfid = ? AND external_userid = ?
        LIMIT 1
      `).get(window.account_key, window.peer_id);
      if (sending) {
        fail('send_in_progress', 'Another iLink send is already in progress');
      }
      const attemptUpdate = this.#database.prepare(`
        UPDATE send_attempts SET status = 'sending', updated_at = ?
        WHERE attempt_key = ? AND status = 'pending'
      `).run(now, attempt.attempt_key);
      const windowUpdate = this.#database.prepare(`
        UPDATE ilink_reply_windows
        SET reserved_send_count = reserved_send_count - 1,
            transmitted_send_count = transmitted_send_count + 1,
            updated_at = ?
        WHERE reply_window_id = ? AND state = 'open'
          AND reserved_send_count > 0
          AND reserved_send_count + transmitted_send_count <= max_sends
      `).run(now, window.reply_window_id);
      if (attemptUpdate.changes !== 1 || windowUpdate.changes !== 1) {
        fail('attempt_conflict', 'iLink reply attempt start lost its race');
      }
      return mapAttempt(rowAs<AttemptRow>(this.#database.prepare(`
        SELECT * FROM send_attempts WHERE attempt_key = ?
      `).get(attempt.attempt_key))!);
    });
  }
}
