import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test, type TestContext } from 'vitest';

import { StatePersistence } from '../../src/state/persistence.ts';
import {
  SqliteStore,
  stableMessageKey,
} from '../../src/state/sqlite-store.ts';
import type { NormalizedMessage } from '../../src/types.ts';

const V21_FIXTURE = fs.readFileSync(
  new URL('../fixtures/state-v21.sql', import.meta.url),
  'utf8',
);
const ACCOUNT_KEY = 'ia_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const PEER_ID = 'shared-peer';
const WECHAT_KEY = 'legacy-wechat-message-key';
const ILINK_KEY = 'legacy-ilink-message-key';
const SESSION_TOKEN = `ws_${'s'.repeat(32)}`;

function createV21Database(t: TestContext, name: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), `${name}-`));
  const filePath = path.join(directory, 'state.sqlite');
  const database = new DatabaseSync(filePath);
  database.exec(V21_FIXTURE);
  database.close();
  t.onTestFinished(() => {
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return filePath;
}

function pragmaNumber(database: DatabaseSync, pragma: string): number {
  const row = database.prepare(`PRAGMA ${pragma}`).get() as
    | Record<string, number>
    | undefined;
  return Number(row ? Object.values(row)[0] : 0);
}

function schemaSnapshot(database: DatabaseSync): string {
  return JSON.stringify(database.prepare(`
    SELECT type, name, sql FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%'
    ORDER BY type, name
  `).all());
}

function tableNames(database: DatabaseSync): string[] {
  return (database.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: string }>).map(({ name }) => name);
}

function foreignKeyColumns(
  database: DatabaseSync,
  table: 'agent_sessions' | 'inbound_media' | 'send_attempts',
): Set<string> {
  const rows = database.prepare(`PRAGMA foreign_key_list(${table})`).all() as
    Array<{ table: string; from: string; to: string }>;
  return new Set(rows.map((row) => `${row.table}:${row.from}->${row.to}`));
}

function replayedWechatMessage(): NormalizedMessage {
  return {
    providerMessageId: 'wechat-provider-message',
    origin: 'customer',
    type: 'text',
    rawType: 'text',
    sentAt: 100,
    sync: { cursor: 'replay', index: 0 },
    conversation: {
      channel: 'wechat_kf',
      accountKey: ACCOUNT_KEY,
      peerId: PEER_ID,
    },
    text: 'replayed WeChat',
    summary: 'replayed WeChat',
    attributes: {},
    attachments: [],
  };
}

test('a frozen real v21 database migrates to v22 without rewriting durable identity', (t) => {
  const filePath = createV21Database(t, 'kintio-real-v21');
  const before = new DatabaseSync(filePath, { readOnly: true });
  assert.equal(pragmaNumber(before, 'user_version'), 21);
  const legacyConversationSql = String((before.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'conversations'
  `).get() as { sql: string }).sql);
  const legacyInboundSql = String((before.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbound_messages'
  `).get() as { sql: string }).sql);
  assert.match(legacyConversationSql, /PRIMARY KEY \(open_kfid, external_userid\)/u);
  assert.doesNotMatch(legacyConversationSql, /\bchannel\b/u);
  assert.match(legacyInboundSql, /UNIQUE \(open_kfid, msgid\)/u);
  assert.equal(
    String((before.prepare(`
      SELECT media_json FROM agent_sessions LIMIT 1
    `).get() as { media_json: string }).media_json).includes('openKfId'),
    true,
  );
  before.close();

  const persistence = new StatePersistence({
    filePath,
    journalMode: 'DELETE',
  });
  t.onTestFinished(() => persistence.close());
  const store = persistence.core;
  const ilink = persistence.createIlinkStore();
  const migrated = new DatabaseSync(filePath, { readOnly: true });
  t.onTestFinished(() => migrated.close());

  assert.equal(pragmaNumber(migrated, 'user_version'), 22);
  assert.deepEqual(
    migrated.prepare('PRAGMA integrity_check').all().map(Object.values),
    [['ok']],
  );
  assert.deepEqual(migrated.prepare('PRAGMA foreign_key_check').all(), []);
  const durableCounts = Object.fromEntries([
    'agent_sessions',
    'authorizations',
    'conversations',
    'ilink_account_secrets',
    'ilink_accounts',
    'ilink_inbound_images',
    'ilink_reply_window_secrets',
    'ilink_reply_windows',
    'inbound_media',
    'inbound_messages',
    'send_attempts',
    'sync_cursors',
  ].map((table) => [
    table,
    Number((migrated.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
      count: number;
    }).count),
  ]));
  assert.deepEqual(durableCounts, {
    agent_sessions: 1,
    authorizations: 1,
    conversations: 2,
    ilink_account_secrets: 1,
    ilink_accounts: 1,
    ilink_inbound_images: 1,
    ilink_reply_window_secrets: 1,
    ilink_reply_windows: 1,
    inbound_media: 2,
    inbound_messages: 2,
    send_attempts: 1,
    sync_cursors: 1,
  });
  assert.deepEqual(
    (migrated.prepare(`
      SELECT inbox_seq, message_key, channel, primary_message_key, status,
             codex_turn_id, client_input_id, steering_boundary
      FROM inbound_messages ORDER BY inbox_seq
    `).all() as Array<Record<string, unknown>>).map((row) => ({ ...row })),
    [
      {
        inbox_seq: 1,
        message_key: WECHAT_KEY,
        channel: 'wechat_kf',
        primary_message_key: null,
        status: 'processing',
        codex_turn_id: 'legacy-turn-wechat',
        client_input_id: 'legacy-client-wechat',
        steering_boundary: 0,
      },
      {
        inbox_seq: 2,
        message_key: ILINK_KEY,
        channel: 'weixin_ilink',
        primary_message_key: null,
        status: 'received',
        codex_turn_id: '',
        client_input_id: '',
        steering_boundary: 0,
      },
    ],
  );
  assert.notEqual(
    WECHAT_KEY,
    stableMessageKey('wechat_kf', ACCOUNT_KEY, 'wechat-provider-message'),
  );
  assert.notEqual(
    ILINK_KEY,
    stableMessageKey('weixin_ilink', ACCOUNT_KEY, 'ilink-provider-message'),
  );

  const replay = store.insertInboundMessages({
    accountKey: ACCOUNT_KEY,
    entries: [{ message: replayedWechatMessage() }],
  });
  assert.deepEqual(replay, [{ messageKey: WECHAT_KEY, inboxSeq: 1, inserted: false }]);
  assert.equal(
    Number((migrated.prepare('SELECT COUNT(*) AS count FROM inbound_messages').get() as {
      count: number;
    }).count),
    2,
  );

  const wechat = store.getInbound(WECHAT_KEY)!;
  assert.equal(wechat.providerMessageId, 'wechat-provider-message');
  assert.equal(Object.hasOwn(wechat.payload || {}, 'id'), false);
  assert.equal(Object.hasOwn(wechat.payload || {}, 'messageKey'), false);
  assert.deepEqual(wechat.payload?.conversation, {
    channel: 'wechat_kf',
    accountKey: ACCOUNT_KEY,
    peerId: PEER_ID,
  });

  assert.deepEqual(store.getConversation('wechat_kf', ACCOUNT_KEY, PEER_ID), {
    channel: 'wechat_kf',
    accountKey: ACCOUNT_KEY,
    peerId: PEER_ID,
    threadId: '',
    memoryThreadId: '',
    updatedAt: 250,
  });
  assert.deepEqual(store.getConversation('weixin_ilink', ACCOUNT_KEY, PEER_ID), {
    channel: 'weixin_ilink',
    accountKey: ACCOUNT_KEY,
    peerId: PEER_ID,
    threadId: '01900000-0000-7000-8000-00000000aa01',
    memoryThreadId: '01900000-0000-7000-8000-00000000aa02',
    updatedAt: 250,
  });

  assert.deepEqual(
    store.listRecentMedia({
      channel: 'wechat_kf',
      accountKey: ACCOUNT_KEY,
      peerId: PEER_ID,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
    }).map(({ channel, messageKey, mediaId }) => ({ channel, messageKey, mediaId })),
    [{ channel: 'wechat_kf', messageKey: WECHAT_KEY, mediaId: 'wechat-media' }],
  );
  assert.deepEqual(
    store.listRecentMedia({
      channel: 'weixin_ilink',
      accountKey: ACCOUNT_KEY,
      peerId: PEER_ID,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
    }).map(({ channel, messageKey, mediaId }) => ({ channel, messageKey, mediaId })),
    [{ channel: 'weixin_ilink', messageKey: ILINK_KEY, mediaId: 'ilink-media' }],
  );

  const attempt = store.listMessageAttempts(ILINK_KEY);
  assert.deepEqual(attempt.map((item) => ({
    attemptId: item.attemptId,
    channel: item.channel,
    accountKey: item.accountKey,
    peerId: item.peerId,
    providerMessageId: item.providerMessageId,
  })), [{
    attemptId: 'legacy-ilink-attempt',
    channel: 'weixin_ilink',
    accountKey: ACCOUNT_KEY,
    peerId: PEER_ID,
    providerMessageId: 'legacy-provider-send',
  }]);

  const session = store.getAgentSession(SESSION_TOKEN);
  assert.deepEqual(session.mediaCatalog, [{
    ref: 'media:0',
    messageKey: WECHAT_KEY,
    kind: 'image',
    mediaId: 'wechat-media',
    filename: 'wechat.png',
    sentAt: 100,
    rememberedAt: 110,
    channel: 'wechat_kf',
    accountKey: ACCOUNT_KEY,
    peerId: PEER_ID,
  }]);
  assert.equal(Object.hasOwn(session.mediaCatalog[0] || {}, 'openKfId'), false);
  assert.equal(Object.hasOwn(session.mediaCatalog[0] || {}, 'externalUserId'), false);

  assert.deepEqual(ilink.getReplyWindow(7), {
    replyWindowId: 7,
    accountKey: ACCOUNT_KEY,
    peerId: PEER_ID,
    accountGeneration: 1,
    sourceMessageKey: ILINK_KEY,
    sourceInboxSeq: 2,
    issuedAt: 200,
    expiresAt: 86400200,
    maxSends: 10,
    nextSendIndex: 1,
    reservedSendCount: 0,
    transmittedSendCount: 1,
    state: 'open',
    createdAt: 200,
    updatedAt: 230,
  });
  assert.equal(ilink.getReplyWindowSecret(7)?.sealedContextToken.ciphertext, 'Aw');
  assert.equal(ilink.getInboundImageSecret(ILINK_KEY, 0)?.sealedLocator.ciphertext, 'Ag');
  assert.equal(store.getCursor(ACCOUNT_KEY), 'legacy-wechat-cursor');
  assert.equal(store.getAuthorization(PEER_ID)?.lastMessageKey, WECHAT_KEY);
  assert.equal(ilink.getAccount(ACCOUNT_KEY)?.providerAccountId, 'fixture-bot@im.bot');
  assert.equal(ilink.getAccountSecret(ACCOUNT_KEY)?.sealedBotToken.ciphertext, 'AQ');

  const expectedIndexes = [
    'agent_session_source_idx',
    'conversation_thread_idx',
    'inbound_deferred_idx',
    'inbound_pending_idx',
    'inbound_primary_idx',
    'media_conversation_idx',
    'send_conversation_idx',
    'send_status_idx',
    'send_wecom_msgid_idx',
  ];
  assert.deepEqual(
    (migrated.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (${expectedIndexes.map(() => '?').join(',')})
      ORDER BY name
    `).all(...expectedIndexes) as Array<{ name: string }>).map(({ name }) => name),
    [...expectedIndexes].sort(),
  );
  for (const table of ['inbound_media', 'send_attempts', 'agent_sessions'] as const) {
    assert.equal(
      foreignKeyColumns(migrated, table).has('inbound_messages:channel->channel'),
      true,
      `${table} must bind its parent channel`,
    );
  }
});

test('a v21 database with broken foreign keys is rejected before migration mutates it', (t) => {
  const filePath = createV21Database(t, 'kintio-corrupt-v21');
  const database = new DatabaseSync(filePath);
  database.exec('PRAGMA foreign_keys = OFF');
  database.prepare(`
    INSERT INTO inbound_media (
      message_key, open_kfid, external_userid, position,
      kind, media_id, filename, sent_at, remembered_at
    ) VALUES (?, ?, ?, 0, 'image', 'orphan-media', '', 0, 1)
  `).run('missing-parent', ACCOUNT_KEY, PEER_ID);
  database.exec('PRAGMA foreign_keys = ON');
  const beforeSchema = schemaSnapshot(database);
  const beforeTables = tableNames(database);
  assert.equal(pragmaNumber(database, 'foreign_keys'), 1);
  assert.equal(pragmaNumber(database, 'legacy_alter_table'), 0);
  assert.throws(
    () => new SqliteStore(
      { filePath, journalMode: 'DELETE' },
      { database },
    ),
    /schema v21 contains foreign-key violations/u,
  );
  assert.equal(pragmaNumber(database, 'user_version'), 21);
  assert.equal(pragmaNumber(database, 'foreign_keys'), 1);
  assert.equal(pragmaNumber(database, 'legacy_alter_table'), 0);
  assert.equal(schemaSnapshot(database), beforeSchema);
  assert.deepEqual(tableNames(database), beforeTables);
  assert.equal(tableNames(database).some((name) => name.endsWith('_v21')), false);
  assert.equal(
    Number((database.prepare(`
      SELECT COUNT(*) AS count FROM inbound_media WHERE media_id = 'orphan-media'
    `).get() as { count: number }).count),
    1,
  );
  database.close();
});

test('a failure after the v22 migration transaction starts restores the exact v21 schema', (t) => {
  const filePath = createV21Database(t, 'kintio-rollback-v21');
  const database = new DatabaseSync(filePath);
  database.exec('DROP INDEX inbound_primary_idx');
  const beforeSchema = schemaSnapshot(database);
  const beforeTables = tableNames(database);
  assert.throws(
    () => new SqliteStore(
      { filePath, journalMode: 'DELETE' },
      { database },
    ),
    /no such index: inbound_primary_idx/u,
  );
  assert.equal(pragmaNumber(database, 'user_version'), 21);
  assert.equal(pragmaNumber(database, 'foreign_keys'), 1);
  assert.equal(pragmaNumber(database, 'legacy_alter_table'), 0);
  assert.equal(schemaSnapshot(database), beforeSchema);
  assert.deepEqual(tableNames(database), beforeTables);
  assert.equal(tableNames(database).some((name) => name.endsWith('_v21')), false);
  database.close();
});
