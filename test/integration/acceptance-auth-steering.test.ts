import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, test } from 'vitest';
import type { TestContext } from 'vitest';

import {
  MESSAGE_TYPES,
  normalizeWecomMessage,
} from '../../src/domain/wecom-message.ts';
import {
  type AgentInput,
} from '../../src/agent/runtime.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { WechatKfToolExecutor } from '../../src/mcp/wechat-kf-executor.ts';
import type { WecomApiClient } from '../../src/services/wecom-api.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import {
  stableMessageKey,
  type CoreState,
} from '../../src/state/sqlite-store.ts';
import type { ResolvedImage } from '../../src/types.ts';
import { withTestDatabase } from '../support/temp-sqlite.ts';
import {
  SimulatedToolAgent,
  type SimulatedAgentCompletion,
  type SimulatedAgentRuntime,
  type SimulatedAgentSubmission,
} from '../support/executing-agent.ts';

type ProcessorAgent = SimulatedAgentRuntime;
type ProcessorMediaGateway = ConstructorParameters<
  typeof ConversationProcessor
>[0]['mediaGateway'];
type PreparerMediaGateway = ConstructorParameters<
  typeof WechatKfToolExecutor
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
  readonly createAgent: (store: CoreState) => ProcessorAgent;
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
  readonly databaseFile: string;
  readonly store: CoreState;
  readonly processor: ConversationProcessor;
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
  const databaseFile = path.join(directory, 'wecom.sqlite');
  const persistence = new StatePersistence({ filePath: databaseFile });
  const store = persistence.core;
  const sent: PreparedSendInput[] = [];
  const apiClient = {
    async sendPreparedMessage(input: PreparedSendInput) {
      sent.push(structuredClone(input));
      options.onSend?.(input);
      return { msgid: `accepted-${sent.length}` };
    },
  };
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
  const channel = new WechatKfToolExecutor({
    store,
    logger: { info() {}, warn() {}, error() {} },
    apiClient,
    mediaGateway,
    observeMs: 0,
  });
  const agent = new SimulatedToolAgent({
    inner: options.createAgent(store),
    tools: channel,
  });
  const processor = new ConversationProcessor({
    store,
    agent,
    mediaGateway,
    channel,
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
      accountKey: openKfId,
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
    await channel.waitForIdle();
  }

  t.onTestFinished(async () => {
    await processor.close();
    await channel.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    databaseFile,
    store,
    processor,
    sent,
    ingest,
    process,
    idle,
  };
}

function forbiddenAgent(calls: { value: number }): ProcessorAgent {
  return {
    async ensureThread(_conversationId, threadId) {
      calls.value += 1;
      return threadId || 'thread-forbidden';
    },
    activePrimary() { return undefined; },
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

test('every known unauthorized customer type is silent before Codex and media work', async (t) => {
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

  const customerTypes = Object.values(MESSAGE_TYPES).filter((type) =>
    type !== MESSAGE_TYPES.EVENT && type !== MESSAGE_TYPES.UNKNOWN);
  for (const [index, type] of customerTypes.entries()) {
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
  assert.ok(keys.every((key) => {
    const inbound = harness.store.getInbound(key);
    return inbound && harness.store.getConversation(
      inbound.channel,
      inbound.accountKey,
      inbound.peerId,
    )?.threadId === '';
  }));
});

test('exact authorization requires unique consecutive triggers within one open_kfid', async (t) => {
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
  readonly firstCompletion = deferred<SimulatedAgentCompletion>();
  #threadSequence = 0;

  async ensureThread(_conversationId: string, threadId: string): Promise<string> {
    this.#threadSequence += 1;
    return threadId || `thread-concurrent-${this.#threadSequence}`;
  }

  activePrimary(): undefined { return undefined; }

  async submit(input: AgentInput): Promise<SimulatedAgentSubmission> {
    this.inputs.push(input);
    const completion = this.inputs.length === 1
      ? this.firstCompletion.promise
      : Promise.resolve<SimulatedAgentCompletion>({
          replies: [{ type: 'text', content: 'reply-b' }],
        });
    return {
      kind: 'started',
      primaryMessageKey: input.message.messageKey,
      turnId: `turn-${this.inputs.length}`,
      threadId: input.threadId,
      completion,
    };
  }

  async close(): Promise<void> {}
  async abort(): Promise<void> {}
}

class WindowAgent implements ProcessorAgent {
  readonly inputs: AgentInput[] = [];
  readonly completions: Array<Deferred<SimulatedAgentCompletion>> = [];

  async ensureThread(conversationId: string, threadId: string): Promise<string> {
    return threadId || `thread-${conversationId}`;
  }

  activePrimary(): undefined { return undefined; }

  async submit(input: AgentInput): Promise<SimulatedAgentSubmission> {
    this.inputs.push(input);
    const completion = deferred<SimulatedAgentCompletion>();
    this.completions.push(completion);
    return {
      kind: 'started',
      primaryMessageKey: input.message.messageKey,
      turnId: `window-turn-${this.inputs.length}`,
      threadId: input.threadId,
      completion: completion.promise,
    };
  }

  async close(): Promise<void> {}
  async abort(): Promise<void> {}
}

class PreemptibleAgent implements ProcessorAgent {
  readonly inputs: AgentInput[] = [];
  readonly completions = new Map<string, Deferred<SimulatedAgentCompletion>>();
  active = 0;
  maxActive = 0;

  async ensureThread(conversationId: string, threadId: string): Promise<string> {
    return threadId || `thread-${conversationId}`;
  }

  activePrimary(): undefined { return undefined; }

  async submit(input: AgentInput): Promise<SimulatedAgentSubmission> {
    this.inputs.push(input);
    const completion = deferred<SimulatedAgentCompletion>();
    this.completions.set(input.conversationId, completion);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    void completion.promise.finally(() => { this.active -= 1; }).catch(() => undefined);
    return {
      kind: 'started',
      primaryMessageKey: input.message.messageKey,
      turnId: `preempt-turn-${this.inputs.length}`,
      threadId: input.threadId,
      completion: completion.promise,
    };
  }

  async interrupt(conversationId: string): Promise<boolean> {
    const completion = this.completions.get(conversationId);
    if (!completion) return false;
    completion.reject(new Error('low-priority turn interrupted'));
    return true;
  }

  async close(): Promise<void> {}
  async abort(): Promise<void> {}
}

test('the eleventh live conversation is notified and waits for a Codex slot', async (t) => {
  const queueNotice = deferred<void>();
  let agent: WindowAgent | undefined;
  const harness = await createHarness(t, {
    createAgent: () => {
      agent = new WindowAgent();
      return agent;
    },
    allowedUserIds: Array.from({ length: 11 }, (_, index) => `wm-window-${index}`),
    onSend: (input) => {
      const text = input.payload.text as { content?: unknown } | undefined;
      if (text?.content === 'Your conversation is queued. Please wait.') queueNotice.resolve();
    },
  });
  const keys = Array.from({ length: 11 }, (_, index) => harness.ingest(
    rawCustomer({
      msgid: `window-${index}`,
      externalUserId: `wm-window-${index}`,
      payload: { text: { content: `问题${index}` } },
    }),
  ));
  assert.ok(keys.every(Boolean));
  const tasks = keys.map((key) => harness.processor.enqueue(key!));
  await Promise.all(tasks.slice(0, 10));
  await queueNotice.promise;
  assert.ok(agent);
  assert.equal(agent.inputs.length, 10);

  agent.completions[0]?.resolve({
    replies: [{ type: 'text', content: '第一个会话完成' }],
  });
  await tasks[10];
  assert.equal(agent.inputs.length, 11);
  for (const completion of agent.completions.slice(1)) {
    completion.resolve({ replies: [{ type: 'text', content: '会话完成' }] });
  }
  await harness.idle();

  const queuedKey = keys[10]!;
  assert.deepEqual(
    harness.store.listMessageAttempts(queuedKey).map((attempt) => ({
      source: attempt.source,
      sendIndex: attempt.sendIndex,
      status: attempt.status,
    })),
    [
      { source: 'queue_notice', sendIndex: 0, status: 'accepted' },
      { source: 'mcp_tool', sendIndex: 1, status: 'accepted' },
    ],
  );
});

test('a new live customer preempts a different deferred conversation', async (t) => {
  const queueNotice = deferred<void>();
  let agent: PreemptibleAgent | undefined;
  const harness = await createHarness(t, {
    createAgent: () => {
      agent = new PreemptibleAgent();
      return agent;
    },
    allowedUserIds: ['wm-backlog', 'wm-live'],
    onSend: (input) => {
      const text = input.payload.text as { content?: unknown } | undefined;
      if (text?.content === 'Your conversation is queued. Please wait.') queueNotice.resolve();
    },
  });
  const backlogKey = harness.ingest(rawCustomer({
    msgid: 'deferred-backlog',
    externalUserId: 'wm-backlog',
    payload: { text: { content: '遗漏问题' } },
  }));
  assert.ok(backlogKey);
  withTestDatabase(harness.databaseFile, (database) => {
    database.prepare(`
      UPDATE inbound_messages SET deferred = 1 WHERE message_key = ?
    `).run(backlogKey);
  });
  const backlog = harness.store.activateNextDeferredConversation();
  assert.equal(backlog.length, 1);
  const recovery = harness.processor.recover(backlog, { priority: 'low' });
  while (!agent || agent.inputs.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  assert.ok(agent);
  assert.equal(agent.inputs.length, 1);

  const liveKey = harness.ingest(rawCustomer({
    msgid: 'live-priority',
    externalUserId: 'wm-live',
    payload: { text: { content: '刚进线' } },
  }));
  assert.ok(liveKey);
  await Promise.all([
    harness.processor.enqueue(liveKey),
    queueNotice.promise,
  ]);
  assert.equal(agent.inputs.length, 2);
  const liveInput = agent.inputs[1]!;
  agent.completions.get(liveInput.conversationId)?.resolve({
    replies: [{ type: 'text', content: '优先回复' }],
  });
  await recovery;
  await harness.idle();

  assert.equal(agent.maxActive, 1);
  assert.equal(harness.store.getInbound(backlogKey)?.status, 'received');
  assert.equal(harness.store.getInbound(backlogKey)?.deferred, true);
  assert.equal(harness.store.getInbound(liveKey)?.status, 'completed');
});

test('a slow customer does not block another isolated thread or media catalog', async (t) => {
  const bSent = deferred<void>();
  let agent: ConcurrentAgent | undefined;
  const resolved = new Map<string, Buffer>();
  const pngA = Buffer.from('89504e470d0a1a0a01010101', 'hex');
  const pngB = Buffer.from('89504e470d0a1a0a02020202', 'hex');
  const harness = await createHarness(t, {
    createAgent: () => {
      agent = new ConcurrentAgent();
      return agent;
    },
    allowedUserIds: ['wm-a', 'wm-b'],
    resolveForCodex: async (message): Promise<readonly ResolvedImage[]> => {
      const bytes = message.conversation.peerId === 'wm-a' ? pngA : pngB;
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
    harness.store.getConversation('wechat_kf', 'wk-one', 'wm-a')?.threadId,
    harness.store.getConversation('wechat_kf', 'wk-one', 'wm-b')?.threadId,
  );
  assert.deepEqual(
    harness.store
      .listRecentMedia({
        channel: 'wechat_kf', accountKey: 'wk-one', peerId: 'wm-a',
      })
      .map((item) => item.mediaId),
    ['media-a'],
  );
  assert.deepEqual(
    harness.store
      .listRecentMedia({
        channel: 'wechat_kf', accountKey: 'wk-one', peerId: 'wm-b',
      })
      .map((item) => item.mediaId),
    ['media-b'],
  );
  assert.deepEqual(resolved.get(keyA), pngA);
  assert.deepEqual(resolved.get(keyB), pngB);

  agent.firstCompletion.resolve({
    replies: [{ type: 'text', content: 'reply-a' }],
  });
  await harness.idle();
  assert.deepEqual(harness.sent.map((item) => item.toUser), ['wm-b', 'wm-a']);
});

class SteeringAgent implements ProcessorAgent {
  readonly completion = deferred<SimulatedAgentCompletion>();
  primaryMessageKey = '';
  turnId = 'turn-steering';
  steerCount = 0;
  latestMediaCatalog: AgentInput['mediaCatalog'] = [];
  async ensureThread(_conversationId: string, threadId: string): Promise<string> {
    return threadId || 'thread-steering';
  }

  activePrimary(): string | undefined { return this.primaryMessageKey || undefined; }

  async submit(input: AgentInput): Promise<SimulatedAgentSubmission> {
    this.latestMediaCatalog = input.mediaCatalog || this.latestMediaCatalog;
    if (input.mode === 'start') {
      this.primaryMessageKey = input.message.messageKey;
      return {
        kind: 'started',
        primaryMessageKey: this.primaryMessageKey,
        turnId: this.turnId,
        threadId: input.threadId,
        completion: this.completion.promise,
      };
    }
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

describe.each([2, 3, 5, 10])('%i mixed follow-ups', (count) => {
  test('2/3/5/10 mixed follow-ups execute only the latest direction', async (t) => {
    let agent: SteeringAgent | undefined;
    const harness = await createHarness(t, {
        createAgent: () => {
          agent = new SteeringAgent();
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
        replies: [{ type: 'text', content: `latest-${count}` }],
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
});

test('identical raw msgids remain isolated across MCP sessions attempts and client IDs', async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'r08-isolation-'));
  const persistence = new StatePersistence({
    filePath: path.join(directory, 'wecom.sqlite'),
  });
  const store = persistence.core;
  const channel = new WechatKfToolExecutor({
    store,
    apiClient: {
      async sendPreparedMessage(input) {
        return { msgid: `wx-${input.openKfId}` };
      },
    },
    mediaGateway: {
      async upload() { return { media_id: 'unused' }; },
      async cloneForSend() { throw new Error('not expected'); },
      async getCardThumbnailMediaId() { throw new Error('not expected'); },
    },
    observeMs: 0,
    logger: { info() {}, error() {} },
  });
  t.onTestFinished(async () => {
    await channel.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  const sameMsgid = 'same-msgid';
  const keys: string[] = [];

  for (const [index, openKfId] of ['wk-a', 'wk-b'].entries()) {
    const externalUserId = 'wm-same';
    const message = normalizeWecomMessage(
      rawCustomer({ msgid: sameMsgid, openKfId, externalUserId }),
      openKfId,
    );
    const ingested = store.ingestSyncPage({
      accountKey: openKfId,
      nextCursor: `cursor-${index}`,
      messages: [message],
    });
    const messageKey = ingested.insertedMessageKeys[0];
    assert.ok(messageKey);
    keys.push(messageKey);
    store.claimInbound({ messageKey });
    const session = store.createAgentSession({ messageKey });
    await channel.execute('send_text', {
      session: session.token,
      content: `reply-${openKfId}`,
    });
    store.closeAgentSession(session.token);
  }

  assert.notEqual(keys[0], keys[1]);
  assert.equal(keys[0], stableMessageKey('wechat_kf', 'wk-a', sameMsgid));
  assert.equal(keys[1], stableMessageKey('wechat_kf', 'wk-b', sameMsgid));
  const attemptsA = store.listMessageAttempts(keys[0]!);
  const attemptsB = store.listMessageAttempts(keys[1]!);
  assert.equal(attemptsA.length, 1);
  assert.equal(attemptsB.length, 1);
  assert.notEqual(attemptsA[0]?.attemptId, attemptsB[0]?.attemptId);
  assert.notEqual(attemptsA[0]?.clientMessageId, attemptsB[0]?.clientMessageId);
  assert.notDeepEqual(attemptsA[0]?.payload, attemptsB[0]?.payload);
});
