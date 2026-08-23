import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { DeliveryService } from '../../src/services/delivery-service.ts';
import { WecomApiError, type WecomApiClient } from '../../src/services/wecom-api.ts';
import {
  SqliteStore,
  type AttemptRecord,
  stableMessageKey,
} from '../../src/state/sqlite-store.ts';
import type { PreparedAttempt } from '../../src/types.ts';
import { inspectAttempt, inspectAttempts } from '../support/sqlite-inspect.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

const silentLogger = Object.freeze({ info() {}, warn() {}, error() {} });

interface ReservedHarness {
  store: SqliteStore;
  messageKey: string;
  attempts: AttemptRecord[];
}

type PreparedSendInput = Parameters<WecomApiClient['sendPreparedMessage']>[0];

async function reserve(
  t: TestContext,
  attempts: readonly PreparedAttempt[],
): Promise<ReservedHarness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-service-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  store.ingestSyncPage({
    openKfId: 'wk-one',
    nextCursor: 'cursor-one',
    messages: [testWecomMessage({
      id: 'source-message',
      openKfId: 'wk-one',
      externalUserId: 'wm-one',
      text: '测试发送',
    })],
  });
  const messageKey = stableMessageKey('wk-one', 'source-message');
  const claimed = store.claimInbound({ messageKey }).message;
  const finalized = store.finalizeInboundBatch({
    messageKey,
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
    attempts,
  });
  t.after(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { store, messageKey, attempts: finalized.attempts };
}

test('accepted delivery uses the exact payload and stable client ID', async (t) => {
  const payload = { msgtype: 'text', text: { content: '只发送一次' } };
  const reserved = await reserve(t, [
    { sendIndex: 0, sentType: 'text', payload },
  ]);
  const calls: PreparedSendInput[] = [];
  const service = new DeliveryService({
    store: reserved.store,
    logger: silentLogger,
    apiClient: {
      async sendPreparedMessage(input: PreparedSendInput) {
        calls.push(structuredClone(input));
        return { msgid: 'accepted-wecom-id' };
      },
    },
  });
  await service.kick();

  const reservedAttempt = reserved.attempts[0];
  assert.ok(reservedAttempt);
  assert.deepEqual(calls, [
    {
      toUser: 'wm-one',
      openKfId: 'wk-one',
      payload,
      messageId: reservedAttempt.clientMessageId,
    },
  ]);
  const attempt = inspectAttempt(reserved.store.database, reservedAttempt.attemptId);
  assert.ok(attempt);
  assert.equal(attempt.status, 'accepted');
  assert.equal(attempt.wecomMsgId, 'accepted-wecom-id');
  assert.equal(reserved.store.getInbound(reserved.messageKey)?.status, 'completed');
  await service.close();
});

test('[O08] definitive failure activates and sends exactly one reserved fallback', async (t) => {
  const reserved = await reserve(t, [
    {
      sendIndex: 0,
      sentType: 'location',
      payload: {
        msgtype: 'location',
        location: {
          name: '地点',
          address: '地址',
          latitude: 39,
          longitude: 116,
        },
      },
    },
    {
      sendIndex: 1,
      sentType: 'text',
      status: 'blocked',
      fallbackForIndex: 0,
      payload: { msgtype: 'text', text: { content: '地点\n地址' } },
    },
  ]);
  const calls: PreparedSendInput[] = [];
  const service = new DeliveryService({
    store: reserved.store,
    logger: silentLogger,
    apiClient: {
      async sendPreparedMessage(input: PreparedSendInput) {
        calls.push(structuredClone(input));
        if (calls.length === 1) {
          throw new WecomApiError('location rejected', {
            code: 40058,
            data: { errcode: 40058 },
          });
        }
        return { msgid: 'fallback-accepted' };
      },
    },
  });
  await service.kick();

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.payload.msgtype, 'location');
  assert.equal(calls[1]?.payload.msgtype, 'text');
  const attempts = inspectAttempts(reserved.store.database, reserved.messageKey);
  assert.deepEqual(
    attempts.map((item) => item.status),
    ['failed', 'accepted'],
  );
  assert.equal(reserved.store.getInbound(reserved.messageKey)?.status, 'completed');
  await service.close();
});

test('[O08][R07] uncertain delivery never activates or sends its fallback', async (t) => {
  const reserved = await reserve(t, [
    {
      sendIndex: 0,
      sentType: 'link',
      payload: {
        msgtype: 'link',
        link: {
          title: '帮助',
          desc: '说明',
          url: 'https://example.com',
          thumb_media_id: 'thumb',
        },
      },
    },
    {
      sendIndex: 1,
      sentType: 'text',
      status: 'blocked',
      fallbackForIndex: 0,
      payload: {
        msgtype: 'text',
        text: { content: '帮助\nhttps://example.com' },
      },
    },
  ]);
  let calls = 0;
  const service = new DeliveryService({
    store: reserved.store,
    logger: silentLogger,
    apiClient: {
      async sendPreparedMessage() {
        calls += 1;
        throw new Error('socket closed before response');
      },
    },
  });
  await service.kick();

  assert.equal(calls, 1);
  const attempts = inspectAttempts(reserved.store.database, reserved.messageKey);
  assert.deepEqual(
    attempts.map((item) => item.status),
    ['uncertain', 'blocked'],
  );
  assert.equal(reserved.store.getInbound(reserved.messageKey)?.status, 'completed');
  await service.close();
});

test('[O08][R07] HTTP 5xx with JSON is uncertain and cannot activate fallback', async (t) => {
  const reserved = await reserve(t, [
    {
      sendIndex: 0,
      sentType: 'location',
      payload: {
        msgtype: 'location',
        location: { name: '地点', address: '地址', latitude: 39, longitude: 116 },
      },
    },
    {
      sendIndex: 1,
      sentType: 'text',
      status: 'blocked',
      fallbackForIndex: 0,
      payload: { msgtype: 'text', text: { content: '文字兜底' } },
    },
  ]);
  let calls = 0;
  const service = new DeliveryService({
    store: reserved.store,
    logger: silentLogger,
    apiClient: {
      async sendPreparedMessage() {
        calls += 1;
        throw new WecomApiError('send_msg returned HTTP 503', {
          data: { errcode: 0, errmsg: 'upstream unavailable' },
        });
      },
    },
  });
  await service.kick();
  assert.equal(calls, 1);
  assert.deepEqual(
    inspectAttempts(reserved.store.database, reserved.messageKey)
      .map((attempt) => attempt.status),
    ['uncertain', 'blocked'],
  );
  await service.close();
});

test('[S07] slow delivery for one customer does not block another customer', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'delivery-concurrency-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'state.sqlite') });
  t.after(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  for (const externalUserId of ['wm-a', 'wm-b']) {
    const msgid = `message-${externalUserId}`;
    store.ingestSyncPage({
      openKfId: 'wk-concurrent',
      expectedCursor: store.getCursor('wk-concurrent'),
      nextCursor: msgid,
      messages: [testWecomMessage({
        id: msgid,
        openKfId: 'wk-concurrent',
        externalUserId,
      })],
    });
    const key = stableMessageKey('wk-concurrent', msgid);
    const claimed = store.claimInbound({ messageKey: key }).message;
    store.finalizeInboundBatch({
      messageKey: key,
      expectedConversationEpoch: claimed.claimedConversationEpoch,
      expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
      attempts: [{
        sendIndex: 0, sentType: 'text',
        payload: { msgtype: 'text', text: { content: externalUserId } },
      }],
    });
  }
  let releaseA!: () => void;
  const blockedA = new Promise<void>((resolve) => { releaseA = resolve; });
  let sentB!: () => void;
  const bAccepted = new Promise<void>((resolve) => { sentB = resolve; });
  const calls: string[] = [];
  const service = new DeliveryService({
    store,
    concurrency: 2,
    logger: silentLogger,
    apiClient: {
      async sendPreparedMessage(input) {
        calls.push(input.toUser);
        if (input.toUser === 'wm-a') await blockedA;
        if (input.toUser === 'wm-b') sentB();
        return { msgid: `wx-${input.toUser}` };
      },
    },
  });
  const kicked = service.kick();
  await bAccepted;
  assert.ok(calls.includes('wm-b'));
  releaseA();
  await kicked;
  assert.deepEqual(calls.sort(), ['wm-a', 'wm-b']);
  await service.close();
});
