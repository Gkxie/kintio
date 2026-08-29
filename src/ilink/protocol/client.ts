import crypto from 'node:crypto';
import { isIP } from 'node:net';

import {
  ILINK_QR_STATUSES,
  type IlinkBaseInfo,
  type IlinkGetUpdatesRequest,
  type IlinkGetUpdatesResponse,
  type IlinkNotifyStartResponse,
  type IlinkNotifyStopResponse,
  type IlinkQrCreateRequest,
  type IlinkQrCreateResponse,
  type IlinkQrStatusRequest,
  type IlinkQrStatusResponse,
  type IlinkSendMessageRequest,
  type IlinkSendMessageResponse,
} from './types.ts';
import type {
  IlinkGetUploadUrlRequest,
  IlinkGetUploadUrlResponse,
} from '../media.ts';

export const DEFAULT_ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com/';
const DEFAULT_ILINK_ALLOWED_HOST_SUFFIXES = Object.freeze([
  'weixin.qq.com',
]);

const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_LIFECYCLE_TIMEOUT_MS = 10_000;
const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_BOT_TYPE = '3';
const REFERENCE_APP_ID = 'bot';
const REFERENCE_CHANNEL_VERSION = '2.4.6';
const REFERENCE_APP_CLIENT_VERSION = (2 << 16) | (4 << 8) | 6;
const MAX_LOCAL_TOKENS = 10;
const MAX_QR_LENGTH = 8_192;
const MAX_VERIFY_CODE_LENGTH = 64;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

type JsonRecord = Record<string, unknown>;

export type IlinkProtocolErrorKind =
  | 'configuration'
  | 'unsafe_url'
  | 'transport'
  | 'http'
  | 'invalid_json'
  | 'invalid_response'
  | 'business';

export class IlinkProtocolError extends Error {
  readonly kind: IlinkProtocolErrorKind;
  readonly operation: string | undefined;
  readonly status: number | undefined;
  readonly ret: number | undefined;
  readonly errcode: number | undefined;

  constructor(
    kind: IlinkProtocolErrorKind,
    message: string,
    details: {
      operation?: string;
      status?: number;
      ret?: number;
      errcode?: number;
      cause?: unknown;
    } = {},
  ) {
    super(message, details.cause === undefined ? undefined : { cause: details.cause });
    this.name = 'IlinkProtocolError';
    this.kind = kind;
    this.operation = details.operation;
    this.status = details.status;
    this.ret = details.ret;
    this.errcode = details.errcode;
  }
}

export interface IlinkRequestOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  baseUrl?: string;
}

export interface IlinkClientOptions {
  token?: string;
  baseUrl?: string;
  allowedHostSuffixes?: readonly string[];
  fetchImpl?: typeof globalThis.fetch;
  timeoutMs?: number;
  longPollTimeoutMs?: number;
  appId?: string;
  appClientVersion?: number;
  baseInfo?: IlinkBaseInfo;
}

function configurationError(message: string): IlinkProtocolError {
  return new IlinkProtocolError('configuration', message);
}

function unsafeUrlError(message: string): IlinkProtocolError {
  return new IlinkProtocolError('unsafe_url', message);
}

function normalizeTimeout(value: number, label: string): number {
  if (!Number.isFinite(value) || !Number.isInteger(value) || value < 1) {
    throw configurationError(`${label} must be a positive integer`);
  }
  return value;
}

function normalizeHostSuffix(raw: string): string {
  const suffix = raw.trim().toLowerCase().replace(/^\.+/u, '');
  if (
    !suffix ||
    suffix === 'localhost' ||
    isIP(suffix) !== 0 ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(suffix) ||
    !suffix.includes('.') ||
    suffix.includes('..')
  ) {
    throw configurationError(`Invalid iLink allowed host suffix: ${raw}`);
  }
  return suffix;
}

function normalizeAllowedHostSuffixes(
  rawSuffixes: readonly string[],
): readonly string[] {
  const suffixes = [...new Set(rawSuffixes.map(normalizeHostSuffix))];
  if (suffixes.length === 0) {
    throw configurationError('At least one iLink allowed host suffix is required');
  }
  return Object.freeze(suffixes);
}

function hostnameAllowed(
  hostname: string,
  allowedHostSuffixes: readonly string[],
): boolean {
  const normalized = hostname.toLowerCase();
  return allowedHostSuffixes.some(
    (suffix) => normalized === suffix || normalized.endsWith(`.${suffix}`),
  );
}

export function normalizeIlinkBaseUrl(
  rawBaseUrl: string,
  allowedHostSuffixes: readonly string[] = DEFAULT_ILINK_ALLOWED_HOST_SUFFIXES,
): string {
  if (!rawBaseUrl || rawBaseUrl !== rawBaseUrl.trim()) {
    throw unsafeUrlError('iLink baseUrl must be a non-empty URL without surrounding whitespace');
  }

  let url: URL;
  try {
    url = new URL(rawBaseUrl);
  } catch {
    throw unsafeUrlError('iLink baseUrl must be a valid HTTPS URL');
  }

  const suffixes = normalizeAllowedHostSuffixes(allowedHostSuffixes);
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    url.pathname !== '/' ||
    isIP(url.hostname) !== 0 ||
    !hostnameAllowed(url.hostname, suffixes)
  ) {
    throw unsafeUrlError(
      'iLink baseUrl must be an allowlisted public HTTPS origin without credentials, port, path, query, or hash',
    );
  }

  return `${url.origin}/`;
}

export function ilinkRedirectHostToBaseUrl(
  rawHost: string,
  allowedHostSuffixes: readonly string[] = DEFAULT_ILINK_ALLOWED_HOST_SUFFIXES,
): string {
  if (
    !rawHost ||
    rawHost !== rawHost.trim() ||
    !/^[A-Za-z0-9.-]+$/u.test(rawHost) ||
    rawHost.startsWith('.') ||
    rawHost.endsWith('.') ||
    rawHost.includes('..')
  ) {
    throw unsafeUrlError('iLink redirect_host must be a plain allowlisted hostname');
  }
  return normalizeIlinkBaseUrl(`https://${rawHost}/`, allowedHostSuffixes);
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf8').toString('base64');
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalInteger(
  data: JsonRecord,
  key: 'ret' | 'errcode',
  operation: string,
): number | undefined {
  const value = data[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new IlinkProtocolError(
      'invalid_response',
      `${operation} returned an invalid ${key}`,
      { operation },
    );
  }
  return value;
}

function assertBusinessSuccess(data: JsonRecord, operation: string): void {
  const ret = optionalInteger(data, 'ret', operation);
  const errcode = optionalInteger(data, 'errcode', operation);
  if ((ret !== undefined && ret !== 0) || (errcode !== undefined && errcode !== 0)) {
    const errmsg = typeof data.errmsg === 'string' ? data.errmsg : '';
    const codes = [
      ret === undefined ? undefined : `ret=${ret}`,
      errcode === undefined ? undefined : `errcode=${errcode}`,
    ].filter((value): value is string => value !== undefined);
    throw new IlinkProtocolError(
      'business',
      `${operation} failed: ${codes.join(' ')}${errmsg ? ` ${errmsg}` : ''}`,
      {
        operation,
        ...(ret === undefined ? {} : { ret }),
        ...(errcode === undefined ? {} : { errcode }),
      },
    );
  }
}

function requireOptionalString(
  data: JsonRecord,
  key: string,
  operation: string,
): void {
  const value = data[key];
  if (value !== undefined && typeof value !== 'string') {
    throw new IlinkProtocolError(
      'invalid_response',
      `${operation} returned an invalid ${key}`,
      { operation },
    );
  }
}

function requireString(
  data: JsonRecord,
  key: string,
  operation: string,
): string {
  const value = data[key];
  if (typeof value !== 'string' || !value) {
    throw new IlinkProtocolError(
      'invalid_response',
      `${operation} returned an invalid ${key}`,
      { operation },
    );
  }
  return value;
}

async function boundedResponseText(
  response: Response,
  operation: string,
): Promise<string> {
  const declared = Number(response.headers.get('content-length') || 0);
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new IlinkProtocolError(
      'invalid_response',
      `${operation} response exceeds the size limit`,
      { operation, status: response.status },
    );
  }
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        throw new IlinkProtocolError(
          'invalid_response',
          `${operation} response exceeds the size limit`,
          { operation, status: response.status },
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), size)
    .toString('utf8');
}

function normalizedAbortReason(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new DOMException('The operation was aborted', 'AbortError');
}

function createRequestControl(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const onExternalAbort = (): void => {
    controller.abort(normalizedAbortReason(externalSignal?.reason));
  };
  if (externalSignal?.aborted) {
    onExternalAbort();
  } else {
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  }

  const timer = setTimeout(() => {
    controller.abort(new DOMException('The iLink request timed out', 'TimeoutError'));
  }, timeoutMs);
  timer.unref();

  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer);
      externalSignal?.removeEventListener('abort', onExternalAbort);
    },
  };
}

function validateTokenList(tokens: readonly string[]): string[] {
  if (tokens.length > MAX_LOCAL_TOKENS) {
    throw configurationError(`local_token_list must contain at most ${MAX_LOCAL_TOKENS} tokens`);
  }
  return tokens.map((token) => {
    const normalized = token.trim();
    if (!normalized) throw configurationError('local_token_list cannot contain empty tokens');
    return normalized;
  });
}

function validateBotType(botType: string): string {
  if (!/^\d{1,8}$/u.test(botType)) {
    throw configurationError('bot_type must contain 1 to 8 digits');
  }
  return botType;
}

export class IlinkClient {
  readonly baseUrl: string;
  readonly allowedHostSuffixes: readonly string[];
  readonly timeoutMs: number;
  readonly longPollTimeoutMs: number;
  readonly fetch: typeof globalThis.fetch;

  readonly #token: string | undefined;
  readonly #appId: string;
  readonly #appClientVersion: number;
  readonly #baseInfo: Readonly<IlinkBaseInfo>;

  constructor(options: IlinkClientOptions = {}) {
    this.allowedHostSuffixes = normalizeAllowedHostSuffixes(
      options.allowedHostSuffixes ?? DEFAULT_ILINK_ALLOWED_HOST_SUFFIXES,
    );
    this.baseUrl = normalizeIlinkBaseUrl(
      options.baseUrl ?? DEFAULT_ILINK_BASE_URL,
      this.allowedHostSuffixes,
    );
    this.timeoutMs = normalizeTimeout(
      options.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
      'timeoutMs',
    );
    this.longPollTimeoutMs = normalizeTimeout(
      options.longPollTimeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS,
      'longPollTimeoutMs',
    );
    this.fetch = options.fetchImpl ?? globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw configurationError('A fetch implementation is required');
    }

    this.#token = options.token?.trim() || undefined;
    this.#appId = options.appId ?? REFERENCE_APP_ID;
    this.#appClientVersion = options.appClientVersion ?? REFERENCE_APP_CLIENT_VERSION;
    if (!this.#appId || !Number.isInteger(this.#appClientVersion) || this.#appClientVersion < 0) {
      throw configurationError('Valid iLink appId and appClientVersion values are required');
    }
    this.#baseInfo = Object.freeze({
      channel_version: options.baseInfo?.channel_version ?? REFERENCE_CHANNEL_VERSION,
      bot_agent: options.baseInfo?.bot_agent ?? 'WechatBot/1.0.0',
    });
  }

  resolveRedirectBaseUrl(redirectHost: string): string {
    return ilinkRedirectHostToBaseUrl(redirectHost, this.allowedHostSuffixes);
  }

  async getUpdates(
    request: IlinkGetUpdatesRequest = {},
    options: IlinkRequestOptions = {},
  ): Promise<IlinkGetUpdatesResponse> {
    const data = await this.#requestJson({
      operation: 'getUpdates',
      method: 'POST',
      path: 'ilink/bot/getupdates',
      token: this.#requireToken('getUpdates'),
      body: {
        get_updates_buf: request.get_updates_buf ?? '',
        base_info: this.#baseInfo,
      },
      options,
      defaultTimeoutMs: this.longPollTimeoutMs,
    });
    assertBusinessSuccess(data, 'getUpdates');
    if (data.msgs !== undefined && !Array.isArray(data.msgs)) {
      throw new IlinkProtocolError(
        'invalid_response',
        'getUpdates returned an invalid msgs field',
        { operation: 'getUpdates' },
      );
    }
    requireOptionalString(data, 'get_updates_buf', 'getUpdates');
    if (
      data.longpolling_timeout_ms !== undefined &&
      (typeof data.longpolling_timeout_ms !== 'number' ||
        !Number.isFinite(data.longpolling_timeout_ms) ||
        data.longpolling_timeout_ms < 0)
    ) {
      throw new IlinkProtocolError(
        'invalid_response',
        'getUpdates returned an invalid longpolling_timeout_ms',
        { operation: 'getUpdates' },
      );
    }
    return data as unknown as IlinkGetUpdatesResponse;
  }

  async notifyStart(
    options: IlinkRequestOptions = {},
  ): Promise<IlinkNotifyStartResponse> {
    const data = await this.#requestJson({
      operation: 'notifyStart',
      method: 'POST',
      path: 'ilink/bot/msg/notifystart',
      token: this.#requireToken('notifyStart'),
      body: { base_info: this.#baseInfo },
      options,
      defaultTimeoutMs: DEFAULT_LIFECYCLE_TIMEOUT_MS,
    });
    assertBusinessSuccess(data, 'notifyStart');
    requireOptionalString(data, 'errmsg', 'notifyStart');
    return data as IlinkNotifyStartResponse;
  }

  async notifyStop(
    options: IlinkRequestOptions = {},
  ): Promise<IlinkNotifyStopResponse> {
    const data = await this.#requestJson({
      operation: 'notifyStop',
      method: 'POST',
      path: 'ilink/bot/msg/notifystop',
      token: this.#requireToken('notifyStop'),
      body: { base_info: this.#baseInfo },
      options,
      defaultTimeoutMs: DEFAULT_LIFECYCLE_TIMEOUT_MS,
    });
    assertBusinessSuccess(data, 'notifyStop');
    requireOptionalString(data, 'errmsg', 'notifyStop');
    return data as IlinkNotifyStopResponse;
  }

  async sendMessage(
    request: IlinkSendMessageRequest,
    options: IlinkRequestOptions = {},
  ): Promise<IlinkSendMessageResponse> {
    if (!isJsonRecord(request.msg)) {
      throw configurationError('sendMessage requires a msg object');
    }
    const data = await this.#requestJson({
      operation: 'sendMessage',
      method: 'POST',
      path: 'ilink/bot/sendmessage',
      token: this.#requireToken('sendMessage'),
      body: { ...request, base_info: this.#baseInfo },
      options,
      defaultTimeoutMs: this.timeoutMs,
    });
    assertBusinessSuccess(data, 'sendMessage');
    return data as IlinkSendMessageResponse;
  }

  async getUploadUrl(
    request: IlinkGetUploadUrlRequest,
    options: IlinkRequestOptions = {},
  ): Promise<IlinkGetUploadUrlResponse> {
    const data = await this.#requestJson({
      operation: 'getUploadUrl',
      method: 'POST',
      path: 'ilink/bot/getuploadurl',
      token: this.#requireToken('getUploadUrl'),
      body: { ...request, base_info: this.#baseInfo },
      options,
      defaultTimeoutMs: this.timeoutMs,
    });
    assertBusinessSuccess(data, 'getUploadUrl');
    requireOptionalString(data, 'upload_param', 'getUploadUrl');
    requireOptionalString(data, 'upload_full_url', 'getUploadUrl');
    return data as IlinkGetUploadUrlResponse;
  }

  async createQr(
    request: IlinkQrCreateRequest = {},
    options: IlinkRequestOptions = {},
  ): Promise<IlinkQrCreateResponse> {
    const botType = validateBotType(request.bot_type ?? DEFAULT_BOT_TYPE);
    const localTokens = validateTokenList(request.local_token_list ?? []);
    const query = new URLSearchParams({ bot_type: botType });
    const data = await this.#requestJson({
      operation: 'createQr',
      method: 'POST',
      path: `ilink/bot/get_bot_qrcode?${query}`,
      body: { local_token_list: localTokens },
      options,
      defaultTimeoutMs: this.timeoutMs,
    });
    assertBusinessSuccess(data, 'createQr');
    requireString(data, 'qrcode', 'createQr');
    requireString(data, 'qrcode_img_content', 'createQr');
    return data as unknown as IlinkQrCreateResponse;
  }

  async getQrStatus(
    request: IlinkQrStatusRequest,
    options: IlinkRequestOptions = {},
  ): Promise<IlinkQrStatusResponse> {
    if (!request.qrcode || request.qrcode.length > MAX_QR_LENGTH) {
      throw configurationError(`qrcode must contain 1 to ${MAX_QR_LENGTH} characters`);
    }
    if (
      request.verify_code !== undefined &&
      (!request.verify_code || request.verify_code.length > MAX_VERIFY_CODE_LENGTH)
    ) {
      throw configurationError(
        `verify_code must contain 1 to ${MAX_VERIFY_CODE_LENGTH} characters`,
      );
    }

    const query = new URLSearchParams({ qrcode: request.qrcode });
    if (request.verify_code !== undefined) query.set('verify_code', request.verify_code);
    const data = await this.#requestJson({
      operation: 'getQrStatus',
      method: 'GET',
      path: `ilink/bot/get_qrcode_status?${query}`,
      options,
      defaultTimeoutMs: this.longPollTimeoutMs,
    });
    assertBusinessSuccess(data, 'getQrStatus');

    const status = requireString(data, 'status', 'getQrStatus');
    if (!(ILINK_QR_STATUSES as readonly string[]).includes(status)) {
      throw new IlinkProtocolError(
        'invalid_response',
        'getQrStatus returned an unknown status',
        { operation: 'getQrStatus' },
      );
    }
    for (const key of [
      'bot_token',
      'ilink_bot_id',
      'baseurl',
      'ilink_user_id',
      'redirect_host',
    ]) {
      requireOptionalString(data, key, 'getQrStatus');
    }
    if (typeof data.redirect_host === 'string') {
      this.resolveRedirectBaseUrl(data.redirect_host);
    }
    if (typeof data.baseurl === 'string') {
      data.baseurl = normalizeIlinkBaseUrl(data.baseurl, this.allowedHostSuffixes);
    }
    return data as unknown as IlinkQrStatusResponse;
  }

  #requireToken(operation: string): string {
    if (!this.#token) {
      throw configurationError(`${operation} requires an iLink bot token`);
    }
    return this.#token;
  }

  #commonHeaders(): Record<string, string> {
    return {
      'iLink-App-Id': this.#appId,
      'iLink-App-ClientVersion': String(this.#appClientVersion),
    };
  }

  #postHeaders(token: string | undefined): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      AuthorizationType: 'ilink_bot_token',
      'X-WECHAT-UIN': randomWechatUin(),
      ...this.#commonHeaders(),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    };
  }

  async #requestJson({
    operation,
    method,
    path,
    token,
    body,
    options,
    defaultTimeoutMs,
  }: {
    operation: string;
    method: 'GET' | 'POST';
    path: string;
    token?: string;
    body?: JsonRecord;
    options: IlinkRequestOptions;
    defaultTimeoutMs: number;
  }): Promise<JsonRecord> {
    const baseUrl = options.baseUrl === undefined
      ? this.baseUrl
      : normalizeIlinkBaseUrl(options.baseUrl, this.allowedHostSuffixes);
    const url = new URL(path, baseUrl);
    const timeoutMs = normalizeTimeout(options.timeoutMs ?? defaultTimeoutMs, 'request timeoutMs');
    const control = createRequestControl(options.signal, timeoutMs);

    try {
      control.signal.throwIfAborted();
      const response = await this.fetch(url, {
        method,
        headers: method === 'POST' ? this.#postHeaders(token) : this.#commonHeaders(),
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: control.signal,
        redirect: 'error',
      });
      if (!response.ok) {
        throw new IlinkProtocolError(
          'http',
          `${operation} returned HTTP ${response.status}`,
          { operation, status: response.status },
        );
      }
      const responseText = await boundedResponseText(response, operation);

      let parsed: unknown;
      try {
        parsed = JSON.parse(responseText) as unknown;
      } catch {
        throw new IlinkProtocolError(
          'invalid_json',
          `${operation} returned non-JSON HTTP ${response.status}`,
          { operation, status: response.status },
        );
      }
      if (!isJsonRecord(parsed)) {
        throw new IlinkProtocolError(
          'invalid_response',
          `${operation} returned a non-object response`,
          { operation, status: response.status },
        );
      }
      return parsed;
    } catch (error) {
      if (control.signal.aborted) {
        throw normalizedAbortReason(control.signal.reason);
      }
      if (error instanceof IlinkProtocolError) throw error;
      throw new IlinkProtocolError(
        'transport',
        `${operation} request failed`,
        { operation, cause: error },
      );
    } finally {
      control.cleanup();
    }
  }
}
