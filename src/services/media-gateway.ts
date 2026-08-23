import type { NormalizedMessage, ResolvedImage } from '../types.ts';

const DEFAULT_LINK_THUMBNAIL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlXcAAAAASUVORK5CYII=',
  'base64',
);
const LINK_THUMBNAIL_CACHE_MS = 60 * 60 * 1000;
const OUTBOUND_MEDIA_CACHE_MS = 60 * 60 * 1000;
const IMAGE_KIND = 'image';

interface MediaApi {
  downloadMedia(mediaId: string): Promise<{
    bytes: Buffer;
    contentType: string;
    filename?: string;
  }>;
  uploadMedia(input: {
    type: 'image';
    bytes: Buffer;
    filename: string;
    contentType: string;
  }): Promise<{ media_id: string }>;
}

function defaultFilename(kind: string, contentType: string): string {
  if (kind === IMAGE_KIND) {
    return contentType === 'image/jpeg' ? 'image.jpg' : 'image.png';
  }
  throw new Error(`Unsupported outbound attachment kind: ${kind}`);
}

export class WecomMediaGateway {
  readonly apiClient: MediaApi;
  private cardThumbnailCache: { mediaId: string; expiresAt: number } | null;
  private readonly outboundMediaCache: Map<
    string,
    { mediaId: string; expiresAt: number }
  >;

  constructor({ apiClient }: { apiClient: MediaApi }) {
    this.apiClient = apiClient;
    this.cardThumbnailCache = null;
    this.outboundMediaCache = new Map();
  }

  async resolveForCodex(message: NormalizedMessage): Promise<ResolvedImage[]> {
    const resolved: ResolvedImage[] = [];

    for (const attachment of message.attachments || []) {
      if (attachment.kind !== IMAGE_KIND) continue;

      const media = await this.apiClient.downloadMedia(attachment.mediaId);
      resolved.push({
        kind: IMAGE_KIND,
        bytes: media.bytes,
        contentType: media.contentType,
      });
    }

    return resolved;
  }

  async upload({
    kind,
    bytes,
    filename,
    contentType,
  }: {
    kind: string;
    bytes: Buffer;
    filename: string;
    contentType: string;
  }): Promise<{ media_id: string }> {
    if (kind !== IMAGE_KIND) {
      throw new Error(`Unsupported attachment kind: ${kind}`);
    }
    return this.apiClient.uploadMedia({
      type: 'image',
      bytes,
      filename,
      contentType,
    });
  }

  async cloneForSend({
    kind,
    sourceMediaId,
    filename = '',
  }: {
    kind: string;
    sourceMediaId: string;
    filename?: string;
  }): Promise<string> {
    const cacheKey = `${kind}:${sourceMediaId}`;
    const cached = this.outboundMediaCache.get(cacheKey);

    if (cached && cached.expiresAt > Date.now()) {
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

  async getCardThumbnailMediaId(): Promise<string> {
    const cached = this.cardThumbnailCache;
    if (cached && cached.expiresAt > Date.now()) {
      return cached.mediaId;
    }

    const result = await this.upload({
      kind: IMAGE_KIND,
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
}
