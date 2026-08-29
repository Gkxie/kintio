import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import type { WecomApiClient } from '../../src/services/wecom-api.ts';
import { WecomSync } from '../../src/services/wecom-sync.ts';
import { SqliteStore, stableMessageKey } from '../../src/state/sqlite-store.ts';

type SyncInput = Parameters<WecomApiClient['syncMessages']>[0];
type SyncResult = Awaited<ReturnType<WecomApiClient['syncMessages']>>;

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

test('sync persists known and unknown messages with the page cursor before enqueueing', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  t.onTestFinished(async () => {
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
        {
          msgid: 'unknown-one',
          external_userid: 'wm-one',
          origin: 3,
          msgtype: 'future_type',
          send_time: 125,
          future_type: { content: 'opaque' },
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
    stableMessageKey('wk-one', 'unknown-one'),
  ]);
  const firstKey = enqueued[0];
  const secondKey = enqueued[1];
  const thirdKey = enqueued[2];
  assert.ok(firstKey && secondKey && thirdKey);
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
  const unknown = store.getInbound(thirdKey);
  assert.equal(unknown?.type, 'unknown');
  assert.equal(asRecord(unknown?.payload?.sync).index, 2);

  await sync.close();
});

test('a live callback during startup catch-up joins the recovery snapshot', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-startup-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  store.ingestSyncPage({
    openKfId: 'wk-one',
    nextCursor: 'cursor-one',
    messages: [],
  });
  let releaseStartup!: () => void;
  const startupBlocked = new Promise<void>((resolve) => { releaseStartup = resolve; });
  const calls: SyncInput[] = [];
  const enqueued: string[] = [];
  const sync = new WecomSync({
    store,
    startPaused: true,
    logger: { info() {}, warn() {}, error() {} },
    apiClient: {
      async syncMessages(input: SyncInput): Promise<SyncResult> {
        calls.push(structuredClone(input));
        if (calls.length === 1) {
          await startupBlocked;
          return {
            next_cursor: 'cursor-two',
            has_more: 0,
            msg_list: [{
              msgid: 'missed', external_userid: 'wm-one', origin: 3,
              msgtype: 'text', text: { content: '停机消息' },
            }],
          };
        }
        return {
          next_cursor: 'cursor-three',
          has_more: 0,
          msg_list: [{
            msgid: 'live', external_userid: 'wm-one', origin: 3,
            msgtype: 'text', text: { content: '刚进线消息' },
          }],
        };
      },
    },
    processor: {
      async enqueue(messageKey: string) { enqueued.push(messageKey); },
    },
  });
  t.onTestFinished(async () => {
    await sync.close();
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const catchUp = sync.catchUp();
  const live = sync.enqueue({ callbackToken: 'live-token', openKfId: 'wk-one' });
  releaseStartup();
  await Promise.all([catchUp, live, sync.waitForIdle()]);

  assert.deepEqual(calls, [
    { cursor: 'cursor-one', callbackToken: '', openKfId: 'wk-one' },
    { cursor: 'cursor-two', callbackToken: 'live-token', openKfId: 'wk-one' },
  ]);
  assert.equal(store.getCursor('wk-one'), 'cursor-three');
  assert.deepEqual(enqueued, []);
  assert.deepEqual(
    store.recoverStartup().inbound.slice(-2).map((record) => record.msgid),
    ['missed', 'live'],
  );
  sync.startConsuming();
});

test('has_more without a new cursor is rejected without advancing state', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-stall-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  t.onTestFinished(async () => {
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
