import { createHash } from 'node:crypto';

import {
  createLinkReply,
  createLocationReply,
  createMiniProgramReply,
} from '../domain/reply.js';
import { splitWecomText } from '../lib/text.js';
import { MAX_WECHAT_IMAGE_BYTES } from '../services/image-stager.js';

export class WecomSendToolError extends Error {
  constructor(message, { code = 'tool_error' } = {}) {
    super(message);
    this.name = 'WecomSendToolError';
    this.code = code;
  }
}

function receipt(result, sentType, status = 'accepted', fallbackId = '') {
  return {
    wecomMsgId: String(result?.msgid || fallbackId || ''),
    sentType,
    status,
  };
}

function stableHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export class WecomSendTools {
  constructor({
    apiClient,
    mediaGateway,
    conversation,
    mediaCatalog = [],
    mediaCatalogProvider,
    deferSends = false,
    maxSends = 5,
    idempotencyJournal,
    turnId = '',
  }) {
    if (!conversation?.openKfId || !conversation?.externalUserId) {
      throw new Error('A bound WeChat Customer Service conversation is required');
    }

    this.apiClient = apiClient;
    this.mediaGateway = mediaGateway;
    this.conversation = Object.freeze({ ...conversation });
    this.mediaCatalog = Object.freeze(
      mediaCatalog.map((item) => Object.freeze({ ...item })),
    );
    this.mediaCatalogProvider = mediaCatalogProvider;
    this.deferSends = Boolean(deferSends);
    this.maxSends = Math.max(1, Math.min(Number(maxSends) || 5, 5));
    this.idempotencyJournal = idempotencyJournal;
    this.turnId = String(turnId || '');
    this.usedSends = 0;
  }

  get remainingSends() {
    return this.maxSends - this.usedSends;
  }

  close() {
    this.idempotencyJournal?.close?.();
  }

  #reserve(count) {
    if (!Number.isInteger(count) || count < 1) {
      throw new WecomSendToolError('Invalid send count', {
        code: 'invalid_send_count',
      });
    }

    if (this.usedSends + count > this.maxSends) {
      throw new WecomSendToolError(
        `This customer turn allows at most ${this.maxSends} messages`,
        { code: 'send_budget_exceeded' },
      );
    }

    const startIndex = this.usedSends;
    this.usedSends += count;
    return startIndex;
  }

  #target(messageId = '') {
    const target = {
      toUser: this.conversation.externalUserId,
      openKfId: this.conversation.openKfId,
    };
    if (messageId) target.messageId = messageId;
    return target;
  }

  #clientMessageId(index) {
    if (!this.turnId) return '';
    return `wb_${stableHash(`${this.turnId}:${index}`).slice(0, 29)}`;
  }

  async #sendOnce(index, sentType, payload, action) {
    const clientMessageId = this.#clientMessageId(index);
    const key = `${this.turnId}:${index}`;
    const fingerprint = stableHash(
      JSON.stringify({ sentType, payload }),
    );

    if (this.deferSends) {
      return receipt(null, sentType, 'staged', clientMessageId);
    }

    if (!this.idempotencyJournal || !this.turnId) {
      const result = await action(clientMessageId);
      return receipt(result, sentType, 'accepted', clientMessageId);
    }

    const begun = await this.idempotencyJournal.begin({
      key,
      fingerprint,
      sentType,
      clientMessageId,
    });

    if (begun.duplicate) {
      const existing = begun.entry;

      if (existing.status === 'failed') {
        throw new WecomSendToolError(
          existing.errorMessage || 'A previous send attempt was rejected',
          { code: existing.errorCode || 'previous_send_failed' },
        );
      }

      const status =
        existing.status === 'accepted' ? 'accepted' : 'uncertain';
      return receipt(
        { msgid: existing.wecomMsgId },
        existing.sentType || sentType,
        status,
        existing.clientMessageId,
      );
    }

    try {
      const result = await action(clientMessageId);
      const accepted = receipt(
        result,
        sentType,
        'accepted',
        clientMessageId,
      );
      await this.idempotencyJournal.complete(key, accepted);
      return accepted;
    } catch (error) {
      if (Number.isFinite(Number(error?.code))) {
        await this.idempotencyJournal.markFailed(key, error);
        throw error;
      }

      const uncertain = await this.idempotencyJournal.markUncertain(key, error);
      return receipt(
        null,
        uncertain.sentType || sentType,
        'uncertain',
        uncertain.clientMessageId,
      );
    }
  }

  async sendText({ content }) {
    const chunks = splitWecomText(content);
    if (!chunks.length) {
      throw new WecomSendToolError('Text content cannot be empty', {
        code: 'invalid_text',
      });
    }

    const startIndex = this.#reserve(chunks.length);
    const receipts = [];

    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index];
      receipts.push(
        await this.#sendOnce(
          startIndex + index,
          'text',
          { content: chunk },
          (messageId) =>
            this.apiClient.sendTextMessage({
              ...this.#target(messageId),
              content: chunk,
            }),
        ),
      );
    }

    return {
      receipts,
      remainingSends: this.remainingSends,
      deferred: this.deferSends,
    };
  }

  async sendLocation(location) {
    const validated = createLocationReply(location).location;
    const index = this.#reserve(1);
    const result = await this.#sendOnce(
      index,
      'location',
      validated,
      (messageId) =>
        this.apiClient.sendLocationMessage({
          ...this.#target(messageId),
          location: validated,
        }),
    );
    return {
      receipts: [result],
      remainingSends: this.remainingSends,
      deferred: this.deferSends,
    };
  }

  async sendLink(link) {
    const validated = createLinkReply(link).link;
    const index = this.#reserve(1);
    const result = await this.#sendOnce(
      index,
      'link',
      validated,
      async (messageId) => {
        const thumbnailMediaId =
          await this.mediaGateway.getCardThumbnailMediaId();
        return this.apiClient.sendLinkMessage({
          ...this.#target(messageId),
          link: validated,
          thumbnailMediaId,
        });
      },
    );
    return {
      receipts: [result],
      remainingSends: this.remainingSends,
      deferred: this.deferSends,
    };
  }

  async sendMiniProgram(miniprogram) {
    const validated = createMiniProgramReply(miniprogram).miniprogram;
    const index = this.#reserve(1);
    const result = await this.#sendOnce(
      index,
      'miniprogram',
      validated,
      async (messageId) => {
        const thumbnailMediaId =
          await this.mediaGateway.getCardThumbnailMediaId();
        return this.apiClient.sendMiniProgramMessage({
          ...this.#target(messageId),
          miniprogram: validated,
          thumbnailMediaId,
        });
      },
    );
    return {
      receipts: [result],
      remainingSends: this.remainingSends,
      deferred: this.deferSends,
    };
  }

  async sendImage({ mediaRef }) {
    const mediaCatalog = this.mediaCatalogProvider
      ? await this.mediaCatalogProvider()
      : this.mediaCatalog;
    const selected = mediaCatalog.find(
      (item) => item.ref === mediaRef && item.kind === 'image',
    );

    if (!selected?.mediaId) {
      throw new WecomSendToolError(
        'The media reference is unavailable or has the wrong type',
        { code: 'invalid_media_reference' },
      );
    }

    const index = this.#reserve(1);
    const result = await this.#sendOnce(
      index,
      'image',
      { mediaRef, kind: selected.kind },
      async (messageId) => {
        const mediaId = await this.mediaGateway.cloneForSend({
          kind: selected.kind,
          sourceMediaId: selected.mediaId,
          filename: selected.filename || '',
        });
        return this.apiClient.sendMediaMessage({
          ...this.#target(messageId),
          type: 'image',
          mediaId,
        });
      },
    );
    return {
      receipts: [result],
      remainingSends: this.remainingSends,
      deferred: this.deferSends,
    };
  }

  async sendGeneratedImage({
    bytes,
    filename = 'generated.png',
    contentType = 'image/png',
  }) {
    if (
      !Buffer.isBuffer(bytes) ||
      bytes.length <= 5 ||
      bytes.length > MAX_WECHAT_IMAGE_BYTES
    ) {
      throw new WecomSendToolError(
        `Generated image must contain 6 to ${MAX_WECHAT_IMAGE_BYTES} bytes`,
        { code: 'invalid_generated_image' },
      );
    }
    if (!['image/png', 'image/jpeg'].includes(contentType)) {
      throw new WecomSendToolError('Generated image must be PNG or JPEG', {
        code: 'invalid_generated_image',
      });
    }

    const index = this.#reserve(1);
    const result = await this.#sendOnce(
      index,
      'image',
      {
        sha256: stableHash(bytes),
        filename,
        contentType,
      },
      async (messageId) => {
        const uploaded = await this.mediaGateway.upload({
          kind: 'image',
          bytes,
          filename,
          contentType,
        });
        return this.apiClient.sendMediaMessage({
          ...this.#target(messageId),
          type: 'image',
          mediaId: uploaded.media_id,
        });
      },
    );
    return {
      receipts: [result],
      remainingSends: this.remainingSends,
      deferred: this.deferSends,
    };
  }
}
