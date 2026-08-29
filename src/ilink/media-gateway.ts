import type { NormalizedMessage, ResolvedImage } from '../types.ts';
import {
  downloadIlinkInboundImage,
  type ResolvedIlinkInboundImage,
} from './inbound-image.ts';
import { IlinkSecretBox } from './secret-box.ts';
import { IlinkSqliteStore } from './sqlite-store.ts';

type DownloadImage = (imageItem: unknown) => Promise<ResolvedIlinkInboundImage>;
const MAX_IMAGES_PER_TURN = 4;
const MAX_AGGREGATE_IMAGE_BYTES = 8 * 1024 * 1024;

function imagePosition(mediaId: string): number {
  const match = /^ilink:(0|[1-9]\d?)$/u.exec(mediaId);
  if (!match) throw new Error('Invalid iLink image reference');
  return Number(match[1]);
}

export class IlinkMediaGateway {
  readonly #store: IlinkSqliteStore;
  readonly #secrets: IlinkSecretBox;
  readonly #download: DownloadImage;

  constructor({
    store,
    secretBox,
    download = (imageItem) => downloadIlinkInboundImage(imageItem),
  }: {
    store: IlinkSqliteStore;
    secretBox: IlinkSecretBox;
    download?: DownloadImage;
  }) {
    this.#store = store;
    this.#secrets = secretBox;
    this.#download = download;
  }

  async resolveReference({
    messageKey,
    mediaId,
  }: {
    messageKey: string;
    mediaId: string;
  }): Promise<ResolvedImage> {
    const stored = this.#store.getInboundImageSecret(
      messageKey,
      imagePosition(mediaId),
    );
    if (!stored) throw new Error('iLink image reference is unavailable');
    const plaintext = this.#secrets.open(stored.sealedLocator, {
      secretKind: 'media_locator',
      accountId: stored.accountKey,
      peerId: stored.peerId,
      generation: stored.secretGeneration,
    });
    let locator: unknown;
    try {
      locator = JSON.parse(plaintext);
    } catch {
      throw new Error('iLink image locator is invalid');
    }
    if (!locator || typeof locator !== 'object' || Array.isArray(locator)) {
      throw new Error('iLink image locator is invalid');
    }
    const { downloadUrl, aesKey } = locator as Record<string, unknown>;
    if (
      typeof downloadUrl !== 'string' || typeof aesKey !== 'string' ||
      !/^[A-Za-z0-9_-]{22}$/u.test(aesKey)
    ) {
      throw new Error('iLink image locator is invalid');
    }
    const key = Buffer.from(aesKey, 'base64url');
    if (key.length !== 16 || key.toString('base64url') !== aesKey) {
      key.fill(0);
      throw new Error('iLink image locator is invalid');
    }
    try {
      const resolved = await this.#download({
        media: {
          full_url: downloadUrl,
          aes_key: key.toString('base64'),
        },
      });
      return { kind: 'image', ...resolved };
    } finally {
      key.fill(0);
    }
  }

  async resolveForCodex(
    message: NormalizedMessage & { readonly messageKey: string },
  ): Promise<readonly ResolvedImage[]> {
    if (message.attachments.length > MAX_IMAGES_PER_TURN) {
      throw new Error('Too many iLink images in one turn');
    }
    const resolved: ResolvedImage[] = [];
    let total = 0;
    for (const attachment of message.attachments) {
      const image = await this.resolveReference({
        messageKey: message.messageKey,
        mediaId: attachment.mediaId,
      });
      total += image.bytes.length;
      if (total > MAX_AGGREGATE_IMAGE_BYTES) {
        throw new Error('iLink image aggregate exceeds the turn limit');
      }
      resolved.push(image);
    }
    return resolved;
  }
}
