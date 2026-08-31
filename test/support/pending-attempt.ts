import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  stableClientMessageId,
  type AttemptRecord,
  type CoreState,
} from '../../src/state/sqlite-store.ts';

type JsonRecord = Record<string, unknown>;

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object' && !Buffer.isBuffer(value)) {
    return Object.fromEntries(
      Object.entries(value as JsonRecord)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function seedPendingAttempts(
  store: Pick<CoreState, 'filePath' | 'getInbound' | 'listMessageAttempts'>,
  messageKey: string,
  attempts: readonly {
    readonly sendIndex: number;
    readonly sentType: string;
    readonly payload: JsonRecord;
    readonly source?: string;
    readonly metadata?: JsonRecord;
  }[],
  { database: injectedDatabase }: { readonly database?: DatabaseSync } = {},
): AttemptRecord[] {
  const inbound = store.getInbound(messageKey);
  if (!inbound) throw new Error(`Unknown fixture inbound ${messageKey}`);
  const now = Date.now();
  const database = injectedDatabase || new DatabaseSync(store.filePath);
  const ownsDatabase = injectedDatabase === undefined;
  database.exec('PRAGMA busy_timeout = 5000');
  database.exec('PRAGMA foreign_keys = ON');
  database.exec('BEGIN IMMEDIATE');
  try {
    const insert = database.prepare(`
      INSERT INTO send_attempts (
        attempt_key, source_message_key, channel, open_kfid, external_userid,
        send_index, source, sent_type, payload_json, metadata_json,
        fingerprint, client_message_id, status, wecom_msgid,
        error_code, error_message, fail_type, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', '', '', 0, ?, ?)
    `);
    for (const attempt of attempts) {
      const payloadJson = JSON.stringify(canonical(attempt.payload));
      const index = Number(attempt.sendIndex);
      insert.run(
        `sa_${sha256(`${messageKey}\0${index}`).slice(0, 29)}`,
        messageKey,
        inbound.channel,
        inbound.accountKey,
        inbound.peerId,
        index,
        attempt.source || 'test_fixture',
        attempt.sentType,
        payloadJson,
        attempt.metadata ? JSON.stringify(canonical(attempt.metadata)) : null,
        sha256(`${attempt.sentType}\0${payloadJson}`),
        stableClientMessageId(messageKey, index),
        now,
        now,
      );
    }
    database.prepare(`
      UPDATE inbound_messages SET status = 'ready', updated_at = ?
      WHERE message_key = ?
    `).run(now, messageKey);
    database.exec('COMMIT');
  } catch (error) {
    database.exec('ROLLBACK');
    throw error;
  } finally {
    if (ownsDatabase) database.close();
  }
  return store.listMessageAttempts(messageKey);
}
