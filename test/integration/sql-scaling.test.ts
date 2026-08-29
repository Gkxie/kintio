import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { describe, test } from 'vitest';

import {
  SqliteStore,
  stableMessageKey,
} from '../../src/state/sqlite-store.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';
import { seedPendingAttempts } from '../support/pending-attempt.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

const historySizes = [100, 10_000, 100_000] as const;
type SqlInputValue = null | number | bigint | string | Uint8Array;

interface ChangeProfile {
  readonly ingest: number;
  readonly thread: number;
  readonly claim: number;
  readonly finalize: number;
  readonly beginSend: number;
  readonly completeSend: number;
}

function totalChanges(database: DatabaseSync): number {
  const row = database.prepare('SELECT total_changes() AS value').get() as {
    value: number;
  };
  return Number(row.value);
}

function changeDelta(database: DatabaseSync, operation: () => void): number {
  const before = totalChanges(database);
  operation();
  return totalChanges(database) - before;
}

function seedHistory(database: DatabaseSync, size: number): void {
  database.prepare(`
    WITH RECURSIVE sequence(value) AS (
      VALUES (1)
      UNION ALL
      SELECT value + 1 FROM sequence WHERE value < ?
    )
    INSERT INTO inbound_messages (
      message_key, open_kfid, msgid, external_userid, origin, msg_type,
      sent_at, status, payload_json, created_at, updated_at
    )
    SELECT
      'history-message-' || printf('%06d', value),
      'wk-history',
      'history-msgid-' || printf('%06d', value),
      'wm-history-' || printf('%06d', value),
      'customer', 'text', value, 'completed', NULL, value, value
    FROM sequence
  `).run(size);
  database.prepare(`
    INSERT INTO send_attempts (
      attempt_key, source_message_key, open_kfid, external_userid,
      send_index, source, sent_type, payload_json, metadata_json,
      fingerprint, client_message_id, status,
      wecom_msgid, error_code, error_message, fail_type, created_at, updated_at
    )
    SELECT
      'history-attempt-' || printf('%06d', inbox_seq),
      message_key, open_kfid, external_userid,
      0, 'history', 'text', NULL, NULL,
      'fingerprint-' || printf('%06d', inbox_seq),
      'client-' || printf('%06d', inbox_seq), 'accepted',
      'wecom-' || printf('%06d', inbox_seq), '', '', 0, created_at, updated_at
    FROM inbound_messages
    WHERE open_kfid = 'wk-history'
  `).run();
}

function planDetails(
  database: DatabaseSync,
  sql: string,
  parameters: readonly SqlInputValue[],
): string[] {
  return database
    .prepare(`EXPLAIN QUERY PLAN ${sql}`)
    .all(...parameters)
    .map((row) => String((row as { detail: unknown }).detail));
}

function assertUsesIndex(details: readonly string[], indexName: string): void {
  assert.ok(
    details.some((detail) => detail.includes(indexName)),
    `Expected query plan to use ${indexName}:\n${details.join('\n')}`,
  );
}

describe.each(historySizes)('%i history rows', (size) => {
  test('critical row operations have constant changes and indexed plans at 100, 10k, and 100k history', async (t) => {
      const temporary = await createTempSqlite(t, {
        prefix: `wechat-sql-scale-${size}-`,
        filename: 'wecom.sqlite',
      });
      const store = new SqliteStore({ filePath: temporary.filePath });
      t.onTestFinished(() => store.close());
      seedHistory(store.database, size);

      const openKfId = `wk-target-${size}`;
      const externalUserId = `wm-target-${size}`;
      const msgid = `target-${size}`;
      const messageKey = stableMessageKey(openKfId, msgid);
      let attemptId = '';

      const profile: ChangeProfile = {
        ingest: changeDelta(store.database, () => {
          store.ingestSyncPage({
            openKfId,
            nextCursor: `cursor-${size}`,
            messages: [testWecomMessage({
              id: msgid,
              openKfId,
              externalUserId,
              sentAt: size,
              text: 'constant update',
            })],
          });
        }),
        thread: changeDelta(store.database, () => {
          store.setConversationThread({
            openKfId,
            externalUserId,
            threadId: `thread-${size}`,
          });
        }),
        claim: changeDelta(store.database, () => {
          store.claimInbound({ messageKey });
        }),
        finalize: changeDelta(store.database, () => {
          const finalized = seedPendingAttempts(store, messageKey, [{
              sendIndex: 0,
              source: 'codex_tool',
              sentType: 'text',
              payload: { msgtype: 'text', text: { content: 'constant send' } },
            }]);
          attemptId = finalized[0]?.attemptId || '';
          assert.ok(attemptId);
        }),
        beginSend: changeDelta(store.database, () => {
          assert.equal(store.beginNextSend()?.attemptId, attemptId);
        }),
        completeSend: changeDelta(store.database, () => {
          store.completeSend(attemptId, { wecomMsgId: `wecom-target-${size}` });
        }),
      };
      assert.deepEqual(profile, {
        ingest: 3,
        thread: 1,
        claim: 1,
        finalize: 2,
        beginSend: 1,
        completeSend: 2,
      });

      store.database.exec('ANALYZE');
      assertUsesIndex(
        planDetails(
          store.database,
          'SELECT * FROM inbound_messages WHERE message_key = ?',
          [messageKey],
        ),
        'sqlite_autoindex_inbound_messages_1',
      );
      assertUsesIndex(
        planDetails(
          store.database,
          `SELECT * FROM inbound_messages
           WHERE status IN (?) AND open_kfid = ? AND external_userid = ?
           ORDER BY inbox_seq LIMIT ?`,
          ['received', openKfId, externalUserId, 100],
        ),
        'inbound_pending_idx',
      );
      assertUsesIndex(
        planDetails(
          store.database,
          `SELECT * FROM send_attempts
           WHERE status = 'pending'
           ORDER BY created_at, send_index LIMIT 100`,
          [],
        ),
        'send_status_idx',
      );
      assertUsesIndex(
        planDetails(
          store.database,
          `SELECT * FROM send_attempts
           WHERE open_kfid = ? AND external_userid = ?
             AND status IN ('accepted', 'failed', 'uncertain')
           ORDER BY updated_at DESC LIMIT ?`,
          ['wk-history', 'wm-history-000001', 20],
        ),
        'send_conversation_idx',
      );
  });
});
