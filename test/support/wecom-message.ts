import type {
  ImageAttachment,
  NormalizedMessage,
} from '../../src/types.ts';

export interface TestWecomMessageOptions {
  id?: string;
  openKfId?: string;
  externalUserId?: string;
  origin?: string;
  type?: string;
  rawType?: string;
  sentAt?: number;
  cursor?: string;
  index?: number;
  text?: string;
  summary?: string;
  attributes?: Readonly<Record<string, unknown>>;
  attachments?: readonly ImageAttachment[];
}

export function testWecomMessage({
  id = 'message-one',
  openKfId = 'wk-test',
  externalUserId = 'wm-test',
  origin = 'customer',
  type = 'text',
  rawType = type,
  sentAt = 1,
  cursor = '',
  index = 0,
  text = id,
  summary = text,
  attributes = {},
  attachments = [],
}: TestWecomMessageOptions = {}): NormalizedMessage {
  return Object.freeze({
    id,
    origin,
    type,
    rawType,
    sentAt,
    sync: Object.freeze({ cursor, index }),
    conversation: Object.freeze({
      channel: 'wechat_kf',
      accountKey: openKfId,
      peerId: externalUserId,
    }),
    text,
    summary,
    attributes: Object.freeze({ ...attributes }),
    attachments: Object.freeze([...attachments]),
  });
}
