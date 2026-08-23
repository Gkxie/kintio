import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.ts';
import type { AgentCompletion, AgentInput, AgentSubmission } from '../../src/services/codex-agent.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { SqliteStore } from '../../src/state/sqlite-store.ts';
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
  handler: (input: AgentInput, store: SqliteStore) => Promise<AgentSubmission>,
  resolveMedia: (input: AgentInput['message']) => Promise<readonly []> = async () => [],
  allowedUserIds: readonly string[] = ['wm-one'],
): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'conversation-gates-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  const inputs: AgentInput[] = [];
  const downloads: string[] = [];
  const errors: string[] = [];
  let cursor = '';
  const codexAgent = {
    async submit(input: AgentInput): Promise<AgentSubmission> {
      inputs.push(input);
      return handler(input, store);
    },
    async close() {},
    async abort() {},
  };
  const processor = new ConversationProcessor({
    store,
    codexAgent,
    mediaGateway: {
      async resolveForCodex(message) {
        downloads.push(message.messageKey);
        return resolveMedia(message);
      },
    },
    outboundPreparer: {
      async prepare({ candidates }) {
        const first = candidates[0];
        const content = first && 'content' in first ? String(first.content) : 'reply';
        return {
          attempts: [{
            sendIndex: 0,
            sentType: 'text',
            payload: {
              msgtype: 'text',
              text: { content },
            },
          }],
          spoolPaths: [],
        };
      },
      async cleanup() {},
    },
    delivery: { async kick() {} },
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

  t.after(async () => {
    await processor.abort();
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

function started(input: AgentInput, store: SqliteStore, completion: Promise<AgentCompletion>): AgentSubmission {
  const claimed = store.claimInbound({
    messageKey: input.message.messageKey,
    clientInputId: input.message.messageKey,
    consumeHeldContext: Boolean(input.consumeHeldContext),
  });
  return {
    kind: 'started', primaryMessageKey: input.message.messageKey, turnId: 'turn-gate',
    completion: completion.then((result) => ({
      ...result,
      expectedConversationEpoch: claimed.message.claimedConversationEpoch,
      expectedRuntimeEpoch: claimed.message.claimedRuntimeEpoch,
    })),
  };
}

function immediate(input: AgentInput, store: SqliteStore): AgentSubmission {
  return started(input, store, Promise.resolve({
    candidates: [{ type: 'text', content: 'reply' }],
    mediaCatalog: input.mediaCatalog || [],
    expectedConversationEpoch: 0,
    expectedRuntimeEpoch: 0,
  }));
}

test('[G05][H01] malformed customer, human, and system records are ignored safely', async (t) => {
  const harness = await createHarness(t, async (input, store) => immediate(input, store));
  const keys = [
    harness.ingest(customer('bad-customer', 'x', { external_userid: '' })),
    harness.ingest({
      msgid: 'bad-human', origin: 5, msgtype: 'text', text: { content: 'x' },
    }),
    harness.ingest({
      msgid: 'bad-system', origin: 4, msgtype: 'event',
      event: { event_type: 'session_status_change', change_type: 1 },
    }),
  ];
  for (const key of keys) await harness.processor.enqueue(key);
  assert.deepEqual(keys.map((key) => harness.store.getInbound(key)?.status), [
    'ignored', 'ignored', 'ignored',
  ]);
  assert.equal(harness.inputs.length, 0);
});

test('[A01][A02][G05] unsupported message resets unauthorized trigger progress without Codex or media', async (t) => {
  const harness = await createHarness(
    t,
    async (input, store) => immediate(input, store),
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

test('[H02][H04] ended session returns to bot and hands held context to the next turn', async (t) => {
  const harness = await createHarness(t, async (input, store) => immediate(input, store));
  const human = harness.ingest({
    ...customer('human', '人工上下文'), origin: 5, servicer_userid: 'admin-one',
  });
  await harness.processor.enqueue(human);
  const ended = harness.ingest({
    msgid: 'ended', origin: 4, msgtype: 'event',
    event: {
      event_type: 'session_status_change', open_kfid: 'wk-one',
      external_userid: 'wm-one', change_type: 3,
    },
  });
  await harness.processor.enqueue(ended);
  const next = harness.ingest(customer('next', '继续'));
  await harness.processor.enqueue(next);
  await harness.processor.waitForIdle();
  assert.equal(harness.store.getConversation('wk-one', 'wm-one')?.mode, 'bot');
  assert.match(harness.inputs[0]?.handoffContext || '', /人工上下文/u);
  assert.equal(harness.store.getInbound(human)?.status, 'absorbed');
});

test('[C06] media download failure leaves received input recoverable and never starts Codex', async (t) => {
  const harness = await createHarness(
    t,
    async (input, store) => immediate(input, store),
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

test('[R04] synchronous Codex start failure preserves claimed input for recovery', async (t) => {
  const harness = await createHarness(t, async (input, store) => {
    store.claimInbound({ messageKey: input.message.messageKey });
    throw new Error('turn start failed');
  });
  const key = harness.ingest(customer('start-fail', 'x'));
  await harness.processor.enqueue(key);
  assert.equal(harness.store.getInbound(key)?.status, 'processing');
  assert.match(harness.errors[0] || '', /turn start failed/u);
});

test('[S08] synchronous steer failure requeues follow-up while primary remains active', async (t) => {
  let primary = '';
  const pending = new Promise<AgentCompletion>(() => {});
  const harness = await createHarness(t, async (input, store) => {
    if (!primary) {
      primary = input.message.messageKey;
      return started(input, store, pending);
    }
    store.beginInboundSteering({
      messageKey: input.message.messageKey,
      primaryMessageKey: primary,
      clientInputId: input.message.messageKey,
    });
    store.requeueInboundSteering(input.message.messageKey, primary);
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

test('[R04] asynchronous completion failure marks primary failed in background tracker', async (t) => {
  const harness = await createHarness(t, async (input, store) =>
    started(input, store, Promise.reject(new Error('background failed'))),
  );
  const key = harness.ingest(customer('background', 'x'));
  await harness.processor.enqueue(key);
  await harness.processor.waitForIdle();
  assert.equal(harness.store.getInbound(key)?.status, 'failed');
  assert.match(harness.store.getInbound(key)?.errorMessage || '', /background failed/u);
});

test('[H03][R04] recovery processes an arrived human takeover before the active primary', async (t) => {
  const harness = await createHarness(t, async (input, store) => immediate(input, store));
  const primary = harness.ingest(customer('crashed-primary', 'old task'));
  harness.store.claimInbound({ messageKey: primary });
  harness.store.markInboundPreparing(primary, 'crashed-turn');
  const human = harness.ingest({
    ...customer('arrived-human', '人工接管'),
    origin: 5,
    servicer_userid: 'admin',
  });
  await harness.processor.recover(harness.store.recoverStartup().inbound);
  await harness.processor.waitForIdle();
  assert.equal(harness.store.getConversation('wk-one', 'wm-one')?.mode, 'human');
  assert.equal(harness.store.getInbound(primary)?.status, 'suppressed');
  assert.equal(harness.store.getInbound(human)?.status, 'held');
  assert.equal(harness.inputs.length, 0);
  assert.deepEqual(inspectAttempts(harness.store.database, primary), []);
});

test('[S08] follow-ups that arrived before completion supersede the old result even when processed later', async (t) => {
  const oldCompletion = deferred<AgentCompletion>();
  const finalCompletion = deferred<AgentCompletion>();
  let call = 0;
  let latestPrimary = '';
  const harness = await createHarness(t, async (input, store) => {
    call += 1;
    if (call === 1) {
      return started(input, store, oldCompletion.promise);
    }
    if (call === 2) {
      latestPrimary = input.message.messageKey;
      return started(input, store, finalCompletion.promise);
    }
    store.beginInboundSteering({
      messageKey: input.message.messageKey,
      primaryMessageKey: latestPrimary,
      clientInputId: input.message.messageKey,
    });
    store.confirmInboundSteered(input.message.messageKey, {
      codexTurnId: 'turn-latest',
    });
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
  const queuedOne = harness.processor.enqueue(followOne);
  const queuedTwo = harness.processor.enqueue(followTwo);
  oldCompletion.resolve({
    candidates: [{ type: 'text', content: '过时回答' }],
    mediaCatalog: [],
    expectedConversationEpoch: 0,
    expectedRuntimeEpoch: 0,
  });
  await Promise.all([queuedOne, queuedTwo]);
  finalCompletion.resolve({
    candidates: [{ type: 'text', content: '最终回答' }],
    mediaCatalog: [],
    expectedConversationEpoch: 0,
    expectedRuntimeEpoch: 0,
  });
  await harness.processor.waitForIdle();
  assert.equal(harness.store.getInbound(primary)?.status, 'suppressed');
  assert.equal(harness.store.getInbound(followOne)?.status, 'ready');
  assert.equal(harness.store.getInbound(followTwo)?.status, 'absorbed');
  assert.deepEqual(inspectAttempts(harness.store.database, primary), []);
  assert.equal(inspectAttempts(harness.store.database, followOne).length, 1);
});
