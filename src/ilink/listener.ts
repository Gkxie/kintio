import {
  normalizeIlinkInboundMessage,
  type IlinkNormalizedInbound,
} from './message.ts';
import { IlinkClient, IlinkProtocolError } from './protocol/client.ts';
import type {
  IlinkGetUpdatesRequest,
  IlinkGetUpdatesResponse,
  IlinkNotifyStartResponse,
  IlinkNotifyStopResponse,
} from './protocol/types.ts';
import type { IlinkAccountKey } from './store-types.ts';
import type { Logger } from '../types.ts';

const DEFAULT_BACKOFF_MIN_MS = 250;
const DEFAULT_BACKOFF_MAX_MS = 10_000;

export interface IlinkListenerRuntimeAccount {
  readonly accountKey: IlinkAccountKey;
  readonly providerAccountId: string;
  readonly ownerPeerId: string;
  readonly generation: number;
  readonly cursor: string;
  readonly botToken: string;
  readonly baseUrl: string;
}

export interface IlinkListenerCommitInput {
  readonly accountKey: IlinkAccountKey;
  readonly expectedGeneration: number;
  readonly expectedCursor: string;
  readonly nextCursor: string;
  readonly messages: readonly IlinkNormalizedInbound[];
  readonly deferredBefore: number;
}

interface IlinkListenerCommitResult {
  readonly insertedMessageKeys: readonly string[];
  readonly cursor: string;
  readonly deferredMessageCount?: number;
}

export interface IlinkListenerHost {
  listActiveRuntimeAccounts(): readonly IlinkListenerRuntimeAccount[];
  commitPage(input: IlinkListenerCommitInput): IlinkListenerCommitResult;
  enqueue(messageKeys: readonly string[]): void;
  backlogReady?(): void | Promise<void>;
}

export interface IlinkPollClient {
  notifyStart?(): Promise<IlinkNotifyStartResponse>;
  notifyStop?(): Promise<IlinkNotifyStopResponse>;
  getUpdates(
    request?: IlinkGetUpdatesRequest,
    options?: { signal?: AbortSignal },
  ): Promise<IlinkGetUpdatesResponse>;
}

export type IlinkPollClientFactory = (
  account: IlinkListenerRuntimeAccount,
) => IlinkPollClient;

export type IlinkListenerSleep = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

interface ListenerState {
  readonly account: IlinkListenerRuntimeAccount;
  readonly controller: AbortController;
  readonly client: IlinkPollClient;
  cursor: string;
  pendingMessageKeys: readonly string[];
  readonly startedAt: number;
  catchingUp: boolean;
}

interface RunningListener {
  readonly state: ListenerState;
  readonly task: Promise<void>;
}

function abortableSleep(
  milliseconds: number,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    function done(): void {
      signal.removeEventListener('abort', aborted);
      resolve();
    }
    function aborted(): void {
      clearTimeout(timeout);
      signal.removeEventListener('abort', aborted);
      reject(signal.reason);
    }
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function validRuntimeAccount(account: IlinkListenerRuntimeAccount): boolean {
  return Boolean(
    account &&
    typeof account.accountKey === 'string' &&
    typeof account.providerAccountId === 'string' &&
    account.providerAccountId &&
    typeof account.ownerPeerId === 'string' &&
    account.ownerPeerId &&
    Number.isSafeInteger(account.generation) &&
    account.generation > 0 &&
    typeof account.cursor === 'string' &&
    typeof account.botToken === 'string' &&
    account.botToken &&
    typeof account.baseUrl === 'string' &&
    account.baseUrl
  );
}

function sameRuntime(
  running: ListenerState,
  desired: IlinkListenerRuntimeAccount,
): boolean {
  const current = running.account;
  return current.accountKey === desired.accountKey &&
    current.providerAccountId === desired.providerAccountId &&
    current.ownerPeerId === desired.ownerPeerId &&
    current.generation === desired.generation &&
    running.cursor === desired.cursor &&
    current.botToken === desired.botToken &&
    current.baseUrl === desired.baseUrl;
}

function fenceRejection(error: unknown): boolean {
  if (!error || typeof error !== 'object' || !('code' in error)) return false;
  return [
    'account_not_found',
    'account_not_active',
    'generation_conflict',
    'cursor_conflict',
  ].includes(String(error.code));
}

function defaultClientFactory(
  account: IlinkListenerRuntimeAccount,
): IlinkPollClient {
  return new IlinkClient({
    token: account.botToken,
    baseUrl: account.baseUrl,
  });
}

export class IlinkListenerManager {
  readonly #host: IlinkListenerHost;
  readonly #createClient: IlinkPollClientFactory;
  readonly #logger: Logger;
  readonly #sleep: IlinkListenerSleep;
  readonly #backoffMinMs: number;
  readonly #backoffMaxMs: number;
  readonly #listeners = new Map<IlinkAccountKey, RunningListener>();
  readonly #tasks = new Set<Promise<void>>();
  #refreshTail: Promise<void> = Promise.resolve();
  #started = false;
  #closed = false;
  #backlogReadyNotified = false;

  constructor({
    host,
    createClient = defaultClientFactory,
    logger = console,
    sleep = abortableSleep,
    backoffMinMs = DEFAULT_BACKOFF_MIN_MS,
    backoffMaxMs = DEFAULT_BACKOFF_MAX_MS,
  }: {
    host: IlinkListenerHost;
    createClient?: IlinkPollClientFactory;
    logger?: Logger;
    sleep?: IlinkListenerSleep;
    backoffMinMs?: number;
    backoffMaxMs?: number;
  }) {
    if (
      !Number.isSafeInteger(backoffMinMs) ||
      !Number.isSafeInteger(backoffMaxMs) ||
      backoffMinMs < 1 ||
      backoffMaxMs < backoffMinMs
    ) {
      throw new Error('Invalid iLink listener backoff configuration');
    }
    this.#host = host;
    this.#createClient = createClient;
    this.#logger = logger;
    this.#sleep = sleep;
    this.#backoffMinMs = backoffMinMs;
    this.#backoffMaxMs = backoffMaxMs;
  }

  start(): Promise<void> {
    if (this.#closed) {
      return Promise.reject(new Error('iLink listener manager is closed'));
    }
    this.#started = true;
    return this.refresh();
  }

  refresh(): Promise<void> {
    if (!this.#started) {
      return Promise.reject(new Error('iLink listener manager is not started'));
    }
    if (this.#closed) return Promise.resolve();
    const refresh = this.#refreshTail.then(() => this.#reconcile());
    this.#refreshTail = refresh.catch(() => undefined);
    return refresh;
  }

  async #reconcile(): Promise<void> {
    if (this.#closed) return;
    const desired = new Map<IlinkAccountKey, IlinkListenerRuntimeAccount>();
    for (const account of this.#host.listActiveRuntimeAccounts()) {
      if (!validRuntimeAccount(account) || desired.has(account.accountKey)) {
        throw new Error('Invalid iLink runtime account list');
      }
      desired.set(account.accountKey, account);
    }

    const retiring: RunningListener[] = [];
    for (const [accountKey, running] of this.#listeners) {
      const account = desired.get(accountKey);
      if (!account || !sameRuntime(running.state, account)) {
        this.#listeners.delete(accountKey);
        running.state.controller.abort();
        retiring.push(running);
      }
    }
    await Promise.allSettled(retiring.map((running) => running.task));
    if (this.#closed) return;

    for (const [accountKey, account] of desired) {
      if (!this.#listeners.has(accountKey)) this.#startAccount(account);
    }
    await this.#notifyBacklogReadyIfAll();
  }

  #startAccount(account: IlinkListenerRuntimeAccount): void {
    this.#backlogReadyNotified = false;
    const state: ListenerState = {
      account,
      controller: new AbortController(),
      client: this.#createClient(account),
      cursor: account.cursor,
      pendingMessageKeys: Object.freeze([]),
      startedAt: Date.now(),
      catchingUp: true,
    };
    const task = this.#run(state).finally(() => {
      this.#tasks.delete(task);
      if (this.#listeners.get(account.accountKey)?.state === state) {
        this.#listeners.delete(account.accountKey);
      }
      void this.#notifyBacklogReadyIfAll();
    });
    this.#tasks.add(task);
    this.#listeners.set(account.accountKey, { state, task });
  }

  async #run(state: ListenerState): Promise<void> {
    try {
      try {
        await state.client.notifyStart?.();
      } catch {
        if (!state.controller.signal.aborted && !this.#closed) {
          this.#logger.warn?.(
            '[ilink-listener] notifyStart failed; continuing',
          );
        }
      }
      if (!state.controller.signal.aborted && !this.#closed) {
        await this.#poll(state);
      }
    } finally {
      try {
        // Deliberately do not pass the listener AbortSignal. notifyStop must be
        // able to finish after the in-flight long poll has been cancelled.
        await state.client.notifyStop?.();
      } catch {
        this.#logger.warn?.('[ilink-listener] notifyStop failed; ignored');
      }
    }
  }

  async #poll(state: ListenerState): Promise<void> {
    let failures = 0;
    const { signal } = state.controller;
    while (!this.#closed && !signal.aborted) {
      try {
        if (state.pendingMessageKeys.length > 0) {
          this.#host.enqueue(state.pendingMessageKeys);
          state.pendingMessageKeys = Object.freeze([]);
        }

        const expectedCursor = state.cursor;
        const response = await state.client.getUpdates(
          { get_updates_buf: expectedCursor },
          { signal },
        );
        if (signal.aborted || this.#closed) return;
        const nextCursor = typeof response.get_updates_buf === 'string'
          ? response.get_updates_buf
          : expectedCursor;
        if ((response.msgs?.length || 0) > 0 && nextCursor === expectedCursor) {
          throw new Error('iLink getUpdates returned messages without cursor progress');
        }
        const pair = {
          accountKey: state.account.accountKey,
          botId: state.account.providerAccountId,
          ownerUserId: state.account.ownerPeerId,
        } as const;
        const messages = (response.msgs ?? []).flatMap((message, index) => {
          const normalized = normalizeIlinkInboundMessage(
            message,
            pair,
            { cursor: expectedCursor, index },
          );
          return normalized ? [normalized] : [];
        });

        let committed: IlinkListenerCommitResult;
        try {
          committed = this.#host.commitPage({
            accountKey: state.account.accountKey,
            expectedGeneration: state.account.generation,
            expectedCursor,
            nextCursor,
            messages,
            deferredBefore: state.startedAt,
          });
        } catch (error: unknown) {
          if (fenceRejection(error)) return;
          throw error;
        }
        state.cursor = committed.cursor;
        state.pendingMessageKeys = Object.freeze([
          ...committed.insertedMessageKeys,
        ]);
        if (state.pendingMessageKeys.length > 0) {
          this.#host.enqueue(state.pendingMessageKeys);
          state.pendingMessageKeys = Object.freeze([]);
        }
        if (
          state.catchingUp &&
          ((response.msgs?.length || 0) === 0 ||
            messages.some(({ message }) => message.sentAt >= state.startedAt))
        ) {
          state.catchingUp = false;
          await this.#notifyBacklogReadyIfAll();
        } else if (
          (committed.deferredMessageCount || 0) > 0 &&
          ![...this.#listeners.values()].some(({ state: other }) => other.catchingUp)
        ) {
          await this.#host.backlogReady?.();
        }
        failures = 0;
      } catch (error: unknown) {
        if (signal.aborted || this.#closed) return;
        const sessionExpired = error instanceof IlinkProtocolError &&
          error.kind === 'business' &&
          (error.errcode === -14 || error.ret === -14);
        if (state.catchingUp) {
          state.catchingUp = false;
          await this.#notifyBacklogReadyIfAll();
        }
        const delay = Math.min(
          this.#backoffMaxMs,
          this.#backoffMinMs * 2 ** Math.min(failures, 30),
        );
        failures += 1;
        this.#logger.warn?.(
          `[ilink-listener] poll cycle failed; retry_ms=${delay}`,
        );
        try {
          await this.#sleep(delay, signal);
        } catch {
          if (signal.aborted || this.#closed) return;
        }
        if (sessionExpired && !signal.aborted && !this.#closed) {
          try {
            await state.client.notifyStart?.();
            failures = 0;
          } catch {
            this.#logger.warn?.(
              '[ilink-listener] expired session refresh failed; retrying',
            );
          }
        }
      }
    }
  }

  async #notifyBacklogReadyIfAll(): Promise<void> {
    if (
      this.#closed || this.#backlogReadyNotified ||
      [...this.#listeners.values()].some(({ state }) => state.catchingUp)
    ) {
      return;
    }
    this.#backlogReadyNotified = true;
    await this.#host.backlogReady?.();
  }

  async waitForIdle(): Promise<void> {
    while (this.#tasks.size > 0) {
      await Promise.allSettled([...this.#tasks]);
    }
  }

  async close(): Promise<void> {
    if (this.#closed) {
      await this.waitForIdle();
      return;
    }
    this.#closed = true;
    for (const running of this.#listeners.values()) {
      running.state.controller.abort();
    }
    await this.#refreshTail;
    for (const running of this.#listeners.values()) {
      running.state.controller.abort();
    }
    await this.waitForIdle();
    this.#listeners.clear();
  }
}
