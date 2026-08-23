import assert from 'node:assert/strict';
import test from 'node:test';

import { projectWecomMessage } from '../src/adapters/wecom-message-adapter.js';
import {
  ATTACHMENT_KINDS,
  MESSAGE_ORIGINS,
  MESSAGE_TYPES,
  renderMessageForCodex,
} from '../src/domain/message.js';

const base = {
  msgid: 'message-id',
  open_kfid: 'wk-one',
  external_userid: 'wm-one',
  send_time: 123,
  origin: 3,
};

const fixtures = [
  ['text', { text: { content: '你好', menu_id: 'menu-one' } }],
  ['image', { image: { media_id: 'image-media' } }],
  ['voice', { voice: { media_id: 'voice-media' } }],
  ['video', { video: { media_id: 'video-media' } }],
  ['file', { file: { media_id: 'file-media' } }],
  [
    'location',
    {
      location: {
        latitude: 39.9,
        longitude: 116.4,
        name: '北京',
        address: '北京市',
      },
    },
  ],
  [
    'link',
    {
      link: {
        title: '博主个人主页',
        desc: '粉丝1.3万',
        url: 'https://example.com/creator',
        pic_url: 'https://example.com/avatar.png',
      },
    },
  ],
  ['business_card', { business_card: { userid: 'contact-one' } }],
  [
    'miniprogram',
    {
      miniprogram: {
        title: '服务小程序',
        appid: 'wx-app',
        pagepath: 'pages/index',
        thumb_media_id: 'thumb',
      },
    },
  ],
  [
    'msgmenu',
    {
      msgmenu: {
        head_content: '请选择服务',
        list: [
          {
            type: 'click',
            click: { id: 'support', content: '售后服务' },
          },
        ],
        tail_content: '点击即可回复',
      },
    },
  ],
  [
    'channels_shop_product',
    {
      channels_shop_product: {
        product_id: 'product-one',
        title: '商品',
        sales_price: '1999',
        shop_nickname: '店铺',
      },
    },
  ],
  [
    'channels_shop_order',
    {
      channels_shop_order: {
        order_id: 'order-one',
        product_titles: '商品A',
        price_wording: '19.99元',
        state: '已支付',
        shop_nickname: '店铺',
      },
    },
  ],
  [
    'merged_msg',
    {
      merged_msg: {
        title: '聊天记录',
        item: [
          {
            send_time: 124,
            msgtype: 'text',
            sender_name: '客户',
            msg_content: JSON.stringify({
              msgtype: 'text',
              text: { content: '记录正文' },
            }),
          },
        ],
      },
    },
  ],
  ['channels', { channels: { sub_type: 1, nickname: '视频号', title: '动态' } }],
  ['note', {}],
];

test('WeCom adapter projects every documented customer message type', () => {
  for (const [msgtype, payload] of fixtures) {
    const message = projectWecomMessage({ ...base, msgtype, ...payload });

    assert.equal(message.origin, MESSAGE_ORIGINS.CUSTOMER);
    assert.equal(message.type, msgtype);
    assert.equal(message.conversation.openKfId, 'wk-one');
    assert.equal(message.conversation.externalUserId, 'wm-one');
    assert.ok(renderMessageForCodex(message).length > 0, msgtype);
  }
});

test('media messages use typed unresolved attachments', () => {
  const expectations = [
    ['image', ATTACHMENT_KINDS.IMAGE],
    ['voice', ATTACHMENT_KINDS.AUDIO],
    ['video', ATTACHMENT_KINDS.VIDEO],
    ['file', ATTACHMENT_KINDS.FILE],
  ];

  for (const [msgtype, kind] of expectations) {
    const payload = fixtures.find(([type]) => type === msgtype)[1];
    const message = projectWecomMessage({ ...base, msgtype, ...payload });
    assert.equal(message.attachments[0].kind, kind);
    assert.equal(message.attachments[0].status, 'unresolved');
  }
});

test('structured messages become explicit text records', () => {
  const miniprogram = projectWecomMessage({
    ...base,
    msgtype: 'miniprogram',
    ...fixtures.find(([type]) => type === 'miniprogram')[1],
  });
  const merged = projectWecomMessage({
    ...base,
    msgtype: 'merged_msg',
    ...fixtures.find(([type]) => type === 'merged_msg')[1],
  });

  assert.match(renderMessageForCodex(miniprogram), /仅文本记录/);
  assert.match(renderMessageForCodex(miniprogram), /服务小程序/);
  assert.match(renderMessageForCodex(merged), /记录正文/);
  assert.match(
    renderMessageForCodex(
      projectWecomMessage({ ...base, msgtype: 'text', text: {
        content: '售后服务',
        menu_id: 'support',
      } }),
    ),
    /menu_id：support/,
  );
});

test('merged chat history recursively summarizes every nested message type', () => {
  const item = (msgtype, payload, senderName = msgtype) => ({
    send_time: 124,
    msgtype,
    sender_name: senderName,
    msg_content:
      typeof payload === 'string'
        ? payload
        : JSON.stringify({ msgtype, ...payload }),
  });
  const message = projectWecomMessage({
    ...base,
    msgtype: 'merged_msg',
    merged_msg: {
      title: '重要聊天记录',
      item: [
        item('text', { text: { content: '正文关键信息' } }, '甲'),
        item('image', { image: { media_id: 'nested-image-secret' } }),
        item('voice', { voice: { media_id: 'nested-voice-secret' } }),
        item('video', { video: { media_id: 'nested-video-secret' } }),
        item('file', { file: { media_id: 'nested-file-secret' } }),
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
            title: '主页链接',
            desc: '公开简介',
            url: 'https://example.com/profile',
          },
        }),
        item('business_card', { business_card: { userid: 'hidden-user' } }),
        item('miniprogram', {
          miniprogram: {
            title: '服务入口',
            appid: 'wx1234567890abcdef',
            pagepath: 'pages/index.html',
          },
        }),
        item('msgmenu', {
          msgmenu: {
            head_content: '请选择',
            list: [
              { type: 'click', click: { id: 'one', content: '选项一' } },
            ],
            tail_content: '结束',
          },
        }),
        item('channels_shop_product', {
          channels_shop_product: {
            product_id: 'product-one',
            title: '商品甲',
            sales_price: '1999',
            shop_nickname: '店铺甲',
          },
        }),
        item('channels_shop_order', {
          channels_shop_order: {
            order_id: 'order-one',
            product_titles: '商品甲',
            price_wording: '19.99元',
            state: '已支付',
            shop_nickname: '店铺甲',
          },
        }),
        item('channels', {
          channels: { sub_type: 1, nickname: '视频号甲', title: '动态甲' },
        }),
        item('note', {}),
        item('merged_msg', {
          merged_msg: {
            title: '内层记录',
            item: [item('text', { text: { content: '内层正文' } }, '乙')],
          },
        }),
        item('text', '{not-json', '损坏条目'),
      ],
    },
  });
  const rendered = renderMessageForCodex(message);

  for (const expected of [
    '正文关键信息',
    '[图片，内容未解析]',
    '[语音，内容未解析]',
    '[视频，内容未解析]',
    '[文件，内容未解析]',
    '天安门',
    'https://example.com/profile',
    '[企业微信名片，未解析联系人详情]',
    '服务入口',
    '选项一',
    '商品甲',
    'order-one',
    '视频号甲',
    '[微信笔记，接口未返回详细内容]',
    '内层正文',
    '[消息内容无法解析]',
  ]) {
    assert.match(rendered, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  }
  assert.doesNotMatch(rendered, /nested-(image|voice|video|file)-secret/);
});

test('system events use nested conversation identifiers', () => {
  const message = projectWecomMessage({
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

  assert.equal(message.type, MESSAGE_TYPES.EVENT);
  assert.equal(message.origin, MESSAGE_ORIGINS.SYSTEM);
  assert.equal(message.conversation.openKfId, 'wk-event');
  assert.equal(message.attributes.change_type, 3);
});
