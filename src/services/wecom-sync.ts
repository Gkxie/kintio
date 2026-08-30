import { normalizeWecomMessage } from '../domain/wecom-message.ts';
import type { Logger } from '../types.ts';
import type { SqliteStore } from '../state/sqlite-store.ts';
import type { ConversationProcessor } from './conversation-processor.ts';
import { WecomApiError, type WecomApiClient } from './wecom-api.ts';

const MAX_SYNC_PAGES = 100;
const CALLBACK_TOKEN_LIFETIME_MS = 9 * 60 * 1_000;
const RETRY_BASE_MS = 250;
const RETRY_MAX_MS = 30_000;
const TOKENLESS_RETRY_MS = 5 * 60_000;
const PROVIDER_ERROR_RETRY_MS = 5 * 60_000;
const MAX_CONCURRENT_SYNC_REQUESTS = 4;

function jitteredRetry(baseMs: number, key: string): number {
  let hash = 0;
  for (const character of key) {
    hash = ((hash * 31) + (character.codePointAt(0) || 0)) >>> 0;
  }
  return baseMs + Math.floor(baseMs * (hash % 21) / 100);
}

export class WecomSync {
  readonly apiClient: Pick<WecomApiClient, 'syncMessages'>;
  readonly store: Pick<
    SqliteStore,
    | 'getCursor'
    | 'listSyncOpenKfIds'
    | 'registerSyncOpenKfId'
    | 'ingestSyncPage'
    | 'promoteDeferredConversation'
  >;
  readonly processor: Pick<ConversationProcessor, 'enqueue'>;
  readonly logger: Logger;
  readonly onDeferredReady: () => void;
  private readonly workers = new Map<string, Promise<void>>();
  private readonly pending = new Map<
    string,
    { readonly live: boolean; readonly deferred: boolean; readonly attempt: number }
  >();
  private readonly liveRequested = new Set<string>();
  private readonly preemptedConversations = new Map<string, Set<string>>();
  private readonly callbackTokens = new Map<
    string,
    { readonly value: string; readonly expiresAt: number }
  >();
  private readonly retries = new Map<
    string,
    { readonly timer: NodeJS.Timeout }
  >();
  private readonly syncWaiters: Array<(acquired: boolean) => void> = [];
  private activeSyncRequests = 0;
  private accepting = true;
  private consuming = false;

  constructor({
    apiClient,
    store,
    processor,
    logger = console,
    startPaused = false,
    onDeferredReady = () => {},
  }: {
    apiClient: Pick<WecomApiClient, 'syncMessages'>;
    store: Pick<
      SqliteStore,
      | 'getCursor'
      | 'listSyncOpenKfIds'
      | 'registerSyncOpenKfId'
      | 'ingestSyncPage'
      | 'promoteDeferredConversation'
    >;
    processor: Pick<ConversationProcessor, 'enqueue'>;
    logger?: Logger;
    startPaused?: boolean;
    onDeferredReady?: () => void;
  }) {
    this.apiClient = apiClient;
    this.store = store;
    this.processor = processor;
    this.logger = logger;
    this.onDeferredReady = onDeferredReady;
    this.consuming = !startPaused;
  }

  enqueue({
    callbackToken,
    openKfId,
  }: {
    callbackToken: string;
    openKfId: string;
  }): boolean {
    if (!this.accepting) return false;
    this.store.registerSyncOpenKfId(openKfId);
    this.callbackTokens.set(openKfId, {
      value: callbackToken,
      expiresAt: Date.now() + CALLBACK_TOKEN_LIFETIME_MS,
    });
    void this.#requestSync(openKfId, false, 0);
    return true;
  }

  catchUp(): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    if (this.consuming) {
      throw new Error('startup catch-up requires paused consumption');
    }
    const openKfIds = this.store.listSyncOpenKfIds();
    if (openKfIds.length) {
      this.logger.info?.(
        `[wecom] startup catch-up accounts=${openKfIds.length}`,
      );
    }
    return Promise.all(
      openKfIds.map((openKfId) => this.#requestSync(openKfId, true, 0)),
    ).then(() => undefined);
  }

  #requestSync(
    openKfId: string,
    deferred: boolean,
    attempt: number,
  ): Promise<void> {
    const current = this.pending.get(openKfId);
    this.pending.set(openKfId, {
      live: Boolean(current?.live || !deferred),
      deferred: Boolean(current?.deferred || deferred),
      attempt: current ? Math.min(current.attempt, attempt) : attempt,
    });
    if (!deferred) this.liveRequested.add(openKfId);
    this.#cancelRetry(openKfId);
    return this.#startWorker(openKfId);
  }

  #startWorker(openKfId: string): Promise<void> {
    const current = this.workers.get(openKfId);
    if (current) return current;
    const worker = this.#runWorker(openKfId).catch((error: unknown) => {
      this.logger.error?.(
        `[wecom] sync worker failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }).finally(() => {
      if (this.workers.get(openKfId) !== worker) return;
      this.workers.delete(openKfId);
      if (
        this.accepting
        && this.pending.has(openKfId)
        && !this.retries.has(openKfId)
      ) void this.#startWorker(openKfId);
    });
    this.workers.set(openKfId, worker);
    return worker;
  }

  async #runWorker(openKfId: string): Promise<void> {
    while (this.accepting) {
      const request = this.pending.get(openKfId);
      if (!request) return;
      this.pending.delete(openKfId);
      if (request.live) this.liveRequested.delete(openKfId);
      const deferred = !request.live && request.deferred;
      try {
        const completed = await this.#drain(
          this.#callbackToken(openKfId),
          openKfId,
          deferred,
        );
        if (deferred && completed) this.onDeferredReady();
      } catch (error: unknown) {
        if (!this.accepting) return;
        const current = this.pending.get(openKfId);
        this.pending.set(openKfId, {
          live: Boolean(current?.live || request.live),
          deferred: Boolean(current?.deferred || request.deferred),
          attempt: current
            ? Math.min(current.attempt, request.attempt + 1)
            : request.attempt + 1,
        });
        this.#scheduleRetry(openKfId, error);
        return;
      }
    }
  }

  #callbackToken(openKfId: string): string {
    const current = this.callbackTokens.get(openKfId);
    if (!current) return '';
    if (current.expiresAt > Date.now()) return current.value;
    this.callbackTokens.delete(openKfId);
    return '';
  }

  #scheduleRetry(
    openKfId: string,
    error: unknown,
  ): void {
    this.#cancelRetry(openKfId);
    const attempt = this.pending.get(openKfId)?.attempt || 1;
    const hasCallbackToken = Boolean(this.#callbackToken(openKfId));
    const providerRejected = error instanceof WecomApiError
      && error.code !== undefined;
    const retryBase = !hasCallbackToken
      ? TOKENLESS_RETRY_MS
      : providerRejected
        ? PROVIDER_ERROR_RETRY_MS
        : Math.min(
          RETRY_BASE_MS * (2 ** Math.min(Math.max(0, attempt - 1), 16)),
          RETRY_MAX_MS,
        );
    const retryMs = retryBase >= PROVIDER_ERROR_RETRY_MS
      ? jitteredRetry(retryBase, `${openKfId}:${attempt}`)
      : retryBase;
    this.logger.error?.(
      `[wecom] sync failed: ${
        error instanceof Error ? error.message : String(error)
      }; retry_ms=${retryMs}`,
    );
    const timer = setTimeout(() => {
      if (this.retries.get(openKfId)?.timer !== timer) return;
      this.retries.delete(openKfId);
      if (this.accepting) void this.#startWorker(openKfId);
    }, retryMs);
    timer.unref?.();
    this.retries.set(openKfId, { timer });
  }

  #cancelRetry(openKfId: string): void {
    const retry = this.retries.get(openKfId);
    if (!retry) return;
    clearTimeout(retry.timer);
    this.retries.delete(openKfId);
  }

  #cancelRetries(): void {
    for (const { timer } of this.retries.values()) {
      clearTimeout(timer);
    }
    this.retries.clear();
  }

  #acquireSyncSlot(): Promise<boolean> {
    if (!this.accepting) return Promise.resolve(false);
    if (this.activeSyncRequests < MAX_CONCURRENT_SYNC_REQUESTS) {
      this.activeSyncRequests += 1;
      return Promise.resolve(true);
    }
    return new Promise((resolve) => this.syncWaiters.push(resolve));
  }

  #releaseSyncSlot(): void {
    this.activeSyncRequests -= 1;
    while (this.syncWaiters.length) {
      const waiter = this.syncWaiters.shift();
      if (!waiter) continue;
      if (!this.accepting) {
        waiter(false);
        continue;
      }
      this.activeSyncRequests += 1;
      waiter(true);
      return;
    }
  }

  #cancelSyncWaiters(): void {
    for (const waiter of this.syncWaiters.splice(0)) waiter(false);
  }

  async #drain(
    callbackToken: string,
    openKfId: string,
    deferred: boolean,
  ): Promise<boolean> {
    let cursor = this.store.getCursor(openKfId);
    const liveConversationPages: string[][] = [];
    let liveDrainCompleted = false;

    try {
      for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
        const acquired = await this.#acquireSyncSlot();
        if (!acquired) return false;
        let result;
        try {
          if (!this.accepting) return false;
          result = await this.apiClient.syncMessages({
            cursor,
            callbackToken,
            openKfId,
          });
        } finally {
          this.#releaseSyncSlot();
        }
        if (!this.accepting) return false;
        const nextCursor = String(result.next_cursor || cursor);
        if (result.has_more === 1 && nextCursor === cursor) {
          throw new Error('sync_msg returned has_more=1 without a new cursor');
        }
        const messages = result.msg_list.map((raw, index) =>
          normalizeWecomMessage(raw, openKfId, { cursor, index }),
        );
        const ingested = this.store.ingestSyncPage({
          openKfId,
          expectedCursor: cursor,
          nextCursor,
          messages,
          deferred,
        });
        cursor = ingested.cursor;
        const interruptedByLive = deferred && this.liveRequested.has(openKfId);
        if (interruptedByLive) {
          const pending = this.preemptedConversations.get(openKfId) || new Set<string>();
          for (const message of messages) {
            pending.add(
              `${message.conversation.accountKey}\0${message.conversation.peerId}`,
            );
          }
          this.preemptedConversations.set(openKfId, pending);
          return false;
        }
        if (!deferred) {
          const liveConversations = new Set(
            messages.map((message) =>
              `${message.conversation.accountKey}\0${message.conversation.peerId}`
            ),
          );
          liveConversationPages.push([...liveConversations]);
        }
        if (result.has_more !== 1) {
          liveDrainCompleted = true;
          return true;
        }
      }
      throw new Error(`sync_msg exceeded ${MAX_SYNC_PAGES} pages`);
    } finally {
      if (
        this.accepting
        && !deferred
        && (liveDrainCompleted || liveConversationPages.some((page) => page.length > 0))
      ) {
        this.#enqueueLiveConversations(openKfId, liveConversationPages);
      }
    }
  }

  #enqueueLiveConversations(
    openKfId: string,
    pages: readonly (readonly string[])[],
  ): void {
    const latestFirst = new Set<string>();
    for (const page of [...pages].reverse()) {
      for (const conversation of page) latestFirst.add(conversation);
    }
    const conversations = latestFirst.size
      ? latestFirst
      : this.preemptedConversations.get(openKfId) || new Set<string>();
    this.preemptedConversations.delete(openKfId);
    if (!this.consuming) return;
    const seen = new Set<string>();
    for (const conversation of conversations) {
      const [service = '', customer = ''] = conversation.split('\0');
      for (const record of this.store.promoteDeferredConversation({
        openKfId: service,
        externalUserId: customer,
      })) {
        if (seen.has(record.messageKey)) continue;
        seen.add(record.messageKey);
        void this.processor.enqueue(record.messageKey).catch((error: unknown) => {
          this.logger.error?.(
            `[wecom] live enqueue failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          );
        });
      }
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.workers.size) {
      await Promise.allSettled([...this.workers.values()]);
    }
  }

  startConsuming(): void {
    this.consuming = true;
  }

  stopAccepting(): void {
    if (!this.accepting) return;
    this.accepting = false;
    this.callbackTokens.clear();
    this.pending.clear();
    this.#cancelRetries();
    this.#cancelSyncWaiters();
  }

  async close(): Promise<void> {
    this.stopAccepting();
    await this.waitForIdle();
  }
}
