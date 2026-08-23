import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import {
  SqliteStore,
  type LegacyJournalEntry,
  type LegacyMessageRecord,
  type LegacySession,
  type LegacyStateSnapshot,
  stableClientMessageId,
  stableMessageKey,
} from '../src/state/sqlite-store.js';
import type { Logger } from '../src/types.js';

interface LegacyJournalRow {
  attempt_key: string;
  fingerprint: string;
  sent_type: string;
  client_message_id: string;
  status: string;
  wecom_msg_id: string;
  error_code: string;
  error_message: string;
  updated_at: number;
}

interface LegacyReceipt {
  sentType?: string;
  status?: string;
  wecomMsgId?: string;
  acceptedAt?: number;
  failedAt?: number;
  failType?: number;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function generatedMetadata(
  record: LegacyMessageRecord,
): Readonly<Record<string, unknown>> | undefined {
  for (const value of record.toolDispatches || []) {
    const dispatch = asRecord(value);
    if (dispatch?.tool !== 'send_generated_image') continue;
    return asRecord(dispatch.arguments) || {};
  }
  return undefined;
}

function legacyTextCandidates(record: LegacyMessageRecord): string[] {
  const outbound = (record.outboundMessages || []).flatMap((value) => {
    const item = asRecord(value);
    return item?.type === 'text' && typeof item.content === 'string'
      ? [item.content]
      : [];
  });
  if (outbound.length) return outbound.slice(0, 5);
  const chunks = (record.responseChunks || []).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  if (chunks.length) return chunks.slice(0, 5);
  return (record.toolDispatches || []).flatMap((value) => {
    const dispatch = asRecord(value);
    const args = asRecord(dispatch?.arguments);
    return dispatch?.tool === 'send_text' && typeof args?.content === 'string'
      ? [args.content]
      : [];
  }).slice(0, 5);
}

interface MigrationResult {
  migrated: boolean;
  reason?: 'already_migrated' | 'legacy_state_missing';
  importHash?: string;
  databaseFilePath?: string;
  backups?: string[];
  summary?: ImportSummary;
}

interface ImportSummary {
  imported: boolean;
  cursors: number;
  messages: number;
  authorizations: number;
  media: number;
  journalEntries: number;
}

interface ImportedAttempt {
  readonly messageKey: string;
  readonly openKfId: string;
  readonly externalUserId: string;
  readonly sendIndex: number;
  readonly type: string;
  readonly status: 'pending' | 'accepted' | 'failed' | 'uncertain';
  readonly source?: string;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly fingerprint?: string;
  readonly clientMessageId?: string;
  readonly attemptKey?: string;
  readonly wecomMsgId?: string;
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly failType?: number;
  readonly updatedAt: number;
}

function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object' || !('code' in error)) return '';
  return String(error.code ?? '');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sha256(parts: readonly NodeJS.ArrayBufferView[]): string {
  const hash = createHash('sha256');
  for (const part of parts) hash.update(part);
  return hash.digest('hex');
}

function readOptionalFile(filePath: string | undefined): Buffer | null {
  if (!filePath) return null;
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw error;
  }
}

function legacyAttemptIdentity(attemptKey: string): {
  openKfId: string;
  externalUserId: string;
  msgid: string;
  sendIndex: number;
  sourceMessageKey: string;
} | null {
  const parts = String(attemptKey || '').split(':');
  const sendIndex = Number(parts.pop());
  const openKfId = parts.shift() || '';
  const externalUserId = parts.shift() || '';
  const msgid = parts.join(':');
  if (
    !openKfId ||
    !externalUserId ||
    !msgid ||
    !Number.isInteger(sendIndex) ||
    sendIndex < 0 ||
    sendIndex >= 5
  ) {
    return null;
  }
  return {
    openKfId,
    externalUserId,
    msgid,
    sendIndex,
    sourceMessageKey: stableMessageKey(openKfId, msgid),
  };
}

function readLegacyJournal(filePath: string | undefined): LegacyJournalEntry[] {
  if (!filePath || !fs.existsSync(filePath)) return [];
  const database = new DatabaseSync(filePath, { readOnly: true });
  try {
    const table = database
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'send_attempts'
      `)
      .get();
    if (!table) return [];
    return (database
      .prepare('SELECT * FROM send_attempts ORDER BY updated_at, attempt_key')
      .all() as unknown as LegacyJournalRow[])
      .map((row) => {
        const identity = legacyAttemptIdentity(row.attempt_key);
        return {
          key: row.attempt_key,
          fingerprint: row.fingerprint,
          sentType: row.sent_type,
          clientMessageId: row.client_message_id,
          status: ['accepted', 'failed', 'uncertain'].includes(row.status)
            ? row.status
            : 'uncertain',
          wecomMsgId: row.wecom_msg_id || '',
          errorCode:
            row.status === 'sending'
              ? 'legacy_sending_uncertain'
              : row.error_code || '',
          errorMessage:
            row.status === 'sending'
              ? 'Legacy process stopped while send outcome was unknown'
              : row.error_message || '',
          updatedAt: row.updated_at,
          ...(identity || {}),
        };
      });
  } finally {
    database.close();
  }
}

function asReceipt(value: unknown): LegacyReceipt | null {
  return value && typeof value === 'object'
    ? value as LegacyReceipt
    : null;
}

function receiptEntries(
  state: LegacyStateSnapshot,
  journalEntries: readonly LegacyJournalEntry[],
): LegacyJournalEntry[] {
  const occupied = new Set(
    journalEntries
      .filter((entry) => entry.sourceMessageKey !== undefined)
      .map((entry) => `${entry.sourceMessageKey}:${entry.sendIndex}`),
  );
  const entries = journalEntries.map((entry) => ({ ...entry }));

  for (const [msgid, record] of Object.entries(state.messages || {})) {
    const openKfId = String(
      record?.openKfId || record?.inboundMessage?.conversation?.openKfId || '',
    );
    const externalUserId = String(
      record?.externalUserId ||
        record?.inboundMessage?.conversation?.externalUserId ||
        '',
    );
    if (!openKfId) continue;
    const sourceMessageKey = stableMessageKey(openKfId, msgid);
    const metadata = generatedMetadata(record);
    if (metadata) {
      for (const entry of entries) {
        if (entry.sourceMessageKey !== sourceMessageKey) continue;
        entry.source = 'codex_image';
        entry.metadata = metadata;
      }
    }
    const receipts = Array.isArray(record.sendReceipts)
      ? record.sendReceipts
      : [];
    for (const [sendIndex, rawReceipt] of receipts.entries()) {
      const receipt = asReceipt(rawReceipt);
      if (!receipt || sendIndex >= 5) continue;
      const identity = `${sourceMessageKey}:${sendIndex}`;
      if (occupied.has(identity)) continue;
      occupied.add(identity);
      const status = receipt.status === 'accepted' ||
        receipt.status === 'failed' ||
        receipt.status === 'uncertain'
        ? receipt.status
        : 'accepted';
      entries.push({
        key: `legacy_receipt_${createHash('sha256')
          .update(identity)
          .digest('hex')
          .slice(0, 24)}`,
        sourceMessageKey,
        openKfId,
        externalUserId,
        sendIndex,
        sentType: String(receipt.sentType || 'unknown'),
        fingerprint: createHash('sha256')
          .update(`legacy-receipt\0${identity}\0${receipt.sentType || ''}`)
          .digest('hex'),
        clientMessageId: stableClientMessageId(sourceMessageKey, sendIndex),
        status,
        wecomMsgId: String(receipt.wecomMsgId || ''),
        errorCode: receipt.status === 'failed' ? 'legacy_failed' : '',
        errorMessage: '',
        failType: Number(receipt.failType || 0),
        ...(metadata ? { source: 'codex_image', metadata } : {}),
        updatedAt: Number(
          receipt.acceptedAt || receipt.failedAt || record.updatedAt || 0,
        ),
      });
    }
  }
  return entries;
}

function existingMigration(
  targetFilePath: string,
  expectedHash?: string,
): MigrationResult | null {
  if (!fs.existsSync(targetFilePath)) return null;
  let database;
  try {
    database = new DatabaseSync(targetFilePath, { readOnly: true });
    const table = database
      .prepare(`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'schema_meta'
      `)
      .get();
    const hashRow = table
      ? database
          .prepare(`
            SELECT value FROM schema_meta WHERE key = 'legacy_import_hash'
          `)
          .get() as { value?: unknown } | undefined
      : undefined;
    const actualHashValue = hashRow?.value || '';
    const actualHash = String(actualHashValue || '');
    if (!actualHash) {
      throw new Error(
        `Target SQLite already exists without a legacy import marker: ${targetFilePath}`,
      );
    }
    if (expectedHash && actualHash !== expectedHash) {
      throw new Error(
        'Target SQLite was imported from different legacy source files',
      );
    }
    return { migrated: false, reason: 'already_migrated', importHash: actualHash };
  } finally {
    database?.close();
  }
}

function backupPath(filePath: string, timestamp: string): string {
  return `${filePath}.migrated-${timestamp}.bak`;
}

function textHash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function splitConversationKey(value: string): [string, string] | undefined {
  const separator = value.indexOf(':');
  return separator > 0
    ? [value.slice(0, separator), value.slice(separator + 1)]
    : undefined;
}

function importLegacySnapshot(
  store: SqliteStore,
  state: LegacyStateSnapshot,
  journalEntries: readonly LegacyJournalEntry[],
  importHash: string,
  source: string,
  confirmationText = '暗号确认，请继续对话',
): ImportSummary {
  const db = store.database;
  const now = Date.now();
  const keyFor = (openKfId: string, msgid: string): string =>
    stableMessageKey(openKfId || 'legacy', msgid);
  const messageKeys = new Map<string, string>();
  const lookupKey = (openKfId: string, msgid: string): string =>
    `${openKfId}\0${msgid}`;
  const ensureConversation = db.prepare(`
    INSERT INTO conversations (open_kfid, external_userid, updated_at)
    VALUES (?, ?, ?) ON CONFLICT(open_kfid, external_userid) DO NOTHING
  `);
  const insertAttempt = (attempt: ImportedAttempt): void => {
    const clientId = attempt.clientMessageId ||
      stableClientMessageId(attempt.messageKey, attempt.sendIndex);
    const payloadJson = attempt.payload ? JSON.stringify(attempt.payload) : null;
    db.prepare(`
      INSERT INTO send_attempts (
        attempt_key, source_message_key, open_kfid, external_userid,
        send_index, source, sent_type, payload_json, metadata_json,
        fingerprint, client_message_id, status, wecom_msgid,
        error_code, error_message, fail_type, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(source_message_key, send_index) DO NOTHING
    `).run(
      attempt.attemptKey || `sa_${textHash(`${attempt.messageKey}\0${attempt.sendIndex}`).slice(0, 29)}`,
      attempt.messageKey,
      attempt.openKfId,
      attempt.externalUserId,
      attempt.sendIndex,
      attempt.source || 'legacy',
      attempt.type,
      payloadJson,
      attempt.metadata ? JSON.stringify(attempt.metadata) : null,
      attempt.fingerprint || textHash(`${attempt.type}\0${payloadJson || ''}`),
      clientId,
      attempt.status,
      attempt.wecomMsgId || '',
      attempt.errorCode || '',
      attempt.errorMessage || '',
      attempt.failType || 0,
      attempt.updatedAt,
      attempt.updatedAt,
    );
  };

  db.exec('BEGIN IMMEDIATE');
  try {
    for (const [openKfId, cursor] of Object.entries(state.cursors || {})) {
      db.prepare(`
        INSERT INTO sync_cursors (open_kfid, cursor, updated_at) VALUES (?, ?, ?)
      `).run(openKfId, cursor, now);
    }
    const conversations = new Map<string, {
      openKfId: string;
      externalUserId: string;
      threadId: string;
      session?: LegacySession;
    }>();
    for (const [key, threadId] of Object.entries(state.threads || {})) {
      const parts = splitConversationKey(key);
      if (parts) conversations.set(key, {
        openKfId: parts[0], externalUserId: parts[1], threadId,
      });
    }
    for (const [key, session] of Object.entries(state.sessions || {})) {
      const parts = splitConversationKey(key);
      if (!parts) continue;
      const prior = conversations.get(key);
      conversations.set(key, {
        openKfId: parts[0], externalUserId: parts[1],
        threadId: prior?.threadId || '', session,
      });
    }
    for (const item of conversations.values()) {
      const mode = item.session?.mode;
      db.prepare(`
        INSERT INTO conversations (
          open_kfid, external_userid, thread_id, mode, servicer_userid,
          session_source, change_type, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        item.openKfId, item.externalUserId, item.threadId,
        mode === 'human' || mode === 'ended' ? mode : 'bot',
        item.session?.servicerUserId || '', item.session?.source || '',
        item.session?.changeType || 0, item.session?.updatedAt || now,
      );
    }
    for (const [externalUserId, authorization] of Object.entries(
      state.customerAuthorizations || {},
    )) {
      const openKfId = authorization.openKfId || '';
      db.prepare(`
        INSERT INTO authorizations (
          external_userid, authorized, consecutive_matches, last_open_kfid,
          last_message_key, authorized_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        externalUserId, authorization.authorized ? 1 : 0,
        authorization.consecutiveMatches || 0, openKfId,
        authorization.lastMessageId && openKfId
          ? keyFor(openKfId, authorization.lastMessageId) : '',
        authorization.authorizedAt || 0, authorization.updatedAt || now,
      );
    }

    const statuses: Record<string, string> = {
      sent: 'completed', ignored: 'ignored', absorbed: 'absorbed', failed: 'failed',
      processing: 'processing', steered: 'steered', generated: 'ready',
      authorization_pending: 'ready',
    };
    for (const [msgid, record] of Object.entries(state.messages || {})) {
      const openKfId = record.openKfId ||
        record.inboundMessage?.conversation?.openKfId || 'legacy';
      const externalUserId = record.externalUserId ||
        record.inboundMessage?.conversation?.externalUserId || '';
      const messageKey = keyFor(openKfId, msgid);
      messageKeys.set(lookupKey(openKfId, msgid), messageKey);
      const status = statuses[record.status || ''] || 'failed';
      db.prepare(`
        INSERT INTO inbound_messages (
          message_key, open_kfid, msgid, external_userid, origin, msg_type,
          sent_at, status, payload_json, error_message, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        messageKey, openKfId, msgid, externalUserId,
        record.inboundMessage?.origin || 'legacy',
        record.inboundMessage?.type || 'legacy',
        record.inboundMessage?.sentAt || record.updatedAt || 0, status,
        status === 'processing' || status === 'steered'
          ? JSON.stringify(record.inboundMessage) : null,
        record.errorMessage || '', record.updatedAt || now, record.updatedAt || now,
      );
      ensureConversation.run(openKfId, externalUserId, now);
    }
    for (const [msgid, record] of Object.entries(state.messages || {})) {
      if (!record.primaryMessageId) continue;
      const openKfId = record.openKfId ||
        record.inboundMessage?.conversation?.openKfId || 'legacy';
      const child = messageKeys.get(lookupKey(openKfId, msgid));
      const primary = messageKeys.get(lookupKey(openKfId, record.primaryMessageId));
      if (child && primary) {
        db.prepare(`UPDATE inbound_messages SET primary_message_key = ? WHERE message_key = ?`)
          .run(primary, child);
      }
    }

    for (const [conversationKey, entries] of Object.entries(state.inboundMedia || {})) {
      const parts = splitConversationKey(conversationKey);
      if (!parts) continue;
      entries.forEach((entry, position) => {
        const msgid = entry.messageId || `legacy-media-${position}`;
        const messageKey = messageKeys.get(lookupKey(parts[0], msgid)) || keyFor(parts[0], msgid);
        if (!messageKeys.has(lookupKey(parts[0], msgid))) {
          db.prepare(`
            INSERT INTO inbound_messages (
              message_key, open_kfid, msgid, external_userid, origin,
              msg_type, status, created_at, updated_at
            ) VALUES (?, ?, ?, ?, 'legacy', 'image', 'completed', ?, ?)
          `).run(messageKey, parts[0], msgid, parts[1], now, now);
        }
        db.prepare(`
          INSERT INTO inbound_media (
            message_key, open_kfid, external_userid, position, kind,
            media_id, filename, sent_at, remembered_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          messageKey, parts[0], parts[1], position, entry.kind || 'image',
          entry.mediaId || '', entry.filename || '', entry.sentAt || 0,
          entry.rememberedAt || now,
        );
      });
    }

    for (const entry of journalEntries) {
      const sendIndex = Number.isInteger(entry.sendIndex) && entry.sendIndex! >= 0 &&
        entry.sendIndex! < 5 ? entry.sendIndex! : 0;
      const legacyKey = entry.key || entry.attemptKey || 'legacy';
      const messageKey = entry.sourceMessageKey || `legacy_${textHash(legacyKey)}`;
      let source = db.prepare(`
        SELECT open_kfid, external_userid FROM inbound_messages WHERE message_key = ?
      `).get(messageKey) as { open_kfid: string; external_userid: string } | undefined;
      if (!source) {
        source = {
          open_kfid: entry.openKfId || 'legacy',
          external_userid: entry.externalUserId || 'legacy',
        };
        const msgid = entry.msgid || `legacy-attempt-${textHash(legacyKey).slice(0, 24)}`;
        db.prepare(`
          INSERT INTO inbound_messages (
            message_key, open_kfid, msgid, external_userid, origin, msg_type,
            status, error_message, created_at, updated_at
          ) VALUES (?, ?, ?, ?, 'legacy', 'legacy_send', 'completed',
            'Placeholder for an unassociated legacy send attempt', ?, ?)
        `).run(messageKey, source.open_kfid, msgid, source.external_userid,
          entry.updatedAt || now, entry.updatedAt || now);
      }
      ensureConversation.run(source.open_kfid, source.external_userid, now);
      const status = entry.status === 'accepted' || entry.status === 'failed' ||
        entry.status === 'uncertain' ? entry.status : 'uncertain';
      insertAttempt({
        messageKey, openKfId: source.open_kfid,
        externalUserId: source.external_userid, sendIndex,
        type: entry.sentType || 'unknown', status,
        ...(entry.source ? { source: entry.source } : {}),
        ...(entry.metadata ? { metadata: entry.metadata } : {}),
        ...(entry.fingerprint ? { fingerprint: entry.fingerprint } : {}),
        ...(entry.clientMessageId ? { clientMessageId: entry.clientMessageId } : {}),
        attemptKey: legacyKey,
        ...(entry.wecomMsgId ? { wecomMsgId: entry.wecomMsgId } : {}),
        ...(entry.errorCode ? { errorCode: entry.errorCode } : {}),
        ...(entry.errorMessage ? { errorMessage: entry.errorMessage } : {}),
        ...(entry.failType ? { failType: entry.failType } : {}),
        updatedAt: entry.updatedAt || now,
      });
    }

    for (const [msgid, record] of Object.entries(state.messages || {})) {
      if (record.status !== 'authorization_pending' && record.status !== 'generated') continue;
      const openKfId = record.openKfId ||
        record.inboundMessage?.conversation?.openKfId || 'legacy';
      const externalUserId = record.externalUserId ||
        record.inboundMessage?.conversation?.externalUserId || '';
      const messageKey = keyFor(openKfId, msgid);
      let count = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM send_attempts WHERE source_message_key = ?
      `).get(messageKey) as { count: number }).count);
      if (!count && record.status === 'authorization_pending') {
        const uncertain = Number(record.sentChunks || 0) > 0;
        insertAttempt({
          messageKey, openKfId, externalUserId, sendIndex: 0,
          source: 'authorization', type: 'text',
          payload: { msgtype: 'text', text: { content: confirmationText } },
          status: uncertain ? 'uncertain' : 'pending', updatedAt: now,
          ...(uncertain ? {
            errorCode: 'legacy_send_uncertain',
            errorMessage: 'Legacy confirmation may already have been sent',
          } : {}),
        });
        count = 1;
      }
      let unrecoverable = false;
      if (record.status === 'generated') {
        const texts = legacyTextCandidates(record);
        const expectedCount = record.outboundMessages?.length ||
          record.responseChunks?.length || record.toolDispatches?.length || 0;
        const sentChunks = Math.max(0, Number(record.sentChunks || 0));
        const existingIndexes = new Set(
          (db.prepare(`
            SELECT send_index FROM send_attempts WHERE source_message_key = ?
          `).all(messageKey) as { send_index: number }[])
            .map((row) => Number(row.send_index)),
        );
        texts.forEach((content, sendIndex) => {
          if (existingIndexes.has(sendIndex)) return;
          const uncertain = sendIndex < sentChunks;
          insertAttempt({
            messageKey, openKfId, externalUserId, sendIndex,
            type: 'text', status: uncertain ? 'uncertain' : 'pending',
            updatedAt: now,
            payload: { msgtype: 'text', text: { content } },
            ...(uncertain ? {
              errorCode: 'legacy_send_uncertain',
              errorMessage: 'Legacy chunk may already have been sent',
            } : {}),
          });
        });
        count = Number((db.prepare(`
          SELECT COUNT(*) AS count FROM send_attempts WHERE source_message_key = ?
        `).get(messageKey) as { count: number }).count);
        unrecoverable = expectedCount > texts.length;
      }
      const pending = Number((db.prepare(`
        SELECT COUNT(*) AS count FROM send_attempts
        WHERE source_message_key = ? AND status = 'pending'
      `).get(messageKey) as { count: number }).count) > 0;
      db.prepare(`
        UPDATE inbound_messages SET status = ?, error_message = ?, updated_at = ?
        WHERE message_key = ?
      `).run(
        unrecoverable ? 'failed' : pending ? 'ready' : count ? 'completed' : 'failed',
        unrecoverable
          ? 'legacy_unrecoverable: remaining outbound payload cannot be reconstructed'
          : count ? '' : 'legacy_unrecoverable: no exact outbound payload',
        now, messageKey,
      );
    }

    db.prepare(`
      INSERT INTO schema_meta (key, value, updated_at)
      VALUES ('legacy_import_hash', ?, ?), ('legacy_import_source', ?, ?)
    `).run(importHash, now, source, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return {
    imported: true,
    cursors: Object.keys(state.cursors || {}).length,
    messages: Object.keys(state.messages || {}).length,
    authorizations: Object.keys(state.customerAuthorizations || {}).length,
    media: Object.values(state.inboundMedia || {}).flat().length,
    journalEntries: journalEntries.length,
  };
}

export function migrateLegacyState({
  jsonFilePath,
  journalFilePath,
  pauseFilePath,
  databaseFilePath,
  backupSources = true,
  clock = Date.now,
  logger = console,
}: {
  jsonFilePath: string;
  journalFilePath?: string;
  pauseFilePath?: string;
  databaseFilePath: string;
  backupSources?: boolean;
  clock?: () => number;
  logger?: Logger;
}): MigrationResult {
  if (!jsonFilePath || !databaseFilePath) {
    throw new Error('jsonFilePath and databaseFilePath are required');
  }
  const jsonBytes = readOptionalFile(jsonFilePath);
  if (!jsonBytes) {
    const prior = existingMigration(databaseFilePath);
    if (prior) return prior;
    return { migrated: false, reason: 'legacy_state_missing' };
  }
  const journalBytes = readOptionalFile(journalFilePath) || Buffer.alloc(0);
  const pauseBytes = readOptionalFile(pauseFilePath);
  const importHash = sha256([
    Buffer.from('wechat-bot-legacy-v1\0'),
    jsonBytes,
    Buffer.from('\0journal\0'),
    journalBytes,
    Buffer.from('\0pause\0'),
    pauseBytes ?? Buffer.from('absent'),
  ]);
  const prior = existingMigration(databaseFilePath, importHash);
  if (prior) return prior;

  let state;
  try {
    const parsed: unknown = JSON.parse(jsonBytes.toString('utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('legacy state root must be an object');
    }
    state = parsed as LegacyStateSnapshot;
  } catch (error) {
    throw new Error(`Unable to parse legacy JSON state: ${errorMessage(error)}`);
  }
  if (Number(state.version || 0) !== 1) {
    throw new Error(`Unsupported legacy JSON state version: ${state.version}`);
  }

  const journalEntries = receiptEntries(
    state,
    readLegacyJournal(journalFilePath),
  );
  const target = path.resolve(databaseFilePath);
  const targetDirectory = path.dirname(target);
  fs.mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
  const temporaryPath = path.join(
    targetDirectory,
    `.${path.basename(target)}.migration-${process.pid}-${randomUUID()}.tmp`,
  );
  let store;
  let summary;

  try {
    store = new SqliteStore({
      filePath: temporaryPath,
      journalMode: 'DELETE',
      clock,
    });
    summary = importLegacySnapshot(
      store,
      state,
      journalEntries,
      importHash,
      [jsonFilePath, journalFilePath, pauseFilePath].filter(Boolean).join(','),
    );
    if (pauseBytes) store.setRuntimePaused(true);
    const integrity = store.integrityCheck();
    const foreignKeys = store.foreignKeyCheck();
    if (
      integrity.length !== 1 ||
      integrity[0]?.integrity_check !== 'ok' ||
      foreignKeys.length !== 0
    ) {
      throw new Error('Migrated SQLite failed integrity or foreign-key checks');
    }
    store.checkpoint('TRUNCATE');
    store.close();
    store = null;
    fs.chmodSync(temporaryPath, 0o600);
    fs.renameSync(temporaryPath, target);
  } catch (error) {
    store?.close();
    for (const candidate of [
      temporaryPath,
      `${temporaryPath}-wal`,
      `${temporaryPath}-shm`,
    ]) {
      try {
        fs.unlinkSync(candidate);
      } catch (cleanupError) {
        if (errorCode(cleanupError) !== 'ENOENT') {
          logger.warn?.(errorMessage(cleanupError));
        }
      }
    }
    throw error;
  }

  const backups = [];
  if (backupSources) {
    const timestamp = new Date(Number(clock())).toISOString().replace(/[:.]/g, '-');
    for (const sourcePath of [jsonFilePath, journalFilePath, pauseFilePath]) {
      if (!sourcePath || !fs.existsSync(sourcePath)) continue;
      const destination = backupPath(sourcePath, timestamp);
      try {
        fs.renameSync(sourcePath, destination);
        backups.push(destination);
      } catch (error) {
        logger.warn?.(
          `[migration] SQLite is installed, but legacy backup rename failed for ${sourcePath}: ${errorMessage(error)}`,
        );
      }
    }
  }

  return {
    migrated: true,
    importHash,
    databaseFilePath: target,
    backups,
    summary,
  };
}

import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const config = loadConfig();
  const result = migrateLegacyState({
    jsonFilePath: config.state.legacyStateFile,
    journalFilePath: config.state.legacyJournalFile,
    pauseFilePath: config.state.legacyPauseFile,
    databaseFilePath: config.state.databaseFile,
  });
  process.stdout.write(result.migrated
    ? `legacy state migrated to ${config.state.databaseFile}\n`
    : `migration skipped: ${result.reason || 'already complete'}\n`);
}
