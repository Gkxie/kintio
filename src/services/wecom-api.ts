import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'https://qyapi.weixin.qq.com';
const INVALID_ACCESS_TOKEN_CODES = new Set([40014, 42001]);
const MAX_MEDIA_ID_CHARACTERS = 512;
const MAX_DOWNLOAD_BYTES = 2 * 1024 * 1024;
const MEDIA_LIMITS: Readonly<Record<string, number>> = Object.freeze({
  image: 2 * 1024 * 1024,
});
const SEND_MESSAGE_TYPES = new Set([
  'text',
  'image',
  'link',
  'miniprogram',
  'location',
]);
type JsonRecord = Record<string, unknown>;
type ImageMedia = {
  type: string;
  bytes: Buffer;
  filename: string;
  contentType: string;
};

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withClientMessageId(
  body: JsonRecord,
  messageId: unknown,
): JsonRecord {
  const value = String(messageId || '');
  if (!value) return body;

  if (value.length > 32 || !/^[0-9A-Za-z_-]+$/.test(value)) {
    throw new Error(
      'WeCom client messageId must use 1 to 32 letters, digits, underscores, or hyphens',
    );
  }

  return { ...body, msgid: value };
}

function safeFilename(filename: unknown): string {
  return String(filename || 'media.bin')
    .replace(/[\r\n"\\/]/g, '_')
    .slice(0, 128);
}

function responseFilename(contentDisposition: unknown): string {
  const value = String(contentDisposition || '');
  const encoded = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i)?.[1];

  if (encoded) {
    try {
      return safeFilename(decodeURIComponent(encoded));
    } catch {
      return safeFilename(encoded);
    }
  }

  const plain = value.match(/filename\s*=\s*"([^"]+)"/i)?.[1];
  return plain ? safeFilename(plain) : '';
}

function createMultipartBody({
  bytes,
  filename,
  contentType,
}: Omit<ImageMedia, 'type'>): { body: Buffer; contentType: string } {
  const boundary = `----wechat-bot-${crypto.randomUUID()}`;
  const header = Buffer.from(
    [
      `--${boundary}`,
      `Content-Disposition: form-data; name="media"; filename="${safeFilename(filename)}"; filelength=${bytes.length}`,
      `Content-Type: ${contentType || 'application/octet-stream'}`,
      '',
      '',
    ].join('\r\n'),
  );
  const footer = Buffer.from(`\r\n--${boundary}--\r\n`);

  return {
    body: Buffer.concat([header, bytes, footer]),
    contentType: `multipart/form-data; boundary=${boundary}`,
  };
}

async function readLimitedBody(
  response: Response,
  limit = MAX_DOWNLOAD_BYTES,
): Promise<Buffer> {
  const declaredLength = Number(response.headers.get('content-length') || 0);
  if (declaredLength > limit) {
    throw new WecomApiError(`media/get response exceeds ${limit} bytes`);
  }
  if (!response.body?.getReader) {
    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.length > limit) {
      throw new WecomApiError(`media/get response exceeds ${limit} bytes`);
    }
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new WecomApiError(`media/get response exceeds ${limit} bytes`);
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks, size);
}

export class WecomApiError extends Error {
  readonly code: number | string | undefined;
  readonly data: JsonRecord | undefined;

  constructor(
    message: string,
    { code, data }: { code?: number | string; data?: JsonRecord } = {},
  ) {
    super(message);
    this.name = 'WecomApiError';
    this.code = code;
    this.data = data;
  }
}

export class WecomApiClient {
  readonly corpId: string;
  readonly kfSecret: string;
  readonly fetch: typeof globalThis.fetch;
  readonly baseUrl: string;
  readonly timeoutMs: number;
  private tokenCache: { value: string; expiresAt: number } | null = null;
  private pendingTokenRequest: Promise<string> | null = null;

  constructor({
    corpId,
    kfSecret,
    fetchImpl = globalThis.fetch,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = 10_000,
  }: {
    corpId: string;
    kfSecret: string;
    fetchImpl?: typeof globalThis.fetch;
    baseUrl?: string;
    timeoutMs?: number;
  }) {
    if (!corpId || !kfSecret) {
      throw new Error('WeCom CorpID and customer-service Secret are required');
    }

    if (typeof fetchImpl !== 'function') {
      throw new Error('A fetch implementation is required');
    }

    this.corpId = corpId;
    this.kfSecret = kfSecret;
    this.fetch = fetchImpl;
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.timeoutMs = timeoutMs;
  }

  clearAccessToken(): void {
    this.tokenCache = null;
  }

  async getAccessToken(): Promise<string> {
    const cached = this.tokenCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.value;
    }

    if (this.pendingTokenRequest) {
      return this.pendingTokenRequest;
    }

    this.pendingTokenRequest = this.#requestAccessToken().finally(() => {
      this.pendingTokenRequest = null;
    });

    return this.pendingTokenRequest;
  }

  async #requestAccessToken(): Promise<string> {
    const query = new URLSearchParams({
      corpid: this.corpId,
      corpsecret: this.kfSecret,
    });
    const data = await this.#fetchJson(
      `${this.baseUrl}/cgi-bin/gettoken?${query}`,
      { method: 'GET' },
      'gettoken',
    );

    const errorCode = Number(data.errcode || 0);

    if (errorCode !== 0) {
      throw new WecomApiError(
        `gettoken failed: ${errorCode} ${data.errmsg || ''}`.trim(),
        { code: errorCode, data },
      );
    }

    if (!data.access_token || !Number.isFinite(Number(data.expires_in))) {
      throw new WecomApiError('gettoken returned an invalid response', { data });
    }

    const expiresIn = Math.max(60, Number(data.expires_in) - 300);
    this.tokenCache = {
      value: String(data.access_token),
      expiresAt: Date.now() + expiresIn * 1000,
    };

    return this.tokenCache.value;
  }

  async #fetchJson(
    url: string,
    options: RequestInit,
    operation: string,
  ): Promise<JsonRecord> {
    let response: Response;

    try {
      response = await this.fetch(url, {
        ...options,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new WecomApiError(`${operation} request failed: ${errorMessage(error)}`);
    }

    const responseText = await response.text();
    let data: JsonRecord;

    try {
      data = JSON.parse(responseText) as JsonRecord;
    } catch {
      throw new WecomApiError(
        `${operation} returned non-JSON HTTP ${response.status}`,
      );
    }

    if (!response.ok) {
      throw new WecomApiError(
        `${operation} returned HTTP ${response.status}`,
        { data },
      );
    }

    return data;
  }

  async #postApi(
    path: string,
    body: JsonRecord,
    retryAccessToken = true,
  ): Promise<JsonRecord> {
    const accessToken = await this.getAccessToken();
    const query = new URLSearchParams({ access_token: accessToken });
    const data = await this.#fetchJson(
      `${this.baseUrl}${path}?${query}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      path,
    );

    const errorCode = Number(data.errcode || 0);

    if (retryAccessToken && INVALID_ACCESS_TOKEN_CODES.has(errorCode)) {
      this.clearAccessToken();
      return this.#postApi(path, body, false);
    }

    if (errorCode !== 0) {
      throw new WecomApiError(
        `${path} failed: ${errorCode} ${data.errmsg || ''}`.trim(),
        { code: errorCode, data },
      );
    }

    return data;
  }

  async #downloadMedia(
    mediaId: string,
    retryAccessToken = true,
  ): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
    const accessToken = await this.getAccessToken();
    const query = new URLSearchParams({
      access_token: accessToken,
      media_id: mediaId,
    });
    let response: Response;

    try {
      response = await this.fetch(
        `${this.baseUrl}/cgi-bin/media/get?${query}`,
        { method: 'GET', signal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error) {
      throw new WecomApiError(`media/get request failed: ${errorMessage(error)}`);
    }

    const contentType = (String(response.headers.get('content-type') || '')
      .split(';')[0] ?? '')
      .trim()
      .toLowerCase();

    if (contentType === 'application/json' || contentType === 'text/json') {
      const data = (await response.json()) as JsonRecord;
      const errorCode = Number(data.errcode || 0);

      if (retryAccessToken && INVALID_ACCESS_TOKEN_CODES.has(errorCode)) {
        this.clearAccessToken();
        return this.#downloadMedia(mediaId, false);
      }

      throw new WecomApiError(
        `media/get failed: ${errorCode} ${data.errmsg || ''}`.trim(),
        { code: errorCode, data },
      );
    }

    if (!response.ok) {
      throw new WecomApiError(`media/get returned HTTP ${response.status}`);
    }

    return {
      bytes: await readLimitedBody(response),
      contentType,
      filename: responseFilename(
        response.headers.get('content-disposition'),
      ),
    };
  }

  async #uploadMedia(
    { type, bytes, filename, contentType }: ImageMedia,
    retryAccessToken = true,
  ): Promise<JsonRecord & { media_id: string }> {
    const accessToken = await this.getAccessToken();
    const query = new URLSearchParams({ access_token: accessToken, type });
    const multipart = createMultipartBody({ bytes, filename, contentType });
    const data = await this.#fetchJson(
      `${this.baseUrl}/cgi-bin/media/upload?${query}`,
      {
        method: 'POST',
        headers: {
          'Content-Type': multipart.contentType,
          'Content-Length': String(multipart.body.length),
        },
        body: multipart.body,
      },
      'media/upload',
    );
    const errorCode = Number(data.errcode || 0);

    if (retryAccessToken && INVALID_ACCESS_TOKEN_CODES.has(errorCode)) {
      this.clearAccessToken();
      return this.#uploadMedia(
        { type, bytes, filename, contentType },
        false,
      );
    }

    if (errorCode !== 0 || !data.media_id) {
      throw new WecomApiError(
        `media/upload failed: ${errorCode} ${data.errmsg || ''}`.trim(),
        { code: errorCode, data },
      );
    }

    return data as JsonRecord & { media_id: string };
  }

  async syncMessages({
    cursor,
    callbackToken,
    openKfId,
    limit = 1000,
    voiceFormat = 0,
  }: {
    cursor?: string;
    callbackToken?: string;
    openKfId?: string;
    limit?: number;
    voiceFormat?: number;
  }): Promise<JsonRecord & { has_more: number; msg_list: JsonRecord[] }> {
    const body: JsonRecord = { limit, voice_format: voiceFormat };

    if (cursor) body.cursor = cursor;
    if (callbackToken) body.token = callbackToken;
    if (openKfId) body.open_kfid = openKfId;

    const data = await this.#postApi('/cgi-bin/kf/sync_msg', body);

    return {
      ...data,
      has_more: Number(data.has_more || 0),
      msg_list: Array.isArray(data.msg_list)
        ? (data.msg_list as JsonRecord[])
        : [],
    };
  }

  async sendPreparedMessage({
    toUser,
    openKfId,
    payload,
    messageId = '',
  }: {
    toUser: string;
    openKfId: string;
    payload: JsonRecord;
    messageId?: string;
  }): Promise<JsonRecord> {
    if (!toUser || !openKfId) {
      throw new Error('toUser and openKfId are required');
    }
    const msgtype = String(payload?.msgtype || '');
    if (!SEND_MESSAGE_TYPES.has(msgtype) || !payload?.[msgtype]) {
      throw new Error('Prepared WeCom payload has an unsupported message type');
    }
    const exactPayload = structuredClone(payload);
    for (const forbidden of ['touser', 'open_kfid', 'msgid']) {
      if (Object.hasOwn(exactPayload, forbidden)) {
        throw new Error(`Prepared WeCom payload must not contain ${forbidden}`);
      }
    }
    return this.#postApi(
      '/cgi-bin/kf/send_msg',
      withClientMessageId(
        { touser: toUser, open_kfid: openKfId, ...exactPayload },
        messageId,
      ),
    );
  }

  async downloadMedia(
    mediaId: string,
  ): Promise<{ bytes: Buffer; contentType: string; filename: string }> {
    const value = String(mediaId || '');

    if (!value || value.length > MAX_MEDIA_ID_CHARACTERS) {
      throw new Error('mediaId must contain 1 to 512 characters');
    }

    return this.#downloadMedia(value);
  }

  async uploadMedia({
    type,
    bytes,
    filename,
    contentType,
  }: ImageMedia): Promise<JsonRecord & { media_id: string }> {
    const limit = MEDIA_LIMITS[type];

    if (!limit) {
      throw new Error(`Unsupported WeCom media type: ${type}`);
    }

    if (!Buffer.isBuffer(bytes) || bytes.length <= 5 || bytes.length > limit) {
      throw new Error(
        `WeCom ${type} media must contain 6 to ${limit} bytes`,
      );
    }

    return this.#uploadMedia({ type, bytes, filename, contentType });
  }

}
