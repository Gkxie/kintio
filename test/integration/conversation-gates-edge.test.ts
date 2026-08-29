import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.ts';
import type { AgentInput } from '../../src/agent/runtime.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { WechatKfToolExecutor } from '../../src/mcp/wechat-kf-executor.ts';
import { SqliteStore } from '../../src/state/sqlite-store.ts';
import {
  SimulatedToolAgent,
  type SimulatedAgentCompletion,
  type SimulatedAgentSubmission,
} from '../support/executing-agent.ts';
import { inspectAttempts } from '../support/sqlite-inspect.ts';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

interface Harness {
  readonly store: SqliteStore;
  readonly processor: ConversationProcessor;
  readonly inputs: AgentInput[];
  readonly downloads: string[];
  readonly errors: string[];
  ingest(raw: Record<string, unknown>): string;
}

async function createHarness(
  t: TestContext,
  handler: (input: AgentInput, store: SqliteStore) => Promise<SimulatedAgentSubmission>,
  resolveMedia: (input: AgentInput['message']) => Promise<readonly []> = async () => [],
  allowedUserIds: readonly string[] = ['wm-one'],
): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-gates-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  const inputs: AgentInput[] = [];
  const downloads: string[] = [];
  const errors: string[] = [];
  let sendSequence = 0;
  let cursor = '';
  const codexAgent = {
    async submit(input: AgentInput): Promise<SimulatedAgentSubmission> {
      inputs.push(input);
      return handler(input, store);
    },
    async close() {},
    async abort() {},
  };
  const channel = new WechatKfToolExecutor({
    store,
    apiClient: {
      async sendPreparedMessage() {
        sendSequence += 1;
        return { msgid: `wx-${sendSequence}` };
      },
    },
    mediaGateway: {
      async upload() { return { media_id: 'uploaded' }; },
      async cloneForSend() { return 'cloned'; },
      async getCardThumbnailMediaId() { return 'thumbnail'; },
    },
    observeMs: 0,
    logger: { info() {}, error() {} },
  });
  const processor = new ConversationProcessor({
    store,
    agent: new SimulatedToolAgent({ inner: codexAgent, tools: channel }),
    mediaGateway: {
      async resolveForCodex(message) {
        downloads.push(message.messageKey);
        return resolveMedia(message);
      },
    },
    channel,
    allowedUserIds,
    authorization: { trigger: '发车', requiredConsecutive: 3 },
    logger: {
      info() {},
      error(message) { errors.push(message); },
    },
  });

  function ingest(raw: Record<string, unknown>): string {
    const next = `${cursor}-${String(raw.msgid)}`;
    const result = store.ingestSyncPage({
      openKfId: 'wk-one', expectedCursor: cursor, nextCursor: next,
      messages: [normalizeWecomMessage(raw, 'wk-one', { cursor, index: 0 })],
    });
    cursor = next;
    const key = result.insertedMessageKeys[0];
    if (!key) throw new Error('Expected inserted gate message');
    return key;
  }

  t.onTestFinished(async () => {
    await processor.abort();
    await channel.close();
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { store, processor, inputs, downloads, errors, ingest };
}

function customer(msgid: string, content: string, overrides: Record<string, unknown> = {}) {
  return {
    msgid, open_kfid: 'wk-one', external_userid: 'wm-one',
    origin: 3, msgtype: 'text', text: { content }, ...overrides,
  };
}

function started(
  input: AgentInput,
  completion: Promise<SimulatedAgentCompletion>,
): SimulatedAgentSubmission {
  return {
    kind: 'started', primaryMessageKey: input.message.messageKey, turnId: 'turn-gate',
    threadId: input.threadId,
    completion,
  };
}

function immediate(input: AgentInput): SimulatedAgentSubmission {
  return started(input, Promise.resolve({
    replies: [{ type: 'text', content: 'reply' }],
  }));
}

test('malformed records and unsupported origin=5 are ignored without side effects', async (t) => {
  const harness = await createHarness(t, async (input) => immediate(input));
  const keys = [
    harness.ingest(customer('bad-customer', 'x', { external_userid: '' })),
    harness.ingest({
      msgid: 'unsupported-origin', open_kfid: 'wk-one', external_userid: 'wm-one',
      origin: 5, msgtype: 'text', text: { content: 'x' },
    }),
    harness.ingest({
      msgid: 'bad-system', origin: 4, msgtype: 'event',
      event: { event_type: 'future_event' },
    }),
  ];
  for (const key of keys) await harness.processor.enqueue(key);
  assert.deepEqual(keys.map((key) => harness.store.getInbound(key)?.status), [
    'ignored', 'ignored', 'ignored',
  ]);
  assert.equal(harness.inputs.length, 0);
  assert.equal(harness.downloads.length, 0);
  assert.ok(keys.every((key) => harness.store.listMessageAttempts(key).length === 0));
});

test('unsupported message resets unauthorized trigger progress without Codex or media', async (t) => {
  const harness = await createHarness(
    t,
    async (input) => immediate(input),
    async () => [],
    [],
  );
  const messages = [
    customer('one', '发车'),
    customer('unknown', '', { msgtype: 'future_type', text: undefined }),
    customer('two', '发车'),
    customer('three', '发车'),
  ];
  for (const raw of messages) await harness.processor.enqueue(harness.ingest(raw));
  assert.equal(harness.store.getAuthorization('wm-one')?.authorized, false);
  assert.equal(harness.store.getAuthorization('wm-one')?.consecutiveMatches, 2);
  assert.equal(harness.inputs.length, 0);
  assert.equal(harness.downloads.length, 0);
});

test('media download failure leaves received input recoverable and never starts Codex', async (t) => {
  const harness = await createHarness(
    t,
    async (input) => immediate(input),
    async () => { throw new Error('download unavailable'); },
  );
  const key = harness.ingest(customer('image', '', {
    msgtype: 'image', text: undefined, image: { media_id: 'image-id' },
  }));
  await harness.processor.enqueue(key);
  assert.equal(harness.store.getInbound(key)?.status, 'received');
  assert.equal(harness.inputs.length, 0);
  assert.match(harness.errors[0] || '', /download unavailable/u);
});

test('transient media failure retries online and completes without a duplicate send', async (t) => {
  let calls = 0;
  const harness = await createHarness(
    t,
    async (input) => immediate(input),
    async () => {
      calls += 1;
      if (calls < 3) throw new Error('temporary media outage');
      return [];
    },
  );
  const key = harness.ingest(customer('image-retry', '', {
    msgtype: 'image', text: undefined, image: { media_id: 'image-id' },
  }));
  await harness.processor.enqueue(key);
  await harness.processor.waitForIdle();
  assert.equal(calls, 3);
  assert.equal(harness.inputs.length, 1);
  assert.equal(harness.store.getInbound(key)?.status, 'completed');
  assert.equal(inspectAttempts(harness.store.database, key).length, 1);
});

test('synchronous Codex start failure preserves claimed input for recovery', async (t) => {
  const harness = await createHarness(t, async () => {
    throw new Error('turn start failed');
  });
  const key = harness.ingest(customer('start-fail', 'x'));
  await harness.processor.enqueue(key);
  assert.equal(harness.store.getInbound(key)?.status, 'processing');
  assert.match(harness.errors[0] || '', /turn start failed/u);
});

test('transient Agent start failure inspects recovery state and succeeds online', async (t) => {
  let calls = 0;
  const harness = await createHarness(t, async (input) => {
    calls += 1;
    if (calls === 1) throw new Error('temporary turn start failure');
    return immediate(input);
  });
  const key = harness.ingest(customer('start-retry', 'x'));
  await harness.processor.enqueue(key);
  await harness.processor.waitForIdle();
  assert.equal(calls, 2);
  assert.equal(harness.store.getInbound(key)?.status, 'completed');
  assert.equal(inspectAttempts(harness.store.database, key).length, 1);
});

test('synchronous steer failure requeues follow-up while primary remains active', async (t) => {
  const pending = new Promise<SimulatedAgentCompletion>(() => {});
  const harness = await createHarness(t, async (input) => {
    if (input.mode === 'start') {
      return started(input, pending);
    }
    throw new Error('steer rejected');
  });
  const primaryKey = harness.ingest(customer('primary', 'x'));
  const followKey = harness.ingest(customer('follow', 'adjust'));
  await harness.processor.enqueue(primaryKey);
  await harness.processor.enqueue(followKey);
  assert.equal(harness.store.getInbound(primaryKey)?.status, 'preparing');
  assert.equal(harness.store.getInbound(followKey)?.status, 'received');
  assert.match(harness.errors.at(-1) || '', /steer rejected/u);
  await harness.processor.abort();
});

test('asynchronous completion failure marks primary failed in background tracker', async (t) => {
  const harness = await createHarness(t, async (input) =>
    started(input, Promise.reject(new Error('background failed'))),
  );
  const key = harness.ingest(customer('background', 'x'));
  await harness.processor.enqueue(key);
  await harness.processor.waitForIdle();
  assert.equal(harness.store.getInbound(key)?.status, 'failed');
  assert.match(harness.store.getInbound(key)?.errorMessage || '', /background failed/u);
});

test('transient asynchronous completion failure is re-enqueued with a bounded recovery', async (t) => {
  let calls = 0;
  const harness = await createHarness(t, async (input) => {
    calls += 1;
    return calls === 1
      ? started(input, Promise.reject(new Error('temporary completion failure')))
      : immediate(input);
  });
  const key = harness.ingest(customer('completion-retry', 'x'));
  await harness.processor.enqueue(key);
  await harness.processor.waitForIdle();
  assert.equal(calls, 2);
  assert.equal(harness.store.getInbound(key)?.status, 'completed');
  assert.equal(inspectAttempts(harness.store.database, key).length, 1);
});

test('repeated completion validation failure stops after two online recoveries', async (t) => {
  let calls = 0;
  const harness = await createHarness(t, async (input) => {
    calls += 1;
    return started(input, Promise.resolve({}));
  });
  const key = harness.ingest(customer('completion-bounded', 'x'));
  await harness.processor.enqueue(key);
  await harness.processor.waitForIdle();
  assert.equal(calls, 3);
  assert.equal(harness.store.getInbound(key)?.status, 'failed');
  assert.equal(inspectAttempts(harness.store.database, key).length, 0);
});

test('no-action decision is rejected outside recovery with a terminal attempt', async (t) => {
  let calls = 0;
  const harness = await createHarness(t, async (input) => {
    calls += 1;
    return started(input, Promise.resolve({ decision: 'no_action' }));
  });
  const key = harness.ingest(customer('no-action-denied', 'x'));
  await harness.processor.enqueue(key);
  await harness.processor.waitForIdle();
  assert.equal(calls, 3);
  assert.equal(harness.store.getInbound(key)?.status, 'failed');
  assert.equal(inspectAttempts(harness.store.database, key).length, 0);
});

test('failed primary with two steers recovers the latest direction once', async (t) => {
  let rejectFirst!: (error: Error) => void;
  const first = new Promise<SimulatedAgentCompletion>((_resolve, reject) => {
    rejectFirst = reject;
  });
  let starts = 0;
  let activePrimary = '';
  const harness = await createHarness(t, async (input) => {
    if (input.mode === 'steer') {
      return {
        kind: 'steered',
        primaryMessageKey: activePrimary,
        turnId: 'turn-steered',
      };
    }
    starts += 1;
    activePrimary = input.message.messageKey;
    return starts === 1 ? started(input, first) : immediate(input);
  });
  const primary = harness.ingest(customer('recover-primary', '先回答'));
  const firstSteer = harness.ingest(customer('recover-steer-one', '第一次调整'));
  const secondSteer = harness.ingest(customer('recover-steer-two', '第二次调整'));
  await harness.processor.enqueue(primary);
  await harness.processor.enqueue(firstSteer);
  await harness.processor.enqueue(secondSteer);
  rejectFirst(new Error('turn crashed after steering'));
  await harness.processor.waitForIdle();

  assert.equal(starts, 2);
  assert.equal(harness.store.getInbound(primary)?.status, 'completed');
  assert.equal(harness.store.getInbound(firstSteer)?.status, 'absorbed');
  assert.equal(harness.store.getInbound(secondSteer)?.status, 'absorbed');
  const attempts = inspectAttempts(harness.store.database, primary);
  assert.equal(attempts.length, 1);
  assert.equal(
    attempts[0]?.metadata?.direction,
    harness.store.getInbound(secondSteer)?.inboxSeq,
  );
});

test('follow-ups that arrived before completion supersede the old result even when processed later', async (t) => {
  const oldCompletion = deferred<SimulatedAgentCompletion>();
  const finalCompletion = deferred<SimulatedAgentCompletion>();
  let call = 0;
  let latestPrimary = '';
  const harness = await createHarness(t, async (input) => {
    call += 1;
    if (call === 1) {
      return started(input, oldCompletion.promise);
    }
    if (call === 2) {
      latestPrimary = input.message.messageKey;
      return started(input, finalCompletion.promise);
    }
    return {
      kind: 'steered',
      primaryMessageKey: latestPrimary,
      turnId: 'turn-latest',
    };
  });
  const primary = harness.ingest(customer('backlog-primary', '介绍北京'));
  await harness.processor.enqueue(primary);
  const followOne = harness.ingest(customer('backlog-one', '只说三个景点'));
  const followTwo = harness.ingest(customer('backlog-two', '改成东北景点'));
  oldCompletion.resolve({
    replies: [{ type: 'text', content: '过时回答' }],
  });
  await harness.processor.waitForIdle();
  assert.equal(harness.store.getInbound(primary)?.status, 'suppressed');

  const queuedOne = harness.processor.enqueue(followOne);
  const queuedTwo = harness.processor.enqueue(followTwo);
  await Promise.all([queuedOne, queuedTwo]);
  finalCompletion.resolve({
    replies: [{ type: 'text', content: '最终回答' }],
  });
  await harness.processor.waitForIdle();
  assert.equal(harness.store.getInbound(followOne)?.status, 'completed');
  assert.equal(harness.store.getInbound(followTwo)?.status, 'absorbed');
  assert.deepEqual(inspectAttempts(harness.store.database, primary), []);
  assert.equal(inspectAttempts(harness.store.database, followOne)[0]?.status, 'accepted');
});
