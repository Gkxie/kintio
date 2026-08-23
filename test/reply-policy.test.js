import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MESSAGE_ORIGINS,
  MESSAGE_TYPES,
  createDomainMessage,
} from '../src/domain/message.js';
import {
  createLinkReply,
  createMiniProgramReply,
  createTextReply,
} from '../src/domain/reply.js';
import {
  needsNativeFormatRetry,
  preferredReplyType,
  renderNativeRetryPrompt,
  renderReplyPolicy,
} from '../src/domain/reply-policy.js';

function textMessage(text) {
  return createDomainMessage({
    id: 'message',
    origin: MESSAGE_ORIGINS.CUSTOMER,
    type: MESSAGE_TYPES.TEXT,
    openKfId: 'wk-one',
    externalUserId: 'wm-one',
    text,
  });
}

test('location intent prefers native WeChat location replies', () => {
  for (const text of [
    '把北平楼的位置发给我',
    '为什么不发我地址',
    '这家店怎么走',
    '给我一个导航',
  ]) {
    const message = textMessage(text);
    assert.equal(preferredReplyType(message), 'location');
    assert.equal(needsNativeFormatRetry(message, createTextReply('地址')), true);
    assert.equal(
      needsNativeFormatRetry(
        message,
        createLinkReply({ title: '地图', url: 'https://maps.example.com/' }),
      ),
      true,
    );
    assert.equal(
      needsNativeFormatRetry(
        message,
        createMiniProgramReply({
          appId: 'wx1234567890abcdef',
          title: '门店入口',
          pagePath: 'pages/store/index',
          sourceUrl: 'https://example.com/mini-program',
        }),
      ),
      false,
    );
    assert.match(renderReplyPolicy(message), /location 是首选/);
  }
});

test('explicit mini-program intent prefers a verified native deep link', () => {
  const message = textMessage('把这家店的小程序卡片发给我');
  const miniprogram = createMiniProgramReply({
    appId: 'wx1234567890abcdef',
    title: '门店入口',
    pagePath: 'pages/store/index',
    sourceUrl: 'https://example.com/mini-program',
  });

  assert.equal(preferredReplyType(message), 'miniprogram');
  assert.equal(needsNativeFormatRetry(message, createTextReply('没有')), true);
  assert.equal(needsNativeFormatRetry(message, miniprogram), false);
  assert.match(renderReplyPolicy(message), /结构化|小程序/u);
  assert.match(renderNativeRetryPrompt(message), /appId 与 pagePath/u);
});

test('ordinary questions keep text as the native fallback', () => {
  const message = textMessage('今天营业吗');
  assert.equal(preferredReplyType(message), 'text');
  assert.equal(needsNativeFormatRetry(message, createTextReply('营业')), false);
});

test('explicit resend intent prefers the matching remembered media type', () => {
  const message = textMessage('把刚才那张原图重新发给我');
  const catalog = [
    { ref: 'media:0', kind: 'image', messageId: 'previous-image' },
  ];

  assert.equal(preferredReplyType(message, catalog), 'image');
  assert.equal(
    needsNativeFormatRetry(message, createTextReply('好的'), catalog),
    true,
  );
  assert.match(renderReplyPolicy(message, catalog), /media.reference/);
  assert.match(renderNativeRetryPrompt(message, catalog), /image 原生媒体/);
});
