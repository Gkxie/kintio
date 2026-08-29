import type { Logger } from '../types.ts';
import { IlinkLoginStore, type IlinkLoginRuntimeOffer } from './login-store.ts';
import {
  IlinkClient,
  IlinkProtocolError,
  normalizeIlinkBaseUrl,
} from './protocol/client.ts';
import type { IlinkQrStatusResponse } from './protocol/types.ts';
import { renderIlinkQrPng } from './qr.ts';
import { IlinkSecretBox } from './secret-box.ts';
import { IlinkSqliteStore } from './sqlite-store.ts';
import { createIlinkAccountKey } from './store-types.ts';

const POLL_INTERVAL_MS = 1_000;

interface LoginClient {
  createQr(request?: {
    readonly local_token_list?: readonly string[];
  }): Promise<{ qrcode: string; qrcode_img_content: string }>;
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
    this.#maxAccounts = maxAccounts;
    this.#clock = clock;
    this.#onAccountsChanged = onAccountsChanged;
    this.#logger = logger;
    this.#sleep = sleepFunction;
  }

  async start(): Promise<void> {
    if (this.#closed) throw new Error('iLink login manager is closed');
    for (const offer of this.#offers.listActive()) this.#startPolling(offer);
  }

  async offer(sessionToken: string): Promise<{ offerId: string; png: Buffer }> {
    if (this.#closed) throw new Error('iLink login manager is closed');
    if (this.#offers.findForSession(sessionToken)) {
      throw new Error('An iLink login offer is already pending');
    }
    if (
      this.#accounts.listActiveAccounts().length +
        this.#offers.listActive().length >= this.#maxAccounts
    ) {
      throw new Error('iLink account limit reached');
    }
    const localTokens = this.#accounts.listActiveAccountsWithSecrets()
      .slice(-10)
      .reverse()
      .map(({ account, secret }) => this.#secrets.open(secret.sealedBotToken, {
        secretKind: 'bot_token',
        accountId: account.accountKey,
        peerId: account.ownerPeerId,
        generation: secret.accountGeneration,
      }));
    const created = await this.#client.createQr({ local_token_list: localTokens });
    if (
      this.#accounts.listActiveAccounts().length +
        this.#offers.listActive().length >= this.#maxAccounts
    ) {
      throw new Error('iLink account limit reached');
    }
    const offer = this.#offers.create({
      sessionToken,
      qrCode: created.qrcode,
      apiBaseUrl: normalizeIlinkBaseUrl('https://ilinkai.weixin.qq.com/'),
    });
    let png: Buffer;
    try {
      png = await renderIlinkQrPng(created.qrcode_img_content);
    } catch (error) {
      this.#offers.finish(offer.offerId, 'failed');
      throw error;
    }
    this.#startPolling(offer);
    return { offerId: offer.offerId, png };
  }

  cancel(offerId: string): void {
    this.#running.get(offerId)?.controller.abort();
    this.#offers.finish(offerId, 'cancelled');
  }

  #startPolling(offer: IlinkLoginRuntimeOffer): void {
    if (this.#running.has(offer.offerId) || this.#closed) return;
    const controller = new AbortController();
    const task = this.#poll(offer, controller.signal).finally(() => {
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
          this.#offers.finish(offer.offerId, 'cancelled');
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
  }
}
