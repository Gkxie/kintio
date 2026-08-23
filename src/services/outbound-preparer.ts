import fs from 'node:fs/promises';
import path from 'node:path';

import { prepareSendBatch, type SendIntent } from '../domain/send-contract.ts';
import { truncateUtf8 } from '../lib/text.ts';
import type { MediaCatalogEntry, PreparedAttempt } from '../types.ts';
import type {
  AgentCandidate,
  GeneratedCandidate,
  StagedCandidate,
} from './codex-agent.ts';
import { MAX_WECHAT_IMAGE_BYTES, detectImageFormat } from './image-stager.ts';
import type { WecomMediaGateway } from './media-gateway.ts';

type Payload = Readonly<Record<string, unknown>>;

type MediaGateway = Pick<
  WecomMediaGateway,
  'upload' | 'cloneForSend' | 'getCardThumbnailMediaId'
>;

interface SpoolMetadata {
  readonly version: 1;
  readonly filename: string;
  readonly contentType: 'image/png' | 'image/jpeg';
  readonly generationId: string;
  readonly revisedPrompt: string;
  readonly data: string;
}

export interface PreparedBatch {
  readonly attempts: readonly PreparedAttempt[];
  readonly spoolPaths: readonly string[];
}

function exactPayload(message: SendIntent, mediaId = ''): Payload {
  switch (message.type) {
    case 'text':
      return { msgtype: 'text', text: { content: message.content } };
    case 'image':
      return { msgtype: 'image', image: { media_id: mediaId } };
    case 'link':
      return {
        msgtype: 'link',
        link: {
          title: message.title,
          desc: message.description,
          url: message.url,
          thumb_media_id: mediaId,
        },
      };
    case 'miniprogram':
      return {
        msgtype: 'miniprogram',
        miniprogram: {
          appid: message.appId,
          title: message.title,
          pagepath: message.pagePath,
          thumb_media_id: mediaId,
        },
      };
    case 'location':
      const { type, ...location } = message;
      return {
        msgtype: type,
        location,
      };
  }
}

function fallbackText(message: SendIntent): string {
  switch (message.type) {
    case 'link':
      return [message.title, message.description, message.url].filter(Boolean).join('\n');
    case 'miniprogram':
      return [message.title, message.sourceUrl].filter(Boolean).join('\n');
    case 'location':
      return [
        message.name,
        message.address,
        `坐标：${message.latitude}, ${message.longitude}`,
      ].filter(Boolean).join('\n');
    case 'image':
      return '暂时无法发送该图片，请重新发送后再试。';
    case 'text': {
      const compact = message.content
        .replace(/[\r\n]+\s*[•●▪*-]?\s*/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
      return truncateUtf8(compact, 300, '…');
    }
  }
}

function isSpoolMetadata(value: unknown): value is SpoolMetadata {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const item = value as Record<string, unknown>;
  return item.version === 1 &&
    typeof item.filename === 'string' &&
    (item.contentType === 'image/png' || item.contentType === 'image/jpeg') &&
    typeof item.generationId === 'string' &&
    typeof item.revisedPrompt === 'string' &&
    typeof item.data === 'string';
}

export class OutboundPreparer {
  readonly #media: MediaGateway;
  readonly #spool: string;

  constructor({ mediaGateway, spoolDirectory }: {
    readonly mediaGateway: MediaGateway;
    readonly spoolDirectory: string;
  }) {
    this.#media = mediaGateway;
    this.#spool = path.resolve(spoolDirectory);
  }

  async #uploadSpooled(
    bytes: Buffer,
    spoolMetadata: SpoolMetadata,
    spoolPaths: readonly string[],
  ): Promise<PreparedBatch> {
    let metadata: Readonly<Record<string, unknown>> = {
      generationId: spoolMetadata.generationId,
      revisedPrompt: spoolMetadata.revisedPrompt,
      byteLength: bytes.length,
    };
    let sentType = 'image';
    let payload: Payload;
    try {
      const uploaded = await this.#media.upload({
        kind: 'image',
        bytes,
        filename: spoolMetadata.filename,
        contentType: spoolMetadata.contentType,
      });
      payload = { msgtype: 'image', image: { media_id: uploaded.media_id } };
    } catch (error) {
      sentType = 'text';
      payload = {
        msgtype: 'text',
        text: { content: '图片已经生成，但暂时无法通过微信发送，请稍后再试。' },
      };
      metadata = {
        ...metadata,
        preparationError: error instanceof Error ? error.message : String(error),
      };
    }
    return {
      attempts: [{
        sendIndex: 0,
        sentType,
        payload,
        source: 'codex_image',
        metadata,
      }],
      spoolPaths,
    };
  }

  async #prepareGenerated(messageKey: string, candidate: GeneratedCandidate): Promise<PreparedBatch> {
    if (candidate.bytes.length < 6 || candidate.bytes.length > MAX_WECHAT_IMAGE_BYTES) {
      throw new Error('Generated image has an invalid size');
    }
    const format = detectImageFormat(candidate.bytes);
    if (!format || (format.mimeType !== 'image/png' && format.mimeType !== 'image/jpeg')) {
      throw new Error('Generated image must be PNG or JPEG');
    }
    await fs.mkdir(this.#spool, { recursive: true, mode: 0o700 });
    await fs.chmod(this.#spool, 0o700);
    if (!/^[A-Za-z0-9_-]+$/u.test(messageKey)) {
      throw new Error('Generated image message key is not spool-safe');
    }
    const spoolPath = path.join(this.#spool, `${messageKey}.json`);
    const metadata: SpoolMetadata = {
      version: 1,
      filename: candidate.filename || `generated${format.extension}`,
      contentType: format.mimeType,
      generationId: candidate.generationId,
      revisedPrompt: candidate.revisedPrompt,
      data: candidate.bytes.toString('base64'),
    };
    const temporary = `${spoolPath}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(metadata), {
      mode: 0o600,
      flag: 'wx',
    });
    try {
      await fs.rename(temporary, spoolPath);
    } catch (error) {
      await fs.rm(temporary, { force: true });
      throw error;
    }
    return this.#uploadSpooled(candidate.bytes, metadata, [spoolPath]);
  }

  async restoreGenerated(messageKey: string): Promise<PreparedBatch | undefined> {
    const metadataPath = path.join(this.#spool, `${messageKey}.json`);
    let metadata: SpoolMetadata;
    try {
      const file = await fs.lstat(metadataPath);
      if (!file.isFile() || file.isSymbolicLink()) {
        throw new Error('Generated image spool must be a regular file');
      }
      const parsed: unknown = JSON.parse(await fs.readFile(metadataPath, 'utf8'));
      if (!isSpoolMetadata(parsed)) {
        throw new Error('Generated image spool metadata is invalid');
      }
      metadata = parsed;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const bytes = Buffer.from(metadata.data, 'base64');
    const format = detectImageFormat(bytes);
    if (!format || format.mimeType !== metadata.contentType) {
      throw new Error('Generated image spool content does not match metadata');
    }
    return this.#uploadSpooled(bytes, metadata, [metadataPath]);
  }

  async prepare({ messageKey, candidates, mediaCatalog = [] }: {
    readonly messageKey: string;
    readonly candidates: readonly AgentCandidate[];
    readonly mediaCatalog?: readonly MediaCatalogEntry[];
  }): Promise<PreparedBatch> {
    if (candidates.length === 1 && candidates[0]?.type === 'generated_image') {
      return this.#prepareGenerated(messageKey, candidates[0] as GeneratedCandidate);
    }
    const messages = prepareSendBatch(candidates as readonly StagedCandidate[], {
      mediaCatalog: mediaCatalog.map(({ ref, kind }) => ({ ref, kind })),
      maxMessages: 5,
    });
    const attempts: PreparedAttempt[] = [];
    const fallbackIndexes: number[] = [];

    for (const [index, message] of messages.entries()) {
      try {
        let mediaId = '';
        if (message.type === 'image') {
          const source = mediaCatalog.find((item) => item.ref === message.mediaRef);
          if (!source) throw new Error('Customer image reference is unavailable');
          mediaId = await this.#media.cloneForSend({
            kind: 'image',
            sourceMediaId: source.mediaId,
            filename: source.filename,
          });
        } else if (message.type === 'link' || message.type === 'miniprogram') {
          mediaId = await this.#media.getCardThumbnailMediaId();
        }
        attempts.push({
          sendIndex: index,
          sentType: message.type,
          payload: exactPayload(message, mediaId),
        });
        if (
          message.type !== 'text' ||
          Buffer.byteLength(message.content, 'utf8') > 384
        ) fallbackIndexes.push(index);
      } catch (error) {
        const content = truncateUtf8(fallbackText(message), 2048);
        if (!content) throw error;
        attempts.push({
          sendIndex: index,
          sentType: 'text',
          payload: { msgtype: 'text', text: { content } },
        });
      }
    }

    for (const primaryIndex of fallbackIndexes) {
      if (attempts.length === 5) break;
      const message = messages[primaryIndex];
      if (!message) continue;
      const content = truncateUtf8(fallbackText(message), 2048);
      if (!content) continue;
      attempts.push({
        sendIndex: attempts.length,
        sentType: 'text',
        payload: { msgtype: 'text', text: { content } },
        fallbackForIndex: primaryIndex,
        status: 'blocked',
      });
    }
    return { attempts, spoolPaths: [] };
  }

  async cleanup(paths: readonly string[]): Promise<void> {
    for (const candidate of paths) {
      const resolved = path.resolve(candidate);
      if (resolved.startsWith(`${this.#spool}${path.sep}`)) {
        await fs.rm(resolved, { force: true }).catch(() => undefined);
      }
    }
  }

  async cleanupOrphans(activeMessageKeys: ReadonlySet<string> = new Set()): Promise<void> {
    let entries;
    try {
      entries = await fs.readdir(this.#spool, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    for (const entry of entries) {
      if (entry.isFile() && !activeMessageKeys.has(entry.name.split('.')[0] || '')) {
        await fs.rm(path.join(this.#spool, entry.name), { force: true })
          .catch(() => undefined);
      }
    }
  }
}
