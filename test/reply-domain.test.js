import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createLinkReply,
  createLocationReply,
  createMediaReply,
  createMiniProgramReply,
  createTextReply,
  parseCodexReply,
  replyToOutboundMessages,
} from '../src/domain/reply.js';

test('text replies split into WeCom-safe outbound messages', () => {
  const messages = replyToOutboundMessages(createTextReply('你好'));
  assert.deepEqual(messages, [{ type: 'text', content: '你好' }]);
});

test('Codex structured location replies are validated', () => {
  const reply = parseCodexReply(
    JSON.stringify({
      type: 'location',
      text: '',
      location: {
        name: '天安门',
        address: '北京市东城区',
        latitude: 39.9087,
        longitude: 116.3975,
      },
    }),
  );

  assert.deepEqual(replyToOutboundMessages(reply), [
    {
      type: 'location',
      location: {
        name: '天安门',
        address: '北京市东城区',
        latitude: 39.9087,
        longitude: 116.3975,
      },
    },
  ]);
  assert.throws(
    () => createLocationReply({ latitude: 91, longitude: 0 }),
    /latitude/,
  );
});

test('plain Codex responses remain compatible text replies', () => {
  assert.deepEqual(parseCodexReply('普通回复'), {
    type: 'text',
    text: '普通回复',
  });
});

test('public links become native WeChat link replies', () => {
  const reply = createLinkReply({
    title: '一喜日本料理',
    description: '北京市海淀区花园东路',
    url: 'https://maps.apple.com/place?place-id=example',
  });

  assert.deepEqual(replyToOutboundMessages(reply), [
    {
      type: 'link',
      link: {
        title: '一喜日本料理',
        description: '北京市海淀区花园东路',
        url: 'https://maps.apple.com/place?place-id=example',
      },
    },
  ]);
  assert.throws(
    () => createLinkReply({ title: '内网', url: 'http://127.0.0.1/test' }),
    /public HTTP/,
  );
});

test('verified mini programs become native WeChat deep-link replies', () => {
  const reply = createMiniProgramReply({
    appId: 'wx1234567890abcdef',
    title: '门店小程序',
    pagePath: 'pages/store/detail?id=123',
    sourceUrl: 'https://example.com/wechat-mini-program',
  });

  assert.deepEqual(replyToOutboundMessages(reply), [
    {
      type: 'miniprogram',
      miniprogram: {
        appId: 'wx1234567890abcdef',
        title: '门店小程序',
        pagePath: 'pages/store/detail?id=123',
        sourceUrl: 'https://example.com/wechat-mini-program',
      },
    },
  ]);
  assert.throws(
    () =>
      createMiniProgramReply({
        appId: 'guessed',
        title: '不可靠入口',
        pagePath: 'https://example.com/',
        sourceUrl: 'http://127.0.0.1/evidence',
      }),
    /(appId|public HTTP)/,
  );
});

test('an invalid structured reply is rejected in favor of its text fallback', () => {
  const reply = parseCodexReply(
    JSON.stringify({
      type: 'miniprogram',
      text: '暂时没有找到可核验的小程序入口。',
      miniprogram: {
        appId: 'guessed',
        title: '不可靠入口',
        pagePath: 'https://example.com/',
        sourceUrl: 'https://example.com/',
      },
    }),
  );

  assert.deepEqual(reply, {
    type: 'text',
    text: '暂时没有找到可核验的小程序入口。',
  });
});

test('a verified customer-media reference becomes a native media reply', () => {
  const reply = createMediaReply(
    'image',
    { reference: 'media:0', caption: '这是你刚才发送的原图：' },
    '暂时无法重新发送原图。',
  );
  const messages = replyToOutboundMessages(reply, {
    mediaCatalog: [
      {
        ref: 'media:0',
        kind: 'image',
        mediaId: 'inbound-image-id',
        filename: 'photo.png',
      },
    ],
  });

  assert.deepEqual(messages, [
    { type: 'text', content: '这是你刚才发送的原图：' },
    {
      type: 'image',
      media: {
        kind: 'image',
        sourceMediaId: 'inbound-image-id',
        filename: 'photo.png',
      },
      fallbackText: '暂时无法重新发送原图。',
    },
  ]);
});

test('unknown or mismatched media references safely fall back to text', () => {
  const reply = createMediaReply(
    'image',
    { reference: 'media:0', caption: '' },
    '没有找到你指定的图片，请重新发送。',
  );

  assert.deepEqual(
    replyToOutboundMessages(reply, {
      mediaCatalog: [
        { ref: 'media:0', kind: 'audio', mediaId: 'wrong-kind' },
      ],
    }),
    [{ type: 'text', content: '没有找到你指定的图片，请重新发送。' }],
  );
  assert.throws(
    () => createMediaReply('image', { reference: '/etc/passwd' }),
    /media:N/,
  );
});
