import { splitWecomText } from '../lib/text.js';

export const REPLY_TYPES = Object.freeze({
  TEXT: 'text',
  IMAGE: 'image',
  LOCATION: 'location',
  LINK: 'link',
  MINIPROGRAM: 'miniprogram',
});

export const MEDIA_REPLY_TYPES = Object.freeze([REPLY_TYPES.IMAGE]);

const MEDIA_KIND_BY_REPLY_TYPE = Object.freeze({
  [REPLY_TYPES.IMAGE]: 'image',
});

export const CODEX_REPLY_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    type: { type: 'string', enum: Object.values(REPLY_TYPES) },
    text: { type: 'string' },
    location: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        address: { type: 'string' },
        latitude: { type: 'number' },
        longitude: { type: 'number' },
      },
      required: ['name', 'address', 'latitude', 'longitude'],
      additionalProperties: false,
    },
    link: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        url: { type: 'string' },
      },
      required: ['title', 'description', 'url'],
      additionalProperties: false,
    },
    miniprogram: {
      type: 'object',
      properties: {
        appId: { type: 'string' },
        title: { type: 'string' },
        pagePath: { type: 'string' },
        sourceUrl: { type: 'string' },
      },
      required: ['appId', 'title', 'pagePath', 'sourceUrl'],
      additionalProperties: false,
    },
    media: {
      type: 'object',
      properties: {
        reference: { type: 'string' },
        caption: { type: 'string' },
      },
      required: ['reference', 'caption'],
      additionalProperties: false,
    },
  },
  required: [
    'type',
    'text',
    'location',
    'link',
    'miniprogram',
    'media',
  ],
  additionalProperties: false,
});

export function createTextReply(text) {
  const content = String(text || '').trim();
  if (!content) throw new Error('Text reply cannot be empty');
  return Object.freeze({ type: REPLY_TYPES.TEXT, text: content });
}

export function createLocationReply(location) {
  const latitude = Number(location?.latitude);
  const longitude = Number(location?.longitude);

  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    throw new Error('Location latitude must be between -90 and 90');
  }

  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new Error('Location longitude must be between -180 and 180');
  }

  return Object.freeze({
    type: REPLY_TYPES.LOCATION,
    location: Object.freeze({
      name: String(location?.name || ''),
      address: String(location?.address || ''),
      latitude,
      longitude,
    }),
  });
}

export function createMediaReply(type, media, fallbackText = '') {
  if (!MEDIA_REPLY_TYPES.includes(type)) {
    throw new Error(`Unsupported media reply type: ${type}`);
  }

  const reference = String(media?.reference || '').trim();

  if (!/^media:(?:0|[1-9]\d?)$/.test(reference)) {
    throw new Error('Media reply reference must use the media:N format');
  }

  return Object.freeze({
    type,
    media: Object.freeze({
      reference,
      caption: String(media?.caption || '').trim(),
    }),
    fallbackText: String(fallbackText || '').trim(),
  });
}

function isForbiddenLinkHost(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  if (
    normalized === 'localhost' ||
    normalized === '::1' ||
    normalized.endsWith('.localhost') ||
    normalized.endsWith('.local')
  ) {
    return true;
  }

  const parts = normalized.split('.').map(Number);

  if (parts.length === 4 && parts.every(Number.isInteger)) {
    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
    );
  }

  return normalized.startsWith('fc') || normalized.startsWith('fd');
}

function parsePublicHttpUrl(value, label) {
  let url;

  try {
    url = new URL(String(value || ''));
  } catch {
    throw new Error(`${label} requires a valid URL`);
  }

  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    isForbiddenLinkHost(url.hostname)
  ) {
    throw new Error(`${label} URL must be a public HTTP(S) URL`);
  }

  return url;
}

export function createLinkReply(link) {
  const url = parsePublicHttpUrl(link?.url, 'Link reply');

  const title = String(link?.title || '').trim();
  if (!title) throw new Error('Link reply title cannot be empty');

  return Object.freeze({
    type: REPLY_TYPES.LINK,
    link: Object.freeze({
      title,
      description: String(link?.description || '').trim(),
      url: url.toString(),
    }),
  });
}

export function createMiniProgramReply(miniprogram) {
  const appId = String(miniprogram?.appId || '').trim();
  const title = String(miniprogram?.title || '').trim();
  const pagePath = String(miniprogram?.pagePath || '').trim();
  const sourceUrl = parsePublicHttpUrl(
    miniprogram?.sourceUrl,
    'Mini program source',
  );

  if (!/^wx[A-Za-z0-9]{16}$/.test(appId)) {
    throw new Error('Mini program appId must use the wx + 16 character format');
  }

  if (!title) throw new Error('Mini program title cannot be empty');

  if (
    !pagePath ||
    pagePath.length > 1024 ||
    /^[a-z]+:\/\//i.test(pagePath) ||
    pagePath.includes('..')
  ) {
    throw new Error('Mini program pagePath is invalid');
  }

  return Object.freeze({
    type: REPLY_TYPES.MINIPROGRAM,
    miniprogram: Object.freeze({
      appId,
      title,
      pagePath,
      sourceUrl: sourceUrl.toString(),
    }),
  });
}

export function parseCodexReply(finalResponse) {
  let parsed;

  try {
    parsed = JSON.parse(String(finalResponse || ''));
  } catch {
    return createTextReply(finalResponse);
  }

  try {
    if (MEDIA_REPLY_TYPES.includes(parsed.type)) {
      return createMediaReply(parsed.type, parsed.media, parsed.text);
    }

    if (parsed.type === REPLY_TYPES.LOCATION) {
      return createLocationReply(parsed.location);
    }

    if (parsed.type === REPLY_TYPES.LINK) {
      return createLinkReply(parsed.link);
    }

    if (parsed.type === REPLY_TYPES.MINIPROGRAM) {
      return createMiniProgramReply(parsed.miniprogram);
    }

  } catch (error) {
    if (!String(parsed.text || '').trim()) throw error;
  }

  return createTextReply(parsed.text);
}

export function replyToOutboundMessages(reply, { mediaCatalog = [] } = {}) {
  if (MEDIA_REPLY_TYPES.includes(reply.type)) {
    const expectedKind = MEDIA_KIND_BY_REPLY_TYPE[reply.type];
    const selected = mediaCatalog.find(
      (item) =>
        item.ref === reply.media.reference && item.kind === expectedKind,
    );

    if (!selected?.mediaId) {
      const fallback =
        reply.fallbackText ||
        reply.media.caption ||
        '暂时无法取得你指定的媒体，请重新发送后再试。';
      return splitWecomText(fallback).map((content) => ({
        type: REPLY_TYPES.TEXT,
        content,
      }));
    }

    const captionMessages = reply.media.caption
      ? splitWecomText(reply.media.caption, 2048, 4).map((content) => ({
          type: REPLY_TYPES.TEXT,
          content,
        }))
      : [];

    return [
      ...captionMessages,
      {
        type: reply.type,
        media: {
          kind: selected.kind,
          sourceMediaId: selected.mediaId,
          filename: selected.filename || '',
        },
        fallbackText:
          reply.fallbackText || '暂时无法发送该媒体，请重新发送后再试。',
      },
    ];
  }

  if (reply.type === REPLY_TYPES.LOCATION) {
    return [{ type: REPLY_TYPES.LOCATION, location: { ...reply.location } }];
  }

  if (reply.type === REPLY_TYPES.LINK) {
    return [{ type: REPLY_TYPES.LINK, link: { ...reply.link } }];
  }

  if (reply.type === REPLY_TYPES.MINIPROGRAM) {
    return [
      {
        type: REPLY_TYPES.MINIPROGRAM,
        miniprogram: { ...reply.miniprogram },
      },
    ];
  }

  return splitWecomText(reply.text).map((content) => ({
    type: REPLY_TYPES.TEXT,
    content,
  }));
}
