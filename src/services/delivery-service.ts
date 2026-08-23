import { WecomApiError } from './wecom-api.js';
import type { Logger } from '../types.js';
import type { SqliteStore } from '../state/sqlite-store.js';
import type { WecomApiClient } from './wecom-api.js';

function isDefinitiveFailure(error: unknown): error is WecomApiError {
  return (
    error instanceof WecomApiError &&
    error.code !== undefined &&
    Number.isFinite(Number(error.code))
  );
}

export class DeliveryService {
  readonly apiClient: Pick<WecomApiClient, 'sendPreparedMessage'>;
  readonly store: SqliteStore;
  readonly logger: Logger;
  private readonly workers = new Set<Promise<void>>();
  private readonly concurrency: number;
  private kickPending = false;
  private closed = false;

  constructor({
    apiClient,
    store,
    logger = console,
    concurrency = 4,
  }: {
    apiClient: Pick<WecomApiClient, 'sendPreparedMessage'>;
    store: SqliteStore;
    logger?: Logger;
    concurrency?: number;
  }) {
    this.apiClient = apiClient;
    this.store = store;
    this.logger = logger;
    this.concurrency = Math.max(1, Number(concurrency) || 4);
  }

  kick(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.kickPending = true;
    if (this.workers.size < this.concurrency) this.#fillWorkers();
    return this.waitForIdle();
  }

  #fillWorkers(): void {
    if (this.closed || this.workers.size >= this.concurrency) return;
    this.kickPending = false;
    while (this.workers.size < this.concurrency) {
      const worker = this.#drain().finally(() => {
        this.workers.delete(worker);
        if (this.kickPending && !this.closed) this.#fillWorkers();
      });
      this.workers.add(worker);
    }
  }

  async #drain(): Promise<void> {
    while (!this.closed) {
      const attempt = await this.store.beginNextSend();
      if (!attempt) return;
      const attemptId = attempt.attemptId;
      try {
        if (!attempt.payload) {
          throw new WecomApiError('Outbox attempt has no exact payload', {
            code: 'invalid_outbox',
          });
        }
        const result = await this.apiClient.sendPreparedMessage({
          toUser: attempt.externalUserId,
          openKfId: attempt.openKfId,
          payload: attempt.payload,
          messageId: attempt.clientMessageId,
        });
        const wecomMsgId = String(result.msgid || '');
        if (!wecomMsgId) {
          throw new Error('WeChat accepted the request without a message ID');
        }
        await this.store.completeSend(attemptId, {
          wecomMsgId,
        });
        this.logger.info?.(
          `[wecom] API accepted outbound type=${attempt.type} attempt=${attemptId}`,
        );
      } catch (error: unknown) {
        if (isDefinitiveFailure(error)) {
          await this.store.failSend(attemptId, error);
          this.logger.warn?.(
            `[wecom] outbound definitively failed attempt=${attemptId}: ${error.message}`,
          );
          continue;
        }
        await this.store.markSendUncertain(attemptId, error);
        this.logger.error?.(
          `[wecom] outbound result is uncertain attempt=${attemptId}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }

  async waitForIdle(): Promise<void> {
    while (this.workers.size) {
      await Promise.allSettled([...this.workers]);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    await this.kick();
    this.closed = true;
  }
}
