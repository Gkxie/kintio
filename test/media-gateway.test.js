import assert from 'node:assert/strict';
import test from 'node:test';

import {
  ATTACHMENT_KINDS,
  MESSAGE_ORIGINS,
  MESSAGE_TYPES,
  createDomainMessage,
} from '../src/domain/message.js';
import { WecomMediaGateway } from '../src/services/media-gateway.js';

test('media gateway resolves only image attachments for Codex', async () => {
  const downloads = [];
  const gateway = new WecomMediaGateway({
    apiClient: {
      async downloadMedia(mediaId) {
        downloads.push(mediaId);
        return { bytes: Buffer.from('image'), contentType: 'image/png' };
      },
    },
  });
  const message = createDomainMessage({
    id: 'media-message',
    origin: MESSAGE_ORIGINS.CUSTOMER,
    type: MESSAGE_TYPES.IMAGE,
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    attachments: [
      { kind: ATTACHMENT_KINDS.IMAGE, mediaId: 'image-one' },
      { kind: ATTACHMENT_KINDS.AUDIO, mediaId: 'voice-one' },
    ],
  });

  const resolved = await gateway.resolveForCodex(message);

  assert.deepEqual(downloads, ['image-one']);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0].kind, 'image');
});

test('card thumbnail upload is in-memory, shared, and cached', async () => {
  const uploads = [];
  const gateway = new WecomMediaGateway({
    apiClient: {
      async uploadMedia(media) {
        uploads.push(media);
        return { media_id: 'thumbnail-one' };
      },
    },
  });

  const first = await gateway.getCardThumbnailMediaId();
  const second = await gateway.getLinkThumbnailMediaId();

  assert.equal(first, 'thumbnail-one');
  assert.equal(second, 'thumbnail-one');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].type, 'image');
  assert.equal(uploads[0].contentType, 'image/png');
  assert.ok(Buffer.isBuffer(uploads[0].bytes));
});

test('inbound images are downloaded, re-uploaded, and cached for sending', async () => {
  const downloads = [];
  const uploads = [];
  const gateway = new WecomMediaGateway({
    apiClient: {
      async downloadMedia(mediaId) {
        downloads.push(mediaId);
        return {
          bytes: Buffer.from('image-bytes'),
          contentType: 'image/png',
          filename: 'customer-image.png',
        };
      },
      async uploadMedia(media) {
        uploads.push(media);
        return { media_id: 'outbound-image' };
      },
    },
  });

  const first = await gateway.cloneForSend({
    kind: ATTACHMENT_KINDS.IMAGE,
    sourceMediaId: 'inbound-image',
  });
  const second = await gateway.cloneForSend({
    kind: ATTACHMENT_KINDS.IMAGE,
    sourceMediaId: 'inbound-image',
  });

  assert.equal(first, 'outbound-image');
  assert.equal(second, 'outbound-image');
  assert.deepEqual(downloads, ['inbound-image']);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0].type, 'image');
  assert.equal(uploads[0].filename, 'customer-image.png');
});
