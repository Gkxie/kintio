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
import type { CoreState } from '../../src/state/sqlite-store.ts';
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
  input: AgentInput;
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
    if (input.mode === 'steer') {
      const turn = this.#active.get(input.conversationId);
      if (!turn) throw new Error('No active turn to steer');
      this.inputs.push(input);
      turn.input = { ...input, message: turn.input.message };
      return {
        kind: 'steered',
        primaryMessageKey: turn.input.message.messageKey,
        turnId: `priority-turn-${this.#sequence}`,
      };
    }
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

  async finish(messageKey: string, content: string, expectedStatus = 'accepted'): Promise<string> {
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
    assert.equal(receipt.status, expectedStatus);
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
  readonly store: CoreState;
  readonly ilinkStore: IlinkSqliteStore;
  readonly agent: ControlledAgent;
  readonly processor: ConversationProcessor;
  advance(milliseconds: number): void;
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
  let now = NOW;
  const persistence = temporary.openPersistence({ clock: () => now });
  const store = persistence.core;
  const ilinkStore = persistence.createIlinkStore({ clock: () => now });
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
      cursor: account.cursor,
      index: 0,
    });
    assert.ok(normalized);
    const secretGeneration = 10_000 + messageId;
    const nextCursor = `${account.botId}-cursor-${messageId}`;
    const page = ilinkStore.commitPollPage({
      accountKey: account.accountKey,
      expectedGeneration: 1,
      expectedCursor: account.cursor,
      nextCursor,
      messages: [{
        message: normalized.message,
        ...(normalized.facts.providerSeq === undefined
          ? {}
          : { providerSeq: normalized.facts.providerSeq }),
        secretGeneration,
        sealedContextToken: secretBox.seal(normalized.facts.contextToken, {
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
      accountKey: openKfId,
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
    persistence.close();
  });

  return {
    store,
    ilinkStore,
    agent,
    processor,
    advance(milliseconds) { now += milliseconds; },
    registerIlink,
    ingestIlink,
    ingestWecom,
  };
}

test('stopping WeCom releases its queued work without invalidating active iLink sends; restarting recovers it once', async (t) => {
  const harness = await createHarness(t);
  const active = Array.from({ length: 10 }, (_, index) =>
    harness.ingestIlink(harness.registerIlink(`shared-slot-${index}`), 'occupy a shared slot'));
  await Promise.all(active.map((key) => harness.processor.enqueue(key)));
  const queued = harness.ingestWecom('paused-wecom', 'wm-working-one');
  const waiting = harness.processor.enqueue(queued);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.agent.inputs.length, 10);
  harness.processor.setChannelEnabled('wechat_kf', false);
  await waiting;
  await harness.processor.waitForChannelIdle('wechat_kf');
  assert.equal(harness.store.getInbound(queued)?.status, 'received');
  await harness.agent.finish(active[0]!, 'iLink capability remains valid');
  harness.processor.setChannelEnabled('wechat_kf', true);
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf'), { priority: 'high' });
  await waitUntil(() => harness.agent.inputs.some((input) => input.message.messageKey === queued), 'WeCom recovery');
  await harness.agent.finish(queued, 'resumed WeCom reply');
  await recovery;
  await Promise.all(active.slice(1).map((key) => harness.agent.finish(key, 'finish iLink')));
  await harness.processor.waitForIdle();
  assert.equal(harness.agent.inputs.filter((input) => input.message.messageKey === queued).length, 1);
  assert.equal(harness.store.getInbound(queued)?.status, 'completed');
  assert.equal(harness.agent.maxActive, 10);
});

test('a WeCom drain waits for its own active turn without waiting for an unrelated iLink turn', async (t) => {
  const harness = await createHarness(t);
  const wecom = harness.ingestWecom('draining-wecom', 'wm-working-one');
  const ilink = harness.ingestIlink(harness.registerIlink('still-working'), 'keep working');
  await Promise.all([harness.processor.enqueue(wecom), harness.processor.enqueue(ilink)]);
  harness.processor.setChannelEnabled('wechat_kf', false);
  let drained = false;
  const draining = harness.processor.waitForChannelIdle('wechat_kf').then(() => { drained = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(drained, false);
  await harness.agent.finish(wecom, 'drain current WeCom response');
  await draining;
  assert.equal(harness.processor.isIdle(), false);
  await harness.agent.finish(ilink, 'finish unrelated iLink work');
  await harness.processor.waitForIdle();
});

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

test('recovery rechecks current WeCom authorization before inspecting or starting an Agent', async (t) => {
  const harness = await createHarness(t);
  const messageKey = harness.ingestWecom('revoked-backlog', 'wm-working-one');
  harness.store.claimInbound({ messageKey });
  harness.store.setConversationThread({
    channel: 'wechat_kf', accountKey: 'wk-priority-runtime', peerId: 'wm-working-one', threadId: 'old-thread',
  });
  harness.processor.configureWecom([], { trigger: '', requiredConsecutive: 3, confirmationText: '' });
  let agentCalls = 0;
  harness.agent.ensureThread = async () => { agentCalls += 1; throw new Error('Agent must not start'); };
  Object.assign(harness.agent, {
    async inspectHistory() { agentCalls += 1; throw new Error('Agent history must not be inspected'); },
  });

  await harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf'));
  assert.equal(agentCalls, 0);
  assert.equal(harness.store.getInbound(messageKey)?.status, 'suppressed');
  assert.equal(harness.store.getInbound(messageKey)?.errorMessage, 'authorization_revoked');
  assert.deepEqual(harness.store.listRecoverableInbound('wechat_kf'), []);
});

test('a live follow-up steers an active recovered turn before its completion', async (t) => {
  const harness = await createHarness(t);
  const oldKey = harness.ingestWecom('active-recovery', 'wm-downtime-backlog');
  harness.store.claimInbound({ messageKey: oldKey });
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf'), { priority: 'low' });
  await waitUntil(() => harness.agent.inputs.length === 1, 'the recovered turn to start');

  const liveKey = harness.ingestWecom('new direction', 'wm-downtime-backlog');
  const online = harness.processor.enqueue(liveKey);
  await waitUntil(() => harness.agent.inputs.length === 2, 'live steering before recovery completion');
  await online;
  assert.deepEqual(harness.agent.inputs.map((input) => input.mode), ['start', 'steer']);
  assert.equal(harness.agent.starts.length, 1);
  assert.deepEqual(harness.agent.interruptedMessageKeys, []);
  await harness.agent.finish(oldKey, 'the latest direction');
  await recovery;
  await harness.processor.waitForIdle();
  assert.equal(harness.store.getInbound(oldKey)?.status, 'completed');
  assert.equal(harness.store.getInbound(liveKey)?.status, 'absorbed');
  assert.equal(harness.store.listMessageAttempts(oldKey).length, 1);
});

test('a live participant promotes their queued recovery without waiting for global idle', async (t) => {
  const harness = await createHarness(t);
  const busyKey = harness.ingestWecom('already-working', 'wm-working-one');
  await harness.processor.enqueue(busyKey);
  const oldKey = harness.ingestWecom('queued-recovery', 'wm-downtime-backlog');
  harness.store.claimInbound({ messageKey: oldKey });
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf').filter((record) => record.messageKey === oldKey), { priority: 'low' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.agent.inputs.length, 1);

  const liveKey = harness.ingestWecom('queued participant returned', 'wm-downtime-backlog');
  const online = harness.processor.enqueue(liveKey);
  await waitUntil(() => harness.agent.inputs.length === 3, 'promoted recovery and its live follow-up');
  await online;
  assert.deepEqual(harness.agent.inputs.map((input) => input.mode), ['start', 'start', 'steer']);
  assert.equal(harness.agent.maxActive, 2);
  await Promise.all([
    harness.agent.finish(oldKey, 'promoted response'),
    harness.agent.finish(busyKey, 'other response'),
  ]);
  await recovery;
  await harness.processor.waitForIdle();
  assert.equal(harness.store.getInbound(liveKey)?.status, 'absorbed');
});

test('promoting a waiting recovery preempts another low-priority conversation', async (t) => {
  const harness = await createHarness(t);
  const firstKey = harness.ingestWecom('running-low-recovery', 'wm-working-one');
  const secondKey = harness.ingestWecom('waiting-low-recovery', 'wm-downtime-backlog');
  harness.store.claimInbound({ messageKey: firstKey });
  harness.store.claimInbound({ messageKey: secondKey });
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf'), { priority: 'low' });
  await waitUntil(() => harness.agent.inputs.length === 1, 'one active low-priority conversation');
  const liveKey = harness.ingestWecom('the waiting participant returned', 'wm-downtime-backlog');
  const online = harness.processor.enqueue(liveKey);
  await waitUntil(() => harness.agent.inputs.length === 3, 'promoted recovery to interrupt unrelated backlog and steer');
  await online;
  assert.deepEqual(harness.agent.interruptedMessageKeys, [firstKey]);
  assert.deepEqual(harness.agent.inputs.map((input) => input.mode), ['start', 'start', 'steer']);
  assert.equal(harness.store.getInbound(firstKey)?.deferred, true);
  assert.equal(harness.store.listMessageAttempts(firstKey).length, 0);
  await harness.agent.finish(secondKey, 'current response');
  await recovery;
  await harness.processor.waitForIdle();
});

test('a live participant arriving before the recovery slot request is still high priority', async (t) => {
  const harness = await createHarness(t);
  const busyKey = harness.ingestWecom('busy-before-recovery', 'wm-working-one');
  await harness.processor.enqueue(busyKey);
  const oldKey = harness.ingestWecom('not-yet-waiting', 'wm-downtime-backlog');
  harness.store.claimInbound({ messageKey: oldKey });
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf').filter((record) => record.messageKey === oldKey), { priority: 'low' });
  const liveKey = harness.ingestWecom('immediately returned', 'wm-downtime-backlog');
  const online = harness.processor.enqueue(liveKey);
  await waitUntil(() => harness.agent.inputs.some((input) => input.message.messageKey === liveKey), 'live admission without waiting for idle');
  await online;
  assert.equal(harness.agent.maxActive, 2);
  assert.deepEqual(harness.agent.inputs.map((input) => input.mode), ['start', 'start', 'steer']);
  await Promise.all([
    harness.agent.finish(oldKey, 'current reply'),
    harness.agent.finish(busyKey, 'other reply'),
  ]);
  await recovery;
  await harness.processor.waitForIdle();
  assert.equal(harness.store.getInbound(liveKey)?.status, 'absorbed');
});

test('promoting a queued recovery respects ten active conversations and sends only one queue notice', async (t) => {
  const harness = await createHarness(t);
  const busyKeys = Array.from({ length: 10 }, (_, index) => harness.ingestWecom(
    `busy-capacity-${index}`, index === 9 ? 'wm-working-one' : `wm-occupied-${index}`,
  ));
  await Promise.all(busyKeys.map((key) => harness.processor.enqueue(key)));
  const oldKey = harness.ingestWecom('capacity-backlog', 'wm-downtime-backlog');
  harness.store.claimInbound({ messageKey: oldKey });
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf').filter((record) => record.messageKey === oldKey), { priority: 'low' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const liveKey = harness.ingestWecom('capacity participant returned', 'wm-downtime-backlog');
  const online = harness.processor.enqueue(liveKey);
  const duplicate = harness.processor.enqueue(liveKey);
  await waitUntil(() => harness.store.listMessageAttempts(liveKey).length === 1, 'one queue notice');
  assert.equal(harness.agent.starts.length, 10);
  await harness.agent.finish(busyKeys[0]!, 'free one slot');
  await Promise.all([online, duplicate]);
  assert.equal(harness.agent.starts.length, 11);
  assert.equal(harness.agent.maxActive, 10);
  assert.equal(harness.store.listMessageAttempts(liveKey).filter((attempt) => attempt.source === 'queue_notice').length, 1);
  await Promise.all([
    harness.agent.finish(oldKey, 'promoted reply'),
    ...busyKeys.slice(1).map((key) => harness.agent.finish(key, 'finish other conversation')),
  ]);
  await recovery;
  await harness.processor.waitForIdle();
});

for (const phase of ['history inspection', 'thread preparation', 'start RPC'] as const) {
  test(`same-participant input arriving during recovery ${phase} does not start a second turn`, async (t) => {
    const harness = await createHarness(t);
    const oldKey = harness.ingestWecom(`recover-${phase}`, 'wm-downtime-backlog');
    harness.store.claimInbound({ messageKey: oldKey });
    const reached = deferred<void>();
    const proceed = deferred<void>();
    if (phase === 'history inspection') {
      harness.store.setConversationThread({
        channel: 'wechat_kf', accountKey: 'wk-priority-runtime', peerId: 'wm-downtime-backlog', threadId: 'history-thread',
      });
      Object.assign(harness.agent, {
        async inspectHistory() {
          reached.resolve();
          await proceed.promise;
          return { state: 'missing', turnId: '', foundClientInputIds: new Set(), artifacts: [] };
        },
      });
    } else if (phase === 'thread preparation') {
      const ensure = harness.agent.ensureThread.bind(harness.agent);
      harness.agent.ensureThread = async (conversationId, threadId) => {
        reached.resolve();
        await proceed.promise;
        return ensure(conversationId, threadId);
      };
    } else {
      const submit = harness.agent.submit.bind(harness.agent);
      harness.agent.submit = async (input) => {
        if (input.mode === 'start') {
          reached.resolve();
          await proceed.promise;
        }
        return submit(input);
      };
    }
    const recovery = harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf'), { priority: 'low' });
    await reached.promise;
    const liveKey = harness.ingestWecom(`new direction during ${phase}`, 'wm-downtime-backlog');
    const online = harness.processor.enqueue(liveKey);
    proceed.resolve();
    await online;
    assert.deepEqual(harness.agent.inputs.map((input) => input.mode), ['start', 'steer']);
    assert.deepEqual(harness.agent.interruptedMessageKeys, []);
    await harness.agent.finish(oldKey, 'current response');
    await recovery;
    await harness.processor.waitForIdle();
    assert.equal(harness.store.getInbound(liveKey)?.status, 'absorbed');
  });
}

test('iLink live steering renews a recovered turn capability without replaying the previous window', async (t) => {
  const sends: string[] = [];
  const harness = await createHarness(t, ({ content }) => { sends.push(content); });
  const account = harness.registerIlink('active-recovery-window');
  const oldKey = harness.ingestIlink(account, 'old request');
  harness.store.claimInbound({ messageKey: oldKey });
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('weixin_ilink'), { priority: 'low' });
  await waitUntil(() => harness.agent.inputs.length === 1, 'iLink recovered turn');
  const oldToken = harness.agent.inputs[0]!.toolSessionToken;
  const liveKey = harness.ingestIlink(account, 'latest request');
  await harness.processor.enqueue(liveKey);
  assert.deepEqual(harness.agent.inputs.map((input) => input.mode), ['start', 'steer']);
  assert.throws(() => harness.store.getAgentSession(oldToken));
  assert.notEqual(harness.agent.inputs[1]?.toolSessionToken, oldToken);
  await harness.agent.finish(oldKey, 'latest iLink reply');
  await recovery;
  await harness.processor.waitForIdle();
  assert.deepEqual(sends, ['latest iLink reply']);
  assert.equal(harness.store.getInbound(liveKey)?.status, 'absorbed');
  const window = harness.ilinkStore.getReplyWindowSecretBySource(liveKey)!;
  assert.equal(harness.ilinkStore.getReplyWindow(window.replyWindowId)?.transmittedSendCount, 1);
});

test('a newer iLink window retires a queued old recovery and admits only the current message', async (t) => {
  const harness = await createHarness(t);
  const busyKey = harness.ingestWecom('busy-before-window', 'wm-working-one');
  await harness.processor.enqueue(busyKey);
  const account = harness.registerIlink('waiting-window');
  const oldKey = harness.ingestIlink(account, 'old request');
  harness.store.claimInbound({ messageKey: oldKey });
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('weixin_ilink'), { priority: 'low' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const liveKey = harness.ingestIlink(account, 'latest request');
  await harness.processor.enqueue(liveKey);
  assert.deepEqual(harness.agent.starts.map((input) => input.messageKey), [busyKey, liveKey]);
  assert.equal(harness.store.getInbound(oldKey)?.status, 'suppressed');
  await Promise.all([harness.agent.finish(liveKey, 'latest reply'), harness.agent.finish(busyKey, 'other reply')]);
  await recovery;
  await harness.processor.waitForIdle();
});

test('duplicate recovery registration and duplicate live enqueue do not replay an accepted turn', async (t) => {
  const harness = await createHarness(t);
  const oldKey = harness.ingestWecom('duplicate-recovery', 'wm-downtime-backlog');
  harness.store.claimInbound({ messageKey: oldKey });
  const records = harness.store.listRecoverableInbound('wechat_kf');
  const first = harness.processor.recover(records, { priority: 'low' });
  const second = harness.processor.recover(records, { priority: 'low' });
  await waitUntil(() => harness.agent.inputs.length === 1, 'one recovered turn');
  await harness.processor.enqueue(oldKey);
  const liveKey = harness.ingestWecom('duplicate-live', 'wm-downtime-backlog');
  await Promise.all([harness.processor.enqueue(liveKey), harness.processor.enqueue(liveKey)]);
  await harness.agent.finish(oldKey, 'only reply');
  await Promise.all([first, second]);
  await harness.processor.waitForIdle();
  assert.deepEqual(harness.agent.inputs.map((input) => input.mode), ['start', 'steer']);
  assert.equal(harness.store.listMessageAttempts(oldKey).length, 1);
});

test('duplicate recovery registration does not resend an uncertain iLink delivery', async (t) => {
  let sends = 0;
  const harness = await createHarness(t, () => {
    sends += 1;
    throw new Error('Connection closed after transmission');
  });
  const account = harness.registerIlink('uncertain-recovery');
  const oldKey = harness.ingestIlink(account, 'request with uncertain outcome');
  harness.store.claimInbound({ messageKey: oldKey });
  const records = harness.store.listRecoverableInbound('weixin_ilink');
  const first = harness.processor.recover(records, { priority: 'low' });
  const second = harness.processor.recover(records, { priority: 'low' });
  await waitUntil(() => harness.agent.inputs.length === 1, 'one recovered iLink turn');
  const attemptId = await harness.agent.finish(oldKey, 'one transmission', 'uncertain');
  await Promise.all([first, second]);
  await harness.processor.waitForIdle();
  assert.equal(sends, 1);
  assert.equal(harness.agent.starts.length, 1);
  assert.equal(harness.store.getAttempt(attemptId)?.status, 'uncertain');
  assert.equal(harness.store.getInbound(oldKey)?.status, 'completed');
});

test('a promoted active recovery shares capacity with other live conversations without being interrupted', async (t) => {
  const harness = await createHarness(t);
  const oldKey = harness.ingestWecom('active-promoted', 'wm-downtime-backlog');
  harness.store.claimInbound({ messageKey: oldKey });
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf'), { priority: 'low' });
  await waitUntil(() => harness.agent.inputs.length === 1, 'the recovered turn');
  const liveKey = harness.ingestWecom('participant returned', 'wm-downtime-backlog');
  await harness.processor.enqueue(liveKey);
  const otherKey = harness.ingestWecom('other live participant', 'wm-working-one');
  await harness.processor.enqueue(otherKey);
  assert.equal(harness.agent.maxActive, 2);
  assert.deepEqual(harness.agent.interruptedMessageKeys, []);
  await Promise.all([harness.agent.finish(oldKey, 'latest reply'), harness.agent.finish(otherKey, 'other reply')]);
  await recovery;
  await harness.processor.waitForIdle();
});

test('a live participant arriving during a pending backlog interrupt waits for cancellation, not the old turn', async (t) => {
  const harness = await createHarness(t);
  const oldKey = harness.ingestWecom('about-to-interrupt', 'wm-downtime-backlog');
  harness.store.claimInbound({ messageKey: oldKey });
  const interruptStarted = deferred<void>();
  const releaseInterrupt = deferred<void>();
  const interrupt = harness.agent.interrupt.bind(harness.agent);
  harness.agent.interrupt = async (conversationId) => {
    interruptStarted.resolve();
    await releaseInterrupt.promise;
    return interrupt(conversationId);
  };
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf'), { priority: 'low' });
  await waitUntil(() => harness.agent.inputs.length === 1, 'interruptible recovery');
  const otherKey = harness.ingestWecom('other queued live participant', 'wm-working-one');
  const other = harness.processor.enqueue(otherKey);
  await interruptStarted.promise;
  const liveKey = harness.ingestWecom('returned during interrupt', 'wm-downtime-backlog');
  const online = harness.processor.enqueue(liveKey);
  releaseInterrupt.resolve();
  await Promise.all([online, other, recovery]);
  assert.ok(harness.agent.inputs.every((input) => input.mode === 'start'));
  assert.deepEqual(harness.agent.interruptedMessageKeys, [oldKey]);
  assert.equal(harness.store.listMessageAttempts(oldKey).length, 0);
  await Promise.all([harness.agent.finish(liveKey, 'fresh current reply'), harness.agent.finish(otherKey, 'other reply')]);
  await harness.processor.waitForIdle();
});

test('separate historical messages remain separate turns rather than steering one another', async (t) => {
  const harness = await createHarness(t);
  const firstKey = harness.ingestWecom('first historical question', 'wm-downtime-backlog');
  const secondKey = harness.ingestWecom('second historical question', 'wm-downtime-backlog');
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf'), { priority: 'low' });
  await waitUntil(() => harness.agent.inputs.length === 1, 'first historical turn');
  assert.equal(harness.agent.inputs[0]?.message.messageKey, firstKey);
  await harness.agent.finish(firstKey, 'first historical reply');
  await waitUntil(() => harness.agent.inputs.length === 2, 'second historical turn');
  await harness.agent.finish(secondKey, 'second historical reply');
  await recovery;
  await harness.processor.waitForIdle();
  assert.deepEqual(harness.agent.inputs.map((input) => input.mode), ['start', 'start']);
  assert.equal(harness.agent.maxActive, 1);
  assert.equal(harness.store.listMessageAttempts(firstKey).length, 1);
  assert.equal(harness.store.listMessageAttempts(secondKey).length, 1);
});

test('a delivered live direction renews independent recovery units and leaves their admission low priority', async (t) => {
  const harness = await createHarness(t);
  const firstKey = harness.ingestWecom('first old question', 'wm-downtime-backlog');
  harness.store.claimInbound({ messageKey: firstKey });
  const secondKey = harness.ingestWecom('second old question', 'wm-downtime-backlog');
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf'), { priority: 'low' });
  await waitUntil(() => harness.agent.inputs.length === 1, 'the first recovered unit');
  const liveKey = harness.ingestWecom('a current direction', 'wm-downtime-backlog');
  await harness.processor.enqueue(liveKey);
  const busyKey = harness.ingestWecom('another live conversation', 'wm-working-one');
  await harness.processor.enqueue(busyKey);
  const attemptId = await harness.agent.finish(firstKey, 'the current response');
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(harness.agent.inputs.length, 3);
  assert.equal(harness.store.getInbound(secondKey)?.status, 'received');
  await harness.agent.finish(busyKey, 'other live response');
  await waitUntil(() => harness.agent.inputs.length === 4, 'independent historical unit with the renewed reply boundary');
  await harness.agent.finish(secondKey, 'the independent historical response');
  await recovery;
  await harness.processor.waitForIdle();
  assert.deepEqual(harness.agent.inputs.map((input) => input.mode), ['start', 'steer', 'start', 'start']);
  assert.equal(harness.store.getAttempt(attemptId)?.status, 'accepted');
  assert.equal(harness.store.listMessageAttempts(firstKey).length, 1);
  assert.equal(harness.store.listMessageAttempts(secondKey).length, 1);
  assert.equal(harness.store.getInbound(secondKey)?.status, 'completed');
});

test('iLink recovery does not replay an older input already absorbed into live context after an uncertain send', async (t) => {
  const sends: string[] = [];
  const harness = await createHarness(t, ({ content }) => {
    sends.push(content);
    throw new Error('Connection lost after transmission');
  });
  const account = harness.registerIlink('independent-window');
  const firstKey = harness.ingestIlink(account, 'first old request');
  harness.store.claimInbound({ messageKey: firstKey });
  const secondKey = harness.ingestIlink(account, 'second independent request');
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('weixin_ilink'), { priority: 'low' });
  await waitUntil(() => harness.agent.inputs.length === 1, 'first recovered iLink unit');
  const liveKey = harness.ingestIlink(account, 'current request');
  await harness.processor.enqueue(liveKey);
  assert.equal(harness.store.getInbound(secondKey)?.status, 'absorbed');
  assert.match(harness.agent.inputs[1]!.contextText, /second independent request/u);
  const attemptId = await harness.agent.finish(firstKey, 'current response', 'uncertain');
  await recovery;
  await harness.processor.waitForIdle();
  assert.deepEqual(sends, ['current response']);
  assert.equal(harness.store.getAttempt(attemptId)?.status, 'uncertain');
  assert.equal(harness.agent.starts.length, 1);
  const window = harness.ilinkStore.getReplyWindowSecretBySource(liveKey)!;
  assert.equal(harness.ilinkStore.getReplyWindow(window.replyWindowId)?.transmittedSendCount, 1);
});

test('recovery retires a superseded iLink window without waking the Agent or replaying a completed reply', async (t) => {
  const sends: string[] = [];
  const harness = await createHarness(t, ({ content }) => { sends.push(content); });
  const account = harness.registerIlink('recovery-window');
  const oldKey = harness.ingestIlink(account, 'old request');
  harness.store.claimInbound({ messageKey: oldKey });
  const newKey = harness.ingestIlink(account, 'current request');
  await harness.processor.enqueue(newKey);
  await harness.agent.finish(newKey, 'current reply');
  await harness.processor.waitForIdle();
  let agentCalls = 0;
  harness.agent.ensureThread = async () => { agentCalls += 1; throw new Error('Agent must not start'); };
  Object.assign(harness.agent, {
    async inspectHistory() { agentCalls += 1; throw new Error('Agent history must not be inspected'); },
  });

  await harness.processor.recover(harness.store.listRecoverableInbound('weixin_ilink'));
  await harness.processor.recover(harness.store.listRecoverableInbound('weixin_ilink'));
  assert.equal(agentCalls, 0);
  assert.equal(harness.store.getInbound(oldKey)?.status, 'suppressed');
  assert.equal(harness.store.getInbound(oldKey)?.errorMessage, 'reply_boundary_unavailable');
  assert.equal(harness.store.getInbound(newKey)?.status, 'completed');
  assert.deepEqual(harness.store.listRecoverableInbound('weixin_ilink'), []);
  assert.deepEqual(sends, ['current reply']);
  assert.equal(harness.store.listMessageAttempts(newKey)[0]?.status, 'accepted');
});

test('backlog preparation yields to live input before starting a model turn', async (t) => {
  const sends: string[] = [];
  const harness = await createHarness(t, ({ content }) => { sends.push(content); });
  const liveAccount = harness.registerIlink('preparing-priority');
  const backlogKey = harness.ingestWecom('preparing-backlog', 'wm-downtime-backlog', { deferred: true });
  const preparing = deferred<void>();
  const ready = deferred<void>();
  const ensure = harness.agent.ensureThread.bind(harness.agent);
  harness.agent.ensureThread = async (conversationId, threadId) => {
    preparing.resolve();
    await ready.promise;
    return ensure(conversationId, threadId);
  };
  const recovery = harness.processor.recover(harness.store.activateNextDeferredConversation(), { priority: 'low' });
  await preparing.promise;
  const liveKey = harness.ingestIlink(liveAccount, 'live during preparation');
  const online = harness.processor.enqueue(liveKey);
  await waitUntil(() => sends.includes(QUEUE_NOTICE), 'the live conversation to enter the high-priority queue');
  ready.resolve();
  await waitUntil(() => harness.agent.inputs.some((input) => input.message.messageKey === liveKey), 'live input to run before the prepared backlog');
  await Promise.all([recovery, online]);
  assert.deepEqual(harness.agent.inputs.map((input) => input.message.messageKey), [liveKey]);
  assert.equal(harness.store.getInbound(backlogKey)?.deferred, true);
  assert.equal(harness.store.getInbound(backlogKey)?.status, 'received');
  assert.equal(harness.store.listMessageAttempts(backlogKey).length, 0);
  assert.equal(harness.agent.maxActive, 1);
  await harness.agent.finish(liveKey, 'live reply');
  await harness.processor.waitForIdle();
});

test('expired iLink recovery becomes terminal before any Agent inspection or submission', async (t) => {
  const harness = await createHarness(t);
  const account = harness.registerIlink('expired-backlog');
  const messageKey = harness.ingestIlink(account, 'expired request');
  harness.store.claimInbound({ messageKey });
  harness.advance(24 * 60 * 60 * 1_000);
  let agentCalls = 0;
  harness.agent.ensureThread = async () => { agentCalls += 1; throw new Error('must not start'); };
  await harness.processor.recover(harness.store.listRecoverableInbound('weixin_ilink'));
  await harness.processor.waitForIdle();
  assert.equal(agentCalls, 0);
  assert.equal(harness.store.getInbound(messageKey)?.status, 'suppressed');
  assert.deepEqual(harness.store.listRecoverableInbound('weixin_ilink'), []);
});

test('recovery history inspection waits for the same idle window as model execution', async (t) => {
  const harness = await createHarness(t);
  const liveKey = harness.ingestIlink(harness.registerIlink('history-priority'), 'live request');
  await harness.processor.enqueue(liveKey);
  const backlogKey = harness.ingestWecom('history-backlog', 'wm-downtime-backlog');
  harness.store.claimInbound({ messageKey: backlogKey });
  harness.store.setConversationThread({
    channel: 'wechat_kf', accountKey: 'wk-priority-runtime', peerId: 'wm-downtime-backlog', threadId: 'history-thread',
  });
  let inspections = 0;
  Object.assign(harness.agent, {
    async inspectHistory() {
      inspections += 1;
      return { state: 'missing', turnId: '', foundClientInputIds: new Set(), artifacts: [] };
    },
  });
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf'), { priority: 'low' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(inspections, 0);
  await harness.agent.finish(liveKey, 'live reply');
  await waitUntil(() => harness.agent.inputs.some((input) => input.message.messageKey === backlogKey), 'recovery after live work');
  assert.equal(inspections, 1);
  assert.equal(harness.agent.maxActive, 1);
  await harness.agent.finish(backlogKey, 'recovered reply');
  await recovery;
  await harness.processor.waitForIdle();
});

test('live input arriving during the Agent start RPC preempts backlog once the turn is interruptible', async (t) => {
  const sends: string[] = [];
  const harness = await createHarness(t, ({ content }) => { sends.push(content); });
  const backlogKey = harness.ingestWecom('starting-backlog', 'wm-downtime-backlog', { deferred: true });
  const starting = deferred<void>();
  const ready = deferred<void>();
  const submit = harness.agent.submit.bind(harness.agent);
  harness.agent.submit = async (input) => {
    if (input.message.messageKey === backlogKey) {
      starting.resolve();
      await ready.promise;
    }
    return submit(input);
  };
  const recovery = harness.processor.recover(harness.store.activateNextDeferredConversation(), { priority: 'low' });
  await starting.promise;
  const liveKey = harness.ingestIlink(harness.registerIlink('starting-priority'), 'live during start RPC');
  const online = harness.processor.enqueue(liveKey);
  await waitUntil(() => sends.includes(QUEUE_NOTICE), 'live input queued during start RPC');
  ready.resolve();
  await waitUntil(() => harness.agent.inputs.some((input) => input.message.messageKey === liveKey), 'live turn after backlog interrupt');
  await Promise.all([recovery, online]);
  assert.deepEqual(harness.agent.interruptedMessageKeys, [backlogKey]);
  assert.equal(harness.store.getInbound(backlogKey)?.deferred, true);
  assert.equal(harness.store.listMessageAttempts(backlogKey).length, 0);
  assert.equal(harness.agent.maxActive, 1);
  await harness.agent.finish(liveKey, 'live reply');
  await harness.processor.waitForIdle();
});

test('authorization revoked during thread preparation prevents starting the model', async (t) => {
  const harness = await createHarness(t);
  const messageKey = harness.ingestWecom('revoked-during-preparation', 'wm-working-one');
  harness.agent.ensureThread = async () => {
    harness.processor.configureWecom([], { trigger: '', requiredConsecutive: 3, confirmationText: '' });
    return 'prepared-thread';
  };
  await harness.processor.enqueue(messageKey);
  await harness.processor.waitForIdle();
  assert.deepEqual(harness.agent.inputs, []);
  assert.equal(harness.store.getInbound(messageKey)?.status, 'suppressed');
});

test('stopping a channel releases its waiting recovery without inspecting or losing that message', async (t) => {
  const harness = await createHarness(t);
  const liveKey = harness.ingestIlink(harness.registerIlink('paused-recovery'), 'live request');
  await harness.processor.enqueue(liveKey);
  const backlogKey = harness.ingestWecom('paused-backlog', 'wm-downtime-backlog');
  harness.store.claimInbound({ messageKey: backlogKey });
  harness.store.setConversationThread({
    channel: 'wechat_kf', accountKey: 'wk-priority-runtime', peerId: 'wm-downtime-backlog', threadId: 'paused-thread',
  });
  let inspections = 0;
  Object.assign(harness.agent, {
    async inspectHistory() { inspections += 1; throw new Error('stopped channel must not inspect history'); },
  });
  const recovery = harness.processor.recover(harness.store.listRecoverableInbound('wechat_kf'), { priority: 'low' });
  await new Promise<void>((resolve) => setImmediate(resolve));
  harness.processor.setChannelEnabled('wechat_kf', false);
  await recovery;
  assert.equal(inspections, 0);
  assert.equal(harness.store.getInbound(backlogKey)?.status, 'processing');
  assert.equal(harness.store.listRecoverableInbound('wechat_kf')[0]?.messageKey, backlogKey);
  await harness.agent.finish(liveKey, 'live reply');
  await harness.processor.waitForIdle();
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
