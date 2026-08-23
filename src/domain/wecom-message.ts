import { truncateUtf8 } from '../lib/text.ts';
import type { NormalizedMessage } from '../types.ts';

export const MESSAGE_ORIGINS = {
  CUSTOMER: 'customer',
  SYSTEM: 'system',
  HUMAN: 'human',
  UNKNOWN: 'unknown',
} as const;
export type MessageOrigin =
  (typeof MESSAGE_ORIGINS)[keyof typeof MESSAGE_ORIGINS];

export const MESSAGE_TYPES = {
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
} as const;
export type MessageType = (typeof MESSAGE_TYPES)[keyof typeof MESSAGE_TYPES];

export const CUSTOMER_MESSAGE_TYPES = Object.freeze([
  MESSAGE_TYPES.TEXT,
  MESSAGE_TYPES.IMAGE,
  MESSAGE_TYPES.VOICE,
  MESSAGE_TYPES.VIDEO,
  MESSAGE_TYPES.FILE,
  MESSAGE_TYPES.LOCATION,
  MESSAGE_TYPES.LINK,
  MESSAGE_TYPES.BUSINESS_CARD,
  MESSAGE_TYPES.MINIPROGRAM,
  MESSAGE_TYPES.MSGMENU,
  MESSAGE_TYPES.CHANNELS_SHOP_PRODUCT,
  MESSAGE_TYPES.CHANNELS_SHOP_ORDER,
  MESSAGE_TYPES.MERGED_MESSAGE,
  MESSAGE_TYPES.CHANNELS,
  MESSAGE_TYPES.NOTE,
]);
type LooseObject = Record<string, unknown>;
type RawMessage = LooseObject & {
  text?: LooseObject;
  image?: LooseObject;
  voice?: LooseObject;
  video?: LooseObject;
  file?: LooseObject;
  location?: LooseObject;
  link?: LooseObject;
  business_card?: LooseObject;
  miniprogram?: LooseObject;
  msgmenu?: LooseObject;
  channels_shop_product?: LooseObject;
  channels_shop_order?: LooseObject;
  merged_msg?: LooseObject;
  channels?: LooseObject;
  note?: LooseObject;
  event?: LooseObject;
};

interface MergedItem {
  readonly sendTime: number;
  readonly type: string;
  readonly senderName: string;
  readonly summary: string;
}

const ORIGINS = new Map([
  [3, MESSAGE_ORIGINS.CUSTOMER],
  [4, MESSAGE_ORIGINS.SYSTEM],
  [5, MESSAGE_ORIGINS.HUMAN],
]);
const KNOWN_TYPES = new Set(Object.values(MESSAGE_TYPES));
const KNOWN_CUSTOMER_TYPES = new Set(CUSTOMER_MESSAGE_TYPES);
const MAX_MERGED_ITEMS = 50;
const MAX_MERGED_DEPTH = 3;
const MAX_SUMMARY_BYTES = 16 * 1024;

function asObject(value: unknown): LooseObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as LooseObject)
    : {};
}

function clean(value: unknown, maxBytes = 1024): string {
  return truncateUtf8(
    String(value ?? '')
      .replace(/\s+/gu, ' ')
      .trim(),
    maxBytes,
    '…',
  );
}

function numberLabel(label: string, value: unknown): string {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? `${label}${parsed}` : '';
}

function labeled(label: string, values: readonly string[]): string {
  const detail = values.filter(Boolean).join('；');
  return detail ? `[微信${label}] ${detail}` : `[微信${label}]`;
}

function menuOptions(menu: LooseObject | undefined): string {
  const list = menu?.list;
  if (!Array.isArray(list)) return '';
  return list
    .slice(0, 20)
    .map((item: unknown) => {
      const row = asObject(item);
      const type = clean(row.type || 'unknown', 64);
      const body = asObject(row[type]);
      return clean(body.content || `[${type}]`, 256);
    })
    .filter(Boolean)
    .join('、');
}

function parseMergedItems(items: unknown, depth: number): readonly MergedItem[] {
  if (!Array.isArray(items)) return [];

  return items.slice(0, MAX_MERGED_ITEMS).map((value: unknown) => {
    const item = asObject(value);
    let payload: RawMessage | null;
    try {
      payload = JSON.parse(String(item.msg_content || '{}')) as RawMessage;
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        payload = null;
      } else if (!payload.msgtype && item.msgtype) {
        payload = { ...payload, msgtype: item.msgtype };
      }
    } catch {
      payload = null;
    }

    return Object.freeze({
      sendTime: Number(item.send_time || 0),
      type: String(item.msgtype || payload?.msgtype || 'unknown'),
      senderName: clean(item.sender_name || '未知发送者', 256),
      summary: summarizePayload(payload, depth),
    });
  });
}

function mergedSummary(mergedValue: unknown, depth: number): string {
  const merged = asObject(mergedValue);
  if (depth >= MAX_MERGED_DEPTH) {
    return '[微信聊天记录：已达嵌套深度上限]';
  }

  const title = clean(merged?.title, 256);
  const items = parseMergedItems(merged?.item, depth + 1);
  const lines = [
    `[微信聊天记录${title ? `：${title}` : ''}]`,
    ...items.map(
      (item, index) => `${index + 1}. ${item.senderName}：${item.summary}`,
    ),
  ];
  return truncateUtf8(lines.join('\n'), MAX_SUMMARY_BYTES, '…');
}

function summarizePayload(
  payload: RawMessage | null,
  depth = 0,
): string {
  if (!payload || typeof payload !== 'object') return '[微信消息：内容无法解析]';

  const type = String(payload.msgtype || 'unknown');
  switch (type) {
    case MESSAGE_TYPES.TEXT: {
      const content = clean(payload.text?.content, MAX_SUMMARY_BYTES);
      const menuId = clean(payload.text?.menu_id, 128);
      return menuId
        ? `客户点击了菜单选项：${content || '[空文本]'}（menu_id：${menuId}）`
        : content || '[微信文本：空]';
    }
    case MESSAGE_TYPES.IMAGE:
      return '[微信图片：已作为原生图像输入附加]';
    case MESSAGE_TYPES.VOICE:
      return '[微信语音：未下载、未转写]';
    case MESSAGE_TYPES.VIDEO:
      return '[微信视频：未下载、未观看或转写]';
    case MESSAGE_TYPES.FILE:
      return labeled('文件', [
        clean(payload.file?.filename, 256),
        payload.file?.file_size
          ? `大小 ${clean(payload.file.file_size, 64)}`
          : '',
        '内容未下载或打开',
      ]);
    case MESSAGE_TYPES.LOCATION:
      return labeled('位置', [
        clean(payload.location?.name, 256),
        clean(payload.location?.address, 512),
        numberLabel('纬度 ', payload.location?.latitude),
        numberLabel('经度 ', payload.location?.longitude),
      ]);
    case MESSAGE_TYPES.LINK:
      return labeled('链接', [
        clean(payload.link?.title, 256),
        clean(payload.link?.desc, 512),
        clean(payload.link?.url, 2048),
      ]);
    case MESSAGE_TYPES.BUSINESS_CARD:
      return '[微信企业名片：未解析联系人详情]';
    case MESSAGE_TYPES.MINIPROGRAM:
      return labeled('小程序', [
        clean(payload.miniprogram?.title, 256),
        clean(payload.miniprogram?.appid, 128),
        clean(payload.miniprogram?.pagepath, 1024),
      ]);
    case MESSAGE_TYPES.MSGMENU:
      return labeled('菜单', [
        clean(payload.msgmenu?.head_content, 512),
        menuOptions(payload.msgmenu),
        clean(payload.msgmenu?.tail_content, 512),
      ]);
    case MESSAGE_TYPES.CHANNELS_SHOP_PRODUCT:
      return labeled('视频号商品', [
        clean(payload.channels_shop_product?.title, 256),
        payload.channels_shop_product?.sales_price
          ? `价格（分）${clean(payload.channels_shop_product.sales_price, 64)}`
          : '',
        clean(payload.channels_shop_product?.shop_nickname, 256),
        payload.channels_shop_product?.product_id
          ? `商品ID ${clean(payload.channels_shop_product.product_id, 128)}`
          : '',
      ]);
    case MESSAGE_TYPES.CHANNELS_SHOP_ORDER:
      return labeled('视频号订单', [
        payload.channels_shop_order?.order_id
          ? `订单号 ${clean(payload.channels_shop_order.order_id, 128)}`
          : '',
        clean(payload.channels_shop_order?.product_titles, 512),
        clean(payload.channels_shop_order?.price_wording, 128),
        clean(payload.channels_shop_order?.state, 128),
        clean(payload.channels_shop_order?.shop_nickname, 256),
      ]);
    case MESSAGE_TYPES.MERGED_MESSAGE:
      return mergedSummary(payload.merged_msg, depth);
    case MESSAGE_TYPES.CHANNELS:
      return labeled('视频号内容', [
        clean(payload.channels?.nickname, 256),
        clean(payload.channels?.title, 512),
        payload.channels?.sub_type
          ? `类型 ${clean(payload.channels.sub_type, 64)}`
          : '',
      ]);
    case MESSAGE_TYPES.NOTE:
      return '[微信笔记：接口未返回可读正文]';
    default:
      return `[微信${clean(type, 128) || 'unknown'}消息：内容未解析]`;
  }
}

function messageAttributes(
  type: MessageType,
  raw: RawMessage,
): Readonly<Record<string, unknown>> {
  switch (type) {
    case MESSAGE_TYPES.TEXT:
      return { menuId: String(raw.text?.menu_id || '') };
    case MESSAGE_TYPES.LOCATION:
      return {
        latitude: Number(raw.location?.latitude),
        longitude: Number(raw.location?.longitude),
        name: String(raw.location?.name || ''),
        address: String(raw.location?.address || ''),
      };
    case MESSAGE_TYPES.LINK:
      return {
        title: String(raw.link?.title || ''),
        description: String(raw.link?.desc || ''),
        url: String(raw.link?.url || ''),
      };
    case MESSAGE_TYPES.MINIPROGRAM:
      return {
        title: String(raw.miniprogram?.title || ''),
        appId: String(raw.miniprogram?.appid || ''),
        pagePath: String(raw.miniprogram?.pagepath || ''),
      };
    case MESSAGE_TYPES.MERGED_MESSAGE:
      return {
        title: String(raw.merged_msg?.title || ''),
        items: parseMergedItems(raw.merged_msg?.item, 1),
      };
    case MESSAGE_TYPES.EVENT:
      return structuredClone(raw.event || {});
    default:
      return {};
  }
}

export function normalizeWecomMessage(
  rawMessage: unknown,
  fallbackOpenKfId = '',
  { cursor = '', index = 0 }: { cursor?: string; index?: number } = {},
): NormalizedMessage {
  const raw = asObject(rawMessage) as RawMessage;
  const rawType = String(raw.msgtype || 'unknown');
  const type = KNOWN_TYPES.has(rawType as MessageType)
    ? (rawType as MessageType)
    : MESSAGE_TYPES.UNKNOWN;
  const event = asObject(raw.event);
  const mediaId =
    type === MESSAGE_TYPES.IMAGE ? String(raw.image?.media_id || '') : '';
  const text =
    type === MESSAGE_TYPES.TEXT ? String(raw.text?.content || '') : '';
  const message = {
    id: String(raw.msgid || ''),
    origin: ORIGINS.get(Number(raw.origin)) || MESSAGE_ORIGINS.UNKNOWN,
    type,
    rawType,
    sentAt: Number(raw.send_time || 0),
    sync: Object.freeze({
      cursor: String(cursor || ''),
      index: Number.isInteger(index) && index >= 0 ? index : 0,
    }),
    conversation: Object.freeze({
      openKfId: String(raw.open_kfid || event.open_kfid || fallbackOpenKfId),
      externalUserId: String(raw.external_userid || event.external_userid || ''),
    }),
    actor: Object.freeze({
      servicerUserId: String(raw.servicer_userid || event.servicer_userid || ''),
    }),
    text,
    summary:
      type === MESSAGE_TYPES.EVENT
        ? `[微信系统事件：${clean(event.event_type || 'unknown', 128)}]`
        : summarizePayload({ ...raw, msgtype: type }),
    attributes: Object.freeze(messageAttributes(type, raw)),
    attachments: Object.freeze(
      mediaId
        ? [Object.freeze({ kind: 'image', mediaId, status: 'unresolved' })]
        : [],
    ),
  };
  return Object.freeze(message);
}

export function isSupportedCustomerMessage(
  message: Pick<NormalizedMessage, 'origin' | 'type'>,
): boolean {
  return (
    message?.origin === MESSAGE_ORIGINS.CUSTOMER &&
    KNOWN_CUSTOMER_TYPES.has(
      message.type as (typeof CUSTOMER_MESSAGE_TYPES)[number],
    )
  );
}

export function renderMessageForCodex(
  message: Pick<NormalizedMessage, 'summary' | 'text'>,
): string {
  return String(message?.summary || message?.text || '[微信消息：无可读摘要]');
}
