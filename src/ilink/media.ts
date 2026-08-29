import {
  createCipheriv,
  createHash,
  randomBytes,
} from 'node:crypto';

import { detectImageFormat } from '../lib/image-format.ts';
import type { IlinkRequestOptions } from './protocol/client.ts';
import { IlinkMessageItemType } from './protocol/types.ts';

/**
 * This in-memory upload flow was independently rewritten after reviewing the
 * MIT-licensed @tencent-weixin/openclaw-weixin 2.4.6 CDN implementation. It
 * deliberately omits that package's local-file and remote-URL helpers.
 * See THIRD_PARTY_NOTICES for attribution.
 */

export const MAX_ILINK_IMAGE_BYTES = 2 * 1024 * 1024;
export const DEFAULT_ILINK_MEDIA_TIMEOUT_MS = 15_000;

const MAX_MEDIA_TIMEOUT_MS = 60_000;
const MAX_PEER_ID_BYTES = 1_024;
const MAX_OPAQUE_PARAM_BYTES = 256 * 1024;
const MAX_UPLOAD_URL_BYTES = 512 * 1024;
const ILINK_CDN_HOST = 'novac2c.cdn.weixin.qq.com';
const ILINK_CDN_UPLOAD_URL = `https://${ILINK_CDN_HOST}/c2c/upload`;
const VISIBLE_ASCII = /^[\x21-\x7e]+$/u;

const IlinkUploadMediaType = {
  IMAGE: 1,
} as const;

export interface IlinkGetUploadUrlRequest {
  readonly filekey: string;
  readonly media_type: typeof IlinkUploadMediaType.IMAGE;
  readonly to_user_id: string;
  readonly rawsize: number;
  readonly rawfilemd5: string;
  readonly filesize: number;
  readonly no_need_thumb: true;
  readonly aeskey: string;
}

export interface IlinkGetUploadUrlResponse {
  readonly upload_param?: string;
  readonly upload_full_url?: string;
}

/** Narrow dependency implemented by the authenticated iLink protocol client. */
export interface IlinkImageUploadClient {
  getUploadUrl(
    request: IlinkGetUploadUrlRequest,
    options?: IlinkRequestOptions,
  ): Promise<IlinkGetUploadUrlResponse>;
}

export interface IlinkImageMessageItem {
  readonly type: typeof IlinkMessageItemType.IMAGE;
  readonly image_item: {
    readonly media: {
      readonly encrypt_query_param: string;
      readonly aes_key: string;
      readonly encrypt_type: 1;
    };
    readonly mid_size: number;
  };
}

export type IlinkMediaErrorCode =
  | 'invalid_image'
  | 'image_too_large'
  | 'invalid_peer'
  | 'invalid_timeout'
  | 'get_upload_url_failed'
  | 'invalid_upload_response'
  | 'unsafe_upload_url'
  | 'upload_failed'
  | 'upload_rejected'
  | 'timeout'
  | 'aborted';

export class IlinkMediaError extends Error {
  readonly code: IlinkMediaErrorCode;
  readonly status: number | undefined;

  constructor(
    code: IlinkMediaErrorCode,
    message: string,
    details: { readonly status?: number; readonly cause?: unknown } = {},
  ) {
    super(
      message,
      details.cause === undefined ? undefined : { cause: details.cause },
    );
    this.name = 'IlinkMediaError';
    this.code = code;
    this.status = details.status;
  }
}

export interface UploadIlinkImageBufferOptions {
  readonly bytes: Buffer;
  readonly peerId: string;
  readonly client: IlinkImageUploadClient;
  readonly fetchImpl?: typeof globalThis.fetch;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

interface RequestControl {
  readonly signal: AbortSignal;
  readonly cleanup: () => void;
}

function mediaError(
  code: IlinkMediaErrorCode,
  message: string,
  details?: { readonly status?: number; readonly cause?: unknown },
): IlinkMediaError {
  return new IlinkMediaError(code, message, details);
}

function normalizeTimeout(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_MEDIA_TIMEOUT_MS
  ) {
    throw mediaError(
      'invalid_timeout',
      `iLink media timeout must be between 1 and ${MAX_MEDIA_TIMEOUT_MS} milliseconds`,
    );
  }
  return value;
}

function normalizePeerId(value: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > MAX_PEER_ID_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw mediaError('invalid_peer', 'Invalid iLink image recipient');
  }
  return value;
}

function copyAndValidateImage(value: Buffer): Buffer {
  if (!Buffer.isBuffer(value) || value.length === 0 || !detectImageFormat(value)) {
    throw mediaError('invalid_image', 'Invalid iLink image bytes');
  }
  if (value.length > MAX_ILINK_IMAGE_BYTES) {
    throw mediaError(
      'image_too_large',
      `iLink image exceeds the ${MAX_ILINK_IMAGE_BYTES}-byte limit`,
    );
  }
  return Buffer.from(value);
}

function validateAesKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 16) {
    throw mediaError('invalid_image', 'iLink media AES key must contain 16 bytes');
  }
}

/** AES-128-ECB encryption with the PKCS#7 padding enabled by Node by default. */
export function encryptIlinkMedia(plaintext: Buffer, key: Buffer): Buffer {
  if (!Buffer.isBuffer(plaintext)) {
    throw mediaError('invalid_image', 'Invalid iLink media bytes');
  }
  validateAesKey(key);
  const cipher = createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function ilinkAesEcbPaddedSize(plaintextSize: number): number {
  if (!Number.isSafeInteger(plaintextSize) || plaintextSize < 0) {
    throw mediaError('invalid_image', 'Invalid iLink media size');
  }
  return Math.ceil((plaintextSize + 1) / 16) * 16;
}

function opaqueParameter(value: unknown, label: string): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > MAX_OPAQUE_PARAM_BYTES ||
    !VISIBLE_ASCII.test(value)
  ) {
    throw mediaError('invalid_upload_response', `Invalid iLink ${label}`);
  }
  return value;
}

function validateCdnUploadUrl(value: string): URL {
  if (
    !value ||
    value !== value.trim() ||
    Buffer.byteLength(value, 'utf8') > MAX_UPLOAD_URL_BYTES
  ) {
    throw mediaError('unsafe_upload_url', 'Unsafe iLink CDN upload URL');
  }

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw mediaError('unsafe_upload_url', 'Unsafe iLink CDN upload URL');
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== ILINK_CDN_HOST ||
    url.username ||
    url.password ||
    url.port ||
    url.pathname !== '/c2c/upload' ||
    !url.search ||
    url.hash
  ) {
    throw mediaError('unsafe_upload_url', 'Unsafe iLink CDN upload URL');
  }
  return url;
}

function resolveUploadUrl(value: unknown, filekey: string): URL {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw mediaError('invalid_upload_response', 'Invalid iLink upload response');
  }
  const response = value as Record<string, unknown>;
  const fullUrl = response.upload_full_url;
  if (fullUrl !== undefined && typeof fullUrl !== 'string') {
    throw mediaError('invalid_upload_response', 'Invalid iLink upload_full_url');
  }
  if (typeof fullUrl === 'string' && fullUrl !== '') {
    return validateCdnUploadUrl(fullUrl);
  }

  const uploadParam = opaqueParameter(response.upload_param, 'upload_param');
  const fallback = new URL(ILINK_CDN_UPLOAD_URL);
  fallback.searchParams.set('encrypted_query_param', uploadParam);
  fallback.searchParams.set('filekey', filekey);
  return fallback;
}

function createRequestControl(
  externalSignal: AbortSignal | undefined,
  timeoutMs: number,
): RequestControl {
  const controller = new AbortController();
  const onExternalAbort = (): void => {
    controller.abort(mediaError('aborted', 'iLink image upload was aborted'));
  };
  if (externalSignal?.aborted) {
    onExternalAbort();
  } else {
    externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  }
  const timer = setTimeout(() => {
    controller.abort(mediaError('timeout', 'iLink image upload timed out'));
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

function abortReason(signal: AbortSignal): IlinkMediaError {
  return signal.reason instanceof IlinkMediaError
    ? signal.reason
    : mediaError('aborted', 'iLink image upload was aborted');
}

async function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw abortReason(signal);
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

function imageMessageItem({
  encryptedParameter,
  aesKey,
  ciphertextSize,
}: {
  readonly encryptedParameter: string;
  readonly aesKey: Buffer;
  readonly ciphertextSize: number;
}): IlinkImageMessageItem {
  return Object.freeze({
    type: IlinkMessageItemType.IMAGE,
    image_item: Object.freeze({
      media: Object.freeze({
        encrypt_query_param: encryptedParameter,
        aes_key: Buffer.from(aesKey.toString('hex'), 'ascii').toString('base64'),
        encrypt_type: 1 as const,
      }),
      mid_size: ciphertextSize,
    }),
  });
}

/**
 * Encrypt and upload image bytes, then produce the IMAGE MessageItem accepted
 * by sendmessage. Only caller-provided memory is accepted as image input.
 */
export async function uploadIlinkImageBuffer({
  bytes,
  peerId,
  client,
  fetchImpl = globalThis.fetch,
  signal: externalSignal,
  timeoutMs: rawTimeoutMs = DEFAULT_ILINK_MEDIA_TIMEOUT_MS,
}: UploadIlinkImageBufferOptions): Promise<IlinkImageMessageItem> {
  const plaintext = copyAndValidateImage(bytes);
  const recipient = normalizePeerId(peerId);
  const timeoutMs = normalizeTimeout(rawTimeoutMs);
  if (typeof client?.getUploadUrl !== 'function') {
    throw mediaError('get_upload_url_failed', 'iLink upload client is unavailable');
  }
  if (typeof fetchImpl !== 'function') {
    throw mediaError('upload_failed', 'iLink CDN transport is unavailable');
  }

  const aesKey = randomBytes(16);
  const filekey = randomBytes(16).toString('hex');
  const ciphertext = encryptIlinkMedia(plaintext, aesKey);
  const request: IlinkGetUploadUrlRequest = Object.freeze({
    filekey,
    media_type: IlinkUploadMediaType.IMAGE,
    to_user_id: recipient,
    rawsize: plaintext.length,
    rawfilemd5: createHash('md5').update(plaintext).digest('hex'),
    filesize: ilinkAesEcbPaddedSize(plaintext.length),
    no_need_thumb: true,
    aeskey: aesKey.toString('hex'),
  });
  const control = createRequestControl(externalSignal, timeoutMs);

  try {
    let uploadDetails: IlinkGetUploadUrlResponse;
    try {
      uploadDetails = await abortable(
        client.getUploadUrl(request, { signal: control.signal, timeoutMs }),
        control.signal,
      );
    } catch (error: unknown) {
      if (control.signal.aborted) throw abortReason(control.signal);
      throw mediaError(
        'get_upload_url_failed',
        'Could not obtain an iLink CDN upload URL',
        { cause: error },
      );
    }

    const uploadUrl = resolveUploadUrl(uploadDetails, filekey);
    let response: Response;
    try {
      response = await abortable(
        fetchImpl(uploadUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: new Uint8Array(ciphertext),
          redirect: 'error',
          signal: control.signal,
        }),
        control.signal,
      );
    } catch (error: unknown) {
      if (control.signal.aborted) throw abortReason(control.signal);
      throw mediaError('upload_failed', 'iLink CDN upload failed', { cause: error });
    }

    if (response.redirected) {
      throw mediaError('unsafe_upload_url', 'iLink CDN redirects are forbidden');
    }
    if (response.url) {
      const responseUrl = validateCdnUploadUrl(response.url);
      if (responseUrl.href !== uploadUrl.href) {
        throw mediaError('unsafe_upload_url', 'iLink CDN response URL changed');
      }
    }
    if (response.status !== 200) {
      throw mediaError(
        'upload_rejected',
        `iLink CDN rejected the upload with HTTP ${response.status}`,
        { status: response.status },
      );
    }
    const encryptedParameter = opaqueParameter(
      response.headers.get('x-encrypted-param'),
      'x-encrypted-param',
    );
    return imageMessageItem({
      encryptedParameter,
      aesKey,
      ciphertextSize: ciphertext.length,
    });
  } finally {
    control.cleanup();
  }
}
