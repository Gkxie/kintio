import { normalizeWecomMessage } from '../domain/wecom-message.ts';
import type { Logger } from '../types.ts';
import type { SqliteStore } from '../state/sqlite-store.ts';
import type { ConversationProcessor } from './conversation-processor.ts';
import type { WecomApiClient } from './wecom-api.ts';

const MAX_SYNC_PAGES = 100;

export class WecomSync {
  readonly apiClient: Pick<WecomApiClient, 'syncMessages'>;
  readonly store: Pick<SqliteStore, 'getCursor' | 'ingestSyncPage'>;
  readonly processor: Pick<ConversationProcessor, 'enqueue'>;
  readonly logger: Logger;
  private readonly queues = new Map<string, Promise<void>>();
  private accepting = true;

  constructor({
    apiClient,
    store,
    processor,
    logger = console,
  }: {
    apiClient: Pick<WecomApiClient, 'syncMessages'>;
    store: Pick<SqliteStore, 'getCursor' | 'ingestSyncPage'>;
    processor: Pick<ConversationProcessor, 'enqueue'>;
    logger?: Logger;
  }) {
    this.apiClient = apiClient;
    this.store = store;
    this.processor = processor;
    this.logger = logger;
  }

  enqueue({
    callbackToken,
    openKfId,
  }: {
    callbackToken: string;
    openKfId: string;
  }): Promise<void> {
    if (!this.accepting) return Promise.resolve();
    const previous = this.queues.get(openKfId) || Promise.resolve();
    const task = previous.then(
      () => this.#drain(callbackToken, openKfId),
      () => this.#drain(callbackToken, openKfId),
    );
    const guarded = task.catch((error) => {
      this.logger.error?.(
        `[wecom] sync failed open_kfid=${openKfId}: ${error.message}`,
      );
    });
    this.queues.set(openKfId, guarded);
    void guarded.finally(() => {
      if (this.queues.get(openKfId) === guarded) this.queues.delete(openKfId);
    });
    return guarded;
  }

  async #drain(callbackToken: string, openKfId: string): Promise<void> {
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
      });
      cursor = ingested.cursor;
      await Promise.all(
        ingested.insertedMessageKeys.map((messageKey) =>
          this.processor.enqueue(messageKey),
        ),
      );
      if (result.has_more !== 1) return;
    }
    throw new Error(`sync_msg exceeded ${MAX_SYNC_PAGES} pages`);
  }

  async waitForIdle(): Promise<void> {
    await Promise.allSettled([...this.queues.values()]);
  }

  stopAccepting(): void {
    this.accepting = false;
  }

  async close(): Promise<void> {
    this.stopAccepting();
    await this.waitForIdle();
  }
}
