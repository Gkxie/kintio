import assert from 'node:assert/strict';
import { test } from 'vitest';

import {
  SEND_TOOL_NAMES,
  SendContractError,
  normalizeMediaCatalog,
  normalizeSendIntent,
} from '../../src/domain/send-contract.ts';

const mediaCatalog = Object.freeze([{ ref: 'media:0', kind: 'image' }]);

function hasContractCode(error: unknown, code: string): boolean {
  return error instanceof SendContractError && error.code === code;
}

test('validates only the five supported outbound message types', () => {
  const candidates = [
    normalizeSendIntent('send_text', { content: '你好' }),
    normalizeSendIntent(
      'send_image',
      { mediaRef: 'media:0' },
      { mediaCatalog },
    ),
    normalizeSendIntent('send_link', {
      title: '帮助中心',
      description: '使用说明',
      url: 'https://example.com/help',
    }),
    normalizeSendIntent('send_miniprogram', {
      appId: 'wx1234567890abcdef',
      title: '服务入口',
      pagePath: 'pages/index',
      sourceUrl: 'https://example.com/miniprogram',
    }),
    normalizeSendIntent('send_location', {
      name: '天安门',
      address: '北京市东城区',
      latitude: 39.9087,
      longitude: 116.3975,
    }),
  ];

  assert.deepEqual(
    candidates.map((candidate) => candidate.type),
    ['text', 'image', 'link', 'miniprogram', 'location'],
  );
  assert.deepEqual(SEND_TOOL_NAMES, [
    'send_text',
    'send_image',
    'send_link',
    'send_miniprogram',
    'send_location',
  ]);
  assert.throws(
    () => normalizeSendIntent('send_video', {}),
    (error) =>
      error instanceof SendContractError &&
      error.code === 'unsupported_send_type',
  );
});

test('media catalog contains only media:N image capabilities', () => {
  assert.deepEqual(normalizeMediaCatalog(mediaCatalog), mediaCatalog);
  for (const unsafe of [
    { ref: 'media:0', kind: 'image', mediaId: 'secret-media-id' },
    { ref: 'media:0', kind: 'image', path: '/tmp/customer.png' },
    { ref: 'media:0', kind: 'image', externalUserId: 'wm-secret' },
  ]) {
    assert.throws(
      () => normalizeMediaCatalog([unsafe]),
      (error: unknown) => hasContractCode(error, 'unsafe_media_catalog'),
    );
  }
  assert.throws(
    () =>
      normalizeSendIntent(
        'send_image',
        { mediaRef: 'media:1' },
        { mediaCatalog },
      ),
    (error: unknown) => hasContractCode(error, 'invalid_media_reference'),
  );
});

test('rejects private destinations and guessed mini-program fields', () => {
  for (const url of [
    'http://127.0.0.1/private',
    'http://2130706433/private',
    'http://10.0.0.1/private',
    'http://[::1]/private',
    'http://[::ffff:7f00:1]/private',
    'http://service.local/private',
  ]) {
    assert.throws(
      () =>
        normalizeSendIntent('send_link', {
          title: '内网',
          description: '',
          url,
        }),
      /public HTTP/u,
    );
  }
  assert.throws(
    () =>
      normalizeSendIntent('send_miniprogram', {
        appId: 'guessed',
        title: '入口',
        pagePath: 'https://example.com',
        sourceUrl: 'https://example.com',
      }),
    /appId/u,
  );
  assert.throws(
    () =>
      normalizeSendIntent('send_miniprogram', {
        appId: 'wx1234567890abcdef',
        title: '入口',
        pagePath: 'https://example.com/pages/index',
        sourceUrl: 'https://example.com',
      }),
    /pagePath/u,
  );
  assert.throws(
    () =>
      normalizeSendIntent('send_miniprogram', {
        appId: 'wx1234567890abcdef',
        title: '入口',
        pagePath: 'pages/index',
        sourceUrl: 'http://127.0.0.1/internal-proof',
      }),
    /source URL/u,
  );
});

test('one MCP text execution enforces the official 2048-byte boundary', () => {
  assert.doesNotThrow(() =>
    normalizeSendIntent('send_text', { content: 'a'.repeat(2048) }));
  assert.throws(
    () => normalizeSendIntent('send_text', { content: 'a'.repeat(2049) }),
    /2048 UTF-8 bytes/u,
  );
});

test('send validation is pure and does not add recipients or mutate input', () => {
  const input = {
    title: '帮助',
    description: '说明',
    url: 'https://example.com/help',
  };
  const before = structuredClone(input);
  const candidate = normalizeSendIntent('send_link', input);

  assert.deepEqual(input, before);
  assert.deepEqual(candidate, {
    type: 'link',
    title: '帮助',
    description: '说明',
    url: 'https://example.com/help',
  });
  assert.equal('openKfId' in candidate, false);
  assert.equal('externalUserId' in candidate, false);
  assert.equal('toUser' in candidate, false);
});
