import { createHash } from 'node:crypto';

import { MESSAGE_ORIGINS } from '../domain/message.ts';
import { truncateUtf8 } from '../lib/text.ts';
import type { NormalizedMessage } from '../types.ts';
import {
  IlinkMessageItemType,
  IlinkMessageState,
  IlinkMessageType,
  type IlinkMessage,
} from './protocol/types.ts';
import { extractIlinkInboundImageLocator } from './inbound-image.ts';
import {
  ILINK_ACCOUNT_KEY_PATTERN,
  ILINK_CHANNEL,
  ILINK_MAX_PROVIDER_ID_BYTES,
  type IlinkAccountKey,
} from './store-types.ts';

const MAX_ID_CHARACTERS = 1_024;
const MAX_CURSOR_CHARACTERS = 256 * 1_024;
const MAX_CONTEXT_TOKEN_CHARACTERS = 256 * 1_024;
const MAX_ITEMS = 50;
const MAX_TEXT_BYTES = 32 * 1_024;
const MAX_SUMMARY_BYTES = 48 * 1_024;
const MAX_NATIVE_IMAGES = 4;

type JsonRecord = Record<string, unknown>;

export interface IlinkInboundPair {
  /** Opaque account registry key; never derive a message key from the raw Bot ID. */
  readonly accountKey: IlinkAccountKey;
  readonly botId: string;
  readonly ownerUserId: string;
}

export interface IlinkInboundSyncPosition {
  readonly cursor: string;
  readonly index: number;
}

type IlinkInboundContentKind =
  | 'text'
  | 'mixed'
  | 'non_text'
  | 'empty';

interface IlinkInboundImageFact {
  readonly position: number;
  readonly downloadUrl: string;
  readonly aesKey: string;
}

interface IlinkInboundFacts {
  readonly contextToken: string;
  readonly providerSeq?: number;
  readonly images: readonly IlinkInboundImageFact[];
}

export interface IlinkNormalizedInbound {
  readonly message: NormalizedMessage;
  readonly facts: IlinkInboundFacts;
}

export class IlinkMessageNormalizationError extends Error {
  readonly code: 'invalid_pair' | 'invalid_sync';

  constructor(code: 'invalid_pair' | 'invalid_sync', message: string) {
    super(message);
    this.name = 'IlinkMessageNormalizationError';
    this.code = code;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requiredBoundedString(
  value: unknown,
  label: string,
  maximum: number,
  code: IlinkMessageNormalizationError['code'],
): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    throw new IlinkMessageNormalizationError(code, `${label} is invalid`);
  }
  return value;
}

function normalizePair(pair: IlinkInboundPair): IlinkInboundPair {
  const accountKey = requiredBoundedString(
    pair?.accountKey,
    'iLink accountKey',
    MAX_ID_CHARACTERS,
    'invalid_pair',
  );
  if (!ILINK_ACCOUNT_KEY_PATTERN.test(accountKey)) {
    throw new IlinkMessageNormalizationError(
      'invalid_pair',
      'iLink accountKey is invalid',
    );
  }
  const providerId = (value: unknown, label: string): string => {
    if (
      typeof value !== 'string' ||
      !value ||
      value !== value.trim() ||
      Buffer.byteLength(value, 'utf8') > ILINK_MAX_PROVIDER_ID_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new IlinkMessageNormalizationError('invalid_pair', `${label} is invalid`);
    }
    return value;
  };
  return Object.freeze({
    accountKey: accountKey as IlinkAccountKey,
    botId: providerId(pair?.botId, 'iLink botId'),
    ownerUserId: providerId(pair?.ownerUserId, 'iLink ownerUserId'),
  });
}

function normalizeSync(
  sync: IlinkInboundSyncPosition,
): IlinkInboundSyncPosition {
  const cursor = sync?.cursor;
  if (
    typeof cursor !== 'string' ||
    cursor.length > MAX_CURSOR_CHARACTERS ||
    cursor.includes('\0')
  ) {
    throw new IlinkMessageNormalizationError(
      'invalid_sync',
      'iLink cursor is invalid',
    );
  }
  if (!Number.isSafeInteger(sync?.index) || sync.index < 0) {
    throw new IlinkMessageNormalizationError(
      'invalid_sync',
      'iLink cursor index is invalid',
    );
  }
  return Object.freeze({ cursor, index: sync.index });
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function stableString(value: unknown): string {
  return typeof value === 'string' && value &&
    value.length <= MAX_ID_CHARACTERS && !value.includes('\0')
    ? value
    : '';
}

function providerMessageId(
  message: IlinkMessage,
): string | undefined {
  if (
    Number.isSafeInteger(message.message_id) &&
    Number(message.message_id) >= 0
  ) {
    return `message:${message.message_id}`;
  }

  const clientId = stableString(message.client_id);
  if (clientId) return `client:${sha256(clientId)}`;

  const itemIds = (message.item_list ?? [])
    .map((item) => stableString(isRecord(item) ? item.msg_id : undefined))
    .filter(Boolean);
  if (itemIds.length > 0) {
    return `items:${sha256(JSON.stringify(itemIds))}`;
  }
  if (Number.isSafeInteger(message.seq) && Number(message.seq) >= 0) {
    return `seq:${message.seq}`;
  }
  return undefined;
}

function safeFilename(value: unknown): string {
  return truncateUtf8(
    typeof value === 'string'
      ? value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').replace(/\s+/gu, ' ').trim()
      : '',
    256,
    '…',
  );
}

interface NormalizedItem {
  readonly type?: number;
  readonly isText: boolean;
  readonly text: string;
  readonly rendered: string;
}

function normalizeItem(value: unknown): NormalizedItem {
  if (!isRecord(value)) {
    return Object.freeze({
      isText: false,
      text: '',
      rendered: '[iLink item: unknown type; content not parsed]',
    });
  }

  const type = Number.isSafeInteger(value.type) && Number(value.type) >= 0
    ? Number(value.type)
    : undefined;
  if (type === IlinkMessageItemType.TEXT) {
    const textItem = isRecord(value.text_item) ? value.text_item : {};
    const rawText = typeof textItem.text === 'string' ? textItem.text : '';
    const text = truncateUtf8(rawText, MAX_TEXT_BYTES, '…');
    return Object.freeze({
      type,
      isText: true,
      text,
      rendered: text.trim() ? text : '[iLink text: empty]',
    });
  }

  let rendered: string;
  switch (type) {
    case IlinkMessageItemType.IMAGE:
      rendered = '[iLink image: not downloaded or viewed]';
      break;
    case IlinkMessageItemType.VOICE:
      rendered = '[iLink voice: not downloaded, played, or transcribed]';
      break;
    case IlinkMessageItemType.FILE: {
      const file = isRecord(value.file_item) ? value.file_item : {};
      const filename = safeFilename(file.file_name);
      rendered = filename
        ? `[iLink file: ${filename}; not downloaded or opened]`
        : '[iLink file: not downloaded or opened]';
      break;
    }
    case IlinkMessageItemType.VIDEO:
      rendered = '[iLink video: not downloaded, watched, or transcribed]';
      break;
    default:
      rendered = type === undefined
        ? '[iLink item: unknown type; content not parsed]'
        : `[iLink non-text item (type ${type}): content not parsed]`;
  }
  return Object.freeze({
    ...(type === undefined ? {} : { type }),
    isText: false,
    text: '',
    rendered,
  });
}

function validOptionalSafeInteger(value: unknown): boolean {
  return value === undefined ||
    (Number.isSafeInteger(value) && Number(value) >= 0);
}

/**
 * Returns null for messages outside the active one-to-one pair or for malformed
 * provider envelopes. Provider reply and media secrets remain isolated in facts
 * so the host can seal them before persistence.
 */
export function normalizeIlinkInboundMessage(
  message: IlinkMessage,
  activePair: IlinkInboundPair,
  syncPosition: IlinkInboundSyncPosition,
): IlinkNormalizedInbound | null {
  const pair = normalizePair(activePair);
  const sync = normalizeSync(syncPosition);
  if (!isRecord(message)) return null;
  const inbound = message as IlinkMessage;
  const contextToken = inbound.context_token;
  const createTime = inbound.create_time_ms;
  const seq = inbound.seq;
  if (
    inbound.from_user_id !== pair.ownerUserId ||
    inbound.to_user_id !== pair.botId ||
    inbound.message_type !== IlinkMessageType.USER ||
    inbound.message_state !== IlinkMessageState.FINISH ||
    typeof contextToken !== 'string' ||
    !contextToken ||
    contextToken.length > MAX_CONTEXT_TOKEN_CHARACTERS ||
    contextToken.includes('\0') ||
    typeof createTime !== 'number' ||
    !Number.isSafeInteger(createTime) ||
    createTime < 0 ||
    !validOptionalSafeInteger(seq) ||
    (inbound.item_list !== undefined && !Array.isArray(inbound.item_list)) ||
    (inbound.item_list?.length ?? 0) > MAX_ITEMS
  ) {
    return null;
  }

  const items = (inbound.item_list ?? []).map(normalizeItem);
  const textItems = items.filter((item) => item.isText);
  const nonTextCount = items.length - textItems.length;
  const text = truncateUtf8(
    textItems.map((item) => item.text).join('\n'),
    MAX_TEXT_BYTES,
    '…',
  );
  const summary = truncateUtf8(
    items.length > 0
      ? items.map((item) => item.rendered).join('\n')
      : '[iLink message: no readable content]',
    MAX_SUMMARY_BYTES,
    '…',
  );
  const kind: IlinkInboundContentKind = textItems.length > 0
    ? nonTextCount > 0 ? 'mixed' : 'text'
    : nonTextCount > 0 ? 'non_text' : 'empty';
  const stableProviderMessageId = providerMessageId(inbound);
  if (!stableProviderMessageId) return null;
  const images = (inbound.item_list ?? []).flatMap((value, position) => {
    if (!isRecord(value) || value.type !== IlinkMessageItemType.IMAGE) return [];
    try {
      const locator = extractIlinkInboundImageLocator(value.image_item);
      const aesKey = locator.aesKey.toString('base64url');
      locator.aesKey.fill(0);
      return [{ position, downloadUrl: locator.downloadUrl, aesKey }];
    } catch {
      return [];
    }
  }).slice(-MAX_NATIVE_IMAGES);

  const imageFacts = Object.freeze(
    images.map((image) => Object.freeze(image)),
  );
  const itemTypes = Object.freeze(
    items.flatMap((item) => item.type === undefined ? [] : [item.type]),
  );
  const normalizedMessage: NormalizedMessage = Object.freeze({
    providerMessageId: stableProviderMessageId,
    origin: MESSAGE_ORIGINS.CUSTOMER,
    type: kind,
    rawType: `ilink_${kind}`,
    sentAt: createTime,
    sync,
    conversation: Object.freeze({
      channel: ILINK_CHANNEL,
      accountKey: pair.accountKey,
      peerId: pair.ownerUserId,
    }),
    text,
    summary,
    attributes: Object.freeze({
      itemTypes,
    }),
    attachments: Object.freeze(
      imageFacts.map((image) => Object.freeze({
        kind: 'image' as const,
        mediaId: `ilink:${image.position}`,
        filename: `ilink-image-${image.position}`,
        status: 'unresolved' as const,
      })),
    ),
  });
  return Object.freeze({
    message: normalizedMessage,
    facts: Object.freeze({
      contextToken,
      ...(seq === undefined ? {} : { providerSeq: seq }),
      images: imageFacts,
    }),
  });
}
