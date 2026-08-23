import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import {
  CursorConflictError,
  SendInvariantError,
  SqliteStore,
  stableMessageKey,
} from '../../src/state/sqlite-store.ts';
import type { NormalizedMessage } from '../../src/types.ts';
import {
  inspectAttempt,
  inspectAttempts,
  inspectPragmas,
  inspectSchemaVersion,
} from '../support/sqlite-inspect.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

function createStore(
  t: TestContext,
  { now = 1_700_000_000_000 }: { now?: number } = {},
): { store: SqliteStore; filePath: string; clock: { value: number } } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-sqlite-'));
  const filePath = path.join(directory, 'state.sqlite');
  const clock = { value: now };
  const store = new SqliteStore({ filePath, clock: () => clock.value });
  t.after(() => {
    store.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { store, filePath, clock };
}

function customerMessage(
  msgid: string,
  externalUserId = 'wm-a',
  content = msgid,
): NormalizedMessage {
  return testWecomMessage({
    id: msgid,
    sentAt: 100,
    openKfId: 'wk-a',
    externalUserId,
    text: content,
  });
}

test('[SEC04] SQLite store creates private directory and WAL/FULL/FK schema', (t) => {
  const { store, filePath } = createStore(t);
  assert.equal(inspectSchemaVersion(store.database), 3);
  assert.deepEqual(inspectPragmas(store.database), {
    journalMode: 'wal',
    synchronous: 2,
    foreignKeys: 1,
    busyTimeout: 5000,
  });
  const tables = (store.database
    .prepare(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `)
    .all() as { name: string }[])
    .map((row) => row.name);
  assert.deepEqual(tables, [
    'authorizations',
    'conversations',
    'inbound_media',
    'inbound_messages',
    'runtime_controls',
    'schema_meta',
    'send_attempts',
    'sync_cursors',
  ]);
  assert.equal(fs.statSync(path.dirname(filePath)).mode & 0o777, 0o700);
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
  assert.deepEqual(store.integrityCheck().map(Object.values), [['ok']]);
  assert.deepEqual(store.foreignKeyCheck(), []);
});

test('[G04][R05] sync page atomically inserts messages and advances a CAS cursor', (t) => {
  const { store } = createStore(t);
  const systemEvent = testWecomMessage({
    id: '',
    origin: 'system',
    type: 'event',
    sentAt: 100,
    index: 1,
    openKfId: 'wk-a',
    externalUserId: '',
    text: '',
    summary: '[event]',
    attributes: { event_type: 'session_status_change' },
  });
  const result = store.ingestSyncPage({
    openKfId: 'wk-a',
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
        openKfId: 'wk-a',
        expectedCursor: '',
        nextCursor: 'cursor-stale',
        messages: [customerMessage('msg-stale')],
      }),
    CursorConflictError,
  );
  assert.equal(store.getCursor('wk-a'), 'cursor-1');
  assert.equal(store.getInbound(stableMessageKey('wk-a', 'msg-stale')), undefined);

  assert.throws(() =>
    store.ingestSyncPage({
      openKfId: 'wk-a',
      expectedCursor: 'cursor-1',
      nextCursor: 'cursor-2',
      messages: [null as unknown as NormalizedMessage],
    }),
  );
  assert.equal(store.getCursor('wk-a'), 'cursor-1');

  store.ingestSyncPage({
    openKfId: 'wk-b',
    expectedCursor: '',
    nextCursor: 'b-1',
    messages: [customerMessage('msg-1')],
  });
  assert.notEqual(
    stableMessageKey('wk-a', 'msg-1'),
    stableMessageKey('wk-b', 'msg-1'),
  );
});

test('[A05] authorization is global but consecutive trigger counting resets by open_kfid', (t) => {
  const { store } = createStore(t);
  const ingest = (openKfId: string, cursor: string, msgid: string): string => {
    const next = `${cursor || 'start'}-${msgid}`;
    store.ingestSyncPage({
      openKfId,
      expectedCursor: cursor,
      nextCursor: next,
      messages: [customerMessage(msgid, 'wm-auth', '发车')],
    });
    return next;
  };
  let cursorA = ingest('wk-a', '', 'a-1');
  const a1 = stableMessageKey('wk-a', 'a-1');
  assert.equal(
    store.evaluateAuthorization({
      messageKey: a1,
      openKfId: 'wk-a',
      externalUserId: 'wm-auth',
      isTrigger: true,
    }).consecutiveMatches,
    1,
  );

  let cursorB = ingest('wk-b', '', 'b-1');
  const b1 = stableMessageKey('wk-b', 'b-1');
  assert.equal(
    store.evaluateAuthorization({
      messageKey: b1,
      openKfId: 'wk-b',
      externalUserId: 'wm-auth',
      isTrigger: true,
    }).consecutiveMatches,
    1,
  );
  cursorB = ingest('wk-b', cursorB, 'b-2');
  store.evaluateAuthorization({
    messageKey: stableMessageKey('wk-b', 'b-2'),
    openKfId: 'wk-b',
    externalUserId: 'wm-auth',
    isTrigger: true,
  });
  cursorB = ingest('wk-b', cursorB, 'b-3');
  const b3 = stableMessageKey('wk-b', 'b-3');
  const authorized = store.evaluateAuthorization({
    messageKey: b3,
    openKfId: 'wk-b',
    externalUserId: 'wm-auth',
    isTrigger: true,
    confirmationText: '暗号确认，请继续对话',
  });
  assert.equal(authorized.newlyAuthorized, true);
  assert.equal(store.getAuthorization('wm-auth')?.authorized, true);
  assert.equal(store.getInbound(b3)?.status, 'ready');
  const confirmation = inspectAttempts(store.database, b3)[0];
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
      openKfId: 'wk-b',
      externalUserId: 'wm-auth',
      isTrigger: true,
    }),
    {
      allowed: false,
      newlyAuthorized: false,
      duplicate: true,
      consecutiveMatches: 3,
    },
  );

  cursorA = ingest('wk-a', cursorA, 'a-after');
  assert.equal(
    store.evaluateAuthorization({
      messageKey: stableMessageKey('wk-a', 'a-after'),
      openKfId: 'wk-a',
      externalUserId: 'wm-auth',
      isTrigger: false,
    }).allowed,
    true,
  );
});

test('held human context is consumed exactly once with the next claimed turn', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    openKfId: 'wk-a',
    nextCursor: 'one',
    messages: [customerMessage('held'), customerMessage('next')],
  });
  const heldKey = stableMessageKey('wk-a', 'held');
  const nextKey = stableMessageKey('wk-a', 'next');
  store.markInboundHeld(heldKey);
  const claimed = store.claimInbound({
    messageKey: nextKey,
    consumeHeldContext: true,
  });
  assert.deepEqual(claimed.heldContext.map((item) => item.messageKey), [heldKey]);
  assert.equal(store.getInbound(heldKey)?.status, 'absorbed');
  assert.equal(store.getInbound(heldKey)?.contextStatus, 'consumed');
  assert.equal(store.getInbound(heldKey)?.primaryMessageKey, nextKey);
  assert.deepEqual(store.listHeldContext('wk-a', 'wm-a'), []);
});

test('[S08] a steer rejected at the completed-turn boundary can become a fresh turn once', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    openKfId: 'wk-a',
    nextCursor: 'one',
    messages: [customerMessage('primary'), customerMessage('boundary')],
  });
  const primary = stableMessageKey('wk-a', 'primary');
  const boundary = stableMessageKey('wk-a', 'boundary');
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
  assert.equal(store.claimInbound({ messageKey: boundary }).message.status, 'processing');
});

test('[R02][R06] final batch is atomic, epoch guarded, and rejects changed fingerprints', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    openKfId: 'wk-a',
    nextCursor: 'one',
    messages: [customerMessage('primary'), customerMessage('follow-up')],
  });
  const primary = stableMessageKey('wk-a', 'primary');
  const followUp = stableMessageKey('wk-a', 'follow-up');
  const claimed = store.claimInbound({ messageKey: primary }).message;
  store.beginInboundSteering({
    messageKey: followUp,
    primaryMessageKey: primary,
  });
  store.confirmInboundSteered(followUp, {
    codexTurnId: 'turn-1',
    steeringBoundary: 10,
  });
  const result = store.finalizeInboundBatch({
    messageKey: primary,
    steeringMessageKeys: [followUp],
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
    attempts: [
      {
        sendIndex: 0,
        source: 'codex_tool',
        sentType: 'text',
        payload: { msgtype: 'text', text: { content: '最终回答' } },
      },
    ],
  });
  assert.equal(result.suppressed, false);
  assert.equal(store.getInbound(primary)?.status, 'ready');
  assert.equal(store.getInbound(followUp)?.status, 'absorbed');
  assert.deepEqual(result.attempts[0]?.payload, {
    msgtype: 'text',
    text: { content: '最终回答' },
  });
  const duplicate = store.finalizeInboundBatch({
    messageKey: primary,
    steeringMessageKeys: [followUp],
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
    attempts: [
      {
        sendIndex: 0,
        source: 'codex_tool',
        sentType: 'text',
        payload: { msgtype: 'text', text: { content: '最终回答' } },
      },
    ],
  });
  assert.equal(duplicate.duplicate, true);

  assert.throws(
    () =>
      store.finalizeInboundBatch({
        messageKey: primary,
        steeringMessageKeys: [],
        expectedConversationEpoch: claimed.claimedConversationEpoch,
        expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
        attempts: [
          {
            sendIndex: 0,
            sentType: 'text',
            payload: { msgtype: 'text', text: { content: '内容变化' } },
          },
        ],
      }),
    (error: unknown) => error instanceof SendInvariantError,
  );

  store.ingestSyncPage({
    openKfId: 'wk-a',
    expectedCursor: 'one',
    nextCursor: 'two',
    messages: [customerMessage('paused')],
  });
  const pausedKey = stableMessageKey('wk-a', 'paused');
  const pausedClaim = store.claimInbound({ messageKey: pausedKey }).message;
  store.setRuntimePaused(true);
  const suppressed = store.finalizeInboundBatch({
    messageKey: pausedKey,
    expectedConversationEpoch: pausedClaim.claimedConversationEpoch,
    expectedRuntimeEpoch: pausedClaim.claimedRuntimeEpoch,
    attempts: [
      {
        sendIndex: 0,
        sentType: 'text',
        payload: { msgtype: 'text', text: { content: '不应发送' } },
      },
    ],
  });
  assert.equal(suppressed.suppressed, true);
  assert.equal(store.getInbound(pausedKey)?.status, 'suppressed');
  assert.deepEqual(inspectAttempts(store.database, pausedKey), []);
});

test('delivery failure atomically activates one reserved fallback', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    openKfId: 'wk-a',
    nextCursor: 'one',
    messages: [customerMessage('delivery')],
  });
  const messageKey = stableMessageKey('wk-a', 'delivery');
  const claimed = store.claimInbound({ messageKey }).message;
  store.finalizeInboundBatch({
    messageKey,
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
    attempts: [
      {
        sendIndex: 0,
        sentType: 'location',
        payload: {
          msgtype: 'location',
          location: { name: '地点', latitude: 1, longitude: 2 },
        },
      },
      {
        sendIndex: 1,
        sentType: 'text',
        status: 'blocked',
        fallbackForIndex: 0,
        payload: { msgtype: 'text', text: { content: '地点' } },
      },
    ],
  });
  const primary = store.beginNextSend();
  assert.ok(primary);
  assert.equal(primary.messageKey, messageKey);
  assert.equal(primary.type, 'location');
  assert.equal(primary.status, 'sending');
  store.failSend(primary.attemptId, { code: 40000, message: 'rejected' });
  const fallback = store.beginNextSend();
  assert.ok(fallback);
  assert.equal(fallback.sendIndex, 1);
  assert.equal(fallback.type, 'text');
  assert.throws(
    () => store.completeSend(fallback.attemptId, { wecomMsgId: '' }),
    /wecomMsgId is required/u,
  );
  assert.equal(inspectAttempt(store.database, fallback.attemptId)?.status, 'sending');
  store.completeSend(fallback.attemptId, { wecomMsgId: 'wecom-fallback' });
  assert.equal(store.getInbound(messageKey)?.status, 'completed');
});

test('startup converts only in-flight sends to uncertain and never requeues them', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-recover-'));
  const filePath = path.join(directory, 'state.sqlite');
  const first = new SqliteStore({ filePath });
  first.ingestSyncPage({
    openKfId: 'wk-a',
    nextCursor: 'one',
    messages: [customerMessage('recover')],
  });
  const messageKey = stableMessageKey('wk-a', 'recover');
  const claimed = first.claimInbound({ messageKey }).message;
  first.finalizeInboundBatch({
    messageKey,
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
    attempts: [
      {
        sendIndex: 0,
        sentType: 'text',
        payload: { msgtype: 'text', text: { content: '可能已发' } },
      },
    ],
  });
  const sending = first.beginNextSend();
  assert.ok(sending);
  first.close();

  const second = new SqliteStore({ filePath });
  t.after(() => {
    second.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  const recovered = second.recoverStartup();
  assert.equal(recovered.uncertainSends, 1);
  assert.equal(inspectAttempt(second.database, sending.attemptId)?.status, 'uncertain');
  assert.equal(second.beginNextSend(), undefined);
  assert.equal(second.getInbound(messageKey)?.status, 'completed');
});

test('delivery rejects a stale batch even when human or pause mode was later restored', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    openKfId: 'wk-a',
    nextCursor: 'one',
    messages: [customerMessage('stale-batch')],
  });
  const messageKey = stableMessageKey('wk-a', 'stale-batch');
  const claimed = store.claimInbound({ messageKey }).message;
  store.finalizeInboundBatch({
    messageKey,
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
    attempts: [
      {
        sendIndex: 0,
        sentType: 'text',
        payload: { msgtype: 'text', text: { content: '过期回答' } },
      },
    ],
  });
  store.setConversationMode({
    openKfId: 'wk-a',
    externalUserId: 'wm-a',
    mode: 'human',
  });
  store.setConversationMode({
    openKfId: 'wk-a',
    externalUserId: 'wm-a',
    mode: 'bot',
  });
  assert.equal(store.beginNextSend(), undefined);
  assert.equal(store.getInbound(messageKey)?.status, 'suppressed');
  assert.equal(
    inspectAttempts(store.database, messageKey)[0]?.errorCode,
    'suppressed',
  );
});

test('recent channel facts are conversation scoped and use the conversation index', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    openKfId: 'wk-a',
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
    const messageKey = stableMessageKey('wk-a', msgid);
    const claimed = store.claimInbound({ messageKey }).message;
    store.finalizeInboundBatch({
      messageKey,
      expectedConversationEpoch: claimed.claimedConversationEpoch,
      expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
      attempts: [
        {
          sendIndex: 0,
          sentType: 'text',
          payload: { msgtype: 'text', text: { content: externalUserId } },
        },
      ],
    });
    const attempt = store.beginNextSend();
    assert.ok(attempt);
    store.completeSend(attempt.attemptId, { wecomMsgId: `wx-${externalUserId}` });
  }

  const facts = store.listRecentConversationAttempts({
    openKfId: 'wk-a',
    externalUserId: 'wm-a',
    limit: 10,
  });
  assert.equal(facts.length, 1);
  assert.equal(facts[0]?.externalUserId, 'wm-a');
  assert.equal(facts[0]?.wecomMsgId, 'wx-wm-a');
  const plan = (store.database
    .prepare(`
      EXPLAIN QUERY PLAN
      SELECT * FROM send_attempts
      WHERE open_kfid = ? AND external_userid = ?
        AND status IN ('accepted', 'failed', 'uncertain')
      ORDER BY updated_at DESC LIMIT ?
    `)
    .all('wk-a', 'wm-a', 10)) as { detail: string }[];
  assert.match(
    plan.map((row) => String(row.detail)).join('\n'),
    /send_conversation_idx/u,
  );
});

test('send drain skips more than 100 stale attempts and still claims the next valid one', (t) => {
  const { store } = createStore(t);
  const staleMessages = Array.from({ length: 100 }, (_, index) =>
    customerMessage(`stale-${index}`, 'wm-backlog')
  );
  store.ingestSyncPage({
    openKfId: 'wk-a',
    nextCursor: 'stale-cursor',
    messages: staleMessages,
  });
  for (const message of staleMessages) {
    const messageKey = stableMessageKey('wk-a', message.id);
    const claimed = store.claimInbound({ messageKey }).message;
    store.finalizeInboundBatch({
      messageKey,
      expectedConversationEpoch: claimed.claimedConversationEpoch,
      expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
      attempts: [{
        sendIndex: 0,
        sentType: 'text',
        payload: { msgtype: 'text', text: { content: message.id } },
      }],
    });
  }
  store.setConversationMode({
    openKfId: 'wk-a',
    externalUserId: 'wm-backlog',
    mode: 'human',
  });
  store.setConversationMode({
    openKfId: 'wk-a',
    externalUserId: 'wm-backlog',
    mode: 'bot',
  });
  const valid = customerMessage('valid-101', 'wm-backlog');
  store.ingestSyncPage({
    openKfId: 'wk-a',
    expectedCursor: 'stale-cursor',
    nextCursor: 'valid-cursor',
    messages: [valid],
  });
  const validKey = stableMessageKey('wk-a', valid.id);
  const validClaim = store.claimInbound({ messageKey: validKey }).message;
  store.finalizeInboundBatch({
    messageKey: validKey,
    expectedConversationEpoch: validClaim.claimedConversationEpoch,
    expectedRuntimeEpoch: validClaim.claimedRuntimeEpoch,
    attempts: [{
      sendIndex: 0,
      sentType: 'text',
      payload: { msgtype: 'text', text: { content: 'valid' } },
    }],
  });
  assert.equal(store.beginNextSend()?.messageKey, validKey);
});

test('startup recovery returns every pending inbound beyond the old 1000-row cap', (t) => {
  const { store } = createStore(t);
  const messages = Array.from({ length: 1_001 }, (_, index) =>
    customerMessage(`recover-${index}`, 'wm-many')
  );
  store.ingestSyncPage({
    openKfId: 'wk-a',
    nextCursor: 'many-cursor',
    messages,
  });
  store.database.exec(`
    UPDATE inbound_messages
    SET status = 'processing', client_input_id = message_key
  `);
  assert.equal(store.recoverStartup().inbound.length, 1_001);
});

test('primary failure also terminates an in-flight steering record', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    openKfId: 'wk-a',
    nextCursor: 'steering-cursor',
    messages: [customerMessage('failure-primary'), customerMessage('failure-steer')],
  });
  const primaryKey = stableMessageKey('wk-a', 'failure-primary');
  const steerKey = stableMessageKey('wk-a', 'failure-steer');
  store.claimInbound({ messageKey: primaryKey });
  store.beginInboundSteering({
    messageKey: steerKey,
    primaryMessageKey: primaryKey,
  });
  store.failInbound(primaryKey, new Error('turn failed'));
  assert.equal(store.getInbound(primaryKey)?.status, 'failed');
  assert.equal(store.getInbound(steerKey)?.status, 'failed');
});

test('[O06][SEC02] composite foreign keys reject cross-customer media and send targets', (t) => {
  const { store } = createStore(t);
  store.ingestSyncPage({
    openKfId: 'wk-a',
    nextCursor: 'fk-cursor',
    messages: [customerMessage('owner', 'wm-owner')],
  });
  const messageKey = stableMessageKey('wk-a', 'owner');
  assert.throws(() =>
    store.database.prepare(`
      INSERT INTO inbound_media (
        message_key, open_kfid, external_userid, position, kind,
        media_id, remembered_at
      ) VALUES (?, 'wk-a', 'wm-other', 0, 'image', 'media', 1)
    `).run(messageKey),
  /FOREIGN KEY/u);
  assert.throws(() =>
    store.database.prepare(`
      INSERT INTO send_attempts (
        attempt_key, source_message_key, open_kfid, external_userid,
        send_index, source, sent_type, fingerprint, client_message_id,
        status, created_at, updated_at
      ) VALUES (
        'bad-attempt', ?, 'wk-a', 'wm-other', 0, 'test', 'text',
        'hash', 'client-id', 'pending', 1, 1
      )
    `).run(messageKey),
  /FOREIGN KEY/u);
});

test('cleanup removes expired blocked fallbacks before their primary audit row', (t) => {
  const { store, clock } = createStore(t);
  const message = customerMessage('cleanup-fallback');
  store.ingestSyncPage({
    openKfId: 'wk-a',
    nextCursor: 'cleanup-cursor',
    messages: [message],
  });
  const messageKey = stableMessageKey('wk-a', message.id);
  const claimed = store.claimInbound({ messageKey }).message;
  store.finalizeInboundBatch({
    messageKey,
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
    attempts: [
      {
        sendIndex: 0,
        sentType: 'location',
        payload: { msgtype: 'location', location: { latitude: 1, longitude: 2 } },
      },
      {
        sendIndex: 1,
        sentType: 'text',
        fallbackForIndex: 0,
        status: 'blocked',
        payload: { msgtype: 'text', text: { content: 'fallback' } },
      },
    ],
  });
  const primary = store.beginNextSend();
  assert.ok(primary);
  store.completeSend(primary.attemptId, { wecomMsgId: 'cleanup-wecom-id' });
  clock.value += 31 * 24 * 60 * 60 * 1_000;
  const cleaned = store.cleanup();
  assert.equal(cleaned.blockedFallbacks, 1);
  assert.equal(inspectAttempts(store.database, messageKey).length, 0);
});
