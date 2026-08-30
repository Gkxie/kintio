import assert from 'node:assert/strict';
import { test } from 'vitest';
import type { TestContext } from 'vitest';

import type {
  AgentCompletion,
  AgentInput,
  AgentRuntime,
  AgentSubmission,
} from '../../src/agent/runtime.ts';
import { normalizeWecomMessage } from '../../src/domain/wecom-message.ts';
import { IlinkSendExecutor } from '../../src/ilink/executor.ts';
import { normalizeIlinkInboundMessage } from '../../src/ilink/message.ts';
import {
  IlinkMessageItemType,
  IlinkMessageState,
  IlinkMessageType,
} from '../../src/ilink/protocol/types.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import { IlinkSqliteStore } from '../../src/ilink/sqlite-store.ts';
import {
  createIlinkAccountKey,
  type IlinkAccountKey,
} from '../../src/ilink/store-types.ts';
import { WechatKfToolExecutor } from '../../src/mcp/wechat-kf-executor.ts';
import { ConversationProcessor } from '../../src/services/conversation-processor.ts';
import { SqliteStore } from '../../src/state/sqlite-store.ts';
import { createTempSqlite } from '../support/temp-sqlite.ts';

const NOW = 1_800_000_000_000;
const QUEUE_NOTICE = 'Your conversation is queued. Please wait.';

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

async function waitUntil(
  predicate: () => boolean,
  label: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
  }
}

interface ControlledTurn {
  readonly input: AgentInput;
  readonly completion: Deferred<AgentCompletion>;
  settled: boolean;
}

class ControlledAgent implements AgentRuntime {
  readonly inputs: AgentInput[] = [];
  readonly starts: Array<{
    readonly messageKey: string;
    readonly channel: AgentInput['channel'];
    readonly activeBefore: number;
  }> = [];
  readonly interruptedMessageKeys: string[] = [];
  readonly #wecom: WechatKfToolExecutor;
  readonly #ilink: IlinkSendExecutor;
  readonly #turns: ControlledTurn[] = [];
  readonly #active = new Map<string, ControlledTurn>();
  #sequence = 0;
  #aborted = false;
  maxActive = 0;

  constructor({
    wecom,
    ilink,
  }: {
    wecom: WechatKfToolExecutor;
    ilink: IlinkSendExecutor;
  }) {
    this.#wecom = wecom;
    this.#ilink = ilink;
  }

  async ensureThread(conversationId: string, threadId: string): Promise<string> {
    return threadId || `thread-${conversationId}`;
  }

  activePrimary(conversationId: string): string | undefined {
    return this.#active.get(conversationId)?.input.message.messageKey;
  }

  async submit(input: AgentInput): Promise<AgentSubmission> {
    if (this.#aborted) throw new Error('Controlled Agent is aborted');
    if (input.mode !== 'start') throw new Error('Unexpected steering in priority test');
    const completion = deferred<AgentCompletion>();
    const turn: ControlledTurn = { input, completion, settled: false };
    this.starts.push({
      messageKey: input.message.messageKey,
      channel: input.channel,
      activeBefore: this.#active.size,
    });
    this.inputs.push(input);
    this.#turns.push(turn);
    this.#active.set(input.conversationId, turn);
    this.maxActive = Math.max(this.maxActive, this.#active.size);
    void completion.promise.finally(() => {
      if (this.#active.get(input.conversationId) === turn) {
        this.#active.delete(input.conversationId);
      }
    }).catch(() => undefined);
    this.#sequence += 1;
    return {
      kind: 'started',
      primaryMessageKey: input.message.messageKey,
      turnId: `priority-turn-${this.#sequence}`,
      threadId: input.threadId,
      completion: completion.promise,
    };
  }

  async finish(messageKey: string, content: string): Promise<string> {
    const turn = this.#turns.find(
      (candidate) => candidate.input.message.messageKey === messageKey,
    );
    if (!turn || turn.settled) throw new Error(`No pending turn for ${messageKey}`);
    const receipt = turn.input.channel === 'weixin_ilink'
      ? await this.#ilink.execute('send_text', {
          session: turn.input.toolSessionToken,
          content,
        })
      : await this.#wecom.execute('send_text', {
          session: turn.input.toolSessionToken,
          content,
        });
    assert.equal(receipt.status, 'accepted');
    assert.ok(receipt.attemptId);
    turn.settled = true;
    turn.completion.resolve({ executedAttemptIds: [receipt.attemptId] });
    return receipt.attemptId;
  }

  async interrupt(conversationId: string): Promise<boolean> {
    const turn = this.#active.get(conversationId);
    if (!turn || turn.settled) return false;
    turn.settled = true;
    this.interruptedMessageKeys.push(turn.input.message.messageKey);
    turn.completion.reject(new Error('low-priority backlog interrupted'));
    return true;
  }

  async close(): Promise<void> {
    await this.abort();
  }

  async abort(): Promise<void> {
    this.#aborted = true;
    for (const turn of this.#active.values()) {
      if (turn.settled) continue;
      turn.settled = true;
      turn.completion.reject(new Error('Controlled Agent aborted'));
    }
    await Promise.resolve();
  }
}

interface IlinkAccountFixture {
  readonly accountKey: IlinkAccountKey;
  readonly botId: string;
  readonly peerId: string;
  readonly token: string;
  cursor: string;
  nextMessageId: number;
}

interface PriorityHarness {
  readonly store: SqliteStore;
  readonly ilinkStore: IlinkSqliteStore;
  readonly agent: ControlledAgent;
  readonly processor: ConversationProcessor;
  registerIlink(label: string, token?: string): IlinkAccountFixture;
  ingestIlink(account: IlinkAccountFixture, text: string): string;
  ingestWecom(
    label: string,
    externalUserId: string,
    options?: { readonly deferred?: boolean },
  ): string;
}

async function createHarness(
  t: TestContext,
  onIlinkSend: (event: {
    readonly token: string;
    readonly content: string;
  }) => void | Promise<void> = () => undefined,
): Promise<PriorityHarness> {
  const temporary = await createTempSqlite(t, {
    prefix: 'ilink-priority-runtime-',
  });
  const store = temporary.trackSqlite(
    new SqliteStore({ filePath: temporary.filePath, clock: () => NOW }),
  );
  const ilinkStore = new IlinkSqliteStore({ store, clock: () => NOW });
  const secretBox = new IlinkSecretBox(Buffer.alloc(32, 37).toString('base64url'));
  let wecomSendSequence = 0;
  const wecom = new WechatKfToolExecutor({
    store,
    apiClient: {
      async sendPreparedMessage() {
        wecomSendSequence += 1;
        return { msgid: `wx-priority-${wecomSendSequence}` };
      },
    },
    mediaGateway: {
      async upload() { return { media_id: 'unused-upload' }; },
      async cloneForSend() { return 'unused-clone'; },
      async getCardThumbnailMediaId() { return 'unused-thumbnail'; },
    },
    observeMs: 0,
    logger: { info() {}, warn() {}, error() {} },
  });
  const ilink = new IlinkSendExecutor({
    store,
    ilinkStore,
    secretBox,
    createClient: ({ token }) => ({
      async sendMessage(request) {
        await onIlinkSend({
          token,
          content: request.msg.item_list?.[0]?.text_item?.text || '',
        });
      },
    }),
  });
  const agent = new ControlledAgent({ wecom, ilink });
  const channel = {
    async kick(channelName?: 'wechat_kf' | 'weixin_ilink'): Promise<void> {
      if (channelName !== 'weixin_ilink') await wecom.kick();
    },
    async notifyQueued(record: { readonly messageKey: string }): Promise<void> {
      await ilink.notifyQueued(record.messageKey);
    },
  };
  const processor = new ConversationProcessor({
    store,
    agent,
    mediaGateway: { async resolveForCodex() { return []; } },
    channel,
    allowedUserIds: [
      ...Array.from({ length: 9 }, (_, index) => `wm-occupied-${index}`),
      'wm-working-one',
      'wm-working-two',
      'wm-downtime-backlog',
    ],
    maxConcurrentConversations: 10,
    logger: { info() {}, warn() {}, error() {} },
  });
  const wecomCursors = new Map<string, string>();
  let wecomPage = 0;

  function registerIlink(label: string, token = `token-${label}`): IlinkAccountFixture {
    const botId = `${label}@im.bot`;
    const peerId = `${label}@im.wechat`;
    const accountKey = createIlinkAccountKey(botId);
    ilinkStore.registerAccount({
      providerAccountId: botId,
      ownerPeerId: peerId,
      baseUrl: 'https://ilinkai.weixin.qq.com/',
      encryptedBotToken: secretBox.seal(token, {
        secretKind: 'bot_token',
        accountId: accountKey,
        peerId,
        generation: 1,
      }),
      now: NOW,
    });
    return { accountKey, botId, peerId, token, cursor: '', nextMessageId: 1 };
  }

  function ingestIlink(account: IlinkAccountFixture, text: string): string {
    const messageId = account.nextMessageId;
    account.nextMessageId += 1;
    const normalized = normalizeIlinkInboundMessage({
      message_id: messageId,
      seq: messageId,
      from_user_id: account.peerId,
      to_user_id: account.botId,
      message_type: IlinkMessageType.USER,
      message_state: IlinkMessageState.FINISH,
      create_time_ms: NOW - 1_000 + messageId,
      context_token: `context-${account.botId}-${messageId}`,
      item_list: [{
        type: IlinkMessageItemType.TEXT,
        text_item: { text },
      }],
    }, {
      accountKey: account.accountKey,
      botId: account.botId,
      ownerUserId: account.peerId,
    }, {
      cursor: account.cursor || 'initial',
      index: 0,
    });
    assert.ok(normalized);
    const candidate = {
      ...normalized,
      sync: { cursor: account.cursor, index: 0 },
    };
    const secretGeneration = 10_000 + messageId;
    const nextCursor = `${account.botId}-cursor-${messageId}`;
    const page = ilinkStore.commitPollPage({
      accountKey: account.accountKey,
      expectedGeneration: 1,
      expectedCursor: account.cursor,
      nextCursor,
      messages: [{
        candidate,
        secretGeneration,
        sealedContextToken: secretBox.seal(candidate.contextToken, {
          secretKind: 'context_token',
          accountId: account.accountKey,
          peerId: account.peerId,
          generation: secretGeneration,
        }),
      }],
    });
    account.cursor = nextCursor;
    const messageKey = page.insertedMessageKeys[0];
    if (!messageKey) throw new Error('Expected a deliverable iLink message');
    return messageKey;
  }

  function ingestWecom(
    label: string,
    externalUserId: string,
    { deferred: isDeferred = false }: { readonly deferred?: boolean } = {},
  ): string {
    const openKfId = 'wk-priority-runtime';
    const expectedCursor = wecomCursors.get(openKfId) || '';
    wecomPage += 1;
    const nextCursor = `wecom-page-${wecomPage}`;
    const message = normalizeWecomMessage({
      msgid: label,
      open_kfid: openKfId,
      external_userid: externalUserId,
      origin: 3,
      msgtype: 'text',
      send_time: Math.floor(NOW / 1_000),
      text: { content: label },
    }, openKfId, { cursor: expectedCursor, index: 0 });
    const page = store.ingestSyncPage({
      openKfId,
      expectedCursor,
      nextCursor,
      messages: [message],
      deferred: isDeferred,
    });
    wecomCursors.set(openKfId, nextCursor);
    const messageKey = page.insertedMessageKeys[0];
    if (!messageKey) throw new Error('Expected a deliverable WeChat-KF message');
    return messageKey;
  }

  t.onTestFinished(async () => {
    await processor.abort();
    await processor.waitForIdle();
    await ilink.waitForIdle();
    await wecom.close();
    store.close();
  });

  return {
    store,
    ilinkStore,
    agent,
    processor,
    registerIlink,
    ingestIlink,
    ingestWecom,
  };
}

test('the global ten-conversation window queues one iLink conversation and serializes its notice before the formal reply', async (t) => {
  const noticeStarted = deferred<void>();
  const releaseNotice = deferred<void>();
  const targetToken = 'target-queue-token';
  const targetContents: string[] = [];
  let targetActive = 0;
  let targetPeak = 0;
  const harness = await createHarness(t, async ({ token, content }) => {
    if (token !== targetToken) return;
    targetContents.push(content);
    targetActive += 1;
    targetPeak = Math.max(targetPeak, targetActive);
    if (content === QUEUE_NOTICE) {
      noticeStarted.resolve();
      await releaseNotice.promise;
    }
    targetActive -= 1;
  });
  const occupiedIlink = harness.registerIlink('occupied-ilink');
  const queuedIlink = harness.registerIlink('queued-ilink', targetToken);
  const occupiedKeys = [
    ...Array.from({ length: 9 }, (_, index) =>
      harness.ingestWecom(`occupied-wecom-${index}`, `wm-occupied-${index}`)),
    harness.ingestIlink(occupiedIlink, 'occupied iLink question'),
  ];

  await Promise.all(occupiedKeys.map((messageKey) =>
    harness.processor.enqueue(messageKey),
  ));
  assert.equal(harness.agent.inputs.length, 10);
  assert.equal(harness.agent.maxActive, 10);
  assert.deepEqual(
    new Set(harness.agent.inputs.map((input) => input.channel)),
    new Set(['wechat_kf', 'weixin_ilink']),
  );

  const queuedKey = harness.ingestIlink(queuedIlink, 'eleventh iLink question');
  const queuedTask = harness.processor.enqueue(queuedKey);
  await noticeStarted.promise;
  assert.equal(harness.agent.inputs.length, 10);
  assert.deepEqual(targetContents, [QUEUE_NOTICE]);
  const queuedAttemptsBeforeRelease = harness.store.listMessageAttempts(queuedKey);
  assert.equal(
    queuedAttemptsBeforeRelease.filter((attempt) => attempt.source === 'queue_notice').length,
    1,
  );
  const windowSecret = harness.ilinkStore.getReplyWindowSecretBySource(queuedKey);
  assert.ok(windowSecret);
  const windowAfterNotice = harness.ilinkStore.getReplyWindow(windowSecret.replyWindowId);
  assert.equal(windowAfterNotice?.maxSends, 10);
  assert.equal(windowAfterNotice?.reservedSendCount, 0);
  assert.equal(windowAfterNotice?.transmittedSendCount, 1);

  await harness.agent.finish(occupiedKeys[0]!, 'release one global slot');
  await queuedTask;
  assert.equal(harness.agent.inputs.length, 11);
  assert.equal(harness.agent.inputs[10]?.message.messageKey, queuedKey);

  const formalReply = harness.agent.finish(queuedKey, 'formal iLink reply');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(targetContents, [QUEUE_NOTICE]);
  releaseNotice.resolve();
  await formalReply;
  await Promise.all(occupiedKeys.slice(1).map((messageKey) =>
    harness.agent.finish(messageKey, `finish ${messageKey}`),
  ));
  await harness.processor.waitForIdle();

  assert.equal(targetPeak, 1);
  assert.deepEqual(targetContents, [QUEUE_NOTICE, 'formal iLink reply']);
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
  assert.equal(
    harness.ilinkStore.getReplyWindow(windowSecret.replyWindowId)
      ?.transmittedSendCount,
    2,
  );
  assert.equal(harness.store.getInbound(queuedKey)?.status, 'completed');
  assert.ok(occupiedKeys.every(
    (messageKey) => harness.store.getInbound(messageKey)?.status === 'completed',
  ));
});

test('low-priority downtime backlog waits for zero working conversations and yields to live iLink input', async (t) => {
  const ilinkSends: string[] = [];
  const harness = await createHarness(t, ({ content }) => {
    ilinkSends.push(content);
  });
  const liveAccount = harness.registerIlink('live-priority');
  const highOne = harness.ingestWecom('working-one', 'wm-working-one');
  const highTwo = harness.ingestWecom('working-two', 'wm-working-two');
  const backlogKey = harness.ingestWecom(
    'downtime-backlog',
    'wm-downtime-backlog',
    { deferred: true },
  );

  await harness.processor.enqueue(highOne);
  await harness.processor.enqueue(highTwo);
  const backlog = harness.store.activateNextDeferredConversation();
  assert.deepEqual(backlog.map((record) => record.messageKey), [backlogKey]);
  const recovery = harness.processor.recover(backlog, { priority: 'low' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(
    harness.agent.inputs.map((input) => input.message.messageKey),
    [highOne, highTwo],
  );

  await harness.agent.finish(highOne, 'first working conversation done');
  await waitUntil(
    () => harness.store.getInbound(highOne)?.status === 'completed',
    'the first working conversation to release',
  );
  assert.equal(harness.agent.inputs.length, 2);

  await harness.agent.finish(highTwo, 'second working conversation done');
  await waitUntil(
    () => harness.agent.inputs.length === 3,
    'the low-priority backlog to start after all live work',
  );
  assert.equal(harness.agent.inputs[2]?.message.messageKey, backlogKey);
  assert.equal(harness.agent.starts[2]?.activeBefore, 0);

  const liveKey = harness.ingestIlink(liveAccount, 'new live iLink input');
  const liveTask = harness.processor.enqueue(liveKey);
  await waitUntil(
    () => harness.agent.inputs.length === 4,
    'the live iLink conversation to preempt the backlog',
  );
  await liveTask;
  await recovery;

  assert.deepEqual(harness.agent.interruptedMessageKeys, [backlogKey]);
  assert.equal(harness.agent.inputs[3]?.message.messageKey, liveKey);
  assert.equal(harness.agent.inputs[3]?.channel, 'weixin_ilink');
  assert.equal(harness.agent.starts[3]?.activeBefore, 0);
  assert.equal(harness.store.getInbound(backlogKey)?.status, 'received');
  assert.equal(harness.store.getInbound(backlogKey)?.deferred, true);
  assert.equal(harness.store.listMessageAttempts(backlogKey).length, 0);

  await harness.agent.finish(liveKey, 'live iLink reply');
  await harness.processor.waitForIdle();
  assert.deepEqual(ilinkSends, [QUEUE_NOTICE, 'live iLink reply']);
  assert.deepEqual(
    harness.store.listMessageAttempts(liveKey).map((attempt) => ({
      source: attempt.source,
      status: attempt.status,
    })),
    [
      { source: 'queue_notice', status: 'accepted' },
      { source: 'mcp_tool', status: 'accepted' },
    ],
  );
  assert.equal(harness.store.getInbound(liveKey)?.status, 'completed');
  assert.deepEqual(
    harness.agent.starts.map(({ messageKey, activeBefore }) => ({
      messageKey,
      activeBefore,
    })),
    [
      { messageKey: highOne, activeBefore: 0 },
      { messageKey: highTwo, activeBefore: 1 },
      { messageKey: backlogKey, activeBefore: 0 },
      { messageKey: liveKey, activeBefore: 0 },
    ],
  );
});
