import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import type { TestContext } from 'node:test';

import {
  CUSTOMER_MESSAGE_TYPES,
  normalizeWecomMessage,
} from '../../src/domain/wecom-message.ts';
import {
  type AgentCompletion,
  type AgentInput,
  type AgentSubmission,
} from '../../src/services/codex-agent.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { DeliveryService } from '../../src/services/delivery-service.ts';
import { OutboundPreparer } from '../../src/services/outbound-preparer.ts';
import type { WecomApiClient } from '../../src/services/wecom-api.ts';
import {
  SqliteStore,
  stableMessageKey,
} from '../../src/state/sqlite-store.ts';
import type { ResolvedImage } from '../../src/types.ts';
import { inspectAttempts } from '../support/sqlite-inspect.ts';

type ProcessorAgent = ConstructorParameters<
  typeof ConversationProcessor
>[0]['codexAgent'];
type ProcessorMediaGateway = ConstructorParameters<
  typeof ConversationProcessor
>[0]['mediaGateway'];
type PreparerMediaGateway = ConstructorParameters<
  typeof OutboundPreparer
>[0]['mediaGateway'];
type PreparedSendInput = Parameters<WecomApiClient['sendPreparedMessage']>[0];

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(reason: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function customerPayload(type: string, label: string): Record<string, unknown> {
  switch (type) {
    case 'text':
      return { text: { content: `普通文本-${label}` } };
    case 'image':
      return { image: { media_id: `media-${label}` } };
    case 'voice':
      return { voice: { media_id: `voice-${label}` } };
    case 'video':
      return { video: { media_id: `video-${label}` } };
    case 'file':
      return { file: { media_id: `file-${label}`, filename: `${label}.txt` } };
    case 'location':
      return {
        location: {
          name: label,
          address: '测试地址',
          latitude: 39.9,
          longitude: 116.4,
        },
      };
    case 'link':
      return {
        link: {
          title: label,
          desc: '测试链接',
          url: `https://example.com/${label}`,
        },
      };
    case 'business_card':
      return { business_card: { userid: `contact-${label}` } };
    case 'miniprogram':
      return {
        miniprogram: {
          title: label,
          appid: 'wx1234567890abcdef',
          pagepath: 'pages/index',
        },
      };
    case 'msgmenu':
      return { msgmenu: { head_content: label, list: [] } };
    case 'channels_shop_product':
      return { channels_shop_product: { title: label, product_id: label } };
    case 'channels_shop_order':
      return { channels_shop_order: { order_id: label, product_titles: label } };
    case 'merged_msg':
      return {
        merged_msg: {
          title: label,
          item: [
            {
              msgtype: 'text',
              sender_name: '客户',
              msg_content: JSON.stringify({
                msgtype: 'text',
                text: { content: label },
              }),
            },
          ],
        },
      };
    case 'channels':
      return { channels: { nickname: label, title: label, sub_type: 1 } };
    case 'note':
      return { note: {} };
    default:
      throw new Error(`Missing customer fixture for ${type}`);
  }
}

interface HarnessOptions {
  readonly createAgent: (store: SqliteStore) => ProcessorAgent;
  readonly allowedUserIds?: readonly string[];
  readonly authorization?: {
    readonly trigger?: string;
    readonly requiredConsecutive?: number;
    readonly confirmationText?: string;
  };
  readonly resolveForCodex?: ProcessorMediaGateway['resolveForCodex'];
  readonly onSend?: (input: PreparedSendInput) => void;
}

interface Harness {
  readonly directory: string;
  readonly store: SqliteStore;
  readonly processor: ConversationProcessor;
  readonly delivery: DeliveryService;
  readonly sent: PreparedSendInput[];
  ingest(raw: Record<string, unknown>, openKfId?: string): string | undefined;
  process(raw: Record<string, unknown>, openKfId?: string): Promise<string | undefined>;
  idle(): Promise<void>;
}

async function createHarness(
  t: TestContext,
  options: HarnessOptions,
): Promise<Harness> {
  const directory = await fs.mkdtemp(
    path.join(os.tmpdir(), 'acceptance-auth-steering-'),
  );
  const store = new SqliteStore({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const sent: PreparedSendInput[] = [];
  const delivery = new DeliveryService({
    store,
    logger: { info() {}, warn() {}, error() {} },
    apiClient: {
      async sendPreparedMessage(input: PreparedSendInput) {
        sent.push(structuredClone(input));
        options.onSend?.(input);
        return { msgid: `accepted-${sent.length}` };
      },
    },
  });
  const mediaGateway: ProcessorMediaGateway & PreparerMediaGateway = {
    resolveForCodex:
      options.resolveForCodex || (async () => []),
    async upload() {
      return { media_id: 'uploaded-image' };
    },
    async cloneForSend() {
      return 'cloned-image';
    },
    async getCardThumbnailMediaId() {
      return 'thumbnail-image';
    },
  };
  const outboundPreparer = new OutboundPreparer({
    mediaGateway,
    spoolDirectory: path.join(directory, 'spool'),
  });
  const processor = new ConversationProcessor({
    store,
    codexAgent: options.createAgent(store),
    mediaGateway,
    outboundPreparer,
    delivery,
    allowedUserIds: options.allowedUserIds || [],
    authorization: options.authorization || {},
    logger: { info() {}, warn() {}, error() {} },
  });
  const cursors = new Map<string, string>();
  let page = 0;

  function ingest(
    raw: Record<string, unknown>,
    openKfId = String(raw.open_kfid || 'wk-one'),
  ): string | undefined {
    const expectedCursor = cursors.get(openKfId) || '';
    page += 1;
    const nextCursor = `${openKfId}-page-${page}`;
    const normalized = normalizeWecomMessage(raw, openKfId, {
      cursor: expectedCursor,
      index: 0,
    });
    const result = store.ingestSyncPage({
      openKfId,
      expectedCursor,
      nextCursor,
      messages: [normalized],
    });
    cursors.set(openKfId, nextCursor);
    return result.insertedMessageKeys[0];
  }

  async function process(
    raw: Record<string, unknown>,
    openKfId?: string,
  ): Promise<string | undefined> {
    const key = ingest(raw, openKfId);
    if (key) await processor.enqueue(key);
    return key;
  }

  async function idle(): Promise<void> {
    await processor.waitForIdle();
    await delivery.waitForIdle();
  }

  t.after(async () => {
    await processor.close();
    await delivery.close();
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { directory, store, processor, delivery, sent, ingest, process, idle };
}

function forbiddenAgent(calls: { value: number }): ProcessorAgent {
  return {
    async submit(): Promise<never> {
      calls.value += 1;
      throw new Error('Unauthorized input must not invoke Codex');
    },
    async close() {},
    async abort() {},
  };
}

function rawCustomer({
  msgid,
  openKfId = 'wk-one',
  externalUserId = 'wm-one',
  type = 'text',
  payload = { text: { content: '普通消息' } },
}: {
  msgid: string;
  openKfId?: string;
  externalUserId?: string;
  type?: string;
  payload?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    msgid,
    open_kfid: openKfId,
    external_userid: externalUserId,
    origin: 3,
    msgtype: type,
    send_time: 100,
    ...payload,
  };
}

test('[A01] every known unauthorized customer type is silent before Codex and media work', async (t) => {
  const codexCalls = { value: 0 };
  const mediaCalls = { value: 0 };
  const harness = await createHarness(t, {
    createAgent: () => forbiddenAgent(codexCalls),
    authorization: { trigger: '发车', requiredConsecutive: 3 },
    resolveForCodex: async () => {
      mediaCalls.value += 1;
      return [];
    },
  });
  const keys: string[] = [];

  for (const [index, type] of CUSTOMER_MESSAGE_TYPES.entries()) {
    const key = await harness.process(
      rawCustomer({
        msgid: `unauthorized-${type}-${index}`,
        type,
        payload: customerPayload(type, `${type}-${index}`),
      }),
    );
    assert.ok(key);
    keys.push(key);
  }
  await harness.idle();

  assert.equal(codexCalls.value, 0);
  assert.equal(mediaCalls.value, 0);
  assert.equal(harness.sent.length, 0);
  assert.ok(keys.every((key) => harness.store.getInbound(key)?.status === 'ignored'));
});

test('[A02] exact authorization requires unique consecutive triggers within one open_kfid', async (t) => {
  const codexCalls = { value: 0 };
  const mediaCalls = { value: 0 };
  const harness = await createHarness(t, {
    createAgent: () => forbiddenAgent(codexCalls),
    authorization: {
      trigger: '发车',
      requiredConsecutive: 3,
      confirmationText: '暗号确认，请继续对话',
    },
    resolveForCodex: async () => {
      mediaCalls.value += 1;
      return [];
    },
  });
  const trigger = (msgid: string, openKfId = 'wk-a') =>
    rawCustomer({
      msgid,
      openKfId,
      externalUserId: 'wm-auth',
      payload: { text: { content: '发车' } },
    });
  const count = () =>
    harness.store.getAuthorization('wm-auth')?.consecutiveMatches ?? 0;

  await harness.process(trigger('duplicate'));
  assert.equal(count(), 1);
  assert.equal(harness.ingest(trigger('duplicate')), undefined);
  assert.equal(count(), 1);
  await harness.process(
    rawCustomer({
      msgid: 'whitespace',
      openKfId: 'wk-a',
      externalUserId: 'wm-auth',
      payload: { text: { content: '发车 ' } },
    }),
  );
  assert.equal(count(), 0);
  await harness.process(trigger('before-image'));
  assert.equal(count(), 1);
  await harness.process(
    rawCustomer({
      msgid: 'non-text',
      openKfId: 'wk-a',
      externalUserId: 'wm-auth',
      type: 'image',
      payload: { image: { media_id: 'must-not-download' } },
    }),
  );
  assert.equal(count(), 0);
  await harness.process(trigger('service-a'));
  await harness.process(trigger('service-b', 'wk-b'), 'wk-b');
  assert.equal(count(), 1);
  await harness.process(trigger('back-a'));
  assert.equal(count(), 1);
  await harness.process(trigger('back-a-two'));
  assert.equal(count(), 2);
  await harness.process(
    rawCustomer({
      msgid: 'interference',
      openKfId: 'wk-a',
      externalUserId: 'wm-auth',
      payload: { text: { content: '干扰' } },
    }),
  );
  assert.equal(count(), 0);
  await harness.process(trigger('final-one'));
  assert.equal(count(), 1);
  await harness.process(trigger('final-two'));
  assert.equal(count(), 2);
  await harness.process(trigger('final-three'));
  await harness.idle();

  assert.equal(harness.store.getAuthorization('wm-auth')?.authorized, true);
  assert.equal(count(), 3);
  assert.equal(codexCalls.value, 0);
  assert.equal(mediaCalls.value, 0);
  assert.equal(harness.sent.length, 1);
  assert.deepEqual(harness.sent[0]?.payload, {
    msgtype: 'text',
    text: { content: '暗号确认，请继续对话' },
  });
});

class ConcurrentAgent implements ProcessorAgent {
  readonly inputs: AgentInput[] = [];
  readonly firstCompletion = deferred<AgentCompletion>();
  readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  async submit(input: AgentInput): Promise<AgentSubmission> {
    this.inputs.push(input);
    const { openKfId, externalUserId } = input.message.conversation;
    const claimed = this.store.claimInbound({
      messageKey: input.message.messageKey,
      clientInputId: input.message.messageKey,
    }).message;
    const threadId = `thread-${externalUserId}`;
    this.store.setConversationThread({ openKfId, externalUserId, threadId });
    const completion = externalUserId === 'wm-a'
      ? this.firstCompletion.promise
      : Promise.resolve<AgentCompletion>({
          candidates: [{ type: 'text', content: 'reply-b' }],
          mediaCatalog: input.mediaCatalog || [],
          expectedConversationEpoch: claimed.claimedConversationEpoch,
          expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
        });
    return {
      kind: 'started',
      primaryMessageKey: input.message.messageKey,
      turnId: `turn-${externalUserId}`,
      completion,
    };
  }

  async close(): Promise<void> {}
  async abort(): Promise<void> {}
}

test('[C01][S07] a slow customer does not block another isolated thread or media catalog', async (t) => {
  const bSent = deferred<void>();
  let agent: ConcurrentAgent | undefined;
  const resolved = new Map<string, Buffer>();
  const pngA = Buffer.from('89504e470d0a1a0a01010101', 'hex');
  const pngB = Buffer.from('89504e470d0a1a0a02020202', 'hex');
  const harness = await createHarness(t, {
    createAgent: (store) => {
      agent = new ConcurrentAgent(store);
      return agent;
    },
    allowedUserIds: ['wm-a', 'wm-b'],
    resolveForCodex: async (message): Promise<readonly ResolvedImage[]> => {
      const bytes = message.conversation.externalUserId === 'wm-a' ? pngA : pngB;
      resolved.set(message.messageKey, bytes);
      return [{ kind: 'image', bytes, contentType: 'image/png' }];
    },
    onSend: (input) => {
      if (input.toUser === 'wm-b') bSent.resolve();
    },
  });
  const keyA = harness.ingest(
    rawCustomer({
      msgid: 'same-image-a',
      externalUserId: 'wm-a',
      type: 'image',
      payload: { image: { media_id: 'media-a' } },
    }),
  );
  const keyB = harness.ingest(
    rawCustomer({
      msgid: 'same-image-b',
      externalUserId: 'wm-b',
      type: 'image',
      payload: { image: { media_id: 'media-b' } },
    }),
  );
  assert.ok(keyA && keyB);

  await harness.processor.enqueue(keyA);
  await harness.processor.enqueue(keyB);
  await bSent.promise;

  assert.ok(agent);
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.sent[0]?.toUser, 'wm-b');
  assert.equal(agent.inputs.length, 2);
  assert.notEqual(
    harness.store.getConversation('wk-one', 'wm-a')?.threadId,
    harness.store.getConversation('wk-one', 'wm-b')?.threadId,
  );
  assert.deepEqual(
    harness.store
      .listRecentMedia({ openKfId: 'wk-one', externalUserId: 'wm-a' })
      .map((item) => item.mediaId),
    ['media-a'],
  );
  assert.deepEqual(
    harness.store
      .listRecentMedia({ openKfId: 'wk-one', externalUserId: 'wm-b' })
      .map((item) => item.mediaId),
    ['media-b'],
  );
  assert.deepEqual(resolved.get(keyA), pngA);
  assert.deepEqual(resolved.get(keyB), pngB);

  agent.firstCompletion.resolve({
    candidates: [{ type: 'text', content: 'reply-a' }],
    mediaCatalog: [],
    expectedConversationEpoch: 0,
    expectedRuntimeEpoch: 0,
  });
  await harness.idle();
  assert.deepEqual(harness.sent.map((item) => item.toUser), ['wm-b', 'wm-a']);
});

class SteeringAgent implements ProcessorAgent {
  readonly completion = deferred<AgentCompletion>();
  primaryMessageKey = '';
  turnId = 'turn-steering';
  steerCount = 0;
  latestMediaCatalog: AgentInput['mediaCatalog'] = [];
  readonly store: SqliteStore;

  constructor(store: SqliteStore) {
    this.store = store;
  }

  async submit(input: AgentInput): Promise<AgentSubmission> {
    this.latestMediaCatalog = input.mediaCatalog || this.latestMediaCatalog;
    if (!this.primaryMessageKey) {
      this.primaryMessageKey = input.message.messageKey;
      const claimed = this.store.claimInbound({
        messageKey: input.message.messageKey,
        clientInputId: input.message.messageKey,
      }).message;
      return {
        kind: 'started',
        primaryMessageKey: this.primaryMessageKey,
        turnId: this.turnId,
        completion: this.completion.promise.then((result) => ({
          ...result,
          expectedConversationEpoch: claimed.claimedConversationEpoch,
          expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
        })),
      };
    }
    this.store.beginInboundSteering({
      messageKey: input.message.messageKey,
      primaryMessageKey: this.primaryMessageKey,
      clientInputId: input.message.messageKey,
    });
    this.store.confirmInboundSteered(input.message.messageKey, {
      codexTurnId: this.turnId,
      steeringBoundary: this.steerCount + 1,
    });
    this.steerCount += 1;
    return {
      kind: 'steered',
      primaryMessageKey: this.primaryMessageKey,
      turnId: this.turnId,
    };
  }

  async close(): Promise<void> {}
  async abort(): Promise<void> {}
}

test('[S05] 2/3/5/10 mixed follow-ups produce one latest final batch', async (t) => {
  for (const count of [2, 3, 5, 10]) {
    await t.test(`${count}-messages`, async (subtest) => {
      let agent: SteeringAgent | undefined;
      const harness = await createHarness(subtest, {
        createAgent: (store) => {
          agent = new SteeringAgent(store);
          return agent;
        },
        allowedUserIds: ['wm-steering'],
      });
      const keys: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const kind = index % 3 === 0 ? 'text' : index % 3 === 1 ? 'image' : 'link';
        const payload = customerPayload(kind, `mixed-${count}-${index}`);
        const key = await harness.process(
          rawCustomer({
            msgid: `mixed-${count}-${index}`,
            externalUserId: 'wm-steering',
            type: kind,
            payload,
          }),
        );
        assert.ok(key);
        keys.push(key);
      }
      assert.ok(agent);
      agent.completion.resolve({
        candidates: [{ type: 'text', content: `latest-${count}` }],
        mediaCatalog: agent.latestMediaCatalog || [],
        expectedConversationEpoch: 0,
        expectedRuntimeEpoch: 0,
      });
      await harness.idle();

      assert.equal(agent.steerCount, count - 1);
      assert.equal(harness.sent.length, 1);
      assert.deepEqual(harness.sent[0]?.payload, {
        msgtype: 'text',
        text: { content: `latest-${count}` },
      });
      assert.equal(harness.store.getInbound(keys[0]!)?.status, 'completed');
      assert.ok(
        keys.slice(1).every(
          (key) => harness.store.getInbound(key)?.status === 'absorbed',
        ),
      );
    });
  }
});

test('[S07][R08] identical raw msgids remain isolated across message outbox spool and client IDs', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'r08-isolation-'));
  const store = new SqliteStore({ filePath: path.join(directory, 'wecom.sqlite') });
  let upload = 0;
  const preparer = new OutboundPreparer({
    spoolDirectory: path.join(directory, 'spool'),
    mediaGateway: {
      async upload() {
        upload += 1;
        return { media_id: `generated-${upload}` };
      },
      async cloneForSend() {
        throw new Error('clone was not expected');
      },
      async getCardThumbnailMediaId() {
        throw new Error('thumbnail was not expected');
      },
    },
  });
  t.after(async () => {
    store.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const sameMsgid = 'same-msgid';
  const keys: string[] = [];
  const batches = [];
  const bytes = Buffer.from('89504e470d0a1a0a01010101', 'hex');

  for (const [index, openKfId] of ['wk-a', 'wk-b'].entries()) {
    const externalUserId = 'wm-same';
    const message = normalizeWecomMessage(
      rawCustomer({ msgid: sameMsgid, openKfId, externalUserId }),
      openKfId,
    );
    const ingested = store.ingestSyncPage({
      openKfId,
      nextCursor: `cursor-${index}`,
      messages: [message],
    });
    const messageKey = ingested.insertedMessageKeys[0];
    assert.ok(messageKey);
    keys.push(messageKey);
    const claimed = store.claimInbound({ messageKey }).message;
    const prepared = await preparer.prepare({
      messageKey,
      candidates: [
        {
          type: 'generated_image',
          bytes,
          filename: `${openKfId}.png`,
          contentType: 'image/png',
          generationId: `generation-${index}`,
          revisedPrompt: `prompt-${index}`,
        },
      ],
    });
    batches.push(prepared);
    store.finalizeInboundBatch({
      messageKey,
      expectedConversationEpoch: claimed.claimedConversationEpoch,
      expectedRuntimeEpoch: claimed.claimedRuntimeEpoch,
      attempts: prepared.attempts,
    });
  }

  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[0], stableMessageKey('wk-a', sameMsgid));
  assert.equal(keys[1], stableMessageKey('wk-b', sameMsgid));
  const spoolPaths = batches.flatMap((batch) => batch.spoolPaths);
  assert.equal(new Set(spoolPaths).size, 2);
  assert.ok(spoolPaths[0]?.includes(keys[0]!));
  assert.ok(spoolPaths[1]?.includes(keys[1]!));
  const attemptsA = inspectAttempts(store.database, keys[0]!);
  const attemptsB = inspectAttempts(store.database, keys[1]!);
  assert.equal(attemptsA.length, 1);
  assert.equal(attemptsB.length, 1);
  assert.notEqual(attemptsA[0]?.attemptId, attemptsB[0]?.attemptId);
  assert.notEqual(attemptsA[0]?.clientMessageId, attemptsB[0]?.clientMessageId);
  assert.notDeepEqual(attemptsA[0]?.payload, attemptsB[0]?.payload);
  await preparer.cleanup(spoolPaths);
});
