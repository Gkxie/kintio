import { ATTACHMENT_KINDS } from '../domain/message.js';

const DEFAULT_LINK_THUMBNAIL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXcAAAAASUVORK5CYII=',
  'base64',
);
const LINK_THUMBNAIL_CACHE_MS = 60 * 60 * 1000;
const OUTBOUND_MEDIA_CACHE_MS = 60 * 60 * 1000;

function defaultFilename(kind, contentType) {
  if (kind === ATTACHMENT_KINDS.IMAGE) {
    return contentType === 'image/jpeg' ? 'image.jpg' : 'image.png';
  }
  throw new Error(`Unsupported outbound attachment kind: ${kind}`);
}

export class WecomMediaGateway {
  constructor({ apiClient }) {
    this.apiClient = apiClient;
    this.cardThumbnailCache = null;
    this.outboundMediaCache = new Map();
  }

  async resolveForCodex(message) {
    const resolved = [];

    for (const attachment of message.attachments || []) {
      if (attachment.kind !== ATTACHMENT_KINDS.IMAGE) continue;

      const media = await this.apiClient.downloadMedia(attachment.mediaId);
      resolved.push({
        kind: ATTACHMENT_KINDS.IMAGE,
        bytes: media.bytes,
        contentType: media.contentType,
      });
    }

    return resolved;
  }

  async upload({ kind, bytes, filename, contentType }) {
    const typeMap = {
      [ATTACHMENT_KINDS.IMAGE]: 'image',
    };
    const type = typeMap[kind];

    if (!type) throw new Error(`Unsupported attachment kind: ${kind}`);
    return this.apiClient.uploadMedia({
      type,
      bytes,
      filename,
      contentType,
    });
  }

  async cloneForSend({ kind, sourceMediaId, filename = '' }) {
    const cacheKey = `${kind}:${sourceMediaId}`;
    const cached = this.outboundMediaCache.get(cacheKey);

    if (cached?.expiresAt > Date.now()) {
      return cached.mediaId;
    }

    const source = await this.apiClient.downloadMedia(sourceMediaId);
    const uploaded = await this.upload({
      kind,
      bytes: source.bytes,
      filename:
        filename ||
        source.filename ||
        defaultFilename(kind, source.contentType),
      contentType: source.contentType,
    });
    this.outboundMediaCache.set(cacheKey, {
      mediaId: uploaded.media_id,
      expiresAt: Date.now() + OUTBOUND_MEDIA_CACHE_MS,
    });

    return uploaded.media_id;
  }

  async getCardThumbnailMediaId() {
    if (this.cardThumbnailCache?.expiresAt > Date.now()) {
      return this.cardThumbnailCache.mediaId;
    }

    const result = await this.upload({
      kind: ATTACHMENT_KINDS.IMAGE,
      bytes: DEFAULT_LINK_THUMBNAIL,
      filename: 'link-thumbnail.png',
      contentType: 'image/png',
    });
    this.cardThumbnailCache = {
      mediaId: result.media_id,
      expiresAt: Date.now() + LINK_THUMBNAIL_CACHE_MS,
    };

    return this.cardThumbnailCache.mediaId;
  }

  async getLinkThumbnailMediaId() {
    return this.getCardThumbnailMediaId();
  }
}
