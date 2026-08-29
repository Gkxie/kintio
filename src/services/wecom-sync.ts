import { normalizeWecomMessage } from '../domain/wecom-message.ts';
import type { Logger } from '../types.ts';
import type { SqliteStore } from '../state/sqlite-store.ts';
import type { ConversationProcessor } from './conversation-processor.ts';
import type { WecomApiClient } from './wecom-api.ts';

const MAX_SYNC_PAGES = 100;

export class WecomSync {
  readonly apiClient: Pick<WecomApiClient, 'syncMessages'>;
  readonly store: Pick<
    SqliteStore,
    | 'getCursor'
    | 'listSyncOpenKfIds'
    | 'ingestSyncPage'
    | 'promoteDeferredConversation'
  >;
  readonly processor: Pick<ConversationProcessor, 'enqueue'>;
  readonly logger: Logger;
  private readonly queues = new Map<string, Promise<void>>();
  private accepting = true;
  private consuming = false;

  constructor({
    apiClient,
    store,
    processor,
    logger = console,
    startPaused = false,
  }: {
    apiClient: Pick<WecomApiClient, 'syncMessages'>;
    store: Pick<
      SqliteStore,
      | 'getCursor'
      | 'listSyncOpenKfIds'
      | 'ingestSyncPage'
      | 'promoteDeferredConversation'
    >;
    processor: Pick<ConversationProcessor, 'enqueue'>;
    logger?: Logger;
    startPaused?: boolean;
  }) {
    this.apiClient = apiClient;
    this.store = store;
    this.processor = processor;
    this.logger = logger;
    this.consuming = !startPaused;
  }

  enqueue({
    callbackToken,
    openKfId,
  }: {
    callbackToken: string;
    openKfId: string;
  }): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    return this.#queue(callbackToken, openKfId, false);
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
      openKfIds.map((openKfId) => this.#queue('', openKfId, true)),
    ).then(() => undefined);
  }

  #queue(
    callbackToken: string,
    openKfId: string,
    deferred: boolean,
  ): Promise<void> {
    const previous = this.queues.get(openKfId) || Promise.resolve();
    const task = previous.then(
      () => this.#drain(callbackToken, openKfId, deferred),
      () => this.#drain(callbackToken, openKfId, deferred),
    );
    const guarded = task.catch((error) => {
      this.logger.error?.(
        `[wecom] sync failed: ${error.message}`,
      );
    });
    this.queues.set(openKfId, guarded);
    void guarded.finally(() => {
      if (this.queues.get(openKfId) === guarded) this.queues.delete(openKfId);
    });
    return guarded;
  }

  async #drain(
    callbackToken: string,
    openKfId: string,
    deferred: boolean,
  ): Promise<void> {
    let cursor = this.store.getCursor(openKfId);

    for (let page = 0; page < MAX_SYNC_PAGES; page += 1) {
      const result = await this.apiClient.syncMessages({
        cursor,
        callbackToken,
        openKfId,
      });
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
      if (!deferred) {
        const ready = new Map<number, string>();
        const conversations = new Set(
          messages.map((message) =>
            `${message.conversation.accountKey}\0${message.conversation.peerId}`
          ),
        );
        for (const conversation of conversations) {
          const [service = '', customer = ''] = conversation.split('\0');
          for (const record of this.store.promoteDeferredConversation({
            openKfId: service,
            externalUserId: customer,
          })) {
            ready.set(record.inboxSeq, record.messageKey);
          }
        }
        if (this.consuming) {
          await Promise.all(
            [...ready.entries()].sort(([left], [right]) => left - right)
              .map(([, messageKey]) => this.processor.enqueue(messageKey)),
          );
        }
      }
      if (result.has_more !== 1) return;
    }
    throw new Error(`sync_msg exceeded ${MAX_SYNC_PAGES} pages`);
  }

  async waitForIdle(): Promise<void> {
    while (this.queues.size) {
      await Promise.allSettled([...this.queues.values()]);
    }
  }

  startConsuming(): void {
    this.consuming = true;
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  async close(): Promise<void> {
    this.stopAccepting();
    await this.waitForIdle();
  }
}
