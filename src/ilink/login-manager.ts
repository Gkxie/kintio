import type { Logger } from '../types.ts';
import {
  IlinkLoginStore,
  type IlinkLoginRuntimeOffer,
  type IlinkLoginSource,
  type IlinkLoginStatus,
} from './login-store.ts';
import {
  DEFAULT_ILINK_BASE_URL,
  IlinkClient,
  IlinkProtocolError,
  normalizeIlinkBaseUrl,
} from './protocol/client.ts';
import type { IlinkQrStatusResponse } from './protocol/types.ts';
import { assertIlinkQrContent } from './qr.ts';
import { IlinkSecretBox } from './secret-box.ts';
import { IlinkSqliteStore } from './sqlite-store.ts';
import {
  createIlinkAccountKey,
  type IlinkAccountKey,
} from './store-types.ts';

const POLL_INTERVAL_MS = 1_000;
const MAX_EXPIRY_TIMER_MS = 10 * 60 * 1_000;

interface LoginClient {
  createQr(request?: {
    readonly local_token_list?: readonly string[];
  }, options?: { readonly signal?: AbortSignal }): Promise<{
    qrcode: string;
    qrcode_img_content: string;
  }>;
  getQrStatus(
    request: { qrcode: string },
    options: { signal: AbortSignal; baseUrl: string },
  ): Promise<IlinkQrStatusResponse>;
  resolveRedirectBaseUrl(host: string): string;
}

function sleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolve, reject) => {
    const done = () => {
      signal.removeEventListener('abort', abort);
      resolve();
    };
    const timer = setTimeout(done, milliseconds);
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    timer.unref();
  });
}

export type IlinkLoginSleep = (
  milliseconds: number,
  signal: AbortSignal,
) => Promise<void>;

export class IlinkLoginManager {
  readonly #offers: IlinkLoginStore;
  readonly #accounts: IlinkSqliteStore;
  readonly #secrets: IlinkSecretBox;
  readonly #client: LoginClient;
  readonly #logger: Logger;
  readonly #maxAccounts: number;
  readonly #baseUrl: string;
  readonly #clock: () => number;
  readonly #onAccountsChanged: () => void | Promise<void>;
  readonly #sleep: IlinkLoginSleep;
  readonly #running = new Map<string, { controller: AbortController; task: Promise<void> }>();
  #closed = false;

  constructor({
    offers,
    accounts,
    secretBox,
    client = new IlinkClient(),
    baseUrl = DEFAULT_ILINK_BASE_URL,
    maxAccounts = 20,
    clock = Date.now,
    onAccountsChanged = () => undefined,
    logger = console,
    sleep: sleepFunction = sleep,
  }: {
    offers: IlinkLoginStore;
    accounts: IlinkSqliteStore;
    secretBox: IlinkSecretBox;
    client?: LoginClient;
    baseUrl?: string;
    maxAccounts?: number;
    clock?: () => number;
    onAccountsChanged?: () => void | Promise<void>;
    logger?: Logger;
    sleep?: IlinkLoginSleep;
  }) {
    this.#offers = offers;
    this.#accounts = accounts;
    this.#secrets = secretBox;
    this.#client = client;
    this.#baseUrl = normalizeIlinkBaseUrl(baseUrl);
    this.#maxAccounts = maxAccounts;
    this.#clock = clock;
    this.#onAccountsChanged = onAccountsChanged;
    this.#logger = logger;
    this.#sleep = sleepFunction;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('iLink login manager is closed');
    for (const offer of this.#offers.listActive()) {
      if (offer.initiatorKind === 'local_operator') {
        this.#offers.finish(offer.offerId, 'cancelled');
      }
      else this.#startPolling(offer);
    }
  }

  async offer(
    source: IlinkLoginSource,
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<{
    offerId: string;
    qrContent: string;
    expiresAt: number;
  }> {
    if (this.#closed) throw new Error('iLink login manager is closed');
    if (this.#offers.find(source)) {
      throw new Error('An iLink login offer is already pending');
    }
    if (
      source.kind !== 'terminal' &&
      this.#accounts.listActiveAccounts().length +
        this.#offers.listActive().length >= this.#maxAccounts
    ) {
      throw new Error('iLink account limit reached');
    }
    const localAccounts = this.#accounts.listActiveAccountsWithSecrets()
      .slice(source.kind === 'terminal' ? -1 : -10)
      .reverse();
    const localTokens = localAccounts
      .map(({ account, secret }) => this.#secrets.open(secret.sealedBotToken, {
        secretKind: 'bot_token',
        accountId: account.accountKey,
        peerId: account.ownerPeerId,
        generation: secret.accountGeneration,
      }));
    const created = await this.#client.createQr(
      { local_token_list: localTokens },
      options.signal ? { signal: options.signal } : {},
    );
    if (options.signal?.aborted) throw options.signal.reason;
    assertIlinkQrContent(created.qrcode_img_content);
    if (
      source.kind !== 'terminal' &&
      this.#accounts.listActiveAccounts().length +
        this.#offers.listActive().length >= this.#maxAccounts
    ) {
      throw new Error('iLink account limit reached');
    }
    const offer = this.#offers.create({
      source,
      qrCode: created.qrcode,
      apiBaseUrl: this.#baseUrl,
      candidateAccountKeys: source.kind === 'terminal'
        ? localAccounts.map(({ account }) => account.accountKey)
        : [],
    });
    this.#startPolling(offer);
    return {
      offerId: offer.offerId,
      qrContent: created.qrcode_img_content,
      expiresAt: offer.expiresAt,
    };
  }

  status(offerId: string): { readonly status: IlinkLoginStatus } {
    const status = this.#offers.status(offerId);
    if (status.status !== 'waiting' && status.status !== 'scanned') {
      this.#running.get(offerId)?.controller.abort();
    }
    return status;
  }

  cancel(offerId: string): boolean {
    this.#running.get(offerId)?.controller.abort();
    return this.#offers.finish(offerId, 'cancelled');
  }

  #startPolling(offer: IlinkLoginRuntimeOffer): void {
    if (this.#running.has(offer.offerId) || this.#closed) return;
    const controller = new AbortController();
    const expiryTimer = setTimeout(() => {
      try {
        this.#offers.finish(offer.offerId, 'expired');
      } catch {
        this.#logger.warn?.('[ilink-login] expired offer cleanup failed');
      } finally {
        controller.abort(new Error('iLink login offer expired'));
      }
    }, Math.max(
      0,
      Math.min(MAX_EXPIRY_TIMER_MS, offer.expiresAt - Number(this.#clock())),
    ));
    expiryTimer.unref();
    const task = this.#poll(offer, controller.signal).finally(() => {
      clearTimeout(expiryTimer);
      if (this.#running.get(offer.offerId)?.controller === controller) {
        this.#running.delete(offer.offerId);
      }
    });
    this.#running.set(offer.offerId, { controller, task });
  }

  async #poll(initial: IlinkLoginRuntimeOffer, signal: AbortSignal): Promise<void> {
    let offer = initial;
    while (!this.#closed && !signal.aborted && Number(this.#clock()) < offer.expiresAt) {
      try {
        const result = await this.#client.getQrStatus(
          { qrcode: offer.qrCode },
          { signal, baseUrl: offer.apiBaseUrl },
        );
        if (signal.aborted || !this.#offers.isActive(offer.offerId)) return;
        if (result.status === 'confirmed') {
          try {
            await this.#confirm(offer, result);
          } catch {
            this.#offers.finish(offer.offerId, 'failed');
            this.#logger.warn?.('[ilink-login] confirmed account activation failed');
          }
          return;
        }
        if (result.status === 'binded_redirect') {
          if (offer.initiatorKind === 'local_operator') {
            const candidates = offer.candidateAccountKeys;
            let reported: IlinkAccountKey | undefined;
            try {
              if (result.ilink_bot_id) {
                reported = createIlinkAccountKey(String(result.ilink_bot_id));
              }
            } catch {
              reported = undefined;
            }
            const accountKey = reported && candidates.includes(reported)
              ? reported
              : candidates.length === 1
                ? candidates[0]
                : undefined;
            if (!accountKey) {
              this.#offers.finish(offer.offerId, 'failed');
              this.#logger.warn?.(
                '[ilink-login] already-connected account could not be identified',
              );
              return;
            }
            this.#accounts.confirmExistingEnrollment({
              offerId: offer.offerId,
              accountKey,
              now: Number(this.#clock()),
            });
          } else {
            this.#offers.finish(offer.offerId, 'already_connected');
          }
          this.#logger.info?.('[ilink-login] account is already connected');
          return;
        }
        if (result.status === 'scaned_but_redirect' && result.redirect_host) {
          offer = this.#offers.update(offer.offerId, {
            status: 'waiting',
            apiBaseUrl: this.#client.resolveRedirectBaseUrl(result.redirect_host),
          });
        } else if (result.status === 'scaned') {
          offer = this.#offers.update(offer.offerId, { status: 'scanned' });
        } else if (
          result.status === 'need_verifycode' ||
          result.status === 'verify_code_blocked'
        ) {
          this.#offers.finish(offer.offerId, 'verification_required');
          return;
        } else if (result.status !== 'wait') {
          this.#offers.finish(
            offer.offerId,
            result.status === 'expired' ? 'expired' : 'failed',
          );
          return;
        }
        await this.#sleep(POLL_INTERVAL_MS, signal);
      } catch (error: unknown) {
        if (signal.aborted || this.#closed) return;
        if (error instanceof IlinkProtocolError && error.kind === 'configuration') {
          this.#offers.finish(offer.offerId, 'failed');
          return;
        }
        this.#logger.warn?.('[ilink-login] status poll failed; retrying');
        await this.#sleep(POLL_INTERVAL_MS, signal).catch(() => undefined);
      }
    }
    this.#offers.finish(offer.offerId, 'expired');
  }

  async #confirm(
    offer: IlinkLoginRuntimeOffer,
    result: IlinkQrStatusResponse,
  ): Promise<void> {
    const providerAccountId = String(result.ilink_bot_id || '');
    const ownerPeerId = String(result.ilink_user_id || '');
    const token = String(result.bot_token || '');
    if (!providerAccountId || !ownerPeerId || !token) {
      throw new Error('Confirmed iLink login is missing credentials');
    }
    const accountKey = createIlinkAccountKey(providerAccountId);
    const existing = this.#accounts.getAccount(accountKey);
    const generation = existing ? existing.generation + 1 : 1;
    const encryptedBotToken = this.#secrets.seal(token, {
      secretKind: 'bot_token',
      accountId: accountKey,
      peerId: ownerPeerId,
      generation,
    });
    const baseUrl = normalizeIlinkBaseUrl(result.baseurl || offer.apiBaseUrl);
    this.#accounts.confirmEnrollment({
      offerId: offer.offerId,
      accountGeneration: generation,
      maxAccounts: this.#maxAccounts,
      providerAccountId,
      ownerPeerId,
      baseUrl,
      encryptedBotToken,
      now: Number(this.#clock()),
    });
    await this.#onAccountsChanged();
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    for (const running of this.#running.values()) running.controller.abort();
    await Promise.allSettled([...this.#running.values()].map(({ task }) => task));
    this.#running.clear();
    for (const offer of this.#offers.listActive()) {
      if (offer.initiatorKind === 'local_operator') {
        this.#offers.finish(offer.offerId, 'cancelled');
      }
    }
  }
}
