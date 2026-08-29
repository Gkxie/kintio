import { createDecipheriv } from 'node:crypto';

import {
  detectImageFormat,
  MAX_WECHAT_IMAGE_BYTES,
} from '../lib/image-format.ts';

const ILINK_CDN_ORIGIN = 'https://novac2c.cdn.weixin.qq.com';
const ILINK_CDN_DOWNLOAD_PATH = '/c2c/download';
const ILINK_CDN_HOSTNAME = 'novac2c.cdn.weixin.qq.com';
const MAX_LOCATOR_CHARACTERS = 32 * 1024;
const MAX_ENCRYPTED_IMAGE_BYTES = MAX_WECHAT_IMAGE_BYTES + 16;
const MAX_IMAGE_DIMENSION = 10_000;
const MAX_IMAGE_PIXELS = 25_000_000;

export const DEFAULT_ILINK_IMAGE_TIMEOUT_MS = 10_000;

type JsonRecord = Record<string, unknown>;

export type IlinkInboundImageErrorKind =
  | 'invalid_locator'
  | 'invalid_key'
  | 'download_timeout'
  | 'download_failed'
  | 'response_too_large'
  | 'decryption_failed'
  | 'image_too_large'
  | 'unsupported_image';

export class IlinkInboundImageError extends Error {
  readonly kind: IlinkInboundImageErrorKind;

  constructor(kind: IlinkInboundImageErrorKind, message: string) {
    // Deliberately do not retain a cause: fetch and crypto errors can contain
    // the signed CDN URL or other provider-controlled values.
    super(message);
    this.name = 'IlinkInboundImageError';
    this.kind = kind;
  }
}

export interface IlinkInboundImageLocator {
  readonly downloadUrl: string;
  readonly aesKey: Buffer;
}

export interface ResolvedIlinkInboundImage {
  readonly bytes: Buffer;
  readonly contentType: 'image/png' | 'image/jpeg';
}

export interface IlinkInboundImageDownloadOptions {
  readonly fetchImpl?: typeof globalThis.fetch;
  /** May shorten, but never extend, the production timeout. */
  readonly timeoutMs?: number;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function invalidLocator(): IlinkInboundImageError {
  return new IlinkInboundImageError(
    'invalid_locator',
    'iLink image contains an invalid or missing CDN locator',
  );
}

function invalidKey(): IlinkInboundImageError {
  return new IlinkInboundImageError(
    'invalid_key',
    'iLink image contains an invalid or missing AES key',
  );
}

function parseHexKey(value: unknown): Buffer {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{32}$/u.test(value)) {
    throw invalidKey();
  }
  return Buffer.from(value, 'hex');
}

function parseBase64Key(value: unknown): Buffer {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    value.length > 64 ||
    value.length % 4 === 1 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw invalidKey();
  }

  const unpadded = value.replace(/=+$/u, '');
  const decoded = Buffer.from(value, 'base64');
  if (decoded.toString('base64').replace(/=+$/u, '') !== unpadded) {
    throw invalidKey();
  }
  if (decoded.length === 16) return decoded;
  if (
    decoded.length === 32 &&
    /^[0-9a-fA-F]{32}$/u.test(decoded.toString('ascii'))
  ) {
    return Buffer.from(decoded.toString('ascii'), 'hex');
  }
  throw invalidKey();
}

function validateDownloadUrl(raw: string): string {
  if (
    !raw ||
    raw !== raw.trim() ||
    raw.length > MAX_LOCATOR_CHARACTERS ||
    /[\u0000-\u001f\u007f]/u.test(raw)
  ) {
    throw invalidLocator();
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalidLocator();
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname !== ILINK_CDN_HOSTNAME ||
    url.username ||
    url.password ||
    url.port ||
    url.hash
  ) {
    throw invalidLocator();
  }
  return url.href;
}

function buildDownloadUrl(queryParam: unknown): string {
  if (
    typeof queryParam !== 'string' ||
    !queryParam ||
    queryParam !== queryParam.trim() ||
    queryParam.length > MAX_LOCATOR_CHARACTERS ||
    /[\u0000-\u001f\u007f]/u.test(queryParam)
  ) {
    throw invalidLocator();
  }
  const query = new URLSearchParams({ encrypted_query_param: queryParam });
  return `${ILINK_CDN_ORIGIN}${ILINK_CDN_DOWNLOAD_PATH}?${query}`;
}

/**
 * Extract only the original-image CDN URL and AES key. `url`, `thumb_media`,
 * and all non-image media fields are intentionally ignored.
 */
export function extractIlinkInboundImageLocator(
  imageItem: unknown,
): IlinkInboundImageLocator {
  if (!isRecord(imageItem) || !isRecord(imageItem.media)) {
    throw invalidLocator();
  }

  const media = imageItem.media;
  const downloadUrl = media.full_url !== undefined
    ? validateDownloadUrl(
        typeof media.full_url === 'string' ? media.full_url : '',
      )
    : buildDownloadUrl(media.encrypt_query_param);

  // The official 2.4.6 implementation observes two key encodings. The
  // image-level raw hex key takes precedence and an invalid preferred key is
  // rejected rather than silently falling back to another field.
  const aesKey = imageItem.aeskey !== undefined
    ? parseHexKey(imageItem.aeskey)
    : parseBase64Key(media.aes_key);

  return Object.freeze({ downloadUrl, aesKey });
}

function normalizeTimeout(value: number | undefined): number {
  const timeoutMs = value ?? DEFAULT_ILINK_IMAGE_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > DEFAULT_ILINK_IMAGE_TIMEOUT_MS
  ) {
    throw new IlinkInboundImageError(
      'download_failed',
      `iLink image timeout must be between 1 and ${DEFAULT_ILINK_IMAGE_TIMEOUT_MS} ms`,
    );
  }
  return timeoutMs;
}

function declaredContentLength(response: Response): number | undefined {
  const raw = response.headers.get('content-length');
  if (raw === null) return undefined;
  if (!/^\d+$/u.test(raw)) {
    throw new IlinkInboundImageError(
      'download_failed',
      'iLink image CDN returned an invalid response',
    );
  }
  const length = Number(raw);
  if (!Number.isSafeInteger(length)) {
    throw new IlinkInboundImageError(
      'response_too_large',
      'iLink encrypted image exceeds the response size limit',
    );
  }
  return length;
}

async function readBoundedBody(response: Response): Promise<Buffer> {
  const length = declaredContentLength(response);
  if (length !== undefined && length > MAX_ENCRYPTED_IMAGE_BYTES) {
    throw new IlinkInboundImageError(
      'response_too_large',
      'iLink encrypted image exceeds the response size limit',
    );
  }

  const reader = response.body?.getReader();
  if (!reader) {
    throw new IlinkInboundImageError(
      'download_failed',
      'iLink image CDN returned an empty response',
    );
  }

  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const result = await reader.read();
    if (result.done) break;
    const chunk = Buffer.from(result.value);
    total += chunk.length;
    if (total > MAX_ENCRYPTED_IMAGE_BYTES) {
      void reader.cancel().catch(() => undefined);
      throw new IlinkInboundImageError(
        'response_too_large',
        'iLink encrypted image exceeds the response size limit',
      );
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function fetchEncryptedImage(
  downloadUrl: string,
  fetchImpl: typeof globalThis.fetch,
  signal: AbortSignal,
): Promise<Buffer> {
  let response: Response;
  try {
    response = await fetchImpl(downloadUrl, {
      method: 'GET',
      redirect: 'error',
      signal,
    });
  } catch {
    if (signal.aborted) {
      throw new IlinkInboundImageError(
        'download_timeout',
        'iLink image download timed out',
      );
    }
    throw new IlinkInboundImageError(
      'download_failed',
      'iLink image CDN request failed',
    );
  }

  if (response.redirected) {
    throw new IlinkInboundImageError(
      'download_failed',
      'iLink image CDN redirect was rejected',
    );
  }
  if (!response.ok) {
    throw new IlinkInboundImageError(
      'download_failed',
      `iLink image CDN request failed with HTTP ${response.status}`,
    );
  }
  return readBoundedBody(response);
}

async function fetchWithTimeout(
  downloadUrl: string,
  fetchImpl: typeof globalThis.fetch,
  timeoutMs: number,
): Promise<Buffer> {
  const controller = new AbortController();
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new IlinkInboundImageError(
        'download_timeout',
        'iLink image download timed out',
      ));
    }, timeoutMs);
    timer.unref();
  });

  try {
    return await Promise.race([
      fetchEncryptedImage(downloadUrl, fetchImpl, controller.signal),
      timeout,
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function decryptImage(ciphertext: Buffer, aesKey: Buffer): Buffer {
  if (ciphertext.length === 0 || ciphertext.length % 16 !== 0) {
    throw new IlinkInboundImageError(
      'decryption_failed',
      'iLink image ciphertext is invalid',
    );
  }
  try {
    const decipher = createDecipheriv('aes-128-ecb', aesKey, null);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new IlinkInboundImageError(
      'decryption_failed',
      'iLink image decryption failed',
    );
  }
}

function validateDimensions(width: number, height: number): void {
  if (
    width < 1 || height < 1 ||
    width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION ||
    width * height > MAX_IMAGE_PIXELS
  ) {
    throw new IlinkInboundImageError(
      'unsupported_image',
      'iLink image dimensions exceed the safe decode limit',
    );
  }
}

function validatePng(bytes: Buffer): void {
  if (
    bytes.length < 45 || bytes.readUInt32BE(8) !== 13 ||
    bytes.subarray(12, 16).toString('ascii') !== 'IHDR' ||
    bytes.subarray(bytes.length - 8, bytes.length - 4).toString('ascii') !== 'IEND'
  ) {
    throw new IlinkInboundImageError(
      'unsupported_image',
      'iLink PNG structure is incomplete',
    );
  }
  validateDimensions(bytes.readUInt32BE(16), bytes.readUInt32BE(20));
}

function validateJpeg(bytes: Buffer): Buffer {
  if (
    bytes.length < 12 || bytes.readUInt16BE(0) !== 0xffd8
  ) {
    throw new IlinkInboundImageError(
      'unsupported_image',
      'iLink JPEG structure is incomplete',
    );
  }
  let offset = 2;
  let imageEnd = 0;
  let dimensions: { width: number; height: number } | undefined;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++];
    if (marker === undefined || marker === 0xd9) break;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) break;
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) break;
    if (
      [
        0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
        0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
      ].includes(marker)
    ) {
      if (length < 7) break;
      dimensions = {
        height: bytes.readUInt16BE(offset + 3),
        width: bytes.readUInt16BE(offset + 5),
      };
    }
    if (marker === 0xda) {
      const eoi = bytes.indexOf(Buffer.from([0xff, 0xd9]), offset + length);
      if (eoi >= 0) imageEnd = eoi + 2;
      break;
    }
    offset += length;
  }
  if (!imageEnd) {
    throw new IlinkInboundImageError(
      'unsupported_image',
      'iLink JPEG structure is incomplete',
    );
  }
  if (!dimensions) {
    throw new IlinkInboundImageError(
      'unsupported_image',
      'iLink JPEG dimensions are missing',
    );
  }
  validateDimensions(dimensions.width, dimensions.height);
  bytes.fill(0, imageEnd);
  return bytes.subarray(0, imageEnd);
}

/**
 * Download and decrypt one iLink image entirely in memory. No URL, key, or
 * provider error body is retained in thrown errors.
 */
export async function downloadIlinkInboundImage(
  imageItem: unknown,
  options: IlinkInboundImageDownloadOptions = {},
): Promise<ResolvedIlinkInboundImage> {
  const locator = extractIlinkInboundImageLocator(imageItem);
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== 'function') {
    locator.aesKey.fill(0);
    throw new IlinkInboundImageError(
      'download_failed',
      'iLink image download is unavailable',
    );
  }

  try {
    const ciphertext = await fetchWithTimeout(
      locator.downloadUrl,
      fetchImpl,
      normalizeTimeout(options.timeoutMs),
    );
    const bytes = decryptImage(ciphertext, locator.aesKey);
    if (bytes.length > MAX_WECHAT_IMAGE_BYTES) {
      throw new IlinkInboundImageError(
        'image_too_large',
        'iLink image exceeds the 2 MiB image size limit',
      );
    }

    const format = detectImageFormat(bytes);
    if (format?.mimeType !== 'image/png' && format?.mimeType !== 'image/jpeg') {
      throw new IlinkInboundImageError(
        'unsupported_image',
        'iLink image must be PNG or JPEG',
      );
    }
    if (format.mimeType === 'image/png') validatePng(bytes);
    const sanitized = format.mimeType === 'image/jpeg' ? validateJpeg(bytes) : bytes;
    return Object.freeze({ bytes: sanitized, contentType: format.mimeType });
  } finally {
    locator.aesKey.fill(0);
  }
}
