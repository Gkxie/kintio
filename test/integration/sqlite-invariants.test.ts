import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';
import { DatabaseSync } from 'node:sqlite';

import {
  SqliteStore,
  type InboundStatus,
} from '../../src/state/sqlite-store.ts';
import type { ImageAttachment, NormalizedMessage } from '../../src/types.ts';
import { inspectAttempt } from '../support/sqlite-inspect.ts';
import { seedPendingAttempts } from '../support/pending-attempt.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

function message(id: string, externalUserId = 'wm-one'): NormalizedMessage {
  return testWecomMessage({
    id,
    openKfId: 'wk-one',
    externalUserId,
  });
}

function harness(t: TestContext): { store: SqliteStore; filePath: string } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-invariant-'));
  const filePath = path.join(directory, 'state.sqlite');
  const store = new SqliteStore({ filePath });
  t.onTestFinished(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, filePath };
}

function ingest(store: SqliteStore, values: readonly NormalizedMessage[]): string[] {
  return store.ingestSyncPage({
    openKfId: 'wk-one',
    expectedCursor: store.getCursor('wk-one'),
    nextCursor: `cursor-${values.map((item) => item.id).join('-')}`,
    messages: values,
  }).insertedMessageKeys;
}

function reserveText(store: SqliteStore, id: string): string {
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
    () => new SqliteStore({
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
    () => new SqliteStore({ filePath: futurePath }),
    /newer than supported/u,
  );
  const retiredPath = path.join(directory, 'retired.sqlite');
  const retired = new DatabaseSync(retiredPath);
  retired.exec('PRAGMA user_version = 10');
  retired.close();
  assert.throws(
    () => new SqliteStore({ filePath: retiredPath }),
    /no longer supported/u,
  );
});

test('schema v11 removes retired state without losing durable facts', (t) => {
  const { store, filePath } = harness(t);
  const messageKey = reserveText(store, 'v11-preserved');
  const attempt = store.beginNextSend();
  assert.ok(attempt);
  store.completeSend(attempt.attemptId, { wecomMsgId: 'wx-v11-preserved' });
  const [activeMessageKey] = ingest(store, [message('v11-active-session')]);
  assert.ok(activeMessageKey);
  store.claimInbound({ messageKey: activeMessageKey });
  const session = store.createAgentSession({ messageKey: activeMessageKey });
  const [staleAttempt] = seedPendingAttempts(store, activeMessageKey, [{
    sendIndex: 0,
    sentType: 'text',
    payload: { msgtype: 'text', text: { content: 'must not send' } },
  }]);
  assert.ok(staleAttempt);
  const [absorbedMessageKey] = ingest(store, [message('v11-absorbed-context')]);
  assert.ok(absorbedMessageKey);
  store.database.prepare(`
    UPDATE inbound_messages SET status = 'absorbed' WHERE message_key = ?
  `).run(absorbedMessageKey);
  store.close();

  const v11 = new DatabaseSync(filePath);
  v11.exec(`
    DROP TRIGGER ilink_session_window_insert_guard;
    DROP TRIGGER ilink_session_window_update_guard;
    DROP TRIGGER ilink_attempt_window_insert_guard;
    DROP TRIGGER ilink_attempt_window_update_guard;
    DROP TRIGGER ilink_window_source_insert_guard;
    DROP TRIGGER ilink_window_source_update_guard;
    DROP TRIGGER ilink_window_delete_guard;
    DROP TABLE ilink_login_offers;
    DROP TABLE ilink_inbound_images;
    DROP TABLE ilink_reply_window_secrets;
    DROP TABLE ilink_reply_windows;
    DROP TABLE ilink_account_secrets;
    DROP TABLE ilink_accounts;
    ALTER TABLE inbound_messages
      ADD COLUMN context_status TEXT NOT NULL DEFAULT 'none'
        CHECK (context_status IN ('none', 'pending', 'consumed'));
    ALTER TABLE inbound_messages
      ADD COLUMN claimed_conversation_epoch INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE agent_sessions
      ADD COLUMN conversation_epoch INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE conversations
      ADD COLUMN mode TEXT NOT NULL DEFAULT 'bot'
        CHECK (mode IN ('bot', 'human', 'ended'));
    ALTER TABLE conversations
      ADD COLUMN automation_epoch INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE conversations
      ADD COLUMN servicer_userid TEXT NOT NULL DEFAULT '';
    ALTER TABLE conversations
      ADD COLUMN session_source TEXT NOT NULL DEFAULT '';
    ALTER TABLE conversations
      ADD COLUMN change_type INTEGER NOT NULL DEFAULT 0;
    UPDATE conversations
    SET mode = 'human', automation_epoch = 1
    WHERE open_kfid = 'wk-one' AND external_userid = 'wm-one';
    PRAGMA user_version = 11;
  `);
  v11.close();

  const upgraded = new SqliteStore({ filePath });
  t.onTestFinished(() => upgraded.close());
  assert.equal(
    (upgraded.database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    21,
  );
  assert.throws(() => upgraded.getAgentSession(session.token), /closed/u);
  const inboundSql = String((upgraded.database.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'inbound_messages'
  `).get() as { sql: string }).sql);
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
  const { store, filePath } = harness(t);
  const [messageKey] = ingest(store, [message('v12-priority')]);
  assert.ok(messageKey);
  store.close();
  const v12 = new DatabaseSync(filePath);
  v12.exec(`
    DROP TRIGGER ilink_session_window_insert_guard;
    DROP TRIGGER ilink_session_window_update_guard;
    DROP TRIGGER ilink_attempt_window_insert_guard;
    DROP TRIGGER ilink_attempt_window_update_guard;
    DROP TRIGGER ilink_window_source_insert_guard;
    DROP TRIGGER ilink_window_source_update_guard;
    DROP TRIGGER ilink_window_delete_guard;
    DROP TABLE ilink_login_offers;
    DROP TABLE ilink_inbound_images;
    DROP TABLE ilink_reply_window_secrets;
    DROP TABLE ilink_reply_windows;
    DROP TABLE ilink_account_secrets;
    DROP TABLE ilink_accounts;
    DROP INDEX inbound_deferred_idx;
    ALTER TABLE inbound_messages DROP COLUMN deferred;
    ALTER TABLE inbound_messages DROP COLUMN channel;
    ALTER TABLE conversations DROP COLUMN memory_thread_id;
    ALTER TABLE agent_sessions DROP COLUMN memory_thread_id;
    ALTER TABLE agent_sessions DROP COLUMN channel;
    ALTER TABLE agent_sessions DROP COLUMN reply_window_id;
    PRAGMA user_version = 12;
  `);
  v12.close();

  const upgraded = new SqliteStore({ filePath });
  t.onTestFinished(() => upgraded.close());
  assert.equal(
    (upgraded.database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    21,
  );
  assert.equal(upgraded.getInbound(messageKey)?.deferred, false);
  assert.deepEqual(upgraded.integrityCheck().map(Object.values), [['ok']]);
});

test('schema v13 adds durable archived-memory bindings', (t) => {
  const { store, filePath } = harness(t);
  const [messageKey] = ingest(store, [message('v13-memory')]);
  assert.ok(messageKey);
  store.setConversationThread({
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    threadId: '01900000-0000-7000-8000-000000000002',
  });
  store.close();
  const v13 = new DatabaseSync(filePath);
  v13.exec(`
    DROP TRIGGER ilink_session_window_insert_guard;
    DROP TRIGGER ilink_session_window_update_guard;
    DROP TRIGGER ilink_attempt_window_insert_guard;
    DROP TRIGGER ilink_attempt_window_update_guard;
    DROP TRIGGER ilink_window_source_insert_guard;
    DROP TRIGGER ilink_window_source_update_guard;
    DROP TRIGGER ilink_window_delete_guard;
    DROP TABLE ilink_login_offers;
    DROP TABLE ilink_inbound_images;
    DROP TABLE ilink_reply_window_secrets;
    DROP TABLE ilink_reply_windows;
    DROP TABLE ilink_account_secrets;
    DROP TABLE ilink_accounts;
    ALTER TABLE inbound_messages DROP COLUMN channel;
    ALTER TABLE conversations DROP COLUMN memory_thread_id;
    ALTER TABLE agent_sessions DROP COLUMN memory_thread_id;
    ALTER TABLE agent_sessions DROP COLUMN channel;
    ALTER TABLE agent_sessions DROP COLUMN reply_window_id;
    PRAGMA user_version = 13;
  `);
  v13.close();

  const upgraded = new SqliteStore({ filePath });
  t.onTestFinished(() => upgraded.close());
  assert.equal(
    (upgraded.database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    21,
  );
  assert.equal(upgraded.getConversation('wk-one', 'wm-one')?.memoryThreadId, '');
  assert.ok(upgraded.getInbound(messageKey));
  assert.deepEqual(upgraded.integrityCheck().map(Object.values), [['ok']]);
  assert.deepEqual(upgraded.foreignKeyCheck(), []);
});

test('schema v17 adds iLink invariant triggers and enrollment audit without rewriting facts', (t) => {
  const { store, filePath } = harness(t);
  const [messageKey] = ingest(store, [message('v17-ilink-invariants')]);
  assert.ok(messageKey);
  store.close();
  const v17 = new DatabaseSync(filePath);
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

  const upgraded = new SqliteStore({ filePath });
  t.onTestFinished(() => upgraded.close());
  assert.equal(
    (upgraded.database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    21,
  );
  assert.ok(upgraded.getInbound(messageKey));
  assert.equal(Number((upgraded.database.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'trigger' AND name LIKE 'ilink_%_guard'
  `).get() as { count: number }).count), 7);
  assert.throws(() => upgraded.database.prepare(`
    INSERT INTO agent_sessions (
      token_hash, source_message_key, open_kfid, external_userid,
      channel, reply_window_id, boundary_inbox_seq, memory_thread_id,
      media_json, expires_at, closed_at, created_at, updated_at
    )
    SELECT 'bad-ilink-session', message_key, open_kfid, external_userid,
           'weixin_ilink', NULL, inbox_seq, '', '[]', 9999999999999, 0, 1, 1
    FROM inbound_messages WHERE message_key = ?
  `).run(messageKey), /channel\/window mismatch/u);
  assert.deepEqual(upgraded.foreignKeyCheck(), []);
});

test('schema v19 adds cleanup indexes without rewriting iLink tables', (t) => {
  const { store, filePath } = harness(t);
  store.close();
  const v19 = new DatabaseSync(filePath);
  v19.exec(`
    DROP INDEX ilink_reply_windows_expiry_idx;
    DROP INDEX ilink_reply_windows_updated_idx;
    PRAGMA user_version = 19;
  `);
  v19.close();
  const upgraded = new SqliteStore({ filePath });
  t.onTestFinished(() => upgraded.close());
  assert.equal(
    (upgraded.database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    21,
  );
  assert.equal(Number((upgraded.database.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'index' AND name IN (
      'ilink_reply_windows_expiry_idx', 'ilink_reply_windows_updated_idx'
    )
  `).get() as { count: number }).count), 2);
  assert.deepEqual(upgraded.foreignKeyCheck(), []);
});

test('schema v21 drops retired binding without rewriting historical sends', (t) => {
  const { store, filePath } = harness(t);
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
  const sending = store.beginNextSend();
  assert.equal(sending?.attemptId, retiredAttempt.attemptId);
  store.completeSend(retiredAttempt.attemptId, { wecomMsgId: 'retired-accepted' });
  store.database.prepare(`
    INSERT INTO delivery_failures (
      wecom_msgid, fail_type, observed_at, matched_attempt_key, matched_at
    ) VALUES ('retired-notification-failure', 13, 1, ?, 1)
  `).run(retiredAttempt.attemptId);
  store.close();

  const v20 = new DatabaseSync(filePath);
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

  const upgraded = new SqliteStore({ filePath });
  t.onTestFinished(() => upgraded.close());
  assert.equal(
    (upgraded.database.prepare('PRAGMA user_version').get() as { user_version: number })
      .user_version,
    21,
  );
  assert.equal(Number((upgraded.database.prepare(`
    SELECT COUNT(*) AS count FROM sqlite_master
    WHERE type = 'table' AND name = 'maintainer_binding'
  `).get() as { count: number }).count), 0);
  assert.deepEqual(upgraded.listMessageAttempts(messageKey).map((attempt) => ({
    source: attempt.source,
    status: attempt.status,
    errorCode: attempt.errorCode,
  })), [
    { source: 'maintainer_binding', status: 'accepted', errorCode: '' },
    { source: 'maintainer_notify', status: 'failed', errorCode: 'feature_removed' },
    { source: 'test_fixture', status: 'pending', errorCode: '' },
  ]);
  assert.deepEqual({ ...(upgraded.database.prepare(`
    SELECT matched_attempt_key, matched_at FROM delivery_failures
    WHERE wecom_msgid = 'retired-notification-failure'
  `).get() as { matched_attempt_key: string; matched_at: number }) }, {
    matched_attempt_key: retiredAttempt.attemptId, matched_at: 1,
  });
  assert.deepEqual(upgraded.integrityCheck().map(Object.values), [['ok']]);
  assert.deepEqual(upgraded.foreignKeyCheck(), []);
});

test('status CHECK rejects invalid rows and filters remain parameterized', (t) => {
  const { store } = harness(t);
  assert.throws(() =>
    store.database.prepare(`
      INSERT INTO inbound_messages (
        message_key, open_kfid, msgid, origin, msg_type, status,
        created_at, updated_at
      ) VALUES ('bad', 'wk-one', 'bad', 'customer', 'text', 'bogus', 1, 1)
    `).run(),
  /CHECK constraint/u);
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
  const { store } = harness(t);
  const [primary, later] = ingest(store, [message('primary'), message('later')]);
  assert.ok(primary && later);
  store.claimInbound({ messageKey: primary });
  const statuses: InboundStatus[] = [
    'received', 'failed', 'processing', 'preparing', 'ready',
    'completed', 'steering', 'steered', 'absorbed', 'suppressed',
  ];
  for (const status of statuses) {
    store.database.prepare(`
      UPDATE inbound_messages SET status = ? WHERE message_key = ?
    `).run(status, later);
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
  const createAttempt = (id: string, externalUserId: string) => {
    const [messageKey] = ingest(store, [message(id, externalUserId)]);
    assert.ok(messageKey);
    store.claimInbound({ messageKey });
    const session = store.createAgentSession({ messageKey });
    const attempt = store.reserveAgentSend({
      sessionToken: session.token,
      sentType: 'text',
      payload: { msgtype: 'text', text: { content: id } },
    });
    store.completeSend(attempt.attemptId, { wecomMsgId: `wx-${id}` });
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
  assert.throws(() => store.completeSend('missing', { wecomMsgId: 'wx' }), /Unknown/u);
  assert.throws(() => store.failSend('missing', new Error('x')), /Unknown/u);
  assert.throws(() => store.markSendUncertain('missing', new Error('x')), /Unknown/u);
  assert.equal(inspectAttempt(store.database, 'missing'), undefined);

  const messageKey = reserveText(store, 'terminal');
  const attempt = store.beginNextSend();
  assert.ok(attempt);
  store.completeSend(attempt.attemptId, { wecomMsgId: 'wx-terminal' });
  assert.equal(store.completeSend(attempt.attemptId, { wecomMsgId: 'wx-terminal' }).status, 'accepted');
  assert.throws(() => store.failSend(attempt.attemptId, new Error('late')), /status accepted/u);
  assert.throws(
    () => store.markSendUncertain(attempt.attemptId, new Error('late')),
    /status accepted/u,
  );
  assert.equal(store.markSendMsgFailed({ wecomMsgId: '', failType: 1 }), false);
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
    openKfId: 'wk-one', externalUserId: 'wm-one', maxAgeMs: -1,
  }), []);
});

test('one nonempty Codex thread belongs to exactly one conversation', (t) => {
  const { store } = harness(t);
  store.setConversationThread({
    openKfId: 'wk-one', externalUserId: 'wm-one', threadId: 'thread-shared',
  });
  assert.throws(
    () => store.setConversationThread({
      openKfId: 'wk-two', externalUserId: 'wm-two', threadId: 'thread-shared',
    }),
    /UNIQUE constraint failed/u,
  );
  assert.equal(
    store.getConversation('wk-two', 'wm-two')?.threadId,
    undefined,
  );
});
