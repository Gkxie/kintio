import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import type { WecomApiClient } from '../../src/services/wecom-api.ts';
import { WecomSync } from '../../src/services/wecom-sync.ts';
import { SqliteStore, stableMessageKey } from '../../src/state/sqlite-store.ts';

type SyncInput = Parameters<WecomApiClient['syncMessages']>[0];
type SyncResult = Awaited<ReturnType<WecomApiClient['syncMessages']>>;

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('[G04] sync persists every page and cursor before enqueueing normalized inbox work', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  t.after(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const pages: SyncResult[] = [
    { next_cursor: 'cursor-one', has_more: 1, msg_list: [] },
    {
      next_cursor: 'cursor-two',
      has_more: 0,
      msg_list: [
        {
          msgid: 'customer-one',
          external_userid: 'wm-one',
          origin: 3,
          msgtype: 'text',
          send_time: 123,
          text: { content: '你好' },
        },
        {
          msgid: 'link-one',
          external_userid: 'wm-one',
          origin: 3,
          msgtype: 'link',
          send_time: 124,
          link: {
            title: '主页',
            desc: 'AI 开发',
            url: 'https://example.com/creator',
          },
        },
      ],
    },
  ];
  const syncCalls: SyncInput[] = [];
  const enqueued: string[] = [];
  const sync = new WecomSync({
    store,
    logger: { info() {}, warn() {}, error() {} },
    apiClient: {
      async syncMessages(input: SyncInput): Promise<SyncResult> {
        syncCalls.push(structuredClone(input));
        const page = pages.shift();
        assert.ok(page);
        return page;
      },
    },
    processor: {
      async enqueue(messageKey: string) {
        assert.equal(store.getCursor('wk-one'), 'cursor-two');
        assert.ok(store.getInbound(messageKey));
        enqueued.push(messageKey);
      },
    },
  });

  await sync.enqueue({ callbackToken: 'callback-token', openKfId: 'wk-one' });

  assert.deepEqual(
    syncCalls.map(({ cursor, callbackToken, openKfId }) => ({
      cursor,
      callbackToken,
      openKfId,
    })),
    [
      { cursor: '', callbackToken: 'callback-token', openKfId: 'wk-one' },
      { cursor: 'cursor-one', callbackToken: 'callback-token', openKfId: 'wk-one' },
    ],
  );
  assert.equal(store.getCursor('wk-one'), 'cursor-two');
  assert.deepEqual(enqueued, [
    stableMessageKey('wk-one', 'customer-one'),
    stableMessageKey('wk-one', 'link-one'),
  ]);
  const firstKey = enqueued[0];
  const secondKey = enqueued[1];
  assert.ok(firstKey && secondKey);
  const text = store.getInbound(firstKey);
  const link = store.getInbound(secondKey);
  assert.ok(text?.payload && link?.payload);
  assert.equal(text.payload.text, '你好');
  const textSync = asRecord(text.payload.sync);
  assert.equal(textSync.cursor, 'cursor-one');
  assert.equal(textSync.index, 0);
  assert.equal(typeof link.payload.summary, 'string');
  assert.match(String(link.payload.summary), /AI 开发/u);
  const linkSync = asRecord(link.payload.sync);
  assert.equal(linkSync.index, 1);
  await sync.close();
});

test('has_more without a new cursor is rejected without advancing state', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-stall-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  t.after(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const errors: string[] = [];
  const sync = new WecomSync({
    store,
    processor: { async enqueue() {} },
    apiClient: {
      async syncMessages() {
        return { next_cursor: '', has_more: 1, msg_list: [] };
      },
    },
    logger: {
      info() {},
      warn() {},
      error(message: string) {
        errors.push(message);
      },
    },
  });

  await sync.enqueue({ callbackToken: 'token', openKfId: 'wk-one' });

  assert.equal(store.getCursor('wk-one'), '');
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /has_more=1 without a new cursor/u);
  await sync.close();
});
