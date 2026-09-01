import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import {
  type InboundStatus,
  type CoreState,
} from '../../src/state/sqlite-store.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import type { ImageAttachment, NormalizedMessage } from '../../src/types.ts';
import { seedPendingAttempts } from '../support/pending-attempt.ts';
import { withTestDatabase } from '../support/temp-sqlite.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

function message(id: string, externalUserId = 'wm-one'): NormalizedMessage {
  return testWecomMessage({
    id,
    openKfId: 'wk-one',
    externalUserId,
  });
}

function harness(t: TestContext): {
  persistence: StatePersistence;
  store: CoreState;
  filePath: string;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-invariant-'));
  const filePath = path.join(directory, 'state.sqlite');
  const persistence = new StatePersistence({ filePath });
  const store = persistence.core;
  t.onTestFinished(() => {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { persistence, store, filePath };
}

function reopen(t: TestContext, filePath: string): CoreState {
  const persistence = new StatePersistence({ filePath });
  t.onTestFinished(() => persistence.close());
  return persistence.core;
}

function schemaVersion(filePath: string): number {
  return withTestDatabase(filePath, (database) => Number(
    (database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
  ));
}

function downgradeLoginSourcesToV22(database: DatabaseSync): void {
  database.exec(`
    DROP INDEX ilink_one_pending_offer_idx;
    DROP TABLE ilink_login_offers;
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
    DROP TABLE ilink_enrollment_audit;
    CREATE TABLE ilink_enrollment_audit (
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
  `);
}

function createLegacyDatabase(
  t: TestContext,
  version: 11 | 12 | 13,
  seed: (database: DatabaseSync) => void,
): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `sqlite-v${version}-`));
  const filePath = path.join(directory, 'state.sqlite');
  const database = new DatabaseSync(filePath);
  const inboundStatuses = version === 11
    ? "'received','processing','preparing','ready','completed','steering','steered','absorbed','failed','ignored','suppressed','held'"
    : "'received','processing','preparing','ready','completed','steering','steered','absorbed','failed','ignored','suppressed'";
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE sync_cursors (
      open_kfid TEXT PRIMARY KEY,
      cursor TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE conversations (
      open_kfid TEXT NOT NULL,
      external_userid TEXT NOT NULL,
      thread_id TEXT NOT NULL DEFAULT '',
      ${version === 11 ? `
      mode TEXT NOT NULL DEFAULT 'bot' CHECK (mode IN ('bot', 'human', 'ended')),
      automation_epoch INTEGER NOT NULL DEFAULT 0,
      servicer_userid TEXT NOT NULL DEFAULT '',
      session_source TEXT NOT NULL DEFAULT '',
      change_type INTEGER NOT NULL DEFAULT 0,
      ` : ''}
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (open_kfid, external_userid)
    ) STRICT, WITHOUT ROWID;
    CREATE TABLE authorizations (
      external_userid TEXT PRIMARY KEY,
      authorized INTEGER NOT NULL DEFAULT 0 CHECK (authorized IN (0, 1)),
      consecutive_matches INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_matches >= 0),
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
      status TEXT NOT NULL CHECK (status IN (${inboundStatuses})),
      ${version >= 13
        ? 'deferred INTEGER NOT NULL DEFAULT 0 CHECK (deferred IN (0, 1)),'
        : ''}
      primary_message_key TEXT,
      payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
      codex_turn_id TEXT NOT NULL DEFAULT '',
      client_input_id TEXT NOT NULL DEFAULT '',
      steering_boundary INTEGER NOT NULL DEFAULT 0,
      error_message TEXT NOT NULL DEFAULT '',
      ${version === 11 ? `
      context_status TEXT NOT NULL DEFAULT 'none'
        CHECK (context_status IN ('none', 'pending', 'consumed')),
      claimed_conversation_epoch INTEGER NOT NULL DEFAULT 0,
      ` : ''}
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (open_kfid, msgid),
      UNIQUE (message_key, open_kfid, external_userid),
      FOREIGN KEY (primary_message_key) REFERENCES inbound_messages(message_key)
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
        REFERENCES inbound_messages(message_key, open_kfid, external_userid)
        ON DELETE CASCADE
    ) STRICT;
    CREATE TABLE send_attempts (
      attempt_key TEXT PRIMARY KEY,
      source_message_key TEXT NOT NULL,
      open_kfid TEXT NOT NULL,
      external_userid TEXT NOT NULL,
      send_index INTEGER NOT NULL CHECK (send_index >= 0 AND send_index < 1000),
      source TEXT NOT NULL,
      sent_type TEXT NOT NULL,
      payload_json TEXT CHECK (payload_json IS NULL OR json_valid(payload_json)),
      metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
      fingerprint TEXT NOT NULL,
      client_message_id TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL CHECK (status IN ('pending','sending','accepted','failed','uncertain')),
      wecom_msgid TEXT NOT NULL DEFAULT '',
      error_code TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      fail_type INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (source_message_key, send_index),
      FOREIGN KEY (source_message_key, open_kfid, external_userid)
        REFERENCES inbound_messages(message_key, open_kfid, external_userid)
    ) STRICT;
    CREATE TABLE agent_sessions (
      token_hash TEXT PRIMARY KEY,
      source_message_key TEXT NOT NULL,
      open_kfid TEXT NOT NULL,
      external_userid TEXT NOT NULL,
      boundary_inbox_seq INTEGER NOT NULL CHECK (boundary_inbox_seq >= 0),
      ${version === 11
        ? 'conversation_epoch INTEGER NOT NULL DEFAULT 0,'
        : ''}
      media_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(media_json)),
      expires_at INTEGER NOT NULL,
      closed_at INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      FOREIGN KEY (source_message_key, open_kfid, external_userid)
        REFERENCES inbound_messages(message_key, open_kfid, external_userid)
        ON DELETE CASCADE
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
      ON inbound_messages(status, open_kfid, external_userid, inbox_seq);
    CREATE INDEX inbound_primary_idx
      ON inbound_messages(primary_message_key, inbox_seq);
    ${version >= 13
      ? 'CREATE INDEX inbound_deferred_idx ON inbound_messages(deferred, status, inbox_seq);'
      : ''}
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
    CREATE INDEX agent_session_source_idx
      ON agent_sessions(source_message_key, closed_at, expires_at);
    PRAGMA user_version = ${version};
  `);
  seed(database);
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), []);
  database.close();
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  return filePath;
}

function ingest(store: CoreState, values: readonly NormalizedMessage[]): string[] {
  return store.ingestSyncPage({
    accountKey: 'wk-one',
    expectedCursor: store.getCursor('wk-one'),
    nextCursor: `cursor-${values.map((item) => item.providerMessageId).join('-')}`,
    messages: values,
  }).insertedMessageKeys;
}

function reserveText(store: CoreState, id: string): string {
  const [messageKey] = ingest(store, [message(id)]);
  assert.ok(messageKey);
  store.claimInbound({ messageKey });
  seedPendingAttempts(store, messageKey, [{
      sendIndex: 0,
      sentType: 'text',
      payload: { msgtype: 'text', text: { content: id } },
    }]);
  return messageKey;
}

test('invalid journal mode and newer schema fail before runtime use', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-schema-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(
    () => new StatePersistence({
      filePath: path.join(directory, 'bad-mode.sqlite'),
      journalMode: 'MEMORY' as unknown as 'WAL',
    }),
    /Unsupported SQLite journal mode/u,
  );
  const futurePath = path.join(directory, 'future.sqlite');
  const future = new DatabaseSync(futurePath);
  future.exec('PRAGMA user_version = 999');
  future.close();
  assert.throws(
    () => new StatePersistence({ filePath: futurePath }),
    /newer than supported/u,
  );
  const retiredPath = path.join(directory, 'retired.sqlite');
  const retired = new DatabaseSync(retiredPath);
  retired.exec('PRAGMA user_version = 10');
  retired.close();
  assert.throws(
    () => new StatePersistence({ filePath: retiredPath }),
    /no longer supported/u,
  );
});

test('schema v11 removes retired state without losing durable facts', (t) => {
  const messageKey = 'message-one';
  const activeMessageKey = 'message-two';
  const absorbedMessageKey = 'message-three';
  const sessionToken = `ws_${'a'.repeat(32)}`;
  const filePath = createLegacyDatabase(t, 11, (database) => {
    database.prepare(`
      INSERT INTO conversations (
        open_kfid, external_userid, thread_id, mode, automation_epoch, updated_at
      ) VALUES ('wk-one', 'wm-one', '', 'human', 1, 1)
    `).run();
    const insertInbound = database.prepare(`
      INSERT INTO inbound_messages (
        inbox_seq, message_key, open_kfid, msgid, external_userid,
        origin, msg_type, sent_at, status, payload_json,
        claimed_conversation_epoch, created_at, updated_at
      ) VALUES (?, ?, 'wk-one', ?, 'wm-one', 'customer', 'text', 1, ?, ?, ?, 1, 1)
    `);
    insertInbound.run(
      1, messageKey, 'v11-preserved', 'completed', null, 1,
    );
    insertInbound.run(
      2, activeMessageKey, 'v11-active-session', 'processing',
      JSON.stringify({ id: 'v11-active-session' }), 0,
    );
    insertInbound.run(
      3, absorbedMessageKey, 'v11-absorbed-context', 'absorbed',
      JSON.stringify({ id: 'v11-absorbed-context' }), 1,
    );
    database.prepare(`
      INSERT INTO agent_sessions (
        token_hash, source_message_key, open_kfid, external_userid,
        boundary_inbox_seq, conversation_epoch, media_json,
        expires_at, closed_at, created_at, updated_at
      ) VALUES (?, ?, 'wk-one', 'wm-one', 2, 1, '[]', 9999999999999, 0, 1, 1)
    `).run(
      createHash('sha256').update(sessionToken).digest('hex'),
      activeMessageKey,
    );
    const insertAttempt = database.prepare(`
      INSERT INTO send_attempts (
        attempt_key, source_message_key, open_kfid, external_userid,
        send_index, source, sent_type, payload_json, fingerprint,
        client_message_id, status, wecom_msgid, created_at, updated_at
      ) VALUES (?, ?, 'wk-one', 'wm-one', 0, 'test', 'text', ?, ?, ?, ?, ?, 1, 1)
    `);
    insertAttempt.run(
      'legacy-v11-accepted-attempt', messageKey, null,
      'accepted-fingerprint', 'accepted-client', 'accepted', 'wx-v11-preserved',
    );
    insertAttempt.run(
      'legacy-v11-pending-attempt', activeMessageKey,
      JSON.stringify({ content: 'must not send' }),
      'pending-fingerprint', 'pending-client', 'pending', '',
    );
  });

  const upgradedPersistence = new StatePersistence({ filePath });
  const upgraded = upgradedPersistence.core;
  t.onTestFinished(() => upgradedPersistence.close());
  assert.equal(
    withTestDatabase(filePath, (database) =>
      (database.prepare('PRAGMA user_version').get() as { user_version: number })
        .user_version),
    23,
  );
  assert.throws(() => upgraded.getAgentSession(sessionToken), /closed/u);
  const inboundSql = withTestDatabase(filePath, (database) => String((database.prepare(`
      SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbound_messages'
    `).get() as { sql: string }).sql));
  assert.equal(inboundSql.includes("'held'"), false);
  assert.equal(upgraded.getInbound(absorbedMessageKey)?.payload, undefined);
  assert.equal(upgraded.getInbound(activeMessageKey)?.status, 'suppressed');
  assert.deepEqual(
    upgraded.listMessageAttempts(activeMessageKey).map((item) => ({
      status: item.status,
      errorCode: item.errorCode,
    })),
    [{ status: 'failed', errorCode: 'suppressed' }],
  );
  assert.equal(upgraded.listMessageAttempts(messageKey)[0]?.status, 'accepted');
  assert.deepEqual(upgraded.integrityCheck().map(Object.values), [['ok']]);
  assert.deepEqual(upgraded.foreignKeyCheck(), []);
});

test('schema v12 adds durable deferred priority without losing inbox rows', (t) => {
  const messageKey = 'message-one';
  const filePath = createLegacyDatabase(t, 12, (database) => {
    database.prepare(`
      INSERT INTO conversations (open_kfid, external_userid, updated_at)
      VALUES ('wk-one', 'wm-one', 1)
    `).run();
    database.prepare(`
      INSERT INTO inbound_messages (
        message_key, open_kfid, msgid, external_userid,
        origin, msg_type, status, created_at, updated_at
      ) VALUES (
        ?, 'wk-one', 'v12-priority', 'wm-one',
        'customer', 'text', 'received', 1, 1
      )
    `).run(messageKey);
  });

  const upgraded = reopen(t, filePath);
  assert.equal(schemaVersion(filePath), 23);
  assert.equal(upgraded.getInbound(messageKey)?.deferred, false);
  assert.deepEqual(upgraded.integrityCheck().map(Object.values), [['ok']]);
});

test('schema v13 adds durable archived-memory bindings', (t) => {
  const messageKey = 'legacy-v13-memory';
  const filePath = createLegacyDatabase(t, 13, (database) => {
    database.prepare(`
      INSERT INTO conversations (
        open_kfid, external_userid, thread_id, updated_at
      ) VALUES (
        'wk-one', 'wm-one',
        '01900000-0000-7000-8000-000000000002', 1
      )
    `).run();
    database.prepare(`
      INSERT INTO inbound_messages (
        message_key, open_kfid, msgid, external_userid,
        origin, msg_type, status, deferred, created_at, updated_at
      ) VALUES (
        ?, 'wk-one', 'v13-memory', 'wm-one',
        'customer', 'text', 'received', 0, 1, 1
      )
    `).run(messageKey);
  });

  const upgraded = reopen(t, filePath);
  assert.equal(schemaVersion(filePath), 23);
  assert.equal(
    upgraded.getConversation('wechat_kf', 'wk-one', 'wm-one')?.memoryThreadId,
    '',
  );
  assert.ok(upgraded.getInbound(messageKey));
  assert.deepEqual(upgraded.integrityCheck().map(Object.values), [['ok']]);
  assert.deepEqual(upgraded.foreignKeyCheck(), []);
});

test('schema v17 adds iLink invariant triggers and enrollment audit without rewriting facts', (t) => {
  const { persistence, store, filePath } = harness(t);
  const [messageKey] = ingest(store, [message('v17-ilink-invariants')]);
  assert.ok(messageKey);
  persistence.close();
  const v17 = new DatabaseSync(filePath);
  downgradeLoginSourcesToV22(v17);
  v17.exec(`
    DROP TRIGGER ilink_session_window_insert_guard;
    DROP TRIGGER ilink_session_window_update_guard;
    DROP TRIGGER ilink_attempt_window_insert_guard;
    DROP TRIGGER ilink_attempt_window_update_guard;
    DROP TRIGGER ilink_window_source_insert_guard;
    DROP TRIGGER ilink_window_source_update_guard;
    DROP TRIGGER ilink_window_delete_guard;
    DROP TABLE ilink_enrollment_audit;
    DROP TABLE ilink_inbound_images;
    PRAGMA user_version = 17;
  `);
  v17.close();

  const upgraded = reopen(t, filePath);
  assert.equal(schemaVersion(filePath), 23);
  assert.ok(upgraded.getInbound(messageKey));
  withTestDatabase(filePath, (database) => {
    assert.equal(Number((database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'trigger' AND name LIKE 'ilink_%_guard'
    `).get() as { count: number }).count), 7);
    assert.throws(() => database.prepare(`
      INSERT INTO agent_sessions (
        token_hash, source_message_key, open_kfid, external_userid,
        channel, reply_window_id, boundary_inbox_seq, memory_thread_id,
        media_json, expires_at, closed_at, created_at, updated_at
      )
      SELECT 'bad-ilink-session', message_key, open_kfid, external_userid,
             'weixin_ilink', NULL, inbox_seq, '', '[]', 9999999999999, 0, 1, 1
      FROM inbound_messages WHERE message_key = ?
    `).run(messageKey), /channel\/window mismatch/u);
  });
  assert.deepEqual(upgraded.foreignKeyCheck(), []);
});

test('schema v19 adds cleanup indexes without rewriting iLink tables', (t) => {
  const { persistence, filePath } = harness(t);
  persistence.close();
  const v19 = new DatabaseSync(filePath);
  downgradeLoginSourcesToV22(v19);
  v19.exec(`
    DROP INDEX ilink_reply_windows_expiry_idx;
    DROP INDEX ilink_reply_windows_updated_idx;
    PRAGMA user_version = 19;
  `);
  v19.close();
  const upgraded = reopen(t, filePath);
  assert.equal(schemaVersion(filePath), 23);
  assert.equal(withTestDatabase(filePath, (database) => Number((database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'ilink_reply_windows_expiry_idx', 'ilink_reply_windows_updated_idx'
      )
    `).get() as { count: number }).count)), 2);
  assert.deepEqual(upgraded.foreignKeyCheck(), []);
});

test('schema v21 drops retired binding without rewriting historical sends', (t) => {
  const { persistence, store, filePath } = harness(t);
  const [messageKey] = ingest(store, [message('v20-maintainer-removal')]);
  assert.ok(messageKey);
  seedPendingAttempts(store, messageKey, [
    {
      sendIndex: 0,
      source: 'maintainer_binding',
      sentType: 'text',
      payload: { msgtype: 'text', text: { content: 'bound' } },
    },
    {
      sendIndex: 1,
      source: 'maintainer_notify',
      sentType: 'text',
      payload: { msgtype: 'text', text: { content: 'notify' } },
    },
    {
      sendIndex: 2,
      source: 'test_fixture',
      sentType: 'text',
      payload: { msgtype: 'text', text: { content: 'preserved' } },
    },
  ]);
  const retiredAttempt = store.listMessageAttempts(messageKey)[0]!;
  const sending = store.beginNextSend('wechat_kf');
  assert.equal(sending?.attemptId, retiredAttempt.attemptId);
  store.completeSend(retiredAttempt.attemptId, {
    providerMessageId: 'retired-accepted',
  });
  withTestDatabase(filePath, (database) => {
    database.prepare(`
      INSERT INTO delivery_failures (
        wecom_msgid, fail_type, observed_at, matched_attempt_key, matched_at
      ) VALUES ('retired-notification-failure', 13, 1, ?, 1)
    `).run(retiredAttempt.attemptId);
  });
  persistence.close();

  const v20 = new DatabaseSync(filePath);
  downgradeLoginSourcesToV22(v20);
  v20.exec(`
    CREATE TABLE maintainer_binding (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      open_kfid TEXT NOT NULL,
      external_userid TEXT NOT NULL,
      bound_message_key TEXT NOT NULL,
      bound_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    ) STRICT;
  `);
  v20.prepare(`
    INSERT INTO maintainer_binding (
      singleton, open_kfid, external_userid, bound_message_key,
      bound_at, updated_at
    ) VALUES (1, 'wk-one', 'wm-one', ?, 1, 1)
  `).run(messageKey);
  v20.exec('PRAGMA user_version = 20');
  v20.close();

  const upgraded = reopen(t, filePath);
  assert.equal(schemaVersion(filePath), 23);
  assert.equal(withTestDatabase(filePath, (database) => Number((database.prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master
      WHERE type = 'table' AND name = 'maintainer_binding'
    `).get() as { count: number }).count)), 0);
  assert.deepEqual(upgraded.listMessageAttempts(messageKey).map((attempt) => ({
    source: attempt.source,
    status: attempt.status,
    errorCode: attempt.errorCode,
  })), [
    { source: 'maintainer_binding', status: 'accepted', errorCode: '' },
    { source: 'maintainer_notify', status: 'failed', errorCode: 'feature_removed' },
    { source: 'test_fixture', status: 'pending', errorCode: '' },
  ]);
  const failure = withTestDatabase(filePath, (database) => database.prepare(`
      SELECT matched_attempt_key, matched_at FROM delivery_failures
      WHERE wecom_msgid = 'retired-notification-failure'
    `).get() as { matched_attempt_key: string; matched_at: number });
  assert.deepEqual({ ...failure }, {
    matched_attempt_key: retiredAttempt.attemptId, matched_at: 1,
  });
  assert.deepEqual(upgraded.integrityCheck().map(Object.values), [['ok']]);
  assert.deepEqual(upgraded.foreignKeyCheck(), []);
});

test('schema v23 generalizes a live v22 login source without re-encrypting its QR token', (t) => {
  const { persistence, filePath } = harness(t);
  persistence.close();
  const database = new DatabaseSync(filePath);
  downgradeLoginSourcesToV22(database);
  const offerId = `qo_${'m'.repeat(20)}`;
  const generation = Number.parseInt(
    createHash('sha256').update(offerId).digest('hex').slice(0, 12),
    16,
  );
  const secretBox = new IlinkSecretBox(Buffer.alloc(32, 31).toString('base64url'));
  const sealed = secretBox.seal('migrated-qr-status-token', {
    secretKind: 'qr_token',
    accountId: 'wk-migrated-source',
    peerId: 'wm-migrated-source',
    generation,
  });
  database.prepare(`
    INSERT INTO ilink_login_offers (
      offer_id, source_message_key, source_open_kfid, source_external_userid,
      secret_generation, nonce, ciphertext, auth_tag, api_base_url,
      status, expires_at, created_at, updated_at
    ) VALUES (?, 'message-migrated-source', 'wk-migrated-source',
      'wm-migrated-source', ?, ?, ?, ?, 'https://ilinkai.weixin.qq.com/',
      'waiting', 9999999999999, 1, 1)
  `).run(offerId, generation, sealed.nonce, sealed.ciphertext, sealed.authTag);
  database.exec('PRAGMA user_version = 22');
  database.close();

  const upgraded = new StatePersistence({ filePath });
  t.onTestFinished(() => upgraded.close());
  const offers = upgraded.createIlinkLoginStore({ secretBox });
  assert.equal(schemaVersion(filePath), 23);
  assert.equal(offers.listActive()[0]?.qrCode, 'migrated-qr-status-token');
  const migratedSource = withTestDatabase(filePath, (reader) => reader.prepare(`
      SELECT initiator_kind, source_channel, source_message_key,
             source_account_id, source_peer_id
      FROM ilink_login_offers WHERE offer_id = ?
    `).get(offerId) as Record<string, unknown>);
  assert.deepEqual({ ...migratedSource }, {
    initiator_kind: 'remote_adapter',
    source_channel: 'wechat_kf',
    source_message_key: 'message-migrated-source',
    source_account_id: 'wk-migrated-source',
    source_peer_id: 'wm-migrated-source',
  });
});

test('status CHECK rejects invalid rows and filters remain parameterized', (t) => {
  const { store, filePath } = harness(t);
  withTestDatabase(filePath, (database) => {
    assert.throws(() =>
      database.prepare(`
        INSERT INTO inbound_messages (
          message_key, open_kfid, msgid, channel, origin, msg_type, status,
          created_at, updated_at
        ) VALUES (
          'bad', 'wk-one', 'bad', 'wechat_kf',
          'customer', 'text', 'bogus', 1, 1
        )
      `).run(),
    /CHECK constraint/u);
  });
  const malicious = "received') OR 1=1 --" as unknown as InboundStatus;
  assert.deepEqual(store.listPendingInbound({ statuses: [malicious] }), []);
  assert.throws(
    () => store.checkpoint('INVALID' as unknown as 'FULL'),
    /Unsupported checkpoint mode/u,
  );
});

test('steering rejects cross-conversation and non-steerable primaries', (t) => {
  const { store } = harness(t);
  const [primary, other] = ingest(store, [message('primary'), message('other', 'wm-two')]);
  assert.ok(primary && other);
  store.claimInbound({ messageKey: primary });
  assert.throws(() => store.beginInboundSteering({
    messageKey: other,
    primaryMessageKey: primary,
  }), /belong.*conversation/u);
  store.markInboundCompleted(primary);
  const [follow] = ingest(store, [message('follow')]);
  assert.ok(follow);
  assert.throws(() => store.beginInboundSteering({
    messageKey: follow,
    primaryMessageKey: primary,
  }), /not steerable/u);
});

test('every later actionable customer state invalidates an older session', (t) => {
  const { store, filePath } = harness(t);
  const [primary, later] = ingest(store, [message('primary'), message('later')]);
  assert.ok(primary && later);
  store.claimInbound({ messageKey: primary });
  const statuses: InboundStatus[] = [
    'received', 'failed', 'processing', 'preparing', 'ready',
    'completed', 'steering', 'steered', 'absorbed', 'suppressed',
  ];
  for (const status of statuses) {
    withTestDatabase(filePath, (database) => {
      database.prepare(`
        UPDATE inbound_messages SET status = ? WHERE message_key = ?
      `).run(status, later);
    });
    const session = store.createAgentSession({ messageKey: primary });
    assert.throws(() => store.reserveAgentSend({
      sessionToken: session.token,
      sentType: 'text',
      payload: { msgtype: 'text', text: { content: status } },
    }), /active conversation direction/u, status);
  }
  assert.deepEqual(store.listMessageAttempts(primary), []);
});

test('illegal inbound transitions and unknown records fail closed', (t) => {
  const { store } = harness(t);
  const [primary, steer] = ingest(store, [message('primary'), message('steer')]);
  assert.ok(primary && steer);
  assert.throws(() => store.markInboundPreparing(primary), /Cannot mark/u);
  assert.throws(() => store.confirmInboundSteered(steer), /Cannot confirm/u);
  store.claimInbound({ messageKey: primary });
  store.beginInboundSteering({ messageKey: steer, primaryMessageKey: primary });
  assert.throws(
    () => store.requeueInboundSteering(steer, 'wrong-primary'),
    /Cannot requeue/u,
  );
  assert.throws(() => store.claimInbound({ messageKey: 'missing' }), /Unknown/u);
});

test('late failures cannot overwrite suppressed ready or completed states', (t) => {
  const { store } = harness(t);
  const [suppressed, ready, completed] = ingest(store, [
    message('terminal-suppressed'), message('terminal-ready'),
    message('terminal-completed'),
  ]);
  assert.ok(suppressed && ready && completed);

  store.claimInbound({ messageKey: suppressed });
  store.suppressInbound(suppressed, 'authorization_revoked');
  store.failInbound(suppressed, new Error('late turn failure'));
  assert.equal(store.getInbound(suppressed)?.status, 'suppressed');
  assert.match(store.getInbound(suppressed)?.errorMessage || '', /authorization_revoked/u);

  store.claimInbound({ messageKey: ready });
  seedPendingAttempts(store, ready, [{
      sendIndex: 0, sentType: 'text',
      payload: { msgtype: 'text', text: { content: 'ready' } },
    }]);
  store.failInbound(ready, new Error('late turn failure'));
  assert.equal(store.getInbound(ready)?.status, 'ready');

  store.markInboundCompleted(completed);
  store.failInbound(completed, new Error('late turn failure'));
  assert.equal(store.getInbound(completed)?.status, 'completed');
});

test('MCP finalization rejects duplicate and cross-message receipts atomically', (t) => {
  const { store } = harness(t);
  const createAttempt = (id: string, peerId: string) => {
    const [messageKey] = ingest(store, [message(id, peerId)]);
    assert.ok(messageKey);
    store.claimInbound({ messageKey });
    const session = store.createAgentSession({ messageKey });
    const attempt = store.reserveAgentSend({
      sessionToken: session.token,
      sentType: 'text',
      payload: { msgtype: 'text', text: { content: id } },
    });
    store.completeSend(attempt.attemptId, {
      providerMessageId: `wx-${id}`,
    });
    store.closeAgentSession(session.token);
    return { messageKey, attempt };
  };
  const first = createAttempt('first-receipt', 'wm-one');
  const second = createAttempt('second-receipt', 'wm-two');
  assert.throws(() => store.finalizeAgentExecution({
    messageKey: first.messageKey,
    attemptIds: [second.attempt.attemptId],
  }), /does not match every terminal MCP attempt/u);
  assert.throws(() => store.finalizeAgentExecution({
    messageKey: first.messageKey,
    attemptIds: [first.attempt.attemptId, first.attempt.attemptId],
  }), /duplicate/u);
  assert.equal(store.getInbound(first.messageKey)?.status, 'processing');
  store.finalizeAgentExecution({
    messageKey: first.messageKey,
    attemptIds: [first.attempt.attemptId],
  });
  assert.equal(store.getInbound(first.messageKey)?.status, 'completed');
});

test('send terminal states cannot reverse and unknown attempts reject', (t) => {
  const { store } = harness(t);
  assert.throws(
    () => store.completeSend('missing', { providerMessageId: 'wx' }),
    /Unknown/u,
  );
  assert.throws(() => store.failSend('missing', new Error('x')), /Unknown/u);
  assert.throws(() => store.markSendUncertain('missing', new Error('x')), /Unknown/u);
  assert.equal(store.getAttempt('missing'), undefined);

  const messageKey = reserveText(store, 'terminal');
  const attempt = store.beginNextSend('wechat_kf');
  assert.ok(attempt);
  store.completeSend(attempt.attemptId, {
    providerMessageId: 'wx-terminal',
  });
  assert.equal(store.completeSend(attempt.attemptId, {
    providerMessageId: 'wx-terminal',
  }).status, 'accepted');
  assert.throws(() => store.failSend(attempt.attemptId, new Error('late')), /status accepted/u);
  assert.throws(
    () => store.markSendUncertain(attempt.attemptId, new Error('late')),
    /status accepted/u,
  );
  assert.equal(store.markSendMsgFailed({ providerMessageId: '', failType: 1 }), false);
  assert.equal(store.getInbound(messageKey)?.status, 'completed');
});

test('media writes validate owner attachment and expiry inputs', (t) => {
  const { store } = harness(t);
  const [messageKey] = ingest(store, [message('media')]);
  assert.ok(messageKey);
  assert.throws(() => store.rememberInboundMedia({
    messageKey: 'missing',
    attachments: [],
  }), /Unknown/u);
  assert.throws(() => store.rememberInboundMedia({
    messageKey,
    attachments: null as unknown as readonly ImageAttachment[],
  }), /attachments must be an array/u);
  assert.throws(() => store.rememberInboundMedia({
    messageKey,
    attachments: [{ kind: 'image', mediaId: '' }],
  }), /mediaId is required/u);
  const remembered = store.rememberInboundMedia({
    messageKey,
    attachments: [{ kind: 'image', mediaId: 'media-id', filename: 'x.png' }],
  });
  assert.equal(remembered[0]?.mediaId, 'media-id');
  assert.deepEqual(store.listRecentMedia({
    channel: 'wechat_kf', accountKey: 'wk-one', peerId: 'wm-one', maxAgeMs: -1,
  }), []);
});

test('one nonempty Codex thread belongs to exactly one conversation', (t) => {
  const { store } = harness(t);
  store.setConversationThread({
    channel: 'wechat_kf', accountKey: 'wk-one', peerId: 'wm-one',
    threadId: 'thread-shared',
  });
  assert.throws(
    () => store.setConversationThread({
      channel: 'wechat_kf', accountKey: 'wk-two', peerId: 'wm-two',
      threadId: 'thread-shared',
    }),
    /UNIQUE constraint failed/u,
  );
  assert.equal(
    store.getConversation('wechat_kf', 'wk-two', 'wm-two')?.threadId,
    undefined,
  );
});
