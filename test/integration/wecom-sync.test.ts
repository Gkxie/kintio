import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';

import type { WecomApiClient } from '../../src/services/wecom-api.ts';
import { WecomApiError } from '../../src/services/wecom-api.ts';
import { WecomSync } from '../../src/services/wecom-sync.ts';
import { stableMessageKey } from '../../src/state/sqlite-store.ts';
import { StatePersistence } from '../../src/state/persistence.ts';

type SyncInput = Parameters<WecomApiClient['syncMessages']>[0];
type SyncResult = Awaited<ReturnType<WecomApiClient['syncMessages']>>;

function asRecord(value: unknown): Record<string, unknown> {
  assert.ok(value && typeof value === 'object' && !Array.isArray(value));
  return value as Record<string, unknown>;
}

async function waitFor(
  predicate: () => boolean,
  message: string,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
  }
}

test('sync persists known and unknown messages with the page cursor before enqueueing', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const store = persistence.core;
  t.onTestFinished(async () => {
    persistence.close();
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
  await sync.waitForIdle();

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
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const store = persistence.core;
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
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const catchUp = sync.catchUp();
  sync.startConsuming();
  const live = sync.enqueue({ callbackToken: 'live-token', openKfId: 'wk-one' });
  releaseStartup();
  await Promise.all([catchUp, live, sync.waitForIdle()]);

  assert.deepEqual(calls, [
    { cursor: 'cursor-one', callbackToken: '', openKfId: 'wk-one' },
    { cursor: 'cursor-two', callbackToken: 'live-token', openKfId: 'wk-one' },
  ]);
  assert.equal(store.getCursor('wk-one'), 'cursor-three');
  assert.deepEqual(enqueued, [
    stableMessageKey('wk-one', 'missed'),
    stableMessageKey('wk-one', 'live'),
  ]);
  assert.deepEqual(
    store.recoverStartup().inbound.slice(-2).map((record) => record.msgid),
    ['missed', 'live'],
  );
});

test('a live callback preempts startup catch-up after the current cursor page', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-preempt-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const store = persistence.core;
  store.ingestSyncPage({
    openKfId: 'wk-one',
    nextCursor: 'cursor-one',
    messages: [],
  });
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const calls: SyncInput[] = [];
  const enqueued: string[] = [];
  let releaseProcessing!: () => void;
  const processingBlocked = new Promise<void>((resolve) => {
    releaseProcessing = resolve;
  });
  const sync = new WecomSync({
    store,
    startPaused: true,
    logger: { info() {}, warn() {}, error() {} },
    apiClient: {
      async syncMessages(input: SyncInput): Promise<SyncResult> {
        calls.push(structuredClone(input));
        if (calls.length === 1) {
          markFirstStarted();
          await firstBlocked;
          return {
            next_cursor: 'cursor-two',
            has_more: 1,
            msg_list: [{
              msgid: 'live-current-page', external_userid: 'wm-one', origin: 3,
              msgtype: 'text', text: { content: '刚进线消息' },
            }],
          };
        }
        return {
          next_cursor: 'cursor-three',
          has_more: 0,
          msg_list: [],
        };
      },
    },
    processor: {
      async enqueue(messageKey: string) {
        enqueued.push(messageKey);
        await processingBlocked;
      },
    },
  });
  t.onTestFinished(async () => {
    releaseFirst();
    releaseProcessing();
    await sync.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const catchUp = sync.catchUp();
  await firstStarted;
  const live = sync.enqueue({ callbackToken: 'live-token', openKfId: 'wk-one' });
  sync.startConsuming();
  releaseFirst();
  let liveTimeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      (async () => {
        while (calls.length < 2) {
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
        }
      })(),
      new Promise<never>((_resolve, reject) => {
        liveTimeout = setTimeout(
          () => reject(new Error('live sync waited for backlog processing')),
          500,
        );
      }),
    ]);
  } finally {
    clearTimeout(liveTimeout);
  }
  releaseProcessing();
  await Promise.all([catchUp, live, sync.waitForIdle()]);

  assert.deepEqual(calls, [
    { cursor: 'cursor-one', callbackToken: '', openKfId: 'wk-one' },
    { cursor: 'cursor-two', callbackToken: 'live-token', openKfId: 'wk-one' },
  ]);
  assert.equal(store.getCursor('wk-one'), 'cursor-three');
  const liveKey = stableMessageKey('wk-one', 'live-current-page');
  assert.deepEqual(enqueued, [liveKey]);
  assert.equal(store.getInbound(liveKey)?.deferred, false);
});

test('live-page conversations enqueue before unrelated preempted backlog', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-live-first-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const store = persistence.core;
  store.ingestSyncPage({
    openKfId: 'wk-one',
    nextCursor: 'cursor-one',
    messages: [],
  });
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const enqueued: string[] = [];
  let call = 0;
  const sync = new WecomSync({
    store,
    startPaused: true,
    logger: { info() {}, warn() {}, error() {} },
    apiClient: {
      async syncMessages(): Promise<SyncResult> {
        call += 1;
        if (call === 1) {
          markFirstStarted();
          await firstBlocked;
          return {
            next_cursor: 'cursor-two',
            has_more: 1,
            msg_list: Array.from({ length: 11 }, (_, index) => ({
              msgid: `missed-${index}`,
              external_userid: `wm-${index}`,
              origin: 3,
              msgtype: 'text',
              text: { content: `停机消息 ${index}` },
            })),
          };
        }
        if (call === 2) {
          return {
            next_cursor: 'cursor-three',
            has_more: 1,
            msg_list: Array.from({ length: 11 }, (_, index) => ({
              msgid: `live-drain-backlog-${index}`,
              external_userid: `wm-live-backlog-${index}`,
              origin: 3,
              msgtype: 'text',
              text: { content: `同步中的旧消息 ${index}` },
            })),
          };
        }
        return {
          next_cursor: 'cursor-four',
          has_more: 0,
          msg_list: [{
            msgid: 'live-next-page',
            external_userid: 'wm-live',
            origin: 3,
            msgtype: 'text',
            text: { content: '刚进线消息' },
          }],
        };
      },
    },
    processor: {
      async enqueue(messageKey: string) { enqueued.push(messageKey); },
    },
  });
  t.onTestFinished(async () => {
    releaseFirst();
    await sync.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  const catchUp = sync.catchUp();
  await firstStarted;
  const live = sync.enqueue({ callbackToken: 'live-token', openKfId: 'wk-one' });
  sync.startConsuming();
  releaseFirst();
  await Promise.all([catchUp, live, sync.waitForIdle()]);

  assert.equal(enqueued[0], stableMessageKey('wk-one', 'live-next-page'));
  assert.equal(enqueued.length, 12);
  for (let index = 0; index < 11; index += 1) {
    assert.equal(
      store.getInbound(stableMessageKey('wk-one', `missed-${index}`))?.deferred,
      true,
    );
  }
});

test('has_more without a new cursor is rejected without advancing state', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-stall-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const store = persistence.core;
  t.onTestFinished(async () => {
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const errors: string[] = [];
  let call = 0;
  const sync = new WecomSync({
    store,
    processor: { async enqueue() {} },
    apiClient: {
      async syncMessages() {
        call += 1;
        return call === 1
          ? { next_cursor: '', has_more: 1, msg_list: [] }
          : { next_cursor: '', has_more: 0, msg_list: [] };
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
  await waitFor(() => call === 2, 'stalled sync did not retry');
  await sync.waitForIdle();

  assert.equal(store.getCursor('wk-one'), '');
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /has_more=1 without a new cursor/u);
  await sync.close();
});

test('live pages committed before a later sync failure are still enqueued', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-partial-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const store = persistence.core;
  const errors: string[] = [];
  const enqueued: string[] = [];
  let call = 0;
  const sync = new WecomSync({
    store,
    processor: {
      async enqueue(messageKey: string) {
        enqueued.push(messageKey);
      },
    },
    apiClient: {
      async syncMessages(): Promise<SyncResult> {
        call += 1;
        if (call === 1) {
          return {
            next_cursor: 'cursor-one',
            has_more: 1,
            msg_list: [{
              msgid: 'committed-before-failure',
              external_userid: 'wm-one',
              origin: 3,
              msgtype: 'text',
              text: { content: '已经入库的实时消息' },
            }],
          };
        }
        if (call === 2) throw new Error('temporary sync failure');
        return { next_cursor: 'cursor-two', has_more: 0, msg_list: [] };
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
  t.onTestFinished(async () => {
    await sync.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await sync.enqueue({ callbackToken: 'token', openKfId: 'wk-one' });
  await waitFor(() => call === 3, 'partial sync did not resume after failure');
  await sync.waitForIdle();

  const key = stableMessageKey('wk-one', 'committed-before-failure');
  assert.equal(store.getCursor('wk-one'), 'cursor-two');
  assert.equal(store.getInbound(key)?.deferred, false);
  assert.deepEqual(enqueued, [key]);
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /temporary sync failure/u);
});

test('a lone callback retries its first failed sync without another callback', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-retry-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const store = persistence.core;
  const errors: string[] = [];
  const enqueued: string[] = [];
  let call = 0;
  const sync = new WecomSync({
    store,
    processor: {
      async enqueue(messageKey: string) {
        enqueued.push(messageKey);
      },
    },
    apiClient: {
      async syncMessages(input: SyncInput): Promise<SyncResult> {
        call += 1;
        assert.equal(input.callbackToken, 'only-callback-token');
        if (call === 1) throw new Error('network unavailable');
        return {
          next_cursor: 'cursor-one',
          has_more: 0,
          msg_list: [{
            msgid: 'arrived-on-retry',
            external_userid: 'wm-one',
            origin: 3,
            msgtype: 'text',
            text: { content: '只回调了一次' },
          }],
        };
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
  t.onTestFinished(async () => {
    await sync.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  await sync.enqueue({
    callbackToken: 'only-callback-token',
    openKfId: 'wk-one',
  });
  await waitFor(() => call === 2, 'lone callback did not retry');
  await sync.waitForIdle();

  const key = stableMessageKey('wk-one', 'arrived-on-retry');
  assert.equal(call, 2);
  assert.deepEqual(store.listSyncOpenKfIds(), ['wk-one']);
  assert.deepEqual(enqueued, [key]);
  assert.equal(store.getCursor('wk-one'), 'cursor-one');
  assert.equal(errors.length, 1);
  assert.match(errors[0] ?? '', /network unavailable; retry_ms=250/u);
});

test('callbacks for one account coalesce into one in-flight run and one rerun', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-coalesce-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const store = persistence.core;
  let releaseFirst!: () => void;
  const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
  let markFirstStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { markFirstStarted = resolve; });
  const calls: SyncInput[] = [];
  const sync = new WecomSync({
    store,
    processor: { async enqueue() {} },
    apiClient: {
      async syncMessages(input: SyncInput): Promise<SyncResult> {
        calls.push(structuredClone(input));
        if (calls.length === 1) {
          markFirstStarted();
          await firstBlocked;
          return { next_cursor: 'cursor-one', has_more: 0, msg_list: [] };
        }
        return { next_cursor: 'cursor-two', has_more: 0, msg_list: [] };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(async () => {
    releaseFirst();
    await sync.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  assert.equal(sync.enqueue({ callbackToken: 'token-0', openKfId: 'wk-one' }), true);
  await firstStarted;
  for (let index = 1; index <= 100; index += 1) {
    assert.equal(
      sync.enqueue({ callbackToken: `token-${index}`, openKfId: 'wk-one' }),
      true,
    );
  }
  releaseFirst();
  await sync.waitForIdle();

  assert.equal(calls.length, 2);
  assert.equal(calls[0]?.callbackToken, 'token-0');
  assert.equal(calls[1]?.callbackToken, 'token-100');
  assert.deepEqual(calls.map((call) => call.cursor), ['', 'cursor-one']);
});

test('shutdown cancels a scheduled sync retry', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-stop-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const store = persistence.core;
  let calls = 0;
  const errors: string[] = [];
  const sync = new WecomSync({
    store,
    processor: { async enqueue() {} },
    apiClient: {
      async syncMessages(): Promise<SyncResult> {
        calls += 1;
        throw new Error('network unavailable');
      },
    },
    logger: {
      info() {},
      warn() {},
      error(message: string) { errors.push(message); },
    },
  });
  t.onTestFinished(async () => {
    await sync.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  assert.equal(sync.enqueue({ callbackToken: 'token', openKfId: 'wk-one' }), true);
  await waitFor(() => errors.length === 1, 'failed sync did not schedule retry');
  sync.stopAccepting();
  await new Promise<void>((resolve) => setTimeout(resolve, 300));

  assert.equal(calls, 1);
  assert.equal(sync.enqueue({ callbackToken: 'late', openKfId: 'wk-one' }), false);
});

test('provider business errors use a slow jittered retry instead of a hot loop', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-provider-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const store = persistence.core;
  const errors: string[] = [];
  const sync = new WecomSync({
    store,
    processor: { async enqueue() {} },
    apiClient: {
      async syncMessages(): Promise<SyncResult> {
        throw new WecomApiError('invalid provider configuration', { code: 40013 });
      },
    },
    logger: {
      info() {},
      warn() {},
      error(message: string) { errors.push(message); },
    },
  });
  t.onTestFinished(async () => {
    await sync.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  assert.equal(sync.enqueue({ callbackToken: 'token', openKfId: 'wk-one' }), true);
  await waitFor(() => errors.length === 1, 'provider error did not schedule retry');
  const retryMs = Number(errors[0]?.match(/retry_ms=(\d+)/u)?.[1]);
  assert.ok(retryMs >= 300_000 && retryMs <= 360_000);
});

test('message synchronization caps provider request concurrency across accounts', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'wecom-sync-limit-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const store = persistence.core;
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let active = 0;
  let maximum = 0;
  let calls = 0;
  const sync = new WecomSync({
    store,
    processor: { async enqueue() {} },
    apiClient: {
      async syncMessages(): Promise<SyncResult> {
        calls += 1;
        active += 1;
        maximum = Math.max(maximum, active);
        await blocked;
        active -= 1;
        return { next_cursor: `cursor-${calls}`, has_more: 0, msg_list: [] };
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  t.onTestFinished(async () => {
    release();
    await sync.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });

  for (let index = 0; index < 10; index += 1) {
    assert.equal(
      sync.enqueue({ callbackToken: `token-${index}`, openKfId: `wk-${index}` }),
      true,
    );
  }
  await waitFor(() => calls === 4, 'sync request limit was not reached');
  assert.equal(maximum, 4);
  release();
  await sync.waitForIdle();

  assert.equal(calls, 10);
  assert.equal(maximum, 4);
});
