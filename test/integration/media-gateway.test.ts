import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeWecomMessage } from '../../src/domain/wecom-message.ts';
import { WecomMediaGateway } from '../../src/services/media-gateway.ts';

type MediaApi = ConstructorParameters<typeof WecomMediaGateway>[0]['apiClient'];
type UploadInput = Parameters<MediaApi['uploadMedia']>[0];

function unusedDownload(): Promise<never> {
  return Promise.reject(new Error('downloadMedia was not expected'));
}

function unusedUpload(): Promise<never> {
  return Promise.reject(new Error('uploadMedia was not expected'));
}

test('[C04] media gateway resolves only image attachments for Codex', async () => {
  const downloads: string[] = [];
  const gateway = new WecomMediaGateway({
    apiClient: {
      async downloadMedia(mediaId: string) {
        downloads.push(mediaId);
        return { bytes: Buffer.from('image'), contentType: 'image/png' };
      },
      uploadMedia: unusedUpload,
    },
  });
  const imageMessage = normalizeWecomMessage({
    msgid: 'image-message',
    origin: 3,
    msgtype: 'image',
    image: { media_id: 'image-one' },
  });
  const voiceMessage = normalizeWecomMessage({
    msgid: 'voice-message',
    origin: 3,
    msgtype: 'voice',
    voice: { media_id: 'voice-one' },
  });

  const resolved = await gateway.resolveForCodex(imageMessage);
  assert.deepEqual(await gateway.resolveForCodex(voiceMessage), []);

  assert.deepEqual(downloads, ['image-one']);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0]?.kind, 'image');
});

test('card thumbnail upload is in-memory, shared, and cached', async () => {
  const uploads: UploadInput[] = [];
  const gateway = new WecomMediaGateway({
    apiClient: {
      downloadMedia: unusedDownload,
      async uploadMedia(media: UploadInput) {
        uploads.push(media);
        return { media_id: 'thumbnail-one' };
      },
    },
  });

  const first = await gateway.getCardThumbnailMediaId();
  const second = await gateway.getCardThumbnailMediaId();

  assert.equal(first, 'thumbnail-one');
  assert.equal(second, 'thumbnail-one');
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.type, 'image');
  assert.equal(uploads[0]?.contentType, 'image/png');
  assert.ok(Buffer.isBuffer(uploads[0]?.bytes));
});

test('inbound images are downloaded, re-uploaded, and cached for sending', async () => {
  const downloads: string[] = [];
  const uploads: UploadInput[] = [];
  const gateway = new WecomMediaGateway({
    apiClient: {
      async downloadMedia(mediaId: string) {
        downloads.push(mediaId);
        return {
          bytes: Buffer.from('image-bytes'),
          contentType: 'image/png',
          filename: 'customer-image.png',
        };
      },
      async uploadMedia(media: UploadInput) {
        uploads.push(media);
        return { media_id: 'outbound-image' };
      },
    },
  });

  const first = await gateway.cloneForSend({
    kind: 'image',
    sourceMediaId: 'inbound-image',
  });
  const second = await gateway.cloneForSend({
    kind: 'image',
    sourceMediaId: 'inbound-image',
  });

  assert.equal(first, 'outbound-image');
  assert.equal(second, 'outbound-image');
  assert.deepEqual(downloads, ['inbound-image']);
  assert.equal(uploads.length, 1);
  assert.equal(uploads[0]?.type, 'image');
  assert.equal(uploads[0]?.filename, 'customer-image.png');
});
