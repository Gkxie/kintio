import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';

import {
  type InboundStatus,
  type CoreState,
} from '../../src/state/sqlite-store.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
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

test('fresh storage uses the current schema and reopening preserves messages', (t) => {
  const { persistence, store, filePath } = harness(t);
  const [messageKey] = ingest(store, [message('current-schema')]);
  assert.ok(messageKey);
  const original = store.getInbound(messageKey);
  assert.equal(schemaVersion(filePath), 24);
  persistence.close();
  const restored = reopen(t, filePath);
  assert.deepEqual(restored.getInbound(messageKey), original);
  assert.deepEqual(restored.integrityCheck().map(Object.values), [['ok']]);
  assert.deepEqual(restored.foreignKeyCheck(), []);
});

test('invalid journal mode is rejected before runtime use', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-journal-'));
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  assert.throws(() => new StatePersistence({
    filePath: path.join(directory, 'state.sqlite'),
    journalMode: 'MEMORY' as unknown as 'WAL',
  }), /Unsupported SQLite journal mode/u);
});

for (const version of [1, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 25, 999]) {
  test(`schema ${version} is rejected without upgrading, resetting, or modifying stored data`, (context) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-unsupported-'));
    const filePath = path.join(directory, 'state.sqlite');
    context.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
    withTestDatabase(filePath, (database) => database.exec(`
      CREATE TABLE retained_data (value TEXT NOT NULL);
      INSERT INTO retained_data VALUES ('keep this data');
      PRAGMA user_version = ${version};
    `));
    assert.throws(() => new StatePersistence({ filePath }),
      /schema version .* is not supported; expected 24/u);
    assert.equal(schemaVersion(filePath), version);
    withTestDatabase(filePath, (database) => {
      assert.deepEqual(database.prepare('SELECT value FROM retained_data').all().map(Object.values),
        [['keep this data']]);
      assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all().map(Object.values), [['retained_data']]);
    });
  });
}

test('failed fresh initialization rolls back partial schema creation', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-initialize-'));
  const filePath = path.join(directory, 'state.sqlite');
  t.onTestFinished(() => fs.rmSync(directory, { recursive: true, force: true }));
  withTestDatabase(filePath, (database) => database.exec('CREATE TABLE inbound_messages (value TEXT)'));
  assert.throws(() => new StatePersistence({ filePath }), /already exists/u);
  assert.equal(schemaVersion(filePath), 0);
  withTestDatabase(filePath, (database) => {
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all().map(Object.values), [['inbound_messages']]);
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
