import crypto from 'node:crypto';

import { truncateUtf8 } from '../lib/text.js';

const DEFAULT_BASE_URL = 'https://qyapi.weixin.qq.com';
const INVALID_ACCESS_TOKEN_CODES = new Set([40014, 42001]);
const MAX_MEDIA_ID_CHARACTERS = 512;
const MEDIA_LIMITS = Object.freeze({
  image: 2 * 1024 * 1024,
});

function optionalClientMessageId(messageId) {
  const value = String(messageId || '');
  if (!value) return '';

  if (value.length > 32 || !/^[0-9A-Za-z_-]+$/.test(value)) {
    throw new Error(
      'WeCom client messageId must use 1 to 32 letters, digits, underscores, or hyphens',
    );
  }

  return value;
}

function withClientMessageId(body, messageId) {
  const value = optionalClientMessageId(messageId);
  return value ? { ...body, msgid: value } : body;
}

function safeFilename(filename) {
  return String(filename || 'media.bin')
    .replace(/[\r\n"\\/]/g, '_')
    .slice(0, 128);
}

function responseFilename(contentDisposition) {
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

function createMultipartBody({ bytes, filename, contentType }) {
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

export class WecomApiError extends Error {
  constructor(message, { code, data } = {}) {
    super(message);
    this.name = 'WecomApiError';
    this.code = code;
    this.data = data;
  }
}

export class WecomApiClient {
  constructor({
    corpId,
    kfSecret,
    fetchImpl = globalThis.fetch,
    baseUrl = DEFAULT_BASE_URL,
    timeoutMs = 10_000,
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
    this.tokenCache = null;
    this.pendingTokenRequest = null;
  }

  clearAccessToken() {
    this.tokenCache = null;
  }

  async getAccessToken() {
    if (this.tokenCache?.expiresAt > Date.now()) {
      return this.tokenCache.value;
    }

    if (this.pendingTokenRequest) {
      return this.pendingTokenRequest;
    }

    this.pendingTokenRequest = this.#requestAccessToken().finally(() => {
      this.pendingTokenRequest = null;
    });

    return this.pendingTokenRequest;
  }

  async #requestAccessToken() {
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
      value: data.access_token,
      expiresAt: Date.now() + expiresIn * 1000,
    };

    return this.tokenCache.value;
  }

  async #fetchJson(url, options, operation) {
    let response;

    try {
      response = await this.fetch(url, {
        ...options,
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      throw new WecomApiError(`${operation} request failed: ${error.message}`);
    }

    const responseText = await response.text();
    let data;

    try {
      data = JSON.parse(responseText);
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

  async #postApi(path, body, retryAccessToken = true) {
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

  async #downloadMedia(mediaId, retryAccessToken = true) {
    const accessToken = await this.getAccessToken();
    const query = new URLSearchParams({
      access_token: accessToken,
      media_id: mediaId,
    });
    let response;

    try {
      response = await this.fetch(
        `${this.baseUrl}/cgi-bin/media/get?${query}`,
        { method: 'GET', signal: AbortSignal.timeout(this.timeoutMs) },
      );
    } catch (error) {
      throw new WecomApiError(`media/get request failed: ${error.message}`);
    }

    const contentType = String(response.headers.get('content-type') || '')
      .split(';')[0]
      .trim()
      .toLowerCase();

    if (contentType === 'application/json' || contentType === 'text/json') {
      const data = await response.json();
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
      bytes: Buffer.from(await response.arrayBuffer()),
      contentType,
      filename: responseFilename(
        response.headers.get('content-disposition'),
      ),
    };
  }

  async #uploadMedia(
    { type, bytes, filename, contentType },
    retryAccessToken = true,
  ) {
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

    return data;
  }

  async syncMessages({
    cursor,
    callbackToken,
    openKfId,
    limit = 1000,
    voiceFormat = 0,
  }) {
    const body = { limit, voice_format: voiceFormat };

    if (cursor) body.cursor = cursor;
    if (callbackToken) body.token = callbackToken;
    if (openKfId) body.open_kfid = openKfId;

    const data = await this.#postApi('/cgi-bin/kf/sync_msg', body);

    return {
      ...data,
      has_more: Number(data.has_more || 0),
      msg_list: Array.isArray(data.msg_list) ? data.msg_list : [],
    };
  }

  async sendTextMessage({ toUser, openKfId, content, messageId = '' }) {
    if (!toUser || !openKfId) {
      throw new Error('toUser and openKfId are required');
    }

    if (!content || Buffer.byteLength(content, 'utf8') > 2048) {
      throw new Error('WeCom text content must contain 1 to 2048 UTF-8 bytes');
    }

    return this.#postApi(
      '/cgi-bin/kf/send_msg',
      withClientMessageId(
        {
          touser: toUser,
          open_kfid: openKfId,
          msgtype: 'text',
          text: { content },
        },
        messageId,
      ),
    );
  }

  async downloadMedia(mediaId) {
    const value = String(mediaId || '');

    if (!value || value.length > MAX_MEDIA_ID_CHARACTERS) {
      throw new Error('mediaId must contain 1 to 512 characters');
    }

    return this.#downloadMedia(value);
  }

  async uploadMedia({ type, bytes, filename, contentType }) {
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

  async sendMediaMessage({
    toUser,
    openKfId,
    type,
    mediaId,
    messageId = '',
  }) {
    if (!toUser || !openKfId || !MEDIA_LIMITS[type]) {
      throw new Error('toUser, openKfId, and a supported media type are required');
    }

    return this.#postApi(
      '/cgi-bin/kf/send_msg',
      withClientMessageId(
        {
          touser: toUser,
          open_kfid: openKfId,
          msgtype: type,
          [type]: { media_id: mediaId },
        },
        messageId,
      ),
    );
  }

  async sendLocationMessage({
    toUser,
    openKfId,
    location,
    messageId = '',
  }) {
    const latitude = Number(location?.latitude);
    const longitude = Number(location?.longitude);

    if (!toUser || !openKfId) {
      throw new Error('toUser and openKfId are required');
    }

    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new Error('Location latitude must be between -90 and 90');
    }

    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error('Location longitude must be between -180 and 180');
    }

    return this.#postApi(
      '/cgi-bin/kf/send_msg',
      withClientMessageId(
        {
          touser: toUser,
          open_kfid: openKfId,
          msgtype: 'location',
          location: {
            name: String(location?.name || ''),
            address: String(location?.address || ''),
            latitude,
            longitude,
          },
        },
        messageId,
      ),
    );
  }

  async sendLinkMessage({
    toUser,
    openKfId,
    link,
    thumbnailMediaId,
    messageId = '',
  }) {
    if (!toUser || !openKfId || !thumbnailMediaId) {
      throw new Error('toUser, openKfId, and thumbnailMediaId are required');
    }

    const url = String(link?.url || '');

    if (!/^https?:\/\//i.test(url) || Buffer.byteLength(url) > 2048) {
      throw new Error('Link URL must be an HTTP(S) URL up to 2048 bytes');
    }

    return this.#postApi(
      '/cgi-bin/kf/send_msg',
      withClientMessageId(
        {
          touser: toUser,
          open_kfid: openKfId,
          msgtype: 'link',
          link: {
            title: truncateUtf8(String(link?.title || ''), 128),
            desc: truncateUtf8(String(link?.description || ''), 512),
            url,
            thumb_media_id: thumbnailMediaId,
          },
        },
        messageId,
      ),
    );
  }

  async sendMiniProgramMessage({
    toUser,
    openKfId,
    miniprogram,
    thumbnailMediaId,
    messageId = '',
  }) {
    if (!toUser || !openKfId || !thumbnailMediaId) {
      throw new Error('toUser, openKfId, and thumbnailMediaId are required');
    }

    const appId = String(miniprogram?.appId || '').trim();
    const pagePath = String(miniprogram?.pagePath || '').trim();

    if (!/^wx[A-Za-z0-9]{16}$/.test(appId)) {
      throw new Error('Mini program appId must use the wx + 16 character format');
    }

    if (
      !pagePath ||
      Buffer.byteLength(pagePath, 'utf8') > 1024 ||
      /^[a-z]+:\/\//i.test(pagePath) ||
      pagePath.includes('..')
    ) {
      throw new Error('Mini program pagePath is invalid');
    }

    return this.#postApi(
      '/cgi-bin/kf/send_msg',
      withClientMessageId(
        {
          touser: toUser,
          open_kfid: openKfId,
          msgtype: 'miniprogram',
          miniprogram: {
            appid: appId,
            title: truncateUtf8(String(miniprogram?.title || ''), 64),
            thumb_media_id: thumbnailMediaId,
            pagepath: pagePath,
          },
        },
        messageId,
      ),
    );
  }

}
