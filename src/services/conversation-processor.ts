import { createHash } from 'node:crypto';

import {
  COMMON_MESSAGE_TYPES,
  MESSAGE_ORIGINS,
  isProcessableCustomerMessage,
  isSystemEvent,
  renderMessageForAgent,
} from '../domain/message.ts';
import type {
  ChannelIdentity,
  ChatChannel,
  Logger,
  NormalizedMessage,
  ResolvedImage,
} from '../types.ts';
import type {
  AgentAccess,
  AgentCompletion,
  AgentImageArtifact,
  AgentInput,
  AgentMessage,
  AgentRuntime,
  AgentSubmission,
} from '../agent/runtime.ts';
import type { CoreState, InboundRecord } from '../state/sqlite-store.ts';

type ChannelMessage = NormalizedMessage & { readonly messageKey: string };
type WorkPriority = 'high' | 'low';
type SlotWaiter = {
  readonly key: string;
  readonly record: InboundRecord;
  readonly priority: WorkPriority;
  readonly resolve: () => void;
};

interface MediaGateway {
  resolveForCodex(message: ChannelMessage): Promise<readonly ResolvedImage[]>;
}

interface SendDrain {
  kick(channel?: ChatChannel): Promise<void>;
  notifyQueued?(record: InboundRecord): Promise<void>;
}

interface ProcessorOptions {
  readonly store: CoreState;
  readonly agent: AgentRuntime;
  readonly mediaGateway: MediaGateway;
  readonly channel: SendDrain;
  readonly agentAccess?: (record: ChannelIdentity) => AgentAccess;
  readonly allowedUserIds?: readonly string[];
  readonly authorization?: {
    readonly trigger?: string;
    readonly requiredConsecutive?: number;
    readonly confirmationText?: string;
  };
  readonly logger?: Logger;
  readonly maxConcurrentConversations?: number;
}

type UnboundAgentInput = Omit<
  AgentInput,
  | 'channel'
  | 'agentAccess'
  | 'mode'
  | 'conversationId'
  | 'threadId'
  | 'toolSessionToken'
>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function messageFromRecord(record: InboundRecord): ChannelMessage {
  const payload = (record.payload || {}) as unknown as Partial<NormalizedMessage>;
  if (
    (payload.providerMessageId &&
      payload.providerMessageId !== record.providerMessageId) ||
    (payload.conversation?.channel &&
      payload.conversation.channel !== record.channel) ||
    (payload.conversation?.accountKey &&
      payload.conversation.accountKey !== record.accountKey) ||
    (payload.conversation?.peerId &&
      payload.conversation.peerId !== record.peerId)
  ) {
    throw new Error(`Inbound payload identity mismatch: ${record.messageKey}`);
  }
  return Object.freeze({
    providerMessageId: record.providerMessageId,
    messageKey: record.messageKey,
    origin: record.origin,
    type: record.type,
    rawType: payload.rawType || record.type,
    sentAt: record.sentAt,
    sync: payload.sync || { cursor: '', index: 0 },
    conversation: {
      channel: record.channel,
      accountKey: record.accountKey,
      peerId: record.peerId,
    },
    text: payload.text || '',
    summary: payload.summary || payload.text || '[Channel message: no readable summary]',
    attributes: payload.attributes || {},
    attachments: payload.attachments || [],
  });
}

function agentMessage(message: ChannelMessage): AgentMessage {
  return {
    messageKey: message.messageKey,
    text: message.text,
    summary: message.summary,
  };
}

function conversationId(record: ChannelIdentity): string {
  return `cv_${createHash('sha256')
    .update(`${record.channel}\0${record.accountKey}\0${record.peerId}`)
    .digest('hex').slice(0, 32)}`;
}

export class ConversationProcessor {
  readonly #store: CoreState;
  readonly #pipeline: Pick<
    ProcessorOptions,
    'agent' | 'mediaGateway' | 'channel' | 'agentAccess'
  >;
  readonly #allowedUsers: ReadonlySet<string>;
  readonly #authorization: {
    readonly trigger: string;
    readonly requiredConsecutive: number;
    readonly confirmationText: string;
  };
  readonly #logger: Logger;
  readonly #queues = new Map<string, Promise<void>>();
  readonly #recoveries = new Map<string, Promise<void>>();
  readonly #background = new Set<Promise<void>>();
  readonly #onlineRetries = new Map<string, number>();
  readonly #activeConversations = new Map<string, {
    readonly record: InboundRecord;
    readonly priority: WorkPriority;
  }>();
  readonly #highWaiters: SlotWaiter[] = [];
  readonly #lowWaiters: SlotWaiter[] = [];
  readonly #queueNotified = new Set<string>();
  readonly #preempting = new Set<string>();
  readonly #maxConcurrentConversations: number;
  #accepting = true;

  constructor(options: ProcessorOptions) {
    this.#store = options.store;
    this.#pipeline = options;
    this.#allowedUsers = new Set(options.allowedUserIds || []);
    this.#authorization = {
      trigger: options.authorization?.trigger || '',
      requiredConsecutive: Math.max(
        1,
        Number(options.authorization?.requiredConsecutive) || 3,
      ),
      confirmationText:
        options.authorization?.confirmationText ||
        'Code accepted. You can continue the conversation.',
    };
    this.#logger = options.logger || console;
    this.#maxConcurrentConversations = Math.max(
      1,
      Math.min(Number(options.maxConcurrentConversations) || 10, 10),
    );
  }

  #message(record: InboundRecord): ChannelMessage | undefined {
    try {
      return messageFromRecord(record);
    } catch (error: unknown) {
      const current = this.#store.getInbound(record.messageKey);
      if (current?.status === 'received') {
        this.#store.markInboundIgnored(record.messageKey);
      } else {
        this.#store.suppressInbound(record.messageKey, 'invalid_persisted_identity');
      }
      this.#logger.error?.(
        `[processor] rejected inbound identity mismatch message_key=${record.messageKey}: ${errorMessage(error)}`,
      );
      return undefined;
    }
  }

  #mediaCatalog(record: ChannelIdentity) {
    return this.#store.listRecentMedia({
      channel: record.channel,
      accountKey: record.accountKey,
      peerId: record.peerId,
      limit: 10,
    }).map(({ ref, kind, messageKey }) => ({ ref, kind, messageKey }));
  }

  #conversationKey(record: ChannelIdentity): string {
    return `${record.channel}\0${record.accountKey}\0${record.peerId}`;
  }

  #agentAccess(record: ChannelIdentity): AgentAccess {
    return this.#pipeline.agentAccess?.(record) === 'host' ? 'host' : 'restricted';
  }

  #notifyQueued(record: InboundRecord): void {
    const key = this.#conversationKey(record);
    if (this.#queueNotified.has(key)) return;
    this.#queueNotified.add(key);
    if (record.channel === 'weixin_ilink') {
      void this.#pipeline.channel.notifyQueued?.(record).catch((error: unknown) => {
        this.#logger.error?.(
          `[ilink] queue notice failed message_key=${record.messageKey}: ${errorMessage(error)}`,
        );
      });
      return;
    }
    try {
      this.#store.reserveQueueNotice(record.messageKey);
      void this.#pipeline.channel.kick(record.channel);
    } catch (error: unknown) {
      this.#logger.error?.(
        `[processor] queue notice failed message_key=${record.messageKey}: ${errorMessage(error)}`,
      );
    }
  }

  #wakeWaiters(): void {
    while (
      this.#highWaiters.length &&
      this.#activeConversations.size < this.#maxConcurrentConversations &&
      ![...this.#activeConversations.values()].some(({ priority }) => priority === 'low')
    ) {
      const waiter = this.#highWaiters.shift()!;
      this.#activeConversations.set(waiter.key, {
        record: waiter.record,
        priority: waiter.priority,
      });
      waiter.resolve();
    }
    if (
      this.#activeConversations.size === 0 &&
      this.#highWaiters.length === 0 &&
      this.#lowWaiters.length
    ) {
      const waiter = this.#lowWaiters.shift()!;
      this.#activeConversations.set(waiter.key, {
        record: waiter.record,
        priority: waiter.priority,
      });
      waiter.resolve();
    }
  }

  async #preemptLow(exceptKey: string): Promise<void> {
    const entry = [...this.#activeConversations.entries()].find(
      ([key, active]) => key !== exceptKey && active.priority === 'low',
    );
    if (!entry || !this.#pipeline.agent.interrupt) return;
    const [, active] = entry;
    const opaqueId = conversationId(active.record);
    const primary = this.#pipeline.agent.activePrimary(opaqueId);
    if (!primary || this.#store.listMessageAttempts(primary).length) return;
    this.#preempting.add(primary);
    try {
      if (!await this.#pipeline.agent.interrupt(opaqueId)) {
        this.#preempting.delete(primary);
      }
    } catch (error: unknown) {
      this.#preempting.delete(primary);
      this.#logger.error?.(
        `[processor] backlog interrupt failed message_key=${primary}: ${errorMessage(error)}`,
      );
    }
  }

  #acquire(record: InboundRecord, priority: WorkPriority): Promise<void> {
    const key = this.#conversationKey(record);
    if (this.#activeConversations.has(key)) return Promise.resolve();
    const lowActive = [...this.#activeConversations.values()]
      .some((active) => active.priority === 'low');
    if (
      priority === 'high' &&
      !lowActive &&
      this.#activeConversations.size < this.#maxConcurrentConversations
    ) {
      this.#activeConversations.set(key, { record, priority });
      return Promise.resolve();
    }
    if (
      priority === 'low' &&
      this.#activeConversations.size === 0 &&
      this.#highWaiters.length === 0
    ) {
      this.#activeConversations.set(key, { record, priority });
      return Promise.resolve();
    }
    const waiting = new Promise<void>((resolve) => {
      const waiter = { key, record, priority, resolve };
      (priority === 'high' ? this.#highWaiters : this.#lowWaiters).push(waiter);
    });
    if (priority === 'high') {
      this.#notifyQueued(record);
      if (lowActive) void this.#preemptLow(key);
    }
    return waiting;
  }

  #release(record: ChannelIdentity): void {
    const key = this.#conversationKey(record);
    this.#activeConversations.delete(key);
    this.#queueNotified.delete(key);
    this.#wakeWaiters();
  }

  #releaseIfInactive(record: InboundRecord): void {
    if (!this.#pipeline.agent.activePrimary(conversationId(record))) {
      this.#release(record);
    }
  }

  enqueue(messageKey: string): Promise<void> {
    if (!this.#accepting) return Promise.resolve();
    const record = this.#store.getInbound(messageKey) as InboundRecord | undefined;
    if (!record) return Promise.resolve();
    const key = this.#conversationKey(record);
    const task = (this.#queues.get(key) || this.#recoveries.get(key) || Promise.resolve())
      .catch(() => undefined)
      .then(() => this.#processRecoverably(record.messageKey))
      .catch((error: unknown) => {
        this.#releaseIfInactive(record);
        this.#logger.error?.(
          `[processor] inbound processing failed message_key=${messageKey}: ${errorMessage(error)}`,
        );
      });
    this.#queues.set(key, task);
    void task.finally(() => {
      if (this.#queues.get(key) === task) this.#queues.delete(key);
    });
    return task;
  }

  async #processRecoverably(messageKey: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        let record = this.#store.getInbound(messageKey);
        if (!record) return;
        if (record.status === 'received') {
          await this.#process(messageKey);
          return;
        }
        if (record.status === 'failed') {
          record = this.#store.claimInbound({
            messageKey,
            clientInputId: record.clientInputId || messageKey,
          });
        }
        if (!['processing', 'preparing'].includes(record.status)) return;
        const group = this.#store.listPendingInbound({
          statuses: ['received', 'processing', 'preparing', 'steering', 'steered'],
          channel: record.channel,
          accountKey: record.accountKey,
          peerId: record.peerId,
          limit: 1000,
        }).filter((candidate) =>
          candidate.messageKey === messageKey ||
          candidate.primaryMessageKey === messageKey ||
          (candidate.status === 'received' && candidate.inboxSeq > record.inboxSeq),
        );
        await this.#recoverConversation(group, 'high');
        return;
      } catch (error: unknown) {
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  #track(task: Promise<void>, record: InboundRecord): Promise<void> {
    const messageKey = record.messageKey;
    const guarded = task.catch((error: unknown) => {
      if (this.#preempting.delete(messageKey)) {
        this.#store.closeAgentSessions(messageKey);
        if (!this.#store.deferActiveInbound(messageKey)) {
          this.#store.failInbound(messageKey, error);
        }
        this.#logger.info?.(
          `[processor] deferred backlog preempted message_key=${messageKey}`,
        );
        return;
      }
      const inbound = this.#store.getInbound(messageKey);
      const superseded = inbound && this.#store.listPendingInbound({
        statuses: ['received'],
        channel: inbound.channel,
        accountKey: inbound.accountKey,
        peerId: inbound.peerId,
        limit: 1000,
      }).some((candidate) =>
        candidate.inboxSeq > inbound.inboxSeq && candidate.origin === 'customer',
      );
      this.#store.closeAgentSessions(messageKey);
      if (superseded) {
        this.#store.suppressInbound(messageKey, 'superseded_by_arrived_followup');
      } else {
        this.#store.failInbound(messageKey, error);
        const retries = this.#onlineRetries.get(messageKey) || 0;
        if (retries < 2) {
          this.#onlineRetries.set(messageKey, retries + 1);
          void this.enqueue(messageKey);
        }
      }
      this.#logger.error?.(
        `[processor] Codex completion failed message_key=${messageKey}: ${errorMessage(error)}`,
      );
    }).finally(() => this.#release(record));
    this.#background.add(guarded);
    void guarded.finally(() => this.#background.delete(guarded));
    return guarded;
  }

  async #submit(
    record: InboundRecord,
    input: UnboundAgentInput,
    options: {
      readonly wait?: boolean;
      readonly boundaryMessageKey?: string;
      readonly recoveredArtifacts?: readonly AgentImageArtifact[];
      readonly started?: (submission: Extract<AgentSubmission, { kind: 'started' }>) => void;
      readonly priority?: WorkPriority;
    } = {},
  ): Promise<AgentSubmission> {
    const opaqueConversationId = conversationId(record);
    const agentAccess = this.#agentAccess(record);
    const activePrimary = options.wait
      ? undefined
      : this.#pipeline.agent.activePrimary(opaqueConversationId);
    if (activePrimary) {
      this.#store.beginInboundSteering({
        messageKey: record.messageKey,
        primaryMessageKey: activePrimary,
        clientInputId: record.messageKey,
      });
      const primary = this.#store.getInbound(activePrimary);
      if (!primary) throw new Error(`Missing active primary ${activePrimary}`);
      const session = this.#store.createAgentSession({
        messageKey: activePrimary,
        boundaryMessageKey: record.messageKey,
      });
      const memoryThreadId = this.#store.getConversation(
        record.channel,
        record.accountKey,
        record.peerId,
      )?.memoryThreadId || '';
      try {
        const submission = await this.#pipeline.agent.submit({
          ...input,
          agentAccess,
          channel: record.channel,
          mode: 'steer',
          conversationId: opaqueConversationId,
          threadId: this.#store.getConversation(
            record.channel,
            record.accountKey,
            record.peerId,
          )?.threadId || '',
          ...(memoryThreadId ? { archivedThreadId: memoryThreadId } : {}),
          toolSessionToken: session.token,
          publishArtifact: async (artifact) => this.#store.registerAgentArtifact({
            sessionToken: session.token,
            bytes: artifact.bytes,
            filename: artifact.filename,
            contentType: artifact.contentType,
            ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
          }),
        });
        if (submission.kind !== 'steered') {
          throw new Error('Active Agent turn did not accept steering');
        }
        this.#store.confirmInboundSteered(record.messageKey, {
          codexTurnId: submission.turnId,
        });
        return submission;
      } catch (error) {
        this.#store.closeAgentSession(session.token);
        this.#store.requeueInboundSteering(record.messageKey, activePrimary);
        throw error;
      }
    }
    await this.#acquire(record, options.priority || 'high');
    this.#store.claimInbound({
      messageKey: record.messageKey,
      clientInputId: input.clientInputId || record.messageKey,
    });
    const boundaryMessageKey = options.boundaryMessageKey || record.messageKey;
    const conversationBefore = this.#store.getConversation(
      record.channel,
      record.accountKey,
      record.peerId,
    );
    const ensuredThreadId = await this.#pipeline.agent.ensureThread(
      opaqueConversationId,
      conversationBefore?.threadId || '',
      agentAccess,
    );
    const pendingMemoryThreadId =
      this.#pipeline.agent.takePendingMemoryThread?.(opaqueConversationId) || '';
    if (!conversationBefore || ensuredThreadId !== conversationBefore.threadId) {
      this.#store.setConversationThread({
        channel: record.channel,
        accountKey: record.accountKey,
        peerId: record.peerId,
        threadId: ensuredThreadId,
        memoryThreadId: pendingMemoryThreadId,
      });
    }
    const memoryThreadId = this.#store.getConversation(
      record.channel,
      record.accountKey,
      record.peerId,
    )?.memoryThreadId || '';
    const session = this.#store.createAgentSession({
      messageKey: record.messageKey,
      boundaryMessageKey,
    });
    const artifactCatalog = (options.recoveredArtifacts || []).map((artifact) => ({
      ref: this.#store.registerAgentArtifact({
        sessionToken: session.token,
        bytes: artifact.bytes,
        filename: artifact.filename,
        contentType: artifact.contentType,
        ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
      }),
      kind: 'image' as const,
    }));
    let submission: AgentSubmission;
    try {
      submission = await this.#pipeline.agent.submit({
        ...input,
        agentAccess,
        channel: record.channel,
        ...(artifactCatalog.length ? { artifactCatalog } : {}),
        mode: 'start',
        conversationId: opaqueConversationId,
        threadId: ensuredThreadId,
        ...(memoryThreadId ? { archivedThreadId: memoryThreadId } : {}),
        toolSessionToken: session.token,
        publishArtifact: async (artifact) => this.#store.registerAgentArtifact({
          sessionToken: session.token,
          bytes: artifact.bytes,
          filename: artifact.filename,
          contentType: artifact.contentType,
          ...(artifact.metadata ? { metadata: artifact.metadata } : {}),
        }),
      });
    } catch (error) {
      this.#store.closeAgentSession(session.token);
      throw error;
    }
    if (submission.kind !== 'started') {
      this.#store.closeAgentSession(session.token);
      throw new Error('Agent start unexpectedly returned steering');
    }
    void submission.completion.catch(() => undefined);
    this.#store.markInboundPreparing(record.messageKey, submission.turnId);
    options.started?.(submission);
    const completion = this.#track(
      submission.completion.then((result) => this.#complete(record, result)),
      record,
    );
    if (options.wait) await completion;
    return submission;
  }

  async #process(
    messageKey: string,
    priority: WorkPriority = 'high',
    {
      wait = false,
      boundaryMessageKey,
    }: { wait?: boolean; boundaryMessageKey?: string } = {},
  ): Promise<void> {
    const record = this.#store.getInbound(messageKey) as InboundRecord | undefined;
    if (!record || record.status !== 'received') return;
    const message = this.#message(record);
    if (!message) return;
    if (isSystemEvent(message)) {
      this.#systemEvent(record, message);
      return;
    }
    const { channel, accountKey, peerId } = message.conversation;
    if (message.origin !== MESSAGE_ORIGINS.CUSTOMER || !peerId || !accountKey) {
      this.#store.markInboundIgnored(messageKey);
      return;
    }
    if (
      channel === 'wechat_kf' &&
      !this.#allowedUsers.has(peerId) &&
      this.#store.getAuthorization(peerId)?.authorized !== true
    ) {
      const isTrigger = Boolean(this.#authorization.trigger) &&
        message.type === COMMON_MESSAGE_TYPES.TEXT &&
        message.text === this.#authorization.trigger;
      const result = this.#store.evaluateAuthorization({
        messageKey,
        accountKey,
        peerId,
        isTrigger,
        requiredConsecutive: this.#authorization.requiredConsecutive,
        confirmationText: this.#authorization.confirmationText,
      });
      if (result.decision !== 'already_authorized') {
        if (result.decision === 'authorized_now') {
          void this.#pipeline.channel.kick(channel);
        }
        return;
      }
    }
    if (!isProcessableCustomerMessage(message)) {
      this.#store.markInboundIgnored(messageKey);
      return;
    }

    await this.#acquire(record, priority);
    if (message.attachments.length) {
      this.#store.rememberInboundMedia({
        messageKey,
        attachments: message.attachments,
        sentAt: message.sentAt,
      });
    }
    const mediaCatalog = this.#mediaCatalog(record);
    const latestImage = this.#store.listRecentConversationAttempts({
      channel,
      accountKey,
      peerId,
      limit: 5,
    }).find((attempt) =>
      attempt.type === 'image' &&
      attempt.metadata?.tool === 'generated_image' &&
      ['accepted', 'uncertain'].includes(attempt.status),
    );
    await this.#submit(record, {
      message: agentMessage(message),
      resolvedMedia: await this.#pipeline.mediaGateway.resolveForCodex(message),
      mediaCatalog,
      contextText: renderMessageForAgent(message),
      ...(latestImage
        ? {
            channelState: {
              accepted: latestImage.status === 'accepted',
              revisedPrompt: latestImage.metadata?.revisedPrompt,
              customerObserved:
                /(?:(?:上一张|刚才|之前).{0,8}(?:图|图片|照片|结果)|(?:previous|last|earlier|just sent).{0,24}(?:image|photo|picture|result))/iu
                  .test(message.text),
            },
          }
        : {}),
    }, { priority, wait, ...(boundaryMessageKey ? { boundaryMessageKey } : {}) });
  }

  async #complete(
    record: InboundRecord,
    result: AgentCompletion,
  ): Promise<void> {
    const later = this.#store.listPendingInbound({
      statuses: ['received'],
      channel: record.channel,
      accountKey: record.accountKey,
      peerId: record.peerId,
      limit: 1000,
    }).filter((candidate) => candidate.inboxSeq > record.inboxSeq);
    let customerFollowupArrived = false;
    for (const candidate of later) {
      const message = this.#message(candidate);
      if (!message) continue;
      if (isSystemEvent(message)) {
        this.#systemEvent(candidate, message);
      } else if (isProcessableCustomerMessage(message)) {
        customerFollowupArrived = true;
      } else {
        this.#store.markInboundIgnored(candidate.messageKey);
      }
    }
    if (customerFollowupArrived) {
      if (result.executedAttemptIds?.length) {
        this.#finalizeAttempts(record, result.executedAttemptIds);
        this.#onlineRetries.delete(record.messageKey);
        return;
      }
      this.#store.suppressInbound(
        record.messageKey,
        'superseded_by_arrived_followup',
      );
      this.#onlineRetries.delete(record.messageKey);
      return;
    }
    if (result.executedAttemptIds?.length) {
      this.#finalizeAttempts(record, result.executedAttemptIds);
      this.#onlineRetries.delete(record.messageKey);
      return;
    }
    if (result.decision === 'no_action') {
      this.#finalizeAttempts(record, []);
      this.#onlineRetries.delete(record.messageKey);
      return;
    }
    throw new Error('Agent completed without an MCP execution');
  }

  #finalizeAttempts(record: InboundRecord, attemptIds: readonly string[]): void {
    const group = this.#store.listPendingInbound({
      statuses: ['steering', 'steered'],
      channel: record.channel,
      accountKey: record.accountKey,
      peerId: record.peerId,
      limit: 100,
    }).filter((item) => item.primaryMessageKey === record.messageKey);
    if (group.some((item) => item.status === 'steering')) {
      throw new Error('Cannot finalize while a steering RPC is unconfirmed');
    }
    const direction = Math.max(
      record.inboxSeq,
      ...group.map((item) => item.inboxSeq),
    );
    const durable = this.#store.listMessageAttempts(record.messageKey)
      .filter((attempt) => attempt.source === 'mcp_tool');
    const latest = attemptIds.length
      ? attemptIds.map((attemptId) => this.#store.getAttempt(attemptId))
      : durable.filter((attempt) =>
          Number(attempt.metadata?.direction || 0) === direction &&
          ['accepted', 'failed', 'uncertain'].includes(attempt.status),
        );
    if (!latest.length || latest.some((attempt) =>
      !attempt || Number(attempt.metadata?.direction || 0) !== direction)) {
      throw new Error('Agent completion has no MCP execution for the latest direction');
    }
    this.#store.finalizeAgentExecution({
      messageKey: record.messageKey,
      steeringMessageKeys: group.map((item) => item.messageKey),
      attemptIds: durable.map((attempt) => attempt.attemptId),
    });
  }

  #systemEvent(record: InboundRecord, message: ChannelMessage): void {
    if (message.conversation.channel !== 'wechat_kf') {
      this.#store.markInboundIgnored(record.messageKey);
      return;
    }
    const event = message.attributes;
    if (event.event_type === 'msg_send_fail') {
      this.#store.markSendMsgFailed({
        providerMessageId: String(event.fail_msgid || ''),
        failType: Number(event.fail_type || 0),
      });
      this.#store.markInboundCompleted(record.messageKey);
      return;
    }
    this.#store.markInboundIgnored(record.messageKey);
  }

  recover(
    records: readonly InboundRecord[],
    { priority = 'high' }: { priority?: WorkPriority } = {},
  ): Promise<void> {
    const conversations = new Map<string, InboundRecord[]>();
    for (const record of [...records].sort(
      (left, right) => left.inboxSeq - right.inboxSeq,
    )) {
      const key = this.#conversationKey(record);
      const group = conversations.get(key) || [];
      group.push(record);
      conversations.set(key, group);
    }
    const tasks = [...conversations.entries()].map(([key, group]) => {
      const task = this.#recoverConversation(group, priority).catch((error: unknown) => {
        const first = group[0];
        if (first) this.#releaseIfInactive(first);
        this.#logger.error?.(
          `[recovery] conversation recovery failed: ${errorMessage(error)}`,
        );
      });
      this.#recoveries.set(key, task);
      void task.finally(() => {
        if (this.#recoveries.get(key) === task) this.#recoveries.delete(key);
      });
      return task;
    });
    return Promise.all(tasks).then(() => {
      void this.#pipeline.channel.kick();
    });
  }

  async #recoverConversation(
    ordered: InboundRecord[],
    priority: WorkPriority,
  ): Promise<void> {
    for (const record of ordered.filter((item) => item.status === 'received')) {
      const message = this.#message(record);
      if (!message) {
        record.status = this.#store.getInbound(record.messageKey)?.status || record.status;
        continue;
      }
      if (isSystemEvent(message)) {
        await this.#process(record.messageKey, priority);
        record.status = this.#store.getInbound(record.messageKey)?.status || record.status;
      }
    }
    const primaries = ordered.filter((record) =>
      ['failed', 'processing', 'preparing'].includes(record.status) &&
      !record.primaryMessageKey,
    );
    const recoveryBoundary = [...ordered].reverse().find((record) => {
      if (['completed', 'ignored', 'absorbed', 'suppressed'].includes(record.status)) {
        return false;
      }
      if (this.#message(record)) return true;
      record.status = this.#store.getInbound(record.messageKey)?.status || record.status;
      return false;
    })?.messageKey;
    for (const primary of primaries) {
      const group = ordered.filter((record) =>
        record.messageKey === primary.messageKey ||
        record.primaryMessageKey === primary.messageKey,
      );
      await this.#recoverPrimary(primary, group, priority, recoveryBoundary);
    }
    for (const record of ordered) {
      if (record.status === 'received') {
        await this.#process(record.messageKey, priority, {
          wait: true,
          ...(recoveryBoundary ? { boundaryMessageKey: recoveryBoundary } : {}),
        });
      }
    }
  }

  async #recoverPrimary(
    primary: InboundRecord,
    group: InboundRecord[],
    priority: WorkPriority,
    recoveryBoundary?: string,
  ): Promise<void> {
    if (primary.status === 'failed') {
      primary = this.#store.claimInbound({
        messageKey: primary.messageKey,
        clientInputId: primary.clientInputId || primary.messageKey,
      });
    }
    const decoded = group.flatMap((record) => {
      const message = this.#message(record);
      return message ? [{ record, message }] : [];
    });
    const primaryMessage = decoded.find(
      ({ record }) => record.messageKey === primary.messageKey,
    )?.message;
    if (!primaryMessage) return;
    const validGroup = decoded.map(({ record }) => record);
    const conversation = this.#store.getConversation(
      primary.channel,
      primary.accountKey,
      primary.peerId,
    );
    const mediaCatalog = this.#mediaCatalog(primary);
    const ids = validGroup.map((record) => record.clientInputId || record.messageKey);
    const latestId = ids.at(-1) || primary.clientInputId;
    const steering = validGroup.filter((item) => item.status === 'steering');
    const inspection = conversation?.threadId && this.#pipeline.agent.inspectHistory
      ? await this.#pipeline.agent.inspectHistory(
          conversation.threadId,
          ids,
          latestId,
          this.#agentAccess(primary),
        )
      : undefined;
    const missingInput = steering.some((record) => {
      const clientId = record.clientInputId || record.messageKey;
      if (!inspection?.foundClientInputIds.has(clientId)) return true;
      this.#store.confirmInboundSteered(record.messageKey, {
        codexTurnId: inspection.turnId || record.codexTurnId,
      });
      record.status = 'steered';
      return false;
    });

    if (inspection?.state === 'completed' && !missingInput) {
      const artifactAttempted = (inspection.executedAttemptIds || []).some(
        (attemptId) =>
          this.#store.getAttempt(attemptId)?.metadata?.tool === 'generated_image',
      );
      if (
        inspection.executedAttemptIds?.length &&
        (!inspection.artifacts.length || artifactAttempted)
      ) {
        await this.#complete(primary, {
          ...(inspection.executedAttemptIds
            ? { executedAttemptIds: inspection.executedAttemptIds }
            : {}),
        });
        return;
      }
    }

    const latestDirection = Math.max(
      primary.inboxSeq,
      ...validGroup.map((record) => record.inboxSeq),
    );
    const attempts = this.#store.listMessageAttempts(primary.messageKey);
    const artifactAlreadyHandled = attempts
      .some((attempt) =>
        attempt.metadata?.tool === 'generated_image' &&
        Number(attempt.metadata.direction || 0) === latestDirection &&
        ['accepted', 'uncertain'].includes(attempt.status),
      );
    const allowNoAction = attempts.some((attempt) =>
      attempt.source === 'mcp_tool' &&
      Number(attempt.metadata?.direction || 0) === latestDirection &&
      ['accepted', 'failed', 'uncertain'].includes(attempt.status),
    );
    const recoveredArtifacts = inspection && !missingInput && !artifactAlreadyHandled
      ? inspection.artifacts.filter(
          (artifact): artifact is AgentImageArtifact =>
            artifact.type === 'generated_image' && Buffer.isBuffer(artifact.bytes),
        )
      : [];

    const resolvedMedia = (await Promise.all(
      decoded.map(({ message }) => this.#pipeline.mediaGateway.resolveForCodex(message)),
    )).flat() as ResolvedImage[];
    const boundaryMessageKey =
      recoveryBoundary || validGroup.at(-1)?.messageKey || primary.messageKey;
    await this.#submit(primary, {
      message: agentMessage(primaryMessage),
      resolvedMedia,
      mediaCatalog,
      contextText: [
        'The previous turn exited before delivery. Use the current thread and the persisted participant messages below to produce one current response:',
        ...(recoveredArtifacts.length
          ? ['The previous turn generated an image that is now available as a deliverable artifact. Do not generate it again.']
          : []),
        ...decoded.sort((left, right) => left.record.inboxSeq - right.record.inboxSeq)
          .map(({ message }) => renderMessageForAgent(message)),
      ].join('\n'),
      allowNoAction,
      clientInputId: `${primary.messageKey}-recovery`,
    }, {
      wait: true,
      boundaryMessageKey,
      ...(recoveredArtifacts.length
        ? { recoveredArtifacts }
        : {}),
      started: (submission) => {
        for (const record of steering) {
          this.#store.confirmInboundSteered(record.messageKey, {
            codexTurnId: submission.turnId,
          });
        }
      },
      priority,
    });
  }

  async waitForIdle(): Promise<void> {
    while (
      this.#recoveries.size || this.#queues.size || this.#background.size ||
      this.#activeConversations.size || this.#highWaiters.length ||
      this.#lowWaiters.length
    ) {
      await Promise.allSettled([
        ...this.#recoveries.values(),
        ...this.#queues.values(),
        ...this.#background,
      ]);
    }
  }

  stopAccepting(): void {
    this.#accepting = false;
  }

  async close(): Promise<void> {
    this.stopAccepting();
    await this.waitForIdle();
    await this.#pipeline.agent.close();
  }

  async abort(): Promise<void> {
    this.stopAccepting();
    await this.#pipeline.agent.abort();
  }
}
