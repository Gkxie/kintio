import assert from 'node:assert/strict';
import { test } from 'vitest';

import { IlinkMediaGateway } from '../../src/ilink/media-gateway.ts';
import { IlinkSecretBox } from '../../src/ilink/secret-box.ts';
import type { IlinkSqliteStore } from '../../src/ilink/sqlite-store.ts';

test('iLink media gateway decrypts only the bound locator and returns image bytes', async () => {
  const box = new IlinkSecretBox(Buffer.alloc(32, 31).toString('base64url'));
  const accountKey = `ia_${'a'.repeat(40)}` as const;
  const peerId = 'media-owner@im.wechat';
  const aesKey = Buffer.alloc(16, 7).toString('base64url');
  const sealedLocator = box.seal(JSON.stringify({
    downloadUrl:
      'https://novac2c.cdn.weixin.qq.com/c2c/download?encrypted_query_param=x',
    aesKey,
  }), {
    secretKind: 'media_locator', accountId: accountKey, peerId, generation: 9,
  });
  const downloaded: unknown[] = [];
  const gateway = new IlinkMediaGateway({
    store: {
      getInboundImageSecret(messageKey: string, position: number) {
        assert.equal(messageKey, 'im-media');
        assert.equal(position, 0);
        return {
          messageKey,
          position,
          accountKey,
          peerId,
          secretGeneration: 9,
          sealedLocator,
        };
      },
    } as unknown as IlinkSqliteStore,
    secretBox: box,
    async download(imageItem) {
      downloaded.push(structuredClone(imageItem));
      return { bytes: Buffer.from('89504e470d0a1a0a', 'hex'), contentType: 'image/png' };
    },
  });
  const result = await gateway.resolveReference({
    messageKey: 'im-media',
    mediaId: 'ilink:0',
  });
  assert.equal(result.contentType, 'image/png');
  assert.equal(downloaded.length, 1);
  assert.doesNotMatch(JSON.stringify(downloaded), /media-owner|ia_aaaa/u);
  await assert.rejects(
    () => gateway.resolveReference({ messageKey: 'im-media', mediaId: '../local' }),
    /Invalid iLink image reference/u,
  );
  const resolved = await gateway.resolveForCodex({
    providerMessageId: 'provider',
    messageKey: 'im-media',
    origin: 'customer',
    type: 'image',
    rawType: 'ilink_image',
    sentAt: 1,
    sync: { cursor: '', index: 0 },
    conversation: { channel: 'weixin_ilink', accountKey, peerId },
    text: '',
    summary: '[image]',
    attributes: {},
    attachments: [{ kind: 'image', mediaId: 'ilink:0' }],
  });
  assert.equal(resolved.length, 1);
  await assert.rejects(() => gateway.resolveForCodex({
    providerMessageId: 'provider-many',
    messageKey: 'im-media',
    origin: 'customer',
    type: 'image',
    rawType: 'ilink_image',
    sentAt: 1,
    sync: { cursor: '', index: 0 },
    conversation: { channel: 'weixin_ilink', accountKey, peerId },
    text: '',
    summary: '[images]',
    attributes: {},
    attachments: Array.from({ length: 5 }, (_, index) => ({
      kind: 'image' as const,
      mediaId: `ilink:${index}`,
    })),
  }), /Too many iLink images/u);
});

test('iLink media gateway fails closed for missing or malformed encrypted locators', async () => {
  const box = new IlinkSecretBox(Buffer.alloc(32, 17).toString('base64url'));
  const accountKey = `ia_${'b'.repeat(40)}` as const;
  const peerId = 'peer@im.wechat';
  const gateway = (plaintext?: string) => new IlinkMediaGateway({
    store: {
      getInboundImageSecret() {
        if (plaintext === undefined) return undefined;
        return {
          messageKey: 'im-x',
          position: 0,
          accountKey,
          peerId,
          secretGeneration: 3,
          sealedLocator: box.seal(plaintext, {
            secretKind: 'media_locator', accountId: accountKey, peerId, generation: 3,
          }),
        };
      },
    } as unknown as IlinkSqliteStore,
    secretBox: box,
    async download() {
      assert.fail('malformed locators must not download');
    },
  });
  for (const plaintext of [
    undefined,
    '{',
    '[]',
    JSON.stringify({ downloadUrl: 'https://example.com', aesKey: 'bad' }),
    JSON.stringify({ downloadUrl: 'https://example.com', aesKey: `${'A'.repeat(21)}B` }),
  ]) {
    await assert.rejects(
      () => gateway(plaintext).resolveReference({ messageKey: 'im-x', mediaId: 'ilink:0' }),
      /unavailable|invalid/u,
    );
  }
});
