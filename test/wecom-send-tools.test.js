import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { SqliteToolJournal } from '../src/state/sqlite-tool-journal.js';
import {
  WecomSendToolError,
  WecomSendTools,
} from '../src/tools/wecom-send-tools.js';

function createHarness({
  mediaCatalog = [],
  mediaCatalogProvider,
  deferSends = false,
  maxSends = 5,
  idempotencyJournal,
  turnId = '',
  calls = [],
} = {}) {
  let nextId = 0;
  const accepted = (method, payload) => {
    calls.push({ method, payload });
    nextId += 1;
    return { errcode: 0, msgid: `wecom-${nextId}` };
  };
  const apiClient = {
    async sendTextMessage(payload) {
      return accepted('text', payload);
    },
    async sendLocationMessage(payload) {
      return accepted('location', payload);
    },
    async sendLinkMessage(payload) {
      return accepted('link', payload);
    },
    async sendMiniProgramMessage(payload) {
      return accepted('miniprogram', payload);
    },
    async sendMediaMessage(payload) {
      return accepted(payload.type, payload);
    },
  };
  const mediaGateway = {
    async getCardThumbnailMediaId() {
      return 'thumbnail-media';
    },
    async cloneForSend(payload) {
      calls.push({ method: 'clone-media', payload });
      return 'cloned-media';
    },
    async upload(payload) {
      calls.push({ method: 'upload-media', payload });
      return { media_id: 'generated-media' };
    },
  };
  const tools = new WecomSendTools({
    apiClient,
    mediaGateway,
    conversation: {
      openKfId: 'wk-bound',
      externalUserId: 'wm-bound',
    },
    mediaCatalog,
    mediaCatalogProvider,
    deferSends,
    maxSends,
    idempotencyJournal,
    turnId,
  });
  return { calls, tools };
}

test('send tools bind every API call to the constructor conversation', async () => {
  const { calls, tools } = createHarness();

  await tools.sendText({ content: '你好' });
  await tools.sendLocation({
    name: '天安门',
    address: '北京市东城区',
    latitude: 39.9087,
    longitude: 116.3975,
  });
  await tools.sendLink({
    title: '帮助中心',
    description: '查看说明',
    url: 'https://example.com/help',
  });
  await tools.sendMiniProgram({
    appId: 'wx1234567890abcdef',
    title: '服务入口',
    pagePath: 'pages/index',
    sourceUrl: 'https://example.com/mini-program',
  });
  const apiCalls = calls.filter((call) => call.method !== 'clone-media');
  assert.equal(apiCalls.length, 4);
  for (const call of apiCalls) {
    assert.equal(call.payload.toUser, 'wm-bound');
    assert.equal(call.payload.openKfId, 'wk-bound');
  }
  assert.equal(tools.remainingSends, 1);
  await tools.sendText({ content: '第五条' });
  assert.equal(tools.remainingSends, 0);
  await assert.rejects(
    () => tools.sendText({ content: '第六条' }),
    (error) =>
      error instanceof WecomSendToolError &&
      error.code === 'send_budget_exceeded',
  );
});

test('image tool accepts only an advertised image reference', async () => {
  const { calls, tools } = createHarness({
    mediaCatalog: [
      {
        ref: 'media:0',
        kind: 'image',
        mediaId: 'customer-image',
        filename: 'photo.png',
      },
      {
        ref: 'media:1',
        kind: 'audio',
        mediaId: 'customer-voice',
        filename: 'voice.amr',
      },
    ],
  });

  const result = await tools.sendImage({ mediaRef: 'media:0' });

  assert.deepEqual(calls, [
    {
      method: 'clone-media',
      payload: {
        kind: 'image',
        sourceMediaId: 'customer-image',
        filename: 'photo.png',
      },
    },
    {
      method: 'image',
      payload: {
        toUser: 'wm-bound',
        openKfId: 'wk-bound',
        type: 'image',
        mediaId: 'cloned-media',
      },
    },
  ]);
  assert.equal(result.receipts[0].sentType, 'image');

  await assert.rejects(
    () => tools.sendImage({ mediaRef: 'media:1' }),
    (error) =>
      error instanceof WecomSendToolError &&
      error.code === 'invalid_media_reference',
  );
  await assert.rejects(
    () => tools.sendImage({ mediaRef: 'media:99' }),
    /unavailable|wrong type/,
  );
});

test('image tool resolves the latest steered-turn media catalog', async () => {
  let currentCatalog = [
    {
      ref: 'media:0',
      kind: 'image',
      mediaId: 'first-image',
      filename: 'first.png',
    },
  ];
  const { calls, tools } = createHarness({
    mediaCatalogProvider: () => currentCatalog,
  });
  currentCatalog = [
    {
      ref: 'media:0',
      kind: 'image',
      mediaId: 'follow-up-image',
      filename: 'follow-up.png',
    },
  ];

  await tools.sendImage({ mediaRef: 'media:0' });

  assert.equal(calls[0].method, 'clone-media');
  assert.equal(calls[0].payload.sourceMediaId, 'follow-up-image');
  assert.equal(calls[0].payload.filename, 'follow-up.png');
});

test('deferred tools validate and stage without calling WeChat', async () => {
  const { calls, tools } = createHarness({
    deferSends: true,
    turnId: 'deferred-turn',
  });

  const result = await tools.sendText({ content: '暂存回复' });

  assert.equal(calls.length, 0);
  assert.equal(result.deferred, true);
  assert.equal(result.receipts[0].status, 'staged');
  assert.match(result.receipts[0].wecomMsgId, /^wb_[0-9a-f]{29}$/u);
});

test('generated image is uploaded and sent with a stable bound target', async () => {
  const calls = [];
  const { tools } = createHarness({ calls, turnId: 'generated-turn' });
  const bytes = Buffer.from('89504e470d0a1a0a00000000', 'hex');

  const result = await tools.sendGeneratedImage({
    bytes,
    filename: 'generated.png',
    contentType: 'image/png',
  });

  assert.equal(calls[0].method, 'upload-media');
  assert.equal(calls[0].payload.bytes, bytes);
  assert.deepEqual(calls[1], {
    method: 'image',
    payload: {
      toUser: 'wm-bound',
      openKfId: 'wk-bound',
      type: 'image',
      mediaId: 'generated-media',
      messageId: calls[1].payload.messageId,
    },
  });
  assert.match(calls[1].payload.messageId, /^wb_[0-9a-f]{29}$/u);
  assert.equal(result.receipts[0].sentType, 'image');
});

test('long text consumes the actual WeChat message budget', async () => {
  const { calls, tools } = createHarness({ maxSends: 2 });
  const content = '你'.repeat(900);

  const result = await tools.sendText({ content });

  assert.equal(calls.length, 2);
  assert.equal(result.receipts.length, 2);
  assert.equal(result.remainingSends, 0);
  assert.ok(
    calls.every(
      (call) => Buffer.byteLength(call.payload.content, 'utf8') <= 2048,
    ),
  );
});

test('SQLite journal prevents a restarted tool process from sending twice', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-tool-idempotency-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journalPath = path.join(directory, 'journal.sqlite');
  const calls = [];
  const first = createHarness({
    calls,
    turnId: 'customer-message-one',
    idempotencyJournal: new SqliteToolJournal({ filePath: journalPath }),
  }).tools;

  const firstResult = await first.sendText({ content: '只发送一次' });
  first.close();
  const second = createHarness({
    calls,
    turnId: 'customer-message-one',
    idempotencyJournal: new SqliteToolJournal({ filePath: journalPath }),
  }).tools;
  const secondResult = await second.sendText({ content: '只发送一次' });
  second.close();

  assert.equal(calls.length, 1);
  assert.match(calls[0].payload.messageId, /^wb_[0-9a-f]{29}$/);
  assert.deepEqual(secondResult.receipts, firstResult.receipts);
});

test('an interrupted sending record becomes uncertain without another API call', async (t) => {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'wechat-tool-uncertain-'),
  );
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const journalPath = path.join(directory, 'journal.sqlite');
  const interrupted = new SqliteToolJournal({ filePath: journalPath });
  await interrupted.begin({
    key: 'crashed-customer-message:0',
    fingerprint: 'previous-fingerprint',
    sentType: 'text',
    clientMessageId: 'wb_previous_uncertain_message',
  });
  interrupted.close();
  const calls = [];
  const tools = createHarness({
    calls,
    turnId: 'crashed-customer-message',
    idempotencyJournal: new SqliteToolJournal({ filePath: journalPath }),
  }).tools;

  const result = await tools.sendText({ content: '可能已经发送' });
  tools.close();

  assert.equal(calls.length, 0);
  assert.deepEqual(result.receipts, [
    {
      wecomMsgId: 'wb_previous_uncertain_message',
      sentType: 'text',
      status: 'uncertain',
    },
  ]);
});
