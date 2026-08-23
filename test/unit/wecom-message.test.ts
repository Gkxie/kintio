import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CUSTOMER_MESSAGE_TYPES,
  MESSAGE_ORIGINS,
  MESSAGE_TYPES,
  isSupportedCustomerMessage,
  normalizeWecomMessage,
  renderMessageForCodex,
} from '../../src/domain/wecom-message.ts';

type FixturePayload = Record<string, unknown>;
type MessageFixture = readonly [msgtype: string, payload: FixturePayload];

const base = Object.freeze({
  msgid: 'message-one',
  open_kfid: 'wk-one',
  external_userid: 'wm-one',
  origin: 3,
  send_time: 123,
});

const fixtures: readonly MessageFixture[] = [
  ['text', { text: { content: '你好', menu_id: 'menu-one' } }],
  ['image', { image: { media_id: 'image-secret' } }],
  ['voice', { voice: { media_id: 'voice-secret' } }],
  ['video', { video: { media_id: 'video-secret' } }],
  [
    'file',
    {
      file: {
        media_id: 'file-secret',
        filename: '合同.pdf',
        file_size: 2048,
      },
    },
  ],
  [
    'location',
    {
      location: {
        name: '天安门',
        address: '北京市东城区',
        latitude: 39.9087,
        longitude: 116.3975,
      },
    },
  ],
  [
    'link',
    {
      link: {
        title: '博主主页',
        desc: '主要分享 AI 开发',
        url: 'https://example.com/creator',
      },
    },
  ],
  ['business_card', { business_card: { userid: 'contact-secret' } }],
  [
    'miniprogram',
    {
      miniprogram: {
        title: '服务入口',
        appid: 'wx1234567890abcdef',
        pagepath: 'pages/index',
      },
    },
  ],
  [
    'msgmenu',
    {
      msgmenu: {
        head_content: '请选择',
        list: [
          { type: 'click', click: { id: 'one', content: '售后服务' } },
        ],
        tail_content: '点击继续',
      },
    },
  ],
  [
    'channels_shop_product',
    {
      channels_shop_product: {
        product_id: 'product-one',
        title: '商品甲',
        sales_price: '1999',
        shop_nickname: '店铺甲',
      },
    },
  ],
  [
    'channels_shop_order',
    {
      channels_shop_order: {
        order_id: 'order-one',
        product_titles: '商品甲',
        price_wording: '19.99元',
        state: '已支付',
        shop_nickname: '店铺甲',
      },
    },
  ],
  [
    'merged_msg',
    {
      merged_msg: {
        title: '记录',
        item: [
          {
            send_time: 124,
            msgtype: 'text',
            sender_name: '客户',
            msg_content: JSON.stringify({
              msgtype: 'text',
              text: { content: '关键正文' },
            }),
          },
        ],
      },
    },
  ],
  ['channels', { channels: { sub_type: 1, nickname: '视频号甲', title: '动态' } }],
  ['note', {}],
];

test('[C03] normalizes every known customer type with stable sync metadata', () => {
  assert.equal(fixtures.length, CUSTOMER_MESSAGE_TYPES.length);
  for (const [index, [msgtype, payload]] of fixtures.entries()) {
    const message = normalizeWecomMessage(
      { ...base, msgtype, ...payload },
      '',
      { cursor: 'cursor-one', index },
    );

    assert.equal(message.type, msgtype);
    assert.equal(message.origin, MESSAGE_ORIGINS.CUSTOMER);
    assert.equal(message.conversation.openKfId, 'wk-one');
    assert.equal(message.conversation.externalUserId, 'wm-one');
    assert.deepEqual(message.sync, { cursor: 'cursor-one', index });
    assert.ok(renderMessageForCodex(message).length > 0, msgtype);
    assert.equal(isSupportedCustomerMessage(message), true);
  }
});

test('preserves exact customer text for authorization while rendering a clean summary', () => {
  const message = normalizeWecomMessage({
    ...base,
    msgtype: 'text',
    text: { content: '发车 ' },
  });

  assert.equal(message.text, '发车 ');
  assert.equal(message.summary, '发车');
});

test('[C04] only images expose downloadable inbound attachments', () => {
  for (const [msgtype, payload] of fixtures.filter(([type]) =>
    ['image', 'voice', 'video', 'file'].includes(type),
  )) {
    const message = normalizeWecomMessage({ ...base, msgtype, ...payload });
    if (msgtype === 'image') {
      assert.deepEqual(message.attachments, [
        { kind: 'image', mediaId: 'image-secret', status: 'unresolved' },
      ]);
    } else {
      assert.deepEqual(message.attachments, []);
      assert.doesNotMatch(message.summary, /(?:voice|video|file)-secret/u);
    }
  }

  const fileFixture = fixtures.find(([type]) => type === 'file');
  assert.ok(fileFixture);
  const file = normalizeWecomMessage({
    ...base,
    msgtype: 'file',
    ...fileFixture[1],
  });
  assert.match(file.summary, /合同\.pdf/u);
  assert.match(file.summary, /未下载或打开/u);
});

test('[C05] recursively summarizes merged history without leaking nested media IDs', () => {
  const item = (
    msgtype: string,
    payload: FixturePayload | string,
    senderName = msgtype,
  ) => ({
    send_time: 125,
    msgtype,
    sender_name: senderName,
    msg_content:
      typeof payload === 'string'
        ? payload
        : JSON.stringify({ msgtype, ...payload }),
  });
  const message = normalizeWecomMessage({
    ...base,
    msgtype: 'merged_msg',
    merged_msg: {
      title: '重要记录',
      item: [
        item('text', { text: { content: '关键文本' } }, '甲'),
        item('image', { image: { media_id: 'nested-image-secret' } }),
        item('voice', { voice: { media_id: 'nested-voice-secret' } }),
        item('video', { video: { media_id: 'nested-video-secret' } }),
        item('file', { file: { media_id: 'nested-file-secret', filename: '账单.pdf' } }),
        item('location', {
          location: {
            name: '天安门',
            address: '北京市东城区',
            latitude: 39.9087,
            longitude: 116.3975,
          },
        }),
        item('link', {
          link: {
            title: '帮助中心',
            desc: '使用说明',
            url: 'https://example.com/help',
          },
        }),
        item('merged_msg', {
          merged_msg: {
            title: '内层',
            item: [item('text', { text: { content: '内层正文' } }, '乙')],
          },
        }),
        item('text', '{broken-json', '损坏条目'),
      ],
    },
  });

  for (const expected of [
    '关键文本',
    '微信图片',
    '微信语音',
    '微信视频',
    '账单.pdf',
    '天安门',
    'https://example.com/help',
    '内层正文',
    '内容无法解析',
  ]) {
    assert.ok(message.summary.includes(expected), expected);
  }
  assert.doesNotMatch(message.summary, /nested-(?:image|voice|video|file)-secret/u);
});

test('normalizes system events and rejects unknown customer types from support', () => {
  const event = normalizeWecomMessage({
    msgid: 'event-one',
    origin: 4,
    msgtype: 'event',
    event: {
      event_type: 'session_status_change',
      open_kfid: 'wk-event',
      external_userid: 'wm-event',
      change_type: 3,
    },
  });
  assert.equal(event.origin, MESSAGE_ORIGINS.SYSTEM);
  assert.equal(event.type, MESSAGE_TYPES.EVENT);
  assert.equal(event.attributes.change_type, 3);
  assert.equal(event.conversation.openKfId, 'wk-event');

  const unknown = normalizeWecomMessage({
    ...base,
    msgtype: 'future_type',
  });
  assert.equal(unknown.type, MESSAGE_TYPES.UNKNOWN);
  assert.equal(unknown.rawType, 'future_type');
  assert.equal(isSupportedCustomerMessage(unknown), false);
});
