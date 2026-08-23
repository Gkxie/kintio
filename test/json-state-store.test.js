import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { JsonStateStore } from '../src/state/json-state-store.js';

test('JSON state persists cursors, threads, and partial reply progress', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wechat-bot-state-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  const firstStore = new JsonStateStore({ filePath });

  await firstStore.setCursor('wk-one', 'cursor-one');
  await firstStore.setThreadId('wk-one:wm-one', 'thread-one');
  await firstStore.setSession('wk-one:wm-one', {
    mode: 'human',
    servicerUserId: 'admin-one',
  });
  await firstStore.setGeneratedMessage('message-one', {
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    responseChunks: ['first', 'second'],
  });
  await firstStore.markChunkSent('message-one', 1);
  await firstStore.setGeneratedMessage('message-two', {
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    outboundMessages: [
      {
        type: 'link',
        link: {
          title: '门店',
          description: '北京市海淀区',
          url: 'https://maps.apple.com/place?place-id=example',
        },
      },
    ],
  });
  await firstStore.markChunkSent('message-two', 1, {
    wecomMsgId: 'wecom-outbound-one',
    sentType: 'link',
  });
  await firstStore.markMessageSent('message-two');
  assert.equal(
    await firstStore.markOutboundFailed({
      wecomMsgId: 'wecom-outbound-one',
      failType: 10,
    }),
    true,
  );
  await firstStore.rememberInboundAttachments({
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    messageId: 'customer-image',
    sentAt: 123,
    attachments: [
      { kind: 'image', mediaId: 'inbound-image', filename: 'photo.png' },
    ],
  });

  const secondStore = new JsonStateStore({ filePath });

  assert.equal(await secondStore.getCursor('wk-one'), 'cursor-one');
  assert.equal(await secondStore.getThreadId('wk-one:wm-one'), 'thread-one');
  assert.equal((await secondStore.getSession('wk-one:wm-one')).mode, 'human');
  assert.deepEqual(await secondStore.getMessage('message-one'), {
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    responseChunks: ['first', 'second'],
    status: 'generated',
    sentChunks: 1,
    updatedAt: (await secondStore.getMessage('message-one')).updatedAt,
  });
  assert.deepEqual(
    await secondStore.getRecentOutboundMessages({
      openKfId: 'wk-one',
      externalUserId: 'wm-one',
    }),
    [
      {
        type: 'link',
        link: {
          title: '门店',
          description: '北京市海淀区',
          url: 'https://maps.apple.com/place?place-id=example',
        },
      },
    ],
  );
  const recentMedia = await secondStore.getRecentInboundAttachments({
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
  });
  assert.equal(recentMedia.length, 1);
  assert.equal(recentMedia[0].messageId, 'customer-image');
  assert.equal(recentMedia[0].kind, 'image');
  assert.equal(recentMedia[0].mediaId, 'inbound-image');
  const failedMessage = await secondStore.getMessage('message-two');
  assert.equal(failedMessage.deliveryStatus, 'failed');
  assert.equal(failedMessage.sendReceipts[0].status, 'failed');
  assert.equal(failedMessage.sendReceipts[0].failType, 10);

  const mode = (await fs.stat(filePath)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('JSON state persists idempotent customer self-authorization', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-authorization-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  const firstStore = new JsonStateStore({ filePath });
  const first = await firstStore.evaluateCustomerAuthorization({
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    messageId: 'trigger-one',
    isTrigger: true,
    requiredConsecutive: 3,
  });
  const duplicate = await firstStore.evaluateCustomerAuthorization({
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    messageId: 'trigger-one',
    isTrigger: true,
    requiredConsecutive: 3,
  });

  assert.equal(first.consecutiveMatches, 1);
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.consecutiveMatches, 1);

  const secondStore = new JsonStateStore({ filePath });
  await secondStore.evaluateCustomerAuthorization({
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    messageId: 'trigger-two',
    isTrigger: true,
    requiredConsecutive: 3,
  });
  const third = await secondStore.evaluateCustomerAuthorization({
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    messageId: 'trigger-three',
    isTrigger: true,
    requiredConsecutive: 3,
  });

  assert.equal(third.allowed, false);
  assert.equal(third.newlyAuthorized, true);
  assert.equal(
    (await secondStore.getMessage('trigger-three')).status,
    'authorization_pending',
  );
  await secondStore.markChunkSent('trigger-three', 1, {
    wecomMsgId: 'authorization-confirmation',
    sentType: 'text',
  });
  await secondStore.markMessageSent('trigger-three');

  const thirdStore = new JsonStateStore({ filePath });
  const authorization = await thirdStore.getCustomerAuthorization('wm-one');
  assert.equal(authorization.authorized, true);
  assert.equal(authorization.consecutiveMatches, 3);
  assert.equal((await thirdStore.getMessage('trigger-three')).status, 'sent');
});

test('JSON state persists active and absorbed steering records', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-steering-state-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const filePath = path.join(directory, 'state.json');
  const store = new JsonStateStore({ filePath });

  await store.setProcessingMessage('primary-one', {
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
  });
  await store.setSteeredMessage('follow-up-one', {
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    primaryMessageId: 'primary-one',
  });
  assert.equal((await store.getMessage('primary-one')).status, 'processing');
  assert.equal((await store.getMessage('follow-up-one')).status, 'steered');

  await store.setGeneratedMessage('primary-one', {
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    outboundMessages: [{ type: 'text', content: 'combined' }],
  });
  await store.markMessageSent('primary-one');
  await store.markSteeredMessagesAbsorbed('primary-one');

  const reloaded = new JsonStateStore({ filePath });
  assert.equal((await reloaded.getMessage('primary-one')).status, 'sent');
  assert.equal((await reloaded.getMessage('follow-up-one')).status, 'absorbed');
});

test('JSON state exposes the latest successful generated-image delivery', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-bot-generated-delivery-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const store = new JsonStateStore({
    filePath: path.join(directory, 'state.json'),
  });
  await store.setGeneratedMessage('generated-delivery-one', {
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    outboundMessages: [],
    toolDispatches: [
      {
        tool: 'send_generated_image',
        arguments: {
          byteLength: 1234,
          revisedPrompt: 'preserve all unmentioned visual properties',
        },
      },
    ],
    sendReceipts: [
      {
        wecomMsgId: 'generated-wechat-message',
        sentType: 'image',
        status: 'accepted',
      },
    ],
  });
  await store.markMessageSent('generated-delivery-one');

  const delivery = await store.getLatestGeneratedImageDelivery({
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
  });
  assert.equal(delivery.delivered, true);
  assert.equal(delivery.byteLength, 1234);
  assert.equal(
    delivery.revisedPrompt,
    'preserve all unmentioned visual properties',
  );
});
