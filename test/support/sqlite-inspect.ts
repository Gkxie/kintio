import type { DatabaseSync } from 'node:sqlite';

import type {
  AttemptRecord,
  JsonObject,
  SendStatus,
} from '../../src/state/sqlite-store.ts';
import type { ChatChannel } from '../../src/types.ts';

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

function json(value: string | null): JsonObject | undefined {
  if (!value) return undefined;
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as JsonObject
    : undefined;
}

function map(row: AttemptRow): AttemptRecord {
  const payload = json(row.payload_json);
  const metadata = json(row.metadata_json);
  return {
    attemptId: row.attempt_key,
    messageKey: row.source_message_key,
    openKfId: row.open_kfid,
    externalUserId: row.external_userid,
    channel: row.channel,
    replyWindowId: Number(row.reply_window_id || 0),
    sendIndex: row.send_index,
    source: row.source,
    type: row.sent_type,
    ...(payload ? { payload } : {}),
    ...(metadata ? { metadata } : {}),
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

export function inspectAttempt(
  database: DatabaseSync,
  attemptId: string,
): AttemptRecord | undefined {
  const row = database.prepare(`
    SELECT * FROM send_attempts WHERE attempt_key = ?
  `).get(attemptId) as AttemptRow | undefined;
  return row ? map(row) : undefined;
}

export function inspectAttempts(
  database: DatabaseSync,
  messageKey?: string,
): AttemptRecord[] {
  const rows = messageKey
    ? database.prepare(`
        SELECT * FROM send_attempts WHERE source_message_key = ?
        ORDER BY created_at, send_index
      `).all(messageKey)
    : database.prepare(`
        SELECT * FROM send_attempts ORDER BY created_at, send_index
      `).all();
  return (rows as unknown as AttemptRow[]).map(map);
}

export function inspectSchemaVersion(database: DatabaseSync): number {
  const row = database.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  return Number(row.user_version);
}

export function inspectPragmas(database: DatabaseSync): {
  journalMode: string;
  synchronous: number;
  foreignKeys: number;
  busyTimeout: number;
} {
  const value = (pragma: string, key: string): unknown =>
    (database.prepare(`PRAGMA ${pragma}`).get() as Record<string, unknown>)[key];
  return {
    journalMode: String(value('journal_mode', 'journal_mode')),
    synchronous: Number(value('synchronous', 'synchronous')),
    foreignKeys: Number(value('foreign_keys', 'foreign_keys')),
    busyTimeout: Number(value('busy_timeout', 'timeout')),
  };
}
