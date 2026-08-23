import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  ImageAttachment,
  MediaCatalogEntry,
  NormalizedMessage,
  PreparedAttempt,
} from '../types.ts';

const SCHEMA_VERSION = 3;
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
  'held',
  'suppressed',
] as const;
const SEND_STATUSES = [
  'pending',
  'blocked',
  'sending',
  'accepted',
  'failed',
  'uncertain',
] as const;
const CONVERSATION_MODES = ['bot', 'human', 'ended'] as const;

export type InboundStatus = (typeof INBOUND_STATUSES)[number];
export type SendStatus = (typeof SEND_STATUSES)[number];
export type ConversationMode = (typeof CONVERSATION_MODES)[number];
export type JsonPrimitive = null | boolean | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | JsonObject;
export interface JsonObject {
  [key: string]: JsonValue;
}

export interface InboundRecord {
  inboxSeq: number;
  messageKey: string;
  openKfId: string;
  msgid: string;
  externalUserId: string;
  origin: string;
  type: string;
  sentAt: number;
  status: InboundStatus;
  primaryMessageKey: string;
  payload?: JsonObject;
  contextStatus: 'none' | 'pending' | 'consumed';
  codexTurnId: string;
  clientInputId: string;
  claimedConversationEpoch: number;
  claimedRuntimeEpoch: number;
  errorMessage: string;
  createdAt: number;
  updatedAt: number;
}

export interface ConversationRecord {
  openKfId: string;
  externalUserId: string;
  threadId: string;
  mode: ConversationMode;
  automationEpoch: number;
  servicerUserId: string;
  source: string;
  changeType: number;
  updatedAt: number;
}

export interface AuthorizationRecord {
  externalUserId: string;
  authorized: boolean;
  consecutiveMatches: number;
  lastOpenKfId: string;
  lastMessageKey: string;
  authorizedAt: number;
  updatedAt: number;
}

export interface AuthorizationEvaluation {
  allowed: boolean;
  newlyAuthorized: boolean;
  duplicate: boolean;
  consecutiveMatches: number;
}

export interface AttemptRecord {
  attemptId: string;
  messageKey: string;
  openKfId: string;
  externalUserId: string;
  sendIndex: number;
  source: string;
  type: string;
  payload?: JsonObject;
  metadata?: JsonObject;
  fallbackForIndex?: number;
  fingerprint: string;
  clientMessageId: string;
  status: SendStatus;
  wecomMsgId: string;
  errorCode: string;
  errorMessage: string;
  failType: number;
  createdAt: number;
  updatedAt: number;
}

export interface RuntimeControl {
  paused: boolean;
  automationEpoch: number;
  updatedAt: number;
}

export interface ClaimedInbound {
  message: InboundRecord;
  heldContext: InboundRecord[];
}

export interface FinalizedBatch {
  suppressed: boolean;
  attempts: AttemptRecord[];
  duplicate?: boolean;
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
  origin: string;
  msg_type: string;
  sent_at: number;
  status: InboundStatus;
  primary_message_key: string | null;
  payload_json: string | null;
  context_status: 'none' | 'pending' | 'consumed';
  codex_turn_id: string;
  client_input_id: string;
  claimed_conversation_epoch: number;
  claimed_runtime_epoch: number;
  error_message: string;
  created_at: number;
  updated_at: number;
}

interface ConversationRow {
  open_kfid: string;
  external_userid: string;
  thread_id: string;
  mode: ConversationMode;
  automation_epoch: number;
  servicer_userid: string;
  session_source: string;
  change_type: number;
  updated_at: number;
}

interface AttemptRow {
  attempt_key: string;
  source_message_key: string;
  open_kfid: string;
  external_userid: string;
  send_index: number;
  source: string;
  sent_type: string;
  payload_json: string | null;
  metadata_json: string | null;
  fallback_for_index: number | null;
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

interface InsertAttemptInput {
  sourceMessageKey: string;
  openKfId: string;
  externalUserId: string;
  sendIndex: number;
  source?: string;
  sentType: string;
  payload?: Readonly<Record<string, unknown>>;
  metadata?: Readonly<Record<string, unknown>>;
  fallbackForIndex?: number | null;
  status?: 'pending' | 'blocked';
}

export interface LegacyInboundMessage extends Record<string, unknown> {
  origin?: string;
  type?: string;
  sentAt?: number;
  conversation?: {
    openKfId?: string;
    externalUserId?: string;
  };
}

export interface LegacyMessageRecord {
  openKfId?: string;
  externalUserId?: string;
  status?: string;
  primaryMessageId?: string;
  inboundMessage?: LegacyInboundMessage;
  errorMessage?: string;
  updatedAt?: number;
  sentChunks?: number;
  responseChunks?: unknown[];
  outboundMessages?: unknown[];
  toolDispatches?: unknown[];
  sendReceipts?: unknown[];
}

export interface LegacyAuthorization {
  authorized?: boolean;
  consecutiveMatches?: number;
  openKfId?: string;
  lastMessageId?: string;
  authorizedAt?: number;
  updatedAt?: number;
}

export interface LegacySession {
  mode?: string;
  servicerUserId?: string;
  source?: string;
  changeType?: number;
  updatedAt?: number;
}

export interface LegacyMediaEntry {
  messageId?: string;
  kind?: string;
  mediaId?: string;
  filename?: string;
  sentAt?: number;
  rememberedAt?: number;
}

export interface LegacyStateSnapshot {
  version: number;
  cursors?: Record<string, string>;
  threads?: Record<string, string>;
  sessions?: Record<string, LegacySession>;
  customerAuthorizations?: Record<string, LegacyAuthorization>;
  messages?: Record<string, LegacyMessageRecord>;
  inboundMedia?: Record<string, LegacyMediaEntry[]>;
}

export interface LegacyJournalEntry {
  key?: string;
  attemptKey?: string;
  fingerprint?: string;
  sentType?: string;
  clientMessageId?: string;
  status?: string;
  wecomMsgId?: string;
  errorCode?: string;
  errorMessage?: string;
  updatedAt?: number;
  openKfId?: string;
  externalUserId?: string;
  msgid?: string;
  sendIndex?: number;
  sourceMessageKey?: string;
  failType?: number;
  source?: string;
  metadata?: Readonly<Record<string, unknown>>;
}

type SqlInputValue = null | number | bigint | string | Uint8Array;
type SqlRow = Record<string, unknown>;
type Clock = () => number;

function rowAs<T>(row: unknown): T | undefined {
  return row === undefined ? undefined : row as T;
}

function rowsAs<T>(rows: readonly unknown[]): T[] {
  return rows as T[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return String(error.code ?? '');
}

function sqlList(values: readonly string[]): string {
  return values.map((value) => `'${value}'`).join(',');
}

function sha256(value: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(value).digest('hex');
}

function requiredText(value: unknown, name: string): string {
  const text = String(value || '');
  if (!text) throw new Error(`${name} is required`);
  return text;
}

function canonicalValue(value: unknown): JsonValue {
  if (value === undefined) return null;
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('JSON numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (typeof value !== 'object' || Buffer.isBuffer(value)) {
    throw new Error(`Unsupported JSON value: ${typeof value}`);
  }
  const source = value as Record<string, unknown>;
  const output: JsonObject = {};
  for (const key of Object.keys(source).sort()) {
    if (source[key] !== undefined) output[key] = canonicalValue(source[key]);
  }
  return output;
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

function mapInbound(row: InboundRow | undefined): InboundRecord | undefined {
  if (!row) return undefined;
  const payload = objectJson(row.payload_json);
  return {
    inboxSeq: row.inbox_seq,
    messageKey: row.message_key,
    openKfId: row.open_kfid,
    msgid: row.msgid,
    externalUserId: row.external_userid,
    origin: row.origin,
    type: row.msg_type,
    sentAt: row.sent_at,
    status: row.status,
    primaryMessageKey: row.primary_message_key || '',
    ...(payload ? { payload } : {}),
    contextStatus: row.context_status,
    codexTurnId: row.codex_turn_id,
    clientInputId: row.client_input_id,
    claimedConversationEpoch: row.claimed_conversation_epoch,
    claimedRuntimeEpoch: row.claimed_runtime_epoch,
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
    openKfId: row.open_kfid,
    externalUserId: row.external_userid,
    threadId: row.thread_id,
    mode: row.mode,
    automationEpoch: row.automation_epoch,
    servicerUserId: row.servicer_userid,
    source: row.session_source,
    changeType: row.change_type,
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
    openKfId: row.open_kfid,
    externalUserId: row.external_userid,
    sendIndex: row.send_index,
    source: row.source,
    type: row.sent_type,
    ...(payload ? { payload } : {}),
    ...(metadata ? { metadata } : {}),
    ...(row.fallback_for_index === null
      ? {}
      : { fallbackForIndex: row.fallback_for_index }),
    fingerprint: row.fingerprint,
    clientMessageId: row.client_message_id,
    status: row.status,
    wecomMsgId: row.wecom_msgid,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    failType: row.fail_type,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function inboundInsert(
  openKfId: string,
  message: NormalizedMessage,
  { cursor = '', index = 0 }: { cursor?: string; index?: number } = {},
): {
  messageKey: string;
  openKfId: string;
  msgid: string;
  externalUserId: string;
  origin: string;
  type: string;
  sentAt: number;
  status: 'received';
  payload: unknown;
} {
  if (!message || typeof message !== 'object' || Array.isArray(message)) {
    throw new Error('Inbound message must be an object');
  }
  const msgid = String(message.id || '') ||
    stableEventId({ openKfId, cursor, index, payload: message });
  return {
    messageKey: stableMessageKey(openKfId, msgid),
    openKfId,
    msgid,
    externalUserId: String(message.conversation.externalUserId || ''),
    origin: String(message.origin || 'unknown'),
    type: String(message.type || 'unknown'),
    sentAt: Number(message.sentAt || 0),
    status: 'received',
    payload: message,
  };
}

export function stableMessageKey(openKfId: string, msgid: string): string {
  const service = requiredText(openKfId, 'openKfId');
  const message = requiredText(msgid, 'msgid');
  return `im_${sha256(`${service}\0${message}`).slice(0, 40)}`;
}

function stableEventId({
  openKfId,
  cursor = '',
  index = 0,
  payload,
}: {
  openKfId: string;
  cursor?: string;
  index?: number;
  payload: unknown;
}): string {
  const digest = sha256(
    `${requiredText(openKfId, 'openKfId')}\0${cursor}\0${Number(index)}\0${encodeJson(payload)}`,
  );
  return `event_${digest.slice(0, 40)}`;
}

export function stableClientMessageId(
  messageKey: string,
  sendIndex: number,
): string {
  return `wb_${sha256(`${requiredText(messageKey, 'messageKey')}\0${sendIndex}`).slice(0, 29)}`;
}

function stableAttemptKey(messageKey: string, sendIndex: number): string {
  return `sa_${sha256(`${messageKey}\0${sendIndex}`).slice(0, 29)}`;
}

export class CursorConflictError extends Error {
  readonly code = 'cursor_conflict';
  readonly expected: string;
  readonly actual: string;

  constructor(openKfId: string, expected: string, actual: string) {
    super(
      `Cursor conflict for ${openKfId}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
    this.name = 'CursorConflictError';
    this.expected = expected;
    this.actual = actual;
  }
}

export class SendInvariantError extends Error {
  readonly code = 'send_fingerprint_conflict';
}

export function assertLegacyMigrationReady({
  databaseFile,
  legacyStateFile,
}: {
  databaseFile: string;
  legacyStateFile: string;
}): void {
  if (!fs.existsSync(legacyStateFile)) return;
  if (!fs.existsSync(databaseFile)) {
    throw new Error(
      'Legacy state requires offline migration; run pnpm run migrate:legacy',
    );
  }
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const marker = database.prepare(`
      SELECT value FROM schema_meta WHERE key = 'legacy_import_hash'
    `).get() as { value?: unknown } | undefined;
    if (!marker?.value) {
      throw new Error(
        'Legacy state is present but the SQLite database has no migration marker; run pnpm run migrate:legacy after moving the unmarked database aside',
      );
    }
  } finally {
    database.close();
  }
}

export class SqliteStore {
  readonly filePath: string;
  readonly database: DatabaseSync;
  private readonly clock: Clock;
  private closed = false;

  constructor({
    filePath,
    clock = Date.now,
    journalMode = 'WAL',
  }: {
    filePath: string;
    clock?: Clock;
    journalMode?: 'WAL' | 'DELETE';
  }) {
    if (!filePath) throw new Error('SQLite filePath is required');
    if (!['WAL', 'DELETE'].includes(journalMode)) {
      throw new Error(`Unsupported SQLite journal mode: ${journalMode}`);
    }

    this.filePath = path.resolve(filePath);
    this.clock = clock;
    const databaseDirectory = path.dirname(this.filePath);
    fs.mkdirSync(databaseDirectory, { recursive: true, mode: 0o700 });
    fs.chmodSync(databaseDirectory, 0o700);
    this.database = new DatabaseSync(this.filePath);
    fs.chmodSync(this.filePath, 0o600);
    this.database.exec('PRAGMA busy_timeout = 5000');
    this.database.exec(`PRAGMA journal_mode = ${journalMode}`);
    this.database.exec('PRAGMA synchronous = FULL');
    this.database.exec('PRAGMA foreign_keys = ON');
    try {
      this.#initializeSchema();
      this.#secureDatabaseFiles();
    } catch (error) {
      this.database.close();
      throw error;
    }
  }

  #now(): number {
    return Number(this.clock());
  }

  #initializeSchema(): void {
    const versionRow = rowAs<{ user_version: number }>(
      this.database.prepare('PRAGMA user_version').get(),
    );
    let version = Number(versionRow?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new Error(
        `SQLite schema version ${version} is newer than supported version ${SCHEMA_VERSION}`,
      );
    }
    if (version === SCHEMA_VERSION) return;

    if (version === 1) {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.exec(`
          DROP INDEX send_status_idx;
          CREATE INDEX send_status_idx
            ON send_attempts(status, created_at, send_index);
          PRAGMA user_version = 2;
          COMMIT;
        `);
        version = 2;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }

    if (version === 2) {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        this.database.exec(`
          CREATE UNIQUE INDEX conversation_thread_idx
            ON conversations(thread_id) WHERE thread_id <> '';
          PRAGMA user_version = 3;
          COMMIT;
        `);
        return;
      } catch (error) {
        this.database.exec('ROLLBACK');
        throw error;
      }
    }

    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.exec(`
        CREATE TABLE schema_meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE sync_cursors (
          open_kfid TEXT PRIMARY KEY,
          cursor TEXT NOT NULL,
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE TABLE conversations (
          open_kfid TEXT NOT NULL,
          external_userid TEXT NOT NULL,
          thread_id TEXT NOT NULL DEFAULT '',
          mode TEXT NOT NULL DEFAULT 'bot'
            CHECK (mode IN (${sqlList(CONVERSATION_MODES)})),
          automation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (automation_epoch >= 0),
          servicer_userid TEXT NOT NULL DEFAULT '',
          session_source TEXT NOT NULL DEFAULT '',
          change_type INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL,
          PRIMARY KEY (open_kfid, external_userid)
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
          context_status TEXT NOT NULL DEFAULT 'none'
            CHECK (context_status IN ('none', 'pending', 'consumed')),
          codex_turn_id TEXT NOT NULL DEFAULT '',
          client_input_id TEXT NOT NULL DEFAULT '',
          claimed_conversation_epoch INTEGER NOT NULL DEFAULT 0,
          claimed_runtime_epoch INTEGER NOT NULL DEFAULT 0,
          steering_boundary INTEGER NOT NULL DEFAULT 0,
          error_message TEXT NOT NULL DEFAULT '',
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          UNIQUE (open_kfid, msgid),
          UNIQUE (message_key, open_kfid, external_userid),
          FOREIGN KEY (primary_message_key)
            REFERENCES inbound_messages(message_key)
        ) STRICT;

        CREATE TABLE inbound_media (
          media_seq INTEGER PRIMARY KEY AUTOINCREMENT,
          message_key TEXT NOT NULL,
          open_kfid TEXT NOT NULL,
          external_userid TEXT NOT NULL,
          position INTEGER NOT NULL CHECK (position >= 0),
          kind TEXT NOT NULL,
          media_id TEXT NOT NULL,
          filename TEXT NOT NULL DEFAULT '',
          sent_at INTEGER NOT NULL DEFAULT 0,
          remembered_at INTEGER NOT NULL,
          UNIQUE (message_key, position),
          FOREIGN KEY (message_key, open_kfid, external_userid)
            REFERENCES inbound_messages(
              message_key, open_kfid, external_userid
            ) ON DELETE CASCADE
        ) STRICT;

        CREATE TABLE send_attempts (
          attempt_key TEXT PRIMARY KEY,
          source_message_key TEXT NOT NULL,
          open_kfid TEXT NOT NULL,
          external_userid TEXT NOT NULL,
          send_index INTEGER NOT NULL CHECK (send_index >= 0 AND send_index < 5),
          source TEXT NOT NULL,
          sent_type TEXT NOT NULL,
          payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
          metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
          fallback_for_index INTEGER CHECK (
            fallback_for_index IS NULL OR
            (fallback_for_index >= 0 AND fallback_for_index < 5)
          ),
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
          CHECK (
            fallback_for_index IS NULL OR fallback_for_index <> send_index
          ),
          CHECK (status <> 'blocked' OR fallback_for_index IS NOT NULL),
          FOREIGN KEY (source_message_key, open_kfid, external_userid)
            REFERENCES inbound_messages(
              message_key, open_kfid, external_userid
            ),
          FOREIGN KEY (source_message_key, fallback_for_index)
            REFERENCES send_attempts(source_message_key, send_index)
        ) STRICT;

        CREATE TABLE runtime_controls (
          control_id INTEGER PRIMARY KEY CHECK (control_id = 1),
          paused INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0, 1)),
          automation_epoch INTEGER NOT NULL DEFAULT 0 CHECK (automation_epoch >= 0),
          updated_at INTEGER NOT NULL
        ) STRICT;

        CREATE INDEX inbound_pending_idx
          ON inbound_messages(status, open_kfid, external_userid, inbox_seq);
        CREATE INDEX inbound_primary_idx
          ON inbound_messages(primary_message_key, inbox_seq);
        CREATE UNIQUE INDEX conversation_thread_idx
          ON conversations(thread_id) WHERE thread_id <> '';
        CREATE INDEX send_status_idx
          ON send_attempts(status, created_at, send_index);
        CREATE UNIQUE INDEX send_wecom_msgid_idx
          ON send_attempts(wecom_msgid) WHERE wecom_msgid <> '';
        CREATE INDEX send_conversation_idx
          ON send_attempts(open_kfid, external_userid, updated_at DESC);
        CREATE INDEX media_conversation_idx
          ON inbound_media(open_kfid, external_userid, remembered_at DESC);
      `);
      this.database
        .prepare(`
          INSERT INTO runtime_controls (
            control_id, paused, automation_epoch, updated_at
          ) VALUES (1, 0, 0, ?)
        `)
        .run(this.#now());
      this.database.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  #secureDatabaseFiles(): void {
    for (const candidate of [
      this.filePath,
      `${this.filePath}-wal`,
      `${this.filePath}-shm`,
    ]) {
      try {
        fs.chmodSync(candidate, 0o600);
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
    }
  }

  #transaction<T>(operation: () => T): T {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.database.exec('COMMIT');
      return result;
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  #ensureConversation(
    openKfId: string,
    externalUserId: string,
    now = this.#now(),
  ): void {
    if (!externalUserId) return;
    this.database
      .prepare(`
        INSERT INTO conversations (
          open_kfid, external_userid, updated_at
        ) VALUES (?, ?, ?)
        ON CONFLICT(open_kfid, external_userid) DO NOTHING
      `)
      .run(openKfId, externalUserId, now);
  }

  #inboundRow(messageKey: string): InboundRow | undefined {
    return rowAs<InboundRow>(
      this.database
        .prepare('SELECT * FROM inbound_messages WHERE message_key = ?')
        .get(messageKey),
    );
  }

  #attemptRow(attemptKey: string): AttemptRow | undefined {
    return rowAs<AttemptRow>(
      this.database
        .prepare('SELECT * FROM send_attempts WHERE attempt_key = ?')
        .get(attemptKey),
    );
  }

  #insertAttempt({
    sourceMessageKey,
    openKfId,
    externalUserId,
    sendIndex,
    source = 'codex_tool',
    sentType,
    payload,
    metadata,
    fallbackForIndex,
    status = 'pending',
  }: InsertAttemptInput): { inserted: boolean; attempt: AttemptRecord } {
    const index = Number(sendIndex);
    if (!Number.isInteger(index) || index < 0 || index >= 5) {
      throw new Error('sendIndex must be an integer between 0 and 4');
    }
    const stableClientId = stableClientMessageId(sourceMessageKey, index);
    const exactPayload = payload ? canonicalValue(payload) : undefined;
    const payloadJson = encodeJson(exactPayload);
    const actualFingerprint = sha256(`${sentType}\0${payloadJson || ''}`);
    const actualAttemptKey = stableAttemptKey(sourceMessageKey, index);
    const now = this.#now();

    const result = this.database
      .prepare(`
        INSERT INTO send_attempts (
          attempt_key, source_message_key, open_kfid, external_userid,
          send_index, source, sent_type, payload_json, metadata_json,
          fallback_for_index, fingerprint, client_message_id, status,
          wecom_msgid, error_code, error_message, fail_type,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(source_message_key, send_index) DO NOTHING
      `)
      .run(
        actualAttemptKey,
        sourceMessageKey,
        openKfId,
        externalUserId,
        index,
        String(source),
        requiredText(sentType, 'sentType'),
        payloadJson,
        encodeJson(metadata),
        fallbackForIndex == null ? null : Number(fallbackForIndex),
        actualFingerprint,
        stableClientId,
        status,
        '',
        '',
        '',
        0,
        now,
        now,
      );

    const existing = rowAs<AttemptRow>(
      this.database
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
      existing.open_kfid !== openKfId ||
      existing.external_userid !== externalUserId ||
      existing.source !== String(source) ||
      existing.fallback_for_index !==
        (fallbackForIndex == null ? null : Number(fallbackForIndex))
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
    const activeRow = rowAs<{ count: number }>(this.database
      .prepare(`
        SELECT COUNT(*) AS count
        FROM send_attempts
        WHERE source_message_key = ? AND status IN ('pending', 'sending')
      `)
      .get(sourceMessageKey));
    const active = Number(activeRow?.count ?? 0);
    if (Number(active) > 0) return;
    this.database
      .prepare(`
        UPDATE inbound_messages
        SET status = CASE WHEN status = 'suppressed' THEN status ELSE 'completed' END,
            payload_json = NULL,
            updated_at = ?
        WHERE message_key = ? AND status IN ('ready', 'processing', 'preparing')
      `)
      .run(now, sourceMessageKey);
  }

  #activateFallback(attempt: AttemptRow, now: number): number {
    const changes = Number(this.database
      .prepare(`
        UPDATE send_attempts SET status = 'pending', updated_at = ?
        WHERE source_message_key = ? AND fallback_for_index = ?
          AND status = 'blocked'
      `)
      .run(now, attempt.source_message_key, attempt.send_index).changes);
    if (changes) {
      this.database.prepare(`
        UPDATE inbound_messages SET status = 'ready', updated_at = ?
        WHERE message_key = ? AND status = 'completed'
      `).run(now, attempt.source_message_key);
    }
    return changes;
  }

  #suppressGroup(messageKey: string, reason: string, now: number): void {
    this.database.prepare(`
      UPDATE inbound_messages
      SET status = 'suppressed', error_message = ?, updated_at = ?
      WHERE (message_key = ? OR primary_message_key = ?)
        AND status NOT IN ('completed', 'ignored', 'absorbed')
    `).run(reason, now, messageKey, messageKey);
    this.database.prepare(`
      UPDATE send_attempts
      SET status = 'failed', error_code = 'suppressed',
          error_message = ?, updated_at = ?
      WHERE source_message_key = ? AND status IN ('pending', 'blocked')
    `).run(reason, now, messageKey);
  }

  #finishSending(
    attemptId: string,
    status: 'accepted' | 'uncertain',
    fields: { wecomMsgId?: string; errorCode?: string; errorMessage?: string },
  ): AttemptRecord {
    const current = this.#attemptRow(attemptId);
    if (!current) throw new Error(`Unknown send attempt: ${attemptId}`);
    if (current.status === status) return mapAttempt(current)!;
    if (current.status !== 'sending') {
      throw new Error(`Cannot mark send ${status} in status ${current.status}`);
    }
    const now = this.#now();
    this.database.prepare(`
      UPDATE send_attempts
      SET status = ?, wecom_msgid = ?, error_code = ?, error_message = ?,
          updated_at = ?
      WHERE attempt_key = ? AND status = 'sending'
    `).run(
      status, fields.wecomMsgId || '', fields.errorCode || '',
      fields.errorMessage || '', now, attemptId,
    );
    this.#settleSourceMessage(current.source_message_key, now);
    return mapAttempt(this.#attemptRow(attemptId))!;
  }

  integrityCheck(): SqlRow[] {
    return rowsAs<SqlRow>(
      this.database.prepare('PRAGMA integrity_check').all(),
    );
  }

  foreignKeyCheck(): SqlRow[] {
    return rowsAs<SqlRow>(
      this.database.prepare('PRAGMA foreign_key_check').all(),
    );
  }

  checkpoint(
    mode: 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE' = 'TRUNCATE',
  ): SqlRow | undefined {
    if (!['PASSIVE', 'FULL', 'RESTART', 'TRUNCATE'].includes(mode)) {
      throw new Error(`Unsupported checkpoint mode: ${mode}`);
    }
    return rowAs<SqlRow>(
      this.database.prepare(`PRAGMA wal_checkpoint(${mode})`).get(),
    );
  }

  getCursor(openKfId: string): string {
    const cursor = rowAs<{ cursor: unknown }>(
      this.database
        .prepare('SELECT cursor FROM sync_cursors WHERE open_kfid = ?')
        .get(String(openKfId)),
    )?.cursor;
    return cursor === undefined ? '' : String(cursor);
  }

  ingestSyncPage({
    openKfId,
    expectedCursor = '',
    nextCursor = '',
    messages,
  }: {
    openKfId: string;
    expectedCursor?: string;
    nextCursor?: string;
    messages: readonly NormalizedMessage[];
  }): { insertedMessageKeys: string[]; cursor: string } {
    const service = requiredText(openKfId, 'openKfId');
    if (!Array.isArray(messages)) throw new Error('messages must be an array');
    const inserts = messages.map((message, index) =>
      inboundInsert(service, message, {
        cursor: String(expectedCursor || ''),
        index,
      }),
    );

    return this.#transaction(() => {
      const actualCursor = this.getCursor(service);
      if (actualCursor !== String(expectedCursor || '')) {
        throw new CursorConflictError(service, expectedCursor || '', actualCursor);
      }
      const now = this.#now();
      const insertedMessageKeys: string[] = [];
      const statement = this.database.prepare(`
        INSERT INTO inbound_messages (
          message_key, open_kfid, msgid, external_userid, origin, msg_type,
          sent_at, status, payload_json, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(open_kfid, msgid) DO NOTHING
      `);

      for (const message of inserts) {
        const result = statement.run(
          message.messageKey,
          service,
          message.msgid,
          message.externalUserId,
          message.origin,
          message.type,
          message.sentAt,
          message.status,
          encodeJson(message.payload),
          now,
          now,
        );
        this.#ensureConversation(service, message.externalUserId, now);
        if (result.changes === 1) insertedMessageKeys.push(message.messageKey);
      }

      this.database
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

  getInbound(messageKey: string): InboundRecord | undefined {
    return mapInbound(this.#inboundRow(messageKey));
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
    openKfId,
    externalUserId,
    limit = 100,
  }: {
    statuses?: readonly InboundStatus[];
    openKfId?: string;
    externalUserId?: string;
    limit?: number;
  } = {}): InboundRecord[] {
    const selected = [...new Set(statuses)];
    if (!selected.length) return [];
    const clauses = [`status IN (${selected.map(() => '?').join(',')})`];
    const parameters: SqlInputValue[] = [...selected];
    if (openKfId) {
      clauses.push('open_kfid = ?');
      parameters.push(String(openKfId));
    }
    if (externalUserId) {
      clauses.push('external_userid = ?');
      parameters.push(String(externalUserId));
    }
    parameters.push(Math.max(1, Math.min(Number(limit) || 100, 1000)));
    return rowsAs<InboundRow>(this.database
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
    openKfId: string,
    externalUserId: string,
  ): ConversationRecord | undefined {
    return mapConversation(
      rowAs<ConversationRow>(
        this.database
          .prepare(`
            SELECT * FROM conversations
            WHERE open_kfid = ? AND external_userid = ?
          `)
          .get(String(openKfId), String(externalUserId)),
      ),
    );
  }

  setConversationThread({
    openKfId,
    externalUserId,
    threadId,
  }: {
    openKfId: string;
    externalUserId: string;
    threadId: string;
  }): ConversationRecord {
    return this.#transaction(() => {
      const now = this.#now();
      this.database
        .prepare(`
          INSERT INTO conversations (
            open_kfid, external_userid, thread_id, updated_at
          ) VALUES (?, ?, ?, ?)
          ON CONFLICT(open_kfid, external_userid) DO UPDATE SET
            thread_id = excluded.thread_id,
            updated_at = excluded.updated_at
        `)
        .run(openKfId, externalUserId, String(threadId || ''), now);
      return this.getConversation(openKfId, externalUserId)!;
    });
  }

  setConversationMode({
    openKfId,
    externalUserId,
    mode,
    servicerUserId = '',
    source = '',
    changeType = 0,
    bumpEpoch = true,
  }: {
    openKfId: string;
    externalUserId: string;
    mode: ConversationMode;
    servicerUserId?: string;
    source?: string;
    changeType?: number;
    bumpEpoch?: boolean;
  }): ConversationRecord {
    if (!CONVERSATION_MODES.includes(mode)) {
      throw new Error(`Unsupported conversation mode: ${mode}`);
    }
    return this.#transaction(() => {
      const now = this.#now();
      this.database
        .prepare(`
          INSERT INTO conversations (
            open_kfid, external_userid, mode, automation_epoch,
            servicer_userid, session_source, change_type, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(open_kfid, external_userid) DO UPDATE SET
            mode = excluded.mode,
            automation_epoch = conversations.automation_epoch + ?,
            servicer_userid = excluded.servicer_userid,
            session_source = excluded.session_source,
            change_type = excluded.change_type,
            updated_at = excluded.updated_at
        `)
        .run(
          openKfId,
          externalUserId,
          mode,
          bumpEpoch ? 1 : 0,
          String(servicerUserId || ''),
          String(source || ''),
          Number(changeType || 0),
          now,
          bumpEpoch ? 1 : 0,
        );
      return this.getConversation(openKfId, externalUserId)!;
    });
  }

  getRuntimeControl(): RuntimeControl {
    const row = rowAs<{
      paused: number;
      automation_epoch: number;
      updated_at: number;
    }>(
      this.database
        .prepare('SELECT * FROM runtime_controls WHERE control_id = 1')
        .get(),
    );
    if (!row) throw new Error('Missing runtime control row');
    return {
      paused: row.paused === 1,
      automationEpoch: row.automation_epoch,
      updatedAt: row.updated_at,
    };
  }

  setRuntimePaused(paused: boolean): RuntimeControl {
    return this.#transaction(() => {
      const next = Boolean(paused);
      this.database
        .prepare(`
          UPDATE runtime_controls
          SET paused = ?,
              automation_epoch = automation_epoch + (paused <> ?),
              updated_at = ?
          WHERE control_id = 1
        `)
        .run(next ? 1 : 0, next ? 1 : 0, this.#now());
      return this.getRuntimeControl();
    });
  }

  getAuthorization(externalUserId: string): AuthorizationRecord | undefined {
    const row = rowAs<{
      external_userid: string;
      authorized: number;
      consecutive_matches: number;
      last_open_kfid: string;
      last_message_key: string;
      authorized_at: number;
      updated_at: number;
    }>(
      this.database
        .prepare('SELECT * FROM authorizations WHERE external_userid = ?')
        .get(String(externalUserId)),
    );
    if (!row) return undefined;
    return {
      externalUserId: row.external_userid,
      authorized: row.authorized === 1,
      consecutiveMatches: row.consecutive_matches,
      lastOpenKfId: row.last_open_kfid,
      lastMessageKey: row.last_message_key,
      authorizedAt: row.authorized_at,
      updatedAt: row.updated_at,
    };
  }

  revokeAuthorization(externalUserId: string): AuthorizationRecord {
    const userId = requiredText(externalUserId, 'externalUserId');
    return this.#transaction(() => {
      const now = this.#now();
      this.database
        .prepare(`
          INSERT INTO authorizations (
            external_userid, authorized, consecutive_matches,
            last_open_kfid, last_message_key, authorized_at, updated_at
          ) VALUES (?, 0, 0, '', '', 0, ?)
          ON CONFLICT(external_userid) DO UPDATE SET
            authorized = 0,
            consecutive_matches = 0,
            last_open_kfid = '',
            last_message_key = '',
            authorized_at = 0,
            updated_at = excluded.updated_at
        `)
        .run(userId, now);
      this.database.prepare(`
        UPDATE conversations
        SET automation_epoch = automation_epoch + 1, updated_at = ?
        WHERE external_userid = ?
      `).run(now, userId);
      this.database.prepare(`
        UPDATE inbound_messages
        SET status = 'suppressed', error_message = 'authorization_revoked',
            updated_at = ?
        WHERE external_userid = ?
          AND status IN ('processing', 'preparing', 'steering', 'steered', 'ready')
      `).run(now, userId);
      this.database.prepare(`
        UPDATE send_attempts
        SET status = 'failed', error_code = 'authorization_revoked',
            error_message = 'authorization revoked before send', updated_at = ?
        WHERE external_userid = ? AND status IN ('pending', 'blocked')
      `).run(now, userId);
      return this.getAuthorization(userId)!;
    });
  }

  evaluateAuthorization({
    messageKey,
    openKfId,
    externalUserId,
    isTrigger,
    requiredConsecutive = 3,
    confirmationText = '暗号确认，请继续对话',
  }: {
    messageKey: string;
    openKfId: string;
    externalUserId: string;
    isTrigger: boolean;
    requiredConsecutive?: number;
    confirmationText?: string;
  }): AuthorizationEvaluation {
    return this.#transaction(() => {
      const message = this.#inboundRow(messageKey);
      if (!message) throw new Error(`Unknown inbound message: ${messageKey}`);
      if (
        message.open_kfid !== openKfId ||
        message.external_userid !== externalUserId
      ) {
        throw new Error('Authorization target does not match inbound message');
      }
      const current = this.getAuthorization(externalUserId);
      if (current?.authorized && current.lastMessageKey === messageKey) {
        return {
          allowed: false,
          newlyAuthorized: false,
          duplicate: true,
          consecutiveMatches: current.consecutiveMatches,
        };
      }
      if (current?.authorized) {
        return {
          allowed: true,
          newlyAuthorized: false,
          duplicate: false,
          consecutiveMatches: current.consecutiveMatches,
        };
      }
      if (current?.lastMessageKey === messageKey) {
        return {
          allowed: false,
          newlyAuthorized: false,
          duplicate: true,
          consecutiveMatches: current.consecutiveMatches,
        };
      }

      const threshold = Math.max(1, Number(requiredConsecutive) || 3);
      const consecutiveMatches = isTrigger
        ? (current?.lastOpenKfId === openKfId
            ? current.consecutiveMatches
            : 0) + 1
        : 0;
      const newlyAuthorized = consecutiveMatches >= threshold;
      const now = this.#now();
      this.database
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
          externalUserId,
          newlyAuthorized ? 1 : 0,
          consecutiveMatches,
          openKfId,
          messageKey,
          newlyAuthorized ? now : 0,
          now,
        );

      if (newlyAuthorized) {
        const conversation = this.getConversation(openKfId, externalUserId) || {
          automationEpoch: 0,
        };
        const runtime = this.getRuntimeControl();
        this.#insertAttempt({
          sourceMessageKey: messageKey,
          openKfId,
          externalUserId,
          sendIndex: 0,
          source: 'authorization',
          sentType: 'text',
          payload: {
            msgtype: 'text',
            text: { content: String(confirmationText) },
          },
        });
        this.database
          .prepare(`
            UPDATE inbound_messages
            SET status = 'ready',
                claimed_conversation_epoch = ?,
                claimed_runtime_epoch = ?,
                updated_at = ?
            WHERE message_key = ?
          `)
          .run(
            Number(conversation.automationEpoch || 0),
            runtime.automationEpoch,
            now,
            messageKey,
          );
      } else {
        this.database
          .prepare(`
            UPDATE inbound_messages
            SET status = 'ignored', payload_json = NULL, updated_at = ?
            WHERE message_key = ?
          `)
          .run(now, messageKey);
      }

      return {
        allowed: false,
        newlyAuthorized,
        duplicate: false,
        consecutiveMatches,
      };
    });
  }

  claimInbound({
    messageKey,
    clientInputId = messageKey,
    consumeHeldContext = false,
  }: {
    messageKey: string;
    clientInputId?: string;
    consumeHeldContext?: boolean;
  }): ClaimedInbound {
    return this.#transaction(() => {
      const row = this.#inboundRow(messageKey);
      if (!row) throw new Error(`Unknown inbound message: ${messageKey}`);
      if (['processing', 'preparing'].includes(row.status)) {
        if (clientInputId && row.client_input_id !== String(clientInputId)) {
          this.database
            .prepare(`
              UPDATE inbound_messages
              SET client_input_id = ?, updated_at = ?
              WHERE message_key = ?
            `)
            .run(String(clientInputId), this.#now(), messageKey);
        }
        return { message: this.getInbound(messageKey)!, heldContext: [] };
      }
      if (row.status !== 'received' && row.status !== 'failed') {
        throw new Error(`Cannot claim inbound message in status ${row.status}`);
      }
      const conversation = this.getConversation(
        row.open_kfid,
        row.external_userid,
      ) || { automationEpoch: 0 };
      const runtime = this.getRuntimeControl();
      const now = this.#now();
      this.database
        .prepare(`
          UPDATE inbound_messages
          SET status = 'processing',
              client_input_id = ?,
              claimed_conversation_epoch = ?,
              claimed_runtime_epoch = ?,
              error_message = '',
              updated_at = ?
          WHERE message_key = ?
        `)
        .run(
          String(clientInputId || messageKey),
          Number(conversation.automationEpoch || 0),
          runtime.automationEpoch,
          now,
          messageKey,
        );

      let heldContext: InboundRecord[] = [];
      if (consumeHeldContext) {
        heldContext = rowsAs<InboundRow>(this.database
          .prepare(`
            SELECT * FROM inbound_messages
            WHERE open_kfid = ? AND external_userid = ? AND status = 'held'
            ORDER BY inbox_seq
          `)
          .all(row.open_kfid, row.external_userid))
          .map((heldRow) => mapInbound(heldRow)!);
        if (heldContext.length) {
          this.database
            .prepare(`
              UPDATE inbound_messages
              SET status = 'absorbed', context_status = 'consumed',
                  primary_message_key = ?, updated_at = ?
              WHERE open_kfid = ? AND external_userid = ? AND status = 'held'
            `)
            .run(
              messageKey,
              now,
              row.open_kfid,
              row.external_userid,
            );
        }
      }
      return { message: this.getInbound(messageKey)!, heldContext };
    });
  }

  markInboundPreparing(
    messageKey: string,
    codexTurnId = '',
  ): InboundRecord {
    const result = this.database
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
        message.open_kfid !== primary.open_kfid ||
        message.external_userid !== primary.external_userid
      ) {
        throw new Error('Steer message must belong to the primary conversation');
      }
      const updated = this.database
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
    const updated = this.database
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
      const updated = this.database
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
      const primary = this.database
        .prepare(`
          UPDATE inbound_messages
          SET status = 'failed', error_message = ?, updated_at = ?
          WHERE message_key = ? AND status IN ('processing', 'preparing')
        `)
        .run(message, now, messageKey);
      if (primary.changes === 1) {
        this.database
          .prepare(`
            UPDATE inbound_messages
            SET status = 'failed', error_message = ?, updated_at = ?
            WHERE primary_message_key = ? AND status IN ('steering', 'steered')
          `)
          .run(message, now, messageKey);
      }
      return this.getInbound(messageKey);
    });
  }

  markInboundHeld(messageKey: string): InboundRecord {
    return this.#transaction(() => {
      const updated = this.database
        .prepare(`
          UPDATE inbound_messages
          SET status = 'held', context_status = 'pending', updated_at = ?
          WHERE message_key = ? AND status = 'received'
        `)
        .run(this.#now(), messageKey);
      if (updated.changes !== 1) {
        throw new Error(`Cannot hold inbound message: ${messageKey}`);
      }
      return this.getInbound(messageKey)!;
    });
  }

  markInboundIgnored(messageKey: string): InboundRecord {
    const updated = this.database
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
    const updated = this.database
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

  listHeldContext(openKfId: string, externalUserId: string): InboundRecord[] {
    return rowsAs<InboundRow>(this.database
      .prepare(`
        SELECT * FROM inbound_messages
        WHERE open_kfid = ? AND external_userid = ? AND status = 'held'
        ORDER BY inbox_seq
      `)
      .all(String(openKfId), String(externalUserId)))
      .map((row) => mapInbound(row)!);
  }

  finalizeInboundBatch({
    messageKey,
    steeringMessageKeys = [],
    expectedConversationEpoch,
    expectedRuntimeEpoch,
    attempts,
  }: {
    messageKey: string;
    steeringMessageKeys?: readonly string[];
    expectedConversationEpoch: number;
    expectedRuntimeEpoch: number;
    attempts: readonly PreparedAttempt[];
  }): FinalizedBatch {
    if (!Array.isArray(attempts) || attempts.length < 1 || attempts.length > 5) {
      throw new Error('Final send batch must contain 1 to 5 reserved attempts');
    }
    const indexes = new Set(attempts.map((attempt) => Number(attempt.sendIndex)));
    if (indexes.size !== attempts.length) {
      throw new Error('Final send batch contains duplicate send indexes');
    }

    return this.#transaction(() => {
      const primary = this.#inboundRow(messageKey);
      if (!primary) throw new Error(`Unknown inbound message: ${messageKey}`);
      if (primary.status === 'suppressed') {
        return { suppressed: true, attempts: [] };
      }
      if (['ready', 'completed'].includes(primary.status)) {
        const reserved = attempts.map((attempt) =>
          this.#insertAttempt({
            ...attempt,
            sourceMessageKey: messageKey,
            openKfId: primary.open_kfid,
            externalUserId: primary.external_userid,
          }).attempt,
        );
        return { suppressed: false, attempts: reserved, duplicate: true };
      }
      if (!['processing', 'preparing'].includes(primary.status)) {
        throw new Error(`Cannot finalize inbound message in status ${primary.status}`);
      }
      const conversation = this.getConversation(
        primary.open_kfid,
        primary.external_userid,
      ) || { mode: 'bot', automationEpoch: 0 };
      const runtime = this.getRuntimeControl();
      const allowed =
        conversation.mode === 'bot' &&
        !runtime.paused &&
        conversation.automationEpoch === Number(expectedConversationEpoch) &&
        runtime.automationEpoch === Number(expectedRuntimeEpoch);
      const now = this.#now();
      const steerKeys = [...new Set(steeringMessageKeys.map(String))];
      if (!allowed) {
        this.#suppressGroup(messageKey, 'automation_epoch_changed', now);
        return { suppressed: true, attempts: [] };
      }

      const reserved = attempts.map((attempt) =>
        this.#insertAttempt({
          ...attempt,
          sourceMessageKey: messageKey,
          openKfId: primary.open_kfid,
          externalUserId: primary.external_userid,
        }).attempt,
      );
      const primaryUpdate = this.database
        .prepare(`
          UPDATE inbound_messages
          SET status = 'ready', updated_at = ?
          WHERE message_key = ? AND status IN ('processing', 'preparing', 'ready')
        `)
        .run(now, messageKey);
      if (primaryUpdate.changes !== 1) {
        throw new Error(`Cannot finalize inbound message in status ${primary.status}`);
      }
      if (steerKeys.length) {
        const absorbed = this.database
          .prepare(`
            UPDATE inbound_messages
            SET status = 'absorbed', payload_json = NULL, updated_at = ?
            WHERE message_key IN (${steerKeys.map(() => '?').join(',')})
              AND status = 'steered' AND primary_message_key = ?
          `)
          .run(now, ...steerKeys, messageKey);
        if (absorbed.changes !== steerKeys.length) {
          throw new Error('Not every steering message belongs to the final batch');
        }
      }
      return { suppressed: false, attempts: reserved };
    });
  }

  listRecentConversationAttempts({
    openKfId,
    externalUserId,
    limit = 20,
  }: {
    openKfId: string;
    externalUserId: string;
    limit?: number;
  }): AttemptRecord[] {
    return rowsAs<AttemptRow>(this.database
      .prepare(`
        SELECT * FROM send_attempts
        WHERE open_kfid = ? AND external_userid = ?
          AND status IN ('accepted', 'failed', 'uncertain')
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(
        requiredText(openKfId, 'openKfId'),
        requiredText(externalUserId, 'externalUserId'),
        Math.max(1, Math.min(Number(limit) || 20, 100)),
      ))
      .map((row) => mapAttempt(row)!);
  }

  beginNextSend(): AttemptRecord | undefined {
    return this.#transaction(() => {
      const runtime = this.getRuntimeControl();
      const now = this.#now();
      while (true) {
        const candidates = rowsAs<AttemptRow>(
          this.database
            .prepare(`
              SELECT * FROM send_attempts
              WHERE status = 'pending' AND NOT EXISTS (
                SELECT 1 FROM send_attempts AS active
                WHERE active.status = 'sending'
                  AND active.open_kfid = send_attempts.open_kfid
                  AND active.external_userid = send_attempts.external_userid
              )
              ORDER BY created_at, send_index
              LIMIT 100
            `)
            .all(),
        );
        if (!candidates.length) return undefined;
        for (const candidate of candidates) {
          const conversation = this.getConversation(
            candidate.open_kfid,
            candidate.external_userid,
          );
          const inbound = this.#inboundRow(candidate.source_message_key);
          const staleEpoch =
            inbound !== undefined &&
            (inbound.claimed_conversation_epoch !==
              Number(conversation?.automationEpoch || 0) ||
              inbound.claimed_runtime_epoch !== runtime.automationEpoch);
          if (runtime.paused || conversation?.mode === 'human' || staleEpoch) {
            this.#suppressGroup(
              candidate.source_message_key,
              'automation disabled before send',
              now,
            );
            continue;
          }
          const claimed = this.database
            .prepare(`
              UPDATE send_attempts SET status = 'sending', updated_at = ?
              WHERE attempt_key = ? AND status = 'pending'
            `)
            .run(now, candidate.attempt_key);
          if (claimed.changes === 1) {
            return mapAttempt(this.#attemptRow(candidate.attempt_key))!;
          }
        }
      }
    });
  }

  completeSend(
    attemptId: string,
    { wecomMsgId }: { wecomMsgId: string },
  ): AttemptRecord {
    const acceptedMessageId = requiredText(wecomMsgId, 'wecomMsgId');
    return this.#transaction(() => this.#finishSending(attemptId, 'accepted', {
      wecomMsgId: acceptedMessageId,
    }));
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
      this.database
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
      this.#activateFallback(current, now);
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
    wecomMsgId,
    failType,
  }: {
    wecomMsgId: string;
    failType: number;
  }): boolean {
    if (!String(wecomMsgId || '')) return false;
    return this.#transaction(() => {
      const current = rowAs<AttemptRow>(this.database
        .prepare(`
          SELECT * FROM send_attempts
          WHERE wecom_msgid = ? AND status = 'accepted'
          ORDER BY updated_at DESC LIMIT 1
        `)
        .get(String(wecomMsgId)));
      if (!current) return false;
      const now = this.#now();
      this.database
        .prepare(`
          UPDATE send_attempts
          SET status = 'failed', fail_type = ?, error_code = 'msg_send_fail',
              error_message = 'WeChat reported delivery failure', updated_at = ?
          WHERE attempt_key = ?
        `)
        .run(Number(failType || 0), now, current.attempt_key);
      this.#activateFallback(current, now);
      return true;
    });
  }

  recoverStartup(): StartupRecovery {
    return this.#transaction(() => {
      const now = this.#now();
      const sending = this.database
        .prepare(`
          UPDATE send_attempts
          SET status = 'uncertain', error_code = 'startup_recovery',
              error_message = 'Process exited while send outcome was unknown',
              updated_at = ?
          WHERE status = 'sending'
        `)
        .run(now).changes;
      const sources = rowsAs<{ source_message_key: string }>(this.database
        .prepare(`
          SELECT DISTINCT source_message_key FROM send_attempts
          WHERE status = 'uncertain' AND error_code = 'startup_recovery'
        `)
        .all());
      for (const source of sources) {
        this.#settleSourceMessage(source.source_message_key, now);
      }
      return {
        uncertainSends: Number(sending),
        inbound: rowsAs<InboundRow>(
          this.database
            .prepare(`
              SELECT * FROM inbound_messages
              WHERE status IN (
                'received', 'processing', 'preparing',
                'steering', 'steered', 'ready'
              )
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
      this.database
        .prepare('DELETE FROM inbound_media WHERE message_key = ?')
        .run(messageKey);
      const now = this.#now();
      const insert = this.database.prepare(`
        INSERT INTO inbound_media (
          message_key, open_kfid, external_userid, position, kind,
          media_id, filename, sent_at, remembered_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      attachments.forEach((attachment, index) => {
        insert.run(
          messageKey,
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
        openKfId: message.open_kfid,
        externalUserId: message.external_userid,
        limit: attachments.length,
      }).filter((item) => item.messageKey === messageKey);
    });
  }

  listRecentMedia({
    openKfId,
    externalUserId,
    limit = 10,
    maxAgeMs = 3 * 24 * 60 * 60 * 1000,
  }: {
    openKfId: string;
    externalUserId: string;
    limit?: number;
    maxAgeMs?: number;
  }): MediaCatalogEntry[] {
    const rows = rowsAs<{
      message_key: string;
      open_kfid: string;
      external_userid: string;
      media_id: string;
      filename: string;
      sent_at: number;
      remembered_at: number;
    }>(this.database
      .prepare(`
        SELECT * FROM inbound_media
        WHERE open_kfid = ? AND external_userid = ? AND remembered_at >= ?
        ORDER BY remembered_at DESC, media_seq DESC
        LIMIT ?
      `)
      .all(
        String(openKfId),
        String(externalUserId),
        this.#now() - Number(maxAgeMs),
        Math.max(0, Math.min(Number(limit) || 10, 50)),
      ));
    return rows.map((row, index) => ({
        ref: `media:${index}`,
        messageKey: String(row.message_key),
        openKfId: String(row.open_kfid),
        externalUserId: String(row.external_userid),
        kind: 'image' as const,
        mediaId: String(row.media_id),
        filename: String(row.filename),
        sentAt: Number(row.sent_at),
        rememberedAt: Number(row.remembered_at),
      }));
  }

  getLatestGeneratedImageDelivery({
    openKfId,
    externalUserId,
  }: {
    openKfId: string;
    externalUserId: string;
  }): {
    accepted: boolean;
    uncertain: boolean;
    metadata: JsonObject;
    updatedAt: number;
  } | undefined {
    const row = rowAs<AttemptRow>(this.database
      .prepare(`
        SELECT * FROM send_attempts
        WHERE open_kfid = ? AND external_userid = ?
          AND source = 'codex_image' AND sent_type = 'image'
          AND status IN ('accepted', 'uncertain')
        ORDER BY updated_at DESC LIMIT 1
      `)
      .get(String(openKfId), String(externalUserId)));
    if (!row) return undefined;
    const attempt = mapAttempt(row)!;
    return {
      accepted: attempt.status === 'accepted',
      uncertain: attempt.status === 'uncertain',
      metadata: attempt.metadata || {},
      updatedAt: attempt.updatedAt,
    };
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
    blockedFallbacks: number;
    audits: number;
  } {
    return this.#transaction(() => {
      const now = this.#now();
      const media = this.database
        .prepare('DELETE FROM inbound_media WHERE remembered_at < ?')
        .run(now - mediaMaxAgeMs).changes;
      const inboundPayloads = this.database
        .prepare(`
          UPDATE inbound_messages SET payload_json = NULL
          WHERE updated_at < ? AND status IN (
            'completed', 'absorbed', 'failed', 'ignored', 'suppressed'
          )
        `)
        .run(now - payloadMaxAgeMs).changes;
      const sendPayloads = this.database
        .prepare(`
          UPDATE send_attempts SET payload_json = NULL, metadata_json = NULL
          WHERE updated_at < ? AND status IN ('accepted', 'failed')
        `)
        .run(now - payloadMaxAgeMs).changes;
      const blockedFallbacks = this.database
        .prepare(`
          DELETE FROM send_attempts
          WHERE status = 'blocked' AND updated_at < ?
        `)
        .run(now - acceptedAuditMaxAgeMs).changes;
      const audits = this.database
        .prepare(`
          DELETE FROM send_attempts
          WHERE updated_at < ? AND status IN ('accepted', 'failed')
        `)
        .run(now - acceptedAuditMaxAgeMs).changes;
      return {
        media: Number(media),
        inboundPayloads: Number(inboundPayloads),
        sendPayloads: Number(sendPayloads),
        blockedFallbacks: Number(blockedFallbacks),
        audits: Number(audits),
      };
    });
  }

  close() {
    if (this.closed) return;
    this.#secureDatabaseFiles();
    this.database.close();
    this.closed = true;
  }
}
