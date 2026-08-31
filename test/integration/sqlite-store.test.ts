import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, type TestContext } from 'vitest';
import assert from 'node:assert/strict';

import {
  CursorConflictError,
  stableMessageKey,
  type CoreState,
} from '../../src/state/sqlite-store.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import type { NormalizedMessage } from '../../src/types.ts';
import {
  inspectPragmas,
  inspectSchemaVersion,
} from '../support/sqlite-inspect.ts';
import { testWecomMessage } from '../support/wecom-message.ts';
import { seedPendingAttempts } from '../support/pending-attempt.ts';
import {
  openInjectedTestPersistence,
  withTestDatabase,
} from '../support/temp-sqlite.ts';

function createStore(
  t: TestContext,
  { now = 1_700_000_000_000 }: { now?: number } = {},
): {
  persistence: StatePersistence;
  store: CoreState;
  filePath: string;
  clock: { value: number };
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-sqlite-'));
  const filePath = path.join(directory, 'state.sqlite');
  const clock = { value: now };
  const persistence = new StatePersistence({ filePath, clock: () => clock.value });
  const store = persistence.core;
  t.onTestFinished(() => {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { persistence, store, filePath, clock };
}

function customerMessage(
  msgid: string,
  externalUserId = 'wm-a',
  content = msgid,
  openKfId = 'wk-a',
): NormalizedMessage {
  return testWecomMessage({
    id: msgid,
    sentAt: 100,
    openKfId,
    externalUserId,
    text: content,
  });
}

test('SQLite store creates private directory and WAL/FULL/FK schema', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-sqlite-pragmas-'));
  const filePath = path.join(directory, 'state.sqlite');
  const persistence = openInjectedTestPersistence(filePath);
  const { core: store, database } = persistence;
  t.onTestFinished(() => {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(inspectSchemaVersion(database), 22);
  assert.deepEqual(inspectPragmas(database), {
    journalMode: 'wal',
    synchronous: 2,
    foreignKeys: 1,
    busyTimeout: 5000,
  });
  const tables = (database.prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all() as { name: string }[])
    .map((row) => row.name);
  assert.deepEqual(tables, [
    'agent_artifacts',
    'agent_sessions',
    'authorizations',
    'conversations',
    'delivery_failures',
    'ilink_account_secrets',
    'ilink_accounts',
    'ilink_enrollment_audit',
    'ilink_inbound_images',
    'ilink_login_offers',
    'ilink_reply_window_secrets',
    'ilink_reply_windows',
    'inbound_media',
    'inbound_messages',
    'send_attempts',
    'sync_cursors',
  ]);
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  }
  assert.deepEqual(store.integrityCheck().map(Object.values), [['ok']]);
  assert.deepEqual(store.foreignKeyCheck(), []);
});

test('SQLite store preserves an existing shared parent directory mode', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-sqlite-shared-'));
  fs.chmodSync(directory, 0o777);
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'state.sqlite'),
  });
  const store = persistence.core;
  t.onTestFinished(() => {
    persistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });

  if (process.platform === 'win32') {
    assert.equal(fs.statSync(directory).isDirectory(), true);
    assert.equal(fs.statSync(store.filePath).isFile(), true);
  } else {
    assert.equal(fs.statSync(directory).mode & 0o777, 0o777);
    assert.equal(fs.statSync(store.filePath).mode & 0o777, 0o600);
  }
});

test('sync page atomically inserts messages and advances a CAS cursor', (t) => {
  const { store } = createStore(t);
  const systemEvent = testWecomMessage({
    id: 'event-1',
    origin: 'system',
    type: 'event',
    sentAt: 100,
    index: 1,
    openKfId: 'wk-a',
    externalUserId: 'wm-event',
    text: '',
    summary: '[event]',
    attributes: { event_type: 'future_event' },
  });
  const result = store.ingestSyncPage({
    accountKey: 'wk-a',
    expectedCursor: '',
    nextCursor: 'cursor-1',
    messages: [
      customerMessage('msg-1'),
      systemEvent,
    ],
  });
  assert.equal(result.insertedMessageKeys.length, 2);
  assert.equal(store.getCursor('wk-a'), 'cursor-1');
  assert.match(result.insertedMessageKeys[1] || '', /^im_[a-f0-9]{40}$/u);

  assert.throws(
    () =>
      store.ingestSyncPage({
        accountKey: 'wk-a',
        expectedCursor: '',
        nextCursor: 'cursor-stale',
        messages: [customerMessage('msg-stale')],
      }),
    CursorConflictError,
  );
  assert.equal(store.getCursor('wk-a'), 'cursor-1');
  assert.equal(store.getInbound(stableMessageKey('wechat_kf', 'wk-a', 'msg-stale')), undefined);

  assert.throws(() =>
    store.ingestSyncPage({
      accountKey: 'wk-a',
      expectedCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      messages: [null as unknown as NormalizedMessage],
    }),
  );
  assert.equal(store.getCursor('wk-a'), 'cursor-1');

  store.ingestSyncPage({
    accountKey: 'wk-b',
    expectedCursor: '',
    nextCursor: 'b-1',
    messages: [customerMessage('msg-1', 'wm-a', 'msg-1', 'wk-b')],
  });
  assert.notEqual(
    stableMessageKey('wechat_kf', 'wk-a', 'msg-1'),
    stableMessageKey('wechat_kf', 'wk-b', 'msg-1'),
  );
});

test('deferred startup messages stay out of recovery until promoted by live activity or idle drain', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    accountKey: 'wk-a',
    nextCursor: 'deferred',
    deferred: true,
    messages: [
      customerMessage('a-one', 'wm-a'),
      customerMessage('a-two', 'wm-a'),
      customerMessage('b-one', 'wm-b'),
    ],
  });
  assert.deepEqual(store.recoverStartup().inbound, []);
  assert.deepEqual(
    store.promoteDeferredConversation({
      channel: 'wechat_kf', accountKey: 'wk-a', peerId: 'wm-a',
    }).map((record) => record.providerMessageId),
    ['a-one', 'a-two'],
  );
  assert.deepEqual(
    store.recoverStartup().inbound.map((record) => record.providerMessageId),
    ['a-one', 'a-two'],
  );
  assert.deepEqual(
    store.activateNextDeferredConversation().map((record) => record.providerMessageId),
    ['b-one'],
  );
  assert.equal(store.getInbound(stableMessageKey('wechat_kf', 'wk-a', 'b-one'))?.deferred, false);
});

test('authorization is global but consecutive trigger counting resets by open_kfid', (t) => {
  const { store } = createStore(t);
  const ingest = (accountKey: string, cursor: string, msgid: string): string => {
    const next = `${cursor || 'start'}-${msgid}`;
    store.ingestSyncPage({
      accountKey,
      expectedCursor: cursor,
      nextCursor: next,
      messages: [customerMessage(msgid, 'wm-auth', '发车', accountKey)],
    });
    return next;
  };
  let cursorA = ingest('wk-a', '', 'a-1');
  const a1 = stableMessageKey('wechat_kf', 'wk-a', 'a-1');
  assert.equal(
    store.evaluateAuthorization({
      messageKey: a1,
      accountKey: 'wk-a',
      peerId: 'wm-auth',
      isTrigger: true,
    }).consecutiveMatches,
    1,
  );

  let cursorB = ingest('wk-b', '', 'b-1');
  const b1 = stableMessageKey('wechat_kf', 'wk-b', 'b-1');
  assert.equal(
    store.evaluateAuthorization({
      messageKey: b1,
      accountKey: 'wk-b',
      peerId: 'wm-auth',
      isTrigger: true,
    }).consecutiveMatches,
    1,
  );
  cursorB = ingest('wk-b', cursorB, 'b-2');
  store.evaluateAuthorization({
    messageKey: stableMessageKey('wechat_kf', 'wk-b', 'b-2'),
    accountKey: 'wk-b',
    peerId: 'wm-auth',
    isTrigger: true,
  });
  cursorB = ingest('wk-b', cursorB, 'b-3');
  const b3 = stableMessageKey('wechat_kf', 'wk-b', 'b-3');
  const authorized = store.evaluateAuthorization({
    messageKey: b3,
    accountKey: 'wk-b',
    peerId: 'wm-auth',
    isTrigger: true,
    confirmationText: '暗号确认，请继续对话',
  });
  assert.equal(authorized.decision, 'authorized_now');
  assert.equal(store.getAuthorization('wm-auth')?.authorized, true);
  assert.equal(store.getInbound(b3)?.status, 'ready');
  const confirmation = store.listMessageAttempts(b3)[0];
  assert.ok(confirmation);
  assert.deepEqual(confirmation.payload, {
    msgtype: 'text',
    text: { content: '暗号确认，请继续对话' },
  });
  assert.equal(confirmation.status, 'pending');
  assert.equal(confirmation.source, 'authorization');
  assert.match(confirmation.clientMessageId, /^wb_[a-f0-9]{29}$/);
  assert.deepEqual(
    store.evaluateAuthorization({
      messageKey: b3,
      accountKey: 'wk-b',
      peerId: 'wm-auth',
      isTrigger: true,
    }),
    {
      decision: 'duplicate',
      consecutiveMatches: 3,
    },
  );

  cursorA = ingest('wk-a', cursorA, 'a-after');
  assert.equal(
    store.evaluateAuthorization({
      messageKey: stableMessageKey('wechat_kf', 'wk-a', 'a-after'),
      accountKey: 'wk-a',
      peerId: 'wm-auth',
      isTrigger: false,
    }).decision,
    'already_authorized',
  );
});

test('a later customer direction prevents an older send from completing its primary early', (t) => {
  const { store } = createStore(t);
  const firstPage = store.ingestSyncPage({
    accountKey: 'wk-a',
    nextCursor: 'race-one',
    messages: [customerMessage('race-primary', 'wm-race')],
  });
  const primary = firstPage.insertedMessageKeys[0]!;
  store.claimInbound({ messageKey: primary });
  const session = store.createAgentSession({ messageKey: primary });
  const attempt = store.reserveAgentSend({
    sessionToken: session.token,
    sentType: 'text',
    payload: { msgtype: 'text', text: { content: 'old direction' } },
  });
  store.ingestSyncPage({
    accountKey: 'wk-a',
    expectedCursor: 'race-one',
    nextCursor: 'race-two',
    messages: [customerMessage('race-followup', 'wm-race')],
  });
  store.closeAgentSession(session.token);
  store.completeSend(attempt.attemptId, { providerMessageId: 'wx-race-old' });
  assert.equal(store.getInbound(primary)?.status, 'processing');
});

test('a steer rejected at the completed-turn boundary can become a fresh turn once', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    accountKey: 'wk-a',
    nextCursor: 'one',
    messages: [customerMessage('primary'), customerMessage('boundary')],
  });
  const primary = stableMessageKey('wechat_kf', 'wk-a', 'primary');
  const boundary = stableMessageKey('wechat_kf', 'wk-a', 'boundary');
  store.claimInbound({ messageKey: primary });
  const steering = store.beginInboundSteering({
    messageKey: boundary,
    primaryMessageKey: primary,
    clientInputId: boundary,
  });
  assert.equal(steering.status, 'steering');
  const requeued = store.requeueInboundSteering(boundary, primary);
  assert.equal(requeued.status, 'received');
  assert.equal(requeued.primaryMessageKey, '');
  assert.equal(requeued.codexTurnId, '');
  assert.equal(requeued.clientInputId, '');
  assert.throws(() => store.requeueInboundSteering(boundary, primary));
  assert.equal(store.claimInbound({ messageKey: boundary }).status, 'processing');
});

test('startup converts only in-flight sends to uncertain and never requeues them', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-recover-'));
  const filePath = path.join(directory, 'state.sqlite');
  const firstPersistence = new StatePersistence({ filePath });
  const first = firstPersistence.core;
  first.ingestSyncPage({
    accountKey: 'wk-a',
    nextCursor: 'one',
    messages: [customerMessage('recover')],
  });
  const messageKey = stableMessageKey('wechat_kf', 'wk-a', 'recover');
  first.claimInbound({ messageKey });
  seedPendingAttempts(first, messageKey, [
      {
        sendIndex: 0,
        sentType: 'text',
        payload: { msgtype: 'text', text: { content: '可能已发' } },
      },
    ]);
  const sending = first.beginNextSend('wechat_kf');
  assert.ok(sending);
  firstPersistence.close();

  const secondPersistence = new StatePersistence({ filePath });
  const second = secondPersistence.core;
  t.onTestFinished(() => {
    secondPersistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const recovered = second.recoverStartup();
  assert.equal(recovered.uncertainSends, 1);
  assert.equal(second.getAttempt(sending.attemptId)?.status, 'uncertain');
  assert.equal(second.beginNextSend('wechat_kf'), undefined);
  assert.equal(second.getInbound(messageKey)?.status, 'completed');
});

test('startup revokes every capability issued by the previous process', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-session-recover-'));
  const filePath = path.join(directory, 'state.sqlite');
  const firstPersistence = new StatePersistence({ filePath });
  const first = firstPersistence.core;
  first.ingestSyncPage({
    accountKey: 'wk-a',
    nextCursor: 'one',
    messages: [customerMessage('active-session')],
  });
  const messageKey = stableMessageKey('wechat_kf', 'wk-a', 'active-session');
  first.claimInbound({ messageKey });
  const session = first.createAgentSession({ messageKey });
  firstPersistence.close();

  const secondPersistence = new StatePersistence({ filePath });
  const second = secondPersistence.core;
  t.onTestFinished(() => {
    secondPersistence.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  assert.equal(second.getAgentSession(session.token).messageKey, messageKey);
  second.recoverStartup();
  assert.throws(() => second.getAgentSession(session.token), /closed/u);
});

test('startup requeues inferred steering without a Codex turn and preserves confirmed steering', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    accountKey: 'wk-a',
    nextCursor: 'steering-recovery',
    messages: [
      customerMessage('unconfirmed-primary'),
      customerMessage('unconfirmed-followup'),
      customerMessage('confirmed-primary'),
      customerMessage('confirmed-followup'),
    ],
  });
  const unconfirmedPrimary = stableMessageKey('wechat_kf', 'wk-a', 'unconfirmed-primary');
  const unconfirmedFollowup = stableMessageKey('wechat_kf', 'wk-a', 'unconfirmed-followup');
  store.claimInbound({ messageKey: unconfirmedPrimary });
  store.beginInboundSteering({
    messageKey: unconfirmedFollowup,
    primaryMessageKey: unconfirmedPrimary,
  });

  const confirmedPrimary = stableMessageKey('wechat_kf', 'wk-a', 'confirmed-primary');
  const confirmedFollowup = stableMessageKey('wechat_kf', 'wk-a', 'confirmed-followup');
  store.claimInbound({ messageKey: confirmedPrimary });
  store.markInboundPreparing(confirmedPrimary, 'turn-confirmed');
  store.beginInboundSteering({
    messageKey: confirmedFollowup,
    primaryMessageKey: confirmedPrimary,
  });

  store.recoverStartup();
  assert.equal(store.getInbound(unconfirmedFollowup)?.status, 'received');
  assert.equal(store.getInbound(unconfirmedFollowup)?.primaryMessageKey, '');
  assert.equal(store.getInbound(confirmedFollowup)?.status, 'steering');
  assert.equal(
    store.getInbound(confirmedFollowup)?.primaryMessageKey,
    confirmedPrimary,
  );
  assert.equal(store.getInbound(confirmedFollowup)?.codexTurnId, 'turn-confirmed');
});

test('recovery snapshot ignores known backlog but a newly arrived message invalidates it', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    accountKey: 'wk-a',
    nextCursor: 'snapshot-one',
    messages: [
      customerMessage('snapshot-primary'),
      customerMessage('snapshot-known-later'),
    ],
  });
  const primary = stableMessageKey('wechat_kf', 'wk-a', 'snapshot-primary');
  const knownLater = stableMessageKey('wechat_kf', 'wk-a', 'snapshot-known-later');
  store.claimInbound({ messageKey: primary });
  const allowed = store.createAgentSession({
    messageKey: primary,
    boundaryMessageKey: knownLater,
  });
  const attempt = store.reserveAgentSend({
    sessionToken: allowed.token,
    sentType: 'text',
    payload: { msgtype: 'text', text: { content: '独立回答' } },
  });
  assert.equal(
    attempt.metadata?.direction,
    store.getInbound(primary)?.inboxSeq,
  );
  store.closeAgentSession(allowed.token);

  const stale = store.createAgentSession({
    messageKey: primary,
    boundaryMessageKey: knownLater,
  });
  store.ingestSyncPage({
    accountKey: 'wk-a',
    expectedCursor: 'snapshot-one',
    nextCursor: 'snapshot-two',
    messages: [customerMessage('snapshot-new-live')],
  });
  assert.throws(() => store.reserveAgentSend({
    sessionToken: stale.token,
    sentType: 'text',
    payload: { msgtype: 'text', text: { content: '不应发送' } },
  }), /active conversation direction/u);
});

test('archived memory binding follows the short-lived session and clears on completion', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    accountKey: 'wk-a',
    nextCursor: 'memory',
    messages: [customerMessage('memory-turn')],
  });
  const messageKey = stableMessageKey('wechat_kf', 'wk-a', 'memory-turn');
  store.claimInbound({ messageKey });
  store.setConversationThread({
    channel: 'wechat_kf',
    accountKey: 'wk-a',
    peerId: 'wm-a',
    threadId: '01900000-0000-7000-8000-000000000002',
    memoryThreadId: '01900000-0000-7000-8000-000000000001',
  });
  const session = store.createAgentSession({ messageKey });
  assert.equal(
    store.getAgentSession(session.token).memoryThreadId,
    '01900000-0000-7000-8000-000000000001',
  );
  const [pending] = seedPendingAttempts(store, messageKey, [{
    sendIndex: 0,
    source: 'mcp_tool',
    sentType: 'text',
    payload: { msgtype: 'text', text: { content: 'done' } },
  }]);
  assert.ok(pending);
  const sending = store.beginNextSend('wechat_kf');
  assert.ok(sending);
  store.completeSend(sending.attemptId, { providerMessageId: 'wx-memory' });
  store.finalizeAgentExecution({
    messageKey,
    attemptIds: [sending.attemptId],
  });
  assert.equal(
    store.getConversation('wechat_kf', 'wk-a', 'wm-a')?.memoryThreadId,
    '',
  );
  assert.throws(() => store.getAgentSession(session.token), /closed/u);
});

test('recent channel facts are conversation scoped and use the conversation index', (t) => {
  const { store, filePath } = createStore(t);
  store.ingestSyncPage({
    accountKey: 'wk-a',
    nextCursor: 'one',
    messages: [
      customerMessage('a-fact', 'wm-a'),
      customerMessage('b-fact', 'wm-b'),
    ],
  });
  for (const [msgid, externalUserId] of [
    ['a-fact', 'wm-a'],
    ['b-fact', 'wm-b'],
  ] as const) {
    const messageKey = stableMessageKey('wechat_kf', 'wk-a', msgid);
    store.claimInbound({ messageKey });
    seedPendingAttempts(store, messageKey, [
        {
          sendIndex: 0,
          sentType: 'text',
          payload: { msgtype: 'text', text: { content: externalUserId } },
        },
      ]);
    const attempt = store.beginNextSend('wechat_kf');
    assert.ok(attempt);
    store.completeSend(attempt.attemptId, { providerMessageId: `wx-${externalUserId}` });
  }

  const facts = store.listRecentConversationAttempts({
    channel: 'wechat_kf',
    accountKey: 'wk-a',
    peerId: 'wm-a',
    limit: 10,
  });
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.peerId, 'wm-a');
  assert.equal(facts[0]?.providerMessageId, 'wx-wm-a');
  const plan = withTestDatabase(filePath, (database) => database.prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM send_attempts
      WHERE channel = ? AND open_kfid = ? AND external_userid = ?
        AND status IN ('accepted', 'failed', 'uncertain')
      ORDER BY updated_at DESC LIMIT ?
    `)
    .all('wechat_kf', 'wk-a', 'wm-a', 10) as unknown as { detail: string }[]);
  assert.match(
    plan.map((row) => String(row.detail)).join('\n'),
    /send_conversation_idx/u,
  );
});

test('startup recovery returns every pending inbound beyond the old 1000-row cap', (t) => {
  const { store, filePath } = createStore(t);
  const messages = Array.from({ length: 1_001 }, (_, index) =>
    customerMessage(`recover-${index}`, 'wm-many')
  );
  store.ingestSyncPage({
    accountKey: 'wk-a',
    nextCursor: 'many-cursor',
    messages,
  });
  withTestDatabase(filePath, (database) => {
    database.exec(`
      UPDATE inbound_messages
      SET status = 'processing', client_input_id = message_key
    `);
  });
  assert.equal(store.recoverStartup().inbound.length, 1_001);
});

test('primary failure requeues its steering input for bounded recovery', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    accountKey: 'wk-a',
    nextCursor: 'steering-cursor',
    messages: [customerMessage('failure-primary'), customerMessage('failure-steer')],
  });
  const primaryKey = stableMessageKey('wechat_kf', 'wk-a', 'failure-primary');
  const steerKey = stableMessageKey('wechat_kf', 'wk-a', 'failure-steer');
  store.claimInbound({ messageKey: primaryKey });
  store.beginInboundSteering({
    messageKey: steerKey,
    primaryMessageKey: primaryKey,
  });
  store.failInbound(primaryKey, new Error('turn failed'));
  assert.equal(store.getInbound(primaryKey)?.status, 'failed');
  assert.equal(store.getInbound(steerKey)?.status, 'received');
  assert.equal(store.getInbound(steerKey)?.primaryMessageKey, '');
});

test('composite foreign keys reject cross-customer media and send targets', (t) => {
  const { store, filePath } = createStore(t);
  store.ingestSyncPage({
    accountKey: 'wk-a',
    nextCursor: 'fk-cursor',
    messages: [customerMessage('owner', 'wm-owner')],
  });
  const messageKey = stableMessageKey('wechat_kf', 'wk-a', 'owner');
  withTestDatabase(filePath, (database) => {
    assert.throws(() =>
      database.prepare(`
        INSERT INTO inbound_media (
          message_key, channel, open_kfid, external_userid, position, kind,
          media_id, remembered_at
        ) VALUES (?, 'wechat_kf', 'wk-a', 'wm-other', 0, 'image', 'media', 1)
      `).run(messageKey),
    /FOREIGN KEY/u);
    assert.throws(() =>
      database.prepare(`
        INSERT INTO send_attempts (
          attempt_key, source_message_key, open_kfid, external_userid,
          channel, send_index, source, sent_type, fingerprint, client_message_id,
          status, created_at, updated_at
        ) VALUES (
          'bad-attempt', ?, 'wk-a', 'wm-other', 'wechat_kf', 0, 'test', 'text',
          'hash', 'client-id', 'pending', 1, 1
        )
      `).run(messageKey),
    /FOREIGN KEY/u);
  });
});
