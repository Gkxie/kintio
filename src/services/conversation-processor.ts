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
type PendingTurn = {
  readonly completion: Promise<void>;
  boundaryMessageKey: string;
};
type AdmissionQueue = { tail: Promise<void>; live: number };
type ActiveConversation = {
  readonly record: InboundRecord;
  priority: WorkPriority;
  turn?: PendingTurn;
};
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
  readonly approvals?: {
    readonly binding: (record: ChannelIdentity) => string | undefined;
    readonly notify: (record: InboundRecord, content: string, signal: AbortSignal) => Promise<void>;
  };
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
  | 'approvals'
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
    'agent' | 'mediaGateway' | 'channel' | 'agentAccess' | 'approvals'
  >;
  #allowedUsers: ReadonlySet<string>;
  #authorization: {
    readonly trigger: string;
    readonly requiredConsecutive: number;
    readonly confirmationText: string;
  };
  readonly #logger: Logger;
  readonly #queues = new Map<string, AdmissionQueue>();
  readonly #recoveries = new Map<string, Promise<void>>();
  readonly #background = new Set<Promise<void>>();
  readonly #onlineRetries = new Map<string, number>();
  readonly #activeConversations = new Map<string, ActiveConversation>();
  readonly #highWaiters: SlotWaiter[] = [];
  readonly #lowWaiters: SlotWaiter[] = [];
  readonly #queueNotified = new Set<string>();
  readonly #preempting = new Set<string>();
  readonly #maxConcurrentConversations: number;
  #accepting = true;
  readonly #pausedChannels = new Set<ChatChannel>();

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

  #approvalBinding(record: ChannelIdentity): string | undefined {
    return record.channel === 'weixin_ilink' && this.#agentAccess(record) === 'host'
      ? this.#pipeline.approvals?.binding(record) : undefined;
  }

  #approvals(record: InboundRecord, boundaryMessageKey: string): AgentInput['approvals'] {
    const binding = this.#approvalBinding(record);
    const boundary = this.#store.getInbound(boundaryMessageKey);
    if (!binding || !boundary || !this.#pipeline.approvals) return undefined;
    const isAllowed = () => {
      try {
        return this.#accepting && !this.#pausedChannels.has(record.channel) &&
          this.#approvalBinding(record) === binding &&
          ['processing', 'preparing'].includes(this.#store.getInbound(record.messageKey)?.status || '');
      } catch { return false; }
    };
    return {
      isAllowed,
      notify: async (content, signal) => {
        if (signal.aborted || !isAllowed()) throw new Error('Approval conversation is no longer active');
        await this.#pipeline.approvals!.notify(boundary, content, signal);
      },
    };
  }

  #authorized(record: ChannelIdentity): boolean {
    return record.channel !== 'wechat_kf' || this.#allowedUsers.has(record.peerId) ||
      this.#store.getAuthorization(record.peerId)?.authorized === true;
  }

  #admit(record: InboundRecord, boundaryMessageKey = record.messageKey): boolean {
    if (this.#pausedChannels.has(record.channel)) {
      this.#releaseIfInactive(record);
      return false;
    }
    const reason = !this.#authorized(record)
      ? 'authorization_revoked'
      : !this.#store.getAgentSessionBoundary(record.messageKey, boundaryMessageKey)
        ? 'reply_boundary_unavailable'
        : '';
    if (!reason) return true;
    this.#store.closeAgentSessions(record.messageKey);
    this.#store.suppressInbound(record.messageKey, reason);
    this.#releaseIfInactive(record);
    return false;
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
    if (!primary || this.#preempting.has(primary) || this.#store.listMessageAttempts(primary)
      .some((attempt) => attempt.source !== 'agent_approval')) return;
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
    if (this.#pausedChannels.has(record.channel)) return Promise.reject(new Error('Channel is stopped'));
    const key = this.#conversationKey(record);
    if (this.#queues.get(key)?.live) priority = 'high';
    const active = this.#activeConversations.get(key);
    if (active?.turn && !this.#pipeline.agent.activePrimary(conversationId(record))) {
      return active.turn.completion.then(() => this.#acquire(record, priority));
    }
    if (active) return Promise.resolve();
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

  #yieldToLiveInput(record: InboundRecord): boolean {
    if (
      this.#activeConversations.get(this.#conversationKey(record))?.priority !== 'low' ||
      !this.#highWaiters.length || !this.#store.deferActiveInbound(record.messageKey)
    ) return false;
    this.#release(record);
    return true;
  }

  #promote(record: InboundRecord): void {
    const key = this.#conversationKey(record);
    const active = this.#activeConversations.get(key);
    if (active) active.priority = 'high';
    const index = this.#lowWaiters.findIndex((waiter) => waiter.key === key);
    if (index !== -1) {
      const waiter = this.#lowWaiters.splice(index, 1)[0]!;
      this.#highWaiters.push({ ...waiter, priority: 'high' });
      this.#wakeWaiters();
      if (!this.#activeConversations.has(key)) {
        this.#notifyQueued(record);
        void this.#preemptLow(key);
      }
    } else if (active) {
      this.#wakeWaiters();
    }
  }

  #schedule(
    record: InboundRecord,
    prepare: () => Promise<PendingTurn | undefined>,
    live = false,
  ): Promise<PendingTurn | undefined> {
    const key = this.#conversationKey(record);
    const queue = this.#queues.get(key) || { tail: Promise.resolve(), live: 0 };
    if (live) queue.live += 1;
    const task = queue.tail.then(prepare);
    const settled = task.then(() => undefined, () => undefined).finally(() => {
      if (live) queue.live -= 1;
    });
    queue.tail = settled;
    this.#queues.set(key, queue);
    void settled.finally(() => {
      if (queue.tail === settled) this.#queues.delete(key);
    });
    return task;
  }

  enqueue(messageKey: string): Promise<void> {
    if (!this.#accepting) return Promise.resolve();
    const record = this.#store.getInbound(messageKey) as InboundRecord | undefined;
    if (!record) return Promise.resolve();
    const message = this.#message(record);
    const live = Boolean(record.status === 'received' && message &&
      isProcessableCustomerMessage(message) && this.#authorized(record));
    if (live) this.#promote(record);
    return this.#schedule(record, () => this.#processRecoverably(record.messageKey), live)
      .then(() => undefined)
      .catch((error: unknown) => {
        this.#releaseIfInactive(record);
        this.#logger.error?.(
          `[processor] inbound processing failed message_key=${messageKey}: ${errorMessage(error)}`,
        );
      });
  }

  async #processRecoverably(messageKey: string): Promise<PendingTurn | undefined> {
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        let record = this.#store.getInbound(messageKey);
        if (!record || this.#pausedChannels.has(record.channel)) return;
        const active = this.#activeConversations.get(this.#conversationKey(record));
        if (active && this.#preempting.has(active.record.messageKey)) {
          await active.turn?.completion;
          record = this.#store.getInbound(messageKey);
          if (!record || this.#pausedChannels.has(record.channel)) return;
        }
        if (this.#pipeline.agent.activePrimary(conversationId(record)) === messageKey) return;
        if (record.status === 'received') {
          return await this.#process(messageKey);
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
        return await this.#recoverPrimary(record, group.filter((candidate) =>
          candidate.messageKey === messageKey || candidate.primaryMessageKey === messageKey,
        ), 'high', group.at(-1)?.messageKey);
      } catch (error: unknown) {
        const record = this.#store.getInbound(messageKey);
        if (record && this.#pausedChannels.has(record.channel)) {
          this.#releaseIfInactive(record);
          return;
        }
        lastError = error;
        if (attempt < 2) {
          await new Promise((resolve) => setTimeout(resolve, 50 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  #track(task: Promise<void>, record: InboundRecord, boundaryMessageKey: string): PendingTurn {
    const messageKey = record.messageKey;
    const key = this.#conversationKey(record);
    const active = this.#activeConversations.get(key);
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
    }).finally(() => {
      if (this.#activeConversations.get(key) === active) this.#release(record);
    });
    const turn = { completion: guarded, boundaryMessageKey };
    if (active) active.turn = turn;
    this.#background.add(guarded);
    void guarded.finally(() => this.#background.delete(guarded));
    return turn;
  }

  async #submit(
    record: InboundRecord,
    input: UnboundAgentInput,
    options: {
      readonly boundaryMessageKey?: string;
      readonly recoveredArtifacts?: readonly AgentImageArtifact[];
      readonly started?: (submission: Extract<AgentSubmission, { kind: 'started' }>) => void;
      readonly priority?: WorkPriority;
      readonly approvalReply?: { readonly code: string; readonly option: number };
    } = {},
  ): Promise<PendingTurn | undefined> {
    const boundaryMessageKey = options.boundaryMessageKey || record.messageKey;
    if (!this.#admit(record, boundaryMessageKey)) return;
    const opaqueConversationId = conversationId(record);
    const agentAccess = this.#agentAccess(record);
    const activePrimary = this.#pipeline.agent.activePrimary(opaqueConversationId);
    if (options.approvalReply && !activePrimary) {
      this.#store.markInboundIgnored(record.messageKey);
      return;
    }
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
          approvals: this.#approvals(primary, record.messageKey),
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
        const turn = this.#activeConversations.get(this.#conversationKey(record))?.turn;
        if (turn) turn.boundaryMessageKey = record.messageKey;
        if (options.approvalReply) {
          try {
            this.#store.getAgentSession(session.token);
            if (!this.#pipeline.agent.respondApproval?.(opaqueConversationId, options.approvalReply.code, options.approvalReply.option, () => {
              try { this.#store.getAgentSession(session.token); return true; }
              catch { return false; }
            })) {
              this.#pipeline.agent.cancelApprovals?.(opaqueConversationId);
            }
          } catch {
            this.#pipeline.agent.cancelApprovals?.(opaqueConversationId);
          }
        }
        return;
      } catch (error) {
        if (options.approvalReply) this.#pipeline.agent.cancelApprovals?.(opaqueConversationId);
        this.#store.closeAgentSession(session.token);
        this.#store.requeueInboundSteering(record.messageKey, activePrimary);
        throw error;
      }
    }
    await this.#acquire(record, options.priority || 'high');
    if (this.#pausedChannels.has(record.channel)) {
      this.#release(record);
      throw new Error('Channel is stopped');
    }
    if (!this.#admit(record, boundaryMessageKey)) return;
    this.#store.claimInbound({
      messageKey: record.messageKey,
      clientInputId: input.clientInputId || record.messageKey,
    });
    if (this.#yieldToLiveInput(record)) return;
    const conversationBefore = this.#store.getConversation(
      record.channel,
      record.accountKey,
      record.peerId,
    );
    const ensuredThreadId = await this.#pipeline.agent.ensureThread(
      opaqueConversationId,
      conversationBefore?.threadId || '',
      agentAccess,
      record.channel,
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
    if (!this.#admit(record, boundaryMessageKey) || this.#yieldToLiveInput(record)) return;
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
        approvals: this.#approvals(record, boundaryMessageKey),
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
    const turn = this.#track(
      submission.completion.then((result) => this.#complete(record, result)),
      record,
      boundaryMessageKey,
    );
    const liveWaiter = this.#highWaiters[0];
    if (liveWaiter) void this.#preemptLow(liveWaiter.key);
    return turn;
  }

  async #process(
    messageKey: string,
    priority: WorkPriority = 'high',
    {
      boundaryMessageKey,
    }: { boundaryMessageKey?: string } = {},
  ): Promise<PendingTurn | undefined> {
    const record = this.#store.getInbound(messageKey) as InboundRecord | undefined;
    if (!record || record.status !== 'received' || this.#pausedChannels.has(record.channel)) return;
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
    if (!this.#authorized(record)) {
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
    if (!this.#admit(record, boundaryMessageKey)) return;

    if (message.type === COMMON_MESSAGE_TYPES.TEXT && /^\/kintio approval(?:\s|$)/u.test(message.text)) {
      const reply = /^\/kintio approval ([A-F0-9]{12}) ([1-3])$/u.exec(message.text.trim());
      const key = conversationId(record);
      if (!reply || !this.#approvalBinding(record) || !this.#pipeline.agent.hasApproval?.(key, reply[1]!, Number(reply[2]))) {
        this.#store.markInboundIgnored(record.messageKey);
        if (this.#approvalBinding(record)) {
          await this.#pipeline.approvals?.notify(record, 'This approval code or option is invalid, expired, or already used. No action was approved.', new AbortController().signal);
        }
        return;
      }
      await this.#submit(record, {
        message: agentMessage(message),
        contextText: 'The participant explicitly answered a pending host approval. Use the refreshed channel session below; the host returns the approval decision separately. This control reply is not a new task.',
      }, { priority, approvalReply: { code: reply[1]!, option: Number(reply[2]) } });
      return;
    }
    this.#pipeline.agent.cancelApprovals?.(conversationId(record));

    await this.#acquire(record, priority);
    if (!this.#admit(record, boundaryMessageKey)) return;
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
    return this.#submit(record, {
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
    }, { priority, ...(boundaryMessageKey ? { boundaryMessageKey } : {}) });
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
      const previous = this.#recoveries.get(key);
      const task = (previous
        ? previous.then(() => this.#recoverConversation(group, priority))
        : this.#recoverConversation(group, priority)).catch((error: unknown) => {
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
        await this.#schedule(record, () => this.#process(record.messageKey, priority));
        record.status = this.#store.getInbound(record.messageKey)?.status || record.status;
      }
    }
    const primaries = ordered.filter((record) =>
      ['failed', 'processing', 'preparing'].includes(record.status) &&
      !record.primaryMessageKey,
    );
    let recoveryBoundary = [...ordered].reverse().find((record) => {
      if (['completed', 'ignored', 'absorbed', 'suppressed'].includes(record.status)) {
        return false;
      }
      if (this.#message(record)) return true;
      record.status = this.#store.getInbound(record.messageKey)?.status || record.status;
      return false;
    })?.messageKey;
    const units = [...primaries, ...ordered.filter((record) => record.status === 'received')];
    for (const unit of units) {
      let retry: boolean;
      do {
        retry = false;
        const pending = await this.#schedule(unit, async () => {
          const active = this.#activeConversations.get(this.#conversationKey(unit));
          if (active?.turn) {
            retry = true;
            return active.turn;
          }
          const current = this.#store.getInbound(unit.messageKey);
          if (!current) return;
          if (current.status === 'received') {
            return this.#process(current.messageKey, priority, {
              ...(recoveryBoundary ? { boundaryMessageKey: recoveryBoundary } : {}),
            });
          }
          if (!['failed', 'processing', 'preparing'].includes(current.status) || current.primaryMessageKey) return;
          const group = this.#store.listPendingInbound({
            channel: current.channel, accountKey: current.accountKey, peerId: current.peerId,
            statuses: ['failed', 'processing', 'preparing', 'steering', 'steered'], limit: 1000,
          }).filter((record) => record.messageKey === current.messageKey || record.primaryMessageKey === current.messageKey);
          return this.#recoverPrimary(current, group, priority, recoveryBoundary);
        });
        // Historical units remain separate, but completion never owns the live-input queue.
        await pending?.completion;
        if (
          pending && (this.#store.getInbound(pending.boundaryMessageKey)?.inboxSeq || 0) >
            (this.#store.getInbound(recoveryBoundary || unit.messageKey)?.inboxSeq || 0)
        ) recoveryBoundary = pending.boundaryMessageKey;
      } while (retry);
    }
  }

  async #recoverPrimary(
    primary: InboundRecord,
    group: InboundRecord[],
    priority: WorkPriority,
    recoveryBoundary?: string,
  ): Promise<PendingTurn | undefined> {
    const decoded = group.flatMap((record) => {
      const message = this.#message(record);
      return message ? [{ record, message }] : [];
    });
    const primaryMessage = decoded.find(
      ({ record }) => record.messageKey === primary.messageKey,
    )?.message;
    if (!primaryMessage) return;
    const validGroup = decoded.map(({ record }) => record);
    const boundaryMessageKey =
      recoveryBoundary || validGroup.at(-1)?.messageKey || primary.messageKey;
    if (!this.#admit(primary, boundaryMessageKey)) return;
    await this.#acquire(primary, priority);
    if (!this.#admit(primary, boundaryMessageKey) || this.#yieldToLiveInput(primary)) return;
    if (primary.status === 'failed') {
      primary = this.#store.claimInbound({
        messageKey: primary.messageKey,
        clientInputId: primary.clientInputId || primary.messageKey,
      });
    }
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
          primary.channel,
        )
      : undefined;
    if (!this.#admit(primary, boundaryMessageKey) || this.#yieldToLiveInput(primary)) return;
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
        this.#releaseIfInactive(primary);
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
    return this.#submit(primary, {
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
        ...[...this.#queues.values()].map((queue) => queue.tail),
        ...this.#background,
      ]);
    }
  }

  isIdle(): boolean {
    return !(
      this.#recoveries.size || this.#queues.size || this.#background.size ||
      this.#activeConversations.size || this.#highWaiters.length ||
      this.#lowWaiters.length
    );
  }

  configureWecom(allowedUserIds: readonly string[], authorization: Required<NonNullable<ProcessorOptions['authorization']>>): void {
    this.#allowedUsers = new Set(allowedUserIds);
    this.#authorization = { ...authorization };
  }

  setChannelEnabled(channel: ChatChannel, enabled: boolean): void {
    if (enabled) this.#pausedChannels.delete(channel);
    else {
      this.#pausedChannels.add(channel);
      this.#pipeline.agent.invalidateApprovals?.();
      for (const waiters of [this.#highWaiters, this.#lowWaiters]) {
        for (let index = waiters.length - 1; index >= 0; index -= 1) {
          if (waiters[index]?.record.channel === channel) waiters.splice(index, 1)[0]!.resolve();
        }
      }
      this.#wakeWaiters();
    }
  }

  async waitForChannelIdle(channel: ChatChannel): Promise<void> {
    const prefix = `${channel}\0`;
    while (true) {
      const pending = [...this.#queues].map(([key, queue]) => [key, queue.tail] as const)
        .concat([...this.#recoveries])
        .filter(([key]) => key.startsWith(prefix)).map(([, task]) => task);
      if (pending.length) await Promise.allSettled(pending);
      else if ([...this.#activeConversations.values()].some(({ record }) => record.channel === channel)) {
        await Promise.race(this.#background);
      } else return;
    }
  }

  stopAccepting(): void {
    this.#accepting = false;
    this.#pipeline.agent.invalidateApprovals?.();
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
