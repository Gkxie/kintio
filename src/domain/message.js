export const MESSAGE_ORIGINS = Object.freeze({
  CUSTOMER: 'customer',
  HUMAN: 'human',
  SYSTEM: 'system',
  UNKNOWN: 'unknown',
});

export const MESSAGE_TYPES = Object.freeze({
  TEXT: 'text',
  IMAGE: 'image',
  VOICE: 'voice',
  VIDEO: 'video',
  FILE: 'file',
  LOCATION: 'location',
  LINK: 'link',
  BUSINESS_CARD: 'business_card',
  MINIPROGRAM: 'miniprogram',
  MSGMENU: 'msgmenu',
  CHANNELS_SHOP_PRODUCT: 'channels_shop_product',
  CHANNELS_SHOP_ORDER: 'channels_shop_order',
  MERGED_MESSAGE: 'merged_msg',
  CHANNELS: 'channels',
  NOTE: 'note',
  EVENT: 'event',
  UNKNOWN: 'unknown',
});

export const ATTACHMENT_KINDS = Object.freeze({
  IMAGE: 'image',
  AUDIO: 'audio',
  VIDEO: 'video',
  FILE: 'file',
});

export function createDomainMessage({
  id,
  origin,
  type,
  sentAt = 0,
  openKfId = '',
  externalUserId = '',
  servicerUserId = '',
  text = '',
  attributes = {},
  attachments = [],
}) {
  return Object.freeze({
    id: String(id || ''),
    channel: 'wecom-kf',
    direction: 'inbound',
    origin: origin || MESSAGE_ORIGINS.UNKNOWN,
    type: type || MESSAGE_TYPES.UNKNOWN,
    sentAt: Number(sentAt || 0),
    conversation: Object.freeze({
      openKfId: String(openKfId || ''),
      externalUserId: String(externalUserId || ''),
    }),
    actor: Object.freeze({ servicerUserId: String(servicerUserId || '') }),
    text: String(text || ''),
    attributes: Object.freeze(structuredClone(attributes || {})),
    attachments: Object.freeze(
      attachments.map((attachment) => Object.freeze({ ...attachment })),
    ),
  });
}

function compact(parts) {
  return parts.filter((part) => part !== '' && part !== undefined && part !== null);
}

function renderMergedItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '没有可记录的聊天条目';
  }

  return items
    .slice(0, 50)
    .map((item, index) => {
      const sender = item.senderName || '未知发送者';
      const summary = item.summary || `[${item.type || 'unknown'}]`;
      return `${index + 1}. ${sender}：${summary}`;
    })
    .join('\n');
}

export function renderMessageForCodex(message) {
  const attributes = message.attributes || {};

  switch (message.type) {
    case MESSAGE_TYPES.TEXT:
      return attributes.menuId
        ? `客户点击了菜单选项：${message.text}（menu_id：${attributes.menuId}）`
        : message.text;

    case MESSAGE_TYPES.IMAGE:
      return '客户发送了一张图片。请识别随消息附带的客户图片，并结合当前对话回复。';

    case MESSAGE_TYPES.VOICE:
      return '客户发送了一条语音消息。当前未配置语音转写，仅记录到一条未解析语音。';

    case MESSAGE_TYPES.VIDEO:
      return '客户发送了一段视频。当前未配置视频抽帧或转写，仅记录到一条未解析视频。';

    case MESSAGE_TYPES.FILE:
      return '客户发送了一个文件。当前未配置通用文件解析，仅记录到一个未解析文件。';

    case MESSAGE_TYPES.LOCATION:
      return compact([
        '客户发送了位置',
        attributes.name ? `名称：${attributes.name}` : '',
        attributes.address ? `地址：${attributes.address}` : '',
        Number.isFinite(attributes.latitude)
          ? `纬度：${attributes.latitude}`
          : '',
        Number.isFinite(attributes.longitude)
          ? `经度：${attributes.longitude}`
          : '',
      ]).join('；');

    case MESSAGE_TYPES.LINK:
      return compact([
        '客户发送了链接',
        attributes.title ? `标题：${attributes.title}` : '',
        attributes.description ? `描述：${attributes.description}` : '',
        attributes.url ? `URL：${attributes.url}` : '',
      ]).join('；');

    case MESSAGE_TYPES.BUSINESS_CARD:
      return '客户发送了一张企业微信名片；当前只记录名片消息，不解析联系人详情。';

    case MESSAGE_TYPES.MINIPROGRAM:
      return compact([
        '客户发送了小程序卡片（仅文本记录）',
        attributes.title ? `标题：${attributes.title}` : '',
        attributes.appId ? `AppID：${attributes.appId}` : '',
        attributes.pagePath ? `页面：${attributes.pagePath}` : '',
      ]).join('；');

    case MESSAGE_TYPES.MSGMENU:
      return compact([
        '客户发送了菜单消息（仅文本记录）',
        attributes.headContent ? `开头：${attributes.headContent}` : '',
        Array.isArray(attributes.items) && attributes.items.length
          ? `选项：${attributes.items
              .slice(0, 10)
              .map((item) => item.content || `[${item.type}]`)
              .join('、')}`
          : '',
        attributes.tailContent ? `结尾：${attributes.tailContent}` : '',
      ]).join('；');

    case MESSAGE_TYPES.CHANNELS_SHOP_PRODUCT:
      return compact([
        '客户发送了视频号商品（仅文本记录）',
        attributes.title ? `商品：${attributes.title}` : '',
        attributes.shopNickname ? `店铺：${attributes.shopNickname}` : '',
        attributes.salesPrice ? `价格（分）：${attributes.salesPrice}` : '',
        attributes.productId ? `商品ID：${attributes.productId}` : '',
      ]).join('；');

    case MESSAGE_TYPES.CHANNELS_SHOP_ORDER:
      return compact([
        '客户发送了视频号订单（仅文本记录）',
        attributes.orderId ? `订单号：${attributes.orderId}` : '',
        attributes.productTitles ? `商品：${attributes.productTitles}` : '',
        attributes.priceWording ? `价格：${attributes.priceWording}` : '',
        attributes.state ? `状态：${attributes.state}` : '',
        attributes.shopNickname ? `店铺：${attributes.shopNickname}` : '',
      ]).join('；');

    case MESSAGE_TYPES.MERGED_MESSAGE:
      return compact([
        `客户发送了聊天记录（仅文本记录）：${attributes.title || '未命名'}`,
        renderMergedItems(attributes.items),
      ]).join('\n');

    case MESSAGE_TYPES.CHANNELS:
      return compact([
        '客户发送了视频号内容（仅文本记录）',
        attributes.nickname ? `视频号：${attributes.nickname}` : '',
        attributes.title ? `标题：${attributes.title}` : '',
        attributes.subType ? `类型：${attributes.subType}` : '',
      ]).join('；');

    case MESSAGE_TYPES.NOTE:
      return '客户发送了一条微信笔记；微信客服接口没有返回笔记详情，仅记录笔记消息。';

    default:
      return `客户发送了类型为 ${message.type || 'unknown'} 的消息；当前只记录消息类型。`;
  }
}
