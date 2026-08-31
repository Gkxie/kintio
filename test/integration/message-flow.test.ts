import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'vitest';
import type { TestContext } from 'vitest';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.ts';
import type {
  AgentInput,
  HistoryInspection,
} from '../../src/agent/runtime.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { WechatKfToolExecutor } from '../../src/mcp/wechat-kf-executor.ts';
import { StatePersistence } from '../../src/state/persistence.ts';
import { stableMessageKey, type CoreState } from '../../src/state/sqlite-store.ts';
import {
  SimulatedToolAgent,
  type SimulatedAgentCompletion,
  type SimulatedAgentSubmission,
} from '../support/executing-agent.ts';
import { withTestDatabase } from '../support/temp-sqlite.ts';

interface Deferred<T> {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

type SubmitHandler = (
  input: AgentInput,
) => Promise<SimulatedAgentSubmission> | SimulatedAgentSubmission;

function statefulFakeAgent(
  _store: CoreState,
  submitHandler: SubmitHandler,
  inspect?: (
    threadId: string,
    clientInputIds: readonly string[],
    latestClientInputId: string,
  ) => Promise<HistoryInspection>,
) {
  return {
    async submit(input: AgentInput): Promise<SimulatedAgentSubmission> {
      return submitHandler(input);
    },
    ...(inspect ? { inspectHistory: inspect } : {}),
    async close(): Promise<void> {},
    async abort(): Promise<void> {},
  };
}

interface Harness {
  readonly databaseFile: string;
  readonly store: CoreState;
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
    readonly createAgent: (store: CoreState) => ReturnType<typeof statefulFakeAgent>;
    readonly allowedUserIds?: readonly string[];
    readonly authorization?: {
      readonly trigger?: string;
      readonly requiredConsecutive?: number;
      readonly confirmationText?: string;
    };
    readonly onSend?: () => void | Promise<void>;
  },
): Promise<Harness> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'message-flow-'));
  const databaseFile = path.join(directory, 'wecom.sqlite');
  const persistence = new StatePersistence({ filePath: databaseFile });
  const store = persistence.core;
  const sent: Harness['sent'] = [];
  const mediaDownloads: string[] = [];
  const mediaGateway = {
    async resolveForCodex(message: AgentInput['message']) {
      mediaDownloads.push(message.messageKey);
      return [];
    },
    async cloneForSend(): Promise<string> { return 'cloned-media'; },
    async getCardThumbnailMediaId(): Promise<string> { return 'thumbnail'; },
    async upload(): Promise<{ media_id: string }> { return { media_id: 'uploaded' }; },
  };
  const channel = new WechatKfToolExecutor({
    store,
    logger: { info() {}, error() {} },
    apiClient: {
      async sendPreparedMessage(input) {
        sent.push(input);
        await options.onSend?.();
        return { msgid: `wecom-${sent.length}` };
      },
    },
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
    await channel.waitForIdle();
  }

  t.onTestFinished(async () => {
    await channel.close();
    persistence.close();
    await fs.rm(directory, { recursive: true, force: true });
  });
  return { databaseFile, store, sent, mediaDownloads, processor, ingest, idle };
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

function immediateText(input: AgentInput, content: string): SimulatedAgentSubmission {
  return {
    kind: 'started',
    primaryMessageKey: input.message.messageKey,
    turnId: 'turn-one',
    threadId: input.threadId,
    completion: Promise.resolve({
      replies: [{ type: 'text', content }],
    }),
  };
}

test('unauthorized image does zero work; third trigger confirms and authorization is global', async (t) => {
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
  assert.equal(
    codexInputs[0]?.threadId,
    harness.store.getConversation('wk-two', 'wm-one')?.threadId,
  );
  assert.ok(codexInputs[0]?.threadId);
  assert.equal(harness.sent[1]?.payload.text instanceof Object, true);
});

test('start plus steer executes one latest-direction reply', async (t) => {
  const completion = deferred<SimulatedAgentCompletion>();
  let primary = '';
  let damageOnSend = (): void => undefined;
  const harness = await createHarness(t, {
    onSend: () => damageOnSend(),
    allowedUserIds: ['wm-one'],
    createAgent: (store) => statefulFakeAgent(store, (input) => {
      if (input.mode === 'start') {
        primary = input.message.messageKey;
        return {
          kind: 'started', primaryMessageKey: primary, turnId: 'turn-steer',
          threadId: input.threadId,
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
  let damagedKey = '';
  damageOnSend = () => {
    damagedKey = harness.ingest(customer('damaged-followup', '损坏消息', {
      send_time: 102,
    }));
    withTestDatabase(harness.databaseFile, (database) => {
      database.prepare(`
        UPDATE inbound_messages
        SET payload_json = json_set(payload_json, '$.conversation.channel', 'weixin_ilink')
        WHERE message_key = ?
      `).run(damagedKey);
    });
  };
  completion.resolve({
    replies: [{ type: 'text', content: '故宫、长城、云冈石窟。' }],
  });
  await harness.idle();
  assert.equal(harness.sent.length, 1);
  assert.equal(harness.store.getInbound(primaryKey)?.status, 'completed');
  assert.equal(harness.store.getInbound(steerKey)?.status, 'absorbed');
  assert.equal(harness.store.getInbound(damagedKey)?.status, 'ignored');
});

test('recovery keeps an old primary and newer unlinked message independent', async (t) => {
  const inputs: AgentInput[] = [];
  const missing: HistoryInspection = {
    state: 'missing', turnId: '', foundClientInputIds: new Set(), artifacts: [],
  };
  const harness = await createHarness(t, {
    allowedUserIds: ['wm-one'],
    createAgent: (store) => statefulFakeAgent(
      store,
      (input) => {
        inputs.push(input);
        return immediateText(input, '独立回复');
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
  assert.equal(inputs.length, 2);
  assert.match(inputs[0]?.contextText || '', /原始问题/u);
  assert.doesNotMatch(inputs[0]?.contextText || '', /最新调整/u);
  assert.match(inputs[1]?.contextText || '', /最新调整/u);
  assert.doesNotMatch(inputs[1]?.contextText || '', /原始问题/u);
  assert.equal(harness.store.getInbound(primaryKey)?.status, 'completed');
  assert.equal(harness.store.getInbound(followKey)?.status, 'completed');
  assert.equal(harness.sent.length, 2);
  assert.equal(stableMessageKey('wk-one', 'recover-primary'), primaryKey);
});
