import type {
  ImageAttachment,
  NormalizedMessage,
} from '../../src/types.js';

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
  servicerUserId?: string;
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
  servicerUserId = '',
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
    conversation: Object.freeze({ openKfId, externalUserId }),
    actor: Object.freeze({ servicerUserId }),
    text,
    summary,
    attributes: Object.freeze({ ...attributes }),
    attachments: Object.freeze([...attachments]),
  });
}
