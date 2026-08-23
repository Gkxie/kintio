import {
  ATTACHMENT_KINDS,
  MESSAGE_ORIGINS,
  MESSAGE_TYPES,
  createDomainMessage,
} from '../domain/message.js';
import { truncateUtf8 } from '../lib/text.js';

const ORIGIN_MAP = new Map([
  [3, MESSAGE_ORIGINS.CUSTOMER],
  [4, MESSAGE_ORIGINS.SYSTEM],
  [5, MESSAGE_ORIGINS.HUMAN],
]);
const KNOWN_TYPES = new Set(Object.values(MESSAGE_TYPES));
const MAX_MERGED_ITEMS = 50;
const MAX_MERGED_DEPTH = 3;

function mediaAttachment(kind, mediaId) {
  if (!mediaId) return [];
  return [{ kind, mediaId: String(mediaId), status: 'unresolved' }];
}

function cleanSummary(value, maxBytes = 1024) {
  return truncateUtf8(
    String(value || '')
      .replace(/\s+/gu, ' ')
      .trim(),
    maxBytes,
    '…',
  );
}

function labeledSummary(label, values) {
  const details = values.filter(Boolean).join('；');
  return cleanSummary(details ? `[${label}] ${details}` : `[${label}]`);
}

function menuItemContent(item) {
  const type = String(item?.type || 'unknown');
  const body = item?.[type] || {};
  return cleanSummary(body.content || `[${type}]`, 256);
}

function summarizeNestedMessage(content, depth = 0) {
  if (!content || typeof content !== 'object') return '[消息内容无法解析]';

  const type = String(content.msgtype || 'unknown');

  switch (type) {
    case MESSAGE_TYPES.TEXT:
      return cleanSummary(content.text?.content || '[空文本]');
    case MESSAGE_TYPES.IMAGE:
      return '[图片，内容未解析]';
    case MESSAGE_TYPES.VOICE:
      return '[语音，内容未解析]';
    case MESSAGE_TYPES.VIDEO:
      return '[视频，内容未解析]';
    case MESSAGE_TYPES.FILE:
      return '[文件，内容未解析]';
    case MESSAGE_TYPES.LOCATION:
      return labeledSummary('位置', [
        cleanSummary(content.location?.name, 256),
        cleanSummary(content.location?.address, 512),
        Number.isFinite(Number(content.location?.latitude))
          ? `纬度 ${Number(content.location.latitude)}`
          : '',
        Number.isFinite(Number(content.location?.longitude))
          ? `经度 ${Number(content.location.longitude)}`
          : '',
      ]);
    case MESSAGE_TYPES.LINK:
      return labeledSummary('链接', [
        cleanSummary(content.link?.title, 256),
        cleanSummary(content.link?.desc, 512),
        cleanSummary(content.link?.url, 1024),
      ]);
    case MESSAGE_TYPES.BUSINESS_CARD:
      return '[企业微信名片，未解析联系人详情]';
    case MESSAGE_TYPES.MINIPROGRAM:
      return labeledSummary('小程序', [
        cleanSummary(content.miniprogram?.title, 256),
        cleanSummary(content.miniprogram?.appid, 64),
        cleanSummary(content.miniprogram?.pagepath, 512),
      ]);
    case MESSAGE_TYPES.MSGMENU:
      return labeledSummary('菜单', [
        cleanSummary(content.msgmenu?.head_content, 512),
        Array.isArray(content.msgmenu?.list)
          ? content.msgmenu.list.slice(0, 10).map(menuItemContent).join('、')
          : '',
        cleanSummary(content.msgmenu?.tail_content, 512),
      ]);
    case MESSAGE_TYPES.CHANNELS_SHOP_PRODUCT:
      return labeledSummary('视频号商品', [
        cleanSummary(content.channels_shop_product?.title, 256),
        content.channels_shop_product?.sales_price
          ? `价格（分）${cleanSummary(content.channels_shop_product.sales_price, 64)}`
          : '',
        cleanSummary(content.channels_shop_product?.shop_nickname, 256),
        content.channels_shop_product?.product_id
          ? `商品ID ${cleanSummary(content.channels_shop_product.product_id, 128)}`
          : '',
      ]);
    case MESSAGE_TYPES.CHANNELS_SHOP_ORDER:
      return labeledSummary('视频号订单', [
        content.channels_shop_order?.order_id
          ? `订单号 ${cleanSummary(content.channels_shop_order.order_id, 128)}`
          : '',
        cleanSummary(content.channels_shop_order?.product_titles, 512),
        cleanSummary(content.channels_shop_order?.price_wording, 128),
        cleanSummary(content.channels_shop_order?.state, 128),
        cleanSummary(content.channels_shop_order?.shop_nickname, 256),
      ]);
    case MESSAGE_TYPES.CHANNELS:
      return labeledSummary('视频号', [
        cleanSummary(content.channels?.nickname, 256),
        cleanSummary(content.channels?.title, 512),
        content.channels?.sub_type
          ? `类型 ${Number(content.channels.sub_type)}`
          : '',
      ]);
    case MESSAGE_TYPES.NOTE:
      return '[微信笔记，接口未返回详细内容]';
    case MESSAGE_TYPES.MERGED_MESSAGE: {
      if (depth >= MAX_MERGED_DEPTH) return '[嵌套聊天记录，已达摘要深度上限]';
      const title = cleanSummary(content.merged_msg?.title, 256);
      const nestedItems = projectMergedItems(
        content.merged_msg?.item,
        depth + 1,
      );
      return cleanSummary(
        [
          `[聊天记录${title ? `：${title}` : ''}]`,
          ...nestedItems.map(
            (item, index) =>
              `${index + 1}. ${item.senderName || '未知发送者'}：${item.summary}`,
          ),
        ].join('\n'),
        4096,
      );
    }
    default:
      return `[${cleanSummary(type, 128)} 消息，内容未解析]`;
  }
}

function projectMergedItems(items, depth = 0) {
  if (!Array.isArray(items)) return [];

  return items.slice(0, MAX_MERGED_ITEMS).map((item) => {
    let content = null;

    try {
      content = JSON.parse(item.msg_content || '{}');
      if (!content.msgtype && item.msgtype) {
        content = { ...content, msgtype: item.msgtype };
      }
    } catch {
      content = null;
    }

    return {
      sendTime: Number(item.send_time || 0),
      type: String(item.msgtype || content?.msgtype || 'unknown'),
      senderName: String(item.sender_name || ''),
      summary: summarizeNestedMessage(content, depth),
    };
  });
}

export function projectWecomMessage(rawMessage, fallbackOpenKfId = '') {
  const rawType = String(rawMessage?.msgtype || 'unknown');
  const type = KNOWN_TYPES.has(rawType) ? rawType : MESSAGE_TYPES.UNKNOWN;
  const event = rawMessage?.event || {};
  const openKfId = rawMessage?.open_kfid || event.open_kfid || fallbackOpenKfId;
  const externalUserId =
    rawMessage?.external_userid || event.external_userid || '';
  let text = '';
  let attributes = {};
  let attachments = [];

  switch (type) {
    case MESSAGE_TYPES.TEXT:
      text = String(rawMessage.text?.content || '').trim();
      attributes = { menuId: String(rawMessage.text?.menu_id || '') };
      break;
    case MESSAGE_TYPES.IMAGE:
      attachments = mediaAttachment(
        ATTACHMENT_KINDS.IMAGE,
        rawMessage.image?.media_id,
      );
      break;
    case MESSAGE_TYPES.VOICE:
      attachments = mediaAttachment(
        ATTACHMENT_KINDS.AUDIO,
        rawMessage.voice?.media_id,
      );
      break;
    case MESSAGE_TYPES.VIDEO:
      attachments = mediaAttachment(
        ATTACHMENT_KINDS.VIDEO,
        rawMessage.video?.media_id,
      );
      break;
    case MESSAGE_TYPES.FILE:
      attachments = mediaAttachment(
        ATTACHMENT_KINDS.FILE,
        rawMessage.file?.media_id,
      );
      break;
    case MESSAGE_TYPES.LOCATION:
      attributes = {
        latitude: Number(rawMessage.location?.latitude),
        longitude: Number(rawMessage.location?.longitude),
        name: String(rawMessage.location?.name || ''),
        address: String(rawMessage.location?.address || ''),
      };
      break;
    case MESSAGE_TYPES.LINK:
      attributes = {
        title: String(rawMessage.link?.title || ''),
        description: String(rawMessage.link?.desc || ''),
        url: String(rawMessage.link?.url || ''),
      };
      break;
    case MESSAGE_TYPES.BUSINESS_CARD:
      attributes = { userId: String(rawMessage.business_card?.userid || '') };
      break;
    case MESSAGE_TYPES.MINIPROGRAM:
      attributes = {
        title: String(rawMessage.miniprogram?.title || ''),
        appId: String(rawMessage.miniprogram?.appid || ''),
        pagePath: String(rawMessage.miniprogram?.pagepath || ''),
      };
      break;
    case MESSAGE_TYPES.MSGMENU:
      attributes = {
        headContent: String(rawMessage.msgmenu?.head_content || ''),
        tailContent: String(rawMessage.msgmenu?.tail_content || ''),
        items: Array.isArray(rawMessage.msgmenu?.list)
          ? rawMessage.msgmenu.list.slice(0, 20).map((item) => {
              const itemType = String(item?.type || 'unknown');
              const body = item?.[itemType] || {};
              return {
                type: itemType,
                id: String(body.id || ''),
                content: String(body.content || ''),
                url: String(body.url || ''),
                appId: String(body.appid || ''),
                pagePath: String(body.pagepath || ''),
              };
            })
          : [],
      };
      break;
    case MESSAGE_TYPES.CHANNELS_SHOP_PRODUCT:
      attributes = {
        productId: String(rawMessage.channels_shop_product?.product_id || ''),
        title: String(rawMessage.channels_shop_product?.title || ''),
        salesPrice: String(rawMessage.channels_shop_product?.sales_price || ''),
        shopNickname: String(
          rawMessage.channels_shop_product?.shop_nickname || '',
        ),
      };
      break;
    case MESSAGE_TYPES.CHANNELS_SHOP_ORDER:
      attributes = {
        orderId: String(rawMessage.channels_shop_order?.order_id || ''),
        productTitles: String(
          rawMessage.channels_shop_order?.product_titles || '',
        ),
        priceWording: String(
          rawMessage.channels_shop_order?.price_wording || '',
        ),
        state: String(rawMessage.channels_shop_order?.state || ''),
        shopNickname: String(
          rawMessage.channels_shop_order?.shop_nickname || '',
        ),
      };
      break;
    case MESSAGE_TYPES.MERGED_MESSAGE:
      attributes = {
        title: String(rawMessage.merged_msg?.title || ''),
        items: projectMergedItems(rawMessage.merged_msg?.item),
      };
      break;
    case MESSAGE_TYPES.CHANNELS:
      attributes = {
        subType: Number(rawMessage.channels?.sub_type || 0),
        nickname: String(rawMessage.channels?.nickname || ''),
        title: String(rawMessage.channels?.title || ''),
      };
      break;
    case MESSAGE_TYPES.NOTE:
      attributes = { detailAvailable: false };
      break;
    case MESSAGE_TYPES.EVENT:
      attributes = structuredClone(event);
      break;
    default:
      attributes = { originalType: rawType };
  }

  return createDomainMessage({
    id: rawMessage?.msgid,
    origin: ORIGIN_MAP.get(Number(rawMessage?.origin)) || MESSAGE_ORIGINS.UNKNOWN,
    type,
    sentAt: rawMessage?.send_time,
    openKfId,
    externalUserId,
    servicerUserId: rawMessage?.servicer_userid || event.servicer_userid,
    text,
    attributes,
    attachments,
  });
}
