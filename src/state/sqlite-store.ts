import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import {
  MAX_WECHAT_IMAGE_BYTES,
  detectImageFormat,
} from '../lib/image-format.ts';
import { ensurePrivateDirectory } from '../lib/private-directory.ts';

import type {
  ChatChannel,
  ImageAttachment,
  MediaCatalogEntry,
  NormalizedMessage,
} from '../types.ts';
import {
  canonicalValue,
  requiredText,
  sha256,
  stableAttemptKey,
  stableClientMessageId,
  stableMessageKey,
  type JsonObject,
  type JsonValue,
} from './compat.ts';

export { stableClientMessageId, stableMessageKey } from './compat.ts';
export type { JsonObject } from './compat.ts';

const SCHEMA_VERSION = 24;
const INBOUND_STATUSES = [
  'received',
  'processing',
  'preparing',
  'ready',
  'completed',
  'steering',
  'steered',
  'absorbed',
  'failed',
  'ignored',
  'suppressed',
] as const;
const SEND_STATUSES = [
  'pending',
  'sending',
  'accepted',
  'failed',
  'uncertain',
] as const;

export type InboundStatus = (typeof INBOUND_STATUSES)[number];
type SendStatus = (typeof SEND_STATUSES)[number];
export interface InboundRecord {
  inboxSeq: number;
  messageKey: string;
  channel: ChatChannel;
  accountKey: string;
  providerMessageId: string;
  peerId: string;
  origin: string;
  type: string;
  sentAt: number;
  status: InboundStatus;
  deferred: boolean;
  primaryMessageKey: string;
  payload?: JsonObject;
  codexTurnId: string;
  clientInputId: string;
  errorMessage: string;
  createdAt: number;
  updatedAt: number;
}

export interface InboxInsertEntry {
  readonly message: NormalizedMessage;
  readonly deferred?: boolean;
}

export interface InboxInsertResult {
  readonly messageKey: string;
  readonly inboxSeq: number;
  readonly inserted: boolean;
}

export interface ConversationRecord {
  channel: ChatChannel;
  accountKey: string;
  peerId: string;
  threadId: string;
  memoryThreadId: string;
  updatedAt: number;
}

export interface AuthorizationRecord {
  peerId: string;
  authorized: boolean;
  consecutiveMatches: number;
  lastAccountKey: string;
  lastMessageKey: string;
  authorizedAt: number;
  updatedAt: number;
}

export interface AuthorizationEvaluation {
  decision: 'blocked' | 'authorized_now' | 'already_authorized' | 'duplicate';
  consecutiveMatches: number;
}

export interface AttemptRecord {
  attemptId: string;
  messageKey: string;
  channel: ChatChannel;
  accountKey: string;
  peerId: string;
  replyWindowId: number;
  sendIndex: number;
  source: string;
  type: string;
  payload?: JsonObject;
  metadata?: JsonObject;
  fingerprint: string;
  clientMessageId: string;
  status: SendStatus;
  providerMessageId: string;
  errorCode: string;
  errorMessage: string;
  failType: number;
  createdAt: number;
  updatedAt: number;
}

export interface AgentSessionRecord {
  token: string;
  messageKey: string;
  channel: ChatChannel;
  accountKey: string;
  peerId: string;
  replyWindowId: number;
  boundaryInboxSeq: number;
  memoryThreadId: string;
  mediaCatalog: MediaCatalogEntry[];
  expiresAt: number;
  closedAt: number;
  createdAt: number;
  updatedAt: number;
}

export interface StartupRecovery {
  uncertainSends: number;
  inbound: InboundRecord[];
}

interface InboundRow {
  inbox_seq: number;
  message_key: string;
  open_kfid: string;
  msgid: string;
  external_userid: string;
  channel: ChatChannel;
  origin: string;
  msg_type: string;
  sent_at: number;
  status: InboundStatus;
  deferred: number;
  primary_message_key: string | null;
  payload_json: string | null;
  codex_turn_id: string;
  client_input_id: string;
  error_message: string;
  created_at: number;
  updated_at: number;
}

interface ConversationRow {
  channel: ChatChannel;
  open_kfid: string;
  external_userid: string;
  thread_id: string;
  memory_thread_id: string;
  updated_at: number;
}

interface AttemptRow {
  attempt_key: string;
  source_message_key: string;
  open_kfid: string;
  external_userid: string;
  channel: ChatChannel;
  reply_window_id: number | null;
  send_index: number;
  source: string;
  sent_type: string;
  payload_json: string | null;
  metadata_json: string | null;
  fingerprint: string;
  client_message_id: string;
  status: SendStatus;
  wecom_msgid: string;
  error_code: string;
  error_message: string;
  fail_type: number;
  created_at: number;
  updated_at: number;
}

interface AgentSessionRow {
  token_hash: string;
  source_message_key: string;
  open_kfid: string;
  external_userid: string;
  channel: ChatChannel;
  reply_window_id: number | null;
  boundary_inbox_seq: number;
  memory_thread_id: string;
  media_json: string;
  expires_at: number;
  closed_at: number;
  created_at: number;
  updated_at: number;
}

interface InsertAttemptInput {
  sourceMessageKey: string;
  accountKey: string;
  peerId: string;
  channel?: ChatChannel;
  replyWindowId?: number;
  sendIndex: number;
  source?: string;
  sentType: string;
  payload?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
}

type SqlInputValue = null | number | bigint | string | Uint8Array;
type SqlRow = Record<string, unknown>;
type Clock = () => number;

/** @internal Connection injection is reserved for the persistence boundary and tests. */
interface SqliteStoreInternalOptions {
  readonly database: DatabaseSync;
}

function rowAs<T>(row: unknown): T | undefined {
  return row === undefined ? undefined : row as T;
}

function rowsAs<T>(rows: readonly unknown[]): T[] {
  return rows as T[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** @internal Persistence lifecycle helper shared by initialization and close. */
export function secureSqliteFiles(filePath: string): void {
  for (const candidate of [filePath, `${filePath}-wal`, `${filePath}-shm`]) {
    try {
      fs.chmodSync(candidate, 0o600);
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
  }
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return String(error.code ?? '');
}

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',');
}

function encodeJson(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return JSON.stringify(canonicalValue(value));
}

function decodeJson(value: string | null | undefined): JsonValue | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return JSON.parse(value);
}

function objectJson(value: string | null): JsonObject | undefined {
  const decoded = decodeJson(value);
  return decoded && !Array.isArray(decoded) && typeof decoded === 'object'
    ? decoded
    : undefined;
}

function inboundPayload(row: InboundRow): JsonObject | undefined {
  const payload = objectJson(row.payload_json);
  if (!payload) return undefined;
  const legacyProviderMessageId = payload.id;
  const { id: _legacyId, messageKey: _legacyMessageKey, ...normalized } = payload;
  return {
    ...normalized,
    providerMessageId: String(
      normalized.providerMessageId || legacyProviderMessageId || row.msgid,
    ),
  };
}

function mapInbound(row: InboundRow | undefined): InboundRecord | undefined {
  if (!row) return undefined;
  const payload = inboundPayload(row);
  return {
    inboxSeq: row.inbox_seq,
    messageKey: row.message_key,
    channel: row.channel,
    accountKey: row.open_kfid,
    providerMessageId: row.msgid,
    peerId: row.external_userid,
    origin: row.origin,
    type: row.msg_type,
    sentAt: row.sent_at,
    status: row.status,
    deferred: row.deferred === 1,
    primaryMessageKey: row.primary_message_key || '',
    ...(payload ? { payload } : {}),
    codexTurnId: row.codex_turn_id,
    clientInputId: row.client_input_id,
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapConversation(
  row: ConversationRow | undefined,
): ConversationRecord | undefined {
  if (!row) return undefined;
  return {
    channel: row.channel,
    accountKey: row.open_kfid,
    peerId: row.external_userid,
    threadId: row.thread_id,
    memoryThreadId: row.memory_thread_id,
    updatedAt: row.updated_at,
  };
}

function mapAttempt(row: AttemptRow | undefined): AttemptRecord | undefined {
  if (!row) return undefined;
  const payload = objectJson(row.payload_json);
  const metadata = objectJson(row.metadata_json);
  return {
    attemptId: row.attempt_key,
    messageKey: row.source_message_key,
    channel: row.channel,
    accountKey: row.open_kfid,
    peerId: row.external_userid,
    replyWindowId: Number(row.reply_window_id || 0),
    sendIndex: row.send_index,
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
    failType: row.fail_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSessionMedia(
  value: JsonValue | undefined,
  row: AgentSessionRow,
): MediaCatalogEntry[] {
  if (!Array.isArray(value)) {
    throw new AgentSessionError('Agent session media catalog is invalid');
  }
  return value.map((item) => {
    if (!item || Array.isArray(item) || typeof item !== 'object') {
      throw new AgentSessionError('Agent session media catalog is invalid');
    }
    const legacy = item as JsonObject;
    const channel = String(legacy.channel || row.channel);
    const accountKey = String(
      legacy.accountKey || legacy.openKfId || row.open_kfid,
    );
    const peerId = String(
      legacy.peerId || legacy.externalUserId || row.external_userid,
    );
    if (
      channel !== row.channel ||
      accountKey !== row.open_kfid ||
      peerId !== row.external_userid
    ) {
      throw new AgentSessionError('Agent session media identity is invalid');
    }
    const {
      openKfId: _legacyAccountKey,
      externalUserId: _legacyPeerId,
      ...normalized
    } = legacy;
    return {
      ...normalized,
      channel: row.channel,
      accountKey,
      peerId,
    } as unknown as MediaCatalogEntry;
  });
}

function mapAgentSession(
  row: AgentSessionRow | undefined,
  token: string,
): AgentSessionRecord | undefined {
  if (!row) return undefined;
  const media = decodeJson(row.media_json);
  return {
    token,
    messageKey: row.source_message_key,
    channel: row.channel,
    accountKey: row.open_kfid,
    peerId: row.external_userid,
    replyWindowId: Number(row.reply_window_id || 0),
    boundaryInboxSeq: row.boundary_inbox_seq,
    memoryThreadId: row.memory_thread_id,
    mediaCatalog: mapSessionMedia(media, row),
    expiresAt: row.expires_at,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function inboundInsert(
  accountKey: string,
  message: NormalizedMessage,
): {
  messageKey: string;
  accountKey: string;
  providerMessageId: string;
  peerId: string;
  channel: ChatChannel;
  origin: string;
  type: string;
  sentAt: number;
  status: 'received';
  payload: unknown;
} {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Inbound message must be an object');
  }
  if (message.conversation.accountKey !== accountKey) {
    throw new Error('Inbound message account does not match its sync source');
  }
  const channel = message.conversation.channel;
  const msgid = requiredText(
    message.providerMessageId,
    'providerMessageId',
  );
  return {
    messageKey: stableMessageKey(channel, accountKey, msgid),
    accountKey,
    providerMessageId: msgid,
    peerId: requiredText(message.conversation.peerId, 'peerId'),
    channel,
    origin: String(message.origin || 'unknown'),
    type: String(message.type || 'unknown'),
    sentAt: Number(message.sentAt || 0),
    status: 'received',
    payload: message,
  };
}

export class CursorConflictError extends Error {
  readonly code = 'cursor_conflict';
  readonly expected: string;
  readonly actual: string;

  constructor(accountKey: string, expected: string, actual: string) {
    super(
      `Cursor conflict for ${accountKey}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
    this.name = 'CursorConflictError';
    this.expected = expected;
    this.actual = actual;
  }
}

class SendInvariantError extends Error {
  readonly code: string;

  constructor(message: string, code = 'send_fingerprint_conflict') {
    super(message);
    this.name = 'SendInvariantError';
    this.code = code;
  }
}

export class AgentSessionError extends Error {
  readonly code: string;

  constructor(message: string, code = 'invalid_agent_session') {
    super(message);
    this.name = 'AgentSessionError';
    this.code = code;
  }
}

export class SqliteStore {
  readonly filePath: string;
  readonly #database: DatabaseSync;
  private readonly clock: Clock;

  constructor({
    filePath,
    clock = Date.now,
    journalMode = 'WAL',
  }: {
    filePath: string;
    clock?: Clock;
    journalMode?: 'WAL' | 'DELETE';
  }, internal: SqliteStoreInternalOptions) {
    if (!filePath) throw new Error('SQLite filePath is required');
    if (!['WAL', 'DELETE'].includes(journalMode)) {
      throw new Error(`Unsupported SQLite journal mode: ${journalMode}`);
    }

    this.filePath = path.resolve(filePath);
    this.clock = clock;
    const databaseDirectory = path.dirname(this.filePath);
    ensurePrivateDirectory(databaseDirectory);
    this.#database = internal.database;
    fs.chmodSync(this.filePath, 0o600);
    this.#database.exec('PRAGMA busy_timeout = 5000');
    this.#database.exec(`PRAGMA journal_mode = ${journalMode}`);
    this.#database.exec('PRAGMA synchronous = FULL');
    this.#database.exec('PRAGMA foreign_keys = ON');
    this.#initializeSchema();
    secureSqliteFiles(this.filePath);
  }

  #now(): number {
    return Number(this.clock());
  }

  #initializeSchema(): void {
    const versionRow = rowAs<{ user_version: number }>(
      this.#database.prepare('PRAGMA user_version').get(),
    );
    let version = Number(versionRow?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `SQLite schema version ${version} is newer than supported version ${SCHEMA_VERSION}`,
      );
    }
    if (version === SCHEMA_VERSION) return;
    if (
      version !== 0 && version !== 11 && version !== 12 &&
      version !== 13 && version !== 14 && version !== 15 &&
      version !== 16 && version !== 17 && version !== 18 && version !== 19 &&
      version !== 20 && version !== 21 && version !== 22 && version !== 23
    ) {
      throw new Error(
        `SQLite schema version ${version} is no longer supported; migrate to version 11 through 23 first`,
      );
    }

    if (version === 11) {
      this.#database.exec(`
        PRAGMA foreign_keys = OFF;
        PRAGMA legacy_alter_table = ON;
        BEGIN IMMEDIATE;
      `);
      try {
        this.#database.exec(`
          CREATE TEMP TABLE stale_v11_sources (
            message_key TEXT PRIMARY KEY
          ) STRICT;
          INSERT INTO stale_v11_sources (message_key)
          SELECT inbound.message_key
          FROM inbound_messages AS inbound
          JOIN conversations AS conversation
            ON conversation.open_kfid = inbound.open_kfid
           AND conversation.external_userid = inbound.external_userid
          WHERE inbound.primary_message_key IS NULL
            AND (
              (
                conversation.mode = 'human'
                AND inbound.status IN (
                  'received', 'failed', 'processing', 'preparing', 'ready'
                )
              )
              OR (
                inbound.status IN ('failed', 'processing', 'preparing', 'ready')
                AND inbound.claimed_conversation_epoch <>
                    conversation.automation_epoch
              )
            );
          UPDATE inbound_messages
          SET status = 'suppressed', payload_json = NULL,
              error_message = 'retired_conversation_state'
          WHERE (
              message_key IN (SELECT message_key FROM stale_v11_sources)
              OR primary_message_key IN (
                SELECT message_key FROM stale_v11_sources
              )
            )
            AND status NOT IN ('completed', 'ignored', 'absorbed');
          UPDATE send_attempts
          SET status = 'failed', error_code = 'suppressed',
              error_message = 'retired_conversation_state'
          WHERE source_message_key IN (
              SELECT message_key FROM stale_v11_sources
            )
            AND status = 'pending';

          UPDATE inbound_messages
          SET status = 'ignored', payload_json = NULL
          WHERE status = 'held';
          UPDATE inbound_messages
          SET payload_json = NULL
          WHERE status = 'absorbed';

          DROP INDEX inbound_pending_idx;
          DROP INDEX inbound_primary_idx;
          ALTER TABLE inbound_messages RENAME TO inbound_messages_v11;
          CREATE TABLE inbound_messages (
            inbox_seq INTEGER PRIMARY KEY AUTOINCREMENT,
            message_key TEXT NOT NULL UNIQUE,
            open_kfid TEXT NOT NULL,
            msgid TEXT NOT NULL,
            external_userid TEXT NOT NULL DEFAULT '',
            origin TEXT NOT NULL,
            msg_type TEXT NOT NULL,
            sent_at INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL CHECK (status IN (${sqlList(INBOUND_STATUSES)})),
            primary_message_key TEXT,
            payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
            codex_turn_id TEXT NOT NULL DEFAULT '',
            client_input_id TEXT NOT NULL DEFAULT '',
            steering_boundary INTEGER NOT NULL DEFAULT 0,
            error_message TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE (open_kfid, msgid),
            UNIQUE (message_key, open_kfid, external_userid),
            FOREIGN KEY (primary_message_key)
              REFERENCES inbound_messages(message_key)
          ) STRICT;
          INSERT INTO inbound_messages (
            inbox_seq, message_key, open_kfid, msgid, external_userid,
            origin, msg_type, sent_at, status, primary_message_key,
            payload_json, codex_turn_id, client_input_id, steering_boundary,
            error_message, created_at, updated_at
          )
          SELECT
            inbox_seq, message_key, open_kfid, msgid, external_userid,
            origin, msg_type, sent_at, status, primary_message_key,
            payload_json, codex_turn_id, client_input_id, steering_boundary,
            error_message, created_at, updated_at
          FROM inbound_messages_v11;
          DROP TABLE inbound_messages_v11;
          CREATE INDEX inbound_pending_idx
            ON inbound_messages(status, open_kfid, external_userid, inbox_seq);
          CREATE INDEX inbound_primary_idx
            ON inbound_messages(primary_message_key, inbox_seq);

          DROP INDEX conversation_thread_idx;
          ALTER TABLE conversations RENAME TO conversations_v11;
          CREATE TABLE conversations (
            open_kfid TEXT NOT NULL,
            external_userid TEXT NOT NULL,
            thread_id TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (open_kfid, external_userid)
          ) STRICT, WITHOUT ROWID;
          INSERT INTO conversations (
            open_kfid, external_userid, thread_id, updated_at
          )
          SELECT open_kfid, external_userid, thread_id, updated_at
          FROM conversations_v11;
          DROP TABLE conversations_v11;
          CREATE UNIQUE INDEX conversation_thread_idx
            ON conversations(thread_id) WHERE thread_id <> '';

          DROP INDEX agent_session_source_idx;
          ALTER TABLE agent_sessions RENAME TO agent_sessions_v11;
          CREATE TABLE agent_sessions (
            token_hash TEXT PRIMARY KEY,
            source_message_key TEXT NOT NULL,
            open_kfid TEXT NOT NULL,
            external_userid TEXT NOT NULL,
            boundary_inbox_seq INTEGER NOT NULL CHECK (boundary_inbox_seq >= 0),
            media_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(media_json)),
            expires_at INTEGER NOT NULL,
            closed_at INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (source_message_key, open_kfid, external_userid)
              REFERENCES inbound_messages(
                message_key, open_kfid, external_userid
              ) ON DELETE CASCADE
          ) STRICT;
          INSERT INTO agent_sessions (
            token_hash, source_message_key, open_kfid, external_userid,
            boundary_inbox_seq, media_json, expires_at, closed_at,
            created_at, updated_at
          )
          SELECT
            token_hash, source_message_key, open_kfid, external_userid,
            boundary_inbox_seq, media_json, expires_at,
            CASE WHEN closed_at = 0 THEN MAX(updated_at, 1) ELSE closed_at END,
            created_at, updated_at
          FROM agent_sessions_v11;
          DROP TABLE agent_sessions_v11;
          CREATE INDEX agent_session_source_idx
            ON agent_sessions(source_message_key, closed_at, expires_at);
          DROP TABLE stale_v11_sources;

          PRAGMA user_version = 12;
        `);
        const violations = this.foreignKeyCheck();
        if (violations.length) {
          throw new Error('SQLite migration v12 created foreign-key violations');
        }
        this.#database.exec('COMMIT');
        version = 12;
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      } finally {
        this.#database.exec(`
          PRAGMA legacy_alter_table = OFF;
          PRAGMA foreign_keys = ON;
        `);
      }
    }

    if (version === 12) {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        this.#database.exec(`
          ALTER TABLE inbound_messages
            ADD COLUMN deferred INTEGER NOT NULL DEFAULT 0
              CHECK (deferred IN (0, 1));
          CREATE INDEX inbound_deferred_idx
            ON inbound_messages(deferred, status, inbox_seq);
          PRAGMA user_version = 13;
          COMMIT;
        `);
        version = 13;
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    }

    if (version === 13) {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        this.#database.exec(`
          ALTER TABLE conversations
            ADD COLUMN memory_thread_id TEXT NOT NULL DEFAULT '';
          ALTER TABLE agent_sessions
            ADD COLUMN memory_thread_id TEXT NOT NULL DEFAULT '';
          PRAGMA user_version = 14;
          COMMIT;
        `);
        version = 14;
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    }

    if (version === 14) {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        this.#database.exec(`
          CREATE TABLE IF NOT EXISTS maintainer_binding (
            singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
            open_kfid TEXT NOT NULL,
            external_userid TEXT NOT NULL,
            bound_message_key TEXT NOT NULL,
            bound_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT;
          PRAGMA user_version = 15;
          COMMIT;
        `);
        version = 15;
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    }

    if (version === 15) {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        this.#database.exec(`
          ALTER TABLE inbound_messages
            ADD COLUMN channel TEXT NOT NULL DEFAULT 'wechat_kf'
              CHECK (channel IN ('wechat_kf', 'weixin_ilink'));
          ALTER TABLE agent_sessions
            ADD COLUMN channel TEXT NOT NULL DEFAULT 'wechat_kf'
              CHECK (channel IN ('wechat_kf', 'weixin_ilink'));
          ALTER TABLE agent_sessions
            ADD COLUMN reply_window_id INTEGER;

          CREATE TABLE ilink_accounts (
            account_key TEXT PRIMARY KEY,
            provider_account_id TEXT NOT NULL UNIQUE,
            owner_peer_id TEXT NOT NULL,
            base_url TEXT NOT NULL,
            generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
            status TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active', 'paused', 'disabled', 'revoked')),
            pause_until INTEGER NOT NULL DEFAULT 0,
            cursor TEXT NOT NULL DEFAULT '',
            cursor_updated_at INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT, WITHOUT ROWID;
          CREATE UNIQUE INDEX ilink_active_owner_idx
            ON ilink_accounts(owner_peer_id)
            WHERE status IN ('active', 'paused');

          CREATE TABLE ilink_account_secrets (
            account_key TEXT PRIMARY KEY,
            account_generation INTEGER NOT NULL CHECK (account_generation > 0),
            nonce TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            auth_tag TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (account_key) REFERENCES ilink_accounts(account_key)
              ON DELETE CASCADE
          ) STRICT, WITHOUT ROWID;

          CREATE TABLE ilink_reply_windows (
            reply_window_id INTEGER PRIMARY KEY AUTOINCREMENT,
            account_key TEXT NOT NULL,
            peer_id TEXT NOT NULL,
            account_generation INTEGER NOT NULL CHECK (account_generation > 0),
            source_message_key TEXT NOT NULL UNIQUE,
            source_inbox_seq INTEGER NOT NULL CHECK (source_inbox_seq > 0),
            provider_seq INTEGER,
            issued_at INTEGER NOT NULL,
            expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
            max_sends INTEGER NOT NULL DEFAULT 10
              CHECK (max_sends BETWEEN 1 AND 10),
            next_send_index INTEGER NOT NULL DEFAULT 0
              CHECK (next_send_index >= 0),
            reserved_send_count INTEGER NOT NULL DEFAULT 0
              CHECK (reserved_send_count >= 0),
            transmitted_send_count INTEGER NOT NULL DEFAULT 0
              CHECK (transmitted_send_count >= 0),
            state TEXT NOT NULL DEFAULT 'open'
              CHECK (state IN ('open', 'superseded', 'closed', 'cancelled')),
            secret_generation INTEGER NOT NULL CHECK (secret_generation >= 0),
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (account_key) REFERENCES ilink_accounts(account_key),
            FOREIGN KEY (source_message_key) REFERENCES inbound_messages(message_key),
            CHECK (reserved_send_count + transmitted_send_count <= max_sends)
          ) STRICT;
          CREATE UNIQUE INDEX ilink_one_open_window_idx
            ON ilink_reply_windows(account_key, peer_id) WHERE state = 'open';

          CREATE TABLE ilink_reply_window_secrets (
            reply_window_id INTEGER PRIMARY KEY,
            nonce TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            auth_tag TEXT NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (reply_window_id)
              REFERENCES ilink_reply_windows(reply_window_id) ON DELETE CASCADE
          ) STRICT, WITHOUT ROWID;

          DROP INDEX send_status_idx;
          DROP INDEX send_wecom_msgid_idx;
          DROP INDEX send_conversation_idx;
          ALTER TABLE send_attempts RENAME TO send_attempts_v15;
          CREATE TABLE send_attempts (
            attempt_key TEXT PRIMARY KEY,
            source_message_key TEXT NOT NULL,
            open_kfid TEXT NOT NULL,
            external_userid TEXT NOT NULL,
            channel TEXT NOT NULL DEFAULT 'wechat_kf'
              CHECK (channel IN ('wechat_kf', 'weixin_ilink')),
            reply_window_id INTEGER,
            send_index INTEGER NOT NULL CHECK (send_index >= 0 AND send_index < 1000),
            source TEXT NOT NULL,
            sent_type TEXT NOT NULL,
            payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
            metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
            fingerprint TEXT NOT NULL,
            client_message_id TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK (status IN (${sqlList(SEND_STATUSES)})),
            wecom_msgid TEXT NOT NULL DEFAULT '',
            error_code TEXT NOT NULL DEFAULT '',
            error_message TEXT NOT NULL DEFAULT '',
            fail_type INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE (source_message_key, send_index),
            FOREIGN KEY (source_message_key, open_kfid, external_userid)
              REFERENCES inbound_messages(message_key, open_kfid, external_userid),
            FOREIGN KEY (reply_window_id)
              REFERENCES ilink_reply_windows(reply_window_id)
          ) STRICT;
          INSERT INTO send_attempts (
            attempt_key, source_message_key, open_kfid, external_userid,
            channel, reply_window_id, send_index, source, sent_type,
            payload_json, metadata_json, fingerprint, client_message_id,
            status, wecom_msgid, error_code, error_message, fail_type,
            created_at, updated_at
          )
          SELECT
            attempt_key, source_message_key, open_kfid, external_userid,
            'wechat_kf', NULL, send_index, source, sent_type,
            payload_json, metadata_json, fingerprint, client_message_id,
            status, wecom_msgid, error_code, error_message, fail_type,
            created_at, updated_at
          FROM send_attempts_v15;
          DROP TABLE send_attempts_v15;
          CREATE INDEX send_status_idx
            ON send_attempts(channel, status, created_at, send_index);
          CREATE UNIQUE INDEX send_wecom_msgid_idx
            ON send_attempts(wecom_msgid) WHERE wecom_msgid <> '';
          CREATE INDEX send_conversation_idx
            ON send_attempts(open_kfid, external_userid, updated_at DESC);

          PRAGMA user_version = 16;
          COMMIT;
        `);
        version = 16;
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    }

    if (version === 16) {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        this.#database.exec(`
          CREATE TABLE ilink_login_offers (
            offer_id TEXT PRIMARY KEY,
            source_message_key TEXT NOT NULL,
            source_open_kfid TEXT NOT NULL,
            source_external_userid TEXT NOT NULL,
            secret_generation INTEGER NOT NULL CHECK (secret_generation >= 0),
            nonce TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            auth_tag TEXT NOT NULL,
            api_base_url TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'waiting'
              CHECK (status IN (
                'waiting', 'scanned', 'confirmed', 'expired', 'failed', 'cancelled'
              )),
            expires_at INTEGER NOT NULL,
            last_polled_at INTEGER NOT NULL DEFAULT 0,
            error_code TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT, WITHOUT ROWID;
          CREATE UNIQUE INDEX ilink_one_pending_offer_idx
            ON ilink_login_offers(source_open_kfid, source_external_userid)
            WHERE status IN ('waiting', 'scanned');
          PRAGMA user_version = 17;
          COMMIT;
        `);
        version = 17;
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    }

    if (version === 17) {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        this.#database.exec(`
          CREATE TABLE IF NOT EXISTS ilink_enrollment_audit (
            offer_id TEXT PRIMARY KEY,
            source_message_key TEXT NOT NULL,
            source_open_kfid TEXT NOT NULL,
            source_external_userid TEXT NOT NULL,
            account_key TEXT NOT NULL DEFAULT '',
            result TEXT NOT NULL
              CHECK (result IN ('confirmed', 'expired', 'failed', 'cancelled')),
            offered_at INTEGER NOT NULL,
            completed_at INTEGER NOT NULL
          ) STRICT, WITHOUT ROWID;

          DROP TRIGGER IF EXISTS ilink_session_window_insert_guard;
          DROP TRIGGER IF EXISTS ilink_session_window_update_guard;
          DROP TRIGGER IF EXISTS ilink_attempt_window_insert_guard;
          DROP TRIGGER IF EXISTS ilink_attempt_window_update_guard;
          DROP TRIGGER IF EXISTS ilink_window_source_insert_guard;
          DROP TRIGGER IF EXISTS ilink_window_source_update_guard;
          DROP TRIGGER IF EXISTS ilink_window_delete_guard;

          CREATE TRIGGER ilink_session_window_insert_guard
          BEFORE INSERT ON agent_sessions
          WHEN (
            (NEW.channel = 'wechat_kf' AND NEW.reply_window_id IS NOT NULL) OR
            (NEW.channel = 'weixin_ilink' AND (
              NEW.reply_window_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM ilink_reply_windows AS window
                WHERE window.reply_window_id = NEW.reply_window_id
                  AND window.account_key = NEW.open_kfid
                  AND window.peer_id = NEW.external_userid
                  AND window.source_inbox_seq = NEW.boundary_inbox_seq
                  AND window.state = 'open'
              )
            ))
          ) BEGIN SELECT RAISE(ABORT, 'agent session channel/window mismatch'); END;
          CREATE TRIGGER ilink_session_window_update_guard
          BEFORE UPDATE OF channel, reply_window_id, open_kfid,
            external_userid, boundary_inbox_seq ON agent_sessions
          WHEN (
            (NEW.channel = 'wechat_kf' AND NEW.reply_window_id IS NOT NULL) OR
            (NEW.channel = 'weixin_ilink' AND (
              NEW.reply_window_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM ilink_reply_windows AS window
                WHERE window.reply_window_id = NEW.reply_window_id
                  AND window.account_key = NEW.open_kfid
                  AND window.peer_id = NEW.external_userid
                  AND window.source_inbox_seq = NEW.boundary_inbox_seq
                  AND window.state = 'open'
              )
            ))
          ) BEGIN SELECT RAISE(ABORT, 'agent session channel/window mismatch'); END;

          CREATE TRIGGER ilink_attempt_window_insert_guard
          BEFORE INSERT ON send_attempts
          WHEN (
            (NEW.channel = 'wechat_kf' AND NEW.reply_window_id IS NOT NULL) OR
            (NEW.channel = 'weixin_ilink' AND (
              NEW.reply_window_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM ilink_reply_windows AS window
                WHERE window.reply_window_id = NEW.reply_window_id
                  AND window.account_key = NEW.open_kfid
                  AND window.peer_id = NEW.external_userid
              )
            ))
          ) BEGIN SELECT RAISE(ABORT, 'send attempt channel/window mismatch'); END;
          CREATE TRIGGER ilink_attempt_window_update_guard
          BEFORE UPDATE OF channel, reply_window_id, open_kfid,
            external_userid ON send_attempts
          WHEN (
            (NEW.channel = 'wechat_kf' AND NEW.reply_window_id IS NOT NULL) OR
            (NEW.channel = 'weixin_ilink' AND (
              NEW.reply_window_id IS NULL OR NOT EXISTS (
                SELECT 1 FROM ilink_reply_windows AS window
                WHERE window.reply_window_id = NEW.reply_window_id
                  AND window.account_key = NEW.open_kfid
                  AND window.peer_id = NEW.external_userid
              )
            ))
          ) BEGIN SELECT RAISE(ABORT, 'send attempt channel/window mismatch'); END;

          CREATE TRIGGER ilink_window_source_insert_guard
          BEFORE INSERT ON ilink_reply_windows
          WHEN NOT EXISTS (
            SELECT 1 FROM inbound_messages AS inbound
            WHERE inbound.message_key = NEW.source_message_key
              AND inbound.open_kfid = NEW.account_key
              AND inbound.external_userid = NEW.peer_id
              AND inbound.channel = 'weixin_ilink'
          ) BEGIN SELECT RAISE(ABORT, 'reply window source mismatch'); END;
          CREATE TRIGGER ilink_window_source_update_guard
          BEFORE UPDATE OF source_message_key, account_key, peer_id
            ON ilink_reply_windows
          WHEN NOT EXISTS (
            SELECT 1 FROM inbound_messages AS inbound
            WHERE inbound.message_key = NEW.source_message_key
              AND inbound.open_kfid = NEW.account_key
              AND inbound.external_userid = NEW.peer_id
              AND inbound.channel = 'weixin_ilink'
          ) BEGIN SELECT RAISE(ABORT, 'reply window source mismatch'); END;
          CREATE TRIGGER ilink_window_delete_guard
          BEFORE DELETE ON ilink_reply_windows
          WHEN EXISTS (
            SELECT 1 FROM agent_sessions
            WHERE reply_window_id = OLD.reply_window_id
          ) BEGIN SELECT RAISE(ABORT, 'reply window still has agent sessions'); END;

          PRAGMA user_version = 18;
          COMMIT;
        `);
        version = 18;
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    }

    if (version === 18) {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        this.#database.exec(`
          CREATE TABLE ilink_inbound_images (
            message_key TEXT NOT NULL,
            position INTEGER NOT NULL CHECK (position >= 0),
            account_key TEXT NOT NULL,
            peer_id TEXT NOT NULL,
            secret_generation INTEGER NOT NULL CHECK (secret_generation >= 0),
            nonce TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            auth_tag TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            PRIMARY KEY (message_key, position),
            FOREIGN KEY (message_key, account_key, peer_id)
              REFERENCES inbound_messages(message_key, open_kfid, external_userid)
              ON DELETE CASCADE
          ) STRICT, WITHOUT ROWID;
          CREATE INDEX IF NOT EXISTS ilink_inbound_images_created_idx
            ON ilink_inbound_images(created_at);
          PRAGMA user_version = 19;
          COMMIT;
        `);
        version = 19;
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    }

    if (version === 19) {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        this.#database.exec(`
          CREATE INDEX IF NOT EXISTS ilink_reply_windows_expiry_idx
            ON ilink_reply_windows(expires_at, state);
          CREATE INDEX IF NOT EXISTS ilink_reply_windows_updated_idx
            ON ilink_reply_windows(updated_at, state);
          PRAGMA user_version = 20;
          COMMIT;
        `);
        version = 20;
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    }

    if (version === 20) {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        this.#database.exec(`
          UPDATE send_attempts
          SET status = 'failed', error_code = 'feature_removed',
              error_message = 'Retired notification tool removed before transmission'
          WHERE source IN ('maintainer_binding', 'maintainer_notify')
            AND status = 'pending';
          DROP TABLE IF EXISTS maintainer_binding;
          PRAGMA user_version = 21;
          COMMIT;
        `);
        version = 21;
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
    }

    if (version === 21) {
      if (this.foreignKeyCheck().length) {
        throw new Error(
          'SQLite schema v21 contains foreign-key violations; repair the database before upgrading',
        );
      }
      this.#database.exec(`
        PRAGMA foreign_keys = OFF;
        PRAGMA legacy_alter_table = ON;
        BEGIN IMMEDIATE;
      `);
      try {
        this.#database.exec(`
          DROP TRIGGER IF EXISTS ilink_session_window_insert_guard;
          DROP TRIGGER IF EXISTS ilink_session_window_update_guard;
          DROP TRIGGER IF EXISTS ilink_attempt_window_insert_guard;
          DROP TRIGGER IF EXISTS ilink_attempt_window_update_guard;
          DROP TRIGGER IF EXISTS ilink_window_source_insert_guard;
          DROP TRIGGER IF EXISTS ilink_window_source_update_guard;
          DROP TRIGGER IF EXISTS ilink_window_delete_guard;

          DROP INDEX inbound_pending_idx;
          DROP INDEX inbound_primary_idx;
          DROP INDEX inbound_deferred_idx;
          DROP INDEX conversation_thread_idx;
          DROP INDEX send_status_idx;
          DROP INDEX send_wecom_msgid_idx;
          DROP INDEX send_conversation_idx;
          DROP INDEX media_conversation_idx;
          DROP INDEX agent_session_source_idx;

          ALTER TABLE agent_sessions RENAME TO agent_sessions_v21;
          ALTER TABLE send_attempts RENAME TO send_attempts_v21;
          ALTER TABLE inbound_media RENAME TO inbound_media_v21;
          ALTER TABLE conversations RENAME TO conversations_v21;
          ALTER TABLE inbound_messages RENAME TO inbound_messages_v21;

          CREATE TABLE inbound_messages (
            inbox_seq INTEGER PRIMARY KEY AUTOINCREMENT,
            message_key TEXT NOT NULL UNIQUE,
            open_kfid TEXT NOT NULL,
            msgid TEXT NOT NULL,
            external_userid TEXT NOT NULL DEFAULT '',
            channel TEXT NOT NULL
              CHECK (channel IN ('wechat_kf', 'weixin_ilink')),
            origin TEXT NOT NULL,
            msg_type TEXT NOT NULL,
            sent_at INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL CHECK (status IN (${sqlList(INBOUND_STATUSES)})),
            deferred INTEGER NOT NULL DEFAULT 0 CHECK (deferred IN (0, 1)),
            primary_message_key TEXT,
            payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
            codex_turn_id TEXT NOT NULL DEFAULT '',
            client_input_id TEXT NOT NULL DEFAULT '',
            steering_boundary INTEGER NOT NULL DEFAULT 0,
            error_message TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE (channel, open_kfid, msgid),
            UNIQUE (message_key, open_kfid, external_userid),
            UNIQUE (message_key, channel, open_kfid, external_userid),
            FOREIGN KEY (
              primary_message_key, channel, open_kfid, external_userid
            ) REFERENCES inbound_messages(
              message_key, channel, open_kfid, external_userid
            )
          ) STRICT;
          INSERT INTO inbound_messages (
            inbox_seq, message_key, open_kfid, msgid, external_userid,
            channel, origin, msg_type, sent_at, status, deferred,
            primary_message_key, payload_json, codex_turn_id, client_input_id,
            steering_boundary, error_message, created_at, updated_at
          )
          SELECT
            old.inbox_seq, old.message_key, old.open_kfid, old.msgid,
            old.external_userid, old.channel, old.origin, old.msg_type,
            old.sent_at,
            CASE
              WHEN old.primary_message_key IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM inbound_messages_v21 AS primary_message
                  WHERE primary_message.message_key = old.primary_message_key
                    AND primary_message.channel = old.channel
                    AND primary_message.open_kfid = old.open_kfid
                    AND primary_message.external_userid = old.external_userid
                )
                AND old.status IN ('steering', 'steered')
              THEN 'received'
              ELSE old.status
            END,
            old.deferred,
            CASE
              WHEN old.primary_message_key IS NULL OR EXISTS (
                SELECT 1 FROM inbound_messages_v21 AS primary_message
                WHERE primary_message.message_key = old.primary_message_key
                  AND primary_message.channel = old.channel
                  AND primary_message.open_kfid = old.open_kfid
                  AND primary_message.external_userid = old.external_userid
              ) THEN old.primary_message_key
              ELSE NULL
            END,
            old.payload_json,
            CASE
              WHEN old.primary_message_key IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM inbound_messages_v21 AS primary_message
                  WHERE primary_message.message_key = old.primary_message_key
                    AND primary_message.channel = old.channel
                    AND primary_message.open_kfid = old.open_kfid
                    AND primary_message.external_userid = old.external_userid
                )
              THEN ''
              ELSE old.codex_turn_id
            END,
            CASE
              WHEN old.primary_message_key IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM inbound_messages_v21 AS primary_message
                  WHERE primary_message.message_key = old.primary_message_key
                    AND primary_message.channel = old.channel
                    AND primary_message.open_kfid = old.open_kfid
                    AND primary_message.external_userid = old.external_userid
                )
              THEN ''
              ELSE old.client_input_id
            END,
            CASE
              WHEN old.primary_message_key IS NOT NULL
                AND NOT EXISTS (
                  SELECT 1 FROM inbound_messages_v21 AS primary_message
                  WHERE primary_message.message_key = old.primary_message_key
                    AND primary_message.channel = old.channel
                    AND primary_message.open_kfid = old.open_kfid
                    AND primary_message.external_userid = old.external_userid
                )
              THEN 0
              ELSE old.steering_boundary
            END,
            old.error_message, old.created_at, old.updated_at
          FROM inbound_messages_v21 AS old;

          CREATE TABLE conversations (
            channel TEXT NOT NULL
              CHECK (channel IN ('wechat_kf', 'weixin_ilink')),
            open_kfid TEXT NOT NULL,
            external_userid TEXT NOT NULL,
            thread_id TEXT NOT NULL DEFAULT '',
            memory_thread_id TEXT NOT NULL DEFAULT '',
            updated_at INTEGER NOT NULL,
            PRIMARY KEY (channel, open_kfid, external_userid)
          ) STRICT, WITHOUT ROWID;
          CREATE TEMP TABLE conversation_identities_v22 (
            channel TEXT NOT NULL,
            open_kfid TEXT NOT NULL,
            external_userid TEXT NOT NULL,
            latest_inbox_seq INTEGER NOT NULL,
            latest_updated_at INTEGER NOT NULL,
            PRIMARY KEY (channel, open_kfid, external_userid)
          ) STRICT, WITHOUT ROWID;
          INSERT INTO conversation_identities_v22 (
            channel, open_kfid, external_userid,
            latest_inbox_seq, latest_updated_at
          )
          SELECT
            channel, open_kfid, external_userid,
            MAX(inbox_seq), MAX(updated_at)
          FROM inbound_messages_v21
          WHERE external_userid <> ''
          GROUP BY channel, open_kfid, external_userid;
          INSERT INTO conversation_identities_v22 (
            channel, open_kfid, external_userid,
            latest_inbox_seq, latest_updated_at
          )
          SELECT
            'wechat_kf', old.open_kfid, old.external_userid, 0, old.updated_at
          FROM conversations_v21 AS old
          WHERE NOT EXISTS (
            SELECT 1 FROM conversation_identities_v22 AS identity
            WHERE identity.open_kfid = old.open_kfid
              AND identity.external_userid = old.external_userid
          );
          INSERT INTO conversations (
            channel, open_kfid, external_userid,
            thread_id, memory_thread_id, updated_at
          )
          SELECT
            identity.channel, identity.open_kfid, identity.external_userid,
            CASE
              WHEN old.open_kfid IS NOT NULL AND identity.channel = (
                SELECT owner.channel
                FROM conversation_identities_v22 AS owner
                WHERE owner.open_kfid = identity.open_kfid
                  AND owner.external_userid = identity.external_userid
                ORDER BY owner.latest_inbox_seq DESC, owner.channel
                LIMIT 1
              ) THEN old.thread_id
              ELSE ''
            END,
            CASE
              WHEN old.open_kfid IS NOT NULL AND identity.channel = (
                SELECT owner.channel
                FROM conversation_identities_v22 AS owner
                WHERE owner.open_kfid = identity.open_kfid
                  AND owner.external_userid = identity.external_userid
                ORDER BY owner.latest_inbox_seq DESC, owner.channel
                LIMIT 1
              ) THEN old.memory_thread_id
              ELSE ''
            END,
            COALESCE(old.updated_at, identity.latest_updated_at)
          FROM conversation_identities_v22 AS identity
          LEFT JOIN conversations_v21 AS old
            ON old.open_kfid = identity.open_kfid
           AND old.external_userid = identity.external_userid;
          DROP TABLE conversation_identities_v22;

          CREATE TABLE inbound_media (
            media_seq INTEGER PRIMARY KEY AUTOINCREMENT,
            message_key TEXT NOT NULL,
            channel TEXT NOT NULL
              CHECK (channel IN ('wechat_kf', 'weixin_ilink')),
            open_kfid TEXT NOT NULL,
            external_userid TEXT NOT NULL,
            position INTEGER NOT NULL CHECK (position >= 0),
            kind TEXT NOT NULL,
            media_id TEXT NOT NULL,
            filename TEXT NOT NULL DEFAULT '',
            sent_at INTEGER NOT NULL DEFAULT 0,
            remembered_at INTEGER NOT NULL,
            UNIQUE (message_key, position),
            FOREIGN KEY (
              message_key, channel, open_kfid, external_userid
            ) REFERENCES inbound_messages(
              message_key, channel, open_kfid, external_userid
            ) ON DELETE CASCADE
          ) STRICT;
          INSERT INTO inbound_media (
            media_seq, message_key, channel, open_kfid, external_userid,
            position, kind, media_id, filename, sent_at, remembered_at
          )
          SELECT
            media.media_seq, media.message_key, inbound.channel,
            media.open_kfid, media.external_userid, media.position,
            media.kind, media.media_id, media.filename,
            media.sent_at, media.remembered_at
          FROM inbound_media_v21 AS media
          JOIN inbound_messages AS inbound
            ON inbound.message_key = media.message_key;

          CREATE TABLE send_attempts (
            attempt_key TEXT PRIMARY KEY,
            source_message_key TEXT NOT NULL,
            open_kfid TEXT NOT NULL,
            external_userid TEXT NOT NULL,
            channel TEXT NOT NULL
              CHECK (channel IN ('wechat_kf', 'weixin_ilink')),
            reply_window_id INTEGER,
            send_index INTEGER NOT NULL CHECK (send_index >= 0 AND send_index < 1000),
            source TEXT NOT NULL,
            sent_type TEXT NOT NULL,
            payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
            metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
            fingerprint TEXT NOT NULL,
            client_message_id TEXT NOT NULL UNIQUE,
            status TEXT NOT NULL CHECK (status IN (${sqlList(SEND_STATUSES)})),
            wecom_msgid TEXT NOT NULL DEFAULT '',
            error_code TEXT NOT NULL DEFAULT '',
            error_message TEXT NOT NULL DEFAULT '',
            fail_type INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            UNIQUE (source_message_key, send_index),
            FOREIGN KEY (
              source_message_key, channel, open_kfid, external_userid
            ) REFERENCES inbound_messages(
              message_key, channel, open_kfid, external_userid
            ),
            FOREIGN KEY (reply_window_id)
              REFERENCES ilink_reply_windows(reply_window_id)
          ) STRICT;
          INSERT INTO send_attempts (
            attempt_key, source_message_key, open_kfid, external_userid,
            channel, reply_window_id, send_index, source, sent_type,
            payload_json, metadata_json, fingerprint, client_message_id,
            status, wecom_msgid, error_code, error_message, fail_type,
            created_at, updated_at
          )
          SELECT
            attempt.attempt_key, attempt.source_message_key,
            attempt.open_kfid, attempt.external_userid, inbound.channel,
            attempt.reply_window_id, attempt.send_index, attempt.source,
            attempt.sent_type, attempt.payload_json, attempt.metadata_json,
            attempt.fingerprint, attempt.client_message_id, attempt.status,
            attempt.wecom_msgid, attempt.error_code, attempt.error_message,
            attempt.fail_type, attempt.created_at, attempt.updated_at
          FROM send_attempts_v21 AS attempt
          JOIN inbound_messages AS inbound
            ON inbound.message_key = attempt.source_message_key;

          CREATE TABLE agent_sessions (
            token_hash TEXT PRIMARY KEY,
            source_message_key TEXT NOT NULL,
            open_kfid TEXT NOT NULL,
            external_userid TEXT NOT NULL,
            channel TEXT NOT NULL
              CHECK (channel IN ('wechat_kf', 'weixin_ilink')),
            reply_window_id INTEGER,
            boundary_inbox_seq INTEGER NOT NULL CHECK (boundary_inbox_seq >= 0),
            memory_thread_id TEXT NOT NULL DEFAULT '',
            media_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(media_json)),
            expires_at INTEGER NOT NULL,
            closed_at INTEGER NOT NULL DEFAULT 0,
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL,
            FOREIGN KEY (
              source_message_key, channel, open_kfid, external_userid
            ) REFERENCES inbound_messages(
              message_key, channel, open_kfid, external_userid
            ) ON DELETE CASCADE
          ) STRICT;
          INSERT INTO agent_sessions (
            token_hash, source_message_key, open_kfid, external_userid,
            channel, reply_window_id, boundary_inbox_seq, memory_thread_id,
            media_json, expires_at, closed_at, created_at, updated_at
          )
          SELECT
            session.token_hash, session.source_message_key,
            session.open_kfid, session.external_userid, inbound.channel,
            session.reply_window_id, session.boundary_inbox_seq,
            session.memory_thread_id, session.media_json, session.expires_at,
            session.closed_at, session.created_at, session.updated_at
          FROM agent_sessions_v21 AS session
          JOIN inbound_messages AS inbound
            ON inbound.message_key = session.source_message_key;

          DROP TABLE agent_sessions_v21;
          DROP TABLE send_attempts_v21;
          DROP TABLE inbound_media_v21;
          DROP TABLE conversations_v21;
          DROP TABLE inbound_messages_v21;

          CREATE INDEX inbound_pending_idx
            ON inbound_messages(
              status, channel, open_kfid, external_userid, inbox_seq
            );
          CREATE INDEX inbound_primary_idx
            ON inbound_messages(primary_message_key, inbox_seq);
          CREATE INDEX inbound_deferred_idx
            ON inbound_messages(deferred, status, inbox_seq);
          CREATE UNIQUE INDEX conversation_thread_idx
            ON conversations(thread_id) WHERE thread_id <> '';
          CREATE INDEX send_status_idx
            ON send_attempts(channel, status, created_at, send_index);
          CREATE UNIQUE INDEX send_wecom_msgid_idx
            ON send_attempts(channel, wecom_msgid) WHERE wecom_msgid <> '';
          CREATE INDEX send_conversation_idx
            ON send_attempts(
              channel, open_kfid, external_userid, updated_at DESC
            );
          CREATE INDEX media_conversation_idx
            ON inbound_media(
              channel, open_kfid, external_userid, remembered_at DESC
            );
          CREATE INDEX agent_session_source_idx
            ON agent_sessions(source_message_key, closed_at, expires_at);

          CREATE TRIGGER ilink_session_window_insert_guard
          BEFORE INSERT ON agent_sessions WHEN (
            (NEW.channel = 'wechat_kf' AND NEW.reply_window_id IS NOT NULL) OR
            (NEW.channel = 'weixin_ilink' AND (NEW.reply_window_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM ilink_reply_windows AS window
              WHERE window.reply_window_id = NEW.reply_window_id
                AND window.account_key = NEW.open_kfid
                AND window.peer_id = NEW.external_userid
                AND window.source_inbox_seq = NEW.boundary_inbox_seq
                AND window.state = 'open'
            )))
          ) BEGIN SELECT RAISE(ABORT, 'agent session channel/window mismatch'); END;
          CREATE TRIGGER ilink_session_window_update_guard
          BEFORE UPDATE OF channel, reply_window_id, open_kfid,
            external_userid, boundary_inbox_seq ON agent_sessions WHEN (
            (NEW.channel = 'wechat_kf' AND NEW.reply_window_id IS NOT NULL) OR
            (NEW.channel = 'weixin_ilink' AND (NEW.reply_window_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM ilink_reply_windows AS window
              WHERE window.reply_window_id = NEW.reply_window_id
                AND window.account_key = NEW.open_kfid
                AND window.peer_id = NEW.external_userid
                AND window.source_inbox_seq = NEW.boundary_inbox_seq
                AND window.state = 'open'
            )))
          ) BEGIN SELECT RAISE(ABORT, 'agent session channel/window mismatch'); END;
          CREATE TRIGGER ilink_attempt_window_insert_guard
          BEFORE INSERT ON send_attempts WHEN (
            (NEW.channel = 'wechat_kf' AND NEW.reply_window_id IS NOT NULL) OR
            (NEW.channel = 'weixin_ilink' AND (NEW.reply_window_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM ilink_reply_windows AS window
              WHERE window.reply_window_id = NEW.reply_window_id
                AND window.account_key = NEW.open_kfid
                AND window.peer_id = NEW.external_userid
            )))
          ) BEGIN SELECT RAISE(ABORT, 'send attempt channel/window mismatch'); END;
          CREATE TRIGGER ilink_attempt_window_update_guard
          BEFORE UPDATE OF channel, reply_window_id, open_kfid,
            external_userid ON send_attempts WHEN (
            (NEW.channel = 'wechat_kf' AND NEW.reply_window_id IS NOT NULL) OR
            (NEW.channel = 'weixin_ilink' AND (NEW.reply_window_id IS NULL OR NOT EXISTS (
              SELECT 1 FROM ilink_reply_windows AS window
              WHERE window.reply_window_id = NEW.reply_window_id
                AND window.account_key = NEW.open_kfid
                AND window.peer_id = NEW.external_userid
            )))
          ) BEGIN SELECT RAISE(ABORT, 'send attempt channel/window mismatch'); END;
          CREATE TRIGGER ilink_window_source_insert_guard
          BEFORE INSERT ON ilink_reply_windows WHEN NOT EXISTS (
            SELECT 1 FROM inbound_messages AS inbound
            WHERE inbound.message_key = NEW.source_message_key
              AND inbound.open_kfid = NEW.account_key
              AND inbound.external_userid = NEW.peer_id
              AND inbound.channel = 'weixin_ilink'
          ) BEGIN SELECT RAISE(ABORT, 'reply window source mismatch'); END;
          CREATE TRIGGER ilink_window_source_update_guard
          BEFORE UPDATE OF source_message_key, account_key, peer_id
            ON ilink_reply_windows WHEN NOT EXISTS (
            SELECT 1 FROM inbound_messages AS inbound
            WHERE inbound.message_key = NEW.source_message_key
              AND inbound.open_kfid = NEW.account_key
              AND inbound.external_userid = NEW.peer_id
              AND inbound.channel = 'weixin_ilink'
          ) BEGIN SELECT RAISE(ABORT, 'reply window source mismatch'); END;
          CREATE TRIGGER ilink_window_delete_guard
          BEFORE DELETE ON ilink_reply_windows WHEN EXISTS (
            SELECT 1 FROM agent_sessions WHERE reply_window_id = OLD.reply_window_id
          ) BEGIN SELECT RAISE(ABORT, 'reply window still has agent sessions'); END;
        `);
        const violations = this.foreignKeyCheck();
        if (violations.length) {
          throw new Error('SQLite migration v22 created foreign-key violations');
        }
        this.#database.exec(`
          PRAGMA user_version = 22;
          COMMIT;
        `);
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      } finally {
        this.#database.exec(`
          PRAGMA legacy_alter_table = OFF;
          PRAGMA foreign_keys = ON;
        `);
      }
      version = 22;
    }

    if (version === 22) {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        const accountColumns = this.#database.prepare(
          'PRAGMA table_info(ilink_accounts)',
        ).all() as unknown as Array<{ name: string }>;
        if (!accountColumns.some(({ name }) => name === 'agent_access')) {
          this.#database.exec(`
            ALTER TABLE ilink_accounts ADD COLUMN agent_access TEXT NOT NULL
              DEFAULT 'restricted'
              CHECK (agent_access IN ('restricted', 'host'));
          `);
        }
        this.#database.exec(`
          DROP INDEX ilink_one_pending_offer_idx;
          ALTER TABLE ilink_login_offers RENAME TO ilink_login_offers_v22;
          CREATE TABLE ilink_login_offers (
            offer_id TEXT PRIMARY KEY,
            initiator_kind TEXT NOT NULL
              CHECK (initiator_kind IN ('local_operator', 'remote_adapter')),
            source_channel TEXT NOT NULL,
            source_message_key TEXT NOT NULL,
            source_account_id TEXT NOT NULL,
            source_peer_id TEXT NOT NULL,
            candidate_account_keys_json TEXT NOT NULL DEFAULT '[]'
              CHECK (json_valid(candidate_account_keys_json)),
            secret_generation INTEGER NOT NULL CHECK (secret_generation >= 0),
            nonce TEXT NOT NULL,
            ciphertext TEXT NOT NULL,
            auth_tag TEXT NOT NULL,
            api_base_url TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'waiting'
              CHECK (status IN (
                'waiting', 'scanned', 'confirmed', 'expired', 'failed', 'cancelled'
              )),
            expires_at INTEGER NOT NULL,
            last_polled_at INTEGER NOT NULL DEFAULT 0,
            error_code TEXT NOT NULL DEFAULT '',
            created_at INTEGER NOT NULL,
            updated_at INTEGER NOT NULL
          ) STRICT, WITHOUT ROWID;
          INSERT INTO ilink_login_offers (
            offer_id, initiator_kind, source_channel, source_message_key,
            source_account_id, source_peer_id, secret_generation,
            candidate_account_keys_json,
            nonce, ciphertext, auth_tag, api_base_url, status,
            expires_at, last_polled_at, error_code, created_at, updated_at
          )
          SELECT
            offer_id, 'remote_adapter', 'wechat_kf', source_message_key,
            source_open_kfid, source_external_userid, secret_generation,
            '[]',
            nonce, ciphertext, auth_tag, api_base_url, status,
            expires_at, last_polled_at, error_code, created_at, updated_at
          FROM ilink_login_offers_v22;
          DROP TABLE ilink_login_offers_v22;
          CREATE UNIQUE INDEX ilink_one_pending_offer_idx
            ON ilink_login_offers(
              source_channel, source_account_id, source_peer_id
            )
            WHERE status IN ('waiting', 'scanned');

          ALTER TABLE ilink_enrollment_audit RENAME TO ilink_enrollment_audit_v22;
          CREATE TABLE ilink_enrollment_audit (
            offer_id TEXT PRIMARY KEY,
            initiator_kind TEXT NOT NULL
              CHECK (initiator_kind IN ('local_operator', 'remote_adapter')),
            source_channel TEXT NOT NULL,
            source_message_key TEXT NOT NULL,
            source_account_id TEXT NOT NULL,
            source_peer_id TEXT NOT NULL,
            account_key TEXT NOT NULL DEFAULT '',
            result TEXT NOT NULL CHECK (result IN (
              'confirmed', 'expired', 'failed', 'cancelled',
              'already_connected', 'verification_required'
            )),
            offered_at INTEGER NOT NULL,
            completed_at INTEGER NOT NULL
          ) STRICT, WITHOUT ROWID;
          INSERT INTO ilink_enrollment_audit (
            offer_id, initiator_kind, source_channel, source_message_key,
            source_account_id, source_peer_id, account_key,
            result, offered_at, completed_at
          )
          SELECT
            offer_id, 'remote_adapter', 'wechat_kf', source_message_key,
            source_open_kfid, source_external_userid, account_key,
            result, offered_at, completed_at
          FROM ilink_enrollment_audit_v22;
          DROP TABLE ilink_enrollment_audit_v22;

          PRAGMA user_version = 23;
          COMMIT;
        `);
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
      version = 23;
    }

    if (version === 23) {
      this.#database.exec('BEGIN IMMEDIATE');
      try {
        const accountColumns = this.#database.prepare(
          'PRAGMA table_info(ilink_accounts)',
        ).all() as unknown as Array<{ name: string }>;
        if (!accountColumns.some(({ name }) => name === 'runtime_enabled')) {
          this.#database.exec(`
            ALTER TABLE ilink_accounts ADD COLUMN runtime_enabled INTEGER NOT NULL
              DEFAULT 0 CHECK (runtime_enabled IN (0, 1));
          `);
        }
        this.#database.exec(`
          UPDATE ilink_accounts
          SET runtime_enabled = 1
          WHERE status = 'active' AND (
            SELECT COUNT(*) FROM ilink_accounts WHERE status = 'active'
          ) = 1;
          PRAGMA user_version = 24;
          COMMIT;
        `);
      } catch (error) {
        this.#database.exec('ROLLBACK');
        throw error;
      }
      return;
    }

    this.#database.exec('BEGIN IMMEDIATE');
    try {
      this.#database.exec(`
        CREATE TABLE sync_cursors (
          open_kfid TEXT PRIMARY KEY,
          cursor TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE conversations (
          channel TEXT NOT NULL
            CHECK (channel IN ('wechat_kf', 'weixin_ilink')),
          open_kfid TEXT NOT NULL,
          external_userid TEXT NOT NULL,
          thread_id TEXT NOT NULL DEFAULT '',
          memory_thread_id TEXT NOT NULL DEFAULT '',
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (channel, open_kfid, external_userid)
        ) STRICT, WITHOUT ROWID;

        CREATE TABLE authorizations (
          external_userid TEXT PRIMARY KEY,
          authorized INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0, 1)),
          consecutive_matches INTEGER NOT NULL DEFAULT 0
            CHECK (consecutive_matches >= 0),
          last_open_kfid TEXT NOT NULL DEFAULT '',
          last_message_key TEXT NOT NULL DEFAULT '',
          authorized_at INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE ilink_accounts (
          account_key TEXT PRIMARY KEY,
          provider_account_id TEXT NOT NULL UNIQUE,
          owner_peer_id TEXT NOT NULL,
          base_url TEXT NOT NULL,
          generation INTEGER NOT NULL DEFAULT 1 CHECK (generation > 0),
          status TEXT NOT NULL DEFAULT 'active'
            CHECK (status IN ('active', 'paused', 'disabled', 'revoked')),
          agent_access TEXT NOT NULL DEFAULT 'restricted'
            CHECK (agent_access IN ('restricted', 'host')),
          runtime_enabled INTEGER NOT NULL DEFAULT 0
            CHECK (runtime_enabled IN (0, 1)),
          pause_until INTEGER NOT NULL DEFAULT 0,
          cursor TEXT NOT NULL DEFAULT '',
          cursor_updated_at INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT, WITHOUT ROWID;
        CREATE UNIQUE INDEX ilink_active_owner_idx
          ON ilink_accounts(owner_peer_id)
          WHERE status IN ('active', 'paused');

        CREATE TABLE ilink_account_secrets (
          account_key TEXT PRIMARY KEY,
          account_generation INTEGER NOT NULL CHECK (account_generation > 0),
          nonce TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (account_key) REFERENCES ilink_accounts(account_key)
            ON DELETE CASCADE
        ) STRICT, WITHOUT ROWID;

        CREATE TABLE ilink_login_offers (
          offer_id TEXT PRIMARY KEY,
          initiator_kind TEXT NOT NULL
            CHECK (initiator_kind IN ('local_operator', 'remote_adapter')),
          source_channel TEXT NOT NULL,
          source_message_key TEXT NOT NULL,
          source_account_id TEXT NOT NULL,
          source_peer_id TEXT NOT NULL,
          candidate_account_keys_json TEXT NOT NULL DEFAULT '[]'
            CHECK (json_valid(candidate_account_keys_json)),
          secret_generation INTEGER NOT NULL CHECK (secret_generation >= 0),
          nonce TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          api_base_url TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'waiting'
            CHECK (status IN (
              'waiting', 'scanned', 'confirmed', 'expired', 'failed', 'cancelled'
            )),
          expires_at INTEGER NOT NULL,
          last_polled_at INTEGER NOT NULL DEFAULT 0,
          error_code TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT, WITHOUT ROWID;
        CREATE UNIQUE INDEX ilink_one_pending_offer_idx
          ON ilink_login_offers(
            source_channel, source_account_id, source_peer_id
          )
          WHERE status IN ('waiting', 'scanned');

        CREATE TABLE ilink_enrollment_audit (
          offer_id TEXT PRIMARY KEY,
          initiator_kind TEXT NOT NULL
            CHECK (initiator_kind IN ('local_operator', 'remote_adapter')),
          source_channel TEXT NOT NULL,
          source_message_key TEXT NOT NULL,
          source_account_id TEXT NOT NULL,
          source_peer_id TEXT NOT NULL,
          account_key TEXT NOT NULL DEFAULT '',
          result TEXT NOT NULL CHECK (result IN (
            'confirmed', 'expired', 'failed', 'cancelled',
            'already_connected', 'verification_required'
          )),
          offered_at INTEGER NOT NULL,
          completed_at INTEGER NOT NULL
        ) STRICT, WITHOUT ROWID;

        CREATE TABLE inbound_messages (
          inbox_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          message_key TEXT NOT NULL UNIQUE,
          open_kfid TEXT NOT NULL,
          msgid TEXT NOT NULL,
          external_userid TEXT NOT NULL DEFAULT '',
          channel TEXT NOT NULL
            CHECK (channel IN ('wechat_kf', 'weixin_ilink')),
          origin TEXT NOT NULL,
          msg_type TEXT NOT NULL,
          sent_at INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL CHECK (status IN (${sqlList(INBOUND_STATUSES)})),
          deferred INTEGER NOT NULL DEFAULT 0 CHECK (deferred IN (0, 1)),
          primary_message_key TEXT,
          payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
          codex_turn_id TEXT NOT NULL DEFAULT '',
          client_input_id TEXT NOT NULL DEFAULT '',
          steering_boundary INTEGER NOT NULL DEFAULT 0,
          error_message TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (channel, open_kfid, msgid),
          UNIQUE (message_key, open_kfid, external_userid),
          UNIQUE (message_key, channel, open_kfid, external_userid),
          FOREIGN KEY (
            primary_message_key, channel, open_kfid, external_userid
          ) REFERENCES inbound_messages(
            message_key, channel, open_kfid, external_userid
          )
        ) STRICT;

        CREATE TABLE inbound_media (
          media_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          message_key TEXT NOT NULL,
          channel TEXT NOT NULL
            CHECK (channel IN ('wechat_kf', 'weixin_ilink')),
          open_kfid TEXT NOT NULL,
          external_userid TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 0),
          kind TEXT NOT NULL,
          media_id TEXT NOT NULL,
          filename TEXT NOT NULL DEFAULT '',
          sent_at INTEGER NOT NULL DEFAULT 0,
          remembered_at INTEGER NOT NULL,
          UNIQUE (message_key, position),
          FOREIGN KEY (message_key, channel, open_kfid, external_userid)
            REFERENCES inbound_messages(
              message_key, channel, open_kfid, external_userid
            ) ON DELETE CASCADE
        ) STRICT;

        CREATE TABLE ilink_inbound_images (
          message_key TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 0),
          account_key TEXT NOT NULL,
          peer_id TEXT NOT NULL,
          secret_generation INTEGER NOT NULL CHECK (secret_generation >= 0),
          nonce TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          PRIMARY KEY (message_key, position),
          FOREIGN KEY (message_key, account_key, peer_id)
            REFERENCES inbound_messages(message_key, open_kfid, external_userid)
            ON DELETE CASCADE
        ) STRICT, WITHOUT ROWID;
        CREATE INDEX ilink_inbound_images_created_idx
          ON ilink_inbound_images(created_at);

        CREATE TABLE ilink_reply_windows (
          reply_window_id INTEGER PRIMARY KEY AUTOINCREMENT,
          account_key TEXT NOT NULL,
          peer_id TEXT NOT NULL,
          account_generation INTEGER NOT NULL CHECK (account_generation > 0),
          source_message_key TEXT NOT NULL UNIQUE,
          source_inbox_seq INTEGER NOT NULL CHECK (source_inbox_seq > 0),
          provider_seq INTEGER,
          issued_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL CHECK (expires_at > issued_at),
          max_sends INTEGER NOT NULL DEFAULT 10 CHECK (max_sends BETWEEN 1 AND 10),
          next_send_index INTEGER NOT NULL DEFAULT 0 CHECK (next_send_index >= 0),
          reserved_send_count INTEGER NOT NULL DEFAULT 0
            CHECK (reserved_send_count >= 0),
          transmitted_send_count INTEGER NOT NULL DEFAULT 0
            CHECK (transmitted_send_count >= 0),
          state TEXT NOT NULL DEFAULT 'open'
            CHECK (state IN ('open', 'superseded', 'closed', 'cancelled')),
          secret_generation INTEGER NOT NULL CHECK (secret_generation >= 0),
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (account_key) REFERENCES ilink_accounts(account_key),
          FOREIGN KEY (source_message_key) REFERENCES inbound_messages(message_key),
          CHECK (reserved_send_count + transmitted_send_count <= max_sends)
        ) STRICT;
        CREATE UNIQUE INDEX ilink_one_open_window_idx
          ON ilink_reply_windows(account_key, peer_id) WHERE state = 'open';
        CREATE INDEX ilink_reply_windows_expiry_idx
          ON ilink_reply_windows(expires_at, state);
        CREATE INDEX ilink_reply_windows_updated_idx
          ON ilink_reply_windows(updated_at, state);

        CREATE TABLE ilink_reply_window_secrets (
          reply_window_id INTEGER PRIMARY KEY,
          nonce TEXT NOT NULL,
          ciphertext TEXT NOT NULL,
          auth_tag TEXT NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (reply_window_id)
            REFERENCES ilink_reply_windows(reply_window_id) ON DELETE CASCADE
        ) STRICT, WITHOUT ROWID;

        CREATE TABLE send_attempts (
          attempt_key TEXT PRIMARY KEY,
          source_message_key TEXT NOT NULL,
          open_kfid TEXT NOT NULL,
          external_userid TEXT NOT NULL,
          channel TEXT NOT NULL
            CHECK (channel IN ('wechat_kf', 'weixin_ilink')),
          reply_window_id INTEGER,
          send_index INTEGER NOT NULL CHECK (send_index >= 0 AND send_index < 1000),
          source TEXT NOT NULL,
          sent_type TEXT NOT NULL,
          payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
          metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
          fingerprint TEXT NOT NULL,
          client_message_id TEXT NOT NULL UNIQUE,
          status TEXT NOT NULL CHECK (status IN (${sqlList(SEND_STATUSES)})),
          wecom_msgid TEXT NOT NULL DEFAULT '',
          error_code TEXT NOT NULL DEFAULT '',
          error_message TEXT NOT NULL DEFAULT '',
          fail_type INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (source_message_key, send_index),
          FOREIGN KEY (
            source_message_key, channel, open_kfid, external_userid
          )
            REFERENCES inbound_messages(
              message_key, channel, open_kfid, external_userid
            ),
          FOREIGN KEY (reply_window_id)
            REFERENCES ilink_reply_windows(reply_window_id)
        ) STRICT;

        CREATE TABLE agent_sessions (
          token_hash TEXT PRIMARY KEY,
          source_message_key TEXT NOT NULL,
          open_kfid TEXT NOT NULL,
          external_userid TEXT NOT NULL,
          channel TEXT NOT NULL
            CHECK (channel IN ('wechat_kf', 'weixin_ilink')),
          reply_window_id INTEGER,
          boundary_inbox_seq INTEGER NOT NULL CHECK (boundary_inbox_seq >= 0),
          memory_thread_id TEXT NOT NULL DEFAULT '',
          media_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(media_json)),
          expires_at INTEGER NOT NULL,
          closed_at INTEGER NOT NULL DEFAULT 0,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          FOREIGN KEY (
            source_message_key, channel, open_kfid, external_userid
          )
            REFERENCES inbound_messages(
              message_key, channel, open_kfid, external_userid
            ) ON DELETE CASCADE
        ) STRICT;

        CREATE TABLE delivery_failures (
          wecom_msgid TEXT PRIMARY KEY,
          fail_type INTEGER NOT NULL,
          observed_at INTEGER NOT NULL,
          matched_attempt_key TEXT NOT NULL DEFAULT '',
          matched_at INTEGER NOT NULL DEFAULT 0
        ) STRICT;

        CREATE TABLE agent_artifacts (
          token_hash TEXT NOT NULL,
          ref TEXT NOT NULL,
          bytes BLOB NOT NULL,
          filename TEXT NOT NULL,
          content_type TEXT NOT NULL,
          metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
          created_at INTEGER NOT NULL,
          PRIMARY KEY (token_hash, ref),
          FOREIGN KEY (token_hash) REFERENCES agent_sessions(token_hash)
            ON DELETE CASCADE
        ) STRICT, WITHOUT ROWID;

        CREATE INDEX inbound_pending_idx
          ON inbound_messages(
            status, channel, open_kfid, external_userid, inbox_seq
          );
        CREATE INDEX inbound_primary_idx
          ON inbound_messages(primary_message_key, inbox_seq);
        CREATE INDEX inbound_deferred_idx
          ON inbound_messages(deferred, status, inbox_seq);
        CREATE UNIQUE INDEX conversation_thread_idx
          ON conversations(thread_id) WHERE thread_id <> '';
        CREATE INDEX send_status_idx
          ON send_attempts(channel, status, created_at, send_index);
        CREATE UNIQUE INDEX send_wecom_msgid_idx
          ON send_attempts(channel, wecom_msgid) WHERE wecom_msgid <> '';
        CREATE INDEX send_conversation_idx
          ON send_attempts(
            channel, open_kfid, external_userid, updated_at DESC
          );
        CREATE INDEX media_conversation_idx
          ON inbound_media(
            channel, open_kfid, external_userid, remembered_at DESC
          );
        CREATE INDEX agent_session_source_idx
          ON agent_sessions(source_message_key, closed_at, expires_at);

        CREATE TRIGGER ilink_session_window_insert_guard
        BEFORE INSERT ON agent_sessions WHEN (
          (NEW.channel = 'wechat_kf' AND NEW.reply_window_id IS NOT NULL) OR
          (NEW.channel = 'weixin_ilink' AND (NEW.reply_window_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM ilink_reply_windows AS window
            WHERE window.reply_window_id = NEW.reply_window_id
              AND window.account_key = NEW.open_kfid
              AND window.peer_id = NEW.external_userid
              AND window.source_inbox_seq = NEW.boundary_inbox_seq
              AND window.state = 'open'
          )))
        ) BEGIN SELECT RAISE(ABORT, 'agent session channel/window mismatch'); END;
        CREATE TRIGGER ilink_session_window_update_guard
        BEFORE UPDATE OF channel, reply_window_id, open_kfid,
          external_userid, boundary_inbox_seq ON agent_sessions WHEN (
          (NEW.channel = 'wechat_kf' AND NEW.reply_window_id IS NOT NULL) OR
          (NEW.channel = 'weixin_ilink' AND (NEW.reply_window_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM ilink_reply_windows AS window
            WHERE window.reply_window_id = NEW.reply_window_id
              AND window.account_key = NEW.open_kfid
              AND window.peer_id = NEW.external_userid
              AND window.source_inbox_seq = NEW.boundary_inbox_seq
              AND window.state = 'open'
          )))
        ) BEGIN SELECT RAISE(ABORT, 'agent session channel/window mismatch'); END;
        CREATE TRIGGER ilink_attempt_window_insert_guard
        BEFORE INSERT ON send_attempts WHEN (
          (NEW.channel = 'wechat_kf' AND NEW.reply_window_id IS NOT NULL) OR
          (NEW.channel = 'weixin_ilink' AND (NEW.reply_window_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM ilink_reply_windows AS window
            WHERE window.reply_window_id = NEW.reply_window_id
              AND window.account_key = NEW.open_kfid
              AND window.peer_id = NEW.external_userid
          )))
        ) BEGIN SELECT RAISE(ABORT, 'send attempt channel/window mismatch'); END;
        CREATE TRIGGER ilink_attempt_window_update_guard
        BEFORE UPDATE OF channel, reply_window_id, open_kfid,
          external_userid ON send_attempts WHEN (
          (NEW.channel = 'wechat_kf' AND NEW.reply_window_id IS NOT NULL) OR
          (NEW.channel = 'weixin_ilink' AND (NEW.reply_window_id IS NULL OR NOT EXISTS (
            SELECT 1 FROM ilink_reply_windows AS window
            WHERE window.reply_window_id = NEW.reply_window_id
              AND window.account_key = NEW.open_kfid
              AND window.peer_id = NEW.external_userid
          )))
        ) BEGIN SELECT RAISE(ABORT, 'send attempt channel/window mismatch'); END;
        CREATE TRIGGER ilink_window_source_insert_guard
        BEFORE INSERT ON ilink_reply_windows WHEN NOT EXISTS (
          SELECT 1 FROM inbound_messages AS inbound
          WHERE inbound.message_key = NEW.source_message_key
            AND inbound.open_kfid = NEW.account_key
            AND inbound.external_userid = NEW.peer_id
            AND inbound.channel = 'weixin_ilink'
        ) BEGIN SELECT RAISE(ABORT, 'reply window source mismatch'); END;
        CREATE TRIGGER ilink_window_source_update_guard
        BEFORE UPDATE OF source_message_key, account_key, peer_id
          ON ilink_reply_windows WHEN NOT EXISTS (
          SELECT 1 FROM inbound_messages AS inbound
          WHERE inbound.message_key = NEW.source_message_key
            AND inbound.open_kfid = NEW.account_key
            AND inbound.external_userid = NEW.peer_id
            AND inbound.channel = 'weixin_ilink'
        ) BEGIN SELECT RAISE(ABORT, 'reply window source mismatch'); END;
        CREATE TRIGGER ilink_window_delete_guard
        BEFORE DELETE ON ilink_reply_windows WHEN EXISTS (
          SELECT 1 FROM agent_sessions WHERE reply_window_id = OLD.reply_window_id
        ) BEGIN SELECT RAISE(ABORT, 'reply window still has agent sessions'); END;
      `);
      this.#database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.#database.exec('COMMIT');
    } catch (error) {
      this.#database.exec('ROLLBACK');
      throw error;
    }
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

  #ensureConversation(
    channel: ChatChannel,
    accountKey: string,
    peerId: string,
    now = this.#now(),
  ): void {
    if (!peerId) return;
    this.#database
      .prepare(`
        INSERT INTO conversations (
          channel, open_kfid, external_userid, updated_at
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(channel, open_kfid, external_userid) DO NOTHING
      `)
      .run(channel, accountKey, peerId, now);
  }

  #inboundRow(messageKey: string): InboundRow | undefined {
    return rowAs<InboundRow>(
      this.#database
        .prepare('SELECT * FROM inbound_messages WHERE message_key = ?')
        .get(messageKey),
    );
  }

  #attemptRow(attemptKey: string): AttemptRow | undefined {
    return rowAs<AttemptRow>(
      this.#database
        .prepare('SELECT * FROM send_attempts WHERE attempt_key = ?')
        .get(attemptKey),
    );
  }

  #agentSessionRow(token: string): AgentSessionRow | undefined {
    return rowAs<AgentSessionRow>(this.#database
      .prepare('SELECT * FROM agent_sessions WHERE token_hash = ?')
      .get(sha256(requiredText(token, 'agent session token'))));
  }

  #validatedAgentSession(token: string): AgentSessionRecord {
    const row = this.#agentSessionRow(token);
    if (!row) {
      throw new AgentSessionError('Unknown agent session');
    }
    const now = this.#now();
    if (row.closed_at !== 0) {
      throw new AgentSessionError('Agent session is closed', 'closed_agent_session');
    }
    if (row.expires_at <= now) {
      throw new AgentSessionError('Agent session has expired', 'expired_agent_session');
    }
    const inbound = this.#inboundRow(row.source_message_key);
    const laterCustomer = inbound
      ? this.#database.prepare(`
          SELECT 1 FROM inbound_messages
          WHERE channel = ? AND open_kfid = ? AND external_userid = ?
            AND inbox_seq > ?
            AND origin = 'customer'
            AND status <> 'ignored'
            AND NOT (channel = 'weixin_ilink' AND status = 'absorbed')
          LIMIT 1
        `).get(
          row.channel,
          row.open_kfid,
          row.external_userid,
          row.boundary_inbox_seq,
        )
      : undefined;
    const valid =
      inbound !== undefined &&
      inbound.open_kfid === row.open_kfid &&
      inbound.external_userid === row.external_userid &&
      inbound.channel === row.channel &&
      ['processing', 'preparing'].includes(inbound.status) &&
      laterCustomer === undefined;
    if (!valid) {
      throw new AgentSessionError(
        'Agent session no longer matches the active conversation direction',
        'stale_agent_session',
      );
    }
    const used = rowAs<{ count: number }>(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM send_attempts
      WHERE source_message_key = ?
    `).get(row.source_message_key));
    if (row.channel === 'wechat_kf' && Number(used?.count || 0) >= 5) {
      throw new AgentSessionError(
        'WeChat permits at most five sends for this conversation turn',
        'send_budget_exceeded',
      );
    }
    return mapAgentSession(row, token)!;
  }

  #insertAttempt({
    sourceMessageKey,
    accountKey,
    peerId,
    sendIndex,
    source = 'codex_tool',
    sentType,
    payload,
    metadata,
    channel,
    replyWindowId,
  }: InsertAttemptInput): { inserted: boolean; attempt: AttemptRecord } {
    const index = Number(sendIndex);
    const inbound = this.#inboundRow(sourceMessageKey);
    if (!inbound) throw new Error(`Unknown inbound message: ${sourceMessageKey}`);
    if (
      accountKey !== inbound.open_kfid ||
      peerId !== inbound.external_userid ||
      (channel !== undefined && channel !== inbound.channel)
    ) {
      throw new SendInvariantError('Send attempt identity does not match its source');
    }
    const actualChannel = inbound.channel;
    const maximum = actualChannel === 'wechat_kf' ? 5 : 1_000;
    if (!Number.isInteger(index) || index < 0 || index >= maximum) {
      throw new Error(`sendIndex must be an integer between 0 and ${maximum - 1}`);
    }
    const stableClientId = stableClientMessageId(sourceMessageKey, index);
    const exactPayload = payload ? canonicalValue(payload) : undefined;
    const payloadJson = encodeJson(exactPayload);
    const actualFingerprint = sha256(`${sentType}\0${payloadJson || ''}`);
    const actualAttemptKey = stableAttemptKey(sourceMessageKey, index);
    const now = this.#now();

    const result = this.#database
      .prepare(`
        INSERT INTO send_attempts (
          attempt_key, source_message_key, open_kfid, external_userid,
          channel, reply_window_id, send_index, source, sent_type,
          payload_json, metadata_json,
          fingerprint, client_message_id, status,
          wecom_msgid, error_code, error_message, fail_type,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_message_key, send_index) DO NOTHING
      `)
      .run(
        actualAttemptKey,
        sourceMessageKey,
        accountKey,
        peerId,
        actualChannel,
        replyWindowId || null,
        index,
        String(source),
        requiredText(sentType, 'sentType'),
        payloadJson,
        encodeJson(metadata),
        actualFingerprint,
        stableClientId,
        'pending',
        '',
        '',
        '',
        0,
        now,
        now,
      );

    const existing = rowAs<AttemptRow>(
      this.#database
        .prepare(`
          SELECT * FROM send_attempts
          WHERE source_message_key = ? AND send_index = ?
        `)
        .get(sourceMessageKey, index),
    );
    if (!existing) throw new Error('Unable to reserve send attempt');
    if (
      existing.fingerprint !== actualFingerprint ||
      existing.client_message_id !== stableClientId ||
      existing.sent_type !== sentType ||
      existing.open_kfid !== accountKey ||
      existing.external_userid !== peerId ||
      existing.channel !== actualChannel ||
      Number(existing.reply_window_id || 0) !== Number(replyWindowId || 0) ||
      existing.source !== String(source)
    ) {
      throw new SendInvariantError(
        `Send attempt invariant conflict for ${sourceMessageKey}:${index}`,
      );
    }
    const attempt = mapAttempt(existing);
    if (!attempt) throw new Error('Unable to map reserved send attempt');
    return { inserted: result.changes === 1, attempt };
  }

  #settleSourceMessage(sourceMessageKey: string, now = this.#now()): void {
    const activeRow = rowAs<{ count: number }>(this.#database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM send_attempts
        WHERE source_message_key = ? AND status IN ('pending', 'sending')
      `)
      .get(sourceMessageKey));
    const active = Number(activeRow?.count ?? 0);
    if (Number(active) > 0) return;
    const activeAgent = rowAs<{ count: number }>(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM agent_sessions
      WHERE source_message_key = ? AND closed_at = 0 AND expires_at > ?
    `).get(sourceMessageKey, now));
    if (Number(activeAgent?.count || 0) > 0) return;
    const source = this.#inboundRow(sourceMessageKey);
    const laterCustomer = source
      ? this.#database.prepare(`
          SELECT 1 FROM inbound_messages
          WHERE channel = ? AND open_kfid = ? AND external_userid = ?
            AND inbox_seq > ? AND origin = 'customer'
            AND status IN (
              'received', 'processing', 'preparing', 'ready',
              'steering', 'steered', 'failed'
            )
          LIMIT 1
        `).get(
          source.channel,
          source.open_kfid,
          source.external_userid,
          source.inbox_seq,
        )
      : undefined;
    if (laterCustomer) return;
    this.#database
      .prepare(`
        UPDATE inbound_messages
        SET status = CASE WHEN status = 'suppressed' THEN status ELSE 'completed' END,
            payload_json = NULL,
            updated_at = ?
        WHERE message_key = ? AND status IN ('ready', 'processing', 'preparing')
      `)
      .run(now, sourceMessageKey);
  }

  #applyDeliveryFailure(attempt: AttemptRow, failType: number, now: number): void {
    this.#database.prepare(`
      UPDATE send_attempts
      SET status = 'failed', fail_type = ?, error_code = 'msg_send_fail',
          error_message = ?, updated_at = ?
      WHERE attempt_key = ?
    `).run(
      failType,
      `WeChat reported delivery failure (fail_type=${failType})`,
      now,
      attempt.attempt_key,
    );
    this.#database.prepare(`
      UPDATE delivery_failures
      SET matched_attempt_key = ?, matched_at = ?
      WHERE wecom_msgid = ?
    `).run(attempt.attempt_key, now, attempt.wecom_msgid);
  }

  #suppressGroup(messageKey: string, reason: string, now: number): void {
    this.#database.prepare(`
      UPDATE inbound_messages
      SET status = 'suppressed', error_message = ?, updated_at = ?
      WHERE (message_key = ? OR primary_message_key = ?)
        AND status NOT IN ('completed', 'ignored', 'absorbed')
    `).run(reason, now, messageKey, messageKey);
    this.#database.prepare(`
      UPDATE send_attempts
      SET status = 'failed', error_code = 'suppressed',
          error_message = ?, updated_at = ?
      WHERE source_message_key = ? AND status = 'pending'
    `).run(reason, now, messageKey);
  }

  #finishSending(
    attemptId: string,
    status: 'accepted' | 'uncertain',
    fields: {
      providerMessageId?: string;
      errorCode?: string;
      errorMessage?: string;
    },
  ): AttemptRecord {
    const current = this.#attemptRow(attemptId);
    if (!current) throw new Error(`Unknown send attempt: ${attemptId}`);
    if (current.status === status) return mapAttempt(current)!;
    if (current.status !== 'sending') {
      throw new Error(`Cannot mark send ${status} in status ${current.status}`);
    }
    const now = this.#now();
    this.#database.prepare(`
      UPDATE send_attempts
      SET status = ?, wecom_msgid = ?, error_code = ?, error_message = ?,
          updated_at = ?
      WHERE attempt_key = ? AND status = 'sending'
    `).run(
      status, fields.providerMessageId || '', fields.errorCode || '',
      fields.errorMessage || '', now, attemptId,
    );
    this.#settleSourceMessage(current.source_message_key, now);
    return mapAttempt(this.#attemptRow(attemptId))!;
  }

  integrityCheck(): SqlRow[] {
    return rowsAs<SqlRow>(
      this.#database.prepare('PRAGMA integrity_check').all(),
    );
  }

  foreignKeyCheck(): SqlRow[] {
    return rowsAs<SqlRow>(
      this.#database.prepare('PRAGMA foreign_key_check').all(),
    );
  }

  checkpoint(
    mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'TRUNCATE',
  ): SqlRow | undefined {
    if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(mode)) {
      throw new Error(`Unsupported checkpoint mode: ${mode}`);
    }
    return rowAs<SqlRow>(
      this.#database.prepare(`PRAGMA wal_checkpoint(${mode})`).get(),
    );
  }

  getCursor(accountKey: string): string {
    const cursor = rowAs<{ cursor: unknown }>(
      this.#database
        .prepare('SELECT cursor FROM sync_cursors WHERE open_kfid = ?')
        .get(String(accountKey)),
    )?.cursor;
    return cursor === undefined ? '' : String(cursor);
  }

  listSyncAccountKeys(): string[] {
    return rowsAs<{ open_kfid: string }>(this.#database.prepare(`
      SELECT open_kfid FROM sync_cursors ORDER BY open_kfid
    `).all()).map((row) => row.open_kfid);
  }

  registerSyncAccountKey(accountKey: string): void {
    const service = requiredText(accountKey, 'accountKey');
    this.#database.prepare(`
      INSERT INTO sync_cursors (open_kfid, cursor, updated_at)
      VALUES (?, '', ?)
      ON CONFLICT(open_kfid) DO NOTHING
    `).run(service, this.#now());
  }

  /** @internal Shared inbox boundary for channel-specific persistence stores. */
  insertInboundMessages({
    accountKey,
    entries,
    now,
  }: {
    accountKey: string;
    entries: readonly InboxInsertEntry[];
    now?: number;
  }): InboxInsertResult[] {
    const service = requiredText(accountKey, 'accountKey');
    if (!Array.isArray(entries)) throw new Error('entries must be an array');
    const timestamp = now === undefined ? this.#now() : Number(now);
    if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
      throw new Error('now must be a non-negative safe integer');
    }
    const messages = entries.map(({ message, deferred = false }) => ({
      message: inboundInsert(service, message),
      deferred: Boolean(deferred),
    }));

    return this.#transaction(() => {
      const statement = this.#database.prepare(`
        INSERT INTO inbound_messages (
          message_key, open_kfid, msgid, external_userid, channel, origin, msg_type,
          sent_at, status, deferred, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(channel, open_kfid, msgid) DO NOTHING
      `);
      const findByProviderIdentity = this.#database.prepare(`
        SELECT message_key, inbox_seq, external_userid
        FROM inbound_messages
        WHERE channel = ? AND open_kfid = ? AND msgid = ?
      `);
      return messages.map(({ message, deferred }) => {
        const result = statement.run(
          message.messageKey,
          service,
          message.providerMessageId,
          message.peerId,
          message.channel,
          message.origin,
          message.type,
          message.sentAt,
          message.status,
          deferred ? 1 : 0,
          encodeJson(message.payload),
          timestamp,
          timestamp,
        );
        this.#ensureConversation(
          message.channel,
          service,
          message.peerId,
          timestamp,
        );
        const row = rowAs<{
          message_key: string;
          inbox_seq: number;
          external_userid: string;
        }>(findByProviderIdentity.get(
          message.channel,
          service,
          message.providerMessageId,
        ));
        if (!row || row.external_userid !== message.peerId) {
          throw new Error('Inbound message dedupe identity conflicts');
        }
        return {
          messageKey: row.message_key,
          inboxSeq: Number(row.inbox_seq),
          inserted: result.changes === 1,
        };
      });
    });
  }

  ingestSyncPage({
    accountKey,
    expectedCursor = '',
    nextCursor = '',
    messages,
    deferred = false,
  }: {
    accountKey: string;
    expectedCursor?: string;
    nextCursor?: string;
    messages: readonly NormalizedMessage[];
    deferred?: boolean;
  }): { insertedMessageKeys: string[]; cursor: string } {
    const service = requiredText(accountKey, 'accountKey');
    if (!Array.isArray(messages)) throw new Error('messages must be an array');

    return this.#transaction(() => {
      const actualCursor = this.getCursor(service);
      if (actualCursor !== String(expectedCursor || '')) {
        throw new CursorConflictError(service, expectedCursor || '', actualCursor);
      }
      const now = this.#now();
      const insertedMessageKeys = this.insertInboundMessages({
        accountKey: service,
        entries: messages.map((message) => ({ message, deferred })),
        now,
      }).filter(({ inserted }) => inserted)
        .map(({ messageKey }) => messageKey);

      this.#database
        .prepare(`
          INSERT INTO sync_cursors (open_kfid, cursor, updated_at)
          VALUES (?, ?, ?)
          ON CONFLICT(open_kfid) DO UPDATE SET
            cursor = excluded.cursor,
            updated_at = excluded.updated_at
        `)
        .run(service, String(nextCursor || ''), now);

      return { insertedMessageKeys, cursor: String(nextCursor || '') };
    });
  }

  promoteDeferredConversation({
    channel,
    accountKey,
    peerId,
  }: {
    channel: ChatChannel;
    accountKey: string;
    peerId: string;
  }): InboundRecord[] {
    return this.#transaction(() => {
      const service = requiredText(accountKey, 'accountKey');
      const customer = String(peerId || '');
      this.#database.prepare(`
        UPDATE inbound_messages SET deferred = 0, updated_at = ?
        WHERE channel = ? AND open_kfid = ? AND external_userid = ?
          AND deferred = 1 AND status = 'received'
      `).run(this.#now(), channel, service, customer);
      return rowsAs<InboundRow>(this.#database.prepare(`
        SELECT * FROM inbound_messages
        WHERE channel = ? AND open_kfid = ? AND external_userid = ?
          AND deferred = 0 AND status = 'received'
        ORDER BY inbox_seq
      `).all(channel, service, customer)).map((row) => mapInbound(row)!);
    });
  }

  activateNextDeferredConversation(
    channels: readonly ChatChannel[] = ['wechat_kf', 'weixin_ilink'],
  ): InboundRecord[] {
    const selected = [...new Set(channels)];
    if (!selected.length) return [];
    const channelPlaceholders = selected.map(() => '?').join(',');
    return this.#transaction(() => {
      const next = rowAs<{
        open_kfid: string;
        external_userid: string;
        channel: ChatChannel;
      }>(
        this.#database.prepare(`
          SELECT open_kfid, external_userid, channel FROM inbound_messages
          WHERE deferred = 1 AND status = 'received'
            AND channel IN (${channelPlaceholders})
          ORDER BY inbox_seq LIMIT 1
        `).get(...selected),
      );
      if (!next) return [];
      this.#database.prepare(`
        UPDATE inbound_messages SET deferred = 0, updated_at = ?
        WHERE open_kfid = ? AND external_userid = ?
          AND channel = ?
          AND deferred = 1 AND status = 'received'
      `).run(this.#now(), next.open_kfid, next.external_userid, next.channel);
      return rowsAs<InboundRow>(this.#database.prepare(`
        SELECT * FROM inbound_messages
        WHERE open_kfid = ? AND external_userid = ?
          AND channel = ?
          AND deferred = 0 AND status = 'received'
        ORDER BY inbox_seq
      `).all(next.open_kfid, next.external_userid, next.channel))
        .map((row) => mapInbound(row)!);
    });
  }

  getInbound(messageKey: string): InboundRecord | undefined {
    return mapInbound(this.#inboundRow(messageKey));
  }

  createAgentSession({
    messageKey,
    boundaryMessageKey = messageKey,
    ttlMs = 15 * 60 * 1000,
  }: {
    messageKey: string;
    boundaryMessageKey?: string;
    ttlMs?: number;
  }): AgentSessionRecord {
    return this.#transaction(() => {
      const inbound = this.#inboundRow(requiredText(messageKey, 'messageKey'));
      if (!inbound || !['processing', 'preparing'].includes(inbound.status)) {
        throw new AgentSessionError('Agent session requires an active inbound message');
      }
      const boundary = this.#inboundRow(boundaryMessageKey);
      if (
        !boundary ||
        boundary.open_kfid !== inbound.open_kfid ||
        boundary.external_userid !== inbound.external_userid ||
        boundary.channel !== inbound.channel
      ) {
        throw new AgentSessionError('Agent session boundary is outside the conversation');
      }
      const boundedTtl = Math.max(1_000, Math.min(Number(ttlMs) || 0, 60 * 60 * 1000));
      const memoryThreadId = this.getConversation(
        inbound.channel,
        inbound.open_kfid,
        inbound.external_userid,
      )?.memoryThreadId || '';
      const now = this.#now();
      const replyWindowId = inbound.channel === 'weixin_ilink'
        ? Number(rowAs<{ reply_window_id: number }>(this.#database.prepare(`
            SELECT reply_window_id FROM ilink_reply_windows
            WHERE source_message_key = ?
          `).get(boundary.message_key))?.reply_window_id || 0)
        : 0;
      if (inbound.channel === 'weixin_ilink' && !replyWindowId) {
        throw new AgentSessionError('iLink message has no reply window');
      }
      const token = `ws_${randomBytes(24).toString('base64url')}`;
      this.#database.prepare(`
        UPDATE agent_sessions SET closed_at = ?, updated_at = ?
        WHERE channel = ? AND open_kfid = ? AND external_userid = ?
          AND closed_at = 0 AND expires_at > ?
      `).run(
        now,
        now,
        inbound.channel,
        inbound.open_kfid,
        inbound.external_userid,
        now,
      );
      this.#database.prepare(`
        INSERT INTO agent_sessions (
          token_hash, source_message_key, open_kfid, external_userid,
          channel, reply_window_id,
          boundary_inbox_seq, memory_thread_id,
          media_json, expires_at,
          closed_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
      `).run(
        sha256(token),
        inbound.message_key,
        inbound.open_kfid,
        inbound.external_userid,
        inbound.channel,
        replyWindowId || null,
        boundary.inbox_seq,
        memoryThreadId,
        encodeJson(this.listRecentMedia({
          channel: inbound.channel,
          accountKey: inbound.open_kfid,
          peerId: inbound.external_userid,
          limit: 10,
        })) || '[]',
        now + boundedTtl,
        now,
        now,
      );
      return mapAgentSession(this.#agentSessionRow(token), token)!;
    });
  }

  getAgentSession(token: string): AgentSessionRecord {
    return this.#validatedAgentSession(token);
  }

  closeAgentSession(token: string): boolean {
    const now = this.#now();
    return Number(this.#database.prepare(`
      UPDATE agent_sessions SET closed_at = ?, updated_at = ?
      WHERE token_hash = ? AND closed_at = 0
    `).run(now, now, sha256(requiredText(token, 'agent session token'))).changes) === 1;
  }

  closeAgentSessions(messageKey: string): number {
    const now = this.#now();
    return Number(this.#database.prepare(`
      UPDATE agent_sessions SET closed_at = ?, updated_at = ?
      WHERE source_message_key = ? AND closed_at = 0
    `).run(now, now, String(messageKey)).changes);
  }

  registerAgentArtifact({
    sessionToken,
    bytes,
    filename,
    contentType,
    metadata,
  }: {
    sessionToken: string;
    bytes: Buffer;
    filename: string;
    contentType: 'image/png' | 'image/jpeg';
    metadata?: Readonly<Record<string, unknown>>;
  }): string {
    const session = this.#validatedAgentSession(sessionToken);
    if (!Buffer.isBuffer(bytes) || bytes.length < 6 || bytes.length > MAX_WECHAT_IMAGE_BYTES) {
      throw new AgentSessionError('Agent image artifact must contain 6 bytes to 2 MiB');
    }
    const format = detectImageFormat(bytes);
    if (!format || format.mimeType !== contentType || !['image/png', 'image/jpeg'].includes(contentType)) {
      throw new AgentSessionError('Agent image artifact must be matching PNG or JPEG bytes');
    }
    const safeFilename = String(filename || 'generated-image')
      .replace(/[\r\n"\\/]/gu, '_');
    if (Buffer.byteLength(safeFilename, 'utf8') > 128) {
      throw new AgentSessionError('Agent image artifact filename exceeds 128 UTF-8 bytes');
    }
    const tokenHash = sha256(session.token);
    const count = rowAs<{ count: number }>(this.#database.prepare(`
      SELECT COUNT(*) AS count FROM agent_artifacts WHERE token_hash = ?
    `).get(tokenHash));
    if (Number(count?.count || 0) >= 5) {
      throw new AgentSessionError('Agent session permits at most five artifacts');
    }
    const ref = `artifact:${Number(count?.count || 0)}`;
    this.#database.prepare(`
      INSERT INTO agent_artifacts (
        token_hash, ref, bytes, filename, content_type, metadata_json, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      tokenHash,
      ref,
      bytes,
      safeFilename,
      contentType,
      encodeJson(metadata),
      this.#now(),
    );
    return ref;
  }

  getAgentArtifact(sessionToken: string, ref: string): {
    bytes: Buffer;
    filename: string;
    contentType: 'image/png' | 'image/jpeg';
    metadata?: JsonObject;
  } {
    const session = this.#validatedAgentSession(sessionToken);
    const row = rowAs<{
      bytes: Uint8Array;
      filename: string;
      content_type: 'image/png' | 'image/jpeg';
      metadata_json: string | null;
    }>(this.#database.prepare(`
      SELECT bytes, filename, content_type, metadata_json FROM agent_artifacts
      WHERE token_hash = ? AND ref = ?
    `).get(sha256(session.token), String(ref)));
    if (!row) {
      throw new AgentSessionError('The generated artifact is unavailable', 'invalid_media_reference');
    }
    const metadata = objectJson(row.metadata_json);
    return {
      bytes: Buffer.from(row.bytes),
      filename: row.filename,
      contentType: row.content_type,
      ...(metadata ? { metadata } : {}),
    };
  }

  reserveAgentSend({
    sessionToken,
    sentType,
    payload,
    metadata,
  }: {
    sessionToken: string;
    sentType: string;
    payload: Readonly<Record<string, unknown>>;
    metadata?: Readonly<Record<string, unknown>>;
  }): AttemptRecord {
    return this.#transaction(() => {
      const session = this.#validatedAgentSession(sessionToken);
      if (session.channel !== 'wechat_kf') {
        throw new AgentSessionError(
          'Agent session is bound to another channel',
          'wrong_channel',
        );
      }
      const indexRow = rowAs<{ next_index: number }>(this.#database.prepare(`
        SELECT COALESCE(MAX(send_index) + 1, 0) AS next_index
        FROM send_attempts WHERE source_message_key = ?
      `).get(session.messageKey));
      const sendIndex = Number(indexRow?.next_index ?? 0);
      if (!Number.isInteger(sendIndex) || sendIndex < 0 || sendIndex >= 5) {
        throw new AgentSessionError(
          'WeChat permits at most five sends for this conversation turn',
          'send_budget_exceeded',
        );
      }
      const directionRow = rowAs<{ direction: number }>(this.#database.prepare(`
        SELECT MAX(inbox_seq) AS direction FROM inbound_messages
        WHERE message_key = ? OR (
          primary_message_key = ? AND status IN ('steering', 'steered')
        )
      `).get(session.messageKey, session.messageKey));
      const reserved = this.#insertAttempt({
        sourceMessageKey: session.messageKey,
        accountKey: session.accountKey,
        peerId: session.peerId,
        sendIndex,
        source: 'mcp_tool',
        sentType,
        payload,
        metadata: {
          ...(metadata || {}),
          direction: Number(directionRow?.direction || session.boundaryInboxSeq),
        },
      }).attempt;
      const claimed = this.#database.prepare(`
        UPDATE send_attempts SET status = 'sending', updated_at = ?
        WHERE attempt_key = ? AND status = 'pending'
      `).run(this.#now(), reserved.attemptId);
      if (claimed.changes !== 1) {
        throw new SendInvariantError(`Cannot claim MCP send ${reserved.attemptId}`);
      }
      return mapAttempt(this.#attemptRow(reserved.attemptId))!;
    });
  }

  getAttempt(attemptId: string): AttemptRecord | undefined {
    return mapAttempt(this.#attemptRow(String(attemptId || '')));
  }

  reserveQueueNotice(
    messageKey: string,
    content = 'Your conversation is queued. Please wait.',
  ): AttemptRecord {
    return this.#transaction(() => {
      const inbound = this.#inboundRow(requiredText(messageKey, 'messageKey'));
      if (!inbound || inbound.status !== 'received' || inbound.deferred === 1) {
        throw new Error('Queue notice requires a live received message');
      }
      const existing = rowAs<AttemptRow>(this.#database.prepare(`
        SELECT * FROM send_attempts
        WHERE source_message_key = ? AND source = 'queue_notice'
        LIMIT 1
      `).get(messageKey));
      if (existing) return mapAttempt(existing)!;
      const next = rowAs<{ send_index: number }>(this.#database.prepare(`
        SELECT COALESCE(MAX(send_index) + 1, 0) AS send_index
        FROM send_attempts WHERE source_message_key = ?
      `).get(messageKey));
      return this.#insertAttempt({
        sourceMessageKey: messageKey,
        accountKey: inbound.open_kfid,
        peerId: inbound.external_userid,
        sendIndex: Number(next?.send_index || 0),
        source: 'queue_notice',
        sentType: 'text',
        payload: { msgtype: 'text', text: { content: String(content) } },
      }).attempt;
    });
  }

  listMessageAttempts(messageKey: string): AttemptRecord[] {
    return rowsAs<AttemptRow>(this.#database.prepare(`
      SELECT * FROM send_attempts
      WHERE source_message_key = ? ORDER BY send_index
    `).all(String(messageKey || ''))).map((row) => mapAttempt(row)!);
  }

  finalizeAgentExecution({
    messageKey,
    steeringMessageKeys = [],
    attemptIds,
  }: {
    messageKey: string;
    steeringMessageKeys?: readonly string[];
    attemptIds: readonly string[];
  }): InboundRecord {
    if (!attemptIds.length || attemptIds.length > 1_000) {
      throw new Error('Agent execution must reference 1 to 1000 MCP attempts');
    }
    return this.#transaction(() => {
      const primary = this.#inboundRow(messageKey);
      if (!primary) throw new Error(`Unknown inbound message: ${messageKey}`);
      const uniqueAttempts = [...new Set(attemptIds.map(String))];
      if (uniqueAttempts.length !== attemptIds.length) {
        throw new Error('Agent execution contains duplicate MCP attempts');
      }
      const durable = rowsAs<{
        attempt_key: string;
        status: SendStatus;
        channel: ChatChannel;
        reply_window_id: number | null;
        error_code: string;
      }>(
        this.#database.prepare(`
          SELECT attempt_key, status, channel, reply_window_id, error_code
          FROM send_attempts
          WHERE source_message_key = ? AND source = 'mcp_tool'
        `).all(messageKey),
      );
      const reported = new Set(uniqueAttempts);
      const counts = new Map<string, number>();
      for (const attempt of durable) {
        if ([
          'abandoned_before_transmit',
          'cancelled_before_transmit',
          'reply_window_expired',
          'reply_quota_exhausted',
        ].includes(attempt.error_code)) {
          continue;
        }
        const key = attempt.channel === 'weixin_ilink'
          ? `ilink:${Number(attempt.reply_window_id || 0)}`
          : 'wechat_kf';
        if (
          (attempt.channel === 'weixin_ilink' && !attempt.reply_window_id) ||
          (attempt.channel === 'wechat_kf' && attempt.reply_window_id)
        ) {
          throw new Error('Agent execution contains a channel/window mismatch');
        }
        counts.set(key, (counts.get(key) || 0) + 1);
      }
      if ([...counts].some(([key, count]) =>
        count > (key === 'wechat_kf' ? 5 : 10)
      )) {
        throw new Error('Agent execution exceeds a channel reply-window budget');
      }
      if (
        durable.length !== uniqueAttempts.length ||
        durable.some((attempt) =>
          !reported.has(attempt.attempt_key) ||
          !['accepted', 'failed', 'uncertain'].includes(attempt.status),
        )
      ) {
        throw new Error('Agent execution does not match every terminal MCP attempt');
      }
      const now = this.#now();
      const updated = this.#database.prepare(`
        UPDATE inbound_messages
        SET status = 'completed', payload_json = NULL, updated_at = ?
        WHERE message_key = ? AND status IN (
          'processing', 'preparing', 'ready', 'completed'
        )
      `).run(now, messageKey);
      if (updated.changes !== 1) {
        throw new Error(`Cannot finalize agent execution in status ${primary.status}`);
      }
      const steeringKeys = [...new Set(steeringMessageKeys.map(String))];
      if (steeringKeys.length) {
        const steeringPlaceholders = steeringKeys.map(() => '?').join(',');
        const absorbed = this.#database.prepare(`
          UPDATE inbound_messages
          SET status = 'absorbed', payload_json = NULL, updated_at = ?
          WHERE message_key IN (${steeringPlaceholders})
            AND status = 'steered' AND primary_message_key = ?
        `).run(now, ...steeringKeys, messageKey);
        if (absorbed.changes !== steeringKeys.length) {
          throw new Error('Not every steering message belongs to the MCP execution');
        }
      }
      this.#database.prepare(`
        UPDATE agent_sessions SET closed_at = ?, updated_at = ?
        WHERE source_message_key = ? AND closed_at = 0
      `).run(now, now, messageKey);
      this.#database.prepare(`
        UPDATE conversations SET memory_thread_id = '', updated_at = ?
        WHERE channel = ? AND open_kfid = ? AND external_userid = ?
      `).run(
        now,
        primary.channel,
        primary.open_kfid,
        primary.external_userid,
      );
      return this.getInbound(messageKey)!;
    });
  }

  listPendingInbound({
    statuses = [
      'received',
      'processing',
      'preparing',
      'steering',
      'steered',
      'ready',
    ],
    channel,
    accountKey,
    peerId,
    limit = 100,
  }: {
    statuses?: readonly InboundStatus[];
    channel?: ChatChannel;
    accountKey?: string;
    peerId?: string;
    limit?: number;
  } = {}): InboundRecord[] {
    const selected = [...new Set(statuses)];
    if (!selected.length) return [];
    const hasIdentity = channel !== undefined || accountKey !== undefined ||
      peerId !== undefined;
    if (
      hasIdentity &&
      (channel === undefined || !accountKey || !peerId)
    ) {
      throw new Error(
        'channel, accountKey, and peerId must be provided together',
      );
    }
    const clauses = [`status IN (${selected.map(() => '?').join(',')})`];
    const parameters: SqlInputValue[] = [...selected];
    if (channel) {
      clauses.push('channel = ?');
      parameters.push(channel);
    }
    if (accountKey) {
      clauses.push('open_kfid = ?');
      parameters.push(String(accountKey));
    }
    if (peerId) {
      clauses.push('external_userid = ?');
      parameters.push(String(peerId));
    }
    parameters.push(Math.max(1, Math.min(Number(limit) || 100, 1000)));
    return rowsAs<InboundRow>(this.#database
      .prepare(`
        SELECT * FROM inbound_messages
        WHERE ${clauses.join(' AND ')}
        ORDER BY inbox_seq
        LIMIT ?
      `)
      .all(...parameters))
      .map((row) => mapInbound(row)!);
  }

  getConversation(
    channel: ChatChannel,
    accountKey: string,
    peerId: string,
  ): ConversationRecord | undefined {
    return mapConversation(
      rowAs<ConversationRow>(
        this.#database
          .prepare(`
            SELECT * FROM conversations
            WHERE channel = ? AND open_kfid = ? AND external_userid = ?
          `)
          .get(channel, String(accountKey), String(peerId)),
      ),
    );
  }

  setConversationThread({
    channel,
    accountKey,
    peerId,
    threadId,
    memoryThreadId = '',
  }: {
    channel: ChatChannel;
    accountKey: string;
    peerId: string;
    threadId: string;
    memoryThreadId?: string;
  }): ConversationRecord {
    return this.#transaction(() => {
      const now = this.#now();
      this.#database
        .prepare(`
          INSERT INTO conversations (
            channel, open_kfid, external_userid,
            thread_id, memory_thread_id, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(channel, open_kfid, external_userid) DO UPDATE SET
            thread_id = excluded.thread_id,
            memory_thread_id = excluded.memory_thread_id,
            updated_at = excluded.updated_at
        `)
        .run(
          channel,
          accountKey,
          peerId,
          String(threadId || ''),
          String(memoryThreadId || ''),
          now,
        );
      return this.getConversation(channel, accountKey, peerId)!;
    });
  }

  getAuthorization(peerId: string): AuthorizationRecord | undefined {
    const row = rowAs<{
      external_userid: string;
      authorized: number;
      consecutive_matches: number;
      last_open_kfid: string;
      last_message_key: string;
      authorized_at: number;
      updated_at: number;
    }>(
      this.#database
        .prepare('SELECT * FROM authorizations WHERE external_userid = ?')
        .get(String(peerId)),
    );
    if (!row) return undefined;
    return {
      peerId: row.external_userid,
      authorized: row.authorized === 1,
      consecutiveMatches: row.consecutive_matches,
      lastAccountKey: row.last_open_kfid,
      lastMessageKey: row.last_message_key,
      authorizedAt: row.authorized_at,
      updatedAt: row.updated_at,
    };
  }

  evaluateAuthorization({
    messageKey,
    accountKey,
    peerId,
    isTrigger,
    requiredConsecutive = 3,
    confirmationText = 'Code accepted. You can continue the conversation.',
  }: {
    messageKey: string;
    accountKey: string;
    peerId: string;
    isTrigger: boolean;
    requiredConsecutive?: number;
    confirmationText?: string;
  }): AuthorizationEvaluation {
    return this.#transaction(() => {
      const message = this.#inboundRow(messageKey);
      if (!message) throw new Error(`Unknown inbound message: ${messageKey}`);
      if (
        message.channel !== 'wechat_kf' ||
        message.open_kfid !== accountKey ||
        message.external_userid !== peerId
      ) {
        throw new Error('Authorization target does not match inbound message');
      }
      const current = this.getAuthorization(peerId);
      if (current?.authorized && current.lastMessageKey === messageKey) {
        return {
          decision: 'duplicate',
          consecutiveMatches: current.consecutiveMatches,
        };
      }
      if (current?.authorized) {
        return {
          decision: 'already_authorized',
          consecutiveMatches: current.consecutiveMatches,
        };
      }
      if (current?.lastMessageKey === messageKey) {
        return {
          decision: 'duplicate',
          consecutiveMatches: current.consecutiveMatches,
        };
      }

      const threshold = Math.max(1, Number(requiredConsecutive) || 3);
      const consecutiveMatches = isTrigger
        ? (current?.lastAccountKey === accountKey
            ? current.consecutiveMatches
            : 0) + 1
        : 0;
      const newlyAuthorized = consecutiveMatches >= threshold;
      const now = this.#now();
      this.#database
        .prepare(`
          INSERT INTO authorizations (
            external_userid, authorized, consecutive_matches,
            last_open_kfid, last_message_key, authorized_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(external_userid) DO UPDATE SET
            authorized = excluded.authorized,
            consecutive_matches = excluded.consecutive_matches,
            last_open_kfid = excluded.last_open_kfid,
            last_message_key = excluded.last_message_key,
            authorized_at = excluded.authorized_at,
            updated_at = excluded.updated_at
        `)
        .run(
          peerId,
          newlyAuthorized ? 1 : 0,
          consecutiveMatches,
          accountKey,
          messageKey,
          newlyAuthorized ? now : 0,
          now,
        );

      if (newlyAuthorized) {
        this.#insertAttempt({
          sourceMessageKey: messageKey,
          accountKey,
          peerId,
          sendIndex: 0,
          source: 'authorization',
          sentType: 'text',
          payload: {
            msgtype: 'text',
            text: { content: String(confirmationText) },
          },
        });
        this.#database
          .prepare(`
            UPDATE inbound_messages
            SET status = 'ready',
                updated_at = ?
            WHERE message_key = ?
          `)
          .run(
            now,
            messageKey,
          );
      } else {
        this.#database
          .prepare(`
            UPDATE inbound_messages
            SET status = 'ignored', payload_json = NULL, updated_at = ?
            WHERE message_key = ?
          `)
          .run(now, messageKey);
      }

      return {
        decision: newlyAuthorized ? 'authorized_now' : 'blocked',
        consecutiveMatches,
      };
    });
  }

  claimInbound({
    messageKey,
    clientInputId = messageKey,
  }: {
    messageKey: string;
    clientInputId?: string;
  }): InboundRecord {
    return this.#transaction(() => {
      const row = this.#inboundRow(messageKey);
      if (!row) throw new Error(`Unknown inbound message: ${messageKey}`);
      if (['processing', 'preparing'].includes(row.status)) {
        if (clientInputId && row.client_input_id !== String(clientInputId)) {
          this.#database
            .prepare(`
              UPDATE inbound_messages
              SET client_input_id = ?, updated_at = ?
              WHERE message_key = ?
            `)
            .run(String(clientInputId), this.#now(), messageKey);
        }
        return this.getInbound(messageKey)!;
      }
      if (row.status !== 'received' && row.status !== 'failed') {
        throw new Error(`Cannot claim inbound message in status ${row.status}`);
      }
      const now = this.#now();
      this.#database
        .prepare(`
          UPDATE inbound_messages
          SET status = 'processing',
              client_input_id = ?,
              error_message = '',
              updated_at = ?
          WHERE message_key = ?
        `)
        .run(
          String(clientInputId || messageKey),
          now,
          messageKey,
        );
      return this.getInbound(messageKey)!;
    });
  }

  markInboundPreparing(
    messageKey: string,
    codexTurnId = '',
  ): InboundRecord {
    const result = this.#database
      .prepare(`
        UPDATE inbound_messages
        SET status = 'preparing', codex_turn_id = ?, updated_at = ?
        WHERE message_key = ? AND status IN ('processing', 'preparing')
      `)
      .run(String(codexTurnId || ''), this.#now(), messageKey);
    if (result.changes !== 1) {
      throw new Error(`Cannot mark inbound preparing: ${messageKey}`);
    }
    return this.getInbound(messageKey)!;
  }

  beginInboundSteering({
    messageKey,
    primaryMessageKey,
    clientInputId = messageKey,
  }: {
    messageKey: string;
    primaryMessageKey: string;
    clientInputId?: string;
  }): InboundRecord {
    return this.#transaction(() => {
      const message = this.#inboundRow(messageKey);
      const primary = this.#inboundRow(primaryMessageKey);
      if (!message || !primary) throw new Error('Unknown steer message group');
      if (!['processing', 'preparing'].includes(primary.status)) {
        throw new Error(`Primary message is not steerable in status ${primary.status}`);
      }
      if (
        message.channel !== primary.channel ||
        message.open_kfid !== primary.open_kfid ||
        message.external_userid !== primary.external_userid
      ) {
        throw new Error('Steer message must belong to the primary conversation');
      }
      const updated = this.#database
        .prepare(`
          UPDATE inbound_messages
          SET status = 'steering',
              primary_message_key = ?,
              codex_turn_id = ?,
              client_input_id = ?,
              steering_boundary = 0,
              updated_at = ?
          WHERE message_key = ? AND status = 'received'
        `)
        .run(
          primaryMessageKey,
          String(primary.codex_turn_id || ''),
          String(clientInputId || messageKey),
          this.#now(),
          messageKey,
        );
      if (updated.changes !== 1) {
        throw new Error(`Cannot begin inbound steering: ${messageKey}`);
      }
      return this.getInbound(messageKey)!;
    });
  }

  confirmInboundSteered(
    messageKey: string,
    {
      codexTurnId = '',
      steeringBoundary = 0,
    }: { codexTurnId?: string; steeringBoundary?: number } = {},
  ): InboundRecord {
    const updated = this.#database
      .prepare(`
        UPDATE inbound_messages
        SET status = 'steered', codex_turn_id = ?, steering_boundary = ?,
            updated_at = ?
        WHERE message_key = ? AND status = 'steering'
      `)
      .run(
        String(codexTurnId || ''),
        Number(steeringBoundary || 0),
        this.#now(),
        String(messageKey),
      );
    if (updated.changes !== 1) {
      throw new Error(`Cannot confirm inbound steered: ${messageKey}`);
    }
    return this.getInbound(messageKey)!;
  }

  requeueInboundSteering(
    messageKey: string,
    primaryMessageKey: string,
  ): InboundRecord {
    return this.#transaction(() => {
      const updated = this.#database
        .prepare(`
          UPDATE inbound_messages
          SET status = 'received',
              primary_message_key = NULL,
              codex_turn_id = '',
              client_input_id = '',
              steering_boundary = 0,
              error_message = '',
              updated_at = ?
          WHERE message_key = ? AND status = 'steering'
            AND primary_message_key = ?
        `)
        .run(this.#now(), String(messageKey), String(primaryMessageKey));
      if (updated.changes !== 1) {
        throw new Error(
          `Cannot requeue steering ${messageKey} for primary ${primaryMessageKey}`,
        );
      }
      return this.getInbound(messageKey)!;
    });
  }

  failInbound(messageKey: string, error: unknown): InboundRecord | undefined {
    return this.#transaction(() => {
      const now = this.#now();
      const message = errorMessage(error) || 'unknown error';
      const primary = this.#database
        .prepare(`
          UPDATE inbound_messages
          SET status = 'failed', error_message = ?, updated_at = ?
          WHERE message_key = ? AND status IN ('processing', 'preparing')
        `)
        .run(message, now, messageKey);
      if (primary.changes === 1) {
        this.#database
          .prepare(`
            UPDATE inbound_messages
            SET status = 'received', primary_message_key = NULL,
                codex_turn_id = '', client_input_id = '', steering_boundary = 0,
                error_message = ?, updated_at = ?
            WHERE primary_message_key = ? AND status IN ('steering', 'steered')
              AND codex_turn_id = ''
          `)
          .run(message, now, messageKey);
      }
      return this.getInbound(messageKey);
    });
  }

  deferActiveInbound(messageKey: string): boolean {
    return this.#transaction(() => {
      const attempts = rowAs<{ count: number }>(this.#database.prepare(`
        SELECT COUNT(*) AS count FROM send_attempts
        WHERE source_message_key = ?
      `).get(messageKey));
      if (Number(attempts?.count || 0) > 0) return false;
      const now = this.#now();
      const updated = this.#database.prepare(`
        UPDATE inbound_messages
        SET status = 'received', deferred = 1,
            primary_message_key = NULL, codex_turn_id = '',
            client_input_id = '', steering_boundary = 0,
            error_message = '', updated_at = ?
        WHERE (message_key = ? OR primary_message_key = ?)
          AND status IN (
            'failed', 'processing', 'preparing', 'steering', 'steered'
          )
      `).run(now, messageKey, messageKey);
      this.#database.prepare(`
        UPDATE agent_sessions SET closed_at = ?, updated_at = ?
        WHERE source_message_key = ? AND closed_at = 0
      `).run(now, now, messageKey);
      return updated.changes > 0;
    });
  }

  markInboundIgnored(messageKey: string): InboundRecord {
    const updated = this.#database
      .prepare(`
        UPDATE inbound_messages
        SET status = 'ignored', payload_json = NULL, updated_at = ?
        WHERE message_key = ? AND status = 'received'
      `)
      .run(this.#now(), messageKey);
    if (updated.changes !== 1) {
      throw new Error(`Cannot ignore inbound message: ${messageKey}`);
    }
    return this.getInbound(messageKey)!;
  }

  markInboundCompleted(messageKey: string): InboundRecord {
    const updated = this.#database
      .prepare(`
        UPDATE inbound_messages
        SET status = 'completed', payload_json = NULL, updated_at = ?
        WHERE message_key = ? AND status IN ('received', 'processing', 'preparing')
      `)
      .run(this.#now(), messageKey);
    if (updated.changes !== 1) {
      throw new Error(`Cannot complete inbound message: ${messageKey}`);
    }
    return this.getInbound(messageKey)!;
  }

  suppressInbound(
    messageKey: string,
    reason = 'automation_suppressed',
  ): InboundRecord | undefined {
    return this.#transaction(() => {
      const now = this.#now();
      this.#suppressGroup(messageKey, reason, now);
      return this.getInbound(messageKey);
    });
  }

  listRecentConversationAttempts({
    channel,
    accountKey,
    peerId,
    limit = 20,
  }: {
    channel: ChatChannel;
    accountKey: string;
    peerId: string;
    limit?: number;
  }): AttemptRecord[] {
    return rowsAs<AttemptRow>(this.#database
      .prepare(`
        SELECT * FROM send_attempts
        WHERE channel = ? AND open_kfid = ? AND external_userid = ?
          AND status IN ('accepted', 'failed', 'uncertain')
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(
        channel,
        requiredText(accountKey, 'accountKey'),
        requiredText(peerId, 'peerId'),
        Math.max(1, Math.min(Number(limit) || 20, 100)),
      ))
      .map((row) => mapAttempt(row)!);
  }

  beginNextSend(channel: ChatChannel): AttemptRecord | undefined {
    return this.#transaction(() => {
      const candidate = rowAs<AttemptRow>(this.#database.prepare(`
        SELECT * FROM send_attempts
        WHERE channel = ? AND status = 'pending' AND NOT EXISTS (
          SELECT 1 FROM send_attempts AS active
          WHERE active.status = 'sending'
            AND active.channel = send_attempts.channel
            AND active.open_kfid = send_attempts.open_kfid
            AND active.external_userid = send_attempts.external_userid
        )
        ORDER BY created_at, send_index
        LIMIT 1
      `).get(channel));
      if (!candidate) return undefined;
      const claimed = this.#database.prepare(`
        UPDATE send_attempts SET status = 'sending', updated_at = ?
        WHERE attempt_key = ? AND status = 'pending'
      `).run(this.#now(), candidate.attempt_key);
      if (claimed.changes !== 1) throw new SendInvariantError('Send claim lost');
      return mapAttempt(this.#attemptRow(candidate.attempt_key))!;
    });
  }

  completeSend(
    attemptId: string,
    { providerMessageId }: { providerMessageId: string },
  ): AttemptRecord {
    const acceptedMessageId = requiredText(
      providerMessageId,
      'providerMessageId',
    );
    return this.#transaction(() => {
      const accepted = this.#finishSending(attemptId, 'accepted', {
        providerMessageId: acceptedMessageId,
      });
      if (accepted.channel !== 'wechat_kf') return accepted;
      const failure = rowAs<{ fail_type: number }>(this.#database.prepare(`
        SELECT fail_type FROM delivery_failures WHERE wecom_msgid = ?
      `).get(acceptedMessageId));
      if (!failure) return accepted;
      const current = this.#attemptRow(attemptId)!;
      this.#applyDeliveryFailure(current, Number(failure.fail_type || 0), this.#now());
      return mapAttempt(this.#attemptRow(attemptId))!;
    });
  }

  failSend(attemptId: string, error: unknown): AttemptRecord {
    const attemptKey = String(attemptId);
    return this.#transaction(() => {
      const current = this.#attemptRow(attemptKey);
      if (!current) throw new Error(`Unknown send attempt: ${attemptKey}`);
      if (current.status !== 'sending') {
        if (current.status === 'failed') return mapAttempt(current)!;
        throw new Error(`Cannot fail send attempt in status ${current.status}`);
      }
      const now = this.#now();
      this.#database
        .prepare(`
          UPDATE send_attempts
          SET status = 'failed', error_code = ?, error_message = ?, updated_at = ?
          WHERE attempt_key = ?
        `)
        .run(
          errorCode(error),
          errorMessage(error) || 'send failed',
          now,
          attemptKey,
        );
      this.#settleSourceMessage(current.source_message_key, now);
      return mapAttempt(this.#attemptRow(attemptKey))!;
    });
  }

  markSendUncertain(attemptId: string, error: unknown): AttemptRecord {
    return this.#transaction(() => this.#finishSending(attemptId, 'uncertain', {
      errorCode: errorCode(error),
      errorMessage: errorMessage(error) || 'send outcome uncertain',
    }));
  }

  markSendMsgFailed({
    providerMessageId,
    failType,
  }: {
    providerMessageId: string;
    failType: number;
  }): boolean {
    if (!String(providerMessageId || '')) return false;
    return this.#transaction(() => {
      const messageId = String(providerMessageId);
      const fail = Number(failType || 0);
      const now = this.#now();
      this.#database.prepare(`
        INSERT INTO delivery_failures (
          wecom_msgid, fail_type, observed_at
        ) VALUES (?, ?, ?)
        ON CONFLICT(wecom_msgid) DO UPDATE SET
          fail_type = excluded.fail_type,
          observed_at = excluded.observed_at
      `).run(messageId, fail, now);
      const current = rowAs<AttemptRow>(this.#database
        .prepare(`
          SELECT * FROM send_attempts
          WHERE channel = 'wechat_kf'
            AND wecom_msgid = ? AND status = 'accepted'
          ORDER BY updated_at DESC LIMIT 1
        `)
        .get(messageId));
      if (!current) return false;
      this.#applyDeliveryFailure(current, fail, now);
      return true;
    });
  }

  recoverStartup(): StartupRecovery {
    return this.#transaction(() => {
      const now = this.#now();
      this.#database.prepare(`
        UPDATE agent_sessions SET closed_at = ?, updated_at = ?
        WHERE closed_at = 0
      `).run(now, now);
      const sending = this.#database
        .prepare(`
          UPDATE send_attempts
          SET status = 'uncertain', error_code = 'startup_recovery',
              error_message = 'Process exited while send outcome was unknown',
              updated_at = ?
          WHERE status = 'sending'
        `)
        .run(now).changes;
      const sources = rowsAs<{ source_message_key: string }>(this.#database
        .prepare(`
          SELECT DISTINCT source_message_key FROM send_attempts
          WHERE status = 'uncertain' AND error_code = 'startup_recovery'
        `)
        .all());
      for (const source of sources) {
        this.#settleSourceMessage(source.source_message_key, now);
      }
      this.#database.prepare(`
        UPDATE inbound_messages
        SET status = 'received', primary_message_key = NULL,
            codex_turn_id = '', client_input_id = '', steering_boundary = 0,
            error_message = '', updated_at = ?
        WHERE status IN ('steering', 'steered') AND codex_turn_id = ''
      `).run(now);
      return {
        uncertainSends: Number(sending),
        inbound: rowsAs<InboundRow>(
          this.#database
            .prepare(`
              SELECT * FROM inbound_messages
              WHERE status IN (
                'received', 'failed', 'processing', 'preparing',
                'steering', 'steered', 'ready'
              )
                AND deferred = 0
              ORDER BY inbox_seq
            `)
            .all(),
        ).map((row) => mapInbound(row)!),
      };
    });
  }

  rememberInboundMedia({
    messageKey,
    attachments,
    sentAt = 0,
  }: {
    messageKey: string;
    attachments: readonly ImageAttachment[];
    sentAt?: number;
  }): MediaCatalogEntry[] {
    if (!Array.isArray(attachments)) throw new Error('attachments must be an array');
    return this.#transaction(() => {
      const message = this.#inboundRow(messageKey);
      if (!message) throw new Error(`Unknown inbound message: ${messageKey}`);
      this.#database
        .prepare('DELETE FROM inbound_media WHERE message_key = ?')
        .run(messageKey);
      const now = this.#now();
      const insert = this.#database.prepare(`
        INSERT INTO inbound_media (
          message_key, channel, open_kfid, external_userid, position, kind,
          media_id, filename, sent_at, remembered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      attachments.forEach((attachment, index) => {
        insert.run(
          messageKey,
          message.channel,
          message.open_kfid,
          message.external_userid,
          index,
          attachment.kind,
          requiredText(attachment.mediaId, 'attachment mediaId'),
          String(attachment?.filename || ''),
          Number(sentAt || message.sent_at || 0),
          now,
        );
      });
      return this.listRecentMedia({
        channel: message.channel,
        accountKey: message.open_kfid,
        peerId: message.external_userid,
        limit: attachments.length,
      }).filter((item) => item.messageKey === messageKey);
    });
  }

  listRecentMedia({
    channel,
    accountKey,
    peerId,
    limit = 10,
    maxAgeMs = 3 * 24 * 60 * 60 * 1000,
  }: {
    channel: ChatChannel;
    accountKey: string;
    peerId: string;
    limit?: number;
    maxAgeMs?: number;
  }): MediaCatalogEntry[] {
    const rows = rowsAs<{
      message_key: string;
      channel: ChatChannel;
      open_kfid: string;
      external_userid: string;
      media_id: string;
      filename: string;
      sent_at: number;
      remembered_at: number;
    }>(this.#database
      .prepare(`
        SELECT * FROM inbound_media
        WHERE channel = ? AND open_kfid = ? AND external_userid = ?
          AND remembered_at >= ?
        ORDER BY remembered_at DESC, media_seq DESC
        LIMIT ?
      `)
      .all(
        channel,
        String(accountKey),
        String(peerId),
        this.#now() - Number(maxAgeMs),
        Math.max(0, Math.min(Number(limit) || 10, 50)),
      ));
    return rows.map((row, index) => ({
        ref: `media:${index}`,
        messageKey: String(row.message_key),
        channel: row.channel,
        accountKey: String(row.open_kfid),
        peerId: String(row.external_userid),
        kind: 'image' as const,
        mediaId: String(row.media_id),
        filename: String(row.filename),
        sentAt: Number(row.sent_at),
        rememberedAt: Number(row.remembered_at),
      }));
  }

  cleanup({
    mediaMaxAgeMs = 3 * 24 * 60 * 60 * 1000,
    payloadMaxAgeMs = 7 * 24 * 60 * 60 * 1000,
    acceptedAuditMaxAgeMs = 30 * 24 * 60 * 60 * 1000,
  }: {
    mediaMaxAgeMs?: number;
    payloadMaxAgeMs?: number;
    acceptedAuditMaxAgeMs?: number;
  } = {}): {
    media: number;
    inboundPayloads: number;
    sendPayloads: number;
    audits: number;
    ilinkReplyWindows: number;
  } {
    return this.#transaction(() => {
      const now = this.#now();
      const wecomMedia = this.#database
        .prepare('DELETE FROM inbound_media WHERE remembered_at < ?')
        .run(now - mediaMaxAgeMs).changes;
      const ilinkMedia = this.#database
        .prepare(`
          DELETE FROM ilink_inbound_images
          WHERE created_at < ? AND EXISTS (
            SELECT 1 FROM inbound_messages AS inbound
            WHERE inbound.message_key = ilink_inbound_images.message_key
              AND inbound.status IN (
                'completed', 'absorbed', 'failed', 'ignored', 'suppressed'
              )
          )
        `)
        .run(now - mediaMaxAgeMs).changes;
      const inboundPayloads = this.#database
        .prepare(`
          UPDATE inbound_messages SET payload_json = NULL
          WHERE updated_at < ? AND status IN (
            'completed', 'absorbed', 'failed', 'ignored', 'suppressed'
          )
        `)
        .run(now - payloadMaxAgeMs).changes;
      const sendPayloads = this.#database
        .prepare(`
          UPDATE send_attempts SET payload_json = NULL, metadata_json = NULL
          WHERE updated_at < ? AND status IN ('accepted', 'failed')
        `)
        .run(now - payloadMaxAgeMs).changes;
      const audits = this.#database
        .prepare(`
          DELETE FROM send_attempts
          WHERE updated_at < ? AND status IN ('accepted', 'failed')
        `)
        .run(now - acceptedAuditMaxAgeMs).changes;
      this.#database.prepare(`
        DELETE FROM delivery_failures WHERE observed_at < ?
      `).run(now - acceptedAuditMaxAgeMs);
      this.#database.prepare(`
        DELETE FROM agent_sessions
        WHERE expires_at < ? OR (closed_at > 0 AND closed_at < ?)
      `).run(now, now - 60 * 60 * 1000);
      this.#database.prepare(`
        DELETE FROM ilink_reply_window_secrets
        WHERE reply_window_id IN (
          SELECT reply_window_id FROM ilink_reply_windows WHERE expires_at <= ?
        )
      `).run(now);
      this.#database.prepare(`
        UPDATE ilink_reply_windows
        SET state = 'closed', reserved_send_count = 0, updated_at = ?
        WHERE state = 'open' AND expires_at <= ?
          AND NOT EXISTS (
            SELECT 1 FROM send_attempts
            WHERE send_attempts.reply_window_id = ilink_reply_windows.reply_window_id
              AND send_attempts.status IN ('pending', 'sending')
          )
          AND NOT EXISTS (
            SELECT 1 FROM inbound_messages
            WHERE inbound_messages.message_key = ilink_reply_windows.source_message_key
              AND inbound_messages.status IN (
                'received', 'failed', 'processing', 'preparing',
                'steering', 'steered', 'ready'
              )
          )
      `).run(now, now);
      const ilinkReplyWindows = this.#database.prepare(`
        DELETE FROM ilink_reply_windows
        WHERE state <> 'open' AND updated_at < ?
          AND NOT EXISTS (
            SELECT 1 FROM send_attempts
            WHERE send_attempts.reply_window_id = ilink_reply_windows.reply_window_id
          )
      `).run(now - acceptedAuditMaxAgeMs).changes;
      this.#database.prepare(`
        DELETE FROM ilink_account_secrets
        WHERE account_key IN (
          SELECT account_key FROM ilink_accounts
          WHERE status IN ('disabled', 'revoked')
        )
      `).run();
      return {
        media: Number(wecomMedia) + Number(ilinkMedia),
        inboundPayloads: Number(inboundPayloads),
        sendPayloads: Number(sendPayloads),
        audits: Number(audits),
        ilinkReplyWindows: Number(ilinkReplyWindows),
      };
    });
  }

}

export type CoreState = SqliteStore;
