import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.ts';
import type {
  AgentCompletion,
  AgentInput,
  AgentSubmission,
  HistoryInspection,
} from '../../src/services/codex-agent.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { DeliveryService } from '../../src/services/delivery-service.ts';
import { OutboundPreparer } from '../../src/services/outbound-preparer.ts';
import { SqliteStore, stableMessageKey } from '../../src/state/sqlite-store.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

type SubmitHandler = (input: AgentInput) => Promise<AgentSubmission> | AgentSubmission;

function statefulFakeAgent(
  store: SqliteStore,
  submitHandler: SubmitHandler,
  inspect?: (
    threadId: string,
    clientInputIds: readonly string[],
    latestClientInputId: string,
  ) => Promise<HistoryInspection>,
) {
  return {
    async submit(input: AgentInput): Promise<AgentSubmission> {
      const submission = await submitHandler(input);
      if (submission.kind === 'steered') {
        store.beginInboundSteering({
          messageKey: input.message.messageKey,
          primaryMessageKey: submission.primaryMessageKey,
          clientInputId: input.message.messageKey,
        });
        store.confirmInboundSteered(input.message.messageKey, {
          codexTurnId: submission.turnId,
          steeringBoundary: 1,
        });
        return submission;
      }
      const claimed = store.claimInbound({
        messageKey: input.message.messageKey,
        clientInputId: input.clientInputId || input.message.messageKey,
        consumeHeldContext: Boolean(input.consumeHeldContext),
      });
      return {
        ...submission,
        completion: submission.completion.then((result) => ({
          ...result,
          expectedConversationEpoch: claimed.message.claimedConversationEpoch,
          expectedRuntimeEpoch: claimed.message.claimedRuntimeEpoch,
        })),
      };
    },
    ...(inspect ? { inspectHistory: inspect } : {}),
    async close(): Promise<void> {},
    async abort(): Promise<void> {},
  };
}

interface Harness {
  readonly store: SqliteStore;
  readonly sent: Array<{
    readonly toUser: string;
    readonly openKfId: string;
    readonly payload: Readonly<Record<string, unknown>>;
    readonly messageId?: string;
  }>;
  readonly mediaDownloads: string[];
  readonly processor: ConversationProcessor;
  ingest(raw: Record<string, unknown>, openKfId?: string): string;
  idle(): Promise<void>;
}

async function createHarness(
  t: TestContext,
  options: {
    readonly createAgent: (store: SqliteStore) => ReturnType<typeof statefulFakeAgent>;
    readonly allowedUserIds?: readonly string[];
    readonly authorization?: {
      readonly trigger?: string;
      readonly requiredConsecutive?: number;
      readonly confirmationText?: string;
    };
  },
): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'message-flow-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  const sent: Harness['sent'] = [];
  const mediaDownloads: string[] = [];
  const delivery = new DeliveryService({
    store,
    logger: { info() {}, error() {} },
    apiClient: {
      async sendPreparedMessage(input) {
        sent.push(input);
        return { msgid: `wecom-${sent.length}` };
      },
    },
  });
  const mediaGateway = {
    async resolveForCodex(message: AgentInput['message']) {
      mediaDownloads.push(message.messageKey);
      return [];
    },
    async cloneForSend(): Promise<string> { return 'cloned-media'; },
    async getCardThumbnailMediaId(): Promise<string> { return 'thumbnail'; },
    async upload(): Promise<{ media_id: string }> { return { media_id: 'uploaded' }; },
  };
  const preparer = new OutboundPreparer({
    mediaGateway,
    spoolDirectory: path.join(directory, 'spool'),
  });
  const processor = new ConversationProcessor({
    store,
    codexAgent: options.createAgent(store),
    mediaGateway,
    outboundPreparer: preparer,
    delivery,
    allowedUserIds: options.allowedUserIds || [],
    authorization: options.authorization || {},
    logger: { info() {}, error() {} },
  });
  const cursors = new Map<string, string>();

  function ingest(raw: Record<string, unknown>, service = String(raw.open_kfid || 'wk-one')): string {
    const expectedCursor = cursors.get(service) || '';
    const nextCursor = `${service}-${String(raw.msgid)}`;
    const result = store.ingestSyncPage({
      openKfId: service,
      expectedCursor,
      nextCursor,
      messages: [normalizeWecomMessage(raw, service, { cursor: expectedCursor, index: 0 })],
    });
    cursors.set(service, nextCursor);
    const key = result.insertedMessageKeys[0];
    if (!key) throw new Error('Expected one inserted message');
    return key;
  }

  async function idle(): Promise<void> {
    await processor.waitForIdle();
    await delivery.waitForIdle();
  }

  t.after(async () => {
    await delivery.close();
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { store, sent, mediaDownloads, processor, ingest, idle };
}

function customer(msgid: string, content: string, overrides: Record<string, unknown> = {}) {
  return {
    msgid,
    open_kfid: 'wk-one',
    external_userid: 'wm-one',
    origin: 3,
    msgtype: 'text',
    send_time: 100,
    text: { content },
    ...overrides,
  };
}

function immediateText(input: AgentInput, content: string): AgentSubmission {
  return {
    kind: 'started',
    primaryMessageKey: input.message.messageKey,
    turnId: 'turn-one',
    completion: Promise.resolve({
      candidates: [{ type: 'text', content }],
      mediaCatalog: input.mediaCatalog || [],
      expectedConversationEpoch: 0,
      expectedRuntimeEpoch: 0,
    }),
  };
}

test('[A03] unauthorized image does zero work; third trigger confirms and authorization is global', async (t) => {
  const codexInputs: AgentInput[] = [];
  const harness = await createHarness(t, {
    createAgent: (store) => statefulFakeAgent(store, (input) => {
      codexInputs.push(input);
      return immediateText(input, '跨客服授权有效');
    }),
    authorization: {
      trigger: '发车', requiredConsecutive: 3,
      confirmationText: '暗号确认，请继续对话',
    },
  });
  const unauthorized = [
    customer('image', '', {
      msgtype: 'image', text: undefined, image: { media_id: 'do-not-download' },
    }),
    customer('one', '发车'), customer('two', '发车'), customer('three', '发车'),
  ];
  for (const raw of unauthorized) await harness.processor.enqueue(harness.ingest(raw));
  await harness.idle();
  assert.equal(codexInputs.length, 0);
  assert.equal(harness.mediaDownloads.length, 0);
  assert.equal(harness.sent.length, 1);
  assert.deepEqual(harness.sent[0]?.payload, {
    msgtype: 'text', text: { content: '暗号确认，请继续对话' },
  });

  await harness.processor.enqueue(harness.ingest(customer('cross', '你好', {
    open_kfid: 'wk-two',
  }), 'wk-two'));
  await harness.idle();
  assert.equal(codexInputs[0]?.message.conversation.openKfId, 'wk-two');
  assert.equal(harness.sent[1]?.payload.text instanceof Object, true);
});

test('[S01] start plus steer emits one final batch', async (t) => {
  const completion = deferred<AgentCompletion>();
  let primary = '';
  const harness = await createHarness(t, {
    allowedUserIds: ['wm-one'],
    createAgent: (store) => statefulFakeAgent(store, (input) => {
      if (!primary) {
        primary = input.message.messageKey;
        return {
          kind: 'started', primaryMessageKey: primary, turnId: 'turn-steer',
          completion: completion.promise,
        };
      }
      return { kind: 'steered', primaryMessageKey: primary, turnId: 'turn-steer' };
    }),
  });
  const primaryKey = harness.ingest(customer('primary', '介绍华北'));
  const steerKey = harness.ingest(customer('steer', '只说三个景点', { send_time: 101 }));
  await harness.processor.enqueue(primaryKey);
  await harness.processor.enqueue(steerKey);
  completion.resolve({
    candidates: [{ type: 'text', content: '故宫、长城、云冈石窟。' }],
    mediaCatalog: [],
    expectedConversationEpoch: 0,
    expectedRuntimeEpoch: 0,
  });
  await harness.idle();
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.store.getInbound(primaryKey)?.status, 'completed');
  assert.equal(harness.store.getInbound(steerKey)?.status, 'absorbed');
});

async function activeSuppression(t: TestContext, action: (harness: Harness) => Promise<void> | void) {
  const completion = deferred<AgentCompletion>();
  const harness = await createHarness(t, {
    allowedUserIds: ['wm-one'],
    createAgent: (store) => statefulFakeAgent(store, (input) => ({
      kind: 'started', primaryMessageKey: input.message.messageKey,
      turnId: 'turn-active', completion: completion.promise,
    })),
  });
  const key = harness.ingest(customer('active', '准备回答'));
  await harness.processor.enqueue(key);
  await action(harness);
  completion.resolve({
    candidates: [{ type: 'text', content: '不应发送' }],
    mediaCatalog: [], expectedConversationEpoch: 0, expectedRuntimeEpoch: 0,
  });
  await harness.idle();
  assert.equal(harness.sent.length, 0);
  assert.equal(harness.store.getInbound(key)?.status, 'suppressed');
}

test('[H03] human takeover suppresses an active turn', async (t) => {
  await activeSuppression(t, async (harness) => {
    const key = harness.ingest({ ...customer('human', '人工'), origin: 5 });
    await harness.processor.enqueue(key);
  });
});

test('[H05] runtime pause suppresses an active turn', async (t) => {
  await activeSuppression(t, (harness) => { harness.store.setRuntimePaused(true); });
});

test('messages held during pause enter the next turn exactly once', async (t) => {
  const inputs: AgentInput[] = [];
  const harness = await createHarness(t, {
    allowedUserIds: ['wm-one'],
    createAgent: (store) => statefulFakeAgent(store, (input) => {
      inputs.push(input);
      return immediateText(input, '恢复回复');
    }),
  });
  harness.store.setRuntimePaused(true);
  const heldKey = harness.ingest(customer('held', '暂停期间消息'));
  await harness.processor.enqueue(heldKey);
  harness.store.setRuntimePaused(false);
  const nextKey = harness.ingest(customer('next', '继续'));
  await harness.processor.enqueue(nextKey);
  await harness.idle();
  assert.match(inputs[0]?.handoffContext || '', /暂停期间消息/u);
  assert.equal(harness.store.getInbound(heldKey)?.status, 'absorbed');
  assert.equal(harness.store.getInbound(heldKey)?.contextStatus, 'consumed');
});

test('recovery handles an old primary before a newer unlinked received message', async (t) => {
  const inputs: AgentInput[] = [];
  const missing: HistoryInspection = {
    state: 'missing', turnId: '', foundClientInputIds: new Set(), candidates: [],
  };
  const harness = await createHarness(t, {
    allowedUserIds: ['wm-one'],
    createAgent: (store) => statefulFakeAgent(
      store,
      (input) => {
        inputs.push(input);
        return immediateText(input, '恢复后的合并回复');
      },
      async () => missing,
    ),
  });
  const primaryKey = harness.ingest(customer('recover-primary', '原始问题'));
  const followKey = harness.ingest(customer('recover-follow', '最新调整'));
  harness.store.setConversationThread({
    openKfId: 'wk-one', externalUserId: 'wm-one', threadId: 'thread-old',
  });
  harness.store.claimInbound({ messageKey: primaryKey, clientInputId: primaryKey });
  harness.store.markInboundPreparing(primaryKey, 'turn-old');
  await harness.processor.recover(harness.store.recoverStartup().inbound);
  await harness.idle();
  assert.equal(inputs.length, 1);
  assert.match(inputs[0]?.contextText || '', /原始问题/u);
  assert.match(inputs[0]?.contextText || '', /最新调整/u);
  assert.equal(harness.store.getInbound(followKey)?.status, 'absorbed');
  assert.equal(harness.sent.length, 1);
  assert.equal(stableMessageKey('wk-one', 'recover-primary'), primaryKey);
});
