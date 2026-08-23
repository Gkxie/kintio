import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { SendContractError } from '../../src/domain/send-contract.ts';
import { OutboundPreparer } from '../../src/services/outbound-preparer.ts';
import {
  SqliteStore,
  stableClientMessageId,
  stableMessageKey,
} from '../../src/state/sqlite-store.ts';
import { testWecomMessage } from '../support/wecom-message.ts';

interface Call {
  readonly method: 'clone' | 'thumbnail' | 'upload';
  readonly input?: unknown;
}

async function createHarness(t: TestContext) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'outbound-preparer-'));
  const calls: Call[] = [];
  const mediaGateway = {
    async cloneForSend(input: unknown): Promise<string> {
      calls.push({ method: 'clone', input });
      return 'cloned-image';
    },
    async getCardThumbnailMediaId(): Promise<string> {
      calls.push({ method: 'thumbnail' });
      return 'thumbnail-image';
    },
    async upload(input: unknown): Promise<{ media_id: string }> {
      calls.push({ method: 'upload', input });
      return { media_id: 'uploaded-image' };
    },
  };
  const preparer = new OutboundPreparer({
    mediaGateway,
    spoolDirectory: path.join(directory, 'spool'),
  });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  return { directory, calls, preparer };
}

const customerMedia = [{
  ref: 'media:0',
  messageKey: 'customer-message',
  openKfId: 'wk-one',
  externalUserId: 'wm-one',
  kind: 'image' as const,
  mediaId: 'customer-image',
  filename: 'customer.png',
  sentAt: 1,
  rememberedAt: 1,
}];

test('prepares exact payloads for all five formats', async (t) => {
  const { calls, preparer } = await createHarness(t);
  const prepared = await preparer.prepare({
    messageKey: 'message-all-types',
    mediaCatalog: customerMedia,
    candidates: [
      { type: 'text', content: '说明' },
      { type: 'image', mediaRef: 'media:0' },
      {
        type: 'link', title: '帮助中心', description: '查看说明',
        url: 'https://example.com/help',
      },
      {
        type: 'miniprogram', appId: 'wx1234567890abcdef', title: '服务入口',
        pagePath: 'pages/index', sourceUrl: 'https://example.com/miniprogram',
      },
      {
        type: 'location', name: '天安门', address: '北京市东城区',
        latitude: 39.9087, longitude: 116.3975,
      },
    ],
  });
  assert.deepEqual(prepared.attempts.map((item) => item.payload), [
    { msgtype: 'text', text: { content: '说明' } },
    { msgtype: 'image', image: { media_id: 'cloned-image' } },
    {
      msgtype: 'link',
      link: {
        title: '帮助中心', desc: '查看说明',
        url: 'https://example.com/help', thumb_media_id: 'thumbnail-image',
      },
    },
    {
      msgtype: 'miniprogram',
      miniprogram: {
        appid: 'wx1234567890abcdef', title: '服务入口',
        pagepath: 'pages/index', thumb_media_id: 'thumbnail-image',
      },
    },
    {
      msgtype: 'location',
      location: {
        name: '天安门', address: '北京市东城区',
        latitude: 39.9087, longitude: 116.3975,
      },
    },
  ]);
  assert.equal(calls.filter((item) => item.method === 'clone').length, 1);
  assert.equal(calls.filter((item) => item.method === 'thumbnail').length, 2);
});

test('reserves blocked fallbacks within five slots and rejects a sixth primary', async (t) => {
  const { preparer } = await createHarness(t);
  const prepared = await preparer.prepare({
    messageKey: 'message-fallbacks',
    candidates: [
      {
        type: 'location', name: '甲店', address: '甲路1号',
        latitude: 39.9, longitude: 116.4,
      },
      {
        type: 'link', title: '帮助', description: '说明',
        url: 'https://example.com/help',
      },
    ],
  });
  assert.deepEqual(prepared.attempts.map((item) => ({
    index: item.sendIndex,
    type: item.sentType,
    status: item.status || 'pending',
    fallbackForIndex: item.fallbackForIndex,
  })), [
    { index: 0, type: 'location', status: 'pending', fallbackForIndex: undefined },
    { index: 1, type: 'link', status: 'pending', fallbackForIndex: undefined },
    { index: 2, type: 'text', status: 'blocked', fallbackForIndex: 0 },
    { index: 3, type: 'text', status: 'blocked', fallbackForIndex: 1 },
  ]);
  await assert.rejects(
    preparer.prepare({
      messageKey: 'too-many',
      candidates: Array.from({ length: 6 }, (_, index) => ({
        type: 'location', name: `地点${index}`, address: `地址${index}`,
        latitude: 39, longitude: 116,
      })),
    }),
    (error: unknown) =>
      error instanceof SendContractError && error.code === 'send_budget_exceeded',
  );
});

test('[O08] long text reserves a compact async-delivery fallback', async (t) => {
  const { preparer } = await createHarness(t);
  const content = '北京餐厅特色推荐。'.repeat(30);
  const prepared = await preparer.prepare({
    messageKey: 'long-text-fallback',
    candidates: [{ type: 'text', content }],
  });
  assert.equal(prepared.attempts.length, 2);
  assert.deepEqual(prepared.attempts[0]?.payload, {
    msgtype: 'text', text: { content },
  });
  assert.equal(prepared.attempts[1]?.status, 'blocked');
  assert.equal(prepared.attempts[1]?.fallbackForIndex, 0);
  const fallback = prepared.attempts[1]?.payload.text as { content?: unknown };
  assert.ok(Buffer.byteLength(String(fallback.content), 'utf8') <= 300);
  assert.doesNotMatch(String(fallback.content), /[\r\n•]/u);
  assert.match(String(fallback.content), /…$/u);
});

test('[I04] durable generated-image spool is consumed after a preparation crash', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'generated-spool-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const spoolDirectory = path.join(directory, 'spool');
  const png = Buffer.from('89504e470d0a1a0a02020202', 'hex');
  const first = new OutboundPreparer({
    spoolDirectory,
    mediaGateway: {
      cloneForSend: async () => '',
      getCardThumbnailMediaId: async () => '',
      upload: async () => { throw new Error('temporary upload outage'); },
    },
  });
  const initial = await first.prepare({
    messageKey: 'im_spool_test',
    candidates: [{
      type: 'generated_image', bytes: png, filename: 'generated.png',
      contentType: 'image/png', generationId: 'generation-one',
      revisedPrompt: 'preserve identity',
    }],
  });
  assert.equal(initial.attempts[0]?.sentType, 'text');
  assert.equal(initial.spoolPaths.length, 1);

  const restored = new OutboundPreparer({
    spoolDirectory,
    mediaGateway: {
      cloneForSend: async () => '',
      getCardThumbnailMediaId: async () => '',
      upload: async () => ({ media_id: 'restored-upload' }),
    },
  });
  const recovered = await restored.restoreGenerated('im_spool_test');
  assert.equal(recovered?.attempts[0]?.sentType, 'image');
  assert.deepEqual(recovered?.attempts[0]?.payload, {
    msgtype: 'image', image: { media_id: 'restored-upload' },
  });
  await restored.cleanup(recovered?.spoolPaths || []);
  await Promise.all((recovered?.spoolPaths || []).map((filePath) =>
    assert.rejects(fs.access(filePath), { code: 'ENOENT' }),
  ));
});

test('[R01] SQLite reservation preserves exact payload and stable client IDs', async (t) => {
  const { directory, preparer } = await createHarness(t);
  const store = new SqliteStore({ filePath: path.join(directory, 'state.sqlite') });
  t.after(() => store.close());
  store.ingestSyncPage({
    openKfId: 'wk-one',
    nextCursor: 'cursor-one',
    messages: [testWecomMessage({
      id: 'source-message', openKfId: 'wk-one', externalUserId: 'wm-one',
      text: '发送位置',
    })],
  });
  const messageKey = stableMessageKey('wk-one', 'source-message');
  const claimed = store.claimInbound({ messageKey }).message;
  const prepared = await preparer.prepare({
    messageKey,
    candidates: [{
      type: 'location', name: '天安门', address: '北京市东城区',
      latitude: 39.9087, longitude: 116.3975,
    }],
  });
  const finalized = store.finalizeInboundBatch({
    messageKey,
    expectedConversationEpoch: claimed.claimedConversationEpoch,
    expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
    attempts: [...prepared.attempts],
  });
  for (const item of finalized.attempts) {
    assert.equal(item.clientMessageId, stableClientMessageId(messageKey, item.sendIndex));
  }
  assert.deepEqual(finalized.attempts[0]?.payload, prepared.attempts[0]?.payload);
  assert.equal(finalized.attempts[1]?.status, 'blocked');
});
